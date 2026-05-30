// probe-vanguard-puppeteer.js
// Probes whether headless Puppeteer can access Vanguard Canada VFV holdings.
// Critical risk: anti-bot detection (503, CAPTCHA, stealth required).
//
// What we're looking for:
//   1. Does the page load without being blocked?
//   2. Does the Angular app fire a GraphQL (or REST) request for holdings data?
//   3. What headers/cookies does that request use — can we replay it from Node?
//   4. Does the response contain individual stock names (NVIDIA test)?
//
// Run: node scripts/probe-vanguard-puppeteer.js

const puppeteer = require('puppeteer');

const VFV_URL = 'https://www.vanguard.ca/en/product/etf/equity/9563/vanguard-sp-500-index-etf';

async function main() {
  console.log('Launching headless browser…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  // ── Capture all XHR / Fetch requests ──────────────────────────────────────
  const capturedRequests = [];
  const capturedResponses = [];

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const resourceType = req.resourceType();
    if (['xhr', 'fetch'].includes(resourceType) || url.includes('/api/') || url.includes('graphql')) {
      capturedRequests.push({
        url,
        method: req.method(),
        resourceType,
        headers: req.headers(),
        postData: req.postData(),
      });
    }
    req.continue();
  });

  page.on('response', async res => {
    const url = res.url();
    if (['xhr', 'fetch'].includes(res.request().resourceType()) ||
        url.includes('/api/') || url.includes('graphql')) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      capturedResponses.push({
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? '',
        bodySnippet: body.slice(0, 500),
        bodyLength: body.length,
        hasNvidia: body.toLowerCase().includes('nvidia'),
      });
    }
  });

  // ── Navigate ───────────────────────────────────────────────────────────────
  console.log('Navigating to VFV product page…');
  let navStatus = null;
  try {
    const response = await page.goto(VFV_URL, {
      waitUntil: 'networkidle0',
      timeout: 60_000,
    });
    navStatus = response.status();
    console.log('Page HTTP status:', navStatus);
  } catch (e) {
    console.error('Navigation failed:', e.message);
    await browser.close();
    return;
  }

  // ── Check page content ─────────────────────────────────────────────────────
  const title = await page.title();
  console.log('Page title:', title);

  // Look for bot-detection signals
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  const isBotBlocked = /captcha|robot|access denied|403|blocked/i.test(bodyText);
  console.log('Bot blocked:', isBotBlocked);
  if (isBotBlocked) {
    console.log('Bot detection page text:', bodyText.slice(0, 300));
  }

  // Check if NVIDIA appears anywhere in rendered DOM
  const nvdiaInDom = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes('nvidia')
  );
  console.log('NVIDIA in rendered DOM:', nvdiaInDom);

  // Wait a bit more for lazy-loaded data
  await new Promise(r => setTimeout(r, 3000));

  // Check DOM again after wait
  const nvdiaAfterWait = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes('nvidia')
  );
  console.log('NVIDIA in DOM after 3s wait:', nvdiaAfterWait);

  // ── Report captured API calls ──────────────────────────────────────────────
  console.log(`\n── Captured API requests (${capturedRequests.length}) ──`);
  capturedRequests.forEach((r, i) => {
    console.log(`\n[${i}] ${r.method} ${r.url.slice(0, 120)}`);
    if (r.postData) console.log('    POST body:', r.postData.slice(0, 200));
  });

  console.log(`\n── Captured API responses (${capturedResponses.length}) ──`);
  capturedResponses.forEach((r, i) => {
    console.log(`\n[${i}] ${r.status} ${r.url.slice(0, 120)}`);
    console.log(`    Content-Type: ${r.contentType}`);
    console.log(`    Body length: ${r.bodyLength}  NVIDIA: ${r.hasNvidia}`);
    console.log(`    Snippet: ${r.bodySnippet.replace(/\n/g, ' ').slice(0, 200)}`);
  });

  // ── Find the holdings API call specifically ────────────────────────────────
  const holdingsCall = capturedResponses.find(r => r.hasNvidia);
  if (holdingsCall) {
    console.log('\n✅ HOLDINGS API CALL FOUND:');
    console.log('  URL:', holdingsCall.url);
    console.log('  Status:', holdingsCall.status);
    console.log('  Body length:', holdingsCall.bodyLength);

    // Find matching request for headers
    const matchReq = capturedRequests.find(r => r.url === holdingsCall.url);
    if (matchReq) {
      console.log('\n  REQUEST HEADERS (these are what we need to replay):');
      const relevantHeaders = Object.entries(matchReq.headers).filter(([k]) =>
        !['sec-fetch-', 'upgrade-', 'pragma', 'cache-control', 'accept-encoding'].some(p => k.startsWith(p))
      );
      relevantHeaders.forEach(([k, v]) => console.log(`    ${k}: ${v}`));
      if (matchReq.postData) {
        console.log('\n  POST BODY:');
        console.log(' ', matchReq.postData.slice(0, 500));
      }
    }

    // Show larger response snippet
    console.log('\n  RESPONSE SNIPPET (first 1000 chars):');
    console.log(holdingsCall.bodySnippet.slice(0, 1000));
  } else {
    console.log('\n❌ No API response containing NVIDIA found.');
    console.log('   Holdings may not have loaded, or NVIDIA is not in VFV top holdings,');
    console.log('   or the page requires additional interaction to show holdings.');
  }

  // ── Look for GraphQL specifically ──────────────────────────────────────────
  const gqlCalls = capturedResponses.filter(r => r.url.includes('graphql'));
  console.log(`\n── GraphQL calls: ${gqlCalls.length} ──`);
  gqlCalls.forEach((r, i) => {
    console.log(`[${i}] ${r.status} ${r.url}`);
    const matchReq = capturedRequests.find(req => req.url === r.url);
    if (matchReq?.postData) {
      console.log('  GQL query:', matchReq.postData.slice(0, 300));
    }
    console.log('  Response:', r.bodySnippet.slice(0, 300));
  });

  await browser.close();
  console.log('\nProbe complete.');
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
