'use strict';
/*
 * call-log.test.js - lib/call-log.js: a repeated failure is one line, a button press always is.
 *
 *   node lib/call-log.test.js
 *
 * The case it was written for (2026-09-23): desktop.js's net.probe of Mission Control, refused
 * every 30 s, wrote 436 identical lines to the log in a morning. Prints one summary line; exits 1
 * if anything failed.
 */
const { createCallLog, createSetLog } = require('./call-log');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}

const PROBE = { url: 'http://127.0.0.1:7373/api/health' };
const REFUSED = { ok: false, reason: 'connect ECONNREFUSED 127.0.0.1:7373' };

// ---- the net.probe storm
{
  const lines = [];
  const log = createCallLog({ write: (l) => lines.push(l) });
  for (let i = 0; i < 436; i++) log.result('net.probe', PROBE, REFUSED);
  check('436 identical failures are one line', lines.length === 1, JSON.stringify(lines));
  check('the line names the command, its arguments and the reason',
    /^mantle: net\.probe \{"url":"http:\/\/127\.0\.0\.1:7373\/api\/health"\} -> connect ECONNREFUSED/.test(lines[0]), lines[0]);
  log.result('net.probe', PROBE, { ok: true, status: 200 });
  check('the recovery is written, with the count', lines.length === 2 && /recovered after 436 failure\(s\) in a row/.test(lines[1]), lines[1]);
  check('and names the failure it recovered from', /ECONNREFUSED/.test(lines[1] || ''), lines[1]);
  log.result('net.probe', PROBE, { ok: true, status: 200 });
  check('a success after a success writes nothing', lines.length === 2, JSON.stringify(lines));
  log.result('net.probe', PROBE, REFUSED);
  check('failing again after the recovery is a new line', lines.length === 3, JSON.stringify(lines));
  check('nothing is held once it has recovered and failed afresh', log.openCount() === 1);
}

// ---- a different reason is news
{
  const lines = [];
  const log = createCallLog({ write: (l) => lines.push(l) });
  log.result('net.probe', PROBE, REFUSED);
  log.result('net.probe', PROBE, REFUSED);
  log.result('net.probe', PROBE, REFUSED);
  log.result('net.probe', PROBE, { ok: false, reason: 'timed out after 2000 ms' });
  check('a new reason is written', lines.length === 2, JSON.stringify(lines));
  check('with how often the previous one failed', /timed out after 2000 ms \(before this, "connect ECONNREFUSED 127\.0\.0\.1:7373" failed 3 time\(s\) in a row\)/.test(lines[1] || ''), lines[1]);
  log.result('net.probe', PROBE, { ok: false, reason: 'timed out after 2000 ms' });
  check('and that one repeating is quiet again', lines.length === 2);
}

// ---- keys: the same command with other arguments is another failure
{
  const lines = [];
  const log = createCallLog({ write: (l) => lines.push(l) });
  log.result('net.probe', PROBE, REFUSED);
  log.result('net.probe', { url: 'http://127.0.0.1:9999/' }, REFUSED);
  check('different arguments are separate failures', lines.length === 2, JSON.stringify(lines));
  log.result('net.probe', { url: 'http://127.0.0.1:9999/' }, { ok: true });
  check('and recover separately', lines.length === 3 && /9999/.test(lines[2]) && log.openCount() === 1, JSON.stringify(lines));
  log.result('app.launch', null, { ok: false, reason: 'no such app' });
  check('a command with no arguments has no trailing blank', lines[3] === 'mantle: app.launch -> no such app', lines[3]);
}

// ---- throws are failures too, and skip() is honoured
{
  const lines = [];
  const log = createCallLog({ write: (l) => lines.push(l), skip: (n) => /^(state|sys)\./.test(n) || n === 'qs.set' });
  log.threw('media.get', null, new Error('the sidecar is down'));
  log.threw('media.get', null, new Error('the sidecar is down'));
  check('a repeated throw is one line', lines.length === 1 && /media\.get -> threw: the sidecar is down/.test(lines[0]), JSON.stringify(lines));
  log.result('media.get', null, { ok: true });
  check('and recovers like any failure', lines.length === 2 && /recovered after 2 failure/.test(lines[1]), lines[1]);
  log.result('sys.stats', null, { ok: false, reason: 'x' });
  log.result('state.get', null, { ok: false, reason: 'x' });
  log.result('qs.set', { part: 'wifi', value: true }, { ok: false, reason: 'x' });
  check('skipped commands write nothing (qs.set logs itself)', lines.length === 2, JSON.stringify(lines));
  log.threw('sys.stats', null, new Error('WMI timed out'));
  check('a skipped command that THROWS is still written', lines.length === 3 && /sys\.stats -> threw: WMI timed out/.test(lines[2]), JSON.stringify(lines));
  lines.pop();
  log.result('media.get', null, { ok: false });
  check('ok:false with no reason says so', /-> ok:false, no reason given$/.test(lines[2] || ''), lines[2]);
}

// ---- the held set is bounded
{
  const lines = [];
  const log = createCallLog({ write: (l) => lines.push(l), maxKeys: 5 });
  for (let i = 0; i < 20; i++) log.result('net.probe', { url: 'u' + i }, REFUSED);
  check('at most maxKeys failures are held', log.openCount() === 5, String(log.openCount()));
}

// ---- qs.set: every press is a line; a drag is its first line plus one summary
{
  const lines = [];
  let timers = [];
  const setLog = createSetLog({
    write: (l) => lines.push(l),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  const fire = () => { const ts = timers; timers = []; ts.forEach((t) => t.fn()); };

  setLog.record('wifi', true, { ok: true, value: true }, 260);
  setLog.record('wifi', false, { ok: false, value: true, reason: 'Windows refused to switch the Wi-Fi radio (error 5: access denied)' }, 31);
  check('a toggle is written every time, with its latency', lines.length === 2 && lines[0] === 'mantle: qs.set wifi=true -> ok, reads true (260 ms)', JSON.stringify(lines));
  check('a refusal is written with its reason', /qs\.set wifi=false -> NOT DONE: Windows refused to switch the Wi-Fi radio \(error 5: access denied\) \(31 ms\)$/.test(lines[1]), lines[1]);

  lines.length = 0;
  setLog.record('brightness', 40, { ok: true, value: 40 }, 52);
  for (let v = 39; v >= 12; v--) setLog.record('brightness', v, { ok: true, value: v }, 7 + (v % 5) * 10);
  check('a drag writes its first set at once', lines.length === 1 && /brightness=40 -> ok, reads 40 \(52 ms\)/.test(lines[0]), JSON.stringify(lines));
  fire();
  check('and one summary when it stops', lines.length === 2 && /brightness: 28 more while it was dragged, the last 12 \(reads 12\), all ok, 7-47 ms each/.test(lines[1]), lines[1]);

  lines.length = 0;
  setLog.record('volume', 30, { ok: true, value: 30 }, 3);
  setLog.record('volume', 31, { ok: true, value: 31 }, 2);
  setLog.record('volume', 32, { ok: false, value: 31, reason: 'the volume could not be changed: the sidecar is restarting' }, 4000);
  check('a failure mid-drag flushes the drag, then is its own line', lines.length === 3 &&
    /volume: 1 more while it was dragged, the last 31/.test(lines[1]) && /volume=32 -> NOT DONE: the volume could not be changed/.test(lines[2]), JSON.stringify(lines));
  fire();
  check('nothing is left to summarise after a failure', lines.length === 3, JSON.stringify(lines));

  lines.length = 0;
  setLog.record('volume', 50, { ok: true, value: 50 }, 3);
  fire();
  check('a single slider set is one line, no empty summary', lines.length === 1, JSON.stringify(lines));
  setLog.record('mute', true, { ok: true, value: true }, 3);
  setLog.record('mute', true, { ok: true, value: true }, 3);
  check('mute is a button: every press is a line', lines.length === 3, JSON.stringify(lines));
  setLog.record('nosuch', 1, { ok: false, reason: 'qs.set does not know the part "nosuch"' }, 0);
  check('an unknown part is written too', /qs\.set nosuch=1 -> NOT DONE: qs\.set does not know the part/.test(lines[3] || ''), lines[3]);
  setLog.record('brightness', 70, { ok: true, value: 70 }, 9);
  setLog.record('brightness', 71, { ok: true, value: 71 }, 9);
  setLog.flushAll();
  check('flushAll writes a pending summary (for quit)', /brightness: 1 more while it was dragged, the last 71/.test(lines[lines.length - 1]), lines[lines.length - 1]);
}

for (const f of failures) console.log('FAIL ' + f);
console.log('CALL LOG TEST: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
