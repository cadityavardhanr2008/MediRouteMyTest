(function () {
    'use strict';

    var $ = function (selector, root) {
        return (root || document).querySelector(selector);
    };

    var $$ = function (selector, root) {
        return Array.from((root || document).querySelectorAll(selector));
    };

    var state = {
        user: null,
        status: 'available',
        trips: 0,
        request: null,
        patient: null,
        hospital: null,
        hospitals: [],
        notifiedAt: null,
        sharedEmergency: null,
        heartbeatTimer: null,
        lastPublishedAt: 0,
        lastRouteRefreshAt: 0,
        lastRouteRefreshPoint: null
    };

    var shiftStarted = false;
    var leg = {
        key: '',
        p: 0,
        timer: null,
        arrived: false,
        arrivalPending: false,
        minutes: 0,
        km: 0,
        from: '',
        to: '',
        token: 0,
        route: null,
        cum: null,
        t0: 0,
        duration: 0,
        start: null,
        end: null,
    };

    function stamp() {
        return new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function haversineKm(a, b) {
        if (!a || !b) return Infinity;
        var rad = Math.PI / 180;
        var dLat = (Number(b.lat) - Number(a.lat)) * rad;
        var dLng = (Number(b.lng) - Number(a.lng)) * rad;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(Number(a.lat) * rad) * Math.cos(Number(b.lat) * rad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * 6371 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function sharedStatusText(status) {
        return ({ searching: 'Searching for an ambulance', assigned: 'Ambulance assigned', approaching: 'Heading to patient', at_pickup: 'At patient location', pickedup: 'Patient picked up', enroute: 'Heading to hospital', arrived: 'At hospital', completed: 'Handover completed' })[status] || status || 'Waiting for request';
    }

    function startCrewHeartbeat() {
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = setInterval(function () {
            if (!state.user) return;
            window.MediRouteSync.heartbeatCrew().catch(function () {});
            // A heartbeat refreshes connection presence only. It must never
            // make an old GPS fix look like a new device measurement.
            if (gps.state === 'live' && navigator.geolocation && !gps.refreshInFlight) {
                gps.refreshInFlight = true;
                navigator.geolocation.getCurrentPosition(function (position) { gps.refreshInFlight = false; onGpsFix(position); }, function (error) { gps.refreshInFlight = false; onGpsError(error); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
            }
        }, 12000);
    }

    function startCrewPolling() {
        window.MediRouteSync.startPolling(handleSharedSnapshot, 1100);
    }

    function publishCrewLocation(point, source) {
        if (!state.user || !point || !isFinite(point.lat) || !isFinite(point.lng) || !Number.isFinite(Number(point.accuracy)) || Number(point.accuracy) <= 0 || Number(point.accuracy) > 500 || !Number.isFinite(Number(point.time)) || Date.now() - Number(point.time) > 30000 || Number(point.time) > Date.now() + 5000) return Promise.resolve();
        state.lastPublishedAt = Date.now();
        return window.MediRouteSync.updateCrewLocation({
            lat: Number(point.lat), lng: Number(point.lng),
            accuracy: Number(point.accuracy),
            source: 'device', at: new Date(Number(point.time)).toISOString()
        }).catch(function (error) {
            $('#waitLine').textContent = 'Location update could not reach the shared server: ' + error.message;
        });
    }

    function publicPatientProfile(remote) {
        var p = remote && remote.patient || {};
        return { name: p.name || 'Patient', age: p.age || '', sex: p.sex || '', phone: p.phone || '', blood: p.blood || '', email: p.email || '', id: p.id || '' };
    }

    function reconstructSharedJourney(remote) {
        if (!remote || !state.user) return;
        var pickup = remote.pickupLocation && remote.pickupLocation.coords;
        var assignment = remote.assignment || {};
        var start = remote.ambulanceLocation || assignment.location || gps.fix;
        var profile = publicPatientProfile(remote);
        state.sharedEmergency = remote;
        state.request = {
            id: remote.id,
            caller: profile.name,
            address: remote.pickupLocation && remote.pickupLocation.address || 'Patient pickup location',
            complaint: remote.details && (remote.details.description || remote.details.type) || 'Emergency assistance requested',
            priority: 'Priority 1',
            // The previous build referenced an undefined NO_SHIFT constant here.
            // That ReferenceError interrupted reconstruction before the crew map
            // could be rendered. Shift scheduling is not part of this request flow.
            pickup: pickup ? { lat: Number(pickup.lat), lng: Number(pickup.lng) } : null,
            start: start ? { lat: Number(start.lat), lng: Number(start.lng) } : null,
            patientProfile: profile,
            shared: true,
            lastLocation: start ? { lat: Number(start.lat), lng: Number(start.lng) } : null
        };
        state.patient = remote.patientAssessment || null;
        if (remote.destination) {
            var d = remote.destination;
            state.hospital = { h: { name: d.hospitalName || d.name, area: d.address || '', phone: d.phone || '', lat: Number(d.coords && d.coords.lat), lng: Number(d.coords && d.coords.lng), beds: 0, has: d.facilities || [] }, eta: remote.route && remote.route.etaMinutes || 0, km: remote.route && remote.route.distanceKm || 0, missing: [], met: [] };
        } else state.hospital = null;
        state.hospitals = [];
        closeSheets();
        $('#doneBox').hidden = true;
        prefillFromProfile(profile);
        resetTripUI();
        setStatus('busy', false);
        $('#reqPriority').textContent = 'Priority 1';
        $('#destTitle').textContent = state.request.address;
        $('#phaseLine').textContent = sharedStatusText(remote.status);
        factRows($('#destFacts'), [
            ['Pickup address', state.request.address], ['Patient', profile.name], ['Patient phone', profile.phone || 'Not provided'],
            ['Reported problem', state.request.complaint], ['Request', state.request.id], ['Your unit', state.user.unit], ['Crew', state.user.name]
        ]);
        show('trip');
        if (remote.status === 'assigned' || remote.status === 'approaching') {
            var origin = start || state.request.start;
            if (origin && pickup) startLeg({ key: 'pickup', start: origin, end: state.request.pickup, from: 'Ambulance', to: 'Patient' });
        } else if (remote.status === 'at_pickup') {
            leg.key = 'pickup'; leg.arrived = true; leg.p = 1;
            setBanner('You have reached the pickup location. Record patient details to find a suitable hospital.');
            setMainAction('Open patient details', true); 
            if (state.request.pickup) drawRoute('mapMain', { coords: [[state.request.pickup.lat, state.request.pickup.lng], [state.request.pickup.lat, state.request.pickup.lng]], approx: true }, 'Ambulance', 'Patient', 1);
        } else if (remote.status === 'pickedup') {
            leg.key = 'pickup'; leg.arrived = true; leg.p = 1;
            setBanner('Patient pickup confirmed. Review hospital recommendations and select a destination.');
            setMainAction('Patient details recorded', false); 
            if (state.patient) findHospitals();
        } else if (remote.status === 'enroute' && state.hospital) {
            var hospitalPointValue = { lat: Number(state.hospital.h.lat), lng: Number(state.hospital.h.lng) };
            var current = start || state.request.pickup;
            if (current && hospitalPointValue.lat && hospitalPointValue.lng) startLeg({ key: 'hospital', start: current, end: hospitalPointValue, from: 'Current ambulance location', to: state.hospital.h.name });
        } else if (remote.status === 'arrived' && state.hospital) {
            leg.key = 'hospital'; leg.arrived = true; leg.p = 1;
            setBanner('You have reached the selected hospital. Confirm patient handover once complete.');
            setMainAction('Confirm patient handover', true); 
        }
        log('Shared request synchronised: ' + remote.id + ' · ' + sharedStatusText(remote.status));
    }

    function handleSharedSnapshot(snapshot) {
        if (snapshot && snapshot.sessionExpired) {
            $('#waitLine').textContent = 'Your crew session expired. Sign in again.';
            return;
        }
        if (!snapshot || snapshot.role !== 'crew') return;
        if (snapshot.profile) {
            state.user = Object.assign({}, state.user || {}, snapshot.profile);
            if (snapshot.profile.trips !== undefined) state.trips = Number(snapshot.profile.trips) || 0;
            $('#tripCount').textContent = state.trips;
            if (snapshot.profile.status === 'busy') setStatus('busy', false);
        }
        var remote = (snapshot.emergencies || [])[0];
        if (remote && (!state.request || state.request.id !== remote.id)) {
            reconstructSharedJourney(remote);
            return;
        }
        if (remote && state.request && state.request.id === remote.id) {
            state.sharedEmergency = remote;
            if (remote.ambulanceLocation) {
                state.request.lastLocation = { lat: Number(remote.ambulanceLocation.lat), lng: Number(remote.ambulanceLocation.lng) };
            }
            if (remote.patientAssessment && !state.patient) state.patient = remote.patientAssessment;
            if (remote.status === 'at_pickup' && !leg.arrived) arriveLeg();
            if (remote.status === 'arrived' && leg.key === 'hospital' && !leg.arrived) arriveLeg();
            if (remote.status === 'cancelled') {
                stopLeg(); state.request = null; state.patient = null; state.hospital = null; resetTripUI(); setStatus('available', false); show('dash');
                log('Patient/dispatch cancelled request ' + remote.id);
            }
        }
        if (!remote && state.request && state.request.shared && !state.request.completed) {
            // Snapshot may omit a completed request after the crew confirms handover.
            if (state.sharedEmergency && state.sharedEmergency.status === 'completed') return;
        }
    }

    function log(message) {
        var li = document.createElement('li');
        li.textContent = stamp() + ' \u2014 ' + message;
        $('#log').prepend(li);
    }

    function show(id) {
        ['auth', 'dash', 'trip'].forEach(function (name) {
            $('#' + name).hidden = name !== id;
        });

        window.scrollTo(0, 0);
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setBanner(text) {
        var banner = $('#banner');
        banner.textContent = text || '';
        banner.classList.toggle('empty', !text);
    }

    function setMainAction(text, enabled) {
        $('#mainAction').textContent = text;
        $('#mainAction').disabled = !enabled;
    }

    function resetTripUI() {
        $('#informChip').hidden = true;
        $('#informChip').textContent = '';
        $('#noticeBox').hidden = true;
        $('#noticeBox').open = false;
        $('#noticeText').textContent = '';
        $('#progFill').style.width = '0%';
        var navigationLink = $('#externalNavigation');
        if (navigationLink) { navigationLink.hidden = true; navigationLink.href = '#'; }
        setBanner('');
    }

    function setStatus(status, writeLog) {
        state.status = status;
        if (state.user && status !== 'busy' && window.MediRouteSync) {
            window.MediRouteSync.updateCrewStatus(status).catch(function (error) { $('#waitLine').textContent = error.message; });
        }

        $$('#statusSet .st').forEach(function (button) {
            button.classList.toggle('on', button.dataset.s === status);
        });

        var labels = {
            available: 'Available',
            break: 'On break',
            offline: 'Off duty',
            busy: 'On assignment'
        };

        $('#barStatus').textContent = labels[status] || status;
        $('#barStatus').className = 'pill';

        if (status === 'busy') {
            $('#barStatus').classList.add('hot');
        } else if (status === 'break') {
            $('#barStatus').classList.add('warn');
        } else if (status === 'offline') {
            $('#barStatus').classList.add('off');
        }

        $('#waitLine').className = 'waiting';

        if (status === 'break') {
            $('#waitLine').textContent = 'You are on break.';
            $('#waitLine').classList.add('paused');
        } else if (status === 'offline') {
            $('#waitLine').textContent = 'You are off duty.';
            $('#waitLine').classList.add('stopped');
        } else if (status === 'busy') {
            $('#waitLine').textContent = 'You are handling an emergency assignment.';
        } else {
            $('#waitLine').textContent = 'Waiting for the next request from dispatch.';
        }

        if (writeLog) {
            log('Status changed to ' + (labels[status] || status));
        }
    }

    function openSheet(id) {
        $('#sheetBack').hidden = false;
        $('#' + id).hidden = false;
    }

    function closeSheets() {
        $('#sheetBack').hidden = true;
        $('#intakeSheet').hidden = true;
        $('#hospitalSheet').hidden = true;
    }

    function factRows(dl, rows) {
        dl.innerHTML = '';

        rows.forEach(function (row) {
            var div = document.createElement('div');
            var dt = document.createElement('dt');
            var dd = document.createElement('dd');

            dt.textContent = row[0];
            dd.textContent = row[1];

            div.appendChild(dt);
            div.appendChild(dd);
            dl.appendChild(div);
        });
    }

    /* ---------- Geo helpers ---------- */

    var tileWarned = false;

    /* OpenStreetMap's own tile server. Its usage policy needs a real web
       address (http://localhost or https), so it refuses pages opened as a file.
       To use another OSM-based tile provider, change these two lines only. */
    // Both portals use the same tile-source fallback and coloured-block detection.
    // Map attribution stays visible; the helper changes only the tile base layer.

    function haversineKm(a, b) {
        var r = Math.PI / 180;
        var dLat = (b.lat - a.lat) * r;
        var dLng = (b.lng - a.lng) * r;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);

        return 2 * 6371 * Math.asin(Math.sqrt(h));
    }


    function pathPrep(coords) {
        var cum = [0];
        var i;

        for (i = 1; i < coords.length; i++) {
            cum.push(cum[i - 1] + haversineKm(
                { lat: coords[i - 1][0], lng: coords[i - 1][1] },
                { lat: coords[i][0], lng: coords[i][1] }
            ));
        }

        return cum;
    }

    /* [lat, lng] lying `f` (0 to 1) of the way along the road path. */
    function pointAt(coords, cum, f) {
        var target = Math.max(0, Math.min(1, f)) * cum[cum.length - 1];
        var i = 1;

        while (i < cum.length - 1 && cum[i] < target) {
            i++;
        }

        var seg = cum[i] - cum[i - 1];
        var t = seg === 0 ? 0 : Math.max(0, Math.min(1, (target - cum[i - 1]) / seg));

        return [
            coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
            coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t
        ];
    }

    /* ---------- Road routing (map service) ---------- */

    /* Always resolves. Falls back to a straight dashed line when the
       routing service is unreachable, so a trip can never get stuck. */
    function fetchRoute(from, to) {
        if (!window.MediRouteMaps || typeof window.MediRouteMaps.getRoute !== 'function') {
            return Promise.reject(new Error('Map and road-routing services did not load.'));
        }
        return window.MediRouteMaps.getRoute(from, to).then(function (result) {
            var route = result && result.primary;
            if (!route || !Array.isArray(route.geometry && route.geometry.coordinates) || route.geometry.coordinates.length < 2) {
                throw new Error('No drivable road route was returned for these locations.');
            }
            return {
                coords: route.geometry.coordinates.map(function (point) { return [Number(point[1]), Number(point[0])]; }),
                km: Number(route.distance) / 1000,
                minutes: Math.max(1, Math.ceil(Number(route.duration) / 60)),
                approx: false
            };
        });
    }

    /* ---------- GPS tracking ---------- */

    /* One continuous watch. states: off, searching, live, blocked.
       The last fix is kept so a short signal drop shows its age instead
       of silently freezing, and it is dropped completely when tracking stops. */
    var gps = { id: null, fix: null, state: 'off', msg: '', tick: null, refreshInFlight: false };
    var GPS_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 };

    function gpsText() {
        var fix = gps.fix;

        if (gps.state === 'off') {
            return { loc: 'Location not enabled.', line: 'GPS is off. This unit is not eligible for dispatch until device location is enabled.' };
        }

        if (gps.state === 'blocked') {
            return { loc: gps.msg, line: 'GPS unavailable.' };
        }

        if (!fix) {
            return { loc: gps.msg, line: gps.msg };
        }

        var age = Math.max(0, Math.round((Date.now() - fix.time) / 1000));
        var acc = 'accuracy ' + Math.round(fix.accuracy) + ' m';
        var coords = fix.lat.toFixed(5) + ', ' + fix.lng.toFixed(5);

        if (age > 30) {
            return {
                loc: coords + ' (last update ' + age + ' s ago)',
                line: 'GPS signal lost, last fix ' + age + ' s ago.'
            };
        }

        return {
            loc: coords + ' (' + acc + ')',
            line: (fix.accuracy > 100 ? 'GPS weak, ' : 'GPS live, ') + acc + '.'
        };
    }

    function renderGps() {
        var text = gpsText();
        var idle = gps.state === 'off' || gps.state === 'blocked';

        $('#locState').textContent = text.loc;
        $('#gpsLine').textContent = text.line;
        $('#locBtn').textContent = idle ? 'Enable location' : 'Turn off location';
    }

    function stopGps(announce) {
        if (gps.id !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(gps.id);
        }

        if (gps.tick) {
            clearInterval(gps.tick);
        }

        var wasOn = gps.id !== null;

        gps.id = null;
        gps.tick = null;
        gps.refreshInFlight = false;
        gps.fix = null;
        gps.state = 'off';
        gps.msg = '';

        drawDevice();
        renderGps();

        if (announce && wasOn) {
            log('Device location turned off');
        }
    }

    function onGpsFix(position) {
        var c = position.coords;

        if (!isFinite(c.latitude) || !isFinite(c.longitude) || (c.latitude === 0 && c.longitude === 0) || !isFinite(c.accuracy) || c.accuracy <= 0 || c.accuracy > 500) {
            gps.msg = 'Waiting for a usable GPS fix with accuracy of 500 metres or better.';
            renderGps();
            return;
        }

        var first = !gps.fix;

        gps.fix = {
            lat: c.latitude,
            lng: c.longitude,
            accuracy: isFinite(c.accuracy) ? c.accuracy : 0,
            time: Date.now(),
            source: 'device'
        };
        gps.state = 'live';

        if (first) {
            log('Device location enabled');
        }

        renderGps();
        drawDevice();
        if (crewPickMap && gps.fix) {
            var ll = [gps.fix.lat, gps.fix.lng];
            if (!crewPickMarker) crewPickMarker = L.marker(ll).addTo(crewPickMap).bindTooltip('Live ambulance GPS');
            else crewPickMarker.setLatLng(ll);
            crewPickMap.setView(ll, Math.max(crewPickMap.getZoom(), 13));
        }
        publishCrewLocation(gps.fix, 'device');
        if (state.request && leg.key) paintLiveLeg();
    }

    function onGpsError(error) {
        if (error.code === 1) {
            stopGps(false);
            gps.state = 'blocked';
            gps.msg = 'Location permission denied. Allow it in the browser site settings, then try again.';
            renderGps();
            log('Location permission denied');
            return;
        }

        /* Signal lost or timed out: the watch keeps retrying by itself. */
        gps.msg = error.code === 3 ? 'GPS timed out, still trying.' : 'GPS signal unavailable, still trying.';
        renderGps();
    }

    function startGps() {
        if (gps.id !== null) {
            return;
        }

        if (!navigator.geolocation) {
            gps.state = 'blocked';
            gps.msg = 'Geolocation is not supported by this browser.';
            renderGps();
            return;
        }

        if (window.isSecureContext === false) {
            gps.state = 'blocked';
            gps.msg = 'Location needs a secure page (https or localhost).';
            renderGps();
            return;
        }

        gps.state = 'searching';
        gps.msg = 'Searching for GPS signal...';
        gps.id = navigator.geolocation.watchPosition(onGpsFix, onGpsError, GPS_OPTIONS);
        gps.tick = setInterval(renderGps, 1000);
        renderGps();
    }

    var FIX_WAIT_MS = 15000;
    var DEFAULT_MAP_CENTER = [20.5937, 78.9629];
    function hospitalPoint(hospital) { return { lat: Number(hospital.lat), lng: Number(hospital.lng) }; }

    /* Resolves with the current fix, or null if GPS is blocked, off or too slow. */
    function waitForFix(ms) {
        return new Promise(function (resolve) {
            var began = Date.now();

            (function poll() {
                if (gps.fix) {
                    resolve(gps.fix);
                } else if (gps.state === 'blocked' || gps.state === 'off' || Date.now() - began >= ms) {
                    resolve(null);
                } else {
                    setTimeout(poll, 200);
                }
            })();
        });
    }

    /* ---------- OpenStreetMap views (Leaflet) ---------- */

    var views = {};

    function canMap() {
        return typeof window.L === 'object' && typeof L.map === 'function';
    }

    function markerIcon(cls) {
        return L.divIcon({
            className: '',
            html: '<span class="mk ' + cls + '"></span>',
            iconSize: [18, 18],
            iconAnchor: [9, 9]
        });
    }

    function getView(id) {
        if (!canMap()) {
            if ($('#' + id)) $('#' + id).textContent = 'Map library could not load. Check internet access to the Leaflet CDN and reload this page.';
            return null;
        }

        if (views[id]) {
            return views[id];
        }

        var el = $('#' + id);
        el.innerHTML = '';

        /* Wheel zoom is off so scrolling the page over the map cannot zoom it out. */
        var map = L.map(el, { scrollWheelZoom: false }).setView(gps.fix ? [gps.fix.lat, gps.fix.lng] : DEFAULT_MAP_CENTER, gps.fix ? 13 : 5);
        if (window.MediRouteMaps && window.MediRouteMaps.addMapBaseLayer) {
            window.MediRouteMaps.addMapBaseLayer(map, id === 'mapMain' ? 'mapMainTileStatus' : 'mapHospitalTileStatus');
        } else {
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                referrerPolicy: 'strict-origin-when-cross-origin',
                errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
            }).addTo(map);
            log('Shared map tile fallback was unavailable; using the standard OpenStreetMap layer.');
        }

        views[id] = { map: map, layer: L.layerGroup().addTo(map), amb: null, dev: null, acc: null };
        drawDevice();

        return views[id];
    }

    /* Draws the road path, both end markers and the ambulance at fraction f.
       Skipped while the container is hidden (Leaflet cannot size it). */
    function drawRoute(id, route, from, to, f) {
        var v = getView(id);

        if (!v || !$('#' + id).offsetWidth) {
            return false;
        }

        v.map.invalidateSize();
        v.layer.clearLayers();

        var line = L.polyline(route.coords, {
            color: '#176b87',
            weight: 5,
            dashArray: route.approx ? '2 10' : null
        }).addTo(v.layer);

        L.marker(route.coords[0], { icon: markerIcon('mk-start'), keyboard: false })
            .bindTooltip(escapeHtml(from), { permanent: true, direction: 'bottom', offset: [0, 8] })
            .addTo(v.layer);

        L.marker(route.coords[route.coords.length - 1], { icon: markerIcon('mk-end'), keyboard: false })
            .bindTooltip(escapeHtml(to), { permanent: true, direction: 'top', offset: [0, -8] })
            .addTo(v.layer);

        v.amb = L.marker(pointAt(route.coords, pathPrep(route.coords), f), {
            icon: markerIcon('mk-amb'),
            keyboard: false,
            zIndexOffset: 500
        }).addTo(v.layer);

        v.map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 16 });

        /* Safety net: if the fit ever lands at world level, centre on the route. */
        if (v.map.getZoom() < 8) {
            v.map.setView(line.getBounds().getCenter(), 13);
        }

        return true;
    }

    function drawDevice() {
        Object.keys(views).forEach(function (id) {
            var v = views[id];

            if (!gps.fix) {
                if (v.dev) {
                    v.map.removeLayer(v.dev);
                    v.map.removeLayer(v.acc);
                    v.dev = null;
                    v.acc = null;
                }

                return;
            }

            var at = [gps.fix.lat, gps.fix.lng];

            if (!v.dev) {
                v.acc = L.circle(at, {
                    radius: gps.fix.accuracy,
                    color: '#2f7fc1',
                    weight: 1,
                    fillOpacity: 0.12,
                    interactive: false
                }).addTo(v.map);
                v.dev = L.marker(at, { icon: markerIcon('mk-dev'), interactive: false, keyboard: false }).addTo(v.map);
            } else {
                v.acc.setLatLng(at);
                v.acc.setRadius(gps.fix.accuracy);
                v.dev.setLatLng(at);
            }
        });
    }

    function clearViews() {
        Object.keys(views).forEach(function (id) {
            views[id].layer.clearLayers();
            views[id].amb = null;
        });
    }

    /* ---------- Sign in / account ---------- */

    function showTab(which) {
        var login = which === 'login';

        $('#loginForm').hidden = !login;
        $('#signupForm').hidden = login;
        $('#tabLogin').classList.toggle('on', login);
        $('#tabSignup').classList.toggle('on', !login);
        $('#loginMsg').textContent = '';
        $('#loginMsg').className = 'msg';
        $('#signupMsg').textContent = '';
        $('#signupMsg').className = 'msg';
    }

    function login(user) {
        state.user = user;
        state.trips = Number(user.trips || 0);
        $('#bar').hidden = false;
        $('#barName').textContent = user.name;
        $('#barUnit').textContent = user.unit;
        $('#factUnit').textContent = user.unit;
        $('#factRole').textContent = user.role;
        $('#tripCount').textContent = state.trips;
        if (!shiftStarted) { $('#shiftStart').textContent = stamp(); shiftStarted = true; }
        if (user.activeEmergencyId) setStatus('busy', false);
        else setStatus('available', false);
        log(user.name + ' signed in');
        show('dash');
        initCrewLocationMap();
        startCrewHeartbeat();
        startCrewPolling();
        startGps();
        if (!gps.fix) $('#waitLine').textContent = 'Waiting for a fresh device GPS reading. Dispatch eligibility begins when precise location is available.';

    }

    $('#tabLogin').onclick = function () { showTab('login'); };
    $('#tabSignup').onclick = function () { showTab('signup'); };

    $('#loginForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        var form = event.target, identifier = form.elements.id.value.trim(), password = form.elements.password.value;
        $('#loginMsg').className = 'msg'; $('#loginMsg').textContent = 'Connecting to shared MediRoute server…';
        try {
            var result = await window.MediRouteSync.crewLogin(identifier, password);
            $('#loginMsg').textContent = ''; form.reset(); login(result.profile);
        } catch (error) {
            $('#loginMsg').className = 'msg'; $('#loginMsg').textContent = error.message || 'Could not sign in to the shared server.';
        }
    });

    $('#signupForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        var form = event.target;
        var profile = {
            name: form.elements.name.value.trim(), crewId: form.elements.crewId.value.trim(),
            phone: form.elements.phone.value.trim(), email: form.elements.email.value.trim(),
            unit: form.elements.unit.value.trim(), role: form.elements.role.value
        };
        var password = form.elements.password.value, confirm = form.elements.confirm.value;
        $('#signupMsg').className = 'msg';
        if (password.length < 8) { $('#signupMsg').textContent = 'Password must contain at least 8 characters.'; return; }
        if (password !== confirm) { $('#signupMsg').textContent = 'Passwords do not match.'; return; }
        try {
            var result = await window.MediRouteSync.crewRegister(profile, password);
            form.reset(); login(result.profile); log('Crew account registered on the shared server');
        } catch (error) {
            $('#signupMsg').className = 'msg'; $('#signupMsg').textContent = error.message || 'Could not create crew account.';
        }
    });

    $('#logoutBtn').onclick = async function () {
        if (state.request || state.status === 'busy') {
            var text = 'Complete the current assignment before signing out.';
            $('#waitLine').textContent = text; if (!$('#trip').hidden) setBanner(text); return;
        }
        stopLeg(); stopGps(false); clearViews();
        window.MediRouteSync.stopPolling();
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
        try { await window.MediRouteSync.logout(); } catch (error) { log('Sign-out connection warning: ' + error.message); }
        $('#bar').hidden = true; state.user = null; state.request = null; state.patient = null; state.hospital = null; state.hospitals = []; state.trips = 0; shiftStarted = false;
        $('#tripCount').textContent = '0'; $('#shiftStart').textContent = '-'; $('#log').innerHTML = ''; $('#loginForm').reset();
        showTab('login'); show('auth');
    };

    /* ---------- Activity status and location ---------- */

    $$('#statusSet .st').forEach(function (button) {
        button.onclick = function () {
            if (state.status === 'busy') {
                $('#waitLine').textContent = 'Complete the current assignment before changing status.';
                return;
            }

            setStatus(button.dataset.s, true);
        };
    });

    $('#locBtn').onclick = function () {
        if (gps.state === 'off' || gps.state === 'blocked') {
            startGps();
        } else if (state.request) {
            $('#waitLine').textContent = 'Live GPS must remain enabled until the current patient journey is completed.';
        } else {
            stopGps(true);
        }
    };


    var crewPickMap = null, crewPickMarker = null;
    function initCrewLocationMap() {
        var el = $('#crewLocationMap');
        if (!el || !canMap()) { $('#crewMapHelp').textContent = 'Map renderer unavailable. Check your internet connection and reload.'; return; }
        if (!crewPickMap) {
            crewPickMap = L.map(el, { scrollWheelZoom: false }).setView(gps.fix ? [gps.fix.lat, gps.fix.lng] : DEFAULT_MAP_CENTER, gps.fix ? 14 : 5);
            if (window.MediRouteMaps && window.MediRouteMaps.addMapBaseLayer) window.MediRouteMaps.addMapBaseLayer(crewPickMap, 'crewMapTileStatus');
        }
        if (gps.fix) {
            var point = [gps.fix.lat, gps.fix.lng];
            if (!crewPickMarker) crewPickMarker = L.marker(point).addTo(crewPickMap).bindTooltip('Live ambulance GPS');
            else crewPickMarker.setLatLng(point);
            crewPickMap.setView(point, Math.max(crewPickMap.getZoom(), 14));
            $('#crewMapHelp').textContent = 'This marker is your device GPS position. It updates automatically.';
        } else { $('#crewMapHelp').textContent = 'Waiting for a valid GPS fix. This ambulance will not receive requests until location is available.'; }
        setTimeout(function () { if (crewPickMap) crewPickMap.invalidateSize(); }, 150);
    }

    /* ---------- Shared incoming requests ---------- */

    /* ---------- Travel legs ---------- */

    function paintLiveLeg() {
        if (!state.request || !leg.end || !gps.fix || gps.fix.source !== 'device') return;
        var current = { lat: gps.fix.lat, lng: gps.fix.lng };
        $('#etaMain').textContent = Number.isFinite(leg.minutes) ? String(leg.minutes) : '--';
        $('#distMain').textContent = Number.isFinite(leg.km) ? leg.km.toFixed(1) : '--';
        if (leg.start) {
            var total = Math.max(0.1, haversineKm(leg.start, leg.end));
            var remaining = haversineKm(current, leg.end);
            $('#progFill').style.width = Math.max(0, Math.min(100, (1 - remaining / total) * 100)) + '%';
        }
        state.request.lastLocation = current;
        var v = views.mapMain;
        if (v && v.amb) v.amb.setLatLng([current.lat, current.lng]);
        if (state.request.shared) publishCrewLocation({ lat: current.lat, lng: current.lng, accuracy: gps.fix.accuracy }, 'device');
        if (haversineKm(current, leg.end) <= 0.09 && gps.fix.accuracy <= 80) {
            arriveLeg(); return;
        }
        var now = Date.now();
        if (state.request.shared && now - state.lastRouteRefreshAt > 12000 &&
            (!state.lastRouteRefreshPoint || haversineKm(state.lastRouteRefreshPoint, current) > 0.08)) {
            state.lastRouteRefreshAt = now; state.lastRouteRefreshPoint = current;
            fetchRoute(current, leg.end).then(function (route) {
                if (!state.request) return;
                leg.route = route; leg.cum = pathPrep(route.coords); leg.minutes = route.minutes; leg.km = route.km;
                drawRoute('mapMain', route, 'Current ambulance location', leg.to, 0);
                if (views.mapMain && views.mapMain.amb) views.mapMain.amb.setLatLng([current.lat, current.lng]);
                $('#etaMain').textContent = String(route.minutes); $('#distMain').textContent = route.km.toFixed(1);
                window.MediRouteSync.updateEmergency(state.request.id, { route: { distanceKm: route.km, etaMinutes: route.minutes, source: 'OSRM road route estimate' } }).catch(function (error) { log('ETA refresh sync failed: ' + error.message); });
            }).catch(function (error) { log('Live road-route refresh failed: ' + error.message); });
        }
    }

    function updateExternalNavigation(start, end) {
        var link = $('#externalNavigation');
        if (!link) return;
        var points = [start, end];
        var valid = points.every(function (point) {
            return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) &&
                Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180 &&
                !(Number(point.lat) === 0 && Number(point.lng) === 0);
        });
        if (!valid) { link.hidden = true; link.href = '#'; return; }
        var origin = Number(start.lat) + ',' + Number(start.lng);
        var destination = Number(end.lat) + ',' + Number(end.lng);
        link.href = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(origin) +
            '&destination=' + encodeURIComponent(destination) + '&travelmode=driving';
        link.hidden = false;
        link.textContent = optionsLabelForLeg(leg.key);
    }

    function optionsLabelForLeg(key) {
        return key === 'pickup' ? 'Navigate to patient in Google Maps' : 'Navigate to hospital in Google Maps';
    }

    function startLeg(options) {
        stopLeg();
        var token = ++leg.token;
        leg.key = options.key; leg.p = 0; leg.arrived = false; leg.arrivalPending = false; leg.route = null;
        leg.from = options.from; leg.to = options.to;
        leg.start = { lat: Number(options.start.lat), lng: Number(options.start.lng) };
        leg.end = { lat: Number(options.end.lat), lng: Number(options.end.lng) };
        updateExternalNavigation(leg.start, leg.end);
        $('#etaMain').textContent = '--'; $('#distMain').textContent = '--'; $('#progFill').style.width = '0%';
        $('#phaseLine').textContent = leg.key === 'pickup' ? 'Live navigation to patient' : 'Live navigation to hospital';

        // Render both endpoints immediately. The patient pickup marker must not
        // depend on an external OSRM request completing successfully. This dashed
        // segment is only a visual locator, never presented as a drivable route.
        if (Number.isFinite(leg.start.lat) && Number.isFinite(leg.start.lng) &&
            Number.isFinite(leg.end.lat) && Number.isFinite(leg.end.lng) &&
            !(leg.start.lat === 0 && leg.start.lng === 0) &&
            !(leg.end.lat === 0 && leg.end.lng === 0)) {
            drawRoute('mapMain', {
                coords: [[leg.start.lat, leg.start.lng], [leg.end.lat, leg.end.lng]],
                approx: true
            }, leg.from, leg.to, 0);
            setBanner(leg.key === 'pickup'
                ? 'Patient pickup point is marked on the map. Calculating the road route…'
                : 'Hospital destination is marked on the map. Calculating the road route…');
        } else {
            setBanner('A valid current ambulance location and destination are required to draw the route. Check device GPS and the destination coordinates.');
        }

        fetchRoute(leg.start, leg.end).then(async function (route) {
            if (token !== leg.token || !state.request) return;
            leg.route = route; leg.cum = pathPrep(route.coords); leg.minutes = route.minutes; leg.km = route.km;
            drawRoute('mapMain', route, leg.from, leg.to, 0);
            $('#etaMain').textContent = String(route.minutes); $('#distMain').textContent = route.km.toFixed(1);
            if (route.approx) setBanner('A road route could not be verified. Navigation is paused; retry when the routing service is available.');
            if (state.request.shared && !route.approx) {
                window.MediRouteSync.updateEmergency(state.request.id, { route: { distanceKm: route.km, etaMinutes: route.minutes, source: 'OSRM road route estimate' } })
                    .catch(function (error) { log('Route ETA could not be synchronised: ' + error.message); });
            }
            if (gps.fix) paintLiveLeg();
        }).catch(function (error) {
            if (token === leg.token) {
                // Keep the already-rendered destination and the last-known
                // ambulance location visible even when the routing provider fails.
                setBanner((leg.key === 'pickup' ? 'Patient pickup point remains marked. ' : 'Hospital destination remains marked. ') +
                    'The road route is unavailable: ' + error.message + ' Do not use the dashed locator as turn-by-turn navigation.');
                $('#etaMain').textContent = '--';
                $('#distMain').textContent = '--';
                log('Road routing unavailable; endpoint markers remain visible: ' + error.message);
            }
        });
    }

    function stopLeg() {
        leg.token++;

        if (leg.timer) {
            clearInterval(leg.timer);
            leg.timer = null;
        }
    }

    async function arriveLeg() {
        if (!state.request || leg.arrived || leg.arrivalPending) return;
        var requestId = state.request.id;
        var legKey = leg.key;
        var fix = gps.fix;
        if (!fix || fix.source !== 'device' || !Number.isFinite(Number(fix.accuracy)) ||
            Number(fix.accuracy) <= 0 || Number(fix.accuracy) > 80 ||
            !Number.isFinite(Number(fix.time)) || Date.now() - Number(fix.time) > 30000) {
            setBanner('Waiting for a fresh, accurate GPS reading before confirming arrival.');
            return;
        }

        leg.arrivalPending = true;
        stopLeg();
        setMainAction('Confirming arrival…', false);
        setBanner('Verifying your current GPS position with the shared server…');
        try {
            // Publish the exact current GPS fix first. The server's geofence check
            // must never race ahead of the location write that it validates.
            await window.MediRouteSync.updateCrewLocation({
                lat: Number(fix.lat), lng: Number(fix.lng), accuracy: Number(fix.accuracy),
                source: 'device', at: new Date(Number(fix.time)).toISOString()
            });
            if (!state.request || state.request.id !== requestId || leg.key !== legKey) return;
            var nextStatus = legKey === 'pickup' ? 'at_pickup' : 'arrived';
            var result = await window.MediRouteSync.updateEmergency(requestId, {
                status: nextStatus,
                ambulanceLocation: { lat: Number(fix.lat), lng: Number(fix.lng), accuracy: Number(fix.accuracy), source: 'device', at: new Date(Number(fix.time)).toISOString() },
                eventMessage: legKey === 'pickup' ? 'Ambulance arrived at the patient pickup location.' : 'Ambulance arrived at the selected hospital.'
            });
            if (!state.request || state.request.id !== requestId || leg.key !== legKey) return;
            state.sharedEmergency = result.emergency;
            state.request.lastLocation = { lat: Number(fix.lat), lng: Number(fix.lng) };
            leg.arrived = true;
            leg.arrivalPending = false;

            if (legKey === 'pickup') {
                $('#phaseLine').textContent = 'At patient location';
                setBanner('Arrival confirmed. Record patient details to find a suitable hospital.');
                setMainAction('Open patient details', true);
                log('Reached patient pickup location; server geofence confirmed arrival');
            } else if (legKey === 'hospital' && state.hospital) {
                $('#phaseLine').textContent = 'At hospital';
                setBanner('Hospital arrival confirmed. Confirm patient handover once complete.');
                setMainAction('Confirm patient handover', true);
                log('Reached hospital: ' + state.hospital.h.name + '; server geofence confirmed arrival');
            }
        } catch (error) {
            leg.arrivalPending = false;
            setMainAction('Waiting for GPS confirmation', false);
            setBanner('The server could not confirm arrival yet: ' + error.message + ' Keep location enabled; confirmation will retry after the next GPS update.');
            log('Arrival confirmation failed and will retry: ' + error.message);
        }
    }

    $('#mainAction').onclick = function () {
        if (!state.request) {
            return;
        }

        /* Nothing on this button works until the ambulance has arrived. */
        if (!leg.arrived) {
            if (leg.key === 'hospital') {
                setBanner('The ambulance is still travelling to the hospital. Handover can be confirmed on arrival.');
            } else {
                setBanner('The ambulance is still travelling to the patient. Patient details can be entered on arrival.');
            }

            return;
        }

        if (leg.key === 'pickup') {
            $('#intakeMsg').textContent = '';
            openSheet('intakeSheet');
        } else if (leg.key === 'hospital' && state.hospital) {
            $('#doneText').textContent = 'Confirm that the patient has been handed over to ' + state.hospital.h.name + '.';
            $('#doneBox').hidden = false;
        }
    };


    $$('.sheet-hide').forEach(function (button) {
        button.onclick = closeSheets;
    });

    $('#sheetBack').onclick = closeSheets;

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && $('#doneBox').hidden) {
            closeSheets();
        }
    });

    /* ---------- Patient intake ---------- */

    function prefillFromProfile(profile) {
        var form = $('#intakeForm');
        form.reset();
        $('#intakeMsg').textContent = '';

        if (!profile) {
            $('#profileNote').className = 'profile-note';
            $('#profileNote').textContent = 'Patient profile: not linked. Enter the patient details below.';
            return;
        }

        form.elements.pname.value = profile.name || '';
        form.elements.age.value = profile.age || '';
        form.elements.sex.value = profile.sex || '';
        if (state.request && state.request.complaint) {
            form.elements.symptoms.value = state.request.complaint;
        }
        if (profile.blood) {
            var bloodOption = $$('input[name="bloodGroup"]', form).find(function (input) {
                return input.value.toLowerCase() === String(profile.blood).toLowerCase();
            });
            if (bloodOption) bloodOption.checked = true;
        }

        $('#profileNote').className = 'profile-note linked';
        $('#profileNote').textContent = 'Patient profile linked. Patient-provided details and emergency description are prefilled; verify them and add clinical observations.';
    }

    function unique(list) {
        return list.filter(function (item, index) {
            return list.indexOf(item) === index;
        });
    }

    /* Adds requirements that the recorded condition clearly implies,
       so a critical patient is never routed on an empty checklist. */
    function deriveNeeds(patient) {
        var added = [];
        var spo2 = patient.spo2 === '' ? null : Number(patient.spo2);

        function add(need) {
            if (patient.needs.indexOf(need) === -1) {
                patient.needs.push(need);
                added.push(need);
            }
        }

        if (spo2 !== null && spo2 < 94) {
            add('Oxygen support');
        }

        if ((spo2 !== null && spo2 < 90) ||
            patient.avpu === 'Responds to pain' ||
            patient.avpu === 'Unresponsive') {
            add('ICU bed');
        }

        if (patient.bloodGroups.some(function (group) { return group !== 'Unknown'; })) {
            add('Blood bank');
        }

        return added;
    }

    $('#intakeForm').addEventListener('submit', async function (event) {
        event.preventDefault();

        var form = event.target;

        /* Safety net: the form only counts when the ambulance has reached the patient. */
        if (!state.request || leg.key !== 'pickup' || !leg.arrived) {
            $('#intakeMsg').textContent = 'Patient details can only be recorded after the ambulance reaches the patient.';
            return;
        }

        if (!form.elements.symptoms.value.trim()) {
            $('#intakeMsg').textContent = 'Describe the main complaint before searching for a hospital.';
            form.elements.symptoms.focus();
            return;
        }

        var bp = form.elements.bp.value.trim();

        if (bp) {
            var match = /^(\d{2,3})\s*\/\s*(\d{2,3})$/.exec(bp);

            if (!match) {
                $('#intakeMsg').textContent = 'Enter blood pressure as systolic/diastolic, for example 120/80.';
                form.elements.bp.focus();
                return;
            }

            if (Number(match[1]) <= Number(match[2])) {
                $('#intakeMsg').textContent = 'Systolic pressure must be higher than diastolic pressure.';
                form.elements.bp.focus();
                return;
            }

            bp = match[1] + '/' + match[2];
        }

        var bloodGroups = $$('input[name="bloodGroup"]:checked', form).map(function (checkbox) {
            return checkbox.value;
        });

        if (bloodGroups.indexOf('Unknown') !== -1 && bloodGroups.length > 1) {
            $('#intakeMsg').textContent = 'Blood group cannot be both Unknown and a specific group. Adjust the selection.';
            return;
        }

        var minBeds = Math.floor(Number(form.elements.minBeds.value || 0));

        if (!isFinite(minBeds) || minBeds < 0) {
            minBeds = 0;
        }

        state.patient = {
            name: form.elements.pname.value.trim() || 'Unknown',
            age: form.elements.age.value,
            sex: form.elements.sex.value,
            symptoms: form.elements.symptoms.value.trim(),
            pulse: form.elements.pulse.value,
            bp: bp,
            spo2: form.elements.spo2.value,
            temp: form.elements.temp.value,
            avpu: form.elements.avpu.value,
            needs: unique($$('input[name="need"]:checked', form).map(function (checkbox) {
                return checkbox.value;
            })),
            bloodGroups: bloodGroups,
            minBeds: minBeds,
            bedType: form.elements.bedType.value,
            given: form.elements.given.value.trim(),
            autoAdded: []
        };

        state.patient.autoAdded = deriveNeeds(state.patient);

        if (state.request.shared) {
            try {
                var pickupResult = await window.MediRouteSync.updateEmergency(state.request.id, {
                    status: 'pickedup', patientAssessment: state.patient,
                    eventMessage: 'Crew confirmed patient pickup and saved the medical intake information.'
                });
                state.sharedEmergency = pickupResult.emergency;
            } catch (error) {
                $('#intakeMsg').textContent = 'Patient pickup could not be recorded on the shared server: ' + error.message;
                return;
            }
        }

        log('Patient details recorded');

        if (state.patient.autoAdded.length) {
            log('Added from patient condition: ' + state.patient.autoAdded.join(', '));
        }

        findHospitals();
    });

    /* ---------- Hospital matching ---------- */

    async function findHospitals() {
        if (!state.patient || !state.request || !state.request.pickup) return;
        closeSheets();
        openSheet('hospitalSheet');
        $('#hName').textContent = 'Searching nearby hospitals…';
        $('#hAddr').textContent = 'Looking up nearby hospital map listings.';
        $('#etaHospital').textContent = '--';
        $('#distHospital').textContent = '';
        factRows($('#hFacts'), [['Hospital search', 'Searching nearby map listings'], ['Clinical suitability', 'Not verified by this system'], ['Bed availability', 'Not connected to live hospital systems']]);
        $('#alts').innerHTML = '';
        try {
            if (!window.MediRouteMaps) throw new Error('Map and place-search services did not load.');
            var found = await window.MediRouteMaps.searchNearbyHospitals(state.request.pickup);
            if (!found.length) throw new Error('No nearby hospital listings were returned. Try again or contact local emergency services for destination guidance.');
            state.hospitals = found.map(function (item) {
                var h = { id: item.id, name: item.name, area: item.displayName, address: item.displayName, phone: '', lat: item.lat, lng: item.lng, has: [], beds: null };
                return { h: h, met: [], missing: [], eta: null, km: item.distanceKm };
            });
            chooseHospital(0);
            renderAlternatives();
        } catch (error) {
            $('#hName').textContent = 'Hospital search unavailable';
            $('#hAddr').textContent = error.message || 'Could not retrieve nearby hospital listings.';
            factRows($('#hFacts'), [['Important', 'Map listings do not confirm hospital operation, clinical capabilities, ambulance acceptance or available beds.']]);
            log('Nearby hospital search failed: ' + (error.message || 'Unknown error'));
        }
    }

    var previewToken = 0;

    function chooseHospital(index) {
        var result = state.hospitals[index];
        var hospital = result.h;
        var first = index === 0;

        state.hospital = result;

        $('#hName').textContent = hospital.name;
        $('#hAddr').textContent = hospital.area;

        if (first) {
            $('#matchPill').textContent = result.missing.length ? 'Closest match' : 'Best match';
        } else {
            $('#matchPill').textContent = 'Selected by crew';
        }

        $('#matchPill').className = result.missing.length ? 'pill warn' : 'pill';

        /* Preview an actual road route from the ambulance's current GPS fix. */
        var pickup = gps.fix ? { lat: gps.fix.lat, lng: gps.fix.lng } : state.request.pickup;
        var target = hospitalPoint(hospital);
        var token = ++previewToken;

        if (!canMap()) {
            $('#mapHospital').textContent = 'Interactive map unavailable. Check that Leaflet loaded and the device has internet access.';
        }

        $('#etaHospital').textContent = '--';
        $('#distHospital').textContent = 'Calculating road route…';

        fetchRoute(pickup, target).then(function (route) {
            if (token !== previewToken || state.hospital !== result) {
                return;
            }

            result.eta = route.minutes;
            result.km = Math.round(route.km * 10) / 10;
            $('#etaHospital').textContent = result.eta == null ? '--' : result.eta;
            $('#distHospital').textContent = Number.isFinite(Number(result.km)) ? Number(result.km).toFixed(1) + ' km' : 'Calculating road route…';
            drawRoute('mapHospital', route, 'Patient pickup', hospital.name, 0);
            renderAlternatives();
        }).catch(function (error) {
            if (token === previewToken && state.hospital === result) {
                $('#etaHospital').textContent = '--';
                $('#distHospital').textContent = 'Road route unavailable';
                $('#hAddr').textContent = hospital.area + ' · ' + error.message;
            }
        });

        var rows = [
            ['Map listing', hospital.area || hospital.name],
            ['Route source', 'OSRM road-network estimate'],
            ['Clinical suitability', 'Not verified; confirm directly with the hospital'],
            ['Bed availability', 'Not connected to a live hospital feed'],
            ['Blood group recorded', state.patient.bloodGroups.length ? state.patient.bloodGroups.join(', ') : 'Not specified']
        ];



        factRows($('#hFacts'), rows);

        log((first ? 'Nearby hospital listing selected: ' : 'Hospital selected: ') + hospital.name);
        renderAlternatives();
    }

    function renderAlternatives() {
        var list = $('#alts');
        list.innerHTML = '';

        state.hospitals.forEach(function (result, index) {
            if (result === state.hospital) {
                return;
            }

            var li = document.createElement('li');
            var left = document.createElement('div');
            var name = document.createElement('strong');
            var small = document.createElement('small');
            var meta = document.createElement('span');
            var button = document.createElement('button');

            name.textContent = result.h.name;
            small.textContent = result.h.area + ' — map listing only; services, acceptance and capacity are unverified';

            left.appendChild(name);
            left.appendChild(small);

            meta.textContent = Number.isFinite(Number(result.eta)) ? ('about ' + result.eta + ' min, ' + Number(result.km).toFixed(1) + ' km by road') : (Number(result.km).toFixed(1) + ' km straight-line · calculating road ETA');

            button.type = 'button';
            button.className = 'btn ghost';
            button.textContent = 'Use this hospital';

            button.onclick = function () {
                chooseHospital(index);
            };

            li.appendChild(left);
            li.appendChild(meta);
            li.appendChild(button);
            list.appendChild(li);
        });
    }

    function buildNotice() {
        var patient = state.patient;
        var request = state.request;
        var hospital = state.hospital.h;
        var vitals = [];

        if (patient.pulse !== '') {
            vitals.push('Pulse: ' + patient.pulse + ' bpm');
        }

        if (patient.bp) {
            vitals.push('BP: ' + patient.bp);
        }

        if (patient.spo2 !== '') {
            vitals.push('SpO2: ' + patient.spo2 + '%');
        }

        if (patient.temp !== '') {
            vitals.push('Temperature: ' + patient.temp + ' \u00b0C');
        }

        return [
            'Destination record: ' + hospital.name,
            'From: Unit ' + state.user.unit + ', ' + state.user.name,
            'Request: ' + request.id + ' (' + request.priority + ')',
            'Expected arrival: about ' + state.hospital.eta + ' minutes',
            '',
            'Patient: ' + patient.name,
            'Age: ' + (patient.age || 'Not recorded'),
            'Sex: ' + (patient.sex || 'Not stated'),
            'Reported problem: ' + request.complaint,
            'Symptoms: ' + patient.symptoms,
            'Consciousness: ' + patient.avpu,
            'Vitals: ' + (vitals.length ? vitals.join(', ') : 'Not recorded'),
            'Blood group: ' + (patient.bloodGroups.length ? patient.bloodGroups.join(', ') : 'Not recorded'),
            'Required services/equipment: ' + (patient.needs.length ? patient.needs.join(', ') : 'General casualty assessment'),
            'Not available at this hospital: ' + (state.hospital.missing.length ? state.hospital.missing.join(', ') : 'None'),
            'Treatment given: ' + (patient.given || 'None recorded')
        ].join('\n');
    }

    function notifyHospital(hospital, message) {
        state.notifiedAt = stamp();

        $('#informChip').textContent = 'Handover summary prepared at ' + state.notifiedAt + ' · not sent to hospital';
        $('#informChip').hidden = false;
        $('#noticeText').textContent = message;
        $('#noticeBox').hidden = false;
        $('#noticeBox').open = false;

        log('Hospital handover summary prepared for ' + hospital.name + ' (not transmitted to the hospital).');
    }

    $('#startHospitalBtn').onclick = async function () {
        if (!state.request || !state.patient || !state.hospital) {
            return;
        }

        var hospital = state.hospital.h;
        var patient = state.patient;
        var destination = hospitalPoint(hospital);
        var hospitalAddress = hospital.area || hospital.name;
        var currentFix = gps.fix && gps.fix.source === 'device' ? { lat: gps.fix.lat, lng: gps.fix.lng } : null;
        if (!currentFix) { setBanner('A live ambulance GPS fix is required before the hospital journey can begin.'); return; }
        var hospitalRoute;
        try { hospitalRoute = await fetchRoute(currentFix, destination); }
        catch (routeError) { setBanner('Hospital road route unavailable: ' + routeError.message + '. The hospital journey has not started.'); return; }
        if (state.request.shared) {
            try {
                var updated = await window.MediRouteSync.updateEmergency(state.request.id, {
                    status: 'enroute',
                    destination: { hospitalId: hospital.id || hospital.name, hospitalName: hospital.name, name: hospital.name, address: hospitalAddress, phone: hospital.phone || '', coords: destination, facilities: [] },
                    patientAssessment: patient,
                    route: { distanceKm: hospitalRoute.km, etaMinutes: hospitalRoute.minutes, source: 'OSRM road route estimate' },
                    eventMessage: 'Crew selected ' + hospital.name + ' as the hospital destination. Ambulance is en route.'
                });
                state.sharedEmergency = updated.emergency;
            } catch (error) {
                setBanner('Hospital destination could not be synced: ' + error.message);
                log('Hospital destination sync failed: ' + error.message);
                return;
            }
        }
        state.hospital.km = hospitalRoute.km; state.hospital.eta = hospitalRoute.minutes;

        notifyHospital(hospital, buildNotice());
        closeSheets();

        $('#phaseLine').textContent = 'Heading to hospital';
        $('#destTitle').textContent = hospital.name;

        /* Handover stays locked until the ambulance reaches the hospital. */
        setMainAction('Handover opens on arrival', false);
        

        factRows($('#destFacts'), [
            ['Hospital', hospital.name],
            ['Address', hospital.area || hospital.name],
            ['Hospital contact', hospital.phone || 'Not supplied by map listing'],
            ['Patient', patient.name],
            ['Blood group', patient.bloodGroups.length ? patient.bloodGroups.join(', ') : 'Not specified'],
            ['Prepared for', patient.needs.length ? patient.needs.join(', ') : 'General casualty assessment'],
            ['Request', state.request.id]
        ]);

        setBanner('Destination selected: ' + hospital.name + '.');
        show('trip');

        startLeg({
            key: 'hospital',
            start: currentFix,
            end: destination,
            from: 'Current ambulance location',
            to: hospital.name
        });
    };

    /* ---------- Handover ---------- */

    $('#doneYes').onclick = async function () {
        if (!state.request || !state.hospital || !leg.arrived || leg.key !== 'hospital') {
            $('#doneBox').hidden = true;
            return;
        }

        if (state.request.shared) {
            $('#doneYes').disabled = true;
            try {
                var completed = await window.MediRouteSync.updateEmergency(state.request.id, { status: 'completed', eventMessage: 'Crew confirmed that the patient was handed over to ' + state.hospital.h.name + '.' });
                state.sharedEmergency = completed.emergency;
            } catch (error) {
                $('#doneYes').disabled = false;
                setBanner('Handover could not be synchronised: ' + error.message);
                return;
            }
        }
        stopLeg();
        $('#doneBox').hidden = true;
        $('#doneYes').disabled = false;

        state.trips += 1;
        $('#tripCount').textContent = state.trips;

        log('Ride completed at ' + state.hospital.h.name);

        state.request = null;
        state.patient = null;
        state.hospital = null;
        state.hospitals = [];
        state.notifiedAt = null;

        leg.key = '';
        leg.arrived = false;
        leg.p = 0;

        clearViews();
        resetTripUI();
        setStatus('available', true);
        show('dash');
    };

    $('#doneNo').onclick = function () {
        $('#doneBox').hidden = true;
        setBanner('Confirm patient handover once it is complete.');
    };

    renderGps();
    show('auth');
    if (window.MediRouteSync && window.MediRouteSync.authenticated) {
        window.MediRouteSync.snapshot().then(function (snapshot) {
            if (snapshot && snapshot.profile) login(snapshot.profile);
            if (snapshot && snapshot.emergencies && snapshot.emergencies[0]) handleSharedSnapshot(snapshot);
        }).catch(function () {});
    }
})();
