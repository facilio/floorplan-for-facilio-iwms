import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { conflictsFor, contactName, floorMeta, isBookable } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { dataSource } from '../../lib/dataSource';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchOrgBookingsForDate } from '../../lib/facilioApiDataSource';
import type { Booking, Unit, UnitType } from '../../lib/types';
import { Button } from '../primitives/Button';
import { Modal, ModalHeader } from '../primitives/Modal';
import { StateflowActions } from '../details/StateflowActions';
import styles from './BookingsView.module.css';

// The portfolio/location switcher is GONE from this view (removed on request): the calendar
// is user-centric — it shows ALL of the current user's bookings across the org, so a floor
// filter had nothing to scope. Booking creation still targets the floorplan's current floor.

/** Category tabs → the unit type they book. Lockers are assignment-only (not time-booked). */
const CATEGORIES: { id: UnitType; label: string; bookable: boolean }[] = [
  { id: 'workstation', label: 'Desks', bookable: true },
  { id: 'parking', label: 'Parking', bookable: true },
  { id: 'locker', label: 'Lockers', bookable: false },
  { id: 'room', label: 'Spaces', bookable: true },
];

// FULL day — bookings aren't limited to office hours (the grid still auto-scrolls to 07:00).
const DAY_START = 0; // 00:00
const DAY_END = 24 * 60; // 24:00
const PX_PER_HOUR = 52;
const PX_PER_MIN = PX_PER_HOUR / 60;
const GRID_HEIGHT = ((DAY_END - DAY_START) / 60) * PX_PER_HOUR;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type CalView = 'day' | 'week' | 'month';

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}
function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function startOfWeek(iso: string): string {
  return addDays(iso, -parseISO(iso).getDay());
}
function shiftMonth(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setMonth(d.getMonth() + n, 1);
  return toISO(d);
}
function monthGridDates(iso: string): string[] {
  const d = parseISO(iso);
  d.setDate(1);
  const first = addDays(toISO(d), -d.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function shortDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function BookingsView() {
  const { state, actions } = useFloorplan();
  const meta = floorMeta(state, state.floorId);

  const [layout, setLayout] = useState<'calendar' | 'grid'>('calendar');
  const [calView, setCalView] = useState<CalView>('week');
  const [focusDate, setFocusDate] = useState(state.date);
  const [category, setCategory] = useState<UnitType>('workstation');
  // No resource dropdown anymore — this is set by clicking a Resource-grid row (or My bookings),
  // and only gates where drag-to-book CREATES; the calendar always shows the whole floor.
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [bookingsByDate, setBookingsByDate] = useState<Record<string, Booking[]>>({});
  const [calLoading, setCalLoading] = useState(true);
  /** Overlap-cluster preview modal target: rows derive live from bookingsByDate so a transition/refetch updates them. */
  const [preview, setPreview] = useState<{ date: string; ids: string[] } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const catDef = CATEGORIES.find((c) => c.id === category)!;

  const resources = useMemo(
    // Only actually bookable units belong on the booking calendar — for desks that's
    // HOT/HOTEL only (ASSIGNED desks are assignment-only; see lib/types DeskType).
    // UNPLACED records count too (requested): a bookable room with no zone drawn on the
    // plan is still a real, bookable resource here.
    () => state.units.filter((u) => u.type === category && isBookable(u)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [state.units, category]
  );


  // Keep a valid resource selected as category/floor changes.
  useEffect(() => {
    if (!resources.length) {
      setResourceId(null);
    } else if (!resources.some((r) => r.id === resourceId)) {
      setResourceId(resources[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources]);

  const visibleDates = useMemo(() => {
    if (calView === 'day') return [focusDate];
    if (calView === 'week') {
      const sow = startOfWeek(focusDate);
      return Array.from({ length: 7 }, (_, i) => addDays(sow, i));
    }
    return monthGridDates(focusDate);
  }, [calView, focusDate]);

  // Load bookings for every visible date (single-date getBookings, one call per day).
  // `state.bookingsNonce` bumps whenever a booking is added/cancelled anywhere, so a booking made
  // through the shared form (which writes to global state, not this local cache) triggers a refetch.
  useEffect(() => {
    let cancelled = false;
    setCalLoading(true);
    // Org-wide day fetch (no floor scoping — the portfolio filter is gone); local/mock mode
    // keeps the per-floor read since its store has no org-wide view.
    Promise.all(
      visibleDates.map((d) =>
        (isFacilioApiConfigured ? fetchOrgBookingsForDate(d) : dataSource.getBookings(state.floorId, d)).catch(() => [] as Booking[])
      )
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, Booking[]> = {};
      visibleDates.forEach((d, i) => {
        map[d] = results[i];
      });
      setBookingsByDate(map);
      setCalLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [state.floorId, visibleDates, state.bookingsNonce, refreshTick]);

  const myBookingsInRange = useMemo(() => {
    const mine: Booking[] = [];
    for (const d of visibleDates) for (const b of bookingsByDate[d] ?? []) if (b.by === state.bookBy) mine.push(b);
    return mine;
  }, [bookingsByDate, visibleDates, state.bookBy]);

  // The calendar shows EVERY booking on the floor for the date — no per-resource filter. The
  // resource picker only targets where drag-to-book CREATES a booking.
  function bookingsFor(date: string): Booking[] {
    // The calendar/month views are USER-CENTRIC (requested): only the current user's bookings
    // render, org-wide. The unfiltered day set stays in bookingsByDate for conflict checks and
    // the resource grid's occupancy counts.
    return (bookingsByDate[date] ?? []).filter((b) => b.by === state.bookBy);
  }

  const selectedResource = resources.find((r) => r.id === resourceId) ?? null;

  // Dragging a window opens the shared booking form (prefilled) rather than booking instantly —
  // the actual create happens on form submit, and the nonce-driven effect above refetches.
  function openForm(date: string, start: number, end: number) {
    if (!catDef.bookable) return;
    if (!resourceId) {
      actions.showToast(`No bookable ${catDef.label.toLowerCase()} found — pick another category`);
      return;
    }
    // Booking-date window (mirrors the form's own validation): rooms are same-day only,
    // everything else books at most one week ahead. ISO strings compare lexicographically.
    const today = toISO(new Date());
    const maxDate = category === 'room' ? today : addDays(today, 7);
    if (date < today || date > maxDate) {
      actions.showToast(category === 'room' ? 'Rooms can only be booked for today' : 'Bookings can be made at most one week ahead');
      return;
    }
    // Today's already-started slots can't be booked — the backend bumps a past start to "now",
    // so the record would not match what was clicked.
    if (date === today) {
      const nowD = new Date();
      if (start < nowD.getHours() * 60 + nowD.getMinutes()) {
        actions.showToast('That slot has already started — pick an upcoming one');
        return;
      }
    }
    if (conflictsFor(bookingsByDate[date] ?? [], resourceId, date, start, end).length) {
      actions.showToast('That window overlaps an existing booking');
      return;
    }
    actions.openBookingForm({ unitId: resourceId, date, start, end });
  }

  function cancelBooking(b: Booking) {
    actions.cancelBooking(b.id);
    setBookingsByDate((prev) => ({ ...prev, [b.date]: (prev[b.date] ?? []).filter((x) => x.id !== b.id) }));
  }

  function stepFocus(dir: -1 | 1) {
    if (calView === 'day') setFocusDate(addDays(focusDate, dir));
    else if (calView === 'week') setFocusDate(addDays(focusDate, dir * 7));
    else setFocusDate(shiftMonth(focusDate, dir));
  }

  function jumpToMyBookings() {
    if (!myBookingsInRange.length) {
      actions.showToast('You have no bookings in this range');
      return;
    }
    const soonest = [...myBookingsInRange].sort((a, b) => (a.date === b.date ? a.start - b.start : a.date.localeCompare(b.date)))[0];
    const unit = state.units.find((u) => u.id === soonest.unitId);
    if (unit) {
      setCategory(unit.type);
      setResourceId(unit.id);
    }
    setFocusDate(soonest.date);
    if (calView === 'month') setCalView('week');
  }

  const rangeLabel = useMemo(() => {
    if (calView === 'day') {
      const d = parseISO(focusDate);
      return `${DAY_ABBR[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
    if (calView === 'week') {
      const dates = visibleDates;
      return `${shortDate(dates[0])} – ${shortDate(dates[6])}`;
    }
    const d = parseISO(focusDate);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }, [calView, focusDate, visibleDates]);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.headerRow}>
          <div>
            <div className={styles.breadcrumb}>
            </div>
            <h1 className={styles.h1}>Bookings</h1>
            <p className={styles.sub}>Calendar and resource view across bookable spaces</p>
          </div>
          <button className={[styles.myBookings, myBookingsInRange.length ? styles.myBookingsActive : ''].join(' ')} onClick={jumpToMyBookings}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            My bookings
            <span className={styles.myBadge}>{myBookingsInRange.length}</span>
          </button>
        </div>

        <div className={styles.pickerRow}>
          <div className={styles.catTabs}>
            {CATEGORIES.map((c) => (
              <button key={c.id} className={[styles.catTab, category === c.id ? styles.catTabActive : ''].join(' ')} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          {/* NO resource switcher here (removed on request, twice) — the SPACE is picked inside
              the booking form's own lookup; the auto/grid-picked resource is only the default
              the form opens with. */}
        </div>

        {catDef.bookable && selectedResource && (
          <p className={styles.hint}>
            Click a slot on the calendar to book for{' '}
            {state.slotGranularity % 60 === 0 ? `${state.slotGranularity / 60}h` : `${state.slotGranularity}m`} — the space is picked in the form.
          </p>
        )}

        {/* NO floor empty-state gate anymore: the calendar is org-wide and user-centric, so it
            renders even when the current floor has no resources of this category (only the
            resource GRID needs them — it shows the empty state itself below). */}
        {!catDef.bookable ? (
          <NotBookableState label={catDef.label} />
        ) : (
          <>
            <div className={styles.calToolbar}>
              <div className={styles.viewSeg}>
                <button className={[styles.viewBtn, layout === 'calendar' ? styles.viewBtnActive : ''].join(' ')} onClick={() => setLayout('calendar')}>
                  Calendar
                </button>
                <button className={[styles.viewBtn, layout === 'grid' ? styles.viewBtnActive : ''].join(' ')} onClick={() => setLayout('grid')}>
                  Resource grid
                </button>
              </div>
              <div className={styles.viewSeg}>
                {(['day', 'week', 'month'] as CalView[]).map((v) => (
                  <button key={v} className={[styles.viewBtn, calView === v ? styles.viewBtnActive : ''].join(' ')} onClick={() => setCalView(v)}>
                    {v === 'day' ? 'Day' : v === 'week' ? 'Week' : 'Month'}
                  </button>
                ))}
              </div>
              <div className={styles.navGroup}>
                <button className={styles.navBtn} onClick={() => stepFocus(-1)} title="Previous">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <button className={styles.todayBtn} onClick={() => setFocusDate(toISO(new Date()))}>Today</button>
                <button className={styles.navBtn} onClick={() => stepFocus(1)} title="Next">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
              <div className={styles.rangeLabel}>{rangeLabel}</div>
            </div>

            <div className={styles.calArea}>
              {calLoading && (
                <div className={styles.calLoading}>
                  <span className={styles.calSpinner} />
                  Loading bookings…
                </div>
              )}
            {layout === 'grid' && !resources.length ? (
              <EmptyState category={catDef.label} floorName={meta?.floor.name} />
            ) : layout === 'grid' ? (
              <ResourceGrid
                resources={resources}
                dates={calView === 'day' ? [focusDate] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(focusDate), i))}
                bookingsByDate={bookingsByDate}
                onPick={(rid, date) => {
                  setResourceId(rid);
                  setFocusDate(date);
                  setLayout('calendar');
                  setCalView('day');
                }}
              />
            ) : calView === 'month' ? (
              <MonthGrid
                dates={visibleDates}
                monthIso={focusDate}
                bookingsFor={bookingsFor}
                onPickDay={(d) => {
                  setFocusDate(d);
                  setCalView('day');
                }}
              />
            ) : (
              <CalendarGrid
                dates={visibleDates}
                bookingsFor={bookingsFor}
                myId={state.bookBy}
                snap={state.slotGranularity}
                onCreate={openForm}
                onPreview={(date, ids) => setPreview({ date, ids })}
                contactNameOf={(id) => contactName(state, id)}
              />
            )}
            </div>
          </>
        )}

        {preview && (
          <Modal onClose={() => setPreview(null)} width={480}>
            <ModalHeader
              title={`Bookings · ${shortDate(preview.date)}`}
              subtitle={`${(bookingsByDate[preview.date] ?? []).filter((b) => preview.ids.includes(b.id)).length} booking(s)`}
              onClose={() => setPreview(null)}
            />
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '58vh', overflowY: 'auto' }}>
              {(bookingsByDate[preview.date] ?? [])
                .filter((b) => preview.ids.includes(b.id))
                .map((b) => {
                  const unit = state.units.find((u) => u.id === b.unitId);
                  return (
                    <div key={b.id} style={{ border: '1px solid var(--ink-200)', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        {/* Other-floor bookings have no local unit — the booking's own name beats a raw record id. */}
                        <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink-900)' }}>{unit?.label ?? b.name ?? `#${b.unitId}`}</span>
                        <span style={{ font: '500 12px var(--font-sans)', color: 'var(--ink-600)' }}>
                          {fmtTime(b.start)}–{fmtTime(b.end)}
                        </span>
                      </div>
                      <div style={{ font: '400 12.5px/1.4 var(--font-sans)', color: 'var(--ink-600)', marginTop: 2 }}>
                        {contactName(state, b.by) || 'Booked'}
                        {b.purpose ? ` · ${b.purpose}` : ''}
                      </div>
                      {/* Real bookings: status pills + whatever actions the record's current state
                          allows (Cancel/Approve/...) — same stateflow bar as everywhere else. */}
                      {/^\d+$/.test(b.id) ? (
                        <StateflowActions moduleName="spacebooking" recordId={Number(b.id)} onChanged={() => setRefreshTick((t) => t + 1)} />
                      ) : (
                        <Button variant="danger" style={{ marginTop: 8 }} onClick={() => { cancelBooking(b); setPreview(null); }}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  );
                })}
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

function EmptyState({ category, floorName }: { category: string; floorName?: string }) {
  return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-300)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
      <div className={styles.emptyTitle}>No {category.toLowerCase()} on {floorName ?? 'this floor'}</div>
      <div className={styles.emptySub}>Place some in Edit mode on the Floorplans view, then book them here.</div>
    </div>
  );
}

function NotBookableState({ label }: { label: string }) {
  return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-300)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <div className={styles.emptyTitle}>{label} are assigned, not booked</div>
      <div className={styles.emptySub}>Lockers belong to a person for the long term — manage them in Assignment mode on the Floorplans view.</div>
    </div>
  );
}

/** Groups a day's bookings into overlap clusters (sorted by start; a booking joins the current cluster when it starts before the cluster's running end). */
function clusterBookings(list: Booking[]): Booking[][] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters: Booking[][] = [];
  let clusterEnd = -1;
  for (const b of sorted) {
    if (clusters.length && b.start < clusterEnd) {
      clusters[clusters.length - 1].push(b);
      clusterEnd = Math.max(clusterEnd, b.end);
    } else {
      clusters.push([b]);
      clusterEnd = b.end;
    }
  }
  return clusters;
}

interface CalendarGridProps {
  dates: string[];
  bookingsFor: (date: string) => Booking[];
  myId: string;
  snap: number;
  onCreate: (date: string, start: number, end: number) => void;
  onPreview: (date: string, ids: string[]) => void;
  contactNameOf: (id: string) => string;
}

function CalendarGrid({ dates, bookingsFor, myId, snap, onCreate, onPreview, contactNameOf }: CalendarGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ date: string; from: number; to: number } | null>(null);
  const dragRef = useRef<{ date: string; colTop: number; from: number; to: number } | null>(null);
  // Live "now" — ticks each minute so the current-time line stays accurate
  // while the view sits open (it was computed once at render before).
  const [now, setNow] = useState(nowMinutes());
  useEffect(() => {
    const t = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(t);
  }, []);

  const todayIso = toISO(new Date());
  const todayVisible = dates.includes(todayIso);
  // The grid spans the working day, but expands to include the current hour
  // when today is on screen — so the now-line always has a real place, even
  // early morning or late evening (before it was clamped to 06:00–22:00 and
  // simply vanished outside those hours).
  const dayStart = todayVisible ? Math.min(DAY_START, Math.floor(now / 60) * 60) : DAY_START;
  const dayEnd = todayVisible ? Math.max(DAY_END, Math.ceil((now + 1) / 60) * 60) : DAY_END;
  const gridHeight = ((dayEnd - dayStart) / 60) * PX_PER_HOUR;

  // Start scrolled near the working day (07:00).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (7 * 60 - dayStart) * PX_PER_MIN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The SLOT containing a y-position — selection is slot-based (fixed length = the Settings default slot), not free-range. */
  function slotAt(colTop: number, clientY: number): number {
    const raw = (clientY - colTop) / PX_PER_MIN + dayStart;
    return Math.max(dayStart, Math.min(dayEnd - snap, Math.floor(raw / snap) * snap));
  }

  function onColMouseDown(date: string, e: ReactMouseEvent) {
    if (e.button !== 0) return;
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const from = slotAt(colTop, e.clientY);
    dragRef.current = { date, colTop, from, to: from + snap };
    setDrag({ date, from, to: from + snap });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }
  function onDragMove(e: MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    // Dragging MOVES the one-slot selection; it never stretches it — bookings are slot-sized.
    const s = slotAt(d.colTop, e.clientY);
    d.from = s;
    d.to = s + snap;
    setDrag({ date: d.date, from: d.from, to: d.to });
  }
  function onDragUp() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    // The create side-effect lives OUTSIDE any setState updater — React StrictMode double-
    // invokes updaters to check purity, which would otherwise fire the booking twice.
    // Clicking a slot books that slot (the form still confirms before anything is created).
    if (d) onCreate(d.date, d.from, d.to);
  }

  return (
    <div className={styles.calWrap}>
      <div className={styles.dayHeaderRow}>
        <div className={styles.gutterHead} />
        {dates.map((d) => {
          const dt = parseISO(d);
          const isToday = d === todayIso;
          return (
            <div key={d} className={[styles.dayHead, isToday ? styles.dayHeadToday : ''].join(' ')}>
              {DAY_ABBR[dt.getDay()]} {shortDate(d)}
            </div>
          );
        })}
      </div>
      <div className={styles.calScroll} ref={scrollRef}>
        <div className={styles.calBody} style={{ height: gridHeight }}>
          <div className={styles.gutter}>
            {Array.from({ length: (dayEnd - dayStart) / 60 + 1 }, (_, i) => {
              const min = dayStart + i * 60;
              return (
                <div key={min} className={styles.hourLabel} style={{ top: i * PX_PER_HOUR }}>
                  {min % 60 === 0 ? formatHour(min) : ''}
                </div>
              );
            })}
          </div>
          {dates.map((d) => {
            const isToday = d === todayIso;
            const blocks = bookingsFor(d);
            return (
              <div key={d} className={styles.dayCol} onMouseDown={(e) => onColMouseDown(d, e)}>
                {Array.from({ length: (dayEnd - dayStart) / 60 }, (_, i) => (
                  <div key={i} className={styles.hourCell} style={{ top: (i + 1) * PX_PER_HOUR }} />
                ))}
                {clusterBookings(blocks).map((cluster) => {
                  const cStart = Math.min(...cluster.map((b) => b.start));
                  const cEnd = Math.max(...cluster.map((b) => b.end));
                  const top = (Math.max(dayStart, cStart) - dayStart) * PX_PER_MIN;
                  const height = Math.max(16, (Math.min(dayEnd, cEnd) - Math.max(dayStart, cStart)) * PX_PER_MIN);
                  if (cluster.length > 1) {
                    // Overlapping bookings collapse into one COUNT block — clicking previews them
                    // all in the modal (each with its stateflow status + actions).
                    return (
                      <button
                        key={cluster[0].id}
                        type="button"
                        className={[styles.block, styles.blockOther].join(' ')}
                        style={{ top, height, cursor: 'pointer', textAlign: 'left' }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onPreview(d, cluster.map((b) => b.id))}
                        title={`${cluster.length} overlapping bookings — click to preview`}
                      >
                        <div className={styles.blockTime}>{fmtTime(cStart)} - {fmtTime(cEnd)}</div>
                        <div className={styles.blockName}>{cluster.length} bookings</div>
                      </button>
                    );
                  }
                  const b = cluster[0];
                  const mine = b.by === myId;
                  return (
                    <div
                      key={b.id}
                      className={[styles.block, mine ? styles.blockMine : styles.blockOther].join(' ')}
                      // Pending-approval bookings render amber (matching the plan markers) so a
                      // request reads differently from a confirmed reservation.
                      style={{ top, height, cursor: 'pointer', ...(b.approvalPending ? { background: 'var(--warning-050)', borderColor: 'var(--warning-700)', color: 'var(--warning-700)' } : {}) }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onPreview(d, [b.id])}
                      title={(mine ? 'Your booking' : `Booked by ${contactNameOf(b.by) || 'someone'}`) + (b.approvalPending ? ' · pending approval' : '') + ' — click to preview'}
                    >
                      <div className={styles.blockTime}>{fmtTime(b.start)} - {fmtTime(b.end)}</div>
                      <div className={styles.blockName}>{mine ? 'Your booking' : contactNameOf(b.by) || 'Booked'}</div>
                    </div>
                  );
                })}
                {drag && drag.date === d && (
                  <div
                    className={styles.selBlock}
                    style={{
                      top: (Math.min(drag.from, drag.to) - dayStart) * PX_PER_MIN,
                      height: Math.max(2, Math.abs(drag.to - drag.from) * PX_PER_MIN),
                    }}
                  >
                    <span className={styles.selLabel}>{fmtTime(Math.min(drag.from, drag.to))} - {fmtTime(Math.max(drag.from, drag.to))}</span>
                  </div>
                )}
                {isToday && (
                  <div className={styles.nowLine} style={{ top: (now - dayStart) * PX_PER_MIN }}>
                    <span className={styles.nowDot} />
                    <span className={styles.nowLabel}>{fmtTime(now)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatHour(min: number): string {
  const h = Math.floor(min / 60);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

function MonthGrid({
  dates,
  monthIso,
  bookingsFor,
  onPickDay,
}: {
  dates: string[];
  monthIso: string;
  bookingsFor: (date: string) => Booking[];
  onPickDay: (date: string) => void;
}) {
  const month = parseISO(monthIso).getMonth();
  const todayIso = toISO(new Date());
  return (
    <div className={styles.monthWrap}>
      <div className={styles.monthHead}>
        {DAY_ABBR.map((d) => (
          <div key={d} className={styles.monthHeadCell}>{d}</div>
        ))}
      </div>
      <div className={styles.monthGrid}>
        {dates.map((d) => {
          const dt = parseISO(d);
          const inMonth = dt.getMonth() === month;
          const blocks = bookingsFor(d);
          const isToday = d === todayIso;
          return (
            <button key={d} className={[styles.monthCell, inMonth ? '' : styles.monthCellDim].join(' ')} onClick={() => onPickDay(d)}>
              <span className={[styles.monthDate, isToday ? styles.monthDateToday : ''].join(' ')}>{dt.getDate()}</span>
              <div className={styles.monthBars}>
                {[...blocks]
                  .sort((a, b) => a.start - b.start)
                  .slice(0, 3)
                  .map((b) => (
                    <span key={b.id} className={styles.monthBar}>
                      {fmtTime(b.start)}
                    </span>
                  ))}
                {blocks.length > 3 && <span className={styles.monthMore}>+{blocks.length - 3} more</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ResourceGrid({
  resources,
  dates,
  bookingsByDate,
  onPick,
}: {
  resources: Unit[];
  dates: string[];
  bookingsByDate: Record<string, Booking[]>;
  onPick: (resourceId: string, date: string) => void;
}) {
  return (
    <div className={styles.rgWrap}>
      <div className={styles.rgScroll}>
        <table className={styles.rgTable}>
          <thead>
            <tr>
              <th className={styles.rgCorner}>Resource</th>
              {dates.map((d) => {
                const dt = parseISO(d);
                return (
                  <th key={d} className={styles.rgDayHead}>{DAY_ABBR[dt.getDay()]} {shortDate(d)}</th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id}>
                <td className={styles.rgName}>{r.label}</td>
                {dates.map((d) => {
                  const n = (bookingsByDate[d] ?? []).filter((b) => b.unitId === r.id).length;
                  return (
                    <td key={d} className={styles.rgCell}>
                      <button className={[styles.rgPill, n ? styles.rgPillBooked : styles.rgPillFree].join(' ')} onClick={() => onPick(r.id, d)}>
                        {n ? `${n} booked` : 'Free'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
