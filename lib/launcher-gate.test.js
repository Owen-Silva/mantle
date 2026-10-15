/*
 * launcher-gate.test.js -- main.js's launcher visibility (the `// <mainrel:launcher>` region), run as
 * the REAL code in a vm with a fake window, backdrop, sidecar and key state (lane mn-launch,
 * 2026-10-12; audit #5, #7, #14). main.js itself needs Electron; this region does not.
 *   #5  the Win tap / Start button toggle it, and launcher:visible true goes out only on a
 *       hidden -> shown change (the page wiped your query on every one);
 *   #14 a close during the first show's backdrop capture wins (it used to be dropped and the
 *       launcher appeared after you dismissed it); two taps while opening end closed;
 *   #7  live: no keyboard -> one retry through the sidecar's 'focus' with the foreground right
 *       handed on -> still none -> the page is told why, and a click outside or Esc closes it.
 *   node lib/launcher-gate.test.js
 * Prints "LAUNCHER GATE TEST: n passed, m failed".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
let passed = 0;
const failures = [];
function ok(cond, what) { if (cond) passed++; else failures.push(what); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Waits for the launcher's keyboard verdict (main's launcherKb leaves ok:null), bounded at 2 s, instead
   of a blind 40 ms: the checks read the verdict, so they wait for it, however busy the machine is
   (zero-fail lane, 2026-10-14). */
async function verdict(L) {
  const end = Date.now() + 2000;
  while (L.kb().ok === null && Date.now() < end) await sleep(5);
}

function region(name) {
  const a = SRC.indexOf(`// <mainrel:${name}>`);
  const b = SRC.indexOf(`// </mainrel:${name}>`);
  if (a < 0 || b < a) throw new Error(`main.js has no <mainrel:${name}> region`);
  return SRC.slice(a, b);
}

function load(opts) {
  const o = opts || {};
  const said = { broadcast: [], page: [], out: [], sidecar: [], grants: 0, raised: 0, bd: [], setBounds: [] };
  const win = {
    visible: false, focused: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isFocused() { return this.focused; },
    show() { this.visible = true; }, showInactive() { this.visible = true; }, hide() { this.visible = false; this.focused = false; },
    focus() { if (o.focusWorks) this.focused = true; },
    bounds: Object.assign({ x: 100, y: 100, width: 680, height: 460 }, o.bounds || {}),
    getBounds() { return Object.assign({}, this.bounds); },
    setBounds(r) { said.setBounds.push([Object.assign({}, r), said.bd.length]); this.bounds = Object.assign({}, r); },
    webContents: { send(_ch, ev) { said.page.push(ev); } },
  };
  let backdropRelease = null;
  const display = { d: o.display || { id: 1, bounds: { x: 0, y: 0, width: 880, height: 660 }, scaleFactor: 1 } };
  const keys = new Map();
  const realGate = require('./surface-gate');
  const watchTicks = [];
  const gateForVm = Object.assign({}, realGate, {
    watchOutside: (w) => realGate.watchOutside(Object.assign({}, w, {
      keys: o.noKeys ? undefined : { down: (vk) => !!keys.get(vk) },
      setInterval: (fn) => { watchTicks.push(fn); return watchTicks.length; },
      clearInterval: (id) => { watchTicks[id - 1] = null; },
    })),
    ensureKeyboard: (k) => realGate.ensureKeyboard(Object.assign({}, k, { setTimeout: (fn) => setTimeout(fn, 0) })),
  });
  if (o.noKeys) gateForVm.watchOutside = (w) => realGate.watchOutside(Object.assign({}, w, { keys: null }));
  const sandbox = {
    require: (m) => (m === './lib/surface-gate' ? gateForVm : m.startsWith('./lib/') ? require('./' + m.slice(6)) : require(m)),
    process: { stdout: { write: (x) => said.out.push(String(x)) } },
    Promise, setTimeout, clearTimeout, setImmediate,
    // main.js's own top-level import (line ~26) that launcherSay uses since the plain-words pass
    // (1c47276): without it every launcher.keyboard push threw inside launcherSay's try and the page
    // was never told, so 4 checks failed on every machine (zero-fail lane, 2026-10-14)
    toPage: require('./plain-error').toPage,
    launcherWin: win,
    flags: { test: !!o.test },
    broadcast: (n, p) => said.broadcast.push([n, p]),
    raiseWin: { up: () => { said.raised++; } },
    launcherBackdrop: {
      once: (why) => { said.bd.push(['once', why]); return o.slowBackdrop ? new Promise((r) => { backdropRelease = r; }) : Promise.resolve(); },
      start: (why) => said.bd.push(['start', why]),
      stop: (why) => said.bd.push(['stop', why]),
    },
    fgGrant: Object.assign({}, require('./fg-grant'), { grant: () => { said.grants++; return { granted: true, reason: null }; } }),
    sidecar: {
      info: { pid: 4242 },
      call: async (cmd, args) => {
        said.sidecar.push([cmd, args]);
        if (o.sidecarFocus === 'works') { win.focused = true; return { how: 'direct', ms: 3 }; }
        throw new Error('Windows refused the foreground change; tried direct: refused; attach: refused');
      },
    },
    // main.js's <mainrel:launcherwait> region (lane mn-speed; its own test is lib/launcher-wait.test.js):
    // here only its contract -- show once, when the first picture is back (the cap is tested there).
    launcherFirstPicture: (w, show) => { sandbox.launcherBackdrop.once('the launcher is opening').then(show, show); },
    hwndOf: () => '123456',
    // a FAKE screen whose main display a test changes (lane mn-display): o.display, then L.setDisplay(d)
    screen: { getCursorScreenPoint: () => o.cursor || { x: 5, y: 5 }, getPrimaryDisplay: () => display.d },
  };
  vm.createContext(sandbox);
  vm.runInContext(region('launcher') + '\nglobalThis.__api = { launcherRecentre, showLauncher, hideLauncher, toggleLauncher, launcherGotKeyboard, gate: launcherGate, kb: () => launcherKb, watch: () => launcherKbWatch };', sandbox);
  const api = sandbox.__api;
  api.win = win; api.said = said; api.keys = keys;
  api.setDisplay = (d) => { display.d = d; };
  api.release = () => { if (backdropRelease) { backdropRelease(); backdropRelease = null; } };
  api.tickWatch = () => watchTicks.forEach((f) => f && f());
  api.visibleTrues = () => said.broadcast.filter(([n, p]) => n === 'launcher:visible' && p === true).length;
  return api;
}

(async () => {
  // ---- #5: toggle, and one launcher:visible per real open -----------------------------------
  {
    const L = load({ focusWorks: true });
    await L.toggleLauncher('the Win key');
    ok(L.win.visible && L.gate.state === 'shown', 'Win tap opens');
    ok(L.visibleTrues() === 1, 'one launcher:visible true for the open');
    await L.showLauncher('Win+S');
    ok(L.win.visible && L.visibleTrues() === 1, 'Win+S over an open launcher: no second launcher:visible (nothing typed is wiped)');
    await L.toggleLauncher('the Win key');
    ok(!L.win.visible && L.gate.state === 'hidden', '#5: a second Win tap CLOSES it (it used to re-show and wipe the query)');
    ok(L.said.broadcast.some(([n, p]) => n === 'launcher:visible' && p === false), 'the close is broadcast');
    await L.toggleLauncher('the Start button');
    ok(L.win.visible && L.visibleTrues() === 2, 'the Start button opens it again, a new open');
    await L.toggleLauncher('the Start button');
    ok(!L.win.visible, '#5: the Start button closes it (the bar is unfocusable, so blur never did)');
    ok(L.said.bd.filter(([k]) => k === 'stop').length === 2, 'the backdrop loop stops on each close');
  }
  // ---- #14: a close while the first frame is captured -----------------------------------------
  {
    const L = load({ slowBackdrop: true, focusWorks: true });
    const p = L.toggleLauncher('the Win key');
    ok(!L.win.visible && L.gate.state === 'opening', 'opening: hidden while the first frame is captured');
    L.hideLauncher('esc');
    L.release();
    const r = await p;
    ok(!r.opened && !L.win.visible && L.visibleTrues() === 0, '#14: closed while opening -> it never appears (it used to show anyway)');
  }
  {
    const L = load({ slowBackdrop: true, focusWorks: true });
    const a = L.toggleLauncher('the Win key');
    const b = L.toggleLauncher('the Win key');
    L.release();
    await a; await b;
    ok(!L.win.visible && L.visibleTrues() === 0, '#14: two Win taps while opening -> closed, never shown');
    const c = L.toggleLauncher('the Win key'); L.release(); await c;
    ok(L.win.visible && L.visibleTrues() === 1, 'and the next tap opens normally');
  }
  {
    const L = load({ slowBackdrop: true, focusWorks: true });
    const a = L.showLauncher('the tray'); const b = L.showLauncher('Win+S');
    ok(L.said.bd.filter(([k]) => k === 'once').length === 1, 'two opens while opening: one capture, joined');
    L.release(); await a; await b;
    ok(L.win.visible && L.visibleTrues() === 1, 'joined opens: shown once, one launcher:visible');
  }
  // ---- --test: never focused, no keyboard ladder ----------------------------------------------
  {
    const L = load({ test: true });
    await L.toggleLauncher('the Win key');
    await sleep(40);
    ok(L.win.visible && !L.win.focused && L.said.sidecar.length === 0 && L.said.raised === 0, '--test: shown inactive, no focus retry, no raise');
  }
  // ---- #7: the keyboard, live -----------------------------------------------------------------
  {
    const L = load({ focusWorks: true });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    ok(L.kb().ok === true && L.kb().how === 'direct' && L.said.sidecar.length === 0, 'focus() worked: no retry, no line');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'works' });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    ok(L.said.grants === 1 && L.said.sidecar.length === 1 && L.said.sidecar[0][0] === 'focus' && L.said.sidecar[0][1].hwnd === '123456',
      'focus() refused: the right is handed on and the sidecar focus ladder runs once');
    ok(L.kb().ok === true && L.kb().how === 'retry' && !L.said.page.some((e) => e.name === 'launcher.keyboard'), 'the retry took it: no line shown');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    const line = L.said.page.find((e) => e.name === 'launcher.keyboard');
    ok(L.kb().ok === false && line && line.payload.ok === false, '#7: still no keyboard -> the page is told');
    ok(line && line.payload.text === 'No keyboard: Windows refused the foreground change. Click here to type; click outside or press Esc to close.',
      `the line, in plain words without the ladder's log (${line && line.payload.text})`);
    ok(L.said.out.some((x) => /shown WITHOUT the keyboard/.test(x)) && !L.said.out.some((x) => /undefined/.test(x)), 'and the log says it');
    ok(!!L.watch(), 'the outside-click / Esc watch runs');
    L.tickWatch();
    ok(L.win.visible, 'nothing pressed: stays');
    L.keys.set(0x01, true); L.tickWatch();
    ok(!L.win.visible && !L.watch() && L.gate.state === 'hidden', '#7: a click outside closes it');
    // the Start button's own click was that "outside" click: its toggle must not reopen it
    await L.toggleLauncher('the Start button');
    ok(!L.win.visible, 'the Start click that closed it does not reopen it');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    L.keys.set(0x1B, true); L.tickWatch();
    ok(!L.win.visible, '#7: Esc closes it without the keyboard');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    L.win.focused = true; L.launcherGotKeyboard(L.win);
    const last = L.said.page.filter((e) => e.name === 'launcher.keyboard').pop();
    ok(last && last.payload.ok === true && !L.watch() && L.kb().how === 'click', 'a click in it gave it the keyboard: the line goes, the watch stops');
    await L.toggleLauncher('the Win key');
    ok(!L.win.visible, 'and the Win tap still closes it');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails', noKeys: true });
    await L.toggleLauncher('the Win key');
    await verdict(L);
    const line = L.said.page.find((e) => e.name === 'launcher.keyboard');
    ok(line && /click here and press Esc to close/.test(line.payload.text), `no key-state binding: the line says how to close it anyway (${line && line.payload.text})`);
  }
  {
    // closed before the keyboard check ran: no retry, no line
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    L.hideLauncher('esc');
    await sleep(40);
    ok(L.said.sidecar.length === 0 && !L.said.page.some((e) => e.name === 'launcher.keyboard'), 'closed at once: no retry and no line afterwards');
  }
  {
    const L = load({ focusWorks: true });
    L.win.destroyed = true;
    const r = await L.toggleLauncher('the Win key');
    ok(!r.opened && /no launcher window/.test(r.reason) && L.hideLauncher('x').closed === false, 'no window: a reason, no throw');
  }

  // ---- a resolution or scale change: it opens centred on the main display AS IT IS NOW (lane mn-display) ----
  {
    // made on a 1920x1080 display: centred at 620,310
    const L = load({ focusWorks: true, display: { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, bounds: { x: 620, y: 310 } });
    await L.toggleLauncher('the Win key');
    ok(L.said.setBounds.length === 0, 'unchanged display: an open moves nothing (no setBounds)');
    await L.toggleLauncher('the Win key');
    // the resolution goes to 2560x1440: the next open is centred on THAT, before its first picture
    L.setDisplay({ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 });
    await L.toggleLauncher('the Win key');
    const [r1, bdAt] = L.said.setBounds[0] || [];
    ok(r1 && r1.x === 940 && r1.y === 490 && r1.width === 680 && r1.height === 460, `2560x1440: opens centred at 940,490, same size (${JSON.stringify(r1)})`);
    const firstOnce = L.said.bd.findIndex(([k]) => k === 'once');
    const opensBefore = L.said.bd.slice(0, bdAt).filter(([k]) => k === 'once').length;
    ok(r1 && opensBefore === 1 && firstOnce >= 0, 'it is moved BEFORE this open\'s first picture (only the earlier open\'s capture came before it)');
    ok(L.said.out.some((l) => /centred on the main display as it is now \(2560x1440/.test(l)), 'the move is logged with the display it centred on');
    // a scale change (125%: the DIP display is 1536x864) while it is UP: re-centred only by the display handler
    L.setDisplay({ id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 });
    await L.showLauncher('Win+S');
    ok(L.said.setBounds.length === 1, 'an open over a launcher that is up does not move it (only the display handler does)');
    const rr = L.launcherRecentre('display metrics changed');
    ok(rr.moved && L.win.bounds.x === 428 && L.win.bounds.y === 202, `the display handler centres the open launcher on 1536x864 (${JSON.stringify(L.win.bounds)})`);
    await L.toggleLauncher('the Win key');
    // another display becomes the main one (a monitor plugged in and made main): the next open is centred on it
    L.setDisplay({ id: 2, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 });
    await L.toggleLauncher('the Win key');
    ok(L.win.bounds.x === 300 && L.win.bounds.y === 130, `a different main display (1280x720): the next open is centred on it (${JSON.stringify(L.win.bounds)})`);
    // a display that reports no size: it opens where it was, and says why
    await L.toggleLauncher('the Win key');
    L.setDisplay({ id: 2, bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 });
    const n = L.said.setBounds.length;
    await L.toggleLauncher('the Win key');
    ok(L.win.visible && L.said.setBounds.length === n && L.said.out.some((l) => /reported no size, so the launcher opens where it was/.test(l)), 'a display with no size: it still opens, where it was, and the log says why');
  }

  if (failures.length) for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`LAUNCHER GATE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((err) => { console.log(`LAUNCHER GATE TEST: crashed (${err.stack})`); process.exitCode = 1; });
