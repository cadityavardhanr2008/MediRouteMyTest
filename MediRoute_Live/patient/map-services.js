/*
 * MediRoute patient map services.
 * Leaflet renders the map; OSM supplies map tiles; Nominatim is called only
 * after an explicit user action; OSRM supplies road geometry and estimates.
 * Public OSM/OSRM endpoints are rate-limited; deploy with a contracted provider for production use.
 */
(() => {
  "use strict";

  const CONFIG = Object.freeze({
    nominatimUrl: "https://nominatim.openstreetmap.org/search",
    osrmBaseUrl: "https://router.project-osrm.org",
    requestGapMs: 1100,
    defaultCenter: [20.5937, 78.9629],
    countryCodes: "in"
  });
  const TILE_SOURCES = Object.freeze([
    {
      id: "OpenStreetMap Standard",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
    },
    {
      id: "OpenStreetMap Humanitarian",
      url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      subdomains: "abc",
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · Map style by <a href="https://www.hotosm.org/" target="_blank" rel="noopener">Humanitarian OpenStreetMap Team</a>'
    },
    {
      id: "OpenStreetMap France",
      url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
      subdomains: "abc",
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · Tiles by <a href="https://www.openstreetmap.fr/" target="_blank" rel="noopener">OpenStreetMap France</a>'
    },
    {
      id: "Esri World Street Map backup",
      // ArcGIS MapServer's cached-tile path uses z/y/x (not z/x/y).
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      maxZoom: 19,
      attribution: 'Sources: <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, DeLorme, HERE, Garmin, USGS, Intermap, increment P Corp., NRCAN, Esri Japan, METI, Esri China (Hong Kong), TomTom and GIS User Community'
    }
  ]);

  const searchCache = new Map();
  const reverseCache = new Map();
  const routeCache = new Map();
  const lastRequestAt = { nominatim: 0, osrm: 0 };
  const requestQueues = { nominatim: Promise.resolve(), osrm: Promise.resolve() };
  const resizeObservers = new WeakMap();
  const resizeHandlers = new WeakMap();
  const tileStates = new WeakMap();
  let pickupMap = null;
  let pickupContainer = null;
  let pickupMarker = null;
  let pickupAccuracyCircle = null;
  let pickupPickHandler = null;
  let trackingMap = null;
  let trackingContainer = null;
  let trackingMarkers = [];
  let trackingRouteLayers = [];

  const validPoint = point => point && Number.isFinite(Number(point.lat)) &&
    Number.isFinite(Number(point.lng)) && Math.abs(Number(point.lat)) <= 90 &&
    Math.abs(Number(point.lng)) <= 180 && !(Number(point.lat) === 0 && Number(point.lng) === 0);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function rateLimitedRequest(kind, operation) {
    // Queue requests per public service so two clicks made close together cannot
    // accidentally bypass the one-request-per-second spacing.
    const task = requestQueues[kind].then(async () => {
      const wait = Math.max(0, CONFIG.requestGapMs - (Date.now() - lastRequestAt[kind]));
      if (wait) await sleep(wait);
      lastRequestAt[kind] = Date.now();
      return operation();
    });
    requestQueues[kind] = task.catch(() => undefined);
    return task;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetch(url, controller ? { ...options, signal: controller.signal } : options);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("The map service took too long to respond. Please try again.");
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function localityFromAddress(address = {}) {
    return String(address.suburb || address.neighbourhood || address.village || address.town ||
      address.city || address.municipality || address.county || address.state_district || "");
  }

  function normalizeResult(item) {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      id: `${item.osm_type || "place"}-${item.osm_id || `${lat.toFixed(5)}-${lng.toFixed(5)}`}`,
      name: String(item.name || item.display_name || "Mapped place"),
      displayName: String(item.display_name || item.name || "Mapped place"),
      lat,
      lng,
      type: String(item.type || item.addresstype || "place"),
      category: String(item.category || item.class || "place"),
      osmType: String(item.osm_type || ""),
      osmId: String(item.osm_id || ""),
      address: item.address || {},
      locality: localityFromAddress(item.address || {})
    };
  }

  async function searchPlaces(query, options = {}) {
    const text = String(query || "").trim();
    if (text.length < 3) throw new Error("Enter at least 3 characters to search for a public place or landmark.");

    const limit = Math.max(1, Math.min(15, Number(options.limit) || 6));
    const viewbox = options.viewbox || null;
    const bounded = Boolean(options.bounded && viewbox);
    const cacheKey = `${text.toLowerCase()}|${limit}|${bounded ? viewbox.join(",") : ""}`;
    if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

    const params = new URLSearchParams({
      q: text,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(limit),
      countrycodes: CONFIG.countryCodes
    });
    if (viewbox && viewbox.length === 4) {
      params.set("viewbox", viewbox.join(","));
      if (bounded) params.set("bounded", "1");
    }

    let response;
    try {
      response = await rateLimitedRequest("nominatim", () => fetchWithTimeout(
        `${CONFIG.nominatimUrl}?${params.toString()}`,
        { method: "GET", headers: { Accept: "application/json" } },
        15000
      ));
    } catch (error) {
      if (error?.message === "The map service took too long to respond. Please try again.") throw error;
      throw new Error("Place search is unavailable. Check your internet connection and try again.");
    }
    if (response.status === 429) throw new Error("The public place-search service is busy. Please wait a moment before trying again.");
    if (!response.ok) throw new Error(`Place search failed (HTTP ${response.status}). Please try again later.`);

    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Place search returned an unexpected response.");
    const results = payload.map(normalizeResult).filter(Boolean);
    searchCache.set(cacheKey, results);
    return results;
  }

  async function reverseGeocode(point) {
    if (!validPoint(point)) throw new Error("A valid map point is required to look up its address.");
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (reverseCache.has(cacheKey)) return reverseCache.get(cacheKey);

    const params = new URLSearchParams({
      format: "jsonv2",
      lat: lat.toFixed(6),
      lon: lng.toFixed(6),
      zoom: "18",
      addressdetails: "1"
    });
    let response;
    try {
      response = await rateLimitedRequest("nominatim", () => fetchWithTimeout(
        `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
        { method: "GET", headers: { Accept: "application/json" } },
        15000
      ));
    } catch (error) {
      if (error?.message === "The map service took too long to respond. Please try again.") throw error;
      throw new Error("Could not look up the address for this point. You can still confirm the map pin or type the address manually.");
    }
    if (response.status === 429) throw new Error("The public address-lookup service is busy. Wait a moment and try again.");
    if (!response.ok) throw new Error(`Address lookup failed (HTTP ${response.status}). You can still use the selected map pin.`);
    const payload = await response.json();
    if (!payload || !payload.display_name) throw new Error("No street address was found for this point. You can still use the selected map pin.");
    const address = payload.address || {};
    const locality = localityFromAddress(address);
    const result = {
      displayName: String(payload.display_name),
      name: String(payload.name || locality || "Selected map point"),
      locality: String(locality),
      address,
      lat,
      lng
    };
    reverseCache.set(cacheKey, result);
    return result;
  }

  function nearbyViewbox(point, radiusKm = 12) {
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const west = lng - lngDelta;
    const east = lng + lngDelta;
    const north = lat + latDelta;
    const south = lat - latDelta;
    return [west, north, east, south];
  }

  function straightLineDistanceKm(a, b) {
    const toRad = value => Number(value) * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  async function searchNearbyHospitals(point) {
    if (!validPoint(point)) throw new Error("A map-confirmed pickup location is required to search nearby hospitals.");
    const results = await searchPlaces("hospital", {
      viewbox: nearbyViewbox(point, 12),
      bounded: true,
      limit: 15
    });
    return results.filter(item => {
      const type = `${item.type} ${item.category}`.toLowerCase();
      const label = `${item.name} ${item.displayName}`.toLowerCase();
      return type.includes("hospital") || label.includes("hospital");
    }).map(item => ({
      ...item,
      distanceKm: straightLineDistanceKm(point, { lat: item.lat, lng: item.lng })
    })).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 10);
  }

  async function getRoute(origin, destination) {
    if (!validPoint(origin) || !validPoint(destination)) {
      throw new Error("A map-confirmed start and destination are required to calculate a road route.");
    }
    const a = `${Number(origin.lng).toFixed(6)},${Number(origin.lat).toFixed(6)}`;
    const b = `${Number(destination.lng).toFixed(6)},${Number(destination.lat).toFixed(6)}`;
    const cacheKey = `${a};${b}`;
    if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);

    const url = `${CONFIG.osrmBaseUrl}/route/v1/driving/${a};${b}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    let response;
    try {
      response = await rateLimitedRequest("osrm", () => fetchWithTimeout(
        url,
        { method: "GET", headers: { Accept: "application/json" } },
        18000
      ));
    } catch (error) {
      if (error?.message === "The map service took too long to respond. Please try again.") throw error;
      throw new Error("Road routing is unavailable. Check your internet connection and try again.");
    }
    if (response.status === 429) throw new Error("The public routing service is busy. Please wait before requesting another automatic route update.");
    if (!response.ok) throw new Error(`Road routing failed (HTTP ${response.status}). Please try again later.`);

    const payload = await response.json();
    const usableRoutes = Array.isArray(payload.routes) ? payload.routes.filter(route =>
      Number.isFinite(Number(route?.distance)) && Number.isFinite(Number(route?.duration)) &&
      Array.isArray(route?.geometry?.coordinates) && route.geometry.coordinates.length >= 2
    ) : [];
    if (payload.code !== "Ok" || !usableRoutes.length) {
      throw new Error("No usable drivable road route was found between these points. Move the map pin or choose another destination.");
    }
    const result = {
      routes: usableRoutes,
      waypoints: payload.waypoints || [],
      primary: usableRoutes[0],
      source: "OSRM public routing endpoint",
      fetchedAt: Date.now()
    };
    routeCache.set(cacheKey, result);
    return result;
  }

  function setMapStatus(statusId, message) {
    const note = document.getElementById(statusId);
    if (note) note.textContent = message;
  }

  function scheduleMapResize(map) {
    const resize = () => {
      if (map && map._container && map._container.isConnected) {
        map.invalidateSize({ pan: false, debounceMoveend: true });
      }
    };
    requestAnimationFrame(() => {
      resize();
      setTimeout(resize, 120);
      setTimeout(resize, 420);
      setTimeout(resize, 900);
    });
  }

  function tileFingerprint(image) {
    // Some providers return a coloured policy/limit graphic as HTTP 200. Leaflet
    // treats that as a successful tile. Compare a small, CORS-readable sample of
    // distinct tiles: a repeated non-map graphic is usually byte-for-byte alike.
    try {
      if (!image) return null;
      if (image.naturalWidth < 16 || image.naturalHeight < 16) return "tiny-image";
      const canvas = document.createElement("canvas");
      canvas.width = 12;
      canvas.height = 12;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, 12, 12);
      const pixels = context.getImageData(0, 0, 12, 12).data;
      let signature = "";
      for (let i = 0; i < pixels.length; i += 4) {
        signature += `${pixels[i] >> 4}${pixels[i + 1] >> 4}${pixels[i + 2] >> 4}${pixels[i + 3] >> 6};`;
      }
      return signature;
    } catch {
      // A host without CORS support cannot be canvas-inspected. Its image still
      // renders normally; real load errors continue to use the fallback path.
      return null;
    }
  }

  function addTileLayer(map, sourceIndex, statusId) {
    const source = TILE_SOURCES[sourceIndex];
    if (!source) {
      setMapStatus(statusId, "Map tiles are unavailable from the configured sources. Check your internet connection. You can still search for a place or enter an address manually.");
      return null;
    }

    const options = {
      minZoom: 2,
      maxZoom: source.maxZoom || 19,
      attribution: source.attribution,
      referrerPolicy: "strict-origin-when-cross-origin",
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
      detectRetina: false,
      errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
    };
    if (source.subdomains) options.subdomains = source.subdomains;

    const layer = window.L.tileLayer(source.url, options);
    const state = tileStates.get(map) || {
      sourceIndex: -1, errors: 0, loaded: 0, switching: false, layer: null,
      fingerprints: new Map(), suspiciousTiles: new Set()
    };
    state.sourceIndex = sourceIndex;
    state.errors = 0;
    state.loaded = 0;
    state.switching = false;
    state.layer = layer;
    state.fingerprints = new Map();
    state.suspiciousTiles = new Set();
    tileStates.set(map, state);

    const switchSource = reason => {
      if (state.switching || state.sourceIndex !== sourceIndex) return;
      if (sourceIndex >= TILE_SOURCES.length - 1) {
        setMapStatus(statusId, "Map tiles are not being served correctly by the available sources. Check your connection and reload, or use place search/address entry while the map service is unavailable.");
        return;
      }
      state.switching = true;
      setMapStatus(statusId, `${reason || "Map tiles are incomplete"}. Switching from ${source.id} to ${TILE_SOURCES[sourceIndex + 1].id}…`);
      setTimeout(() => {
        if (!map || !map._container || !map._container.isConnected) return;
        if (state.layer && map.hasLayer && map.hasLayer(state.layer)) map.removeLayer(state.layer);
        state.switching = false;
        addTileLayer(map, sourceIndex + 1, statusId);
        scheduleMapResize(map);
      }, 100);
    };

    layer.on("tileload", event => {
      if (state.sourceIndex !== sourceIndex || state.switching) return;
      state.loaded++;
      const coords = event?.coords;
      const key = coords ? `${coords.z}/${coords.x}/${coords.y}` : `tile-${state.loaded}`;
      const fingerprint = tileFingerprint(event?.tile);
      if (fingerprint === "tiny-image") {
        state.suspiciousTiles.add(key);
      } else if (fingerprint) {
        const matches = state.fingerprints.get(fingerprint) || new Set();
        matches.add(key);
        state.fingerprints.set(fingerprint, matches);
        // Four distinct map coordinates sharing the same full-tile fingerprint
        // strongly suggests an HTTP-200 block/limit graphic. This higher threshold
        // reduces false positives from occasional visually similar empty tiles.
        if (matches.size >= 4) {
          switchSource(`The ${source.id} endpoint returned the same graphic for ${matches.size} different map tiles`);
        }
      }
      if (state.suspiciousTiles.size >= 3) {
        switchSource(`${source.id} returned undersized tile images`);
      }
    });
    layer.on("tileerror", () => {
      if (state.sourceIndex !== sourceIndex || state.switching) return;
      state.errors++;
      if (state.errors >= 2) switchSource(`${source.id} failed to load map tiles`);
      else setMapStatus(statusId, `A map tile failed from ${source.id}; retrying…`);
    });
    layer.on("load", () => {
      if (state.sourceIndex !== sourceIndex || state.switching) return;
      if (state.errors === 0 && state.loaded > 0) {
        setMapStatus(statusId, `Map ready · ${source.id}. Map credits are shown at the lower-right of the map.`);
      } else if (state.errors > 0) {
        switchSource(`${source.id} returned incomplete map tiles`);
      }
    });
    layer.addTo(map);
    return layer;
  }

  function createTileMap(element, statusId, center = CONFIG.defaultCenter, zoom = 5) {
    const map = window.L.map(element, {
      zoomControl: true,
      scrollWheelZoom: false,
      preferCanvas: true,
      fadeAnimation: false,
      markerZoomAnimation: true
    });
    // Centre before tile creation: do not load the default India view and then
    // immediately fetch a second region when the pickup point is known.
    map.setView(center, zoom);
    // Keep a small Leaflet credit without its default long hover tooltip.
    // Provider/data attribution remains visible and is added by each tile layer.
    if (map.attributionControl?.setPrefix) {
      map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>');
    }
    addTileLayer(map, 0, statusId);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => scheduleMapResize(map));
      observer.observe(element);
      resizeObservers.set(map, observer);
    }
    map.on("load", () => scheduleMapResize(map));
    const resizeHandler = () => scheduleMapResize(map);
    window.addEventListener("resize", resizeHandler, { passive: true });
    resizeHandlers.set(map, resizeHandler);
    scheduleMapResize(map);
    return map;
  }

  function destroyTileMap(map) {
    if (!map) return;
    const observer = resizeObservers.get(map);
    if (observer) observer.disconnect();
    const resizeHandler = resizeHandlers.get(map);
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    map.remove();
  }

  function pickupIcon() {
    return window.L.divIcon({
      className: "",
      html: '<span class="mr-pickup-marker"><span class="mr-pickup-marker__pulse"></span><span class="mr-pickup-marker__dot">P</span></span>',
      iconSize: [46, 46],
      iconAnchor: [23, 23]
    });
  }

  function makeTrackingIcon(label, background) {
    return window.L.divIcon({
      className: "",
      html: `<span style="display:grid;place-items:center;width:38px;height:38px;border:3px solid #fff;border-radius:50%;background:${background};color:#fff;font-size:17px;font-weight:900;box-shadow:0 2px 12px #172b3a55">${label}</span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });
  }

  function setPickupMarker(point, shouldPan = true, notify = false) {
    if (!pickupMap || !validPoint(point)) return false;
    const latLng = [Number(point.lat), Number(point.lng)];
    const accuracy = Number(point.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 10000) {
      if (!pickupAccuracyCircle) {
        pickupAccuracyCircle = window.L.circle(latLng, {
          radius: Math.max(accuracy, 12),
          color: "#0c7184",
          weight: 2,
          opacity: 0.95,
          fillColor: "#22a7a2",
          fillOpacity: 0.13,
          dashArray: "6 7",
          interactive: false
        }).addTo(pickupMap);
      } else {
        pickupAccuracyCircle.setLatLng(latLng);
        pickupAccuracyCircle.setRadius(Math.max(accuracy, 12));
      }
    } else if (pickupAccuracyCircle) {
      pickupAccuracyCircle.remove();
      pickupAccuracyCircle = null;
    }
    if (!pickupMarker) {
      pickupMarker = window.L.marker(latLng, { draggable: true, icon: pickupIcon(), keyboard: true })
        .addTo(pickupMap)
        .bindTooltip("Pickup location · drag to adjust");
      pickupMarker.on("dragend", () => {
        const next = pickupMarker.getLatLng();
        if (pickupPickHandler) pickupPickHandler({ lat: next.lat, lng: next.lng, source: "map-pin" });
      });
    } else {
      pickupMarker.setLatLng(latLng);
    }
    if (shouldPan) pickupMap.setView(latLng, Math.max(pickupMap.getZoom(), 15));
    if (notify && pickupPickHandler) pickupPickHandler({ lat: latLng[0], lng: latLng[1], source: "map-pin" });
    return true;
  }

  function initPickupMap(onPick, initialPoint = null) {
    const element = document.getElementById("pickupMap");
    if (!element) return false;
    if (!window.L) { setMapStatus("pickupMapStatus", "Leaflet map renderer did not load. Check access to unpkg.com and reload the page."); element.textContent = "The interactive map could not load. Check your internet connection and browser content blockers."; return false; }
    pickupPickHandler = typeof onPick === "function" ? onPick : null;

    if (pickupMap && pickupContainer !== element) {
      destroyTileMap(pickupMap);
      pickupMap = null;
      pickupMarker = null;
    }
    if (!pickupMap) {
      const hasInitialPoint = validPoint(initialPoint);
      const center = hasInitialPoint ? [Number(initialPoint.lat), Number(initialPoint.lng)] : CONFIG.defaultCenter;
      pickupMap = createTileMap(element, "pickupMapStatus", center, hasInitialPoint ? 15 : 5);
      pickupContainer = element;
      pickupMap.on("click", event => setPickupMarker(event.latlng, false, true));
    }
    if (validPoint(initialPoint)) setPickupMarker(initialPoint, true);
    else clearPickupMarker();
    scheduleMapResize(pickupMap);
    return true;
  }

  function updatePickupMap(point) {
    if (!validPoint(point)) return false;
    if (!pickupMap) return false;
    return setPickupMarker(point, true, false);
  }

  function clearPickupMarker() {
    if (pickupMarker) pickupMarker.remove();
    if (pickupAccuracyCircle) pickupAccuracyCircle.remove();
    pickupMarker = null;
    pickupAccuracyCircle = null;
  }

  function pointAlongRoute(route, progress) {
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    if (coordinates.length === 1) return { lat: coordinates[0][1], lng: coordinates[0][0] };
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    const segmentLengths = [];
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const [x1, y1] = coordinates[i - 1];
      const [x2, y2] = coordinates[i];
      const meanLat = ((y1 + y2) / 2) * Math.PI / 180;
      const dx = (x2 - x1) * Math.cos(meanLat);
      const dy = y2 - y1;
      const length = Math.sqrt(dx * dx + dy * dy);
      segmentLengths.push(length);
      total += length;
    }
    if (!total) return { lat: coordinates[0][1], lng: coordinates[0][0] };
    let target = total * p;
    for (let i = 0; i < segmentLengths.length; i++) {
      const length = segmentLengths[i];
      if (target <= length || i === segmentLengths.length - 1) {
        const ratio = length ? target / length : 0;
        const from = coordinates[i];
        const to = coordinates[i + 1];
        return {
          lat: from[1] + (to[1] - from[1]) * ratio,
          lng: from[0] + (to[0] - from[0]) * ratio
        };
      }
      target -= length;
    }
    const last = coordinates[coordinates.length - 1];
    return { lat: last[1], lng: last[0] };
  }

  function routeFromProgress(route, progress) {
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return route || null;

    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    if (p <= 0) return route;

    const segmentLengths = [];
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const [x1, y1] = coordinates[i - 1];
      const [x2, y2] = coordinates[i];
      const meanLat = ((y1 + y2) / 2) * Math.PI / 180;
      const dx = (x2 - x1) * Math.cos(meanLat);
      const dy = y2 - y1;
      const length = Math.sqrt(dx * dx + dy * dy);
      segmentLengths.push(length);
      total += length;
    }
    if (!total) return route;

    let target = total * p;
    let startIndex = 0;
    let startRatio = 0;
    for (let i = 0; i < segmentLengths.length; i++) {
      const length = segmentLengths[i];
      if (target <= length || i === segmentLengths.length - 1) {
        startIndex = i;
        startRatio = length ? Math.max(0, Math.min(1, target / length)) : 0;
        break;
      }
      target -= length;
    }

    const from = coordinates[startIndex];
    const to = coordinates[startIndex + 1];
    const current = [
      from[0] + (to[0] - from[0]) * startRatio,
      from[1] + (to[1] - from[1]) * startRatio
    ];
    const remaining = [current, ...coordinates.slice(startIndex + 1).map(point => [point[0], point[1]])];
    if (remaining.length === 1) remaining.push([...remaining[0]]);

    return {
      ...route,
      distance: Number.isFinite(Number(route.distance)) ? Number(route.distance) * (1 - p) : route.distance,
      duration: Number.isFinite(Number(route.duration)) ? Number(route.duration) * (1 - p) : route.duration,
      geometry: { ...route.geometry, coordinates: remaining }
    };
  }

  function removeTrackingLayers() {
    trackingMarkers.forEach(marker => marker.remove());
    trackingRouteLayers.forEach(layer => layer.remove());
    trackingMarkers = [];
    trackingRouteLayers = [];
  }

  function renderTrackingMap(data = {}) {
    const element = document.getElementById("trackingMap");
    if (!element) return false;
    if (!window.L) { setMapStatus("trackingMapStatus", "Leaflet map renderer did not load. Check access to unpkg.com and reload the page."); element.textContent = "The interactive map could not load. Check your internet connection and browser content blockers."; return false; }

    if (trackingMap && trackingContainer !== element) {
      destroyTileMap(trackingMap);
      trackingMap = null;
    }
    if (!trackingMap) {
      const firstRoutePoint = data.route?.primary?.geometry?.coordinates?.[0];
      const center = validPoint(data.pickup) ? [Number(data.pickup.lat), Number(data.pickup.lng)] :
        (Array.isArray(firstRoutePoint) && firstRoutePoint.length >= 2 ? [Number(firstRoutePoint[1]), Number(firstRoutePoint[0])] : CONFIG.defaultCenter);
      const hasJourneyCenter = validPoint(data.pickup) || (Array.isArray(firstRoutePoint) && firstRoutePoint.length >= 2);
      trackingMap = createTileMap(element, "trackingMapStatus", center, hasJourneyCenter ? 13 : 5);
      trackingContainer = element;
    }

    removeTrackingLayers();
    const bounds = [];
    const routeList = data.route?.routes || (data.route?.primary ? [data.route.primary] : []);
    routeList.forEach((route, index) => {
      const coords = route?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const latLngs = coords.map(([lng, lat]) => [lat, lng]);
      const line = window.L.polyline(latLngs, {
        color: index === 0 ? "#176b87" : "#8baebc",
        weight: index === 0 ? 6 : 4,
        opacity: index === 0 ? 0.9 : 0.45,
        dashArray: index === 0 ? null : "7 8"
      }).addTo(trackingMap);
      trackingRouteLayers.push(line);
      latLngs.forEach(point => bounds.push(point));
    });

    const addMarker = (point, label, markerLabel, color) => {
      if (!validPoint(point)) return;
      const marker = window.L.marker([Number(point.lat), Number(point.lng)], {
        icon: makeTrackingIcon(markerLabel, color),
        keyboard: true
      }).addTo(trackingMap).bindTooltip(label);
      trackingMarkers.push(marker);
      bounds.push([Number(point.lat), Number(point.lng)]);
    };

    addMarker(data.pickup, "Patient pickup point", "P", "#176b87");
    addMarker(data.ambulance, data.ambulanceLabel || "Live ambulance position", "A", "#c83e4d");
    addMarker(data.hospital, "Selected destination hospital", "H", "#16845b");

    if (bounds.length >= 2) {
      trackingMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    } else if (bounds.length === 1) {
      trackingMap.setView(bounds[0], 15);
    } else {
      trackingMap.setView(CONFIG.defaultCenter, 5);
    }
    scheduleMapResize(trackingMap);
    return true;
  }

  window.MediRouteMaps = Object.freeze({
    config: CONFIG,
    validPoint,
    addMapBaseLayer(map, statusId) {
      if (!map || !window.L) return null;
      return addTileLayer(map, 0, statusId || "");
    },
    searchPlaces,
    reverseGeocode,
    searchNearbyHospitals,
    getRoute,
    initPickupMap,
    updatePickupMap,
    clearPickupMarker,
    renderTrackingMap,
    pointAlongRoute,
    routeFromProgress
  });
})();
