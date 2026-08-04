import type { Booking, ClientContact, Unit } from '../lib/types';
import type { AppState } from './types';

export function unitById(state: AppState, id: string | null | undefined): Unit | null {
  if (!id) return null;
  return state.units.find((u) => u.id === id) ?? null;
}

export function contactById(state: AppState, id: string | null | undefined): ClientContact | null {
  if (!id) return null;
  return state.clientContacts.find((c) => c.id === id) ?? null;
}

export function contactName(state: AppState, id: string | null | undefined): string {
  // Unknown id (assignee outside the loaded contact directory) -> '' — raw record ids must never
  // surface in the UI; callers render a generic "Occupied"/"Assigned" instead.
  if (!id) return '';
  return contactById(state, id)?.name ?? '';
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Units with any booking overlapping [start,end) on `date`. */
export function conflictsFor(bookings: Booking[], unitId: string, date: string, start: number, end: number): Booking[] {
  return bookings.filter((b) => b.unitId === unitId && b.date === date && b.start < end && b.end > start);
}

export function bookedUnitIds(state: AppState): Set<string> {
  const set = new Set<string>();
  for (const b of state.bookings) {
    if (b.date === state.date && b.start < state.end && b.end > state.start) set.add(b.unitId);
  }
  return set;
}

/**
 * Desk bookability/assignability follows the real deskType semantics (see lib/types DeskType):
 * ASSIGNED (or untyped) desks are assignment-only; HOT/HOTEL desks are booking-only. Parking
 * stays bookable; lockers stay assignment-only. Rooms follow their own `isReservable` flag (from
 * the IWMS rooms module): bookable unless explicitly marked not-reservable, in which case they're
 * assignable instead — mutually exclusive, same as desks.
 */
export function isBookable(u: Unit): boolean {
  if (u.type === 'locker' || u.type === 'amenity') return false;
  if (u.type === 'workstation') return u.deskType === 'HOT' || u.deskType === 'HOTEL';
  if (u.type === 'room') {
    if (u.isReservable === true) return true; // reservable wins over isassignable_rooms
    if (u.isReservable === false) return false;
    // `reservable` unset: an explicitly assignable room is NOT bookable (it was wrongly
    // showing as "Available" in book mode); otherwise the legacy bookable default stands.
    return u.isAssignableRoom !== true;
  }
  return true;
}

export function isAssignable(u: Unit): boolean {
  if (u.type === 'workstation') return (u.deskType ?? 'ASSIGNED') === 'ASSIGNED';
  if (u.type === 'room') {
    // `reservable === true` takes PRIORITY: such a room stays booking-only even when also
    // flagged assignable. Otherwise `isassignable_rooms` decides (including when `reservable`
    // is unset); rooms explicitly non-reservable without the flag keep the legacy behavior.
    if (u.isReservable === true) return false;
    if (u.isAssignableRoom === true) return true;
    return u.isReservable === false && u.isAssignableRoom !== false;
  }
  return u.type === 'locker' || u.type === 'parking';
}

export function myAssignedUnit(state: AppState): Unit | null {
  const mine = Object.entries(state.assignments).find(([, contactId]) => contactId === state.bookBy);
  if (mine) return unitById(state, mine[0]);
  // Real-backend fallback, no "This is me" pick needed: servicePortalHome already resolved the
  // SESSION user's assigned/booked desk at boot (state.myDesk), and viewerData-sourced units
  // carry the backing desk record id as their unit id — so the join is a direct id match.
  if (state.myDesk?.recordId != null) return unitById(state, String(state.myDesk.recordId));
  return null;
}

export function floorMeta(state: AppState, floorId: string) {
  for (const site of state.portfolio) {
    for (const building of site.buildings) {
      const floor = building.floors.find((f) => f.id === floorId);
      if (floor) return { site, building, floor };
    }
  }
  return null;
}

export function nextLabel(state: AppState, type: Unit['type'], prefix: string): string {
  const count = state.units.filter((u) => u.type === type).length;
  return `${prefix}-${String(count + 1).padStart(2, '0')}`;
}
