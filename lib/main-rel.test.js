/*
 * main-rel.test.js -- main.js's reliability pieces (lane mainrel, 2026-09-27), run as the REAL code:
 * each piece sits between `// <mainrel:NAME>` and `// </mainrel:NAME>` in main.js, and this file
 * lifts that region out and runs it in a vm with fakes (main.js itself needs Electron).
 *
 *   logtee     every file line stamped HH:MM:SS.mmm (the date at start and after midnight);
 *              rotation at maxBytes into .1/.2, between lines, nothing lost, a failed rename
 *              said and retried; how long a real 5 MB rotation blocks.
 *   broadcast  a page whose renderer died gets no send (Electron prints an error per send), said once.
 *   revive     a dead page is reloaded 3 times in 2 min at most, then Mantle stops and says so.
 *   session    Windows ending the session runs shutdown() once; the question alone does not.
 *   qsBtToggle a failed Bluetooth reason no longer names the device (security review #20).
 *
 * Pinned to the old code: the HEAD versions of broadcast and qsBtToggle are run as baselines and
 * must show the old fault (a send to the dead page; the device name in the reason).
 *
 *   node lib/main-rel.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
// The baselines are main.js as it was BEFORE these fixes landed (d85d4bb, the parent of 9abfe4d): once
// 9abfe4d was committed, HEAD itself carried the fix and its broadcast needed deadPagesSaid (2026-09-28).
let HEAD = '';
try { HEAD = execFileSync('git', ['show', 'd85d4bb:main.js'],{ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { HEAD = ''; }

let passed = 0;
const failures = [];
function ok(cond, what) { if (cond) passed++; else failures.push(what); }
const notes = [];

function region(src, name) {
  const a = src.indexOf(`// <mainrel:${name}>`);
  const b = src.indexOf(`// </mainrel:${name}>`);
  if (a === -1 || b === -1) throw new Error(`main.js has no <mainrel:${name}> region`);
  return src.slice(a, b);
}
// A top-level function in main.js, from its `function name(` line to the first `}` at column 0.
function topFunction(src, head) {
  const a = src.indexOf(head);
  if (a === -1) return null;
  const end = src.indexOf('\n}', a);
  return src.slice(a, end + 2);
}
function run(code, ctx, expose) {
  const c = vm.createContext(Object.assign({ Buffer, Number, String, Math, Map, WeakSet, Object, Array, JSON, Error }, ctx));
  vm.runInContext(`${code}\n;globalThis.__out = { ${expose.join(', ')} };`, c);
  return c.__out;
}

/* ---- logtee ------------------------------------------------------------------------------------ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mainrel-'));
const teeCode = region(SRC, 'logtee');
const { makeLogTee } = run(teeCode, { process }, ['makeLogTee']);
const STAMP = /^\d\d:\d\d:\d\d\.\d{3} /;
const STAMP_DAY = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /;

{
  const f = path.join(TMP, 'stamp.log');
  let t = new Date(2026, 8, 27, 23, 59, 59, 990);
  const tee = makeLogTee(fs, f, { now: () => t });
  tee.start('===== mantle start\n');
  tee.write('one\ntwo\n');
  tee.write('three, in ');
  tee.write('two chunks\n');
  tee.write(Buffer.from('caf\u00e9 \u2014 bytes\n', 'utf8'));
  t = new Date(2026, 8, 28, 0, 0, 0, 5);   // midnight passes
  tee.write('after midnight\nand the next\n');
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  ok(lines.length === 7, `stamp: 7 lines written (got ${lines.length})`);
  ok(STAMP_DAY.test(lines[0]) && lines[0].includes('2026-09-27 23:59:59.990 ===== mantle start'), `stamp: the first line of a run has the date (${lines[0]})`);
  ok(STAMP.test(lines[1]) && !STAMP_DAY.test(lines[1]) && lines[1].endsWith(' one'), `stamp: a later line has the time only (${lines[1]})`);
  ok(lines[3].endsWith(' three, in two chunks') && (lines[3].match(/\d\d:\d\d:\d\d\.\d{3}/g) || []).length === 1, `stamp: a line in two chunks gets one stamp (${lines[3]})`);
  ok(lines[4].endsWith('caf\u00e9 \u2014 bytes'), 'stamp: a UTF-8 Buffer comes through whole');
  ok(lines[5].startsWith('2026-09-28 00:00:00.005 after midnight'), `stamp: the first line after midnight has the date (${lines[5]})`);
  ok(STAMP.test(lines[6]) && !STAMP_DAY.test(lines[6]), 'stamp: the line after that has the time only');
}

// Rotation, nothing lost: 3 files hold every line (sized so the keep limit drops none).
{
  const f = path.join(TMP, 'rot.log');
  const tee = makeLogTee(fs, f, { maxBytes: 4000, keep: 2 });
  tee.start('===== start\n');
  const N = 250;   // ~30 bytes a line stamped: ~7.5 KB over a 4 KB cap -> one rotation
  for (let i = 1; i <= N; i++) {
    if (i % 3 === 0) { tee.write(`line ${i} `); tee.write('in parts\n'); } else tee.write(`line ${i}\n`);
  }
  const parts = [`${f}.2`, `${f}.1`, f].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p, 'utf8'));
  const all = parts.join('');
  const nums = [...all.matchAll(/ line (\d+)( in parts)?\n/g)].map((m) => Number(m[1]));
  ok(nums.length === N && nums.every((n, i) => n === i + 1), `rotate: all ${N} lines present in order across the files (got ${nums.length})`);
  ok(parts.every((p) => p.endsWith('\n')), 'rotate: every file ends between two lines (none split)');
  ok(fs.existsSync(`${f}.1`) && fs.statSync(`${f}.1`).size >= 4000, 'rotate: the full file became .1');
  ok(/log: rotated at \d+ MB: the previous 0\.0 MB is now rot\.log\.1 \(2 old files kept\), rotated in [\d.]+ ms/.test(parts[parts.length - 1]), 'rotate: the new file opens with the rotation line (size, name, ms)');
  ok(parts.every((p) => p.split('\n').filter(Boolean).every((l) => STAMP.test(l) || STAMP_DAY.test(l))), 'rotate: every line in every file is stamped');
}

// keep = 2: many rotations leave exactly .1 and .2, newest lines intact and contiguous.
{
  const f = path.join(TMP, 'many.log');
  const tee = makeLogTee(fs, f, { maxBytes: 1500, keep: 2 });
  tee.start('===== start\n');
  for (let i = 1; i <= 600; i++) tee.write(`line ${i}\n`);
  ok(fs.existsSync(`${f}.1`) && fs.existsSync(`${f}.2`) && !fs.existsSync(`${f}.3`), 'rotate: 2 old files kept, no .3');
  const all = [`${f}.2`, `${f}.1`, f].map((p) => fs.readFileSync(p, 'utf8')).join('');
  const nums = [...all.matchAll(/ line (\d+)\n/g)].map((m) => Number(m[1]));
  ok(nums[nums.length - 1] === 600 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1), 'rotate: the kept lines run without a gap to the last one');
}

// A rename that fails (a reader holding the file): keep writing, say so in the log, retry 1 MB later.
{
  const f = path.join(TMP, 'busy.log');
  let refuse = 1;
  const said = [];
  const fake = Object.assign({}, fs, {
    renameSync(a, b) { if (refuse > 0) { refuse--; const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return fs.renameSync(a, b); },
  });
  const tee = makeLogTee(fake, f, { maxBytes: 1000, keep: 2, retryBytes: 1000, say: (s) => said.push(s) });
  tee.start('===== start\n');
  for (let i = 1; i <= 120; i++) tee.write(`line ${i}\n`);
  const all = [`${f}.2`, `${f}.1`, f].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p, 'utf8')).join('');
  const nums = [...all.matchAll(/ line (\d+)\n/g)].map((m) => Number(m[1]));
  ok(nums.length === 120 && nums.every((n, i) => n === i + 1), `busy: no line lost when a rename fails (got ${nums.length})`);
  ok(/could NOT rotate at [\d.]+ MB \(.*EBUSY\); still writing to this file, next try at/.test(all), 'busy: the failure is written INTO the log with its reason');
  ok(said.length === 1 && said[0].includes('could NOT rotate'), 'busy: and to the terminal once');
  ok(fs.existsSync(`${f}.1`), 'busy: the retry 1 MB (here 1000 B) later rotated');
}

// Security review 2: mantle.log.1 / .2 READ-ONLY on the real fs (Windows refuses to rename over a
// read-only file): no throw out of write(), no line lost, the failure said in the log.
{
  const f = path.join(TMP, 'ro.log');
  const said = [];
  const tee = makeLogTee(fs, f, { maxBytes: 1000, keep: 2, retryBytes: 1000, say: (s) => said.push(s) });
  tee.start('===== start\n');
  let threw = null;
  try {
    for (let i = 1; i <= 100; i++) tee.write(`line ${i}\n`);       // rotations make .1 and .2
    fs.chmodSync(`${f}.1`, 0o444); fs.chmodSync(`${f}.2`, 0o444);
    for (let i = 101; i <= 240; i++) tee.write(`line ${i}\n`);
  } catch (e) { threw = e; }
  const all = [`${f}.2`, `${f}.1`, f].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p, 'utf8')).join('');
  const nums = [...all.matchAll(/ line (\d+)\n/g)].map((m) => Number(m[1]));
  const last = nums.slice(nums.indexOf(101));
  ok(!threw, `read-only .1/.2: write() never throws (${threw && threw.message})`);
  ok(last.length === 140 && last.every((n, i) => n === 101 + i), `read-only .1/.2: every line after it went read-only is kept, in order (got ${last.length})`);
  ok(/could NOT rotate at [\d.]+ MB \(.*(EPERM|EACCES)\)/.test(all), 'read-only .1/.2: the refused rotation is said in the log with its code');
  try { fs.chmodSync(`${f}.1`, 0o666); fs.chmodSync(`${f}.2`, 0o666); } catch (_) {}
}

// Security review 2: the file cannot be REOPENED after a rotation. It used to stay closed for the
// rest of the run (every later line lost, said only to a terminal the logon task does not have).
{
  const f = path.join(TMP, 'reopen.log');
  let clock = 0;
  let failOpens = 0;
  const said = [];
  const fake = Object.assign({}, fs, {
    openSync(p, fl) { if (failOpens > 0) { failOpens--; const e = new Error('denied'); e.code = 'EACCES'; throw e; } return fs.openSync(p, fl); },
  });
  const tee = makeLogTee(fake, f, { maxBytes: 1000, keep: 2, retryBytes: 1000, clock: () => clock, say: (s) => said.push(s) });
  tee.start('===== start\n');
  for (let i = 1; i <= 30; i++) tee.write(`line ${i}\n`);
  failOpens = 2;                                                    // the rotation's reopen + the first retry
  let i = 31;
  while (tee.size < 1000) tee.write(`line ${i++}\n`);                // up to the cap: the rotation
  const rotatedAfter = i - 1;
  for (let k = 0; k < 20; k++) tee.write(`lost ${k}\n`);            // closed: lost (counted)
  clock += 6000; tee.write('lost 20\n');                             // retry 1 fails
  clock += 6000; tee.write('back 1\n');                              // retry 2 opens
  tee.write('back 2\n');
  let now = '';
  try { now = fs.readFileSync(f, 'utf8'); } catch (_) { now = ''; }   // before the fix it was never made again
  ok(said.some((s) => /could not be reopened after rotating it/.test(s)), 'reopen: the failed reopen is said');
  ok(/ back 1\n/.test(now) && / back 2\n/.test(now), `reopen: logging comes back ${5}+ s later instead of never (after line ${rotatedAfter})`);
  ok(/log: this file could not be opened for 12 s \(EACCES\); 21 writes to it were lost/.test(now), 'reopen: the first line back says for how long and how many writes were lost');
}

// How long a real rotation blocks the main process: a 5 MB file, the real fs, timed around write().
{
  const f = path.join(TMP, 'real.log');
  const MB5 = 5 * 1024 * 1024;
  fs.writeFileSync(`${f}.1`, Buffer.alloc(MB5, 0x61));
  fs.writeFileSync(`${f}.2`, Buffer.alloc(1024, 0x62));
  fs.writeFileSync(f, Buffer.concat([Buffer.alloc(MB5 - 6000, 0x63), Buffer.from('\n')]));   // a live log just under the cap
  const tee = makeLogTee(fs, f);
  tee.start('===== start\n');
  const line = 'mantle: a typical line of about a hundred bytes, the kind Mantle writes many times a minute ok\n';
  const times = [];
  let rotMs = null;
  let after = 0;
  for (let i = 0; i < 2000 && after < 200; i++) {
    const before = tee.size;
    const t0 = process.hrtime.bigint();
    tee.write(line);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms);
    if (tee.size < before) rotMs = ms;
    if (rotMs !== null) after++;
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const max = times[times.length - 1];
  const said = (fs.readFileSync(f, 'utf8').match(/rotated in ([\d.]+) ms/) || [])[1];
  notes.push(`real 5 MB rotation: the write() that rotated took ${rotMs === null ? '?' : rotMs.toFixed(2)} ms (rotation itself ${said} ms); ${times.length} writes p50 ${p50.toFixed(3)} ms, max ${max.toFixed(2)} ms`);
  ok(rotMs !== null && rotMs < 50, `real rotation blocks under 50 ms (took ${rotMs})`);
  ok(fs.statSync(`${f}.2`).size === MB5, 'real rotation: the old .1 became .2');
  ok(fs.statSync(`${f}.1`).size >= MB5, 'real rotation: the full log became .1');
}

/* ---- broadcast --------------------------------------------------------------------------------- */
function fakeWin(opts) {
  const w = { sends: 0, crashed: !!opts.crashed, destroyed: !!opts.destroyed, url: opts.url || 'file:///C:/m/ui/bar/index.html' };
  w.webContents = {
    isDestroyed: () => false,
    isCrashed: () => { if (opts.throws) throw new Error('gone'); return w.crashed; },
    getURL: () => w.url,
    send: () => { if (w.crashed) w.errorsPrinted = (w.errorsPrinted || 0) + 1; w.sends++; },
  };
  w.isDestroyed = () => w.destroyed;
  return w;
}
function broadcastWith(code, wins) {
  const out = [];
  const ctx = { BrowserWindow: { getAllWindows: () => wins }, process: { stdout: { write: (s) => out.push(s) } } };
  const { broadcast } = run(code, ctx, ['broadcast']);
  return { broadcast, out };
}
{
  const live = fakeWin({});
  const dead = fakeWin({ crashed: true, url: 'file:///C:/m/ui/desktop/index.html' });
  const gone = fakeWin({ destroyed: true });
  const odd = fakeWin({ throws: true });
  const { broadcast, out } = broadcastWith(region(SRC, 'broadcast'), [live, dead, gone, odd]);
  for (let i = 0; i < 5; i++) broadcast('state', { i });
  ok(live.sends === 5, 'broadcast: a live page gets every send');
  ok(dead.sends === 0 && odd.sends === 0 && gone.sends === 0, `broadcast: no send to a dead page (dead ${dead.sends}, isCrashed-throws ${odd.sends})`);
  const lines = out.filter((s) => s.includes('renderer is gone'));
  ok(lines.length === 2 && lines.some((s) => s.includes("desktop/index.html's renderer is gone")), `broadcast: each dead page said once over 5 broadcasts (${lines.length} lines)`);
  dead.crashed = false;   // reloaded
  broadcast('state', {});
  ok(dead.sends === 1, 'broadcast: a reloaded page gets sends again');
  dead.crashed = true;    // dies again
  broadcast('state', {}); broadcast('state', {});
  ok(out.filter((s) => s.includes("desktop/index.html's renderer is gone")).length === 2, 'broadcast: a second death is said again, once');
  const headCode = HEAD ? topFunction(HEAD, 'function broadcast(') : null;
  if (headCode) {
    const d2 = fakeWin({ crashed: true });
    const h = broadcastWith(headCode, [d2]);
    for (let i = 0; i < 5; i++) h.broadcast('state', {});
    notes.push(`broadcast before/after: 5 state changes with one dead page -> HEAD sends to it ${d2.sends} times (each prints "Render frame was disposed" + a stack in Electron), now 0 and one line`);
    ok(d2.sends === 5, `baseline: HEAD's broadcast does send to the dead page (${d2.sends}), the fault this pins`);
  } else failures.push('baseline: could not read HEAD:main.js broadcast');
}

/* ---- revive ------------------------------------------------------------------------------------ */
function reviver(extra) {
  const clock = { t: 0, timers: [] };
  const reports = [];
  const said = [];
  let blocked = null;
  const { makePageReviver } = run(region(SRC, 'revive'), {}, ['makePageReviver']);
  const r = makePageReviver(Object.assign({
    tries: 3, windowMs: 120000, delays: [1000, 5000, 15000],
    now: () => clock.t,
    later: (fn, ms) => { const h = { at: clock.t + ms, fn }; clock.timers.push(h); return h; },
    cancel: (h) => { clock.timers = clock.timers.filter((x) => x !== h); },
    say: (s) => said.push(s),
    blocked: () => blocked,
    report: (key, okay, reason) => reports.push({ key, ok: okay, reason }),
  }, extra || {}));
  function advance(ms) {
    const end = clock.t + ms;
    for (;;) {
      clock.timers.sort((a, b) => a.at - b.at);
      const h = clock.timers[0];
      if (!h || h.at > end) break;
      clock.timers.shift(); clock.t = h.at; h.fn();
    }
    clock.t = end;
  }
  return { r, clock, reports, said, advance, block: (b) => { blocked = b; } };
}
{
  const R = reviver();
  let reloads = 0;
  const reload = () => { reloads++; return null; };
  ok(R.r.died('page.bar', 'The bar', 'killed', reload) === 'reload', 'revive: a death schedules a reload');
  ok(reloads === 0, 'revive: not at once');
  R.advance(999); ok(reloads === 0, 'revive: not before 1 s');
  R.advance(1); ok(reloads === 1, 'revive: the first reload at 1 s');
  ok(R.reports[0].ok === false && /renderer died \(killed\); reloading it in 1 s \(try 1 of 3/.test(R.reports[0].reason), `revive: the wait is SAID in state (${R.reports[0].reason})`);
  R.r.loaded('page.bar', 'The bar');
  ok(R.reports[R.reports.length - 1].ok === true && /reloaded after its renderer died/.test(R.reports[R.reports.length - 1].reason), 'revive: a load after it says healthy again');
  R.advance(10000); R.r.died('page.bar', 'The bar', 'crashed', reload); R.advance(5000);
  ok(reloads === 2, 'revive: the second death reloads after 5 s');
  R.advance(10000); R.r.died('page.bar', 'The bar', 'crashed', reload); R.advance(15000);
  ok(reloads === 3, 'revive: the third after 15 s');
  R.advance(10000);
  ok(R.r.died('page.bar', 'The bar', 'oom', reload) === 'gave-up', 'revive: a 4th death inside 2 min gives up');
  R.advance(60000);
  ok(reloads === 3, 'revive: and reloads no more');
  const last = R.reports[R.reports.length - 1];
  ok(last.ok === false && /died 4 times in 2 min \(the last: oom\), so Mantle stopped reloading it: restart Mantle/.test(last.reason), `revive: giving up is SAID (${last.reason})`);
  ok(R.said.some((s) => s.includes('stopped reloading')), 'revive: and logged');
}
{
  const R = reviver();
  let reloads = 0;
  for (let i = 0; i < 6; i++) { R.r.died('page.desktop', 'The desktop layer', 'killed', () => { reloads++; return null; }); R.advance(3 * 60000); }
  ok(reloads === 6, `revive: deaths 3 min apart never give up (${reloads} reloads of 6)`);
}
{
  const R = reviver();
  let reloads = 0;
  R.block('Mantle is quitting');
  ok(R.r.died('page.bar', 'The bar', 'killed', () => { reloads++; }) === 'blocked', 'revive: no reload while quitting');
  ok(/not reloaded: Mantle is quitting/.test(R.reports[0].reason), 'revive: and says why');
  R.block(null);
  R.r.died('page.launcher', 'The launcher', 'killed', () => { reloads++; });
  R.block('Windows is ending the session (logoff)');
  R.advance(2000);
  ok(reloads === 0 && /not reloaded: Windows is ending the session/.test(R.reports[R.reports.length - 1].reason), 'revive: a session end between the death and the reload stops it');
  ok(R.r.died('page.bar', 'The bar', 'clean-exit', () => { reloads++; }) === 'clean' && reloads === 0, 'revive: a clean exit is not a death');
  R.block(null);
  R.r.died('page.launcher', 'The launcher', 'killed', () => false);
  R.advance(20000);
  ok(R.reports[R.reports.length - 1].ok === true && /window was closed before its reload/.test(R.reports[R.reports.length - 1].reason), 'revive: a window closed since is not left saying "reloading"');
  R.r.died('page.launcher', 'The launcher', 'killed', () => { throw new Error('no page'); });
  R.advance(20000);
  ok(R.reports[R.reports.length - 1].ok === false && /could not be reloaded: no page/.test(R.reports[R.reports.length - 1].reason), 'revive: a reload that throws is said');
}

/* ---- session ----------------------------------------------------------------------------------- */
{
  let now = 1000000;
  const shut = [];
  const out = [];
  const ctx = { Date: { now: () => now }, shutdown: (why) => shut.push(why), process: { stdout: { write: (s) => out.push(s) } } };
  const S = run(region(SRC, 'session'), ctx, ['onSessionEnd', 'sessionEndingReason']);
  ok(S.sessionEndingReason() === null, 'session: nothing ending at first');
  S.onSessionEnd('query', { reasons: ['logoff'] }); S.onSessionEnd('query', { reasons: ['logoff'] }); S.onSessionEnd('query', { reasons: ['logoff'] });
  ok(shut.length === 0, 'session: the question alone does not quit (another app can still cancel it)');
  ok(out.length === 1 && out[0].includes('Windows asked whether the session may end (logoff)'), `session: three windows asked, one line (${out.length})`);
  ok(/Windows asked to end the session \(logoff\)/.test(S.sessionEndingReason() || ''), 'session: reloads are held after the question');
  now += 61000;
  ok(S.sessionEndingReason() === null, 'session: a question nobody followed up (cancelled) stops holding reloads after 60 s');
  S.onSessionEnd('end', { reasons: ['shutdown', 'critical'] }); S.onSessionEnd('end', { reasons: ['logoff'] }); S.onSessionEnd('query', {});
  ok(shut.length === 1 && shut[0] === 'Windows is ending the session (shutdown, critical)', `session: the end runs shutdown() once (${JSON.stringify(shut)})`);
  ok(/Windows is ending the session/.test(S.sessionEndingReason() || ''), 'session: and blocks reloads for good');
  S.onSessionEnd('end', {});
  ok(shut.length === 1, 'session: never twice');
}

/* ---- lib/features.js settingsFor (security review #4 + 2) --------------------------------------- */
// A feature's settings file that is corrupt, huge or not an object: it used to become {} silently
// (the next set() wrote over the rest) and was read with no size check, sync, on main.
async function settingsChecks() {
  const { createFeatures } = require('./features');
  const { ShellState } = require('./state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mainrel-settings-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mainrel-userdata-'));
  const mk = (n) => `module.exports = { name: '${n}', label: 'S ${n}', defaultOn: true, install(ctx) { global.__sett = global.__sett || {}; global.__sett['${n}'] = { ctx, v: ctx.settings.get('a', 'DEFAULT') }; } };`;
  for (const n of ['sbad', 'sbig', 'sarr', 'sgood']) fs.writeFileSync(path.join(dir, `${n}.js`), mk(n));
  const state = new ShellState('test', 'bottom');
  const lines = [];
  const sidecar = Object.assign(new (require('events').EventEmitter)(), { down: null, blockedReason: () => null, call: async () => ({}) });
  const f = createFeatures({ dir, test: true, root: ROOT, userData, state, sidecar, commands: {}, broadcast: () => {}, log: (l) => lines.push(l),
    host: { openLauncher: () => null, barRect: () => ({}), display: () => ({}) } });
  const sd = path.join(userData, 'features');
  fs.mkdirSync(sd, { recursive: true });
  const BAD = '{"a": "SECRET WINDOW TITLE", "b": [1, 2,,]}';
  fs.writeFileSync(path.join(sd, 'sbad.json'), BAD);
  fs.writeFileSync(path.join(sd, 'sbig.json'), JSON.stringify({ a: 'x'.repeat(5 * 1024 * 1024) }));
  fs.writeFileSync(path.join(sd, 'sarr.json'), '[1, 2, 3]');
  fs.writeFileSync(path.join(sd, 'sgood.json'), '{"a": "kept"}');
  const t0 = Date.now();
  f.load();
  const took = Date.now() - t0;
  const S = global.__sett || {};
  const piece = (n) => (state.get().features || {})[n] || {};
  ok(S.sbad && S.sbad.v === 'DEFAULT', 'settings: a corrupt file is not used (the default comes back)');
  ok(fs.existsSync(path.join(sd, 'sbad.json.unreadable')) && fs.readFileSync(path.join(sd, 'sbad.json.unreadable'), 'utf8') === BAD && !fs.existsSync(path.join(sd, 'sbad.json')),
    'settings: ... it is kept as <name>.json.unreadable, byte for byte');
  ok(lines.some((l) => /sbad: its saved settings were not used: sbad\.json is not valid JSON; kept as sbad\.json\.unreadable/.test(l)) && /not valid JSON/.test(piece('sbad').note || '') && piece('sbad').broken === piece('sbad').note && piece('sbad').ok === true,
    `settings: ... and SAID: a log line and the feature's line (note + broken, which the strip and tray show) ${JSON.stringify(piece('sbad'))}`);
  ok(!lines.some((l) => l.includes('SECRET')) && !JSON.stringify(state.get().features).includes('SECRET'), 'settings: ... and no reason quotes the file\'s text');
  let setErr = null;
  try { S.sbad.ctx.settings.set('a', 'new'); } catch (e) { setErr = e.message; }
  ok(!setErr && JSON.parse(fs.readFileSync(path.join(sd, 'sbad.json'), 'utf8')).a === 'new' && fs.existsSync(path.join(sd, 'sbad.json.unreadable')), `settings: ... a later set() writes a fresh file and keeps the unreadable one (${setErr})`);
  ok(S.sbig && S.sbig.v === 'DEFAULT' && /sbig\.json is 5\.0 MB, over the 4 MB a settings file may be/.test(piece('sbig').note || ''), `settings: a file over 4 MB is refused in words, not read ${JSON.stringify(piece('sbig').note)}`);
  ok(S.sarr && S.sarr.v === 'DEFAULT' && /not a JSON object/.test(piece('sarr').note || ''), 'settings: JSON that is not an object (an array) is not used, and said');
  try { S.sarr.ctx.settings.set('a', 'saved'); } catch (_) { /* checked below */ }
  let arrSaved = null;
  try { arrSaved = JSON.parse(fs.readFileSync(path.join(sd, 'sarr.json'), 'utf8')).a; } catch (_) { arrSaved = null; }
  ok(arrSaved === 'saved', `settings: ... a set() after it is really saved (on an array every key was dropped: got ${arrSaved})`);
  ok(S.sgood && S.sgood.v === 'kept' && !piece('sgood').note, 'settings: a good file is used and nothing is said');
  notes.push(`settings: loading 4 features (one with a 5 MB settings file) took ${took} ms`);
  try { await f.stopAll('test'); } catch (_) { /* fixtures */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp */ }
}

/* ---- qsBtToggle -------------------------------------------------------------------------------- */
async function bt(code, reply) {
  const { qsBtToggle } = run(code, {
    qsMore: async () => Object.assign({}, reply), QS_BT_MS: { toggle: 1 }, qsWatching: false, qsPush: () => {},
  }, ['qsBtToggle']);
  return qsBtToggle('connect', { device: 'BTH-1' });
}
(async () => {
  await settingsChecks();
  const cur = topFunction(SRC, 'async function qsBtToggle(');
  const NAME = "Owen's Buds Pro";
  const a = await bt(cur, { ok: false, name: NAME, reason: `Mantle is still connecting ${NAME}; ${NAME} did not answer` });
  ok(a.reason === 'Mantle is still connecting the device; the device did not answer', `bt: the device name is gone from a failed reason (${a.reason})`);
  const b = await bt(cur, { ok: true, name: NAME, reason: `${NAME} connected` });
  ok(b.reason === `${NAME} connected`, 'bt: a success is left alone');
  const c = await bt(cur, { ok: false, name: 'X', reason: 'X failed' });
  ok(c.reason === 'X failed', 'bt: a one-letter name is not replaced (it would eat letters of the sentence)');
  const d = await bt(cur, { ok: false, name: null, reason: 'Bluetooth is off, so nothing can connect' });
  ok(d.reason === 'Bluetooth is off, so nothing can connect', 'bt: no name, nothing to replace');
  // Security review 2: the REAL busy reply (sidecar/BtDevices.cs Toggle) has no name field and names
  // the OTHER device that is still toggling.
  const busy = await bt(cur, { ok: false, op: 'connect', device: 'BTH-1', reason: `Mantle is still disconnecting ${NAME}; wait for it to finish` });
  ok(busy.reason === 'Mantle is still disconnecting another device; wait for it to finish', `bt: the busy reply (no name field) no longer names the other device (${busy.reason})`);
  const busy2 = await bt(cur, { ok: false, reason: 'Mantle is still connecting another device; wait for it to finish' });
  ok(busy2.reason === 'Mantle is still connecting another device; wait for it to finish', 'bt: the busy reply with no name stays as it was');

  // The coordinator's #19 follow-up: the bar's window entries carry the window's pid (ontop.js refuses
  // a pin whose pid does not match the handle's window or app).
  const gcode = topFunction(SRC, 'function groupRunning(');
  const { groupRunning } = run(gcode, {}, ['groupRunning']);
  const g = groupRunning([{ hwnd: 101, pid: 4321, exe: 'C:\\a.exe', title: 't' }, { hwnd: 102, exe: 'C:\\a.exe' }, { hwnd: 103, pid: 'junk', exe: 'C:\\a.exe' }]);
  const wins = [...g.values()][0].windows;
  ok(wins.map((w) => w.pid).join(',') === '4321,0,0', `groupRunning: each window entry carries its pid, 0 when unknown (${wins.map((w) => w.pid)})`);
  const headCode = HEAD ? topFunction(HEAD, 'async function qsBtToggle(') : null;
  if (headCode) {
    const h = await bt(headCode, { ok: false, name: NAME, reason: `Mantle is still connecting ${NAME}` });
    ok(h.reason.includes(NAME), 'baseline: HEAD\'s qsBtToggle leaks the device name, the fault this pins');
  } else failures.push('baseline: could not read HEAD:main.js qsBtToggle');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  for (const n of notes) console.log('NOTE ' + n);
  for (const f of failures) console.log('FAIL ' + f);
  console.log('MAIN REL TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.log('FAIL the test itself threw: ' + (err && err.stack)); console.log('MAIN REL TEST: ' + passed + ' passed, ' + (failures.length + 1) + ' failed'); process.exit(1); });
