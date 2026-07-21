import { FacilioApiDataSource } from './facilioApiDataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Employee, Site, Unit } from './types';

// Local dev data lives as editable JSON in src/data/*.json — change a file and the app uses it
// (Vite picks the JSON up on save). This is the seed the LocalJsonDataSource serves; session edits
// are layered on top in localStorage so a dev session survives reloads.
import portfolioJson from '../data/portfolio.json';
import employeesJson from '../data/employees.json';
import assetsJson from '../data/assets.json';
import unitsJson from '../data/units.json';
import assignmentsJson from '../data/assignments.json';
import bookingsJson from '../data/bookings.json';

/**
 * Data access contract for the Floorplan Manager (connected-app build).
 *
 * Two tiers only (see CompositeDataSource / defaultTiers): the real Facilio V3 API
 * (FacilioApiDataSource — active in connected-app mode via session cookies, or in dev with a
 * base URL + token) → the local JSON tier (LocalJsonDataSource — editable src/data/*.json plus
 * localStorage session edits). There is no vibe-db or connector tier in this build.
 */
export interface FloorplanDataSource {
  readonly name: string;
  getPortfolio(): Promise<Site[]>;
  getEmployees(): Promise<Employee[]>;
  /** Catalog of assets that can be dropped onto a plan (Edit mode asset picker). */
  getAssets(): Promise<Asset[]>;
  getUnits(floorId: string): Promise<Unit[]>;
  saveUnits(floorId: string, units: Unit[]): Promise<void>;
  getAssignments(floorId: string): Promise<Assignments>;
  assignUnit(unitId: string, employeeId: string): Promise<void>;
  vacateUnit(unitId: string): Promise<void>;
  getBookings(floorId: string, date: string): Promise<Booking[]>;
  createBooking(input: Omit<Booking, 'id'>): Promise<Booking>;
  cancelBooking(id: string): Promise<void>;
  /**
   * Mint a genuinely-new record (desk/locker/parking/room). On the Facilio API tier this would be
   * a real V3 create (not yet wired there — it throws); the local tier just echoes the unit back
   * with its local id so dev works, and the on-plan position is persisted separately by the caller
   * via saveUnits. Amenities (assets/markers) aren't records and are handled purely locally.
   */
  createUnit(loc: CreateSpaceLoc, unit: Unit): Promise<Unit>;
  /**
   * Optional fast path: everything a floor load needs in ONE round-trip. `file` is the stored
   * floorplan-file JSON string (see floorplanFileStore) or null. Tiers without it are skipped by
   * the composite; callers must be prepared to fall back to the per-call path.
   */
  getFloorData?(floorId: string, date: string, planId: string): Promise<FloorBundle>;
}

export interface FloorBundle {
  units: Unit[];
  assignments: Assignments;
  bookings: Booking[];
  file: string | null;
}

/** Where a new record is being created — its floor, plus the enclosing building/site. Resolved by
 *  the caller from the portfolio tree; used by a real-API create when that gets wired. */
export interface CreateSpaceLoc {
  siteId: string | null;
  buildingId: string | null;
  floorId: string;
}

// ---- seed data (editable JSON in src/data) ----
const SEED_PORTFOLIO = portfolioJson as unknown as Site[];
const SEED_EMPLOYEES = employeesJson as unknown as Employee[];
const SEED_ASSETS = assetsJson as unknown as Asset[];
const SEED_UNITS = unitsJson as unknown as Unit[];
const SEED_ASSIGNMENTS = assignmentsJson as unknown as Assignments;
// Bookings are stored date-agnostic; getBookings stamps the requested day (demo behaviour).
const SEED_BOOKINGS = bookingsJson as unknown as Omit<Booking, 'date'>[];

// ---- local session persistence (localStorage) ----
const LS_KEY = 'facilio_floorplan_proto_v2';

interface PersistedShape {
  units: Unit[];
  assignments: Assignments;
  bookings: Booking[];
}

function loadPersisted(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedShape) : null;
  } catch {
    return null;
  }
}

function savePersisted(next: Partial<PersistedShape>) {
  try {
    const cur = loadPersisted() || { units: SEED_UNITS, assignments: SEED_ASSIGNMENTS, bookings: [] };
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...next }));
  } catch {
    /* ignore quota/serialization errors */
  }
}

/**
 * Local tier: serves the editable src/data/*.json seed and persists a session's edits to
 * localStorage so a dev/demo run survives reloads. Powers `npm run dev` with no backend, and is
 * the fallback under the real Facilio API tier in connected-app mode. To reset to the JSON seed,
 * clear the app's localStorage (Settings › Data & caches › Clear local data).
 */
export class LocalJsonDataSource implements FloorplanDataSource {
  readonly name = 'local-json';

  async getPortfolio(): Promise<Site[]> {
    return SEED_PORTFOLIO;
  }

  async getEmployees(): Promise<Employee[]> {
    return SEED_EMPLOYEES;
  }

  async getAssets(): Promise<Asset[]> {
    return SEED_ASSETS;
  }

  async getUnits(floorId: string): Promise<Unit[]> {
    const saved = loadPersisted();
    const units = saved?.units ?? SEED_UNITS;
    return units.filter((u) => u.floor === floorId);
  }

  async saveUnits(floorId: string, units: Unit[]): Promise<void> {
    const saved = loadPersisted();
    const others = (saved?.units ?? SEED_UNITS).filter((u) => u.floor !== floorId);
    savePersisted({ units: [...others, ...units] });
  }

  // No backend to create against — the record lives entirely in localStorage, persisted with its
  // position by the caller's saveUnits. Just echo the unit back with its local id.
  async createUnit(_loc: CreateSpaceLoc, unit: Unit): Promise<Unit> {
    return unit;
  }

  async getAssignments(floorId: string): Promise<Assignments> {
    const saved = loadPersisted();
    const all = saved?.assignments ?? SEED_ASSIGNMENTS;
    const units = await this.getUnits(floorId);
    const ids = new Set(units.map((u) => u.id));
    return Object.fromEntries(Object.entries(all).filter(([unitId]) => ids.has(unitId)));
  }

  async assignUnit(unitId: string, employeeId: string): Promise<void> {
    const saved = loadPersisted();
    const assignments = { ...(saved?.assignments ?? SEED_ASSIGNMENTS), [unitId]: employeeId };
    savePersisted({ assignments });
  }

  async vacateUnit(unitId: string): Promise<void> {
    const saved = loadPersisted();
    const assignments = { ...(saved?.assignments ?? SEED_ASSIGNMENTS) };
    delete assignments[unitId];
    savePersisted({ assignments });
  }

  async getBookings(floorId: string, date: string): Promise<Booking[]> {
    const saved = loadPersisted();
    const bookings = saved?.bookings ?? SEED_BOOKINGS.map((b) => ({ ...b, date }));
    const units = await this.getUnits(floorId);
    const ids = new Set(units.map((u) => u.id));
    return bookings.filter((b) => ids.has(b.unitId) && b.date === date);
  }

  async createBooking(input: Omit<Booking, 'id'>): Promise<Booking> {
    const saved = loadPersisted();
    const bookings = saved?.bookings ?? SEED_BOOKINGS.map((b) => ({ ...b, date: input.date }));
    const booking: Booking = { ...input, id: 'b' + Date.now() };
    savePersisted({ bookings: [...bookings, booking] });
    return booking;
  }

  async cancelBooking(id: string): Promise<void> {
    const saved = loadPersisted();
    if (!saved?.bookings) return;
    savePersisted({ bookings: saved.bookings.filter((b) => b.id !== id) });
  }

  async getFloorData(floorId: string, date: string): Promise<FloorBundle> {
    const [units, assignments, bookings] = await Promise.all([
      this.getUnits(floorId),
      this.getAssignments(floorId),
      this.getBookings(floorId, date),
    ]);
    return { units, assignments, bookings, file: null };
  }
}

/** Wipe the local session store so the next load re-seeds from the src/data/*.json files. */
export function clearLocalData(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Tier order: the real Facilio V3 API first (active in connected-app mode, or dev with a token),
 * then the local JSON tier. First to resolve wins.
 */
function defaultTiers(): FloorplanDataSource[] {
  return [new FacilioApiDataSource(), new LocalJsonDataSource()];
}

/** Tries each tier in order for every call; first to resolve wins, logging which did. */
export class CompositeDataSource implements FloorplanDataSource {
  readonly name = 'composite';
  private tiers: FloorplanDataSource[];

  constructor(tiers: FloorplanDataSource[] = defaultTiers()) {
    this.tiers = tiers;
  }

  private async run<K extends keyof FloorplanDataSource>(
    method: K,
    ...args: FloorplanDataSource[K] extends (...a: infer A) => any ? A : never
  ): Promise<any> {
    let lastErr: unknown;
    for (const tier of this.tiers) {
      try {
        // @ts-expect-error - dynamic dispatch across the shared interface
        const result = await tier[method](...args);
        // Empty portfolio/employees counts as a MISS, not an answer: the whole app is built on
        // those two datasets, and an empty-but-successful response from the API tier (e.g. the
        // real employee fetch coming back [] for a permission-limited user) would otherwise mask
        // the local seed. NOT applied to per-floor data (units/bookings/assignments), where empty
        // is a legitimate answer — falling through there would paint seed markers over a genuinely
        // empty real floor.
        if ((method === 'getPortfolio' || method === 'getEmployees') && Array.isArray(result) && result.length === 0) {
          throw new Error(`${tier.name}: ${String(method)} returned no records`);
        }
        return result;
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.debug(`[dataSource] ${String(method)} unavailable on "${tier.name}", falling back`, err);
      }
    }
    throw lastErr;
  }

  /**
   * Portfolio is first-non-empty-wins (NOT a union): the org's real tree from the Facilio API is
   * authoritative and stands ALONE. `run()` treats an empty portfolio as a miss and falls through,
   * so the API wins when it has sites and the local JSON seed only answers when the API tier is
   * empty/unavailable (offline dev with no backend).
   */
  getPortfolio(): Promise<Site[]> {
    return this.run('getPortfolio');
  }
  getEmployees() {
    return this.run('getEmployees');
  }
  getAssets() {
    return this.run('getAssets');
  }
  getUnits(floorId: string) {
    return this.run('getUnits', floorId);
  }
  /** Fast path across tiers that implement it; callers fall back to the per-call path on throw. */
  async getFloorData(floorId: string, date: string, planId: string): Promise<FloorBundle> {
    let lastErr: unknown = new Error('no tier implements getFloorData');
    for (const tier of this.tiers) {
      if (!tier.getFloorData) continue;
      try {
        return await tier.getFloorData(floorId, date, planId);
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.debug(`[dataSource] getFloorData unavailable on "${tier.name}", falling back`, err);
      }
    }
    throw lastErr;
  }
  saveUnits(floorId: string, units: Unit[]) {
    return this.run('saveUnits', floorId, units);
  }
  /**
   * API-first by tier order: a real create wins when the API tier wires one, otherwise the local
   * tier echoes the unit back so dev/connected sessions stay interactive. The on-plan position is
   * persisted separately via saveUnits (+ saveFloorplanMarkers to the real API when configured).
   */
  createUnit(loc: CreateSpaceLoc, unit: Unit) {
    return this.run('createUnit', loc, unit) as Promise<Unit>;
  }
  getAssignments(floorId: string) {
    return this.run('getAssignments', floorId);
  }
  assignUnit(unitId: string, employeeId: string) {
    return this.run('assignUnit', unitId, employeeId);
  }
  vacateUnit(unitId: string) {
    return this.run('vacateUnit', unitId);
  }
  getBookings(floorId: string, date: string) {
    return this.run('getBookings', floorId, date);
  }
  createBooking(input: Omit<Booking, 'id'>) {
    return this.run('createBooking', input);
  }
  cancelBooking(id: string) {
    return this.run('cancelBooking', id);
  }
}

export const dataSource: FloorplanDataSource = new CompositeDataSource();
