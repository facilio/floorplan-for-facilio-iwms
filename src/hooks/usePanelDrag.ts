import { useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../state/FloorplanContext';

interface DragSession {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  moved: boolean;
}

/** Drag/collapse behavior for a floating panel, mirroring the original startPanelDrag/onPanelDragMove logic. */
export function usePanelDrag(id: 'context' | 'portfolio' | 'details', width: number) {
  const { state, actions } = useFloorplan();
  const dragRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);

  const pos = actions.panelPos(id, width);
  const open = state.panels[id].open;
  // Bottom clearance keeps a fully-expanded panel (and its drop shadow) off
  // the stage's bottom overlays. The bottom-left stack is legend (bottom 12,
  // ~28px chips) + "Reset layout" (bottom 48, ~44px button) ≈ 92px, plus the
  // panel's shadow bleed — 120px keeps everything below fully readable.
  const maxH = Math.max(180, state.stage.h - pos.y - 120);

  function onMouseMove(e: MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    actions.setPanelPos(id, d.ox + dx, d.oy + dy, open ? width : 46);
  }

  function onMouseUp() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    if (dragRef.current?.moved) {
      suppressClickRef.current = true;
      setTimeout(() => (suppressClickRef.current = false), 0);
    }
    dragRef.current = null;
  }

  function startDrag(e: ReactMouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  return {
    x: pos.x,
    y: pos.y,
    open,
    maxH,
    onHeaderDown: startDrag,
    onIconDown: startDrag,
    onToggle: (e: ReactMouseEvent) => {
      e.stopPropagation();
      actions.togglePanelOpen(id);
    },
    onIconClick: () => {
      if (suppressClickRef.current) return;
      actions.togglePanelOpen(id);
    },
  };
}
