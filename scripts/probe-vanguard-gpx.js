// probe-vanguard-gpx.js
// Test whether the /gpx/graphql endpoint is reachable from plain Node.js
// (no Puppeteer, no cookies) using the headers discovered by the Puppeteer probe.
//
// If this works server-side, we don't need Puppeteer for Vanguard CA.
// Run: node scripts/probe-vanguard-gpx.js

const https = require('https');

const GQL_URL = 'https://www.vanguard.ca/gpx/graphql';

// Minimal borHoldings query - asking for the delayered equity holdings
const HOLDINGS_QUERY = `
query FundsHoldingsQuery($portIds: [String!]!, $lastItemKey: String) {
  borHoldings(portIds: $portIds, lastItemKey: $lastItemKey) {
    delayeredHoldings {
      items {
        issuerName
        securityLongDescription
        gicsSectorDescription
        icbIndustryDescription
        marketValuePercentage
        sedol1
        cusip
        isin
        ticker
        quantity
        __typename
      }
      lastItemKey
      __typename
    }
    __typename
  }
}
`.trim();

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'www.vanguard.ca',
      path: '/gpx/graphql',
      method: 'POST',
      headers: {
        // Headers confirmed present in the Puppeteer-intercepted request
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://www.vanguard.ca',
        'referer': 'https://www.vanguard.ca/en/product/etf/equity/9563/vanguard-sp-500-index-etf',
        'x-consumer-id': 'ca0',
        'apollographql-client-name': 'gpx',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept-language': 'en-CA,en;q=0.9',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('Testing /gpx/graphql server-side (no Puppeteer)…\n');

  // ── Test 1: borHoldings query ────────────────────────────────────────────
  console.log('[1] borHoldings query for VFV (portId 9563)…');
  const res1 = await post({
    operationName: 'FundsHoldingsQuery',
    variables: { portIds: ['9563'], lastItemKey: null },
    query: HOLDINGS_QUERY,
  });

  console.log('  Status:', res1.status);
  console.log('  Body length:', res1.body.length);

  const hasNvidia = res1.body.toLowerCase().includes('nvidia');
  const hasApple = res1.body.toLowerCase().includes('apple');
  console.log('  Contains NVIDIA:', hasNvidia);
  console.log('  Contains Apple:', hasApple);

  if (res1.status === 200 && (hasNvidia || hasApple)) {
    console.log('\n✅ SERVER-SIDE QUERY WORKS — Puppeteer not needed for Vanguard CA!');

    // Parse and inspect the response
    try {
      const json = JSON.parse(res1.body);
      const items = json?.data?.borHoldings?.[0]?.delayeredHoldings?.items ?? [];
      console.log('  Holdings count:', items.length);

      const top5 = items.slice(0, 5);
      console.log('\n  Top 5 holdings:');
      top5.forEach((h, i) => {
        console.log(`    [${i+1}] ${h.issuerName} — ${h.marketValuePercentage?.toFixed(4)}%`);
        console.log(`         SEDOL: ${h.sedol1 ?? 'n/a'}  CUSIP: ${h.cusip ?? 'n/a'}  ISIN: ${h.isin ?? 'n/a'}  Ticker: ${h.ticker ?? 'n/a'}`);
      });

      const lastItemKey = json?.data?.borHoldings?.[0]?.delayeredHoldings?.lastItemKey;
      console.log('\n  Pagination lastItemKey:', lastItemKey ?? 'null (all data in one page)');

      // Weight sum check
      const totalWeight = items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
      console.log(`  Weight sum: ${totalWeight.toFixed(4)}% (expect ~100%)`);

    } catch (e) {
      console.log('  Parse error:', e.message);
      console.log('  Raw (first 500):', res1.body.slice(0, 500));
    }
  } else {
    console.log('\n❌ SERVER-SIDE QUERY FAILED — will need Puppeteer.');
    console.log('  Response (first 500):', res1.body.slice(0, 500));
  }

  // ── Test 2: Try without x-consumer-id to see if it's actually required ──
  console.log('\n[2] Same query WITHOUT x-consumer-id header…');
  const res2 = await post_noConsumerId({
    operationName: 'FundsHoldingsQuery',
    variables: { portIds: ['9563'], lastItemKey: null },
    query: HOLDINGS_QUERY,
  });
  console.log('  Status:', res2.status, '  NVIDIA:', res2.body.toLowerCase().includes('nvidia'));
  if (res2.status !== 200 || !res2.body.toLowerCase().includes('nvidia')) {
    console.log('  → x-consumer-id IS required');
  } else {
    console.log('  → x-consumer-id is NOT required (optional header)');
  }
}

function post_noConsumerId(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'www.vanguard.ca',
      path: '/gpx/graphql',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://www.vanguard.ca',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'apollographql-client-name': 'gpx',
        // intentionally NO x-consumer-id
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

main().catch(console.error);
