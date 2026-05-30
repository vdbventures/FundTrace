// probe-vanguard-html.js — extract holdings from Vanguard CA SSR HTML
// The page is Angular Universal SSR (209KB) with state transferred in serverApp-state
const https = require('https');
const cheerio = require('cheerio');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Accept-Language': 'en-CA,en;q=0.9',
      },
    };
    let data = '';
    const req = https.get(opts, res => {
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

async function main() {
  const { status, body: html } = await fetch(
    'https://www.vanguard.ca/en/product/etf/equity/9563/vanguard-sp-500-index-etf'
  );
  console.log('Status:', status, 'Length:', html.length);

  // ── 1. Try Cheerio HTML scraping ───────────────────────────────────────────
  const $ = cheerio.load(html);

  // Look for holdings table in the HTML
  const tables = $('table');
  console.log('\nTables found:', tables.length);
  tables.each((i, t) => {
    const text = $(t).text().slice(0, 200).replace(/\s+/g, ' ');
    console.log(`  Table ${i}:`, text);
  });

  // Look for holding rows
  const holdingRows = $('[class*="holding"], [class*="portfolio"], [class*="composition"]');
  console.log('\nHolding-like elements:', holdingRows.length);
  holdingRows.slice(0, 5).each((i, el) => {
    console.log(`  Element ${i} (${$(el).prop('tagName')}.${$(el).attr('class')}):`, $(el).text().slice(0, 150).replace(/\s+/g, ' '));
  });

  // Look for NVIDIA anywhere in the page
  const nvdaIdx = html.indexOf('NVIDIA');
  if (nvdaIdx > -1) {
    console.log('\nNVIDIA found at position', nvdaIdx, ':');
    console.log(html.slice(Math.max(0, nvdaIdx - 50), nvdaIdx + 200));
  } else {
    console.log('\nNVIDIA NOT found in HTML');
  }

  // Look for weight/allocation percentages near stock names
  const weightPattern = /([A-Z][a-zA-Z .,&'-]{5,40})\s*[\r\n\t ]*[\d]{1,3}\.[\d]{1,4}%/g;
  const weightMatches = [];
  let m;
  while ((m = weightPattern.exec(html)) !== null && weightMatches.length < 20) {
    weightMatches.push({ name: m[1], raw: m[0].slice(0, 60) });
  }
  console.log('\nWeight patterns in HTML:', weightMatches.length, weightMatches.slice(0, 10));

  // ── 2. Parse serverApp-state more carefully ───────────────────────────────
  console.log('\n── serverApp-state analysis ──');
  const stateMatch = html.match(/<script id="serverApp-state" type="application\/json">([^<]+)<\/script>/);
  if (stateMatch) {
    const raw = stateMatch[1];
    console.log('Raw state length:', raw.length);

    // Try different decoding strategies
    const decoded = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'");

    // Find where JSON breaks
    try {
      JSON.parse(decoded);
      console.log('JSON parsed successfully!');
    } catch (e) {
      console.log('JSON parse error at:', e.message);
      // Show context around the error position
      const pos = parseInt(e.message.match(/position (\d+)/)?.[1] ?? 0);
      if (pos) {
        console.log('Context around error:', decoded.slice(Math.max(0, pos-100), pos+100));
      }
    }

    // Look for portfolio-related keys in the raw string (even if JSON is broken)
    const holdingMatches = raw.match(/"(?:holding|portfolio|composition|ticker|weight|allocation|pctOf)[^"]*":\s*[\[\{"][^}]{0,200}/gi)?.slice(0, 15) ?? [];
    console.log('\nHolding-related state keys:', holdingMatches);

    // Check for pre-loaded fund data blobs
    const fundDataBlob = raw.match(/"portId"\s*:\s*"?9563"?[\s\S]{0,200}/i)?.[0];
    if (fundDataBlob) console.log('\nFound fund data blob:', fundDataBlob.slice(0, 300));
  }

  // ── 3. Look for JSON-LD or other structured data ─────────────────────────
  const jsonLdBlocks = $('script[type="application/ld+json"]').map((_, el) => $(el).html()).get();
  console.log('\nJSON-LD blocks:', jsonLdBlocks.length);
  jsonLdBlocks.forEach((b, i) => console.log('  Block', i, ':', b?.slice(0, 200)));
}

main().catch(console.error);
