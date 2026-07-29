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
  const mod = await import('@mlightcad/cad-simple-viewer');
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
    const ok = await manager.openDocument(file.name, buffer, { openViewMode: AcApOpenViewMode.Extents });
    if (!ok) throw new Error('Could not parse this CAD file');

    // `openDocument()` resolving doesn't mean entity conversion is done — for DWG especially
    // (parsed off-thread via a web worker), batch conversion keeps running afterward, and the
    // library's own docs warn that "parsing can report 100% before this reaches zero." A real
    // building-scale DWG confirmed this: openDocument resolved, but the canvas was still fully
    // blank moments later. Wait for `isProcessingEntities` to clear, then fit the camera
    // ourselves rather than trust the auto-fit's internal timing against our own snapshot delay.
    const deadline = Date.now() + 15000;
    while (manager.curView.isProcessingEntities && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    manager.curView.zoomToFitDrawing();
    // The fit itself isn't synchronous either (confirmed against the real building DWG: the
    // camera's position/zoom were still at their pre-fit default a tick after this call, and
    // only settled onto the drawing's actual bounds after roughly a second) — 300ms wasn't
    // enough on top of the isProcessingEntities wait above, so this is deliberately generous.
    await new Promise((r) => setTimeout(r, 1200));

    // DETERMINISTIC framing on top of the async fit: zoomToFitDrawing routes through the
    // library's progressive-open machinery (poll timers, incremental-fit state), so the FINAL
    // camera can differ slightly run-to-run and scale-to-scale. Markers live as FRACTIONS of
    // the rendered frame — a hi-res zoom tier framed even 1% differently than the base slides
    // the whole drawing under every placed desk. `zoomTo(box, margin)` is proportional (margin
    // is a factor of the box, no fixed-pixel padding — verified in the bundle), so pinning the
    // camera to the scene's own box here yields the IDENTICAL world→frame mapping at every
    // render size. Falls back to whatever the async fit produced when the box isn't exposed.
    const view: any = manager.curView;
    const fitBox = view.resolveLayoutFitBox?.();
    if (fitBox) {
      view.zoomTo(fitBox, 1.1);
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
