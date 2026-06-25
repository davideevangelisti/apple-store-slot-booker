# Timeslots API Investigation

**Date:** 2026-05-16  
**Goal:** Determine whether Apple's real timeslots API gives more granular slot data than the CDN endpoint, and if so, intercept it.

## Conclusion

**The timeslots API requires Apple Account login. There is no unauthenticated path to it.**  
The CDN approach (`retail-pz.cdn-apple.com`) remains the correct and only viable strategy.

---

## Data Sources

### CDN endpoint (unauthenticated ✓)

```
GET https://retail-pz.cdn-apple.com/product-zone-prod/availability/{YYYY-MM-DD}/{UTC_HOUR}/availability.json
```

Response shape:
```json
{
  "storeNumber": "R420",
  "appointmentsAvailable": true,
  "firstAvailableAppointment": 1747983600,
  "errorCode": null
}
```

- No authentication required
- Returns **one timestamp** — the earliest available appointment
- Updated roughly hourly (CDN cache)

### Timeslots API (requires auth ✗)

```
POST https://getsupport.apple.com/api/v1/facade/timeslots?locale=de_DE
```

- Returns individual appointment slots for a selected date and store
- **Requires Apple Account login** — redirected before any call can be made
- JWT from `window.___INITIAL_JWT__` and session cookies needed

---

## Full Booking Wizard Flow (mapped via Playwright)

All steps below were automated successfully up to the auth wall (step 8).

| Step | Action | API fired |
|------|--------|-----------|
| 1 | Load `https://getsupport.apple.com/?locale=de_DE` | `/api/v1/facade/page-init` |
| 2 | Click "Produkt auswählen" | `/api/v1/facade/content`, `/api/v1/facade/product/all` |
| 3 | Click "AirPods" category card | `/api/v1/facade/topics`, `/api/v1/facade/content` |
| 4 | *(no model selection step — goes straight to topics)* | — |
| 5 | Click "Physischer oder Flüssigkeitsschaden" | — |
| 6 | Click "Beschädigte AirPods austauschen" subtopic | — |
| 7 | Click "Weiter" (Continue) | `/api/v1/facade/triggers`, `/api/v1/facade/solutions` |
| 8 | Click "Termin vereinbaren" or "Store finden suchen" | → **Apple ID login redirect** |

### Note on topic choice

"Audio und Ton" (Audio and Sound) was tried first but its subtopic flow ("Reduktion lauter Geräusche verwenden") leads only to a phone call option — no in-store option appears. "Physischer oder Flüssigkeitsschaden" (Physical or Liquid Damage) reliably surfaces the "Termin vereinbaren" card.

---

## APIs Accessible Without Auth

| Endpoint | Description |
|----------|-------------|
| `/api/v1/facade/page-init` | Session bootstrap, JWT |
| `/api/v1/facade/product/all` | Full product list |
| `/api/v1/facade/topics` | Topics per product |
| `/api/v1/facade/content` | UI content/copy |
| `/api/v1/facade/triggers` | Dynamic question flow |
| `/api/v1/facade/solutions` | Support option cards (phone, in-store, etc.) |

## APIs Requiring Auth

| Endpoint | Description |
|----------|-------------|
| `/api/v1/facade/timeslots` | Appointment slots per store + date |

---

## Diagnostic Scripts

Both scripts kept in `src/` for reference:

- **`src/check-slots-local.ts`** — Full Playwright navigator. Steps through the entire booking wizard, intercepts all `/api/v1/facade/*` responses, and attempts to capture the timeslots payload. Run with `npx tsx src/check-slots-local.ts`.
- **`src/debug-screenshot.ts`** — One-shot script to screenshot the initial page and log visible button texts. Used early in the investigation to understand the page structure.

---

## Decision

Current checker (`src/apple-store-checker.ts`) uses the CDN `firstAvailableAppointment` timestamp. This is correct and does not need to change. The CDN value is the only unauthenticated availability signal Apple provides.

If Apple credentials are ever available, the timeslots API could be accessed by:
1. Logging in via the booking wizard (or directly via Apple ID OAuth)
2. Extracting the JWT and session cookies
3. Calling `/api/v1/facade/timeslots` with the stored session

That path is out of scope for the current unauthenticated monitoring design.
