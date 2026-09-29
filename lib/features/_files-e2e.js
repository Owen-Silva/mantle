'use strict';
/* _files-e2e.js - TEST ONLY (lane files2, 2026-09-28): the end-to-end proof of Mantle Files inside a
 * real `electron . --test` instance. lib/features/files.js loads it ONLY when Mantle runs with --test,
 * MANTLE_FILES_SELFTEST=1 and a valid MANTLE_FILES_SANDBOX; a live Mantle never requires this file.
 *
 * Every Mantle Files window that loads logs how long Win+E took to paint its first folder (cold on the
 * first window, warm after). The FIRST window then drives its own page through the real bridge
 * (window.mantle.call -> main -> sidecar): it lists a folder inside the sandbox, copies, renames and
 * recycles there, undoes each, checks the guard refuses a write outside the sandbox, times page script
 * per folder change (DevTools Performance.getMetrics, ScriptDuration), cleans up and closes the window.
 *
 * PRIVACY: log lines carry counts, ms and pass/fail only; never a file name or path.
 * SAFETY: every write targets <sandbox>\e2e-<pid>\ (checked before anything is created); the refusal
 * probes point at <sandbox>\..\outside (harmless scratch the sidecar test also uses), which is
 * snapshotted and must be unchanged at the end. */

const fs = require('fs');
const path = require('path');

let opened = 0;
let scenarioRan = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inside(root, p) {
  const r = path.resolve(root).toLowerCase().replace(/\\+$/, '');
  const q = path.resolve(p).toLowerCase();
  return q.startsWith(r + '\\');
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push('d|' + p); walk(p); } else {
        let st = null;
        try { st = fs.statSync(p); } catch (_) { st = null; }
        out.push('f|' + p + '|' + (st ? st.size + '|' + st.mtimeMs : '?'));
      }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

const HELPER = `(() => {
  if (window.__ft) return true;
  const done = new Map(), wait = new Map();
  window.mantle.on('files.opdone', (ev) => {
    if (!ev || !ev.job) return;
    done.set(ev.job, ev);
    const f = wait.get(ev.job);
    if (f) { wait.delete(ev.job); f(ev); }
  });
  const until = (job, ms) => done.has(job) ? Promise.resolve(done.get(job)) : new Promise((res) => {
    wait.set(job, res);
    setTimeout(() => { if (wait.has(job)) { wait.delete(job); res(null); } }, ms);
  });
  const slim = (ev) => ev && { ok: ev.ok, wasUndo: !!ev.wasUndo, undoable: !!ev.undoable, reason: ev.reason || null,
    results: (ev.results || []).map((x) => ({ ok: x.ok !== false, key: x.key ? 1 : 0, why: x.why ? 1 : 0 })) };
  window.__ft = {
    async op(args) { const r = await MF.app.api('files.op', args); return { start: r, done: slim(r && r.job ? await until(r.job, 20000) : null) }; },
    async undo() { const r = await MF.app.api('files.undo', {}); return { start: r, done: slim(r && r.job ? await until(r.job, 20000) : null) }; },
    async call(name, args) { return MF.app.api(name, args || {}); },
    async go(p) {
      const t = MF.app.cur();
      const t0 = performance.now();
      MF.app.go(t, p);
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (t.path && !t.loading && t.error) return { error: t.error, ms: performance.now() - t0 };
        if (!t.loading && t.run && t.run.all != null) return { ms: performance.now() - t0, count: t.items.length, first: t.run.first };
        await new Promise((r) => setTimeout(r, 5));
      }
      return { error: 'no listing within 15 s' };
    },
    names() { return MF.app.cur().items.map((x) => x.n).sort(); },
  };
  return true;
})()`;

/** Called from files.js on every Mantle Files window's did-finish-load in self-test mode. */
async function loaded(o) {
  const n = ++opened;
  const loadMs = Date.now() - o.t0;                                  // window made + page loaded
  const wc = o.win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  let ready = null;
  const end = Date.now() + 20000;
  while (Date.now() < end && !o.win.isDestroyed()) {
    try {
      ready = await js(`(() => { const t = window.MF && MF.app && MF.app.cur && MF.app.cur();
        if (document.documentElement.dataset.ready !== '1' || !t || t.loading) return null;
        return { kind: t.kind, count: (t.items || []).length, err: !!t.error }; })()`);
    } catch (_) { ready = null; }
    if (ready) break;
    await sleep(15);
  }
  const ms = Date.now() - o.t0;
  o.log(`E2E open #${n} (${n === 1 ? 'cold' : 'warm'}): ${ready ? `first view (${ready.kind}, ${ready.count} items${ready.err ? ', ERROR shown' : ''}) ready ${ms} ms after Win+E (page loaded at ${loadMs} ms)` : 'the page never became ready in 20 s'}`);
  if (n !== 1 || scenarioRan) return;
  scenarioRan = true;
  try { await scenario(o); } catch (e) { o.log(`E2E FAIL: the scenario threw (${e && e.message})`); o.log('E2E: 0 passed, 1 failed'); }
}

async function scenario(o) {
  const wc = o.win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  let pass = 0, fail = 0;
  const check = (label, ok, detail) => { if (ok) pass++; else fail++; o.log(`E2E ${ok ? 'ok  ' : 'FAIL'}: ${label}${!ok && detail ? ` (${detail})` : ''}`); };
  const J = (v) => JSON.stringify(v);

  const base = path.join(o.sandbox, 'e2e-' + process.pid);
  if (!inside(o.sandbox, base)) { check('the work folder is inside the sandbox', false); return; }
  const src = path.join(base, 'src'), dst = path.join(base, 'dst'), many = path.join(base, 'many');
  const outside = path.join(path.dirname(o.sandbox), 'outside');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(many, { recursive: true });
  for (const x of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(src, x), 'mantle files e2e ' + x + '\n');
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(many, 'item ' + String(i).padStart(4, '0') + '.txt'), String(i));
  const outsideOk = fs.existsSync(outside);
  const outBefore = outsideOk ? snapshot(outside) : '';

  // identity: the window Win+E opened is Mantle Files, with its icon
  check('the window is titled exactly as lib/mantle-apps.js names it', o.win.getTitle() === o.title, J(o.win.getTitle() === o.title));
  check('the Mantle Files icon exists and was set on the window', !!o.hasIcon);

  await js(HELPER);
  const f = (expr) => js(`window.__ft.${expr}`);
  const ex = (...p) => fs.existsSync(path.join(...p));

  // list a folder inside the sandbox
  const l1 = await f(`go(${J(src)})`);
  const names = await f('names()');
  check('lists a sandbox folder (3 items, the right ones)', !l1.error && l1.count === 3 && J(names) === J(['a.txt', 'b.txt', 'c.txt']), l1.error || `count ${l1.count}`);

  // copy + undo
  let r = await f(`op(${J({ op: 'copy', items: [path.join(src, 'a.txt')], dest: dst, conflict: 'ask' })})`);
  check('copy into another sandbox folder', r.done && r.done.ok && ex(dst, 'a.txt') && ex(src, 'a.txt'), r.done ? r.done.reason : r.start && r.start.reason);
  check('the copy is undoable', !!(r.done && r.done.undoable));
  r = await f('undo()');
  check('undo of the copy removes the copy (and only it)', r.done && r.done.ok && r.done.wasUndo && !ex(dst, 'a.txt') && ex(src, 'a.txt'), r.done ? r.done.reason : r.start && r.start.reason);

  // rename + the page refreshes by itself + undo
  r = await f(`op(${J({ op: 'rename', items: [path.join(src, 'b.txt')], name: 'b renamed.txt' })})`);
  check('rename in the sandbox', r.done && r.done.ok && ex(src, 'b renamed.txt') && !ex(src, 'b.txt'), r.done ? r.done.reason : r.start && r.start.reason);
  let seen = false;
  for (let i = 0; i < 60 && !seen; i++) { seen = (await f('names()')).includes('b renamed.txt'); if (!seen) await sleep(50); }
  check('the open folder shows the rename by itself (no F5)', seen);
  r = await f('undo()');
  check('undo of the rename puts the old name back', r.done && r.done.ok && r.done.wasUndo && ex(src, 'b.txt') && !ex(src, 'b renamed.txt'), r.done ? r.done.reason : r.start && r.start.reason);

  // recycle + undo (restore from the Recycle Bin by the key the op reported)
  r = await f(`op(${J({ op: 'recycle', items: [path.join(src, 'c.txt')] })})`);
  const key = r.done && r.done.results && r.done.results[0] && r.done.results[0].key;
  check('recycle a sandbox file (key of the bin item reported)', r.done && r.done.ok && !ex(src, 'c.txt') && !!key, r.done ? r.done.reason : r.start && r.start.reason);
  r = await f('undo()');
  check('undo of the recycle restores it from the Recycle Bin', r.done && r.done.ok && r.done.wasUndo && ex(src, 'c.txt'), r.done ? r.done.reason : r.start && r.start.reason);

  // the guard: writes that touch anything outside the sandbox are refused, nothing moves
  r = await f(`op(${J({ op: 'copy', items: [path.join(src, 'a.txt')], dest: outside, conflict: 'ask' })})`);
  check('guard: copy OUT of the sandbox is refused', r.start && r.start.ok === false && !r.done, r.start && r.start.reason);
  r = await f(`op(${J({ op: 'newfolder', dest: outside, name: 'e2e probe' })})`);
  check('guard: a new folder outside the sandbox is refused', r.start && r.start.ok === false && !ex(outside, 'e2e probe'), r.start && r.start.reason);
  r = await f(`op(${J({ op: 'move', items: [path.join(outside, 'keep.txt')], dest: src, conflict: 'ask' })})`);
  check('guard: moving an outside file IN is refused', r.start && r.start.ok === false && !ex(src, 'keep.txt'), r.start && r.start.reason);
  r = await f(`op(${J({ op: 'recycle', items: [base + '\\..\\..\\outside\\keep.txt'] })})`);     // a literal .. (path.join would fold it)
  check('guard: recycling outside through a .. path is refused', r.start && r.start.ok === false, r.start && r.start.reason);
  const o1 = await f(`call('files.open', ${J({ path: path.join(src, 'a.txt') })})`);
  check('open in the default app is a dry run in test mode', !!(o1 && o1.dryRun), J(o1 && { ok: o1.ok, dryRun: o1.dryRun }));
  if (outsideOk) check('the outside folder is byte-for-byte unchanged', snapshot(outside) === outBefore);
  else check('the outside probe folder exists (the sidecar test makes it)', false, 'absent: the refusals were still checked');

  // timing: page script per folder change (ScriptDuration from DevTools metrics) and wall time
  let dbg = null;
  try { dbg = wc.debugger; dbg.attach('1.3'); await dbg.sendCommand('Performance.enable'); } catch (e) { dbg = null; o.log(`E2E note: DevTools metrics unavailable (${e.message}); wall time only`); }
  const metric = async () => {
    if (!dbg) return 0;
    const m = await dbg.sendCommand('Performance.getMetrics');
    const g = (k) => ((m.metrics || []).find((x) => x.name === k) || {}).value || 0;
    return g('ScriptDuration') * 1000;
  };
  const rows = { small: [], big: [] };
  for (let i = 0; i < 6; i++) {
    for (const [which, p] of [['small', src], ['big', many]]) {
      const s0 = await metric();
      const g = await f(`go(${J(p)})`);
      const s1 = await metric();
      if (g.error) { check(`timing listing (${which})`, false, g.error); continue; }
      rows[which].push({ wall: g.ms, script: s1 - s0, count: g.count });
    }
  }
  if (dbg) { try { dbg.detach(); } catch (_) { /* gone */ } }
  const med = (a, k) => { const s = a.map((x) => x[k]).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  for (const k of ['small', 'big']) {
    const a = rows[k];
    if (!a.length) continue;
    o.log(`E2E timing folder change (${a[0].count} items, ${a.length} runs): wall median ${med(a, 'wall').toFixed(0)} ms (max ${Math.max(...a.map((x) => x.wall)).toFixed(0)}), page script median ${med(a, 'script').toFixed(1)} ms (max ${Math.max(...a.map((x) => x.script)).toFixed(1)})`);
  }
  check('a 1000-item sandbox folder lists in full', rows.big.length > 0 && rows.big.every((x) => x.count === 1000), rows.big.length ? `count ${rows.big[0].count}` : 'no runs');

  // leave the window on something that is not about to be deleted, then clean up
  await js(`(MF.app.go(MF.app.cur(), 'mantle:home'), true)`);     // Home: the same start the cold open had
  await sleep(300);
  try { if (inside(o.sandbox, base)) fs.rmSync(base, { recursive: true, force: true }); } catch (e) { o.log(`E2E note: the work folder was not removed (${e.code || e.message})`); }
  check('cleanup removed the work folder', !fs.existsSync(base));
  o.log(`E2E: ${pass} passed, ${fail} failed`);
  o.close();
}

module.exports = { loaded };
