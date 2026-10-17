'use strict';
/* osd-glide.test.js - the volume pop-up GLIDES WITH THE BAR (lane corner-follow-osd, 2026-10-17):
 * lib/features/osd.js on a hand-made ctx, a fake bar (host.bar up/onMotion), a fake window that records
 * its bounds and SHAPE, and a fake lib/bar-shape.js. Owen's screen: 1920x1080 at 125 % = work
 * {0,0,1536,864} DIP, the pill's resting shape {208,802,1120,62}.
 *   - bar hidden: the window's bottom on the work area's bottom (no bar room reserved);
 *   - bar up: the pane rises by the reach (62) on the bar's spring, 18 DIP clear of the pill, never over it;
 *   - the shape is the pane, spans the whole glide while it runs, narrows after; the panel growing keeps it so;
 *   - catchUp mid-hide; nothing on screen = no glide; flat fallback (no shape) never glides and never lands
 *     on the leaving pill; top-edge and --dock bars: reach 0; the faded race; the --test hook's synthetic state.
 *   node lib/features/osd-glide.test.js
 */
const Module = require('module');
const EventEmitter = require('events');

const fakeScreen = new EventEmitter();
class FakeWin {
  constructor() {
    FakeWin.last = this; this.destroyed = false; this.visible = false; this.sets = []; this.shapes = [];
    const self = this; this.wcOn = {};
    this.webContents = { on(ev, fn) { (self.wcOn[ev] = self.wcOn[ev] || []).push(fn); }, setWindowOpenHandler() {}, async executeJavaScript() { return { shown: true, open: true }; }, isCrashed() { return false; } };
  }
  emit(ev, ...a) { (this.wcOn[ev] || []).forEach((fn) => fn({}, ...a)); }
  setAlwaysOnTop() {} moveTop() {} isVisible() { return this.visible; } getOpacity() { return 1; }
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(0x4e078en); return b; }
  loadFile() {} isDestroyed() { return this.destroyed; }
  setBounds(b) { this.sets.push(b); this.cur = { x: b.x, y: b.y, width: b.width, height: b.height }; }
  getBounds() { return this.cur || { x: 0, y: 0, width: 0, height: 0 }; }
  setShape(rects) { this.shapes.push(rects.length ? rects[0] : null); }
  destroy() { this.destroyed = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
}
const shapeCfg = { applyFails: false, verifyFails: false, verifies: 0 };
const fakeShape = {
  apply(win, rect) { if (shapeCfg.applyFails && rect) return { ok: false, reason: 'refused (test)' }; win.setShape(rect ? [rect] : []); return { ok: true, reason: null }; },
  verify() { shapeCfg.verifies++; return shapeCfg.verifyFails ? { ok: false, reason: 'no region (test)' } : { ok: true, box: null, reason: null }; },
  readBack() { return { ok: true, box: null }; },
};
const pw = { opened: null };
const fakePopwatch = { open(k, o) { pw.opened = o; }, close() { pw.opened = null; }, isOpen() { return !!pw.opened; } };
const load = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { BrowserWindow: FakeWin, screen: fakeScreen };
  if (req === '../bar-shape') return fakeShape;
  if (req === '../popwatch') return fakePopwatch;
  return load.apply(this, arguments);
};
const feature = require('./osd.js');
const BF = require('../bar-follow');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const PILL = { x: 208, y: 802, width: 1120, height: 62 };
function makeCtx(o) {
  o = o || {};
  const t = { sent: [], pushes: [], logs: [], cmds: {}, on: {}, motion: [], up: !!o.up, enabled: true };
  t.bar = Object.assign({}, o.bar || PILL);
  t.display = o.display || { workArea: { x: 0, y: 0, width: 1536, height: 864 }, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
  t.ctx = {
    name: 'osd', flags: { test: !!o.test, live: !o.test }, preload: '',
    log: (s) => t.logs.push(s),
    sidecar: {
      async send(cmd, args) {
        t.sent.push({ cmd, args });
        if (cmd === 'osd.bright') return { ok: true, result: { watching: args.on !== false, reason: null, restored: 0 } };
        if (cmd === 'osd.qs') return { ok: true, result: { qsOpen: false } };
        if (cmd === 'raise') return { ok: true, result: { onTop: true } };
        if (cmd === 'volume') return { ok: true, result: { level: 30, muted: false } };
        if (cmd === 'osd.volume') return { ok: true, result: { ms: 1, level: 32, muted: false, from: { level: 30, muted: false } } };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on(ev, fn) { (t.on[ev] = t.on[ev] || []).push(fn); return () => {}; },
      onReady(fn) { fn(); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; }, replay() {},
    onChord() { return () => {}; }, health() {}, enabled: () => t.enabled, onEnabled() {},
    page: (f) => f || 'index.html',
    push(win, event, payload) { t.pushes.push({ event, payload, at: Date.now() }); return true; },
    broadcast() {},
    host: {
      display: () => t.display, barRect: () => t.bar,
      bar: o.noBar ? undefined : Object.assign({ up: () => t.up, onMotion(fn) { t.motion.push(fn); return () => { t.motion = t.motion.filter((f) => f !== fn); }; } },
        o.pill ? { pill: () => o.pill } : {}),
    },
  };
  t.move = (up, ms) => { t.up = up; t.motion.forEach((fn) => fn({ up, ms })); };
  t.lifts = () => t.pushes.filter((p) => p.event === 'osd.lift').map((p) => p.payload);
  t.win = () => FakeWin.last;
  t.shape = () => { const s = FakeWin.last.shapes; return s[s.length - 1]; };
  return t;
}

(async () => {
  // ---- 1. bar HIDDEN, then UP, then DOWN: the window stays, the pane glides, the shape follows
  {
    const t = makeCtx({ up: false });
    const inst = feature.install(t.ctx);
    await tick(30);
    const w = t.win();
    w.emit('did-finish-load');
    check('a page that loaded is told where the pane stands (no travel)', t.lifts().some((l) => l.ms === 0), t.lifts());
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('bar hidden: the window is the pop-up plus the reach, its BOTTOM ON THE WORK AREA\'S BOTTOM (no bar room reserved)',
      same(w.getBounds(), { x: 606, y: 720, width: 324, height: 144 }) && st.reach === 62 && st.full === 144, { b: w.getBounds(), st });
    check('bar hidden: the low spot is the work area\'s bottom', st.low && st.low.y + st.low.height === 864, st.low);
    check('bar hidden: the shape is the pane at the window\'s bottom (the see-through top takes no click)', same(t.shape(), { x: 0, y: 62, width: 324, height: 82 }), t.shape());
    check('bar hidden: the pane is 18 DIP above the screen\'s bottom, lift 0', st.pane && st.pane.y + st.pane.height === 846 && st.lift === 0, st.pane);
    check('the first shape on the window is read back from Windows', shapeCfg.verifies === 1 && st.shapeOk === true, shapeCfg.verifies);
    const nSets = w.sets.length, nLift = t.lifts().length;
    t.move(true, 560);
    const up = t.lifts().slice(nLift);
    check('bar UP: the page is told to rise by the reach on the bar\'s spring, in UP_RATE of its reveal', up.length === 1 && up[0].px === 62 && up[0].kind === 'up' && up[0].ms === BF.stackMs(true, 560), up);
    check('...the window does not move for the bar', w.sets.length === nSets, w.sets.slice(nSets));
    check('...and while it glides the shape spans the whole way (lo 0 .. hi 62)', same(t.shape(), { x: 0, y: 0, width: 324, height: 144 }), t.shape());
    await tick(BF.stackMs(true, 560) + BF.SETTLE_PAD_MS + 40);
    const st2 = (await t.cmds.state()).glide;
    check('...it narrows to the pane at the top once the glide is over (never before)', same(t.shape(), { x: 0, y: 0, width: 324, height: 82 }), t.shape());
    check('bar up: the pane\'s bottom is 18 DIP above the pill\'s top: never on or under the pill', st2.pane.y + st2.pane.height === 784 && st2.pane.y + st2.pane.height <= PILL.y && st2.lift === 62, st2.pane);
    const nL2 = t.lifts().length;
    t.move(false, 240);
    const dn = t.lifts().slice(nL2);
    check('bar DOWN: down on the bar\'s exit, DOWN_TRAIL_MS behind it', dn.length === 1 && dn[0].px === 0 && dn[0].kind === 'down' && dn[0].ms === 300, dn);
    check('...the shape spans the way down', same(t.shape(), { x: 0, y: 0, width: 324, height: 144 }), t.shape());
    await tick(300 + BF.SETTLE_PAD_MS + 40);
    check('...and narrows to the pane at the bottom after', same(t.shape(), { x: 0, y: 62, width: 324, height: 82 }), t.shape());
    // the panel opens while the bar is up: the window grows, the shape is the (taller) pane where it rests
    t.move(true, 560); await tick(BF.stackMs(true, 560) + BF.SETTLE_PAD_MS + 40);
    await t.cmds.size({ w: 384, h: 330, open: true }); await tick(5);
    check('the panel grows the window (pane + reach, bottom anchored) and the shape is the pane, lifted',
      same(w.getBounds(), { x: 576, y: 472, width: 384, height: 392 }) && same(t.shape(), { x: 0, y: 0, width: 384, height: 330 }), { b: w.getBounds(), s: t.shape() });
    // the click-outside test of the open panel is the pane, not the taller window round it
    await t.cmds.mixer(); await tick(160);
    const c = pw.opened && pw.opened.contains;
    check('open panel, bar up: a point in the pane is inside it', !!c && c({ x: 768, y: 600 }), !!c);
    check('...a point in the window\'s see-through bottom (over the pill) is outside it', !!c && !c({ x: 768, y: 840 }));
    check('...and the shadow margin is outside too', !!c && !c({ x: 580, y: 600 }));
    // THE FADE RACE still holds: an older "faded" never hides a newer show
    const seqs = () => t.pushes.filter((p) => p.event === 'osd.show').map((p) => p.payload.seq);
    await t.cmds.show({}); const s1 = seqs().slice(-1)[0];
    await t.cmds.show({}); const s2 = seqs().slice(-1)[0];
    await t.cmds.faded({ seq: s1 });
    check('the faded race: an older seq is ignored', (await t.cmds.state()).shown === true);
    await t.cmds.faded({ seq: s2 });
    check('...the newest seq hides it', (await t.cmds.state()).shown === false && !w.visible);
    // NOTHING ON SCREEN: no glide, the page simply stands at the target for the next show
    const g0 = (await t.cmds.state()).glide.follow.glides, nL3 = t.lifts().length, nS = w.shapes.length;
    t.move(false, 240); t.move(true, 560);
    const hidden = t.lifts().slice(nL3);
    check('hidden: a bar motion is no glide (ms 0) and the window is not touched', hidden.length === 2 && hidden.every((l) => l.ms === 0) && w.shapes.length === nS &&
      (await t.cmds.state()).glide.follow.glides === g0, { hidden, shapes: w.shapes.length - nS });
    // CATCH UP: up while the bar is still GOING (nothing was on screen): from the bar's top, down with it
    t.move(false, 240);
    await tick(60);
    const nL4 = t.lifts().length;
    await t.cmds.show({}); await tick(5);
    const cu = t.lifts().slice(nL4);
    const f = (await t.cmds.state()).glide.follow;
    check('shown mid-hide: it starts at the bar\'s top (px 62, ms 0) and goes down over what is left of the exit',
      cu.length >= 2 && cu[cu.length - 2].px === 62 && cu[cu.length - 2].ms === 0 && cu[cu.length - 1].px === 0 && cu[cu.length - 1].ms > 100 && cu[cu.length - 1].ms < 300 && f.glide && f.glide.caughtUp, cu);
    check('...and the shape spans that way', same(t.shape(), { x: 0, y: 0, width: 384, height: 392 }), t.shape());
    await t.cmds.faded({});
    await inst.stop();
    check('stop(): the bar hook is dropped', t.motion.length === 0);
  }

  // ---- 2. FLAT: the shape would not stick -> the window is the pane, placed at the target, no glide
  {
    shapeCfg.verifyFails = true; shapeCfg.verifies = 0;
    const t = makeCtx({ up: true });
    const inst = feature.install(t.ctx);
    await tick(30);
    const w = t.win();
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('flat: the window is sized to the pane and placed where it rests (bar up: y - reach)', same(w.getBounds(), { x: 606, y: 720, width: 324, height: 82 }) && st.shapeOk === false, { b: w.getBounds(), st });
    check('flat: the shape is cleared (plain window, no see-through part) and the page\'s lift goes back to 0',
      t.shape() === null && t.lifts().slice(-1)[0].px === 0, { s: t.shape(), l: t.lifts().slice(-2) });
    check('flat: the reason is in the log', t.logs.some((l) => /shape did not stick/.test(l)), t.logs.slice(-3));
    const nL = t.lifts().length;
    t.move(false, 240);
    check('flat, bar going down: no glide (lift 0, ms 0) and the window waits out the bar\'s exit (never on the leaving pill)',
      t.lifts().slice(nL).every((l) => l.px === 0 && l.ms === 0) && w.getBounds().y === 720, { l: t.lifts().slice(nL), b: w.getBounds() });
    await tick(340);
    check('...then drops to the low spot', w.getBounds().y === 782, w.getBounds());
    t.move(true, 560);
    check('flat, bar coming up: the window goes up at once (before the pill arrives)', w.getBounds().y === 720, w.getBounds());
    await t.cmds.faded({}); await inst.stop();
    shapeCfg.verifyFails = false;
  }

  // ---- 3. TOP-EDGE and --dock bars: reach 0, today's spot, nothing glides
  {
    const t = makeCtx({ up: true, bar: { x: 208, y: 0, width: 1120, height: 62 } });
    const inst = feature.install(t.ctx);
    await tick(30);
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('top-edge bar: below it as before (y 62), reach 0, the window is the pane', st.reach === 0 && st.below === true && same(t.win().getBounds(), { x: 606, y: 62, width: 324, height: 82 }), { st, b: t.win().getBounds() });
    const n = t.lifts().length;
    t.move(false, 240); t.move(true, 560);
    check('top-edge bar: its motion moves nothing', t.lifts().slice(n).length === 0 && (await t.cmds.state()).glide.follow.glides === 0, t.lifts().slice(n));
    const show = t.pushes.filter((p) => p.event === 'osd.show').slice(-1)[0];
    check('top-edge bar: the page is told it hangs below', show && show.payload.below === true);
    await t.cmds.faded({}); await inst.stop();
  }
  {
    const t = makeCtx({ up: true, bar: { x: 0, y: 820, width: 1536, height: 44 },
      display: { workArea: { x: 0, y: 0, width: 1536, height: 820 }, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1 } });
    const inst = feature.install(t.ctx);
    await tick(30);
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('--dock: the pinned bar is outside the work area: reach 0, the window\'s bottom on the bar\'s top', st.reach === 0 && same(t.win().getBounds(), { x: 606, y: 738, width: 324, height: 82 }), { st, b: t.win().getBounds() });
    await t.cmds.faded({}); await inst.stop();
  }
  // no bar hook at all (an old host): the bar counts as up, the pane rests above it
  {
    const t = makeCtx({ noBar: true });
    const inst = feature.install(t.ctx);
    await tick(30);
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('no bar hook: it rests above the pill (counted as up), never under it', st.lift === 62 && st.pane.y + st.pane.height === 784, st);
    await t.cmds.faded({}); await inst.stop();
  }

  // ---- 4. the --test hook: synthetic state, held up, placed by the live road; never registered live
  {
    const live = makeCtx({});
    const i0 = feature.install(live.ctx); await tick(30);
    check('testShow / testHide exist only in --test', !live.cmds.testShow && !live.cmds.testHide);
    await i0.stop();
    const t = makeCtx({ test: true, up: false });
    const inst = feature.install(t.ctx);
    await tick(30);
    const before = t.sent.filter((s) => s.cmd === 'osd.volume' || s.cmd === 'osd.bright' && s.args.op !== 'watch').length;
    const r = await t.cmds.testShow({ kind: 'volume', level: 40 });
    const show = t.pushes.filter((p) => p.event === 'osd.show').slice(-1)[0];
    check('testShow: shown with the made-up level, held up (hold: true), via testShow', r.ok && show.payload.state.level === 40 && show.payload.state.synthetic === true && show.payload.hold === true && show.payload.via === 'testShow', show && show.payload);
    check('testShow: placed exactly as live (pane + reach, bottom on the work area\'s bottom), the window stays hidden', same(r.glide.bounds, { x: 606, y: 720, width: 324, height: 144 }) && r.glide.visible === false, r.glide);
    check('testShow: its state carries the bounds, the shape rect, the follower, the reach and the lift',
      same(r.glide.shapeRect, { x: 0, y: 62, width: 324, height: 82 }) && r.glide.reach === 62 && r.glide.lift === 0 && r.glide.follow && 'glides' in r.glide.follow, r.glide);
    check('testShow: no volume or brightness command went to the sidecar', t.sent.filter((s) => s.cmd === 'osd.volume' || s.cmd === 'osd.bright' && s.args.op !== 'watch').length === before);
    const lvl0 = await t.cmds.testShow({ level: 0 });
    check('testShow: level 0 is level 0', t.pushes.filter((p) => p.event === 'osd.show').slice(-1)[0].payload.state.level === 0 && lvl0.ok);
    t.move(true, 560);
    check('testShow: a bar motion glides it (the trace\'s bar.testMove)', t.lifts().slice(-1)[0].px === 62 && t.lifts().slice(-1)[0].ms > 0);
    const h = await t.cmds.testHide();
    check('testHide: gone', h.ok && (await t.cmds.state()).shown === false);
    await inst.stop();
  }

  // ---- lane mantle-corner-follow2: with the bar's PILL (host.bar.pill()) the pane RESTS above the hidden pill.
  // r1: its bottom at 846 was under the hidden pill's top (841) and the pill's first faint frames of an up landed
  // on it (1.4 DIP). Same rule as the card, the Clips panel and the banners (lib/bar-follow.js restOver).
  {
    const PILL48 = { x: 208, y: 802, width: 1120, height: 48, shape: 'pill', edge: 'bottom' };
    const ht = BF.hiddenPillTop(PILL48);
    const t = makeCtx({ up: false, pill: PILL48 });
    const inst = feature.install(t.ctx);
    await tick(30);
    const w = t.win();
    w.emit('did-finish-load');
    check('rest: a page that loaded is told it stands at the rest (24 up), no travel', t.lifts().some((l) => l.ms === 0 && l.px === 24), t.lifts());
    await t.cmds.show({}); await tick(5);
    const st = (await t.cmds.state()).glide;
    check('rest: bar hidden, the pane\'s bottom 822, above the hidden pill\'s top (840.9) by its 18 DIP margin', st.pane && st.pane.y + st.pane.height === 822 && ht - 822 >= 18 && st.lift === 24, { pane: st.pane, lift: st.lift });
    check('rest: the window is the same as without a pill (pop-up + reach, bottom on the work area\'s)', same(w.getBounds(), { x: 606, y: 720, width: 324, height: 144 }), w.getBounds());
    check('rest: the shape is the pane, 24 up', same(t.shape(), { x: 0, y: 38, width: 324, height: 82 }), t.shape());
    const n = t.lifts().length;
    t.move(true, 560);
    const up = t.lifts().slice(n);
    check('rest: bar UP rises from the rest to the reach (62)', up.length === 1 && up[0].px === 62 && up[0].kind === 'up', up);
    check('...the shape spans the way (24 .. 62)', same(t.shape(), { x: 0, y: 0, width: 324, height: 120 }), t.shape());
    await tick(BF.stackMs(true, 560) + BF.SETTLE_PAD_MS + 40);
    const n2 = t.lifts().length;
    t.move(false, 240);
    const dn = t.lifts().slice(n2);
    check('rest: bar DOWN goes back to the rest, not the corner', dn.length === 1 && dn[0].px === 24 && dn[0].kind === 'down' && dn[0].ms === 300, dn);
    await tick(300 + BF.SETTLE_PAD_MS + 40);
    check('...and narrows to the pane at the rest after', same(t.shape(), { x: 0, y: 38, width: 324, height: 82 }), t.shape());
    await t.cmds.faded({}); await inst.stop();
  }

  console.log(`osd glide: ${passed} passed, ${failures.length} failed`);
  failures.forEach((x) => console.log(`  FAIL ${x}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`osd glide: CRASHED ${e && e.stack || e}`); process.exit(1); });
