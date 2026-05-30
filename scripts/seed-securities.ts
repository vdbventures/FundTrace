/**
 * scripts/seed-securities.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds the securities + security_aliases tables with the top ~30 S&P 500
 * constituents so that the EDGAR ingest can resolve holdings for those stocks.
 *
 * For each security we insert:
 *   - One row in `securities`
 *   - Aliases for: CUSIP (lowercase), ISIN (lowercase), normalised name
 *
 * This is a one-time setup; re-running is safe (upsert on conflict).
 *
 * Usage:  npx tsx scripts/seed-securities.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Top 30 S&P 500 holdings as of Q1 2026 (from VOO filing)
// CUSIP and ISIN from the VOO N-PORT-P XML
// ─────────────────────────────────────────────────────────────────────────────

interface SeedSecurity {
  canonical_name: string;
  ticker: string;
  asset_class: string;
  country: string;
  cusip: string;
  isin: string;
}

const SECURITIES: SeedSecurity[] = [
  { canonical_name: 'NVIDIA Corp',              ticker: 'NVDA',  asset_class: 'equity', country: 'US', cusip: '67066G104', isin: 'US67066G1040' },
  { canonical_name: 'Apple Inc',                ticker: 'AAPL',  asset_class: 'equity', country: 'US', cusip: '037833100', isin: 'US0378331005' },
  { canonical_name: 'Microsoft Corp',           ticker: 'MSFT',  asset_class: 'equity', country: 'US', cusip: '594918104', isin: 'US5949181045' },
  { canonical_name: 'Amazon.com Inc',           ticker: 'AMZN',  asset_class: 'equity', country: 'US', cusip: '023135106', isin: 'US0231351067' },
  { canonical_name: 'Alphabet Inc Class C',     ticker: 'GOOG',  asset_class: 'equity', country: 'US', cusip: '02079K305', isin: 'US02079K3059' },
  { canonical_name: 'Broadcom Inc',             ticker: 'AVGO',  asset_class: 'equity', country: 'US', cusip: '11135F101', isin: 'US11135F1012' },
  { canonical_name: 'Alphabet Inc Class A',     ticker: 'GOOGL', asset_class: 'equity', country: 'US', cusip: '02079K107', isin: 'US02079K1079' },
  { canonical_name: 'Meta Platforms Inc',       ticker: 'META',  asset_class: 'equity', country: 'US', cusip: '30303M102', isin: 'US30303M1027' },
  { canonical_name: 'Tesla Inc',                ticker: 'TSLA',  asset_class: 'equity', country: 'US', cusip: '88160R101', isin: 'US88160R1014' },
  { canonical_name: 'Berkshire Hathaway Inc',   ticker: 'BRK.B', asset_class: 'equity', country: 'US', cusip: '084670702', isin: 'US0846707026' },
  { canonical_name: 'JPMorgan Chase & Co',      ticker: 'JPM',   asset_class: 'equity', country: 'US', cusip: '46625H100', isin: 'US46625H1005' },
  { canonical_name: 'Eli Lilly & Co',           ticker: 'LLY',   asset_class: 'equity', country: 'US', cusip: '532457108', isin: 'US5324571083' },
  { canonical_name: 'Visa Inc',                 ticker: 'V',     asset_class: 'equity', country: 'US', cusip: '92826C839', isin: 'US92826C8394' },
  { canonical_name: 'Exxon Mobil Corp',         ticker: 'XOM',   asset_class: 'equity', country: 'US', cusip: '30231G102', isin: 'US30231G1022' },
  { canonical_name: 'UnitedHealth Group Inc',   ticker: 'UNH',   asset_class: 'equity', country: 'US', cusip: '91324P102', isin: 'US91324P1021' },
  { canonical_name: 'Mastercard Inc',           ticker: 'MA',    asset_class: 'equity', country: 'US', cusip: '57636Q104', isin: 'US57636Q1040' },
  { canonical_name: 'Costco Wholesale Corp',    ticker: 'COST',  asset_class: 'equity', country: 'US', cusip: '22160K105', isin: 'US22160K1051' },
  { canonical_name: 'Walmart Inc',              ticker: 'WMT',   asset_class: 'equity', country: 'US', cusip: '931142103', isin: 'US9311421039' },
  { canonical_name: 'Johnson & Johnson',        ticker: 'JNJ',   asset_class: 'equity', country: 'US', cusip: '478160104', isin: 'US4781601046' },
  { canonical_name: 'Procter & Gamble Co',      ticker: 'PG',    asset_class: 'equity', country: 'US', cusip: '742718109', isin: 'US7427181091' },
  { canonical_name: 'Abbott Laboratories',      ticker: 'ABT',   asset_class: 'equity', country: 'US', cusip: '002824100', isin: 'US0028241000' },
  { canonical_name: 'Oracle Corp',              ticker: 'ORCL',  asset_class: 'equity', country: 'US', cusip: '68389X105', isin: 'US68389X1054' },
  { canonical_name: 'Netflix Inc',              ticker: 'NFLX',  asset_class: 'equity', country: 'US', cusip: '64110L106', isin: 'US64110L1061' },
  { canonical_name: 'Home Depot Inc',           ticker: 'HD',    asset_class: 'equity', country: 'US', cusip: '437076102', isin: 'US4370761029' },
  { canonical_name: 'Bank of America Corp',     ticker: 'BAC',   asset_class: 'equity', country: 'US', cusip: '060505104', isin: 'US0605051046' },
  { canonical_name: 'Salesforce Inc',           ticker: 'CRM',   asset_class: 'equity', country: 'US', cusip: '79466L302', isin: 'US79466L3024' },
  { canonical_name: 'AMD',                      ticker: 'AMD',   asset_class: 'equity', country: 'US', cusip: '007903107', isin: 'US0079031078' },
  { canonical_name: 'Goldman Sachs Group Inc',  ticker: 'GS',    asset_class: 'equity', country: 'US', cusip: '38141G104', isin: 'US38141G1040' },
  { canonical_name: 'Caterpillar Inc',          ticker: 'CAT',   asset_class: 'equity', country: 'US', cusip: '149123101', isin: 'US1491231015' },
  { canonical_name: 'Palo Alto Networks Inc',   ticker: 'PANW',  asset_class: 'equity', country: 'US', cusip: '697435105', isin: 'US6974351057' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Name normalisation — must match the logic in ingest-edgar.ts
// ─────────────────────────────────────────────────────────────────────────────

const STRIP_SUFFIXES =
  /\b(Corp\.?|Inc\.?|Ltd\.?|PLC|SE|AG|SA|ADR|Class\s+[A-Z]|Shs|Ord|N\.?V\.?|S\.?A\.?)\b\.?/gi;

function normaliseName(name: string): string {
  return name
    .replace(STRIP_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  console.log('═'.repeat(60));
  console.log(' FundTrace — Seed Securities');
  console.log('═'.repeat(60));
  console.log(`Seeding ${SECURITIES.length} securities...\n`);

  let inserted = 0;
  let skipped = 0;

  for (const sec of SECURITIES) {
    // Upsert security
    const { data: secRow, error: secErr } = await supabase
      .from('securities')
      .upsert(
        {
          canonical_name: sec.canonical_name,
          ticker: sec.ticker,
          asset_class: sec.asset_class,
          country: sec.country,
        },
        { onConflict: 'id', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (secErr || !secRow) {
      // If upsert conflicts, try to find the existing row by ticker
      const { data: existing } = await supabase
        .from('securities')
        .select('id')
        .eq('ticker', sec.ticker)
        .maybeSingle();

      if (!existing) {
        console.error(`  ✗ Failed to upsert ${sec.canonical_name}: ${secErr?.message}`);
        continue;
      }

      // Security exists — just ensure aliases are set
      await upsertAliases(supabase, existing.id, sec);
      skipped++;
      process.stdout.write('.');
      continue;
    }

    await upsertAliases(supabase, secRow.id, sec);
    inserted++;
    process.stdout.write('+');
  }

  console.log('\n');
  console.log(`Done: ${inserted} inserted, ${skipped} already existed`);
  console.log('\nAliases registered per security:');
  console.log('  • CUSIP (lowercase)');
  console.log('  • ISIN (lowercase)');
  console.log('  • Normalised name (suffix-stripped, lowercased)');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertAliases(
  supabase: any,
  securityId: string,
  sec: SeedSecurity
) {
  const aliases = [
    sec.cusip.toLowerCase(),
    sec.isin.toLowerCase(),
    normaliseName(sec.canonical_name),
  ].filter(Boolean);

  // Add ticker as alias too
  if (sec.ticker) aliases.push(sec.ticker.toLowerCase());

  for (const alias of aliases) {
    await supabase
      .from('security_aliases')
      .upsert({ alias, security_id: securityId }, { onConflict: 'alias', ignoreDuplicates: true });
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
