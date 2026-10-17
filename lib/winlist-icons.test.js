'use strict';
/*
 * winlist-icons.test.js - the window list's icon diffs, put back (idlefix-winlist, 2026-10-17).
 *
 *   node lib/winlist-icons.test.js
 *
 * sidecar/Windows.cs now sends `ev windows` with iconDiff: true and leaves out the icon it last
 * sent for an hwnd. Every 'windows' listener must still get EXACTLY the list it got before. Two
 * parts: (1) lib/winlist-icons.js against a JS mirror of the sidecar's WithoutSentIcons, step by
 * step; (2) lib/sidecar.js with this file as a FAKE child (--fake-child) that pushes the same
 * diffs: each 'windows' and 'event' listener gets the full list, and the repair after a lost list.
 * Prints one summary line; exits 1 if anything failed.
 */
const assert = require('assert');
const { spawn } = require('child_process');

// ------------------------------------------------- the sidecar's side, mirrored in JS
/** Windows.cs WithoutSentIcons: an entry whose icon equals the one last sent for its hwnd loses its icon key. */
function sidecarDiffer() {
  let sent = new Map();
  return (list) => {
    const next = new Map();
    const out = list.map((w) => {
      const h = String(w.hwnd);
      const same = sent.has(h) && sent.get(h) === w.icon;
      next.set(h, w.icon);
      if (!same) return w;
      const o = {};
      for (const k of Object.keys(w)) if (k !== 'icon') o[k] = w[k];
      return o;
    });
    sent = next;
    return out;
  };
}
const win = (hwnd, title, icon, extra = {}) => Object.assign({
  hwnd: String(hwnd), title, exe: 'C:\\x\\' + hwnd + '.exe', pid: Number(hwnd), aumid: null, host: 'exe',
  minimized: false, foreground: false, icon, iconFrom: icon ? 'exe' : null, iconPending: false,
}, extra);
const STEPS = [
  ['first list: every icon', [win(1, 'a', 'data:A'), win(2, 'b', 'data:B'), win(3, 'no icon', null)]],
  ['a title change', [win(1, 'a*', 'data:A'), win(2, 'b', 'data:B'), win(3, 'no icon', null)]],
  ['a new window', [win(1, 'a*', 'data:A'), win(2, 'b', 'data:B'), win(3, 'no icon', null), win(4, 'd', 'data:D')]],
  ['a window closes', [win(1, 'a*', 'data:A'), win(3, 'no icon', null), win(4, 'd', 'data:D')]],
  ['an icon changes', [win(1, 'a*', 'data:A2'), win(3, 'no icon', null), win(4, 'd', 'data:D')]],
  ['a closed hwnd comes back with another icon', [win(2, 'b again', 'data:B2'), win(1, 'a*', 'data:A2'), win(3, 'no icon', null), win(4, 'd', 'data:D', { foreground: true })]],
  ['an icon that was pending lands', [win(2, 'b again', 'data:B2'), win(1, 'a*', 'data:A2'), win(3, 'now one', 'data:C'), win(4, 'd', 'data:D')]],
];

let passed = 0;
const failed = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failed.push(`${name}: ${e.message.split('\n')[0]}`); }
}

function unit() {
  let mod = null;
  try { mod = require('./winlist-icons'); } catch (e) { failed.push('lib/winlist-icons.js loads: ' + e.message.split('\n')[0]); return; }
  const cache = new mod.WindowIconCache();
  const diff = sidecarDiffer();
  for (let i = 0; i < STEPS.length; i++) {
    const [name, full] = STEPS[i];
    const sent = diff(full);
    const r = cache.take(sent);
    check(`${name}: the reassembled list is the full list`, () => assert.deepStrictEqual(r.list, full));
    check(`${name}: same field order`, () => assert.strictEqual(JSON.stringify(r.list), JSON.stringify(full)));
    check(`${name}: nothing missed`, () => assert.deepStrictEqual(r.missed, []));
    check(`${name}: the cache holds exactly this list's hwnds`, () => assert.deepStrictEqual([...cache.icons.keys()].sort(), full.map((w) => w.hwnd).sort()));
    if (i > 0) {
      const carried = sent.filter((w) => 'icon' in w).map((w) => w.hwnd);
      check(`${name}: only new or changed icons were sent`, () => {
        const prev = new Map(STEPS[i - 1][1].map((w) => [w.hwnd, w.icon]));
        const want = full.filter((w) => !prev.has(w.hwnd) || prev.get(w.hwnd) !== w.icon).map((w) => w.hwnd);
        assert.deepStrictEqual(carried, want);
      });
    }
  }
  check('a title-only diff carries no icon at all', () => {
    const d = sidecarDiffer();
    d(STEPS[0][1]);
    const sent = d(STEPS[1][1]);
    assert.ok(sent.every((w) => !('icon' in w)), JSON.stringify(sent));
    assert.ok(JSON.stringify(sent).indexOf('data:') < 0);
  });
  check('a closed window leaves the cache', () => assert.ok(!cache.icons.has('99')));
  check('an entry with no icon and none kept: icon null, and said', () => {
    const c = new mod.WindowIconCache();
    const e = win(7, 'lost', 'data:L');
    delete e.icon;
    const r = c.take([e]);
    assert.deepStrictEqual(r.missed, ['7']);
    assert.strictEqual(r.list[0].icon, null);
    assert.deepStrictEqual(Object.keys(r.list[0]), Object.keys(win(7, 'lost', null)));
    c.fill([win(7, 'lost', 'data:L')], r.missed);
    const e2 = Object.assign({}, e);
    assert.strictEqual(c.take([e2]).list[0].icon, 'data:L');
  });
  check('reset forgets every icon', () => { const c = new mod.WindowIconCache(); c.take([win(1, 'a', 'x')]); c.reset(); assert.strictEqual(c.icons.size, 0); });
}

// ------------------------------------------------------------- the fake child
function fakeChild() {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ ev: 'ready', pid: process.pid, version: 'fake-1', passive: true });
  const diff = sidecarDiffer();
  let i = 0;
  const next = () => {
    if (i < STEPS.length) { out({ ev: 'windows', list: diff(STEPS[i][1]), iconDiff: true }); i++; setTimeout(next, 15); return; }
    // A list "lost on the way": an hwnd main never got, without its icon.
    const lost = win(8, 'never seen', 'data:H');
    delete lost.icon;
    out({ ev: 'windows', list: [lost], iconDiff: true });
  };
  setTimeout(next, 30);
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c.toString('utf8');
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1);
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.cmd === 'windows') out({ id: m.id, ok: true, result: [win(8, 'never seen', 'data:H')] });
      else if (m.cmd === 'quit') { out({ id: m.id, ok: true, result: {} }); process.exit(0); }
      else if (m.id !== undefined) out({ id: m.id, ok: true, result: {} });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function viaSidecar() {
  const { Sidecar } = require('./sidecar');
  const sc = new Sidecar({
    exePath: process.execPath, buildScript: null, passive: true, cwd: __dirname,
    spawnImpl: (exe, args, opts) => spawn(process.execPath, [__filename, '--fake-child', ...args], opts),
  });
  const got = [], evs = [], logs = [];
  sc.on('windows', (m) => got.push(m));
  sc.on('event', (m) => { if (m.ev === 'windows') evs.push(m); });
  sc.on('log', (l) => logs.push(l.message));
  await sc.start();
  const t0 = Date.now();
  while (got.length < STEPS.length + 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < STEPS.length; i++) {
    check(`sidecar.js: '${STEPS[i][0]}' reaches 'windows' listeners as the full list`, () => assert.deepStrictEqual(got[i] && got[i].list, STEPS[i][1]));
    check(`sidecar.js: '${STEPS[i][0]}' reaches 'event' listeners as the full list`, () => assert.deepStrictEqual(evs[i] && evs[i].list, STEPS[i][1]));
    check(`sidecar.js: '${STEPS[i][0]}' arrives without the iconDiff flag`, () => assert.deepStrictEqual(got[i] && Object.keys(got[i]), ['ev', 'list']));
  }
  check('sidecar.js: a lost list is said and repaired with a full list', () => {
    assert.ok(logs.some((l) => /without the icons of 1 window/.test(l)), JSON.stringify(logs));
    const last = got[got.length - 1];
    assert.ok(last && last.list.length === 1 && last.list[0].icon === 'data:H', JSON.stringify(last && last.list));
  });
  try { await sc.stop(); } catch (_) { /* fake */ }
  try { if (sc.proc) sc.proc.kill(); } catch (_) { /* gone */ }
}

if (process.argv[2] === '--fake-child') fakeChild();
else {
  (async () => {
    unit();
    await viaSidecar();
    console.log(`WINLIST ICONS TEST: ${passed} passed, ${failed.length} failed`);
    for (const f of failed) console.log('  FAIL ' + f);
    process.exit(failed.length || !passed ? 1 : 0);
  })().catch((err) => { console.log('FAIL the test itself threw: ' + (err && err.stack || err)); console.log('WINLIST ICONS TEST: 0 passed, 1 failed'); process.exit(1); });
}
