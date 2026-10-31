'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'patient/index.html', 'ambulance/index.html'];
const forbiddenIds = [
  'simBtn', 'skipBtn', 'movementMode', 'manualLat', 'manualLng', 'setManualLocation',
  'requestAmbulanceGuest', 'resetBtn', 'helpReset', 'moreReset', 'advanceDemoJourney'
];

for (const relativePage of pages) {
  const absolutePage = path.join(root, relativePage);
  assert.ok(fs.existsSync(absolutePage), `${relativePage} exists`);
  const html = fs.readFileSync(absolutePage, 'utf8');
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicateIds)], [], `${relativePage} has no duplicate IDs`);

  for (const id of forbiddenIds) {
    assert.equal(ids.includes(id), false, `${relativePage} does not contain removed demo/test control #${id}`);
  }

  const localRefs = [
    ...[...html.matchAll(/\bsrc=["']([^"']+)["']/gi)].map(match => match[1]),
    ...[...html.matchAll(/\bhref=["']([^"']+)["']/gi)].map(match => match[1])
  ];
  for (const ref of localRefs) {
    if (/^(?:https?:|data:|mailto:|tel:|#|javascript:)/i.test(ref)) continue;
    const clean = decodeURIComponent(ref.split(/[?#]/, 1)[0]);
    if (!clean) continue;
    const target = clean.startsWith('/') ? path.join(root, clean.slice(1)) : path.resolve(path.dirname(absolutePage), clean);
    assert.ok(fs.existsSync(target), `${relativePage} local asset/link resolves: ${ref}`);
  }
}

const patientHtml = fs.readFileSync(path.join(root, 'patient/index.html'), 'utf8');
const crewHtml = fs.readFileSync(path.join(root, 'ambulance/index.html'), 'utf8');
const gatewayHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(patientHtml, /Create an account/i, 'patient registration is offered');
assert.match(crewHtml, /Create account/i, 'crew registration is offered');
assert.doesNotMatch(patientHtml + crewHtml + gatewayHtml, /demo@mediroute\.test|demo123|Demo Crew/i, 'no seeded credentials are displayed');
assert.match(patientHtml, /map-services\.js/, 'patient portal loads shared map services');
assert.match(crewHtml, /\/patient\/map-services\.js/, 'crew portal loads the shared map services');
assert.match(patientHtml, /\/shared-sync\.js/, 'patient portal loads shared API client');
assert.match(crewHtml, /\/shared-sync\.js/, 'crew portal loads shared API client');

const ambulanceJs = fs.readFileSync(path.join(root, 'ambulance/app.js'), 'utf8');
assert.doesNotMatch(ambulanceJs, /\bshift\s*:\s*NO_SHIFT\b/, 'assigned ambulance journey does not evaluate the undefined NO_SHIFT identifier');
const startLegStart = ambulanceJs.indexOf('function startLeg(options)');
const startLegEnd = ambulanceJs.indexOf('function stopLeg()', startLegStart);
assert.ok(startLegStart >= 0 && startLegEnd > startLegStart, 'ambulance startLeg function exists');
const startLegSource = ambulanceJs.slice(startLegStart, startLegEnd);
const immediateMapIndex = startLegSource.indexOf("drawRoute('mapMain'");
const routingRequestIndex = startLegSource.indexOf('fetchRoute(leg.start, leg.end)');
assert.ok(immediateMapIndex >= 0 && routingRequestIndex > immediateMapIndex, 'pickup and ambulance endpoint markers render before the external road-route request');
assert.match(startLegSource, /Do not use the dashed locator as turn-by-turn navigation/, 'route failure keeps the pickup map visible with a clear safety warning');
assert.match(startLegSource, /updateExternalNavigation\(leg\.start, leg\.end\)/, 'crew gets an external turn-by-turn navigation fallback for the assigned destination');
assert.match(crewHtml, /id="externalNavigation"/, 'ambulance portal includes its route-navigation fallback link');
const arrivalStart = ambulanceJs.indexOf('async function arriveLeg()');
const arrivalEnd = ambulanceJs.indexOf("$('#mainAction').onclick", arrivalStart);
assert.ok(arrivalStart >= 0 && arrivalEnd > arrivalStart, 'server-confirmed arrival handler exists');
const arrivalHandler = ambulanceJs.slice(arrivalStart, arrivalEnd);
const locationWriteIndex = arrivalHandler.indexOf('await window.MediRouteSync.updateCrewLocation');
const statusWriteIndex = arrivalHandler.indexOf('await window.MediRouteSync.updateEmergency');
assert.ok(locationWriteIndex >= 0 && statusWriteIndex > locationWriteIndex, 'fresh GPS is persisted before the server arrival transition');
assert.match(arrivalHandler, /arrivalPending/, 'duplicate arrival submissions are guarded');
assert.doesNotMatch(patientHtml + crewHtml, /leaflet@1\.9\.4[^>]*crossorigin/i, 'Leaflet CDN resources are not unnecessarily forced into CORS mode');

const data = JSON.parse(fs.readFileSync(path.join(root, 'data/mediroute-data.json'), 'utf8'));
assert.deepEqual(data, { schemaVersion: 3, patients: [], crews: [], emergencies: [] }, 'initial shipped database is empty');

console.log('PASS: all portal HTML files and local references are present');
console.log('PASS: no duplicate HTML IDs');
console.log('PASS: demo/simulate/manual-location controls removed from HTML');
console.log('PASS: no seeded account credentials or demo crew content');
console.log('PASS: patient and ambulance both load the common map and sync modules');
console.log('PASS: ambulance assignment reconstruction has no undefined shift identifier');
console.log('PASS: ambulance and patient endpoint markers render before external route calculation');
console.log('PASS: route-service failure preserves pickup marker and warns against using the locator as navigation');
console.log('PASS: ambulance includes a one-click external directions fallback to the assigned destination');
console.log('PASS: arrival GPS write precedes server-side arrival transition; Leaflet CDN is not forced into CORS mode');
console.log('PASS: shipped database has no pre-existing accounts or journeys');
