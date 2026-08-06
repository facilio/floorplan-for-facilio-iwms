import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { conflictsFor, contactName, floorMeta, isBookable } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { dataSource } from '../../lib/dataSource';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchCurrentApp, fetchOrgBookableResources, fetchOrgBookingsForRange } from '../../lib/facilioApiDataSource';
import { orgNow } from '../../lib/orgTime';
import type { Booking, Building, Floor, Site, Unit, UnitType } from '../../lib/types';
import { Button } from '../primitives/Button';
import { Modal, ModalHeader } from '../primitives/Modal';
import { StateflowActions } from '../details/StateflowActions';
import styles from './BookingsView.module.css';

// The portfolio/location switcher is GONE from this view (removed on request): the calendar
// is user-centric — it shows ALL of the current user's bookings across the org, so a floor
// filter had nothing to scope. Booking creation still targets the floorplan's current floor.

/** Category tabs → the unit type they book. "All spaces" leads (requested); lockers are assignment-only (not time-booked). */
type CategoryId = UnitType | 'all';
// "All spaces" lists ONLY bookable desks and rooms (requested) — parking keeps its own tab.
const BOOKABLE_TYPES: UnitType[] = ['workstation', 'room'];
// Lockers and Parking tabs are REMOVED for now (requested) — desks and rooms only.
const CATEGORIES: { id: CategoryId; label: string; bookable: boolean }[] = [
  { id: 'all', label: 'All spaces', bookable: true },
  { id: 'workstation', label: 'Desks', bookable: true },
  { id: 'room', label: 'Rooms', bookable: true },
];

// FULL day — bookings aren't limited to office hours (the grid still auto-scrolls to 07:00).
const DAY_START = 0; // 00:00
const DAY_END = 24 * 60; // 24:00
const PX_PER_HOUR = 52;
const PX_PER_MIN = PX_PER_HOUR / 60;
const GRID_HEIGHT = ((DAY_END - DAY_START) / 60) * PX_PER_HOUR;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Inline filter chips shown before collapsing the rest into a +N pill. */
const CHIP_LIMIT = 2;
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
// ORG clock, not the browser's — "now"/"today" must match the facility's timezone.
function nowMinutes(): number {
  return orgNow().minutes;
}
function orgTodayISO(): string {
  return orgNow().dateISO;
}
function shortDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function BookingsView() {
  const { state, actions } = useFloorplan();
  const meta = floorMeta(state, state.floorId);

  const [calView, setCalView] = useState<CalView>('week');
  const [focusDate, setFocusDate] = useState(state.date);
  const [category, setCategory] = useState<CategoryId>('all');
  // No resource dropdown anymore — this is set by clicking a Resource-grid row (or My bookings),
  // and only gates where drag-to-book CREATES; the calendar always shows the whole floor.
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [bookingsByDate, setBookingsByDate] = useState<Record<string, Booking[]>>({});
  const [calLoading, setCalLoading] = useState(true);
  /** Overlap-cluster preview modal target: rows derive live from bookingsByDate so a transition/refetch updates them. */
  const [preview, setPreview] = useState<{ date: string; ids: string[] } | null>(null);
  /** "My bookings" popup — every booking of the current user in the visible range (requested). */
  const [myOpen, setMyOpen] = useState(false);
  // PORTALS see only their own bookings (scoped server-side); MAINTENANCE sees everything.
  const [isPortal, setIsPortal] = useState(false);
  useEffect(() => {
    let alive = true;
    if (isFacilioApiConfigured) fetchCurrentApp().then((a) => alive && setIsPortal(!!a?.linkName && a.linkName !== 'maintenance')).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [refreshTick, setRefreshTick] = useState(0);
  // PORTFOLIO FILTER (approved design: button + popover tree below My bookings) — the applied
  // floors ride the range request as API filters (see fetchSpaceBookingsForRange floorIds),
  // never a client-side row filter. Names kept for the removable chips.
  const [floorFilter, setFloorFilter] = useState<{ id: string; name: string }[]>([]);
  // ORG-WIDE resource records (desks/rooms/parking everywhere, requested) — the current
  // floor's placed units still win on id collisions since they carry richer data.
  const [orgUnits, setOrgUnits] = useState<Unit[]>([]);
  useEffect(() => {
    let alive = true;
    if (isFacilioApiConfigured) fetchOrgBookableResources().then((u) => alive && setOrgUnits(u));
    return () => {
      alive = false;
    };
  }, []);

  const catDef = CATEGORIES.find((c) => c.id === category)!;

  const resources = useMemo(
    // Only actually bookable units belong on the booking calendar — for desks that's
    // HOT/HOTEL only (ASSIGNED desks are assignment-only; see lib/types DeskType).
    // UNPLACED records count too (requested): a bookable room with no zone drawn on the
    // plan is still a real, bookable resource here.
    () => {
      const localIds = new Set(state.units.map((u) => u.id));
      const pool = [...state.units, ...orgUnits.filter((u) => !localIds.has(u.id))];
      return pool
        .filter((u) => (category === 'all' ? BOOKABLE_TYPES.includes(u.type) : u.type === category) && isBookable(u))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    },
    [state.units, orgUnits, category]
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

  // ONE request for the whole visible range (week = 7 days, month = 42), grouped per-day
  // client-side — the per-day fan-out sprayed dozens of identical-shaped calls (reported).
  // `state.bookingsNonce` bumps whenever a booking is added/cancelled anywhere, so a booking made
  // through the shared form (which writes to global state, not this local cache) triggers a refetch.
  useEffect(() => {
    let cancelled = false;
    setCalLoading(true);
    const first = visibleDates[0];
    const last = visibleDates[visibleDates.length - 1];
    const load: Promise<Booking[]> = isFacilioApiConfigured
      ? fetchOrgBookingsForRange(first, last, {
          ...(isPortal ? { forCurrentUser: true } : {}),
          ...(floorFilter.length ? { floorIds: floorFilter.map((f) => f.id) } : {}),
          // Desks/Rooms tab scopes the FETCH by resource lookup (desk / space not-empty) —
          // switching category re-queries instead of showing unfiltered rows (reported).
          ...(category === 'workstation' ? { resourceField: 'desk' as const } : category === 'room' ? { resourceField: 'space' as const } : {}),
        }).catch(() => [] as Booking[])
      : Promise.all(visibleDates.map((d) => dataSource.getBookings(state.floorId, d).catch(() => [] as Booking[]))).then((r) => r.flat());
    load.then((rows) => {
      if (cancelled) return;
      const map: Record<string, Booking[]> = {};
      for (const d of visibleDates) map[d] = [];
      for (const b of rows) (map[b.date] ??= []).push(b);
      setBookingsByDate(map);
      setCalLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [state.floorId, visibleDates, state.bookingsNonce, refreshTick, isPortal, floorFilter, category]);

  const myBookingsInRange = useMemo(() => {
    const mine: Booking[] = [];
    for (const d of visibleDates) {
      for (const b of bookingsByDate[d] ?? []) {
        // PORTALS: the range fetch is already scoped SERVER-SIDE to this client contact
        // (reservedBy = the session's people id), so every fetched row is theirs — matching on
        // `by` again would drop rows whose reservedBy the list projection didn't return.
        // MAINTENANCE sees the whole org, so there the id match is what makes them "mine".
        if (isPortal || b.by === state.bookBy) mine.push(b);
      }
    }
    return mine;
  }, [bookingsByDate, visibleDates, state.bookBy, isPortal]);

  // The calendar shows EVERY booking on the floor for the date — no per-resource filter. The
  // resource picker only targets where drag-to-book CREATES a booking.
  function bookingsFor(date: string): Booking[] {
    // ALL fetched bookings render (org-wide) — the mine-only filter hid API rows whose
    // reservedBy wasn't exactly the session id (bookings made FOR someone else, unresolved
    // people id) and read as "records missing" (reported). The current user's own rows still
    // highlight blue via myId, and the My-bookings popup/badge stay user-filtered.
    return bookingsByDate[date] ?? [];
  }

  const selectedResource = resources.find((r) => r.id === resourceId) ?? null;

  // Dragging a window opens the shared booking form (prefilled) rather than booking instantly —
  // the actual create happens on form submit, and the nonce-driven effect above refetches.
  function openForm(date: string, start: number, end: number) {
    if (!catDef.bookable) return;
    // No bookable resource of this category: silently no-op (toast removed on request) —
    // the All-spaces form's own switch is the way to change type.
    if (!resourceId) return;
    // Booking-date window (mirrors the form's own validation): rooms are same-day only,
    // everything else books at most one week ahead. ISO strings compare lexicographically.
    const today = orgTodayISO();
    // ANY UPCOMING DAY is bookable — rooms included (requested: no same-day limit) — only the
    // past is refused. Duration rules live in the form: rooms a fixed 2h, desks up to 7 days.
    if (date < today) {
      actions.showToast('That day has already passed — pick an upcoming one');
      return;
    }
    // Today's already-started slots can't be booked — the backend bumps a past start to "now",
    // so the record would not match what was clicked.
    if (date === today) {
      // The ORG clock decides what's past (nowMinutes reads it) — this used `new Date()`, the
      // BROWSER clock, so a device running ahead of the facility rejected slots that were still
      // upcoming there (reported).
      if (start < nowMinutes()) {
        actions.showToast('That slot has already started — pick an upcoming one');
        return;
      }
    }
    if (conflictsFor(bookingsByDate[date] ?? [], resourceId, date, start, end).length) {
      actions.showToast('That window overlaps an existing booking');
      return;
    }
    // ALL SPACES mixes desks and rooms, so the form opens with the TYPE/FORM SWITCH enabled
    // (that flag is what shows it — without it the All-spaces form had no switch at all,
    // reported). A single-category tab books that type only, so no switch there.
    // The resource snapshot rides along: org-wide records aren't in state.units, and without it
    // the form can't name/keep the picked resource until the org pool lands.
    const picked = resources.find((r) => r.id === resourceId);
    actions.openBookingForm({
      unitId: resourceId,
      date,
      start,
      end,
      ...(category === 'all' ? { allowTypeSwitch: true } : {}),
      ...(picked ? { resourceUnit: picked } : {}),
    });
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

  /** Row click in the My-bookings popup: focus the calendar on that booking. */
  function jumpToBooking(b: Booking) {
    const unit = state.units.find((u) => u.id === b.unitId);
    if (unit && unit.type !== 'amenity') {
      setCategory(unit.type);
      setResourceId(unit.id);
    }
    setFocusDate(b.date);
    if (calView === 'month') setCalView('week');
    setMyOpen(false);
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
          <div className={styles.headerActions}>
            <PortfolioFilter applied={floorFilter} onApply={setFloorFilter} />
          </div>
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
              {/* The Calendar / Resource-grid switch is GONE (requested): the calendar is the only
                  layout, and MY BOOKINGS sits here in its place instead of up in the header. */}
              <button className={[styles.myBookings, myBookingsInRange.length ? styles.myBookingsActive : ''].join(' ')} onClick={() => setMyOpen(true)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                My bookings
                <span className={styles.myBadge}>{myBookingsInRange.length}</span>
              </button>
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
                <button className={styles.todayBtn} onClick={() => setFocusDate(orgTodayISO())}>Today</button>
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
            {calView === 'month' ? (
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

        {myOpen && (
          <Modal onClose={() => setMyOpen(false)} width={520}>
            <ModalHeader
              title="My bookings"
              subtitle={
                isPortal
                  ? `Your bookings · ${myBookingsInRange.length} in the visible range`
                  : `${myBookingsInRange.length} booking(s) in the visible range`
              }
              onClose={() => setMyOpen(false)}
            />
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '58vh', overflowY: 'auto' }}>
              {myBookingsInRange.length === 0 && (
                <p style={{ font: '400 13px/1.5 var(--font-sans)', color: 'var(--ink-500)', margin: 0 }}>
                  No bookings in the visible date range — switch to Week or Month to widen it.
                </p>
              )}
              {[...myBookingsInRange]
                .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date.localeCompare(b.date)))
                .map((b) => {
                  // Org-wide rows can reference a resource that isn't on the current floor —
                  // fall back to the org resource pool so the row still names its space.
                  const unit = state.units.find((u) => u.id === b.unitId) ?? orgUnits.find((u) => u.id === b.unitId);
                  return (
                    <div key={b.id} style={{ border: '1px solid var(--ink-200)', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <button
                          type="button"
                          data-tip="Show on the calendar"
                          onClick={() => jumpToBooking(b)}
                          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: '600 13.5px var(--font-sans)', color: 'var(--blue-600)', textAlign: 'left' }}
                        >
                          {unit?.label ?? b.name ?? `#${b.unitId}`}
                        </button>
                        <span style={{ font: '500 12px var(--font-sans)', color: 'var(--ink-600)', whiteSpace: 'nowrap' }}>
                          {parseISO(b.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · {fmtTime(b.start)}–{fmtTime(b.end)}
                        </span>
                      </div>
                      {b.purpose && <div style={{ font: '400 12.5px/1.4 var(--font-sans)', color: 'var(--ink-600)', marginTop: 2 }}>{b.purpose}</div>}
                      {/* Same stateflow bar as the day preview — Cancel/Approve/... per the record's state. */}
                      {/^\d+$/.test(b.id) ? (
                        <StateflowActions moduleName="spacebooking" recordId={Number(b.id)} onChanged={() => setRefreshTick((t) => t + 1)} />
                      ) : (
                        <Button variant="danger" style={{ marginTop: 8 }} onClick={() => cancelBooking(b)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  );
                })}
            </div>
          </Modal>
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
                  // Org-wide rows can reference a resource that isn't on the current floor —
                  // fall back to the org resource pool so the row still names its space.
                  const unit = state.units.find((u) => u.id === b.unitId) ?? orgUnits.find((u) => u.id === b.unitId);
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

function EmptyState({ category }: { category: string; floorName?: string }) {
  // The list is ORG-WIDE now — no floor in the copy.
  return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-300)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
      <div className={styles.emptyTitle}>No bookable {category.toLowerCase()} found</div>
      <div className={styles.emptySub}>Mark desks as hot desks or rooms as reservable in your org, then book them here.</div>
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

  const todayIso = orgTodayISO();
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
                        data-tip={`${fmtTime(cStart)} – ${fmtTime(cEnd)} · ${cluster.length} overlapping bookings — click to preview`}
                        data-tip-pos="top"
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
                      data-tip={
                        `${fmtTime(b.start)} – ${fmtTime(b.end)} · ` +
                        (mine ? 'Your booking' : `Booked by ${contactNameOf(b.by) || 'someone'}`) +
                        (b.approvalPending ? ' · pending approval' : '') +
                        ' — click to preview'
                      }
                      data-tip-pos="top"
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
  const todayIso = orgTodayISO();
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

/* ─────────────────────────── Portfolio filter ─────────────────────────── */

/**
 * "Filter" button + popover checkbox tree (Site → Building → Floor), per the approved
 * design sample. Buildings/floors LAZY-load on expand (same dataSource methods the
 * portfolio tab uses); a search box narrows loaded rows. Apply hands the drafted floors
 * up (the parent re-fetches with them IN the API request); Reset clears everything.
 */
function PortfolioFilter({ applied, onApply }: { applied: { id: string; name: string }[]; onApply: (floors: { id: string; name: string }[]) => void }) {
  const { state } = useFloorplan();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  /** Draft selection while the popover is open — floorId → floor name (for chips). */
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [buildingsBySite, setBuildingsBySite] = useState<Record<string, Building[]>>({});
  const [floorsByBuilding, setFloorsByBuilding] = useState<Record<string, Floor[]>>({});
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  const [openBuildings, setOpenBuildings] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // The portfolio tree in state may already carry children (site expanded elsewhere) —
  // use those; a cached [] from the lazy fetch means "loaded, none", null means "not yet".
  const buildingsOf = (site: Site): Building[] | null => (site.buildings.length ? site.buildings : buildingsBySite[site.id] ?? null);
  const floorsOf = (b: Building): Floor[] | null => (b.floors.length ? b.floors : floorsByBuilding[b.id] ?? null);

  const loadBuildings = async (site: Site): Promise<Building[]> => {
    const have = buildingsOf(site);
    if (have) return have;
    const list = await dataSource.getBuildingsForSite(site.id).catch(() => [] as Building[]);
    setBuildingsBySite((m) => ({ ...m, [site.id]: list }));
    return list;
  };
  const loadFloors = async (b: Building): Promise<Floor[]> => {
    const have = floorsOf(b);
    if (have) return have;
    const list = await dataSource.getFloorsForBuilding(b.id).catch(() => [] as Floor[]);
    setFloorsByBuilding((m) => ({ ...m, [b.id]: list }));
    return list;
  };

  // Chip labels carry the building for context — several buildings share floor names
  // ("Floor 1"), so a bare floor name on a chip is ambiguous.
  const chipLabel = (b: Building, f: Floor) => `${b.name} · ${f.name}`;

  const setAllOrNone = (entries: { id: string; name: string }[]) =>
    setDraft((d) => {
      const n = new Map(d);
      const allSelected = entries.length > 0 && entries.every((e) => n.has(e.id));
      if (allSelected) entries.forEach((e) => n.delete(e.id));
      else entries.forEach((e) => n.set(e.id, e.name));
      return n;
    });

  const toggleFloor = (b: Building, f: Floor) =>
    setDraft((d) => {
      const n = new Map(d);
      if (n.has(f.id)) n.delete(f.id);
      else n.set(f.id, chipLabel(b, f));
      return n;
    });
  const toggleBuilding = async (b: Building) => {
    setOpenBuildings((s) => new Set(s).add(b.id));
    setAllOrNone((await loadFloors(b)).map((f) => ({ id: f.id, name: chipLabel(b, f) })));
  };
  const toggleSite = async (site: Site) => {
    setOpenSites((s) => new Set(s).add(site.id));
    const bs = await loadBuildings(site);
    setOpenBuildings((s) => new Set([...s, ...bs.map((x) => x.id)]));
    const entries = await Promise.all(bs.map(async (b) => (await loadFloors(b)).map((f) => ({ id: f.id, name: chipLabel(b, f) }))));
    setAllOrNone(entries.flat());
  };

  const q = search.trim().toLowerCase();
  const hit = (name: string) => name.toLowerCase().includes(q);
  const siteVisible = (site: Site) =>
    !q || hit(site.name) || (buildingsOf(site) ?? []).some((b) => hit(b.name) || (floorsOf(b) ?? []).some((f) => hit(f.name)));

  const openPopover = () => {
    if (!open) setDraft(new Map(applied.map((f) => [f.id, f.name])));
    setOpen((o) => !o);
  };
  const reset = () => {
    setDraft(new Map());
    setSearch('');
    setOpen(false);
    onApply([]);
  };
  const apply = () => {
    setOpen(false);
    onApply(Array.from(draft, ([id, name]) => ({ id, name })));
  };

  const checkboxRef = (some: boolean, all: boolean) => (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = some && !all;
  };

  return (
    <div className={styles.filterWrap} ref={wrapRef}>
      <button className={[styles.myBookings, applied.length ? styles.myBookingsActive : ''].join(' ')} onClick={openPopover}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
        Filter
        {applied.length > 0 && <span className={styles.myBadge}>{applied.length}</span>}
      </button>
      {applied.length > 0 && (
        // Only the first TWO active filters render inline (each ellipsized) — twelve chips
        // overflowed the header row. The rest collapse into a +N pill that opens the panel,
        // where every active filter can be removed individually. The Filter button's badge
        // keeps showing the TRUE total.
        <div className={styles.filterChips}>
          {applied.slice(0, CHIP_LIMIT).map((f) => (
            <span key={f.id} className={styles.filterChip} data-tip={f.name} data-tip-align="end" data-tip-pos="top">
              <span className={styles.chipLabel}>{f.name}</span>
              <button className={styles.chipX} title="Remove" onClick={() => onApply(applied.filter((x) => x.id !== f.id))}>
                ×
              </button>
            </span>
          ))}
          {applied.length > CHIP_LIMIT && (
            <button
              type="button"
              className={styles.chipMore}
              title={`${applied.length - CHIP_LIMIT} more — open the filter to manage them`}
              onClick={openPopover}
            >
              +{applied.length - CHIP_LIMIT}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className={styles.filterPop}>
          {/* Active filters, all of them, each individually removable — the chip bar only shows
              the first two, so this list is where the rest get managed. Edits go through the
              SAME draft state the tree writes, so Apply/badge/results stay in sync. */}
          {draft.size > 0 && (
            <div className={styles.activeBox}>
              <div className={styles.activeHead}>
                <span>
                  Active filters <b>{draft.size}</b>
                </span>
                <button type="button" className={styles.clearAll} onClick={() => setDraft(new Map())}>
                  Clear all
                </button>
              </div>
              <div className={styles.activeList}>
                {Array.from(draft, ([id, name]) => (
                  <span key={id} className={styles.filterChip} data-tip={name}>
                    <span className={styles.chipLabel}>{name}</span>
                    <button
                      className={styles.chipX}
                      title="Remove"
                      onClick={() =>
                        setDraft((d) => {
                          const n = new Map(d);
                          n.delete(id);
                          return n;
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <input className={styles.filterSearch} placeholder="Search sites, buildings, floors…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div className={styles.filterTree}>
            {state.portfolio.filter(siteVisible).map((site) => {
              const expanded = q ? true : openSites.has(site.id);
              const bs = buildingsOf(site);
              const siteFloors = (bs ?? []).flatMap((b) => floorsOf(b) ?? []);
              const siteSel = siteFloors.filter((f) => draft.has(f.id)).length;
              const siteAll = siteFloors.length > 0 && siteSel === siteFloors.length;
              return (
                <div key={site.id}>
                  <label className={styles.filterRow}>
                    <input type="checkbox" checked={siteAll} ref={checkboxRef(siteSel > 0, siteAll)} onChange={() => void toggleSite(site)} />
                    <span className={styles.filterName}>{site.name}</span>
                    <button
                      className={styles.chevBtn}
                      onClick={(e) => {
                        e.preventDefault();
                        setOpenSites((s) => {
                          const n = new Set(s);
                          if (n.has(site.id)) n.delete(site.id);
                          else n.add(site.id);
                          return n;
                        });
                        void loadBuildings(site);
                      }}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                  </label>
                  {expanded && bs === null && <div className={styles.filterLoading}>Loading…</div>}
                  {expanded &&
                    (bs ?? [])
                      .filter((b) => !q || hit(site.name) || hit(b.name) || (floorsOf(b) ?? []).some((f) => hit(f.name)))
                      .map((b) => {
                        const bExpanded = q ? true : openBuildings.has(b.id);
                        const fls = floorsOf(b);
                        const bSel = (fls ?? []).filter((f) => draft.has(f.id)).length;
                        const bAll = (fls ?? []).length > 0 && bSel === (fls ?? []).length;
                        return (
                          <div key={b.id}>
                            <label className={[styles.filterRow, styles.filterRowL2].join(' ')}>
                              <input type="checkbox" checked={bAll} ref={checkboxRef(bSel > 0, bAll)} onChange={() => void toggleBuilding(b)} />
                              <span className={styles.filterName}>{b.name}</span>
                              <button
                                className={styles.chevBtn}
                                onClick={(e) => {
                                  e.preventDefault();
                                  setOpenBuildings((s) => {
                                    const n = new Set(s);
                                    if (n.has(b.id)) n.delete(b.id);
                                    else n.add(b.id);
                                    return n;
                                  });
                                  void loadFloors(b);
                                }}
                              >
                                {bExpanded ? '▾' : '▸'}
                              </button>
                            </label>
                            {bExpanded && fls === null && <div className={styles.filterLoading}>Loading…</div>}
                            {bExpanded &&
                              (fls ?? [])
                                .filter((f) => !q || hit(site.name) || hit(b.name) || hit(f.name))
                                .map((f) => (
                                  <label key={f.id} className={[styles.filterRow, styles.filterRowL3].join(' ')}>
                                    <input type="checkbox" checked={draft.has(f.id)} onChange={() => toggleFloor(b, f)} />
                                    <span className={styles.filterName}>{f.name}</span>
                                  </label>
                                ))}
                          </div>
                        );
                      })}
                </div>
              );
            })}
            {state.portfolio.filter(siteVisible).length === 0 && <div className={styles.filterLoading}>No matches</div>}
          </div>
          <div className={styles.filterFoot}>
            <button className={styles.filterReset} onClick={reset}>
              ⟲ Reset filter
            </button>
            <button className={styles.filterApply} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
