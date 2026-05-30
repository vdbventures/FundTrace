// probe-vanguard-fund-list2.js — inspect raw identifiers for VFV to find ticker field
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

async function main() {
  // Get VFV (9563) and VAB (9567?) identifiers to understand the structure
  const res = await post({
    operationName: 'FundIdentifiers',
    variables: {},
    query: `
      query FundIdentifiers {
        funds(portIds: ["9563","9561","9548","9558","9554","1811"]) {
          portId
          profile {
            fundFullName
            polarisPdtTypeIndicator
            identifiers { altId altIdCode altIdValue }
            listings {
              portId
              exchange
              stockExchangeMarketIdentifierCode
              identifiers { altId altIdCode altIdValue }
            }
          }
        }
      }
    `,
  });
  const data = JSON.parse(res.body);
  const funds = data?.data?.funds ?? [];
  funds.forEach(f => {
    console.log(`\n=== portId:${f.portId} — ${f.profile?.fundFullName} ===`);
    console.log('Profile identifiers:');
    f.profile?.identifiers?.forEach(id => console.log(`  ${id.altId} (${id.altIdCode}): ${id.altIdValue}`));
    console.log('Listings:');
    f.profile?.listings?.forEach(l => {
      console.log(`  Listing portId:${l.portId}  exchange:${l.exchange}  MIC:${l.stockExchangeMarketIdentifierCode}`);
      l.identifiers?.forEach(id => console.log(`    ${id.altId} (${id.altIdCode}): ${id.altIdValue}`));
    });
  });
}

main().catch(console.error);
