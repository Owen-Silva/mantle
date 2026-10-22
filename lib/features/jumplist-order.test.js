'use strict';
// jumplist-order.test.js - drag to reorder the bar's apps (lane bardrag, 2026-09-29): the pinned
// order kept in Mantle's own pin list (_jumplist-pins.js), its merge with pins that come and go,
// the running-only session order, and the jumplist.order command with a fake ctx.
// Plain node, nothing launched, nothing of Windows' read or written: `node lib/features/jumplist-order.test.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('./_jumplist-pins');
const feature = require('./jumplist');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
}
const ids = (list) => list.map((p) => p.id).join(',');

// Windows' pins as lib/pinned.js lists them (already in Windows' order)
const winPins = [
  { id: 'a.lnk', name: 'A', exe: 'c:\\a.exe', aumid: null, order: 0 },
  { id: 'b.lnk', name: 'B', exe: 'c:\\b.exe', aumid: null, order: 1 },
  { id: 'c.lnk', name: 'C', exe: 'c:\\c.exe', aumid: null, order: 2 },
  { id: 'app:d!app', name: 'D', exe: null, aumid: 'd!app', order: 3 },
];
const frozen = JSON.stringify(winPins);

// ---- the stored shape
check('empty() has an order list', Array.isArray(own.empty().order) && own.empty().order.length === 0);
check('norm keeps a clean order', JSON.stringify(own.norm({ order: ['b.lnk', 'a.lnk'] }).order) === '["b.lnk","a.lnk"]');
check('norm drops junk from the order (non-strings, empties, repeats)',
  JSON.stringify(own.norm({ order: ['a.lnk', 3, null, '', 'a.lnk', { x: 1 }, 'b.lnk'] }).order) === '["a.lnk","b.lnk"]');
check('norm: an order that is not a list is an empty one', own.norm({ order: 'a.lnk' }).order.length === 0);
check('an old file with no order still reads (hide/add kept)', own.norm({ hide: [{ id: 'x' }], add: [] }).hide.length === 1 && own.norm({ hide: [] }).order.length === 0);
{
  const big = []; for (let i = 0; i < own.ORDER_MAX + 50; i++) big.push('p' + i);
  check('a runaway order is cut at ORDER_MAX', own.cleanIds(big).length === own.ORDER_MAX);
}

// ---- apply: Windows' order until the user drags, then his
check('no order: Windows\' order, untouched', ids(own.apply(winPins, own.empty())) === 'a.lnk,b.lnk,c.lnk,app:d!app');
let ov = own.setOrder(own.empty(), ['c.lnk', 'a.lnk', 'app:d!app', 'b.lnk']);
check('setOrder stores the dragged order', ov.order.join() === 'c.lnk,a.lnk,app:d!app,b.lnk', ov.order.join());
check('apply puts the pins in the dragged order', ids(own.apply(winPins, ov)) === 'c.lnk,a.lnk,app:d!app,b.lnk', ids(own.apply(winPins, ov)));
check('apply never changes the pin objects main caches', JSON.stringify(winPins) === frozen);
{
  const more = winPins.concat([{ id: 'e.lnk', name: 'E', exe: 'c:\\e.exe', order: 4 }]);
  check('a pin the order has not seen goes at the END', ids(own.apply(more, ov)) === 'c.lnk,a.lnk,app:d!app,b.lnk,e.lnk', ids(own.apply(more, ov)));
  const two = [more[4], winPins[0], { id: 'f.lnk', name: 'F', exe: 'c:\\f.exe', order: 5 }].concat(winPins.slice(1));
  check('several unseen pins: at the end, in Windows\' order among themselves', ids(own.apply(two, ov)) === 'c.lnk,a.lnk,app:d!app,b.lnk,e.lnk,f.lnk', ids(own.apply(two, ov)));
  const fewer = winPins.filter((p) => p.id !== 'a.lnk');
  check('a pin that is gone drops out, the rest keep their order', ids(own.apply(fewer, ov)) === 'c.lnk,app:d!app,b.lnk', ids(own.apply(fewer, ov)));
}

// ---- pin / unpin of ANOTHER app keeps the order
{
  const browser = { id: 'running:x', name: 'Browser', kind: 'running', exe: 'c:\\br\\electron.exe', aumid: null, shortcut: 'C:\\s\\Browser.lnk' };
  let r = own.pin(ov, browser);
  check('pin another app: the order is kept', r.overlay.order.join() === ov.order.join(), r.overlay.order.join());
  const withBrowser = own.apply(winPins, r.overlay);
  check('pin another app: it goes at the end, the dragged order stands', ids(withBrowser) === 'c.lnk,a.lnk,app:d!app,b.lnk,mantle:' + browser.exe, ids(withBrowser));
  // The user drags the new Mantle pin to the front
  const o2 = own.setOrder(r.overlay, ['mantle:' + browser.exe, 'c.lnk', 'a.lnk', 'app:d!app', 'b.lnk']);
  check('a Mantle pin takes a dragged place like any other', ids(own.apply(winPins, o2)).startsWith('mantle:' + browser.exe + ',c.lnk'), ids(own.apply(winPins, o2)));
  r = own.unpin(o2, { id: 'a.lnk', name: 'A', exe: 'c:\\a.exe' });
  check('unpin another app: the others keep their order', ids(own.apply(winPins, r.overlay)) === 'mantle:' + browser.exe + ',c.lnk,app:d!app,b.lnk', ids(own.apply(winPins, r.overlay)));
  check('unpin: the unpinned app leaves the stored order', r.overlay.order.indexOf('a.lnk') === -1, r.overlay.order.join());
  const back = own.pin(r.overlay, { id: 'running:a', name: 'A', kind: 'running', exe: 'c:\\a.exe' });
  check('pinned again: it comes back at the END, as on Windows', back.did === 'unhid' && ids(own.apply(winPins, back.overlay)).endsWith(',a.lnk'), ids(own.apply(winPins, back.overlay)));
  const gone = own.unpin(o2, { id: 'mantle:' + browser.exe, name: 'Browser', exe: browser.exe });
  check('unpinning a Mantle pin drops it from add AND order', gone.did === 'removed' && gone.overlay.order.indexOf('mantle:' + browser.exe) === -1, gone.overlay.order.join());
  const byRunning = own.unpin(o2, { id: 'running:zz', name: 'Browser', exe: browser.exe });
  check('unpinning it from its running item still drops its id from the order', byRunning.did === 'removed' && byRunning.overlay.order.indexOf('mantle:' + browser.exe) === -1, byRunning.overlay.order.join());
}

// ---- a drag made while a pin was missing from the bar keeps that pin's place
check('mergeOrder: a pin not on the bar keeps its place after the one it followed',
  own.mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'd']).join() === 'c,a,b,d', own.mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'd']).join());
check('mergeOrder: a missing first pin stays first', own.mergeOrder(['x', 'a', 'b'], ['b', 'a']).join() === 'x,b,a', own.mergeOrder(['x', 'a', 'b'], ['b', 'a']).join());
check('mergeOrder: nothing stored = the bar\'s order', own.mergeOrder([], ['b', 'a']).join() === 'b,a');
check('mergeOrder: junk in, clean out', own.mergeOrder(null, ['b', 7, 'b', 'a']).join() === 'b,a');

// ---- persistence round trip through the real file format (a temp userData, never the user's)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-order-'));
  fs.mkdirSync(path.dirname(own.fileFor(tmp)), { recursive: true });
  const saved = own.setOrder(own.empty(), ['app:d!app', 'b.lnk', 'a.lnk', 'c.lnk']);
  fs.writeFileSync(own.fileFor(tmp), JSON.stringify({ someOtherSetting: 1, pins: saved }, null, 2));
  const back = own.read(tmp);
  check('round trip: the order reads back as written', back.order.join() === 'app:d!app,b.lnk,a.lnk,c.lnk', back.order.join());
  check('round trip: applied after a "restart", the bar gets it', ids(own.apply(winPins, back)) === 'app:d!app,b.lnk,a.lnk,c.lnk');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- running-only apps: this session's order
{
  const items = [
    { id: 'a.lnk', kind: 'pinned' }, { id: 'b.lnk', kind: 'pinned' },
    { id: 'running:r1', kind: 'running' }, { id: 'running:r2', kind: 'running' }, { id: 'running:r3', kind: 'running' },
  ];
  own.setRunning([]);
  check('no session order: Windows\' enumeration order', ids(own.orderRunning(items)) === 'a.lnk,b.lnk,running:r1,running:r2,running:r3');
  own.setRunning(['running:r3', 'running:r1', 'running:r2']);
  const out = own.orderRunning(items);
  check('session order applies to the running-only apps', ids(out) === 'a.lnk,b.lnk,running:r3,running:r1,running:r2', ids(out));
  check('the pinned ones never move for it', out[0] === items[0] && out[1] === items[1]);
  check('orderRunning does not change its input', ids(items) === 'a.lnk,b.lnk,running:r1,running:r2,running:r3');
  const plus = items.concat([{ id: 'running:r4', kind: 'running' }]);
  check('a newly started app goes at the end of the running ones', ids(own.orderRunning(plus)) === 'a.lnk,b.lnk,running:r3,running:r1,running:r2,running:r4', ids(own.orderRunning(plus)));
  const noR1 = items.filter((it) => it.id !== 'running:r1');
  own.orderRunning(noR1, { prune: false });
  check('an unclean read (prune:false) forgets nobody', own.getRunning().join() === 'running:r3,running:r1,running:r2', own.getRunning().join());
  const pr = own.orderRunning(noR1, { prune: true });
  check('a clean read forgets an app that stopped', own.getRunning().join() === 'running:r3,running:r2' && ids(pr) === 'a.lnk,b.lnk,running:r3,running:r2', own.getRunning().join());
  const again = own.orderRunning(items, { prune: true });
  check('...so when it starts again it is at the end, as on Windows', ids(again) === 'a.lnk,b.lnk,running:r3,running:r2,running:r1', ids(again));
  check('opts.order (tests) does not touch the session list', ids(own.orderRunning(items, { order: ['running:r2'], prune: true })) === 'a.lnk,b.lnk,running:r2,running:r1,running:r3' && own.getRunning().join() === 'running:r3,running:r2');
  own.setRunning([]);
}

// ---- the jumplist.order command
(async () => {
  function fakeCtx(testMode, opts) {
    const cmds = {}, logs = [], store = {};
    const ctx = {
      flags: { test: testMode, live: !testMode },
      log: (t) => logs.push(t),
      health: () => {},
      enabled: () => true,
      command: (verb, fn) => { cmds[verb] = fn; return 'jumplist.' + verb; },
      settings: {
        get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
        set: (k, v) => { if (opts && opts.fail) throw new Error('jumplist: the setting "pins" could not be saved (the disk is full)'); store[k] = JSON.parse(JSON.stringify(v)); return v; },
      },
      sidecar: { send: async () => ({ ok: false, error: 'unknown command' }) },
    };
    return { ctx, cmds, logs, store };
  }
  const names = ['secret app.lnk', 'app:Private.Thing!App', 'c.lnk'];
  for (const testMode of [true, false]) {
    const f = fakeCtx(testMode);
    feature.install(f.ctx);
    check(`order command exists (test=${testMode})`, typeof f.cmds.order === 'function');
    f.store.pins = { hide: [{ id: 'h.lnk', name: 'H' }], add: [], order: [] };
    const r = await f.cmds.order({ group: 'pinned', ids: names, from: 2, to: 0 });
    check(`pinned: saved (test=${testMode}, a test profile saves for real)`, r.ok === true && r.saved === 'pins' && f.store.pins.order.join() === names.join(), JSON.stringify(r) + ' ' + JSON.stringify(f.store.pins));
    check(`pinned: the hide list is untouched (test=${testMode})`, f.store.pins.hide.length === 1 && f.store.pins.hide[0].id === 'h.lnk');
    const line = f.logs[f.logs.length - 1] || '';
    check(`pinned: one log line with positions (test=${testMode})`, /moved 3 -> 1 of 3, saved/.test(line), line);
    check(`pinned: no app name or id in the log (test=${testMode})`, !f.logs.some((l) => /secret|private|\.lnk/i.test(l)), f.logs.join(' | '));
  }
  {
    const f = fakeCtx(false);
    feature.install(f.ctx);
    const r = await f.cmds.order({ group: 'running', ids: ['running:r2', 'running:r1'], from: 1, to: 0 });
    check('running: kept for the session, nothing saved', r.ok === true && r.saved === 'session' && !('pins' in f.store) && own.getRunning().join() === 'running:r2,running:r1', JSON.stringify(r));
    check('running: logged with positions, no names', /moved 2 -> 1 of 2 \(kept for this session\)/.test(f.logs.join()) && !/running:r/.test(f.logs.join()), f.logs.join());
    own.setRunning([]);
    const empty = await f.cmds.order({ group: 'pinned', ids: [] });
    check('no ids: refused in words', empty.ok === false && /no order/.test(empty.reason), JSON.stringify(empty));
    const junk = await f.cmds.order({ group: 'pinned', ids: 'a.lnk' });
    check('ids that are not a list: refused in words', junk.ok === false && /no order/.test(junk.reason), JSON.stringify(junk));
  }
  {
    const f = fakeCtx(false, { fail: true });
    feature.install(f.ctx);
    const r = await f.cmds.order({ group: 'pinned', ids: names, from: 0, to: 2 });
    check('a save that fails says why (the bar shows it)', r.ok === false && /not saved: .*could not be saved/.test(r.reason), JSON.stringify(r));
    check('...and the log gets one line, positions only', f.logs.length === 1 && /moved 1 -> 3 of 3 and the order was NOT saved/.test(f.logs[0]) && !/secret|disk/i.test(f.logs[0]), f.logs.join(' | '));
  }

  console.log(`JUMPLIST ORDER TEST: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
