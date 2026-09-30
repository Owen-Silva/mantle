// test-search-bench.js - measures the sidecar's file search against the REAL Windows Search index,
// read-only: `search` (main's launcher.files) and `search.files` (the Win+S feature).
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-search-bench.js [--rounds=3] [--vs=<other exe>]
//
// --vs runs a SECOND sidecar and asks both the same query back to back, alternating which goes
// first, so machine load (this PC runs simulations and builds) hits both sides alike: that is the
// only fair before/after on a busy machine (MEASURED 2026-09-29: the same exe's p50 moved 3-10x
// between two runs ten minutes apart).
//
// Per exe and command: warm latency p50/p95/max by query length (1, 2, 3, 4 letters, multi-word),
// rows returned, a junk census of those rows (Office "~$" owner files, .tmp, desktop.ini,
// Thumbs.db, rows under AppData or a Temp folder, the same path twice), and the SQL-special
// queries (quotes, % _ [ ], unicode) by answer SHAPE.
//
// PRIVACY: counts and milliseconds only - never a path, a file name or a folder from this machine.
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const exeA = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
const vsArg = process.argv.find(a => a.startsWith('--vs='));
const exeB = vsArg ? vsArg.slice(5) : null;
const roundsArg = process.argv.find(a => a.startsWith('--rounds='));
const ROUNDS = roundsArg ? Math.max(1, parseInt(roundsArg.slice(9), 10) || 3) : 3;
for (const e of [exeA, exeB]) if (e && !fs.existsSync(e)) { console.log('bench: no sidecar exe'); process.exit(1); }

function side(exe) {
  const p = cp.spawn(exe, ['--passive'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '', nextId = 0;
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  return {
    call(cmd, args, ms) {
      const n = ++nextId;
      return new Promise((res) => {
        const t = setTimeout(() => { waiters.delete(n); res({ ok: false, error: 'TEST TIMEOUT' }); }, ms || 20000);
        waiters.set(n, (m) => { clearTimeout(t); res(m); });
        p.stdin.write(JSON.stringify(Object.assign({ id: n, cmd }, args || {})) + '\n');
      });
    },
    stop() {
      try { p.stdin.write(JSON.stringify({ id: 99999, cmd: 'quit' }) + '\n'); } catch (_) { /* gone */ }
      setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 300);
    },
  };
}

const SETS = {
  '1': ['a', 'e', 's', '1'],
  '2': ['re', 'ma', 'no', 'sc'],
  '3': ['rep', 'not', 'img', 'doc'],
  '4': ['test', 'read', 'mant', 'note'],
  'multi': ['final rep', 'mantle test', 'read me', 'screen shot'],
};
const SPECIAL = ["'", "a'b", '"', '%', '50%', '_', 'my_', '[', 'a]b', '[x]', '--', "'; DROP TABLE x --", '\\', 'é', '日本', '😀', 'a b c', '*', 'NEAR', 'AND OR'];

function pct(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function junkOf(rows, j) {
  const seen = new Set();
  for (const f of rows) {
    const name = String(f.name || ''), pth = String(f.path || '').toLowerCase();
    if (/^~\$/.test(name)) j.lock++;
    if (/\.tmp$/i.test(name)) j.tmp++;
    if (/^(desktop\.ini|thumbs\.db)$/i.test(name)) j.sysfile++;
    if (/\\appdata\\/.test(pth)) j.appdata++;
    if (/\\te?mp\\/.test(pth)) j.temp++;
    if (seen.has(pth)) j.dup++;
    seen.add(pth);
    if (f.isDir) j.dirs++;
  }
}

(async () => {
  const sides = [{ tag: 'A', s: side(exeA) }];
  if (exeB) sides.push({ tag: 'B', s: side(exeB) });
  await new Promise(r => setTimeout(r, 2500));
  let unanswered = 0;
  for (const cmd of ['search', 'search.files']) {
    const acc = {};
    for (const x of sides) {
      await x.s.call(cmd, { q: 'warm', max: 8 });       // open the connection: the table is the typing case
      acc[x.tag] = { junk: { lock: 0, tmp: 0, sysfile: 0, appdata: 0, temp: 0, dup: 0, dirs: 0 }, rows: 0, sets: {} };
    }
    for (const k of Object.keys(SETS)) {
      for (const x of sides) acc[x.tag].sets[k] = { times: [], rows: 0, fails: 0 };
      for (let r = 0; r < ROUNDS; r++) {
        for (const q of SETS[k]) {
          const order = (r % 2) ? sides.slice().reverse() : sides;
          for (const x of order) {
            const t0 = Date.now();
            const res = await x.s.call(cmd, { q, max: 24 });
            const wall = Date.now() - t0;
            const a = acc[x.tag].sets[k];
            if (!res.ok || !res.result || res.result.ok !== true) { if (res.error === 'TEST TIMEOUT') unanswered++; a.fails++; continue; }
            a.times.push(wall);
            if (r === 0) { const items = res.result.items || []; a.rows += items.length; acc[x.tag].rows += items.length; junkOf(items, acc[x.tag].junk); }
          }
        }
      }
    }
    for (const x of sides) {
      console.log(cmd + ' [' + x.tag + ']:');
      for (const k of Object.keys(SETS)) {
        const a = acc[x.tag].sets[k];
        console.log('  ' + k.padEnd(5) + ' p50 ' + pct(a.times, 0.5) + ' ms  p95 ' + pct(a.times, 0.95) + ' ms  max ' +
                    (a.times.length ? Math.max.apply(null, a.times) : null) + ' ms  rows ' + a.rows + '  failed ' + a.fails);
      }
      console.log('  junk in ' + acc[x.tag].rows + ' rows: ' + JSON.stringify(acc[x.tag].junk));
    }
    for (const x of sides) {
      let spOk = 0, spReason = 0, spRows = 0; const errs = [];
      for (const q of SPECIAL) {
        const res = await x.s.call(cmd, { q, max: 8 });
        if (res.error === 'TEST TIMEOUT') unanswered++;
        if (res.ok && res.result && res.result.ok === true) { spOk++; spRows += (res.result.items || []).length; }
        else if (res.ok && res.result && res.result.reason) spReason++;
        else errs.push(JSON.stringify(q) + ' -> ' + String(res.error || '').slice(0, 60));
      }
      console.log('  special [' + x.tag + ']: ' + SPECIAL.length + ' queries -> ok ' + spOk + ' (rows ' + spRows + '), ok:false+reason ' + spReason +
                  ', refused ' + errs.length + (errs.length ? ' (' + errs.join('; ') + ')' : ''));
    }
  }
  for (const x of sides) {
    const alive = await x.s.call('ping', {}, 3000);
    console.log('bench [' + x.tag + ']: sidecar alive after all queries = ' + (alive.ok === true));
    x.s.stop();
  }
  console.log('bench: unanswered ' + unanswered);
  setTimeout(() => process.exit(unanswered ? 1 : 0), 600);
})();
