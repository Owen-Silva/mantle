'use strict';
/* lib/keep-ready.test.js -- the keep-ready switches (lane settingsfast). Plain node, no Electron.
 *   node lib/keep-ready.test.js   -> "KEEP-READY TEST: n passed, m failed" */
const fs = require('fs');
const os = require('os');
const path = require('path');
const KR = require('./keep-ready.js');

let passed = 0;
const failed = [];
function check(name, ok, detail) { if (ok) passed++; else { failed.push(name); console.log(`FAIL ${name}${detail !== undefined ? ` -- ${detail}` : ''}`); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-keepready-test-'));
const file = path.join(dir, 'keep-ready.json');

try {
  check('three surfaces, these keys', JSON.stringify(KR.KEYS) === '["settings","taskmgr","files"]' && KR.keyOf('files') === 'keepReady.files');
  const logs = [];
  const s = KR.create({ file, log: (m) => logs.push(m) });
  check('no file: every key is off', JSON.stringify(s.all()) === JSON.stringify({ 'keepReady.settings': false, 'keepReady.taskmgr': false, 'keepReady.files': false }) && s.reason() === null);
  const heard = [];
  const off = s.onChange((surface, on) => heard.push([surface, on]));
  const r = s.set('files', true);
  check('set: saved and read back', r.ok && r.on === true && s.get('files') === true && s.get('settings') === false);
  check('set: the file holds the config key', JSON.parse(fs.readFileSync(file, 'utf8'))['keepReady.files'] === true);
  check('set: a new store reads it back (survives a restart)', KR.create({ file }).get('files') === true);
  check('set: listeners hear the change once', JSON.stringify(heard) === '[["files",true]]', JSON.stringify(heard));
  s.set('files', true);
  check('set: the same value again is not a change', heard.length === 1);
  check('set: logged without paths', logs.some((l) => /Files kept ready in the background/.test(l)) && !logs.some((l) => l.includes(dir)), JSON.stringify(logs));
  off();
  s.set('files', false);
  check('onChange: off() stops it', heard.length === 1);
  const bad = s.set('explorer', true);
  check('an unknown surface is refused in words', bad.ok === false && /not a window Mantle can keep ready/.test(bad.reason));
  check('only true turns one on (truthy strings do not)', s.set('taskmgr', 'yes').on === false && s.get('taskmgr') === false);

  fs.writeFileSync(file, '{ not json');
  const b = KR.create({ file, log: () => {} });
  check('a broken file: every key off, said in words, moved aside', b.get('settings') === false && /did not hold these switches/.test(b.reason() || '') && fs.existsSync(file + '.unreadable'), b.reason());
  check('...and the next set writes a good file', b.set('settings', true).ok && KR.create({ file }).get('settings') === true && b.reason() === null);

  const v = KR.create({ file }).view();
  check('view: one row per surface with its words and cost', v.rows.length === 3 && v.rows.every((x) => /^Keep .+ ready$/.test(x.label) && /holds about \d+ MB of memory all the time/.test(x.help) && /uses no memory while closed/.test(x.help)), JSON.stringify(v.rows.map((x) => x.label)));
  check('view: Settings row says Win+I', /Win\+I opens it instantly/.test(v.rows[0].help));
  const nf = KR.create({ file: null });
  check('no folder: off, and a set says why', nf.get('settings') === false && nf.set('settings', true).ok === false);
  check('plain node: the shared store never loads Electron and is all off', KR.get('settings') === false && KR.get('files') === false);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`KEEP-READY TEST: ${passed} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
