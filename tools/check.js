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
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'obj', 'bin', 'shots']);

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
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
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

console.log(bad ? `\n${bad} file(s) do not parse` : '\nevery .js parses');
process.exit(bad ? 1 : 0);
