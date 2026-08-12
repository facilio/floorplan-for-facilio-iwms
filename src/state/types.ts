import type { PortalPlanScope,
  AppMode,
  Assignments,
  Booking,
  ClientContact,
  EditTool,
  FloorplanCustomization,
  MarkerDef,
  ModePerms,
  PanelsState,
  Perms,
  PlanId,
  Role,
  Site,
  Unit,
  UnitType,
} from '../lib/types';
import type { Asset } from '../lib/assets';
import type { ViewTransform } from '../lib/geometry';
import type { CadGroup } from '../lib/cadAnalyze';

export type SpaceFilter = 'all' | UnitType;

export interface AppState {
  mode: AppMode;
  tool: EditTool;
  /** Which marker-library entry (MarkerDef id) the 'amenity' edit tool places. */
  markerKind: string;
  /** User-created marker-library entries, persisted via settings. */
  customMarkers: MarkerDef[];
  floorId: string;
  planId: PlanId;
  expanded: Record<string, boolean>;
  navOpen: boolean;
  navView: 'tree' | 'spaces';
  panels: PanelsState;
  stage: { w: number; h: number };
  view: ViewTransform;
  viewAnim: boolean;
  userZoomed: boolean;
  spaceFilter: SpaceFilter;
  spaceSearch: string;

  units: Unit[];
  /**
   * Desk/locker/parking records that exist but aren't placed on the plan: deleting a placed
   * marker moves its record here (the desk itself isn't destroyed), and the edit-mode map
   * dialog / sidebar drag place them back. In-memory only for now — a refresh rebuilds it empty.
   */
  unplacedUnits: Unit[];
  /** A click-to-place spot awaiting the "which desk goes here?" map dialog (edit mode). */
  /**
   * Point types carry the click spot; a room carries its just-drawn outline (the draft stays
   * rendered until the dialog resolves). Both flows land in the same MapDeskModal: pick an
   * existing record via the select, or create a new one.
   */
  pendingPlacement: { type: 'workstation' | 'locker' | 'parking'; x: number; y: number } | { type: 'room'; pts: [number, number][] } | null;
  /** Snapshot of `units` as of the last explicit save (floor load, "Save changes", or a resolved discard) — the revert target for "Discard changes". */
  savedUnits: Unit[];
  /**
   * DISTINCT unsaved changes since the last save, derived by diffing `units` vs `savedUnits`
   * (see countUnsavedChanges): per unit — any module type — a geometry move counts once no
   * matter how many drags, a value edit counts once more, adds/deletes one each. Drives the
   * floating "N unsaved changes" bar and the save/discard prompt on mode switch.
   */
  unsavedChanges: number;
  /** True while an explicit save (bar button / save-and-switch) persists — drives button loaders. */
  saving: boolean;
  /** Mode the user tried to switch to while there were unsaved edit changes — set while the save/discard confirmation is open. */
  pendingModeSwitch: AppMode | null;
  assignments: Assignments;
  bookings: Booking[];
  clientContacts: ClientContact[];
  /** Org asset catalog (CMMS connector) — the Edit-mode asset picker's source. */
  assets: Asset[];
  portfolio: Site[];
  pxPerMeter: number | null;
  loading: boolean;
  dataSourceName: string | null;

  selected: string | null;
  /**
   * Marquee multi-selection (edit mode). Mutually exclusive with `selected`: picking a single
   * unit clears this, and a non-empty marquee result clears `selected`. Drives the group-drag
   * gesture on the canvas and the multi-unit inspector in the Edit panel.
   */
  multiSelected: string[];
  /**
   * An "Available to place" record armed for click-placement: the next canvas click places
   * this record there (edit mode). Toggled from the tray row's "Click map" affordance.
   */
  placingUnitId: string | null;
  /** Unit to visually pulse for ~2s (e.g. after "My desk" jumps to it) — separate from `selected`, which also opens the info panel. */
  highlightUnitId: string | null;
  draft: [number, number][];
  calib: [number, number][];
  calibLen: string;
  contactSearch: string;
  /** True while the SERVER-side people search for `contactSearch` is in flight. */
  contactSearchLoading: boolean;
  dragContactId: string | null;
  dragOverId: string | null;

  date: string;
  start: number;
  end: number;
  bookBy: string;
  bookPurpose: string;
  bookNotes: string;
  bookModalOpen: boolean;
  /** The booking form's current target (resource + window). When set, the shared BookingModal is open. Both the calendar and the sidebar populate this. */
  bookForm: { unitId: string; date: string; start: number; end: number; allowTypeSwitch?: boolean; resourceUnit?: Unit; /** Floors the calendar's top filter is limited to — the form's lookups follow it. */ floorIds?: string[]; /** Multi-day drag: the day the window ENDS on (omitted = same day). */ endDate?: string } | null;
  /** Which real Facilio module bookings target. Mutually exclusive — set in Settings. */
  bookingModule: 'space' | 'facility';
  /** Bumped on every booking add/cancel so surfaces holding their own booking cache (the calendar) know to refetch. */
  bookingsNonce: number;
  /** Bumped after ANY action on a unit (assign, vacate, a stateflow transition) so the open
   *  details popup/panel re-reads the record instead of showing the pre-action state. */
  unitNonce: number;
  webReassign: string | null;
  /** Unit whose ASSIGN / RE-ASSIGN person lookup popup is open (requested: its own popup, not an inline picker). */
  peoplePicker: string | null;
  schedView: 'list' | 'calendar';

  role: Role;
  perms: Perms;

  /** Org custom module holding per-role mode permissions (Settings › Permissions). Empty = none. */
  permsModuleName: string;
  /** Fallback mode visibility when the module has no record for the user's role (Settings-editable). */
  defaultModePerms: ModePerms;
  /** RESOLVED mode visibility for the current user — what actually shows/hides the mode tabs. */
  modePerms: ModePerms;
  /** True when modePerms came from a module record (defaults-toggles then don't overwrite it). */
  modePermsFromModule: boolean;
  /** False until the org has ANSWERED on permissions — the tabs stay hidden rather than showing
   *  every mode and then retracting to the user's real scope (reported as a glimpse). */
  modePermsResolved: boolean;

  activeView: 'map' | 'settings' | 'bookings' | 'people';
  settingsTab: 'permissions' | 'bookings' | 'module' | UnitType;
  moduleColors: Record<string, string>;
  slotGranularity: number;
  /**
   * When false, the local/mock tier is excluded from the data-source fallback chain (Settings ›
   * Local data) — a real-org data failure surfaces as an explicit error instead of silently
   * showing local/seed data. Only takes effect when a real backend is actually configured
   * (connected-app mode, or dev with a base URL + token) — in plain local dev there's no "real"
   * tier to prefer, so this has no effect there.
   */
  allowLocalFallback: boolean;

  /** Design-system toast stack (max 3, newest last) — see primitives/Toast. */
  toasts: import('../components/primitives/Toast').ToastItem[];

  mobileTab: 'book' | 'assign';
  mobSel: string | null;
  mobPickSite: string | null;
  mobPickBuilding: string | null;
  mobFloorOpen: boolean;
  mobTimePick: 'start' | 'end' | null;
  mobAssignEdit: boolean;

  uploadOpen: boolean;
  /** Mappable structure of the last-uploaded CAD file — non-null while the auto-map modal is open. */
  autoMapGroups: CadGroup[] | null;
  /** Per floor/plan (floorImageKey) CAD analysis kept for the session, so the Edit panel can re-open auto-map without re-uploading. */
  cadAnalyses: Record<string, CadGroup[]>;
  /** The logged-in user's real assigned/booked desk (from servicePortalHome) — powers "My desk" against the real backend, where `assignments` (mock-derived) can't. */
  myDesk: { recordId: number; name: string; floorId: string | null; booked: boolean; isRoom?: boolean } | null;
  floorImages: Record<string, string>;
  /**
   * Floors known to have an uploaded floorplan — from the vibe-db file list at boot plus any
   * upload/load this session. The portfolio tree ORs this with the (static) floor.hasPlan flag
   * so a floor stops reading "no plan" the moment a plan actually exists for it.
   */
  floorsWithPlans: Record<string, true>;
  /** Unit id whose record summary is being fetched for the preview — drives a loader, not a flicker. */
  unitDetailLoading: string | null;
  /** Unit whose STATEFLOW read is still in flight — the popup's loader waits for this too, so the
   *  state pill and the action buttons don't appear a beat after everything else. */
  flowPendingUnitId: string | null;
  /** True when running inside a non-maintenance (portal) app — resolved from fetchCurrentApp. */
  isPortalApp: boolean;
  /**
   * PORTALS only: floors/buildings/sites that actually have an indoorfloorplan (one filtered
   * floor query — see fetchPortalPlanFloors). null = maintenance app, still loading, or
   * fail-open — NO filtering in any of those cases.
   */
  portalPlanFloors: PortalPlanScope | null;
  /** Which plan types actually have a configured floor plan, fetched lazily per-floor on selection (not eagerly for the whole portfolio). */
  floorPlanTypes: Record<string, { id: PlanId; name: string; recordId: number }[]>;
  /** True while a floor/plan-type's real image (or the plan-type list) is being fetched — drives the loading overlay over the canvas. */
  floorImageLoading: boolean;
  /**
   * Per floor/plan (floorImageKey) real rendering rules (`indoorfloorplan.customizationBooking`)
   * — drives marker colors/labels in assign/book view (see lib/unitStatus). Absent key = not
   * fetched yet or not configured for that floor+plan; falls back to this app's own colors.
   */
  floorCustomizations: Record<string, FloorplanCustomization>;
  /** Force EVERY marker label visible (declutter + zoom gate bypassed) — user toggle, see ZoomControls. */
  showAllLabels: boolean;
}
