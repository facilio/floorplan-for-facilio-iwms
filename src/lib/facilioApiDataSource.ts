import { apiOrigin, customGet, facilioApi, fetchFilePreview, isFacilioApiConfigured } from './facilioApi';
import { renderCadToDataUrl } from './cadPreview';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, quadToGeometryString, quadToLngLat } from './geoReference';
import type { FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Building, ClientContact, Floor, FloorplanCustomization, MarkerDef, PlanId, PointGeom, PolyGeom, Site, Unit, UnitType } from './types';

/**
 * Sniffs a DWG/DXF/PDF signature off the file's own leading bytes — the fallback when no
 * Content-Type is available to check (connected-app mode's `common.toBase64` exposes no headers
 * at all, unlike dev mode's real HTTP response). DWG's version tag always starts with the ASCII
 * bytes "AC" (e.g. "AC1015"); PDF always starts with "%PDF"; ASCII DXF (this app only ever
 * produces/consumes the ASCII variant) opens with a "0" group code then "SECTION".
 */
async function sniffCadOrPdfType(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  if (head.length >= 2 && head[0] === 0x41 && head[1] === 0x43) return 'image/vnd.dwg';
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'application/pdf';
  const text = new TextDecoder('ascii', { fatal: false }).decode(head);
  if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(text)) return 'image/vnd.dxf';
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
    const res = await facilioApi.fetchAll('site');
    if (res.error) throw new Error(`facilio-api: portfolio fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((s: any) => ({ id: String(s.id), name: s.name, buildings: [] }));
  }

  async getBuildingsForSite(siteId: string): Promise<Building[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('building', { filters: JSON.stringify({ site: { operatorId: 36, value: [siteId] } }) });
    if (res.error) throw new Error(`facilio-api: buildings fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((b: any) => ({ id: String(b.id), name: b.name, floors: [] }));
  }

  async getFloorsForBuilding(buildingId: string): Promise<Floor[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('floor', { filters: JSON.stringify({ building: { operatorId: 36, value: [buildingId] } }) });
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
    const res = await facilioApi.fetchAll('clientcontact');
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

  async getUnits(_floorId: string): Promise<Unit[]> {
    throw new Error('facilio-api: unit placement (floorplanmarker/floorplanmarkedzone geometry) not wired — needs schema verification against a live org');
  }
  async saveUnits(): Promise<void> {
    throw new Error('facilio-api: unit placement not wired');
  }
  // Space creation is wired on the CMMS connector tier (create-space), not this raw module-CRUD
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
async function getFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
  const body = await customGet('v3/floorplan/getFloorplanDetailsByType', { floorId });
  if (body?.code !== 0) throw new Error(body?.message || `code ${body?.code ?? '?'}`);
  return body?.data?.indoorFloorPlans ?? {};
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
  return blobToRenderableDataUrl(preview.blob, preview.contentType);
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
      FLOOR_PLAN_TYPE[u.plan] === targetType &&
      ((u.geom.kind === 'point' && (u.type === 'workstation' || u.type === 'locker' || u.type === 'parking' || u.type === 'amenity')) ||
        (u.geom.kind === 'poly' && u.type === 'room'))
  );
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(targetType)];
  if (!summary?.id) return;

  await syncMarkersForIndoorFloorPlan(summary.id, syncable).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] marker sync failed for plan ${planId}`, err);
  });
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
 * `unit.type` -> the real org's auto-provisioned "Static" markertype name for it — confirmed live
 * for workstation only (`v3/floorplan/viewerData`'s marker features: `markerType: {name: "desk",
 * isAutoCreate: true, recordModuleId: <desks module id>, type: 1 (Static)}`). Locker/parking
 * stall's equivalent auto-markertype names aren't confirmed, so they're left unset — omitting
 * `markerType` only affects how FACILIO'S OWN native UI icons a marker; this app's own rendering
 * doesn't read it.
 */
const AUTO_MARKER_TYPE_NAME: Partial<Record<Unit['type'], string>> = {
  workstation: 'desk',
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
      .catch(() => new Map<string, number>());
  }
  const map = await markerTypeIdByNameCache;
  return map.get(name.toLowerCase()) ?? null;
}

async function syncMarkersForIndoorFloorPlan(indoorFloorPlanId: number, units: Unit[]): Promise<void> {
  const record = await fetchIndoorFloorPlanRecord(indoorFloorPlanId);
  if (!record) return;
  const quad = geometryStringToQuad(record.geometry);
  if (!quad) return;

  const pointUnits = units.filter((u): u is Unit & { geom: PointGeom } => u.geom.kind === 'point');
  const roomUnits = units.filter((u): u is Unit & { geom: PolyGeom } => u.geom.kind === 'poly' && u.type === 'room');

  // ---- markers: desks/lockers/parking stalls/amenities (point geometry) ----
  const existingMarkers: any[] = record.markers ?? [];
  const existingMarkersByGeoId = new Map(existingMarkers.filter((m) => m.geoId).map((m) => [m.geoId, m]));
  const nextMarkers: any[] = [];

  for (const unit of pointUnits) {
    const match = existingMarkersByGeoId.get(unit.id);
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
    const properties = JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null });
    // A brand-new entry's markerType — only resolvable for workstation right now (see
    // AUTO_MARKER_TYPE_NAME); an existing match's own markerType (spread below) is never
    // overridden by this.
    let newMarkerType: { id: number } | undefined;
    if (!match) {
      const autoName = AUTO_MARKER_TYPE_NAME[unit.type];
      const id = autoName ? await markerTypeIdByName(autoName) : null;
      if (id) newMarkerType = { id };
    }
    // Spread the existing entry first so anything it already carries (recordId, markerType,
    // markerModuleId, etc.) survives the round-trip untouched — only geometry/label are ours to
    // change.
    nextMarkers.push({
      ...(match ?? {}),
      ...(newMarkerType ? { markerType: newMarkerType } : {}),
      geoId: unit.id,
      geometry,
      properties,
      type: 'Feature',
      indoorfloorplan: { id: indoorFloorPlanId },
      label: unit.label,
    });

    // Desk-specific fields go on the SEPARATE desks/lockers/parkingstall record, not the marker.
    if (match?.recordId) {
      const moduleName = REAL_SPACE_MODULE[unit.type];
      const fields: Record<string, unknown> = {};
      if (unit.type === 'workstation' && unit.deskType) fields.deskType = unit.deskType;
      if (unit.secondary) fields.secondary = unit.secondary;
      if (moduleName && Object.keys(fields).length > 0) {
        const res = await facilioApi.updateRecord(moduleName, { id: match.recordId, data: fields });
        if (res.error) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] desk field sync failed for unit ${unit.id}`, res.error);
        }
      }
    }
  }
  // Markers this app doesn't own (no geoId — amenities/decorative markers placed by other
  // tools) are preserved untouched; a geoId-tagged marker whose unit is gone gets dropped.
  for (const m of existingMarkers) {
    if (!m.geoId) nextMarkers.push(m);
  }

  // ---- markedZones: rooms (polygon geometry) ----
  const existingZones: any[] = record.markedZones ?? [];
  const existingZonesByGeoId = new Map(existingZones.filter((z) => z.geoId).map((z) => [z.geoId, z]));
  const nextZones: any[] = [];

  for (const unit of roomUnits) {
    const match = existingZonesByGeoId.get(unit.id);
    const ring = [...unit.geom.pts, unit.geom.pts[0]].map(([x, y]) => quadToLngLat(quad, x, y));
    const geometry = JSON.stringify({ type: 'Polygon', coordinates: [ring] });

    if (!match) {
      // Brand-new room — create its backing `space` record inline (module name confirmed live,
      // see ROOM_SPACE_MODULE), same as a brand-new desk's marker gets created inline above.
      const created = await createRealZoneSpaceRecord(unit);
      if (!created) continue;
      nextZones.push({
        geoId: unit.id,
        geometry,
        properties: '{}',
        type: 'Feature',
        indoorfloorplan: { id: indoorFloorPlanId },
        label: unit.label,
        isReservable: unit.isReservable ?? true,
        space: { id: created.recordId, reservable: unit.isReservable ?? true },
        zoneModuleId: created.zoneModuleId,
        recordId: created.recordId,
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
      space: match.space ? { ...match.space, reservable: unit.isReservable ?? match.space.reservable } : match.space,
    });
  }
  // Zones this app doesn't own preserved untouched; one whose unit is gone gets dropped, same as markers.
  for (const z of existingZones) {
    if (!z.geoId) nextZones.push(z);
  }

  // Round-trip the WHOLE fetched record, not just {markers, markedZones} — a live capture of the
  // real web app's own save confirmed the update payload always carries every field back
  // (customizationJSON, customizationBookingJSON, name, geometry, etc.), not just the ones
  // actually changing. A partial patch risks the backend treating this as a full replace and
  // wiping those other fields rather than merging.
  const res = await facilioApi.updateRecord('indoorfloorplan', { id: indoorFloorPlanId, data: { ...record, markers: nextMarkers, markedZones: nextZones } });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] marker sync failed for plan ${indoorFloorPlanId}`, res.error);
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
  let marker = markers.find((m) => m.geoId === unit.id);

  if (!marker) {
    if (unit.geom.kind !== 'point') return null;
    const quad = geometryStringToQuad(record.geometry);
    if (!quad) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] floor plan ${summary.id} has no geo-reference — assignment for unit ${unit.id} not persisted to backend`);
      return null;
    }
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const autoName = AUTO_MARKER_TYPE_NAME[unit.type];
    const markerTypeId = autoName ? await markerTypeIdByName(autoName) : null;
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
    data: { name: unit.label, site: { id: siteId }, building: { id: buildingId }, floor: { id: unit.floor } },
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
 * A placed unit's real backend record status, read-only — unlike `ensureRealSpaceRecord`, this
 * never creates anything: returns null for a unit that's never been assigned/vacated/booked (no
 * real space record exists yet), not just when the fetch fails. NOT verified against a live org:
 * `moduleState` as the real field name is taken from what was reported directly off a live API
 * response, not independently confirmed here.
 */
export async function fetchUnitModuleState(unit: Unit): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return null;

  let recordId = realSpaceRecordCache.get(unit.id)?.recordId;
  if (!recordId) {
    const byType = await getFloorplanDetailsByType(unit.floor).catch(() => ({}) as Record<string, any>);
    const summary = byType[String(FLOOR_PLAN_TYPE[unit.plan])];
    if (!summary?.id) return null;
    const record = await fetchIndoorFloorPlanRecord(summary.id);
    const marker = record?.markers?.find((m: any) => m.geoId === unit.id);
    if (!marker?.recordId) return null;
    recordId = marker.recordId;
  }
  if (!recordId) return null;

  const res = await facilioApi.fetchRecord<any>(moduleName, { id: recordId });
  if (res.error || !res[moduleName]) return null;
  return res[moduleName].moduleState ?? null;
}

export interface ModuleSummary {
  id: number;
  name: string;
  displayName: string;
}

let modulesListCache: Promise<ModuleSummary[]> | null = null;

/**
 * All modules in the org (`v3/modules/list/all?skipPermission=true` — confirmed live) — the
 * "Select Module" dropdown when creating a custom marker type (recordModuleId). Response shape
 * not independently confirmed, so several reasonable list locations are tried. Cached for the
 * session (module list doesn't change during a session).
 */
export function getAllModules(): Promise<ModuleSummary[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  if (!modulesListCache) {
    modulesListCache = customGet('v3/modules/list/all', { skipPermission: true })
      .then((body: any) => {
        const list = body?.data ?? body?.result?.modules ?? body?.result ?? body?.modules ?? [];
        return (Array.isArray(list) ? list : [])
          .map((m: any) => ({ id: Number(m.id ?? m.moduleId), name: m.name ?? m.moduleName ?? '', displayName: m.displayName ?? m.name ?? m.moduleName ?? '' }))
          .filter((m: ModuleSummary) => Number.isFinite(m.id) && m.name);
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
 * The logged-in user's assigned (or booked) desk, via the employee portal's own home endpoint:
 * `GET maintenance/api/v2/servicePortalHome?fetchOnlyDesk=true&count=1[&recordId={employeeId}]`
 * (captured from a live portal session). Without `recordId` the backend resolves the employee
 * from the session user. Returns null when the user has no desk or the endpoint isn't
 * accessible for the current token.
 */
export async function fetchMyDesk(employeeId?: number): Promise<MyDeskInfo | null> {
  if (!isFacilioApiConfigured || !apiOrigin) return null;
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
 * against a live org: for desks, creates a `moves` record (`to` + `employee`, `timeOfMove`
 * at-or-before now so the reassignment executes immediately — the backend auto-unassigns
 * whatever desk that employee previously held, per the org's documented Moves flow); for
 * lockers/parking stalls, a plain `employee` field update (no Moves involvement there).
 *
 * The moves payload mirrors the real web app's, captured from a live session:
 * `{to, timeOfMove, employee, scheduledTime: null, moveType: 1, siteId}`.
 *
 * NOTE: `to`/lockers/parkingstall's assignee lookup is still the real `employee` field — this app
 * now assigns CLIENT CONTACTS to these records, and whether that lookup accepts a client-contact
 * id (vs. requiring an actual employee record) is an open backend question (see plan follow-ups),
 * not something this app controls. Left as `employee` here since that's the real field name.
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
    const res = await facilioApi.createRecord('moves', {
      data: {
        to: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id },
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
}

/**
 * Vacates a placed workstation/locker/parking-stall for real — for desks, a `moves` record with
 * only `from` set (confirmed live: clears the desk's `employee` field); for lockers/parking
 * stalls, clears the `employee` field directly.
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
    const res = await facilioApi.createRecord('moves', {
      data: {
        from: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id },
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
