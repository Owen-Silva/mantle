'use strict';
/*
 * lib/features.test.js - the feature seam's main-process half (lib/features.js).
 *
 *   node lib/features.test.js              unit: fixture features in a temp dir, a fake sidecar
 *   node lib/features.test.js --electron   ...then ONE Electron --test instance (needs a test slot
 *                                          and MANTLE_SIDECAR_EXE): a fixture feature loads, a page
 *                                          calls its command, fireChord / --test-chord reach it, and
 *                                          its stop() runs on --quit while a hanging stop() does
 *                                          not hold the quit up.
 *
 * Plain node, no deps. One summary line: "features tests: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const { createFeatures, validate, pieceWords, CHORDS, KEYS } = require('./features');
const { ShellState } = require('./state');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- fixtures, written to a temp dir (nothing lands in the repo) ---- */

function writeFixtures(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

const UNIT_FIXTURES = {
  'alpha.js': `module.exports = {
    name: 'alpha', label: 'Alpha (Win+V)', defaultOn: true, chords: ['Win+V', 'Win+Z'], observe: ['VolumeUp'],
    install(ctx) {
      global.__alpha = { ctx, chords: [], keys: [], enabled: [], stopped: 0 };
      ctx.command('ping', async (a) => ({ pong: true, n: a.n }));
      ctx.onChord('Win+V', (c) => global.__alpha.chords.push(c));
      ctx.onChord('Win+Z', () => { throw new Error('boom in Win+Z'); });
      ctx.onKey('VolumeUp', (k) => global.__alpha.keys.push(k));
      ctx.onEnabled((on) => global.__alpha.enabled.push(on));
      ctx.replay('alpha.items', () => ({ n: 3 }));
      return { stop() { global.__alpha.stopped++; } };
    },
  };`,
  'beta.js': `module.exports = { name: 'beta', label: 'Beta', defaultOn: false, chords: ['Win+S'], observe: ['VolumeUp'],
    install(ctx) { global.__beta = { keys: [] }; ctx.onKey('VolumeUp', (k) => global.__beta.keys.push(k)); return { stop() {} }; } };`,
  'crashy.js': `module.exports = { name: 'crashy', label: 'Crashy', defaultOn: true, chords: ['Win+Tab'],
    install() { throw new Error('no window for you'); } };`,
  'dupe.js': `module.exports = { name: 'dupe', label: 'Dupe', defaultOn: true, chords: ['Win+V'], install() { global.__dupeInstalled = true; return {}; } };`,
  'hang.js': `module.exports = { name: 'hang', label: 'Hang', defaultOn: true, chords: [],
    install() { return { stop() { return new Promise(() => {}); } }; } };`,
  'thrower.js': `module.exports = { name: 'thrower', label: 'Thrower', defaultOn: true,
    install() { return { stop() { throw new Error('stop blew up'); } }; } };`,
  'misnamed.js': `module.exports = { name: 'other', label: 'x', defaultOn: true, install() {} };`,
  'broken.js': 'module.exports = { this is not javascript',
  'asyncy.js': `module.exports = { name: 'asyncy', label: 'Async', defaultOn: true, chords: ['PrintScreen'],
    async install(ctx) { await new Promise((r) => setTimeout(r, 20)); ctx.health(false, 'the capture engine is missing'); return { stop() { global.__asyncStopped = true; } }; } };`,
  'alpha.test.js': 'throw new Error("a test file must never be loaded as a feature");',
  '_helper.js': 'throw new Error("an _underscore file must never be loaded as a feature");',
  'README.md': 'not js',
};

function fakeSidecar(opts) {
  const s = new EventEmitter();
  s.calls = [];
  s.down = null;
  s.fail = (opts && opts.fail) || null;
  s.blockedReason = () => s.down;
  s.call = async (cmd, args) => {
    s.calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });
    if (s.fail) throw new Error(s.fail);
    if (cmd === 'hotkey') return { installed: true, chords: (args.chords || []).slice(), observe: (args.observe || []).slice(), reason: null };
    return { echoed: cmd };
  };
  return s;
}

function harness(dir, test, sidecarOpts, extra) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-unit-'));
  const state = new ShellState(test ? 'test' : 'live', 'bottom');
  const sidecar = fakeSidecar(sidecarOpts);
  const commands = { 'state.get': async () => state.get() };
  const lines = [];
  const broadcasts = [];
  const opened = [];
  const f = createFeatures({
    dir, test, root: ROOT, userData, state, sidecar, commands,
    broadcast: (n, p) => broadcasts.push([n, p]),
    log: (l) => lines.push(l),
    host: { openLauncher: (a, from) => { opened.push([a, from]); return a; }, barRect: () => ({ x: 1, y: 2, width: 3, height: 4 }), display: () => ({ id: 9 }) },
    ...(extra || {}),
  });
  return { f, state, sidecar, commands, lines, broadcasts, opened, userData };
}

/* ---- pure ---- */

function pureChecks() {
  const good = { name: 'clipboard', label: 'Clipboard history (Win+V)', defaultOn: true, chords: ['Win+V'], observe: [], install() {} };
  check('validate: a good module passes', validate(good, 'clipboard') === null);
  const bad = (patch, base, re, what) => {
    const r = validate(Object.assign({}, good, patch), base || 'clipboard');
    check(`validate: ${what}`, typeof r === 'string' && re.test(r), r);
  };
  bad({ name: 'Clip Board' }, 'Clip Board', /not lower-case/, 'a name with capitals/spaces is refused');
  bad({}, 'clip', /not its file name/, 'a name that is not the file name is refused');
  bad({ name: 'state' }, 'state', /Mantle's own/, 'a reserved name is refused');
  bad({ label: '' }, null, /no label/, 'an empty label is refused');
  bad({ defaultOn: 'yes' }, null, /defaultOn/, 'a non-boolean defaultOn is refused');
  bad({ chords: ['Win+Q'] }, null, /not one of/, 'an unknown chord is refused');
  bad({ chords: ['Win+V', 'Win+V'] }, null, /twice/, 'a chord listed twice is refused');
  bad({ observe: ['VolumeLouder'] }, null, /not one of/, 'an unknown observed key is refused');
  bad({ install: null }, null, /install/, 'a module with no install is refused');
  check('validate: a non-object is refused', /object/.test(validate(null, 'x')));
  // Read from the C# itself (KeyMachine.ChordNames), so a name added on one side only fails here.
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'AltTab.cs'), 'utf8').match(/ChordNames = {([^}]*)}/);
  const csNames = cs ? (cs[1].match(/"[^"]+"/g) || []).map((q) => q.slice(1, -1)) : [];
  check('the chord table matches the sidecar protocol (sidecar/AltTab.cs KeyMachine.ChordNames, same order)',
    CHORDS.join() === csNames.join() && CHORDS.slice(0, 10).join() === 'Win+S,Win+V,Win+Tab,Win+Left,Win+Right,Win+Up,Win+Down,Win+Z,Win+Shift+S,PrintScreen',
    JSON.stringify({ js: CHORDS, cs: csNames }));
  check('the observed-key table matches the sidecar protocol', KEYS.join() === 'VolumeUp,VolumeDown,VolumeMute');

  const f = { name: 'clipboard', label: 'Clip', chords: ['Win+V'], enabled: true, ok: true, reason: 'working' };
  let p = pieceWords(f, { test: false, live: true, taken: new Set(['Win+V']) });
  check('piece: on, healthy, taken = keys true, not broken', p.on && p.ok && p.keys === true && p.broken === null, JSON.stringify(p));
  p = pieceWords(f, { test: false, live: true, taken: new Set(), err: 'SetWindowsHookEx failed' });
  check('piece: a refused hook is broken, with the reason', p.keys === false && /SetWindowsHookEx/.test(p.broken), JSON.stringify(p));
  p = pieceWords(f, { test: true, live: false });
  check('piece: test mode is never broken', p.broken === null && /test mode/.test(p.keysReason), JSON.stringify(p));
  p = pieceWords(Object.assign({}, f, { enabled: false }), { test: false, live: true, taken: new Set() });
  check('piece: turned off is not broken', p.on === false && p.broken === null && /tray menu/.test(p.keysReason), JSON.stringify(p));
  p = pieceWords(Object.assign({}, f, { ok: false, reason: 'page crashed' }), { test: false, live: true, taken: new Set() });
  check('piece: unhealthy says so and its chords are Windows\'', p.ok === false && p.reason === 'page crashed' && p.broken === null && /until it is healthy/.test(p.keysReason), JSON.stringify(p));
  p = pieceWords(f, { test: false, live: true, applying: true });
  check('piece: while the hook call is in flight it is not (yet) a fault', p.broken === null && /being taken/.test(p.keysReason), JSON.stringify(p));
  p = pieceWords(f, { test: false, live: true, sidecarDown: 'the sidecar is not running (it exited)' });
  check('piece: a sidecar that is down is the sidecar row\'s problem, not this one', p.broken === null && /not running/.test(p.keysReason), JSON.stringify(p));
}

/* ---- the set, in test mode ---- */

async function testModeChecks(dir) {
  const h = harness(dir, true);
  const up = h.f.load();
  check('load: the good, async and misbehaving-at-stop features start', ['alpha', 'asyncy', 'hang', 'thrower'].every((n) => up.includes(n)), JSON.stringify(up));
  check('load: *.test.js, _helpers and non-js files are never loaded', !global.__never && !up.includes('alpha.test') && !h.f.list().some((x) => x.name === '_helper' || x.name === 'README'), JSON.stringify(h.f.list().map((x) => x.name)));
  const st = () => h.state.get().features || {};
  check('load: a throwing install() is that feature down with the reason', st().crashy && st().crashy.ok === false && /install\(\) threw no window for you/.test(st().crashy.reason), JSON.stringify(st().crashy));
  check('load: a second claim on a chord is refused and named', st().dupe && st().dupe.ok === false && /Win\+V is already taken by alpha/.test(st().dupe.reason) && !global.__dupeInstalled, JSON.stringify(st().dupe));
  check('load: a module whose name is not its file is refused', st().misnamed && st().misnamed.ok === false && /not its file name/.test(st().misnamed.reason), JSON.stringify(st().misnamed));
  check('load: a file that does not parse is refused, Mantle carries on', st().broken && st().broken.ok === false && /would not load/.test(st().broken.reason), JSON.stringify(st().broken));
  check('load: defaultOn false starts off', st().beta && st().beta.on === false, JSON.stringify(st().beta));
  check('load: problems() lists each feature that is on and not working, and only those',
    (() => { const ps = h.state.problems().map((p) => p.piece); return ps.includes('Crashy') && ps.includes('Dupe') && !ps.includes('Alpha (Win+V)') && !ps.includes('Beta'); })(),
    JSON.stringify(h.state.problems().filter((p) => !/sidecar|taskbar|desktop|Win key|window glass|shortcuts|taskbar watch/.test(p.piece))));
  const a = global.__alpha;
  check('ctx.flags says test', a && a.ctx.flags.test === true && a.ctx.flags.live === false);
  check('ctx.test exists in test mode', a && a.ctx.test && typeof a.ctx.test.fireChord === 'function');

  // commands
  const r = await h.commands['alpha.ping']({ n: 5 });
  check('ctx.command: a page can call <name>.<verb>', r && r.pong === true && r.n === 5, JSON.stringify(r));
  let threw = null;
  try { a.ctx.command('ping', async () => 1); } catch (e) { threw = e.message; }
  check('ctx.command: registering the same verb twice throws', /already exists/.test(threw || ''), threw);
  threw = null;
  try { a.ctx.onChord('Win+S', () => {}); } catch (e) { threw = e.message; }
  check('ctx.onChord: a chord the module did not list throws', /does not list "Win\+S"/.test(threw || ''), threw);

  // chords and keys
  let res = a.ctx.test.fireChord('Win+V');
  check('fireChord: reaches the onChord handler', res.delivered === true && a.chords.join() === 'Win+V', JSON.stringify(res));
  res = h.f.fireKey('VolumeUp', 'unit');
  check('fireKey: every ON feature observing it gets it (beta is off)', res.handlers === 1 && a.keys.length === 1 && global.__beta.keys.length === 0, JSON.stringify(res));
  h.sidecar.emit('chord', { ev: 'chord', chord: 'Win+V' });
  check('a hook {ev:chord} is routed like fireChord', a.chords.length === 2);
  h.sidecar.emit('key', { ev: 'key', key: 'VolumeUp' });
  check('a hook {ev:key} is routed like fireKey', a.keys.length === 2);
  res = h.f.fireChord('Win+Z', 'unit');
  await sleep(40);
  check('a chord handler that throws takes the feature down, with the reason, and its keys go back',
    st().alpha.ok === false && /Win\+Z handler failed \(boom in Win\+Z\)/.test(st().alpha.reason) && !h.f.wanted().chords.includes('Win+V'), JSON.stringify(st().alpha));
  res = h.f.fireChord('Win+V', 'unit');
  check('fireChord to an unhealthy feature is not delivered, and says why', res.delivered === false && /not healthy/.test(res.reason), JSON.stringify(res));
  a.ctx.health(true);
  check('ctx.health(true) brings it back', st().alpha.ok === true && h.f.wanted().chords.includes('Win+V'));
  await sleep(60);
  check('asyncy: an async install() that reports unhealthy is down with its words', st().asyncy.ok === false && st().asyncy.reason === 'the capture engine is missing', JSON.stringify(st().asyncy));
  check('wanted(): only on + healthy features\' chords; observe from on features',
    JSON.stringify(h.f.wanted()) === JSON.stringify({ chords: ['Win+V', 'Win+Z'], observe: ['VolumeUp'] }), JSON.stringify(h.f.wanted()));
  threw = null;
  try { h.f.fireChord('Win+Q'); } catch (e) { threw = e.message; }
  check('fireChord names an unknown chord', /not a chord/.test(threw || ''), threw);
  check('test mode never calls the sidecar\'s hotkey', !h.sidecar.calls.some((c) => c.cmd === 'hotkey'), JSON.stringify(h.sidecar.calls));

  // enabled, settings, host, replay, sidecar
  h.f.setEnabled('alpha', false, 'unit');
  check('setEnabled: onEnabled handlers hear it, state and wanted() follow', a.enabled.join() === 'false' && st().alpha.on === false && !h.f.wanted().chords.includes('Win+V'));
  const saved = JSON.parse(fs.readFileSync(path.join(h.userData, 'features.json'), 'utf8'));
  check('setEnabled: persisted to features.json in the profile dir', saved.alpha === false, JSON.stringify(saved));
  h.f.setEnabled('alpha', true, 'unit');
  a.ctx.settings.set('size', { w: 3 });
  check('settings: get returns what set stored, default otherwise', a.ctx.settings.get('size').w === 3 && a.ctx.settings.get('nope', 7) === 7);
  check('settings: stored as JSON under <profile>/features/<name>.json', JSON.parse(fs.readFileSync(path.join(h.userData, 'features', 'alpha.json'), 'utf8')).size.w === 3);
  a.ctx.host.openLauncher({ mode: 'search', query: 'calc' });
  check('host.openLauncher passes mode + query through, with who asked', h.opened.length === 1 && h.opened[0][0].mode === 'search' && h.opened[0][0].query === 'calc' && h.opened[0][1] === 'alpha', JSON.stringify(h.opened));
  check('host.barRect / display come from main', a.ctx.host.barRect().height === 4 && a.ctx.host.display().id === 9);
  check('ctx.page is ui/<name>/<file>', a.ctx.page('index.html') === path.join(ROOT, 'ui', 'alpha', 'index.html'));
  check('ctx.preload is the shared preload.js', a.ctx.preload === path.join(ROOT, 'preload.js'));
  a.ctx.broadcast('alpha.changed', { x: 1 });
  check('ctx.broadcast reaches main\'s broadcast', h.broadcasts.some(([n]) => n === 'alpha.changed'));
  const rp = h.f.replay('alpha.items');
  check('ctx.replay answers mantle:replay for its own events', rp && rp.has === true && rp.payload.n === 3, JSON.stringify(rp));
  check('replay of an unknown event falls through (null)', h.f.replay('wallpaper') === null);
  const sr = await a.ctx.sidecar.send('clip.list', { a: 1 });
  check('ctx.sidecar.send resolves {ok, result}', sr.ok === true && sr.result.echoed === 'clip.list', JSON.stringify(sr));
  h.sidecar.fail = 'unknown command: clip.list';
  const sr2 = await a.ctx.sidecar.send('clip.list');
  check('ctx.sidecar.send never rejects: {ok:false, error}', sr2.ok === false && sr2.error === 'unknown command: clip.list', JSON.stringify(sr2));
  h.sidecar.fail = null;
  let got = null;
  const off = a.ctx.sidecar.on('clip', (m) => { got = m; });
  h.sidecar.emit('clip', { ev: 'clip', n: 2 });
  check('ctx.sidecar.on gets Features.Event pushes as {ev, ...}', got && got.ev === 'clip' && got.n === 2, JSON.stringify(got));
  off();
  got = null;
  h.sidecar.emit('clip', { ev: 'clip', n: 3 });
  check('ctx.sidecar.on returns an unsubscribe', got === null);
  const items = h.f.trayItems();
  check('tray: one checkbox per feature, checked = on', items.some((i) => i.type === 'checkbox' && i.label === 'Alpha (Win+V)' && i.checked === true) && items.some((i) => i.label === 'Beta' && i.checked === false));
  check('tray: the reason sits under a feature that is on and failing', items.some((i) => i.enabled === false && /install\(\) threw/.test(i.label)));

  // stop
  const t0 = Date.now();
  const p1 = h.f.stopAll('unit quit');
  const p2 = h.f.stopAll('again');
  check('stopAll twice is the same promise', p1 === p2);
  const res2 = await p1;
  const ms = Date.now() - t0;
  check('stopAll: every stop() ran (a sync one, an async one)', a.stopped === 1 && global.__asyncStopped === true);
  check('stopAll: a hanging stop() is abandoned at its deadline, not waited for', ms >= 2400 && ms < 4000 && res2.some((x) => x.name === 'hang' && /did not finish within 2500 ms/.test(x.line)), `${ms} ms ${JSON.stringify(res2)}`);
  check('stopAll: a throwing stop() is logged and does not stop the others', res2.some((x) => x.name === 'thrower' && /stop blew up/.test(x.line)));
  check('after stop: pieces say stopped and none is a problem', st().alpha.stopped === true && !h.state.problems().some((p) => /Alpha/.test(p.piece)), JSON.stringify(st().alpha));
  threw = null;
  try { await h.commands['alpha.ping']({}); } catch (e) { threw = e.message; }
  check('after stop: its commands say it is stopped', /stopped/.test(threw || ''), threw);
  const before = a.chords.length;
  h.sidecar.emit('chord', { ev: 'chord', chord: 'Win+V' });
  check('after stop: no chord reaches it', a.chords.length === before);
}

/* ---- live mode: the hotkey protocol against a fake sidecar ---- */

async function liveChecks(dir) {
  for (const k of Object.keys(global)) if (k.startsWith('__')) delete global[k];
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  const h = harness(dir, false);
  h.f.load();
  const a = global.__alpha;
  check('live: ctx.test is null', a.ctx.test === null && a.ctx.flags.live === true);
  let threw = null;
  try { h.f.fireChord('Win+V'); } catch (e) { threw = e.message; }
  check('live: fireChord refuses', /test-only/.test(threw || ''), threw);
  await sleep(80);
  check('live: nothing is sent before Mantle owns the shell', !h.sidecar.calls.some((c) => c.cmd === 'hotkey'));
  await h.f.applyLive('unit');
  const last = () => h.sidecar.calls.filter((c) => c.cmd === 'hotkey').pop();
  check('applyLive sends hotkey {chords, observe} for on + healthy features only',
    last() && JSON.stringify(last().args) === JSON.stringify({ chords: ['Win+V', 'Win+Z'], observe: ['VolumeUp'] }), JSON.stringify(last()));
  const st = () => h.state.get().features;
  check('the sidecar\'s answer makes keys true', st().alpha.keys === true && st().alpha.broken === null, JSON.stringify(st().alpha));
  const n0 = h.sidecar.calls.length;
  a.ctx.health(false, 'page gone');
  a.ctx.health(false, 'page gone, still');
  await sleep(80);
  const sent = h.sidecar.calls.slice(n0).filter((c) => c.cmd === 'hotkey');
  check('health(false) gives the chords back in ONE coalesced call', sent.length === 1 && JSON.stringify(sent[0].args.chords) === '[]', JSON.stringify(sent));
  a.ctx.health(true);
  await sleep(80);
  check('health(true) takes them again', JSON.stringify(last().args.chords) === '["Win+V","Win+Z"]', JSON.stringify(last()));
  h.sidecar.emit('switcher', { ev: 'switcher', op: 'hook', installed: false, chords: [], reason: 'the hook was removed' });
  check('a hook announce that dropped them makes the feature broken, with the reason', /the hook was removed/.test(st().alpha.broken || ''), JSON.stringify(st().alpha));
  check('...and problems() says so', h.state.problems().some((p) => p.piece === 'Alpha (Win+V)' && /hook was removed/.test(p.reason)));
  h.sidecar.fail = 'hotkey needs winTap, altTab or winKeys: true or false';
  h.f.setEnabled('alpha', false, 'unit');
  h.f.setEnabled('alpha', true, 'unit');
  await sleep(80);
  check('an exe from before the seam is named as such', /predates feature chords/.test(st().alpha.broken || ''), JSON.stringify(st().alpha));
  h.sidecar.fail = null;
  h.sidecar.emit('status', { status: 'down', reason: 'it exited' });
  check('sidecar down: keys false, not this row\'s fault', st().alpha.keys === false && st().alpha.broken === null && /not running/.test(st().alpha.keysReason), JSON.stringify(st().alpha));
  await h.f.applyLive('the sidecar came back');
  check('a sidecar restart re-sends the chords (a new process holds none)', st().alpha.keys === true && JSON.stringify(last().args.chords) === '["Win+V","Win+Z"]');
  h.f.released('unit restore');
  check('released: keys false, not broken, reason says Windows is back', st().alpha.keys === false && st().alpha.broken === null && /put Windows back/.test(st().alpha.keysReason), JSON.stringify(st().alpha));
  const n1 = h.sidecar.calls.length;
  await h.f.stopAll('unit quit');
  await sleep(80);
  check('stopping never re-asks for chords', !h.sidecar.calls.slice(n1).some((c) => c.cmd === 'hotkey'));
}

/* ---- the volume keys as chords (osd lane, 2026-09-24) ---- */

const VOL_FIXTURES = {
  'vol.js': `module.exports = { name: 'vol', label: 'Volume keys (test)', defaultOn: true,
    chords: ['VolumeUp', 'VolumeDown', 'VolumeMute'], observe: [],
    install(ctx) {
      global.__vol = { ctx, got: [] };
      for (const k of ['VolumeUp', 'VolumeDown', 'VolumeMute']) ctx.onChord(k, (c) => global.__vol.got.push(c));
      return { stop() {} };
    } };`,
  'ear.js': `module.exports = { name: 'ear', label: 'Only listens (test)', defaultOn: true, chords: [], observe: ['VolumeUp'],
    install(ctx) { global.__ear = { got: [] }; ctx.onKey('VolumeUp', (k) => global.__ear.got.push(k)); return { stop() {} }; } };`,
};

async function volumeChordChecks() {
  const VOL = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
  check('volume: the three bare volume keys are chord names', VOL.every((k) => CHORDS.includes(k)), JSON.stringify(CHORDS));
  const mod = { name: 'osd', label: 'x', defaultOn: true, chords: VOL, observe: [], install() {} };
  check('volume: validate accepts a module that claims them', validate(mod, 'osd') === null, validate(mod, 'osd'));
  check('volume: validate refuses the same key as a chord AND an observed key',
    /VolumeUp as a chord AND an observed key/.test(validate(Object.assign({}, mod, { observe: ['VolumeUp'] }), 'osd') || ''));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-vol-'));
  writeFixtures(dir, VOL_FIXTURES);
  try {
    // Test mode: fireChord routes exactly like the hook; an observer of the key hears a taken press.
    for (const k of Object.keys(global)) if (k.startsWith('__')) delete global[k];
    const t = harness(dir, true);
    t.f.load();
    const r1 = t.f.fireChord('VolumeUp', 'unit');
    t.f.fireChord('VolumeUp', 'unit');
    t.f.fireChord('VolumeMute', 'unit');
    check('volume (test): a claimed VolumeUp is delivered to its feature', r1.delivered === true && r1.feature === 'vol', JSON.stringify(r1));
    check('volume (test): every press (a held key\'s repeats) is its own event',
      JSON.stringify(global.__vol.got) === '["VolumeUp","VolumeUp","VolumeMute"]', JSON.stringify(global.__vol.got));
    check('volume (test): a feature that only observes VolumeUp still hears each taken press',
      JSON.stringify(global.__ear.got) === '["VolumeUp","VolumeUp"]', JSON.stringify(global.__ear.got));
    global.__vol.ctx.health(false, 'the pop-up page crashed');
    const r2 = t.f.fireChord('VolumeDown', 'unit');
    check('volume (test): an unhealthy feature is not handed the key', r2.delivered === false && /not healthy/.test(r2.reason), JSON.stringify(r2));
    check('volume (test): the strip names why', t.state.problems().some((p) => /pop-up page crashed/.test(p.reason)));
    await t.f.stopAll('unit');

    // Live mode: what the hook is told to take, as the feature turns off / breaks / recovers.
    for (const k of Object.keys(global)) if (k.startsWith('__')) delete global[k];
    for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
    const h = harness(dir, false);
    h.f.load();
    await h.f.applyLive('unit');
    const last = () => h.sidecar.calls.filter((c) => c.cmd === 'hotkey').pop();
    check('volume (live): on + healthy -> the hook takes all three, the observer\'s key is still watched',
      last() && JSON.stringify(last().args) === JSON.stringify({ chords: VOL, observe: ['VolumeUp'] }), JSON.stringify(last()));
    check('volume (live): keys are Mantle\'s', h.state.get().features.vol.keys === true, JSON.stringify(h.state.get().features.vol));
    h.f.setEnabled('vol', false, 'unit');
    await sleep(80);
    check('volume (live): turned off in the tray -> all three go back to Windows',
      JSON.stringify(last().args.chords) === '[]', JSON.stringify(last()));
    h.f.setEnabled('vol', true, 'unit');
    await sleep(80);
    check('volume (live): turned back on -> taken again', JSON.stringify(last().args.chords) === JSON.stringify(VOL), JSON.stringify(last()));
    global.__vol.ctx.health(false, 'the sidecar cannot step the volume');
    await sleep(80);
    check('volume (live): health(false) -> all three go back to Windows at once',
      JSON.stringify(last().args.chords) === '[]', JSON.stringify(last()));
    global.__vol.ctx.health(true, 'a plain note: brightness keys stay Windows\'');
    await sleep(80);
    check('volume (live): health(true) with a note -> taken again, and no problem row',
      JSON.stringify(last().args.chords) === JSON.stringify(VOL) && !h.state.problems().some((p) => p.piece === 'Volume keys (test)'),
      JSON.stringify({ last: last(), problems: h.state.problems() }));
    check('volume (live): the note is in the feature state', /brightness keys stay/.test(h.state.get().features.vol.reason), JSON.stringify(h.state.get().features.vol));
    const n1 = h.sidecar.calls.length;
    await h.f.stopAll('unit quit');
    await sleep(80);
    check('volume (live): stopping never re-asks for chords', !h.sidecar.calls.slice(n1).some((c) => c.cmd === 'hotkey'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

/* ---- one Electron --test instance ---- */

const E2E_FEATURE = `'use strict';
const path = require('path');
module.exports = {
  name: 'fixture', label: 'Seam fixture (test)', defaultOn: true, chords: ['Win+V'], observe: ['VolumeUp'],
  install(ctx) {
    const { BrowserWindow } = require('electron');
    ctx.log('SEAMTEST install test=' + ctx.flags.test + ' boots=' + ctx.settings.set('boots', ctx.settings.get('boots', 0) + 1));
    ctx.command('ping', async (a) => {
      ctx.log('SEAMTEST ping from page n=' + a.n);
      setTimeout(() => ctx.log('SEAMTEST fired ' + JSON.stringify(ctx.test.fireChord('Win+V'))), 50);
      return { pong: true, n: a.n };
    });
    ctx.command('report', async (a) => { ctx.log('SEAMTEST page got ' + JSON.stringify(a)); return true; });
    ctx.onChord('Win+V', (c) => ctx.log('SEAMTEST chord ' + c));
    ctx.onKey('VolumeUp', (k) => ctx.log('SEAMTEST key ' + k));
    // Never shown: a hidden window runs its page all the same, and nothing lands on Owen's screen.
    const win = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true } });
    win.loadFile(path.join(__dirname, 'fixture.html'));
    return { stop(why) { ctx.log('SEAMTEST stop ' + why); if (!win.isDestroyed()) win.destroy(); } };
  },
};`;
const E2E_PAGE = `<!doctype html><meta charset="utf-8"><title>seam fixture</title>
<script>
window.mantle.call('fixture.ping', { n: 7 })
  .then((r) => window.mantle.call('fixture.report', { r }))
  .catch((e) => window.mantle.call('fixture.report', { error: String(e && e.message || e) }));
</script>`;
const E2E_SLEEPY = `module.exports = { name: 'sleepy', label: 'Sleepy stop (test)', defaultOn: true,
  install(ctx) { return { stop() { ctx.log('SEAMTEST sleepy stop started (never finishes)'); return new Promise(() => {}); } }; } };`;
const E2E_CRASHY = `module.exports = { name: 'crashy', label: 'Crashy (test)', defaultOn: true, install() { throw new Error('fixture crash'); } };`;

function gamesRunning() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });
  return parseInt((r.stdout || '0').trim(), 10) || 0;
}

async function electronCheck() {
  const exe = process.env.MANTLE_SIDECAR_EXE;
  if (!exe || !fs.existsSync(exe)) { check('electron: MANTLE_SIDECAR_EXE names a built exe', false, String(exe)); return; }
  if (gamesRunning()) { check('electron: no game running (Owen is playing: not launching an instance)', false); return; }
  let slot = null;
  for (const n of [1, 2]) {
    const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
    try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
  }
  if (!slot) { check('electron: a test slot was free (mantle-slot-1/2 both taken; try again later)', false); return; }
  const PROFILE = 'seam';
  const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-seam-fixture-'));
  writeFixtures(fixDir, { 'fixture.js': E2E_FEATURE, 'fixture.html': E2E_PAGE, 'sleepy.js': E2E_SLEEPY, 'crashy.js': E2E_CRASHY });
  // The profile dir outlives a run (%TEMP%/mantle-test-<profile>): start the fixture's settings from nothing.
  try { fs.unlinkSync(path.join(os.tmpdir(), `mantle-test-${PROFILE}`, 'features', 'fixture.json')); } catch (_) { /* first run */ }
  const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
  const env = Object.assign({}, process.env, { MANTLE_FEATURES_DIR: fixDir, MANTLE_SIDECAR_EXE: exe });
  let out = '';
  const proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; });
  const toback = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'toback.ps1'), '-Match', PROFILE, '-WaitSec', '40'], { stdio: 'ignore' });
  const waitFor = async (re, ms) => { const t = Date.now() + ms; while (Date.now() < t) { if (re.test(out)) return true; if (exited) return false; await sleep(150); } return false; };
  // A second instance is a MESSENGER: it hands its argv to the running one and exits in about a
  // second, creating no window. The machine-wide one-browser lock (NODE_OPTIONS lowcpu-hook) would
  // make it wait for the lock held by the very instance it is messaging - a deadlock (measured
  // 2026-09-24: every --test-chord and --quit sat out the 30 s timeout) - so it alone skips it.
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });
  const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
  try {
    // Up to 9 min: the machine-wide one-browser lock (lowcpu) makes this instance queue behind other
    // lanes' headless shots (it waits up to 8 min). NOTHING below may run before it is up: a messenger
    // started first would take the single-instance lock and become the instance itself.
    const up = await waitFor(/SEAMTEST install test=true boots=1/, 9 * 60000);
    check('electron: the fixture feature installs, flags.test true', up, out.slice(-600));
    if (!up) return;
    check('electron: a feature whose install throws is reported and Mantle carries on', /crashy: NOT started: it could not start: install\(\) threw fixture crash/.test(out));
    check('electron: its page (the shared preload) called fixture.ping', await waitFor(/SEAMTEST ping from page n=7/, 20000), out.slice(-600));
    check('electron: ...and got the command\'s answer back', await waitFor(/SEAMTEST page got \{"r":\{"pong":true,"n":7\}\}/, 10000));
    check('electron: ctx.test.fireChord reached onChord', await waitFor(/SEAMTEST chord Win\+V/, 10000));
    check('electron: fireChord said delivered', /SEAMTEST fired \{"delivered":true,"feature":"fixture"\}/.test(out));
    second(['--test-chord=Win+V']);
    check('electron: a second instance --test-chord=Win+V reached it too', await waitFor(/Win\+V from a second instance: \{"delivered":true/, 15000), out.slice(-400));
    second(['--test-key=VolumeUp']);
    check('electron: --test-key=VolumeUp reached onKey', await waitFor(/SEAMTEST key VolumeUp/, 15000));
    check('electron: no keyboard hook was ever asked for', !/features: keys .*taking/.test(out));
    const tq = Date.now();
    second(['--quit']);
    const gone = await (async () => { const t = Date.now() + 30000; while (Date.now() < t && !exited) await sleep(150); return !!exited; })();
    check('electron: --quit ends the instance', gone, out.slice(-600));
    check('electron: the fixture\'s stop() ran on the quit path', /SEAMTEST stop /.test(out));
    check('electron: a stop() that never finishes was abandoned at its deadline', /sleepy: stop\(\) did not finish within 2500 ms/.test(out));
    check('electron: ...and the quit did not wait on it for long', gone && exited.at - tq < 15000, gone ? `${exited.at - tq} ms` : 'did not exit');
    check('electron: no uncaught exception', !/uncaught exception|RESTORE INCOMPLETE/.test(out), (out.match(/.*(uncaught exception|RESTORE INCOMPLETE).*/) || [''])[0]);
  } finally {
    if (!exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    try { toback.kill(); } catch (_) { /* done */ }
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    try { fs.rmSync(fixDir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    const log = path.join(os.tmpdir(), 'mantle-seam-e2e.log');
    try { fs.writeFileSync(log, out); console.log(`electron output: ${log}`); } catch (_) { /* best effort */ }
  }
}

/* ---- options + Mantle Settings' host API (lane settings, 2026-09-28) ---- */
async function optionsChecks() {
  const good = { name: 'gm', label: 'GM', defaultOn: true, install() {} };
  const refuse = (options, re, what) => {
    const r = validate(Object.assign({}, good, { options }), 'gm');
    check(`options: ${what}`, typeof r === 'string' && re.test(r), r);
  };
  check('options: a good list passes', validate(Object.assign({}, good, { options: [
    { key: 'auto', label: 'Auto', type: 'bool', default: true },
    { key: 'mode', label: 'Mode', type: 'choice', choices: ['a', { value: 'b', label: 'Bee' }], default: 'a' },
    { key: 'mb', label: 'MB', type: 'number', min: 50, max: 900, default: 400 },
    { key: 'dir', label: 'Folder', type: 'folder', default: null, defaultLabel: 'the usual one' },
  ] }), 'gm') === null);
  refuse('x', /must be a list/, 'a non-list is refused');
  refuse([{ key: 'a b', label: 'x', type: 'bool', default: true }], /not a plain word/, 'a key with a space is refused');
  refuse([{ key: 'a', label: 'x', type: 'bool', default: true }, { key: 'a', label: 'y', type: 'bool', default: false }], /twice/, 'a key listed twice is refused');
  refuse([{ key: 'a', label: '', type: 'bool', default: true }], /no label/, 'an option without a label is refused');
  refuse([{ key: 'a', label: 'x', type: 'colour', default: 1 }], /type must be one of/, 'an unknown type is refused');
  refuse([{ key: 'a', label: 'x', type: 'bool' }], /no default/, 'a bool without a default is refused');
  refuse([{ key: 'a', label: 'x', type: 'choice', choices: [], default: 'q' }], /needs choices/, 'a choice without choices is refused');
  refuse([{ key: 'a', label: 'x', type: 'choice', choices: ['p'], default: 'q' }], /default is not valid/, 'a choice whose default is not a choice is refused');
  refuse([{ key: 'a', label: 'x', type: 'number', min: 5, default: 1 }], /at least 5/, 'a number default under its min is refused');
  // Every real module (lib/features/*.js) keeps the contract, its options included.
  const realDir = path.join(ROOT, 'lib', 'features');
  const bads = [];
  for (const n of fs.readdirSync(realDir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js') && !x.startsWith('_'))) {
    try { const why = validate(require(path.join(realDir, n)), n.slice(0, -3)); if (why) bads.push(`${n}: ${why}`); } catch (e) { bads.push(`${n}: would not load (${e.message})`); }
  }
  check('options: every real feature module passes validate(), options and Win+I included', bads.length === 0, JSON.stringify(bads));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-opt-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-opt-folder-'));
  fs.writeFileSync(path.join(dir, 'gm.js'), `'use strict';
module.exports = { name: 'gm', label: 'Game mode', defaultOn: true, rest: true,
  options: [
    { key: 'auto', label: 'Start by itself', help: 'when a known game starts', type: 'bool', default: true },
    { key: 'size', label: 'Size', type: 'choice', choices: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }], default: 's' },
    { key: 'mb', label: 'Trim above', type: 'number', min: 50, max: 900, unit: 'MB', default: 400 },
    { key: 'dir', label: 'Save to', type: 'folder', default: null, defaultLabel: 'the usual folder' },
    { key: 'note', label: 'Note', type: 'text', default: '' },
  ],
  install(ctx) {
    const g = global.__opt = global.__opt || { installs: 0, heard: [] };
    g.installs++; g.ctx = ctx;
    ctx.onOption('auto', (v, k) => g.heard.push([k, v, ctx.settings.get('auto', true)]));
    ctx.onOption('*', (v, k) => g.heard.push(['*', k]));
    try { ctx.onOption('nope', () => {}); } catch (e) { g.nope = e.message; }
    return { stop() {} };
  } };
`);
  fs.writeFileSync(path.join(dir, 'panel.js'), `'use strict';
module.exports = { name: 'panel', label: 'Mantle Settings', defaultOn: true, install(ctx) { global.__panel = { ctx, changes: [] }; ctx.host.features.onChange((e) => global.__panel.changes.push(e)); return { stop() {} }; } };
`);
  try {
    const h = harness(dir, true);
    h.f.load();
    await sleep(20);
    const g = global.__opt, P = global.__panel.ctx.host.features;
    check('onOption: an undeclared key throws at once', /declares no option "nope"/.test(g.nope || ''), g.nope);
    const rec = () => P.list().find((x) => x.name === 'gm');
    const opt = (k) => rec().options.find((o) => o.key === k);
    check('list: options with their defaults, types, choices and extras', opt('auto').value === true && opt('auto').isDefault && opt('size').choices.length === 2 && opt('mb').unit === 'MB' && opt('dir').value === null && opt('dir').defaultLabel === 'the usual folder', JSON.stringify(rec().options));
    check('list: keys / keysReason / loaded ride along', rec().loaded === true && typeof rec().keysReason === 'string', JSON.stringify(rec()));

    const r1 = P.setOption('gm', 'auto', false);
    check('setOption: ok, served back as not-default', r1.ok && r1.option.value === false && r1.option.isDefault === false && r1.told === 2, JSON.stringify(r1));
    check('setOption: the feature hears it, and ITS OWN ctx.settings already reads the new value (one store)', JSON.stringify(g.heard.slice(0, 2)) === JSON.stringify([['auto', false, false], ['*', 'auto']]), JSON.stringify(g.heard));
    check('setOption: written to the feature\'s own file', JSON.parse(fs.readFileSync(path.join(h.userData, 'features', 'gm.json'), 'utf8')).auto === false);
    check('setOption: logged with who did it', h.lines.some((l) => l === 'gm: option auto set to false by Mantle Settings'), JSON.stringify(h.lines.slice(-3)));
    g.ctx.settings.set('size', 'l');
    check('the other road (a card writing ctx.settings) is what Mantle Settings reads next', opt('size').value === 'l');
    const bad = P.setOption('gm', 'size', 'xl');
    check('setOption: a value that is not a choice is refused in words, nothing written', !bad.ok && /must be one of Small, Large/.test(bad.reason) && opt('size').value === 'l', JSON.stringify(bad));
    check('setOption: a number out of range is refused', /at most 900 MB/.test(P.setOption('gm', 'mb', 1000).reason || ''));
    check('setOption: a number sent as text is taken as the number', P.setOption('gm', 'mb', '450').option.value === 450);
    check('setOption: a folder that does not exist is refused', /does not exist/.test(P.setOption('gm', 'dir', path.join(folder, 'nope')).reason || ''));
    const fo = P.setOption('gm', 'dir', folder);
    check('setOption: a real folder is kept, and its path is NOT logged', fo.ok && opt('dir').value === folder && !h.lines.some((l) => l.includes(folder)) && h.lines.some((l) => l === 'gm: option dir changed by Mantle Settings'), JSON.stringify(fo));
    check('setOption: text is never logged', P.setOption('gm', 'note', 'SECRET-TEXT-9').ok && !h.lines.some((l) => l.includes('SECRET-TEXT-9')));
    const rs = P.setOption('gm', 'auto', null);
    check('setOption: null resets to the default (the key leaves the file)', rs.ok && rs.option.isDefault && !('auto' in JSON.parse(fs.readFileSync(path.join(h.userData, 'features', 'gm.json'), 'utf8'))), JSON.stringify(rs));
    check('setOption: an unknown option / feature is refused in words', /has no option called "zzz"/.test(P.setOption('gm', 'zzz', 1).reason) && /no feature called "nope"/.test(P.setOption('nope', 'a', 1).reason));
    check('onChange: Mantle Settings heard the option writes', global.__panel.changes.some((e) => e.what === 'option' && e.feature === 'gm'), JSON.stringify(global.__panel.changes.slice(-2)));

    const e1 = P.setEnabled('gm', false);
    check('setEnabled: the tray\'s switch, answered with the fresh record, logged by label', e1.ok && e1.feature.enabled === false && h.lines.some((l) => l === 'gm: turned off by Mantle Settings'), JSON.stringify(e1));
    check('setEnabled: not true/false is refused', !P.setEnabled('gm', 'yes').ok);
    P.setEnabled('gm', true);
    check('switcher: null when main gave none', global.__panel.ctx.host.switcher === null);

    // The store outlives a rest: the woken ctx reads what was set while it rested, and is the same store.
    const before = g.ctx.settings;
    await h.f.restAll('VALORANT runs');
    const whileResting = P.setOption('gm', 'size', 's');
    check('setOption while resting: saved, nobody told (it reads it on wake)', whileResting.ok && whileResting.told === 0, JSON.stringify(whileResting));
    await h.f.wakeAll('VALORANT exited');
    check('wake: the new ctx has the SAME settings store and reads the value set while resting', g.installs === 2 && g.ctx.settings === before && g.ctx.settings.get('size') === 's');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(folder, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

/* ---- resting while a game runs (lane memfix, 2026-09-26): restAll / wakeAll ---- */
async function restChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-rest-'));
  const mod = (name, chord, rest) => `'use strict';
module.exports = { name: '${name}', label: '${name} label', defaultOn: true, chords: ['${chord}'], observe: []${rest ? ', rest: true' : ''},
  install(ctx) {
    const g = global.__rest_${name} = global.__rest_${name} || { installs: 0, stops: [] };
    g.installs++; g.ctx = ctx; g.rests = g.rests || [];
    ctx.onRest((e) => { g.rests.push(e); });
    ctx.command('ping', async () => 'pong ' + g.installs);
    ctx.replay('${name}.state', () => ({ n: g.installs }));
    return { stop(why, how) { g.stops.push({ why, how }); } };
  } };
`;
  fs.writeFileSync(path.join(dir, 'rester.js'), mod('rester', 'Win+V', true));
  fs.writeFileSync(path.join(dir, 'stayer.js'), mod('stayer', 'Win+Z', false));
  try {
    const h = harness(dir, false);
    h.f.load();
    await h.f.applyLive('unit');
    await sleep(60);
    const R = global.__rest_rester, K = global.__rest_stayer;
    const hot = () => h.sidecar.calls.filter((c) => c.cmd === 'hotkey').pop();
    check('rest: before, both chords are taken', JSON.stringify(hot().args.chords) === JSON.stringify(['Win+V', 'Win+Z']), JSON.stringify(hot()));
    const rested = await h.f.restAll('VALORANT runs');
    await sleep(60);
    check('rest: restAll stops only rest:true features, and says which', JSON.stringify(rested) === '["rester"]' && R.stops.length === 1 && K.stops.length === 0, JSON.stringify(rested));
    check('rest: stop() is told it is only resting', R.stops[0].how && R.stops[0].how.rest === true && /resting while VALORANT runs/.test(R.stops[0].why), JSON.stringify(R.stops));
    check('rest: its chord goes back to Windows, the other stays', JSON.stringify(hot().args.chords) === '["Win+Z"]', JSON.stringify(hot()));
    const p = h.state.get().features.rester;
    check('rest: HEALTHY, "resting while ..." (not a fault, not stopped)', p.ok === true && p.resting === 'VALORANT runs' && p.reason === 'resting while VALORANT runs' && !p.stopped && p.broken === null && /Windows' own while Mantle rests/.test(p.keysReason), JSON.stringify(p));
    check('rest: no problem row for it', !h.state.problems().some((x) => /rester/.test(JSON.stringify(x))), JSON.stringify(h.state.problems()));
    let said = null;
    try { await h.commands['rester.ping'](); } catch (e) { said = e.message; }
    check('rest: its commands answer in words', /rester label is resting while VALORANT runs; it is back when the game exits/.test(said || ''), said);
    check('rest: its replay is gone', h.f.replay('rester.state') === null);
    check('rest: features.list names it resting', h.f.list().find((x) => x.name === 'rester').resting === 'VALORANT runs');
    check('rest: a second restAll does nothing', JSON.stringify(await h.f.restAll('VALORANT runs')) === '[]' && R.stops.length === 1);
    // spotgame lane: a feature that stays up hears the rest (ctx.onRest); a resting one does not
    check('onRest: the feature that stays up is told, once per restAll', JSON.stringify(K.rests) === '[{"on":true,"why":"VALORANT runs"},{"on":true,"why":"VALORANT runs"}]', JSON.stringify(K.rests));
    check('onRest: a rest:true feature is not told (it is stopped instead)', R.rests.length === 0, JSON.stringify(R.rests));
    const back = await h.f.wakeAll('VALORANT exited');
    check('onRest: told on the wake too', JSON.stringify(K.rests[K.rests.length - 1]) === '{"on":false,"why":"VALORANT exited"}' && R.rests.length === 0, JSON.stringify(K.rests));
    await sleep(60);
    check('wake: installed again, the same install() as at start', JSON.stringify(back) === '["rester"]' && R.installs === 2, JSON.stringify(back));
    check('wake: its command works again (the new one)', (await h.commands['rester.ping']()) === 'pong 2');
    check('wake: its chord is taken again', JSON.stringify(hot().args.chords) === JSON.stringify(['Win+V', 'Win+Z']), JSON.stringify(hot()));
    const p2 = h.state.get().features.rester;
    check('wake: healthy, working, no resting mark', p2.ok === true && p2.reason === 'working' && !p2.resting && p2.keys === true, JSON.stringify(p2));
    await h.f.restAll('cs2 runs');
    await h.f.stopAll('quit');
    const back2 = await h.f.wakeAll('too late');
    check('stopAll while resting: stays down, never installed again', back2.length === 0 && R.installs === 2 && h.state.get().features.rester.stopped === true, JSON.stringify(h.state.get().features.rester));
  } finally {
    delete global.__rest_rester; delete global.__rest_stayer;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

/* ---- core-lib quality pass (2026-09-29): leaks on a failed install, late installs, a way back ----
 * Each of these failed on the pre-pass loader: a feature whose install() threw after subscribing
 * kept its sidecar listeners and commands alive (and they still ran), an install that finished after
 * its 10 s deadline stayed "not healthy" for good, a handle that arrived after stopAll() was never
 * stopped (its windows outlived the quit), and a feature that was down had no way back short of
 * restarting Mantle. */
async function hardeningChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-hard-'));
  writeFixtures(dir, {
    'leaky.js': `module.exports = { name: 'leaky', label: 'Leaky', defaultOn: true, chords: ['Win+V'],
      install(ctx) { ctx.sidecar.on('clip', () => { global.__leakyHeard = (global.__leakyHeard || 0) + 1; });
        ctx.command('go', async () => 'went'); ctx.replay('leaky.items', () => 1); ctx.onChord('Win+V', () => {});
        ctx.host.features.onChange(() => {});
        throw new Error('half way'); } };`,
    'leakyasync.js': `module.exports = { name: 'leakyasync', label: 'Leaky async', defaultOn: true,
      async install(ctx) { ctx.sidecar.on('clip', () => { global.__leakyAsyncHeard = (global.__leakyAsyncHeard || 0) + 1; });
        ctx.command('go', async () => 'went'); await new Promise((r) => setTimeout(r, 5)); throw new Error('async half way'); } };`,
    'slow.js': `module.exports = { name: 'slow', label: 'Slow', defaultOn: true,
      async install(ctx) { await new Promise((r) => setTimeout(r, 150)); return { stop() { global.__slowStops = (global.__slowStops || 0) + 1; } }; } };`,
    'flaky.js': `module.exports = { name: 'flaky', label: 'Flaky', defaultOn: true, chords: ['Win+Z'],
      install(ctx) { const g = global.__flaky = global.__flaky || { installs: 0, stops: 0 }; g.installs++;
        if (g.installs === 1) throw new Error('first start fails');
        ctx.command('ping', async () => 'pong ' + g.installs);
        ctx.onChord('Win+Z', () => { if (g.installs === 2) throw new Error('chord blew up'); });
        return { stop() { g.stops++; } }; } };`,
    'zclash.js': `module.exports = { name: 'zclash', label: 'Clash', defaultOn: true, chords: ['Win+V'], install() { global.__clashInstalled = true; return {}; } };`,
  });
  try {
    const h = harness(dir, true, null, { installMs: 60 });
    const base = h.sidecar.listenerCount('clip');
    h.f.load();
    await sleep(30);
    check('failed install: its sidecar listener is removed', h.sidecar.listenerCount('clip') === base, `${h.sidecar.listenerCount('clip')} vs ${base}`);
    h.sidecar.emit('clip', {});
    check('failed install: its handlers never run afterwards', !global.__leakyHeard && !global.__leakyAsyncHeard, `${global.__leakyHeard} / ${global.__leakyAsyncHeard}`);
    check('failed install: its commands are gone', !h.commands['leaky.go'] && !h.commands['leakyasync.go'], Object.keys(h.commands).join(','));
    check('failed install: its replay is gone', h.f.replay('leaky.items') === null);
    check('failed install: the words say why', /install\(\) threw half way/.test(h.state.get().features.leaky.reason), h.state.get().features.leaky.reason);

    // slow: the 60 ms deadline passes, then install finishes at ~150 ms -> healthy again.
    await sleep(60);
    check('slow install: marked not healthy at the deadline', h.state.get().features.slow.ok === false, JSON.stringify(h.state.get().features.slow));
    await sleep(200);
    check('slow install: healthy again once it finishes', h.state.get().features.slow.ok === true && h.state.get().features.slow.reason === 'working', JSON.stringify(h.state.get().features.slow));

    // restart: flaky failed its first install; restart brings it up.
    check('flaky: down after its first install', h.state.get().features.flaky.ok === false);
    const r1 = await h.f.restart('flaky', 'a test');
    check('restart: a down feature comes back', r1.ok === true && r1.feature && r1.feature.running === true, JSON.stringify(r1));
    check('restart: its command works', (await h.commands['flaky.ping']()) === 'pong 2');
    h.f.fireChord('Win+Z');
    await sleep(10);
    check('restart: a handler throw marks it down again', h.state.get().features.flaky.ok === false, JSON.stringify(h.state.get().features.flaky));
    const r2 = await h.f.restart('flaky', 'a test');
    check('restart: a running-but-unhealthy feature is stopped then installed again', r2.ok === true && global.__flaky.stops === 1 && global.__flaky.installs === 3, JSON.stringify({ r2, g: global.__flaky }));
    check('restart: the command is the new one', (await h.commands['flaky.ping']()) === 'pong 3');
    const r3 = await h.f.restart('leaky', 'a test');
    check('restart: a feature that fails again says why', r3.ok === false && /half way/.test(r3.reason || ''), JSON.stringify(r3));
    check('restart: the failed retry leaks nothing either', h.sidecar.listenerCount('clip') === base, String(h.sidecar.listenerCount('clip')));
    const r4 = await h.f.restart('zclash', 'a test');
    check('restart: a chord clash is refused, never installed over the owner', r4.ok === false && /already taken/.test(r4.reason || '') && !global.__clashInstalled, JSON.stringify(r4));
    const r5 = await h.f.restart('nope', 'a test');
    check('restart: an unknown name is refused in words', r5.ok === false && /no feature called "nope"/.test(r5.reason || ''), JSON.stringify(r5));
    const viaCtx = global.__flaky && typeof h.f.list === 'function';
    check('restart: offered to Settings through ctx.host.features', viaCtx && typeof makeHostRestart(h) === 'function');

    // a handle that arrives after stopAll is stopped at once, never leaked.
    global.__slowStops = 0;
    const r6 = h.f.restart('slow', 'a test');
    await sleep(20);
    await h.f.stopAll('quit');
    await r6;
    await sleep(200);
    check('late handle after stopAll: its stop() still runs', global.__slowStops >= 1, String(global.__slowStops));
    const r7 = await h.f.restart('flaky', 'a test');
    check('restart after stopAll: refused in words', r7.ok === false && /put Windows back|shutting down/.test(r7.reason || ''), JSON.stringify(r7));

    // A features.json that is not an object: moved aside and said, never silently saved over.
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-sw-'));
    fs.writeFileSync(path.join(ud, 'features.json'), '5');
    const lines = [];
    createFeatures({ dir, test: true, root: ROOT, userData: ud, state: new ShellState('test', 'bottom'), sidecar: fakeSidecar(), commands: {}, broadcast() {}, log: (l) => lines.push(l), host: {} });
    check('corrupt switches: said in the log', lines.some((l) => /saved on\/off switches were not used/.test(l)), lines.join(' | '));
    check('corrupt switches: kept aside, not lost', fs.existsSync(path.join(ud, 'features.json.unreadable')) && !fs.existsSync(path.join(ud, 'features.json')));
    check('corrupt switches: no path in the log line', !lines.some((l) => l.includes(ud) || /[A-Za-z]:\\/.test(l)), lines.join(' | '));
    // A broken per-feature settings file: its log line names the file, never the full path.
    fs.mkdirSync(path.join(ud, 'features'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'features', 'probe.json'), '{not json');
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-probe2-'));
    writeFixtures(d2, { 'probe.js': `module.exports = { name: 'probe', label: 'Probe', defaultOn: true, install(ctx) { ctx.settings.get('x'); return {}; } };` });
    const lines2 = [];
    const f2 = createFeatures({ dir: d2, test: true, root: ROOT, userData: ud, state: new ShellState('test', 'bottom'), sidecar: fakeSidecar(), commands: {}, broadcast() {}, log: (l) => lines2.push(l), host: {} });
    f2.load();
    check('broken settings file: said', lines2.some((l) => /saved settings were not used/.test(l)), lines2.join(' | '));
    check('broken settings file: no full path in the log', !lines2.some((l) => l.includes(ud)), lines2.filter((l) => l.includes(ud)).join(' | '));
    fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
  } finally {
    for (const k of ['__leakyHeard', '__leakyAsyncHeard', '__slowStops', '__flaky', '__clashInstalled']) delete global[k];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}
/* ctx.host.features.restart, read off a fixture's ctx (the fixtures above keep no ctx; the loaded
   feature list proves the API through a tiny probe feature instead). */
function makeHostRestart(h) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-probe-'));
  try {
    writeFixtures(dir, { 'probe.js': `module.exports = { name: 'probe', label: 'Probe', defaultOn: true, install(ctx) { global.__probeCtx = ctx; return {}; } };` });
    const h2 = harness(dir, true);
    h2.f.load();
    const fn = global.__probeCtx && global.__probeCtx.host.features.restart;
    delete global.__probeCtx;
    return fn;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-fixture-'));
  writeFixtures(dir, UNIT_FIXTURES);
  try {
    pureChecks();
    await testModeChecks(dir);
    await liveChecks(dir);
    await volumeChordChecks();
    await restChecks();
    await optionsChecks();
    await hardeningChecks();
    if (process.argv.includes('--electron')) await electronCheck();
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack : String(e));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
  console.log(`features tests: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})();
