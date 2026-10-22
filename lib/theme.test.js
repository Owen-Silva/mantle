'use strict';
/*
 * theme.test.js - lib/theme.js, Mantle's own light / dark (lane dm-core, 2026-10-08).
 * Plain node, no Electron: Windows' mode is a fake windowsMode(), a "Windows change" is the fake
 * flipping and windowsChanged() being called (what main.js does on nativeTheme 'updated'). The user's real
 * Windows setting is never read or touched. Files go to a fresh folder under the OS temp dir.
 *
 *   node lib/theme.test.js      -> "THEME TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTheme, resolve, badMode, isMode, windowsModeFrom, MODES, DEFAULT_MODE } = require('./theme');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-theme-test-'));
let n = 0;
const fileFor = () => path.join(dir, `p${++n}`, 'theme.json');
function fakeWindows(start) {
  const W = { mode: start, why: null, reads: 0 };
  W.fn = () => { W.reads++; return { mode: W.mode, why: W.why }; };
  return W;
}
function mk(o) {
  const logs = [];
  const W = o && o.W ? o.W : fakeWindows('dark');
  const T = createTheme(Object.assign({ file: fileFor(), windowsMode: W.fn, log: (l) => logs.push(l) }, o || {}, { W: undefined }));
  const seen = [];
  T.on((v) => seen.push(v));
  return { T, W, logs, seen };
}

// ---- resolution (pure)
check('resolve: light is light whatever Windows says', resolve('light', 'dark') === 'light' && resolve('light', null) === 'light');
check('resolve: dark is dark whatever Windows says', resolve('dark', 'light') === 'dark' && resolve('dark', null) === 'dark');
check('resolve: system follows Windows', resolve('system', 'dark') === 'dark' && resolve('system', 'light') === 'light');
check('resolve: system with Windows unknown = light (Mantle\'s original look)', resolve('system', null) === 'light');
check('modes are exactly system / light / dark, default system', MODES.join() === 'system,light,dark' && DEFAULT_MODE === 'system');
check('isMode refuses everything else', isMode('dark') && !isMode('Dark') && !isMode('auto') && !isMode('') && !isMode(null) && !isMode(1));

// ---- default
{
  const { T } = mk();
  const v = T.get();
  check('default: no file = Match Windows', v.mode === 'system', v);
  check('default: Windows dark -> Mantle dark', v.theme === 'dark' && T.theme() === 'dark' && v.windows === 'dark', v);
  check('default: the view is complete and quiet', v.ok === true && v.windowsWhy === null && v.pinned === null && v.note === null && v.reason === null, v);
}
{
  const { T } = mk({ W: fakeWindows('light') });
  check('default: Windows light -> Mantle light', T.theme() === 'light' && T.get().windows === 'light');
}

// ---- set + persistence
{
  const file = fileFor();
  const W = fakeWindows('dark');
  const a = mk({ file, W });
  const r = a.T.set('light');
  check('set light: ok, read-back value, theme light', r.ok === true && r.value === 'light' && r.mode === 'light' && r.theme === 'light', r);
  check('set: listeners hear it once with the new view', a.seen.length === 1 && a.seen[0].theme === 'light', a.seen);
  check('set: saved as {mode}', JSON.parse(fs.readFileSync(file, 'utf8')).mode === 'light');
  check('set: no .tmp left behind', !fs.existsSync(file + '.tmp'));
  const b = mk({ file, W });
  check('persistence: a new start reads the saved mode', b.T.get().mode === 'light' && b.T.theme() === 'light');
  b.T.set({ mode: 'dark' });
  check('set accepts {mode} too', b.T.get().mode === 'dark' && b.T.theme() === 'dark');
  b.T.set('system');
  const c = mk({ file, W });
  check('persistence: Match Windows is saved and restored', c.T.get().mode === 'system' && c.T.theme() === 'dark');
  const again = c.T.set('system');
  check('set to the same mode still answers ok and tells listeners (other Settings windows)', again.ok && c.seen.length === 1);
}

// ---- validation
{
  const { T, seen } = mk();
  const before = T.get();
  for (const bad of ['Dark', 'auto', '', 'light ', null, undefined, 3, ['dark'], { mode: 'neon' }]) {
    const r = T.set(bad);
    check(`validation: ${JSON.stringify(bad)} is refused in words`, r.ok === false && /Mantle's appearance can be "light", "dark" or "system" \(Match Windows\); it was sent /.test(r.reason), r);
  }
  check('validation: a refusal changes nothing and tells nobody', JSON.stringify(T.get()) === JSON.stringify(before) && seen.length === 0);
  check('validation: a long bad value is cut to 40 characters', badMode('x'.repeat(500)).length < 140);
  check('validation: never echoes an object', /a object/.test(badMode({ a: 'secret' })) && !/secret/.test(badMode({ a: 'secret' })));
}

// ---- Windows changes (the nativeTheme 'updated' path, simulated)
{
  const W = fakeWindows('dark');
  const { T, seen, logs } = mk({ W });
  check('Windows change: starts dark', T.theme() === 'dark');
  W.mode = 'light';
  check('Windows change: windowsChanged() says it moved', T.windowsChanged() === true);
  check('Windows change: Match Windows follows to light, live', T.theme() === 'light' && seen.length === 1 && seen[0].theme === 'light' && seen[0].windows === 'light', seen);
  check('Windows change: it is logged in words', logs.some((l) => /Windows apps are light now, so Mantle is light/.test(l)), logs);
  check('Windows change: nothing new = no event', T.windowsChanged() === false && seen.length === 1);
  T.set('dark');
  seen.length = 0;
  W.mode = 'dark';
  T.windowsChanged();
  W.mode = 'light';
  T.windowsChanged();
  check('Windows change: a fixed Dark stays dark, the view still reports Windows', T.theme() === 'dark' && seen.length === 2 && seen[1].windows === 'light' && seen[1].theme === 'dark', seen);
  W.mode = null; W.why = 'made up: nativeTheme is not there';
  T.set('system');
  const v = T.get();
  check('Windows unknown: Match Windows shows light and says why', v.theme === 'light' && v.windows === null && /made up: nativeTheme is not there, so Match Windows shows light/.test(v.windowsWhy), v);
}
{
  const T = createTheme({ file: fileFor(), windowsMode: () => { throw new Error('made-up registry error'); } });
  const v = T.get();
  check('Windows read that throws: light, with the reason', v.theme === 'light' && /made-up registry error/.test(v.windowsWhy), v);
}

// ---- --theme (test override)
{
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mode: 'light' }));
  const { T } = mk({ file, override: 'dark', W: fakeWindows('light') });
  const v = T.get();
  check('override: --theme=dark wins over the saved light', v.mode === 'dark' && v.theme === 'dark', v);
  check('override: the view says it is pinned and never saved', /--theme=dark/.test(v.pinned) && /never saved/.test(v.pinned), v);
  const r = T.set('light');
  check('override: theme.set still switches live', r.ok && T.theme() === 'light');
  check('override: but never writes the file', JSON.parse(fs.readFileSync(file, 'utf8')).mode === 'light' && fs.readdirSync(path.dirname(file)).join() === 'theme.json');
  const sys = mk({ file: fileFor(), override: 'system', W: fakeWindows('dark') });
  check('override: --theme=system follows Windows', sys.T.theme() === 'dark' && sys.T.get().mode === 'system');
  check('override: nothing written for a fresh profile either', (sys.T.set('dark'), !fs.existsSync(path.join(dir, `p${n}`, 'theme.json'))));
  const junk = mk({ override: 'neon' });
  check('override: an invalid one is ignored (lib/args.js refuses it first)', junk.T.get().pinned === null && junk.T.get().mode === 'system');
}

// ---- a saved file that cannot be used: moved aside, said, back to Match Windows
for (const [what, content, re] of [
  ['not JSON', '{mode: dark', /is not valid JSON/],
  ['not an object', '["dark"]', /does not hold a setting/],
  ['an unknown mode', '{"mode":"neon"}', /says "neon", which is not a mode/],
]) {
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const { T, logs } = mk({ file });
  const v = T.get();
  check(`bad file (${what}): Match Windows, with the reason on the view`, v.mode === 'system' && re.test(v.note) && /kept as theme\.json\.unreadable/.test(v.note), v);
  check(`bad file (${what}): moved aside, not deleted`, !fs.existsSync(file) && fs.readFileSync(file + '.unreadable', 'utf8') === content);
  check(`bad file (${what}): logged with the file name, never the path`, logs.length === 1 && !logs[0].includes(dir), logs);
  T.set('dark');
  check(`bad file (${what}): a good save clears the note`, T.get().note === null && JSON.parse(fs.readFileSync(file, 'utf8')).mode === 'dark');
}
{
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  check('a file with no mode = the default, no note', (() => { const v = mk({ file }).T.get(); return v.mode === 'system' && v.note === null; })());
}

// ---- a save that fails: applied now, said, not lost silently
{
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where the folder should be');
  const { T, logs } = mk({ file: path.join(blocker, 'theme.json') });
  const r = T.set('light');
  check('save fails: the pick still applies now', r.ok === true && T.theme() === 'light', r);
  check('save fails: the note says so in words', /Light is on now, but it could not be saved \(E[A-Z]+\), so Mantle goes back to the last saved appearance at its next start/.test(r.note), r.note);
  check('save fails: logged', logs.some((l) => /could not be saved/.test(l)));
}

// ---- a listener that throws does not stop the others
{
  const logs = [];
  const T = createTheme({ file: fileFor(), windowsMode: () => ({ mode: 'light', why: null }), log: (l) => logs.push(l) });
  let second = 0;
  T.on(() => { throw new Error('made-up listener bug'); });
  const off = T.on(() => { second++; });
  T.set('dark');
  check('listeners: a throwing one is logged, the next still runs', second === 1 && logs.some((l) => /a listener threw: made-up listener bug/.test(l)), logs);
  off();
  T.set('light');
  check('listeners: off() unsubscribes', second === 1);
}

// ---- nativeTheme -> Windows' app mode
check('nativeTheme: dark colours = dark', windowsModeFrom({ themeSource: 'system', shouldUseDarkColors: true }).mode === 'dark');
check('nativeTheme: light colours = light', windowsModeFrom({ themeSource: 'system', shouldUseDarkColors: false }).mode === 'light');
check('nativeTheme: a forced themeSource is said, not trusted', (() => { const r = windowsModeFrom({ themeSource: 'light', shouldUseDarkColors: false }); return r.mode === null && /set to light/.test(r.why); })());
check('nativeTheme: missing = unknown with a reason', windowsModeFrom(null).mode === null && /not available/.test(windowsModeFrom(null).why));

// ---- Mantle never sets nativeTheme.themeSource (it would hide Windows' mode and flip every page)
{
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'main.js')].concat(
    fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(__dirname, f)),
    fs.readdirSync(path.join(__dirname, 'features')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(__dirname, 'features', f)));
  const setters = files.filter((f) => /themeSource\s*=[^=]/.test(fs.readFileSync(f, 'utf8')));
  check('no Mantle file assigns nativeTheme.themeSource', setters.length === 0, setters.map((f) => path.basename(f)).join(' '));
}

// ---- every pick is logged, even one that keeps the same look (Dark -> Match Windows on a dark Windows)
{
  const { T, logs } = mk({ W: fakeWindows('dark') });
  T.set('dark');
  const before = logs.length;
  T.set('system');
  check('a mode change that keeps the look is still logged', logs.length === before + 1 && /Match Windows -> Mantle is dark/.test(logs[logs.length - 1]), logs);
  T.set('system');
  check('the same pick again adds no line', logs.length === before + 1, logs);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
for (const f of failures) console.log('FAIL ' + f);
console.log(`THEME TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
