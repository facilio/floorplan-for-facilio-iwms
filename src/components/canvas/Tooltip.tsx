import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, isAssignable, isBookable, unitById } from '../../state/selectors';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { tooltipPlacement, unitCenter } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { StatusPill } from '../primitives/StatusPill';
import { Button } from '../primitives/Button';
import { UnitStateflowSection } from '../details/StateflowActions';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import styles from './Tooltip.module.css';

export function Tooltip() {
  const { state, actions } = useFloorplan();
  const unit = unitById(state, state.selected);
  // Hooks run BEFORE the early returns below — the popup unmounts on deselect and in edit mode, and
  // a hook after those would be a conditional call.
  //
  // DELAYED, because both of the reads this waits on are usually answered from cache within a frame
  // or two: painting the skeleton immediately made it flash and vanish, which reads as flickering
  // rather than loading. Sticky per unit as well, so a flag raised again for a unit already showing
  // real content (the panel and the popup each mount a stateflow section for it) can't pull that
  // content back out.
  // 400ms measured from the report, not guessed: frames of a real selection show the skeleton still
  // up at 1.5s and the content in place by 1.7s, i.e. these reads land around 250-400ms. A shorter
  // threshold flashes on exactly the common case. Nothing is hidden meanwhile — the popup already
  // has the unit's name and type from the plan feed; only record-derived fields wait.
  const detailPending = !!unit && (state.unitDetailLoading === unit.id || state.flowPendingUnitId === unit.id);
  const detailLoading = useDelayedFlag(detailPending, { key: unit?.id, sticky: true, delayMs: 400 });
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
  // ROOMS show their ROOM TYPE here (requested) — "Seat type: Room" was both wrong for a room and
  // a restatement of the eyebrow above it. Desks keep seat type; everything else keeps "Type".
  const isRoomUnit = unit.type === 'room';
  const secondaryLabel = isAmenity
    ? 'Details'
    : isRoomUnit
      ? 'Room type'
      : unit.secondary
        ? 'Seat type'
        : unit.room
          ? 'Room'
          : 'Type';
  const secondary = isAmenity
    ? unit.secondary || (unit.markerKind || unit.icon ? markerName : 'Marker')
    : isRoomUnit
      ? unit.roomType || unit.secondary || ''
      : // DESKS/lockers/stalls: seat type when the record has one, else the ROOM they sit in —
        // never the bare type name, which just repeated the eyebrow above ("DESK / Type: Desk").
        unit.secondary || unit.room || '';
  /**
   * The record summary is still loading — show a shimmer rather than a value that will change. The
   * WHOLE popup waits for BOTH reads (its own record summary and the stateflow section's
   * state/transitions) so it never renders half of itself and then shifts (requested). Resolved
   * above, before this component's early returns — see `detailLoading`.
   */

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
          {/* The RECORD ID sits on the EYEBROW line beside "DESK" (requested): next to the name it
              was competing with a long label and truncated to "#15546…", which defeats the point of
              showing an id. Up here it has the room to print in full and the name keeps its line. */}
          <div className={styles.eyebrowRow}>
            <span className={styles.eyebrow}>{primaryLabel}</span>
            {/^\d+$/.test(unit.id) && (
              <span className={styles.idChip} title={`Record id ${unit.id}`}>
                #{unit.id}
              </span>
            )}
          </div>
          <div className={styles.name}>{primary}</div>
        </div>
        <button className={styles.close} title="Close" onClick={() => actions.selectUnit(null)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* While the record is (re)loading — on open, and again after every action — the WHOLE body
          loads as one block (requested). Field-by-field shimmers next to already-rendered values
          read as a half-updated popup; the header stays because it names what you clicked. */}
      {detailLoading ? (
        <div className={styles.loadingBody} aria-live="polite" aria-busy="true">
          <div className={[styles.skelLine, styles.eyebrowLine].join(' ')} />
          <div className={[styles.skelLine, styles.valueLine].join(' ')} />
          <div className={[styles.skelLine, styles.pillLine].join(' ')} />
          {/* A ROOM's popup fills with more (room type, who holds it, its actions), so its
              placeholder is taller. A DESK settles into a couple of lines — reserving a
              button-sized block for it made the loading state bigger than the result
              (requested: smaller for desks, rooms are fine as they are). */}
          {isRoomUnit && <div className={[styles.skelLine, styles.btnLine].join(' ')} />}
          <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} />
        </div>
      ) : (
      <>
      {/* Hidden rather than showing an em dash when the record carries no type (a room whose
          roomType isn't set) — and a shimmer while the summary that would fill it is in flight. */}
      {(secondary || detailLoading) && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>{secondaryLabel}</div>
          {/* While the unit's own record is loading, shimmer — a room whose roomType hasn't
              arrived yet would otherwise print the generic fallback and then change. */}
          {detailLoading ? <div className={styles.valueSkeleton} /> : <div className={styles.value}>{secondary}</div>}
        </div>
      )}
      {(unit.type === 'workstation' || isAmenity) && (unit.room || detailLoading) && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Room</div>
          {detailLoading && !unit.room ? <div className={styles.valueSkeleton} /> : <div className={styles.value}>{unit.room}</div>}
        </div>
      )}
      {unit.department && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Department</div>
          <div className={styles.value}>{unit.department}</div>
        </div>
      )}
      {/* WHO holds the space, right in the popup — never the raw contact id. While the record
          summary is still resolving the name, a SHIMMER stands in: showing "Occupied" and then
          swapping in the person a moment later read as a glitch.
          Rooms only, once — so a DESK popup showed just an "Occupied" pill and never said who
          (reported). Every assignable type gets the line now; amenities have no assignee. */}
      {!isAmenity && contactId && (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Assigned to</div>
          {detailLoading && !contactName(state, contactId) ? (
            <div className={styles.valueSkeleton} />
          ) : (
            <div className={styles.value}>{contactName(state, contactId) || 'Occupied'}</div>
          )}
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
      {/* With a real backend the assign button comes from the record's own transitions (rendered
          inside the stateflow section above), so it appears only for users/records the API offers
          it to. This standalone button is the LOCAL-mode fallback, where there is no API to ask. */}
      {!isFacilioApiConfigured && state.mode === 'assign' && assignable && (
        <Button variant={contactId ? 'secondary' : 'primary'} fullWidth style={{ marginTop: 10 }} onClick={() => actions.openPeoplePicker(unit.id)}>
          {contactId ? 'Re-assign' : 'Assign a person'}
        </Button>
      )}
      {/* Bookable-only DESKS get no note (removed on approval); ROOMS get this exact line. */}
      {state.mode === 'assign' && !assignable && unit.type === 'room' && (
        <div className={styles.note}>Meeting Rooms can only be booked, not assigned</div>
      )}
      </>
      )}

      <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} />
      </>
      )}
    </div>
  );
}
