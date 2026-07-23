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
  /**
   * The client contact this device's user IS (Settings › Bookings › "This is me") — drives
   * "My bookings", the "Your desk" badge, and booking defaults. There's no confirmed backend
   * mapping from the logged-in session to a clientcontact record, so it's user-picked.
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
    bookBy: state.bookBy,
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
