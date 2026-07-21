// Route-rescue service worker — the ONLY way to get clean SPA paths on the vibe static host.
//
// The host has no SPA fallback, no directory-index resolution, and serves extensionless files
// as application/octet-stream (all verified live) — so /bookings can never come from the server
// as HTML. Instead, this worker intercepts NAVIGATION requests to the app's route paths and
// answers them with the root page (which the host does serve), letting the client router
// (src/lib/routes.ts) show the right view. Everything else — assets, API calls, other pages —
// passes straight through to the network untouched.
//
// Caveat by design: the very first visit a browser ever makes to a deep link (before this
// worker has installed) still 404s; opening the app root once installs the worker and every
// refresh/deep-link works from then on.
const ROUTE_PATHS = new Set(['/bookings', '/people', '/settings']);

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (event.request.mode === 'navigate' && url.origin === self.location.origin && ROUTE_PATHS.has(path)) {
    event.respondWith(
      fetch('/', { credentials: 'include' }).then((res) =>
        // Force the HTML content type — never let an upstream octet-stream turn into a download.
        new Response(res.body, { status: res.status, headers: { 'content-type': 'text/html; charset=utf-8' } })
      )
    );
  }
});
