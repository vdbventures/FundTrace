// probe-vanguard-ca.js — parse Vanguard CA serverApp-state JSON
const https = require('https');

const options = {
  hostname: 'www.vanguard.ca',
  path: '/en/product/etf/equity/9563/vanguard-sp-500-index-etf',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,*/*',
    'Accept-Language': 'en-CA,en;q=0.9',
  },
};

let html = '';
const req = https.get(options, (res) => {
  console.log('Status:', res.statusCode, 'Final:', res.headers['location'] ?? 'no-redirect');
  res.on('data', d => { html += d; });
  res.on('end', () => {
    console.log('HTML length:', html.length);

    // Extract serverApp-state JSON
    const match = html.match(/<script id="serverApp-state" type="application\/json">([^<]+)<\/script>/);
    if (!match) { console.log('No serverApp-state'); return; }

    // Decode HTML entities
    const decoded = match[1]
      .replace(/&q;/g, '"')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    let state;
    try { state = JSON.parse(decoded); } catch(e) {
      console.log('JSON parse error:', e.message);
      console.log('Raw snippet:', decoded.slice(0, 500));
      return;
    }

    const keys = Object.keys(state);
    console.log('State keys (' + keys.length + '):', keys.slice(0,30));

    // Look for holdings/portfolio/fund data keys
    const interestingKeys = keys.filter(k =>
      k.toLowerCase().match(/hold|portfolio|fund|etf|composition|position|weight|alloc/)
    );
    console.log('\nInteresting keys:', interestingKeys);

    interestingKeys.forEach(k => {
      console.log('\n' + k + ':');
      console.log(JSON.stringify(state[k]).slice(0, 400));
    });

    // Extract all URLs from the state
    const stateJson = JSON.stringify(state);
    const urlRegex = /https?:\/\/[a-z0-9.-]+\.[a-z]{2,6}\/[^"\\]{5,100}/g;
    const urls = [];
    let m;
    while ((m = urlRegex.exec(stateJson)) !== null) urls.push(m[0]);
    const unique = [...new Set(urls)];
    console.log('\nAll URLs in state:', unique.slice(0, 20));
  });
});
req.on('error', e => console.error('Request error:', e.message));
