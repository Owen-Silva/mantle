'use strict';
/* toasts-incoming.test.js - the EARLY banner window in lib/features/toasts.js (lane mantle-toastfast,
 * 2026-10-16) on a hand-made ctx, a fake sidecar and a fake BrowserWindow, like toasts.test.js (kept
 * apart so that file's own lanes and this one never edit the same test).
 *
 *   node lib/features/toasts-incoming.test.js   -> "TOASTS INCOMING TEST: n passed, m failed"
 *
 * Pins: host.toasts.onIncoming starts the window BEFORE the list (an app Mantle covers, or an app not
 * known yet); the list's banner then lands on that same window (one make), queued until the page says
 * ready; nothing is started for an app Mantle does not draw for, while Do not disturb says quiet, before
 * access is known, with the switch off, or when the window is already open; a window started early and
 * given no banner is destroyed after PREWARM_MS, said in the log (RAM); a window that fails to start is
 * logged and the list still makes one; a host with no onIncoming is said once and banners still work;
 * stop() drops the subscription.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-toasts-incoming-'));
class FakeWin {
  constructor(o) {
    if (FakeWin.throwNext) { FakeWin.throwNext = false; throw new Error('no GPU process'); }
    FakeWin.made.push(this);
    this.o = o; this.destroyed = false; this.visible = false; this.bounds = [{ x: o.x, y: o.y, width: o.width, height: o.height }];
    const self = this;
    this.wcOn = {};
    this.webContents = { on(ev, fn) { (self.wcOn[ev] = self.wcOn[ev] || []).push(fn); }, setWindowOpenHandler() {}, getOSProcessId() { return 4242; } };
    this.winOn = {};
  }
  on(ev, fn) { (this.winOn[ev] = this.winOn[ev] || []).push(fn); }
  loadFile(f) { this.page = f; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; (this.winOn.closed || []).forEach((fn) => fn()); }
  setAlwaysOnTop() {}
  setBounds(b) { this.bounds.push(b); }
  getBounds() { return this.bounds[this.bounds.length - 1]; }
  isVisible() { return this.visible; }
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(77n); return b; }
  getBackgroundColor() { return this.o.backgroundColor; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
}
FakeWin.made = [];
const DISPLAY = { workArea: { x: 0, y: 32, width: 1536, height: 800 }, scaleFactor: 1.25 };
const load = Module._load;
Module._load = function (req) {
  if (req === 'electron') {
    return {
      BrowserWindow: FakeWin,
      screen: { getPrimaryDisplay: () => DISPLAY, getDisplayMatching: () => DISPLAY, on() {}, removeListener() {} },
      app: { getPath: () => USER_DATA, getAppMetrics: () => [] },
    };
  }
  if (req === '../bar-shape') return { apply: () => ({ ok: true, reason: null }), verify: () => ({ ok: true, reason: null }), readBack: () => ({ ok: true, box: null }) };
  if (req === '../raise') return { up() {} };
  return load.apply(this, arguments);
};
const feature = require('./toasts.js');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

function makeCtx(opts) {
  const o = opts || {};
  const t = { logs: [], cmds: {}, pushes: [], enabledFns: [], ready: [], enabled: true, quiet: { ok: true, dnd: 0, quns: 5 }, listFns: [], inFns: [], quietAsks: 0,
    reg: { 'com.example.chat': { banner: 1, enabled: 1 }, 'com.example.muted': { banner: undefined, enabled: 0 } } };
  const toasts = {
    onList: (fn) => { t.listFns.push(fn); return () => { t.listFns = t.listFns.filter((x) => x !== fn); }; },
    last: () => null, targetFor: () => null, focus: async () => ({ ok: true }), open: async () => ({ ok: true }), openList: () => ({ ok: true }),
  };
  if (o.incoming !== false) toasts.onIncoming = (fn) => { t.inFns.push(fn); return () => { t.inFns = t.inFns.filter((x) => x !== fn); }; };
  t.ctx = {
    name: 'toasts', flags: { test: false }, preload: 'preload.js',
    log: (s) => t.logs.push(s),
    sidecar: {
      ready: true,
      async send(cmd, args) {
        if (cmd === 'toasts.banners' && args.op === 'read') {
          return { ok: true, result: { ok: true, reason: null, apps: Object.keys(t.reg).map((k) => ({ aumid: k, banner: t.reg[k].banner === undefined ? null : t.reg[k].banner, enabled: t.reg[k].enabled, odd: false })) } };
        }
        if (cmd === 'toasts.banners' && args.op === 'write') {
          return { ok: true, result: { ok: true, reason: null, results: args.set.map((s) => { t.reg[s.aumid].banner = s.value === null ? undefined : s.value; return { aumid: s.aumid, ok: true, now: s.value, reason: null }; }) } };
        }
        if (cmd === 'toasts.quiet') { t.quietAsks++; return { ok: true, result: t.quiet }; }
        return { ok: false, error: `unknown command ${cmd}` };
      },
      onReady(fn) { t.ready.push(fn); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; },
    health() {},
    enabled: () => t.enabled,
    onEnabled(fn) { t.enabledFns.push(fn); },
    page: (f) => `ui/toasts/${f}`,
    push(win, event, payload) { t.pushes.push({ win, event, payload }); return true; },
    host: { barRect: () => null, toasts },
  };
  let nextId = 100;
  t.toasts = [{ id: 1, aumid: 'com.example.chat', app: 'Chat', title: 'old', body: 'already there', timeMs: Date.now() - 1000 }];
  t.post = (aumid, title) => { const x = { id: nextId++, aumid, app: aumid.split('.').pop(), title, body: 'hello', timeMs: Date.now() }; t.toasts.push(x); return x; };
  t.list = async () => { const p = { ok: true, access: 'Allowed', available: true, toasts: t.toasts.slice() }; for (const fn of t.listFns) fn(p); await tick(60); };
  t.coming = async (aumid) => { for (const fn of t.inFns) fn({ aumid: aumid === undefined ? null : aumid, rev: 1, at: Date.now() }); await tick(30); };
  t.shows = () => t.pushes.filter((p) => p.event === 'toasts.show');
  t.live = () => FakeWin.made.filter((w) => !w.destroyed);
  return t;
}

(async () => {
  const t = makeCtx();
  const inst = feature.install(t.ctx);
  await tick();
  check('install subscribes to host.toasts.onIncoming and makes no window up front', t.inFns.length === 1 && FakeWin.made.length === 0, { inFns: t.inFns.length, made: FakeWin.made.length });

  // before any list: access not known, nothing is started
  await t.coming('com.example.chat');
  check('coming before access is known starts nothing', FakeWin.made.length === 0, FakeWin.made.length);

  // the first list says Allowed: chat is taken
  t.ready.forEach((fn) => fn()); await tick(30);
  await t.list(); await tick(900);   // the owner's apply is debounced (APPLY_DEBOUNCE_MS 800)
  check('setup: chat is covered after the first Allowed list', t.reg['com.example.chat'].banner === 0, t.reg);

  // ---- coming for a covered app: the window starts BEFORE the list
  await t.coming('com.example.chat');
  check('coming for a covered app: the window is started before the list arrives', FakeWin.made.length === 1 && t.live().length === 1 && t.shows().length === 0, FakeWin.made.length);
  check('... after asking whether Windows is quiet (no window during Do not disturb or a full-screen app)', t.quietAsks >= 1, t.quietAsks);
  const w1 = FakeWin.made[0];
  const x = t.post('com.example.chat', 'hi');
  await t.list();
  check('the list\'s banner lands on that same window (one make), queued until the page is ready', FakeWin.made.length === 1 && t.shows().length === 0, { made: FakeWin.made.length, shows: t.shows().length });
  await t.cmds.ready();
  check('... and goes up when the page says ready', t.shows().length === 1 && t.shows()[0].win === w1 && t.shows()[0].payload.banners[0].id === x.id, t.shows().map((s) => s.payload));
  await t.cmds.layout({ h: 120, count: 1 });

  // ---- already open: coming starts nothing new
  await t.coming('com.example.chat');
  check('coming while the window is open starts nothing new', FakeWin.made.length === 1, FakeWin.made.length);
  w1.destroy();   // the idle close, quickly

  // ---- apps Mantle does not draw for, quiet, switched off
  await t.coming('com.example.muted');
  await t.coming('Some.Other.App');
  check('coming for an app Mantle does not cover starts nothing', FakeWin.made.length === 1, FakeWin.made.length);
  t.quiet = { ok: true, dnd: 1, quns: 5 };
  await t.coming('com.example.chat');
  check('coming during Do not disturb starts nothing', FakeWin.made.length === 1, FakeWin.made.length);
  t.quiet = { ok: true, dnd: 0, quns: 5 };
  t.enabled = false;
  await t.coming('com.example.chat');
  check('coming with the switch off starts nothing', FakeWin.made.length === 1, FakeWin.made.length);
  t.enabled = true;

  // ---- an app not known yet (aumid null): started; no banner comes -> destroyed after PREWARM_MS, said
  await t.coming(null);
  check('coming with the app not known starts the window', FakeWin.made.length === 2 && t.live().length === 1, FakeWin.made.length);
  await t.cmds.ready();
  await t.cmds.layout({ h: 0, count: 0 });   // the page's empty first layout
  await tick(5300);
  const w2 = FakeWin.made[1];
  check('a window started early that gets no banner is destroyed after PREWARM_MS (RAM), not after the 30 s idle close',
    w2.destroyed === true && t.logs.some((l) => /the banner window closed \(it was started for an incoming notification and no banner came within 5 s\)/.test(l)), t.logs.slice(-3));

  // ---- the early window fails to start: logged, and the list still makes one
  FakeWin.throwNext = true;
  await t.coming('com.example.chat');
  check('an early window that fails to start is logged with what happens instead', t.logs.some((l) => /the early banner window failed \(no GPU process\); the banner makes it when the list comes/.test(l)) && FakeWin.made.length === 2, t.logs.slice(-2));
  t.post('com.example.chat', 'after the failure');
  await t.list();
  check('... and the list then makes the window as before', FakeWin.made.length === 3 && t.live().length === 1, FakeWin.made.length);

  // ---- stop() drops the subscription
  inst.stop('the test ended');
  await tick(50);
  check('stop() unsubscribes from onIncoming', t.inFns.length === 0, t.inFns.length);

  // ---- a host with no onIncoming: said once, banners still work
  FakeWin.made.length = 0;
  const t2 = makeCtx({ incoming: false });
  const inst2 = feature.install(t2.ctx);
  await tick();
  check('a host with no onIncoming is said in the log (no silent slow path)', t2.logs.some((l) => /no early "notification coming" signal from this Mantle: banners start their window when the list comes/.test(l)), t2.logs);
  t2.ready.forEach((fn) => fn()); await tick(30);
  await t2.list(); await tick(900);
  t2.post('com.example.chat', 'old path');
  await t2.list();
  check('... and a banner still makes its window from the list', FakeWin.made.length === 1, FakeWin.made.length);
  inst2.stop('the test ended');
  await tick(50);

  fs.rmSync(USER_DATA, { recursive: true, force: true });
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TOASTS INCOMING TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('TOASTS INCOMING TEST: 0 passed, 1 failed'); console.log('  FAIL the test threw: ' + (e.stack || e.message)); process.exit(1); });
