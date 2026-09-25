'use strict';
/* topbar.test.js — the top bar's pure logic (ui/topbar/model.js), and once it exists the feature
 * module's shape (lib/features/topbar.js). Plain node, no deps, no Electron, no sidecar.
 *   node lib/features/topbar.test.js      -> "TOPBAR MODEL TEST: n passed, m failed" */
const path = require('path');
const fs = require('fs');
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'model.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

/* app names */
check('FileDescription wins', M.appName({ exe: 'C:\\x\\notepad++.exe', desc: 'Notepad++' }) === 'Notepad++');
check('"Electron" falls back to the product name', M.appName({ exe: 'C:\\x\\Discord.exe', desc: 'Electron', product: 'Discord' }) === 'Discord');
check('"Electron" twice falls back to the exe name', M.appName({ exe: 'C:\\x\\browser.exe', desc: 'Electron', product: 'Electron' }) === 'Browser');
check('explorer is File Explorer', M.appName({ exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer' }) === 'File Explorer');
check('the desktop is Desktop', M.appName({ shell: true, exe: 'C:\\Windows\\explorer.exe' }) === 'Desktop');
check('no exe at all (elevated app) still has a name', M.appName({ exe: '', desc: '' }) === 'Window');

/* separators */
const cleaned = M.cleanItems([{ t: 'sep' }, { t: 'item', label: 'a' }, { t: 'sep' }, { t: 'sep' }, { t: 'item', label: 'b', items: [{ t: 'sep' }, { t: 'item', label: 'c' }, { t: 'sep' }] }, { t: 'sep' }]);
check('leading, doubled and trailing separators go, recursively',
  JSON.stringify(cleaned.map((i) => i.t)) === '["item","sep","item"]' && cleaned[2].items.length === 1, JSON.stringify(cleaned));

/* new window */
check('Chrome opens a new window with --new-window', JSON.stringify(M.newWindowArgs('C:\\p\\chrome.exe')) === '["--new-window"]');
check('Firefox uses -new-window', JSON.stringify(M.newWindowArgs('C:\\p\\firefox.exe')) === '["-new-window"]');
check('an unknown app gets no New window item at all', M.newWindowArgs('C:\\p\\whatever.exe') === null);
check('the table is not mutated through a returned array', (M.newWindowArgs('C:\\p\\chrome.exe').push('x'), M.newWindowArgs('C:\\p\\chrome.exe').length === 1));

/* titles: never an empty bar */
const chrome = { hwnd: '1', exe: 'C:\\p\\chrome.exe', desc: 'Google Chrome', zoomed: true, topmost: true, menu: null };
const t1 = M.titles(chrome, null);
check('a menu-less app: Mantle, the bold app menu and a Window menu', t1.map((t) => t.key).join(',') === 'mantle,app,window' && t1[1].bold === true && t1[1].label === 'Google Chrome');
const am = t1[1].items.filter((i) => i.t === 'item');
check('app menu: New window, Minimize, Restore size (zoomed), Always on top (checked), Close window, Quit',
  am.map((i) => i.act).join(',') === 'newWindow,minimize,zoom,ontop,close,quit' && am[2].label === 'Restore size' && am[3].checked === true && am[5].label === 'Quit Google Chrome');
const npp = { hwnd: '2', exe: 'C:\\p\\notepad++.exe', desc: 'Notepad++' };
const menu = { source: 'win32', hwnd: '2', items: [{ t: 'item', pos: 0, label: 'File', items: [{ t: 'item', pos: 0, label: 'New', id: 41 }] }, { t: 'sep', pos: 1 }, { t: 'item', pos: 2, label: 'Edit', items: [] , lazy: true }] };
const t2 = M.titles(npp, menu);
check('an app with menus: its menus follow the bold name, separators dropped, positions kept',
  t2.map((t) => t.label).join('|') === 'Mantle|Notepad++|File|Edit' && t2[3].pos === 2 && t2[3].lazy === true && t2[2].source === 'win32');
check('the Mantle menu has the power items, and the dangerous ones confirm',
  M.MANTLE_MENU.filter((i) => i.act === 'power').map((i) => i.power + (i.confirm ? '!' : '')).join(',') === 'lock,sleep,restart!,shutdown!');
check('the Mantle menu has the "keep the bar over full-screen games" switch (unchecked until hello says)',
  M.MANTLE_MENU.some((i) => i.act === 'overGames' && i.checked === false && /full-screen games/.test(i.label)));
check('the desktop gets a File Explorer window item', M.titles({ shell: true }, null)[1].items[0].act === 'newWindow');

/* the tiny-numbers rule */
check('pct rounds and clamps', M.pct(23.4) === '23%' && M.pct(140) === '100%' && M.pct(-1) === '0%' && M.pct(null) === '--');
check('gb has one fixed decimal', M.gb(10 * 2 ** 30) === '10.0' && M.gb(undefined) === '--');
check('rate picks units with fixed decimals', M.rate(0) === '0 KB/s' && M.rate(512 * 1024) === '512 KB/s' && M.rate(2.5 * 2 ** 20) === '2.5 MB/s' && M.rate(300 * 2 ** 20) === '300 MB/s' && M.rate(-5) === '--');
const cells = M.statCells({ cpu: { pct: 12 }, mem: { used: null, reason: 'x' }, gpu: { pct: null, reason: 'no GPU counters' }, net: { down: 1, up: 2 } });
check('an unavailable stat shows -- and carries its reason', cells[2].value === '--' && cells[2].why === 'no GPU counters' && cells[1].why === 'x' && cells[0].why === null);
check('no sample yet: every cell says --, with a reason', M.statCells(null).every((c) => c.value === '--' && c.why));

/* the feature module, once it exists */
const feat = path.join(__dirname, 'topbar.js');
if (fs.existsSync(feat)) {
  const f = require(feat);
  check('feature: name/label/defaultOn/install', f.name === 'topbar' && typeof f.label === 'string' && typeof f.install === 'function');
  check('feature: takes no chords from Windows', !f.chords || f.chords.length === 0);
  if (typeof f._test === 'object') {
    const T = f._test;
    if (T.reserveSize) check('feature: app bar size is 28 DIP scaled to physical px', T.reserveSize(1.25, true) === 35 && T.reserveSize(1, true) === 28 && T.reserveSize(1.5, false) === 28);
    if (T.stepAsideFor) {
      check('feature: a game verdict steps the bar aside', T.stepAsideFor({ stepAside: true, signal: 'x' }, false) === true);
      check('feature: "keep the bar over full-screen games" overrides it', T.stepAsideFor({ stepAside: true }, true) === false);
      check('feature: no verdict (an old sidecar) never steps aside', T.stepAsideFor(undefined, false) === false && T.stepAsideFor({ stepAside: false }, false) === false);
      check('feature: the lock screen always steps the bar aside, even with "keep over games" on',
        T.stepAsideFor({ stepAside: false }, false, 'LockApp.exe') === true && T.stepAsideFor(undefined, true, 'LogonUI.exe') === true);
    }
    if (T.lockScreen) {
      const L = T.lockScreen;
      check('feature: LockApp.exe (the live log\'s full-screen window) is the lock screen, by path, any case',
        L({ exe: 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe' }) === 'LockApp.exe' && L({ exe: 'c:\\windows\\systemapps\\x\\LOCKAPP.EXE' }) === 'LockApp.exe');
      check('feature: LogonUI.exe is the sign-in screen', L({ exe: 'C:\\Windows\\System32\\LogonUI.exe' }) === 'LogonUI.exe');
      check('feature: an unreadable exe path still matches on the file description', L({ exe: '', desc: 'LockApp.exe' }) === 'LockApp.exe');
      check('feature: ordinary apps, Mantle itself and no snapshot are not the lock screen',
        L({ exe: 'C:\\x\\notepad.exe', desc: 'Notepad' }) === null && L({ exe: 'C:\\x\\LockApp.exe', self: true }) === null && L(null) === null && L({ exe: 'C:\\x\\NotLockApp.exe' }) === null);
    }
    if (T.workAreaCheck) {
      const d = (by, wy) => ({ bounds: { x: 0, y: by, width: 1536, height: 864 }, workArea: { x: 0, y: wy, width: 1536, height: 800 } });
      check('feature: work area starting at the bar bottom passes', T.workAreaCheck(d(0, 28)).ok && T.workAreaCheck(d(0, 28.8)).ok);
      check('feature: work area still at the screen top fails, with both numbers', !T.workAreaCheck(d(0, 0)).ok && T.workAreaCheck(d(0, 0)).want === 28 && T.workAreaCheck(d(0, 0)).got === 0);
    }
  }
}

console.log(`TOPBAR MODEL TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);
