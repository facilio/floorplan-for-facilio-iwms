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

/**
 * The people lists show ONE secondary line under a name: department when the org sets one, else
 * client. The single-contact upsert resolves a name from a record summary and carries no
 * department, so it must not wipe the line off someone already in the directory.
 */
describe('reducer: client contact upsert', () => {
  const withContact = () => ({
    ...buildInitialState(),
    clientContacts: [
      { id: '1', name: 'Ashjan Aly', client: 'Corporate Services' },
      { id: '2', name: 'Anas Alassafi', client: 'Heritage' },
    ],
  });

  it('keeps the existing department when a name-only upsert arrives', () => {
    const next = reducer(withContact(), { type: 'UPSERT_CLIENT_CONTACT', contact: { id: '1', name: 'Ashjan Aly', client: '' } });
    expect(next.clientContacts.find((c) => c.id === '1')?.client).toBe('Corporate Services');
  });

  it('keeps the person in place rather than moving them to the end', () => {
    const next = reducer(withContact(), { type: 'UPSERT_CLIENT_CONTACT', contact: { id: '1', name: 'Ashjan Aly', client: '' } });
    expect(next.clientContacts.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('still takes a non-empty department from the incoming record', () => {
    const next = reducer(withContact(), { type: 'UPSERT_CLIENT_CONTACT', contact: { id: '1', name: 'Ashjan Aly', client: 'Facilities' } });
    expect(next.clientContacts.find((c) => c.id === '1')?.client).toBe('Facilities');
  });

  it('adds a contact that is not in the directory yet', () => {
    const next = reducer(withContact(), { type: 'UPSERT_CLIENT_CONTACT', contact: { id: '9', name: 'New Person', client: 'Ops' } });
    expect(next.clientContacts).toHaveLength(3);
    expect(next.clientContacts[2]).toEqual({ id: '9', name: 'New Person', client: 'Ops' });
  });
});
