import type { MarkerDef, Perms } from './types';
import type { AppState } from '../state/types';

/**
 * The app's persisted settings, stored as a single multi-line JSON string in localStorage.
 *
 * This build has no vibe-db, so settings live purely in the browser (localStorage). In
 * connected-app mode a future upgrade could persist them to a Facilio API preference store; for
 * now the local copy is the source of truth on each device.
 */
export interface SettingsConfig {
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
  /** Fallback mode visibility when no module record matches the user's role. */
  defaultModePerms?: import('./types').ModePerms;
  /**
   * DEPRECATED — the client contact this device's user was manually picked to be. Who-you-are
   * now resolves from the login session's people id (fetchCurrentPeopleId) at boot; this key is
   * neither written nor applied anymore, it only remains so old stored JSON still parses.
   */
  bookBy?: string;
}

const LS_KEY = 'facilio_floorplan_settings_v1';

/** Extract the persisted slice of app state. */
export function settingsFromState(state: AppState): SettingsConfig {
  return {
    perms: state.perms,
    moduleColors: state.moduleColors,
    slotGranularity: state.slotGranularity,
    bookingModule: state.bookingModule,
    customMarkers: state.customMarkers,
    allowLocalFallback: state.allowLocalFallback,
    permsModuleName: state.permsModuleName,
    defaultModePerms: state.defaultModePerms,
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

export async function saveSettings(cfg: SettingsConfig): Promise<void> {
  try {
    localStorage.setItem(LS_KEY, serializeSettings(cfg));
  } catch {
    /* ignore quota/serialization errors */
  }
}
