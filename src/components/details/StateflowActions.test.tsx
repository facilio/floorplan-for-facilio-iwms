import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The component only touches these two actions — a stub keeps the whole provider out of the test.
const setFlowPending = vi.fn();
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: {}, actions: { setFlowPending, showToast: vi.fn() } }),
}));
vi.mock('../../lib/facilioApi', () => ({ isFacilioApiConfigured: true }));

const fetchAvailableStates = vi.fn();
const fetchApprovalTransitions = vi.fn();
vi.mock('../../lib/stateflowApi', () => ({
  fetchAvailableStates: (...a: unknown[]) => fetchAvailableStates(...a),
  fetchApprovalTransitions: (...a: unknown[]) => fetchApprovalTransitions(...a),
  executeStateTransition: vi.fn(),
  executeApprovalTransition: vi.fn(),
  isAssignTransition: () => false,
  isVacateTransition: () => false,
}));
vi.mock('../../lib/facilioApiDataSource', () => ({ resolveUnitRecordRef: vi.fn() }));

import { StateflowActions } from './StateflowActions';

/** A state read that never settles — models the window while a newly selected record is loading. */
const pending = () => new Promise(() => {});

describe('StateflowActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchApprovalTransitions.mockImplementation(() => Promise.resolve(null));
  });
  afterEach(cleanup);

  it('drops the previous record\'s state the instant the record changes', async () => {
    // Record A is Assigned and offers Vacate.
    fetchAvailableStates.mockImplementation(() =>
      Promise.resolve({ currentStateName: 'Assigned', transitions: [{ id: 1, name: 'Vacate' }] })
    );
    const view = render(<StateflowActions moduleName="rooms" recordId={1} unitId="u1" />);
    await act(async () => {});
    expect(screen.getByText('Vacate')).toBeTruthy();

    // Selecting record B: its read hasn't answered yet. A's answer must NOT still be on screen —
    // showing "Assigned"/"Vacate" under a different record is the reported flicker, and those
    // buttons were live against the NEW record.
    fetchAvailableStates.mockImplementation(pending);
    view.rerender(<StateflowActions moduleName="rooms" recordId={2} unitId="u2" />);
    expect(screen.queryByText('Vacate')).toBeNull();
    expect(screen.queryByText('Assigned')).toBeNull();
  });

  it('keeps showing the current state while the SAME record is re-read', async () => {
    // A refresh after an action re-reads the same record; blanking there would just be a different
    // flicker, so the rendered state must survive a refreshKey bump.
    fetchAvailableStates.mockImplementation(() =>
      Promise.resolve({ currentStateName: 'Assigned', transitions: [{ id: 1, name: 'Vacate' }] })
    );
    const view = render(<StateflowActions moduleName="rooms" recordId={1} unitId="u1" refreshKey={0} />);
    await act(async () => {});
    expect(screen.getByText('Vacate')).toBeTruthy();

    fetchAvailableStates.mockImplementation(pending);
    view.rerender(<StateflowActions moduleName="rooms" recordId={1} unitId="u1" refreshKey={1} />);
    expect(screen.queryByText('Vacate')).toBeTruthy();
  });

  it('clears the popup loading flag once its reads settle', async () => {
    fetchAvailableStates.mockImplementation(() => Promise.resolve({ currentStateName: 'Free', transitions: [] }));
    render(<StateflowActions moduleName="rooms" recordId={1} unitId="u1" />);
    await act(async () => {});
    expect(setFlowPending).toHaveBeenCalledWith(null, 'u1');
  });
});
