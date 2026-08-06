import type { Unit } from '../../lib/types';
import { useFloorplan } from '../../state/FloorplanContext';
import { notAssignableReason, notBookableReason, contactName, initials, isAssignable, isBookable, unitById } from '../../state/selectors';
import { unitStatus } from '../../lib/unitStatus';
import { fmtTime } from '../../lib/geometry';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import { useSheetDrag } from './useSheetDrag';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { UnitStateflowSection } from '../details/StateflowActions';
import styles from './MobileUnitSheet.module.css';

export function MobileUnitSheet() {
  const { state, actions } = useFloorplan();
  const unit = unitById(state, state.mobSel);
  const sheetRef = useSheetDrag(() => {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
  }, !!unit);

  const contactId = unit ? state.assignments[unit.id] : undefined;
  const showBookTab = state.mobileTab === 'book';
  const isAmenity = unit?.type === 'amenity';
  const isAsset = isAmenity && !!unit?.assetId;
  const assignable = unit && !isAmenity ? isAssignable(unit) : false;
  if (!unit) return null;

  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const bookable = isBookable(unit);

  function close() {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
  }

  return (
    <>
      <div className={styles.backdrop} onClick={close} />
      {/* The sheet no longer grows for an inline directory — the person lookup is its own popup. */}
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.name}>{unit.label}</div>
            {/* Shimmer while the unit's own record loads — the type line would otherwise show a
                generic fallback and change a moment later. */}
            {state.unitDetailLoading === unit.id ? (
              <span className={styles.nameSkeleton} style={{ width: 90, height: 11 }} />
            ) : (
            <div className={styles.kind}>
              {/* ROOMS read their ROOM TYPE, desks their seat type — same rule as the web popup. */}
              {isAmenity
                ? isAsset
                  ? 'Asset'
                  : unit.markerKind || unit.icon
                    ? resolveMarkerDef(state.customMarkers, unit).name
                    : 'Amenity'
                : unit.type === 'room'
                  ? unit.roomType || TYPE_META[unit.type].name
                  : [TYPE_META[unit.type].name, unit.secondary].filter(Boolean).join(' · ')}
              {unit.room ? ` · ${unit.room}` : ''}
              {unit.department ? ` · ${unit.department}` : ''}
            </div>
            )}
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
        {/* WHY this space can't be booked, per TYPE — the copy was hardcoded to lockers and read
            wrong on an assigned desk (reported). Mirrors isBookable's actual rules. */}
        {!isAmenity && showBookTab && !bookable && <div className={styles.infoBox}>{notBookableReason(unit)}</div>}
        {!isAmenity && !showBookTab && !assignable && unit.type === 'room' && <div className={styles.infoBox}>{notAssignableReason(unit)}</div>}

        {!showBookTab && assignable && contactId && !state.mobAssignEdit && (
          // Shimmer while the record summary resolves the assignee's name — "Occupied" then the
          // real person a moment later read as a glitch (reported).
          state.unitDetailLoading === unit.id && !contactName(state, contactId) ? (
            <div className={styles.assignedRow}>
              <span className={styles.avatar} />
              <span className={styles.nameSkeleton} />
            </div>
          ) : (
            <div className={styles.assignedRow} data-tip={contactName(state, contactId) || 'Occupied'}>
              <span className={styles.avatar}>{initials(contactName(state, contactId) || 'Occupied')}</span>
              <span className={styles.assignedName}>{contactName(state, contactId) || 'Occupied'}</span>
            </div>
          )
        )}

        {/* RECORD ACTIONS COME FROM THE API for every unit, exactly like the web panels
            (AssignPanel/BookPanel): the record's own stateflow + approval transitions, never a
            hardcoded Vacate/Reassign/Book-state button. Read-only where the web is read-only:
            the Book tab, and units that aren't assignable in the Assign tab. */}
        {!isAmenity && !state.mobAssignEdit && <UnitStateflowSection unit={unit} readOnly={showBookTab || !assignable} />}

        {/* ONE assign button here too (requested — desks AND rooms, web AND mobile): the person
            lookup is the shared popup, so the sheet no longer carries its own inline list. That
            list also only filtered what was already in memory, while the popup searches the
            directory on the server. */}
        {!isFacilioApiConfigured && !isAmenity && !showBookTab && assignable && (
          <button
            className={styles.primaryBtn}
            onClick={() => {
              actions.setMobAssignEdit(false);
              actions.openPeoplePicker(unit.id);
            }}
          >
            {contactId ? 'Re-assign' : 'Assign a person'}
          </button>
        )}
      </div>
    </>
  );
}
