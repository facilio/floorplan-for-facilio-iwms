import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { clipPathFor } from '../../lib/geometry';
import { conflictsFor, isAssignable } from '../../state/selectors';
import { moduleColor } from '../../lib/unitStatus';
import type { PolyGeom, Unit } from '../../lib/types';

export function RoomPolygon({
  unit,
  onEditDown,
}: {
  unit: Unit;
  onEditDown?: (unit: Unit, e: ReactMouseEvent) => void;
}) {
  const { state, actions } = useFloorplan();
  const geom = unit.geom as PolyGeom;
  const selected = state.selected === unit.id;
  const movable = state.mode === 'edit' && state.tool === 'select';

  let fill: string;
  if (state.mode === 'edit') {
    fill = selected ? 'rgba(60,34,157,0.22)' : 'rgba(60,34,157,0.10)';
  } else if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      // Bookable room, viewed in Assign mode — solid neutral, matches Marker's not-assignable fill.
      fill = 'rgba(96,119,150,0.07)';
    } else {
      const assigned = !!state.assignments[unit.id];
      const c = moduleColor(state, 'room', assigned ? 'assigned' : 'free');
      fill = `color-mix(in srgb, ${c} ${selected ? 26 : 14}%, transparent)`;
    }
  } else {
    const booked = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end).length > 0;
    const base = booked ? '182,25,25' : '41,160,30';
    const alpha = selected ? 0.26 : 0.14;
    fill = `rgba(${base},${alpha})`;
  }

  function onClick(e: ReactMouseEvent) {
    if (state.mode === 'edit' && state.tool !== 'select') return;
    e.stopPropagation();
    actions.selectUnit(unit.id);
  }

  return (
    <div
      onClick={onClick}
      onMouseDown={movable && onEditDown ? (e) => onEditDown(unit, e) : undefined}
      style={{ position: 'absolute', inset: 0, clipPath: clipPathFor(geom), background: fill, cursor: movable ? 'move' : 'pointer' }}
    />
  );
}
