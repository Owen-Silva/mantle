'use strict';
/*
 * _player-assoc.js - "Use Mantle Player for video and music" (lane mantle-player, 2026-10-17).
 *
 * WHAT IT DOES, and what it never does. Windows 11 protects each file type's chosen app with a hash
 * (UserChoice); only Owen's own click in Windows' Default apps page may set it, so this NEVER writes
 * UserChoice. It registers Mantle Player as an AVAILABLE app the documented way (Default Programs:
 * "Registering an application for use in Default Programs"), all under HKCU:
 *   HKCU\Software\Classes\MantlePlayer.Video|Audio            the ProgIDs: name, icon, open command
 *   HKCU\Software\Classes\.<ext>\OpenWithProgids  <ProgID>     REG_NONE, so "Open with" lists it
 *   HKCU\Software\Mantle\Player\Capabilities(\FileAssociations) ApplicationName/Description/Icon, .ext -> ProgID
 *   HKCU\Software\RegisteredApplications  "Mantle Player"      -> Software\Mantle\Player\Capabilities
 * then opens Windows' Default apps page at Mantle Player (ms-settings:defaultapps?registeredAppUser=...)
 * for Owen to pick it. Only types Mantle Player really plays are offered (no AVI/WMV: that would be a lie).
 *
 * UNDO REMOVES EXACTLY WHAT IT ADDED: use() records every key it created and every value it set (a key
 * that already existed is never deleted, only our value inside it), and undo() walks that record backwards.
 *
 * DRY RUN: in --test (main passes dryRun) or with MANTLE_PLAYER_DRYRUN=1 nothing runs at all, not even a
 * read: the answer lists what WOULD be written. The one place reg.exe can be started is `run` below, and
 * every path reaches it through the `dry` check first.
 */
const PROGID = { video: 'MantlePlayer.Video', audio: 'MantlePlayer.Audio' };
const APP_NAME = 'Mantle Player';
const CAPS = 'Software\\Mantle\\Player\\Capabilities';
const VIDEO = ['.mp4', '.m4v', '.mov', '.mkv', '.webm'];
const AUDIO = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.weba'];
const SETTINGS_URI = 'ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent(APP_NAME);
const HK = 'HKCU\\';

function command(exe, appDir) { return '"' + exe + '" "' + appDir + '" --open=player "--play=%1"'; }

/** The writes, in order: [{ key, name|null (default value), type, data }]. Pure. */
function plan(o) {
  const ico = '"' + o.icon + '",0';
  const w = [];
  for (const kind of ['video', 'audio']) {
    const id = PROGID[kind], base = 'Software\\Classes\\' + id;
    w.push({ key: base, name: null, type: 'REG_SZ', data: (kind === 'video' ? 'Video' : 'Music') + ' (Mantle Player)' });
    w.push({ key: base, name: 'FriendlyTypeName', type: 'REG_SZ', data: kind === 'video' ? 'Video' : 'Music' });
    w.push({ key: base + '\\DefaultIcon', name: null, type: 'REG_SZ', data: ico });
    w.push({ key: base + '\\Application', name: 'ApplicationName', type: 'REG_SZ', data: APP_NAME });
    w.push({ key: base + '\\Application', name: 'ApplicationIcon', type: 'REG_SZ', data: ico });
    w.push({ key: base + '\\shell\\open', name: 'FriendlyAppName', type: 'REG_SZ', data: APP_NAME });
    w.push({ key: base + '\\shell\\open\\command', name: null, type: 'REG_SZ', data: command(o.exe, o.appDir) });
  }
  w.push({ key: CAPS, name: 'ApplicationName', type: 'REG_SZ', data: APP_NAME });
  w.push({ key: CAPS, name: 'ApplicationDescription', type: 'REG_SZ', data: 'Plays your video and music, part of Mantle' });
  w.push({ key: CAPS, name: 'ApplicationIcon', type: 'REG_SZ', data: ico });
  for (const e of VIDEO) w.push({ key: CAPS + '\\FileAssociations', name: e, type: 'REG_SZ', data: PROGID.video });
  for (const e of AUDIO) w.push({ key: CAPS + '\\FileAssociations', name: e, type: 'REG_SZ', data: PROGID.audio });
  for (const e of VIDEO) w.push({ key: 'Software\\Classes\\' + e + '\\OpenWithProgids', name: PROGID.video, type: 'REG_NONE', data: '' });
  for (const e of AUDIO) w.push({ key: 'Software\\Classes\\' + e + '\\OpenWithProgids', name: PROGID.audio, type: 'REG_NONE', data: '' });
  w.push({ key: 'Software\\RegisteredApplications', name: APP_NAME, type: 'REG_SZ', data: CAPS });
  return w;
}
const line = (x) => 'HKCU\\' + x.key + ' ' + (x.name === null ? '(Default)' : JSON.stringify(x.name)) + ' = ' + (x.type === 'REG_NONE' ? '(none)' : JSON.stringify(x.data));

/* every key on the way down to `key` (Software\Classes\.mp4\OpenWithProgids -> ...\.mp4, ...\.mp4\OpenWithProgids),
   below the roots that always exist */
const ROOTS = ['Software', 'Software\\Classes'];
function chain(key) { const parts = key.split('\\'); const out = []; for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join('\\'); if (!ROOTS.includes(k)) out.push(k); } return out; }

/**
 * o: { exe, appDir, icon, dryRun, reg(args) -> Promise<{ code, out }>, record: { get(), set(v) } }
 * -> { ok, dryRun?, reason, lines?, uri }
 */
async function use(o) {
  const writes = plan(o);
  const dry = !!o.dryRun || process.env.MANTLE_PLAYER_DRYRUN === '1';
  if (dry) return { ok: true, dryRun: true, uri: SETTINGS_URI, lines: writes.map(line), reason: 'Test run: nothing was written. It would add ' + writes.length + ' registry entries under HKCU (Mantle Player as an app for ' + (VIDEO.length + AUDIO.length) + ' file types), then open Windows\' Default apps for you to pick it' };
  const prev = o.record.get();
  if (prev && prev.done) return { ok: true, already: true, uri: SETTINGS_URI, reason: null };
  const rec = { at: Date.now(), keys: [], values: [], done: false };
  const exists = async (k) => (await o.reg(['query', HK + k])).code === 0;
  const hasValue = async (k, n) => (await o.reg(['query', HK + k, n === null ? '/ve' : '/v', ...(n === null ? [] : [n])])).code === 0;
  try {
    for (const x of writes) {
      for (const k of chain(x.key)) if (!rec.keys.includes(k) && !(await exists(k))) rec.keys.push(k);    // created by us
      if (await hasValue(x.key, x.name)) {
        // a value of ours already there (an earlier run that was not recorded): overwrite, but never remove it on undo
        // unless it is inside a key we created
      } else rec.values.push({ key: x.key, name: x.name });
      const args = ['add', HK + x.key, ...(x.name === null ? ['/ve'] : ['/v', x.name]), '/t', x.type, ...(x.type === 'REG_NONE' ? [] : ['/d', x.data]), '/f'];
      const r = await o.reg(args);
      if (r.code !== 0) throw new Error('Windows refused a registry entry (' + (String(r.out || '').trim().split(/\r?\n/).pop() || 'reg.exe ' + r.code) + ')');
      o.record.set(rec);                                                        // after every write: a crash midway can still be undone
    }
  } catch (e) {
    o.record.set(rec);
    const back = await undo(o);
    return { ok: false, reason: 'Mantle Player could not be added to Windows\' list: ' + e.message + (back.ok ? '; what was added was taken out again' : '; and taking it out again failed: ' + back.reason) };
  }
  rec.done = true; o.record.set(rec);
  return { ok: true, uri: SETTINGS_URI, reason: null, added: rec.values.length };
}

async function undo(o) {
  const rec = o.record.get();
  if (!rec || (!rec.keys.length && !rec.values.length)) return { ok: true, nothing: true, reason: 'Mantle Player was not added to Windows\' list, so there is nothing to take out' };
  const dry = !!o.dryRun || process.env.MANTLE_PLAYER_DRYRUN === '1';
  if (dry) return { ok: true, dryRun: true, reason: 'Test run: nothing was removed. It would remove ' + rec.values.length + ' values and ' + rec.keys.length + ' keys' };
  const fails = [];
  const inMine = (k) => rec.keys.some((m) => k === m || k.startsWith(m + '\\'));
  for (const v of rec.values.slice().reverse()) {
    if (inMine(v.key)) continue;                                                // goes with its key below
    const r = await o.reg(['delete', HK + v.key, ...(v.name === null ? ['/ve'] : ['/v', v.name]), '/f']);
    if (r.code !== 0 && (await o.reg(['query', HK + v.key, ...(v.name === null ? ['/ve'] : ['/v', v.name])])).code === 0) fails.push(v.name || '(Default)');
  }
  // deepest first, so a parent we created goes after its children
  for (const k of rec.keys.slice().sort((a, b) => b.split('\\').length - a.split('\\').length)) {
    if (rec.keys.some((m) => k.startsWith(m + '\\') && m !== k)) continue;      // its parent is ours: removed with it
    const r = await o.reg(['delete', HK + k, '/f']);
    if (r.code !== 0 && (await o.reg(['query', HK + k])).code === 0) fails.push(k.split('\\').pop());
  }
  if (fails.length) { return { ok: false, reason: fails.length + ' registry entr' + (fails.length === 1 ? 'y' : 'ies') + ' could not be removed; try Undo again' }; }
  o.record.set(null);
  return { ok: true, reason: null };
}

async function status(o) {
  const rec = o.record.get();
  if (o.dryRun || process.env.MANTLE_PLAYER_DRYRUN === '1') return { ok: true, registered: !!(rec && rec.done), dryRun: true, uri: SETTINGS_URI };
  const r = await o.reg(['query', HK + 'Software\\RegisteredApplications', '/v', APP_NAME]);
  const there = r.code === 0;
  return { ok: true, registered: there, recorded: !!(rec && rec.done), uri: SETTINGS_URI, reason: there && !(rec && rec.done) ? 'Mantle Player is in Windows\' list from an earlier setup this copy did not record' : null };
}

/** The real runner: reg.exe, never a shell, no window. */
function regRunner(execFile) {
  return (args) => new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stderr || stdout || '') }));
  });
}

module.exports = { plan, use, undo, status, regRunner, line, chain, PROGID, APP_NAME, VIDEO, AUDIO, SETTINGS_URI, CAPS, command };
