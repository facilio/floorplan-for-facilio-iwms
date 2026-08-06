import { useEffect, useMemo } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, initials, unitById } from '../../state/selectors';
import { Modal, ModalHeader } from '../primitives/Modal';
import { SkeletonRows } from '../primitives/Skeleton';
import card from './Card.module.css';
import styles from './AssignPanel.module.css';

/**
 * The person lookup for an assign / re-assign, in its OWN popup (requested) — clicking either
 * action opens this rather than expanding a picker inside the side panel, so the choice is one
 * focused step wherever it started (marker popup, side panel, a Re-Assign transition button).
 *
 * Typing SEARCHES THE SERVER: the query goes to shared `contactSearch` state, which the debounced
 * search in FloorplanContext sends to the directory and merges into `clientContacts` — the whole
 * directory is never fetched up front, so filtering the local list alone would hide most people.
 *
 * Picking a person calls the ordinary `assign` action, which writes the record (assign and
 * re-assign are record writes, not transitions) and refreshes every surface showing it.
 */
export function PeoplePickerModal() {
  const { state, actions } = useFloorplan();
  const unitId = state.peoplePicker;
  const unit = unitById(state, unitId);
  const currentId = unitId ? state.assignments[unitId] : undefined;

  // A stale query from a previous open would show the wrong list for a moment.
  useEffect(() => {
    if (unitId) actions.setContactSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  const q = state.contactSearch.trim().toLowerCase();
  const contacts = useMemo(() => {
    if (!q) return state.clientContacts;
    return state.clientContacts.filter((c) => c.name.toLowerCase().includes(q) || c.client.toLowerCase().includes(q));
  }, [state.clientContacts, q]);

  if (!unitId || !unit) return null;
  const close = () => actions.closePeoplePicker();

  return (
    <Modal onClose={close} width={420}>
      <ModalHeader
        title={currentId ? 'Re-assign this space' : 'Assign a person'}
        subtitle={`${unit.label}${currentId ? ` · currently ${contactName(state, currentId) || 'occupied'}` : ''}`}
        onClose={close}
      />
      <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          className={card.input}
          autoFocus
          placeholder="Search people"
          aria-label="Search people"
          value={state.contactSearch}
          onChange={(e) => actions.setContactSearch(e.target.value)}
        />
        <div className={styles.peopleList} style={{ maxHeight: 320, overflowY: 'auto' }}>
          {state.contactSearchLoading && contacts.length === 0 && <SkeletonRows rows={4} avatar />}
          {!state.contactSearchLoading && contacts.length === 0 && (
            <p className={card.helper} style={{ padding: '10px 12px' }}>
              {q.length >= 2 ? 'No people match that search.' : 'Type at least 2 characters to search the directory.'}
            </p>
          )}
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              className={styles.personRow}
              data-tip={[c.name, c.client].filter(Boolean).join(' · ')}
              style={{ width: '100%', textAlign: 'left', background: 'none', cursor: 'pointer' }}
              onClick={() => {
                void actions.assign(c.id, unitId);
                close();
              }}
            >
              <span className={styles.avatar}>{initials(c.name)}</span>
              {/* Same two-line structure as the directory list — as inline spans the name and
                  department ran together ("Maria SilvaFinance"). */}
              <div className={styles.personText}>
                <div className={styles.personName}>{c.name}</div>
                {c.client && <div className={styles.personDept}>{c.client}</div>}
              </div>
              {c.id === currentId && <span className={card.helper}>Current</span>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
