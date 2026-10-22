/* apppower.test.js - node lib/features/apppower.test.js (lane mantle-power, 2026-10-14).
 * The main half of App power over a FAKE ctx and a FAKE sidecar: what reaches the sidecar, what is
 * saved, what the dropdown and Settings get back. No Windows process is touched here (the sidecar
 * half is tested on throwaway processes by sidecar/test-apppower.js). */
'use strict';
const core = require('../apppower-core');
const F = require('./apppower.js');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }
const JARGON = /sidecar|within \d+ms|no reply|undefined|\bnull\b|apppower\.\w+|dryRun|ecoqos|job object|working set/i;
const MB = 1024 * 1024;

const QUARTZ = 'C:\\Users\\user\\browser\\node_modules\\electron\\dist\\electron.exe';
const QKEY = 'electron|' + QUARTZ.toLowerCase();
const SAMPLE = {
  cpu: { pct: 30, top: [
    { name: 'electron (6)', exe: 'electron', n: 6, path: QUARTZ, access: 'ok', pct: 9 },
    { name: 'svchost (43)', exe: 'svchost', n: 43, path: 'C:\\Windows\\System32\\svchost.exe', access: 'system', pct: 5 },
    { name: 'mpburn-x1', exe: 'mpburn-x1', n: 1, path: 'C:\\Temp\\mantle-apppower-test\\mpburn-x1.exe', access: 'ok', pct: 50 },
    { name: 'electron (9)', exe: 'electron', n: 9, path: process.execPath, access: 'ok', pct: 3 },
  ] },
  mem: { top: [{ name: 'chrome (12)', exe: 'chrome', n: 12, path: 'C:\\c\\chrome.exe', access: 'ok', bytes: 900 * MB }] },
};

function fakeCtx(opts) {
  const o = opts || {};
  const sent = [], logs = [], cmds = {}, handlers = {}, store = { rules: o.saved || [] };
  let ready = null, enabledFn = null, enabled = o.enabled !== false;
  const ctx = {
    flags: Object.freeze({ test: !!o.test, live: !o.test }),
    enabled: () => enabled,
    onEnabled: (fn) => { enabledFn = fn; },
    log: (s) => logs.push(s),
    health: () => {},
    command: (name, fn) => { cmds[name] = (a) => fn(a); },
    settings: { get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: (k, v) => { if (o.saveFails) throw new Error('disk full'); store[k] = JSON.parse(JSON.stringify(v)); }, file: 'x' },
    sidecar: {
      send: async (cmd, args) => {
        sent.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
        if (o.fail && o.fail(cmd, args)) return { ok: false, error: 'no reply to "' + cmd + '" within 5000ms' };
        if (cmd === 'apppower.caps') return { ok: true, result: { ok: true, gpus: 1, gpuLow: true, gpuLowWhy: null, gpuPref: false } };
        if (cmd === 'apppower.rules') return { ok: true, result: { ok: true, dryRun: args.dryRun || undefined, status: args.rules.map((r) => ({ key: r.key, applied: 2, denied: o.denied || [], shared: true })) } };
        if (cmd === 'apppower.trim') return { ok: true, result: o.trim || { ok: true, n: 3, before: 600 * MB, after: 188 * MB, denied: [], dryRun: args.dryRun || undefined } };
        if (cmd === 'apppower.gpupref') return { ok: true, result: { ok: true, dryRun: args.dryRun || undefined } };
        return { ok: true, result: {} };
      },
      on: (ev, fn) => { handlers[ev] = fn; },
      onReady: (fn) => { ready = fn; },
    },
  };
  const inst = F.install(ctx);
  return { ctx, sent, logs, cmds, handlers, store, inst, ready: async () => { await ready(); },
    setEnabled: (on) => { enabled = on; enabledFn(on); } };
}
const rulesSent = (f) => f.sent.filter((s) => s.cmd === 'apppower.rules');
const lastRules = (f, dry) => { const r = rulesSent(f).filter((s) => !!s.args.dryRun === !!dry); return r.length ? r[r.length - 1].args.rules : null; };
const settle = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  // ---- install: saved rules are checked, then sent on ready with the caps
  let f = fakeCtx({ saved: [
    { key: QKEY, exe: 'electron', path: QUARTZ, label: 'Quartz', set: { eco: true, cpuCap: 25 } },
    { key: 'svchost', exe: 'svchost', set: { eco: true } },          // protected: dropped
    { exe: 'electron', set: { eco: true } },                        // no path: dropped
    'junk',
  ] });
  check('nothing is sent before the sidecar is ready, rows are undecorated', f.sent.length === 0 && core.live.decorate(SAMPLE) === SAMPLE);
  await f.ready();
  check('on ready: the caps are asked, then the saved table is sent', f.sent[0].cmd === 'apppower.caps' && f.sent[1].cmd === 'apppower.rules', f.sent.map((s) => s.cmd));
  let t = lastRules(f);
  check('only the valid saved rule reaches the sidecar, in the contract\'s shape', t.length === 1 && t[0].key === QKEY && t[0].match.exe === 'electron' && t[0].match.path === QUARTZ && t[0].set.eco === true && t[0].set.cpuCap === 25 && !('gpuPref' in t[0].set), t);
  check('the dropped saved rules are logged without names', f.logs.some((l) => /3 saved rule\(s\) were not valid/.test(l)), f.logs);
  let d = core.live.decorate(SAMPLE);
  check('rows are decorated once running: Quartz shows its remembered rule and the caps', d.cpu.top[0].label === 'Quartz' && d.cpu.top[0].set.eco && d.cpu.top[0].remembered && d.apppower.gpus === 1);

  // ---- set
  let r = await f.cmds.set({ key: 'chrome', change: { memLow: true }, remember: true });
  t = lastRules(f);
  check('set: Lower memory priority on Chrome reaches the sidecar next to Quartz\'s rule', r.ok && t.length === 2 && t.some((x) => x.key === 'chrome' && x.set.memLow === true), { r, t });
  check('set: the reply carries the row\'s new state', r.row && r.row.key === 'chrome' && r.row.set.memLow === true && r.row.remembered === true && r.row.label === 'Google Chrome', r.row);
  check('set: a remembered rule is saved', f.store.rules.some((x) => x.key === 'chrome' && x.set.memLow === true));
  r = await f.cmds.set({ key: 'chrome', change: { cpuCap: 50 }, remember: false });
  check('set: "Remember" off keeps it for this session only (sent, not saved)', r.ok && lastRules(f).some((x) => x.key === 'chrome' && x.set.cpuCap === 50) && !f.store.rules.some((x) => x.key === 'chrome'), f.store.rules);
  r = await f.cmds.remember({ key: 'chrome', on: true });
  check('remember: the checkbox on its own saves the rule', r.ok && f.store.rules.some((x) => x.key === 'chrome' && x.set.cpuCap === 50 && x.set.memLow));
  r = await f.cmds.set({ key: 'chrome', change: { cpuCap: 0 }, remember: true });
  r = await f.cmds.set({ key: 'chrome', change: { memLow: false }, remember: true });
  check('set: back to all-normal removes the rule (sent and saved)', r.ok && !lastRules(f).some((x) => x.key === 'chrome') && !f.store.rules.some((x) => x.key === 'chrome'));
  let n = f.sent.length;
  r = await f.cmds.set({ key: 'svchost', change: { eco: true } });
  check('set: a protected app is refused in plain words and nothing is sent', !r.ok && r.reason === 'Windows protects this process' && f.sent.length === n, r);
  r = await f.cmds.set({ key: 'electron|' + process.execPath.toLowerCase(), change: { eco: true } });
  check('set: Mantle itself is refused', !r.ok && r.reason === 'This is Mantle' && f.sent.length === n, r);
  r = await f.cmds.set({ key: 'nope', change: { eco: true } });
  check('set: an app that is not in the list is refused', !r.ok && /closed or left the list/.test(r.reason) && f.sent.length === n);
  r = await f.cmds.set({ key: 'chrome', change: { priority: 'realtime' } });
  check('set: Realtime is refused, nothing sent', !r.ok && /never raises/.test(r.reason) && f.sent.length === n);
  r = await f.cmds.set({ key: 'chrome', change: { gpuPref: 'performance' } });
  check('set: a graphics preference on a one-GPU PC is refused', !r.ok && /one graphics processor/.test(r.reason) && f.sent.length === n);
  // two quick clicks: both land
  const [a1, a2] = await Promise.all([f.cmds.set({ key: 'chrome', change: { eco: true } }), f.cmds.set({ key: QKEY, change: { memLow: true } })]);
  t = lastRules(f);
  check('two quick changes both reach the last table', a1.ok && a2.ok && t.some((x) => x.key === 'chrome' && x.set.eco) && t.some((x) => x.key === QKEY && x.set.memLow && x.set.eco), t);

  // ---- the sidecar refuses: the row stays true
  f = fakeCtx({ fail: (cmd) => cmd === 'apppower.rules' && f && f._failNow });
  await f.ready();
  core.live.decorate(SAMPLE);
  f._failNow = true;
  r = await f.cmds.set({ key: 'chrome', change: { eco: true } });
  check('set: a failed apply is reported in plain words and NOT kept', !r.ok && !JARGON.test(r.reason) && r.row && r.row.set.eco === false && !core.live.rules.has('chrome'), r);
  f._failNow = false;

  // ---- denial words through the status
  f = fakeCtx({ denied: [{ access: 'admin', n: 6 }] });
  await f.ready();
  core.live.decorate(SAMPLE);
  r = await f.cmds.set({ key: QKEY, change: { eco: true } });
  d = core.live.decorate(SAMPLE);
  check('a refusal from Windows shows on the row in the user\'s words', d.cpu.top[0].deny === 'Windows didn’t let Mantle change 2 of Quartz’s processes: they run as administrator' || /runs? as administrator/.test(d.cpu.top[0].deny || ''), d.cpu.top[0].deny);
  f.handlers.apppower({ ev: 'apppower', status: [{ key: QKEY, applied: 0, denied: [{ access: 'admin', n: 6 }] }] });
  d = core.live.decorate(SAMPLE);
  check('a later push (an app restarted as admin) updates the row', d.cpu.top[0].deny === 'Windows didn’t let Mantle change Quartz: it runs as administrator', d.cpu.top[0].deny);

  // ---- trim
  f = fakeCtx();
  await f.ready();
  core.live.decorate(SAMPLE);
  r = await f.cmds.trim({ key: 'chrome' });
  const tr = f.sent.find((s) => s.cmd === 'apppower.trim');
  check('trim: Free up memory sends the app\'s match once and says what it freed', r.ok && r.text === 'Freed 412 MB' && r.freed === 412 * MB && tr.args.match.exe === 'chrome' && !tr.args.dryRun, { r, tr });
  f = fakeCtx({ trim: { ok: true, n: 0, before: 0, after: 0, denied: [{ access: 'admin', n: 2 }] } });
  await f.ready();
  core.live.decorate(SAMPLE);
  r = await f.cmds.trim({ key: 'chrome' });
  check('trim: an admin app says so', !r.ok && r.reason === 'Windows didn’t let Mantle change Google Chrome: it runs as administrator', r);
  r = await f.cmds.trim({ key: 'svchost' });
  check('trim: a protected app is refused', !r.ok && r.reason === 'Windows protects this process');

  // ---- graphics preference (2 GPUs) and reset
  f = fakeCtx();
  await f.ready();
  core.live.decorate(SAMPLE);
  core.live.caps = { gpus: 2, gpuLow: true, gpuLowWhy: null, gpuPref: true };
  r = await f.cmds.set({ key: 'chrome', change: { gpuPref: 'saving' } });
  const gp = f.sent.find((s) => s.cmd === 'apppower.gpupref');
  check('graphics preference: written by exe path, kept on the rule, not in the sidecar\'s process set', r.ok && gp && gp.args.path === 'C:\\c\\chrome.exe' && gp.args.pref === 'saving' && r.row.set.gpuPref === 'saving' && !('gpuPref' in lastRules(f)[0].set), { r, gp });
  r = await f.cmds.reset({ key: 'chrome' });
  const gp2 = f.sent.filter((s) => s.cmd === 'apppower.gpupref');
  check('reset: back to normal: the preference goes back to Windows\' default, the rule is gone and unsaved', r.ok && gp2.length === 2 && gp2[1].args.pref === 'default' && !core.live.rules.has('chrome') && !f.store.rules.length && r.row.set.gpuPref === 'default', { r, gp2 });

  // ---- Settings: rules / forget / resetAll / undo
  f = fakeCtx({ saved: [
    { key: QKEY, exe: 'electron', path: QUARTZ, label: 'Quartz', set: { eco: true, cpuCap: 25 } },
    { key: 'chrome', exe: 'chrome', path: 'C:\\c\\chrome.exe', label: 'Google Chrome', set: { memCap: 1024 * MB } },
  ] });
  await f.ready();
  r = await f.cmds.rules();
  check('rules: listed by name with a plain summary', r.ok && r.rules.length === 2 && r.rules[0].label === 'Google Chrome' && r.rules[0].summary === 'Memory limit 1 GB' && r.rules[1].summary === 'Efficiency mode, CPU limit 25%' && r.rules[1].remembered === true, r);
  const listed = r.rules;
  r = await f.cmds.forget({ key: 'chrome' });
  check('forget: removed, sent, saved', r.ok && r.rules.length === 1 && !lastRules(f).some((x) => x.key === 'chrome') && f.store.rules.length === 1);
  r = await f.cmds.restoreRules({ rules: [listed[0]] });
  check('undo of a Remove: the rule is back, sent and saved', r.ok && r.restored === 1 && lastRules(f).some((x) => x.key === 'chrome' && x.set.memCap === 1024 * MB) && f.store.rules.length === 2, r);
  r = await f.cmds.resetAll();
  check('reset all: every app back to normal (empty table), nothing saved, the removed rules returned for undo', r.ok && r.removed.length === 2 && lastRules(f).length === 0 && f.store.rules.length === 0, r);
  r = await f.cmds.restoreRules({ rules: r.removed });
  check('undo of Reset all puts both back', r.ok && r.restored === 2 && lastRules(f).length === 2 && f.store.rules.length === 2);
  r = await f.cmds.restoreRules({ rules: [{ exe: 'svchost', set: { eco: true } }, { exe: 'lsass', set: { cpuCap: 5 } }] });
  check('undo cannot smuggle in a protected app', !r.ok && !lastRules(f).some((x) => x.key === 'svchost'));
  r = await f.cmds.forget({ key: 'nothing' });
  check('forget of a missing rule says so', !r.ok && /already gone/.test(r.reason));

  // ---- saving fails: applied, but the row says it was not saved
  f = fakeCtx({ saveFails: true });
  await f.ready();
  core.live.decorate(SAMPLE);
  r = await f.cmds.set({ key: 'chrome', change: { eco: true } });
  check('a save failure: applied, with the reason in plain words', r.ok && r.reason === 'Mantle couldn’t save this for next time' && f.logs.some((l) => /saving the rules failed/.test(l)));

  // ---- off in the tray: every app handed back, commands refused
  f = fakeCtx({ saved: [{ key: QKEY, exe: 'electron', path: QUARTZ, label: 'Quartz', set: { eco: true } }] });
  await f.ready();
  f.setEnabled(false);
  await settle(); await settle();
  check('turned off: an empty table hands every app back to Windows', lastRules(f).length === 0);
  check('turned off: rows are not decorated', core.live.decorate(SAMPLE) === SAMPLE);
  r = await f.cmds.set({ key: QKEY, change: { cpuCap: 10 } });
  check('turned off: commands answer why', !r.ok && /turned off/.test(r.reason));
  f.setEnabled(true);
  await settle(); await settle();
  check('turned on again: the saved rules come back', lastRules(f).length === 1 && lastRules(f)[0].key === QKEY);

  // ---- --test: only dry runs, except the throwaway exe
  process.env.MANTLE_APPPOWER_TEST_EXE = 'mpburn-x1';
  f = fakeCtx({ test: true, saved: [{ key: QKEY, exe: 'electron', path: QUARTZ, label: 'Quartz', set: { eco: true } }] });
  await f.ready();
  core.live.decorate(SAMPLE);
  check('--test: the real table is EMPTY of real apps, the full table goes as a dry run', lastRules(f, false).length === 0 && lastRules(f, true).length === 1);
  r = await f.cmds.set({ key: 'mpburn-x1', change: { cpuCap: 25 } });
  check('--test: the throwaway exe\'s rule is real, Quartz\'s stays a dry run', r.ok && lastRules(f, false).length === 1 && lastRules(f, false)[0].key === 'mpburn-x1' && lastRules(f, true).length === 2, rulesSent(f).slice(-2));
  r = await f.cmds.set({ key: 'chrome', change: { eco: true } });
  check('--test: a real app\'s change is a dry run, and the row still shows it set', r.ok && r.dryRun === true && r.row.set.eco === true && !lastRules(f, false).some((x) => x.key === 'chrome'));
  r = await f.cmds.trim({ key: 'chrome' });
  check('--test: Free up memory is a dry run with its own words', r.ok && f.sent.filter((s) => s.cmd === 'apppower.trim').pop().args.dryRun === true && r.text === 'Test run: nothing was freed', r);
  check('--test: the rows say test', core.live.decorate(SAMPLE).cpu.top[0].test === true);
  delete process.env.MANTLE_APPPOWER_TEST_EXE;
  f = fakeCtx({ test: true });
  await f.ready();
  core.live.decorate(SAMPLE);
  r = await f.cmds.set({ key: 'mpburn-x1', change: { eco: true } });
  check('--test without the env: even the burner is a dry run', r.ok && r.dryRun === true && lastRules(f, false).length === 0);

  // ---- phase 2 hook
  f = fakeCtx();
  await f.ready();
  core.live.setAuto([{ exe: 'chrome', path: 'C:\\c\\chrome.exe', set: { eco: true } }]);
  await settle(); await settle();
  check('PHASE 2: setAuto re-sends the table with Auto\'s rule', lastRules(f).some((x) => x.key === 'chrome' && x.set.eco));
  core.live.setAuto([]);
  await settle(); await settle();
  f.inst.stop();
  check('stop: rows are undecorated again', core.live.decorate(SAMPLE) === SAMPLE);

  // ---- every reply is plain words
  const replies = [];
  f = fakeCtx({ fail: () => true });
  await f.ready();
  core.live.decorate(SAMPLE);
  replies.push(await f.cmds.set({ key: 'chrome', change: { eco: true } }), await f.cmds.trim({ key: 'chrome' }), await f.cmds.set({ key: 'x', change: {} }), await f.cmds.reset({ key: 'gone' }));
  check('every refusal is plain words', replies.every((x) => !x.ok && typeof x.reason === 'string' && !JARGON.test(x.reason)), replies.map((x) => x.reason));

  for (const x of failures) console.log('  FAIL ' + x);
  console.log('APPPOWER FEATURE TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
