import Link from 'next/link';

interface NavProps {
  variant?: 'dark' | 'light';
}

export default function Nav({ variant = 'dark' }: NavProps) {
  const isDark = variant === 'dark';

  return (
    <nav
      className="w-full flex items-center justify-between px-6 py-4"
      style={{
        background: isDark ? 'transparent' : 'white',
        borderBottom: isDark ? 'none' : '0.5px solid var(--border)',
      }}
    >
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 no-underline">
        <div
          className="flex items-center justify-center rounded-lg text-white font-bold text-sm"
          style={{
            width: 30,
            height: 30,
            background: isDark ? '#1A3050' : 'var(--navy-900)',
            letterSpacing: '-0.02em',
          }}
        >
          F
        </div>
        <span
          className="font-semibold text-[15px]"
          style={{ color: isDark ? '#FFFFFF' : 'var(--text-primary)' }}
        >
          Fund Trace
        </span>
      </Link>

      {/* Links */}
      <div className="hidden md:flex items-center gap-7">
        {['Product', 'How it works', 'FAQ'].map((item) => (
          <a
            key={item}
            href="#"
            className="text-sm transition-opacity hover:opacity-100"
            style={{
              color: isDark ? 'rgba(255,255,255,0.65)' : 'var(--text-secondary)',
              opacity: 0.85,
              textDecoration: 'none',
            }}
          >
            {item}
          </a>
        ))}
      </div>

      {/* CTA */}
      <a
        href="#"
        className="text-sm font-medium px-4 py-2 rounded-full transition-opacity hover:opacity-90"
        style={{
          background: isDark ? 'white' : 'var(--navy-900)',
          color: isDark ? 'var(--navy-900)' : 'white',
          textDecoration: 'none',
        }}
      >
        Get early access
      </a>
    </nav>
  );
}
