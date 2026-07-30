import { apiOrigin, customDelete, customGet, customPost, facilioApi, fetchFilePreview, isFacilioApiConfigured } from './facilioApi';
import { executeStateTransition, fetchAvailableStates, findCancelTransition, isPendingApprovalName, stateName } from './stateflowApi';
import { renderCadToDataUrl } from './cadPreview';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, lngLatToFraction, quadToGeometryString, quadToLngLat, type GeoQuad } from './geoReference';
import type { FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Building, ClientContact, DefaultPlanView, DeskType, Floor, FloorplanCustomization, MarkerDef, ModePerms, PlanId, PointGeom, PolyGeom, Site, Unit, UnitType } from './types';

/**
 * Sniffs a DWG/DXF/PDF signature off the file's own leading bytes — the fallback when no
 * Content-Type is available to check (connected-app mode's `common.toBase64` exposes no headers
 * at all, unlike dev mode's real HTTP response). DWG's version tag always starts with the ASCII
 * bytes "AC" (e.g. "AC1015"); PDF always starts with "%PDF"; ASCII DXF (this app only ever
 * produces/consumes the ASCII variant) opens with a "0" group code then "SECTION".
 */
async function sniffCadOrPdfType(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  if (head.length >= 2 && head[0] === 0x41 && head[1] === 0x43) return 'image/vnd.dwg';
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'application/pdf';
  const text = new TextDecoder('ascii', { fatal: false }).decode(head);
  if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(text)) return 'image/vnd.dxf';
  // SVG: bare `<svg` root, or an XML prolog with an <svg …> shortly after.
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'image/svg+xml';
  return '';
}

/**
 * `fetchFilePreview(fileId, {original: true})` (dev mode: `v2/files/download/{fileId}` — see its
 * doc comment for why not the preview endpoint) returns the ORIGINAL uploaded bytes — for a plain
 * raster image that's directly usable as an `<img>` source, but a floor's plan is often a DWG/
 * DXF/PDF source file (confirmed against a live org: `Content-Type: image/vnd.dwg`), which a
 * browser can't decode natively. Detect that from the response's real content-type when there is
 * one (not the `.dwg` extension, which isn't available here — this isn't a locally-picked `File`),
 * else sniff the bytes themselves (connected-app mode has no Content-Type to read at all), and run
 * it through the same client-side CAD/PDF renderers the upload flow uses, so a floor plan that was
 * uploaded as a DWG still shows a rendered image, not a broken `<img>` icon.
 */
async function blobToRenderableDataUrl(blob: Blob, contentType: string | undefined): Promise<string> {
  let type = (contentType || blob.type || '').toLowerCase();
  if (!type) type = await sniffCadOrPdfType(blob);
  if (type.includes('dwg') || type.includes('dxf')) {
    const file = new File([blob], `floorplan.${type.includes('dxf') ? 'dxf' : 'dwg'}`, { type });
    return renderCadToDataUrl(file);
  }
  if (type.includes('pdf')) {
    const file = new File([blob], 'floorplan.pdf', { type });
    return renderPdfToDataUrl(file);
  }
  if (type.includes('svg')) {
    // Re-wrap with the EXACT MIME — a browser only renders an <img src=blob:…> as SVG when the
    // blob's own type says image/svg+xml; server responses often come back typeless or generic.
    return URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: 'image/svg+xml' }));
  }
  return URL.createObjectURL(blob);
}

/**
 * Facilio uses `-1` as the sentinel for "unset" throughout (confirmed live across many fields,
 * not just fileId) — a plain falsy check doesn't catch it (`-1` is truthy), so a "no file
 * attached" fileId of `-1` would otherwise still trigger a doomed preview/download request.
 */
function isValidFileId(id: unknown): id is number {
  return typeof id === 'number' && id > 0;
}

/**
 * `indoorfloorplan.floorPlanType` — one plan record per module, confirmed against a live org
 * (only 1/2/3 are accepted; there's no generic/custom type, so `custom` floors fall back to
 * the workstation plan).
 */
const FLOOR_PLAN_TYPE: Record<PlanId, number> = {
  workstation: 1,
  locker: 2,
  parking: 3,
  custom: 1,
};
const PLAN_ID_BY_TYPE: Record<number, PlanId> = { 1: 'workstation', 2: 'locker', 3: 'parking' };
const PLAN_NAME_BY_TYPE: Record<number, string> = { 1: 'Workstations', 2: 'Lockers', 3: 'Parking stalls' };

/**
 * Real Facilio backend tier (generic V3 module CRUD: `v3/modules/{moduleName}`) — see
 * `facilioApi.ts` for the connected-app-SDK vs. dev-mode-axios transport split.
 *
 * Scope, deliberately: portfolio (site/building/floor) and the client contact directory map cleanly
 * onto plain module records, so those are wired for real. Units/assignments/bookings are NOT
 * wired here — a desk/room/locker/parkingstall record has no on-plan position of its own; that
 * lives in separate `floorplanmarker` (Point) / `floorplanmarkedzone` (Polygon) records, joined
 * by `markerModuleId`/`recordId`, with `geometry` as a stringified GeoJSON blob whose exact shape
 * (and whether it's plan-pixel or georeferenced lng/lat) needs verifying against a live org before
 * it's safe to render. Guessing that mapping wrong would silently misplace markers rather than
 * fail loudly, which is worse than falling through to the next tier — so those methods throw,
 * exactly like the stubs in ConnectorDataSource, and CompositeDataSource falls through to the
 * app db / mock tier for them.
 */
export class FacilioApiDataSource implements FloorplanDataSource {
  readonly name = 'facilio-api';

  private assertConfigured() {
    if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured (VITE_DEV_MODE / base URL / token)');
  }

  /**
   * Sites only — buildings/floors are fetched lazily as the portfolio switcher expands each node
   * (`getBuildingsForSite`/`getFloorsForBuilding`), rather than fan-out-fetching the whole org's
   * tree (every building and every floor, across every site) up front.
   */
  async getPortfolio(): Promise<Site[]> {
    this.assertConfigured();
    // Explicit page size — without it the backend's default (~50) silently truncated big portfolios.
    const res = await facilioApi.fetchAll('site', { page: 1, perPage: 500 });
    if (res.error) throw new Error(`facilio-api: portfolio fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((s: any) => ({ id: String(s.id), name: s.name, buildings: [] }));
  }

  async getBuildingsForSite(siteId: string): Promise<Building[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('building', { page: 1, perPage: 500, filters: JSON.stringify({ site: { operatorId: 36, value: [siteId] } }) });
    if (res.error) throw new Error(`facilio-api: buildings fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((b: any) => ({ id: String(b.id), name: b.name, floors: [] }));
  }

  async getFloorsForBuilding(buildingId: string): Promise<Floor[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('floor', { page: 1, perPage: 500, filters: JSON.stringify({ building: { operatorId: 36, value: [buildingId] } }) });
    if (res.error) throw new Error(`facilio-api: floors fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((f: any) => ({
      id: String(f.id),
      name: f.name,
      // Unknown until getFloorPlanSummary runs for this floor; true is the safer default so the
      // canvas isn't hidden behind "No floorplan yet" pre-emptively.
      hasPlan: true,
    }));
  }

  async getClientContacts(): Promise<ClientContact[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('clientcontact', { page: 1, perPage: 500 });
    if (res.error) throw new Error(`facilio-api: client contact fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name,
      client: c.client?.name ?? c.clientName ?? '',
    }));
  }

  async getAssets(): Promise<Asset[]> {
    // Sourced from the CMMS connector (list-assets); not fetched by this tier. Throw so the
    // composite falls through to the connector tier.
    throw new Error('facilio-api: assets come from the CMMS connector, not this tier');
  }

  /**
   * Real placed units for a floor, sourced from `v3/floorplan/viewerData` (see
   * `viewerDataUnitsForFloor`). Empty is a legitimate answer (a real but empty floor) — the
   * composite treats per-floor emptiness as an answer, not a miss, so it won't paint the local
   * seed over a genuinely empty real floor.
   */
  async getUnits(floorId: string): Promise<Unit[]> {
    this.assertConfigured();
    return viewerDataUnitsForFloor(floorId);
  }
  async saveUnits(): Promise<void> {
    throw new Error('facilio-api: unit placement not wired');
  }
  // Space creation is wired on the CMMS connector tier (create-space), not this raw module-CRUD
  // layer — throw so the composite falls through to it.
  async createUnit(): Promise<Unit> {
    throw new Error('facilio-api: space creation goes through the CMMS connector — not wired here');
  }
  async getAssignments(floorId: string): Promise<Assignments> {
    this.assertConfigured();
    return viewerDataAssignmentsForFloor(floorId);
  }
  async assignUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async vacateUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  /**
   * Real spacebooking records for one day, mapped to this app's Booking shape. Day window filter:
   * `bookingStartTime BETWEEN [midnight, midnight+24h)` (operatorId 20 — Facilio's BETWEEN). The
   * booked resource lookup (desk/space/parkingStall) maps to `unitId`, which matches
   * viewerData-sourced unit ids (both are the backing record id). Throws on error so the
   * composite falls back to the locally-stored bookings, same as before this was wired.
   */
  async getBookings(floorId: string, date: string): Promise<Booking[]> {
    this.assertConfigured();
    const dayStart = epochAt(date, 0);
    const dayEnd = epochAt(date, 24 * 60);
    const res = await facilioApi.fetchAll('spacebooking', {
      filters: JSON.stringify({ bookingStartTime: { operatorId: 20, value: [String(dayStart), String(dayEnd - 1)] } }),
    });
    if (res.error) throw new Error(`facilio-api: spacebooking fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    // The day filter above is ORG-WIDE — spacebooking rows aren't floor-filtered server-side —
    // so scope to THIS floor's bookable records (same cached per-floor fetches getUnits shares).
    // Without this, a booking on any other floor rode onto every floor's calendar and inflated
    // the "My bookings" badge with rows the current floor never renders.
    const [desks, spaces, stalls] = await Promise.all(
      ['desks', 'space', 'parkingstall'].map((m) => fetchFloorRecordsRaw(m, floorId).catch(() => [] as any[]))
    );
    const onFloor = new Set([...desks, ...spaces, ...stalls].map((r: any) => String(r.id)));
    const toMinutes = (t: number) => Math.max(0, Math.min(24 * 60, Math.round((t - dayStart) / 60_000)));
    return (res.list ?? [])
      .map((b: any): Booking | null => {
        const unitId = b.desk?.id ?? b.space?.id ?? b.parkingStall?.id;
        if (!unitId || !Number.isFinite(b.bookingStartTime)) return null;
        // Stateflow/approval read-side: pending when the record is approval-enabled
        // (approvalFlowId + approvalStatus, same gate the real client uses) and its status label
        // is unresolvable or reads pending/requested/waiting. Transition-cancelled/rejected rows
        // are dropped below so a cancel-by-transition doesn't resurrect on refetch (best-effort —
        // list projections that omit moduleState keep the row).
        const approvalStatusName = stateName(b.approvalStatus);
        // approvalStatus must be a real LOOKUP OBJECT — Facilio's unset sentinel is -1 (a
        // number), which `!= null` alone would treat as approval-enabled and mark every plain
        // booking pending.
        const approvalEnabled = b.approvalFlowId != null && b.approvalFlowId !== -1 && b.approvalStatus != null && typeof b.approvalStatus === 'object';
        const approvalPending = approvalEnabled && (approvalStatusName === null || isPendingApprovalName(approvalStatusName));
        const recordStateName = stateName(b.moduleState);
        // Dead states beyond literal "cancel" — orgs name them Terminated/Declined/Void too.
        if (recordStateName && /cancel|reject|terminat|declin|void/i.test(recordStateName)) return null;
        return {
          id: String(b.id),
          unitId: String(unitId),
          floorId,
          date,
          start: toMinutes(b.bookingStartTime),
          end: toMinutes(b.bookingEndTime ?? b.bookingStartTime),
          by: b.reservedBy?.id != null ? String(b.reservedBy.id) : '',
          purpose: b.name ?? '',
          module: 'space',
          name: b.name ?? '',
          approvalPending,
          approvalStatusName,
          stateName: recordStateName,
        };
      })
      // An EMPTY floor set can also mean the record fetches failed — showing the unscoped rows
      // beats silently blanking real bookings in that case.
      .filter((b: Booking | null): b is Booking => b !== null && (onFloor.size === 0 || onFloor.has(b.unitId)));
  }
  // Booking WRITES stay on their existing paths: creation goes through createRealBooking (the
  // org-form-aware create), with the local tier's copy as the interim store — so this tier's
  // createBooking still throws to fall through.
  async createBooking(): Promise<Booking> {
    throw new Error('facilio-api: booking creation goes through createRealBooking — local tier stores the interim copy');
  }
  /**
   * Real cancel for backend bookings (numeric ids); locally-minted ids ("b...") fall through to
   * the local tier. Transition-ONLY: cancelling runs the record's stateflow Cancel transition
   * (the record stays visible as Cancelled in the real client, with its state history). Records
   * are NEVER hard-deleted — a booking whose current state offers no Cancel transition simply
   * can't be cancelled from here (the stateflow buttons are the source of truth for what's
   * allowed).
   */
  async cancelBooking(id: string): Promise<void> {
    this.assertConfigured();
    if (!/^\d+$/.test(id)) throw new Error('facilio-api: not a backend booking id');
    const { transitions } = await fetchAvailableStates('spacebooking', Number(id));
    const cancel = findCancelTransition(transitions);
    if (!cancel) throw new Error('facilio-api: this booking has no Cancel transition in its current state');
    await executeStateTransition('spacebooking', Number(id), cancel.id);
  }
}

/** Best-effort lookup-field id extraction: tries `{key}.id`, `{key}Id`, then the raw field. */
function lookupId(record: any, key: string): unknown {
  return record?.[key]?.id ?? record?.[`${key}Id`] ?? record?.[key];
}

/**
 * Server-side SITE search for the switcher's top search bar (sites only — buildings/floors have
 * their own in-branch scoped searches, see searchBranchChildren). Standard list `search` param,
 * ids only: the tree renders from the already-loaded portfolio, filtered to these.
 */
export async function searchSiteIds(text: string): Promise<Set<string>> {
  const q = text.trim();
  if (!isFacilioApiConfigured || !q) return new Set();
  const res = await facilioApi.fetchAll('site', { page: 1, perPage: 50, search: q }).catch(() => ({ list: null }) as any);
  return new Set(((res.list ?? []) as any[]).map((r) => String(r.id)));
}

/**
 * Scoped in-branch search: buildings WITHIN one site (`kind: 'site'`), or floors WITHIN one
 * building (`kind: 'building'`) — the search text goes to the API together with the parent
 * lookup filter, so only that branch's children are searched. Returns matching child ids.
 */
export async function searchBranchChildren(kind: 'site' | 'building', parentId: string, text: string): Promise<Set<string>> {
  const q = text.trim();
  if (!isFacilioApiConfigured || !q) return new Set();
  const moduleName = kind === 'site' ? 'building' : 'floor';
  const parentField = kind === 'site' ? 'site' : 'building';
  const res = await facilioApi
    .fetchAll(moduleName, {
      page: 1,
      perPage: 50,
      search: q,
      filters: JSON.stringify({ [parentField]: { operatorId: 36, value: [String(parentId)] } }),
    })
    .catch(() => ({ list: null }) as any);
  return new Set(((res.list ?? []) as any[]).map((r) => String(r.id)));
}

export interface FloorParents {
  siteId: string;
  buildingId: string;
}

/**
 * A floor's parent site/building ids — the portfolio tree only fetches a site/building's OWN
 * children when it's expanded (see `getBuildingsForSite`/`getFloorsForBuilding`); it never walks
 * UP from a floor to find its ancestors. Used to auto-reveal the boot-resolved floor (from
 * `fetchMyDesk`/`getAnyFloor`) in the tree, so a refresh doesn't leave the active floor buried
 * under two collapsed, unexpanded nodes the user has to hunt for manually.
 */
export async function findFloorParents(floorId: string): Promise<FloorParents | null> {
  if (!isFacilioApiConfigured) return null;
  const res = await facilioApi.fetchRecord<any>('floor', { id: floorId });
  if (res.error || !res.floor) return null;
  const siteId = lookupId(res.floor, 'site');
  const buildingId = lookupId(res.floor, 'building');
  if (!siteId || !buildingId) return null;
  return { siteId: String(siteId), buildingId: String(buildingId) };
}

/**
 * `GET v3/floorplan/getFloorplanDetailsByType` — the real FloorplanAction endpoint, confirmed
 * against a live org. Takes only `floorId` (no `floorPlanType` filter — passing one doesn't
 * narrow the result) and returns EVERY plan type configured for that floor in one call, keyed
 * by `floorPlanType` as a string ("1"=workstation, "2"=locker, "3"=parking). This is what the
 * plan-type switcher needs: which types have a floor plan on this floor, in one round trip,
 * rather than fetching every indoorfloorplan record org-wide and filtering client-side.
 *
 * Note: the records this returns omit `fileId`/`floor`/`building`/`site` (this endpoint's
 * projection is geared at plan customization, not the file) — use `id` from here with
 * `fetchRecord('indoorfloorplan', {id})` if the fileId is needed.
 */
/**
 * Short-lived promise cache — getUnits and getAssignments both need this, and loadFloor runs them
 * concurrently, so caching the in-flight PROMISE (not the resolved value) collapses the two into
 * one request. TTL-bounded so a later reload re-fetches; evicted on failure so a retry isn't stuck
 * replaying a rejection. Plan-type summaries don't change on marker edits, so this can't go stale
 * against the write paths.
 */
/**
 * Drops entries older than `ttl` from a request cache. Called on every write so the cache only ever
 * holds entries from roughly the current interaction (bounded by how many distinct floors/plans are
 * touched within one TTL window) rather than growing for every floor visited all session — keeps
 * the memory footprint flat, not proportional to session length.
 */
function pruneExpired<T extends { at: number }>(cache: Map<string, T>, ttl: number): void {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
}

/**
 * Session-long (not TTL'd): the floor -> plan-type -> indoorfloorplan-record-id mapping only ever
 * changes when an upload creates a NEW plan record for the floor — and that one write path
 * invalidates this cache explicitly (see the attach step in uploadRealFloorplanFile). Keeping it
 * session-long means "Save changes" doesn't re-call getFloorplanDetailsByType on every save just
 * to re-derive an id that can't have changed.
 */
const floorplanDetailsCache = new Map<string, { at: number; promise: Promise<Record<string, any>> }>();

function getFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
  const hit = floorplanDetailsCache.get(floorId);
  if (hit) return hit.promise;
  const promise = (async () => {
    const body = await customGet('v3/floorplan/getFloorplanDetailsByType', { floorId });
    if (body?.code !== 0) throw new Error(body?.message || `code ${body?.code ?? '?'}`);
    return body?.data?.indoorFloorPlans ?? {};
  })();
  promise.catch(() => {
    if (floorplanDetailsCache.get(floorId)?.promise === promise) floorplanDetailsCache.delete(floorId);
  });
  floorplanDetailsCache.set(floorId, { at: Date.now(), promise });
  return promise;
}

// ---------------------------------------------------------------------------
// `v3/floorplan/viewerData` — the real floor-plan viewer feed (markers + zones + rendering rules),
// the source the native Facilio web app renders from. This app uses it as the real source of a
// floor's placed units (positions + type + desk metadata), replacing the local-JSON seed for
// getUnits/getAssignments when a real backend is configured.
// ---------------------------------------------------------------------------

type ViewerMode = 'ASSIGNMENT' | 'BOOKING';

interface ViewerDataOpts {
  /** Booking-window epoch millis — only meaningful for BOOKING mode (availability). */
  startTime?: number;
  endTime?: number;
  /** BOOKING mode: whether this is a brand-new booking (mirrors the web app's request). */
  newBooking?: boolean;
  /** Amenity-filter ids the web app passes under `floorplanFilters.amenities`. */
  amenities?: Array<string | number>;
}

const UNIT_TYPE_BY_MARKER_MODULE: Record<string, UnitType> = {
  desks: 'workstation',
  lockers: 'locker',
  parkingstall: 'parking',
};

/**
 * `desks.deskType` numeric enum <-> this app's DeskType. Confirmed mapping:
 * ASSIGNED = 1, HOT = 2, HOTEL = 3. The backend field is an INTEGER — every write must go
 * through DESK_TYPE_NUM (sending the string enum name doesn't stick).
 */
const DESK_TYPE_BY_NUM: Record<number, DeskType> = { 1: 'ASSIGNED', 2: 'HOT', 3: 'HOTEL' };
const DESK_TYPE_NUM: Record<DeskType, number> = { ASSIGNED: 1, HOT: 2, HOTEL: 3 };

/**
 * Short-lived promise cache so a single floor load's getUnits + getAssignments (both
 * viewerData-backed, run CONCURRENTLY by loadFloor) share ONE round trip per floorplan+mode instead
 * of each firing its own. Caching the in-flight PROMISE (not the resolved value) is what dedupes the
 * concurrent case — a resolved-value cache is only ever populated after the request returns, so two
 * parallel callers both miss it. Keyed by the full request identity; TTL-bounded so a later reload
 * re-fetches; evicted on failure so a retry isn't stuck replaying a rejection.
 */
const VIEWER_DATA_TTL_MS = 20_000;
const viewerDataCache = new Map<string, { at: number; promise: Promise<any> }>();

function fetchViewerData(floorplanId: number, mode: ViewerMode, opts: ViewerDataOpts = {}): Promise<any> {
  const key = `${floorplanId}:${mode}:${opts.startTime ?? ''}:${opts.endTime ?? ''}`;
  const hit = viewerDataCache.get(key);
  if (hit && Date.now() - hit.at < VIEWER_DATA_TTL_MS) return hit.promise;

  const promise = (async () => {
    const body: Record<string, unknown> = {
      floorplanId,
      viewMode: mode,
      floorplanFilters: { amenities: opts.amenities ?? [] },
    };
    if (mode === 'BOOKING') body.newBooking = opts.newBooking ?? true;
    if (opts.startTime != null) body.startTime = opts.startTime;
    if (opts.endTime != null) body.endTime = opts.endTime;

    const res = await customPost('v3/floorplan/viewerData', body, { skipPermission: true });
    if (res?.code !== 0) throw new Error(res?.message || `viewerData code ${res?.code ?? '?'}`);
    return res.data ?? {};
  })();
  promise.catch(() => {
    if (viewerDataCache.get(key)?.promise === promise) viewerDataCache.delete(key);
  });
  pruneExpired(viewerDataCache, VIEWER_DATA_TTL_MS);
  viewerDataCache.set(key, { at: Date.now(), promise });
  return promise;
}

interface ViewerMarkerFeature {
  geometry?: { type?: string; coordinates?: any };
  properties?: Record<string, any>;
  markerType?: { name?: string; recordModuleId?: number; [k: string]: any };
}

/**
 * A marker's unit type, from every signal viewerData carries — not `markerModuleName` alone.
 * `markerModuleName` is the cleanest when present, but a desk placed as a marker can come through
 * without it; those still carry a `deskId`/`deskType`, a `desk`-named markerType/markerId, or a
 * `desk*` normalClass. Falls back to `amenity` only when nothing identifies it as a space record.
 */
function unitTypeForMarker(f: ViewerMarkerFeature): UnitType {
  const p = f.properties ?? {};
  const byModule = UNIT_TYPE_BY_MARKER_MODULE[p.markerModuleName];
  if (byModule) return byModule;
  if (p.deskId != null || p.deskType != null) return 'workstation';
  const names = [p.markerId, p.iconName, p.normalClass, f.markerType?.name].map((v) => String(v ?? '').toLowerCase());
  if (names.some((n) => n.includes('desk'))) return 'workstation';
  if (names.some((n) => n.includes('locker'))) return 'locker';
  if (names.some((n) => n.includes('parking'))) return 'parking';
  return 'amenity';
}

function isPointFeature(f: ViewerMarkerFeature): boolean {
  return f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length === 2;
}

function isPolygonFeature(f: ViewerMarkerFeature): boolean {
  return f?.geometry?.type === 'Polygon' && Array.isArray(f.geometry.coordinates) && Array.isArray(f.geometry.coordinates[0]);
}

/** The outer ring ([[lng,lat],...]) of a Polygon feature, or null. */
function polygonRing(f: ViewerMarkerFeature): [number, number][] | null {
  const ring = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring)) return null;
  const pts = ring.filter((c: any) => Array.isArray(c) && c.length === 2) as [number, number][];
  return pts.length >= 3 ? pts : null;
}

/** Bounding-box normalizer (with padding) over one coordinate set — y flipped to image convention. */
function bboxMapper(coords: [number, number][]): (c: [number, number]) => [number, number] {
  if (!coords.length) return () => [0.5, 0.5];
  const xs = coords.map((p) => p[0]);
  const ys = coords.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const PAD = 0.08;
  return ([lng, lat]) => [PAD + (1 - 2 * PAD) * ((lng - minX) / spanX), PAD + (1 - 2 * PAD) * ((maxY - lat) / spanY)];
}

/**
 * Builds the [lng,lat] -> 0-1 image-fraction converter for one plan, from ALL of its coordinates
 * (point markers + polygon-zone vertices) so markers and rooms share one consistent transform.
 *
 * viewerData's coordinates are NOT guaranteed to live in the same space as the plan's own stored
 * `geometry` quad: features this app itself wrote sit in that quad's synthetic lng/lat, but ones
 * placed through Facilio's native editor can come back in a separate local system (confirmed from
 * a live capture — inverting the quad on those yields fractions in the tens-of-thousands).
 *
 * PER-POINT decision, not all-or-nothing: a coordinate that inverts into the sane band around
 * [0,1] uses the quad (exact placement); only the OUTLIERS fall back to bounding-box
 * normalization computed over the outliers alone. The old all-or-nothing rule meant ONE foreign
 * marker dragged every correctly-georeferenced marker into the bbox fallback — the whole floor
 * rendered misaligned in assign/book views. Latitude increases "up", so the y axis is flipped to
 * the image convention (y=0 at top).
 */
function fractionMapper(coords: [number, number][], quad: GeoQuad | null): (coords: [number, number]) => [number, number] {
  const inQuad = quad
    ? (c: [number, number]) => {
        const [x, y] = lngLatToFraction(quad, c[0], c[1]);
        return x > -0.5 && x < 1.5 && y > -0.5 && y < 1.5;
      }
    : () => false;

  if (quad && coords.length) {
    const outliers = coords.filter((c) => !inQuad(c));
    if (outliers.length === 0) return ([lng, lat]) => lngLatToFraction(quad, lng, lat);
    if (outliers.length < coords.length) {
      const fallback = bboxMapper(outliers);
      return (c) => (inQuad(c) ? lngLatToFraction(quad, c[0], c[1]) : fallback(c));
    }
  }
  return bboxMapper(coords);
}

/** viewerData tooltip title label, the fallback display name when a marker has no own `label`. */
function tooltipTitleLabel(f: ViewerMarkerFeature): string | undefined {
  const t = f?.properties?.tooltipData?.title?.label ?? f?.properties?.tooltipData?.content?.[0]?.label;
  return typeof t === 'string' && t.trim() ? t.trim() : undefined;
}

function markerFeatureToUnit(
  f: ViewerMarkerFeature,
  floorId: string,
  planId: PlanId,
  toFraction: (coords: [number, number]) => [number, number],
  index: number
): Unit | null {
  const p = f.properties ?? {};
  const coords = f.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;

  const [x, y] = toFraction(coords as [number, number]);
  const type = unitTypeForMarker(f);
  // Real assignable/bookable records join on their backing recordId/deskId; decorative markers
  // (Camera, Fire extinguisher — no recordId) fall back to objectId just for a stable local key.
  const recordId = p.recordId ?? p.deskId;
  const id = String(recordId ?? p.objectId ?? `${planId}-${index}`);
  const label = (typeof p.label === 'string' && p.label.trim()) || tooltipTitleLabel(f) || id;
  const secondary = typeof p.secondaryLabel === 'string' && p.secondaryLabel.trim() ? p.secondaryLabel.trim() : undefined;

  const unit: Unit = {
    id,
    type,
    label,
    secondary,
    room: null,
    geom: { kind: 'point', x, y },
    floor: floorId,
    plan: planId,
    // No backing record: the id above is an OBJECT id (a small per-plan counter), NOT a module
    // record id — flag it so the save sync never links/creates a record from it (linking one
    // caused real FK violations: objectId 109 sent as a desks/space id).
    ...(recordId == null ? { markerOnly: true } : {}),
  };
  if (type === 'workstation' && DESK_TYPE_BY_NUM[p.deskType]) unit.deskType = DESK_TYPE_BY_NUM[p.deskType];
  const department = departmentName(p) ?? departmentName(p.desk);
  if (department) unit.department = department;
  return unit;
}

/** The record's department lookup as a display string, whichever shape the projection used. */
function departmentName(rec: Record<string, any> | undefined): string | undefined {
  const d = rec?.department;
  const name = typeof d === 'string' ? d : (d?.name ?? d?.primaryValue);
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

/**
 * A polygon zone from viewerData's `spaceZone` layer -> a room Unit. Rooms/spaces are drawn as
 * marked zones (Polygon), NOT point markers, so they come through this layer rather than `marker`.
 * `isReservable`/`reservable` drives assign-vs-book (see Unit.isReservable).
 */
function zoneFeatureToUnit(
  f: ViewerMarkerFeature,
  floorId: string,
  planId: PlanId,
  toFraction: (coords: [number, number]) => [number, number],
  index: number
): Unit | null {
  const ring = polygonRing(f);
  if (!ring) return null;
  const p = f.properties ?? {};
  // Drop the trailing closing vertex if the ring repeats its first point (GeoJSON convention);
  // this app's PolyGeom stores an open ring.
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const pts = open.map((c) => toFraction(c));

  const recordId = p.recordId ?? p.spaceId ?? p.space?.id;
  const id = String(recordId ?? p.objectId ?? `${planId}-zone-${index}`);
  const label = (typeof p.label === 'string' && p.label.trim()) || tooltipTitleLabel(f) || id;
  const secondary = typeof p.secondaryLabel === 'string' && p.secondaryLabel.trim() ? p.secondaryLabel.trim() : undefined;
  const reservable = p.isReservable ?? p.reservable ?? p.space?.reservable;
  const department = departmentName(p) ?? departmentName(p.space);

  return {
    id,
    type: 'room',
    label,
    secondary,
    room: null,
    geom: { kind: 'poly', pts },
    floor: floorId,
    plan: planId,
    ...(department ? { department } : {}),
    ...(typeof reservable === 'boolean' ? { isReservable: reservable } : {}),
    // Same objectId guard as markers — an id that isn't a real space record id must never be
    // linked as one on save (FloorPlan_MarkedZones.SPACE_ID is FK-constrained to BaseSpace).
    ...(recordId == null ? { markerOnly: true } : {}),
  };
}

/**
 * ALL of the floor's records from their real modules (desks/lockers/parkingstall/space), filtered
 * by the floor lookup — including ones with NO on-plan marker yet. Those surface as `unplaced`
 * units: listed in edit mode's "Available to place", and matchable by auto-map's name matching
 * (which otherwise can't link existing records the viewerData feed never mentions).
 */
const FLOOR_RECORD_MODULES: { type: UnitType; moduleName: string; plan: PlanId }[] = [
  { type: 'workstation', moduleName: 'desks', plan: 'workstation' },
  { type: 'locker', moduleName: 'lockers', plan: 'locker' },
  { type: 'parking', moduleName: 'parkingstall', plan: 'parking' },
  { type: 'room', moduleName: 'space', plan: 'custom' },
];

/**
 * Short-lived promise cache for one floor's RAW module-record list. getUnits (unplaced
 * ride-alongs) and getAssignments (desk assignees, see viewerDataAssignmentsForFloor) both need
 * the floor's desks and run CONCURRENTLY per floor load — caching the in-flight promise collapses
 * them into one request, same discipline as viewerDataCache.
 */
const FLOOR_RECORDS_TTL_MS = 20_000;
const floorRecordsCache = new Map<string, { at: number; promise: Promise<any[]> }>();

function fetchFloorRecordsRaw(moduleName: string, floorId: string): Promise<any[]> {
  const key = `${floorId}:${moduleName}`;
  const hit = floorRecordsCache.get(key);
  if (hit && Date.now() - hit.at < FLOOR_RECORDS_TTL_MS) return hit.promise;
  pruneExpired(floorRecordsCache, FLOOR_RECORDS_TTL_MS);
  const promise = (async () => {
    const res: any = await facilioApi.fetchAll(moduleName, {
      page: 1,
      perPage: 500,
      isArchived: false,
      filters: JSON.stringify({ floor: { operatorId: 36, value: [String(floorId)] } }),
    });
    if (res.error || !res.list) throw new Error(res.error?.message || `fetch failed for ${moduleName}`);
    return res.list as any[];
  })();
  promise.catch(() => {
    if (floorRecordsCache.get(key)?.promise === promise) floorRecordsCache.delete(key);
  });
  floorRecordsCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function fetchFloorModuleRecords(floorId: string): Promise<Unit[]> {
  const results = await Promise.all(
    FLOOR_RECORD_MODULES.map(async ({ type, moduleName, plan }) => {
      const list = await fetchFloorRecordsRaw(moduleName, floorId).catch(() => null);
      if (!list) return [] as Unit[];
      return (list as any[]).map(
        (r): Unit => ({
          id: String(r.id),
          type,
          label: r.name ?? `#${r.id}`,
          room: null,
          // Placeholder geometry — `unplaced` keeps it off the canvas until it's actually placed.
          geom: { kind: 'point', x: 0, y: 0 },
          floor: String(floorId),
          plan,
          unplaced: true,
          ...(type === 'workstation' && DESK_TYPE_BY_NUM[r.deskType] ? { deskType: DESK_TYPE_BY_NUM[r.deskType] } : {}),
          ...(type === 'room' && typeof r.reservable === 'boolean' ? { isReservable: r.reservable } : {}),
          ...(departmentName(r) ? { department: departmentName(r) } : {}),
        })
      );
    })
  );
  return results.flat();
}

/**
 * All placed units on a floor, from viewerData — unioned across every plan type configured for the
 * floor (workstations/lockers/parking each have their own `indoorfloorplan` record + viewerData
 * feed). Point markers (desks/lockers/parking/amenities) come from the `marker` layer; rooms/spaces
 * come from the `spaceZone` layer. Positions/type/metadata come straight from the feed; ASSIGNMENT
 * mode is used since geometry doesn't vary by view mode. The floor's module records WITHOUT a
 * marker ride along as `unplaced` units (see fetchFloorModuleRecords).
 */
async function viewerDataUnitsForFloor(floorId: string): Promise<Unit[]> {
  const byType = await getFloorplanDetailsByType(floorId);
  // Dedupe by unit id — a room/space can appear in more than one plan type's feed; a later entry
  // just refreshes the earlier one rather than double-listing it.
  const byId = new Map<string, Unit>();
  let attempted = 0;
  let failed = 0;
  for (const [typeNum, summary] of Object.entries(byType)) {
    const planId = PLAN_ID_BY_TYPE[Number(typeNum)];
    if (!planId || !summary?.id) continue;
    attempted += 1;
    const data = await fetchViewerData(summary.id, 'ASSIGNMENT').catch((err) => {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] viewerData fetch failed for plan ${summary.id} (${planId}, floor ${floorId})`, err);
      return null;
    });
    if (!data) continue;

    const quad = geometryStringToQuad(data.indoorfloorplan?.geometry);
    const markerFeatures: ViewerMarkerFeature[] = (data.marker?.features ?? []).filter(isPointFeature);
    const zoneFeatures: ViewerMarkerFeature[] = (data.spaceZone?.features ?? []).filter(isPolygonFeature);
    // One transform per plan, fed every coordinate (markers + zone vertices) so both layers align.
    const allCoords: [number, number][] = [
      ...markerFeatures.map((f) => f.geometry!.coordinates as [number, number]),
      ...zoneFeatures.flatMap((f) => polygonRing(f) ?? []),
    ];
    const toFraction = fractionMapper(allCoords, quad);

    let markers = 0;
    let rooms = 0;
    markerFeatures.forEach((f, i) => {
      const unit = markerFeatureToUnit(f, floorId, planId, toFraction, i);
      if (unit) {
        byId.set(unit.id, unit);
        markers += 1;
      }
    });
    zoneFeatures.forEach((f, i) => {
      const unit = zoneFeatureToUnit(f, floorId, planId, toFraction, i);
      if (unit) {
        byId.set(unit.id, unit);
        rooms += 1;
      }
    });
    // eslint-disable-next-line no-console
    console.debug(`[facilio-api] viewerData ${planId} plan ${summary.id}: ${markerFeatures.length} markers, ${zoneFeatures.length} zones -> ${markers} units + ${rooms} rooms`);
  }
  // A floor with configured plans where EVERY viewerData call failed is a real error, not an empty
  // floor — throw so the composite falls back to the local tier (keeps the sidebar populated)
  // rather than returning [] (which the composite treats as a valid "empty floor" answer, no
  // fallback). A genuinely empty floor (calls succeeded, zero features) still returns [].
  if (attempted > 0 && failed === attempted) {
    throw new Error(`facilio-api: viewerData failed for all ${attempted} plan type(s) on floor ${floorId}`);
  }

  // The floor's module records with NO marker yet ride along as `unplaced` — placed records
  // (already in byId under the same record id) win, but the MODULE record's richer projection
  // backfills detail fields the viewerData feed doesn't project (department, desk type).
  const moduleRecords = await fetchFloorModuleRecords(floorId).catch(() => [] as Unit[]);
  for (const u of moduleRecords) {
    const placed = byId.get(u.id);
    if (!placed) {
      byId.set(u.id, u);
    } else {
      if (u.department && !placed.department) placed.department = u.department;
      if (u.deskType && !placed.deskType) placed.deskType = u.deskType;
    }
  }

  return [...byId.values()];
}

/**
 * The CLIENT CONTACT id assigned to a desk, read off a viewerData marker's properties —
 * `clientcontact_desks` (the desk module's contact lookup this app writes on assign, see
 * assignUnitReal), with `clientcontact_moves` kept as a fallback for older captures.
 *
 * Deliberately NOT `employeeId` — that's a separate entity (a real employee/people record), a
 * different id space from `clientcontact`; the UI resolves assignment ids against
 * `state.clientContacts` (see selectors.contactById), so an employee id there would resolve to the
 * wrong person or none. Returns null when no client-contact assignee is present.
 */
function contactIdFromMarker(p: Record<string, any>): string | null {
  // The desk module's contact lookup is `clientcontact_desks` (all-lowercase, per the live org's
  // field name); older captures/writes used the camelCase spelling — read BOTH so no assignee is
  // missed, on the record itself or nested under a viewerData marker's `desk`.
  const raw =
    p.clientcontact_desks?.id ??
    p.clientcontact_desks ??
    p.clientContact_desks?.id ??
    p.clientContact_desks ??
    p.desk?.clientcontact_desks?.id ??
    p.desk?.clientcontact_desks ??
    p.desk?.clientContact_desks?.id ??
    p.desk?.clientContact_desks ??
    p.clientcontact_moves?.id ??
    p.clientcontact_moves;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/**
 * Desk/space -> client-contact assignee, from the same viewerData feed getUnits reads (ASSIGNMENT
 * mode). Keyed by the unit id getUnits assigns (recordId/deskId) so the two line up. See
 * `contactIdFromMarker` for why this reads the client-contact field and not `employeeId`.
 */
async function viewerDataAssignmentsForFloor(floorId: string): Promise<Assignments> {
  const byType = await getFloorplanDetailsByType(floorId);
  const map: Assignments = {};
  for (const [, summary] of Object.entries(byType)) {
    if (!summary?.id) continue;
    const data = await fetchViewerData(summary.id, 'ASSIGNMENT').catch(() => null);
    for (const f of (data?.marker?.features ?? []) as ViewerMarkerFeature[]) {
      const p = f.properties ?? {};
      const recordId = p.recordId ?? p.deskId;
      const contactId = contactIdFromMarker(p);
      if (recordId && contactId) map[String(recordId)] = contactId;
    }
  }
  // The desks MODULE is the authority on the current assignee — `clientcontact_desks` lives on
  // the desk record, and the viewerData feed's marker properties don't always project it. Overlay
  // it last so a desk whose record carries clientcontact_desks ALWAYS shows as assigned to that
  // contact, even when viewerData said nothing. (Shares one request with getUnits' concurrent
  // floor-records fetch via fetchFloorRecordsRaw's promise cache.)
  const desks = await fetchFloorRecordsRaw('desks', floorId).catch(() => [] as any[]);
  for (const r of desks) {
    const contactId = contactIdFromMarker(r);
    if (contactId) map[String(r.id)] = contactId;
  }
  return map;
}

export interface FloorPlanTypeSummary {
  id: PlanId;
  name: string;
  recordId: number;
}

/**
 * Which plan types are actually configured for ONE floor — called lazily when that floor is
 * selected (not eagerly for the whole portfolio, which would be an N-request fan-out across
 * every floor for data only the current one needs).
 */
export async function getFloorPlanSummary(floorId: string): Promise<FloorPlanTypeSummary[]> {
  if (!isFacilioApiConfigured) return [];
  const byType = await getFloorplanDetailsByType(floorId);
  return Object.entries(byType).map(([typeNum, rec]: [string, any]) => ({
    id: PLAN_ID_BY_TYPE[Number(typeNum)] ?? 'custom',
    name: PLAN_NAME_BY_TYPE[Number(typeNum)] ?? 'Plan',
    recordId: rec.id,
  }));
}

/**
 * The uploaded image for a floor+plan-type. `getFloorplanDetailsByType` gives the
 * `indoorfloorplan` record id for this floor+type but omits `fileId` (its projection is geared
 * at plan customization, not the file), so this re-fetches that record via the generic
 * `fetchRecord('indoorfloorplan', {id})` module read to get `fileId` — works identically in
 * connected-app mode and dev mode, and matches the pattern already used everywhere else in this
 * file (`uploadFloorplanFile`, `syncMarkersForIndoorFloorPlan`, `ensureRealSpaceRecord`).
 */
export async function fetchFloorplanImage(floorId: string, planId: PlanId): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  const byType = await getFloorplanDetailsByType(floorId);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) return null;

  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: summary.id });
  if (recordRes.error || !recordRes.indoorfloorplan) return null;
  const fileId = recordRes.indoorfloorplan.fileId;
  if (!isValidFileId(fileId)) return null;

  const preview = await fetchFilePreview(fileId, { original: true });
  if (preview.dataUrl) return preview.dataUrl;
  if (!preview.blob) return null;
  // A CAD source plan keeps its ORIGINAL file bytes around (session cache) so Edit mode can offer
  // "Auto-map CAD units" on every visit — not only right after an upload. Analysis stays lazy
  // (running the CAD viewer is expensive); this only remembers the file.
  const type = (preview.contentType || '').toLowerCase() || (await sniffCadOrPdfType(preview.blob));
  if (type.includes('dwg') || type.includes('dxf')) {
    const name = `floorplan.${type.includes('dxf') ? 'dxf' : 'dwg'}`;
    cadSourceFileCache.set(`${floorId}:${planId}`, new File([preview.blob], name, { type }));
  }
  return blobToRenderableDataUrl(preview.blob, preview.contentType);
}

/** Session cache of CAD source files per floor+plan — see fetchFloorplanImage. */
const cadSourceFileCache = new Map<string, File>();

/** The floor+plan's original CAD file when its real plan is a DWG/DXF (fetched this session), else null. */
export function getCachedCadFile(floorId: string, planId: PlanId): File | null {
  return cadSourceFileCache.get(`${floorId}:${planId}`) ?? null;
}

/**
 * The real org's rendering rules for this floor+plan — `indoorfloorplan.customizationBooking`,
 * confirmed against a live capture. Reuses `fetchIndoorFloorPlanRecord` (the same record marker
 * sync round-trips) since the summary from `getFloorplanDetailsByType` omits it, same as `fileId`.
 * Drives marker colors/labels in assign/book view; a null return means this app's own configurable
 * colors (Settings › module colors) should be used instead.
 */
export async function fetchFloorplanCustomization(floorId: string, planId: PlanId): Promise<FloorplanCustomization | null> {
  if (!isFacilioApiConfigured) return null;
  const byType = await getFloorplanDetailsByType(floorId);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) return null;
  const record = await fetchIndoorFloorPlanRecord(summary.id);
  return record?.customizationBooking ?? null;
}

/**
 * Saves (or clears, with `view: null`) this app's default viewport for one floor+plan into the
 * indoorfloorplan record's `customizationBooking` under a namespaced key
 * (`floorplanAppDefaultView`) the native client ignores — riding alongside its rendering rules,
 * never touching them. Full-record round trip (partial patches replace-and-wipe, see
 * syncMarkersForIndoorFloorPlan), INCLUDING the zoneModuleId repair: the GET projection omits it
 * on markedZones, and echoing zones back without it is exactly the payload shape that corrupts
 * zone linkage. Both the object and its JSON-string twin are updated — the record carries both.
 */
export async function saveFloorplanDefaultView(floorId: string, planId: PlanId, view: DefaultPlanView | null): Promise<boolean> {
  if (!isFacilioApiConfigured) return false;
  const byType = await getFloorplanDetailsByType(floorId);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) return false;
  const record = await fetchIndoorFloorPlanRecord(summary.id);
  if (!record) return false;

  const booking: Record<string, unknown> = { ...(record.customizationBooking ?? {}) };
  if (view) booking.floorplanAppDefaultView = view;
  else delete booking.floorplanAppDefaultView;

  const res = await facilioApi.updateRecord('indoorfloorplan', {
    id: summary.id,
    data: { ...record, markedZones: repairZoneModuleIds(record), customizationBooking: booking, customizationBookingJSON: JSON.stringify(booking) },
  });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] default-view save failed for plan ${summary.id}`, res.error);
    return false;
  }
  return true;
}

/**
 * The cheapest possible "does any floor exist" check — a single paginated record (`page: 1,
 * perPage: 1`), no site/building context needed. Used only as the last-resort boot-time default
 * floor when the current user has no assigned/booked desk to land on instead (see `fetchMyDesk`,
 * tried first) — replaces walking the whole site/building tree just to find "a" floor.
 */
export async function getAnyFloor(): Promise<{ id: string; name: string } | null> {
  if (!isFacilioApiConfigured) return null;
  const res = await facilioApi.fetchAll('floor', { page: 1, perPage: 1 });
  if (res.error || !res.list?.length) return null;
  const f = res.list[0];
  return { id: String(f.id), name: f.name };
}

export interface FloorplanFileUploadResult {
  fileId: number;
  /** Object URL of the ORIGINAL uploaded bytes (a valid <img> src only for plain images). */
  previewUrl: string;
  /**
   * Object URL of Facilio's SERVER-RENDERED preview of the file (`v2/files/preview/{fileId}`
   * without `fetchOriginal`) — a rasterized image for formats the browser can't draw itself
   * (PDF, and DWG/DXF where the server rasterizes CAD). Null when the server returned non-image
   * bytes (i.e. it couldn't render that file). This is what lets a browser-unrenderable DWG still
   * be shown: upload → fileId → server image.
   */
  serverImageUrl: string | null;
  /** False when the fileId couldn't be attached to an `indoorfloorplan` record (e.g. `floorId` isn't a real floor id) — the upload+preview still succeeded. */
  attachedToFloorPlan: boolean;
  attachError?: string;
}

/**
 * Fetch Facilio's server-rendered preview image for a stored file id. `v2/files/preview/{id}`
 * WITHOUT `fetchOriginal` rasterizes supported documents (PDF pages, and CAD where the server
 * renders it) to an image. Returns an object URL only when the response is actually an image;
 * otherwise null (the file isn't server-renderable, so callers fall back). Best-effort.
 */
export async function fetchRenderedFileImage(fileId: number): Promise<string | null> {
  if (!isFacilioApiConfigured || !isValidFileId(fileId)) return null;
  try {
    const preview = await fetchFilePreview(fileId);
    if (preview.dataUrl) return preview.dataUrl;
    if (!preview.blob) return null;
    const type = (preview.contentType || preview.blob.type || '').toLowerCase();
    if (type.startsWith('image/')) return URL.createObjectURL(preview.blob);
    return null;
  } catch {
    return null;
  }
}

/**
 * Uploads a floorplan source file (image/PDF/DXF/whatever) to Facilio's real file storage
 * (`POST v3/modules/data/files` in dev mode, `api.uploadFile` in connected-app mode — see
 * `facilioApi.ts`), then attaches that `fileId` to the floor's `indoorfloorplan` record for
 * this `planId` (creating one if it doesn't exist yet). Also fetches the uploaded bytes back
 * for a preview via `fetchFilePreview` (dev: raw blob off `GET v2/files/preview/{fileId}
 * ?fetchOriginal=true`; connected: `common.toBase64`).
 *
 * `indoorfloorplan` requires `floor`/`building`/`site` as `{id}` lookups (not raw ids) plus a
 * `floorPlanType` int (confirmed against a live org: 1=workstation, 2=locker, 3=parking — no
 * generic/custom type). `building`/`site` aren't tracked per-floor in this app's own state, so
 * they're read off the `floor` record itself, which carries both as `{id}` lookups already.
 *
 * The attach step is best-effort and non-fatal: `facilioApi` returns `{error}` rather than
 * throwing on a failed request, so it's checked explicitly rather than trusted to reject —
 * a bad `floorId` (e.g. one that doesn't correspond to a real floor record) fails the attach
 * without discarding the (real, working) uploaded file/preview.
 *
 * `imageDimensions`, when known (the caller already rendered a preview to measure), seeds a
 * synthetic geo-reference quad (`indoorfloorplan.geometry` — see `geoReference.ts`) sized to the
 * image's actual aspect ratio, so `saveFloorplanMarkers` has something to convert this plan's
 * unit-fraction positions against later. Always overwritten on re-upload to stay in sync with
 * whatever image is currently attached.
 */
export async function uploadFloorplanFile(
  floorId: string,
  planId: PlanId,
  file: File,
  imageDimensions?: { width: number; height: number }
): Promise<FloorplanFileUploadResult> {
  if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured');

  const uploadRes = await facilioApi.uploadFiles([file]);
  if (uploadRes.error || !uploadRes.ids?.length) {
    throw new Error(uploadRes.error?.message || 'facilio-api: file upload failed');
  }
  const fileId = Number(uploadRes.ids[0]);

  const preview = await fetchFilePreview(fileId, { original: true });
  const previewUrl = preview.dataUrl ?? URL.createObjectURL(preview.blob!);
  // Also grab the server-RENDERED image (no fetchOriginal) — the display source for files the
  // browser can't draw (PDF, DWG/DXF). Null when the server didn't rasterize it.
  const serverImageUrl = await fetchRenderedFileImage(fileId);

  let attachedToFloorPlan = false;
  let attachError: string | undefined;
  try {
    // `fetchRecord`'s resolved value nests the record under `res[moduleName]` (e.g. `res.floor`),
    // NOT `res.data` — confirmed live: `res.data` is always undefined, which silently failed
    // every attach as "floor not found" regardless of whether the floor actually existed.
    const floorRes = await facilioApi.fetchRecord<any>('floor', { id: floorId });
    if (floorRes.error || !floorRes.floor) throw new Error(floorRes.error?.message || `floor ${floorId} not found`);
    const floorRec = floorRes.floor;
    const siteId = lookupId(floorRec, 'site');
    const buildingId = lookupId(floorRec, 'building');
    if (!siteId || !buildingId) throw new Error('floor record has no site/building lookup');

    const floorPlanType = FLOOR_PLAN_TYPE[planId];
    const geometry = imageDimensions ? quadToGeometryString(computeSyntheticGeometry(imageDimensions.width, imageDimensions.height)) : undefined;
    // Resolve the plan-type mapping FRESH, never from the session cache — a record created or
    // deleted elsewhere (another tab/user) would otherwise send this down the wrong branch
    // (creating a duplicate indoorfloorplan, or updating a ghost).
    floorplanDetailsCache.delete(floorId);
    const existingByType = await getFloorplanDetailsByType(floorId);
    const existing = existingByType[String(floorPlanType)];
    let attachRes;
    if (existing) {
      // REPLACE = full-record round trip, same rule as every other indoorfloorplan write: a
      // partial {fileId} patch risks the backend treating it as a replace and WIPING the
      // record's markers/markedZones/customization. Echo everything back with only the file
      // fields changed — including the markedZones zoneModuleId repair (the GET omits it).
      const record = await fetchIndoorFloorPlanRecord(existing.id);
      if (!record) throw new Error(`indoorfloorplan ${existing.id} fetch failed before re-attach`);
      attachRes = await facilioApi.updateRecord('indoorfloorplan', {
        id: existing.id,
        data: {
          ...record,
          markedZones: repairZoneModuleIds(record),
          fileId,
          name: file.name,
          ...(geometry ? { geometry } : {}),
        },
      });
    } else {
      attachRes = await facilioApi.createRecord('indoorfloorplan', {
        data: {
          floor: { id: floorId },
          building: { id: buildingId },
          site: { id: siteId },
          fileId,
          name: file.name,
          floorPlanType,
          ...(geometry ? { geometry } : {}),
        },
      });
    }
    if (attachRes.error) throw new Error(attachRes.error.message || `code ${attachRes.error.code}`);
    attachedToFloorPlan = true;
    // The plan record just changed — drop every session cache that could serve the OLD plan:
    // the plan-type mapping (a create changes it), viewerData (geometry/file changed), and the
    // CAD source file (auto-map + hi-res zoom tiers must use the NEW drawing, not the one
    // cached at the last image fetch).
    floorplanDetailsCache.delete(floorId);
    viewerDataCache.clear();
    const cadKey = `${floorId}:${planId}`;
    if (/\.(dwg|dxf)$/i.test(file.name)) cadSourceFileCache.set(cadKey, file);
    else cadSourceFileCache.delete(cadKey);
  } catch (err) {
    attachError = (err as Error).message || 'attach failed';
    // A failed attach may itself be a stale-mapping symptom — clear it so a retry re-resolves.
    floorplanDetailsCache.delete(floorId);
  }

  return { fileId, previewUrl, serverImageUrl, attachedToFloorPlan, attachError };
}

/**
 * Syncs this app's placed units to the real `indoorfloorplan` record for ONE plan type — the
 * currently active tab (`planId`) only, not every plan type configured on the floor. Point units
 * (desks/lockers/parking/amenities) go into its embedded `markers` array, room polygons into its
 * embedded `markedZones` array — confirmed against a live capture of the real web app's own save
 * (both are plain fields on the record, not separate modules; `geoId` on each entry is this app's
 * own unit id, doubling as the idempotency key so re-saving updates in place instead of
 * duplicating).
 *
 * A unit's OWN `plan` tag doesn't gate which record it belongs to here — rooms are tagged
 * `'custom'` (not a real, separately-saved plan type; see `FLOOR_PLAN_TYPE`) but still belong to
 * whichever record `'custom'` resolves to (the workstation one) — matching is done by resolved
 * `FLOOR_PLAN_TYPE` number, not the raw `plan` string, so a room synced while viewing the
 * Workstations tab is actually included.
 *
 * Brand-new desks/lockers/parking stalls AND rooms all create their real backing record inline
 * (desks/etc. via `ensureRealSpaceRecord`'s pattern above; rooms via `createRealZoneSpaceRecord`,
 * module name confirmed live — see `ROOM_SPACE_MODULE`). Amenities are the one exception: a
 * brand-new amenity marker (no matching `markers` entry yet) is skipped with a warning rather than
 * guessed at — there's no confirmed real payload yet for what its `markerType`/`markerModuleId`/
 * `recordId` should be for a fresh placement. An amenity that already has a real entry (from a
 * prior real save) still round-trips normally.
 *
 * Skipped when `indoorfloorplan.geometry` isn't set yet (no synthetic geo-reference — see
 * `geoReference.ts` — has been computed, e.g. a floor plan uploaded before this existed): there's
 * no sane lng/lat to convert a unit's 0-1 fraction position into, and guessing would silently
 * misplace it rather than fail loudly.
 */
export async function saveFloorplanMarkers(floorId: string, planId: PlanId, units: Unit[]): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const targetType = FLOOR_PLAN_TYPE[planId];
  const syncable = units.filter(
    (u) =>
      // `unplaced` records (org desks fetched from their modules with NO on-plan position — their
      // geom is a 0,0 placeholder) must NEVER sync: without this, saving one placed desk pushed a
      // phantom origin-marker for every unplaced record on the floor (1 desk -> 125 markers).
      !u.unplaced &&
      FLOOR_PLAN_TYPE[u.plan] === targetType &&
      ((u.geom.kind === 'point' && (u.type === 'workstation' || u.type === 'locker' || u.type === 'parking' || u.type === 'amenity')) ||
        (u.geom.kind === 'poly' && u.type === 'room'))
  );
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(targetType)];
  if (!summary?.id) return;

  // Deliberately NOT caught here — a failed sync must reject so persistUnits' failure toast can
  // actually fire; swallowing it here (as this used to) meant the UI always reported "saved".
  await syncMarkersForIndoorFloorPlan(summary.id, syncable);
}

/**
 * The indoorfloorplan record's own fields, including its embedded `markers`/`markedZones` arrays
 * — neither is a separate related module (the old `floorplanmarker`/`floorplanmarkedzone`
 * relatedList approach didn't actually work): confirmed live, `v3/modules/data/update` for
 * `indoorfloorplan` carries both FULL arrays as fields on the record itself, joined to this app's
 * own units via each entry's `geoId` (a client-assigned id — this app's own unit id). Existing
 * entries reference their backing record (desk/locker/parkingstall/space, or a markertype +
 * arbitrary module record for amenities) by a bare `recordId`; only a brand-new entry (created
 * inline together with its record) needs the record nested in full, which this app doesn't do for
 * desks/lockers/parking — it creates the record separately first (see `ensureRealSpaceRecord`),
 * then references it by id. Rooms/amenities have no such creation path yet (see
 * `saveFloorplanMarkers`).
 */
async function fetchIndoorFloorPlanRecord(indoorFloorPlanId: number): Promise<any | null> {
  const res = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: indoorFloorPlanId });
  if (res.error || !res.indoorfloorplan) return null;
  return res.indoorfloorplan;
}

/**
 * The record's markedZones with `zoneModuleId` restored on every entry. The GET projection
 * OMITS zoneModuleId — so any full-record round-trip write (default-view save, file re-attach,
 * …) that naively echoes the fetched zones back sends exactly the broken payload shape that
 * corrupts zone→module linkage (the musanadah incident). Every such write must go through this.
 */
function repairZoneModuleIds(record: any): any[] {
  const zones: any[] = record?.markedZones ?? [];
  const spaceModuleId = zones.map((z) => z.zoneModuleId ?? z.space?.moduleId).find((v) => v != null) ?? null;
  return zones.map((z) => {
    const zoneModuleId = z.zoneModuleId ?? z.space?.moduleId ?? spaceModuleId;
    return z.zoneModuleId == null && zoneModuleId != null ? { ...z, zoneModuleId } : z;
  });
}

/**
 * `unit.type` -> candidate names for the real org's auto-provisioned "Static" markertype, tried
 * in order against the org's actual markertype list. `desk` is confirmed live
 * (`v3/floorplan/viewerData`'s marker features: `markerType: {name: "desk", isAutoCreate: true,
 * recordModuleId: <desks module id>, type: 1 (Static)}`); locker/parking follow the same
 * per-module naming pattern with spelling variants covered — the resolver only ever uses a name
 * that actually exists in the org, so a miss just leaves markerType unset instead of guessing.
 */
const AUTO_MARKER_TYPE_NAMES: Partial<Record<Unit['type'], string[]>> = {
  workstation: ['desk'],
  locker: ['locker', 'lockers'],
  parking: ['parking stall', 'parkingstall', 'parking'],
};

/** Real org's `markertype` records, name (lowercased) -> numeric id. Session-lifetime cache — this list doesn't change during a session. */
let markerTypeIdByNameCache: Promise<Map<string, number>> | null = null;
async function markerTypeIdByName(name: string): Promise<number | null> {
  if (!markerTypeIdByNameCache) {
    markerTypeIdByNameCache = facilioApi
      .fetchAll('markertype')
      .then((res) => {
        const map = new Map<string, number>();
        for (const m of res.list ?? []) {
          if (m?.name && typeof m.id === 'number') map.set(String(m.name).toLowerCase(), m.id);
        }
        return map;
      })
      .catch(() => {
        // Transient failure — clear so the next save retries, instead of pinning an empty map
        // (= markerType never attached again) for the whole session. Same pattern as
        // modulesListCache.
        markerTypeIdByNameCache = null;
        return new Map<string, number>();
      });
  }
  const map = await markerTypeIdByNameCache;
  return map.get(name.toLowerCase()) ?? null;
}

/** The unit type's auto markertype id, resolved against the org's real markertype list (first candidate name that exists wins). */
async function autoMarkerTypeIdFor(type: Unit['type']): Promise<number | null> {
  for (const name of AUTO_MARKER_TYPE_NAMES[type] ?? []) {
    const id = await markerTypeIdByName(name);
    if (id) return id;
  }
  return null;
}

async function syncMarkersForIndoorFloorPlan(indoorFloorPlanId: number, units: Unit[]): Promise<void> {
  const record = await fetchIndoorFloorPlanRecord(indoorFloorPlanId);
  // The caller only reaches here for a plan record that's known to exist (getFloorplanDetailsByType
  // returned it) — a null fetch is a real failure, not a "nothing to sync" case, so throw for the
  // save toast rather than silently reporting saved.
  if (!record) throw new Error(`indoorfloorplan ${indoorFloorPlanId} fetch failed`);
  // No geo-reference on the plan record (created by the native app, or attached before synthetic
  // geometry existed): this used to SILENTLY skip the whole sync — every placement stayed
  // localStorage-only, so a different browser/incognito tab saw nothing and no error ever
  // surfaced. SELF-HEAL instead: mint the synthetic quad now and persist it WITH the markers
  // (the quad is this app's own coordinate reference — any consistent one works; existing
  // markers on such plans are untouched since they're matched, not re-derived). The default
  // footprint aspect only affects real-world scale, which nothing here consumes.
  let quad = geometryStringToQuad(record.geometry);
  let geometryPatch: string | undefined;
  if (!quad) {
    quad = computeSyntheticGeometry(1492, 1054);
    geometryPatch = quadToGeometryString(quad);
  }

  const pointUnits = units.filter((u): u is Unit & { geom: PointGeom } => u.geom.kind === 'point');
  const roomUnits = units.filter((u): u is Unit & { geom: PolyGeom } => u.geom.kind === 'poly' && u.type === 'room');

  // ---- markers: desks/lockers/parking stalls/amenities (point geometry) ----
  const existingMarkers: any[] = record.markers ?? [];
  // Units can join their marker three ways: geoId (markers this app wrote), recordId
  // (viewerData-sourced units carry the backend record id AS their unit id — see
  // markerFeatureToUnit), or objectId (viewerData units with no backing record, e.g. decorative
  // markers). Matching by geoId alone treated every native-placed marker as brand-new on save —
  // nesting a fresh record (DUPLICATING the real desk) and double-pushing the marker (the
  // preservation loop re-added the "unmatched" original).
  const existingMarkersByGeoId = new Map(existingMarkers.filter((m) => m.geoId).map((m) => [String(m.geoId), m]));
  const existingMarkersByRecordId = new Map(existingMarkers.filter((m) => m.recordId != null).map((m) => [String(m.recordId), m]));
  // NOTE: viewerData FEATURES carry `objectId`; the STORED rows carry that same number as `id`
  // — key on both, or objectId-derived units never match and their entries get rebuilt from
  // scratch (losing the stored row's id/recordId linkage).
  const existingMarkersByObjectId = new Map(
    existingMarkers.filter((m) => m.objectId != null || m.id != null).map((m) => [String(m.objectId ?? m.id), m])
  );
  const consumedMarkers = new Set<any>();
  const nextMarkers: any[] = [];

  // Parent site/building for brand-new desks' nested records — off the indoorfloorplan record
  // itself (it carries floor/building/site lookups; see the attach step that sets them).
  const parentSiteId = lookupId(record, 'site');
  const parentBuildingId = lookupId(record, 'building');
  const parentFloorId = lookupId(record, 'floor');

  // Real markers carry the backing record's module id (`markerModuleId`) — confirmed from a live
  // native-app save payload (desk markers ride with markerModuleId 569547; a non-desk marker
  // rides with markerType + markerModuleId + recordId). Resolve name -> id once per sync via the
  // cached org modules list; a miss just omits the field (backend derives it from markerType).
  const orgModules = await getAllModules().catch(() => [] as ModuleSummary[]);
  const moduleIdByName = new Map(orgModules.map((m) => [m.name, m.id]));

  // The org's desk spaceCategory id (native save payloads carry it on every nested desk —
  // spaceCategory {id: 6533} in the confirmed capture). All of an org's desks share it, so read
  // it off ANY existing desk on the plan; when none exists yet the field is simply omitted.
  const deskSpaceCategoryId: number | null =
    existingMarkers.map((m) => m.desk?.spaceCategory?.id ?? m.desk?.spaceCategoryId).find((v: unknown) => typeof v === 'number') ?? null;

  for (const unit of pointUnits) {
    const match =
      existingMarkersByGeoId.get(unit.id) ?? existingMarkersByRecordId.get(unit.id) ?? existingMarkersByObjectId.get(unit.id);
    if (match) consumedMarkers.add(match);
    if (!match && unit.type === 'amenity') {
      // No confirmed real payload for a BRAND NEW amenity's backing record — skip rather than
      // guess at markerType/markerModuleId/recordId. An amenity that already has an entry (from
      // a prior real save) still round-trips below.
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] amenity marker ${unit.id} has no existing backend entry — not synced (creation flow unconfirmed)`);
      continue;
    }
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const geometry = JSON.stringify({ type: 'Point', coordinates: [lng, lat] });
    // The native app's own save payload (captured live) sends `properties` as plain "{}" on
    // EVERY marker — desk and non-desk alike. Preserve an existing entry's string on the
    // round-trip; brand-new entries get "{}" to match.
    const properties = match?.properties ?? '{}';
    // A brand-new entry's markerType, resolved per type against the org's real markertype list
    // (see AUTO_MARKER_TYPE_NAMES — desks/lockers/parking); an existing match's own markerType
    // (spread below) is never overridden by this.
    let newMarkerType: { id: number } | undefined;
    const recordKey = MARKER_RECORD_KEY[unit.type];
    // A unit whose id IS a real backend record id (numeric — auto-map name match, placement
    // dialog, record-swap lookup, unplaced-list drag) getting its FIRST marker LINKS that record.
    // markerOnly units are excluded: their numeric ids are viewerData OBJECT ids, not record ids
    // (linking one throws an FK violation server-side).
    //
    // No record selected -> the marker saves BARE: no nested desk/locker/parkingStall object goes
    // on the update payload at all (inline creation is deliberately gone — it minted records the
    // user never asked for). The real record is created lazily on first actual use instead
    // (assignment/booking via ensureRealSpaceRecord).
    const existingRecordId = !match && !unit.markerOnly && /^\d+$/.test(unit.id) ? Number(unit.id) : null;
    if (!match) {
      const id = await autoMarkerTypeIdFor(unit.type);
      if (id) newMarkerType = { id };
    }
    // Spread the existing entry first so anything it already carries (recordId, markerType,
    // markerModuleId, etc.) survives the round-trip untouched — only geometry/label are ours to
    // change.
    // markerModuleId only travels when the marker actually references a record.
    const newModuleId = existingRecordId && recordKey ? moduleIdByName.get(REAL_SPACE_MODULE[unit.type] ?? '') : undefined;
    // Record-field changes (deskType/secondary/name) ride INSIDE the marker's nested record in
    // this same indoorfloorplan update — the backend syncs them to the desks/lockers/parkingstall
    // record from there (matching the native app's payload, which nests the full record on every
    // marker). This replaced one separate updateRecord PATCH per desk per save.
    // A marker's nested record object MUST always carry id + name (+ deskType for desks) —
    // mandatory backend fields; an id-only reference is not accepted.
    let matchedRecordPatch: Record<string, unknown> | undefined;
    if (match && recordKey && (match[recordKey] || match.recordId)) {
      const fields: Record<string, unknown> = { name: unit.label };
      if (unit.type === 'workstation' && unit.deskType) fields.deskType = DESK_TYPE_NUM[unit.deskType];
      if (unit.secondary) fields.secondary = unit.secondary;
      // When the fetched row omits the nested record (projection variance), rebuild it in the
      // native payload's full field shape rather than id-only (same set as the link branch).
      const rebuiltBase: Record<string, unknown> = {
        id: match.recordId,
        spaceType: -1,
        resourceType: 1,
        reservable: false,
        isArchived: false,
        ...(parentSiteId ? { siteId: parentSiteId } : {}),
        ...(parentBuildingId ? { building: { id: parentBuildingId } } : {}),
        floorId: Number(parentFloorId ?? unit.floor),
        floor: { id: Number(parentFloorId ?? unit.floor) },
        ...(deskSpaceCategoryId && unit.type === 'workstation' ? { spaceCategory: { id: deskSpaceCategoryId } } : {}),
      };
      const patchObj: Record<string, unknown> = { ...(match[recordKey] ?? rebuiltBase), ...fields };
      // deskType is mandatory on the desk object: keep the fetched record's when the unit
      // doesn't carry one, defaulting to ASSIGNED only as the last resort.
      if (unit.type === 'workstation' && patchObj.deskType == null) {
        patchObj.deskType = DESK_TYPE_NUM[unit.deskType ?? 'ASSIGNED'];
      }
      matchedRecordPatch = patchObj;
    }
    nextMarkers.push({
      ...(match ?? {}),
      ...(newMarkerType ? { markerType: newMarkerType } : {}),
      ...(matchedRecordPatch && recordKey ? { [recordKey]: matchedRecordPatch } : {}),
      // Existing-record link (see existingRecordId above): the FULL desk object travels, in the
      // exact field set the native app's own save carries (confirmed capture): id + name +
      // deskType + site/building/floor lookups + spaceCategory + resourceType/spaceType/
      // reservable/isArchived — not an id-only reference.
      ...(existingRecordId
        ? {
            recordId: existingRecordId,
            ...(recordKey
              ? {
                  [recordKey]: {
                    id: existingRecordId,
                    name: unit.label,
                    ...(unit.type === 'workstation' ? { deskType: DESK_TYPE_NUM[unit.deskType ?? 'ASSIGNED'] } : {}),
                    spaceType: -1,
                    resourceType: 1,
                    reservable: false,
                    isArchived: false,
                    ...(parentSiteId ? { siteId: parentSiteId } : {}),
                    ...(parentBuildingId ? { building: { id: parentBuildingId } } : {}),
                    floorId: Number(parentFloorId ?? unit.floor),
                    floor: { id: Number(parentFloorId ?? unit.floor) },
                    ...(deskSpaceCategoryId ? { spaceCategory: { id: deskSpaceCategoryId } } : {}),
                  },
                }
              : {}),
          }
        : {}),
      ...(newModuleId ? { markerModuleId: newModuleId } : {}),
      geoId: unit.id,
      geometry,
      properties,
      type: 'Feature',
      indoorfloorplan: { id: indoorFloorPlanId },
      label: unit.label,
    });
  }
  // Unconsumed markers: a geoId-tagged one whose unit is gone was deleted in this app — drop it.
  // One with no geoId that ALSO matched no unit is preserved untouched (defensive: if the floor's
  // units came from a fallback tier rather than viewerData, nothing joins by recordId/objectId,
  // and dropping would wipe every native marker). Consumed ones are already in nextMarkers —
  // re-pushing them here was the old double-push bug.
  const droppedMarkerRowIds: number[] = [];
  for (const m of existingMarkers) {
    if (consumedMarkers.has(m)) continue;
    if (m.geoId) {
      // Dropping it from the array removes it from the plan, but the floorplanmarker ROW itself
      // lingers in the module — collect its id for the bulk delete below.
      if (typeof m.id === 'number' && m.id > 0) droppedMarkerRowIds.push(m.id);
    } else {
      nextMarkers.push(m);
    }
  }

  // ---- markedZones: rooms (polygon geometry) ----
  const existingZones: any[] = record.markedZones ?? [];
  // Same three-way join as markers: geoId (ours), recordId / space.id (viewerData-sourced rooms
  // carry the backend record id as their unit id), objectId.
  const existingZonesByGeoId = new Map(existingZones.filter((z) => z.geoId).map((z) => [String(z.geoId), z]));
  const existingZonesByRecordId = new Map(
    existingZones.filter((z) => z.recordId != null || z.space?.id != null).map((z) => [String(z.recordId ?? z.space?.id), z])
  );
  // Same objectId/id duality as markers above — without keying on the stored row's `id`,
  // objectId-derived rooms missed the join and their zones were rebuilt WITHOUT the existing
  // recordId/zoneModuleId (the "markedZones lost their record ids" failure).
  const existingZonesByObjectId = new Map(
    existingZones.filter((z) => z.objectId != null || z.id != null).map((z) => [String(z.objectId ?? z.id), z])
  );
  const consumedZones = new Set<any>();
  const nextZones: any[] = [];

  // Zone-side counterpart of markerModuleId: every markedZones entry must carry zoneModuleId —
  // the `space` module's numeric id (spacebooking resolution reads it as parentModuleId; the
  // native capture shows it on every zone). Resolved once from the org's module list.
  const spaceModuleId = moduleIdByName.get(ROOM_SPACE_MODULE) ?? null;

  for (const unit of roomUnits) {
    const match = existingZonesByGeoId.get(unit.id) ?? existingZonesByRecordId.get(unit.id) ?? existingZonesByObjectId.get(unit.id);
    if (match) consumedZones.add(match);
    const ring = [...unit.geom.pts, unit.geom.pts[0]].map(([x, y]) => quadToLngLat(quad, x, y));
    const geometry = JSON.stringify({ type: 'Polygon', coordinates: [ring] });

    if (!match) {
      // A room whose unit id IS a real space record id (numeric — an existing org room getting
      // its first outline) LINKS that record; a genuinely new room gets its `space` record
      // created FIRST (createRealZoneSpaceRecord — the confirmed flow) and referenced by id.
      // Inline-nesting a space WITHOUT an id (the desk-marker analogy) is NOT accepted for
      // markedZones — the server errors on the missing space id. markerOnly rooms are excluded
      // from linking: their numeric ids are viewerData OBJECT ids, not BaseSpace ids — linking
      // one violated FloorPlan_MarkedZones' SPACE_ID foreign key.
      let spaceId = !unit.markerOnly && /^\d+$/.test(unit.id) ? Number(unit.id) : null;
      let zoneModuleId: number | null = null;
      if (!spaceId) {
        const created = await createRealZoneSpaceRecord(unit);
        if (!created) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] room ${unit.id} backing space create failed — zone not synced`);
          continue;
        }
        spaceId = created.recordId;
        zoneModuleId = created.zoneModuleId;
      }
      nextZones.push({
        geoId: unit.id,
        geometry,
        properties: '{}',
        type: 'Feature',
        indoorfloorplan: { id: indoorFloorPlanId },
        label: unit.label,
        isReservable: unit.isReservable ?? true,
        recordId: spaceId,
        space: { id: spaceId, reservable: unit.isReservable ?? true },
        ...(zoneModuleId ?? spaceModuleId ? { zoneModuleId: zoneModuleId ?? spaceModuleId } : {}),
      });
      continue;
    }
    nextZones.push({
      ...match,
      geoId: unit.id,
      geometry,
      properties: match.properties ?? '{}',
      type: 'Feature',
      indoorfloorplan: { id: indoorFloorPlanId },
      label: unit.label,
      isReservable: unit.isReservable ?? match.isReservable,
      // A zone entry must always carry its space id — a fetched entry that omits the nested
      // space (projection variance) rebuilds it from recordId instead of sending nothing.
      space: match.space
        ? { ...match.space, reservable: unit.isReservable ?? match.space.reservable }
        : match.recordId
          ? { id: match.recordId, reservable: unit.isReservable ?? true }
          : match.space,
      // Matched rows fetched WITHOUT zoneModuleId (this projection omits it) get it restored —
      // markers always carry markerModuleId; zones must always carry this.
      ...(match.zoneModuleId ?? spaceModuleId ? { zoneModuleId: match.zoneModuleId ?? spaceModuleId } : {}),
    });
  }
  // Same preservation rule as markers: drop only our own (geoId-tagged) zones whose unit is gone;
  // preserve unmatched native zones; never re-push consumed ones.
  const droppedZoneRowIds: number[] = [];
  for (const z of existingZones) {
    if (consumedZones.has(z)) continue;
    if (z.geoId) {
      if (typeof z.id === 'number' && z.id > 0) droppedZoneRowIds.push(z.id);
    } else {
      nextZones.push(z);
    }
  }

  // Round-trip the WHOLE fetched record, not just {markers, markedZones} — a live capture of the
  // real web app's own save confirmed the update payload always carries every field back
  // (customizationJSON, customizationBookingJSON, name, geometry, etc.), not just the ones
  // actually changing. A partial patch risks the backend treating this as a full replace and
  // wiping those other fields rather than merging.
  const res = await facilioApi.updateRecord('indoorfloorplan', {
    id: indoorFloorPlanId,
    data: { ...record, ...(geometryPatch ? { geometry: geometryPatch } : {}), markers: nextMarkers, markedZones: nextZones },
  });
  if (res.error) {
    // Throw (not just warn) — the save UI must be able to report this instead of "saved".
    throw new Error(res.error.message || `indoorfloorplan ${indoorFloorPlanId} update failed (code ${res.error.code ?? '?'})`);
  }
  // Markers/zones removed from the plan above are gone from the RECORD, but their own module rows
  // (floorplanmarker / floorplanmarkedzone) survive — the real web client deletes them explicitly.
  // Best-effort AFTER the plan update landed: a failed delete leaves an orphan row, never a
  // half-saved plan.
  await deleteFloorplanRows('floorplanmarker', droppedMarkerRowIds);
  await deleteFloorplanRows(ZONE_ROW_MODULE, droppedZoneRowIds);
  // The plan's markers just changed — a viewerData response cached before this write is stale
  // (e.g. brand-new desks would come back without their recordIds for up to the TTL).
  viewerDataCache.clear();
}

/** The marked-zone rows' own module (markers live in `floorplanmarker`). */
const ZONE_ROW_MODULE = 'floorplanmarkedzone';

/**
 * Bulk-deletes plan row records via `DELETE v3/modules/data/delete?skipPermission=true` with body
 * `{moduleName, data: {<moduleName>: [ids…]}}` — the exact endpoint/payload the real web client
 * uses when markers are removed from a plan (confirmed live capture). Falls back to per-id
 * `deleteRecord` when the bulk endpoint isn't available (connected-mode DELETE-with-body isn't
 * independently verified). Best-effort throughout: an undeleted row is an orphan, not a
 * correctness problem for the plan itself, so failures warn instead of throwing.
 */
async function deleteFloorplanRows(moduleName: string, ids: number[]): Promise<void> {
  if (!isFacilioApiConfigured || !ids.length) return;
  try {
    const body = await customDelete('v3/modules/data/delete', { moduleName, data: { [moduleName]: ids } }, { skipPermission: true });
    if (body?.code === 0 || body?.code === undefined) return;
    throw new Error(body?.message || `code ${body?.code}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] bulk delete failed for ${moduleName} [${ids.join(',')}] — falling back to per-id delete`, err);
    for (const id of ids) {
      const res = await facilioApi.deleteRecord(moduleName, id).catch((e) => ({ error: e }) as any);
      if (res?.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] ${moduleName} ${id} delete failed`, res.error);
      }
    }
  }
}

/**
 * Real module a placed unit's employee-assignment backs onto, confirmed against a live org.
 * Desks use `moves` — Lockers/Parking Stall are a plain `employee` field update with no move
 * record (confirmed via the org's own module docs: "Moves are the reassignment mechanism for
 * Desks only").
 */
const REAL_SPACE_MODULE: Partial<Record<Unit['type'], string>> = {
  workstation: 'desks',
  locker: 'lockers',
  parking: 'parkingstall',
};

/**
 * The marker object's field for a brand-new unit's nested backing record — the backend creates
 * the record inline from it (see syncMarkersForIndoorFloorPlan). `desk` is confirmed; locker/
 * parkingStall follow the org's singular-camelCase field pattern (same names spacebooking uses
 * for its resource lookups). Rooms nest under `space` on the markedZone entry instead.
 */
const MARKER_RECORD_KEY: Partial<Record<Unit['type'], string>> = {
  workstation: 'desk',
  locker: 'locker',
  parking: 'parkingStall',
};

/**
 * Rooms' real backing module — confirmed live via `v3/floorplan/viewerData`'s
 * `floorplanMappedmodules` list (moduleId 569101 = name `"space"`, the generic room/space
 * business module every other space-like module extends). The two `markedZones` examples
 * captured earlier had different `zoneModuleId` values NOT because room category varies the
 * module (as originally assumed) — one of them was actually a locker drawn as a polygon zone
 * (`markerModuleName: "lockers"`), not a room at all; a genuine room's zone is always this module.
 */
const ROOM_SPACE_MODULE = 'space';

interface RealSpaceRef {
  recordId: number;
  /** The floor's site id — sent on `moves` records to match the real web app's payload shape. */
  siteId?: number;
  /** Rooms only — the `space` module's own numeric moduleId (for spacebooking's parentModuleId), read off the zone entry's `zoneModuleId` or resolved via `moduleIdFor` when just created. */
  parentModuleId?: number;
}

/**
 * Creates a room's real backing `space` record (module name confirmed live, see
 * `ROOM_SPACE_MODULE`) and resolves that module's own numeric id — shared by
 * `syncMarkersForIndoorFloorPlan` (bulk, on "Save changes") and `ensureRealZoneRecord` (lazily, on
 * first booking) so a brand-new room gets the same treatment either way.
 */
async function createRealZoneSpaceRecord(unit: Unit): Promise<{ recordId: number; zoneModuleId: number | null; siteId?: number } | null> {
  const floorRes = await facilioApi.fetchRecord<any>('floor', { id: unit.floor });
  if (floorRes.error || !floorRes.floor) return null;
  const siteId = Number(lookupId(floorRes.floor, 'site')) || undefined;
  const buildingId = lookupId(floorRes.floor, 'building');

  const createRes = await facilioApi.createRecord<any>(ROOM_SPACE_MODULE, {
    data: { name: unit.label, site: { id: siteId }, building: { id: buildingId }, floor: { id: unit.floor }, reservable: unit.isReservable ?? true },
  });
  if (createRes.error || !createRes[ROOM_SPACE_MODULE]?.id) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] room backing-record create failed for unit ${unit.id}`, createRes.error);
    return null;
  }
  const recordId = createRes[ROOM_SPACE_MODULE].id;
  const zoneModuleId = await moduleIdFor(ROOM_SPACE_MODULE, recordId);
  return { recordId, zoneModuleId, siteId };
}

/**
 * `unit.id` -> real desks/lockers/parkingstall record ref, once resolved. Assign/vacate are
 * booking-adjacent actions the user can repeat often (reassign, then vacate, then reassign) —
 * without this, EVERY one of those re-ran the full indoorfloorplan+marker-list lookup below just
 * to re-derive the same id. Cleared on full page reload only (session-lifetime cache); that's
 * fine since a unit's backing record never changes once created.
 */
const realSpaceRecordCache = new Map<string, RealSpaceRef>();

/**
 * Finds the real desks/lockers/parkingstall record backing a placed unit — joined via the
 * unit's `floorplanmarker.recordId` (set here the first time a unit is actually assigned; units
 * that are never assigned never get a real space record, only their marker). If the marker
 * itself doesn't exist yet — the normal case when a unit was just placed and assigned BEFORE
 * hitting "Save changes" (marker sync is deliberately save-only) — it's created inline here, so
 * an assignment always produces its Move/desk record instead of silently skipping.
 */
async function ensureRealSpaceRecord(unit: Unit): Promise<RealSpaceRef | null> {
  if (unit.type === 'room') return ensureRealZoneRecord(unit);
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return null;
  const cached = realSpaceRecordCache.get(unit.id);
  if (cached) return cached;

  const byType = await getFloorplanDetailsByType(unit.floor).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE[unit.plan])];
  if (!summary?.id) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] no configured floor plan for unit ${unit.id} (${unit.plan} on floor ${unit.floor}) — assignment not persisted to backend`);
    return null;
  }

  const record = await fetchIndoorFloorPlanRecord(summary.id);
  if (!record) return null;
  const markers: any[] = record.markers ?? [];
  // Join by geoId (this app's own client-assigned marker id — set on markers this app wrote) OR by
  // recordId (units sourced from viewerData carry the backend record id AS their unit id — see
  // markerFeatureToUnit). Without the recordId match, a viewerData-sourced desk wouldn't find its
  // existing marker and would wrongly create a duplicate record below.
  let marker = markers.find((m) => m.geoId === unit.id) ?? markers.find((m) => m.recordId != null && String(m.recordId) === unit.id);

  if (!marker) {
    if (unit.geom.kind !== 'point') return null;
    const quad = geometryStringToQuad(record.geometry);
    if (!quad) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] floor plan ${summary.id} has no geo-reference — assignment for unit ${unit.id} not persisted to backend`);
      return null;
    }
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const markerTypeId = await autoMarkerTypeIdFor(unit.type);
    marker = {
      geoId: unit.id,
      geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }),
      properties: JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null }),
      type: 'Feature',
      indoorfloorplan: { id: summary.id },
      label: unit.label,
      ...(markerTypeId ? { markerType: { id: markerTypeId } } : {}),
    };
    // Round-trip the whole record (not just {markers}) — see the matching comment in
    // syncMarkersForIndoorFloorPlan for why a partial patch risks wiping other fields.
    const createRes = await facilioApi.updateRecord('indoorfloorplan', { id: summary.id, data: { ...record, markers: [...markers, marker] } });
    if (createRes.error) return null;
  }

  const floorRes = await facilioApi.fetchRecord<any>('floor', { id: unit.floor });
  if (floorRes.error || !floorRes.floor) return null;
  const siteId = Number(lookupId(floorRes.floor, 'site')) || undefined;
  const buildingId = lookupId(floorRes.floor, 'building');

  if (marker.recordId) {
    const ref = { recordId: marker.recordId, siteId };
    realSpaceRecordCache.set(unit.id, ref);
    return ref;
  }

  const createRes = await facilioApi.createRecord<any>(moduleName, {
    data: {
      name: unit.label,
      site: { id: siteId },
      building: { id: buildingId },
      floor: { id: unit.floor },
      // Same integer enum as the marker-nested create path (ASSIGNED=1/HOT=2/HOTEL=3).
      ...(unit.type === 'workstation' ? { deskType: DESK_TYPE_NUM[unit.deskType ?? 'ASSIGNED'] } : {}),
      // parkingMode is MANDATORY on parkingstall creation — 1 = Permanent.
      ...(unit.type === 'parking' ? { parkingMode: 1 } : {}),
    },
  });
  if (createRes.error || !createRes[moduleName]?.id) return null;
  const recordId = createRes[moduleName].id;
  // Link the new record id back onto the marker within the embedded array — re-fetch fresh
  // rather than reusing what's in scope, in case the array changed since it was last read.
  const latest = await fetchIndoorFloorPlanRecord(summary.id);
  if (latest) {
    const latestMarkers: any[] = (latest.markers ?? []).map((m: any) => (m.geoId === unit.id ? { ...m, recordId } : m));
    await facilioApi.updateRecord('indoorfloorplan', { id: summary.id, data: { ...latest, markers: latestMarkers } }).catch(() => {});
  }
  const ref = { recordId, siteId };
  realSpaceRecordCache.set(unit.id, ref);
  return ref;
}

/**
 * A room's backing "space" record — mirrors `ensureRealSpaceRecord`'s desk pattern: an existing
 * real zone entry (by `geoId`, from some prior real save/import) resolves as-is; a brand-new room
 * gets its backing `space` record created inline (module name confirmed live, see
 * `ROOM_SPACE_MODULE`), same as `syncMarkersForIndoorFloorPlan`'s bulk save-time creation, so a
 * room booked before ever hitting "Save changes" still gets a real record.
 */
async function ensureRealZoneRecord(unit: Unit): Promise<RealSpaceRef | null> {
  const cached = realSpaceRecordCache.get(unit.id);
  if (cached) return cached;

  const byType = await getFloorplanDetailsByType(unit.floor).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE[unit.plan])];
  if (!summary?.id) return null;

  const record = await fetchIndoorFloorPlanRecord(summary.id);
  if (!record) return null;
  const zones: any[] = record.markedZones ?? [];
  let zone = zones.find((z) => z.geoId === unit.id);
  let siteId: number | undefined;

  if (!zone) {
    if (unit.geom.kind !== 'poly') return null;
    const quad = geometryStringToQuad(record.geometry);
    if (!quad) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] floor plan ${summary.id} has no geo-reference — room ${unit.id} not persisted to backend`);
      return null;
    }
    const created = await createRealZoneSpaceRecord(unit);
    if (!created) return null;
    siteId = created.siteId;
    const ring = [...unit.geom.pts, unit.geom.pts[0]].map(([x, y]) => quadToLngLat(quad, x, y));
    zone = {
      geoId: unit.id,
      geometry: JSON.stringify({ type: 'Polygon', coordinates: [ring] }),
      properties: '{}',
      type: 'Feature',
      indoorfloorplan: { id: summary.id },
      label: unit.label,
      isReservable: unit.isReservable ?? true,
      space: { id: created.recordId, reservable: unit.isReservable ?? true },
      zoneModuleId: created.zoneModuleId,
      recordId: created.recordId,
    };
    // Round-trip the whole record — see the matching comment in syncMarkersForIndoorFloorPlan.
    const createZoneRes = await facilioApi.updateRecord('indoorfloorplan', { id: summary.id, data: { ...record, markedZones: [...zones, zone] } });
    if (createZoneRes.error) return null;
  }

  if (!zone.recordId) return null;
  if (siteId === undefined) {
    const floorRes = await facilioApi.fetchRecord<any>('floor', { id: unit.floor });
    siteId = floorRes.error || !floorRes.floor ? undefined : Number(lookupId(floorRes.floor, 'site')) || undefined;
  }

  const ref: RealSpaceRef = { recordId: zone.recordId, siteId, parentModuleId: zone.zoneModuleId };
  realSpaceRecordCache.set(unit.id, ref);
  return ref;
}

/**
 * READ-ONLY resolution of the real backend record backing a placed unit — unlike
 * `ensureRealSpaceRecord`, never creates anything: null for a unit with no real record yet.
 * Resolution order: session cache -> numeric unit id (viewerData-sourced units carry the backing
 * record id AS their unit id) -> indoorfloorplan marker/zone join by geoId OR recordId. Rooms
 * resolve to the `space` module via their zone entry; amenities have no stateful record -> null.
 * Powers the stateflow/approval UI (see StateflowActions), which must never mint records just to
 * show state.
 */
export async function resolveUnitRecordRef(unit: Unit): Promise<{ moduleName: string; recordId: number } | null> {
  if (!isFacilioApiConfigured) return null;
  const moduleName = unit.type === 'room' ? ROOM_SPACE_MODULE : REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return null;

  const cached = realSpaceRecordCache.get(unit.id)?.recordId;
  if (cached) return { moduleName, recordId: cached };
  // viewerData-sourced units: the unit id IS the backend record id.
  if (/^\d+$/.test(unit.id)) return { moduleName, recordId: Number(unit.id) };

  const byType = await getFloorplanDetailsByType(unit.floor).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE[unit.plan])];
  if (!summary?.id) return null;
  const record = await fetchIndoorFloorPlanRecord(summary.id);
  if (!record) return null;
  if (unit.type === 'room') {
    const zone = (record.markedZones ?? []).find((z: any) => z.geoId === unit.id || String(z.recordId ?? z.space?.id) === unit.id);
    const recordId = zone?.recordId ?? zone?.space?.id;
    return recordId ? { moduleName, recordId: Number(recordId) } : null;
  }
  const marker = (record.markers ?? []).find((m: any) => m.geoId === unit.id || String(m.recordId) === unit.id);
  return marker?.recordId ? { moduleName, recordId: Number(marker.recordId) } : null;
}

/**
 * A placed unit's real backend record status label, read-only. Returns a printable string only
 * (`stateName` unwraps the `moduleState` LOOKUP OBJECT — rendering the raw field crashed JSX on
 * live orgs where moduleState is `{id, displayName, ...}`).
 */
export async function fetchUnitModuleState(unit: Unit): Promise<string | null> {
  const ref = await resolveUnitRecordRef(unit);
  if (!ref) return null;
  const res = await facilioApi.fetchRecord<any>(ref.moduleName, { id: ref.recordId });
  if (res.error || !res[ref.moduleName]) return null;
  return stateName(res[ref.moduleName].moduleState);
}

export interface ModuleSummary {
  id: number;
  name: string;
  displayName: string;
}

let modulesListCache: Promise<ModuleSummary[]> | null = null;

/** One raw module object -> ModuleSummary, tolerant of id/name living under either field name. */
function toModuleSummary(m: any): ModuleSummary {
  return { id: Number(m?.id ?? m?.moduleId), name: m?.name ?? m?.moduleName ?? '', displayName: m?.displayName ?? m?.name ?? m?.moduleName ?? '' };
}

/**
 * All modules in the org (`v3/modules/list/all?skipPermission=true` — confirmed live) — the
 * "Select Module" dropdown when creating a custom marker type (recordModuleId). The response
 * carries TWO separate lists — system modules and custom modules (per the user's description of
 * the real payload; exact key names not captured, so common spellings of each are tried) — which
 * are combined into one list here, de-duped by module id, system first. Falls back to the older
 * single-list guesses when neither split list is present. Cached for the session (module list
 * doesn't change during a session).
 */
export function getAllModules(): Promise<ModuleSummary[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  if (!modulesListCache) {
    modulesListCache = customGet('v3/modules/list/all', { skipPermission: true })
      .then((body: any) => {
        const root = body?.data ?? body?.result ?? body ?? {};
        const asArray = (v: unknown) => (Array.isArray(v) ? v : []);
        const system = asArray(root.systemModules ?? root.system ?? root.defaultModules);
        const custom = asArray(root.customModules ?? root.custom);
        let combined = [...system, ...custom];
        if (combined.length === 0) {
          // Older single-list fallbacks, kept in case some org/version returns a flat list.
          const flat = root.modules ?? body?.data ?? body?.result?.modules ?? body?.result ?? body?.modules ?? [];
          combined = asArray(flat);
        }
        const seen = new Set<number>();
        return combined
          .map(toModuleSummary)
          .filter((m: ModuleSummary) => {
            if (!Number.isFinite(m.id) || !m.name || seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] module list fetch failed', err);
        modulesListCache = null; // transient failure — allow a retry on next open
        return [];
      });
  }
  return modulesListCache;
}

/**
 * Real custom marker types (`markertype` module — `POST v3/modules/data/create`, confirmed live
 * with `{name, description, fileId, recordModuleId, isAutoCreate}`). Neutral default color since
 * the real schema carries no color field (this app's own MarkerDef always has one) — real markers
 * render from their `fileId` image instead.
 */
export async function getCustomMarkerTypes(): Promise<MarkerDef[]> {
  if (!isFacilioApiConfigured) return [];
  const res = await facilioApi.fetchAll('markertype');
  if (res.error) throw new Error(`facilio-api: marker type fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
  return (res.list ?? []).map((m: any) => ({
    id: String(m.id),
    name: m.name,
    color: '#607796',
    text: (m.name ?? '?').slice(0, 2).toUpperCase(),
    fileId: isValidFileId(m.fileId) ? m.fileId : undefined,
  }));
}

export interface CreateMarkerTypeInput {
  name: string;
  description?: string;
  fileId: number;
  recordModuleId: number;
}

/** Creates a real `markertype` record — returns its new record id, or throws with the server's error message. */
export async function createMarkerType(input: CreateMarkerTypeInput): Promise<{ id: string }> {
  const res = await facilioApi.createRecord<any>('markertype', {
    data: {
      name: input.name,
      description: input.description ?? '',
      fileId: input.fileId,
      recordModuleId: input.recordModuleId,
      isAutoCreate: false,
    },
  });
  if (res.error || !res.markertype?.id) throw new Error(res.error?.message || 'facilio-api: marker type create failed');
  return { id: String(res.markertype.id) };
}

/** A marker icon's displayable URL, resolved from its `fileId` (same file-preview path as floorplan images). */
export async function fetchMarkerIconUrl(fileId: number): Promise<string | null> {
  if (!isFacilioApiConfigured || !isValidFileId(fileId)) return null;
  const preview = await fetchFilePreview(fileId, { original: true });
  if (preview.dataUrl) return preview.dataUrl;
  if (!preview.blob) return null;
  return URL.createObjectURL(preview.blob);
}

/** Uploads a marker icon image, returning its fileId (for the `markertype` create payload). */
export async function uploadMarkerIcon(file: File): Promise<number> {
  const res = await facilioApi.uploadFiles([file]);
  if (res.error || !res.ids?.length) throw new Error(res.error?.message || 'facilio-api: marker icon upload failed');
  return Number(res.ids[0]);
}

export interface MyDeskInfo {
  recordId: number;
  name: string;
  floorId: string | null;
  /** True when this came from `bookedDesks` (a hot-desk booking) rather than a permanent assignment. */
  booked: boolean;
}

/**
 * The logged-in SESSION user's ids, from the account endpoint (cached per session):
 * - `peopleId` — the clientcontact/people record id, the id space desk assignment lives in
 *   (`desks.clientcontact_desks` holds it; it is NOT the login user id / ouid).
 * - `roleId` — the user's role, the filter key for the org's role-permissions custom module
 *   (Settings › Permissions).
 */
export interface SessionUser {
  peopleId: number | null;
  roleId: number | null;
  /** The CURRENT application id — some setup endpoints (e.g. setup/roles) scope by it. */
  appId: number | null;
}
let sessionUserCache: Promise<SessionUser> | null = null;
export function fetchSessionUser(): Promise<SessionUser> {
  if (!isFacilioApiConfigured) return Promise.resolve({ peopleId: null, roleId: null, appId: null });
  if (!sessionUserCache) {
    sessionUserCache = (async () => {
      const asId = (v: any) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
      // `v2/account` and `v2/fetchAccount` both exist across versions; try both before giving up
      // (the first returning a usable payload wins).
      let user: any = null;
      let account: any = null;
      for (const path of ['v2/account', 'v2/fetchAccount']) {
        const body = await customGet(path).catch(() => null);
        if (!body) continue;
        account = body?.result?.account ?? body?.account ?? body?.data?.account ?? body?.result ?? body?.data ?? body;
        user = account?.user ?? body?.result?.user ?? body?.user ?? null;
        if (user) break;
      }
      const peopleId = asId(user?.peopleId ?? user?.people?.id ?? user?.peopleID);
      const roleId = asId(user?.roleId ?? user?.role?.roleId ?? user?.role?.id);
      const appId = asId(user?.applicationId ?? user?.appId ?? account?.app?.id ?? account?.appId);
      if (!peopleId) {
        // Log the actual SHAPE (keys), not the value — "null" told us nothing last time.
        // eslint-disable-next-line no-console
        console.warn(
          '[facilio-api] account fetch carried no peopleId',
          user ? { userKeys: Object.keys(user) } : account ? { accountKeys: Object.keys(account) } : 'no account payload'
        );
      }
      return { peopleId, roleId, appId };
    })();
    sessionUserCache.catch(() => {
      sessionUserCache = null;
    });
  }
  return sessionUserCache;
}

export async function fetchCurrentPeopleId(): Promise<number | null> {
  return (await fetchSessionUser()).peopleId;
}

/**
 * The CURRENT application id. The account payload's `applicationId` is often 0/absent
 * (confirmed live), so this falls back to `v2/application/fetchDetails` — the endpoint
 * clientV2 itself boots the current application from (same params). Session-cached.
 */
/**
 * The app id out of the embed's own `x-connected-app` token — base64 of
 * `{"i":<appId>,"a":"<org>","w":"<widget>","t":"WEB_TAB"}` (confirmed across live captures).
 * Read from the URL (the connected-app host passes it through) or a global the SDK exposes;
 * null whenever it isn't present, e.g. dev mode.
 */
function readConnectedAppToken(): { i?: number; a?: string; w?: string; t?: string } | null {
  const candidates: (string | null | undefined)[] = [];
  try {
    const q = new URLSearchParams(window.location.search);
    candidates.push(q.get('connectedApp'), q.get('x-connected-app'), q.get('connected_app'));
  } catch {
    /* no URL access — ignore */
  }
  const g = window as any;
  candidates.push(g.__FACILIO_CONNECTED_APP__, g.connectedApp);
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    try {
      const parsed = JSON.parse(atob(raw));
      if (parsed && (parsed.i != null || parsed.a != null)) return parsed;
    } catch {
      /* not a base64 connected-app token — try the next candidate */
    }
  }
  return null;
}

function readConnectedAppId(): number | null {
  const id = Number(readConnectedAppToken()?.i);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * The current app's LINK NAME (`maintenance`, `appgallerytesting`, a tenant/vendor portal, …).
 * Sources, in order: the connected-app token's `a` claim (confirmed shape:
 * `{"i":<appId>,"a":"<appLinkName>","w":"<widget>","t":"WEB_TAB"}`), then the first path segment
 * of the embedding URL — which is how clientV2 itself derives the current app. Null when neither
 * is available (plain local dev).
 */
export function currentAppLinkName(): string | null {
  const fromToken = readConnectedAppToken()?.a;
  if (typeof fromToken === 'string' && fromToken.trim()) return fromToken.trim().toLowerCase();
  try {
    // Embedded: the parent frame's URL carries the app segment; same-origin access can throw.
    const href = window.top && window.top !== window ? window.top.location.pathname : window.location.pathname;
    for (const seg of href.split('/')) {
      const s = seg.trim().toLowerCase();
      // 'legacy'/'api'-style prefixes and the org subdomain segment aren't app link names; the
      // maintenance app is the one we actually need to recognize, so match it explicitly.
      if (s === 'maintenance') return s;
    }
  } catch {
    /* cross-origin parent — fall through */
  }
  return null;
}

/** True when this app is embedded in the MAINTENANCE (admin) app — gates admin-only surfaces. */
export function isMaintenanceApp(): boolean {
  return currentAppLinkName() === 'maintenance';
}

let currentAppIdCache: Promise<number | null> | null = null;
export function fetchCurrentAppId(): Promise<number | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  if (!currentAppIdCache) {
    currentAppIdCache = (async () => {
      const asId = (v: any) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
      const fromAccount = (await fetchSessionUser()).appId;
      if (fromAccount) return fromAccount;
      // The connected-app token itself carries the app id — the `x-connected-app` payload this
      // app is embedded with is base64 `{"i":<appId>,"a":<org>,"w":<widget>,…}` (confirmed in the
      // live captures). Cheapest and most reliable source, no extra request.
      const fromToken = asId(readConnectedAppId());
      if (fromToken) return fromToken;
      const body = await customGet('v2/application/fetchDetails', { considerRole: true, optimised: true }).catch(() => null);
      const data = body?.data ?? body?.result ?? body ?? null;
      const app = data?.application ?? data?.applicationDetails ?? null;
      const id = asId(app?.id ?? app?.applicationId ?? data?.applicationId ?? data?.appId ?? data?.id);
      if (!id) {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] current appId unresolvable', data ? { keys: Object.keys(data) } : 'no fetchDetails payload');
      }
      return id;
    })();
    currentAppIdCache.catch(() => {
      currentAppIdCache = null;
    });
  }
  return currentAppIdCache;
}

// ---------------------------------------------------------------------------
// Role-permissions CUSTOM MODULE (Settings › Permissions): one record per role — a `role`
// lookup plus BOOLEAN fields whose names contain edit/assign/book (field names are org-defined,
// so they're discovered per record rather than hardcoded). The matched record decides which
// mode tabs the user sees; no match -> the Settings defaults apply.
// ---------------------------------------------------------------------------

export interface RolePermRecord {
  id: number;
  /** Display label — the record's own NAME field (roles are listed/edited separately). */
  label: string;
  /** `role` is a MULTI-lookup: one permission record can apply to several roles. */
  roleIds: number[];
  /** The record's boolean permission values, keyed by mode. Missing = field absent on the record. */
  values: Partial<ModePerms>;
  /** The record's ACTUAL field names per mode — updates write back these exact keys. */
  fieldKeys: Partial<Record<keyof ModePerms, string>>;
}

/** An org role, for the permission records' role picker. */
export interface OrgRole {
  id: number;
  name: string;
}

/**
 * The org's role list — `GET v2/setup/roles` (the endpoint clientV2's own role pickers use,
 * response under `roles`). Session-cached; empty on failure so pickers degrade to showing ids.
 */
let orgRolesCache: Promise<OrgRole[]> | null = null;
export function fetchOrgRoles(): Promise<OrgRole[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  if (!orgRolesCache) {
    orgRolesCache = (async () => {
      const extract = (body: any): OrgRole[] =>
        ((body?.data?.roles ?? body?.roles ?? body?.result?.roles ?? []) as any[])
          .map((r) => ({ id: Number(r.roleId ?? r.id), name: (typeof r.name === 'string' && r.name.trim()) || `#${r.roleId ?? r.id}` }))
          .filter((r) => Number.isFinite(r.id) && r.id > 0);

      // The roles endpoint is UNVERSIONED — `setup/roles`, NOT `v2/setup/roles` (that 404s), and
      // it scopes by the CURRENT app, so appId rides as a URL param (same as the native client's
      // role pickers: GET /setup/roles?appId=<current app>).
      const appId = await fetchCurrentAppId().catch(() => null);
      const params = appId ? { appId } : undefined;
      let roles = extract(await customGet('setup/roles', params).catch(() => null));
      if (!roles.length) {
        // Same-origin session fallback for when the SDK/app base resolves the path under a scope
        // the endpoint doesn't live in.
        const qs = appId ? `?appId=${appId}` : '';
        const res = await fetch(`/api/setup/roles${qs}`, { credentials: 'include' }).catch(() => null);
        const alt = res?.ok ? await res.json().catch(() => null) : null;
        roles = extract(alt);
      }
      if (!roles.length) {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] roles list unavailable — role pickers will show ids only');
      }
      return roles;
    })();
    orgRolesCache.catch(() => {
      orgRolesCache = null;
    });
  }
  return orgRolesCache;
}

/** Writes a permission record's role MULTI-lookup — the standard array-of-{id} lookup shape. */
export async function updateRolePermissionRoles(moduleName: string, recordId: number, roleIds: number[]): Promise<boolean> {
  if (!isFacilioApiConfigured) return false;
  const res = await facilioApi.updateRecord(moduleName.trim(), { id: recordId, data: { role: roleIds.map((id) => ({ id })) } });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] ${moduleName} role update failed for record ${recordId}`, res.error);
    return false;
  }
  return true;
}

/** One role reference (object with roleId/id, or a bare id) -> numeric role id. */
function roleIdOf(v: any): number | null {
  const n = Number(v?.roleId ?? v?.id ?? v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The record's role multi-lookup, whatever shape the projection used, -> role id list. */
function normalizeRoleIds(v: any): number[] {
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  return arr.map(roleIdOf).filter((n): n is number => n != null);
}

/** The module's CONFIRMED field names (this org): assignment / booking / edit. */
const PERM_EXACT_KEY: Record<keyof ModePerms, string> = { edit: 'edit', assign: 'assignment', book: 'booking' };
const PERM_KEY_RX: Record<keyof ModePerms, RegExp> = { edit: /edit/i, assign: /assign/i, book: /book/i };
const MODE_PERM_KEYS = ['edit', 'assign', 'book'] as const;
const isBoolish = (v: unknown) => typeof v === 'boolean' || v === 0 || v === 1 || v === 'true' || v === 'false';
const asPermBool = (v: unknown) => v === true || v === 1 || v === 'true';

export async function fetchRolePermissionRecords(moduleName: string): Promise<RolePermRecord[]> {
  if (!isFacilioApiConfigured || !moduleName.trim()) return [];
  const res: any = await facilioApi.fetchAll(moduleName.trim(), { page: 1, perPage: 500 });
  if (res.error || !res.list) throw new Error(res.error?.message || `facilio-api: ${moduleName} fetch failed`);
  return (res.list as any[]).map((r) => {
    const fieldKeys: Partial<Record<keyof ModePerms, string>> = {};
    // Exact field names first (assignment/booking/edit — the org's confirmed schema)…
    for (const p of MODE_PERM_KEYS) {
      if (isBoolish(r[PERM_EXACT_KEY[p]])) fieldKeys[p] = PERM_EXACT_KEY[p];
    }
    // …then fuzzy discovery for any that didn't match (other orgs name fields their own way).
    for (const key of Object.keys(r)) {
      if (!isBoolish(r[key])) continue;
      for (const p of MODE_PERM_KEYS) {
        if (!fieldKeys[p] && PERM_KEY_RX[p].test(key)) fieldKeys[p] = key;
      }
    }
    const values: Partial<ModePerms> = {};
    for (const p of MODE_PERM_KEYS) {
      const k = fieldKeys[p];
      if (k) values[p] = asPermBool(r[k]);
    }
    const roleRaw = r.role ?? r.roles ?? r.roleId;
    return {
      id: r.id,
      // The record's OWN name labels the row; its roles are listed/edited separately in the UI.
      label: (typeof r.name === 'string' && r.name.trim()) || `#${r.id}`,
      roleIds: normalizeRoleIds(roleRaw),
      values,
      fieldKeys,
    };
  });
}

/**
 * The current user's mode permissions from the org module — every record whose role MULTI-lookup
 * includes the session's roleId. Overlapping records merge permissively (a mode granted by ANY
 * matching record is granted). Null when there's no session role or nothing matches with
 * recognizable permission fields — the caller then applies the defaults.
 */
export async function resolveModePermsForCurrentUser(moduleName: string): Promise<Partial<ModePerms> | null> {
  const { roleId } = await fetchSessionUser();
  if (!roleId) return null;
  const records = await fetchRolePermissionRecords(moduleName);
  const hits = records.filter((r) => r.roleIds.includes(roleId) && Object.keys(r.values).length > 0);
  if (!hits.length) return null;
  const merged: Partial<ModePerms> = {};
  for (const p of MODE_PERM_KEYS) {
    const seen = hits.filter((h) => h.values[p] !== undefined);
    if (seen.length) merged[p] = seen.some((h) => h.values[p] === true);
  }
  return merged;
}

/** Writes ONE permission flag back to its module record, using the record's own field name. */
export async function updateRolePermissionRecord(moduleName: string, rec: RolePermRecord, perm: keyof ModePerms, value: boolean): Promise<boolean> {
  if (!isFacilioApiConfigured) return false;
  const field = rec.fieldKeys[perm];
  if (!field) return false;
  const res = await facilioApi.updateRecord(moduleName.trim(), { id: rec.id, data: { [field]: value } });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] ${moduleName}.${field} update failed for record ${rec.id}`, res.error);
    return false;
  }
  return true;
}

/**
 * The current user's assigned desk. Primary path (client-portal style): a direct `desks` list
 * fetch, one row (page 1 / perPage 1), filtered on the desk module's `clientcontact_desks`
 * lookup to the logged-in user's PEOPLE id (see fetchCurrentPeopleId — the lookup holds the
 * people/clientcontact record id, not the login user id), archived records excluded
 * (`isArchived: false`). The lookup filter uses operatorId 36 — the same lookup-"is" operator
 * every other list filter in this file uses. No manual "this is me" setting involved.
 *
 * Fallback (no people id resolvable): the employee portal's home endpoint
 * `GET maintenance/api/v2/servicePortalHome?fetchOnlyDesk=true&count=1[&recordId={employeeId}]`,
 * which resolves the employee from the session. Returns null when neither path finds a desk.
 */
export async function fetchMyDesk(employeeId?: number): Promise<MyDeskInfo | null> {
  if (!isFacilioApiConfigured) return null;

  const peopleId = await fetchCurrentPeopleId().catch(() => null);
  if (peopleId) {
    const res = await facilioApi.fetchAll('desks', {
      page: 1,
      perPage: 1,
      isArchived: false,
      filters: JSON.stringify({ clientcontact_desks: { operatorId: 36, value: [String(peopleId)] } }),
    });
    const desk = res.list?.[0];
    if (!res.error && desk?.id) {
      const floorId = lookupId(desk, 'floor');
      return { recordId: desk.id, name: desk.name ?? 'Your desk', floorId: floorId != null ? String(floorId) : null, booked: false };
    }
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn('[facilio-api] clientcontact_desks filter fetch failed — falling back to servicePortalHome', res.error);
    }
  }

  if (!apiOrigin) return null;
  const body = await customGet(
    'v2/servicePortalHome',
    { fetchOnlyDesk: true, count: 1, ...(employeeId ? { recordId: employeeId } : {}) },
    { devAbsoluteUrl: `${apiOrigin}/maintenance/api/v2/servicePortalHome` }
  );
  const result = body?.result;
  const assigned = result?.desks?.[0];
  const bookedDesk = result?.bookedDesks?.[0];
  const desk = assigned ?? bookedDesk;
  if (!desk?.id) return null;
  const floorId = desk.floorId ?? desk.floor?.id;
  return { recordId: desk.id, name: desk.name ?? 'Your desk', floorId: floorId != null ? String(floorId) : null, booked: !assigned };
}

/**
 * Maps a real desk record back to this app's own unit id, via the floor's workstation-plan
 * markers (`marker.recordId` -> `marker.geoId`, which is the local unit id for markers this app
 * created). Returns null for desks placed outside this app (no geoId convention) — callers fall
 * back to just navigating to the floor.
 */
export async function findUnitIdForDeskRecord(floorId: string, deskRecordId: number): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE.workstation)];
  if (!summary?.id) return null;
  const record = await fetchIndoorFloorPlanRecord(summary.id);
  const marker = record?.markers?.find((m: any) => m.recordId === deskRecordId);
  return marker?.geoId ?? null;
}

/**
 * Assigns a client contact to a placed workstation/locker/parking-stall for real, confirmed
 * against a live org: for desks, creates a `moves` record (`to` + `clientcontact_moves`,
 * `timeOfMove` at-or-before now so the reassignment executes immediately — the backend
 * auto-unassigns whatever desk that client contact previously held, per the org's documented
 * Moves flow); for lockers/parking stalls, a plain `employee` field update (no Moves involvement
 * there — that module's assignee lookup is a separate, confirmed-real `employee` field).
 *
 * The moves payload mirrors the real web app's: `{to, timeOfMove, clientcontact_moves,
 * scheduledTime: null, moveType: 1, siteId}` — `clientcontact_moves` is the `moves` module's real
 * field for the client contact being moved (not `employee`).
 */
export async function assignUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const id = Number(contactId);
  if (!Number.isFinite(id)) return; // mock client-contact ids (e.g. "c1") aren't real backend ids.

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    // Order matters: the DESK updates FIRST (clientcontact_desks — the DESK module's contact
    // lookup, all-lowercase field name; the moves record below keeps its own clientcontact_moves
    // field), THEN the moves record is added for the history/reassignment mechanics. Once the
    // backend's Moves execution updates the desk itself, the direct patch goes away and only the
    // move remains.
    const patch = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { clientcontact_desks: { id } } });
    if (patch.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] desk clientcontact_desks patch failed for unit ${unit.id}`, patch.error);
    }
    const res = await facilioApi.createRecord('moves', {
      data: {
        to: { id: ref.recordId },
        timeOfMove: Date.now(),
        clientcontact_moves: { id },
        scheduledTime: null,
        moveType: 1,
        ...(ref.siteId ? { siteId: ref.siteId } : {}),
      },
    });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] assign move failed for unit ${unit.id}`, res.error);
    }
  } else {
    const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: { id } } });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] assign update failed for unit ${unit.id}`, res.error);
    }
  }
  // Assignment state changed — don't let a pre-write viewerData response serve stale occupancy.
  viewerDataCache.clear();
}

/**
 * Direct assignee-field patch, no Moves record — the companion to the STATEFLOW vacate/assign
 * buttons (executing a transition changes state but not the lookup): desks carry the contact on
 * `clientcontact_desks` (the desk module's contact lookup), lockers/parking on `employee`.
 * `contactId: null` clears it.
 */
export async function patchUnitContact(unit: Unit, contactId: string | null): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;
  const field = unit.type === 'workstation' ? 'clientcontact_desks' : 'employee';
  const value = contactId != null && Number.isFinite(Number(contactId)) ? { id: Number(contactId) } : null;
  const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { [field]: value } });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] ${field} patch failed for unit ${unit.id}`, res.error);
  }
  viewerDataCache.clear();
}

/**
 * Vacates a placed workstation/locker/parking-stall for real — for desks, a `moves` record with
 * only `from` set (confirmed live: clears the desk's assignee via `clientcontact_moves`); for
 * lockers/parking stalls, clears the `employee` field directly.
 */
export async function vacateUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const id = Number(contactId);
  if (!Number.isFinite(id)) return;

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    // Mirror of assign's ordering: the DESK clears FIRST (clientcontact_desks: null), THEN the
    // departure move is recorded. Same future path — the direct patch goes away once the
    // backend's Moves execution owns the desk field.
    const patch = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { clientcontact_desks: null } });
    if (patch.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] desk clientcontact_desks clear failed for unit ${unit.id}`, patch.error);
    }
    const res = await facilioApi.createRecord('moves', {
      data: {
        from: { id: ref.recordId },
        timeOfMove: Date.now(),
        clientcontact_moves: { id },
        scheduledTime: null,
        moveType: 1,
        ...(ref.siteId ? { siteId: ref.siteId } : {}),
      },
    });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] vacate move failed for unit ${unit.id}`, res.error);
    }
  } else {
    const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: null } });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] vacate update failed for unit ${unit.id}`, res.error);
    }
  }
  // Same as assign — invalidate cached viewerData so occupancy reads fresh.
  viewerDataCache.clear();
}

/** moduleName -> its numeric moduleId (spacebooking's `parentModuleId`). Session cache. */
const moduleIdCache = new Map<string, number>();
async function moduleIdFor(moduleName: string, sampleRecordId: number): Promise<number | null> {
  const cached = moduleIdCache.get(moduleName);
  if (cached) return cached;
  const res = await facilioApi.fetchRecord<any>(moduleName, { id: sampleRecordId });
  const id = res?.[moduleName]?.moduleId;
  if (typeof id === 'number') moduleIdCache.set(moduleName, id);
  return typeof id === 'number' ? id : null;
}

/** (dateISO, minutesFromMidnight) -> epoch millis in the browser's local timezone. */
function epochAt(dateISO: string, minutes: number): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}

/**
 * Which spacebooking lookup field carries the booked resource, per real module. Rooms aren't in
 * `REAL_SPACE_MODULE` (see `ensureRealZoneRecord`), so they're handled separately in
 * `createRealBooking` — `'space'`, matching the field name the real org's own zone entries use
 * for the same backing record (`markedZones[].space`); not independently confirmed for
 * spacebooking's create payload specifically.
 */
const SPACEBOOKING_LOOKUP: Record<string, string> = { desks: 'desk', parkingstall: 'parkingStall' };
const ROOM_SPACEBOOKING_LOOKUP = 'space';

export interface RealBookingResult {
  ok: boolean;
  reason?: string;
  id?: number;
}

/**
 * Creates a booking in the real Facilio backend for a placed unit, routed by the org's booking
 * module setting:
 *
 * - `space`  -> `spacebooking` (confirmed live for desks/parking): `{[desk|parkingStall|space]:{id},
 *   parentModuleId, bookingStartTime, bookingEndTime, reservedBy/host/internalAttendees,
 *   noOfAttendees, name}`. The unit must resolve to a real desks/parkingstall record (via
 *   `ensureRealSpaceRecord`) or, for rooms, an existing real zone entry (via
 *   `ensureRealZoneRecord` — read-only, no creation for a brand-new room) — on mock/unmapped
 *   floors this returns `{ok:false}` and the caller keeps only the local booking.
 * - `facility` -> `facilitybooking`. Facility bookings are SLOT-based (a `facility` record with
 *   generated slots), which this app doesn't yet provision, so this is a marked TODO that returns
 *   `{ok:false, reason}` for now rather than posting an invalid record.
 *
 * Best-effort and non-fatal: the caller always saves locally regardless (see the
 * `LOCAL-BOOKING-FALLBACK` markers in FloorplanContext) — this is the forward path that should
 * become the source of truth once every floor is real-backed.
 */
export interface RealBookingInput {
  module: 'space' | 'facility';
  name?: string;
  description?: string;
  host?: string;
  reservedBy?: string;
  noOfAttendees?: number;
  internalAttendees?: string[];
  externalAttendees?: string[];
  /** The org form the booking was filled through (v2/forms) — stored on the record so backend form rules apply. */
  formId?: number;
  /** Values of org-form fields this app doesn't model natively — passed through verbatim. */
  extras?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Org booking forms (v2/forms): the booking modal renders the org's ACTUAL
// configured form for spacebooking / facilitybooking instead of a hardcoded
// field list. Forms are per resource type (e.g. default_deskbooking_web_* for
// desks), so resolution is (module, unit type) -> formId, then a detail fetch
// for the section fields. Ids are org-specific — never hardcode them.
// ---------------------------------------------------------------------------

export interface BookingFormFieldMeta {
  name: string;
  label: string;
  required: boolean;
  /** Facilio displayTypeEnum: TEXTBOX / TEXTAREA / NUMBER / DATETIME / LOOKUP_SIMPLE / MULTI_LOOKUP / … */
  type: string;
  /** Lookup target module (people, desks, space, …) when the field is a lookup. */
  lookupModule?: string;
  sequence: number;
}

export interface BookingFormMeta {
  id: number;
  name: string;
  displayName: string;
  moduleName: 'spacebooking' | 'facilitybooking';
  fields: BookingFormFieldMeta[];
}

/** Form-name preferences per module + unit type (system form names follow these patterns). */
const FORM_NAME_PREFERENCE: Record<'spacebooking' | 'facilitybooking', Partial<Record<UnitType | 'default', RegExp[]>>> = {
  spacebooking: {
    workstation: [/deskbooking/i],
    parking: [/parkingbooking/i],
    default: [/default_spacebooking/i, /spacebooking/i],
  },
  facilitybooking: {
    workstation: [/hot_desk/i],
    parking: [/parkingbooking/i],
    room: [/^space_/i],
    default: [/default_facilitybooking/i],
  },
};

export interface BookingFormSummary {
  id: number;
  name: string;
  displayName: string;
  hideInList?: boolean | null;
}

/** The module's default form for a unit type — what the modal auto-selects before any switching. */
export function pickDefaultBookingForm(forms: BookingFormSummary[], module: 'space' | 'facility', unitType: UnitType): BookingFormSummary | null {
  if (forms.length === 0) return null;
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  const prefs = FORM_NAME_PREFERENCE[moduleName];
  const patterns = [...(prefs[unitType] ?? []), ...(prefs.default ?? [])];
  for (const re of patterns) {
    const hit = forms.find((f) => re.test(f.name ?? ''));
    if (hit) return hit;
  }
  return forms[0];
}

const bookingFormListCache = new Map<string, Promise<BookingFormSummary[]>>();
const bookingFormDetailCache = new Map<string, Promise<BookingFormMeta | null>>();

/**
 * All of the module's forms (`v2/{moduleName}/forms?moduleName=&skipPermission=true` — confirmed
 * live) — the modal's switcher when there's more than one. Cached per module for the session;
 * resolves [] when unconfigured or on API failure so the modal can fall back to its built-in
 * field list.
 */
export function fetchBookingFormList(module: 'space' | 'facility'): Promise<BookingFormSummary[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  let pending = bookingFormListCache.get(moduleName);
  if (!pending) {
    // v2/{moduleName}/forms answers the plain {responseCode, result} envelope — customGet returns the body verbatim.
    pending = customGet(`v2/${moduleName}/forms`, { moduleName, skipPermission: true })
      .then((body: { result?: { forms?: BookingFormSummary[] } }) => (body?.result?.forms ?? []).filter((f) => !f.hideInList))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] booking form list fetch failed', err);
        bookingFormListCache.delete(moduleName); // transient failure — allow a retry on next open
        return [];
      });
    bookingFormListCache.set(moduleName, pending);
  }
  return pending;
}

/** One form's field layout (`v2/forms/getForm`), cached per form for the session. */
export function fetchBookingFormById(module: 'space' | 'facility', formId: number): Promise<BookingFormMeta | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  const key = `${moduleName}:${formId}`;
  let pending = bookingFormDetailCache.get(key);
  if (!pending) {
    pending = loadBookingFormDetail(module, moduleName, formId).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[facilio-api] booking form fetch failed', err);
      bookingFormDetailCache.delete(key); // transient failure — allow a retry on next open
      return null;
    });
    bookingFormDetailCache.set(key, pending);
  }
  return pending;
}

/** Convenience: the default form for a module + unit type, fields included. */
export async function fetchBookingForm(module: 'space' | 'facility', unitType: UnitType): Promise<BookingFormMeta | null> {
  const forms = await fetchBookingFormList(module);
  const chosen = pickDefaultBookingForm(forms, module, unitType);
  return chosen ? fetchBookingFormById(module, chosen.id) : null;
}

async function loadBookingFormDetail(module: 'space' | 'facility', moduleName: 'spacebooking' | 'facilitybooking', formId: number): Promise<BookingFormMeta | null> {
  // `v2/forms/{moduleName}?fetchFormRuleFields=true&forCreate=true&formId=&skipPermission=true`
  // (confirmed live for a different module — desks). Response shape for THIS specific endpoint
  // wasn't confirmed, so both `result.form` and `result` itself (in case the form is the direct
  // payload rather than nested under `.form`) are tried before giving up.
  const detailBody = await customGet(`v2/forms/${moduleName}`, { fetchFormRuleFields: true, forCreate: true, formId, skipPermission: true });
  const form = detailBody?.result?.form ?? (detailBody?.result?.sections ? detailBody.result : null);
  if (!form) {
    // Detail endpoint came back empty — keep the id usable with the list's naming.
    const summary = (await fetchBookingFormList(module)).find((f) => f.id === formId);
    return summary ? { id: summary.id, name: summary.name, displayName: summary.displayName, moduleName, fields: [] } : null;
  }

  interface RawFormField {
    displayName?: string;
    fieldName?: string;
    required?: boolean;
    sequenceNumber?: number;
    displayTypeEnum?: string;
    field?: { name?: string; displayName?: string; displayTypeEnum?: string; lookupModule?: { name?: string } };
  }
  const fields: BookingFormFieldMeta[] = ((form.sections ?? []) as { fields?: RawFormField[] }[])
    .flatMap((s) => s.fields ?? [])
    .map((ff) => ({
      name: ff.field?.name ?? ff.fieldName ?? '',
      label: ff.displayName ?? ff.field?.displayName ?? '',
      required: !!ff.required,
      type: ff.displayTypeEnum ?? ff.field?.displayTypeEnum ?? 'TEXTBOX',
      lookupModule: ff.field?.lookupModule?.name,
      sequence: ff.sequenceNumber ?? 0,
    }))
    .filter((f) => f.name)
    .sort((a, b) => a.sequence - b.sequence);

  return { id: form.id, name: form.name, displayName: form.displayName, moduleName, fields };
}

/** Numeric backend ids only — mock ids like "c1" aren't real client contacts and are dropped. */
function realIds(ids?: string[]): { id: number }[] {
  return (ids ?? []).map(Number).filter(Number.isFinite).map((id) => ({ id }));
}

export async function createRealBooking(unit: Unit, dateISO: string, start: number, end: number, input: RealBookingInput): Promise<RealBookingResult> {
  if (!isFacilioApiConfigured) return { ok: false, reason: 'not configured' };

  if (input.module === 'facility') {
    // TODO(real-facility-booking): facilitybooking needs a `facility` record + a generated slot
    // (facility.slotDuration / slotGeneratedUpto) and books by slot, not arbitrary start/end.
    // Provisioning facilities + resolving the slot for a window is out of scope until the
    // facility layer is wired; skip cleanly so the local booking still stands.
    return { ok: false, reason: 'facility booking requires slot provisioning (not yet wired)' };
  }

  const lookupField = unit.type === 'room' ? ROOM_SPACEBOOKING_LOOKUP : SPACEBOOKING_LOOKUP[REAL_SPACE_MODULE[unit.type] ?? ''];
  if (!lookupField) return { ok: false, reason: `no spacebooking mapping for ${unit.type}` };

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return { ok: false, reason: 'no real backend record for this unit' };

  // Rooms carry their own parentModuleId (the zone's zoneModuleId — see ensureRealZoneRecord);
  // desks/lockers/parking resolve it generically via their fixed module name.
  const parentModuleId = ref.parentModuleId ?? (await moduleIdFor(REAL_SPACE_MODULE[unit.type]!, ref.recordId));
  if (!parentModuleId) return { ok: false, reason: 'could not resolve parentModuleId' };

  const reservedBy = Number(input.reservedBy);
  const host = Number(input.host);
  const internal = realIds(input.internalAttendees);
  // spacebooking requires at least one internal attendee — default to the reserver when the
  // form left it empty (matches how the real form auto-adds the reserver).
  if (Number.isFinite(reservedBy) && !internal.some((a) => a.id === reservedBy)) internal.unshift({ id: reservedBy });

  const res = await facilioApi.createRecord<any>('spacebooking', {
    data: {
      // Unknown org-form fields first, so the mapped fields below always win on collision.
      ...(input.extras ?? {}),
      // Route the create through the org form the user filled — backend form rules apply.
      // actionFormId alongside formId, same value: seen paired this way in a confirmed live
      // create payload for a different module (desks) — not independently confirmed for
      // spacebooking specifically, included since it's a plausible low-risk match.
      ...(input.formId ? { formId: input.formId, actionFormId: input.formId } : {}),
      [lookupField]: { id: ref.recordId },
      parentModuleId,
      bookingStartTime: epochAt(dateISO, start),
      bookingEndTime: epochAt(dateISO, end),
      noOfAttendees: input.noOfAttendees && input.noOfAttendees > 0 ? input.noOfAttendees : Math.max(1, internal.length),
      name: input.name || `${unit.label} booking`,
      ...(input.description ? { description: input.description } : {}),
      externalAttendees: realIds(input.externalAttendees),
      internalAttendees: internal,
      ...(Number.isFinite(reservedBy) ? { reservedBy: { id: reservedBy } } : {}),
      ...(Number.isFinite(host) ? { host: { id: host } } : {}),
    },
  });
  if (res.error) return { ok: false, reason: res.error.message || `code ${res.error.code}` };
  return { ok: true, id: res.spacebooking?.id };
}
