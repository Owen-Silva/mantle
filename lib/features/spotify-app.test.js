/* spotify-app.test.js - lib/features/_spotify-app.js (the Spotify DESKTOP APP bridge) against a FAKE
 * Spotify debugging port on 127.0.0.1 (./_spotify-fakecdp.js). The real PAGE() runs inside the fake
 * page (node:vm). Nothing here touches the real Spotify process, its port, or the network: the
 * process calls go to a recorder and the artwork fetch is a stub.
 *   node lib/features/spotify-app.test.js
 */
'use strict';
const http = require('http');
const { createSpotifyApp, FLAG, PAGE_SRC, HIDDEN_ARGS, LIKED_URI } = require('./_spotify-app.js');
const { createFakeSpotify, fakeFetch, fakeProc, uri } = require('./_spotify-fakecdp.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
const FAST = { verifyDelayMs: 5, stepDelayMs: 2, pollMs: 25, closeWaitMs: 200, startWaitMs: 1500, httpTimeoutMs: 800, openTimeoutMs: 800, evalTimeoutMs: 1500, searchTimeoutMs: 1500 };

function bridge(port, extra) {
  const statuses = [], logs = [], fetched = [];
  const proc = (extra && extra.proc) || fakeProc({ pids: [100] });
  const sp = createSpotifyApp(Object.assign({ port, proc, fetch: fakeFetch(fetched), exe: 'C:\\fake\\Spotify.exe',
    log: (t) => logs.push(t), onStatus: (s) => statuses.push(s) }, FAST, extra || {}));
  return { sp, statuses, logs, fetched, proc };
}

(async () => {
  /* ------------------------------------------------ port closed: not running / running without the port / no install */
  {
    const port = await freePort();
    const b = bridge(port, { proc: fakeProc({ pids: [] }) });
    let s = await b.sp.status();
    ok(s.state === 'notrunning' && /not running/.test(s.reason), 'closed port + no Spotify.exe -> notrunning ' + JSON.stringify(s));
    b.proc.P.pids = [7];
    s = await b.sp.status();
    ok(s.state === 'noport' && /not started by Mantle/.test(s.reason), 'closed port + Spotify running -> noport ' + JSON.stringify(s));
    ok(b.statuses.map((x) => x.state).join() === 'notrunning,noport', 'each change is pushed once: ' + b.statuses.map((x) => x.state).join());
    const q = await b.sp.queue();
    ok(!q.ok && q.state === 'noport', 'queue with the port closed says noport, not a crash ' + JSON.stringify(q));
    b.proc.P.exists = false;
    s = await b.sp.status();
    ok(s.state === 'noinstall' && /Microsoft Store/.test(s.reason), 'no Spotify.exe at the classic path -> noinstall with the Store caveat');
    b.sp.stop();
  }

  /* ------------------------------------------------ connected: status, queue read, artwork */
  const F = createFakeSpotify();
  const port = await F.start();
  const b = bridge(port);
  {
    const s = await b.sp.status();
    ok(s.state === 'connected' && s.caps && s.caps.remove && s.caps.move && s.caps.skipTo && s.caps.search, 'status: connected with every capability ' + JSON.stringify(s));
    ok(/Registry\(PlayerAPI\)/.test(s.via || ''), 'found through the React context -> Registry(PlayerAPI): ' + s.via);
    ok(s.version === '1.3.0.277', 'version from the Platform object: ' + s.version);
    ok(F.calls.some((c) => c[0] === 'upgrade' && c[2] === null), 'the socket is opened with NO Origin header (so no --remote-allow-origins is needed)');
    const q = await b.sp.queue();
    ok(q.ok && q.state === 'connected', 'queue read ok ' + (q.reason || ''));
    ok(q.current && q.current.uri === uri(1) && q.current.name === 'Song 1', 'current item');
    ok(q.queued.length === 2 && q.queued[0].name === 'Song 2' && q.queued[0].where === 'queued' && q.queued[0].uid === 'u2', 'queued items, in order, with uids');
    ok(q.nextUp.length === 3 && q.nextUp[2].uri === uri(12) && q.nextUp[0].where === 'next', 'next-up (context) items');
    ok(q.queued[0].artists === 'Artist 2, Feat 2', 'artists joined: ' + q.queued[0].artists);
    ok(/^data:image\/png;base64,/.test(q.queued[0].image || ''), 'artwork arrives as data: (the bar CSP)');
    ok(b.fetched.some((u) => /^https:\/\/i\.scdn\.co\/image\/ab67616d00004851/.test(u)), 'spotify:image: becomes i.scdn.co, the SMALL image');
    ok(q.nextUp[2].image === null && /HTTP 404/.test(q.nextUp[2].imageReason || ''), 'a missing artwork keeps its reason');
    const evalsBefore = F.evals;
    await b.sp.queue();
    ok(F.evals === evalsBefore + 1, 'one Runtime.evaluate per queue read (socket reused)');
    ok(F.calls.filter((c) => c[0] === 'upgrade').length === 1, 'one socket for all of it');
  }

  /* ------------------------------------------------ play: skipTo, verified */
  {
    const r = await b.sp.play({ uri: uri(11), uid: 'u11' });
    ok(r.ok && r.verified && r.via === 'skipTo', 'play via skipTo, verified ' + JSON.stringify(r));
    const sk = F.calls.filter((c) => c[0] === 'skipTo').pop();
    ok(sk && sk[1].uri === uri(11) && sk[1].uid === 'u11', 'skipTo got {uri, uid}');
    ok(F.q.current.uri === uri(11), 'the fake now plays it');
    const gone = await b.sp.play({ uri: uri(2), uid: 'u2' });
    ok(!gone.ok && gone.state === 'moved', 'a song no longer queued -> moved, no skip sent ' + JSON.stringify(gone));
  }

  /* ------------------------------------------------ play fallback: skipTo throws -> N x skipToNext */
  {
    F.q = { current: F.q.current, queued: [], nextUp: [] };
    F.player.addToQueue([{ uri: uri(40) }, { uri: uri(41) }, { uri: uri(42) }]);
    F.q.queued.forEach((x, i) => { x.uid = 'f' + i; });
    F.opts.skipToThrows = true;
    const nextBefore = F.calls.filter((c) => c[0] === 'skipToNext').length;
    const r = await b.sp.play({ uri: uri(42), uid: 'f2' });
    ok(r.ok && r.verified && r.via === 'next' && /skipTo failed/.test(r.note || ''), 'skipTo refused -> 3 x next, said in the note ' + JSON.stringify(r));
    ok(F.calls.filter((c) => c[0] === 'skipToNext').length - nextBefore === 3, 'exactly 3 skipToNext');
    F.opts.skipToThrows = false;
  }

  /* ------------------------------------------------ add / remove / reorder */
  {
    const r = await b.sp.add({ uri: uri(50) });
    ok(r.ok && r.verified, 'add verified ' + JSON.stringify(r));
    const a = F.calls.filter((c) => c[0] === 'addToQueue').pop();
    ok(a && a[1].length === 1 && a[1][0].uri === uri(50) && a[1][0].uid === null, 'addToQueue([{uri, uid:null}])');
    F.q.queued = [];
    F.player.addToQueue([{ uri: uri(60) }, { uri: uri(61) }, { uri: uri(62) }]);
    F.q.queued.forEach((x, i) => { x.uid = 'm' + i; });
    F.q.nextUp = [require('./_spotify-fakecdp.js').track(70)];
    let m = await b.sp.move({ uri: uri(62), uid: 'm2', dir: 'up' });
    ok(m.ok && m.verified, 'move up verified ' + JSON.stringify(m));
    const ro = F.calls.filter((c) => c[0] === 'reorderQueue').pop();
    ok(ro && ro[1][0].uid === 'm2' && ro[2].before && ro[2].before.uid === 'm1', 'reorderQueue([{m2}], {before: m1})');
    ok(F.q.queued.map((x) => x.uid).join() === 'm0,m2,m1', 'order now m0,m2,m1');
    m = await b.sp.move({ uri: uri(60), uid: 'm0', dir: 'down' });
    const ro2 = F.calls.filter((c) => c[0] === 'reorderQueue').pop();
    ok(m.ok && m.verified && ro2[2].after && ro2[2].after.uid === 'm2', 'move down = {after: next}');
    const top = await b.sp.move({ uri: uri(62), uid: 'm2', dir: 'up' });
    ok(!top.ok && /already first/.test(top.reason), 'first cannot move up, said ' + JSON.stringify(top));
    const ctxMove = await b.sp.move({ uri: uri(70), uid: 'u70', dir: 'up' });
    ok(!ctxMove.ok && /only songs you queued/.test(ctxMove.reason), 'a next-up (context) song cannot be moved');
    const rm = await b.sp.remove({ uri: uri(61), uid: 'm1' });
    ok(rm.ok && rm.verified && !F.q.queued.some((x) => x.uid === 'm1'), 'remove verified ' + JSON.stringify(rm));
    const rmc = F.calls.filter((c) => c[0] === 'removeFromQueue').pop();
    ok(rmc && rmc[1][0].uid === 'm1' && rmc[1][0].uri === uri(61), 'removeFromQueue([{uri, uid}])');
    const rm2 = await b.sp.remove({ uri: uri(61), uid: 'm1' });
    ok(!rm2.ok && rm2.state === 'moved', 'removing it twice -> moved');
  }

  /* ------------------------------------------------ search: the bundle hash, then the baked fallback */
  {
    const r = await b.sp.search({ q: 'macklemore' });
    ok(r.ok && r.items.length === 3 && r.items[0].name === 'Found 30 for macklemore' && r.items[0].artists === 'Band 30', 'search results ' + JSON.stringify(r).slice(0, 200));
    const lc = F.loaderCalls.pop();
    ok(lc && lc.def.name === 'searchTracks' && lc.def.sha256Hash === F.searchHash && lc.vars.searchTerm === 'macklemore', 'the searchTracks hash read from the live bundle');
    ok(/^data:image\/png/.test(r.items[0].image || ''), 'search artwork as data:');
    const F2 = createFakeSpotify({ search: 'none' });
    const p2 = await F2.start();
    const b2 = bridge(p2);
    const r2 = await b2.sp.search({ q: 'x' });
    const lc2 = F2.loaderCalls.pop();
    ok(r2.ok && lc2 && lc2.def.sha256Hash === require('./_spotify-app.js').SEARCH_HASH_1_3_0_277 && /baked/.test(r2.via), 'no search module loaded -> the baked 1.3.0.277 hash, said in via');
    F2.opts.search = 'broken';
    const r3 = await b2.sp.search({ q: 'x' });
    ok(!r3.ok && /Search is unavailable/.test(r3.reason) && /PersistedQueryNotFound/.test(r3.reason), 'a rejected query says why ' + JSON.stringify(r3));
    const long = await b2.sp.search({ q: 'x'.repeat(101) });
    ok(!long.ok && /100 characters/.test(long.reason), 'over-long search refused before reaching Spotify');
    b2.sp.stop(); await F2.stop();
  }

  /* ------------------------------------------------ hostile input: validated, and only ever JSON-encoded */
  {
    const evals = F.evals;
    const bad = [
      await b.sp.add({ uri: 'spotify:track:x"); globalThis.pwned=1; ("' }),
      await b.sp.play({ uri: 'javascript:alert(1)' }),
      await b.sp.remove({ uri: uri(1), uid: 'u1"};pwned=1;//' }),
      await b.sp.move({ uri: uri(1), uid: 'u1', dir: 'sideways' }),
      await b.sp.add({ uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' }),
    ];
    ok(bad.every((r) => !r.ok && r.state === 'error'), 'every malicious/wrong value refused: ' + bad.map((r) => r.reason).join(' | '));
    ok(F.evals === evals, 'and none of them reached Spotify\'s page');
    const tricky = '"); globalThis.pwned = 1; ("\u2028</script>';
    const r = await b.sp.search({ q: tricky });
    const lc = F.loaderCalls.pop();
    ok(r.ok && lc && lc.vars.searchTerm === tricky.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), 'search text arrives as DATA, byte for byte');
    ok(F.sandbox.pwned === undefined, 'nothing in the search text ran in the page');
    ok(F.expressions.every((e) => e.startsWith('(' + PAGE_SRC + ')(')), 'every evaluate is the fixed PAGE() source + JSON arguments');
    ok(!F.expressions.some((e) => /cookie|localStorage|accessToken|getToken|Authorization/i.test(e.slice(PAGE_SRC.length + 2))), 'no call asks for tokens or cookies');
    ok(!/cookie|localStorage|accessToken|getToken|Authorization/i.test(PAGE_SRC), 'PAGE() itself never touches tokens or cookies');
  }

  /* ------------------------------------------------ Spotify restarts: port closes, then reconnect */
  {
    await F.stop();
    b.proc.P.pids = [];
    const q = await b.sp.queue();
    ok(!q.ok && q.state === 'notrunning', 'Spotify quit -> notrunning ' + JSON.stringify(q));
    F.reload();
    await F.start(port);
    b.proc.P.pids = [9];
    const q2 = await b.sp.queue();
    ok(q2.ok && q2.state === 'connected', 'Spotify back on the same port -> reconnected and the internals re-found ' + (q2.reason || ''));
    ok(b.statuses.slice(-2).map((x) => x.state).join() === 'notrunning,connected', 'pushed: notrunning then connected: ' + b.statuses.map((x) => x.state).join());
  }

  /* ------------------------------------------------ a hung page: clean timeout, then a fresh socket */
  {
    F.opts.stuck = true;
    const t0 = Date.now();
    const q = await b.sp.queue();
    ok(!q.ok && /did not answer within/.test(q.reason) && Date.now() - t0 < 4000, 'a stuck page times out cleanly ' + JSON.stringify(q));
    F.opts.stuck = false;
    const ups = F.calls.filter((c) => c[0] === 'upgrade').length;
    const q2 = await b.sp.queue();
    ok(q2.ok && F.calls.filter((c) => c[0] === 'upgrade').length === ups + 1, 'the next call opens a fresh socket and works');
  }

  /* ------------------------------------------------ internals missing (a Spotify update) */
  {
    const F3 = createFakeSpotify({ internals: 'none' });
    const p3 = await F3.start();
    const b3 = bridge(p3);
    const s = await b3.sp.status();
    ok(s.state === 'internals' && /queue functions were not found/.test(s.reason) && /Spotify update/.test(s.reason) && /1\.3\.0\.277/.test(s.reason), 'no PlayerAPI -> internals, with the version ' + JSON.stringify(s));
    const q = await b3.sp.queue();
    ok(!q.ok && q.state === 'internals', 'queue says internals too');
    b3.sp.stop(); await F3.stop();
    const F4 = createFakeSpotify({ internals: false });   // Platform found, registry has no PlayerAPI
    const p4 = await F4.start();
    const b4 = bridge(p4);
    const s4 = await b4.sp.status();
    ok(s4.state === 'internals' && /gave no PlayerAPI/.test(s4.reason), 'Platform without PlayerAPI -> internals ' + s4.reason);
    b4.sp.stop(); await F4.stop();
  }

  /* ------------------------------------------------ some other program on the port */
  {
    const F5 = createFakeSpotify({ list: [{ id: 'X', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/X' }] });
    const p5 = await F5.start();
    const b5 = bridge(p5);
    const s = await b5.sp.status();
    ok(s.state === 'portbusy' && /none of its 1 page/.test(s.reason), 'a non-Spotify debugging port -> portbusy ' + JSON.stringify(s));
    b5.sp.stop(); await F5.stop();
    const F6 = createFakeSpotify({ list: [{ id: 'P', type: 'page', url: 'https://xpui.app.spotify.com/index.html', webSocketDebuggerUrl: 'ws://evil.example:80/devtools/page/P' }] });
    const p6 = await F6.start();
    const b6 = bridge(p6);
    const s6 = await b6.sp.status();
    ok(s6.state === 'portbusy' && /unexpected socket address/.test(s6.reason) && !F6.calls.some((c) => c[0] === 'upgrade'), 'a socket address off 127.0.0.1:<port> is never connected to');
    b6.sp.stop(); await F6.stop();
  }

  /* ------------------------------------------------ start / restart (fake process, fake port) */
  {
    const p7 = await freePort();
    const F7 = createFakeSpotify();
    const proc = fakeProc({ pids: [] });
    proc.P.onLaunch = async () => { setTimeout(() => F7.start(p7), 80); };
    proc.P.visibleFn = () => F7.win.state !== 4;
    const b7 = bridge(p7, { proc });
    const r = await b7.sp.start();
    ok(r.hidden === true && b7.sp.window().state === 'hidden', 'the card Start hides the window it started ' + JSON.stringify(r));
    const launch = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'launch');
    ok(r.ok && launch && launch[2].join(' ') === [FLAG].concat(HIDDEN_ARGS).join(' '), 'start launches Spotify.exe with ' + FLAG + ' + ' + HIDDEN_ARGS.join(' ') + ' (hidden) ' + JSON.stringify(r));
    ok(!launch[2].some((a) => /allow-origins/.test(a)), 'no --remote-allow-origins');
    ok(b7.sp.last().state === 'connected', 'start waits for the port, then connected');
    ok(b7.statuses.some((s) => s.state === 'starting'), 'the wait is pushed as "starting"');
    const again = await b7.sp.start();
    ok(!again.ok && /already running/.test(again.reason), 'start while running refuses and points at Restart');
    await F7.stop();

    // restart: polite close works; it was minimized, so it comes back minimized (NOT hidden: he opened it)
    proc.P.visibleFn = null;
    proc.P.pids = [5]; proc.P.visibleNow = false; proc.P.calls.length = 0;
    const F8 = createFakeSpotify();
    proc.P.onLaunch = async () => { setTimeout(() => F8.start(p7), 80); };
    const rr = await b7.sp.restart();
    ok(rr.ok && !rr.forced, 'restart: WM_CLOSE was enough (no force) ' + JSON.stringify(rr));
    const l2 = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'launch');
    ok(proc.P.calls.indexOf('close') >= 0 && !proc.P.calls.includes('kill') && l2 && l2[2].join(' ') === FLAG + ' --minimized', 'close -> launch ' + FLAG + ' --minimized (it was in the tray): ' + JSON.stringify(proc.P.calls));
    await F8.stop();

    // restart: Spotify ignores WM_CLOSE (minimize-to-tray) -> ended, and said so
    proc.P.pids = [5]; proc.P.visibleNow = true; proc.P.closeWorks = false; proc.P.calls.length = 0;
    const F9 = createFakeSpotify();
    proc.P.onLaunch = async () => { setTimeout(() => F9.start(p7), 80); };
    const rf = await b7.sp.restart();
    const l3 = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'launch');
    ok(rf.ok && rf.forced && /did not quit when asked/.test(rf.note || '') && proc.P.calls.includes('kill'), 'a refused close is forced AND said ' + JSON.stringify(rf));
    ok(l3 && l3[2].join(' ') === FLAG, 'visible before -> started normally (not minimized)');
    await F9.stop();

    // start: Spotify ignores the flag (port never opens) -> said, with the likely cause
    proc.P.pids = []; proc.P.calls.length = 0; proc.P.onLaunch = null;
    const rn = await b7.sp.start();
    ok(!rn.ok && /could not reach it within/.test(rn.reason) && /ignore --remote-debugging-port/.test(rn.reason), 'a port that never opens is said ' + JSON.stringify(rn));
    ok(b7.sp.last().state !== 'starting', 'and the card leaves "starting" ' + b7.sp.last().state);

    // dry run (a --test instance): nothing launched or closed
    const pd = fakeProc({ pids: [3] });
    const bd = bridge(p7, { proc: pd, dryRun: true });
    const d1 = await bd.sp.restart();
    ok(d1.ok && d1.dryRun && pd.P.calls.length === 0, 'dry-run restart touches no process');
    pd.P.pids = [];
    const d2 = await bd.sp.start();
    ok(d2.ok && d2.dryRun && !pd.P.calls.some((c) => Array.isArray(c)), 'dry-run start launches nothing');
    b7.sp.stop(); bd.sp.stop();
  }

  /* ------------------------------------------------ spothide lane: hidden start, trim, the card's new commands */
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ph = await freePort();
    const FH = createFakeSpotify();
    const proc = fakeProc({ pids: [] });
    proc.P.visibleFn = () => FH.win.state !== 4;
    proc.P.onLaunch = async () => { setTimeout(() => FH.start(ph), 60); };
    const bh = bridge(ph, { proc, hideVerifyMs: 5, trimDelayMs: 40, windowVerifyMs: 5, playVerifyMs: 200, closeWaitMs: 300 });
    const r = await bh.sp.start();
    ok(r.ok && r.hidden && /window-state service/.test(r.how || ''), 'start -> hidden via Spotify own window-state service ' + JSON.stringify(r));
    ok(FH.calls.some((c) => c[0] === 'setWindowState' && c[1].state === 4), 'the hide is SetWindowState(HIDDEN = 4)');
    ok(bh.logs.some((l) => /hid the Spotify window Mantle started \(pid 4242, from the Spotify card\)/.test(l)), 'the way it was hidden is logged ' + JSON.stringify(bh.logs.slice(-3)));
    ok(bh.statuses.some((s) => s.window && s.window.state === 'hidden'), 'the hidden state is pushed to the card');
    await wait(150);
    const tr = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'trim');
    ok(tr && tr[1] === 4242 && tr[2] === 'C:\\fake\\Spotify.exe', 'ONE trim, on the pid Mantle launched and its exe ' + JSON.stringify(tr));
    ok(proc.P.calls.filter((c) => Array.isArray(c) && c[0] === 'trim').length === 1, 'the trim runs once');
    const w1 = bh.sp.window();
    ok(w1.trim && w1.trim.ok && /900 MB → 60 MB/.test(w1.trim.text), 'the trim result is kept and said ' + JSON.stringify(w1.trim));

    // info: memory, window, player
    const inf = await bh.sp.info();
    ok(inf.ok && inf.memory && inf.memory.privateWsMB === 210 && inf.visible === false && inf.window.state === 'hidden' && inf.player && inf.player.paused === true, 'info: memory + hidden + player ' + JSON.stringify(inf).slice(0, 200));

    // library: playable rows only, mosaic art = its first tile, Liked Songs offered
    const lib = await bh.sp.library();
    ok(lib.ok && lib.items.length === 3 && lib.skipped === 2 && lib.liked.uri === LIKED_URI, 'library keeps playlist/artist/album, drops the folder and the bad uri ' + JSON.stringify(lib).slice(0, 200));
    ok(bh.fetched.some((u) => /i\.scdn\.co\/image\/ab67616d00001e0211111/.test(u)), 'a mosaic cover loads its first tile');
    ok(lib.items[0].owner === 'Owen' && lib.items[2].owner === 'Some Band', 'owner / artists are carried for the sub-line');

    // search of every kind: the bundle's hash, a bad uri dropped
    const sr = await bh.sp.searchAll({ q: 'lofi' });
    const lc = FH.loaderCalls[FH.loaderCalls.length - 1];
    ok(sr.ok && sr.tracks.length === 2 && sr.artists.length === 1 && sr.albums.length === 1 && sr.playlists.length === 1, 'searchAll: songs, artists (evil uri dropped), albums, playlists ' + JSON.stringify(sr).slice(0, 160));
    ok(lc.def.name === 'searchDesktop' && lc.def.sha256Hash === FH.searchAllHash && sr.via === 'Spotify’s bundle', 'searchAll uses the hash read from the Spotify bundle');
    ok((await bh.sp.searchAll({ q: 'x'.repeat(101) })).ok === false, 'a 101-character search is refused');

    // play a context, Liked Songs, a song; refusals
    const p1 = await bh.sp.playUri({ uri: 'spotify:playlist:' + 'L'.repeat(22) });
    ok(p1.ok && p1.verified, 'play a playlist: verified by the player state ' + JSON.stringify(p1).slice(0, 160));
    const pl = FH.calls.filter((c) => c[0] === 'play').pop();
    ok(pl && pl[1].uri === 'spotify:playlist:' + 'L'.repeat(22) && Object.keys(pl[1]).join() === 'uri', 'play() gets {uri} only');
    const p2 = await bh.sp.playUri({ uri: LIKED_URI });
    ok(p2.ok && p2.verified, 'Liked Songs plays (Spotify rewrites the collection uri) ' + JSON.stringify(p2).slice(0, 160));
    const p3 = await bh.sp.playUri({ uri: 'spotify:track:' + 'T'.repeat(22) });
    ok(p3.ok && p3.verified && p3.player.item === 'spotify:track:' + 'T'.repeat(22), 'a song plays');
    const nPlay = FH.calls.filter((c) => c[0] === 'play').length;
    const bad = await bh.sp.playUri({ uri: 'spotify:playlist:x");alert(1);//' });
    ok(!bad.ok && FH.calls.filter((c) => c[0] === 'play').length === nPlay, 'a malformed uri never reaches play()');

    // shuffle / repeat
    const s1 = await bh.sp.shuffle({ on: true });
    ok(s1.ok && s1.verified && FH.ps.shuffle === true, 'shuffle on, verified');
    const r2 = await bh.sp.repeat({ mode: 2 });
    ok(r2.ok && r2.verified && FH.ps.repeat === 2, 'repeat this song, verified');
    ok(!(await bh.sp.repeat({ mode: 7 })).ok, 'repeat 7 is refused');

    // open / hide the window from the card
    const ow = await bh.sp.openWindow();
    ok(ow.ok && ow.verified && FH.calls.some((c) => c[0] === 'focusMainWindow') && bh.sp.window().state === 'shown', 'Open Spotify: its own focusMainWindow, verified ' + JSON.stringify(ow));
    const i2 = await bh.sp.info();
    ok(i2.visible === true && i2.window.state === 'shown', 'info says the window is showing');
    const hw = await bh.sp.hideWindow();
    ok(hw.ok && hw.verified && bh.sp.window().state === 'hidden', 'Hide window again, verified');

    // quit: Spotify's own shutdown, never forced
    FH.onQuit = () => { proc.P.pids = []; };
    proc.P.calls.length = 0;
    const q = await bh.sp.quit();
    ok(q.ok && FH.quits === 1 && /LifecycleAPI/.test(q.via) && !proc.P.calls.includes('close') && !proc.P.calls.includes('kill'), 'Quit: LifecycleAPI.shutdown, no taskkill ' + JSON.stringify(q));
    ok(bh.sp.last().state === 'notrunning' && bh.sp.window() === null, 'after Quit: not running, no window record');
    bh.sp.stop();
    await FH.stop();

    // quit when Spotify's own shutdown is missing: taskkill WITHOUT /F, never kill
    const pq = await freePort();
    const FQ = createFakeSpotify({ lifecycle: false });
    const prq = fakeProc({ pids: [9] });
    await FQ.start(pq);
    const bq = bridge(pq, { proc: prq, closeWaitMs: 200 });
    await bq.sp.status();
    const qq = await bq.sp.quit();
    ok(qq.ok && prq.P.calls.includes('close') && !prq.P.calls.includes('kill') && /taskkill without \/F/.test(qq.via), 'no LifecycleAPI -> WM_CLOSE, never forced ' + JSON.stringify(qq));
    bq.sp.stop(); await FQ.stop();

    // the hide that does not take, and a missing window service: both SAID
    const pf = await freePort();
    const FF = createFakeSpotify({ windowSticks: true });
    const pr2 = fakeProc({ pids: [] });
    pr2.P.visibleFn = () => FF.win.state !== 4;
    pr2.P.onLaunch = async () => { setTimeout(() => FF.start(pf), 60); };
    const bf = bridge(pf, { proc: pr2, hideVerifyMs: 5, trimDelayMs: 20 });
    const rf = await bf.sp.start();
    ok(rf.ok && rf.hidden === false && /^Could not hide Spotify’s window: .*still showing/.test(rf.reason), 'a window that stays up is said ' + JSON.stringify(rf));
    ok(bf.sp.window().state === 'failed' && bf.logs.some((l) => /Could not hide/.test(l)), 'and logged, and pushed as failed');
    await wait(60);
    ok(!pr2.P.calls.some((c) => Array.isArray(c) && c[0] === 'trim'), 'no trim when the hide failed');
    bf.sp.stop(); await FF.stop();

    const pn = await freePort();
    const FN = createFakeSpotify({ windowApi: false });
    const pr3 = fakeProc({ pids: [] });
    pr3.P.onLaunch = async () => { setTimeout(() => FN.start(pn), 60); };
    const bn = bridge(pn, { proc: pr3, hideVerifyMs: 5 });
    const rn = await bn.sp.start();
    ok(rn.ok && rn.hidden === false && /window-state service .* was not found/.test(rn.reason), 'no window service -> said ' + JSON.stringify(rn));
    bn.sp.stop(); await FN.stop();

    // a start that only handed over to a Spotify already running (our pid gone): that window is left alone
    const pa = await freePort();
    const FA = createFakeSpotify();
    const pr4 = fakeProc({ pids: [] });
    pr4.P.onLaunch = async () => { setTimeout(() => { pr4.P.pids = [5]; FA.start(pa); }, 60); };
    const ba = bridge(pa, { proc: pr4, hideVerifyMs: 5 });
    const ra = await ba.sp.start();
    ok(ra.ok && ra.hidden === false && /left alone/.test(ra.reason) && !FA.calls.some((c) => c[0] === 'setWindowState'), 'a Spotify Mantle did not start is never hidden ' + JSON.stringify(ra));
    ba.sp.stop(); await FA.stop();

    // adopt: a pin/launcher start announced on the bus is hidden the same way
    const pb = await freePort();
    const FB = createFakeSpotify();
    const pr5 = fakeProc({ pids: [777] });
    pr5.P.visibleFn = () => FB.win.state !== 4;
    const bb = bridge(pb, { proc: pr5, hideVerifyMs: 5, trimDelayMs: 20 });
    setTimeout(() => FB.start(pb), 60);
    const rb = await bb.sp.adopt({ pid: 777, source: 'the pinned icon' });
    ok(rb.ok && rb.hidden && bb.logs.some((l) => /pid 777, from the pinned icon/.test(l)), 'adopt hides the pinned icon Spotify ' + JSON.stringify(rb));
    await wait(60);
    ok(pr5.P.calls.some((c) => Array.isArray(c) && c[0] === 'trim' && c[1] === 777), 'and trims that pid once');
    bb.sp.stop(); await FB.stop();

    // playing when the trim comes due: skipped, said
    const pp = await freePort();
    const FP = createFakeSpotify();
    FP.ps.paused = false;
    const pr6 = fakeProc({ pids: [888] });
    pr6.P.visibleFn = () => FP.win.state !== 4;
    const bp = bridge(pp, { proc: pr6, hideVerifyMs: 5, trimDelayMs: 20 });
    setTimeout(() => FP.start(pp), 60);
    await bp.sp.adopt({ pid: 888, source: 'the launcher' });
    await wait(80);
    ok(!pr6.P.calls.some((c) => Array.isArray(c) && c[0] === 'trim') && /skipped: music was already playing/.test((bp.sp.window().trim || {}).text || ''), 'no trim while music plays, and said');
    bp.sp.stop(); await FP.stop();

    // dry run: quit / open / hide touch nothing
    const pdd = fakeProc({ pids: [3] });
    const bdd = bridge(ph, { proc: pdd, dryRun: true });
    const dq = await bdd.sp.quit(), dw = await bdd.sp.openWindow(), dh = await bdd.sp.hideWindow();
    ok(dq.dryRun && dw.dryRun && dh.dryRun && pdd.P.calls.length === 0, 'dry-run quit/open/hide touch nothing');
    bdd.sp.stop();

    // the page code still reads no tokens or cookies
    ok(!/token|cookie|localStorage|getSession|getTransport/i.test(PAGE_SRC), 'PAGE() never touches tokens, cookies, sessions or the transport');
  }

  b.sp.stop();
  await F.stop();
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY-APP ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY-APP ${pass} passed, ${fail + 1} failed`); process.exit(1); });
