/* spotify-holes.test.js - the media-be lane's holes and the heart (Liked Songs), against the FAKE
 * Spotify (./_spotify-fakecdp.js) and a fake process list. Nothing touches the real Spotify.
 *   node lib/features/spotify-holes.test.js
 * Each block failed before its fix (2026-09-29): jargon on the card, a leaked socket on a double
 * click, a dead socket after sleep, artwork broken for good after a network blip, a watch read after
 * stop(), a hide/watch started after stop() mid-start; plus the new like() and info().liked.
 */
'use strict';
const http = require('http');
const { createSpotifyApp, PORT } = require('./_spotify-app.js');
const { createFakeSpotify, fakeFetch, fakeProc, uri } = require('./_spotify-fakecdp.js');
const { createTrimWatch } = require('./_spotify-trim.js');
const { words } = require('./_spotify-revive.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
const J = (x) => JSON.stringify(x);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
const FAST = { verifyDelayMs: 5, stepDelayMs: 2, pollMs: 25, closeWaitMs: 150, forceAfterMs: 150, forceWaitMs: 150, startWaitMs: 800, httpTimeoutMs: 800, openTimeoutMs: 800,
  evalTimeoutMs: 1500, searchTimeoutMs: 1500, hideEvalMs: 800, hideEvalMaxMs: 1500, likeWaitMs: 300, likeSettleMs: 5 };
function bridge(port, extra) {
  const statuses = [], logs = [];
  const proc = (extra && extra.proc) || fakeProc({ pids: [100] });
  const sp = createSpotifyApp(Object.assign({ port, proc, fetch: fakeFetch([]), exe: 'C:\\Users\\someone\\AppData\\Roaming\\Spotify\\Spotify.exe',
    log: (t) => logs.push(t), onStatus: (s) => statuses.push(s) }, FAST, extra || {}));
  return { sp, statuses, logs, proc };
}
/* Every string the card shows: these keys, anywhere in an answer or a pushed status. */
const SHOWN = ['reason', 'note', 'text', 'plan', 'memoryReason', 'playerReason', 'imageReason', 'retryWhy', 'lastReason', 'error', 'likedReason', 'how'];
const JARGON = /CDP|evaluat|\bpids?\b|sidecar|taskkill|\/PID|0x[0-9A-F]{4,}|\bE[A-Z]{4,}\b|\w\(\)|[a-z]API\b|React|Platform object|debugger|--[a-z]|HTTP \d{3}|\bundefined\b|\bnull\b|NaN|\[object|\bat \S+:\d+|exit code|window-state|CimInstance|PowerShell|[A-Za-z]:\\|spotify:[a-z]/;
function shown(x, out, depth) {
  if (!x || typeof x !== 'object' || (depth || 0) > 6) return out;
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (typeof v === 'string' && SHOWN.includes(k)) out.push(v);
    else if (v && typeof v === 'object') shown(v, out, (depth || 0) + 1);
  }
  return out;
}
const jargonIn = (things) => things.flatMap((t) => shown(t, [])).filter((s) => JARGON.test(s) && !/^dry run/.test(s));
const PRIVATE = /Song \d|Artist \d|spotify:(track|episode|local|playlist|album|artist):[A-Za-z0-9]|[A-Za-z]:\\Users/;

(async () => {
  /* ------------------------------------------------ plain words on the card, in every state we can make */
  {
    const seen = [];
    const port = await freePort();
    const b = bridge(port, { proc: fakeProc({ pids: [] }) });
    seen.push(await b.sp.status(), await b.sp.queue(), await b.sp.like({ on: true }), await b.sp.info());
    b.proc.P.pids = [7]; seen.push(await b.sp.status(), await b.sp.search({ q: 'x' }));
    b.proc.P.exists = false; seen.push(await b.sp.status(), await b.sp.start());
    b.proc.P.exists = true; b.proc.running = async () => { throw new Error('tasklist.exe failed at C:\\Windows\\System32'); };
    seen.push(await b.sp.status(), await b.sp.start());
    b.sp.stop();
    for (const opts of [{ internals: 'none' }, { internals: 'loading' }, { list: [{ id: 'X', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/X' }] },
      { skipToThrows: true, search: 'broken', controlsIgnored: true, playFails: true, windowApi: false, lifecycle: false, like: 'throw' }, { stuck: true }]) {
      const F = createFakeSpotify(opts);
      const p = await F.start();
      const proc = fakeProc({ pids: [9] });
      proc.P.closePidWorks = false; proc.P.killPidWorks = false; proc.P.snapshotFails = 'Get-CimInstance : Access denied at C:\\x.ps1:1';
      const x = bridge(p, { proc });
      seen.push(await x.sp.status(), await x.sp.queue(), await x.sp.play({ uri: uri(12), uid: 'u12' }), await x.sp.search({ q: 'x' }), await x.sp.searchAll({ q: 'x' }),
        await x.sp.library(), await x.sp.shuffle({ on: true }), await x.sp.repeat({ mode: 1 }), await x.sp.playUri({ uri: 'spotify:playlist:' + 'P'.repeat(22) }),
        await x.sp.like({ on: true }), await x.sp.info(), await x.sp.hideWindow(), await x.sp.quit(), await x.sp.add({ uri: 'javascript:alert(1)' }),
        await x.sp.remove({ uri: 'x' }), await x.sp.move({ uri: uri(2), uid: 'u2', dir: 'sideways' }), await x.sp.repeat({ mode: 7 }));
      seen.push(...x.statuses);
      ok(!x.logs.some((l) => PRIVATE.test(l)), 'no song, address or user path in the log ' + J(opts) + ' ' + J(x.logs.filter((l) => PRIVATE.test(l)).slice(0, 3)));
      x.sp.stop(); await F.stop();
    }
    seen.push({ text: words({ state: 'waiting', on: true, game: 'VALORANT', exit: { code: 0xC0000005 } }).head });
    seen.push({ text: words({ state: 'closed', on: true, game: '', scanError: 'the sidecar is not running' }).head });
    const bad = jargonIn(seen);
    ok(bad.length === 0, `no jargon in anything the card shows (${seen.length} answers): ` + J([...new Set(bad)].slice(0, 6)));
  }

  /* ------------------------------------------------ a double click: ONE socket, not one per call */
  {
    const F = createFakeSpotify();
    const p = await F.start();
    const b = bridge(p);
    const all = await Promise.all([b.sp.queue(), b.sp.info(), b.sp.status(), b.sp.queue(), b.sp.library()]);
    ok(all.every((r) => r.ok), 'five calls at once all answer');
    ok(F.calls.filter((c) => c[0] === 'upgrade').length === 1, 'five calls at once share ONE connection (each used to open its own; the extra ones leaked) ' + F.calls.filter((c) => c[0] === 'upgrade').length);
    b.sp.stop(); await wait(80);
    ok(F.sockets.size === 0, 'stop(): no connection left open ' + F.sockets.size);
    // stop() while a connection is still opening: it is closed when it lands, never kept
    const b2 = bridge(p);
    const q = b2.sp.queue();
    await wait(1); b2.sp.stop();
    await q; await wait(80);
    ok(F.sockets.size === 0, 'a connection that opens after stop() is closed, not kept ' + F.sockets.size);
    await F.stop();
  }

  /* ------------------------------------------------ the PC slept: an idle, dead connection is replaced */
  {
    const F = createFakeSpotify();
    const p = await F.start();
    const b = bridge(p, { idleCheckMs: 50, pingMs: 200 });
    ok((await b.sp.queue()).ok, 'connected');
    F.stale(); await wait(80);
    const t0 = Date.now();
    const q = await b.sp.queue();
    ok(q.ok && Date.now() - t0 < 1200, `after a sleep the first click works (a fresh connection after one ${Date.now() - t0} ms check), instead of "Spotify didn’t answer" ` + (q.reason || ''));
    ok(F.calls.filter((c) => c[0] === 'upgrade').length === 2 && b.logs.some((l) => /idle connection to Spotify did not answer; reconnecting/.test(l)), 'reconnected once, and logged');
    b.sp.stop(); await F.stop();
  }

  /* ------------------------------------------------ artwork after a network blip comes back */
  {
    const F = createFakeSpotify();
    const p = await F.start();
    let online = false, hang = false;
    const real = fakeFetch([]);
    const fetch = (u, o) => (hang ? new Promise(() => {}) : online ? real(u, o) : Promise.reject(new Error('getaddrinfo ENOTFOUND i.scdn.co')));
    const b = bridge(p, { fetch, artRetryMs: 100, artTimeoutMs: 300 });
    const q1 = await b.sp.queue();
    ok(q1.ok && q1.queued[0].image === null && q1.queued[0].imageReason === 'The artwork didn’t load', 'offline: no artwork, a plain reason');
    online = true; await wait(120);
    const q2 = await b.sp.queue();
    ok(q2.ok && /^data:image\/png/.test(q2.queued[0].image || ''), 'back online: the artwork loads (it used to stay broken for the whole session)');
    hang = true; F.q.queued[0].images = [{ url: 'https://i.scdn.co/image/ab67616d0000485100000000000000000000abcd', label: 'small' }];
    const t0 = Date.now();
    const q3 = await b.sp.queue();
    ok(q3.ok && Date.now() - t0 < 1000 && q3.queued[0].image === null, `a fetch that never answers is cut at artTimeoutMs (${Date.now() - t0} ms)`);
    b.sp.stop(); await F.stop();
  }

  /* ------------------------------------------------ nothing runs after stop() */
  {
    const reads = [];
    const w = createTrimWatch({ read: async (r) => { reads.push(r); return { running: true, visible: 0, mb: 100, procs: [] }; }, audio: async () => ({ pids: [] }), trim: async () => ({}), firstDelayMs: 100000 });
    w.start(55, 'test'); w.stop('stopped');
    await w.tickNow();
    ok(reads.length === 0 && w.view().state === 'stopped', 'a watch tick asked for after stop() reads nothing (the socket-close check did, 1.5 s later) ' + reads.length);
    // stop() while Spotify is starting: no hide, no memory watch, no retry timer afterwards
    const port = await freePort();
    const F = createFakeSpotify();
    const proc = fakeProc({ pids: [] });
    proc.P.onLaunch = async () => { setTimeout(() => F.start(port), 150); };
    const b = bridge(port, { proc, trimDelayMs: 20 });
    const st = b.sp.start();
    await wait(60); b.sp.stop('the Spotify queue was turned off');
    const r = await st;
    await wait(80);
    ok(!r.ok && r.state === 'off' && !F.calls.some((c) => c[0] === 'setWindowState') && b.sp.watch.view().state !== 'watching', 'stop() mid-start: nothing hidden or watched afterwards ' + J(r));
    await F.stop();
  }

  /* ------------------------------------------------ New feature: Like (the card's heart) */
  {
    const F = createFakeSpotify();
    const p = await F.start();
    const b = bridge(p);
    await b.sp.status();
    const cur = uri(1);
    F.ps.item = cur;
    let i = await b.sp.info();
    ok(i.liked === false && i.likedUri === cur, 'info: liked false for the current song ' + J({ liked: i.liked, likedUri: i.likedUri }));
    let r = await b.sp.like({ on: true });
    ok(r.ok && r.liked === true && r.uri === cur && F.liked.has(cur) && r.reason === null, 'like: the current song is saved, verified by a re-read ' + J(r));
    i = await b.sp.info();
    ok(i.liked === true, 'info: liked true after');
    r = await b.sp.like({ on: false, uri: cur });
    ok(r.ok && r.liked === false && !F.liked.has(cur), 'unlike by uri ' + J(r));
    // a double click: both applied, in order (like then unlike), one at a time
    const [d1, d2] = await Promise.all([b.sp.like({ on: true }), b.sp.like({ on: false })]);
    ok(d1.ok && d1.liked === true && d2.ok && d2.liked === false && !F.liked.has(cur), 'double click: liked then unliked, as clicked ' + J([d1, d2]));
    // a flood: at most one waits while one runs; the rest are refused as busy (nothing piles up)
    const libCalls = () => F.calls.filter((c) => c[0] === 'libraryAdd' || c[0] === 'libraryRemove').length;
    const beforeFlood = libCalls();
    const flood = await Promise.all([1, 2, 3, 4, 5].map((n) => b.sp.like({ on: n % 2 === 1 })));
    ok(flood.filter((x) => x.state === 'busy').length === 3 && flood.filter((x) => x.ok).length === 2 && libCalls() - beforeFlood === 2, 'five clicks at once: two applied, three refused as busy ' + J(flood.map((x) => x.state || x.ok)) + ' calls ' + (libCalls() - beforeFlood));
    // right after an answer, the next click is taken (the busy count used to drop a few microtasks late)
    const r1 = await b.sp.like({ on: true });
    const [n1, n2] = await Promise.all([b.sp.like({ on: false }), b.sp.like({ on: true })]);
    ok(r1.ok && n1.ok && n2.ok && n2.liked === true, 'clicks right after an answer are taken, not refused as busy ' + J([r1.state || r1.ok, n1.state || n1.ok, n2.state || n2.ok]));
    await b.sp.like({ on: false });
    // nothing likeable: no item, a local file
    F.ps.item = null; i = await b.sp.info();
    ok(i.liked === null && i.likedUri === null, 'info: nothing playing -> liked null');
    r = await b.sp.like({ on: true });
    ok(!r.ok && /^Nothing is playing/.test(r.reason), 'like with nothing playing: said ' + r.reason);
    F.ps.item = 'spotify:local:Some+Artist:Album:Title:200'; i = await b.sp.info();
    ok(i.liked === null && /Only Spotify songs and episodes/.test(i.likedReason), 'info: a local file -> liked null, with why');
    F.ps.item = cur;
    // bad arguments never reach Spotify
    const before = F.calls.length;
    for (const a of [{}, { on: 'yes' }, { on: 1 }, { on: true, uri: 'spotify:track:short' }, { on: true, uri: 'spotify:playlist:' + 'P'.repeat(22) }, { on: true, uri: '"); alert(1); ("' }, { on: true, uri: {} }]) {
      const x = await b.sp.like(a);
      ok(!x.ok && typeof x.reason === 'string' && !JARGON.test(x.reason), 'refused in plain words: ' + J(a) + ' -> ' + x.reason);
    }
    ok(F.calls.slice(before).every((c) => c[0] !== 'libraryAdd' && c[0] !== 'libraryRemove'), 'no bad argument reached Spotify');
    // Spotify without the LibraryAPI heart methods / throwing / hanging / ignoring
    F.opts.like = 'missing';
    i = await b.sp.info(); r = await b.sp.like({ on: true });
    ok(i.liked === null && !r.ok && r.reason === 'This version of Spotify doesn’t let Mantle change Liked Songs', 'missing LibraryAPI: info null, like says so ' + r.reason);
    F.opts.like = 'throw';
    i = await b.sp.info(); r = await b.sp.like({ on: true });
    ok(i.liked === null && !r.ok && /^Spotify couldn’t save it to Liked Songs just now/.test(r.reason) && !b.logs.some((l) => /spotify:track/.test(l)), 'contains/add throwing: info null, like plain ' + r.reason);
    F.opts.like = 'hang';
    let t0 = Date.now();
    i = await b.sp.info();
    const infoMs = Date.now() - t0;
    t0 = Date.now(); r = await b.sp.like({ on: true });
    ok(i.liked === null && infoMs < 1000 && !r.ok && /didn’t answer in time/.test(r.reason) && Date.now() - t0 < 1000, `hang: bounded (info ${infoMs} ms, like ${Date.now() - t0} ms), plain reason ` + r.reason);
    F.opts.like = 'ok';
    r = await b.sp.like({ on: true });
    ok(r.ok && r.liked === true, 'after a hang the same connection still works (the page bounded the wait itself) ' + J(r));
    F.opts.like = 'ignore'; F.liked.clear();
    r = await b.sp.like({ on: true });
    ok(!r.ok && r.liked === false && /still not in Liked Songs/.test(r.reason), 'Spotify ignored it: not ok, the truth from the re-read ' + J(r));
    F.opts.like = 'ok';
    ok(!b.logs.some((l) => PRIVATE.test(l)) && b.logs.some((l) => /^like a song: done$/.test(l)), 'the log says a song was liked, never which');
    b.sp.stop(); await F.stop();
    // Spotify not running / no port: the same plain reasons as every verb
    const port = await freePort();
    const bn = bridge(port, { proc: fakeProc({ pids: [] }) });
    r = await bn.sp.like({ on: true });
    ok(!r.ok && r.state === 'notrunning' && r.reason === 'Spotify is not running', 'not running: said ' + J(r));
    // --test against the REAL port: never changes Owen's Liked Songs (nothing is even connected to)
    const bt = createSpotifyApp({ port: PORT, dryRun: true, proc: fakeProc({ pids: [] }), exe: 'C:\\fake\\Spotify.exe' });
    r = await bt.like({ on: true, uri: cur });
    ok(r.ok && r.dryRun && r.liked === true, 'dry run on the real port: nothing sent ' + J(r));
    bt.stop();
  }

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY-HOLES ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY-HOLES ${pass} passed, ${fail + 1} failed`); process.exit(1); });
