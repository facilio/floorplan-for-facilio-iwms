import { useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileDatePicker.module.css';

const DAY_ABBR = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/** Month grid for a given year/month (6 rows, leading/trailing days from siblings). */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/**
 * Design-system month calendar sheet — replaces the native date input on
 * mobile so the date picker matches the app's look everywhere.
 */
export function MobileDatePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(onClose, open);
  const selected = state.date;
  const [cursor, setCursor] = useState(() => {
    const d = parseISO(state.date);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  if (!open) return null;

  const todayIso = toISO(new Date());
  const days = monthGrid(cursor.year, cursor.month);

  function step(delta: number) {
    setCursor((c) => {
      const m = c.month + delta;
      return { year: c.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <div className={styles.head}>
          <button className={styles.navBtn} onClick={() => step(-1)} aria-label="Previous month">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className={styles.monthLabel}>
            {MONTHS[cursor.month]} {cursor.year}
          </span>
          <button className={styles.navBtn} onClick={() => step(1)} aria-label="Next month">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
        <div className={styles.weekRow}>
          {DAY_ABBR.map((d, i) => (
            <span key={i} className={styles.weekCell}>{d}</span>
          ))}
        </div>
        <div className={styles.grid}>
          {days.map((d) => {
            const iso = toISO(d);
            const inMonth = d.getMonth() === cursor.month;
            const isSel = iso === selected;
            const isToday = iso === todayIso;
            return (
              <button
                key={iso}
                className={[styles.day, inMonth ? '' : styles.dayDim, isSel ? styles.daySel : '', isToday && !isSel ? styles.dayToday : ''].join(' ')}
                onClick={() => {
                  actions.setDate(iso);
                  onClose();
                }}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
        <button className={styles.todayBtn} onClick={() => { actions.setDate(todayIso); onClose(); }}>
          Jump to today
        </button>
      </div>
    </>
  );
}
