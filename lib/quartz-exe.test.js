/* quartz-exe.test.js - which exe starts Quartz, and which exes ARE Quartz (lib/quartz-exe.js).
 * Plain node, nothing started; the disk is a stand-in (`exists`).
 *   node lib/quartz-exe.test.js   -> "QUARTZ EXE TEST: n passed, m failed"
 */
const path = require('path');
const os = require('os');
const Q = require('./quartz-exe');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''));
}

const DIST = path.join(os.homedir(), 'browser', 'node_modules', 'electron', 'dist');
const QX = path.join(DIST, 'Quartz.exe'), EX = path.join(DIST, 'electron.exe');
const MANTLE_EL = path.join(os.homedir(), 'mantle-live', 'node_modules', 'electron', 'dist', 'electron.exe');
const only = (...ps) => (p) => ps.includes(p);

check('candidates: Quartz.exe first, then electron.exe, both under ~/browser', JSON.stringify(Q.candidates()) === JSON.stringify([QX, EX]), Q.candidates());
check('BROWSER_DIR is ~/browser', Q.BROWSER_DIR === path.join(os.homedir(), 'browser'));

check('launch: Quartz.exe present -> Quartz.exe', Q.browserExe({ exists: only(QX, EX) }) === QX);
check('launch: only Quartz.exe present -> Quartz.exe', Q.browserExe({ exists: only(QX) }) === QX);
check('launch: Quartz.exe absent (right after an Electron update) -> electron.exe', Q.browserExe({ exists: only(EX) }) === EX);
check('launch: neither present -> the preferred path (Quartz.exe), so the caller\'s missing check names it',
  Q.browserExe({ exists: () => false }) === QX);
let threw = false; try { Q.browserExe({ exists: (p) => { if (p === QX) throw new Error('EPERM'); return true; } }); } catch (_) { threw = true; }
check('launch: an injected exists() that throws is the caller\'s problem (the default one never throws)', threw === true);
const dir2 = 'D:\\other\\browser';
check('launch: another browser folder resolves inside that folder',
  Q.browserExe({ dir: dir2, exists: (p) => p === path.join(dir2, 'node_modules', 'electron', 'dist', 'electron.exe') }) === path.join(dir2, 'node_modules', 'electron', 'dist', 'electron.exe'));
const real = Q.browserExe();
check('launch: the real disk picks one of the two candidates', real === QX || real === EX, real);

check('match: Quartz.exe is Quartz', Q.isBrowserExe(QX) === true);
check('match: the bare electron.exe under ~/browser is Quartz', Q.isBrowserExe(EX) === true);
check('match: case and slash style do not matter', Q.isBrowserExe(QX.toUpperCase()) && Q.isBrowserExe(EX.replace(/\\/g, '/')));
check('match: Mantle\'s own electron.exe (mantle-live) is NOT Quartz', Q.isBrowserExe(MANTLE_EL) === false);
check('match: some other electron.exe is NOT Quartz', Q.isBrowserExe('C:\\Program Files\\Tool\\electron.exe') === false);
check('match: a Quartz.exe elsewhere is NOT Quartz', Q.isBrowserExe('C:\\Downloads\\Quartz.exe') === false);
check('match: empty / null / undefined are not Quartz', !Q.isBrowserExe('') && !Q.isBrowserExe(null) && !Q.isBrowserExe(undefined));

for (const f of failures) console.log('FAIL ' + f);
console.log(`QUARTZ EXE TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
