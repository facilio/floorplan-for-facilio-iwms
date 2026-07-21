import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { conflictsFor, employeeName, floorMeta, isBookable } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { dataSource } from '../../lib/dataSource';
import type { Booking, Unit, UnitType } from '../../lib/types';
import { Select } from '../primitives/Select';
import { PortfolioTree } from '../location/PortfolioTree';
import loc from '../location/LocationPanel.module.css';
import styles from './BookingsView.module.css';

/**
 * The calendar's location switcher — the SAME control as the portfolio tab's (LocationPanel):
 * the Site › Building path over the floor name with a chevron, expanding into the full
 * PortfolioTree. Here it lives in the header breadcrumb spot and opens as a popover; picking a
 * floor (PortfolioTree calls selectFloor) reloads units/bookings in place and closes it.
 */
function LocationSwitcher() {
  const { state } = useFloorplan();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const meta = floorMeta(state, state.floorId);

  // A floor pick changes floorId — that's the close signal (the tree lives inside the popover).
  useEffect(() => {
    setOpen(false);
  }, [state.floorId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className={styles.locSwitcherWrap}>
      <button className={loc.switcher} onClick={() => setOpen((o) => !o)}>
        <span className={loc.switcherIcon}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
          </svg>
        </span>
        <span className={loc.switcherText}>
          <span className={loc.switcherPath}>{meta ? `${meta.site.name} › ${meta.building.name}` : ''}</span>
          <span className={loc.switcherName}>{meta?.floor.name ?? 'Choose a floor'}</span>
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-500)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 160ms var(--ease-standard)' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={styles.locPopover}>
          <PortfolioTree />
        </div>
      )}
    </div>
  );
}

/** Category tabs → the unit type they book. Lockers are assignment-only (not time-booked). */
const CATEGORIES: { id: UnitType; label: string; bookable: boolean }[] = [
  { id: 'workstation', label: 'Desks', bookable: true },
  { id: 'parking', label: 'Parking', bookable: true },
  { id: 'locker', label: 'Lockers', bookable: false },
  { id: 'room', label: 'Spaces', bookable: true },
];

const DAY_START = 6 * 60; // 06:00
const DAY_END = 22 * 60; // 22:00
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
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [bookingsByDate, setBookingsByDate] = useState<Record<string, Booking[]>>({});
  const [calLoading, setCalLoading] = useState(true);

  const catDef = CATEGORIES.find((c) => c.id === category)!;

  const resources = useMemo(
    // Only actually bookable units belong on the booking calendar — for desks that's
    // HOT/HOTEL only (ASSIGNED desks are assignment-only; see lib/types DeskType).
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
    Promise.all(visibleDates.map((d) => dataSource.getBookings(state.floorId, d).catch(() => [] as Booking[]))).then((results) => {
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
  }, [state.floorId, visibleDates, state.bookingsNonce]);

  const myBookingsInRange = useMemo(() => {
    const mine: Booking[] = [];
    for (const d of visibleDates) for (const b of bookingsByDate[d] ?? []) if (b.by === state.bookBy) mine.push(b);
    return mine;
  }, [bookingsByDate, visibleDates, state.bookBy]);

  function bookingsFor(date: string): Booking[] {
    return (bookingsByDate[date] ?? []).filter((b) => b.unitId === resourceId);
  }

  function resourceStatus(unit: Unit): string {
    if (!catDef.bookable) return 'Not bookable';
    const list = (bookingsByDate[focusDate] ?? []).filter((b) => b.unitId === unit.id);
    if (!list.length) return 'Vacant';
    return `${list.length} booking${list.length === 1 ? '' : 's'}`;
  }

  const selectedResource = resources.find((r) => r.id === resourceId) ?? null;

  // Dragging a window opens the shared booking form (prefilled) rather than booking instantly —
  // the actual create happens on form submit, and the nonce-driven effect above refetches.
  function openForm(date: string, start: number, end: number) {
    if (!resourceId || !catDef.bookable) return;
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
              <LocationSwitcher />
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
          <div className={styles.resourcePick}>
            <Select
              value={resourceId}
              options={resources
                .filter((r) => !search || r.label.toLowerCase().includes(search.toLowerCase()))
                .map((r) => ({ value: r.id, label: `${r.label} — ${resourceStatus(r)}`, sublabel: r.secondary }))}
              onChange={(v) => setResourceId(v)}
              placeholder={resources.length ? 'Select a resource' : 'No resources'}
              disabled={!resources.length}
              size="md"
              aria-label="Resource"
            />
            <button className={styles.searchBtn} title="Filter resources" onClick={() => setSearch((s) => (s === '' ? ' ' : ''))}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
              </svg>
            </button>
          </div>
        </div>
        {search !== '' && (
          <input className={styles.searchInput} autoFocus placeholder="Filter resources by name…" value={search.trim()} onChange={(e) => setSearch(e.target.value || ' ')} />
        )}

        {catDef.bookable && selectedResource && (
          <p className={styles.hint}>Drag across the calendar to book <strong>{selectedResource.label}</strong> for that window.</p>
        )}

        {!resources.length ? (
          <EmptyState category={catDef.label} floorName={meta?.floor.name} />
        ) : !catDef.bookable ? (
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
              <div className={styles.rangeLabel}>
                {layout === 'grid' ? rangeLabel : <>Showing: <strong>{selectedResource?.label}</strong></>}
              </div>
            </div>

            <div className={styles.calArea}>
              {calLoading && (
                <div className={styles.calLoading}>
                  <span className={styles.calSpinner} />
                  Loading bookings…
                </div>
              )}
            {layout === 'grid' ? (
              <ResourceGrid
                resources={resources.filter((r) => !search || r.label.toLowerCase().includes(search.toLowerCase()))}
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
                onCancel={cancelBooking}
                employeeNameOf={(id) => employeeName(state, id)}
              />
            )}
            </div>
          </>
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

interface CalendarGridProps {
  dates: string[];
  bookingsFor: (date: string) => Booking[];
  myId: string;
  snap: number;
  onCreate: (date: string, start: number, end: number) => void;
  onCancel: (b: Booking) => void;
  employeeNameOf: (id: string) => string;
}

function CalendarGrid({ dates, bookingsFor, myId, snap, onCreate, onCancel, employeeNameOf }: CalendarGridProps) {
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

  function yToMin(colTop: number, clientY: number): number {
    const raw = (clientY - colTop) / PX_PER_MIN + dayStart;
    return Math.max(dayStart, Math.min(dayEnd, Math.round(raw / snap) * snap));
  }

  function onColMouseDown(date: string, e: ReactMouseEvent) {
    if (e.button !== 0) return;
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const from = yToMin(colTop, e.clientY);
    dragRef.current = { date, colTop, from, to: from };
    setDrag({ date, from, to: from });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }
  function onDragMove(e: MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.to = yToMin(d.colTop, e.clientY);
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
    if (d) {
      const start = Math.min(d.from, d.to);
      const end = Math.max(d.from, d.to);
      // Require a real drag of at least one slot — a stray click shouldn't create a booking.
      if (end - start >= snap) onCreate(d.date, start, end);
    }
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
                {blocks.map((b) => {
                  const top = (Math.max(dayStart, b.start) - dayStart) * PX_PER_MIN;
                  const height = Math.max(16, (Math.min(dayEnd, b.end) - Math.max(dayStart, b.start)) * PX_PER_MIN);
                  const mine = b.by === myId;
                  return (
                    <div
                      key={b.id}
                      className={[styles.block, mine ? styles.blockMine : styles.blockOther].join(' ')}
                      style={{ top, height }}
                      onMouseDown={(e) => e.stopPropagation()}
                      title={mine ? 'Your booking' : `Booked by ${employeeNameOf(b.by) || 'someone'}`}
                    >
                      {/* Cancelling is an explicit button, never a bare click on the block —
                          clicking a booking to inspect it used to silently cancel it. */}
                      {mine && (
                        <button
                          className={styles.blockCancel}
                          title="Cancel this booking"
                          aria-label="Cancel booking"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancel(b);
                          }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                      <div className={styles.blockTime}>{fmtTime(b.start)} - {fmtTime(b.end)}</div>
                      <div className={styles.blockName}>{mine ? 'Your booking' : employeeNameOf(b.by) || 'Booked'}</div>
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
