/**
 * SLGI Holdings Scraper v8
 * ─────────────────────────────────────────────────────────────────────────────
 * Changes from v7:
 *   - Fixed Granite Conservative code: SLCMF → SLMCF (transposed letters)
 *   - All 5 LIRA funds now confirmed working
 *   - YOUR_LIRA portfolio updated with correct API codes
 *
 * Confirmed SLGI API codes (from /mp/[CODE]/ in sunlifeglobalinvestments.com URLs):
 *   SLMCF  Sun Life Granite Conservative Portfolio   (ETFInsight: FCGC)
 *   SMIPF  Sun Life Granite Income Portfolio          (ETFInsight: FINN)
 *   SMEIA  Sun Life Granite Enhanced Income Portfolio (ETFInsight: FEQT)
 *   SLMGF  Sun Life Granite Growth Portfolio          (ETFInsight: FGEP)
 *   SIVFF  Sun Life MFS International Value Fund      (ETFInsight: SIVFF)
 *
 * Usage:
 *   node slgi-v8.js              ← fetches all 5 LIRA funds (default)
 *   node slgi-v8.js SIVFF        ← single fund
 *   node slgi-v8.js --all        ← all funds in registry
 *
 * Requires: npm install axios
 */

const axios = require("axios");
const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// Fund registry — SLGI API codes
// ─────────────────────────────────────────────────────────────────────────────
const FUND_CODES = {
  // ── Your LIRA (all confirmed working) ─────────────────────────────────────
  SLMCF: "Sun Life Granite Conservative Portfolio",
  SMIPF: "Sun Life Granite Income Portfolio",
  SMEIA: "Sun Life Granite Enhanced Income Portfolio",
  SLMGF: "Sun Life Granite Growth Portfolio",
  SIVFF: "Sun Life MFS International Value Fund",

  // ── Other SLGI funds ───────────────────────────────────────────────────────
  SLVGF: "SLGI MFS Blended Research Low Vol Global Fund",
  SLVIF: "SLGI MFS Blended Research Low Vol International Fund",
  SMGF:  "Sun Life MFS Global Growth Fund",
  SMVF:  "Sun Life MFS Global Value Fund",
};

// ─────────────────────────────────────────────────────────────────────────────
// Your LIRA portfolio
// Update dollar values whenever your holdings change
// ─────────────────────────────────────────────────────────────────────────────
const YOUR_LIRA = [
  { fundCode: "SLMCF", value: 54248,  label: "Granite Conservative (FCGC)" },
  { fundCode: "SMIPF", value: 53342,  label: "Granite Income (FINN)" },
  { fundCode: "SMEIA", value: 62207,  label: "Granite Enhanced Income (FEQT)" },
  { fundCode: "SLMGF", value: 13373,  label: "Granite Growth (FGEP)" },
  { fundCode: "SIVFF", value: 30988,  label: "MFS International Value" },
];

const GRAPHQL_URL =
  "https://funds.sunlifeglobalinvestments.com/api/graphql/mutual-funds-production";

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
              effectiveDate
            }
            topEquityHoldings {
              holding
              allocation
              effectiveDate
            }
            sectorAllocations {
              name
              value
              percentage
            }
            geographicAllocations {
              name
              value
              percentage
            }
          }
        }
      }
    }
  }
}
`;

async function graphql(query, variables = {}) {
  const res = await axios.post(
    GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://funds.sunlifeglobalinvestments.com",
        Referer: "https://funds.sunlifeglobalinvestments.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 15000,
    }
  );
  return res.data;
}

function normaliseHoldings(rawArray) {
  if (!rawArray?.length) return [];
  return rawArray
    .map((h) => ({
      name: (h.holding || "").trim(),
      weight: Math.round(parseFloat(h.allocation || 0) * 10000) / 100,
    }))
    .filter((h) => h.name && h.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

async function fetchFund(fundCode) {
  const entityId = `${fundCode}-CAD`;
  console.log(`\nFetching ${fundCode} (${entityId})...`);

  const result = await graphql(HOLDINGS_QUERY, { locale: "en-US", entityId });
  fs.writeFileSync(`./raw-${fundCode}.json`, JSON.stringify(result, null, 2));

  if (result.errors) {
    const fatal = result.errors.filter(
      (e) => !e.message.includes("Cannot query field")
    );
    if (fatal.length) {
      console.error(`  ✗ Fatal errors:`, fatal.map((e) => e.message).join(", "));
      return null;
    }
  }

  const fund = result.data
    ?.webProfiles?.[0]
    ?.webProfileSalesOptions?.[0]
    ?.salesOption?.fund;

  if (!fund) {
    console.error(`  ✗ No fund data — check raw-${fundCode}.json`);
    return null;
  }

  const portfolios = fund.portfolios;
  if (!portfolios?.length) {
    console.error(`  ✗ No portfolios array`);
    return null;
  }

  // Most recent snapshot = last item
  const portfolio = portfolios[portfolios.length - 1];
  const effectiveDate = portfolio.effectiveDate;

  console.log(`  Snapshots: ${portfolios.length} (${portfolios[0].effectiveDate} → ${effectiveDate})`);

  let holdings = normaliseHoldings(portfolio.top10Holdings);
  let holdingsSource = "top10Holdings";

  if (!holdings.length) {
    holdings = normaliseHoldings(portfolio.topEquityHoldings);
    holdingsSource = "topEquityHoldings";
  }

  if (!holdings.length) {
    console.error(`  ✗ No holdings found`);
    return null;
  }

  const isFundOfFunds = holdings.some((h) =>
    /\b(fund|portfolio|bond|income|equity|ETF|fixed|balanced)\b/i.test(h.name)
  );

  const final = {
    fundCode,
    fundName: FUND_CODES[fundCode] || fundCode,
    source: `slgi-graphql:${holdingsSource}`,
    entityId,
    asOf: effectiveDate,
    isFundOfFunds,
    dataQuality: holdings.length >= 10 ? "top10" : `partial:${holdings.length}`,
    scrapedAt: new Date().toISOString(),
    holdings,
    sectorAllocations: (portfolio.sectorAllocations || [])
      .map((s) => ({ name: s.name, pct: parseFloat(s.percentage || s.value || 0) }))
      .filter((s) => s.name && s.pct > 0)
      .sort((a, b) => b.pct - a.pct),
    geographicAllocations: (portfolio.geographicAllocations || [])
      .map((g) => ({ name: g.name, pct: parseFloat(g.percentage || g.value || 0) }))
      .filter((g) => g.name && g.pct > 0)
      .sort((a, b) => b.pct - a.pct),
  };

  console.log(`  ✓ ${final.fundName}`);
  console.log(`    As of:         ${effectiveDate}`);
  console.log(`    Fund-of-funds: ${isFundOfFunds ? "Yes" : "No"}`);
  console.log(`    Holdings:      ${holdings.length}\n`);
  holdings.forEach((h) =>
    console.log(`      ${h.name.padEnd(55)} ${h.weight.toFixed(1)}%`)
  );

  return final;
}

function doIOwn(query, portfolio, results) {
  const q = query.toLowerCase().trim();
  const totalValue = portfolio.reduce((s, p) => s + p.value, 0);
  const matches = [];
  const fundOfFundsNames = [];
  const unresolvedCodes = [];

  for (const pos of portfolio) {
    const fund = results[pos.fundCode];
    if (!fund) {
      unresolvedCodes.push(pos.fundCode);
      continue;
    }
    if (fund.isFundOfFunds) fundOfFundsNames.push(fund.fundName);

    const posWeight = pos.value / totalValue;
    for (const h of fund.holdings) {
      if (h.name.toLowerCase().includes(q)) {
        const eff = (posWeight * h.weight) / 100;
        matches.push({
          stock: h.name,
          fund: fund.fundName,
          fundCode: pos.fundCode,
          isFundOfFunds: fund.isFundOfFunds,
          weightInFund: h.weight,
          portfolioExposurePct: +(eff * 100).toFixed(2),
          dollarExposure: +(eff * totalValue).toFixed(2),
        });
      }
    }
  }

  const notes = [];
  if (unresolvedCodes.length)
    notes.push(`${unresolvedCodes.join(", ")} could not be resolved`);
  if (fundOfFundsNames.length)
    notes.push(`${fundOfFundsNames.length} fund(s) are fund-of-funds — underlying fund names searched, not individual stocks`);

  const caveat = notes.length ? ` [Note: ${notes.join("; ")}]` : "";

  if (!matches.length) {
    return {
      query, found: false,
      message: `"${query}" not found in top-10 holdings of any resolved fund.${caveat}`,
    };
  }

  const totalPct = +matches.reduce((s, m) => s + m.portfolioExposurePct, 0).toFixed(2);
  const totalDollar = +matches.reduce((s, m) => s + m.dollarExposure, 0).toFixed(2);
  const fundList = [...new Set(matches.map((m) => m.fund))].join(", ");

  return {
    query, found: true,
    totalPortfolioExposurePct: totalPct,
    totalDollarExposure: totalDollar,
    foundIn: matches,
    message:
      `Yes — ~${totalPct}% exposure to ${matches[0].stock} ` +
      `(~$${totalDollar.toLocaleString("en-CA")} of $${totalValue.toLocaleString("en-CA")}) ` +
      `via: ${fundList}.${caveat}`,
  };
}

async function main() {
  const args = process.argv.slice(2);

  const codesToFetch = args.includes("--all")
    ? Object.keys(FUND_CODES)
    : args.length > 0
    ? args.map((a) => a.toUpperCase())
    : YOUR_LIRA.map((p) => p.fundCode);

  console.log("═══════════════════════════════════════════════════════");
  console.log(" SLGI Holdings Scraper v8");
  console.log(" Sun Life Global Investments — GraphQL API");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`\nFetching: ${codesToFetch.join(", ")}\n`);

  const results = {};
  const failed = [];

  for (let i = 0; i < codesToFetch.length; i++) {
    const code = codesToFetch[i];
    try {
      const result = await fetchFund(code);
      if (result) results[code] = result;
      else failed.push(code);
    } catch (err) {
      console.error(`  ✗ ${code}: ${err.message}`);
      failed.push(code);
    }
    if (i < codesToFetch.length - 1) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // ── Portfolio queries ──────────────────────────────────────────────────────
  if (Object.keys(results).length > 0) {
    const totalValue = YOUR_LIRA.reduce((s, p) => s + p.value, 0);

    console.log("\n═══════════════════════════════════════════════════════");
    console.log(" PORTFOLIO QUERIES — Your LIRA");
    console.log(`  $${totalValue.toLocaleString("en-CA")} across ${YOUR_LIRA.length} funds`);
    console.log("═══════════════════════════════════════════════════════");

    // Show portfolio breakdown first
    console.log("\n  Holdings:");
    YOUR_LIRA.forEach((p) => {
      const fund = results[p.fundCode];
      const status = fund ? "✓" : "✗";
      const fof = fund?.isFundOfFunds ? " [fund-of-funds]" : "";
      console.log(`  ${status} ${p.label.padEnd(45)} $${p.value.toLocaleString("en-CA")}${fof}`);
    });

    const queries = [
      "NVIDIA",
      "Taiwan Semiconductor",
      "Apple",
      "Microsoft",
      "Franco-Nevada",
      "iShares",
      "Shopify",
      "Amazon",
    ];

    console.log("\n  Stock look-through:");
    queries.forEach((q) => {
      const r = doIOwn(q, YOUR_LIRA, results);
      console.log(`\n  ${r.found ? "✓" : "✗"} ${r.message}`);
    });
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  fs.writeFileSync(
    "./slgi-holdings.json",
    JSON.stringify(
      {
        version: "v8",
        scrapedAt: new Date().toISOString(),
        fundsScraped: Object.keys(results).length,
        fundsFailed: failed,
        yourPortfolio: YOUR_LIRA,
        results,
      },
      null,
      2
    )
  );

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`Scraped:  ${Object.keys(results).length} / ${codesToFetch.length} funds`);
  if (failed.length) {
    console.log(`Failed:   ${failed.join(", ")}`);
  }
  console.log("\nOutput:");
  console.log("  slgi-holdings.json   ← clean structured results");
  console.log("  raw-[CODE].json      ← full API response per fund");
  console.log("\nNext steps:");
  console.log("  - Add Manulife funds using same DevTools technique");
  console.log("  - Build fund-of-funds look-through for Granite Portfolios");
  console.log("  - Integrate into Next.js app as the Canadian data layer");
}

main().catch((e) => {
  console.error("\nFatal:", e.message);
  process.exit(1);
});
