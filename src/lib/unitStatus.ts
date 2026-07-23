import type { AppState } from '../state/types';
import { conflictsFor, isAssignable, isBookable } from '../state/selectors';
import { floorImageKey, resolveMarkerDef, STATE_DEFS } from './types';
import type { BookingStateColors, FloorplanCustomization, LabelSpec, Unit } from './types';
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

/**
 * The real org's rendering rules for the active floor+plan, if fetched (see
 * `fetchFloorplanCustomization` / `SET_FLOOR_CUSTOMIZATION`). Null means fall back to this app's
 * own configurable colors below — either it hasn't loaded yet, or this floor+plan has none.
 */
function customizationFor(state: AppState): FloorplanCustomization | null {
  return state.floorCustomizations[floorImageKey(state.floorId, state.planId)] ?? null;
}

/** Point markers (workstation/locker/parking, all backed by a desk-like record) vs. polygon rooms — the real schema's two label/color families. */
function categoryOf(type: Unit['type']): 'desk' | 'space' {
  return type === 'room' ? 'space' : 'desk';
}

/** Strips alpha from a real `rgba(...)` state color so a marker's border/text stays legible even when its fill is a translucent real-org color. Non-rgba input passes through unchanged. */
function opaque(color: string): string {
  const m = color.match(/^rgba?\(([^,]+),([^,]+),([^,]+)/);
  return m ? `rgb(${m[1].trim()},${m[2].trim()},${m[3].trim()})` : color;
}

function realBookColor(cust: FloorplanCustomization | null, category: 'desk' | 'space', key: keyof BookingStateColors): string | null {
  const s = category === 'space' ? cust?.spaceBookingState : cust?.deskBookingState;
  const c = s?.[key];
  return typeof c === 'string' && c.trim() ? c : null;
}

function realAssignColor(cust: FloorplanCustomization | null, occupied: boolean): string | null {
  const s = cust?.assignmentState;
  const c = occupied ? s?.assignedColor : s?.unAssignedColor;
  return typeof c === 'string' && c.trim() ? c : null;
}

/** bg/bd/fg triple for a state: the real org's color when available (translucent fill, opaque border/text — mirrors the tint()+saturated pattern below), else this app's own configurable color. */
function colorTriple(real: string | null, fallback: string, solidFallback: boolean): { bg: string; bd: string; fg: string } {
  if (real) {
    const solid = opaque(real);
    return { bg: real, bd: solid, fg: solid };
  }
  return solidFallback ? { bg: fallback, bd: fallback, fg: '#fff' } : { bg: tint(fallback), bd: fallback, fg: fallback };
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
  const contactId = state.assignments[unit.id];

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

  const cust = customizationFor(state);
  const category = categoryOf(unit.type);

  if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      // solid neutral, NOT a washed-out ghost — every marker stays legible
      return { bg: 'var(--ink-100)', bd: 'var(--ink-500)', fg: 'var(--ink-600)', opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
    }
    if (state.dragOverId === unit.id) {
      return { bg: 'var(--blue-100)', bd: 'var(--blue-500)', fg: 'var(--blue-700)', opacity: 1, shadow: '0 0 0 4px rgba(0,89,214,0.22)', size, radius, zIndex: 6, occText: contactId ? initialsOf(contactNameFallback(state, contactId)) : null, icon: contactId ? null : markerIcon(unit.type) };
    }
    if (contactId) {
      // Occupied desk: the real org's "assigned" color when configured, else this app's own
      // configurable color, solid-filled with white initials (see colorTriple).
      const { bg, bd, fg } = colorTriple(realAssignColor(cust, true), moduleColor(state, unit.type, 'assigned'), true);
      return { bg, bd, fg, opacity: 1, shadow, size, radius, zIndex, occText: initialsOf(contactNameFallback(state, contactId)), icon: null };
    }
    const { bg, bd, fg } = colorTriple(realAssignColor(cust, false), moduleColor(state, unit.type, 'free'), false);
    return { bg, bd, fg, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
  }

  // book mode
  if (!isBookable(unit)) {
    // Previously 35%-opacity white — assigned desks were invisible on the plan. The real org's
    // "not reservable" color when configured (this app's non-bookable concept maps directly onto
    // it), else a solid grey chip, with the occupant's initials so the booking view still says
    // whose desk it is.
    const real = realBookColor(cust, category, 'nonReservableColor');
    if (real) {
      const solid = opaque(real);
      return { bg: real, bd: solid, fg: solid, opacity: 1, shadow, size, radius, zIndex, occText: contactId ? initialsOf(contactNameFallback(state, contactId)) : null, icon: contactId ? null : markerIcon(unit.type) };
    }
    return {
      bg: 'var(--ink-100)',
      bd: 'var(--ink-500)',
      fg: 'var(--ink-600)',
      opacity: 1,
      shadow,
      size,
      radius,
      zIndex,
      occText: contactId ? initialsOf(contactNameFallback(state, contactId)) : null,
      icon: contactId ? null : markerIcon(unit.type),
    };
  }
  const conflicts = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end);
  if (conflicts.length) {
    const { bg, bd, fg } = colorTriple(realBookColor(cust, category, 'notAvailableColor'), moduleColor(state, unit.type, 'booked'), false);
    return { bg, bd, fg, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
  }
  // bookable + free/available — the real org's "available" color when configured, else the
  // configurable "go" color.
  const avail = moduleColor(state, unit.type, unit.type === 'room' ? 'available' : 'free');
  const { bg, bd, fg } = colorTriple(realBookColor(cust, category, 'availableColor'), avail, false);
  return { bg, bd, fg, opacity: 1, shadow, size, radius, zIndex, occText: null, icon: markerIcon(unit.type) };
}

function markerIcon(type: Unit['type']): MarkerStyle['icon'] {
  if (type === 'workstation') return 'workstation';
  if (type === 'locker') return 'locker';
  if (type === 'parking') return 'parking';
  return null;
}
function initialsOf(name: string): string {
  // A numeric "name" is an unresolved contact id (assignee not in the loaded directory — e.g. a
  // permission-limited or paginated contact fetch). Digit "initials" like "88" read as garbage on
  // the marker; a generic person glyph at least reads as "assigned to someone".
  if (/^\d+$/.test(name.trim())) return '?';
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
function contactNameFallback(state: AppState, contactId: string): string {
  return state.clientContacts.find((e) => e.id === contactId)?.name ?? contactId;
}

export function unitStatus(state: AppState, unit: Unit, contactName: (id: string) => string): UnitStatus {
  if (unit.type === 'amenity') {
    const name = unit.markerKind || unit.icon ? resolveMarkerDef(state.customMarkers, unit).name : 'Amenity';
    return { key: 'amenity', text: name, bg: TOKEN.ink100, fg: TOKEN.ink600, dot: 'var(--ink-500)' };
  }
  if (state.mode === 'edit') {
    const name = { workstation: 'Desk', locker: 'Locker', parking: 'Parking stall', room: 'Room', amenity: 'Amenity' }[unit.type];
    return { key: 'type', text: name, bg: TOKEN.ink100, fg: TOKEN.ink600, dot: moduleColor(state, unit.type, 'free') };
  }
  const cust = customizationFor(state);
  const category = categoryOf(unit.type);

  if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      return { key: 'na', text: 'Not assignable', bg: TOKEN.ink100, fg: TOKEN.ink600, dot: 'var(--ink-400)' };
    }
    const contactId = state.assignments[unit.id];
    if (contactId) {
      return {
        key: 'assigned',
        text: `Assigned · ${contactName(contactId)}`,
        bg: TOKEN.blue050,
        fg: TOKEN.blue700,
        dot: opaque(realAssignColor(cust, true) ?? moduleColor(state, unit.type, 'assigned')),
      };
    }
    return { key: 'free', text: 'Free', bg: TOKEN.success050, fg: TOKEN.success700, dot: opaque(realAssignColor(cust, false) ?? moduleColor(state, unit.type, 'free')) };
  }
  // book mode
  if (!isBookable(unit)) {
    const contactId = state.assignments[unit.id];
    return {
      key: 'notBookable',
      // whose desk it is stays visible from the booking tab too
      text: contactId ? `Assigned · ${contactName(contactId)}` : 'Not bookable',
      bg: TOKEN.ink100,
      fg: TOKEN.ink600,
      dot: opaque(realBookColor(cust, category, 'nonReservableColor') ?? 'var(--ink-400)'),
    };
  }
  const conflicts = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end);
  if (conflicts.length) {
    return {
      key: 'booked',
      text: `Booked ${fmtTime(conflicts[0].start)}–${fmtTime(conflicts[0].end)}`,
      bg: TOKEN.danger050,
      fg: TOKEN.danger700,
      dot: opaque(realBookColor(cust, category, 'notAvailableColor') ?? moduleColor(state, unit.type, 'booked')),
    };
  }
  return {
    key: 'available',
    text: 'Available',
    bg: TOKEN.success050,
    fg: TOKEN.success700,
    dot: opaque(realBookColor(cust, category, 'availableColor') ?? moduleColor(state, unit.type, unit.type === 'room' ? 'available' : 'free')),
  };
}

/** Resolved label text for a marker's above/below chips, per the real org's label-type rules (see FloorplanCustomization) — falls back to this app's plain desk-name/assignee-name behavior when no real customization is loaded. */
export interface ResolvedLabels {
  primary: string;
  secondary: string | null;
}

function resolveLabelText(spec: LabelSpec | undefined, ctx: { name: string; contactName: string | null; category: string | null }): string | null {
  if (!spec) return null;
  switch (spec.labelType) {
    case 'CUSTOM':
      return spec.customText?.trim() || null;
    case 'DESK_NAME':
      return ctx.name;
    case 'FIRST_NAME':
      return ctx.contactName ? ctx.contactName.trim().split(/\s+/)[0] : null;
    case 'LAST_NAME':
      return ctx.contactName ? ctx.contactName.trim().split(/\s+/).slice(-1)[0] : null;
    case 'FULL_NAME':
      return ctx.contactName;
    case 'CATEGORY':
      return ctx.category;
    case 'DEFAULT':
    default:
      return ctx.name;
  }
}

export function resolveMarkerLabels(state: AppState, unit: Unit, contactNameOf: (id: string) => string): ResolvedLabels {
  // Amenities are markertype records with their own name, not a desk/space — no real-schema label rule applies.
  if (unit.type === 'amenity') return { primary: unit.label, secondary: null };

  const contactId = state.assignments[unit.id];
  const contactNameVal = contactId ? contactNameOf(contactId) : null;
  const cust = customizationFor(state);
  if (state.mode === 'edit' || !cust) {
    return { primary: unit.label, secondary: state.mode === 'assign' && contactNameVal ? contactNameVal : null };
  }

  const category = categoryOf(unit.type);
  const primarySpec = category === 'space' ? cust.spacePrimaryLabel : cust.deskPrimaryLabel;
  const secondarySpec = category === 'space' ? cust.spaceSecondaryLabel : cust.deskSecondaryLabel;
  const ctx = { name: unit.label, contactName: contactNameVal, category: unit.secondary ?? null };
  // A resolved-empty PRIMARY (e.g. FULL_NAME with no assignee) falls back to the plain desk/room
  // name rather than rendering a blank label — the real product's exact empty-state isn't known.
  return {
    primary: resolveLabelText(primarySpec, ctx) ?? unit.label,
    secondary: resolveLabelText(secondarySpec, ctx),
  };
}
