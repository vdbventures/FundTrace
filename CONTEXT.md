# FundTrace — Project Context
> Last updated: 2026-05-27
> Read this file at the start of every Claude Code session.

---

## What This Product Is

FundTrace is a Canadian mutual fund and ETF transparency tool. It answers one question:

**"Do I actually own [stock]?"**

Users enter their mutual fund and ETF holdings. FundTrace looks through each fund to reveal the underlying stocks they actually own — with dollar amounts, not just percentages. It works for Canadian mutual funds, LIRAs, group RRSPs, TFSAs, and accounts that no existing tool can handle.

**Founding story:** The builder couldn't find out whether their Sun Life LIRA held NVIDIA. ETFInsight — the closest competitor — couldn't resolve the Sun Life fund at all. FundTrace was built to solve exactly that problem.

---

## The Problem We Solve

Most Canadian investors hold mutual funds in registered accounts (LIRA, RRSP, TFSA, group RRSP). They have no idea what stocks those funds actually hold. Existing tools like ETFInsight and Guardfolio:

- Are built on SEC EDGAR data — they can't see Canadian-domiciled mutual funds
- Failed to resolve Sun Life MFS International Value Fund entirely
- Have broken screenshot import (the feature exists but failed in testing)
- Are dashboard-first — require ticker entry before showing any value
- Show no results for Fidelity Canada group plan codes (FID1646, FID5982 etc.)

FundTrace solves this with proprietary scrapers for Canadian fund families that no third-party API covers.

---

## Unique Competitive Advantage

**We have working data pipelines for Canadian funds that no competitor has:**

1. **Sun Life Global Investments (SLGI)** — GraphQL API confirmed working
   - Resolves all Granite Portfolio funds (SLMCF, SMIPF, SMEIA, SLMGF)
   - Resolves Sun Life MFS International Value Fund (SIVFF)
   - Returns exact holdings weights from current monthly snapshot

2. **Fidelity Canada** — HTML scraper confirmed working
   - Resolves Fidelity Greater Canada Fund (FID1646/gc)
   - Resolves Fidelity Global Innovators (FID5982/uet)
   - Resolves Fidelity All-in-One Equity ETF (FID7567/aee) — fund of funds
   - Resolves Fidelity Global Equity+ (FID7648/mmf) — fund of funds

These funds are invisible to ETFInsight, Guardfolio, FMP API, and every other existing tool.

---

## Target User

**Primary:** Canadian investor with a LIRA, group RRSP, or RRSP containing mutual funds they can't see through. Specifically:
- Has Sun Life, Fidelity, Manulife, or Canada Life funds in a workplace pension/LIRA
- Can't connect their account via Plaid (most group plans aren't supported)
- Wonders "do I own NVIDIA?" or "am I too concentrated in tech?"
- Frustrated by tools that only work for US ETFs

**Secondary:** DIY Canadian investors with a mix of ETFs (VFV, XEQT, VEQT) and mutual funds.

**Acquisition channels:**
- r/PersonalFinanceCanada (founding story lands authentically here)
- r/Bogleheads, r/financialindependence
- SEO: "does FXAIX own NVIDIA", "401k overlap checker", "do I own NVIDIA through my LIRA"

---

## Business Model

**Consumer (freemium):**
- Free tier: ETF look-through only, up to 3 funds, top 10 holdings
- Pro ($9/month or $79/year): Canadian mutual fund look-through, unlimited funds, Claude AI analysis, CSV export, saved portfolios

**Advisor (Phase 2):**
- Advisor Basic ($99/month): directory listing shown to opted-in leads
- Advisor Pro ($199/month): white-label embed for their website + leads

**Revenue goal:** $500 MRR by week 12 post-launch (~55 Pro users)

---

## Tech Stack

```
Frontend/Backend:  Next.js (App Router) on Vercel
Database:          Supabase (schema already created — see supabase-schema.sql)
Auth:              Supabase Auth (or Clerk if needed)
Payments:          Stripe
AI:                Anthropic Claude API (claude-sonnet-4-20250514)
Canadian data:     Proprietary scrapers (see scraper files)
US ETF data:       Financial Modeling Prep API (free tier)
Styling:           Tailwind CSS + Shadcn/ui
```

**Vercel config notes:**
- Free tier works for development and early production
- Serverless function timeout: 10s (free) / 60s (Pro $20/month)
- Fidelity HTML scraper may need longer timeout — move to cron job pattern

**Supabase config notes:**
- Schema is in `supabase-schema.sql` — run this in SQL editor first
- Row Level Security enabled on all user tables
- `is_pro_user(user_id)` function available for gating
- Fund holdings cached in `fund_holdings` table, refreshed by cron

---

## Working Scraper Files

### `slgi-v8.js` — Sun Life Global Investments
- **Method:** GraphQL POST to `funds.sunlifeglobalinvestments.com/api/graphql/mutual-funds-production`
- **Auth:** None required (public API)
- **Entity ID format:** `[CODE]-CAD` (e.g. `SIVFF-CAD`)
- **Holdings path:** `webProfiles[0].webProfileSalesOptions[0].salesOption.fund.portfolios[last].top10Holdings`
- **Weight field:** `allocation` (decimal fraction — 0.039 = 3.9%)
- **Confirmed codes:** SLMCF, SMIPF, SMEIA, SLMGF, SIVFF, SLVGF, SLVIF, SMGF, SMVF
- **Status:** ✅ 5/5 LIRA funds working, confirmed March 2026 data

### `fidelity-scraper-v2.js` — Fidelity Canada
- **Method:** HTTP GET + Cheerio HTML parsing
- **URL pattern:** `fidelity.ca/en/products/funds/[slug]/?series=F`
- **Type A (stock funds gc, uet):** `ol.pdf-holdings-reg li` selector — names only, aggregate weight
- **Type B (fund-of-funds aee, mmf):** `div[id^="target-allocation-"] table tbody tr` — exact weights
- **Confirmed slugs:** gc (FID1646), uet (FID5982), aee (FID7567), mmf (FID7648)
- **Status:** ✅ 4/4 funds working

### `canadian-fund-registry.json` — Asset Type Detection
- Flat `aliasIndex` for O(1) lookup of any user-entered code
- Maps ETFInsight codes → canonical codes → scraper
- Canadian ETF list with US equivalents for FMP routing
- Unknown holdings logger for roadmap prioritisation

---

## Fund Detection Logic

When a user enters a holding, detect type in this order:

```javascript
1. Check aliasIndex in canadian-fund-registry.json → canadian_mutual_fund
2. Check Canadian ETF list (TSX-listed) → canadian_etf
3. Try FMP API → us_etf (if returns holdings data)
4. Check if looks like a stock ticker → stock (no look-through needed)
5. Fuzzy name match against fund registry → canadian_mutual_fund
6. Unknown → log to unknown_holdings table, ask user to clarify
```

**Key insight:** Individual stocks (NVDA, AAPL, RY) need NO look-through — they ARE the holding. Only funds require look-through.

---

## Data Architecture (Production Pattern)

```
Cron job (nightly via Vercel cron)
  → Runs all scrapers
  → Writes to fund_holdings table in Supabase
  → Marks old records is_current = false

User request
  → API route reads from fund_holdings cache (fast, <100ms)
  → Calculates exposure across portfolio
  → Calls Claude API for natural language analysis
  → Returns results to frontend
```

**MVP shortcut:** Call scrapers live during user requests. Switch to cron/cache pattern after launch when >10 active users.

---

## Claude API Integration

**Endpoint:** `https://api.anthropic.com/v1/messages`
**Model:** `claude-sonnet-4-20250514`
**Pattern:** Pass pre-calculated exposure data as context, ask natural language questions

**System prompt (use this):**
```
You are a portfolio transparency assistant helping Canadian investors understand 
what they actually own across their mutual funds and ETFs, including LIRA, RRSP, 
and TFSA accounts. You receive pre-calculated exposure data. Answer questions 
directly using the specific numbers provided. Never give financial advice or 
recommend specific trades. If a fund's data is marked as partial or estimated, 
acknowledge that limitation. Keep responses under 150 words unless a detailed 
breakdown is requested.
```

**Cost:** ~$0.003/query at typical portfolio size. 20 queries/day per Pro user = ~$1.80/month API cost vs $9 MRR. Comfortable margin.

**Rate limiting:** Check `daily_query_counts` view in Supabase before each Claude call.

---

## Freemium Gate Implementation

```javascript
// In your API route:
const isPro = await isProUser(userId); // calls Supabase is_pro_user() function

if (!isPro) {
  // Free tier limits:
  // - ETFs only (no canadian_mutual_fund type)
  // - Max 3 funds
  // - Top 10 holdings only
  // - No Claude analysis
  if (position.asset_type === 'canadian_mutual_fund') {
    return { gated: true, message: 'Mutual fund look-through requires Pro' };
  }
}
```

**The upgrade moment:** Free user enters a Canadian mutual fund code → hits the gate → clear value prop for upgrading.

---

## Landing Page (in Lovable)

**Current state:** Good first pass. Key elements working:
- Animated hero: "Do I actually own [NVIDIA/Bitcoin/Tesla]?" 
- Import flow: upload PDF/screenshot/CSV or paste plain English
- "The portfolio behind your portfolio" section
- Three features: Look-through, Overlap & concentration, Sector & geography
- Sample portfolio visualization (bar chart of top 10 holdings)

**Needs updating:**
- Sample portfolio uses US ETFs (VOO, QQQ) — should show Canadian funds (FID1646, SIVFF)
- No Canadian-specific copy — add "Including LIRAs, group RRSPs, and Canadian mutual funds"
- Import example should be Canadian: change "60% VOO, 30% QQQ" to Canadian fund codes

**Keep as marketing site.** Build actual product (portfolio entry, analysis, dashboard) in Next.js.

---

## Key Product Decisions Made

1. **Canadian-first positioning** — not competing on ETF overlap (ETFInsight's territory), competing on Canadian mutual fund look-through (unoccupied)

2. **No brokerage connection required** — users enter holdings manually. Removes Plaid dependency and the group plan problem entirely.

3. **"Do I own X?" as hero use case** — not a dashboard, not an overlap chart. One question, one answer.

4. **Mutual fund gate = freemium upgrade reason** — clearest possible gate: ETFs free, mutual funds Pro. No explanation needed.

5. **Advisor directory = Phase 2** — schema is ready, don't build it until you have consumer traction.

6. **FundTrace as working name** — not final. Domain availability check needed.

---

## Immediate Next Steps (Week 1)

1. **Scaffold Next.js project:**
   ```bash
   npx create-next-app -e with-supabase fundtrace
   cd fundtrace
   ```

2. **Run Supabase schema:** Paste `supabase-schema.sql` into Supabase SQL editor

3. **Copy scraper files into project:**
   - `lib/scrapers/slgi-v8.js`
   - `lib/scrapers/fidelity-scraper-v2.js`
   - `lib/fund-registry.json` (from `canadian-fund-registry.json`)

4. **Build first API route:** `app/api/analyze/route.js`
   - Accepts: `{ holdings: [{code, value}], query: string }`
   - Detects asset types
   - Fetches holdings from cache or scrapers
   - Calls Claude with exposure data
   - Returns: structured exposure + natural language answer

5. **Build first UI component:** The "Do I own X?" search flow
   - Fund entry (ticker/name + dollar value)
   - Stock query input
   - Results display (yes/no + breakdown)

---

## Files in This Project

```
slgi-v8.js                   ← Sun Life scraper (confirmed working)
fidelity-scraper-v2.js       ← Fidelity scraper (confirmed working)
canadian-fund-registry.json  ← Fund detection registry
supabase-schema.sql          ← Database schema (run this first)
CONTEXT.md                   ← This file
```

---

## What NOT to Build Yet

- Broker sync / Plaid integration
- Canadian fund support beyond SLGI and Fidelity (Manulife etc. is next sprint)
- Advisor directory (Phase 2)
- Rebalancing tools
- Mobile app
- Mutual fund comparison pages (post-launch SEO)
- 401k / US mutual fund import

---

## Contact / Accounts Needed

- [ ] Supabase project created
- [ ] Vercel account connected to GitHub repo  
- [ ] Stripe account created
- [ ] Anthropic API key
- [ ] FMP API key (free tier)
- [ ] Domain registered (.ca preferred)

---

*This document is the source of truth for project context. Update it when major decisions change.*
