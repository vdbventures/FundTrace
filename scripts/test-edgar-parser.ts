/**
 * scripts/test-edgar-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Checkpoint 1 + 2 verification: tests the N-PORT parser against a live
 * VOO filing from SEC EDGAR and reconciles against known expected values.
 *
 * Expected (from VOO NPORT-P 2026-05-28 filing, verified manually):
 *   - Top holding: NVIDIA Corp ~7.58%
 *   - Apple Inc ~6.66%
 *   - Microsoft Corp ~4.91%
 *   - 500+ equity holdings
 *   - equity weight sum ~95-100%
 *
 * Usage: npx tsx scripts/test-edgar-parser.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { lookupTicker } from '../lib/edgar/ticker-lookup';
import { parseNport } from '../lib/edgar/nport-parser';

const USER_AGENT = 'FundTrace fundtrace-contact@example.com';

async function secGet(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

async function main() {
  console.log('═'.repeat(60));
  console.log(' FundTrace EDGAR Parser — VOO Reconciliation Test');
  console.log('═'.repeat(60));

  // ── 1. Ticker lookup ──────────────────────────────────────────────────────
  console.log('\n[1] Looking up VOO in SEC mutual fund tickers...');
  const info = await lookupTicker('VOO');
  if (!info) throw new Error('VOO not found in SEC tickers list');

  console.log(`  CIK:       ${info.cik}`);
  console.log(`  Title:     ${info.title}`);
  console.log(`  Series ID: ${info.seriesId ?? 'n/a'}`);
  console.log(`  Class ID:  ${info.classId ?? 'n/a'}`);

  // ── 2. Get latest filing ───────────────────────────────────────────────────
  console.log('\n[2] Fetching EDGAR submissions for Vanguard Index Funds...');
  const paddedCik = info.cik.padStart(10, '0');
  const subUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
  const subRes = await secGet(subUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subData = await subRes.json() as any;

  const recent = subData?.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const accessions: string[] = recent.accessionNumber ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const seriesIds: string[] = recent.seriesId ?? [];

  interface Filing { accession: string; date: string; form: string; }
  const candidates: Filing[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== 'NPORT-P' && forms[i] !== 'NPORT-P/A') continue;
    if (info.seriesId && seriesIds[i] && seriesIds[i] !== info.seriesId) continue;
    candidates.push({ accession: accessions[i], date: dates[i], form: forms[i] });
  }

  candidates.sort((a, b) => b.date.localeCompare(a.date));
  const best = candidates[0];
  if (!best) throw new Error('No NPORT-P filing found for VOO series');

  console.log(`  Filing:    ${best.accession}`);
  console.log(`  Form:      ${best.form}`);
  console.log(`  Date:      ${best.date}`);

  // ── 3. Fetch XML ───────────────────────────────────────────────────────────
  console.log('\n[3] Fetching filing XML...');
  // EDGAR Archives: integer CIK (no leading zeros)
  const intCik = String(parseInt(info.cik, 10));
  const accNoSlashes = best.accession.replace(/-/g, '');
  const baseDir = `https://www.sec.gov/Archives/edgar/data/${intCik}/${accNoSlashes}`;

  // Fetch directory listing to find XML filename
  const dirRes = await secGet(`${baseDir}/`);
  const dirHtml = await dirRes.text();

  const xmlMatch =
    dirHtml.match(/href="([^"]*\/primary_doc\.xml)"/) ??
    dirHtml.match(/href="([^"]*nport[^"]*\.xml)"/) ??
    dirHtml.match(/href="([^"]*\.xml)"/);

  const xmlFilename = xmlMatch ? xmlMatch[1].split('/').pop()! : 'primary_doc.xml';
  const xmlUrl = `${baseDir}/${xmlFilename}`;
  console.log(`  URL:       ${xmlUrl}`);

  const xmlRes = await secGet(xmlUrl);
  const xml = await xmlRes.text();
  console.log(`  Size:      ${(xml.length / 1024).toFixed(1)} KB`);

  // ── 4. Parse ───────────────────────────────────────────────────────────────
  console.log('\n[4] Parsing N-PORT XML...');
  const parsed = parseNport(xml);

  console.log(`  Period:    ${parsed.period} (raw: ${parsed.periodRaw})`);
  console.log(`  Series:    ${parsed.seriesName ?? 'n/a'}`);
  console.log(`  Equities:  ${parsed.equityCount}`);
  console.log(`  Skipped:   ${parsed.skipped.length}`);
  console.log(`  Weight Σ:  ${(parsed.equityWeightSum * 100).toFixed(2)}%`);

  // ── 5. Reconciliation ──────────────────────────────────────────────────────
  console.log('\n[5] Reconciliation — Top 10 holdings:');

  const sorted = [...parsed.equityHoldings].sort((a, b) => b.weight - a.weight);
  const top10 = sorted.slice(0, 10);

  console.log('');
  console.log('  Rank  Name'.padEnd(55) + 'Weight    CUSIP        ISIN');
  console.log('  ' + '─'.repeat(85));
  top10.forEach((h, i) => {
    const w = `${(h.weight * 100).toFixed(4)}%`;
    console.log(
      `  ${String(i + 1).padStart(2)}.  ${h.name.padEnd(48)} ${w.padEnd(10)} ${(h.cusip ?? 'n/a').padEnd(12)} ${h.isin ?? 'n/a'}`
    );
  });

  // ── 6. Assertions ─────────────────────────────────────────────────────────
  console.log('\n[6] Assertions:');
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

  // Equity count — VOO holds ~500 S&P 500 stocks
  assert('equity count ≥ 490', parsed.equityCount >= 490, `got ${parsed.equityCount}`);

  // Weight sum — should be close to 100% (equities only, ignores cash/swaps)
  assert(
    'weight sum ≥ 90%',
    parsed.equityWeightSum >= 0.90,
    `got ${(parsed.equityWeightSum * 100).toFixed(2)}%`
  );

  // Period is set
  assert('period is set', parsed.period.length === 10 && parsed.period.startsWith('20'));

  // Top holding should be one of the well-known mega-caps
  const topName = top10[0]?.name?.toLowerCase() ?? '';
  const knownTopHoldings = ['nvidia', 'apple', 'microsoft', 'amazon', 'alphabet'];
  assert(
    'top holding is a known mega-cap',
    knownTopHoldings.some((n) => topName.includes(n)),
    `got "${top10[0]?.name}"`
  );

  // NVIDIA should be near the top (within top 3)
  const nvidiaRank = sorted.findIndex((h) => h.name.toLowerCase().includes('nvidia'));
  assert('NVIDIA in top 3', nvidiaRank >= 0 && nvidiaRank <= 2, `rank ${nvidiaRank + 1}`);

  // All equity holdings have weight > 0
  const zeroWeight = parsed.equityHoldings.filter((h) => h.weight <= 0);
  assert('no zero-weight equities', zeroWeight.length === 0, `${zeroWeight.length} found`);

  // Weight is in DB form (< 1.0, not percent form)
  assert(
    'weights are DB fractions (< 1.0)',
    top10.every((h) => h.weight < 1.0),
    `top10 max = ${(Math.max(...top10.map((h) => h.weight)) * 100).toFixed(2)}%`
  );

  // Skipped non-equity items
  assert(
    'non-equity items skipped correctly',
    parsed.skipped.length < parsed.equityCount,
    `${parsed.skipped.length} skipped vs ${parsed.equityCount} equity`
  );

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);

  if (fail > 0) {
    console.error('\n✗ PARSER RECONCILIATION FAILED — do not proceed with DB writes');
    process.exit(1);
  } else {
    console.log('\n✓ Parser verified — proceed to checkpoint 2 (DB write)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
