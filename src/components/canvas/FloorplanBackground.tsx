import { IMG_H, IMG_W } from '../../lib/mockData';
import { isFacilioApiConfigured } from '../../lib/facilioApi';

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
export function FloorplanBackground({ imageUrl }: { imageUrl?: string }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        draggable={false}
        // contain, not cover: uploads rarely match the frame's 1492×1054
        // aspect, and cover silently crops the overflow (a squarer plan lost
        // its top and bottom). Letterbox on white instead — nothing is cut.
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
