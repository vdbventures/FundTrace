import Link from 'next/link';
import Nav from './components/Nav';
import AnimatedWord from './components/AnimatedWord';
import ImportCard from './components/ImportCard';

export default function HomePage() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--navy-900)' }}
    >
      <Nav variant="dark" />

      {/* Hero */}
      <main className="flex-1 flex items-center">
        <div className="w-full max-w-7xl mx-auto px-6 py-16 flex flex-col lg:flex-row items-center gap-16 lg:gap-8">

          {/* ── Left: copy ─────────────────────────────────────────────────── */}
          <div className="flex-1 max-w-xl">
            {/* Badge */}
            <div
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium mb-8"
              style={{
                background: 'rgba(91,159,232,0.12)',
                color: '#5B9FE8',
                border: '0.5px solid rgba(91,159,232,0.25)',
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: '#5B9FE8' }}
              />
              Now in private preview
            </div>

            {/* Headline */}
            <h1
              className="text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight mb-6"
              style={{ color: '#FFFFFF' }}
            >
              Do I actually own{' '}
              <AnimatedWord />
              <span className="cursor" />?
            </h1>

            {/* Body */}
            <p
              className="text-lg leading-relaxed mb-10"
              style={{ color: 'rgba(255,255,255,0.55)' }}
            >
              Fund Trace x-rays your mutual funds and ETFs and tells you the
              real stocks you hold — and how much of each one you actually own.
            </p>

            {/* CTAs */}
            <div className="flex items-center flex-wrap gap-4 mb-14">
              <a
                href="#"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full font-semibold text-sm transition-all hover:opacity-90"
                style={{ background: '#FFFFFF', color: 'var(--navy-900)' }}
              >
                Get early access
              </a>
              <Link
                href="/results?q=nvidia&found=true"
                className="text-sm font-medium transition-opacity hover:opacity-100"
                style={{ color: 'rgba(255,255,255,0.55)', textDecoration: 'none' }}
              >
                See sample report →
              </Link>
            </div>

            {/* Stats */}
            <div
              className="flex flex-wrap gap-8 pt-8"
              style={{ borderTop: '0.5px solid rgba(255,255,255,0.10)' }}
            >
              {[
                { value: '10,000+', label: 'Funds tracked' },
                { value: 'Daily',   label: 'Holdings refresh' },
                { value: 'Read-only', label: 'No brokerage login' },
              ].map(({ value, label }) => (
                <div key={label}>
                  <div
                    className="text-base font-semibold"
                    style={{ color: '#FFFFFF' }}
                  >
                    {value}
                  </div>
                  <div
                    className="text-xs mt-0.5"
                    style={{ color: 'rgba(255,255,255,0.40)' }}
                  >
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Right: Import card ──────────────────────────────────────────── */}
          <div className="w-full max-w-md flex-shrink-0">
            <ImportCard />
          </div>

        </div>
      </main>
    </div>
  );
}
