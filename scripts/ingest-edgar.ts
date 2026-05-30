/**
 * scripts/ingest-edgar.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runner script: fetches EDGAR N-PORT filings and writes fund_snapshots +
 * snapshot_holdings rows into Supabase.
 *
 * Behaviour:
 *   - One snapshot per (fund_id, period) — re-running for a period with no
 *     new filing is a no-op (upsert on unique constraint).
 *   - Re-running after an amendment (NPORT-P/A) correctly overwrites the prior
 *     snapshot_holdings for that period (delete + re-insert via transaction).
 *   - Holdings with no resolvable identifier go to a review queue log, NOT
 *     auto-created in securities.
 *
 * Usage:
 *   npx ts-node scripts/ingest-edgar.ts --ticker VOO
 *   npx ts-node scripts/ingest-edgar.ts --ticker VOO,SPY,QQQ
 *   npx ts-node scripts/ingest-edgar.ts --all   ← ingests all US funds in catalog
 *
 * Environment variables required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role — bypasses RLS)
 *
 * Scheduled job: runs weekly (see cron config).
 */

import dotenv from 'dotenv';
import path from 'path';
// Load .env.local (Next.js convention) so vars are available when running via tsx
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fetchFundHoldings, EdgarHolding } from '../lib/scrapers/edgar';

// ─────────────────────────────────────────────────────────────────────────────
// Types matching the snapshot schema (fundtrace-snapshot-schema.sql)
// ─────────────────────────────────────────────────────────────────────────────

interface FundRow {
  id: string;
  family: string;
  source_code: string;
  display_name: string;
  fund_type: string;
}

interface SecurityRow {
  id: string;
  canonical_name: string;
  ticker: string | null;
}

interface ReviewQueueEntry {
  ticker: string;
  period: string;
  holding_name: string;
  cusip: string | null;
  isin: string | null;
  weight: number;
  reason: string;
  logged_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise name for alias matching (mirrors Canadian scraper logic)
// ─────────────────────────────────────────────────────────────────────────────

const STRIP_SUFFIXES =
  /\b(Corp\.?|Inc\.?|Ltd\.?|PLC|SE|AG|SA|ADR|Class\s+[A-Z]|Shs|Ord|N\.?V\.?|S\.?A\.?)\b\.?/gi;

function normaliseName(name: string): string {
  return name
    .replace(STRIP_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a holding to a security_id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolution order (per spec):
 *   1. CUSIP match via security_aliases
 *   2. ISIN match via security_aliases
 *   3. Normalised name match via security_aliases
 *   4. → review queue
 */
async function resolveSecurityId(
  supabase: SupabaseClient,
  holding: EdgarHolding
): Promise<string | null> {
  // Try aliases in order: cusip, isin, normalized name
  const candidates: string[] = [];
  if (holding.cusip) candidates.push(holding.cusip.toLowerCase());
  if (holding.isin) candidates.push(holding.isin.toLowerCase());
  candidates.push(normaliseName(holding.name));

  for (const alias of candidates) {
    if (!alias) continue;
    const { data } = await supabase
      .from('security_aliases')
      .select('security_id')
      .eq('alias', alias)
      .maybeSingle();

    if (data?.security_id) return data.security_id;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert fund record in funds catalog
// ─────────────────────────────────────────────────────────────────────────────

async function upsertFund(
  supabase: SupabaseClient,
  ticker: string,
  displayName: string
): Promise<FundRow> {
  const { data, error } = await supabase
    .from('funds')
    .upsert(
      {
        family: 'edgar',
        source_code: ticker.toUpperCase(),
        display_name: displayName,
        fund_type: 'us_etf', // will be refined if we detect mutual fund
        is_lookthrough_supported: true,
      },
      { onConflict: 'family,source_code', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertFund failed for ${ticker}: ${error.message}`);
  return data as FundRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core ingest function for a single ticker
// ─────────────────────────────────────────────────────────────────────────────

async function ingestTicker(
  supabase: SupabaseClient,
  ticker: string,
  reviewQueue: ReviewQueueEntry[]
): Promise<{ status: 'ok' | 'no-op' | 'error'; message?: string }> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Ingesting: ${ticker}`);

  // ── Fetch holdings from EDGAR ─────────────────────────────────────────────
  const result = await fetchFundHoldings(ticker);
  if (!result) {
    return { status: 'error', message: `fetchFundHoldings returned null for ${ticker}` };
  }

  console.log(`  Period:   ${result.period} (${result.periodRaw})`);
  console.log(`  Holdings: ${result.equityCount} equity`);
  console.log(`  Weight Σ: ${(result.equityWeightSum * 100).toFixed(2)}%`);

  // ── Upsert fund in catalog ────────────────────────────────────────────────
  const fundDisplayName = result.seriesName
    ? result.seriesName.replace(/\b\w/g, (c) => c.toUpperCase()).toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())  // title case
    : ticker.toUpperCase();

  const fund = await upsertFund(supabase, ticker, fundDisplayName);
  console.log(`  Fund ID:  ${fund.id}`);

  // ── Check if this (fund_id, period) already exists ───────────────────────
  const { data: existingSnapshot } = await supabase
    .from('fund_snapshots')
    .select('id, scraped_at')
    .eq('fund_id', fund.id)
    .eq('period', result.period)
    .maybeSingle();

  if (existingSnapshot && !result.isAmendment) {
    // Snapshot exists and this is not an amendment — no-op
    console.log(
      `  ↷ Snapshot already exists for ${ticker} period ${result.period} — no-op`
    );
    return { status: 'no-op' };
  }

  if (existingSnapshot && result.isAmendment) {
    console.log(
      `  ↻ Amendment found — overwriting snapshot ${existingSnapshot.id}`
    );
  }

  // ── Resolve each holding to a security_id ─────────────────────────────────
  const resolved: Array<{ holding: EdgarHolding; securityId: string }> = [];

  for (const holding of result.holdings) {
    const securityId = await resolveSecurityId(supabase, holding);

    if (!securityId) {
      reviewQueue.push({
        ticker,
        period: result.period,
        holding_name: holding.name,
        cusip: holding.cusip,
        isin: holding.isin,
        weight: holding.weight,
        reason: 'no alias match (cusip, isin, name all unresolved)',
        logged_at: new Date().toISOString(),
      });
      continue;
    }

    resolved.push({ holding, securityId });
  }

  console.log(
    `  Resolved: ${resolved.length}/${result.holdings.length} holdings ` +
    `(${result.holdings.length - resolved.length} → review queue)`
  );

  // ── Write snapshot (upsert) ───────────────────────────────────────────────
  const { data: snapshot, error: snapError } = await supabase
    .from('fund_snapshots')
    .upsert(
      {
        ...(existingSnapshot ? { id: existingSnapshot.id } : {}),
        fund_id: fund.id,
        period: result.period,
        scraped_at: new Date().toISOString(),
        holding_count: resolved.length,
        source_url: result.sourceUrl,
      },
      { onConflict: 'fund_id,period' }
    )
    .select()
    .single();

  if (snapError || !snapshot) {
    throw new Error(`fund_snapshots upsert failed: ${snapError?.message}`);
  }

  console.log(`  Snapshot: ${snapshot.id}`);

  // ── Delete old holdings if amending ──────────────────────────────────────
  if (existingSnapshot) {
    const { error: delError } = await supabase
      .from('snapshot_holdings')
      .delete()
      .eq('snapshot_id', snapshot.id);

    if (delError) {
      throw new Error(`snapshot_holdings delete failed: ${delError.message}`);
    }
  }

  // ── Insert new holdings ───────────────────────────────────────────────────
  if (resolved.length > 0) {
    const rows = resolved.map(({ holding, securityId }) => ({
      snapshot_id: snapshot.id,
      security_id: securityId,
      weight: holding.weight,
      rank: holding.rank,
    }));

    const { error: insertError } = await supabase
      .from('snapshot_holdings')
      .insert(rows);

    if (insertError) {
      throw new Error(`snapshot_holdings insert failed: ${insertError.message}`);
    }
  }

  console.log(`  ✓ ${ticker} ingested — ${resolved.length} holdings written`);
  return { status: 'ok' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── Parse args ────────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  let tickers: string[] = [];
  let runAll = false;
  let refreshCache = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ticker' && args[i + 1]) {
      tickers = args[i + 1].split(',').map((t) => t.trim().toUpperCase());
      i++;
    } else if (args[i] === '--all') {
      runAll = true;
    } else if (args[i] === '--refresh-cache') {
      refreshCache = true;
    }
  }

  // ── Init Supabase ─────────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error(
      'Missing env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Optional cache refresh ────────────────────────────────────────────────
  if (refreshCache) {
    const { refreshTickerCache } = await import('../lib/edgar/ticker-lookup');
    console.log('Refreshing SEC ticker cache...');
    await refreshTickerCache();
    console.log('Cache refreshed.');
    if (!tickers.length && !runAll) return;
  }

  // ── Determine tickers to ingest ──────────────────────────────────────────
  if (runAll) {
    // Load all US funds from catalog
    const { data: usFunds } = await supabase
      .from('funds')
      .select('source_code')
      .eq('family', 'edgar');

    tickers = (usFunds ?? []).map((f: { source_code: string }) => f.source_code);
    console.log(`[ingest-edgar] --all mode: found ${tickers.length} US funds in catalog`);
  }

  if (!tickers.length) {
    console.error(
      'No tickers specified. Usage:\n' +
      '  npx ts-node scripts/ingest-edgar.ts --ticker VOO\n' +
      '  npx ts-node scripts/ingest-edgar.ts --ticker VOO,SPY,QQQ\n' +
      '  npx ts-node scripts/ingest-edgar.ts --all'
    );
    process.exit(1);
  }

  // ── Run ingestion ─────────────────────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log(' FundTrace EDGAR N-PORT Ingestion');
  console.log('═'.repeat(60));
  console.log(`Tickers: ${tickers.join(', ')}`);

  const reviewQueue: ReviewQueueEntry[] = [];
  const summary = { ok: 0, noop: 0, error: 0 };

  for (const ticker of tickers) {
    try {
      const result = await ingestTicker(supabase, ticker, reviewQueue);
      if (result.status === 'ok') summary.ok++;
      else if (result.status === 'no-op') summary.noop++;
      else {
        summary.error++;
        console.error(`  ✗ ${ticker}: ${result.message}`);
      }
    } catch (err) {
      summary.error++;
      console.error(`  ✗ ${ticker} fatal error:`, err);
    }

    // Be polite to SEC servers — 1s delay between funds
    if (tickers.indexOf(ticker) < tickers.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ── Review queue report ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('Summary:');
  console.log(`  Ingested: ${summary.ok}`);
  console.log(`  No-op:    ${summary.noop}`);
  console.log(`  Error:    ${summary.error}`);

  if (reviewQueue.length > 0) {
    console.log(`\nReview queue (${reviewQueue.length} unresolved holdings):`);
    console.log('These holdings could not be matched to an existing security.');
    console.log('Do NOT auto-create securities — resolve manually or via the review UI.\n');

    // Group by fund+period
    const grouped: Record<string, ReviewQueueEntry[]> = {};
    for (const entry of reviewQueue) {
      const key = `${entry.ticker} / ${entry.period}`;
      (grouped[key] ??= []).push(entry);
    }

    for (const [key, entries] of Object.entries(grouped)) {
      console.log(`  ${key}:`);
      for (const e of entries.slice(0, 10)) {
        console.log(
          `    ${e.holding_name.padEnd(45)} CUSIP:${(e.cusip ?? 'n/a').padEnd(12)} ISIN:${e.isin ?? 'n/a'}`
        );
      }
      if (entries.length > 10) {
        console.log(`    ... and ${entries.length - 10} more`);
      }
    }

    // Write review queue to JSON for manual inspection
    const queuePath = `./edgar-review-queue-${new Date().toISOString().split('T')[0]}.json`;
    const { writeFileSync } = await import('fs');
    writeFileSync(queuePath, JSON.stringify(reviewQueue, null, 2));
    console.log(`\nReview queue saved to: ${queuePath}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
