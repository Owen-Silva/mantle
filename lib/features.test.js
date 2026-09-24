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

function harness(dir, test, sidecarOpts) {
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
  check('the chord table matches the sidecar protocol', CHORDS.join() === 'Win+S,Win+V,Win+Tab,Win+Left,Win+Right,Win+Up,Win+Down,Win+Z,Win+Shift+S,PrintScreen');
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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-features-fixture-'));
  writeFixtures(dir, UNIT_FIXTURES);
  try {
    pureChecks();
    await testModeChecks(dir);
    await liveChecks(dir);
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
