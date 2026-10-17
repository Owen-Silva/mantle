'use strict';
// test-iconlist.js -- the window list never reads an icon on the ui lane (lane r7-fg, 2026-10-01).
// WHY: the first list after a start read every app's icon on the ui lane (measured 952-961 ms of a
// 1025-1093 ms list), so every quick request queued behind it waited up to 1.9 s at start. Now icons
// not yet known are read on a background thread (Windows.cs QueueIcon) and a pushed list carries them.
//   node sidecar/test-iconlist.js [--exe=<new exe>] [--old=<old exe>]   (passive sidecars, reads only)
//   --old: also compares every settled icon with the old exe's (same source, same picture).
// 1. Cold first list: how long it holds the ui lane, and a "foreground" sent 20 ms behind it.
// 2. NEW: the list has iconPending entries with no icon; a pushed list follows with none pending.
// 3. The settled icons are the SAME as the old exe's (same iconFrom, same picture) for every window.
// Prints counts and timings only, never names.
const crypto = require('crypto');
const lib = require('./test-lib');
const newExe = lib.exePath();
const oldExe = (process.argv.find((a) => a.startsWith('--old=')) || '').slice(6) || null;
let pass = 0; const fails = [];
const check = (name, ok, detail) => { if (ok) pass++; else fails.push(name + (detail ? ' -- ' + detail : '')); console.log((ok ? '  ok ' : '  FAIL ') + name + (ok || !detail ? '' : ' -- ' + detail)); };
const h = (s) => (s ? crypto.createHash('sha1').update(s).digest('hex').slice(0, 12) : null);
const mapOf = (list) => { const m = new Map(); for (const w of list) m.set(w.hwnd, { from: w.iconFrom, pic: h(w.icon), pending: !!w.iconPending }); return m; };

async function cold(exe) {
  const s = await lib.startPassive({ exe });
  const a = Date.now();
  const pw = s.send('windows', {}, 8000).then((r) => ({ ms: Date.now() - a, list: r.ok ? r.result : [] }));
  await lib.sleep(20);
  const b = Date.now();
  const pf = s.send('foreground', {}, 8000).then((r) => ({ ms: Date.now() - b, ok: r.ok }));
  const [w, f] = await Promise.all([pw, pf]);
  return { s, w, f };
}

(async () => {
  const o = oldExe ? await cold(oldExe) : null;
  const oldMap = o ? mapOf(o.w.list) : null;
  if (o) console.log(`OLD: first list ${o.w.ms} ms (${o.w.list.length} windows, ${o.w.list.filter((x) => x.icon).length} with icons); foreground behind it ${o.f.ms} ms`);
  if (o) await o.s.stop();

  const n = await cold(newExe);
  const pend = n.w.list.filter((x) => x.iconPending);
  console.log(`NEW: first list ${n.w.ms} ms (${n.w.list.length} windows, ${pend.length} icons pending); foreground behind it ${n.f.ms} ms`);
  check('new: every entry says iconPending true/false', n.w.list.every((x) => typeof x.iconPending === 'boolean'));
  check('new: a pending entry has no icon and no iconFrom (nothing guessed)', pend.every((x) => x.icon === null && x.iconFrom === null));
  check('new: the cold first list answers fast (no icon is read on the ui lane)', n.w.ms < 300 || (o && n.w.ms < o.w.ms / 2), `${n.w.ms} ms${o ? ' vs ' + o.w.ms + ' ms' : ''}`);
  check('new: a foreground sent behind it answers fast', n.f.ok && n.f.ms < 300, `${n.f.ms} ms`);
  // The pushed list that carries the read icons.
  let settled = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    // Pushed lists leave an unchanged icon out (iconDiff, idlefix-winlist 2026-10-17): put them back
    // the way lib/sidecar.js does, in order, so the settled list compared below is the full one.
    const icons = new (require('../lib/winlist-icons').WindowIconCache)();
    const evs = n.s.collect('windows').map((e) => (e.iconDiff === true ? { list: icons.take(e.list).list } : e));
    const last = evs.length ? evs[evs.length - 1].list : null;
    if (last && !last.some((x) => x.iconPending) && (pend.length === 0 || evs.length >= 1)) { settled = last; break; }
    await lib.sleep(100);
  }
  check('new: a pushed list with no icon pending follows within 6 s', !!settled, `waited ${Date.now() - t0} ms`);
  if (pend.length) console.log(`NEW: settled list pushed ${Date.now() - t0} ms after the first answer`);
  if (settled && !settled.every((x) => x.iconPending === false)) check("new: the settled list says iconPending false on every entry", false);
  if (settled && oldMap) {
    const newMap = mapOf(settled);
    let same = 0, diff = 0, only = 0;
    for (const [hwnd, v] of newMap) {
      const ov = oldMap.get(hwnd);
      if (!ov) { only++; continue; }
      if (ov.from === v.from && ov.pic === v.pic) same++; else diff++;
    }
    console.log(`compare: ${same} same icon, ${diff} different, ${only} windows not in the old list`);
    check('new: every settled icon is the one the old exe gave (same source, same picture)', diff === 0 && same > 0, `${diff} differ`);
  }
  if (settled) {
    const r = await n.s.send('windows', {}, 4000);
    const again = r.ok ? r.result : [];
    check('new: asked again, nothing is pending and nothing is read twice', again.every((x) => !x.iconPending));
  }
  await n.s.stop();
  console.log(`ICON LIST TEST: ${pass} passed, ${fails.length} failed`);
})().catch((e) => { console.log('ICON LIST TEST: crashed: ' + e.message); process.exit(1); });
