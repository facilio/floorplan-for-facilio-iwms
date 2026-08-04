import type { MarkerDef, Perms } from './types';
import type { AppState } from '../state/types';
import { fetchOrgSettings, saveOrgSettings } from './facilioApiDataSource';

/**
 * The app's persisted settings, stored as a single multi-line JSON string in localStorage.
 *
 * This build has no vibe-db, so settings live purely in the browser (localStorage). In
 * connected-app mode a future upgrade could persist them to a Facilio API preference store; for
 * now the local copy is the source of truth on each device.
 */
export interface SettingsConfig {
  /** DEPRECATED — permission data is NEVER persisted anymore (perms resolve fresh from the org
   * each load; caching them could carry one login's access over to the next on a shared
   * browser). Keys remain so old stored JSON still parses; they are neither written nor applied. */
  perms?: Perms;
  moduleColors?: Record<string, string>;
  slotGranularity?: number;
  bookingModule?: 'space' | 'facility';
  /** User-created marker-library entries (Edit view › Markers › New marker). */
  customMarkers?: MarkerDef[];
  /** When false, a real-org data failure shows an error instead of silently falling back to local/seed data. */
  allowLocalFallback?: boolean;
  /** Org custom module holding per-role mode permissions (Settings › Permissions). */
  permsModuleName?: string;
  /** DEPRECATED — same as `perms`: kept for parse-compat, never written or applied. */
  defaultModePerms?: import('./types').ModePerms;
  /**
   * DEPRECATED — the client contact this device's user was manually picked to be. Who-you-are
   * now resolves from the login session's people id (fetchCurrentPeopleId) at boot; this key is
   * neither written nor applied anymore, it only remains so old stored JSON still parses.
   */
  bookBy?: string;
}

const LS_KEY = 'facilio_floorplan_settings_v1';

/**
 * Org custom module holding per-role floorplan mode permissions, used when none is configured.
 * Its fields follow the `<name>_<moduleName>` convention (edit_/assignment_/booking_/roles_
 * + this module name); the record label field is plain `name`.
 */
export const DEFAULT_PERMS_MODULE_NAME = 'custom_floorplanpermissions';

/** Extract the persisted slice of app state — NO permission data (see the deprecation notes). */
export function settingsFromState(state: AppState): SettingsConfig {
  return {
    moduleColors: state.moduleColors,
    slotGranularity: state.slotGranularity,
    bookingModule: state.bookingModule,
    customMarkers: state.customMarkers,
    allowLocalFallback: state.allowLocalFallback,
    permsModuleName: state.permsModuleName,
  };
}

/** Serialize to the multi-line JSON string that gets stored. */
export function serializeSettings(cfg: SettingsConfig): string {
  return JSON.stringify(cfg, null, 2);
}

export async function loadSettings(): Promise<SettingsConfig | null> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SettingsConfig) : null;
  } catch {
    return null;
  }
}

/**
 * The settings every consumer should actually apply: the ORG record (custom module
 * `custom_floorplansettings`) wins field-by-field over localStorage — settings/setup are
 * org-wide, not per-browser; the local copy is only a per-device/offline fallback. Session
 * cached; invalidated on save.
 */
let effectiveCache: Promise<SettingsConfig | null> | null = null;
export function loadEffectiveSettings(): Promise<SettingsConfig | null> {
  if (!effectiveCache) {
    effectiveCache = (async () => {
      const local = await loadSettings().catch(() => null);
      const org = await fetchOrgSettings().catch(() => null);
      if (!org?.config || Object.keys(org.config).length === 0) return local;
      return { ...(local ?? {}), ...(org.config as SettingsConfig) };
    })();
    effectiveCache.catch(() => {
      effectiveCache = null;
    });
  }
  return effectiveCache;
}

export async function saveSettings(cfg: SettingsConfig): Promise<void> {
  try {
    localStorage.setItem(LS_KEY, serializeSettings(cfg));
  } catch {
    /* ignore quota/serialization errors */
  }
  // Best-effort ORG-WIDE write (permission-gated by the org's own module rules — non-admins
  // simply fail silently and keep their device copy). Cache invalidated so the next load
  // re-reads whatever actually stuck.
  effectiveCache = null;
  void saveOrgSettings(cfg as unknown as Record<string, unknown>);
}
