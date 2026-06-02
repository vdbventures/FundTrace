'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Nav from '../components/Nav';
import { Suspense } from 'react';

/* ─── Sample data ──────────────────────────────────────────────────────────── */

const SAMPLE_FOUND = {
  query: 'NVIDIA',
  totalValue: 4217,
  portfolioValue: 110236,
  fundCount: 2,
  holdings: [
    { fund: 'Fidelity Global Innovators (FID5982)', value: 3084 },
    { fund: 'Sun Life MFS International Value (SIVFF)', value: 1133 },
  ],
};

const SAMPLE_NOT_FOUND = {
  query: 'Tesla',
  similar: [
    { name: 'NVIDIA', value: 4217 },
    { name: 'Amazon', value: 2910 },
  ],
  surprises: [
    { name: 'Bitcoin (via ETF)', sub: 'Inside Fidelity All-in-One Equity', value: 1465 },
    { name: 'TSMC (Taiwan)',      sub: 'Inside Sun Life MFS International Value', value: 988 },
    { name: 'Franco-Nevada',      sub: 'Across 2 different funds', value: 1626 },
  ],
};

const TOP_HOLDINGS = [
  { name: 'Apple Inc.',         sub: 'In 3 funds', value: 6842, pct: 100 },
  { name: 'Microsoft Corp.',    sub: 'In 2 funds', value: 5331, pct: 78  },
  { name: 'NVIDIA Corp.',       sub: 'In 2 funds', value: 4217, pct: 62  },
  { name: 'Royal Bank of Canada', sub: 'In 2 funds', value: 3786, pct: 55 },
  { name: 'Franco-Nevada Corp.', sub: 'In 2 funds · merged', value: 1626, pct: 24 },
];

const FLAGS = [
  { icon: '⚠', label: 'Concentration', value: '11.2%', sub: 'US tech across 3 funds', warn: true },
  { icon: '₵', label: 'Weighted MER',  value: '1.84%', sub: '$2,028 in annual fees',  warn: true },
  { icon: '👁', label: 'Unresolved',   value: '1 fund', sub: 'Manulife · contact advisor', warn: false },
];

/* ─── Format helpers ───────────────────────────────────────────────────────── */
function fmt(n: number) {
  return n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
}

/* ─── Results inner component ──────────────────────────────────────────────── */
function ResultsInner() {
  const params  = useSearchParams();
  const query   = params.get('q') ?? 'NVIDIA';
  const found   = params.get('found') !== 'false';
  const data    = found ? SAMPLE_FOUND : SAMPLE_NOT_FOUND;
  const pctOwned = found ? ((SAMPLE_FOUND.totalValue / 110236) * 100).toFixed(1) : null;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-page)' }}>
      <Nav variant="light" />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 pb-16">

        {/* ── Search header ─────────────────────────────────────────────── */}
        <div
          className="rounded-xl p-4 mb-4"
          style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-[15px]" style={{ color: 'var(--text-primary)' }}>
              FundTrace
            </span>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Portfolio · $110,236 · 4 holdings
            </span>
          </div>
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: 'var(--bg-secondary)' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Do I own</span>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {found ? (data as typeof SAMPLE_FOUND).query : (data as typeof SAMPLE_NOT_FOUND).query}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {['Bitcoin', 'Shopify', 'Loblaws'].map((s) => (
                <Link
                  key={s}
                  href={`/results?q=${s.toLowerCase()}&found=false`}
                  className="text-[11px] hover:underline"
                  style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}
                >
                  {s}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* ── Answer hero ───────────────────────────────────────────────── */}
        {found ? (
          /* YES variant */
          <div
            className="rounded-xl px-6 py-5 mb-4"
            style={{ background: 'var(--teal-bg)' }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--teal-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span className="text-[13px] font-semibold" style={{ color: 'var(--teal-accent)' }}>
                Yes, you own {SAMPLE_FOUND.query}
              </span>
            </div>
            <div className="text-[30px] font-bold mb-1" style={{ color: 'var(--teal-text)' }}>
              {fmt(SAMPLE_FOUND.totalValue)}
            </div>
            <div className="text-[13px]" style={{ color: 'var(--teal-text-mid)' }}>
              {pctOwned}% of your portfolio · held through {SAMPLE_FOUND.fundCount} of your 4 funds
            </div>

            <div
              className="mt-4 pt-4"
              style={{ borderTop: '0.5px solid var(--teal-line)' }}
            >
              {SAMPLE_FOUND.holdings.map((h) => (
                <div key={h.fund} className="flex justify-between items-center py-1">
                  <span className="text-[13px]" style={{ color: 'var(--teal-text)' }}>{h.fund}</span>
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--teal-text)' }}>{fmt(h.value)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* NO variant */
          <>
            <div
              className="rounded-xl px-6 py-5 mb-4"
              style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border-strong)' }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-base" style={{ color: 'var(--text-tertiary)' }}>✕</span>
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  No {SAMPLE_NOT_FOUND.query} in your portfolio
                </span>
              </div>
              <div className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                {SAMPLE_NOT_FOUND.query} doesn't appear in any of your 4 funds
              </div>
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Not held directly, and not inside any fund you own.
              </div>

              <div
                className="mt-4 pt-4 flex flex-wrap items-center gap-2"
                style={{ borderTop: '0.5px solid var(--border)' }}
              >
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  Looking for similar exposure? You hold:
                </span>
                {SAMPLE_NOT_FOUND.similar.map((s) => (
                  <Link
                    key={s.name}
                    href={`/results?q=${s.name.toLowerCase()}&found=true`}
                    className="text-xs px-3 py-1 rounded-lg transition-colors hover:opacity-80"
                    style={{
                      border: '0.5px solid var(--border-strong)',
                      color: 'var(--text-primary)',
                      background: 'transparent',
                      textDecoration: 'none',
                    }}
                  >
                    {s.name}&nbsp;&nbsp;{fmt(s.value)}
                  </Link>
                ))}
              </div>
            </div>

            {/* Surprises panel */}
            <div
              className="rounded-xl px-6 py-5 mb-4"
              style={{ background: 'var(--teal-bg)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span>💡</span>
                <span className="text-[13px] font-semibold" style={{ color: 'var(--teal-accent)' }}>
                  But here's what might surprise you
                </span>
              </div>
              <p className="text-[14px] mb-3" style={{ color: 'var(--teal-text)' }}>
                3 names you probably didn't realise you own:
              </p>
              {SAMPLE_NOT_FOUND.surprises.map((s, i) => (
                <div
                  key={s.name}
                  className="flex justify-between items-center py-2"
                  style={{
                    borderBottom: i < SAMPLE_NOT_FOUND.surprises.length - 1
                      ? '0.5px solid var(--teal-line)'
                      : 'none',
                  }}
                >
                  <div>
                    <div className="text-[14px]" style={{ color: 'var(--teal-text)' }}>{s.name}</div>
                    <div className="text-[12px]" style={{ color: 'var(--teal-text-mid)' }}>{s.sub}</div>
                  </div>
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--teal-text)' }}>
                    {fmt(s.value)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Top holdings ─────────────────────────────────────────────── */}
        <div
          className="rounded-xl p-5 mb-4"
          style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        >
          <div className="flex items-baseline justify-between mb-3">
            <span className="font-semibold text-[16px]" style={{ color: 'var(--text-primary)' }}>
              Your top holdings
            </span>
            <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              Showing {TOP_HOLDINGS.length} of 47 unique stocks
            </span>
          </div>

          {TOP_HOLDINGS.map((h, i) => {
            const blurred = i >= 3;
            return (
              <div
                key={h.name}
                className={`flex justify-between items-center py-2 ${blurred ? (i === 3 ? 'blurred' : 'blurred-2') : ''}`}
                style={{
                  borderBottom: i < TOP_HOLDINGS.length - 1 ? '0.5px solid var(--border)' : 'none',
                }}
              >
                <div>
                  <div className="text-[14px]" style={{ color: 'var(--text-primary)' }}>{h.name}</div>
                  {!blurred && (
                    <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{h.sub}</div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {!blurred && (
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${h.pct}%` }} />
                    </div>
                  )}
                  <span className="text-[14px] font-semibold" style={{ minWidth: 60, textAlign: 'right', color: 'var(--text-primary)' }}>
                    {blurred ? '$•••••' : fmt(h.value)}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Pro gate */}
          <div
            className="mt-4 flex items-center justify-between rounded-lg px-3 py-3"
            style={{ background: 'var(--bg-secondary)' }}
          >
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                See all 47 holdings
              </div>
              <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Pro · $9/month</div>
            </div>
            <button
              className="text-[13px] font-medium px-4 py-2 rounded-full transition-opacity hover:opacity-80"
              style={{
                background: 'var(--navy-900)',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Upgrade →
            </button>
          </div>
        </div>

        {/* ── Flags row ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {FLAGS.map((f) => (
            <div
              key={f.label}
              className="rounded-xl p-3"
              style={{
                background: f.warn ? 'var(--amber-bg)' : 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[13px]">{f.icon}</span>
                <span
                  className="text-[11px] font-semibold"
                  style={{ color: f.warn ? 'var(--amber-accent)' : 'var(--text-secondary)' }}
                >
                  {f.label}
                </span>
              </div>
              <div
                className="text-[17px] font-bold"
                style={{ color: f.warn ? 'var(--amber-text)' : 'var(--text-primary)' }}
              >
                {f.value}
              </div>
              <div
                className="text-[11px] mt-0.5"
                style={{ color: f.warn ? 'var(--amber-text-mid)' : 'var(--text-secondary)' }}
              >
                {f.sub}
              </div>
            </div>
          ))}
        </div>

        {/* ── Advisor CTA ───────────────────────────────────────────────── */}
        <div
          className="rounded-xl p-5 flex items-center justify-between gap-4"
          style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        >
          <div>
            <div className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              Want a second opinion on this portfolio?
            </div>
            <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Fee-only advisors who specialise in look-through analysis
            </div>
          </div>
          <button
            className="text-[13px] font-medium px-4 py-2 rounded-full whitespace-nowrap transition-opacity hover:opacity-80"
            style={{
              background: 'var(--navy-900)',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            See advisors →
          </button>
        </div>

      </main>
    </div>
  );
}

/* ─── Page wrapper with Suspense (required for useSearchParams in App Router) ─ */
export default function ResultsPage() {
  return (
    <Suspense fallback={<div style={{ background: 'var(--bg-page)', minHeight: '100vh' }} />}>
      <ResultsInner />
    </Suspense>
  );
}
