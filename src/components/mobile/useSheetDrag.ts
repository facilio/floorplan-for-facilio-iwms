import { useEffect, useRef } from 'react';

/**
 * Native-style pull-down-to-dismiss for bottom sheets. Drag anywhere on the
 * sheet: downward drags translate it live (upward drags are ignored), and
 * releasing past ~90px — or flicking faster than 0.55 px/ms — dismisses;
 * otherwise it springs back. Drags starting inside a scrolled-down region
 * (any ancestor with scrollTop > 0, the sheet included) are left alone so
 * list scrolling keeps working — the grab only happens at the top, exactly
 * like a native sheet.
 *
 * Non-passive native listeners (not React synthetic) so preventDefault can
 * stop the page itself from rubber-banding under the drag.
 */
export function useSheetDrag(close: () => void, enabled = true) {
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // `enabled` gates attachment because these sheets render null while
    // closed — a mount-only effect would fire before the element exists.
    if (!enabled) return;
    const el = sheetRef.current;
    if (!el) return;
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let dragging = false;

    function anyAncestorScrolled(target: Node): boolean {
      let n = target as HTMLElement | null;
      while (n && n !== el!.parentElement) {
        if (n.scrollTop > 0) return true;
        n = n.parentElement;
      }
      return false;
    }

    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      if (anyAncestorScrolled(e.target as Node)) return;
      startY = e.touches[0].clientY;
      startT = Date.now();
      dy = 0;
      dragging = true;
      el!.style.transition = 'none';
    }

    function onMove(e: TouchEvent) {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      if (dy > 0) {
        e.preventDefault();
        el!.style.transform = `translateY(${dy}px)`;
      }
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      const velocity = dy / Math.max(1, Date.now() - startT);
      if (dy > 90 || (dy > 24 && velocity > 0.55)) {
        el!.style.transition = 'transform 0.18s ease-in';
        el!.style.transform = 'translateY(105%)';
        setTimeout(close, 170);
      } else {
        el!.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
        el!.style.transform = 'translateY(0)';
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return sheetRef;
}
