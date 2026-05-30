# FundTrace — Claude Code Task Brief: Holdings Estimation Layer

## Goal

Build a derivation layer that estimates a fund's full current holdings by
combining its **most recent top-N disclosure** (e.g. Sun Life's monthly top-10)
with its **most recent full historical disclosure** (e.g. the same fund's
semi-annual MRFP filing showing ~40-50 holdings).

The goal is to extend coverage from "10 names with exact current weights" to
"40-50 names with exact top-10 weights and estimated tail weights, clearly
labeled as estimates."

This is a derivation layer, not a new data source. The raw snapshots stay
pristine and truthful — only the fund's actually-disclosed data. Estimation
output is stored separately or flagged distinctly, never silently mixed.

---

## Why This Matters

Without this layer, funds that disclose only a top-10 (Sun Life Granite line,
others) can only show users 10 names. The other ~70% of the fund is opaque.

With this layer, those funds can answer "do I own NVIDIA" even when NVIDIA
falls below the top-10 cutoff — by estimating its current weight from the
historical full disclosure. This is the difference between FundTrace working
on Sun Life portfolios and FundTrace being mostly blind on them.

---

## Context You Need to Re-Read First

1. `CONTEXT.md` — overall project state
2. `fundtrace-snapshot-schema.sql` — the snapshot/diff data model. This task
   may require a small schema addition (see below)
3. The existing Sun Life scraper (`slgi-v8.js` / `lib/scrapers/slgi.ts`) — the
   primary use case
4. The diff/alert logic — to confirm estimated rows are excluded from alerts

---

## The Estimation Technique

Given:
- **Snapshot A**: fresh top-N for the fund (e.g. 10 names, current weights)
- **Snapshot B**: historical full disclosure (e.g. 47 names, weights from 6 months ago)

Compute estimated current holdings:

1. The top-N names from Snapshot A keep their exact weights — these are facts,
   not estimates. Sum their weights → call it `top_weight` (e.g. 0.38).

2. The remaining residual weight is `1 - top_weight` (e.g. 0.62). This is the
   share of the fund held by the tail names not in the current top-N.

3. From Snapshot B, identify the **tail names**: names present in B but not
   in A's top-N. Take their historical weights.

4. Normalize: divide each tail name's historical weight by the sum of all
   tail-name historical weights. Now they sum to 1.0.

5. Scale: multiply each normalized weight by the residual (0.62 in the example).
   These are the estimated current weights for the tail names.

6. The output is: top-N at exact weights + tail names at estimated weights, all
   summing to ~100%.

### Assumptions and their failure modes

Be explicit about what this technique cannot capture:

- **Names added since Snapshot B**: invisible to the estimate. If the manager
  bought a mid-tier position after B was filed, it doesn't appear.
- **Names removed since Snapshot B**: still appear in the estimate at non-zero
  weight, even though the fund no longer holds them.
- **Major rebalancing or strategy shifts**: the tail's relative proportions
  may have changed substantially, not just at the margins.

These are not fixable — they're the inherent limit of estimation from sparse
data. The mitigation is **transparent labeling** (see below), not fancier math.

---

## Scope of This Task

In scope:
- A derivation job that runs after each new top-N snapshot lands
- Storage for estimated holdings, distinct from raw fund-disclosed holdings
- A confidence indicator on each estimated row
- A freshness limit: don't estimate if the historical anchor is older than
  12 months (tunable constant)
- A read path that returns combined (real + estimated) holdings for display,
  with each row tagged
- Explicit exclusion of estimated rows from diff/alert computation

Out of scope (defer):
- UI work — the brief defines the data contract and labeling; UI consumes it
  in a separate task
- Cross-fund estimation (using one fund's disclosure to estimate another) —
  too speculative for v1
- Backfilling estimates for old snapshots — only estimate going forward

---

## Schema Decision (Resolve Before Building)

Two options. Pick deliberately and document.

### Option A: Flag column on existing tables (lighter touch)

Add:
- `fund_snapshots.disclosure_quality` — `'full'` | `'top_n'`
- `snapshot_holdings.is_estimated` — boolean, default false
- `snapshot_holdings.estimated_from_snapshot_id` — nullable FK to the
  historical anchor snapshot used

Estimated rows live in `snapshot_holdings` alongside real rows for the same
snapshot, distinguished only by the flag. **Critical:** every query that reads
holdings for diffing or alerts must filter `is_estimated = false`. Forgetting
this in any query corrupts alerts with phantom drift.

### Option B: Separate `estimated_holdings` table (stronger guarantees)

A parallel table with the same shape as `snapshot_holdings`, plus the anchor
snapshot FK. Diff/alert queries never join to it, so contamination is
structurally impossible.

Cost: one more table, slightly more code to read combined holdings for display.

**Recommendation: Option B.** The stronger guarantee is worth the modest extra
complexity. The whole risk of this feature is real and estimated data getting
mixed in queries where they shouldn't be. Option B makes that mistake harder.

---

## Critical Implementation Details

### Freshness limit
Define a constant `MAX_ANCHOR_AGE_MONTHS = 12`. If the most recent full
disclosure for a fund is older than that, **do not estimate**. The fund's
holdings page should display the top-N only, with a note that older holdings
are not currently estimable. Estimating against year-old data is more misleading
than honest absence.

This constant should be easily tunable as you learn what users tolerate.

### Snapshot quality tagging
When the scrapers write a `fund_snapshots` row, they should populate a
`disclosure_quality` field correctly:
- Sun Life top-10 → `'top_n'`
- Fidelity full holdings → `'full'`
- Canada Life full → `'full'`
- EDGAR N-PORT → `'full'`
- Canadian ETF issuer feeds (full holdings) → `'full'`

This requires updating each existing scraper to set the field. Small change,
must be done.

### The estimation job

A function `estimateHoldings(snapshotId)` that:
1. Loads the target snapshot's holdings (the top-N).
2. Finds the most recent prior snapshot of the same fund with
   `disclosure_quality = 'full'` that's within the freshness window.
3. If no qualifying anchor exists → no-op, log it.
4. If an anchor exists → run the math, write estimated rows.

This runs as a step after the relevant scrapers complete. For Sun Life,
attach it to the SLGI ingest. For others, only run it when a fund's snapshot
is `top_n`.

### Estimation must be deterministic and reproducible
Same inputs → same outputs, every time. No randomness, no time-dependent
fudge factors. If you re-run estimation against the same snapshot pair, you
get identical rows. This matters because:
- Users will refresh and see the same numbers
- Audit/debugging is straightforward
- The "is this fresh or stale" question stays unambiguous

### Diff/alert exclusion
The existing diff job (`computeSnapshotDiffs` or whatever it's named) must
read only from real (non-estimated) holdings. With Option B above this is
structural. With Option A this is a discipline that every query must follow.

For aggregate sector-drift alerts on Sun Life funds specifically: alerts
compare disclosure-to-disclosure (real-to-real), even if that means the
alert cadence for those funds is semi-annual rather than monthly. **Do not
compare a top-N snapshot's full estimated rollup against a prior full snapshot's
rollup** — the difference is mostly measurement error, not real change, and
that's exactly the false-signal problem we want to avoid.

### The read path returns labeled holdings
A function `getDisplayHoldings(snapshotId)` returns an array of holdings, each
tagged as:
- `confidence: 'disclosed'` — fund's actual reported weight
- `confidence: 'estimated'` — derived weight, with `anchor_period` (the date
  of the historical anchor used)

The UI consumes this and renders accordingly. The data contract is the
boundary — UI work is separate, but this brief defines what the UI will see.

---

## Test Plan

Before declaring done:

1. **Mathematical correctness.** Take a fund where you have both a full
   disclosure and a top-10 snapshot in the same dataset. Run the estimation
   using the full disclosure as the *anchor* and the top-10 as the current.
   The estimated tail weights, when added to the real top-10 weights, must
   sum to 100% (within rounding).

2. **Pseudo-reconciliation.** For a fund where you have a full disclosure at
   two recent periods, pretend the most recent one is a "top-10 plus anchor."
   Run the estimation. Compare the estimated tail weights to the *actual*
   reported tail weights from the real full disclosure. They won't match
   exactly — but the aggregate sector/country totals computed from the
   estimate should be within a few percentage points of the totals computed
   from the real full data. If they're wildly off, the technique isn't working
   for that fund family and that's worth knowing.

3. **Freshness limit enforced.** Create a test case where the only available
   anchor is 18 months old. Confirm the estimator returns no estimates and
   logs the reason. Holdings page should fall back to top-10 only.

4. **Diff/alert exclusion.** Run the diff job against a fund that has
   estimated rows. Confirm none of those rows appear in `snapshot_diffs`.
   This is the single most important correctness test — if estimates leak
   into alerts, the feature is worse than not shipping it.

5. **Idempotency.** Run estimation twice against the same snapshot. Identical
   output. No duplicate rows.

---

## Files to Create / Modify

Create:
- `lib/estimation/estimate-holdings.ts` — the core estimation function, pure
  logic, unit-testable in isolation
- `lib/estimation/anchor-selector.ts` — finds the right historical anchor for
  a given snapshot, applies the freshness rule
- `lib/estimation/read-holdings.ts` — the combined read path returning labeled
  holdings for display
- `scripts/estimate-holdings.ts` — runner, called after relevant scrapers

Modify:
- Schema: implement chosen Option (A or B) above
- Each existing scraper (`slgi.ts`, `fidelity.ts`, `canadalife.ts`, `edgar.ts`,
  etc.): populate `disclosure_quality` correctly when writing snapshots
- The diff job: confirm it only reads real (non-estimated) holdings

---

## Definition of Done

1. Running estimation against a Sun Life Granite fund (e.g. SLMGF) produces
   a labeled holdings list with ~40-50 names: top-10 marked `disclosed`,
   the rest marked `estimated` with the anchor period.
2. The math passes the sum-to-100% test and the pseudo-reconciliation test.
3. Re-running is a no-op.
4. The freshness limit correctly suppresses estimation when no fresh anchor
   exists.
5. The diff job produces zero rows referencing estimated holdings.
6. Each existing scraper correctly tags its snapshots with `disclosure_quality`.
7. There's a clear data contract (`getDisplayHoldings` return shape) that the
   UI task can consume.

---

## What NOT to Do in This Session

- Don't ship UI changes. The data contract is the deliverable.
- Don't let estimated rows into the diff/alert path. Test this explicitly.
- Don't estimate against stale anchors. Enforce the freshness limit.
- Don't get clever with the math. The straightforward technique is the right
  one; sophisticated extrapolation (price-adjusting weights, sector-modeling,
  etc.) is out of scope and likely makes the estimates worse, not better.
- Don't backfill estimates for old snapshots. Forward-only.
- Don't change the diff/alert logic itself, only its filter for source quality.

---

## Open Questions to Resolve Before Starting

1. **Which Sun Life funds have a usable full historical disclosure available
   to FundTrace today?** This task is most valuable for those funds. If the
   SLGI scraper currently captures only the top-10 and the semi-annual full
   disclosures are not in the database, the historical anchors don't exist
   yet. Before this task can ship usefully, the full disclosures need to be
   ingested at least once per covered fund. Confirm status; if missing, the
   prerequisite is a one-time historical scrape, not part of this task.

2. **Where does the semi-annual full disclosure live for each affected fund
   family?** Sun Life publishes MRFPs on SEDAR+ and on its own site. Confirm
   the source format and whether the existing scraper can fetch it or whether
   a new ingestion path is needed.

3. **Schema option A or B?** Stated recommendation is B; confirm before
   building.

---

## Opening Prompt for Claude Code

```
Read CONTEXT.md, fundtrace-snapshot-schema.sql, and the SLGI scraper
(lib/scrapers/slgi.ts or slgi-v8.js) first.

Today's task: build the holdings estimation layer per
fundtrace-estimation-task-brief.md.

Before writing code, resolve the three open questions in the brief:
1. Do we have historical full disclosures for Sun Life funds in the DB?
2. Where are they sourced from?
3. Confirm schema Option B (separate estimated_holdings table) or argue for A.

Stop and check in with me after:
1. The three open questions are resolved
2. The math passes the sum-to-100% test on a real Sun Life fund
3. Before integrating with the existing scrapers' write path
```
