import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';

const geist = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'FundTrace — Do you actually own what you think you own?',
  description:
    'FundTrace x-rays your mutual funds and ETFs and tells you the real stocks you hold — and how much of each one you actually own.',
  openGraph: {
    title: 'FundTrace',
    description: 'X-ray your mutual funds. See the real stocks inside.',
    url: 'https://fundtrace.ca',
    siteName: 'FundTrace',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-full flex flex-col antialiased">{children}</body>
    </html>
  );
}
