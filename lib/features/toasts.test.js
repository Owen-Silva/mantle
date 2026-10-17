'use strict';
/* toasts.test.js - lib/features/toasts.js itself on a hand-made ctx, a fake sidecar (a fake registry
 * behind toasts.banners / toasts.quiet) and a fake BrowserWindow (lane mantle-toasts2, 2026-10-15).
 * The owner (_toasts-owner.js) and the picker (_toasts-core.js) are the REAL modules; their own rules
 * are in _toasts-owner.test.js / _toasts-core.test.js. What this file pins is the feature's wiring:
 *   - nothing is taken until a list has said access is "Allowed"; then every coverable app is taken
 *     (Windows' own apps, notifications-off apps and Owen's own banner-off are not);
 *   - NO WINDOW until a banner: made on the first toast, its banner queued until the page says ready,
 *     a column at the bottom right (above the bar's resting shape, an open pop-up and the screenshot card,
 *     lib/corner.js), SHAPED to the stack (sized to it if the shape does not stick), see-through with no
 *     shadow, closed IDLE_CLOSE_MS after the last banner went (RAM);
 *   - an app Mantle does not cover gets no Mantle banner (Windows keeps showing its own);
 *   - Do not disturb: no banner, and state says why;
 *   - access lost: health(false) with the reason, every original put back, state carries the fix URI;
 *   - the switch off and stop(): window gone, every original back (1 back to 1, "no value" deleted);
 *   - a game rest keeps Windows' banners off (the toasts wait in the list) but closes the window;
 *   - toasts.debug exists only in a --test instance.
 *   node lib/features/toasts.test.js   -> "TOASTS FEATURE TEST: n passed, m failed"
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-toasts-unit-'));
class FakeWin {
  constructor(o) {
    FakeWin.made.push(this);
    this.o = o; this.destroyed = false; this.visible = false; this.bounds = [{ x: o.x, y: o.y, width: o.width, height: o.height }]; this.page = null; this.onTop = []; this.shapes = [];
    const self = this;
    this.wcOn = {};
    this.webContents = { on(ev, fn) { (self.wcOn[ev] = self.wcOn[ev] || []).push(fn); }, setWindowOpenHandler() {}, getOSProcessId() { return 4242; } };
    this.winOn = {};
  }
  on(ev, fn) { (this.winOn[ev] = this.winOn[ev] || []).push(fn); }
  loadFile(f) { this.page = f; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; (this.winOn.closed || []).forEach((fn) => fn()); }
  setAlwaysOnTop(on, level) { this.onTop.push(level); }
  setBounds(b) { this.bounds.push(b); }
  getBounds() { return this.bounds[this.bounds.length - 1] || { x: 0, y: 0, width: 0, height: 0 }; }
  isVisible() { return this.visible; }
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(77n); return b; }
  getBackgroundColor() { return this.o.backgroundColor; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
}
FakeWin.made = [];
const DISPLAY = { workArea: { x: 0, y: 32, width: 1536, height: 800 }, scaleFactor: 1.25 };
const SHAPE = { verify: { ok: true, reason: null }, applied: [] };
const fakeShape = {
  apply(w, rect) { w.shapes.push(rect); SHAPE.applied.push(rect); return { ok: true, reason: null }; },
  verify() { return SHAPE.verify; },
  readBack() { return { ok: true, box: null }; },
};
const fakeElectron = {
  BrowserWindow: FakeWin,
  screen: { getPrimaryDisplay: () => DISPLAY, getDisplayMatching: () => DISPLAY, on() {}, removeListener() {} },
  app: { getPath: () => USER_DATA, getAppMetrics: () => [{ pid: 4242, memory: { workingSetSize: 51200, privateBytes: 20480 } }] },
};
const raised = [];
const load = Module._load;
Module._load = function (req) {
  if (req === 'electron') return fakeElectron;
  if (req === '../bar-shape') return fakeShape;
  if (req === '../raise') return { up: (w, o) => { raised.push(o && o.what); } };
  return load.apply(this, arguments);
};
const feature = require('./toasts.js');
const corner = require('../corner');
const RECORD = path.join(USER_DATA, 'notif-banners.json');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

/* The registry Windows would have: ShowBanner per app (undefined = no value). */
function makeReg() {
  return {
    'com.example.chat': { banner: 1, enabled: 1 },
    'com.example.mail': { banner: undefined, enabled: 1 },
    'com.example.muted': { banner: undefined, enabled: 0 },          // notifications off: never taken
    'com.example.quietbyowen': { banner: 0, enabled: 1 },           // Owen's own banner-off: never taken
    'Windows.SystemToast.AutoPlay': { banner: undefined, enabled: 1 }, // Windows' own: left to Windows
  };
}

function makeCtx(opts) {
  const o = opts || {};
  const t = { logs: [], health: [], cmds: {}, pushes: [], enabledFns: [], ready: [], enabled: o.enabled !== false, reg: makeReg(), writes: [], quiet: { ok: true, dnd: 0, quns: 5 }, listFns: [], opened: [], lists: 0 };
  t.barUp = o.barUp === true; t.barFns = [];   // lane mantle-corner: the bar starts hidden, as in hover mode
  t.ctx = {
    name: 'toasts', flags: { test: !!o.test }, preload: 'preload.js',
    log: (s) => t.logs.push(s),
    sidecar: {
      ready: true,
      async send(cmd, args) {
        if (cmd === 'toasts.banners' && args.op === 'read') {
          return { ok: true, result: { ok: true, reason: null, apps: Object.keys(t.reg).map((k) => ({ aumid: k, banner: t.reg[k].banner === undefined ? null : t.reg[k].banner, enabled: t.reg[k].enabled, odd: false })) } };
        }
        if (cmd === 'toasts.banners' && args.op === 'write') {
          t.writes.push(args.set);
          const results = args.set.map((s) => {
            const a = t.reg[s.aumid];
            if (!a) return { aumid: s.aumid, ok: false, now: null, reason: 'no such app' };
            a.banner = s.value === null ? undefined : s.value;
            return { aumid: s.aumid, ok: true, now: a.banner === undefined ? null : a.banner, reason: null };
          });
          return { ok: true, result: { ok: true, reason: null, results } };
        }
        if (cmd === 'toasts.quiet') return { ok: true, result: t.quiet };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      onReady(fn) { t.ready.push(fn); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; },
    health(ok, reason) { t.health.push({ ok, reason }); },
    enabled: () => t.enabled,
    onEnabled(fn) { t.enabledFns.push(fn); },
    page: (f) => `ui/toasts/${f}`,
    push(win, event, payload) { t.pushes.push({ win, event, payload }); return true; },
    host: {
      barRect: () => t.bar || null,
      // lane mantle-corner: the bar's state and its motion, driven by the test (t.barMove)
      bar: { up: () => t.barUp, onMotion: (fn) => { t.barFns.push(fn); return () => { t.barFns = t.barFns.filter((x) => x !== fn); }; } },
      toasts: {
        onList: (fn) => { t.listFns.push(fn); return () => { t.listFns = t.listFns.filter((x) => x !== fn); }; },
        last: () => null,
        targetFor: () => null,
        focus: async () => ({ ok: true }),
        open: async (id) => { t.opened.push(id); return { ok: true }; },
        openList: () => { t.opened.push('list'); return { ok: true }; },
      },
    },
  };
  let nextId = 100;
  t.toasts = [{ id: 1, aumid: 'com.example.chat', app: 'Chat', title: 'old', body: 'already there', timeMs: Date.now() - 1000 }];
  t.post = (aumid, title) => { const x = { id: nextId++, aumid, app: aumid.split('.').pop(), title, body: 'hello', timeMs: Date.now() }; t.toasts.push(x); return x; };
  t.list = async (extra) => { t.lists++; const p = Object.assign({ ok: true, access: 'Allowed', available: true, toasts: t.toasts.slice() }, extra || {}); for (const fn of t.listFns) fn(p); await tick(60); };
  t.lastH = () => t.health[t.health.length - 1] || {};
  t.barMove = (up, ms) => { t.barUp = up; for (const fn of t.barFns) fn({ up, ms, why: 'the test' }); };
  t.lifts = () => t.pushes.filter((p) => p.event === 'toasts.lift').map((p) => p.payload);
  t.shows = () => t.pushes.filter((p) => p.event === 'toasts.show');
  return t;
}

(async () => {
  try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
  const t = makeCtx();
  const inst = feature.install(t.ctx);
  await tick();
  check('meta: name toasts, on by default, no chords, rests for a game', feature.name === 'toasts' && feature.defaultOn === true && feature.chords.length === 0 && feature.rest === true);
  check('install: no banner window is made up front (RAM)', FakeWin.made.length === 0, FakeWin.made.length);
  check('install: debug is a test-only command (absent in a live instance)', !t.cmds.debug && !t.cmds.apply && !t.cmds.testShow && !t.cmds.testReveal && typeof t.cmds.state === 'function');
  t.ready.forEach((fn) => fn()); await tick(40);
  check('the sidecar starting with access not yet known writes nothing', t.writes.length === 0, t.writes);
  let st = await t.cmds.state();
  check('state before any list: on, access not known, nothing covered', st.ok && st.on === true && st.covered === 0 && st.fixUri === 'ms-settings:privacy-notifications', st);

  // ---- the first list says Allowed: every coverable app is taken
  await t.list();
  await tick(60);
  const took = (t.writes[0] || []).map((s) => s.aumid).sort();
  check('access Allowed: chat and mail are taken (ShowBanner 0), nothing else', JSON.stringify(took) === JSON.stringify(['com.example.chat', 'com.example.mail']) && t.writes[0].every((s) => s.value === 0), t.writes);
  check('... Windows\' own app, a notifications-off app and Owen\'s own banner-off are left alone',
    t.reg['Windows.SystemToast.AutoPlay'].banner === undefined && t.reg['com.example.muted'].banner === undefined && t.reg['com.example.quietbyowen'].banner === 0);
  let rec = null; try { rec = JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) { /* none */ }
  check('the record keeps each original (chat 1, mail null = no value)', rec && rec.owned['com.example.chat'] === 1 && rec.owned['com.example.mail'] === null, rec);
  check('the first list is the baseline: the toast already there gets no banner, no window', t.shows().length === 0 && FakeWin.made.length === 0);
  st = await t.cmds.state();
  check('state: on, access ok, 2 apps covered, no reason', st.on && st.accessOk && st.covered === 2 && !st.reason && st.access === 'Allowed', st);
  check('health is ok', t.lastH().ok === true, t.lastH());

  // ---- a new toast from a covered app: the window is made, the banner waits for the page
  t.post('com.example.chat', 'Lunch?');
  await t.list();
  check('a covered app\'s toast makes the banner window (one)', FakeWin.made.length === 1, FakeWin.made.length);
  const w = FakeWin.made[0];
  check('... hidden at first, frameless, transparent, not focusable, no taskbar button, the toasts page',
    w && w.o.show === false && w.o.frame === false && w.o.transparent === true && w.o.focusable === false && w.o.skipTaskbar === true && /ui\/toasts\/index\.html$/.test(w.page), w && w.o);
  check('... sandboxed with the preload, no node', w && w.o.webPreferences.sandbox === true && w.o.webPreferences.nodeIntegration === false && w.o.webPreferences.preload === 'preload.js');
  check('... the banner is not pushed before the page is ready', t.shows().length === 0);
  const r = await t.cmds.ready();
  const sh = t.shows();
  check('ready: the queued banner goes up, with its title and app', r.ok && sh.length === 1 && sh[0].payload.banners.length === 1 && sh[0].payload.banners[0].title === 'Lunch?' && sh[0].payload.banners[0].aumid === 'com.example.chat', sh.map((x) => x.payload));
  await t.cmds.layout({ h: 120, count: 1 });
  const b = w.getBounds();
  const raisedAtFirst = raised.length;   // 1: the first layout showed it; the block below hides it once and shows it again
  check('layout: shown at once and raised (before the corner moves below)', w.visible === true && raisedAtFirst === 1, raised);
  // the work area is 0,32 1536x800: its bottom is 832; the column runs from 8 under its top (40) down to it
  check('layout: a column at the bottom right, 392 wide, from 40 down to the corner (832)', b.x === 1536 - 392 && b.y === 40 && b.width === 392 && b.height === 792, b);
  const shp = w.shapes[w.shapes.length - 1];
  check('layout: SHAPED to the stack at its bottom: 392 x the 120 the page asked for', shp && shp.x === 0 && shp.y === 792 - 120 && shp.width === 392 && shp.height === 120, w.shapes);
  check('the window is see-through with no shadow, frame or material (the dark square was the CSS shadow, not this)',
    w.o.transparent === true && w.o.backgroundColor === '#00000000' && w.o.hasShadow === false && w.o.thickFrame === false && w.o.frame === false
    && w.o.backgroundMaterial === undefined && w.o.vibrancy === undefined, w.o);
  // the screenshot card comes up in the corner: the column ends above it, at its real bounds; the window MOVES, the shape follows
  const nb = w.bounds.length;
  corner.set('the screenshot card', { x: 1536 - 300, y: 832 - 110, width: 300, height: 110 });
  let b2 = w.getBounds(), sh2 = w.shapes[w.shapes.length - 1];
  check('screenshot card up: the banners sit just above it (column ends at 722): the window MOVES up, same 792 height (no re-layout), still shaped to 120', b2.height === 792 && b2.y + b2.height === 722 && sh2.y === 792 - 120 && sh2.height === 120 && w.bounds.length === nb + 1, { b2, sh2 });
  check('... and the log says why they moved', t.logs.some((l) => /banners moved: the screenshot card is up/.test(l)), t.logs.slice(-3));
  corner.set('the screenshot card', { x: 1536 - 260, y: 832 - 96, width: 260, height: 96 });
  check('... a smaller card = they sit lower (its real size, nothing hard-coded)', w.getBounds().y + w.getBounds().height === 736, w.getBounds());
  corner.set('the screenshot card', null);
  check('card gone: back down to the corner', w.getBounds().y + w.getBounds().height === 832, w.getBounds());
  // ---- IN THE CORNER, GLIDING WITH THE BAR (lane mantle-corner, 2026-10-16)
  // the bar's resting pill reaches the corner, but the bar is HIDDEN: the banners stay in the corner
  t.bar = { x: 208, y: 770, width: 1120, height: 62 };
  corner.changed('a bar pop-up closed');
  const nb0 = w.bounds.length, raisedGlide = raised.length;
  let shp0 = w.shapes[w.shapes.length - 1];
  check('bar hidden: in the corner (the column ends at 832, not above the bar\'s resting top 770)', w.getBounds().y + w.getBounds().height === 832 && shp0.y === 792 - 120 && shp0.height === 120, { b: w.getBounds(), shp0 });
  // the bar comes up: the WINDOW does not move; the page is told to lift the stack 62 DIP on the bar's spring
  t.barMove(true, 560);
  let lf = t.lifts().pop(), shp1 = w.shapes[w.shapes.length - 1];
  check('bar up: the page lifts the stack 62 DIP (832 - 770) on the bar\'s spring, AHEAD of it (0.6 of its 560 ms = 336: never behind the pill)', lf && lf.px === 62 && lf.kind === 'up' && lf.ms === 336, lf);
  check('... the window does not move (no setBounds) and stays in the corner', w.bounds.length === nb0 && w.getBounds().y + w.getBounds().height === 832, w.bounds.slice(nb0));
  check('... while it glides the shape covers the whole way (120 + 62 tall, from 62 above the stack\'s rest)', shp1.y === 792 - 120 - 62 && shp1.height === 182, shp1);
  await tick(560 + 60 + 40);
  let shp2 = w.shapes[w.shapes.length - 1];
  check('... and narrows to the stack where it rests once the glide is over (never cuts it mid-glide)', shp2.y === 792 - 120 - 62 && shp2.height === 120, shp2);
  // the bar goes: back to the corner with the bar's exit (main says 320, the bar's page runs 240)
  t.barMove(false, 320);
  lf = t.lifts().pop();
  const shp3 = w.shapes[w.shapes.length - 1];
  check('bar down: back to the corner (lift 0) on the bar\'s exit curve, BEHIND it (the 240 ms its page runs + 60 = 300: never ahead of the pill)', lf && lf.px === 0 && lf.kind === 'down' && lf.ms === 300, lf);
  check('... the shape spans both places while it goes', shp3.y === 792 - 120 - 62 && shp3.height === 182, shp3);
  await tick(300 + 60 + 40);
  const shp4 = w.shapes[w.shapes.length - 1];
  check('... settled in the corner', shp4.y === 792 - 120 && shp4.height === 120, shp4);
  // a banner ARRIVING while the bar is going and nothing was up: it starts where the bar was, goes down with it
  t.barMove(true, 560); await tick(560 + 60 + 40);
  await t.cmds.layout({ h: 0, count: 0 });   // the banner went; the window idles
  t.barMove(false, 320);
  const lfIdle = t.lifts().pop();
  check('nothing on screen while the bar goes: the stack just stands in the corner (no glide to run)', lfIdle.px === 0 && lfIdle.ms === 0, lfIdle);
  const nl = t.lifts().length;
  t.post('com.example.chat', 'Arrived mid-hide');
  await t.list();
  const re = t.lifts().slice(nl);
  check('a banner arriving mid-way through the bar going: starts at 62, goes down over what is left of the exit (never onto the pill)', re.length === 2 && re[0].px === 62 && re[0].ms === 0 && re[1].px === 0 && re[1].kind === 'down' && re[1].ms > 0 && re[1].ms <= 300, re);
  const shpC = w.shapes[w.shapes.length - 1];
  await t.cmds.layout({ h: 120, count: 1 });
  const shpC2 = w.shapes[w.shapes.length - 1];
  check('... the shape spans its way down', shpC2.y === 792 - 120 - 62 && shpC2.height === 182, { shpC, shpC2 });
  await tick(300 + 60 + 40);
  check('... and settles in the corner', w.shapes[w.shapes.length - 1].y === 792 - 120 && w.shapes[w.shapes.length - 1].height === 120, w.shapes[w.shapes.length - 1]);
  t.pushes = t.pushes.filter((p) => !(p.event === 'toasts.show' && p.payload.banners.some((b) => b.title === 'Arrived mid-hide')));   // the later counts are of their own banners
  // rapid toggles: up, down after 80 ms, up after 60 more: the shape covers every place in between until the LAST glide ends
  t.barMove(true, 560); await tick(80); t.barMove(false, 320); await tick(60); t.barMove(true, 560);
  lf = t.lifts().pop();
  const shp5 = w.shapes[w.shapes.length - 1];
  check('rapid toggles: aimed at the last state (up, 62), the shape spans 0..62 the whole time', lf.px === 62 && lf.kind === 'up' && shp5.y === 792 - 120 - 62 && shp5.height === 182, { lf, shp5 });
  await tick(300);
  check('... not narrowed before the last glide is over (300 ms into its 336)', w.shapes[w.shapes.length - 1].height === 182, w.shapes[w.shapes.length - 1]);
  await tick(260);
  check('... then narrowed to the stack above the bar', w.shapes[w.shapes.length - 1].y === 792 - 120 - 62 && w.shapes[w.shapes.length - 1].height === 120, w.shapes[w.shapes.length - 1]);
  check('the glides never re-raise the window (no z-order churn each time the bar moves): the one raise is the layout that brought the mid-hide banner back on screen', raised.length === raisedGlide + 1, raised.length - raisedGlide);
  // a second banner while the bar is up: the stack grows from where it rests (above the bar), not from the corner
  await t.cmds.layout({ h: 250, count: 2 });
  const shp6 = w.shapes[w.shapes.length - 1];
  check('two banners with the bar up: the shape is both, still above the bar', shp6.y === 792 - 250 - 62 && shp6.height === 250, shp6);
  await t.cmds.layout({ h: 120, count: 1 });
  const extraRaises = raised.length - raisedGlide;   // each layout with banners raises it (as before this lane)
  // with the bar up, the old resting place: above its resting top
  check('bar up and resting: the stack ends at 770 on screen (window bottom 832 minus the 62 lift)', w.getBounds().y + w.getBounds().height - 62 === 770, w.getBounds());
  t.bar = { x: 208, y: 770 - 600, width: 1120, height: 662 };   // only 130 DIP left above it
  corner.changed('a bar pop-up opened (bell)');
  check('a pop-up taller than the room left: held back (hidden), with the reason in the log', w.visible === false && t.logs.some((l) => /banners held back: only \d+ DIP left above the bar/.test(l)), t.logs.slice(-2));
  t.bar = null;
  t.barMove(false, 320);
  corner.changed('a bar pop-up closed');
  check('... and back on screen when it closes', w.visible === true && w.getBounds().y + w.getBounds().height === 832 && t.logs.some((l) => /banners back/.test(l)), { v: w.visible, b: w.getBounds() });
  check('layout: shown without taking focus, and raised', w.visible === true && raised.length === raisedAtFirst + 1 + extraRaises && w.visible, { visible: w.visible, raised, raisedAtFirst });
  check('live: always on top at screen-saver level', w.o.alwaysOnTop === true && w.onTop.includes('screen-saver'), w.onTop);

  // ---- an app Mantle does not cover
  t.post('Windows.SystemToast.AutoPlay', 'USB drive');
  await t.list();
  check('an app left to Windows gets no Mantle banner', t.shows().length === 1, t.shows().length);
  const ids = t.pushes.filter((p) => p.event === 'toasts.ids').pop();
  check('... but the page hears the new id list (a banner whose toast went away goes too)', ids && ids.payload.ids.length === t.toasts.length, ids && ids.payload);

  // ---- Do not disturb
  t.quiet = { ok: true, dnd: 1, quns: 5 };
  t.post('com.example.mail', 'Quiet one');
  await t.list();
  st = await t.cmds.state();
  check('Do not disturb: no banner, state says why', t.shows().length === 1 && /Do not disturb is on/.test(st.quiet || ''), st.quiet);
  t.quiet = { ok: true, dnd: 0, quns: 5 };
  t.post('com.example.mail', 'Loud one');
  await t.list();
  check('Do not disturb off again: the next toast is a banner', t.shows().length === 2 && t.shows()[1].payload.banners[0].title === 'Loud one');
  st = await t.cmds.state();
  check('... and state no longer carries a quiet reason', st.quiet === null, st.quiet);

  // ---- click: no window for the app, no link -> the list opens
  const c = await t.cmds.click({ id: 7, banner: { aumid: 'com.example.mail', opens: null } });
  check('click with no app window: Mantle\'s list opens', c.ok && c.act === 'list' && t.opened.includes('list'), c);
  const c2 = await t.cmds.click({ id: 'x' });
  check('click on an unknown banner is refused with a reason', c2.ok === false && !!c2.reason, c2);

  // ---- the last banner goes: hidden, then closed IDLE_CLOSE_MS later (shortened here)
  const realST = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 30000 ? 30 : ms, ...a);
  try {
    await t.cmds.layout({ h: 1, count: 0 });
    check('no banner left: the window hides at once', w.visible === false && !w.destroyed);
    await tick(80);
    check('... and is DESTROYED after the idle wait (no window kept in the background)', w.destroyed === true, w.destroyed);
  } finally { global.setTimeout = realST; }
  t.post('com.example.chat', 'Again');
  await t.list();
  check('the next banner makes a fresh window', FakeWin.made.length === 2 && !FakeWin.made[1].destroyed, FakeWin.made.length);
  const lay = await t.cmds.layout({ h: 100, count: 1 });
  check('layout before the new page is ready still places it', lay.ok === true, lay);

  // ---- access lost: originals back, health says why, state carries the fix
  await t.list({ access: 'Denied' });
  await tick(60);
  st = await t.cmds.state();
  check('access lost: health(false) with the reason', t.lastH().ok === false && /not letting Mantle read notifications/.test(t.lastH().reason || ''), t.lastH());
  check('... every original is back (chat 1, mail no value)', t.reg['com.example.chat'].banner === 1 && t.reg['com.example.mail'].banner === undefined, t.reg);
  check('... state: accessOk false, the reason, the fix URI, nothing covered', st.accessOk === false && /Privacy > Notifications/.test(st.accessWhy || '') && st.fixUri === 'ms-settings:privacy-notifications' && st.covered === 0 && st.reason === st.accessWhy, st);
  const before = t.shows().length;
  t.post('com.example.chat', 'While denied');
  await t.list({ access: 'Denied' });
  check('... and no Mantle banner while access is denied (Windows shows its own)', t.shows().length === before);
  await t.list();
  await tick(60);
  check('access back: taken again', t.reg['com.example.chat'].banner === 0 && t.reg['com.example.mail'].banner === 0, t.reg);
  check('... health ok again', t.lastH().ok === true, t.lastH());

  // ---- the switch off: window gone, originals back; on: taken again
  t.enabled = false;
  for (const fn of t.enabledFns) fn(false);
  await tick(80);
  check('switch off: the window is destroyed', FakeWin.made.every((x) => x.destroyed), FakeWin.made.map((x) => x.destroyed));
  check('switch off: every original back', t.reg['com.example.chat'].banner === 1 && t.reg['com.example.mail'].banner === undefined, t.reg);
  st = await t.cmds.state();
  check('switch off: state on:false', st.on === false && st.covered === 0, st);
  const made = FakeWin.made.length;
  t.post('com.example.chat', 'Off');
  await t.list();
  check('switch off: a toast makes no window', FakeWin.made.length === made);
  t.enabled = true;
  for (const fn of t.enabledFns) fn(true);
  await tick(80);
  check('switch on: taken again', t.reg['com.example.chat'].banner === 0 && t.reg['com.example.mail'].banner === 0, t.reg);

  // ---- a game rest: window closed, Windows' banners stay off
  t.post('com.example.chat', 'Before rest');
  await t.list();
  const restWin = FakeWin.made[FakeWin.made.length - 1];
  const rr = inst.stop('a game', { rest: true });
  await tick(40);
  check('a game rest closes the window but keeps Windows\' banners off (the toasts wait in the list)',
    rr === undefined && restWin.destroyed && t.reg['com.example.chat'].banner === 0, { destroyed: restWin.destroyed, chat: t.reg['com.example.chat'].banner });

  // ---- a full stop (quit) puts everything back
  const t2 = makeCtx();
  const inst2 = feature.install(t2.ctx);
  t2.reg = t.reg;   // the same "registry" the first instance left
  t2.ready.forEach((fn) => fn());
  await t2.list();
  await tick(60);
  await inst2.stop('Mantle stopped');
  check('stop(): every original back (chat 1, mail no value)', t.reg['com.example.chat'].banner === 1 && t.reg['com.example.mail'].banner === undefined, t.reg);
  rec = null; try { rec = JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) { /* none */ }
  check('... and the record owns nothing', rec && Object.keys(rec.owned).length === 0, rec);

  // ---- a --test instance: debug is there and reports the window's own process
  const t3 = makeCtx({ test: true });
  t3.reg = {};   // a test instance sees only its own test ids; none here
  const inst3 = feature.install(t3.ctx);
  check('--test: debug and apply commands exist', typeof t3.cmds.debug === 'function' && typeof t3.cmds.apply === 'function' && typeof t3.cmds.testShow === 'function');
  let d = await t3.cmds.debug();
  check('--test debug with no window: win false, no memory', d.ok && d.win === false && d.memory === null && d.idleCloseMs === 30000, d);
  await t3.list();
  t3.reg['Mantle.ToastTest.unit'] = { banner: undefined, enabled: 1 };
  t3.toasts.push({ id: 900, aumid: 'Mantle.ToastTest.unit', app: 'Test', title: 'Test toast', body: 'x', timeMs: Date.now() });
  await t3.cmds.apply();
  await t3.list();
  d = await t3.cmds.debug();
  check('--test: the test id is taken; a banner makes the window; debug reads its memory', t3.reg['Mantle.ToastTest.unit'].banner === 0 && d.win === true && d.memory && d.memory.workingSetSize === 51200 && d.makes === 1, d);
  const tw = FakeWin.made[FakeWin.made.length - 1];
  check('--test: the window is never on top (and never shown: reveal is skipped)', tw.o.alwaysOnTop === false && tw.onTop.length === 0, tw.o.alwaysOnTop);
  await t3.cmds.ready();
  await t3.cmds.layout({ h: 100, count: 1 });
  check('--test: a layout never shows the window on Owen\'s screen', tw.visible === false);
  d = await t3.cmds.debug();
  check('--test debug: the window\'s look, its shape and its spot are there for the e2e', d.look && d.look.transparent === true && d.look.hasShadow === false && d.shape && d.shape.height === 100 && d.spot && d.spot.x === 1536 - 392, d);
  await t3.cmds.corner({ rect: { x: 1536 - 300, y: 832 - 100, width: 300, height: 100 } });
  check('--test corner: a stand-in card lifts the column above it', tw.getBounds().y + tw.getBounds().height === 732, tw.getBounds());
  await t3.cmds.corner({ rect: null });
  await inst3.stop('test over');
  check('stop: the corner listener is gone (a change after stop moves nothing)', (() => { const n = tw.bounds.length; corner.changed('after stop'); return tw.bounds.length === n; })());

  // ---- the shape does not stick (read back from Windows): the window is sized to the stack, bottom-anchored
  SHAPE.verify = { ok: false, reason: 'Windows reports no region on the window (GetWindowRgnBox answered 0)' };
  const t4 = makeCtx();
  t4.reg = makeReg();
  const inst4 = feature.install(t4.ctx);
  await t4.list();
  t4.post('com.example.chat', 'No shape');
  await t4.list();
  const fw = FakeWin.made[FakeWin.made.length - 1];
  await t4.cmds.ready();
  await t4.cmds.layout({ h: 130, count: 1 });
  const fb = fw.getBounds();
  check('no shape: sized to the 130 DIP stack, its bottom at the corner (832)', fb.height === 130 && fb.y === 832 - 130 && fb.x === 1536 - 392, fb);
  check('... the shape is cleared and the log says why', fw.shapes[fw.shapes.length - 1] === null && t4.logs.some((l) => /shape did not stick \(Windows reports no region/.test(l)), t4.logs.slice(-3));
  await t4.cmds.layout({ h: 250, count: 2 });
  check('... a taller stack grows the window UP (bottom still at the corner)', fw.getBounds().height === 250 && fw.getBounds().y === 832 - 250, fw.getBounds());
  SHAPE.verify = { ok: true, reason: null };
  await inst4.stop('test over');
  check('--test stop: the test id is put back (no value)', t3.reg['Mantle.ToastTest.unit'].banner === undefined, t3.reg);

  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* busy */ }
  console.log(`TOASTS FEATURE TEST: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`TOASTS FEATURE TEST: CRASHED ${e.stack}`); process.exit(1); });
