-- FundTrace — snapshot & alert data model
-- Granularity: one snapshot per fund per reporting period (quarterly)
-- Alert signal: change in fund-reported WEIGHT (allocation %), not dollar value
-- Postgres / Supabase

-- ─────────────────────────────────────────────────────────────
-- 1. FUNDS  — the catalog (you already have a version of this)
-- ─────────────────────────────────────────────────────────────
create table funds (
  id              uuid primary key default gen_random_uuid(),
  family          text not null,              -- 'sunlife' | 'fidelity' | 'canadalife' ...
  source_code     text not null,              -- the code your scraper keys on (e.g. SIVFF-CAD)
  display_name    text not null,
  fund_type       text not null,              -- 'mutual_fund' | 'canadian_etf' | 'fund_of_funds'
  is_lookthrough_supported boolean default true,
  created_at      timestamptz default now(),
  unique (family, source_code)
);

-- ─────────────────────────────────────────────────────────────
-- 2. FUND_SNAPSHOTS  — immutable record of "what this fund held
--    in this reporting period". One row per fund per period.
-- ─────────────────────────────────────────────────────────────
create table fund_snapshots (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references funds(id),
  period          date not null,              -- normalize to first day of reporting quarter: 2026-03-01
  scraped_at      timestamptz default now(),  -- when YOU pulled it (audit, not the period)
  holding_count   int,                        -- denormalized for quick display
  source_url      text,
  unique (fund_id, period)                     -- guarantees one snapshot per fund per quarter
);

-- ─────────────────────────────────────────────────────────────
-- 3. SNAPSHOT_HOLDINGS  — the line items inside one snapshot.
--    WEIGHT is the source of truth. Never store dollars here.
-- ─────────────────────────────────────────────────────────────
create table snapshot_holdings (
  id              uuid primary key default gen_random_uuid(),
  snapshot_id     uuid not null references fund_snapshots(id) on delete cascade,
  security_id     uuid not null references securities(id),
  weight          numeric(7,4) not null,      -- 0.0380 = 3.80% of the fund. 4dp = 0.01% resolution
  rank            int,                         -- position in the holdings list, optional
  unique (snapshot_id, security_id)
);
create index on snapshot_holdings (snapshot_id);
create index on snapshot_holdings (security_id);

-- ─────────────────────────────────────────────────────────────
-- 4. SECURITIES  — canonical stock/asset identity. This is what
--    lets "Franco-Nevada" from two funds merge into one thing.
-- ─────────────────────────────────────────────────────────────
create table securities (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,              -- 'Franco-Nevada Corp'
  ticker          text,                        -- nullable; many fund holdings have no clean ticker
  asset_class     text,                        -- 'equity' | 'crypto_etf' | 'bond' | 'cash' ...
  country         text,
  created_at      timestamptz default now()
);
-- alias table so messy scraped names resolve to one security
create table security_aliases (
  alias           text primary key,           -- lowercased, suffix-stripped scraped name
  security_id     uuid not null references securities(id)
);

-- ─────────────────────────────────────────────────────────────
-- 5. SNAPSHOT_DIFFS  — the heart of alerts. One row per security
--    whose weight changed between two consecutive snapshots of
--    the SAME fund. Computed by a job after each new snapshot.
-- ─────────────────────────────────────────────────────────────
create table snapshot_diffs (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references funds(id),
  from_period     date not null,
  to_period       date not null,
  security_id     uuid not null references securities(id),
  change_type     text not null,              -- 'added' | 'removed' | 'increased' | 'decreased'
  weight_before   numeric(7,4),               -- null when 'added'
  weight_after    numeric(7,4),               -- null when 'removed'
  weight_delta    numeric(7,4) not null,      -- after - before (signed)
  created_at      timestamptz default now(),
  unique (fund_id, from_period, to_period, security_id)
);
create index on snapshot_diffs (fund_id, to_period);
create index on snapshot_diffs (security_id);

-- ─────────────────────────────────────────────────────────────
-- 6. USER side — portfolios and the funds a user holds.
--    Dollar value lives HERE and only here.
-- ─────────────────────────────────────────────────────────────
create table portfolios (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  name            text default 'My portfolio',
  created_at      timestamptz default now()
);

create table portfolio_positions (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid not null references portfolios(id) on delete cascade,
  fund_id         uuid references funds(id),  -- null if it's a direct stock holding
  security_id     uuid references securities(id), -- set if direct stock, else null
  value           numeric(14,2) not null,     -- the user's dollars in this position
  updated_at      timestamptz default now()
);
create index on portfolio_positions (portfolio_id);
create index on portfolio_positions (fund_id);

-- ─────────────────────────────────────────────────────────────
-- 7. ALERT_PREFS + ALERT_EVENTS — what each user wants to hear
--    about, and what actually fired.
-- ─────────────────────────────────────────────────────────────
create table alert_prefs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  -- minimum change in a user's effective weight to bother them. 0.5% = 0.0050
  min_weight_delta numeric(6,4) default 0.0050,
  notify_added    boolean default true,       -- a fund I own started holding a new stock
  notify_removed  boolean default true,
  notify_drift    boolean default true,       -- existing holding's weight moved
  unique (user_id)
);

-- optional: watchlist for stocks the user does NOT own but wants flagged if a fund adds them
create table alert_watchlist (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  security_id     uuid not null references securities(id),
  unique (user_id, security_id)
);

create table alert_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  portfolio_id    uuid not null references portfolios(id),
  security_id     uuid not null references securities(id),
  fund_id         uuid not null references funds(id),
  to_period       date not null,
  change_type     text not null,
  -- the user's EFFECTIVE weight change = fund weight delta scaled by how much
  -- of the user's portfolio sits in that fund. This is what we threshold on.
  effective_weight_delta numeric(7,4) not null,
  -- dollar figure is computed at send-time for display, stored for the record only
  est_value_after numeric(14,2),
  status          text default 'pending',     -- 'pending' | 'sent' | 'dismissed'
  created_at      timestamptz default now()
);
create index on alert_events (user_id, status);
