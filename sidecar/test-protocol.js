// test-protocol.js - the sidecar's wire protocol at its edges (core quality pass, 2026-09-29).
//
//   node sidecar/test-protocol.js [--exe=<path>]
//
// test-sidecar.js proves every command does its job; this file proves the pipe itself cannot
// be used to crash the sidecar, wedge it, make it lie, or make it touch a window that is not
// Mantle's. Each block below was written against the pre-fix sidecar and failed there first
// (MATRIX.md, lane core-sc, has the before/after lines).
//
// ALWAYS passive, like every sidecar test. The only window any check here restyles or moves is
// one this test creates itself in a throwaway PowerShell process, never shown on screen.
// Prints one summary line: "PROTOCOL TEST: n passed, m failed".
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');

const EXE = T.exePath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write a raw line and wait for the next reply that carries no id we sent (id null). */
async function raw(s, line, timeoutMs) {
  const before = s.events.length;
  s.proc.stdin.write(line + '\n');
  const until = Date.now() + (timeoutMs || 4000);
  while (Date.now() < until) {
    for (let i = before; i < s.events.length; i++) {
      const e = s.events[i];
      if (e.ev === '__unmatched' && e.msg && e.msg.id === null) return e.msg;
    }
    await sleep(10);
  }
  return null;
}

/** A hidden top-level window owned by ANOTHER process (never shown). Resolves {hwnd, stop}. */
function foreignWindow() {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.Form',
    '$f.ShowInTaskbar = $false',
    '$f.StartPosition = "Manual"',
    '$f.Location = New-Object System.Drawing.Point(-32000, -32000)',
    '[Console]::Out.WriteLine([string]$f.Handle.ToInt64())',
    '[Console]::Out.Flush()',
    '[Console]::In.ReadLine() | Out-Null',
  ].join('; ');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve({ hwnd: null, stop: () => { try { p.kill(); } catch (_) {} } }), 15000);
    p.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const m = /(\d+)\r?\n/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ hwnd: m[1], pid: p.pid, stop: () => { try { p.stdin.end(); } catch (_) {} setTimeout(() => { try { p.kill(); } catch (_) {} }, 500); } });
      }
    });
  });
}

/** Posts one window message from a separate process, the way Windows' session manager would. */
function postMessage(hwnd, msg, wParam, lParam) {
  const ps = 'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);\'; ' +
    '[W.U]::PostMessageW([System.IntPtr]' + hwnd + ', ' + msg + ', [System.IntPtr]' + wParam + ', [System.IntPtr]' + lParam + ')';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return (r.stdout || '').trim();
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

(async () => {
  const t = T.checker('PROTOCOL');
  if (!fs.existsSync(EXE)) { console.log('  no exe at ' + EXE); process.exit(t.summary()); }

  // ------------------------------------------------------------------ the reader
  let s = await T.startPassive();
  // A block that killed the sidecar (the pre-fix build) must not take the rest of the file with it.
  const ensure = async () => { if (s.proc.exitCode !== null || s.proc.signalCode !== null) { t.fail('the sidecar was dead at the start of a block', 'restarted'); s = await T.startPassive(); } };
  {
    // A request nested 200,000 deep used to overflow the reader's stack: an uncatchable
    // StackOverflowException that killed the sidecar with no restore at all.
    const deep = '{"cmd":"ping","x":' + '['.repeat(200000) + '}';
    const r = await raw(s, deep, 5000);
    const alive = await s.send('ping', {}, 4000).catch(() => null);
    t.check('a request nested 200,000 deep is refused and the sidecar lives',
      r && r.ok === false && /too deeply nested/.test(r.error || '') && alive && alive.ok === true,
      JSON.stringify(r).slice(0, 200) + ' alive=' + !!(alive && alive.ok));
  }
  await ensure();
  {
    const r = await raw(s, '{"cmd":"ping","x":"\\u 12a"}');
    t.check('a \\u escape must be exactly four hex digits', r && r.ok === false && /escape/.test(r.error || ''), JSON.stringify(r));
    const bad = [];
    for (const n of ['+1', '01', '.5', '1.', '-', '1e', '1e+', '--1', '1.2.3']) {
      const q = await raw(s, '{"cmd":"ping","x":' + n + '}');
      if (!(q && q.ok === false && /number/.test(q.error || ''))) bad.push(n + '=' + JSON.stringify(q));
    }
    t.check('numbers follow JSON grammar (+1, 01, .5, 1., -, 1e, --1 are refused)', bad.length === 0, bad.join(' '));
    const good = await s.send('selftest', { op: 'getint', v: -12.5e1 }, 3000);
    t.check('a valid exponent number still parses', good.ok && good.result.v === -125, JSON.stringify(good));
  }
  await ensure();
  {
    // A line over the cap is refused without being parsed; the next line is served.
    const huge = '{"cmd":"ping","pad":"' + 'x'.repeat(17 * 1024 * 1024) + '"}';
    const r = await raw(s, huge, 15000);
    const alive = await s.send('ping', {}, 5000).catch(() => null);
    t.check('a 17 MB line is refused as over the line cap, and the next request is served',
      r && r.ok === false && /line cap/.test(r.error || '') && alive && alive.ok === true,
      JSON.stringify(r).slice(0, 200));
  }

  await ensure();
  // ------------------------------------------------------------------ the writer
  {
    const r = await s.send('selftest', { op: 'echo', value: 'a\ud800b\udc00c\u0001 ' }, 3000);
    t.check('lone surrogates and control characters round-trip exactly',
      r.ok && r.result.value === 'a\ud800b\udc00c\u0001 ', JSON.stringify(r));
    const u = await s.send('x\udfff', {}, 3000);
    t.check('an error that quotes the request keeps a lone surrogate intact', u.ok === false && u.error.endsWith('x\udfff'), JSON.stringify(u));
    const pair = await s.send('selftest', { op: 'echo', value: 'emoji 😀 ok' }, 3000);
    t.check('a real surrogate pair (emoji) round-trips', pair.ok && pair.result.value === 'emoji 😀 ok', JSON.stringify(pair));
  }
  await ensure();
  {
    const before = s.events.filter((e) => e.ev === '__unparseable').length;
    const got = [];
    for (const num of ['NaN', 'Infinity', '-Infinity']) {
      got.push(await s.send('selftest', { op: 'echo', num }, 3000).catch((e) => ({ timeout: e.message })));
    }
    const after = s.events.filter((e) => e.ev === '__unparseable').length;
    t.check('NaN and Infinity are written as null, never as text JSON cannot read',
      after === before && got.every((r) => r.ok === true && r.result.num === null), JSON.stringify(got));
  }
  await ensure();
  {
    const r = await s.send('selftest', { op: 'unwritable' }, 3000).catch((e) => ({ timeout: e.message }));
    t.check('a result that cannot be written still answers its caller (with an error)',
      r.ok === false && /could not be written/.test(r.error || ''), JSON.stringify(r));
  }
  await ensure();
  {
    const cases = [[1e12, 2147483647], [-1e12, -2147483648], [2147483647, 2147483647], ['abc', -1], [3.5, 4]];
    const bad = [];
    for (const [v, want] of cases) {
      const r = await s.send('selftest', { op: 'getint', v }, 3000);
      if (!(r.ok && r.result.v === want)) bad.push(v + '->' + JSON.stringify(r.result));
    }
    t.check('integer arguments clamp to the int range instead of wrapping', bad.length === 0, bad.join(' '));
  }

  await ensure();
  // ------------------------------------------------------------------ lanes
  {
    // Park the slow lane, then flood it. The queue is bounded: the overflow is told "busy"
    // straight away instead of piling up without limit.
    const park = s.send('sleep', { lane: 'slow', ms: 3000 }, 30000);
    await sleep(100);
    const flood = [];
    for (let i = 0; i < 1100; i++) flood.push(s.send('sleep', { lane: 'slow', ms: 0 }, 30000).catch((e) => ({ timeout: e.message })));
    const t0 = Date.now();
    const rs = await Promise.all(flood);
    await park;
    const busy = rs.filter((r) => r.ok === false && /busy/.test(r.error || '')).length;
    const ok = rs.filter((r) => r.ok === true).length;
    t.check('a flooded worker lane answers the overflow "busy" and serves the rest',
      busy > 0 && ok >= 1000 && busy + ok === 1100, 'busy=' + busy + ' ok=' + ok + ' in ' + (Date.now() - t0) + ' ms');
    const ping = await s.send('ping', {}, 4000);
    t.check('the ui lane is untouched by a flooded worker lane', ping.ok === true, JSON.stringify(ping).slice(0, 120));
  }
  await ensure();
  {
    const park = s.send('sleep', { lane: 'ui', ms: 3000 }, 30000);
    await sleep(100);
    const flood = [];
    for (let i = 0; i < 1100; i++) flood.push(s.send('selftest', { op: 'getint', v: i }, 30000).catch((e) => ({ timeout: e.message })));
    const rs = await Promise.all(flood);
    await park;
    const busy = rs.filter((r) => r.ok === false && /busy/.test(r.error || '')).length;
    const ok = rs.filter((r) => r.ok === true).length;
    t.check('a flooded ui lane answers the overflow "busy" and serves the rest',
      busy > 0 && ok >= 1000 && busy + ok === 1100, 'busy=' + busy + ' ok=' + ok);
  }

  await ensure();
  // ------------------------------------------------------------------ state note
  {
    const r = await s.send('selftest', { op: 'stateRace', threads: 8, writes: 40 }, 30000);
    const st = readState(s.stateFile);
    t.check('the state note written from 8 threads at once: no failed write, file still whole JSON',
      r.ok && r.result.errors === 0 && st && st.original && typeof st.restored === 'boolean',
      JSON.stringify(r.result) + ' file=' + (st ? 'ok' : 'unreadable'));
  }

  await ensure();
  // ------------------------------------------------------------------ ownership
  let selfHwnd = null;
  try { selfHwnd = (await s.send('ping', {}, 4000)).result.selfHwnd; } catch (_) {}
  const fw = await foreignWindow();
  if (!fw.hwnd) {
    t.check('a foreign test window could be created', false, 'powershell gave no hwnd');
  } else {
    const box = { x: -32000, y: -32000, w: 50, h: 50 };
    const tries = [
      ['glass', { hwnd: fw.hwnd, mode: 'acrylic' }],
      ['corners', { hwnd: fw.hwnd, mode: 'round' }],
      ['region', { hwnd: fw.hwnd, r: 8 }],
      ['morph', { hwnd: fw.hwnd, from: box, to: box, ms: 0 }],
      ['place', { hwnd: fw.hwnd, x: -32000, y: -32000, w: 60, h: 60 }],
      ['traywatch', { hwnd: fw.hwnd }],
    ];
    const bad = [];
    for (const [cmd, a] of tries) {
      const r = await s.send(cmd, a, 4000).catch((e) => ({ timeout: e.message }));
      if (!(r.ok === false && /not one of Mantle's own windows/.test(r.error || ''))) bad.push(cmd + '=' + JSON.stringify(r).slice(0, 140));
    }
    t.check('glass, corners, region, morph, place and traywatch refuse another app\'s window', bad.length === 0, bad.join(' | '));
    const own = await s.send('corners', { hwnd: selfHwnd, mode: 'round' }, 4000).catch((e) => ({ timeout: e.message }));
    t.check('the same commands still act on Mantle\'s own window', own.ok === true, JSON.stringify(own).slice(0, 160));
    fw.stop();
  }

  // ------------------------------------------------------------------ resources
  // A fresh sidecar: the block above wedged the pre-fix build's ui lane for good.
  await s.stop();
  s = await T.startPassive();
  try { selfHwnd = (await s.send('ping', {}, 4000)).result.selfHwnd; } catch (_) {}
  try {
    const round = async (i) => {
      await s.send('backdrop', { x: 0, y: 0, w: 64, h: 32, scale: 4 }, 4000);
      await s.send('corners', { hwnd: selfHwnd, mode: i % 2 ? 'round' : 'none' }, 4000);
      await s.send('region', { hwnd: selfHwnd, r: i % 2 ? 8 : 0 }, 4000);
      await s.send('glass', { hwnd: selfHwnd, mode: i % 2 ? 'acrylic' : 'off' }, 4000);
      await s.send('hittest', { x: 5, y: 5 }, 4000);
      await s.send('foreground', {}, 4000);
    };
    // Warm-up first: the first calls load DLLs, start the lane threads' COM and cache a DC,
    // which is growth once, not a leak. The measured stretch must then stay flat.
    // The sidecar's own start-up (Quick Settings warm-up, the window watcher) also grows handles
    // for its first seconds (+69 in 3 s idle, then flat: probed 2026-09-29), so wait for two
    // reads a second apart to agree before the baseline.
    for (let i = 0; i < 30; i++) await round(i);
    let r0 = (await s.send('selftest', { op: 'resources' }, 3000)).result;
    for (let k = 0; k < 10; k++) {
      await sleep(1000);
      const again = (await s.send('selftest', { op: 'resources' }, 3000)).result;
      const same = again.handles === r0.handles && again.user === r0.user && again.gdi === r0.gdi;
      r0 = again;
      if (same) break;
    }
    for (let i = 0; i < 150; i++) {
      if (s.proc.exitCode !== null) break;
      await round(i);
    }
    const r1 = (await s.send('selftest', { op: 'resources' }, 3000)).result;
    t.check('150 rounds of backdrop/corners/region/glass/hittest/foreground leak no GDI or USER objects',
      r1.gdi - r0.gdi <= 2 && r1.user - r0.user <= 2, JSON.stringify({ before: r0, after: r1 }));
    t.check('...and no kernel handles', r1.handles - r0.handles <= 16, JSON.stringify({ before: r0.handles, after: r1.handles }));
  } catch (e) { t.fail('resource rounds', e.message); }
  await s.stop();

  // ------------------------------------------------------------------ dying well
  {
    // Two background threads throw at once. The first starts the restore; the second must
    // not let the runtime tear the process down underneath it.
    const x = await T.startPassive();
    const r = await x.send('selftest', { op: 'throw', count: 2 }, 3000);
    let ex = null;
    try { ex = await x.waitExit(6000); } catch (_) {}
    const st = readState(x.stateFile);
    const restore = x.events.find((e) => e.ev === 'restore');
    t.check('two background threads throwing at once: the sidecar restores, notes restored:true and exits 1',
      r.ok && ex && ex.code === 1 && st && st.restored === true && restore && restore.done === true,
      'exit=' + JSON.stringify(ex) + ' restored=' + (st && st.restored) + ' restoreEv=' + !!restore);
  }
  {
    // WM_ENDSESSION (sign-out / shut down): a winexe gets no console signal, only this message.
    const x = await T.startPassive();
    const hw = (await x.send('ping', {}, 4000)).result.selfHwnd;
    const posted = postMessage(hw, 0x16, 1, 0x80000000);   // ENDSESSION_LOGOFF
    let ex = null;
    try { ex = await x.waitExit(5000); } catch (_) {}
    const st = readState(x.stateFile);
    t.check('sign-out (WM_ENDSESSION) restores, notes restored:true and exits 0',
      posted === 'True' && ex && ex.code === 0 && st && st.restored === true,
      'posted=' + posted + ' exit=' + JSON.stringify(ex) + ' restored=' + (st && st.restored));
    if (!ex) await x.stop();
  }
  {
    // A cancelled sign-out (wParam FALSE) must change nothing.
    const x = await T.startPassive();
    const hw = (await x.send('ping', {}, 4000)).result.selfHwnd;
    postMessage(hw, 0x16, 0, 0);
    await sleep(600);
    const alive = await x.send('ping', {}, 3000).catch(() => null);
    t.check('a cancelled sign-out (WM_ENDSESSION false) keeps the sidecar running', alive && alive.ok === true, '');
    await x.stop();
  }

  // ------------------------------------------------------------------ session sleep
  {
    const x = await T.startPassive();
    const a = await x.send('session', { action: 'sleep', simulate: true, delayMs: 300 }, 4000);
    const b = await x.send('session', { action: 'sleep', simulate: true, delayMs: 300 }, 4000);
    await sleep(1600);   // past the 300 ms delay, the 200 ms stand-in and the 1 s repeat guard
    const c = await x.send('session', { action: 'sleep', simulate: true, delayMs: 0 }, 4000);
    t.check('a second Sleep while one is on its way is not a second suspend',
      a.ok && a.result.ok === true && a.result.simulated === true &&
      b.ok && b.result.ok === true && b.result.already === true &&
      c.ok && c.result.ok === true && !c.result.already,
      JSON.stringify([a.result, b.result, c.result]).slice(0, 400));
    const real = await x.send('session', { action: 'sleep' }, 4000);
    t.check('passive still refuses a real sleep', real.ok && real.result.ok === false && /passive/.test(real.result.reason || ''), JSON.stringify(real));
    await x.stop();
  }

  process.exit(t.summary());
})().catch((e) => { console.log('PROTOCOL TEST: crashed: ' + (e && e.stack || e)); process.exit(1); });
