/**
 * lib/edgar/nport-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure N-PORT-P XML parser. No HTTP, no DB — takes XML text in, returns
 * structured holdings out. Unit-testable in isolation.
 *
 * Verified against VOO filing 0000036405-26-000325 (2026-05-28):
 *   - 519 holdings, equity filter = assetCat "EC"
 *   - pctVal is already in percent form  (7.5775 → 7.5775%)
 *   - ISIN lives as an attribute:  <isin value="US9100471096"/>
 *   - Default namespace: http://www.sec.gov/edgar/nport  (stripped before parse)
 *
 * DB weight convention (snapshot_holdings.weight numeric(7,4)):
 *   0.0380 = 3.80%  →  weight = pctVal / 100
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NportHolding {
  /** Raw name from XML */
  name: string;
  /** CUSIP — 9-char, present on virtually all US equities */
  cusip: string | null;
  /** ISIN — 12-char, present on most equities */
  isin: string | null;
  /** weight as DB fraction: 0.0758 = 7.58% */
  weight: number;
  /** raw pctVal string from XML, preserved for debugging */
  pctValRaw: string;
  /** 'EC' = equity common; others passed through for caller to bucket */
  assetCat: string | null;
  /** ISO country code, e.g. 'US' */
  country: string | null;
}

export interface NportSkipped {
  reason: string;
  name?: string;
  xml?: string;
}

export interface NportParseResult {
  /** Normalised first-day-of-quarter date string, e.g. "2025-12-01" */
  period: string;
  /** Raw period end date from <repPdDate> */
  periodRaw: string;
  /** Series name from <seriesName>, if present */
  seriesName: string | null;
  /** Fund's CIK as string (may include leading zeros) */
  cik: string | null;
  /** Equity holdings only (assetCat === 'EC') */
  equityHoldings: NportHolding[];
  /** Total equity holdings count */
  equityCount: number;
  /** Holdings that were skipped and why */
  skipped: NportSkipped[];
  /** Sum of all equity weights — should be ≤ 1.0 (not 100%) */
  equityWeightSum: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the default SEC EDGAR namespace declaration so plain string matching
 * works without an XML namespace resolver.
 */
function stripNamespace(xml: string): string {
  return xml.replace(/\sxmlns="[^"]*"/g, '');
}

/**
 * Extract the text content of the first matching simple tag.
 * Handles both <tag>value</tag> and self-closing <tag/>.
 */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * Extract the value of a named attribute from the first matching tag.
 * e.g. extractAttr(xml, 'isin', 'value') on <isin value="US9100471096"/>
 */
function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]+${attr}="([^"]*)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * Split XML string into per-holding chunks using <invstOrSec>...</invstOrSec>.
 * Returns array of raw XML strings, one per holding.
 */
function splitHoldings(xml: string): string[] {
  const chunks: string[] = [];
  const open = '<invstOrSec>';
  const close = '</invstOrSec>';
  let cursor = 0;

  while (true) {
    const start = xml.indexOf(open, cursor);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    chunks.push(xml.slice(start + open.length, end));
    cursor = end + close.length;
  }

  return chunks;
}

/**
 * Normalise a reporting period end date → first day of the quarter.
 * N-PORT periods end on the last day of the month (Dec 31, Mar 31, Jun 30, Sep 30).
 * We normalise to the first day: Dec → Dec 1, Mar → Mar 1, etc.
 * Input format: YYYY-MM-DD
 */
function normaliseToQuarterStart(raw: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(raw);
  if (!m) return raw;
  const [, year, month] = m;
  return `${year}-${month}-01`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse N-PORT-P XML.
 *
 * @param xml   Raw XML string from SEC EDGAR
 * @returns     Parsed result with equity holdings and metadata
 */
export function parseNport(xml: string): NportParseResult {
  const clean = stripNamespace(xml);

  // ── Reporting period ──────────────────────────────────────────────────────
  const periodRaw = extractTag(clean, 'repPdDate') ?? '';
  const period = periodRaw ? normaliseToQuarterStart(periodRaw) : '';

  // ── Fund identity ─────────────────────────────────────────────────────────
  const seriesName = extractTag(clean, 'seriesName');
  const cik = extractTag(clean, 'cik');

  // ── Split and parse individual holdings ──────────────────────────────────
  const chunks = splitHoldings(clean);
  const equityHoldings: NportHolding[] = [];
  const skipped: NportSkipped[] = [];

  for (const chunk of chunks) {
    try {
      const result = parseHolding(chunk);

      // 'skip' = non-equity (DE, STIV, etc.) — silently discard
      if (result === 'skip') continue;

      // null = equity but unparseable or zero/negative weight — log to skipped
      if (result === null) {
        const name = extractTag(chunk, 'name') ?? 'unknown';
        const pctVal = extractTag(chunk, 'pctVal') ?? 'n/a';
        const assetCat = extractTag(chunk, 'assetCat') ?? 'n/a';
        skipped.push({
          reason: `equity holding skipped: missing fields, zero/negative weight, or parse error (pctVal=${pctVal}, assetCat=${assetCat})`,
          name,
        });
        continue;
      }

      equityHoldings.push(result);
    } catch (err) {
      const name = extractTag(chunk, 'name') ?? 'unknown';
      skipped.push({
        reason: `parse error: ${err instanceof Error ? err.message : String(err)}`,
        name,
        xml: chunk.slice(0, 200),
      });
    }
  }

  const equityWeightSum =
    Math.round(equityHoldings.reduce((sum, h) => sum + h.weight, 0) * 1e6) / 1e6;

  return {
    period,
    periodRaw,
    seriesName,
    cik,
    equityHoldings,
    equityCount: equityHoldings.length,
    skipped,
    equityWeightSum,
  };
}

/**
 * Parse a single <invstOrSec> chunk.
 *
 * Returns:
 *   - NportHolding  → equity holding, include it
 *   - 'skip'        → non-equity (DE, STIV, etc.), silently ignore
 *   - null          → equity but missing required fields, add to skipped
 */
function parseHolding(chunk: string): NportHolding | 'skip' | null {
  const assetCat = extractTag(chunk, 'assetCat');

  // Only ingest equity common stock; silently drop the rest
  if (assetCat !== 'EC') return 'skip';

  const name = extractTag(chunk, 'name');
  const pctValRaw = extractTag(chunk, 'pctVal');

  // Required fields for an equity holding
  if (!name || pctValRaw === null) {
    return null; // will be recorded in skipped by caller
  }

  const pctVal = parseFloat(pctValRaw);
  if (isNaN(pctVal)) {
    return null;
  }

  // weight: pctVal is in percent form (7.5775 = 7.5775%)
  // DB schema: weight numeric(7,4) where 0.0758 = 7.58%
  const weight = Math.round((pctVal / 100) * 1e6) / 1e6;

  // Skip near-zero or negative-weight holdings — these are index reconstitution
  // artefacts (e.g. contingent value rights, tiny odd-lot positions) that round
  // to exactly 0 at our 6dp precision.  Log as skipped, do not include.
  if (weight <= 0) return null;

  // Identifiers
  const cusip = extractTag(chunk, 'cusip');

  // ISIN lives as an attribute: <isin value="US9100471096"/>
  const isinSection = /<identifiers[^>]*>([\s\S]*?)<\/identifiers>/i.exec(chunk);
  const isin = isinSection ? extractAttr(isinSection[1], 'isin', 'value') : null;

  const country = extractTag(chunk, 'invCountry');

  return {
    name: name.trim(),
    cusip: cusip?.trim() || null,
    isin: isin?.trim() || null,
    weight,
    pctValRaw,
    assetCat,
    country: country?.trim() || null,
  };
}
