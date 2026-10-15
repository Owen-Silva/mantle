'use strict';
/* _ramreclaim-core.js — the record / apply / undo engine behind "Windows pieces Mantle replaces"
 * (lib/features/ramreclaim.js, ui/settings/sections/ramreclaim.js; lane mantle-ramreclaim, 2026-10-15).
 *
 * Owen, 2026-10-15: "everything should be taken over. also if there is anything we can disable from
 * windows and take over with mantle lets do that. preferably using less ram".
 *
 * WHAT IT CHANGES: per-user (HKCU) DWORD values only, from the fixed table below (PIECES). Nothing that
 * needs administrator rights, no policy, no package: those are LISTED for Owen and never applied here.
 *
 * THE RULE: every change is written to the journal BEFORE the registry is touched, and the journal is
 * what every exit road undoes from: the switch off, the feature off, Mantle quitting, "Restore Windows
 * taskbar", the next start after a crash, tools/restore-windows.ps1 (crash give-up) and
 * tools/install-autostart.ps1 -Uninstall (both through tools/ramreclaim-undo.ps1, which reads the SAME
 * journal file and knows the same allowlist).
 *   - never double-applied: a piece with a journal entry is never recorded again (the value there
 *     now is Mantle's, not Windows' original);
 *   - a value Windows already had is not recorded and not undone (Mantle changed nothing);
 *   - an undo only writes when the value is still Mantle's; one changed since (by Owen or by Windows)
 *     is left as it is and said;
 *   - journal entries outside the allowlist are never acted on (a tampered file cannot make Mantle write
 *     an arbitrary value).
 * Windows ending the session (sign-out, restart) is NOT a quit: the pieces marked keepAcrossSignOut
 * stay off so Windows skips them at the next sign-in (that is the only moment they save memory) and
 * the journal keeps them, so every other road still puts them back.
 */

const DWORD = 'REG_DWORD';

/* The pieces. kind 'switch' = Mantle may turn it off (HKCU, no admin, undone on every road);
 * 'listed' = needs administrator rights, a policy or removing a package: shown, off, Owen decides;
 * 'kept' = no safe way exists, said why. procs = the root process names whose memory (with their
 * child processes) is the piece's; measured live from the sidecar's process list. */
const PIECES = Object.freeze([
  Object.freeze({
    id: 'widgets-prelaunch', kind: 'switch',
    action: 'Don’t load Windows’ Widgets board at sign-in',
    label: 'Widgets board, loaded at sign-in',
    help: 'Windows starts its Widgets board at sign-in so it opens fast. Mantle has its own desktop widgets.',
    breaks: 'Windows’ Widgets board (Win+W) takes a second longer to open the first time.',
    hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Dsh', name: 'IsPrelaunchEnabled', type: DWORD, target: 0,
    defaultOn: true, keepAcrossSignOut: true, effect: 'next sign-in', procs: ['Widgets.exe'],
  }),
  Object.freeze({
    id: 'search-highlights', kind: 'switch',
    action: 'Turn off Windows’ search highlights',
    label: 'Search highlights',
    help: 'Windows’ search fetches the day’s pictures and trending searches in the background. Mantle’s search (Win+S) never shows them.',
    breaks: 'Windows’ own search window shows no pictures or trending searches.',
    hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', name: 'IsDynamicSearchBoxEnabled', type: DWORD, target: 0,
    defaultOn: true, keepAcrossSignOut: true, effect: 'next sign-in', procs: ['SearchHost.exe'],
    ramNote: 'Stops Windows’ search waking up to fetch them; its window stays loaded',
  }),
  Object.freeze({
    id: 'lockscreen-widgets', kind: 'switch',
    action: 'Turn off widgets on the lock screen',
    label: 'Widgets on the lock screen',
    help: 'The weather and other widgets on the lock screen keep Windows’ widget service running.',
    breaks: 'The lock screen shows no weather or widgets. Mantle does not replace the lock screen, so this is your call.',
    hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Lock Screen', name: 'LockScreenWidgetsEnabled', type: DWORD, target: 0,
    defaultOn: false, keepAcrossSignOut: true, effect: 'next lock', procs: ['WidgetService.exe'],
  }),
  Object.freeze({
    id: 'search-window', kind: 'listed', admin: true,
    action: 'Turn off Windows’ search window',
    label: 'Windows’ search window',
    help: 'Windows keeps its search window and its web view loaded all the time, even though Win+S opens Mantle’s search. The search index stays on either way: Mantle’s search uses it.',
    how: 'The "Fully disable Search UI" policy (DisableSearch = 1 in HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search).',
    why: 'Needs administrator rights, and Mantle could not undo it after a crash without asking you again. Microsoft lists the policy for Pro and up; not tried on Home.',
    breaks: 'With Mantle closed, Win+S and the Start menu have no search until it is undone.',
    procs: ['SearchHost.exe'],
  }),
  Object.freeze({
    id: 'widgets-all', kind: 'listed', admin: true,
    action: 'Turn off Windows’ Widgets completely',
    label: 'Windows’ Widgets, completely',
    help: 'Turns Windows’ Widgets off for every account on this PC.',
    how: 'The "Allow widgets" policy (AllowNewsAndInterests = 0 in HKLM\\SOFTWARE\\Policies\\Microsoft\\Dsh).',
    why: 'Needs administrator rights and is a policy, so it stays your call.',
    breaks: 'No Widgets board and no lock screen widgets until it is undone.',
    procs: ['Widgets.exe', 'WidgetService.exe'],
  }),
  Object.freeze({
    id: 'widgets-package', kind: 'listed', admin: false, removal: true,
    action: 'Remove Windows’ Widgets app',
    label: 'Remove Windows’ Widgets app',
    help: 'Uninstalls the Windows Web Experience Pack, the app behind Widgets.',
    how: 'Remove-AppxPackage on MicrosoftWindows.Client.WebExperience (your account only).',
    why: 'Removes an app: getting it back means reinstalling it from the Microsoft Store, so Mantle never does it on its own.',
    breaks: 'No Widgets at all until it is reinstalled from the Store.',
    procs: ['Widgets.exe', 'WidgetService.exe'],
  }),
  Object.freeze({
    id: 'start-menu', kind: 'kept',
    label: 'Windows’ Start menu',
    help: 'Stays loaded. There is no safe switch: Explorer starts it again at once, and it is your Start menu whenever Mantle is closed.',
    procs: ['StartMenuExperienceHost.exe'],
  }),
]);

const switches = () => PIECES.filter((p) => p.kind === 'switch');
const pieceById = (id) => PIECES.find((p) => p.id === id) || null;
/* The allowlist: the only (hive, key, name) a journal entry may name. tools/ramreclaim-undo.ps1 has the same
 * list. A piece taken out of PIECES moves to RETIRED ({hive, key, name}) so an old journal entry for it is
 * still put back (and goes on the .ps1 list too). */
const RETIRED = Object.freeze([]);
const ALLOWED = new Set(switches().concat(RETIRED).map((p) => `${p.hive}\\${p.key}|${p.name}`.toLowerCase()));
const allowed = (e) => !!e && e.hive === 'HKCU' && e.type === DWORD && ALLOWED.has(`${e.hive}\\${e.key}|${e.name}`.toLowerCase());

const errText = (e) => (e && e.message ? e.message : String(e));
const same = (a, b) => a != null && b != null && Number(a) === Number(b);

/* The journal on disk: { v: 1, entries: { <pieceId>: { hive, key, name, type, existed, data, target, at, keptForSignOut? } } }.
 * save() is synchronous and atomic (temp file + rename) and THROWS when it cannot write: no record, no change. */
function fileStore(file, fs) {
  const pathMod = require('path');
  return {
    file,
    load() {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { v: 1, entries: {} }; throw e; }
      const j = JSON.parse(raw.replace(/^﻿/, ''));
      return { v: 1, entries: j && j.entries && typeof j.entries === 'object' && !Array.isArray(j.entries) ? j.entries : {} };
    },
    save(j) {
      fs.mkdirSync(pathMod.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: j.entries || {} }, null, 1));
      fs.renameSync(tmp, file);
    },
  };
}

/* The real registry: reg.exe (no PowerShell, no native module). HKCU and REG_DWORD only.
 * read -> { ok, exists, data } | { ok:false, reason }; write / remove -> { ok } | { ok:false, reason }. */
function realRegistry(execFile) {
  const run = (args) => new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 4000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || (err && !stdout ? err.message : '') || '') });
    });
  });
  const only = (hive, type) => (hive !== 'HKCU' ? 'Mantle only changes your own settings (HKCU), never ' + hive : type && type !== DWORD ? 'Mantle only writes number (DWORD) values' : null);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    async read(hive, key, name) {
      const no = only(hive); if (no) return { ok: false, reason: no };
      const r = await run(['query', 'HKCU\\' + key, '/v', name]);
      if (r.code === 0) {
        const m = new RegExp('^\\s+' + esc(name) + '\\s+(REG_[A-Z_]+)\\s+(\\S*)\\s*$', 'mi').exec(r.out);
        if (!m) return { ok: false, reason: 'Windows answered, but not in a form Mantle could read' };
        if (m[1] !== DWORD) return { ok: true, exists: true, data: null, type: m[1] };
        return { ok: true, exists: true, data: parseInt(m[2], 16), type: m[1] };
      }
      if (r.code === 1 && /unable to find|cannot find|not find/i.test(r.err)) return { ok: true, exists: false, data: null };
      return { ok: false, reason: 'Windows would not say what it is set to (' + (r.err.trim().split(/\r?\n/)[0] || 'reg.exe exit ' + r.code) + ')' };
    },
    async write(hive, key, name, type, data) {
      const no = only(hive, type); if (no) return { ok: false, reason: no };
      const r = await run(['add', 'HKCU\\' + key, '/v', name, '/t', DWORD, '/d', String(Number(data) >>> 0), '/f']);
      return r.code === 0 ? { ok: true } : { ok: false, reason: 'Windows refused the change (' + (r.err.trim().split(/\r?\n/)[0] || 'reg.exe exit ' + r.code) + ')' };
    },
    async remove(hive, key, name) {
      const no = only(hive); if (no) return { ok: false, reason: no };
      const r = await run(['delete', 'HKCU\\' + key, '/v', name, '/f']);
      if (r.code === 0 || (r.code === 1 && /unable to find|cannot find|not find/i.test(r.err))) return { ok: true };
      return { ok: false, reason: 'Windows refused the change (' + (r.err.trim().split(/\r?\n/)[0] || 'reg.exe exit ' + r.code) + ')' };
    },
  };
}

/* A test run (--test): reads are real (harmless), writes land in memory only. */
function dryRunRegistry(inner) {
  const over = new Map();
  const k = (hive, key, name) => `${hive}\\${key}|${name}`.toLowerCase();
  return {
    dryRun: true,
    writes: [],
    async read(hive, key, name) { const o = over.get(k(hive, key, name)); return o ? { ok: true, exists: o.exists, data: o.data } : inner.read(hive, key, name); },
    async write(hive, key, name, type, data) { this.writes.push({ op: 'write', key, name, data }); over.set(k(hive, key, name), { exists: true, data: Number(data) }); return { ok: true }; },
    async remove(hive, key, name) { this.writes.push({ op: 'remove', key, name }); over.set(k(hive, key, name), { exists: false, data: null }); return { ok: true }; },
  };
}

/* The memory a piece holds now, from the sidecar's process list (taskmgr.snapshot: {procs:[{pid, ppid,
 * file, pws, created}]}): its root processes by file name plus every child process under them (Search's
 * web view), private memory (Task Manager's Memory column). -> { running, mb, count } */
function measure(procs, piece) {
  if (!Array.isArray(procs) || !piece || !Array.isArray(piece.procs) || !piece.procs.length) return null;
  const names = new Set(piece.procs.map((n) => n.toLowerCase()));
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const seen = new Set();
  let bytes = 0;
  const walk = (p) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    bytes += Number(p.pws) || 0;
    for (const c of kids.get(p.pid) || []) {
      // a reused parent pid is not a parent: a child cannot be older than its parent
      if (c.created != null && p.created != null && Number(c.created) < Number(p.created)) continue;
      walk(c);
    }
  };
  for (const p of procs) if (names.has(String(p.file || '').toLowerCase())) walk(p);
  return { running: seen.size > 0, count: seen.size, mb: Math.round(bytes / 1048576) };
}

function createReclaim(o) {
  const reg = o.reg, store = o.store;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const notes = new Map();   // pieceId -> { state, reason, at } from the last action on it
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const note = (id, state, reason) => { const n = { state, reason: reason || null, at: now() }; notes.set(id, n); return n; };

  /* Turn one piece off (= set Windows' value to the piece's target), recording first. */
  async function ensure(p) {
    let j;
    try { j = store.load(); } catch (e) { return note(p.id, 'error', 'Mantle could not read its undo record, so it changed nothing (' + errText(e) + ')'); }
    const entry = j.entries[p.id];
    const cur = await reg.read(p.hive, p.key, p.name);
    if (!cur.ok) return note(p.id, 'error', cur.reason);
    if (entry) {
      // already Mantle's: never recorded twice; Windows putting it back is undone here (start / switch), said
      if (cur.exists && same(cur.data, p.target)) { if (entry.keptForSignOut) { delete entry.keptForSignOut; try { store.save(j); } catch (_) { /* the flag is only a note */ } } return note(p.id, 'applied', null); }
      const w = await reg.write(p.hive, p.key, p.name, p.type, p.target);
      if (!w.ok) return note(p.id, 'error', w.reason);
      log(`${p.id}: Windows had put it back; turned off again`);
      return note(p.id, 'applied', 'Windows had turned this back on; Mantle turned it off again');
    }
    if (cur.exists && same(cur.data, p.target)) return note(p.id, 'already', null);   // nothing to change, nothing recorded
    j.entries[p.id] = { hive: p.hive, key: p.key, name: p.name, type: p.type, existed: !!cur.exists, data: cur.exists ? cur.data : null, target: p.target, at: new Date(now()).toISOString() };
    try { store.save(j); } catch (e) { return note(p.id, 'error', 'Mantle could not write its undo record, so it changed nothing (' + errText(e) + ')'); }
    const w = await reg.write(p.hive, p.key, p.name, p.type, p.target);
    const back = await reg.read(p.hive, p.key, p.name);
    if (w.ok && back.ok && back.exists && same(back.data, p.target)) { log(`${p.id}: turned off (was ${cur.exists ? cur.data : 'not set'})`); return note(p.id, 'applied', null); }
    // it did not take: if Windows still has the original, the record goes too; otherwise it stays for the undo
    const unchanged = back.ok && (cur.exists ? back.exists && same(back.data, cur.data) : !back.exists);
    if (unchanged) { delete j.entries[p.id]; try { store.save(j); } catch (_) { /* a stale entry only makes a later undo a no-op */ } }
    return note(p.id, 'error', w.ok ? 'Windows did not keep the change' : w.reason);
  }

  /* Put one journal entry back. -> note */
  async function undoEntry(id, j) {
    const e = j.entries[id];
    if (!allowed(e)) { log(`${id}: an undo record Mantle does not recognise was left alone`); return note(id, 'error', 'an undo record Mantle does not recognise was left alone'); }
    const cur = await reg.read(e.hive, e.key, e.name);
    if (!cur.ok) return note(id, 'error', 'could not be put back: ' + cur.reason);
    let outcome;
    if (cur.exists && same(cur.data, e.target)) {
      const w = e.existed ? await reg.write(e.hive, e.key, e.name, e.type, e.data) : await reg.remove(e.hive, e.key, e.name);
      if (!w.ok) return note(id, 'error', 'could not be put back: ' + w.reason);
      const back = await reg.read(e.hive, e.key, e.name);
      const okBack = back.ok && (e.existed ? back.exists && same(back.data, e.data) : !back.exists);
      if (!okBack) return note(id, 'error', 'could not be put back: Windows did not keep the change');
      outcome = note(id, 'off', null);
      log(`${id}: put back`);
    } else if (e.existed ? cur.exists && same(cur.data, e.data) : !cur.exists) {
      outcome = note(id, 'off', null);
    } else {
      outcome = note(id, 'off', 'Changed outside Mantle since, so Mantle left it as it is');
      log(`${id}: changed outside Mantle; left as it is`);
    }
    delete j.entries[id];
    store.save(j);
    return outcome;
  }

  async function undo(id) {
    let j;
    try { j = store.load(); } catch (e) { return note(id, 'error', 'Mantle could not read its undo record (' + errText(e) + ')'); }
    if (!j.entries[id]) { const n = notes.get(id); return n && n.state === 'already' ? n : note(id, 'off', null); }
    try { return await undoEntry(id, j); } catch (e) { return note(id, 'error', 'could not be put back (' + errText(e) + ')'); }
  }

  return {
    /* Make Windows match `wanted` (a Set of switch ids; empty = put everything back). */
    sync(wanted) {
      return serial(async () => {
        const out = {};
        for (const p of switches()) out[p.id] = wanted.has(p.id) ? await ensure(p) : await undo(p.id);
        // entries for pieces no longer in the table: put back too (allowlist permitting)
        let j = null;
        try { j = store.load(); } catch (_) { j = null; }
        if (j) {
          for (const id of Object.keys(j.entries)) {
            if (pieceById(id)) continue;
            if (allowed(j.entries[id])) out[id] = await undoEntry(id, j).catch((e) => note(id, 'error', errText(e)));
            else log(`${id}: an undo record Mantle does not recognise was left alone`);
          }
        }
        return out;
      });
    },
    set(id, on) {
      const p = pieceById(id);
      if (!p || p.kind !== 'switch') return Promise.resolve(note(id, 'error', 'Mantle cannot switch that piece'));
      return serial(() => (on ? ensure(p) : undo(id)));
    },
    /* Every road out. keepSignOut (Windows is ending the session): keepAcrossSignOut pieces stay off, marked. */
    undoAll(opts) {
      const keep = !!(opts && opts.keepSignOut);
      return serial(async () => {
        let j;
        try { j = store.load(); } catch (e) { log('the undo record could not be read: ' + errText(e)); return { ok: false, reason: errText(e) }; }
        const out = {};
        for (const id of Object.keys(j.entries)) {
          const p = pieceById(id);
          if (!allowed(j.entries[id])) { log(`${id}: an undo record Mantle does not recognise was left alone`); continue; }
          if (keep && p && p.keepAcrossSignOut) {
            j.entries[id].keptForSignOut = new Date(now()).toISOString();
            try { store.save(j); } catch (_) { /* only a note */ }
            out[id] = note(id, 'applied', 'Kept off through the sign-out so Windows skips it at sign-in');
            continue;
          }
          out[id] = await undoEntry(id, j).catch((e) => note(id, 'error', errText(e)));
        }
        const failed = Object.values(out).filter((n) => n.state === 'error');
        return { ok: failed.length === 0, out, reason: failed.length ? failed[0].reason : null };
      });
    },
    /* What the page shows, read fresh (no writes). */
    status(wanted, enabled) {
      return serial(async () => {
        let j = { entries: {} }, jErr = null;
        try { j = store.load(); } catch (e) { jErr = errText(e); }
        const rows = [];
        for (const p of PIECES) {
          const row = { id: p.id, kind: p.kind };
          if (p.kind === 'switch') {
            const cur = await reg.read(p.hive, p.key, p.name);
            const entry = j.entries[p.id];
            const n = notes.get(p.id);
            row.wanted = wanted.has(p.id);
            row.mantleChanged = !!entry;
            row.since = entry ? entry.at : null;
            row.keptForSignOut = !!(entry && entry.keptForSignOut);
            if (!cur.ok) { row.state = 'error'; row.reason = cur.reason; }
            else {
              row.windowsOff = cur.exists && same(cur.data, p.target);
              if (n && n.state === 'error' && row.wanted && !row.windowsOff) { row.state = 'error'; row.reason = n.reason; }
              else if (entry && !row.windowsOff) { row.state = 'drift'; row.reason = 'Windows turned this back on. Mantle turns it off again at its next start, or switch it off and on here'; }
              else if (row.windowsOff) { row.state = entry ? 'applied' : 'already'; row.reason = n && n.state === 'applied' ? n.reason : null; }
              else if (row.wanted && !enabled) { row.state = 'paused'; row.reason = null; }
              else { row.state = 'off'; row.reason = n && n.state === 'off' ? n.reason : null; }
            }
          }
          rows.push(row);
        }
        return { rows, journalError: jErr };
      });
    },
    note: (id) => notes.get(id) || null,
  };
}

module.exports = { PIECES, switches, pieceById, allowed, createReclaim, fileStore, realRegistry, dryRunRegistry, measure, DWORD };
