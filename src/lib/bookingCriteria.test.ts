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
 * Cancelled bookings are excluded server-side so they can't hold a slot. The OPERATOR matters more
 * than the field: "is false" would drop rows whose flag was never set (NULL), hiding LIVE bookings
 * and showing a taken desk as free — strictly worse than not filtering at all.
 */
describe('spacebooking cancelled criteria', () => {
  beforeEach(() => {
    fetchAll.mockReset();
    fetchAll.mockResolvedValue({ list: [], error: null });
  });

  it('excludes isCancelled = true, and does NOT filter on false', async () => {
    await fetchOrgBookingsForRange('2026-08-26', '2026-08-26');
    const sent = filtersOf(fetchAll.mock.calls[0]);
    expect(sent.isCancelled).toEqual({ operatorId: 10, value: ['true'] });
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
