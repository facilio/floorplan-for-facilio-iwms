import { useEffect, useMemo, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { fitView, fmtTime, polygonCentroid, zoomAt } from '../../lib/geometry';
import type { ViewTransform } from '../../lib/geometry';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { FloorplanBackground } from '../canvas/FloorplanBackground';
import { MobileFloorPicker } from './MobileFloorPicker';
import { MobileUnitSheet } from './MobileUnitSheet';
import { MobileTimePicker } from './MobileTimePicker';
import { MobileQrScanner } from './MobileQrScanner';
import { MobileSpacesSheet } from './MobileSpacesSheet';
import { MobileMyBookings } from './MobileMyBookings';
import { MobileDatePicker } from './MobileDatePicker';
import { FloorplanSkeleton } from '../canvas/FloorplanSkeleton';
import { markerStyle } from '../../lib/unitStatus';
import { MARKER_ICONS } from '../canvas/markerIcons';
import { contactName, myAssignedUnit } from '../../state/selectors';
import { floorImageKey } from '../../lib/types';
import type { Unit } from '../../lib/types';
import styles from './MobileApp.module.css';

interface MobileAppProps {
  mode: 'page' | 'docked' | 'fullscreen';
  onClose?: () => void;
}

export function MobileApp({ mode, onClose }: MobileAppProps) {
  const { state, actions } = useFloorplan();
  const meta = floorMeta(state, state.floorId);
  // Same rule as PortfolioTree: the static floor flag OR a plan discovered at runtime (real fetch
  // / this-session upload). The flag alone hid real floors behind "No floorplan" on mobile while
  // the web canvas rendered them fine. A loaded image for the active plan also counts.
  const hasPlan = !!meta?.floor.hasPlan || !!state.floorsWithPlans[state.floorId] || !!state.floorImages[floorImageKey(state.floorId, state.planId)];
  const myUnit = myAssignedUnit(state);
  const [qrOpen, setQrOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [myBookingsOpen, setMyBookingsOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const myBookingsCount = state.bookings.filter((b) => b.by === state.bookBy).length;

  // Memoized: the mobile map re-renders per pan/zoom frame; units only change on real edits.
  const rooms = useMemo(() => state.units.filter((u) => u.type === 'room' && u.geom.kind === 'poly'), [state.units]);
  const markers = useMemo(() => state.units.filter((u) => u.type !== 'room' && u.geom.kind === 'point'), [state.units]);

  const legend =
    state.mobileTab === 'assign'
      ? [
          { label: 'Free', color: 'var(--success-500)' },
          { label: 'Assigned', color: 'var(--blue-500)' },
        ]
      : [
          { label: 'Available', color: 'var(--success-500)' },
          { label: 'Booked', color: 'var(--danger-500)' },
        ];

  const outerClass = mode === 'page' ? styles.page : mode === 'fullscreen' ? styles.fullscreen : styles.docked;

  return (
    <div className={[styles.outer, outerClass].join(' ')}>
      {mode === 'fullscreen' && (
        <div className={styles.chromeRow}>
          <span className={styles.chromeBadge}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <path d="M11 18h2" />
            </svg>
            Mobile preview
          </span>
          <button className={styles.chromeClose} onClick={onClose} title="Close mobile preview">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className={mode === 'page' ? styles.bezelless : styles.bezel}>
        <div className={styles.screen}>
          {mode !== 'page' && (
            <div className={styles.statusBar}>
              <span>9:41</span>
              <span className={styles.notch} />
            </div>
          )}

          <div className={styles.header}>
            <div className={styles.headerRow}>
              <button className={styles.floorSwitch} onClick={() => actions.setMobFloorOpen(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="2" width="16" height="20" rx="1" />
                  <path d="M4 8h16M4 13h16M4 18h16" />
                </svg>
                <span className={styles.floorLabel}>{meta ? `${meta.floor.name} · ${meta.building.name}` : 'Choose floor'}</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {myUnit ? (
                <button className={styles.locateBtn} onClick={() => actions.setMobSel(myUnit.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                  Locate
                </button>
              ) : (
                <span className={styles.dateStatic}>{new Date(state.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              )}
              <button className={styles.qrBtn} onClick={() => setMyBookingsOpen(true)} title="My bookings" aria-label="My bookings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                  <path d="M8 15l3 3 5-6" />
                </svg>
                {myBookingsCount > 0 && <span className={styles.iconBadge}>{myBookingsCount}</span>}
              </button>
              <button className={styles.qrBtn} onClick={() => setQrOpen(true)} title="Scan a space QR" aria-label="Scan a space QR">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <path d="M14 14h3v3M21 14v7h-7" />
                </svg>
              </button>
            </div>

            <div className={styles.tabs}>
              <button className={state.mobileTab === 'book' ? styles.tabActive : styles.tab} onClick={() => actions.setMobileTab('book')}>
                Book
              </button>
              <button className={state.mobileTab === 'assign' ? styles.tabActive : styles.tab} onClick={() => actions.setMobileTab('assign')}>
                Assign
              </button>
            </div>

            {state.mobileTab === 'book' && (
              <div className={styles.slotPicker}>
                <button className={styles.slotDateField} onClick={() => setDateOpen(true)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="17" rx="2" />
                    <path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  <div className={styles.slotDateText}>
                    <span className={styles.slotFieldLabel}>Date</span>
                    <span className={styles.slotDateValue}>
                      {new Date(state.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <div className={styles.slotTimeRow}>
                  <TimeField label="Start" value={state.start} active={state.mobTimePick === 'start'} onClick={() => actions.setMobTimePick(state.mobTimePick === 'start' ? null : 'start')} />
                  <svg className={styles.slotArrow} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  <TimeField label="End" value={state.end} active={state.mobTimePick === 'end'} onClick={() => actions.setMobTimePick(state.mobTimePick === 'end' ? null : 'end')} />
                  <span className={styles.slotDuration}>{fmtDuration(state.end - state.start)}</span>
                </div>
              </div>
            )}
          </div>

          <div className={styles.body}>
            {state.floorImageLoading || state.loading ? (
              <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <FloorplanSkeleton />
              </div>
            ) : hasPlan ? (
              <MobileMap rooms={rooms} markers={markers} legend={legend} onOpenSpaces={() => setSpacesOpen(true)} />
            ) : (
              <div className={styles.noPlan}>
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--ink-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 3L4 5v16l5-2 6 2 5-2V3l-5 2-6-2z M9 3v16M15 5v16" />
                </svg>
                <div className={styles.noPlanTitle}>No floorplan for this floor</div>
                <div className={styles.noPlanSub}>Choose another floor from the switcher above.</div>
              </div>
            )}
          </div>

          <MobileTimePicker />
          <MobileFloorPicker />
          <MobileUnitSheet />
          <MobileSpacesSheet open={spacesOpen} onClose={() => setSpacesOpen(false)} />
          <MobileMyBookings open={myBookingsOpen} onClose={() => setMyBookingsOpen(false)} />
          <MobileDatePicker open={dateOpen} onClose={() => setDateOpen(false)} />
          {qrOpen && <MobileQrScanner onClose={() => setQrOpen(false)} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Pan/zoomable plan viewport for the mobile experience — the plan used to be a fixed 1492px
 * plane crammed inside a small overflow-hidden card (cropped to the top-left corner, no way to
 * see the rest). Supports one-finger drag to pan, two-finger pinch to zoom, double-tap to
 * toggle zoom, mouse-drag/wheel (for the desktop viewport preview), and +/- buttons.
 */
function MobileMap({
  rooms,
  markers,
  legend,
  onOpenSpaces,
}: {
  rooms: Unit[];
  markers: Unit[];
  legend: { label: string; color: string }[];
  onOpenSpaces: () => void;
}) {
  const { state, actions } = useFloorplan();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform | null>(null);
  const viewRef = useRef<ViewTransform | null>(null);
  viewRef.current = view;
  const gesture = useRef<{ mode: 'pan' | 'pinch'; startView: ViewTransform; sx: number; sy: number; startDist?: number; midX?: number; midY?: number } | null>(null);
  const lastTap = useRef(0);

  // Fit-to-card on mount and whenever the floor/plan changes; ResizeObserver keeps the initial
  // fit correct once the card actually has a measured size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 20) setView(fitView(r.width, r.height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.floorId, state.planId]);

  // Native (non-passive) touch listeners — React's synthetic touch events are passive, so
  // preventDefault there can't stop the page/pull-to-refresh from scrolling with the gesture.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    function dist(t: TouchList) {
      return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }

    function onTouchStart(e: TouchEvent) {
      const v = viewRef.current;
      if (!v) return;
      if (e.touches.length === 2) {
        const r = el!.getBoundingClientRect();
        gesture.current = {
          mode: 'pinch',
          startView: v,
          sx: 0,
          sy: 0,
          startDist: dist(e.touches),
          midX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
          midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
        };
      } else if (e.touches.length === 1) {
        gesture.current = { mode: 'pan', startView: v, sx: e.touches[0].clientX, sy: e.touches[0].clientY };
      }
    }
    function onTouchMove(e: TouchEvent) {
      const g = gesture.current;
      if (!g) return;
      e.preventDefault();
      if (g.mode === 'pinch' && e.touches.length === 2 && g.startDist) {
        const factor = dist(e.touches) / g.startDist;
        setView(zoomAt(g.startView, factor, g.midX!, g.midY!));
      } else if (g.mode === 'pan' && e.touches.length === 1) {
        setView({ ...g.startView, tx: g.startView.tx + (e.touches[0].clientX - g.sx), ty: g.startView.ty + (e.touches[0].clientY - g.sy) });
      }
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length === 0) {
        gesture.current = null;
        // Double-tap toggles between fit and 2.5x.
        const now = Date.now();
        if (now - lastTap.current < 300) {
          const r = el!.getBoundingClientRect();
          const fitted = fitView(r.width, r.height);
          const v = viewRef.current;
          setView(v && v.z > fitted.z * 1.3 ? fitted : zoomAt(fitted, 2.5, r.width / 2, r.height / 2));
        }
        lastTap.current = now;
      }
    }
    function onWheel(e: WheelEvent) {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      const r = el!.getBoundingClientRect();
      setView(zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  function onMouseDown(e: React.MouseEvent) {
    const v = viewRef.current;
    if (!v || e.button !== 0) return;
    const start = { sx: e.clientX, sy: e.clientY, sv: v };
    function move(ev: MouseEvent) {
      setView({ ...start.sv, tx: start.sv.tx + (ev.clientX - start.sx), ty: start.sv.ty + (ev.clientY - start.sy) });
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function zoomBtn(factor: number) {
    const el = wrapRef.current;
    const v = viewRef.current;
    if (!el || !v) return;
    const r = el.getBoundingClientRect();
    setView(zoomAt(v, factor, r.width / 2, r.height / 2));
  }

  const v = view ?? { tx: 0, ty: 0, z: 0.2 };
  const invZ = 1 / v.z;

  return (
    <div ref={wrapRef} className={styles.mapCard} onMouseDown={onMouseDown} style={{ touchAction: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: IMG_W,
          height: IMG_H,
          transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`,
          transformOrigin: '0 0',
        }}
      >
        <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
        <svg style={{ position: 'absolute', inset: 0 }} width={IMG_W} height={IMG_H} viewBox={`0 0 ${IMG_W} ${IMG_H}`}>
          {rooms.map((r) => {
            if (r.geom.kind !== 'poly') return null;
            const c = polygonCentroid(r.geom.pts);
            const scale = Math.min(invZ, 3.5);
            const selected = state.mobSel === r.id;
            return (
              <g key={r.id}>
                <polygon
                  points={r.geom.pts.map(([x, y]) => `${x * IMG_W},${y * IMG_H}`).join(' ')}
                  fill={roomFill(state.mobileTab, state.bookings, r.id, state.date, state.start, state.end, selected)}
                  stroke={selected ? 'var(--blue-600)' : 'rgba(96,119,150,0.5)'}
                  strokeWidth={(selected ? 3 : 1.5) * scale}
                  style={{ cursor: 'pointer' }}
                  onClick={() => actions.setMobSel(r.id)}
                />
                {/* room name at the centroid — halo keeps it readable over plan linework */}
                <text
                  x={c.x * IMG_W}
                  y={c.y * IMG_H}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={Math.min(15 * scale, 34)}
                  fontWeight={700}
                  fill="var(--ink-900)"
                  stroke="#fff"
                  strokeWidth={Math.min(5 * scale, 11)}
                  paintOrder="stroke"
                  style={{ pointerEvents: 'none', fontFamily: 'var(--font-sans)' }}
                >
                  {r.label}
                </text>
              </g>
            );
          })}
        </svg>
        {markers.map((m) => {
          if (m.geom.kind !== 'point') return null;
          const selected = state.mobSel === m.id;
          const contactId = state.assignments[m.id];
          const contact = contactId ? contactName(state, contactId) : null;
          // Same palette as the web: markerStyle keyed on a mode synced to the
          // mobile tab, so bg / border / fill are identical across views.
          const ms = markerStyle({ ...state, mode: state.mobileTab } as typeof state, m);
          // labels appear once zoomed in enough to not collide; the selected pin always shows
          const showLabel = v.z >= 0.5 || selected;
          return (
            <button
              key={m.id}
              className={styles.marker}
              style={{
                left: `${m.geom.x * 100}%`,
                top: `${m.geom.y * 100}%`,
                transform: `translate(-50%, -50%) scale(${Math.min(invZ, 3.5)})`,
                zIndex: selected ? 3 : showLabel ? 2 : 1,
              }}
              onClick={() => actions.setMobSel(m.id)}
            >
              <span
                className={styles.markerDot}
                style={{
                  background: ms.bg,
                  border: `2px solid ${ms.bd}`,
                  color: ms.fg,
                  // Mobile keeps circular dots (clearer at small size) while
                  // still using the web's bg/border colors.
                  borderRadius: '999px',
                  boxShadow: selected ? '0 0 0 3px rgba(0,89,214,0.35)' : 'var(--shadow-xs)',
                }}
              >
                {/* initials when assigned, otherwise the type/amenity glyph */}
                {ms.occText ?? (ms.icon ? MARKER_ICONS[ms.icon] : null)}
              </span>
              {showLabel && (
                <span className={styles.markerLabel}>
                  <span className={styles.markerLabelName}>{m.label}</span>
                  {contact && <span className={styles.markerLabelSub}>{contact}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button className={styles.countPill} onClick={onOpenSpaces}>
        {markers.length + rooms.length} spaces
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      <div className={styles.legend}>
        {legend.map((l) => (
          <span key={l.label} className={styles.legendChip}>
            <span className={styles.legendDot} style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      <div className={styles.zoomBtns}>
        <button className={styles.zoomBtn} onClick={() => zoomBtn(1.4)} title="Zoom in">+</button>
        <button className={styles.zoomBtn} onClick={() => zoomBtn(1 / 1.4)} title="Zoom out">−</button>
      </div>
    </div>
  );
}

function TimeField({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button className={[styles.timeFieldBtn, active ? styles.timeFieldBtnActive : ''].join(' ')} onClick={onClick}>
      <span className={styles.slotFieldLabel}>{label}</span>
      <span className={styles.timeFieldValue}>{fmtTime(value)}</span>
    </button>
  );
}

/** "1h", "1h 30m", "45m" for the booking-window duration chip. */
function fmtDuration(mins: number): string {
  if (mins <= 0) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

// Matches the web RoomPolygon fills exactly (keyed on the mobile tab, which
// is the mobile equivalent of the desktop mode).
function roomFill(tab: string, bookings: any[], unitId: string, date: string, start: number, end: number, selected: boolean) {
  if (tab === 'book') {
    const booked = bookings.some((b) => b.unitId === unitId && b.date === date && b.start < end && b.end > start);
    const base = booked ? '182,25,25' : '41,160,30';
    return `rgba(${base},${selected ? 0.26 : 0.14})`;
  }
  return 'rgba(96,119,150,0.07)';
}
