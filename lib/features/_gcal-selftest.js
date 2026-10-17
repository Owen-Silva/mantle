'use strict';
/*
 * _gcal-selftest.js - Google Calendar proving its Electron half inside a --test instance
 * (MANTLE_GCAL_SELFTEST=1; loaded only by lib/features/gcal.js, and only in --test).
 *
 * MOCKED GOOGLE: a fake google object answers every request; nothing leaves the PC and no real token
 * or client file is touched. What is REAL here: Electron's safeStorage (Windows DPAPI) encrypting the
 * fake sign-in on disk, the store in the test profile's userData, the engine, and the feature's own
 * replay/broadcast path. Result: one line, "gcal: SELFTEST n passed, m failed", in mantle.log and stdout.
 */
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./_gcal-sync');
const { createStore } = require('./_gcal-store');
const C = require('./_gcal-core');

async function run({ ctx, app, safeStorage, last }) {
  let passed = 0; const fails = [];
  const check = (name, ok, d) => { if (ok) passed++; else fails.push(name + (d !== undefined ? ' (' + String(d).slice(0, 160) + ')' : '')); };
  const dir = path.join(app.getPath('userData'), 'gcal-selftest');
  try {
    check('the feature published its status at install', !!last.status && last.status.test === true && last.status.signedIn === false, JSON.stringify(last.status));
    check('DPAPI is available to safeStorage', safeStorage.isEncryptionAvailable());
    const store = createStore({ dir, safeStorage });
    const FAKE = 'selftest-refresh-' + Date.now();
    const google = {
      refresh: async () => ({ access: 'selftest-access', refresh: FAKE, expiresAt: Date.now() + 3600e3, scopes: [C.SCOPE] }),
      calendarList: async () => [{ id: 'self@example.com', summary: 'Self', primary: true, backgroundColor: '#039be5' }],
      events: async () => ({ items: [{ id: 'e1', summary: 'Selftest event', start: { date: '2026-10-16' }, end: { date: '2026-10-17' }, htmlLink: 'https://www.google.com/calendar/event?eid=x' }] }),
      revoke: async () => true,
    };
    const pubs = [];
    const eng = createEngine({ store, google, signIn: async () => ({ access: 'selftest-access', refresh: FAKE, expiresAt: Date.now() + 3600e3, scopes: [C.SCOPE] }),
      choices: () => ({}), saveChoices: () => {}, publish: (s, e) => pubs.push({ s, e }), log: () => {} });
    eng.start();
    const sc = await eng.setClient(JSON.stringify({ installed: { client_id: '1-selftest.apps.googleusercontent.com', client_secret: 'selftest-secret' } }));
    check('client saved', sc.ok, JSON.stringify(sc));
    const si = await eng.signIn();
    check('fake sign-in + sync', si.ok && si.account === 'self@example.com', JSON.stringify(si));
    const tok = fs.readFileSync(path.join(dir, 'token.bin'));
    check('token.bin is DPAPI-encrypted (no token text on disk)', !tok.includes(FAKE) && !tok.includes('selftest-access'));
    check('client.bin is encrypted', !fs.readFileSync(path.join(dir, 'client.bin')).includes('selftest-secret'));
    check('token decrypts back through safeStorage', (store.getToken() || {}).refresh === FAKE);
    check('cache written', (store.getCache() || { events: [] }).events.length === 1);
    check('events published without links', pubs.some((p) => p.e && p.e.events.length === 1 && !('link' in p.e.events[0])));
    const so = await eng.signOut();
    check('sign out deletes the token AND the cache', so.ok && !fs.existsSync(path.join(dir, 'token.bin')) && !fs.existsSync(path.join(dir, 'cache.json')), JSON.stringify(so));
    eng.stop();
  } catch (e) { fails.push('threw: ' + (e && e.stack || e)); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  const line = 'gcal: SELFTEST ' + passed + ' passed, ' + fails.length + ' failed' + (fails.length ? ' -- ' + fails.join('; ') : '');
  ctx.log(line);
  process.stdout.write('mantle: ' + line + '\n');
}

module.exports = { run };
