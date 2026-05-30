# FundTrace — Claude Code Task Brief: Canadian ETF Issuer Feeds

## Goal

Build ingestion adapters for the major Canadian ETF issuers (Vanguard Canada,
iShares/BlackRock Canada, BMO, Horizons, Purpose, CI, Mackenzie) that pull full
holdings from each issuer's public website and write them into the existing
`fund_snapshots` + `snapshot_holdings` tables.

Unlike the US side, there is **no universal regulatory fallback** for Canadian
ETFs — no equivalent of EDGAR N-PORT exists. Each issuer publishes holdings
voluntarily on their own site, in their own format. The universe of issuers is
small enough that one adapter per issuer is tractable.

This task is the Canadian-ETF analog to the US Step 2 (issuer-feed) work, and
sits alongside (not replacing) the Canadian *mutual fund* scrapers that are
already in production (SLGI, Fidelity, Canada Life).

---

## Context You Need to Re-Read First

1. `CONTEXT.md` — overall project state
2. `fundtrace-snapshot-schema.sql` — the snapshot/diff data model. New adapters
   write into the same tables.
3. The existing Canadian mutual fund scrapers (`slgi-v8.js`, etc.) — these are
   the closest analog in conventions and shape, even though the data sources
   differ.
4. The EDGAR pipeline (`lib/scrapers/edgar.ts`) once it's in — for the
   per-source adapter pattern.

The architectural principle remains: downstream code does not know which source
a snapshot came from. ETF issuer feeds are just more sources writing into the
same rails.

---

## Scope of This Task

In scope:
- Build one adapter per major Canadian ETF issuer, each exposing the same
  internal interface
- Cover the top ETFs by retail AUM first; long tail later
- Write `fund_snapshots` + `snapshot_holdings` rows in the same shape Canadian
  mutual fund scrapers and EDGAR produce
- Handle the issuer-specific quirks (file format, identifier conventions,
  refresh cadence) inside each adapter so the runner doesn't care

Out of scope (defer):
- ETFs from issuers not on the priority list — log them as `unresolved` with
  a clear "not currently supported" disposition
- Canadian mutual fund work — already covered by existing scrapers
- US ETFs from issuer feeds — that's the US Step 2 task, separate
- Any UI surfacing changes — pipeline task only

---

## Priority Order (Verify Before Building)

Build adapters in this order. The list reflects rough AUM-and-popularity
priority but **verify current issuer AUM and the specific ETFs Canadians
actually hold before locking in the order** — this list is based on general
knowledge and may be outdated:

1. **Vanguard Canada** — VFV, VEQT, VBAL, VGRO, VCN, VUN, VAB
2. **iShares Canada (BlackRock)** — XIC, XIU, XEQT, XGRO, XBAL, XAW
3. **BMO ETFs** — ZSP, ZEB, ZCN, ZAG, ZGRO
4. **Horizons / Global X** — HXS, HXT, HXQ, HXCN (note: Horizons rebranded; verify current name)
5. **Purpose Investments** — BTCC (Bitcoin ETF), plus others if user demand exists
6. **CI Global Asset Management** — CI ETF line
7. **Mackenzie ETFs** — if AUM justifies

Each issuer is its own adapter session. Don't try to do all of them at once.
Vanguard Canada first because it has the highest retail visibility and likely
covers the largest share of FundTrace user portfolios.

Before starting each adapter, verify the issuer's holdings page still exists
at the expected location and the format hasn't changed.

---

## Critical Implementation Details

### One adapter per issuer, common interface
Each adapter is its own file: `lib/scrapers/vanguard-ca.ts`,
`lib/scrapers/ishares-ca.ts`, etc. Each exports the same function shape — likely
`fetchFundHoldings(ticker)` returning the same internal structure that the
EDGAR scraper and Canadian mutual fund scrapers return. The runner picks the
adapter by ticker prefix or registry lookup, never by branching logic in the
runner itself.

### File format varies — usually CSV or JSON
Canadian ETF issuers generally publish daily holdings as CSV or JSON, often
linked from the product page. Some require constructing the URL from the
ticker; some have an index page listing all ETFs. Build each adapter to handle
its issuer's specific pattern; don't try to generalize prematurely.

If an issuer's "holdings page" turns out to be HTML-only (no clean download),
fall back to HTML scraping for that issuer, same way the Canada Life scraper
works.

### Identifier resolution
Canadian ETF holdings often come with multiple identifiers (ticker, ISIN,
CUSIP, sometimes SEDOL). Route every holding through the existing
`security_aliases` table:
1. Try CUSIP/ISIN match → existing security
2. Fall back to ticker match
3. Fall back to normalized name match (`normaliseName()`)
4. Unmatched → review queue, do not auto-create

Canadian ETFs frequently hold US securities (VFV is essentially VOO), which
means the same `security_id` your EDGAR pipeline already resolved should match.
This is the payoff of canonical resolution.

### Cadence
Most issuers publish daily, but daily ingestion is overkill for FundTrace's
quarterly-level alert model. Run the issuer-feed job **weekly**, same cadence
as EDGAR. The schema treats each weekly pull as a snapshot with that week's
date as `period` — the diff system will compare against the previous snapshot
naturally.

Optionally, expose a per-fund refresh button for the user-facing "refresh
holdings" feature (already discussed in the product flow). This calls the
adapter on demand, bypassing the weekly schedule.

### Licensing terms — read them per issuer
Each ETF issuer's holdings data has its own terms of use. Most permit
redisplay for non-commercial or fair-use purposes; some explicitly restrict
commercial redistribution.

Before each adapter ships, read the issuer's website terms and confirm the use
case (a consumer-facing tool showing the user the holdings of an ETF they
themselves own) is permitted. Flag any issuer with ambiguous or restrictive
terms — don't ship the adapter, escalate the question. This is the licensing
discipline we've talked about throughout; it matters more here than for EDGAR
(which is unambiguously public regulatory data).

### Log and skip, don't fail-the-fund
Same discipline as EDGAR. Partial ingest beats no ingest. A weird derivative
line item in an ETF's holdings shouldn't break the whole snapshot.

### Handle the rebrand/restructure risk
Canadian ETF issuers have a history of acquisitions, rebrands, and
restructurings (Horizons → Global X; First Trust acquired by various; etc.).
Build each adapter to fail loudly when the issuer's URL structure or format
changes, so silent breakage doesn't accumulate.

---

## Test Plan

For each adapter, before shipping:

1. **Reconciliation against the issuer's own page.** Pull holdings via the
   adapter, render them, compare to what the issuer's website shows for that
   ETF. Top 10 holdings, weights, and total holding count should match.

2. **Cross-source reconciliation where possible.** VFV ostensibly holds the
   US S&P 500 via VOO. The adapter for VFV should resolve its underlying VOO
   position cleanly, and the EDGAR pipeline's VOO snapshot should be reachable
   from VFV's snapshot through your `securities` table. If a FundTrace user
   owns VFV, the look-through should reach VOO's underlying equities.

3. **Snapshot writes correctly.** Same as EDGAR test 2: `fund_snapshots` and
   `snapshot_holdings` rows present, weights sum to ~100%, every `security_id`
   resolves.

4. **Idempotency.** Re-running for the same `(fund_id, period)` is a no-op,
   not a duplicate.

---

## Files to Create

Per adapter, following the existing scraper conventions:

- `lib/scrapers/vanguard-ca.ts` (and one per issuer)
- `lib/scrapers/issuer-registry.ts` — maps tickers to which adapter handles
  them. The runner consults this, not branching logic.

Extend:
- `lib/fund-registry.json` — add the new tickers and their issuer flag
- `scripts/ingest-canadian-etfs.ts` — the runner, iterates known tickers,
  delegates to the right adapter via the registry
- Whatever schedule/cron config exists — add the weekly trigger

---

## Definition of Done (per adapter)

1. `node scripts/ingest-canadian-etfs.ts --ticker VFV` (or whichever) ingests
   the ETF and writes a snapshot reconciling to the issuer's published data.
2. Re-running the same ticker without new issuer data is a no-op.
3. Holdings with no resolvable identifier go to the review queue.
4. The adapter follows the same internal interface as the EDGAR adapter and
   the Canadian mutual fund scrapers.
5. The issuer's terms of use have been read and the use case is confirmed
   acceptable (or escalated if not).

## Definition of Done (overall task)

Adapters complete for the top 3 issuers (Vanguard Canada, iShares Canada, BMO)
covering at least 15-20 of the most-held Canadian ETFs. The remaining issuers
are valid follow-up tasks, not required for this session.

---

## What NOT to Do in This Session

- Don't try to build all 7 issuers in one session. Ship 3, validate, then
  decide whether the rest are worth doing now or later.
- Don't generalize the adapters into one parameterized adapter. The whole point
  is each issuer has its own quirks; generalizing prematurely will fight you.
- Don't touch the diff or alert logic.
- Don't change the schema.
- Don't add UI changes.
- Don't ship an adapter without reading its issuer's terms of use.

---

## Open Question Before Starting

This task assumes the EDGAR pipeline is complete and the `securities` table is
populated with US equities from N-PORT ingestion. If EDGAR isn't done yet, the
cross-source reconciliation test (VFV → VOO underlying) won't work. Confirm
EDGAR status before starting this task; if EDGAR is incomplete, finish it first.

---

## Opening Prompt for Claude Code

```
Read CONTEXT.md, fundtrace-snapshot-schema.sql, and the existing scraper files
(slgi-v8.js, fidelity-scraper-v2.js, canadalife-scraper-v1.js, and
lib/scrapers/edgar.ts) first.

Today's task: build the first Vanguard Canada adapter per
fundtrace-canadian-etf-task-brief.md. Start with VFV specifically — verify
the issuer's holdings page is accessible and parseable, then build the adapter
and reconcile against the issuer's own published holdings.

Stop and check in with me after:
1. Confirming the Vanguard Canada holdings page format and confirming the
   licensing terms permit our use case
2. The first successful end-to-end VFV ingest with reconciliation
3. Before starting the second issuer adapter
```
