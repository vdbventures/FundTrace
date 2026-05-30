// probe-vanguard-gpx3.js — discover pagination on borHoldings and fetch all holdings
// Run: node scripts/probe-vanguard-gpx3.js

const https = require('https');

function post(body) {
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

// Fetch one page of delayered holdings
async function fetchPage(portId, lastItemKey) {
  const res = await post({
    operationName: 'BorHoldingsPage',
    variables: { portIds: [portId], lastItemKey: lastItemKey ?? null },
    query: `
      query BorHoldingsPage($portIds: [String!]!, $lastItemKey: String) {
        borHoldings(portIds: $portIds) {
          delayeredHoldings(lastItemKey: $lastItemKey) {
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
    `,
  });

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  const json = JSON.parse(res.body);
  if (json.errors) {
    throw new Error('GQL error: ' + JSON.stringify(json.errors[0]).slice(0, 200));
  }
  const holding = json?.data?.borHoldings?.[0];
  return {
    items: holding?.delayeredHoldings?.items ?? [],
    lastItemKey: holding?.delayeredHoldings?.lastItemKey ?? null,
  };
}

async function main() {
  console.log('Fetching all VFV delayered holdings via cursor pagination…\n');

  const PORT_ID = '9563';
  const allHoldings = [];
  let cursor = null;
  let page = 1;

  while (true) {
    console.log(`  Page ${page} (cursor: ${cursor?.slice(0, 30) ?? 'null'})…`);
    let result;
    try {
      result = await fetchPage(PORT_ID, cursor);
    } catch (e) {
      console.error('  Error:', e.message);
      break;
    }

    const { items, lastItemKey } = result;
    console.log(`    → ${items.length} items, nextCursor: ${lastItemKey?.slice(0, 30) ?? 'null'}`);

    if (items.length === 0) break;
    allHoldings.push(...items);

    if (!lastItemKey || lastItemKey === cursor) break;
    cursor = lastItemKey;
    page++;

    if (page > 100) { console.log('Safety limit hit'); break; }

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n✅ Total holdings fetched: ${allHoldings.length}`);

  // Top 10
  const sorted = allHoldings.sort((a, b) => (b.marketValuePercentage ?? 0) - (a.marketValuePercentage ?? 0));
  console.log('\nTop 10 holdings:');
  sorted.slice(0, 10).forEach((h, i) => {
    console.log(`  [${String(i+1).padStart(2)}] ${(h.issuerName ?? h.securityLongDescription ?? 'unknown').padEnd(40)} ${h.marketValuePercentage?.toFixed(4)}%`);
    console.log(`       SEDOL:${(h.sedol1 ?? 'n/a').padEnd(8)} CUSIP:${(h.cusip ?? 'n/a').padEnd(12)} ISIN:${h.isin ?? 'n/a'}  Ticker:${h.ticker ?? 'n/a'}`);
  });

  // Weight sum
  const totalWeight = allHoldings.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
  console.log(`\nWeight sum: ${totalWeight.toFixed(4)}% (expect ~99-100%)`);

  // ISIN coverage
  const withIsin = allHoldings.filter(h => h.isin && h.isin.trim()).length;
  const withCusip = allHoldings.filter(h => h.cusip && h.cusip.trim()).length;
  const withSedol = allHoldings.filter(h => h.sedol1 && h.sedol1.trim()).length;
  const withTicker = allHoldings.filter(h => h.ticker && h.ticker.trim()).length;
  console.log(`\nIdentifier coverage (out of ${allHoldings.length}):`);
  console.log(`  ISIN:   ${withIsin} (${(100*withIsin/allHoldings.length).toFixed(1)}%)`);
  console.log(`  CUSIP:  ${withCusip} (${(100*withCusip/allHoldings.length).toFixed(1)}%)`);
  console.log(`  SEDOL:  ${withSedol} (${(100*withSedol/allHoldings.length).toFixed(1)}%)`);
  console.log(`  Ticker: ${withTicker} (${(100*withTicker/allHoldings.length).toFixed(1)}%)`);
}

main().catch(console.error);
