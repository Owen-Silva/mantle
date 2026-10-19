'use strict';
/*
 * player.e2e.test.js - Mantle Player END TO END in a hidden, MUTED --test Mantle of this checkout (lane
 * mantle-player2, 2026-10-17). Modelled on emoji.e2e.test.js: the instance is spawned with a DevTools port,
 * the bar page calls main's commands (player.*, files.*, apps.*, settings.open, theme.set) and the player page
 * (ui/player) is driven over CDP: its real buttons are clicked, its real key handler gets the keys, pointer
 * input on the seek and volume bars is CDP mouse input. window.__player (test only) exposes the page state.
 *
 *   node lib/features/player.e2e.test.js [--shots=<dir>]   -> "PLAYER E2E TEST: n passed, m failed"
 *
 * Media: lib/features/fixtures/player (tools/make-player-fixtures.js), copied to a temp folder that
 * MANTLE_PLAYER_TEST_ROOTS names as the Music and Videos library, so nothing of Owen's is read.
 *
 * NOTHING REACHES OWEN:
 *   - the window is alpha 0, click-through and off-screen (lib/test-quiet.js, player.js place());
 *   - SILENCE: main mutes the player's WebContents in --test (setAudioMuted). teststate.audioMuted is read
 *     after EVERY phase, including while the page itself is unmuted, and every sample must be true. The
 *     fixtures are a -30 dBFS sine on top of that;
 *   - media keys are off in --test (main.js, HardwareMediaKeyHandling), so his live bar never sees this session;
 *   - full screen is state only (never a real full-screen window), Open with / Show in Files / the launcher
 *     launch are dry runs, and Settings' "Use Mantle Player" is a dry run proven to call reg.exe ZERO times
 *     (teststate.regCalls) with the HKCU keys it would write read before and after: unchanged.
 *
 * FORMAT REALITY: each video fixture is also played raw in a scratch muted <video> on the player page, and the
 * player's verdict (can it play: yes, or "can't play" + reason) must match what Electron actually decoded.
 *
 * SKIPS, with the reason printed, and counts as no failure: on CI and when a game is running.
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'playere2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const FIX = path.join(__dirname, 'fixtures', 'player');
const MEDIA = path.join(os.tmpdir(), 'mantle-player-e2e-media');
const MUSIC = path.join(MEDIA, 'music'), VIDEOS = path.join(MEDIA, 'videos');
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice('--shots='.length) || null;
const V = (n) => path.join(VIDEOS, n), A = (n) => path.join(MUSIC, n);

let passed = 0; const failures = []; const result = { formats: {}, silence: [] };
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(step || 150); } }
/* a game: the shared game guard's flag, or a game exe running. The Riot CLIENT alone is not one: it idles in
   the tray for hours after Valorant closes */
function gaming() {
  if (fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.gaming'))) return 1;
  try {
    const n = spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-Process 'VALORANT*','League of Legends','FortniteClient-Win64-Shipping','RocketLeague','cs2','r5apex','GTA5','Overwatch','Minecraft*','RobloxPlayerBeta' -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true });
    return parseInt((n.stdout || '').trim(), 10) || 0;
  } catch (_) { return -1; }
}
const freeGb = () => { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8', timeout: 20000, windowsHide: true }); return (Number((r.stdout || '').trim()) || 0) / 1048576; };

/* the HKCU keys and values "Use Mantle Player" WOULD write (lib/features/_player-assoc.js plan) */
const REG_PROBES = [
  ['HKCU\\Software\\Mantle\\Player'], ['HKCU\\Software\\Classes\\MantlePlayer.Video'], ['HKCU\\Software\\Classes\\MantlePlayer.Audio'],
  ['HKCU\\Software\\RegisteredApplications', 'Mantle Player'], ['HKCU\\Software\\Classes\\.mp4\\OpenWithProgids', 'MantlePlayer.Video'], ['HKCU\\Software\\Classes\\.mp3\\OpenWithProgids', 'MantlePlayer.Audio'],
];
function regSnapshot() {
  return REG_PROBES.map(([k, v]) => {
    const r = spawnSync('reg', ['query', k].concat(v ? ['/v', v] : []), { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return `${k}${v ? ' /v ' + v : ''}: ${r.status === 0 ? 'present ' + (r.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 200) : 'absent'}`;
  });
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { MANTLE_PLAYER_TEST_ROOTS: `music=${MUSIC};videos=${VIDEOS}` });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
delete env.MANTLE_PLAYER_DRYRUN;  // the dry run must come from --test itself
function freshMedia() {
  fs.rmSync(MEDIA, { recursive: true, force: true });
  for (const d of ['music', 'videos']) {
    fs.mkdirSync(path.join(MEDIA, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(FIX, d))) fs.copyFileSync(path.join(FIX, d, f), path.join(MEDIA, d, f));
  }
}
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  // a fresh player: no saved queue, state, resume spots, playlists or library cache
  try { for (const f of fs.readdirSync(path.join(USER_DATA, 'features'))) if (/^player/i.test(f)) fs.rmSync(path.join(USER_DATA, 'features', f), { recursive: true, force: true }); } catch (_) { /* first run */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', '--theme=light'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let n = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++n; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { url: t.url, ev, send, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;
const J = JSON.stringify;

let skipped = null;
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }
  const minGb = process.env.MANTLE_TEST_MIN_FREE_GB !== undefined && process.env.MANTLE_TEST_MIN_FREE_GB !== '' ? Number(process.env.MANTLE_TEST_MIN_FREE_GB) : 1.5;
  if (!await until(() => freeGb() >= minGb, 600000, 15000)) { check(`at least ${minGb} GB free to start a test instance`, false, freeGb().toFixed(2) + ' GB free'); return; }
  freshMedia();
  const regBefore = regSnapshot();
  const run = launch();
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 60000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null, 40000, 300);
    if (!check('the bar page is up (main\'s commands are called from it)', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 15000, 200);
    const st = () => bar.ev(call('player.teststate'));
    const s0 = await until(async () => { const s = await st(); return s && s.ok && typeof s.hasWindow === 'boolean' ? s : null; }, 30000, 400);
    if (!check('player.teststate answers (the feature is installed and on in --test)', !!s0, await st())) return;
    check('no player window before anything opens it (made on demand)', s0.hasWindow === false, s0);
    check('the library roots come from MANTLE_PLAYER_TEST_ROOTS (2: Music, Videos)', s0.libraryRoots === 2, s0);
    const silent = async (label) => { const s = await st(); result.silence.push({ label, muted: s && s.audioMuted, audible: s && s.audible }); return s; };

    // ===================== the launcher row (a dry run in --test: it names what it would open)
    await bar.ev(call('apps.index', {}));
    const hits = await bar.ev(call('apps.search', { q: 'media player' }));
    const rows = Array.isArray(hits) ? hits : (hits && (hits.items || hits.results)) || [];
    const firstApp = rows.find((r) => r && (r.kind === 'app' || r.path));
    check('launcher: "media player" finds Mantle Player first', firstApp && firstApp.name === 'Mantle Player' && firstApp.path === 'mantle:player', rows.slice(0, 3).map((r) => ({ name: r.name, path: r.path, kind: r.kind })));
    const hits2 = await bar.ev(call('apps.search', { q: 'player' }));
    check('launcher: "player" lists Mantle Player', (Array.isArray(hits2) ? hits2 : []).some((r) => r && r.name === 'Mantle Player'), (Array.isArray(hits2) ? hits2 : []).slice(0, 4).map((r) => r.name));
    if (firstApp) {
      const lr = await bar.ev(call('apps.launch', { id: firstApp.id }));
      check('launcher: running the row (dry run) would open Mantle\'s player window', lr && lr.ok !== false && /would open Mantle's player window/.test(lr.reason || JSON.stringify(lr)), lr);
    }

    // ===================== Mantle Files' Open with: Mantle Player first, and it opens the file
    const fw = await bar.ev(call('files.open', {}));
    if (check('Files: a Files window opens to ask from', fw && fw.ok && fw.w !== undefined, fw)) {
      const hd = await bar.ev(call('files.handlers', { w: fw.w, path: V('clip-h264.mp4') }));
      check('Files: Open with lists Mantle Player FIRST for a video', hd && hd.ok && hd.handlers && hd.handlers[0] && hd.handlers[0].name === 'Mantle Player' && hd.handlers[0].handler === 'mantle:player', hd && { ok: hd.ok, reason: hd.reason, first: (hd.handlers || []).slice(0, 2).map((x) => x.name) });
      const hs = await bar.ev(call('files.handlers', { w: fw.w, path: V('clip-h264.srt') }));
      check('Files: ... but not for a subtitle file', hs && !(hs.handlers || []).some((x) => x && x.handler === 'mantle:player'), hs && (hs.handlers || []).slice(0, 2).map((x) => x.name));
      const ow = await bar.ev(call('files.openwith', { w: fw.w, path: V('clip-h264.mp4'), handler: 'mantle:player' }));
      check('Files: Open with > Mantle Player answers ok', ow && ow.ok === true, ow);
      await bar.ev(call('files.win', { w: fw.w, op: 'close' }));
    }
    const s1 = await until(async () => { const s = await st(); return s && s.hasWindow && s.opens >= 1 ? s : null; }, 15000, 200);
    check('the player window was made by Files\' Open with', !!s1, await st());
    check('SILENCE: the player\'s WebContents is muted from its first moment', s1 && s1.audioMuted === true, s1);
    check('the window is never really full screen or on top in --test', s1 && s1.nativeFull === false, s1);
    const plT = await until(async () => (await targets(port)).find((t) => /\/ui\/player\//.test(t.url)) || null, 15000, 200);
    if (!check('the player page is reachable over CDP', !!plT)) return;
    let pl = await attach(plT); open.push(pl);
    if (!check('the page booted in test mode (window.__player)', !!await until(() => pl.ev('!!window.__player'), 15000, 150))) return;
    const P = 'window.__player';
    const now = () => pl.ev(`(() => { const p = ${P}, v = p.v; return { name: p.S.cur && p.S.cur.name, kind: p.S.cur && p.S.cur.kind, index: p.S.index, n: p.S.items.length, paused: v.paused, t: v.currentTime, d: v.duration, vol: v.volume, muted: v.muted, rate: v.playbackRate, nope: !document.getElementById('nope').hidden, nopeh: document.getElementById('nopeh').textContent, nopep: document.getElementById('nopep').textContent, verdict: p.S.verdict && p.S.verdict.state, err: v.error && v.error.code, toast: document.getElementById('toast').hidden ? null : document.getElementById('toastt').textContent, view: p.S.view, cls: document.documentElement.className }; })()`);
    const playingNamed = (name, minT) => until(async () => { const x = await now(); return x.name === name && !x.paused && x.t > (minT || 0.15) ? x : null; }, 12000, 120);
    const click = (id) => pl.ev(`(() => { const b = document.getElementById(${J(id)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const key = (k, o) => pl.ev(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${J(k)}, bubbles: true, cancelable: true }, ${J(o || {})})))`);
    const rect = (id) => pl.ev(`(() => { const r = document.getElementById(${J(id)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    async function mouseAt(id, f) {
      const r = await rect(id); const x = r.x + r.w * f, y = r.y + r.h / 2;
      await pl.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await pl.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await pl.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    async function shot(name) {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await sleep(450);   // the CSS transitions settle
      const r = await pl.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    }

    // ===================== playing what Files opened: the folder is the queue
    const p0 = await playingNamed('clip-h264.mp4');
    check('it plays clip-h264.mp4 (H.264/AAC MP4)', !!p0, await now());
    const q0 = await pl.ev(`${P}.S.items.map((p) => p.split('\\\\').pop())`);
    check('the play queue is the whole Videos folder in name order (7 videos, the .srt left out)', J(q0) === J(['broken.mp4', 'clip-2audio.mp4', 'clip-h264.mkv', 'clip-h264.mp4', 'clip-hevc.mp4', 'clip-mjpeg.avi', 'clip-vp9.webm']), q0);
    check('the video kind is on the page (root .video)', p0 && /\bvideo\b/.test(p0.cls), p0 && p0.cls);
    // media session: the metadata Windows' flyout and Mantle's bar read
    const md = await pl.ev(`(() => { const m = navigator.mediaSession.metadata; return m ? { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length, state: navigator.mediaSession.playbackState, handlers: Object.keys(${P}.MS).sort() } : null; })()`);
    check('media session: title = the file name, artist "Mantle Player", album = the folder', md && md.title === 'clip-h264' && md.artist === 'Mantle Player' && md.album === 'videos', md);
    check('media session: playbackState "playing"', md && md.state === 'playing', md);
    check('media session: play, pause, stop, previous, next, seek back/forward/to are all handled', md && J(md.handlers) === J(['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto', 'stop']), md && md.handlers);
    // subtitles: the sidecar .srt, on by default
    const sub0 = await until(() => pl.ev(`(() => { const ts = ${P}.textTracks(); const c = ts[0] && ts[0].activeCues; return ts.length === 1 && ts[0].mode === 'showing' && c && c.length ? { n: ts.length, label: ts[0].label, cue: c[0].text } : null; })()`), 8000, 150);
    check('subtitles: clip-h264.srt is loaded and showing ("The first line" at ~1 s)', sub0 && sub0.cue === 'The first line', sub0 || await pl.ev(`${P}.textTracks().map((t) => ({ mode: t.mode, label: t.label, cues: t.cues && t.cues.length }))`));
    check('subtitles: the CC button is on', await pl.ev(`document.getElementById('cc').getAttribute('aria-pressed')`) === 'true');
    await shot('mantle-player-video-light');
    // play / pause: the button, Space, and the media session's own handlers
    await click('play');
    const pz = await until(async () => { const x = await now(); return x.paused ? x : null; }, 3000, 80);
    check('play/pause button: pauses', !!pz, await now());
    check('... and says "Play (Space)", media session "paused"', await pl.ev(`document.getElementById('play').title + '|' + navigator.mediaSession.playbackState`) === 'Play (Space)|paused');
    await key(' ');
    check('Space plays again', !!await until(async () => { const x = await now(); return !x.paused ? x : null; }, 3000, 80));
    await pl.ev(`${P}.MS.pause()`);
    check('media session pause handler pauses', !!await until(async () => { const x = await now(); return x.paused ? x : null; }, 3000, 80));
    await pl.ev(`${P}.MS.play()`);
    check('media session play handler plays', !!await until(async () => { const x = await now(); return !x.paused ? x : null; }, 3000, 80));
    await pl.ev(`${P}.MS.seekto({ seekTime: 12 })`);
    check('media session seekto moves to 12 s', !!await until(async () => { const x = await now(); return x.t >= 11.9 && x.t < 13.5 ? x : null; }, 3000, 80), await now());
    await click('play'); await until(async () => (await now()).paused, 2000, 80);
    // seeking: keys, digits, and a real pointer click on the bar
    let t0 = (await now()).t;
    await key('ArrowRight');
    check('ArrowRight seeks +5 s', !!await until(async () => { const x = await now(); return Math.abs(x.t - (t0 + 5)) < 0.3 ? x : null; }, 2000, 60), { t0, now: (await now()).t });
    t0 = (await now()).t; await key('j');
    check('J seeks -10 s', !!await until(async () => { const x = await now(); return Math.abs(x.t - (t0 - 10)) < 0.3 ? x : null; }, 2000, 60), { t0, now: (await now()).t });
    await key('5');
    check('5 jumps to half way (15 s of 30)', !!await until(async () => { const x = await now(); return Math.abs(x.t - x.d / 2) < 0.3 ? x : null; }, 2000, 60), await now());
    await mouseAt('bar', 0.25);
    const sk = await until(async () => { const x = await now(); return Math.abs(x.t - x.d * 0.25) < 1 ? x : null; }, 2000, 60);
    check('a pointer click at a quarter of the seek bar seeks there (~7.5 s)', !!sk, await now());
    check('... and the readout follows', /^0:0[6-8]$/.test(await pl.ev(`document.getElementById('tcur').textContent`)), await pl.ev(`document.getElementById('tcur').textContent`));
    // volume and mute: the page's own controls (the WebContents stays muted underneath, whatever they say)
    await mouseAt('vol', 0.3);
    const vz = await until(async () => { const x = await now(); return Math.abs(x.vol - 0.3) < 0.04 ? x : null; }, 2000, 60);
    check('a pointer click at 30% of the volume bar sets the volume ~0.30', !!vz, await now());
    await key('ArrowUp');
    check('ArrowUp: +5% volume', !!await until(async () => { const x = await now(); return Math.abs(x.vol - (vz ? vz.vol + 0.05 : 0.35)) < 0.02 ? x : null; }, 2000, 60), await now());
    await click('mute');
    const mu = await now();
    check('the mute button mutes the page (aria-pressed, "Unmute (M)")', mu.muted === true && await pl.ev(`document.getElementById('mute').getAttribute('aria-pressed') + '|' + document.getElementById('mute').title`) === 'true|Unmute (M)', mu);
    await key('m');
    const um = await now();
    check('M unmutes the page', um.muted === false, um);
    const sUn = await silent('page unmuted');
    check('SILENCE holds while the page is UNMUTED: the WebContents is still muted', sUn && sUn.audioMuted === true, sUn);
    const saved = await bar.ev(call('player.state', {}));
    check('volume and mute are saved (player.state)', saved && saved.ok && Math.abs(saved.state.volume - um.vol) < 0.011 && saved.state.muted === false, saved);
    // speed: the menu and the > key
    await click('speed');
    const sm = await pl.ev(`Array.from(document.querySelectorAll('#menu .mi')).map((b) => b.textContent)`);
    check('the speed menu lists 0.25x to 2x', sm.length === 8 && sm.includes('Normal') && sm.includes('1.5×'), sm);
    await pl.ev(`Array.from(document.querySelectorAll('#menu .mi')).find((b) => b.textContent === '1.5×').click()`);
    check('picking 1.5x sets the rate and the button says 1.5×', (await now()).rate === 1.5 && await pl.ev(`document.getElementById('speed').textContent`) === '1.5×');
    await key('>');
    check('> steps up to 1.75x, with a toast', (await now()).rate === 1.75 && /Speed 1\.75×/.test((await now()).toast || ''), await now());
    await key('<'); await key('<');
    await click('speed'); await pl.ev(`Array.from(document.querySelectorAll('#menu .mi')).find((b) => b.textContent === 'Normal').click()`);
    check('Normal puts the rate back to 1', (await now()).rate === 1);
    // subtitles: the CC menu and C
    await click('cc');
    const cm = await pl.ev(`Array.from(document.querySelectorAll('#menu .mi')).map((b) => b.textContent)`);
    check('the subtitles menu: Off + the .srt track', cm.length === 2 && cm[0] === 'Off', cm);
    await pl.ev(`document.querySelector('#menu .mi').click()`);
    check('Off turns them off (track disabled, CC not pressed)', await pl.ev(`${P}.textTracks()[0].mode + '|' + document.getElementById('cc').getAttribute('aria-pressed')`) === 'disabled|false');
    await key('c');
    check('C turns them back on', await pl.ev(`${P}.textTracks()[0].mode`) === 'showing');
    await click('play'); await sleep(400); await click('play');   // playing, then paused again for full screen

    // ===================== full screen (state only in --test) and the controls hiding
    await key('f');
    const fs1 = await until(async () => { const s = await st(); return s.full ? s : null; }, 3000, 80);
    check('F: full screen on (state), never a real full-screen window', fs1 && fs1.nativeFull === false && /\bfull\b/.test(await pl.ev('document.documentElement.className')), fs1);
    await click('play');
    const idle = await until(() => pl.ev(`document.documentElement.classList.contains('idle') ? getComputedStyle(document.getElementById('transport')).opacity : null`), 5000, 150);
    check('full screen + playing: the controls hide after the mouse rests (root.idle)', idle !== null, await pl.ev('document.documentElement.className'));
    await sleep(500);
    check('... and the transport is see-through', Number(await pl.ev(`getComputedStyle(document.getElementById('transport')).opacity`)) < 0.05);
    await pl.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 200 });
    check('moving the mouse brings them back', !await pl.ev(`document.documentElement.classList.contains('idle')`));
    await click('play');
    await sleep(3000);
    check('paused: they stay (no idle while paused)', !await pl.ev(`document.documentElement.classList.contains('idle')`));
    await key('Escape');
    check('Esc leaves full screen', !!await until(async () => { const s = await st(); return !s.full ? s : null; }, 3000, 80) && !/\bfull\b/.test(await pl.ev('document.documentElement.className')));
    await silent('full screen');

    // ===================== format reality: what this Electron decodes, raw, against the player's verdict
    const files = ['clip-h264.mp4', 'clip-vp9.webm', 'clip-h264.mkv', 'clip-hevc.mp4', 'clip-2audio.mp4', 'clip-mjpeg.avi', 'broken.mp4'];
    for (const f of files) {
      const pr = await pl.ev(call('player.prepare', { path: V(f) }));
      const raw = await pl.ev(`new Promise((done) => {
        const t = document.createElement('video'); t.muted = true; t.preload = 'auto'; t.style.cssText = 'position:fixed;left:-9999px;width:160px;height:90px';
        document.body.appendChild(t);
        const end = (r) => { clearTimeout(to); clearInterval(iv); const q = t.getVideoPlaybackQuality ? t.getVideoPlaybackQuality() : {}; const o = Object.assign({ w: t.videoWidth, h: t.videoHeight, t: +t.currentTime.toFixed(2), frames: q.totalVideoFrames || 0, err: t.error ? t.error.code : null, msg: t.error ? String(t.error.message).slice(0, 160) : null }, r); t.pause(); t.removeAttribute('src'); t.load(); t.remove(); done(o); };
        t.addEventListener('error', () => end({ plays: false }));
        const iv = setInterval(() => { const q = t.getVideoPlaybackQuality(); if (t.videoWidth > 0 && t.currentTime > 0.5 && q.totalVideoFrames > 2) end({ plays: true }); }, 100);
        const to = setTimeout(() => end({ plays: false, timeout: true }), 8000);
        t.src = ${J(pr && pr.url)}; t.play().catch(() => {});
      })`);
      const verdict = pr && pr.ok ? await pl.ev(`window.MantlePlayerProbe.verdict(${J(pr.probe)}, ${P}.can)`) : { state: 'no', reason: pr && pr.reason };
      const mime = await pl.ev(`(() => { const c = ${J(pr && pr.probe ? pr.probe.tracks.filter((x) => x.type === 'video').map((x) => x.codec) : [])}; return c.map((k) => k + ':' + (window.MantlePlayerProbe.CODECS[k] && window.MantlePlayerProbe.CODECS[k].mime ? document.createElement('video').canPlayType(window.MantlePlayerProbe.CODECS[k].mime) || '(empty)' : 'no mime')).join(',') })()`);
      result.formats[f] = { raw, verdict: verdict.state, reason: verdict.reason, canPlayType: mime, container: pr && pr.probe && pr.probe.container };
      console.log(`info: format ${f}: raw ${raw.plays ? 'PLAYS' : 'does not play'} (${raw.w}x${raw.h}, ${raw.frames} frames, t ${raw.t}${raw.err ? ', error ' + raw.err + ' ' + raw.msg : ''}${raw.timeout ? ', timed out' : ''}); canPlayType ${mime || '-'}; verdict ${verdict.state}${verdict.reason ? ': ' + verdict.reason : ''}`);
    }
    // in the player itself: every file either plays, or shows "Can't play" with its reason
    for (const f of files) {
      await bar.ev(call('player.open', { paths: [V(f)], via: 'e2e' }));
      const out = await until(async () => { const x = await now(); if (x.name !== f && !(x.nope && x.nopeh.includes(f))) return null; if (x.nope) return x; return !x.paused && x.t > 0.3 ? x : null; }, 10000, 120);
      const raw = result.formats[f].raw;
      result.formats[f].player = out ? (out.nope ? 'cant: ' + out.nopep : 'plays') : 'neither';
      check(`${f}: the player's answer matches reality (raw ${raw.plays ? 'plays' : 'does not'})`, out && (raw.plays ? !out.nope : out.nope), out || await now());
      if (out && out.nope) check(`${f}: "Can't play" says why in words (no raw codes)`, out.nopep.length > 20 && !/MEDIA_ERR|PIPELINE_ERROR|DEMUXER_ERROR|0x[0-9a-f]{4}/i.test(out.nopep), out.nopep);
    }
    // the unplayable file's three ways out
    await bar.ev(call('player.open', { paths: [V('clip-mjpeg.avi')], via: 'e2e' }));
    const avi = await until(async () => { const x = await now(); return x.nope && x.nopeh.includes('clip-mjpeg.avi') ? x : null; }, 6000, 100);
    check('the AVI: "Can\'t play clip-mjpeg.avi" names the container and the codec', avi && /AVI/.test(avi.nopep) && /Motion JPEG/.test(avi.nopep), avi);
    check('... with Open with, Show in Files and Skip offered', await pl.ev(`['nopewith','nopefiles','nopeskip'].map((i) => document.getElementById(i).hidden).join()`) === 'false,false,false');
    await click('nopewith');
    check('Open with (dry run) says what it would do', !!await until(async () => /would show Windows' Open with/.test((await now()).toast || ''), 3000, 80), await now());
    await click('nopefiles');
    check('Show in Files (dry run) says what it would do', !!await until(async () => /would show it in Mantle Files/.test((await now()).toast || ''), 3000, 80), await now());
    await click('nopeskip');
    check('Skip goes on to the next item (clip-vp9.webm)', !!await playingNamed('clip-vp9.webm'), await now());
    await silent('formats');

    // ===================== next / previous / shuffle / repeat over the 7-item folder queue
    await bar.ev(call('player.resume', { path: V('clip-h264.mp4'), t: 0, d: 30, now: true }));   // no resume spot in the way
    await bar.ev(call('player.open', { paths: [V('clip-h264.mkv')], via: 'e2e' }));
    await until(async () => (await now()).name === 'clip-h264.mkv', 6000, 100);
    const nx = await pl.ev(`(() => { document.getElementById('next').click(); return ${P}.S.index; })()`);
    check('Next: the next item in the queue (index 2 -> 3, clip-h264.mp4)', nx === 3 && !!await until(async () => (await now()).name === 'clip-h264.mp4', 5000, 80), { nx, now: await now() });
    await until(() => pl.ev(`${P}.v.readyState >= 1`), 4000, 60); await sleep(150);
    await pl.ev(`${P}.v.currentTime = 6`); await sleep(150);
    const pr0 = await pl.ev(`(() => { document.getElementById('prev').click(); return ${P}.S.index; })()`);
    check('Previous after 3 s: starts this item again (same index, back to 0)', pr0 === 3 && !!await until(async () => (await now()).t < 1.5, 2000, 60), { pr0, now: await now() });
    await pl.ev(`${P}.v.currentTime = 1`); await sleep(100);
    const pv = await pl.ev(`(() => { document.getElementById('prev').click(); return ${P}.S.index; })()`);
    check('Previous in the first 3 s: the item before (index 2)', pv === 2, pv);
    await until(async () => (await now()).name === 'clip-h264.mkv', 5000, 80);
    await pl.ev(`${P}.MS.nexttrack()`);
    check('media session next: index 3', await pl.ev(`${P}.S.index`) === 3);
    await pl.ev(`${P}.MS.previoustrack()`);
    check('media session previous: index 2', !!await until(async () => (await pl.ev(`${P}.S.index`)) === 2, 2000, 60));
    await click('shuf');
    const sh = await pl.ev(`(() => { const o = ${P}.S.state.shuffle; document.getElementById('next').click(); return { on: o, order: ${P}.S.order, index: ${P}.S.index, pressed: document.getElementById('shuf').getAttribute('aria-pressed') }; })()`);
    check('Shuffle on: a full random order that starts at the current item, and Next follows it', sh.on === true && sh.pressed === 'true' && Array.isArray(sh.order) && sh.order.length === 7 && J(sh.order.slice().sort()) === J([0, 1, 2, 3, 4, 5, 6]) && sh.order[0] === 2 && sh.index === sh.order[1], sh);
    await key('s');
    check('S turns shuffle off (with a toast)', await pl.ev(`${P}.S.state.shuffle`) === false && /Shuffle off/.test((await now()).toast || ''));
    const reps = [];
    for (let i = 0; i < 3; i++) { await click('rep'); reps.push(await pl.ev(`${P}.S.state.repeat + '|' + document.getElementById('rep').title`)); }
    check('Repeat cycles off -> all -> this one -> off, and says so', J(reps) === J(['all|Repeat: all (R)', 'one|Repeat: this one (R)', 'off|Repeat: off (R)']), reps);
    // the end of the queue: off stops with a word; all wraps
    await bar.ev(call('player.open', { paths: [V('clip-vp9.webm')], via: 'e2e' }));
    await playingNamed('clip-vp9.webm');
    await click('next');
    check('Next on the last item, repeat off: it says it was the last one', !!await until(async () => /last item in the play queue/.test((await now()).toast || ''), 2000, 60), await now());
    await click('rep');   // all
    const wrap = await pl.ev(`(() => { document.getElementById('next').click(); return ${P}.S.index; })()`);
    check('Next on the last item, repeat all: wraps to the first', wrap === 0, wrap);
    // repeat one: the end replays the same item
    await bar.ev(call('player.open', { paths: [V('clip-vp9.webm')], via: 'e2e' }));
    await playingNamed('clip-vp9.webm');
    await click('rep');   // one
    await pl.ev(`${P}.v.currentTime = ${P}.v.duration - 0.4`);
    const again = await until(async () => { const x = await now(); return x.name === 'clip-vp9.webm' && x.index === 6 && !x.paused && x.t < 1.2 && x.t > 0.05 ? x : null; }, 6000, 80);
    check('Repeat this one: the end starts the same item again', !!again, await now());
    await click('rep');   // off
    await silent('queue controls');

    // ===================== two sound tracks
    await bar.ev(call('player.open', { paths: [V('clip-2audio.mp4')], via: 'e2e' }));
    await playingNamed('clip-2audio.mp4');
    const at = await until(() => pl.ev(`(() => { const a = ${P}.audioTracks(); return a && a.length === 2 ? a.map((t) => ({ label: t.label, lang: t.language, on: t.enabled })) : null; })()`), 5000, 100);
    check('two sound tracks are seen (AudioVideoTracks on)', !!at, await pl.ev(`(() => { const a = ${P}.audioTracks(); return a ? a.length : 'no audioTracks API'; })()`));
    check('the sound-track button is on', await pl.ev(`!document.getElementById('atrack').disabled`));
    await click('atrack');
    const am = await pl.ev(`Array.from(document.querySelectorAll('#menu .mi')).map((b) => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : ''))`);
    check('its menu names both, the first checked', am.length === 2 && /\*$/.test(am[0]) && !/\*$/.test(am[1]), am);
    await pl.ev(`document.querySelectorAll('#menu .mi')[1].click()`);
    const at2 = await pl.ev(`${P}.audioTracks().map((t) => t.enabled)`);
    check('picking the second switches to it (only it enabled)', J(at2) === J([false, true]), at2);
    check('... and it keeps playing', !!await until(async () => { const x = await now(); return !x.paused && !x.nope ? x : null; }, 3000, 80));

    // ===================== resume: a spot at 12 s of the 30 s video (Mantle keeps 10 s .. end-15 s, so 10-15 s here)
    await bar.ev(call('player.open', { paths: [V('clip-h264.mp4')], via: 'e2e' }));
    await playingNamed('clip-h264.mp4');
    await pl.ev(`${P}.v.currentTime = 12`); await sleep(250);
    await click('play');
    const rs = await until(async () => { const s = await st(); return s.resumeKeys >= 1 ? s : null; }, 4000, 150);
    check('resume: pausing at ~12 s keeps a resume spot', !!rs, await st());
    // switching files must not carry that spot over to the next one (it once did: the pause event saved the
    // old video's position against the NEW file, so the next long video started part way in)
    await bar.ev(call('player.open', { paths: [V('clip-2audio.mp4')], via: 'e2e' }));
    const fresh = await playingNamed('clip-2audio.mp4');
    await sleep(300);
    const carried = await pl.ev(call('player.prepare', { path: V('clip-2audio.mp4') }));
    check('the next file starts at the top and gets no resume spot of the old one\'s', fresh && fresh.t < 2 && carried && carried.ok && !carried.resume, { fresh, resume: carried && carried.resume });
    await bar.ev(call('player.open', { paths: [V('clip-h264.mp4')], via: 'e2e' }));
    const back = await until(async () => { const x = await now(); return x.name === 'clip-h264.mp4' && x.t >= 11.8 && x.t < 14.5 ? x : null; }, 8000, 100);
    check('resume: clip-h264.mp4 picks up at ~12 s', !!back, await now());
    check('... with a "Resumed at 0:12" toast offering Start over', /Resumed at 0:1[23]/.test((await now()).toast || '') && await pl.ev(`document.getElementById('toasta').textContent`) === 'Start over', await now());
    await click('toasta');
    check('Start over goes back to 0', !!await until(async () => (await now()).t < 2, 3000, 80), await now());
    await silent('resume');

    // ===================== mini player
    const big = (await st()).bounds;
    await click('wmini');
    const mi = await until(async () => { const s = await st(); return s.mini ? s : null; }, 3000, 80);
    check('Mini player: on, a small window, kept on top (state)', mi && mi.onTop === true && mi.bounds.height < big.height && mi.bounds.width < big.width, { big, mini: mi });
    check('... the page draws the mini layout (no rail, no title bar)', await pl.ev(`document.documentElement.classList.contains('mini') && getComputedStyle(document.getElementById('rail')).display === 'none'`));
    await click('unmini');
    const un = await until(async () => { const s = await st(); return !s.mini ? s : null; }, 3000, 80);
    check('Expand: back to the full window and size', un && un.onTop === false && Math.abs(un.bounds.height - big.height) <= 2 && Math.abs(un.bounds.width - big.width) <= 2, { big, now: un });
    await key('m', { ctrlKey: true });
    check('Ctrl+M toggles the mini player', !!await until(async () => (await st()).mini, 3000, 80));
    await key('m', { ctrlKey: true });
    await until(async () => !(await st()).mini, 3000, 80);
    await silent('mini');

    // ===================== the library: Music, Albums, Videos, search, rescan
    await pl.ev(`document.querySelector('.ni[data-view="songs"]').click()`);
    const lib = await until(() => pl.ev(`(() => { const L = ${P}.S.lib; return L && !L.scanning && L.songs.length === 3 ? { songs: L.songs.map((s) => [s.title, s.artist, s.album, s.track, !!s.cover]), albums: L.albums.map((a) => [a.album, a.songs.length, !!a.cover]), videos: L.videos.length } : null; })()`), 20000, 300);
    check('Music lists the 3 tagged songs (mp3, m4a, opus) in track order with their tags', lib && J(lib.songs.map((s) => s.slice(0, 4))) === J([['Glass Morning', 'Mantle Test Band', 'Quiet Things', 1], ['Paper Lanterns', 'Mantle Test Band', 'Quiet Things', 2], ['Jumpy Polygons', 'Mantle Test Band', 'Quiet Things', 3]]), lib || await pl.ev(`${P}.S.lib`));
    check('Albums: one album, "Quiet Things", 3 songs, with its cover', lib && lib.albums.length === 1 && lib.albums[0][0] === 'Quiet Things' && lib.albums[0][1] === 3 && lib.albums[0][2] === true, lib && lib.albums);
    check('Videos: all 7 videos', lib && lib.videos === 7, lib && lib.videos);
    check('the Music view shows 3 rows', await pl.ev(`document.querySelectorAll('#musicbody .row:not(.rowhead)').length`) === 3);
    await shot('mantle-player-library-light');
    // play a song from its row (a single click: detail 1, as a real click): the music layout, the cover, the media session with artwork
    await pl.ev(`document.querySelectorAll('#musicbody .row:not(.rowhead)')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))`);
    const song = await playingNamed('song-b.m4a');
    check('clicking a song plays it (song-b.m4a, AAC in MP4)', !!song, await now());
    check('... in the music layout, the cover drawn from its tags', song && /\baudio\b/.test(song.cls) && /url\(/.test(await pl.ev(`document.getElementById('art').style.backgroundImage`)), song && song.cls);
    const md2 = await pl.ev(`(() => { const m = navigator.mediaSession.metadata; return { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length }; })()`);
    check('media session: the song\'s title, artist, album and artwork', J(md2) === J({ title: 'Paper Lanterns', artist: 'Mantle Test Band', album: 'Quiet Things', art: 1 }), md2);
    check('the queue is the album list (3 songs)', (await now()).n === 3);
    await pl.ev(`${P}.v.currentTime = 1.2`);
    await shot('mantle-player-nowplaying-light');
    for (const [f, t] of [['song-a.mp3', 'Glass Morning'], ['song-c.opus', 'Jumpy Polygons']]) {
      await bar.ev(call('player.open', { paths: [A(f)], add: false, via: 'e2e' }));
      const x = await playingNamed(f);
      check(`${f} plays, titled from its tags`, x && await pl.ev(`document.getElementById('npt').textContent`) === t, x || await now());
    }
    await click('wmini'); await until(async () => (await st()).mini, 3000, 80);
    await shot('mantle-player-mini-light');
    await click('unmini'); await until(async () => !(await st()).mini, 3000, 80);
    // search
    const typeQ = async (q) => { await pl.ev(`(() => { const i = document.getElementById('q'); i.value = ${J(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(500); };
    await pl.ev(`document.querySelector('.ni[data-view="songs"]').click()`);
    await typeQ('lanterns');
    const sq = await until(() => pl.ev(`(() => { const L = ${P}.S.lib; return ${P}.S.q === 'lanterns' && L && L.songs.length === 1 ? L.songs[0].title : null; })()`), 4000, 100);
    check('search "lanterns" finds Paper Lanterns only', sq === 'Paper Lanterns', await pl.ev(`${P}.S.lib && ${P}.S.lib.songs.map((s) => s.title)`));
    await typeQ('vp9');
    const vq = await until(() => pl.ev(`(() => { const L = ${P}.S.lib; return ${P}.S.q === 'vp9' && L && L.songs.length === 0 && L.videos.length === 1 ? L.videos[0].title + '|' + ${P}.S.view : null; })()`), 4000, 100);
    check('search "vp9" finds the one video', vq && /vp9/.test(vq), vq);
    await typeQ('zzzz');
    check('a search that matches nothing says so', /No music matches “zzzz”/.test(await pl.ev(`document.getElementById('musicbody').textContent`)), await pl.ev(`document.getElementById('musicbody').textContent`));
    await typeQ('');
    // rescan: a new file appears, a removed one goes
    fs.copyFileSync(A('song-a.mp3'), A('song-d.mp3'));
    await click('rescan1');
    const r4 = await until(() => pl.ev(`(() => { const L = ${P}.S.lib; return L && !L.scanning && L.songs.length === 4 ? 4 : null; })()`), 15000, 250);
    check('Rescan finds a song added to the Music folder (3 -> 4)', r4 === 4, await pl.ev(`${P}.S.lib && ${P}.S.lib.songs.length`));
    fs.rmSync(A('song-d.mp3'));
    await click('rescan1');
    const r3 = await until(() => pl.ev(`(() => { const L = ${P}.S.lib; return L && !L.scanning && L.songs.length === 3 ? 3 : null; })()`), 15000, 250);
    check('... and drops one deleted from it (4 -> 3)', r3 === 3, await pl.ev(`${P}.S.lib && ${P}.S.lib.songs.length`));
    await pl.ev(`document.querySelector('.ni[data-view="videos"]').click()`);
    const thumbs = await until(() => pl.ev(`document.querySelectorAll('#videobody .card.vid img').length`), 10000, 250);
    check('Videos shows thumbnails for the videos it can draw', thumbs >= 3, thumbs);
    await silent('library');

    // ===================== the play queue view, save as playlist, playlists
    await bar.ev(call('player.open', { paths: [V('clip-vp9.webm')], via: 'e2e' }));
    await playingNamed('clip-vp9.webm'); await click('play');
    await pl.ev(`document.querySelector('.ni[data-view="queue"]').click()`);
    check('the Play queue view lists the 7 items', await pl.ev(`document.querySelectorAll('#qbody .row').length`) === 7 && await pl.ev(`document.getElementById('qcount').textContent`) === '7');
    await pl.ev(`document.querySelectorAll('#qbody .row .rx')[0].click()`);
    check('Remove takes one out, with Undo', (await now()).n === 6 && /Removed broken/.test((await now()).toast || '') && await pl.ev(`document.getElementById('toasta').textContent`) === 'Undo', await now());
    await click('toasta');
    check('Undo puts it back where it was', (await now()).n === 7 && await pl.ev(`${P}.S.items[0].split('\\\\').pop()`) === 'broken.mp4');
    await click('qsave');
    await pl.ev(`(() => { document.getElementById('dlgin').value = 'E2E list'; document.getElementById('dlgok').click(); })()`);
    check('Save as playlist: saved, and says so', !!await until(async () => /Saved “E2E list” \(7\)/.test((await now()).toast || ''), 3000, 80), await now());
    const pls = await bar.ev(call('player.playlists', {}));
    check('player.playlists has it (7 items)', pls && pls.playlists && pls.playlists.some((x) => x.name === 'E2E list' && x.count === 7), pls);
    await pl.ev(`document.querySelector('.ni[data-view="playlists"]').click()`);
    await until(() => pl.ev(`document.querySelectorAll('#plbody .card').length`), 3000, 100);
    await pl.ev(`Array.from(document.querySelectorAll('#plbody .card')).find((c) => c.textContent.includes('E2E list')).click()`);
    check('opening it lists its 7 items', !!await until(async () => (await pl.ev(`document.querySelectorAll('#plbody .row').length`)) === 7, 3000, 80));
    await bar.ev(call('player.open', { paths: [A('song-a.mp3')], via: 'e2e' }));   // a different queue first
    await until(async () => (await now()).n === 3, 4000, 80);
    await pl.ev(`document.querySelector('.ni[data-view="playlists"]').click()`);
    await click('plplay');
    check('Play loads the playlist as the queue', !!await until(async () => (await now()).n === 7, 4000, 80), await now());
    await pl.ev(`document.querySelector('.ni[data-view="playlists"]').click()`);
    await click('pldel');
    check('Delete removes it, with Undo', !!await until(async () => { const r = await bar.ev(call('player.playlists', {})); return r && r.playlists && r.playlists.length === 0 && /Deleted/.test((await now()).toast || ''); }, 3000, 100), await now());
    await click('toasta');
    check('Undo brings the playlist back', !!await until(async () => { const r = await bar.ev(call('player.playlists', {})); return r && r.playlists && r.playlists.some((x) => x.name === 'E2E list' && x.count === 7); }, 3000, 100));
    await silent('playlists');

    // ===================== the queue survives the window closing
    await pl.ev(`${P}.S.index`);
    const qBefore = await pl.ev(`({ items: ${P}.S.items.slice(), index: ${P}.S.index })`);
    await sleep(700);   // the queue save is debounced 400 ms
    pl.close();
    await bar.ev(call('player.testclose', {}));
    await until(async () => !(await st()).hasWindow, 4000, 100);
    await bar.ev(call('player.open', { paths: [], via: 'e2e' }));
    const plT2 = await until(async () => (await targets(port)).find((t) => /\/ui\/player\//.test(t.url)) || null, 15000, 200);
    pl = plT2 ? await attach(plT2) : null; if (pl) open.push(pl);
    const restored = pl && await until(() => pl.ev(`window.__player && window.__player.S.items.length ? { items: window.__player.S.items.slice(), index: window.__player.S.index, paused: window.__player.v.paused } : null`), 10000, 150);
    check('reopened: the saved queue and position come back, paused', restored && J(restored.items) === J(qBefore.items) && restored.index === qBefore.index && restored.paused === true, { qBefore, restored });
    const s2 = await silent('reopened');
    check('SILENCE: the new window is muted too', s2 && s2.audioMuted === true, s2);

    // ===================== Settings > Apps > Default apps: "Use Mantle Player" is a dry run, zero registry writes
    const ROW = (row) => `document.querySelector('[data-row=${J(row)}]')`;
    await bar.ev(call('settings.open', { section: 'apps', page: 'defaults' }));
    const setT = await until(async () => (await targets(port)).find((t) => /\/ui\/settings\/index\.html/.test(t.url)) || null, 20000, 300);
    if (check('Settings opens (made on demand, never shown in --test)', !!setT)) {
      const sc = await attach(setT); open.push(sc);
      await until(() => sc.ev('!!(window.mantle && window.mantle.call)'), 15000, 150);
      let row = await until(() => sc.ev(`!!${ROW('apps.defaults.player.use')}`), 8000, 150);
      if (!row) { await bar.ev(call('settings.open', { section: 'applist', page: 'defaults' })); row = await until(() => sc.ev(`!!${ROW('apps.defaults.player.use')}`), 12000, 150); }
      if (check('Default apps shows the "Use Mantle Player for video and music" row', !!row)) {
        const stTxt = await until(() => sc.ev(`(() => { const t = ${ROW('apps.defaults.player')}.textContent; return /Reading/.test(t) ? null : t; })()`), 6000, 150);
        check('its status: "Not set up", and that a test run changes nothing', /Not set up/.test(stTxt || '') && /Test run/.test(stTxt || ''), stTxt);
        await sc.ev(`${ROW('apps.defaults.player.use')}.querySelector('button').click()`);
        const useTxt = await until(() => sc.ev(`(() => { const t = ${ROW('apps.defaults.player.use')}.textContent; return /Test run: nothing was written/.test(t) ? t : null; })()`), 8000, 150);
        check('Set up (dry run): says nothing was written, and how many entries it would add', !!useTxt && /would add \d+ registry entries/.test(useTxt), useTxt || await sc.ev(`${ROW('apps.defaults.player.use')}.textContent`));
        const undoOn = await sc.ev(`!${ROW('apps.defaults.player.undo')}.querySelector('button').disabled`);
        if (check('Undo is offered in the dry run', undoOn)) {
          await sc.ev(`${ROW('apps.defaults.player.undo')}.querySelector('button').click()`);
          // the dry Set up records nothing, so Undo has nothing to take out, and must SAY so under the button
          const undoTxt = await until(() => sc.ev(`(() => { const t = ${ROW('apps.defaults.player.undo')}.textContent; return /nothing to take out|Test run: nothing was removed/.test(t) ? t : null; })()`), 8000, 150);
          check('Undo (dry run): says there was nothing to take out (not a silent click)', !!undoTxt, await sc.ev(`${ROW('apps.defaults.player.undo')}.textContent`));
        }
      }
    }
    const sReg = await st();
    check('ZERO registry calls: reg.exe never ran (teststate.regCalls 0)', sReg && sReg.regCalls === 0, sReg && sReg.regCalls);
    const regAfter = regSnapshot();
    check('the HKCU keys Set up would write are exactly as before the run', J(regAfter) === J(regBefore), { regBefore, regAfter });

    // ===================== dark shots (theme.set switches this instance only, until it quits)
    if (SHOTS && pl) {
      await bar.ev(call('theme.set', { mode: 'dark' }));
      const dark = await until(() => pl.ev(`document.documentElement.dataset.theme === 'dark'`), 5000, 100);
      check('dark: the player page follows Mantle\'s appearance', !!dark, await pl.ev('document.documentElement.dataset.theme'));
      await pl.ev(`document.querySelector('.ni[data-view="songs"]').click()`);
      await until(() => pl.ev(`document.querySelectorAll('#musicbody .row:not(.rowhead)').length === 3`), 5000, 100);
      await shot('mantle-player-library-dark');
      await bar.ev(call('player.open', { paths: [A('song-b.m4a')], via: 'e2e' }));
      await playingNamed('song-b.m4a'); await pl.ev(`${P}.v.currentTime = 1.2`);
      await shot('mantle-player-nowplaying-dark');
      await click('wmini'); await until(async () => (await st()).mini, 3000, 80);
      await shot('mantle-player-mini-dark');
      await click('unmini'); await until(async () => !(await st()).mini, 3000, 80);
      await bar.ev(call('player.open', { paths: [V('clip-h264.mp4')], via: 'e2e' }));
      await until(async () => { const x = await now(); return x.name === 'clip-h264.mp4' && !x.paused && x.t > 0.9 && x.t < 3 ? x : null; }, 8000, 80);
      await shot('mantle-player-video-dark');
      await silent('dark shots');
    }

    // ===================== silence, all through
    const loud = result.silence.filter((x) => x.muted !== true);
    check(`SILENCE: the player's WebContents was muted at every one of ${result.silence.length} checkpoints`, result.silence.length >= 8 && loud.length === 0, loud);
    console.log(`info: silence: ${result.silence.length} checkpoints, all audioMuted=true: ${loud.length === 0}; isCurrentlyAudible seen: ${result.silence.filter((x) => x.audible).length} (Chromium's signal meter, before the mute)`);
    const q = await bar.ev(call('shell.quit')).catch((e) => ({ threw: e.message }));
    const exited = await until(() => run.exited, 30000, 250);
    check('shell.quit: the instance exits by itself', !!exited, { q, tail: run.out.slice(-400) });
  } finally {
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
    try { fs.rmSync(MEDIA, { recursive: true, force: true }); } catch (_) { /* a file still open */ }
  }
}
main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  if (skipped) console.log(`PLAYER E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`PLAYER E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
