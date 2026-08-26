import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reported crash: clicking a desk marker whose record had been deleted fired
 * `GET v3/modules/desks/2062` -> 404, and the HOST navigated the whole tab to its "Something
 * Missing" page. The fix is to never ask a question that can 404 — a filtered list answers 200
 * with no rows instead — so what matters here is the REQUEST SHAPE, not just the return value.
 */
const fetchAll = vi.fn();
const fetchRecord = vi.fn();
vi.mock('./facilioApi', () => ({
  apiOrigin: null,
  customDelete: vi.fn(),
  customGet: vi.fn(),
  customPatch: vi.fn(),
  customPost: vi.fn(),
  facilioApi: { fetchAll: (...a: unknown[]) => fetchAll(...a), fetchRecord: (...a: unknown[]) => fetchRecord(...a) },
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  sdkProperties: {},
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

import { fetchUnitRecordDetails } from './facilioApiDataSource';
import type { Unit } from './types';

const desk = (id: string): Unit => ({ id, type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0, y: 0 }, floor: '1', plan: 'workstation' });

describe('record reads never ask by id', () => {
  beforeEach(() => {
    fetchAll.mockReset();
    fetchRecord.mockReset();
  });

  it('reads a desk through a filtered list, not GET /desks/{id}', async () => {
    fetchAll.mockResolvedValue({ list: [{ id: 2062, deskType: 1 }], error: null });
    await fetchUnitRecordDetails(desk('2062'));
    expect(fetchRecord).not.toHaveBeenCalled();
    const [moduleName, params] = fetchAll.mock.calls[0];
    expect(moduleName).toBe('desks');
    expect(JSON.parse((params as any).filters)).toEqual({ id: { operatorId: 9, value: ['2062'] } });
  });

  it('treats a deleted record as "no details" instead of an error', async () => {
    fetchAll.mockResolvedValue({ list: [], error: null }); // the 404 case, as a 200 with no rows
    await expect(fetchUnitRecordDetails(desk('2062'))).resolves.toBeNull();
    expect(fetchRecord).not.toHaveBeenCalled();
  });

  it('falls back to the by-id read only when the filter itself is rejected', async () => {
    fetchAll.mockResolvedValue({ list: null, error: { code: 400, message: 'unsupported filter' } });
    fetchRecord.mockResolvedValue({ desks: { id: 2062, deskType: 2 }, error: null });
    const res = await fetchUnitRecordDetails(desk('2062'));
    expect(fetchRecord).toHaveBeenCalledTimes(1);
    expect(res?.patch.deskType).toBe('HOT');
  });
});
