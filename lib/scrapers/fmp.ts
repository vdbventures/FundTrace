import axios from 'axios';

const FMP_BASE = 'https://financialmodelingprep.com/stable';

export interface FmpHolding {
  name: string;
  weight: number;
  weightSource: 'actual';
}

export interface FmpResult {
  ticker: string;
  source: 'fmp-api';
  holdings: FmpHolding[];
}

// Deduplicates FMP calls within the same process lifecycle.
// null means FMP returned nothing for this ticker — don't retry.
// Missing key is NOT cached so it works after a server restart with the key set.
const cache = new Map<string, FmpResult | null>();

console.log('[fmp] env keys available:', Object.keys(process.env).filter(k => k.includes('FMP')))
console.log('[fmp] FMP_API_KEY value:', process.env.FMP_API_KEY ? 'SET (' + process.env.FMP_API_KEY.slice(0,8) + '...)' : 'NOT SET')

export async function fetchEtf(ticker: string): Promise<FmpResult | null> {
  if (cache.has(ticker)) return cache.get(ticker)!;

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    // Don't cache — key may be configured after server start
    return null;
  }

  try {
    const url = `${FMP_BASE}/etf-holdings?symbol=${ticker}&apikey=${apiKey}`
    console.log('[fmp] fetching:', url)
    const res = await fetch(url)
    console.log('[fmp] status:', res.status)
    const text = await res.text()
    console.log('[fmp] body preview:', text.slice(0, 200))
    const data = JSON.parse(text)

    // stable API returns a flat array, not a { holdings: [] } envelope
    const raw = Array.isArray(data) ? data : data?.holdings;
    if (!Array.isArray(raw) || raw.length === 0) {
      cache.set(ticker, null);
      return null;
    }

    const holdings: FmpHolding[] = raw
      .filter((h: { asset: string; weightPercentage: number }) => h.asset && h.weightPercentage > 0)
      .map((h) => ({
        name: h.asset,
        weight: +h.weightPercentage.toFixed(4),
        weightSource: 'actual' as const,
      }))
      .sort((a, b) => b.weight - a.weight);

    const result: FmpResult = { ticker, source: 'fmp-api', holdings };
    cache.set(ticker, result);
    return result;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 403 || err.response?.status === 404)) {
      cache.set(ticker, null);
      return null;
    }
    // Unexpected error — don't cache, allow retry
    throw err;
  }
}
