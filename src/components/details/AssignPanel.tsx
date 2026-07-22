import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, initials, isAssignable, unitById } from '../../state/selectors';
import { TYPE_META } from '../../lib/types';
import { facilioRecordUrl } from '../../lib/facilioApi';
import { Select } from '../primitives/Select';
import { Button } from '../primitives/Button';
import { SkeletonRows } from '../primitives/Skeleton';
import card from './Card.module.css';
import styles from './AssignPanel.module.css';

export function AssignPanel() {
  const { state, actions } = useFloorplan();
  const sel = unitById(state, state.selected);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  const q = state.contactSearch.trim().toLowerCase();
  const contacts = state.clientContacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.client.toLowerCase().includes(q));

  function unitsHeldBy(contactId: string) {
    return state.units.filter((u) => state.assignments[u.id] === contactId).map((u) => u.label);
  }

  function onDragStart(e: ReactDragEvent, contactId: string, name: string) {
    e.dataTransfer.setData('text/plain', contactId);
    e.dataTransfer.effectAllowed = 'move';

    const ghost = document.createElement('div');
    ghost.textContent = initials(name);
    Object.assign(ghost.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: '40px',
      height: '40px',
      borderRadius: '999px',
      background: 'var(--blue-500)',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '600 13px/1 var(--font-sans)',
      boxShadow: '0 4px 12px rgba(40,54,72,0.3)',
    } as CSSStyleDeclaration);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 20, 20);
    dragGhostRef.current = ghost;

    setDragId(contactId);
    actions.dragStartContact(contactId);
  }
  function onDragEnd() {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
    setDragId(null);
    actions.dragStartContact(null);
  }

  return (
    <div className={styles.stack}>
      {sel && sel.type !== 'amenity' && (
        <div className={card.card}>
          <div className={card.cardHead}>
            <h3 className={card.cardTitle}>
              {sel.label} <span className={styles.typeTag}>{TYPE_META[sel.type].name}</span>
            </h3>
          </div>
          <div className={card.cardBody}>
            {isAssignable(sel) ? (
              <AssignBody unitId={sel.id} />
            ) : (
              <p className={card.helper}>This space is booked in Booking mode, not assigned.</p>
            )}
          </div>
        </div>
      )}
      {sel && sel.type === 'amenity' && (
        <div className={card.card}>
          <div className={card.cardHead}>
            <h3 className={card.cardTitle}>{sel.label}</h3>
          </div>
          <div className={card.cardBody}>
            {sel.secondary && <p className={card.helper}>{sel.secondary}</p>}
          </div>
        </div>
      )}
      {!sel && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Select a desk, locker, or parking stall on the plan to assign it.</p>
          </div>
        </div>
      )}

      <div className={[card.card, styles.peopleCard].join(' ')}>
        <div className={card.cardHead}>
          <h3 className={card.cardTitle}>People</h3>
        </div>
        <div className={styles.peopleSearchWrap}>
          <input className={card.input} placeholder="Search people" value={state.contactSearch} onChange={(e) => actions.setContactSearch(e.target.value)} />
          <p className={styles.dragHint}>Drag a person onto a desk, locker, or parking stall to assign it.</p>
        </div>
        <div className={styles.peopleList}>
          {state.loading && state.clientContacts.length === 0 && <SkeletonRows rows={6} avatar />}
          {contacts.map((contact) => {
            const held = unitsHeldBy(contact.id);
            // Mock demo ids look like "c1".."c14" and have no real record to open — only
            // real (numeric) client-contact ids from @facilio/api get a working summary-page link.
            const recordUrl = /^\d+$/.test(contact.id) ? facilioRecordUrl('clientcontact', contact.id) : null;
            return (
              <div
                key={contact.id}
                className={styles.personRow}
                draggable
                onDragStart={(e) => onDragStart(e, contact.id, contact.name)}
                onDragEnd={onDragEnd}
                onClick={() => recordUrl && window.open(recordUrl, '_blank', 'noopener,noreferrer')}
                style={{ opacity: dragId === contact.id ? 0.45 : 1, cursor: recordUrl ? 'pointer' : 'grab' }}
                title={recordUrl ? 'Open client contact record' : undefined}
              >
                <span className={styles.avatar}>{initials(contact.name)}</span>
                <div className={styles.personText}>
                  <div className={styles.personName}>{contact.name}</div>
                  <div className={styles.personDept}>{contact.client}</div>
                </div>
                {held.length > 0 && <span className={styles.heldBadge}>{held.join(', ')}</span>}
                {recordUrl && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.openIcon}>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <path d="M15 3h6v6M10 14L21 3" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AssignBody({ unitId }: { unitId: string }) {
  const { state, actions } = useFloorplan();
  const contactId = state.assignments[unitId];
  const reassigning = state.webReassign === unitId;

  if (contactId && !reassigning) {
    return (
      <div>
        <div className={styles.assignedRow}>
          <span className={styles.avatar}>{initials(contactName(state, contactId))}</span>
          <span className={styles.assignedName}>{contactName(state, contactId)}</span>
        </div>
        <div className={styles.actionsRow}>
          <Button variant="danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => actions.vacate(unitId)}>
            Vacate
          </Button>
          <Button variant="primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => actions.setWebReassign(unitId)}>
            Reassign
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Select
        value={contactId ?? null}
        placeholder="— Choose a person —"
        options={state.clientContacts.map((c) => ({ value: c.id, label: c.name, sublabel: c.client }))}
        onChange={(v) => actions.assign(v, unitId)}
        fullWidth
        aria-label="Assign to"
      />
      <p className={styles.dragHint} style={{ marginTop: 8 }}>
        Or drag a person from the list below onto this space.
      </p>
    </div>
  );
}
