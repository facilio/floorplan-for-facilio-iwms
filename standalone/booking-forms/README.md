# Booking forms — moved

The standalone booking-form connected app now lives in its **own repo**:

```
/Users/facilio/ConnectedApp/connectedappform
```

That folder is the deployable app (HTML + CSS + JS, no build step): upload its `app/` folder and it
runs on its own. See its README for the deploy steps, the query-string contract
(`form.html?unitType=room&resourceId=123&resourceLabel=…`) and the full behaviour spec.

The copy that used to sit here has been removed so there's only one source of truth. The rules it
implements are mirrored from this app's own booking form —
`src/components/details/BookingModal.tsx` and `src/lib/facilioApiDataSource.ts` — so when a booking
rule changes here, mirror it there (both its JS and TSX variants).
