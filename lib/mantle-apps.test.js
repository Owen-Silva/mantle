'use strict';
/* mantle-apps.test.js - which windows and pins are Mantle's apps, their icons, and whether Mantle's
   version can open (icons lane, 2026-09-28). Plain node, no Electron, nothing opened.
     node lib/mantle-apps.test.js */
const fs = require('fs');
const path = require('path');
const MA = require('./mantle-apps');

let passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; console.log('  FAIL: ' + label); } }

const EL = 'C:\\Users\\user\\mantle\\node_modules\\electron\\dist\\electron.exe';

// windows
ok(MA.forWindow({ exe: EL, title: 'Mantle Settings' }) === 'settings', 'electron.exe titled "Mantle Settings" is Mantle Settings');
ok(MA.forWindow({ exe: EL, title: 'Mantle Task Manager' }) === 'taskmgr', 'electron.exe titled "Mantle Task Manager" is the task manager');
ok(MA.forWindow({ exe: EL, title: 'Mantle Files' }) === 'files', 'a third app window slots in from its APPS entry alone');
ok(MA.forWindow({ exe: 'C:\\x\\electron.exe', title: 'Mantle Settings - Quartz' }) === null, 'the title must be EXACT (a browser tab is not Mantle Settings)');
ok(MA.forWindow({ exe: 'C:\\Windows\\notepad.exe', title: 'Mantle Settings' }) === null, 'another program with that title is not Mantle\'s');
ok(MA.forWindow({ exe: EL, title: 'anything', aumid: 'Mantle.TaskManager' }) === 'taskmgr', 'the per-window AUMID alone is enough (setAppDetails)');
ok(MA.forWindow({ exe: EL, title: 'Quartz', aumid: null }) === null, 'The user\'s own Electron browser is not a Mantle app');
ok(MA.forTitle('Mantle Settings') === 'settings' && MA.forTitle('mantle settings') === null, 'forTitle is exact');

// pins (lib/pinned.js records)
ok(MA.standInFor({ aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' }) === 'settings', 'Windows Settings pinned (its AUMID, no shortcut) -> Mantle Settings');
ok(MA.standInFor({ aumid: 'Windows.ImmersiveControlPanel_cw5n1h2txyewy!Microsoft.Windows.ImmersiveControlPanel' }) === 'settings', 'the AUMID match ignores case');
ok(MA.standInFor({ exe: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe' }) === 'settings', 'SystemSettings.exe -> Mantle Settings');
ok(MA.standInFor({ target: 'ms-settings:display' }) === 'settings', 'an ms-settings: shortcut -> Mantle Settings');
ok(MA.standInFor({ exe: 'C:\\WINDOWS\\system32\\Taskmgr.exe', lnkPath: 'x.lnk' }) === 'taskmgr', 'Taskmgr.exe pinned -> Mantle Task Manager');
// lane barfiles (2026-09-29): the File Explorer pin opens Mantle Files directly
ok(MA.standInFor({ aumid: 'Microsoft.Windows.Explorer', lnkPath: 'File Explorer.lnk' }) === 'files', 'File Explorer\'s pin (its AUMID, no file target) -> Mantle Files');
ok(MA.standInFor({ exe: 'C:\\Windows\\explorer.exe', args: '' }) === 'files', 'bare explorer.exe pinned -> Mantle Files');
ok(MA.standInFor({ exe: 'C:\\Windows\\explorer.exe', args: 'D:\\Projects' }) === null, 'explorer.exe WITH a folder argument is a folder shortcut: left alone');
ok(MA.forPin({ id: 'mantle:mantle.files', exe: EL, aumid: 'mantle.files' }) === 'files', 'Mantle\'s own pin of Mantle Files (electron.exe + its AUMID) is Mantle Files');
ok(MA.forPin({ aumid: 'Mantle.TaskManager' }) === 'taskmgr' && MA.forPin({ aumid: 'Mantle.Settings' }) === 'settings', 'forPin knows every Mantle app by AUMID, any case');
ok(MA.forPin({ exe: EL, aumid: null }) === null && MA.forPin({ exe: EL, aumid: 'quartz' }) === null && MA.forPin(null) === null, 'electron.exe alone (the user\'s browser) is never a Mantle app pin');
ok(MA.standInFor({ exe: 'C:\\Program Files\\Spotify\\Spotify.exe' }) === null && MA.standInFor(null) === null, 'any other pin is left alone');

// icons: every APPS entry has its files, and a missing one is a reason, never a throw
for (const k of MA.KEYS) {
  const ico = MA.icoPath(k);
  ok(fs.existsSync(ico), k + ': ' + path.basename(ico) + ' exists');
  const buf = fs.existsSync(ico) ? fs.readFileSync(ico) : Buffer.alloc(6);
  ok(buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) === 8, k + ': the .ico holds 8 sizes');
  ok(/^data:image\/png;base64,/.test(MA.iconOf(k, 32).icon || ''), k + ': a 32 px data URL');
  ok(fs.existsSync(MA.pngPath(k)), k + ': the 256 px png exists');
}
const missing = MA.iconOf('settings', 999);
ok(missing.icon === null && /missing/.test(missing.reason) && /make-icons/.test(missing.reason), 'a missing size says so and how to make it (' + missing.reason + ')');
ok(MA.iconOf('nope').icon === null, 'an unknown app is null with a reason');

// availability (lib/features.js list() records)
const rec = (o) => Object.assign({ name: 'settings', loaded: true, enabled: true, stopped: false, resting: null, ok: true, reason: '' }, o);
ok(MA.availability('settings', [rec({})]).ok === true, 'on and healthy: Mantle\'s opens');
ok(/switched off in the tray/.test(MA.availability('settings', [rec({ enabled: false })]).reason), 'off: said');
ok(MA.availability('settings', [rec({ resting: 'VALORANT runs', stopped: true })]).reason === 'Mantle Settings is resting while VALORANT runs', 'resting: said with the game');
ok(/not loaded/.test(MA.availability('taskmgr', [rec({})]).reason), 'no such feature: not loaded');
ok(/is down: page crashed/.test(MA.availability('settings', [rec({ ok: false, reason: 'page crashed' })]).reason), 'unhealthy: said with its reason');

// core-lib 2026-09-29: an inherited name is not a Mantle app (failed first: 'constructor' read Object's).
for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
  ok(MA.iconOf(k, 32).icon === null && /no such Mantle app/.test(MA.iconOf(k, 32).reason), 'iconOf(' + k + '): no such Mantle app');
  ok(MA.icoPath(k) === null && MA.pngPath(k, 32) === null, 'icoPath/pngPath(' + k + '): null');
  ok(/no such Mantle app/.test(MA.availability(k, []).reason), 'availability(' + k + '): no such Mantle app');
}

console.log('MANTLE APPS TEST: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
