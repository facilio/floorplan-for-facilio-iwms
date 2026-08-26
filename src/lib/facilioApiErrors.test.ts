import { describe, expect, it, vi } from 'vitest';

/**
 * The desk/room popover crash: a summary read that 400s took the whole map view down, because the
 * entire view sits under one error boundary and the crud helpers REJECTED instead of returning the
 * `{error}` their own type declares. Every caller checks `res.error`, so those checks simply never
 * fired on an HTTP failure.
 *
 * axios rejects on 4xx, so these assert the boundary absorbs it. `isFacilioApiConfigured` is false
 * here, which leaves the dev axios instance null — the call therefore throws inside the helper,
 * which is exactly the shape being guarded against.
 */
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

import { facilioApi } from './facilioApi';

describe('facilioApi never rejects', () => {
  it('resolves a failed fetchRecord to {error} rather than throwing', async () => {
    const res = await facilioApi.fetchRecord('desks', { id: 1554635 });
    expect(res.error).toBeTruthy();
    expect(res.error?.message).toBeTruthy();
  });

  it('resolves a failed fetchAll to {error} with a null list', async () => {
    const res = await facilioApi.fetchAll('clientcontact', { page: 1 });
    expect(res.error).toBeTruthy();
    expect(res.list).toBeNull();
  });

  it('resolves failed writes to {error} so the save UI can report them', async () => {
    const created = await facilioApi.createRecord('desks', { data: {} });
    const updated = await facilioApi.updateRecord('desks', { id: 1, data: {} });
    const deleted = await facilioApi.deleteRecord('desks', 1);
    expect(created.error).toBeTruthy();
    expect(updated.error).toBeTruthy();
    expect(deleted.error).toBeTruthy();
  });

  it('resolves a failed upload to {error}', async () => {
    const res = await facilioApi.uploadFiles([new File(['x'], 'plan.png', { type: 'image/png' })]);
    expect(res.error).toBeTruthy();
  });
});
