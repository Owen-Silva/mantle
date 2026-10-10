'use strict';
/*
 * widgethide.test.js - lib/features/widgethide.js: the desktop widgets step aside under windows.
 *
 *   node lib/features/widgethide.test.js
 *
 * The pure parts (pane validation, CSS px -> physical pixels at 125% and on a second monitor, the
 * fail-open answer), then install() on a fake ctx: rects -> widgethide.watch with the right areas,
 * the sidecar's pushes -> 'widgethide.cover', the switch off/on, an old helper, a failed check, the
 * helper not ready then ready, a helper restart, no desktop window, an out-of-order reply, stop().
 * Last, the module loads through the real lib/features.js (validate + install + command).
 * No Electron, no sidecar. One summary line; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const W = require('./widgethide');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`  FAIL ${name}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ''}`);
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- pure ------------------------------------------------------------------------------------
function pure() {
  const bad = (a, re, what) => { let m = null; try { W.readPanes(a); } catch (e) { m = e.message; } check(`readPanes: ${what}`, re.test(m || ''), m); };
  bad({}, /needs panes/, 'no panes is refused');
  bad({ panes: Array.from({ length: 17 }, (_, i) => ({ key: 'k' + i, x: 0, y: 0, w: 1, h: 1 })) }, /at most 16/, 'more than 16 is refused');
  bad({ panes: [{ key: 'Bad Key', x: 0, y: 0, w: 1, h: 1 }] }, /short key/, 'a bad key is refused');
  bad({ panes: [{ key: 'clock', x: 'a', y: 0, w: 1, h: 1 }] }, /not a number/, 'a non-number is refused');
  const ok = W.readPanes({ panes: [{ key: 'clock', x: '44', y: 38, w: 420, h: 120, extra: 1 }] });
  check('readPanes: a good pane comes back cleaned', JSON.stringify(ok) === '[{"key":"clock","x":44,"y":38,"w":420,"h":120}]', JSON.stringify(ok));

  const at125 = (r) => ({ x: Math.round(r.x * 1.25), y: Math.round(r.y * 1.25), width: Math.round(r.width * 1.25), height: Math.round(r.height * 1.25) });
  let a = W.toAreas([{ key: 'clock', x: 44, y: 38, w: 420, h: 120 }, { key: 'strip', x: 44, y: 600, w: 0, h: 0 }], { x: 0, y: 0 }, at125);
  check('toAreas: CSS px -> physical at 125%', JSON.stringify(a) === '[{"key":"clock","l":55,"t":48,"r":580,"b":198}]', JSON.stringify(a));
  check('toAreas: a hidden (zero-size) strip is left out', a.length === 1);
  a = W.toAreas([{ key: 'clock', x: 44, y: 38, w: 420, h: 120 }], { x: 1536, y: 0 }, at125);
  check('toAreas: the window origin is added first (a desktop on a monitor to the right)', a[0].l === Math.round((1536 + 44) * 1.25) && a[0].t === 48, JSON.stringify(a));
  a = W.toAreas([{ key: 'clock', x: 1, y: 1, w: 5, h: 5 }], { x: 0, y: 0 }, () => null);
  check('toAreas: a rect the screen cannot convert is left out', a.length === 0);

  let p = W.answer(true, { clock: true, stats: false, junk: 'yes' }, { clock: 'Notepad', stats: null }, null);
  check('answer: only true is covered', p.on && p.covered.clock === true && p.covered.stats === false && p.covered.junk === false && p.by.clock === 'Notepad', JSON.stringify(p));
  p = W.answer(false, { clock: true }, {}, 'off');
  check('answer: off = nothing covered (fail open)', p.on === false && Object.keys(p.covered).length === 0 && p.reason === 'off', JSON.stringify(p));
}

// ---- install on a fake ctx -------------------------------------------------------------------
function fakeCtx(opts) {
  const o = opts || {};
  const sc = new EventEmitter();
  const ctx = {
    on: o.on !== false,
    sent: [], casts: [], health: [], logs: [], cmds: {}, replays: {}, enabledFns: [], readyFns: [],
    reply: o.reply || ((cmd, args) => ({ ok: true, result: { on: args.on, covered: Object.fromEntries((args.areas || []).map((x) => [x.key, x.key === 'clock'])), by: { clock: 'Notepad' } } })),
  };
  ctx.api = {
    enabled: () => ctx.on,
    onEnabled: (fn) => ctx.enabledFns.push(fn),
    broadcast: (ev, p) => ctx.casts.push([ev, JSON.parse(JSON.stringify(p))]),
    replay: (ev, fn) => { ctx.replays[ev] = fn; },
    health: (ok, reason) => ctx.health.push([ok, reason || null]),
    log: (l) => ctx.logs.push(l),
    command: (verb, fn) => { ctx.cmds[verb] = fn; },
    sidecar: {
      ready: o.ready !== false,
      send: async (cmd, args) => { ctx.sent.push([cmd, JSON.parse(JSON.stringify(args || {}))]); return (o.delay ? o.delay(cmd, args) : Promise.resolve()).then(() => ctx.reply(cmd, args)); },
      on: (ev, fn) => sc.on(ev, fn),
      onReady: (fn) => { ctx.readyFns.push(fn); if (ctx.api.sidecar.ready) fn(); },
    },
  };
  ctx.emit = (ev) => sc.emit('widgethide', Object.assign({ ev: 'widgethide' }, ev));
  ctx.last = () => ctx.casts[ctx.casts.length - 1][1];
  return ctx;
}
const DEPS = { origin: () => ({ x: 0, y: 0 }), toScreen: (r) => ({ x: r.x * 2, y: r.y * 2, width: r.width * 2, height: r.height * 2 }) };
const PANES = { panes: [{ key: 'clock', x: 44, y: 38, w: 420, h: 120 }, { key: 'stats', x: 44, y: 174, w: 420, h: 110 }, { key: 'strip', x: 44, y: 300, w: 0, h: 0 }] };

async function installed() {
  // 1. the normal loop
  let c = fakeCtx();
  let inst = W.install(c.api, DEPS);
  await tick();
  check('install: replay answers before the page reports (nothing covered)', c.replays['widgethide.cover'] && Object.keys(c.replays['widgethide.cover']().covered).length === 0);
  let r = await c.cmds.rects(PANES);
  const watch = c.sent.filter((s) => s[0] === 'widgethide.watch').pop();
  check('rects: the sidecar is asked to watch the panes in physical pixels', watch && watch[1].on === true && JSON.stringify(watch[1].areas) === JSON.stringify([{ key: 'clock', l: 88, t: 76, r: 928, b: 316 }, { key: 'stats', l: 88, t: 348, r: 928, b: 568 }]), JSON.stringify(watch));
  check('rects: the answer comes back and is broadcast (clock covered, stats not)', r.on && r.covered.clock === true && r.covered.stats === false && c.last().covered.clock === true && c.casts.slice(-1)[0][0] === 'widgethide.cover', JSON.stringify(r));
  check('rects: healthy', c.health.slice(-1)[0][0] === true, JSON.stringify(c.health));
  check('replay: now answers the latest', c.replays['widgethide.cover']().covered.clock === true);
  c.emit({ covered: { clock: false, stats: true }, by: { stats: 'Code' } });
  check('event: a sidecar push becomes the broadcast', c.last().covered.clock === false && c.last().covered.stats === true && c.last().by.stats === 'Code', JSON.stringify(c.last()));
  c.emit({ error: 'EnumWindows blew up' });
  check('event: a failed check shows every widget and says why', Object.keys(c.last().covered).length === 0 && /EnumWindows blew up/.test(c.last().reason) && c.health.slice(-1)[0][0] === false && /EnumWindows/.test(c.health.slice(-1)[0][1]), JSON.stringify(c.last()));
  c.emit({ covered: { clock: true }, by: {} });
  check('event: the next good push is healthy again', c.health.slice(-1)[0][0] === true && c.last().covered.clock === true);

  // 2. the switch
  c.on = false; c.enabledFns.forEach((fn) => fn(false)); await tick();
  check('off: the sidecar stops watching', c.sent.slice(-1)[0][0] === 'widgethide.watch' && c.sent.slice(-1)[0][1].on === false, JSON.stringify(c.sent.slice(-1)));
  check('off: every widget shows, with the reason', c.last().on === false && Object.keys(c.last().covered).length === 0 && /switched off/.test(c.last().reason), JSON.stringify(c.last()));
  const n = c.casts.length;
  c.emit({ covered: { clock: true }, by: {} });
  check('off: a late push from the sidecar is ignored', c.casts.length === n);
  c.on = true; c.enabledFns.forEach((fn) => fn(true)); await tick(); await tick();
  check('on again: watching the same panes again', c.sent.slice(-1)[0][1].on === true && c.sent.slice(-1)[0][1].areas.length === 2 && c.last().covered.clock === true, JSON.stringify(c.sent.slice(-1)));

  // 3. helper restart re-applies
  const before = c.sent.length;
  c.readyFns.forEach((fn) => fn()); await tick(); await tick();
  check('helper restart: the areas are handed over again', c.sent.length === before + 1 && c.sent.slice(-1)[0][1].areas.length === 2);

  // 4. stop
  inst.stop('test');
  check('stop: watch off and every widget shows', c.sent.slice(-1)[0][1].on === false && c.last().on === false && Object.keys(c.last().covered).length === 0);

  // 5. an old helper
  c = fakeCtx({ reply: () => ({ ok: false, error: 'unknown command: widgethide.watch' }) });
  W.install(c.api, DEPS);
  r = await c.cmds.rects(PANES);
  check('old helper: widgets show, and the reason says the helper is out of date', Object.keys(r.covered).length === 0 && /out of date/.test(r.reason) && c.health.slice(-1)[0][0] === false && /out of date/.test(c.health.slice(-1)[0][1]), JSON.stringify([r, c.health.slice(-1)]));
  c = fakeCtx({ reply: () => ({ ok: false, error: 'the sidecar did not answer in 4000 ms' }) });
  W.install(c.api, DEPS);
  r = await c.cmds.rects(PANES);
  check('a failed watch: widgets show, with the helper\'s own reason', Object.keys(r.covered).length === 0 && /4000 ms/.test(c.health.slice(-1)[0][1]), JSON.stringify(c.health.slice(-1)));

  // 6. helper not ready, then ready
  c = fakeCtx({ ready: false });
  W.install(c.api, DEPS);
  r = await c.cmds.rects(PANES);
  check('helper not ready: no call, widgets show, it says it is waiting', c.sent.length === 0 && /waiting for Mantle's helper/.test(r.reason), JSON.stringify(r));
  c.api.sidecar.ready = true; c.readyFns.forEach((fn) => fn()); await tick(); await tick();
  check('helper ready: the waiting areas are watched', c.sent.length === 1 && c.last().covered.clock === true, JSON.stringify(c.sent));

  // 7. no desktop window
  c = fakeCtx();
  W.install(c.api, Object.assign({}, DEPS, { origin: () => null }));
  r = await c.cmds.rects(PANES);
  check('no desktop window: nothing hidden, health says why', Object.keys(r.covered).length === 0 && c.health.slice(-1)[0][0] === false && /desktop layer is not open/.test(c.health.slice(-1)[0][1]));

  // 8. an older reply that lands after a newer one does not win
  let release = null;
  let first = true;
  c = fakeCtx({
    delay: () => { if (first) { first = false; return new Promise((res) => { release = res; }); } return Promise.resolve(); },
    reply: (cmd, args) => ({ ok: true, result: { covered: { clock: args.areas[0].l === 88 }, by: {} } }),
  });
  W.install(c.api, DEPS);
  const slow = c.cmds.rects(PANES);
  await c.cmds.rects({ panes: [{ key: 'clock', x: 100, y: 38, w: 420, h: 120 }] });
  release(); await slow;
  check('out of order: the newer answer stands (clock not covered at its new spot)', c.last().covered.clock === false, JSON.stringify(c.last()));

  // 9. bad input from the page throws in plain words
  let threw = null;
  try { await c.cmds.rects({ panes: 'x' }); } catch (e) { threw = e.message; }
  check('rects: bad input is refused in plain words', /needs panes/.test(threw || ''), threw);
}

// ---- through the real lib/features.js ------------------------------------------------------
async function throughFeatures() {
  const { createFeatures } = require('../features');
  const { ShellState } = require('../state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-widgethide-'));
  fs.copyFileSync(path.join(__dirname, 'widgethide.js'), path.join(dir, 'widgethide.js'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-widgethide-ud-'));
  const state = new ShellState('test', 'bottom');
  const sidecar = new EventEmitter();
  sidecar.call = async () => ({});
  sidecar.blockedReason = () => null;
  const commands = {};
  const casts = [];
  const f = createFeatures({ dir, test: true, root: path.join(__dirname, '..', '..'), userData, state, sidecar, commands,
    broadcast: (n, p) => casts.push([n, p]), log: () => {}, host: { openLauncher: () => null, barRect: () => null, display: () => ({ id: 1 }) } });
  const up = f.load();
  await new Promise((r) => setTimeout(r, 50));
  const rec = f.list().find((x) => x.name === 'widgethide');
  check('features.js: the module loads and is on by default', up.includes('widgethide') && rec && rec.enabled === true, JSON.stringify(rec));
  check('features.js: its label is the switch text', rec && rec.label === 'Hide desktop widgets under windows', rec && rec.label);
  check('features.js: widgethide.rects and widgethide.get are page commands', typeof commands['widgethide.rects'] === 'function' && typeof commands['widgethide.get'] === 'function', Object.keys(commands).join());
  let threw = null;
  try { await commands['widgethide.rects']({ panes: 7 }); } catch (e) { threw = e.message; }
  check('features.js: a bad call answers in plain words', /needs panes/.test(threw || ''), threw);
  const g = await commands['widgethide.get']();
  check('features.js: get answers nothing covered before any report', g && g.on === true && Object.keys(g.covered).length === 0, JSON.stringify(g));
  try { f.stopAll && f.stopAll('test'); } catch (_) { /* best effort */ }
}

(async () => {
  try {
    pure();
    await installed();
    await throughFeatures();
  } catch (e) {
    failures.push(`  FAIL the run finished (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`);
  }
  console.log(`WIDGETHIDE FEATURE TEST: ${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.join('\n'));
  process.exit(failures.length ? 1 : 0);
})();
