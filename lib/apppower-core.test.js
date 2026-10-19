/* apppower-core.test.js - node lib/apppower-core.test.js (lane mantle-power, 2026-10-14).
 * The pure half of App power: which app a row is, the friendly names, what is never offered, the
 * rules (validate, change, merge with phase 2's Auto), the words, and decorate() of a stats sample. */
'use strict';
const C = require('./apppower-core');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }
const JARGON = /ecoqos|job object|working set|\bpid\b|\bkey\b|dryRun|qos|priority class|undefined|null|NaN/i;

const MANTLE_LIVE = 'C:\\Users\\user\\mantle-live\\node_modules\\electron\\dist\\electron.exe';
const MANTLE_WT = 'C:\\Users\\user\\mantle-wt\\power\\node_modules\\electron\\dist\\electron.exe';
const QUARTZ_EL = 'C:\\Users\\user\\browser\\node_modules\\electron\\dist\\electron.exe';
const HELM_EL = 'C:\\Users\\user\\helm\\node_modules\\electron\\dist\\electron.exe';
const OTHER_EL = 'C:\\Users\\user\\some-app\\node_modules\\electron\\dist\\electron.exe';
const OWN = 'C:\\Users\\user\\mantle-wt\\power\\node_modules\\electron\\dist\\electron.exe';

// ---- keys and grouping
check('a normal app is keyed by its exe name, any case, with or without .exe', C.keyFor('Quartz', 'C:\\x\\Quartz.exe') === 'quartz' && C.keyFor('quartz.exe', null) === 'quartz');
check('a generic runtime is keyed by its exe path too (Mantle, Quartz and Helm are all electron.exe)',
  C.keyFor('electron', MANTLE_LIVE) !== C.keyFor('electron', QUARTZ_EL) && C.keyFor('electron', QUARTZ_EL) === 'electron|' + QUARTZ_EL.toLowerCase());
check('slashes and case do not split one app in two', C.keyFor('electron', QUARTZ_EL.replace(/\\/g, '/').toUpperCase()) === C.keyFor('electron', QUARTZ_EL));
check('a generic runtime without a path has no key (it could be any app, Mantle included)', C.keyFor('electron', null) === null && C.keyFor('node', '') === null);
check('every GENERIC name is the sidecar list', ['electron', 'node', 'python', 'pythonw', 'py', 'java', 'javaw', 'dotnet'].every((x) => C.GENERIC.has(x)) && C.GENERIC.size === 8);
check('exeOf reads "electron (13)" and an exe field', C.exeOf({ name: 'electron (13)' }) === 'electron' && C.exeOf({ name: 'x', exe: 'Quartz.exe' }) === 'Quartz');
check('countOf: n, else the "(13)" in the name, else 1', C.countOf({ n: 4, name: 'a (9)' }) === 4 && C.countOf({ name: 'svchost (43)' }) === 43 && C.countOf({ name: 'System' }) === 1);

// ---- friendly names
check('Mantle\'s live electron is "Mantle"', C.friendlyName('electron', MANTLE_LIVE, OWN) === 'Mantle');
check('a Mantle worktree / test copy is "Mantle" too', C.friendlyName('electron', MANTLE_WT, 'C:\\other\\electron.exe') === 'Mantle');
check('the electron.exe under ~/browser is Quartz', C.friendlyName('electron', QUARTZ_EL, OWN) === 'Quartz');
check('Quartz.exe is Quartz', C.friendlyName('Quartz', 'C:\\Users\\user\\browser\\node_modules\\electron\\dist\\Quartz.exe', OWN) === 'Quartz');
check('the electron.exe under ~/helm is Helm, helm.exe is Helm', C.friendlyName('electron', HELM_EL, OWN) === 'Helm' && C.friendlyName('helm', 'C:\\x\\helm.exe', OWN) === 'Helm');
check('another Electron app is named by its folder', C.friendlyName('electron', OTHER_EL, OWN) === 'some-app (Electron)');
check('well-known Windows names read like Task Manager', C.friendlyName('svchost', null) === 'Service Host' && C.friendlyName('MsMpEng', null) === 'Microsoft Defender' && C.friendlyName('msedge', null) === 'Microsoft Edge' && C.friendlyName('powershell', null) === 'PowerShell');
check('an unknown exe shows as Windows names it', C.friendlyName('MyTool', 'C:\\t\\MyTool.exe') === 'MyTool' && C.friendlyName('', null) === 'This app');

// ---- protected
for (const n of ['System', 'svchost', 'MsMpEng', 'csrss', 'lsass', 'dwm', 'audiodg', 'explorer', 'Memory Compression', 'Registry', 'smss', 'wininit', 'winlogon', 'services', 'Mantle.Sidecar'])
  check(`never offered: ${n}`, !!C.protectedWhy(n, 'C:\\Windows\\System32\\' + n + '.exe', 'ok', n, OWN), n);
check('Windows processes say "Windows protects this process"', C.protectedWhy('svchost', null, 'ok', 'Service Host', OWN) === 'Windows protects this process');
check('Mantle (live, or this very instance) says "This is Mantle"', C.protectedWhy('electron', MANTLE_LIVE, 'ok', 'Mantle', 'C:\\z\\electron.exe') === 'This is Mantle' && C.protectedWhy('electron', OWN, 'ok', 'Mantle', OWN) === 'This is Mantle');
check('a protected process (by Windows\' own flag) is protected', C.protectedWhy('SomeAv', 'C:\\x\\SomeAv.exe', 'protected', 'SomeAv', OWN) === 'Windows protects this process');
check('a session-0 service is protected', C.protectedWhy('SomeSvc', 'C:\\x\\SomeSvc.exe', 'system', 'SomeSvc', OWN) === 'Windows protects this process');
check('an app run as administrator says so with its name', C.protectedWhy('Tool', 'C:\\x\\Tool.exe', 'admin', 'Tool', OWN) === 'Windows doesn’t let Mantle change Tool: it runs as administrator');
check('a game or anti-cheat is never offered', C.protectedWhy('VALORANT', 'C:\\x\\VALORANT.exe', 'game', 'VALORANT', OWN) === 'Mantle never changes games or anti-cheat');
check('Quartz, Helm and an ordinary app are offered', !C.protectedWhy('electron', QUARTZ_EL, 'ok', 'Quartz', OWN) && !C.protectedWhy('helm', 'C:\\x\\helm.exe', 'ok', 'Helm', OWN) && !C.protectedWhy('chrome', 'C:\\x\\chrome.exe', 'unknown', 'Chrome', OWN));

// ---- sets and changes
const caps1 = { gpus: 1, gpuLow: true, gpuPref: false };
check('normalizeSet: junk becomes the default', JSON.stringify(C.normalizeSet({ eco: 'yes', priority: 'realtime', cpuCap: 150, memCap: 5, gpuPref: 'x' })) === JSON.stringify(C.DEFAULT_SET));
check('normalizeSet keeps good values; "normal" priority = not changed', (() => { const s = C.normalizeSet({ eco: true, priority: 'normal', cpuCap: 25, memLow: true, memCap: 1024 * 1024 * 1024 }); return s.eco && s.priority === null && s.cpuCap === 25 && s.memLow && s.memCap === 1073741824; })());
check('isDefaultSet', C.isDefaultSet({}) && C.isDefaultSet({ priority: 'normal' }) && !C.isDefaultSet({ eco: true }));
let r = C.applyChange(null, { eco: true }, caps1);
check('change: Efficiency mode on', r.ok && r.set.eco === true && r.set.cpuCap === 0, r);
r = C.applyChange(r.set, { cpuCap: 25 }, caps1);
check('change: a CPU limit keeps Efficiency mode', r.ok && r.set.eco && r.set.cpuCap === 25, r);
check('change: High / Realtime are refused in plain words', !C.applyChange(null, { priority: 'high' }, caps1).ok && /never raises/.test(C.applyChange(null, { priority: 'realtime' }, caps1).reason));
check('change: two fields at once are refused', !C.applyChange(null, { eco: true, memLow: true }, caps1).ok);
check('change: an unknown field is refused', !C.applyChange(null, { kill: true }, caps1).ok);
check('change: a CPU limit outside 0..99 is refused', !C.applyChange(null, { cpuCap: 100 }, caps1).ok && !C.applyChange(null, { cpuCap: 2.5 }, caps1).ok && C.applyChange(null, { cpuCap: 0 }, caps1).ok);
check('change: a memory limit under 64 MB is refused, 0 clears it', !C.applyChange(null, { memCap: 1024 }, caps1).ok && C.applyChange({ memCap: 1 << 30 }, { memCap: 0 }, caps1).set.memCap === 0);
check('change: a graphics preference on a one-GPU PC is refused, "default" is fine', !C.applyChange(null, { gpuPref: 'performance' }, caps1).ok && C.applyChange(null, { gpuPref: 'default' }, caps1).ok);
check('change: a graphics preference with 2 GPUs works', C.applyChange(null, { gpuPref: 'saving' }, { gpus: 2, gpuPref: true }).set.gpuPref === 'saving');
check('change: lower graphics priority refused with the sidecar\'s reason when Windows does not allow it',
  C.applyChange(null, { gpuLow: true }, { gpuLow: false, gpuLowWhy: 'Windows only lets administrators change graphics priority' }).reason === 'Windows only lets administrators change graphics priority');
check('every refusal is plain words', ['priority:high', 'cpuCap:100', 'memCap:1', 'gpuPref:x', 'kill:1'].every((p) => { const [k, v] = p.split(':'); const x = C.applyChange(null, { [k]: isNaN(+v) ? v : +v }, caps1); return !x.ok && !JARGON.test(x.reason); }));

// ---- words
check('summary', C.summary({ eco: true, cpuCap: 25 }) === 'Efficiency mode, CPU limit 25%' && C.summary({ memCap: 1 << 30, memLow: true }) === 'Lower memory priority, Memory limit 1 GB' && C.summary({}) === 'Normal');
check('fmtBytes', C.fmtBytes(412 * 1024 * 1024) === '412 MB' && C.fmtBytes(1.5 * 1024 * 1024 * 1024) === '1.5 GB' && C.fmtBytes(0) === '0 MB');
check('deny: an admin app', C.denyWords('Quartz', 0, [{ access: 'admin', n: 3 }]) === 'Windows didn’t let Mantle change Quartz: it runs as administrator');
check('deny: some of an app', C.denyWords('Quartz', 5, [{ access: 'admin', n: 1 }]) === 'Windows didn’t let Mantle change one of Quartz’s processes: it runs as administrator');
check('deny: processes that closed are not a failure', C.denyWords('Quartz', 2, [{ access: 'gone', n: 4 }]) === null && C.denyWords('Quartz', 2, []) === null);
check('deny: protected', C.denyWords('X', 0, [{ access: 'protected', n: 1 }]) === 'Windows protects this process');
check('deny: words carry no jargon', !JARGON.test(C.denyWords('X', 0, [{ access: 'error', n: 2 }])));

// ---- stored rules
const good = { key: 'quartz', exe: 'Quartz', path: 'C:\\Users\\user\\browser\\node_modules\\electron\\dist\\Quartz.exe', label: 'Quartz', set: { eco: true } };
check('cleanRule keeps a good rule', !!C.cleanRule(good) && C.cleanRule(good).set.eco === true && C.cleanRule(good).remember === true);
check('cleanRule drops a protected app, Mantle, a wrong key, an empty set, a relative path', !C.cleanRule(Object.assign({}, good, { exe: 'svchost', key: 'svchost' }))
  && !C.cleanRule({ exe: 'electron', path: MANTLE_LIVE, set: { eco: true } }) && !C.cleanRule(Object.assign({}, good, { key: 'chrome' }))
  && !C.cleanRule(Object.assign({}, good, { set: {} })) && !C.cleanRule(Object.assign({}, good, { path: 'browser\\Quartz.exe' })));
check('cleanRule: a generic runtime needs its path', !C.cleanRule({ exe: 'electron', set: { eco: true } }) && !!C.cleanRule({ exe: 'electron', path: QUARTZ_EL, set: { eco: true } }));
const ra = C.cleanRule(good), rb = C.cleanRule({ exe: 'chrome', path: 'C:\\c\\chrome.exe', set: { cpuCap: 10 } });
const table = C.mergeTable([ra], [{ exe: 'Quartz', path: good.path, set: { priority: 'low' } }, { exe: 'chrome', path: 'C:\\c\\chrome.exe', set: { eco: true } }, { exe: 'svchost', set: { eco: true } }]);
check('PHASE 2 merge: the user\'s rule wins, Auto fills the rest, Auto never reaches a protected app',
  table.length === 2 && table[0].set.eco === true && table[0].set.priority === null && table[1].key === 'chrome' && table[1].source === 'auto' && table[1].remember === false, table);
const sr = C.sidecarRules([ra, rb]);
check('sidecarRules: match + the process settings, never the graphics preference', sr.length === 2 && sr[0].match.exe === 'Quartz' && sr[0].match.path === good.path && !('gpuPref' in sr[0].set) && sr[1].set.cpuCap === 10);

// ---- decorate
const L = C.createLive();
L.ownExe = OWN;
const sample = {
  cpu: { pct: 30, top: [
    { name: 'svchost (43)', exe: 'svchost', n: 43, path: 'C:\\Windows\\System32\\svchost.exe', access: 'system', pct: 5 },
    { name: 'electron (6)', exe: 'electron', n: 6, path: QUARTZ_EL, access: 'ok', pct: 4 },
    { name: 'electron (9)', exe: 'electron', n: 9, path: OWN, access: 'ok', pct: 3 },
    { name: 'Tool', exe: 'Tool', n: 1, path: 'C:\\t\\Tool.exe', access: 'admin', pct: 2 },
    { name: 'electron', exe: 'electron', n: 1, path: null, access: 'unknown', pct: 1 },
  ] },
  mem: { used: 1, top: [{ name: 'chrome (12)', pct: undefined, bytes: 900 }] },   // an old sidecar: no exe/n/path
  net: { down: 1 },
};
check('decorate leaves the sample alone while App power is not running', L.decorate(sample) === sample);
L.running = true;
L.caps = { gpus: 1, gpuLow: true, gpuLowWhy: null, gpuPref: false };
let d = L.decorate(sample);
const rows = d.cpu.top;
check('decorate: the sample is copied, not changed', !('key' in sample.cpu.top[0]) && d !== sample && d.net === sample.net);
check('decorate: svchost is protected, no controls', rows[0].ctl === false && rows[0].why === 'Windows protects this process' && rows[0].label === 'Service Host' && rows[0].n === 43);
check('decorate: Quartz\'s electron is a controllable "Quartz" row', rows[1].ctl === true && rows[1].label === 'Quartz' && rows[1].key === 'electron|' + QUARTZ_EL.toLowerCase() && rows[1].why === null && rows[1].set.eco === false && rows[1].remembered === false);
check('decorate: this Mantle is "This is Mantle"', rows[2].ctl === false && rows[2].why === 'This is Mantle' && rows[2].label === 'Mantle');
check('decorate: an admin app says so, no controls', rows[3].ctl === false && /runs as administrator/.test(rows[3].why));
check('decorate: an electron without a path is left alone with the reason', rows[4].ctl === false && rows[4].key === null && /can’t tell which app/.test(rows[4].why));
check('decorate: the old values stay (name, pct)', rows[1].name === 'electron (6)' && rows[1].pct === 4);
check('decorate: an old sidecar row (no exe/path) still works by name', d.mem.top[0].label === 'Google Chrome' && d.mem.top[0].n === 12 && d.mem.top[0].ctl === true && d.mem.top[0].key === 'chrome');
check('decorate: apppower caps at the top level', d.apppower && d.apppower.gpus === 1 && d.apppower.gpuPref === false && d.apppower.gpuLow === true);
// a rule + a status
L.rules.set('electron|' + QUARTZ_EL.toLowerCase(), C.cleanRule({ exe: 'electron', path: QUARTZ_EL, label: 'Quartz', set: { eco: true, cpuCap: 25 } }));
L.status.set('electron|' + QUARTZ_EL.toLowerCase(), { applied: 4, denied: [{ access: 'admin', n: 2 }], shared: false });
d = L.decorate(sample);
const q = d.cpu.top[1];
check('decorate: the rule\'s state is on the row', q.set.eco === true && q.set.cpuCap === 25 && q.remembered === true);
check('decorate: a partial refusal is on the row in plain words', q.deny === 'Windows didn’t let Mantle change 2 of Quartz’s processes: they run as administrator', q.deny);
check('decorate: shared=false (the limit applies fully after a restart)', q.shared === false);
check('decorate: no row text carries jargon', d.cpu.top.every((x) => !x.why || !JARGON.test(x.why)) && (!q.deny || !JARGON.test(q.deny)));
check('known rows are kept for the dropdown\'s calls, capped', L.known.has('chrome') && (() => { for (let i = 0; i < 400; i++) L.remember('k' + i, { exe: 'k' + i }); return L.known.size <= 300 && !L.known.has('k0') && L.known.has('k399'); })());
let changed = 0;
L.onChange = () => { changed++; };
L.setAuto([{ exe: 'chrome', path: 'C:\\c\\chrome.exe', set: { eco: true } }]);
check('PHASE 2 hook: setAuto tells the feature and joins the table under the user\'s rules', changed === 1 && L.table().length === 2 && L.table()[1].source === 'auto');

for (const x of failures) console.log('  FAIL ' + x);
console.log('APPPOWER CORE TEST: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
