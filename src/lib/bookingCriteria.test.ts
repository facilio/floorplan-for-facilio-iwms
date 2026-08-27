import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAll = vi.fn();
vi.mock('./facilioApi', () => ({
  apiOrigin: null,
  customDelete: vi.fn(),
  customGet: vi.fn(async () => ({})),
  customPatch: vi.fn(),
  customPost: vi.fn(),
  facilioApi: { fetchAll: (...a: unknown[]) => fetchAll(...a), fetchRecord: vi.fn() },
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  sdkProperties: {},
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

import { fetchOrgBookingsForRange } from './facilioApiDataSource';

const filtersOf = (call: unknown[]) => JSON.parse((call[1] as any).filters);

/**
 * Cancelled bookings are excluded server-side so they can't hold a slot. 15 is the org's boolean
 * "IS", so live rows are asked for directly (`isCancelled IS false`). Getting the operator or the
 * value wrong here inverts the query — asking for `true` would return ONLY cancelled bookings, so
 * every desk would read as free — which is why the exact criteria is asserted rather than assumed.
 */
describe('spacebooking cancelled criteria', () => {
  beforeEach(() => {
    fetchAll.mockReset();
    fetchAll.mockResolvedValue({ list: [], error: null });
  });

  it('asks for live rows only: isCancelled IS false', async () => {
    await fetchOrgBookingsForRange('2026-08-26', '2026-08-26');
    const sent = filtersOf(fetchAll.mock.calls[0]);
    expect(sent.isCancelled).toEqual({ operatorId: 15, value: ['false'] });
  });

  it('retries without the criteria when the org rejects them', async () => {
    fetchAll.mockReset();
    fetchAll
      .mockResolvedValueOnce({ list: null, error: { code: 400, message: 'unknown field isCancelled' } })
      .mockResolvedValue({ list: [], error: null });
    await fetchOrgBookingsForRange('2026-08-26', '2026-08-26');
    expect(fetchAll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(filtersOf(fetchAll.mock.calls[1]).isCancelled).toBeUndefined();
  });

  it('keeps the booking window criteria alongside it', async () => {
    await fetchOrgBookingsForRange('2026-08-26', '2026-08-26');
    const sent = filtersOf(fetchAll.mock.calls[0]);
    expect(sent.bookingStartTime?.operatorId).toBe(20);
  });
});
