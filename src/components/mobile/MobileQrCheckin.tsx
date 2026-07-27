import { useEffect, useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, floorMeta } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { dataSource } from '../../lib/dataSource';
import { StateflowActions } from '../details/StateflowActions';
import { TYPE_META } from '../../lib/types';
import type { Booking, Unit } from '../../lib/types';

/**
 * QR "Scan result" screen (Facilio DS flow "QR Check-in"): the QR identifies the space; this
 * resolves the space's bookings against it — Today / Upcoming tabs, a time-window status chip per
 * booking, and the record's OWN stateflow + approval actions (StateflowActions) as the only
 * action surface. STRICT rule: check-in/check-out/cancel/anything are never hardcoded here —
 * exactly the transitions the record's current state allows are offered, and nothing is faked
 * locally. Local-only bookings (non-numeric ids) have no backend record, so they get no actions.
 */

const FONT = 'var(--font-sans)';
const CHECKIN_EARLY_MIN = 15;

type Status = 'ready' | 'checked-in' | 'early' | 'missed' | 'ended' | 'upcoming';

const CHIP: Record<Status, { label: string; bg: string; fg: string; cardBorder: string }> = {
  ready: { label: 'Ready to check in', bg: 'var(--blue-025)', fg: 'var(--blue-600)', cardBorder: 'var(--blue-300)' },
  'checked-in': { label: 'Checked in', bg: 'var(--success-050)', fg: 'var(--success-700)', cardBorder: 'var(--success-500)' },
  early: { label: 'Starts later', bg: 'var(--ink-050)', fg: 'var(--ink-600)', cardBorder: 'var(--ink-200)' },
  missed: { label: 'Missed check-in', bg: 'var(--danger-050)', fg: 'var(--danger-700)', cardBorder: 'var(--ink-200)' },
  ended: { label: 'Checked out', bg: 'var(--ink-050)', fg: 'var(--ink-600)', cardBorder: 'var(--ink-200)' },
  upcoming: { label: 'Confirmed', bg: 'var(--ink-050)', fg: 'var(--ink-600)', cardBorder: 'var(--ink-200)' },
};

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function MobileQrCheckin({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const meta = floorMeta(state, state.floorId);
  const [tab, setTab] = useState<'today' | 'upcoming'>('today');
  const [upcoming, setUpcoming] = useState<Booking[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const today = todayIso();

  // REAL backend bookings only (numeric ids) — local-only rows have no record, no stateflow, and
  // per the strict rule they don't appear here at all.
  const todayBookings = useMemo(
    () => state.bookings.filter((b) => b.unitId === unit.id && b.date === today && /^\d+$/.test(b.id)).sort((a, b) => a.start - b.start),
    [state.bookings, unit.id, today]
  );

  // Upcoming: the next 7 days, fetched per-day through the composite (same path the calendar uses).
  useEffect(() => {
    let cancelled = false;
    const days = Array.from({ length: 7 }, (_, i) => addDaysIso(today, i + 1));
    Promise.all(days.map((d) => dataSource.getBookings(state.floorId, d).catch(() => [] as Booking[]))).then((results) => {
      if (cancelled) return;
      setUpcoming(results.flat().filter((b) => b.unitId === unit.id && /^\d+$/.test(b.id)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id, refreshTick]);

  /** Time-window status for the chip/note only — the record's REAL state comes from its stateflow pills. */
  function statusOf(b: Booking): Status {
    if (b.date !== today) return 'upcoming';
    const now = nowMinutes();
    if (now < b.start - CHECKIN_EARLY_MIN) return 'early';
    if (now >= b.end) return 'ended';
    return 'ready';
  }

  const list = tab === 'today' ? todayBookings : upcoming;
  const typeName = TYPE_META[unit.type].name;
  const tags = [
    typeName,
    unit.type === 'workstation' ? (unit.deskType ?? 'ASSIGNED') : null,
    unit.secondary ?? null,
    unit.room ? `In ${unit.room}` : null,
  ].filter(Boolean) as string[];

  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 4,
    border: 'none',
    font: `500 13px ${FONT}`,
    cursor: 'pointer',
    background: active ? '#fff' : 'transparent',
    color: active ? 'var(--ink-900)' : 'var(--ink-600)',
    boxShadow: active ? 'var(--shadow-sm)' : 'none',
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--ink-025, #f5f7fa)', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 8px 0 12px', background: '#fff', borderBottom: '1px solid var(--ink-100)' }}>
        <button aria-label="Back" onClick={onClose} style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'none', color: 'var(--ink-700)', cursor: 'pointer' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div style={{ flex: 1, minWidth: 0, font: `500 16px ${FONT}`, color: 'var(--ink-900)' }}>Scan result</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 999, background: 'var(--success-050)', font: `500 11px ${FONT}`, color: 'var(--success-700)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--success-500)', animation: 'qrc-live 2s ease-in-out infinite' }} />
          QR verified
        </div>
        <button aria-label="Close" onClick={onClose} style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'none', color: 'var(--ink-700)', cursor: 'pointer' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <style>{`@keyframes qrc-live { 0%,100% { opacity: 1; } 50% { opacity: .3; } }`}</style>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* scanned resource */}
        <div style={{ background: '#fff', border: '1px solid var(--ink-100)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 'none', width: 42, height: 42, borderRadius: 8, background: 'var(--blue-025)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blue-600)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {unit.type === 'room' ? <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></> : <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>}
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: `500 18px/1.25 ${FONT}`, color: 'var(--ink-900)' }}>{unit.label}</div>
              <div style={{ font: `400 12px ${FONT}`, color: 'var(--ink-600)', marginTop: 3 }}>
                {[meta?.floor.name, meta?.building.name, meta?.site.name].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((t) => (
              <span key={t} style={{ height: 22, display: 'inline-flex', alignItems: 'center', padding: '0 8px', borderRadius: 4, background: 'var(--ink-050)', font: `400 11px ${FONT}`, color: 'var(--ink-600)' }}>
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--ink-050)', borderRadius: 6 }}>
          {(['today', 'upcoming'] as const).map((t) => (
            <button key={t} style={tabBtn(tab === t)} onClick={() => setTab(t)}>
              <span>{t === 'today' ? 'Today' : 'Upcoming'}</span>
              <span style={{ minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--ink-100)', font: `500 10px ${FONT}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-600)' }}>
                {t === 'today' ? todayBookings.length : upcoming.length}
              </span>
            </button>
          ))}
        </div>

        {/* bookings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((b) => {
            const st = statusOf(b);
            const chip = CHIP[st];
            const note =
              st === 'early'
                ? { text: `Check-in opens at ${fmtTime(Math.max(0, b.start - CHECKIN_EARLY_MIN))}.`, bg: 'var(--ink-050)', fg: 'var(--ink-600)' }
                : st === 'ended'
                  ? { text: 'This slot has ended.', bg: 'var(--ink-050)', fg: 'var(--ink-600)' }
                  : null;
            return (
              <div key={b.id} style={{ background: '#fff', border: `1px solid ${chip.cardBorder}`, borderRadius: 8, boxShadow: 'var(--shadow-sm)', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ font: `600 11px ${FONT}`, color: 'var(--ink-400)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{b.date === today ? 'Today' : b.date}</div>
                    <div style={{ font: `500 17px/1.25 ${FONT}`, color: 'var(--ink-900)', marginTop: 4 }}>
                      {fmtTime(b.start)} – {fmtTime(b.end)}
                    </div>
                    <div style={{ font: `400 12px ${FONT}`, color: 'var(--ink-600)', marginTop: 3 }}>
                      {[contactName(state, b.by) || null, b.purpose || null].filter(Boolean).join(' · ') || 'Booking'}
                    </div>
                  </div>
                  <span style={{ flex: 'none', height: 22, display: 'inline-flex', alignItems: 'center', padding: '0 8px', borderRadius: 4, background: chip.bg, font: `500 11px ${FONT}`, color: chip.fg }}>
                    {chip.label}
                  </span>
                </div>
                {note && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 6, background: note.bg }}>
                    <span style={{ font: `400 12px/1.45 ${FONT}`, color: note.fg }}>{note.text}</span>
                  </div>
                )}
                {/* STRICT: the record's own stateflow + approval transitions are the ONLY actions —
                    check-in/out/cancel appear exactly when the booking's current state offers
                    them, with the record's real state + approval pills above the buttons. */}
                <StateflowActions moduleName="spacebooking" recordId={Number(b.id)} onChanged={() => { setRefreshTick((t) => t + 1); actions.refreshBookings(); }} />
              </div>
            );
          })}
          {list.length === 0 && (
            <div style={{ background: '#fff', border: '1px dashed var(--ink-200)', borderRadius: 8, padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
              <div style={{ font: `500 14px ${FONT}`, color: 'var(--ink-900)' }}>{tab === 'today' ? 'No bookings here today' : 'Nothing booked ahead'}</div>
              <div style={{ font: `400 12px/1.45 ${FONT}`, color: 'var(--ink-600)', maxWidth: 230 }}>
                {tab === 'today' ? 'No reservation for this space today. Book it now if it is free.' : 'Future reservations for this space will show up here.'}
              </div>
            </div>
          )}
        </div>

        <div style={{ height: 1, background: 'var(--ink-100)', margin: '2px 0' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => {
              onClose();
              actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end });
            }}
            style={{ height: 40, borderRadius: 8, border: '1px solid var(--ink-200)', background: '#fff', font: `600 13.5px ${FONT}`, color: 'var(--ink-800)', cursor: 'pointer' }}
          >
            + Book this {typeName.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  );
}
