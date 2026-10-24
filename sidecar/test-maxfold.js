// test-maxfold.js - MaxFold.cs (the quick unfold on maximize/restore), proved on the harness's OWN windows
// (lane unfold-max, 2026-10-23).
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-maxfold.js [--frames=<dir>]   -> "MAXFOLD TEST: n passed, m failed"
//
// PASSIVE and INVISIBLE: the sidecar runs --passive with this script as its parent; every window it animates
// is a sidecar/maxfold-testwin.js window (untitled, owned, disabled, alpha 0, click-through, at the bottom of
// the z-order, closes itself after 90 s) and the overlay is alpha 0 (config invisible:true). A window the
// harness did NOT start (a grandchild through cmd.exe) proves the fence: skipped, never flagged, never posed.
// The foreground window's handle is read before and after: nothing here may take the focus.
// Windows settings are never written: the two reads (Windows' animation, "Animation effects") get the passive
// sidecar's stand-ins (testWinAnim / testReduced).
//
// Checks: the pure decision table (every reason, first match wins); config on/off (thread, hooks, no thread
// while off); the overlay's styles and alpha; real plays (frames, frame gaps, DWM missed frames, first-frame
// latency from ShowWindow by QPC, z-order directly above the window, hidden + parked after); the restore
// flag (record file written before, removed after, cleared once the play started); skips (tiny, tool,
// full-screen popup, capture-hidden, not the harness's, restore without the flag); cancels (moved,
// minimized), the watchdog, the reduced cross-fade, a stale record put back at the first config; and the
// LOOK at p 0/.25/.5/.75/1 (frozen poses grabbed with PrintWindow) against the iPhone Duo spec.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');
const W = require('./maxfold-testwin');

const t = T.checker('MAXFOLD');
const REFUSED = T.PASSIVE_REFUSAL;
const FRAMES = path.resolve((process.argv.find((a) => a.startsWith('--frames=')) || '').slice(9) || path.join(__dirname, '..', 'scratch', 'frames'));
const RECORD = path.join(os.tmpdir(), 'mantle-maxfold-test', 'maxfold-windows.json');
const LOCK = path.join(os.tmpdir(), 'mantle-electron-lock');
const BASE = { r: 4, g: 3, b: 14 }; // lerp(#000, #4436E8, .06): barely any tint (Owen, 23:10)
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mx = (a) => (a.length ? Math.max.apply(null, a) : NaN);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

(async () => {
  let s = null; const wins = []; let locked = false;
  const numbers = {};
  try { fs.mkdirSync(LOCK); locked = true; } catch (_) { /* another Mantle test holds it: timings are marked */ }
  try {
    W.build();
    // ---- a stale record from a "crashed" run, written BEFORE the sidecar starts: put back at the first config
    try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
    const stale = await W.start({ life: 90, x: 60, y: 60, w: 700, h: 500 }); wins.push(stale);
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify({ hwnd: stale.hwnd, pid: stale.pid, set: true, assumedOriginal: false }));

    s = await T.startPassive();
    // ---- off before on: no thread, no hook
    let st = await s.call('maxfold.state', {});
    t.check('before any config: not armed, no thread, no overlay', st.armed === false && st.thread === 'ended' && st.overlay === 0, JSON.stringify(st).slice(0, 200));
    t.check('flag/pose while off answer "switched off"', /switched off/.test((await s.send('maxfold.flag', { window: stale.hwnd, on: true })).error || ''));

    // ---- the pure decision
    const base = { armed: true, passive: false, harness: false, mantle: false, w: 1200, h: 800, action: 'maximize', winAnim: true };
    const cases = [
      [{ armed: false, tool: true }, false, 'switched off'],
      [{ passive: true, harness: false, mantle: true }, false, 'a test run only animates its own test windows'],
      [{ mantle: true, fullScreenApp: true }, false, "one of Mantle's own windows"],
      [{ passive: true, harness: true, mantle: true }, true, null],
      [{ fullScreenApp: true, fullScreenWindow: true }, false, 'a full-screen app or game is running'],
      [{ fullScreenWindow: true, tool: true }, false, 'the window is full screen'],
      [{ tool: true, w: 10 }, false, 'a tool window'],
      [{ child: true }, false, 'a tool window'],
      [{ dragging: true, w: 10 }, false, 'the window is being dragged'],
      [{ w: 239 }, false, 'too small to animate'],
      [{ h: 159, cloaked: true }, false, 'too small to animate'],
      [{ cloaked: true, affinity: 1 }, false, 'the window is hidden or on another desktop'],
      [{ affinity: 17 }, false, 'the app hides itself from screen capture'],
      [{ action: 'restore', thumbHr: -2147024809 }, false, 'Windows animates this restore itself'],
      [{ action: 'restore', flagged: true }, true, null],
      [{ action: 'restore', winAnim: false }, true, null],
      [{ thumbHr: -2147024809 }, false, 'Windows would not let Mantle draw the window (0x80070057)'],
      [{ reduced: true }, true, null, 'reduced'],
      [{}, true, null, 'full'],
    ];
    let bad = [];
    for (const [over, play, reason, mode] of cases) {
      const r = await s.call('maxfold.decide', { facts: Object.assign({}, base, over) });
      if (r.play !== play || (reason && r.reason !== reason) || (mode && r.mode !== mode)) bad.push(`${JSON.stringify(over)} -> ${JSON.stringify(r)}`);
    }
    t.check(`decide: ${cases.length} cases in the spec's order (first match wins)`, bad.length === 0, bad.join(' | '));

    // ---- on: the stale record is put back first
    let c = await s.call('maxfold.config', { on: true, invisible: true, testWinAnim: true, testReduced: false });
    t.check('config on: armed, hooked, passive, invisible', c.armed === true && c.hooked === true && c.passive === true && c.invisible === true, JSON.stringify(c));
    t.check('the record lives in the test folder', c.recordFile === RECORD, c.recordFile);
    const rs = await s.waitEvent('maxfold', 2000, (e) => e.kind === 'restored-stale').catch(() => null);
    t.check('a stale record is put back at the first config (event + record gone)', !!rs && !fs.existsSync(RECORD) && /put Windows' animation back/.test(rs.note || ''), JSON.stringify(rs));
    t.check('the put-back is said in the log', s.events.some((e) => e.ev === 'log' && /stopped unexpectedly last time/.test(e.message || '')));
    await stale.close();

    st = await s.call('maxfold.state', {});
    t.check('state: thread running, overlay made and hidden', st.thread === 'running' && st.overlay > 0 && st.overlayVisible === false, JSON.stringify(st).slice(0, 240));
    const OV = st.overlay;

    // ---- the main test window
    const w = await W.start({ life: 120, x: 140, y: 100, w: 1000, h: 640 }); wins.push(w);
    await w.cmd('seed', 'OK'); await T.sleep(150);
    const fg0 = await w.cmd('fg');
    let info = W.parseInfo(await w.cmd(`info ${OV}`));
    t.check('overlay: layered + transparent + no-activate + tool window, redirected (not NOREDIRECTIONBITMAP)',
      info && (info.ex & 0x80000) && (info.ex & 0x20) && (info.ex & 0x8000000) && (info.ex & 0x80) && !(info.ex & 0x200000), JSON.stringify(info));
    t.check('overlay: alpha 0 in a test (invisible), hidden at rest', info && info.lwaOk && info.alpha === 0 && !info.visible, JSON.stringify(info));

    const doneN = (n) => s.waitEvent('maxfold', 3000, (e) => e.kind === 'done' && s.collect('maxfold').filter((x) => x.kind === 'done').indexOf(e) === n);
    let doneCount = 0;
    const lat = { max: [], restore: [] }, first = [], gaps = [], frames = [], missed = [], totals = [], cut = [], taps = [], rms = [];
    for (let i = 0; i < 6; i++) {
      // maximize
      const m = await w.cmd('max', 'OK');
      const during = W.parseInfo(await w.cmd(`info ${OV}`));
      const rect = await w.cmd('rect');
      const d = await doneN(doneCount++);
      const q = Number(/qpc=(\d+)/.exec(m)[1]);
      lat.max.push((d.shownQpc - q) / w.freq * 1000); first.push(d.firstFrameMs);
      taps.push(d.maxTaps); rms.push(d.renderMaxMs);
      if (d.cancelled) cut.push(`max:${d.cancelWhy}`); else { gaps.push(d.gapMaxMs); frames.push(d.frames); missed.push(d.missedDelta); totals.push(d.totalMs); }
      if (i === 0) {
        const fr = /frame (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(rect).slice(1).map(Number);
        t.check('while it plays: the overlay is shown directly above the window, over its frame', during && during.visible && during.above === OV &&
          during.rect.l === fr[0] && during.rect.t === fr[1] && during.rect.r === fr[2] && during.rect.b === fr[3], `${JSON.stringify(during)} vs frame ${fr}`);
        t.check('maximize: done, full mode, ended sharp, not cancelled', d.action === 'maximize' && d.mode === 'full' && d.endedSharp === true && d.cancelled === false, JSON.stringify(d).slice(0, 300));
        t.check('maximize: holds the converged frame until Windows\' morph is over (total >= holdMs)', d.totalMs >= 295, String(d.totalMs));
        const after = W.parseInfo(await w.cmd(`info ${OV}`));
        t.check('after a play: overlay hidden and parked at 1x1', after && !after.visible && after.rect.r - after.rect.l === 1 && after.rect.b - after.rect.t === 1, JSON.stringify(after));
        const sk = await w.cmd('restore', 'OK');
        const skip = await s.waitEvent('maxfold', 2000, (e) => e.kind === 'skip' && e.action === 'restore').catch(() => null);
        t.check('restore without the flag (Windows animation on): skipped, said why', !!skip && skip.reason === 'Windows animates this restore itself', JSON.stringify(skip) + ' ' + sk);
        await w.cmd('max', 'OK');
        await T.sleep(50);
        await doneN(doneCount++);
      }
      const fl = await s.call('maxfold.flag', { window: w.hwnd, on: true });
      const rec = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : null;
      if (i === 0) {
        t.check('flag: set on the harness window, the record written first ({hwnd, pid, set, assumedOriginal})', fl.flagged && fl.set && rec &&
          rec.hwnd === w.hwnd && rec.pid === w.pid && rec.set === true && rec.assumedOriginal === false, JSON.stringify({ fl, rec }));
        st = await s.call('maxfold.state', {});
        t.check('state names the flagged window', st.flagged === 1 && st.flaggedHwnd === w.hwnd && st.recordExists === true, JSON.stringify(st).slice(0, 200));
      }
      const r = await w.cmd('restore', 'OK');
      const d2 = await doneN(doneCount++);
      const q2 = Number(/qpc=(\d+)/.exec(r)[1]);
      lat.restore.push((d2.shownQpc - q2) / w.freq * 1000); first.push(d2.firstFrameMs);
      taps.push(d2.maxTaps); rms.push(d2.renderMaxMs);
      if (d2.cancelled) cut.push(`restore:${d2.cancelWhy}`); else { gaps.push(d2.gapMaxMs); frames.push(d2.frames); missed.push(d2.missedDelta); }
      if (i === 0) {
        t.check('restore (flagged): done, ended sharp, no hold (no morph to hide)', d2.action === 'restore' && d2.endedSharp && !d2.cancelled && d2.totalMs < 290, JSON.stringify(d2).slice(0, 300));
        st = await s.call('maxfold.state', {});
        t.check('restore: the flag is cleared once the play started, the record deleted', st.flagged === 0 && !fs.existsSync(RECORD), JSON.stringify(st).slice(0, 200));
      }
    }
    numbers.latencyMax = lat.max.map(f2).join(' '); numbers.latencyRestore = lat.restore.map(f2).join(' ');
    numbers.firstFrame = first.map(f2).join(' '); numbers.frames = frames.join(' '); numbers.gapMax = gaps.map(f2).join(' ');
    numbers.missed = missed.join(' '); numbers.totalMaxMs = totals.map(f2).join(' ');
    numbers.maxTaps = taps.join(' '); numbers.renderMaxMs = rms.map(f2).join(' ');
    const lk = locked ? '' : ' [LOCK NOT HELD]';
    numbers.cutByInput = cut.join(' ') || 'none';
    // Owen is at the PC: a real key press mid-play cancels it BY DESIGN; only that reason is excused.
    t.check(`timed plays: none cancelled except by real input (${numbers.cutByInput})`, cut.every((x) => /:input$/.test(x)) && frames.length >= 8);
    t.check(`frames: every play >= 10 frames over ~0.24 s (${frames.join(',')})`, frames.every((n) => n >= 10));
    t.check(`frame pacing: worst gap per play <= 34 ms, no DWM missed frames (gaps ${numbers.gapMax}; missed ${numbers.missed})${lk}`,
      gaps.every((g) => g <= 34) && missed.every((n) => n === 0 || n === null));
    t.check(`first frame: hook -> overlay shown median <= 8 ms (${numbers.firstFrame})${lk}`, med(first) <= 8);
    t.check(`latency: the window change -> overlay shown median <= 17 ms (one frame) (max ${numbers.latencyMax}; restore ${numbers.latencyRestore})${lk}`,
      med(lat.max.concat(lat.restore)) <= 17);

    // ---- cancels
    await w.cmd('max', 'OK');
    await T.sleep(40);
    await w.cmd('move 200 140 900 600', 'OK');
    let d = await doneN(doneCount++);
    t.check('a window that moves again mid-play: cancelled at once ("moved"), not sharp', d.cancelled && d.cancelWhy === 'moved' && d.endedSharp === false && d.totalMs < 200, JSON.stringify(d).slice(0, 260));
    await w.cmd('restore', 'OK'); await T.sleep(100);
    await w.cmd('max', 'OK'); await T.sleep(40);
    await w.cmd('min', 'OK');
    d = await doneN(doneCount++);
    t.check('minimized mid-play: cancelled', d.cancelled === true && /minimized|closed/.test(d.cancelWhy || ''), JSON.stringify(d).slice(0, 260));
    await w.cmd('restore', 'OK'); await T.sleep(200);   // back from minimized = maximized again (never animated)
    await w.cmd('restore', 'OK'); await T.sleep(150);   // maximized -> normal: a restore without the flag, a skip

    // ---- the watchdog: the thread is blocked mid-play, another thread hides the overlay
    await s.call('maxfold.stall', { ms: 1100 });
    await w.cmd('max', 'OK');
    await T.sleep(800);
    info = W.parseInfo(await w.cmd(`info ${OV}`));
    d = await doneN(doneCount++);
    t.check('watchdog: a play whose thread is stuck is hidden from another thread, then ended', /watchdog/.test(d.cancelWhy || '') && d.cancelled && d.endedSharp === false, JSON.stringify({ info, d }).slice(0, 300));
    t.check('watchdog: said in the log', s.events.some((e) => e.ev === 'log' && /watchdog/.test(e.message || '')));
    await w.cmd('restore', 'OK'); await T.sleep(150); // not flagged: a skip
    for (let k = 0; k < 40 && (await s.call('maxfold.state', {})).playing; k++) await T.sleep(50);
    doneCount = s.collect('maxfold').filter((x) => x.kind === 'done').length;

    // ---- reduced motion ("Animation effects" off): a 120 ms cross-fade
    await s.call('maxfold.config', { on: true, invisible: true, testWinAnim: false, testReduced: true });
    await w.cmd('max', 'OK');
    d = await doneN(doneCount++);
    t.check('reduced motion: a short cross-fade (mode reduced, ~120 ms, sharp end)', d.mode === 'reduced' && d.endedSharp && d.totalMs < 200 && d.frames >= 4, JSON.stringify(d).slice(0, 260));
    await w.cmd('restore', 'OK');
    d = await doneN(doneCount++);
    t.check('Windows animation off: a restore plays without the flag', d.action === 'restore' && !d.cancelled, JSON.stringify(d).slice(0, 200));
    await s.call('maxfold.config', { on: true, invisible: true, testWinAnim: true, testReduced: false });

    // ---- skips on our own odd windows
    async function skipOf(mode, prep) {
      const x = await W.start({ mode, life: 60, x: 300, y: 200, w: 900, h: 600 }); wins.push(x);
      await x.cmd('seed', 'OK'); await T.sleep(120);
      if (prep) await x.cmd(prep, 'AFF');
      const n0 = s.collect('maxfold').length;
      await x.cmd('max', 'OK');
      const e = await s.waitEvent('maxfold', 2000, (ev) => (ev.kind === 'skip' || ev.kind === 'play') && s.events.indexOf(ev) >= 0 && s.collect('maxfold').indexOf(ev) >= n0).catch(() => null);
      await x.close();
      return e;
    }
    let e = await skipOf('tiny');
    t.check('a window too small: "too small to animate"', e && e.kind === 'skip' && e.reason === 'too small to animate', JSON.stringify(e));
    e = await skipOf('tool');
    t.check('a tool window: "a tool window"', e && e.kind === 'skip' && e.reason === 'a tool window', JSON.stringify(e));
    e = await skipOf('popup');
    t.check('a captionless popup filling the monitor: "the window is full screen"', e && e.kind === 'skip' &&
      (e.reason === 'the window is full screen' || e.reason === 'a full-screen app or game is running'), JSON.stringify(e));
    e = await skipOf('normal', 'affinity');
    t.check('a window hidden from capture: "the app hides itself from screen capture"', e && e.kind === 'skip' && e.reason === 'the app hides itself from screen capture', JSON.stringify(e));

    // ---- the fence: a window this harness did NOT start
    const other = await W.start({ via: 'cmd', life: 60, x: 320, y: 220, w: 900, h: 600 }); wins.push(other);
    await other.cmd('seed', 'OK'); await T.sleep(150);
    const n1 = s.collect('maxfold').length;
    await other.cmd('max', 'OK');
    e = await s.waitEvent('maxfold', 2000, (ev) => s.collect('maxfold').indexOf(ev) >= n1).catch(() => null);
    t.check('not the harness\'s window: skipped, "a test run only animates its own test windows"', e && e.kind === 'skip' && e.reason === 'a test run only animates its own test windows', JSON.stringify(e));
    const rf = await s.send('maxfold.flag', { window: other.hwnd, on: true });
    const rp = await s.send('maxfold.pose', { window: other.hwnd, p: 0.5 });
    t.check('flag and pose refuse a window the harness did not make', !rf.ok && rf.error.startsWith(REFUSED) && !rp.ok && rp.error.startsWith(REFUSED), `${rf.error} | ${rp.error}`);
    st = await s.call('maxfold.state', {});
    t.check('...and nothing was set on it (no flag, no record)', st.flaggedHwnd !== other.hwnd && !fs.existsSync(RECORD), JSON.stringify(st).slice(0, 200));
    await other.close();

    // ---- the LOOK: frozen frames at p 0 / .25 / .5 / .75 / 1 over the maximized window
    fs.mkdirSync(FRAMES, { recursive: true });
    await w.cmd('max', 'OK'); await doneN(doneCount++);
    const look = [];
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const pz = await s.call('maxfold.pose', { window: w.hwnd, p }, 6000);
      const tag = String(Math.round(p * 100)).padStart(3, '0');
      const png = path.join(FRAMES, `maxfold-p${tag}.png`);
      const b = W.parseBands(await w.cmd(`bands ${pz.overlay} 20 ${png} ${p === 0 ? path.join(FRAMES, 'maxfold-source.png') : '-'}`, 'BANDS', 20000));
      look.push({ p, pz, b, png });
    }
    await s.call('maxfold.pose', { off: true });
    const L = lookChecks(look);
    for (const [name, ok, detail] of L) t.check(name, ok, detail);
    numbers.framePngs = look.map((x) => x.png).join(' ');
    for (const [name, ok] of L) console.log(`  look ${ok ? 'ok' : 'FAIL'}: ${name}`);

    // reduced pose: whole window, sharp, darker
    const pr = await s.call('maxfold.pose', { window: w.hwnd, p: 0, reduced: true });
    const br = W.parseBands(await w.cmd(`bands ${pr.overlay} 10 ${path.join(FRAMES, 'maxfold-reduced-p000.png')}`, 'BANDS', 20000));
    await s.call('maxfold.pose', { off: true });
    t.check('reduced frame: the whole window at .7 over the base, sharp everywhere (no blur)', br && br.bands.every((x) => Math.abs(x.gradO / (0.7 * x.gradS) - 1) < 0.12),
      br && br.bands.map((x) => f2(x.gradO / (0.7 * x.gradS))).join(' '));

    // ---- nothing took the focus, and nothing activated a test window
    const fgEnd = await w.cmd('fg');
    t.check('the foreground is never one of the test windows (Owen may change it himself)', !wins.some((x) => fgEnd === 'FG ' + x.hwnd), `${fg0} -> ${fgEnd}`);
    st = await s.call('maxfold.state', {});
    t.check('no test window ever became the foreground', st.fgHarness === 0, String(st.fgHarness));

    // ---- off: unhook, hide, no thread, no record
    c = await s.call('maxfold.config', { on: false });
    st = await s.call('maxfold.state', {});
    t.check('off: not armed, thread ended, overlay gone, no record', c.armed === false && st.thread === 'ended' && st.overlay === 0 && !fs.existsSync(RECORD), JSON.stringify(st).slice(0, 200));
    const n2 = s.collect('maxfold').length;
    await w.cmd('restore', 'OK'); await w.cmd('max', 'OK'); await T.sleep(400);
    t.check('off: a maximize makes no event at all (no hook)', s.collect('maxfold').length === n2);
  } catch (e) {
    t.fail('the run threw', e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
  } finally {
    for (const w of wins) { try { await w.close(); } catch (_) { /* gone */ } }
    if (s) await s.stop();
    try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
    if (locked) { try { fs.rmdirSync(LOCK); } catch (_) { /* gone */ } }
  }
  for (const k of Object.keys(numbers)) console.log(`  ${k}: ${numbers[k]}`);
  if (process.env.MAXFOLD_TEST_TRACE === '1' && s) {
    console.log('  trace: ' + s.collect('maxfold').map((e) => `${e.kind}:${e.action || ''}${e.reason ? '(' + e.reason + ')' : ''}${e.cancelWhy ? '[' + e.cancelWhy + ']' : ''}${e.mode === 'reduced' ? '{r}' : ''}`).join(' '));
  }
  process.exit(t.summary());
})();

/** The Duo spec, band by band (20 column bands; cover = left half, hinge at band 10). Returns [name, ok, detail]. */
function lookChecks(look) {
  const out = [];
  const lumB = 0.114 * BASE.b + 0.587 * BASE.g + 0.299 * BASE.r;
  for (const { p, pz, b } of look) {
    const tag = `p=${p}`;
    if (!b || !b.ok) { out.push([`${tag}: the overlay could be grabbed`, false, JSON.stringify(b).slice(0, 200)]); continue; }
    const n = b.bands.length, bw = b.w / n;
    if (p === 1) {
      out.push([`${tag}: the last frame is identical to the window (mean diff ${f2(b.diff)}, max ${b.max})`, b.diff < 0.5 && b.max <= 16, '']);
      continue;
    }
    // cover half: sharp (gradient = coverage x the window's), brightness = inner x window + (1 - inner) x base
    const cover = b.bands.slice(0, n / 2);
    const sharpC = cover.map((x) => x.gradO / (pz.inner * x.gradS));
    const lumErr = cover.map((x) => Math.abs(x.lumO - (pz.inner * x.lumS + (1 - pz.inner) * lumB)));
    out.push([`${tag}: the cover half is in place and sharp (sharpness ${f2(med(sharpC))}, brightness error ${f2(mx(lumErr))})`,
      sharpC.every((v) => v > 0.88 && v < 1.12) && mx(lumErr) < 5, sharpC.map(f2).join(' ')]);
    // the opening panel: bands fully inside [xh, xh + pw)
    const open = []; const beyond = [];
    for (let i = n / 2; i < n; i++) {
      const x0 = i * bw - pz.xh, x1 = (i + 1) * bw - pz.xh;
      if (x1 <= pz.pw) open.push({ i, d: (x0 + x1) / 2 / Math.max(1, pz.pw), x: b.bands[i] });
      else if (x0 >= pz.pw) beyond.push(b.bands[i]);
    }
    if (beyond.length) {
      // the not-yet-open part: the window's outline, dim (pz.beyond of it over the base), as soft as the free edge
      const lumErrB = beyond.map((x) => Math.abs(x.lumO - (pz.beyond * x.lumS + (1 - pz.beyond) * lumB)));
      const shB = beyond.map((x) => x.gradO / (pz.beyond * Math.max(1e-6, x.gradS)));
      out.push([`${tag}: beyond the free edge the window's outline shows, dim (${f2(pz.beyond)}) and soft (brightness error ${f2(mx(lumErrB))}; sharpness ${shB.map(f2).join(' ')})`,
        mx(lumErrB) < 5 && shB.every((v) => v > 0.15 && v < 1.15), '']);
    }
    if (p === 0) { out.push([`${tag}: the panel has not opened (width ${pz.pw})`, pz.pw === 0, '']); continue; }
    if (open.length >= 2) {
      const cov = (d) => pz.inner * (1 - pz.darkEdge * d);
      const sharp = open.map((o) => o.x.gradO / (cov(o.d) * o.x.gradS));
      const dark = open.map((o) => o.x.lumO / o.x.lumS);
      const tint = open.map((o) => o.x.tintO - o.x.tintS);
      const last = sharp.length - 1;
      // blur radius at the free edge = blurPx * d^3: a clear falloff only when the edge blur is a few px
      if (pz.blurPx > 1.5) {
        out.push([`${tag}: sharp at the hinge, blurrier toward the moving edge (edge blur ${f2(pz.blurPx)} px; ${sharp.map(f2).join(' ')})`,
          sharp[0] > 0.8 && sharp[last] < sharp[0] - (pz.blurPx > 4 ? 0.1 : 0.03), '']);
      } else {
        out.push([`${tag}: nearly landed: sharp across the panel (edge blur ${f2(pz.blurPx)} px; ${sharp.map(f2).join(' ')})`, sharp.every((v) => v > 0.85 && v < 1.15), '']);
      }
      if (pz.s > 0.05) {
        out.push([`${tag}: darker toward the moving edge (${dark.map(f2).join(' ')})`, dark[last] < dark[0] - 0.02, '']);
        // Owen 23:10: "barely any" tint: a faint indigo hint near the moving edge only while the shade shows
        if (pz.shadeEdge >= 0.1) out.push([`${tag}: a faint indigo hint toward the moving edge (b-g shift ${tint.map(f2).join(' ')})`, tint[last] > tint[0], '']);
        out.push([`${tag}: barely any tint anywhere (b-g shift ${tint.map(f2).join(' ')} <= 8)`, tint.every((v) => Math.abs(v) <= 8), '']);
      } else {
        out.push([`${tag}: nearly landed: brightness close to the window's (${dark.map(f2).join(' ')})`, dark.every((v) => v > 0.9), '']);
      }
    }
  }
  return out;
}
