/**
 * Worker URLs resolved against the app's ACTUAL served location, not the host
 * root. Hardcoded '/workers/...' broke the connected-app embed: mounted under
 * a subpath (e.g. …/iwms-floor-plan/), '/workers/x.js' hit the host root and
 * 404'd, so the CAD engine failed to init → "Could not render this CAD file".
 * `import.meta.env.BASE_URL` ('./' with our base config) resolved against the
 * document base yields the right path wherever the app is mounted.
 */
export function cadWorkerUrls() {
  const base = import.meta.env.BASE_URL || './';
  const at = (name: string) => new URL(`${base}workers/${name}`, document.baseURI).href;
  return {
    dxfParser: at('dxf-parser-worker.js'),
    dwgParser: at('libredwg-parser-worker.js'),
    mtextRender: at('mtext-renderer-worker.js'),
  };
}

/**
 * WALL-CLOCK BUDGET for ONE CAD pass (engine load + document open + entity settle + snapshot),
 * after which the attempt REJECTS instead of hanging.
 *
 * Why this exists (established by live investigation, not defensive guesswork): for a DWG,
 * `cad-simple-viewer` and the mtext-render worker load fine but `libredwg-parser-worker.js` is
 * NEVER requested at all (the asset itself serves 200, 12.5MB) — so `openDocument()`'s promise
 * never settles, in either direction. Neither the lazy ~13MB engine import nor `openDocument`
 * rejects on its own, so anything awaiting them waited forever with no error to report: the upload
 * modal sat on "Rendering…" and the code that actually SENDS the file to Facilio was never reached.
 * Fixing DWG parsing is a separate job; this only guarantees the wait ENDS, with a rejection a
 * caller can turn into "couldn't read this CAD file".
 *
 * TWO bounds, because the two stalls have very different legitimate durations:
 *
 *  - CAD_ENGINE_LOAD_MS covers the lazy ~13MB engine import ALONE. A cold fetch over a slow link is
 *    legitimately 10-20s and is NOT the failure being caught here, so it gets its own generous
 *    allowance and is deliberately NOT charged against the budget below.
 *  - CAD_TIMEOUT_MS covers the document pass (open + the 15s entity settle + 1.5s of camera-settle
 *    sleeps). 30s (the requested 20-30s window) is what turns "the parser never answered" into an
 *    error the user can act on while it's still plausibly their problem to retry. The risk this
 *    accepts, stated plainly: a genuinely enormous drawing that would have parsed in 40s now fails
 *    as unreadable — and it still reaches the org, because the upload no longer waits on the render
 *    at all (see FloorUploadModal). That trade is the whole point of the ordering fix; raise this
 *    only if real drawings are seen failing on time rather than on content.
 */
export const CAD_ENGINE_LOAD_MS = 45_000;
export const CAD_TIMEOUT_MS = 30_000;

/** Rejects `promise` if it hasn't settled within `ms`, naming the stage. `cad-timeout:` prefixed so callers can word it differently from a parse failure. */
export function withCadTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cad-timeout: ${what} didn't finish within ${Math.round(ms / 1000)}s`)), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** True for this module's own timeout rejection (a stalled engine/parser), as opposed to a file it read and couldn't parse. */
export function isCadTimeoutError(err: unknown): boolean {
  return /^cad-timeout:/.test((err as Error)?.message ?? '');
}

/** One shared deadline for a whole CAD pass — every step draws from the same remaining time. */
export interface CadBudget {
  remainingMs(): number;
  /** Rejects with a `cad-timeout:` error if `work` hasn't settled by the deadline. */
  guard<T>(work: Promise<T>, label: string): Promise<T>;
}

export function cadBudget(ms = CAD_TIMEOUT_MS): CadBudget {
  const deadline = Date.now() + ms;
  return {
    remainingMs: () => deadline - Date.now(),
    guard: <T,>(work: Promise<T>, label: string) => withCadTimeout(work, deadline - Date.now(), label),
  };
}

/**
 * The CAD engine module, bounded separately from the document pass (see CAD_ENGINE_LOAD_MS) — and
 * loaded BEFORE the pass budget starts, so a cold 13MB fetch can't eat the parse's allowance.
 */
export function loadCadEngine(): Promise<typeof import('@mlightcad/cad-simple-viewer')> {
  return withCadTimeout(import('@mlightcad/cad-simple-viewer'), CAD_ENGINE_LOAD_MS, 'loading the CAD engine');
}

/**
 * `openDocument`, bounded by the pass budget. On timeout the underlying open may stay pending
 * forever, so the viewer is torn down WITHOUT awaiting the teardown (a hung open can hang destroy
 * too) — otherwise a timed-out attempt keeps its WebGL context, canvas and parser alive for the
 * rest of the session.
 */
export async function openCadDocument(manager: any, file: File, buffer: ArrayBuffer, openViewMode: unknown, budget: CadBudget): Promise<boolean> {
  try {
    return await budget.guard(Promise.resolve(manager.openDocument(file.name, buffer, { openViewMode })), `reading ${file.name}`);
  } catch (err) {
    try {
      void Promise.resolve(manager.destroy?.()).catch(() => {});
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Waits for entity conversion to finish, bounded by BOTH its own 15s allowance and what's left of
 * the pass budget. `openDocument()` resolving doesn't mean conversion is done — for DWG especially
 * (parsed off-thread via a web worker), batch conversion keeps running afterward, and the library's
 * own docs warn that "parsing can report 100% before this reaches zero." A real building-scale DWG
 * confirmed this: openDocument resolved, but the canvas was still fully blank moments later.
 */
export async function waitForCadEntities(view: any, budget: CadBudget): Promise<void> {
  const deadline = Date.now() + 15_000;
  // Leave ~1.5s of budget for the fixed camera-settle sleeps that follow.
  while (view.isProcessingEntities && Date.now() < deadline && budget.remainingMs() > 1_500) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Renders a DWG/DXF file to a PNG data URL using @mlightcad/cad-simple-viewer
 * (a pure client-side, WASM-backed CAD parser/renderer — no server round-trip).
 * The heavy parser bundle (~13MB for DWG via LibreDWG) is only fetched lazily,
 * the first time a CAD file is actually opened.
 *
 * `scale` multiplies the base 1492×1054 raster: the vector source re-renders crisply at any
 * size, so the zoom-tier upgrade path (see FloorplanBackground) re-runs this at 2×/3× when the
 * user zooms in past what the base raster can show. The camera fit is Extents both times, so a
 * higher-scale render frames the identical content — only sharper.
 */
export async function renderCadToDataUrl(file: File, scale = 1): Promise<string> {
  // Time-bounded throughout (see CAD_TIMEOUT_MS): an engine or parser that never answers rejects
  // instead of hanging the caller forever. The engine load is bounded on its own; the document pass
  // that follows shares one deadline.
  const mod = await loadCadEngine();
  const budget = cadBudget();
  const { AcApDocManager, AcApOpenViewMode } = mod;

  const w = Math.round(1492 * scale);
  const h = Math.round(1054 * scale);
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.width = `${w}px`;
  container.style.height = `${h}px`;
  document.body.appendChild(container);

  try {
    const manager = AcApDocManager.createInstance({
      container,
      width: w,
      height: h,
      // Skip fetching the default CAD font manifest from the library's CDN — this app only
      // needs a snapshot of the drawing's geometry, not exact text-glyph fidelity, and that
      // fetch failing (e.g. no network access to cdn.jsdelivr.net) was throwing an uncaught
      // error during initialization.
      notLoadDefaultFonts: true,
      webworkerFileUrls: cadWorkerUrls(),
    });
    if (!manager) throw new Error('CAD viewer failed to initialize');

    const buffer = await file.arrayBuffer();
    // Without an explicit view mode, the default open mode restores the drawing's saved
    // AutoCAD viewport (VPORT `*ACTIVE`) rather than framing the actual geometry — for a
    // snapshot render (not an interactive edit session) that saved view can easily point at an
    // empty region, producing a blank canvas even though the drawing parsed fine. Forcing
    // `Extents` always fits the camera to the real content.
    const ok = await openCadDocument(manager, file, buffer, AcApOpenViewMode.Extents, budget);
    if (!ok) throw new Error('Could not parse this CAD file');

    // Entity conversion outlives openDocument — see waitForCadEntities. Then fit the camera
    // ourselves rather than trust the auto-fit's internal timing against our own snapshot delay.
    await waitForCadEntities(manager.curView, budget);
    manager.curView.zoomToFitDrawing();
    // The fit itself isn't synchronous either (confirmed against the real building DWG: the
    // camera's position/zoom were still at their pre-fit default a tick after this call, and
    // only settled onto the drawing's actual bounds after roughly a second) — 300ms wasn't
    // enough on top of the isProcessingEntities wait above, so this is deliberately generous.
    await new Promise((r) => setTimeout(r, 1200));

    // DETERMINISTIC framing on top of the async fit — see pinCadCamera.
    if (pinCadCamera(manager.curView, file)) {
      await new Promise((r) => setTimeout(r, 300));
    }

    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('CAD viewer produced no canvas');
    const dataUrl = cadCanvasToLightSnapshot(canvas);

    await manager.destroy();
    return dataUrl;
  } finally {
    container.remove();
  }
}

export function isCadFile(filename: string): boolean {
  return /\.(dwg|dxf)$/i.test(filename);
}

/**
 * DETERMINISTIC camera framing, shared by EVERY render pass of a given file (base snapshot,
 * 2×/3× zoom tiers, the auto-map analysis).
 *
 * zoomToFitDrawing routes through the library's async progressive-open machinery, so the final
 * camera can differ run-to-run; and even an explicit fit differs when one pass snapshots before
 * entity conversion fully finished (its scene box is smaller — the first parse of a session is
 * the slowest, so exactly the base render risked this). Markers live as FRACTIONS of the frame:
 * any framing drift slides the whole drawing under every placed desk on tier swap/zoom.
 *
 * Fix: resolve the fit box ONCE per file and reuse that exact box for every subsequent pass.
 * `zoomTo(box, margin)` is proportional (margin is a factor of the box, no fixed-pixel padding
 * — verified in the bundle), so same box + same aspect = the identical world→frame mapping at
 * every render size, by construction.
 */
const cadFitBoxCache = new Map<string, unknown>();
export function pinCadCamera(view: any, file: File): boolean {
  const key = `${file.name}:${file.size}`;
  let box = cadFitBoxCache.get(key);
  if (!box) {
    box = view.resolveLayoutFitBox?.();
    if (box) cadFitBoxCache.set(key, box);
  }
  if (!box) return false; // fall back to whatever the async fit produced
  view.zoomTo(box, 1.1);
  return true;
}

/**
 * Dark→light theme for the CAD snapshot. The viewer renders AutoCAD-style
 * (black background, light linework) and re-applies the drawing's own layout
 * background during openDocument — overriding any backgroundColor set through
 * the API before/after open (confirmed against a real DWG). Instead of
 * fighting that timing, invert near-grayscale pixels in the captured frame:
 * black background → white, white/gray strokes → black/dark. Chromatic pixels
 * (colored layers) pass through untouched.
 */
export function cadCanvasToLightSnapshot(canvas: HTMLCanvasElement): string {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    // near-grayscale = low chroma; leave colored entities (green/blue/red layers) alone
    if (Math.max(r, g, b) - Math.min(r, g, b) < 28) {
      const v = 255 - Math.round((r + g + b) / 3);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out.toDataURL('image/png');
}
