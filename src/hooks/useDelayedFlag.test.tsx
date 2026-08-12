import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedFlag } from './useDelayedFlag';

/**
 * These cover the popup's shimmer directly: the reported bug was NOT "the loader never appears"
 * but "the loader appears for an instant on data that was already there" — a flash, reported as
 * flickering. What matters is therefore the RISING edge (must be suppressed for fast reads) and
 * re-raising the flag on a unit that already rendered (must never go back to a skeleton).
 */
function Probe({ active, unitId }: { active: boolean; unitId?: string }) {
  const visible = useDelayedFlag(active, { key: unitId, sticky: true, delayMs: 180 });
  return <span data-testid="v">{visible ? 'loading' : 'content'}</span>;
}

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const shown = (c: { getByTestId: (id: string) => HTMLElement }) => c.getByTestId('v').textContent;

  it('never shows a skeleton for a read that settles inside the delay (the flicker)', () => {
    const c = render(<Probe active unitId="u1" />);
    // 120ms of loading, then the answer arrives — under the 180ms threshold.
    act(() => void vi.advanceTimersByTime(120));
    expect(shown(c)).toBe('content');
    c.rerender(<Probe active={false} unitId="u1" />);
    act(() => void vi.advanceTimersByTime(500));
    // Never flashed: 'loading' was not rendered at any point.
    expect(shown(c)).toBe('content');
  });

  it('does show a skeleton for a genuinely slow read', () => {
    const c = render(<Probe active unitId="u1" />);
    act(() => void vi.advanceTimersByTime(200));
    expect(shown(c)).toBe('loading');
  });

  it('clears immediately when the data lands, without waiting out the delay', () => {
    const c = render(<Probe active unitId="u1" />);
    act(() => void vi.advanceTimersByTime(200));
    expect(shown(c)).toBe('loading');
    c.rerender(<Probe active={false} unitId="u1" />);
    expect(shown(c)).toBe('content');
  });

  it('never returns to a skeleton once the unit has shown real content', () => {
    // This is the panel+popup case: the unit finishes loading, then a SECOND stateflow section
    // mounts for the same unit and raises the flag again.
    const c = render(<Probe active unitId="u1" />);
    c.rerender(<Probe active={false} unitId="u1" />);
    expect(shown(c)).toBe('content');
    c.rerender(<Probe active unitId="u1" />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(shown(c)).toBe('content');
  });

  it('shows the loader again after an action re-reads the same unit', () => {
    // Stickiness must not outlive the read it was protecting. Callers key it on unit + action nonce,
    // so running a transition (Vacate, assign) counts as new work: keyed on the unit alone, the
    // loader was suppressed for the rest of that unit's life and a transition re-read showed nothing
    // loading at all.
    const c = render(<Probe active unitId="u1:0" />);
    c.rerender(<Probe active={false} unitId="u1:0" />); // first read settled
    expect(shown(c)).toBe('content');
    // A transition runs -> nonce bumps -> same unit, new key.
    c.rerender(<Probe active unitId="u1:1" />);
    act(() => void vi.advanceTimersByTime(200));
    expect(shown(c)).toBe('loading');
  });

  it('reproduces the OLD flash when the delay and stickiness are removed', () => {
    // Guards the guard: with delayMs 0 and no stickiness — what the popup did before, reading the
    // flags straight — both reported symptoms come back. If this ever passes as 'content', the
    // tests above have stopped proving anything.
    function Raw({ active, unitId }: { active: boolean; unitId?: string }) {
      const visible = useDelayedFlag(active, { key: unitId, sticky: false, delayMs: 0 });
      return <span data-testid="v">{visible ? 'loading' : 'content'}</span>;
    }
    const c = render(<Raw active unitId="u1" />);
    act(() => void vi.advanceTimersByTime(1)); // a read answered almost instantly...
    expect(shown(c)).toBe('loading'); // ...still flashed a skeleton
    c.rerender(<Raw active={false} unitId="u1" />);
    expect(shown(c)).toBe('content');
    c.rerender(<Raw active unitId="u1" />); // second section mounts for the same unit
    act(() => void vi.advanceTimersByTime(1));
    expect(shown(c)).toBe('loading'); // content -> skeleton -> content, the flicker
  });

  it('still shows a slow load for a DIFFERENT unit', () => {
    const c = render(<Probe active unitId="u1" />);
    c.rerender(<Probe active={false} unitId="u1" />); // u1 settled
    c.rerender(<Probe active unitId="u2" />); // switching to a fresh unit
    act(() => void vi.advanceTimersByTime(200));
    expect(shown(c)).toBe('loading');
  });
});
