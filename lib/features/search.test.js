/* search.test.js — lib/features/search.js against a fake ctx (no Electron, no real sidecar).
 * Every action here is a dry run or goes into a fake; nothing opens, launches or copies.
 *   node lib/features/search.test.js
 */
'use strict';
const feature = require('./search.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }

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
  const home = require('os').homedir();
  const of = await c.commands.openFile({ path: require('path').join(home, 'no-such-file-mantle-test.txt') });
  ok(!of.ok && /gone from disk/.test(of.reason), 'openFile checks the path before anything (a missing file is refused)');
  const outside = await c.commands.openFile({ path: 'C:\\Windows\\notepad.exe' });
  ok(!outside.ok && /only opens files inside/.test(outside.reason), 'openFile refuses a path outside the profile');

  // files go to the sidecar's search.files with a ttl, and "cancelled" is a quiet superseded answer
  const f = await c.commands.files({ q: 'report' });
  const sent = c.sent.find(s => s.cmd === 'search.files');
  ok(f.ok && sent && sent.args.q === 'report' && sent.args.ttl > 0 && sent.o.timeoutMs >= 1000, 'files asks the sidecar search.files, with a ttl');
  const c2 = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files' ? { ok: false, error: 'cancelled' } : { ok: true, result: {} } });
  feature.install(c2);
  const sup = await c2.commands.files({ q: 'report' });
  ok(sup.ok && sup.superseded, 'a cancelled (superseded) query is not an error');
  const c3 = fakeCtx({ sidecarAnswer: (cmd) => cmd === 'search.files' ? { ok: false, error: 'unknown command: search.files' } : { ok: true, result: {} } });
  feature.install(c3);
  const old = await c3.commands.files({ q: 'report' });
  ok(!old.ok && /SearchIndex\.cs/.test(old.reason), 'an old sidecar without search.files says to rebuild it');

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

  for (const x of failures) console.log('  FAIL: ' + x);
  console.log('SEARCH FEATURE TEST: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
