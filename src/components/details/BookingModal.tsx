import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchBookingFormById, fetchBookingFormList, pickDefaultBookingForm } from '../../lib/facilioApiDataSource';
import type { BookingFormFieldMeta, BookingFormMeta, BookingFormSummary } from '../../lib/facilioApiDataSource';
import type { ClientContact, UnitType } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Select } from '../primitives/Select';
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
const RESOURCE_LOOKUPS = new Set(['desks', 'space', 'basespace', 'parkingstall', 'facility', 'parkinglot']);
const PEOPLE_LOOKUPS = new Set(['people', 'employee', 'clientcontact', 'users']);

function toLocalInput(dateISO: string, minutes: number): string {
  return `${dateISO}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function fromLocalInput(v: string): { date: string; minutes: number } {
  const [d, t] = v.split('T');
  const [h, m] = (t ?? '0:0').split(':').map(Number);
  return { date: d, minutes: (h || 0) * 60 + (m || 0) };
}

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
  const unit = unitById(state, target.unitId);
  const module = state.bookingModule;
  const contacts = state.clientContacts;

  const defaultContact = contacts.some((c) => c.id === state.bookBy) ? state.bookBy : contacts[0]?.id ?? '';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState(defaultContact);
  const [reservedBy, setReservedBy] = useState(defaultContact);
  const [noOfAttendees, setNoOfAttendees] = useState('1');
  const [startInput, setStartInput] = useState(toLocalInput(target.date, target.start));
  const [endInput, setEndInput] = useState(toLocalInput(target.date, target.end));
  const [internalAttendees, setInternalAttendees] = useState<string[]>([]);
  const [externalAttendees, setExternalAttendees] = useState<string[]>([]);
  // Facility mode books a discrete slot: a date + a start minute (slot length = slotGranularity).
  const [slotDate, setSlotDate] = useState(target.date);
  const [slotStart, setSlotStart] = useState<number | null>(target.start);
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

  // Step 2: (re)load the selected form's fields whenever the chosen form changes.
  useEffect(() => {
    if (formId == null) return;
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
  const isRoom = unit.type === 'room';
  const resourceFieldLabel = isFacility ? 'Facility' : SPACE_RESOURCE_LABEL[unit.type];
  const fallbackFormName = isFacility ? FACILITY_FORM_NAME[unit.type] : SPACE_FORM_NAME[unit.type];
  const reserverLabel = isFacility ? 'Reserved For' : 'Reserved By';

  const slotLen = state.slotGranularity;
  const slots = Array.from({ length: (18 * 60 - 8 * 60) / slotLen }, (_, i) => 8 * 60 + i * slotLen);

  const contactOptions = contacts.map((c) => ({ value: c.id, label: c.name, sublabel: c.client }));

  function isResourceField(f: BookingFormFieldMeta): boolean {
    return (f.lookupModule && RESOURCE_LOOKUPS.has(f.lookupModule.toLowerCase())) || ['desk', 'space', 'parking', 'facility', 'location'].includes(f.name.toLowerCase());
  }

  /** Org fields rendered generically (not mapped to a dedicated control) → typed extras for the API. */
  function collectExtras(meta: BookingFormMeta | null): { values: Record<string, unknown>; missing: string | null } {
    if (!meta) return { values: {}, missing: null };
    const values: Record<string, unknown> = {};
    for (const f of meta.fields) {
      if (KNOWN_FIELDS.has(f.name) || isResourceField(f)) continue;
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
        const ts = Date.parse(raw);
        if (Number.isFinite(ts)) values[f.name] = ts;
      } else if (f.type === 'DECISION_BOX') values[f.name] = raw === '1';
      else values[f.name] = raw;
    }
    return { values, missing: null };
  }

  async function onSubmit() {
    const s = fromLocalInput(startInput);
    const e = fromLocalInput(endInput);
    let date = s.date;
    let start = s.minutes;
    let end = e.minutes;
    if (isFacility) {
      if (slotStart == null) {
        actions.showToast('Pick a time slot');
        return;
      }
      date = slotDate;
      start = slotStart;
      end = slotStart + slotLen;
    }
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
    });
    setSubmitting(false);
    if (ok) actions.closeBookingForm();
  }

  const resourceRow = (
    <Field key="__resource" label={resourceFieldLabel} required>
      <div className={card.input} style={{ display: 'flex', alignItems: 'center', color: 'var(--ink-900)', background: 'var(--ink-050)' }}>
        {unit.label}
        {unit.secondary ? <span style={{ color: 'var(--ink-500)', marginLeft: 6 }}>· {unit.secondary}</span> : null}
      </div>
    </Field>
  );

  const timeWindow = !isFacility ? (
    <div key="__time" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <Field label="Start Time" required>
        <input className={card.input} type="datetime-local" value={startInput} onChange={(e) => setStartInput(e.target.value)} />
      </Field>
      <Field label="End Time" required>
        <input className={card.input} type="datetime-local" value={endInput} onChange={(e) => setEndInput(e.target.value)} />
      </Field>
    </div>
  ) : (
    <Field key="__time" label="Time Slots" required>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className={card.label}>Select Date</div>
          <input className={card.input} type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} />
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
        {slots.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setSlotStart(m)}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: `1px solid ${slotStart === m ? 'var(--blue-500)' : 'var(--ink-200)'}`,
              background: slotStart === m ? 'var(--blue-025)' : '#fff',
              color: slotStart === m ? 'var(--blue-600)' : 'var(--ink-700)',
              font: '500 12px/1 var(--font-sans)',
              cursor: 'pointer',
            }}
          >
            {fmtTime(m)}
          </button>
        ))}
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
          <div className={card.input} style={{ display: 'flex', alignItems: 'center', color: 'var(--ink-900)', background: 'var(--ink-050)' }}>
            {unit!.label}
            {unit!.secondary ? <span style={{ color: 'var(--ink-500)', marginLeft: 6 }}>· {unit!.secondary}</span> : null}
          </div>
        </Field>
      );
    }
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
    // Generic fallback by display type — value travels in `extras`.
    const set = (v: string) => setExtras((x) => ({ ...x, [f.name]: v }));
    const val = extras[f.name] ?? '';
    let control: ReactNode;
    if (f.type === 'TEXTAREA') control = <textarea className={card.input} style={{ height: 64, padding: '8px 10px', resize: 'vertical' }} value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'NUMBER' || f.type === 'DECIMAL') control = <input className={card.input} type="number" value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'DATE') control = <input className={card.input} type="date" value={val} onChange={(e) => set(e.target.value)} />;
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ padding: '3px 10px', borderRadius: 6, background: 'var(--ink-050)', border: '1px solid var(--ink-200)', fontSize: 12, color: 'var(--ink-700)' }}>
              {formMeta ? formMeta.displayName : fallbackFormName}
            </span>
            {formMeta && (
              <span title={`Org form ${formMeta.name}`} style={{ fontSize: 11, color: 'var(--ink-400)' }}>
                form #{formMeta.id}
              </span>
            )}
          </span>
        }
        onClose={actions.closeBookingForm}
      />
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '64vh', overflowY: 'auto' }}>
        {formList.length > 1 && (
          <div>
            <div className={card.label}>Form</div>
            <div role="tablist" aria-label="Booking form" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {formList.map((f) => {
                const active = f.id === formId;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={f.name}
                    onClick={() => setFormId(f.id)}
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
                    {f.displayName || f.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {formLoading ? (
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
