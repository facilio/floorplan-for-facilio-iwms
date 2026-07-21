import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { employeeName, initials, isAssignable, unitById } from '../../state/selectors';
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

  const q = state.empSearch.trim().toLowerCase();
  const employees = state.employees.filter((e) => !q || e.name.toLowerCase().includes(q) || e.dept.toLowerCase().includes(q));

  function unitsHeldBy(empId: string) {
    return state.units.filter((u) => state.assignments[u.id] === empId).map((u) => u.label);
  }

  function onDragStart(e: ReactDragEvent, empId: string, name: string) {
    e.dataTransfer.setData('text/plain', empId);
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

    setDragId(empId);
    actions.dragStartEmp(empId);
  }
  function onDragEnd() {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
    setDragId(null);
    actions.dragStartEmp(null);
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
          <input className={card.input} placeholder="Search people" value={state.empSearch} onChange={(e) => actions.setEmpSearch(e.target.value)} />
          <p className={styles.dragHint}>Drag a person onto a desk, locker, or parking stall to assign it.</p>
        </div>
        <div className={styles.peopleList}>
          {state.loading && state.employees.length === 0 && <SkeletonRows rows={6} avatar />}
          {employees.map((emp) => {
            const held = unitsHeldBy(emp.id);
            // Mock demo ids look like "e1".."e14" and have no real record to open — only
            // real (numeric) employee ids from @facilio/api get a working summary-page link.
            const recordUrl = /^\d+$/.test(emp.id) ? facilioRecordUrl('employee', emp.id) : null;
            return (
              <div
                key={emp.id}
                className={styles.personRow}
                draggable
                onDragStart={(e) => onDragStart(e, emp.id, emp.name)}
                onDragEnd={onDragEnd}
                onClick={() => recordUrl && window.open(recordUrl, '_blank', 'noopener,noreferrer')}
                style={{ opacity: dragId === emp.id ? 0.45 : 1, cursor: recordUrl ? 'pointer' : 'grab' }}
                title={recordUrl ? 'Open employee record' : undefined}
              >
                <span className={styles.avatar}>{initials(emp.name)}</span>
                <div className={styles.personText}>
                  <div className={styles.personName}>{emp.name}</div>
                  <div className={styles.personDept}>{emp.dept}</div>
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
  const empId = state.assignments[unitId];
  const reassigning = state.webReassign === unitId;

  if (empId && !reassigning) {
    return (
      <div>
        <div className={styles.assignedRow}>
          <span className={styles.avatar}>{initials(employeeName(state, empId))}</span>
          <span className={styles.assignedName}>{employeeName(state, empId)}</span>
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
        value={empId ?? null}
        placeholder="— Choose a person —"
        options={state.employees.map((e) => ({ value: e.id, label: e.name, sublabel: e.dept }))}
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
