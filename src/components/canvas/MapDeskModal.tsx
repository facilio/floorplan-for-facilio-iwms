import { useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { Select } from '../primitives/Select';
import { TYPE_META } from '../../lib/types';
import card from '../details/Card.module.css';

/**
 * The "which record goes here?" dialog — opened by clicking a spot with a desk/locker/parking
 * tool, or by closing a drawn room outline (see closeDraft): both flows resolve here. Pick an
 * existing record from the select (unplaced records first — the pool plus org records with no
 * position yet), or create a new one for the spot. Placing never silently mints a record.
 */
export function MapDeskModal() {
  const { state, actions } = useFloorplan();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const spot = state.pendingPlacement;
  if (!spot) return null;

  const meta = TYPE_META[spot.type];
  // Rooms have no session pool (deleting a room never pools it) — their candidates are room
  // units, typically `unplaced` org records receiving their first outline. Point types offer the
  // session pool plus this floor's records of that type (unplaced ones get placed, placed ones
  // get moved to the new spot).
  const candidates =
    spot.type === 'room'
      ? state.units.filter((u) => u.type === 'room' && u.unplaced)
      : [...state.unplacedUnits.filter((u) => u.type === spot.type), ...state.units.filter((u) => u.type === spot.type && u.geom.kind === 'point')];

  const placedIds = new Set(state.units.filter((u) => !u.unplaced).map((u) => u.id));
  const options = candidates.map((u) => ({
    value: u.id,
    label: u.label,
    sublabel:
      [
        u.type === 'workstation' ? (u.deskType ?? 'ASSIGNED') : null,
        u.secondary ?? null,
        placedIds.has(u.id) ? (u.room ? `currently in ${u.room}` : 'currently placed — will move') : 'unplaced',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
  }));
  const noun = meta.name.toLowerCase();

  return (
    <Modal onClose={actions.cancelPlacement} width={420}>
      <ModalHeader
        title={`Place a ${noun}`}
        subtitle={options.length ? `Pick an existing ${noun} for this spot, or create a new one.` : `No existing ${noun}s to place — create a new one for this spot.`}
        onClose={actions.cancelPlacement}
      />
      <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {options.length > 0 ? (
          <>
            <Select value={selectedId} options={options} onChange={setSelectedId} placeholder={`Select a ${noun}…`} fullWidth aria-label={`Select a ${noun} to place`} />
            <Button variant="primary" fullWidth disabled={!selectedId} onClick={() => selectedId && actions.confirmPlacementExisting(selectedId)}>
              Place selected {noun}
            </Button>
          </>
        ) : (
          <div className={card.helper} style={{ padding: '6px 2px' }}>
            Deleting a placed {noun} moves it here instead of destroying it, so it can be re-placed later.
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={actions.cancelPlacement}>Cancel</Button>
        <Button variant={options.length ? 'secondary' : 'primary'} onClick={actions.confirmPlacementCreate}>Create new {noun}</Button>
      </ModalFooter>
    </Modal>
  );
}
