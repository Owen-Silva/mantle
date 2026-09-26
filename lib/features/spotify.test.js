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
  ok(verbs === 'add,move,play,queue,remove,restart,search,start,status', 'commands: ' + verbs);
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
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SPOTIFY ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`SPOTIFY ${pass} passed, ${fail + 1} failed`); process.exit(1); });
