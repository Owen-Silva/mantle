'use strict';
/*
 * iconpending.test.js -- the bar never guesses a running app's icon while the sidecar is still reading
 * it (lane r7-fg, 2026-10-01).
 *
 * WHY. The sidecar's window list read every app's icon on its ui lane, and the first list after a start
 * held that lane ~1 s (measured: 952-961 ms of 1025-1093 ms were icons), so every quick request queued
 * behind it waited up to 1.9 s. Now the list takes only icons already known and marks the rest
 * iconPending (sidecar/Windows.cs QueueIcon); a fresh list with them follows within ~1 s. main.js must
 * then show NO icon for that app until it arrives -- never ask by exe first, which would give a Store
 * app its exe's picture instead of its own.
 *   1. groupRunning (lifted out of main.js and run in a vm): a group is pending only while none of its
 *      windows has an icon and one of them is pending.
 *   2. buildPinned's running items: a pending group gets no icon and the reason "still loading", and is
 *      not sent to iconFor.
 * MANTLE_BASE_MAIN=<old main.js> runs the same checks against an older main.js (they must fail there).
 *   node lib/iconpending.test.js   -> "ICON PENDING TEST: n passed, m failed"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = process.env.MANTLE_BASE_MAIN || path.join(__dirname, '..', 'main.js');
const SRC = fs.readFileSync(FILE, 'utf8');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

/** The source of `function <name>(` up to its matching closing brace (strings/comments are plain here). */
function lift(name) {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  return null;
}

// 1. groupRunning, the real code.
const src = lift('groupRunning');
check('groupRunning is in main.js', !!src);
if (src) {
  const ctx = vm.createContext({ Map, Array, String, Object });
  vm.runInContext(`${src}; this.groupRunning = groupRunning;`, ctx);
  const png = 'data:image/png;base64,AAAA';
  const groups = ctx.groupRunning([
    { hwnd: '1', exe: 'C:\\Apps\\one.exe', title: 'a', icon: null, iconFrom: null, iconPending: true },
    { hwnd: '2', exe: 'C:\\Apps\\two.exe', title: 'b', icon: null, iconFrom: null, iconPending: true },
    { hwnd: '3', exe: 'C:\\Apps\\two.exe', title: 'c', icon: png, iconFrom: 'exe', iconPending: false },
    { hwnd: '4', exe: 'C:\\Apps\\three.exe', title: 'd', icon: null, iconFrom: null, iconPending: false },
    { hwnd: '5', aumid: 'Some.App_x!App', exe: 'C:\\Program Files\\WindowsApps\\x\\app.exe', host: 'frame', title: 'e', icon: null, iconFrom: null, iconPending: true },
  ]);
  const g = (exe) => [...groups.values()].find((x) => x.exe === exe.toLowerCase() || (x.aumid && x.aumid === exe.toLowerCase()));
  check('a window whose icon is still being read makes its app pending', g('C:\\Apps\\one.exe') && g('C:\\Apps\\one.exe').iconPending === true);
  check('an app that already has an icon from another window is not pending, and keeps that icon',
    g('C:\\Apps\\two.exe') && !g('C:\\Apps\\two.exe').iconPending && g('C:\\Apps\\two.exe').icon === png);
  check('an app with no icon that is NOT pending is not pending (iconFor may look)', g('C:\\Apps\\three.exe') && !g('C:\\Apps\\three.exe').iconPending);
  check('a Store app still loading is pending (no exe picture in its place)', g('Some.App_x!App') && g('Some.App_x!App').iconPending === true);
}

// 2. buildPinned's running items: the pending branch comes before the iconFor fallback, with no icon.
const bp = lift('buildPinned') || '';
const run = bp.slice(bp.indexOf('Everything running that no pin claimed'));
const pend = run.indexOf("g.iconPending ? { icon: null, reason: 'still loading' }");
const fall = run.indexOf('await iconFor([g.exeRaw');
check('buildPinned: a pending app gets no icon and "still loading", and is never sent to iconFor',
  pend > 0 && fall > pend, `pending branch at ${pend}, iconFor at ${fall}`);

console.log(`ICON PENDING TEST${process.env.MANTLE_BASE_MAIN ? ' (against ' + FILE + ')' : ''}: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
