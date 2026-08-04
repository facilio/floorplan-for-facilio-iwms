import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, isAssignable, isBookable, unitById } from '../../state/selectors';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { tooltipPlacement, unitCenter } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { StatusPill } from '../primitives/StatusPill';
import { Button } from '../primitives/Button';
import { UnitStateflowSection } from '../details/StateflowActions';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import styles from './Tooltip.module.css';

export function Tooltip() {
  const { state, actions } = useFloorplan();
  const unit = unitById(state, state.selected);
  if (!unit) return null;
  // EDIT mode: no popover. It floated right over the selected room and its corner handles,
  // blocking dimension edits — and closing it deselected the unit, which killed the handles
  // anyway. Editing has its own surface (the Edit panel inspector); selection on the canvas
  // must stay purely about dragging/reshaping there.
  if (state.mode === 'edit') return null;

  const { cx, cy } = unitCenter(unit);
  const place = tooltipPlacement(cx, cy, state.view);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const contactId = state.assignments[unit.id];

  // Amenity/asset markers are informational — no booking/assignment concept,
  // so they skip the status pill, action buttons, and any mode notes.
  const isAmenity = unit.type === 'amenity';
  const isAsset = isAmenity && !!unit.assetId;

  const markerName = isAmenity && (unit.markerKind || unit.icon) ? resolveMarkerDef(state.customMarkers, unit).name : 'Amenity';
  const primaryLabel = isAsset
    ? 'Asset'
    : isAmenity
      ? markerName
      : unit.type === 'workstation'
        ? 'Desk'
        : TYPE_META[unit.type].name;
  const primary = unit.label;
  const secondaryLabel = isAmenity ? 'Details' : unit.secondary ? 'Seat type' : 'Type';
  const secondary = isAmenity
    ? unit.secondary || (unit.markerKind || unit.icon ? markerName : 'Marker')
    : unit.secondary || [TYPE_META[unit.type].name, unit.room].filter(Boolean).join(' · ');

  const bookable = isBookable(unit);
  const assignable = isAssignable(unit);
  const booked = status.key === 'booked';

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={styles.card}
      style={{ left: place.sx, top: place.sy, transform: place.transform }}
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.eyebrow}>{primaryLabel}</div>
          <div className={styles.name}>{primary}</div>
        </div>
        <button className={styles.close} title="Close" onClick={() => actions.selectUnit(null)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className={styles.section}>
        <div className={styles.eyebrow}>{secondaryLabel}</div>
        <div className={styles.value}>{secondary}</div>
      </div>
      {(unit.type === 'workstation' || isAmenity) && unit.room && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Room</div>
          <div className={styles.value}>{unit.room}</div>
        </div>
      )}
      {unit.department && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Department</div>
          <div className={styles.value}>{unit.department}</div>
        </div>
      )}
      {unit.type === 'room' && unit.roomType && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Room type</div>
          <div className={styles.value}>{unit.roomType}</div>
        </div>
      )}
      {/* WHO holds the room, right in the popup (requested) — never the raw contact id. */}
      {unit.type === 'room' && contactId && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Assigned to</div>
          <div className={styles.value}>{contactName(state, contactId) || 'Occupied'}</div>
        </div>
      )}

      {/* Everything below is booking/assignment — irrelevant for amenities/assets. */}
      {!isAmenity && (
      <>
      {/* Connected mode shows ONLY the record's own moduleState (the stateflow section below) —
          the app-derived pill duplicated it ("Occupied" twice). It remains as the local-mode
          fallback, where there is no stateflow to ask. */}
      {!isFacilioApiConfigured && (
        <div className={styles.statusRow}>
          <StatusPill label={status.text} bg={status.bg} fg={status.fg} />
        </div>
      )}

      {/* The record's OWN stateflow: current state + approval pills ("the desk status"), and
          Assign/Vacate/whatever transitions its current state actually offers — STRICT rule,
          nothing hardcoded. Booking creation and the person picker are data-entry flows (not
          state actions), so they keep their navigation buttons below. TRANSITION BUTTONS show
          only for ASSIGNABLE units in ASSIGN mode (per request): booking view is always
          read-only, and a booking-type (HOT/HOTEL) desk stays read-only in assign view too. */}
      <UnitStateflowSection unit={unit} readOnly={state.mode === 'book' || !assignable} />

      {state.mode === 'book' && bookable && !booked && (
        <Button variant="primary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end })}>
          Book
        </Button>
      )}
      {state.mode === 'book' && bookable && booked && (
        <Button
          variant="secondary"
          fullWidth
          style={{ marginTop: 10 }}
          onClick={() => {
            // LIST the unit's bookings (BookPanel's schedule for this selected unit) — this
            // button used to open the CREATE form, which is what "Book" is for.
            actions.setSchedView('list');
            actions.openPanel('details');
          }}
        >
          Manage bookings
        </Button>
      )}
      {state.mode === 'assign' && assignable && (
        <Button variant={contactId ? 'secondary' : 'primary'} fullWidth style={{ marginTop: 10 }} onClick={() => actions.openPanel('details')}>
          {contactId ? 'Manage' : 'Assign a person'}
        </Button>
      )}
      {/* No note for bookable-only units in assign mode (removed on approval) — the status
          pill alone carries the state. */}
      </>
      )}

      <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} />
    </div>
  );
}
