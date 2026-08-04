import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, myAssignedUnit } from '../../state/selectors';
import { markerStyle, unitStatus } from '../../lib/unitStatus';
import type { PointGeom, Unit } from '../../lib/types';
import { MARKER_ICONS as ICONS } from './markerIcons';
import styles from './Marker.module.css';

export function Marker({ unit, invZ, onDragStart, myUnitId, labelVisible }: { unit: Unit; invZ: number; onDragStart?: (unit: Unit, e: ReactMouseEvent) => void; myUnitId?: string | null; labelVisible?: boolean }) {
  const { state, actions } = useFloorplan();
  const geom = unit.geom as PointGeom;
  const style = markerStyle(state, unit);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const draggable = state.mode === 'edit' && state.tool === 'select';
  // Prefer the parent-computed id: myAssignedUnit is a full assignments scan, and running it in
  // every marker made pan/zoom frames O(markers × assignments). The fallback keeps call sites
  // that don't pass it (mobile) working.
  const isMine = (myUnitId !== undefined ? myUnitId : myAssignedUnit(state)?.id) === unit.id;
  const isHighlighted = state.highlightUnitId === unit.id;

  function onClick(e: ReactMouseEvent) {
    e.stopPropagation();
    if (state.mode === 'edit' && state.tool !== 'select') return;
    actions.selectUnit(unit.id);
  }

  function onMouseDown(e: ReactMouseEvent) {
    if (draggable) onDragStart?.(unit, e);
  }

  // Edit mode: a tray-record drag of the SAME type may drop onto this marker — the dragged
  // record replaces this one's (this record moves to "Available to place"). The dragged unit's
  // type travels as an extra mime suffix because dragover can only read types, not data.
  const replaceMime = `application/x-floorplan-unit-t-${unit.type}`;
  function isReplaceDrag(e: ReactDragEvent): boolean {
    return state.mode === 'edit' && unit.type !== 'room' && e.dataTransfer.types.includes(replaceMime);
  }

  function onDragOver(e: ReactDragEvent) {
    if (state.mode === 'edit') {
      if (!isReplaceDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (state.dragOverId !== unit.id) actions.dragOverUnit(unit.id);
      return;
    }
    if (state.mode !== 'assign') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (state.dragOverId !== unit.id) actions.dragOverUnit(unit.id);
  }
  function onDragLeave() {
    if (state.dragOverId === unit.id) actions.dragOverUnit(null);
  }
  function onDrop(e: ReactDragEvent) {
    if (state.mode === 'edit') {
      if (!isReplaceDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      actions.dragOverUnit(null);
      const unitId = e.dataTransfer.getData('application/x-floorplan-unit');
      if (unitId && unitId !== unit.id) actions.placeUnitOnUnit(unitId, unit.id);
      return;
    }
    if (state.mode !== 'assign') return;
    e.preventDefault();
    const contactId = state.dragContactId || e.dataTransfer.getData('text/plain');
    if (contactId) actions.assign(contactId, unit.id);
  }

  const title = `${unit.label}${unit.room ? ' · ' + unit.room : ''} — ${status.text}`;

  // labelVisible: the parent's decluttering verdict (dense grids keep only non-colliding
  // labels) — callers that don't pass it (mobile) show all labels as before.
  const showLabel = (state.mode === 'assign' || state.mode === 'book' || unit.type === 'amenity') && invZ <= 1.9 && labelVisible !== false;

  return (
    <>
      {isMine && (
        <div
          className={styles.myDeskBadge}
          style={{ left: `${geom.x * 100}%`, top: `${geom.y * 100}%`, transform: `translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 6)}px)) scale(${invZ})`, transformOrigin: 'bottom center' }}
        >
          <div className={styles.myDeskPill}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            Your desk
          </div>
          <div className={styles.myDeskTail} />
        </div>
      )}
      <div
        title={title}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          position: 'absolute',
          left: `${geom.x * 100}%`,
          top: `${geom.y * 100}%`,
          width: style.size,
          height: style.size,
          transform: `translate(-50%,-50%) scale(${invZ})`,
          background: style.bg,
          border: `2px solid ${style.bd}`,
          color: style.fg,
          borderRadius: style.radius,
          boxShadow: style.shadow,
          opacity: style.opacity,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: draggable ? 'grab' : 'pointer',
          zIndex: style.zIndex,
        }}
      >
        {isHighlighted && <div className={styles.wave} />}
        {style.img ? (
          <img src={style.img} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', pointerEvents: 'none' }} />
        ) : (
          <>
            {/* Chips compacted below ~15px (dense pods) drop their glyph — a 9px monogram
                overflowing a 12px chip reads as noise, the color already carries the state. */}
            {style.size >= 15 && style.occText && <span style={{ font: '700 9px/1 var(--font-sans)' }}>{style.occText}</span>}
            {style.size >= 15 && !style.occText && style.icon && ICONS[style.icon]}
          </>
        )}
      </div>
      {/* ONE label only — the MARKER's own label, tight above the icon; assignee/desk details
          show on CLICK (the details panel / tooltip), not as a second chip. Hidden when the
          "Your desk" pill sits above. The gap SCALES with the marker ((size/2+2) * invZ): a fixed
          pixel offset overlapped the icon when zoomed out (marker visually larger than the gap)
          and floated far away when zoomed in. */}
      {showLabel && !isMine && (
        <div
          style={{
            position: 'absolute',
            left: `${geom.x * 100}%`,
            top: `${geom.y * 100}%`,
            transform: `translate(-50%, -100%) translate(0, -${Math.round((style.size / 2 + 2) * invZ)}px) scale(${invZ})`,
            transformOrigin: 'bottom center',
            pointerEvents: 'none',
            zIndex: 1,
            font: '600 8.5px/1.1 var(--font-sans)',
            color: 'var(--ink-700)',
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid var(--ink-100)',
            padding: '2px 5px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
        >
          {unit.label}
        </div>
      )}
    </>
  );
}
