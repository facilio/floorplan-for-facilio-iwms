import { useEffect, useRef, useState } from 'react';

/**
 * A loading flag that only becomes visible if it STAYS set — the standard cure for a shimmer that
 * flashes and vanishes.
 *
 * Why the popup needs it: the record summary and the stateflow reads each raise a flag the moment a
 * unit is selected, and both are commonly answered from cache or in a few tens of milliseconds. The
 * skeleton was therefore painted and replaced within a frame or two — read as flickering, not as
 * loading. Worse, several surfaces mount a section for the same unit (assignment panel + map
 * popup), so the flag could be raised again on an already-loaded unit and flash content -> skeleton
 * -> content.
 *
 * Rising edge is DELAYED (a read that finishes inside the delay never shows a skeleton at all);
 * falling edge is IMMEDIATE (data is here, show it now). `sticky` additionally refuses to go back to
 * loading once this key has rendered real content, so a late flag can't pull loaded data back out
 * from under the user.
 */
export function useDelayedFlag(active: boolean, opts?: { delayMs?: number; key?: string; sticky?: boolean }): boolean {
  const delayMs = opts?.delayMs ?? 180;
  const key = opts?.key;
  const sticky = opts?.sticky ?? false;
  const [visible, setVisible] = useState(false);
  // Keys that have already shown real content — a re-raised flag for one of them is ignored.
  const settledKeys = useRef(new Set<string>());
  const lastKey = useRef(key);

  if (lastKey.current !== key) {
    lastKey.current = key;
  }

  useEffect(() => {
    if (!active) {
      setVisible(false);
      // Reaching "not loading" is what marks this key as having real content to protect.
      if (sticky && key != null) settledKeys.current.add(key);
      return;
    }
    if (sticky && key != null && settledKeys.current.has(key)) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs, key, sticky]);

  return visible;
}
