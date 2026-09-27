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
const { spawnSidecar } = require('./test-lib');

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

/** A running sidecar, with request/reply correlation over its stdout lines (sidecar/test-lib.js,
 *  shared with every feature lane's sidecar/test-<name>.js since 2026-09-24). */
function start(args) {
  return spawnSidecar(EXE, args);
}

/*
 * WI-FI NETWORKS, OUTPUT DEVICES, THE MIXER (qsx lane, 2026-09-23: Wlan.cs, AudioMixer.cs).
 *
 * Owen is at the machine and may be recording lessons with audio, so against his machine this is
 * READ ONLY: listing and scanning networks, listing devices and apps. Nothing here connects,
 * disconnects or saves a Wi-Fi profile: the passive sidecar refuses all three, and the profile XML
 * is built by a passive-only test op that writes nothing. The write entry points are proved to
 * load by aiming them at an interface GUID that does not exist (`wlan probe`), which answers with
 * Windows' documented error codes. The only audio writes land on a session this harness creates
 * and ends itself: a PowerShell child looping a silent WAV, put back to its starting level and
 * mute before it is killed, because Windows remembers an app's mixer level between runs.
 *
 * MANTLE_TEST_AUDIO_DEFAULT=1 adds the one live call the brief allows: making the current default
 * device the default again. It is off by default because, measured 2026-09-23 with a read-only
 * IMMNotificationClient, even that no-op makes Windows announce a default-device change to every
 * app (OnDefaultDeviceChanged five times in ~35 ms, then ~150 property changes over ~480 ms), and
 * an app that follows the default may reopen its stream mid-recording.
 */
const QSX_PASSIVE = 'refused: sidecar is passive (test mode)';
const QSX_ACTIONS = ['disconnect', 'connect', 'open', 'password', 'settings'];

/** One second (or n) of 16-bit mono silence at 8 kHz, as a WAV file's bytes. */
function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds * 2;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

async function qsxChecks(s) {
  // A made-up key that must never come back: not in an error, not in a log line.
  const secret = 'qsx-never-echo-' + process.pid;
  const notes = [];        // measurements, printed with the other notes (counts only, never a network's name)

  try {
    const r = await s.send('ping');
    const cmds = r.ok && r.result ? r.result.commands : null;
    check('ping lists wlan and audio', Array.isArray(cmds) && cmds.indexOf('wlan') >= 0 && cmds.indexOf('audio') >= 0, JSON.stringify(cmds));
  } catch (e) { check('ping lists wlan and audio', false, e.message); }

  // ---- wlan list ----------------------------------------------------------
  let wl = null;
  try {
    const r = await s.send('wlan', { op: 'list' }, 10000);
    wl = r.ok ? r.result : null;
    const nets = wl && Array.isArray(wl.networks) ? wl.networks : null;
    check('wlan list answers with present, on and the networks',
      !!wl && typeof wl.present === 'boolean' && typeof wl.on === 'boolean' && !!nets &&
      (wl.ok === true || (typeof wl.reason === 'string' && wl.reason.length > 0)),
      JSON.stringify(r).slice(0, 300));
    if (wl && (!wl.present || !wl.on)) {
      check('wlan list says why when there is no adapter or the radio is off',
        typeof wl.reason === 'string' && wl.reason.length > 0, JSON.stringify(wl).slice(0, 200));
    }
    if (nets) {
      const bad = nets.filter((n) => !(
        (n.ssid === null || typeof n.ssid === 'string') && typeof n.hex === 'string' &&
        typeof n.signal === 'number' && n.signal >= 0 && n.signal <= 100 &&
        typeof n.secure === 'boolean' && typeof n.security === 'string' && n.security.length > 0 &&
        typeof n.known === 'boolean' && typeof n.connected === 'boolean' && typeof n.connecting === 'boolean' &&
        QSX_ACTIONS.indexOf(n.action) >= 0 &&
        (n.action !== 'settings' || (typeof n.why === 'string' && n.why.length > 0))));
      check('every wlan row has its fields and an action, and a reason when the action is Windows settings',
        bad.length === 0, JSON.stringify(bad[0] || null).slice(0, 300));
      // connected first, then saved, then the rest, the hidden row last; each group by signal
      const rank = (n) => (n.connected ? 0 : n.hidden ? 3 : n.known ? 1 : 2);
      let sorted = true;
      for (let i = 1; i < nets.length; i++) {
        const a = nets[i - 1], b = nets[i];
        if (rank(a) > rank(b) || (rank(a) === rank(b) && a.signal < b.signal)) sorted = false;
      }
      check('wlan rows come connected, saved, others, hidden, each by signal', sorted,
        nets.map((n) => rank(n) + ':' + n.signal).join(' '));
      check('at most one wlan row is connected, and hidden networks fold into one row',
        nets.filter((n) => n.connected).length <= 1 && nets.filter((n) => n.hidden).length <= 1,
        nets.map((n) => n.ssid).join(', '));
    }
  } catch (e) { check('wlan list', false, e.message); }

  // ---- wlan scan: one real WlanScan (read-only), the list read after the scan completes --
  try {
    const t0 = Date.now();
    const r = await s.send('wlan', { op: 'scan' }, 15000);
    const ms = Date.now() - t0;
    const res = r.ok ? r.result : null;
    const sc = res && res.scan;
    check('wlan scan answers with the list and the scan\'s own outcome',
      !!res && Array.isArray(res.networks) && !!sc && typeof sc.ok === 'boolean' &&
      (sc.ok || (typeof sc.reason === 'string' && sc.reason.length > 0)),
      JSON.stringify(r).slice(0, 300));
    if (wl && wl.present && wl.on) {
      check('wlan scan waited for Windows and still answered in time', sc && sc.ok === true && ms < 9000,
        ms + ' ms, ' + JSON.stringify(sc));
    }
    const nets = res && Array.isArray(res.networks) ? res.networks : [];
    notes.push('wlan: ' + nets.length + ' network row(s), ' + nets.filter((n) => n.known).length + ' saved, ' +
      nets.filter((n) => n.connected).length + ' connected; list read ' + (wl ? wl.readMs : '?') + ' ms; scan ' + ms +
      ' ms end to end (' + (sc ? (sc.ok ? 'completed' : 'failed: ' + sc.reason) : 'no outcome') + ')');
  } catch (e) { check('wlan scan', false, e.message); }

  // ---- wlan reason: WLAN_REASON_CODE -> WlanReasonCodeToString -----------
  try {
    const ok0 = await s.send('wlan', { op: 'reason', code: 0 });
    const psk = await s.send('wlan', { op: 'reason', code: 0x48014 });
    const neg = await s.send('wlan', { op: 'reason', code: -1 });
    const none = await s.send('wlan', { op: 'reason' });
    check('wlan reason turns a WLAN_REASON_CODE into Windows\' text',
      ok0.ok === true && typeof ok0.result.text === 'string' && ok0.result.text.length > 0 &&
      psk.ok === true && psk.result.hex === '0x48014' && psk.result.text.length > 0 && !/no text/.test(psk.result.text),
      JSON.stringify([ok0, psk]).slice(0, 300));
    check('wlan reason refuses a missing code and one that is not a whole number in range',
      neg.ok === false && /whole number/.test(neg.error) && none.ok === false && /needs code/.test(none.error),
      JSON.stringify([neg, none]).slice(0, 300));
  } catch (e) { check('wlan reason', false, e.message); }

  // ---- the profile XML a connect would hand WlanSetProfile (built, never written) --
  const prof = (extra) => s.send('wlan', Object.assign({ op: 'profile' }, extra));
  try {
    const open = await prof({ ssid: 'Test Open', security: 'open' });
    const x = open.ok ? open.result.xml : '';
    check('profile XML for an open network: open/none, no key, the SSID as hex and name, auto',
      open.ok === true && open.result.wellFormed === true &&
      x.includes('<authentication>open</authentication>') && x.includes('<encryption>none</encryption>') &&
      !x.includes('sharedKey') && x.toLowerCase().includes('<hex>' + Buffer.from('Test Open').toString('hex') + '</hex>') &&
      x.includes('<name>Test Open</name>') && x.includes('<connectionMode>auto</connectionMode>') &&
      x.includes('<useOneX>false</useOneX>'),
      JSON.stringify(open).slice(0, 400));

    const w2 = await prof({ ssid: 'Cafe WiFi', security: 'wpa2', password: 'correct horse', auto: false });
    const x2 = w2.ok ? w2.result.xml : '';
    check('profile XML for WPA2-Personal: WPA2PSK/AES, a passphrase key, manual when auto is off',
      w2.ok === true && w2.result.wellFormed === true && x2.includes('<authentication>WPA2PSK</authentication>') &&
      x2.includes('<encryption>AES</encryption>') && x2.includes('<keyType>passPhrase</keyType>') &&
      x2.includes('<protected>false</protected>') && x2.includes('<keyMaterial>correct horse</keyMaterial>') &&
      x2.includes('<connectionMode>manual</connectionMode>'),
      JSON.stringify(w2).slice(0, 400));

    const w3 = await prof({ ssid: 'Cafe WiFi', security: 'wpa3', password: 'correct horse' });
    const w1 = await prof({ ssid: 'Old Router', security: 'wpa', password: 'correct horse' });
    check('profile XML for WPA3-Personal (WPA3SAE/AES) and WPA-Personal (WPAPSK/TKIP)',
      w3.ok === true && w3.result.wellFormed === true && w3.result.xml.includes('<authentication>WPA3SAE</authentication>') &&
      w3.result.xml.includes('<encryption>AES</encryption>') &&
      w1.ok === true && w1.result.xml.includes('<authentication>WPAPSK</authentication>') &&
      w1.result.xml.includes('<encryption>TKIP</encryption>'),
      JSON.stringify([w3, w1]).slice(0, 400));

    const raw = await prof({ ssid: 'Raw Key', security: 'wpa2', password: 'a1'.repeat(32) });
    check('profile XML takes exactly 64 hex digits as the raw key (networkKey)',
      raw.ok === true && raw.result.xml.includes('<keyType>networkKey</keyType>'), JSON.stringify(raw).slice(0, 300));

    const name = 'A&B <"x">\'';
    const esc = await prof({ ssid: name, security: 'wpa2', password: 'p&ss<w>rd"\'' });
    const xe = esc.ok ? esc.result.xml : '';
    check('profile XML escapes the name and the key and stays well formed',
      esc.ok === true && esc.result.wellFormed === true &&
      xe.includes('<name>A&amp;B &lt;&quot;x&quot;&gt;&apos;</name>') &&
      xe.includes('<keyMaterial>p&amp;ss&lt;w&gt;rd&quot;&apos;</keyMaterial>') &&
      xe.toLowerCase().includes('<hex>' + Buffer.from(name).toString('hex') + '</hex>'),
      JSON.stringify(esc).slice(0, 500));
  } catch (e) { check('profile XML', false, e.message); }

  try {
    const cases = [
      [{ ssid: 'N', security: 'wpa2', password: 'short1' }, /at least 8/],
      [{ ssid: 'N', security: 'wpa2', password: 'x'.repeat(64) }, /at most 63/],
      [{ ssid: 'N', security: 'wpa2', password: 'café-café' }, /printable ASCII/],
      [{ ssid: 'N', security: 'open', password: 'something9' }, /takes no password/],
      [{ ssid: 'N', security: 'wpa2' }, /needs a password/],
      [{ ssid: 'N', security: 'wep', password: 'something9' }, /security must be/],
      [{ ssid: 'x'.repeat(33), security: 'open' }, /at most 32 bytes/],
    ];
    const bad = [];
    for (const [args, re] of cases) {
      const r = await prof(args);
      const err = r.error || '';
      if (!(r.ok === false && re.test(err) && (!args.password || !err.includes(args.password)))) bad.push(JSON.stringify(r).slice(0, 160));
    }
    check('profile refuses a bad key, security word or name in words, never quoting the key', bad.length === 0, bad.join(' | '));
  } catch (e) { check('profile refusals', false, e.message); }

  // ---- every write entry point, aimed at an interface that does not exist --
  try {
    const r = await s.send('wlan', { op: 'probe' }, 10000);
    const res = r.ok ? r.result : null;
    const c = res && res.codes;
    if (res && res.ok === false) {
      check('wlan probe says why it could not run', typeof res.reason === 'string' && res.reason.length > 0, JSON.stringify(r));
    } else {
      // 1168 ERROR_NOT_FOUND for an unknown interface, 87 ERROR_INVALID_PARAMETER where Windows checks
      // the arguments first (measured 2026-09-23); a wrong signature would crash or return garbage.
      check('wlan write entry points load and give their documented errors for a bogus interface',
        !!c && c.scan === 1168 && c.connect === 1168 && c.disconnect === 1168 && c.setProfile === 87 &&
        c.deleteProfile === 87 && c.profileList === 87 && c.networkList === 1168 && c.notify === 0 && c.reasonText === 0,
        JSON.stringify(r).slice(0, 400));
    }
  } catch (e) { check('wlan probe', false, e.message); }

  // ---- connect and disconnect: arguments first, then the passive refusal --
  try {
    const noName = await s.send('wlan', { op: 'connect' });
    const short = await s.send('wlan', { op: 'connect', ssid: 'Somewhere', password: 'short1' });
    const long = await s.send('wlan', { op: 'connect', ssid: 'x'.repeat(33) });
    const badHex = await s.send('wlan', { op: 'connect', hex: 'zz' });
    const numPw = await s.send('wlan', { op: 'connect', ssid: 'Somewhere', password: 12345678 });
    check('wlan connect checks its arguments before the passive refusal, without quoting the key',
      noName.ok === false && /needs ssid/.test(noName.error) && !noName.error.includes('passive') &&
      short.ok === false && /at least 8/.test(short.error) && !short.error.includes('passive') && !short.error.includes('short1') &&
      long.ok === false && /32 bytes/.test(long.error) && badHex.ok === false && /hex/.test(badHex.error) &&
      numPw.ok === false && /must be a string/.test(numPw.error),
      JSON.stringify([noName, short, long, badHex, numPw]).slice(0, 500));
    const c = await s.send('wlan', { op: 'connect', ssid: 'Somewhere', password: secret });
    check('wlan connect is refused in passive, and the refusal does not quote the key',
      c.ok === false && c.error.startsWith(QSX_PASSIVE) && /join a network/.test(c.error) && !c.error.includes(secret),
      JSON.stringify(c).slice(0, 300));
    const d = await s.send('wlan', { op: 'disconnect' });
    check('wlan disconnect is refused in passive', d.ok === false && d.error.startsWith(QSX_PASSIVE), JSON.stringify(d));
    const u = await s.send('wlan', { op: 'nope' });
    check('wlan names its ops for an unknown one', u.ok === false && /unknown op/.test(u.error), JSON.stringify(u));
  } catch (e) { check('wlan connect/disconnect refusals', false, e.message); }

  // ---- audio devices ------------------------------------------------------
  let devs = null;
  try {
    const r = await s.send('audio', { op: 'devices' });
    const d = r.ok ? r.result : null;
    devs = d && Array.isArray(d.devices) ? d.devices : null;
    const shapeOk = !!devs && devs.every((x) => typeof x.id === 'string' && x.id.length > 0 &&
      typeof x.name === 'string' && x.name.length > 0 && typeof x.isDefault === 'boolean' && !!x.roles &&
      ['console', 'multimedia', 'communications'].every((k) => typeof x.roles[k] === 'boolean'));
    check('audio devices lists the active playback devices with their three roles', !!d && d.ok === true && shapeOk,
      JSON.stringify(r).slice(0, 300));
    if (devs && devs.length) {
      const defs = devs.filter((x) => x.isDefault);
      check('exactly one playback device is the default, and defaultId names it',
        defs.length === 1 && defs[0].id === d.defaultId, JSON.stringify(d).slice(0, 300));
    }
  } catch (e) { check('audio devices', false, e.message); }

  // ---- audio sessions (the mixer) ------------------------------------------
  try {
    const r = await s.send('audio', { op: 'sessions' });
    const res = r.ok ? r.result : null;
    const ss = res && Array.isArray(res.sessions) ? res.sessions : null;
    check('audio sessions answers with the default device and its apps',
      !!res && !!ss && (res.ok === true || (typeof res.reason === 'string' && res.reason.length > 0)),
      JSON.stringify(r).slice(0, 300));
    if (ss) {
      const bad = ss.filter((x) => !(typeof x.key === 'string' && /^(system|pid:\d+|sid:\d+)$/.test(x.key) &&
        typeof x.name === 'string' && x.name.length > 0 && typeof x.system === 'boolean' && typeof x.active === 'boolean' &&
        Number.isInteger(x.level) && x.level >= 0 && x.level <= 100 && typeof x.muted === 'boolean' && x.sessions >= 1));
      check('every mixer row has a key, a name, a 0-100 level and a mute flag', bad.length === 0, JSON.stringify(bad[0] || null));
      const sys = ss.filter((x) => x.system);
      check('system sounds are one row keyed "system", and it comes first',
        sys.length <= 1 && (sys.length === 0 || (ss[0].system === true && ss[0].key === 'system')),
        JSON.stringify(ss.map((x) => x.key)));
    }
    // The open mixer polls every 1.5 s, so a read has to stay cheap (5-10 ms warm, 2026-09-23).
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await s.send('audio', { op: 'sessions' });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    check('an audio sessions read is cheap enough to poll (median of 5 under 250 ms)', times[2] < 250, times.join(','));
    notes.push('audio: ' + (devs ? devs.length : '?') + ' playback device(s); ' + (ss ? ss.length : '?') +
      ' mixer row(s); sessions read round trips ' + times.join('/') + ' ms (median ' + times[2] + ')');
  } catch (e) { check('audio sessions', false, e.message); }

  // ---- audio default: refusals, and the no-op only when asked for ----------
  try {
    const none = await s.send('audio', { op: 'default' });
    const bogus = await s.send('audio', { op: 'default', device: '{0.0.0.00000000}.{not-a-device}' });
    check('audio default needs a device and refuses one that is not active, before any passive check',
      none.ok === false && /needs device/.test(none.error) &&
      bogus.ok === false && /no active playback device/.test(bogus.error) && !bogus.error.includes('passive'),
      JSON.stringify([none, bogus]).slice(0, 300));
    const other = devs && devs.find((x) => !x.isDefault);
    if (other) {
      const r = await s.send('audio', { op: 'default', device: other.id });
      check('audio default to another device is refused in passive',
        r.ok === false && r.error.startsWith(QSX_PASSIVE), JSON.stringify(r).slice(0, 200));
    }
    const cur = devs && devs.find((x) => x.isDefault);
    if (process.env.MANTLE_TEST_AUDIO_DEFAULT !== '1') {
      notes.push('audio default no-op: not run (MANTLE_TEST_AUDIO_DEFAULT=1 runs it; Windows announces even a no-op to every app)');
    } else if (cur) {
      const r = await s.send('audio', { op: 'default', device: cur.id });
      const res = r.ok ? r.result : null;
      notes.push('audio default no-op: ' + JSON.stringify(res ? { ok: res.ok, noop: res.noop, hr: res.hr, ms: res.ms } : r));
      check('audio default: the current default made default again through IPolicyConfig reads back all three roles',
        !!res && res.ok === true && res.noop === true && !!res.roles &&
        res.roles.console === true && res.roles.multimedia === true && res.roles.communications === true &&
        !!res.hr && res.hr.console === '0x00000000' && res.hr.multimedia === '0x00000000' && res.hr.communications === '0x00000000',
        JSON.stringify(r).slice(0, 400));
    }
  } catch (e) { check('audio default', false, e.message); }

  // ---- audio session: arguments, then the fence ------------------------------
  try {
    const noKey = await s.send('audio', { op: 'session', level: 10 });
    const badKey = await s.send('audio', { op: 'session', key: 'chrome', level: 10 });
    const range = await s.send('audio', { op: 'session', key: 'pid:4', level: 101 });
    const nothing = await s.send('audio', { op: 'session', key: 'pid:4' });
    check('audio session checks key, level and muted before anything else',
      noKey.ok === false && /needs key/.test(noKey.error) && badKey.ok === false && /key must be/.test(badKey.error) &&
      range.ok === false && /0 to 100/.test(range.error) && nothing.ok === false && /needs level/.test(nothing.error),
      JSON.stringify([noKey, badKey, range, nothing]).slice(0, 400));
    const sys = await s.send('audio', { op: 'session', key: 'system', muted: true });
    const notOurs = await s.send('audio', { op: 'session', key: 'pid:4', level: 50 });
    check('audio session refuses system sounds and any app this harness did not start',
      sys.ok === false && sys.error.startsWith(QSX_PASSIVE) && notOurs.ok === false && notOurs.error.startsWith(QSX_PASSIVE),
      JSON.stringify([sys, notOurs]).slice(0, 300));
  } catch (e) { check('audio session refusals', false, e.message); }

  // ---- audio session on a session of our own ---------------------------------
  const wav = path.join(os.tmpdir(), 'mantle-sidecar-test-' + process.pid + '-silence.wav');
  let child = null;
  try {
    fs.writeFileSync(wav, silentWav(1));
    // This harness is the child's parent: that is exactly what the passive fence checks.
    // Start-Sleep bounds it even if the harness dies before it can kill it.
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$p = New-Object System.Media.SoundPlayer '" + wav.replace(/'/g, "''") + "'; $p.PlayLooping(); Start-Sleep -Seconds 40"],
      { stdio: 'ignore', windowsHide: true });
    const key = 'pid:' + child.pid;
    const t0 = Date.now();
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      await sleep(250);
      const r = await s.send('audio', { op: 'sessions' });
      row = (r.ok && r.result && Array.isArray(r.result.sessions) && r.result.sessions.find((x) => x.key === key)) || null;
    }
    if (row) notes.push('own session: ' + key + ' ("' + row.name + '") appeared after ' + (Date.now() - t0) + ' ms at level ' + row.level + (row.muted ? ', muted' : ''));
    if (check('the harness\'s own silent PowerShell shows up as a mixer row', !!row, key)) {
      const startLevel = row.level, startMuted = row.muted;
      const l = await s.send('audio', { op: 'session', key, level: 37 });
      check('audio session sets the harness\'s own session to 37 and reads 37 back',
        l.ok === true && l.result.ok === true && l.result.session && l.result.session.level === 37,
        JSON.stringify(l).slice(0, 300));
      const m = await s.send('audio', { op: 'session', key, muted: true });
      const u = await s.send('audio', { op: 'session', key, muted: false });
      check('audio session mutes and unmutes it, reading each back',
        m.ok === true && m.result.session && m.result.session.muted === true &&
        u.ok === true && u.result.session && u.result.session.muted === false,
        JSON.stringify([m, u]).slice(0, 400));
      const back = await s.send('audio', { op: 'session', key, level: startLevel, muted: startMuted });
      check('and puts it back where it started (Windows remembers an app\'s mixer level)',
        back.ok === true && back.result.session && back.result.session.level === startLevel &&
        back.result.session.muted === startMuted,
        JSON.stringify(back).slice(0, 300));
    }
  } catch (e) {
    check('audio session on the harness\'s own session', false, e.message);
  } finally {
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      try { child.kill(); } catch (_) { /* already gone */ }
      await Promise.race([gone, sleep(3000)]);
    }
    try { fs.unlinkSync(wav); } catch (_) { /* never written, or already gone */ }
  }

  // ---- btdevices: the paired Bluetooth devices (BtDevices.cs, 2026-09-23) ----------------------
  // READ ONLY. Owen may be listening on Bluetooth headphones: nothing here connects or disconnects
  // anything. connect/disconnect are only ever sent to this PASSIVE sidecar, which refuses them
  // before it looks the device up. The connect route is proven by the filter's own list of
  // property sets (KSPROPERTY_TYPE_SETSUPPORT with GUID_NULL), which no driver handler answers.
  const KINDS = ['headphones', 'speaker', 'mouse', 'keyboard', 'phone', 'gamepad', 'other'];
  const since = (i, pred) => s.events.slice(i).find(pred) || null;
  async function eventAfter(i, pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = since(i, pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  }
  try {
    const r = await s.send('ping');
    const cmds = r.ok && r.result ? r.result.commands : null;
    check('ping lists btdevices', Array.isArray(cmds) && cmds.indexOf('btdevices') >= 0, JSON.stringify(cmds));
  } catch (e) { check('ping lists btdevices', false, e.message); }

  let bt = null;
  try {
    const t0 = Date.now();
    const r = await s.send('btdevices', { op: 'list' }, 10000);
    const ms = Date.now() - t0;
    bt = r.ok ? r.result : null;
    const devs = bt && Array.isArray(bt.devices) ? bt.devices : null;
    check('btdevices list answers with present, on and the paired devices',
      !!bt && typeof bt.present === 'boolean' && (typeof bt.on === 'boolean' || bt.on === null) && !!devs &&
      (bt.ok === true || (typeof bt.reason === 'string' && bt.reason.length > 0)),
      JSON.stringify(r).slice(0, 300));
    if (bt && bt.present === false) {
      check('btdevices says why when there is no adapter', typeof bt.reason === 'string' && bt.reason.length > 0, JSON.stringify(bt).slice(0, 200));
    }
    if (devs) {
      const bad = devs.filter((d) => !(
        typeof d.id === 'string' && /^Bluetooth/.test(d.id) && typeof d.name === 'string' && d.name.length > 0 &&
        KINDS.indexOf(d.kind) >= 0 && typeof d.connected === 'boolean' &&
        typeof d.audio === 'boolean' && typeof d.canConnect === 'boolean' &&
        (d.canConnect ? d.connectWhy === null : typeof d.connectWhy === 'string' && d.connectWhy.length > 0)));
      check('every device has an id, a name, one of the seven kinds, connected, and a reason where it cannot connect',
        bad.length === 0, JSON.stringify(bad[0] || null).slice(0, 300));
      const badBattery = devs.filter((d) => !(
        d.connected
          ? (d.battery === null ? typeof d.batteryWhy === 'string' && d.batteryWhy.length > 0
                                : Number.isInteger(d.battery) && d.battery >= 0 && d.battery <= 100 && d.batteryWhy === null)
          : d.battery === null && d.batteryWhy === null));
      check('a battery level only while connected, a whole 0-100, and a reason while connected without one',
        badBattery.length === 0, JSON.stringify(badBattery[0] || null).slice(0, 300));
      const order = devs.map((d) => d.connected);
      check('connected devices are listed first', order.every((c, i) => i === 0 || !c || order[i - 1]), JSON.stringify(order));
      check('a device that is not audio never offers connect', devs.every((d) => d.audio || !d.canConnect), '');
      const kinds = {};
      devs.forEach((d) => { kinds[d.kind] = (kinds[d.kind] || 0) + 1; });
      notes.push('btdevices: ' + devs.length + ' paired (' + Object.keys(kinds).map((k) => kinds[k] + ' ' + k).join(', ') + '), ' +
        devs.filter((d) => d.connected).length + ' connected, ' + devs.filter((d) => d.canConnect).length + ' with a connect route; on=' +
        bt.on + ', ' + ms + ' ms round trip, sidecar ' + JSON.stringify(bt.ms));
    }
  } catch (e) { check('btdevices list', false, e.message); }

  // The route proof, and proof that reading it moved nothing: the default output device and every
  // device's connected flag are the same before and after.
  try {
    const before = await s.send('audio', { op: 'devices' });
    const r = await s.send('btdevices', { op: 'list', raw: true }, 10000);
    const after = await s.send('audio', { op: 'devices' });
    const devs = r.ok && r.result && Array.isArray(r.result.devices) ? r.result.devices : [];
    const routed = devs.filter((d) => d.audio && Array.isArray(d.filters) && d.filters.length > 0);
    const badProof = routed.filter((d) => !(Array.isArray(d.rawKs) && d.rawKs.length === d.filters.length &&
      d.rawKs.every((k) => typeof k.btAudio === 'boolean' && (k.btAudio ? k.sets > 0 : typeof k.why === 'string')) &&
      d.canConnect === d.rawKs.some((k) => k.btAudio)));
    check('every Bluetooth audio route is decided from the filter\'s own list of property sets (SETSUPPORT, GUID_NULL)',
      badProof.length === 0, JSON.stringify(badProof[0] || null).slice(0, 400));
    if (!routed.length) notes.push('btdevices: no paired audio device has sound endpoints, so the KS route was not exercised here');
    else {
      notes.push('btdevices: ' + routed.length + ' audio device(s), ' + routed.reduce((n, d) => n + d.filters.length, 0) + ' filters, ' +
        routed.reduce((n, d) => n + d.rawKs.filter((k) => k.btAudio).length, 0) + ' offering KSPROPSETID_BtAudio');
    }
    const defBefore = before.ok && before.result ? before.result.defaultId : null;
    const defAfter = after.ok && after.result ? after.result.defaultId : null;
    check('reading the Bluetooth routes changed no sound output (the default device is the same)',
      !!defBefore && defBefore === defAfter, JSON.stringify([defBefore, defAfter]));
    if (bt && Array.isArray(bt.devices)) {
      const was = {};
      bt.devices.forEach((d) => { was[d.id] = d.connected; });
      const moved = devs.filter((d) => d.id in was && was[d.id] !== d.connected);
      check('and connected or disconnected nothing', moved.length === 0, JSON.stringify(moved.map((d) => d.name)));
    }
  } catch (e) { check('btdevices route proof', false, e.message); }

  // The watch: a push once Windows' first enumeration completes, a renewal that starts nothing,
  // a stop, and a lease that ends a watch nobody renews.
  try {
    let i = s.events.length;
    const on = await s.send('btdevices', { op: 'watch', on: true, leaseMs: 2000 });
    check('btdevices watch starts', on.ok === true && on.result.ok === true && on.result.watching === true && on.result.started === true,
      JSON.stringify(on).slice(0, 200));
    const ev = await eventAfter(i, (e) => e.ev === 'btdevices', 4000);
    check('the watch pushes the list once Windows has enumerated (ev btdevices)',
      !!ev && Array.isArray(ev.devices) && ev.watching === true && typeof ev.why === 'string',
      ev ? JSON.stringify(ev).slice(0, 200) : 'no btdevices event within 4 s');
    const again = await s.send('btdevices', { op: 'watch', on: true, leaseMs: 2000 });
    check('renewing starts nothing new', again.ok === true && again.result.watching === true && again.result.started === false,
      JSON.stringify(again).slice(0, 200));
    const off = await s.send('btdevices', { op: 'watch', on: false });
    const off2 = await s.send('btdevices', { op: 'watch', on: false });
    check('btdevices watch stops, and stopping twice is harmless',
      off.ok === true && off.result.watching === false && off.result.stopped === true &&
      off2.ok === true && off2.result.stopped === false, JSON.stringify([off, off2]).slice(0, 300));
    i = s.events.length;
    await s.send('btdevices', { op: 'watch', on: true, leaseMs: 1000 });
    const lapse = await eventAfter(i, (e) => e.ev === 'log' && /btdevices: the watch lapsed/.test(e.message || ''), 4000);
    const after = await s.send('btdevices', { op: 'list' }, 10000);
    check('a watch nobody renews stops itself when its lease runs out',
      !!lapse && after.ok === true && after.result.watching === false && /lapsed/.test(after.result.watchReason || ''),
      JSON.stringify([lapse, after.result && after.result.watchReason]).slice(0, 300));
  } catch (e) { check('btdevices watch', false, e.message); }

  for (const [extra, want, label] of [
    [{ op: 'watch' }, /needs on/, 'a watch without on'],
    [{ op: 'watch', on: 'yes' }, /on must be true or false/, "on:'yes'"],
    [{ op: 'watch', on: true, leaseMs: 5 }, /leaseMs must be/, 'a 5 ms lease'],
    [{ op: 'connect' }, /needs device/, 'a connect without a device'],
    [{ op: 'pair' }, /unknown op/, 'an unknown op'],
  ]) {
    try {
      const r = await s.send('btdevices', extra);
      check('btdevices refuses ' + label + ' as a bad argument', r.ok === false && want.test(r.error || '') && !/passive/.test(r.error || ''),
        JSON.stringify(r).slice(0, 200));
    } catch (e) { check('btdevices refuses ' + label, false, e.message); }
  }
  for (const op of ['connect', 'disconnect']) {
    try {
      const device = bt && bt.devices && bt.devices[0] ? bt.devices[0].id : 'Bluetooth#Bluetooth00:00:00:00:00:00-00:00:00:00:00:01';
      const r = await s.send('btdevices', { op, device });
      check('btdevices ' + op + ' is refused in passive, before anything is touched',
        r.ok === false && /passive/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    } catch (e) { check('btdevices ' + op + ' is refused in passive', false, e.message); }
  }

  // ---- the panel's live picture: volwatch, net, qswatch (qsx round 2, 2026-09-23) ---------------
  // Pushes, not polls (Owen, 2026-09-23: "be way more responsive"). READ ONLY: listening changes
  // nothing, and every switch below goes to this PASSIVE sidecar, which refuses it. The budgets are
  // generous multiples of what Owen's laptop measured under load the same day: first volume event
  // 410 ms, qs first pushes 605-958 ms, net get 1007 ms cold / 58-172 ms warm.
  try {
    const r = await s.send('ping');
    const cmds = r.ok && r.result ? r.result.commands : null;
    check('ping lists volwatch, net and qswatch',
      Array.isArray(cmds) && ['volwatch', 'net', 'qswatch'].every((c) => cmds.indexOf(c) >= 0), JSON.stringify(cmds));
    const w = r.result && r.result.watches;
    check('ping reports the volume and net watches',
      !!(w && w.volume && w.net && typeof w.volume.watching === 'boolean' && typeof w.net.watching === 'boolean'), JSON.stringify(w));
  } catch (e) { check('ping lists volwatch, net and qswatch', false, e.message); }

  try {
    const i = s.events.length;
    const t0 = Date.now();
    const on = await s.send('volwatch', { on: true });
    const ev = await eventAfter(i, (e) => e.ev === 'volume', 3000);
    const ms = Date.now() - t0;
    check('volwatch starts and pushes the current volume (ev volume, ' + ms + ' ms, budget 3000)',
      on.ok === true && on.result && on.result.ok === true && on.result.watching === true && !!ev && ev.ok === true &&
      typeof ev.level === 'number' && ev.level >= 0 && ev.level <= 100 && typeof ev.muted === 'boolean',
      JSON.stringify({ on, ev }).slice(0, 260));
    if (ev) notes.push('volwatch: first event ' + ms + ' ms (' + ev.via + ')');
    const p = await s.send('ping');
    check('ping shows the volume watch running',
      !!(p.result && p.result.watches && p.result.watches.volume.watching === true), JSON.stringify(p.result && p.result.watches));
    const again = await s.send('volwatch', { on: true });
    const off = await s.send('volwatch', { on: false });
    const off2 = await s.send('volwatch', { on: false });
    check('volwatch: on twice does not start a second listener; off stops it; off twice is harmless',
      again.ok === true && again.result.started === false && off.ok === true && off.result.watching === false &&
      off2.ok === true && off2.result.watching === false, JSON.stringify({ again, off, off2 }).slice(0, 260));
    const bad = await s.send('volwatch', { on: 'yes' });
    check("volwatch {on:'yes'} is refused as a bad argument",
      bad.ok === false && typeof bad.error === 'string' && !bad.error.includes('passive'), JSON.stringify(bad));
  } catch (e) { check('volwatch', false, e.message); }

  const NET_STATES = ['connected', 'no-internet', 'disconnected', 'wifi-off', 'unknown'];
  const NET_KINDS = ['wifi', 'ethernet', 'other', 'none'];
  try {
    const t0 = Date.now();
    const r = await s.send('net', { op: 'get' }, 8000);
    const coldMs = Date.now() - t0;
    const n = (r.ok && r.result) || {};
    check('net get answers with the readout\'s shape (' + coldMs + ' ms cold, budget 3000)',
      n.ok === true && NET_STATES.indexOf(n.state) >= 0 && NET_KINDS.indexOf(n.kind) >= 0 &&
      (n.internet === true || n.internet === false || n.internet === null) && !!n.wifi && typeof n.wifi === 'object' &&
      coldMs < 3000, JSON.stringify(r).slice(0, 300));
    check('net get agrees with itself: connected has internet (or it is unknown), a Wi-Fi route is a connected Wi-Fi, off is off',
      (n.state !== 'connected' || n.internet !== false) && (n.kind !== 'wifi' || n.wifi.connected === true) &&
      (n.state !== 'wifi-off' || n.wifi.on === false) && (n.state !== 'no-internet' || n.internet === false),
      JSON.stringify(n).slice(0, 300));
    const warm = [];
    for (let k = 0; k < 3; k++) { const t = Date.now(); await s.send('net', { op: 'get' }, 8000); warm.push(Date.now() - t); }
    check('net get answers warm within 1000 ms (' + warm.join('/') + ' ms)', Math.max(...warm) < 1000, warm.join(','));
    // no network name in the notes: they are printed
    notes.push('net: ' + n.state + ' through ' + n.kind + ', internet ' + n.internet + ', cold ' + coldMs + ' ms, warm ' +
      warm.join('/') + ' ms, parts ' + JSON.stringify(n.partsMs));
  } catch (e) { check('net get', false, e.message); }

  try {
    const i = s.events.length;
    const t0 = Date.now();
    const on = await s.send('net', { op: 'watch', on: true, fast: true });
    const ev = await eventAfter(i, (e) => e.ev === 'net', 3000);
    const ms = Date.now() - t0;
    check('net watch starts and pushes the reading (ev net, ' + ms + ' ms, budget 3000)',
      on.ok === true && on.result.watching === true && !!ev && ev.ok === true && NET_STATES.indexOf(ev.state) >= 0,
      JSON.stringify({ on, ev }).slice(0, 260));
    const p = await s.send('ping');
    const nw = p.result && p.result.watches && p.result.watches.net;
    check('ping shows the net watch running fast, and whether Windows\' connectivity events are heard',
      !!nw && nw.watching === true && nw.fast === true && nw.connectivityEvents !== undefined, JSON.stringify(nw));
    if (nw) notes.push('net watch: first event ' + ms + ' ms, connectivity events ' + JSON.stringify(nw.connectivityEvents));
    const slow = await s.send('net', { op: 'watch', on: true, fast: false });
    check('net watch drops to its slow tick without restarting',
      slow.ok === true && slow.result.started === false && slow.result.fast === false, JSON.stringify(slow).slice(0, 200));
    const off = await s.send('net', { op: 'watch', on: false });
    check('net watch stops', off.ok === true && off.result.watching === false, JSON.stringify(off).slice(0, 200));
  } catch (e) { check('net watch', false, e.message); }
  for (const [extra, what] of [
    [{ op: 'watch' }, 'net watch without on'],
    [{ op: 'watch', on: 'yes' }, "net {on:'yes'}"],
    [{ op: 'watch', on: true, fast: 1 }, 'net {fast:1}'],
    [{ op: 'bogus' }, "net {op:'bogus'}"]
  ]) {
    try {
      const r = await s.send('net', extra);
      check(what + ' is refused as a bad argument',
        r.ok === false && typeof r.error === 'string' && !r.error.includes('passive'), JSON.stringify(r));
    } catch (e) { check(what + ' is refused as a bad argument', false, e.message); }
  }

  const QS_PARTS = ['nightlight', 'power', 'volume', 'brightness', 'bluetooth', 'wifi'];
  try {
    const i = s.events.length;
    const t0 = Date.now();
    const on = await s.send('qswatch', { on: true, leaseMs: 5000 });
    const seen = {};
    while (Date.now() - t0 < 4000 && QS_PARTS.some((p) => seen[p] === undefined)) {
      for (const e of s.events.slice(i)) if (e.ev === 'qs' && e.part && seen[e.part] === undefined) seen[e.part] = Date.now() - t0;
      await sleep(25);
    }
    const missing = QS_PARTS.filter((p) => seen[p] === undefined);
    check('qswatch starts and pushes every part once (budget 4000 ms)',
      on.ok === true && on.result.ok === true && on.result.started === true && on.result.watching === true && !missing.length,
      'missing: ' + missing.join(',') + '; ' + JSON.stringify(on).slice(0, 200));
    const pushes = s.events.slice(i).filter((e) => e.ev === 'qs');
    check('each qs push carries its part\'s whole state, and none is an error',
      pushes.length > 0 && pushes.every((e) => e.part && e.state && typeof e.state === 'object' && e.ok !== false),
      JSON.stringify(pushes.filter((e) => !e.part || !e.state || e.ok === false)).slice(0, 240));
    notes.push('qswatch: first pushes ' + QS_PARTS.map((p) => p + ' ' + seen[p]).join(', ') + ' ms');
    const again = await s.send('qswatch', { on: true, leaseMs: 5000 });
    check('renewing the lease does not restart the watch',
      again.ok === true && again.result.started === false && again.result.watching === true, JSON.stringify(again).slice(0, 200));
    const off = await s.send('qswatch', { on: false });
    check('qswatch off ends the lease at once', off.ok === true && off.result.leaseMs === 0 && off.result.watching === false,
      JSON.stringify(off).slice(0, 200));
    // A lease nobody renews ends the watch by itself (a dead panel cannot leave it running), and
    // the next on pushes every part again, so main's picture is whole after any gap.
    await s.send('qswatch', { on: true, leaseMs: 1000 });
    await sleep(2500);
    const p = await s.send('ping');
    const w = p.result && p.result.caches && p.result.caches.watch;
    const j = s.events.length;
    const back = await s.send('qswatch', { on: true, leaseMs: 5000 });
    const re = await eventAfter(j, (e) => e.ev === 'qs' && e.part === 'nightlight', 3000);
    check('a lapsed lease ends the watch by itself, and the next on pushes every part again',
      !!w && w.watching === false && back.ok === true && back.result.watching === true && !!re,
      JSON.stringify({ w, back, re }).slice(0, 260));
    await s.send('qswatch', { on: false });
  } catch (e) { check('qswatch', false, e.message); }
  for (const [extra, what] of [
    [{ on: 'yes' }, "qswatch {on:'yes'}"],
    [{ on: true, leaseMs: 10 }, 'qswatch {leaseMs:10}'],
    [{ on: true, leaseMs: 'long' }, "qswatch {leaseMs:'long'}"]
  ]) {
    try {
      const r = await s.send('qswatch', extra);
      check(what + ' is refused as a bad argument',
        r.ok === false && typeof r.error === 'string' && !r.error.includes('passive'), JSON.stringify(r));
    } catch (e) { check(what + ' is refused as a bad argument', false, e.message); }
  }

  // Switches run on their own lane (qs) since 2026-09-23: brightness sets used to queue on the
  // slow lane behind WMI and PowerShell reads.
  try {
    const parked = s.send('sleep', { lane: 'slow', ms: 2000 }, 8000);
    await sleep(50);
    const t = Date.now();
    const nl = await s.send('nightlight', { on: true }, 4000);
    const br = await s.send('brightness', { level: 50 }, 4000);
    const ms = Date.now() - t;
    check('night light and brightness switches answer while the slow lane is busy (' + ms + ' ms, budget 600)',
      nl.ok === false && /passive/.test(nl.error || '') && br.ok === false && /passive/.test(br.error || '') && ms < 600,
      JSON.stringify({ nl, br, ms }).slice(0, 260));
    await parked;
  } catch (e) { check('switches answer while the slow lane is busy', false, e.message); }
  try {
    const parked = s.send('sleep', { lane: 'qs', ms: 800 }, 8000);
    await sleep(50);
    const tS = Date.now();
    const sw = s.send('brightness', { level: 50 }, 4000).then((r) => ({ r, ms: Date.now() - tS }));
    const tR = Date.now();
    const rd = await s.send('brightness', {}, 4000);
    const rdMs = Date.now() - tR;
    const swr = await sw;
    check('with the qs lane parked, a brightness switch waits for it (' + swr.ms + ' ms) and a brightness read does not (' + rdMs + ' ms)',
      swr.r.ok === false && /passive/.test(swr.r.error || '') && swr.ms >= 450 && rd.ok === true && rdMs < 400,
      JSON.stringify({ sw: swr, rdMs }).slice(0, 260));
    const pr = await parked;
    check('the parked qs lane itself finished', pr.ok === true && pr.result && pr.result.lane === 'qs', JSON.stringify(pr));
  } catch (e) { check('the qs lane', false, e.message); }

  // ---- nothing secret in anything the sidecar printed -------------------------
  const printed = JSON.stringify(s.events) + s.stderr;
  check('no Wi-Fi key from these tests appears in the sidecar\'s logs or events',
    !printed.includes(secret) && !printed.includes('correct horse') && !printed.includes('short1'));
  return notes;
}

/*
 * THE FEATURE SEAM (wave 3, 2026-09-24): Features.cs in ping, feature commands falling through
 * Program.Run, and the feature chords in KeyMachine. The chords are proved the way Alt+Tab is -
 * `hotkey {op:'simulate'}` drives the PURE key machine with scripted keys - so not one real
 * keystroke is involved and no hook is ever installed (passive refuses to take a chord, below).
 * Step format: S = swallowed, D = partner key (0xFF) before it, P = passed, then the event.
 */
const VKS = {
  LWIN: 0x5B, LSHIFT: 0xA0, LCTRL: 0xA2, LALT: 0xA4, TAB: 0x09, S: 0x53, V: 0x56, Z: 0x5A, X: 0x58,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, PRTSC: 0x2C, VOLUP: 0xAF, VOLDOWN: 0xAE, MUTE: 0xAD, T: 0x54,
};
const CHORD_KEYS = {
  'Win+S': [VKS.S, false], 'Win+V': [VKS.V, false], 'Win+Tab': [VKS.TAB, false], 'Win+Left': [VKS.LEFT, false],
  'Win+Right': [VKS.RIGHT, false], 'Win+Up': [VKS.UP, false], 'Win+Down': [VKS.DOWN, false], 'Win+Z': [VKS.Z, false],
  'Win+Shift+S': [VKS.S, true],
};
const VOL_CHORDS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];   // bare keys (osd lane, 2026-09-24)
const ALL_CHORDS = Object.keys(CHORD_KEYS).concat(['PrintScreen'], VOL_CHORDS, ['Win+Alt+T']);   // Win+Alt+T: lane tbvideo, 2026-09-26
const ALL_KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const MOD_UP_VKS = new Set([VKS.LWIN, 0x5C, VKS.LALT, 0xA5, 0x12, VKS.LSHIFT, 0xA1, VKS.LCTRL, 0xA3]);

function kv(vk, down, o) { return Object.assign({ vk, down }, o || {}); }
function stepWords(st) {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  const tail = st.chord ? `:${st.chord}` : st.key ? `:${st.key}` :
    /^(open|next|prev|left|right|up|down|commit)$/.test(st.event) ? `:${st.sel}` : '';
  return `${head} ${st.event}${tail}`;
}

async function featureSeamChecks(s) {
  // ---- Features.cs: ping says what registered, and an unknown feature command is named ----
  try {
    const r = await s.send('ping');
    const f = r.ok && r.result ? r.result.features : null;
    check('ping has a features block: {commands:[], problems:[]}',
      !!f && Array.isArray(f.commands) && Array.isArray(f.problems), JSON.stringify(f));
    check('every registered feature command is named feature.verb',
      !!f && f.commands.every((n) => typeof n === 'string' && n.indexOf('.') > 0), JSON.stringify(f && f.commands));
    check('no feature file failed to register', !!f && f.problems.length === 0, JSON.stringify(f && f.problems));
  } catch (e) { check('ping (features block)', false, e.message); }
  try {
    const r = await s.send('x.y');
    check('an unknown feature command "x.y" says unknown command', r.ok === false && r.error === 'unknown command: x.y', JSON.stringify(r));
  } catch (e) { check('unknown feature command', false, e.message); }

  // ---- the chord protocol, before any key: names are checked, passive never takes one ----
  const REFUSAL = 'refused: sidecar is passive (test mode)';
  const want = async (name, extra, test) => {
    try {
      const r = await s.send('hotkey', extra);
      check(name, test(r), JSON.stringify(r).slice(0, 300));
    } catch (e) { check(name, false, e.message); }
  };
  await want('passive refuses to take a feature chord', { chords: ['Win+V'] }, (r) => r.ok === false && r.error === REFUSAL);
  await want('passive refuses to watch a key', { observe: ['VolumeUp'] }, (r) => r.ok === false && r.error === REFUSAL);
  await want('an unknown chord is named, with the known ones', { chords: ['Win+Q'] },
    (r) => r.ok === false && /unknown chord "Win\+Q"/.test(r.error) && /Win\+Shift\+S/.test(r.error) && /PrintScreen/.test(r.error));
  await want('an unknown observed key is named', { observe: ['VolumeLouder'] }, (r) => r.ok === false && /unknown key "VolumeLouder"/.test(r.error));
  await want('chords must be a list', { chords: 'Win+V' }, (r) => r.ok === false && /chords must be a list/.test(r.error));
  await want('status reports the (empty) chord and observe sets', { op: 'status' },
    (r) => r.ok === true && Array.isArray(r.result.chords) && r.result.chords.length === 0 &&
           Array.isArray(r.result.observe) && r.result.observe.length === 0 && r.result.installed === false);

  // ---- the key machine ----
  let modUps = 0;
  const sim = async (name, opts, events, wantSteps) => {
    let r;
    try { r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts || {})); } catch (e) { check(name, false, e.message); return; }
    if (!r.ok) { check(name, false, r.error); return; }
    const steps = r.result.steps;
    events.forEach((e, i) => {
      if (e.vk !== undefined && e.down === false && MOD_UP_VKS.has(e.vk)) {
        modUps++;
        check(`${name}: step ${i}, a modifier keyup, is never swallowed`, !steps[i].swallow, JSON.stringify(steps[i]));
      }
    });
    const got = steps.map(stepWords);
    check(`chords: ${name}`, JSON.stringify(got) === JSON.stringify(wantSteps), `got ${JSON.stringify(got)}, want ${JSON.stringify(wantSteps)}`);
  };
  const winD = kv(VKS.LWIN, true), winU = kv(VKS.LWIN, false);
  const shD = kv(VKS.LSHIFT, true), shU = kv(VKS.LSHIFT, false);

  // Every Win chord: taken when on (key down AND up swallowed, a partner key before the Win-up so
  // Start stays shut), untouched when off, and never with Ctrl or Alt held.
  for (const [chord, [vk, shift]] of Object.entries(CHORD_KEYS)) {
    const m = { win: true, shift };
    const press = shift
      ? [winD, shD, kv(vk, true, m), kv(vk, false, m), shU, winU]
      : [winD, kv(vk, true, m), kv(vk, false, m), winU];
    const took = shift ? ['P', 'P', `S chord:${chord}`, 'S', 'P', 'D'] : ['P', `S chord:${chord}`, 'S', 'D'];
    await sim(`${chord} is taken when on`, { chords: [chord] }, press, took);
    await sim(`${chord} is taken with every chord on`, { chords: ALL_CHORDS }, press, took);
    await sim(`${chord} is Windows' own when off`, { chords: [] }, press, press.map(() => 'P'));
    await sim(`Ctrl+${chord} is not ${chord}`, { chords: ALL_CHORDS },
      [kv(VKS.LCTRL, true), winD, kv(vk, true, Object.assign({ ctrl: true }, m)), kv(vk, false, m), winU, kv(VKS.LCTRL, false)],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim(`Alt+${chord} is not ${chord}`, { chords: ALL_CHORDS, altTab: false },
      [kv(VKS.LALT, true), winD, kv(vk, true, Object.assign({ alt: true }, m)), kv(vk, false, Object.assign({ alt: true }, m)), winU, kv(VKS.LALT, false)],
      ['P', 'P', 'P', 'P', 'P', 'P']);
  }
  await sim('PrintScreen is taken when on (no Win, so no partner key)', { chords: ['PrintScreen'] },
    [kv(VKS.PRTSC, true), kv(VKS.PRTSC, false)], ['S chord:PrintScreen', 'S']);
  await sim("PrintScreen is Windows' own when off", { chords: ['Win+S'] }, [kv(VKS.PRTSC, true), kv(VKS.PRTSC, false)], ['P', 'P']);
  await sim("Alt+PrintScreen (the active window) stays Windows'", { chords: ALL_CHORDS },
    [kv(VKS.LALT, true), kv(VKS.PRTSC, true, { alt: true }), kv(VKS.PRTSC, false, { alt: true }), kv(VKS.LALT, false)], ['P', 'P', 'P', 'P']);
  await sim("Win+PrintScreen (save to Pictures) stays Windows'", { chords: ALL_CHORDS },
    [winD, kv(VKS.PRTSC, true, { win: true }), kv(VKS.PRTSC, false, { win: true }), winU], ['P', 'P', 'P', 'P']);
  await sim("Shift+PrintScreen and Ctrl+PrintScreen stay Windows'", { chords: ALL_CHORDS },
    [shD, kv(VKS.PRTSC, true, { shift: true }), kv(VKS.PRTSC, false, { shift: true }), shU,
     kv(VKS.LCTRL, true), kv(VKS.PRTSC, true, { ctrl: true }), kv(VKS.PRTSC, false, { ctrl: true }), kv(VKS.LCTRL, false)],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);

  // Exact modifiers: the Shift variants are different chords (or none).
  await sim('Win+Shift+Left (move to the other monitor) does NOT match Win+Left', { chords: ['Win+Left'] },
    [winD, shD, kv(VKS.LEFT, true, { win: true, shift: true }), kv(VKS.LEFT, false, { win: true, shift: true }), shU, winU],
    ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('Win+Shift+Right/Up/Down are not chords even with every chord on', { chords: ALL_CHORDS },
    [winD, shD, kv(VKS.RIGHT, true, { win: true, shift: true }), kv(VKS.RIGHT, false, { win: true, shift: true }),
     kv(VKS.UP, true, { win: true, shift: true }), kv(VKS.UP, false, { win: true, shift: true }),
     kv(VKS.DOWN, true, { win: true, shift: true }), kv(VKS.DOWN, false, { win: true, shift: true }), shU, winU],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
  await sim('Win+Shift+S does not match Win+S', { chords: ['Win+S'] },
    [winD, shD, kv(VKS.S, true, { win: true, shift: true }), kv(VKS.S, false, { win: true, shift: true }), shU, winU],
    ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('Win+S does not match Win+Shift+S', { chords: ['Win+Shift+S'] },
    [winD, kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), winU], ['P', 'P', 'P', 'P']);
  await sim('with both on, each S goes to its own chord', { chords: ['Win+S', 'Win+Shift+S'] },
    [winD, kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), shD,
     kv(VKS.S, true, { win: true, shift: true }), kv(VKS.S, false, { win: true, shift: true }), shU, winU],
    ['P', 'S chord:Win+S', 'S', 'P', 'S chord:Win+Shift+S', 'S', 'P', 'D']);

  // Win+Alt+T (lane tbvideo, 2026-09-26: the top bar's hide / show): Alt is PART of this chord. Both
  // modifier keyups get the partner key (D), so neither Start nor the app's menu bar opens.
  const altD = kv(VKS.LALT, true), altU = kv(VKS.LALT, false);
  const wat = { win: true, alt: true };
  await sim('Win+Alt+T is taken when on (Win first); Alt-up and Win-up both get the partner key', { chords: ['Win+Alt+T'] },
    [winD, altD, kv(VKS.T, true, wat), kv(VKS.T, false, wat), altU, winU], ['P', 'P', 'S chord:Win+Alt+T', 'S', 'D', 'D']);
  await sim('Win+Alt+T is taken when on (Alt first), with every chord on', { chords: ALL_CHORDS },
    [altD, winD, kv(VKS.T, true, wat), kv(VKS.T, false, wat), winU, altU], ['P', 'P', 'S chord:Win+Alt+T', 'S', 'D', 'D']);
  await sim("Win+Alt+T is Windows' own when off", { chords: ['Win+S'] },
    [winD, altD, kv(VKS.T, true, wat), kv(VKS.T, false, wat), altU, winU], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim("Win+T (taskbar cycling) is not Win+Alt+T", { chords: ALL_CHORDS },
    [winD, kv(VKS.T, true, { win: true }), kv(VKS.T, false, { win: true }), winU], ['P', 'P', 'P', 'P']);
  await sim('Alt+T (an app menu key) is not Win+Alt+T', { chords: ALL_CHORDS, altTab: false },
    [altD, kv(VKS.T, true, { alt: true }), kv(VKS.T, false, { alt: true }), altU], ['P', 'P', 'P', 'P']);
  await sim('Ctrl+Win+Alt+T and Win+Alt+Shift+T are not Win+Alt+T', { chords: ALL_CHORDS, altTab: false },
    [kv(VKS.LCTRL, true), winD, altD, kv(VKS.T, true, Object.assign({ ctrl: true }, wat)), kv(VKS.T, false, wat), altU, winU, kv(VKS.LCTRL, false),
     winD, altD, shD, kv(VKS.T, true, Object.assign({ shift: true }, wat)), kv(VKS.T, false, wat), shU, altU, winU],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
  await sim('a plain T while Win+Alt+T is on is just a T', { chords: ALL_CHORDS }, [kv(VKS.T, true), kv(VKS.T, false)], ['P', 'P']);

  // Held Win, repeats, and keys already down.
  await sim('Win+S, S again with Win still held: two chords', { chords: ['Win+S'] },
    [winD, kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), winU],
    ['P', 'S chord:Win+S', 'S', 'S chord:Win+S', 'S', 'D']);
  await sim('auto-repeat of a taken chord is swallowed with no second event', { chords: ['Win+Left'] },
    [winD, kv(VKS.LEFT, true, { win: true }), kv(VKS.LEFT, true, { win: true }), kv(VKS.LEFT, true, { win: true }), kv(VKS.LEFT, false, { win: true }), winU],
    ['P', 'S chord:Win+Left', 'S', 'S', 'S', 'D']);
  await sim('a Tab held BEFORE Win stays a plain Tab to its keyup (no half keystroke)', { chords: ['Win+Tab'] },
    [kv(VKS.TAB, true), winD, kv(VKS.TAB, true, { win: true }), kv(VKS.TAB, false, { win: true }), winU],
    ['P', 'P', 'P', 'P', 'P']);
  await sim('an S held before Win is not Win+S; the next S press is', { chords: ['Win+S'] },
    [kv(VKS.S, true), winD, kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), winU],
    ['P', 'P', 'P', 'P', 'S chord:Win+S', 'S', 'D']);
  await sim('a chord whose keyup was never seen does not eat the next plain press', { chords: ['Win+S'] },
    [winD, kv(VKS.S, true, { win: true }), winU, kv(VKS.S, true), kv(VKS.S, false)],
    ['P', 'S chord:Win+S', 'D', 'P', 'P']);
  await sim('Win released before the chord key: the keyup still goes with its keydown', { chords: ['Win+V'] },
    [winD, kv(VKS.V, true, { win: true }), winU, kv(VKS.V, false)], ['P', 'S chord:Win+V', 'D', 'S']);

  // Everything that already worked still works with every chord on.
  await sim('Alt+Tab still works with every chord on', { chords: ALL_CHORDS, observe: ALL_KEYS },
    [kv(VKS.LALT, true), kv(VKS.TAB, true, { alt: true }), kv(VKS.TAB, false, { alt: true }), kv(VKS.LALT, false)],
    ['P', 'S open:1', 'S', 'D commit:1']);
  await sim('arrows inside an Alt+Tab still move the switcher, not Win+arrow', { chords: ALL_CHORDS },
    [kv(VKS.LALT, true), kv(VKS.TAB, true, { alt: true }), kv(VKS.TAB, false, { alt: true }),
     kv(VKS.RIGHT, true, { alt: true }), kv(VKS.RIGHT, false, { alt: true }), kv(VKS.LALT, false)],
    ['P', 'S open:1', 'S', 'S right:2', 'S', 'D commit:2']);
  await sim("Win+Alt+Tab stays Windows' with Win+Tab on", { chords: ['Win+Tab'] },
    [winD, kv(VKS.LALT, true), kv(VKS.TAB, true, { alt: true, win: true }), kv(VKS.TAB, false, { alt: true, win: true }), kv(VKS.LALT, false), winU],
    ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('Win+Tab is a chord while Alt+Tab is on too', { chords: ['Win+Tab'] },
    [winD, kv(VKS.TAB, true, { win: true }), kv(VKS.TAB, false, { win: true }), winU], ['P', 'S chord:Win+Tab', 'S', 'D']);
  await sim('a Win tap still opens the launcher with every chord on', { winTap: true, chords: ALL_CHORDS, observe: ALL_KEYS },
    [winD, winU], ['P', 'D wintap']);
  await sim('a Win hold that took a chord is not a tap', { winTap: true, chords: ALL_CHORDS },
    [winD, kv(VKS.Z, true, { win: true }), kv(VKS.Z, false, { win: true }), winU], ['P', 'S chord:Win+Z', 'S', 'D']);
  await sim('Win+N still opens notifications with every chord on', { winKeys: true, chords: ALL_CHORDS },
    [winD, kv(0x4E, true, { win: true }), kv(0x4E, false, { win: true }), winU], ['P', 'S winkey:n', 'S', 'D']);
  await sim('plain typing is untouched with every chord on', { chords: ALL_CHORDS, observe: ALL_KEYS },
    [kv(VKS.S, true), kv(VKS.S, false), kv(VKS.V, true), kv(VKS.V, false), kv(VKS.TAB, true), kv(VKS.TAB, false),
     kv(VKS.LEFT, true), kv(VKS.LEFT, false), kv(VKS.X, true), kv(VKS.X, false)],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);

  // Observed keys: reported on every keydown (repeats too), NEVER swallowed.
  for (const [name, vk] of [['VolumeUp', VKS.VOLUP], ['VolumeDown', VKS.VOLDOWN], ['VolumeMute', VKS.MUTE]]) {
    await sim(`${name} is reported and passed through, repeats included`, { observe: [name] },
      [kv(vk, true), kv(vk, true), kv(vk, false)], [`P key:${name}`, `P key:${name}`, 'P']);
    await sim(`${name} says nothing when not observed`, { observe: [] }, [kv(vk, true), kv(vk, false)], ['P', 'P']);
  }
  await sim('an observed key with Win held is still reported and passed', { observe: ALL_KEYS, winTap: true },
    [winD, kv(VKS.VOLUP, true, { win: true }), kv(VKS.VOLUP, false, { win: true }), winU], ['P', 'P key:VolumeUp', 'P', 'P']);
  // The volume keys as CHORDS (osd lane, 2026-09-24): Mantle takes them so Windows' flyout never
  // shows (its host cannot be found on 25H2 to hide it). Bare keys only; a held Up/Down REPEATS (one
  // event per auto-repeat, one step each, as Windows does); a held Mute is ONE toggle; unclaimed they
  // are never swallowed. Owen's two keyboards: the IdeaPad's built-in one (ACPI IDEA0102, PS/2:
  // Fn+F2/F3 with typematic repeat = many keydowns, one keyup) and the Logitech USB receiver's media
  // keys (HID consumer control, which may instead send a down/up per step). The hook sees both as
  // the same VKs (0xAF/0xAE/0xAD), so both patterns are rows here.
  const VOLS = [['VolumeUp', VKS.VOLUP], ['VolumeDown', VKS.VOLDOWN], ['VolumeMute', VKS.MUTE]];
  const MODS = [['Win', winD, winU, { win: true }], ['Shift', shD, shU, { shift: true }],
    ['Ctrl', kv(VKS.LCTRL, true), kv(VKS.LCTRL, false), { ctrl: true }], ['Alt', kv(VKS.LALT, true), kv(VKS.LALT, false), { alt: true }]];
  for (const [name, vk] of VOLS) {
    const others = ALL_CHORDS.filter((c) => c !== name);
    await sim(`${name} is taken when claimed (no Win, so no partner key)`, { chords: [name] },
      [kv(vk, true), kv(vk, false)], [`S chord:${name}`, 'S']);
    await sim(`${name} is taken with every chord on and every key observed`, { chords: ALL_CHORDS, observe: ALL_KEYS },
      [kv(vk, true), kv(vk, false)], [`S chord:${name}`, 'S']);
    await sim(`${name} is never swallowed when not claimed (every other chord on)`, { chords: others },
      [kv(vk, true), kv(vk, true), kv(vk, false)], ['P', 'P', 'P']);
    await sim(`${name} not claimed but observed: reported and passed`, { chords: others, observe: [name] },
      [kv(vk, true), kv(vk, false)], [`P key:${name}`, 'P']);
    for (const [mod, d, u, m] of MODS) {
      await sim(`${mod}+${name} stays Windows'`, { chords: ALL_CHORDS },
        [d, kv(vk, true, m), kv(vk, false, m), u], ['P', 'P', 'P', 'P']);
    }
    await sim(`an injected ${name} (an OEM hotkey tool, Mantle's own keys) is never taken`, { chords: ALL_CHORDS },
      [kv(vk, true, { injected: true }), kv(vk, false, { injected: true })], ['I', 'I']);
  }
  await sim('laptop keyboard: a held Volume Up steps on EVERY repeat, its one keyup swallowed', { chords: VOL_CHORDS },
    [kv(VKS.VOLUP, true), kv(VKS.VOLUP, true), kv(VKS.VOLUP, true), kv(VKS.VOLUP, true), kv(VKS.VOLUP, false)],
    ['S chord:VolumeUp', 'S chord:VolumeUp', 'S chord:VolumeUp', 'S chord:VolumeUp', 'S']);
  await sim('laptop keyboard: a held Volume Down steps on every repeat', { chords: VOL_CHORDS },
    [kv(VKS.VOLDOWN, true), kv(VKS.VOLDOWN, true), kv(VKS.VOLDOWN, true), kv(VKS.VOLDOWN, false)],
    ['S chord:VolumeDown', 'S chord:VolumeDown', 'S chord:VolumeDown', 'S']);
  await sim('a held Mute is ONE toggle: its repeats are swallowed with no event', { chords: VOL_CHORDS },
    [kv(VKS.MUTE, true), kv(VKS.MUTE, true), kv(VKS.MUTE, true), kv(VKS.MUTE, false)], ['S chord:VolumeMute', 'S', 'S', 'S']);
  await sim('USB media keys: a down/up per step is one step each', { chords: VOL_CHORDS },
    [kv(VKS.VOLUP, true), kv(VKS.VOLUP, false), kv(VKS.VOLUP, true), kv(VKS.VOLUP, false), kv(VKS.VOLDOWN, true), kv(VKS.VOLDOWN, false)],
    ['S chord:VolumeUp', 'S', 'S chord:VolumeUp', 'S', 'S chord:VolumeDown', 'S']);
  await sim('Volume Down pressed while Volume Up is held: each its own event, both keyups swallowed', { chords: VOL_CHORDS },
    [kv(VKS.VOLUP, true), kv(VKS.VOLUP, true), kv(VKS.VOLDOWN, true), kv(VKS.VOLDOWN, false), kv(VKS.VOLUP, false)],
    ['S chord:VolumeUp', 'S chord:VolumeUp', 'S chord:VolumeDown', 'S', 'S']);
  await sim("a volume key that began with Win held stays Windows' to its keyup, repeats included", { chords: VOL_CHORDS },
    [winD, kv(VKS.VOLUP, true, { win: true }), winU, kv(VKS.VOLUP, true), kv(VKS.VOLUP, false)], ['P', 'P', 'P', 'P', 'P']);
  await sim('Shift pressed while a taken Volume Up is held: that repeat is a fresh press, not a chord', { chords: VOL_CHORDS },
    [kv(VKS.VOLUP, true), shD, kv(VKS.VOLUP, true, { shift: true }), kv(VKS.VOLUP, false, { shift: true }), shU],
    ['S chord:VolumeUp', 'P', 'P', 'P', 'P']);
  await sim('the volume chords leave Win chords, Alt+Tab and typing alone', { chords: VOL_CHORDS, winTap: true },
    [winD, kv(VKS.S, true, { win: true }), kv(VKS.S, false, { win: true }), winU, kv(VKS.LALT, true), kv(VKS.TAB, true, { alt: true }),
     kv(VKS.TAB, false, { alt: true }), kv(VKS.LALT, false), kv(VKS.X, true), kv(VKS.X, false)],
    ['P', 'P', 'P', 'P', 'P', 'S open:1', 'S', 'D commit:1', 'P', 'P']);
  await sim('injected keys never reach a chord', { chords: ALL_CHORDS },
    [winD, kv(VKS.S, true, { win: true, injected: true }), kv(VKS.S, false, { win: true, injected: true }), winU], ['P', 'I', 'I', 'P']);
  try {
    const r = await s.send('hotkey', { op: 'simulate', events: [], chords: ['Win+Nope'] });
    check('simulate names an unknown chord', r.ok === false && /unknown chord "Win\+Nope"/.test(r.error), JSON.stringify(r));
  } catch (e) { check('simulate unknown chord', false, e.message); }
  // 40 on 2026-09-24. Fewer means scenarios stopped running, not that the rule got easier.
  check(`chords: every Win/Alt/Shift/Ctrl keyup passed through (${modUps} of them)`, modUps >= 40, `only ${modUps} were exercised`);
}

/*
 * TBHIDE (TaskbarHide.cs, 2026-09-25): while Mantle runs, the Windows taskbar gets an EMPTY WINDOW
 * REGION, so the reveals Explorer does on a foreground change are never seen. Against Owen's machine
 * this is READ ONLY: on/off are refused in passive, the decision logic is proved with made-up window
 * states (`decide`), and the one live read is `status`. The guard process is run with
 * --guard-dry-run against a throwaway node child, so it decides and writes its note but never calls
 * SetWindowRgn - and the live Shell_TrayWnd is never touched by this file.
 */
async function tbhideChecks(s) {
  let note = null;
  for (const extra of [{ on: true }, { on: false }]) {
    try {
      const r = await s.send('tbhide', extra);
      check(`tbhide ${JSON.stringify(extra)} is refused in passive, with a reason`,
        r.ok === false && typeof r.error === 'string' && r.error.includes('passive') && r.error.includes('taskbar'),
        JSON.stringify(r));
    } catch (e) { check(`tbhide ${JSON.stringify(extra)} refused in passive`, false, e.message); }
  }
  try {
    const r = await s.send('tbhide', {});
    check('tbhide without on: says what it needs', r.ok === false && /on:true/.test(r.error || ''), JSON.stringify(r));
  } catch (e) { check('tbhide without on: says what it needs', false, e.message); }

  // THE DECISION TABLE, one made-up taskbar window at a time.
  const table = [
    [{ want: true, kind: 'none' }, 'apply', 'no region yet: set the empty one'],
    [{ want: true, kind: 'empty' }, 'keep', 'ours, or a dead Mantle\'s: taken over, never stacked'],
    [{ want: true, kind: 'shaped' }, 'yield', 'another program shaped the taskbar: never fought'],
    [{ want: true, kind: 'gone' }, 'leave', 'Explorer restarting: the replacement is caught next pass'],
    [{ want: false, kind: 'empty', mayRelease: true }, 'release', 'our own region on the way out'],
    [{ want: false, kind: 'empty', mayRelease: false }, 'leave', 'another live Mantle holds it: a test sidecar exiting never un-hides the live one'],
    [{ want: false, kind: 'none', mayRelease: true }, 'leave', 'nothing to undo'],
    [{ want: false, kind: 'shaped', mayRelease: true }, 'leave', 'not Mantle\'s shape: never cleared'],
    [{ want: false, kind: 'gone', mayRelease: true }, 'leave', 'window gone'],
  ];
  for (const [input, want, why] of table) {
    try {
      const r = await s.send('tbhide', { decide: [input] });
      const d = r.ok && r.result && Array.isArray(r.result.decisions) ? r.result.decisions[0] : null;
      check(`tbhide decides "${want}" for ${JSON.stringify(input)} (${why})`,
        d && d.action === want && typeof d.reason === 'string' && d.reason.length > 10, JSON.stringify(r).slice(0, 240));
    } catch (e) { check(`tbhide decide ${JSON.stringify(input)}`, false, e.message); }
  }

  // THE SUMMARY: invisible only when EVERY taskbar window is, and the reason names the one that is not.
  const sums = [
    ['both monitors hidden', [{ kind: 'none' }, { kind: 'empty', class: 'Shell_SecondaryTrayWnd' }],
      (d) => d.applied === true && /invisible/.test(d.reason) && /2 taskbar windows/.test(d.reason)],
    ['a secondary taskbar someone else shaped keeps it from claiming success',
      [{ kind: 'none' }, { kind: 'shaped', class: 'Shell_SecondaryTrayWnd' }],
      (d) => d.applied === false && d.reason.includes('Shell_SecondaryTrayWnd') && /another program/.test(d.reason)],
    ['a region Windows did not take is reported, not claimed', [{ kind: 'none', okAfter: false }],
      (d) => d.applied === false && /did not take/.test(d.reason)],
    ['no taskbar window at all says so', [],
      (d) => d.applied === false && /no taskbar window/.test(d.reason)],
  ];
  for (const [name, list, ok] of sums) {
    try {
      const r = await s.send('tbhide', { decide: list });
      check(`tbhide summary: ${name}`, r.ok === true && r.result && ok(r.result), JSON.stringify(r).slice(0, 300));
    } catch (e) { check(`tbhide summary: ${name}`, false, e.message); }
  }
  try {
    const r = await s.send('tbhide', { decide: [{ kind: 'hidden' }] });
    check('tbhide decide refuses an unknown kind with the allowed ones',
      r.ok === false && /none, empty, shaped or gone/.test(r.error || ''), JSON.stringify(r));
  } catch (e) { check('tbhide decide refuses an unknown kind', false, e.message); }

  // STATUS: a read of the live taskbar windows' region kinds, nothing more.
  try {
    const r = await s.send('tbhide', { status: true });
    const d = r.ok ? r.result : null;
    check('tbhide status reads the taskbar windows in passive and changes nothing',
      d && d.on === false && d.applied === false && Array.isArray(d.windows) &&
      d.windows.every((w) => ['none', 'empty', 'shaped', 'gone'].includes(w.region) && /Shell_(Secondary)?TrayWnd/.test(w.class)),
      JSON.stringify(r).slice(0, 300));
    if (d) note = `tbhide: ${d.windows.length} taskbar window(s), regions ${d.windows.map((w) => w.region).join('/')}; ` +
      `another sidecar holding one: ${d.otherHolder || 'none'}; ${table.length} decisions + ${sums.length} summaries checked`;
  } catch (e) { check('tbhide status', false, e.message); }

  await tbhideGuardChecks();
  return note;
}

/** The guard, dry-run: it must stay up while its sidecar lives, and act (on paper) the moment it dies. */
async function tbhideGuardChecks() {
  const note = path.join(os.tmpdir(), `mantle-tbguard-test-${process.pid}.log`);
  try { fs.unlinkSync(note); } catch (_) { /* none */ }
  const target = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const guard = spawn(EXE, [`--taskbar-guard=${target.pid}`, '--guard-dry-run', `--guard-note=${note}`], { stdio: 'ignore' });
  const exited = new Promise((resolve) => guard.on('exit', (code) => resolve(code)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(900);
    check('tbhide guard stays up while the process it guards is alive', guard.exitCode === null,
      `exit code ${guard.exitCode}`);
    target.kill();
    const code = await Promise.race([exited, sleep(4000).then(() => 'timeout')]);
    check('tbhide guard exits by itself once the guarded process dies', code === 0, `exit ${code}`);
    let text = '';
    try { text = fs.readFileSync(note, 'utf8'); } catch (_) { /* missing */ }
    check('tbhide guard (dry run) leaves a note saying what it found, and touched nothing',
      new RegExp(`sidecar ${target.pid} exited`).test(text) && /dry run|belongs to live sidecar/.test(text), text.trim());
  } catch (e) {
    check('tbhide guard dry run', false, e.message);
  } finally {
    try { target.kill(); } catch (_) { /* gone */ }
    try { guard.kill(); } catch (_) { /* gone */ }
  }
  // Nothing to guard: says so and exits 2 instead of waiting forever.
  try {
    const g = spawn(EXE, [`--taskbar-guard=${target.pid}`, '--guard-dry-run', `--guard-note=${note}`], { stdio: 'ignore' });
    const code = await Promise.race([new Promise((r) => g.on('exit', r)), sleep(4000).then(() => 'timeout')]);
    if (code === 'timeout') { try { g.kill(); } catch (_) { /* gone */ } }
    const text = fs.readFileSync(note, 'utf8');
    check('tbhide guard with nothing to watch exits 2 and says why',
      code === 2 && /was not running/.test(text), `exit ${code}: ${text.trim().split('\n').pop()}`);
  } catch (e) { check('tbhide guard with nothing to watch', false, e.message); }
  try { fs.unlinkSync(note); } catch (_) { /* gone */ }
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

  // ---- the feature seam: Features.cs in ping, unknown feature commands, the chord machine ----
  await featureSeamChecks(s);

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

  // ---- battery (Battery.cs, 2026-09-23) ---------------------------------
  // READ ONLY: GetSystemPowerStatus and CallNtPowerInformation, and a watch that only listens.
  // The readout used Win32_Battery, which said 71 where Windows said 72 and "charging" for any
  // laptop on AC; these rows hold the sidecar to what Windows itself reports.
  try {
    const times = [];
    let r = null;
    for (let k = 0; k < 9; k++) {
      const t = Date.now();
      r = await s.send('battery');
      times.push(Date.now() - t);
    }
    times.sort((a, b) => a - b);
    const d = r.ok ? r.result : null;
    check('battery reads with the full shape',
      r.ok === true && d && d.ok === true && (d.present === null || typeof d.present === 'boolean') &&
      (d.percent === null || (Number.isInteger(d.percent) && d.percent >= 0 && d.percent <= 100)) &&
      (d.ac === null || typeof d.ac === 'boolean') && typeof d.charging === 'boolean' && typeof d.saver === 'boolean' &&
      (d.secondsLeft === null || (Number.isInteger(d.secondsLeft) && d.secondsLeft > 0)) &&
      (d.reason === null || typeof d.reason === 'string') && !!d.raw && typeof d.raw === 'object',
      JSON.stringify(r).slice(0, 320));
    if (d && d.raw) {
      check('battery never passes an "unknown" on as a value (255 %, a -1 / 0xFFFFFFFF lifetime)',
        d.percent !== 255 && d.secondsLeft !== -1 && d.secondsLeft !== 4294967295 &&
        (d.raw.lifePercent !== 255 || d.percent === null) && (d.raw.lifeTime !== 4294967295 || d.secondsLeft === null),
        JSON.stringify({ percent: d.percent, secondsLeft: d.secondsLeft, raw: d.raw }));
      check('battery gives a time left only on battery', d.ac !== true || d.secondsLeft === null, JSON.stringify(d).slice(0, 200));
      if (d.raw.ntCharging !== null) {
        check('battery: charging agrees with the kernel\'s own SYSTEM_BATTERY_STATE.Charging',
          d.charging === d.raw.ntCharging, JSON.stringify(d.raw));
      }
      quickNotes.push('battery: present=' + d.present + ' percent=' + d.percent + ' ac=' + d.ac + ' charging=' + d.charging +
        ' secondsLeft=' + d.secondsLeft + ' saver=' + d.saver + ' flag=' + d.raw.flag +
        (d.capacity ? ' mWh=' + d.capacity.remaining + '/' + d.capacity.full + ' rate=' + d.capacity.rate + 'mW' : '') +
        ' read median ' + times[4] + ' ms' + (d.reason ? ' reason=' + JSON.stringify(d.reason) : ''));
    }
  } catch (e) { check('battery reads with the full shape', false, e.message); }

  // The same Windows call, read independently (.NET's PowerStatus in PowerShell), then the sidecar
  // straight after: the two must agree. Once more if the percentage moved in between.
  try {
    let agree = false, detail = '';
    for (let attempt = 0; attempt < 2 && !agree; attempt++) {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.SystemInformation]::PowerStatus; ' +
        '"{0} {1} {2}" -f [int][Math]::Round($p.BatteryLifePercent * 100), $p.PowerLineStatus, [int]$p.BatteryChargeStatus'],
        { encoding: 'utf8', timeout: 20000 });
      const r = await s.send('battery');
      const m = /(\d+) (\w+) (\d+)/.exec(ps.stdout || '');
      if (!m || !r.ok) { detail = 'powershell: ' + JSON.stringify((ps.stdout || ps.stderr || '').trim()) + ' sidecar: ' + JSON.stringify(r).slice(0, 160); continue; }
      const d = r.result, pct = Number(m[1]), flags = Number(m[3]);
      const want = {
        percent: pct > 100 ? null : pct,
        ac: m[2] === 'Online' ? true : m[2] === 'Offline' ? false : null,
        charging: flags !== 255 && (flags & 8) !== 0
      };
      agree = d.percent === want.percent && d.ac === want.ac && d.charging === want.charging;
      detail = 'Windows ' + JSON.stringify(want) + ' sidecar ' + JSON.stringify({ percent: d.percent, ac: d.ac, charging: d.charging });
    }
    check('battery agrees with Windows\' own PowerStatus, read independently', agree, detail);
  } catch (e) { check('battery agrees with Windows\' own PowerStatus', false, e.message); }

  try {
    const r = await s.send('power');
    const d = r.ok ? r.result : null;
    check('power carries the battery reading too (one reading for the panel and the readout)',
      !!d && typeof d.charging === 'boolean' && 'ac' in d && 'secondsLeft' in d && typeof d.onBattery === 'boolean',
      JSON.stringify(r).slice(0, 220));
  } catch (e) { check('power carries the battery reading too', false, e.message); }

  // The watch: armed with all three notifications, and the path proven end to end by the push
  // Windows sends at registration (measured 6 ms after arming, 2026-09-23). Passive is fine: it
  // listens and changes nothing.
  try {
    const r = await s.send('battery', { watch: true });
    const d = r.ok ? r.result : null;
    check('battery {watch:true} arms, with ac, percent and saver all registered',
      !!d && d.watching === true && Array.isArray(d.registered) &&
      ['ac', 'percent', 'saver'].every((n) => d.registered.indexOf(n) >= 0) && d.watchReason === null,
      JSON.stringify(r).slice(0, 320));
    let ev = null, evErr = '';
    try { ev = await s.waitEvent('battery', 3000); } catch (e) { evErr = e.message; }
    check('the watch delivers a push through its window (Windows notifies at registration)',
      !!ev && typeof ev.via === 'string' && ev.ok === true && typeof ev.charging === 'boolean' && 'percent' in ev,
      ev ? JSON.stringify(ev).slice(0, 200) : evErr);
    const again = await s.send('battery', { watch: true });
    check('arming the watch twice is harmless (the same three registrations)',
      again.ok === true && again.result.watching === true && again.result.registered.length === 3, JSON.stringify(again).slice(0, 200));
    const off = await s.send('battery', { watch: false });
    check('battery {watch:false} stops the watch',
      off.ok === true && off.result.watching === false && off.result.registered.length === 0, JSON.stringify(off).slice(0, 200));
  } catch (e) { check('battery watch', false, e.message); }

  try {
    const r = await s.send('battery', { watch: 'yes' });
    check("battery {watch:'yes'} is refused as a bad argument",
      r.ok === false && typeof r.error === 'string' && r.error.includes('watch') && !r.error.includes('passive'), JSON.stringify(r));
  } catch (e) { check("battery {watch:'yes'} is refused", false, e.message); }

  // Every switch, refused - and the refusal must SAY it is passive.
  for (const [cmd, extra] of [
    ['wifi', { on: true }],
    ['wifi', { on: false }],
    ['bluetooth', { on: true }],
    ['brightness', { level: 50 }],
    ['nightlight', { on: true }]
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
    ['brightness', { level: 500 }, 'brightness {level:500}'],
    ['nightlight', { on: 'yes' }, "nightlight {on:'yes'}"]
  ]) {
    try {
      const r = await s.send(cmd, extra);
      check(`${what} is refused as a bad argument`,
        r.ok === false && typeof r.error === 'string' && !r.error.includes('passive'), JSON.stringify(r));
    } catch (e) { check(`${what} is refused as a bad argument`, false, e.message); }
  }

  // Energy saver: Windows has no public switch (powrprof.dll exports only the power-mode overlay,
  // checked 2026-09-23), so the sidecar says so and the panel opens its Settings page. Night light
  // became a real switch the same day (refused above, as every switch is in passive).
  try {
    const r = await s.send('power', { saver: true });
    check('power {saver} says plainly that Windows has no public switch for it',
      r.ok === true && r.result && r.result.ok === false &&
      typeof r.result.reason === 'string' && r.result.reason.includes('no public switch'),
      JSON.stringify(r));
  } catch (e) { check('power {saver} says Windows has no public switch', false, e.message); }

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

  const tbhideNote = await tbhideChecks(s);

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
                              'nightlight', 'power', 'battery', 'hittest', 'raise', 'windows', 'glass', 'place']
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

  // ---- Wi-Fi networks, output devices, the mixer (qsx lane, 2026-09-23) --
  // See qsxChecks: reads, refusals and profile XML only, plus writes to a
  // silent audio session this harness starts and stops itself.
  const qsxNotes = await qsxChecks(s);

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
    // Alt+Tab and Win+N / Win+A ride the same hook (Hotkey.cs, AltTab.cs; lib/switcher.test.js)
    ['hotkey', { altTab: true }],
    ['hotkey', { winKeys: true }],
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
  for (const n of qsxNotes) console.log('  note: ' + n);
  if (tbhideNote) console.log("  note: " + tbhideNote);
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  FAIL: harness crashed: ' + (e && e.stack ? e.stack : e));
  console.log(`SIDECAR TEST: ${passed} passed, ${failures.length + 1} failed`);
  process.exit(1);
});
