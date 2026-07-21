# Floorplan Manager — Connected App

A React + Vite implementation of the "Floorplan Manager" design prototype (`.design-src/Floorplan Manager.dc.html`), built as a Facilio **connected app**.

This is the connected-app fork of the vibe-app project: it supports **only** two modes — a Facilio connected app (real V3 API, same-origin session cookies) and **local dev** (data from the editable JSON in `src/data/`). The vibe-db tier, the Facilio CMMS/IWMS connectors, the `@facilio/vibe-sdk`, the `floorplanApi` Studio Function, and the seeding scripts are all removed.

## Run it

```bash
npm install
npm run dev        # http://localhost:9090 (strict port)
npm run build      # outputs dist/, index.html at the root
npm run typecheck
```

Out of the box `npm run dev` runs fully offline against the JSON data in `src/data/` — no backend required.

## `.env.local` setup

Copy `.env.local.example` to `.env.local` (gitignored — never commit it). Two modes:

- **Local JSON (default):** leave everything blank/false — the app serves `src/data/*.json`.
- **Dev against a real org:** set `VITE_DEV_MODE=true` and both `VITE_FACILIO_API_BASE_URL` (…/api) + `VITE_FACILIO_TOKEN`. The bearer token authenticates the real V3 API; requests route through the vite dev proxy (`/fapi`) to dodge CORS.
- **Connected app:** `VITE_IS_CONNECTED_APP=true` (set in `.env.production`) — served inside a Facilio org, the V3 APIs are called same-origin with the user's session cookies (no token), overriding dev mode.

## Data layer

`src/lib/dataSource.ts` tries a two-tier list of `FloorplanDataSource` implementations per call, first-to-resolve wins (`defaultTiers()`):

1. **`@facilio/api`** (`src/lib/facilioApiDataSource.ts`, V3 module CRUD via `v3/modules/{moduleName}`) — active in connected-app mode (session cookies) or in dev with a base URL + token. Serves real `site`/`building`/`floor`/`employee` records and the real floorplan file-upload/attach path. Deliberately **not** wired for units/assignments/bookings/create: on-plan geometry lives in separate `floorplanmarker` records whose schema needs verifying against a live org, so those fall through rather than guess. Marker geometry is synced back via `saveFloorplanMarkers` (see `persistUnits`).
2. **Local JSON** (`LocalJsonDataSource` in `dataSource.ts`) — serves the editable seed from `src/data/*.json` and layers this session's edits on top in `localStorage`. Always succeeds; powers offline dev and is the fallback under the API tier.

### Editable data — `src/data/*.json`

The dataset that used to live in the vibe-db is now plain JSON files you can edit in the repo:

| File | Contents |
|---|---|
| `portfolio.json` | site → building → floor tree |
| `employees.json` | people directory |
| `units.json` | placed desks / lockers / rooms / parking (with normalized `geom`) |
| `assignments.json` | `unitId → employeeId` map |
| `bookings.json` | booking templates (date-agnostic; the app stamps the viewed day) |
| `assets.json` | Edit-mode asset catalog |

Edit a file and save — Vite picks it up (the seed is imported directly). Session edits made in the UI persist to `localStorage`; **Settings → Local data → Clear local data** wipes those and reloads to re-seed from the JSON. `src/lib/mockData.ts` re-exports this same JSON for the reducer's initial state, so there's a single source of truth.

### Floorplan file uploads

"Upload floorplan" renders the file client-side first (image directly, PDF via pdf.js, DWG/DXF via `@mlightcad/cad-simple-viewer`) so it works fully offline, and persists the renderable data URL to `localStorage` (`floorplanFileStore`) so it survives a refresh. When `@facilio/api` is configured it *additionally* uploads the original for real and attaches the `fileId` to the floor's `indoorfloorplan` record (best-effort; a failure surfaces as a toast).

## Deploying

Build a static bundle and serve it as a Facilio connected app (inside the org, so `VITE_IS_CONNECTED_APP=true` from `.env.production` applies):

```bash
npm run build      # → dist/
# host dist/ wherever the connected app is served from
```

There is no `vibe deploy` in this build.

## Floorplan Editor (edit mode)

Edit mode implements the "Floorplan Editor" design (`.design-src/Floorplan Editor.dc.html`):

- **Edit view panel** with **Tools | Markers** tabs: a live active-tool banner (name + hint), a
  "Work with units" grid (Select `V` / Room / Scale), and an "Add to plan" grid (Desk, Locker,
  Parking — drag onto the plan or click to arm; Asset opens the asset list).
- **Marker library** (Markers tab): 9 built-ins (stairs, elevator, restroom, fire extinguisher,
  first aid, fire exit, printer, pantry, reception) plus **custom markers** (name, 1–2 char chip
  label, optional image URL, color) created inline and persisted via settings
  (`customMarkers`). Markers drag onto the plan or click-to-arm, and render as colored chips.
- **Available to place** tray (Location panel): unplaced records drag onto the plan **or
  click-to-arm** ("Click map" pill) and place on the next canvas click.
- **Replace semantics**: dropping a record (tray drag or an on-canvas marker drag) onto an
  existing marker of the same type gives the dragged record that exact spot; the old record
  moves back to "Available to place" (green ring shows the drop target).
- **Inspector card**: single selection (label, desk type, room, area, delete) or marquee
  multi-selection ("N selected", Delete N). Deleting keeps records — they return to the tray.
- Dark **save bar** (`N unsaved changes · Discard · Save changes`), Shift+drag marquee,
  `V`/`Esc`/`Delete` shortcuts.

Deliberately not ported from the design prototype: the mock Facilio top-bar chrome (the app
gets real chrome from the connected-app host when embedded), and the "empty desk slot"
(`filled: false`) markers — a placeholder-slot concept with no counterpart in the real
floorplanmarker data model yet.

## Known simplifications vs. the original prototype

- **Floorplan background image**: the original referenced a rendered raster PNG that wasn't available to this rebuild (it exceeded the design-tool's file-size cap). Replaced with a generated SVG architectural schematic (`src/components/canvas/FloorplanBackground.tsx`) that follows the same desk/room layout — actually crisper at high zoom than a raster would be. Users can upload a real plan (PNG/JPG/PDF/DWG/DXF) via "Upload floorplan", which replaces it per-floor.
- **DWG/DXF upload**: rendered fully client-side via `@mlightcad/cad-simple-viewer` (MIT-licensed, WASM-backed CAD parser — no external conversion service). This is a heavier, best-effort integration I couldn't interactively test against a real DWG file; it degrades gracefully to an error message if parsing fails. Its DWG parser worker is ~13MB, lazy-loaded only when a DWG/DXF is actually selected.
- **Settings → module color overrides**: not persisted (matches the original prototype's behavior — resets on reload). Permissions and slot-granularity are persisted via the data layer's mock tier.
- **Vestigial features from the original were intentionally dropped**, not ported: a dead third panel, unwired mobile pan/zoom/pinch, a computed-but-unrendered mobile tooltip, and role/permission enforcement that in the original was cosmetic only (toggles in Settings didn't actually gate anything). If real permission enforcement is wanted, `state.perms` + `state.role` are already modeled and just need to gate the relevant actions/buttons.
- **Floor id mismatch when `@facilio/api` is configured**: the app's default floor (`state.floorId`, hardcoded to the mock seed's `'hqA3'`) won't exist in a real org's portfolio, so the canvas shows "No floorplan yet" for it even though the Location panel's spaces list still shows the 41 mock units (those come from the mock tier, keyed to `'hqA3'`, independently of the real portfolio tree). This also means uploading a floorplan while on that floor uploads the file for real but can't attach it to a real `indoorfloorplan` record (the toast says so rather than overclaiming success). Not fixed yet — the fix is to auto-select a real floor from the loaded portfolio when `@facilio/api` answers `getPortfolio()`, at the cost of losing the mock demo data's richness for that floor (mock units are only seeded for `'hqA3'`).
