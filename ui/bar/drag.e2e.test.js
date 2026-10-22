'use strict';
/*
 * ui/bar/drag.e2e.test.js - drag to reorder, with REAL input, in a real --test bar (lane dragfix,
 * 2026-10-08).
 *
 * WHY. Drag to reorder shipped on 2026-09-29 and never worked with a mouse. The user: "it lifts and
 * follows the mouse and then when you let go it stays where you stopped". Each icon is an <img>, and
 * Chromium drags images itself: at 4 px it started a Windows drag-and-drop, sent the bar a
 * pointercancel and kept the button-up, so the drop never landed and no order was ever saved. The
 * checks of the day DISPATCHED pointer events from script, which never start Chromium's own drag.
 *
 * WHAT. One Electron --test instance (invisible: lib/test-quiet.js) with a DevTools port. Into its
 * bar page only, through CDP Input.dispatchMouseEvent (the browser's own input path, the one a mouse
 * takes): press the first pin, move in steps two slots right, hold still, let go. Checks: no drag of
 * Chromium's own ever started (Input.setInterceptDrags is on from the first moment, so none could ever
 * reach the desktop either), no pointercancel, the icon lifts and the two it passes slide aside, the
 * bar stays up through the drag, the DOM order after the drop, no transform left on any icon, the click
 * that ends the drop does nothing, main saved the order to the profile's feature store, the bar still
 * re-renders from main afterwards, and after a restart of the instance the order is still there.
 * Nothing of the user's is touched: the test profile is %TEMP%\mantle-test-dragfix, no event goes to the
 * OS, and every click on the dock is stopped before it could open an app.
 *
 *   node ui/bar/drag.e2e.test.js
 *
 * Needs at least 3 pinned apps on this PC (the test bar reads Windows' pins, read-only). Refuses while
 * a game runs. Prints no app names. One summary line: "bar drag e2e: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE = 'dragfix';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const STORE = path.join(USER_DATA, 'features', 'jumplist.json');
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail !== undefined ? `${name} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : name);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The games themselves (the lane rule, ui/bar/page-harness.js gaming()): the Riot Client launcher is no game. */
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
const envMsg = Object.assign({}, env, { LOWCPU: '0' });

/* One run of the test instance: its output, and its exit. */
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}

/* CDP into the instance's BAR page, and nothing else: the port is the one THIS instance wrote into
   its own profile (--remote-debugging-port=0 picks a free one), and the page must be ui/bar. */
async function attach(run) {
  const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
  if (!port) throw new Error('the test instance never wrote its DevTools port');
  const tgt = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && /\/ui\/bar\/index\.html/.test(t.url) && t.url.startsWith('file:'));
  }, 90000, 500);
  if (!tgt) throw new Error('the bar page never showed up in the test instance');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
    else if (j.method) events.push(j.method);
  });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  // FIRST: no drag-and-drop of Chromium's own can reach Windows from here; one that starts is only reported
  await send('Input.setInterceptDrags', { enabled: true });
  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', { type, x, y, button: (type === 'mouseMoved' && !buttons) ? 'none' : 'left', buttons, clickCount: 1 });
  return { ws, send, ev, events, mouse, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

/* The pinned group, in the order it stands in the DOM (all of it: the save sends all of it). */
const PINNED = `[...document.querySelectorAll('#dock .cell')].filter((c) => c._item && c._item.kind !== 'running')`;
const pinnedIds = (c) => c.ev(`${PINNED}.map((c) => c.dataset.id)`);
/* The bar is held up (as a pointer over it would) by saying so to main the way the page itself does. */
const holdUp = (c, on) => c.ev(`(() => { clearInterval(window.__dragE2eHold); window.__dragE2eHold = 0;
  ${on ? "window.__dragE2eHold = setInterval(() => window.mantle.call('bar.hover', { inside: true }), 90); window.mantle.call('bar.hover', { inside: true });" : ''}
  return true; })()`);
const isUp = (c) => c.ev(`(() => { const s = ${PINNED}.filter((c) => !c.classList.contains('ovf')); if (s.length < 3) return false;
  const r = s[0].getBoundingClientRect(); return document.body.classList.contains('up') && r.top >= 0 && r.bottom <= innerHeight; })()`);
const readStore = () => { try { const j = JSON.parse(fs.readFileSync(STORE, 'utf8')); return (j && j.pins && Array.isArray(j.pins.order)) ? j.pins.order : null; } catch (_) { return null; } };
/* positions only, never ids (they name apps): where each of `ids` stands in `base` */
const where = (ids, base) => (ids || []).map((id) => base.indexOf(id));
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

async function run() {
  if (gaming()) { check('no game running (not launching an instance)', false); return; }
  let slot = null;
  for (const n of [1, 2]) {
    const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
    try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
  }
  if (!slot) { check('a test slot was free (mantle-slot-1/2 both taken; try again later)', false); return; }
  // a clean start: no saved order in this test profile
  try { fs.unlinkSync(STORE); } catch (_) { /* none */ }
  let r1 = null, r2 = null, c = null;
  const log = [];
  try {
    r1 = launch();
    c = await attach(r1);
    const n = await until(async () => { const ids = await pinnedIds(c); return ids && ids.length >= 3 ? ids.length : null; }, 120000, 500);
    if (!check('the test bar shows at least 3 pinned apps', !!n, 'this PC needs 3 pins for the drag test')) return;

    // The bar up, as it is under the user's pointer; a click on the dock never reaches the code that opens apps.
    await holdUp(c, true);
    check('the bar came up', !!(await until(() => isUp(c), 8000)));
    await sleep(700);   // the reveal's slide has landed
    await c.ev(`(() => { if (window.__dragE2e) return true;
      const L = window.__dragE2e = { cancel: 0, starts: [], leaked: 0, lifted: 0 };
      window.addEventListener('pointercancel', () => { L.cancel++; }, true);
      window.addEventListener('dragstart', (e) => { setTimeout(() => L.starts.push(e.defaultPrevented), 0); }, true);
      // after bar.js's own capture listener (the drop's swallow): a click that gets here would open an app
      document.getElementById('dock').addEventListener('click', (e) => { L.leaked++; e.stopPropagation(); e.preventDefault(); }, true);
      return true; })()`);

    const order0 = await pinnedIds(c);
    const rects = await c.ev(`${PINNED}.filter((c) => !c.classList.contains('ovf')).slice(0, 3).map((c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
    const pitch = rects[1].x - rects[0].x;
    const x0 = Math.round(rects[0].x), y = Math.round(rects[0].y), x1 = Math.round(rects[2].x);
    const mark = r1.out.length;

    // ---- the drag: press the first pin, move two slots right in 12 steps, hold still, let go
    await c.mouse('mouseMoved', x0, y, 0);
    await sleep(30);
    await c.mouse('mousePressed', x0, y, 1);
    let released = false;
    for (let i = 1; i <= 12; i++) {
      await c.mouse('mouseMoved', Math.round(x0 + (x1 - x0) * i / 12), y, 1);
      // From the lift on, the drag alone keeps the bar up (main cannot see this pointer). The stand-in for
      // the user's pointer ON the bar is let go only once the icon has lifted: let go before the press (as until
      // 10-17), nothing held the bar through those CDP round trips, which a real press (made on the bar)
      // never has; on a loaded PC that gap passed main's 180 + 180 ms and the bar began to leave (10-17 21:39).
      if (!released && await c.ev("!!document.querySelector('#dock .cell.lifted')")) { await holdUp(c, false); released = true; }
      await sleep(16);
    }
    if (!released) await holdUp(c, false);   // it never lifted: the 'lifted' check below says so
    await sleep(700);         // longer than main's 180 ms hide grace plus the 350 ms slide
    const mid = await c.ev(`(() => { const s = ${PINNED}; const tx = (e) => { const m = /translateX\\((-?[\\d.]+)px\\)/.exec(e.style.transform); return m ? Number(m[1]) : 0; };
      return { lifted: s[0].classList.contains('lifted'), t: s.slice(0, 4).map(tx), up: document.body.classList.contains('up') }; })()`);
    check('mid-drag: the pressed icon is lifted', mid.lifted, mid);
    check('mid-drag: it follows the pointer (two slots right)', Math.abs(mid.t[0] - (x1 - x0)) <= 1, mid.t);
    check('mid-drag: the two icons it passed slid one slot left, the next did not move',
      Math.abs(mid.t[1] + pitch) <= 1 && Math.abs(mid.t[2] + pitch) <= 1 && (mid.t[3] || 0) === 0, { t: mid.t, pitch });
    check('mid-drag: the bar stayed up while the button was held', mid.up && !/bar hidden|bar is leaving/.test(r1.out.slice(mark)),
      (r1.out.slice(mark).match(/.*(bar hidden|bar is leaving).*/) || [mid.up ? '' : 'the page slid away'])[0]);
    // every icon's item as it is now: a render of main's list after the drop replaces each one
    await c.ev(`(() => { [...document.querySelectorAll('#dock .cell')].forEach((c) => { if (c._item) c._item.__dragE2e = 1; }); return true; })()`);
    await c.mouse('mouseReleased', x1, y, 0);
    await holdUp(c, true);
    await sleep(800);         // the 150 ms glide, the save, main's reply

    // ---- after the drop
    const intercepted = c.events.filter((m) => m === 'Input.dragIntercepted').length;
    if (intercepted) { try { await c.send('Input.cancelDragging'); } catch (_) { /* nothing to cancel */ } }
    const L = await c.ev('window.__dragE2e');
    check('no drag of Chromium\'s own started (it is what took the drop away)', intercepted === 0 && L.starts.every(Boolean), { intercepted, dragstarts: L.starts });
    check('no pointercancel during the drag', L.cancel === 0, L.cancel);
    const order1 = await pinnedIds(c);
    const want = [order0[1], order0[2], order0[0]].concat(order0.slice(3));
    check('after the drop: the icon stands in the slot it was let go on', same(order1, want), where(order1, order0));
    const left = await c.ev(`(() => ({ tf: [...document.querySelectorAll('#dock .cell')].filter((c) => c.style.transform).length,
      cls: [...document.querySelectorAll('#dock .cell.lifted, #dock .cell.settle')].length,
      dock: ['dragging', 'no-anim'].filter((k) => document.getElementById('dock').classList.contains(k)) }))()`);
    check('after the drop: no transform left on any icon', left.tf === 0, left);
    check('after the drop: nothing is still lifted or settling', left.cls === 0 && left.dock.length === 0, left);
    check('the click that ends a drop opens nothing', L.leaked === 0, L.leaked);
    check('main saved it (count-only log line)', new RegExp(`jumplist: order: a pinned app moved 1 -> 3 of ${order0.length}, saved \\(in this test profile\\)`).test(r1.out.slice(mark)),
      (r1.out.slice(mark).match(/.*jumplist: order.*/) || ['no "order" line'])[0]);
    const stored = readStore();
    check('the feature store holds the new order', same(stored, order1), stored ? where(stored, order0) : 'no pins.order in the store');

    // ---- the bar still renders after a drop (a glide that never ended would hold every render back)
    const stale = await c.ev(`[...document.querySelectorAll('#dock .cell')].filter((c) => c._item && c._item.__dragE2e).length`);
    check('after the drop: the bar rendered main\'s list again (every icon\'s item is new)', stale === 0, `${stale} icons still hold the item from before the drop`);

    // ---- ...and takes the next drag: the icon now first, one slot right
    const r2nd = await c.ev(`${PINNED}.filter((c) => !c.classList.contains('ovf')).slice(0, 2).map((c) => Math.round(c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2))`);
    const mark2 = r1.out.length;
    await c.mouse('mouseMoved', r2nd[0], y, 0);
    await c.mouse('mousePressed', r2nd[0], y, 1);
    for (let i = 1; i <= 8; i++) { await c.mouse('mouseMoved', Math.round(r2nd[0] + (r2nd[1] - r2nd[0]) * i / 8), y, 1); await sleep(16); }
    await sleep(150);
    await c.mouse('mouseReleased', r2nd[1], y, 0);
    await sleep(800);
    const order1b = await pinnedIds(c);
    const want2 = [order1[1], order1[0]].concat(order1.slice(2));
    check('a second drag works after the first', same(order1b, want2), where(order1b, order0));
    check('...and is saved too', /jumplist: order: a pinned app moved 1 -> 2 of \d+, saved/.test(r1.out.slice(mark2)), (r1.out.slice(mark2).match(/.*jumplist: order.*/) || ['no "order" line'])[0]);
    check('...with no transform left', (await c.ev(`[...document.querySelectorAll('#dock .cell')].filter((c) => c.style.transform).length`)) === 0);
    const L2 = await c.ev('window.__dragE2e');
    check('...and its click opens nothing either', L2.leaked === 0 && L2.cancel === 0 && c.events.indexOf('Input.dragIntercepted') < 0, L2);
    check('the feature store holds the final order', same(readStore(), order1b), readStore() ? where(readStore(), order0) : 'no pins.order in the store');
    await holdUp(c, false);
    c.close(); c = null;

    // ---- restart: the order is still there
    second(['--quit']);
    check('the test instance quits', !!(await until(() => r1.exited, 30000)));
    check('no uncaught exception or handler failure (first run)', !/uncaught exception|handler threw|unhandled promise rejection/i.test(r1.out),
      (r1.out.match(/.*(uncaught exception|handler threw|unhandled promise rejection).*/i) || [''])[0]);
    log.push(r1.out);
    r2 = launch();
    c = await attach(r2);
    const order2 = await until(async () => { const ids = await pinnedIds(c); return ids && ids.length === order0.length ? ids : null; }, 120000, 500);
    check('after a restart: the dragged order is still the order', same(order2, order1b), order2 ? where(order2, order0) : 'the pins never came back');
    check('after a restart: the feature store still holds it', same(readStore(), order1b));
    c.close(); c = null;
    second(['--quit']);
    await until(() => r2.exited, 30000);
    check('no uncaught exception or handler failure (after the restart)', !/uncaught exception|handler threw|unhandled promise rejection/i.test(r2.out),
      (r2.out.match(/.*(uncaught exception|handler threw|unhandled promise rejection).*/i) || [''])[0]);
  } finally {
    if (c) c.close();
    for (const r of [r1, r2]) {
      if (r && !r.exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    }
    if (r2) log.push(r2.out); else if (r1 && !log.length) log.push(r1.out);
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    const file = path.join(os.tmpdir(), 'mantle-drag-e2e.log');
    try { fs.writeFileSync(file, log.join('\n----- restart -----\n')); console.log(`electron output: ${file}`); } catch (_) { /* best effort */ }
  }
}

(async () => {
  // A throw inside a check is a failure, never a silent exit 0.
  try { await run(); } catch (e) { check('ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`bar drag e2e: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
