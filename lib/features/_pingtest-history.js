'use strict';
/*
 * _pingtest-history.js -- the PING dropdown's list of past ping tests (lane pingtest-hist, 2026-10-09).
 *
 * Owen: "i want history of the tests and make it so i can save tests and name them and each test
 * should also say what wifi i was on". Every finished ping test (a run the sidecar measured and main
 * forwarded, phase 'done') becomes one small entry: when, which network (the sidecar's own wifi
 * object, as given), the best server, the router, the speeds, and each row's numbers. Nothing else
 * from the run is kept.
 *
 * SAVED vs NOT. A new test is unsaved. The newest MAX_UNSAVED unsaved tests are kept; older ones drop
 *   off on the next add. Saving a test gives it a name and keeps it for good (never pruned). Only a
 *   saved test can be renamed. Any test can be removed (the page asks first, not this file).
 *
 * THE FILE. { "version": 1, "tests": [...] }, written after every change the safe way: a .tmp file
 *   next to it, then a rename over the real one, so a crash mid-write never leaves half a file.
 *   No file yet = an empty history, not a problem.
 *
 * NO SILENT FAILURES. A file that cannot be read or makes no sense is moved aside to <name>.bad.json
 *   (never lost, never written over) and the history starts fresh, with the reason in view().problem
 *   for the rest of the session. If it cannot even be moved aside, new tests are kept in memory only
 *   and the file is left alone; the problem says so. A write that fails keeps the tests in memory and
 *   says "history could not be saved: <why>" until a later write works.
 *
 * PRIVACY. Log lines carry counts and reasons only: never a Wi-Fi name, never a test's name.
 */

const fsReal = require('fs');
const path = require('path');

const MAX_UNSAVED = 50;
const NAME_MAX = 60;

const ROW_FIELDS = ['kind', 'name', 'host', 'via', 'method', 'sent', 'got', 'avg', 'min', 'max', 'jitter', 'loss', 'why', 'gaveUp', 'best', 'iface', 'wifi'];

const val = (v) => (v === undefined ? null : v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* A JSON-safe copy of a small sidecar value, or null when it is missing or cannot be copied. */
function jsonCopy(v) {
  if (v === undefined || v === null) return null;
  try { const s = JSON.stringify(v); return s === undefined ? null : JSON.parse(s); } catch (_) { return null; }
}

/* An error in plain words: "EACCES: permission denied, open 'C:\x'" -> "permission denied". */
function plain(e) {
  let m = String((e && e.message) || e || 'unknown reason');
  if (/^E[A-Z]+:\s*/.test(m)) {
    m = m.replace(/^E[A-Z]+:\s*/, '');
    m = m.replace(/,\s*[a-z_]+(\s+'[^']*')?(\s*->\s*'[^']*')?\s*$/i, '');
  }
  m = m.trim();
  return m || 'unknown reason';
}

/* A parse error in plain words. The parser's own message can quote the file's text (which may hold a
 * Wi-Fi or test name), so only where it broke is kept. */
function parseReason(e) {
  const m = String((e && e.message) || '');
  const pos = /at position (\d+)/.exec(m);
  return 'the file is damaged' + (pos ? ` near character ${pos[1]}` : '');
}

function checkName(v) {
  if (typeof v !== 'string') return { ok: false, reason: 'a name needs 1 to 60 characters' };
  const name = v.trim();
  if (name.length < 1 || name.length > NAME_MAX) return { ok: false, reason: 'a name needs 1 to 60 characters' };
  if (/[\x00-\x1f\x7f]/.test(name)) return { ok: false, reason: 'a name cannot hold control characters' };
  return { ok: true, name };
}

function speedOf(s) {
  const o = isObj(s) ? s : {};
  return { mbps: val(o.mbps), bytes: val(o.bytes), why: val(o.why), state: val(o.state), server: val(o.server), note: val(o.note) };   // server/note: who measured, why a fallback (ptfix)
}

function entryOf(run) {
  if (!run || run.phase !== 'done' || !run.startedAt) return null;
  const rows = (Array.isArray(run.rows) ? run.rows : []).filter(isObj).map((r) => {
    const o = {};
    for (const k of ROW_FIELDS) o[k] = jsonCopy(r[k]);
    return o;
  });
  const b = rows.find((r) => r.best === true);
  const rt = rows.find((r) => r.kind === 'router');
  return {
    id: `${run.startedAt}-${run.run}`,
    at: run.startedAt,
    endedAt: val(run.endedAt),
    name: null,
    saved: false,
    wifi: jsonCopy(run.wifi || null),
    wifiChanged: run.wifiChanged || null,
    linkEnd: jsonCopy(run.linkEnd || null),   // ptfix2: the link at the end (wifi.link is the start: signal, band, rates, access point)
    linkChanged: run.linkChanged || null,
    label: val(run.label),
    host: val(run.host),
    best: b ? { name: b.name, avg: b.avg, jitter: b.jitter, loss: b.loss } : null,
    router: rt ? { host: rt.host, avg: rt.avg, jitter: rt.jitter, loss: rt.loss, iface: rt.iface } : null,
    routerWhy: run.routerWhy || null,
    listWhy: run.listWhy || null,
    down: speedOf(run.down),
    up: speedOf(run.up),
    rows,
  };
}

const newestFirst = (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0);
const copy = (e) => JSON.parse(JSON.stringify(e));

function makeHistory(opts) {
  const o = opts || {};
  const file = o.file;
  const fs = o.fs || fsReal;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const dir = path.dirname(file);
  const badName = path.basename(file, path.extname(file)) + '.bad.json';
  const badFile = path.join(dir, badName);

  let loaded = false;
  let tests = [];
  let readProblem = null; // sticky for the session
  let saveProblem = null; // cleared by the next good write
  let memoryOnly = false; // the old file could not be moved aside: never write over it

  function say(line) { try { log('ping test history: ' + line); } catch (_) { /* a broken logger never breaks the history */ } }

  function moveAside(reason) {
    try {
      fs.renameSync(file, badFile);
      readProblem = `history could not be read: ${reason}; starting fresh, old file kept as ${badName}`;
      say(`could not read the file (${reason}); moved it aside, starting fresh`);
    } catch (e2) {
      const r2 = plain(e2);
      memoryOnly = true;
      readProblem = `history could not be read: ${reason}; the old file could not be moved aside (${r2}), so new tests are kept only until Mantle restarts`;
      say(`could not read the file (${reason}) nor move it aside (${r2}); keeping tests in memory only`);
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      moveAside(plain(e));
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch (e) { moveAside(parseReason(e)); return; }
    if (!isObj(data) || !Array.isArray(data.tests)) { moveAside('the file does not hold a list of tests'); return; }
    const seen = new Set();
    let dropped = 0;
    for (const t of data.tests) {
      if (!isObj(t) || typeof t.id !== 'string' || seen.has(t.id)) { dropped++; continue; }
      seen.add(t.id);
      tests.push(t);
    }
    tests.sort(newestFirst);
    if (dropped) say(`loaded ${tests.length} tests; dropped ${dropped} entries that made no sense`);
  }

  function persist() {
    if (memoryOnly) return;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tests }, null, 2));
      fs.renameSync(tmp, file);
      if (saveProblem) say('saving works again');
      saveProblem = null;
    } catch (e) {
      const next = 'history could not be saved: ' + plain(e);
      if (next !== saveProblem) say(`could not save ${tests.length} tests (${plain(e)}); kept in memory`);
      saveProblem = next;
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing left behind, or nothing more to do */ }
    }
  }

  function prune() {
    tests.sort(newestFirst);
    let unsaved = 0;
    tests = tests.filter((t) => t.saved || ++unsaved <= MAX_UNSAVED);
  }

  const find = (id) => tests.find((t) => t.id === id);
  const gone = { ok: false, reason: 'that test is no longer in the history' };

  return {
    view() {
      load();
      const p = [readProblem, saveProblem].filter(Boolean);
      return { tests: tests.map(copy), problem: p.length ? p.join(' · ') : null, max: MAX_UNSAVED };
    },
    add(run) {
      load();
      const e = entryOf(run);
      if (!e || find(e.id)) return null;
      tests.push(e);
      prune();
      persist();
      return copy(e);
    },
    save(id, name) {
      load();
      const t = find(id);
      if (!t) return Object.assign({}, gone);
      const c = checkName(name);
      if (!c.ok) return c;
      t.name = c.name;
      t.saved = true;
      persist();
      return { ok: true, entry: copy(t) };
    },
    rename(id, name) {
      load();
      const t = find(id);
      if (!t) return Object.assign({}, gone);
      if (!t.saved) return { ok: false, reason: 'only a saved test can be renamed' };
      const c = checkName(name);
      if (!c.ok) return c;
      t.name = c.name;
      persist();
      return { ok: true, entry: copy(t) };
    },
    remove(id) {
      load();
      if (!find(id)) return Object.assign({}, gone);
      tests = tests.filter((t) => t.id !== id);
      persist();
      return { ok: true };
    },
  };
}

module.exports = { MAX_UNSAVED, checkName, entryOf, makeHistory };
