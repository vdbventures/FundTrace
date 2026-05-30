/**
 * Build Canada Life Fund Registry
 * Fetches the fund list page and extracts all fund names + instrument IDs
 * Output: canadalife-registry.json
 *
 * Usage: node build-canadalife-registry.js
 * Requires: npm install axios cheerio
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};

async function buildRegistry() {
  console.log('Fetching Canada Life fund list...');
  
  const res  = await axios.get('https://canadalifemutualfunds.fundata.com/?language=en', { headers: HEADERS });
  const html = res.data;
  const $    = cheerio.load(html);
  
  const registry = {};
  const funds    = [];

  // Extract all fund links — each fund is a link to /Fund/Snapshot/[ID]
  $('a[href*="/Fund/Snapshot/"]').each((_, el) => {
    const href         = $(el).attr('href');
    const name         = $(el).text().trim();
    const idMatch      = href.match(/\/Fund\/Snapshot\/(\d+)/);
    
    if (idMatch && name && name.length > 3) {
      const instrumentId = idMatch[1];
      
      // Skip duplicates
      if (registry[instrumentId]) return;

      // Infer asset class from fund name
      let assetClass = 'unknown';
      if (/equity|stock|growth/i.test(name))           assetClass = 'equity';
      else if (/bond|fixed|income|credit/i.test(name)) assetClass = 'fixed_income';
      else if (/balanced|portfolio|multi/i.test(name)) assetClass = 'balanced';
      else if (/money market|cash/i.test(name))        assetClass = 'money_market';

      // Infer series from name
      let series = null;
      const seriesMatch = name.match(/\b(Series\s+\w+|Series\s+\w+\d*|\bF\b|\bA\b|\bN\b|\bE\b)\s*$/i);
      if (seriesMatch) series = seriesMatch[1];

      registry[instrumentId] = {
        instrumentId,
        name,
        code:       `CL${instrumentId}`,
        series,
        assetClass,
        url:        `https://canadalifemutualfunds.fundata.com${href}`,
      };

      funds.push({ instrumentId, name, assetClass, series });
    }
  });

  console.log(`\nFound ${funds.length} funds`);

  // Print summary by asset class
  const byClass = {};
  funds.forEach(f => {
    byClass[f.assetClass] = (byClass[f.assetClass] || 0) + 1;
  });
  console.log('\nBy asset class:');
  Object.entries(byClass).sort((a,b) => b[1]-a[1]).forEach(([cls, count]) => {
    console.log(`  ${cls.padEnd(20)} ${count}`);
  });

  // Print first 20 funds
  console.log('\nFirst 20 funds:');
  funds.slice(0, 20).forEach(f => {
    console.log(`  ${f.instrumentId.padStart(6)}  ${f.name}`);
  });

  // Save full registry
  const output = {
    version:      '1.0',
    builtAt:      new Date().toISOString(),
    totalFunds:   funds.length,
    source:       'canadalifemutualfunds.fundata.com',
    registry,
  };

  fs.writeFileSync('./canadalife-registry.json', JSON.stringify(output, null, 2));
  console.log(`\nSaved to canadalife-registry.json`);

  // Also save a simple ID→name lookup for quick reference
  const simpleLookup = {};
  funds.forEach(f => { simpleLookup[f.instrumentId] = f.name; });
  fs.writeFileSync('./canadalife-id-lookup.json', JSON.stringify(simpleLookup, null, 2));
  console.log('Saved to canadalife-id-lookup.json');
}

buildRegistry().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
