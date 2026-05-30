/**
 * Fidelity Canada Holdings Scraper v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles three Fidelity fund page structures:
 *
 *   Type A — Stock funds (gc, uet):
 *     Holdings: ol.pdf-holdings-reg li  (names only, no individual weights)
 *     Aggregate: td.pdf-holdings-prt
 *
 *   Type B — Fund-of-funds (aee, mmf):
 *     Holdings: div[id^="target-allocation"] table tbody tr
 *     Columns: td[0]=fund name, td[1]=percentage (exact weights ✓)
 *
 * Usage:
 *   node fidelity-scraper-v2.js           ← all 4 your funds
 *   node fidelity-scraper-v2.js gc        ← single fund
 *   node fidelity-scraper-v2.js gc uet aee mmf
 *
 * Requires: npm install axios cheerio
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');

const FIDELITY_FUNDS = {
  gc:  { name: 'Fidelity Greater Canada Fund Series F',     code: 'FID1646', series: 'F', type: 'stock' },
  uet: { name: 'Fidelity Global Innovators Class Series F', code: 'FID5982', series: 'F', type: 'stock' },
  aee: { name: 'Fidelity All-in-One Equity ETF Fund',       code: 'FID7567', series: 'F', type: 'fof'   },
  mmf: { name: 'Fidelity Global Equity+ Fund Series F',     code: 'FID7648', series: 'F', type: 'fof'   },
};

const BASE_URL = 'https://www.fidelity.ca';
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};

// ─────────────────────────────────────────────────────────────────────────────
// Parse "as of" date from page
// ─────────────────────────────────────────────────────────────────────────────
function extractDate($) {
  const patterns = [
    /As at\s+(\d{1,2}[-\s][A-Za-z]+[-\s]\d{4})/i,
    /As of\s+([A-Za-z]+ \d+,?\s+\d{4})/i,
    /(\d{1,2}-[A-Za-z]+-\d{4})/,
  ];
  const text = $.html();
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      try { return new Date(m[1].replace(/-/g, ' ')).toISOString().split('T')[0]; } catch {}
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type A: stock fund — names in ol.pdf-holdings-reg, aggregate in td.pdf-holdings-prt
// ─────────────────────────────────────────────────────────────────────────────
function parseStockFund($, fund) {
  const names = [];
  $('ol.pdf-holdings-reg li').each((_, el) => {
    const n = $(el).text().trim();
    if (n) names.push(n);
  });

  const aggregateText = $('td.pdf-holdings-prt').first().text().trim();
  const totalText     = $('td.pdf-holdings-total').first().text().trim();
  const aggregate     = parseFloat(aggregateText) || null;
  const totalHoldings = parseInt(totalText) || null;
  const estWeight     = aggregate && names.length ? +(aggregate / names.length).toFixed(2) : null;

  return {
    fundType:       'stock',
    isFundOfFunds:  false,
    totalHoldings,
    top10Aggregate: aggregate,
    dataQuality:    names.length >= 10 ? 'top10-names-only' : `partial:${names.length}`,
    holdings: names.map((name, i) => ({
      name,
      rank:          i + 1,
      weight:        estWeight,
      weightSource:  'estimated',
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type B: fund-of-funds — allocation tables in div[id^="target-allocation"]
// Each category section has its own table; we collect all of them
// ─────────────────────────────────────────────────────────────────────────────
function parseFoFund($, fund) {
  const holdings = [];

  // Collect category names from the accordion headers
  const categoryNames = [];
  $('[id^="target-allocation-trigger"]').each((_, el) => {
    // Category name is in a span inside the button, strip the percentage
    const fullText = $(el).text().trim();
    // Remove trailing percentage like "48.4" or "U.S. Equities 48.4"
    const catName = fullText.replace(/[\d.]+$/, '').trim();
    categoryNames.push(catName);
  });

  // Collect holdings from each allocation table
  $('div[id^="target-allocation-"] table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name   = $(cells[0]).text().trim();
    const weight = parseFloat($(cells[1]).text().trim());
    if (name && !isNaN(weight) && weight > 0) {
      holdings.push({ name, weight, weightSource: 'actual', rank: holdings.length + 1 });
    }
  });

  // Also check for mmf-style tables (different structure)
  if (holdings.length === 0) {
    $('table.table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const name   = $(cells[0]).text().trim();
        const weight = parseFloat($(cells[1]).text().trim());
        if (name && name.length > 3 && !isNaN(weight) && weight > 0 && weight < 100) {
          holdings.push({ name, weight, weightSource: 'actual', rank: holdings.length + 1 });
        }
      }
    });
  }

  return {
    fundType:       'fund-of-funds',
    isFundOfFunds:  true,
    totalHoldings:  holdings.length,
    top10Aggregate: null,
    dataQuality:    holdings.length > 0 ? 'full-allocation' : 'failed',
    holdings:       holdings.sort((a, b) => b.weight - a.weight),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch and parse a single fund
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFund(slug) {
  const fund = FIDELITY_FUNDS[slug];
  if (!fund) {
    console.error(`Unknown slug: ${slug}`);
    return null;
  }

  const url = `${BASE_URL}/en/products/funds/${slug}/?series=${fund.series}`;
  console.log(`\nFetching ${slug} (${fund.code}) [${fund.type}]...`);

  let html;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    html = res.data;
    fs.writeFileSync(`./fidelity-${slug}.html`, html);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    return null;
  }

  const $      = cheerio.load(html);
  const asOf   = extractDate($);
  const parsed = fund.type === 'fof' ? parseFoFund($, fund) : parseStockFund($, fund);

  if (!parsed.holdings.length) {
    console.error(`  ✗ No holdings parsed — check fidelity-${slug}.html`);
    return null;
  }

  const result = {
    fundCode:  fund.code,
    fundName:  fund.name,
    slug,
    source:    'fidelity-html',
    url,
    asOf,
    scrapedAt: new Date().toISOString(),
    ...parsed,
  };

  console.log(`  ✓ ${fund.name}`);
  console.log(`    Type:        ${parsed.fundType}`);
  console.log(`    As of:       ${asOf ?? 'unknown'}`);
  console.log(`    Holdings:    ${parsed.holdings.length}`);
  if (parsed.top10Aggregate) console.log(`    Aggregate:   ${parsed.top10Aggregate}%`);
  console.log();
  parsed.holdings.slice(0, 10).forEach((h, i) => {
    const w = h.weight != null ? `${h.weight}%${h.weightSource === 'estimated' ? ' (est)' : ''}` : 'n/a';
    console.log(`      ${String(i+1).padStart(2)}. ${h.name.padEnd(50)} ${w}`);
  });
  if (parsed.holdings.length > 10) {
    console.log(`      ... and ${parsed.holdings.length - 10} more`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Do I own X?" — works across both fund types
// For fund-of-funds: searches underlying fund names
// For stock funds: searches stock names
// ─────────────────────────────────────────────────────────────────────────────
function doIOwn(query, portfolio, results) {
  const q          = query.toLowerCase().trim();
  const totalValue = portfolio.reduce((s, p) => s + p.value, 0);
  const matches    = [];

  for (const pos of portfolio) {
    const fund = results[pos.fundCode];
    if (!fund) continue;
    const posWeight = pos.value / totalValue;

    for (const h of fund.holdings) {
      if (h.name.toLowerCase().includes(q)) {
        const eff = h.weight ? (posWeight * h.weight) / 100 : null;
        matches.push({
          stock:               h.name,
          fund:                fund.fundName,
          fundCode:            pos.fundCode,
          fundType:            fund.fundType,
          rank:                h.rank,
          weightInFund:        h.weight,
          portfolioExposurePct: eff ? +(eff * 100).toFixed(2) : null,
          dollarExposure:       eff ? +(eff * totalValue).toFixed(2) : null,
          isActualWeight:       h.weightSource === 'actual',
        });
      }
    }
  }

  const unresolvedFunds = portfolio.filter(p => !results[p.fundCode]).map(p => p.fundCode);
  const caveat = unresolvedFunds.length ? ` [${unresolvedFunds.join(', ')} not resolved]` : '';

  if (!matches.length) {
    return { query, found: false, message: `"${query}" not found in any resolved Fidelity fund.${caveat}` };
  }

  const totalPct    = matches.reduce((s, m) => s + (m.portfolioExposurePct || 0), 0);
  const totalDollar = matches.reduce((s, m) => s + (m.dollarExposure || 0), 0);
  const fundList    = [...new Set(matches.map(m => m.fund))].join(', ');
  const hasActual   = matches.some(m => m.isActualWeight);
  const hasEstimate = matches.some(m => !m.isActualWeight);

  let msg = `Yes — "${matches[0].stock}" found in: ${fundList}.`;
  if (totalPct > 0) {
    msg += ` ~${totalPct.toFixed(2)}% portfolio exposure (~$${totalDollar.toFixed(0)} of $${totalValue.toLocaleString('en-CA')}).`;
  }
  if (hasEstimate) msg += ' ⚠ Some weights estimated.';

  return { query, found: true, totalPct, totalDollar, foundIn: matches, message: msg };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args  = process.argv.slice(2);
  const slugs = args.length > 0 ? args.map(a => a.toLowerCase()) : Object.keys(FIDELITY_FUNDS);

  console.log('═══════════════════════════════════════════════════════');
  console.log(' Fidelity Canada Holdings Scraper v2');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Fetching: ${slugs.join(', ')}\n`);

  const results = {};
  const failed  = [];

  for (let i = 0; i < slugs.length; i++) {
    const result = await fetchFund(slugs[i]);
    if (result) results[slugs[i]] = result;
    else failed.push(slugs[i]);
    if (i < slugs.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  if (Object.keys(results).length > 0) {
    const portfolio = [
      { fundCode: 'gc',  value: 54248,  label: 'Greater Canada (FID1646)' },
      { fundCode: 'uet', value: 53342,  label: 'Global Innovators (FID5982)' },
      { fundCode: 'aee', value: 62207,  label: 'All-in-One Equity ETF (FID7567)' },
      { fundCode: 'mmf', value: 13373,  label: 'Global Equity+ (FID7648)' },
    ];
    const totalValue = portfolio.reduce((s, p) => s + p.value, 0);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(' PORTFOLIO — Your Fidelity LIRA funds');
    console.log(`  $${totalValue.toLocaleString('en-CA')} across ${portfolio.length} funds`);
    console.log('═══════════════════════════════════════════════════════');
    portfolio.forEach(p => {
      const f = results[p.fundCode];
      const status = f ? `✓ [${f.fundType}]` : '✗ not resolved';
      console.log(`  ${status.padEnd(18)} ${p.label.padEnd(42)} $${p.value.toLocaleString('en-CA')}`);
    });

    const queries = [
      'NVIDIA', 'Apple', 'Microsoft', 'Shopify', 'Franco-Nevada',
      'Fidelity U.S. Momentum', 'Fidelity Global Innovators', 'Bitcoin',
    ];
    console.log('\n  Stock / Fund queries:');
    queries.forEach(q => {
      const r = doIOwn(q, portfolio, results);
      console.log(`\n  ${r.found ? '✓' : '✗'} ${r.message}`);
    });
  }

  fs.writeFileSync('./fidelity-holdings.json',
    JSON.stringify({ version: 'v2', scrapedAt: new Date().toISOString(), results, failed }, null, 2)
  );

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Scraped: ${Object.keys(results).length} / ${slugs.length}`);
  if (failed.length) console.log(`Failed:  ${failed.join(', ')}`);
  console.log('Output: fidelity-holdings.json');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
