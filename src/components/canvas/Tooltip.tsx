import { useFloorplan } from '../../state/FloorplanContext';
import { employeeName, isAssignable, isBookable, unitById } from '../../state/selectors';
import { tooltipPlacement, unitCenter } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { StatusPill } from '../primitives/StatusPill';
import { Button } from '../primitives/Button';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import styles from './Tooltip.module.css';

export function Tooltip() {
  const { state, actions } = useFloorplan();
  const unit = unitById(state, state.selected);
  if (!unit) return null;

  const { cx, cy } = unitCenter(unit);
  const place = tooltipPlacement(cx, cy, state.view);
  const status = unitStatus(state, unit, (id) => employeeName(state, id));
  const empId = state.assignments[unit.id];

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

      {/* Everything below is booking/assignment — irrelevant for amenities/assets. */}
      {!isAmenity && (
      <>
      <div className={styles.statusRow}>
        <StatusPill label={status.text} bg={status.bg} fg={status.fg} />
      </div>

      {state.mode === 'book' && bookable && !booked && (
        <Button variant="primary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end })}>
          Book
        </Button>
      )}
      {state.mode === 'book' && bookable && booked && (
        <Button variant="secondary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end })}>
          Manage bookings
        </Button>
      )}
      {state.mode === 'assign' && assignable && !empId && (
        <Button variant="primary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.togglePanelOpen('details')}>
          Assign
        </Button>
      )}
      {state.mode === 'assign' && assignable && !!empId && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <Button variant="danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => actions.vacate(unit.id)}>
            Vacate
          </Button>
          <Button
            variant="primary"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              actions.setWebReassign(unit.id);
            }}
          >
            Reassign
          </Button>
        </div>
      )}
      {state.mode === 'assign' && !assignable && (
        <div className={styles.note}>Booked in Booking mode, not assigned.</div>
      )}
      </>
      )}

      <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} />
    </div>
  );
}
