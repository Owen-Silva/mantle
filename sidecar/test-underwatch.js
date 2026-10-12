'use strict';
/*
 * test-underwatch.js - the sidecar's `underwatch` (UnderDup.cs, lane mantle-topbar-instant): the row under
 * the top bar pushed on the frame it changes (DXGI Desktop Duplication). Passive sidecar, read-only: it
 * reads the screen like `underrow` and changes nothing on it.
 *
 *   node sidecar/test-underwatch.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
 *
 * What it proves: the command is listed and validates its row; on:true starts the watch and says its mode
 * (frames, or poll WITH a reason on a machine that cannot duplicate); the first push is the same columns
 * `underrow` reads, byte for byte; a row on no display falls back to poll with the reason in words;
 * on:false stops it at once; and a watch nobody keeps alive stops itself (the bar's main gone, a game).
 */
const { startPassive, checker, sleep } = require('./test-lib');

const t = checker('SIDECAR UNDERWATCH');
const ROW = { x: 0, y: 35, w: 1920, n: 240 };

(async () => {
  const s = await startPassive();
  try {
    const ping = await s.call('ping');
    t.check('ping lists underwatch', Array.isArray(ping.commands) && ping.commands.includes('underwatch'), ping.commands && ping.commands.length);
    // validation
    const bad1 = await s.send('underwatch', { on: true, x: 0, y: 35, w: 0, n: 10 });
    t.check('a row with no width is refused with a reason', !bad1.ok && /w must be/.test(bad1.error || ''), bad1.error);
    const bad2 = await s.send('underwatch', { on: true, x: 0, y: 35, w: 100, n: 200 });
    t.check('more columns than pixels is refused with a reason', !bad2.ok && /n must be/.test(bad2.error || ''), bad2.error);
    // the real row: frames (or poll, said)
    const read = await s.call('underrow', ROW);
    const e0 = s.events.length;
    const on = await s.call('underwatch', Object.assign({ on: true }, ROW));
    t.check('on:true answers ok with the watch\'s state', on.ok === true && on.on === true && typeof on.mode === 'string', JSON.stringify(on));
    const st = await s.waitEvent('underrow', 4000, (e) => e.kind === 'state' && e.mode !== 'off').catch(() => null);
    t.check('it says its mode within 4 s', !!st, 'no state event');
    if (st && st.mode === 'poll') {
      t.check('poll (this machine cannot duplicate) comes WITH the reason in words', typeof st.reason === 'string' && st.reason.length > 10, st.reason);
      console.log('  info: this machine reads by polling: ' + st.reason);
    } else if (st) {
      t.check('frames: the watch runs', st.mode === 'frames', st.mode);
      const first = await s.waitEvent('underrow', 3000, (e) => e.kind === 'cols').catch(() => null);
      t.check('the first frame is pushed within 3 s of the start', !!first, 'no push');
      if (first) {
        const a = Buffer.from(first.cols, 'base64'), b = Buffer.from(read.cols, 'base64');
        const again = Buffer.from((await s.call('underrow', ROW)).cols, 'base64');
        let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.min(Math.abs(a[i] - b[i]), Math.abs(a[i] - again[i])));
        t.check('the pushed columns are the ones underrow reads (same buckets, same pixels; max difference ' + d + ')', a.length === 720 && d <= 1, d);
        t.check('...with n, a wall-clock stamp, and when Windows presented the frame', first.n === 240 && Math.abs(first.at - Date.now()) < 60000 && first.presentAt <= first.at, JSON.stringify({ n: first.n, at: first.at, presentAt: first.presentAt }));
      }
      const live = await s.call('underwatch', Object.assign({ on: true }, ROW));
      t.check('asking again (the keep-alive) reports frames, frames seen and pushes', live.mode === 'frames' && live.frames >= 1 && live.pushes >= 1, JSON.stringify(live));
    }
    void e0;
    // off: at once
    await s.call('underwatch', { on: false });
    const off = await s.waitEvent('underrow', 2000, (e) => e.kind === 'state' && e.mode === 'off').catch(() => null);
    t.check('on:false stops it within 2 s (state off)', !!off, 'no off state');
    // no keep-alive: stops itself
    await s.call('underwatch', Object.assign({ on: true }, ROW));
    const st2 = await s.waitEvent('underrow', 4000, (e) => e.kind === 'state' && e.mode !== 'off' && e !== st).catch(() => null);
    const tOn = Date.now();
    t.check('it starts again after an off', !!st2, 'no state');
    const n1 = s.events.length;
    const lapse = await (async () => { for (let i = 0; i < 60; i++) { if (s.events.slice(n1).some((e) => e.ev === 'underrow' && e.kind === 'state' && e.mode === 'off')) return Date.now() - tOn; await sleep(100); } return null; })();
    t.check('a watch nobody keeps alive stops itself within 3-5 s', lapse != null && lapse >= 2500 && lapse <= 5500, lapse);
    // a row on no display: poll, with the reason
    const n2 = s.events.length;
    await s.call('underwatch', { on: true, x: -100000, y: -100000, w: 100, n: 10 });
    let why = null;
    for (let i = 0; i < 40 && !why; i++) { const e = s.events.slice(n2).find((x) => x.ev === 'underrow' && x.kind === 'state' && x.mode === 'poll'); if (e) why = e.reason; else await sleep(100); }
    t.check('a row on no display falls back to poll with the reason in words', /no display output holds the row/.test(why || ''), why);
    await s.call('underwatch', { on: false });
  } catch (e) {
    t.fail('the run threw', e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
