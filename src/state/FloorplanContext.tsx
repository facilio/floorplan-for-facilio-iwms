import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Dispatch, MutableRefObject, ReactNode } from 'react';
import { dataSource, clearLocalData, setAllowLocalFallback as dataSourceSetAllowLocalFallback } from '../lib/dataSource';
import type { CreateSpaceLoc } from '../lib/dataSource';
import { CONTACTS as MOCK_CONTACTS, seedBookings, seedUnits, seedAssignments } from '../lib/mockData';
import { floorImageKey, resolveMarkerDef, TYPE_META } from '../lib/types';
import type { AmenityIcon, Assignments, Booking, ClientContact, MarkerDef, PlanId, Role, Site, Unit, UnitType } from '../lib/types';
import type { CadGroup } from '../lib/cadAnalyze';
import type { Asset } from '../lib/assets';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { assignUnitReal, createRealBooking, fetchFloorplanCustomization, fetchFloorplanImage, fetchMyDesk, findUnitIdForDeskRecord, getAnyFloor, getFloorPlanSummary, saveFloorplanMarkers, vacateUnitReal } from '../lib/facilioApiDataSource';
import { listFloorplanFloorIds, loadFloorplanFile, persistFloorplanFile } from '../lib/floorplanFileStore';
import { loadSettings, saveSettings, settingsFromState } from '../lib/settingsStore';
import { pathForView, viewFromLocation } from '../lib/routes';
import { buildInitialState, reducer } from './reducer';
import type { Action } from './reducer';
import type { AppState } from './types';
import { conflictsFor, isAssignable, nextLabel, unitById } from './selectors';
import { calibratedPxPerMeter, clampPanelPos, defaultPanelPos, distNormToPx, fitView as fitViewFn, focusUnitView, pointInPoly, zoomAt as zoomAtFn } from '../lib/geometry';

interface Ctx {
  state: AppState;
  actions: ReturnType<typeof buildActions>;
}

const FloorplanCtx = createContext<Ctx | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Module-level so it's reachable from the boot effect too, not just actions built in buildActions. */
function showToastVia(dispatch: Dispatch<Action>, message: string) {
  dispatch({ type: 'SHOW_TOAST', message });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dispatch({ type: 'SHOW_TOAST', message: null }), 3200);
}

/**
 * Overlay chrome the auto-fit must clear so plan content never hides under
 * the floating panels — same widths MapStage uses for its layout padding
 * (portfolio 320 / details 336 when open, 76 for their collapsed rails),
 * plus headroom for the mode switcher (top) and the bottom nav.
 */
function viewInsets(state: AppState) {
  return {
    left: state.panels.portfolio.open ? 336 : 76,
    right: state.panels.details.open ? 352 : 76,
    top: 64,
    bottom: 84,
  };
}

/**
 * Explicit-save chokepoint ONLY — local per-action edits (place/update/delete/close-draft) call
 * `dataSource.saveUnits` directly and stop there; this additionally pushes real
 * `floorplanmarker`/`indoorfloorplan` sync, and is deliberately reserved for "Save changes" /
 * mode-switch confirm / discard / reset, not every micro-edit. Syncing markers on every drag or
 * click was real, measured overhead (re-fetching indoorfloorplan geometry + the full marker list
 * per configured plan type, on every single edit) with no benefit — the real backend only needs
 * to reflect the floor once the user is done editing, same mental model as the "unsaved changes"
 * bar itself. Best-effort: never blocks or throws into the local save it runs alongside.
 */
async function persistUnits(floorId: string, units: Unit[]): Promise<void> {
  const local = dataSource.saveUnits(floorId, units);
  if (isFacilioApiConfigured) {
    saveFloorplanMarkers(floorId, units).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[facilio-api] marker sync failed', err);
    });
  }
  await local;
}

/** Walk the portfolio tree to find which site/building a floor belongs to — create-space needs the
 *  site id (and building, when known). Returns nulls for the parents on a demo/slug floor that isn't
 *  in the org tree; the connector tier then rejects the create and the local tier owns the record. */
function resolveSpaceLoc(portfolio: Site[], floorId: string): CreateSpaceLoc {
  for (const site of portfolio) {
    for (const building of site.buildings) {
      if (building.floors.some((f) => f.id === floorId)) {
        return { siteId: site.id, buildingId: building.id, floorId };
      }
    }
  }
  return { siteId: null, buildingId: null, floorId };
}

/**
 * Fetched lazily for ONE floor at a time (on selection/mount), not eagerly for the whole
 * portfolio. Finds which plan types are actually configured, defaults `planId` to one of them
 * if the current selection isn't among them, then loads that plan's real image.
 */
/** Blob/object URLs aren't portable to the Vibe DB — turn any image URL into a storable data URL. */
async function toStorableDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url;
  try {
    const blob = await fetch(url).then((r) => r.blob());
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Floor-plan image load, with the Vibe DB as a read-through cache of the floorplan image (per the
 * product ask): (1) serve the cached copy immediately if we have one, (2) refresh from the
 * connector/@facilio when available, and (3) write that fetch back to the cache so the next load
 * is instant and works offline. The cache write is deployed-only (persistFloorplanFile no-ops in
 * dev), and only real (@facilio/connector) fetches populate it — so it stays equal to the source.
 */
async function loadFloorPlanTypesAndImage(dispatch: Dispatch<Action>, floorId: string, currentPlanId: PlanId) {
  dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: true });
  try {
    let resolvedPlanId = currentPlanId;
    if (isFacilioApiConfigured) {
      const types = await getFloorPlanSummary(floorId).catch(() => []);
      dispatch({ type: 'SET_FLOOR_PLAN_TYPES', floorId, types });
      if (types.length) {
        resolvedPlanId = types.some((t) => t.id === currentPlanId) ? currentPlanId : types[0].id;
        if (resolvedPlanId !== currentPlanId) dispatch({ type: 'SET_PLAN', planId: resolvedPlanId });
      }
    }

    // 1) Vibe-DB cache first — instant display of the stored image if present.
    const cached = await loadFloorplanFile(floorId, resolvedPlanId).catch(() => null);
    if (cached?.dataUrl) dispatch({ type: 'SET_FLOOR_IMAGE', floorId, planId: resolvedPlanId, dataUrl: cached.dataUrl });

    // 2) Refresh from the source (connector/@facilio), and 3) cache the fetch back to the Vibe DB.
    if (isFacilioApiConfigured) {
      const imageUrl = await fetchFloorplanImage(floorId, resolvedPlanId).catch(() => null);
      if (imageUrl) {
        dispatch({ type: 'SET_FLOOR_IMAGE', floorId, planId: resolvedPlanId, dataUrl: imageUrl });
        const storable = await toStorableDataUrl(imageUrl);
        if (storable && storable !== cached?.dataUrl) {
          void persistFloorplanFile(floorId, resolvedPlanId, { dataUrl: storable }).catch(() => {});
        }
      }
      const customization = await fetchFloorplanCustomization(floorId, resolvedPlanId).catch(() => null);
      if (customization) dispatch({ type: 'SET_FLOOR_CUSTOMIZATION', floorId, planId: resolvedPlanId, customization });
    }
  } finally {
    dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: false });
  }
}

/**
 * Fetches the image for a floor+plan-type that's already known to be configured but not yet
 * cached in `state.floorImages` — the case hit when the user flips the plan-type switcher to a
 * type other than whichever one `loadFloorPlanTypesAndImage` auto-resolved on floor load.
 */
async function ensureFloorplanImage(dispatch: Dispatch<Action>, floorId: string, planId: PlanId) {
  dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: true });
  try {
    let imageUrl = isFacilioApiConfigured ? await fetchFloorplanImage(floorId, planId).catch(() => null) : null;
    if (!imageUrl) {
      // Deployed / no real backend for this plan: fall back to the Vibe DB copy (no-op in dev).
      const stored = await loadFloorplanFile(floorId, planId).catch(() => null);
      imageUrl = stored?.dataUrl ?? null;
    }
    if (imageUrl) dispatch({ type: 'SET_FLOOR_IMAGE', floorId, planId, dataUrl: imageUrl });
    if (isFacilioApiConfigured) {
      const customization = await fetchFloorplanCustomization(floorId, planId).catch(() => null);
      if (customization) dispatch({ type: 'SET_FLOOR_CUSTOMIZATION', floorId, planId, customization });
    }
  } finally {
    dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: false });
  }
}

/** The room polygon (if any) containing an image-fraction point — placed units inherit its label. */
function roomLabelAt(state: AppState, x: number, y: number): string | null {
  const room = state.units.find((u) => u.type === 'room' && u.geom.kind === 'poly' && pointInPoly({ x, y }, u.geom.pts));
  return room ? room.label : null;
}

function buildActions(state: AppState, dispatch: Dispatch<Action>, canvasRectRef: MutableRefObject<DOMRect | null>) {
  const showToast = (message: string) => showToastVia(dispatch, message);

  /**
   * Fire-and-forget per-action persistence — every edit action calls this and moves on. Never
   * lets a failure become an uncaught rejection: e.g. local fallback disabled (Settings › Local
   * data) + the real tier not wired for units (it never is — see FacilioApiDataSource.saveUnits)
   * would otherwise throw out of whatever onClick handler triggered it.
   */
  function saveUnitsBestEffort(floorId: string, units: Unit[]) {
    dataSource.saveUnits(floorId, units).catch((err) => {
      showToast("Couldn't save your changes");
      // eslint-disable-next-line no-console
      console.warn('[saveUnits] failed', err);
    });
  }

  async function loadFloor(floorId: string): Promise<Unit[]> {
    dispatch({ type: 'SELECT_FLOOR_START', floorId });
    // Flag the image load NOW, not when loadFloorPlanTypesAndImage eventually starts — the
    // units/assignments/bookings awaits below leave a gap where the stage would otherwise flash
    // a blank canvas before the skeleton appears. Its finally-block still clears the flag.
    dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: true });

    // Fast path (deployed, slug floors = demo/RCU data on the vibe-db tier): every
    // floorplanApi invocation costs ~1.5-2s regardless of payload, so the four
    // per-call round-trips (units/assignments/bookings/floorplan file) dominated
    // the loader time — getFloorData bundles them into ONE. Real numeric org
    // floors keep the per-call path so the connector tier's spaces still win,
    // and dev keeps the real backend tier's precedence.
    if (!isFacilioApiConfigured && !/^\d+$/.test(floorId)) {
      try {
        const bundle = await dataSource.getFloorData!(floorId, state.date, state.planId);
        dispatch({
          type: 'SELECT_FLOOR_DONE',
          floorId,
          units: bundle.units,
          assignments: bundle.assignments,
          bookings: bundle.bookings,
        });
        try {
          const file = bundle.file ? (JSON.parse(bundle.file) as { dataUrl?: string }) : null;
          if (file?.dataUrl) dispatch({ type: 'SET_FLOOR_IMAGE', floorId, planId: state.planId, dataUrl: file.dataUrl });
        } finally {
          dispatch({ type: 'SET_FLOOR_IMAGE_LOADING', value: false });
        }
        return bundle.units;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.debug('[loadFloor] bundle fast path unavailable, using per-call path', err);
      }
    }

    // Individually caught (not a bare Promise.all) so one failing tier can't strand this floor's
    // load forever (state.loading would never clear) — local-fallback-disabled failures surface
    // as a toast + empty result instead.
    let floorLoadFailed = false;
    const [units, assignments, bookings] = await Promise.all([
      dataSource.getUnits(floorId).catch((err) => {
        floorLoadFailed = true;
        // eslint-disable-next-line no-console
        console.warn('[loadFloor] units load failed', err);
        return [] as Unit[];
      }),
      dataSource.getAssignments(floorId).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[loadFloor] assignments load failed', err);
        return {} as Assignments;
      }),
      dataSource.getBookings(floorId, state.date).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[loadFloor] bookings load failed', err);
        return [] as Booking[];
      }),
    ]);
    if (floorLoadFailed) showToast("Couldn't load this floor's data");
    dispatch({ type: 'SELECT_FLOOR_DONE', floorId, units, assignments, bookings });
    loadFloorPlanTypesAndImage(dispatch, floorId, state.planId);
    return units;
  }

  return {
    // Leaving edit mode with unsaved changes prompts to save/discard first rather than
    // switching straight away — auto-save-per-action already persists edits as they happen (see
    // placePoint/updateUnit/deleteUnit/closeDraft below), but the user still needs a chance to
    // discard a half-finished edit rather than have it silently carried into Assign/Book.
    setMode: (mode: AppState['mode']) => {
      if (state.mode === 'edit' && mode !== 'edit' && state.unsavedChanges > 0) {
        dispatch({ type: 'SET_PENDING_MODE_SWITCH', mode });
        return;
      }
      dispatch({ type: 'SET_MODE', mode });
      // Assignment/Booking need the details panel to actually show anything — open it if it's
      // closed, but never close it if it's already open (force-set, not toggle).
      if (mode === 'assign' || mode === 'book') dispatch({ type: 'SET_PANEL_OPEN', id: 'details', open: true });
    },
    toggleEdit: () => {
      if (state.mode === 'edit' && state.unsavedChanges > 0) {
        dispatch({ type: 'SET_PENDING_MODE_SWITCH', mode: 'assign' });
        return;
      }
      dispatch({ type: 'TOGGLE_EDIT' });
    },
    cancelModeSwitch: () => dispatch({ type: 'SET_PENDING_MODE_SWITCH', mode: null }),
    confirmSaveAndSwitch: async () => {
      const target = state.pendingModeSwitch;
      if (!target) return;
      // The modal stays up with a loader on the Save button while persisting (saving flag) —
      // saving must complete before the switch, unlike discard, which is instant.
      dispatch({ type: 'SET_SAVING', value: true });
      try {
        await persistUnits(state.floorId, state.units);
        dispatch({ type: 'MARK_SAVED' });
      } catch {
        showToast('Could not save changes');
      } finally {
        dispatch({ type: 'SET_SAVING', value: false });
      }
      dispatch({ type: 'SET_MODE', mode: target });
      if (target === 'assign' || target === 'book') dispatch({ type: 'SET_PANEL_OPEN', id: 'details', open: true });
      dispatch({ type: 'SET_PENDING_MODE_SWITCH', mode: null });
    },
    confirmDiscardAndSwitch: () => {
      const target = state.pendingModeSwitch;
      if (!target) return;
      // Discard is local (revert to the saved snapshot) — close the popup and switch modes
      // IMMEDIATELY; the store re-persist below is backend housekeeping the user shouldn't
      // wait on (it used to hold the modal open for the full round trip).
      dispatch({ type: 'DISCARD_CHANGES' });
      dispatch({ type: 'SET_MODE', mode: target });
      if (target === 'assign' || target === 'book') dispatch({ type: 'SET_PANEL_OPEN', id: 'details', open: true });
      dispatch({ type: 'SET_PENDING_MODE_SWITCH', mode: null });
      // Auto-save already pushed the now-discarded edits per action — re-persist the reverted
      // snapshot in the background so the store matches what's shown.
      void persistUnits(state.floorId, state.savedUnits).catch(() => {});
    },
    /**
     * In-place discard (the ✕ on the unsaved-changes bar): revert to the last-saved snapshot and
     * STAY in edit mode — unlike confirmDiscardAndSwitch, which discards on the way out.
     */
    discardChanges: () => {
      dispatch({ type: 'DISCARD_CHANGES' });
      showToast('Changes discarded');
      // Background housekeeping, same as confirmDiscardAndSwitch.
      void persistUnits(state.floorId, state.savedUnits).catch(() => {});
    },
    setTool: (tool: AppState['tool']) => dispatch({ type: 'SET_TOOL', tool }),
    /** Arm the amenity tool with a marker-library entry (built-in or custom). */
    setMarkerKind: (kind: string) => dispatch({ type: 'SET_MARKER_KIND', kind }),
    addCustomMarker: (def: MarkerDef) => {
      dispatch({ type: 'ADD_CUSTOM_MARKER', def });
      showToast(`Marker “${def.name}” added`);
    },
    /** Replaces the whole custom-markers list — used to populate it from the real API's markertype records. */
    setCustomMarkers: (defs: MarkerDef[]) => dispatch({ type: 'SET_CUSTOM_MARKERS', defs }),
    setMultiSelected: (ids: string[]) => dispatch({ type: 'SET_MULTI_SELECTED', ids }),
    /** Arm/disarm an "Available to place" record for click-placement on the canvas. */
    setPlacingUnit: (id: string | null) => dispatch({ type: 'SET_PLACING_UNIT', id }),
    toggleNav: () => dispatch({ type: 'TOGGLE_NAV' }),
    setNavView: (view: AppState['navView']) => dispatch({ type: 'SET_NAV_VIEW', view }),
    /**
     * Expanding a site/building node lazily fetches its children (buildings/floors) instead of
     * the whole org's tree being fetched up front — skipped when already loaded (buildings/
     * floors already populated) or when collapsing.
     */
    toggleNode: (id: string) => {
      const wasExpanded = !!state.expanded[id];
      dispatch({ type: 'TOGGLE_NODE', id });
      if (wasExpanded) return;

      const site = state.portfolio.find((s) => s.id === id);
      if (site) {
        if (site.buildings.length > 0) return;
        dataSource
          .getBuildingsForSite(id)
          .then((buildings) => dispatch({ type: 'SITE_BUILDINGS_LOADED', siteId: id, buildings }))
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[portfolio] buildings fetch failed for site ${id}`, err);
          });
        return;
      }
      for (const s of state.portfolio) {
        const building = s.buildings.find((b) => b.id === id);
        if (building) {
          if (building.floors.length > 0) return;
          dataSource
            .getFloorsForBuilding(id)
            .then((floors) => dispatch({ type: 'BUILDING_FLOORS_LOADED', siteId: s.id, buildingId: id, floors }))
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(`[portfolio] floors fetch failed for building ${id}`, err);
            });
          return;
        }
      }
    },

    selectFloor: (floorId: string) => {
      if (floorId === state.floorId) return;
      loadFloor(floorId);
    },
    setPlan: (planId: PlanId) => {
      dispatch({ type: 'SET_PLAN', planId });
      // Switching to a plan type whose image hasn't been fetched yet on this floor (the common
      // case — loadFloorPlanTypesAndImage only auto-fetches whichever type it resolves to on
      // floor load) needs its own fetch, not just the state flip.
      if (!state.floorImages[floorImageKey(state.floorId, planId)]) {
        ensureFloorplanImage(dispatch, state.floorId, planId);
      }
    },

    setStageSize: (w: number, h: number) => dispatch({ type: 'SET_STAGE_SIZE', w, h }),

    fitView: (rectW: number, rectH: number) => {
      dispatch({ type: 'MARK_USER_ZOOMED', value: false });
      dispatch({ type: 'SET_VIEW', view: fitViewFn(rectW, rectH, viewInsets(state)) });
    },
    zoomIn: (rectW: number, rectH: number) => {
      dispatch({ type: 'MARK_USER_ZOOMED', value: true });
      dispatch({ type: 'SET_VIEW', view: zoomAtFn(state.view, 1.3, rectW / 2, rectH / 2) });
    },
    zoomOut: (rectW: number, rectH: number) => {
      dispatch({ type: 'MARK_USER_ZOOMED', value: true });
      dispatch({ type: 'SET_VIEW', view: zoomAtFn(state.view, 1 / 1.3, rectW / 2, rectH / 2) });
    },
    zoomAtPoint: (factor: number, cx: number, cy: number) => {
      dispatch({ type: 'MARK_USER_ZOOMED', value: true });
      dispatch({ type: 'SET_VIEW', view: zoomAtFn(state.view, factor, cx, cy) });
    },
    setView: (view: AppState['view']) => dispatch({ type: 'SET_VIEW', view }),

    focusUnit: (id: string, rectW: number, rectH: number, opts?: { select?: boolean }) => {
      const u = unitById(state, id);
      if (!u) return;
      if (u.plan !== state.planId) dispatch({ type: 'SET_PLAN', planId: u.plan });
      const view = focusUnitView(u, rectW, rectH, state.view.z, viewInsets(state));
      dispatch({ type: 'SET_VIEW', view, animate: true });
      dispatch({ type: 'MARK_USER_ZOOMED', value: true });
      if (opts?.select !== false) dispatch({ type: 'SELECT_UNIT', id });
      // Pulses the marker for ~2s so it's easy to spot after jumping to it — separate from
      // selection, so callers that skip selecting (e.g. "My desk") still get the visual cue.
      dispatch({ type: 'HIGHLIGHT_UNIT', id });
      setTimeout(() => dispatch({ type: 'HIGHLIGHT_UNIT', id: null }), 2000);
      setTimeout(() => dispatch({ type: 'SET_VIEW', view, animate: false }), 380);
    },

    /**
     * "My desk" against the REAL backend: `state.myDesk` (from servicePortalHome) names a desk
     * record + floor. Navigates to that floor, then tries to map the desk record back to a
     * local unit (via its floorplanmarker's geoId) for the zoom+pulse treatment; desks that
     * were never placed through this app have no local unit, so those just land on the floor
     * with a toast.
     */
    locateMyDesk: async (rectW: number, rectH: number) => {
      const md = state.myDesk;
      if (!md?.floorId) return;
      let units: Unit[] = state.units;
      if (md.floorId !== state.floorId) units = await loadFloor(md.floorId);
      const geoId = await findUnitIdForDeskRecord(md.floorId, md.recordId).catch(() => null);
      const u = geoId ? units.find((x) => x.id === geoId) : null;
      if (u) {
        if (u.plan !== state.planId) dispatch({ type: 'SET_PLAN', planId: u.plan });
        const view = focusUnitView(u, rectW, rectH, state.view.z, viewInsets(state));
        dispatch({ type: 'SET_VIEW', view, animate: true });
        dispatch({ type: 'MARK_USER_ZOOMED', value: true });
        dispatch({ type: 'HIGHLIGHT_UNIT', id: u.id });
        setTimeout(() => dispatch({ type: 'HIGHLIGHT_UNIT', id: null }), 2000);
        setTimeout(() => dispatch({ type: 'SET_VIEW', view, animate: false }), 380);
      } else {
        showToast(`Your desk ${md.name} is on this floor`);
      }
    },

    setSpaceFilter: (filter: AppState['spaceFilter']) => dispatch({ type: 'SET_SPACE_FILTER', filter }),
    setSpaceSearch: (value: string) => dispatch({ type: 'SET_SPACE_SEARCH', value }),

    selectUnit: (id: string | null) => dispatch({ type: 'SELECT_UNIT', id }),

    /**
     * Clicking a spot with a desk/locker/parking tool no longer silently mints a new record —
     * it opens the map dialog ("which desk goes here?") offering the unplaced pool, with
     * creating a fresh record as the explicit alternative (confirmPlacementCreate below).
     */
    placePoint: (type: 'workstation' | 'locker' | 'parking', x: number, y: number) => {
      dispatch({ type: 'SET_PENDING_PLACEMENT', placement: { type, x, y } });
    },
    cancelPlacement: () => dispatch({ type: 'SET_PENDING_PLACEMENT', placement: null }),
    /** Place a marker linked to a catalog asset (drag from the Edit asset list). */
    placeAssetAt: (assetId: string, x: number, y: number) => {
      const asset = state.assets.find((a) => a.id === assetId);
      if (!asset) return;
      // Don't place the same asset twice — move the existing marker instead.
      const existing = state.units.find((u) => u.type === 'amenity' && u.assetId === assetId);
      if (existing) {
        const geom = { kind: 'point' as const, x, y };
        dispatch({ type: 'UPDATE_UNIT', id: existing.id, patch: { geom } });
        saveUnitsBestEffort(state.floorId, state.units.map((u) => (u.id === existing.id ? { ...u, geom } : u)));
        showToast(`${asset.name} moved`);
        return;
      }
      const unit: Unit = {
        id: 'as' + Date.now(),
        type: 'amenity',
        icon: 'asset',
        assetId,
        label: asset.name,
        secondary: `${asset.category} · ${asset.detail}`,
        room: roomLabelAt(state, x, y),
        geom: { kind: 'point', x, y },
        floor: state.floorId,
        plan: state.planId,
      };
      dispatch({ type: 'ADD_UNIT', unit });
      saveUnitsBestEffort(state.floorId, [...state.units, unit]);
      showToast(`${asset.name} placed`);
    },
    /** Library markers place directly (no which-record dialog) with the armed marker kind. */
    placeMarker: (kind: string, x: number, y: number) => {
      const def = resolveMarkerDef(state.customMarkers, { markerKind: kind });
      const count = state.units.filter((u) => u.type === 'amenity' && (u.markerKind ?? u.icon) === kind).length;
      const unit: Unit = {
        id: 'am' + Date.now(),
        type: 'amenity',
        markerKind: kind,
        // Legacy glyph field doubles as the render key for the built-in five, so older
        // surfaces (mobile sheet, tooltips) keep naming them without knowing markerKind.
        ...(def.icon ? { icon: def.icon } : {}),
        label: `${def.name}${count > 0 ? ` ${count + 1}` : ''}`,
        room: roomLabelAt(state, x, y),
        geom: { kind: 'point', x, y },
        floor: state.floorId,
        // amenities show on every plan type — tag them to the current one so
        // they're visible where they were placed
        plan: state.planId,
      };
      dispatch({ type: 'ADD_UNIT', unit });
      saveUnitsBestEffort(state.floorId, [...state.units, unit]);
      showToast(`${unit.label} added`);
    },
    /**
     * Drop a record onto an existing same-type marker: the dragged record takes that exact
     * spot and the record that was there moves to "Available to place".
     */
    placeUnitOnUnit: (unitId: string, targetId: string) => {
      const target = state.units.find((u) => u.id === targetId);
      const dragged = state.unplacedUnits.find((u) => u.id === unitId) ?? state.units.find((u) => u.id === unitId);
      if (!target || !dragged || target.geom.kind !== 'point' || target.type === 'room' || dragged.id === target.id) return;
      if (dragged.type !== target.type) return;
      dispatch({ type: 'REPLACE_UNIT_AT', unitId, targetId });
      const placedDragged: Unit = { ...dragged, geom: { ...target.geom }, room: target.room, floor: state.floorId };
      saveUnitsBestEffort(
        state.floorId,
        state.units.filter((u) => u.id !== targetId && u.id !== unitId).concat(placedDragged),
      );
      showToast(`${dragged.label} replaced ${target.label} — it moved to Available`);
    },
    /** Map dialog: place an EXISTING record — unplaced, or already placed elsewhere on this floor — at the pending spot. */
    confirmPlacementExisting: (unitId: string) => {
      const spot = state.pendingPlacement;
      if (!spot) return;
      const room = roomLabelAt(state, spot.x, spot.y);
      const pooled = state.unplacedUnits.find((u) => u.id === unitId);
      if (pooled) {
        dispatch({ type: 'PLACE_EXISTING_UNIT', unitId, geom: { kind: 'point', x: spot.x, y: spot.y }, room });
        saveUnitsBestEffort(state.floorId, [...state.units, { ...pooled, geom: { kind: 'point', x: spot.x, y: spot.y }, room, floor: state.floorId }]);
        showToast(`${pooled.label} placed`);
        return;
      }
      // Already placed elsewhere on this floor — move it to the new spot instead of creating one.
      const placed = state.units.find((u) => u.id === unitId);
      if (!placed || placed.geom.kind !== 'point') return;
      dispatch({ type: 'SET_PENDING_PLACEMENT', placement: null });
      dispatch({ type: 'UPDATE_UNIT', id: unitId, patch: { geom: { kind: 'point', x: spot.x, y: spot.y }, room } });
      saveUnitsBestEffort(state.floorId, state.units.map((u) => (u.id === unitId ? { ...u, geom: { kind: 'point', x: spot.x, y: spot.y }, room } : u)));
      showToast(`${placed.label} moved`);
    },
    /**
     * Map dialog: explicitly create a NEW auto-numbered record at the pending spot. This is a REAL
     * record write — `dataSource.createUnit` hits the CMMS connector's create-space so the org's
     * database gets the desk/locker/parking (it falls back to the local vibe-db/mock tier when the
     * connector isn't reachable, e.g. dev). The on-plan position is then persisted via saveUnits,
     * since space records carry no floorplan geometry.
     */
    confirmPlacementCreate: async () => {
      const spot = state.pendingPlacement;
      if (!spot) return;
      const { type, x, y } = spot;
      const label = nextLabel(state, type, TYPE_META[type].prefix);
      const base: Unit = {
        id: 'u' + Date.now(),
        type,
        label,
        secondary: type === 'workstation' ? 'Standard · single monitor' : undefined,
        room: roomLabelAt(state, x, y),
        geom: { kind: 'point', x, y },
        floor: state.floorId,
        // Tag to the plan tab actually being viewed when placed (not the unit's own type) —
        // same reasoning as placeMarker below: the click coordinates only make sense relative
        // to whatever plan/background was showing, and the canvas only renders a unit when its
        // `plan` matches the active tab.
        plan: state.planId,
        // New desks start ASSIGNED (the backend default) — switch to HOT/HOTEL in the
        // Selection panel to make them bookable instead of assignable.
        ...(type === 'workstation' ? { deskType: 'ASSIGNED' as const } : {}),
      };
      dispatch({ type: 'SET_PENDING_PLACEMENT', placement: null });
      const unit = await dataSource.createUnit(resolveSpaceLoc(state.portfolio, state.floorId), base).catch(() => base);
      dispatch({ type: 'ADD_UNIT', unit });
      saveUnitsBestEffort(state.floorId, [...state.units, unit]);
      showToast(`${label} added`);
    },
    /**
     * Sidebar drag-drop: the dragged row names the exact desk, so no dialog — an unplaced
     * record gets placed at the drop point; an already-placed one is repositioned there.
     */
    placeUnitAt: (unitId: string, x: number, y: number) => {
      const room = roomLabelAt(state, x, y);
      const pooled = state.unplacedUnits.find((u) => u.id === unitId);
      if (pooled) {
        dispatch({ type: 'PLACE_EXISTING_UNIT', unitId, geom: { kind: 'point', x, y }, room });
        saveUnitsBestEffort(state.floorId, [...state.units, { ...pooled, geom: { kind: 'point', x, y }, room, floor: state.floorId }]);
        showToast(`${pooled.label} placed`);
        return;
      }
      const placed = state.units.find((u) => u.id === unitId);
      if (!placed || placed.geom.kind !== 'point') return;
      dispatch({ type: 'UPDATE_UNIT', id: unitId, patch: { geom: { kind: 'point', x, y }, room } });
      saveUnitsBestEffort(state.floorId, state.units.map((u) => (u.id === unitId ? { ...u, geom: { kind: 'point', x, y }, room } : u)));
      showToast(`${placed.label} moved`);
    },
    pushDraftPoint: (pt: [number, number]) => dispatch({ type: 'PUSH_DRAFT_POINT', pt }),
    closeDraft: async () => {
      if (state.draft.length < 3) return;
      const label = nextLabel(state, 'room', 'RM');
      const base: Unit = {
        id: 'u' + Date.now(),
        type: 'room',
        label,
        room: null,
        geom: { kind: 'poly', pts: state.draft },
        floor: state.floorId,
        plan: 'custom',
      };
      // A drawn room is a real space too — create it on the connector (category "Room"), then
      // persist its polygon locally. Falls back to the local record if the connector isn't there.
      const unit = await dataSource.createUnit(resolveSpaceLoc(state.portfolio, state.floorId), base).catch(() => base);
      dispatch({ type: 'CLOSE_DRAFT', unit });
      saveUnitsBestEffort(state.floorId, [...state.units, unit]);
      showToast(`${label} created — rename it in the Selection panel`);
    },
    clearDraft: () => dispatch({ type: 'CLEAR_DRAFT' }),

    openAutoMap: (groups: CadGroup[]) => dispatch({ type: 'SET_AUTOMAP_GROUPS', groups }),
    closeAutoMap: () => dispatch({ type: 'SET_AUTOMAP_GROUPS', groups: null }),
    /** Keep a CAD file's analysis for the session so Edit → "Auto-map CAD units" can re-open it. */
    storeCadAnalysis: (floorId: string, planId: PlanId, groups: CadGroup[]) =>
      dispatch({ type: 'SET_CAD_ANALYSIS', key: floorImageKey(floorId, planId), groups }),
    /**
     * Materialize the auto-map modal's choices into units. Rooms are created
     * first so point units (desks/lockers/parking) can be containment-tagged
     * with the room they fall inside — same rule as manual placePoint.
     *
     * Point-type positions prefer an EXISTING unplaced record of that type over fabricating a
     * brand-new one — the CAD shape becomes a marker position that a real desk/locker/parking
     * stall gets placed onto, same as manual placement already offers (MapDeskModal's "place an
     * existing record here"). Falls back to creating a new auto-numbered record only once that
     * type's unplaced pool is exhausted.
     */
    applyAutoMap: (mapping: Record<string, UnitType | 'ignore'>) => {
      const groups = state.autoMapGroups ?? [];
      const counters: Record<UnitType, number> = {
        workstation: state.units.filter((u) => u.type === 'workstation').length,
        locker: state.units.filter((u) => u.type === 'locker').length,
        parking: state.units.filter((u) => u.type === 'parking').length,
        room: state.units.filter((u) => u.type === 'room').length,
        amenity: state.units.filter((u) => u.type === 'amenity').length,
      };
      const pad = (n: number) => String(n).padStart(2, '0');
      const created: Unit[] = [];
      const placedFromPool: Unit[] = [];
      let idSeq = Date.now();

      const pool: Partial<Record<UnitType, Unit[]>> = {};
      for (const u of state.unplacedUnits) (pool[u.type] ??= []).push(u);

      const ordered = [...groups].sort(
        (a, b) => (mapping[b.key] === 'room' ? 1 : 0) - (mapping[a.key] === 'room' ? 1 : 0),
      );
      for (const group of ordered) {
        const type = mapping[group.key];
        if (!type || type === 'ignore') continue;
        for (const item of group.items) {
          if (type === 'room') {
            if (!item.poly) continue;
            counters.room += 1;
            created.push({
              id: 'u' + idSeq++,
              type: 'room',
              label: `${TYPE_META.room.prefix}-${pad(counters.room)}`,
              room: null,
              geom: { kind: 'poly', pts: item.poly },
              floor: state.floorId,
              plan: 'custom',
            });
          } else {
            if (!item.point) continue;
            const [x, y] = item.point;
            const rooms = [...state.units, ...created].filter((u) => u.type === 'room');
            const room = rooms.find((r) => r.geom.kind === 'poly' && pointInPoly({ x, y }, r.geom.pts));
            // Tag to the ACTIVE plan tab (matching manual placement), not the unit's own type —
            // the canvas only renders a unit when its `plan` matches the currently-viewed tab.
            const fromPool = pool[type]?.shift();
            if (fromPool) {
              placedFromPool.push({ ...fromPool, room: room ? room.label : null, geom: { kind: 'point', x, y }, floor: state.floorId, plan: state.planId });
            } else {
              counters[type] += 1;
              created.push({
                id: 'u' + idSeq++,
                type,
                label: `${TYPE_META[type].prefix}-${pad(counters[type])}`,
                secondary: group.blockName ? `CAD block · ${group.blockName}` : `CAD layer · ${group.layer}`,
                room: room ? room.label : null,
                geom: { kind: 'point', x, y },
                floor: state.floorId,
                plan: state.planId,
              });
            }
          }
        }
      }

      const totalMapped = created.length + placedFromPool.length;
      if (totalMapped > 0) {
        dispatch({ type: 'APPLY_AUTOMAP', created, placedFromPool });
        saveUnitsBestEffort(state.floorId, [...state.units, ...created, ...placedFromPool]);
      }
      dispatch({ type: 'SET_AUTOMAP_GROUPS', groups: null });
      showToast(
        totalMapped > 0
          ? `${totalMapped} units mapped from CAD metadata (${placedFromPool.length} existing, ${created.length} new) — review and Save changes`
          : 'Nothing was mapped',
      );
    },
    isNearFirstDraftPoint: (pt: [number, number]) => {
      if (state.draft.length < 3) return false;
      return distNormToPx(state.draft[0], pt, state.view.z) < 12;
    },

    pushCalibPoint: (pt: [number, number]) => dispatch({ type: 'PUSH_CALIB_POINT', pt }),
    setCalibLen: (value: string) => dispatch({ type: 'SET_CALIB_LEN', value }),
    applyCalib: () => {
      const meters = parseFloat(state.calibLen);
      if (!(meters > 0) || state.calib.length !== 2) return;
      const ppm = calibratedPxPerMeter(state.calib[0], state.calib[1], meters);
      dispatch({ type: 'APPLY_CALIB', pxPerMeter: ppm });
      saveUnitsBestEffort(state.floorId, state.units); // units unaffected, but keep persistence consistent
      showToast(`Scale set — ${ppm.toFixed(1)} px/m`);
    },
    clearCalib: () => dispatch({ type: 'CLEAR_CALIB' }),

    updateUnit: (id: string, patch: Partial<Unit>) => {
      dispatch({ type: 'UPDATE_UNIT', id, patch });
      saveUnitsBestEffort(state.floorId, state.units.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    },
    /** Bulk patch — one dispatch + one persist, for group moves (marquee multi-select). */
    updateUnits: (updates: { id: string; patch: Partial<Unit> }[]) => {
      dispatch({ type: 'UPDATE_UNITS', updates });
      const patches = new Map(updates.map((u) => [u.id, u.patch]));
      saveUnitsBestEffort(state.floorId, state.units.map((u) => (patches.has(u.id) ? { ...u, ...patches.get(u.id)! } : u)));
    },
    deleteUnit: (id: string) => {
      const u = unitById(state, id);
      dispatch({ type: 'DELETE_UNIT', id });
      saveUnitsBestEffort(state.floorId, state.units.filter((x) => x.id !== id));
      if (u) showToast(`${u.label} deleted`);
    },
    /** Bulk delete (marquee multi-select) — one dispatch + one persist. */
    deleteUnits: (ids: string[]) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      dispatch({ type: 'DELETE_UNITS', ids });
      saveUnitsBestEffort(state.floorId, state.units.filter((x) => !set.has(x.id)));
      showToast(`${ids.length} unit${ids.length === 1 ? '' : 's'} deleted`);
    },

    setContactSearch: (value: string) => dispatch({ type: 'SET_CONTACT_SEARCH', value }),
    dragStartContact: (id: string | null) => dispatch({ type: 'DRAG_START_CONTACT', id }),
    dragOverUnit: (id: string | null) => dispatch({ type: 'DRAG_OVER_UNIT', id }),

    assign: async (contactId: string, unitId: string) => {
      const target = unitById(state, unitId);
      if (!target) return;
      const next = { ...state.assignments };
      // one unit per type per contact
      for (const [uid, cId] of Object.entries(next)) {
        if (cId === contactId && uid !== unitId) {
          const other = unitById(state, uid);
          if (other && other.type === target.type) delete next[uid];
        }
      }
      const prevContactId = next[unitId];
      next[unitId] = contactId;
      dispatch({ type: 'ASSIGN', unitId, contactId, assignments: next });
      await dataSource.assignUnit(unitId, contactId);
      // Best-effort real assignment (Moves for desks, a plain field update for lockers/parking)
      // — never blocks or throws into the local assignment flow above, which is already the
      // source of truth for this app's own read-path. When this unit is being REASSIGNED (it
      // already had an occupant), vacate that previous occupant as its own move first — so a
      // reassignment is captured as a departure move plus an arrival move, rather than silently
      // overwriting who's assigned with no record of the vacate.
      if (isFacilioApiConfigured) {
        (prevContactId ? vacateUnitReal(target, prevContactId) : Promise.resolve())
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[facilio-api] real vacate (on reassign) failed', err);
          })
          .then(() =>
            assignUnitReal(target, contactId).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('[facilio-api] real assignment failed', err);
            })
          );
      }
      const contactName = MOCK_CONTACTS.find((c) => c.id === contactId)?.name ?? contactId;
      const prevName = prevContactId ? MOCK_CONTACTS.find((c) => c.id === prevContactId)?.name : null;
      showToast(`${contactName} assigned to ${target.label}` + (prevName ? ` — replaced ${prevName}` : ''));
    },
    vacate: async (unitId: string) => {
      const target = unitById(state, unitId);
      const prevContactId = state.assignments[unitId];
      const next = { ...state.assignments };
      delete next[unitId];
      dispatch({ type: 'VACATE', unitId, assignments: next });
      await dataSource.vacateUnit(unitId);
      if (isFacilioApiConfigured && target && prevContactId) {
        vacateUnitReal(target, prevContactId).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[facilio-api] real vacate failed', err);
        });
      }
      const prevName = prevContactId ? MOCK_CONTACTS.find((c) => c.id === prevContactId)?.name : null;
      if (target) showToast(`${target.label} vacated` + (prevName ? ` — ${prevName} unassigned` : ''));
    },
    setWebReassign: (id: string | null) => {
      dispatch({ type: 'SET_WEB_REASSIGN', id });
      // The reassign UI lives in the details panel — starting a reassign (e.g. from a marker
      // tooltip) while that panel is minimized would otherwise leave the action with nowhere
      // to show. Force it open (never close it) so the flow is always visible.
      if (id) dispatch({ type: 'SET_PANEL_OPEN', id: 'details', open: true });
    },

    setDate: async (value: string) => {
      const bookings = await dataSource.getBookings(state.floorId, value).catch((err) => {
        showToast("Couldn't load bookings for that date");
        // eslint-disable-next-line no-console
        console.warn('[setDate] bookings load failed', err);
        return [] as Booking[];
      });
      dispatch({ type: 'SET_DATE', value, bookings });
    },
    setTimeRange: (start: number, end: number) => dispatch({ type: 'SET_TIME_RANGE', start, end }),
    openBookModal: () => dispatch({ type: 'SET_BOOK_MODAL', open: true }),
    closeBookModal: () => dispatch({ type: 'SET_BOOK_MODAL', open: false }),
    setBookField: (field: 'bookBy' | 'bookPurpose' | 'bookNotes', value: string) => dispatch({ type: 'SET_BOOK_FIELD', field, value }),
    confirmBooking: async (unitId: string) => {
      const conflicts = conflictsFor(state.bookings, unitId, state.date, state.start, state.end);
      if (state.end <= state.start || conflicts.length) return false;
      const booking: Booking = {
        id: 'b' + Date.now(),
        unitId,
        date: state.date,
        start: state.start,
        end: state.end,
        by: state.bookBy,
        purpose: state.bookPurpose,
      };
      const saved = await dataSource.createBooking(booking);
      dispatch({ type: 'ADD_BOOKING', booking: saved });
      showToast(`${unitById(state, unitId)?.label ?? 'Space'} booked`);
      return true;
    },
    cancelBooking: async (id: string) => {
      // Persist BEFORE dispatching: CANCEL_BOOKING bumps bookingsNonce, which refetches the
      // calendar — if the store still held the booking at that moment it would resurrect.
      // (That resurrection was a live bug: cancel had no persistence at all and only looked
      // like it worked until the next refetch.)
      try {
        await dataSource.cancelBooking(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[bookings] cancel persistence failed', err);
      }
      dispatch({ type: 'CANCEL_BOOKING', id });
      showToast('Booking cancelled');
    },

    /** Which real module bookings target (Space vs Facility) — mutually exclusive, set in Settings. */
    setBookingModule: (module: AppState['bookingModule']) => dispatch({ type: 'SET_BOOKING_MODULE', module }),
    /** Opens the shared booking form for a resource + window (used by the calendar drag and the book sidebar). */
    openBookingForm: (target: { unitId: string; date: string; start: number; end: number }) => dispatch({ type: 'SET_BOOK_FORM', form: target }),
    updateBookForm: (patch: Partial<{ unitId: string; date: string; start: number; end: number }>) => dispatch({ type: 'UPDATE_BOOK_FORM', patch }),
    closeBookingForm: () => dispatch({ type: 'SET_BOOK_FORM', form: null }),
    /**
     * Submits the booking form. Saves locally (survives reload) AND best-effort creates the real
     * backend booking routed by `state.bookingModule` (space -> spacebooking; facility -> TODO).
     *
     * LOCAL-BOOKING-FALLBACK: the `dataSource.createBooking` + ADD_BOOKING path below is the
     * interim local store. Once real spacebooking/facilitybooking is the source of truth for
     * every floor, delete this local branch (and the mock booking tier) and read/write bookings
     * straight from the real module. It's isolated here so removal is a clean, single-site edit.
     */
    submitBooking: async (form: {
      unitId: string;
      date: string;
      start: number;
      end: number;
      name: string;
      description: string;
      host: string;
      reservedBy: string;
      noOfAttendees: number;
      internalAttendees: string[];
      externalAttendees: string[];
      /** Org form (v2/forms) the modal rendered — travels onto the real record. */
      formId?: number;
      /** Org-form fields the app doesn't model natively (rendered generically). */
      extras?: Record<string, unknown>;
    }): Promise<boolean> => {
      const unit = unitById(state, form.unitId);
      if (!unit || form.end <= form.start) {
        showToast('Pick a valid time window');
        return false;
      }
      // Conflict-check against the resource's real slice for that exact date (the form can target
      // any date, so re-fetch rather than trust the single-date `state.bookings`).
      const dayBookings = await dataSource.getBookings(state.floorId, form.date).catch(() => [] as Booking[]);
      if (conflictsFor(dayBookings, form.unitId, form.date, form.start, form.end).length) {
        showToast('That window overlaps an existing booking');
        return false;
      }

      // --- LOCAL-BOOKING-FALLBACK (remove once real modules are the source of truth) ---
      // Persist EVERY form field to the vibe-db (not just the calendar summary): the handler
      // stores whatever object it's given, so the full booking survives reload/refresh.
      const local: Booking = {
        id: 'b' + Date.now(),
        unitId: form.unitId,
        date: form.date,
        start: form.start,
        end: form.end,
        by: form.reservedBy || form.host || state.bookBy,
        purpose: form.name,
        module: state.bookingModule,
        name: form.name,
        description: form.description,
        host: form.host,
        reservedBy: form.reservedBy,
        noOfAttendees: form.noOfAttendees,
        internalAttendees: form.internalAttendees,
        externalAttendees: form.externalAttendees,
      };
      const saved = await dataSource.createBooking(local);
      dispatch({ type: 'ADD_BOOKING', booking: saved });
      // --- end LOCAL-BOOKING-FALLBACK ---

      if (isFacilioApiConfigured) {
        createRealBooking(unit, form.date, form.start, form.end, {
          module: state.bookingModule,
          name: form.name,
          description: form.description,
          host: form.host,
          reservedBy: form.reservedBy,
          noOfAttendees: form.noOfAttendees,
          internalAttendees: form.internalAttendees,
          externalAttendees: form.externalAttendees,
          formId: form.formId,
          extras: form.extras,
        })
          .then((res) => {
            if (!res.ok) {
              showToast(`Saved locally, but the real booking failed: ${res.reason ?? 'unknown error'}`);
              // eslint-disable-next-line no-console
              console.warn(`[facilio-api] real ${state.bookingModule} booking skipped/failed: ${res.reason}`);
            }
          })
          .catch((err) => {
            showToast(`Saved locally, but the real booking failed: ${(err as Error).message ?? 'unknown error'}`);
            // eslint-disable-next-line no-console
            console.warn('[facilio-api] real booking error', err);
          });
      }

      showToast(`${unit.label} booked`);
      return true;
    },
    /**
     * Books a resource for an explicit date/time window — the calendar view drags out arbitrary
     * windows on arbitrary days, which doesn't fit `confirmBooking`'s reliance on the shared
     * `state.start/end/date`. Returns the saved booking (persisted via the data source, so it
     * survives reload) or null on an invalid/conflicting window. Conflict-checking is the
     * caller's job (the calendar holds the multi-day booking data; `state.bookings` is only the
     * single selected date).
     */
    bookResource: async (input: { unitId: string; date: string; start: number; end: number; by: string; purpose?: string }): Promise<Booking | null> => {
      if (input.end <= input.start) return null;
      const booking: Booking = {
        id: 'b' + Date.now(),
        unitId: input.unitId,
        date: input.date,
        start: input.start,
        end: input.end,
        by: input.by,
        purpose: input.purpose ?? '',
      };
      const saved = await dataSource.createBooking(booking);
      dispatch({ type: 'ADD_BOOKING', booking: saved });
      showToast(`${unitById(state, input.unitId)?.label ?? 'Space'} booked`);
      return saved;
    },
    quickMobileBook: async (unitId: string) => {
      const u = unitById(state, unitId);
      if (!u || u.type === 'locker') return;
      if (state.end <= state.start) return;
      if (conflictsFor(state.bookings, unitId, state.date, state.start, state.end).length) return;
      const booking: Booking = {
        id: 'b' + Date.now(),
        unitId,
        date: state.date,
        start: state.start,
        end: state.end,
        by: state.bookBy,
        purpose: 'Booked from mobile',
      };
      const saved = await dataSource.createBooking(booking);
      dispatch({ type: 'ADD_BOOKING', booking: saved });
      dispatch({ type: 'SET_MOB_SEL', id: null });
      showToast(`${u.label} booked · ${Math.floor(state.start / 60)}:${String(state.start % 60).padStart(2, '0')}`);
    },
    setSchedView: (view: AppState['schedView']) => dispatch({ type: 'SET_SCHED_VIEW', view }),

    setRole: (role: Role) => {
      dispatch({ type: 'SET_ROLE', role });
      showToast(`Viewing as ${role[0].toUpperCase()}${role.slice(1)}`);
    },
    togglePerm: (action: keyof AppState['perms'], role: Role) => dispatch({ type: 'TOGGLE_PERM', action, role }),
    resetPerms: () => {
      dispatch({ type: 'RESET_PERMS' });
      showToast('Permissions reset to defaults');
    },

    /**
     * Reset the local session store (units/assignments/bookings edits + settings + uploaded
     * floorplan files) so the app re-seeds from the editable src/data/*.json files and any real
     * Facilio API data on the next load. Reloads to apply the clean state.
     */
    clearCaches: async () => {
      clearLocalData();
      try {
        localStorage.removeItem('facilio_floorplan_settings_v1');
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith('facilio_floorplan_file_v1:')) localStorage.removeItem(key);
        }
      } catch {
        /* ignore */
      }
      showToast('Local data cleared — reloading to re-seed from repo JSON…');
      setTimeout(() => window.location.reload(), 600);
    },

    openMap: () => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'map' }),
    openSettings: () => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'settings' }),
    openBookings: () => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'bookings' }),
    openPeople: () => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'people' }),
    setSettingsTab: (tab: AppState['settingsTab']) => dispatch({ type: 'SET_SETTINGS_TAB', tab }),
    setModuleColor: (key: string, hex: string) => dispatch({ type: 'SET_MODULE_COLOR', key, hex }),
    setSlotGranularity: (minutes: number) => dispatch({ type: 'SET_SLOT_GRANULARITY', minutes }),
    /** dataSource.ts can't read React state directly, so this keeps its module-level flag in sync. */
    setAllowLocalFallback: (value: boolean) => {
      dispatch({ type: 'SET_ALLOW_LOCAL_FALLBACK', value });
      dataSourceSetAllowLocalFallback(value);
    },

    showToast,

    togglePanelOpen: (id: 'context' | 'portfolio' | 'details') => dispatch({ type: 'TOGGLE_PANEL_OPEN', id }),
    setPanelPos: (id: 'context' | 'portfolio' | 'details', x: number, y: number, width: number) => {
      const clamped = clampPanelPos(x, y, width, state.stage.w, state.stage.h);
      dispatch({ type: 'SET_PANEL_POS', id, x: clamped.x, y: clamped.y });
    },
    resetLayout: () => {
      dispatch({ type: 'RESET_LAYOUT' });
      showToast('Panel layout reset');
    },
    panelPos: (id: 'context' | 'portfolio' | 'details', width: number) => {
      const p = state.panels[id];
      const d = defaultPanelPos(id === 'portfolio' ? 'location' : 'details', state.stage.w);
      const open = p.open;
      const w = open ? width : 46;
      const x = p.x == null ? d.x : p.x;
      const y = p.y == null ? d.y : p.y;
      return clampPanelPos(x, y, w, state.stage.w, state.stage.h);
    },

    setMobileTab: (tab: AppState['mobileTab']) => dispatch({ type: 'SET_MOBILE_TAB', tab }),
    setMobSel: (id: string | null) => dispatch({ type: 'SET_MOB_SEL', id }),
    setMobFloorOpen: (open: boolean) => dispatch({ type: 'SET_MOB_FLOOR_OPEN', open }),
    setMobPick: (site: string | null, building: string | null) => dispatch({ type: 'SET_MOB_PICK', site, building }),
    setMobTimePick: (which: AppState['mobTimePick']) => dispatch({ type: 'SET_MOB_TIME_PICK', which }),
    setMobAssignEdit: (value: boolean) => dispatch({ type: 'SET_MOB_ASSIGN_EDIT', value }),

    setUploadOpen: (open: boolean) => dispatch({ type: 'SET_UPLOAD_OPEN', open }),
    setFloorImage: (floorId: string, planId: PlanId, dataUrl: string) => {
      dispatch({ type: 'SET_FLOOR_IMAGE', floorId, planId, dataUrl });
      // Persist the uploaded floorplan so a deployed app reloads it after a refresh. Best-effort
      // and a no-op in dev (where the real backend's indoorfloorplan record already holds it).
      void persistFloorplanFile(floorId, planId, { dataUrl });
    },

    resetDemo: () => {
      const units = seedUnits();
      const assignments = seedAssignments();
      const bookings = seedBookings(state.date);
      dispatch({ type: 'RESET_DEMO', units, assignments, bookings });
      void persistUnits(state.floorId, units).catch(() => {});
      showToast('Demo data reset');
    },

    /**
     * Edits already persist per-action (placePoint/updateUnit/deleteUnit/closeDraft all call
     * persistUnits internally) — this is an explicit, user-triggered re-save with its own
     * confirmation, for a visible "did my changes actually save" signal.
     */
    saveChanges: async () => {
      dispatch({ type: 'SET_SAVING', value: true });
      try {
        await persistUnits(state.floorId, state.units);
        dispatch({ type: 'MARK_SAVED' });
        showToast('Changes saved');
      } catch (err) {
        showToast('Could not save changes');
      } finally {
        dispatch({ type: 'SET_SAVING', value: false });
      }
    },
  };
}

export function FloorplanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, buildInitialState);
  const canvasRectRef = useRef<DOMRect | null>(null);
  const loadedRef = useRef(false);
  const settingsLoadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Path-route sync (see lib/routes.ts): state.activeView is the source of truth, pushed to
  // history (/bookings, /people, /settings — real files on the host via copy-route-pages) so
  // each bottom-nav view is a clean URL. Nav clicks push a history entry; back/forward come
  // back in via popstate. The reducer's SET_ACTIVE_VIEW is idempotent, so no loops. A legacy
  // #/x hash link resolves via viewFromLocation and gets normalized to its path form here.
  useEffect(() => {
    if (viewFromLocation(window.location) !== state.activeView) {
      window.history.pushState({}, '', pathForView(state.activeView));
    } else if (window.location.hash) {
      window.history.replaceState({}, '', pathForView(state.activeView));
    }
  }, [state.activeView]);
  useEffect(() => {
    const onPopState = () => dispatch({ type: 'SET_ACTIVE_VIEW', view: viewFromLocation(window.location) });
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Which floors have a stored floorplan (vibe-db, deployed only) — flags the portfolio tree
  // so an uploaded floor stops reading "no plan" after a refresh, without fetching any blobs.
  useEffect(() => {
    listFloorplanFloorIds().then((floorIds) => {
      if (floorIds.length) dispatch({ type: 'SET_FLOORS_WITH_PLANS', floorIds });
    });
  }, []);

  // Load persisted settings (vibe-db when deployed, else localStorage) once on mount.
  useEffect(() => {
    loadSettings()
      .then((cfg) => {
        if (cfg) {
          dispatch({ type: 'APPLY_SETTINGS', config: cfg });
          // dataSource.ts can't read React state directly — keep its module-level flag in sync
          // with whatever the persisted setting says.
          if (cfg.allowLocalFallback !== undefined) dataSourceSetAllowLocalFallback(cfg.allowLocalFallback);
        }
      })
      .finally(() => {
        settingsLoadedRef.current = true;
      });
  }, []);

  // Persist settings (as one JSON string) whenever a config slice changes — debounced so a
  // color-picker drag or rapid toggles collapse into a single write. Skipped until the initial
  // load has run, so we never clobber stored config with defaults before it arrives.
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveSettings(settingsFromState(state));
    }, 500);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.perms, state.moduleColors, state.slotGranularity, state.bookingModule, state.customMarkers, state.allowLocalFallback]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      // Local-fallback-disabled failures surface as an explicit toast + empty result, instead of
      // either masking them with mock data or leaving this Promise.all rejected (which would
      // strand state.loading forever, same class of bug as an unbounded SDK wait).
      const [portfolio, clientContacts, assets] = await Promise.all([
        dataSource.getPortfolio().catch((err) => {
          showToastVia(dispatch, "Couldn't load your organization's portfolio");
          // eslint-disable-next-line no-console
          console.warn('[boot] portfolio load failed', err);
          return [] as Site[];
        }),
        dataSource.getClientContacts().catch((err) => {
          showToastVia(dispatch, "Couldn't load client contacts");
          // eslint-disable-next-line no-console
          console.warn('[boot] client contacts load failed', err);
          return [] as ClientContact[];
        }),
        dataSource.getAssets().catch((err) => {
          showToastVia(dispatch, "Couldn't load the asset catalog");
          // eslint-disable-next-line no-console
          console.warn('[boot] assets load failed', err);
          return [] as Asset[];
        }),
      ]);
      dispatch({ type: 'PORTFOLIO_LOADED', portfolio, clientContacts, assets });

      // The mock default floorId ('hqA3') isn't a real floor against the live backend —
      // sending it to per-floor endpoints (getFloorplanDetailsByType) just 500s. Prefer the
      // CURRENT USER's own assigned/booked desk's floor (so they land somewhere relevant to
      // them); otherwise fall back to the cheapest possible "some floor exists" check — one
      // paginated floor record — rather than walking the whole site/building tree to find one.
      let myDesk: Awaited<ReturnType<typeof fetchMyDesk>> = null;
      let firstRealFloor: string | undefined;
      if (isFacilioApiConfigured) {
        myDesk = await fetchMyDesk().catch(() => null);
        firstRealFloor = myDesk?.floorId ?? (await getAnyFloor().catch(() => null))?.id;
      }
      const floorId = firstRealFloor ?? state.floorId;
      if (floorId !== state.floorId) dispatch({ type: 'SELECT_FLOOR_START', floorId });

      // Individually caught (not a bare Promise.all) — same reasoning as loadFloor's per-call
      // path: one failing tier must not strand the boot sequence with an uncaught rejection.
      let bootFloorLoadFailed = false;
      const [units, assignments, bookings] = await Promise.all([
        dataSource.getUnits(floorId).catch((err) => {
          bootFloorLoadFailed = true;
          // eslint-disable-next-line no-console
          console.warn('[boot] units load failed', err);
          return [] as Unit[];
        }),
        dataSource.getAssignments(floorId).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[boot] assignments load failed', err);
          return {} as Assignments;
        }),
        dataSource.getBookings(floorId, state.date).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[boot] bookings load failed', err);
          return [] as Booking[];
        }),
      ]);
      if (bootFloorLoadFailed) showToastVia(dispatch, "Couldn't load this floor's data");
      dispatch({ type: 'SELECT_FLOOR_DONE', floorId, units, assignments, bookings });
      loadFloorPlanTypesAndImage(dispatch, floorId, state.planId);

      // The logged-in user's real assigned/booked desk, for the "My desk" button — already
      // resolved above (reused, not re-fetched) when configured.
      if (isFacilioApiConfigured) dispatch({ type: 'SET_MY_DESK', myDesk });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => buildActions(state, dispatch, canvasRectRef), [state]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);

  return <FloorplanCtx.Provider value={value}>{children}</FloorplanCtx.Provider>;
}

export function useFloorplan(): Ctx {
  const ctx = useContext(FloorplanCtx);
  if (!ctx) throw new Error('useFloorplan must be used within FloorplanProvider');
  return ctx;
}
