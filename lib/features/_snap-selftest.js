'use strict';
/*
 * _snap-selftest.js - the snap feature proving itself inside an Electron --test instance
 * (MANTLE_SNAP_SELFTEST=1; loaded only by lib/features/snap.js, and only in --test).
 *
 * WHAT IT DRIVES: the real chords through ctx.test.fireChord (routed exactly like the hook), the
 * real sidecar (passive: it refuses any window this process did not make), the real page (its
 * keyboard handler, fed KeyboardEvents inside the page: no OS input anywhere), and real DWM
 * pictures registered into the (never shown) snap window.
 *
 * WHAT IT MOVES: only four small windows it creates itself (frame, resize border, focusable:false
 * = WS_EX_NOACTIVATE, shown inactive, pushed to the bottom of the z-order). The foreground window's
 * HANDLE is read before and after: the run fails if it changed. Titles of other windows are never
 * read or written anywhere.
 *
 * Results: one line in mantle.log and %TEMP%\mantle-snap\selftest.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'mantle-snap', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let halt = false;

function start(k) {
  (async () => {
    const t0 = Date.now();
    while (!halt && Date.now() - t0 < 20000 && !(k.S.sidecar.ok && k.S.page.ok)) await sleep(100);
    if (halt) return;
    const out = { at: new Date().toISOString(), results: [], notes: [] };
    try { await run(k, out); } catch (e) { out.results.push({ name: 'no exception', ok: false, detail: String(e && e.stack) }); }
    finish(k, out);
  })();
}

function stop() { halt = true; }

function finish(k, out) {
  out.pass = out.results.filter((r) => r.ok).length;
  out.fail = out.results.length - out.pass;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); } catch (_) { /* the log line still says it */ }
  k.ctx.log(`selftest: ${out.pass} passed, ${out.fail} failed (${OUT})`);
  for (const r of out.results) if (!r.ok) k.ctx.log(`selftest FAIL ${r.name}: ${String(r.detail || '').slice(0, 300)}`);
}

const half = (o, s, n, d) => o + Math.floor((2 * s * n + d) / (2 * d));
function cell(work, cols, rows, x, y, w, h) {
  const W = work.w, H = work.h;
  const l = half(work.x, W, x, cols), t = half(work.y, H, y, rows);
  const r = half(work.x, W, x + w, cols), b = half(work.y, H, y + h, rows);
  return { x: l, y: t, w: r - l, h: b - t };
}
const Z = { left: [2, 1, 0, 0, 1, 1], right: [2, 1, 1, 0, 1, 1], tl: [2, 2, 0, 0, 1, 1], tr: [2, 2, 1, 0, 1, 1], bl: [2, 2, 0, 1, 1, 1], br: [2, 2, 1, 1, 1, 1] };
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const fmt = (r) => (r ? `${r.x},${r.y} ${r.w}x${r.h}` : String(r));

async function run(k, out) {
  const { ctx, S, screen, BrowserWindow, hwndOf, thumbs } = k;
  const check = (name, ok, detail) => { out.results.push(ok ? { name, ok: true } : { name, ok: false, detail }); return !!ok; };
  const send = (cmd, args) => ctx.sidecar.send(cmd, args || {}, { timeoutMs: 4000 });
  const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return !!pred(); };
  const frameOf = async (hwnd) => { const r = await send('snap.info', { hwnd }); return r.ok ? r.result.frame : null; };
  const key = (name) => S.win.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true })); true`);

  const fg0 = await send('snap.info', {});
  const fgBefore = fg0.ok ? fg0.result.hwnd : 'none';

  // ---- our own windows
  const prim = screen.getPrimaryDisplay().workArea;
  const mk = (name, i, opts) => {
    const w = new BrowserWindow(Object.assign({
      x: prim.x + 40 + i * 36, y: prim.y + 60 + i * 36, width: 420, height: 300,
      show: false, frame: true, resizable: true, focusable: false, skipTaskbar: true,
      title: `Mantle snap test ${name}`, backgroundColor: '#e8ecf4',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    }, opts || {}));
    w.loadURL('data:text/html,' + encodeURIComponent(`<title>Mantle snap test ${name}</title><body style="font:28px sans-serif;background:#e8ecf4;color:#333a4e">snap test ${name}</body>`));
    w.showInactive();
    const hwnd = String(hwndOf(w));
    try { thumbs.toBack(hwnd); } catch (_) { /* best effort: it was shown inactive anyway */ }
    const t = { win: w, hwnd, name };
    S.testWindows.push(t);
    return t;
  };
  const A = mk('A', 0), B = mk('B', 1), C = mk('C', 2), F = mk('F (fixed size)', 3, { resizable: false, maximizable: false });
  await sleep(600);

  const infoA = (await send('snap.info', { hwnd: A.hwnd })).result;
  if (!check('test window A is measured by the sidecar', infoA && infoA.frame, JSON.stringify(infoA))) return;
  const work = infoA.monitor.work;
  const pre = infoA.frame;
  out.notes.push(`A: dpi ${infoA.dpi}, borders ${JSON.stringify(infoA.margins)}, frame ${fmt(pre)}, work ${fmt(work)}`);
  const zone = (n) => cell(work, ...Z[n]);

  const timings = [];
  async function chord(c) {
    const n = S.moves;
    const t0 = Date.now();
    const fired = ctx.test.fireChord(c);
    await until(() => S.moves > n, 5000);
    const r = S.last && S.last.r;
    const x = r && r.ok ? r.result : null;
    if (x) timings.push({ chord: c, keyToDone: S.last.ms, sidecar: x.ms, moves: x.moves });
    return { fired, x, err: r && !r.ok ? r.error : null, wall: Date.now() - t0 };
  }
  async function step(c, to, want, hwnd) {
    const s = await chord(c);
    const f = await frameOf(hwnd || A.hwnd);
    check(`${c} -> ${to}${want ? ' at exactly ' + fmt(want) : ''}`, s.x && s.x.ok && s.x.to === to && (!want || same(f, want)),
      JSON.stringify({ fired: s.fired, err: s.err, x: s.x && { ok: s.x.ok, from: s.x.from, to: s.x.to, moves: s.x.moves, reason: s.x.reason }, frame: f }));
    return s;
  }

  S.testTarget = A.hwnd;

  // ---- Win+Left, then Snap Assist fills the right half with a window picked by keyboard
  let s = await step('Win+Left', 'left', zone('left'));
  check('the chord was delivered through the feature router', s.fired && s.fired.delivered !== false, JSON.stringify(s.fired));
  check('a normal window moves with ONE SetWindowPos', s.x && s.x.moves === 1, s.x && s.x.moves);
  check('Snap Assist opened for the right half', S.sess && S.sess.mode === 'assist' && S.sess.cands.length === 3,
    JSON.stringify(S.sess && { mode: S.sess.mode, n: S.sess.cands && S.sess.cands.length }));
  await until(() => S.sess && S.sess.thumbs, 3000);
  const th = S.sess && S.sess.thumbs;
  check('Snap Assist registered a live DWM picture per window', th && th.ok && th.thumbs.filter((t) => t.ok).length === 3,
    JSON.stringify(th && { ok: th.ok, reason: th.reason, t: th.thumbs.map((t) => t.ok || t.reason) }));
  out.notes.push(`assist: page drawn ${S.sess && S.sess.painted ? Math.round(S.sess.painted.at - S.sess.t0) : '?'} ms after the session began`);
  await key('ArrowRight');
  await key('Enter');
  await until(() => S.lastPick && S.lastPick.hwnd === C.hwnd, 3000);
  await sleep(50);
  check('ArrowRight + Enter in the page put window C in the right half', same(await frameOf(C.hwnd), zone('right')), fmt(await frameOf(C.hwnd)));
  check('...and the assist closed (one zone, filled)', !S.sess || S.sess.mode !== 'assist');

  // ---- the quarter ladder; the assist that follows each snap is closed by the next chord
  await step('Win+Up', 'tl', zone('tl'));
  check('after left -> top-left quarter, Snap Assist offers the bottom-left quarter', S.sess && S.sess.mode === 'assist');
  await key('Escape');
  await until(() => !S.sess, 2000);
  check('Esc in the page closes Snap Assist', !S.sess && S.ended && S.ended.why === 'Esc', JSON.stringify(S.ended));
  await step('Win+Down', 'left', zone('left'));
  await step('Win+Down', 'bl', zone('bl'));
  await step('Win+Right', 'br', zone('br'));
  await step('Win+Up', 'right', zone('right'));
  s = await step('Win+Left', 'normal', pre);
  check('Win+Left from the right half put back the pre-snap frame', s.x && s.x.restoredFrom === 'remembered', s.x && s.x.restoredFrom);

  // ---- Win+Up on a window that is not the active one: refused, and the notice says why
  s = await chord('Win+Up');
  check('Win+Up is refused (a test window is never the active one) and a notice says why', s.x && s.x.ok === false &&
    S.sess && S.sess.mode === 'notice' && /only maximizes the active window/.test(s.x.reason || ''), JSON.stringify(s.x && s.x.reason));

  // ---- Win+Z: thirds by keyboard, then Snap Assist fills the other two thirds
  const n0 = S.seq;
  ctx.test.fireChord('Win+Z');
  await until(() => S.sess && S.sess.mode === 'picker' && S.sess.seq > n0 && S.sess.painted, 3000);
  check('Win+Z opened the layout picker and the page drew it', S.sess && S.sess.mode === 'picker' && !!S.sess.painted);
  await key('ArrowRight');
  await key('ArrowRight');
  await key('Enter');
  await until(() => S.lastPick && S.lastPick.layout === 'thirds', 3000);
  await until(() => S.sess && S.sess.mode === 'assist', 2000);
  check('the picker put A in the left third', same(await frameOf(A.hwnd), cell(work, 3, 1, 0, 0, 1, 1)), fmt(await frameOf(A.hwnd)));
  check('Snap Assist offers the middle third next (2 zones left)', S.sess && S.sess.mode === 'assist' && S.sess.zones.length === 2,
    JSON.stringify(S.sess && { mode: S.sess.mode, z: S.sess.zones && S.sess.zones.length }));
  await until(() => S.sess && S.sess.thumbs, 2000);
  await key('ArrowRight');
  await key('Enter');
  await until(() => S.lastPick && S.lastPick.hwnd === C.hwnd && S.sess && S.sess.zones && S.sess.zones.length === 1, 3000);
  check('C went to the middle third', same(await frameOf(C.hwnd), cell(work, 3, 1, 1, 0, 1, 1)), fmt(await frameOf(C.hwnd)));
  check('...and Snap Assist moved on to the right third without C', S.sess && S.sess.mode === 'assist' && S.sess.cands.every((c) => c.hwnd !== C.hwnd),
    JSON.stringify(S.sess && S.sess.cands && S.sess.cands.map((c) => c.hwnd === B.hwnd ? 'B' : c.hwnd === F.hwnd ? 'F' : '?')));
  await until(() => S.sess && S.sess.thumbs, 2000);
  await key('Enter');
  await until(() => S.lastPick && S.lastPick.hwnd === B.hwnd, 3000);
  await sleep(50);
  check('B went to the right third, and the three thirds tile the work area', same(await frameOf(B.hwnd), cell(work, 3, 1, 2, 0, 1, 1)), fmt(await frameOf(B.hwnd)));

  // ---- a fixed-size window: refused in words, from both roads
  S.testTarget = F.hwnd;
  s = await chord('Win+Left');
  check('a fixed-size window is refused by Win+Left, with the reason on the notice', s.x && s.x.ok === false && /fixed size/.test(s.x.reason || '') &&
    S.sess && S.sess.mode === 'notice', JSON.stringify(s.x && s.x.reason));
  ctx.test.fireChord('Win+Z');
  await until(() => S.sess && S.sess.mode === 'notice' && S.sess.seq > n0 + 1, 2000);
  check('...and by Win+Z', S.sess && S.sess.mode === 'notice');

  const fg1 = await send('snap.info', {});
  check('the active window is the same one before and after (nothing here took the focus)', (fg1.ok ? fg1.result.hwnd : 'none') === fgBefore,
    `before ${fgBefore}, after ${fg1.ok ? fg1.result.hwnd : fg1.error}; ours: ${[A, B, C, F].map((t) => t.hwnd).join(',')}`);

  const moves = timings.filter((t) => typeof t.keyToDone === 'number');
  const med = (a) => { const v = a.slice().sort((p, q) => p - q); return v[v.length >> 1]; };
  out.notes.push(`key -> moved (main, round trip included): median ${med(moves.map((t) => t.keyToDone))} ms, max ${Math.max(...moves.map((t) => t.keyToDone))} ms over ${moves.length} chords`);
  out.notes.push(`sidecar share: median ${med(moves.map((t) => t.sidecar))} ms; moves per snap: ${JSON.stringify(moves.map((t) => t.moves))}`);
  out.timings = timings;

  S.testTarget = null;
  k.end('self-check done');
  for (const t of [A, B, C, F]) { try { t.win.destroy(); } catch (_) { /* gone */ } }
  S.testWindows = [];
}

module.exports = { start, stop };
