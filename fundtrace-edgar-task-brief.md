# FundTrace — Claude Code Task Brief: EDGAR N-PORT Pipeline

## Goal

Build an ingestion pipeline that pulls US ETF and mutual fund holdings from SEC
EDGAR (Form N-PORT) and writes them into the existing `fund_snapshots` +
`snapshot_holdings` tables — using the same schema and conventions as the
Canadian scrapers (SLGI, Fidelity, Canada Life).

This becomes FundTrace's universal fallback for US fund holdings. Step 2 (top-20
ETF issuer-feed ingestion for fresher data) is a separate task; do not start it
in this session.

---

## Context You Need to Re-Read First

1. `CONTEXT.md` — overall project state
2. `chat-handoff-summary.md` — the original handoff doc
3. `fundtrace-snapshot-schema.sql` — the snapshot/diff data model. The new
   pipeline writes into the *same* tables. No schema changes in this task.
4. The existing Canadian scraper files (`slgi-v8.js`, `fidelity-scraper-v2.js`,
   `canadalife-scraper-v1.js`) — match their shape and conventions.

The key architectural principle: downstream code (diffs, alerts, page rendering)
does not know which source a snapshot came from. EDGAR is just another source
writing into the same rails.

---

## Scope of This Task

In scope:
- Ingest the **public N-PORT-P** filing for a given US fund (ETF or mutual fund)
- Extract **equity holdings only** (security identifier, name, weight)
- Resolve each holding through the existing `securities` / `security_aliases`
  tables
- Write one `fund_snapshots` row + N `snapshot_holdings` rows per ingest
- Handle filing amendments (N-PORT/A) correctly via the existing
  `unique (fund_id, period)` constraint

Out of scope (defer):
- Top-20 issuer-feed ingestion (Step 2, separate task)
- Non-equity holdings: bond detail, swaps, futures, FX forwards — bucket these
  as `other` or skip
- US mutual funds in the consumer flow — load the data, but don't surface in
  the UI yet
- A "comprehensive" N-PORT parser. Only parse what FundTrace actually uses.

---

## Critical Implementation Details

These are the things that bite people on EDGAR. Don't skip any.

### User-Agent header is mandatory
SEC EDGAR will rate-limit or block requests without a proper User-Agent
identifying you with a contact email. Set it once in the HTTP client.
Format: `FundTrace [your-name] [contact-email]`.

### Ticker → CIK/series mapping
Use the SEC's published mutual fund tickers JSON
(`https://www.sec.gov/files/company_tickers_mf.json`) to map tickers to
CIK + series identifiers. Download once, store as a lookup table in the existing
`funds` catalog. Don't try to search by name.

### Find the latest filing per fund
Use the EDGAR submissions API for the CIK
(`https://data.sec.gov/submissions/CIK{cik}.json`) to list filings.
Filter to `N-PORT-P` and `N-PORT-P/A`. Prefer the amended version (`/A`) for
the same period if one exists.

### Funds file on different fiscal calendars
Each fund's most recent public filing may be 47, 60, or 89 days old. That's
fine. Record `period` as whatever the filing says. The diff/alert system handles
varying cadences already.

### Parser approach
Evaluate `edgartools` (Python) against a real N-PORT filing for a fund you
can verify externally — pick a large, well-disclosed ETF like VOO. Test:
do the holdings it returns reconcile to the issuer's published holdings list?

- If yes → use it. Pin the version.
- If no → write a small parser using standard XML libraries. The relevant
  element list is `<invstOrSec>` — each one is a holding with name,
  identifier (CUSIP, sometimes ISIN), value, pct of net assets, asset type.
  Probably 100-200 lines.

Do NOT spend the session "evaluating libraries" abstractly. Pick one, run it
against VOO, look at output, decide in under an hour.

### Equity-only filter
N-PORT contains everything a fund holds — equities, bonds, swaps, futures,
cash. For FundTrace v1, filter to equity holdings before resolving into
`securities`. Bucket the rest as `other` at the fund level (a single row, or
skip entirely). Don't try to model derivatives.

### Identifier resolution
Each equity holding has a CUSIP (usually) and sometimes an ISIN. Push these
through the existing `security_aliases` table:
1. Try CUSIP match → existing security
2. Fall back to ISIN match
3. Fall back to normalized name match (the same `normaliseName()` logic the
   Canadian scrapers use)
4. If nothing matches, route to the review queue — do NOT auto-create new
   securities silently (this is the snapshot stability discipline)

### Log and skip, don't fail-the-fund
Some holdings will have missing fields, weird asset categorizations, or values
without weights. Log the issue and skip that line. A partial ingest is better
than failing the whole fund.

---

## Test Plan

Before declaring done, the pipeline must pass these three checks against a real
filing:

1. **VOO reconciliation.** Pull VOO's latest N-PORT-P. Compare top 10 holdings
   (by weight) and total holding count against Vanguard's published holdings
   list on vanguard.com. Holdings, weights, and identifiers should match within
   rounding. If they don't, the parser is wrong — fix before continuing.

2. **Snapshot writes correctly.** After ingest, query `fund_snapshots` and
   `snapshot_holdings` for the VOO entry. Verify period date is set, weights
   sum to ~100% across equity holdings, every `security_id` resolves to an
   existing row in `securities`.

3. **Amendment handling.** Find any fund with both N-PORT-P and N-PORT-P/A
   filed for the same period. Run ingest twice (P first, then /A). Verify the
   final snapshot reflects the amended data, not the original.

If you can't find an amendment in the wild quickly, fake it — write a unit test
that runs two ingests for the same `(fund_id, period)` and confirms the second
overwrites the first.

---

## Files to Create

Match the conventions of the existing scrapers:

- `lib/scrapers/edgar.ts` — main scraper module, mirrors the shape of
  `lib/scrapers/slgi.ts`. Exports `fetchFundHoldings(ticker)` returning the
  same internal shape Canadian scrapers return.
- `lib/edgar/nport-parser.ts` — pure parsing logic, no HTTP. Takes XML in,
  returns structured holdings out. Unit-testable in isolation.
- `lib/edgar/ticker-lookup.ts` — manages the SEC mutual fund tickers JSON.
  One-time download, cached.
- `scripts/ingest-edgar.ts` — the runner. Iterates funds in the catalog,
  fetches new filings, writes snapshots. This is what the scheduled job calls.

Update:
- `lib/fund-registry.json` — extend the asset type detection so US tickers
  resolve to a US-fund source flag pointing at EDGAR.
- Whatever the cron/schedule config is — add a weekly trigger for the EDGAR job.

---

## Definition of Done

1. `node scripts/ingest-edgar.ts --ticker VOO` ingests VOO and writes a complete
   snapshot that reconciles to Vanguard's published data.
2. The same script run on a US mutual fund ticker works without per-family
   special-casing.
3. Re-running on the same fund (no new filing) is a no-op — does not duplicate,
   does not re-write.
4. Re-running when an amendment has been filed correctly overwrites the prior
   snapshot for that period.
5. Holdings with no resolvable identifier go to the review queue, not into
   `securities` as new rows.
6. The pipeline writes the same snapshot shape Canadian scrapers do — confirmed
   by querying `fund_snapshots` and seeing rows with the same column population
   pattern.

---

## What NOT to Do in This Session

- Don't touch the diff or alert logic. EDGAR snapshots flow through the same
  diff job; don't reimplement.
- Don't build per-family logic. EDGAR is one pipeline for all US funds.
- Don't try to handle non-equity holdings precisely. Bucket and move on.
- Don't change the schema. If something seems to require a schema change,
  stop and flag it — it probably doesn't.
- Don't start the top-20 issuer-feed work. That's a separate task whose value
  depends on EDGAR being live first.
- Don't add UI changes. This is a pipeline task. UI surfaces US funds in a
  later task once data is loaded and validated.

---

## Opening Prompt for Claude Code

```
Read CONTEXT.md, chat-handoff-summary.md, and fundtrace-snapshot-schema.sql
first.

Today's task: build the EDGAR N-PORT ingestion pipeline per
fundtrace-edgar-task-brief.md. Start by re-reading that brief, then verify the
parser library decision against a real VOO filing before writing any other
code.

Stop and check in with me after:
1. The library-vs-DIY parser decision (after testing against VOO)
2. The first successful end-to-end VOO ingest
3. Before starting the runner / scheduler
```
