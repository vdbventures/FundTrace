import axios from 'axios';

const FUND_NAMES: Record<string, string> = {
  SLMCF: 'Sun Life Granite Conservative Portfolio',
  SMIPF: 'Sun Life Granite Income Portfolio',
  SMEIA: 'Sun Life Granite Enhanced Income Portfolio',
  SLMGF: 'Sun Life Granite Growth Portfolio',
  SIVFF: 'Sun Life MFS International Value Fund',
  SLVGF: 'SLGI MFS Blended Research Low Volatility Global Fund',
  SLVIF: 'SLGI MFS Blended Research Low Volatility International Fund',
  SMGF: 'Sun Life MFS Global Growth Fund',
  SMVF: 'Sun Life MFS Global Value Fund',
};

const GRAPHQL_URL =
  'https://funds.sunlifeglobalinvestments.com/api/graphql/mutual-funds-production';

const HOLDINGS_QUERY = `
query fundHoldings($locale: String, $entityId: String) {
  webProfiles(entityId: $entityId, locale: $locale) {
    webProfileSalesOptions(take: 1, sortDirection: "D") {
      salesOption {
        fund {
          portfolios {
            effectiveDate
            top10Holdings {
              holding
              allocation
            }
            topEquityHoldings {
              holding
              allocation
            }
          }
        }
      }
    }
  }
}
`;

export interface SlgiHolding {
  name: string;
  weight: number;
}

export interface SlgiFundResult {
  fundCode: string;
  fundName: string;
  source: 'slgi-graphql';
  asOf: string | null;
  isFundOfFunds: boolean;
  dataQuality: string;
  scrapedAt: string;
  holdings: SlgiHolding[];
}

async function gql(variables: Record<string, string>): Promise<unknown> {
  const res = await axios.post(
    GRAPHQL_URL,
    { query: HOLDINGS_QUERY, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://funds.sunlifeglobalinvestments.com',
        Referer: 'https://funds.sunlifeglobalinvestments.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    }
  );
  return res.data;
}

function normalise(raw: Array<{ holding?: string; allocation?: string }>): SlgiHolding[] {
  if (!raw?.length) return [];
  return raw
    .map((h) => ({
      name: (h.holding || '').trim(),
      weight: Math.round(parseFloat(h.allocation || '0') * 10000) / 100,
    }))
    .filter((h) => h.name && h.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

export async function fetchFund(fundCode: string): Promise<SlgiFundResult | null> {
  const entityId = `${fundCode}-CAD`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await gql({ locale: 'en-US', entityId })) as any;

  if (result.errors) {
    const fatal = result.errors.filter(
      (e: { message: string }) => !e.message.includes('Cannot query field')
    );
    if (fatal.length) return null;
  }

  const fund =
    result.data?.webProfiles?.[0]?.webProfileSalesOptions?.[0]?.salesOption?.fund;

  if (!fund?.portfolios?.length) return null;

  const portfolio = fund.portfolios[fund.portfolios.length - 1];

  let holdings = normalise(portfolio.top10Holdings);
  if (!holdings.length) holdings = normalise(portfolio.topEquityHoldings);
  if (!holdings.length) return null;

  const isFundOfFunds = holdings.some((h) =>
    /\b(fund|portfolio|bond|income|equity|ETF|fixed|balanced)\b/i.test(h.name)
  );

  return {
    fundCode,
    fundName: FUND_NAMES[fundCode] || fundCode,
    source: 'slgi-graphql',
    asOf: portfolio.effectiveDate ?? null,
    isFundOfFunds,
    dataQuality: holdings.length >= 10 ? 'top10' : `partial:${holdings.length}`,
    scrapedAt: new Date().toISOString(),
    holdings,
  };
}
