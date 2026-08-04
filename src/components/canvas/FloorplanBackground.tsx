import { useEffect, useState } from 'react';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { isFacilioApiConfigured } from '../../lib/facilioApi';

/**
 * HYBRID SVG plan rendering (benchmarked, see commit):
 *
 * 1. Reasonably-sized SVGs render INLINE as real vectors — pixel-perfect at every zoom level,
 *    measured as smooth as a bitmap up to ~30k elements. The markup is sanitized first
 *    (scripts/foreignObject/event handlers/external hrefs stripped) since inlining executes
 *    in the app's DOM.
 * 2. Heavier SVGs fall back to a ONE-TIME 4× PNG raster: painting a huge vector drawing
 *    re-rasterizes it at every new zoom scale (a measured 492ms frame freeze — the reported
 *    stutter), while a fixed bitmap costs the same per frame no matter how complex the source
 *    was. Sharp to 400% zoom.
 *
 * Both paths keep ONE framing forever — unlike the old zoom-tier re-render (removed for
 *   framing drift), nothing about the source changes after the initial resolve.
 * Raster plans (PNG/JPG/server-rendered CAD) pass through untouched.
 */
const INLINE_MAX_BYTES = 2.5 * 1024 * 1024;
const INLINE_MAX_ELEMENTS = 30000;
const RASTER_SCALE = 4;
const RASTER_MAX_EDGE = 8192;
const svgRasterCache = new Map<string, string>();
const svgRasterInFlight = new Map<string, Promise<string | null>>();
/** Sanitized inline markup per url; null = too heavy/unusable → the raster path decides. */
const svgInlineCache = new Map<string, string | null>();
const svgInlineInFlight = new Map<string, Promise<string | null>>();

function isSvgUrl(url: string): boolean {
  return /^data:image\/svg|\.svg([?#]|$)/i.test(url);
}

function svgTextFromUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) {
    try {
      const comma = url.indexOf(',');
      const payload = url.slice(comma + 1);
      return Promise.resolve(url.slice(0, comma).includes(';base64') ? atob(payload) : decodeURIComponent(payload));
    } catch {
      return Promise.resolve(null);
    }
  }
  return fetch(url)
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
}

/**
 * Sanitized inline markup for a plan SVG, or null when it shouldn't inline: too big, too many
 * elements (vector paint cost scales with node count — the raster fallback doesn't), no usable
 * viewBox, or it isn't valid SVG at all. Strips everything that could execute or exfiltrate:
 * scripts, foreignObject, on* handlers, and non-local hrefs.
 */
function sanitizeSvgForInline(text: string): string | null {
  if (text.length > INLINE_MAX_BYTES) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
  if (doc.getElementsByTagName('*').length > INLINE_MAX_ELEMENTS) return null;
  for (const el of Array.from(doc.querySelectorAll('script, foreignObject'))) el.remove();
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'xlink:href') && !/^\s*(#|data:)/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  }
  if (!root.getAttribute('viewBox')) {
    const w = parseFloat(root.getAttribute('width') ?? '');
    const h = parseFloat(root.getAttribute('height') ?? '');
    if (!(w > 0) || !(h > 0)) return null;
    root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  // Fill the IMG_W×IMG_H frame with objectFit:contain semantics (meet = letterbox, centered).
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  root.setAttribute('style', 'display:block');
  return new XMLSerializer().serializeToString(root);
}

async function rasterizeSvgOnce(url: string): Promise<string | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || IMG_W;
    const h = img.naturalHeight || IMG_H;
    const k = Math.min(RASTER_SCALE, RASTER_MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves how an SVG plan url renders: `inline` markup when it qualifies (vector-crisp at any
 * zoom), else a one-time high-res `raster`. Cached per url, deduped while in flight; non-SVG
 * urls resolve to neither and pass through as-is.
 */
function useSvgPlan(imageUrl?: string): { inline: string | null; raster: string | null } {
  const [inline, setInline] = useState<string | null>(() => (imageUrl ? svgInlineCache.get(imageUrl) ?? null : null));
  const [raster, setRaster] = useState<string | null>(() => (imageUrl ? svgRasterCache.get(imageUrl) ?? null : null));
  useEffect(() => {
    setInline(imageUrl ? svgInlineCache.get(imageUrl) ?? null : null);
    setRaster(imageUrl ? svgRasterCache.get(imageUrl) ?? null : null);
    if (!imageUrl || !isSvgUrl(imageUrl)) return;
    let alive = true;

    const startRaster = () => {
      const cached = svgRasterCache.get(imageUrl);
      if (cached) {
        if (alive) setRaster(cached);
        return;
      }
      let job = svgRasterInFlight.get(imageUrl);
      if (!job) {
        job = rasterizeSvgOnce(imageUrl);
        svgRasterInFlight.set(imageUrl, job);
      }
      void job.then((u) => {
        svgRasterInFlight.delete(imageUrl);
        if (u) svgRasterCache.set(imageUrl, u);
        if (alive && u) setRaster(u);
      });
    };

    if (svgInlineCache.has(imageUrl)) {
      if (svgInlineCache.get(imageUrl) === null) startRaster();
      return;
    }
    let job = svgInlineInFlight.get(imageUrl);
    if (!job) {
      job = svgTextFromUrl(imageUrl).then((text) => (text ? sanitizeSvgForInline(text) : null));
      svgInlineInFlight.set(imageUrl, job);
    }
    void job.then((markup) => {
      svgInlineInFlight.delete(imageUrl);
      svgInlineCache.set(imageUrl, markup);
      if (!alive) return;
      if (markup) setInline(markup);
      else startRaster();
    });
    return () => {
      alive = false;
    };
  }, [imageUrl]);
  return { inline, raster };
}

// The made-up architectural schematic below is a LOCAL-PROTOTYPE-ONLY fallback. In the deployed
// app (VITE_DEV_MODE=false) there's no real backend tier, so `isFacilioApiConfigured` is false —
// which used to fall straight through to the schematic and paint a fake floorplan under real
// markers on every refresh/switch. Gate on dev mode too so the deployed app shows a blank sheet
// (and the shimmer covers loading), never the dummy.
const isDevMode = import.meta.env.VITE_DEV_MODE === 'true';

/**
 * The original prototype used a rendered raster floorplan image as a static background.
 * That asset isn't available to this rebuild, so this draws a clean, resolution-independent
 * architectural schematic instead — crisper at any zoom level than a raster would be, and it
 * roughly follows the seeded desk/room layout so context still lines up with the overlays.
 *
 * The schematic is a MOCK-TIER-ONLY fallback: against the real backend it read as
 * real-but-wrong data (a made-up building drawn under real markers), so there it's replaced by
 * a plain blank sheet — the real image renders when it exists, and while it's being fetched the
 * stage shows the shimmer skeleton instead of this component entirely (see MapStage).
 *
 * NOTE: the zoom-tier CAD re-render (2×/3× upgrades swapped in on zoom) was REMOVED on request —
 * repeated framing drift between render passes kept sliding the drawing under the markers, so
 * the plan now always renders from the single base raster (one framing, nothing to misalign).
 * The `zoom` prop is accepted-and-ignored so call sites stay stable if this returns.
 */
export function FloorplanBackground({ imageUrl }: { imageUrl?: string; zoom?: number }) {
  // Hybrid resolve for SVG sources (see top of file); until either path is ready the raw SVG
  // shows in the SAME box, so the swap never shifts framing. Raster sources pass through.
  const { inline, raster } = useSvgPlan(imageUrl);
  if (imageUrl && inline) {
    return (
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: IMG_W,
          height: IMG_H,
          background: '#fff',
          boxShadow: 'var(--shadow-md)',
          pointerEvents: 'none',
        }}
        dangerouslySetInnerHTML={{ __html: inline }}
      />
    );
  }
  if (imageUrl) {
    return (
      <img
        src={raster ?? imageUrl}
        draggable={false}
        // contain, not cover: uploads rarely match the frame's 1492×1054 aspect, and cover
        // silently crops the overflow (a squarer plan lost its top and bottom). Letterbox on
        // white instead — nothing is cut.
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: IMG_W,
          height: IMG_H,
          boxShadow: 'var(--shadow-md)',
          pointerEvents: 'none',
          objectFit: 'contain',
          background: '#fff',
        }}
      />
    );
  }
  // Real backend OR deployed app: a missing image is a blank sheet, never the mock schematic.
  if (isFacilioApiConfigured || !isDevMode) {
    return (
      <div
        style={{ position: 'absolute', left: 0, top: 0, width: IMG_W, height: IMG_H, background: '#fff', boxShadow: 'var(--shadow-md)', pointerEvents: 'none' }}
      />
    );
  }
  const px = (f: number) => f * IMG_W;
  const py = (f: number) => f * IMG_H;

  const pods = [
    { x: [0.05, 0.155], y: [0.08, 0.24] },
    { x: [0.285, 0.39], y: [0.08, 0.24] },
    { x: [0.625, 0.74], y: [0.09, 0.21] },
    { x: [0.805, 0.96], y: [0.75, 0.9] },
    { x: [0.665, 0.74], y: [0.75, 0.9] },
    { x: [0.04, 0.11], y: [0.75, 0.9] },
  ];
  const corridor = { x: [0.03, 0.185], y: [0.31, 0.38] };
  const parkingArea = { x: [0.405, 0.535], y: [0.56, 0.7] };

  return (
    <svg
      width={IMG_W}
      height={IMG_H}
      viewBox={`0 0 ${IMG_W} ${IMG_H}`}
      style={{ position: 'absolute', left: 0, top: 0, boxShadow: 'var(--shadow-md)', pointerEvents: 'none' }}
    >
      <rect x={0} y={0} width={IMG_W} height={IMG_H} fill="#F5F7FA" />
      {/* outer building shell */}
      <rect x={px(0.015)} y={py(0.02)} width={px(0.97)} height={py(0.96)} fill="none" stroke="var(--ink-300)" strokeWidth={4} />
      <rect x={px(0.02)} y={py(0.025)} width={px(0.96)} height={py(0.95)} fill="none" stroke="var(--ink-200)" strokeWidth={1.5} />

      {/* corridor spine */}
      <rect x={px(corridor.x[0])} y={py(corridor.y[0])} width={px(corridor.x[1] - corridor.x[0])} height={py(corridor.y[1] - corridor.y[0])} fill="#EDF1F7" stroke="var(--ink-200)" strokeWidth={2} />

      {/* office pods */}
      {pods.map((p, i) => (
        <rect
          key={i}
          x={px(p.x[0])}
          y={py(p.y[0])}
          width={px(p.x[1] - p.x[0])}
          height={py(p.y[1] - p.y[0])}
          fill="#fff"
          stroke="var(--ink-300)"
          strokeWidth={3}
        />
      ))}

      {/* parking area outline */}
      <rect
        x={px(parkingArea.x[0])}
        y={py(parkingArea.y[0])}
        width={px(parkingArea.x[1] - parkingArea.x[0])}
        height={py(parkingArea.y[1] - parkingArea.y[0])}
        fill="#EEF0F3"
        stroke="var(--ink-300)"
        strokeWidth={2}
        strokeDasharray="10 6"
      />

      {/* meeting-room wall outlines (fills are drawn separately as interactive overlays) */}
      <rect x={px(0.492)} y={py(0.735)} width={px(0.126)} height={py(0.22)} fill="none" stroke="var(--ink-300)" strokeWidth={3} />
      <rect x={px(0.148)} y={py(0.7)} width={px(0.237)} height={py(0.255)} fill="none" stroke="var(--ink-300)" strokeWidth={3} />
      <rect x={px(0.033)} y={py(0.36)} width={px(0.122)} height={py(0.08)} fill="none" stroke="var(--ink-300)" strokeWidth={3} />

      {/* compass */}
      <g transform={`translate(${px(0.94)}, ${py(0.06)})`} opacity={0.55}>
        <circle r={22} fill="#fff" stroke="var(--ink-300)" strokeWidth={1.5} />
        <path d="M0,-16 L6,8 L0,3 L-6,8 Z" fill="var(--ink-500)" />
        <text x={0} y={-26} textAnchor="middle" fontSize={11} fill="var(--ink-500)" fontFamily="var(--font-sans)">
          N
        </text>
      </g>
    </svg>
  );
}
