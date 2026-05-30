// probe-vanguard-gpx4.js — fetch all VFV holdings with proper dynamic query
// Run: node scripts/probe-vanguard-gpx4.js

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

// Build a query with inline literal args — avoids variable type issues
function buildHoldingsQuery(portId, lastItemKey, limit) {
  // Use inline literals, no variables, to sidestep type inference issues
  const portIdsLiteral = `["${portId}"]`;
  const args = [`limit: ${limit}`];
  if (lastItemKey) {
    const escaped = lastItemKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    args.push(`lastItemKey: "${escaped}"`);
  }
  const argsStr = args.join(', ');

  return {
    operationName: 'BorHoldingsPage',
    variables: {},
    query: `
      query BorHoldingsPage {
        borHoldings(portIds: ${portIdsLiteral}) {
          delayeredHoldings(${argsStr}) {
            items {
              issuerName
              securityLongDescription
              marketValuePercentage
              gicsSectorDescription
              sedol1
              cusip
              isin
              ticker
            }
            lastItemKey
          }
        }
      }
    `.trim(),
  };
}

async function fetchPage(portId, lastItemKey, limit) {
  const body = buildHoldingsQuery(portId, lastItemKey, limit);
  const res = await post(body);

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
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
  // ── Try limit:1000 to get all at once ────────────────────────────────────
  console.log('[1] limit:1000 — all in one request?');
  try {
    const p = await fetchPage('9563', null, 1000);
    console.log(`  → ${p.items.length} items, hasMore: ${!!p.lastItemKey}`);
    if (p.items.length > 100) {
      const total = p.items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
      console.log(`  Weight sum: ${total.toFixed(2)}%`);
      console.log('  NVIDIA:', p.items.find(h => h.issuerName?.includes('NVIDIA'))?.marketValuePercentage?.toFixed(4) + '%');
      await printResults(p.items);
      return;
    }
    if (p.lastItemKey) {
      console.log('  Server capped at', p.items.length, '— need pagination');
    }
  } catch (e) {
    console.log('  Error:', e.message.slice(0, 150));
  }

  // ── Try limit:100 pagination ──────────────────────────────────────────────
  console.log('\n[2] Paginate with limit:100…');
  try {
    const all = await paginateAll('9563', 100);
    if (all.length > 100) {
      await printResults(all);
      return;
    }
  } catch (e) {
    console.log('  Error:', e.message.slice(0, 200));
  }

  // ── Try limit:25 pagination ───────────────────────────────────────────────
  console.log('\n[3] Paginate with limit:25…');
  try {
    const all = await paginateAll('9563', 25);
    await printResults(all);
  } catch (e) {
    console.log('  Error:', e.message.slice(0, 200));
  }
}

async function paginateAll(portId, limit) {
  const all = [];
  let cursor = null;
  let page = 1;
  while (true) {
    const p = await fetchPage(portId, cursor, limit);
    console.log(`  Page ${page}: ${p.items.length} items`);
    if (!p.items.length) break;
    all.push(...p.items);
    cursor = p.lastItemKey;
    if (!cursor) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
    if (page > 50) { console.log('  Safety limit hit'); break; }
  }
  return all;
}

async function printResults(items) {
  const sorted = items.sort((a, b) => (b.marketValuePercentage ?? 0) - (a.marketValuePercentage ?? 0));
  console.log(`\n✅ Total: ${items.length} holdings`);
  const totalWeight = items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
  console.log(`Weight sum: ${totalWeight.toFixed(4)}%`);

  console.log('\nTop 10:');
  sorted.slice(0, 10).forEach((h, i) => {
    console.log(`  [${i+1}] ${(h.issuerName ?? '').padEnd(35)} ${h.marketValuePercentage?.toFixed(4)}%  ISIN:${h.isin ?? 'n/a'}  Ticker:${h.ticker ?? 'n/a'}`);
  });

  const withIsin = items.filter(h => h.isin).length;
  const withCusip = items.filter(h => h.cusip).length;
  const withTicker = items.filter(h => h.ticker).length;
  console.log('\nIdentifier coverage:');
  console.log(`  ISIN: ${withIsin}/${items.length}  CUSIP: ${withCusip}/${items.length}  Ticker: ${withTicker}/${items.length}`);
}

main().catch(console.error);
