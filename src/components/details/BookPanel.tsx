import { useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, conflictsFor, employeeName, isBookable, unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { Select } from '../primitives/Select';
import { Button } from '../primitives/Button';
import { SkeletonRows } from '../primitives/Skeleton';
import card from './Card.module.css';
import styles from './BookPanel.module.css';

const TIME_OPTIONS = Array.from({ length: (1200 - 420) / 30 + 1 }, (_, i) => 420 + i * 30).map((m) => ({ value: String(m), label: fmtTime(m) }));

const WIN_S = 420;
const WIN_E = 1200;
const PXH = 28;

export function BookPanel() {
  const { state, actions } = useFloorplan();
  const sel = unitById(state, state.selected);
  const bookable = state.units.filter(isBookable);
  const bookedIds = bookedUnitIds(state);
  const availCount = bookable.filter((u) => !bookedIds.has(u.id)).length;

  return (
    <div className={styles.stack}>
      <div className={card.card}>
        <div className={card.cardHead}>
          <h3 className={card.cardTitle}>Time window</h3>
        </div>
        <div className={card.cardBody}>
          <label className={card.label}>Date</label>
          <input className={card.input} type="date" value={state.date} onChange={(e) => actions.setDate(e.target.value)} />
          <div className={styles.timeRow}>
            <div style={{ flex: 1 }}>
              <label className={card.label}>Start</label>
              <Select
                value={String(state.start)}
                options={TIME_OPTIONS}
                onChange={(v) => actions.setTimeRange(Number(v), Math.max(Number(v) + 15, state.end))}
                fullWidth
                aria-label="Start time"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className={card.label}>End</label>
              <Select
                value={String(state.end)}
                options={TIME_OPTIONS}
                onChange={(v) => actions.setTimeRange(Math.min(state.start, Number(v) - 15), Number(v))}
                fullWidth
                aria-label="End time"
              />
            </div>
          </div>
          <div className={styles.countRow}>
            <span className={styles.countPill} style={{ background: 'var(--success-050)', color: 'var(--success-700)' }}>
              {availCount} available
            </span>
            <span className={styles.countPill} style={{ background: 'var(--danger-050)', color: 'var(--danger-700)' }}>
              {bookable.length - availCount} booked
            </span>
          </div>
        </div>
      </div>

      {sel && isBookable(sel) && (
        <div className={card.card}>
          <div className={card.cardHead} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 className={card.cardTitle}>{sel.label}</h3>
            <div className={styles.viewToggle}>
              <button className={state.schedView === 'list' ? styles.viewBtnActive : styles.viewBtn} onClick={() => actions.setSchedView('list')}>
                List
              </button>
              <button className={state.schedView === 'calendar' ? styles.viewBtnActive : styles.viewBtn} onClick={() => actions.setSchedView('calendar')}>
                Calendar
              </button>
            </div>
          </div>
          <div className={card.cardBody}>
            {state.schedView === 'list' ? <ScheduleList unitId={sel.id} /> : <DayTimeline unitId={sel.id} />}
            {!bookedUnitIds(state).has(sel.id) || conflictsFor(state.bookings, sel.id, state.date, state.start, state.end).length === 0 ? (
              <Button variant="primary" fullWidth style={{ marginTop: 12 }} onClick={() => actions.openBookingForm({ unitId: sel.id, date: state.date, start: state.start, end: state.end })}>
                New booking
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {sel && !isBookable(sel) && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Lockers are assigned via Assignment mode, not booked.</p>
          </div>
        </div>
      )}
      {!sel && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Select a desk, room, or parking stall on the plan to see its schedule and book it.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleList({ unitId }: { unitId: string }) {
  const { state, actions } = useFloorplan();
  const dayBookings = state.units.length
    ? state.bookings.filter((b) => b.unitId === unitId && b.date === state.date).sort((a, b) => a.start - b.start)
    : [];
  if (state.loading) return <SkeletonRows rows={3} />;
  if (!dayBookings.length) return <p className={card.helper}>No bookings for this date.</p>;
  return (
    <div className={styles.list}>
      {dayBookings.map((b) => (
        <div key={b.id} className={styles.listRow}>
          <div className={styles.listTime}>
            {fmtTime(b.start)}–{fmtTime(b.end)}
          </div>
          <div className={styles.listMeta}>
            <div className={styles.listBy}>{employeeName(state, b.by)}</div>
            {b.purpose && <div className={styles.listPurpose}>{b.purpose}</div>}
          </div>
          <button className={styles.cancelLink} onClick={() => actions.cancelBooking(b.id)}>
            Cancel
          </button>
        </div>
      ))}
    </div>
  );
}

function yAt(m: number) {
  return ((Math.max(WIN_S, Math.min(WIN_E, m)) - WIN_S) / 60) * PXH;
}

function minutesAtClientY(rect: DOMRect, clientY: number, snap: number) {
  const y = clientY - rect.top;
  let m = Math.round((y / PXH) * 60 + WIN_S);
  m = Math.round(m / snap) * snap;
  return Math.max(WIN_S, Math.min(WIN_E, m));
}

function DayTimeline({ unitId }: { unitId: string }) {
  const { state, actions } = useFloorplan();
  const height = ((WIN_E - WIN_S) / 60) * PXH;
  const dayBookings = state.bookings.filter((b) => b.unitId === unitId && b.date === state.date);
  const hours = Array.from({ length: (WIN_E - WIN_S) / 60 + 1 }, (_, i) => WIN_S + i * 60);
  const timelineRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ edge: 'top' | 'bottom' } | null>(null);

  function onClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (resizeRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const m = Math.min(WIN_E - state.slotGranularity, minutesAtClientY(rect, e.clientY, state.slotGranularity));
    actions.setTimeRange(m, m + state.slotGranularity);
  }

  function onEdgeDown(edge: 'top' | 'bottom', e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { edge };
    const onMove = (ev: MouseEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const m = minutesAtClientY(rect, ev.clientY, 15);
      if (edge === 'top') actions.setTimeRange(Math.min(m, state.end - 15), state.end);
      else actions.setTimeRange(state.start, Math.max(m, state.start + 15));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setTimeout(() => (resizeRef.current = null), 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div ref={timelineRef} className={styles.timeline} style={{ height }} onClick={onClick}>
      {hours.map((h) => (
        <div key={h} className={styles.hourLine} style={{ top: yAt(h) }}>
          <span className={styles.hourLabel}>{fmtTime(h)}</span>
        </div>
      ))}
      {dayBookings.map((b) => {
        const top = yAt(b.start);
        const h = Math.max(16, yAt(b.end) - top);
        const mine = b.by === state.bookBy;
        const label = mine ? 'Your booking' : 'Booked';
        return (
          <div
            key={b.id}
            className={styles.block}
            style={{
              top,
              height: h,
              background: mine ? 'var(--blue-050)' : 'var(--danger-050)',
              borderColor: mine ? 'var(--blue-400)' : 'var(--danger-500)',
              color: mine ? 'var(--blue-700)' : 'var(--danger-700)',
            }}
            title={`${label} · ${fmtTime(b.start)}–${fmtTime(b.end)} · ${employeeName(state, b.by)}${b.purpose ? ' · ' + b.purpose : ''}`}
          >
            {h >= 22 && (
              <span className={styles.blockLabel}>
                {label} · {fmtTime(b.start)}–{fmtTime(b.end)}
              </span>
            )}
          </div>
        );
      })}
      {state.end > state.start && (
        <div className={styles.selBlock} style={{ top: yAt(state.start), height: Math.max(14, yAt(state.end) - yAt(state.start)) }}>
          <div className={styles.selHandle} style={{ top: -4 }} onMouseDown={(e) => onEdgeDown('top', e)} />
          <div className={styles.selHandle} style={{ bottom: -4 }} onMouseDown={(e) => onEdgeDown('bottom', e)} />
        </div>
      )}
    </div>
  );
}
