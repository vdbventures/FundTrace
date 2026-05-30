import axios from 'axios';
import { load } from 'cheerio';

const FIDELITY_FUNDS: Record<
  string,
  { name: string; code: string; series: string; type: 'stock' | 'fof' }
> = {
  gc:  { name: 'Fidelity Greater Canada Fund Series F',     code: 'FID1646', series: 'F', type: 'stock' },
  uet: { name: 'Fidelity Global Innovators Class Series F', code: 'FID5982', series: 'F', type: 'stock' },
  aee: { name: 'Fidelity All-in-One Equity ETF Fund',       code: 'FID7567', series: 'F', type: 'fof'   },
  mmf: { name: 'Fidelity Global Equity+ Fund Series F',     code: 'FID7648', series: 'F', type: 'fof'   },
};

const BASE_URL = 'https://www.fidelity.ca';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};

export interface FidelityHolding {
  name: string;
  rank: number;
  weight: number | null;
  weightSource: 'actual' | 'estimated';
}

export interface FidelityFundResult {
  fundCode: string;
  fundName: string;
  slug: string;
  source: 'fidelity-html';
  fundType: 'stock' | 'fund-of-funds';
  isFundOfFunds: boolean;
  asOf: string | null;
  dataQuality: string;
  scrapedAt: string;
  holdings: FidelityHolding[];
}

function extractDate(html: string): string | null {
  const patterns = [
    /As at\s+(\d{1,2}[-\s][A-Za-z]+[-\s]\d{4})/i,
    /As of\s+([A-Za-z]+ \d+,?\s+\d{4})/i,
    /(\d{1,2}-[A-Za-z]+-\d{4})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        return new Date(m[1].replace(/-/g, ' ')).toISOString().split('T')[0];
      } catch {
        // ignore parse errors, try next pattern
      }
    }
  }
  return null;
}

function parseStockFund(
  $: ReturnType<typeof load>
): Pick<FidelityFundResult, 'fundType' | 'isFundOfFunds' | 'dataQuality' | 'holdings'> {
  const names: string[] = [];
  $('ol.pdf-holdings-reg li').each((_, el) => {
    const n = $(el).text().trim();
    if (n) names.push(n);
  });

  const aggregateText = $('td.pdf-holdings-prt').first().text().trim();
  const aggregate = parseFloat(aggregateText) || null;
  const estWeight = aggregate && names.length ? +(aggregate / names.length).toFixed(2) : null;

  return {
    fundType: 'stock',
    isFundOfFunds: false,
    dataQuality: names.length >= 10 ? 'top10-names-only' : `partial:${names.length}`,
    holdings: names.map((name, i) => ({
      name,
      rank: i + 1,
      weight: estWeight,
      weightSource: 'estimated' as const,
    })),
  };
}

function parseFoFund(
  $: ReturnType<typeof load>
): Pick<FidelityFundResult, 'fundType' | 'isFundOfFunds' | 'dataQuality' | 'holdings'> {
  const holdings: FidelityHolding[] = [];

  $('div[id^="target-allocation-"] table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name = $(cells[0]).text().trim();
    const weight = parseFloat($(cells[1]).text().trim());
    if (name && !isNaN(weight) && weight > 0) {
      holdings.push({ name, weight, weightSource: 'actual', rank: holdings.length + 1 });
    }
  });

  // Fallback for mmf-style tables
  if (holdings.length === 0) {
    $('table.table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const name = $(cells[0]).text().trim();
        const weight = parseFloat($(cells[1]).text().trim());
        if (name && name.length > 3 && !isNaN(weight) && weight > 0 && weight < 100) {
          holdings.push({ name, weight, weightSource: 'actual', rank: holdings.length + 1 });
        }
      }
    });
  }

  return {
    fundType: 'fund-of-funds',
    isFundOfFunds: true,
    dataQuality: holdings.length > 0 ? 'full-allocation' : 'failed',
    holdings: holdings.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
  };
}

export async function fetchFund(slug: string): Promise<FidelityFundResult | null> {
  const fund = FIDELITY_FUNDS[slug];
  if (!fund) return null;

  const url = `${BASE_URL}/en/products/funds/${slug}/?series=${fund.series}`;

  const res = await axios.get<string>(url, { headers: HEADERS, timeout: 15000 });
  const html = res.data;

  const $ = load(html);
  const asOf = extractDate(html);
  const parsed = fund.type === 'fof' ? parseFoFund($) : parseStockFund($);

  if (!parsed.holdings.length) return null;

  // Deduplicate by name — multiple table sections on the page can produce the same holding
  const seen = new Set<string>();
  const holdings = parsed.holdings.filter((h) => {
    const key = h.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    fundCode: fund.code,
    fundName: fund.name,
    slug,
    source: 'fidelity-html',
    asOf,
    scrapedAt: new Date().toISOString(),
    ...parsed,
    holdings,
  };
}
