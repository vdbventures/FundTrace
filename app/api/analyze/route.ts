import { NextRequest, NextResponse } from 'next/server';
import registry from '@/lib/fund-registry.json';
import { fetchFund as fetchSlgi } from '@/lib/scrapers/slgi';
import { fetchFund as fetchFidelity } from '@/lib/scrapers/fidelity';
import { fetchEtf as fetchFmp } from '@/lib/scrapers/fmp';

type AssetType = 'canadian_mutual_fund' | 'canadian_etf' | 'us_etf' | 'stock' | 'unknown';

interface PositionInput {
  code: string;
  value: number;
}

interface DetectResult {
  assetType: AssetType;
  canonical?: string;
  family?: string;
}

const aliasIndex = registry.aliasIndex as unknown as Record<
  string,
  { canonical: string; family: string }
>;
const canadianETFs = registry.canadianETFs as unknown as Record<string, Record<string, unknown>>;

function detectAssetType(code: string): DetectResult {
  // Try exact, then uppercase, then lowercase to cover all alias key formats
  for (const key of [code, code.toUpperCase(), code.toLowerCase()]) {
    if (aliasIndex[key]) {
      return { assetType: 'canadian_mutual_fund', ...aliasIndex[key] };
    }
  }

  if (canadianETFs[code.toUpperCase()]) {
    return { assetType: 'canadian_etf', canonical: code.toUpperCase() };
  }

  // Unknown — FMP will determine whether it's a US ETF or direct stock holding
  return { assetType: 'unknown' };
}

const STRIP_SUFFIXES =
  /\b(Corp\.?|Inc\.?|Ltd\.?|PLC|SE|AG|SA|ADR|Class\s+A|Shs|Ord)\b\.?/gi;

function normaliseName(name: string): string {
  return name.replace(STRIP_SUFFIXES, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  let body: { holdings?: PositionInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const holdings = body.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) {
    return NextResponse.json(
      { error: 'holdings must be a non-empty array of { code, value }' },
      { status: 400 }
    );
  }

  const portfolioTotal = holdings.reduce((sum, h) => sum + (h.value || 0), 0);

  // ── Resolve each position ─────────────────────────────────────────────────
  const positions = [];
  const unresolved: string[] = [];

  for (const h of holdings) {
    const { assetType, canonical, family } = detectAssetType(h.code);

    if (assetType === 'canadian_etf') {
      const etfMeta = canadianETFs[canonical!] as Record<string, unknown>;
      const usEquiv = (etfMeta.usEquiv as string | null) ?? null;
      const fmpTicker = usEquiv ?? canonical!;

      try {
        const fmpResult = await fetchFmp(fmpTicker);
        const annotatedHoldings = (fmpResult?.holdings ?? []).map((holding) => ({
          name: holding.name,
          weight: holding.weight,
          dollarExposure: +((holding.weight / 100) * h.value).toFixed(2),
        }));

        positions.push({
          code: h.code,
          value: h.value,
          assetType,
          canonical: canonical!,
          fundName: (etfMeta.name as string) ?? canonical,
          family: (etfMeta.provider as string) ?? null,
          fmpTicker,
          asOf: null,
          dataQuality: fmpResult ? 'fmp-full' : 'fmp-unavailable',
          holdings: annotatedHoldings,
        });
      } catch {
        unresolved.push(h.code);
      }
      continue;
    }

    if (assetType === 'canadian_mutual_fund') {
      try {
        let scraped = null;
        if (family === 'SLGI') {
          scraped = await fetchSlgi(canonical!);
        } else if (family === 'FIDELITY') {
          scraped = await fetchFidelity(canonical!);
        }

        if (!scraped) {
          unresolved.push(h.code);
          continue;
        }

        // Annotate each holding with its dollar exposure within this position
        const annotatedHoldings = scraped.holdings.map((holding) => ({
          name: holding.name,
          weight: holding.weight,
          dollarExposure:
            holding.weight != null
              ? +((holding.weight / 100) * h.value).toFixed(2)
              : null,
        }));

        positions.push({
          code: h.code,
          value: h.value,
          assetType,
          canonical: canonical!,
          fundName: scraped.fundName,
          family,
          asOf: scraped.asOf,
          dataQuality: scraped.dataQuality,
          holdings: annotatedHoldings,
        });
      } catch {
        unresolved.push(h.code);
      }
      continue;
    }

    // unknown — try FMP to distinguish US ETF from direct stock
    try {
      const fmpResult = await fetchFmp(h.code.toUpperCase());
      if (fmpResult && fmpResult.holdings.length > 0) {
        const annotatedHoldings = fmpResult.holdings.map((holding) => ({
          name: holding.name,
          weight: holding.weight,
          dollarExposure: +((holding.weight / 100) * h.value).toFixed(2),
        }));
        positions.push({
          code: h.code,
          value: h.value,
          assetType: 'us_etf' as AssetType,
          canonical: h.code.toUpperCase(),
          fundName: h.code.toUpperCase(),
          family: 'FMP',
          fmpTicker: h.code.toUpperCase(),
          asOf: null,
          dataQuality: 'fmp-full',
          holdings: annotatedHoldings,
        });
      } else {
        positions.push({
          code: h.code,
          value: h.value,
          assetType: 'stock' as AssetType,
          canonical: h.code.toUpperCase(),
          fundName: null,
          family: null,
          fmpTicker: null,
          asOf: null,
          dataQuality: null,
          holdings: [],
        });
      }
    } catch {
      unresolved.push(h.code);
    }
  }

  // ── Aggregate exposure across all resolved funds ───────────────────────────
  const exposureMap = new Map<
    string, // normalised key
    { displayName: string; totalDollar: number; sources: Array<{ fund: string; weight: number; dollar: number }> }
  >();

  for (const pos of positions) {
    for (const h of pos.holdings) {
      if (h.dollarExposure == null || h.dollarExposure <= 0) continue;
      const normKey = normaliseName(h.name);
      const source = { fund: pos.code, weight: h.weight ?? 0, dollar: h.dollarExposure };
      const existing = exposureMap.get(normKey);
      if (existing) {
        existing.totalDollar += h.dollarExposure;
        existing.sources.push(source);
        if (h.name.length > existing.displayName.length) existing.displayName = h.name;
      } else {
        exposureMap.set(normKey, { displayName: h.name, totalDollar: h.dollarExposure, sources: [source] });
      }
    }
  }

  const exposure = Array.from(exposureMap.values())
    .map(({ displayName, totalDollar, sources }) => ({
      name: displayName,
      totalDollar: +totalDollar.toFixed(2),
      pctOfPortfolio:
        portfolioTotal > 0 ? +((totalDollar / portfolioTotal) * 100).toFixed(2) : 0,
      sources,
    }))
    .sort((a, b) => b.totalDollar - a.totalDollar);

  return NextResponse.json({
    portfolioTotal,
    positions,
    exposure,
    unresolved,
  });
}
