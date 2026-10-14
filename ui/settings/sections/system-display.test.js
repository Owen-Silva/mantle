require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* system-display.test.js — Mantle Settings > System > Display (lane sysdisp2, 2026-09-28).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/system.js) against SysDisplay.cs:
 * every display reading/change it names is a real sysdisplay.* command, the administrator action is a
 * real [Elevated] one, a test run sends EVERY display write as a dryRun and never sends keep/revert at
 * all, and the sidecar's keep/revert events reach the page as settings.system.display. Plus the page
 * file's shape (model.js checkSection) and that every search row of the Display page is drawn by it.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file
 * sections/system.js on the settings lane's mock (mock-mantle.js), with settings.system.* played by
 * FAKE() below over MADE-UP fixtures (two displays, a change waiting to be kept, a declined administrator
 * prompt, read-only rows with their reasons). Screenshots go to MANTLE_SHOOT_OUT (default
 * scratchpad/lanes/sysset-shots). Line 1 is the machine-wide CPU cap and browser lock.
 *
 *   node ui/settings/sections/system-display.test.js      (ONLY=disp-02,disp-05 for some shots)
 * Prints "SYSDISPLAY PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/sysset-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

/* The games themselves (the lane rule is VALORANT*). Not the Riot Client: it stays in the tray after a
   session, and while it alone runs no game is being played. */
function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysDisplay.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(sysdisplay\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  check('SysDisplay.cs lists its commands', cmds.size >= 15, [...cmds].join(' '));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'system.js'));
  const readNames = Object.values(main.READS).map((x) => x[0]).filter((c) => c.startsWith('sysdisplay.'));
  const writeNames = Object.values(main.WRITES).filter((c) => c.startsWith('sysdisplay.'));
  check('main: every display reading is a real SysDisplay command', readNames.length === 3 && readNames.every((c) => cmds.has(c)), readNames.filter((c) => !cmds.has(c)).join(' '));
  check('main: every display change is a real SysDisplay command', writeNames.every((c) => cmds.has(c)), writeNames.filter((c) => !cmds.has(c)).join(' '));
  const reachable = new Set(readNames.concat(writeNames));
  const missing = [...cmds].filter((c) => c !== 'sysdisplay.decide' && c !== 'sysdisplay.testArm' && !reachable.has(c));
  check('main: every SysDisplay command but the pure planner and the test-only arm can be reached', !missing.length, missing.join(' '));
  check('main: the test-only sysdisplay.testArm can NOT be reached from the page', !reachable.has('sysdisplay.testArm'));
  check('main: the GPU scheduling administrator action is SysDisplay\'s [Elevated] one', elevated.has('sysdisplay.gpuScheduling') && Object.prototype.hasOwnProperty.call(main.ADMIN, 'sysdisplay.gpuScheduling'));

  // a test run: every display write is a dry run; keep and revert never reach the sidecar
  const sent = [];
  const events = {};
  const pushed = [];
  const mk = (test) => ({ test, log() {}, push: (ev, p) => pushed.push([ev, p]), elevate: async () => ({ ok: false, kind: 'cancelled' }),
    sidecar: { on: (ev, fn) => { events[ev] = fn; return () => { delete events[ev]; }; },
      send: async (c, a) => { sent.push([c, a]); return { ok: true, result: a.dryRun ? { ok: true, dryRun: true, wouldRefuse: null,
        writes: c === 'sysdisplay.mode' ? [{ api: 'ChangeDisplaySettingsEx', width: 2560, height: 1600, hz: 60, orientation: 'landscape' }]
          : c === 'sysdisplay.nightlightSet' ? [{ api: 'registry', hive: 'HKCU', name: 'Data', bytes: 'aabbcc' }] : [] }
        : c === 'sysdisplay.gpuSchedulingSet' ? { ok: false, needsAdmin: true, elevate: 'sysdisplay.gpuScheduling', args: { on: a.on }, reason: 'Windows will ask for administrator permission to turn hardware-accelerated GPU scheduling on or off' }
          : { ok: true, changed: true } }; } } });
  const T = mk(true);
  const W = {
    displayMode: { display: 'k-1', width: 2560, height: 1600, hz: 60 }, topology: { mode: 'extend' }, primary: { display: 'k-2' },
    arrange: { positions: [{ display: 'k-2', x: 2560, y: 0 }] }, scale: { display: 'k-1', percent: 125 }, hdr: { display: 'k-2', on: true },
    nightlightSet: { from: '20:00' }, gpuPrefSet: { app: 'C:\\Made\\up.exe', pref: 2 }, gpuGlobalSet: { key: 'AutoHDREnable', on: true }, gpuSchedulingSet: { on: false },
  };
  for (const [what, args] of Object.entries(W)) {
    sent.length = 0;
    const r = await main.commands.write(Object.assign({ what }, args), T);
    check(`test run: ${what} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && !('what' in sent[0][1]), JSON.stringify([r, sent]));
  }
  sent.length = 0;
  const m = await main.commands.write(Object.assign({ what: 'displayMode' }, W.displayMode), T);
  check('test run: a dry mode change says what it would set', /2560 x 1600 at 60 Hz, landscape/.test(m.reason), m.reason);
  const nl = await main.commands.write({ what: 'nightlightSet', from: '20:00' }, T);
  check('test run: a dry night light change names the value, not "undefined"', /Data = 3 bytes/.test(nl.reason) && !/undefined/.test(nl.reason), nl.reason);
  for (const what of ['displayKeep', 'displayRevert']) {
    sent.length = 0;
    const r = await main.commands.write({ what, token: 'tok-1' }, T);
    check(`test run: ${what} never reaches the sidecar`, r.ok && r.dryRun && sent.length === 0 && /test run/.test(r.reason), JSON.stringify([r, sent]));
  }
  const a = await main.commands.admin({ action: 'sysdisplay.gpuScheduling', args: { on: true } }, T);
  check('test run: the GPU scheduling administrator action is a dry run', a.ok && a.dryRun && /hardware-accelerated GPU scheduling/.test(a.reason), JSON.stringify(a));

  // a live run: keep/revert go through, and needsAdmin comes back as a refusal the page can act on
  const L = mk(false);
  sent.length = 0;
  const k = await main.commands.write({ what: 'displayKeep', token: 'tok-9' }, L);
  check('live: keep sends the token and no dryRun', sent.length === 1 && sent[0][0] === 'sysdisplay.keep' && sent[0][1].token === 'tok-9' && !('dryRun' in sent[0][1]) && k.ok, JSON.stringify(sent));
  const g = await main.commands.write({ what: 'gpuSchedulingSet', on: true }, L);
  check('live: GPU scheduling answers needsAdmin with its [Elevated] name', g.ok === false && g.needsAdmin === true && g.elevate === 'sysdisplay.gpuScheduling', JSON.stringify(g));
  const ad = await main.commands.admin({ action: 'sysdisplay.gpuScheduling', args: { on: true } }, L);
  check('live: a declined administrator prompt comes back as cancelled', ad.ok === false && ad.cancelled === true, JSON.stringify(ad));

  // the keep/revert events reach the open page
  const stop = main.install(L);
  check('install: listens to the sidecar\'s sysdisplay events', typeof events.sysdisplay === 'function');
  events.sysdisplay && events.sysdisplay({ what: 'reverted', token: 'tok-9', kind: 'mode', why: 'timeout', ok: true });
  check('install: a sysdisplay event is pushed as settings.system.display', pushed.length === 1 && pushed[0][0] === 'settings.system.display' && pushed[0][1].why === 'timeout', JSON.stringify(pushed));
  stop();
  check('install: stop unsubscribes', !events.sysdisplay);

  // the page file: shape, and every search row of the Display page is one it draws
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  let def = null;
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'system.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(d) { def = d; } }, window: {}, document: { currentScript: { dataset: { section: 'system' } } }, console });
  check('page: checkSection is happy', def && M.checkSection(def, 'system') === null, def && M.checkSection(def, 'system'));
  const pg = def && def.pages.find((p) => p.id === 'display');
  check('page: Display is drawn natively (a render, not the built-in placeholder)', pg && typeof pg.render === 'function' && pg.title === 'Display');
  const body = src.slice(src.indexOf('function renderDisplay('), src.indexOf('/* ---------------------------------------------------------------- Storage'));
  const drawn = (row) => body.includes(`'${row}'`) || body.includes(`\`${row}\${s}\``) ||
    (/^system\.display\.gpu\.[A-Za-z]+$/.test(row) && body.includes('`system.display.gpu.${id}`') && src.includes(`'${row.split('.').pop()}'`));
  const notDrawn = (pg ? pg.search : []).filter((s) => !drawn(s.row));
  check('page: every Display search row is drawn by renderDisplay', pg && pg.search.length >= 15 && !notDrawn.length, notDrawn.map((s) => s.row).join(' '));
  check('page: a test run never calls qs.set from the slider or switch', /if \(kit\.test\) return \{ ok: true, dryRun: true/.test(body) && /onInput: \(v\) => \{ if \(!kit\.test\) live\(v\)/.test(body));
}

/* ================================================================ PART 2: the page on the mock */
/* Runs IN THE PAGE (addInitScript): wraps mock-mantle.js's window.mantle. Everything is made up. */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('disp') || 'two';
  const KEEPMS = Number(q.get('keepms')) || 15000, STALE = q.get('stale') === '1';   // the keep window; keep/revert find nothing waiting
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const emit = (ev, p) => setTimeout(() => window.__mockEmit && window.__mockEmit(ev, p), 20);
  const modes = (list) => list.flatMap(([w, h, hzs, nat]) => hzs.map((hz) => ({ width: w, height: h, hz, native: !!nat })));
  const D1 = { display: '00000000000a1b2c-1001', name: 'Built-in display', kind: 'internal', connector: 'internal', active: true, available: true, primary: true,
    bounds: { x: 0, y: 0, width: 2560, height: 1600 }, resolution: { width: 2560, height: 1600 }, refreshHz: 120, orientation: 'landscape',
    native: { width: 2560, height: 1600, hz: 120 }, modes: modes([[2560, 1600, [120, 60], true], [1920, 1200, [120, 60]], [1680, 1050, [60]], [1280, 800, [60]]]),
    scale: { percent: 150, recommended: 150, allowed: [100, 125, 150, 175, 200], reason: null },
    hdr: { supported: false, enabled: false, writable: false, reason: 'this display does not report HDR support to Windows' }, reason: null };
  const D2 = { display: '00000000000a1b2c-1002', name: 'Studio Monitor 27 (made up)', kind: 'external', connector: 'HDMI', active: true, available: true, primary: false,
    bounds: { x: 2560, y: 0, width: 3840, height: 2160 }, resolution: { width: 3840, height: 2160 }, refreshHz: 60, orientation: 'landscape',
    native: { width: 3840, height: 2160, hz: 60 }, modes: modes([[3840, 2160, [60, 30], true], [2560, 1440, [144, 120, 60]], [1920, 1080, [144, 60]]]),
    scale: { percent: 150, recommended: 150, allowed: [100, 125, 150, 175, 200, 225, 250, 300], reason: null },
    hdr: { supported: true, enabled: false, writable: true, reason: null, sdrWhiteNits: 240 }, reason: null };
  const F = {
    displays: SCN === 'single' ? [D1] : [D1, D2],
    topology: SCN === 'single' ? { current: 'internal', available: ['internal'], unavailable: { clone: 'Windows refused the layout (error 87: the parameter is incorrect)', extend: 'Windows refused the layout (error 87: the parameter is incorrect)' } }
      : { current: 'extend', available: ['internal', 'clone', 'extend', 'external'], unavailable: {} },
    customScale: { on: false, percent: null, writable: false, why: 'custom scaling only takes effect after signing out, so Mantle shows it but does not set it (use per-display scale)' },
    pending: SCN === 'pending' ? { token: 'tok-1', kind: 'mode', revertsInMs: 12000 } : null,
  };
  if (SCN === 'pending') { D2.resolution = { width: 2560, height: 1440 }; D2.refreshHz = 144; D2.bounds = { x: 2560, y: 0, width: 2560, height: 1440 }; }
  let until = F.pending ? Date.now() + F.pending.revertsInMs : 0;
  const NIGHT = { ok: true, present: true, on: false, schedule: { value: 'hours' }, from: { hour: 21, minute: 0, text: '21:00' }, to: { hour: 7, minute: 0, text: '07:00' },
    sunset: null, sunrise: null, strength: { percent: null, kelvin: null, reason: 'the settings hold no strength, so Windows uses its default (the field appears once the Strength slider is moved)' },
    writable: { hours: true, strength: false, schedule: false, why: 'only the set-hours start/end (whole hours) are in the layout measured here; strength and schedule would add fields not measured on this machine' } };
  const GPU = { ok: true, appsReason: null, gpusReason: null,
    apps: [{ app: 'C:\\Games\\Made Up Racer\\racer.exe', pref: 2 }, { app: 'C:\\Tools\\PhotoLab\\photolab.exe', pref: 1 }, { app: 'Contoso.VideoEditor_8wekyb3d8bbwe!App', pref: 0 }],
    global: { SwapEffectUpgradeEnable: { on: true }, VRROptimizeEnable: { on: null, reason: 'not set: Windows\' default applies' }, AutoHDREnable: { on: false } },
    gpuScheduling: { on: true, supported: true, enabledNow: true, writable: true, restartPending: false, reason: null },
    gpus: [{ name: 'Made-up Integrated Graphics', hybrid: 'integrated', displaySupported: true, gpuScheduling: { supported: false, enabled: false } },
      { name: 'Made-up Discrete GPU 4000', hybrid: 'discrete', displaySupported: true, gpuScheduling: { supported: true, enabled: true } }] };
  const disp = () => {
    if (F.pending) F.pending.revertsInMs = Math.max(0, until - Date.now());
    return Object.assign({ ok: true, inactiveReason: null }, JSON.parse(JSON.stringify({ displays: F.displays, topology: F.topology, customScale: F.customScale, pending: F.pending })));
  };
  const no = (why) => ({ ok: false, reason: why });
  function read(a) {
    if (SCN === 'fail') return later(40, no(a.what === 'gpu' ? 'the sidecar is not running (made up)' : 'sysdisplay.get failed: the sidecar is not running (made up)'));
    if (a.what === 'display') return later(40, disp());
    if (a.what === 'nightlight') return later(30, JSON.parse(JSON.stringify(NIGHT)));
    if (a.what === 'gpu') return later(30, JSON.parse(JSON.stringify(GPU)));
    return later(10, no(`fake: no reading "${a.what}"`));
  }
  let timer = null;
  function arm(kind) {
    const tok = 'tok-' + Math.random().toString(36).slice(2, 7);
    F.pending = { token: tok, kind, revertsInMs: KEEPMS };
    until = Date.now() + KEEPMS;
    clearTimeout(timer);
    timer = setTimeout(() => { if (F.pending && F.pending.token === tok) { F.pending = null; emit('settings.system.display', { ev: 'sysdisplay', what: 'reverted', token: tok, kind, why: 'timeout', ok: true }); } }, KEEPMS);
    emit('settings.system.display', { ev: 'sysdisplay', what: 'pending', token: tok, kind, keepWithinMs: KEEPMS });
    return { ok: true, changed: true, pending: true, token: tok, keepWithinMs: KEEPMS, note: 'not saved yet' };
  }
  function write(a) {
    if (TEST) {
      if (a.what === 'displayKeep' || a.what === 'displayRevert') return later(20, { ok: true, dryRun: true, reason: 'test run: nothing was kept (a test run never changes a display, so no change is waiting)' });
      return later(30, { ok: true, dryRun: true, reason: `test run: nothing was changed (would write: ${a.what === 'displayMode' ? `ChangeDisplaySettingsEx ${a.width} x ${a.height}` : a.what})` });
    }
    const d = F.displays.find((x) => x.display === a.display);
    if (F.pending && ['displayMode', 'topology', 'primary', 'arrange'].includes(a.what)) return later(30, no(`a display change is still waiting to be kept or reverted (${Math.ceil(Math.max(0, until - Date.now()) / 1000)} s left); keep or revert it first`));
    // stale: the change ended elsewhere, so Windows has nothing waiting any more (the next read says so too)
    if (STALE && (a.what === 'displayKeep' || a.what === 'displayRevert')) return (F.pending = null), later(20, no('no display change is waiting with that token (it was already kept or reverted)'));
    switch (a.what) {
      case 'displayMode': if (d) { d.resolution = { width: a.width, height: a.height }; if (a.hz) d.refreshHz = a.hz; if (a.orientation) d.orientation = a.orientation; } return later(60, arm('mode'));
      case 'topology': F.topology.current = a.mode; return later(60, arm('topology'));
      case 'primary': F.displays.forEach((x) => { x.primary = x === d; }); return later(60, arm('primary'));
      case 'arrange': return later(60, arm('arrange'));
      case 'displayKeep': case 'displayRevert': {
        if (!F.pending || F.pending.token !== a.token) return later(20, no('no display change is waiting with that token (it was already kept or reverted)'));
        const p = F.pending; F.pending = null;
        emit('settings.system.display', { ev: 'sysdisplay', what: a.what === 'displayKeep' ? 'kept' : 'reverted', token: p.token, kind: p.kind, why: 'asked', ok: true });
        return later(40, a.what === 'displayKeep' ? { ok: true, kept: true, kind: p.kind } : { ok: true, reverted: true });
      }
      case 'scale': if (d) d.scale.percent = a.percent; return later(40, { ok: true, changed: true, percent: a.percent });
      case 'hdr': if (d) d.hdr.enabled = a.on; return later(40, { ok: true, changed: true, on: a.on });
      case 'nightlightSet': return later(40, a.from || a.to ? { ok: true, changed: true, after: Object.assign({}, NIGHT, a.from ? { from: { text: a.from } } : { to: { text: a.to } }) } : no('turning the schedule on adds a field this machine\'s night light settings have not shown, a layout Mantle has not measured here, so nothing was written'));
      case 'gpuSchedulingSet': return later(40, { ok: false, needsAdmin: true, elevate: 'sysdisplay.gpuScheduling', args: { on: a.on }, reason: 'Windows will ask for administrator permission to turn hardware-accelerated GPU scheduling on or off' });
      case 'gpuGlobalSet': GPU.global[a.key] = { on: a.on }; return later(40, { ok: true, changed: true, on: a.on, note: 'games pick it up the next time they start' });
      case 'gpuPrefSet': { const x = GPU.apps.find((y) => y.app === a.app); if (x) x.pref = a.pref; else GPU.apps.push({ app: a.app, pref: a.pref }); return later(40, { ok: true, changed: true, pref: a.pref }); }
      default: return later(10, no(`fake: no change "${a.what}"`));
    }
  }
  function admin(a) {
    if (TEST) return later(20, { ok: true, dryRun: true, reason: 'test run: Windows would ask for administrator permission to turn hardware-accelerated GPU scheduling on or off; nothing was changed' });
    return later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });   // the declined prompt
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'system', file: 'sections/system.js', down: null, main: null }] });
        const mine = name === 'settings.system.read' ? read(copy) : name === 'settings.system.write' ? write(copy) : name === 'settings.system.admin' ? admin(copy) : null;
        if (!mine) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return mine;
      } };
    },
  });
}

const sel = (row) => `[data-row="${row}"]`;
const rowText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel(row));
const shown = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent; }, sel(row));
const scrollTo = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'start' }); }, sel(row));
const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const PG = '?section=system&page=display';
const KEPT_HIDE = 6000;   // system.js KEPT_HIDE_MS

const SHOTS = [
  ['disp-01-top', PG + '&disp=pending', async (p) => {
    check('01: the countdown shows', /Keep these display settings\?/.test(await rowText(p, 'system.display.keep') || '') && /Going back in \d+ s/.test(await rowText(p, 'system.display.keep') || ''), await rowText(p, 'system.display.keep'));
    check('01: keep and revert buttons are there', await shown(p, 'system.display.keep.yes') && await shown(p, 'system.display.keep.no'));
    check('01: brightness reads 66%', /66%/.test(await rowText(p, 'display.brightness') || ''), await rowText(p, 'display.brightness'));
    check('01: night light hours are read (21:00)', await p.$eval(sel('system.display.nightlight.from') + ' select', (s) => s.value) === '21:00');
    const st = await rowText(p, 'system.display.nightlight.strength');
    check('01: strength is read-only WITH its reason', /Read only here: Windows has not stored a strength/.test(st) && await p.$eval(sel('system.display.nightlight.strength') + ' input', (i) => i.disabled), st);
    check('01: the schedule is read-only WITH its reason', /Read only here/.test(await rowText(p, 'system.display.nightlight.schedule') || ''));
  }],
  ['disp-02-monitors', PG, async (p) => {
    check('02: two display cards', await p.locator('[data-row^="display.monitor."]').count() === 2);
    check('02: the main display is listed first', /Built-in display/.test(await rowText(p, 'display.monitor.0') || '') && /Main display/.test(await rowText(p, 'display.monitor.0') || ''));
    const opts = await p.$$eval(sel('system.display.resolution.2') + ' option', (o) => o.map((x) => x.textContent));
    check('02: resolutions listed with Windows\' recommended one', opts.length === 3 && /3840 × 2160 \(Recommended\)/.test(opts[0]), opts.join(' | '));
    const hz = await p.$$eval(sel('system.display.refresh') + ' option', (o) => o.map((x) => x.textContent));
    check('02: refresh rates at the current size', hz.join(',') === '120 Hz,60 Hz', hz.join(','));
    check('02: HDR on the built-in is read-only WITH its reason', /Read only here: this display does not report HDR/.test(await rowText(p, 'system.display.hdr') || ''));
    check('02: HDR on the external can be switched', await p.$eval(sel('system.display.hdr.2') + ' button', (b) => !b.disabled));
    check('02: the second display has a position (right of the main one)', await shown(p, 'system.display.position.2') && await p.$eval(sel('system.display.position.2') + ' select', (s) => s.value) === 'right');
    check('02: the main display has no position row', !(await shown(p, 'system.display.position')));
    check('02: custom scaling is read-only WITH its reason', /Read only here: custom scaling only takes effect after signing out/.test(await rowText(p, 'system.display.customScale') || ''));
    check('02: the arrangement map draws both displays', await p.$eval(sel('system.display.arrange') + ' + .card', (c) => c.querySelectorAll('[title]').length) === 2);
    await scrollTo(p, 'system.display.hdr.2');
  }],
  ['disp-03-graphics', PG, async (p) => {
    check('03: three apps with their own graphics setting', await p.locator('[data-row^="system.display.gpu.apps."]').count() === 3);
    check('03: an app shows its preference', /High performance/.test(await rowText(p, 'system.display.gpu.apps.a0') || ''));
    check('03: GPU scheduling carries the shield and says so before the click', /Windows will ask for administrator permission to turn hardware-accelerated GPU scheduling/.test(await rowText(p, 'system.display.gpu.scheduling') || ''));
    check('03: VRR not set says Windows\' default applies', /Windows' default applies/.test(await rowText(p, 'system.display.gpu.vrr') || ''));
    await p.click(sel('system.display.gpu.scheduling') + ' button[role="switch"]');
    await p.waitForTimeout(400);
    const t = await rowText(p, 'system.display.gpu.scheduling');
    check('03: a declined administrator prompt says so and springs back', /You said no to the administrator prompt; nothing changed/.test(t) && await p.$eval(sel('system.display.gpu.scheduling') + ' button[role="switch"]', (b) => b.getAttribute('aria-checked')) === 'true', t);
    const a = await calls(p, 'settings.system.admin');
    check('03: the prompt went through settings.system.admin as sysdisplay.gpuScheduling', a.length === 1 && a[0].args.action === 'sysdisplay.gpuScheduling' && a[0].args.args.on === false, JSON.stringify(a));
    await scrollTo(p, 'system.display.gpu');
  }],
  ['disp-04-change', PG, async (p) => {
    await p.selectOption(sel('system.display.resolution.2') + ' select', '2560x1440');
    await p.waitForTimeout(400);
    check('04: a real change starts the countdown', /Going back in 1[45] s/.test(await rowText(p, 'system.display.keep') || ''), await rowText(p, 'system.display.keep'));
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'displayMode');
    check('04: the change named the display and the size', w && w.args.display === '00000000000a1b2c-1002' && w.args.width === 2560 && w.args.height === 1440, JSON.stringify(w));
    await p.click(sel('system.display.keep.no') + ' button');
    await p.waitForTimeout(400);
    const t = await rowText(p, 'system.display.keep');
    check('04: Revert puts it back and says so', /Put back/.test(t) && /You chose Revert/.test(t) && !(await shown(p, 'system.display.keep.yes')), t);
    await scrollTo(p, 'system.display.keep');
  }],
  ['disp-05-kept', PG + '&disp=pending', async (p) => {
    await p.click(sel('system.display.keep.yes') + ' button');
    await p.waitForTimeout(400);
    const t = await rowText(p, 'system.display.keep');
    check('05: Keep changes keeps it and says so', /Kept/.test(t) && !(await shown(p, 'system.display.keep.no')), t);
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'displayKeep');
    check('05: keep sent the waiting token', w && w.args.token === 'tok-1', JSON.stringify(w));
  }],
  ['disp-06-testrun', PG + '&test=1', async (p) => {
    await p.selectOption(sel('system.display.resolution.2') + ' select', '1920x1080');
    await p.$eval(sel('display.brightness') + ' input', (i) => { i.value = '40'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
    await p.click(sel('system.display.gpu.scheduling') + ' button[role="switch"]');
    await p.waitForTimeout(500);
    const t = await rowText(p, 'system.display.resolution.2');
    check('06: a test-run resolution change is a dry run with its note, and springs back', /test run: nothing was changed/i.test(t) && await p.$eval(sel('system.display.resolution.2') + ' select', (s) => s.value) === '3840x2160', t);
    check('06: no countdown in a test run', !(await shown(p, 'system.display.keep')));
    const qs = await calls(p, 'qs.set');
    check('06: a test run never sets the brightness', qs.length === 0 && /test run: the brightness was not changed \(would set 40%\)/i.test(await rowText(p, 'display.brightness') || ''), JSON.stringify(qs));
    check('06: GPU scheduling in a test run is a dry run too', /test run/i.test(await rowText(p, 'system.display.gpu.scheduling') || ''));
    await scrollTo(p, 'display.monitor.1');
  }],
  ['disp-07-single', PG + '&disp=single', async (p) => {
    check('07: one display card', await p.locator('[data-row^="display.monitor."]').count() === 1);
    const t = await rowText(p, 'system.display.topology');
    check('07: multiple displays is read-only WITH its reason', /Read only here: only one display is connected/.test(t) && await p.$eval(sel('system.display.topology') + ' select', (s) => s.disabled), t);
    check('07: nothing to arrange, said on the page', /Only one display is in use/.test(await p.$eval(sel('system.display.arrange') + ' + .card', (c) => c.textContent)));
    check('07: the only display is the main one, said on its button', /always the main one/.test(await rowText(p, 'system.display.primary') || ''));
    await scrollTo(p, 'display.monitors');
  }],
  ['disp-08-failing', PG + '&disp=fail', async (p) => {
    check('08: the displays say why they could not be read', /The displays could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'system.display.resolution') || ''));
    check('08: the night light schedule says why', /could not be read/.test(await rowText(p, 'system.display.nightlight.schedule') || ''));
    check('08: graphics says why', /could not be read/.test(await rowText(p, 'system.display.gpu.scheduling') || ''));
    check('08: brightness still works (its own backend)', /66%/.test(await rowText(p, 'display.brightness') || ''));
    check('08: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['disp-09-locked', PG + '&disp=pending', async (p) => {
    const dis = (row) => p.$eval(sel(row) + ' select, ' + sel(row) + ' button', (e) => e.disabled);
    check('09: while a change waits, the resolution row is locked and says why', await dis('system.display.resolution.2') && /Keep or revert the display change above first/.test(await rowText(p, 'system.display.resolution.2') || ''), await rowText(p, 'system.display.resolution.2'));
    check('09: ... and so are refresh rate, orientation, main display and Multiple displays', await dis('system.display.refresh.2') && await dis('system.display.orientation.2') && await dis('system.display.primary.2') && await dis('system.display.topology'));
    check('09: scale stays free (it has no countdown)', !(await dis('system.display.scale.2')));
    await p.click(sel('system.display.keep.no') + ' button');
    await p.waitForTimeout(500);
    check('09: after Revert the rows unlock and the line is gone', !(await dis('system.display.resolution.2')) && !(await dis('system.display.topology')) && !/Keep or revert the display change/.test(await p.textContent('#page')));
  }],
  ['disp-10-timeout', PG + '&keepms=1500', async (p) => {
    await p.selectOption(sel('system.display.resolution.2') + ' select', '2560x1440');
    await p.waitForTimeout(350);
    check('10: the countdown uses the change\'s own time', /Going back in [12] s/.test(await rowText(p, 'system.display.keep') || ''), await rowText(p, 'system.display.keep'));
    check('10: the other rows are locked meanwhile', await p.$eval(sel('system.display.refresh.2') + ' select', (e) => e.disabled));
    await p.waitForTimeout(2200);
    const t = await rowText(p, 'system.display.keep');
    check('10: not kept in time: put back by itself, and the page says why', /Put back/.test(t) && /not kept in time/.test(t) && !(await shown(p, 'system.display.keep.yes')), t);
    check('10: the rows unlock', !(await p.$eval(sel('system.display.refresh.2') + ' select', (e) => e.disabled)));
    await p.waitForTimeout(KEPT_HIDE + 400);
    check('10: a timed-out change stays explained (it is not hidden)', await shown(p, 'system.display.keep'));
  }],
  ['disp-11-stale', PG + '&disp=pending&stale=1', async (p) => {
    await p.click(sel('system.display.keep.yes') + ' button');
    await p.waitForTimeout(450);
    const t = await rowText(p, 'system.display.keep');
    check('11: Keep on a change that already ended says so, no dead buttons', /No longer waiting/.test(t) && !(await shown(p, 'system.display.keep.yes')) && !(await shown(p, 'system.display.keep.no')), t);
  }],
  ['disp-12-kept-hides', PG + '&disp=pending', async (p) => {
    await p.click(sel('system.display.keep.yes') + ' button');
    await p.waitForTimeout(450);
    check('12: Kept shows at once', /Kept/.test(await rowText(p, 'system.display.keep') || ''));
    await p.waitForTimeout(KEPT_HIDE + 400);
    check('12: ... and the note goes by itself once it is settled', !(await shown(p, 'system.display.keep')));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
    await ctx.addInitScript(FAKE);
    for (const [name, query, prep] of SHOTS) {
      if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
      await page.goto(PAGE + query, { waitUntil: 'load' });
      try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
      await page.waitForTimeout(400);
      try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
      await page.waitForTimeout(200);
      const probe = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
          if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        });
        const pg = document.getElementById('page');
        return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, ready: document.documentElement.dataset.ready, text: pg ? pg.textContent : '' };
      });
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      check(`${name}: drawn`, probe.rows > 10 && probe.ready === '1', `rows ${probe.rows}, ready ${probe.ready}`);
      check(`${name}: not DOWN, not the built-in page`, !/could not be drawn|did not load|Read only here \(Windows Settings\)/.test(probe.text) && /Graphics/.test(probe.text), probe.text.slice(0, 200));
      check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
      console.log(`${name}: ${probe.rows} rows`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SYSDISPLAY PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
