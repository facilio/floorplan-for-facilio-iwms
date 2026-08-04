# Standalone Facilio booking forms

`bookingForms.tsx` is a **single self-contained file** — the floorplan app's booking form,
extracted so it can ship inside ANY Facilio connected app. It has **no imports from the
floorplan app**; its only dependency is React. All org access goes through the
FacilioAppSDK bridge (loaded automatically from the Facilio CDN), so there are no tokens,
base URLs, or CORS concerns.

## What it does

- Fetches the org's own `spacebooking` forms and auto-picks the right one **by link name**
  (desk form for desks, space form for rooms, parking form for stalls). No form switcher.
- **Rooms:** hardcoded 2-hour slot chips, same-day booking only.
- **Desks:** no slots — date + start/end time selects, bookable up to one week ahead.
- **Parking/lockers:** slot chips of `slotMinutes` (default 30), one week ahead.
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
