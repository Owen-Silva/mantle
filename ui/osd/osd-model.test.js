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
}

console.log(`osd-model: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
