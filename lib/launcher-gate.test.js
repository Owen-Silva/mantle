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

function region(name) {
  const a = SRC.indexOf(`// <mainrel:${name}>`);
  const b = SRC.indexOf(`// </mainrel:${name}>`);
  if (a < 0 || b < a) throw new Error(`main.js has no <mainrel:${name}> region`);
  return SRC.slice(a, b);
}

function load(opts) {
  const o = opts || {};
  const said = { broadcast: [], page: [], out: [], sidecar: [], grants: 0, raised: 0, bd: [] };
  const win = {
    visible: false, focused: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isFocused() { return this.focused; },
    show() { this.visible = true; }, showInactive() { this.visible = true; }, hide() { this.visible = false; this.focused = false; },
    focus() { if (o.focusWorks) this.focused = true; },
    getBounds() { return { x: 100, y: 100, width: 680, height: 460 }; },
    webContents: { send(_ch, ev) { said.page.push(ev); } },
  };
  let backdropRelease = null;
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
    require: (m) => (m === './lib/surface-gate' ? gateForVm : require(m)),
    process: { stdout: { write: (x) => said.out.push(String(x)) } },
    Promise, setTimeout, clearTimeout, setImmediate,
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
    screen: { getCursorScreenPoint: () => o.cursor || { x: 5, y: 5 } },
  };
  vm.createContext(sandbox);
  vm.runInContext(region('launcher') + '\nglobalThis.__api = { showLauncher, hideLauncher, toggleLauncher, launcherGotKeyboard, gate: launcherGate, kb: () => launcherKb, watch: () => launcherKbWatch };', sandbox);
  const api = sandbox.__api;
  api.win = win; api.said = said; api.keys = keys;
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
    await sleep(40);
    ok(L.kb().ok === true && L.kb().how === 'direct' && L.said.sidecar.length === 0, 'focus() worked: no retry, no line');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'works' });
    await L.toggleLauncher('the Win key');
    await sleep(40);
    ok(L.said.grants === 1 && L.said.sidecar.length === 1 && L.said.sidecar[0][0] === 'focus' && L.said.sidecar[0][1].hwnd === '123456',
      'focus() refused: the right is handed on and the sidecar focus ladder runs once');
    ok(L.kb().ok === true && L.kb().how === 'retry' && !L.said.page.some((e) => e.name === 'launcher.keyboard'), 'the retry took it: no line shown');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    await sleep(40);
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
    await sleep(40);
    L.keys.set(0x1B, true); L.tickWatch();
    ok(!L.win.visible, '#7: Esc closes it without the keyboard');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails' });
    await L.toggleLauncher('the Win key');
    await sleep(40);
    L.win.focused = true; L.launcherGotKeyboard(L.win);
    const last = L.said.page.filter((e) => e.name === 'launcher.keyboard').pop();
    ok(last && last.payload.ok === true && !L.watch() && L.kb().how === 'click', 'a click in it gave it the keyboard: the line goes, the watch stops');
    await L.toggleLauncher('the Win key');
    ok(!L.win.visible, 'and the Win tap still closes it');
  }
  {
    const L = load({ focusWorks: false, sidecarFocus: 'fails', noKeys: true });
    await L.toggleLauncher('the Win key');
    await sleep(40);
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

  if (failures.length) for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`LAUNCHER GATE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((err) => { console.log(`LAUNCHER GATE TEST: crashed (${err.stack})`); process.exitCode = 1; });
