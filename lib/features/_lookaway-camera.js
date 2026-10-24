'use strict';
/*
 * _lookaway-camera.js - is ANOTHER app using the camera right now? (lane lookaway, 2026-10-23)
 *
 * Windows keeps a record per app of when it last started and stopped using the camera, the same
 * record Settings > Privacy & security > Camera shows as "Currently in use":
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam
 *     <packaged app>\                  LastUsedTimeStart, LastUsedTimeStop (FILETIME, QWORD)
 *     NonPackaged\<exe path, \ as #>\  the same two values
 * While an app holds the camera, its LastUsedTimeStop is 0. Mantle's own entry (this Electron's
 * exe) is left out, so the look-away camera never pauses itself.
 *
 * Read in-process through koffi (advapi32), read-only, about 1 ms; no camera is touched.
 * PRIVACY: the app names in the key names are compared and COUNTED here and never leave this
 * file: the answer is { others: <number>, self: <bool> }. Nothing is logged.
 */

const ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';
const HKCU = -2147483647;           // (HKEY)(LONG)0x80000001, sign-extended on 64-bit
const KEY_READ = 0x20019;
const ERROR_NO_MORE_ITEMS = 259;

let api = null, bindError = '';
function bind() {
  if (api || bindError) return api;
  try {
    const koffi = require('koffi');
    const adv = koffi.load('advapi32.dll');
    api = {
      open: adv.func('long __stdcall RegOpenKeyExW(intptr_t hKey, str16 sub, uint32 opts, uint32 sam, _Out_ intptr_t *out)'),
      enumKey: adv.func('long __stdcall RegEnumKeyExW(intptr_t hKey, uint32 index, void *name, _Inout_ uint32 *cch, void *reserved, void *cls, void *ccls, void *ft)'),
      query: adv.func('long __stdcall RegQueryValueExW(intptr_t hKey, str16 name, void *reserved, _Out_ uint32 *type, void *data, _Inout_ uint32 *cb)'),
      close: adv.func('long __stdcall RegCloseKey(intptr_t hKey)'),
    };
  } catch (e) { bindError = 'koffi could not read the registry (' + String(e && e.message).split('\n')[0] + ')'; }
  return api;
}

function openKey(parent, sub) {
  const out = [0];
  const rc = api.open(parent, sub, 0, KEY_READ, out);
  return rc === 0 ? out[0] : null;
}
function subkeys(h) {
  const names = [];
  const buf = Buffer.alloc(1024);
  for (let i = 0; i < 4096; i++) {
    const cch = [512];
    const rc = api.enumKey(h, i, buf, cch, null, null, null, null);
    if (rc === ERROR_NO_MORE_ITEMS) break;
    if (rc !== 0) continue;
    names.push(buf.toString('utf16le', 0, cch[0] * 2));
  }
  return names;
}
function qword(h, name) {
  const type = [0], cb = [8];
  const data = Buffer.alloc(8);
  const rc = api.query(h, name, null, type, data, cb);
  if (rc !== 0 || type[0] !== 11 /* REG_QWORD */) return null;
  return Number(data.readBigUInt64LE(0));
}
function times(parent, sub) {
  const h = openKey(parent, sub);
  if (h === null) return null;
  try { return { start: qword(h, 'LastUsedTimeStart'), stop: qword(h, 'LastUsedTimeStop') }; } finally { api.close(h); }
}

/** Every camera record: [{ name, packaged, start, stop }]. Throws in plain words if unreadable. */
function readRecords() {
  if (!bind()) throw new Error(bindError);
  const root = openKey(HKCU, ROOT);
  if (root === null) return [];   // no app has ever asked for the camera
  const out = [];
  try {
    for (const name of subkeys(root)) {
      if (name === 'NonPackaged') {
        const np = openKey(root, 'NonPackaged');
        if (np === null) continue;
        try { for (const n of subkeys(np)) { const t = times(np, n); if (t) out.push({ name: n, packaged: false, start: t.start, stop: t.stop }); } } finally { api.close(np); }
      } else {
        const t = times(root, name);
        if (t) out.push({ name, packaged: true, start: t.start, stop: t.stop });
      }
    }
  } finally { api.close(root); }
  return out;
}

/** The registry's key name for an exe path: C:\a\b.exe -> C:#a#b.exe */
function keyNameFor(exePath) { return String(exePath || '').replace(/\\/g, '#').toLowerCase(); }

/** PURE: records + our exe -> { others, self }. In use = started and not stopped (stop 0). */
function inUse(records, selfExe) {
  const me = keyNameFor(selfExe);
  let others = 0, self = false;
  for (const r of records || []) {
    if (!(r.start > 0) || r.stop !== 0) continue;
    if (!r.packaged && me && String(r.name).toLowerCase() === me) self = true;
    else others++;
  }
  return { others, self };
}

/** { ok, others, self } or { ok:false, reason } (never throws). `read` is for tests. */
function check(selfExe, read) {
  try { return Object.assign({ ok: true }, inUse((read || readRecords)(), selfExe)); } catch (e) { return { ok: false, others: 0, self: false, reason: String((e && e.message) || e) }; }
}

module.exports = { check, inUse, keyNameFor, readRecords, ROOT };
