/* Shared MediRoute API client. Tokens are tab-scoped and never written into app source. */
(function (global) {
  'use strict';
  const API = '/api';
  const TOKEN_KEY = 'mediroute.session.token';
  const ROLE_KEY = 'mediroute.session.role';
  let connected = false;
  let pollingStop = null;

  function token() { try { return global.sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function role() { try { return global.sessionStorage.getItem(ROLE_KEY) || ''; } catch { return ''; } }
  function setSession(result, roleName) {
    if (!result || !result.token) throw new Error('The server did not return a session token.');
    global.sessionStorage.setItem(TOKEN_KEY, result.token);
    global.sessionStorage.setItem(ROLE_KEY, roleName);
    return result;
  }
  function clearSession() {
    try { global.sessionStorage.removeItem(TOKEN_KEY); global.sessionStorage.removeItem(ROLE_KEY); } catch {}
  }
  async function request(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {} }, options || {});
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const currentToken = token();
    if (currentToken) opts.headers.Authorization = 'Bearer ' + currentToken;
    const response = await fetch(API + path, Object.assign({ cache: 'no-store' }, opts));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || ('MediRoute API request failed (' + response.status + ')'));
    connected = true;
    return payload;
  }
  const api = {
    get connected() { return connected; },
    get role() { return role(); },
    get authenticated() { return !!token(); },
    request,
    patientLogin(identifier, password) { return request('/auth/patient/login', { method: 'POST', body: { identifier, password } }).then(r => setSession(r, 'patient')); },
    patientRegister(profile, password) { return request('/auth/patient/register', { method: 'POST', body: Object.assign({}, profile, { password }) }).then(r => setSession(r, 'patient')); },
    crewLogin(identifier, password) { return request('/auth/crew/login', { method: 'POST', body: { identifier, password } }).then(r => setSession(r, 'crew')); },
    crewRegister(profile, password) { return request('/auth/crew/register', { method: 'POST', body: Object.assign({}, profile, { password }) }).then(r => setSession(r, 'crew')); },
    snapshot() { return request('/snapshot'); },
    savePatientProfile(profile) { return request('/patient/profile', { method: 'PATCH', body: profile }); },
    createEmergency(emergency) { return request('/emergencies', { method: 'POST', body: emergency }); },
    updateEmergency(id, patch) { return request('/emergencies/' + encodeURIComponent(id), { method: 'PATCH', body: patch }); },
    updateCrewStatus(status) { return request('/crew/status', { method: 'PATCH', body: { status } }); },
    updateCrewLocation(location) { return request('/crew/location', { method: 'POST', body: location }); },
    heartbeatCrew() { return request('/crew/heartbeat', { method: 'POST', body: {} }); },
    async logout() {
      try { await request('/auth/logout', { method: 'POST', body: {} }); } finally { clearSession(); }
    },
    startPolling(callback, intervalMs) {
      if (pollingStop) pollingStop();
      let stopped = false, timer = null, inFlight = false;
      const interval = Math.max(700, Number(intervalMs) || 1200);
      async function poll() {
        if (stopped || inFlight || !token()) return schedule();
        inFlight = true;
        try { const snapshot = await api.snapshot(); callback(snapshot); }
        catch (error) {
          connected = false;
          if (error && /session|sign in/i.test(error.message || '')) callback({ sessionExpired: true, error: error.message });
          else if (global.console && console.debug) console.debug('MediRoute sync temporarily unavailable:', error.message);
        } finally { inFlight = false; schedule(); }
      }
      function schedule() { if (!stopped) timer = global.setTimeout(poll, interval); }
      poll();
      pollingStop = function () { stopped = true; if (timer) global.clearTimeout(timer); };
      return pollingStop;
    },
    stopPolling() { if (pollingStop) pollingStop(); pollingStop = null; }
  };
  global.MediRouteSync = api;
})(window);
