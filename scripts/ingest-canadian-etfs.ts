/**
 * scripts/ingest-canadian-etfs.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runner script: fetches Canadian ETF holdings and writes fund_snapshots +
 * snapshot_holdings rows into Supabase.
 *
 * Behaviour:
 *   - One snapshot per (fund_id, period) — re-running for a period that is
 *     already stored is a no-op.
 *   - Holdings whose identifiers don't resolve to a known security go to a
 *     review queue log. They are NOT auto-created in securities.
 *   - Cross-source resolution: CUSIP/ISIN from Vanguard CA holdings match
 *     aliases written by ingest-edgar.ts, enabling VFV → VOO look-through.
 *
 * Usage:
 *   npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --ticker VFV
 *   npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --ticker VFV,VEQT,VBAL
 *   npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --all
 *
 * Supported sources:
 *   vanguard-ca   Vanguard Canada ETFs (lib/scrapers/vanguard-ca.ts)
 *
 * Environment variables required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role — bypasses RLS)
 *
 * Scheduled job: runs weekly (see .github/workflows/ingest-canadian-etfs.yml).
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  fetchFundHoldings,
  VANGUARD_CA_PORT_IDS,
  VanguardCaHolding,
  VanguardCaFundResult,
} from '../lib/scrapers/vanguard-ca';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Tickers whose actual fund structure is a fund-of-funds (ETF-of-ETFs). */
const FUND_OF_FUNDS = new Set(['VCIP', 'VCNS', 'VBAL', 'VGRO', 'VEQT']);

/** Map from source name → all known tickers for that source. */
const SOURCE_TICKERS: Record<string, string[]> = {
  'vanguard-ca': Object.keys(VANGUARD_CA_PORT_IDS),
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewQueueEntry {
  source: string;
  ticker: string;
  period: string;
  holding_name: string;
  cusip: string | null;
  isin: string | null;
  sedol: string | null;
  weight: number;
  reason: string;
  logged_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name normalisation (mirrors ingest-edgar.ts)
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
// Security resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolution order (per spec):
 *   1. CUSIP   — lowercased 9-char identifier
 *   2. ISIN    — lowercased 12-char identifier
 *   3. SEDOL   — lowercased 7-char identifier (populated by future sources)
 *   4. Normalised name via security_aliases
 *   5. → review queue (caller's responsibility)
 */
async function resolveSecurityId(
  supabase: SupabaseClient,
  holding: VanguardCaHolding
): Promise<string | null> {
  const candidates: string[] = [];

  if (holding.cusip)  candidates.push(holding.cusip.toLowerCase());
  if (holding.isin)   candidates.push(holding.isin.toLowerCase());
  if (holding.sedol)  candidates.push(holding.sedol.toLowerCase());
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
// Fund upsert
// ─────────────────────────────────────────────────────────────────────────────

async function upsertFund(
  supabase: SupabaseClient,
  source: string,
  ticker: string,
  displayName: string,
  isFundOfFunds: boolean
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('funds')
    .upsert(
      {
        family: source,
        source_code: ticker.toUpperCase(),
        display_name: displayName,
        fund_type: isFundOfFunds ? 'fund_of_funds' : 'canadian_etf',
        is_lookthrough_supported: true,
      },
      { onConflict: 'family,source_code', ignoreDuplicates: false }
    )
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`upsertFund failed for ${ticker}: ${error?.message ?? 'no data'}`);
  }
  return data as { id: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core ingest for a single ticker
// ─────────────────────────────────────────────────────────────────────────────

async function ingestTicker(
  supabase: SupabaseClient,
  source: string,
  ticker: string,
  reviewQueue: ReviewQueueEntry[]
): Promise<{ status: 'ok' | 'no-op' | 'skip' | 'error'; message?: string }> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Ingesting: ${ticker} (${source})`);

  // ── Fetch holdings ────────────────────────────────────────────────────────
  let result: VanguardCaFundResult | null = null;

  if (source === 'vanguard-ca') {
    result = await fetchFundHoldings(ticker);
  } else {
    return { status: 'error', message: `Unknown source: ${source}` };
  }

  if (!result) {
    // API returned no data — not a DB error. Some ETFs (Canadian equity, bonds,
    // factor) don't expose delayeredHoldings. Treat as skip, not failure.
    return { status: 'skip', message: `no holdings data available from API` };
  }

  console.log(`  Period:    ${result.period}  (asOfDate: ${result.asOfDate})`);
  console.log(`  Holdings:  ${result.holdingCount}`);
  console.log(`  Weight Σ:  ${(result.weightSum * 100).toFixed(2)}%`);

  // ── Upsert fund in catalog ────────────────────────────────────────────────
  const displayName =
    result.fundFullName ??
    `Vanguard ${ticker.toUpperCase()} ETF`;

  const fund = await upsertFund(
    supabase,
    source,
    ticker,
    displayName,
    FUND_OF_FUNDS.has(ticker.toUpperCase())
  );
  console.log(`  Fund ID:   ${fund.id}`);

  // ── Check if this (fund_id, period) already exists ───────────────────────
  const { data: existing } = await supabase
    .from('fund_snapshots')
    .select('id, scraped_at')
    .eq('fund_id', fund.id)
    .eq('period', result.period)
    .maybeSingle();

  if (existing) {
    console.log(
      `  ↷ Snapshot already exists for ${ticker} period ${result.period} — no-op`
    );
    return { status: 'no-op' };
  }

  // ── Sort by weight descending and assign rank ─────────────────────────────
  const sorted = [...result.holdings].sort((a, b) => b.weight - a.weight);

  // ── Resolve each holding to a security_id ─────────────────────────────────
  const resolved: Array<{ holding: VanguardCaHolding; securityId: string; rank: number }> = [];

  for (let i = 0; i < sorted.length; i++) {
    const holding = sorted[i];
    const securityId = await resolveSecurityId(supabase, holding);

    if (!securityId) {
      reviewQueue.push({
        source,
        ticker,
        period: result.period,
        holding_name: holding.name,
        cusip: holding.cusip,
        isin: holding.isin,
        sedol: holding.sedol,
        weight: holding.weight,
        reason: 'no alias match (cusip, isin, sedol, name all unresolved)',
        logged_at: new Date().toISOString(),
      });
      continue;
    }

    resolved.push({ holding, securityId, rank: i + 1 });
  }

  console.log(
    `  Resolved:  ${resolved.length}/${result.holdingCount} holdings ` +
    `(${result.holdingCount - resolved.length} → review queue)`
  );

  // ── Write snapshot ────────────────────────────────────────────────────────
  const { data: snapshot, error: snapError } = await supabase
    .from('fund_snapshots')
    .insert({
      fund_id: fund.id,
      period: result.period,
      scraped_at: result.scrapedAt,
      holding_count: resolved.length,
      source_url: `https://www.vanguard.ca/en/investor/products/products-group/etfs/${ticker}`,
    })
    .select('id')
    .single();

  if (snapError || !snapshot) {
    throw new Error(`fund_snapshots insert failed for ${ticker}: ${snapError?.message ?? 'no data'}`);
  }

  console.log(`  Snapshot:  ${snapshot.id}`);

  // ── Insert holdings (batch) ───────────────────────────────────────────────
  if (resolved.length > 0) {
    const rows = resolved.map(({ holding, securityId, rank }) => ({
      snapshot_id: snapshot.id,
      security_id: securityId,
      weight: holding.weight,
      rank,
    }));

    // Batch in chunks of 500 to stay within Supabase request limits
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error: insertError } = await supabase
        .from('snapshot_holdings')
        .insert(chunk);

      if (insertError) {
        throw new Error(
          `snapshot_holdings insert failed for ${ticker} chunk ${Math.floor(i / CHUNK) + 1}: ${insertError.message}`
        );
      }
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
  let source = 'vanguard-ca';
  let tickers: string[] = [];
  let runAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) {
      source = args[i + 1];
      i++;
    } else if (args[i] === '--ticker' && args[i + 1]) {
      tickers = args[i + 1].split(',').map((t) => t.trim().toUpperCase());
      i++;
    } else if (args[i] === '--all') {
      runAll = true;
    }
  }

  // ── Init Supabase ─────────────────────────────────────────────────────────
  const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error(
      'Missing env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Determine tickers to ingest ──────────────────────────────────────────
  if (runAll) {
    const known = SOURCE_TICKERS[source];
    if (!known) {
      console.error(`Unknown source: ${source}. Known sources: ${Object.keys(SOURCE_TICKERS).join(', ')}`);
      process.exit(1);
    }
    tickers = known;
    console.log(`[ingest-canadian-etfs] --all mode: ${tickers.length} tickers for source "${source}"`);
  }

  if (!tickers.length) {
    console.error(
      'No tickers specified. Usage:\n' +
      '  npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --ticker VFV\n' +
      '  npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --ticker VFV,VEQT\n' +
      '  npx tsx scripts/ingest-canadian-etfs.ts --source vanguard-ca --all'
    );
    process.exit(1);
  }

  // ── Run ingestion ─────────────────────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log(' FundTrace Canadian ETF Ingestion');
  console.log('═'.repeat(60));
  console.log(`Source:  ${source}`);
  console.log(`Tickers: ${tickers.join(', ')}`);

  const reviewQueue: ReviewQueueEntry[] = [];
  const summary = { ok: 0, noop: 0, skip: 0, error: 0 };

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      const result = await ingestTicker(supabase, source, ticker, reviewQueue);
      if (result.status === 'ok')         summary.ok++;
      else if (result.status === 'no-op') summary.noop++;
      else if (result.status === 'skip') {
        summary.skip++;
        console.log(`  ↷ ${ticker}: ${result.message}`);
      } else {
        summary.error++;
        console.error(`  ✗ ${ticker}: ${result.message}`);
      }
    } catch (err) {
      summary.error++;
      console.error(`  ✗ ${ticker} fatal error:`, err);
    }

    // Polite delay between funds (not between pages — the scraper handles that)
    if (i < tickers.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── Review queue report ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('Summary:');
  console.log(`  Ingested: ${summary.ok}`);
  console.log(`  No-op:    ${summary.noop}`);
  console.log(`  Skipped:  ${summary.skip}  (no delayeredHoldings from API)`);
  console.log(`  Error:    ${summary.error}`);

  if (reviewQueue.length > 0) {
    console.log(`\nReview queue: ${reviewQueue.length} unresolved holdings`);
    console.log('These could not be matched to an existing security.\n');

    // Group by fund + period
    const grouped: Record<string, ReviewQueueEntry[]> = {};
    for (const entry of reviewQueue) {
      const key = `${entry.ticker} / ${entry.period}`;
      (grouped[key] ??= []).push(entry);
    }

    for (const [key, entries] of Object.entries(grouped)) {
      console.log(`  ${key}  (${entries.length} unresolved):`);
      for (const e of entries.slice(0, 5)) {
        console.log(
          `    ${e.holding_name.padEnd(45)} ` +
          `CUSIP:${(e.cusip ?? 'n/a').padEnd(12)} ` +
          `ISIN:${e.isin ?? 'n/a'}`
        );
      }
      if (entries.length > 5) {
        console.log(`    … and ${entries.length - 5} more`);
      }
    }

    // Write review queue to JSON
    const { writeFileSync } = await import('fs');
    const queuePath = `./canadian-etf-review-queue-${new Date().toISOString().split('T')[0]}.json`;
    writeFileSync(queuePath, JSON.stringify(reviewQueue, null, 2));
    console.log(`\nReview queue saved to: ${queuePath}`);
  }

  if (summary.error > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
