import { useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { employeeName, isAssignable, isBookable } from '../../state/selectors';
import { unitStatus } from '../../lib/unitStatus';
import { unitSortCompare, fmtTime } from '../../lib/geometry';
import { TYPE_META } from '../../lib/types';
import type { Unit, UnitType } from '../../lib/types';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileSpacesSheet.module.css';

const FILTERS: { id: 'all' | UnitType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'workstation', label: 'Desks' },
  { id: 'locker', label: 'Lockers' },
  { id: 'room', label: 'Rooms' },
  { id: 'parking', label: 'Parking' },
];

/**
 * Full spaces directory for the floor, opened from the map's count tag:
 * type filters + search, per-row availability/assignee, and the primary
 * action (Book / Assign) inline — so common flows don't require hunting
 * the right pin on the plan first.
 */
export function MobileSpacesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const [filter, setFilter] = useState<'all' | UnitType>('all');
  const [query, setQuery] = useState('');
  const sheetRef = useSheetDrag(onClose, open);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: state.units.length };
    for (const u of state.units) c[u.type] = (c[u.type] || 0) + 1;
    return c;
  }, [state.units]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.units
      .filter((u) => filter === 'all' || u.type === filter)
      .filter(
        (u) =>
          !q ||
          u.label.toLowerCase().includes(q) ||
          (u.room ?? '').toLowerCase().includes(q) ||
          (u.secondary ?? '').toLowerCase().includes(q),
      )
      .sort(unitSortCompare);
  }, [state.units, filter, query]);

  if (!open) return null;

  function showOnPlan(unit: Unit) {
    onClose();
    actions.setMobSel(unit.id);
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          <span className={styles.title}>Spaces on this floor</span>
          <span className={styles.count}>{state.units.length}</span>
        </div>
        <input
          className={styles.search}
          placeholder="Search spaces or rooms"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.chips}>
          {FILTERS.filter((f) => f.id === 'all' || (counts[f.id] || 0) > 0).map((f) => (
            <button
              key={f.id}
              className={[styles.chip, filter === f.id ? styles.chipActive : ''].join(' ')}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className={styles.chipCount}>{counts[f.id] || 0}</span>
            </button>
          ))}
        </div>

        <div className={styles.list}>
          {filtered.map((u) => (
            <SpaceRow key={u.id} unit={u} onShow={() => showOnPlan(u)} onClose={onClose} />
          ))}
          {filtered.length === 0 && <div className={styles.emptyNote}>No spaces match.</div>}
        </div>
      </div>
    </>
  );
}

function SpaceRow({ unit, onShow, onClose }: { unit: Unit; onShow: () => void; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const status = unitStatus(state, unit, (id) => employeeName(state, id));
  const empId = state.assignments[unit.id];
  const bookTab = state.mobileTab === 'book';

  const canBook = bookTab && isBookable(unit) && status.key !== 'booked';
  const canAssign = !bookTab && isAssignable(unit) && !empId;

  return (
    <div className={styles.row}>
      <button className={styles.rowMain} onClick={onShow}>
        <span className={styles.typeDot} data-type={unit.type} />
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>{unit.label}</span>
          <span className={styles.rowSub}>
            {[TYPE_META[unit.type].name, unit.room].filter(Boolean).join(' · ')}
            {empId ? ` · ${employeeName(state, empId)}` : ''}
          </span>
        </span>
        <span className={styles.statusPill} style={{ background: status.bg, color: status.fg }}>
          {status.text}
        </span>
      </button>
      {canBook && (
        <button
          className={styles.actionBtn}
          onClick={() => {
            actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end });
            onClose();
          }}
        >
          Book · {fmtTime(state.start)}
        </button>
      )}
      {canAssign && (
        <button
          className={styles.actionBtn}
          onClick={() => {
            onClose();
            actions.setMobSel(unit.id);
            actions.setMobAssignEdit(true);
          }}
        >
          Assign
        </button>
      )}
    </div>
  );
}
