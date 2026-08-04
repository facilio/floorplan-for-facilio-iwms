# Standalone Facilio booking forms

The floorplan app's booking form, extracted so it can ship inside ANY Facilio connected app.
No imports from the floorplan app; all org access goes through the FacilioAppSDK bridge
(loaded automatically from the Facilio CDN) — no tokens, base URLs, or CORS concerns.

Two equivalent builds:

- **`app/scripts/form.html` + `app/scripts/bookingForms.js`** — plain JavaScript (no JSX,
  no bundler), laid out at the EXACT path the connected-app host serves
  (`<key>/app/scripts/form.html` — a root-level index 404s with NoSuchKey). Only allowed
  file types: css, html, jpeg, jpg, js, json, png, svg, txt, pdf. Upload the `app` folder
  as-is; React loads from the unpkg CDN. Embed with
  `form.html?unitType=room&resourceId=123&resourceLabel=E-1-CO11`, or call
  `FacilioBookingForms.mount(el, props)` from your own page/script.
- **`bookingForms.tsx`** — the same component for TypeScript/React codebases with a bundler.

## What it does

- Fetches the org's own `spacebooking` forms and auto-picks the right one **by link name**
  (desk form for desks, space form for rooms, parking form for stalls). No form switcher.
- **Rooms:** hardcoded 2-hour slot chips, same-day booking only — the ONLY type with slots.
- **Desks / parking / lockers:** no slots — date + start/end time selects, up to one week ahead.
- Today's already-started slots/start times are blocked client-side.
- Creates the `spacebooking` record with the resource in the correct lookup field
  (`desk` / `space` / `parkingStall`), `parentModuleId` resolved from the org's module list,
  and the reserver auto-added to `internalAttendees`.

## Usage

Copy the file into your connected app and render the component:

```tsx
import { FacilioBookingForm } from './bookingForms';

<FacilioBookingForm
  unitType="room"            // 'workstation' | 'room' | 'parking' | 'locker'
  resourceId={123456}        // the desks/space/parkingstall record id
  resourceLabel="E-1-CO11"
  onDone={(bookingId) => console.log('booked', bookingId)}
  onCancel={() => close()}
/>
```

The lower-level pieces are exported too, if you want your own UI:

- `fetchBookingForm(unitType)` — the org form (link-name picked) with its field list.
- `createSpaceBooking(input)` — the confirmed create payload.

## Keeping it in sync

This file mirrors `src/components/details/BookingModal.tsx` +
`src/lib/facilioApiDataSource.ts` in the floorplan app **by hand** — if booking rules change
there (slot lengths, date windows, form matching), update this file to match.
