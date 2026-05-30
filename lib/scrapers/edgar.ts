/**
 * lib/scrapers/edgar.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EDGAR N-PORT-P holdings scraper.
 * Mirrors the shape of lib/scrapers/slgi.ts — exports fetchFundHoldings(ticker)
 * returning the same internal structure Canadian scrapers return.
 *
 * Pipeline:
 *   1. ticker → CIK + seriesId    (ticker-lookup.ts)
 *   2. CIK → latest NPORT-P accession number  (EDGAR submissions API)
 *   3. accession → XML filing     (EDGAR XBRL viewer / full-submission)
 *   4. XML → holdings             (nport-parser.ts)
 *
 * SEC EDGAR User-Agent policy: requests without a contact email will be
 * rate-limited or blocked. Set once here.
 *
 * Downstream code (diffs, alerts, page rendering) is not aware of the source.
 * EDGAR is just another source writing into the same snapshot tables.
 */

import { lookupTicker, TickerInfo } from '../edgar/ticker-lookup';
import { parseNport, NportHolding } from '../edgar/nport-parser';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// IMPORTANT: SEC EDGAR blocks requests without a contact email in User-Agent
const USER_AGENT = 'FundTrace fundtrace-contact@example.com';

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/full-index';
const DOCUMENTS_BASE = 'https://www.sec.gov/Archives/edgar/data';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgarHolding {
  name: string;
  cusip: string | null;
  isin: string | null;
  /** DB-ready weight: 0.0758 = 7.58% */
  weight: number;
  /** Position in the holdings list (1-based, by descending weight) */
  rank: number;
}

export interface EdgarFundResult {
  ticker: string;
  /** The CIK this filing was pulled from */
  cik: string;
  /** Series name from the filing itself, e.g. "VANGUARD 500 INDEX FUND" */
  seriesName: string | null;
  source: 'edgar-nport';
  /** Normalised period: first day of the reporting quarter, e.g. "2025-12-01" */
  period: string;
  /** Raw period end date from the filing, e.g. "2025-12-31" */
  periodRaw: string;
  /** Accession number used, e.g. "0000036405-26-000325" */
  accessionNumber: string;
  /** Whether the filing was an amendment (NPORT-P/A) */
  isAmendment: boolean;
  equityCount: number;
  equityWeightSum: number;
  /** Sum of all equity weights as a sanity check */
  holdings: EdgarHolding[];
  scrapedAt: string;
  sourceUrl: string;
}

interface FilingEntry {
  accessionNumber: string;
  filingDate: string;
  form: string;
  /** Derived: true if form is NPORT-P/A */
  isAmendment: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

async function secFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`SEC fetch failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — CIK → latest N-PORT-P filing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the EDGAR submissions JSON for a CIK and return the most recent
 * NPORT-P (or NPORT-P/A, preferred) filing entry.
 *
 * For multi-fund trusts (like Vanguard Index Funds), the submissions list
 * contains filings for ALL series. We use seriesId to narrow to the right
 * series if provided; otherwise we take the most recent NPORT-P filing.
 */
async function getLatestFiling(
  cik: string,
  seriesId: string | null
): Promise<FilingEntry | null> {
  const paddedCik = cik.padStart(10, '0');
  const url = `${SUBMISSIONS_BASE}/CIK${paddedCik}.json`;

  console.log(`[edgar] fetching submissions for CIK ${paddedCik}...`);
  const res = await secFetch(url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any;

  const recent = data?.filings?.recent;
  if (!recent) {
    console.warn('[edgar] no recent filings in submissions JSON');
    return null;
  }

  const forms: string[] = recent.form ?? [];
  const accessions: string[] = recent.accessionNumber ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const seriesIds: string[] = recent.seriesId ?? [];

  // Build list of all NPORT-P and NPORT-P/A filings (possibly filtered by seriesId)
  const candidates: FilingEntry[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (form !== 'NPORT-P' && form !== 'NPORT-P/A') continue;

    // If we have a seriesId, only include filings for that series
    if (seriesId && seriesIds[i] && seriesIds[i] !== seriesId) continue;

    candidates.push({
      accessionNumber: accessions[i],
      filingDate: dates[i],
      form,
      isAmendment: form === 'NPORT-P/A',
    });
  }

  if (!candidates.length) {
    console.warn('[edgar] no NPORT-P filings found for this CIK/series');
    return null;
  }

  // Sort by date descending (most recent first)
  candidates.sort((a, b) => b.filingDate.localeCompare(a.filingDate));

  // If the most recent is an amendment, prefer it. If the most recent is a
  // base filing, check if there's an amendment for the same period (i.e., same
  // accession prefix/date window). Keep the logic simple: just take [0].
  // Amendments supersede base filings for the same period, and they're more
  // recent, so sorting by date descending already gives us the right one.
  const best = candidates[0];

  console.log(
    `[edgar] latest filing: ${best.accessionNumber} (${best.form}, ${best.filingDate})`
  );
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — accession number → XML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the primary XML document from an N-PORT accession.
 *
 * Accession format on disk: {cik}/{accessionNumber-no-dashes}/
 * The primary document is typically named nport-p.xml or similar.
 * We fetch the filing index to find the right filename.
 */
async function fetchFilingXml(cik: string, accessionNumber: string): Promise<string> {
  // IMPORTANT: EDGAR Archives uses the integer CIK (no leading zeros) in the path
  const intCik = String(parseInt(cik, 10));
  const accNoSlashes = accessionNumber.replace(/-/g, '');
  const baseDir = `${DOCUMENTS_BASE}/${intCik}/${accNoSlashes}`;

  // Fetch the HTML directory listing to find the XML filename
  console.log(`[edgar] fetching filing directory: ${baseDir}/`);
  const dirRes = await secFetch(`${baseDir}/`);
  const dirHtml = await dirRes.text();

  // Extract XML filenames from directory listing
  const xmlMatch =
    dirHtml.match(/href="([^"]*\/primary_doc\.xml)"/) ??
    dirHtml.match(/href="([^"]*nport[^"]*\.xml)"/) ??
    dirHtml.match(/href="([^"]*\.xml)"/);

  let xmlFilename: string;
  if (xmlMatch) {
    const href = xmlMatch[1];
    xmlFilename = href.split('/').pop()!;
  } else {
    xmlFilename = 'primary_doc.xml';
  }

  const xmlUrl = `${baseDir}/${xmlFilename}`;
  console.log(`[edgar] fetching XML: ${xmlUrl}`);

  const res = await secFetch(xmlUrl);
  return await res.text();
}

/**
 * Fetch the N-PORT XML and return it with the source URL.
 * Uses the HTML directory listing to find the XML filename.
 */
async function fetchFilingXmlViaIndex(
  cik: string,
  accessionNumber: string
): Promise<{ xml: string; sourceUrl: string }> {
  // EDGAR Archives: integer CIK (no leading zeros), dashes removed from accession
  const intCik = String(parseInt(cik, 10));
  const accNoSlashes = accessionNumber.replace(/-/g, '');
  const baseDir = `${DOCUMENTS_BASE}/${intCik}/${accNoSlashes}`;

  // Fetch the HTML directory listing to discover the XML filename
  console.log(`[edgar] fetching filing directory: ${baseDir}/`);
  const dirRes = await secFetch(`${baseDir}/`);
  const dirHtml = await dirRes.text();

  // Prefer primary_doc.xml, then nport*.xml, then any .xml
  const xmlMatch =
    dirHtml.match(/href="([^"]*\/primary_doc\.xml)"/) ??
    dirHtml.match(/href="([^"]*nport[^"]*\.xml)"/) ??
    dirHtml.match(/href="([^"]*\.xml)"/);

  let xmlFilename: string;
  if (xmlMatch) {
    xmlFilename = xmlMatch[1].split('/').pop()!;
  } else {
    xmlFilename = 'primary_doc.xml';
  }

  const xmlUrl = `${baseDir}/${xmlFilename}`;
  console.log(`[edgar] fetching XML: ${xmlUrl}`);

  const res = await secFetch(xmlUrl);
  const xml = await res.text();
  return { xml, sourceUrl: xmlUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch N-PORT holdings for a US fund by ticker.
 *
 * @param ticker  e.g. "VOO", "SPY", "FXAIX"
 * @returns       EdgarFundResult with equity holdings, or null on failure
 */
export async function fetchFundHoldings(ticker: string): Promise<EdgarFundResult | null> {
  const uTicker = ticker.toUpperCase();

  // ── 1. ticker → CIK + seriesId ────────────────────────────────────────────
  let tickerInfo: TickerInfo | null;
  try {
    tickerInfo = await lookupTicker(uTicker);
  } catch (err) {
    console.error(`[edgar] ticker lookup failed for ${uTicker}:`, err);
    return null;
  }

  if (!tickerInfo) {
    console.warn(`[edgar] ticker ${uTicker} not found in SEC mutual fund list`);
    return null;
  }

  console.log(
    `[edgar] ${uTicker} → CIK ${tickerInfo.cik}, series ${tickerInfo.seriesId ?? 'n/a'}`
  );

  // ── 2. CIK → latest filing ─────────────────────────────────────────────────
  let filing: FilingEntry | null;
  try {
    filing = await getLatestFiling(tickerInfo.cik, tickerInfo.seriesId);
  } catch (err) {
    console.error(`[edgar] could not get filings for ${uTicker}:`, err);
    return null;
  }

  if (!filing) return null;

  // ── 3. accession → XML ────────────────────────────────────────────────────
  let xml: string;
  let sourceUrl: string;
  try {
    const result = await fetchFilingXmlViaIndex(tickerInfo.cik, filing.accessionNumber);
    xml = result.xml;
    sourceUrl = result.sourceUrl;
  } catch (err) {
    console.error(`[edgar] could not fetch XML for ${uTicker}:`, err);
    return null;
  }

  // ── 4. XML → holdings ─────────────────────────────────────────────────────
  const parsed = parseNport(xml);

  if (!parsed.equityHoldings.length) {
    console.warn(`[edgar] ${uTicker}: no equity holdings found in filing`);
    return null;
  }

  if (parsed.skipped.length > 0) {
    console.log(
      `[edgar] ${uTicker}: skipped ${parsed.skipped.length} non-equity/unparseable holdings`
    );
  }

  // Rank by descending weight
  const sorted = [...parsed.equityHoldings].sort((a, b) => b.weight - a.weight);
  const holdings: EdgarHolding[] = sorted.map((h, i) => ({
    name: h.name,
    cusip: h.cusip,
    isin: h.isin,
    weight: h.weight,
    rank: i + 1,
  }));

  console.log(
    `[edgar] ${uTicker}: ${holdings.length} equity holdings, ` +
    `weight sum ${(parsed.equityWeightSum * 100).toFixed(2)}%, ` +
    `period ${parsed.period}`
  );

  return {
    ticker: uTicker,
    cik: tickerInfo.cik,
    seriesName: parsed.seriesName,
    source: 'edgar-nport',
    period: parsed.period,
    periodRaw: parsed.periodRaw,
    accessionNumber: filing.accessionNumber,
    isAmendment: filing.isAmendment,
    equityCount: holdings.length,
    equityWeightSum: parsed.equityWeightSum,
    holdings,
    scrapedAt: new Date().toISOString(),
    sourceUrl,
  };
}
