import type { Assignments, Booking, Employee, Site, Unit } from './types';

// Single source of truth for the local/dev dataset is the editable JSON in src/data — edit a file
// there and both the data-source tier and these seed exports pick it up. This module just adapts
// that JSON for the callers that want it synchronously (reducer initial state, geometry constants).
import portfolioJson from '../data/portfolio.json';
import employeesJson from '../data/employees.json';
import unitsJson from '../data/units.json';
import assignmentsJson from '../data/assignments.json';
import bookingsJson from '../data/bookings.json';

export const EMPLOYEES = employeesJson as unknown as Employee[];

export const PORTFOLIO = portfolioJson as unknown as Site[];

export function seedUnits(): Unit[] {
  return unitsJson as unknown as Unit[];
}

export function seedAssignments(): Assignments {
  return assignmentsJson as unknown as Assignments;
}

/** Bookings are stored date-agnostic in bookings.json; stamp the requested day (demo behaviour). */
export function seedBookings(date: string): Booking[] {
  return (bookingsJson as unknown as Omit<Booking, 'date'>[]).map((b) => ({ ...b, date }));
}

/** Intrinsic pixel size of the demo floorplan image the normalized geometry maps onto. */
export const IMG_W = 1492;
export const IMG_H = 1054;
