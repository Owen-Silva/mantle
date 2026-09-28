/* spotify.test.js - lib/features/spotify.js, the seam: its commands, the status push and replay,
 * the tray switch, and --test's dry runs, against a FAKE Spotify debugging port on 127.0.0.1
 * (./_spotify-fakecdp.js). The bridge itself is covered by spotify-app.test.js. Nothing here touches
 * the real Spotify.
 *   node lib/features/spotify.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const feature = require('./spotify.js');
const { createFakeSpotify, fakeFetch, fakeProc, uri } = require('./_spotify-fakecdp.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }

function fakeCtx({ test = true } = {}) {
  const c = {
    commands: {}, logs: [], healths: [], pushes: [], replays: {}, on: true,
    flags: Object.freeze({ test, live: !test }),
    log(t) { c.logs.push(t); },
    command(verb, fn) { c.commands[verb] = fn; return 'spotify.' + verb; },
    health(okv, why) { c.healths.push([okv, why]); },
    broadcast(ev, p) { c.pushes.push([ev, p]); },
    replay(ev, fn) { c.replays[ev] = fn; },
    enabled() { return c.on; },
    onEnabled(fn) { c.flip = fn; },
    settings: { file: path.join(os.tmpdir(), 'spq-none', 'features', 'spotify.json'), get(k, d) { return d; }, set() {} },
  };
  return c;
}
const FAST = { verifyDelayMs: 5, stepDelayMs: 2, pollMs: 25, closeWaitMs: 200, startWaitMs: 800, httpTimeoutMs: 800, openTimeoutMs: 800, evalTimeoutMs: 1500 };

(async () => {
  ok(feature.name === 'spotify' && feature.defaultOn === true && typeof feature.install === 'function', 'feature shape');
  const src = fs.readFileSync(path.join(__dirname, 'spotify.js'), 'utf8');
  ok(!/_spotify-api|clientId|openDashboard|copyRedirect/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'the Web API path is gone from the seam (no Client ID, dashboard or redirect)');
  ok(!fs.existsSync(path.join(__dirname, '_spotify-api.js')), '_spotify-api.js is deleted');

  const F = createFakeSpotify();
  const port = await F.start();
  const proc = fakeProc({ pids: [11] });
  const ctx = fakeCtx();
  const inst = feature._install(ctx, { options: Object.assign({ port, proc, fetch: fakeFetch(), exe: 'C:\\fake\\Spotify.exe' }, FAST) });

  const verbs = Object.keys(ctx.commands).sort().join();
  ok(verbs === 'add,gameclose,hideWindow,info,library,move,openWindow,play,playUri,queue,quit,remove,repeat,restart,revive,search,searchAll,shuffle,start,status', 'commands: ' + verbs);
  ok(ctx.healths.length === 1 && ctx.healths[0][0] === true, 'healthy on install');
  ok(ctx.replays['spotify.status']().state === 'checking', 'replay before any probe: "checking" (sync, never a promise)');

  const st = await ctx.commands.status();
  ok(st.state === 'connected', 'status connected ' + JSON.stringify(st));
  ok(ctx.pushes.some(([ev, p]) => ev === 'spotify.status' && p.state === 'connected'), 'the change is pushed on spotify.status');
  ok(ctx.replays['spotify.status']().state === 'connected', 'replay gives the last state');

  const q = await ctx.commands.queue();
  ok(q.ok && q.queued.length === 2 && q.nextUp.length === 3, 'queue through the seam');
  const p = await ctx.commands.play({ uri: uri(10), uid: 'u10' });
  ok(p.ok && p.verified, 'play through the seam ' + JSON.stringify(p));
  const a = await ctx.commands.add({ uri: uri(77) });
  ok(a.ok, 'add through the seam');
  const bad = await ctx.commands.add({ uri: '"); alert(1); ("' });
  ok(!bad.ok && /not a Spotify song/.test(bad.reason), 'a bad uri is refused with a reason');
  const none = await ctx.commands.move(null);
  ok(!none.ok && typeof none.reason === 'string', 'a missing argument answers a reason, never throws');

  // --test: start/restart are dry runs even with a real process layer
  const r = await ctx.commands.restart();
  ok(r.ok && r.dryRun && /dry run/.test(r.reason), 'restart in --test is a dry run ' + JSON.stringify(r));
  ok(!proc.P.calls.some((c) => Array.isArray(c) || c === 'close' || c === 'kill'), 'no process was closed or launched in --test');

  // the tray switch
  ctx.on = false;
  ctx.flip(false);
  ok(ctx.pushes[ctx.pushes.length - 1][1].state === 'off', 'switched off -> "off" pushed');
  const offq = await ctx.commands.queue();
  ok(!offq.ok && offq.state === 'off' && /tray menu/.test(offq.reason), 'commands while off say why');
  ok(ctx.replays['spotify.status']().state === 'off', 'replay while off');
  ctx.on = true; ctx.flip(true);
  const back = await ctx.commands.status();
  ok(back.state === 'connected', 'back on: reconnects');

  // a bridge that throws is caught and said
  const ctx2 = fakeCtx();
  feature._install(ctx2, { options: { port, proc: { exists() { throw new Error('disk gone'); }, running: async () => [] } } });
  F.stop();
  await new Promise((res) => setTimeout(res, 50));
  const thrown = await ctx2.commands.start();
  ok(!thrown.ok && /start failed inside Mantle: disk gone/.test(thrown.reason), 'a throw inside the bridge becomes a reason ' + JSON.stringify(thrown));

  // live mode ignores the test port override
  process.env.MANTLE_SPOTIFY_APP_PORT = '1234';
  const ctx3 = fakeCtx({ test: false });
  const i3 = feature._install(ctx3, { options: { proc: fakeProc() } });
  ok(i3._sp.port === 47292 && ctx3.logs.some((l) => /ignored outside --test/.test(l)), 'MANTLE_SPOTIFY_APP_PORT is ignored in a live run');
  delete process.env.MANTLE_SPOTIFY_APP_PORT;

  inst.stop(); i3.stop();
  /* spothide lane: a pin or launcher start (launchBus 'launched') is hidden by the feature's bridge */
  {
    const { EventEmitter } = require('events');
    const bus = new EventEmitter();
    const FB = createFakeSpotify();
    const pb = await FB.start();
    const pr = fakeProc({ pids: [321] });
    pr.P.visibleFn = () => FB.win.state !== 4;
    const cb = fakeCtx();
    const ib = feature._install(cb, { bus, options: Object.assign({ port: pb, proc: pr, fetch: fakeFetch(), exe: 'C:\\fake\\Spotify.exe', hideVerifyMs: 5, trimDelayMs: 60000 }, FAST) });
    ok(bus.listenerCount('launched') === 1, 'the feature listens on the launch bus');
    bus.emit('launched', { pid: 321, source: 'the pinned icon' });
    for (let i = 0; i < 60 && !(ib._sp.window() && ib._sp.window().state === 'hidden'); i++) await new Promise((r) => setTimeout(r, 25));
    ok(ib._sp.window() && ib._sp.window().state === 'hidden' && FB.win.state === 4, 'a pinned-icon start is hidden by the feature ' + JSON.stringify(ib._sp.window()));
    ok(cb.pushes.some(([ev, p]) => ev === 'spotify.status' && p.window && p.window.state === 'hidden'), 'and the card hears it');
    const r = await cb.commands.info({});
    ok(r.ok && r.window.state === 'hidden' && r.memory && r.memory.privateWsMB === 210, 'spotify.info answers through the seam ' + JSON.stringify(r).slice(0, 160));
    cb.on = false;
    const before = FB.calls.length;
    bus.emit('launched', { pid: 322, source: 'the launcher' });
    await new Promise((r2) => setTimeout(r2, 50));
    ok(FB.calls.length === before && cb.logs.some((l) => /was not hidden: the Spotify queue is off/.test(l)), 'with the feature off, a launch is only logged');
    /* sptrim lane: the memory watch follows the tray switch, and its line is the feature setting */
    cb.on = true;
    ok(ib._sp.window().watch && ib._sp.window().watch.state === 'watching' && ib._sp.window().watch.aboveMB === 400, 'hidden -> the memory watch runs, over 300 MB by default ' + JSON.stringify(ib._sp.window().watch));
    cb.flip(false);
    ok(ib._sp.window().watch.state === 'stopped' && cb.logs.some((l) => /stopped watching the hidden Spotify’s memory: the Spotify queue was turned off/.test(l)), 'tray switch off -> the watch stops, said');
    cb.flip(true);
    ok(ib._sp.window().watch.state === 'watching', 'tray switch on while hidden -> watching again');
    ib.stop();
    ok(ib._sp.window().watch.state === 'stopped', 'stop() stops the watch');
    const cs = fakeCtx();
    cs.settings.get = (k, d) => (k === 'trimAboveMB' ? 200 : d);
    const is = feature._install(cs, { bus: new EventEmitter(), options: Object.assign({ port: pb, proc: fakeProc({ pids: [9] }), fetch: fakeFetch(), exe: 'C:\\fake\\Spotify.exe', trimDelayMs: 60000 }, FAST) });
    is._sp.watch.start(9);
    ok(is._sp.watch.view().aboveMB === 200, 'the setting trimAboveMB moves the line (200 MB)');
    is.stop();
    ok(bus.listenerCount('launched') === 0, 'stop() leaves the bus');
    await FB.stop();
  }

  /* spadopt lane: on install, the hidden Spotify an earlier Mantle started is taken over (live),
     only said in --test, and not looked for while the feature is off (then looked for on the switch) */
  {
    const { EventEmitter } = require('events');
    const EXE = 'C:\\fake\\Spotify.exe';
    const mk = () => {
      const p = fakeProc({ pids: [4321], created: String((BigInt(Date.now() - 5 * 60000) + 11644473600000n) * 10000n) });
      p.P.list = [{ pid: 4321, ppid: 999, exe: EXE, cmd: `"${EXE}" --remote-debugging-port=47292 --minimized --disable-gpu`, createdMs: Date.now() - 5 * 60000 }];
      return p;
    };
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const pl = mk(), cl = fakeCtx({ test: false });
    const il = feature._install(cl, { bus: new EventEmitter(), options: Object.assign({ proc: pl, fetch: fakeFetch(), exe: EXE, trimDelayMs: 60000 }, FAST) });
    await settle();
    ok(il._sp.window() && il._sp.window().adopted && il._sp.window().state === 'hidden' && il._sp.window().watch.state === 'watching', 'live install takes over the hidden Spotify ' + JSON.stringify(il._sp.window()));
    ok(cl.logs.some((l) => /^took over the hidden Spotify an earlier Mantle started \(pid 4321, running for 5 min\); trimming it over 400 MB$/.test(l)), 'and logs it once');
    ok(cl.pushes.some(([ev, s]) => ev === 'spotify.status' && s.window && s.window.adopted), 'and pushes it to the card');
    il.stop();
    const pt = mk(), ct = fakeCtx({ test: true });
    const it = feature._install(ct, { bus: new EventEmitter(), options: Object.assign({ proc: pt, fetch: fakeFetch(), exe: EXE, trimDelayMs: 60000 }, FAST) });
    await settle();
    ok(it._sp.window() === null && ct.logs.some((l) => /^dry run: would take over .*pid 4321/.test(l)) && !pt.P.calls.some((c) => Array.isArray(c) && c[0] === 'trimTree'), '--test: said, never taken over');
    it.stop();
    const po = mk(), co = fakeCtx({ test: false });
    co.on = false;
    const io = feature._install(co, { bus: new EventEmitter(), options: Object.assign({ proc: po, fetch: fakeFetch(), exe: EXE, trimDelayMs: 60000 }, FAST) });
    await settle();
    ok(!po.P.listCalls && io._sp.window() === null, 'feature off at install: not looked for');
    co.on = true; co.flip(true);
    await settle();
    ok(po.P.listCalls === 1 && io._sp.window() && io._sp.window().adopted, 'switched on: taken over then');
    io.stop();
  }
  /* spotdeath lane: the card's "Restart Spotify after games" toggle (on unless turned off; saved) */
  {
    const { EventEmitter } = require('events');
    const EXE = 'C:\\fake\\Spotify.exe';
    const store = {};
    const ct = fakeCtx({ test: true });
    ct.settings = { file: '', get(k, d) { return k in store ? store[k] : d; }, set(k, v) { store[k] = v; } };
    const pt = fakeProc({ pids: [] });
    const it = feature._install(ct, { bus: new EventEmitter(), options: Object.assign({ proc: pt, fetch: fakeFetch(), exe: EXE, port: 1 }, FAST) });
    ok(it._sp.revive.view().on === true, 'restart after games: on by default');
    const r1 = await ct.commands.revive({ on: false });
    ok(r1.ok && r1.on === false && store.reviveAfterGames === false && it._sp.revive.view().on === false, 'the toggle turns it off and saves it ' + JSON.stringify(r1));
    ok(ct.logs.some((l) => /Restart Spotify after games: off \(from the card\)/.test(l)), 'the toggle is logged');
    ok(ct.pushes.some(([ev, p]) => ev === 'spotify.status' && p.revive && p.revive.on === false), 'the card is told at once');
    await ct.commands.revive({ on: true });
    ok(store.reviveAfterGames === true && it._sp.revive.view().on === true, 'and back on');
    ct.on = false;
    const r2 = await ct.commands.revive({ on: false });
    ok(!r2.ok && r2.state === 'off' && store.reviveAfterGames === true, 'feature off: the toggle answers off and saves nothing');
    it.stop();
  }
  /* spotgame lane: "Close Spotify while I game" (on unless turned off; saved), wired to Mantle's rest */
  {
    const { EventEmitter } = require('events');
    const store = {};
    const ct = fakeCtx({ test: true });
    ct.settings = { file: '', get(k, d) { return k in store ? store[k] : d; }, set(k, v) { store[k] = v; } };
    let restFn = null;
    ct.onRest = (fn) => { restFn = fn; return () => { restFn = null; }; };
    const pt = fakeProc({ pids: [] });
    pt.P.games = [{ pid: 777, file: 'VALORANT-Win64-Shipping.exe' }];
    const it = feature._install(ct, { bus: new EventEmitter(), options: Object.assign({ proc: pt, fetch: fakeFetch(), exe: 'C:\\fake\\Spotify.exe', port: 1 }, FAST) });
    ok(typeof restFn === 'function' && it._sp.revive.view().closeOn === true, 'close for games: on by default, and it listens to the rest');
    restFn({ on: true, why: 'VALORANT runs' });
    const until = async (fn) => { const end = Date.now() + 2000; while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 10)); return fn(); };
    ok(await until(() => ct.logs.some((l) => /^VALORANT started: Spotify is not running, so there is nothing to close$/.test(l))), 'a game start reaches the Spotify bridge ' + JSON.stringify(ct.logs.slice(-2)));
    const r1 = await ct.commands.gameclose({ on: false });
    ok(r1.ok && r1.on === false && store.closeForGames === false && it._sp.revive.view().closeOn === false, 'the toggle turns it off and saves it ' + JSON.stringify(r1));
    ok(ct.logs.some((l) => /Close Spotify while I game: off \(from the card\)/.test(l)), 'the toggle is logged');
    ok(ct.pushes.some(([ev, p]) => ev === 'spotify.status' && p.revive && p.revive.closeOn === false), 'the card is told at once');
    restFn({ on: true, why: 'cs2 runs' });
    ok(await until(() => ct.logs.some((l) => /a game started \(cs2 runs\): “Close Spotify while I game” is off, so Spotify is left alone/.test(l))), 'off: a game start leaves Spotify alone, said once');
    ct.on = false;
    const r2 = await ct.commands.gameclose({ on: true });
    ok(!r2.ok && r2.state === 'off' && store.closeForGames === false, 'feature off: the toggle answers off and saves nothing');
    it.stop();
    ok(restFn === null, 'stop() lets go of the rest');
    // the media session's word on Spotify (pure)
    const mp = feature._mediaPlaying;
    ok(mp(null) === null && mp({ ok: false, reason: 'x' }) === null, 'media: nothing read -> unknown');
    ok(mp({ ok: true, sessions: [{ aumid: 'Chrome', playing: true }] }) === false, 'media: another app playing is not Spotify playing');
    ok(mp({ ok: true, sessions: [{ aumid: 'Spotify.exe', status: 'Paused', playing: false }] }) === false, 'media: Spotify paused -> false');
    ok(mp({ ok: true, sessions: [{ aumid: 'Spotify.exe', status: 'Playing', playing: true }] }) === true, 'media: Spotify playing -> true');
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY ${pass} passed, ${fail + 1} failed`); process.exit(1); });
