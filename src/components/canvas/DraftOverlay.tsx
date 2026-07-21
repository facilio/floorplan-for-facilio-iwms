import { IMG_H, IMG_W } from '../../lib/mockData';

interface DraftOverlayProps {
  draft: [number, number][];
  calib: [number, number][];
}

export function DraftOverlay({ draft, calib }: DraftOverlayProps) {
  if (!draft.length && !calib.length) return null;
  const toPx = ([x, y]: [number, number]) => [x * IMG_W, y * IMG_H] as const;

  return (
    <svg
      width={IMG_W}
      height={IMG_H}
      viewBox={`0 0 ${IMG_W} ${IMG_H}`}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 3 }}
    >
      {draft.length >= 2 && (
        <polyline points={draft.map((p) => toPx(p).join(',')).join(' ')} fill="none" stroke="#5E3ED3" strokeWidth={2} strokeDasharray="6 4" />
      )}
      {draft.length >= 3 && (
        <polygon points={draft.map((p) => toPx(p).join(',')).join(' ')} fill="rgba(94,62,211,0.12)" stroke="none" />
      )}
      {draft.map((p, i) => {
        const [x, y] = toPx(p);
        return <circle key={i} cx={x} cy={y} r={5} fill="#5E3ED3" stroke="#fff" strokeWidth={1.5} />;
      })}
      {calib.length > 0 &&
        calib.map((p, i) => {
          const [x, y] = toPx(p);
          return <circle key={i} cx={x} cy={y} r={5} fill="#B61919" stroke="#fff" strokeWidth={1.5} />;
        })}
      {calib.length === 2 && (
        <line x1={toPx(calib[0])[0]} y1={toPx(calib[0])[1]} x2={toPx(calib[1])[0]} y2={toPx(calib[1])[1]} stroke="#B61919" strokeWidth={2} strokeDasharray="6 4" />
      )}
    </svg>
  );
}
