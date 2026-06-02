'use client';

import Link from 'next/link';
import { useState, DragEvent } from 'react';

export default function ImportCard() {
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);

  const handleDrag = (e: DragEvent) => {
    e.preventDefault();
    setDragging(e.type === 'dragover');
  };

  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: '#FFFFFF',
        boxShadow: '0 24px 80px rgba(0,0,0,0.35), 0 4px 16px rgba(0,0,0,0.15)',
      }}
    >
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Import your portfolio
        </span>
        <span
          className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
          style={{
            background: 'var(--blue-100)',
            color: 'var(--blue-600)',
            letterSpacing: '0.04em',
          }}
        >
          INSTANT X-RAY
        </span>
      </div>

      <p className="text-[13px] leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
        Drop a brokerage statement, screenshot, or paste your portfolio.
        We read PDFs, images, CSV, or plain English like{' '}
        <span style={{ color: 'var(--blue-600)', fontWeight: 500 }}>
          "60% VOO, 30% QQQ, 10% cash"
        </span>
        . Nothing is stored.
      </p>

      {/* Drop zone */}
      <div
        className={`drop-zone flex flex-col items-center justify-center gap-2 py-8 mb-4 cursor-pointer${dragging ? ' drag-over' : ''}`}
        style={{ background: dragging ? 'var(--blue-50)' : 'var(--blue-50)' }}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={(e) => { e.preventDefault(); setDragging(false); }}
        onClick={() => document.getElementById('ft-file-input')?.click()}
      >
        <input id="ft-file-input" type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.csv,.txt" />
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ background: 'var(--navy-900)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Drop a file or click to browse
        </span>
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          PDF · PNG · JPG · CSV · TXT · UP TO 10MB
        </span>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>OR PASTE</span>
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
      </div>

      {/* Textarea */}
      <textarea
        rows={3}
        placeholder='e.g. "I have $200k: 40% VOO, 30% QQQ, 20% BND, 10% cash"'
        className="w-full resize-none rounded-lg px-3 py-2.5 text-[13px] outline-none"
        style={{
          background: 'var(--bg-secondary)',
          border: focused ? '0.5px solid var(--blue-500)' : '0.5px solid var(--border)',
          boxShadow: focused ? '0 0 0 3px rgba(55,138,221,0.12)' : 'none',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-geist-sans)',
          lineHeight: '1.5',
          marginBottom: '12px',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />

      {/* Submit */}
      <Link
        href="/results?q=nvidia&found=true"
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-full text-sm font-semibold transition-opacity hover:opacity-90"
        style={{ background: 'var(--navy-900)', color: 'white', textDecoration: 'none' }}
      >
        Analyze portfolio →
      </Link>

      <p className="text-center text-[11px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
        ✦ Powered by AI — review before anything lands in your report
      </p>
    </div>
  );
}
