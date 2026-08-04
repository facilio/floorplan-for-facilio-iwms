import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { orgNow } from '../../lib/orgTime';

/**
 * App-wide DATE PICKER (replaces every native `<input type="date">` on request): a button
 * showing the friendly date + a popup mini-calendar. min/max days render disabled, so the
 * booking window (e.g. "today .. one week") is VISIBLE instead of silently rejected — the
 * browser-default picker communicated none of that.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  fullWidth,
  'aria-label': ariaLabel,
}: {
  /** ISO yyyy-mm-dd */
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  fullWidth?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISO(value) ?? new Date();
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // FLOATING placement (portal + fixed): inside a modal/panel an absolutely-positioned popup
  // pushed the form down / clipped against the scroll edge — this overlays instead, flipping
  // above the trigger when the viewport bottom is close.
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const POP_H = 330;
      const up = window.innerHeight - r.bottom < POP_H && r.top > POP_H;
      setPos({ left: Math.min(Math.max(r.left, 8), window.innerWidth - 260), top: up ? r.top - 6 : r.bottom + 6, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Re-anchor the visible month whenever the popup opens on a new value.
  useEffect(() => {
    if (open) {
      const d = parseISO(value) ?? new Date();
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const todayIso = orgNow().dateISO; // the ORG's today, not the browser's
  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const first = new Date(viewYear, viewMonth, 1);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => toISO(new Date(viewYear, viewMonth, i + 1))),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // Whole-month navigation clamps: hide arrows that can only reach fully-disabled months.
  const prevOk = !min || toISO(new Date(viewYear, viewMonth, 0)) >= min;
  const nextOk = !max || toISO(new Date(viewYear, viewMonth + 1, 1)) <= max;

  const display = parseISO(value)
    ? parseISO(value)!.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : 'Pick a date';

  return (
    <div ref={rootRef} style={{ position: 'relative', ...(fullWidth ? { width: '100%' } : {}) }}>
      <button
        type="button"
        aria-label={ariaLabel ?? 'Date'}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          boxSizing: 'border-box',
          padding: '9px 11px',
          borderRadius: 8,
          border: `1.5px solid ${open ? 'var(--blue-500)' : 'var(--ink-200)'}`,
          background: '#fff',
          font: '500 13.5px var(--font-sans)',
          color: 'var(--ink-900)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{display}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            zIndex: 320, // above the Modal overlay (200) — the popup opened BEHIND it and read as a dead button
            top: pos.top,
            left: pos.left,
            transform: pos.up ? 'translateY(-100%)' : undefined,
            minWidth: 252,
            background: '#fff',
            border: '1px solid var(--ink-200)',
            borderRadius: 10,
            boxShadow: '0 10px 28px rgba(28,39,51,0.16)',
            padding: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" disabled={!prevOk} onClick={() => setViewMonth((m) => (m === 0 ? (setViewYear((y) => y - 1), 11) : m - 1))} style={navBtn(!prevOk)} aria-label="Previous month">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink-900)' }}>{monthLabel}</span>
            <button type="button" disabled={!nextOk} onClick={() => setViewMonth((m) => (m === 11 ? (setViewYear((y) => y + 1), 0) : m + 1))} style={navBtn(!nextOk)} aria-label="Next month">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2, justifyContent: 'center' }}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} style={{ textAlign: 'center', font: '600 10.5px var(--font-sans)', color: 'var(--ink-400)', padding: '2px 0' }}>
                {d}
              </div>
            ))}
            {cells.map((iso, i) => {
              if (!iso) return <div key={i} />;
              const ok = inRange(iso);
              const isSel = iso === value;
              const isToday = iso === todayIso;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!ok}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  style={{
                    width: 32,
                    height: 30,
                    borderRadius: 7,
                    border: isToday && !isSel ? '1.5px solid var(--blue-300)' : '1px solid transparent',
                    background: isSel ? 'var(--blue-500)' : 'transparent',
                    color: isSel ? '#fff' : ok ? 'var(--ink-800)' : 'var(--ink-300)',
                    font: `${isSel ? 600 : 500} 12.5px var(--font-sans)`,
                    cursor: ok ? 'pointer' : 'not-allowed',
                  }}
                >
                  {Number(iso.slice(8))}
                </button>
              );
            })}
          </div>
          {(min || max) && (
            <div style={{ marginTop: 8, font: '500 11px var(--font-sans)', color: 'var(--ink-500)', textAlign: 'center' }}>
              {min === max ? 'Today only' : `Bookable ${min ? fmtShort(min) : '…'} – ${max ? fmtShort(max) : '…'}`}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

function navBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: 6,
    border: '1px solid var(--ink-200)',
    background: '#fff',
    color: disabled ? 'var(--ink-300)' : 'var(--ink-700)',
    cursor: disabled ? 'default' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function fmtShort(iso: string): string {
  const d = parseISO(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : iso;
}
