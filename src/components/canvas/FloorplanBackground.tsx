import { useEffect, useRef, useState } from 'react';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { useFloorplan } from '../../state/FloorplanContext';
import { getCachedCadFile } from '../../lib/facilioApiDataSource';
import { renderCadToDataUrl } from '../../lib/cadPreview';

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
 */
/**
 * CAD-backed plans rasterize ONCE at the plan's base size (1492×1054) — crisp at fit zoom but
 * visibly pixelated once zoomed in. When this session still holds the floor's original DWG/DXF
 * (getCachedCadFile), crossing a zoom tier re-renders the VECTOR source at 2×/3× (debounced
 * until the gesture settles) and swaps the sharper raster in. Tiers only ever upgrade — a
 * higher-res image downscales fine at low zoom — and results cache per floor+plan+tier so each
 * renders at most once a session. The cache is size-capped: a 3× PNG data URL is tens of MB.
 */
const tierForZoom = (z: number) => (z >= 2.2 ? 3 : z >= 1.15 ? 2 : 1);
const CAD_TIER_CACHE_MAX = 4;
const cadTierCache = new Map<string, string>();
const cadTierInFlight = new Set<string>();

/**
 * Decode an image OFF-DOM before it's ever shown. Swapping a multi-MB data URL straight into a
 * mounted <img> blanks the plan to white while the browser decodes it — priming the decode here
 * means the later paint lands in a single already-decoded frame.
 */
async function preloadDecode(url: string): Promise<void> {
  try {
    const img = new Image();
    img.src = url;
    if (img.decode) await img.decode();
    else
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
  } catch {
    // decode() rejecting is non-fatal — the in-DOM onLoad fade still gates visibility.
  }
}

/** The hi-res tier URL for the CURRENT plan+base image, or undefined while only the base exists. */
function useCadZoomUpgrade(imageUrl: string | undefined, zoom: number | undefined): string | undefined {
  const { state } = useFloorplan();
  const planKey = `${state.floorId}:${state.planId}`;
  // `forUrl` ties the upgrade to the base raster it sharpens — a re-uploaded plan changes the
  // base image, which must immediately invalidate any hi-res tier of the OLD drawing.
  const [hiRes, setHiRes] = useState<{ planKey: string; tier: number; url: string; forUrl: string } | null>(null);
  // The render outlives debounce cleanups (it takes seconds) — apply its result iff the
  // component is still mounted and still showing the same floor+plan.
  const liveRef = useRef({ planKey, mounted: true });
  liveRef.current.planKey = planKey;
  useEffect(() => {
    liveRef.current.mounted = true;
    return () => {
      liveRef.current.mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!imageUrl || !zoom) return;
    const tier = tierForZoom(zoom);
    if (tier <= 1) return; // base raster is already right for this zoom
    if (hiRes && hiRes.planKey === planKey && hiRes.forUrl === imageUrl && hiRes.tier >= tier) return;
    const file = getCachedCadFile(state.floorId, state.planId);
    if (!file) return; // not a CAD-backed plan (or the source wasn't fetched this session)
    // File size in the key: a re-uploaded plan for the same floor must not serve stale tiers.
    const key = `${planKey}:${file.size}:${tier}`;
    const timer = setTimeout(async () => {
      const apply = async (url: string) => {
        // Decode BEFORE the state swap — see preloadDecode. Never blank the visible plan.
        await preloadDecode(url);
        if (liveRef.current.mounted && liveRef.current.planKey === planKey) setHiRes({ planKey, tier, url, forUrl: imageUrl });
      };
      const cached = cadTierCache.get(key);
      if (cached) return void (await apply(cached));
      if (cadTierInFlight.has(key)) return; // the in-flight starter applies it on completion
      cadTierInFlight.add(key);
      try {
        const url = await renderCadToDataUrl(file, tier);
        while (cadTierCache.size >= CAD_TIER_CACHE_MAX) cadTierCache.delete(cadTierCache.keys().next().value!);
        cadTierCache.set(key, url);
        await apply(url);
      } catch {
        // keep showing the base raster — the upgrade is strictly best-effort
      } finally {
        cadTierInFlight.delete(key);
      }
    }, 400); // let the zoom gesture settle before burning seconds on a render
    return () => clearTimeout(timer);
  }, [imageUrl, zoom, planKey, hiRes, state.floorId, state.planId]);

  return hiRes && hiRes.planKey === planKey && hiRes.forUrl === imageUrl ? hiRes.url : undefined;
}

// Shared geometry for both raster layers — contain, not cover: uploads rarely match the frame's
// 1492×1054 aspect, and cover silently crops the overflow (a squarer plan lost its top and
// bottom). Letterbox on white instead — nothing is cut.
const RASTER_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: IMG_W,
  height: IMG_H,
  pointerEvents: 'none',
  objectFit: 'contain',
} as const;

export function FloorplanBackground({ imageUrl, zoom }: { imageUrl?: string; zoom?: number }) {
  const hiResUrl = useCadZoomUpgrade(imageUrl, zoom);
  // The overlay stays invisible until ITS OWN onLoad fires — combined with the off-DOM
  // pre-decode, the base raster is never removed or blanked during a tier swap: the sharper
  // image simply fades in ON TOP of the one already showing.
  const [overlayReady, setOverlayReady] = useState(false);
  useEffect(() => {
    if (!hiResUrl) setOverlayReady(false);
  }, [hiResUrl]);
  if (imageUrl) {
    return (
      <>
        <img src={imageUrl} draggable={false} style={{ ...RASTER_STYLE, boxShadow: 'var(--shadow-md)', background: '#fff' }} />
        {hiResUrl && hiResUrl !== imageUrl && (
          <img
            src={hiResUrl}
            draggable={false}
            onLoad={() => setOverlayReady(true)}
            style={{ ...RASTER_STYLE, background: 'transparent', opacity: overlayReady ? 1 : 0, transition: 'opacity 160ms ease' }}
          />
        )}
      </>
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
