// probe-vanguard-portids.js — find all Vanguard CA ETF portIds including VEQT/VBAL/VGRO
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
        'referer': 'https://www.vanguard.ca/en/investor/products/products-group/etfs/',
        'x-consumer-id': 'ca0',
        'apollographql-client-name': 'gpx',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
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

function buildQuery(portIds) {
  return {
    operationName: 'FundFinder',
    variables: {},
    query: `
      query FundFinder {
        funds(portIds: ${JSON.stringify(portIds)}) {
          portId
          profile {
            fundFullName
            polarisPdtTypeIndicator
            listings {
              stockExchangeMarketIdentifierCode
              identifiers { altId altIdCode altIdValue }
            }
          }
        }
      }
    `.trim(),
  };
}

function extractTicker(fund) {
  for (const listing of fund.profile?.listings ?? []) {
    if (listing.stockExchangeMarketIdentifierCode === 'XTSE') {
      const tick = listing.identifiers?.find(id => id.altIdCode === 'CATK');
      if (tick) return tick.altIdValue;
    }
  }
  return null;
}

async function main() {
  // Known range: 1811, 1817, 1936, 9548-9570, 9742, 9795, 9828, 9835, 9563
  // VEQT confirmed at 9692 — probe 9680-9710 for VBAL, VGRO, VUN, VAB, VRIF
  const rangeLow = Array.from({length: 30}, (_, i) => String(9680 + i));
  const rangeHigh = Array.from({length: 20}, (_, i) => String(9710 + i));

  // Also try 9700s and 9800s for newer funds
  const portIds = [...new Set([
    // Known from previous probe
    '1811','1817','1936',
    '9548','9549','9550','9554','9555','9556','9558','9559','9560','9561','9562',
    '9563','9564','9565','9566','9567','9568','9569','9570',
    '9742','9795','9828','9835',
    // New range around VEQT (9692)
    ...rangeLow, ...rangeHigh,
  ])];

  console.log(`Querying ${portIds.length} portIds…\n`);

  const res = await post(buildQuery(portIds));
  if (res.status !== 200) {
    console.log('Error:', res.body.slice(0, 300));
    return;
  }
  const data = JSON.parse(res.body);
  const funds = (data?.data?.funds ?? []).filter(f => f.profile?.fundFullName);

  console.log(`Found ${funds.length} active funds:\n`);

  const result = [];
  funds.forEach(f => {
    const ticker = extractTicker(f);
    result.push({ portId: f.portId, ticker: ticker ?? '---', name: f.profile?.fundFullName, type: f.profile?.polarisPdtTypeIndicator });
    console.log(`  portId:${f.portId.padEnd(6)} ticker:${(ticker ?? '---').padEnd(8)} ${f.profile?.fundFullName}`);
  });

  console.log('\n// Complete portId map:');
  result
    .filter(r => r.ticker !== '---')
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
    .forEach(r => console.log(`  '${r.ticker}': '${r.portId}',  // ${r.name}`));
}

main().catch(console.error);
