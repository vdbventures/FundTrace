// probe-vanguard-fund-list.js — get portId→ticker mapping for all Vanguard CA ETFs
// Run: node scripts/probe-vanguard-fund-list.js

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
        'referer': 'https://www.vanguard.ca/en/investor/products/products-group/etfs/VFV',
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

// Known portIds from the Puppeteer probe FundFinderFunds call
const KNOWN_PORT_IDS = [
  '1811','1817','1936',
  '9561','9554','9559','9560','9569','9570',
  '9558','9555','9550','9549','9742','9556',
  '9548','9828','9835','9795','9563',
  // Additional guesses
  '9562','9564','9565','9566','9567','9568',
];

async function main() {
  console.log('Fetching fund names/tickers for all Vanguard CA portIds…\n');

  const res = await post({
    operationName: 'FundFinderFunds',
    variables: {},
    query: `
      query FundFinderFunds {
        funds(portIds: ${JSON.stringify(KNOWN_PORT_IDS)}) {
          portId
          profile {
            fundFullName
            polarisPdtTypeIndicator
            assetClassificationLevel1
            listings {
              portId
              exchange
              stockExchangeMarketIdentifierCode
              identifiers {
                altId
                altIdCode
                altIdValue
              }
            }
          }
        }
      }
    `,
  });

  if (res.status !== 200 || res.body.includes('"errors"')) {
    console.log('Error:', res.body.slice(0, 400));
    return;
  }

  const data = JSON.parse(res.body);
  const funds = data?.data?.funds ?? [];

  console.log(`Found ${funds.length} funds:\n`);

  // Focus on ETFs listed on TSX
  const etfs = funds.filter(f =>
    f.profile?.polarisPdtTypeIndicator === 'ETF' ||
    f.profile?.listings?.some((l) => l.exchange?.toLowerCase().includes('toronto') ||
                          l.stockExchangeMarketIdentifierCode === 'XTSE')
  );

  console.log(`ETFs (${etfs.length}):`);
  const portIdMap = {};
  etfs.forEach((f) => {
    const listing = f.profile?.listings?.find((l) =>
      l.exchange?.toLowerCase().includes('toronto') ||
      l.stockExchangeMarketIdentifierCode === 'XTSE'
    ) ?? f.profile?.listings?.[0];
    const ticker = listing?.fundTicker ?? 'UNKNOWN';
    portIdMap[ticker] = f.portId;
    console.log(`  portId:${f.portId.padEnd(6)} ticker:${ticker.padEnd(8)} ${f.profile?.fundFullName ?? ''}`);
  });

  console.log('\n// portId map for vanguard-ca.ts:');
  console.log('const VANGUARD_CA_PORT_IDS: Record<string, string> = {');
  Object.entries(portIdMap).sort(([a], [b]) => a.localeCompare(b)).forEach(([ticker, portId]) => {
    console.log(`  '${ticker}': '${portId}',`);
  });
  console.log('};');

  // Also show all funds (mutual funds etc.)
  const nonEtfs = funds.filter((f) => !etfs.includes(f));
  if (nonEtfs.length > 0) {
    console.log(`\nNon-ETF funds (${nonEtfs.length}):`);
    nonEtfs.forEach((f) => {
      console.log(`  portId:${f.portId.padEnd(6)} type:${(f.profile?.polarisPdtTypeIndicator ?? 'FUND').padEnd(8)} ${f.profile?.fundFullName ?? ''}`);
    });
  }
}

main().catch(console.error);
