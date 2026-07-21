import type { AppState } from '../state/types';

/**
 * Path routes for the bottom-nav views: / (map), /bookings, /people, /settings.
 *
 * Each view is a real route — refresh lands back on the same tab, browser back/forward walk the
 * tabs, and the URL is shareable. The vibe static host has NO SPA fallback (unknown paths 404,
 * verified live), so these paths only survive a hard refresh because the build publishes a copy
 * of index.html at each of them (scripts/copy-route-pages.mjs, run by `npm run build`). Adding a
 * view here therefore means adding its path to that script too.
 *
 * The sync lives in FloorplanContext: state.activeView is the single source of truth, pushed to
 * history on change, and popstate (back/forward) is dispatched back into state. Legacy #/x hash
 * links from the earlier hash-router still resolve (viewFromLocation reads the hash first) and
 * get normalized to the path form on load.
 */
export type AppView = AppState['activeView'];

const PATH_BY_VIEW: Record<AppView, string> = {
  map: '/',
  bookings: '/bookings',
  people: '/people',
  settings: '/settings',
};

const VIEW_BY_PATH: Record<string, AppView> = {
  '/': 'map',
  '/bookings': 'bookings',
  '/people': 'people',
  '/settings': 'settings',
};

export function pathForView(view: AppView): string {
  return PATH_BY_VIEW[view] ?? '/';
}

/** Unknown/empty paths resolve to the map so a bad link degrades to the default view. */
export function viewFromPath(pathname: string): AppView {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  return VIEW_BY_PATH[path] ?? 'map';
}

/** Current view from the full location — honors legacy #/x hash links, then the pathname. */
export function viewFromLocation(loc: { pathname: string; hash: string }): AppView {
  const hashPath = (loc.hash || '').replace(/^#/, '');
  if (hashPath && VIEW_BY_PATH[hashPath.replace(/\/+$/, '') || '/']) return VIEW_BY_PATH[hashPath.replace(/\/+$/, '') || '/'];
  return viewFromPath(loc.pathname);
}
