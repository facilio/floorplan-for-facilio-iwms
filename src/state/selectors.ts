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
  // Unknown id (assignee outside the loaded contact directory): label it rather than returning ''
  // — a blank name renders as "Assigned · " / an empty avatar row in the panels.
  if (!id) return '';
  return contactById(state, id)?.name ?? `Contact #${id}`;
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
  if (u.type === 'room') return u.isReservable !== false;
  return true;
}

export function isAssignable(u: Unit): boolean {
  if (u.type === 'workstation') return (u.deskType ?? 'ASSIGNED') === 'ASSIGNED';
  if (u.type === 'room') return u.isReservable === false;
  return u.type === 'locker' || u.type === 'parking';
}

export function myAssignedUnit(state: AppState): Unit | null {
  const mine = Object.entries(state.assignments).find(([, contactId]) => contactId === state.bookBy);
  if (!mine) return null;
  return unitById(state, mine[0]);
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
