'use strict';
/*
 * run.test.js - Win+R (lib/features/run.js), Win+X (quicklinks.js) and their launch road (_run-exec.js)
 * against a FAKE ctx and a FAKE sidecar, in plain node: nothing is opened or started (lane keysrun).
 *   node lib/features/run.test.js      prints "RUN FEATURE TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RUN = require('./run');
const QLF = require('./quicklinks');
const QL = require('../quick-links');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + detail : '')); }
const show = (x) => JSON.stringify(x);

function world(mod, o) {
  const w = { cmds: {}, chords: {}, ons: {}, store: {}, sent: [], ready: [], health: null, opened: null };
  const ctx = {
    name: mod.name, flags: { test: !!o.test, live: !o.test }, log: () => {},
    settings: { get: (k, d) => (k in w.store ? JSON.parse(JSON.stringify(w.store[k])) : d), set: (k, v) => { w.store[k] = JSON.parse(JSON.stringify(v)); } },
    sidecar: { get ready() { return o.ready !== false; }, pid: 4242,
      send: async (c, a) => { w.sent.push({ c, a }); return o.send(c, a, w); },
      on: (ev, fn) => { w.ons[ev] = fn; }, onReady: (fn) => { w.ready.push(fn); } },
    command: (v, fn) => { w.cmds[v] = fn; }, onChord: (c, fn) => { w.chords[c] = fn; },
    health: (ok, why) => { w.health = { ok, why }; },
    host: { openLauncher: (a) => { w.opened = a; } },
  };
  mod.install(ctx);
  return w;
}
const found = (file) => ({ found: /^notarealprogram/.test(file) ? null : 'C:\\Windows\\System32\\' + file + (/\./.test(file) ? '' : '.exe') });
const dryRunSidecar = (c, a) => {
  if (c === 'run.exec') return { ok: true, result: { ok: true, dryRun: true, verb: a.verb, file: a.file, params: a.params, found: found(a.file) } };
  if (c === 'run.mru') return { ok: true, result: { items: ['git', 'PERFMON /report', 'SystemPropertiesPerformance.exe'] } };
  if (c === 'run.resolve') return { ok: true, result: a.file === 'wt.exe' ? { found: null } : found(a.file) };
  if (c === 'hotcorners.desktop') return { ok: true, result: { ok: true, dryRun: true } };
  return { ok: false, error: 'unknown command: ' + c };
};

async function main() {
  /* ---- Win+R, test mode (every launch a dry run) ---- */
  const r = world(RUN, { test: true, send: dryRunSidecar });
  check('run: takes exactly Win+R, rests with the launcher', show(RUN.chords) === '["Win+R"]' && RUN.rest === true && typeof r.chords['Win+R'] === 'function');
  r.chords['Win+R']('Win+R');
  check('run: Win+R opens the launcher in Run mode (no new window)', show(r.opened) === '{"mode":"run"}', show(r.opened));
  check('run: healthy with its words', r.health && r.health.ok === true && /Win\+R opens the launcher in Run mode/.test(r.health.why));
  for (const fn of r.ready) await fn();
  let x = await r.cmds.exec({ line: 'perfmon /report' });
  const last = () => r.sent.filter((s) => s.c === 'run.exec').slice(-1)[0].a;
  check('run: perfmon /report -> run.exec file + params apart, open, dry run', x.ok && x.dryRun && x.how === 'exec' && show(last()) === show({ file: 'perfmon', params: '/report', verb: 'open', dryRun: true }), show({ x, a: last() }));
  x = await r.cmds.exec({ line: 'perfmon /report', admin: true });
  check('run: admin -> runas', x.ok && last().verb === 'runas' && /as administrator/.test(x.reason), show(x));
  x = await r.cmds.exec({ line: 'notarealprogram' });
  check('run: an unknown command -> Windows\' words, not remembered', !x.ok && x.reason === 'Windows can\'t find "notarealprogram". Check the spelling, then try again.' && !(r.store.history || []).includes('notarealprogram'), show(x));
  x = await r.cmds.exec({ line: '%appdata%' });
  check('run: %appdata% -> a folder, through Mantle Files (dry run)', x.ok && x.how === 'folder' && /files:.*Roaming/i.test(x.reason || ''), show(x));
  x = await r.cmds.exec({ line: 'ms-settings:display' });
  check('run: ms-settings: -> Mantle Settings (dry run)', x.ok && x.how === 'settings' && /Mantle Settings/.test(x.reason || ''), show(x));
  x = await r.cmds.exec({ line: '' });
  check('run: nothing typed -> plain words', !x.ok && /Type a program/.test(x.reason), show(x));
  x = await r.cmds.exec({ line: 'calc\nnotepad' });
  check('run: a line break -> refused, nothing sent', !x.ok && /line break/.test(x.reason), show(x));
  x = await r.cmds.exec({ line: 42 });
  check('run: a non-string line -> plain words', !x.ok && typeof x.reason === 'string', show(x));
  const h = await r.cmds.history();
  check('run: history = Mantle\'s (newest first) then RunMRU without repeats', show(h.items) === show(['ms-settings:display', '%appdata%', 'perfmon /report', 'git', 'SystemPropertiesPerformance.exe']), show(h.items));
  check('run: history is saved in its settings', show(r.store.history) === show(['ms-settings:display', '%appdata%', 'perfmon /report']), show(r.store.history));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-keysrun-'));
  fs.mkdirSync(path.join(tmp, 'alpha')); fs.writeFileSync(path.join(tmp, 'alpine.txt'), 'x'); fs.writeFileSync(path.join(tmp, 'beta.txt'), 'x');
  const c = await r.cmds.complete({ typed: tmp + '\\al' });
  check('run: folder completion lists the folder you are typing in, folders first', show(c.items.map((i) => i.text.slice(tmp.length))) === show(['\\alpha\\', '\\alpine.txt']), show(c.items));
  fs.rmSync(tmp, { recursive: true, force: true });

  /* ---- the launch road, live mode with a FAKE sidecar (nothing can start) ---- */
  let mode = 'now';
  const live = world(RUN, { test: false, send: (cmd, a, w) => {
    if (cmd !== 'run.exec') return dryRunSidecar(cmd, a);
    if (mode === 'now') return { ok: true, result: { ok: true, code: 0, pid: 99, ticket: 'r1' } };
    if (mode === 'pending') { setTimeout(() => w.ons.run({ ev: 'run', ticket: 'r2', ok: true, code: 0, pid: 77 }), 30); return { ok: true, result: { pending: true, ticket: 'r2' } }; }
    if (mode === 'early') { w.ons.run({ ev: 'run', ticket: 'r3', ok: true, code: 0, pid: 55 }); return { ok: true, result: { pending: true, ticket: 'r3' } }; }
    if (mode === 'cancel') { setTimeout(() => w.ons.run({ ev: 'run', ticket: 'r4', ok: false, code: 1223 }), 10); return { ok: true, result: { pending: true, ticket: 'r4' } }; }
    if (mode === 'notfound') return { ok: true, result: { ok: false, code: 2, message: 'The system cannot find the file specified.' } };
    return { ok: false, error: 'unknown command: run.exec' };
  } });
  x = await live.cmds.exec({ line: 'git' });
  check('live: an answer within the wait -> ok, started', x.ok && x.pid === 99 && !x.dryRun, show(x));
  mode = 'pending'; x = await live.cmds.exec({ line: 'regedit', admin: true });
  check('live: a UAC prompt finishes as the run event', x.ok && x.pid === 77, show(x));
  mode = 'early'; x = await live.cmds.exec({ line: 'regedit', admin: true });
  check('live: an outcome that beats its own "pending" reply is not lost', x.ok && x.pid === 55, show(x));
  mode = 'cancel'; x = await live.cmds.exec({ line: 'regedit', admin: true });
  check('live: no to the UAC prompt -> plain words', !x.ok && x.reason === 'You said no to the administrator prompt, so "regedit" didn\'t run.', show(x));
  mode = 'notfound'; x = await live.cmds.exec({ line: 'notarealprogram' });
  check('live: not found -> plain words', !x.ok && /^Windows can't find "notarealprogram"/.test(x.reason), show(x));
  mode = 'old'; x = await live.cmds.exec({ line: 'git' });
  check('live: an old helper -> "restart Mantle", no jargon', !x.ok && /older than Run and Quick links/.test(x.reason), show(x));
  const down = world(RUN, { test: false, ready: false, send: dryRunSidecar });
  x = await down.cmds.exec({ line: 'git' });
  check('live: helper down -> says Win+R is Windows\' until it is back', !x.ok && /Windows' own/.test(x.reason), show(x));
  const old = world(RUN, { test: false, send: () => ({ ok: false, error: 'unknown command: run.resolve' }) });
  for (const fn of old.ready) await fn();
  check('fail-open: an old helper exe hands Win+R back to Windows (health false, said why)', old.health && old.health.ok === false && /older/.test(old.health.why), show(old.health));

  /* ---- Win+X ---- */
  const q = world(QLF, { test: true, send: dryRunSidecar });
  check('quick: takes exactly Win+X', show(QLF.chords) === '["Win+X"]' && QLF.rest === true);
  q.chords['Win+X']('Win+X');
  check('quick: Win+X opens the launcher in Quick links mode', show(q.opened) === '{"mode":"quick"}', show(q.opened));
  for (const l of QL.LINKS.filter((k) => k.run)) {
    const res = await q.cmds.open({ link: l.id });
    check(`quick: ${l.id} opens (dry run)`, res.ok && res.link === l.id, show(res));
  }
  const term = await q.cmds.open({ link: 'terminaladmin' });
  const ta = q.sent.filter((s) => s.c === 'run.exec').slice(-1)[0].a;
  check('quick: Terminal (Admin) without Windows Terminal -> PowerShell, runas, said', term.ok && ta.file === 'powershell.exe' && ta.verb === 'runas' && /PowerShell opened instead/.test(term.reason), show({ term, ta }));
  const dev = await q.cmds.open({ link: 'devices' });
  check('quick: Device Manager is devmgmt.msc through run.exec', dev.ok && q.sent.some((s) => s.c === 'run.exec' && s.a.file === 'devmgmt.msc'), show(dev));
  for (const bad of ['search', 'run', 'shutdown', 'nope', '', undefined]) {
    const res = await q.cmds.open({ link: bad });
    check(`quick: ${show(bad)} is refused in plain words (the page's own, or unknown)`, !res.ok && /quick link/.test(res.reason), show(res));
  }
  const injected = await q.cmds.open({ link: 'devices', file: 'cmd.exe', params: '/c bad' });
  check('quick: a page cannot choose what runs (extra args ignored)', injected.ok && q.sent.filter((s) => s.c === 'run.exec').slice(-1)[0].a.file === 'devmgmt.msc');
}

main().catch((e) => check('the run finished', false, e && e.stack)).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`RUN FEATURE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
