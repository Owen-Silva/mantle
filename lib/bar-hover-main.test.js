/*
 * bar-hover-main.test.js -- the REAL main.js hoverTick (and barRect / popoverDipRect / popHoldsBar), lifted
 * out of main.js and run in a sandbox on a simulated clock with a made-up cursor (lane mantle-barhover,
 * 2026-10-17). Owen: "i can hold my mouse a lot of pixels above it without it going away like a lot".
 * The same sweep runs on main.js as of 03b8ede (git show; skipped if git cannot give it) for the BEFORE
 * numbers. Geometry is Owen's screen: 1536x864 DIP, the 1120-wide pill resting 14 DIP above the edge.
 * Pure node, no Electron, never the real cursor.
 *
 *   node lib/bar-hover-main.test.js        one summary line: "BAR HOVER MAIN TEST: n passed, m failed"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = '03b8ede';
let passed = 0;
const failures = [];
function ok(cond, what, detail) {
  if (cond) passed++;
  else failures.push(what + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
  return cond;
}

function topFunction(src, head) {
  const a = src.indexOf(head);
  if (a === -1) return null;
  const end = src.indexOf('\n}', a);
  return src.slice(a, end + 2);
}

const SCREEN = { x: 0, y: 0, width: 1536, height: 864 };
const REST = { x: 208, y: 864 - 62, width: 1120, height: 62 };   // the pill (48) and its 14 DIP of air
const SLIDE_MS = 370;

/** A sandbox running main.js's own hover code from `src`. */
function world(src, label) {
  const heads = ['async function hoverTick(', 'function barRect(', 'function popoverDipRect(', 'function popHoldsBar(', 'function inHotZone(', 'function pointIn('];
  const code = heads.map((h) => topFunction(src, h)).filter(Boolean);
  if (!code.some((c) => c.startsWith('async function hoverTick('))) return null;
  const w = { t: 10000, cursor: { x: -10000, y: -10000 }, log: [], closes: [] };
  const BarIntent = label === 'now' ? require('./bar-intent') : (() => {
    const m = { exports: {} };
    new Function('module', 'exports', 'require', w.barIntentSrc || BASE_INTENT)(m, m.exports, require);
    return m.exports;
  })();
  const c = vm.createContext({
    Promise, Error, String, JSON, Math, Number, Object,
    Date: { now: () => w.t },
    process: { stdout: { write: (s) => { w.log.push(`${w.t} ${String(s).trim()}`); return true; } } },
    screen: { getPrimaryDisplay: () => ({ bounds: SCREEN, scaleFactor: 1.25 }), getCursorScreenPoint: () => ({ x: w.cursor.x, y: w.cursor.y }) },
    testCursor: null,
    flags: { dock: false, barEdge: 'bottom' }, BAR_SHAPE: 'pill', shuttingDown: false,
    barWin: { isDestroyed: () => false, getBounds: () => ({ x: REST.x, y: REST.y - 640, width: REST.width, height: REST.height + 640 }) },
    barRevealed: false, barPopover: null, hoverTimer: null, hideTimer: null, hoverHeld: null, hoverFirstTick: false,
    HOVER_DEBUG: false, hoverDebugAt: 0, rendererHoverAt: 0, barLeftAt: null, barOutAt: null,
    REVEAL_BAND_DIP: 4, HIDE_GRACE_MS: 180, POLL_HIDDEN_MS: 80, POLL_SHOWN_MS: 60,
    BarIntent, HotCorners: { claims: () => false },
    gameQuiet: () => null, barTall: () => true,
    barGeometry: () => ({ rest: { dip: REST }, shape: 'pill', scale: 1.25, start: {}, edge: 'bottom' }),
    sideRect: (r) => r, popKind: (k) => String(k || 'unnamed').split(':')[0],
    foregroundBlocksReveal: async () => ({ blocked: false, reason: null }),
    setBar: () => {}, scheduleHoverTick: () => {},
    revealBar: (why) => { c.barRevealed = true; c.hideTimer = null; c.barLeftAt = null; c.barOutAt = null; w.log.push(`${w.t} reveal: ${why}`); },
    beginHide: (why) => { if (!c.barRevealed || c.hideTimer) return; c.hideTimer = { at: w.t, why }; w.log.push(`${w.t} hide: ${why}`); },
    closeBarPop: (how) => { w.closes.push({ t: w.t, how }); },
  });
  vm.runInContext(`${code.join('\n')}\n;globalThis.__h = { hoverTick };`, c);
  w.c = c;
  /** Advance the clock by `ms`, ticking the way the real poll does (60 ms shown, 80 hidden). */
  w.run = async (ms) => {
    const end = w.t + ms;
    while (w.t < end) {
      if (c.hideTimer && w.t - c.hideTimer.at >= SLIDE_MS) { c.hideTimer = null; c.barRevealed = false; c.barLeftAt = null; c.barOutAt = null; }
      await c.__h.hoverTick();
      w.t += c.barRevealed ? 60 : 80;
    }
  };
  w.up = () => c.barRevealed && !c.hideTimer;
  /** Reveal at the edge, settle in the pill, rest at (x, y): ms until the hide starts, or null if it held 3 s. */
  w.restAt = async (x, y) => {
    w.cursor = { x: 768, y: 863 }; await w.run(400);
    w.cursor = { x: 768, y: REST.y + 24 }; await w.run(600);
    if (!w.up()) return 'no-reveal';
    w.cursor = { x, y };
    const t0 = w.t;
    while (w.t - t0 < 3000) { await w.run(20); if (!w.up()) return w.t - t0; }
    return null;
  };
  return w;
}

let BASE_INTENT = null;
async function sweep(src, label) {
  const w = world(src, label);
  if (!w) { ok(false, `${label}: main.js has hoverTick`); return null; }
  const up = {};
  for (const off of [0, 8, 9, 20, 28, 29, 60, 200]) up[off] = await w.restAt(768, REST.y - off);
  const side = {};
  for (const off of [8, 9, 12, 13]) side[off] = await world(src, label).restAt(REST.x - off, REST.y + 24);
  const band = Math.max(...Object.keys(up).map(Number).filter((o) => up[o] === null));
  const sideBand = Math.max(-1, ...Object.keys(side).map(Number).filter((o) => side[o] === null));
  console.log(`  ${label}: hover band ${band} DIP above the pill, ${sideBand} DIP past its end; hide starts (ms) by DIP above: ` +
    Object.keys(up).map((o) => `${o}:${up[o] === null ? 'kept' : up[o]}`).join(' '));
  return { up, side, band, sideBand };
}

/** A pop-up, by kind: rest at 200 DIP above with it open; then in its room. */
async function popState(src, label, key, height) {
  const w = world(src, label);
  w.cursor = { x: 768, y: 863 }; await w.run(400);
  w.cursor = { x: 768, y: REST.y + 24 }; await w.run(600);
  w.c.barPopover = { key, height };
  w.cursor = { x: 768, y: REST.y - Math.min(40, height - 10) }; await w.run(1500);
  const inRoom = w.up();
  w.cursor = { x: 768, y: REST.y - 200 };
  const t0 = w.t; let hideAt = null;
  while (w.t - t0 < 3000) { await w.run(20); if (!w.up()) { hideAt = w.t - t0; break; } }
  // the page (or main's fallback) gives the room back one second after main asked
  const asked = w.closes.length;
  if (asked) { await w.run(1000); w.c.barPopover = null; }
  await w.run(1000);
  return { inRoom, hideAt, asked, hiddenAfter: !w.c.barRevealed, reveals: w.log.filter((l) => / reveal: a bar popover is open/.test(l)).length };
}

async function main() {
  const NOW = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const g = spawnSync('git', ['-C', ROOT, 'show', `${BASE}:main.js`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const gi = spawnSync('git', ['-C', ROOT, 'show', `${BASE}:lib/bar-intent.js`], { encoding: 'utf8' });
  const OLD = g.status === 0 && gi.status === 0 ? g.stdout : null;
  BASE_INTENT = gi.status === 0 ? gi.stdout : null;

  // ---- BEFORE (03b8ede, what live runs): the measured fault
  if (OLD) {
    const o = await sweep(OLD, 'before');
    ok(o && o.band === 28 && o.sideBand === 12, `before (${BASE}): a cursor resting 28 DIP above / 12 DIP past the end keeps the bar for ever (the fault)`, o && { band: o.band, side: o.sideBand });
    const ot = await popState(OLD, 'before', 'tip', 58);
    console.log(`  before: a tooltip's room open, cursor 200 DIP above: hide ${ot.hideAt === null ? 'never (3 s)' : ot.hideAt + ' ms'}`);
    ok(ot.hideAt === null, `before (${BASE}): a tooltip's room held the bar with the cursor 200 DIP above`, ot);
  } else console.log(`  before: NOT RUN (git show ${BASE} failed: ${(g.stderr || gi.stderr || '').trim().slice(0, 120)})`);

  // ---- NOW
  const n = await sweep(NOW, 'now');
  ok(n.band === 8 && n.sideBand === 8, 'now: the hover band is the pill plus 8 DIP (up and past each end)', { band: n.band, side: n.sideBand });
  ok([9, 20, 28].every((o) => typeof n.up[o] === 'number' && n.up[o] >= 500 && n.up[o] <= 620), 'now: resting 9..28 DIP above, the hide starts after ~500 ms (the overshoot pass; ticks are 60 ms, so up to two ticks later)', n.up);
  ok([29, 60, 200].every((o) => typeof n.up[o] === 'number' && n.up[o] >= 180 && n.up[o] <= 260), 'now: 29+ DIP above, after the ~180 ms grace (as before)', n.up);
  ok(n.side[8] === null && typeof n.side[9] === 'number' && n.side[9] >= 500 && n.side[9] <= 620, 'now: 8 DIP past the end keeps it, 9 DIP goes after ~500 ms', n.side);

  // hidden: the band never reveals, only the edge
  const h = world(NOW, 'now');
  h.cursor = { x: 768, y: REST.y - 4 }; await h.run(1000);
  const above = h.c.barRevealed;
  h.cursor = { x: 768, y: REST.y + 24 }; await h.run(1000);
  const onPlace = h.c.barRevealed;
  h.cursor = { x: 768, y: 863 }; await h.run(200);
  ok(!above && !onPlace && h.c.barRevealed, 'now, hidden: resting above or on the hidden pill\'s place never reveals it; the edge does', { above, onPlace, edge: h.c.barRevealed });

  // a clicked pop-up holds (macOS menus close on a click away / Esc), a tooltip's room does not
  const cal = await popState(NOW, 'now', 'cal', 300);
  ok(cal.inRoom && cal.hideAt === null && cal.asked === 0, 'now, clicked pop-up (calendar): holds the bar with the cursor 200 DIP above; nothing closes it from here', cal);
  const fly = await popState(NOW, 'now', 'app:7', 192);
  ok(fly.inRoom && fly.hideAt === null, 'now, a flyout: held while open (the page closes a hovered one 350 ms after the pointer leaves)', fly);
  const tip = await popState(NOW, 'now', 'tip', 58);
  console.log(`  now: a tooltip's room open, cursor in the room: ${tip.inRoom ? 'kept' : 'hid'}; cursor 200 DIP above: hide after ${tip.hideAt} ms; room asked back ${tip.asked}x`);
  ok(tip.inRoom, 'now, tooltip: the cursor in its room keeps the bar (the room is part of the shaped bar)', tip);
  ok(typeof tip.hideAt === 'number' && tip.hideAt >= 180 && tip.hideAt <= 260, 'now, tooltip: 200 DIP above, out of the room, the bar goes after the ~180 ms grace', tip);
  ok(tip.asked === 1 && tip.hiddenAfter && tip.reveals === 0, 'now, tooltip: main asks for the room back once, and the hidden bar is never re-revealed by it', tip);

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`BAR HOVER MAIN TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.log('  FAIL the run threw: ' + (e && e.stack || e)); console.log(`BAR HOVER MAIN TEST: ${passed} passed, ${failures.length + 1} failed`); process.exitCode = 1; });
