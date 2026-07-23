import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { clamp, polyAreaM2, polygonCentroid, toNorm, unitCenter } from '../../lib/geometry';
import { myAssignedUnit } from '../../state/selectors';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { FloorplanBackground } from './FloorplanBackground';
import { RoomPolygon } from './RoomPolygon';
import { Marker } from './Marker';
import { DraftOverlay } from './DraftOverlay';
import { Legend } from './Legend';
import { ZoomControls } from './ZoomControls';
import { Tooltip } from './Tooltip';
import { floorImageKey } from '../../lib/types';
import type { PolyGeom, Unit, UnitGeom } from '../../lib/types';
import styles from './Canvas.module.css';

const DRAW_TOOLS = new Set(['room', 'workstation', 'locker', 'parking', 'amenity', 'calibrate']);

/**
 * Live edit-gesture preview, applied to rendering only — the store commits
 * once, on mouseup (matching the existing marker-drag pattern):
 *  - room:   whole-polygon drag of one room
 *  - vertex: reshaping one vertex of the selected room
 *  - group:  marquee multi-select moved as a whole
 */
type EditPreview =
  | { kind: 'room'; id: string; dx: number; dy: number }
  | { kind: 'vertex'; id: string; pts: [number, number][] }
  | { kind: 'group'; dx: number; dy: number }
  | null;

function translateGeom(geom: UnitGeom, dx: number, dy: number): UnitGeom {
  if (geom.kind === 'point') {
    return { kind: 'point', x: clamp(geom.x + dx, 0, 1), y: clamp(geom.y + dy, 0, 1) };
  }
  return { kind: 'poly', pts: geom.pts.map(([x, y]) => [clamp(x + dx, 0, 1), clamp(y + dy, 0, 1)] as [number, number]) };
}

export function Canvas() {
  const { state, actions } = useFloorplan();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState({ w: 1200, h: 700 });
  const panRef = useRef<{ sx: number; sy: number; otx: number; oty: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const dragUnitIdRef = useRef<string | null>(null);
  const lastDragClientRef = useRef<{ x: number; y: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editPreview, setEditPreview] = useState<EditPreview>(null);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Write-through mirrors of the gesture-preview state, updated in the SAME tick as the
  // mousemove (not on render): the mouseup handlers read these and dispatch to the store
  // AFTER clearing the local preview. Dispatching from inside a setState updater is a
  // React render-phase violation ("cannot update FloorplanProvider while rendering
  // Canvas"), and reading render-synced mirrors would drop a gesture whose final
  // mousemove and mouseup land in the same frame.
  const dragPreviewRef = useRef<typeof dragPreview>(null);
  const editPreviewRef = useRef<EditPreview>(null);
  const marqueeRef = useRef<typeof marquee>(null);
  const updateDragPreview = (p: typeof dragPreview) => {
    dragPreviewRef.current = p;
    setDragPreview(p);
  };
  const updateEditPreview = (p: EditPreview) => {
    editPreviewRef.current = p;
    setEditPreview(p);
  };
  const updateMarquee = (m: typeof marquee) => {
    marqueeRef.current = m;
    setMarquee(m);
  };
  // Multi-selection lives in app state (the Edit panel's inspector reads it); keep a Set view
  // locally for the O(1) membership checks the render path does per marker.
  const multiSel = useMemo(() => new Set(state.multiSelected), [state.multiSelected]);
  const setMultiSel = (ids: Set<string>) => actions.setMultiSelected([...ids]);
  const gestureRef = useRef<{
    kind: 'room' | 'group' | 'vertex' | 'marquee';
    id?: string;
    vertexIndex?: number;
    sx: number;
    sy: number;
    origPts?: [number, number][];
  } | null>(null);
  const userZoomedRef = useRef(state.userZoomed);
  userZoomedRef.current = state.userZoomed;

  const isDrawTool = state.mode === 'edit' && DRAW_TOOLS.has(state.tool);
  const isEditSelect = state.mode === 'edit' && state.tool === 'select';

  // The reducer drops multi-selection on floor/mode/tool switches; the live gesture
  // preview is render-local, so clear that here.
  useEffect(() => {
    updateEditPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.floorId, state.planId, state.mode, state.tool]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width < 20) return;
      setRect({ w: r.width, h: r.height });
      actions.setStageSize(r.width, r.height);
      if (!userZoomedRef.current) actions.fitView(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.floorId, state.planId]);

  // Panels float OVER the canvas, so opening/closing one never fires the
  // ResizeObserver — re-fit explicitly so the plan re-centers in the visible
  // gap (fitView accounts for panel insets) unless the user has taken over.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || userZoomedRef.current) return;
    const r = el.getBoundingClientRect();
    if (r.width > 20) actions.fitView(r.width, r.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.panels.portfolio.open, state.panels.details.open]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = el!.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      actions.zoomAtPoint(factor, e.clientX - r.left, e.clientY - r.top);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (state.draft.length || state.calib.length) {
          actions.clearDraft();
          actions.clearCalib();
        } else if (multiSel.size > 0) {
          setMultiSel(new Set());
        } else {
          actions.selectUnit(null);
          actions.setTool('select');
        }
      } else if (e.key === 'Enter') {
        if (state.mode === 'edit' && state.tool === 'room' && state.draft.length >= 3) actions.closeDraft();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.mode !== 'edit') return;
        if (multiSel.size > 0) {
          actions.deleteUnits([...multiSel]);
        } else if (state.selected) {
          actions.deleteUnit(state.selected);
        }
      } else if ((e.key === 'v' || e.key === 'V') && state.mode === 'edit') {
        actions.setTool('select');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.draft, state.calib, state.mode, state.tool, state.selected, multiSel]);

  /** client-px → normalized delta relative to the gesture start. */
  function normDelta(e: MouseEvent) {
    const g = gestureRef.current!;
    return {
      dx: (e.clientX - g.sx) / state.view.z / IMG_W,
      dy: (e.clientY - g.sy) / state.view.z / IMG_H,
    };
  }

  function onMouseDown(e: ReactMouseEvent) {
    if (isDrawTool) return;
    if (e.button !== 0) return;
    if (isEditSelect && e.shiftKey) {
      // Shift+drag = marquee multi-select (plain drag stays panning).
      const r = wrapRef.current!.getBoundingClientRect();
      gestureRef.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY };
      updateMarquee({ x1: e.clientX - r.left, y1: e.clientY - r.top, x2: e.clientX - r.left, y2: e.clientY - r.top });
      window.addEventListener('mousemove', onMarqueeMove);
      window.addEventListener('mouseup', onMarqueeUp);
      e.preventDefault();
      return;
    }
    panRef.current = { sx: e.clientX, sy: e.clientY, otx: state.view.tx, oty: state.view.ty, moved: false };
    window.addEventListener('mousemove', onPanMove);
    window.addEventListener('mouseup', onPanUp);
  }
  function onPanMove(e: MouseEvent) {
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) p.moved = true;
    actions.setView({ ...state.view, tx: p.otx + dx, ty: p.oty + dy });
  }
  function onPanUp() {
    window.removeEventListener('mousemove', onPanMove);
    window.removeEventListener('mouseup', onPanUp);
    if (panRef.current?.moved) {
      suppressClickRef.current = true;
      setTimeout(() => (suppressClickRef.current = false), 0);
    }
    panRef.current = null;
  }

  function onMarqueeMove(e: MouseEvent) {
    const r = wrapRef.current!.getBoundingClientRect();
    const m = marqueeRef.current;
    if (m) updateMarquee({ ...m, x2: e.clientX - r.left, y2: e.clientY - r.top });
  }
  function onMarqueeUp(e: MouseEvent) {
    window.removeEventListener('mousemove', onMarqueeMove);
    window.removeEventListener('mouseup', onMarqueeUp);
    gestureRef.current = null;
    suppressClickRef.current = true;
    setTimeout(() => (suppressClickRef.current = false), 0);
    const r = wrapRef.current!.getBoundingClientRect();
    const m = marqueeRef.current;
    updateMarquee(null);
    if (m) {
      const a = toNorm(Math.min(m.x1, m.x2) + r.left, Math.min(m.y1, m.y2) + r.top, r, state.view);
      const b = toNorm(Math.max(m.x1, m.x2) + r.left, Math.max(m.y1, m.y2) + r.top, r, state.view);
      const hits = state.units
        // Mirror the render filter below (amenities show on every plan; unplaced never drawn) —
        // the marquee must be able to catch exactly what's visible, nothing more.
        .filter((u) => (u.type === 'room' && u.geom.kind === 'poly') || (u.type !== 'room' && !u.unplaced && (u.type === 'amenity' || u.plan === state.planId)))
        .filter((u) => {
          const { cx, cy } = unitCenter(u);
          return cx >= a.x && cx <= b.x && cy >= a.y && cy <= b.y;
        })
        .map((u) => u.id);
      setMultiSel(new Set(hits));
      if (hits.length > 0) actions.selectUnit(null);
    }
    void e;
  }

  /** Reposition an already-placed desk/locker/parking-stall by dragging it — Select tool, edit mode only. */
  function startMarkerDrag(unit: Unit, e: ReactMouseEvent) {
    if (!isEditSelect) return;
    e.stopPropagation();
    e.preventDefault();
    if (multiSel.size > 1 && multiSel.has(unit.id)) {
      startGroupDrag(e);
      return;
    }
    actions.selectUnit(unit.id);
    dragUnitIdRef.current = unit.id;
    window.addEventListener('mousemove', onMarkerDragMove);
    window.addEventListener('mouseup', onMarkerDragUp);
  }
  function onMarkerDragMove(e: MouseEvent) {
    const id = dragUnitIdRef.current;
    const el = wrapRef.current;
    if (!id || !el) return;
    const r = el.getBoundingClientRect();
    const n = toNorm(e.clientX, e.clientY, r, state.view);
    lastDragClientRef.current = { x: e.clientX, y: e.clientY };
    updateDragPreview({ id, x: clamp(n.x, 0, 1), y: clamp(n.y, 0, 1) });
  }
  /** Nearest placed same-type point marker within `px` screen pixels of a client position. */
  function sameTypeMarkerNear(clientX: number, clientY: number, dragged: Unit, px = 18): Unit | null {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let best: Unit | null = null;
    let bestDist = px;
    for (const u of state.units) {
      if (u.id === dragged.id || u.type !== dragged.type || u.geom.kind !== 'point') continue;
      const sx = r.left + state.view.tx + u.geom.x * IMG_W * state.view.z;
      const sy = r.top + state.view.ty + u.geom.y * IMG_H * state.view.z;
      const dist = Math.hypot(sx - clientX, sy - clientY);
      if (dist < bestDist) {
        bestDist = dist;
        best = u;
      }
    }
    return best;
  }
  function onMarkerDragUp() {
    window.removeEventListener('mousemove', onMarkerDragMove);
    window.removeEventListener('mouseup', onMarkerDragUp);
    const last = lastDragClientRef.current;
    lastDragClientRef.current = null;
    dragUnitIdRef.current = null;
    const preview = dragPreviewRef.current;
    updateDragPreview(null);
    if (preview) {
      // Released right on top of another marker of the same type → take over that spot
      // (its record moves to "Available to place") instead of stacking two markers.
      const dragged = state.units.find((u) => u.id === preview.id);
      const target = last && dragged ? sameTypeMarkerNear(last.x, last.y, dragged) : null;
      if (target) actions.placeUnitOnUnit(preview.id, target.id);
      else actions.updateUnit(preview.id, { geom: { kind: 'point', x: preview.x, y: preview.y } });
    }
  }

  /** Whole-room drag (edit + select): translate every vertex, commit on release. */
  function startRoomDrag(unit: Unit, e: ReactMouseEvent) {
    if (!isEditSelect || unit.geom.kind !== 'poly') return;
    e.stopPropagation();
    e.preventDefault();
    if (multiSel.size > 1 && multiSel.has(unit.id)) {
      startGroupDrag(e);
      return;
    }
    actions.selectUnit(unit.id);
    gestureRef.current = { kind: 'room', id: unit.id, sx: e.clientX, sy: e.clientY };
    window.addEventListener('mousemove', onRoomDragMove);
    window.addEventListener('mouseup', onRoomDragUp);
  }
  function onRoomDragMove(e: MouseEvent) {
    const g = gestureRef.current;
    if (!g || g.kind !== 'room') return;
    const { dx, dy } = normDelta(e);
    updateEditPreview({ kind: 'room', id: g.id!, dx, dy });
  }
  function onRoomDragUp() {
    window.removeEventListener('mousemove', onRoomDragMove);
    window.removeEventListener('mouseup', onRoomDragUp);
    gestureRef.current = null;
    suppressClickRef.current = true;
    setTimeout(() => (suppressClickRef.current = false), 0);
    const p = editPreviewRef.current;
    updateEditPreview(null);
    if (p?.kind === 'room') {
      const unit = state.units.find((u) => u.id === p.id);
      if (unit && (p.dx !== 0 || p.dy !== 0)) actions.updateUnit(p.id, { geom: translateGeom(unit.geom, p.dx, p.dy) });
    }
  }

  /** Marquee selection moved as one — commits a single bulk update. */
  function startGroupDrag(e: ReactMouseEvent) {
    gestureRef.current = { kind: 'group', sx: e.clientX, sy: e.clientY };
    window.addEventListener('mousemove', onGroupDragMove);
    window.addEventListener('mouseup', onGroupDragUp);
  }
  function onGroupDragMove(e: MouseEvent) {
    const g = gestureRef.current;
    if (!g || g.kind !== 'group') return;
    const { dx, dy } = normDelta(e);
    updateEditPreview({ kind: 'group', dx, dy });
  }
  function onGroupDragUp() {
    window.removeEventListener('mousemove', onGroupDragMove);
    window.removeEventListener('mouseup', onGroupDragUp);
    gestureRef.current = null;
    suppressClickRef.current = true;
    setTimeout(() => (suppressClickRef.current = false), 0);
    const p = editPreviewRef.current;
    updateEditPreview(null);
    if (p?.kind === 'group' && (p.dx !== 0 || p.dy !== 0)) {
      const updates = state.units
        .filter((u) => multiSel.has(u.id))
        .map((u) => ({ id: u.id, patch: { geom: translateGeom(u.geom, p.dx, p.dy) } }));
      if (updates.length > 0) actions.updateUnits(updates);
    }
  }

  /** Vertex reshape on the selected room's corner handles. */
  function startVertexDrag(unit: Unit, index: number, e: ReactMouseEvent) {
    if (unit.geom.kind !== 'poly') return;
    e.stopPropagation();
    e.preventDefault();
    gestureRef.current = { kind: 'vertex', id: unit.id, vertexIndex: index, sx: e.clientX, sy: e.clientY, origPts: unit.geom.pts };
    window.addEventListener('mousemove', onVertexDragMove);
    window.addEventListener('mouseup', onVertexDragUp);
  }
  function onVertexDragMove(e: MouseEvent) {
    const g = gestureRef.current;
    if (!g || g.kind !== 'vertex' || !g.origPts) return;
    const { dx, dy } = normDelta(e);
    const pts = g.origPts.map(([x, y], i) =>
      i === g.vertexIndex ? ([clamp(x + dx, 0, 1), clamp(y + dy, 0, 1)] as [number, number]) : ([x, y] as [number, number]),
    );
    updateEditPreview({ kind: 'vertex', id: g.id!, pts });
  }
  function onVertexDragUp() {
    window.removeEventListener('mousemove', onVertexDragMove);
    window.removeEventListener('mouseup', onVertexDragUp);
    gestureRef.current = null;
    suppressClickRef.current = true;
    setTimeout(() => (suppressClickRef.current = false), 0);
    const p = editPreviewRef.current;
    updateEditPreview(null);
    if (p?.kind === 'vertex') actions.updateUnit(p.id, { geom: { kind: 'poly', pts: p.pts } });
  }

  function onClick(e: ReactMouseEvent) {
    if (suppressClickRef.current) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const n = toNorm(e.clientX, e.clientY, r, state.view);

    // An armed "Available to place" record places on this click (edit mode).
    if (state.mode === 'edit' && state.placingUnitId) {
      if (n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1) return;
      actions.placeUnitAt(state.placingUnitId, n.x, n.y);
      actions.setPlacingUnit(null);
      return;
    }

    if (!isDrawTool) {
      actions.selectUnit(null);
      if (multiSel.size > 0) setMultiSel(new Set());
      return;
    }
    if (n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1) return;

    if (state.tool === 'calibrate') {
      if (state.calib.length < 2) actions.pushCalibPoint([n.x, n.y]);
      return;
    }
    if (state.tool === 'room') {
      if (actions.isNearFirstDraftPoint([n.x, n.y])) {
        actions.closeDraft();
      } else {
        actions.pushDraftPoint([n.x, n.y]);
      }
      return;
    }
    if (state.tool === 'workstation' || state.tool === 'locker' || state.tool === 'parking') {
      actions.placePoint(state.tool, n.x, n.y);
    }
    if (state.tool === 'amenity') {
      actions.placeMarker(state.markerKind, n.x, n.y);
    }
  }

  function onDblClick() {
    if (state.mode === 'edit' && state.tool === 'room' && state.draft.length >= 3) actions.closeDraft();
  }

  // Drop target for desk rows dragged from the left sidebar (SpacesList): an unplaced record
  // gets placed at the drop point, an already-placed one is repositioned. Edit mode only —
  // the rows are only draggable there, but guard anyway against synthetic drops.
  function onDragOver(e: ReactDragEvent) {
    if (
      state.mode === 'edit' &&
      (e.dataTransfer.types.includes('application/x-floorplan-unit') ||
        e.dataTransfer.types.includes('application/x-floorplan-asset') ||
        e.dataTransfer.types.includes('application/x-floorplan-marker') ||
        e.dataTransfer.types.includes('application/x-floorplan-addtool'))
    )
      e.preventDefault();
  }
  function onDrop(e: ReactDragEvent) {
    if (state.mode !== 'edit') return;
    const el = wrapRef.current;
    if (!el) return;
    const unitId = e.dataTransfer.getData('application/x-floorplan-unit');
    const assetId = e.dataTransfer.getData('application/x-floorplan-asset');
    const markerKind = e.dataTransfer.getData('application/x-floorplan-marker');
    const addType = e.dataTransfer.getData('application/x-floorplan-addtool');
    if (!unitId && !assetId && !markerKind && !addType) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const n = toNorm(e.clientX, e.clientY, r, state.view);
    if (n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1) return;
    if (assetId) actions.placeAssetAt(assetId, n.x, n.y);
    else if (markerKind) actions.placeMarker(markerKind, n.x, n.y);
    else if (addType === 'workstation' || addType === 'locker' || addType === 'parking') actions.placePoint(addType, n.x, n.y);
    else if (unitId) actions.placeUnitAt(unitId, n.x, n.y);
  }

  const invZ = (1 / state.view.z).toFixed(4);
  const planeTransition = state.viewAnim ? 'transform 340ms cubic-bezier(0.2,0,0,1)' : 'none';

  /** Rendering geometry with any live edit preview applied. */
  function previewedGeom(u: Unit): UnitGeom {
    if (editPreview?.kind === 'group' && multiSel.has(u.id)) return translateGeom(u.geom, editPreview.dx, editPreview.dy);
    if (editPreview?.kind === 'room' && editPreview.id === u.id) return translateGeom(u.geom, editPreview.dx, editPreview.dy);
    if (editPreview?.kind === 'vertex' && editPreview.id === u.id) return { kind: 'poly', pts: editPreview.pts };
    return u.geom;
  }

  // poly-guard matters: connector-tier spaces arrive without plan geometry
  // (listed in the sidebar, not drawn) — RoomPolygon would crash on them.
  // The FILTERED lists are memoized: the canvas re-renders every frame during pan/zoom
  // (SET_VIEW), and re-scanning all units per frame is pure waste — units/plan only change on
  // real edits. The previewedGeom map stays per-render (it tracks live drags by design).
  const roomUnits = useMemo(() => state.units.filter((u) => u.type === 'room' && u.geom.kind === 'poly'), [state.units]);
  const markerUnits = useMemo(
    // amenities show on every plan type; desks/lockers/parking only on theirs. `unplaced` units
    // (org records with no plan position, e.g. connector spaces) are sidebar-only, never drawn.
    () => state.units.filter((u) => u.type !== 'room' && !u.unplaced && (u.type === 'amenity' || u.plan === state.planId)),
    [state.units, state.planId]
  );
  const rooms = roomUnits.map((u) => ({ ...u, geom: previewedGeom(u) }));
  const markers = markerUnits.map((u) => ({ ...u, geom: previewedGeom(u) }));
  // One assignments scan per render, not one per marker (Marker's isMine fallback).
  const myUnitId = useMemo(() => myAssignedUnit(state)?.id ?? null, [state.assignments, state.bookBy, state.units]);

  const selectedRoom = isEditSelect && multiSel.size === 0 ? rooms.find((r) => r.id === state.selected) : undefined;

  let canvasHint = '';
  if (state.mode === 'edit') {
    if (state.placingUnitId) canvasHint = 'Click anywhere on the plan to place it · Esc to cancel';
    else if (state.tool === 'room') canvasHint = state.draft.length === 0 ? 'Click to start a room outline' : 'Click to add points · click the first point (or press Enter) to close';
    else if (state.tool === 'calibrate') canvasHint = state.calib.length === 0 ? 'Click two points a known distance apart' : state.calib.length === 1 ? 'Click the second point' : 'Enter the real-world distance in the panel';
    else if (state.tool !== 'select') canvasHint = 'Click on the plan to place it';
    else if (multiSel.size > 1) canvasHint = `${multiSel.size} selected — drag any of them to move the group · Esc to clear`;
    else if (selectedRoom) canvasHint = 'Drag the room to move it · drag a corner to reshape · Shift+drag for multi-select';
    else canvasHint = 'Drag units to move them · Shift+drag to multi-select';
  }

  return (
    <div
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDblClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={styles.wrap}
      style={{ cursor: isDrawTool || (state.mode === 'edit' && state.placingUnitId) ? 'crosshair' : 'grab' }}
    >
      <div
        className={styles.plane}
        style={{
          width: IMG_W,
          height: IMG_H,
          transform: `translate(${state.view.tx}px, ${state.view.ty}px) scale(${state.view.z})`,
          transition: planeTransition,
          ['--inv' as any]: invZ,
        }}
      >
        <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
        {rooms.map((r) => (
          <RoomPolygon key={r.id} unit={r} onEditDown={startRoomDrag} />
        ))}
        <DraftOverlay draft={state.draft} calib={state.calib} />
        {rooms.map((r) => (
          <RoomLabel key={r.id} unit={r} />
        ))}
        {markers.map((m) => (
          <Marker
            key={m.id}
            unit={dragPreview?.id === m.id ? { ...m, geom: { kind: 'point', x: dragPreview.x, y: dragPreview.y } } : m}
            invZ={Number(invZ)}
            onDragStart={startMarkerDrag}
            myUnitId={myUnitId}
          />
        ))}

        {/* multi-select outlines */}
        {multiSel.size > 0 && (
          <svg width={IMG_W} height={IMG_H} viewBox={`0 0 ${IMG_W} ${IMG_H}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {rooms
              .filter((r) => multiSel.has(r.id))
              .map((r) => (
                <polygon
                  key={r.id}
                  points={(r.geom as PolyGeom).pts.map(([x, y]) => `${x * IMG_W},${y * IMG_H}`).join(' ')}
                  fill="none"
                  stroke="var(--blue-500)"
                  strokeWidth={2 * Number(invZ)}
                  strokeDasharray={`${6 * Number(invZ)} ${4 * Number(invZ)}`}
                />
              ))}
            {markers
              .filter((m) => multiSel.has(m.id) && m.geom.kind === 'point')
              .map((m) => (
                <circle
                  key={m.id}
                  cx={(m.geom as { x: number }).x * IMG_W}
                  cy={(m.geom as { y: number }).y * IMG_H}
                  r={16 * Number(invZ)}
                  fill="none"
                  stroke="var(--blue-500)"
                  strokeWidth={2 * Number(invZ)}
                  strokeDasharray={`${5 * Number(invZ)} ${4 * Number(invZ)}`}
                />
              ))}
          </svg>
        )}

        {/* corner handles for reshaping the selected room */}
        {selectedRoom && selectedRoom.geom.kind === 'poly' && (
          <>
            {(selectedRoom.geom as PolyGeom).pts.map(([x, y], i) => (
              <div
                key={i}
                onMouseDown={(e) => startVertexDrag(state.units.find((u) => u.id === selectedRoom.id)!, i, e)}
                title="Drag to reshape"
                style={{
                  position: 'absolute',
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: '#fff',
                  border: '2.5px solid var(--blue-500)',
                  transform: 'translate(-50%,-50%) scale(var(--inv))',
                  cursor: 'grab',
                  boxShadow: '0 1px 3px rgba(16,24,40,0.3)',
                  zIndex: 5,
                }}
              />
            ))}
          </>
        )}
      </div>

      {/* marquee rectangle, drawn in stage space */}
      {marquee && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            border: '1.5px dashed var(--blue-500)',
            background: 'rgba(0,89,214,0.06)',
            pointerEvents: 'none',
            zIndex: 6,
          }}
        />
      )}

      <Tooltip />

      {canvasHint && <div className={styles.hint}>{canvasHint}</div>}

      <Legend />
      <ZoomControls rectW={rect.w} rectH={rect.h} />
    </div>
  );
}

function RoomLabel({ unit }: { unit: Unit }) {
  const { state } = useFloorplan();
  if (unit.geom.kind !== 'poly') return null;
  const geom = unit.geom as PolyGeom;
  const { x, y } = polygonCentroid(geom.pts);

  let sub = '';
  let subFg = 'var(--ink-600)';
  if (state.mode === 'edit') {
    const area = polyAreaM2(geom.pts, state.pxPerMeter);
    sub = area != null ? `${area.toFixed(0)} m²` : '';
  } else if (state.mode === 'book') {
    const conflicts = state.bookings.filter((b) => b.unitId === unit.id && b.date === state.date && b.start < state.end && b.end > state.start);
    if (conflicts.length) {
      const b = conflicts[0];
      sub = `Booked ${String(Math.floor(b.start / 60)).padStart(2, '0')}:${String(b.start % 60).padStart(2, '0')}–${String(Math.floor(b.end / 60)).padStart(2, '0')}:${String(b.end % 60).padStart(2, '0')}`;
      subFg = 'var(--danger-700)';
    } else {
      sub = 'Available';
      subFg = 'var(--success-700)';
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: 'translate(-50%,-50%) scale(var(--inv))',
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
      }}
    >
      <span style={{ background: '#fff', color: 'var(--ink-900)', border: '1px solid var(--ink-200)', borderRadius: 4, padding: '3px 8px', font: '600 11px/1 var(--font-sans)', boxShadow: 'var(--shadow-xs)', whiteSpace: 'nowrap' }}>
        {unit.label}
      </span>
      {sub && (
        <span style={{ background: 'rgba(255,255,255,0.92)', color: subFg, borderRadius: 4, padding: '2px 6px', font: '500 10px/1 var(--font-sans)', whiteSpace: 'nowrap' }}>
          {sub}
        </span>
      )}
    </div>
  );
}
