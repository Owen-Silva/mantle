/* search.test.js — lib/features/search.js against a fake ctx (no Electron, no real sidecar).
 * Every action here is a dry run or goes into a fake; nothing opens, launches or copies.
 *   node lib/features/search.test.js
 * PRIVACY: prints counts and pass/fail lines only.
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const feature = require('./search.js');
const { makeCommands, makeRecent, fileScore, plain, JARGON } = feature._internals;

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }

const home = os.homedir();
const REAL = __filename;                                   // a real file inside the profile
const REAL_DIR = __dirname;

function fakeCtx({ test = true, openThrows = null, sidecarAnswer } = {}) {
  const c = {
    commands: {}, chords: {}, logs: [], healths: [], opened: [], sent: [],
    flags: Object.freeze({ test, live: !test }),
    test: test ? {} : null,
    log(t) { c.logs.push(t); },
    command(verb, fn) { c.commands[verb] = fn; return 'search.' + verb; },
    onChord(ch, fn) { c.chords[ch] = fn; return () => {}; },
    health(okv, why) { c.healths.push([okv, why]); },
    host: { openLauncher(a) { if (openThrows) throw new Error(openThrows); c.opened.push(a); return a; } },
    sidecar: {
      send(cmd, args, o) {
        c.sent.push({ cmd, args, o });
        return Promise.resolve(sidecarAnswer ? sidecarAnswer(cmd, args) : { ok: true, result: { ok: true, items: [], ms: 5 } });
      },
      onReady(fn) { fn(); return () => {}; },
      on() { return () => {}; },
    },
  };
  return c;
}

const row = (name, folder, extra) => Object.assign({ path: path.join(folder, name), name, folder, isDir: false, modified: '2026-09-01T00:00:00Z', match: 'prefix' }, extra || {});
const noJargon = (s) => typeof s === 'string' && s.length > 0 && !JARGON.test(s) && !/[A-Z]:\\/.test(s);

(async () => {
  ok(feature.name === 'search' && feature.chords.length === 1 && feature.chords[0] === 'Win+S', 'module: name search, chord Win+S');
  ok(feature.defaultOn === true && /Win\+S/.test(feature.label), 'module: on by default, label names the chord');

  const c = fakeCtx();
  const handle = feature.install(c);
  ok(handle && typeof handle.stop === 'function', 'install returns a stop()');
  ok(['files', 'openFile', 'copy', 'web', 'status'].every(v => typeof c.commands[v] === 'function'), 'registers files/openFile/copy/web/status');
  ok(c.healths.length && c.healths[c.healths.length - 1][0] === true, 'healthy after install');

  // the chord opens the launcher in search mode
  c.chords['Win+S']('Win+S');
  ok(c.opened.length === 1 && c.opened[0].mode === 'search', 'Win+S opens the launcher with mode search');

  // dry runs in --test
  const cp = await c.commands.copy({ expr: '6*7' });
  ok(cp.ok && cp.dryRun && cp.copied === '42', 'copy is a dry run in --test');
  const w = await c.commands.web({ q: 'weather' });
  ok(w.ok && w.dryRun && /google\.com\/search\?q=weather/.test(w.url), 'web is a dry run in --test');
  const w2 = await c.commands.web({ q: 'a&b=c #x' });
  ok(w2.ok && /q=a%26b%3Dc\+%23x$/.test(w2.url), 'web query is URL-encoded (& = # cannot add parameters)');

  // files go to the sidecar's search.files with a ttl, and "cancelled" is a quiet superseded answer
  const f = await c.commands.files({ q: 'report' });
  const sent = c.sent.find(s => s.cmd === 'search.files');
  ok(f.ok && sent && sent.args.q === 'report' && sent.args.ttl > 0 && sent.o.timeoutMs >= 1000 && sent.args.scope === home, 'files asks the sidecar search.files, scoped to the profile, with a ttl');
  const c2 = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files' ? { ok: false, error: 'cancelled' } : { ok: true, result: {} } });
  feature.install(c2);
  const sup = await c2.commands.files({ q: 'report' });
  ok(sup.ok && sup.superseded, 'a cancelled (superseded) query is not an error');

  // ---- HOLE: failure reasons were internals on screen ("the running sidecar was built without ... SearchIndex.cs")
  const errCases = [
    ['unknown command: search.files', /restarted/],
    ['expired: "search.files" waited 5200 ms, past the caller\'s 5000 ms deadline', /too long/],
    ['timeout after 6000 ms', /too long/],
    ['the sidecar is not running (it exited)', /starting up/],
    ['System.Runtime.InteropServices.COMException (0x80004005)', /isn't working/],
  ];
  for (const [err, want] of errCases) {
    const cx = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files' ? { ok: false, error: err } : { ok: true, result: {} } });
    feature.install(cx);
    const r = await cx.commands.files({ q: 'quarterly budget' });
    ok(!r.ok && noJargon(r.reason) && want.test(r.reason), 'a failed call reads as plain words: ' + want);
    ok(cx.logs.every(l => !/quarterly|budget/.test(l)) && cx.logs.some(l => /file search failed: /.test(l)), 'the log names the kind of failure, never the query');
  }
  const cIdx = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files'
    ? { ok: true, result: { ok: false, items: [], reason: 'the Windows Search index did not answer: IErrorInfo.GetDescription failed (HRESULT 0x80040E14)', detail: 'OleDbException' } }
    : { ok: true, result: {} } });
  feature.install(cIdx);
  const ri = await cIdx.commands.files({ q: 'budget' });
  ok(!ri.ok && noJargon(ri.reason), 'an index answer with an HRESULT in it is replaced by plain words');
  const cPlain = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files'
    ? { ok: true, result: { ok: false, items: [], reason: 'Windows Search isn\'t running, so files can\'t be searched.' } } : { ok: true, result: {} } });
  feature.install(cPlain);
  const rp = await cPlain.commands.files({ q: 'budget' });
  ok(!rp.ok && /isn't running/.test(rp.reason), 'an index reason that is already plain words is kept');

  // ---- HOLE: arguments were String()-ed, so an object became "[object Object]" on screen
  const bad1 = await c.commands.files({ q: { toString() { return 'x'; } } });
  ok(!bad1.ok && noJargon(bad1.reason), 'files: a q that is not text is refused in plain words');
  const nSent = c.sent.length;
  const long = await c.commands.files({ q: 'x'.repeat(201) });
  ok(long.ok && long.items.length === 0 && /too long/.test(long.reason) && c.sent.length === nSent, 'files: a 201-char q never reaches the sidecar');
  const short = await c.commands.files({ q: ' a ' });
  ok(short.ok && short.items.length === 0 && c.sent.length === nSent, 'files: one letter never reaches the sidecar');
  const wBad = await c.commands.web({ q: ['x'] });
  ok(!wBad.ok && noJargon(wBad.reason), 'web: a q that is not text is refused in plain words');
  const wLong = await c.commands.web({ q: 'x'.repeat(501) });
  ok(!wLong.ok && /too long/.test(wLong.reason), 'web: over 500 characters is refused');
  const cBad = await c.commands.copy({ expr: { a: 1 } });
  ok(!cBad.ok && noJargon(cBad.reason), 'copy: an expression that is not text is refused in plain words');
  const cLong = await c.commands.copy({ expr: '1+'.repeat(150) + '1' });
  ok(!cLong.ok && /too long/.test(cLong.reason), 'copy: an over-long expression is refused');
  const cNot = await c.commands.copy({ expr: 'require("child_process")' });
  ok(!cNot.ok && !cNot.dryRun, 'copy: text that is not arithmetic is never evaluated or copied');

  // ---- HOLE: openFile opened ANY existing path in the profile a page named (an .exe in Downloads too)
  const cf = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files'
    ? { ok: true, result: { ok: true, ms: 7, items: [row(path.basename(REAL), REAL_DIR)] } } : { ok: true, result: {} } });
  feature.install(cf);
  const notOffered = await cf.commands.openFile({ path: REAL });
  ok(!notOffered.ok && /search results/.test(notOffered.reason), 'openFile refuses a real file no search offered');
  const got = await cf.commands.files({ q: 'search.test' });
  ok(got.ok && got.items.length === 1 && got.items[0].path === REAL, 'files returns the row');
  const opened = await cf.commands.openFile({ path: REAL });
  ok(opened.ok && opened.dryRun, 'openFile opens (dry run) a file the search offered');
  const openedCase = await cf.commands.openFile({ path: REAL.toUpperCase().replace(/^C:/, 'c:'), reveal: true });
  ok(openedCase.ok && openedCase.dryRun, 'show in folder works for the offered file whatever the case of the path');
  const dots = await cf.commands.openFile({ path: path.join(REAL_DIR, '..', 'features', path.basename(REAL)) });
  ok(dots.ok, 'a ".." spelling of the offered path is the same file (normalised first)');
  const sneaky = await cf.commands.openFile({ path: path.join(REAL_DIR, '..', '..', 'package.json') });
  ok(!sneaky.ok && /search results/.test(sneaky.reason), 'a ".." walk to a file never offered is refused');
  for (const p of ['C:\\Windows\\notepad.exe', '\\\\server\\share\\x.txt', '\\\\?\\' + REAL, 'relative\\x.txt', '', REAL + '\0.txt', 42, null]) {
    const r = await cf.commands.openFile({ path: p });
    ok(!r.ok && noJargon(r.reason), 'openFile refuses ' + (typeof p === 'string' ? (p.startsWith('\\\\') ? 'a share/device path' : p === '' ? 'an empty path' : p.indexOf('\0') >= 0 ? 'a NUL in the path' : /^[A-Z]:/.test(p) && !p.startsWith(home) ? 'a path outside the profile' : 'a relative path') : 'a non-text path') + ' in plain words');
  }
  // an offered file that has gone since
  const ghost = row('mantle-ghost-' + Date.now() + '.txt', home);
  const cg = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files' ? { ok: true, result: { ok: true, ms: 1, items: [ghost] } } : { ok: true, result: {} } });
  feature.install(cg);
  await cg.commands.files({ q: 'mantle-ghost' });
  const gone = await cg.commands.openFile({ path: ghost.path });
  ok(!gone.ok && /isn't there any more/.test(gone.reason) && !gone.reason.includes(ghost.path), 'an offered file that is gone says so, without the path');

  // offers expire and are bounded
  let t = 1e6;
  const cmds = makeCommands({ sidecar: async () => ({ ok: true, ms: 1, items: [row(path.basename(REAL), REAL_DIR)] }), dryRun: true, home, now: () => t });
  await cmds.files({ q: 'search' });
  ok((await cmds.openFile({ path: REAL })).ok, 'offer: fresh offer opens');
  t += 31 * 60 * 1000;
  ok(!(await cmds.openFile({ path: REAL })).ok, 'offer: after 30 minutes it must be searched again');
  const many = Array.from({ length: 30 }, (_, i) => row('f' + i + '.txt', home));
  const cmds2 = makeCommands({ sidecar: async () => ({ ok: true, ms: 1, items: many }), dryRun: true, home });
  for (let i = 0; i < 60; i++) await cmds2.files({ q: 'f' + i });
  ok(cmds2._offered.size <= 400, 'offer: the remembered set is capped (' + cmds2._offered.size + ')');

  // ---- ranking: exact > prefix > word start > contains; shorter first in a tier; recent nudged up
  ok(fileScore('notes.txt', 'notes') === 1000, 'rank: the exact name (stem) is 1000');
  ok(fileScore('notes-old.txt', 'notes') > fileScore('old-notes.txt', 'notes'), 'rank: prefix beats a later word');
  ok(fileScore('old-notes.txt', 'notes') > fileScore('footnotes.txt', 'notes'), 'rank: a word start beats a contains');
  ok(fileScore('notes.txt', 'note') > fileScore('notebook-archive-2024.txt', 'note'), 'rank: shorter first inside the prefix tier');
  ok(fileScore('ñandú-notas.pdf', 'notas') > fileScore('anotaciones.pdf', 'notas'), 'rank: word starts work for non-ASCII names');
  const rows = [row('footnotes.txt', home, { match: 'contains' }), row('old-notes.txt', home, { match: 'word' }), row('notes.txt', path.join(home, 'Documents')), row('notes-2.txt', path.join(home, 'Documents'))];
  const cr = makeCommands({ sidecar: async () => ({ ok: true, ms: 3, items: rows }), dryRun: true, home });
  const ranked = await cr.files({ q: 'notes' });
  ok(ranked.items.map(i => i.name).join('|') === 'notes.txt|notes-2.txt|old-notes.txt|footnotes.txt', 'rank: rows come back best-first');
  ok(ranked.items.every(i => i.kind === 'file' && /^file:[0-9a-f]{12}$/.test(i.id) && typeof i.subtitle === 'string' && i.subtitle.startsWith('~') && i.recent === false), 'shape: kind, stable id, ~ subtitle, recent flag');

  // recent: a shortcut in Recent with the row's name AND pointing at the row's path lifts it within its tier
  const recentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-recent-'));
  fs.writeFileSync(path.join(recentDir, 'notes-2.txt.lnk'), '');
  fs.writeFileSync(path.join(recentDir, 'old-notes.txt.lnk'), '');
  const targets = { 'notes-2.txt.lnk': path.join(home, 'Documents', 'notes-2.txt'), 'old-notes.txt.lnk': path.join(home, 'elsewhere', 'old-notes.txt') };
  let reads = 0;
  const recent = makeRecent({ dir: recentDir, readLink: (p) => { reads++; return targets[path.basename(p)]; } });
  const crr = makeCommands({ sidecar: async () => ({ ok: true, ms: 3, items: rows }), dryRun: true, home, recent });
  const rr = await crr.files({ q: 'notes' });
  ok(rr.items.map(i => i.name).join('|') === 'notes.txt|notes-2.txt|old-notes.txt|footnotes.txt', 'recent: never lifts a row over the exact name');
  const rr2 = await crr.files({ q: 'note' });
  ok(rr2.items[0].name === 'notes-2.txt' && rr2.items[0].recent === true, 'recent: the recently opened file leads its tier');
  ok(rr2.items.find(i => i.name === 'old-notes.txt').recent === false, 'recent: a same-named shortcut to ANOTHER path does not count');
  ok(makeRecent({ dir: recentDir, readLink: null })({ name: 'notes-2.txt', path: targets['notes-2.txt.lnk'] }) === false, 'recent: without a shortcut reader nothing is boosted');
  ok(makeRecent({ dir: path.join(recentDir, 'nope'), readLink: () => 'x' })({ name: 'a', path: 'b' }) === false, 'recent: a missing Recent folder is not an error');
  const readsBefore = reads;
  const crr3 = makeCommands({ sidecar: async () => ({ ok: true, ms: 3, items: [row('other.txt', home)] }), dryRun: true, home, recent });
  await crr3.files({ q: 'other' });
  ok(reads === readsBefore, 'recent: shortcuts are read only for rows whose name is in Recent');
  fs.rmSync(recentDir, { recursive: true, force: true });

  // ---- status and the start-up log: plain words, no reason text or path in mantle.log
  const cs = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.status'
    ? { ok: true, result: { ok: false, service: 'Running', scopeIndexed: false, reason: 'Your user folder isn\'t in the Windows Search index. ' + home } }
    : { ok: true, result: {} } });
  feature.install(cs);
  await new Promise(r => setImmediate(r));
  ok(cs.logs.some(l => /^Windows Search: service Running, profile indexed false$/.test(l)), 'start-up log: states only');
  ok(cs.logs.every(l => !l.includes(home) && !/isn't in the/.test(l)), 'start-up log: no reason text, no profile path');
  const st = await cs.commands.status({});
  ok(st.ok === false && /isn't in the Windows Search index/.test(st.reason), 'status: a plain reason is passed through');
  const cs2 = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.status' ? { ok: false, error: 'timeout after 4000 ms' } : { ok: true, result: {} } });
  feature.install(cs2);
  await new Promise(r => setImmediate(r));
  const st2 = await cs2.commands.status({});
  ok(!st2.ok && noJargon(st2.reason), 'status: a failed check reads as plain words');
  ok(cs2.logs.includes('Windows Search status unavailable'), 'start-up log: an unavailable status is logged without its error text');

  // Win+S when the launcher cannot open: unhealthy, with the reason (the chord goes back to Windows)
  const c4 = fakeCtx({ openThrows: 'there is no launcher window to open' });
  feature.install(c4);
  c4.chords['Win+S']('Win+S');
  const last = c4.healths[c4.healths.length - 1];
  ok(last[0] === false && /no launcher window/.test(last[1]), 'a launcher that cannot open makes the feature unhealthy, with why');

  // a live run: copy uses the clipboard given (none outside Electron -> says so, never silent)
  const c5 = fakeCtx({ test: false });
  feature.install(c5);
  const live = await c5.commands.copy({ expr: '1+1' });
  ok(!live.ok && /clipboard/.test(live.reason), 'outside Electron the copy says the clipboard is unreachable');

  ok(plain('the sidecar exploded', 'X') === 'X' && plain('Windows Search is off.', 'X') === 'Windows Search is off.', 'plain(): keeps words, replaces internals');

  for (const x of failures) console.log('  FAIL: ' + x);
  console.log('SEARCH FEATURE TEST: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
