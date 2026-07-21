import { useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { employeeName, initials, isAssignable, isBookable, unitById } from '../../state/selectors';
import { unitStatus } from '../../lib/unitStatus';
import { fmtTime } from '../../lib/geometry';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileUnitSheet.module.css';

/** Cap the rendered rows — the RCU directory is 1,400+ people; search narrows. */
const MAX_ROWS = 60;

export function MobileUnitSheet() {
  const { state, actions } = useFloorplan();
  const unit = unitById(state, state.mobSel);
  const [empQuery, setEmpQuery] = useState('');
  const sheetRef = useSheetDrag(() => {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
    setEmpQuery('');
  }, !!unit);

  const empId = unit ? state.assignments[unit.id] : undefined;
  const showBookTab = state.mobileTab === 'book';
  const isAmenity = unit?.type === 'amenity';
  const isAsset = isAmenity && !!unit?.assetId;
  const assignable = unit && !isAmenity ? isAssignable(unit) : false;
  // Employee picking expands the sheet to near-full height with its own
  // search — a plain dropdown was unusable against the full directory.
  const picking = !!unit && !showBookTab && assignable && (!empId || state.mobAssignEdit);

  const filtered = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return state.employees;
    return state.employees.filter((e) => e.name.toLowerCase().includes(q) || e.dept.toLowerCase().includes(q));
  }, [state.employees, empQuery]);

  if (!unit) return null;

  const status = unitStatus(state, unit, (id) => employeeName(state, id));
  const bookable = isBookable(unit);

  function close() {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
    setEmpQuery('');
  }

  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <>
      <div className={styles.backdrop} onClick={close} />
      <div ref={sheetRef} className={[styles.sheet, picking ? styles.sheetTall : ''].join(' ')}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.name}>{unit.label}</div>
            <div className={styles.kind}>
              {isAmenity
                ? isAsset
                  ? 'Asset'
                  : unit.markerKind || unit.icon
                    ? resolveMarkerDef(state.customMarkers, unit).name
                    : 'Amenity'
                : TYPE_META[unit.type].name}
              {unit.room ? ` · ${unit.room}` : ''}
            </div>
          </div>
          {!isAmenity && (
            <span className={styles.statusPill} style={{ background: status.bg, color: status.fg }}>
              {status.text}
            </span>
          )}
        </div>

        {isAmenity && unit.secondary && <div className={styles.infoBox}>{unit.secondary}</div>}

        {!isAmenity && showBookTab && bookable && status.key !== 'booked' && (
          <button
            className={styles.primaryBtn}
            onClick={() => {
              // Open the shared booking form (same as desktop) instead of an instant book.
              actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end });
              actions.setMobSel(null);
            }}
          >
            Book · {fmtTime(state.start)}–{fmtTime(state.end)}
          </button>
        )}
        {!isAmenity && showBookTab && bookable && status.key === 'booked' && <div className={styles.infoBox}>This space is currently booked for the selected time window.</div>}
        {!isAmenity && showBookTab && !bookable && <div className={styles.infoBox}>Lockers are assigned via the Assign tab, not booked.</div>}

        {!isAmenity && !showBookTab && !assignable && <div className={styles.infoBox}>This space is booked in Booking mode, not assigned.</div>}
        {!showBookTab && assignable && empId && !state.mobAssignEdit && (
          <>
            <div className={styles.assignedRow}>
              <span className={styles.avatar}>{initials(employeeName(state, empId))}</span>
              <span className={styles.assignedName}>{employeeName(state, empId)}</span>
            </div>
            <div className={styles.actionsRow}>
              <button className={styles.vacateBtn} onClick={() => actions.vacate(unit.id)}>
                Vacate
              </button>
              <button className={styles.reassignBtn} onClick={() => actions.setMobAssignEdit(true)}>
                Reassign
              </button>
            </div>
          </>
        )}

        {picking && (
          <div className={styles.pickWrap}>
            <div className={styles.assignLabel}>Assign to</div>
            <input
              className={styles.empSearch}
              placeholder="Search people or departments"
              value={empQuery}
              onChange={(e) => setEmpQuery(e.target.value)}
            />
            <div className={styles.empList}>
              {shown.map((e) => (
                <button
                  key={e.id}
                  className={styles.empRow}
                  onClick={() => {
                    actions.assign(e.id, unit.id);
                    actions.setMobAssignEdit(false);
                    setEmpQuery('');
                  }}
                >
                  <span className={styles.avatar}>{initials(e.name)}</span>
                  <span className={styles.empText}>
                    <span className={styles.empName}>{e.name}</span>
                    <span className={styles.empDept}>{e.dept}</span>
                  </span>
                  {empId === e.id && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-600)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
              {filtered.length > MAX_ROWS && (
                <div className={styles.listNote}>
                  Showing {MAX_ROWS} of {filtered.length} — keep typing to narrow down.
                </div>
              )}
              {filtered.length === 0 && <div className={styles.listNote}>No people match “{empQuery}”.</div>}
            </div>
            {state.mobAssignEdit && (
              <button
                className={styles.cancelPick}
                onClick={() => {
                  actions.setMobAssignEdit(false);
                  setEmpQuery('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
