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
const J = (x) => JSON.stringify(x);
function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
const FAST = { verifyDelayMs: 5, stepDelayMs: 2, pollMs: 25, closeWaitMs: 200, forceAfterMs: 200, forceWaitMs: 200, startWaitMs: 1500, httpTimeoutMs: 800, openTimeoutMs: 800, evalTimeoutMs: 1500, searchTimeoutMs: 1500, hideEvalMs: 1500, hideEvalMaxMs: 3000 };

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
    // r6-art: the playing song's cover too (the card's art when Windows has none), never its address
    ok(/^data:image\/png;base64,/.test(q.current.image || '') && !('currentImage' in q), 'the playing song\'s cover arrives as data: too: ' + String(q.current.image).slice(0, 30));
    ok(b.fetched.some((u) => /^https:\/\/i\.scdn\.co\/image\/ab67616d00004851/.test(u)), 'spotify:image: becomes i.scdn.co, the SMALL image');
    ok(q.nextUp[2].image === null && q.nextUp[2].imageReason === 'The artwork didn’t load', 'a missing artwork keeps a plain reason: ' + q.nextUp[2].imageReason);
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
    ok(r.ok && r.verified && r.via === 'next' && /^Spotify couldn’t jump straight to it, so Mantle skipped ahead 3 times$/.test(r.note || ''), 'skipTo refused -> 3 x next, said in the note in plain words ' + JSON.stringify(r));
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
    ok(!r3.ok && /^Spotify’s search didn’t answer\. Try again in a moment$/.test(r3.reason) && b2.logs.some((l) => /PersistedQueryNotFound/.test(l)), 'a rejected query: plain words on the card, Spotify’s own error in the log ' + JSON.stringify(r3));
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
    ok(!q.ok && /^Spotify didn’t answer within 2 s\. Try again/.test(q.reason) && Date.now() - t0 < 4000, 'a stuck page times out cleanly ' + JSON.stringify(q));
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
    ok(s.state === 'internals' && /^This version of Spotify \(1\.3\.0\.277\) works differently from what Mantle knows/.test(s.reason) && /Spotify update/.test(s.reason), 'no PlayerAPI -> internals, with the version, in plain words ' + JSON.stringify(s));
    ok(b3.logs.some((l) => /internals were not found: no Platform object in \d+ React nodes/.test(l)), 'the technical why is in the log');
    const q = await b3.sp.queue();
    ok(!q.ok && q.state === 'internals', 'queue says internals too');
    b3.sp.stop(); await F3.stop();
    const F4 = createFakeSpotify({ internals: false });   // Platform found, registry has no PlayerAPI
    const p4 = await F4.start();
    const b4 = bridge(p4);
    const s4 = await b4.sp.status();
    ok(s4.state === 'internals' && b4.logs.some((l) => /gave no PlayerAPI/.test(l)), 'Platform without PlayerAPI -> internals, the why in the log ' + s4.reason);
    b4.sp.stop(); await F4.stop();
  }

  /* ------------------------------------------------ some other program on the port */
  {
    const F5 = createFakeSpotify({ list: [{ id: 'X', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/X' }] });
    const p5 = await F5.start();
    const b5 = bridge(p5);
    const s = await b5.sp.status();
    ok(s.state === 'portbusy' && /^Another program is using the connection Mantle uses for Spotify/.test(s.reason) && b5.logs.some((l) => /none of its 1 page/.test(l)), 'a non-Spotify debugging port -> portbusy, plain words, the detail logged ' + JSON.stringify(s));
    b5.sp.stop(); await F5.stop();
    const F6 = createFakeSpotify({ list: [{ id: 'P', type: 'page', url: 'https://xpui.app.spotify.com/index.html', webSocketDebuggerUrl: 'ws://evil.example:80/devtools/page/P' }] });
    const p6 = await F6.start();
    const b6 = bridge(p6);
    const s6 = await b6.sp.status();
    ok(s6.state === 'portbusy' && b6.logs.some((l) => /unexpected socket address/.test(l)) && !F6.calls.some((c) => c[0] === 'upgrade'), 'a socket address off 127.0.0.1:<port> is never connected to');
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

    // spotpid lane: Restart closes by the MAIN pid (the Spotify the user opened: 5, its renderer 6 and GPU
    // helper 7), never by image name. The pid Mantle started (4242) is gone, so the list names the root.
    const TREE = [{ pid: 5, ppid: 1, exe: 'C:\\fake\\Spotify.exe', cmd: '"C:\\fake\\Spotify.exe"', createdMs: 10 },
      { pid: 6, ppid: 5, exe: 'C:\\fake\\Spotify.exe', cmd: '"C:\\fake\\Spotify.exe" --type=renderer', createdMs: 11 },
      { pid: 7, ppid: 5, exe: 'C:\\fake\\Spotify.exe', cmd: '"C:\\fake\\Spotify.exe" --type=gpu-process', createdMs: 12 }];
    const pidCalls = (verb) => proc.P.calls.filter((c) => Array.isArray(c) && c[0] === verb).map((c) => c[1]);
    const byName7 = () => proc.P.calls.includes('close') || proc.P.calls.includes('kill');
    // restart: polite close works; it was minimized, so it comes back minimized (NOT hidden: they opened it)
    proc.P.visibleFn = null;
    proc.P.pids = [5, 6, 7]; proc.P.list = TREE; proc.P.visibleNow = false; proc.P.calls.length = 0;
    const F8 = createFakeSpotify();
    proc.P.onLaunch = async () => { setTimeout(() => F8.start(p7), 80); };
    const rr = await b7.sp.restart();
    ok(rr.ok && !rr.forced && !rr.note, 'restart: WM_CLOSE to its main pid was enough (no force, no note) ' + JSON.stringify(rr));
    const l2 = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'launch');
    ok(J(pidCalls('closePid')) === '[5]' && !pidCalls('killPid').length && !byName7() && l2 && l2[2].join(' ') === FLAG + ' --minimized', 'closePid 5 (the root, not 6 or 7) -> launch ' + FLAG + ' --minimized (it was in the tray): ' + JSON.stringify(proc.P.calls));
    ok(b7.logs.some((l) => /^restart Spotify: it is closed \(Spotify’s own quit was unavailable \(.+\), so Windows asked the main Spotify process \(pid 5\) to close \(taskkill \/PID \/T without \/F\)\)$/.test(l)), 'the log names the pid and the step ' + J(b7.logs.slice(-3)));
    ok(b7.logs.some((l) => /^the Spotify Mantle started \(pid 4242\) is not running any more; looking for the main Spotify process instead$/.test(l)), 'a stale pid is said, and not asked');
    ok(b7.sp.window() === null, 'the closed tree leaves no window record behind');
    await F8.stop();

    // restart: Spotify ignores WM_CLOSE (minimize-to-tray) -> that TREE is forced by its pid, and said so
    proc.P.pids = [5, 6, 7]; proc.P.visibleNow = true; proc.P.closePidWorks = false; proc.P.calls.length = 0;
    const F9 = createFakeSpotify();
    proc.P.onLaunch = async () => { setTimeout(() => F9.start(p7), 80); };
    const rf = await b7.sp.restart();
    const l3 = proc.P.calls.find((c) => Array.isArray(c) && c[0] === 'launch');
    ok(rf.ok && rf.forced && /^Spotify didn’t close on its own within \d+(\.\d)? s, so Mantle closed it before starting it again$/.test(rf.note || ''), 'a refused close is forced AND said on the card ' + JSON.stringify(rf));
    ok(J(pidCalls('closePid')) === '[5]' && J(pidCalls('killPid')) === '[5]' && !byName7(), 'asked by pid first, then forced by the SAME pid, never by image name ' + J(proc.P.calls));
    ok(proc.P.calls.findIndex((c) => Array.isArray(c) && c[0] === 'killPid') < proc.P.calls.findIndex((c) => Array.isArray(c) && c[0] === 'launch'), 'forced before the new start, never after');
    ok(l3 && l3[2].join(' ') === FLAG, 'visible before -> started normally (not minimized)');
    ok(b7.logs.some((l) => /^restart Spotify: it is closed \(FORCED\) \(.*so Mantle forced that tree closed \(taskkill \/PID \/T \/F\)\)$/.test(l)), 'the force is in the log too');
    await F9.stop();

    // restart: even the force fails -> NOT started again, and the card says why
    proc.P.pids = [5, 6, 7]; proc.P.killPidWorks = false; proc.P.calls.length = 0;
    proc.P.onLaunch = null;
    const rk = await b7.sp.restart();
    ok(!rk.ok && rk.forced && /^Spotify is still running even after Mantle forced it to close\. Try again, or end it in Task Manager$/.test(rk.reason) && b7.logs.some((l) => /taskkill \/PID \/T \/F on pid 5: pid 5: Access is denied/.test(l)) && !pidCalls('launch').length && !byName7(), 'a failed force: not restarted, said ' + J(rk));
    ok(b7.sp.last().state !== 'starting', 'and the card leaves "starting" ' + b7.sp.last().state);

    // restart: no main pid can be found -> nothing closed by pid, nothing by name, SAID
    proc.P.killPidWorks = true; proc.P.closePidWorks = true;
    proc.P.list = [TREE[1], TREE[2]].map((x) => Object.assign({}, x, { ppid: 99 })); proc.P.calls.length = 0;
    const rn0 = await b7.sp.restart();
    ok(!rn0.ok && /^Spotify didn’t quit, and Mantle couldn’t tell which program to close/.test(rn0.reason) && b7.logs.some((l) => /Mantle could not find its main process among pids 5, 6, 7, so Mantle closed nothing by process id/.test(l)) && !pidCalls('closePid').length && !pidCalls('killPid').length && !byName7() && !pidCalls('launch').length, 'no main pid: refused and said ' + J(rn0));
    proc.P.listFails = 'Get-CimInstance timed out';
    const rn1 = await b7.sp.restart();
    ok(!rn1.ok && /^Spotify didn’t quit, and Mantle couldn’t tell which program to close/.test(rn1.reason) && b7.logs.some((l) => /and Mantle could not find its main process \(Get-CimInstance timed out\), so Mantle closed nothing/.test(l)) && !byName7(), 'a failed process list: refused and said ' + J(rn1));
    proc.P.listFails = null; proc.P.list = null;

    // start: Spotify ignores the flag (port never opens) -> said, with the likely cause
    proc.P.pids = []; proc.P.calls.length = 0; proc.P.onLaunch = null;
    const rn = await b7.sp.start();
    ok(!rn.ok && /^Spotify started, but Mantle couldn’t connect to it within \d+ s\. Try Restart Spotify/.test(rn.reason), 'a port that never opens is said in plain words ' + JSON.stringify(rn));
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
    ok(r.ok && r.hidden && r.how === 'Spotify itself, when Mantle asked', 'start -> hidden by Spotify itself (its window-state service) ' + JSON.stringify(r));
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
    ok(lib.items[0].owner === 'Alex' && lib.items[2].owner === 'Some Band', 'owner / artists are carried for the sub-line');

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
    const tk = (p, verb) => p.P.calls.filter((c) => Array.isArray(c) && c[0] === verb).map((c) => c[1]);
    const anyKill = (p) => p.P.calls.includes('close') || p.P.calls.includes('kill') || tk(p, 'closePid').length > 0 || tk(p, 'killPid').length > 0;
    ok(q.ok && FH.quits === 1 && q.via === 'Spotify’s own LifecycleAPI.shutdown (pid 4242)' && !q.forced && !q.note && !anyKill(proc), 'Quit: LifecycleAPI.shutdown on the pid Mantle started, no taskkill ' + JSON.stringify(q));
    ok(bh.sp.last().state === 'notrunning' && bh.sp.window() === null, 'after Quit: not running, no window record');
    bh.sp.stop();
    await FH.stop();

    // quit when Spotify's own shutdown is missing: taskkill /PID /T WITHOUT /F on the MAIN pid (9, not
    // its renderer 10), never forced when that is enough, never by image name
    const pq = await freePort();
    const FQ = createFakeSpotify({ lifecycle: false });
    const ROOT9 = [{ pid: 9, ppid: 1, exe: 'C:\\fake\\Spotify.exe', cmd: '"C:\\fake\\Spotify.exe"', createdMs: 10 },
      { pid: 10, ppid: 9, exe: 'C:\\fake\\Spotify.exe', cmd: '"C:\\fake\\Spotify.exe" --type=renderer', createdMs: 11 }];
    const prq = fakeProc({ pids: [9, 10], list: ROOT9 });
    await FQ.start(pq);
    const bq = bridge(pq, { proc: prq, closeWaitMs: 200 });
    await bq.sp.status();
    const qq = await bq.sp.quit();
    ok(qq.ok && !qq.forced && !qq.note && J(tk(prq, 'closePid')) === '[9]' && !tk(prq, 'killPid').length && !prq.P.calls.includes('close') && !prq.P.calls.includes('kill')
      && /so Windows asked the main Spotify process \(pid 9\) to close \(taskkill \/PID \/T without \/F\)$/.test(qq.via), 'no LifecycleAPI -> WM_CLOSE to pid 9’s tree, not forced ' + JSON.stringify(qq));
    ok(bq.sp.last().state === 'notrunning', 'after it: not running');

    // it ignores that close request -> the SAME tree is forced by pid, and the card says so
    prq.P.pids = [9, 10]; prq.P.closePidWorks = false; prq.P.calls.length = 0;
    const qf = await bq.sp.quit();
    ok(qf.ok && qf.forced && /^Spotify didn’t quit on its own within \d+(\.\d)? s, so Mantle closed it\. Spotify is closed\.$/.test(qf.note || '') && /pid 9/.test(qf.via), 'an ignored close is forced by pid AND said (the pid only in via, for the log) ' + JSON.stringify(qf));
    ok(J(tk(prq, 'closePid')) === '[9]' && J(tk(prq, 'killPid')) === '[9]' && !prq.P.calls.includes('close') && !prq.P.calls.includes('kill') && !prq.P.pids.length, 'asked by pid, then forced by the same pid (its renderer went with it), never by image name ' + J(prq.P.calls));
    ok(bq.logs.some((l) => /^quit Spotify: it is closed \(FORCED\) \(.+so Mantle forced that tree closed \(taskkill \/PID \/T \/F\)\)$/.test(l)), 'the force is logged with its pid ' + J(bq.logs.slice(-2)));

    // even the force fails -> said on the card, not "quit"
    prq.P.pids = [9, 10]; prq.P.killPidWorks = false; prq.P.calls.length = 0;
    const qk = await bq.sp.quit();
    ok(!qk.ok && qk.forced && /^Spotify is still running even after Mantle forced it to close\. Try again, or end it in Task Manager$/.test(qk.reason) && bq.logs.some((l) => /pid 9: Access is denied/.test(l)) && bq.sp.last().state !== 'notrunning', 'a failed force is said ' + J(qk));

    // no main pid to be found -> nothing closed by pid or by name, and why
    prq.P.killPidWorks = true; prq.P.closePidWorks = true; prq.P.listFails = 'Get-CimInstance timed out'; prq.P.calls.length = 0;
    const qn = await bq.sp.quit();
    ok(!qn.ok && /^Spotify didn’t quit, and Mantle couldn’t tell which program to close\. Quit it from its own window$/.test(qn.reason) && bq.logs.some((l) => /Spotify’s own quit was unavailable \(.+\), and Mantle could not find its main process \(Get-CimInstance timed out\), so Mantle closed nothing by process id/.test(l)) && !anyKill(prq), 'no main pid: refused and said ' + J(qn));
    prq.P.listFails = null;

    // nothing running -> quit is done at once, nothing asked
    prq.P.pids = []; prq.P.calls.length = 0;
    const q0 = await bq.sp.quit();
    ok(q0.ok && !q0.forced && q0.via === 'Spotify was not running' && !anyKill(prq) && bq.sp.last().state === 'notrunning', 'not running: nothing to close ' + J(q0));
    bq.sp.stop(); await FQ.stop();

    // the Spotify Mantle STARTED is closed by its own pid (4242), with no process list read; an ignored
    // close request -> that tree forced, and said
    const pm = await freePort();
    const FM = createFakeSpotify({ lifecycle: false });
    const prm = fakeProc({ pids: [] });
    prm.P.visibleFn = () => FM.win.state !== 4;
    prm.P.onLaunch = async () => { setTimeout(() => FM.start(pm), 60); };
    const bm = bridge(pm, { proc: prm, hideVerifyMs: 5, trimDelayMs: 100000, windowVerifyMs: 5 });
    const rm = await bm.sp.start();
    ok(rm.ok && bm.sp.window() && bm.sp.window().pid === 4242, 'Mantle started it hidden (pid 4242) ' + J(rm));
    prm.P.closePidWorks = false; prm.P.calls.length = 0; prm.P.listCalls = 0;
    const qm = await bm.sp.quit();
    ok(qm.ok && qm.forced && /^Spotify didn’t quit on its own within \d+(\.\d)? s, so Mantle closed it\. Spotify is closed\.$/.test(qm.note || '') && /pid 4242/.test(qm.via), 'Mantle’s own Spotify: forced by its pid and said ' + J(qm));
    ok(J(tk(prm, 'closePid')) === '[4242]' && J(tk(prm, 'killPid')) === '[4242]' && prm.P.listCalls === 0 && !prm.P.calls.includes('close') && !prm.P.calls.includes('kill'), 'the pid Mantle knows, no list read, never by name ' + J(prm.P.calls));
    ok(/Windows asked the Spotify Mantle started \(pid 4242\) to close/.test(qm.via) && bm.sp.last().state === 'notrunning' && bm.sp.window() === null, 'said which Spotify, then not running ' + qm.via);
    bm.sp.stop(); await FM.stop();

    // the hide that does not take, and a missing window service: both SAID
    const pf = await freePort();
    const FF = createFakeSpotify({ windowSticks: true });
    const pr2 = fakeProc({ pids: [] });
    pr2.P.visibleFn = () => FF.win.state !== 4;
    pr2.P.onLaunch = async () => { setTimeout(() => FF.start(pf), 60); };
    const bf = bridge(pf, { proc: pr2, hideVerifyMs: 5, trimDelayMs: 20, hideRetryMs: [30, 30], hideRetryEveryMs: 30, hideRetryMax: 2 });
    const rf = await bf.sp.start();
    ok(rf.ok && rf.hidden === false && rf.hiding === true && /^Its window is not hidden yet \(its window is still showing\); Mantle keeps trying$/.test(rf.reason), 'a window that stays up is said, and tried again ' + JSON.stringify(rf));
    ok(bf.sp.window().state === 'hiding' && bf.sp.window().tries === 1 && bf.statuses.some((s) => s.window && s.window.state === 'hiding'), 'pushed as hiding (try 1)');
    await wait(400);
    const wf = bf.sp.window();
    ok(wf.state === 'failed' && wf.own && wf.gaveUp && wf.tries === 3 && /^Could not hide Spotify’s window: Spotify took the hide, but its window is still showing\. Mantle tried 3 times over \d+(\.\d)? s, then stopped$/.test(wf.reason), 'after the tries: failed, with the reason and the count ' + JSON.stringify(wf));
    ok(bf.logs.some((l) => /^Could not hide Spotify’s window: .*Mantle tried 3 times/.test(l)) && bf.logs.filter((l) => /^Spotify’s window is not hidden yet \(pid 4242, try [12]: /.test(l)).length === 2, 'each try and the give-up are logged ' + J(bf.logs.filter((l) => /hid/.test(l))));
    ok(!pr2.P.calls.some((c) => Array.isArray(c) && /^(trim|trimTree)$/.test(c[0])) && (!wf.watch || wf.watch.state !== 'watching'), 'no watch and no trim while the window is not hidden');
    bf.sp.stop(); await FF.stop();

    const pn = await freePort();
    const FN = createFakeSpotify({ windowApi: false });
    const pr3 = fakeProc({ pids: [] });
    pr3.P.onLaunch = async () => { setTimeout(() => FN.start(pn), 60); };
    const bn = bridge(pn, { proc: pr3, hideVerifyMs: 5 });
    const rn = await bn.sp.start();
    ok(rn.ok && rn.hidden === false && /^Could not hide Spotify’s window: This version of Spotify can’t hide its window from Mantle$/.test(rn.reason), 'no window service -> said in plain words ' + JSON.stringify(rn));
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
    ok(bo.logs.some((l) => /helper is older than this Mantle.*unknown command/.test(l)), 'and logs it, with the helper’s own words');
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
    ok(bw.sp.window().watch.state === 'stopped' && /opened from the card|window is showing/.test(bw.sp.window().watch.reason), 'open window -> the watch stops ' + JSON.stringify(bw.sp.window().watch));
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

  /* ------------------------------------------------ spotfix lane: a SLOW Spotify (busy PC): the hide is tried again */
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await wait(10); } return !!fn(); };
    const RETRY = { hideVerifyMs: 5, windowVerifyMs: 5, trimDelayMs: 100000, hideEvalMs: 300, hideEvalMaxMs: 600, hideRetryMs: [40, 40, 40, 40], hideRetryEveryMs: 40, hideRetryMax: 5 };
    const slowOne = async (fake, extra) => {
      const port = await freePort();
      const F = createFakeSpotify(fake || {});
      const pr = fakeProc({ pids: [] });
      pr.P.visibleFn = () => F.win.state !== 4;
      pr.P.onLaunch = async () => { setTimeout(() => F.start(port), 60); };
      return { F, pr, b: bridge(port, Object.assign({ proc: pr }, RETRY, extra || {})) };
    };

    // 1. the live case: the hide's answer comes after Mantle stopped waiting, but the hide LANDS. The
    //    retry LOOKS first, sees it hidden, and says so; nothing is sent twice
    const s1 = await slowOne({ slowMs: 700 }, { hideRetryMs: [800] });
    s1.F.slowWindow = 1;
    const r1 = await s1.b.sp.start();
    ok(r1.ok && r1.hidden === false && r1.hiding === true && /\(Spotify is slow to answer\); Mantle keeps trying$/.test(r1.reason), 'a slow answer: not failed, tried again ' + J(r1));
    const w1 = s1.b.sp.window();
    ok(w1.state === 'hiding' && w1.retryWhy === 'Spotify is slow to answer' && w1.lastReason === 'Spotify was too slow to answer' && w1.retryAt > Date.now() - 1000 && w1.reason === null, 'hiding: why, when, and the last reason, no error ' + J(w1));
    ok(await until(() => s1.b.sp.window().state === 'hidden', 3000), 'the late hide is seen and taken ' + J(s1.b.sp.window()));
    ok(/its answer came late/.test(s1.b.sp.window().how) && s1.b.sp.window().reason === null && s1.F.calls.filter((c) => c[0] === 'setWindowState').length === 1, 'hidden, said how, no second hide sent ' + J(s1.b.sp.window()));
    ok(s1.b.logs.some((l) => /^hid the Spotify window Mantle started \(pid 4242, from the Spotify card\): Spotify itself \(its answer came late\) on try 2$/.test(l)), 'logged with the try ' + J(s1.b.logs.filter((l) => /hid/.test(l))));
    ok(s1.b.statuses.some((s) => s.window && s.window.state === 'hiding') && s1.b.sp.last().window.state === 'hidden', 'the card got hiding, then hidden');
    s1.b.sp.stop(); await s1.F.stop();

    // 2. slow answers the page never took: tried again with backoff, and the third try hides it
    const s2 = await slowOne();
    s2.F.lostWindow = 2;
    const r2 = await s2.b.sp.start();
    ok(r2.hiding === true && s2.b.sp.window().state === 'hiding', 'try 1 lost -> hiding ' + J(r2));
    ok(await until(() => s2.b.sp.window().state === 'hidden', 4000), 'tried again until it took ' + J(s2.b.sp.window()));
    const n2 = s2.F.calls.filter((c) => c[0] === 'lostWindow').length;
    ok(n2 === 2 && s2.F.calls.filter((c) => c[0] === 'setWindowState').length === 1 && s2.b.logs.some((l) => /: Spotify itself, when Mantle asked on try 3, \d+(\.\d)? s after the first$/.test(l)), 'two lost tries, then hidden on try 3 ' + J(s2.b.logs.filter((l) => /hid|not hidden yet/.test(l))));
    ok(s2.b.logs.filter((l) => /^Spotify’s window is not hidden yet \(pid 4242, try [12]: Spotify was too slow to answer\); trying again in 0\.0 s$/.test(l)).length === 2, 'each slow try is one log line: pid, try, reason ' + J(s2.b.logs.filter((l) => /not hidden yet/.test(l))));
    ok(await until(() => s2.b.sp.window().watch && s2.b.sp.window().watch.state === 'watching', 500), 'once hidden, its memory is watched');
    s2.b.sp.stop(); await s2.F.stop();

    // 3. the hide waits LONGER than other calls (hideEvalMs, not evalTimeoutMs): a 0.5 s answer is
    //    too slow for a 0.3 s call but fine for the hide
    const s3 = await slowOne({ slowMs: 500 }, { evalTimeoutMs: 300, hideEvalMs: 1500 });
    s3.F.slowWindow = 1;
    const r3 = await s3.b.sp.start();
    ok(r3.ok && r3.hidden === true && s3.b.sp.window().state === 'hidden', 'a slow but answered hide takes the first time ' + J(r3));
    s3.b.sp.stop(); await s3.F.stop();

    // 4. slow every time: the tries run out -> failed, the reason, the count; then "Hide now" works
    const s4 = await slowOne();
    s4.F.lostWindow = 99;
    await s4.b.sp.start();
    ok(await until(() => s4.b.sp.window().state === 'failed', 6000), 'gave up in the end ' + J(s4.b.sp.window()));
    const w4 = s4.b.sp.window();
    ok(w4.own && w4.gaveUp && w4.tries === 6 && /^Could not hide Spotify’s window: Spotify was too slow to answer\. Mantle tried 6 times over \d+(\.\d)? s, then stopped$/.test(w4.reason), 'the give-up says why and how often ' + J(w4));
    ok(s4.b.sp.last().window.state === 'failed' && s4.b.logs.some((l) => /^Could not hide Spotify’s window: .*then stopped$/.test(l)), 'pushed and logged');
    const lostAt = s4.F.calls.filter((c) => c[0] === 'lostWindow').length;
    await wait(200);
    ok(s4.F.calls.filter((c) => c[0] === 'lostWindow').length === lostAt, 'and it stops trying');
    s4.F.lostWindow = 0;
    const hn = await s4.b.sp.hideWindow();
    ok(hn.ok && hn.verified && s4.b.sp.window().state === 'hidden' && s4.b.sp.window().reason === null, '"Hide now" hides it and clears the error ' + J(hn));
    // "Hide now" on a slow Spotify: tried again (hiding), said, not an error
    s4.F.win.state = 1; s4.F.lostWindow = 1;
    const hs = await s4.b.sp.hideWindow();
    ok(!hs.ok && hs.hiding === true && /Mantle keeps trying$/.test(hs.reason) && hs.window && hs.window.state === 'hiding', 'a slow "Hide now" goes back to trying ' + J(hs));
    ok(await until(() => s4.b.sp.window().state === 'hidden', 3000), 'and then hides it');
    s4.b.sp.stop(); await s4.F.stop();

    // 5. a reason that cannot pass (no window service): failed at once, no tries
    const s5 = await slowOne({ windowApi: false });
    const r5 = await s5.b.sp.start();
    ok(r5.hidden === false && !r5.hiding && s5.b.sp.window().state === 'failed' && s5.b.sp.window().own && !s5.b.sp.window().gaveUp && /This version of Spotify can’t hide its window from Mantle$/.test(r5.reason), 'no window service: failed at once ' + J(r5));
    await wait(120);
    ok(!s5.b.logs.some((l) => /not hidden yet/.test(l)), 'and not tried again');
    s5.b.sp.stop(); await s5.F.stop();

    // 6. the card's read is the truth: a failed hide that landed later reads as HIDDEN (never "Not
    //    hidden" next to "Running hidden"), and a hiding one stops trying
    const s6 = await slowOne({ windowApi: false });
    await s6.b.sp.start();
    ok(s6.b.sp.window().state === 'failed', 'failed first');
    s6.F.win.state = 4;                                   // it went to the tray after all
    const i6 = await s6.b.sp.info();
    ok(i6.visible === false && i6.window.state === 'hidden' && i6.window.reason === null && s6.b.sp.last().window.state === 'hidden', 'info: failed + not showing -> hidden, error gone ' + J(i6.window));
    s6.b.sp.stop(); await s6.F.stop();

    // 7. while hiding, Quit / Open / the pin bringing it forward all stop the tries
    const s7 = await slowOne({}, { hideRetryMs: [300], hideRetryEveryMs: 300 });
    s7.F.lostWindow = 1;
    await s7.b.sp.start();
    ok(s7.b.sp.window().state === 'hiding', 'hiding');
    s7.b.sp.opening({ source: 'the pinned icon' });
    ok(s7.b.sp.window().state === 'shown' && /brought forward from the pinned icon/.test(s7.b.sp.window().how) && s7.b.logs.some((l) => /^stopped hiding Spotify’s window: it was brought forward from the pinned icon$/.test(l)), 'the pin brought it forward: shown, no more tries ' + J(s7.b.sp.window()));
    const sw7 = s7.F.calls.filter((c) => c[0] === 'setWindowState').length;
    await wait(450);
    ok(s7.F.calls.filter((c) => c[0] === 'setWindowState').length === sw7 && s7.b.sp.window().state === 'shown', 'and never hidden behind the user’s back');
    s7.b.sp.stop(); await s7.F.stop();

    // 8. the hidden Spotify exits while being hid: the tries stop, the card says not running
    const s8 = await slowOne({}, { hideRetryMs: [60] });
    s8.F.lostWindow = 1;
    await s8.b.sp.start();
    s8.pr.P.pids = []; await s8.F.stop();
    ok(await until(() => s8.b.sp.window() === null, 2000) && s8.b.logs.some((l) => /^stopped hiding Spotify’s window: the Spotify Mantle started \(pid 4242\) is not running any more$/.test(l)), 'gone -> no window record, said ' + J(s8.b.logs.slice(-3)));
    ok(await until(() => s8.b.sp.last().state === 'notrunning', 1000), 'and the card says not running ' + s8.b.sp.last().state);
    s8.b.sp.stop();

    // 9. Spotify shows its window again soon after a start's hide (its page finished loading): hidden
    //    once more; later, or brought forward from a pin, it is the user's and left open
    const s9 = await slowOne({}, { trimDelayMs: 30, rehideSettleMs: 5000, watchOpts: { tickMs: 40 } });
    await s9.b.sp.start();
    ok(s9.b.sp.window().state === 'hidden' && s9.b.sp.window().settleUntil > Date.now(), 'hidden, settling');
    s9.F.win.state = 1;                                   // Spotify put its window back up
    ok(await until(() => s9.b.logs.some((l) => /^Spotify’s window came back \d+(\.\d)? s after Mantle hid it \(pid 4242, seen by the memory watch\); hiding it again$/.test(l)), 2000), 'the watch sees it come back, said ' + J(s9.b.logs.slice(-3)));
    ok(await until(() => s9.b.sp.window().state === 'hidden' && s9.F.win.state === 4, 2000) && !s9.b.sp.window().settleUntil, 'hidden again, once (no second settle) ' + J(s9.b.sp.window()));
    s9.F.win.state = 1;                                   // again: now it counts as the user's
    ok(await until(() => s9.b.sp.window().state === 'shown', 2000) && s9.b.sp.window().how === 'opened outside the card' && s9.F.win.state === 1, 'a second time it is left open ' + J(s9.b.sp.window()));
    s9.b.sp.stop(); await s9.F.stop();
    const s10 = await slowOne({}, { trimDelayMs: 30, rehideSettleMs: 5000, watchOpts: { tickMs: 40 } });
    await s10.b.sp.start();
    s10.b.sp.opening({ source: 'the pinned icon' });
    s10.F.win.state = 1;
    ok(await until(() => s10.b.sp.window().state === 'shown', 2000) && s10.F.win.state === 1 && !s10.b.logs.some((l) => /came back/.test(l)), 'brought forward from the pin while settling: left open ' + J(s10.b.sp.window()));
    s10.b.sp.stop(); await s10.F.stop();
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
    ok(A.trims.length === 1 && A.logs.filter((l) => /not trimmed: Mantle couldn’t tell which part of Spotify plays the audio \(no default playback device\)/.test(l)).length === 1, 'audio unknown -> no trim, said once');
    A.audio = { pids: [5], reason: null };
    await A.fire(30000);
    ok(A.trims.length === 2 && JSON.stringify(A.trims[1][2]) === '[5]', 'audio known again -> trims all but the pid playing ' + JSON.stringify(A.trims[1]));

    // stop conditions
    A.read.visible = 1;
    await A.fire(30000);
    ok(A.w.view().state === 'stopped' && /window is showing/.test(A.w.view().reason) && A.shown === 1 && A.timers.length === 0, 'window showing -> stops, tells the bridge, no timer left');
    const B = mk(); B.w.start(9); B.read.running = false; B.read.why = 'the Spotify Mantle started (pid 9) has exited';
    await B.fire(8000);
    ok(B.w.view().state === 'stopped' && B.w.view().reason === 'Spotify closed' && B.logs.some((l) => /has exited/.test(l)) && B.timers.length === 0 && B.logs.filter((l) => /^stopped watching/.test(l)).length === 1, 'Spotify exited -> stops, one line; the card’s reason has no pid');
    // spotdeath lane: an EXIT is handed to the owner, with the exit code when the sidecar knows it; a refused read is not
    const exits = [];
    const EX = mk({ onExit: (e) => exits.push(e) }); EX.w.start(9); EX.read.running = false; EX.read.why = 'the Spotify Mantle started (pid 9) has exited'; EX.read.exit = { code: 1, at: 5 };
    await EX.fire(8000);
    ok(exits.length === 1 && exits[0].root === 9 && exits[0].exit.code === 1 && /has exited/.test(exits[0].why), 'exit -> onExit once, with root and exit code ' + JSON.stringify(exits));
    const RF = mk({ onExit: (e) => exits.push(e) }); RF.w.start(9); RF.read.running = false; RF.read.why = 'pid 9 could not be read (error 5)';
    await RF.fire(8000);
    ok(exits.length === 1 && RF.w.view().state === 'stopped', 'a read that was refused stops the watch but is not an exit');
    const D = mk(); D.w.start(9); D.w.stop('the Spotify queue was turned off');
    ok(D.w.view().state === 'stopped' && D.timers.length === 0, 'feature off -> stopped, no timer');
    await D.fire(8000);
    ok(D.mem.length === 0, 'and nothing is read after');
    D.w.stop('again');
    ok(D.logs.filter((l) => /^stopped watching/.test(l)).length === 1, 'a second stop says nothing');
    const E = mk(); E.readErr = Object.assign(new Error('unknown command: spotify.mem'), { code: 'old' }); E.w.start(3);
    await E.fire(8000);
    ok(E.w.view().state === 'unavailable' && E.old === 1 && E.timers.length === 0 && /Restart Mantle to update it$/.test(E.w.view().reason) && !/sidecar/.test(E.w.view().reason), 'old sidecar -> unavailable, the fallback called once, no more reads');
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
    // spotpid lane: the real process layer can only close Spotify BY PID; a bad pid is refused before
    // taskkill is ever run (nothing here reaches a real process)
    ok(typeof rp.close === 'undefined' && typeof rp.kill === 'undefined' && typeof rp.closePid === 'function' && typeof rp.killPid === 'function', 'realProc: no by-image-name close/kill, only closePid/killPid');
    const bad = [await rp.killPid('Spotify.exe'), await rp.killPid(0), await rp.closePid(-4), await rp.killPid(null)];
    ok(bad.every((x) => x.out === '' && /^not a process id/.test(x.err)), 'realProc: a pid that is not one is refused, taskkill never run ' + J(bad));
  }

  /* ------------------------------------------------ spotpid lane: never taskkill Spotify BY IMAGE NAME, anywhere in lib/ */
  {
    const fs = require('fs'), path = require('path');
    // "/IM" then Spotify, across quotes, commas, spaces and a line break (LF or CRLF)
    const BY_NAME = /\/IM\b[ \t'"`,]*(?:\r?\n[ \t'"`,]*)?Spotify/i;
    const IM = '/' + 'IM';                 // built, so this file does not trip its own scan
    ok(BY_NAME.test(`['/F', '/T', '${IM}', 'Spotify.exe']`) && BY_NAME.test(`taskkill ${IM} Spotify.exe`) && BY_NAME.test(`'${IM}',\r\n      'Spotify.exe'`) && BY_NAME.test(`'${IM.toLowerCase()}',\n'spotify.exe'`)
      && !BY_NAME.test("['/FI', 'IMAGENAME eq Spotify.exe']") && !BY_NAME.test("['/PID', String(n), '/T', '/F']"), 'the by-name pattern catches the old forms (LF and CRLF) and not tasklist’s filter');
    const lib = path.join(__dirname, '..');
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
      }
    })(lib);
    const hits = files.filter((f) => BY_NAME.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(lib, f));
    ok(files.length > 20 && files.some((f) => /_spotify-app\.js$/.test(f)), 'the scan reads lib/ (' + files.length + ' files)');
    ok(!hits.length, 'no file in lib/ taskkills Spotify by image name (/IM): ' + hits.join(', '));
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
    ok(!pk.match && pk.seen.length === 1 && /not started hidden by Mantle \(no --remote-debugging-port=47292, --minimized, --disable-gpu\)/.test(pk.seen[0].why), 'a Spotify the user opened (no args) is not picked, and why ' + JSON.stringify(pk.seen));
    pk = X.pickMantleSpotify(rows(`"${EXE}" --autostart --minimized`), EXE);
    ok(!pk.match && /no --remote-debugging-port=47292, --disable-gpu/.test(pk.seen[0].why), 'Spotify\'s own autostart is not picked');
    pk = X.pickMantleSpotify(rows(`"${EXE}" --remote-debugging-port=47292 --minimized`), EXE);
    ok(!pk.match && /no --disable-gpu/.test(pk.seen[0].why), 'Mantle\'s Restart (port, not hidden) is not picked');
    pk = X.pickMantleSpotify(rows(`"${EXE}" --remote-debugging-port=472920 --minimized --disable-gpu`), EXE);
    ok(!pk.match, 'a near-miss port is not the signature (exact tokens)');
    pk = X.pickMantleSpotify(rows(MANTLE, { exe: 'C:\\Other\\Spotify.exe' }), EXE);
    ok(!pk.match && pk.seen[0].why === 'it runs a different Spotify.exe', 'another Spotify.exe path is not picked, and why ' + JSON.stringify(pk.seen));
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

    // not Mantle's: the user's own Spotify, and one at another path: never taken over, nothing read or watched
    for (const [what, pr] of [['a Spotify the user opened', adoptProc(`"${EXE}"`)], ['a Spotify.exe at another path', adoptProc(MANTLE, { exe: 'C:\\Other\\Spotify.exe' })]]) {
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
    ok(!r4.ok && b4.sp.window() && b4.sp.window().state === 'failed' && b4.sp.window().takeOverFailed && /^Mantle couldn’t take over the hidden Spotify it started before it restarted, so its memory isn’t watched/.test(b4.sp.window().reason) && b4.logs.some((l) => /Could not take over the hidden Spotify an earlier Mantle started: .*Access denied.*Its memory is not watched/.test(l)), 'a failed process read: failed on the card with the reason ' + JSON.stringify(b4.sp.window()));
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
    ok(b6.sp.window().state === 'failed' && b6.logs.some((l) => /\(pid 4321\): its memory and window could not be read \(the helper timed out\)/.test(l)) && !/pid/.test(b6.sp.window().reason), 'a failed spotify.mem read: said with the reason ' + JSON.stringify(b6.sp.window()));
    b6.sp.stop();
    const p7 = adoptProc(MANTLE, null, { created: ft(T0 + 60000) });
    const b7 = bridge(await freePort(), { proc: p7, exe: EXE });
    await b7.sp.takeOver('Mantle started');
    ok(b7.sp.window().state === 'failed' && b7.logs.some((l) => /start time changed/.test(l)) && b7.sp.watch.view().state === 'off', 'a pid reused between the two reads is refused ' + JSON.stringify(b7.sp.window()));
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

  /* ------------------------------------------------ spotdeath lane: the hidden Spotify closed during a game */
  {
    const { words } = require('./_spotify-revive.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return !!fn(); };
    const VAL = [{ pid: 777, file: 'VALORANT-Win64-Shipping.exe' }];
    /* one hidden Spotify, started from the card; every relaunch gets a fresh fake page on the same port */
    async function setup(extra) {
      const port = await freePort();
      const fakes = [];
      const proc = fakeProc({ pids: [] });
      proc.P.memMB = 100;                                    // under the line: no trim in the way
      proc.P.visibleFn = () => { const f = fakes[fakes.length - 1]; return !!f && f.win.state !== 4; };
      proc.P.onLaunch = async () => { const f = createFakeSpotify(); f.onQuit = () => { proc.P.pids = []; }; fakes.push(f); setTimeout(() => f.start(port), 40); };
      const bb = bridge(port, Object.assign({ proc, hideVerifyMs: 5, trimDelayMs: 20, closeWaitMs: 300, watchOpts: { tickMs: 30 }, reviveOpts: { pollMs: 30, settleMs: 20 } }, extra || {}));
      const r = await bb.sp.start();
      return Object.assign(bb, { fakes, r, port, launches: () => proc.P.calls.filter((c) => Array.isArray(c) && c[0] === 'launch') });
    }
    const die = async (d, exit) => { d.proc.P.pids = []; d.proc.P.exit = exit || null; await d.fakes[d.fakes.length - 1].stop(); };

    // died during VALORANT -> the card says so -> started again ONCE, hidden and not playing, after it exits
    const d = await setup();
    ok(d.r.ok && d.r.hidden && d.sp.window().state === 'hidden' && d.launches().length === 1, 'setup: one hidden Spotify from the card ' + JSON.stringify(d.r));
    d.proc.P.games = VAL.slice();
    await die(d, { code: 1, at: Date.UTC(2026, 8, 28, 2, 47, 0) });
    ok(await until(() => d.sp.revive.view().state === 'waiting'), 'died during the game -> waiting for the game to exit ' + JSON.stringify(d.sp.revive.view()));
    const st = d.sp.last();
    ok(st.state === 'notrunning' && st.window === null && st.revive && st.revive.text === 'Spotify closed while VALORANT was running: something outside Spotify ended it.', 'the card is told why ' + JSON.stringify(st.revive));
    ok(st.revive.plan === 'Mantle starts it again, hidden, when VALORANT exits. Press play then.' && /Spotify closed while VALORANT was running/.test(st.reason), 'and what happens next ' + JSON.stringify(st));
    ok(d.logs.filter((l) => /^the hidden Spotify \(pid 4242\) closed while VALORANT was running at 2026-09-28T02:47:00\.000Z; it was ended from outside/.test(l)).length === 1, 'ONE log line with the time and exit code ' + JSON.stringify(d.logs.slice(-3)));
    await wait(150);
    ok(d.launches().length === 1, 'nothing is started while the game runs');
    d.proc.P.games = [];
    ok(await until(() => d.sp.revive.view().state === 'done'), 'the game exited -> started again ' + JSON.stringify(d.sp.revive.view()));
    const l2 = d.launches();
    ok(l2.length === 2 && l2[1][2].includes(FLAG) && HIDDEN_ARGS.every((a) => l2[1][2].includes(a)), 'the relaunch is the hidden start, with the port ' + JSON.stringify(l2[1]));
    ok(await until(() => d.sp.window() && d.sp.window().state === 'hidden' && d.sp.last().state === 'connected'), 'the new one is hidden and connected ' + JSON.stringify(d.sp.window()));
    ok(d.sp.window().source === 'after VALORANT exited', 'its source says why it was started');
    ok(!d.fakes[1].calls.some((c) => /^(play|resume|skip)/i.test(String(c[0]))), 'NOT playing: nothing was played, resumed or skipped ' + JSON.stringify(d.fakes[1].calls.map((c) => c[0])));
    ok(d.sp.last().revive.plan === 'Mantle started it again, hidden, after VALORANT exited. Press play to carry on.', 'the card says it was started again ' + JSON.stringify(d.sp.last().revive));
    ok(d.logs.filter((l) => /^started the hidden Spotify again after VALORANT exited \(it closed during the game\); it is not playing/.test(l)).length === 1, 'ONE log line for the relaunch');
    // never twice for one game session (the same game pids)
    d.proc.P.games = VAL.slice();
    await d.sp.revive.died({ pid: 1, exit: null });
    d.proc.P.games = [];                                 // (the relaunched one keeps running: the once-guard answers first)
    ok(await until(() => d.sp.revive.view().state === 'skipped'), 'the same game again -> not a second time ' + JSON.stringify(d.sp.revive.view()));
    ok(/already started again once for this VALORANT session/.test(d.sp.revive.view().plan) && d.launches().length === 2, 'said, and not launched ' + d.sp.revive.view().plan);
    d.sp.stop(); for (const f of d.fakes) await f.stop();

    // closed with no game running (they closed it themselves): said, never started again
    const n = await setup();
    await die(n, null);
    ok(await until(() => n.sp.revive.view().state === 'closed'), 'no game -> closed, not waiting ' + JSON.stringify(n.sp.revive.view()));
    ok(n.sp.last().revive.text === 'Spotify closed without being asked, and no game was running.' && /Start it from here/.test(n.sp.last().revive.plan), 'the card says it closed, no game ' + JSON.stringify(n.sp.last().revive));
    ok(n.logs.some((l) => /closed without being asked; no exit code was recorded; no game was running, so it is not started again/.test(l)), 'logged with no exit code');
    await wait(120);
    ok(n.launches().length === 1, 'no game -> never started again');
    n.sp.stop(); for (const f of n.fakes) await f.stop();

    // they quit it from the card during the game -> no restart after it
    const q = await setup();
    q.proc.P.games = VAL.slice();
    const qr = await q.sp.quit();
    ok(qr.ok && q.sp.last().state === 'notrunning', 'the card Quit closed it ' + JSON.stringify(qr));
    await wait(120);
    q.proc.P.games = [];
    await wait(120);
    ok(q.launches().length === 1 && q.sp.revive.view().state === 'idle' && !q.logs.some((l) => /closed while|started the hidden Spotify again/.test(l)), 'Quit from the card -> no death, no restart ' + JSON.stringify(q.sp.revive.view()));
    q.sp.stop(); for (const f of q.fakes) await f.stop();

    // the toggle is off -> said on the card, not started again
    const t = await setup({ reviveOn: () => false });
    t.proc.P.games = VAL.slice();
    await die(t, { code: 0, at: null });
    ok(await until(() => t.sp.revive.view().state === 'waiting'), 'toggle off: still noticed');
    ok(t.sp.last().revive.text === 'Spotify closed while VALORANT was running: it closed normally.' && t.sp.last().revive.plan === '“Restart Spotify after games” is off, so it stays closed.', 'toggle off: the card says it stays closed ' + JSON.stringify(t.sp.last().revive));
    t.proc.P.games = [];
    ok(await until(() => t.sp.revive.view().state === 'skipped'), 'toggle off: skipped after the game');
    ok(t.launches().length === 1 && t.logs.some((l) => /^Spotify was not started again after VALORANT exited: “Restart Spotify after games” is off/.test(l)), 'toggle off: not launched, one line');
    t.sp.stop(); for (const f of t.fakes) await f.stop();

    // the words, pure
    ok(words({ state: 'waiting', on: true, game: 'VALORANT', exit: { code: 0xC0000005 } }).head === 'Spotify closed while VALORANT was running: it crashed.', 'words: a crash code (no code on the card)');
    ok(words({ state: 'failed', on: true, game: 'VALORANT', why: 'Spotify did not start' }).plan === 'Mantle could not start it again: Spotify did not start.', 'words: a failed restart');
    ok(words({ state: 'closed', on: true, game: '', scanError: 'the sidecar is not running' }).head === 'Spotify closed without being asked. Mantle couldn’t tell whether a game was running.', 'words: the game list failed (the error is not on the card)');
    ok(words({ state: 'idle' }).head === '', 'words: nothing when idle');

    /* ------------------------------------------ spotgame lane: closed for a game, back after it */
    const noTrack = (logs) => !logs.some((l) => /Song \d|Artist \d|spotify:(track|playlist|album):/.test(l));
    const quitOf = (d) => d.fakes[0].quits;
    const byName = (d) => d.proc.P.calls.includes('close') || d.proc.P.calls.includes('kill');
    /* its port closes a moment after its own shutdown (as a real quit does), so a relaunch can have it */
    const stopsOnQuit = (d) => { const f = d.fakes[d.fakes.length - 1]; f.onQuit = () => { d.proc.P.pids = []; setTimeout(() => f.stop(), 20); }; };
    // not playing -> closed at once (Spotify's own shutdown, its pid only), then back hidden, not playing
    const c1 = await setup();
    c1.fakes[0].ps.paused = true;
    stopsOnQuit(c1);
    c1.proc.P.games = VAL.slice();
    const t0 = Date.now();
    const r1 = await c1.sp.gameRest({ on: true, why: 'VALORANT runs' });
    const closeMs = Date.now() - t0;
    ok(r1.ok && r1.action === 'closed' && r1.game === 'VALORANT' && !r1.dryRun, 'close: not playing -> closed ' + JSON.stringify(r1));
    ok(quitOf(c1) === 1 && !byName(c1), 'close: Spotify’s own shutdown; never taskkill by image name ' + JSON.stringify(c1.proc.P.calls.filter((x) => typeof x === 'string' && x !== 'running' && x !== 'visible')));
    ok(closeMs < 1000, `close: detection-to-closed ${closeMs} ms (fakes; poll step 25 ms)`);
    console.log(`  spotgame: detection-to-closed ${closeMs} ms (fake Spotify page + fake process list)`);
    const s1 = c1.sp.last();
    ok(s1.state === 'notrunning' && c1.sp.window() === null && s1.revive.state === 'waiting' && s1.revive.mine === true, 'close: the card says not running, a reopen waits ' + JSON.stringify(s1.revive));
    ok(s1.revive.text === 'Closed for VALORANT to save memory; it comes back when the game exits.' && s1.revive.plan === 'It comes back hidden and not playing: press play then.', 'close: the card’s words ' + JSON.stringify(s1.revive));
    ok(c1.logs.filter((l) => /^closed the hidden Spotify \(pid 4242\) for VALORANT in \d+ ms: nothing was playing \(Spotify: not playing, media session: unknown\); via Spotify’s own LifecycleAPI\.shutdown; it is started again/.test(l)).length === 1, 'close: ONE log line ' + JSON.stringify(c1.logs.slice(-3)));
    ok(!c1.logs.some((l) => /closed while VALORANT was running|closed without being asked/.test(l)), 'close: Mantle’s own close is not taken for a death');
    await wait(150);
    ok(c1.launches().length === 1, 'close: nothing is started while the game runs');
    c1.proc.P.games = [];
    await c1.sp.gameRest({ on: false, why: 'VALORANT exited' });
    ok(await until(() => c1.sp.revive.view().state === 'done'), 'reopen: after the game ' + JSON.stringify(c1.sp.revive.view()));
    const l1 = c1.launches();
    ok(l1.length === 2 && l1[1][2].includes(FLAG) && HIDDEN_ARGS.every((a) => l1[1][2].includes(a)), 'reopen: the hidden start, with the port ' + JSON.stringify(l1[1]));
    ok(await until(() => c1.sp.window() && c1.sp.window().state === 'hidden' && c1.sp.last().state === 'connected'), 'reopen: hidden and connected ' + JSON.stringify(c1.sp.window()));
    ok(!c1.fakes[1].calls.some((x) => /^(play|resume|skip)/i.test(String(x[0]))), 'reopen: NOT playing ' + JSON.stringify(c1.fakes[1].calls.map((x) => x[0])));
    ok(c1.sp.last().revive.text === 'Mantle closed Spotify for VALORANT to save memory.' && /started it again, hidden, after VALORANT exited/.test(c1.sp.last().revive.plan), 'reopen: the card says so ' + JSON.stringify(c1.sp.last().revive));
    ok(c1.logs.filter((l) => /^started the hidden Spotify again after VALORANT exited \(Mantle closed it for the game\); it is not playing/.test(l)).length === 1, 'reopen: ONE log line');
    ok(noTrack(c1.logs), 'logs: no track or artist names, no Spotify addresses');
    // once per game session: the same game again (its pid, plus a second game) -> left alone
    c1.proc.P.games = VAL.concat([{ pid: 900, file: 'cs2.exe' }]);
    const r1b = await c1.sp.gameRest({ on: true, why: 'VALORANT, cs2 runs' });
    ok(r1b.action === 'same' && c1.fakes[1].quits === 0, 'once per session: the same game session is not closed again ' + JSON.stringify(r1b));
    c1.proc.P.games = [{ pid: 901, file: 'cs2.exe' }];
    const r1c = await c1.sp.gameRest({ on: true, why: 'cs2 runs' });
    ok(r1c.action === 'closed' && r1c.game === 'cs2' && c1.fakes[1].quits === 1, 'a NEW game session is decided again ' + JSON.stringify(r1c));
    c1.sp.stop(); for (const f of c1.fakes) await f.stop();

    // music playing -> kept open, said on the card; the media session alone saying so keeps it too
    const c2 = await setup();
    c2.fakes[0].ps.paused = false;
    c2.proc.P.games = VAL.slice();
    const r2 = await c2.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r2.action === 'kept' && quitOf(c2) === 0 && c2.sp.last().state === 'connected' && c2.sp.window().state === 'hidden', 'keep: music playing -> not closed ' + JSON.stringify(r2));
    ok(c2.sp.last().revive.text === 'Kept open: music was playing when VALORANT started.', 'keep: the card says why ' + JSON.stringify(c2.sp.last().revive));
    ok(c2.logs.some((l) => /^Spotify was kept open for VALORANT: music was playing \(Spotify: playing, media session: unknown\)$/.test(l)), 'keep: one log line, states only');
    await c2.sp.gameRest({ on: false, why: 'VALORANT exited' });
    ok(c2.sp.revive.view().state === 'idle' && c2.launches().length === 1, 'keep: the words go when the game exits; nothing started');
    c2.sp.stop(); for (const f of c2.fakes) await f.stop();
    const c2m = await setup({ mediaPlaying: () => true });
    c2m.fakes[0].ps.paused = true;
    c2m.proc.P.games = VAL.slice();
    const r2m = await c2m.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r2m.action === 'kept' && quitOf(c2m) === 0 && /media session: playing/.test(c2m.logs.join('\n')), 'keep: the media session says Spotify plays -> kept ' + JSON.stringify(r2m));
    c2m.sp.stop(); for (const f of c2m.fakes) await f.stop();

    // the play state cannot be read -> kept, and said
    const c3 = await setup();
    c3.proc.P.games = VAL.slice();
    await c3.fakes[0].stop();                              // its page is gone; the process still runs
    const r3 = await c3.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r3.action === 'kept' && quitOf(c3) === 0 && !c3.proc.P.calls.some((x) => Array.isArray(x) && x[0] === 'closePid') && !byName(c3), 'unknown: nothing closed ' + JSON.stringify(r3));
    ok(/^Kept open: Mantle couldn’t tell whether music was playing when VALORANT started\.$/.test(c3.sp.revive.view().text), 'unknown: the card says why ' + c3.sp.revive.view().text);
    c3.sp.stop();

    // The user starts Spotify themselves during the game -> the pending reopen is dropped
    const c4 = await setup();
    c4.fakes[0].ps.paused = true;
    stopsOnQuit(c4);
    c4.proc.P.games = VAL.slice();
    ok((await c4.sp.gameRest({ on: true, why: 'VALORANT runs' })).action === 'closed', 'cancel: closed first');
    const st4 = await c4.sp.start();
    ok(st4.ok && c4.sp.revive.view().state === 'idle' && c4.logs.some((l) => /no restart after the game is pending any more: Spotify was started from the card/.test(l)), 'cancel: their Start drops the reopen ' + JSON.stringify(c4.sp.revive.view()));
    c4.proc.P.games = [];
    await c4.sp.gameRest({ on: false, why: 'VALORANT exited' });
    await wait(150);
    ok(c4.launches().length === 2 && !c4.logs.some((l) => /started the hidden Spotify again/.test(l)), 'cancel: only their start; no reopen ' + c4.launches().length);
    c4.sp.stop(); for (const f of c4.fakes) await f.stop();

    // the toggle off -> nothing at all
    const c5 = await setup({ closeForGames: () => false });
    c5.fakes[0].ps.paused = true;
    c5.proc.P.games = VAL.slice();
    const r5 = await c5.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r5.action === 'off' && quitOf(c5) === 0 && c5.sp.revive.view().state === 'idle' && c5.sp.last().state === 'connected', 'toggle off: nothing closed, nothing said on the card ' + JSON.stringify(r5));
    ok(c5.sp.last().revive.closeOn === false && c5.logs.some((l) => /“Close Spotify while I game” is off, so Spotify is left alone/.test(l)), 'toggle off: the card’s box reads off; one log line');
    c5.sp.stop(); for (const f of c5.fakes) await f.stop();

    // "Restart Spotify after games" off: Mantle closed it itself, so Mantle still brings it back
    const c6 = await setup({ reviveOn: () => false });
    c6.fakes[0].ps.paused = true;
    stopsOnQuit(c6);
    c6.proc.P.games = VAL.slice();
    await c6.sp.gameRest({ on: true, why: 'VALORANT runs' });
    c6.proc.P.games = [];
    ok(await until(() => c6.sp.revive.view().state === 'done') && c6.launches().length === 2, 'revive toggle off: Mantle’s own close still comes back ' + JSON.stringify(c6.sp.revive.view()));
    c6.sp.stop(); for (const f of c6.fakes) await f.stop();

    // the close fails (Spotify ignores its shutdown and the WM_CLOSE) -> the card says why; never forced
    const c7 = await setup();
    c7.fakes[0].ps.paused = true;
    c7.fakes[0].onQuit = () => {};                          // it does not quit
    c7.proc.P.closePidWorks = false;
    c7.proc.P.games = VAL.slice();
    const r7 = await c7.sp.gameRest({ on: true, why: 'VALORANT runs' });
    const cp7 = c7.proc.P.calls.filter((x) => Array.isArray(x) && x[0] === 'closePid');
    ok(r7.action === 'failed' && cp7.length === 1 && cp7[0][1] === 4242 && !byName(c7), 'fail: its pid asked once, never by image name, never forced ' + JSON.stringify(cp7));
    ok(c7.sp.revive.view().state === 'closefailed' && c7.sp.revive.view().text === 'Mantle could not close Spotify for VALORANT: it ignored its own quit and a close request.' && c7.sp.revive.view().plan === 'It stays open.', 'fail: the card says why ' + c7.sp.revive.view().text);
    ok(c7.logs.some((l) => /^Spotify \(pid 4242\) could NOT be closed for VALORANT \(\d+ ms\): it is still running after Spotify did not quit by itself, so Windows asked pid 4242 to close \(taskkill \/PID \/T without \/F: no window answered\), and Mantle does not force it closed$/.test(l)) && c7.sp.window() && c7.sp.window().state === 'hidden', 'fail: logged; its window state kept');
    c7.sp.stop(); for (const f of c7.fakes) await f.stop();

    // a SHOWING Mantle Spotify counts too; a Spotify Mantle did not start is left alone; none running: nothing
    const c8 = await setup();
    c8.fakes[0].ps.paused = true;
    await c8.sp.openWindow();
    ok(c8.sp.window().state === 'shown', 'shown: its window is showing ' + JSON.stringify(c8.sp.window()));
    c8.proc.P.games = VAL.slice();
    const r8 = await c8.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r8.action === 'closed' && c8.logs.some((l) => /^closed the showing Spotify \(pid 4242\) for VALORANT/.test(l)), 'shown: closed too ' + JSON.stringify(r8));
    c8.sp.stop(); for (const f of c8.fakes) await f.stop();
    const p9 = fakeProc({ pids: [999] }); p9.P.games = VAL.slice();
    const b9 = bridge(await freePort(), { proc: p9 });
    const r9 = await b9.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r9.action === 'kept' && !p9.P.calls.some((x) => Array.isArray(x) && x[0] === 'closePid') && !p9.P.calls.includes('close') && /not started by Mantle/.test(b9.sp.revive.view().text), 'not Mantle’s: left alone, said ' + JSON.stringify(r9));
    b9.sp.stop();
    const p10 = fakeProc({ pids: [] }); p10.P.games = VAL.slice();
    const b10 = bridge(await freePort(), { proc: p10 });
    const r10 = await b10.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r10.action === 'notrunning' && b10.sp.revive.view().state === 'idle', 'not running: nothing to close, nothing on the card ' + JSON.stringify(r10));
    // game mode on by hand, no known game: nothing
    p10.P.games = [];
    ok((await b10.sp.gameRest({ on: true, why: 'game mode is on (by hand)' })).action === 'nogame', 'no known game: nothing');
    b10.sp.stop();

    // --test (dryRun): the real Spotify is never closed
    const p11 = fakeProc({ pids: [4242] }); p11.P.games = VAL.slice();
    const b11 = bridge(await freePort(), { proc: p11, dryRun: true });
    const r11 = await b11.sp.gameRest({ on: true, why: 'VALORANT runs' });
    ok(r11.action !== 'closed' || r11.dryRun, 'dry run: never a real close ' + JSON.stringify(r11));
    ok(!p11.P.calls.some((x) => Array.isArray(x) && x[0] === 'closePid') && !p11.P.calls.includes('close') && !p11.P.calls.includes('kill'), 'dry run: no close call at all');
    b11.sp.stop();
    ok(words({ state: 'waiting', mine: true, game: 'VALORANT', dryRun: true }).head === 'Closed for VALORANT to save memory; it comes back when the game exits (dry run: nothing was closed).', 'words: a dry-run close');

    /* Up next after a start whose page is still LOADING (2026-09-27: 1 React node for ~3 min): said as
       loading (not "a Spotify update moved them"), then hidden and connected once it has loaded. */
    const pl = await freePort();
    const FL = createFakeSpotify({ internals: 'loading' });
    const prl = fakeProc({ pids: [] });
    prl.P.memMB = 100;
    prl.P.visibleFn = () => FL.win.state !== 4;
    prl.P.onLaunch = async () => { setTimeout(() => FL.start(pl), 40); };
    const bl = bridge(pl, { proc: prl, hideVerifyMs: 5, trimDelayMs: 60000, startWaitMs: 400, loadWaitMs: 4000, loadPollMs: 30 });
    const rl = await bl.sp.start();
    ok(rl.ok && rl.loading && /^Spotify is still loading\. Mantle hides it and connects once it has loaded$/.test(rl.note || ''), 'a loading page: start says so ' + JSON.stringify(rl));
    ok(bl.sp.last().state === 'loading' && !bl.statuses.some((s) => s.state === 'internals') && !bl.logs.some((l) => /update probably moved/.test(l)), 'said as loading, never as moved internals ' + JSON.stringify(bl.sp.last()));
    FL.opts.internals = true; FL.reload();
    ok(await until(() => bl.sp.last().state === 'connected' && bl.sp.window() && bl.sp.window().state === 'hidden'), 'once loaded: hidden and connected ' + JSON.stringify(bl.sp.window()));
    ok(bl.logs.some((l) => /^Spotify’s page finished loading \(pid 4242/.test(l)), 'the late load is logged');
    bl.sp.stop(); await FL.stop();
  }

  /* ------------------------------------------------ secreview-sp lane (2026-09-27): a hostile port / page */
  {
    // a debugging port whose page only MENTIONS spotify (a browser on 47292 with such a tab) is never driven
    const FE = createFakeSpotify({ pageUrl: 'https://evil.example/spotify-lyrics?x=1' });
    const pe = await FE.start();
    const be = bridge(pe);
    const se = await be.sp.status();
    const sq = await be.sp.searchAll({ q: 'my private search' });
    ok(se.state === 'portbusy' && !sq.ok && FE.evals === 0 && !FE.calls.some((c) => c[0] === 'upgrade'), 'a page that is not https://xpui.app.spotify.com/ is never connected to or evaluated in ' + JSON.stringify(se).slice(0, 200));
    be.sp.stop(); await FE.stop();

    // a page answering whatever it likes: lists and strings are bounded HERE, not trusted to PAGE()
    const BIG = 'N'.repeat(1024 * 1024);
    const many = (n, k) => Array.from({ length: n }, (_, i) => ({ uri: 'spotify:track:' + String(i).padStart(22, 'B'), uid: 'u' + i, name: i < 3 ? BIG : 'n' + i, artists: i < 3 ? BIG : 'a', provider: 'queue', image: 'https://i.scdn.co/image/' + k + i.toString(16).padStart(40, '0') }));
    const FH = createFakeSpotify({ hostile: (op) => {
      if (op === 'queue') return { ok: true, caps: { remove: true, move: true, skipTo: true }, current: { uri: 'spotify:track:' + 'C'.repeat(22), name: { toString: 1 }, image: 'file://evil-host/share/a.png' },
        queued: many(3000, 'a').concat([{ uri: 'spotify:track:' + 'D'.repeat(22), uid: 'd', name: 'unc', image: 'file://evil-host/share/b.png' }]), nextUp: many(2000, 'b'), totalQueued: 'lots', totalNextUp: 2000 };
      if (op === 'searchall') return { ok: true, tracks: many(4000, 'c').map((x) => ({ uri: x.uri, name: x.name, sub: x.artists, image: x.image })), artists: [], albums: [], playlists: [{ uri: 'spotify:playlist:' + 'P'.repeat(22), name: 'pl', sub: 's', image: 'file:///C:/Windows/win.ini' }] };
      if (op === 'library') return { ok: true, items: many(5000, 'd').map((x) => ({ uri: 'spotify:album:' + x.uri.slice(-22), name: x.name, owner: x.artists, image: x.image })), total: 5000 };
      return undefined;
    } });
    const ph = await FH.start();
    const bh2 = bridge(ph);
    await bh2.sp.status();
    const q = await bh2.sp.queue();
    const longest = (arr, k) => Math.max(0, ...arr.map((x) => String(x[k]).length));
    ok(q.ok && q.queued.length <= 50 && q.nextUp.length <= 20, `a hostile queue is cut to 50 + 20 rows (${q.queued && q.queued.length} + ${q.nextUp && q.nextUp.length})`);
    ok(bh2.fetched.length <= 71, `one queue read fetches at most 71 artworks: 50 + 20 rows and the playing song (${bh2.fetched.length})`);
    ok(longest(q.queued, 'name') <= 200 && longest(q.queued, 'artists') <= 200 && typeof q.current.name === 'string', `names reach the card at most 200 characters (${longest(q.queued, 'name')})`);
    ok(!('currentImage' in q) && q.queued.concat(q.nextUp, [q.current]).every((x) => !x.image || /^data:image\//.test(x.image)), 'no image address from the page reaches the card: only data: art (current: ' + String(q.current.image).slice(0, 60) + ')');
    ok(typeof q.totalQueued === 'number', 'counts are numbers: ' + q.totalQueued);
    bh2.fetched.length = 0;
    const s = await bh2.sp.searchAll({ q: 'x' });
    ok(s.ok && s.tracks && s.tracks.length <= 5 && longest(s.tracks, 'sub') <= 200 && bh2.fetched.length <= 20, `a hostile search is cut to 5 per kind, 200 characters (${s.tracks && s.tracks.length}, ${s.tracks && longest(s.tracks, 'sub')}, ${bh2.fetched.length} fetches)`);
    ok(s.playlists[0] && s.playlists[0].image === null, 'a file:/// artwork address is never passed on');
    bh2.fetched.length = 0;
    const lib = await bh2.sp.library();
    ok(lib.ok && lib.items && lib.items.length <= 60 && longest(lib.items, 'owner') <= 200 && bh2.fetched.length <= 60, `a hostile library is cut to 60 rows (${lib.items && lib.items.length}, ${bh2.fetched.length} fetches)`);
    bh2.sp.stop(); await FH.stop();

    // privacy: what the user plays is not written to the log (a local file's address carries its tags)
    const local = 'spotify:local:Secret+Artist:Private+Album:Diary+Entry+Song:200';
    const FP = createFakeSpotify();
    FP.q.queued.push(require('./_spotify-fakecdp.js').track(50, { uri: local, uid: 'loc1', name: 'Diary Entry Song', provider: 'queue' }));
    const pp = await FP.start();
    const bp2 = bridge(pp);
    await bp2.sp.status();
    const r1 = await bp2.sp.play({ uri: local, uid: 'loc1' });
    const r2 = await bp2.sp.playUri({ uri: 'spotify:playlist:' + 'L'.repeat(22) });
    const r3 = await bp2.sp.add({ uri: uri(7) });
    ok(r1.ok && r2.ok && r3.ok, 'the plays and the add went through');
    ok(bp2.logs.length && !bp2.logs.some((l) => /spotify:(local|playlist|track|episode|album|artist)|Diary|Secret/.test(l)), 'no log line names what was played or added: ' + bp2.logs.filter((l) => /spotify:/.test(l)).join(' | '));
    ok(bp2.logs.some((l) => /^play a local file via /.test(l)) && bp2.logs.some((l) => /^play a playlist: playing it/.test(l)) && bp2.logs.some((l) => /^added a song/.test(l)), 'the log still says what KIND was played, and how it went');
    bp2.sp.stop(); await FP.stop();
  }

  b.sp.stop();
  await F.stop();
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY-APP ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY-APP ${pass} passed, ${fail + 1} failed`); process.exit(1); });
