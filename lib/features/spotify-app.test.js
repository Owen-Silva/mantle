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
    const tr = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'trimTree');
    ok(tr && tr[1] === 4242 && tr[2] === '1' && Array.isArray(tr[3]) && JSON.stringify(tr[3]) === '[4242]', 'the watch trims the tree of the pid Mantle launched (as first seen), leaving its main process alone: 900 MB is over the line ' + JSON.stringify(tr));
    ok(proc.P.calls.filter((c) => Array.isArray(c) && c[0] === 'trimTree').length === 1 && !proc.P.calls.some((c) => Array.isArray(c) && c[0] === 'trim'), 'one trim through the sidecar, never the PowerShell one');
    const w1 = bh.sp.window();
    ok(w1.watch && w1.watch.state === 'watching' && w1.watch.lastTrim && w1.watch.lastTrim.ok && /900 MB → 60 MB/.test(w1.watch.lastTrim.text), 'the trim result is kept and said ' + JSON.stringify(w1.watch));
    ok(bh.logs.filter((l) => /trimmed the hidden Spotify: 900 MB → 60 MB of RAM \(6 processes[;)]/.test(l)).length === 1, 'ONE log line for the trim, before -> after ' + JSON.stringify(bh.logs.slice(-4)));
    ok(bh.statuses.some((st) => st.window && st.window.watch && st.window.watch.trims === 1), 'the trim is pushed to the card');

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
    ok(!pr2.P.calls.some((c) => Array.isArray(c) && /^(trim|trimTree|mem)$/.test(c[0])), 'no watch and no trim when the hide failed');
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
    ok(pr5.P.calls.some((c) => Array.isArray(c) && c[0] === 'trimTree' && c[1] === 777), 'and watches and trims that pid');
    bb.sp.stop(); await FB.stop();

    // playing when the trim comes due: the process playing the audio is left alone, the rest trimmed, said
    const pp = await freePort();
    const FP = createFakeSpotify();
    FP.ps.paused = false;
    const pr6 = fakeProc({ pids: [888] });
    pr6.P.visibleFn = () => FP.win.state !== 4;
    pr6.P.audioPids = [888, 31337];           // Spotify's main process plays; 31337 is another app
    const bp = bridge(pp, { proc: pr6, hideVerifyMs: 5, trimDelayMs: 20 });
    setTimeout(() => FP.start(pp), 60);
    await bp.sp.adopt({ pid: 888, source: 'the launcher' });
    await wait(80);
    const t6 = pr6.P.calls.find((c) => Array.isArray(c) && c[0] === 'trimTree');
    ok(t6 && t6[3].includes(888) && t6[3].every((p) => p === 888 || p === t6[1]), 'while music plays the audio process is skipped (only the tree\'s own pids: it and the main process) ' + JSON.stringify(t6));
    ok(bp.logs.some((l) => /left alone: pid [0-9, ]*888[0-9, ]* \(Spotify's main process and whatever plays the audio\)/.test(l)), 'and said in the log');
    bp.sp.stop(); await FP.stop();

    // a sidecar too old for spotify.mem: said on the card and in the log, and the old one-time trim runs once
    const po = await freePort();
    const FO = createFakeSpotify();
    const pr7 = fakeProc({ pids: [999] });
    pr7.P.visibleFn = () => FO.win.state !== 4;
    pr7.P.memOld = true;
    const bo = bridge(po, { proc: pr7, hideVerifyMs: 5, trimDelayMs: 20 });
    setTimeout(() => FO.start(po), 60);
    await bo.sp.adopt({ pid: 999, source: 'the pinned icon' });
    await wait(100);
    const wo = bo.sp.window();
    ok(wo.watch.state === 'unavailable' && /older than this Mantle/.test(wo.watch.reason || ''), 'old sidecar: the watch says why it is off ' + JSON.stringify(wo.watch));
    ok(bo.logs.some((l) => /sidecar\) is older than this Mantle/.test(l)), 'and logs it');
    ok(pr7.P.calls.filter((c) => Array.isArray(c) && c[0] === 'trim' && c[1] === 999).length === 1 && wo.trim && wo.trim.ok, 'and falls back to ONE PowerShell trim ' + JSON.stringify(wo.trim));
    ok(pr7.P.calls.filter((c) => Array.isArray(c) && c[0] === 'mem').length === 1, 'and does not ask again');
    bo.sp.stop(); await FO.stop();

    // the stop conditions through the bridge: window opened from the card, hidden again, feature off/on, quit
    const pw = await freePort();
    const FW = createFakeSpotify();
    const pr8 = fakeProc({ pids: [555] });
    pr8.P.visibleFn = () => FW.win.state !== 4;
    const bw = bridge(pw, { proc: pr8, hideVerifyMs: 5, trimDelayMs: 20, windowVerifyMs: 5, closeWaitMs: 300 });
    setTimeout(() => FW.start(pw), 60);
    await bw.sp.adopt({ pid: 555, source: 'the pinned icon' });
    ok(bw.sp.window().watch.state === 'watching', 'hidden -> watching');
    await bw.sp.openWindow();
    ok(bw.sp.window().watch.state === 'stopped' && /opened from the card/.test(bw.sp.window().watch.reason), 'open window -> the watch stops ' + JSON.stringify(bw.sp.window().watch));
    await bw.sp.hideWindow();
    ok(bw.sp.window().watch.state === 'watching', 'hidden again -> watching again');
    bw.sp.stop('the Spotify queue was turned off');
    ok(bw.sp.window().watch.state === 'stopped' && /turned off/.test(bw.sp.window().watch.reason), 'feature off -> stopped');
    bw.sp.resume();
    ok(bw.sp.window().watch.state === 'watching', 'feature on again while hidden -> watching again');
    await wait(60);
    const nMem = pr8.P.calls.filter((c) => Array.isArray(c) && c[0] === 'mem').length;
    await bw.sp.quit();
    await wait(40);
    const qw = bw.sp.window(); ok(!qw && pr8.P.calls.filter((c) => Array.isArray(c) && c[0] === 'mem').length === nMem, 'quit -> no window and no more reads ' + JSON.stringify(pr8.P.calls.slice(-6)));
    ok(bw.logs.filter((l) => /^stopped watching/.test(l)).length >= 3, 'each stop is one log line ' + JSON.stringify(bw.logs.filter((l) => /watching/.test(l))));
    bw.sp.stop(); await FW.stop();

    // dry run: quit / open / hide touch nothing
    const pdd = fakeProc({ pids: [3] });
    const bdd = bridge(ph, { proc: pdd, dryRun: true });
    const dq = await bdd.sp.quit(), dw = await bdd.sp.openWindow(), dh = await bdd.sp.hideWindow();
    ok(dq.dryRun && dw.dryRun && dh.dryRun && pdd.P.calls.length === 0, 'dry-run quit/open/hide touch nothing');
    bdd.sp.stop();

    // the page code still reads no tokens or cookies
    ok(!/token|cookie|localStorage|getSession|getTransport/i.test(PAGE_SRC), 'PAGE() never touches tokens, cookies, sessions or the transport');
  }

  /* ------------------------------------------------ sptrim lane: the memory watch's decisions (pure, fake clock) */
  {
    const TW = require('./_spotify-trim.js');
    const S = 1000, M = 60 * S;
    const C = { aboveMB: 300 };
    const rd = (mb, audio) => ({ mb, procs: [{ pid: 10, mb: 125 }, { pid: 11, mb: Math.max(0, mb - 125) }], audioPids: audio === undefined ? [] : audio });
    ok(TW.TRIM_ABOVE_MB === 400 && TW.TICK_MS === 30 * S && TW.MIN_GAP_MS === 2 * M && TW.MAX_GAP_MS === 10 * M && TW.REFILL_MS === 60 * S, 'the named constants: 400 MB, 30 s, 2 min, 10 min, 60 s');

    let s = TW.fresh(TW.DEFAULTS);
    let d = TW.step(s, rd(290), 0, C);
    ok(!d.trim && d.why === 'under' && d.notes.length === 0, 'threshold: 290 MB is under 300: no trim, nothing said');
    d = TW.step(s, rd(300), 0, C);
    ok(!d.trim && d.why === 'under', 'threshold: exactly 300 MB is not over');
    d = TW.step(s, rd(301), 0, C);
    ok(d.trim && d.skip.length === 0 && d.gainMB === 301, 'threshold: 301 MB is over -> trim everything (nothing plays)');
    ok(TW.step(s, rd(250), 0, { aboveMB: 200 }).trim, 'the threshold is a setting (200 MB)');

    s = TW.afterTrim(d.s, 0);
    d = TW.step(s, rd(400), 90 * S, C);
    ok(!d.trim && d.why === 'gap' && d.nextAt === 2 * M, 'gap: over again 90 s later -> waits for 2 min ' + JSON.stringify({ why: d.why, nextAt: d.nextAt }));
    d = TW.step(d.s, rd(400), 2 * M, C);
    ok(d.trim, 'gap: 2 min after the last trim it may trim again');

    // audio
    d = TW.step(TW.fresh(TW.DEFAULTS), rd(400, [10, 999]), 0, C);
    ok(d.trim && JSON.stringify(d.skip) === '[10]' && d.gainMB === 275, 'audio: the tree pid with an active session is skipped (another app\'s pid is not ours to list), the rest trimmed');
    d = TW.step(TW.fresh(TW.DEFAULTS), Object.assign(rd(400, []), { root: 10 }), 0, C);
    ok(d.trim && JSON.stringify(d.skip) === '[10]' && d.gainMB === 275, 'root: the main Spotify process is left alone even when no active session names it (audio on another device)');
    d = TW.step(TW.fresh(TW.DEFAULTS), rd(400, null), 0, C);
    ok(!d.trim && d.why === 'audio', 'audio: unknown who plays -> no trim at all');
    d = TW.step(TW.fresh(TW.DEFAULTS), { mb: 400, procs: [{ pid: 10, mb: 390 }, { pid: 11, mb: 10 }], audioPids: [10] }, 0, C);
    ok(!d.trim && d.why === 'nothing' && d.gainMB === 10, 'audio: when the audio process holds nearly all of it, no pointless trim');

    // back-off: two fast refills in a row double the gap, capped at 10 min; a slow one breaks the run
    let t = 0, logs = [];
    s = TW.fresh(TW.DEFAULTS);
    const run = (mb, at) => { const x = TW.step(s, rd(mb), at, C); s = x.s; logs = logs.concat(x.notes); if (x.trim) s = TW.afterTrim(s, at); return x; };
    run(900, t);                                      // trim 1
    run(350, t += 30 * S);                            // fast refill #1
    ok(s.gapMs === 2 * M && s.fast === 1 && logs.length === 0, 'back-off: one fast refill changes nothing');
    run(350, t = 2 * M);                              // trim 2
    run(350, t += 30 * S);                            // fast refill #2 -> 4 min
    ok(s.gapMs === 4 * M && logs.length === 1 && /at least 4 min \(was 2 min\)/.test(logs[0]), 'back-off: twice in a row -> gap doubles to 4 min, one note ' + JSON.stringify(logs));
    ok(!run(350, t = 2 * M + 3 * M).trim, 'back-off: 3 min after, still waiting');
    run(350, t = 2 * M + 4 * M);                      // trim 3 at 6 min
    run(350, t += 30 * S);
    run(350, t = 10 * M);                             // trim 4 at 10 min
    run(350, t += 30 * S);
    ok(s.gapMs === 8 * M && logs.length === 2, 'back-off: 8 min next');
    run(350, t = 18 * M); run(350, t += 30 * S); run(350, t = 26 * M); run(350, t += 30 * S);
    ok(s.gapMs === 10 * M && logs.length === 3 && /at least 10 min/.test(logs[2]), 'back-off: capped at 10 min');
    run(350, t = 36 * M); run(350, t += 30 * S); run(350, t = 46 * M); run(350, t += 30 * S);
    ok(s.gapMs === 10 * M && logs.length === 3, 'back-off: at the cap, nothing more is said');

    s = TW.fresh(TW.DEFAULTS); logs = [];
    run(900, t = 0); run(350, t = 30 * S);            // fast #1
    run(350, t = 2 * M); run(250, t = 2 * M + 30 * S); run(250, t = 2 * M + 60 * S); run(350, t = 2 * M + 90 * S);   // slow: back over only after 90 s
    ok(s.fast === 0 && s.gapMs === 2 * M, 'back-off: a trim that held for over 60 s breaks the run');

    // calm reset
    s = Object.assign(TW.fresh(TW.DEFAULTS), { gapMs: 8 * M, lastTrimAt: 1, pending: false }); logs = [];
    run(250, t = 100 * M); run(250, t = 105 * M);
    ok(s.gapMs === 8 * M && logs.length === 0, 'calm: 5 min under the line is not yet calm');
    run(250, t = 110 * M);
    ok(s.gapMs === 2 * M && logs.length === 1 && /back-off reset: under 300 MB for 10 min/.test(logs[0]), 'calm: 10 min under the line -> the gap is back to 2 min, one note');
    run(350, t = 111 * M); run(250, t = 112 * M);
    ok(s.calmSince === 112 * M, 'calm: a reading over the line restarts the calm clock');
  }

  /* ------------------------------------------------ sptrim lane: the watch itself (fake clock, fake sidecar) */
  {
    const TW = require('./_spotify-trim.js');
    const mk = (over) => {
      const W = { now: 0, timers: [], logs: [], changes: 0, shown: 0, old: 0, mem: [], trims: [], audio: { pids: [], reason: null },
        read: { running: true, created: '77', visible: 0, mb: 900, procs: [{ pid: 5, mb: 125 }, { pid: 6, mb: 775 }] }, readErr: null };
      W.w = TW.createTrimWatch(Object.assign({
        now: () => W.now,
        setTimeout: (f, ms) => { const h = { f, ms }; W.timers.push(h); return h; },
        clearTimeout: (h) => { W.timers = W.timers.filter((x) => x !== h); },
        read: async (root, created) => { W.mem.push([root, created]); if (W.readErr) throw W.readErr; return Object.assign({}, W.read); },
        audio: async () => { W.audioCalls = (W.audioCalls || 0) + 1; return W.audio; },
        trim: async (root, created, skip) => { W.trims.push([root, created, skip]); return { trimmed: 1, beforeMB: W.read.mb, afterMB: 140, refused: [] }; },
        log: (l) => W.logs.push(l), onChange: () => { W.changes++; }, onShown: () => { W.shown++; }, onUnavailable: () => { W.old++; },
      }, over || {}));
      W.fire = async (ms) => { W.now += ms; const h = W.timers.shift(); if (h) { h.f(); } await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
      return W;
    };

    const A = mk();
    A.w.start(5, 'test');
    ok(A.w.view().state === 'watching' && A.logs.length === 1 && /trimmed when over 400 MB, checked every 30 s, at most once per 2 min/.test(A.logs[0]), 'start: one line ' + JSON.stringify(A.logs));
    ok(A.timers.length === 1 && A.timers[0].ms === 8000, 'the first read is 8 s after the hide (the old one-time trim\'s moment)');
    await A.fire(8000);
    ok(A.trims.length === 1 && A.trims[0][0] === 5 && A.trims[0][1] === '77', 'over the line -> trimmed, the root pinned by its start time ' + JSON.stringify(A.trims));
    ok(A.logs.length === 2 && /trimmed the hidden Spotify: 900 MB → 140 MB of RAM \(1 process[;)]/.test(A.logs[1]), 'one line per trim with before -> after ' + JSON.stringify(A.logs));
    ok(A.timers.length === 1 && A.timers[0].ms === 30000, 'then every 30 s');
    A.read.mb = 280;
    for (let i = 0; i < 6; i++) await A.fire(30000);
    ok(A.logs.length === 2 && A.trims.length === 1 && A.mem.length === 7, 'quiet ticks write nothing and trim nothing ' + JSON.stringify(A.logs.slice(2)));
    ok(A.audioCalls === 1, 'a quiet tick under the line is ONE sidecar call (who plays the audio is asked only when over) ' + A.audioCalls);
    ok(A.w.view().mb === 280 && A.w.view().at === A.now, 'the view carries the latest reading');
    const sig0 = A.w.sig(); A.read.mb = 281; await A.fire(30000);
    ok(A.w.sig() === sig0, 'the pushed signature ignores the 30 s number (no push per tick)');

    // read errors: once per distinct reason
    A.readErr = new Error('the sidecar is restarting');
    await A.fire(30000); await A.fire(30000); await A.fire(30000);
    ok(A.logs.filter((l) => /could not read the hidden Spotify’s memory: the sidecar is restarting/.test(l)).length === 1 && A.w.view().error, 'a failing read is logged once and shown ' + JSON.stringify(A.logs.slice(-2)));
    A.readErr = null; await A.fire(30000);
    ok(!A.w.view().error && A.w.view().state === 'watching', 'and clears when a read works');

    // audio unknown: no trim, said once
    A.read.mb = 500; A.audio = { pids: null, reason: 'no default playback device' };
    await A.fire(30000); await A.fire(30000);
    ok(A.trims.length === 1 && A.logs.filter((l) => /not trimmed: which process plays the audio could not be read \(no default playback device\)/.test(l)).length === 1, 'audio unknown -> no trim, said once');
    A.audio = { pids: [5], reason: null };
    await A.fire(30000);
    ok(A.trims.length === 2 && JSON.stringify(A.trims[1][2]) === '[5]', 'audio known again -> trims all but the pid playing ' + JSON.stringify(A.trims[1]));

    // stop conditions
    A.read.visible = 1;
    await A.fire(30000);
    ok(A.w.view().state === 'stopped' && /window is showing/.test(A.w.view().reason) && A.shown === 1 && A.timers.length === 0, 'window showing -> stops, tells the bridge, no timer left');
    const B = mk(); B.w.start(9); B.read.running = false; B.read.why = 'the Spotify Mantle started (pid 9) has exited';
    await B.fire(8000);
    ok(B.w.view().state === 'stopped' && /has exited/.test(B.w.view().reason) && B.timers.length === 0 && B.logs.filter((l) => /^stopped watching/.test(l)).length === 1, 'Spotify exited -> stops, one line');
    const D = mk(); D.w.start(9); D.w.stop('the Spotify queue was turned off');
    ok(D.w.view().state === 'stopped' && D.timers.length === 0, 'feature off -> stopped, no timer');
    await D.fire(8000);
    ok(D.mem.length === 0, 'and nothing is read after');
    D.w.stop('again');
    ok(D.logs.filter((l) => /^stopped watching/.test(l)).length === 1, 'a second stop says nothing');
    const E = mk(); E.readErr = Object.assign(new Error('unknown command: spotify.mem'), { code: 'old' }); E.w.start(3);
    await E.fire(8000);
    ok(E.w.view().state === 'unavailable' && E.old === 1 && E.timers.length === 0 && /restart Mantle/.test(E.w.view().reason), 'old sidecar -> unavailable, the fallback called once, no more reads');
    const G = mk({ aboveMB: () => 1000 }); G.w.start(4);
    await G.fire(8000);
    ok(G.trims.length === 0 && G.w.view().aboveMB === 1000, 'the threshold is read from the setting each tick');

    // back-off lines through the watch
    const H = mk(); H.w.start(5);
    await H.fire(8000);                                  // trim 1 (900)
    H.read.mb = 450;
    await H.fire(30000);                                 // fast #1
    for (let i = 0; i < 3; i++) await H.fire(30000);     // 2 min after trim 1 -> trim 2
    await H.fire(30000);                                 // fast #2 -> back-off
    ok(H.trims.length === 2 && H.logs.filter((l) => /^back-off: /.test(l)).length === 1 && H.w.view().gapMs === 4 * 60000, 'back-off change: one line, the gap shown ' + JSON.stringify(H.logs.slice(1)));
  }

  /* ------------------------------------------------ sptrim lane: realProc's sidecar reads (a fake sidecar, nothing spawned) */
  {
    const { realProc } = require('./_spotify-app.js');
    const sent = [];
    const MiB = 1048576;
    const fakeSc = async (cmd, args, ms) => {
      sent.push([cmd, args, ms]);
      if (cmd === 'spotify.mem') return { ok: true, result: { running: true, created: '5', visible: 0, n: 2, ws: 500 * MiB, pws: 380 * MiB, priv: 700 * MiB,
        procs: [{ pid: 1, ws: 200 * MiB, pws: 125 * MiB }, { pid: 2, ws: 300 * MiB, pws: 255 * MiB }], ms: 3 } };
      if (cmd === 'spotify.trim') return { ok: true, result: { running: true, trimmed: 1, before: 380 * MiB, after: 130 * MiB,
        results: [{ pid: 1, ok: false, skipped: true }, { pid: 2, ok: true }, { pid: 3, ok: false, why: 'could not be opened to trim (error 5)' }] } };
      if (cmd === 'audio') return { ok: true, result: { ok: true, sessions: [{ pid: 1, active: true }, { pid: 7, active: false }, { pid: 0, active: true }] } };
      return { ok: false, error: 'unknown command: ' + cmd };
    };
    const rp = realProc({ sidecar: fakeSc, exe: 'C:\\fake\\Spotify.exe' });
    const m = await rp.mem(1, '5');
    ok(m.running && m.mb === 380 && m.procs.length === 2 && m.procs[1].mb === 255 && m.created === '5', 'realProc.mem: the private working set in MB, per process ' + JSON.stringify(m));
    ok(sent[0][0] === 'spotify.mem' && sent[0][1].root === 1 && sent[0][1].created === '5' && sent[0][1].exe === 'C:\\fake\\Spotify.exe', 'realProc.mem asks the sidecar for that root, as first seen, at the exe it launched ' + JSON.stringify(sent[0]));
    const t = await rp.trimTree(1, '5', [1]);
    ok(t.trimmed === 1 && t.beforeMB === 380 && t.afterMB === 130 && t.refused.length === 1 && t.refused[0].pid === 3, 'realProc.trimTree: before -> after, the failures listed, a skip is not a failure ' + JSON.stringify(t));
    ok(JSON.stringify(sent[1][1].skip) === '[1]', 'the skip list goes to the sidecar');
    const a = await rp.audio();
    ok(JSON.stringify(a.pids) === '[1]', 'realProc.audio: only pids with an ACTIVE session ' + JSON.stringify(a));
    let err = null;
    try { await realProc({ sidecar: async () => ({ ok: false, error: 'unknown command: spotify.mem' }) }).mem(1); } catch (e) { err = e; }
    ok(err && err.code === 'old', 'an old sidecar is told apart (code old)');
    err = null;
    try { await realProc({}).mem(1); } catch (e) { err = e; }
    ok(err && err.code === 'nosidecar', 'no sidecar: said, never a silent no-op');
  }

  /* ------------------------------------------------ spadopt lane: taking over the hidden Spotify an earlier Mantle started */
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const EXE = 'C:\\fake\\Spotify.exe';
    const ft = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
    const T0 = Date.now() - 42 * 60000 - 5000;           // started 42 min ago
    const MANTLE = `"${EXE}" --remote-debugging-port=47292 --minimized --disable-gpu`;
    const rows = (cmd, extra) => [
      Object.assign({ pid: 4321, ppid: 999, exe: EXE, cmd, createdMs: T0 }, extra || {}),
      { pid: 4322, ppid: 4321, exe: EXE, cmd: `"${EXE}" --type=renderer --remote-debugging-port=47292 --minimized --disable-gpu`, createdMs: T0 + 400 },
      { pid: 4323, ppid: 4321, exe: EXE, cmd: `"${EXE}" --type=gpu-process --disable-gpu`, createdMs: T0 + 300 },
    ];
    const adoptProc = (cmd, extra, init) => {
      const p = fakeProc(Object.assign({ pids: [4321, 4322, 4323], created: ft(T0) }, init || {}));
      p.P.list = rows(cmd, extra);
      return p;
    };
    const touched = (p) => p.P.calls.filter((c) => (Array.isArray(c) ? ['launch', 'trim'].includes(c[0]) : ['close', 'kill'].includes(c)));
    const X = require('./_spotify-app.js');

    // the pure decision
    ok(JSON.stringify(X.cmdTokens('"C:\\a b\\Spotify.exe" --x=1  --y')) === JSON.stringify(['C:\\a b\\Spotify.exe', '--x=1', '--y']), 'cmdTokens: quotes and runs of spaces');
    ok(X.SIGNATURE.join(' ') === '--remote-debugging-port=47292 --minimized --disable-gpu', 'the signature is exactly Mantle\'s hidden launch: ' + X.SIGNATURE.join(' '));
    let pk = X.pickMantleSpotify(rows(MANTLE), EXE);
    ok(pk.match && pk.match.pid === 4321 && !pk.several.length && !pk.seen.length, 'picks the ROOT with the signature, never a --type= child ' + JSON.stringify(pk));
    pk = X.pickMantleSpotify(rows(MANTLE, { exe: 'c:\\FAKE\\spotify.EXE' }), EXE);
    ok(pk.match && pk.match.pid === 4321, 'the path is compared the way Windows does (case)');
    pk = X.pickMantleSpotify(rows(`"${EXE}"`), EXE);
    ok(!pk.match && pk.seen.length === 1 && /not started hidden by Mantle \(no --remote-debugging-port=47292, --minimized, --disable-gpu\)/.test(pk.seen[0].why), 'a Spotify Owen opened (no args) is not picked, and why ' + JSON.stringify(pk.seen));
    pk = X.pickMantleSpotify(rows(`"${EXE}" --autostart --minimized`), EXE);
    ok(!pk.match && /no --remote-debugging-port=47292, --disable-gpu/.test(pk.seen[0].why), 'Spotify\'s own autostart is not picked');
    pk = X.pickMantleSpotify(rows(`"${EXE}" --remote-debugging-port=47292 --minimized`), EXE);
    ok(!pk.match && /no --disable-gpu/.test(pk.seen[0].why), 'Mantle\'s Restart (port, not hidden) is not picked');
    pk = X.pickMantleSpotify(rows(`"${EXE}" --remote-debugging-port=472920 --minimized --disable-gpu`), EXE);
    ok(!pk.match, 'a near-miss port is not the signature (exact tokens)');
    pk = X.pickMantleSpotify(rows(MANTLE, { exe: 'C:\\Other\\Spotify.exe' }), EXE);
    ok(!pk.match && /it runs C:\\Other\\Spotify\.exe, not C:\\fake\\Spotify\.exe/.test(pk.seen[0].why), 'another Spotify.exe path is not picked, and why ' + JSON.stringify(pk.seen));
    pk = X.pickMantleSpotify(rows(MANTLE, { cmd: null }), EXE);
    ok(!pk.match && /command line could not be read/.test(pk.seen[0].why), 'an unreadable command line is not picked');
    pk = X.pickMantleSpotify(rows(MANTLE).concat([{ pid: 777, ppid: 1, exe: EXE, cmd: MANTLE, createdMs: T0 }]), EXE);
    ok(!pk.match && pk.several.length === 2, 'two look-alikes: neither is picked');
    pk = X.pickMantleSpotify([{ pid: 4321, ppid: 50, exe: EXE, cmd: MANTLE, createdMs: T0 }, { pid: 50, ppid: 1, exe: EXE, cmd: `"${EXE}" --type=utility`, createdMs: T0 + 9000 }], EXE);
    ok(pk.match && pk.match.pid === 4321, 'a reused parent pid (a Spotify.exe younger than it) does not make the root a child');
    ok(X.fileTimeMs(ft(T0)) === T0 && X.fileTimeMs('x') === null, 'FILETIME -> ms');

    // hidden: taken over, the watch on that root AND its start time, one log line, nothing touched
    const p1 = adoptProc(MANTLE);
    const b1 = bridge(await freePort(), { proc: p1, exe: EXE, trimDelayMs: 20 });
    const r1 = await b1.sp.takeOver('Mantle started');
    const w1 = b1.sp.window();
    ok(r1.adopted && r1.pid === 4321 && w1 && w1.state === 'hidden' && w1.how === X.ADOPTED && w1.adopted && w1.pid === 4321, 'a hidden Mantle-style Spotify is taken over as hidden ' + JSON.stringify(r1) + ' ' + JSON.stringify(w1));
    ok(w1.watch.state === 'watching' && w1.watch.root === 4321 && b1.sp.watch.created === ft(T0), 'the watch starts on that root and its start time ' + JSON.stringify(w1.watch) + ' ' + b1.sp.watch.created);
    ok(b1.logs.filter((l) => /^took over the hidden Spotify an earlier Mantle started \(pid 4321, running for 42 min\); trimming it over 400 MB$/.test(l)).length === 1, 'one log line: ' + JSON.stringify(b1.logs.filter((l) => /took over/.test(l))));
    ok(p1.P.calls.some((c) => Array.isArray(c) && c[0] === 'mem' && c[1] === 4321 && c[2] === ''), 'the takeover reads the start time and window through spotify.mem (read only)');
    ok(b1.statuses.some((s) => s.window && s.window.state === 'hidden' && s.window.watch.state === 'watching'), 'the card is told (window hidden, watching)');
    ok(touched(p1).length === 0, 'the takeover itself launches, closes, kills and trims nothing ' + JSON.stringify(touched(p1)));
    await sleep(60);
    const reads1 = p1.P.calls.filter((c) => Array.isArray(c) && c[0] === 'mem' && c[1] === 4321 && c[2] === ft(T0));
    const tt1 = p1.P.calls.find((c) => Array.isArray(c) && c[0] === 'trimTree');
    ok(reads1.length >= 1 && tt1 && tt1[1] === 4321 && tt1[2] === ft(T0), 'the watch reads and trims (over 400 MB) with that root and start time ' + JSON.stringify(tt1));
    ok(!p1.P.calls.some((c) => Array.isArray(c) && c[0] === 'trim'), 'no one-time trim on a takeover: the watch holds the line');
    const again = await b1.sp.takeOver('Spotify came up on the port');
    ok(!again.adopted && /already holds/.test(again.reason) && p1.P.listCalls === 1, 'a second takeover while holding it does nothing');
    b1.sp.stop();

    // window showing: taken over as shown, no watch; Hide from the card starts it (same root + start time); Quit works
    const F2 = createFakeSpotify();
    const port2 = await F2.start();
    const p2 = adoptProc(MANTLE);
    p2.P.visibleFn = () => F2.win.state !== 4;
    const b2 = bridge(port2, { proc: p2, exe: EXE, trimDelayMs: 20, windowVerifyMs: 5, closeWaitMs: 300 });
    const r2 = await b2.sp.takeOver('Mantle started');
    ok(r2.adopted && b2.sp.window().state === 'shown' && b2.sp.window().watch.state === 'off', 'a Mantle-style Spotify with its window open is taken over as shown, not watched ' + JSON.stringify(b2.sp.window()));
    ok(b2.logs.some((l) => /^took over the Spotify an earlier Mantle started hidden \(pid 4321, running for 42 min\); its window is showing/.test(l)), 'said in the log');
    ok(!F2.calls.some((c) => c[0] === 'setWindowState'), 'taking over never hides or shows it');
    const h2 = await b2.sp.hideWindow();
    ok(h2.verified && b2.sp.window().state === 'hidden' && b2.sp.window().watch.state === 'watching' && b2.sp.window().watch.root === 4321 && b2.sp.watch.created === ft(T0), 'Hide window on the taken-over one: hidden and watched on its root and start time ' + JSON.stringify(b2.sp.window()));
    await b2.sp.openWindow();
    ok(b2.sp.window().state === 'shown' && b2.sp.window().watch.state === 'stopped', 'Open Spotify on it: shown, the watch stops');
    const q2 = await b2.sp.quit();
    ok(q2.ok && b2.sp.window() === null, 'Quit on it: closed, no window state ' + JSON.stringify(q2));
    b2.sp.stop(); await F2.stop();

    // not Mantle's: Owen's own Spotify, and one at another path: never taken over, nothing read or watched
    for (const [what, pr] of [['a Spotify Owen opened', adoptProc(`"${EXE}"`)], ['a Spotify.exe at another path', adoptProc(MANTLE, { exe: 'C:\\Other\\Spotify.exe' })]]) {
      const bx = bridge(await freePort(), { proc: pr, exe: EXE, trimDelayMs: 20 });
      const rx = await bx.sp.takeOver('Mantle started');
      await sleep(40);
      ok(!rx.adopted && bx.sp.window() === null && bx.sp.watch.view().state === 'off', `${what} is never taken over ` + JSON.stringify(rx));
      ok(!pr.P.calls.some((c) => Array.isArray(c) && (c[0] === 'mem' || c[0] === 'trimTree')) && touched(pr).length === 0, `${what}: never read, watched or trimmed ` + JSON.stringify(pr.P.calls));
      ok(bx.logs.filter((l) => /^not taking over Spotify \(Mantle started\): pid 4321: .*\. It is left alone$/.test(l)).length === 1, `${what}: one log line, with why ` + JSON.stringify(bx.logs.slice(-2)));
      bx.sp.stop();
    }

    // --test (dryRun): found and said, never taken over
    const p3 = adoptProc(MANTLE);
    const b3 = bridge(await freePort(), { proc: p3, exe: EXE, trimDelayMs: 20, dryRun: true });
    const r3 = await b3.sp.takeOver('Mantle started');
    await sleep(40);
    ok(r3.dryRun && !r3.adopted && r3.pid === 4321 && b3.sp.window() === null && b3.sp.watch.view().state === 'off' && !p3.P.calls.some((c) => Array.isArray(c) && c[0] === 'trimTree'), 'dry run: found, said, not taken over or trimmed ' + JSON.stringify(r3));
    ok(b3.logs.some((l) => /^dry run: would take over the Spotify an earlier Mantle started hidden \(pid 4321, running for 42 min, window hidden\)/.test(l)), 'dry run: said in the log');
    b3.sp.stop();

    // failures show on the card and in the log, with the reason
    const p4 = adoptProc(MANTLE);
    p4.P.listFails = 'Get-CimInstance: Access denied';
    const b4 = bridge(await freePort(), { proc: p4, exe: EXE });
    const r4 = await b4.sp.takeOver('Mantle started');
    ok(!r4.ok && b4.sp.window() && b4.sp.window().state === 'failed' && b4.sp.window().takeOverFailed && /Could not take over the hidden Spotify an earlier Mantle started: .*Access denied.*Its memory is not watched/.test(b4.sp.window().reason), 'a failed process read: failed on the card with the reason ' + JSON.stringify(b4.sp.window()));
    ok(b4.logs.some((l) => /^Could not take over .*Access denied/.test(l)) && b4.statuses.some((s) => s.window && s.window.state === 'failed'), 'and in the log, and pushed');
    p4.P.listFails = null;
    const r4b = await b4.sp.takeOver('Spotify came up on the port');
    ok(r4b.adopted && b4.sp.window().state === 'hidden', 'a failed takeover is retried and can then succeed');
    b4.sp.stop();
    const p5 = adoptProc(MANTLE, null, { pids: [] });
    p5.P.listFails = 'no answer';
    const b5 = bridge(await freePort(), { proc: p5, exe: EXE });
    const r5 = await b5.sp.takeOver('Mantle started');
    ok(r5.ok && !r5.adopted && b5.sp.window() === null, 'a failed read with no Spotify running at all is not a failure');
    b5.sp.stop();
    const p6 = adoptProc(MANTLE);
    p6.P.memFails = 'the helper timed out';
    const b6 = bridge(await freePort(), { proc: p6, exe: EXE });
    await b6.sp.takeOver('Mantle started');
    ok(b6.sp.window().state === 'failed' && /\(pid 4321\): its memory and window could not be read \(the helper timed out\)/.test(b6.sp.window().reason), 'a failed spotify.mem read: said with the reason ' + JSON.stringify(b6.sp.window()));
    b6.sp.stop();
    const p7 = adoptProc(MANTLE, null, { created: ft(T0 + 60000) });
    const b7 = bridge(await freePort(), { proc: p7, exe: EXE });
    await b7.sp.takeOver('Mantle started');
    ok(b7.sp.window().state === 'failed' && /start time changed/.test(b7.sp.window().reason) && b7.sp.watch.view().state === 'off', 'a pid reused between the two reads is refused ' + JSON.stringify(b7.sp.window()));
    b7.sp.stop();

    // Spotify comes up on the port later: taken over then, without being asked
    const F8 = createFakeSpotify();
    const port8 = await F8.start();
    const p8 = adoptProc(MANTLE);
    p8.P.visibleFn = () => F8.win.state !== 4;
    F8.win.state = 4;
    const b8 = bridge(port8, { proc: p8, exe: EXE, trimDelayMs: 5000 });
    const s8 = await b8.sp.status();
    await sleep(80);
    ok(s8.state === 'connected' && b8.sp.window() && b8.sp.window().adopted && b8.sp.window().state === 'hidden' && p8.P.listCalls === 1, 'connecting to the port takes it over ' + JSON.stringify(b8.sp.window()));
    b8.sp.stop();
    ok(b8.sp.watch.view().state === 'stopped', 'feature stop stops the adopted watch');
    b8.sp.resume();
    ok(b8.sp.window().watch.state === 'watching' && b8.sp.watch.created === ft(T0), 'feature on again: watching the same root and start time');
    b8.sp.stop(); await F8.stop();
  }

  b.sp.stop();
  await F.stop();
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY-APP ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY-APP ${pass} passed, ${fail + 1} failed`); process.exit(1); });
