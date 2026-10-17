/* osd-model.test.js - node ui/osd/osd-model.test.js */
'use strict';
const M = require('./osd-model.js');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }

/* a fake clock */
function clock() {
  let t = 0, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (f, ms) => { id++; timers.set(id, { f, at: t + ms }); return id; },
    clearTimeout: (i) => { timers.delete(i); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        timers.delete(next[0]); t = next[1].at; next[1].f();
      }
      t = end;
    },
  };
}

// ---- fader
{
  const c = clock(); let faded = 0;
  const f = M.fader({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onFade: () => faded++ });
  f.poke(); c.advance(1499);
  check('no fade before 1.5 s', faded === 0);
  c.advance(1); check('fades at 1.5 s', faded === 1);
  c.advance(5000); check('fades once', faded === 1);
}
{
  const c = clock(); let faded = 0;
  const f = M.fader({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onFade: () => faded++ });
  f.poke(); c.advance(1000); f.poke(); c.advance(1000);
  check('a repeat key restarts the 1.5 s', faded === 0);
  c.advance(500); check('...and fades 1.5 s after the last one', faded === 1);
}
{
  const c = clock(); let faded = 0;
  const f = M.fader({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onFade: () => faded++ });
  f.poke(); c.advance(500); f.hover(true); c.advance(10000);
  check('never fades while hovered', faded === 0 && f.state().up);
  f.hover(false); c.advance(1499); check('pointer left: still up at 1.499 s', faded === 0);
  c.advance(1); check('pointer left: fades at 1.5 s', faded === 1);
}
{
  const c = clock(); let faded = 0;
  const f = M.fader({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onFade: () => faded++ });
  f.poke(); f.hold(true); c.advance(9000); check('never fades while a slider is held', faded === 0);
  f.hold(false); c.advance(1500); check('fades 1.5 s after the hold ends', faded === 1);
}
{
  const c = clock(); let faded = 0;
  const f = M.fader({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onFade: () => faded++ });
  f.poke(); f.reset(); c.advance(5000);
  check('reset cancels the pending fade', faded === 0 && !f.state().armed && !f.state().up);
  f.hover(false); c.advance(5000); check('a leave after reset does not fade a hidden pop-up', faded === 0);
}

// ---- describe / pct
check('pct rounds and clamps', M.pct(41.6) === 42 && M.pct(-3) === 0 && M.pct(140) === 100 && M.pct(null) === null && M.pct(NaN) === null);
{
  const d = M.describe('volume', { ok: true, level: 62, muted: false });
  check('volume 62', d.value === '62' && d.fill === 62 && d.label === 'Volume' && !d.dead, d);
  const m = M.describe('volume', { ok: true, level: 62, muted: true });
  check('muted keeps the level and says Muted', m.muted && m.label === 'Muted' && m.value === '62', m);
  const x = M.describe('volume', { ok: false, reason: 'no playback device' });
  check('unavailable volume says why', x.dead && /no playback device/.test(x.aria), x);
  const b = M.describe('brightness', { ok: true, level: 80 });
  check('brightness 80', b.value === '80' && b.label === 'Brightness', b);
  const bx = M.describe('brightness', { level: null });
  check('brightness unknown is dead with a reason', bx.dead && /no reason/.test(bx.aria), bx);
}

// ---- glyphs
check('volume glyph: 3 waves at 80', (M.volumeSvg(80, false).match(/stroke-width="1.2"/g) || []).length === 3);
check('volume glyph: 1 wave at 20', (M.volumeSvg(20, false).match(/stroke-width="1.2"/g) || []).length === 1);
check('volume glyph: muted draws the cross, no waves', /M10.2 5.6l4.6 4.8/.test(M.volumeSvg(80, true)) && !/stroke-width="1.2"/.test(M.volumeSvg(80, true)));
check('sun glyph: filled from 50', /fill="currentColor"/.test(M.sunSvg(60)) && !/<circle[^>]*fill="currentColor"/.test(M.sunSvg(30)));

// ---- listApps
{
  const S = (key, active, extra) => Object.assign({ key, name: key, active, level: 50, muted: false }, extra || {});
  let r = M.listApps([S('a', true), S('b', false), S('c', true)], null, 0);
  check('only apps playing now are listed', r.rows.map((s) => s.key).join() === 'a,c', r.rows.map((s) => s.key));
  r = M.listApps([S('a', true), S('b', true), S('c', true)], r.memo, 100);
  check('a newcomer goes after the ones already listed', r.rows.map((s) => s.key).join() === 'a,c,b', r.rows.map((s) => s.key));
  r = M.listApps([S('a', false), S('b', true), S('c', true)], r.memo, 3000);
  check('an app that just stopped stays for the grace period', r.rows.map((s) => s.key).join() === 'a,c,b');
  r = M.listApps([S('a', false), S('b', true), S('c', true)], r.memo, 100 + M.GRACE_MS + 1);
  check('...and goes after it', r.rows.map((s) => s.key).join() === 'c,b', r.rows.map((s) => s.key));
  r = M.listApps([S('a', false), S('b', true), S('c', true)], r.memo, 20000, (k) => k === 'a');
  check('a row in use (keep) stays even when idle', r.rows.map((s) => s.key).join() === 'a,c,b' || r.rows.map((s) => s.key).join() === 'c,b,a', r.rows.map((s) => s.key));
  r = M.listApps([], r.memo, 30000);
  check('no apps -> no rows', r.rows.length === 0);
  r = M.listApps(null, null, 0);
  check('garbage in -> no rows', r.rows.length === 0);
  check('system sounds are named in words', M.appName({ system: true, name: 'x' }) === 'System sounds' && M.appName({}) === 'An app');
}

// ---- plain: reasons on screen carry no codes or jargon (capture-osd 2026-09-29)
{
  const nd = M.describe('volume', { ok: false, reason: 'the volume key did nothing: no default playback device (HRESULT 0x80070490) - nothing is plugged in, or audio is disabled' });
  check('no playback device: the pop-up says what to do, in plain words', /^Volume unavailable: No speakers or headphones are connected\. Plug some in/.test(nd.aria) && !/0x|HRESULT/.test(nd.aria), nd.aria);
  const code = M.plain('the volume could not be read: COMException: Element not found. (0x80070490)');
  check('another reason keeps its words but loses the code and the exception name', code === 'the volume could not be read: Element not found.', code);
  check('"sidecar" never reaches the screen', !/sidecar/i.test(M.plain('the sidecar did not answer')), M.plain('the sidecar did not answer'));
  check('an empty or odd reason still says something', M.plain('') === 'no reason was given' && M.plain(null) === 'no reason was given' && !/object Object/.test(M.plain({})) && M.plain({ message: 'gone' }) === 'gone', M.plain({}));
}

// ---- wheel: a notch is one step; a touchpad's small deltas add up (capture-osd 2026-09-29)
{
  check('a mouse notch up is one step up, down one step down', M.wheel(0, -100, 0).steps === 1 && M.wheel(0, 100, 0).steps === -1);
  check('a big notch (9 lines a notch) is still ONE step', M.wheel(0, -300, 0).steps === 1);
  check('line-mode events count one notch each', M.wheel(0, -3, 1).steps === 1);
  let acc = 0, steps = 0;
  for (let i = 0; i < 40; i++) { const w = M.wheel(acc, -4, 0); acc = w.acc; steps += w.steps; }
  check('a touchpad swipe of 40 x 4 px is one step, not forty', steps === 1, steps);
  const turn = M.wheel(-80, 30, 0);
  check('turning round drops the carry from the other direction', turn.steps === 0 && turn.acc === 30, turn);
  check('a zero or junk delta does nothing', M.wheel(0, 0, 0).steps === 0 && M.wheel(0, NaN, 0).steps === 0);
}

// ---- place
{
  const work = { x: 0, y: 0, width: 1536, height: 864 };
  const bar = { x: 400, y: 812, width: 736, height: 44 };
  const p = M.place(bar, work, { w: 260, h: 52 }, 10);
  check('bottom bar: centred, 10 px above the bar', p.x === 638 && p.y === 812 - 10 - 52 && !p.below, p);
  const t = M.place({ x: 400, y: 8, width: 736, height: 44 }, work, { w: 260, h: 52 }, 10);
  check('top bar: below it', t.y === 62 && t.below, t);
  const n = M.place(null, work, { w: 260, h: 52 }, 10);
  check('no bar: still on screen, near the bottom', n.y > 700 && n.y + 52 <= 864, n);
  const big = M.place(bar, work, { w: 360, h: 900 }, 10);
  check('taller than the screen: clamped inside the work area', big.y >= 0, big);
  const off = M.place(bar, { x: 1536, y: 0, width: 1920, height: 1040 }, { w: 260, h: 52 }, 10);
  check('second display: x inside it', off.x >= 1536 && off.x + 260 <= 1536 + 1920, off);
  // capture-osd 2026-09-29: the bar lives on ONE display; the pop-up goes to the one under the
  // cursor. A bar on another display (or parked below the screen) says nothing about this one.
  check('second display: the other display\'s bar is ignored (near the bottom, not at the bar\'s y)',
    off.y === 1040 - 10 - 52 - 40 && !off.below, off);
  const parked = M.place({ x: 400, y: 900, width: 736, height: 44 }, work, { w: 260, h: 52 }, 10);
  check('bar parked below the screen: placed as if there were no bar (a gap, never flush with the edge)',
    parked.y === n.y, { parked, n });
  const topWork = { x: 0, y: 28, width: 1536, height: 836 };   // Owen's: the top bar reserves 28 px
  const q = M.place({ x: 400, y: 812, width: 736, height: 44 }, topWork, { w: 324, h: 82 }, 0);
  const dock = M.place({ x: 0, y: 820, width: 1536, height: 44 }, { x: 0, y: 0, width: 1536, height: 820 }, { w: 260, h: 52 }, 10, { x: 0, y: 0, width: 1536, height: 864 });
  check('--dock bar reserving its strip outside the work area: still just above it', dock.y === 820 - 10 - 52, dock);
  check('work area that starts below a top strip: still just above the bottom bar', q.y === 812 - 82 && q.x === 606, q);
}

// ---- placeLow: as if the bar were not there, plus the reach it glides up by (lane corner-follow-osd)
{
  const BF = require('../../lib/bar-follow.js');
  const work = { x: 0, y: 0, width: 1536, height: 864 };
  const pill = { x: 208, y: 802, width: 1120, height: 62 };   // Owen's resting pill, 1920x1080 at 125 %
  const s = { w: 324, h: 82 };
  const p = M.placeLow(pill, work, s, work, BF.reachOver);
  check('low: the window\'s bottom on the work area\'s bottom, centred', p.x === 606 && p.y === 864 - 82 && p.height === 82 && !p.below, p);
  check('low: the reach clears the pill\'s resting top (the pane 18 DIP above it, as place() put it)', p.reach === 62 && p.full === 144 && p.y - p.reach === M.place(pill, work, s, 0, work).y, p);
  const big = M.placeLow(pill, work, { w: 384, h: 330 }, work, BF.reachOver);
  check('the open panel: same reach, the window grows by it', big.reach === 62 && big.full === 392 && big.y === 534, big);
  const pop = M.placeLow({ x: 208, y: 402, width: 1120, height: 462 }, work, s, work, BF.reachOver);
  check('a bar pop-up open (the resting shape is taller): the reach clears it too', pop.reach === 462, pop);
  const tall = M.placeLow(pill, work, { w: 384, h: 840 }, work, BF.reachOver);
  check('no room above: the reach is cut to the room there is (inside the work area)', tall.y === 24 && tall.reach === 24 && tall.y - tall.reach === 0, tall);
  const top = M.placeLow({ x: 208, y: 0, width: 1120, height: 62 }, work, s, work, BF.reachOver);
  check('top-edge bar: below it as place() does, reach 0', top.below && top.y === 62 && top.reach === 0 && top.full === 82, top);
  const dock = M.placeLow({ x: 0, y: 820, width: 1536, height: 44 }, { x: 0, y: 0, width: 1536, height: 820 }, s, { x: 0, y: 0, width: 1536, height: 864 }, BF.reachOver);
  check('--dock (outside the work area): reach 0, the bottom on the bar\'s top', dock.reach === 0 && dock.y === 738, dock);
  const none = M.placeLow(null, work, s, work, BF.reachOver);
  check('no bar: low, reach 0', none.y === 782 && none.reach === 0, none);
  const other = M.placeLow(pill, { x: 1536, y: 0, width: 1920, height: 1040 }, s, { x: 1536, y: 0, width: 1920, height: 1080 }, BF.reachOver);
  check('the bar on another display: reach 0 here', other.reach === 0 && other.x > 1536 && other.y === 1040 - 82, other);
  const noFn = M.placeLow(pill, work, s, work);
  check('no reachOver given (the page): reach 0, never a throw', noFn.reach === 0 && noFn.y === 782, noFn);
  check('place() is unchanged for the layouts / on-top HUDs (the bar\'s room kept)', M.place(pill, work, s, 0, work).y === 720);
}

console.log(`osd-model: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
