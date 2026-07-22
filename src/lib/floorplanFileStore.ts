/**
 * Persistence for an uploaded floorplan source file (image, or a rasterized snapshot of a
 * PDF/CAD file), so the app can reload it after a refresh.
 *
 * This build stores the renderable bytes (a data URL) in localStorage, keyed by floor+plan.
 * In connected-app mode the real `indoorfloorplan` record is still the source of
 * truth when configured (facilioApiDataSource.uploadFloorplanFile attaches the fileId and
 * fetchFloorplanImage reads it back); this local store is the guaranteed fallback so an uploaded
 * preview survives a refresh even with no backend.
 *
 * Note: data URLs can be large and localStorage is ~5MB per origin, so a very big image may fail
 * to persist — that's swallowed (the in-memory preview still shows for the session).
 */
export interface StoredFloorplanFile {
  /** A renderable data URL — a plain image, or a rasterized snapshot of a PDF/CAD source. */
  dataUrl: string;
  /** Real Facilio file id when an @facilio upload succeeded (informational for now). */
  fileId?: number | null;
  name?: string;
  mime?: string;
}

const LS_PREFIX = 'facilio_floorplan_file_v1:';
const fileKey = (floorId: string, planId: string) => `${LS_PREFIX}${floorId}::${planId}`;

/** Reads a previously-uploaded floorplan file for a floor+plan back from localStorage. */
export async function loadFloorplanFile(floorId: string, planId: string): Promise<StoredFloorplanFile | null> {
  try {
    const raw = localStorage.getItem(fileKey(floorId, planId));
    return raw ? (JSON.parse(raw) as StoredFloorplanFile) : null;
  } catch {
    return null;
  }
}

/**
 * Floor ids that have at least one stored floorplan file — keys only, no blobs. Lets the
 * portfolio tree stop showing "no plan" for floors whose upload lives in localStorage.
 */
export async function listFloorplanFloorIds(): Promise<string[]> {
  try {
    const ids: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        const floorId = key.slice(LS_PREFIX.length).split('::')[0];
        if (floorId) ids.push(floorId);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Persists an uploaded floorplan file so the app reloads it after a refresh. Best-effort: a
 * failure (e.g. quota exceeded on a large image) is swallowed — the in-memory preview still shows.
 */
export async function persistFloorplanFile(floorId: string, planId: string, file: StoredFloorplanFile): Promise<void> {
  try {
    localStorage.setItem(fileKey(floorId, planId), JSON.stringify(file));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[floorplanFile] local save failed; kept in-memory preview only', err);
  }
}
