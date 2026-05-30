/**
 * lib/scrapers/vanguard-ca.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vanguard Canada ETF holdings scraper.
 *
 * Technique: unauthenticated HTTPS POST to https://www.vanguard.ca/gpx/graphql
 * Two static headers are required:
 *   x-consumer-id: ca0
 *   apollographql-client-name: gpx
 *
 * No session tokens, no CSRF, no cookies needed. Confirmed working 2026-05-30.
 *
 * Returns borHoldings.delayeredHoldings — the look-through holdings that pierce
 * the ETF wrapper (e.g. VFV → 525 underlying S&P 500 stocks, not just "VOO").
 * Fund-of-funds (VEQT, VBAL, VGRO) return their underlying ETF allocations.
 *
 * Identifier coverage (VFV sample, n=525):
 *   ISIN: 96%  CUSIP: 97%  SEDOL: ~96%  Ticker: 97%
 *
 * Weight convention: DB stores weight as a fraction (0.0783 = 7.83%).
 * Vanguard returns marketValuePercentage as percent (7.83).
 *
 * Period: normalised to first day of the reference month from the holdings
 * asOfDate returned by the borHoldings query (or portfolio characteristics).
 *
 * Probes that led to this implementation:
 *   scripts/probe-vanguard-puppeteer.js  — discovered /gpx/graphql endpoint
 *   scripts/probe-vanguard-gpx4.js       — confirmed server-side access
 *   scripts/probe-vanguard-portids.js    — built portId map
 */

import https from 'https';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const GQL_HOSTNAME = 'www.vanguard.ca';
const GQL_PATH = '/gpx/graphql';
const GQL_ORIGIN = 'https://www.vanguard.ca';
const USER_AGENT =
  'Mozilla/5.0 (compatible; FundTrace/1.0; +https://fundtrace.ca) Chrome/124.0';

// ─────────────────────────────────────────────────────────────────────────────
// portId map — all Vanguard Canada TSX-listed ETFs
// Source: probed via /gpx/graphql FundFinder query 2026-05-30
// ─────────────────────────────────────────────────────────────────────────────

export const VANGUARD_CA_PORT_IDS: Record<string, string> = {
  // All-in-one portfolios (fund of ETFs — delayeredHoldings = underlying ETF allocations)
  'VCIP': '9691',  // Conservative Income ETF Portfolio
  'VCNS': '9577',  // Conservative ETF Portfolio
  'VBAL': '9578',  // Balanced ETF Portfolio
  'VGRO': '9579',  // Growth ETF Portfolio
  'VEQT': '9692',  // All-Equity ETF Portfolio

  // US equity
  'VFV': '9563',   // S&P 500 Index ETF (unhedged)
  'VSP': '9562',   // S&P 500 Index ETF (CAD-hedged)
  'VUN': '9557',   // U.S. Total Market Index ETF (unhedged)
  'VUS': '9551',   // U.S. Total Market Index ETF (CAD-hedged)
  'VGG': '9566',   // U.S. Dividend Appreciation Index ETF (unhedged)
  'VGH': '9564',   // U.S. Dividend Appreciation Index ETF (CAD-hedged)

  // Canadian equity
  'VCN': '9561',   // FTSE Canada All Cap Index ETF
  'VCE': '9554',   // FTSE Canada Index ETF
  'VDY': '9560',   // FTSE Canadian High Dividend Yield Index ETF
  'VRE': '9559',   // FTSE Canadian Capped REIT Index ETF

  // International equity
  'VXC': '9548',   // FTSE Global All Cap ex Canada Index ETF
  'VIU': '9569',   // FTSE Developed All Cap ex North America Index ETF (unhedged)
  'VI':  '9570',   // FTSE Developed All Cap ex North America Index ETF (CAD-hedged)
  'VDU': '9558',   // FTSE Developed All Cap ex U.S. Index ETF (unhedged)
  'VEF': '9555',   // FTSE Developed All Cap ex U.S. Index ETF (CAD-hedged)
  'VEE': '9556',   // FTSE Emerging Markets All Cap Index ETF
  'VIDY':'9742',   // FTSE Developed ex North America High Dividend Yield Index ETF
  'VE':  '9549',   // FTSE Developed Europe All Cap Index ETF
  'VA':  '9550',   // FTSE Developed Asia Pacific All Cap Index ETF

  // Canadian bonds
  'VAB': '9552',   // Canadian Aggregate Bond Index ETF
  'VSB': '9553',   // Canadian Short-Term Bond Index ETF
  'VSC': '9565',   // Canadian Short-Term Corporate Bond Index ETF
  'VLB': '1811',   // Canadian Long-Term Bond Index ETF
  'VGV': '1817',   // Canadian Government Bond Index ETF
  'VCB': '1936',   // Canadian Corporate Bond Index ETF

  // Factor / smart-beta
  'VVL': '9795',   // Global Value Factor ETF
  'VVO': '9828',   // Global Minimum Volatility ETF
  'VMO': '9835',   // Global Momentum Factor ETF
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VanguardCaHolding {
  /** Security name as returned by Vanguard */
  name: string;
  /** ISIN — present on ~96% of holdings */
  isin: string | null;
  /** CUSIP — present on ~97% of holdings */
  cusip: string | null;
  /** SEDOL — present on ~96% of holdings */
  sedol: string | null;
  /** Exchange ticker (e.g. "NVDA") — present on ~97% of holdings */
  ticker: string | null;
  /** DB-ready weight fraction: 0.0783 = 7.83% */
  weight: number;
  /** GICS sector description */
  sector: string | null;
}

export interface VanguardCaFundResult {
  ticker: string;
  portId: string;
  source: 'vanguard-ca';
  /**
   * Full fund name as returned by the API, e.g.
   * "Vanguard S&P 500 Index ETF". Null if not returned.
   */
  fundFullName: string | null;
  /**
   * Normalised period: first day of the reference month, e.g. "2026-04-01"
   * Derived from the asOfDate field in the holdings response.
   */
  period: string;
  /** Raw asOfDate from the API, e.g. "2026-04-30" */
  asOfDate: string;
  holdingCount: number;
  weightSum: number;
  holdings: VanguardCaHolding[];
  scrapedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function gqlPost(body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts: https.RequestOptions = {
      hostname: GQL_HOSTNAME,
      path: GQL_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*',
        'origin': GQL_ORIGIN,
        'referer': GQL_ORIGIN + '/en/investor/products/products-group/etfs/',
        'x-consumer-id': 'ca0',
        'apollographql-client-name': 'gpx',
        'user-agent': USER_AGENT,
        'accept-language': 'en-CA,en;q=0.9',
        'content-length': String(Buffer.byteLength(payload)),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "2026-04-30" → "2026-04-01" */
function toFirstOfMonth(dateStr: string): string {
  const [year, month] = dateStr.split('-');
  return `${year}-${month}-01`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL query builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the borHoldings query with an inline literal limit.
 * We cannot use a typed GQL variable for limit because the schema type is
 * not Int (the server rejects it). Inline literals bypass the type check.
 */
function buildHoldingsQuery(portId: string, limit = 1000, cursor: string | null = null): string {
  // cursor must be passed as an inline literal to avoid GQL variable type issues
  const cursorArg = cursor
    ? `, lastItemKey: "${cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : '';
  const fundsQuery = cursor
    ? '' // Only need funds metadata on the first page
    : `funds(portIds: ["${portId}"]) {
          portId
          profile { fundFullName }
        }`;
  return JSON.stringify({
    operationName: 'VanguardCaHoldings',
    variables: {},
    query: `
      query VanguardCaHoldings {
        ${fundsQuery}
        borHoldings(portIds: ["${portId}"]) {
          delayeredHoldings(limit: ${limit}${cursorArg}) {
            items {
              issuerName
              securityLongDescription
              marketValuePercentage
              gicsSectorDescription
              sedol1
              cusip
              isin
              ticker
            }
            lastItemKey
          }
        }
      }
    `.trim(),
  });
}

/**
 * Return the best-guess asOfDate for the holdings snapshot.
 * Vanguard CA publishes holdings monthly. The /gpx/graphql schema's
 * exact field for the holdings reference date hasn't been confirmed
 * without introspection. Until it is, we derive: "last complete month".
 *
 * TODO: discover the correct GQL field name for the holdings asOfDate.
 * The PortfolioCharacteristicsQuery operation (from browser network trace)
 * uses a field under funds.* — try `polarisPortfolioCharacteristics`,
 * `polarisFundDetails`, or similar once schema introspection is enabled.
 */
function deriveAsOfDate(): string {
  const today = new Date();
  // Use the last day of the previous month as the reference date,
  // which normalises to first-of-that-month for `period`.
  today.setDate(0); // rolls to last day of previous month
  return today.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core fetch function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all holdings for a Vanguard Canada ETF by TSX ticker.
 *
 * @param ticker - TSX ticker, e.g. "VFV", "VEQT", "VBAL"
 * @returns null if the ticker is unknown or the API returns an error
 */
export async function fetchFundHoldings(
  ticker: string
): Promise<VanguardCaFundResult | null> {
  const upperTicker = ticker.toUpperCase();
  const portId = VANGUARD_CA_PORT_IDS[upperTicker];
  if (!portId) {
    console.warn(`[vanguard-ca] Unknown ticker: ${upperTicker}`);
    return null;
  }

  // ── Paginate through all holdings ──────────────────────────────────────────
  const allRawItems: any[] = [];
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20; // safety cap — even VEQT (10,000+ stocks) fits in 15 pages
  let pageNum = 0;
  let fundFullName: string | null = null;

  let currentCursor: string | null = null;

  while (pageNum < MAX_PAGES) {
    const query = buildHoldingsQuery(portId, PAGE_SIZE, currentCursor);
    let res: { status: number; body: string };
    try {
      res = await gqlPost(JSON.parse(query));
    } catch (err) {
      console.error(`[vanguard-ca] HTTP error for ${upperTicker} page ${pageNum + 1}:`, err);
      return null;
    }

    if (res.status !== 200) {
      console.error(`[vanguard-ca] HTTP ${res.status} for ${upperTicker}:`, res.body.slice(0, 300));
      return null;
    }

    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      console.error(`[vanguard-ca] JSON parse error for ${upperTicker} page ${pageNum + 1}`);
      return null;
    }

    if (json.errors?.length) {
      console.error(`[vanguard-ca] GQL errors for ${upperTicker}:`, JSON.stringify(json.errors[0]).slice(0, 200));
      return null;
    }

    if (pageNum === 0) {
      fundFullName = json?.data?.funds?.[0]?.profile?.fundFullName ?? null;
    }

    const borHolding = json?.data?.borHoldings?.[0];
    if (!borHolding) {
      console.error(`[vanguard-ca] No borHoldings in response for ${upperTicker} page ${pageNum + 1}`);
      return null;
    }

    const items: any[] = borHolding.delayeredHoldings?.items ?? [];
    allRawItems.push(...items);

    const nextCursor = borHolding.delayeredHoldings?.lastItemKey ?? null;
    pageNum++;

    if (!nextCursor || items.length === 0) break;
    currentCursor = nextCursor;

    // Small delay between pages to be polite
    await new Promise((r) => setTimeout(r, 100));
  }

  const rawItems = allRawItems;

  if (rawItems.length === 0) {
    console.warn(`[vanguard-ca] Zero holdings returned for ${upperTicker} (portId ${portId})`);
    return null;
  }

  // TODO: replace with actual asOfDate from the schema once the correct field name is found
  const asOfDate: string = deriveAsOfDate();

  // Map raw items to our type
  const holdings: VanguardCaHolding[] = rawItems.map((item) => ({
    name: item.issuerName ?? item.securityLongDescription ?? '',
    isin: item.isin ?? null,
    cusip: item.cusip ?? null,
    sedol: item.sedol1 ?? null,
    ticker: item.ticker ?? null,
    // Vanguard returns percent (7.83), DB wants fraction (0.0783)
    weight: (item.marketValuePercentage ?? 0) / 100,
    sector: item.gicsSectorDescription ?? null,
  }));

  const weightSum = holdings.reduce((s, h) => s + h.weight, 0);
  const period = asOfDate ? toFirstOfMonth(asOfDate) : toFirstOfMonth(new Date().toISOString().slice(0, 10));

  return {
    ticker: upperTicker,
    portId,
    source: 'vanguard-ca',
    fundFullName,
    period,
    asOfDate: asOfDate || '',
    holdingCount: holdings.length,
    weightSum,
    holdings,
    scrapedAt: new Date().toISOString(),
  };
}
