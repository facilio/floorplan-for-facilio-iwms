import { IMG_H, IMG_W } from './mockData';
import type { PointGeom, PolyGeom, Unit, UnitGeom } from './types';

export interface ViewTransform {
  tx: number;
  ty: number;
  z: number;
}

/** Overlay chrome (floating panels, mode switcher, bottom nav) eating into the stage. */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function fitView(rectW: number, rectH: number, insets?: Partial<ViewInsets>): ViewTransform {
  const l = insets?.left ?? 0;
  const r = insets?.right ?? 0;
  const t = insets?.top ?? 0;
  const b = insets?.bottom ?? 0;
  const availW = Math.max(120, rectW - l - r);
  const availH = Math.max(120, rectH - t - b);
  const z = Math.min(availW / IMG_W, availH / IMG_H) * 0.96;
  return { z, tx: l + (availW - IMG_W * z) / 2, ty: t + (availH - IMG_H * z) / 2 };
}

export function zoomAt(view: ViewTransform, factor: number, cx: number, cy: number): ViewTransform {
  const z = clamp(view.z * factor, 0.08, 6);
  const k = z / view.z;
  return { z, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Screen client coords -> normalized (0-1) plan coords, given the canvas rect and view transform. */
export function toNorm(clientX: number, clientY: number, rect: DOMRect, view: ViewTransform) {
  return {
    x: (clientX - rect.left - view.tx) / view.z / IMG_W,
    y: (clientY - rect.top - view.ty) / view.z / IMG_H,
  };
}

export function unitCenter(u: Pick<Unit, 'geom'>): { cx: number; cy: number; span: number } {
  if (u.geom.kind === 'point') {
    return { cx: u.geom.x, cy: u.geom.y, span: 0.06 };
  }
  const pts = u.geom.pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, span: Math.max(maxX - minX, maxY - minY, 0.08) };
}

/** View transform that centers+zooms on a unit, per the original focusUnit() formula. */
export function focusUnitView(
  u: Pick<Unit, 'geom'>,
  rectW: number,
  rectH: number,
  currentZ: number,
  insets?: Partial<ViewInsets>,
): ViewTransform {
  const { cx, cy, span } = unitCenter(u);
  const l = insets?.left ?? 0;
  const r = insets?.right ?? 0;
  const t = insets?.top ?? 0;
  const b = insets?.bottom ?? 0;
  const centerX = l + (rectW - l - r) / 2;
  const centerY = t + (rectH - t - b) / 2;
  let z: number;
  if (u.geom.kind === 'point') {
    z = clamp(Math.max(currentZ, 1.25), 1.25, 2.4);
  } else {
    z = clamp(Math.min(2.4, (Math.min(rectW, rectH) * 0.7) / (span * IMG_W)), 0.6, 2.4);
  }
  return { z, tx: centerX - cx * IMG_W * z, ty: centerY - cy * IMG_H * z };
}

export function clipPathFor(geom: PolyGeom): string {
  return `polygon(${geom.pts.map(([x, y]) => `${(x * 100).toFixed(3)}% ${(y * 100).toFixed(3)}%`).join(', ')})`;
}

export function polygonCentroid(pts: [number, number][]): { x: number; y: number } {
  const n = pts.length;
  const x = pts.reduce((s, p) => s + p[0], 0) / n;
  const y = pts.reduce((s, p) => s + p[1], 0) / n;
  return { x, y };
}

/** Shoelace formula in pixel space, divided by px-per-meter squared. Null if uncalibrated. */
export function polyAreaM2(pts: [number, number][], pxPerMeter: number | null): number | null {
  if (!pxPerMeter) return null;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[(i + 1) % pts.length];
    a += (xj * IMG_W + xi * IMG_W) * (yj * IMG_H - yi * IMG_H);
  }
  return Math.abs(a / 2) / (pxPerMeter * pxPerMeter);
}

export function distNormToPx(a: [number, number], b: [number, number], z: number): number {
  return Math.hypot((b[0] - a[0]) * IMG_W, (b[1] - a[1]) * IMG_H) * z;
}

export function calibratedPxPerMeter(a: [number, number], b: [number, number], meters: number): number {
  const distPx = Math.hypot((b[0] - a[0]) * IMG_W, (b[1] - a[1]) * IMG_H);
  return distPx / meters;
}

export function pointInPoly(pt: { x: number; y: number }, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointGeom(g: UnitGeom): g is PointGeom {
  return g.kind === 'point';
}
export function isPolyGeom(g: UnitGeom): g is PolyGeom {
  return g.kind === 'poly';
}

/** Natural sort (numeric-aware) — "WS-2" sorts before "WS-10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

const TYPE_RANK: Record<Unit['type'], number> = { workstation: 0, room: 1, locker: 2, parking: 3, amenity: 4 };
export function unitSortCompare(a: Unit, b: Unit): number {
  const r = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (r !== 0) return r;
  return naturalCompare(a.label, b.label);
}

export function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface TooltipPlacement {
  sx: number;
  sy: number;
  below: boolean;
  transform: string;
}

export function tooltipPlacement(cx: number, cy: number, view: ViewTransform): TooltipPlacement {
  const sx = view.tx + cx * IMG_W * view.z;
  const sy = view.ty + cy * IMG_H * view.z;
  const below = sy < 180;
  return {
    sx,
    sy,
    below,
    transform: below ? 'translate(-50%, 20px)' : 'translate(-50%, calc(-100% - 20px))',
  };
}

export interface PanelBox {
  x: number;
  y: number;
}

export function defaultPanelPos(id: 'location' | 'details', stageW: number): PanelBox {
  if (id === 'location') return { x: 16, y: 16 };
  return { x: Math.max(16, stageW - 320), y: 16 };
}

export function clampPanelPos(x: number, y: number, w: number, stageW: number, stageH: number): PanelBox {
  return {
    x: clamp(x, 4, Math.max(4, stageW - w - 4)),
    y: clamp(y, 4, Math.max(4, stageH - 60)),
  };
}
