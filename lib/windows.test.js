'use strict';
/*
 * windows.test.js - NO DRAG HANDLES on Mantle's frameless windows (lane tbdrift, 2026-09-27).
 *
 *   node lib/windows.test.js      -> "WINDOWS TEST: n passed, m failed"
 *
 * A RESIZABLE frameless Electron window answers WM_NCHITTEST with resize codes on the 5 DIP inside
 * every edge and corner, whatever thickFrame says; Owen's top bar was dragged to 673 DIP wide that way.
 * 1. Plain node: every frameless window Mantle builds says resizable:false, and the ones a raw
 *    SetWindowPos sizes go through noDragHandles(win, { rawSized: true }).
 * 2. One Electron child (this file with --electron-child): the REAL bottom bar window (createBar, the
 *    live shape, never shown and never topmost) and a plain window: the hit test says CLIENT at every
 *    edge and corner, and a raw SetWindowPos (what the sidecar's `place` does) still sizes the bar,
 *    also after an Electron setBounds. Only this child's own windows, hidden; no input, nothing of Owen's.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

if (process.argv.includes('--electron-child')) { child(); return; }

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

/* 1. the options, in the source that builds each window */
const optsOf = (file, anchor) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf(anchor);
  return at < 0 ? '' : src.slice(at, at + 2600);
};
const WINDOWS = [
  ['the bottom bar (lib/windows.js createBar, live shape)', 'lib/windows.js', '}) : Object.assign(common, {', /resizable: false,/, /noDragHandles\(win, \{ rawSized: true \}\)/],   // the live shape (the framed --test bar stays resizable)
  ['the Alt+Tab switcher (lib/switcher.js)', 'lib/switcher.js', 'const win = new BrowserWindow({', /resizable: false,/, /noDragHandles\(win, \{ rawSized: true \}\)/],
  ['snap (lib/features/snap.js)', 'lib/features/snap.js', 'function createWindow()', /resizable: false,/, null],
  ['task view (lib/features/taskview.js)', 'lib/features/taskview.js', 'const win = new BrowserWindow({', /resizable: false,/, null],
  ['the screenshot overlay and card (lib/features/screenshot.js baseWindow)', 'lib/features/screenshot.js', 'function baseWindow(', /resizable: false,/, /noDragHandles\(win, \{ rawSized: true \}\)/],
  ['the top bar (lib/features/topbar.js barWindowOptions)', 'lib/features/topbar.js', 'function barWindowOptions(', /resizable: false,/, null],
];
for (const [what, file, anchor, off, raw] of WINDOWS) {
  const o = optsOf(file, anchor);
  check(`options: ${what} is built resizable:false (no hit-test resize bands)`, !!o && off.test(o) && !/resizable:\s*true/.test(o.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').slice(0, 1400)), o ? 'resizable:true or no resizable:false' : 'anchor not found');
  if (raw) check(`options: ${what} is sized by a raw SetWindowPos, so it lifts the min = max pin (noDragHandles rawSized)`, raw.test(o), 'no noDragHandles(win, { rawSized: true })');
}

/* 2. the Electron child */
const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const games = (() => {
  try {
    const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 20000 });
    return Number(String(r.stdout).trim()) || 0;
  } catch (_) { return 0; }
})();
if (games) {
  check('electron: no game running (the Electron part was not run)', false, `${games} game process(es)`);
} else if (!fs.existsSync(exe)) {
  check('electron: node_modules/electron is installed', false, exe);
} else {
  const os = require('os');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-windows-test-'));
  const r = require('child_process').spawnSync(exe, [__filename, '--electron-child', `--user-data-dir=${ud}`], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* Electron may still hold a file */ }
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('WINDOWS-CHILD '));
  let got = null;
  try { got = line && JSON.parse(line.slice('WINDOWS-CHILD '.length)); } catch (_) { /* reported below */ }
  if (!got) {
    check('electron: the child ran and reported', false, `status ${r.status}; ${String(r.stderr || '').slice(-600)}`);
  } else {
    for (const c of got.checks) check(`electron: ${c.name}`, c.ok, c.detail);
  }
}

console.log(`WINDOWS TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);

/* ---- the Electron child ------------------------------------------------------------------------- */
function child() {
  const { app, BrowserWindow } = require('electron');
  const W = require('./windows');
  const koffi = require('koffi');
  const SetWindowPos = koffi.load('user32.dll').func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const check = (name, ok, detail) => checks.push(ok ? { name, ok: true } : { name, ok: false, detail: String(detail) });
  const NOMOVE = 0x0002, NOZORDER = 0x0004, NOACTIVATE = 0x0010;
  // the sidecar's `place`: a raw SetWindowPos in physical px (size only here; it stays hidden)
  const rawSize = async (win, w, h) => { SetWindowPos(Number(W.hwndOf(win)), 0, 0, 0, w, h, NOMOVE | NOZORDER | NOACTIVATE); await sleep(120); return win.getBounds(); };
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    try {
      // the REAL bottom bar window: the live shape, but test: never topmost, never shown
      const { win: bar } = W.createBar({ root: path.join(__dirname, '..'), test: true, barEdge: 'bottom', liveShape: true });
      await sleep(300);
      const z = W.hitZones(bar);
      check('the bottom bar: the hit test says CLIENT at all four edges and corners (no drag handles)', !W.dragHandles(z), JSON.stringify(z));
      check('the bottom bar: not resizable, and no min = max pin left on it', bar.isResizable() === false && bar.getMinimumSize().join() === '0,0' && bar.getMaximumSize().join() === '0,0',
        JSON.stringify({ resizable: bar.isResizable(), min: bar.getMinimumSize(), max: bar.getMaximumSize() }));
      const b1 = await rawSize(bar, 1100, 700);
      const sf = require('electron').screen.getPrimaryDisplay().scaleFactor;
      check('the bottom bar: a raw SetWindowPos (the sidecar\'s place) still sizes it (1100x700 px)', Math.abs(b1.width - 1100 / sf) <= 1 && Math.abs(b1.height - 700 / sf) <= 1, JSON.stringify({ b1, sf }));
      bar.setBounds({ x: b1.x, y: b1.y, width: 600, height: 200 });   // Electron pins min = max here; noDragHandles lifts it
      const b2 = bar.getBounds();
      const b3 = await rawSize(bar, 900, 500);
      check('the bottom bar: after an Electron setBounds (600x200) a raw SetWindowPos still sizes it (the pin is lifted)', b2.width === 600 && b3.width !== 600 && b3.height !== b2.height,
        JSON.stringify({ afterSetBounds: b2, afterRaw: b3 }));
      bar.setBounds(bar.getBounds());   // a SAME-size setBounds pins too, with no 'resize' event
      const b4 = await rawSize(bar, 700, 300);
      check('the bottom bar: after a same-size setBounds a raw SetWindowPos still sizes it', b4.width !== b3.width, JSON.stringify({ before: b3, after: b4 }));
      bar.destroy();

      // a window sized only by setBounds (snap, task view, the top bar): resizable:false is enough
      const plain = new BrowserWindow({ show: false, frame: false, transparent: true, resizable: false, thickFrame: false, width: 800, height: 500, x: 100, y: 100, webPreferences: { sandbox: true } });
      W.noDragHandles(plain);
      const zp = W.hitZones(plain);
      plain.setBounds({ x: 120, y: 90, width: 500, height: 300 });
      const p1 = plain.getBounds();
      check('setBounds-only window: no drag handles, and setBounds still sizes it (500x300)', !W.dragHandles(zp) && p1.width === 500 && Math.abs(p1.height - 300) <= 1, JSON.stringify({ zp, p1 }));
      plain.destroy();

      // the control: what today's resizable:true + thickFrame:false answered (so the checks above can fail)
      const old = new BrowserWindow({ show: false, frame: false, transparent: true, resizable: true, thickFrame: false, width: 800, height: 500, x: 100, y: 100, webPreferences: { sandbox: true } });
      const zo = W.hitZones(old);
      check('control: a resizable:true + thickFrame:false frameless window DOES have drag handles (the bug)', W.dragHandles(zo).split(' ').length === 8, JSON.stringify(zo));
      old.destroy();
    } catch (e) {
      check('the child finished', false, e.stack || e.message);
    }
    process.stdout.write('WINDOWS-CHILD ' + JSON.stringify({ checks }) + '\n');
    app.exit(0);
  });
}
