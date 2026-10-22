'use strict';
/*
 * check.js - the cheap, boring check that runs in a second and needs no Electron.
 *
 *   node tools/check.js
 *
 * Two jobs:
 *   1. node --check every .js in the repo (never node_modules), so a typo in a
 *      lane's file is found here instead of as a window that silently never opens.
 *   2. list the files the four lanes owe each other, present or missing, with the
 *      lane that owns each one. A missing file is not a failure -- lanes finish at
 *      different times -- but it is never a surprise either.
 *
 * Exit code is 1 only if something that EXISTS does not parse.
 *
 * SPEED (core-lib, 2026-09-29): it used to start one `node --check` per file, and with ~310 files
 * that took 133 s on the user's machine, not "a second". Now each file is parsed IN this process the
 * way Node's CommonJS loader wraps it (Module.wrap + vm.Script, compiled but never run), and only a
 * file that fails that is handed to `node --check` for the verdict and the words, so the answer is
 * still node's own.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'obj', 'bin', 'bin-int', 'bin-next', 'out', 'shots']);

/** Does this file parse as Node would load it? Compiled only, never run. */
function parsesInProcess(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.startsWith('#!')) src = '//' + src.slice(2);   // a hashbang is legal only at the very start
  try { new vm.Script(Module.wrap(src), { filename: file }); return true; } catch (_) { return false; }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const CONTRACT = [
  ['main.js', 'main process (lane B)'],
  ['preload.js', 'the window.mantle bridge (lane B)'],
  ['ui/desktop/index.html', 'desktop layer (lane B)'],
  ['ui/shared/tokens.css', 'shared palette (shipped with the repo)'],
  ['ui/bar/index.html', 'the bar (lane C)'],
  ['ui/launcher/index.html', 'the launcher (lane D)'],
  ['lib/launcher-index.js', 'the app index module (lane D)'],
  ['sidecar/bin/Mantle.Sidecar.exe', 'the Win32 sidecar, built (lane A)'],
  ['sidecar/build.ps1', 'the sidecar build script (lane A)'],
];

let bad = 0;

console.log('syntax');
const files = walk(ROOT);
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  try {
    if (!parsesInProcess(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ok      ${rel}`);
  } catch (err) {
    bad++;
    const msg = (err.stderr ? err.stderr.toString() : String(err)).trim().split('\n').slice(0, 3).join(' / ');
    console.log(`  BROKEN  ${rel}: ${msg}`);
  }
}

console.log('\nfiles the lanes owe each other');
for (const [rel, who] of CONTRACT) {
  const there = fs.existsSync(path.join(ROOT, rel));
  console.log(`  ${there ? 'present' : 'MISSING'}  ${rel}  (${who})`);
}

console.log(bad ? `\n${bad} of ${files.length} file(s) do not parse` : `\nevery .js parses (${files.length} files)`);
process.exit(bad ? 1 : 0);
