// test-search.js - the `search.files` / `search.status` feature commands (sidecar/SearchIndex.cs)
// against the REAL Windows Search index, read-only.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-search.js
//
// PRIVACY: prints counts, tiers and timings only - never a path or a file name from this machine.
// Runs the sidecar in --passive; nothing here writes anything anywhere.
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const exe = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
if (!fs.existsSync(exe)) { console.log('search: 0 passed, 1 failed (no sidecar exe at ' + exe + ')'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL ' + what); }
}

const p = cp.spawn(exe, ['--passive'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
let buf = '';
const waiters = new Map();
let ready;
const readyP = new Promise((r) => { ready = r; });
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.ev === 'ready') ready();
    if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
let nextId = 0;
function call(cmd, args, ms) {
  const id = ++nextId;
  return new Promise((res) => {
    const t = setTimeout(() => { waiters.delete(id); res({ id, ok: false, error: 'TEST TIMEOUT' }); }, ms || 15000);
    waiters.set(id, (m) => { clearTimeout(t); res(m); });
    p.stdin.write(JSON.stringify(Object.assign({ id, cmd }, args || {})) + '\n');
  });
}

const TIER = { prefix: 0, word: 1, contains: 2 };

(async () => {
  await Promise.race([readyP, new Promise(r => setTimeout(r, 8000))]);

  // --- status: the service and scope report, answered from a pool thread
  const st = await call('search.status', { fresh: true });
  ok(st.ok === true, 'search.status answers ok (got ' + (st.error || 'no error') + ')');
  const s = st.result || {};
  ok(typeof s.service === 'string' || s.service === null, 'status names the WSearch service state');
  ok('scopeIndexed' in s, 'status says whether the profile is indexed');
  ok(s.stats && typeof s.stats.served === 'number', 'status carries served/superseded/failed counters');
  ok(s.ok === true || (typeof s.reason === 'string' && s.reason.length > 0), 'a not-ok status says why in words');
  console.log('  status: service=' + s.service + ' scopeIndexed=' + s.scopeIndexed);

  // --- refusals are errors with words, answered at once
  const e1 = await call('search.files', { q: '   ' });
  ok(e1.ok === false && /needs q/.test(e1.error || ''), 'empty q is refused with a reason');
  const e2 = await call('search.files', { q: 'a', max: 0 });
  ok(e2.ok === false && /max must be/.test(e2.error || ''), 'max 0 is refused');
  const e3 = await call('search.files', { q: 'a', scope: "C:\\it's" });
  ok(e3.ok === false && /quotes/.test(e3.error || ''), 'a quote in scope is refused (SQL literal)');
  const e4 = await call('search.files', { q: 'a', scope: 'relative\\dir' });
  ok(e4.ok === false && /absolute folder/.test(e4.error || ''), 'a relative scope is refused');
  const e5 = await call('search.files', { q: 'x'.repeat(201) });
  ok(e5.ok === false && /longer than 200/.test(e5.error || ''), 'a 201-char q is refused');

  // --- real queries: shape, tier order, cap, timings (the index is only READ)
  const times = [];
  for (const q of ['rep', 'mantle', 'port', 'notes', 'readme', 'xyzzyq-no-such-file']) {
    const t0 = Date.now();
    const r = await call('search.files', { q, max: 12, ttl: 8000 });
    const wall = Date.now() - t0;
    const res = r.result || {};
    ok(r.ok === true, q.length + '-char query answered (' + (r.error || '') + ')');
    if (!r.ok) continue;
    if (res.ok !== true) {
      // the index is unavailable: that must come with a reason, never an empty success
      ok(typeof res.reason === 'string' && res.reason.length > 0, 'an unavailable index says why');
      console.log('  index unavailable: reason given=' + !!res.reason);
      continue;
    }
    const items = Array.isArray(res.items) ? res.items : [];
    ok(items.length <= 12, 'capped at max');
    ok(items.every(f => typeof f.path === 'string' && typeof f.name === 'string' && f.match in TIER), 'every row has path, name, tier');
    let mono = true;
    for (let i = 1; i < items.length; i++) if (TIER[items[i].match] < TIER[items[i - 1].match]) mono = false;
    ok(mono, 'tiers run prefix > word > contains');
    ok(new Set(items.map(f => f.path.toLowerCase())).size === items.length, 'no path twice');
    ok(items.every(f => !/\\(node_modules|\.git|site-packages)\\/i.test(f.path)), 'no noise folders');
    const lower = q.toLowerCase();
    ok(items.every(f => f.match !== 'prefix' || f.name.toLowerCase().startsWith(lower)), 'prefix rows really start with q');
    ok(items.every(f => f.match !== 'contains' || f.name.toLowerCase().includes(lower)), 'contains rows really contain q');
    if (q.length < 3) ok(items.every(f => f.match !== 'contains'), 'no contains tier under 3 letters');
    times.push(res.ms);
    const tiers = items.reduce((a, f) => { a[f.match] = (a[f.match] || 0) + 1; return a; }, {});
    console.log('  q(' + q.length + ' chars): n=' + items.length + ' ' + JSON.stringify(tiers) + ' ms=' + res.ms +
                ' wall=' + wall + ' (prefix ' + res.prefixMs + ', word ' + res.wordMs + ', contains ' + res.containsMs + ')');
  }
  if (times.length) console.log('  latency: max ' + Math.max.apply(null, times) + ' ms over ' + times.length + ' queries');

  // --- latest wins: a burst answers the older ones `cancelled`, the newest with rows
  const burst = await Promise.all(['la', 'lau', 'laun', 'launch'].map(q => call('search.files', { q, max: 8, ttl: 8000 })));
  ok(burst.every(b => b.ok === true || b.error === 'cancelled'), 'every id in a burst gets exactly one answer');
  ok(burst[burst.length - 1].ok === true, 'the newest query in a burst is answered with rows');
  ok(burst.slice(0, -1).some(b => b.error === 'cancelled'), 'an older query in a burst is cancelled');

  // --- ttl already past: skipped, with the word "expired"
  const ex = await call('search.files', { q: 'report', ttl: 0.001 });
  ok(ex.ok === false && /expired/.test(ex.error || '') || ex.ok === true, 'a past-deadline query is skipped as expired (or ran in time)');

  const st2 = await call('search.status', {});
  const stats = (st2.result || {}).stats || {};
  ok(stats.served >= 1 && stats.superseded >= 1, 'counters moved (served ' + stats.served + ', superseded ' + stats.superseded + ')');

  p.stdin.write(JSON.stringify({ id: 99999, cmd: 'quit' }) + '\n');
  setTimeout(() => {
    try { p.kill(); } catch (_) { /* gone */ }
    console.log('search: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }, 400);
})();
