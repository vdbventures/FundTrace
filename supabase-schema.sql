-- ─────────────────────────────────────────────────────────────────────────────
-- FundTrace / HoldingsLens — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this in your Supabase SQL editor to set up the full schema.
-- Includes: fund holdings cache, portfolios, users, query logs, unknown holdings
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FUND FAMILIES
--    Reference table — one row per fund family (SLGI, Fidelity, Manulife etc.)
-- ─────────────────────────────────────────────────────────────────────────────
create table fund_families (
  id           text primary key,              -- e.g. 'SLGI', 'FIDELITY', 'MANULIFE'
  name         text not null,                 -- e.g. 'Sun Life Global Investments'
  website      text,
  data_source  text not null,                 -- 'slgi_graphql' | 'fidelity_html' | 'fmp' etc.
  scraper_file text,                          -- filename of the scraper
  status       text default 'active',         -- 'active' | 'broken' | 'pending'
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

insert into fund_families (id, name, website, data_source, scraper_file, status) values
  ('SLGI',     'Sun Life Global Investments',   'sunlifeglobalinvestments.com', 'slgi_graphql',   'slgi-v8.js',               'active'),
  ('FIDELITY', 'Fidelity Investments Canada',   'fidelity.ca',                  'fidelity_html',  'fidelity-scraper-v2.js',   'active'),
  ('FMP',      'Financial Modeling Prep',       'financialmodelingprep.com',    'fmp_api',        null,                       'active'),
  ('MANULIFE', 'Manulife Investment Management','funds.manulife.ca',            'pending',        null,                       'pending'),
  ('CANADA_LIFE', 'Canada Life',               'canadalife.com',               'pending',        null,                       'pending'),
  ('RBC_GAM',  'RBC Global Asset Management',  'rbcgam.com',                   'pending',        null,                       'pending'),
  ('TD_AM',    'TD Asset Management',          'tdassetmanagement.com',        'pending',        null,                       'pending');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FUND REGISTRY
--    One row per fund. The canonical reference — maps all aliases to one record.
-- ─────────────────────────────────────────────────────────────────────────────
create table funds (
  id                  uuid primary key default uuid_generate_v4(),
  canonical_code      text not null unique,   -- the code your scraper uses
  family_id           text not null references fund_families(id),
  name                text not null,
  aliases             text[],                 -- ['FID1646', 'gc', 'Fidelity Greater Canada']
  url_slug            text,                   -- for HTML scrapers: 'gc'
  series              text,                   -- 'F', 'A', 'CAD'
  fund_type           text not null,          -- 'equity_fund' | 'fund_of_funds' | 'etf'
  asset_class         text,                   -- 'canadian_equity' | 'global_equity' | 'balanced'
  risk_level          text,                   -- 'low' | 'low_to_medium' | 'medium' | 'high'
  holdings_type       text,                   -- 'individual_stocks' | 'underlying_funds' | 'underlying_etfs'
  is_active           boolean default true,
  etfinsight_code     text,                   -- cross-reference to ETFInsight codes
  notes               text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Indexes for fast alias lookup
create index idx_funds_canonical_code on funds(canonical_code);
create index idx_funds_aliases on funds using gin(aliases);
create index idx_funds_family on funds(family_id);

-- Seed with confirmed working funds
insert into funds (canonical_code, family_id, name, aliases, url_slug, series, fund_type, asset_class, risk_level, holdings_type, etfinsight_code, notes) values

-- ── SLGI funds ────────────────────────────────────────────────────────────
('SLMCF', 'SLGI', 'Sun Life Granite Conservative Portfolio',
  array['FCGC', 'Granite Conservative', 'Sun Life Granite Conservative'],
  null, 'CAD', 'fund_of_funds', 'balanced', 'low_to_medium', 'underlying_funds', 'FCGC', null),

('SMIPF', 'SLGI', 'Sun Life Granite Income Portfolio',
  array['FINN', 'Granite Income', 'Sun Life Granite Income'],
  null, 'CAD', 'fund_of_funds', 'balanced_income', 'low_to_medium', 'underlying_funds', 'FINN', null),

('SMEIA', 'SLGI', 'Sun Life Granite Enhanced Income Portfolio',
  array['FEQT', 'Granite Enhanced Income', 'Sun Life Granite Enhanced'],
  null, 'CAD', 'fund_of_funds', 'balanced', 'medium', 'underlying_funds', 'FEQT', 'Verify FEQT vs SMEIA mapping'),

('SLMGF', 'SLGI', 'Sun Life Granite Growth Portfolio',
  array['FGEP', 'Granite Growth', 'Sun Life Granite Growth'],
  null, 'CAD', 'fund_of_funds', 'equity', 'medium', 'underlying_funds', 'FGEP', null),

('SIVFF', 'SLGI', 'Sun Life MFS International Value Fund',
  array['SUN404', 'Sun Life MFS International', 'MFS International Value'],
  null, 'CAD', 'equity_fund', 'international_equity', 'medium', 'individual_stocks', 'SUN404',
  'International value fund. Does not hold US tech. Top holdings: Franco-Nevada, TotalEnergies, TSMC'),

('SLVGF', 'SLGI', 'SLGI MFS Blended Research Low Volatility Global Fund',
  array['SLGI MFS Low Vol Global'],
  null, 'CAD', 'equity_fund', 'global_equity', 'medium', 'individual_stocks', null, null),

('SLVIF', 'SLGI', 'SLGI MFS Blended Research Low Volatility International Fund',
  array['SLGI MFS Low Vol International'],
  null, 'CAD', 'equity_fund', 'international_equity', 'medium', 'individual_stocks', null, null),

('SMGF', 'SLGI', 'Sun Life MFS Global Growth Fund',
  array['MFS Global Growth', 'Sun Life MFS Global Growth'],
  null, 'CAD', 'equity_fund', 'global_equity', 'medium_high', 'individual_stocks', null, null),

('SMVF', 'SLGI', 'Sun Life MFS Global Value Fund',
  array['MFS Global Value', 'Sun Life MFS Global Value'],
  null, 'CAD', 'equity_fund', 'global_equity', 'medium', 'individual_stocks', null, null),

-- ── Fidelity funds ────────────────────────────────────────────────────────
('gc', 'FIDELITY', 'Fidelity Greater Canada Fund Series F',
  array['FID1646', 'Fidelity Greater Canada', 'Greater Canada Fund'],
  'gc', 'F', 'equity_fund', 'canadian_equity', 'medium_high', 'individual_stocks', 'FID1646',
  'Top-10 names confirmed. Holds Shopify, Franco-Nevada, Canadian Pacific, Agnico Eagle'),

('uet', 'FIDELITY', 'Fidelity Global Innovators Class Series F',
  array['FID5982', 'Fidelity Global Innovators', 'Global Innovators'],
  'uet', 'F', 'equity_fund', 'global_equity_technology', 'high', 'individual_stocks', 'FID5982',
  'Tech-heavy. Confirmed holds NVIDIA, Apple, Microsoft in top-10'),

('aee', 'FIDELITY', 'Fidelity All-in-One Equity ETF Fund Series F',
  array['FID7567', 'Fidelity All-in-One', 'All-in-One Equity ETF', 'Fidelity All in One'],
  'aee', 'F', 'fund_of_funds', 'global_equity', 'medium_high', 'underlying_etfs', 'FID7567',
  'Holds Fidelity factor ETFs. Includes Bitcoin ETF 2.7%. US Equities 48.4%'),

('mmf', 'FIDELITY', 'Fidelity Global Equity+ Fund Series F',
  array['FID7648', 'Fidelity Global Equity Plus', 'Global Equity+', 'Fidelity Global Equity+'],
  'mmf', 'F', 'fund_of_funds', 'global_equity', 'medium_high', 'underlying_funds', 'FID7648',
  'Holds Fidelity Greater Canada O 33.3%, Global Innovators Trust 32.9%');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FUND HOLDINGS CACHE
--    Stores scraped holdings. Refreshed by cron job.
--    One row per holding per fund per scrape date.
-- ─────────────────────────────────────────────────────────────────────────────
create table fund_holdings (
  id              uuid primary key default uuid_generate_v4(),
  fund_id         uuid not null references funds(id) on delete cascade,
  canonical_code  text not null,              -- denormalised for fast queries
  as_of_date      date not null,              -- date the holdings are as-of
  scraped_at      timestamptz not null,       -- when we fetched the data
  rank            integer,                    -- 1 = largest holding
  holding_name    text not null,              -- 'Franco-Nevada Corp'
  holding_ticker  text,                       -- 'FNV' if we can resolve it
  weight          numeric(6,3),               -- 3.900 = 3.9%
  weight_source   text not null,              -- 'actual' | 'estimated' | 'top10_aggregate'
  holding_type    text,                       -- 'stock' | 'etf' | 'fund' | 'bond'
  sector          text,
  country         text,
  market_value    numeric(20,2),
  data_quality    text,                       -- 'top10_actual' | 'top10_names_only' | 'full_allocation'
  is_current      boolean default true,       -- false when superseded by newer scrape
  created_at      timestamptz default now()
);

-- Indexes for common queries
create index idx_holdings_fund_current    on fund_holdings(canonical_code, is_current, as_of_date desc);
create index idx_holdings_name_search     on fund_holdings using gin(to_tsvector('english', holding_name));
create index idx_holdings_ticker          on fund_holdings(holding_ticker) where holding_ticker is not null;

-- View: latest holdings only (most recent per fund)
create view current_holdings as
  select fh.*, f.name as fund_name, f.family_id, f.fund_type, f.asset_class
  from fund_holdings fh
  join funds f on f.canonical_code = fh.canonical_code
  where fh.is_current = true;

-- Function to mark old holdings as not current when new scrape arrives
create or replace function mark_old_holdings_stale()
returns trigger as $$
begin
  update fund_holdings
  set is_current = false
  where canonical_code = new.canonical_code
    and id != new.id
    and is_current = true;
  return new;
end;
$$ language plpgsql;

create trigger holdings_stale_trigger
  after insert on fund_holdings
  for each row execute function mark_old_holdings_stale();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SCRAPE LOG
--    Records every scrape run — success, failure, duration.
--    Useful for debugging and monitoring data freshness.
-- ─────────────────────────────────────────────────────────────────────────────
create table scrape_log (
  id              uuid primary key default uuid_generate_v4(),
  canonical_code  text not null,
  family_id       text not null,
  status          text not null,              -- 'success' | 'failed' | 'partial'
  holdings_count  integer,
  as_of_date      date,
  duration_ms     integer,
  error_message   text,
  scraped_at      timestamptz default now()
);

create index idx_scrape_log_code on scrape_log(canonical_code, scraped_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. USER PORTFOLIOS
--    Stores saved portfolios for Pro users.
--    Anonymous sessions get a session_id instead of user_id.
-- ─────────────────────────────────────────────────────────────────────────────
create table portfolios (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id) on delete cascade,  -- null for anonymous
  session_id    text,                         -- for anonymous/free users
  name          text default 'My Portfolio',
  currency      text default 'CAD',
  is_default    boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  constraint portfolio_owner check (
    user_id is not null or session_id is not null
  )
);

create index idx_portfolios_user    on portfolios(user_id) where user_id is not null;
create index idx_portfolios_session on portfolios(session_id) where session_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. PORTFOLIO POSITIONS
--    Individual holdings within a portfolio.
--    Supports mutual funds, ETFs, and individual stocks.
-- ─────────────────────────────────────────────────────────────────────────────
create table portfolio_positions (
  id              uuid primary key default uuid_generate_v4(),
  portfolio_id    uuid not null references portfolios(id) on delete cascade,
  -- What the user entered
  raw_input       text not null,              -- exactly what user typed: 'FID1646', 'VFV', 'NVDA'
  -- Resolved asset
  asset_type      text not null,              -- 'canadian_mutual_fund' | 'canadian_etf' | 'us_etf' | 'canadian_stock' | 'us_stock' | 'unknown'
  canonical_code  text,                       -- resolved code (null if unknown)
  display_name    text,                       -- friendly name for UI
  family_id       text references fund_families(id),
  exchange        text,                       -- 'TSX' | 'NYSE' | 'NASDAQ' | null
  -- Position size
  value_cad       numeric(15,2),              -- dollar value in CAD
  shares          numeric(15,4),              -- optional share count
  -- Detection metadata
  detection_confidence text,                  -- 'high' | 'medium' | 'manual'
  user_confirmed  boolean default false,      -- did user confirm the detection?
  -- Timestamps
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index idx_positions_portfolio on portfolio_positions(portfolio_id);
create index idx_positions_asset     on portfolio_positions(canonical_code) where canonical_code is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. QUERY LOG
--    Records every "do I own X?" query.
--    Used for: rate limiting, analytics, improving Claude prompts.
-- ─────────────────────────────────────────────────────────────────────────────
create table query_log (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id),
  session_id    text,
  portfolio_id  uuid references portfolios(id),
  query_text    text not null,                -- 'NVIDIA'
  query_type    text,                         -- 'stock_search' | 'portfolio_brief' | 'overlap' | 'chat'
  result_found  boolean,
  funds_checked integer,
  response_ms   integer,
  model         text,                         -- 'claude-sonnet-4-20250514'
  tokens_used   integer,
  is_pro_query  boolean default false,
  created_at    timestamptz default now()
);

create index idx_query_log_user    on query_log(user_id, created_at desc) where user_id is not null;
create index idx_query_log_session on query_log(session_id, created_at desc) where session_id is not null;

-- Rate limiting view: queries per user in last 24 hours
create view daily_query_counts as
  select
    coalesce(user_id::text, session_id) as identifier,
    count(*) as query_count,
    max(created_at) as last_query_at
  from query_log
  where created_at > now() - interval '24 hours'
    and is_pro_query = true
  group by coalesce(user_id::text, session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. UNKNOWN HOLDINGS LOG
--    When a user enters a code we don't recognise, log it.
--    Review weekly — top entries become next development sprint.
-- ─────────────────────────────────────────────────────────────────────────────
create table unknown_holdings (
  id            uuid primary key default uuid_generate_v4(),
  raw_input     text not null,
  times_entered integer default 1,
  first_seen    timestamptz default now(),
  last_seen     timestamptz default now(),
  resolved      boolean default false,
  resolved_as   text,                         -- canonical code once identified
  notes         text
);

create unique index idx_unknown_holdings_input on unknown_holdings(lower(raw_input));

-- Function to upsert unknown holdings (increment count if exists)
create or replace function log_unknown_holding(p_raw_input text)
returns void as $$
begin
  insert into unknown_holdings (raw_input, times_entered, first_seen, last_seen)
  values (p_raw_input, 1, now(), now())
  on conflict (lower(raw_input))
  do update set
    times_entered = unknown_holdings.times_entered + 1,
    last_seen = now();
end;
$$ language plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. USER SUBSCRIPTION STATUS
--    Tracks free vs Pro. Stripe webhook updates this table.
-- ─────────────────────────────────────────────────────────────────────────────
create table user_subscriptions (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null unique references auth.users(id) on delete cascade,
  plan                text default 'free',    -- 'free' | 'pro' | 'advisor'
  stripe_customer_id  text unique,
  stripe_subscription_id text unique,
  current_period_end  timestamptz,
  cancel_at_period_end boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index idx_subscriptions_user   on user_subscriptions(user_id);
create index idx_subscriptions_stripe on user_subscriptions(stripe_customer_id);

-- Helper function: is this user on Pro?
create or replace function is_pro_user(p_user_id uuid)
returns boolean as $$
  select exists (
    select 1 from user_subscriptions
    where user_id = p_user_id
      and plan in ('pro', 'advisor')
      and (current_period_end is null or current_period_end > now())
  );
$$ language sql stable;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. ADVISOR DIRECTORY (future — Phase 2)
--     Listed advisors shown to users who opt in for advice
-- ─────────────────────────────────────────────────────────────────────────────
create table advisors (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references auth.users(id),
  firm_name       text,
  advisor_name    text not null,
  email           text not null unique,
  phone           text,
  city            text,
  province        text,                       -- 'BC' | 'ON' | 'AB' etc.
  website         text,
  specialties     text[],                     -- ['LIRA', 'RRSP', 'retirement']
  accepts_leads   boolean default true,
  plan            text default 'basic',       -- 'basic' | 'featured'
  stripe_subscription_id text,
  is_active       boolean default true,
  created_at      timestamptz default now()
);

create index idx_advisors_province on advisors(province) where is_active = true;
create index idx_advisors_city     on advisors(city) where is_active = true;

-- Lead opt-ins from the main consumer tool
create table lead_optins (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id),
  session_id    text,
  province      text,
  city          text,
  portfolio_summary jsonb,                    -- sanitised summary, not full portfolio
  opted_in_at   timestamptz default now(),
  contacted_at  timestamptz,
  advisor_id    uuid references advisors(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
--    Users can only see their own data.
-- ─────────────────────────────────────────────────────────────────────────────
alter table portfolios          enable row level security;
alter table portfolio_positions enable row level security;
alter table query_log           enable row level security;
alter table user_subscriptions  enable row level security;

-- Portfolios: users see their own
create policy "users see own portfolios"
  on portfolios for all
  using (auth.uid() = user_id);

-- Anonymous portfolios: accessible by session (handled in app layer)
create policy "anon portfolios by session"
  on portfolios for select
  using (user_id is null);

-- Positions: via portfolio ownership
create policy "users see own positions"
  on portfolio_positions for all
  using (
    portfolio_id in (
      select id from portfolios where user_id = auth.uid()
    )
  );

-- Query log: users see own queries
create policy "users see own queries"
  on query_log for all
  using (auth.uid() = user_id);

-- Subscriptions: users see own subscription
create policy "users see own subscription"
  on user_subscriptions for all
  using (auth.uid() = user_id);

-- Fund data is public (read-only for everyone)
alter table funds          enable row level security;
alter table fund_holdings  enable row level security;
alter table fund_families  enable row level security;

create policy "fund data is public read"
  on funds for select using (true);

create policy "holdings data is public read"
  on fund_holdings for select using (true);

create policy "families data is public read"
  on fund_families for select using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- USEFUL QUERIES (reference — not executed)
-- ─────────────────────────────────────────────────────────────────────────────

-- Get current holdings for a fund:
-- select * from current_holdings where canonical_code = 'SIVFF' order by rank;

-- Find which funds hold a stock (do I own NVIDIA?):
-- select ch.canonical_code, ch.fund_name, ch.holding_name, ch.weight
-- from current_holdings ch
-- where to_tsvector('english', ch.holding_name) @@ plainto_tsquery('nvidia')
-- order by ch.weight desc;

-- Check if user is Pro:
-- select is_pro_user('user-uuid-here');

-- Top unknown holdings this week:
-- select raw_input, times_entered from unknown_holdings
-- where resolved = false order by times_entered desc limit 20;

-- Daily query count for rate limiting:
-- select query_count from daily_query_counts where identifier = 'user-uuid';

