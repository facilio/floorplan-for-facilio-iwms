import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { bookedUnitIds, conflictsFor, isCancelledBooking } from './selectors';
import { buildInitialState } from './reducer';
import type { Booking } from '../lib/types';

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'b1',
  unitId: 'WS-01',
  date: '2026-08-26',
  start: 540,
  end: 600, // 09:00-10:00
  by: '',
  purpose: '',
  ...over,
});

/**
 * A cancelled booking must not hold its slot: the desk/room is bookable in that range as if it
 * weren't there. `isCancelled` is authoritative — the org's state name may be anything.
 */
describe('cancelled bookings never block a time range', () => {
  it('does not clash when isCancelled is true', () => {
    const b = booking({ isCancelled: true, stateName: 'Confirmed' }); // name says live, flag says cancelled
    expect(isCancelledBooking(b)).toBe(true);
    expect(conflictsFor([b], 'WS-01', '2026-08-26', 540, 600)).toEqual([]);
  });

  it('still clashes when isCancelled is false', () => {
    const b = booking({ isCancelled: false, stateName: 'Confirmed' });
    expect(conflictsFor([b], 'WS-01', '2026-08-26', 540, 600)).toHaveLength(1);
  });

  it('keeps honouring the state name for rows carrying no flag', () => {
    expect(isCancelledBooking(booking({ stateName: 'Cancelled' }))).toBe(true);
    expect(conflictsFor([booking({ stateName: 'Cancelled' })], 'WS-01', '2026-08-26', 540, 600)).toEqual([]);
  });

  it('leaves the unit un-greyed on the plan', () => {
    const state = { ...buildInitialState(), date: '2026-08-26', start: 540, end: 600, bookings: [booking({ isCancelled: true })] };
    expect(bookedUnitIds(state).has('WS-01')).toBe(false);
  });

  it('a partial overlap by a live booking still blocks', () => {
    const live = booking({ start: 570, end: 630, isCancelled: false });
    expect(conflictsFor([live], 'WS-01', '2026-08-26', 540, 600)).toHaveLength(1);
  });
});

/**
 * The user-visible question: does a cancelled booking still paint the desk RED on the plan, and
 * still occupy the calendar? Both surfaces read the same two things, so both are covered — the
 * marker/list colour resolves through unitStatus -> conflictsFor, and the calendar renders
 * state.bookings, which cancelled rows never enter.
 */
describe('a cancelled booking does not mark the unit booked', () => {
  const deskUnit = {
    id: 'WS-01',
    type: 'workstation' as const,
    label: 'WS-01',
    room: null,
    geom: { kind: 'point' as const, x: 0.5, y: 0.5 },
    floor: '1',
    plan: 'workstation' as const,
    deskType: 'HOT' as const, // bookable, so "booked" is a state it can reach
  };

  it('is not coloured booked when the only overlapping booking is cancelled', async () => {
    const { unitStatus } = await import('../lib/unitStatus');
    const state = {
      ...buildInitialState(),
      mode: 'book' as const, // the booked/red state only exists in booking mode
      date: '2026-08-26',
      start: 540,
      end: 600,
      units: [deskUnit],
      bookings: [booking({ isCancelled: true, unitId: 'WS-01' })],
    };
    expect(unitStatus(state, deskUnit, () => '').key).not.toBe('booked');
  });

  it('IS coloured booked when a live booking overlaps', async () => {
    const { unitStatus } = await import('../lib/unitStatus');
    const state = {
      ...buildInitialState(),
      mode: 'book' as const, // the booked/red state only exists in booking mode
      date: '2026-08-26',
      start: 540,
      end: 600,
      units: [deskUnit],
      bookings: [booking({ isCancelled: false, unitId: 'WS-01' })],
    };
    expect(unitStatus(state, deskUnit, () => '').key).toBe('booked');
  });
});
