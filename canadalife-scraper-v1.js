/**
 * Canada Life / FundData Holdings Scraper v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Canada Life mutual fund pages are hosted on FundData:
 *   https://canadalifemutualfunds.fundata.com/Fund/Snapshot/[instrumentId]
 *
 * Holdings are server-side rendered — no auth required, plain axios + Cheerio.
 * Selector: table.table-fund-details tbody tr
 * Columns:  td:first-child = name, td.text-end = weight (%)
 *
 * Fund ID system: FundData uses numeric instrument IDs in the URL.
 * These are mapped from Canada Life fund codes in FUND_REGISTRY below.
 *
 * Usage:
 *   node canadalife-scraper-v1.js              ← scrapes all known funds
 *   node canadalife-scraper-v1.js 2317         ← single fund by instrument ID
 *
 * Requires: npm install axios cheerio
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const BASE_URL = 'https://canadalifemutualfunds.fundata.com/Fund/Snapshot';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};

// ─────────────────────────────────────────────────────────────────────────────
// Fund registry — loaded from canadalife-registry.json (566 funds)
// Regenerate with: node build-canadalife-registry.js
// ─────────────────────────────────────────────────────────────────────────────
let FUND_REGISTRY = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'canadalife-registry.json'), 'utf8');
  FUND_REGISTRY = JSON.parse(raw).registry;
  console.log(`Loaded ${Object.keys(FUND_REGISTRY).length} funds from canadalife-registry.json`);
} catch {
  console.warn('canadalife-registry.json not found — run build-canadalife-registry.js first');
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio statistics labels that appear in the same table as holdings
// These are fund metrics, not positions — must be filtered out
// ─────────────────────────────────────────────────────────────────────────────
const STATS_LABELS = new Set([
  'Standard deviation',
  'Duration (years)',
  'Coupon',
  'Yield to maturity',
  'Dividend yield',
  'Average credit quality',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Fetch and parse a single fund by FundData instrument ID
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFund(instrumentId) {
  const url = `${BASE_URL}/${instrumentId}`;
  const fundMeta = FUND_REGISTRY[instrumentId] || { name: `Canada Life Fund ${instrumentId}`, code: `CL${instrumentId}` };

  console.log(`\nFetching instrument ID ${instrumentId}...`);
  console.log(`  URL: ${url}`);

  let html;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    html = res.data;
    fs.writeFileSync(`./canadalife-${instrumentId}.html`, html);
  } catch (err) {
    console.error(`  ✗ ${err.response?.status || err.message}`);
    return null;
  }

  const $ = cheerio.load(html);

  // ── As-of date ────────────────────────────────────────────────────────────
  let asOf = null;
  const dateMatch = $.html().match(/as of\s+([A-Za-z]+ \d+,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\w+ \d{1,2},? \d{4})/i);
  if (dateMatch) {
    try { asOf = new Date(dateMatch[1]).toISOString().split('T')[0]; } catch {}
  }

  // ── Holdings from table.table-fund-details ─────────────────────────────
  // Selector confirmed: table with class table-fund-details
  // Row structure: <td>name</td><td class="text-end">weight</td>
  const holdings = [];
  $('table.table-fund-details tbody tr').each((_, row) => {
    const cells  = $(row).find('td');
    if (cells.length < 2) return;
    const name   = $(cells[0]).text().trim();
    const weight = parseFloat($(cells[1]).text().trim());
    if (name && !isNaN(weight) && weight > 0 && name !== 'Total allocation in top holdings' && !STATS_LABELS.has(name)) {
      holdings.push({
        name,
        weight,
        weightSource: 'actual',
        rank: holdings.length + 1,
      });
    }
  });

  if (!holdings.length) {
    console.error(`  ✗ No holdings found — check canadalife-${instrumentId}.html`);
    return null;
  }

  // Detect fund-of-funds: if any holding name contains fund/income/equity keywords
  const isFundOfFunds = holdings.some(h =>
    /\b(fund|series|portfolio|income|equity|fixed|balanced|defensive|growth)\b/i.test(h.name)
    && !/corp|inc|ltd|plc|bank|group|co\./i.test(h.name)
  );

  const result = {
    instrumentId,
    fundCode:      fundMeta.code,
    fundName:      fundMeta.name,
    source:        'canadalife-fundata-html',
    url,
    asOf,
    isFundOfFunds,
    dataQuality:   holdings.length >= 8 ? 'top10-actual' : `partial:${holdings.length}`,
    scrapedAt:     new Date().toISOString(),
    holdings:      holdings.sort((a, b) => b.weight - a.weight),
  };

  console.log(`  ✓ ${fundMeta.name}`);
  console.log(`    As of:         ${asOf ?? 'unknown'}`);
  console.log(`    Fund-of-funds: ${isFundOfFunds ? 'Yes' : 'No'}`);
  console.log(`    Holdings:      ${holdings.length}\n`);
  holdings.forEach(h =>
    console.log(`      ${String(h.rank).padStart(2)}. ${h.name.padEnd(52)} ${h.weight.toFixed(1)}%`)
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discover fund ID from a Canada Life fund page URL
// Usage: node canadalife-scraper-v1.js --discover [URL]
// ─────────────────────────────────────────────────────────────────────────────
async function discoverFundId(url) {
  console.log(`Discovering fund ID from: ${url}`);
  const match = url.match(/Snapshot\/(\d+)/);
  if (match) {
    console.log(`Fund ID: ${match[1]}`);
    return match[1];
  }
  console.log('Could not extract ID from URL');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Discovery mode
  if (args[0] === '--discover' && args[1]) {
    await discoverFundId(args[1]);
    return;
  }

  // Fetch specific IDs or all known funds
  const idsToFetch = args.length > 0
    ? args
    : Object.keys(FUND_REGISTRY);

  if (!idsToFetch.length) {
    console.log('No fund IDs to fetch. Add funds to FUND_REGISTRY or pass IDs as arguments.');
    console.log('Usage: node canadalife-scraper-v1.js 2317 1234 5678');
    return;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log(' Canada Life / FundData Holdings Scraper v1');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Fetching: ${idsToFetch.join(', ')}\n`);

  const results  = {};
  const failed   = [];

  for (let i = 0; i < idsToFetch.length; i++) {
    const id     = idsToFetch[i];
    const result = await fetchFund(id);
    if (result) results[id] = result;
    else failed.push(id);
    if (i < idsToFetch.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  fs.writeFileSync('./canadalife-holdings.json',
    JSON.stringify({ version: 'v1', scrapedAt: new Date().toISOString(), results, failed }, null, 2)
  );

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Scraped: ${Object.keys(results).length} / ${idsToFetch.length}`);
  if (failed.length) console.log(`Failed:  ${failed.join(', ')}`);
  console.log('\nOutput: canadalife-holdings.json');
  console.log('\nTo add more funds:');
  console.log('  1. Find fund page at canadalifemutualfunds.fundata.com');
  console.log('  2. Note the number at end of URL (e.g. /Snapshot/2317)');
  console.log('  3. Add to FUND_REGISTRY in this file');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
