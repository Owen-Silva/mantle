// pingtest-checks.js - the PING dropdown's ping test (sidecar/PingTest.cs, lane pingtest, 2026-10-09),
// run by test-topbar.js (not a test by itself: no test- prefix, so the sidecar suite does not run it alone).
//
// PASSIVE sidecars only. Fake targets via MANTLE_PING_TARGETS (127.0.0.1 answers; 192.0.2.1 is
// TEST-NET-1, never routed), a fake router through the start command's test caps (127.0.0.1, or "none"),
// and a LOCAL HTTP server standing in for speed.cloudflare.com via MANTLE_SPEEDTEST_URL: it serves
// /__down?bytes=N and reads /__up, or stays silent / says 403 / trickles, for the failure and cancel
// paths. Then ONE real run with the real caps against the real targets and speed.cloudflare.com, with
// the sidecar's CPU before, during and after it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

function speedServer(mode) {
  const st = { served: 0, received: 0, reqs: 0, conns: new Set(), downReqs: 0, fileServed: 0, files: [] };
  const chunk = Buffer.alloc(65536, 7);
  const srv = http.createServer((req, res) => {
    st.reqs++;
    // the fallback stand-in (a Linode speed-test file): /linode/<dc>/100MB-<dc>.bin, by Range
    if (req.url.startsWith('/linode/')) {
      st.files.push(req.url);
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!m) { res.writeHead(416); res.end(); return; }
      let left = +m[2] - +m[1] + 1;
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': left, 'Content-Range': `bytes ${m[1]}-${m[2]}/100000000` });
      res.on('close', () => { left = 0; });
      const pumpF = () => {
        while (left > 0) { const k = Math.min(chunk.length, left); left -= k; st.fileServed += k; if (!res.write(chunk.subarray(0, k))) { res.once('drain', pumpF); return; } }
        res.end();
      };
      pumpF();
      return;
    }
    if (req.url.startsWith('/__down')) st.downReqs++;
    // Cloudflare's per-address limit: the download is refused with a wait, the upload still works
    if (mode === '429' && req.url.startsWith('/__down')) { res.writeHead(429, { 'Retry-After': '120', 'Content-Type': 'text/plain' }); res.end('slow down'); return; }
    if (mode === 'silent') return;   // takes the connection, never answers
    if (mode === '403') { req.resume(); res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('no'); return; }
    if (req.url.startsWith('/__down')) {
      let left = +new URL(req.url, 'http://x').searchParams.get('bytes') || 0;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': left });
      res.on('close', () => { left = 0; });
      const pump = () => {
        if (mode === 'trickle') {
          if (left <= 0) { res.end(); return; }
          const k = Math.min(4096, left); left -= k; st.served += k; res.write(chunk.subarray(0, k)); setTimeout(pump, 50); return;
        }
        while (left > 0) { const k = Math.min(chunk.length, left); left -= k; st.served += k; if (!res.write(chunk.subarray(0, k))) { res.once('drain', pump); return; } }
        res.end();
      };
      pump();
    } else if (req.url.startsWith('/__up')) {
      req.on('data', (d) => { st.received += d.length; });
      req.on('end', () => { res.writeHead(200); res.end(); });
    } else { res.writeHead(404); res.end(); }
  });
  srv.on('connection', (s) => { st.conns.add(s); s.on('close', () => st.conns.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    st.url = `http://127.0.0.1:${srv.address().port}`;
    st.close = () => { for (const s of st.conns) s.destroy(); srv.close(); };
    resolve(st);
  }));
}

const cpuOf = (pid) => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' });
  return parseFloat(String(r.stdout).trim().replace(',', '.'));
};

async function pingTestChecks(t, T, exe) {
  const LOCAL = [{ name: 'Here', host: '127.0.0.1' }, { name: 'Nowhere', host: '192.0.2.1' }];   // no port: ICMP only
  const FAST = { rounds: 6, periodMs: 150, downMs: 2000, upMs: 2000, downBytes: 20e6, upBytes: 10e6, router: '127.0.0.1' };

  /** One passive sidecar, one (or more) runs. drive(ps, call) does the run and returns what to check. */
  const withSidecar = async (name, targets, speedUrl, drive) => {
    let file = null;
    if (targets) {
      file = path.join(os.tmpdir(), `mantle-pingtest-${name}-${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ use: 'x', sets: { x: { label: 'Test', targets } } }));
      process.env.MANTLE_PING_TARGETS = file;
    }
    if (speedUrl) process.env.MANTLE_SPEEDTEST_URL = speedUrl;
    if (drive.fallback) process.env.MANTLE_SPEEDTEST_FALLBACK = drive.fallback;
    let ps = null;
    try {
      ps = await T.startPassive({ exe });
      return await drive(ps);
    } finally {
      delete process.env.MANTLE_PING_TARGETS; delete process.env.MANTLE_SPEEDTEST_URL; delete process.env.MANTLE_SPEEDTEST_FALLBACK;
      if (ps) { try { ps.proc.kill(); } catch (_) { /* gone */ } }
      if (file) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } }
    }
  };
  const waitEnd = async (ps, ms, until) => {
    const t0 = Date.now();
    for (;;) {
      await T.sleep(100);
      const evs = ps.collect('pingtest');
      const last = evs[evs.length - 1];
      if (until ? until(last, evs) : (last && last.running === false)) return { evs, last };
      if (Date.now() - t0 > ms) return { evs, last, timedOut: true };
    }
  };
  const phases = (evs) => evs.reduce((a, e) => (a[a.length - 1] === e.phase ? a : a.concat(e.phase)), []).join('>');

  // ---- A. a whole run, local: router, two targets (one dead), the local speed server -------------
  const srvA = await speedServer('ok');
  try {
    await withSidecar('a', LOCAL, srvA.url, async (ps) => {
      const t0 = Date.now();
      const r0 = await ps.call('topbar.pingtest', { action: 'start', test: FAST }, 4000);
      t.check('pingtest: start answers at once, running, run 1', r0.running === true && r0.run === 1 && Date.now() - t0 < 1500, JSON.stringify(r0).slice(0, 200));
      let again = null;
      try { await ps.call('topbar.pingtest', { action: 'start' }, 4000); } catch (e) { again = e.message; }
      t.check('pingtest: a second start while one runs is refused, in words', /a ping test is already running/.test(again || ''), again);
      const { evs, last, timedOut } = await waitEnd(ps, 30000);
      const secs = (Date.now() - t0) / 1000;
      t.check('pingtest: the run ends: starting > ping > down > up > done', !timedOut && phases(evs) === 'starting>ping>down>up>done', phases(evs));
      const rows = last.rows || [];
      const rt = rows.find((r) => r.kind === 'router') || {}, here = rows.find((r) => r.name === 'Here') || {}, nowhere = rows.find((r) => r.name === 'Nowhere') || {};
      t.check('pingtest: the router row: 6 of 6 replies, avg/best/worst/jitter, 0% loss', rt.host === '127.0.0.1' && rt.sent === 6 && rt.got === 6 && rt.loss === 0 &&
        typeof rt.avg === 'number' && rt.avg < 20 && typeof rt.jitter === 'number' && rt.min <= rt.avg && rt.avg <= rt.max, JSON.stringify(rt));
      t.check('pingtest: a live target: 6 of 6, marked best', here.got === 6 && here.best === true && here.method === 'icmp', JSON.stringify(here));
      t.check('pingtest: a dead target is given up after 3 tries, with its reason', nowhere.got === 0 && nowhere.sent === 3 && nowhere.gaveUp === true && /no reply from Test Nowhere in 1 s/.test(nowhere.why || '') && !nowhere.best,
        JSON.stringify(nowhere));
      // jitter = mean |difference| of consecutive replies: recomputed from min/max bounds is not possible, so check its range
      t.check('pingtest: jitter is within 0..(worst - best)', rt.jitter >= 0 && rt.jitter <= rt.max - rt.min + 0.05, JSON.stringify(rt));
      t.check('pingtest: every ping counted (given-up rounds included)', last.pingDone === last.pingTotal && last.pingTotal === 3 * 6, `${last.pingDone}/${last.pingTotal}`);
      const prog = evs.map((e) => e.progress);
      t.check('pingtest: progress only goes up, and ends at 1', prog.every((p, i) => i === 0 || p >= prog[i - 1] - 1e-9) && prog[prog.length - 1] === 1, prog.join(','));
      t.check('pingtest: download in Mbps, inside its byte cap, every byte served by the endpoint', last.down.state === 'ok' && last.down.mbps > 0 &&
        last.down.bytes <= FAST.downBytes && last.down.bytes > 0 && srvA.served >= last.down.bytes, JSON.stringify([last.down, srvA.served]));
      t.check('pingtest: upload in Mbps, inside its byte cap, received by the endpoint', last.up.state === 'ok' && last.up.mbps > 0 &&
        last.up.bytes <= FAST.upBytes && srvA.received > 0 && srvA.received <= last.up.bytes, JSON.stringify([last.up, srvA.received]));
      t.check('pingtest: the caps and the test endpoint are in the state', last.caps.rounds === 6 && last.caps.downBytes === FAST.downBytes && last.caps.upMs === 2000 &&
        /MANTLE_SPEEDTEST_URL/.test(last.test || '') && last.host === '127.0.0.1', JSON.stringify(last.caps));
      const w = last.wifi || {};
      t.check('pingtest: the network is recorded: a name, or why Windows hides it (never a blank)', /^(wifi|ethernet|other|none)$/.test(w.kind) && (!!w.name || !!w.why) && !(w.name && w.why), JSON.stringify(Object.assign({}, w, { name: w.name ? '(' + w.name.length + ' chars)' : null })));
      t.check('pingtest: the same network start to end -> no change note', last.wifiChanged == null, last.wifiChanged);
      console.log(`  pingtest network: ${w.kind}, ${w.name ? 'name read (' + w.name.length + ' chars)' : 'no name: ' + w.why}`);
      const rate = evs.length / secs;
      t.check('pingtest: events at most ~4 a second (plus phase changes)', rate <= 6, `${evs.length} events in ${secs.toFixed(1)} s`);
      const kept = await ps.call('topbar.pingtest', { action: 'state' }, 4000);
      t.check('pingtest: the result is kept, with its times, until the next run', kept.run === 1 && kept.phase === 'done' && kept.endedAt === last.endedAt && kept.startedAt < kept.endedAt &&
        kept.rows.length === 3, JSON.stringify(kept).slice(0, 200));
      let bad = null;
      try { await ps.call('topbar.pingtest', { action: 'format' }, 4000); } catch (e) { bad = e.message; }
      t.check('pingtest: an unknown action is refused in words', /Mantle does not know that ping test request/.test(bad || ''), bad);
      console.log(`  pingtest local: ${phases(evs)} in ${secs.toFixed(1)} s, ${evs.length} events; router ${rt.avg} ms; down ${last.down.mbps} Mbps (${last.down.bytes} B); up ${last.up.mbps} Mbps (${last.up.bytes} B)`);
    });
  } finally { srvA.close(); }

  // ---- B. Cancel: during the download (a trickling endpoint), then at once a new run, cancelled in its ping phase
  const srvB = await speedServer('trickle');
  try {
    await withSidecar('b', LOCAL.slice(0, 1), srvB.url, async (ps) => {
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 2, downMs: 15000 }) }, 4000);
      const inDown = await waitEnd(ps, 15000, (l) => l && l.phase === 'down' && l.down.bytes > 0);
      const conns = srvB.conns.size;
      const tc = Date.now();
      const c = await ps.call('topbar.pingtest', { action: 'cancel' }, 4000);
      t.check('pingtest: cancel answers at once with the run cancelled', !inDown.timedOut && c.phase === 'cancelled' && c.running === false && c.down.state === 'cancelled' && Date.now() - tc < 1500,
        JSON.stringify([conns, c.phase, c.down]));
      for (let k = 0; k < 20 && srvB.conns.size > 0; k++) await T.sleep(100);
      t.check('pingtest: cancel closes every download connection (the endpoint sees them go)', conns > 0 && srvB.conns.size === 0, `${conns} open before, ${srvB.conns.size} after ${Date.now() - tc} ms`);
      const n0 = ps.collect('pingtest').length;
      await T.sleep(1200);
      const after = ps.collect('pingtest').slice(n0);
      const served0 = srvB.served;
      await T.sleep(300);
      t.check('pingtest: nothing more after cancel (no events, no bytes)', after.length === 0 && srvB.served === served0, `${after.length} events after; ${srvB.served - served0} B`);
      const st = await ps.call('topbar.pingtest', { action: 'state' }, 4000);
      t.check('pingtest: the cancelled run stays as cancelled', st.phase === 'cancelled' && st.run === 1, st.phase);
      // a new run straight away, cancelled in its ping phase
      const r2 = await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 20, periodMs: 500 }) }, 4000);
      await waitEnd(ps, 5000, (l) => l && l.run === 2 && l.phase === 'ping' && l.pingDone >= 2);
      const c2 = await ps.call('topbar.pingtest', { action: 'cancel' }, 4000);
      const n2 = ps.collect('pingtest').length;
      await T.sleep(1500);
      const tail = ps.collect('pingtest').slice(n2);
      t.check('pingtest: a new run starts right after a cancel, and cancel stops its pings too', r2.run === 2 && c2.run === 2 && c2.phase === 'cancelled' && c2.pingDone < c2.pingTotal && tail.length === 0,
        JSON.stringify([r2.run, c2.phase, c2.pingDone, c2.pingTotal, tail.length]));
    });
  } finally { srvB.close(); }

  // ---- C. failures, each in words: no router + a silent endpoint; a 403; a closed port --------------
  const srvC = await speedServer('silent');
  try {
    await withSidecar('c', LOCAL.slice(0, 1), srvC.url, async (ps) => {
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 2, router: 'none', wifi: 'Home,Phone', downMs: 7000, upMs: 7000 }) }, 4000);
      const { last } = await waitEnd(ps, 20000);
      t.check('pingtest: no router: said in words, no router row', /^no router found: Windows reports no default gateway/.test(last.routerWhy || '') && !last.rows.some((r) => r.kind === 'router'), last.routerWhy);
      t.check('pingtest: a network change mid-run is said on the test', last.wifi && last.wifi.name === 'Home' &&
        last.wifiChanged === 'the network changed during the test: Wi-Fi "Home" at the start, Wi-Fi "Phone" at the end', JSON.stringify([last.wifi, last.wifiChanged]));
      t.check('pingtest: a silent endpoint: "did not answer in 5 s"', last.down.state === 'failed' && last.down.why === 'download: 127.0.0.1 did not answer in 5 s', JSON.stringify(last.down));
      t.check('pingtest: ... and the upload is skipped, saying why', last.up.state === 'skipped' && last.up.why === 'upload skipped: the download could not reach 127.0.0.1', JSON.stringify(last.up));
      t.check('pingtest: a failed speed test still ends the run as done, the pings kept', last.phase === 'done' && last.rows.length === 1 && last.rows[0].got === 2, last.phase);
    });
  } finally { srvC.close(); }
  const srvD = await speedServer('403');
  try {
    await withSidecar('d', LOCAL.slice(0, 1), srvD.url, async (ps) => {
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 1, downMs: 7000, upMs: 7000 }) }, 4000);
      const { last } = await waitEnd(ps, 20000);
      t.check('pingtest: an endpoint that refuses: its HTTP answer in words, for both directions', /^download: 127\.0\.0\.1 refused it \(HTTP 403 Forbidden\)$/.test(last.down.why || '') &&
        /^upload: 127\.0\.0\.1 refused it \(HTTP 403 Forbidden\)$/.test(last.up.why || ''), JSON.stringify([last.down.why, last.up.why]));
    });
  } finally { srvD.close(); }
  const dead = await speedServer('ok');
  const deadUrl = dead.url; dead.close();
  await T.sleep(100);
  await withSidecar('e', LOCAL.slice(0, 1), deadUrl, async (ps) => {
    await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 1, downMs: 7000, upMs: 7000 }) }, 4000);
    const { last } = await waitEnd(ps, 20000);
    t.check('pingtest: nothing listening: "could not connect", upload skipped', last.down.why === 'download: could not connect to 127.0.0.1' && last.up.state === 'skipped', JSON.stringify([last.down.why, last.up.why]));
  });

  // ---- F. Cloudflare says 429: the fallback (a local Linode stand-in) measures, and is named ----------
  const TEXAS = [{ name: 'US Central (Texas)', host: '127.0.0.1' }];   // maps to the Dallas region
  const srvF = await speedServer('429');
  try {
    const drive = async (ps) => {
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 2 }) }, 4000);
      const { last, timedOut } = await waitEnd(ps, 30000);
      const d = last.down || {}, tr = (d.tried || [])[0] || {};
      t.check('pingtest 429: the download falls back to the nearest Linode region (Texas -> Dallas) and measures', !timedOut && last.phase === 'done' && d.state === 'ok' && d.mbps > 0 &&
        d.server === 'Linode Dallas' && srvF.files.length > 0 && srvF.files.every((f) => f === '/linode/dallas/100MB-dallas.bin'), JSON.stringify([d, srvF.files.slice(0, 3)]));
      t.check('pingtest 429: it says why, in plain words, with the wait', d.note === 'Cloudflare was busy: too many requests, it asked to wait 2 min', d.note);
      t.check('pingtest 429: Cloudflare is listed as tried, with its HTTP answer', tr.server === 'Cloudflare' && tr.status === 429 && /refused it \(HTTP 429 Too Many Requests\), it asked to wait 2 min/.test(tr.why || ''), JSON.stringify(tr));
      t.check('pingtest 429: the region pick is explained', /closest to Test US Central \(Texas\)/.test(d.pick || ''), d.pick);
      t.check('pingtest 429: a refusal costs Cloudflare one small request per connection, no more', srvF.downReqs <= 3, `${srvF.downReqs} __down requests`);
      t.check('pingtest 429: the fallback stays inside the byte cap, by Range', d.bytes <= FAST.downBytes && srvF.fileServed >= d.bytes && srvF.fileServed <= FAST.downBytes + 3 * 10e6, JSON.stringify([d.bytes, srvF.fileServed]));
      t.check('pingtest 429: the upload still runs on Cloudflare, and says so', last.up.state === 'ok' && last.up.server === 'Cloudflare' && last.up.mbps > 0, JSON.stringify(last.up));
      t.check('pingtest 429: no failure words when the fallback measured', !d.why, d.why);
      console.log(`  pingtest 429: down ${d.mbps} Mbps by ${d.server} (${d.note}); up ${last.up.mbps} Mbps by ${last.up.server}`);
      // a second run inside the wait: Cloudflare is not asked again
      const n0 = srvF.downReqs;
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 1 }) }, 4000);
      const r2 = await waitEnd(ps, 30000, (l) => l && l.run === 2 && l.running === false);
      const d2 = (r2.last && r2.last.down) || {};
      t.check('pingtest 429: a run inside the wait does not ask Cloudflare again, says so, and still measures', srvF.downReqs === n0 && d2.state === 'ok' && d2.server === 'Linode Dallas' &&
        /^Cloudflare was busy: too many requests at \d+:\d\d, so it was not asked again until \d+:\d\d$/.test(d2.note || ''), JSON.stringify([srvF.downReqs - n0, d2.note, d2.state]));
    };
    drive.fallback = srvF.url + '/linode/{dc}/100MB-{dc}.bin';
    await withSidecar('f', TEXAS, srvF.url, drive);
  } finally { srvF.close(); }
  // every server fails: each reason is said
  const srvG = await speedServer('429');
  try {
    const drive = async (ps) => {
      await ps.call('topbar.pingtest', { action: 'start', test: Object.assign({}, FAST, { rounds: 1 }) }, 4000);
      const { last } = await waitEnd(ps, 30000);
      const d = last.down || {};
      t.check('pingtest all fail: every server and its reason, in one line', d.state === 'failed' &&
        /^download: every server failed\. Cloudflare: 127\.0\.0\.1 refused it \(HTTP 429 Too Many Requests\), it asked to wait 2 min; Linode Dallas: (could not connect to 127\.0\.0\.1|127\.0\.0\.1 did not answer in 2 s); Linode Fremont: (could not connect to 127\.0\.0\.1|127\.0\.0\.1 did not answer in 2 s)$/.test(d.why || '') &&
        (d.tried || []).length === 3 && !d.server, JSON.stringify(d));   // a refused loopback connect takes Windows ~2 s: the 2 s test cap can come first
      t.check('pingtest all fail: the upload is still tried on Cloudflare (it answered)', last.up.state === 'ok' && last.up.server === 'Cloudflare', JSON.stringify(last.up));
    };
    const deadF = await speedServer('ok'); const deadFUrl = deadF.url; deadF.close();
    drive.fallback = deadFUrl + '/linode/{dc}/100MB-{dc}.bin';
    await withSidecar('g', TEXAS, srvG.url, drive);
  } finally { srvG.close(); }

  // ---- D. ONE real run: real targets, the real router, speed.cloudflare.com, the real caps ----------
  if (process.env.MANTLE_PINGTEST_REAL === '0') { console.log('  pingtest REAL: skipped (MANTLE_PINGTEST_REAL=0)'); return; }
  await withSidecar('real', null, null, async (ps) => {
    const pid = ps.proc.pid;
    await T.sleep(1500);
    const i0 = cpuOf(pid), ti0 = Date.now();
    await T.sleep(6000);
    const i1 = cpuOf(pid), ti1 = Date.now();
    const t0 = Date.now();
    await ps.call('topbar.pingtest', { action: 'start' }, 4000);
    const { last, evs, timedOut } = await waitEnd(ps, 60000);
    const secs = (Date.now() - t0) / 1000;
    const r1 = cpuOf(pid), tr1 = Date.now();
    await T.sleep(1500);
    const a0 = cpuOf(pid), ta0 = Date.now();
    await T.sleep(6000);
    const a1 = cpuOf(pid), ta1 = Date.now();
    const idleBefore = (i1 - i0) / ((ti1 - ti0) / 1000), idleAfter = (a1 - a0) / ((ta1 - ta0) / 1000), during = (r1 - i1) / ((tr1 - ti1) / 1000);
    const rows = (last && last.rows) || [];
    t.check('pingtest REAL: done in under 45 s', !timedOut && last.phase === 'done' && secs < 45, `${last && last.phase} ${secs.toFixed(1)} s`);
    t.check('pingtest REAL: the router answered (or says why)', rows.some((r) => r.kind === 'router' && r.got > 0) || !!last.routerWhy, last.routerWhy);
    t.check('pingtest REAL: the Valorant locations answered, one marked best', rows.filter((r) => r.kind === 'server' && r.got > 0).length >= 1 && rows.filter((r) => r.best).length === 1);
    t.check('pingtest REAL: download in Mbps, inside the caps (35 MB / 7 s), by a named server', last.down.state === 'ok' && last.down.mbps > 0 && last.down.bytes <= 35e6 && last.down.ms <= 7300 && !!last.down.server,
      JSON.stringify(last.down));
    t.check('pingtest REAL: upload in Mbps inside the caps (20 MB / 6 s), or a reason in words', (last.up.state === 'ok' && last.up.mbps > 0 && last.up.bytes <= 20e6 && last.up.ms <= 6300) || !!last.up.why,
      JSON.stringify(last.up));
    t.check('pingtest REAL: idle cost unchanged after a run (nothing left running)', idleAfter - idleBefore < 3, `${idleBefore.toFixed(1)} -> ${idleAfter.toFixed(1)} ms CPU/s`);
    console.log(`  pingtest REAL: ${phases(evs)} in ${secs.toFixed(1)} s, ${evs.length} events`);
    const rw = last.wifi || {};
    t.check('pingtest REAL: the network is recorded (a name, or why it is hidden)', !!rw.kind && (!!rw.name || !!rw.why), JSON.stringify(Object.assign({}, rw, { name: rw.name ? '(read)' : null })));
    console.log(`    network: ${rw.kind} on ${rw.iface}: ${rw.name ? 'name read (' + rw.name.length + ' chars)' : rw.why}${last.wifiChanged ? '; ' + last.wifiChanged : ''}`);
    for (const r of rows) console.log(`    ${r.kind === 'router' ? 'router ' + r.host + ' (' + r.iface + ')' : r.name}: avg ${r.avg} ms, best ${r.min}, worst ${r.max}, jitter ${r.jitter}, loss ${r.loss}% (${r.got}/${r.sent}, ${r.method})${r.best ? ' BEST' : ''}${r.why ? ' why: ' + r.why : ''}`);
    console.log(`    download by ${last.down.server} (${last.down.host})${last.down.note ? ', because ' + last.down.note : ''}${last.down.pick ? '; region: ' + last.down.pick : ''}; tried: ${JSON.stringify(last.down.tried)}; upload by ${last.up.server}${last.up.why ? ': ' + last.up.why : ''}`);
    console.log(`    download ${last.down.mbps} Mbps (${(last.down.bytes / 1e6).toFixed(1)} MB in ${last.down.ms} ms); upload ${last.up.mbps} Mbps (${(last.up.bytes / 1e6).toFixed(1)} MB in ${last.up.ms} ms)${last.routerWhy ? '; ' + last.routerWhy : ''}`);
    console.log(`    sidecar CPU: idle before ${idleBefore.toFixed(1)} ms/s, during the run ${during.toFixed(1)} ms/s (${(during / 10).toFixed(1)}% of one core over ${secs.toFixed(0)} s), idle after ${idleAfter.toFixed(1)} ms/s`);
  });
}

module.exports = { pingTestChecks, speedServer };
