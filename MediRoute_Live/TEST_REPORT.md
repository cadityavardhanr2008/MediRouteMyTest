# MediRoute Live Field-Test Build — Verification Report

**Verification date:** 31 October 2026  
**Build:** 1.0.1 — assigned patient pickup visibility regression fix

## Automated checks completed

The project was checked from the packaged `MediRoute_Live` directory.

- `node --check` passed for every JavaScript file in the project.
- `npm test` passed: static checks and isolated backend integration tests.
- Static checks confirmed the gateway and both portals reference the required local files and contain no duplicate HTML IDs.
- Static checks confirmed demo login, demo movement, simulated request, simulated arrival and manual coordinate controls are absent from the user-facing pages.
- Static checks confirmed no demo account credentials or pre-created records are shipped.
- The shipped database starts with zero patients, zero crews and zero emergencies.
- The local server started successfully during integration testing. Gateway, patient, ambulance and shared JavaScript assets returned HTTP 200.
- `/data/mediroute-data.json` was not accessible as an HTTP static file.

### API and journey integration tests

Passed using temporary accounts and generated coordinates in an isolated temporary data directory. The test directory and data were deleted after completion.

1. Empty initial database; demo login credentials are rejected.
2. Patient and crew registration and authentication; password hashes remain server-side and are omitted from public profiles.
3. GPS validation rejects invalid coordinates, `(0, 0)`, stale fixes and inaccurate fixes.
4. A patient request remains queued when no crew is eligible.
5. The queued request is automatically assigned after an eligible crew becomes online and publishes a fresh device fix.
6. The nearest eligible crew is selected by straight-line distance; the server does not invent a road ETA at dispatch time.
7. The assigned crew's authenticated snapshot contains the patient's exact pickup latitude, longitude and address. This is the backend regression test for the reported crew-not-seeing-patient-location issue.
8. Frontend source regression checks confirm assigned-request reconstruction no longer evaluates the undefined `NO_SHIFT` identifier.
9. Frontend source regression checks confirm ambulance and patient endpoint markers are drawn before the external OSRM road-route request.
10. Frontend source regression checks confirm the pickup marker remains visible with a clear warning if road routing fails, and a Google Maps directions fallback is provided.
11. Premature pickup/hospital-arrival status changes are rejected unless recent, accurate device GPS is within the server geofence.
12. The complete journey state chain passes: `assigned → approaching → at_pickup → pickedup → enroute → arrived → completed`.
13. Patient and crew snapshots synchronize the assigned journey and location while hiding emergency-contact data from crew snapshots.
14. Completion releases the crew and increments its completed-trip count.
15. A second patient request can be made after completion; the prior completed journey remains in patient history. Patient cancellation before pickup also releases the assigned crew.
16. Runtime patient/crew/emergency data is blocked from the public static-file server.

## Additional source-level checks

- The crew heartbeat updates connection presence only; it does not refresh the timestamp of a stale GPS measurement.
- The client publishes a fresh position before asking the server to accept a geofenced arrival, preventing the location/status request race.
- The ambulance and patient portals use the shared map and synchronization code paths.
- No account is seeded on application startup.

## Not verified in this environment

These items require real browsers, network access or physical devices and must not be mistaken for passed tests:

- Automated browser navigation was attempted for the assigned-crew map regression, but the available Chromium environment blocked localhost with an administrator policy. The actual visual rendering of the crew map therefore still needs confirmation on the user's phone/laptop.
- Leaflet map tiles were not visually inspected end-to-end on a physical phone or laptop.
- Actual device GPS permissions, accuracy, background throttling, battery behaviour and movement updates were not tested on the user's Mac, phone or friend's device.
- The complete workflow was not physically tested between two devices on different internet connections.
- Public Nominatim, OSRM and tile endpoints were not load-tested or guaranteed. They can be rate-limited or temporarily unavailable.
- A real Render deployment and persistent volume were not created from the user's account. Deployment still requires the user's GitHub/hosting account and an eligible paid persistent-disk service plan.

## Honest result

The backend API lifecycle, assigned crew pickup-coordinate delivery, GPS validation, queue/assignment behaviour, geofence enforcement, account registration, data isolation and next-request logic pass automated tests. Static frontend regression checks verify that the original undefined identifier is removed and that both route endpoints are rendered before OSRM is called. Source files pass syntax checks. The two-device, real-GPS and visual map field test remains outstanding and must be completed using the README procedure before accepting this build for field testing.

**This report is not a production certification or an assurance of suitability for emergency medical dispatch.**
