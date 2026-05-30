# FundTrace — Chat Handoff Summary
> Paste this at the start of a new chat to restore full context

---

## What Was Built Today (2026-05-27)

I'm building **FundTrace** — a Canadian mutual fund transparency tool that answers "Do I actually own [stock]?" by looking through mutual funds and ETFs to reveal underlying stock exposure with dollar amounts.

**Founding story:** I couldn't find out whether my Sun Life LIRA held NVIDIA. ETFInsight failed to resolve the fund. FundTrace solves this.

---

## Working Data Pipelines

### 1. Sun Life Global Investments (SLGI) — GraphQL API
- **File:** `slgi-v8.js`
- **Endpoint:** `POST https://funds.sunlifeglobalinvestments.com/api/graphql/mutual-funds-production`
- **Auth:** None required (public API)
- **Entity ID format:** `[CODE]-CAD` (e.g. `SIVFF-CAD`)
- **Holdings path:** `webProfiles[0].webProfileSalesOptions[0].salesOption.fund.portfolios[last].top10Holdings`
- **Fields:** `{ holding: String, allocation: Decimal }` — allocation is decimal fraction (0.039 = 3.9%)
- **Status:** ✅ Confirmed working, March 2026 data

**Confirmed fund codes (ETFInsight code → SLGI API code):**
- FCGC → SLMCF (Sun Life Granite Conservative Portfolio)
- FINN → SMIPF (Sun Life Granite Income Portfolio)
- FEQT → SMEIA (Sun Life Granite Enhanced Income Portfolio)
- FGEP → SLMGF (Sun Life Granite Growth Portfolio)
- SIVFF → SIVFF (Sun Life MFS International Value Fund) — also known as SUN404

### 2. Fidelity Canada — HTML Scraper
- **File:** `fidelity-scraper-v2.js`
- **URL pattern:** `fidelity.ca/en/products/funds/[slug]/?series=F`
- **Type A stock funds (gc, uet):** `ol.pdf-holdings-reg li` — names only, aggregate weight
- **Type B fund-of-funds (aee, mmf):** `div[id^="target-allocation-"] table tbody tr` — exact weights
- **Status:** ✅ 4/4 funds working

**Fund code mapping (ETFInsight → Fidelity slug):**
- FID1646 → gc (Fidelity Greater Canada Fund Series F)
- FID5982 → uet (Fidelity Global Innovators Class Series F)
- FID7567 → aee (Fidelity All-in-One Equity ETF Fund) — fund of funds, holds Bitcoin ETF 2.7%
- FID7648 → mmf (Fidelity Global Equity+ Fund Series F) — fund of funds

### 3. Canada Life / FundData — HTML Scraper
- **File:** `canadalife-scraper-v1.js`
- **URL pattern:** `canadalifemutualfunds.fundata.com/Fund/Snapshot/[instrumentId]`
- **Selector:** `table.table-fund-details tbody tr`
- **Columns:** `td:first-child` = name, `td.text-end` = weight (%)
- **Auth:** None required
- **Status:** ✅ Working, 566 funds mapped
- **Registry files:** `canadalife-registry.json`, `canadalife-id-lookup.json`
- **Note:** Filter out statistics rows: Standard deviation, Duration, Coupon, Yield to maturity, Dividend yield

### 4. Manulife — BLOCKED
- Uses authenticated GraphQL at `mim-ca.maestro.maark.digital/fund/graphql`
- Bearer token generated client-side, not extractable without Puppeteer
- **Decision:** Post-launch, use Puppeteer headless browser
- Holdings data confirmed available (topTenHoldings.returns[].label.en + pct)

---

## Next.js App Status

**Location:** `C:\Users\jonvd\FundTrace`
**Running:** `npm run dev` → `localhost:3000`

**Files built:**
- `lib/scrapers/slgi.ts` — SLGI GraphQL scraper
- `lib/scrapers/fidelity.ts` — Fidelity HTML scraper
- `lib/scrapers/fmp.ts` — FMP stub (disabled, legacy endpoint issue)
- `lib/fund-registry.json` — fund detection registry
- `app/api/analyze/route.ts` — POST endpoint, working and tested

**API route confirmed working:**
```
POST /api/analyze
Body: { holdings: [{ code, value }] }
Returns: { portfolioTotal, positions, exposure, unresolved }
```

**Test command:**
```powershell
$body = '{"holdings":[{"code":"SIVFF","value":30988},{"code":"FID1646","value":54248},{"code":"VFV","value":20000},{"code":"NVDA","value":5000}]}'
Invoke-RestMethod -Uri "http://localhost:3000/api/analyze" -Method POST -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10
```

**Confirmed results:**
- SIVFF → 10 holdings, exact weights, March 2026 (Franco-Nevada 3.9%, TSMC 3.19%)
- FID1646 → 19 unique holdings, estimated weights (aggregate/count)
- VFV → recognised as canadian_etf, FMP unavailable (post-launch fix)
- NVDA → stock, direct holding, no look-through needed
- Franco-Nevada correctly merged from SIVFF ($1,208) + FID1646 ($417) = $1,626 combined

**Known bugs fixed:**
- Fidelity duplicate holdings — deduplication by lowercase name after parsing
- Franco-Nevada name mismatch — normaliseName() strips Corp/Inc/Ltd suffixes before grouping
- FMP deprecated endpoint — stub returns null, position marked fmp-unavailable

---

## Asset Type Detection Logic

```
1. Check aliasIndex in canadian-fund-registry.json → canadian_mutual_fund
2. Check Canadian ETF list → canadian_etf (VFV maps to VOO via usEquiv)
3. Try FMP API (currently disabled) → us_etf
4. Stock ticker pattern → stock (no look-through needed)
5. Fuzzy name match → canadian_mutual_fund
6. Unknown → log to unknown_holdings table
```

---

## Database (Supabase)

**Schema file:** `supabase-schema.sql` — run this in Supabase SQL editor
**Tables:** fund_families, funds, fund_holdings, scrape_log, portfolios, portfolio_positions, query_log, unknown_holdings, user_subscriptions, advisors, lead_optins
**RLS:** Enabled on all user tables
**Key function:** `is_pro_user(user_id)` for gating

---

## Business Model

- **Free:** ETF look-through only, max 3 funds, no saved portfolios
- **Pro ($9/month):** Canadian mutual fund look-through, unlimited funds, Claude AI analysis, saved portfolios
- **Advisor ($99-199/month):** Phase 2, directory listing + leads (schema ready, not built)

**Freemium gate:** When user enters a Canadian mutual fund code → hits gate → upgrade prompt

---

## Tech Stack

```
Frontend/Backend:  Next.js (App Router) on Vercel
Database:          Supabase
Auth:              Supabase Auth
Payments:          Stripe (not yet wired)
AI:                Anthropic Claude API (claude-sonnet-4-20250514)
Styling:           Tailwind CSS + Shadcn/ui
```

---

## Landing Page (Lovable)

- Built and live at lovable.dev
- Animated hero: "Do I actually own [NVIDIA/Bitcoin/Tesla]?"
- Import flow: upload PDF/screenshot/CSV or paste plain English
- "The portfolio behind your portfolio" section
- Sample portfolio bar chart (top 10 holdings)
- **Needs:** Swap US ETF examples for Canadian fund codes, add Canadian-specific copy

---

## Coverage Summary

```
Sun Life SLGI      ✓  ~3% market AUM, 9 funds
Fidelity Canada    ✓  ~8% market AUM, 4 funds  
Canada Life        ✓  ~3% market AUM, 566 funds mapped
Manulife           ✗  Post-launch (Puppeteer needed)
RBC/TD/BMO         ✗  Not yet investigated
```

For group plan accounts (primary target), these three providers likely represent 35-45% of currently invisible accounts.

---

## Immediate Next Steps

1. **Build frontend UI** — `app/page.tsx` with portfolio entry form, results display, exposure table
2. **Deploy to Vercel** — `vercel` in FundTrace folder
3. **Run Supabase schema** — paste `supabase-schema.sql` into SQL editor
4. **Fix Canada Life statistics filter** — remove Standard deviation/Duration/Coupon rows
5. **Integrate Canada Life registry** — load `canadalife-registry.json` instead of hardcoded FUND_REGISTRY
6. **Wire Stripe** — freemium gate for mutual fund look-through

---

## Files Produced Today

- `slgi-v8.js` — Sun Life scraper
- `fidelity-scraper-v2.js` — Fidelity scraper
- `canadalife-scraper-v1.js` — Canada Life scraper
- `build-canadalife-registry.js` — builds 566-fund registry
- `canadalife-registry.json` — full Canada Life fund registry
- `canadian-fund-registry.json` — cross-family detection registry
- `supabase-schema.sql` — full database schema
- `CONTEXT.md` — Claude Code handoff document
- `check-manulife-token.js` — Manulife auth investigation tool

---

## Claude Code Opening Prompt

```
Read CONTEXT.md first. 

I'm building FundTrace — a Canadian mutual fund transparency tool.
The /api/analyze endpoint is working and tested locally.

Today's task: [INSERT TASK]
```
