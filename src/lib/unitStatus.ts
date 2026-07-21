import type { AppState } from '../state/types';
import { conflictsFor, isAssignable, isBookable } from '../state/selectors';
import { resolveMarkerDef, STATE_DEFS } from './types';
import type { Unit } from './types';
import { fmtTime } from './geometry';

export function moduleColor(state: AppState, type: Unit['type'], key: string): string {
  const override = state.moduleColors[`${type}.${key}`];
  if (override) return override;
  const def = STATE_DEFS[type]?.find((s) => s.key === key);
  return def ? def.def : '#607796';
}

/** A pale wash of a state color for a marker's fill (border/text stay the saturated color). */
function tint(color: string): string {
  return `color-mix(in srgb, ${color} 16%, #fff)`;
}

export interface UnitStatus {
  key: string;
  text: string;
  bg: string;
  fg: string;
  dot: string;
}

const TOKEN = {
  success050: 'var(--success-050)',
  success700: 'var(--success-700)',
  danger050: 'var(--danger-050)',
  danger700: 'var(--danger-700)',
  blue050: 'var(--blue-050)',
  blue700: 'var(--blue-700)',
  ink100: 'var(--ink-100)',
  ink600: 'var(--ink-600)',
};

export interface MarkerStyle {
  bg: string;
  bd: string;
  fg: string;
  opacity: number;
  shadow: string;
  size: number;
  radius: string;
  zIndex: number;
  occText: string | null;
  icon: 'workstation' | 'locker' | 'parking' | 'asset' | 'fire' | 'stairs' | 'elevator' | 'restroom' | null;
  /** Custom library markers with an image chip render this instead of a glyph/text. */
  img?: string;
}

export function markerStyle(state: AppState, unit: Unit, markerScale = 1): MarkerStyle {
  const size = Math.round(24 * markerScale);
  const radius = unit.type === 'parking' ? '999px' : unit.type === 'locker' ? '4px' : '6px';
  const selected = state.selected === unit.id || state.multiSelected.includes(unit.id);
  // In edit mode, hovering a compatible drag over a marker rings it green — the drop
  // will REPLACE this marker's record (see placeUnitOnUnit), not stack a second one.
  const dropTarget = state.mode === 'edit' && state.dragOverId === unit.id;
  const shadow = dropTarget ? '0 0 0 4px rgba(41,160,30,0.4)' : selected ? '0 0 0 3px rgba(0,89,214,0.28)' : 'var(--shadow-xs)';
  const zIndex = dropTarget ? 6 : selected ? 5 : 2;
  const empId = state.assignments[unit.id];

  // Amenity markers are informational in every mode: FILLED with the marker's
  // own color (stairs teal, elevator amber, …) with a white glyph / short text
  // label / image chip, so the type is obvious by color. Never faded.
  if (unit.type === 'amenity') {
    const def = resolveMarkerDef(state.customMarkers, unit);
    return {
      bg: def.color,
      bd: def.color,
      fg: '#fff',
      opacity: 1,
      shadow,
      size,
      radius: '8px',
      zIndex,
      occText: def.icon || def.img ? null : (def.text ?? '?').slice(0, 2),
      icon: def.icon ?? null,
      img: def.img,
    };
  }

  if (state.mode === 'edit') {
    if (selected) {
      return { bg: 'var(--blue-500)', bd: 'var(--blue-500)', fg: '#fff', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: null };
    }
    if (unit.type === 'locker') {
      return { bg: '#fff', bd: 'var(--brand-indigo-400)', fg: 'var(--brand-indigo)', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: 'locker' };
    }
    if (unit.type === 'parking') {
      return { bg: '#fff', bd: 'var(--ink-500)', fg: 'var(--ink-700)', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: 'parking' };
    }
    return { bg: '#fff', bd: 'var(--blue-300)', fg: 'var(--blue-600)', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: unit.type === 'workstation' ? 'workstation' : null };
  }

  if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      // solid neutral, NOT a washed-out ghost — every marker stays legible
      return { bg: 'var(--ink-100)', bd: 'var(--ink-500)', fg: 'var(--ink-600)', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
    }
    if (state.dragOverId === unit.id) {
      return { bg: 'var(--blue-100)', bd: 'var(--blue-500)', fg: 'var(--blue-700)', opacity: 1, shadow: '0 0 0 4px rgba(0,89,214,0.22)', size, radius, zIndex: 6, occText: empId ? initialsOf(employeeNameFallback(state, empId)) : null, icon: empId ? null : markerIcon(unit.type) };
    }
    if (empId) {
      // Occupied desk: solid fill in the configurable "assigned" color, white initials.
      const c = moduleColor(state, unit.type, 'assigned');
      return { bg: c, bd: c, fg: '#fff', opacity: 1, shadow, size, radius, zIndex, occText: initialsOf(employeeNameFallback(state, empId)), icon: null };
    }
    const free = moduleColor(state, unit.type, 'free');
    return { bg: tint(free), bd: free, fg: free, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
  }

  // book mode
  if (!isBookable(unit)) {
    // Previously 35%-opacity white — assigned desks were invisible on the
    // plan. Solid grey chip instead, with the occupant's initials so the
    // booking view still says whose desk it is.
    return {
      bg: 'var(--ink-100)',
      bd: 'var(--ink-500)',
      fg: 'var(--ink-600)',
      opacity: 1,
      shadow,
      size,
      radius,
      zIndex,
      occText: empId ? initialsOf(employeeNameFallback(state, empId)) : null,
      icon: empId ? null : markerIcon(unit.type),
    };
  }
  const conflicts = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end);
  if (conflicts.length) {
    const c = moduleColor(state, unit.type, 'booked');
    return { bg: tint(c), bd: c, fg: c, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
  }
  // bookable + free/available — the configurable "go" color.
  const avail = moduleColor(state, unit.type, unit.type === 'room' ? 'available' : 'free');
  return { bg: tint(avail), bd: avail, fg: avail, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
}

function markerIcon(type: Unit['type']): MarkerStyle['icon'] {
  if (type === 'workstation') return 'workstation';
  if (type === 'locker') return 'locker';
  if (type === 'parking') return 'parking';
  return null;
}
function initialsOf(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
function employeeNameFallback(state: AppState, empId: string): string {
  return state.employees.find((e) => e.id === empId)?.name ?? empId;
}

export function unitStatus(state: AppState, unit: Unit, employeeName: (id: string) => string): UnitStatus {
  if (unit.type === 'amenity') {
    const name = unit.markerKind || unit.icon ? resolveMarkerDef(state.customMarkers, unit).name : 'Amenity';
    return { key: 'amenity', text: name, bg: TOKEN.ink100, fg: TOKEN.ink600, dot: 'var(--ink-500)' };
  }
  if (state.mode === 'edit') {
    const name = { workstation: 'Desk', locker: 'Locker', parking: 'Parking stall', room: 'Room', amenity: 'Amenity' }[unit.type];
    return { key: 'type', text: name, bg: TOKEN.ink100, fg: TOKEN.ink600, dot: moduleColor(state, unit.type, 'free') };
  }
  if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      return { key: 'na', text: 'Not assignable', bg: TOKEN.ink100, fg: TOKEN.ink600, dot: 'var(--ink-400)' };
    }
    const empId = state.assignments[unit.id];
    if (empId) {
      return {
        key: 'assigned',
        text: `Assigned · ${employeeName(empId)}`,
        bg: TOKEN.blue050,
        fg: TOKEN.blue700,
        dot: moduleColor(state, unit.type, 'assigned'),
      };
    }
    return { key: 'free', text: 'Free', bg: TOKEN.success050, fg: TOKEN.success700, dot: moduleColor(state, unit.type, 'free') };
  }
  // book mode
  if (!isBookable(unit)) {
    const empId = state.assignments[unit.id];
    return {
      key: 'notBookable',
      // whose desk it is stays visible from the booking tab too
      text: empId ? `Assigned · ${employeeName(empId)}` : 'Not bookable',
      bg: TOKEN.ink100,
      fg: TOKEN.ink600,
      dot: 'var(--ink-400)',
    };
  }
  const conflicts = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end);
  if (conflicts.length) {
    return {
      key: 'booked',
      text: `Booked ${fmtTime(conflicts[0].start)}–${fmtTime(conflicts[0].end)}`,
      bg: TOKEN.danger050,
      fg: TOKEN.danger700,
      dot: moduleColor(state, unit.type, 'booked'),
    };
  }
  return { key: 'available', text: 'Available', bg: TOKEN.success050, fg: TOKEN.success700, dot: moduleColor(state, unit.type, unit.type === 'room' ? 'available' : 'free') };
}
