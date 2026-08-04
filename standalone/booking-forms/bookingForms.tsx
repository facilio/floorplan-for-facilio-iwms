/**
 * STANDALONE Facilio booking forms — one self-contained file, no imports from the floorplan app.
 *
 * Drop this file (plus React) into any Facilio CONNECTED APP and render <FacilioBookingForm>.
 * It talks to the host org through the FacilioAppSDK bridge only (loaded from the CDN below),
 * so there are no tokens, no CORS and no base URLs to configure.
 *
 * Behavior (mirrors the floorplan app's booking modal, kept in sync by hand):
 *  - The org's OWN form is used, auto-picked by its LINK NAME per resource type
 *    (desk form for desks, space form for rooms, parking form for stalls) — no form switcher.
 *  - ONLY rooms book slots (HARDCODED 2-hour); desks/parking/lockers book a plain
 *    start/end window — no slots.
 *  - Date window: rooms are same-day only; everything else books at most one week ahead.
 *    Today's already-started slots/start-times are rejected.
 *  - The create goes to `spacebooking` with the resource in the RIGHT lookup field
 *    (`desk` / `space` / `parkingStall`), `parentModuleId` resolved from the org's module list.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Facilio connected-app SDK bridge
// ---------------------------------------------------------------------------

const FACILIO_SDK_URL = 'https://static.facilio.com/apps-sdk/beta/facilio_apps_sdk.min.js';
const SDK_READY_TIMEOUT_MS = 20000;

let sdkReady: Promise<any> | null = null;
function facilioAppReady(): Promise<any> {
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`FacilioAppSDK never fired "app.loaded" within ${SDK_READY_TIMEOUT_MS}ms`));
      }
    }, SDK_READY_TIMEOUT_MS);
    const start = () => {
      try {
        const app = (window as any).FacilioAppSDK.init();
        (window as any).facilioApp = app;
        app.on('app.loaded', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(app);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    };
    if ((window as any).FacilioAppSDK) {
      start();
      return;
    }
    const script = document.createElement('script');
    script.src = FACILIO_SDK_URL;
    script.async = true;
    script.onload = start;
    script.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('failed to load FacilioAppSDK from CDN'));
      }
    };
    document.head.appendChild(script);
  });
  return sdkReady;
}

function toQueryString(params?: Record<string, unknown>): string {
  if (!params) return '';
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

/** GET on a custom (non-module) endpoint through the SDK; returns the body verbatim. */
async function customGet(path: string, params?: Record<string, unknown>): Promise<any> {
  const app = await facilioAppReady();
  const raw = await app.request.invokeFacilioAPI(`${path}${toQueryString(params)}`, { method: 'GET' });
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function fetchAll(moduleName: string, params: Record<string, unknown> = {}): Promise<{ error: any; list: any[] | null }> {
  const app = await facilioAppReady();
  return app.api.fetchAll(moduleName, params);
}

async function createRecord(moduleName: string, params: { data: Record<string, unknown> }): Promise<any> {
  const app = await facilioAppReady();
  return app.api.createRecord(moduleName, params);
}

// ---------------------------------------------------------------------------
// Booking forms API (org forms, picked by LINK NAME)
// ---------------------------------------------------------------------------

export type BookableType = 'workstation' | 'room' | 'parking' | 'locker';

export interface BookingFormFieldMeta {
  name: string;
  label: string;
  required: boolean;
  /** Facilio displayTypeEnum: TEXTBOX / TEXTAREA / NUMBER / DATETIME / LOOKUP_SIMPLE / … */
  type: string;
  lookupModule?: string;
  sequence: number;
}

export interface BookingFormMeta {
  id: number;
  name: string;
  displayName: string;
  fields: BookingFormFieldMeta[];
}

interface BookingFormSummary {
  id: number;
  name: string;
  displayName: string;
  hideInList?: boolean | null;
}

/** Form LINK-NAME preferences per resource type — never the display name. */
const FORM_LINKNAME_PREFERENCE: Partial<Record<BookableType | 'default', RegExp[]>> = {
  workstation: [/desk/i],
  parking: [/parking/i],
  room: [/^space_/i, /spacebooking/i],
  default: [/default_spacebooking/i, /spacebooking/i],
};

export async function fetchBookingForm(unitType: BookableType): Promise<BookingFormMeta | null> {
  const listBody = await customGet('v2/spacebooking/forms', { moduleName: 'spacebooking', skipPermission: true }).catch(() => null);
  const forms: BookingFormSummary[] = (listBody?.result?.forms ?? []).filter((f: BookingFormSummary) => !f.hideInList);
  if (!forms.length) return null;
  const patterns = [...(FORM_LINKNAME_PREFERENCE[unitType] ?? []), ...(FORM_LINKNAME_PREFERENCE.default ?? [])];
  let chosen: BookingFormSummary | undefined;
  for (const re of patterns) {
    chosen = forms.find((f) => re.test(f.name ?? ''));
    if (chosen) break;
  }
  chosen = chosen ?? forms[0];

  const detailBody = await customGet('v2/forms/spacebooking', {
    fetchFormRuleFields: true,
    forCreate: true,
    formId: chosen.id,
    skipPermission: true,
  }).catch(() => null);
  const form = detailBody?.result?.form ?? (detailBody?.result?.sections ? detailBody.result : null);
  if (!form) return { id: chosen.id, name: chosen.name, displayName: chosen.displayName, fields: [] };

  const fields: BookingFormFieldMeta[] = ((form.sections ?? []) as { fields?: any[] }[])
    .flatMap((s) => s.fields ?? [])
    .map((ff: any) => ({
      name: ff.field?.name ?? ff.fieldName ?? '',
      label: ff.displayName ?? ff.field?.displayName ?? '',
      required: !!ff.required,
      type: ff.displayTypeEnum ?? ff.field?.displayTypeEnum ?? 'TEXTBOX',
      lookupModule: ff.field?.lookupModule?.name,
      sequence: ff.sequenceNumber ?? 0,
    }))
    .filter((f: BookingFormFieldMeta) => f.name)
    .sort((a: BookingFormFieldMeta, b: BookingFormFieldMeta) => a.sequence - b.sequence);

  return { id: form.id, name: form.name, displayName: form.displayName, fields };
}

// ---------------------------------------------------------------------------
// Create payload (spacebooking)
// ---------------------------------------------------------------------------

/** The spacebooking lookup FIELD the resource travels in, per type. */
const RESOURCE_LOOKUP_FIELD: Record<BookableType, string> = {
  workstation: 'desk',
  room: 'space',
  parking: 'parkingStall',
  locker: 'locker',
};
/** The resource's own module (for parentModuleId resolution). */
const RESOURCE_MODULE: Record<BookableType, string> = {
  workstation: 'desks',
  room: 'space',
  parking: 'parkingstall',
  locker: 'lockers',
};

let modulesCache: Promise<Map<string, number>> | null = null;
function moduleIdByName(): Promise<Map<string, number>> {
  if (!modulesCache) {
    modulesCache = customGet('v3/modules/list/all', { skipPermission: true })
      .then((body: any) => {
        const map = new Map<string, number>();
        const lists = [body?.data?.modules, body?.data?.systemModules, body?.data?.customModules, body?.modules].filter(Array.isArray);
        for (const list of lists) {
          for (const m of list as any[]) {
            const id = Number(m?.id ?? m?.moduleId);
            const name = m?.name ?? m?.moduleName;
            if (name && Number.isFinite(id)) map.set(String(name), id);
          }
        }
        return map;
      })
      .catch(() => new Map());
  }
  return modulesCache;
}

// ---- ORG TIMEZONE: wire values are EPOCH MILLIS computed in the org's zone; "today"/"now"
// guards read the org clock (browser zone = unresolved fallback).
let orgTzCache: Promise<string | null> | null = null;
function fetchOrgTimezone(): Promise<string | null> {
  if (!orgTzCache) {
    orgTzCache = customGet('v2/account')
      .catch(() => null)
      .then((body: any) => {
        const account = body?.result?.account ?? body?.account ?? null;
        for (const tz of [account?.org?.timezone, account?.org?.timeZone, account?.user?.timezone]) {
          if (typeof tz === 'string' && tz) {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: tz });
              return tz;
            } catch {
              /* next */
            }
          }
        }
        return null;
      });
  }
  return orgTzCache;
}
function tzParts(at: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((q) => q.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}
function tzOffsetMs(tz: string, at: number): number {
  const q = tzParts(at, tz);
  return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - at;
}
function epochAt(dateISO: string, minutes: number, tz: string | null): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  if (!tz) return new Date(y, (m || 1) - 1, d || 1, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, Math.floor(minutes / 60), minutes % 60, 0, 0);
  let t = guess - tzOffsetMs(tz, guess);
  const off2 = tzOffsetMs(tz, t);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}
function dateISOInTz(at: number, tz: string | null): string {
  if (!tz) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const q = tzParts(at, tz);
  return `${q.y}-${String(q.mo).padStart(2, '0')}-${String(q.d).padStart(2, '0')}`;
}
function orgNowIn(tz: string | null): { dateISO: string; minutes: number } {
  if (!tz) {
    const d = new Date();
    return { dateISO: dateISOInTz(Date.now(), null), minutes: d.getHours() * 60 + d.getMinutes() };
  }
  const q = tzParts(Date.now(), tz);
  return { dateISO: dateISOInTz(Date.now(), tz), minutes: q.h * 60 + q.mi };
}

export interface CreateBookingInput {
  unitType: BookableType;
  resourceId: number;
  resourceLabel: string;
  dateISO: string;
  startMinutes: number;
  endMinutes: number;
  name?: string;
  description?: string;
  /** clientcontact record ids */
  host?: number;
  reservedBy?: number;
  noOfAttendees?: number;
  internalAttendees?: number[];
  externalAttendees?: number[];
  formId?: number;
  /** Extra org-form field values keyed by field name (lookups as {id}). */
  extras?: Record<string, unknown>;
}

export async function createSpaceBooking(input: CreateBookingInput): Promise<{ ok: boolean; id?: number; reason?: string }> {
  const tz = await fetchOrgTimezone().catch(() => null);
  const lookupField = RESOURCE_LOOKUP_FIELD[input.unitType];
  const parentModuleId = (await moduleIdByName()).get(RESOURCE_MODULE[input.unitType]) ?? null;
  if (!parentModuleId) return { ok: false, reason: 'could not resolve parentModuleId' };

  const internal = (input.internalAttendees ?? []).map((id) => ({ id }));
  // spacebooking requires at least one internal attendee — default to the reserver.
  if (input.reservedBy && !internal.some((a) => a.id === input.reservedBy)) internal.unshift({ id: input.reservedBy });

  const res = await createRecord('spacebooking', {
    data: {
      ...(input.extras ?? {}),
      ...(input.formId ? { formId: input.formId, actionFormId: input.formId } : {}),
      [lookupField]: { id: input.resourceId },
      parentModuleId,
      bookingStartTime: epochAt(input.dateISO, input.startMinutes, tz),
      bookingEndTime: epochAt(input.dateISO, input.endMinutes, tz),
      noOfAttendees: input.noOfAttendees && input.noOfAttendees > 0 ? input.noOfAttendees : Math.max(1, internal.length),
      name: input.name || `${input.resourceLabel} booking`,
      ...(input.description ? { description: input.description } : {}),
      internalAttendees: internal,
      externalAttendees: (input.externalAttendees ?? []).map((id) => ({ id })),
      ...(input.reservedBy ? { reservedBy: { id: input.reservedBy } } : {}),
      ...(input.host ? { host: { id: input.host } } : {}),
    },
  });
  if (res.error) return { ok: false, reason: res.error.message || `code ${res.error.code}` };
  return { ok: true, id: res.spacebooking?.id };
}

// ---------------------------------------------------------------------------
// <FacilioBookingForm> — the form UI
// ---------------------------------------------------------------------------

const fmtTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const ROOM_SLOT_MINUTES = 120; // rooms book HARDCODED 2h slots
const KNOWN_FIELDS = new Set(['name', 'description', 'host', 'reservedBy', 'noOfAttendees', 'bookingStartTime', 'bookingEndTime', 'internalAttendees', 'externalAttendees']);
const RESOURCE_LOOKUPS = new Set(['desks', 'space', 'basespace', 'parkingstall', 'facility', 'parkinglot', 'lockers']);
const PEOPLE_LOOKUPS = new Set(['people', 'employee', 'clientcontact', 'users']);

const S: Record<string, CSSProperties> = {
  root: { font: '400 13.5px/1.45 system-ui, sans-serif', color: '#1c2733', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 },
  label: { display: 'block', font: '600 11.5px/1 system-ui, sans-serif', color: '#5b6b7d', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.03em' },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #d5dce4', font: 'inherit', background: '#fff' },
  chip: { padding: '6px 10px', borderRadius: 6, border: '1px solid #d5dce4', background: '#fff', font: '500 12px/1 system-ui, sans-serif', cursor: 'pointer' },
  chipActive: { border: '1px solid #0059d6', background: '#eef4fd', color: '#0059d6' },
  chipDisabled: { background: '#f2f4f7', color: '#b3bdc9', cursor: 'not-allowed' },
  button: { padding: '10px 16px', borderRadius: 8, border: 'none', background: '#0059d6', color: '#fff', font: '600 13.5px system-ui, sans-serif', cursor: 'pointer' },
  error: { color: '#b61919', font: '500 12.5px system-ui, sans-serif' },
};

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label style={S.label}>
        {required && <span style={{ color: '#b61919', marginRight: 3 }}>*</span>}
        {label}
      </label>
      {children}
    </div>
  );
}

export interface FacilioBookingFormProps {
  unitType: BookableType;
  resourceId: number;
  resourceLabel: string;
  onDone?: (bookingId: number) => void;
  onCancel?: () => void;
}

export function FacilioBookingForm({ unitType, resourceId, resourceLabel, onDone, onCancel }: FacilioBookingFormProps) {
  const isRoom = unitType === 'room';
  // ONLY rooms book by slots — desks, parking, and lockers all book a plain start/end window.
  const useSlots = isRoom;
  const slotLen = ROOM_SLOT_MINUTES;

  // Date window: rooms same-day only; everything else at most one week ahead — ORG clock.
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchOrgTimezone().then((z) => alive && setTz(z));
    return () => {
      alive = false;
    };
  }, []);
  const nowOrg = orgNowIn(tz);
  const minDate = nowOrg.dateISO;
  const maxDate = isRoom ? minDate : dateISOInTz(Date.now() + 7 * 86400000, tz);
  const nowMinutes = nowOrg.minutes;

  const [form, setForm] = useState<BookingFormMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<{ id: number; name: string }[]>([]);
  const [date, setDate] = useState(minDate);
  const [slotStart, setSlotStart] = useState<number | null>(null);
  const [startMin, setStartMin] = useState(Math.ceil(nowMinutes / 30) * 30);
  const [endMin, setEndMin] = useState(Math.min(1440, Math.ceil(nowMinutes / 30) * 30 + 60));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState<number | ''>('');
  const [reservedBy, setReservedBy] = useState<number | ''>('');
  const [noOfAttendees, setNoOfAttendees] = useState('1');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchBookingForm(unitType)
      .then((f) => alive && setForm(f))
      .finally(() => alive && setLoading(false));
    fetchAll('clientcontact', { page: 1, perPage: 500 })
      .then((res) => alive && setContacts((res.list ?? []).map((c: any) => ({ id: Number(c.id), name: c.name }))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [unitType]);

  const slots = useMemo(() => Array.from({ length: Math.floor(1440 / slotLen) }, (_, i) => i * slotLen), [slotLen]);
  const slotSelectable = (m: number) => date !== minDate || m >= nowMinutes;
  const TIME_OPTIONS = useMemo(() => Array.from({ length: 1440 / 30 + 1 }, (_, i) => i * 30), []);

  async function onSubmit() {
    setError(null);
    if (date < minDate || date > maxDate) {
      setError(isRoom ? 'Rooms can only be booked for today.' : 'Bookings can be made at most one week ahead.');
      return;
    }
    let start: number;
    let end: number;
    if (useSlots) {
      if (slotStart == null) return setError('Pick a time slot.');
      if (!slotSelectable(slotStart)) return setError('That slot has already started — pick an upcoming one.');
      start = slotStart;
      end = slotStart + slotLen;
    } else {
      if (endMin <= startMin) return setError('End time must be after the start time.');
      if (!slotSelectable(startMin)) return setError('That start time has already passed.');
      start = startMin;
      end = endMin;
    }
    for (const f of form?.fields ?? []) {
      if (KNOWN_FIELDS.has(f.name) || RESOURCE_LOOKUPS.has((f.lookupModule ?? '').toLowerCase())) continue;
      if (f.required && !(extras[f.name] ?? '').trim()) return setError(`“${f.label || f.name}” is required.`);
    }
    setSubmitting(true);
    const extraValues: Record<string, unknown> = {};
    for (const f of form?.fields ?? []) {
      const raw = (extras[f.name] ?? '').trim();
      if (!raw || KNOWN_FIELDS.has(f.name) || RESOURCE_LOOKUPS.has((f.lookupModule ?? '').toLowerCase())) continue;
      if (f.lookupModule) {
        const id = Number(raw);
        if (Number.isFinite(id)) extraValues[f.name] = { id };
      } else if (f.type === 'NUMBER' || f.type === 'DECIMAL') extraValues[f.name] = Number(raw);
      else if (f.type === 'DECISION_BOX') extraValues[f.name] = raw === '1';
      else extraValues[f.name] = raw;
    }
    const res = await createSpaceBooking({
      unitType,
      resourceId,
      resourceLabel,
      dateISO: date,
      startMinutes: start,
      endMinutes: end,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      host: host || undefined,
      reservedBy: reservedBy || undefined,
      noOfAttendees: Number(noOfAttendees) || 1,
      formId: form?.id,
      extras: extraValues,
    });
    setSubmitting(false);
    if (!res.ok) setError(res.reason ?? 'Booking failed.');
    else if (res.id) onDone?.(res.id);
  }

  const contactSelect = (value: number | '', onChange: (v: number | '') => void, label: string, required?: boolean) => (
    <Field label={label} required={required}>
      <select style={S.input} value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
        <option value="">— Select —</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );

  if (loading) return <div style={S.root}>Loading the org's booking form…</div>;

  return (
    <div style={S.root}>
      <Field label={isRoom ? 'Location' : unitType === 'parking' ? 'Parking' : 'Desk'} required>
        <div style={{ ...S.input, background: '#f2f4f7' }}>{resourceLabel}</div>
      </Field>

      <Field label="Name">
        <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your text here" />
      </Field>
      <Field label="Description">
        <textarea style={{ ...S.input, height: 64, resize: 'vertical' }} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {contactSelect(host, setHost, 'Host')}
      {contactSelect(reservedBy, setReservedBy, 'Reserved By', true)}
      <Field label="Number Of Attendees">
        <input style={S.input} type="number" min={1} value={noOfAttendees} onChange={(e) => setNoOfAttendees(e.target.value)} />
      </Field>

      {/* Time controls: rooms = 2h slots, desks = start/end, parking/locker = slotMinutes chips */}
      <Field label={useSlots ? 'Time Slots' : 'Booking Window'} required>
        <div style={{ display: 'grid', gridTemplateColumns: useSlots ? '1fr' : '1fr 1fr 1fr', gap: 12 }}>
          <input style={S.input} type="date" value={date} min={minDate} max={maxDate} onChange={(e) => setDate(e.target.value)} />
          {!useSlots && (
            <>
              <select style={S.input} value={startMin} onChange={(e) => setStartMin(Number(e.target.value))}>
                {TIME_OPTIONS.filter((m) => m < endMin).map((m) => (
                  <option key={m} value={m}>
                    {fmtTime(m)}
                  </option>
                ))}
              </select>
              <select style={S.input} value={endMin} onChange={(e) => setEndMin(Number(e.target.value))}>
                {TIME_OPTIONS.filter((m) => m > startMin).map((m) => (
                  <option key={m} value={m}>
                    {fmtTime(m)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {useSlots && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {slots.map((m) => {
              const selectable = slotSelectable(m);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={!selectable}
                  onClick={() => setSlotStart(m)}
                  style={{ ...S.chip, ...(slotStart === m ? S.chipActive : {}), ...(selectable ? {} : S.chipDisabled) }}
                >
                  {fmtTime(m)} – {fmtTime(m + slotLen)}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      {/* Org-form fields the block above doesn't model — rendered generically. */}
      {(form?.fields ?? [])
        .filter((f) => !KNOWN_FIELDS.has(f.name) && !RESOURCE_LOOKUPS.has((f.lookupModule ?? '').toLowerCase()))
        .map((f) => (
          <Field key={f.name} label={f.label || f.name} required={f.required}>
            {f.lookupModule && PEOPLE_LOOKUPS.has(f.lookupModule.toLowerCase()) ? (
              <select style={S.input} value={extras[f.name] ?? ''} onChange={(e) => setExtras((x) => ({ ...x, [f.name]: e.target.value }))}>
                <option value="">— Select —</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : f.type === 'TEXTAREA' ? (
              <textarea style={{ ...S.input, height: 56 }} value={extras[f.name] ?? ''} onChange={(e) => setExtras((x) => ({ ...x, [f.name]: e.target.value }))} />
            ) : (
              <input
                style={S.input}
                type={f.type === 'NUMBER' || f.type === 'DECIMAL' ? 'number' : f.type === 'DATE' ? 'date' : f.type === 'DATETIME' ? 'datetime-local' : 'text'}
                value={extras[f.name] ?? ''}
                onChange={(e) => setExtras((x) => ({ ...x, [f.name]: e.target.value }))}
              />
            )}
          </Field>
        ))}

      {error && <div style={S.error}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        {onCancel && (
          <button type="button" style={{ ...S.button, background: '#fff', color: '#1c2733', border: '1.5px solid #d5dce4' }} onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button type="button" style={S.button} onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Saving…' : 'Submit Details'}
        </button>
      </div>
    </div>
  );
}
