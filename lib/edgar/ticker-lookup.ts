/**
 * lib/edgar/ticker-lookup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps a US fund ticker to its SEC CIK + series/class identifiers using the
 * SEC's published mutual fund tickers JSON.
 *
 * Source: https://www.sec.gov/files/company_tickers_mf.json
 * Downloaded once per process, cached in memory. The file is updated by the
 * SEC periodically; for freshness run the ingestion job regularly.
 *
 * Structure of the SEC JSON (array of objects):
 *   { cik_str: 36405, ticker: "VOO", title: "VANGUARD INDEX FUNDS", ... }
 * Fields (not all records have all fields):
 *   cik_str, ticker, title, exchange, type, class_id, series_id
 *
 * Usage:
 *   const info = await lookupTicker('VOO');
 *   // { cik: '0000036405', ticker: 'VOO', title: '...', seriesId: '...' }
 */

import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TickerInfo {
  /** Zero-padded 10-digit CIK, e.g. "0000036405" */
  cik: string;
  ticker: string;
  title: string;
  /** SEC series ID, e.g. "S000002277" — used to disambiguate multi-fund trusts */
  seriesId: string | null;
  /** SEC class/series ID for the specific share class */
  classId: string | null;
}

interface SecMfRecord {
  cik_str: number | string;
  ticker: string;
  title?: string;
  series_id?: string;
  class_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SEC_TICKERS_MF_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const CACHE_FILE = path.join(process.cwd(), '.edgar-ticker-cache.json');
const USER_AGENT = 'FundTrace fundtrace-contact@example.com';

// In-process cache — avoids repeated disk/network hits during a single run
let memoryCache: Map<string, TickerInfo> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function padCik(cik: number | string): string {
  return String(cik).padStart(10, '0');
}

function buildIndex(records: SecMfRecord[]): Map<string, TickerInfo> {
  const idx = new Map<string, TickerInfo>();
  for (const r of records) {
    if (!r.ticker) continue;
    const info: TickerInfo = {
      cik: padCik(r.cik_str),
      ticker: r.ticker.toUpperCase(),
      title: r.title ?? '',
      seriesId: r.series_id ?? null,
      classId: r.class_id ?? null,
    };
    idx.set(r.ticker.toUpperCase(), info);
  }
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load — try disk cache first, then fetch from SEC
// ─────────────────────────────────────────────────────────────────────────────

async function loadIndex(): Promise<Map<string, TickerInfo>> {
  if (memoryCache) return memoryCache;

  // Try disk cache
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const records: SecMfRecord[] = JSON.parse(raw);
    console.log(`[ticker-lookup] loaded ${records.length} records from disk cache`);
    memoryCache = buildIndex(records);
    return memoryCache;
  } catch {
    // Cache missing or corrupt — fall through to fetch
  }

  // Fetch from SEC
  console.log('[ticker-lookup] fetching SEC mutual fund tickers list...');
  const res = await fetch(SEC_TICKERS_MF_URL, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`[ticker-lookup] SEC fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as unknown;

  // The SEC file uses a columnar format:
  //   { "fields": ["cik","seriesId","classId","symbol"], "data": [[2110,"S000009184",...], ...] }
  // Handle this as well as an older flat-array format if the SEC ever changes it.
  let records: SecMfRecord[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;

  if (d && Array.isArray(d.fields) && Array.isArray(d.data)) {
    // Current format: { fields: [...], data: [[...], ...] }
    const headers: string[] = d.fields;
    const rows: Array<Array<string | number>> = d.data;
    records = rows.map((row) => {
      const obj: Record<string, string | number> = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return {
        cik_str: obj['cik'],
        ticker: String(obj['symbol'] ?? ''),
        series_id: obj['seriesId'] ? String(obj['seriesId']) : undefined,
        class_id: obj['classId'] ? String(obj['classId']) : undefined,
      } as SecMfRecord;
    });
  } else if (Array.isArray(data)) {
    records = data as SecMfRecord[];
  } else if (data && typeof data === 'object') {
    records = Object.values(data) as SecMfRecord[];
  } else {
    throw new Error('[ticker-lookup] unexpected SEC JSON shape');
  }

  console.log(`[ticker-lookup] fetched ${records.length} records from SEC`);

  // Persist to disk for future runs
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(records), 'utf8');
    console.log(`[ticker-lookup] cached to ${CACHE_FILE}`);
  } catch (err) {
    console.warn('[ticker-lookup] could not write disk cache:', err);
  }

  memoryCache = buildIndex(records);
  return memoryCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up a US fund ticker → CIK + series info.
 *
 * @param ticker  e.g. "VOO", "SPY", "FXAIX"
 * @returns       TickerInfo or null if not found in SEC's fund list
 */
export async function lookupTicker(ticker: string): Promise<TickerInfo | null> {
  const idx = await loadIndex();
  return idx.get(ticker.toUpperCase()) ?? null;
}

/**
 * Force a fresh download of the SEC tickers file (e.g. from a CLI refresh command).
 * Clears both memory and disk caches.
 */
export async function refreshTickerCache(): Promise<void> {
  memoryCache = null;
  try { fs.unlinkSync(CACHE_FILE); } catch { /* file may not exist */ }
  await loadIndex();
}
