require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* system-sound.test.js — Mantle Settings > System > Sound (lane syssnd, 2026-09-28).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/system.js) against SysSound.cs:
 * every sound reading/change it names is a real syssound.* command, the administrator action is SysSound's
 * [Elevated] one, a test run sends EVERY sound write (the test tone and the microphone test included) as a
 * dryRun, and the sidecar's syssound events reach the page as settings.system.sound. Plus the page file's
 * shape (model.js checkSection) and that every search row of the Sound page is drawn by renderSound.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on the
 * settings mock, with settings.system.* played by FAKE() over MADE-UP devices and apps (a declined
 * administrator prompt, a microphone test's events, read-only rows with their reasons). Shots go to
 * MANTLE_SHOOT_OUT (default scratchpad/lanes/syssnd-shots). Line 1 is the CPU cap and browser lock.
 *
 *   node ui/settings/sections/system-sound.test.js      (ONLY=snd-02 for some shots)
 * Prints "SYSSOUND PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/syssnd-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysSound.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(syssound\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  check('SysSound.cs lists its commands', cmds.size >= 14, [...cmds].join(' '));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'system.js'));
  const readNames = Object.values(main.READS).map((x) => x[0]).filter((c) => c.startsWith('syssound.'));
  const writeKeys = Object.keys(main.WRITES).filter((k) => main.WRITES[k].startsWith('syssound.'));
  const writeNames = writeKeys.map((k) => main.WRITES[k]);
  check('main: every sound reading is a real SysSound command', readNames.length === 4 && readNames.every((c) => cmds.has(c)), readNames.filter((c) => !cmds.has(c)).join(' '));
  check('main: every sound change is a real SysSound command', writeNames.length >= 10 && writeNames.every((c) => cmds.has(c)), writeNames.filter((c) => !cmds.has(c)).join(' '));
  const reachable = new Set(readNames.concat(writeNames));
  const missing = [...cmds].filter((c) => c !== 'syssound.decide' && !reachable.has(c));
  check('main: every SysSound command but the pure maths can be reached', !missing.length, missing.join(' '));
  check('main: the device-properties administrator action is SysSound\'s [Elevated] one', elevated.has('syssound.deviceProp') && Object.prototype.hasOwnProperty.call(main.ADMIN, 'syssound.deviceProp'));
  check('main: no sound write skips the dry run in a test (none is in NO_DRY)', writeKeys.every((k) => !main.NO_DRY[k]));

  const sent = [];
  const events = {};
  const pushed = [];
  const mk = (test) => ({ test, log() {}, push: (ev, p) => pushed.push([ev, p]), elevate: async () => ({ ok: false, kind: 'cancelled' }),
    sidecar: { on: (ev, fn) => { events[ev] = fn; return () => { delete events[ev]; }; },
      send: async (c, a) => { sent.push([c, a]); return { ok: true, result: a.dryRun ? { ok: true, dryRun: true, wouldRefuse: null,
        writes: c === 'syssound.setting' ? [{ api: 'registry', hive: 'HKCU', name: 'AccessibilityMonoMixState', value: 1 }] : [{ api: 'IAudioEndpointVolume.SetMasterVolumeLevelScalar', value: 0.4 }] } : { ok: true } }; } } });
  const Tst = mk(true);
  const args = { soundDefault: { device: 'd', role: 'default' }, soundLevel: { device: 'd', level: 40 }, soundProps: { device: 'd', prop: 'name', value: 'x' },
    soundEnable: { device: 'd', on: false }, soundSetting: { key: 'mono', value: true }, tone: { device: 'd' }, micTest: { device: 'd' },
    appSet: { app: 'pid:1', level: 5 }, appDevice: { app: 'pid:1', flow: 'output', device: '' }, resetApps: {} };
  for (const k of writeKeys) {
    sent.length = 0;
    const r = await main.commands.write(Object.assign({ what: k }, args[k] || {}), Tst);
    check(`test run: ${k} is sent ONLY as a dry run`, sent.length === 1 && sent[0][1].dryRun === true && r.ok && r.dryRun === true && /test run/.test(r.reason), JSON.stringify(sent));
  }
  sent.length = 0;
  const mono = await main.commands.write({ what: 'soundSetting', key: 'mono', value: true }, Tst);
  check('test run: the note says what would be written', /AccessibilityMonoMixState = 1/.test(mono.reason), mono.reason);
  const ad = await main.commands.admin({ action: 'syssound.deviceProp', args: { device: 'd', prop: 'name', value: 'x' } }, Tst);
  check('test run: the administrator action is a dry run', ad.ok && ad.dryRun === true);
  const L = mk(false);
  const ad2 = await main.commands.admin({ action: 'syssound.deviceProp', args: { device: 'd', prop: 'name', value: 'x' } }, L);
  check('live: a declined administrator prompt comes back as cancelled', ad2.ok === false && ad2.cancelled === true, JSON.stringify(ad2));
  const stop = main.install(L);
  check('install: listens to the sidecar\'s syssound events', typeof events.syssound === 'function');
  events.syssound && events.syssound({ what: 'micDone', device: 'd', peakMax: 40, ok: true });
  check('install: a syssound event is pushed as settings.system.sound', pushed.some((p) => p[0] === 'settings.system.sound' && p[1].peakMax === 40), JSON.stringify(pushed));
  stop();
  check('install: stop unsubscribes', !events.syssound && !events.sysdisplay);

  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  let def = null;
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'system.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(d) { def = d; } }, window: {}, document: { currentScript: { dataset: { section: 'system' } } }, console });
  check('page: checkSection is happy', def && M.checkSection(def, 'system') === null, def && M.checkSection(def, 'system'));
  const pg = def && def.pages.find((p) => p.id === 'sound');
  check('page: Sound is drawn natively (a render, not the built-in placeholder)', pg && typeof pg.render === 'function' && pg.title === 'Sound');
  const body = src.slice(src.indexOf('function renderSound('), src.indexOf('/* ---------------------------------------------------------------- Storage'));
  const notDrawn = (pg ? pg.search : []).filter((s) => !body.includes(`'${s.row}'`));
  check('page: every Sound search row is drawn by renderSound', pg && pg.search.length >= 20 && !notDrawn.length, notDrawn.map((s) => s.row).join(' '));
  for (const r of ['sound.output', 'sound.input', 'sound.volume', 'sound.mixer']) check(`page: the built-in row ${r} is kept`, pg && pg.search.some((s) => s.row === r));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('snd') || 'full';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const emit = (ev, p, ms) => setTimeout(() => window.__mockEmit && window.__mockEmit(ev, p), ms || 20);
  const K = (n, inp) => `{0.0.${inp ? 1 : 0}.00000000}.{${String(n).repeat(8)}-aaaa-bbbb-cccc-1234567890ab}`;
  const fmts = [[44100, 16], [48000, 16], [44100, 24], [48000, 24], [96000, 24], [192000, 24]].map(([r, b]) => ({ value: `${r}/${b}/${b === 24 ? 32 : 16}`, rate: r, bits: b, text: `2 channel, ${b} bit, ${r} Hz${b === 16 && r === 44100 ? ' (CD Quality)' : b === 16 ? ' (DVD Quality)' : ' (Studio Quality)'}` }));
  const vol = (lv, mu) => ({ level: lv, muted: !!mu, channels: [{ index: 0, name: 'Left', level: 100 }, { index: 1, name: 'Right', level: 92 }], reason: null });
  const spat = { supported: true, current: '', formats: [{ subtype: 'sonic', name: 'Windows Sonic for Headphones' }, { subtype: 'atmos', name: 'Dolby Atmos for Headphones' }], writable: true, why: null };
  const dev = (n, inp, name, o) => Object.assign({ device: K(n, inp), flow: inp ? 'input' : 'output', name, label: name.split(' (')[0], adapter: 'Made-up Audio', state: 'active',
    isDefault: false, isDefaultComms: false, volume: vol(inp ? 70 : 38), format: { rate: 48000, bits: 24, container: 32, channels: 2, float: false, value: '48000/24/32', text: '2 channel, 24 bit, 48000 Hz (Studio Quality)' },
    formats: fmts, formatsReason: null, enhancements: { on: true, set: false, note: 'Not set: the driver\'s default effects apply' }, exclusive: { allow: true, priority: true },
    spatial: inp ? null : JSON.parse(JSON.stringify(spat)) }, o || {});
  const D = {
    ok: true,
    output: { devices: [dev(1, false, 'Speakers (Made-up Audio)', { isDefault: true, isDefaultComms: true }), dev(2, false, 'Headphones (Made-up USB)', { spatial: { supported: false, current: '', formats: [], writable: false, why: 'this device does not support spatial sound (Windows reports no spatial formats for it)' } }),
      dev(3, false, 'TV (Made-up HDMI)', { state: 'unplugged', volume: { reason: 'the device is unplugged, so it has no volume right now' }, formats: [], formatsReason: 'the device is unplugged, so Windows cannot ask it which formats it takes', spatial: null })],
      defaultDevice: K(1), defaultComms: K(1), reason: null },
    input: { devices: [dev(4, true, 'Microphone Array (Made-up Audio)', { isDefault: true, isDefaultComms: true }), dev(5, true, 'Headset Mic (Made-up USB)', { state: 'disabled', volume: { reason: 'the device is disabled, so it has no volume right now' }, formats: [] })],
      defaultDevice: K(4, true), defaultComms: K(4, true), reason: null },
    mono: { on: false, note: 'Sound that starts from now on is mixed to mono' }, ducking: { value: 3, set: true, options: ['Mute all other sounds', 'Reduce the volume of other sounds by 80%', 'Reduce the volume of other sounds by 50%', 'Do nothing'].map((label, value) => ({ value, label })) },
    propsWritable: false, propsWhy: 'Windows keeps device properties for the whole PC',
    listen: { writable: false, why: 'Windows keeps "Listen to this device" in the audio driver\'s effects store, which only the Sound control panel\'s own interface writes' },
  };
  if (SCN === 'empty') { D.input.devices = []; D.input.defaultDevice = null; D.input.defaultComms = null; }
  const APPS = { ok: true, perAppDevices: true, apps: SCN === 'empty' ? [] : [
    { app: 'system', name: 'System sounds', system: true, active: false, level: 100, muted: false, output: null, input: null, deviceWritable: false, deviceWhy: 'System sounds always play on the default device' },
    { app: 'pid:4242', name: 'Made-up Racer', system: false, active: true, level: 80, muted: false, output: K(2), input: '', deviceWritable: true, deviceWhy: null },
    { app: 'pid:5151', name: 'Made-up Browser', system: false, active: false, level: 100, muted: true, output: '', input: '', deviceWritable: true, deviceWhy: null }] };
  const no = (why) => ({ ok: false, reason: why });
  const copy = (x) => JSON.parse(JSON.stringify(x));
  function read(a) {
    if (SCN === 'fail') return later(40, no(a.what === 'apps' ? 'syssound.apps failed: the sidecar is not running (made up)' : 'syssound.devices failed: the sidecar is not running (made up)'));
    if (a.what === 'sound') return later(40, copy(D));
    if (a.what === 'apps') return later(30, copy(APPS));
    if (a.what === 'micStop') return later(10, { ok: true, stopped: true });
    return later(10, no(`fake: no reading "${a.what}"`));
  }
  function write(a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: `test run: nothing was changed (would write: ${a.what === 'soundLevel' ? `IAudioEndpointVolume.SetMasterVolumeLevelScalar = ${a.level / 100}` : a.what})` });
    const all = D.output.devices.concat(D.input.devices);
    const d = all.find((x) => x.device === a.device);
    switch (a.what) {
      case 'soundDefault': { const side = d.flow === 'output' ? D.output : D.input; const list = side.devices;
        if (a.role === 'default') { list.forEach((x) => { x.isDefault = x === d; }); side.defaultDevice = d.device; } else { list.forEach((x) => { x.isDefaultComms = x === d; }); side.defaultComms = d.device; }
        return later(40, { ok: true, changed: true, device: d.device, role: a.role }); }
      case 'soundLevel': if (a.channel != null) { d.volume.channels[a.channel].level = a.level; return later(30, { ok: true, channels: d.volume.channels.map((c) => c.level) }); }
        if (a.level != null) d.volume.level = a.level; if (a.muted != null) d.volume.muted = a.muted; return later(30, { ok: true, changed: true, level: d.volume.level, muted: d.volume.muted });
      case 'soundProps':
        if (a.prop === 'name' || a.prop === 'enhancements' || a.prop === 'exclusive' || a.prop === 'exclusivePriority') return later(30, { ok: false, needsAdmin: true, elevate: 'syssound.deviceProp', args: { device: a.device, prop: a.prop, value: a.value }, reason: 'Windows will ask for administrator permission to change a sound device\'s properties' });
        if (a.prop === 'spatial') { d.spatial.current = a.value; return later(40, { ok: true, changed: true, current: a.value }); }
        if (a.prop === 'format') { const f = fmts.find((x) => x.value === a.value); d.format = Object.assign({}, d.format, f); return later(40, { ok: true, changed: true, format: d.format }); }
        return later(10, no('fake: unknown prop'));
      case 'soundEnable': d.state = a.on ? 'active' : 'disabled'; return later(30, { ok: true, changed: true, on: a.on });
      case 'soundSetting': if (a.key === 'mono') D.mono.on = a.value; else D.ducking.value = a.value; return later(30, { ok: true, changed: true, value: a.value });
      case 'tone': emit('settings.system.sound', { ev: 'syssound', what: 'tone', device: a.device, ok: true }, 300); return later(20, { ok: true, started: true });
      case 'micTest':
        [12, 40, 62, 18].forEach((p, i) => emit('settings.system.sound', { ev: 'syssound', what: 'mic', device: a.device, peak: p }, 100 + i * 80));
        emit('settings.system.sound', { ev: 'syssound', what: 'micDone', device: a.device, peakMax: 62, ok: true }, 500);
        return later(20, { ok: true, started: true, ms: 6000, note: 'Nothing is recorded or kept: Mantle only reads the level' });
      case 'appSet': { const x = APPS.apps.find((y) => y.app === a.app); if (a.level != null) x.level = a.level; if (a.muted != null) x.muted = a.muted; return later(30, { ok: true, level: x.level, muted: x.muted }); }
      case 'appDevice': { const x = APPS.apps.find((y) => y.app === a.app); x[a.flow] = a.device; return later(30, { ok: true, device: a.device }); }
      case 'resetApps': APPS.apps.forEach((x) => { x.level = 100; x.muted = false; if (!x.system) { x.output = ''; x.input = ''; } }); return later(40, { ok: true, changed: true });
      default: return later(10, no(`fake: no change "${a.what}"`));
    }
  }
  function admin() {
    if (TEST) return later(20, { ok: true, dryRun: true, reason: 'test run: Windows would ask for administrator permission to change a sound device\'s properties; nothing was changed' });
    return later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const c = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'system', file: 'sections/system.js', down: null, main: null }] });
        const mine = name === 'settings.system.read' ? read(c) : name === 'settings.system.write' ? write(c) : name === 'settings.system.admin' ? admin(c) : null;
        if (!mine) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: c });
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
const selVal = (p, row) => p.$eval(sel(row) + ' select', (s) => s.value);
const PG = '?section=system&page=sound';
const K = (n, inp) => `{0.0.${inp ? 1 : 0}.00000000}.{${String(n).repeat(8)}-aaaa-bbbb-cccc-1234567890ab}`;

const SHOTS = [
  ['snd-01-top', PG, async (p) => {
    check('01: the default output is chosen', await selVal(p, 'sound.output') === K(1));
    const outs = await p.$$eval(sel('sound.output') + ' option', (o) => o.map((x) => x.textContent));
    check('01: only working outputs are offered', outs.length === 2 && !outs.some((t) => /TV/.test(t)), outs.join(' | '));
    check('01: the volume reads 38%', /38%/.test(await rowText(p, 'sound.volume') || ''), await rowText(p, 'sound.volume'));
    check('01: the default microphone is chosen', await selVal(p, 'sound.input') === K(4, true));
    check('01: three apps in the mixer', await p.locator('[data-row^="sound.mixer.pid-"]').count() >= 2 && await shown(p, 'sound.mixer.system'));
    check('01: system sounds cannot take a device, said on the row', /Read only here: System sounds always play on the default device/.test(await rowText(p, 'sound.mixer.system.out') || ''));
    check('01: an app with its own output shows it', await selVal(p, 'sound.mixer.pid-4242.out') === K(2));
  }],
  ['snd-02-props', PG, async (p) => {
    const sp = await p.$$eval(sel('system.sound.props.spatial') + ' option', (o) => o.map((x) => x.textContent));
    check('02: spatial sound offers Off and the device\'s formats', sp.join(',') === 'Off,Windows Sonic for Headphones,Dolby Atmos for Headphones', sp.join(','));
    check('02: the current format is selected', await selVal(p, 'system.sound.props.format') === '48000/24/32');
    check('02: two balance sliders (Left, Right)', await shown(p, 'system.sound.props.balance.0') && /Right/.test(await rowText(p, 'system.sound.props.balance.1') || ''));
    check('02: "Listen to this device" is hidden for an output', !(await shown(p, 'system.sound.props.listen')));
    check('02: properties carry the shield (Windows needs administrator here)', /Windows will ask for administrator permission to change a sound device's properties/.test(await rowText(p, 'system.sound.props.name') || ''));
    await p.selectOption(sel('system.sound.props') + ' select', K(4, true));
    await p.waitForTimeout(200);
    check('02: an input shows Listen as read-only WITH its reason', await shown(p, 'system.sound.props.listen') && /Read only here: Windows keeps "Listen to this device"/.test(await rowText(p, 'system.sound.props.listen') || ''));
    check('02: an input has no spatial sound or test tone', !(await shown(p, 'system.sound.props.spatial')) && !(await shown(p, 'system.sound.props.test')));
    await p.selectOption(sel('system.sound.props') + ' select', K(2));
    await p.waitForTimeout(200);
    check('02: headphones without spatial formats say why', /Read only here: this device does not support spatial sound/.test(await rowText(p, 'system.sound.props.spatial') || ''));
    await scrollTo(p, 'system.sound.props');
  }],
  ['snd-03-change', PG, async (p) => {
    await p.selectOption(sel('sound.output') + ' select', K(2));
    await p.waitForTimeout(300);
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'soundDefault');
    check('03: choosing an output makes it the default', w && w.args.device === K(2) && w.args.role === 'default', JSON.stringify(w));
    await p.fill(sel('system.sound.props.name') + ' input', 'Desk speakers');
    await p.press(sel('system.sound.props.name') + ' input', 'Enter');
    await p.waitForTimeout(400);
    const t = await rowText(p, 'system.sound.props.name');
    check('03: a declined administrator prompt on rename says so', /You said no to the administrator prompt; nothing changed/.test(t), t);
    const a = await calls(p, 'settings.system.admin');
    check('03: the prompt went through settings.system.admin as syssound.deviceProp', a.length === 1 && a[0].args.action === 'syssound.deviceProp' && a[0].args.args.prop === 'name', JSON.stringify(a));
    await p.$eval(sel('sound.mixer.pid-5151') + ' input', (i) => { i.value = '55'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
    await p.waitForTimeout(300);
    const aw = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'appSet');
    check('03: an app\'s slider sets that app', aw && aw.args.app === 'pid:5151' && aw.args.level === 55, JSON.stringify(aw));
    await scrollTo(p, 'system.sound.props');
  }],
  ['snd-04-mic', PG, async (p) => {
    await p.click(sel('system.sound.input.test') + ' button');
    await p.waitForTimeout(900);
    const t = await rowText(p, 'system.sound.input.level');
    check('04: the microphone test shows the loudest level', /Loudest 62%/.test(t) && /picking up sound/.test(t), t);
    check('04: the button is back to Start test', /Start test/.test(await rowText(p, 'system.sound.input.test') || ''));
    await p.click(sel('system.sound.props.test') + ' button');
    await p.waitForTimeout(500);
    check('04: the test tone says it played', /Played/.test(await rowText(p, 'system.sound.props.test') || ''), await rowText(p, 'system.sound.props.test'));
    await scrollTo(p, 'sound.input');
  }],
  ['snd-05-testrun', PG + '&test=1', async (p) => {
    await p.$eval(sel('sound.volume') + ' input', (i) => { i.value = '70'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
    await p.click(sel('system.sound.input.test') + ' button');
    await p.waitForTimeout(500);
    const t = await rowText(p, 'sound.volume');
    check('05: a test-run volume change is a dry run with its note, and springs back', /test run: nothing was changed/i.test(t) && /38%/.test(t), t);
    check('05: a test-run microphone test is a dry run too', /test run/i.test(await rowText(p, 'system.sound.input.test') || ''));
    check('05: no microphone level arrives in a test run', /Not listening/.test(await rowText(p, 'system.sound.input.level') || ''));
  }],
  ['snd-06-failing', PG + '&snd=fail', async (p) => {
    check('06: the output says why it could not be read', /The sound devices could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'sound.output') || ''));
    check('06: the mixer says why', /The volume mixer could not be read/.test(await p.$eval(sel('sound.mixer') + ' + div', (e) => e.textContent)));
    check('06: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['snd-07-empty', PG + '&snd=empty', async (p) => {
    check('07: no microphone: the input row says so', /No input device is working/.test(await rowText(p, 'sound.input') || ''));
    check('07: no microphone: the test is off WITH its reason', /No microphone is working/.test(await rowText(p, 'system.sound.input.test') || ''));
    check('07: no app playing: the mixer says so', /No app is playing sound right now/.test(await p.$eval(sel('sound.mixer') + ' + div', (e) => e.textContent)));
    await scrollTo(p, 'system.sound.devices');
    check('07: an unplugged device is listed with its state', /Not plugged in/.test(await p.$eval(sel('system.sound.devices'), (e) => e.closest('.card').textContent)));
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
      check(`${name}: not DOWN, not the built-in page`, !/could not be drawn|did not load/.test(probe.text) && /Device properties for/.test(probe.text), probe.text.slice(0, 200));
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
  console.log(`SYSSOUND PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
