import { apiOrigin, facilioApi, isFacilioApiConfigured } from './facilioApi';
import { getInstance } from '@facilio/api';
import { renderCadToDataUrl } from './cadPreview';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, quadToGeometryString, quadToLngLat } from './geoReference';
import type { FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Employee, PlanId, PointGeom, Site, Unit, UnitType } from './types';

/**
 * `fetchOriginal=true` on `v2/files/preview` returns the ORIGINAL uploaded bytes — for a plain
 * raster image that's directly usable as an `<img>` source, but a floor's plan is often a DWG/
 * DXF/PDF source file (confirmed against a live org: `Content-Type: image/vnd.dwg`), which a
 * browser can't decode natively. Detect that from the response's real content-type (not the
 * `.dwg` extension, which isn't available here — this isn't a locally-picked `File`) and run it
 * through the same client-side CAD/PDF renderers the upload flow uses, so a floor plan that was
 * uploaded as a DWG still shows a rendered image, not a broken `<img>` icon.
 */
async function blobToRenderableDataUrl(blob: Blob, contentType: string | undefined): Promise<string> {
  const type = (contentType || blob.type || '').toLowerCase();
  if (type.includes('dwg') || type.includes('dxf')) {
    const file = new File([blob], `floorplan.${type.includes('dxf') ? 'dxf' : 'dwg'}`, { type });
    return renderCadToDataUrl(file);
  }
  if (type.includes('pdf')) {
    const file = new File([blob], 'floorplan.pdf', { type });
    return renderPdfToDataUrl(file);
  }
  return URL.createObjectURL(blob);
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
 * Real Facilio backend tier via @facilio/api (generic V3 module CRUD: `v3/modules/{moduleName}`).
 *
 * Scope, deliberately: portfolio (site/building/floor) and the employee directory map cleanly
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

  async getPortfolio(): Promise<Site[]> {
    this.assertConfigured();
    const [sitesRes, buildingsRes, floorsRes] = await Promise.all([
      facilioApi.fetchAll('site'),
      facilioApi.fetchAll('building'),
      facilioApi.fetchAll('floor'),
    ]);
    const err = sitesRes.error || buildingsRes.error || floorsRes.error;
    if (err) {
      throw new Error(`facilio-api: portfolio fetch failed (${err.code ?? '?'} ${err.message ?? ''})`.trim());
    }
    const sites = sitesRes.list ?? [];
    const buildings = buildingsRes.list ?? [];
    const floors = floorsRes.list ?? [];

    // Deliberately NOT calling getFloorplanDetailsByType here for every floor — that's an
    // N-request fan-out across the whole portfolio for data only the *currently selected*
    // floor needs. See `getFloorPlanSummary` below, called lazily on floor selection instead.
    return sites.map((s: any) => ({
      id: String(s.id),
      name: s.name,
      buildings: buildings
        .filter((b: any) => String(lookupId(b, 'site')) === String(s.id))
        .map((b: any) => ({
          id: String(b.id),
          name: b.name,
          floors: floors
            .filter((f: any) => String(lookupId(f, 'building')) === String(b.id))
            .map((f: any) => ({
              id: String(f.id),
              name: f.name,
              // Unknown until getFloorPlanSummary runs for this floor; true is the safer
              // default so the canvas isn't hidden behind "No floorplan yet" pre-emptively.
              hasPlan: true,
            })),
        })),
    }));
  }

  async getEmployees(): Promise<Employee[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('employee');
    if (res.error) throw new Error(`facilio-api: employee fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((e: any) => ({
      id: String(e.id),
      name: e.name,
      dept: e.department?.name ?? e.departmentName ?? '',
    }));
  }

  async getAssets(): Promise<Asset[]> {
    // Sourced from the CMMS connector (list-assets); not fetched over @facilio/api. Throw so the
    // composite falls through to the connector tier.
    throw new Error('facilio-api: assets come from the CMMS connector, not @facilio/api');
  }

  async getUnits(_floorId: string): Promise<Unit[]> {
    throw new Error('facilio-api: unit placement (floorplanmarker/floorplanmarkedzone geometry) not wired — needs schema verification against a live org');
  }
  async saveUnits(): Promise<void> {
    throw new Error('facilio-api: unit placement not wired');
  }
  // Space creation is wired on the CMMS connector tier (create-space), not the raw @facilio/api
  // layer — throw so the composite falls through to it.
  async createUnit(): Promise<Unit> {
    throw new Error('facilio-api: space creation goes through the CMMS connector — not wired here');
  }
  async getAssignments(): Promise<Assignments> {
    throw new Error('facilio-api: assignments (Moves-derived) not wired');
  }
  async assignUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async vacateUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async getBookings(): Promise<Booking[]> {
    throw new Error('facilio-api: spacebooking not wired');
  }
  async createBooking(): Promise<Booking> {
    throw new Error('facilio-api: spacebooking not wired');
  }
  async cancelBooking(): Promise<void> {
    throw new Error('facilio-api: spacebooking not wired');
  }
}

/** Best-effort lookup-field id extraction: tries `{key}.id`, `{key}Id`, then the raw field. */
function lookupId(record: any, key: string): unknown {
  return record?.[key]?.id ?? record?.[`${key}Id`] ?? record?.[key];
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
async function getFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
  const res = await facilioApi.get('v3/floorplan/getFloorplanDetailsByType', { floorId });
  if (res.error) throw new Error(res.error.message || `code ${res.error.code}`);
  return (res.data as any)?.indoorFloorPlans ?? {};
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
 * The uploaded image for a floor+plan-type, fetched via `POST .../v3/floorplan/viewerData`
 * (confirmed against a live org — returns `{indoorfloorplan: {fileId, ...}, marker, spaceZone,
 * floorplanlayers, floorplanMappedmodules}`; only `fileId` is used here).
 *
 * Called via the raw axios instance (not `@facilio/api`'s `API.post`) because the full path
 * (`maintenance/api/v3/floorplan/viewerData`, confirmed against the live org) doesn't start
 * with `v3/`, so `@facilio/api`'s response-envelope unwrapping wouldn't recognize it as a v3
 * call and would misparse the `{code,data}` body. It's also requested as an ABSOLUTE URL off
 * `apiOrigin` rather than a path relative to the configured axios baseURL — that baseURL
 * already carries a `/api` suffix (for the generic `v3/modules/...` calls), and this route
 * lives directly off the bare origin, not nested under `/api` — a relative path here doubles
 * into `/api/maintenance/api/...` and 404s.
 *
 * `marker`/`spaceZone` in the same response are the real per-unit geometry this app's
 * `getUnits` still declines to render (see the class doc comment) — worth revisiting now that
 * a live shape is confirmed, but out of scope for this change (which only needed the file).
 */
export async function fetchFloorplanImage(floorId: string, planId: PlanId): Promise<string | null> {
  if (!isFacilioApiConfigured || !apiOrigin) return null;
  const byType = await getFloorplanDetailsByType(floorId);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) return null;

  const axiosInstance = getInstance();
  const viewerRes = await axiosInstance.post(
    `${apiOrigin}/maintenance/api/v3/floorplan/viewerData`,
    { floorplanId: summary.id, viewMode: 'ASSIGNMENT' }
  );
  const fileId = viewerRes.data?.data?.indoorfloorplan?.fileId;
  if (!fileId) return null;

  const previewRes = await axiosInstance.get(`v2/files/preview/${fileId}`, {
    params: { fetchOriginal: true },
    responseType: 'blob',
  });
  return blobToRenderableDataUrl(previewRes.data, previewRes.headers?.['content-type']);
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
  if (!isFacilioApiConfigured) return null;
  try {
    const res = await getInstance().get(`v2/files/preview/${fileId}`, { responseType: 'blob' });
    const blob = res.data as Blob;
    const type = (res.headers?.['content-type'] || blob.type || '').toLowerCase();
    if (type.startsWith('image/')) return URL.createObjectURL(blob);
    return null;
  } catch {
    return null;
  }
}

/**
 * Uploads a floorplan source file (image/PDF/DXF/whatever) to Facilio's real file storage
 * (`POST v3/modules/data/files`, multipart, returns `{attachments: {filename: fileId}}`),
 * then attaches that `fileId` to the floor's `indoorfloorplan` record for this `planId`
 * (creating one if it doesn't exist yet). Also fetches the uploaded bytes back via
 * `GET v2/files/preview/{fileId}?fetchOriginal=true` and returns an object URL — that endpoint
 * returns raw bytes rather than @facilio/api's `{code,data}` JSON envelope, so it's fetched via
 * the raw axios instance (`getInstance()`) rather than `API.get`, which would misparse it.
 *
 * `indoorfloorplan` requires `floor`/`building`/`site` as `{id}` lookups (not raw ids) plus a
 * `floorPlanType` int (confirmed against a live org: 1=workstation, 2=locker, 3=parking — no
 * generic/custom type). `building`/`site` aren't tracked per-floor in this app's own state, so
 * they're read off the `floor` record itself, which carries both as `{id}` lookups already.
 *
 * The attach step is best-effort and non-fatal: `@facilio/api` returns `{error}` rather than
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

  const axiosInstance = getInstance();
  const previewRes = await axiosInstance.get(`v2/files/preview/${fileId}`, {
    params: { fetchOriginal: true },
    responseType: 'blob',
  });
  const previewUrl = URL.createObjectURL(previewRes.data);
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
    const existingByType = await getFloorplanDetailsByType(floorId);
    const existing = existingByType[String(floorPlanType)];
    const attachRes = existing
      ? await facilioApi.updateRecord('indoorfloorplan', { id: existing.id, data: { fileId, ...(geometry ? { geometry } : {}) } })
      : await facilioApi.createRecord('indoorfloorplan', {
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
    if (attachRes.error) throw new Error(attachRes.error.message || `code ${attachRes.error.code}`);
    attachedToFloorPlan = true;
  } catch (err) {
    attachError = (err as Error).message || 'attach failed';
  }

  return { fileId, previewUrl, serverImageUrl, attachedToFloorPlan, attachError };
}

/**
 * Syncs this app's placed desks/lockers/parking-stalls (point units only — room/zone polygons
 * need a real `space` module record via `floorplanmarkedzone.space`, which this app doesn't
 * create, so those stay local-only) to real `floorplanmarker` records, confirmed against a live
 * org: required fields are `geoId, geometry, indoorfloorplan, properties, type` (`geoId` doubles
 * as our idempotency key — this app's own stable unit id — so re-saving updates in place instead
 * of duplicating).
 *
 * Skipped per plan-type when `indoorfloorplan.geometry` isn't set yet (no synthetic
 * geo-reference — see `geoReference.ts` — has been computed, e.g. a floor plan uploaded before
 * this existed): there's no sane lng/lat to convert a unit's 0-1 fraction position into, and
 * guessing would silently misplace it rather than fail loudly.
 */
export async function saveFloorplanMarkers(floorId: string, units: Unit[]): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const pointUnits = units.filter(
    (u): u is Unit & { geom: PointGeom } => u.geom.kind === 'point' && (u.type === 'workstation' || u.type === 'locker' || u.type === 'parking')
  );
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);

  const byPlan = new Map<PlanId, (Unit & { geom: PointGeom })[]>();
  for (const u of pointUnits) {
    const list = byPlan.get(u.plan) ?? [];
    list.push(u);
    byPlan.set(u.plan, list);
  }
  const configuredPlanIds = Object.keys(byType)
    .map((t) => PLAN_ID_BY_TYPE[Number(t)])
    .filter((p): p is PlanId => !!p);
  const allPlanIds = new Set<PlanId>([...byPlan.keys(), ...configuredPlanIds]);

  for (const planId of allPlanIds) {
    const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
    if (!summary?.id) continue;
    await syncMarkersForIndoorFloorPlan(summary.id, byPlan.get(planId) ?? []).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] marker sync failed for plan ${planId}`, err);
    });
  }
}

async function syncMarkersForIndoorFloorPlan(indoorFloorPlanId: number, units: (Unit & { geom: PointGeom })[]): Promise<void> {
  // See the matching comment in uploadFloorplanFile — `fetchRecord` nests the record under
  // `res[moduleName]` (`res.indoorfloorplan` here), not `res.data`.
  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: indoorFloorPlanId });
  if (recordRes.error || !recordRes.indoorfloorplan) return;
  const quad = geometryStringToQuad(recordRes.indoorfloorplan.geometry);
  if (!quad) return;

  const existingRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: indoorFloorPlanId,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (existingRes.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetching existing markers failed for plan ${indoorFloorPlanId}`, existingRes.error);
    return; // bail rather than risk creating duplicates against a list we couldn't actually verify.
  }
  const existing = existingRes.list ?? [];
  const existingByGeoId = new Map(existing.map((m) => [m.geoId, m]));
  const seenGeoIds = new Set<string>();

  for (const unit of units) {
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const geometry = JSON.stringify({ type: 'Point', coordinates: [lng, lat] });
    const properties = JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null });
    seenGeoIds.add(unit.id);
    const match = existingByGeoId.get(unit.id);
    if (match) {
      if (match.geometry !== geometry || match.label !== unit.label) {
        // `@facilio/api` resolves (doesn't reject) on a failed request — the failure shows up
        // as `res.error`, not a rejected promise, so a bare `.catch()` here would never catch
        // a real validation error; check `.error` explicitly and log it instead.
        const res = await facilioApi.updateRecord('floorplanmarker', { id: match.id, data: { geometry, properties, label: unit.label, type: 'Point' } });
        if (res.error) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] marker update failed for unit ${unit.id}`, res.error);
        }
      }
    } else {
      const res = await facilioApi.createRecord('floorplanmarker', {
        data: { geoId: unit.id, geometry, properties, type: 'Point', label: unit.label, indoorfloorplan: { id: indoorFloorPlanId } },
      });
      if (res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] marker create failed for unit ${unit.id}`, res.error);
      }
    }
  }
  for (const m of existing) {
    if (m.geoId && !seenGeoIds.has(m.geoId)) {
      const res = await facilioApi.deleteRecord('floorplanmarker', m.id);
      if (res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] marker delete failed for id ${m.id}`, res.error);
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

interface RealSpaceRef {
  recordId: number;
  /** The floor's site id — sent on `moves` records to match the real web app's payload shape. */
  siteId?: number;
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

  const markersRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: summary.id,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (markersRes.error) return null;
  let marker = (markersRes.list ?? []).find((m) => m.geoId === unit.id);

  if (!marker) {
    if (unit.geom.kind !== 'point') return null;
    const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: summary.id });
    const quad = geometryStringToQuad(recordRes.indoorfloorplan?.geometry);
    if (!quad) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] floor plan ${summary.id} has no geo-reference — assignment for unit ${unit.id} not persisted to backend`);
      return null;
    }
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const createMarkerRes = await facilioApi.createRecord<any>('floorplanmarker', {
      data: {
        geoId: unit.id,
        geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }),
        properties: JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null }),
        type: 'Point',
        label: unit.label,
        indoorfloorplan: { id: summary.id },
      },
    });
    if (createMarkerRes.error || !createMarkerRes.floorplanmarker?.id) return null;
    marker = createMarkerRes.floorplanmarker;
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
    data: { name: unit.label, site: { id: siteId }, building: { id: buildingId }, floor: { id: unit.floor } },
  });
  if (createRes.error || !createRes[moduleName]?.id) return null;
  const recordId = createRes[moduleName].id;
  await facilioApi.updateRecord('floorplanmarker', { id: marker.id, data: { recordId } }).catch(() => {});
  const ref = { recordId, siteId };
  realSpaceRecordCache.set(unit.id, ref);
  return ref;
}

export interface MyDeskInfo {
  recordId: number;
  name: string;
  floorId: string | null;
  /** True when this came from `bookedDesks` (a hot-desk booking) rather than a permanent assignment. */
  booked: boolean;
}

/**
 * The logged-in user's assigned (or booked) desk, via the employee portal's own home endpoint:
 * `GET maintenance/api/v2/servicePortalHome?fetchOnlyDesk=true&count=1[&recordId={employeeId}]`
 * (captured from a live portal session). Without `recordId` the backend resolves the employee
 * from the session user. Returns null when the user has no desk or the endpoint isn't
 * accessible for the current token.
 */
export async function fetchMyDesk(employeeId?: number): Promise<MyDeskInfo | null> {
  if (!isFacilioApiConfigured || !apiOrigin) return null;
  const axiosInstance = getInstance();
  const res = await axiosInstance.get(`${apiOrigin}/maintenance/api/v2/servicePortalHome`, {
    params: { fetchOnlyDesk: true, count: 1, ...(employeeId ? { recordId: employeeId } : {}) },
  });
  const result = res.data?.result;
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
  const markersRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: summary.id,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (markersRes.error) return null;
  const marker = (markersRes.list ?? []).find((m) => m.recordId === deskRecordId);
  return marker?.geoId ?? null;
}

/**
 * Assigns an employee to a placed workstation/locker/parking-stall for real, confirmed against
 * a live org: for desks, creates a `moves` record (`to` + `employee`, `timeOfMove` at-or-before
 * now so the reassignment executes immediately — the backend auto-unassigns whatever desk that
 * employee previously held, per the org's documented Moves flow); for lockers/parking stalls, a
 * plain `employee` field update (no Moves involvement there).
 *
 * The moves payload mirrors the real web app's, captured from a live session:
 * `{to, timeOfMove, employee, scheduledTime: null, moveType: 1, siteId}`.
 */
export async function assignUnitReal(unit: Unit, employeeId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const empId = Number(employeeId);
  if (!Number.isFinite(empId)) return; // mock employee ids (e.g. "e1") aren't real backend ids.

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    const res = await facilioApi.createRecord('moves', {
      data: {
        to: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id: empId },
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
    const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: { id: empId } } });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] assign update failed for unit ${unit.id}`, res.error);
    }
  }
}

/**
 * Vacates a placed workstation/locker/parking-stall for real — for desks, a `moves` record with
 * only `from` set (confirmed live: clears the desk's `employee` field); for lockers/parking
 * stalls, clears the `employee` field directly.
 */
export async function vacateUnitReal(unit: Unit, employeeId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const empId = Number(employeeId);
  if (!Number.isFinite(empId)) return;

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    const res = await facilioApi.createRecord('moves', {
      data: {
        from: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id: empId },
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

/** Which spacebooking lookup field carries the booked resource, per real module. */
const SPACEBOOKING_LOOKUP: Record<string, string> = { desks: 'desk', parkingstall: 'parkingStall' };

export interface RealBookingResult {
  ok: boolean;
  reason?: string;
  id?: number;
}

/**
 * Creates a booking in the real Facilio backend for a placed unit, routed by the org's booking
 * module setting:
 *
 * - `space`  -> `spacebooking` (confirmed live): `{[desk|parkingStall]:{id}, parentModuleId,
 *   bookingStartTime, bookingEndTime, reservedBy/host/internalAttendees, noOfAttendees, name}`.
 *   The unit must resolve to a real desks/parkingstall record (via `ensureRealSpaceRecord`, i.e.
 *   a real geo-referenced floor with a synced marker) — on mock/unmapped floors this returns
 *   `{ok:false}` and the caller keeps only the local booking.
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
 * All of the module's forms (`v2/forms?moduleName=`) — the modal's switcher when there's more
 * than one. Cached per module for the session; resolves [] when unconfigured or on API failure
 * so the modal can fall back to its built-in field list.
 */
export function fetchBookingFormList(module: 'space' | 'facility'): Promise<BookingFormSummary[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  let pending = bookingFormListCache.get(moduleName);
  if (!pending) {
    // Raw axios (not API.get): v2/forms answers the plain {responseCode, result} envelope.
    pending = getInstance()
      .get('v2/forms', { params: { moduleName } })
      .then((res: { data?: { result?: { forms?: BookingFormSummary[] } } }) => (res.data?.result?.forms ?? []).filter((f) => !f.hideInList))
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
  const detailRes = await getInstance().get('v2/forms/getForm', { params: { formId, moduleName } });
  const form = detailRes.data?.result?.form;
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

/** Numeric backend ids only — mock ids like "e1" aren't real employees and are dropped. */
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

  const lookupField = SPACEBOOKING_LOOKUP[REAL_SPACE_MODULE[unit.type] ?? ''];
  if (!lookupField) return { ok: false, reason: `no spacebooking mapping for ${unit.type}` };

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return { ok: false, reason: 'no real backend record for this unit' };

  const moduleName = REAL_SPACE_MODULE[unit.type]!;
  const parentModuleId = await moduleIdFor(moduleName, ref.recordId);
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
      ...(input.formId ? { formId: input.formId } : {}),
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
