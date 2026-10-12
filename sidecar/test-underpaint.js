'use strict';
/*
 * test-underpaint.js - the sidecar's `underpaint` / `underhint` / `winproc` (UnderPaint.cs, lane
 * mantle-topbar-zero): the top bar's colour painted by the sidecar itself in a native layered window right
 * under the bar, with predictions (a per-window cache, Quartz / Helm hints) and Desktop Duplication as the truth.
 *
 *   node sidecar/test-underpaint.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
 *
 * Passive sidecar. Every window it makes is invisible: the layer is fully transparent in passive (unless
 * MANTLE_UNDERPAINT_VISIBLE=1, which this test never sets) and the fake bar (test-underpaint-bar.ps1) is
 * layered with alpha 0. Nothing is focused, nothing of Owen's is moved.
 *
 *   1. the commands are listed; bad asks are refused in words
 *   2. lifecycle + placement: the layer window, its styles, its owner, hidden until the first row, the rect,
 *      not in `windows`, the focus untouched, on:false and a lapsed keep-alive take it down, transparent
 *   3. following a fake bar: directly under it in the z-order, moves / hides / shows with it
 *   4. predictions in sim mode: cache, confirm, hold + correct, partial rows, moves, titles, hints, flush
 *   5. a real-screen smoke with `underwatch` (skipped, with the reason, when duplication polls)
 */
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { startPassive, checker, sleep } = require('./test-lib');

const t = checker('SIDECAR UNDERPAINT');
const N = 40;
const SIM = { on: true, sim: true, bar: '0', x: 300, y: 500, w: 400, h: 12, rowX: 1000, rowY: 100, rowW: 400, n: N };
const REAL_ROW = { x: 0, y: 35, w: 1920, n: 240 };

// ------------------------------------------------------------------ rows
const row = (f) => { const b = Buffer.alloc(N * 3); for (let c = 0; c < N; c++) { const v = f(c); b[c * 3] = v[0]; b[c * 3 + 1] = v[1]; b[c * 3 + 2] = v[2]; } return b; };
const solid = (r, g, b) => row(() => [r, g, b]);
const b64 = (b) => b.toString('base64');
const buf = (s) => Buffer.from(s || '', 'base64');
function maxDiff(a, b, c0, c1) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = (c0 || 0) * 3; i < (c1 == null ? a.length / 3 : c1) * 3; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

// ------------------------------------------------------------------ the fake bar (and the window reader)
function startBar(x, y, w, h) {
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'test-underpaint-bar.ps1'),
    String(x), String(y), String(w), String(h)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let acc = '';
  const queue = [], waiters = [];
  let err = '';
  p.stderr.on('data', (c) => { err += c.toString('utf8'); });
  p.stdin.on('error', () => {});
  p.stdout.on('data', (c) => {
    acc += c.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const l = acc.slice(0, i).trim(); acc = acc.slice(i + 1);
      if (!l) continue;
      let m; try { m = JSON.parse(l); } catch (e) { m = { ok: false, error: 'unparseable: ' + l }; }
      const wt = waiters.shift();
      if (wt) wt(m); else queue.push(m);
    }
  });
  const next = (ms) => queue.length ? Promise.resolve(queue.shift()) : new Promise((res, rej) => {
    const tm = setTimeout(() => rej(new Error('the fake bar did not answer' + (err ? ': ' + err.slice(0, 300) : ''))), ms);
    waiters.push((m) => { clearTimeout(tm); res(m); });
  });
  return {
    proc: p,
    first: () => next(40000),
    cmd: (c) => { const pr = next(8000); p.stdin.write(c + '\n'); return pr; },
    quit: async () => { try { p.stdin.write('quit\n'); await sleep(300); } catch (_) { /* gone */ } try { p.kill(); } catch (_) { /* gone */ } },
  };
}

async function until(fn, ms, every) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { v: null, ms: Date.now() - t0 };
    await sleep(every || 10);
  }
}

function cpuMs(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ').TotalProcessorTime.TotalMilliseconds'],
    { encoding: 'utf8', windowsHide: true });
  return parseFloat(out.trim().replace(',', '.'));
}

(async () => {
  let s = null, bar = null, ka = null;
  let P = null, W = null;   // the underpaint / underwatch asks the keep-alive repeats
  try {
    s = await startPassive();
    const pk = () => s.call('underpaint', { peek: true });
    const up = (x) => s.call('underpaint', x);
    const inj = (b) => up({ inject: b64(b) });
    const paintEvs = (from) => s.events.slice(from).filter((e) => e.ev === 'underrow' && e.kind === 'paint');
    ka = setInterval(() => {
      if (P) s.send('underpaint', P).catch(() => {});
      if (W) s.send('underwatch', W).catch(() => {});
    }, 700);

    // ================================================================ 1. listing + validation
    const ping = await s.call('ping');
    const cmds = ping.commands || [];
    t.check('ping lists underpaint, underhint and winproc', ['underpaint', 'underhint', 'winproc'].every((c) => cmds.includes(c)), cmds.length);
    const refuse = async (name, cmd, req, re) => {
      const r = await s.send(cmd, req);
      t.check(name, !r.ok && re.test(r.error || ''), r.error || JSON.stringify(r).slice(0, 200));
    };
    await refuse('a layer with no width is refused in words', 'underpaint', { on: true, x: 0, y: 0, w: 0, h: 10, n: 10 }, /must be 1\.\.16384 x 1\.\.512/);
    await refuse('a layer with no height is refused in words', 'underpaint', { on: true, x: 0, y: 0, w: 100, h: 0, n: 10 }, /must be 1\.\.16384 x 1\.\.512/);
    await refuse('a layer taller than 512 is refused in words', 'underpaint', { on: true, x: 0, y: 0, w: 100, h: 600, n: 10 }, /must be 1\.\.16384 x 1\.\.512/);
    await refuse('n = 0 is refused in words', 'underpaint', { on: true, x: 0, y: 0, w: 100, h: 10, n: 0 }, /n must be between 1 and rowW/);
    await refuse('more columns than row pixels is refused in words', 'underpaint', { on: true, x: 0, y: 0, w: 100, h: 10, n: 50, rowW: 40 }, /n must be between 1 and rowW/);
    await refuse('inject with no sim layer is refused in words', 'underpaint', { inject: b64(solid(1, 2, 3)) }, /need a running sim:true layer/);
    await refuse('underhint without hwnd is refused in words', 'underhint', { app: 'x', top: { kind: 'flat', rgb: [1, 2, 3] } }, /hwnd is required/);
    await refuse('underhint with a bad kind is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'zigzag' } }, /kind must be flat, cols, wash or none/);
    await refuse('underhint rgb out of range is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'flat', rgb: [0, 0, 300] } }, /rgb must be 0\.\.255/);
    await refuse('underhint rgb with two numbers is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'flat', rgb: [0, 0] } }, /rgb must be \[r, g, b\]/);
    await refuse('underhint alpha out of range is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'wash', rgb: [1, 2, 3], alpha: 1.5 } }, /alpha must be 0\.\.1/);
    await refuse('underhint cols not a multiple of 3 is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'cols', cols: [1, 2, 3, 4] } }, /cols must be a flat list/);
    await refuse('underhint cols out of range is refused in words', 'underhint', { hwnd: '1001', top: { kind: 'cols', cols: [1, 2, 256] } }, /cols must be 0\.\.255/);
    const wp0 = await s.send('winproc', { hwnd: '0' });
    const wp0r = wp0.result || wp0;
    t.check('winproc of no window says so in words', wp0r.ok === false && /no such window/.test(wp0r.reason || wp0.error || ''), JSON.stringify(wp0));

    // ================================================================ the fake bar (also the window reader)
    bar = startBar(200, 300, 800, 30);
    const bi = await bar.first();
    t.check('the fake bar (an invisible test window) is made', bi.ok === true && bi.hwnd !== '0', JSON.stringify(bi));
    const fg0 = (await bar.cmd('fg')).fg;

    // ================================================================ 2. lifecycle + placement
    {
      const e0 = s.events.length;
      const on = await up(SIM); P = SIM;
      t.check('on:true (sim) answers ok', on.ok === true && on.on === true && on.sim === true, JSON.stringify(on).slice(0, 200));
      const got = await until(async () => { const p = await pk(); return p.hwnd && p.hwnd !== '0' ? p : null; }, 2000);
      const lw = got.v ? got.v.hwnd : '0';
      t.check('the layer window exists within 2 s', lw !== '0', JSON.stringify(got));
      const w1 = await bar.cmd('win ' + lw);
      t.check('its class is MantleUnderPaint', w1.exists && w1.cls === 'MantleUnderPaint', JSON.stringify(w1));
      const want = 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8;
      t.check('its ex-style has LAYERED | TRANSPARENT | TOOLWINDOW | NOACTIVATE | TOPMOST', w1.exists && ((w1.ex & want) >>> 0) === (want >>> 0), w1.ex && w1.ex.toString(16));
      t.check('it is hidden until the first row', w1.exists && w1.visible === false, JSON.stringify(w1));
      const wp = await s.call('winproc', { hwnd: lw });
      t.check('winproc says it is the sidecar\'s own window', wp.ok === true && wp.pid === s.proc.pid && /Mantle\.Sidecar\.exe$/i.test(wp.path || ''), JSON.stringify(wp));
      const wl = await s.call('windows');
      const wls = JSON.stringify(wl);
      t.check('it is NOT in the sidecar\'s windows list (taskbar / Alt+Tab)', wls.length > 2 && !new RegExp('(^|[^0-9])' + lw + '([^0-9]|$)').test(wls) && !/MantleUnderPaint/.test(wls), wls.length);
      // the first row: shown at exactly the rect
      const under0 = await s.call('underrow', { x: 300, y: 506, w: 400, n: N });
      const MAG = solid(255, 0, 254);
      const fgS = (await bar.cmd('fg')).fg;
      await inj(MAG);
      const shown = await until(async () => { const w = await bar.cmd('win ' + lw); return w.visible ? w : null; }, 1000);
      t.check('the first row shows it (within 1 s, took ' + shown.ms + ' ms)', !!shown.v, JSON.stringify(shown));
      t.check('...at exactly the asked rect [300,500,700,512]', shown.v && JSON.stringify(shown.v.rect) === '[300,500,700,512]', shown.v && JSON.stringify(shown.v.rect));
      const p1 = await pk();
      t.check('peek: it paints the injected row', maxDiff(buf(p1.painted), MAG) === 0, p1.painted);
      const nat = await until(async () => paintEvs(e0).find((e) => e.mode === 'native'), 1000);
      t.check('it says mode native (an underrow paint event)', !!nat.v, JSON.stringify(paintEvs(e0)));
      const under1 = await s.call('underrow', { x: 300, y: 506, w: 400, n: N });
      const u1 = buf(under1.cols), u0 = buf(under0.cols);
      let mag = 0; for (let c = 0; c < N; c++) if (Math.abs(u1[c * 3] - 255) <= 6 && u1[c * 3 + 1] <= 6 && Math.abs(u1[c * 3 + 2] - 254) <= 6) mag++;
      t.check('passive: it is fully transparent (the screen under it is not the painted colour; ' + mag + ' magenta columns; screen moved ' + maxDiff(u0, u1) + ' levels)', mag === 0, mag);
      t.check('...and says so in its layer info', /transparent: a test/.test(p1.layer || ''), p1.layer);
      const fg1 = (await bar.cmd('fg')).fg;
      t.check('the foreground window did not change when it was shown', fg1 === fgS && fg1 !== lw, fgS + ' -> ' + fg1 + ' (at the start ' + fg0 + ')');
      // off: at once
      const e1 = s.events.length;
      await up({ on: false }); P = null;
      const gone = await until(async () => { const w = await bar.cmd('win ' + lw); return w.exists ? null : true; }, 1000);
      t.check('on:false destroys it at once (' + gone.ms + ' ms)', !!gone.v && gone.ms < 600, gone.ms);
      const offEv = await until(async () => paintEvs(e1).find((e) => e.mode === 'off'), 1000);
      t.check('...and says mode off', !!offEv.v, JSON.stringify(paintEvs(e1)));
      // an off and an on in the same breath (no keep-alive after): back at once, not at the next ask
      await up(SIM); await sleep(50); await inj(solid(1, 1, 1));
      await until(async () => (await pk()).mode === 'native', 1000);
      await Promise.all([up({ on: false }), up(SIM)]);
      await sleep(30);
      await inj(solid(5, 6, 7));
      const back = await until(async () => {
        const p = await pk();
        if (!p.hwnd || p.hwnd === '0' || !p.painted) return null;
        const w = await bar.cmd('win ' + p.hwnd);
        return w.visible && maxDiff(buf(p.painted), solid(5, 6, 7)) === 0 ? p : null;
      }, 1500, 10);
      t.check('an off and an on in the same breath: the layer is back at once (' + back.ms + ' ms, no keep-alive needed)', !!back.v && back.ms < 400, back.ms);
      await up({ on: false });
      await until(async () => (await pk()).hwnd === '0', 1000);
      // a lapsed keep-alive: gone by itself within 3-4.5 s
      const e2 = s.events.length;
      await up(SIM);
      const tOn = Date.now();
      await sleep(100);
      await inj(solid(10, 20, 30));
      const nat2 = await until(async () => paintEvs(e2).find((e) => e.mode === 'native'), 1000);
      const lw2 = (await pk()).hwnd;
      t.check('it comes back after an off', !!nat2.v && lw2 !== '0', JSON.stringify(paintEvs(e2)));
      const lapse = await until(async () => paintEvs(e2).find((e) => e.mode === 'off'), 6000, 50);
      const lapseMs = lapse.v ? Date.now() - tOn : null;
      t.check('nobody keeping it alive takes it down by itself in 3-4.5 s (' + lapseMs + ' ms) with mode off', lapse.v && lapseMs >= 2900 && lapseMs <= 4500, lapseMs);
      const w3 = await bar.cmd('win ' + lw2);
      t.check('...and the window is destroyed', w3.exists === false, JSON.stringify(w3));
    }

    // ================================================================ 3. following a bar
    {
      const [bl, bt] = bi.rect;
      const B3 = Object.assign({}, SIM, { bar: bi.hwnd, x: bl + 100, y: bt, w: 400, h: 12 });
      await up(B3); P = B3;
      await sleep(100);
      await inj(solid(20, 40, 60));
      const sh = await until(async () => { const p = await pk(); if (p.hwnd === '0') return null; const w = await bar.cmd('win ' + p.hwnd); return w.visible ? { p, w } : null; }, 1000);
      t.check('with a bar: shown after the first row', !!sh.v, JSON.stringify(sh));
      const lw = sh.v ? sh.v.p.hwnd : '0';
      const p0 = await pk();
      const i0 = await bar.cmd('info');
      t.check('it is directly under the bar in the z-order (peek zUnderBar)', p0.zUnderBar === true, p0.layer);
      t.check('...GetWindow(bar, GW_HWNDNEXT) is the layer', i0.next === lw, i0.next + ' vs ' + lw);
      const r0 = sh.v ? sh.v.w.rect : [0, 0, 0, 0];
      t.check('...at the bar\'s rect plus its offset', r0[0] === bl + 100 && r0[1] === bt, JSON.stringify(r0));
      // move the bar
      await bar.cmd('move ' + (bl + 37) + ' ' + (bt + 23));
      const mv = await until(async () => { const w = await bar.cmd('win ' + lw); return w.rect[0] === r0[0] + 37 && w.rect[1] === r0[1] + 23 ? w : null; }, 1000, 3);
      t.check('moving the bar moves the layer by the same delta (+37,+23) on its event (' + mv.ms + ' ms)', !!mv.v && mv.ms < 150, JSON.stringify(mv));
      const pm = await pk();
      t.check('...and keeps it directly under the bar', pm.zUnderBar === true && (await bar.cmd('info')).next === lw, pm.layer);
      // hide / show
      const fgH = (await bar.cmd('fg')).fg;
      await bar.cmd('hide');
      const hd = await until(async () => { const w = await bar.cmd('win ' + lw); return w.visible ? null : true; }, 1000, 5);
      t.check('hiding the bar hides the layer (' + hd.ms + ' ms)', !!hd.v && hd.ms < 300, hd.ms);
      await bar.cmd('show');
      const sw = await until(async () => { const w = await bar.cmd('win ' + lw); return w.visible ? w : null; }, 1000, 5);
      t.check('showing it shows the layer again (' + sw.ms + ' ms)', !!sw.v && sw.ms < 300, sw.ms);
      const i2 = await bar.cmd('info');
      t.check('...directly under the bar again', i2.next === lw && (await pk()).zUnderBar === true, i2.next + ' vs ' + lw);
      // a tight window (Owen may switch apps during the run; the fake bar's own show/hide is SW_SHOWNOACTIVATE)
      t.check('the foreground window did not change across the layer\'s hide / show', i2.fg === fgH && i2.fg !== lw && i2.fg !== bi.hwnd, fgH + ' -> ' + i2.fg);
      await bar.cmd('move ' + bl + ' ' + bt);
      await up({ on: false }); P = null;
      await sleep(200);
    }

    // ================================================================ 4. predictions (sim)
    {
      await up(SIM); P = SIM;
      await up({ flush: true });
      await s.call('underhint', { clear: true });
      await sleep(100);
      const A = { hwnd: '1001', title: 'Alpha', rect: [1000, 100, 1400, 600] };
      const B = { hwnd: '1002', title: 'Beta', rect: [1000, 100, 1400, 600] };
      const C = { hwnd: '1003', title: 'Gamma', rect: [1000, 50, 1200, 600] };
      const D = { hwnd: '1004', title: 'Delta', rect: [1200, 50, 1400, 600] };
      const rowA = row((c) => [200, 10 + c * 5, 30]);
      const rowB = row((c) => [20, 40, 100 + c * 3]);
      const rowB2 = solid(90, 90, 90);
      const rowCD = row((c) => (c < 20 ? [10, 100 + c * 7, 10] : [240, 220, c * 5]));
      const rowA2 = solid(130, 20, 160);
      const wins = (w) => up({ wins: w });
      const ev = (type, hwnd, w) => up(w ? { wins: w, ev: { type, hwnd } } : { ev: { type, hwnd } });

      // 4a: the cache records a window's columns
      await wins([A, B]); await sleep(20);
      await inj(rowA); await sleep(60);
      let p = await pk();
      t.check('the cache records the window under the row (cache ' + p.cache + ', records ' + p.records + ')', p.cache >= 1 && p.records >= 1 && maxDiff(buf(p.painted), rowA) === 0, JSON.stringify({ cache: p.cache, records: p.records }));
      let st = p;
      await ev('foreground', B.hwnd, [B, A]); await sleep(40);
      p = await pk();
      t.check('a switch to an unseen window is a cache miss (no prediction)', p.cacheMisses > st.cacheMisses && p.pred == null && maxDiff(buf(p.painted), rowA) === 0, JSON.stringify({ miss: p.cacheMisses, pred: p.pred }));
      await inj(rowB); await sleep(50);
      p = await pk();
      t.check('...its row recorded too', p.cache >= 2 && maxDiff(buf(p.painted), rowB) === 0, p.cache);

      // 4b: a switch to a cached window paints its columns at once, the agreeing row confirms
      st = await pk();
      await ev('foreground', A.hwnd, [A, B]); await sleep(12);
      p = await pk();
      t.check('foreground to a cached window: painted from the cache at once, before any row (pred ' + p.pred + ')', p.pred === 'switch painted cache' && maxDiff(buf(p.painted), rowA) === 0, p.pred);
      t.check('...counted (cacheHits, predictions switch:cache)', p.cacheHits > st.cacheHits && (p.predictions['switch:cache'] || 0) > ((st.predictions || {})['switch:cache'] || 0), JSON.stringify(p.predictions));
      await inj(rowA); await sleep(30);
      p = await pk();
      t.check('an agreeing row confirms it (confirmed ' + st.confirmed + ' -> ' + p.confirmed + ')', p.confirmed === st.confirmed + 1 && p.pred == null && p.corrected === st.corrected, JSON.stringify({ c: p.confirmed, k: p.corrected, pred: p.pred }));

      // 4c: a stale entry is held, then the capture wins and the entry is dropped
      st = await pk();
      await ev('foreground', B.hwnd, [B, A]);
      await inj(rowB2);
      await sleep(15);
      p = await pk();
      t.check('a disagreeing row inside the hold is held (pred ' + p.pred + ', held ' + st.held + ' -> ' + p.held + ')', p.pred === 'switch painted cache' && p.held > st.held && maxDiff(buf(p.painted), rowB) === 0, JSON.stringify({ pred: p.pred, held: p.held }));
      await sleep(150);
      p = await pk();
      t.check('...then the capture wins (corrected ' + st.corrected + ' -> ' + p.corrected + ')', p.corrected === st.corrected + 1 && p.pred == null && maxDiff(buf(p.painted), rowB2) === 0, JSON.stringify({ k: p.corrected, pred: p.pred }));
      t.check('...correctionRate > 0 and correctedBy switch:cache', p.correctionRate > 0 && (p.correctedBy['switch:cache'] || 0) >= 1, JSON.stringify({ rate: p.correctionRate, by: p.correctedBy }));
      t.check('...and the stale entry is dropped (cache ' + st.cache + ' -> ' + p.cache + ')', p.cache === st.cache - 1, p.cache);
      await inj(rowB2); await sleep(40);
      p = await pk();
      t.check('the next settled row records it again', p.cache === st.cache, p.cache);

      // 4d: partial rows: two windows side by side, each range from its own entry
      await wins([C, D, A]); await sleep(20);
      await inj(rowCD); await sleep(50);
      await ev('foreground', A.hwnd, [A, C, D]); await sleep(8);
      await inj(rowA); await sleep(50);
      p = await pk();
      t.check('(setup: A back on top, painted A)', maxDiff(buf(p.painted), rowA) === 0 && p.pred == null, p.pred);
      st = p;
      await ev('foreground', C.hwnd, [C, D, A]); await sleep(12);
      p = await pk();
      const pc = buf(p.painted);
      t.check('partial rows: the left half from C\'s entry (max diff ' + maxDiff(pc, rowCD, 0, 20) + ')', p.pred === 'switch painted cache' && maxDiff(pc, rowCD, 0, 20) === 0, p.pred);
      t.check('...the right half from D\'s entry (max diff ' + maxDiff(pc, rowCD, 20, 40) + ')', maxDiff(pc, rowCD, 20, 40) === 0, p.pred);
      await inj(rowCD); await sleep(50);
      p = await pk();
      t.check('...confirmed by the agreeing row', p.confirmed === st.confirmed + 1 && p.pred == null, JSON.stringify({ c: p.confirmed, pred: p.pred }));

      // 4e: moved sideways = the entry shifted; moved down or resized = dropped
      const C2 = Object.assign({}, C, { rect: [1100, 50, 1300, 600] });
      st = await pk();
      await ev('foreground', C.hwnd, [C2, D, A]); await sleep(12);
      p = await pk();
      const exp = row((c) => { const src = c < 10 ? rowA : c < 30 ? rowCD : rowCD; const k = c < 10 ? c : c < 30 ? c - 10 : c; return [src[k * 3], src[k * 3 + 1], src[k * 3 + 2]]; });
      const pm = buf(p.painted);
      t.check('a window moved sideways (+100 px) reuses its entry shifted (cols 10-29 = C\'s 0-19; diff ' + maxDiff(pm, exp, 10, 30) + ')', p.pred === 'switch painted cache' && maxDiff(pm, exp, 10, 30) === 0, p.pred);
      t.check('...the columns it uncovered come from the window behind (A; diff ' + maxDiff(pm, exp, 0, 10) + ')', maxDiff(pm, exp, 0, 10) === 0, '');
      await inj(exp); await sleep(50);
      await inj(exp); await sleep(30);
      p = await pk();
      t.check('...confirmed', p.confirmed === st.confirmed + 1 && p.corrected === st.corrected, JSON.stringify({ c: p.confirmed, k: p.corrected }));
      st = p;
      const C3 = Object.assign({}, C2, { rect: [1100, 60, 1300, 610] });
      await ev('foreground', C.hwnd, [C3, D, A]); await sleep(40);
      p = await pk();
      t.check('a window moved down drops its entry (cache ' + st.cache + ' -> ' + p.cache + ')', p.cache === st.cache - 1 && p.pred == null, JSON.stringify({ cache: p.cache, pred: p.pred }));
      st = p;
      const D2 = Object.assign({}, D, { rect: [1200, 50, 1390, 600] });
      await ev('foreground', D.hwnd, [C3, D2, A]); await sleep(40);
      p = await pk();
      t.check('a resized window drops its entry (cache ' + st.cache + ' -> ' + p.cache + ')', p.cache === st.cache - 1, JSON.stringify({ cache: p.cache, pred: p.pred }));
      // the column D2 uncovered (39) is A's: A was seen whole, then only cols 0-9 (C2 and D over it): its entry kept the rest
      const p39 = buf(p.painted);
      t.check('a window seen whole, then partly covered, keeps its hidden columns (col 39 = A\'s; pred ' + p.pred + ')', p.pred === 'switch painted cache' && maxDiff(p39, rowA, 39, 40) === 0, JSON.stringify([...p39.slice(117, 120)]));
      await sleep(120);   // any prediction from it runs out

      // 4f: a title change to a cached title is timed, then confirmed
      await wins([A, B]); await sleep(20);
      await inj(rowA); await sleep(50);
      const A2 = Object.assign({}, A, { title: 'Alpha 2' });
      st = await pk();
      await ev('title', A.hwnd, [A2, B]); await sleep(80);
      await inj(rowA2); await sleep(50);
      p = await pk();
      t.check('a new title is a miss, then its repaint is recorded (cache ' + st.cache + ' -> ' + p.cache + ')', p.cache === st.cache + 1 && maxDiff(buf(p.painted), rowA2) === 0, JSON.stringify({ cache: p.cache, pred: p.pred }));
      st = p;
      await ev('title', A.hwnd, [A, B]);
      const w0 = (await until(async () => { const x = await pk(); return x.pred ? x : null; }, 30, 1)).v || {};
      t.check('a title change back to a cached title waits for the app\'s frame (pred ' + w0.pred + ')', w0.pred === 'title waiting cache' && maxDiff(buf(w0.painted), rowA2) === 0, w0.pred);
      const land = await until(async () => { const x = await pk(); return x.pred === 'title painted cache' ? x : null; }, 300, 3);
      await inj(rowA);
      t.check('...then is painted within ~100 ms (' + land.ms + ' ms) with the cached row', !!land.v && land.ms <= 110 && maxDiff(buf(land.v.painted), rowA) === 0, JSON.stringify({ ms: land.ms }));
      await sleep(40);
      p = await pk();
      t.check('...and confirmed by the agreeing row (predictions title:cache ' + (p.predictions['title:cache'] || 0) + ')', p.confirmed === st.confirmed + 1 && p.pred == null && (p.predictions['title:cache'] || 0) >= 1, JSON.stringify({ c: p.confirmed, pred: p.pred }));

      // 4h: a desktop column (no window under it: the page keeps its glass there) is SHOWN with its nearest
      // window column's colour, so the page's mask ramp between their centres blends the window into the glass,
      // not toward the desktop's raw colour; `painted` (what predictions compare) stays the screen's row
      {
        const E = { hwnd: '1005', title: 'Eps', rect: [1100, 100, 1200, 600] };   // cols 10-19 of the 40
        const rowE = row((c) => (c >= 10 && c < 20 ? [100 + c, 60, 20] : [5, 5, 240]));
        const expE = row((c) => { const k = c < 10 ? 10 : c >= 20 ? 19 : c; return [100 + k, 60, 20]; });
        await wins([E]); await sleep(20);
        await inj(rowE); await sleep(60);
        p = await pk();
        const sh = buf(p.shown);
        t.check('a desktop column is shown with its nearest window column (0-9 = col 10, 20-39 = col 19; diff ' + maxDiff(sh, expE) + ')', maxDiff(sh, expE) === 0, JSON.stringify([...sh.slice(0, 6), '...', ...sh.slice(114)]));
        t.check('...the window\'s own columns as read (diff ' + maxDiff(sh, rowE, 10, 20) + ')', maxDiff(sh, rowE, 10, 20) === 0, '');
        t.check('...and painted (what a prediction compares) is still the screen\'s row', maxDiff(buf(p.painted), rowE) === 0, '');
        // two windows with desktop between: each desktop column takes the NEARER one
        const F = { hwnd: '1006', title: 'Phi', rect: [1300, 100, 1400, 600] };   // cols 30-39
        const rowEF = row((c) => (c >= 10 && c < 20 ? [100, 60, 20] : c >= 30 ? [20, 60, 200] : [5, 5, 240]));
        const expEF = row((c) => (c < 25 ? [100, 60, 20] : [20, 60, 200]));
        await wins([E, F]); await sleep(20);
        await inj(rowEF); await sleep(60);
        p = await pk();
        t.check('between two windows each desktop column takes the nearer one (20-24 left, 25-29 right; diff ' + maxDiff(buf(p.shown), expEF) + ')', maxDiff(buf(p.shown), expEF) === 0, JSON.stringify([...buf(p.shown).slice(60, 90)]));
        // only the desktop: shown as read (the page has its whole glass up then)
        const rowD = row((c) => [c * 4, 30, 90]);
        await wins([]); await sleep(20);
        await inj(rowD); await sleep(60);
        p = await pk();
        t.check('only the desktop under the row: shown as read (diff ' + maxDiff(buf(p.shown), rowD) + ')', maxDiff(buf(p.shown), rowD) === 0, '');
        // the same row, a window comes: the fill changes, so the layer is painted again though the row did not
        const st0 = await pk();
        await wins([E]); await sleep(20);
        await inj(rowD); await sleep(60);
        p = await pk();
        const expD = row((c) => { const k = c < 10 ? 10 : c >= 20 ? 19 : c; return [k * 4, 30, 90]; });
        t.check('the same row with a window come under it is painted again, filled (paints ' + st0.paints + ' -> ' + p.paints + ', diff ' + maxDiff(buf(p.shown), expD) + ')', p.paints > st0.paints && maxDiff(buf(p.shown), expD) === 0, '');
        // back to the world 4g expects: A whole under the row, painted A
        await wins([A, B]); await sleep(20);
        await inj(rowA); await sleep(60);
      }

      // 4g: hints win over the cache
      st = await pk();
      await s.call('underhint', { hwnd: A.hwnd, app: 'quartz-test', top: { kind: 'flat', rgb: [10, 200, 30] } });
      const hl = await until(async () => { const x = await pk(); return x.pred === 'hint painted hint' ? x : null; }, 300, 3);
      t.check('a flat hint for the window under the row is painted (pred hint painted hint, ' + hl.ms + ' ms)', !!hl.v && maxDiff(buf(hl.v.painted), solid(10, 200, 30)) === 0, JSON.stringify(hl.v && hl.v.pred));
      await inj(solid(10, 200, 30)); await sleep(40);
      p = await pk();
      t.check('...confirmed, and counted (hintUsed ' + st.hintUsed + ' -> ' + p.hintUsed + ', hints ' + p.hints + ')', p.confirmed === st.confirmed + 1 && p.hintUsed > st.hintUsed && p.hints === 1, JSON.stringify({ c: p.confirmed, hu: p.hintUsed }));
      // a switch: the hint wins over the cache
      await ev('foreground', B.hwnd, [B, A]); await sleep(8); await inj(rowB2); await sleep(50);
      await ev('foreground', A.hwnd, [A, B]); await sleep(12);
      p = await pk();
      t.check('on a switch the hint wins over the cache (pred ' + p.pred + ')', p.pred === 'switch painted hint' && maxDiff(buf(p.painted), solid(10, 200, 30)) === 0, p.pred);
      await inj(solid(10, 200, 30)); await sleep(50);
      // cols
      const hc = [255, 0, 0, 0, 255, 0, 0, 0, 255, 100, 100, 100];
      const expC = row((c) => { const j = Math.floor((c + 0.5) / 10); return hc.slice(j * 3, j * 3 + 3); });
      await s.call('underhint', { hwnd: A.hwnd, app: 'quartz-test', top: { kind: 'cols', cols: hc } });
      const hcl = await until(async () => { const x = await pk(); return x.pred === 'hint painted hint' ? x : null; }, 300, 3);
      t.check('a cols hint is spread across the window (diff ' + (hcl.v ? maxDiff(buf(hcl.v.painted), expC) : 'none') + ')', !!hcl.v && maxDiff(buf(hcl.v.painted), expC) === 0, '');
      await inj(expC); await sleep(50);
      // wash, over the layer's wash base
      const washBase = row((c) => [c * 6, 50, 200 - c * 4]);
      const SW = Object.assign({}, SIM, { wash: b64(washBase) });
      await up(SW); P = SW; await sleep(60);
      const expW = row((c) => [0, 1, 2].map((k) => Math.round(washBase[c * 3 + k] * 0.5 + [200, 100, 0][k] * 0.5)));
      await s.call('underhint', { hwnd: A.hwnd, app: 'quartz-test', top: { kind: 'wash', rgb: [200, 100, 0], alpha: 0.5 } });
      const hwl = await until(async () => { const x = await pk(); return x.pred === 'hint painted hint' ? x : null; }, 300, 3);
      t.check('a wash hint mixes over the wash base (diff ' + (hwl.v ? maxDiff(buf(hwl.v.painted), expW) : 'none') + ')', !!hwl.v && maxDiff(buf(hwl.v.painted), expW) <= 1, '');
      await inj(expW); await sleep(50);
      // a disagreeing hint: said to main, the capture wins
      st = await pk();
      const eh = s.events.length;
      await s.call('underhint', { hwnd: A.hwnd, app: 'liar-test', top: { kind: 'flat', rgb: [50, 50, 50] } });
      const truth = solid(200, 200, 200);
      for (let i = 0; i < 14; i++) { await inj(truth); await sleep(30); }
      await sleep(100);
      p = await pk();
      const bad = s.events.slice(eh).find((e) => e.ev === 'underrow' && e.kind === 'hint' && e.ok === false);
      t.check('a hint the screen disagrees with for > 3 frames is said to main (kind hint, ok false, why, levels)', !!bad && bad.app === 'liar-test' && /differs from the screen by 150 levels/.test(bad.why || '') && bad.levels === 150, JSON.stringify(bad));
      t.check('...once (not per frame)', s.events.slice(eh).filter((e) => e.ev === 'underrow' && e.kind === 'hint' && e.ok === false).length === 1, '');
      t.check('...and the capture wins (painted the screen\'s row)', maxDiff(buf(p.painted), truth) === 0 && p.pred == null, p.pred);
      // an agreeing hint later: ok again
      const eo = s.events.length;
      await s.call('underhint', { hwnd: A.hwnd, app: 'liar-test', top: { kind: 'flat', rgb: [200, 200, 200] } });
      for (let i = 0; i < 8; i++) { await inj(truth); await sleep(30); }
      const good = await until(async () => s.events.slice(eo).find((e) => e.ev === 'underrow' && e.kind === 'hint' && e.ok === true), 500);
      t.check('an agreeing hint from that app later says ok:true', !!good.v && good.v.app === 'liar-test', JSON.stringify(s.events.slice(eo).filter((e) => e.ev === 'underrow')));
      // none / null / clear / flush
      await s.call('underhint', { hwnd: A.hwnd, top: { kind: 'none' } }); await sleep(40);
      p = await pk();
      t.check('kind none forgets the hint (hints ' + p.hints + ')', p.hints === 0, p.hints);
      await s.call('underhint', { hwnd: B.hwnd, app: 'quartz-test', top: { kind: 'flat', rgb: [1, 2, 3] } }); await sleep(40);
      const h1 = (await pk()).hints;
      await s.call('underhint', { hwnd: B.hwnd, top: null }); await sleep(40);
      const h2 = (await pk()).hints;
      t.check('top:null forgets it too (' + h1 + ' -> ' + h2 + ')', h1 === 1 && h2 === 0, h1 + ' -> ' + h2);
      await s.call('underhint', { hwnd: A.hwnd, app: 'quartz-test', top: { kind: 'flat', rgb: [1, 2, 3] } });
      await s.call('underhint', { hwnd: B.hwnd, app: 'quartz-test', top: { kind: 'flat', rgb: [4, 5, 6] } }); await sleep(40);
      const h3 = (await pk()).hints;
      await s.call('underhint', { clear: true }); await sleep(40);
      const h4 = (await pk()).hints;
      t.check('underhint clear forgets every hint (' + h3 + ' -> ' + h4 + ')', h3 === 2 && h4 === 0, h3 + ' -> ' + h4);
      const c0 = (await pk()).cache;
      await up({ flush: true }); await sleep(40);
      const c1 = (await pk()).cache;
      t.check('flush empties the cache (' + c0 + ' -> ' + c1 + ')', c0 > 0 && c1 === 0, c0 + ' -> ' + c1);
      await up({ on: false }); P = null;
      await sleep(200);
    }

    // ================================================================ 5. the real screen (smoke)
    {
      const e0 = s.events.length;
      W = Object.assign({ on: true }, REAL_ROW);
      await s.call('underwatch', W);
      const st = await s.waitEvent('underrow', 4000, (e) => e.kind === 'state' && e.mode !== 'off').catch(() => null);
      if (!st || st.mode !== 'frames') {
        console.log('  SKIP section 5 (real screen): duplication is not running here: ' + (st ? st.mode + ': ' + st.reason : 'no state within 4 s'));
      } else {
        const first = await s.waitEvent('underrow', 3000, (e) => e.kind === 'cols' && s.events.indexOf(e) >= e0).catch(() => null);
        t.check('real: underwatch pushes the row', !!first, 'no push');
        // wait for a still row (no push for 600 ms, up to 6 s): then no frame will hand the new layer its row
        const pushes = (from) => s.events.slice(from).filter((e) => e.ev === 'underrow' && e.kind === 'cols').length;
        let still = false;
        for (let i = 0; i < 10 && !still; i++) { const k = s.events.length; await sleep(600); still = pushes(k) === 0; }
        const R = { on: true, bar: '0', x: 300, y: 600, w: 400, h: 12, rowX: REAL_ROW.x, rowY: REAL_ROW.y, rowW: REAL_ROW.w, n: REAL_ROW.n };
        const eOn = s.events.length;
        await up(R); P = R;
        const got = await until(async () => { const x = await pk(); return x.painted ? x : null; }, 2000, 20);
        t.check('real: the layer gets painted (' + got.ms + ' ms)', !!got.v, JSON.stringify(got.v && got.v.layer));
        if (still && pushes(eOn) === 0) t.check('real: on a still row it is painted from the row read last (' + got.ms + ' ms, no frame crossed the row)', !!got.v && got.ms < 600, got.ms);
        else console.log('  info: the still-row start was not exercised (the row kept changing: ' + (still ? pushes(eOn) + ' pushes after the start' : 'never still for 600 ms') + ')');
        if (got.v && first) {
          const pushes = s.events.slice(e0).filter((e) => e.ev === 'underrow' && e.kind === 'cols').map((e) => buf(e.cols));
          const now = buf((await s.call('underrow', REAL_ROW)).cols);
          const pp = buf(got.v.painted);
          const dFirst = maxDiff(pp, buf(first.cols)), dBest = Math.min(dFirst, maxDiff(pp, now), ...pushes.map((x) => maxDiff(pp, x)));
          t.check('real: the painted row is the row underwatch reads (first push diff ' + dFirst + ', closest ' + dBest + ' levels)', dBest <= 3, dBest);
          t.check('real: mode native, transparent (passive)', got.v.mode === 'native' && /transparent: a test/.test(got.v.layer || ''), got.v.mode + ' / ' + got.v.layer);
        }
        const c0 = cpuMs(s.proc.pid), w0 = Date.now(), pk0 = await pk();
        await sleep(10000);
        const c1 = cpuMs(s.proc.pid), w1 = Date.now(), pk1 = await pk();
        const pct = ((c1 - c0) / (w1 - w0)) * 100;
        console.log('  info: sidecar CPU over ' + ((w1 - w0) / 1000).toFixed(1) + ' s with underwatch + underpaint on the real row: ' + pct.toFixed(2) + '% of one core (' +
          (c1 - c0).toFixed(0) + ' ms); layer paints ' + (pk1.paints - pk0.paints) + ', capture paints ' + (pk1.capturePaints - pk0.capturePaints) + ', events ' + (pk1.events - pk0.events) +
          ', predictions ' + JSON.stringify(pk1.predictions) + ', corrected ' + pk1.corrected + ', confirmed ' + pk1.confirmed + ', ulwFails ' + pk1.ulwFails);
        t.check('real: still native after 10 s, no UpdateLayeredWindow failures', pk1.mode === 'native' && pk1.ulwFails === 0, pk1.mode + ' ' + pk1.ulwFails);
        await up({ on: false }); P = null;
      }
      await s.call('underwatch', { on: false }); W = null;
    }
  } catch (e) {
    t.fail('the run threw', e.stack);
  } finally {
    if (ka) clearInterval(ka);
    if (bar) await bar.quit();
    if (s) await s.stop();
  }
  process.exit(t.summary());
})();
