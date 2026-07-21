import type { UnitType } from './types';
import { cadCanvasToLightSnapshot, cadWorkerUrls } from './cadPreview';

/**
 * Opens a DWG/DXF once and produces BOTH the rendered preview snapshot and
 * the drawing's mappable structure for the auto-map flow: block inserts,
 * circles, and closed polylines, grouped by layer (+ block name), with every
 * coordinate already converted through the SAME camera used for the snapshot
 * (view.worldToScreen ÷ canvas size) — so a normalized point/polygon lands on
 * the rendered image exactly where the entity is drawn.
 */

export interface CadItem {
  /** Normalized (0-1 of the snapshot) point — inserts, circles, poly centroids. */
  point?: [number, number];
  /** Normalized closed polygon — LWPOLYLINE/POLYLINE vertices. */
  poly?: [number, number][];
}

export type CadGroupKind = 'block' | 'circle' | 'polyline';

export interface CadGroup {
  key: string;
  /** Layer the entities live on. */
  layer: string;
  /** Block name for insert groups. */
  blockName?: string;
  kind: CadGroupKind;
  /** 'point' groups can become desks/lockers/parking; 'poly' groups can also become rooms. */
  geometry: 'point' | 'poly';
  count: number;
  truncated: boolean;
  suggested: UnitType | 'ignore';
  items: CadItem[];
}

export interface CadAnalysis {
  previewUrl: string;
  groups: CadGroup[];
}

const MAX_ITEMS_PER_GROUP = 1000;
const MAX_POLY_VERTICES = 96;

/** Name-based module suggestion — matched against `layer` + block name. */
export function suggestUnitType(name: string): UnitType | 'ignore' {
  const n = name.toLowerCase();
  if (/desk|workstation|work[-_ ]?st|chair|seat|\bws\b|furn/.test(n)) return 'workstation';
  if (/lock/.test(n)) return 'locker';
  if (/park|stall|\bcar\b|garage|vehicle/.test(n)) return 'parking';
  if (/room|meet|conf|office|zone|space|cabin|hall/.test(n)) return 'room';
  return 'ignore';
}

interface WorldPoint {
  x: number;
  y: number;
}

export async function analyzeCadFile(file: File): Promise<CadAnalysis> {
  const mod = await import('@mlightcad/cad-simple-viewer');
  const { AcApDocManager, AcApOpenViewMode } = mod;

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  const CANVAS_W = 1492;
  const CANVAS_H = 1054;
  container.style.width = `${CANVAS_W}px`;
  container.style.height = `${CANVAS_H}px`;
  document.body.appendChild(container);

  try {
    const manager = AcApDocManager.createInstance({
      container,
      width: CANVAS_W,
      height: CANVAS_H,
      notLoadDefaultFonts: true,
      webworkerFileUrls: cadWorkerUrls(),
    });
    if (!manager) throw new Error('CAD viewer failed to initialize');

    const buffer = await file.arrayBuffer();
    const ok = await manager.openDocument(file.name, buffer, { openViewMode: AcApOpenViewMode.Extents });
    if (!ok) throw new Error('Could not parse this CAD file');

    // Same settle dance as renderCadToDataUrl (see cadPreview.ts for the why).
    const deadline = Date.now() + 15000;
    while (manager.curView.isProcessingEntities && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    manager.curView.zoomToFitDrawing();
    await new Promise((r) => setTimeout(r, 1200));

    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('CAD viewer produced no canvas');
    const previewUrl = cadCanvasToLightSnapshot(canvas);

    // Snapshot taken — now enumerate model space through the same camera.
    const view = manager.curView;
    const toNorm = (pt: WorldPoint): [number, number] | null => {
      const s = view.worldToScreen({ x: pt.x, y: pt.y });
      const nx = s.x / CANVAS_W;
      const ny = s.y / CANVAS_H;
      // Entities can sit outside the fitted frame (title blocks, stray refs).
      if (nx < -0.02 || nx > 1.02 || ny < -0.02 || ny > 1.02) return null;
      return [clamp01(nx), clamp01(ny)];
    };

    const groups = collectGroups(manager.curDocument.database, toNorm);

    await manager.destroy();
    return { previewUrl, groups };
  } finally {
    container.remove();
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/* The library ships strong classes, but importing @mlightcad/data-model directly
 * would add an undeclared dependency — duck-type off dxfTypeName instead. */
interface AnyEntity {
  dxfTypeName?: string;
  layer?: string;
  position?: WorldPoint;
  center?: WorldPoint;
  closed?: boolean;
  numberOfVertices?: number;
  getPoint2dAt?: (i: number) => WorldPoint;
  blockTableRecord?: { name?: string };
}

interface AnyDatabase {
  tables: { blockTable: { modelSpace: { newIterator: () => Iterable<AnyEntity> } } };
}

function collectGroups(database: unknown, toNorm: (pt: WorldPoint) => [number, number] | null): CadGroup[] {
  const byKey = new Map<string, CadGroup>();

  const push = (
    key: string,
    seed: Omit<CadGroup, 'count' | 'truncated' | 'items' | 'suggested'>,
    item: CadItem,
  ) => {
    let group = byKey.get(key);
    if (!group) {
      group = {
        ...seed,
        count: 0,
        truncated: false,
        suggested: suggestUnitType(`${seed.layer} ${seed.blockName ?? ''}`),
        items: [],
      };
      byKey.set(key, group);
    }
    group.count += 1;
    if (group.items.length < MAX_ITEMS_PER_GROUP) group.items.push(item);
    else group.truncated = true;
  };

  const modelSpace = (database as AnyDatabase).tables.blockTable.modelSpace;
  for (const entity of modelSpace.newIterator()) {
    const type = (entity.dxfTypeName ?? '').toUpperCase();
    const layer = entity.layer ?? '0';

    if (type === 'INSERT' && entity.position) {
      const point = toNorm(entity.position);
      if (!point) continue;
      const blockName = entity.blockTableRecord?.name ?? 'block';
      push(
        `block:${layer}:${blockName}`,
        { key: `block:${layer}:${blockName}`, layer, blockName, kind: 'block', geometry: 'point' },
        { point },
      );
    } else if (type === 'CIRCLE' && entity.center) {
      const point = toNorm(entity.center);
      if (!point) continue;
      push(`circle:${layer}`, { key: `circle:${layer}`, layer, kind: 'circle', geometry: 'point' }, { point });
    } else if (
      (type === 'LWPOLYLINE' || type === 'POLYLINE') &&
      entity.closed === true &&
      typeof entity.numberOfVertices === 'number' &&
      entity.numberOfVertices >= 3 &&
      entity.getPoint2dAt
    ) {
      const pts: [number, number][] = [];
      const step = Math.max(1, Math.ceil(entity.numberOfVertices / MAX_POLY_VERTICES));
      let outside = false;
      for (let i = 0; i < entity.numberOfVertices; i += step) {
        const norm = toNorm(entity.getPoint2dAt(i));
        if (!norm) {
          outside = true;
          break;
        }
        pts.push(norm);
      }
      if (outside || pts.length < 3) continue;
      // A polygon spanning nearly the whole frame is the building outline or
      // the drawing border, not a mappable space — skip it.
      const area = polygonArea(pts);
      if (area > 0.85) continue;
      push(`poly:${layer}`, { key: `poly:${layer}`, layer, kind: 'polyline', geometry: 'poly' }, { poly: pts, point: centroid(pts) });
    }
  }

  return [...byKey.values()]
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Shoelace area in normalized units (frame = 1.0). */
function polygonArea(pts: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function centroid(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  return [x / pts.length, y / pts.length];
}
