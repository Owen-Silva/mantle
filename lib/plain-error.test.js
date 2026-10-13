/*
 * plain-error.test.js - lib/plain-error.js (lane mn-plainwords, 2026-10-12): raw error codes become
 * plain words before they reach a page, the codes go to the log, and nothing else is touched.
 *
 *   PART 1  the mapper on the sidecar's real error shapes (SysCommon.Why, "(Type: message)", Downloads'
 *           "Type 0x...", stack text, Node errno, JS errors), Microsoft's documented meanings, the
 *           generic sentence for an unknown code, text without a code left exactly as it was
 *   PART 2  plainReply: only error-ish fields change, at any depth, copy-on-write, codes reported once
 *   PART 3  the choke points: main.js mantle:call / broadcast / replay and lib/features.js push run
 *           every reply and push through it (the broadcast region is RUN in a vm with a fake window)
 *
 *   node lib/plain-error.test.js     -> "PLAIN-ERROR TEST: n passed, m failed"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('./plain-error');

let passed = 0;
const failures = [];
const ok = (cond, name, detail) => { if (cond) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); };
/** Anything a developer would recognise as a raw code or exception text. */
const RAW_I = /0x[0-9a-f]{8}|exception|hresult|\(\d+\)|\berror \d|\bat [\w.]+\(|TypeError|win32/i;
const RAW = { test: (s) => RAW_I.test(s) || /\bE[A-Z]{3,}\b/.test(s) };   // errno names are upper-case only

/* ---- PART 1: the mapper ---------------------------------------------------------------------- */
const CASES = [
  // [raw, expected text]
  ['Windows Update Agent did not answer: COMException (0x8024402C)', 'Windows Update Agent did not answer: there is no internet connection'],
  ['Windows Update Agent did not answer: COMException (0x80240009)', 'Windows Update Agent did not answer: Windows Update is busy with another check or an install; try again in a few minutes'],
  ["Windows Update's list could not be read: COMException (0x80004005)", "Windows Update's list could not be read: Windows reported an unexpected error"],
  ['The update history could not be read: COMException (0x8024FFFF)', 'The update history could not be read: Windows Update reported an error it did not explain'],
  ['the app volumes could not be read (COMException: Exception from HRESULT: 0x88890004)', 'the app volumes could not be read (the device was unplugged or changed)'],
  ['Windows refused the write: access denied (5)', 'Windows refused the write: access was denied'],
  ['files.list failed: IOException', 'files.list failed: Windows reported an unexpected error'],
  ['IOException 0x80070020', 'The file is in use by another app'],
  ['IOException 0x80070070', 'The disk is full'],
  ['the in-process Bluetooth API failed (COMException: Element not found. (Exception from HRESULT: 0x80070490))', 'the in-process Bluetooth API failed (it was not found)'],
  ["EBUSY: resource busy or locked, rename 'C:\\a\\b.txt' -> 'C:\\a\\c.txt'", 'The file is in use by another app'],
  ['spawn powershell.exe ENOENT', 'It was not found'],
  ['Win32Exception: Access is denied', 'Access was denied'],
  ['the brightness could not be read (ManagementException: Not supported )', 'the brightness could not be read (this PC does not support it)'],
  ['switching threw InvalidOperationException: Sequence contains no elements\n   at System.Linq.Enumerable.First(IEnumerable`1 source)\n   at Mantle.AltTab.Go()', 'switching failed: Windows reported an unexpected error'],
  ["settings.update.status failed (TypeError: Cannot read properties of undefined (reading 'x'))", 'settings.update.status failed (Mantle hit an internal error)'],
  ['the update failed with error 0x80240009', 'the update failed: Windows Update is busy with another check or an install; try again in a few minutes'],
  ['HRESULT -2147024891', 'Access was denied'],
  ['0x80070005', 'Access was denied'],
  ['the night light state could not be written (UnauthorizedAccessException: Access to the registry key is denied.)', 'the night light state could not be written (access was denied)'],
  ['the service could not be asked: Win32 error 1062', 'the service could not be asked: the Windows service it needs is not running'],
  ['the Wi-Fi scan did not finish (COMException (0x800706BA))', 'the Wi-Fi scan did not finish (the Windows service it needs is not running)'],
  ['a policy blocks it: COMException (0x8024002E)', 'a policy blocks it: a policy on this PC blocks Windows Update'],
  ['the file could not be opened (System.IO.FileNotFoundException: Could not find file)', 'the file could not be opened (the file was not found)'],
  ['the folder could not be read (DirectoryNotFoundException)', 'the folder could not be read (the folder was not found)'],
  ['moving it failed: EXDEV: cross-device link not permitted', 'moving it failed: it cannot be moved to another drive that way'],
];
for (const [raw, want] of CASES) {
  const r = P.plainText(raw);
  ok(r.text === want, `plain: ${JSON.stringify(raw).slice(0, 70)}`, `got ${JSON.stringify(r.text)}`);
  ok(!RAW.test(r.text), `plain: no raw code left in ${JSON.stringify(r.text).slice(0, 60)}`);
  ok(r.changed && r.codes.length > 0, `plain: codes kept for the log for ${JSON.stringify(raw).slice(0, 50)}`, r.codes.join(','));
}
// the codes for the log carry no message text and no path
const logged = P.plainText("UnauthorizedAccessException: Access to the path 'C:\\Users\\user\\secret.txt' is denied.").codes;
ok(logged.join(',') === 'UnauthorizedAccessException', 'codes: only the type name, never the message or its path', logged.join(','));
ok(P.plainText('COMException (0x8024402C)').codes.join(',') === 'COMException,0x8024402C', 'codes: the type and the HRESULT');

// text with no code stays exactly as it was (the same string, changed false)
for (const s of ['Windows Update is busy', 'the window 0x000A0B12 is gone', 'Test run, nothing changed: Mantle would pause updates for 2 weeks',
  'You said no to the administrator prompt; nothing changed.', 'Checked 3 hours ago: 2 found', 'the helper exited: exit code 1', '', 'an error in the list']) {
  const r = P.plainText(s);
  ok(r.text === s && !r.changed && !r.codes.length, `untouched: ${JSON.stringify(s)}`, JSON.stringify(r));
}
ok(P.plainText(null).text === null && P.plainText(undefined).text === undefined, 'untouched: null and undefined');

// meaning(): Microsoft's documented meanings, HRESULT_FROM_WIN32, errno, type names
ok(P.meaning('0x80070005') === 'access was denied', 'meaning: E_ACCESSDENIED');
ok(P.meaning('0x80070020') === 'the file is in use by another app', 'meaning: ERROR_SHARING_VIOLATION via 0x8007');
ok(P.meaning('0x80070003') === 'the folder was not found', 'meaning: ERROR_PATH_NOT_FOUND via 0x8007');
ok(P.meaning('0x80070070') === 'the disk is full', 'meaning: ERROR_DISK_FULL via 0x8007');
ok(P.meaning('0x80070422') === 'the Windows service it needs is turned off', 'meaning: ERROR_SERVICE_DISABLED via 0x8007');
ok(P.meaning('0x80072efd') === 'there is no internet connection', 'meaning: lower-case hex is read too');
ok(P.meaning('win32:32') === P.meaning('0x80070020'), 'meaning: win32:N and 0x8007NNNN agree');
ok(P.meaning('ENOSPC') === 'the disk is full' && P.meaning('EACCES') === 'access was denied', 'meaning: errno');
ok(P.meaning('UnauthorizedAccessException') === 'access was denied', 'meaning: a .NET type name');
ok(P.meaning('0x80004005') === null && P.meaning('0x8007FFFF') === null && P.meaning('nope') === null, 'meaning: unknown is null');
// every WU_E_* busy code update.js knows reads as busy words here too
const { BUSY, WHY } = require('./features/_settings-sections/update');
for (const code of Object.keys(BUSY)) ok(!!P.meaning(code), `meaning: update.js busy code ${code} has words`);
for (const code of Object.keys(WHY)) ok(!!P.meaning(code), `meaning: update.js history code ${code} has words`);

/* ---- PART 2: plainReply ---------------------------------------------------------------------- */
const status = {
  ok: true, build: { name: 'Windows 11 Home' }, lastCheck: null, wuaWhy: 'Windows Update Agent did not answer: COMException (0x8024402C)',
  delivery: { words: null, why: "Windows keeps it in the Delivery Optimization service's own profile (NETWORK SERVICE), which this account may not read (access denied (5))" },
  check: { running: false, error: null, code: '0x8024402C' },
  items: [{ title: 'Update 0x80070005 for COMException', reason: 'IOException 0x80070020', code: 'ENOENT' }],
  warn: ['the list could not be read: COMException (0x800706BA)', 'fine words'],
  roundTripError: 'Win32Exception: Access is denied',
  message: 'a notification body that says 0x80070005', text: 'COMException copied to the clipboard',
};
const before = JSON.stringify(status);
let seen = null, calls = 0;
const out = P.plainReply(status, (codes) => { calls++; seen = codes; });
ok(JSON.stringify(status) === before, 'reply: the original object is never changed');
ok(out !== status, 'reply: a changed reply is a copy');
ok(out.wuaWhy === 'Windows Update Agent did not answer: there is no internet connection', 'reply: wuaWhy (the last-checked line)', out.wuaWhy);
ok(!RAW.test(out.delivery.why), 'reply: a nested why', out.delivery.why);
ok(out.items[0].reason === 'The file is in use by another app', 'reply: a reason inside an array item', out.items[0].reason);
ok(out.items[0].title === status.items[0].title, 'reply: a title is never touched (it is a person\'s own content)');
ok(out.items[0].code === 'ENOENT' && out.check.code === '0x8024402C', 'reply: a code field the page may switch on is never touched');
ok(out.warn[0] === 'the list could not be read: the Windows service it needs is not running' && out.warn[1] === 'fine words', 'reply: a warn array', out.warn.join(' | '));
ok(out.roundTripError === 'Access was denied', 'reply: a *Error field', out.roundTripError);
ok(out.message === status.message && out.text === status.text, 'reply: message and text fields are never touched');
ok(out.build === status.build && out.check === status.check, 'reply: untouched branches are the same objects (no copy)');
ok(calls === 1 && Array.isArray(seen) && seen.includes('0x8024402C') && seen.includes('win32:5'), 'reply: the codes are reported once, all of them', seen && seen.join(','));
const clean = { ok: true, reason: null, items: [{ title: 'A', why: 'Windows did not say' }] };
let cleanCalls = 0;
ok(P.plainReply(clean, () => cleanCalls++) === clean && cleanCalls === 0, 'reply: a clean reply is the same object, no log');
ok(P.plainReply('COMException (0x80070005)') === 'COMException (0x80070005)', 'reply: a bare string reply is not an error field, so it is left');
ok(P.plainReply({ ok: false, error: 'EPERM: operation not permitted' }).error === 'Access was denied', 'reply: the mantle:call error envelope');
ok(P.plainReply(null) === null && P.plainReply(5) === 5 && P.plainReply(undefined) === undefined, 'reply: non-objects pass');
const buf = Buffer.from('x');
ok(P.plainReply({ reason: buf }).reason === buf, 'reply: a Buffer is not walked');
let cyc = { reason: 'COMException (0x80070005)' }; cyc.self = cyc;
let threw = null;
try { P.plainReply(cyc); } catch (e) { threw = e; }
ok(!threw, 'reply: a cycle stops at the depth limit instead of throwing', threw && threw.message);
const big = { items: Array.from({ length: 4000 }, (_, i) => ({ title: `file ${i}`, size: i, why: i === 3999 ? 'files.size failed: IOException' : null })) };
const t0 = process.hrtime.bigint();
const bigOut = P.plainReply(big);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok(bigOut.items[3999].why === 'files.size failed: Windows reported an unexpected error' && bigOut.items[0] === big.items[0], 'reply: 4000 rows, only the one with a code is copied');
ok(ms < 50, `reply: 4000 rows walked in ${ms.toFixed(1)} ms (< 50)`);
// onceLogger: each distinct where+codes once
const lines = [];
const said = P.onceLogger((l) => lines.push(l));
said('settings.update.status', ['COMException', '0x8024402C']); said('settings.update.status', ['COMException', '0x8024402C']); said('x', []);
said('settings.update.list', ['COMException', '0x8024402C']);
ok(lines.length === 2 && /settings\.update\.status: shown in plain words, the codes were COMException, 0x8024402C/.test(lines[0]), 'log: once per where+codes, codes kept', lines.join(' | '));

/* ---- PART 3: the choke points -------------------------------------------------------------- */
const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const callH = MAIN.slice(MAIN.indexOf("ipcMain.handle('mantle:call'"), MAIN.indexOf("ipcMain.on('mantle:theme-now'"));
ok(/return \{ ok: true, result: toPage\(name, result\) \};/.test(callH), 'main.js mantle:call: every result goes through toPage');
ok(/return toPage\(name, \{ ok: false, error: msg \}\);/.test(callH), 'main.js mantle:call: a thrown error goes through toPage');
ok(/callLog\.result\(name, a, logView\(a, result\)\);\s*return \{ ok: true, result: toPage/.test(callH), 'main.js mantle:call: the log is written from the RAW result first (the codes stay in the log)');
ok(/ipcMain\.handle\('mantle:replay', async \(e, name\) => toPage\(/.test(MAIN) && /async function replayAnswer\(e, name\) \{/.test(MAIN), 'main.js mantle:replay: every replay goes through toPage');
ok(/\n\/\/ <\/mainrel:broadcast>\r?\npushWords = \(name, payload\) => toPage\(/.test(MAIN), 'main.js broadcast: pushWords is set to toPage right after the region');
const m = /\/\/ <mainrel:broadcast>[^\n]*\n([^]*?)\/\/ <\/mainrel:broadcast>/.exec(MAIN);
if (!m) ok(false, 'main.js broadcast region found');
else {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, isCrashed: () => false, send: (ch, msg) => sent.push(msg) } };
  const ctx = { BrowserWindow: { getAllWindows: () => [win] }, process: { stdout: { write() {} } }, WeakSet };
  vm.createContext(ctx);
  vm.runInContext(`${m[1]}\nthis.broadcast = broadcast; this.setWords = (f) => { pushWords = f; };`, ctx);
  ctx.broadcast('qs', { audio: { reason: 'x (COMException (0x88890004))' } });
  ok(sent[0] && sent[0].payload.audio.reason === 'x (COMException (0x88890004))', 'broadcast region alone (main-rel.test.js): pushes the payload as it was');
  ctx.setWords((name, p) => P.plainReply(p));
  ctx.broadcast('qs', { audio: { reason: 'the playback devices could not be read (COMException: Exception from HRESULT: 0x88890004)' } });
  ok(sent[1] && sent[1].payload.audio.reason === 'the playback devices could not be read (the device was unplugged or changed)', 'broadcast: once wired, every window gets the words', sent[1] && sent[1].payload.audio.reason);
}
const FEAT = fs.readFileSync(path.join(__dirname, 'features.js'), 'utf8');
ok(/const words = plainError\.plainReply\(payload, [^\n]*\n\s*try \{ win\.webContents\.send\('mantle:event', \{ name: event, payload: words \}\)/.test(FEAT), 'lib/features.js push(): a feature\'s push to its window goes through plainReply');
for (const f of ['wallpaper.js', 'switcher.js']) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  ok(/send\('mantle:event', \{ name, payload: toPage\(`push \$\{name\}`, payload\) \}\)/.test(src), `lib/${f}: its pushes go through toPage`);
}
// a real feature push through createFeatures, with a fake window
(async () => {
  try {
    const { createFeatures } = require('./features');
    const sent = [];
    const logs = [];
    const fakeWin = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, msg) => sent.push(msg) } };
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwords-feat-'));
    fs.writeFileSync(path.join(dir, 'zzplain.js'), "module.exports = { name: 'zzplain', label: 'Plain', defaultOn: true, install(ctx) { global.__zzplainCtx = ctx; } };\n");
    const { EventEmitter } = require('events');
    const sc = new EventEmitter();
    sc.blockedReason = () => null;
    sc.call = async () => ({ installed: true, chords: [], observe: [], reason: null });
    const { ShellState } = require('./state');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwords-ud-'));
    const feats = createFeatures({ dir, test: true, root: ROOT, userData, state: new ShellState('test', 'bottom'), sidecar: sc, commands: {}, broadcast() {}, log: (l) => logs.push(l), host: {} });
    await feats.load();
    await new Promise((r) => setTimeout(r, 50));
    const mod = { ctx: global.__zzplainCtx };
    if (!mod.ctx) ok(false, 'features push: the fake feature started', logs.slice(-3).join(' | '));
    else {
      mod.ctx.push(fakeWin, 'zzplain.done', { ok: false, error: 'files.size failed: UnauthorizedAccessException' });
      mod.ctx.push(fakeWin, 'zzplain.done', { ok: false, error: 'files.size failed: UnauthorizedAccessException' });
      ok(sent[0] && sent[0].payload.error === 'files.size failed: access was denied', 'features push: the page gets the words', sent[0] && JSON.stringify(sent[0]));
      ok(logs.filter((l) => /shown in plain words, the codes were UnauthorizedAccessException/.test(l)).length === 1, 'features push: the code is logged once', logs.filter((l) => /plain words/.test(l)).join(' | '));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { ok(false, 'features push: threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`PLAIN-ERROR TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
