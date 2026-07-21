import type { ReactNode } from 'react';

/**
 * Shared marker glyphs, keyed by MarkerStyle.icon — used by both the web
 * Marker and the mobile map so the two views render identical icons.
 * `currentColor` lets the marker's `color` (fg) drive the stroke.
 */
export const MARKER_ICONS: Record<string, ReactNode> = {
  workstation: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  locker: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  parking: <span style={{ font: '700 11px/1 var(--font-sans)' }}>P</span>,
  asset: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  ),
  fire: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c4 0 7-2.7 7-7 0-3-2-5.5-3.5-7C14 6 13 4 13 2c-3 2-4.5 4.5-4.5 7C7 8 6 7 5.5 5.5 4.5 8 5 10.5 5 12c0 6 3 10 7 10z" />
    </svg>
  ),
  stairs: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h4v-4h4v-4h4V9h4V5h2" />
    </svg>
  ),
  elevator: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 12l2.5-3 2.5 3M9 15.5l2.5 3 2.5-3" />
    </svg>
  ),
  restroom: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="2" />
      <path d="M8 9v6m-2.5 6v-4h5v4M6 9h4" />
      <circle cx="16.5" cy="5" r="2" />
      <path d="M16.5 9c-1.8 0-2.5 1.4-2.8 3l-.7 3h7l-.7-3c-.3-1.6-1-3-2.8-3zM15 18v3m3-3v3" />
    </svg>
  ),
};
