/**
 * app/api/cron/ingest-edgar/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vercel Cron route for weekly EDGAR N-PORT ingestion.
 * Triggered by Vercel's cron scheduler (configured in vercel.json).
 *
 * Schedule: every Monday at 06:00 UTC
 * (N-PORT filings are typically 47-89 days old; weekly polling is sufficient)
 *
 * Security: requests must include the CRON_SECRET header set by Vercel.
 * The route is otherwise blocked (returns 401).
 *
 * To trigger manually (for testing):
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://your-app.vercel.app/api/cron/ingest-edgar
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchFundHoldings } from '@/lib/scrapers/edgar';

// Tickers to ingest on each run.
// This list will grow as US funds are added to the catalog.
// The runner also supports --all mode which reads from the funds table.
const DEFAULT_TICKERS = ['VOO', 'SPY', 'IVV', 'QQQ', 'VTI'];

export async function GET(req: NextRequest) {
  // ── Auth check ─────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Supabase ───────────────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { error: 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Determine tickers ─────────────────────────────────────────────────────
  const tickerParam = req.nextUrl.searchParams.get('tickers');
  const tickers = tickerParam
    ? tickerParam.split(',').map((t) => t.trim().toUpperCase())
    : DEFAULT_TICKERS;

  console.log(`[cron/ingest-edgar] running for: ${tickers.join(', ')}`);

  // ── Run ingestion ─────────────────────────────────────────────────────────
  const results: Record<string, { status: string; period?: string; error?: string }> = {};

  for (const ticker of tickers) {
    try {
      const fundResult = await fetchFundHoldings(ticker);

      if (!fundResult) {
        results[ticker] = { status: 'fetch-failed' };
        continue;
      }

      // Upsert fund
      const { data: fund, error: fundErr } = await supabase
        .from('funds')
        .upsert(
          {
            family: 'edgar',
            source_code: ticker,
            display_name: fundResult.seriesName ?? ticker,
            fund_type: 'us_etf',
            is_lookthrough_supported: true,
          },
          { onConflict: 'family,source_code' }
        )
        .select('id')
        .single();

      if (fundErr || !fund) {
        results[ticker] = { status: 'db-error', error: fundErr?.message };
        continue;
      }

      // Check if snapshot already exists for this period
      const { data: existing } = await supabase
        .from('fund_snapshots')
        .select('id')
        .eq('fund_id', fund.id)
        .eq('period', fundResult.period)
        .maybeSingle();

      if (existing && !fundResult.isAmendment) {
        results[ticker] = { status: 'no-op', period: fundResult.period };
        continue;
      }

      // Write snapshot (upsert)
      const { data: snapshot, error: snapErr } = await supabase
        .from('fund_snapshots')
        .upsert(
          {
            ...(existing ? { id: existing.id } : {}),
            fund_id: fund.id,
            period: fundResult.period,
            scraped_at: new Date().toISOString(),
            holding_count: fundResult.equityCount,
            source_url: fundResult.sourceUrl,
          },
          { onConflict: 'fund_id,period' }
        )
        .select('id')
        .single();

      if (snapErr || !snapshot) {
        results[ticker] = { status: 'snapshot-error', error: snapErr?.message };
        continue;
      }

      // Delete old holdings if amendment
      if (existing) {
        await supabase.from('snapshot_holdings').delete().eq('snapshot_id', snapshot.id);
      }

      // Resolve and write holdings
      let written = 0;
      for (const holding of fundResult.holdings) {
        const aliases = [
          holding.cusip?.toLowerCase(),
          holding.isin?.toLowerCase(),
        ].filter(Boolean) as string[];

        let securityId: string | null = null;
        for (const alias of aliases) {
          const { data } = await supabase
            .from('security_aliases')
            .select('security_id')
            .eq('alias', alias)
            .maybeSingle();
          if (data?.security_id) { securityId = data.security_id; break; }
        }

        if (!securityId) continue; // review queue (handled by runner script)

        await supabase.from('snapshot_holdings').insert({
          snapshot_id: snapshot.id,
          security_id: securityId,
          weight: holding.weight,
          rank: holding.rank,
        });
        written++;
      }

      results[ticker] = {
        status: fundResult.isAmendment ? 'amended' : 'ok',
        period: fundResult.period,
      };

      console.log(`[cron/ingest-edgar] ${ticker}: ${written} holdings written for ${fundResult.period}`);

    } catch (err) {
      results[ticker] = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      console.error(`[cron/ingest-edgar] ${ticker} failed:`, err);
    }

    // Rate-limit: be polite to SEC servers
    await new Promise((r) => setTimeout(r, 1000));
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    tickers,
    results,
  });
}
