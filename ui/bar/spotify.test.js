require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* spotify.test.js — the Spotify section of the now-playing card (ui/bar/spotify.js + spotify.css),
 * media-ui lane, 2026-09-29.
 *
 * PART 1 (node, always): plain() — Spotify's internals, codes and the debugging port never reach the
 * card in their raw form.
 * PART 2 (headless chromium over file://, never Electron, never a real Spotify): the REAL spotify.js and
 * spotify.css (with glass-light.css and bar.css for the card around it) on a page built here, with a
 * FAKE bar.js api (call / on / msg / repaint) scripted per scenario and FAKE timers (T.tick), so the
 * 8 s refresh, the 5 s disarm, the 380 ms search wait and the 700 ms track settle are exact. Every
 * scenario CLICKS / TYPES through the real UI code and checks the calls made and what the card says.
 * Screenshots of the key states at 1x and 1.5x go to MANTLE_SHOOT_OUT (default: the media lane's shots).
 *
 *   node ui/bar/spotify.test.js            (SHOTS=0 to skip the screenshots; ONLY=name,name for some; PAGE=0 = node part only)
 * Prints "SPOTIFY CARD TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 * Line 1 is the machine-wide CPU cap and browser lock; run it through uislot.sh (BRIEF).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/7e5085b9-5bec-43fe-aecd-5fe5701b290a/scratchpad/lanes/media/shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SHOTS = process.env.SHOTS !== '0';

let passed = 0;
const failures = [];
let scen = '';
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(`[${scen}] ${name}` + (detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : '')); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ PART 1: node */
function nodeTests() {
  scen = 'plain';
  const { plain, look } = require('./spotify.js');
  check('look() still exported for lib/features/spotify.test.js', typeof look === 'function');
  const cases = [
    ['Spotify’s page threw: TypeError: t.getQueue is not a function', /ran into a problem/],
    ['Spotify’s page gave no answer', /didn’t answer in time/],
    ['connect ECONNREFUSED 127.0.0.1:47292', /lost its connection/],
    ['Spotify’s skipTo failed (no track) and the song changed anyway', /couldn’t jump to that song/],
    ['this Spotify has no removeFromQueue(), so songs cannot be removed from Mantle', /doesn’t allow that/],
    ['Spotify’s LibraryAPI has no add/remove/contains', /doesn’t allow that/],
    ['unknown command spotify.like', /needs an update/],
    ['Spotify is running, but it was not started with its debugging port (127.0.0.1:47292)', /^Spotify is running, but it was not started with Mantle’s connection$/],
    ['it is already first in your queue', /^It is already first in your queue$/],
    [undefined, /^Spotify gave no reason$/], [null, /^Spotify gave no reason$/], ['undefined', /^Spotify gave no reason$/], ['[object Object]', /^Spotify gave no reason$/],
  ];
  for (const [raw, want] of cases) {
    const got = plain(raw);
    check(`plain(${JSON.stringify(raw)})`, want.test(got) && !/127\.0\.0\.1|47292|debugging|\w+\(\)|TypeError|ECONN/.test(got), got);
  }
}

/* ================================================================ fixtures (all made up) */
const PAL = ['#5B7CFA', '#E8674A', '#2BB39A', '#B55BE0', '#E0B03A', '#3A8EE0', '#E05B8E', '#6BBF4A', '#8A6BE0', '#E08A3A'];
const art = (i) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PAL[i % PAL.length]}"/><stop offset="1" stop-color="${PAL[(i + 3) % PAL.length]}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="46" cy="18" r="10" fill="#fff" fill-opacity=".25"/></svg>`).toString('base64');
const id22 = (n) => ('A' + String(n) + 'bcdefghijklmnopqrstuvwxyz0123456789').slice(0, 22);
const TR = (n) => `spotify:track:${id22(n)}`;
const SONGS = [['Midnight City', 'M83'], ['Dreams', 'Fleetwood Mac'], ['Electric Feel', 'MGMT'], ['Redbone', 'Childish Gambino'], ['Tadow', 'Masego, FKJ'],
  ['Nights', 'Frank Ocean'], ['Solar Power', 'Lorde'], ['Heat Waves', 'Glass Animals'], ['Pink + White', 'Frank Ocean']];
const item = (i, where) => ({ uri: TR(i), uid: 'u' + i + 'abc', name: SONGS[i % SONGS.length][0], artists: SONGS[i % SONGS.length][1], kind: 'track', where, image: art(i) });
const QUEUE = () => ({ ok: true, state: 'connected', at: Date.now(), caps: { move: true, remove: true }, current: Object.assign(item(8, 'current'), { image: '' }),
  queued: [item(0, 'queued'), item(1, 'queued'), item(2, 'queued')], nextUp: [item(3, 'next'), item(4, 'next'), item(5, 'next'), item(6, 'next')], totalQueued: 5, totalNextUp: 40 });
const PLAYER = { paused: false, shuffle: false, repeat: 0, context: 'spotify:playlist:' + id22(90), item: TR(8), hasItem: true, canShuffle: true, canRepeat: true, canRepeatTrack: true };
const INFO = () => ({ ok: true, state: 'connected', window: { state: 'hidden', how: 'Mantle started it hidden' }, running: true, visible: false,
  memory: { n: 6, wsMB: 431, privateMB: 512, privateWsMB: 358, visible: 0 }, memoryReason: null, player: Object.assign({}, PLAYER), playerReason: null, liked: false });
const LIB = () => ({ ok: true, liked: { uri: 'spotify:collection:tracks', name: 'Liked Songs' }, total: 5, skipped: 1, at: Date.now(), items: [
  { uri: 'spotify:playlist:' + id22(90), kind: 'playlist', name: 'Late night drive', sub: 'Owen', image: art(1) },
  { uri: 'spotify:playlist:' + id22(91), kind: 'playlist', name: 'Focus flow', sub: 'Spotify', image: art(4) },
  { uri: 'spotify:artist:' + id22(92), kind: 'artist', name: 'Frank Ocean', sub: '', image: art(6) },
  { uri: 'spotify:album:' + id22(93), kind: 'album', name: 'Currents', sub: 'Tame Impala', image: art(7) }] });
const SEARCH = (q) => ({ ok: true, q, tracks: [{ uri: TR(20), kind: 'track', name: 'Get Lucky', sub: 'Daft Punk, Pharrell Williams', image: art(2) }, { uri: TR(21), kind: 'track', name: 'One More Time', sub: 'Daft Punk', image: art(5) }],
  artists: [{ uri: 'spotify:artist:' + id22(22), kind: 'artist', name: 'Daft Punk', sub: '', image: art(3) }], albums: [],
  playlists: [{ uri: 'spotify:playlist:' + id22(23), kind: 'playlist', name: 'This Is Daft Punk', sub: 'Spotify', image: art(9) }] });
const STATUS = (extra) => Object.assign({ ok: true, state: 'connected', reason: null, window: { state: 'hidden', how: 'Mantle started it hidden' }, revive: { on: true, closeOn: true, state: 'idle' } }, extra || {});
const SESSION = { aumid: 'Spotify.exe', app: { name: 'Spotify' }, title: 'Pink + White', artist: 'Frank Ocean', playing: true };
const IDLE_SESSION = { aumid: 'Spotify.exe', app: { name: 'Spotify' }, title: '', artist: '', playing: false };
const JARGON = /sidecar|\bCDP\b|127\.0\.0\.1|47292|debugging port|\bpid\b|undefined|\bnull\b|NaN|\[object|TypeError|ECONN|\w+\(\)|hwnd|IPC/;

/* ================================================================ the page */
function pageHtml() {
  const u = (p) => 'file:///' + path.join(ROOT, p).replace(/\\/g, '/');
  const G = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${d}</svg>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${u('ui/shared/glass-light.css')}">
<link rel="stylesheet" href="${u('ui/bar/bar.css')}">
<link rel="stylesheet" href="${u('ui/bar/spotify.css')}">
<style>
  html, body { width: auto; height: auto; overflow: visible; }
  body { margin: 0; background: linear-gradient(135deg, #dfe6f2, #eef0f6 55%, #e6e2ef); }
  .stage { display: inline-block; padding: 18px; }
  .stage .pop { position: relative; bottom: auto; left: auto; top: auto; display: block; }
</style>
<script>
/* FAKE timers: only spotify.js uses them; Playwright's own scripts live in another world */
(function () {
  var realST = window.setTimeout, base = Date.now(), now0 = 0, timers = [], tid = 1, realNow = Date.now.bind(Date);
  Date.now = function () { return base + now0; };
  window.setTimeout = function (fn, ms) { var id = tid++; timers.push({ id: id, at: now0 + (+ms || 0), fn: fn, every: 0 }); return id; };
  window.setInterval = function (fn, ms) { var id = tid++; timers.push({ id: id, at: now0 + (+ms || 0), fn: fn, every: Math.max(1, +ms || 0) }); return id; };
  window.clearTimeout = window.clearInterval = function (id) { timers = timers.filter(function (t) { return t.id !== id; }); };
  var flush = function () { return new Promise(function (r) { realST(r, 0); }); };
  var h = {}, calls = [], pend = {}, subs = {}, unsubs = 0, pop = null, session = null;
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  var api = {
    call: function (name, args) {
      calls.push([name, clone(args)]);
      var s = h[name];
      if (s && s.__defer) return new Promise(function (res, rej) { (pend[name] = pend[name] || []).push({ res: res, rej: rej }); });
      if (s && s.__throw) return Promise.reject(new Error(s.__throw));
      if (s && s.__seq) return Promise.resolve(clone(s.__seq.length > 1 ? s.__seq.shift() : s.__seq[0]));
      if (s === undefined) return Promise.reject(new Error('no fake for ' + name));
      return Promise.resolve(clone(s));
    },
    on: function (ev, fn, onDead) {
      subs[ev] = fn;
      if (T.deadReason) Promise.resolve().then(function () { onDead(T.deadReason); });
      return function () { unsubs++; delete subs[ev]; };
    },
    msg: function (e) { return (e && e.message) || String(e); },
    repaint: function () { T.repaints++; if (pop && session) MantleSpotify.paint(session, pop); }
  };
  window.T = {
    repaints: 0, docEsc: 0, deadReason: '',
    set: function (n, v) { h[n] = v; },
    calls: calls,
    count: function (n) { return calls.filter(function (c) { return c[0] === n; }).length; },
    last: function (n) { for (var i = calls.length - 1; i >= 0; i--) if (calls[i][0] === n) return calls[i][1]; return null; },
    open: function (s) {
      session = s; pop = document.querySelector('.pop');
      MantleSpotify.attach(pop, pop.querySelector('.mc-src'), api);
      MantleSpotify.paint(session, pop);
      return flush();
    },
    paint: function (s) { session = s; MantleSpotify.paint(s, pop); return flush(); },
    close: function () { MantleSpotify.closed(); var r = pop.querySelector('.spq'); if (r) r.remove(); return flush(); },
    resolve: function (n, v) { var p = (pend[n] || []).shift(); if (!p) throw new Error('nothing pending for ' + n); p.res(clone(v)); return flush(); },
    reject: function (n, m) { var p = (pend[n] || []).shift(); p.rej(new Error(m)); return flush(); },
    pending: function (n) { return (pend[n] || []).length; },
    push: function (ev, v) { if (subs[ev]) subs[ev](clone(v)); return flush(); },
    subs: function () { return Object.keys(subs).length; },
    unsubs: function () { return unsubs; },
    live: function () { return timers.length; },
    tick: async function (ms) {
      var end = now0 + ms;
      for (;;) {
        timers.sort(function (a, b) { return a.at - b.at; });
        var t = timers[0];
        if (!t || t.at > end) break;
        now0 = t.at;
        if (t.every) t.at += t.every; else timers.shift();
        t.fn();
        await flush();
      }
      now0 = end;
      await flush();
    },
    flush: flush
  };
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') T.docEsc++; });
})();
</script>
<script src="${u('ui/bar/spotify.js')}"></script>
</head><body>
<div class="stage"><div class="pop mcard">
  <div class="mc-head"><div class="mc-art"><img alt="" src="${art(8)}"></div><div class="mc-meta"><div class="mc-title">Pink + White</div><div class="mc-artist">Frank Ocean</div>
    <div class="mc-app"><span class="mc-appico"></span><span class="mc-apptxt">Spotify</span></div></div></div>
  <div class="mc-prog"><div class="mc-bar"><div class="mc-fill" style="width:38%"></div></div><div class="mc-times"><span>1:14</span><span>3:04</span></div></div>
  <div class="mc-ctl"><button class="mc-btn" type="button">${G('<path d="M4 3.5v9M12 3.5v9L6 8z" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>')}</button>
    <button class="mc-btn main" type="button">${G('<path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')}</button>
    <button class="mc-btn" type="button">${G('<path d="M12 3.5v9M4 3.5v9L10 8z" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>')}</button></div>
  <div class="mc-src" hidden><div class="sub mc-srcwhy">Automatic: showing the session Windows calls current</div><div class="mc-srclist">
    <button class="mc-s on" type="button"><span class="mc-sico">S</span><span class="mc-stxt">Spotify · Pink + White</span></button>
    <button class="mc-s" type="button"><span class="mc-sico">A</span><span class="mc-stxt">LessonPlayer · lesson</span></button>
    <button class="mc-s mc-auto" type="button">Automatic</button></div></div>
</div></div>
</body></html>`;
}

/* ================================================================ PART 2: the page */
async function pageTests() {
  if (gaming()) { console.log('a game is running: the page part is skipped'); failures.push('page part skipped (a game is running)'); return; }
  if (!fs.existsSync(CHROME)) { failures.push('no chromium at ' + CHROME); return; }
  const dir = path.join(os.tmpdir(), 'mantle-spotify-card-test');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, pageHtml());
  const URL = 'file:///' + file.replace(/\\/g, '/');
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 380, height: 760 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const ctx15 = SHOTS ? await browser.newContext({ viewport: { width: 380, height: 760 }, deviceScaleFactor: 1.5, colorScheme: 'light' }) : null;
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${scen}] ${e.message}`));
    const page15 = ctx15 ? await ctx15.newPage() : null;
    if (page15) page15.on('pageerror', (e) => errors.push(`[${scen} 1.5x] ${e.message}`));

    // ---------------------------------------------------------------- helpers over one page
    const mkH = (pg) => {
      const ev = (fn, arg) => pg.evaluate(fn, arg);
      const H = {
        pg,
        async fresh(fx) {
          await pg.goto(URL, { waitUntil: 'load' });
          const d = Object.assign({ 'spotify.status': STATUS(), 'spotify.queue': QUEUE(), 'spotify.info': INFO(), 'spotify.library': LIB(), 'qs.keyboard': { ok: true } }, fx || {});
          await ev((d) => { for (const k of Object.keys(d)) T.set(k, d[k]); }, d);
        },
        set: (n, v) => ev(([n, v]) => T.set(n, v), [n, v]),
        open: (s) => ev((s) => T.open(s), s || SESSION),
        paint: (s) => ev((s) => T.paint(s), s),
        close: () => ev(() => T.close()),
        tick: (ms) => ev((ms) => T.tick(ms), ms),
        flush: () => ev(() => T.flush()),
        resolve: (n, v) => ev(([n, v]) => T.resolve(n, v), [n, v]),
        reject: (n, m) => ev(([n, m]) => T.reject(n, m), [n, m]),
        push: (e, v) => ev(([e, v]) => T.push(e, v), [e, v]),
        count: (n) => ev((n) => T.count(n), n),
        last: (n) => ev((n) => T.last(n), n),
        calls: () => ev(() => T.calls.map((c) => c[0])),
        text: (sel) => ev((sel) => { const n = document.querySelector(sel); return n ? n.innerText.replace(/\s+/g, ' ').trim() : null; }, sel || '.spq'),
        vis: (sel) => ev((sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'; }, sel),
        attr: async (sel, a) => (/>>/.test(sel) ? ((await pg.locator(sel).count()) ? pg.locator(sel).first().getAttribute(a) : null) : ev(([sel, a]) => { const n = document.querySelector(sel); return n ? n.getAttribute(a) : null; }, [sel, a])),
        n: (sel) => ev((sel) => document.querySelectorAll(sel).length, sel),
        async click(sel, opts) { await pg.locator(sel).first().click(opts); await H.flush(); },
        async clickText(t, opts) { await pg.locator('.spq button', { hasText: t }).first().click(opts); await H.flush(); },
        async expand() { await H.click('.spq-head'); },
        note: () => ev(() => { const n = document.querySelector('.spq-note'); return n && !n.hidden ? { text: n.textContent, bad: n.classList.contains('bad'), title: n.title } : null; }),
        async shot(name) {
          if (!SHOTS) return;
          await pg.locator('.stage').screenshot({ path: path.join(OUT, name + (pg === page15 ? '@1.5x' : '') + '.png') });
        },
      };
      return H;
    };
    const P = mkH(page);
    const P15 = page15 ? mkH(page15) : null;
    const run = async (name, fn) => {
      if (ONLY && !ONLY.includes(name)) return;
      scen = name;
      try { await fn(P); } catch (e) { failures.push(`[${name}] threw: ${String(e && e.stack || e).slice(0, 400)}`); }
    };
    const noJargon = async (H, what) => { const t = await H.text('.spq'); check(`${what}: no jargon on screen`, !JARGON.test(t || ''), (t || '').match(JARGON)); };

    // ================================================================ states (not connected)
    await run('state-checking', async (H) => {
      await H.fresh({ 'spotify.status': { __defer: true } });
      await H.open(); await H.expand();
      check('says Checking Spotify…', /Checking Spotify…/.test(await H.text()));
      check('no player row, no search before it is connected', !(await H.vis('.spq-bar')) && !(await H.vis('.spq-add')));
    });
    await run('state-notrunning', async (H) => {
      await H.fresh({ 'spotify.status': STATUS({ state: 'notrunning', reason: 'Spotify is not running', port: 47292 }), 'spotify.start': { __defer: true } });
      await H.open(); await H.expand();
      const t = await H.text();
      check('headline + one primary Start Spotify', /Spotify isn’t running/.test(t) && (await H.n('.spq-state .spq-btn')) === 1 && /Start Spotify/.test(await H.text('.spq-state .spq-btn')), t);
      check('head word says Not running (warn)', (await H.text('.spq-hint')) === 'Not running' && (await H.attr('.spq-hint', 'class')).includes('warn'));
      check('the game toggles are NOT on the first screen', !(await H.vis('.spq-opt')));
      await noJargon(H, 'not running');
      await H.shot('01-not-running');
            await H.pg.locator('.spq-state .spq-btn').dblclick(); await H.flush();
      check('a double-click on Start starts once', (await H.count('spotify.start')) === 1);
      check('Starting… is said at once', /Starting Spotify…/.test(await H.text()) && /30 seconds/.test(await H.text()));
      await H.resolve('spotify.start', { ok: true });
      await H.push('spotify.status', STATUS());
      check('connected after the push: the player row shows', await H.vis('.spq-bar'));
      check('Spotify started. is said', /Spotify started\./.test((await H.note() || {}).text || ''));
    });
    await run('state-notrunning-revive', async (H) => {
      await H.fresh({ 'spotify.status': STATUS({ state: 'notrunning', revive: { on: true, closeOn: true, state: 'waiting', mine: true, text: 'Mantle closed Spotify for your game.', plan: 'It starts again, not playing, after the game.' } }) });
      await H.open(); await H.expand();
      const t = await H.text();
      check('the game words and "Start it now"', /closed Spotify for your game/.test(t) && /after the game/.test(t) && /Start it now/.test(t), t);
    });
    await run('state-noport', async (H) => {
      await H.fresh({ 'spotify.status': STATUS({ state: 'noport', reason: 'Spotify is running, but it was not started by Mantle, so Up next cannot reach it' }), 'spotify.restart': { ok: true } });
      await H.open(); await H.expand();
      check('says it was opened outside Mantle + Restart Spotify', /opened outside Mantle/.test(await H.text()) && (await H.text('.spq-state .spq-btn')) === 'Restart Spotify');
      check('head word Needs a restart', (await H.text('.spq-hint')) === 'Needs a restart');
      await H.click('.spq-state .spq-btn');
      check('first click only arms it (no call), says the music stops', (await H.count('spotify.restart')) === 0 && (await H.text('.spq-state .spq-btn')) === 'Click again to restart' && /stops the music/.test(await H.text()));
      await H.shot('02-noport-armed');
      await H.tick(5100);
      check('5 s later it is disarmed', (await H.text('.spq-state .spq-btn')) === 'Restart Spotify');
      await H.click('.spq-state .spq-btn');
      await H.pg.keyboard.press('Escape'); await H.flush();
      check('Esc disarms it and does not close the card', (await H.text('.spq-state .spq-btn')) === 'Restart Spotify' && (await H.pg.evaluate(() => T.docEsc)) === 0);
      await H.click('.spq-state .spq-btn'); await H.click('.spq-state .spq-btn');
      check('second click restarts, once', (await H.count('spotify.restart')) === 1);
      await noJargon(H, 'noport');
    });
    for (const [st, head, again] of [['starting', /Starting Spotify…/, false], ['loading', /still loading/, true], ['portbusy', /Another app is using/, true],
      ['internals', /Spotify updated/, true], ['noinstall', /isn’t installed/, true], ['off', /controls are off/, false],
      ['error', /can’t reach Spotify/, true]]) {
      await run('state-' + st, async (H) => {
        const reason = { starting: 'Starting Spotify…', loading: 'Spotify is still loading its page (no player yet); Up next works once it has loaded', portbusy: 'port 47292 on 127.0.0.1 is taken by another program (pid 4411)',
          internals: 'Spotify is reachable, but its queue functions were not found: no PlayerAPI (1.2.3). A Spotify update probably moved them', noinstall: 'Mantle starts Spotify from C:\\Users\\x\\AppData\\Roaming\\Spotify\\Spotify.exe, and it is not there (the Microsoft Store Spotify cannot be started with a debugging port)',
          off: 'the Spotify queue is off in Mantle’s tray menu', error: 'Spotify’s page threw: TypeError: e.getState is not a function' }[st];
        await H.fresh({ 'spotify.status': STATUS({ state: st, reason }) });
        await H.open(); await H.expand();
        check('headline', head.test(await H.text()), await H.text());
        check(again ? 'offers Try again' : 'no Try again', (await H.n('.spq-state .spq-link.act')) === (again ? 1 : 0));
        await noJargon(H, st);
        if (again) { const n0 = await H.count('spotify.status'); await H.click('.spq-state .spq-link.act'); check('Try again re-reads the status', (await H.count('spotify.status')) === n0 + 1); }
        if (st === 'error' || st === 'portbusy') await H.shot('03-state-' + st);
      });
    }
    await run('state-missing', async (H) => {
      await H.fresh({ 'spotify.status': { __throw: 'No handler registered for spotify.status' } });
      await H.open(); await H.expand();
      check('status that throws: says controls aren’t available, in plain words', /aren’t available/.test(await H.text()) && /needs an update/.test(await H.text()), await H.text());
    });

    // ================================================================ connected: Up next
    await run('queue', async (H) => {
      await H.fresh({ 'spotify.play': { ok: true, verified: true }, 'spotify.move': { ok: true, verified: true }, 'spotify.remove': { ok: true, verified: true } });
      await H.open();
      check('shut by default: head only, no reads but the status', !(await H.vis('.spq-body')) && (await H.count('spotify.queue')) === 0 && (await H.count('spotify.info')) === 0);
      check('head tooltip says what opening shows', /Show Up next, Library and search/.test(await H.attr('.spq-head', 'title')));
      await H.shot('10-shut');
      await H.expand();
      check('opening reads the queue and info once', (await H.count('spotify.queue')) === 1 && (await H.count('spotify.info')) === 1);
      const t = await H.text('.spq-list');
      check('sections: Next in queue then Coming up', /Next in queue.*Coming up/.test(t), t);
      check('7 rows, +2 more said', (await H.n('.spq-list .spq-row')) === 7 && /\+2 more in the queue/.test(t));
      check('head says 3 in queue', (await H.text('.spq-hint')) === '3 in queue');
      check('first queued: Move up disabled; last queued: Move down disabled', await H.pg.evaluate(() => {
        const it = document.querySelectorAll('.spq-list .spq-item');
        const tl = (i, l) => Array.from(it[i].querySelectorAll('.spq-tool')).find((b) => b.getAttribute('aria-label') === l);
        return tl(0, 'Move up').disabled && !tl(0, 'Move down').disabled && tl(2, 'Move down').disabled && !tl(1, 'Move up').disabled;
      }));
      check('coming-up rows: remove only (Spotify reorders only its queue)', (await H.pg.evaluate(() => document.querySelectorAll('.spq-list .spq-item')[4].querySelectorAll('.spq-tool').length)) === 1);
      check('tools have tooltips with their shortcut', /Remove from queue \(Delete\)/.test(await H.attr('.spq-list .spq-item .spq-tool[aria-label="Remove from queue"]', 'title')));
      check('art: a real picture, 36 px', (await H.pg.evaluate(() => document.querySelector('.spq-list .spq-art img').getBoundingClientRect().width)) === 36);
      await noJargon(H, 'queue');
      await H.pg.hover('.spq-list .spq-item >> nth=1');
      await H.shot('11-up-next');
      // play
      await H.pg.locator('.spq-list .spq-row').nth(1).dblclick(); await H.flush();
      check('a double-click on a row plays once, with its uri + uid', (await H.count('spotify.play')) === 1 && (await H.last('spotify.play')).uid === 'u1abc');
      check('Playing “Dreams”', /Playing “Dreams”/.test((await H.note()).text));
      check('the queue was re-read to verify', (await H.count('spotify.queue')) === 2);
      await H.tick(6100);
      check('the good-news note clears itself after 6 s', (await H.note()) === null);
      // move
      await H.pg.hover('.spq-list .spq-item >> nth=0');
      await H.click('.spq-list .spq-item >> nth=0 >> .spq-tool[aria-label="Move down"]');
      check('Move down sends dir down', (await H.last('spotify.move')).dir === 'down' && /Moved “Midnight City” down/.test((await H.note()).text));
      await H.click('.spq-list .spq-item >> nth=3 >> .spq-tool[aria-label="Remove from queue"]');   // row 3 = the first Coming up row (Redbone)
      check('Remove sends the row', (await H.last('spotify.remove')).uri === TR(3) && /Removed “Redbone”/.test((await H.note()).text));
      // failures in plain words
      await H.set('spotify.move', { ok: false, state: 'error', reason: 'Spotify’s skipTo failed (x) and the song changed anyway' });
      await H.click('.spq-list .spq-item >> nth=1 >> .spq-tool[aria-label="Move up"]');
      const nb = await H.note();
      check('a refusal is said in warn, plain, raw on the tooltip', nb.bad && /^Not moved: Spotify couldn’t jump to that song$/.test(nb.text) && /skipTo/.test(nb.title), nb);
      await H.set('spotify.play', { ok: true, verified: false, reason: 'Spotify took it, but it is playing something else' });
      await H.click('.spq-list .spq-row >> nth=2');
      check('unverified play is a warning', (await H.note()).bad && /playing something else/.test((await H.note()).text));
      // one at a time
      await H.set('spotify.play', { __defer: true });
      await H.click('.spq-list .spq-row >> nth=3');
      check('busy row is dimmed', (await H.n('.spq-list .spq-item.busy')) === 1);
      await H.click('.spq-list .spq-row >> nth=4');
      check('another action while one runs: said, not sent', (await H.count('spotify.play')) === 3 && /Still working/.test((await H.note()).text));
      await H.resolve('spotify.play', { ok: true, verified: true });
      check('after it lands the dim goes', (await H.n('.spq-list .spq-item.busy')) === 0);
    });
    await run('queue-focus-refresh', async (H) => {
      await H.fresh();
      await H.open(); await H.expand();
      await H.pg.locator('.spq-list .spq-row').nth(2).focus();
      await H.pg.evaluate(() => { document.activeElement._mark = 1; });
      const q0 = await H.count('spotify.queue');
      await H.tick(8000);
      check('the 8 s refresh reads the queue', (await H.count('spotify.queue')) === q0 + 1);
      check('same content, new `at`: the list is NOT rebuilt (focus and element kept)', await H.pg.evaluate(() => document.activeElement && document.activeElement._mark === 1));
      const q = QUEUE(); q.queued.shift(); q.totalQueued = 4;
      await H.set('spotify.queue', q);
      await H.tick(8000);
      check('changed content: rebuilt, and focus goes back to the SAME song', await H.pg.evaluate(() => document.activeElement && document.activeElement.classList.contains('spq-row') && /Electric Feel/.test(document.activeElement.textContent)));
      check('the list is one Tab stop (roving)', (await H.n('.spq-list .spq-row[tabindex="0"]')) === 1);
      await H.pg.keyboard.press('ArrowDown'); await H.flush();
      check('ArrowDown moves to the next row', /Redbone/.test(await H.pg.evaluate(() => document.activeElement.textContent)));
      await H.pg.keyboard.press('Delete'); await H.flush();
      await H.set('spotify.remove', { ok: true, verified: true });
      check('Delete removes the focused row', (await H.count('spotify.remove')) === 1 || (await H.last('spotify.remove')) !== null);
      await H.pg.locator('.spq-list .spq-row').nth(1).focus();
      await H.set('spotify.move', { ok: true, verified: true });
      await H.pg.keyboard.press('Alt+ArrowUp'); await H.flush();
      check('Alt+Up moves a queued song up', (await H.last('spotify.move') || {}).dir === 'up');
      await H.close();
      check('closed(): no timer left running', (await H.pg.evaluate(() => T.live())) === 0, await H.pg.evaluate(() => T.live()));
      check('closed(): the status and auto-pause subscriptions are released (r5-autopause: two)', (await H.pg.evaluate(() => T.unsubs())) === 2 && (await H.pg.evaluate(() => T.subs())) === 0);
      const n = (await H.calls()).length;
      await H.tick(30000);
      check('closed(): nothing is read afterwards', (await H.calls()).length === n);
    });
    await run('queue-states', async (H) => {
      await H.fresh({ 'spotify.queue': { __defer: true } });
      await H.open(); await H.expand();
      check('loading: skeleton rows of the real size, list busy', (await H.n('.spq-skel')) === 4 && (await H.attr('.spq-list', 'aria-busy')) === 'true');
      const h0 = await H.pg.evaluate(() => document.querySelector('.spq-scroll').getBoundingClientRect().height);
      await H.shot('12-loading');
      await H.resolve('spotify.queue', QUEUE());
      const h1 = await H.pg.evaluate(() => document.querySelector('.spq-scroll').getBoundingClientRect().height);
      check('little jump when rows arrive (skeleton ≈ rows)', h1 - h0 < 140, [h0, h1]);
      await H.set('spotify.queue', { ok: false, state: 'error', reason: 'Spotify’s page gave no answer' });
      await H.tick(8000);
      const t = await H.text('.spq-state');
      check('error: headline, plain reason, Try again', /Up next didn’t load/.test(t) && /didn’t answer in time/.test(t) && /Try again/.test(t), t);
      check('head says nothing alarming for a queue read error (the list says it)', (await H.text('.spq-hint')) !== 'Error');
      await H.shot('13-queue-error');
      await H.set('spotify.queue', Object.assign(QUEUE(), { queued: [], nextUp: [], totalQueued: 0 }));
      await H.click('.spq-state .spq-link.act');
      check('empty: Nothing is queued after this song', /Nothing is queued after this song/.test(await H.text('.spq-state')));
      await H.shot('14-queue-empty');
    });
    await run('queue-stale', async (H) => {
      await H.fresh({ 'spotify.queue': { __defer: true } });
      await H.open(); await H.expand();
      await H.close();
      await H.set('spotify.queue', { __defer: true });
      await H.open();
      const old = QUEUE(); old.queued = [Object.assign(item(0, 'queued'), { name: 'STALE SONG' })];
      await H.resolve('spotify.queue', old);            // the FIRST card's read lands late
      check('a read from a closed card never paints into the new one', !/STALE SONG/.test(await H.text()));
      await H.resolve('spotify.queue', QUEUE());
      check('the new card shows its own read', /Midnight City/.test(await H.text()));
    });

    // ================================================================ Library
    await run('library', async (H) => {
      await H.fresh({ 'spotify.library': { __defer: true }, 'spotify.playUri': { ok: true, verified: true, player: Object.assign({}, PLAYER, { context: 'spotify:playlist:' + id22(91) }) } });
      await H.open(); await H.expand();
      await H.click('.spq-tab[data-k="tab:lib"]');
      check('Library tab selected (aria-selected, tick)', (await H.attr('.spq-tab[data-k="tab:lib"]', 'aria-selected')) === 'true');
      check('loading: skeleton', (await H.n('.spq-skel')) === 4);
      await H.resolve('spotify.library', LIB());
      const t = await H.text('.spq-list');
      check('Liked Songs first, then the items, then the skipped note', /^Liked Songs/.test(t) && /Late night drive/.test(t) && /Currents/.test(t) && /1 folder or item that can’t be played from here is not listed/.test(t), t);
      check('the playing playlist has the wash + tick (aria-current)', (await H.n('.spq-item.cur')) === 1 && /Late night drive/.test(await H.text('.spq-item.cur')));
      check('artist art is round', (await H.n('.spq-art.round')) === 1);
      await H.shot('20-library');
      await H.click('.spq-list .spq-row >> nth=2');
      check('a tap plays the playlist', (await H.last('spotify.playUri')).uri === 'spotify:playlist:' + id22(91) && /Playing “Focus flow”/.test((await H.note()).text));
      check('…and the tick moves to it', /Focus flow/.test(await H.text('.spq-item.cur')));
      await H.pg.locator('.spq-tab[data-k="tab:lib"]').focus();
      await H.pg.keyboard.press('ArrowLeft'); await H.flush();
      check('Left/Right switch the tabs', (await H.attr('.spq-tab[data-k="tab:queue"]', 'aria-selected')) === 'true' && await H.pg.evaluate(() => document.activeElement.getAttribute('data-k') === 'tab:queue'));
      await H.set('spotify.library', { ok: false, state: 'error', reason: 'Your library could not be read: Spotify’s page threw: TypeError: x' });
      await H.pg.evaluate(() => {});
    });
    await run('library-error', async (H) => {
      await H.fresh({ 'spotify.library': { ok: false, state: 'error', reason: 'Your library could not be read: Spotify’s page threw: TypeError: x' } });
      await H.open(); await H.expand();
      await H.click('.spq-tab[data-k="tab:lib"]');
      const t = await H.text('.spq-state');
      check('error: headline + plain reason + Try again', /Your library didn’t load/.test(t) && /ran into a problem/.test(t) && /Try again/.test(t), t);
      await noJargon(H, 'library error');
      await H.set('spotify.library', LIB());
      await H.click('.spq-state .spq-link.act');
      check('Try again loads it', /Late night drive/.test(await H.text('.spq-list')));
    });

    // ================================================================ Search
    await run('search', async (H) => {
      await H.fresh({ 'spotify.searchAll': { __defer: true }, 'spotify.add': { ok: true, verified: true }, 'spotify.playUri': { ok: true, verified: true } });
      await H.open(); await H.expand();
      await H.click('.spq-input');
      check('clicking the box asks for the keyboard', (await H.count('qs.keyboard')) === 1 && (await H.last('qs.keyboard')).on === true);
      await H.pg.keyboard.type('daft');
      await H.tick(200);
      check('no search before the 380 ms wait', (await H.count('spotify.searchAll')) === 0);
      await H.tick(250);
      check('one search after it, for the whole text', (await H.count('spotify.searchAll')) === 1 && (await H.last('spotify.searchAll')).q === 'daft');
      check('searching: skeleton rows; no tab selected', (await H.n('.spq-skel')) === 3 && (await H.n('.spq-tab[aria-selected="true"]')) === 0);
      await H.resolve('spotify.searchAll', SEARCH('daft'));
      const t = await H.text('.spq-list');
      check('grouped: Songs, Artists, Playlists (no empty Albums)', /Songs.*Artists.*Playlists/.test(t) && !/Albums/.test(t), t);
      check('song results keep their + visible', (await H.n('.spq-tools.keep')) === 2);
      await H.shot('30-search');
      await H.click('.spq-list .spq-item >> nth=0 >> .spq-tool');
      check('+ queues the song', (await H.last('spotify.add')).uri === TR(20) && /Added “Get Lucky” to the queue/.test((await H.note()).text));
      check('…and becomes a disabled check "Added to the queue"', (await H.attr('.spq-list .spq-item >> nth=0 >> .spq-tool', 'title')) === 'Added to the queue' || await H.pg.evaluate(() => document.querySelector('.spq-list .spq-item .spq-tool').disabled));
      await H.click('.spq-list .spq-row >> nth=2');
      check('a tap on the artist plays it', (await H.last('spotify.playUri')).uri === 'spotify:artist:' + id22(22) && /^Playing Daft Punk$/.test((await H.note()).text));
      // keyboard
      await H.pg.locator('.spq-input').focus();
      await H.pg.keyboard.press('ArrowDown'); await H.flush();
      check('ArrowDown from the box goes to the first result', /Get Lucky/.test(await H.pg.evaluate(() => document.activeElement.textContent)));
      await H.pg.keyboard.press('ArrowDown'); await H.flush();
      await H.pg.keyboard.press('Shift+Enter'); await H.flush();
      check('Shift+Enter queues the focused song', (await H.last('spotify.add')).uri === TR(21));
      await H.pg.keyboard.press('Home'); await H.pg.keyboard.press('ArrowUp'); await H.flush();
      check('ArrowUp from the first result goes back to the box', await H.pg.evaluate(() => document.activeElement.classList.contains('spq-input')));
      // stale answers
      await H.pg.keyboard.press('End'); await H.pg.keyboard.type('x'); await H.tick(400);
      await H.pg.keyboard.type('y'); await H.tick(400);
      await H.resolve('spotify.searchAll', Object.assign(SEARCH('daftx'), { tracks: [{ uri: TR(30), kind: 'track', name: 'OLD ANSWER', sub: 'x', image: '' }] }));
      check('an answer for an older query is dropped', !/OLD ANSWER/.test(await H.text('.spq-list')));
      await H.resolve('spotify.searchAll', Object.assign(SEARCH('daftxy'), { tracks: [], artists: [], playlists: [] }));
      check('no results: said, with what to try', /No results for “daftxy”/.test(await H.text('.spq-state')) && /fewer words/.test(await H.text('.spq-state')));
      await H.pg.keyboard.press('Enter'); await H.flush();
      check('Enter searches at once', (await H.count('spotify.searchAll')) === 4);
      await H.reject('spotify.searchAll', 'Spotify’s page gave no answer');
      check('search error: headline + plain reason + Try again', /Search didn’t work/.test(await H.text('.spq-state')) && /didn’t answer in time/.test(await H.text('.spq-state')));
      await H.pg.locator('.spq-input').focus();
      await H.pg.keyboard.press('Escape'); await H.flush();
      check('Esc with text clears the search and does NOT close the card', (await H.pg.inputValue('.spq-input')) === '' && (await H.pg.evaluate(() => T.docEsc)) === 0);
      check('…the tab comes back', (await H.attr('.spq-tab[data-k="tab:queue"]', 'aria-selected')) === 'true');
      await H.pg.keyboard.press('Escape'); await H.flush();
      check('Esc on an empty box reaches the card (closes it)', (await H.pg.evaluate(() => T.docEsc)) === 1);
    });
    await run('search-long', async (H) => {
      const long = 'An extremely long song title that goes on and on well past the width of the card (Remastered 2011 Deluxe Edition)';
      await H.fresh({ 'spotify.searchAll': Object.assign(SEARCH('long'), { tracks: [{ uri: TR(40), kind: 'track', name: long, sub: 'A very long list of artists, featuring several more artists, and yet more', image: art(1) }] }), 'qs.keyboard': { ok: false, reason: 'the bar window could not take the keyboard' } });
      await H.open(); await H.expand();
      await H.click('.spq-input');
      await H.pg.keyboard.type('long'); await H.tick(400);
      check('a long name is ellipsized on one line', await H.pg.evaluate(() => { const t = document.querySelector('.spq-list .spq-t'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis'; }));
      check('…and the full name + artists are on hover', (await H.attr('.spq-list .spq-row', 'title')).includes(long) && (await H.attr('.spq-list .spq-row', 'title')).includes('yet more'));
      check('keyboard refusal said under the box', /Typing may not reach this box/.test(await H.text('.spq')));
      await H.shot('31-search-long');
    });

    // ================================================================ shuffle / repeat / like
    await run('player-tools', async (H) => {
      await H.fresh({ 'spotify.info': { __defer: true }, 'spotify.shuffle': { ok: true, verified: true, player: Object.assign({}, PLAYER, { shuffle: true }) }, 'spotify.repeat': { ok: true, verified: true, player: Object.assign({}, PLAYER, { repeat: 1 }) } });
      await H.open(); await H.expand();
      check('before the read: no heart; shuffle/repeat disabled, said in the tooltip', (await H.n('.spq-tool[data-k="tool:like"]')) === 0 && await H.pg.evaluate(() => Array.from(document.querySelectorAll('.spq-bar .spq-tool')).every((b) => b.disabled && /Reading Spotify/.test(b.title))));
      await H.resolve('spotify.info', INFO());
      check('after it: enabled; tooltips name the action', (await H.attr('.spq-tool[data-k="tool:shuffle"]', 'title')) === 'Turn shuffle on' && (await H.attr('.spq-tool[data-k="tool:like"]', 'title')) === 'Save to Liked Songs');
      await H.pg.locator('.spq-tool[data-k="tool:shuffle"]').dblclick(); await H.flush();
      check('shuffle: one call on a double-click, on:true, then on (aria-pressed, accent)', (await H.count('spotify.shuffle')) === 1 && (await H.last('spotify.shuffle')).on === true && (await H.attr('.spq-tool[data-k="tool:shuffle"]', 'aria-pressed')) === 'true' && /Shuffle on/.test((await H.note()).text));
      await H.click('.spq-tool[data-k="tool:repeat"]');
      check('repeat: off -> all', (await H.last('spotify.repeat')).mode === 1 && (await H.attr('.spq-tool[data-k="tool:repeat"]', 'aria-pressed')) === 'true');
      await H.set('spotify.repeat', { ok: true, verified: true, player: Object.assign({}, PLAYER, { shuffle: true, repeat: 2 }) });
      await H.click('.spq-tool[data-k="tool:repeat"]');
      check('repeat: all -> this song, with the 1 mark', (await H.last('spotify.repeat')).mode === 2 && (await H.n('.spq-tool.one')) === 1);
      await H.set('spotify.shuffle', { ok: false, state: 'error', reason: 'Spotify refused: Shuffle is not allowed' });
      await H.click('.spq-tool[data-k="tool:shuffle"]');
      check('a refusal is said', (await H.note()).bad && /^Shuffle didn’t change/.test((await H.note()).text));
    });
    await run('like', async (H) => {
      await H.fresh({ 'spotify.like': { __defer: true } });
      await H.open(); await H.expand();
      const heart = '.spq-tool[data-k="tool:like"]';
      check('not liked: outline heart, "Save to Liked Songs", aria-pressed false', (await H.attr(heart, 'aria-pressed')) === 'false' && (await H.attr(heart, 'title')) === 'Save to Liked Songs');
      await H.shot('40-like-off');
      await H.pg.locator(heart).dblclick();
      check('flips AT ONCE (optimistic), before Spotify answers', (await H.attr(heart, 'aria-pressed')) === 'true' && (await H.attr(heart, 'title')) === 'Remove from Liked Songs');
      await H.flush();
      check('a double-click likes once, naming the song', (await H.count('spotify.like')) === 1 && (await H.last('spotify.like')).on === true && (await H.last('spotify.like')).uri === TR(8));
      await H.resolve('spotify.like', { ok: true, liked: true, uri: TR(8) });
      check('Saved to Liked Songs', /^Saved to Liked Songs$/.test((await H.note()).text) && (await H.attr(heart, 'aria-pressed')) === 'true');
      await H.shot('41-like-on');
      await H.click(heart);
      check('clicking again is the undo: on:false', (await H.last('spotify.like')).on === false && (await H.attr(heart, 'aria-pressed')) === 'false');
      await H.resolve('spotify.like', { ok: true, liked: false });
      check('Removed from Liked Songs', /^Removed from Liked Songs$/.test((await H.note()).text));
      await H.click(heart);
      await H.resolve('spotify.like', { ok: false, state: 'error', code: 'nolike', reason: 'Spotify’s LibraryAPI has no add/remove/contains' });
      const nb = await H.note();
      check('refused: put back, said in plain words, raw on the tooltip', (await H.attr(heart, 'aria-pressed')) === 'false' && nb.bad && /^Not saved to Liked Songs: This version of Spotify doesn’t allow that from Mantle$/.test(nb.text) && /LibraryAPI/.test(nb.title), nb);
      await H.click(heart);
      await H.reject('spotify.like', 'Spotify is not running');
      check('a thrown call is put back too', (await H.attr(heart, 'aria-pressed')) === 'false' && (await H.note()).bad);
      await H.click(heart);
      await H.resolve('spotify.like', { ok: true, liked: false, reason: 'Spotify took it, but it did not stick' });
      check('Spotify took it but the re-read says no: the heart shows the truth + a warning', (await H.attr(heart, 'aria-pressed')) === 'false' && (await H.note()).bad);
      await H.click(heart);
      await H.resolve('spotify.like', { ok: true, dryRun: true, liked: true, reason: 'dry run: Liked Songs was not changed in a test run' });
      check('a test instance (dry run) puts the heart back and says so, never "Saved"', (await H.attr(heart, 'aria-pressed')) === 'false' && /^Test instance: /.test((await H.note()).text));
      // track change -> re-read
      await H.set('spotify.info', Object.assign(INFO(), { liked: true, player: Object.assign({}, PLAYER, { item: TR(3) }) }));
      const i0 = await H.count('spotify.info');
      await H.paint(Object.assign({}, SESSION, { title: 'Redbone', artist: 'Childish Gambino' }));
      await H.tick(700);
      check('a track change re-reads the heart', (await H.count('spotify.info')) === i0 + 1 && (await H.attr(heart, 'aria-pressed')) === 'true');
      await H.set('spotify.info', Object.assign(INFO(), { liked: null, player: Object.assign({}, PLAYER, { item: 'spotify:local:Artist:Album:Song:180' }) }));
      await H.paint(Object.assign({}, SESSION, { title: 'Local song' })); await H.tick(700);
      check('liked unknown (a local file): no heart at all', (await H.n('.spq-tool[data-k="tool:like"]')) === 0);
    });

    // ================================================================ feature 2: nothing loaded
    await run('idle', async (H) => {
      await H.fresh({ 'spotify.playUri': { __defer: true } });
      await H.open(IDLE_SESSION);
      check('shut + nothing loaded: ONE button, Play Liked Songs, with no read', (await H.vis('.spq-idle .spq-btn')) && (await H.text('.spq-idle')) === 'Play Liked Songs' && (await H.count('spotify.info')) === 0);
      await H.shot('50-idle-shut');
      await H.pg.locator('.spq-idle .spq-btn').dblclick(); await H.flush();
      check('plays Liked Songs, once', (await H.count('spotify.playUri')) === 1 && (await H.last('spotify.playUri')).uri === 'spotify:collection:tracks');
      check('busy while it starts', (await H.attr('.spq-idle .spq-btn', 'aria-busy')) === 'true');
      await H.resolve('spotify.playUri', { ok: false, state: 'error', reason: 'Spotify refused: no active device' });
      check('a refusal is said even with the section shut', (await H.vis('.spq-note')) && (await H.note()).bad && /Didn’t play it/.test((await H.note()).text));
      await H.set('spotify.playUri', { ok: true, verified: true, player: Object.assign({}, PLAYER, { context: 'spotify:collection:tracks' }) });
      await H.click('.spq-idle .spq-btn');
      await H.paint(SESSION);
      check('once something plays, the button goes', !(await H.vis('.spq-idle')));
    });
    await run('idle-open', async (H) => {
      await H.fresh({ 'spotify.info': Object.assign(INFO(), { liked: null, player: Object.assign({}, PLAYER, { item: null, hasItem: false, context: null }) }), 'spotify.queue': Object.assign(QUEUE(), { current: null, queued: [], nextUp: [], totalQueued: 0 }) });
      await H.open(IDLE_SESSION); await H.expand();
      check('open + nothing loaded: Play Liked Songs first, the list says Nothing is playing', (await H.vis('.spq-idle .spq-btn')) && /Nothing is playing/.test(await H.text('.spq-state')));
      check('no heart with nothing to like', (await H.n('.spq-tool[data-k="tool:like"]')) === 0);
      await H.shot('51-idle-open');
    });

    // ================================================================ More
    await run('more', async (H) => {
      await H.fresh({ 'spotify.quit': { ok: true }, 'spotify.openWindow': { ok: true, verified: true, window: { state: 'shown' } }, 'spotify.gameclose': { __defer: true }, 'spotify.revive': { ok: true } });
      await H.open(); await H.expand();
      check('More is shut by default: no window line, no toggles', !(await H.vis('.spq-more')) && (await H.text('.spq-more-btn')) === 'More');
      await H.click('.spq-more-btn');
      const t = await H.text('.spq-more');
      check('More: Running hidden · 358 MB, Open Spotify, Quit Spotify, both toggles on', /Running hidden · 358 MB/.test(t) && /Open Spotify/.test(t) && /Quit Spotify/.test(t) && (await H.n('.spq-opt input:checked')) === 2, t);
      await noJargon(H, 'more');
      await H.shot('60-more');
      await H.clickText('Quit Spotify');
      check('Quit: first click arms (no call)', (await H.count('spotify.quit')) === 0 && /Click again to quit/.test(await H.text('.spq-more')));
      await H.shot('61-quit-armed');
      await H.tick(5100);
      check('5 s later disarmed', /Quit Spotify/.test(await H.text('.spq-more')));
      await H.clickText('Quit Spotify');
      await H.pg.keyboard.press('Escape'); await H.flush();
      check('Esc disarms Quit first', /Quit Spotify/.test(await H.text('.spq-more')) && (await H.pg.evaluate(() => T.docEsc)) === 0);
      // toggles
      await H.pg.locator('.spq-opt input').first().click(); await H.flush();
      check('toggle sends gameclose on:false and is held while it goes', (await H.last('spotify.gameclose')).on === false && await H.pg.evaluate(() => document.querySelector('.spq-opt input').disabled));
      await H.resolve('spotify.gameclose', { ok: false, reason: 'the setting could not be saved (EPERM: operation not permitted)' });
      check('refused: put back to on, said in plain words', await H.pg.evaluate(() => { const c = document.querySelector('.spq-opt input'); return c.checked && !c.disabled; }) && (await H.note()).bad && !/EPERM/.test((await H.note()).text), await H.note());
      await H.pg.locator('.spq-opt input').nth(1).click(); await H.flush();
      check('the other toggle: revive on:false, said, status re-read', (await H.last('spotify.revive')).on === false && /Restart Spotify after games: off/.test((await H.note()).text));
      // window
      await H.set('spotify.info', Object.assign(INFO(), { window: { state: 'shown' }, visible: true }));
      await H.clickText('Open Spotify');
      check('Open Spotify: said, then the button is Hide window', (await H.count('spotify.openWindow')) === 1 && /window is open/.test((await H.note()).text) && /Hide window/.test(await H.text('.spq-more')));
      await H.pg.locator('.spq-more .spq-sbtn').first().focus();
      await H.pg.keyboard.press('Escape'); await H.flush();
      check('Esc inside More shuts More (focus back on More), not the card', !(await H.vis('.spq-more')) && await H.pg.evaluate(() => document.activeElement.classList.contains('spq-more-btn')) && (await H.pg.evaluate(() => T.docEsc)) === 0);
      await H.clickText('Quit Spotify').catch(() => {});
      await H.click('.spq-more-btn');
      await H.clickText('Quit Spotify'); await H.clickText('Click again to quit');
      check('Quit on the second click, once', (await H.count('spotify.quit')) === 1);
    });
    await run('more-flag', async (H) => {
      await H.fresh({ 'spotify.info': Object.assign(INFO(), { memory: null, memoryReason: 'could not read Spotify’s memory (powershell.exe exited 1)' }) });
      await H.open(); await H.expand();
      check('a problem inside More: warn dot on it, said in its tooltip', (await H.attr('.spq-more-btn', 'class')).includes('flag') && /needs a look/.test(await H.attr('.spq-more-btn', 'title')));
      await H.shot('62-more-flag');
    });
    await run('window-failed', async (H) => {
      const w = { state: 'failed', own: true, reason: 'Spotify’s window service did not answer, so its window could not be hidden' };
      await H.fresh({ 'spotify.status': STATUS({ window: w }), 'spotify.info': Object.assign(INFO(), { window: w, visible: true }), 'spotify.hideWindow': { ok: true, verified: true, window: { state: 'hidden' } } });
      await H.open();
      check('head says Not hidden (warn), even shut', (await H.text('.spq-hint')) === 'Not hidden' && (await H.attr('.spq-hint', 'class')).includes('warn'));
      await H.expand();
      check('first screen: warn glyph + one line + Hide now', (await H.vis('.spq-warn')) && /Hide now/.test(await H.text('.spq-warn')), await H.text('.spq-warn'));
      await H.shot('63-window-failed');
      await H.set('spotify.info', INFO());
      await H.clickText('Hide now');
      check('Hide now hides it; the warning goes', (await H.count('spotify.hideWindow')) === 1 && !(await H.vis('.spq-warn')));
    });
    await run('hiding-countdown', async (H) => {
      await H.fresh();
      await H.open(); await H.expand(); await H.click('.spq-more-btn');
      const at = await H.pg.evaluate(() => Date.now());
      const w = { state: 'hiding', retryAt: at + 5000, retryWhy: 'its window is still showing' };
      await H.push('spotify.status', STATUS({ window: w }));
      check('hiding: head says Hiding…, More counts down', (await H.text('.spq-hint')) === 'Hiding…' && /trying again in 5 s/.test(await H.text('.spq-more')));
      await H.tick(2000);
      check('…3 s after 2 s', /trying again in 3 s/.test(await H.text('.spq-more')), await H.text('.spq-more'));
      await H.close();
      check('closed(): the countdown timer is freed too', (await H.pg.evaluate(() => T.live())) === 0);
    });

    // ================================================================ holes
    await run('arm-across-cards', async (H) => {
      await H.fresh({ 'spotify.quit': { ok: true } });
      await H.open(); await H.expand(); await H.click('.spq-more-btn');
      await H.clickText('Quit Spotify');                 // card 1 armed at t=0
      await H.close();
      await H.open();                                     // card 2 (More stays open for the session)
      await H.tick(3000);
      await H.clickText('Quit Spotify');                 // card 2 armed at t=3 s
      await H.tick(2500);                                 // t=5.5 s: card 1's old timer would have fired here
      check('an old card’s timer never disarms a new card', /Click again to quit/.test(await H.text('.spq-more')));
    });
    // r5-autopause lane: Spotify auto-pause's line under the head (only while it acts) and its words under More.
    await run('autopause-line', async (H) => {
      await H.fresh();
      await H.open();
      check('autopause: no line before anything is pushed', !(await H.vis('.spq-ap')));
      await H.push('autopause.status', { ok: true, state: 'holding', words: 'Paused while LessonPlayer plays', card: 'Paused while LessonPlayer plays', mode: 'media' });
      check('autopause: holding shows its line', (await H.text('.spq-ap')) === 'Paused while LessonPlayer plays' && (await H.vis('.spq-ap')), await H.text('.spq-ap'));
      await H.push('autopause.status', { ok: true, state: 'error', words: 'Spotify could not be paused: Windows did not answer', card: 'Couldn’t pause Spotify', mode: 'media' });
      check('autopause: a failure is said in the warn colour, its reason on hover', String(await H.attr('.spq-ap', 'class')).includes('bad') && String(await H.attr('.spq-ap', 'title')).includes('Windows did not answer'));
      await H.push('autopause.status', { ok: true, state: 'standby', words: 'The separate Spotify auto-pause helper on this PC is in charge, so Mantle’s stays off', card: '', mode: 'media' });
      check('autopause: standby puts no line under the head', !(await H.vis('.spq-ap')));
      await H.expand(); await H.clickText('More');
      check('autopause: standby is said under More', /^Auto-pause: The separate Spotify auto-pause helper/.test((await H.text('.spq-ap-more')) || ''), await H.text('.spq-ap-more'));
      await H.push('autopause.status', { ok: true, state: 'off', words: 'Off', card: '', mode: 'media' });
      check('autopause: off says nothing anywhere', !(await H.vis('.spq-ap')) && !(await H.vis('.spq-ap-more')));
      await H.push('autopause.status', { ok: true, state: 'holding', words: 'Paused while Opera GX plays a video', card: 'Paused while Opera GX plays a video', mode: 'media' });
      check('autopause: while it acts, More does not repeat the line', !(await H.vis('.spq-ap-more')) && (await H.vis('.spq-ap')));
      await H.shot('autopause-holding-more-open');
      await noJargon(H, 'autopause');
    });

    // r6-apfix: auto-pause's own switch under More (the feature's real on/off; replies faked, nothing real moves).
    await run('autopause-switch', async (H) => {
      await H.fresh();
      await H.open();
      await H.push('autopause.status', { ok: true, state: 'holding', words: 'Paused while LessonPlayer plays', card: 'Paused while LessonPlayer plays', mode: 'media' });
      await H.expand();
      check('switch: hidden while More is closed (the closed card does not move)', !(await H.vis('.spq-apsw')));
      await H.clickText('More');
      check('switch: one row under More, on, with plain words', (await H.vis('.spq-apsw')) && (await H.attr('.spq-apsw-btn', 'aria-checked')) === 'true'
        && (await H.text('.spq-apsw-btn')) === 'Pause Spotify for videos' && (await H.attr('.spq-apsw-btn', 'role')) === 'switch', await H.text('.spq-apsw'));
      await H.set('autopause.switch', { ok: true, on: false, state: 'off', words: 'Off', card: '', mode: 'media' });
      await H.click('.spq-apsw-btn');
      const sent = await H.pg.evaluate(() => T.calls.filter((c) => c[0] === 'autopause.switch').map((c) => c[1]));
      check('switch off: asks the feature to turn off', JSON.stringify(sent) === JSON.stringify([{ on: false }]), JSON.stringify(sent));
      check('switch off: shows off at once, and the "Paused while" line goes', (await H.attr('.spq-apsw-btn', 'aria-checked')) === 'false' && !(await H.vis('.spq-ap')));
      await H.push('autopause.status', { ok: true, state: 'standby', words: 'The separate Spotify auto-pause helper on this PC is in charge, so Mantle’s stays off', card: '', mode: 'media' });
      await H.push('autopause.status', { ok: true, state: 'off', words: 'Off', card: '', mode: 'media' });
      check('off: no line and no standby words', !(await H.vis('.spq-ap')) && !(await H.vis('.spq-ap-more')));
      await H.set('autopause.switch', { ok: false, on: false, reason: 'Spotify auto-pause was stopped when Mantle put Windows back; it comes back when Mantle restarts' });
      await H.click('.spq-apsw-btn');
      check('a refused switch says why on the row, and stays off', (await H.vis('.spq-apsw-err')) && /Couldn’t turn auto-pause on: Spotify auto-pause was stopped/.test((await H.text('.spq-apsw-err')) || '')
        && (await H.attr('.spq-apsw-btn', 'aria-checked')) === 'false', await H.text('.spq-apsw-err'));
      await H.set('autopause.switch', { __throw: 'the call timed out' });
      await H.click('.spq-apsw-btn');
      check('a failed call is said too', /Couldn’t turn auto-pause on: The call timed out/i.test((await H.text('.spq-apsw-err')) || ''), await H.text('.spq-apsw-err'));
      await H.set('autopause.switch', { ok: true, on: true, state: 'idle', words: 'On: Spotify pauses while another app plays video or sound', card: '', mode: 'media' });
      await H.click('.spq-apsw-btn');
      check('switch on: on, the error line gone, and idle words not repeated under More', (await H.attr('.spq-apsw-btn', 'aria-checked')) === 'true' && !(await H.vis('.spq-apsw-err')) && !(await H.vis('.spq-ap-more')));
      await H.shot('autopause-switch-on');
      for (const w of [393, 320]) {
        await H.pg.setViewportSize({ width: w, height: 760 });
        await H.flush();
        const fit = await H.pg.evaluate(() => { const b = document.querySelector('.spq-apsw-btn'); const r = b.getBoundingClientRect(); return { right: r.right, vw: document.documentElement.clientWidth, over: b.scrollWidth - b.clientWidth, h: Math.round(r.height) }; });
        check(`switch row fits at ${w}px (no overflow, one 28 px row)`, fit.right <= fit.vw + 0.5 && fit.over <= 0 && fit.h === 28, JSON.stringify(fit));
      }
      await H.pg.setViewportSize({ width: 380, height: 760 });
      await noJargon(H, 'autopause-switch');
    });

    await run('push-and-dead-sub', async (H) => {
      await H.fresh();
      await H.pg.evaluate(() => { T.deadReason = 'the live channel closed'; });
      await H.open(); await H.expand();
      check('a dead subscription is said', /Live updates from Spotify are off/.test(((await H.note()) || {}).text || ''));
      await H.push('spotify.status', STATUS({ state: 'notrunning', reason: 'Spotify is not running: it closed without being asked' }));
      check('a pushed state change repaints at once', /Spotify isn’t running/.test(await H.text()));
    });
    await run('fit', async (H) => {
      await H.fresh();
      await H.pg.evaluate(() => { document.querySelector('.mc-src').hidden = false; });
      await H.open(); await H.expand();
      const h = await H.pg.evaluate(() => document.querySelector('.pop').offsetHeight);
      check('the whole card fits its 600 DIP room (sources folded away if needed)', h + 16 <= 600, h);
      check('…and says so when the sources fold', !(await H.pg.evaluate(() => document.querySelector('.pop').classList.contains('spq-squeeze'))) || /source list is hidden/.test(await H.text()));
      // r3-media: More open squeezes the list; it ends on a whole row, never a sliver of the next one
      await H.click('.spq-more-btn');
      const cut = await H.pg.evaluate(() => {
        const sc = document.querySelector('.spq-scroll'), top = sc.getBoundingClientRect().top - sc.scrollTop, h = sc.clientHeight;
        return { h, cut: Array.from(sc.querySelectorAll('.spq-item, .spq-sec')).map((r) => [r.getBoundingClientRect().top - top, r.getBoundingClientRect().bottom - top]).filter(([t, b]) => t < h - 1 && b > h + 1 && h - t < (b - t) * 0.35).length };
      });
      check('More open: the squeezed list never ends on a sliver of the next row (a whole row, or a real peek)', cut.cut === 0 && cut.h >= 40, cut);
      const h2 = await H.pg.evaluate(() => document.querySelector('.pop').offsetHeight);
      check('More open: the card still fits its 600 DIP room', h2 + 16 <= 600, h2);
    });
    await run('tab-order', async (H) => {
      await H.fresh();
      await H.open(); await H.expand();
      await H.pg.locator('.spq-head').focus();
      const seen = [];
      for (let i = 0; i < 9; i++) {
        await H.pg.keyboard.press('Tab');
        seen.push(await H.pg.evaluate(() => { const a = document.activeElement; return a.getAttribute('data-k') || a.className.split(' ')[0]; }));
      }
      const want = ['tab:queue', 'tool:like', 'tool:shuffle', 'tool:repeat', 'spq-row', 'spq-input', 'spq-more-btn'];
      check('Tab order: tabs (one stop), heart, shuffle, repeat, the list (one stop), search, More', want.every((w, i) => seen[i] === w), seen);
      await H.pg.locator('.spq-head').focus();
      await H.pg.keyboard.press('Enter'); await H.flush();
      check('Enter on the head shuts it', !(await H.vis('.spq-body')));
    });

    // ================================================================ 1.5x shots
    if (P15 && (!ONLY || ONLY.includes('shots15'))) {
      scen = 'shots15';
      const H = P15;
      await H.fresh(); await H.open(); await H.expand(); await H.pg.hover('.spq-list .spq-item >> nth=1'); await H.shot('11-up-next');
      await H.click('.spq-tab[data-k="tab:lib"]'); await H.shot('20-library');
      await H.fresh(); await H.open(IDLE_SESSION); await H.shot('50-idle-shut');
      await H.fresh({ 'spotify.status': STATUS({ state: 'notrunning' }) }); await H.open(); await H.expand(); await H.shot('01-not-running');
      await H.fresh(); await H.open(); await H.expand(); await H.click('.spq-more-btn'); await H.shot('60-more');
    }
  } finally { await browser.close(); }
  for (const e of errors) failures.push('page error: ' + e);
}

(async () => {
  nodeTests();
  if (process.env.PAGE === '0') console.log('PAGE=0: the page part is skipped'); else await pageTests();
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY CARD TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
