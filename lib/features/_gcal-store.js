'use strict';
/*
 * _gcal-store.js - what Google Calendar keeps on this PC, all of it under <userData>\gcal\ (lane mantle-gcal).
 *
 *   token.bin   the sign-in (refresh + access token), ENCRYPTED with Electron safeStorage (Windows DPAPI,
 *               tied to the user's Windows account). Never written in plain text: no encryption = no sign-in.
 *   client.bin  the client_id / client_secret copied out of the Google client file he chose, also encrypted.
 *   cache.json  the recent events and the calendar list, so the flyout opens from disk with no network.
 *
 * Sign out deletes token.bin AND cache.json (privacy.html claim 6). client.bin is the user's own app
 * registration, not his data, and is kept so signing in again does not need the file again; "Choose
 * Google client file…" replaces it.
 * Writes go to a temp file then rename, so a crash mid-write never leaves half a file.
 */
const fs = require('fs');
const path = require('path');

function createStore({ dir, safeStorage }) {
  const file = (n) => path.join(dir, n);

  function writeAtomic(name, data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file(name + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file(name));
  }

  function canEncrypt() {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
  }

  function putSecret(name, obj) {
    if (!canEncrypt()) throw Object.assign(new Error('no encryption'), { reason: 'Windows encryption (DPAPI) is not available, so Mantle will not store a Google sign-in' });
    writeAtomic(name, safeStorage.encryptString(JSON.stringify(obj)));
  }

  /* -> the object, null when there is none, or { broken: reason } when it cannot be read back. */
  function getSecret(name) {
    let buf;
    try { buf = fs.readFileSync(file(name)); } catch (e) { return e.code === 'ENOENT' ? null : { broken: 'it could not be read (' + e.code + ')' }; }
    if (!canEncrypt()) return { broken: 'Windows encryption (DPAPI) is not available' };
    try { return JSON.parse(safeStorage.decryptString(buf)); } catch (e) { return { broken: 'it could not be decrypted (made under another Windows account?)' }; }
  }

  /* Deleting a file also deletes any "<name>.<pid>.tmp" a crash mid-write left behind, so Sign out
     leaves no copy of the events or the token anywhere in the folder. */
  function remove(name) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const n of names) {
      if (n.startsWith(name + '.') && n.endsWith('.tmp')) { try { fs.unlinkSync(file(n)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
    try { fs.unlinkSync(file(name)); return true; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  }

  return {
    dir,
    canEncrypt,
    getToken: () => getSecret('token.bin'),
    putToken: (t) => putSecret('token.bin', t),
    deleteToken: () => remove('token.bin'),
    getClient: () => getSecret('client.bin'),
    putClient: (c) => putSecret('client.bin', c),
    getCache() {
      try {
        const j = JSON.parse(fs.readFileSync(file('cache.json'), 'utf8'));
        return j && j.v === 1 && Array.isArray(j.events) ? j : null;
      } catch (e) { return null; }
    },
    putCache: (c) => writeAtomic('cache.json', JSON.stringify(Object.assign({ v: 1 }, c))),
    deleteCache: () => remove('cache.json'),
    has: (name) => fs.existsSync(file(name)),
  };
}

module.exports = { createStore };
