'use strict';
/* restore-banners.test.js - tools/restore-banners.ps1 on REAL registry keys, test app ids only
 * (lane mantle-toasts2, 2026-10-15). Every key it makes is
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Mantle.ToastTest.rb<random>-<x>
 * with a record file in a temp folder (-RecordFile), so neither Owen's apps nor his real
 * %APPDATA%\mantle\notif-banners.json are ever read or written. Every key is deleted in the finally.
 *   a: Mantle's 0, original 1        -> back to 1
 *   b: Mantle's 0, original null     -> the value is deleted (Windows' default)
 *   c: 1 (Owen turned it back on)    -> left at 1
 *   d: in the record, no key at all  -> left (and no key is made)
 *   e: 0 but NOT in the record       -> left at 0 (not Mantle's)
 * Then: a second run changes nothing and exits 0; no record = exit 0 and "nothing to put back";
 * an unreadable record = exit 1 and nothing touched. Plus: restore-windows.ps1 and
 * install-autostart.ps1 parse and call this script (they are never RUN here: restore-windows stops
 * Mantle processes and touches the shell).
 *   node tools/restore-banners.test.js   -> "RESTORE BANNERS TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'restore-banners.ps1');
const BASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const TAG = 'Mantle.ToastTest.rb' + Math.random().toString(36).slice(2, 8);
const id = (x) => `${TAG}-${x}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-restore-banners-'));
const RECORD = path.join(DIR, 'notif-banners.json');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); }

const reg = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
function setVal(app, v) { reg(['add', `${BASE}\\${app}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', String(v), '/f']); }
function makeKey(app) { reg(['add', `${BASE}\\${app}`, '/f']); }
/** -> number | null (no value) | 'nokey' */
function read(app) {
  if (reg(['query', `${BASE}\\${app}`]).status !== 0) return 'nokey';
  const r = reg(['query', `${BASE}\\${app}`, '/v', 'ShowBanner']);
  if (r.status !== 0) return null;
  const m = /ShowBanner\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
  return m ? parseInt(m[1], 16) : 'odd';
}
function run(record) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-RecordFile', record], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function parses(file) {
  const ps = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim() === '0';
}

try {
  if (process.platform !== 'win32') { console.log('RESTORE BANNERS TEST: skipped: Windows only'); process.exit(0); }
  makeKey(id('a')); setVal(id('a'), 0);
  makeKey(id('b')); setVal(id('b'), 0);
  makeKey(id('c')); setVal(id('c'), 1);
  makeKey(id('e')); setVal(id('e'), 0);
  check('setup: the test keys exist with their values', read(id('a')) === 0 && read(id('b')) === 0 && read(id('c')) === 1 && read(id('d')) === 'nokey' && read(id('e')) === 0);
  const owned = {}; owned[id('a')] = 1; owned[id('b')] = null; owned[id('c')] = null; owned[id('d')] = 1;
  fs.writeFileSync(RECORD, JSON.stringify({ v: 1, owned, released: [] }));
  const recBefore = fs.readFileSync(RECORD, 'utf8');

  const r1 = run(RECORD);
  check('run 1: exit 0 and "verified"', r1.code === 0 && /verified/.test(r1.out), r1.out);
  check('run 1: a (Mantle\'s 0, original 1) is back to 1', read(id('a')) === 1, read(id('a')));
  check('run 1: b (Mantle\'s 0, original none) has no value again', read(id('b')) === null, read(id('b')));
  check('run 1: c (Owen\'s own 1) is left at 1', read(id('c')) === 1, read(id('c')));
  check('run 1: d (gone from Windows) is left, and no key is made', read(id('d')) === 'nokey', read(id('d')));
  check('run 1: e (0 but not Mantle\'s) is left at 0', read(id('e')) === 0, read(id('e')));
  check('run 1: says 2 put back, 2 left', /2 put back to Windows' own pop-up, 2 left/.test(r1.out), r1.out);
  check('run 1: the record is not rewritten (it is Mantle\'s)', fs.readFileSync(RECORD, 'utf8') === recBefore);

  const r2 = run(RECORD);
  check('run 2 (safe twice): exit 0, nothing put back, nothing changed', r2.code === 0 && /0 put back/.test(r2.out) && read(id('a')) === 1 && read(id('b')) === null && read(id('e')) === 0, r2.out);

  const r3 = run(path.join(DIR, 'missing.json'));
  check('no record: exit 0, "nothing to put back"', r3.code === 0 && /no record/.test(r3.out) && /nothing to put back/.test(r3.out), r3.out);

  setVal(id('a'), 0);
  const bad = path.join(DIR, 'bad.json');
  fs.writeFileSync(bad, '{ "v": 1, "owned": ');
  const r4 = run(bad);
  check('an unreadable record: exit 1 with the reason, nothing touched', r4.code === 1 && /could not be read/.test(r4.out) && read(id('a')) === 0, r4.out);

  const empty = path.join(DIR, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ v: 1, owned: {}, released: [id('a')] }));
  const r5 = run(empty);
  check('a record that owns nothing: exit 0, nothing touched', r5.code === 0 && /owns no app/.test(r5.out) && read(id('a')) === 0, r5.out);

  const rw = fs.readFileSync(path.join(__dirname, 'restore-windows.ps1'), 'utf8');
  const ia = fs.readFileSync(path.join(__dirname, 'install-autostart.ps1'), 'utf8');
  check('restore-windows.ps1 parses and runs restore-banners.ps1 after the cursor clip step',
    parses(path.join(__dirname, 'restore-windows.ps1')) && rw.indexOf('restore-banners.ps1') > rw.indexOf('ReleaseCursorClip()') && rw.indexOf('ReleaseCursorClip()') > 0);
  const un = ia.slice(ia.indexOf('if ($Uninstall)'), ia.indexOf('$root = Split-Path'));
  check('install-autostart.ps1 parses and its -Uninstall branch runs restore-banners.ps1', parses(path.join(__dirname, 'install-autostart.ps1')) && /restore-banners\.ps1/.test(un));
  check('restore-banners.ps1 parses', parses(SCRIPT));
} catch (e) {
  check('the run itself', false, e && e.stack ? e.stack : String(e));
} finally {
  for (const x of ['a', 'b', 'c', 'd', 'e']) reg(['delete', `${BASE}\\${id(x)}`, '/f']);
  const leftover = ['a', 'b', 'c', 'd', 'e'].filter((x) => read(id(x)) !== 'nokey');
  check('cleanup: every test key is gone', leftover.length === 0, leftover);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* busy */ }
}
console.log(`RESTORE BANNERS TEST: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log(`  FAIL ${f}`));
process.exit(failures.length ? 1 : 0);
