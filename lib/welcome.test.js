'use strict';
/*
 * lib/welcome.test.js - the first-start decision, its flag, the window host, and the TRUTH of every
 * key and fact on the cards (lane mantle-firstrun, 2026-10-15). Pure node: no Electron, no window.
 *
 *   node lib/welcome.test.js   -> "WELCOME TEST: n passed, m failed" (exit 1 on any failure)
 *
 * On the user's laptop it also judges his LIVE profile (%APPDATA%\mantle) through a file system that
 * throws on any write, and prints the verdict: the welcome must never be due there. On a runner with
 * no such folder that check is skipped, and says so.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('./welcome');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
  return ok;
}
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-welcome-test-'));
let n = 0;
function profile(files) {
  const dir = path.join(TMP, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files || []) {
    if (f.endsWith('/')) fs.mkdirSync(path.join(dir, f), { recursive: true });
    else fs.writeFileSync(path.join(dir, f), f === W.FLAG_FILE ? '{}' : 'x');
  }
  return dir;
}
/** fs for judge(): reads pass through, ANY write throws (and is counted). */
function readOnlyFs() {
  const writes = [];
  const deny = (name) => (...a) => { writes.push(`${name}(${String(a[0]).slice(-60)})`); throw new Error(`read-only fs: ${name} refused`); };
  return {
    writes,
    fs: { readFileSync: fs.readFileSync, statSync: fs.statSync, existsSync: fs.existsSync,
      writeFileSync: deny('writeFileSync'), renameSync: deny('renameSync'), mkdirSync: deny('mkdirSync'), unlinkSync: deny('unlinkSync'),
      appendFileSync: deny('appendFileSync'), openSync: deny('openSync'), rmSync: deny('rmSync') },
  };
}
const flagOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, W.FLAG_FILE), 'utf8')); } catch (_) { return null; } };

/* ---------------------------------------------------------------- the decision */
{
  const dir = profile([]);
  const ro = readOnlyFs();
  const v = W.judge({ dir, test: false, fs: ro.fs });
  check('fresh profile: the welcome is due', v.show === true, v);
  check('fresh profile: it will record "pending"', v.write && v.write.state === 'pending', v.write);
  check('fresh profile: judge wrote nothing', ro.writes.length === 0 && fs.readdirSync(dir).length === 0, ro.writes);
}
for (const name of W.EVIDENCE) {
  const dir = profile([name === 'features' || name === 'wallpapers' || name === 'Local Storage' ? name + '/' : name]);
  const v = W.judge({ dir, test: false });
  check(`evidence "${name}" alone marks the profile as used`, v.show === false && v.write && v.write.how === 'existing-profile' && v.evidence.includes(name), v);
}
{
  const dir = profile(['mantle.log', 'Local State', 'Preferences', 'lockfile', 'GPUCache/']);
  const v = W.judge({ dir, test: false });
  check('mantle.log and Chromium files are NOT evidence (main writes the log before judging)', v.show === true, v);
}
{
  const dir = profile(['shell-state.json', 'theme.json', 'features/']);
  const v = W.judge({ dir, test: false });
  check('a used profile: reason names what was found', /shell-state\.json, theme\.json, features/.test(v.reason), v.reason);
  check('a used profile: the flag to record carries its evidence', Array.isArray(v.write.evidence) && v.write.evidence.length === 3, v.write);
}
{
  const dir = profile([]);
  fs.writeFileSync(path.join(dir, W.FLAG_FILE), JSON.stringify({ state: 'done', how: 'skipped', at: 'x' }));
  const v = W.judge({ dir, test: false });
  check('flag done/skipped: not shown, nothing to write', v.show === false && v.write === null && /skipped/.test(v.reason), v);
  fs.writeFileSync(path.join(dir, W.FLAG_FILE), JSON.stringify({ state: 'done', how: 'finished' }));
  check('flag done/finished: not shown', W.judge({ dir, test: false }).show === false);
  fs.writeFileSync(path.join(dir, W.FLAG_FILE), JSON.stringify({ state: 'pending' }));
  const p = W.judge({ dir, test: false });
  check('flag pending: shown again (a quit halfway brings it back)', p.show === true && p.write === null, p);
  fs.writeFileSync(path.join(dir, W.FLAG_FILE), '{not json');
  const c = W.judge({ dir, test: false });
  check('corrupt flag, no evidence: shown, and the reason says the flag was bad', c.show === true && /not valid JSON/.test(c.reason), c);
  fs.writeFileSync(path.join(dir, 'theme.json'), '{}');
  const ce = W.judge({ dir, test: false });
  check('corrupt flag WITH evidence: not shown (used profile wins)', ce.show === false && ce.write.how === 'existing-profile', ce);
  fs.writeFileSync(path.join(dir, W.FLAG_FILE), JSON.stringify({ state: 'done', how: 'whatever' }));
  check('an unknown "how" is judged by evidence', W.judge({ dir, test: false }).write.how === 'existing-profile');
}
{
  const dir = profile([]);
  const v = W.judge({ dir, test: true, optIn: false });
  check('--test without --first-run: never shown, never written', v.show === false && v.write === null && /without --first-run/.test(v.reason), v);
  const o = W.judge({ dir, test: true, optIn: true });
  check('--test --first-run on an empty profile: judged like live (due)', o.show === true && o.write.state === 'pending', o);
  const used = profile(['shell-state.json']);
  check('--test --first-run on a used profile: not shown', W.judge({ dir: used, test: true, optIn: true }).show === false);
  check('no profile folder: not shown, with a reason', W.judge({ dir: '', test: false }).show === false);
}
{
  const dir = profile([]);
  const r = W.writeFlag(dir, { state: 'pending' });
  check('writeFlag writes the flag', r.ok && flagOf(dir).state === 'pending', r);
  check('writeFlag leaves no temp file', fs.readdirSync(dir).length === 1, fs.readdirSync(dir));
  const bad = W.writeFlag(path.join(dir, W.FLAG_FILE, 'nested'), { state: 'pending' });
  check('writeFlag failure is a plain reason, not a throw', bad.ok === false && /could not be saved/.test(bad.reason), bad);
}

/* ---------------------------------------------------------------- The user's live profile, READ ONLY */
{
  const live = path.join(process.env.APPDATA || '', 'mantle');
  if (process.env.APPDATA && fs.existsSync(live) && fs.existsSync(path.join(live, 'mantle.log'))) {
    const ro = readOnlyFs();
    const before = fs.readdirSync(live).sort().join('|');
    const v = W.judge({ dir: live, test: false, fs: ro.fs });
    const after = fs.readdirSync(live).sort().join('|');
    console.log(`welcome: LIVE PROFILE ${live} (read only): show=${v.show}; ${v.reason}`);
    check('The user\'s live profile: the welcome is NOT due', v.show === false, v);
    check('The user\'s live profile: judging it wrote nothing', ro.writes.length === 0 && before === after, ro.writes);
  } else {
    console.log('welcome: no live Mantle profile on this machine (%APPDATA%\\mantle with a mantle.log): live-profile check skipped');
  }
}

/* ---------------------------------------------------------------- the host, with a fake window */
class FakeWin {
  constructor(o) { this.o = o; this.ev = {}; this.shown = false; this.closedFlag = false; this.focused = false;
    const wev = {}; this.wcEv = wev;
    this.webContents = { on: (e, f) => { (wev[e] = wev[e] || []).push(f); }, setWindowOpenHandler: (f) => { this.openHandler = f; } };
    FakeWin.all.push(this); }
  on(e, f) { (this.ev[e] = this.ev[e] || []).push(f); }
  once(e, f) { this.on(e, f); }
  emit(e, ...a) { (this.ev[e] || []).forEach((f) => f(...a)); }
  loadFile(p) { this.page = p; }
  show() { this.shown = true; } focus() { this.focused = true; } isFocused() { return this.focused; }
  isMinimized() { return false; } restore() {}
  isDestroyed() { return this.closedFlag; }
  close() { if (this.closedFlag) return; this.closedFlag = true; this.emit('closed'); }
  destroy() { this.close(); }
}
FakeWin.all = [];
function mkHost(verdict, extra) {
  const lines = [];
  const timers = [];
  const dir = (extra && extra.dir) || profile([]);
  const h = W.host(Object.assign({ verdict, dir, test: false, preload: 'P', page: 'ui/welcome/index.html', BrowserWindow: FakeWin,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 28, width: 1920, height: 1052 } }) },
    log: (l) => lines.push(l), setTimeout: (f, ms) => { timers.push({ f, ms }); return { unref() {} }; } }, extra || {}));
  const run = () => { while (timers.length) timers.shift().f(); };
  return { h, lines, dir, run, timers };
}
(async () => {
  {
    const t = mkHost({ show: false, reason: 'this profile has been used (theme.json)', write: { state: 'done', how: 'existing-profile' } });
    const before = FakeWin.all.length;
    t.h.record();
    t.h.start(); t.run();
    check('not due: no window is ever made', FakeWin.all.length === before);
    check('not due: one line says why', t.lines.some((l) => /^not shown: this profile has been used/.test(l)), t.lines);
    check('not due: record() wrote existing-profile', flagOf(t.dir).how === 'existing-profile', flagOf(t.dir));
  }
  {
    const t = mkHost({ show: true, reason: 'a brand-new profile', write: { state: 'pending' } });
    t.h.record();
    check('due: record() wrote pending', flagOf(t.dir).state === 'pending');
    t.h.start();
    check('due: the window waits for the shell to settle', t.timers.length === 1 && t.timers[0].ms === W.SHOW_DELAY_MS, t.timers.map((x) => x.ms));
    t.run();
    const w = FakeWin.all[FakeWin.all.length - 1];
    check('due: one window, clear and frameless, with the preload and the welcome page',
      w && w.o.transparent === true && w.o.frame === false && w.o.webPreferences.preload === 'P' && w.o.webPreferences.sandbox === true && w.page === 'ui/welcome/index.html', w && w.o);
    check('due: centred in the work area', w.o.x === Math.round((1920 - W.WIN_W) / 2) && w.o.y === 28 + Math.round((1052 - W.WIN_H) / 2), [w.o.x, w.o.y]);
    check('due: it never navigates or opens windows', w.openHandler && w.openHandler().action === 'deny');
    w.emit('ready-to-show');
    check('due: shown and focused when ready', w.shown && w.focused);
    const st = await t.h.commands['welcome.state']();
    check('welcome.state answers', st.ok && st.via === 'first start', st);
    const bad = await t.h.commands['welcome.done']({ how: 'maybe' });
    check('welcome.done refuses an unknown how', bad.ok === false && !w.closedFlag, bad);
    const r = await t.h.commands['welcome.done']({ how: 'finished' });
    t.run();
    check('finish: recorded done/finished', r.ok && r.recorded && flagOf(t.dir).state === 'done' && flagOf(t.dir).how === 'finished', flagOf(t.dir));
    check('finish: the window closes', w.closedFlag);
    check('finish: closing after an answer does not re-record', flagOf(t.dir).how === 'finished' && !flagOf(t.dir).note);
    const again = await t.h.commands['welcome.show']({ via: 'Settings' });
    t.run();
    const w2 = FakeWin.all[FakeWin.all.length - 1];
    check('show again: a new window opens', again.ok && again.opened && w2 !== w, again);
    const twice = await t.h.commands['welcome.show']({ via: 'Settings' });
    check('show again while open: the same window, said so', twice.ok && twice.already && FakeWin.all[FakeWin.all.length - 1] === w2, twice);
    const s = await t.h.commands['welcome.done']({ how: 'skipped' });
    t.run();
    check('skip from show-again: recorded skipped, window closed', s.ok && flagOf(t.dir).how === 'skipped' && w2.closedFlag, flagOf(t.dir));
  }
  {
    const t = mkHost({ show: true, reason: 'new', write: { state: 'pending' } });
    t.h.record(); t.h.start(); t.run();
    const w = FakeWin.all[FakeWin.all.length - 1];
    w.close();
    check('closed by hand without an answer: recorded as skipped', flagOf(t.dir).how === 'skipped' && /closed/.test(flagOf(t.dir).note), flagOf(t.dir));
  }
  {
    let quitting = false;
    const t = mkHost({ show: true, reason: 'new', write: { state: 'pending' } }, { quitting: () => quitting });
    t.h.record(); t.h.start(); t.run();
    const w = FakeWin.all[FakeWin.all.length - 1];
    quitting = true; w.close();
    check('closed because Mantle quits: still pending (it comes back next start)', flagOf(t.dir).state === 'pending', flagOf(t.dir));
  }
  {
    const t = mkHost({ show: true, reason: 'new', write: { state: 'pending' } });
    t.h.record(); t.h.start(); t.run();
    const w = FakeWin.all[FakeWin.all.length - 1];
    fs.rmSync(t.dir, { recursive: true, force: true });
    fs.writeFileSync(t.dir, 'a FILE where the profile folder should be');   // every write now fails
    const r = await t.h.commands['welcome.done']({ how: 'finished' });
    t.run();
    check('a failed record keeps the window and says why', r.ok === false && /could not be saved/.test(r.reason) && !w.closedFlag, r);
    fs.unlinkSync(t.dir);
  }
  {
    const t = mkHost({ show: false, optIn: false, reason: 'test', write: null }, { test: true });
    const o = await t.h.commands['welcome.show']({ via: 'Settings' });
    t.run();
    const r = await t.h.commands['welcome.done']({ how: 'finished' });
    check('--test without --first-run: show-again works, nothing is recorded', o.ok && r.ok && r.recorded === false && flagOf(t.dir) === null, r);
  }

  /* ---------------------------------------------------------------- truth: every card fact vs the code */
  const C = require('../ui/welcome/content.js');
  const all = JSON.stringify(C);
  const main = read('main.js');
  const keys = C.cards[1].keys;
  const keyOf = (k) => keys.find((x) => x.keys.join('+') === k);
  check('truth: Win opens the launcher (main.js winTap)', keyOf('Win') && /launcher/i.test(keyOf('Win').what) && /a tap of the Win key opens the Mantle launcher/.test(main));
  check('truth: Alt+Space opens the launcher too (registerShortcuts)', /Alt\+Space works too/.test(keyOf('Win').note) && /globalShortcut\.register\('Alt\+Space', \(\) => \{\s*toggleLauncher/.test(main));
  check('truth: Alt+Tab is Mantle\'s switcher, on by default (lib/switcher.js)', keyOf('Alt+Tab') && /settings: \{ altTab: true/.test(read('lib/switcher.js')));
  const shot = read('lib/features/screenshot.js');
  check('truth: Win+Shift+S is the screenshot chord, copied only by default', keyOf('Win+Shift+S') && /chords: \['Win\+Shift\+S'/.test(shot) && /key: 'autoSave'[^\n]*default: false/.test(shot) && /Copied to the clipboard; Save keeps a file/.test(keyOf('Win+Shift+S').note));
  check('truth: Win+Tab is Task view (lib/features/taskview.js)', keyOf('Win+Tab') && keyOf('Win+Tab').what === 'Task view' && /chords: \['Win\+Tab'\]/.test(read('lib/features/taskview.js')));
  check('truth: Win+I is Mantle Settings (lib/features/settings.js CHORD)', keyOf('Win+I') && keyOf('Win+I').what === 'Mantle Settings' && /const CHORD = 'Win\+I'/.test(read('lib/features/settings.js')));
  for (const f of ['screenshot', 'taskview', 'settings', 'corners']) {
    check(`truth: the ${f} feature is on by default`, /defaultOn: true/.test(read(`lib/features/${f}.js`)));
  }
  const K = require('./features/_corners');
  const cc = C.cards[1].corners;
  check('truth: the default corners match _corners.js DEFAULTS', JSON.stringify(cc.actions) === JSON.stringify(K.DEFAULTS), [cc.actions, K.DEFAULTS]);
  check('truth: the action words match _corners.js ACTION_NAMES', JSON.stringify(cc.labels) === JSON.stringify(K.ACTION_NAMES));
  check('truth: the corner names match CORNER_NAMES', Object.keys(K.CORNER_NAMES).every((c) => cc.names[c].toLowerCase() === K.CORNER_NAMES[c]));
  check('truth: "rest for a moment" is a short dwell (<= 500 ms)', K.CORNER_DWELL_MS > 0 && K.CORNER_DWELL_MS <= 500, K.CORNER_DWELL_MS);
  check('truth: the Keyboard shortcuts page exists in Settings', /head\('Keyboard shortcuts'/.test(read('ui/settings/settings.js')) && /Keyboard shortcuts/.test(C.cards[1].foot));
  check('truth: hot corners are switched under Settings > Mantle', /f\.name === 'corners' \? cornersRow\(f\)/.test(read('ui/settings/settings.js')) && /V\.mantle = function/.test(read('ui/settings/settings.js')));
  check('truth: the bar is a hover bar by default (no --dock in the logon task)', /const BAR_MODE = flags\.dock \? 'dock' : 'hover'/.test(main) && !/--dock/.test(read('tools/mantle-logon-task.xml')));
  check('truth: pins come from the Windows taskbar (lib/pinned.js)', /the apps the user pinned to the Windows taskbar/.test(read('lib/pinned.js')));
  const tb = read('lib/features/topbar.js');
  check('truth: the top bar has the Mantle menu, app menus and CPU/RAM/GPU, on by default', /the Mantle menu and\s*\n?\s*\*?\s*the focused app's name and ITS menus/.test(tb) && /ram cpu gpu/.test(tb) && /defaultOn: true/.test(tb));
  const groups = read('ui/launcher/groups.js');
  check('truth: the launcher finds apps, settings and files', ['Apps', 'Settings', 'Files'].every((g) => groups.includes(`label: '${g}'`)));
  const bar = read('ui/bar/bar.js');
  const barHtml = read('ui/bar/index.html');
  check('truth: the bar\'s ••• button is "More"', /id="more"[^>]*aria-label="More"/.test(barHtml) && /<circle cx="3\.5"[^>]*\/><circle cx="8"[^>]*\/><circle cx="12\.5"/.test(barHtml));
  check('truth: its menu has "Restore Windows taskbar" (shell.restore)', /<span>Restore Windows taskbar<\/span>/.test(bar) && /callR\('shell\.restore'\)/.test(bar) && all.includes('Restore Windows taskbar'));
  check('truth: its menu has "Quit Mantle" behind a second click', /quit\.textContent = 'Quit Mantle'/.test(bar) && /Click again to quit/.test(bar) && /second click/.test(C.cards[2].ways[1].text));
  check('truth: after a restore the tray offers "Restart Mantle to resume"', /'Restart Mantle to resume'/.test(main) && all.includes('Restart Mantle to resume'));
  check('truth: the welcome\'s restore button runs the same shell.restore', /call\('shell\.restore'\)/.test(read('ui/welcome/welcome.js')) && /'shell\.restore': async/.test(main));
  check('truth: restore lets the Windows taskbar draw again (it was hidden)', /releaseTaskbarHide\(why\)/.test(main) && /only hidden/.test(C.cards[2].lead));
  check('truth: Ctrl+Alt+Shift+Backspace puts Windows back and quits', /globalShortcut\.register\('Ctrl\+Alt\+Shift\+Backspace', \(\) => \{\s*(?:supervisor\.standDown\('the kill switch'\);[^\n]*\s*)?restoreShell\('the kill switch'\)\.finally\(\(\) => shutdown/.test(main) && C.cards[2].ways[1].keys.join('+') === 'Ctrl+Alt+Shift+Backspace');
  const auto = read('tools/install-autostart.ps1');
  check('truth: the sign-in task is named Mantle (install-autostart.ps1)', /\[string\]\$TaskName = 'Mantle'/.test(auto) && /a task named Mantle in Task Scheduler/.test(C.cards[2].ways[2].text));
  check('truth: npm run autostart:remove removes it', /"autostart:remove": "[^"]*install-autostart\.ps1 -Uninstall"/.test(read('package.json')) && C.cards[2].ways[2].code === 'npm run autostart:remove');
  check('truth: Settings has the "Welcome tour" Show again row', /id: 'about\.welcome'[^\n]*Welcome tour/.test(read('ui/settings/settings.js')) && /welcome: \(t\) => act\(rowOf\(t\), call\('welcome\.show'/.test(read('ui/settings/settings.js')));
  check('truth: main wires welcome.* into COMMANDS and judges before the sidecar starts',
    /Object\.assign\(COMMANDS, welcome\.commands\)/.test(main) && main.indexOf('const welcomeVerdict = require(\'./lib/welcome\').judge(') > 0
    && main.indexOf('const welcomeVerdict') < main.indexOf('sidecar.start();') && main.indexOf('const welcomeVerdict') < main.indexOf('requestSingleInstanceLock'));

  /* the page uses only --lg-* colours */
  const css = read('ui/welcome/welcome.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const literal = css.split('\n').filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(l));
  check('theme: welcome.css has no literal colours (only --lg-* tokens)', literal.length === 0, literal);
  const darkOnly = ['--lg-card', '--lg-field', '--lg-focus', '--lg-divider', '--lg-edge-inner'];
  const leaks = css.split('\n').filter((l) => darkOnly.some((t) => l.includes(`var(${t})`)) && !/:root\[data-theme="dark"\]/.test(l));
  check('theme: dark-only tokens are used only under :root[data-theme="dark"]', leaks.length === 0, leaks);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* leave it */ }
  console.log(`WELCOME TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('WELCOME TEST: crashed: ' + (e && e.stack || e)); console.log(`WELCOME TEST: ${passed} passed, ${failures.length + 1} failed`); process.exit(1); });
