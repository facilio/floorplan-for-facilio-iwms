import { DEFAULT_PERMS, floorImageKey } from '../lib/types';
import type { Booking, MarkerDef, PlanId, Site, Unit } from '../lib/types';
import { clamp, fitView } from '../lib/geometry';
import { seedBookings } from '../lib/mockData';
import { viewFromLocation } from '../lib/routes';
import type { AppState } from './types';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Distinct unsaved changes, DERIVED by diffing against the last save instead of incrementing a
 * counter per action — for every module type (desks, lockers, parking, rooms alike): dragging
 * the same unit five times is ONE change (its geometry differs from the saved copy), editing
 * its value fields (label/type/room/...) is ONE more, and each add or delete is one. Derived
 * counting also means dragging a unit back exactly where it started costs nothing — the diff
 * is empty again.
 */
function countUnsavedChanges(units: Unit[], savedUnits: Unit[]): number {
  const savedById = new Map(savedUnits.map((u) => [u.id, u]));
  const liveIds = new Set(units.map((u) => u.id));
  let count = 0;
  for (const u of units) {
    const saved = savedById.get(u.id);
    if (!saved) {
      count += 1; // newly placed — its position/edits are all part of that one change
      continue;
    }
    if (JSON.stringify(u.geom) !== JSON.stringify(saved.geom)) count += 1; // moved, however many times
    const { geom: _g, ...rest } = u;
    const { geom: _sg, ...savedRest } = saved;
    if (JSON.stringify(rest) !== JSON.stringify(savedRest)) count += 1; // value edits, as one more
  }
  for (const s of savedUnits) if (!liveIds.has(s.id)) count += 1; // deleted
  return count;
}

export function buildInitialState(): AppState {
  const iso = todayIso();
  return {
    mode: 'assign',
    tool: 'select',
    markerKind: 'stairs',
    customMarkers: [],
    // Boot into the seed floor from src/data — HQ Berlin › Building A › Floor 3 (the one the JSON
    // units live on). Edit src/data/portfolio.json + units.json to change the local dataset.
    floorId: 'hqA3',
    planId: 'workstation',
    // Expand that site + building in the portfolio tree so the initial floor is visible.
    expanded: { sBer: true, bA: true },
    navOpen: false,
    navView: 'spaces',
    panels: {
      context: { open: true, x: null, y: null },
      portfolio: { open: true, x: null, y: null },
      details: { open: true, x: null, y: null },
    },
    stage: { w: 1200, h: 700 },
    view: { tx: 0, ty: 0, z: 0.5 },
    viewAnim: false,
    userZoomed: false,
    spaceFilter: 'all',
    spaceSearch: '',

    units: [],
    unplacedUnits: [],
    pendingPlacement: null,
    savedUnits: [],
    unsavedChanges: 0,
    saving: false,
    pendingModeSwitch: null,
    assignments: {},
    bookings: [],
    employees: [],
    assets: [],
    portfolio: [],
    pxPerMeter: null,
    loading: true,
    dataSourceName: null,

    selected: null,
    multiSelected: [],
    placingUnitId: null,
    highlightUnitId: null,
    draft: [],
    calib: [],
    calibLen: '',
    empSearch: '',
    dragEmpId: null,
    dragOverId: null,

    date: iso,
    start: 600,
    end: 660,
    bookBy: 'e1',
    bookPurpose: '',
    bookNotes: '',
    bookModalOpen: false,
    bookForm: null,
    bookingModule: 'space',
    bookingsNonce: 0,
    webReassign: null,
    schedView: 'list',

    role: 'admin',
    perms: { ...DEFAULT_PERMS },

    // Each bottom-nav view is a path route (see lib/routes.ts) — boot straight into whatever
    // the URL says, so a refresh/deep link on /bookings etc. lands on that tab.
    activeView: viewFromLocation(window.location),
    settingsTab: 'permissions',
    moduleColors: {},
    slotGranularity: 30,

    toast: null,

    mobileTab: 'book',
    mobSel: null,
    mobPickSite: null,
    mobPickBuilding: null,
    mobFloorOpen: false,
    mobTimePick: null,
    mobAssignEdit: false,

    uploadOpen: false,
    autoMapGroups: null,
    cadAnalyses: {},
    myDesk: null,
    floorImages: {},
    floorsWithPlans: {},
    floorPlanTypes: {},
    // Start in the loading state so a fresh load / refresh paints the shimmer immediately, not a
    // blank/placeholder canvas. The mount-time image load clears it in its finally block.
    floorImageLoading: true,
  };
}

export type Action =
  | { type: 'SET_MODE'; mode: AppState['mode'] }
  | { type: 'TOGGLE_EDIT' }
  | { type: 'SET_TOOL'; tool: AppState['tool'] }
  | { type: 'SET_MARKER_KIND'; kind: string }
  | { type: 'ADD_CUSTOM_MARKER'; def: MarkerDef }
  | { type: 'SET_MULTI_SELECTED'; ids: string[] }
  | { type: 'SET_PLACING_UNIT'; id: string | null }
  | { type: 'REPLACE_UNIT_AT'; unitId: string; targetId: string }
  | { type: 'TOGGLE_NAV' }
  | { type: 'SET_NAV_VIEW'; view: AppState['navView'] }
  | { type: 'TOGGLE_NODE'; id: string }
  | { type: 'SELECT_FLOOR_START'; floorId: string }
  | { type: 'SELECT_FLOOR_DONE'; floorId: string; units: Unit[]; assignments: AppState['assignments']; bookings: Booking[] }
  | { type: 'SET_PLAN'; planId: AppState['planId'] }
  | { type: 'SET_STAGE_SIZE'; w: number; h: number }
  | { type: 'SET_VIEW'; view: AppState['view']; animate?: boolean }
  | { type: 'MARK_USER_ZOOMED'; value: boolean }
  | { type: 'SET_SPACE_FILTER'; filter: AppState['spaceFilter'] }
  | { type: 'SET_SPACE_SEARCH'; value: string }
  | { type: 'PORTFOLIO_LOADED'; portfolio: Site[]; employees: AppState['employees']; assets: AppState['assets'] }
  | { type: 'SELECT_UNIT'; id: string | null }
  | { type: 'HIGHLIGHT_UNIT'; id: string | null }
  | { type: 'ADD_UNIT'; unit: Unit }
  | { type: 'ADD_UNITS'; units: Unit[] }
  | { type: 'UPDATE_UNIT'; id: string; patch: Partial<Unit> }
  | { type: 'UPDATE_UNITS'; updates: { id: string; patch: Partial<Unit> }[] }
  | { type: 'DELETE_UNIT'; id: string }
  | { type: 'DELETE_UNITS'; ids: string[] }
  | { type: 'PUSH_DRAFT_POINT'; pt: [number, number] }
  | { type: 'CLEAR_DRAFT' }
  | { type: 'CLOSE_DRAFT'; unit: Unit }
  | { type: 'PUSH_CALIB_POINT'; pt: [number, number] }
  | { type: 'SET_CALIB_LEN'; value: string }
  | { type: 'APPLY_CALIB'; pxPerMeter: number }
  | { type: 'CLEAR_CALIB' }
  | { type: 'SET_EMP_SEARCH'; value: string }
  | { type: 'DRAG_START_EMP'; id: string | null }
  | { type: 'DRAG_OVER_UNIT'; id: string | null }
  | { type: 'ASSIGN'; unitId: string; employeeId: string; assignments: AppState['assignments'] }
  | { type: 'VACATE'; unitId: string; assignments: AppState['assignments'] }
  | { type: 'SET_WEB_REASSIGN'; id: string | null }
  | { type: 'SET_DATE'; value: string; bookings: Booking[] }
  | { type: 'SET_TIME_RANGE'; start: number; end: number }
  | { type: 'SET_BOOK_MODAL'; open: boolean }
  | { type: 'SET_BOOK_FIELD'; field: 'bookBy' | 'bookPurpose' | 'bookNotes'; value: string }
  | { type: 'SET_BOOK_FORM'; form: AppState['bookForm'] }
  | { type: 'UPDATE_BOOK_FORM'; patch: Partial<NonNullable<AppState['bookForm']>> }
  | { type: 'SET_BOOKING_MODULE'; module: AppState['bookingModule'] }
  | { type: 'ADD_BOOKING'; booking: Booking }
  | { type: 'CANCEL_BOOKING'; id: string }
  | { type: 'SET_SCHED_VIEW'; view: AppState['schedView'] }
  | { type: 'SET_ROLE'; role: AppState['role'] }
  | { type: 'TOGGLE_PERM'; action: keyof AppState['perms']; role: AppState['role'] }
  | { type: 'RESET_PERMS' }
  | { type: 'SET_ACTIVE_VIEW'; view: AppState['activeView'] }
  | { type: 'SET_PENDING_PLACEMENT'; placement: AppState['pendingPlacement'] }
  | { type: 'PLACE_EXISTING_UNIT'; unitId: string; geom: Unit['geom']; room: string | null }
  | { type: 'APPLY_SETTINGS'; config: import('../lib/settingsStore').SettingsConfig }
  | { type: 'SET_FLOORS_WITH_PLANS'; floorIds: string[] }
  | { type: 'SET_SETTINGS_TAB'; tab: AppState['settingsTab'] }
  | { type: 'SET_MODULE_COLOR'; key: string; hex: string }
  | { type: 'SET_SLOT_GRANULARITY'; minutes: number }
  | { type: 'SHOW_TOAST'; message: string | null }
  | { type: 'TOGGLE_PANEL_OPEN'; id: 'context' | 'portfolio' | 'details' }
  | { type: 'SET_PANEL_OPEN'; id: 'context' | 'portfolio' | 'details'; open: boolean }
  | { type: 'SET_PANEL_POS'; id: 'context' | 'portfolio' | 'details'; x: number; y: number }
  | { type: 'RESET_LAYOUT' }
  | { type: 'SET_MOBILE_TAB'; tab: AppState['mobileTab'] }
  | { type: 'SET_MOB_SEL'; id: string | null }
  | { type: 'SET_MOB_FLOOR_OPEN'; open: boolean }
  | { type: 'SET_MOB_PICK'; site: string | null; building: string | null }
  | { type: 'SET_MOB_TIME_PICK'; which: AppState['mobTimePick'] }
  | { type: 'SET_MOB_ASSIGN_EDIT'; value: boolean }
  | { type: 'SET_UPLOAD_OPEN'; open: boolean }
  | { type: 'SET_AUTOMAP_GROUPS'; groups: AppState['autoMapGroups'] }
  | { type: 'SET_CAD_ANALYSIS'; key: string; groups: AppState['autoMapGroups'] }
  | { type: 'SET_FLOOR_IMAGE'; floorId: string; planId: PlanId; dataUrl: string }
  | { type: 'SET_FLOOR_PLAN_TYPES'; floorId: string; types: AppState['floorPlanTypes'][string] }
  | { type: 'SET_FLOOR_IMAGE_LOADING'; value: boolean }
  | { type: 'SET_MY_DESK'; myDesk: AppState['myDesk'] }
  | { type: 'MARK_SAVED' }
  | { type: 'SET_SAVING'; value: boolean }
  | { type: 'DISCARD_CHANGES' }
  | { type: 'SET_PENDING_MODE_SWITCH'; mode: AppState['mode'] | null }
  | { type: 'RESET_DEMO'; units: Unit[]; assignments: AppState['assignments']; bookings: Booking[] };

function resetSelectionState(_s: AppState): Partial<AppState> {
  return { selected: null, multiSelected: [], placingUnitId: null, draft: [], calib: [], calibLen: '', dragOverId: null, webReassign: null };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.mode, tool: 'select', ...resetSelectionState(state) };
    case 'TOGGLE_EDIT':
      return { ...state, mode: state.mode === 'edit' ? 'assign' : 'edit', tool: 'select', ...resetSelectionState(state) };
    case 'SET_TOOL':
      return { ...state, tool: action.tool, draft: [], calib: [], calibLen: '', placingUnitId: null, multiSelected: [] };
    case 'SET_MARKER_KIND':
      // Arming a library marker IS picking the amenity tool for that kind.
      return { ...state, markerKind: action.kind, tool: 'amenity', placingUnitId: null, multiSelected: [] };
    case 'ADD_CUSTOM_MARKER':
      return { ...state, customMarkers: [...state.customMarkers, action.def] };
    case 'SET_MULTI_SELECTED':
      return { ...state, multiSelected: action.ids, selected: action.ids.length > 0 ? null : state.selected };
    case 'SET_PLACING_UNIT':
      return { ...state, placingUnitId: action.id, ...(action.id ? { tool: 'select' as const } : {}) };
    // Drop an "Available to place" record (or an already-placed one) onto an existing same-type
    // marker: the dragged record takes the target's exact spot, and the target's record moves to
    // the unplaced pool — re-mapping which record sits at a location without re-aiming the point.
    case 'REPLACE_UNIT_AT': {
      const target = state.units.find((u) => u.id === action.targetId);
      if (!target || target.geom.kind !== 'point' || target.type === 'room') return state;
      const dragged = state.unplacedUnits.find((u) => u.id === action.unitId) ?? state.units.find((u) => u.id === action.unitId);
      if (!dragged || dragged.id === target.id) return state;
      const placedDragged: Unit = { ...dragged, geom: { ...target.geom }, room: target.room, floor: state.floorId };
      const units = state.units.filter((u) => u.id !== action.targetId && u.id !== action.unitId).concat(placedDragged);
      const unplacedUnits = [...state.unplacedUnits.filter((u) => u.id !== action.unitId), target];
      return {
        ...state,
        units,
        unplacedUnits,
        selected: placedDragged.id,
        multiSelected: [],
        placingUnitId: null,
        unsavedChanges: countUnsavedChanges(units, state.savedUnits),
      };
    }
    case 'TOGGLE_NAV':
      return { ...state, navOpen: !state.navOpen };
    case 'SET_NAV_VIEW':
      return { ...state, navView: action.view };
    case 'TOGGLE_NODE':
      return { ...state, expanded: { ...state.expanded, [action.id]: !state.expanded[action.id] } };
    case 'SELECT_FLOOR_START':
      if (action.floorId === state.floorId) return state;
      return {
        ...state,
        floorId: action.floorId,
        userZoomed: false,
        navView: 'spaces',
        spaceSearch: '',
        spaceFilter: 'all',
        loading: true,
        // Switching floors: shimmer immediately (cleared once the new floor's image resolves), so
        // the new floor's markers never briefly render over the old/blank background.
        floorImageLoading: true,
        ...resetSelectionState(state),
      };
    case 'SELECT_FLOOR_DONE':
      if (action.floorId !== state.floorId) return state;
      return { ...state, units: action.units, savedUnits: action.units, unsavedChanges: 0, assignments: action.assignments, bookings: action.bookings, loading: false };
    case 'SET_PLAN':
      return { ...state, planId: action.planId, ...resetSelectionState(state) };
    case 'SET_STAGE_SIZE':
      return { ...state, stage: { w: action.w, h: action.h } };
    case 'SET_VIEW':
      return { ...state, view: action.view, viewAnim: !!action.animate };
    case 'MARK_USER_ZOOMED':
      return { ...state, userZoomed: action.value };
    case 'SET_SPACE_FILTER':
      return { ...state, spaceFilter: action.filter };
    case 'SET_SPACE_SEARCH':
      return { ...state, spaceSearch: action.value };
    case 'PORTFOLIO_LOADED':
      return { ...state, portfolio: action.portfolio, employees: action.employees, assets: action.assets };

    case 'SELECT_UNIT':
      return { ...state, selected: action.id, webReassign: null, ...(action.id ? { multiSelected: [] } : {}) };
    case 'HIGHLIGHT_UNIT':
      return { ...state, highlightUnitId: action.id };
    case 'ADD_UNIT': {
      const units = [...state.units, action.unit];
      return { ...state, units, selected: action.unit.id, unsavedChanges: countUnsavedChanges(units, state.savedUnits) };
    }
    case 'ADD_UNITS': {
      const units = [...state.units, ...action.units];
      return { ...state, units, unsavedChanges: countUnsavedChanges(units, state.savedUnits) };
    }
    case 'UPDATE_UNIT': {
      const units = state.units.map((u) => (u.id === action.id ? { ...u, ...action.patch } : u));
      return { ...state, units, unsavedChanges: countUnsavedChanges(units, state.savedUnits) };
    }
    case 'UPDATE_UNITS': {
      const patches = new Map(action.updates.map((u) => [u.id, u.patch]));
      const units = state.units.map((u) => (patches.has(u.id) ? { ...u, ...patches.get(u.id) } : u));
      return { ...state, units, unsavedChanges: countUnsavedChanges(units, state.savedUnits) };
    }
    case 'DELETE_UNIT': {
      const assignments = { ...state.assignments };
      delete assignments[action.id];
      const removed = state.units.find((u) => u.id === action.id);
      const units = state.units.filter((u) => u.id !== action.id);
      return {
        ...state,
        units,
        // Deleting a desk/locker/parking marker un-places the record rather than destroying it —
        // it lands in the unplaced pool, where the map dialog / sidebar drag can put it back.
        // Rooms are pure geometry, so they delete outright.
        unplacedUnits: removed && removed.type !== 'room' ? [...state.unplacedUnits, removed] : state.unplacedUnits,
        assignments,
        bookings: state.bookings.filter((b) => b.unitId !== action.id),
        selected: state.selected === action.id ? null : state.selected,
        unsavedChanges: countUnsavedChanges(units, state.savedUnits),
      };
    }
    case 'DELETE_UNITS': {
      const ids = new Set(action.ids);
      const assignments = { ...state.assignments };
      const unplaced = [...state.unplacedUnits];
      for (const u of state.units) {
        if (!ids.has(u.id)) continue;
        delete assignments[u.id];
        if (u.type !== 'room') unplaced.push(u); // same un-place semantics as single delete
      }
      const units = state.units.filter((u) => !ids.has(u.id));
      return {
        ...state,
        units,
        unplacedUnits: unplaced,
        assignments,
        bookings: state.bookings.filter((b) => !ids.has(b.unitId)),
        selected: state.selected && ids.has(state.selected) ? null : state.selected,
        multiSelected: state.multiSelected.filter((id) => !ids.has(id)),
        unsavedChanges: countUnsavedChanges(units, state.savedUnits),
      };
    }
    case 'SET_PENDING_PLACEMENT':
      return { ...state, pendingPlacement: action.placement };
    case 'PLACE_EXISTING_UNIT': {
      const pooled = state.unplacedUnits.find((u) => u.id === action.unitId);
      if (!pooled) return state;
      const placed: Unit = { ...pooled, geom: action.geom, room: action.room, floor: state.floorId };
      const units = [...state.units, placed];
      return {
        ...state,
        units,
        unplacedUnits: state.unplacedUnits.filter((u) => u.id !== action.unitId),
        selected: placed.id,
        pendingPlacement: null,
        unsavedChanges: countUnsavedChanges(units, state.savedUnits),
      };
    }
    case 'PUSH_DRAFT_POINT':
      return { ...state, draft: [...state.draft, action.pt] };
    case 'CLEAR_DRAFT':
      return { ...state, draft: [] };
    case 'CLOSE_DRAFT': {
      const units = [...state.units, action.unit];
      return { ...state, units, draft: [], tool: 'select', selected: action.unit.id, unsavedChanges: countUnsavedChanges(units, state.savedUnits) };
    }
    case 'PUSH_CALIB_POINT':
      return { ...state, calib: state.calib.length >= 2 ? state.calib : [...state.calib, action.pt] };
    case 'SET_CALIB_LEN':
      return { ...state, calibLen: action.value };
    case 'APPLY_CALIB':
      return { ...state, pxPerMeter: action.pxPerMeter, calib: [], calibLen: '', tool: 'select' };
    case 'CLEAR_CALIB':
      return { ...state, calib: [], calibLen: '' };

    case 'SET_EMP_SEARCH':
      return { ...state, empSearch: action.value };
    case 'DRAG_START_EMP':
      return { ...state, dragEmpId: action.id };
    case 'DRAG_OVER_UNIT':
      return { ...state, dragOverId: action.id };
    case 'ASSIGN':
      return { ...state, assignments: action.assignments, dragOverId: null, dragEmpId: null, selected: action.unitId, webReassign: null };
    case 'VACATE':
      return { ...state, assignments: action.assignments };
    case 'SET_WEB_REASSIGN':
      return { ...state, webReassign: action.id };

    case 'SET_DATE':
      return { ...state, date: action.value, bookings: action.bookings };
    case 'SET_TIME_RANGE':
      return { ...state, start: action.start, end: action.end };
    case 'SET_BOOK_MODAL':
      return { ...state, bookModalOpen: action.open, bookPurpose: action.open ? state.bookPurpose : '', bookNotes: action.open ? state.bookNotes : '' };
    case 'SET_BOOK_FIELD':
      return { ...state, [action.field]: action.value } as AppState;
    case 'SET_BOOK_FORM':
      return { ...state, bookForm: action.form, bookModalOpen: !!action.form };
    case 'UPDATE_BOOK_FORM':
      return { ...state, bookForm: state.bookForm ? { ...state.bookForm, ...action.patch } : state.bookForm };
    case 'SET_BOOKING_MODULE':
      return { ...state, bookingModule: action.module };
    case 'APPLY_SETTINGS': {
      const c = action.config;
      return {
        ...state,
        perms: c.perms ?? state.perms,
        moduleColors: c.moduleColors ?? state.moduleColors,
        slotGranularity: c.slotGranularity ?? state.slotGranularity,
        bookingModule: c.bookingModule ?? state.bookingModule,
        customMarkers: c.customMarkers ?? state.customMarkers,
      };
    }
    case 'ADD_BOOKING':
      return {
        ...state,
        bookings: [...state.bookings, action.booking],
        bookModalOpen: false,
        bookForm: null,
        bookPurpose: '',
        bookNotes: '',
        bookingsNonce: state.bookingsNonce + 1,
      };
    case 'CANCEL_BOOKING':
      return { ...state, bookings: state.bookings.filter((b) => b.id !== action.id), bookingsNonce: state.bookingsNonce + 1 };
    case 'SET_SCHED_VIEW':
      return { ...state, schedView: action.view };

    case 'SET_ROLE':
      return { ...state, role: action.role };
    case 'TOGGLE_PERM': {
      const cur = state.perms[action.action];
      const has = cur.includes(action.role);
      const next = has ? cur.filter((r) => r !== action.role) : [...cur, action.role];
      return { ...state, perms: { ...state.perms, [action.action]: next } };
    }
    case 'RESET_PERMS':
      return { ...state, perms: { ...DEFAULT_PERMS } };

    case 'SET_ACTIVE_VIEW':
      // Idempotent so the hash<->state sync in FloorplanContext can dispatch freely on every
      // hashchange without triggering render churn (or a dispatch->hash->dispatch loop).
      if (state.activeView === action.view) return state;
      return { ...state, activeView: action.view };
    case 'SET_SETTINGS_TAB':
      return { ...state, settingsTab: action.tab };
    case 'SET_MODULE_COLOR':
      return { ...state, moduleColors: { ...state.moduleColors, [action.key]: action.hex } };
    case 'SET_SLOT_GRANULARITY':
      return { ...state, slotGranularity: action.minutes, end: Math.min(1200, state.start + action.minutes) };

    case 'SHOW_TOAST':
      return { ...state, toast: action.message };

    case 'TOGGLE_PANEL_OPEN':
      return { ...state, panels: { ...state.panels, [action.id]: { ...state.panels[action.id], open: !state.panels[action.id].open } } };
    case 'SET_PANEL_OPEN':
      return { ...state, panels: { ...state.panels, [action.id]: { ...state.panels[action.id], open: action.open } } };
    case 'SET_PANEL_POS':
      return { ...state, panels: { ...state.panels, [action.id]: { ...state.panels[action.id], x: action.x, y: action.y } } };
    case 'RESET_LAYOUT':
      return {
        ...state,
        panels: {
          context: { open: true, x: null, y: null },
          portfolio: { open: true, x: null, y: null },
          details: { open: true, x: null, y: null },
        },
      };

    case 'SET_MOBILE_TAB':
      return { ...state, mobileTab: action.tab, mobSel: null };
    case 'SET_MOB_SEL':
      return { ...state, mobSel: action.id, mobAssignEdit: action.id ? state.mobAssignEdit : false };
    case 'SET_MOB_FLOOR_OPEN':
      return action.open
        ? { ...state, mobFloorOpen: true, mobPickSite: null, mobPickBuilding: null, mobSel: null }
        : { ...state, mobFloorOpen: false };
    case 'SET_MOB_PICK':
      return { ...state, mobPickSite: action.site, mobPickBuilding: action.building };
    case 'SET_MOB_TIME_PICK':
      return { ...state, mobTimePick: action.which };
    case 'SET_MOB_ASSIGN_EDIT':
      return { ...state, mobAssignEdit: action.value };

    case 'SET_UPLOAD_OPEN':
      return { ...state, uploadOpen: action.open };
    case 'SET_AUTOMAP_GROUPS':
      return { ...state, autoMapGroups: action.groups };
    case 'SET_CAD_ANALYSIS': {
      const cadAnalyses = { ...state.cadAnalyses };
      if (action.groups && action.groups.length > 0) cadAnalyses[action.key] = action.groups;
      else delete cadAnalyses[action.key];
      return { ...state, cadAnalyses };
    }
    case 'SET_FLOOR_IMAGE':
      return {
        ...state,
        floorImages: { ...state.floorImages, [floorImageKey(action.floorId, action.planId)]: action.dataUrl },
        // A floor with an actual image is a floor with a plan — flip the tree badge immediately.
        floorsWithPlans: { ...state.floorsWithPlans, [action.floorId]: true },
      };
    case 'SET_FLOORS_WITH_PLANS': {
      const next = { ...state.floorsWithPlans };
      for (const id of action.floorIds) next[id] = true;
      return { ...state, floorsWithPlans: next };
    }
    case 'SET_FLOOR_PLAN_TYPES':
      return { ...state, floorPlanTypes: { ...state.floorPlanTypes, [action.floorId]: action.types } };
    case 'SET_FLOOR_IMAGE_LOADING':
      return { ...state, floorImageLoading: action.value };
    case 'SET_MY_DESK':
      return { ...state, myDesk: action.myDesk };
    case 'SET_SAVING':
      return { ...state, saving: action.value };
    case 'MARK_SAVED':
      return { ...state, savedUnits: state.units, unsavedChanges: 0 };
    case 'DISCARD_CHANGES':
      return { ...state, units: state.savedUnits, unsavedChanges: 0, ...resetSelectionState(state) };
    case 'SET_PENDING_MODE_SWITCH':
      return { ...state, pendingModeSwitch: action.mode };

    case 'RESET_DEMO':
      return { ...state, units: action.units, savedUnits: action.units, unsavedChanges: 0, assignments: action.assignments, bookings: action.bookings, selected: null, draft: [], calib: [] };

    default:
      return state;
  }
}

export function initialViewForStage(w: number, h: number) {
  return fitView(w, h);
}

export function clampMinutes(v: number): number {
  return clamp(v, 0, 1439);
}

export { seedBookings };
