'use strict';
/*
 * lib/spotify-launch.test.js - Spotify from a pin or the launcher starts WITH Up next's port
 * (lib/spotify-launch.js, its launcher-index.js hook, and apps.js passing the switch through).
 *
 *   node lib/spotify-launch.test.js
 *
 * Plain node, no deps. NOTHING IS STARTED, CLOSED OR RESTARTED: every process call goes to a mock
 * proc, and the launcher-index checks are dry runs. One summary line:
 * "spotify-launch tests: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sl = require('./spotify-launch');
const { FLAG, defaultExe } = require('./features/_spotify-app.js');
const { matchSpotify, launchSpotifyWithPort, isSpotifyAumid } = sl;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const J = (x) => JSON.stringify(x);

const EXE = 'C:\\Users\\tester\\AppData\\Roaming\\Spotify\\Spotify.exe';
const SPOTIFY_LNK = 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify.lnk';

/* A realProc-shaped mock: records every call, starts nothing. */
/* spotpid lane: every close a mock proc is asked for (by name or by pid), across the whole file: a pin
   or launcher start must never close Spotify, so this stays empty. */
const closeAsks = [];
function mockProc({ exists = true, pids = [], runningThrows = null, launchResult = { ok: true, pid: 4242 } } = {}) {
  const calls = { exists: 0, running: 0, launch: [] };
  const asked = (verb) => async (pid) => { closeAsks.push([verb, pid]); return { out: '', err: 'the test refuses every close' }; };
  return {
    calls,
    exists(exe) { calls.exists++; return typeof exists === 'function' ? exists(exe) : exists; },
    async running() { calls.running++; if (runningThrows) throw new Error(runningThrows); return pids; },
    async launch(exe, args) { calls.launch.push({ exe, args }); return launchResult; },
    close: asked('close'), kill: asked('kill'), closePid: asked('closePid'), killPid: asked('killPid'),
  };
}
/* A mock .lnk resolver: a map from lnk path to what it points at, counting reads. */
function mockResolver(map) {
  const fn = (lnk) => { fn.reads.push(lnk); return Object.prototype.hasOwnProperty.call(map, lnk) ? map[lnk] : null; };
  fn.reads = [];
  return fn;
}

(async () => {
  /* ------------------------------------------------------------ the matcher */
  {
    const r = mockResolver({});
    const m = matchSpotify({ exe: EXE.toLowerCase(), target: EXE, args: '', lnkPath: 'C:\\pins\\Spotify.lnk' }, { exe: EXE, resolveLnk: r });
    check('pin with the Spotify.exe path (lowercased exe): match via exe', m.match && m.via === 'exe', J(m));
    check('...and the already-resolved pin is not read again', r.reads.length === 0, J(r.reads));
  }
  {
    const old = process.env.APPDATA;
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    const m = matchSpotify({ target: '%APPDATA%\\Spotify\\Spotify.exe' }, { exe: EXE, resolveLnk: mockResolver({}) });
    check('a %APPDATA% target is expanded before comparing', m.match && m.via === 'target', J(m));
    process.env.APPDATA = old;
  }
  {
    const m = matchSpotify({ path: '"' + EXE.toUpperCase() + '"' }, { exe: EXE, resolveLnk: mockResolver({}) });
    check('a quoted, upper-case path that IS Spotify.exe matches', m.match && m.via === 'path', J(m));
  }
  {
    const r = mockResolver({ [SPOTIFY_LNK]: EXE });
    const m = matchSpotify({ path: SPOTIFY_LNK }, { exe: EXE, resolveLnk: r });
    check('a .lnk whose target is Spotify.exe (mock resolver, string): match via lnk', m.match && m.via === 'lnk', J(m));
    check('...the resolver was asked once, for that .lnk', r.reads.length === 1 && r.reads[0] === SPOTIFY_LNK, J(r.reads));
  }
  {
    const m = matchSpotify({ path: SPOTIFY_LNK }, { exe: EXE, resolveLnk: mockResolver({ [SPOTIFY_LNK]: { target: EXE, args: '' } }) });
    check('a .lnk resolved to {target, args:""}: match', m.match && m.via === 'lnk', J(m));
  }
  {
    const m = matchSpotify({ path: SPOTIFY_LNK }, { exe: EXE, resolveLnk: mockResolver({ [SPOTIFY_LNK]: { target: EXE, args: '--minimized' } }) });
    check('a Spotify .lnk with its OWN arguments is left alone (its args are never dropped)', !m.match, J(m));
    const p = matchSpotify({ exe: EXE.toLowerCase(), target: EXE, args: '--uri=spotify:x' }, { exe: EXE, resolveLnk: mockResolver({}) });
    check('...same for a pin with arguments', !p.match, J(p));
  }
  {
    const r = mockResolver({ 'C:\\pins\\Spotify.lnk': EXE });
    const m = matchSpotify({ exe: null, target: null, args: '', lnkPath: 'C:\\pins\\Spotify.lnk' }, { exe: EXE, resolveLnk: r });
    check('a pin whose resolution came back empty (target:null) is not re-read', !m.match && r.reads.length === 0, J({ m, reads: r.reads }));
  }
  {
    const throwing = () => { throw new Error('bad lnk'); };
    const m = matchSpotify({ path: 'C:\\x\\Broken.lnk' }, { exe: EXE, resolveLnk: throwing });
    check('a resolver that throws is "not Spotify", not a crash', !m.match, J(m));
  }
  /* other apps untouched */
  {
    const r = mockResolver({ 'C:\\sm\\Notepad.lnk': 'C:\\Windows\\System32\\notepad.exe', 'C:\\sm\\Spotify (fake).lnk': 'C:\\Games\\Spotify.exe' });
    const cases = [
      { exe: 'c:\\program files\\google\\chrome\\application\\chrome.exe', target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: '', lnkPath: 'C:\\pins\\Google Chrome.lnk' },
      { path: 'C:\\sm\\Notepad.lnk' },
      { path: 'C:\\sm\\Spotify (fake).lnk' },                     // a DIFFERENT Spotify.exe
      { target: 'C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.2.3.0_x64__zpdnekdrzrea0\\Spotify.exe' },
      { exe: null, target: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', args: '', lnkPath: 'C:\\pins\\File Explorer.lnk' },
      { aumid: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },    // the Store build
      { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
      { path: 'C:\\Users\\tester\\Documents\\Spotify.exe.txt' },
      {}, null,
    ];
    const bad = cases.filter((c) => matchSpotify(c, { exe: EXE, resolveLnk: r }).match);
    check('other apps (Chrome, Notepad, a different Spotify.exe, the Store build, File Explorer, junk) do not match', bad.length === 0, J(bad));
  }
  /* AUMIDs */
  {
    const old = process.env.APPDATA;
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    check('AUMID = the exe path (Get-StartApps on Owen\'s machine)', isSpotifyAumid(EXE, EXE));
    check('AUMID = {RoamingAppData}\\Spotify\\Spotify.exe', isSpotifyAumid('{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}\\Spotify\\Spotify.exe', EXE));
    check('AUMID = bare "Spotify.exe" (what the media session reports)', isSpotifyAumid('spotify.EXE', EXE));
    check('AUMID of the Store build does not count', !isSpotifyAumid('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', EXE));
    check('an unknown known-folder GUID does not count', !isSpotifyAumid('{00000000-0000-0000-0000-000000000000}\\Spotify\\Spotify.exe', EXE));
    const m = matchSpotify({ exe: null, target: null, lnkPath: null, aumid: EXE }, { exe: EXE, resolveLnk: mockResolver({}) });
    check('a pin that is only an AUMID for Spotify matches via aumid', m.match && m.via === 'aumid', J(m));
    process.env.APPDATA = old;
  }

  /* ------------------------------------------------------------ the launch decision */
  {
    const proc = mockProc({ pids: [] });
    const bus = new (require('events').EventEmitter)();
    const heard = [];
    bus.on('launched', (e) => heard.push(e));
    const r = await launchSpotifyWithPort({ path: SPOTIFY_LNK }, { exe: EXE, proc, bus, source: 'the launcher', resolveLnk: mockResolver({ [SPOTIFY_LNK]: EXE }) });
    check('Spotify not running: started WITH the flag', r.handled && r.ok && r.action === 'launched' && r.pid === 4242, J(r));
    check('...exactly once, as exe + [FLAG] + HIDDEN_ARGS (spothide: --minimized --disable-gpu)', proc.calls.launch.length === 1 && proc.calls.launch[0].exe === EXE
      && J(proc.calls.launch[0].args) === J([FLAG, '--minimized', '--disable-gpu']) && FLAG === '--remote-debugging-port=47292', J(proc.calls.launch));
    check('...and the pid is announced on the launch bus for the feature to hide', heard.length === 1 && heard[0].pid === 4242 && heard[0].source === 'the launcher' && /hides its window/.test(r.hide), J({ heard, hide: r.hide }));
    const proc2 = mockProc({ pids: [] });
    const r2 = await launchSpotifyWithPort({ path: SPOTIFY_LNK }, { exe: EXE, proc: proc2, bus: new (require('events').EventEmitter)(), resolveLnk: mockResolver({ [SPOTIFY_LNK]: EXE }) });
    check('...with nothing listening, the answer says the window stays minimized', r2.handled && /nothing was listening/.test(r2.hide), J(r2));
  }
  {
    const proc = mockProc({ pids: [1234, 5678] });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc });
    check('Spotify ALREADY running: no flagged launch (the caller brings it forward)', !r.handled && r.spotify && r.running && r.quiet && proc.calls.launch.length === 0, J({ r, calls: proc.calls }));
    // spotfix lane: said on the bus as "opening", so the feature stops hiding a window Owen asked to see
    const bus = new (require('events').EventEmitter)();
    const heard = [], launched = [];
    bus.on('opening', (e) => heard.push(e));
    bus.on('launched', (e) => launched.push(e));
    const r2 = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc, bus, source: 'the pinned icon' });
    check('...and "opening" is said on the launch bus (no "launched")', !r2.handled && r2.running && heard.length === 1 && heard[0].source === 'the pinned icon' && !launched.length, J({ heard, launched }));
  }
  {
    const proc = mockProc({ pids: [] });
    const r = await launchSpotifyWithPort({ exe: 'c:\\windows\\notepad.exe', target: 'C:\\Windows\\notepad.exe', args: '' }, { exe: EXE, proc });
    check('another app: not handled, and the process is never even looked at', !r.handled && !r.spotify && !r.why
      && proc.calls.exists === 0 && proc.calls.running === 0 && proc.calls.launch.length === 0, J({ r, calls: proc.calls }));
  }
  {
    const proc = mockProc({ pids: [] });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc, dryRun: true });
    check('dry run (--test): says the flagged command, starts nothing', r.handled && r.dryRun && r.reason.includes(FLAG) && r.reason.includes(EXE)
      && proc.calls.launch.length === 0, J({ r, calls: proc.calls }));
  }
  {
    const proc = mockProc({ pids: [] });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc, enabled: false });
    check('Spotify queue off: opens the normal way, quietly, nothing looked at', !r.handled && r.spotify && r.quiet
      && proc.calls.running === 0 && proc.calls.launch.length === 0, J({ r, calls: proc.calls }));
  }
  {
    const proc = mockProc({ runningThrows: 'tasklist failed (boom)' });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc });
    check('tasklist failed: no flagged launch, and the reason is NOT quiet', !r.handled && !r.quiet && /boom/.test(r.why) && proc.calls.launch.length === 0, J(r));
  }
  {
    const proc = mockProc({ exists: false });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc });
    check('exe missing: normal open, says so', !r.handled && !r.quiet && /not on disk/.test(r.why) && proc.calls.running === 0, J(r));
  }
  {
    const proc = mockProc({ pids: [], launchResult: { ok: false, reason: 'ENOENT' } });
    const r = await launchSpotifyWithPort({ exe: EXE.toLowerCase(), target: EXE, args: '' }, { exe: EXE, proc });
    check('flagged start refused: falls back to the normal open, with the reason', !r.handled && !r.quiet && /ENOENT/.test(r.why), J(r));
  }

  /* ------------------------------------------------------------ the default .lnk reader, read-only */
  {
    const real = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Spotify.lnk');
    if (fs.existsSync(real) && fs.existsSync(defaultExe())) {
      const m = matchSpotify({ path: real });
      check('this machine\'s Start Menu Spotify.lnk (read, never opened) resolves to the Spotify.exe the card starts', m.match && m.via === 'lnk', J(m));
    } else {
      console.log('skip: no Start Menu Spotify.lnk / Spotify.exe on this machine');
    }
  }

  /* ------------------------------------------------------------ launcher-index.js hook (dry runs only) */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-spl-'));
    const lnk = path.join(tmp, 'Spotify.lnk');
    const other = path.join(tmp, 'Notepad.lnk');
    fs.writeFileSync(lnk, 'not a real shortcut: the resolver is mocked');
    fs.writeFileSync(other, 'not a real shortcut: the resolver is mocked');
    const orig = sl.launchSpotifyWithPort;
    let proc = mockProc({ pids: [] });
    let seen = 0;
    sl.launchSpotifyWithPort = (t, o) => { seen++; return orig(t, Object.assign({}, o, { exe: EXE, proc, resolveLnk: mockResolver({ [lnk]: EXE, [other]: 'C:\\Windows\\notepad.exe' }) })); };
    try {
      const idx = require('./launcher-index');
      const base = await idx.launch({ kind: 'app', path: other }, { dryRun: true });
      const withSwitch = await idx.launch({ kind: 'app', path: other }, { dryRun: true, spotifyPort: true });
      check('launcher: another app\'s dry run is byte-for-byte the same with the switch on', J(base) === J(withSwitch), J({ base, withSwitch }));

      const off = await idx.launch({ kind: 'app', path: lnk }, { dryRun: true });
      check('launcher: switch off (queue off / old caller): Spotify is not even checked', seen === 1 && !off.reason.includes(FLAG), J({ seen, off }));

      const on = await idx.launch({ kind: 'app', path: lnk }, { dryRun: true, spotifyPort: true });
      check('launcher: Spotify row, not running, dry run says the flagged start', on.ok && on.reason.includes(FLAG) && proc.calls.launch.length === 0, J(on));

      proc = mockProc({ pids: [99] });
      const running = await idx.launch({ kind: 'app', path: lnk }, { dryRun: true, spotifyPort: true });
      check('launcher: Spotify row while Spotify runs: the ordinary open, no note', J(running) === J(off) && proc.calls.launch.length === 0, J({ running, off }));

      proc = mockProc({ runningThrows: 'no tasklist' });
      const failed = await idx.launch({ kind: 'app', path: lnk }, { dryRun: true, spotifyPort: true });
      check('launcher: a failed check shows its reason under the row', failed.ok && /no tasklist/.test(failed.reason) && !failed.reason.includes(FLAG), J(failed));
    } finally {
      sl.launchSpotifyWithPort = orig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------ apps.js passes the switch through */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-spl-apps-'));
    const fake = path.join(tmp, 'fake-index.js');
    fs.writeFileSync(fake, [
      "'use strict';",
      'module.exports = {',
      "  build: async () => ({ items: [{ id: 'app:x', kind: 'app', name: 'X', path: 'C:\\\\x.lnk' }], sources: [] }),",
      '  search: () => [],',
      '  launch: async (item, opts) => { module.exports.seen.push(opts); return { ok: true }; },',
      '  seen: [],',
      '};',
    ].join('\n'));
    try {
      const { Apps } = require('./apps');
      const apps = new Apps({ modulePath: fake, icon: async () => null });
      await apps.index();
      await apps.launch('app:x', { dryRun: true, spotifyPort: true });
      const seen1 = require(fake).seen.slice();
      await apps.launch('app:x', { dryRun: true });
      const seen2 = require(fake).seen.slice();
      check('apps.js hands spotifyPort:true to launch()', seen1.length === 1 && seen1[0].spotifyPort === true && seen1[0].dryRun === true, J(seen1));
      check('apps.js without the switch hands spotifyPort:false', seen2.length === 1 && seen2[0].spotifyPort === false, J(seen2));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /* spotpid lane: a pin or launcher start never closes Spotify, by name or by pid (only the card's Quit
     and Restart do, by the main pid: lib/features/_spotify-app.js) */
  check('no pin or launcher path asked any mock proc to close Spotify', closeAsks.length === 0, J(closeAsks));
  {
    const src = fs.readFileSync(path.join(__dirname, 'spotify-launch.js'), 'utf8');
    const CLOSES = /taskkill|\.(closePid|killPid)\(|proc\.(close|kill)\(/g;
    check('spotify-launch.js has no taskkill and asks its proc for no close of its own', !CLOSES.test(src), (src.match(CLOSES) || []).join(','));
  }

  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`spotify-launch tests: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => {
  console.log(`FAIL the test file threw: ${(e && e.stack) || e}`);
  console.log(`spotify-launch tests: ${passed} passed, ${failures.length + 1} failed`);
  process.exitCode = 1;
});
