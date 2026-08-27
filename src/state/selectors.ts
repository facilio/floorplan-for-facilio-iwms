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

/**
 * A CANCELLED booking doesn't hold the slot — the unit is bookable in that range as if the booking
 * weren't there. Two independent signals, either sufficient:
 *
 *  - `isCancelled`, the record's own flag. AUTHORITATIVE, and checked first: a state the pattern
 *    below doesn't recognise still must not hold a slot.
 *  - the state name, which covers rows that carry no flag (local/older rows) and works whatever
 *    the org calls the state, which a hardcoded state id wouldn't.
 *
 * Neither needs an extra request; every row carries both. Used by the plan colouring, the calendar
 * and the submit pre-flight — the booking form already ignored cancelled rows, but those three
 * didn't, so a cancelled booking still greyed a desk out.
 */
export function isCancelledBooking(b: Booking): boolean {
  return b.isCancelled === true || /cancel/i.test(b.stateName ?? '');
}

/** Units with any LIVE booking overlapping [start,end) on `date`. */
export function conflictsFor(bookings: Booking[], unitId: string, date: string, start: number, end: number): Booking[] {
  return bookings.filter((b) => !isCancelledBooking(b) && b.unitId === unitId && b.date === date && b.start < end && b.end > start);
}

export function bookedUnitIds(state: AppState): Set<string> {
  const set = new Set<string>();
  for (const b of state.bookings) {
    if (isCancelledBooking(b)) continue;
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

/** The one sentence for a unit nothing can be done with — same copy in book AND assign view. */
const NO_ACTION_ROOM = "This room isn't set up for booking or assignment, so there's nothing to do here.";

/**
 * Nothing is actionable on a unit that is neither bookable nor assignable — a room whose record
 * carries `reservable = false` AND `isassignable_rooms = false` is the case that reaches this
 * (requested). Surfaces use it to withhold every action rather than offer one that can't run.
 */
export function isActionable(u: Unit): boolean {
  return isBookable(u) || isAssignable(u);
}

/**
 * Why `unit` can't be ASSIGNED — the mirror of notBookableReason. Both hardcoded "Meeting Rooms
 * can only be booked, not assigned", which is wrong for a room that can't be booked either.
 */
export function notAssignableReason(u: Unit): string {
  if (u.type === 'room') return isBookable(u) ? 'Meeting Rooms can only be booked, not assigned' : NO_ACTION_ROOM;
  if (u.type === 'workstation') return 'This is a bookable (hot) desk, so it isn’t assigned to anyone.';
  return "This space can't be assigned.";
}

/**
 * Why `unit` can't be booked — accurate per TYPE (see isBookable). Shared by the web Book panel
 * and the mobile unit sheet, which both hardcoded the LOCKER sentence and so told users a room or
 * an assigned desk was a locker (reported).
 */
export function notBookableReason(u: Unit): string {
  switch (u.type) {
    case 'workstation':
      return "This desk is assigned to a person, so it can't be booked — pick a free (hot) desk instead.";
    case 'room':
      // A room flagged NEITHER reservable NOR assignable has no action at all — claiming it is
      // "set up for assignment" would send the user to a tab that offers nothing (requested).
      return isAssignable(u) ? 'This room is set up for assignment, not booking.' : NO_ACTION_ROOM;
    case 'locker':
      return 'Lockers are assigned, not booked.';
    case 'parking':
      return "This parking stall is assigned, so it can't be booked.";
    default:
      return "This space isn't bookable.";
  }
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
  // A ROOM assignment is deliberately NOT a "my desk" (requested): it still decides which floor
  // the app lands on at boot, but it is never what this button locates or badges.
  if (state.myDesk?.recordId != null && !state.myDesk.isRoom) return unitById(state, String(state.myDesk.recordId));
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
