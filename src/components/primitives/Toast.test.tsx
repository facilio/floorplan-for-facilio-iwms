import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastStack } from './Toast';
import type { ToastItem } from './Toast';

const toast = (variant: ToastItem['variant']): ToastItem => ({ id: 1, title: 'x', variant });

describe('ToastStack auto-dismiss', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('dismisses a success toast after its window', () => {
    const onDismiss = vi.fn();
    render(<ToastStack toasts={[toast('success')]} onDismiss={onDismiss} />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('dismisses an ERROR toast too, on a longer window', () => {
    // Errors used to be persistent — they stayed over the plan until clicked away. They must now
    // clear on their own, but with more reading time than the others.
    const onDismiss = vi.fn();
    render(<ToastStack toasts={[toast('error')]} onDismiss={onDismiss} />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onDismiss).not.toHaveBeenCalled(); // still readable at the normal window
    act(() => void vi.advanceTimersByTime(4000));
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('never leaves any variant on screen indefinitely', () => {
    for (const variant of ['success', 'warning', 'error', 'info'] as const) {
      const onDismiss = vi.fn();
      const { unmount } = render(<ToastStack toasts={[toast(variant)]} onDismiss={onDismiss} />);
      act(() => void vi.advanceTimersByTime(30_000));
      expect(onDismiss, `${variant} toast should auto-dismiss`).toHaveBeenCalledWith(1);
      unmount();
    }
  });
});
