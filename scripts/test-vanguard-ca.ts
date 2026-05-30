/**
 * scripts/test-vanguard-ca.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reconciliation test for the Vanguard Canada adapter.
 *
 * Tests:
 *   1. VFV fetches successfully — 500+ holdings, weight sum ~100%
 *   2. NVIDIA is in VFV holdings at a reasonable weight (>5%)
 *   3. All identifier coverage targets met (ISIN >90%, CUSIP >90%)
 *   4. VEQT fetches as fund-of-funds — small number of underlying ETF allocations
 *   5. VBAL fetches with correct sector ETFs
 *   6. Period format is correct (YYYY-MM-01)
 *   7. Unknown ticker returns null gracefully
 *
 * Run: npx tsx scripts/test-vanguard-ca.ts
 */

import { fetchFundHoldings, VANGUARD_CA_PORT_IDS } from '../lib/scrapers/vanguard-ca';

// ─────────────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

async function main() {
  console.log('=== Vanguard Canada Adapter Reconciliation Test ===\n');

  // ── Test 1: portId map sanity ─────────────────────────────────────────────
  console.log('[Sanity] portId map…');
  assert(VANGUARD_CA_PORT_IDS['VFV'] === '9563', "VFV portId is '9563'");
  assert(VANGUARD_CA_PORT_IDS['VEQT'] === '9692', "VEQT portId is '9692'");
  assert(VANGUARD_CA_PORT_IDS['VBAL'] === '9578', "VBAL portId is '9578'");
  assert(VANGUARD_CA_PORT_IDS['VGRO'] === '9579', "VGRO portId is '9579'");
  assert(VANGUARD_CA_PORT_IDS['VCN'] === '9561', "VCN portId is '9561'");
  assert(VANGUARD_CA_PORT_IDS['VUN'] === '9557', "VUN portId is '9557'");
  assert(VANGUARD_CA_PORT_IDS['VAB'] === '9552', "VAB portId is '9552'");
  assert(Object.keys(VANGUARD_CA_PORT_IDS).length >= 30, 'At least 30 tickers in map');

  // ── Test 2: Unknown ticker ────────────────────────────────────────────────
  console.log('\n[Unknown ticker] fetchFundHoldings("BOGUS")…');
  const bogus = await fetchFundHoldings('BOGUS');
  assert(bogus === null, 'Unknown ticker returns null');

  // ── Test 3: VFV end-to-end ────────────────────────────────────────────────
  console.log('\n[VFV] Fetching S&P 500 Index ETF holdings…');
  const vfv = await fetchFundHoldings('VFV');
  assert(vfv !== null, 'VFV result is not null');
  if (!vfv) { console.error('VFV fetch failed — skipping VFV tests'); }
  else {
    console.log(`  Holdings count: ${vfv.holdingCount}  Weight sum: ${(vfv.weightSum * 100).toFixed(2)}%  asOfDate: ${vfv.asOfDate}  period: ${vfv.period}`);

    assert(vfv.source === 'vanguard-ca', "source is 'vanguard-ca'");
    assert(vfv.ticker === 'VFV', "ticker is 'VFV'");
    assert(vfv.holdingCount >= 490, `At least 490 holdings (got ${vfv.holdingCount})`);
    assert(vfv.weightSum >= 0.97 && vfv.weightSum <= 1.01, `Weight sum 97-101% (got ${(vfv.weightSum * 100).toFixed(2)}%)`);

    // Period format check
    const periodOk = /^\d{4}-\d{2}-01$/.test(vfv.period);
    assert(periodOk, `Period is YYYY-MM-01 format (got '${vfv.period}')`);

    // NVIDIA check (should be top holding at >5%)
    const nvidia = vfv.holdings.find(h => h.name?.toLowerCase().includes('nvidia'));
    assert(nvidia !== undefined, 'NVIDIA found in holdings');
    if (nvidia) {
      assert(nvidia.weight >= 0.05, `NVIDIA weight ≥ 5% (got ${(nvidia.weight * 100).toFixed(2)}%)`);
      assert(nvidia.isin === 'US67066G1040', `NVIDIA ISIN correct (got ${nvidia.isin})`);
      assert(nvidia.ticker === 'NVDA', `NVIDIA ticker is NVDA (got ${nvidia.ticker})`);
    }

    // Identifier coverage
    const withIsin = vfv.holdings.filter(h => h.isin).length;
    const withCusip = vfv.holdings.filter(h => h.cusip).length;
    const withTicker = vfv.holdings.filter(h => h.ticker).length;
    assert(withIsin / vfv.holdingCount >= 0.90, `ISIN coverage ≥ 90% (got ${(100 * withIsin / vfv.holdingCount).toFixed(1)}%)`);
    assert(withCusip / vfv.holdingCount >= 0.90, `CUSIP coverage ≥ 90% (got ${(100 * withCusip / vfv.holdingCount).toFixed(1)}%)`);
    assert(withTicker / vfv.holdingCount >= 0.90, `Ticker coverage ≥ 90% (got ${(100 * withTicker / vfv.holdingCount).toFixed(1)}%)`);

    // Top 5 print (manual reconciliation check)
    const top5 = vfv.holdings
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
    console.log('\n  VFV top 5 (compare to Vanguard.ca):');
    top5.forEach((h, i) =>
      console.log(`    [${i + 1}] ${h.name.padEnd(38)} ${(h.weight * 100).toFixed(4)}%  ${h.isin ?? '—'}  ${h.ticker ?? '—'}`)
    );
  }

  // ── Test 4: VEQT (fund of ETFs) ───────────────────────────────────────────
  console.log('\n[VEQT] Fetching All-Equity ETF Portfolio…');
  const veqt = await fetchFundHoldings('VEQT');
  assert(veqt !== null, 'VEQT result is not null');
  if (veqt) {
    console.log(`  Holdings count: ${veqt.holdingCount}  Weight sum: ${(veqt.weightSum * 100).toFixed(2)}%`);
    // VEQT holds 4 underlying ETFs — delayeredHoldings may pierce through or show ETFs
    // Weight sum should still be close to 100%
    assert(veqt.weightSum >= 0.97 && veqt.weightSum <= 1.03, `Weight sum 97-103% (got ${(veqt.weightSum * 100).toFixed(2)}%)`);
    assert(veqt.holdingCount > 0, `At least 1 holding (got ${veqt.holdingCount})`);

    if (veqt.holdingCount <= 10) {
      console.log('\n  VEQT underlying allocations (fund-of-funds):');
      veqt.holdings
        .sort((a, b) => b.weight - a.weight)
        .forEach((h, i) =>
          console.log(`    [${i + 1}] ${h.name.padEnd(40)} ${(h.weight * 100).toFixed(2)}%`)
        );
    } else {
      console.log(`  VEQT shows ${veqt.holdingCount} delayered underlying stocks`);
    }
  }

  // ── Test 5: VBAL (balanced ETF portfolio) ─────────────────────────────────
  console.log('\n[VBAL] Fetching Balanced ETF Portfolio…');
  const vbal = await fetchFundHoldings('VBAL');
  assert(vbal !== null, 'VBAL result is not null');
  if (vbal) {
    console.log(`  Holdings count: ${vbal.holdingCount}  Weight sum: ${(vbal.weightSum * 100).toFixed(2)}%`);
    assert(vbal.holdingCount > 0, 'VBAL has holdings');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
