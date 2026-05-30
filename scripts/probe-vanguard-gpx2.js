// probe-vanguard-gpx2.js
// 1. Introspect the borHoldings field schema
// 2. Try various query shapes to find what works
// Run: node scripts/probe-vanguard-gpx2.js

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

async function main() {
  // ── 1. Introspect borHoldings field ──────────────────────────────────────
  console.log('[1] Introspect borHoldings field args and return type…');
  const intro = await post({
    query: `{
      __type(name: "Query") {
        fields {
          name
          args { name type { name kind ofType { name kind ofType { name kind } } } }
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }`,
  });
  if (intro.status === 200) {
    try {
      const d = JSON.parse(intro.body);
      const fields = d?.data?.__type?.fields ?? [];
      const borField = fields.find(f => f.name === 'borHoldings' || f.name === 'borDelayeredHoldings');
      const allBorFields = fields.filter(f => f.name?.toLowerCase().includes('bor') || f.name?.toLowerCase().includes('hold'));
      console.log('Holdings-related fields:', allBorFields.map(f => f.name));
      if (borField) {
        console.log('borHoldings args:');
        borField.args?.forEach(a => console.log(`  ${a.name}: ${JSON.stringify(a.type)}`));
      }
    } catch (e) {
      console.log('Parse error:', e.message, intro.body.slice(0, 300));
    }
  } else {
    console.log('Introspection status:', intro.status, intro.body.slice(0, 200));
  }

  // ── 2. Try borHoldings with just portIds ─────────────────────────────────
  console.log('\n[2] borHoldings(portIds: ["9563"]) — no pagination arg…');
  const res2 = await post({
    operationName: 'BorHoldingsTest',
    variables: { portIds: ['9563'] },
    query: `
      query BorHoldingsTest($portIds: [String!]!) {
        borHoldings(portIds: $portIds) {
          delayeredHoldings {
            items {
              issuerName
              marketValuePercentage
              sedol1
              cusip
              isin
            }
          }
        }
      }
    `,
  });
  console.log('Status:', res2.status, 'Length:', res2.body.length);
  console.log('NVIDIA:', res2.body.toLowerCase().includes('nvidia'));
  if (res2.status !== 200 || res2.body.includes('error')) {
    console.log('Response (500 chars):', res2.body.slice(0, 500));
  } else {
    try {
      const d = JSON.parse(res2.body);
      const items = d?.data?.borHoldings?.[0]?.delayeredHoldings?.items ?? [];
      console.log('Items count:', items.length);
      if (items.length > 0) {
        console.log('First 3:', items.slice(0, 3).map(h => `${h.issuerName} (${h.marketValuePercentage?.toFixed(4)}%)`));
      }
    } catch(e) { console.log('Parse error:', e.message); }
  }

  // ── 3. Try with page/pageSize args ───────────────────────────────────────
  console.log('\n[3] borHoldings with page args…');
  const res3 = await post({
    operationName: 'BorHoldingsPage',
    variables: { portIds: ['9563'], page: 1, pageSize: 25 },
    query: `
      query BorHoldingsPage($portIds: [String!]!, $page: Int, $pageSize: Int) {
        borHoldings(portIds: $portIds, page: $page, pageSize: $pageSize) {
          delayeredHoldings {
            items {
              issuerName
              marketValuePercentage
              sedol1
              cusip
              isin
            }
          }
        }
      }
    `,
  });
  console.log('Status:', res3.status, 'Length:', res3.body.length);
  console.log('NVIDIA:', res3.body.toLowerCase().includes('nvidia'));
  if (res3.status !== 200 || res3.body.includes('"errors"')) {
    console.log('Response (300 chars):', res3.body.slice(0, 300));
  }

  // ── 4. Try the FundsHoldingsQuery operation used by the real page ────────
  // From the Puppeteer probe, the FundsHoldingsQuery uses securityTypes
  // for FI/MM. Try it with equity types.
  console.log('\n[4] FundsHoldingsQuery with equity securityTypes…');
  const res4 = await post({
    operationName: 'FundsHoldingsQuery',
    variables: {
      portIds: ['9563'],
      lastItemKey: null,
      securityTypes: ['EQ'],
    },
    query: `
      query FundsHoldingsQuery($portIds: [String!]!, $lastItemKey: String, $securityTypes: [String]) {
        borHoldings(portIds: $portIds) {
          delayeredHoldings {
            items {
              issuerName
              marketValuePercentage
              sedol1
            }
          }
        }
      }
    `,
  });
  console.log('Status:', res4.status, 'Length:', res4.body.length);
  console.log('NVIDIA:', res4.body.toLowerCase().includes('nvidia'));
  if (res4.body.includes('"errors"')) {
    console.log('Errors:', res4.body.slice(0, 400));
  }
}

main().catch(console.error);
