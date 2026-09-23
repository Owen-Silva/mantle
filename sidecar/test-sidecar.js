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
// Which exe to test. Default: the one Mantle runs. A running Mantle holds that
// file open, so a new build is made beside it (build.ps1 -Out ...) and tested
// by path:  node sidecar/test-sidecar.js --exe=sidecar/bin-next/Mantle.Sidecar.exe
//      or:  MANTLE_SIDECAR_EXE=... npm run test:sidecar
// A custom exe is never auto-built: testing a stale file by accident is worse
// than failing to find one.
const EXE_ARG = (process.argv.find((a) => a.startsWith('--exe=')) || '').slice('--exe='.length) ||
                process.env.MANTLE_SIDECAR_EXE || '';
const EXE = EXE_ARG ? path.resolve(EXE_ARG) : path.join(HERE, 'bin', 'Mantle.Sidecar.exe');
const BUILD = path.join(HERE, 'build.ps1');
// Scratch, not the repo: the state file is a runtime artefact and a test run
// must not leave one lying next to the source.
const STATE = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '.state.json');
const STATE_EOF = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '.eof.state.json');
// A shortcut of our own, in scratch, for `lnk`. Writing one .lnk in the temp
// folder is the only thing this suite creates on the machine, and it is
// deleted again at the end: the real Start menu is read, never written.
const LNK = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '.lnk');
const LNK_MISSING = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '-not-here.lnk');
// A second shortcut that points at a SHELL FOLDER (This PC) rather than a file.
// Links like this store an item list and no path at all - Owen's pinned File
// Explorer is one - and they are the reason `lnk` reads the IDList.
const LNK_SHELL = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '-shell.lnk');
const THIS_PC = '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file || STATE, 'utf8')); } catch (e) { return null; }
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

/**
 * Write one throwaway .lnk with the shell's own shortcut writer (WScript.Shell
 * is what every installer uses), so `lnk` is tested against a REAL shortcut
 * rather than bytes we made up. Returns null on success or the reason, which
 * the caller reports as a failure - a check that cannot run must say so.
 */
function makeShortcut() {
  // Both shortcuts in ONE powershell start: the machine is busy and a process
  // launch is the most expensive thing this suite does.
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$w = New-Object -ComObject WScript.Shell;` +
      `$s = $w.CreateShortcut('${LNK}');` +
      `$s.TargetPath = 'C:\\Windows\\explorer.exe';` +
      `$s.Arguments = '/root,C:\\';` +
      `$s.WorkingDirectory = 'C:\\Windows';` +
      `$s.IconLocation = 'C:\\Windows\\explorer.exe,3';` +
      `$s.Save();` +
      `$p = $w.CreateShortcut('${LNK_SHELL}');` +
      `$p.TargetPath = '${THIS_PC}';` +
      `$p.Save()`], { encoding: 'utf8' });
    if (!fs.existsSync(LNK)) return 'powershell did not write it: ' + ((r.stderr || r.stdout || '').trim() || 'no output');
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * The real pinned "File Explorer" shortcut, if this machine has one. It is the
 * link that motivated the IDList path - read-only, never written - and it is a
 * smoke check, not a requirement: a machine without the pin just prints a note.
 */
function findExplorerPin() {
  const appdata = process.env.APPDATA || '';
  if (!appdata) return null;
  const candidates = [
    path.join(appdata, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'File Explorer.lnk'),
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'System Tools', 'File Explorer.lnk'),
    path.join(appdata, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'File Explorer.lnk')
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}

/**
 * The REAL taskbar pin list, base64 of HKCU\...\Taskband\Favorites. Read-only,
 * and it is the only way to test `pins` against the thing it exists for.
 * Returns null with the reason printed if the value cannot be read.
 */
function favoritesBlobBase64() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "$b=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband'" +
      " -Name Favorites -ErrorAction Stop).Favorites; [Convert]::ToBase64String($b)"], { encoding: 'utf8' });
    const b64 = (r.stdout || '').replace(/\s+/g, '');
    return b64.length > 100 ? b64 : null;
  } catch (e) {
    return null;
  }
}

/** The sidecar writes the file just after `ready`, so poll rather than sleep. */
async function waitForState(predicate, timeoutMs, file) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const s = readState(file);
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
  if (EXE_ARG && !fs.existsSync(EXE)) {
    console.log('SIDECAR TEST: 0 passed, 1 failed');
    console.log('  no exe at ' + EXE + ' (--exe / MANTLE_SIDECAR_EXE); build it with build.ps1 -Out');
    process.exit(1);
  }
  if (EXE_ARG) console.log('testing ' + EXE);
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
  let selfHwnd = null;
  try {
    const r = await s.send('ping');
    if (r.ok && r.result) selfHwnd = r.result.selfHwnd;
    check('ping ok', r.ok === true, JSON.stringify(r));
    check('ping reports passive + pid + version',
      r.ok && r.result && r.result.passive === true &&
      typeof r.result.pid === 'number' && typeof r.result.version === 'string',
      JSON.stringify(r.result));
    // Physical pixels, because SHAppBarMessage is not DPI-virtualised (see
    // Program.InitDpi). If this ever goes false the app bar lands 200 px off.
    check('ping reports dpiAware:true', r.ok && r.result && r.result.dpiAware === true,
      JSON.stringify(r.result));
    // The one window the sidecar owns, so `glass` has something safe to aim at.
    check('ping reports selfHwnd as a decimal string',
      typeof selfHwnd === 'string' && /^\d+$/.test(selfHwnd) && selfHwnd !== '0',
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
  let windowsAppNote = '';
  let pinsNote = '';
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

    // exe + pid are what the launcher groups by and what `lnk` targets are
    // matched against, so they are checked by name and not only as part of the
    // shape above. An empty exe is legal (an elevated process denies us the
    // query), a MISSING one is not.
    const noId = list.filter((w) => !('exe' in w) || typeof w.exe !== 'string' ||
                                    !('pid' in w) || typeof w.pid !== 'number' || w.pid <= 0);
    check('every window entry carries exe and pid', noId.length === 0,
      noId.length ? JSON.stringify(noId[0]).slice(0, 200) : '');

    // The identity a pin can be matched against. An exe path cannot group
    // Discord (Update.exe pinned, Discord.exe running), Edge, or any Store app;
    // an AUMID can. Both keys are always present, null for a plain Win32 app.
    const noApp = list.filter((w) =>
      !('aumid' in w) || (w.aumid !== null && typeof w.aumid !== 'string') ||
      !('host' in w) || (w.host !== null && w.host !== 'frame'));
    check('every window entry carries aumid and host', noApp.length === 0,
      noApp.length ? JSON.stringify(noApp[0]).slice(0, 200) : '');

    // A UWP window must NOT report ApplicationFrameHost.exe: the whole point of
    // the frame lookup is that the window says which app it really is.
    const frames = list.filter((w) => w.host === 'frame');
    check('a framed (UWP) window reports the app, not ApplicationFrameHost',
      frames.every((w) => w.exe === '' || !/ApplicationFrameHost\.exe$/i.test(w.exe)),
      JSON.stringify(frames.map((w) => ({ title: w.title, exe: w.exe, aumid: w.aumid }))).slice(0, 220));
    windowsAppNote = 'windows: ' + list.length + ' listed, ' +
      list.filter((w) => w.aumid).length + ' with an aumid, ' + frames.length + ' framed (UWP)';
  } catch (e) { check('windows', false, e.message); }

  // ---- icon -------------------------------------------------------------
  try {
    const r = await s.send('icon', { path: 'C:\\Windows\\explorer.exe' });
    const url = r.ok && r.result ? r.result.icon : null;
    check('icon for explorer.exe is a png data url',
      typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length > 200,
      typeof url === 'string' ? url.slice(0, 40) + ' len=' + url.length : JSON.stringify(r));
  } catch (e) { check('icon', false, e.message); }

  // ---- lnk --------------------------------------------------------------
  // Printed at the end: what the two shortcut shapes actually resolved to, so
  // a run says out loud what lane A will be handed rather than only pass/fail.
  let shellLnkNote = '';
  let explorerPinNote = '';
  // Read-only, so it runs in passive: the shortcut is opened STGM_READ and the
  // one .lnk involved is ours, in scratch. Both paths go in ONE call on
  // purpose - the missing one must come back ok:false WITHOUT costing the good
  // one its answer, because the launcher scans hundreds at a time.
  {
    const why = makeShortcut();
    check('a test shortcut can be created', why === null, why || '');
    if (why === null) {
      try {
        const r = await s.send('lnk', { paths: [LNK, LNK_MISSING] });
        const items = r.ok && r.result ? r.result.items : null;
        check('lnk answers with one item per path',
          r.ok === true && Array.isArray(items) && items.length === 2,
          JSON.stringify(r).slice(0, 200));
        if (Array.isArray(items) && items.length === 2) {
          const it = items[0];
          check('lnk resolves the target of a real shortcut',
            it.ok === true && typeof it.target === 'string' &&
            it.target.toLowerCase().endsWith('\\explorer.exe'),
            JSON.stringify(it).slice(0, 220));
          check('lnk returns the arguments and working directory',
            typeof it.args === 'string' && it.args.indexOf('/root') === 0 &&
            typeof it.workdir === 'string' && it.workdir.toLowerCase().endsWith('windows'),
            JSON.stringify(it).slice(0, 220));
          check('lnk returns the icon location and index',
            typeof it.iconPath === 'string' && it.iconPath.toLowerCase().endsWith('\\explorer.exe') &&
            it.iconIndex === 3,
            JSON.stringify(it).slice(0, 220));
          // A classic shortcut has no App User Model ID; the FIELD must still
          // be there, because a Store pin is the only thing that fills it and
          // the caller must not have to guard for its absence.
          check('lnk always reports an aumid field (null for a classic shortcut)',
            'aumid' in it && (it.aumid === null || typeof it.aumid === 'string'),
            JSON.stringify(it).slice(0, 220));
          // iconPng is what a launcher actually draws, so it is on EVERY item
          // - a data URL when the shell gave us a picture, null when it did
          // not, never absent.
          check('lnk returns a ready-to-draw iconPng',
            'iconPng' in it && typeof it.iconPng === 'string' &&
            it.iconPng.startsWith('data:image/png;base64,') && it.iconPng.length > 200,
            typeof it.iconPng === 'string' ? it.iconPng.slice(0, 40) + ' len=' + it.iconPng.length
                                           : JSON.stringify(it).slice(0, 220));

          const gone = items[1];
          check('lnk answers a missing path with ok:false and a reason',
            gone.ok === false && typeof gone.reason === 'string' && gone.reason.length > 0 &&
            gone.path === LNK_MISSING,
            JSON.stringify(gone).slice(0, 220));
        }
      } catch (e) { check('lnk', false, e.message); }
    }

    // ---- a shortcut with NO file target (the pinned-File-Explorer shape) ----
    // GetPath answers "" for these; everything the caller can use comes from
    // the item list. Without that fallback the launcher shows a blank tile.
    if (fs.existsSync(LNK_SHELL)) {
      try {
        const r = await s.send('lnk', { paths: [LNK_SHELL] });
        const it = r.ok && r.result && r.result.items ? r.result.items[0] : null;
        shellLnkNote = it ? 'shell-folder lnk: target=' + JSON.stringify(it.target) +
                            ' iconPng=' + (typeof it.iconPng === 'string' ? it.iconPng.length + ' chars' : String(it.iconPng))
                          : 'shell-folder lnk: ' + JSON.stringify(r).slice(0, 120);
        check('lnk resolves a shortcut that has no file target',
          it !== null && it.ok === true && typeof it.target === 'string' && it.target.length > 0,
          JSON.stringify(it).slice(0, 220));
        check('lnk gives that shortcut an icon from its item list',
          it !== null && (it.iconPng === null || typeof it.iconPng === 'string'),
          JSON.stringify(it).slice(0, 220));
      } catch (e) { check('lnk resolves a shortcut that has no file target', false, e.message); }
    } else {
      shellLnkNote = 'shell-folder lnk: powershell would not write one, so the IDList path was ' +
                     'only exercised against the real pin below';
    }

    // The real thing, read-only: the pin that made this necessary.
    const pin = findExplorerPin();
    if (pin) {
      try {
        const r = await s.send('lnk', { paths: [pin] });
        const it = r.ok && r.result && r.result.items ? r.result.items[0] : null;
        explorerPinNote = 'File Explorer pin: ok=' + (it ? it.ok : '?') +
                          ' target=' + JSON.stringify(it ? it.target : null) +
                          ' aumid=' + JSON.stringify(it ? it.aumid : null) +
                          ' iconPng=' + (it && typeof it.iconPng === 'string' ? it.iconPng.length + ' chars' : String(it && it.iconPng));
        check('the real pinned File Explorer shortcut resolves to something launchable',
          it !== null && it.ok === true &&
          ((typeof it.target === 'string' && it.target.length > 0) || typeof it.aumid === 'string'),
          JSON.stringify(it).slice(0, 220));
      } catch (e) { check('the real pinned File Explorer shortcut resolves', false, e.message); }
    } else {
      explorerPinNote = 'File Explorer pin: not on this machine, so it was not read';
    }

    try {
      const r = await s.send('lnk', {});
      check('lnk without paths says what it needs',
        r.ok === false && typeof r.error === 'string' && r.error.includes('paths'), JSON.stringify(r));
    } catch (e) { check('lnk without paths says what it needs', false, e.message); }
  }

  // ---- keys -------------------------------------------------------------
  // The allow-list is answered BEFORE passive (see Program.Run): "win+x is not
  // a combo this command sends" is true in every mode.
  try {
    const r = await s.send('keys', { combo: 'win+x' });
    check('keys win+x answers "combo not allowed"',
      r.ok === false && r.error === 'combo not allowed', JSON.stringify(r));
  } catch (e) { check('keys win+x answers "combo not allowed"', false, e.message); }

  // And an ALLOWED combo must still be refused here: a test run may never type
  // into the live desktop.
  for (const combo of ['win+a', 'win+n', 'win+d']) {
    try {
      const r = await s.send('keys', { combo });
      check(`keys ${combo} is refused in passive, with a reason`,
        r.ok === false && typeof r.error === 'string' &&
        r.error.includes('passive') && r.error.includes(combo),
        JSON.stringify(r));
    } catch (e) { check(`keys ${combo} is refused in passive`, false, e.message); }
  }

  try {
    const r = await s.send('keys', {});
    check('keys without a combo says which three it takes',
      r.ok === false && typeof r.error === 'string' && r.error.includes('win+a'), JSON.stringify(r));
  } catch (e) { check('keys without a combo says which three it takes', false, e.message); }

  // ---- foreground -------------------------------------------------------
  try {
    const r = await s.send('foreground');
    const f = r.ok ? r.result : null;
    check('foreground reports hwnd, rect and a fullscreen boolean',
      r.ok === true && f && typeof f.hwnd === 'string' && /^\d+$/.test(f.hwnd) &&
      Array.isArray(f.rect) && f.rect.length === 4 && f.rect.every((n) => typeof n === 'number') &&
      typeof f.fullscreen === 'boolean',
      JSON.stringify(r).slice(0, 220));
    check('foreground reports a title and an exe as strings',
      r.ok === true && f && typeof f.title === 'string' && typeof f.exe === 'string',
      JSON.stringify(f).slice(0, 220));
  } catch (e) { check('foreground', false, e.message); }

  // ---- traywatch --------------------------------------------------------
  // Pointed at the sidecar's OWN hidden window - never anyone else's, and
  // never the taskbar. The subscribe emits the tray's state straight away,
  // which is also how this test learns the taskbar's hwnd without spawning
  // anything: it is in the event.
  let trayHwnd = null;
  if (selfHwnd) {
    try {
      const r = await s.send('traywatch', { hwnd: selfHwnd });
      check('traywatch subscribes to the sidecar\'s own window',
        r.ok === true && r.result && r.result.ok === true, JSON.stringify(r));
      const ev = await s.waitEvent('tray', 3000);
      check('traywatch emits a tray event with visible + rect',
        ev && ev.event === 'tray' && typeof ev.visible === 'boolean' &&
        Array.isArray(ev.rect) && ev.rect.length === 4,
        JSON.stringify(ev).slice(0, 200));
      if (ev && typeof ev.tray === 'string' && /^\d+$/.test(ev.tray) && ev.tray !== '0') trayHwnd = ev.tray;
    } catch (e) { check('traywatch on the sidecar\'s own window', false, e.message); }

    // The refusal that keeps the 2026-09-21 incident from happening again:
    // traywatch RAISES the window it is given, so it may never be given the
    // taskbar.
    if (trayHwnd) {
      try {
        const r = await s.send('traywatch', { hwnd: trayHwnd });
        check('traywatch refuses Shell_TrayWnd itself',
          r.ok === false && typeof r.error === 'string' && r.error.includes('taskbar'),
          JSON.stringify(r));
      } catch (e) { check('traywatch refuses Shell_TrayWnd itself', false, e.message); }
    } else {
      check('traywatch refuses Shell_TrayWnd itself', false,
        'the tray event did not carry a taskbar hwnd, so the refusal could not be tested');
    }

    try {
      const r = await s.send('traywatch', { hwnd: null });
      check('traywatch with hwnd:null unsubscribes',
        r.ok === true && r.result && r.result.ok === true && r.result.watching === false,
        JSON.stringify(r));
    } catch (e) { check('traywatch with hwnd:null unsubscribes', false, e.message); }
  } else {
    check('traywatch on the sidecar\'s own window', false, 'ping did not report selfHwnd');
  }

  // ---- corners ----------------------------------------------------------
  // Aimed at the sidecar's own hidden window, like `glass`: DWM rounds one
  // window's frame and the attribute dies with the window, so there is nothing
  // for passive mode to protect.
  if (selfHwnd) {
    for (const mode of ['round', 'roundsmall', 'none', 'default']) {
      try {
        const r = await s.send('corners', { hwnd: selfHwnd, mode });
        check(`corners ${mode} applies to the sidecar's own window`,
          r.ok === true && r.result && r.result.ok === true &&
          r.result.used === mode && r.result.mode === mode,
          JSON.stringify(r));
      } catch (e) { check(`corners ${mode}`, false, e.message); }
    }

    // The Windows 11 window border: a 1 px outline OUTSIDE the client area,
    // rounded by DWM rather than by the page, which is why it showed up around
    // the 24 px CSS pill. Removing it is a separate attribute from the corner
    // preference, and the two do not share a fate.
    try {
      const r = await s.send('corners', { hwnd: selfHwnd, mode: 'none', border: 'none' });
      check('corners can remove the Windows 11 window border',
        r.ok === true && r.result && r.result.used === 'none' && r.result.border === 'none',
        JSON.stringify(r));
      if (r.ok && r.result && r.result.borderReason) {
        cornersNote = 'corners border: ' + r.result.borderReason;
      }
    } catch (e) { check('corners can remove the Windows 11 window border', false, e.message); }

    try {
      const r = await s.send('corners', { hwnd: selfHwnd, mode: 'round' });
      check('corners leaves the border alone when border is omitted',
        r.ok === true && r.result && r.result.border === null, JSON.stringify(r));
    } catch (e) { check('corners leaves the border alone when border is omitted', false, e.message); }

    try {
      const r = await s.send('corners', { hwnd: selfHwnd, mode: 'round', border: 'invisible' });
      check('corners refuses an unknown border value',
        r.ok === false && typeof r.error === 'string' && r.error.includes('border'), JSON.stringify(r));
    } catch (e) { check('corners refuses an unknown border value', false, e.message); }

    // Put the sidecar's own window back the way Windows had it.
    try { await s.send('corners', { hwnd: selfHwnd, mode: 'default', border: 'default' }); } catch (e) { /* best effort */ }
  }

  try {
    const r = await s.send('corners', { hwnd: selfHwnd || '1', mode: 'bevelled' });
    check('corners refuses an unknown mode with a reason',
      r.ok === false && typeof r.error === 'string' && r.error.includes('round'), JSON.stringify(r));
  } catch (e) { check('corners refuses an unknown mode with a reason', false, e.message); }

  try {
    const r = await s.send('corners', { hwnd: '1', mode: 'round' });
    check('corners refuses a hwnd that is not a window',
      r.ok === false && typeof r.error === 'string' && r.error.includes('no longer exists'),
      JSON.stringify(r));
  } catch (e) { check('corners refuses a hwnd that is not a window', false, e.message); }

  if (trayHwnd) {
    try {
      const r = await s.send('corners', { hwnd: trayHwnd, mode: 'round' });
      check('corners refuses the Windows taskbar',
        r.ok === false && typeof r.error === 'string' && r.error.includes('taskbar'), JSON.stringify(r));
    } catch (e) { check('corners refuses the Windows taskbar', false, e.message); }
  }

  // ---- app / pins / launch ----------------------------------------------
  // The AUMID layer: the only way to see a Store pin (5 of Owen's 14 have no
  // .lnk at all) or to group a UWP window under it.
  try {
    const r = await s.send('app', { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
    const d = r.ok ? r.result : null;
    const b64 = d && typeof d.iconPng === 'string' ? d.iconPng.replace('data:image/png;base64,', '') : '';
    let magic = '';
    try { magic = Buffer.from(b64, 'base64').slice(0, 8).toString('hex'); } catch (e) { magic = 'undecodable'; }
    check('app resolves a Store app id to a name and a png',
      r.ok === true && d && d.ok === true && typeof d.name === 'string' && d.name.length > 0 &&
      magic === '89504e470d0a1a0a',
      'name=' + (d && d.name) + ' magic=' + magic + ' ' + JSON.stringify(r).slice(0, 120));
  } catch (e) { check('app resolves a Store app id', false, e.message); }

  try {
    const r = await s.send('app', { aumid: 'Not.A.Real.App_0000000000000!App' });
    check('app answers an unknown id with ok:false and the HRESULT',
      r.ok === true && r.result && r.result.ok === false &&
      typeof r.result.reason === 'string' && r.result.reason.includes('HRESULT'),
      JSON.stringify(r).slice(0, 200));
  } catch (e) { check('app answers an unknown id with ok:false', false, e.message); }

  {
    const blob = favoritesBlobBase64();
    check('the real Taskband\\Favorites blob can be read for the test', blob !== null,
      'reg read produced nothing');
    if (blob) {
      try {
        const r = await s.send('pins', { blob }, 20000);
        const d = r.ok ? r.result : null;
        const items = d && Array.isArray(d.items) ? d.items : [];
        check('pins parses the real taskbar pin list',
          r.ok === true && d && d.ok === true && items.length >= 1,
          JSON.stringify(r).slice(0, 200));
        check('pins finds both Store apps and .lnk pins',
          items.filter((it) => it.kind === 'app').length >= 1 &&
          items.filter((it) => it.kind === 'lnk').length >= 1,
          items.map((it) => it.kind).join(','));
        check('every pin carries the full shape',
          items.every((it) => typeof it.index === 'number' && typeof it.name === 'string' &&
                              typeof it.parsing === 'string' && 'aumid' in it && 'lnk' in it &&
                              'iconPng' in it),
          JSON.stringify(items[0] || null).slice(0, 220));
        pinsNote = 'pins (' + items.length + ', format ' + (d && d.format) + ', skipped ' +
          (d && d.skipped) + '): ' +
          items.map((it) => it.name + '[' + it.kind + (it.iconPng ? '+icon' : '') + ']').join(', ');
      } catch (e) { check('pins parses the real taskbar pin list', false, e.message); }
    }

    // Garbage must be an ANSWER, never a crash and never an invented pin.
    try {
      const junk = Buffer.from('not a pidl at all, just text'.repeat(8)).toString('base64');
      const r = await s.send('pins', { blob: junk });
      check('pins answers garbage without crashing',
        r.ok === true && r.result &&
        (r.result.ok === false || r.result.skipped > 0 || r.result.items.length === 0),
        JSON.stringify(r).slice(0, 200));
    } catch (e) { check('pins answers garbage without crashing', false, e.message); }

    try {
      const r = await s.send('pins', { blob: 'not base64 !!' });
      check('pins refuses a blob that is not base64',
        r.ok === false && typeof r.error === 'string' && r.error.includes('base64'), JSON.stringify(r));
    } catch (e) { check('pins refuses a blob that is not base64', false, e.message); }
  }

  // launch ACTS, so passive refuses it - and nothing in this suite ever starts
  // an app on Owen's desktop.
  try {
    const r = await s.send('launch', { aumid: 'Not.A.Real.App_0000000000000!App' });
    check('launch is refused in passive, with a reason',
      r.ok === false && typeof r.error === 'string' &&
      r.error.includes('passive') && r.error.includes('launch'),
      JSON.stringify(r));
  } catch (e) { check('launch is refused in passive', false, e.message); }

  const quickNotes = [];
  let hitNote = '';
  // ---- the quick settings panel -----------------------------------------
  // Reads only. NOTHING in this block may toggle a radio or move the
  // brightness on the machine Owen is sitting at: every switch is expected to
  // REFUSE, and that refusal is the test.
  // wifi, bluetooth and brightness answer from a background-refreshed cache
  // (QuickSettings.cs): the first read right after start may be a placeholder
  // with pending:true while the real read runs. Poll past it, and prove on
  // the way that even that first answer was instant.
  async function settledRead(cmd, maxMs) {
    const t0 = Date.now();
    let first = null;
    for (;;) {
      const a0 = Date.now();
      const r = await s.send(cmd, {}, 4000);
      if (first === null) first = Date.now() - a0;
      if (!r.ok || !r.result || r.result.pending !== true || Date.now() - t0 > maxMs) return { r, firstMs: first };
      await sleep(250);
    }
  }
  for (const cmd of ['wifi', 'bluetooth', 'brightness']) {
    try {
      const { r, firstMs } = await settledRead(cmd, 25000);
      check(cmd + ' read answers from its cache without waiting on the hardware (' + firstMs + ' ms)',
        firstMs < 1000, 'first answer took ' + firstMs + ' ms');
      check(cmd + ' read settles to a real reading with its age',
        r.ok === true && r.result && r.result.pending !== true && typeof r.result.ageMs === 'number' &&
        typeof r.result.stale === 'boolean', JSON.stringify(r).slice(0, 220));
    } catch (e) { check(cmd + ' read settles to a real reading', false, e.message); }
  }

  try {
    const r = await s.send('wifi', {}, 10000);
    const d = r.ok ? r.result : null;
    check('wifi reads with the full shape',
      r.ok === true && d && d.ok === true &&
      typeof d.present === 'boolean' && typeof d.on === 'boolean' &&
      typeof d.connected === 'boolean' && (d.ssid === null || typeof d.ssid === 'string') &&
      typeof d.signal === 'number' && d.signal >= 0 && d.signal <= 100 &&
      (d.band === null || typeof d.band === 'string') &&
      (d.reason === null || typeof d.reason === 'string'),
      JSON.stringify(r).slice(0, 220));
    if (d) quickNotes.push('wifi: present=' + d.present + ' on=' + d.on + ' connected=' + d.connected +
      ' ssid=' + JSON.stringify(d.ssid) + ' signal=' + d.signal + ' band=' + JSON.stringify(d.band) +
      (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
  } catch (e) { check('wifi reads with the full shape', false, e.message); }

  try {
    const r = await s.send('bluetooth', {}, 20000);
    const d = r.ok ? r.result : null;
    check('bluetooth reads with the full shape',
      r.ok === true && d && typeof d.ok === 'boolean' && typeof d.present === 'boolean' &&
      typeof d.on === 'boolean' && typeof d.via === 'string' &&
      (d.reason === null || typeof d.reason === 'string'),
      JSON.stringify(r).slice(0, 220));
    // Before 2026-09-22 the PowerShell route never loaded
    // System.Runtime.WindowsRuntime, so a machine WITH a radio always read
    // "Windows listed no Bluetooth radio". A present radio must now be read.
    check('bluetooth reads the radio when the machine has one',
      d && (d.present === false || d.ok === true), JSON.stringify(d));
    if (d) quickNotes.push('bluetooth: present=' + d.present + ' on=' + d.on + ' via=' + d.via +
      (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
  } catch (e) { check('bluetooth reads with the full shape', false, e.message); }

  try {
    const r = await s.send('brightness', {}, 15000);
    const d = r.ok ? r.result : null;
    check('brightness reads with the full shape',
      r.ok === true && d && d.ok === true && typeof d.present === 'boolean' &&
      typeof d.level === 'number' && d.level >= 0 && d.level <= 100 &&
      (d.reason === null || typeof d.reason === 'string'),
      JSON.stringify(r).slice(0, 220));
    // present:false is the EXPECTED answer on a desktop without DDC/CI, and it
    // must come with a reason the panel can show.
    check('brightness explains itself when there is no controllable backlight',
      d && (d.present === true || (typeof d.reason === 'string' && d.reason.length > 0)),
      JSON.stringify(d));
    if (d) quickNotes.push('brightness: present=' + d.present + ' level=' + d.level +
      (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
  } catch (e) { check('brightness reads with the full shape', false, e.message); }

  try {
    const r = await s.send('nightlight');
    const d = r.ok ? r.result : null;
    check('nightlight reads with the full shape',
      r.ok === true && d && typeof d.ok === 'boolean' && typeof d.present === 'boolean' &&
      typeof d.on === 'boolean' && (d.reason === null || typeof d.reason === 'string'),
      JSON.stringify(r).slice(0, 220));
    if (d) quickNotes.push('nightlight: present=' + d.present + ' on=' + d.on +
      (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
  } catch (e) { check('nightlight reads with the full shape', false, e.message); }

  try {
    const r = await s.send('power');
    const d = r.ok ? r.result : null;
    check('power reads with the full shape',
      r.ok === true && d && d.ok === true && typeof d.onBattery === 'boolean' &&
      (d.percent === null || typeof d.percent === 'number') &&
      (d.minutesLeft === null || typeof d.minutesLeft === 'number') &&
      typeof d.saver === 'boolean' && (d.reason === null || typeof d.reason === 'string'),
      JSON.stringify(r).slice(0, 220));
    if (d) quickNotes.push('power: onBattery=' + d.onBattery + ' percent=' + d.percent +
      ' minutesLeft=' + d.minutesLeft + ' saver=' + d.saver +
      (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
  } catch (e) { check('power reads with the full shape', false, e.message); }

  // Every switch, refused - and the refusal must SAY it is passive.
  for (const [cmd, extra] of [
    ['wifi', { on: true }],
    ['wifi', { on: false }],
    ['bluetooth', { on: true }],
    ['brightness', { level: 50 }]
  ]) {
    try {
      const r = await s.send(cmd, extra);
      check(`${cmd} ${JSON.stringify(extra)} is refused in passive, with a reason`,
        r.ok === false && typeof r.error === 'string' && r.error.includes('passive'), JSON.stringify(r));
    } catch (e) { check(`${cmd} ${JSON.stringify(extra)} refused in passive`, false, e.message); }
  }

  // A switch argument must be a real boolean: coercing 'maybe' to false would
  // turn someone's Wi-Fi OFF.
  for (const [cmd, extra, what] of [
    ['wifi', { on: 'maybe' }, "wifi {on:'maybe'}"],
    ['bluetooth', { on: 1 }, 'bluetooth {on:1}'],
    ['brightness', { level: 'bright' }, "brightness {level:'bright'}"],
    ['brightness', { level: 500 }, 'brightness {level:500}']
  ]) {
    try {
      const r = await s.send(cmd, extra);
      check(`${what} is refused as a bad argument`,
        r.ok === false && typeof r.error === 'string' && !r.error.includes('passive'), JSON.stringify(r));
    } catch (e) { check(`${what} is refused as a bad argument`, false, e.message); }
  }

  // The two things Mantle is honest about not being able to do yet.
  for (const [cmd, extra] of [['nightlight', { on: true }], ['power', { saver: true }]]) {
    try {
      const r = await s.send(cmd, extra);
      check(`${cmd} says plainly that the switch is not available yet`,
        r.ok === true && r.result && r.result.ok === false &&
        typeof r.result.reason === 'string' && r.result.reason.includes('not available yet'),
        JSON.stringify(r));
    } catch (e) { check(`${cmd} says the switch is not available yet`, false, e.message); }
  }

  // ---- backdrop ---------------------------------------------------------
  // Read-only, so it runs in passive: a 64x16 grab of the very top-left corner
  // is the cheapest thing on the screen and tells us nothing about anyone.
  let cornersNote = '';
  let backdropNote = '';
  try {
    const r = await s.send('backdrop', { x: 0, y: 0, w: 64, h: 16, scale: 1 });
    const d = r.ok ? r.result : null;
    const b64 = d && typeof d.png === 'string' ? d.png.replace('data:image/png;base64,', '') : '';
    // Decoded, not just prefix-matched: a truncated or mislabelled blob would
    // pass a header check and fail in the browser.
    let magic = '';
    try { magic = Buffer.from(b64, 'base64').slice(0, 8).toString('hex'); } catch (e) { magic = 'undecodable'; }
    check('backdrop returns a png that actually decodes',
      r.ok === true && d && typeof d.png === 'string' &&
      d.png.startsWith('data:image/png;base64,') && b64.length > 100 &&
      magic === '89504e470d0a1a0a',
      'magic=' + magic + ' len=' + b64.length + ' ' + JSON.stringify(r).slice(0, 120));
    check('backdrop at scale 1 keeps the asked-for size',
      d && d.w === 64 && d.h === 16 && d.scale === 1 && typeof d.ms === 'number' && d.ms >= 0,
      JSON.stringify(d && { w: d.w, h: d.h, scale: d.scale, ms: d.ms }));
    if (d) backdropNote = 'backdrop: 64x16 at scale 1 took ' + d.ms + 'ms, ' + b64.length + ' base64 chars';
  } catch (e) { check('backdrop', false, e.message); }

  try {
    const r = await s.send('backdrop', { x: 0, y: 0, w: 64, h: 16, scale: 4 });
    const d = r.ok ? r.result : null;
    check('backdrop at scale 4 downscales by exactly 4',
      r.ok === true && d && d.w === 16 && d.h === 4 && d.scale === 4 &&
      typeof d.png === 'string' && d.png.startsWith('data:image/png;base64,'),
      JSON.stringify(d && { w: d.w, h: d.h, scale: d.scale }));
  } catch (e) { check('backdrop at scale 4', false, e.message); }

  try {
    const r = await s.send('backdrop', { x: 0, y: 0, w: 64, h: 16, scale: 99 });
    check('backdrop clamps scale to 8',
      r.ok === true && r.result && r.result.scale === 8 && r.result.w === 8 && r.result.h === 2,
      JSON.stringify(r.result && { w: r.result.w, h: r.result.h, scale: r.result.scale }));
  } catch (e) { check('backdrop clamps scale to 8', false, e.message); }

  for (const [rect, what] of [
    [{ x: 200000, y: 200000, w: 64, h: 16 }, 'a rect past the edge of the desktop'],
    [{ x: 0, y: 0, w: 0, h: 16 }, 'a zero width']
  ]) {
    try {
      const r = await s.send('backdrop', rect);
      check(`backdrop refuses ${what}`,
        r.ok === false && typeof r.error === 'string' && r.error.includes('backdrop'), JSON.stringify(r));
    } catch (e) { check(`backdrop refuses ${what}`, false, e.message); }
  }

  // ---- edgeclip ---------------------------------------------------------
  // The command that confines the POINTER, so passive refuses it outright and
  // the only thing a test run may exercise is the arithmetic: dryRun answers
  // with the rect it WOULD set and touches nothing.
  for (const extra of [{ on: true, inset: 2 }, { on: false }]) {
    try {
      const r = await s.send('edgeclip', extra);
      check(`edgeclip ${JSON.stringify(extra)} is refused in passive, with a reason`,
        r.ok === false && typeof r.error === 'string' &&
        r.error.includes('passive') && r.error.includes('cursor'),
        JSON.stringify(r));
    } catch (e) { check(`edgeclip ${JSON.stringify(extra)} refused in passive`, false, e.message); }
  }

  try {
    const r = await s.send('edgeclip', { dryRun: true, inset: 2 });
    const d = r.ok ? r.result : null;
    check('edgeclip dryRun answers without applying anything',
      r.ok === true && d && d.dryRun === true && d.applied === false &&
      Array.isArray(d.rect) && d.rect.length === 4 && Array.isArray(d.monitor) &&
      typeof d.monitors === 'number' && d.monitors >= 1,
      JSON.stringify(r).slice(0, 220));
    // THE GEOMETRY, checked as pure arithmetic: the clip is the monitor rect
    // with ONLY the bottom pulled in, by exactly the inset.
    check('edgeclip takes the inset off the bottom edge and nothing else',
      d && d.inset === 2 &&
      d.rect[0] === d.monitor[0] && d.rect[1] === d.monitor[1] && d.rect[2] === d.monitor[2] &&
      d.rect[3] === d.monitor[3] - 2,
      JSON.stringify(d));
  } catch (e) { check('edgeclip dryRun', false, e.message); }

  // The clamp, at both ends: an inset of 0 would not keep the taskbar down and
  // one of 99 would fence the cursor a long way up the screen.
  for (const [asked, want] of [[0, 1], [-5, 1], [99, 8], [8, 8], [1, 1]]) {
    try {
      const r = await s.send('edgeclip', { dryRun: true, inset: asked });
      const d = r.ok ? r.result : null;
      check(`edgeclip clamps inset ${asked} to ${want}`,
        d && d.inset === want && d.rect[3] === d.monitor[3] - want, JSON.stringify(d));
    } catch (e) { check(`edgeclip clamps inset ${asked}`, false, e.message); }
  }

  try {
    const r = await s.send('edgeclip', {});
    check('edgeclip without on: says what it needs',
      r.ok === false && typeof r.error === 'string' && r.error.includes('on:true'), JSON.stringify(r));
  } catch (e) { check('edgeclip without on: says what it needs', false, e.message); }

  // ---- morph + region ---------------------------------------------------
  // Driven against the sidecar's own hidden window, which is never visible and
  // never in the window list: the animation is real, the desktop sees nothing.
  if (selfHwnd) {
    const A = { x: 120, y: 120, w: 480, h: 320, r: 0 };
    const B = { x: 160, y: 150, w: 560, h: 380, r: 12 };
    const C = { x: 200, y: 180, w: 600, h: 400, r: 16 };
    const box = (b) => [b.x, b.y, b.x + b.w, b.y + b.h];

    try {
      const r = await s.send('morph', { hwnd: selfHwnd, from: A, to: B, ms: 120, ease: [0.2, 0, 0, 1] });
      check('morph replies only after the animation has landed',
        r.ok === true && r.result && r.result.ok === true && typeof r.result.frames === 'number' &&
        r.result.frames >= 4,
        JSON.stringify(r));
      // The whole promise of the command: the window ENDS exactly on `to`, not
      // a rounding error away from it.
      check('morph lands the window exactly on the target rect',
        r.ok === true && Array.isArray(r.result.rect) &&
        JSON.stringify(r.result.rect) === JSON.stringify(box(B)),
        JSON.stringify(r.result && r.result.rect) + ' wanted ' + JSON.stringify(box(B)));
    } catch (e) { check('morph', false, e.message); }

    // A second morph for the same window supersedes the first, and the
    // superseded one must still ANSWER - a promise that never settles would
    // hang the caller forever.
    try {
      const first = s.send('morph', { hwnd: selfHwnd, from: B, to: A, ms: 900 });
      await sleep(80);
      const second = await s.send('morph', { hwnd: selfHwnd, from: B, to: C, ms: 120 });
      const firstReply = await first;
      check('a second morph cancels the first, and the first says so',
        firstReply.ok === false && (firstReply.reason === 'cancelled' || firstReply.error === 'cancelled'),
        JSON.stringify(firstReply));
      check('the morph that superseded it still lands on its own target',
        second.ok === true && second.result &&
        JSON.stringify(second.result.rect) === JSON.stringify(box(C)),
        JSON.stringify(second.result));
    } catch (e) { check('a second morph cancels the first', false, e.message); }

    // cancel:true stops it WHERE IT IS and clears nothing else.
    try {
      const running = s.send('morph', { hwnd: selfHwnd, from: C, to: A, ms: 900 });
      await sleep(80);
      const stop = await s.send('morph', { hwnd: selfHwnd, cancel: true });
      check('morph cancel:true is acknowledged',
        stop.ok === true && stop.result && stop.result.cancelled === true, JSON.stringify(stop));
      const cancelled = await running;
      check('a cancelled morph answers ok:false with reason "cancelled"',
        cancelled.ok === false && (cancelled.reason === 'cancelled' || cancelled.error === 'cancelled'),
        JSON.stringify(cancelled));
    } catch (e) { check('morph cancel', false, e.message); }

    for (const [ease, what] of [
      [[0.4, 0], 'too few numbers'],
      [[2, 0, 0.5, 1], 'x outside 0..1'],
      ['ease-in-out', 'a string instead of an array']
    ]) {
      try {
        const r = await s.send('morph', { hwnd: selfHwnd, from: A, to: B, ms: 60, ease });
        check(`morph refuses a bad ease (${what})`,
          r.ok === false && typeof r.error === 'string' && r.error.includes('ease'), JSON.stringify(r));
      } catch (e) { check(`morph refuses a bad ease (${what})`, false, e.message); }
    }

    try {
      const r = await s.send('morph', { hwnd: selfHwnd, to: B, ms: 60 });
      check('morph without a from rect says what it needs',
        r.ok === false && typeof r.error === 'string' && r.error.includes('from'), JSON.stringify(r));
    } catch (e) { check('morph without a from rect says what it needs', false, e.message); }

    // region on its own: round at the current size, then clear.
    try {
      const on = await s.send('region', { hwnd: selfHwnd, r: 14 });
      check('region rounds the window at its current size',
        on.ok === true && on.result && on.result.ok === true && on.result.r === 14, JSON.stringify(on));
      const off = await s.send('region', { hwnd: selfHwnd, r: 0 });
      check('region with r:0 clears the region',
        off.ok === true && off.result && off.result.r === 0, JSON.stringify(off));
    } catch (e) { check('region', false, e.message); }
  }

  try {
    const r = await s.send('morph', { hwnd: '1', from: { x: 0, y: 0, w: 10, h: 10 }, to: { x: 1, y: 1, w: 10, h: 10 }, ms: 40 });
    check('morph refuses a hwnd that is not a window',
      r.ok === false && typeof r.error === 'string' && r.error.includes('no longer exists'), JSON.stringify(r));
  } catch (e) { check('morph refuses a hwnd that is not a window', false, e.message); }

  if (trayHwnd) {
    try {
      const r = await s.send('morph', {
        hwnd: trayHwnd, from: { x: 0, y: 0, w: 100, h: 40 }, to: { x: 0, y: 0, w: 200, h: 40 }, ms: 40
      });
      check('morph refuses the Windows taskbar',
        r.ok === false && typeof r.error === 'string' && r.error.includes('taskbar'), JSON.stringify(r));
    } catch (e) { check('morph refuses the Windows taskbar', false, e.message); }

    try {
      const r = await s.send('region', { hwnd: trayHwnd, r: 8 });
      check('region refuses the Windows taskbar',
        r.ok === false && typeof r.error === 'string' && r.error.includes('taskbar'), JSON.stringify(r));
    } catch (e) { check('region refuses the Windows taskbar', false, e.message); }
  }

  // ---- hittest / raise --------------------------------------------------
  // Written for a real bug: Explorer's full-screen LockScreenBackstopFrame sits
  // inside the topmost band and swallowed every click on Mantle's bar. A shell
  // that is invisibly covered looks exactly like a shell with broken handlers,
  // so the sidecar has to be able to say which it is.
  if (selfHwnd) {
    const R = { x: 140, y: 140, w: 520, h: 360, r: 0 };
    try {
      // ms:0 lands in one frame, so the window is at a rect this test knows.
      await s.send('morph', { hwnd: selfHwnd, from: R, to: R, ms: 0 });
      const r = await s.send('hittest', { x: R.x + R.w / 2, y: R.y + R.h / 2 });
      const d = r.ok ? r.result : null;
      check('hittest answers with the full shape at a known point',
        r.ok === true && d && d.ok === true &&
        typeof d.hwnd === 'string' && /^\d+$/.test(d.hwnd) &&
        typeof d.root === 'string' && /^\d+$/.test(d.root) &&
        typeof d.cls === 'string' && typeof d.title === 'string' &&
        typeof d.pid === 'number' && typeof d.exe === 'string',
        JSON.stringify(r).slice(0, 220));
      hitNote = 'hittest at the sidecar window centre: cls=' + (d && d.cls) +
        ' title=' + JSON.stringify(d && d.title) + ' pid=' + (d && d.pid);
    } catch (e) { check('hittest answers with the full shape at a known point', false, e.message); }
  }

  try {
    const r = await s.send('hittest', { x: 0, y: 0 });
    check('hittest at 0,0 answers',
      r.ok === true && r.result && r.result.ok === true && typeof r.result.cls === 'string',
      JSON.stringify(r).slice(0, 200));
  } catch (e) { check('hittest at 0,0 answers', false, e.message); }

  try {
    const r = await s.send('raise', { hwnd: selfHwnd || '1' });
    check('raise is refused in passive, with a reason',
      r.ok === false && typeof r.error === 'string' && r.error.includes('passive'), JSON.stringify(r));
  } catch (e) { check('raise is refused in passive', false, e.message); }

  // The argument is checked BEFORE passive, so hwnd 0 says what is wrong with
  // it rather than hiding behind the refusal.
  try {
    const r = await s.send('raise', { hwnd: '0' });
    check('raise with hwnd 0 errors on the argument',
      r.ok === false && typeof r.error === 'string' &&
      r.error.includes('hwnd') && !r.error.includes('passive'), JSON.stringify(r));
  } catch (e) { check('raise with hwnd 0 errors on the argument', false, e.message); }

  // ---- ping lists what it serves ----------------------------------------
  try {
    const r = await s.send('ping');
    const cmds = r.ok && r.result ? r.result.commands : null;
    check('ping lists the commands it serves',
      Array.isArray(cmds) && ['lnk', 'keys', 'foreground', 'traywatch', 'corners', 'morph', 'region',
                              'edgeclip', 'backdrop', 'app', 'pins', 'launch', 'wifi', 'bluetooth', 'brightness',
                              'nightlight', 'power', 'hittest', 'raise', 'windows', 'glass', 'place']
        .every((c) => cmds.indexOf(c) >= 0),
      JSON.stringify(cmds));
  } catch (e) { check('ping lists the commands it serves', false, e.message); }

  // ---- volume (READ ONLY: never change what Owen is listening to) -------
  try {
    const r = await s.send('volume');
    check('volume reads level + muted',
      r.ok === true && r.result && typeof r.result.level === 'number' &&
      r.result.level >= 0 && r.result.level <= 100 && typeof r.result.muted === 'boolean',
      JSON.stringify(r).slice(0, 200));
  } catch (e) { check('volume', false, e.message); }

  // ---- notifications (READ ONLY: no toast of Owen's is ever touched) -----
  // Only reads and refusals here. remove/open are exercised end to end on
  // toasts posted under Notifications.TestAumid by the notif lane's scratch
  // script, never in this suite, which must not write to the machine.
  try {
    const r = await s.send('notifications', { op: 'list' });
    const n = r.ok ? r.result : null;
    check('notifications list answers toasts[] or says why not',
      n && ((n.ok === true && Array.isArray(n.toasts) && typeof n.access === 'string') ||
            (n.ok === false && typeof n.reason === 'string' && n.reason.length > 0)),
      JSON.stringify(r).slice(0, 200));
    check('every listed toast has an id, an app and a way to open (or why not)',
      n && Array.isArray(n.toasts) && n.toasts.every((t) => typeof t.id === 'number' && typeof t.app === 'string' &&
        ['protocol', 'app', 'none'].includes(t.opens) && (t.opens !== 'none' || typeof t.opensWhy === 'string')),
      n && Array.isArray(n.toasts) ? `${n.toasts.length} toasts` : 'no list');
  } catch (e) { check('notifications list', false, e.message); }
  try {
    // An id no toast has: nothing is dismissed, and the reply says it was missing.
    const r = await s.send('notifications', { op: 'remove', ids: [4000000001] });
    check('notifications remove of an unknown id reports it missing',
      r.ok && r.result && r.result.removed.length === 0 && r.result.missing.length === 1, JSON.stringify(r));
  } catch (e) { check('notifications remove of an unknown id', false, e.message); }
  try {
    const r = await s.send('notifications', { op: 'open', toast: 4000000001 });
    check('notifications open of an unknown toast says it is gone',
      r.ok && r.result && r.result.ok === false && /gone/.test(r.result.reason), JSON.stringify(r));
  } catch (e) { check('notifications open of an unknown toast', false, e.message); }
  try {
    const r = await s.send('notifications', { op: 'open' });
    check('notifications open without `toast` errors on the argument',
      r.ok === false && /needs toast/.test(r.error), JSON.stringify(r));
  } catch (e) { check('notifications open without toast', false, e.message); }
  try {
    const r = await s.send('notifications', { op: 'clear' });
    check('notifications clear of everything is refused in passive',
      r.ok === false && typeof r.error === 'string' && r.error.startsWith('refused: sidecar is passive'), JSON.stringify(r));
  } catch (e) { check('notifications clear refused in passive', false, e.message); }

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

  // ---- glass ------------------------------------------------------------
  // NOT in the refusal list on purpose: `glass` only ever touches a window the
  // caller owns, so there is nothing for passive mode to protect. The only
  // refusals are a hwnd that is not a window.
  try {
    const r = await s.send('glass', { hwnd: '0', mode: 'acrylic' });
    check('glass refuses hwnd 0 with a reason',
      r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
  } catch (e) { check('glass refuses hwnd 0 with a reason', false, e.message); }

  try {
    const r = await s.send('glass', { hwnd: '1', mode: 'acrylic' });
    check('glass refuses a hwnd that is not a window',
      r.ok === false && typeof r.error === 'string' && r.error.includes('no longer exists'),
      JSON.stringify(r));
  } catch (e) { check('glass refuses a hwnd that is not a window', false, e.message); }

  if (selfHwnd) {
    try {
      const on = await s.send('glass', { hwnd: selfHwnd, mode: 'acrylic', tint: '#101014CC' });
      check('glass acrylic applies to the sidecar\'s own window',
        on.ok === true && on.result && on.result.applied === true && on.result.mode === 'acrylic',
        JSON.stringify(on));
      const off = await s.send('glass', { hwnd: selfHwnd, mode: 'off' });
      check('glass off applies to the sidecar\'s own window',
        off.ok === true && off.result && off.result.applied === true && off.result.mode === 'off',
        JSON.stringify(off));
    } catch (e) { check('glass on the sidecar\'s own window', false, e.message); }
  } else {
    check('glass on the sidecar\'s own window', false, 'ping did not report selfHwnd');
  }

  try {
    const r = await s.send('glass', { hwnd: selfHwnd || '1', mode: 'frosted' });
    check('glass refuses an unknown mode with a reason',
      r.ok === false && typeof r.error === 'string' && r.error.includes('acrylic'), JSON.stringify(r));
  } catch (e) { check('glass refuses an unknown mode with a reason', false, e.message); }

  // ---- trayClick takes `icon` (never `id`, which is the protocol's) ------
  try {
    const none = await s.send('trayClick', {});
    check('trayClick without icon names the argument, in any mode',
      none.ok === false && typeof none.error === 'string' && none.error.includes('icon') &&
      !none.error.includes('passive'), JSON.stringify(none));
    const some = await s.send('trayClick', { icon: 'nope', button: 'left' });
    check('trayClick {icon} is refused in passive (it would click a live icon)',
      some.ok === false && typeof some.error === 'string' && some.error.includes('passive'), JSON.stringify(some));
  } catch (e) { check('trayClick takes icon', false, e.message); }

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

  // ---- lanes, deadlines, coalescing (Lanes.cs, 2026-09-22) ---------------
  // The live sidecar went permanently behind because every command shared one
  // thread and late requests still ran. `sleep` (passive-only) parks one lane
  // so these checks can prove the others do not care.
  const laneNotes = [];
  {
    const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
    async function timed(cmd, extra, timeoutMs) {
      const t0 = process.hrtime.bigint();
      const r = await s.send(cmd, extra, timeoutMs);
      return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    }

    // 1. A slow lane busy for 3 s: ui commands still answer in milliseconds.
    try {
      const parked = s.send('sleep', { lane: 'slow', ms: 3000 }, 8000);
      await sleep(50);
      const ms = [];
      for (let i = 0; i < 20; i++) {
        const { r, ms: m } = await timed(i % 2 ? 'hittest' : 'ping', i % 2 ? { x: 5, y: 5 } : {}, 4000);
        if (!r.ok) throw new Error('an interactive command failed: ' + JSON.stringify(r).slice(0, 160));
        ms.push(m);
        await sleep(40);
      }
      const bd = await timed('backdrop', { x: 0, y: 0, w: 64, h: 16, scale: 4 }, 4000);
      const vol = await timed('volume', {}, 4000);
      const bt = await timed('bluetooth', {}, 4000);
      const pr = await parked;
      laneNotes.push(`slow lane parked 3 s: ping/hittest p50 ${pct(ms, 0.5).toFixed(1)} ms, ` +
        `max ${Math.max(...ms).toFixed(1)} ms; backdrop ${bd.ms.toFixed(0)} ms; volume ${vol.ms.toFixed(0)} ms; ` +
        `bluetooth ${bt.ms.toFixed(0)} ms`);
      check('ui answers in milliseconds while the slow lane is busy (max ' + Math.max(...ms).toFixed(0) + ' ms)',
        Math.max(...ms) < 250, ms.map((x) => x.toFixed(0)).join(','));
      check('backdrop (capture lane) answers while the slow lane is busy',
        bd.r.ok === true && bd.ms < 1500, JSON.stringify({ ms: bd.ms, ok: bd.r.ok }));
      check('volume (audio lane) answers while the slow lane is busy',
        vol.r.ok === true && vol.ms < 1500, JSON.stringify({ ms: vol.ms, r: vol.r }).slice(0, 160));
      check('a cached bluetooth read answers while the slow lane is busy',
        bt.r.ok === true && bt.ms < 500, JSON.stringify({ ms: bt.ms }));
      check('the parked slow lane itself finished', pr.ok === true && pr.result && pr.result.lane === 'slow',
        JSON.stringify(pr));
    } catch (e) { check('lanes: ui stays responsive while slow is busy', false, e.message); }

    // 2. A request that waits past its caller's deadline is skipped, not run.
    try {
      const parked = s.send('sleep', { lane: 'slow', ms: 1500 }, 8000);
      await sleep(50);
      const t0 = Date.now();
      const late = s.send('icon', { path: 'C:\\Windows\\explorer.exe', ttl: 300 }, 8000);
      const fine = s.send('icon', { path: 'C:\\Windows\\explorer.exe', ttl: 6000 }, 8000);
      const [lr, fr] = await Promise.all([late, fine]);
      await parked;
      check('a request past its ttl answers "expired" instead of running',
        lr.ok === false && lr.reason === 'expired' && typeof lr.error === 'string' && lr.error.startsWith('expired'),
        JSON.stringify(lr).slice(0, 200));
      check('a request inside its ttl on the same lane still runs', fr.ok === true && fr.result && 'icon' in fr.result,
        JSON.stringify(fr).slice(0, 160));
      laneNotes.push(`expiry: the late icon was skipped after ${Date.now() - t0} ms`);
    } catch (e) { check('lanes: expired requests are skipped', false, e.message); }

    // Undo requests (quit, restore, remove, release, cancel) are never skipped
    // for being late. Most of them are refused in passive, so the one tested
    // here is `morph {cancel:true}`, which answers in passive and is an undo.
    try {
      const parked = s.send('sleep', { lane: 'ui', ms: 600 }, 8000);
      await sleep(30);
      const late = s.send('ping', { ttl: 100 }, 8000);
      const undo = s.send('morph', { hwnd: selfHwnd || '1', cancel: true, ttl: 100 }, 8000);
      const [lr, ur] = await Promise.all([late, undo]);
      await parked;
      check('the ui lane skips an expired request too', lr.ok === false && lr.reason === 'expired', JSON.stringify(lr));
      check('an undo (morph cancel) runs even past its ttl', ur.ok === true, JSON.stringify(ur));
    } catch (e) { check('lanes: ui expiry and undo exemption', false, e.message); }

    // 3. Identical backdrop grabs queued behind a busy capture lane collapse
    //    into ONE capture, and every caller gets the picture.
    try {
      const before = (await s.send('ping')).result.load.merged;
      const parked = s.send('sleep', { lane: 'capture', ms: 800 }, 8000);
      await sleep(30);
      const rect = { x: 0, y: 0, w: 64, h: 16, scale: 4 };
      const shots = await Promise.all([1, 2, 3, 4, 5].map(() => s.send('backdrop', rect, 8000)));
      await parked;
      const after = (await s.send('ping')).result.load.merged;
      check('five identical queued backdrops all answer with a picture',
        shots.every((r) => r.ok === true && r.result && typeof r.result.png === 'string'),
        JSON.stringify(shots.map((r) => r.ok)));
      check('five identical queued backdrops were captured once (4 merged)', after - before === 4,
        'merged went from ' + before + ' to ' + after);
      check('the merged callers got the same capture', shots.every((r) => r.result && r.result.png === shots[0].result.png),
        'pngs differ');
    } catch (e) { check('lanes: backdrop coalescing', false, e.message); }

    // 4. After all that, nothing is left queued: the sidecar drained.
    try {
      await sleep(200);
      const p = await s.send('ping', {}, 4000);
      const lanes = p.ok && p.result && p.result.load ? p.result.load.lanes : null;
      check('ping reports every lane', Array.isArray(lanes) &&
        ['ui', 'capture', 'slow', 'audio'].every((n) => lanes.some((l) => l && l.name === n)), JSON.stringify(lanes));
      check('every lane has drained', Array.isArray(lanes) && lanes.every((l) => l.queued === 0),
        JSON.stringify(lanes));
      check('ping reports the quick settings caches', p.result && p.result.caches && p.result.caches.bluetooth &&
        'ageMs' in p.result.caches.bluetooth, JSON.stringify(p.result && p.result.caches));
      laneNotes.push('after the burst: ' + JSON.stringify(p.result.load));
    } catch (e) { check('lanes: drained', false, e.message); }

    try {
      const r = await s.send('sleep', { lane: 'slow', ms: 99999 });
      check('sleep refuses an out-of-range ms', r.ok === false, JSON.stringify(r));
    } catch (e) { check('sleep refuses an out-of-range ms', false, e.message); }
  }

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

  // ---- stdin EOF WITH a state file --------------------------------------
  // The 2026-09-21 live crash test: Electron was killed, the sidecar went away
  // and Explorer reclaimed the app bar, but the state file still said
  // "restored":false - the restore had blocked on a stdout write to a pipe with
  // no reader. The restore must now finish, and the file must say so, on the
  // EOF path exactly as it does on `quit`.
  try { fs.unlinkSync(STATE_EOF); } catch (e) { /* not there: that is the point */ }
  const s3 = start(['--passive', '--parent-pid=' + process.pid, '--state-file=' + STATE_EOF]);
  try {
    await s3.waitEvent('ready', 6000);
    await waitForState((v) => v && v.original, 3000, STATE_EOF);
    s3.proc.stdin.end();
    const ex = await s3.waitExit(3000);
    check('stdin EOF with a state file exits 0', ex.code === 0, 'exit code ' + ex.code);
    const st = await waitForState((v) => v && v.restored === true, 3000, STATE_EOF);
    check('stdin EOF writes restored:true BEFORE exiting',
      st !== null && st.restored === true,
      st ? JSON.stringify(st) : 'no file at ' + STATE_EOF);
    check('stdin EOF leaves no app bar recorded',
      st !== null && st.changed && Array.isArray(st.changed.appbars) && st.changed.appbars.length === 0,
      st ? JSON.stringify(st.changed) : '');
  } catch (e) {
    check('stdin EOF writes restored:true BEFORE exiting', false, e.message);
    try { s3.proc.kill(); } catch (_) {}
  }

  // ---- a stdout NOBODY READS (the actual 2026-09-21 failure) ------------
  // When Electron is killed, the read end of the sidecar's stdout can still be
  // open while nothing drains it: writes do not fail, they BLOCK once the pipe
  // fills. That is what swallowed the restore. Reproduced here by never reading
  // stdout and then flooding it with icon replies until it wedges - the restore
  // must still run, the note must still be written, and the process must still
  // die.
  {
    const STATE_WEDGE = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '.wedge.state.json');
    try { fs.unlinkSync(STATE_WEDGE); } catch (e) { /* not there */ }
    const p = spawn(EXE, ['--passive', '--parent-pid=' + process.pid, '--state-file=' + STATE_WEDGE],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    p.stdout.pause();   // never read; a paused stdio stream is never drained
    let exited = null;
    p.on('exit', (code) => { exited = code === null ? -1 : code; });
    try {
      await waitForState((v) => v && v.original, 5000, STATE_WEDGE);
      for (let i = 0; i < 200; i++) {
        p.stdin.write(JSON.stringify({ id: 1000 + i, cmd: 'icon', path: 'C:\\Windows\\explorer.exe' }) + '\n');
      }
      await sleep(800);          // let the replies fill the pipe and wedge it
      const t0 = Date.now();
      p.stdin.end();             // EOF: the restore must happen anyway

      const st = await waitForState((v) => v && v.restored === true, 6000, STATE_WEDGE);
      check('a wedged stdout cannot stop the restore being recorded',
        st !== null && st.restored === true, st ? JSON.stringify(st) : 'no file at ' + STATE_WEDGE);

      for (let i = 0; i < 80 && exited === null; i++) await sleep(100);
      check('a wedged stdout cannot stop the sidecar exiting',
        exited !== null, 'still running ' + (Date.now() - t0) + 'ms after EOF');
    } catch (e) {
      check('a wedged stdout cannot stop the restore being recorded', false, e.message);
    }
    if (exited === null) { try { p.kill(); } catch (_) {} }
    try { fs.unlinkSync(STATE_WEDGE); } catch (e) { /* already gone */ }
  }

  try { fs.unlinkSync(STATE); } catch (e) { /* already gone */ }
  try { fs.unlinkSync(STATE_EOF); } catch (e) { /* already gone */ }
  // The only two files this suite created on the machine.
  try { fs.unlinkSync(LNK); } catch (e) { /* already gone */ }
  try { fs.unlinkSync(LNK_SHELL); } catch (e) { /* already gone */ }

  for (const f of failures) console.log('  FAIL: ' + f);
  for (const n of quickNotes) console.log('  note: ' + n);
  for (const n of laneNotes) console.log('  note: ' + n);
  if (hitNote) console.log('  note: ' + hitNote);
  if (windowsAppNote) console.log('  note: ' + windowsAppNote);
  if (pinsNote) console.log('  note: ' + pinsNote);
  if (backdropNote) console.log('  note: ' + backdropNote);
  if (cornersNote) console.log('  note: ' + cornersNote);
  if (trayNote) console.log('  note: ' + trayNote);
  if (shellLnkNote) console.log('  note: ' + shellLnkNote);
  if (explorerPinNote) console.log('  note: ' + explorerPinNote);
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  FAIL: harness crashed: ' + (e && e.stack ? e.stack : e));
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length + 1} failed`);
  process.exit(1);
});
