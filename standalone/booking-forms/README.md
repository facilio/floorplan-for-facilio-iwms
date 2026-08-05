# Booking forms — standalone Facilio connected app

The floorplan app's booking form as its **own connected app**: upload the `app/` folder and it runs
on its own, with no build step and no dependency on the floorplan app. All org access goes through
the FacilioAppSDK bridge (loaded from the Facilio CDN), so there are no tokens, base URLs or CORS
settings to configure.

```
standalone/booking-forms/
├── app/
│   └── scripts/
│       ├── form.html         <- entry page (the upload path matters — see below)
│       └── bookingForms.js   <- the whole form, plain JS (no JSX, no bundler)
├── bookingForms.tsx          <- same form for TS/React codebases that already have a bundler
└── README.md
```

## Deploying it as a connected app

1. Upload the **`app` folder as-is**. The host serves `<app-key>/app/scripts/form.html`; a
   root-level `index.html` returns `NoSuchKey`, which is why the entry page lives at that path.
2. Allowed upload types are `css, html, jpeg, jpg, js, json, png, svg, txt, pdf` — this app ships
   only `.html` and `.js`; React/ReactDOM load from the unpkg CDN at runtime.
3. Open it with the resource in the query string. The host appends `origin` and `capp_id` itself —
   both are **required** by `FacilioAppSDK.init()`, so never strip them:

```
form.html?unitType=room&resourceId=123&resourceLabel=E-1-CO11
```

`unitType` is `workstation | room | parking | locker`; `resourceId` is the desks/space/parkingstall
record id.

Mounting it yourself from another page or script:

```js
FacilioBookingForms.mount(document.getElementById('root'), {
  unitType: 'room',
  resourceId: 123456,
  resourceLabel: 'E-1-CO11',
  onDone: function (bookingId) { /* created spacebooking id */ },
  onCancel: function () { /* closed */ },
});
```

The bundler variant is the same component:

```tsx
import { FacilioBookingForm } from './bookingForms';
<FacilioBookingForm unitType="room" resourceId={123456} resourceLabel="E-1-CO11" onDone={...} />
```

## Behaviour (same rules as the floorplan app)

**Which form** — the org's own `spacebooking` forms are matched by **link name**, not display name:
desks get the desk form, rooms/spaces the space form, stalls the parking form. When a type has
several forms the header shows a **dropdown of their display names** (picking one swaps the fields
below and the id sent on create); with one form it shows a static label. Only booking-enabled forms
are listed.

**Time rules**
- **Rooms:** hardcoded **2-hour slots**, same day only — the only type with slots.
- **Everything else:** date + start/end in **30-minute** steps, up to **one week** ahead.
- The start is never limited by the end: moving it drags the end along, keeping the duration.
- Times already past on the org's today are **shown disabled**, not hidden — and only a few of
  them, so the list doesn't open on a dead stretch of the day.
- The org form's own start/end datetime inputs are replaced by these controls.

**Clash check** — as the window changes, that resource's existing bookings for the date are fetched
(resource-scoped filter) and an error banner appears above the form when they overlap.

**Fields** — everything else on the org form renders from the form response: people lookups become
contact selects, and a lookup the app can't map is **skipped rather than rendered as a text box**
(typing a label into a lookup writes garbage). Resource lookups are identified by the field's own
`lookupModule` — `rooms` (e.g. `meeting_rooms_spacebooking`), `desks`, `space`, `parkingstall` —
never by hardcoded field names.

**What gets created** — one `spacebooking` record with:
- the resource under the module's own lookup field (`space` for rooms, `desk` for desks,
  `parkingStall` for stalls),
- `parentModuleId` resolved from the org's module list,
- `bookingStartTime` / `bookingEndTime` as **epoch millis computed in the org's timezone**,
- `bookingbreachtime` = start + 30 minutes, sent explicitly,
- the reserver auto-added to `internalAttendees`,
- `formId` + `actionFormId` of the chosen form, so backend form rules apply.

**Timezone** — resolved from `v2/fetchAccount?optimized=true` (flattened `account.timezone`, then
`account.org.timezone`), exactly like the v2 client. Every "now"/"today" guard and every epoch on
the wire uses that zone; the browser zone is only the unresolved fallback. Times display as AM/PM.

## Exports

`window.FacilioBookingForms` (JS build) / named exports (TSX build):

- `mount(el, props)` / `BookingForm`, `FacilioBookingForm` — the form itself.
- `fetchBookingFormsForType(unitType)` — every booking-enabled form for that type.
- `fetchBookingFormById(formId)` — one form's fields.
- `fetchResourceBookings(unitType, resourceId, dateISO, tz)` — that resource's bookings for a date.
- `createSpaceBooking(input)` — the confirmed create payload.

## Keeping it in sync

This folder is a **copy**, not an import — it has to stay dependency-free to ship on its own. When a
booking rule changes in the main app (`src/components/details/BookingModal.tsx`,
`src/lib/facilioApiDataSource.ts`), mirror it here in both variants.
