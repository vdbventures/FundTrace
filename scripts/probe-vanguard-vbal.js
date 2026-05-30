// probe-vanguard-vbal.js — diagnose VBAL 20,000-holding / 169% weight bug
// Run: node scripts/probe-vanguard-vbal.js
//
// Checks:
//   1. Per-page item count and lastItemKey value (detect cursor loop)
//   2. Duplicate items between page 1 and page 2 (first ISIN / name seen twice)
//   3. Per-page weight subtotal (flag runaway accumulation)
//   4. Whether VBAL genuinely has >20,000 holdings or hits a page cap

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
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept-language': 'en-CA,en;q=0.9',
        'content-length': String(Buffer.byteLength(payload)),
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function buildQuery(portId, limit, cursor) {
  const args = [`limit: ${limit}`];
  if (cursor) {
    const esc = cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    args.push(`lastItemKey: "${esc}"`);
  }
  return {
    operationName: 'VbalProbe',
    variables: {},
    query: `
      query VbalProbe {
        borHoldings(portIds: ["${portId}"]) {
          delayeredHoldings(${args.join(', ')}) {
            items {
              issuerName
              marketValuePercentage
              isin
              cusip
            }
            lastItemKey
          }
        }
      }
    `.trim(),
  };
}

async function fetchPage(portId, limit, cursor) {
  const res = await post(buildQuery(portId, limit, cursor));
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  if (json.errors) throw new Error('GQL: ' + JSON.stringify(json.errors[0]).slice(0, 200));
  const bor = json?.data?.borHoldings?.[0];
  return {
    items: bor?.delayeredHoldings?.items ?? [],
    lastItemKey: bor?.delayeredHoldings?.lastItemKey ?? null,
  };
}

async function main() {
  const VBAL_PORT_ID = '9578';
  const VEQT_PORT_ID = '9692';
  const PAGE_SIZE = 1000;

  // ── Step 1: First 4 pages for VBAL — log cursor and weight per page ────────
  console.log('=== VBAL pagination diagnostic ===\n');
  console.log(`Fetching ${PAGE_SIZE}-item pages for VBAL (portId ${VBAL_PORT_ID})…\n`);

  const pages = [];
  let cursor = null;
  for (let p = 1; p <= 4; p++) {
    process.stdout.write(`Page ${p}: fetching… `);
    const page = await fetchPage(VBAL_PORT_ID, PAGE_SIZE, cursor);
    const weightSubtotal = page.items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
    const cursorShort = page.lastItemKey
      ? page.lastItemKey.slice(0, 60) + (page.lastItemKey.length > 60 ? '…' : '')
      : 'null';
    console.log(`${page.items.length} items  weightSubtotal: ${weightSubtotal.toFixed(2)}%  cursor: ${cursorShort}`);
    pages.push(page);
    if (!page.lastItemKey || page.items.length === 0) {
      console.log('  → no next cursor, stopping early');
      break;
    }
    cursor = page.lastItemKey;
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Step 2: Cursor loop detection ─────────────────────────────────────────
  console.log('\n=== Cursor loop check ===');
  const cursors = pages.map(p => p.lastItemKey);
  const uniqueCursors = new Set(cursors.filter(Boolean));
  if (cursors.filter(Boolean).length !== uniqueCursors.size) {
    console.log('⚠️  CURSOR LOOP DETECTED — same cursor value repeated across pages');
    cursors.forEach((c, i) => console.log(`  Page ${i + 1} cursor: ${c?.slice(0, 80) ?? 'null'}`));
  } else {
    console.log('✅ Cursors are all distinct (no obvious loop)');
    cursors.forEach((c, i) => console.log(`  Page ${i + 1} cursor: ${c?.slice(0, 80) ?? 'null'}`));
  }

  // ── Step 3: Duplicate item detection between page 1 and page 2 ───────────
  if (pages.length >= 2) {
    console.log('\n=== Duplicate item check (page 1 vs page 2) ===');
    const p1Keys = new Set(pages[0].items.map(h => h.isin ?? h.cusip ?? h.issuerName));
    const p2Items = pages[1].items;
    const dups = p2Items.filter(h => p1Keys.has(h.isin ?? h.cusip ?? h.issuerName));
    if (dups.length > 0) {
      console.log(`⚠️  ${dups.length} items from page 2 appear identical to page 1 items`);
      dups.slice(0, 5).forEach(d =>
        console.log(`  dup: ${d.issuerName}  ISIN:${d.isin ?? '—'}  weight:${d.marketValuePercentage?.toFixed(4)}%`)
      );
    } else {
      console.log('✅ No duplicates between page 1 and page 2');
    }
  }

  // ── Step 4: Cumulative weight growth across pages ─────────────────────────
  console.log('\n=== Cumulative weight growth ===');
  let runningWeight = 0;
  pages.forEach((page, i) => {
    const sub = page.items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
    runningWeight += sub;
    console.log(`  After page ${i + 1}: cumulative weight = ${runningWeight.toFixed(2)}%  (${(i + 1) * PAGE_SIZE} items max)`);
  });

  // ── Step 5: First item of each page (spot check for content shift) ────────
  console.log('\n=== First item of each page ===');
  pages.forEach((page, i) => {
    const first = page.items[0];
    if (first) {
      console.log(`  Page ${i + 1}: ${first.issuerName}  ISIN:${first.isin ?? '—'}  weight:${first.marketValuePercentage?.toFixed(4)}%`);
    }
  });

  // ── Step 6: VEQT first page for comparison ────────────────────────────────
  console.log('\n=== VEQT page 1 for comparison (portId 9692) ===');
  const veqtP1 = await fetchPage(VEQT_PORT_ID, PAGE_SIZE, null);
  const veqtSub = veqtP1.items.reduce((s, h) => s + (h.marketValuePercentage ?? 0), 0);
  console.log(`  VEQT page 1: ${veqtP1.items.length} items  weight: ${veqtSub.toFixed(2)}%  hasMore: ${!!veqtP1.lastItemKey}`);
  console.log(`  VEQT page 1 first item: ${veqtP1.items[0]?.issuerName}  weight:${veqtP1.items[0]?.marketValuePercentage?.toFixed(4)}%`);

  // ── Step 7: Hypothesis summary ────────────────────────────────────────────
  console.log('\n=== Hypothesis summary ===');
  const totalWeight = pages.reduce((s, p) =>
    s + p.items.reduce((ss, h) => ss + (h.marketValuePercentage ?? 0), 0), 0);
  const totalItems = pages.reduce((s, p) => s + p.items.length, 0);
  console.log(`VBAL after ${pages.length} pages: ${totalItems} items, ${totalWeight.toFixed(2)}% weight`);
  if (totalWeight > 120) {
    console.log('⚠️  Weight far exceeds 100% — likely cause: bond sub-ETF holdings are NOT');
    console.log('   scaled to VBAL\'s allocation weight. Bond portfolio contributes ~100% instead of ~40%.');
    console.log('   Or the API is looping / returning overlapping pages.');
  } else {
    console.log('Weight looks reasonable for the pages fetched so far.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
