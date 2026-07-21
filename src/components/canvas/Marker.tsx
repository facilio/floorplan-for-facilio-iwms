import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { employeeName, myAssignedUnit } from '../../state/selectors';
import { markerStyle, unitStatus } from '../../lib/unitStatus';
import type { PointGeom, Unit } from '../../lib/types';
import { MARKER_ICONS as ICONS } from './markerIcons';
import styles from './Marker.module.css';

export function Marker({ unit, invZ, onDragStart }: { unit: Unit; invZ: number; onDragStart?: (unit: Unit, e: ReactMouseEvent) => void }) {
  const { state, actions } = useFloorplan();
  const geom = unit.geom as PointGeom;
  const style = markerStyle(state, unit);
  const status = unitStatus(state, unit, (id) => employeeName(state, id));
  const draggable = state.mode === 'edit' && state.tool === 'select';
  const isMine = myAssignedUnit(state)?.id === unit.id;
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
    const empId = state.dragEmpId || e.dataTransfer.getData('text/plain');
    if (empId) actions.assign(empId, unit.id);
  }

  const title = `${unit.label}${unit.room ? ' · ' + unit.room : ''} — ${status.text}`;

  // Under-marker label. Assign view: desk name on top, assignee (if any)
  // underneath. Book view: the space name. Amenities: their name, always.
  const empId = state.assignments[unit.id];
  const assignedName = state.mode === 'assign' && empId ? employeeName(state, empId) : null;
  const showLabel = (state.mode === 'assign' || state.mode === 'book' || unit.type === 'amenity') && invZ <= 1.9;

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
            {style.occText && <span style={{ font: '700 9px/1 var(--font-sans)' }}>{style.occText}</span>}
            {!style.occText && style.icon && ICONS[style.icon]}
          </>
        )}
      </div>
      {/* Primary name label ABOVE the marker (hidden when the "Your desk"
          pill already sits above it, to avoid stacking two labels). */}
      {showLabel && !isMine && (
        <div
          style={{
            position: 'absolute',
            left: `${geom.x * 100}%`,
            top: `${geom.y * 100}%`,
            transform: `translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 4)}px)) scale(${invZ})`,
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
      {/* Secondary label (assignee) BELOW the marker. */}
      {showLabel && assignedName && (
        <div
          style={{
            position: 'absolute',
            left: `${geom.x * 100}%`,
            top: `${geom.y * 100}%`,
            transform: `translate(-50%, ${Math.round(style.size / 2 + 4)}px) scale(${invZ})`,
            transformOrigin: 'top center',
            pointerEvents: 'none',
            zIndex: 1,
            font: '500 8px/1.1 var(--font-sans)',
            color: 'var(--ink-500)',
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid var(--ink-100)',
            padding: '2px 5px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
        >
          {assignedName}
        </div>
      )}
    </>
  );
}
