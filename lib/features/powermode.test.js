/* powermode.test.js - node lib/features/powermode.test.js (lane sysmon-power, 2026-09-29).
 * The main half of the power mode switch over a FAKE ctx: what reaches the sidecar, what reaches the
 * page. Each block below failed before its fix: a bad argument used to go to the sidecar as it was,
 * a --test instance sent real writes, and a timeout reached the page as "(no reply ... within 4000ms)". */
'use strict';
const F = require('./powermode.js');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }

const STATE = { ok: true, mode: 'balanced', available: true, settable: true, source: 'ac', plan: { name: 'Balanced' } };
function fakeCtx(opts) {
  const o = opts || {};
  const sent = [], logs = [], cmds = {}, handlers = {}, casts = [];
  let ready = null;
  const ctx = {
    flags: Object.freeze({ test: !!o.test, live: false }),
    enabled: () => o.enabled !== false,
    log: (s) => logs.push(s),
    health: () => {},
    broadcast: (ch, p) => casts.push([ch, p]),
    command: (name, fn) => { cmds[name] = fn; },
    sidecar: {
      send: async (cmd, args) => {
        sent.push({ cmd, args });
        if (o.fail) return { ok: false, error: 'no reply to "' + cmd + '" within 4000ms' };
        if (cmd === 'powermode.get') return { ok: true, result: STATE };
        if (cmd === 'powermode.set') return { ok: true, result: args.dryRun ? { ok: true, dryRun: true, same: args.mode === 'balanced', mode: args.mode, state: STATE, reason: null } : { ok: true, mode: args.mode, state: Object.assign({}, STATE, { mode: args.mode }) } };
        if (cmd === 'powermode.plan') return { ok: true, result: args.dryRun ? { ok: true, dryRun: true, same: false, plan: args.plan, state: STATE } : { ok: true, plan: args.plan, state: STATE } };
        return { ok: true, result: {} };
      },
      on: (ev, fn) => { handlers[ev] = fn; },
      onReady: (fn) => { ready = fn; },
    },
  };
  F.install(ctx);
  return { ctx, sent, logs, cmds, handlers, casts, ready: () => ready };
}
const JARGON = /sidecar|within \d+ms|no reply|undefined|\bnull\b|powermode\.\w+|dryRun/i;

(async () => {
  // ---- arguments are checked before anything reaches the sidecar
  let f = fakeCtx();
  for (const bad of [undefined, {}, { mode: 'turbo' }, { mode: 5 }, { mode: 'Balanced' }, { mode: 'balanced; rm' }]) {
    const r = await f.cmds.set(bad);
    check('set refuses ' + JSON.stringify(bad) + ' in plain words, sends nothing', r.ok === false && /not a power mode/.test(r.reason) && f.sent.length === 0, { r, sent: f.sent.length });
  }
  for (const bad of [undefined, { plan: 'balanced please' }, { plan: 42 }, { plan: '381b4222-f694-41f0-9685-ff5bb260df2e; x' }]) {
    const r = await f.cmds.plan(bad);
    check('plan refuses ' + JSON.stringify(bad) + ', sends nothing', r.ok === false && /not a power plan/.test(r.reason) && f.sent.length === 0, { r, sent: f.sent.length });
  }
  // ---- a live instance sends the real set, no dryRun
  let r = await f.cmds.set({ mode: 'performance' });
  check('live: set sends the mode with no dryRun and returns the read-back', f.sent[0].cmd === 'powermode.set' && f.sent[0].args.mode === 'performance' && !('dryRun' in f.sent[0].args) && r.ok === true && r.state.mode === 'performance', f.sent);

  // ---- a --test instance: every write is a dryRun, and the page is told nothing changed
  f = fakeCtx({ test: true });
  r = await f.cmds.set({ mode: 'performance' });
  check('test run: set is sent as a dryRun', f.sent[0].args.dryRun === true, f.sent[0]);
  check('test run: the page hears "not changed" in plain words (not a fake success)', r.ok === false && /test run, so Windows was not changed/.test(r.reason), r);
  r = await f.cmds.set({ mode: 'balanced' });
  check('test run: a same-value set is simply ok', r.ok === true && r.same === true, r);
  r = await f.cmds.plan({ plan: '381b4222-f694-41f0-9685-ff5bb260df2e' });
  check('test run: plan is sent as a dryRun and reported as not changed', f.sent[2].args.dryRun === true && r.ok === false && /test run/.test(r.reason), { sent: f.sent[2], r });

  // ---- the sidecar not answering reaches the page in plain words
  f = fakeCtx({ fail: true });
  r = await f.cmds.get();
  check('get failing: a plain reason, no timeout text', r.ok === false && !JARGON.test(r.reason) && /Windows did not answer/.test(r.reason), r.reason);
  r = await f.cmds.set({ mode: 'efficiency' });
  check('set failing: a plain reason with what to do (try again)', r.ok === false && !JARGON.test(r.reason) && /Try again/.test(r.reason), r.reason);
  check('...and the technical detail goes to the log', f.logs.some((l) => /within 4000ms/.test(l)), f.logs);

  // ---- switched off in the tray: says so, sends nothing
  f = fakeCtx({ enabled: false });
  r = await f.cmds.set({ mode: 'efficiency' });
  check('feature off: set refused with where to turn it on, nothing sent', r.ok === false && /tray menu/.test(r.reason) && f.sent.length === 0, r);
  r = await f.cmds.get();
  check('feature off: get says so', r.ok === false && /tray menu/.test(r.reason), r);

  // ---- the push is relayed without its "ev" key
  f = fakeCtx();
  f.handlers.powermode({ ev: 'powermode', via: 'mode', mode: 'efficiency' });
  check('a sidecar push reaches every page as powermode, without ev', f.casts.length === 1 && f.casts[0][0] === 'powermode' && f.casts[0][1].mode === 'efficiency' && !('ev' in f.casts[0][1]), f.casts);

  for (const x of failures) console.log('  FAIL ' + x);
  console.log('POWERMODE FEATURE TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
