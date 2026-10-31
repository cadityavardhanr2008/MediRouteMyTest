'use strict';

// MediRoute live-device field-test server. Single Node.js process; HTTPS is provided by the deployment platform.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'mediroute-data.json');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOCATION_FRESH_MS = 45_000;
const MAX_BODY = 1_000_000;
const sessions = new Map();
let writeQueue = Promise.resolve();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ schemaVersion: 3, patients: [], crews: [], emergencies: [] }, null, 2), { mode: 0o600 });
try { fs.chmodSync(DATA_DIR, 0o700); fs.chmodSync(DATA_FILE, 0o600); } catch { /* deployment filesystem may ignore POSIX modes */ }

function iso() { return new Date().toISOString(); }
function id(prefix) { return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function str(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
function validPoint(p) {
  const lat = Number(p?.lat), lng = Number(p?.lng ?? p?.lon);
  // (0, 0) is rejected as a common uninitialised-GPS sentinel in this India-first field test.
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
function cleanPoint(p) {
  if (!validPoint(p)) return null;
  const rawAccuracy = p.accuracy;
  const accuracy = rawAccuracy === null || rawAccuracy === undefined || rawAccuracy === '' ? null : Number(rawAccuracy);
  const observedAt = p.at && Number.isFinite(Date.parse(p.at)) ? new Date(p.at).toISOString() : iso();
  return { lat: Number(p.lat), lng: Number(p.lng ?? p.lon), accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : null, source: 'device', at: observedAt };
}
function distanceKm(a, b) {
  if (!validPoint(a) || !validPoint(b)) return null;
  const rad = n => n * Math.PI / 180;
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function hasFreshAccurateCrewFix(crew, maxAgeMs = LOCATION_FRESH_MS, maxAccuracyM = 80) {
  const point = crew?.location;
  if (!validPoint(point) || point.source !== 'device') return false;
  const accuracy = Number(point.accuracy);
  const age = Date.now() - Date.parse(point.at || '');
  return Number.isFinite(accuracy) && accuracy > 0 && accuracy <= maxAccuracyM &&
    Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
function readData() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.patients ||= []; data.crews ||= []; data.emergencies ||= [];
  return data;
}
async function writeData(data) {
  data.updatedAt = iso();
  const tmp = DATA_FILE + '.' + process.pid + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmp, DATA_FILE);
  try { await fs.promises.chmod(DATA_FILE, 0o600); } catch { /* permissions are platform-specific */ }
}
function mutate(fn) {
  const task = writeQueue.then(async () => {
    const data = readData();
    const result = await fn(data);
    await writeData(data);
    return result;
  });
  writeQueue = task.catch(() => {});
  return task;
}
function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'geolocation=(self)', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('Request body is too large.')); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('Request body must be valid JSON.')); } });
    req.on('error', reject);
  });
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: derived.toString('hex') };
}
async function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const actual = await hashPassword(password, user.passwordSalt);
  const a = Buffer.from(actual.hash, 'hex'), b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function stripSecrets(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, ...publicUser } = user;
  return publicUser;
}
function safeContact(c) {
  return { name: str(c?.name, 120), relationship: str(c?.relationship, 80), phone: str(c?.phone, 40), consented: !!c?.consented };
}
function addEvent(emergency, message, actor = 'system', kind = 'info') {
  emergency.timeline ||= [];
  emergency.timeline.unshift({ id: crypto.randomUUID(), at: iso(), message: str(message, 500), actor: str(actor, 80), kind });
  emergency.timeline = emergency.timeline.slice(0, 100);
}
function emergencyAlertText(emergency, eventName) {
  const p = emergency.pickupLocation || {};
  const a = emergency.assignment || {};
  const v = emergency.ambulanceLocation || a.location;
  const h = emergency.destination || {};
  const link = point => validPoint(point) ? `https://maps.google.com/?q=${Number(point.lat)},${Number(point.lng)}` : 'Not available';
  return [
    'MEDIROUTE · EMERGENCY UPDATE', `Update: ${eventName}`,
    `Patient: ${emergency.patient?.name || 'Patient'}`, `Request: ${emergency.id}`,
    `Emergency: ${emergency.details?.type || 'Medical emergency'}`,
    `Pickup: ${p.address || 'Not available'}`, `Pickup map: ${link(p.coords)}`,
    `Ambulance: ${a.unit || 'Not assigned'} · ${a.crewName || 'Crew pending'}`,
    `Ambulance position: ${validPoint(v) ? `${v.lat}, ${v.lng}` : 'Not available'}`,
    `Vehicle map: ${link(v)}`, `Status: ${emergency.status}`,
    `Hospital: ${h.hospitalName || h.name || 'Not selected'}`,
    `Hospital address: ${h.address || 'Not selected'}`, `Hospital map: ${link(h.coords)}`,
    `Updated: ${iso()}`,
    'This is an automated field-test record. No external message was sent; contact local emergency services for real assistance.'
  ].join('\n');
}
function addContactAlert(emergency, eventName) {
  const recipients = (emergency.contactRecipients || []).filter(c => c.consented && c.name && c.phone);
  if (!recipients.length) return;
  emergency.contactAlerts ||= [];
  emergency.contactAlerts.unshift({
    id: crypto.randomUUID(), event: eventName, at: iso(),
    recipients: recipients.map(c => ({ name: c.name, relationship: c.relationship, phone: c.phone })),
    message: emergencyAlertText(emergency, eventName),
    deliveryStatus: 'preview_only',
    deliveryNote: 'No SMS/WhatsApp provider is connected. This message is stored as a local preview and has not been sent.'
  });
  emergency.contactAlerts = emergency.contactAlerts.slice(0, 30);
}
function eligibleCrew(c) {
  if (c.status !== 'available' || c.online !== true || c.activeEmergencyId || !validPoint(c.location)) return false;
  if (c.location.source !== 'device' || !Number.isFinite(Number(c.location.accuracy)) || Number(c.location.accuracy) <= 0 || Number(c.location.accuracy) > 500) return false;
  // A recent GPS point alone is insufficient: a crew browser may have closed
  // after publishing it. Require a fresh heartbeat as well as a fresh fix.
  const now = Date.now();
  const locationAge = now - new Date(c.location.at || c.lastLocationAt || 0).getTime();
  const heartbeatAge = now - new Date(c.lastSeenAt || 0).getTime();
  return Number.isFinite(locationAge) && locationAge >= 0 && locationAge <= LOCATION_FRESH_MS &&
    Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= LOCATION_FRESH_MS;
}
function assignNearest(data, emergency) {
  if (!emergency || emergency.status !== 'searching' || emergency.assignment) return emergency;
  if (!validPoint(emergency.pickupLocation?.coords)) return emergency;
  const candidates = data.crews.filter(eligibleCrew).map(crew => ({ crew, km: distanceKm(emergency.pickupLocation.coords, crew.location) })).filter(x => Number.isFinite(x.km));
  candidates.sort((a, b) => a.km - b.km || String(a.crew.crewId).localeCompare(String(b.crew.crewId)));
  if (!candidates.length) return emergency;
  const chosen = candidates[0], crew = chosen.crew, now = iso();
  // A straight-line proximity check is dispatch triage only. The crew browser
  // calculates the actual drivable road route and publishes its OSRM estimate.
  const etaMinutes = null;
  emergency.status = 'assigned';
  emergency.assignment = {
    crewId: crew.crewId, crewName: crew.name, unit: crew.unit,
    phone: crew.phone || '', role: crew.role || 'Ambulance personnel',
    assignedAt: now, distanceKm: Number(chosen.km.toFixed(2)), etaMinutes,
    location: { ...crew.location }
  };
  emergency.ambulanceLocation = { ...crew.location };
  emergency.route = { distanceKm: null, etaMinutes: null, updatedAt: now, source: 'awaiting ambulance road-route calculation' };
  emergency.updatedAt = now;
  crew.status = 'busy'; crew.activeEmergencyId = emergency.id; crew.lastSeenAt = now;
  addEvent(emergency, `Nearest available ambulance ${crew.unit} assigned from ${Number(chosen.km.toFixed(2))} km away.`, 'dispatch', 'success');
  addContactAlert(emergency, 'Ambulance assigned');
  return emergency;
}
function dispatchWaiting(data) {
  const waiting = data.emergencies.filter(e => e.status === 'searching' && !e.assignment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  waiting.forEach(e => assignNearest(data, e));
}
function publicEmergency(e) {
  return JSON.parse(JSON.stringify(e));
}
function emergencyForCrew(e) {
  const copy = publicEmergency(e);
  // Crew members need the assigned patient's care details, not the patient's
  // separately-consented family contact list or contact-alert message history.
  delete copy.contactRecipients;
  delete copy.contactAlerts;
  if (copy.patient) {
    copy.patient = { id: copy.patient.id, name: copy.patient.name, phone: copy.patient.phone || '', blood: copy.patient.blood || '' };
  }
  return copy;
}
function createSession(role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function requireSession(req, role) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now() || (role && s.role !== role)) return null;
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return { ...s, token };
}
function getUser(data, session) {
  if (!session) return null;
  return session.role === 'patient' ? data.patients.find(p => p.id === session.userId) :
    session.role === 'crew' ? data.crews.find(c => c.id === session.userId) : null;
}
function profileForPatient(p) {
  return { id: p.id, name: p.name, email: p.email, phone: p.phone || '', blood: p.blood || '', emergencyContact: p.emergencyContact || '', emergencyContacts: (p.emergencyContacts || []).map(safeContact) };
}
function crewPublic(c) {
  return c ? { crewId: c.crewId, name: c.name, unit: c.unit, phone: c.phone || '', email: c.email || '', role: c.role || '', status: c.status, online: !!c.online, activeEmergencyId: c.activeEmergencyId || null, trips: Number(c.trips || 0), location: c.location || null } : null;
}
function snapshotFor(data, session) {
  const user = getUser(data, session);
  if (session.role === 'patient') {
    const emergencies = data.emergencies.filter(e => e.patientId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicEmergency);
    return { role: 'patient', profile: profileForPatient(user), emergencies };
  }
  if (session.role === 'crew') {
    const emergencies = data.emergencies.filter(e => e.assignment?.crewId === user.crewId && e.status !== 'completed' &&
      (e.status !== 'cancelled' || Date.now() - new Date(e.updatedAt).getTime() < 5 * 60 * 1000))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(emergencyForCrew);
    return { role: 'crew', profile: Object.assign(crewPublic(user), { activeEmergencyId: user.activeEmergencyId || null, trips: Number(user.trips || 0) }), emergencies };
  }
  return { role: 'unknown', emergencies: [] };
}
function makeEmergency(body, patient) {
  const pickup = body.pickupLocation || body.location || {};
  if (!str(pickup.address, 400) || !validPoint(pickup.coords)) throw new Error('A pickup map point with coordinates is required for nearest-ambulance assignment. Detect your location or select the pickup point on the map, then confirm it.');
  const details = body.details || {};
  if (!str(details.type, 120)) throw new Error('Choose an emergency category.');
  const now = iso();
  const contacts = (patient.emergencyContacts || []).map(safeContact).filter(c => c.name && c.phone && c.consented);
  return {
    id: id('MR'), patientId: patient.id, createdAt: now, updatedAt: now,
    patient: profileForPatient(patient),
    pickupLocation: { address: str(pickup.address, 400), coords: cleanPoint(pickup.coords), source: str(pickup.source || 'map-pin', 30) },
    details: { type: str(details.type, 120), description: str(details.description, 1000), contact: str(details.contact || patient.phone, 40), blood: str(details.blood || patient.blood, 20) },
    contactRecipients: contacts,
    status: 'searching', assignment: null, ambulanceLocation: null,
    patientAssessment: null, destination: null,
    route: { distanceKm: null, etaMinutes: null, updatedAt: now, source: 'awaiting ambulance assignment' },
    timeline: [], contactAlerts: []
  };
}


async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).slice(1);
  const method = req.method;
  if (method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true, name: 'MediRoute', timestamp: iso(), schemaVersion: 3 });

  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'patient' && parts[2] === 'register') {
    const body = await readBody(req);
    const name = str(body.name, 120), email = str(body.email, 180).toLowerCase(), password = String(body.password || '');
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) return send(res, 400, { error: 'Enter a valid name, email and password (at least 8 characters).' });
    const pass = await hashPassword(password);
    const result = await mutate(data => {
      if (data.patients.some(p => p.email === email)) return { conflict: true };
      const p = { id: id('MRP'), name, email, phone: str(body.phone, 40), blood: str(body.blood, 20), emergencyContact: '', emergencyContacts: [], passwordSalt: pass.salt, passwordHash: pass.hash, createdAt: iso() };
      data.patients.push(p); return p;
    });
    if (result.conflict) return send(res, 409, { error: 'An account with this email already exists. Please sign in.' });
    const token = createSession('patient', result.id);
    return send(res, 201, { token, profile: profileForPatient(result) });
  }
  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'patient' && parts[2] === 'login') {
    const body = await readBody(req), identifier = str(body.identifier, 180).toLowerCase();
    const data = readData();
    const patient = data.patients.find(p => p.email === identifier || p.id.toLowerCase() === identifier);
    if (!patient || !(await verifyPassword(body.password, patient))) return send(res, 401, { error: 'Invalid patient email/ID or password.' });
    const token = createSession('patient', patient.id);
    return send(res, 200, { token, profile: profileForPatient(patient) });
  }
  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'crew' && parts[2] === 'register') {
    const body = await readBody(req);
    const name = str(body.name, 120), crewId = str(body.crewId, 80), unit = str(body.unit, 80), email = str(body.email, 180).toLowerCase(), phone = str(body.phone, 40), password = String(body.password || '');
    if (name.length < 2 || crewId.length < 2 || unit.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) return send(res, 400, { error: 'Complete name, crew ID, ambulance unit and password (at least 8 characters).' });
    if (phone && !/^\+?[\d\s()-]{7,20}$/.test(phone)) return send(res, 400, { error: 'Enter a valid crew mobile number.' });
    const pass = await hashPassword(password);
    const result = await mutate(data => {
      if (data.crews.some(c => c.crewId.toLowerCase() === crewId.toLowerCase() || c.unit.toLowerCase() === unit.toLowerCase() || (email && c.email === email))) return { conflict: true };
      const crew = { id: crypto.randomUUID(), crewId, name, unit, email, phone, role: str(body.role || 'Compounder', 80), passwordSalt: pass.salt, passwordHash: pass.hash, status: 'offline', online: false, location: null, createdAt: iso(), lastSeenAt: null, activeEmergencyId: null, trips: 0 };
      data.crews.push(crew); return crew;
    });
    if (result.conflict) return send(res, 409, { error: 'Crew ID, unit or email is already registered.' });
    const token = createSession('crew', result.id);
    return send(res, 201, { token, profile: crewPublic(result) });
  }
  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'crew' && parts[2] === 'login') {
    const body = await readBody(req), identifier = str(body.identifier, 180).toLowerCase();
    const data = readData();
    const crew = data.crews.find(c => c.crewId.toLowerCase() === identifier || c.email.toLowerCase() === identifier);
    if (!crew || !(await verifyPassword(body.password, crew))) return send(res, 401, { error: 'Invalid crew ID/email or password.' });
    const token = createSession('crew', crew.id);
    const signedIn = await mutate(d => { const c = d.crews.find(x => x.id === crew.id); c.online = true; c.lastSeenAt = iso(); return c; });
    return send(res, 200, { token, profile: crewPublic(signedIn) });
  }
  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = sessions.get(token);
    if (s) {
      sessions.delete(token);
      if (s.role === 'crew') await mutate(data => { const c = data.crews.find(x => x.id === s.userId); if (c && !c.activeEmergencyId) { c.online = false; c.status = 'offline'; c.lastSeenAt = iso(); } });
    }
    return send(res, 200, { ok: true });
  }

  const session = requireSession(req);
  if (!session) return send(res, 401, { error: 'Sign in to MediRoute again. Your local session may have expired.' });
  if (method === 'GET' && parts[0] === 'snapshot') {
    const data = readData();
    return send(res, 200, snapshotFor(data, session));
  }

  if (method === 'PATCH' && parts[0] === 'patient' && parts[1] === 'profile' && session.role === 'patient') {
    const body = await readBody(req);
    const profile = await mutate(data => {
      const p = getUser(data, session); if (!p) return null;
      const nextEmail = str(body.email || p.email, 180).toLowerCase();
      if (!nextEmail.includes('@')) throw new Error('Enter a valid email address.');
      if (data.patients.some(other => other.id !== p.id && other.email === nextEmail)) throw new Error('That email address is already used by another patient account.');
      p.name = str(body.name || p.name, 120); p.email = nextEmail; p.phone = str(body.phone, 40); p.blood = str(body.blood, 20);
      const contacts = Array.isArray(body.emergencyContacts) ? body.emergencyContacts.slice(0, 2).map(safeContact) : p.emergencyContacts || [];
      for (const c of contacts) if ((c.name || c.phone || c.relationship || c.consented) && (!c.name || !c.phone)) throw new Error('Each configured emergency contact needs a name and mobile number.');
      p.emergencyContacts = contacts; p.emergencyContact = contacts.find(c => c.phone)?.phone || '';
      p.updatedAt = iso();
      return profileForPatient(p);
    });
    return profile ? send(res, 200, { profile }) : send(res, 404, { error: 'Patient account not found.' });
  }

  if (method === 'PATCH' && parts[0] === 'crew' && parts[1] === 'status' && session.role === 'crew') {
    const body = await readBody(req), status = str(body.status, 20);
    if (!['available', 'break', 'offline'].includes(status)) return send(res, 400, { error: 'Invalid crew availability status.' });
    const result = await mutate(data => {
      const c = getUser(data, session); if (!c) return null;
      if (c.activeEmergencyId) return { conflict: true };
      c.status = status; c.online = status !== 'offline'; c.lastSeenAt = iso();
      dispatchWaiting(data);
      return crewPublic(c);
    });
    if (result?.conflict) return send(res, 409, { error: 'Complete the current assignment before changing availability.' });
    return result ? send(res, 200, { crew: result }) : send(res, 404, { error: 'Crew account not found.' });
  }
  if (method === 'POST' && parts[0] === 'crew' && parts[1] === 'heartbeat' && session.role === 'crew') {
    const result = await mutate(data => { const c = getUser(data, session); if (!c) return null; c.online = c.status !== 'offline'; c.lastSeenAt = iso(); dispatchWaiting(data); return crewPublic(c); });
    return result ? send(res, 200, { crew: result }) : send(res, 404, { error: 'Crew account not found.' });
  }
  if (method === 'POST' && parts[0] === 'crew' && parts[1] === 'location' && session.role === 'crew') {
    const body = await readBody(req), point = cleanPoint(body);
    if (!point) return send(res, 400, { error: 'A valid device GPS latitude and longitude are required.' });
    if (!body.at || !Number.isFinite(Date.parse(body.at)) || Date.now() - Date.parse(point.at) > 30000 || Date.parse(point.at) > Date.now() + 5000) return send(res, 400, { error: 'The device GPS fix is stale. Wait for a fresh location reading.' });
    if (body.accuracy === null || body.accuracy === undefined || body.accuracy === '' || !Number.isFinite(Number(body.accuracy)) || Number(body.accuracy) <= 0 || Number(body.accuracy) > 500) return send(res, 400, { error: 'GPS accuracy must be available and no worse than 500 metres.' });
    const result = await mutate(data => {
      const c = getUser(data, session); if (!c) return null;
      c.location = point; c.lastSeenAt = iso(); c.online = true;
      if (c.activeEmergencyId) {
        const e = data.emergencies.find(x => x.id === c.activeEmergencyId);
        if (e) {
          e.ambulanceLocation = point; e.updatedAt = iso();
          if (e.status === 'assigned') { e.status = 'approaching'; addEvent(e, 'Ambulance began travelling toward the pickup location.', 'crew'); addContactAlert(e, 'Ambulance approaching'); }
        }
      }
      dispatchWaiting(data);
      return { crew: crewPublic(c), assignedEmergencyId: c.activeEmergencyId || null };
    });
    return result ? send(res, 200, result) : send(res, 404, { error: 'Crew account not found.' });
  }

  if (method === 'POST' && parts[0] === 'emergencies' && parts.length === 1) {
    if (session.role !== 'patient') return send(res, 403, { error: 'Only a signed-in patient can create an emergency request.' });
    const body = await readBody(req);
    const created = await mutate(data => {
      const patient = getUser(data, session);
      if (!patient) throw new Error('Patient account not found.');
      const alreadyActive = data.emergencies.find(e => e.patientId === patient.id && !['completed', 'cancelled'].includes(e.status));
      if (alreadyActive) throw new Error('You already have an active emergency request. Follow or cancel that request before creating another.');
      const emergency = makeEmergency(body, patient);
      data.emergencies.unshift(emergency);
      addEvent(emergency, 'Emergency request submitted and added to nearest-ambulance dispatch.', 'patient', 'success');
      addContactAlert(emergency, 'Emergency request created');
      assignNearest(data, emergency);
      return publicEmergency(emergency);
    });
    return send(res, 201, { emergency: created });
  }

  if (method === 'PATCH' && parts[0] === 'emergencies' && parts[1]) {
    const requestId = parts[1], body = await readBody(req);
    const updated = await mutate(data => {
      const e = data.emergencies.find(x => x.id === requestId); if (!e) return null;
      if (session.role === 'patient') {
        if (e.patientId !== session.userId) throw new Error('You cannot access this emergency request.');
        // Patients may cancel only before the patient is
        // picked up. They cannot alter dispatch, crew, intake or destination data.
        if (body.status !== 'cancelled') throw new Error('Patients can only cancel their own request.');
        if (!['searching', 'assigned', 'approaching', 'at_pickup'].includes(e.status)) {
          throw new Error('This request can no longer be cancelled from the patient portal because pickup has progressed.');
        }
      } else if (session.role === 'crew') {
        if (e.assignment?.crewId !== getUser(data, session)?.crewId) throw new Error('This emergency is not assigned to your crew.');
      } else throw new Error('This action is not permitted.');

      const oldStatus = e.status;
      if (session.role === 'crew') {
        if (body.status && !['at_pickup', 'pickedup', 'enroute', 'arrived', 'completed', 'cancelled'].includes(body.status)) throw new Error('Invalid journey transition.');
        const allowedNext = { assigned: ['at_pickup', 'cancelled'], approaching: ['at_pickup', 'cancelled'], at_pickup: ['pickedup', 'cancelled'], pickedup: ['enroute', 'cancelled'], enroute: ['arrived', 'cancelled'], arrived: ['completed'] };
        if (body.status && body.status !== e.status && !(allowedNext[e.status] || []).includes(body.status)) throw new Error('That journey transition is not valid from the current status (' + e.status + ').');
        const actingCrew = getUser(data, session);
        if (body.status === 'at_pickup') {
          if (!hasFreshAccurateCrewFix(actingCrew, 45000, 80) || distanceKm(actingCrew.location, e.pickupLocation?.coords) > 0.15) {
            throw new Error('Pickup arrival can only be confirmed when the ambulance device GPS is fresh, accurate, and within 150 metres of the pickup point.');
          }
        }
        if (body.status === 'arrived') {
          if (!e.destination?.coords || !hasFreshAccurateCrewFix(actingCrew, 45000, 80) || distanceKm(actingCrew.location, e.destination.coords) > 0.15) {
            throw new Error('Hospital arrival can only be confirmed when the ambulance device GPS is fresh, accurate, and within 150 metres of the selected hospital.');
          }
        }
        if (body.status) e.status = body.status;
        if (body.patientAssessment) e.patientAssessment = body.patientAssessment;
        if (body.destination) {
          if (!str(body.destination.hospitalName || body.destination.name, 200) || !validPoint(body.destination.coords)) throw new Error('Choose a hospital with a valid map location before starting the hospital journey.');
          e.destination = { hospitalId: str(body.destination.hospitalId || body.destination.id || '', 120), hospitalName: str(body.destination.hospitalName || body.destination.name, 200), name: str(body.destination.name || body.destination.hospitalName, 200), address: str(body.destination.address, 500), phone: str(body.destination.phone, 40), coords: cleanPoint(body.destination.coords), facilities: Array.isArray(body.destination.facilities) ? body.destination.facilities.slice(0, 30).map(x => str(x, 100)) : [] };
        }
        if (body.route) {
          const km = body.route.distanceKm == null ? null : Number(body.route.distanceKm);
          const minutes = body.route.etaMinutes == null ? null : Number(body.route.etaMinutes);
          if ((km !== null && (!Number.isFinite(km) || km < 0 || km > 10000)) || (minutes !== null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 100000))) throw new Error('Invalid road-route estimate.');
          e.route = { distanceKm: km, etaMinutes: minutes, source: str(body.route.source || 'road route', 80), updatedAt: iso() };
          if (e.assignment) { e.assignment.distanceKm = km; e.assignment.etaMinutes = minutes; }
        }
        if (body.ambulanceLocation && validPoint(body.ambulanceLocation)) e.ambulanceLocation = cleanPoint(body.ambulanceLocation);
      } else {
        e.status = 'cancelled';
      }
      e.updatedAt = iso();
      if (body.status && e.status !== oldStatus) {
        addEvent(e, body.eventMessage || ('Journey status updated to ' + e.status.replace(/_/g, ' ') + '.'), session.role, ['completed', 'cancelled'].includes(e.status) ? 'success' : 'info');
        const alertEvent = ({ at_pickup: 'Ambulance arrived at pickup', pickedup: 'Patient picked up', enroute: 'Ambulance en route to hospital', arrived: 'Ambulance arrived at hospital', completed: 'Patient handover completed', cancelled: 'Emergency request cancelled' })[e.status];
        if (alertEvent) addContactAlert(e, alertEvent);
      }
      if (session.role === 'crew' && e.status === 'completed') {
        const crew = getUser(data, session); if (crew) { crew.status = 'available'; crew.activeEmergencyId = null; crew.trips = Number(crew.trips || 0) + 1; crew.lastSeenAt = iso(); }
        // Release the unit and immediately try the oldest waiting patient request.
        dispatchWaiting(data);
      }
      if (e.status === 'cancelled') {
        const crew = data.crews.find(c => c.crewId === e.assignment?.crewId);
        if (crew) { crew.status = 'available'; crew.activeEmergencyId = null; crew.lastSeenAt = iso(); }
        dispatchWaiting(data);
      }
      return publicEmergency(e);
    });
    if (!updated) return send(res, 404, { error: 'Emergency was not found.' });
    return session.role === 'crew' ? send(res, 200, { emergency: emergencyForCrew(updated) }) : send(res, 200, { emergency: updated });
  }

  return send(res, 404, { error: 'Unknown MediRoute API route.' });
}

function localIPv4() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) for (const e of entries || []) if (e.family === 'IPv4' && !e.internal) out.push(e.address);
  return out;
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Only GET and HEAD are supported for static files.' });
  let reqPath = decodeURIComponent(url.pathname);
  // The JSON data store contains account hashes, patient profiles, contact
  // details and active requests. It must never be exposed as a static asset.
  if (reqPath === '/data' || reqPath.startsWith('/data/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('File not found.');
  }
  if (reqPath === '/') reqPath = '/index.html';
  else if (reqPath.endsWith('/')) reqPath += 'index.html';
  let filePath = path.resolve(ROOT, '.' + reqPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) return send(res, 403, { error: 'Forbidden.' });
  try {
    const stat = await fs.promises.stat(filePath); if (!stat.isFile()) throw new Error('Not a file');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'geolocation=(self)', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('File not found.'); }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch { return send(res, 400, { error: 'Invalid URL.' }); }
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (error) { if (!res.headersSent) send(res, 400, { error: error.message || 'MediRoute API error.' }); }
    return;
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
    const actualPort = server.address().port;
    console.log('\nMediRoute live field-test server is running.');
    console.log('Role selection: http://localhost:' + actualPort + '/');
    console.log('Patient portal: http://localhost:' + actualPort + '/patient/');
    console.log('Ambulance portal: http://localhost:' + actualPort + '/ambulance/');
    console.log('\nLAN addresses (for same-Wi-Fi access; use HTTPS for device GPS):');
    localIPv4().forEach(ip => console.log('  http://' + ip + ':' + actualPort + '/'));
    console.log('\nNo accounts are pre-created. Register a patient and ambulance crew account in their respective portals.');
    console.log('Use HTTPS for real device geolocation. Do not use this field-test build for real emergency dispatch.\n');
  });
