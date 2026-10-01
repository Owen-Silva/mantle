/* autopause-compat.test.js - the bridge-compatible HTTP API (./_autopause-compat.js), r5-autopause lane,
 * 2026-09-30. Served on FREE test ports against a fake Spotify and the real rules engine: the exact
 * calls Quartz (owen-browser) and the Opera GX extension (browser) make, plus the safety fences.
 * Never binds 8787-8790 and never touches the real Spotify.
 *   node lib/features/autopause-compat.test.js
 */
'use strict';
const http = require('http');
const { createCompat, originOk, hostOk, srcKey } = require('./_autopause-compat.js');
const { createEngine } = require('./_autopause-core.js');
const coexist = require('./_autopause-coexist.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
const J = (x) => JSON.stringify(x);
function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function req(port, method, path, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}) }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { j = null; } resolve({ code: res.statusCode, j, h: res.headers }); });
    });
    r.on('error', (e) => resolve({ code: 0, err: e.code }));
    if (o.body) r.write(o.body);
    r.end();
  });
}

(async () => {
  ok(srcKey(new URLSearchParams('src=owen-browser')) === 'owen-browser' && srcKey(new URLSearchParams('src=<x>')) === 'browser' && srcKey(new URLSearchParams('')) === 'browser', 'src: valid kept, invalid and missing = browser (the bridge rule)');
  ok(originOk(undefined) && originOk('chrome-extension://abc') && !originOk('https://evil.example') && !originOk('null'), 'origin fence: none or an extension only');
  ok(hostOk('127.0.0.1:8787', 8787) && hostOk('localhost:8787', 8787) && !hostOk('evil.example:8787', 8787), 'host fence: no DNS rebinding');

  const sp = { state: 'playing', cmds: [] };
  const adapter = { state: () => sp.state, pause: async () => { sp.cmds.push('pause'); sp.state = 'paused'; return { ok: true }; }, play: async () => { sp.cmds.push('play'); sp.state = 'playing'; return { ok: true }; } };
  let t = 1000;
  const engine = createEngine({ spotify: adapter, now: () => t });
  const controls = [];
  const media = { ok: true, shown: { aumid: 'Spotify.exe', title: 'Song', artist: 'Artist', album: 'Album', status: 'paused', playing: false,
    can: { next: true, previous: true, toggle: true }, timeline: { available: true, positionMs: 61000, durationMs: 200000 }, artKey: 'k1', art: 'data:image/jpeg;base64,QUJD' }, sessions: [] };
  const p1 = await freePort(), p2 = await freePort();
  const logs = [];
  const compat = createCompat({ engine, spotify: () => ({ found: true, state: sp.state, aumid: 'Spotify.exe' }), media: () => media,
    control: async (c) => { controls.push(c); return { ok: true }; }, log: (x) => logs.push(x), now: () => t, ports: [p1, p2] });
  const got = await compat.start();
  ok(got === p1 && compat.running(), `starts on the first free port (${got})`);

  // The Opera extension's /ping and the coexistence probe: answers as the bridge, says it is Mantle.
  const ping = await req(p1, 'GET', '/ping');
  ok(ping.code === 200 && ping.j.ok === true && ping.j.app === 'spotify-autopause' && ping.j.server === 'mantle' && ping.j.port === p1, `/ping bridge shape + server:mantle (${J(ping.j && { app: ping.j.app, server: ping.j.server })})`);
  const probe = await coexist.check({ readFile: (f, cb) => { const e = new Error('x'); e.code = 'ENOENT'; cb(e); }, ports: [p1] });
  ok(!probe.inCharge, 'the coexistence probe does not mistake this server for the helper');

  // Quartz: /pause?src=owen-browser pauses Spotify; the extension's hold is separate; the last /resume resumes.
  const a = await req(p1, 'GET', '/pause?src=owen-browser');
  ok(a.j.action === 'paused' && sp.state === 'paused' && J(a.j.holds) === J(['owen-browser']), `Quartz hold pauses Spotify (${a.j.action}, ${J(a.j.holds)})`);
  const b = await req(p1, 'GET', '/pause?src=browser', { headers: { Origin: 'chrome-extension://operagx' } });
  ok(b.j.action === 'refreshed' || b.j.action === 'already-paused', `Opera's hold joins (${b.j.action})`);
  ok(b.h['access-control-allow-origin'] === 'chrome-extension://operagx', 'the extension gets its CORS header back');
  const ctlHeld = await req(p1, 'POST', '/control', { body: J({ cmd: 'play' }) });
  ok(ctlHeld.j.ok === false && ctlHeld.j.reason === 'held' && controls.length === 0, `play during a hold is refused as held (${J(ctlHeld.j)})`);
  const r1 = await req(p1, 'GET', '/resume?src=owen-browser');
  ok(r1.j.action === 'skipped' && r1.j.reason === 'other-holds' && sp.state === 'paused', `one of two released: still paused (${r1.j.reason})`);
  const r2 = await req(p1, 'GET', '/resume?src=browser');
  ok(r2.j.action === 'resumed' && sp.state === 'playing', `last release resumes (${r2.j.action})`);

  // A hold that is never refreshed expires (180 s) through the engine's tick: no stranded hold over HTTP.
  await req(p1, 'GET', '/pause?src=owen-browser');
  t += 181000; await engine.tick(t, []); await engine.idle();
  ok(sp.state === 'playing' && engine.snapshot(t).holds.length === 0, 'an unrefreshed HTTP hold expires after 180 s');

  // /now and /control for Quartz's new tab.
  const now1 = await req(p1, 'GET', '/now');
  ok(now1.j.title === 'Song' && now1.j.positionMs === 61000 && now1.j.canNext === true && now1.j.art === 'QUJD' && now1.j.artMime === 'image/jpeg' && !!now1.j.artHash, `/now with art (${J(Object.assign({}, now1.j, { art: now1.j.art && 'b64' }))})`);
  const now2 = await req(p1, 'GET', `/now?artHash=${now1.j.artHash}`);
  const now3 = await req(p1, 'GET', '/now?art=0');
  ok(now2.j.art === null && now3.j.art === null && now2.j.artHash === now1.j.artHash, 'art only when it changed; art=0 never');
  const n = await req(p1, 'POST', '/control', { body: J({ cmd: 'prev' }) });
  const bad = await req(p1, 'POST', '/control', { body: J({ cmd: 'rm -rf' }) });
  ok(n.j.ok === true && controls[controls.length - 1] === 'previous' && bad.j.ok === false && bad.j.reason === 'bad cmd', `control maps prev -> previous; junk refused (${J(controls)})`);
  const cfg = await req(p1, 'POST', '/config', { body: J({ adDuck: { enabled: true } }) });
  ok(cfg.j.ok === false && /does not turn Spotify’s ads down/.test(cfg.j.reason), 'ad-duck config is refused in words, never silently');

  // Fences.
  const web = await req(p1, 'GET', '/pause?src=x', { headers: { Origin: 'https://evil.example' } });
  const reb = await req(p1, 'GET', '/ping', { headers: { Host: 'evil.example' } });
  const big = await req(p1, 'POST', '/control', { body: 'x'.repeat(5000) });
  ok(web.code === 403 && engine.snapshot(t).holds.length === 0, `a web page cannot take a hold (${web.code})`);
  ok(reb.code === 403, `a rebinding Host is refused (${reb.code})`);
  ok(big.code === 413, `a body over 4 KB is refused (${big.code})`);
  const opt = await req(p1, 'OPTIONS', '/pause', { headers: { Origin: 'chrome-extension://operagx' } });
  ok(opt.code === 204 && opt.h['access-control-allow-private-network'] === 'true', 'preflight answers like the bridge');
  ok(logs.every((l) => !/owen-browser|operagx|Song|Artist/.test(l)), 'the log names no source, song or artist');

  // A port taken by someone else: the next one is used; stop() frees it.
  compat.stop('test');
  const blocker = http.createServer(() => {}); await new Promise((r) => blocker.listen(p1, '127.0.0.1', r));
  const got2 = await compat.start();
  ok(got2 === p2, `first port taken: falls to the next (${got2})`);
  compat.stop('test');
  const gone = await req(p2, 'GET', '/ping');
  ok(gone.code === 0 && !compat.running(), `stop closes it (${gone.err})`);
  blocker.close();

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`AUTOPAUSE-COMPAT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`AUTOPAUSE-COMPAT ${pass} passed, ${fail + 1} failed`); process.exit(1); });
