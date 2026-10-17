'use strict';
/*
 * test-notif-coming.js - TOAST INCOMING in sidecar/Notifications.cs on a real Windows toast (lane
 * mantle-toastfast, 2026-10-16): a PASSIVE sidecar with the notifications watch on, and silent toasts
 * from a throwaway Mantle.ToastTest.fast* id (tools/toast-poster.js: ShowBanner 0 before the first post,
 * so nothing ever pops up; the toasts are removed in the finally, pass or fail). No Electron.
 *
 *   node sidecar/test-notif-coming.js [--exe=<path>]   -> "NOTIF COMING TEST: n passed, m failed"
 *
 * Checks: the watch reply says the early signal is on (coming:true), polls every 100 ms, and says
 * whether Windows' change event is on, with the reason when it is not; each post brings ONE
 * {ev:"notifications.coming"} naming the test app, BEFORE the {ev:"notifications"} for the same toast,
 * within a poll or two of the post; a removal brings a list change but no "coming"; the data_version
 * shortcut never had to be turned off. Prints post -> coming and post -> list times.
 * SKIPS (no failure) on CI, off Windows, and while a game runs.
 */
const { spawnSync } = require('child_process');
const T = require('./test-lib');
const P = require('../tools/toast-poster');

const N = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
  return parseInt((r.stdout || '').trim(), 10) || 0;
}

(async () => {
  const t = T.checker('NOTIF COMING');
  if (process.env.CI === 'true' || process.platform !== 'win32') { console.log('SKIPPED: needs a Windows desktop session'); process.exit(t.summary()); }
  if (gaming()) { console.log('SKIPPED: a game is running'); process.exit(t.summary()); }
  let s = null, p = null;
  try {
    s = await T.startPassive();
    // arrival stamps of our own (test-lib keeps no times): every event line, as it reaches node
    const stamps = [];
    let buf = '';
    s.proc.stdout.on('data', (c) => {
      const at = Date.now();
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m && typeof m.ev === 'string') stamps.push({ ev: m.ev, aumid: m.aumid, message: m.message, at }); } catch (_) { /* not ours */ }
      }
    });
    const w = await s.call('notifications', { op: 'watch', on: true }, 8000);
    t.check('watch: armed with the database, polling every 100 ms, the early signal on', w.watching === true && w.via === 'listener+database' && w.pollMs === 100 && w.coming === true, JSON.stringify(w).slice(0, 300));
    t.check('watch: says whether Windows\' change event is on, with the reason when it is not',
      (w.changes === 'event' && w.changesWhy == null) || (w.changes === 'poll' && /would not send Mantle notification changes/.test(w.changesWhy || '')), JSON.stringify([w.changes, w.changesWhy]));
    console.log(`  Windows' change event: ${w.changes}${w.changesWhy ? ` (${w.changesWhy})` : ''}`);
    t.check('watch: each look reads the WAL-index header (the cheapest), or says why not',
      w.looks === 'wal-index header' ? w.looksWhy == null : typeof w.looksWhy === 'string' && w.looksWhy.length > 0, JSON.stringify([w.looks, w.looksWhy]));
    console.log(`  looks: ${w.looks}${w.looksWhy ? ` (${w.looksWhy})` : ''}`);

    p = await P.open();
    const toComing = [], toList = [];
    for (let i = 0; i < N; i++) {
      const from = stamps.length;
      const r = await p.post(`Mantle coming ${i} ${p.aumid.slice(-6)}`);
      const end = Date.now() + 3000;
      let coming = null, list = null;
      while (Date.now() < end && !list) {
        await sleep(5);
        const evs = stamps.slice(from);
        coming = coming || (() => { const k = evs.findIndex((e) => e.ev === 'notifications.coming'); return k >= 0 ? { k, e: evs[k], at: evs[k].at } : null; })();
        const k2 = evs.findIndex((e) => e.ev === 'notifications');
        if (k2 >= 0) list = { k: k2, e: evs[k2] };
      }
      const comings = stamps.slice(from).filter((e) => e.ev === 'notifications.coming');
      t.check(`post ${i}: one "coming", naming the test app, before the list change`,
        !!coming && !!list && coming.k < list.k && comings.length === 1 && coming.e.aumid === p.aumid,
        JSON.stringify({ coming: coming && coming.e, list: list && list.e, n: comings.length }).slice(0, 300));
      if (coming && coming.at) toComing.push(coming.at - r.before);
      if (list && list.e.at) toList.push(list.e.at - r.before);
      await sleep(400);
    }
    const sc = P.stats(toComing), sl = P.stats(toList);
    console.log(`  post -> coming: p50 ${sc.p50} ms, p95 ${sc.p95}, max ${sc.max} (n ${sc.n}); post -> list change: p50 ${sl.p50}, p95 ${sl.p95}, max ${sl.max}`);
    t.check('post -> coming stays within two polls and a read of the database (p95 under 400 ms)', sc.n === N && sc.p95 < 400, sc);

    // a removal: the list changes, nothing is "coming"
    const from = stamps.length;
    await p.clear();
    await sleep(1500);
    const after = stamps.slice(from);
    t.check('removing the toasts brings a list change and no "coming"', after.some((e) => e.ev === 'notifications') && !after.some((e) => e.ev === 'notifications.coming'), JSON.stringify(after.map((e) => e.ev)));
    t.check('neither look shortcut (WAL-index header, data_version) ever had to be turned off', !stamps.some((e) => e.ev === 'log' && /data_version moving|WAL-index header did not/.test(e.message || '')),
      JSON.stringify(stamps.filter((e) => e.ev === 'log').map((e) => e.message)).slice(0, 300));
    await s.call('notifications', { op: 'watch', on: false }, 8000);
  } catch (e) {
    t.check('the test ran', false, e.message);
  } finally {
    if (p) await p.close();
    if (s) await s.stop();
  }
  process.exit(t.summary());
})();
