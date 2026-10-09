'use strict';
/*
 * args.test.js - lib/args.js: the flags that decide whether Mantle may touch Windows at all
 * (core-lib quality pass, 2026-09-29).
 *
 *   node lib/args.test.js
 *
 * Failed first: --profile-name took anything, and it becomes a folder name
 * (%TEMP%\mantle-test-<x>) and the text tools/kill-test.ps1 and toback.ps1 match on. A name with
 * "..\" or a slash put a TEST run's user data outside %TEMP% (next to, or into, the live
 * %APPDATA%\mantle), and a name with a space or quote broke the kill-test match.
 */
const { parseArgs, ArgError } = require('./args');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
function refused(argv, re, name) {
  try { parseArgs(argv); check(name, false, 'it was accepted'); } catch (e) { check(name, e instanceof ArgError && re.test(e.message), e.message); }
}

const bare = parseArgs([]);
check('no flags: neither live nor test (main refuses to run)', bare.live === false && bare.test === false);
const t = parseArgs(['--test', '--profile-name=core-lib', '--screenshot=shots']);
check('test + profile + screenshot', t.test && t.profileName === 'core-lib' && t.screenshot === 'shots', JSON.stringify(t));
check('live', parseArgs(['--live']).live === true);
check('unknown flags are left for main.js (not an error)', parseArgs(['--test', '--profile-name=a', '--test-unload', '--test-live-bar']).test === true);
check('bar edge top', parseArgs(['--live', '--bar-edge=top']).barEdge === 'top');
check('--no-desktop / --no-acrylic', (() => { const f = parseArgs(['--live', '--no-desktop', '--no-acrylic']); return !f.desktop && !f.acrylic; })());
check('non-string argv entries are skipped', parseArgs([null, 5, '--live']).live === true);

refused(['--live', '--test', '--profile-name=a'], /opposites/, 'live + test refused');
refused(['--quit', '--live'], /--quit only/, 'quit + live refused');
refused(['--test'], /requires --profile-name/, 'test without a profile refused');
refused(['--live', '--screenshot=x'], /only works with --test/, 'screenshot without test refused');
refused(['--live', '--flyout=code'], /only works with --test/, 'flyout without test refused');
refused(['--test', '--profile-name=a', '--screenshot='], /needs a directory/, 'empty screenshot dir refused');
refused(['--live', '--bar-edge=left'], /top" or "bottom/, 'a bad bar edge refused');

for (const bad of ['..\\..\\Roaming\\mantle', '../x', 'a/b', 'a\\b', 'has space', 'q"uote', '..', '.', 'x'.repeat(65), 'C:x', '-rf']) {
  refused(['--test', `--profile-name=${bad}`], /profile-name/, `profile name ${JSON.stringify(bad).slice(0, 30)} refused`);
}
for (const good of ['dev', 'core-lib', 'core_b.2', 'A1']) {
  check(`profile name ${good} accepted`, parseArgs(['--test', `--profile-name=${good}`]).profileName === good);
}

// --theme (lane dm-core, 2026-10-08): a test instance's appearance, over the saved setting
check('--theme defaults to null (the saved setting rules)', bare.theme === null);
for (const v of ['dark', 'light', 'system']) {
  check(`--theme=${v} on a test run`, parseArgs(['--test', '--profile-name=dm', `--theme=${v}`]).theme === v);
}
refused(['--test', '--profile-name=dm', '--theme=blue'], /--theme must be "dark", "light" or "system", got "blue"/, '--theme=blue is refused in words');
refused(['--test', '--profile-name=dm', '--theme'], /--theme must be/, '--theme with no value is refused');
refused(['--live', '--theme=dark'], /--theme only works with --test/, '--theme on the live shell is refused');

for (const f of failures) console.log('FAIL ' + f);
console.log(`ARGS TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
