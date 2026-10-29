/* packaged.test.js - what a copy installed by Mantle-Setup.exe does when it starts (lib/packaged.js).
 * Plain node, nothing started; the disk is a temp folder or a stand-in fs.
 *   node lib/packaged.test.js   -> "PACKAGED TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./packaged');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const LOG = 'C:\\Users\\u\\AppData\\Roaming\\mantle\\mantle.log';
const YES = { ok: true, accepted: true, at: '2026-10-29T12:00:00.000Z' };
const NO = { ok: true, accepted: false, at: null };

// ---- plan: the decision for each way Mantle.exe can be started
let p = P.plan([], NO, LOG);
check('plain start, no consent -> ask', p.action === 'ask', p);
p = P.plan([], YES, LOG);
check('plain start, consent -> run live with the log', p.action === 'run' && same(p.argv, ['--live', `--log=${LOG}`]), p);
check('plain start, consent -> the why names when it was accepted', /2026-10-29/.test(p.why), p);
p = P.plan(['--no-desktop'], YES, LOG);
check('other flags are kept on a consented plain start', p.action === 'run' && same(p.argv, ['--no-desktop', '--live', `--log=${LOG}`]), p);
p = P.plan(['--live'], NO, LOG);
check('--live by name runs even with no consent (as a clone does), log added', p.action === 'run' && same(p.argv, ['--live', `--log=${LOG}`]), p);
p = P.plan(['--live', '--log=C:\\x.log'], NO, LOG);
check('--live with its own --log keeps it (the logon task passes one)', p.action === 'run' && same(p.argv, ['--live', '--log=C:\\x.log']), p);
p = P.plan(['--test', '--profile-name=ci'], NO, LOG);
check('--test passes through untouched, no --live, no log', p.action === 'run' && same(p.argv, ['--test', '--profile-name=ci']), p);
p = P.plan(['--quit'], NO, LOG);
check('--quit passes through untouched (the uninstaller uses it)', p.action === 'run' && same(p.argv, ['--quit']), p);
p = P.plan(['--quit'], YES, LOG);
check('--quit with consent is still only --quit (never --live)', p.action === 'run' && same(p.argv, ['--quit']), p);
p = P.plan(['C:\\app', '--open=player', '--play=C:\\a.mp3'], YES, LOG);
check('--open=<x> passes through untouched (file associations)', p.action === 'run' && same(p.argv, ['C:\\app', '--open=player', '--play=C:\\a.mp3']), p);
p = P.plan([], { ok: false, accepted: false, reason: 'X could not be read' }, LOG);
check('an unreadable consent -> ask, and the why says so', p.action === 'ask' && /could not be read/.test(p.why), p);
p = P.plan(null, NO, LOG);
check('no argv at all -> ask', p.action === 'ask', p);
p = P.plan([], YES, '');
check('no log path -> no --log added', p.action === 'run' && same(p.argv, ['--live']), p);
check('decided: --open alone and --open=x', P.decided(['--open']) && P.decided(['--open=wallpapers']) && !P.decided(['--opener']) && !P.decided(['--no-desktop']));

// ---- readConsent / writeConsent on a real temp folder
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-packaged-test-'));
let c = P.readConsent(dir);
check('no file -> ok, not accepted', c.ok && !c.accepted, c);
let w = P.writeConsent(dir, { at: '2026-10-29T12:00:00.000Z', version: '0.1.1', autostart: false });
check('write -> ok, in the profile', w.ok && w.file === path.join(dir, P.CONSENT_FILE), w);
check('write leaves no temp file behind', !fs.existsSync(path.join(dir, P.CONSENT_FILE + '.tmp')));
c = P.readConsent(dir);
check('read back -> accepted, with the time', c.ok && c.accepted && c.at === '2026-10-29T12:00:00.000Z', c);
const saved = JSON.parse(fs.readFileSync(path.join(dir, P.CONSENT_FILE), 'utf8'));
check('the file records the version and the autostart answer', saved.accepted === true && saved.version === '0.1.1' && saved.autostart === false, saved);
fs.writeFileSync(path.join(dir, P.CONSENT_FILE), '\uFEFF{"accepted": true}');
check('a BOM is read', P.readConsent(dir).accepted === true);
fs.writeFileSync(path.join(dir, P.CONSENT_FILE), '{"accepted": "yes"}');
check('accepted must be exactly true', P.readConsent(dir).accepted === false);
fs.writeFileSync(path.join(dir, P.CONSENT_FILE), '{nope');
c = P.readConsent(dir);
check('broken JSON -> not ok, reason names the file', !c.ok && !c.accepted && c.reason.includes(P.CONSENT_FILE), c);
const sub = path.join(dir, 'new', 'profile');
w = P.writeConsent(sub, {});
check('write creates a missing profile folder', w.ok && P.readConsent(sub).accepted === true, w);
fs.rmSync(dir, { recursive: true, force: true });

const denied = { readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
c = P.readConsent('C:\\p', denied);
check('a file that cannot be read -> not ok, with the code', !c.ok && /EACCES/.test(c.reason), c);
const full = { mkdirSync() {}, writeFileSync: () => { const e = new Error('full'); e.code = 'ENOSPC'; throw e; }, renameSync() {} };
w = P.writeConsent('C:\\p', {}, full);
check('a write that fails -> not ok, says it did not start', !w.ok && /ENOSPC/.test(w.reason) && /did not start/.test(w.reason), w);

// ---- the warning's words: every promise in it is one the installed copy keeps
const d = P.dialogOptions();
check('warning: two buttons, Start Mantle first, Esc = Not now', same(d.buttons, ['Start Mantle', 'Not now']) && d.cancelId === 1 && d.defaultId === 0);
check('warning: start-at-sign-in is opt-in (unticked)', d.checkboxChecked === false && /sign in/.test(d.checkboxLabel));
check('warning: says at your own risk', /at your own risk/i.test(d.detail));
check('warning: says nothing has changed yet', /Nothing has changed yet/.test(d.detail));
check('warning: names the Start menu restore entry', d.detail.includes(P.START_MENU_RESTORE));
check('warning: names the kill switch', d.detail.includes('Ctrl+Alt+Shift+Backspace'));
check('warning: names the Task Manager fallback', /Ctrl\+Shift\+Esc/.test(d.detail) && /Windows Explorer/.test(d.detail));
const nsh = fs.readFileSync(path.join(__dirname, '..', 'installer', 'installer.nsh'), 'utf8');
check('truth: the installer creates exactly that Start menu entry (Mantle folder, "Restore Windows taskbar")',
  /\$SMPROGRAMS\\Mantle\\Restore Windows taskbar\.lnk/.test(nsh), P.START_MENU_RESTORE);
const yml = fs.readFileSync(path.join(__dirname, '..', 'installer', 'electron-builder.yml'), 'utf8');
check('truth: the installed copy\'s Start menu folder is "Mantle"', /menuCategory:\s*Mantle\b/.test(yml));
check('truth: the installed copy starts at lib/packaged-entry.js', /main:\s*lib\/packaged-entry\.js/.test(yml));
const welcome = fs.readFileSync(path.join(__dirname, '..', 'ui', 'welcome', 'content.js'), 'utf8');
check('truth: the kill switch is the one the welcome tour names', /'Ctrl', 'Alt', 'Shift', 'Backspace'/.test(welcome));
check('truth: uninstall puts Windows back before removing anything (un.onInit\'s app check and customUnInstall both run mantleBack)',
  /!macro customCheckAppRunning[\s\S]*?Call un\.mantleBack[\s\S]*?!macroend/.test(nsh) && /!macro customUnInstall[\s\S]*?Call un\.mantleBack[\s\S]*?!macroend/.test(nsh));
check('truth: the electron-builder "app is running" taskkill is replaced, never used', /!macro customCheckAppRunning/.test(nsh) && !/taskkill/i.test(nsh.replace(/^;.*$/gm, '')));
check('truth: a failed check changes nothing and exits 3 when silent', /\/SD IDCANCEL IDRETRY mantle_back_again\s+SetErrorLevel 3\s+Quit/.test(nsh));
check('truth: the restore shortcut opens tools\\restore-windows.cmd, which bypasses the execution policy',
  /Restore Windows taskbar\.lnk" "\$INSTDIR\\resources\\app\\tools\\restore-windows\.cmd"/.test(nsh)
  && /-ExecutionPolicy Bypass -File "%~dp0restore-windows\.ps1"/.test(fs.readFileSync(path.join(__dirname, '..', 'tools', 'restore-windows.cmd'), 'utf8')));

// ---- the commands
const a = P.autostartCommand('C:\\M\\resources\\app', 'C:\\M\\Mantle.exe');
check('autostart: install-autostart.ps1 -Exe <this exe>, policy bypassed, no -Run', a.file === 'powershell.exe'
  && same(a.args.slice(-4), ['-File', 'C:\\M\\resources\\app\\tools\\install-autostart.ps1', '-Exe', 'C:\\M\\Mantle.exe'])
  && a.args.includes('Bypass') && !a.args.includes('-Run'), a);
check('liveArgs: --live and the log', same(P.liveArgs(LOG), ['--live', `--log=${LOG}`]));

for (const f of failures) console.log('FAIL ' + f);
console.log(`PACKAGED TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
