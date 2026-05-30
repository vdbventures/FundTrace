// probe-vanguard-gql.js — discover Vanguard Canada GraphQL schema for fund holdings
const https = require('https');

const GQL_URL = 'https://www.vanguard.ca/api/graphql';

function gqlPost(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: 'www.vanguard.ca',
      path: '/api/graphql',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.vanguard.ca',
        'Referer': 'https://www.vanguard.ca/en/product/etf/equity/9563/vanguard-sp-500-index-etf',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Vanguard Canada GraphQL endpoint probe');
  console.log('URL:', GQL_URL);

  // 1. Try introspection
  console.log('\n[1] Schema introspection (top-level types)...');
  const intro = await gqlPost(`{ __schema { queryType { name } types { name kind } } }`);
  console.log('Status:', intro.status);
  if (intro.status === 200) {
    try {
      const data = JSON.parse(intro.body);
      const types = data?.data?.__schema?.types ?? [];
      console.log('Types found:', types.length);
      const relevant = types.filter(t =>
        t.name && !t.name.startsWith('__') &&
        /fund|etf|holding|portfolio|product|compo/i.test(t.name)
      );
      console.log('Relevant types:', relevant.map(t => t.name + '(' + t.kind + ')'));
    } catch(e) {
      console.log('Parse error:', e.message);
      console.log('Raw (first 500):', intro.body.slice(0, 500));
    }
  } else {
    console.log('Response:', intro.body.slice(0, 300));
  }

  // 2. Try common fund data query patterns
  console.log('\n[2] Try fund portfolio query with ID 9563...');
  const fundQueries = [
    // Common patterns for ETF portfolio data
    `{ fund(id: "9563") { ticker holdings { name weight } } }`,
    `{ etf(fundId: "9563") { holdings { securityName pctWeight } } }`,
    `{ portfolio(portId: "9563") { holdings { name allocation } } }`,
    `{ productPortfolio(portId: 9563) { holdings { securityName pctOfFundAssets } } }`,
    // Try with string vs number
    `{ fund(ticker: "VFV") { holdings { name weight } } }`,
  ];

  for (const q of fundQueries) {
    const res = await gqlPost(q);
    const preview = res.body.slice(0, 150).replace(/\n/g, ' ');
    console.log(`  [${res.status}]`, q.slice(0, 60).padEnd(60), '->', preview.slice(0, 80));
  }

  // 3. Try querying what's available
  console.log('\n[3] Try __type introspection for Query type...');
  const queryType = await gqlPost(`{
    __type(name: "Query") {
      fields {
        name
        args { name type { name kind ofType { name kind } } }
        type { name kind ofType { name kind } }
      }
    }
  }`);
  console.log('Status:', queryType.status);
  if (queryType.status === 200) {
    try {
      const data = JSON.parse(queryType.body);
      const fields = data?.data?.__type?.fields ?? [];
      console.log('Query fields:', fields.map(f => f.name).join(', '));
      // Show fields that look relevant to holdings
      const relevant = fields.filter(f => /fund|etf|hold|port|prod|compo/i.test(f.name));
      console.log('Relevant fields:', relevant.map(f => f.name + '(' + (f.args?.map(a=>a.name).join(',') || '') + ')'));
    } catch(e) {
      console.log('Parse error:', e.message, 'Raw:', queryType.body.slice(0, 300));
    }
  } else {
    console.log('Response:', queryType.body.slice(0, 300));
  }
}

main().catch(console.error);
