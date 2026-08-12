import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, which imports pdf.js's worker via `?url` —
// a Vite-only import form the test runner can't resolve. Nothing here touches PDFs.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';

/**
 * Guards the property that makes a post-action refresh safe.
 *
 * Assign/vacate now re-read the whole floor so the sidebar and markers catch up, not just the
 * selected unit's record. That is only acceptable because re-reading the floor you are ALREADY on
 * leaves the selection alone — otherwise every assignment would close the popup you just acted in.
 * The refresh button depends on the same property, so this is worth pinning rather than assuming.
 */
describe('reducer: re-reading the current floor', () => {
  const withSelection = () => ({ ...buildInitialState(), floorId: 'f1', selected: 'u1' });

  it('keeps the selection when the floor is unchanged', () => {
    const next = reducer(withSelection(), { type: 'SELECT_FLOOR_START', floorId: 'f1' });
    expect(next.selected).toBe('u1');
  });

  it('still clears the selection when moving to a DIFFERENT floor', () => {
    const next = reducer(withSelection(), { type: 'SELECT_FLOOR_START', floorId: 'f2' });
    expect(next.selected).toBeNull();
  });

  it('keeps the selection when the floor load completes', () => {
    const next = reducer(withSelection(), {
      type: 'SELECT_FLOOR_DONE',
      floorId: 'f1',
      units: [],
      assignments: {},
      bookings: [],
    });
    expect(next.selected).toBe('u1');
  });

  it('bumps unitNonce on UNIT_CHANGED so the re-read effects actually re-run', () => {
    const before = withSelection();
    const next = reducer(before, { type: 'UNIT_CHANGED' });
    expect(next.unitNonce).toBe(before.unitNonce + 1);
  });
});
