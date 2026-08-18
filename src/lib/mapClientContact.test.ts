import { describe, expect, it, vi } from 'vitest';

// The data source reaches the network and the CAD/PDF renderers on import; none of that is involved
// in mapping a contact row. (pdfPreview also imports pdf.js's worker via `?url`, a Vite-only form.)
vi.mock('./facilioApi', () => ({
  apiOrigin: null,
  customDelete: vi.fn(),
  customGet: vi.fn(),
  customPatch: vi.fn(),
  customPost: vi.fn(),
  facilioApi: { fetchAll: vi.fn(async () => ({ list: [] })) },
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: false,
  sdkProperties: {},
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

import { mapClientContact } from './facilioApiDataSource';

/**
 * The secondary line under a name is the DEPARTMENT when the org sets one, else the client.
 * `department_clientcontact` is a lookup, so it arrives in whichever shape the list projection
 * used — these pin every shape seen in the wild, plus the fallback order.
 */
describe('mapClientContact secondary line', () => {
  it('prefers an expanded department lookup over the client', () => {
    const c = mapClientContact({ id: 7, name: 'Ashjan Aly', department_clientcontact: { id: 3, name: 'Corporate Services' }, client: { name: 'RCU' } });
    expect(c.client).toBe('Corporate Services');
  });

  it('reads a lookup exposed as primaryValue or displayName', () => {
    expect(mapClientContact({ id: 1, name: 'A', department_clientcontact: { id: 3, primaryValue: 'Heritage' } }).client).toBe('Heritage');
    expect(mapClientContact({ id: 1, name: 'A', department_clientcontact: { id: 3, displayName: 'Ops' } }).client).toBe('Ops');
  });

  it('falls back to the client when no department is set', () => {
    expect(mapClientContact({ id: 1, name: 'A', client: { name: 'RCU Corporate' } }).client).toBe('RCU Corporate');
    expect(mapClientContact({ id: 1, name: 'A', clientName: 'RCU Heritage' }).client).toBe('RCU Heritage');
  });

  it('treats a blank department as unset rather than blanking the line', () => {
    expect(mapClientContact({ id: 1, name: 'A', department_clientcontact: { id: 3, name: '   ' }, client: { name: 'RCU' } }).client).toBe('RCU');
  });

  it('never returns undefined for the line', () => {
    expect(mapClientContact({ id: 1, name: 'A' }).client).toBe('');
  });

  it('does not show a raw id when the lookup came back unexpanded and unresolved', () => {
    // A bare id with no department module loaded must fall back to the client, never render "42".
    expect(mapClientContact({ id: 1, name: 'A', department_clientcontact: 42, client: { name: 'RCU' } }).client).toBe('RCU');
  });
});
