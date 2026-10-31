# MediRoute — live-device field-test build

MediRoute has two connected web portals served by one Node.js application:

- **Patient portal** — account registration, profile and emergency contacts, pickup confirmation, ambulance tracking, journey updates and history.
- **Ambulance portal** — crew registration, availability, live device GPS, pickup navigation, patient intake, nearby hospital lookup, hospital navigation and handover.

There are **no pre-created accounts, demo credentials, seeded patients, seeded ambulances or seeded journeys**. The first user of each role creates an account through that portal. The database starts empty.

> **Important safety boundary:** This is a controlled live-device field-test build, not a certified emergency dispatch service. Do not use it to request help for a real emergency or enter real patient medical information. It does not connect to public emergency dispatch, hospital admission/bed systems or real SMS/WhatsApp delivery. Keep a real emergency number available during testing.

## 1. What the application does

1. An ambulance crew member registers or signs in, enables browser location and sets the unit to **Available**.
2. The crew browser publishes fresh device GPS fixes to the server. A heartbeat indicates that the signed-in browser is still connected, but does not refresh the timestamp of an old GPS position.
3. A patient registers or signs in, detects their location or selects a pickup point on the map, reviews the address and confirms the pickup point, then submits an emergency request.
4. If no eligible crew is online, the request remains queued. When an eligible crew is available and publishes a fresh, sufficiently accurate GPS fix, the server automatically assigns the nearest eligible crew by straight-line distance.
5. The assigned crew snapshot contains the patient's confirmed pickup address and exact coordinates. The ambulance portal immediately marks both the ambulance and patient endpoints before it requests an OSRM driving route; the patient pin therefore remains visible even if the routing provider is slow or unavailable. When OSRM succeeds, the dashed locator is replaced by the road route and its estimate. The crew also gets a one-click Google Maps directions fallback. The patient portal shows the ambulance's latest shared position and its route to the pickup point. Location and route/ETA data refresh as the crew moves.
6. Arrival at pickup is only accepted when fresh device GPS is inside the server-side pickup geofence. The crew then records the patient intake and chooses a nearby hospital listing.
7. The selected hospital becomes the shared destination. Both portals display the hospital leg, live ambulance position and road-route ETA.
8. Hospital arrival is verified against fresh device GPS. The crew confirms handover; the patient journey is completed and retained in history, the patient returns to Home, and the crew is released for another request.

### Assigned pickup visibility and routing fallback

The ambulance portal reconstructs the assigned emergency from the crew's authenticated server snapshot. That snapshot includes `pickupLocation.address` and `pickupLocation.coords`; these are not removed from the crew view. On assignment, the map immediately displays an ambulance start marker and a patient destination marker. It then requests a road route. If OSRM is down or rate-limited, the two markers and a dashed straight-line locator remain visible, but that dashed line is **not** turn-by-turn navigation. Use the visible Google Maps directions link as a navigation fallback and follow the actual road directions.

The assigned-request reconstruction also avoids the undefined shift identifier that previously stopped the ambulance screen from rendering the request. The regression test now checks the exact pickup coordinates in the assigned crew snapshot and checks that markers are drawn before the routing request is made.

## 2. Requirements

- Node.js 20 or newer (Node 22 LTS recommended).
- A current Chrome, Safari or Firefox browser.
- Internet access for Leaflet, map tiles, place search and OSRM route calculation.
- For actual GPS testing on phones or separate networks, deploy behind **HTTPS**. Browser geolocation is restricted to secure contexts and requires the user to grant permission. A plain LAN URL such as `http://192.168.x.x:4173` is not a secure context for normal browser geolocation; `localhost` is treated specially, but a friend's phone opening your laptop's LAN IP is not localhost. See [MDN Geolocation](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation).

No third-party Node packages are needed. The server uses Node.js built-in modules.

## 3. Run locally on your Mac

Open Terminal and enter the project directory (the directory containing `server.js`):

```bash
cd /path/to/MediRoute_Live
node -v
npm test
npm start
```

The server prints the local address, normally:

```text
http://localhost:4173/
```

Open that address on your Mac. Register a new patient account in the patient portal and a different new crew account in the ambulance portal. There are no default passwords.

To use another port:

```bash
PORT=4174 npm start
```

Keep the Terminal process running while the application is in use. Stop it with `Ctrl + C`.

### Same-Wi-Fi visual check (not a GPS field test)

The server also prints a LAN URL such as `http://192.168.1.25:4173/`. A second laptop on the same Wi-Fi can use that URL to check that the gateway and portals load and that the shared API can be reached. This plain HTTP LAN check is **not sufficient to verify real device GPS**. Do not try to work around browser geolocation security by changing browser security flags for real testing; use HTTPS instead.

## 4. Fastest real-GPS test without deploying the database

For your first test with your Mac and a friend in another location, you can keep the Node server and its data file on your Mac while giving both devices a temporary HTTPS address using a Cloudflare Quick Tunnel. This is a testing tunnel, not a permanent hosting setup.

1. Install Cloudflare Tunnel on your Mac:

   ```bash
   brew install cloudflared
   ```

2. In Terminal window 1, start MediRoute from this folder:

   ```bash
   npm start
   ```

3. In Terminal window 2, start the HTTPS tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:4173
   ```

4. Wait for the `https://…trycloudflare.com` address printed in the terminal. Share that exact HTTPS address with your friend. Both people must use the same address; do not mix the tunnel URL with `localhost` or the LAN IP.
5. On your friend's phone, open `https://…trycloudflare.com/ambulance/`. Register their crew account, grant location permission, and set Available.
6. On your phone, open `https://…trycloudflare.com/patient/`. Register your patient account, grant location permission, confirm the pickup point and submit a request.
7. Continue with steps 7–14 in section 5.C below, replacing the Render URL there with this `trycloudflare.com` URL.

The tunnel is temporary: the URL stops working when `cloudflared` is stopped and its hostname changes when a new quick tunnel is created. The Mac must remain awake, connected to the internet, and running both terminal processes for the test. The data file remains on your Mac under `data/`. Anyone who obtains an unprotected Quick Tunnel URL can reach the website, so use fictional test data only and do not share it publicly. Cloudflare documents an email allow-list option for restricting Quick Tunnel access; for example, add `--allowed-mail 'you@example.com,friend@example.com'` to the tunnel command if you want Cloudflare email verification in front of the app. Quick Tunnels are for testing/development and have no uptime guarantee. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

This HTTPS tunnel is the recommended way to prove actual device GPS from two different networks before deciding on permanent hosting. HTTPS is important because browser geolocation is only available in secure contexts. See [MDN Geolocation](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation).

## 5. Permanent hosting option: deploy over HTTPS

The included `render.yaml` describes a single Node web service with a persistent data volume. Use this route when you want a stable URL that does not depend on your Mac remaining online.

### A. Put the project in a private GitHub repository

1. Create a **private** repository in your GitHub account.
2. From Terminal, inside `MediRoute_Live`, run:

   ```bash
   git init
   git add .
   git commit -m "Initial MediRoute live field-test build"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_PRIVATE_REPOSITORY.git
   git push -u origin main
   ```

3. Do not add your old `mediroute-data.json`, personal files, passwords, API tokens or `.env` file. The `.gitignore` excludes the runtime database and `.env` file. The included `.env.example` contains only non-secret local settings.

### B. Deploy with the included Render Blueprint

1. Sign in to Render and choose **New → Blueprint**.
2. Connect the private GitHub repository and select its `main` branch.
3. Render reads `render.yaml`. Review the service, `DATA_DIR=/var/data`, and the persistent disk mount at `/var/data` before creating it.
4. Deploy the service. Wait for the deployment to finish and for the `/api/health` health check to pass.
5. Open the HTTPS `onrender.com` address Render gives you. Render provides managed TLS for its `onrender.com` domain and redirects HTTP to HTTPS; see [Render TLS documentation](https://render.com/docs/tls).
6. Visit `https://YOUR-SERVICE.onrender.com/api/health`. A successful response contains `ok: true` and `schemaVersion: 3`.

**Cost and persistence note:** the Blueprint uses a persistent disk because patient accounts, crew accounts and journey history must survive restarts and deploys. Render documents persistent disks as a paid-service feature; its free web services have ephemeral filesystems and cannot attach persistent disks. Do not remove the disk or run this JSON-file datastore on a free ephemeral service if you expect account and journey data to persist. See [Render persistent disks](https://render.com/docs/disks) and [Render free-instance limitations](https://render.com/docs/free).

This build uses one Node process and a file-backed store. A Render persistent disk is limited to a single service instance, so this design is for a small controlled field test, not horizontal scaling or production dispatch. Render documents that a persistent disk cannot be shared by multiple service instances.

### C. Test with two phones or laptops

Use devices on different networks to prove this is not relying on your home Wi-Fi:

1. On your friend's phone, turn on mobile data (or use another Wi-Fi) and open `https://YOUR-SERVICE.onrender.com/ambulance/`.
2. Register a new ambulance crew account. Use a unique Crew ID, unit number, email and a strong password. Do not use a real patient or emergency record.
3. Allow location while using the site. Keep the browser open and the screen awake during this test. Confirm the crew location status changes to a live GPS state and that the location map shows the device marker.
4. Set crew availability to **Available**. Keep GPS permission enabled. The server requires a recent location and connection heartbeat before dispatch can assign the unit.
5. On your phone, on a different network, open `https://YOUR-SERVICE.onrender.com/patient/`.
6. Register a separate patient account and sign in.
7. Start a request. Allow location, choose **Use my current location** or select the pickup point on the map, check the address/pin, and explicitly confirm it. Complete the required emergency details and submit.
8. The server assigns the nearest eligible crew by straight-line geographic distance. If no eligible unit is available, the request waits; it is not falsely shown as assigned.
9. On the ambulance device, confirm that the assigned request appears automatically. The patient destination pin must appear immediately, before route calculation finishes. When OSRM succeeds, the road route and ETA replace the dashed locator. If OSRM fails, the patient pin stays visible and the **Navigate to patient in Google Maps** link is available. On the patient device, open tracking and confirm the ambulance marker and route appear.
10. Move the ambulance device toward the pickup point along a safe, short, pre-agreed route. Do not operate or look at a phone while driving. The device must continue sending current GPS measurements. Arrival is only confirmed when the latest accurate fix is within the configured geofence; a button alone cannot mark arrival.
11. After arrival is confirmed, crew opens patient details, records fictional test observations, searches for nearby hospital map listings and chooses an appropriate test destination. The application routes the ambulance to that destination.
12. Confirm on the patient device that the map changes to the hospital leg and that the latest ambulance point and road ETA refresh as the crew device moves.
13. Once the ambulance is genuinely at the test hospital point and server-side GPS arrival is confirmed, crew confirms handover.
14. Confirm the patient portal returns to Home, offers a new request, and keeps the completed journey in Journey History. Confirm the crew returns to Available and can receive a second request.

For the first field test, choose a short, safe route where the phone has a clear GPS view. Test first with people and devices only; no real patient, real emergency or clinical decision should be involved.

## 6. Location, maps and the previous blank-map issue

The map is not just a static picture. The browser loads Leaflet, map tile images, and external place/route services. A white or grey map can mean the Leaflet library failed to load, the map container was measured while hidden, a tile server failed, the network blocked the tile domain, or a provider rate-limited the browser.

This build addresses several common failure modes:

- Uses one shared map service module for the patient and ambulance portals.
- Initializes map layers only when a map container is available and invalidates map size after layout changes.
- Tries multiple tile providers if the first tile endpoint errors or returns incomplete/repeated tile images.
- Does not force anonymous CORS mode on map tile images.
- Shows a status message when tile providers fail, rather than silently leaving a blank map.
- Keeps the user informed when location or routing is unavailable; it does not fabricate a GPS position.

Troubleshooting on either device:

1. Confirm the browser address starts with `https://` (not `http://192.168…` and not `file://`).
2. Confirm internet access and allow location permission for the site.
3. Reload the portal after granting permission. On the ambulance portal, wait for a fresh and accurate GPS fix. On the patient portal, explicitly detect or choose and confirm the pickup point.
4. Read the map status message below the map. It identifies a map-library/tile-service problem separately from a GPS or routing problem.
5. Open browser developer tools if the map remains blank. In Network, check whether `leaflet.css`, `leaflet.js`, tile image requests, and OSRM requests return successfully. In Console, inspect the first JavaScript error (later errors may be consequences of the first one).
6. If one tile provider is blocked by the network or temporarily unavailable, the app tries the configured alternatives. Public map providers can still be unavailable or rate-limited; no public endpoint can be guaranteed.

### GPS eligibility / no assignment

The server only treats a crew as eligible when the unit is Available and online, unassigned, and has a recent real-device GPS reading with accuracy of 500 metres or better plus a fresh heartbeat. A missing GPS point, `(0, 0)`, stale fix or poor-accuracy fix is not accepted. Server-side arrival confirmation is stricter: the device GPS must be recent, have accuracy of 80 metres or better, and be within 150 metres of the pickup/hospital destination. The crew app attempts arrival detection within about 90 metres, but the server is authoritative.

If a request is still searching, check that the crew is logged into the same deployed URL, the crew status is Available, location permission is granted, GPS accuracy is improving, and the browser remains open. A queued request is automatically considered when a valid crew becomes eligible.

## 7. What route and ETA mean

OSRM returns an estimate based on the OpenStreetMap driving network and current route geometry. It is **not live-traffic-aware**, does not know about road closures unless represented in the routing data, and is not an emergency-vehicle dispatch ETA. The first dispatch decision is based on straight-line distance to choose the nearest eligible ambulance, not fastest predicted road arrival. Do not interpret the displayed ETA as a guarantee.

Nearby hospitals are discovered as map listings. Their appearance does not verify that the hospital is open, has an available bed, accepts the patient, offers the selected specialty/equipment, or has clinically appropriate staff. Crew must use professional judgement and contact the facility independently in any legitimate care context.

## 8. Data, privacy and lifecycle

- The shipped database is empty. Users create their own patient and crew accounts.
- Passwords are stored as server-side `scrypt` hashes; plaintext passwords are not stored.
- The runtime database is excluded from Git and `/data/*` is not served over HTTP. Keep backups and restrict access to the deployment account/volume.
- Patient profile and emergency-contact details are not exposed in the crew snapshot beyond the patient information needed for the assigned workflow. Contact alert records are not delivered: they remain server-side previews.
- Sessions are held in server memory and expire after inactivity; a process restart requires users to sign in again.
- One patient can have only one active request at a time. A patient can cancel before pickup. Once pickup has been confirmed, cancellation from the patient portal is blocked; use the crew/admin operational process to handle exceptions in a real system.
- Completed requests remain in patient journey history. The crew is released and the queue is checked after handover.

## 9. Important limitations before any real-world use

This is not a certified medical, ambulance dispatch, or hospital integration product. Specifically, it has no integration to a public emergency number, ambulance fleet provider, hospital bed/availability system, hospital triage team, SMS gateway, WhatsApp provider, push-notification service, or verified crew identity/licence system. The patient intake data and hospital suggestions are not clinical decision support. ETA is not live traffic. Public Nominatim, OSRM and tile services have usage limits and availability constraints.

Before real-world use, the system needs a production security review, threat modelling, privacy/legal review, verified staff and fleet onboarding, abuse prevention/rate limiting, durable managed database, audited event delivery, observability, redundancy, disaster recovery, contractual map/routing services, hospital integrations, clinical governance and live operational procedures. The included JSON file store and in-memory sessions are deliberately limited to a single small field-test instance.

## 10. Test commands

Run these before and after local changes:

```bash
npm test
```

The tests cover static portal references, removed demo controls, an empty initial database, registration/authentication, GPS validation (including `(0, 0)`), queue auto-assignment, geofenced arrivals, ordered journey transitions, cancellation, handover, crew release, second-request flow and data-file protection. They use temporary test data and delete it afterwards.

A code/API test does not replace a real-browser test. The final report in `TEST_REPORT.md` distinguishes automated checks from the remaining two-device and visual map checks.
