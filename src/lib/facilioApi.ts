import axios from 'axios';
import { API, setConfig, setInstance } from '@facilio/api';

const devMode = import.meta.env.VITE_DEV_MODE === 'true';
const envBaseURL = import.meta.env.VITE_FACILIO_API_BASE_URL;
const token = import.meta.env.VITE_FACILIO_TOKEN;

/**
 * Connected-app mode (VITE_IS_CONNECTED_APP=true): the app is served INSIDE a Facilio org
 * (connected app tab/iframe), so the very same V3 APIs the dev token reaches are available
 * same-origin, authenticated by the user's session cookies — no bearer token at all. This mode
 * OVERRIDES dev mode and every other data tier: when it's on, the real Facilio API tier is
 * active unconditionally (rendering from the org's live data), and the vibe-db tier is demoted
 * to what it always was underneath — a fallback.
 */
export const isConnectedApp = import.meta.env.VITE_IS_CONNECTED_APP === 'true';

/**
 * Where the V3 APIs live for absolute-URL needs: same-origin in connected mode (unless
 * explicitly overridden), the configured URL in dev.
 */
const absoluteBaseURL = isConnectedApp ? envBaseURL || `${window.location.origin}/api` : envBaseURL;

/**
 * What the axios instance actually talks to. In dev the org API is cross-origin and allows no
 * CORS from localhost, so requests route through the vite dev-server proxy ('/fapi' →
 * VITE_FACILIO_API_BASE_URL — see vite.config.ts); the x-api-key header still authenticates.
 */
const baseURL = isConnectedApp ? absoluteBaseURL : devMode && envBaseURL ? '/fapi' : envBaseURL;

/** True in connected-app mode (session-cookie auth), or in dev mode with base URL + token set. */
export const isFacilioApiConfigured = isConnectedApp || (devMode && !!envBaseURL && !!token);

if (isFacilioApiConfigured) {
  // Same-origin session cookies do the authenticating in connected mode; the x-api-key header is
  // dev-only. `withCredentials` is set for the connected case so an explicitly-configured
  // same-site absolute base URL still carries the session.
  const instance = axios.create({ baseURL, withCredentials: isConnectedApp });
  if (!isConnectedApp) {
    instance.interceptors.request.use((config) => {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>)['x-api-key'] = token!;
      return config;
    });
  }
  setInstance(instance);
  setConfig({ _newV3: true, cacheTimeout: 0 });
} else if (devMode) {
  // eslint-disable-next-line no-console
  console.warn(
    '[facilioApi] VITE_DEV_MODE is true but VITE_FACILIO_API_BASE_URL / VITE_FACILIO_TOKEN are not both set — the Facilio API tier is disabled, falling back to the app db / mock tiers.'
  );
}

export { API as facilioApi };

/**
 * The bare web-app origin (e.g. `https://pre-app-stage2.facilio.in` — scheme + host only, no
 * path). Some endpoints (the `maintenance/api/...` FloorplanAction routes, the web app's own
 * `goto/summary` pages) hang directly off this bare origin rather than under the configured API
 * baseURL, so callers building an absolute URL for those need this instead of `baseURL`. In
 * connected mode that's simply the app's own origin.
 *
 * Computed via `new URL(...).origin` rather than stripping a trailing `/api` — some orgs'
 * VITE_FACILIO_API_BASE_URL already bakes a product prefix into the path (e.g.
 * `https://app.facilio.com/maintenance/api`), and a regex strip of just `/api` would leave
 * `/maintenance` behind, doubling into `.../maintenance/maintenance/api/...` once a caller
 * appends its own `/maintenance/api/...` suffix (confirmed live).
 */
export const apiOrigin: string | null = absoluteBaseURL ? new URL(absoluteBaseURL).origin : null;

/**
 * Builds a link to a record's summary page in the real Facilio web app (e.g.
 * `https://pre-app-stage2.facilio.in/maintenance/goto/summary/clientcontact/123`), matching the
 * `RECORD URL` convention documented on the CMMS actions.
 */
export function facilioRecordUrl(moduleName: string, id: string | number): string | null {
  if (!apiOrigin) return null;
  return `${apiOrigin}/maintenance/goto/summary/${moduleName}/${id}`;
}
