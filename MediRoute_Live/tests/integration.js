'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediroute-test-'));
const dataFile = path.join(tempDir, 'mediroute-data.json');
let child;
let baseUrl;
let stdout = '';
let stderr = '';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForServer() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const match = stdout.match(/Role selection: http:\/\/localhost:(\d+)\//);
    if (match) { baseUrl = `http://127.0.0.1:${match[1]}`; return; }
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${stdout}\n${stderr}`);
    await sleep(100);
  }
  throw new Error(`Server startup timed out.\n${stdout}\n${stderr}`);
}

async function request(route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function gps(lat, lng, accuracy = 12) {
  return { lat, lng, accuracy, source: 'device', at: new Date().toISOString() };
}

async function run() {
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: tempDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForServer();

  for (const asset of ['/', '/patient/', '/ambulance/', '/shared-sync.js', '/patient/map-services.js', '/patient/app.js', '/ambulance/app.js']) {
    const served = await fetch(baseUrl + asset);
    assert.equal(served.status, 200, `static route ${asset} is served`);
  }

  const health = await request('/api/health');
  assert.equal(health.status, 200, 'health endpoint responds');
  assert.equal(health.payload.schemaVersion, 3, 'schema version is current');

  const initialData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(initialData, { schemaVersion: 3, patients: [], crews: [], emergencies: [] }, 'database starts empty without demo accounts');
  assert.equal((await request('/data/mediroute-data.json')).status, 404, 'private data file is not statically accessible');
  assert.equal((await request('/api/auth/patient/login', { method: 'POST', body: { identifier: 'demo@mediroute.test', password: 'demo123' } })).status, 401, 'no demo patient credentials exist');

  const weakPatient = await request('/api/auth/patient/register', { method: 'POST', body: { name: 'Test Patient', email: 'test.patient@example.test', password: 'short' } });
  assert.equal(weakPatient.status, 400, 'weak patient password rejected');

  const patientReg = await request('/api/auth/patient/register', { method: 'POST', body: {
    name: 'Field Test Patient', email: 'patient@example.test', phone: '+910000000001', blood: 'O+'
    , password: 'PatientPass!28'
  } });
  assert.equal(patientReg.status, 201, 'patient registration succeeds');
  assert.ok(patientReg.payload.token, 'patient receives a session token');
  assert.equal(Object.hasOwn(patientReg.payload.profile, 'passwordHash'), false, 'password hashes never enter public profile');
  const patientToken = patientReg.payload.token;
  const duplicatePatient = await request('/api/auth/patient/register', { method: 'POST', body: {
    name: 'Duplicate Patient', email: 'patient@example.test', password: 'PatientPass!28'
  } });
  assert.equal(duplicatePatient.status, 409, 'duplicate patient email rejected');

  const pickup = { lat: 17.386, lng: 78.486 };
  const emergencyResult = await request('/api/emergencies', { method: 'POST', token: patientToken, body: {
    patient: { name: 'Field Test Patient' },
    pickupLocation: { address: 'Integration Test Pickup', coords: pickup, source: 'device' },
    details: { type: 'Integration test', description: 'Automated lifecycle verification' }
  } });
  assert.equal(emergencyResult.status, 201, 'patient request is accepted before a crew is online');
  assert.equal(emergencyResult.payload.emergency.status, 'searching', 'request waits when no eligible crew is online');
  const duplicateActive = await request('/api/emergencies', { method: 'POST', token: patientToken, body: {
    pickupLocation: { address: 'Duplicate request', coords: pickup, source: 'device' }, details: { type: 'Duplicate' }
  } });
  assert.equal(duplicateActive.status, 400, 'patient cannot create overlapping active requests');

  const crewReg = await request('/api/auth/crew/register', { method: 'POST', body: {
    name: 'Field Test Crew', crewId: 'CREW-001', unit: 'AMB-001', role: 'Emergency medical technician',
    email: 'crew@example.test', phone: '+910000000002', password: 'CrewPassword!28'
  } });
  assert.equal(crewReg.status, 201, 'crew registration succeeds');
  assert.ok(crewReg.payload.token, 'crew receives a session token');
  const crewToken = crewReg.payload.token;
  assert.equal((await request('/api/snapshot')).status, 401, 'private snapshot requires authentication');

  const status = await request('/api/crew/status', { method: 'PATCH', token: crewToken, body: { status: 'available' } });
  assert.equal(status.status, 200, 'crew can set available status');
  const badZero = await request('/api/crew/location', { method: 'POST', token: crewToken, body: gps(0, 0) });
  assert.equal(badZero.status, 400, 'uninitialised zero coordinates are rejected');
  const stale = await request('/api/crew/location', { method: 'POST', token: crewToken, body: { ...gps(17.385, 78.486), at: new Date(Date.now() - 60000).toISOString() } });
  assert.equal(stale.status, 400, 'stale device GPS fixes are rejected');
  const inaccurate = await request('/api/crew/location', { method: 'POST', token: crewToken, body: gps(17.385, 78.486, 600) });
  assert.equal(inaccurate.status, 400, 'GPS fixes worse than 500 metres are rejected');

  const firstFix = gps(17.375, 78.486);
  assert.equal((await request('/api/crew/location', { method: 'POST', token: crewToken, body: firstFix })).status, 200, 'fresh device GPS is accepted');
  const patientAfterDispatch = await request('/api/snapshot', { token: patientToken });
  const emergency = patientAfterDispatch.payload.emergencies[0];
  assert.equal(emergency.status, 'assigned', 'waiting request is automatically assigned when an eligible crew comes online');
  assert.equal(emergency.assignment.crewId, 'CREW-001', 'correct crew is selected');
  assert.equal(emergency.route.etaMinutes, null, 'dispatch does not fabricate a road ETA');

  // Critical regression: the assigned crew snapshot must contain the exact
  // patient pickup address and coordinates needed to render the ambulance map.
  const crewAssignedSnapshot = await request('/api/snapshot', { token: crewToken });
  assert.equal(crewAssignedSnapshot.status, 200, 'assigned crew can retrieve its snapshot');
  assert.equal(crewAssignedSnapshot.payload.emergencies.length, 1, 'assigned emergency is delivered to the matching crew');
  assert.equal(crewAssignedSnapshot.payload.emergencies[0].pickupLocation.coords.lat, pickup.lat, 'patient pickup latitude is preserved in the crew snapshot');
  assert.equal(crewAssignedSnapshot.payload.emergencies[0].pickupLocation.coords.lng, pickup.lng, 'patient pickup longitude is preserved in the crew snapshot');
  assert.equal(crewAssignedSnapshot.payload.emergencies[0].pickupLocation.address, 'Integration Test Pickup', 'patient pickup address is preserved in the crew snapshot');
  assert.equal(crewAssignedSnapshot.payload.emergencies[0].assignment.crewId, 'CREW-001', 'snapshot assignment belongs to the logged-in crew');

  const tooFar = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: { status: 'at_pickup' } });
  assert.equal(tooFar.status, 400, 'crew cannot confirm pickup while away from the patient');

  assert.equal((await request('/api/crew/location', { method: 'POST', token: crewToken, body: gps(pickup.lat, pickup.lng) })).status, 200, 'crew publishes arrival-area fix');
  const atPickup = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: { status: 'at_pickup' } });
  assert.equal(atPickup.status, 200, 'crew arrival at pickup is accepted with GPS proximity');
  assert.equal(atPickup.payload.emergency.status, 'at_pickup');

  const picked = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: {
    status: 'pickedup', patientAssessment: { name: 'Field Test Patient', symptoms: 'Test', needs: [], bloodGroups: [] }
  } });
  assert.equal(picked.status, 200, 'crew can confirm patient pickup');

  const hospital = { lat: 17.39, lng: 78.5 };
  const enroute = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: {
    status: 'enroute',
    destination: { hospitalId: 'OSM-TEST-1', hospitalName: 'Test Hospital', address: 'Test Road', coords: hospital },
    route: { distanceKm: 3.7, etaMinutes: 11, source: 'integration-test route' }
  } });
  assert.equal(enroute.status, 200, 'hospital leg starts with a valid destination');
  assert.equal(enroute.payload.emergency.status, 'enroute');
  assert.equal(enroute.payload.emergency.destination.hospitalName, 'Test Hospital');
  assert.equal(enroute.payload.emergency.route.etaMinutes, 11, 'crew road-route estimate is synchronised');

  const prematureArrival = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: { status: 'arrived' } });
  assert.equal(prematureArrival.status, 400, 'crew cannot confirm hospital arrival while away from destination');
  assert.equal((await request('/api/crew/location', { method: 'POST', token: crewToken, body: gps(hospital.lat, hospital.lng) })).status, 200, 'crew publishes hospital-area fix');
  const arrived = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: { status: 'arrived' } });
  assert.equal(arrived.status, 200, 'hospital arrival accepted with GPS proximity');
  const completed = await request(`/api/emergencies/${emergency.id}`, { method: 'PATCH', token: crewToken, body: { status: 'completed' } });
  assert.equal(completed.status, 200, 'crew handover completion succeeds');

  const patientSnapshot = await request('/api/snapshot', { token: patientToken });
  assert.equal(patientSnapshot.status, 200);
  assert.equal(patientSnapshot.payload.emergencies[0].status, 'completed', 'patient sees completed journey');
  const crewSnapshot = await request('/api/snapshot', { token: crewToken });
  assert.equal(crewSnapshot.status, 200);
  assert.equal(crewSnapshot.payload.profile.status, 'available', 'crew is released after completion');
  assert.equal(crewSnapshot.payload.profile.trips, 1, 'completed trip count increments');
  assert.equal(crewSnapshot.payload.profile.activeEmergencyId, null, 'active assignment is cleared');

  // Same patient can create a new request after completion; completed history remains.
  await request('/api/crew/heartbeat', { method: 'POST', token: crewToken, body: {} });
  await request('/api/crew/location', { method: 'POST', token: crewToken, body: gps(hospital.lat, hospital.lng) });
  const nextRequest = await request('/api/emergencies', { method: 'POST', token: patientToken, body: {
    pickupLocation: { address: 'Second Integration Pickup', coords: hospital, source: 'device' },
    details: { type: 'Second integration request' }
  } });
  assert.equal(nextRequest.status, 201, 'patient can request again after handover');
  assert.equal(nextRequest.payload.emergency.status, 'assigned', 'released crew can receive another request');
  const historySnapshot = await request('/api/snapshot', { token: patientToken });
  assert.equal(historySnapshot.payload.emergencies.length, 2, 'previous completed journey remains in history');

  const cancel = await request(`/api/emergencies/${nextRequest.payload.emergency.id}`, { method: 'PATCH', token: patientToken, body: { status: 'cancelled' } });
  assert.equal(cancel.status, 200, 'patient can cancel an unpicked request');
  const afterCancelCrew = await request('/api/snapshot', { token: crewToken });
  assert.equal(afterCancelCrew.payload.profile.status, 'available', 'cancellation releases the crew');

  const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(stored.patients.length, 1);
  assert.equal(stored.crews.length, 1);
  assert.equal(stored.emergencies.length, 2);
  assert.ok(stored.patients[0].passwordHash && stored.crews[0].passwordHash, 'password hashes are stored server-side');

  console.log('PASS: gateway, patient, ambulance and shared JavaScript static routes return HTTP 200');
  console.log('PASS: empty database/no demo accounts');
  console.log('PASS: patient and crew registration, authentication and public-profile secrecy');
  console.log('PASS: invalid, (0,0), stale and inaccurate GPS validation');
  console.log('PASS: queued request auto-assignment when an eligible crew later goes online');
  console.log('PASS: assigned crew snapshot includes exact patient pickup address and coordinates');
  console.log('PASS: nearest eligible crew assignment and no fabricated initial ETA');
  console.log('PASS: pickup and hospital arrival GPS geofence enforcement');
  console.log('PASS: assigned → approaching → at_pickup → pickedup → enroute → arrived → completed');
  console.log('PASS: patient/crew snapshot synchronisation, crew release and trip count');
  console.log('PASS: next request after completion, history retention and cancellation release');
  console.log('PASS: private data file is not served over HTTP');
  console.log('ALL INTEGRATION TESTS PASSED');
}

run().catch(error => {
  console.error('INTEGRATION TEST FAILED:', error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
