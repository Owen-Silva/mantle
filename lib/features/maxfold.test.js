'use strict';
/*
 * maxfold.test.js - lib/features/maxfold.js + lib/features/_maxfold-tokens.js (lane unfold-max, 2026-10-23).
 *
 *   node lib/features/maxfold.test.js
 *
 * Pure node, no Electron, no sidecar. First the token parsing against the REAL ui/shared/unfold.css and
 * glass-light.css, then synthetic CSS (missing tokens, var() chains, linear() lists with positions,
 * cubic-bezier, bad values), curve sampling and the config payload. Then the feature itself, loaded by
 * the real lib/features.js createFeatures with a fake sidecar (the harness()/fakeSidecar() pattern of
 * lib/features.test.js): on/off, onReady re-sends, stop() and a game rest, an old sidecar, armed:false,
 * the skip rate limit, 'done' as numbers, no window name ever in the log, --test invisible:true.
 * One summary line: "maxfold unit: N passed, M failed"; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const T = require('./_maxfold-tokens');
const { createFeatures } = require('../features');
const { ShellState } = require('../state');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(`  FAIL ${name}${detail !== undefined ? ` (${String(detail).slice(0, 400)})` : ''}`);
  return false;
}
const tick = () => new Promise((r) => setImmediate(r));
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-3 : eps);

/* ---- tokens: the real files ---- */
function realTokens() {
  const uf = fs.readFileSync(path.join(ROOT, 'ui', 'shared', 'unfold.css'), 'utf8');
  const gl = fs.readFileSync(path.join(ROOT, 'ui', 'shared', 'glass-light.css'), 'utf8');
  const t = T.readTokens(uf, gl);
  check('real css: no fallback needed', t.fallbacks.length === 0, JSON.stringify(t.fallbacks));
  check('real css: --unfold-quick-ms is 240 ms', t.ms === 240, t.ms);
  check('real css: the curve resolves --unfold-in through var(--m-spring) to the 41-point spring', t.curveFrom === '--unfold-in' && t.curve.length === 41 && t.curve[0] === 0 && t.curve[1] === 0.0208 && t.curve[40] === 1, JSON.stringify(t.curve.slice(0, 3)));
  check('real css: the spring overshoots (max about 1.015)', near(Math.max(...t.curve), 1.0151, 1e-4), Math.max(...t.curve));
  check('real css: the tint is Mantle indigo from :root --lg-acc (not the dark theme value)', t.tintFrom === '--lg-acc' && t.tint.r === 0x44 && t.tint.g === 0x36 && t.tint.b === 0xE8, JSON.stringify(t.tint));
  check('real css: blurFrac from quick 6 px / full 18 px = .018 * .667 = .012', t.blurFrom === 'tokens' && near(t.blurFrac, 0.012, 1e-4), t.blurFrac);
  const vars = T.rootVars(gl);
  const dark = T.rootVars(gl, (sel) => sel === ':root[data-theme="dark"]');
  check('rootVars: :root and :root[data-theme="dark"] are kept apart', vars['--lg-acc'] === '#4436E8' && /^#9fb4cc$/i.test(dark['--lg-acc'] || ''), `${vars['--lg-acc']} / ${dark['--lg-acc']}`);
  return t;
}

/* ---- tokens: synthetic ---- */
function syntheticTokens() {
  let t = T.readTokens('', '');
  check('empty css: every value falls back', t.ms === 240 && t.curveFrom === 'fallback' && t.tintFrom === 'fallback' && t.blurFrom === 'fallback' && t.blurFrac === 0.012 && t.tint.r === 0x44 && t.tint.b === 0xE8, JSON.stringify(t));
  check('empty css: four fallbacks, each said in words', t.fallbacks.length === 4 && t.fallbacks.every((l) => /, so /.test(l)), JSON.stringify(t.fallbacks));
  check('fallback curve: ease-out cubic, 41 points, 0 -> 1', t.curve.length === 41 && t.curve[0] === 0 && t.curve[40] === 1 && near(t.curve[20], 0.875), t.curve[20]);

  const uf = `/* c { --unfold-quick-ms: 9999ms } */
    :root { --unfold-quick-ms: .3s; --unfold-quick-blur: 12px; --unfold-full-blur: 12px;
            --unfold-in: var(--nope, var(--curve-b)); --unfold-tint: var(--brand); }
    .other { --unfold-quick-ms: 100ms; }`;
  const gl = `:root { --curve-b: cubic-bezier(0, 0, .58, 1); --brand: rgb(10, 20, 30); --lg-acc: #fff; }
    :root[data-theme="dark"] { --brand: #000; }`;
  t = T.readTokens(uf, gl);
  check('seconds are read as ms; a commented-out and a non-:root rule are ignored', t.ms === 300, t.ms);
  check('var() chain with a fallback var() that resolves in the other file', t.curveFrom === '--unfold-in' && near(t.curve[20], T.parseCubicBezier('ease-out')[20]) && t.curve[0] === 0 && t.curve[40] === 1, JSON.stringify(t.curve.slice(18, 22)));
  check('--unfold-tint wins over --lg-acc, through a var()', t.tintFrom === '--unfold-tint' && t.tint.r === 10 && t.tint.g === 20 && t.tint.b === 30, JSON.stringify(t.tint));
  check('blurFrac is capped by clamp(2q/f, .3, 1): equal blurs give .018', near(t.blurFrac, 0.018), t.blurFrac);
  t = T.readTokens(':root{--unfold-quick-blur:1px;--unfold-full-blur:100px}', '');
  check('blurFrac floor: clamp .3 -> .0054', near(t.blurFrac, 0.0054), t.blurFrac);

  t = T.readTokens(':root{--unfold-quick-ms: fast; --unfold-in: bounce(1); --unfold-tint: notacolour; --unfold-quick-blur: 6em; --unfold-full-blur: 18px}',
    ':root{--m-spring: linear(0, 0.5 25%, 1); --lg-acc: #abc}');
  check('bad duration -> 240 and said', t.ms === 240 && t.fallbacks.some((l) => /--unfold-quick-ms is not a duration/.test(l)), JSON.stringify(t.fallbacks));
  check('a bad --unfold-in falls through to --m-spring', t.curveFrom === '--m-spring', t.curveFrom);
  check('linear() with a position: 0.5 at 25 %, so 0.5 at p=.25 and 0.75 at p=.625', near(T.sampleCurve(t.curve, 0.25), 0.5) && near(T.sampleCurve(t.curve, 0.625), 0.75), `${T.sampleCurve(t.curve, 0.25)} ${T.sampleCurve(t.curve, 0.625)}`);
  check('a bad --unfold-tint falls back to --lg-acc (#abc short form)', t.tintFrom === '--lg-acc' && t.tint.r === 0xaa && t.tint.g === 0xbb && t.tint.b === 0xcc, JSON.stringify(t.tint));
  check('a blur not in px -> .012 and said', t.blurFrac === 0.012 && t.fallbacks.some((l) => /blur/.test(l)), JSON.stringify(t.fallbacks));

  t = T.readTokens(':root{--unfold-in: var(--loop-a)} :root{--loop-a: var(--loop-b); --loop-b: var(--loop-a)}', '');
  check('a var() cycle ends and falls back (no hang)', t.curveFrom === 'fallback', t.curveFrom);
  t = T.readTokens(':root{--unfold-in: var(--missing)}', '');
  check('an unknown var() with no fallback is unusable -> fallback', t.curveFrom === 'fallback');
  check('later :root rules win', T.rootVars(':root{--x:1} :root{--x:2}')['--x'] === '2');
  check('a :root inside @media is read', T.rootVars('@media (min-width: 1px) { :root { --x: 3; } }')['--x'] === '3');
  check('a selector list with :root is read', T.rootVars('html, :root { --x: 4 }')['--x'] === '4');

  // the parsers
  check('parseMs: 240ms / .24s / bad / out of range', T.parseMs('240ms') === 240 && T.parseMs('.24s') === 240 && T.parseMs('240') === null && T.parseMs('5ms') === null && T.parseMs('9s') === null);
  check('parsePx: 6px / 0 / em / negative', T.parsePx('6px') === 6 && T.parsePx('0') === 0 && T.parsePx('6em') === null && T.parsePx('-2px') === null);
  const c = (v) => JSON.stringify(T.parseColor(v));
  check('parseColor: #rgb #rrggbb #rrggbbaa rgb() rgba() and junk', c('#fff') === '{"r":255,"g":255,"b":255}' && c('#4436E8') === '{"r":68,"g":54,"b":232}' &&
    c('#4436e880') === '{"r":68,"g":54,"b":232}' && c('rgb(1,2,3)') === '{"r":1,"g":2,"b":3}' && c('rgba(1, 2, 3, .5)') === '{"r":1,"g":2,"b":3}' &&
    c('rgb(1 2 3 / 50%)') === '{"r":1,"g":2,"b":3}' && T.parseColor('rgb(300,0,0)') === null && T.parseColor('indigo') === null);
  check('parseLinear: refuses junk, one stop, a bad position, wild values', T.parseLinear('linear(0)') === null && T.parseLinear('linear(0, x, 1)') === null &&
    T.parseLinear('linear(0, 0.5 2, 1)') === null && T.parseLinear('linear(0, 9, 1)') === null && T.parseLinear('ease') === null);
  const two = T.parseLinear('linear(0, 1)', 5);
  check('parseLinear: linear(0, 1) is a straight line', JSON.stringify(two) === '[0,0.25,0.5,0.75,1]', JSON.stringify(two));
  const dbl = T.parseLinear('linear(0, 0.2 0% 50%, 1)', 5);
  check('parseLinear: a stop with two positions holds flat between them', JSON.stringify(dbl) === '[0.2,0.2,0.2,0.6,1]', JSON.stringify(dbl));
  check('parseCubicBezier: refuses x outside 0..1 and the wrong count', T.parseCubicBezier('cubic-bezier(2,0,1,1)') === null && T.parseCubicBezier('cubic-bezier(0,0,1)') === null);
  const lin = T.parseCubicBezier('linear', 5);
  check('parseCubicBezier: the linear keyword is the identity', lin.every((v, i) => near(v, i / 4)), JSON.stringify(lin));

  // sampling
  const pts = [0, 0.5, 1];
  check('sampleCurve: ends, middle, between, clamped outside 0..1', T.sampleCurve(pts, 0) === 0 && T.sampleCurve(pts, 1) === 1 && T.sampleCurve(pts, 0.5) === 0.5 &&
    near(T.sampleCurve(pts, 0.25), 0.25) && T.sampleCurve(pts, -1) === 0 && T.sampleCurve(pts, 2) === 1);
  check('sampleCurve: a bad list samples the fallback curve', near(T.sampleCurve(null, 0.5), 0.875));
}

/* ---- config ---- */
function configChecks(real) {
  check('config off is exactly {on:false}', JSON.stringify(T.buildConfig(real, { on: false })) === '{"on":false}');
  const on = T.buildConfig(real, { on: true });
  check('config on: every SPEC-LOOK key with its default', on.on === true && on.ms === 240 && on.curve.length === 41 && on.blurFrac === 0.012 &&
    JSON.stringify(on.tint) === '{"r":68,"g":54,"b":232}' && on.baseMix === 0.3 && on.innerDark === 0.35 && on.darkCap === 0.6 &&
    on.strips === 10 && on.cover === 'left' && on.holdMs === 300, JSON.stringify(Object.assign({}, on, { curve: on.curve.length })));
  check('config on: no invisible/dryRun outside a test, no lip/sheen/stretch keys, no argument called id',
    !('invisible' in on) && !('dryRun' in on) && !('lip' in on) && !('sheen' in on) && !('stretch' in on) && !('id' in on) && !('cmd' in on), Object.keys(on).join());
  check('config on in --test adds invisible:true', T.buildConfig(real, { on: true, test: true }).invisible === true);
  on.curve[0] = 99;
  check('config: the curve is a copy (the tokens are not changed)', real.curve[0] === 0);
}

/* ---- the feature through the real lib/features.js ---- */
function fakeSidecar(respond) {
  const s = new EventEmitter();
  s.calls = [];
  s.down = null;
  s.respond = respond;
  s.blockedReason = () => s.down;
  s.call = async (cmd, args) => {
    s.calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });
    if (cmd === 'hotkey') return { installed: true, chords: (args.chords || []).slice(), observe: (args.observe || []).slice(), reason: null };
    if (s.respond) return s.respond(cmd, args);
    return { echoed: cmd };
  };
  return s;
}

const ARMED = (args) => ({ armed: !!args.on, hooked: !!args.on, why: null, winAnim: true, reduced: false, passive: true, recordFile: 'x' });

function harness(test, respond, rootDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-maxfold-unit-'));
  fs.writeFileSync(path.join(dir, 'maxfold.js'), `module.exports = require(${JSON.stringify(path.join(__dirname, 'maxfold.js'))});`);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-maxfold-ud-'));
  const state = new ShellState(test ? 'test' : 'live', 'bottom');
  const sidecar = fakeSidecar(respond || ((cmd, args) => (cmd === 'maxfold.config' ? ARMED(args) : { armed: true, plays: 3 })));
  const commands = { 'state.get': async () => state.get() };
  const lines = [];
  const f = createFeatures({
    dir, test, root: rootDir || ROOT, userData, state, sidecar, commands,
    broadcast: () => {}, log: (l) => lines.push(l),
    host: { openLauncher: (a) => a, barRect: () => null, display: () => ({ id: 1 }), bar: { up: () => true, onMotion: () => () => {} } },
  });
  const configs = () => sidecar.calls.filter((c) => c.cmd === 'maxfold.config').map((c) => c.args);
  const piece = () => (state.get().features || {}).maxfold || {};
  const ours = () => lines.filter((l) => /^maxfold: /.test(l));
  const done = () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp */ } };
  return { f, state, sidecar, commands, lines, configs, piece, ours, done };
}

async function featureChecks() {
  const M = require('./maxfold');
  M._resetSaid();
  let h = harness(true);
  try {
    const up = h.f.load();
    await tick(); await tick();
    check('load: maxfold validates and installs through lib/features.js', up.includes('maxfold'), JSON.stringify(up));
    const rec = h.f.list().find((x) => x.name === 'maxfold') || {};
    check('module: label, on by default, rests for games, no chords', rec.label === 'Unfold when windows maximize' && M.defaultOn === true && M.rest === true && M.chords.length === 0 && M.observe.length === 0, JSON.stringify(rec));
    let cs = h.configs();
    check('install: one maxfold.config {on:true} at once (sidecar up)', cs.length === 1 && cs[0].on === true && cs[0].ms === 240 && cs[0].strips === 10, JSON.stringify(cs.map((c) => c.on)));
    check('--test: the config carries invisible:true', cs[0].invisible === true);
    check('healthy when armed', h.piece().ok === true, JSON.stringify(h.piece()));
    check('the real css needs no fallback, so none is said', !h.ours().some((l) => /fallback/.test(l)), JSON.stringify(h.ours()));

    h.f.setEnabled('maxfold', false, 'unit');
    await tick(); await tick();
    cs = h.configs();
    check('switch off -> maxfold.config {on:false} only', cs.length === 2 && JSON.stringify(cs[1]) === '{"on":false}', JSON.stringify(cs[1]));
    check('off + not armed is healthy (that is the point)', h.piece().ok === true, JSON.stringify(h.piece()));
    h.f.setEnabled('maxfold', true, 'unit');
    await tick(); await tick();
    cs = h.configs();
    check('switch on -> {on:true, ...} again', cs.length === 3 && cs[2].on === true && cs[2].curve.length === 41);

    h.sidecar.emit('ready');
    await tick(); await tick();
    cs = h.configs();
    check('a sidecar restart (onReady) re-sends the config', cs.length === 4 && cs[3].on === true);

    // events
    const t0 = 1000000;
    let now = t0;
    M._now = () => now;
    const secret = 'Quarterly salaries - Excel';
    for (let i = 0; i < 5; i++) h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'skip', action: 'maximize', reason: 'too small to animate', title: secret, exe: 'EXCEL.EXE', path: 'C:\\secret\\pay.xlsx' });
    let skips = h.ours().filter((l) => /skip:/.test(l));
    check('skip: the same reason is said once a minute', skips.length === 1 && /skip: maximize, too small to animate$/.test(skips[0]), JSON.stringify(skips));
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'skip', action: 'restore', reason: 'a tool window' });
    skips = h.ours().filter((l) => /skip:/.test(l));
    check('skip: a different reason is said at once', skips.length === 2 && /a tool window/.test(skips[1]), JSON.stringify(skips));
    now = t0 + 61000;
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'skip', action: 'maximize', reason: 'too small to animate' });
    skips = h.ours().filter((l) => /skip:/.test(l));
    check('skip: after a minute it is said again with the held count', skips.length === 3 && /\(and 4 more since the last line\)/.test(skips[2]), JSON.stringify(skips));
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'skip', action: 'maximize', reason: `${secret} is too small` });
    skips = h.ours().filter((l) => /skip:/.test(l));
    check('skip: an unknown reason (could carry a name) is logged as "another reason"', /skip: maximize, another reason$/.test(skips[3] || ''), JSON.stringify(skips));
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'skip', action: 'maximize', reason: 'Windows would not let Mantle draw the window (0x80070005)' });
    check('skip: the thumbnail failure reason keeps its code', h.ours().some((l) => /draw the window \(0x80070005\)/.test(l)));

    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'play', action: 'maximize', title: secret });
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'done', action: 'maximize', firstFrameMs: 2.14, frames: 15, gapMedMs: 16.7, gapMaxMs: 17.93, missedDelta: 0, totalMs: 300, endedSharp: true, cancelled: false, title: secret, name: secret });
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'done', action: secret, firstFrameMs: 'x', cancelled: true });
    const dones = h.ours().filter((l) => /done:/.test(l));
    check('done: one line of numbers', dones[0] === 'maxfold: done: maximize, first frame 2.1 ms, 15 frames, worst gap 17.9 ms, missed 0', dones[0]);
    check('done: an odd action and a non-number are words/?, never echoed', /done: a change, first frame \? ms, \? frames, worst gap \? ms, missed \?, cancelled$/.test(dones[1] || ''), dones[1]);
    h.sidecar.emit('maxfold', { ev: 'maxfold', kind: 'restored-stale', title: secret, hwnd: 1234 });
    check('restored-stale: said in words', h.ours().some((l) => /put back the window animation Mantle had switched off/.test(l)));
    check('PRIVACY: no window name, exe or path ever reaches the log', !h.lines.some((l) => l.includes('Quarterly') || l.includes('EXCEL') || l.includes('secret') || l.includes('pay.xlsx')),
      JSON.stringify(h.lines.filter((l) => /Quarterly|EXCEL|secret/.test(l))));

    const st = await h.commands['maxfold.state']();
    check('maxfold.state: sidecar state + tokens + counts', st.ok && st.sidecar && st.sidecar.plays === 3 && st.tokens.ms === 240 && st.tokens.curvePoints === 41 &&
      st.counts.plays === 1 && st.counts.done === 2 && st.counts.cancelled === 1 && st.counts.skips['too small to animate'] === 6 &&
      st.counts.skips['a tool window'] === 1 && st.counts.skips['another reason'] === 1 && st.counts.restoredStale === 1, JSON.stringify(st.counts));
    check('maxfold.state: counts never key a window name', !JSON.stringify(st).includes('Quarterly'));

    // rest
    const before = h.configs().length;
    await h.f.restAll('VALORANT runs');
    cs = h.configs();
    check('game rest -> stop(rest) sends {on:false}', cs.length === before + 1 && JSON.stringify(cs[cs.length - 1]) === '{"on":false}', JSON.stringify(cs.slice(before)));
    await h.f.wakeAll('VALORANT exited');
    await tick(); await tick();
    cs = h.configs();
    check('wake -> install again sends {on:true}', cs[cs.length - 1].on === true, JSON.stringify(cs[cs.length - 1]));

    // stop
    const n = h.configs().length;
    await h.f.stopAll('unit quit');
    cs = h.configs();
    check('stop() -> {on:false}', cs.length === n + 1 && JSON.stringify(cs[cs.length - 1]) === '{"on":false}', JSON.stringify(cs.slice(n)));
    h.sidecar.emit('ready');
    await tick();
    check('after stop() a sidecar restart sends nothing', h.configs().length === n + 1);
  } finally { M._now = () => Date.now(); h.done(); }

  // live run (not --test): no invisible
  h = harness(false);
  try {
    h.f.load(); await tick(); await tick();
    const cs = h.configs();
    check('live run: the config has no invisible key', cs.length >= 1 && cs[0].on === true && !('invisible' in cs[0]), JSON.stringify(Object.keys(cs[0] || {})));
    await h.f.stopAll('unit');
  } finally { h.done(); }

  // an old sidecar
  h = harness(true, async (cmd) => { throw new Error(`unknown command: ${cmd}`); });
  try {
    h.f.load(); await tick(); await tick();
    check('old sidecar: health false with the rebuild reason', h.piece().ok === false && h.piece().reason === 'the sidecar is older than this feature (rebuild it)', JSON.stringify(h.piece()));
    const st = await h.commands['maxfold.state']();
    check('old sidecar: maxfold.state says so too', st.ok === false && /older than this feature/.test(st.reason), JSON.stringify(st));
    await h.f.stopAll('unit');
  } finally { h.done(); }

  // armed:false with a why
  const why = 'Windows would not let Mantle watch windows (0x5)';
  h = harness(true, (cmd, args) => (cmd === 'maxfold.config' ? { armed: false, hooked: false, why: args.on ? why : 'switched off', winAnim: true, reduced: false, passive: true } : {}));
  try {
    h.f.load(); await tick(); await tick();
    check('armed:false while it should be on -> health false with the sidecar why', h.piece().ok === false && h.piece().reason === why, JSON.stringify(h.piece()));
    h.f.setEnabled('maxfold', false, 'unit');
    await tick(); await tick();
    check('armed:false while switched off -> healthy', h.piece().ok === true, JSON.stringify(h.piece()));
    await h.f.stopAll('unit');
  } finally { h.done(); }

  // a sidecar that times out (not old) while on
  h = harness(true, async () => { throw new Error('no answer in 4000 ms'); });
  try {
    h.f.load(); await tick(); await tick();
    check('a failed config while on -> health false, in words', h.piece().ok === false && /did not take the settings/.test(h.piece().reason || ''), JSON.stringify(h.piece()));
    await h.f.stopAll('unit');
  } finally { h.done(); }

  // missing shared css -> every fallback said once, and not again after a rest
  M._resetSaid();
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-maxfold-root-'));
  h = harness(true, null, fakeRoot);
  try {
    h.f.load(); await tick(); await tick();
    const fb = h.ours().filter((l) => /fallback:/.test(l));
    check('missing css files: said (both files + 4 fallbacks), still on with the defaults', fb.length === 6 && fb.some((l) => /unfold\.css could not be read \(ENOENT\)/.test(l)) && h.configs()[0].ms === 240 && h.configs()[0].tint.b === 0xE8, JSON.stringify(fb));
    await h.f.restAll('VALORANT runs');
    await h.f.wakeAll('VALORANT exited');
    await tick(); await tick();
    check('fallbacks are said once (not again after a rest)', h.ours().filter((l) => /fallback:/.test(l)).length === 6);
    await h.f.stopAll('unit');
  } finally { h.done(); fs.rmSync(fakeRoot, { recursive: true, force: true }); }

  // pure helpers
  check('cleanReason: known phrase kept, anything else is "another reason"', M._cleanReason('a tool window') === 'a tool window' && M._cleanReason('Notepad') === 'another reason' && M._cleanReason(null) === 'another reason');
}

(async () => {
  try {
    const real = realTokens();
    syntheticTokens();
    configChecks(real);
    await featureChecks();
  } catch (e) {
    failures.push(`  FAIL the run threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  }
  for (const f of failures) console.log(f);
  console.log(`maxfold unit: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
