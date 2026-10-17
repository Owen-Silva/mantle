'use strict';
/*
 * test-winlist-idle.js - the window list's idle cost (idlefix-winlist, 2026-10-17).
 *
 *   node sidecar/test-winlist-idle.js [--exe=path\to\Mantle.Sidecar.exe] [--secs=20]
 *
 * Runs the sidecar in --passive mode (read-only: it watches windows, it changes nothing) on the
 * real desktop for --secs seconds, creates no window of its own, and checks the `ev windows` it
 * pushes, reassembled the way main does (lib/winlist-icons.js):
 *   - a list whose only change from the one before is titles comes at least ~1 s after it
 *     (a spinner in a terminal's title used to push ~4 lists a second, each with every icon);
 *   - after the first list, an entry carries its icon only when its hwnd is new or its icon
 *     changed (the iconDiff protocol), and the reassembled list's icons are the same as a full
 *     `windows` request's for every hwnd in both;
 *   - it reports the lists, bytes and the sidecar's own CPU time, so old and new can be compared.
 * Run against the old exe it fails the coalescing and iconDiff checks whenever any listed window's
 * title churns (and says so when nothing churned, which proves nothing either way).
 * Prints one summary line: WINLIST IDLE TEST: N passed, M failed.
 */
const { execFileSync } = require('child_process');
const lib = require('./test-lib');
const { WindowIconCache } = require('../lib/winlist-icons');

const t = lib.checker('WINLIST IDLE');
const secs = Number(((process.argv.find((a) => a.startsWith('--secs=')) || '').slice(7))) || 20;

function cpuMs(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + Number(pid) + ').TotalProcessorTime.TotalMilliseconds'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return Math.round(Number(out.trim()));
  } catch (_) { return NaN; }
}
// Everything but the titles: a list that also changed an icon (icons landing force a list) is not title-only.
const shape = (list) => JSON.stringify(list.map((w) => Object.assign({}, w, { title: undefined })));
const titles = (list) => list.map((w) => w.title).join('\u0002');

(async () => {
  const exe = lib.exePath();
  const s = await lib.startPassive({ exe });
  const got = [];           // { at, bytes, msg }
  let buf = '';
  s.proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.indexOf('"ev":"windows"') < 0) continue;
      try { got.push({ at: Date.now(), bytes: Buffer.byteLength(line), msg: JSON.parse(line) }); } catch (_) { /* counted by test-lib */ }
    }
  });
  try {
    // The first list is forced; let it and any icon reads settle, then measure.
    await lib.sleep(3000);
    const cpu0 = cpuMs(s.proc.pid);
    const from = got.length;
    const t0 = Date.now();
    await lib.sleep(secs * 1000);
    const cpu1 = cpuMs(s.proc.pid);
    const span = got.slice(from);
    const bytes = span.reduce((a, g) => a + g.bytes, 0);
    console.log(`exe: ${exe}`);
    console.log(`in ${secs} s: ${span.length} window lists, ${Math.round(bytes / 1024)} KB, sidecar CPU ${cpu1 - cpu0} ms (${((cpu1 - cpu0) / (Date.now() - t0) * 100).toFixed(2)}% of a core)`);

    // --fixture: a minimised, never-activated window that renames itself every 100 ms for 8 s
    // (sidecar/winlist-fixture.ps1). It shows in whatever bar is running, so it is opt-in.
    let fx = null;
    if (process.argv.includes('--fixture')) {
      const { spawn } = require('child_process');
      fx = { hwnd: null, upAt: 0, goneAt: 0, cpu0: cpuMs(s.proc.pid), n0: got.length };
      const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', require('path').join(__dirname, 'winlist-fixture.ps1'), '-Secs', '8'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let ob = '';
      p.stdout.on('data', (c) => {
        ob += c.toString('utf8');
        const m = /hwnd (\d+)/.exec(ob);
        if (m && !fx.hwnd) { fx.hwnd = m[1]; fx.upAt = Date.now(); }
        if (/gone/.test(ob) && !fx.goneAt) fx.goneAt = Date.now();
      });
      await new Promise((r) => p.on('exit', r));
      await lib.sleep(1500);
      const fb = got.slice(fx.n0).reduce((a, g) => a + g.bytes, 0);
      console.log(`while the fixture renamed itself (~9.5 s): ${got.length - fx.n0} window lists, ${Math.round(fb / 1024)} KB on the wire, sidecar CPU ${cpuMs(s.proc.pid) - fx.cpu0} ms`);
    }

    // Reassemble every list in order, the way lib/sidecar.js does.
    const cache = new WindowIconCache();
    const full = [];
    let diffOk = true, diffWhy = '', everDiff = false;
    for (let k = 0; k < got.length; k++) {
      const m = got[k].msg;
      if (m.iconDiff === true) {
        everDiff = true;
        const prev = new Map(cache.icons);
        const r = cache.take(m.list);
        if (r.missed.length) { diffOk = false; diffWhy = `list ${k}: ${r.missed.length} entr(ies) without an icon and none kept`; }
        // An entry that carries its icon must be new or changed (beyond the first list).
        if (k > 0) for (const w of m.list) {
          if (Object.prototype.hasOwnProperty.call(w, 'icon') && prev.has(String(w.hwnd)) && prev.get(String(w.hwnd)) === w.icon) {
            diffOk = false; diffWhy = `list ${k}: hwnd ${w.hwnd} re-sent an unchanged icon`;
          }
        }
        full.push({ at: got[k].at, list: r.list });
      } else {
        full.push({ at: got[k].at, list: m.list });
      }
    }
    t.check('lists say iconDiff and leave unchanged icons out', everDiff && diffOk, everDiff ? diffWhy : 'no list said iconDiff (the old protocol: every list carries every icon)');

    // Title-only lists: at least ~1 s after the list before.
    let titleOnly = 0, tooSoon = 0, minGap = Infinity;
    for (let k = Math.max(1, from); k < full.length; k++) {
      const a = full[k - 1], b = full[k];
      if (shape(a.list) !== shape(b.list) || titles(a.list) === titles(b.list)) continue;
      titleOnly++;
      const gap = b.at - a.at;
      minGap = Math.min(minGap, gap);
      if (gap < 850) tooSoon++;   // 1 s in the sidecar; stdout and timer jitter allowed
    }
    console.log(`title-only lists: ${titleOnly}${titleOnly ? `, closest ${minGap} ms after the one before, ${tooSoon} under 850 ms` : ' (no listed window renamed itself: the coalescing went unexercised)'}`);
    t.check('a title-only list comes at most about once a second', tooSoon === 0, `${tooSoon} of ${titleOnly} came under 850 ms after the list before`);

    if (fx) {
      const has = (g) => g.list.some((w) => String(w.hwnd) === fx.hwnd);
      const firstIn = full.find((g) => g.at >= fx.upAt - 50 && has(g));
      const firstOut = full.find((g) => g.at >= fx.goneAt && !has(g));
      const live = full.filter((g) => g.at > (firstIn ? firstIn.at : Infinity) && g.at < fx.goneAt && has(g));
      const fxTitle = (g) => (g.list.find((w) => String(w.hwnd) === fx.hwnd) || {}).title;
      const renames = new Set(live.map(fxTitle)).size;
      console.log(`fixture ${fx.hwnd}: listed ${firstIn ? firstIn.at - fx.upAt + ' ms' : 'never'} after it was up; ${live.length} lists while it renamed itself ~80 times (${renames} distinct titles seen); gone from the list ${firstOut ? firstOut.at - fx.goneAt + ' ms' : 'never'} after it closed`);
      t.check('fixture: a new window is listed at once', !!firstIn && firstIn.at - fx.upAt < 700, firstIn ? `${firstIn.at - fx.upAt} ms` : 'never listed');
      t.check('fixture: renames go out about once a second, not per rename', live.length >= 4 && live.length <= 11, `${live.length} lists in ~8 s`);
      t.check('fixture: a closed window leaves the list at once', !!firstOut && firstOut.at - fx.goneAt < 700, firstOut ? `${firstOut.at - fx.goneAt} ms` : 'never left');
      // The raw diff lists: its icon rides only the list it first appears in.
      // (A cold sidecar may list it iconPending first; the list that brings the read icon is a change.)
      const raw = got.filter((g) => g.at >= (firstIn ? firstIn.at : Infinity) && g.at < fx.goneAt).map((g) => g.msg.list.find((w) => String(w.hwnd) === fx.hwnd)).filter(Boolean);
      let reIcon = 0, sentIcon;
      raw.forEach((w, k) => {
        if (!Object.prototype.hasOwnProperty.call(w, 'icon')) return;
        if (k > 0 && w.icon === sentIcon) reIcon++;
        sentIcon = w.icon;
      });
      t.check('fixture: its later lists leave its unchanged icon out', raw.length > 1 && reIcon === 0, `${reIcon} of ${raw.length - 1} later lists re-sent the same icon`);
      const lastFx = live.length ? live[live.length - 1].list.find((w) => String(w.hwnd) === fx.hwnd) : null;
      // The last list it was in, reassembled, has the last icon the sidecar actually sent for it.
      t.check('fixture: the reassembled entry keeps its icon', !!lastFx && typeof sentIcon === 'string' && lastFx.icon === sentIcon,
        lastFx ? `reassembled icon ${lastFx.icon ? 'present' : 'null'}, last sent ${typeof sentIcon === 'string' ? 'a picture' : String(sentIcon)}` : 'no entry');
    }

    // The reassembled icons are what a full request answers, for every hwnd in both.
    const last = full.length ? full[full.length - 1].list : [];
    const req = await s.call('windows', {}, 8000);
    const want = new Map(req.map((w) => [String(w.hwnd), w]));
    let compared = 0, wrong = 0, wrongWhy = '';
    for (const w of last) {
      const r = want.get(String(w.hwnd));
      if (!r || r.iconPending || w.iconPending) continue;
      compared++;
      if (r.icon !== w.icon || r.iconFrom !== w.iconFrom || JSON.stringify(Object.keys(r)) !== JSON.stringify(Object.keys(w))) {
        wrong++; wrongWhy = `hwnd ${w.hwnd}: ${r.icon === w.icon ? 'same icon, fields ' + Object.keys(w).join(',') : 'icon differs'}`;
      }
    }
    t.check('the reassembled list has the same icons and fields as a full windows request', compared > 0 && wrong === 0, `${compared} compared, ${wrong} wrong ${wrongWhy}`);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})().catch((err) => { console.log('FAIL the test itself threw: ' + (err && err.stack || err)); console.log('WINLIST IDLE TEST: 0 passed, 1 failed'); process.exit(1); });
