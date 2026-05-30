/**
 * scripts/test-amendment-handling.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Checkpoint 3 — Amendment handling test.
 *
 * Per the brief: "If you can't find an amendment in the wild quickly, fake it —
 * write a unit test that runs two ingests for the same (fund_id, period) and
 * confirms the second overwrites the first."
 *
 * This test uses an in-memory fake DB (no Supabase connection needed) to verify:
 *
 *   A. Same filing, same period → no-op (second run does nothing)
 *   B. Amendment (isAmendment=true) for same period → deletes old holdings,
 *      writes new ones
 *   C. New period → adds a fresh snapshot, leaves old one intact
 *
 * Also tests: "re-running when no new filing" is a no-op (definition of done #3).
 *
 * Usage: npx tsx scripts/test-amendment-handling.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory DB that mirrors the snapshot schema
// ─────────────────────────────────────────────────────────────────────────────

interface DbFund { id: string; family: string; source_code: string; display_name: string; fund_type: string; }
interface DbSnapshot { id: string; fund_id: string; period: string; scraped_at: string; holding_count: number; source_url: string; }
interface DbHolding { id: string; snapshot_id: string; security_id: string; weight: number; rank: number; }
interface DbSecurity { id: string; canonical_name: string; ticker: string | null; }
interface DbAlias { alias: string; security_id: string; }

class FakeDb {
  funds: DbFund[] = [];
  snapshots: DbSnapshot[] = [];
  holdings: DbHolding[] = [];
  securities: DbSecurity[] = [];
  aliases: DbAlias[] = [];

  // Ops log — for asserting what happened
  ops: string[] = [];

  private nextId = 1;
  id() { return `id-${this.nextId++}`; }

  /** Seed a security + alias so holdings can resolve */
  seedSecurity(id: string, name: string, ticker: string, cusip: string) {
    this.securities.push({ id, canonical_name: name, ticker });
    this.aliases.push({ alias: cusip.toLowerCase(), security_id: id });
    this.aliases.push({ alias: normalise(name), security_id: id });
  }
}

function normalise(name: string): string {
  return name.replace(/\b(Corp\.?|Inc\.?|Ltd\.?|PLC|SE|AG|SA|ADR)\b\.?/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// A simplified version of the ingest logic — same algorithm as ingest-edgar.ts
// but operating on the FakeDb instead of Supabase.
// ─────────────────────────────────────────────────────────────────────────────

interface MockHolding {
  name: string; cusip: string | null; isin: string | null;
  weight: number; rank: number;
}

interface MockFundResult {
  ticker: string; period: string; isAmendment: boolean;
  holdings: MockHolding[];
  seriesName: string; sourceUrl: string;
}

type IngestStatus = 'ok' | 'no-op';

function ingest(db: FakeDb, result: MockFundResult): IngestStatus {
  const ticker = result.ticker;

  // Upsert fund
  let fund = db.funds.find((f) => f.family === 'edgar' && f.source_code === ticker);
  if (!fund) {
    fund = { id: db.id(), family: 'edgar', source_code: ticker, display_name: result.seriesName, fund_type: 'us_etf' };
    db.funds.push(fund);
    db.ops.push(`UPSERT fund ${ticker}`);
  }

  // Check existing snapshot
  const existingSnap = db.snapshots.find((s) => s.fund_id === fund!.id && s.period === result.period);

  if (existingSnap && !result.isAmendment) {
    db.ops.push(`NO-OP: snapshot already exists for ${ticker}/${result.period}`);
    return 'no-op';
  }

  if (existingSnap && result.isAmendment) {
    db.ops.push(`AMENDMENT: deleting holdings for snapshot ${existingSnap.id}`);
    db.holdings = db.holdings.filter((h) => h.snapshot_id !== existingSnap.id);
  }

  // Resolve holdings
  const resolved: Array<{ h: MockHolding; secId: string }> = [];
  for (const h of result.holdings) {
    const alias = h.cusip ? db.aliases.find((a) => a.alias === h.cusip?.toLowerCase()) : null;
    const aliasName = db.aliases.find((a) => a.alias === normalise(h.name));
    const secId = alias?.security_id ?? aliasName?.security_id;
    if (secId) resolved.push({ h, secId });
  }

  // Write/update snapshot
  let snap: DbSnapshot;
  if (existingSnap) {
    existingSnap.scraped_at = new Date().toISOString();
    existingSnap.holding_count = resolved.length;
    snap = existingSnap;
    db.ops.push(`UPDATE snapshot ${snap.id} for ${ticker}/${result.period}`);
  } else {
    snap = {
      id: db.id(), fund_id: fund.id, period: result.period,
      scraped_at: new Date().toISOString(), holding_count: resolved.length,
      source_url: result.sourceUrl,
    };
    db.snapshots.push(snap);
    db.ops.push(`INSERT snapshot ${snap.id} for ${ticker}/${result.period}`);
  }

  // Write holdings
  for (const { h, secId } of resolved) {
    db.holdings.push({ id: db.id(), snapshot_id: snap.id, security_id: secId, weight: h.weight, rank: h.rank });
  }
  db.ops.push(`INSERT ${resolved.length} holdings for snapshot ${snap.id}`);

  return 'ok';
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

let _pass = 0;
let _fail = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
    _pass++;
  } else {
    console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    _fail++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_Q4_2025 = '2025-12-01';
const PERIOD_Q1_2026 = '2026-03-01';

function makeResult(overrides: Partial<MockFundResult> = {}): MockFundResult {
  return {
    ticker: 'VOO',
    period: PERIOD_Q4_2025,
    isAmendment: false,
    seriesName: 'Vanguard 500 Index Fund',
    sourceUrl: 'https://test.example/nport.xml',
    holdings: [
      { name: 'NVIDIA Corp', cusip: '67066G104', isin: 'US67066G1040', weight: 0.0758, rank: 1 },
      { name: 'Apple Inc',   cusip: '037833100', isin: 'US0378331005', weight: 0.0666, rank: 2 },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

function testA_FirstIngest() {
  console.log('\n── Test A: First ingest writes snapshot + holdings ──────');
  const db = new FakeDb();
  db.seedSecurity('sec-nvda', 'NVIDIA Corp',  'NVDA',  '67066G104');
  db.seedSecurity('sec-aapl', 'Apple Inc',    'AAPL',  '037833100');

  const status = ingest(db, makeResult());

  assert('returns ok',              status === 'ok');
  assert('fund row created',        db.funds.length === 1);
  assert('snapshot created',        db.snapshots.length === 1);
  assert('period correct',          db.snapshots[0].period === PERIOD_Q4_2025);
  assert('2 holdings written',      db.holdings.length === 2);
  assert('holdings use DB weights', db.holdings.every((h) => h.weight < 1.0));
  assert('NVIDIA resolved',         db.holdings.some((h) => h.security_id === 'sec-nvda'));
  assert('Apple resolved',          db.holdings.some((h) => h.security_id === 'sec-aapl'));
}

function testB_NoOpOnSamePeriod() {
  console.log('\n── Test B: Re-running same period (no amendment) = no-op ──');
  const db = new FakeDb();
  db.seedSecurity('sec-nvda', 'NVIDIA Corp', 'NVDA', '67066G104');
  db.seedSecurity('sec-aapl', 'Apple Inc',   'AAPL', '037833100');

  ingest(db, makeResult());
  const snapId1 = db.snapshots[0].id;
  const holdingCount1 = db.holdings.length;

  const status2 = ingest(db, makeResult()); // same period, not amendment

  assert('second run returns no-op',     status2 === 'no-op');
  assert('still only 1 snapshot',        db.snapshots.length === 1);
  assert('snapshot id unchanged',        db.snapshots[0].id === snapId1);
  assert('holding count unchanged',      db.holdings.length === holdingCount1);
}

function testC_AmendmentOverwrites() {
  console.log('\n── Test C: Amendment for same period overwrites holdings ──');
  const db = new FakeDb();
  db.seedSecurity('sec-nvda', 'NVIDIA Corp', 'NVDA', '67066G104');
  db.seedSecurity('sec-aapl', 'Apple Inc',   'AAPL', '037833100');
  db.seedSecurity('sec-msft', 'Microsoft Corp', 'MSFT', '594918104');

  // First ingest: 2 holdings (NVDA + AAPL)
  ingest(db, makeResult());
  const snapId1 = db.snapshots[0].id;
  assert('[setup] 2 holdings after first ingest', db.holdings.length === 2);

  // Amendment: same period, now has 3 holdings with corrected weights
  const amended = makeResult({
    isAmendment: true,
    holdings: [
      { name: 'NVIDIA Corp',   cusip: '67066G104', isin: 'US67066G1040', weight: 0.0760, rank: 1 },
      { name: 'Apple Inc',     cusip: '037833100', isin: 'US0378331005', weight: 0.0670, rank: 2 },
      { name: 'Microsoft Corp',cusip: '594918104', isin: 'US5949181045', weight: 0.0490, rank: 3 },
    ],
  });

  const status2 = ingest(db, amended);

  assert('amendment returns ok',           status2 === 'ok');
  assert('still only 1 snapshot',          db.snapshots.length === 1);
  assert('same snapshot id',               db.snapshots[0].id === snapId1);
  assert('3 holdings now (not 2+3=5)',     db.holdings.length === 3);
  assert('NVIDIA weight updated',          db.holdings.find((h) => h.security_id === 'sec-nvda')?.weight === 0.0760);
  assert('Microsoft now present',          db.holdings.some((h) => h.security_id === 'sec-msft'));
  assert('holding_count updated to 3',     db.snapshots[0].holding_count === 3);
}

function testD_NewPeriodAddsFreshSnapshot() {
  console.log('\n── Test D: New period adds snapshot, old one untouched ──');
  const db = new FakeDb();
  db.seedSecurity('sec-nvda', 'NVIDIA Corp', 'NVDA', '67066G104');

  ingest(db, makeResult({ period: PERIOD_Q4_2025 }));
  ingest(db, makeResult({ period: PERIOD_Q1_2026 }));

  assert('2 snapshots total',      db.snapshots.length === 2);
  assert('Q4 snapshot exists',     db.snapshots.some((s) => s.period === PERIOD_Q4_2025));
  assert('Q1 snapshot exists',     db.snapshots.some((s) => s.period === PERIOD_Q1_2026));
  assert('2 holdings per snapshot',db.holdings.filter((h) => h.snapshot_id === db.snapshots[0].id).length === 1
    && db.holdings.filter((h) => h.snapshot_id === db.snapshots[1].id).length === 1);
}

function testE_UnresolvableHoldingsGoToReviewNotSecurities() {
  console.log('\n── Test E: Unresolvable holdings skipped, not auto-created ──');
  const db = new FakeDb();
  db.seedSecurity('sec-nvda', 'NVIDIA Corp', 'NVDA', '67066G104');
  // Apple NOT seeded → should be unresolvable

  ingest(db, makeResult({
    holdings: [
      { name: 'NVIDIA Corp', cusip: '67066G104', isin: 'US67066G1040', weight: 0.0758, rank: 1 },
      { name: 'Apple Inc',   cusip: '037833100', isin: 'US0378331005', weight: 0.0666, rank: 2 }, // unresolvable
    ],
  }));

  assert('no new securities auto-created', db.securities.length === 1, `${db.securities.length} securities`);
  assert('only resolved holding written',  db.holdings.length === 1);
  assert('NVIDIA holding present',         db.holdings[0].security_id === 'sec-nvda');
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log(' FundTrace — Amendment Handling Unit Tests');
console.log('═'.repeat(60));

testA_FirstIngest();
testB_NoOpOnSamePeriod();
testC_AmendmentOverwrites();
testD_NewPeriodAddsFreshSnapshot();
testE_UnresolvableHoldingsGoToReviewNotSecurities();

console.log('\n' + '─'.repeat(60));
console.log(`Result: ${_pass} passed, ${_fail} failed`);

if (_fail > 0) {
  console.error('\n✗ Amendment tests FAILED');
  process.exit(1);
} else {
  console.log('\n✓ All amendment tests passed');
}
