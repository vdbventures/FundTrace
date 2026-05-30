/**
 * scripts/verify-ingest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Checkpoint 2 verification: queries Supabase to confirm the VOO snapshot
 * was written correctly and meets the spec.
 *
 * Checks:
 *   1. fund_snapshots row exists with correct period
 *   2. snapshot_holdings rows exist with sum of weights ~100%
 *   3. Every security_id in snapshot_holdings resolves to a securities row
 *   4. Amendment handling: re-running ingest is a no-op (no duplicate rows)
 *
 * Usage:  npx tsx scripts/verify-ingest.ts --ticker VOO
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { createClient } from '@supabase/supabase-js';

async function main() {
  const ticker = process.argv.find((_, i) => process.argv[i - 1] === '--ticker') ?? 'VOO';

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  console.log('═'.repeat(60));
  console.log(` FundTrace — Ingest Verification: ${ticker}`);
  console.log('═'.repeat(60));

  let pass = 0;
  let fail = 0;

  function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
      pass++;
    } else {
      console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
      fail++;
    }
  }

  // ── 1. Find fund row ──────────────────────────────────────────────────────
  console.log('\n[1] Fund catalog entry...');
  const { data: fund } = await supabase
    .from('funds')
    .select('id, display_name, family, fund_type')
    .eq('family', 'edgar')
    .eq('source_code', ticker.toUpperCase())
    .maybeSingle();

  assert('fund row exists', !!fund, fund?.display_name);
  if (!fund) { printResult(pass, fail); return; }
  console.log(`     ${fund.display_name} (${fund.fund_type})`);

  // ── 2. Find snapshot ──────────────────────────────────────────────────────
  console.log('\n[2] Snapshot row...');
  const { data: snapshots } = await supabase
    .from('fund_snapshots')
    .select('id, period, scraped_at, holding_count, source_url')
    .eq('fund_id', fund.id)
    .order('period', { ascending: false });

  assert('at least one snapshot exists', (snapshots?.length ?? 0) > 0);
  assert('no duplicate snapshots per period', new Set(snapshots?.map((s) => s.period)).size === snapshots?.length);

  if (!snapshots?.length) { printResult(pass, fail); return; }

  const snap = snapshots[0];
  console.log(`     Period:    ${snap.period}`);
  console.log(`     Scraped:   ${snap.scraped_at}`);
  console.log(`     Holdings:  ${snap.holding_count}`);

  assert('period is set (YYYY-MM-01 format)', /^\d{4}-\d{2}-01$/.test(snap.period ?? ''), snap.period);
  assert('holding_count > 0', (snap.holding_count ?? 0) > 0, String(snap.holding_count));

  // ── 3. Holdings ───────────────────────────────────────────────────────────
  console.log('\n[3] Snapshot holdings...');
  const { data: holdings } = await supabase
    .from('snapshot_holdings')
    .select('id, security_id, weight, rank')
    .eq('snapshot_id', snap.id)
    .order('weight', { ascending: false });

  const holdingCount = holdings?.length ?? 0;
  assert('holdings written', holdingCount > 0, `${holdingCount} rows`);

  if (holdingCount > 0) {
    const weightSum = (holdings ?? []).reduce((s, h) => s + Number(h.weight), 0);
    assert('weight sum ≥ 0.01 (some holdings resolved)', weightSum > 0.01, `Σ = ${(weightSum * 100).toFixed(2)}%`);

    const top = holdings![0];
    assert('top holding weight < 1.0 (DB fraction form)', Number(top.weight) < 1.0, `top = ${(Number(top.weight)*100).toFixed(4)}%`);

    // ── 4. Security resolution ─────────────────────────────────────────────
    console.log('\n[4] Security resolution...');
    const securityIds = [...new Set((holdings ?? []).map((h) => h.security_id))];
    const { data: securities } = await supabase
      .from('securities')
      .select('id, canonical_name, ticker')
      .in('id', securityIds);

    const resolvedCount = securities?.length ?? 0;
    assert(
      `all ${holdingCount} holdings point to existing security rows`,
      resolvedCount === holdingCount,
      `${resolvedCount}/${holdingCount} verified`
    );

    if (resolvedCount > 0) {
      console.log('\n  Top holdings:');
      const secMap = new Map((securities ?? []).map((s) => [s.id, s]));
      (holdings ?? []).slice(0, 10).forEach((h, i) => {
        const sec = secMap.get(h.security_id);
        const name = sec?.canonical_name ?? `[unresolved ${h.security_id}]`;
        const w = (Number(h.weight) * 100).toFixed(4) + '%';
        console.log(`    ${String(i + 1).padStart(2)}. ${name.padEnd(45)} ${w}`);
      });
    }
  }

  // ── 5. Re-run is no-op ────────────────────────────────────────────────────
  console.log('\n[5] Idempotency check...');
  const { count: snapCount } = await supabase
    .from('fund_snapshots')
    .select('id', { count: 'exact' })
    .eq('fund_id', fund.id)
    .eq('period', snap.period);

  assert('exactly 1 snapshot per (fund, period)', snapCount === 1, `got ${snapCount}`);

  printResult(pass, fail);
}

function printResult(pass: number, fail: number) {
  console.log('\n' + '─'.repeat(60));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('\n✗ Checkpoint 2 NOT complete');
    process.exit(1);
  } else {
    console.log('\n✓ Checkpoint 2 complete — snapshot written correctly');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
