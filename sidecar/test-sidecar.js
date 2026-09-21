// test-sidecar.js - the sidecar's own test harness. Plain node, no deps.
//
//   node sidecar/test-sidecar.js
//
// Every run spawns the sidecar in --passive mode, which is a hard promise that
// NOTHING on the live desktop moves: the taskbar is never hidden, no keyboard
// hook is installed, no window is focused, minimised, closed or reparented, and
// the work area is never touched. The commands that would do those things are
// expected to REFUSE here, and the test asserts that they do - a passive build
// that silently obeyed would be the worst possible bug.
//
// The harness also proves the two ways the sidecar must die on its own: `quit`
// (exit 0) and stdin EOF (gone within 2 s). Those are what stop an orphaned
// sidecar from sitting on the machine holding shell state.
//
// It also holds the line on the 2026-09-21 incident (see Taskbar.cs): the two
// commands that caused it - `taskbar {show:...}` and `workarea {bottom:...}` -
// must answer "removed", in every mode, forever; and the state file the
// recovery script depends on must exist from the first moment of a run.
//
// Prints exactly one summary line and exits non-zero if anything failed.

'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HERE = __dirname;
const EXE = path.join(HERE, 'bin', 'Mantle.Sidecar.exe');
const BUILD = path.join(HERE, 'build.ps1');
// Scratch, not the repo: the state file is a runtime artefact and a test run
// must not leave one lying next to the source.
const STATE = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '.state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; }
}

/**
 * The primary screen's width as a DPI-UNAWARE process sees it. powershell.exe
 * has no DPI manifest, so this is the virtualised number (1536 on this
 * 1920x1080 @ 125% machine) - the yardstick for proving the sidecar is not
 * virtualised any more. Returns null, with the reason printed, if the probe
 * cannot run: a check that cannot be made must fail out loud, not vanish.
 */
function virtualisedScreenWidth() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width'],
      { encoding: 'utf8' });
    const n = parseInt((r.stdout || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

/** The sidecar writes the file just after `ready`, so poll rather than sleep. */
async function waitForState(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const s = readState();
    if (s) { last = s; if (predicate(s)) return s; }
    if (Date.now() >= until) return last;
    await sleep(50);
  }
}

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}

/** A running sidecar, with request/reply correlation over its stdout lines. */
function start(args) {
  const proc = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  let nextId = 1;
  let buf = '';
  let stderr = '';
  let exited = null;

  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  proc.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        events.push({ ev: '__unparseable', line });
        continue;
      }
      if (msg.ev !== undefined) {
        events.push(msg);
        for (let k = eventWaiters.length - 1; k >= 0; k--) {
          if (eventWaiters[k].name === msg.ev) { eventWaiters[k].resolve(msg); eventWaiters.splice(k, 1); }
        }
      } else if (pending.has(msg.id)) {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        done(msg);
      } else {
        events.push({ ev: '__unmatched', msg });
      }
    }
  });

  function send(cmd, extra, timeoutMs) {
    const id = nextId++;
    const req = Object.assign({ id, cmd }, extra || {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no reply to "${cmd}" within ${timeoutMs || 8000}ms`));
      }, timeoutMs || 8000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  function waitEvent(name, timeoutMs) {
    const already = events.find((e) => e.ev === name);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${name}" event within ${timeoutMs}ms`)), timeoutMs);
      eventWaiters.push({ name, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  function waitExit(timeoutMs) {
    if (exited) return Promise.resolve(exited);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`still running after ${timeoutMs}ms`)), timeoutMs);
      proc.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, at: Date.now() }); });
    });
  }

  return { proc, send, waitEvent, waitExit, events, get stderr() { return stderr; } };
}

async function main() {
  if (!fs.existsSync(EXE)) {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUILD], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (!fs.existsSync(EXE)) {
      console.log('SIDECAR TEST: 0 passed, 1 failed');
      console.log('  build did not produce ' + EXE);
      process.exit(1);
    }
  }

  try { fs.unlinkSync(STATE); } catch (e) { /* not there: that is the point */ }
  const s = start(['--passive', '--parent-pid=' + process.pid, '--state-file=' + STATE]);

  // ---- ready ------------------------------------------------------------
  let ready = null;
  try {
    ready = await s.waitEvent('ready', 6000);
  } catch (e) {
    check('ready event', false, e.message);
  }
  if (ready) {
    check('ready event is first and well formed',
      typeof ready.pid === 'number' && ready.passive === true && typeof ready.version === 'string',
      JSON.stringify(ready));
  }

  // ---- ping -------------------------------------------------------------
  try {
    const r = await s.send('ping');
    check('ping ok', r.ok === true, JSON.stringify(r));
    check('ping reports passive + pid + version',
      r.ok && r.result && r.result.passive === true &&
      typeof r.result.pid === 'number' && typeof r.result.version === 'string',
      JSON.stringify(r.result));
    // Physical pixels, because SHAppBarMessage is not DPI-virtualised (see
    // Program.InitDpi). If this ever goes false the app bar lands 200 px off.
    check('ping reports dpiAware:true', r.ok && r.result && r.result.dpiAware === true,
      JSON.stringify(r.result));
  } catch (e) { check('ping', false, e.message); }

  // ---- state file (the recovery note) -----------------------------------
  // Written before anything could have been changed, so a recovery script has
  // the ORIGINAL shell state even if this process is killed a second later.
  {
    const st = await waitForState((v) => v && v.original, 3000);
    check('state file is written at startup', st !== null, 'no file at ' + STATE);
    if (st) {
      check('state file records the original taskbar state',
        st.original && typeof st.original.abmState === 'number',
        JSON.stringify(st.original));
      check('state file records the original work area as four numbers',
        st.original && Array.isArray(st.original.workarea) &&
        st.original.workarea.length === 4 &&
        st.original.workarea.every((n) => typeof n === 'number'),
        JSON.stringify(st.original));
      check('state file starts with restored:false', st.restored === false, JSON.stringify(st));
      check('state file says its numbers are physical pixels', st.units === 'physical', JSON.stringify(st));
      // The real proof that DPI awareness took: a DPI-UNAWARE process on this
      // machine sees a 1536-wide screen, an aware one sees 1920. Equal is fine
      // (100% scale); smaller means we are virtualised again and the app bar
      // would land 200 px off, exactly as it did on 2026-09-21.
      const vw = virtualisedScreenWidth();
      check('state file reads PHYSICAL pixels, not virtualised',
        typeof vw === 'number' && st.original && Array.isArray(st.original.workarea) &&
        st.original.workarea[2] >= vw,
        'workarea right edge ' + (st.original && st.original.workarea ? st.original.workarea[2] : '?') +
        ' vs DPI-unaware screen width ' + vw);
      check('a passive run reports changing nothing',
        st.changed && st.changed.autohide === false &&
        Array.isArray(st.changed.appbars) && st.changed.appbars.length === 0,
        JSON.stringify(st.changed));
    }
  }

  // ---- the forms that caused the 2026-09-21 incident --------------------
  // These are gone from the protocol entirely: the answer says "removed" in
  // every mode, so a caller still sending them cannot mistake it for passive.
  for (const [cmd, extra, what] of [
    ['taskbar', { show: false }, 'taskbar {show:false}'],
    ['workarea', { bottom: 44 }, 'workarea {bottom:44}']
  ]) {
    try {
      const r = await s.send(cmd, extra);
      check(`${what} answers "removed"`,
        r.ok === false && typeof r.error === 'string' && r.error.includes('removed'),
        JSON.stringify(r));
    } catch (e) { check(`${what} answers "removed"`, false, e.message); }
  }

  // ---- windows ----------------------------------------------------------
  try {
    const r = await s.send('windows');
    const list = r.ok ? r.result : [];
    check('windows ok', r.ok === true, JSON.stringify(r).slice(0, 200));
    check('windows returns at least one window', Array.isArray(list) && list.length >= 1,
      'got ' + (Array.isArray(list) ? list.length : typeof list));

    const mine = list.filter((w) => w.pid === process.pid);
    check('windows excludes the parent pid', mine.length === 0,
      mine.length + ' entries had pid ' + process.pid);

    const bad = list.filter((w) =>
      typeof w.hwnd !== 'string' || !/^\d+$/.test(w.hwnd) ||
      typeof w.title !== 'string' || w.title.length === 0 ||
      typeof w.exe !== 'string' ||
      typeof w.pid !== 'number' ||
      typeof w.minimized !== 'boolean' ||
      typeof w.foreground !== 'boolean' ||
      !('icon' in w) || (w.icon !== null && typeof w.icon !== 'string'));
    check('every window entry has the full shape', bad.length === 0,
      bad.length ? JSON.stringify(bad[0]).slice(0, 200) : '');
  } catch (e) { check('windows', false, e.message); }

  // ---- icon -------------------------------------------------------------
  try {
    const r = await s.send('icon', { path: 'C:\\Windows\\explorer.exe' });
    const url = r.ok && r.result ? r.result.icon : null;
    check('icon for explorer.exe is a png data url',
      typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length > 200,
      typeof url === 'string' ? url.slice(0, 40) + ' len=' + url.length : JSON.stringify(r));
  } catch (e) { check('icon', false, e.message); }

  // ---- volume (READ ONLY: never change what Owen is listening to) -------
  try {
    const r = await s.send('volume');
    check('volume reads level + muted',
      r.ok === true && r.result && typeof r.result.level === 'number' &&
      r.result.level >= 0 && r.result.level <= 100 && typeof r.result.muted === 'boolean',
      JSON.stringify(r).slice(0, 200));
  } catch (e) { check('volume', false, e.message); }

  // ---- passive refusals -------------------------------------------------
  const refusals = [
    ['taskbar', { mode: 'autohide' }],
    ['taskbar', { restore: true }],
    ['appbar', { hwnd: '1', edge: 'bottom', size: 44 }],
    ['appbar', { hwnd: '1', remove: true }],
    ['workarea', { reset: true }],
    ['desktop', { hwnd: '1' }],
    ['hotkey', { winTap: true }],
    ['focus', { hwnd: '1' }]
  ];
  const REFUSAL = 'refused: sidecar is passive (test mode)';
  for (const [cmd, extra] of refusals) {
    const what = `${cmd} ${JSON.stringify(extra)}`;
    try {
      const r = await s.send(cmd, extra);
      check(`${what} refused in passive`, r.ok === false && r.error === REFUSAL, JSON.stringify(r));
    } catch (e) { check(`${what} refused in passive`, false, e.message); }
  }

  // ---- unknown command --------------------------------------------------
  try {
    const r = await s.send('nonsense-command');
    check('unknown cmd answers ok:false with a reason',
      r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
  } catch (e) { check('unknown cmd', false, e.message); }

  // ---- tray (informational; a refusal with a reason is a valid outcome) --
  let trayNote = '';
  try {
    const r = await s.send('tray', {}, 12000);
    if (r.ok) {
      trayNote = `tray: ${r.result.length} icon(s)`;
      check('tray answers with a list or a reason', Array.isArray(r.result), JSON.stringify(r).slice(0, 160));
    } else {
      trayNote = 'tray: ' + r.error;
      check('tray answers with a list or a reason',
        typeof r.error === 'string' && r.error.startsWith('tray unavailable:'), JSON.stringify(r));
    }
  } catch (e) { check('tray', false, e.message); trayNote = 'tray: ' + e.message; }

  // ---- unsolicited windows event ----------------------------------------
  try {
    const ev = await s.waitEvent('windows', 5000);
    check('an unsolicited windows event arrives', Array.isArray(ev.list), JSON.stringify(ev).slice(0, 120));
  } catch (e) { check('an unsolicited windows event arrives', false, e.message); }

  // ---- quit -------------------------------------------------------------
  try {
    const r = await s.send('quit');
    check('quit is acknowledged', r.ok === true, JSON.stringify(r));
    // The restore path says out loud what it put back, in plain words.
    const rev = await s.waitEvent('restore', 4000);
    check('quit emits a restore event with a spoken detail',
      typeof rev.done === 'boolean' && typeof rev.detail === 'string' && rev.detail.length > 0,
      JSON.stringify(rev));
    const ex = await s.waitExit(4000);
    check('quit exits with code 0', ex.code === 0, 'exit code ' + ex.code);
  } catch (e) { check('quit', false, e.message); try { s.proc.kill(); } catch (_) {} }

  // The note a recovery script would read AFTER Mantle is gone must say the
  // shell was handed back.
  {
    const st = await waitForState((v) => v && v.restored === true, 3000);
    check('state file ends with restored:true', st !== null && st.restored === true,
      st ? JSON.stringify(st) : 'no file at ' + STATE);
  }

  // ---- stdin EOF, and a run with NO state file --------------------------
  // No --state-file is legal, but it must SAY so: nothing fails silently.
  const s2 = start(['--passive', '--parent-pid=' + process.pid]);
  try {
    await s2.waitEvent('ready', 6000);
    const warn = await s2.waitEvent('log', 3000);
    check('a run without --state-file warns that recovery cannot know the original state',
      warn.level === 'warn' && typeof warn.message === 'string' && warn.message.includes('--state-file'),
      JSON.stringify(warn));
    const t0 = Date.now();
    s2.proc.stdin.end();
    const ex = await s2.waitExit(2000);
    check('stdin EOF exits within 2s', ex.code === 0, 'exit code ' + ex.code + ' after ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    check('stdin EOF exits within 2s', false, e.message);
    try { s2.proc.kill(); } catch (_) {}
  }

  try { fs.unlinkSync(STATE); } catch (e) { /* already gone */ }

  for (const f of failures) console.log('  FAIL: ' + f);
  if (trayNote) console.log('  note: ' + trayNote);
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  FAIL: harness crashed: ' + (e && e.stack ? e.stack : e));
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length + 1} failed`);
  process.exit(1);
});
