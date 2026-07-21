import { useFloorplan } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { TYPE_META } from '../../lib/types';
import card from '../details/Card.module.css';

/**
 * The "which desk goes here?" dialog, opened by clicking a spot with a desk/locker/parking tool
 * in edit mode (see placePoint). Placing no longer silently creates a new record: this offers
 * the UNPLACED pool of that type first (records whose markers were deleted — the record
 * survives off-plan), with an explicit "create new" as the alternative.
 */
export function MapDeskModal() {
  const { state, actions } = useFloorplan();
  const spot = state.pendingPlacement;
  if (!spot) return null;

  const meta = TYPE_META[spot.type];
  const candidates = state.unplacedUnits.filter((u) => u.type === spot.type);

  return (
    <Modal onClose={actions.cancelPlacement} width={420}>
      <ModalHeader
        title={`Place a ${meta.name.toLowerCase()}`}
        subtitle={candidates.length ? `Pick an existing unplaced ${meta.name.toLowerCase()} for this spot, or create a new one.` : `No unplaced ${meta.name.toLowerCase()}s — create a new one for this spot.`}
        onClose={actions.cancelPlacement}
      />
      <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '46vh', overflowY: 'auto' }}>
        {candidates.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => actions.confirmPlacementExisting(u.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--ink-200)',
              background: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
              font: '500 13px/1.3 var(--font-sans)',
              color: 'var(--ink-900)',
            }}
          >
            <span>
              {u.label}
              {u.type === 'workstation' ? <span style={{ color: 'var(--ink-500)', fontWeight: 400 }}> · {u.deskType ?? 'ASSIGNED'}</span> : null}
              {u.secondary ? <span style={{ color: 'var(--ink-500)', fontWeight: 400 }}> · {u.secondary}</span> : null}
            </span>
            <span style={{ color: 'var(--blue-600)', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>Assign here</span>
          </button>
        ))}
        {candidates.length === 0 && (
          <div className={card.helper} style={{ padding: '6px 2px' }}>
            Deleting a placed {meta.name.toLowerCase()} moves it here instead of destroying it, so it can be re-placed later.
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={actions.cancelPlacement}>Cancel</Button>
        <Button variant="primary" onClick={actions.confirmPlacementCreate}>Create new {meta.name.toLowerCase()}</Button>
      </ModalFooter>
    </Modal>
  );
}
