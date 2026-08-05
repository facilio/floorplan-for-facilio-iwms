import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isBookable, unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { epochAtInTz, orgTimezone, wallClockInTz } from '../../lib/orgTime';
import { useOrgClock } from '../../hooks/useOrgClock';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { bookingFormsForType, fetchBookingFormById, fetchBookingFormList, fetchOrgBookableResources, fetchOrgBookingsForRange, pickDefaultBookingForm } from '../../lib/facilioApiDataSource';
import type { BookingFormFieldMeta, BookingFormMeta, BookingFormSummary } from '../../lib/facilioApiDataSource';
import type { ClientContact, Unit, UnitType } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Select } from '../primitives/Select';
import { DatePicker } from '../primitives/DatePicker';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import card from './Card.module.css';

/** Resource-field label per unit type, in space-booking mode (matches the real Facilio forms). */
const SPACE_RESOURCE_LABEL: Record<UnitType, string> = { workstation: 'Desk', parking: 'Parking', room: 'Location', locker: 'Locker', amenity: 'Amenity' };
/** Fallback chip names when the org form isn't reachable (mock/offline) — mirrors the system forms. */
const SPACE_FORM_NAME: Record<UnitType, string> = {
  workstation: 'Desk Booking Form',
  parking: 'Parking Booking Form',
  room: 'Space Booking Form',
  locker: 'Locker Form',
  amenity: 'Space Booking Form',
};
const FACILITY_FORM_NAME: Record<UnitType, string> = {
  workstation: 'Hot Desk Booking',
  parking: 'Parking Booking',
  room: 'Space Booking',
  locker: 'Locker Booking',
  amenity: 'Space Booking',
};

/** Org-form fields the modal maps onto its own controls; everything else renders generically. */
const KNOWN_FIELDS = new Set(['name', 'description', 'host', 'reservedBy', 'noOfAttendees', 'bookingStartTime', 'bookingEndTime', 'internalAttendees', 'externalAttendees']);
/** Lookup targets that mean "the booked resource" — pre-filled by the map selection, shown read-only. */
/**
 * The form response tells us what a lookup points at (`field.lookupModule.name`), so resource
 * fields are identified STRUCTURALLY from that — never from hardcoded field names. The org's room
 * picker arrives as `meeting_rooms_spacebooking` with lookupModule `rooms`; only this map needs to
 * know which unit type a lookup module represents.
 */
function baseFieldName(name: string): string {
  return name.toLowerCase().replace(/_(space|facility)booking$/, '');
}

const RESOURCE_LOOKUP_TYPE: Record<string, UnitType> = {
  desks: 'workstation',
  desk: 'workstation',
  rooms: 'room',
  space: 'room',
  basespace: 'room',
  parkingstall: 'parking',
  parkinglot: 'parking',
  lockers: 'locker',
};
const PEOPLE_LOOKUPS = new Set(['people', 'employee', 'clientcontact', 'users']);

export function BookingModal() {
  const { state } = useFloorplan();
  if (!state.bookForm) return null;
  const target = state.bookForm;
  // Remount (fresh field state) whenever the form opens for a different resource/window.
  return <BookingFormInner key={`${target.unitId}:${target.date}:${target.start}:${target.end}`} />;
}

function BookingFormInner() {
  const { state, actions } = useFloorplan();
  const target = state.bookForm!;
  // The RESOURCE is a form LOOKUP (added on request): the map/calendar selection is only the
  // default; any bookable unit of the same type can be picked right here.
  const [resourceId, setResourceId] = useState(target.unitId);
  // Org-wide resources (bookings view) aren't in state.units — the modal loads the same
  // org-wide pool the bookings view lists (session-cached fetch), so the type switch and the
  // resource lookup work from ANY floor; the snapshot covers the instant before it lands.
  const snap = target.resourceUnit;
  const [orgUnits, setOrgUnits] = useState<Unit[]>([]);
  useEffect(() => {
    let alive = true;
    if (isFacilioApiConfigured) fetchOrgBookableResources().then((u) => alive && setOrgUnits(u));
    return () => {
      alive = false;
    };
  }, []);
  const unitPool = useMemo(() => {
    const ids = new Set(state.units.map((u) => u.id));
    // FLOORPLAN VIEW scopes the lookup to the floor being viewed (requested): booking from a plan
    // means booking something ON that plan, so org-wide records are left out there. The BOOKINGS
    // calendar stays org-wide (its whole point is booking anything, incl. unplaced records).
    const onFloorplan = state.activeView === 'map';
    const pool = onFloorplan
      ? [...state.units, ...orgUnits.filter((u) => !ids.has(u.id) && u.floor === state.floorId)]
      : [...state.units, ...orgUnits.filter((u) => !ids.has(u.id))];
    if (snap && !pool.some((u) => u.id === snap.id)) pool.push(snap);
    return pool;
  }, [state.units, orgUnits, snap, state.activeView, state.floorId]);
  const unit = unitById(state, resourceId) ?? unitPool.find((u) => u.id === resourceId) ?? unitById(state, target.unitId) ?? snap ?? null;
  // The FORM SHOWN follows the type switch itself (both pills always render in All spaces —
  // requested), independent of whether a resource of that type is picked/available yet.
  const [typeOverride, setTypeOverride] = useState<UnitType | null>(null);
  const effType: UnitType = typeOverride ?? unit?.type ?? 'workstation';
  useEffect(() => {
    if (!typeOverride || unit?.type === typeOverride) return;
    const first = unitPool.find((u) => u.type === typeOverride && isBookable(u));
    if (first) setResourceId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeOverride, unitPool]);
  const module = state.bookingModule;
  const contacts = state.clientContacts;

  const defaultContact = contacts.some((c) => c.id === state.bookBy) ? state.bookBy : contacts[0]?.id ?? '';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState(defaultContact);
  const [reservedBy, setReservedBy] = useState(defaultContact);
  const [noOfAttendees, setNoOfAttendees] = useState('1');
  const [internalAttendees, setInternalAttendees] = useState<string[]>([]);
  const [externalAttendees, setExternalAttendees] = useState<string[]>([]);
  // ROOMS book a discrete slot (HARDCODED 2h, per request); desks book a free start/end time
  // window instead — no slots there. Parking/facility keep the configured slot length.
  const [slotDate, setSlotDate] = useState(target.date);
  const [slotStart, setSlotStart] = useState<number | null>(target.start);
  const [startMin, setStartMin] = useState(target.start);
  const [endMin, setEndMin] = useState(Math.max(target.end, target.start + 15));
  const [submitting, setSubmitting] = useState(false);
  // Values of org-form fields the app doesn't model natively, keyed by field name.
  const [extras, setExtras] = useState<Record<string, string>>({});

  // The org's actual configured forms (v2/forms) for this module. When more than one, a
  // switcher lets the user pick; the module's per-type default is auto-selected. Null/empty in
  // mock/offline mode or if the fetch fails — the built-in field list below stands in.
  const [formList, setFormList] = useState<BookingFormSummary[]>([]);
  const [formId, setFormId] = useState<number | null>(null);
  const [formMeta, setFormMeta] = useState<BookingFormMeta | null>(null);
  const [formLoading, setFormLoading] = useState<boolean>(isFacilioApiConfigured);

  // Step 1: load the module's form list, then auto-select the default for this unit type.
  useEffect(() => {
    let alive = true;
    if (!isFacilioApiConfigured || !unit) {
      setFormLoading(false);
      return;
    }
    fetchBookingFormList(module).then((forms) => {
      if (!alive) return;
      setFormList(forms);
      const def = pickDefaultBookingForm(forms, module, unit.type);
      if (def) setFormId(def.id);
      else setFormLoading(false); // no forms — fall back to the built-in layout
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forms the header offers for what's being booked — every booking-enabled form matching this
  // type's link-name key (deskbooking for desks, spacebooking for rooms/spaces).
  const formsForCurrentType = useMemo(() => {
    if (!unit) return [];
    // ALL SPACES mixes desks and rooms, so EVERY form for both keys is offered (requested — only
    // the space form was showing); a context view offers just its own key's forms.
    if (target.allowTypeSwitch) {
      const both = [...bookingFormsForType(formList, module, 'workstation'), ...bookingFormsForType(formList, module, 'room')];
      const seen = new Set<number>();
      return both.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
    }
    return bookingFormsForType(formList, module, effType);
  }, [formList, module, effType, unit, target.allowTypeSwitch]);

  /** Which resource type a form belongs to — picking a form in All spaces switches to it. */
  const typeOfForm = (id: number): UnitType | null => {
    if (bookingFormsForType(formList, module, 'workstation').some((f) => f.id === id)) return 'workstation';
    if (bookingFormsForType(formList, module, 'room').some((f) => f.id === id)) return 'room';
    return null;
  };

  // The All-spaces switch flips the resource TYPE — re-pick that type's own form (by link
  // name) from the already-fetched list.
  useEffect(() => {
    if (!formList.length || !unit) return;
    // A type with exactly ONE form auto-selects it; with SEVERAL the user picks from the header
    // dropdown (keep an already-valid choice, else clear so nothing is silently preselected).
    if (formsForCurrentType.length === 1) {
      if (formsForCurrentType[0].id !== formId) setFormId(formsForCurrentType[0].id);
      return;
    }
    if (formsForCurrentType.length > 1) {
      if (formId != null && formsForCurrentType.some((f) => f.id === formId)) return;
      const def = target.allowTypeSwitch ? null : pickDefaultBookingForm(formsForCurrentType, module, effType);
      setFormId(def ? def.id : null);
      return;
    }
    const def = pickDefaultBookingForm(formList, module, effType);
    if (def && def.id !== formId) setFormId(def.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effType, formList]);

  // Step 2: (re)load the selected form's fields whenever the chosen form changes.
  useEffect(() => {
    if (formId == null) {
      // Nothing chosen yet (All-spaces with several forms): drop any previously loaded form so
      // the body can't show the last form's fields under a blank picker.
      setFormMeta(null);
      setFormLoading(false);
      return;
    }
    let alive = true;
    setFormLoading(true);
    fetchBookingFormById(module, formId).then((meta) => {
      if (!alive) return;
      setFormMeta(meta);
      setFormLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  if (!unit) return null;

  const isFacility = module === 'facility';

  /**
   * The RESOURCE field on the currently loaded form, straight from its response metadata — used
   * both to render the lookup and to fill it in the create payload. Nothing name-hardcoded.
   */
  const formResourceField = useMemo(() => {
    if (!formMeta || !unit) return null;
    const hit = formMeta.fields.find((f) => isResourceField(f));
    return hit?.name ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formMeta, unit?.type, isFacility]);

  const isRoom = effType === 'room';
  const resourceFieldLabel = isFacility ? 'Facility' : SPACE_RESOURCE_LABEL[effType];
  const fallbackFormName = isFacility ? FACILITY_FORM_NAME[unit.type] : SPACE_FORM_NAME[unit.type];
  const reserverLabel = isFacility ? 'Reserved For' : 'Reserved By';

  // ONLY rooms book by slots (HARDCODED 2-hour). Everything else — desks, parking, lockers —
  // books a plain start/end window.
  const slotLen = 120;
  const useSlots = effType === 'room';
  // Full-day slot chips (00:00–24:00), not the old 08:00–18:00 office window.
  const slots = Array.from({ length: Math.floor((24 * 60) / slotLen) }, (_, i) => i * slotLen);
  // Desk start/end options — full day, half-hour steps, cross-filtered so end stays after start.
  const TIME_OPTIONS = Array.from({ length: 1440 / 30 + 1 }, (_, i) => i * 30).map((m) => ({ value: String(m), label: fmtTime(m) }));

  // Booking-date window: ROOMS are same-day only; desks/parking book at most ONE WEEK ahead.
  // All of it on the ORG clock — "today" is the facility's today, not the browser's.
  const nowOrg = useOrgClock(); // reactive: re-renders when the ORG zone resolves
  const minDate = nowOrg.dateISO;
  const maxDate = isRoom ? minDate : wallClockInTz(Date.now() + 7 * 86400000, orgTimezone()).dateISO;
  // For TODAY, slots that already started are off the table — the backend silently bumps a
  // past start to "now" (a 05:15 booking made at 08:16 came back as 08:19), so what you pick
  // must be what you get.
  const slotSelectable = (m: number) => slotDate !== minDate || m >= nowOrg.minutes;

  const contactOptions = contacts.map((c) => ({ value: c.id, label: c.name, sublabel: c.client }));

  /** Any resource-family field, read from the form's own lookup metadata. */
  function isResourceFamilyField(f: BookingFormFieldMeta): boolean {
    const lm = (f.lookupModule ?? '').toLowerCase();
    return lm === 'facility' || lm in RESOURCE_LOOKUP_TYPE;
  }

  /**
   * THE resource field for the unit being booked — type-aware: a ROOM fills the space/Location
   * field (spacebooking's `space` lookup), never the Desk field, and vice versa. Other
   * resource-family fields on a shared form are skipped entirely (see renderOrgField).
   */
  function isResourceField(f: BookingFormFieldMeta): boolean {
    const lm = (f.lookupModule ?? '').toLowerCase();
    const nm = baseFieldName(f.name);
    if (isFacility) return lm === 'facility';
    // The lookup's own target module decides which unit type it books — read per form fetch.
    if (lm in RESOURCE_LOOKUP_TYPE) return RESOURCE_LOOKUP_TYPE[lm] === unit!.type;
    switch (unit!.type) {
      case 'room':
        return ['space', 'location'].includes(nm);
      case 'workstation':
        return nm === 'desk';
      case 'parking':
        return nm === 'parking';
      case 'locker':
        return nm === 'locker';
      default:
        return isResourceFamilyField(f);
    }
  }

  /** Org fields rendered generically (not mapped to a dedicated control) → typed extras for the API. */
  function collectExtras(meta: BookingFormMeta | null): { values: Record<string, unknown>; missing: string | null } {
    if (!meta) return { values: {}, missing: null };
    const values: Record<string, unknown> = {};
    for (const f of meta.fields) {
      // The WHOLE resource family is excluded from extras — the create payload's own lookup
      // carries the resource, and a shared form's other-type field (Desk on a room booking)
      // must neither travel nor block submit as "required".
      if (KNOWN_FIELDS.has(f.name) || isResourceFamilyField(f)) continue;
      const raw = (extras[f.name] ?? '').trim();
      if (!raw) {
        if (f.required) return { values, missing: f.label || f.name };
        continue;
      }
      if (f.lookupModule) {
        // ANY lookup field travels as {id} (confirmed live — department/building/floor all send
        // {id} in a real create payload, not just people lookups). Mock ids ("c1") have no
        // backend record and are dropped.
        const id = Number(raw);
        if (Number.isFinite(id)) values[f.name] = { id };
        else if (f.required) return { values, missing: f.label || f.name };
      } else if (f.type === 'NUMBER' || f.type === 'DECIMAL') values[f.name] = Number(raw);
      else if (f.type === 'DATE' || f.type === 'DATETIME') {
        // EPOCH MILLIS on the wire, interpreted in the ORG timezone — Date.parse read a bare
        // date as UTC and a datetime as browser-local, shifting both against the facility.
        const [d, t] = raw.split('T');
        const [hh, mm] = (t ?? '00:00').split(':').map(Number);
        const ts = /^\d{4}-\d{2}-\d{2}$/.test(d) ? epochAtInTz(d, (hh || 0) * 60 + (mm || 0), orgTimezone()) : Date.parse(raw);
        if (Number.isFinite(ts)) values[f.name] = ts;
      } else if (f.type === 'DECISION_BOX') values[f.name] = raw === '1';
      else values[f.name] = raw;
    }
    return { values, missing: null };
  }

  async function onSubmit() {
    if (!unit || unit.type !== effType) {
      actions.showToast(`Pick a ${resourceFieldLabel.toLowerCase()} first`);
      return;
    }
    // ISO strings compare lexicographically — the min/max attributes hint, this enforces.
    if (slotDate < minDate || slotDate > maxDate) {
      actions.showToast(isRoom ? 'Rooms can only be booked for today' : 'Bookings can be made at most one week ahead');
      return;
    }
    let start: number;
    let end: number;
    if (useSlots) {
      if (slotStart == null) {
        actions.showToast('Pick a time slot');
        return;
      }
      if (!slotSelectable(slotStart)) {
        actions.showToast('That slot has already started — pick an upcoming one');
        return;
      }
      start = slotStart;
      end = slotStart + slotLen;
    } else {
      // Desk path: free start/end window (no slots).
      if (endMin <= startMin) {
        actions.showToast('End time must be after the start time');
        return;
      }
      if (!slotSelectable(startMin)) {
        actions.showToast('That start time has already passed — pick an upcoming one');
        return;
      }
      start = startMin;
      end = endMin;
    }
    const date = slotDate;
    // Known/built-in fields are rendered with a required indicator (the real org form's own
    // `required` flag when one's loaded, else the hardcoded fallback layout's required set) but
    // were never actually validated before submit — only the generic org-form extras were.
    const usingOrgForm = !!formMeta && formMeta.fields.length > 0;
    const isRequired = (fieldName: string, fallbackRequired: boolean): boolean =>
      usingOrgForm ? !!formMeta!.fields.find((f) => f.name === fieldName)?.required : fallbackRequired;
    if (isRequired('name', !isFacility) && !name.trim()) {
      actions.showToast('“Name” is required');
      return;
    }
    if (isRequired('host', !isFacility) && !host) {
      actions.showToast('“Host” is required');
      return;
    }
    if (isRequired('reservedBy', true) && !reservedBy) {
      actions.showToast(`“${reserverLabel}” is required`);
      return;
    }
    if (isRequired('noOfAttendees', true) && !(Number(noOfAttendees) > 0)) {
      actions.showToast('“Number Of Attendees” is required');
      return;
    }
    if (isRequired('internalAttendees', false) && internalAttendees.length === 0) {
      actions.showToast('“Internal Attendees” is required');
      return;
    }
    if (isRequired('externalAttendees', false) && externalAttendees.length === 0) {
      actions.showToast('“External Attendees” is required');
      return;
    }

    const { values: extraValues, missing } = collectExtras(formMeta);
    if (missing) {
      actions.showToast(`“${missing}” is required`);
      return;
    }
    setSubmitting(true);
    const ok = await actions.submitBooking({
      unitId: unit!.id,
      date,
      start,
      end,
      name: name.trim() || `${unit!.label} booking`,
      description: description.trim(),
      host,
      reservedBy,
      noOfAttendees: Number(noOfAttendees) || 1,
      internalAttendees,
      externalAttendees,
      formId: formMeta?.id,
      extras: extraValues,
      // The form's own resource lookup name (from its response) so the create fills it too.
      resourceField: formResourceField ?? undefined,
    });
    setSubmitting(false);
    if (ok) actions.closeBookingForm();
  }

  // Bookable units of the SAME type as the picked one — the lookup's option set, org-wide.
  const resourceOptions = unitPool
    .filter((u) => u.type === effType && isBookable(u))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map((u) => ({ value: u.id, label: u.label, sublabel: u.room ?? u.secondary ?? undefined }));

  const resourceControl = (
    <Select
      value={unit && unit.type === effType ? resourceId : null}
      options={resourceOptions}
      onChange={setResourceId}
      placeholder={`Select a ${resourceFieldLabel.toLowerCase()}`}
      fullWidth
      aria-label={resourceFieldLabel}
    />
  );

  const resourceRow = (
    <Field key="__resource" label={resourceFieldLabel} required>
      {resourceControl}
    </Field>
  );

  // EXISTING BOOKINGS for the selected resource on the chosen date (requested): fetched with the
  // resource-scoped filter as the range is picked, so a clash is visible BEFORE submitting.
  const [conflicts, setConflicts] = useState<{ start: number; end: number; name?: string }[]>([]);
  useEffect(() => {
    if (!isFacilioApiConfigured || !unit || !resourceId) {
      setConflicts([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      fetchOrgBookingsForRange(slotDate, slotDate, { resourceField: effType === 'room' ? 'space' : 'desk' })
        .then((rows) => {
          if (!alive) return;
          setConflicts(
            rows
              .filter((b) => b.unitId === unit.id && b.date === slotDate && b.start < endMin && b.end > startMin)
              .map((b) => ({ start: b.start, end: b.end, name: b.name }))
          );
        })
        .catch(() => alive && setConflicts([]));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit?.id, resourceId, slotDate, startMin, endMin, effType, state.bookingsNonce]);

  const conflictNote =
    conflicts.length > 0 ? (
      <div
        key="__conflict"
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          border: '1px solid #f0bcbc',
          borderLeft: '3px solid #c62828',
          background: '#fdf2f2',
          color: '#8f2323',
          borderRadius: 8,
          padding: '10px 12px',
          font: '500 12.5px/1.45 var(--font-sans)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" style={{ flex: 'none', marginTop: 1 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
        <span>
          This {effType === 'room' ? 'space' : 'desk'} is already booked{' '}
          {conflicts.map((c, i) => (
            <b key={i} style={{ fontWeight: 600 }}>
              {i > 0 ? ', ' : ''}
              {fmtTime(c.start)}–{fmtTime(c.end)}
            </b>
          ))}{' '}
          on {slotDate}. Pick another time or another {effType === 'room' ? 'space' : 'desk'}.
        </span>
      </div>
    ) : null;

  // ROOMS: hardcoded 2h slot chips. Everything else: no slots — a plain start/end window on
  // the chosen date.
  const timeWindow = !useSlots ? (
    <Field key="__time" label="Booking Window" required>
      {/* The org declares start/end as DATETIME fields, so each is one datetime control here
          (calendar + HH/MM columns, like the native picker) instead of a date plus two dropdowns.
          START is never restricted by the end — moving it drags the end to keep the duration. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className={card.label}>Start Time</div>
          <DatePicker
            value={slotDate}
            min={minDate}
            max={maxDate}
            minutes={startMin}
            minuteStep={5}
            minMinutes={nowOrg.minutes}
            onChange={(iso) => setSlotDate(iso)}
            onMinutesChange={(m) => {
              const dur = Math.max(state.slotGranularity, endMin - startMin);
              setStartMin(m);
              setEndMin(Math.min(1440, m + dur));
            }}
            fullWidth
            aria-label="Start time"
          />
        </div>
        <div>
          <div className={card.label}>End Time</div>
          <DatePicker
            value={slotDate}
            min={minDate}
            max={maxDate}
            minutes={endMin}
            minuteStep={5}
            minMinutes={startMin + 5}
            onChange={(iso) => setSlotDate(iso)}
            onMinutesChange={(m) => setEndMin(Math.max(startMin + 5, m))}
            fullWidth
            aria-label="End time"
          />
        </div>
      </div>
    </Field>
  ) : (
    <Field key="__time" label="Time Slots" required>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className={card.label}>Select Date</div>
          <DatePicker value={slotDate} min={minDate} max={maxDate} onChange={setSlotDate} fullWidth aria-label="Booking date" />
        </div>
        <div>
          <div className={card.label}>Time Slot</div>
          <div className={card.input} style={{ display: 'flex', alignItems: 'center', color: slotStart != null ? 'var(--ink-900)' : 'var(--ink-400)' }}>
            {slotStart != null ? `${fmtTime(slotStart)} – ${fmtTime(slotStart + slotLen)}` : 'Pick a slot'}
          </div>
        </div>
      </div>
      <div className={card.label} style={{ marginTop: 12, color: 'var(--blue-600)' }}>Available Slots</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {slots.map((m) => {
          const selectable = slotSelectable(m);
          return (
            <button
              key={m}
              type="button"
              disabled={!selectable}
              title={selectable ? undefined : 'Already past'}
              onClick={() => setSlotStart(m)}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: `1px solid ${slotStart === m ? 'var(--blue-500)' : 'var(--ink-200)'}`,
                background: selectable ? (slotStart === m ? 'var(--blue-025)' : '#fff') : 'var(--ink-050)',
                color: selectable ? (slotStart === m ? 'var(--blue-600)' : 'var(--ink-700)') : 'var(--ink-300)',
                font: '500 12px/1 var(--font-sans)',
                cursor: selectable ? 'pointer' : 'not-allowed',
              }}
            >
              {fmtTime(m)}
            </button>
          );
        })}
      </div>
    </Field>
  );

  /** One org-form field → the matching control (dedicated where the app models it, generic otherwise). */
  function renderOrgField(f: BookingFormFieldMeta, flags: { time: boolean; resource: boolean }): ReactNode {
    switch (f.name) {
      case 'name':
        return (
          <Field key={f.name} label={f.label || 'Name'} required={f.required}>
            <input className={card.input} value={name} placeholder="Enter your text here" onChange={(e) => setName(e.target.value)} />
          </Field>
        );
      case 'description':
        return (
          <Field key={f.name} label={f.label || 'Description'} required={f.required}>
            <textarea className={card.input} style={{ height: 72, padding: '8px 10px', resize: 'vertical' }} value={description} placeholder="Type your description here" onChange={(e) => setDescription(e.target.value)} />
          </Field>
        );
      case 'host':
        return (
          <Field key={f.name} label={f.label || 'Host'} required={f.required}>
            <Select value={host || null} options={contactOptions} onChange={setHost} placeholder="Select an option" fullWidth aria-label={f.label || 'Host'} />
          </Field>
        );
      case 'reservedBy':
        return (
          <Field key={f.name} label={f.label || reserverLabel} required={f.required}>
            <Select value={reservedBy || null} options={contactOptions} onChange={setReservedBy} placeholder="Select an option" fullWidth aria-label={f.label || reserverLabel} />
          </Field>
        );
      case 'noOfAttendees':
        return (
          <Field key={f.name} label={f.label || 'Number Of Attendees'} required={f.required}>
            <input className={card.input} type="number" min={1} value={noOfAttendees} placeholder="Input numerical value" onChange={(e) => setNoOfAttendees(e.target.value)} />
          </Field>
        );
      case 'bookingStartTime':
      case 'bookingEndTime':
        if (flags.time) return null;
        flags.time = true;
        return timeWindow;
      default:
        break;
    }
    // The org form's OWN start/end time inputs are always replaced by this app's hardcoded window
    // controls (requested): desks get date + start/end within a 7-day window, rooms get same-day
    // 2h slots. Any DATETIME field on a booking form is part of that window, so it collapses into
    // the single `timeWindow` block instead of rendering a raw datetime input.
    if (/DATE_?TIME/i.test(f.type)) {
      if (flags.time) return null;
      flags.time = true;
      return timeWindow;
    }
    switch (f.name) {
      case 'internalAttendees':
        return (
          <Field key={f.name} label={f.label || 'Internal Attendees'} required={f.required}>
            <AttendeePicker contacts={contacts} selected={internalAttendees} onChange={setInternalAttendees} placeholder="Select one or more options" />
          </Field>
        );
      case 'externalAttendees':
        return (
          <Field key={f.name} label={f.label || 'External Attendees'} required={f.required}>
            <AttendeePicker contacts={contacts} selected={externalAttendees} onChange={setExternalAttendees} placeholder="Select one or more options" />
          </Field>
        );
      default:
        break;
    }
    if (isResourceField(f)) {
      flags.resource = true;
      return (
        <Field key={f.name} label={f.label || resourceFieldLabel} required={f.required}>
          {resourceControl}
        </Field>
      );
    }
    // Resource-family fields for OTHER unit types (a shared form's Desk field on a room
    // booking) aren't editable here — the payload's own lookup carries the resource.
    if (isResourceFamilyField(f)) return null;
    // People lookups the app doesn't model (e.g. approvers) → employee select into extras.
    if (f.lookupModule && PEOPLE_LOOKUPS.has(f.lookupModule.toLowerCase())) {
      return (
        <Field key={f.name} label={f.label || f.name} required={f.required}>
          <Select
            value={extras[f.name] || null}
            options={contactOptions}
            onChange={(v) => setExtras((x) => ({ ...x, [f.name]: v }))}
            placeholder="Select an option"
            fullWidth
            aria-label={f.label || f.name}
          />
        </Field>
      );
    }
    // A LOOKUP-typed field the app couldn't resolve must NEVER become a free-text box (typing a
    // label into a lookup writes garbage) — it's skipped, with one console line naming it so an
    // unrecognized org lookup can be mapped properly.
    if (/LOOKUP/i.test(f.type)) {
      // eslint-disable-next-line no-console
      console.info(`[booking-form] unmapped lookup field skipped: ${f.name} (type ${f.type}, module ${f.lookupModule ?? '?'})`);
      return null;
    }
    // Generic fallback by display type — value travels in `extras`.
    const set = (v: string) => setExtras((x) => ({ ...x, [f.name]: v }));
    const val = extras[f.name] ?? '';
    let control: ReactNode;
    if (f.type === 'TEXTAREA') control = <textarea className={card.input} style={{ height: 64, padding: '8px 10px', resize: 'vertical' }} value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'NUMBER' || f.type === 'DECIMAL') control = <input className={card.input} type="number" value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'DATE') control = <DatePicker value={val} onChange={set} fullWidth aria-label={f.label || f.name} />;
    else if (f.type === 'DATETIME') control = <input className={card.input} type="datetime-local" value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'DECISION_BOX')
      control = (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: '400 12.5px/1 var(--font-sans)', color: 'var(--ink-700)' }}>
          <input type="checkbox" checked={val === '1'} onChange={(e) => set(e.target.checked ? '1' : '')} /> Yes
        </label>
      );
    else control = <input className={card.input} value={val} placeholder="Enter your text here" onChange={(e) => set(e.target.value)} />;
    return (
      <Field key={f.name} label={f.label || f.name} required={f.required}>
        {control}
      </Field>
    );
  }

  /** The org form, field by field, in its configured order. */
  function renderOrgForm(meta: BookingFormMeta): ReactNode[] {
    const flags = { time: false, resource: false };
    const nodes = meta.fields.map((f) => renderOrgField(f, flags)).filter(Boolean) as ReactNode[];
    // A booking without its resource or window makes no sense — if the org form somehow
    // omits them (custom form), pin the app's own controls rather than dropping them.
    if (!flags.resource) nodes.unshift(resourceRow);
    if (!flags.time) nodes.push(timeWindow);
    return nodes;
  }

  return (
    <Modal onClose={actions.closeBookingForm} width={560}>
      <ModalHeader
        title={isFacility ? 'Booking' : 'Space Booking'}
        subtitle={
          // API-DRIVEN form picker (requested), keyed by what's being booked: desks resolve the
          // desk form, rooms/single spaces the space form, and All-spaces offers both via the
          // type switch below. ONE form -> static display-name label, no chevron. SEVERAL ->
          // a real Select of their DISPLAY names; picking one swaps the body and the submit id.
          // The raw formId stays internal (it still travels on the create payload).
          formsForCurrentType.length > 1 ? (
            <Select
              value={formId != null ? String(formId) : ''}
              options={formsForCurrentType.map((f) => ({ value: String(f.id), label: f.displayName || f.name }))}
              placeholder="Choose a form"
              onChange={(v) => {
                const id = Number(v);
                setFormId(id);
                // In All spaces the chosen FORM decides what's being booked.
                if (target.allowTypeSwitch) {
                  const t = typeOfForm(id);
                  if (t && t !== effType) setTypeOverride(t);
                }
              }}
              size="sm"
              aria-label="Booking form"
            />
          ) : (
            <span style={{ padding: '3px 10px', borderRadius: 6, background: 'var(--ink-050)', border: '1px solid var(--ink-200)', fontSize: 12, color: 'var(--ink-700)' }}>
              {formMeta ? formMeta.displayName : formsForCurrentType[0]?.displayName || fallbackFormName}
            </span>
          )
        }
        onClose={actions.closeBookingForm}
      />
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '64vh', overflowY: 'auto' }}>
        {/* NO form switcher (removed on request): the unit type's own form is auto-picked by
            its LINK NAME (pickDefaultBookingForm) — desk bookings get only the desk form,
            space bookings only the space form. From "All spaces" (allowTypeSwitch) a TYPE
            switch flips desk/space/parking — the resource options AND the org form follow. */}
        {target.allowTypeSwitch && (
          <div role="tablist" aria-label="Booking type" style={{ display: 'flex', gap: 6 }}>
            {/* Desk and Space, BOTH always shown (requested) — the two org forms the switch
                flips between; an empty type still shows its form with the lookup awaiting. */}
            {(['workstation', 'room'] as const).map((t) => {
              const active = effType === t;
              const label = t === 'workstation' ? 'Desk' : 'Space';
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    if (!active) setTypeOverride(t);
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    border: `1px solid ${active ? 'var(--blue-500)' : 'var(--ink-200)'}`,
                    background: active ? 'var(--blue-025)' : '#fff',
                    color: active ? 'var(--blue-600)' : 'var(--ink-700)',
                    font: `${active ? 600 : 500} 12px/1 var(--font-sans)`,
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {/* CLASH BANNER at the top of the form (requested): the selected desk/space already has a
            booking in this window — fetched with the resource-scoped filter as the range changes. */}
        {conflictNote}
        {formsForCurrentType.length > 1 && formId == null ? (
          <div style={{ padding: '28px 0', textAlign: 'center', font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>
            Choose a booking form above to continue.
          </div>
        ) : formLoading ? (
          <div style={{ padding: '28px 0', textAlign: 'center', font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>
            Loading the org's booking form…
          </div>
        ) : formMeta && formMeta.fields.length > 0 ? (
          renderOrgForm(formMeta)
        ) : (
          <>
            {!isFacility && (
              <>
                <Field label="Name" required>
                  <input className={card.input} value={name} placeholder="Enter your text here" onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Description">
                  <textarea
                    className={card.input}
                    style={{ height: 72, padding: '8px 10px', resize: 'vertical' }}
                    value={description}
                    placeholder="Type your description here"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field label="Host" required>
                  <Select value={host || null} options={contactOptions} onChange={setHost} placeholder="Select an option" fullWidth aria-label="Host" />
                </Field>
              </>
            )}

            <Field label={reserverLabel} required>
              <Select value={reservedBy || null} options={contactOptions} onChange={setReservedBy} placeholder="Select an option" fullWidth aria-label={reserverLabel} />
            </Field>

            {resourceRow}

            <Field label="Number Of Attendees" required>
              <input className={card.input} type="number" min={1} value={noOfAttendees} placeholder="Input numerical value" onChange={(e) => setNoOfAttendees(e.target.value)} />
            </Field>

            {timeWindow}

            {(isFacility || isRoom) && (
              <div style={{ borderTop: '1px solid var(--ink-100)', paddingTop: 12 }}>
                <div style={{ font: '700 12px/1 var(--font-sans)', color: 'var(--ink-700)', letterSpacing: '0.03em', marginBottom: 10 }}>ATTENDEES</div>
                <Field label="Internal Attendees">
                  <AttendeePicker contacts={contacts} selected={internalAttendees} onChange={setInternalAttendees} placeholder="Select one or more options" />
                </Field>
              </div>
            )}
            {!isFacility && isRoom && (
              <Field label="External Attendees">
                <AttendeePicker contacts={contacts} selected={externalAttendees} onChange={setExternalAttendees} placeholder="Select one or more options" />
              </Field>
            )}
          </>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" disabled={submitting} onClick={actions.closeBookingForm}>Cancel</Button>
        <Button variant="primary" disabled={submitting || formLoading} onClick={onSubmit}>
          {submitting && <ButtonSpinner />}
          {submitting ? 'Saving…' : 'Submit Details'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className={card.label}>
        {required && <span style={{ color: 'var(--danger-500)', marginRight: 3 }}>*</span>}
        {label}
      </label>
      {children}
    </div>
  );
}

function AttendeePicker({
  contacts,
  selected,
  onChange,
  placeholder,
}: {
  contacts: ClientContact[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const available = contacts.filter((c) => !selected.includes(c.id));
  return (
    <div>
      <Select
        value={null}
        options={available.map((c) => ({ value: c.id, label: c.name, sublabel: c.client }))}
        onChange={(v) => onChange([...selected, v])}
        placeholder={placeholder}
        fullWidth
        aria-label="Add attendee"
      />
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {selected.map((id) => {
            const e = contacts.find((x) => x.id === id);
            return (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 6px 4px 10px', borderRadius: 999, background: 'var(--blue-025)', border: '1px solid var(--blue-200)', font: '500 12px/1 var(--font-sans)', color: 'var(--blue-700)' }}>
                {e?.name ?? id}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  style={{ border: 'none', background: 'transparent', color: 'var(--blue-600)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                  aria-label={`Remove ${e?.name ?? id}`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
