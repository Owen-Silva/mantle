// test-snap.js - Snap.cs, proved two ways (wave 3, 2026-09-24).
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-snap.js
//
// 1. PURE: `snap.plan` runs the geometry and the Win+arrow state machine on made-up monitors
//    (100 / 125 / 150 %, three side by side, a top app bar, odd widths). Every expected rect below is
//    worked out here by hand-written arithmetic, not by asking the sidecar twice.
// 2. LIVE, ON OUR OWN WINDOWS ONLY: the sidecar runs --passive with this harness as its parent, and
//    this harness starts small PowerShell WinForms windows of its own. They are created
//    WS_EX_NOACTIVATE + shown without activation + pushed to the BOTTOM of the z-order, and they
//    close themselves after a minute even if this script dies. Every snap.move / snap.zone names
//    one of them by hwnd. The passive fence refuses anything else, and one test proves it does
//    (on a window of ours that the harness did NOT start directly). The foreground window is read
//    (its handle only) before and after: nothing here may change it.
// Prints one summary line; exits non-zero on any failure.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXE = path.resolve(process.env.MANTLE_SIDECAR_EXE ||
  (process.argv.find((a) => a.startsWith('--exe=')) || '').slice(6) || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe'));
const PASSIVE = 'refused: sidecar is passive (test mode)';
const TMP = path.join(os.tmpdir(), 'mantle-snap');

let pass = 0, fail = 0;
const notes = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + (detail ? '  -- ' + detail : '')); }
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSidecar() {
  const proc = spawn(EXE, ['--passive', '--parent-pid=' + process.pid], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buf = '', id = 1, ready;
  const readyP = new Promise((r) => { ready = r; });
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.ev === 'ready') ready(m);
      else if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  proc.stderr.on('data', () => {});
  const send = (cmd, args, ms) => new Promise((resolve) => {
    const n = id++;
    const t = setTimeout(() => { pending.delete(n); resolve({ ok: false, error: 'timeout after ' + (ms || 5000) + ' ms' }); }, ms || 5000);
    pending.set(n, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify(Object.assign({ id: n, cmd }, args || {})) + '\n');
  });
  return { proc, send, ready: readyP };
}

// ---------------------------------------------------------------- the geometry, by hand
const half = (o, s, n, d) => o + Math.floor((2 * s * n + d) / (2 * d));
function cell(work, cols, rows, x, y, w, h) {
  const [l, t, r, b] = work, W = r - l, H = b - t;
  return [half(l, W, x, cols), half(t, H, y, rows), half(l, W, x + w, cols), half(t, H, y + h, rows)];
}
const ZONES = { left: [2, 1, 0, 0, 1, 1], right: [2, 1, 1, 0, 1, 1], tl: [2, 2, 0, 0, 1, 1], tr: [2, 2, 1, 0, 1, 1], bl: [2, 2, 0, 1, 1, 1], br: [2, 2, 1, 1, 1, 1] };
const zone = (work, name) => cell(work, ...ZONES[name]);
const xywh = (r) => r && { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
const same = (a, b, tol) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= (tol || 0));
const fmt = (r) => r ? `${r.x},${r.y} ${r.w}x${r.h}` : String(r);

async function pure(s) {
  const one = [{ id: 'A', bounds: [0, 0, 1920, 1080], work: [0, 0, 1920, 1040], dpi: 96, primary: true }];
  const frame = [100, 100, 900, 700], win = [93, 100, 907, 707];   // 7/0/7/7: a 100 % standard frame
  const plan = (x) => s.send('snap.plan', Object.assign({ monitors: one, frame, window: win }, x));

  // halves, with the invisible borders added back
  let r = await plan({ dir: 'left' });
  check('plan: Win+Left on a normal window is the left half of the WORK area', r.ok && r.result.action === 'snap' &&
    same(r.result.frame, xywh([0, 0, 960, 1040])), JSON.stringify(r).slice(0, 300));
  check('plan: the window rect carries the 7/0/7/7 invisible borders', r.ok && same(r.result.window, xywh([-7, 0, 967, 1047])) &&
    r.result.marginsOk === true, JSON.stringify(r.result && r.result.window));
  check('plan: Snap Assist is offered the right half', r.ok && r.result.assist.length === 1 && same(r.result.assist[0].frame, xywh([960, 0, 1920, 1040])));
  r = await plan({ dir: 'right' });
  check('plan: Win+Right is the right half', r.ok && same(r.result.frame, xywh([960, 0, 1920, 1040])));
  r = await plan({ dir: 'up' });
  check('plan: Win+Up on a normal window maximizes', r.ok && r.result.action === 'maximize' && r.result.to === 'max');
  r = await plan({ dir: 'down' });
  check('plan: Win+Down on a normal window minimizes', r.ok && r.result.action === 'minimize');
  r = await plan({ dir: 'down', maximized: true });
  check('plan: Win+Down on a maximized window restores (then a second Win+Down minimizes)', r.ok && r.result.action === 'restore' && r.result.to === 'normal');
  r = await plan({ dir: 'up', maximized: true });
  check('plan: Win+Up on a maximized window does nothing, and says why', r.ok && r.result.action === 'none' && /already maximized/.test(r.result.why));
  r = await plan({ dir: 'left', maximized: true });
  check('plan: Win+Left on a maximized window snaps it left', r.ok && r.result.action === 'snap' && r.result.to === 'left');
  r = await plan({ dir: 'left', minimized: true });
  check('plan: a minimized window is left alone', r.ok && r.result.action === 'none' && /minimized/.test(r.result.why));
  r = await plan({ dir: 'sideways' });
  check('plan: a bad direction is "none" with the reason', r.ok && r.result.action === 'none' && /left, right, up or down/.test(r.result.why));

  // the quarter ladder, from frames that ARE the zones (no memory: recognised by position)
  const L = zone(one[0].work, 'left'), TL = zone(one[0].work, 'tl'), BL = zone(one[0].work, 'bl'), TR = zone(one[0].work, 'tr'), BR = zone(one[0].work, 'br');
  const at = (f, dir, extra) => s.send('snap.plan', Object.assign({ monitors: one, frame: f, window: [f[0] - 7, f[1], f[2] + 7, f[3] + 7], dir }, extra));
  const ladder = [
    [L, 'up', 'tl', TL], [L, 'down', 'bl', BL], [TL, 'down', 'left', L], [BL, 'up', 'left', L],
    [TL, 'right', 'tr', TR], [TR, 'left', 'tl', TL], [BL, 'right', 'br', BR], [BR, 'left', 'bl', BL],
    [TR, 'down', 'right', zone(one[0].work, 'right')], [BR, 'up', 'right', zone(one[0].work, 'right')],
  ];
  for (const [f, dir, to, want] of ladder) {
    r = await at(f, dir);
    check(`plan: ${r.result && r.result.from} + Win+${dir} -> ${to}`, r.ok && r.result.to === to && same(r.result.frame, xywh(want)),
      JSON.stringify(r.result && { from: r.result.from, to: r.result.to, frame: r.result.frame }));
  }
  r = await at(TL, 'up');
  check('plan: top-left quarter + Win+Up maximizes', r.ok && r.result.action === 'maximize');
  r = await at(BL, 'down');
  check('plan: bottom-left quarter + Win+Down minimizes', r.ok && r.result.action === 'minimize');
  r = await at(TL, 'down', {});
  check('plan: back down to the left half, the assist is the right half again', r.ok && r.result.assist.length === 1 &&
    same(r.result.assist[0].frame, xywh(zone(one[0].work, 'right'))));
  r = await s.send('snap.plan', { monitors: one, frame: L, dir: 'up' });
  check('plan: after left -> tl the assist is the bottom-left quarter', r.ok && same(r.result.assist[0].frame, xywh(BL)));

  // tolerance: DWM rounds a scaled frame by a pixel either way
  r = await at([L[0] + 2, L[1], L[2] - 2, L[3] + 2], 'up');
  check('plan: a frame 2 px off a half still counts as that half', r.ok && r.result.from === 'left');
  r = await at([L[0] + 3, L[1], L[2], L[3]], 'up');
  check('plan: 3 px off is a normal window', r.ok && r.result.from === 'normal' && r.result.action === 'maximize');

  // unsnap: the remembered frame, Windows' restore rect, or a centred two thirds
  r = await s.send('snap.plan', { monitors: one, frame: L, dir: 'right', remembered: { zone: 'left', frame: L, pre: frame, preMonitor: 'A' } });
  check('plan: left half + Win+Right puts the remembered pre-snap frame back exactly', r.ok && r.result.action === 'unsnap' &&
    r.result.restoredFrom === 'remembered' && same(r.result.frame, xywh(frame)), JSON.stringify(r.result).slice(0, 300));
  r = await s.send('snap.plan', { monitors: one, frame: zone(one[0].work, 'right'), dir: 'left', placement: [300, 200, 1100, 800] });
  check('plan: a half Windows snapped goes back to Windows\' own restore rect', r.ok && r.result.restoredFrom === 'windows' && same(r.result.frame, xywh([300, 200, 1100, 800])));
  r = await s.send('snap.plan', { monitors: one, frame: zone(one[0].work, 'right'), dir: 'left' });
  check('plan: with nothing to go back to, a centred two thirds', r.ok && r.result.restoredFrom === 'centered' && same(r.result.frame, xywh([320, 173, 1600, 866])),
    JSON.stringify(r.result && r.result.frame));
  const g3 = cell(one[0].work, 3, 1, 1, 0, 1, 1);
  r = await s.send('snap.plan', { monitors: one, frame: g3, dir: 'down', remembered: { zone: 'grid:3x1:1,0,1,1', frame: g3, pre: frame, preMonitor: 'A' } });
  check('plan: Win+Down on a Win+Z third goes back to the pre-snap frame', r.ok && r.result.from === 'grid:3x1:1,0,1,1' && r.result.action === 'unsnap' && same(r.result.frame, xywh(frame)));

  // exact tiling on awkward sizes: shared edges are one pixel line, never a gap or an overlap
  const odd = [{ id: 'O', bounds: [0, 0, 1919, 1079], work: [0, 0, 1919, 1031], dpi: 96, primary: true }];
  const oddPlan = (grid, c) => s.send('snap.plan', { monitors: odd, frame: [10, 10, 500, 500], grid, cell: c }).then((x) => x.result && x.result.frame);
  const a = await oddPlan([2, 1], [0, 0, 1, 1]), b = await oddPlan([2, 1], [1, 0, 1, 1]);
  check('plan: 1919 px splits 960 | 959 with one shared edge', a && b && a.x + a.w === b.x && a.w === 960 && b.x + b.w === 1919, fmt(a) + ' / ' + fmt(b));
  const t1 = await oddPlan([3, 1], [0, 0, 1, 1]), t2 = await oddPlan([3, 1], [1, 0, 1, 1]), t3 = await oddPlan([3, 1], [2, 0, 1, 1]);
  check('plan: thirds of 1919 tile exactly (640 | 639 | 640)', t1 && t2 && t3 && t1.x + t1.w === t2.x && t2.x + t2.w === t3.x && t3.x + t3.w === 1919 &&
    t1.w === 640 && t2.w === 639, [t1, t2, t3].map(fmt).join(' / '));
  const two = await oddPlan([3, 1], [0, 0, 2, 1]);
  check('plan: 2/3 + 1/3 meet on the same edge as the thirds', two && t3 && two.x + two.w === t3.x, fmt(two));
  const q = await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => oddPlan([2, 2], [x, y, 1, 1])));
  check('plan: quarters of an odd work area tile with no gap', q.every(Boolean) && q[0].x + q[0].w === q[1].x && q[0].y + q[0].h === q[2].y &&
    q[3].x + q[3].w === 1919 && q[3].y + q[3].h === 1031, q.map(fmt).join(' / '));
  r = await s.send('snap.plan', { monitors: odd, frame: [10, 10, 500, 500], grid: [4, 2], cell: [0, 0, 2, 2] });
  check('plan: a 4x2 grid cell spanning the left half IS "left" (Win+arrows carry on from it)', r.ok && r.result.to === 'left');
  r = await s.send('snap.plan', { monitors: odd, frame: [10, 10, 500, 500], grid: [3, 1], cell: [2, 0, 2, 1] });
  check('plan: a cell outside its grid is refused in words', !r.ok && /do not fit/.test(r.error || ''), JSON.stringify(r));

  // 125 % with an app bar at the TOP (Mantle's menu bar) and at the bottom
  const hi = [{ id: 'H', bounds: [0, 0, 2560, 1600], work: [0, 40, 2560, 1552], dpi: 120, primary: true }];
  r = await s.send('snap.plan', { monitors: hi, frame: [200, 200, 1200, 900], window: [191, 200, 1209, 909], dir: 'left' });
  check('plan: the left half starts BELOW a top app bar', r.ok && same(r.result.frame, xywh([0, 40, 1280, 1552])));
  check('plan: 125 % borders (9/0/9/9) are added back', r.ok && same(r.result.window, xywh([-9, 40, 1289, 1561])), JSON.stringify(r.result && r.result.window));
  r = await s.send('snap.plan', { monitors: hi, frame: zone(hi[0].work, 'left'), dir: 'up' });
  check('plan: top-left quarter under a top bar: 40..796', r.ok && same(r.result.frame, xywh([0, 40, 1280, 796])), fmt(r.result && r.result.frame));
  r = await s.send('snap.plan', { monitors: hi, frame: [200, 200, 1200, 900], window: [150, 100, 1300, 1000], dir: 'left' });
  check('plan: impossible borders (50 px) are flagged and treated as none', r.ok && r.result.marginsOk === false && same(r.result.window, r.result.frame));

  // three monitors: 100 % left, 125 % primary, 150 % right. Win+Left walks like Windows 7-11.
  const three = [
    { id: 'A', bounds: [-1920, 0, 0, 1080], work: [-1920, 0, 0, 1040], dpi: 96 },
    { id: 'B', bounds: [0, 0, 2560, 1600], work: [0, 0, 2560, 1552], dpi: 120, primary: true },
    { id: 'C', bounds: [2560, -200, 5440, 1420], work: [2560, -200, 5440, 1372], dpi: 144 },
  ];
  const onB = zone(three[1].work, 'left');
  r = await s.send('snap.plan', { monitors: three, frame: onB, window: [onB[0] - 9, onB[1], onB[2] + 9, onB[3] + 9], dir: 'left' });
  check('plan: left half + Win+Left -> RIGHT half of the monitor to the left', r.ok && r.result.monitor === 'A' && r.result.to === 'right' &&
    same(r.result.frame, xywh(zone(three[0].work, 'right'))), JSON.stringify(r.result && { m: r.result.monitor, f: r.result.frame }));
  check('plan: crossing 125 % -> 100 % scales the borders 9 -> 7', r.ok && r.result.margins.l === 7 && r.result.margins.b === 7, JSON.stringify(r.result && r.result.margins));
  const onA = zone(three[0].work, 'left');
  r = await s.send('snap.plan', { monitors: three, frame: onA, dir: 'left' });
  check('plan: from the leftmost monitor Win+Left wraps to the rightmost', r.ok && r.result.monitor === 'C' && r.result.to === 'right' &&
    same(r.result.frame, xywh(zone(three[2].work, 'right'))));
  const rC = zone(three[2].work, 'right');
  r = await s.send('snap.plan', { monitors: three, frame: rC, dir: 'right' });
  check('plan: from the rightmost, Win+Right wraps to the LEFT half of the leftmost', r.ok && r.result.monitor === 'A' && r.result.to === 'left');
  const trB = zone(three[1].work, 'tl');
  r = await s.send('snap.plan', { monitors: three, frame: trB, dir: 'left' });
  check('plan: a top-left quarter walks to the top-RIGHT quarter of the monitor to the left', r.ok && r.result.monitor === 'A' && r.result.to === 'tr');
  // back from a half on A to a pre-snap frame that was on B: same offset, scaled 125 -> 100 %, kept on A
  const rA = zone(three[0].work, 'right');
  r = await s.send('snap.plan', { monitors: three, frame: rA, dir: 'left', remembered: { zone: 'right', frame: rA, pre: [500, 300, 1500, 1100], preMonitor: 'B' } });
  check('plan: the pre-snap frame is carried onto the monitor the window is on now, scaled for DPI', r.ok && r.result.action === 'unsnap' &&
    r.result.monitor === 'A' && same(r.result.frame, xywh([-1920 + 400, 240, -1920 + 400 + 800, 240 + 640])), JSON.stringify(r.result && r.result.frame));
  r = await s.send('snap.plan', { monitors: three, frame: onB, dir: 'left', monitor: 'B', window: onB });
  check('plan: assist after a cross-monitor snap is on the NEW monitor', r.ok && r.result.assist.length === 1 && same(r.result.assist[0].frame, xywh(zone(three[0].work, 'left'))));

  await virtualized(s);
}

// ---------------------------------------------------------------- odd work areas, apps Windows scales
// The top bar made the user's work area 0,35 1920x1045 at 125 % (2026-09-24), and a DPI-unaware
// window's top-left quarter landed 1 px OVER the bottom-left one: Windows rounds such an app's
// position and size through its own 96-DPI pixels separately (measured, see SnapGeom.Virt), so at
// 125 % a height of 532 does not exist for it. These cases are pure: none depends on the live layout.
const mulDiv = (a, b, c) => { const n = a * b, h = Math.floor(c / 2); return n >= 0 ? Math.floor((n + h) / c) : -Math.floor((-n + h) / c); };
const virt = (v, mon, app) => (!app || app === mon) ? v : mulDiv(mulDiv(v, app, mon), mon, app);
/** Independent brute force: can the app put one edge exactly on `line` with its other edge inside the zone? */
function canReach(s0, e0, ms, me, org, mon, app, which) {
  const k = Math.ceil(mon / app) + 1;
  for (let p = s0 - ms - k; p <= s0 - ms + k; p++) {
    for (let l = e0 + me - (s0 - ms) - 2 * k; l <= e0 + me - (s0 - ms) + 2 * k; l++) {
      const a = org + virt(p - org, mon, app) + ms, b = a - ms + virt(l, mon, app) - me;
      if (which === 'end' ? (b === e0 && a >= s0 && a <= s0 + k) : (a === s0 && b <= e0 && b >= e0 - k)) return true;
    }
  }
  return false;
}

async function virtualized(s) {
  // The user's live layout, by hand
  const oneMon = [{ id: 'T', bounds: [0, 0, 1920, 1080], work: [0, 35, 1920, 1080], dpi: 120, primary: true }];
  const f9 = [100, 100, 900, 700], w9 = [91, 100, 909, 709];    // 9/0/9/9: the measured 125 % borders
  const op = (z, appDpi) => s.send('snap.plan', { monitors: oneMon, frame: f9, window: w9, zone: z, appDpi }).then((x) => x.result || {});
  let tl = await op('tl', 0), bl = await op('bl', 0);
  check('plan (top bar, 125 %, 1045 tall): a per-monitor-aware tl is exactly 35..558 and meets bl on one line',
    tl.fit === true && same(tl.reach, xywh([0, 35, 960, 558])) && bl.fit === true && tl.reach.y + tl.reach.h === bl.reach.y, fmt(tl.reach) + ' / ' + fmt(bl.reach));
  tl = await op('tl', 96); bl = await op('bl', 96);
  check('plan (top bar, 125 %): a DPI-unaware tl cannot be 35..558 (a 532 px window height does not exist for it), so 36..558, fit "rounded"',
    tl.fit === 'rounded' && same(tl.reach, xywh([0, 36, 960, 558])) && same(tl.window, xywh([-9, 36, 969, 567])) && /top edge 1 px inside/.test(tl.fitReason || ''),
    JSON.stringify({ reach: tl.reach, window: tl.window, fit: tl.fit, why: tl.fitReason }));
  check('plan (top bar, 125 %): ... and it still meets the DPI-unaware bl (558..1080, exact) on one line, no overlap',
    bl.fit === true && same(bl.reach, xywh([0, 558, 960, 1080])) && tl.reach.y + tl.reach.h === bl.reach.y, fmt(bl.reach));
  const lh = await op('left', 96);
  check('plan (top bar, 125 %): a DPI-unaware left half is reachable, so it is exact', lh.fit === true && same(lh.reach, xywh([0, 35, 960, 1080])), fmt(lh.reach));

  // a sweep: top bar at 1.0 / 1.25 / 1.5x, odd heights and widths, a monitor that is not at 0,0
  const cases = [
    ['1.0x, top bar 28 px', 96, [0, 0, 1920, 1080], [0, 28, 1920, 1080]],
    ['1.25x, top bar 35 px (1045 tall)', 120, [0, 0, 1920, 1080], [0, 35, 1920, 1080]],
    ['1.5x, top bar 42 px', 144, [0, 0, 1920, 1080], [0, 42, 1920, 1080]],
    ['1.0x, 1079 tall', 96, [0, 0, 1920, 1080], [0, 0, 1920, 1079]],
    ['1.25x, 1079 tall', 120, [0, 0, 1920, 1080], [0, 0, 1920, 1079]],
    ['1.5x, 1919 x 1079', 144, [0, 0, 1919, 1079], [0, 0, 1919, 1079]],
    ['1.25x, top bar + taskbar, 1919 wide', 120, [0, 0, 1919, 1080], [0, 35, 1919, 1032]],
    ['1.5x, right of the primary, top bar', 144, [1920, 0, 3840, 1080], [1920, 42, 3840, 1080]],
  ];
  const Z = { left: [2, 1, 0, 0, 1, 1], right: [2, 1, 1, 0, 1, 1], tl: [2, 2, 0, 0, 1, 1], tr: [2, 2, 1, 0, 1, 1], bl: [2, 2, 0, 1, 1, 1], br: [2, 2, 1, 1, 1, 1],
    t1: [3, 1, 0, 0, 1, 1], t2: [3, 1, 1, 0, 1, 1], t3: [3, 1, 2, 0, 1, 1], two: [3, 1, 0, 0, 2, 1] };
  // [A, B, axis]: A's end edge is B's start edge
  const PAIRS = [['left', 'right', 'x'], ['tl', 'tr', 'x'], ['bl', 'br', 'x'], ['t1', 't2', 'x'], ['t2', 't3', 'x'], ['two', 't3', 'x'], ['tl', 'bl', 'y'], ['tr', 'br', 'y']];
  const lt = (r) => [r.x, r.y, r.x + r.w, r.y + r.h];
  for (const [label, dpi, bounds, work] of cases) {
    const b = Math.round(7 * dpi / 96);                            // 7 px standard borders, scaled
    const frame = [bounds[0] + 100, work[1] + 100, bounds[0] + 900, work[1] + 700];
    const window = [frame[0] - b, frame[1], frame[2] + b, frame[3] + b];
    const mons = [{ id: 'S', bounds, work, dpi, primary: bounds[0] === 0 }];
    for (const app of [0, 96]) {
      const got = {}, bad = [];
      for (const [n, g] of Object.entries(Z)) {
        const r = await s.send('snap.plan', { monitors: mons, monitor: 'S', frame, window, grid: g.slice(0, 2), cell: g.slice(2), appDpi: app });
        if (!r.ok) { bad.push(n + ': ' + r.error); continue; }
        got[n] = { zone: lt(r.result.frame), reach: lt(r.result.reach), fit: r.result.fit, why: r.result.fitReason };
      }
      // how far an edge may move: an edge shared with a neighbour 1 px (reachable values are at most
      // 2 apart below 2x); an edge on the work area's rim up to one app pixel, because Reach moves
      // it inward to keep the shared edge exact (1.5x: x -10 does not exist, -11 and -9 do)
      const scaled = app > 0 && app !== dpi, kIn = scaled ? 1 : 0, kOut = scaled ? Math.ceil(dpi / app) : 0;
      let rounded = 0;
      for (const [n, g] of Object.entries(got)) {
        const [l, t, r, bt] = g.reach, [zl, zt, zr, zb] = g.zone;
        if (l < work[0] || t < work[1] || r > work[2] || bt > work[3]) bad.push(`${n} leaves the work area ${JSON.stringify(g.reach)}`);
        const off = [l - zl, t - zt, r - zr, bt - zb], rim = [zl === work[0], zt === work[1], zr === work[2], zb === work[3]];
        if (off.some((d, i) => Math.abs(d) > (rim[i] ? kOut : kIn))) bad.push(`${n} is too far off its zone ${JSON.stringify(g.reach)} vs ${JSON.stringify(g.zone)}`);
        const exact = [0, 1, 2, 3].every((i) => g.reach[i] === g.zone[i]);
        if (exact !== (g.fit === true) || (!exact && g.fit !== 'rounded')) bad.push(`${n} fit ${g.fit} but reach ${exact ? '==' : '!='} zone`);
        if (!exact) rounded++;
      }
      for (const [a, c, axis] of PAIRS) {
        const A = got[a], B = got[c];
        if (!A || !B) continue;
        const i = axis === 'x' ? 0 : 1, line = A.zone[i + 2];
        if (A.reach[i + 2] > B.reach[i]) bad.push(`${a} overlaps ${c} by ${A.reach[i + 2] - B.reach[i]} px`);
        // an edge whose zone's OTHER edge is on the work area's edge must land exactly on the shared
        // line whenever both apps can reach it (the independent brute force above says)
        const aOuter = A.zone[i] === work[i], bOuter = B.zone[i + 2] === work[i + 2];
        if (!aOuter || !bOuter) continue;
        const ms = axis === 'x' ? b : 0, org = bounds[i];
        const aCan = canReach(A.zone[i], line, ms, b, org, dpi, app || dpi, 'end'), bCan = canReach(line, B.zone[i + 2], ms, b, org, dpi, app || dpi, 'start');
        if (aCan && bCan && (A.reach[i + 2] !== line || B.reach[i] !== line)) bad.push(`${a}|${c} do not meet on ${line} although both can (${A.reach[i + 2]} / ${B.reach[i]})`);
      }
      check(`plan sweep ${label}, ${app ? 'DPI-unaware' : 'per-monitor-aware'}: inside the work area, no overlap, neighbours meet where reachable` +
        (scaled ? '' : ', every zone exact'), bad.length === 0 && (scaled || rounded === 0), bad.slice(0, 4).join('; '));
      if (scaled) notes.push(`sweep ${label}, DPI-unaware: ${rounded} of ${Object.keys(got).length} zones rounded`);
    }
  }
}

// ---------------------------------------------------------------- our own test windows
const FORM_PS1 = `
param([string]$Mode = 'sizable', [int]$X = 40, [int]$Y = 40, [int]$Life = 60, [int]$Aware = 0)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class SnapTestForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000; return cp; } }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}
'@
if ($Aware -ne 0) { [void][SnapTestForm]::SetProcessDpiAwarenessContext([IntPtr](-4)) }
$f = New-Object SnapTestForm
$f.Text = 'Mantle snap test (' + $Mode + ')'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point($X, $Y)
$f.Size = New-Object System.Drawing.Size(360, 260)
$f.ShowInTaskbar = $false
if ($Mode -eq 'fixed') { $f.FormBorderStyle = 'FixedSingle'; $f.MaximizeBox = $false }
$f.add_Shown({
  [void][SnapTestForm]::SetWindowPos($f.Handle, [IntPtr]1, 0, 0, 0, 0, 0x13)
  [Console]::Out.WriteLine('HWND ' + $f.Handle.ToInt64())
  [Console]::Out.Flush()
})
$t = New-Object System.Windows.Forms.Timer
$t.Interval = $Life * 1000
$t.add_Tick({ $f.Close() })
$t.Start()
[System.Windows.Forms.Application]::Run($f)
`;

function testWindow(args, viaCmd) {
  fs.mkdirSync(TMP, { recursive: true });
  const ps1 = path.join(TMP, 'snap-test-form.ps1');
  fs.writeFileSync(ps1, FORM_PS1);
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1].concat(args);
  // viaCmd: a grandchild (cmd.exe in between), which the passive fence must NOT accept.
  const child = viaCmd
    ? spawn('cmd.exe', ['/d', '/c', 'powershell'].concat(psArgs), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawn('powershell', psArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve) => {
    let out = '', err = '';
    const t = setTimeout(() => resolve({ child, hwnd: null, why: 'no HWND line in 20 s ' + err.slice(0, 200) }), 20000);
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = /HWND (\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve({ child, hwnd: m[1] }); }
    });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('exit', (code) => { clearTimeout(t); resolve({ child, hwnd: null, why: 'exited ' + code + ' ' + err.slice(0, 300) }); });
  });
}

async function live(s) {
  const mons = await s.send('snap.monitors');
  check('snap.monitors lists at least one monitor with a work area and a DPI', mons.ok && mons.result.monitors.length >= 1 &&
    mons.result.monitors.every((m) => m.work.w > 0 && m.dpi >= 96), JSON.stringify(mons).slice(0, 300));
  if (!mons.ok) return;
  notes.push('monitors: ' + mons.result.monitors.map((m) => `${m.primary ? '*' : ''}${m.bounds.w}x${m.bounds.h}@${m.scale} work ${fmt(m.work)}`).join(' | '));
  const fg0 = await s.send('snap.info', {});     // the user's active window: its HANDLE only, never its title
  const fgHwnd = fg0.ok ? fg0.result.hwnd : null;
  let fgMoved = null, ourHwnds = [];

  const wins = await Promise.all([
    testWindow(['-Mode', 'sizable', '-X', '60', '-Y', '80']),
    testWindow(['-Mode', 'sizable', '-X', '90', '-Y', '110', '-Aware', '1']),
    testWindow(['-Mode', 'fixed', '-X', '120', '-Y', '140']),
    testWindow(['-Mode', 'sizable', '-X', '150', '-Y', '170'], true),
  ]);
  try {
    const [plain, aware, fixed, grand] = wins;
    ourHwnds = wins.map((w) => w.hwnd).filter(Boolean);
    for (const [n, w] of [['DPI-unaware', plain], ['per-monitor-aware', aware], ['fixed-size', fixed], ['grandchild', grand]])
      check(`test window (${n}) came up`, !!w.hwnd, w.why);
    if (!plain.hwnd || !aware.hwnd) return;

    for (const [label, w] of [['DPI-unaware', plain], ['per-monitor-aware', aware]]) {
      const hwnd = w.hwnd;
      const info = (await s.send('snap.info', { hwnd })).result;
      check(`${label}: snap.info measures it normal, resizable, not above Mantle's integrity`, info && info.state === 'normal' && info.resizable &&
        !info.elevatedAboveMantle && info.integrity === '0x2000', JSON.stringify(info && { s: info.state, r: info.resizable, il: info.integrity }));
      check(`${label}: its invisible borders measured sane`, info && info.marginsOk && info.margins.l > 0 && info.margins.t === 0, JSON.stringify(info && info.margins));
      check(`${label}: WINDOWPLACEMENT workspace coords convert back to its own rect`, info && same(info.placementRect, info.rect, 1),
        fmt(info && info.placementRect) + ' vs ' + fmt(info && info.rect));
      notes.push(`${label}: dpi ${info && info.dpi}, awareness ${info && info.awareness} (virtDpi ${info && info.virtDpi}), borders ${info && JSON.stringify(info.margins)}, frame ${fmt(info && info.frame)}`);
      check(`${label}: snap.info reads its DPI awareness (what Windows scales it by)`, !!info &&
        (label === 'DPI-unaware' ? info.awareness === 'unaware' && info.virtDpi === 96 : info.awareness === 'per-monitor' && info.virtDpi === 0),
        JSON.stringify(info && { a: info.awareness, v: info.virtDpi }));
      const pre = info.frame;
      const mon = mons.result.monitors.find((m) => m.id === info.monitor.id);
      const work = [mon.work.x, mon.work.y, mon.work.x + mon.work.w, mon.work.y + mon.work.h];
      const ms = [], timing = [];
      const med = (k) => { const v = timing.map((t) => t[k]).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : null; };
      // Where the window SHOULD land: the zone, or for an app Windows scales (DPI-unaware) the
      // nearest frame it can reach, from the same pure planner (snap.plan with its virtDpi). The
      // checks below then prove the model matches what Windows really does, pixel for pixel.
      const lt = (r) => [r.x, r.y, r.x + r.w, r.y + r.h];
      const planMons = mons.result.monitors.map((m) => ({ id: m.id, bounds: lt(m.bounds), work: lt(m.work), dpi: m.dpi, primary: m.primary }));
      const expect = async (z) => {
        const r = await s.send('snap.plan', Object.assign({ monitors: planMons, monitor: mon.id, frame: lt(info.frame), window: lt(info.rect), appDpi: info.virtDpi }, z));
        return r.ok ? r.result : null;
      };
      const step = async (dir, to, z, extra) => {
        const p = z ? await expect({ zone: z }) : null;
        const r = await s.send('snap.move', Object.assign({ hwnd, dir }, extra));
        const x = r.result || {};
        if (typeof x.ms === 'number') ms.push(x.ms);
        if (x.timing) timing.push(x.timing);
        const fg = await s.send('snap.info', {});
        const now = fg.ok ? fg.result.hwnd : 'none';
        if (now !== (fgHwnd || 'none') && !fgMoved) fgMoved = `after ${label} Win+${dir}: ${now}` + (ourHwnds.includes(now) ? ' (ONE OF OUR TEST WINDOWS)' : ' (not one of ours)');
        const ok = r.ok && x.ok && x.to === to && (!p || (same(x.frame, p.reach, 0) && x.fit === p.fit && same(x.goal, p.reach, 0)));
        check(`${label}: Win+${dir} -> ${to}${p ? ' at exactly ' + fmt(p.reach) + (p.fit === true ? '' : ' (fit "rounded": ' + p.fitReason + ')') : ''}`, ok,
          JSON.stringify(r.error || { ok: x.ok, from: x.from, to: x.to, frame: x.frame, fit: x.fit, moves: x.moves, reason: x.reason, fitReason: x.fitReason }));
        if (x.fit === 'rounded') notes.push(`${label} ${to}: fit "rounded": ${x.fitReason}`);
        return x;
      };
      const single = mons.result.monitors.length === 1;
      let x = await step('left', 'left', 'left');
      check(`${label}: a normal window moves with ONE SetWindowPos`, x.moves === 1, 'moves ' + x.moves);
      check(`${label}: the snap never touched the focus`, x.foreground === false);
      const tl = await step('up', 'tl', 'tl');
      await step('down', 'left', 'left');
      const bl = await step('down', 'bl', 'bl');
      check(`${label}: the top and bottom quarters meet on ONE pixel line (no gap, no overlap)`, !!tl.frame && !!bl.frame &&
        tl.frame.y + tl.frame.h === bl.frame.y && tl.frame.y >= mon.work.y && bl.frame.y + bl.frame.h <= mon.work.y + mon.work.h,
        fmt(tl.frame) + ' / ' + fmt(bl.frame) + ' in work ' + fmt(mon.work));
      const br = await step('right', 'br', 'br');
      check(`${label}: the bottom quarters meet on ONE pixel line`, !!br.frame && bl.frame.x + bl.frame.w === br.frame.x, fmt(bl.frame) + ' / ' + fmt(br.frame));
      await step('up', 'right', 'right');
      x = await step('left', 'normal', null);
      check(`${label}: Win+Left from the right half puts the pre-snap frame back exactly`, same(x.frame, pre, 0) && x.restoredFrom === 'remembered',
        fmt(x.frame) + ' vs ' + fmt(pre) + ' ' + x.restoredFrom);
      await step('right', 'right', 'right');
      if (single) await step('right', 'left', 'left');   // one monitor: Win+Right wraps onto the same one
      x = (await s.send('snap.move', { hwnd, dir: 'up' })).result || {};
      check(`${label}: Win+Up on a half -> the top quarter`, x.ok && (x.to === 'tl' || x.to === 'tr'), JSON.stringify(x).slice(0, 200));
      x = (await s.send('snap.move', { hwnd, dir: 'up' })).result || {};
      check(`${label}: Win+Up is refused on a window that is not the active one, with the reason`, x.ok === false && x.action === 'maximize' &&
        /only maximizes the active window/.test(x.reason || ''), JSON.stringify(x).slice(0, 300));
      // a Win+Z third, then Win+Down back out of it
      const mid = await expect({ grid: [3, 1], cell: [1, 0, 1, 1] });
      let z = (await s.send('snap.zone', { hwnd, grid: [3, 1], cell: [1, 0, 1, 1] })).result || {};
      check(`${label}: snap.zone puts it in the middle third exactly (${fmt(mid && mid.reach)}, the zone ${fmt(xywh(cell(work, 3, 1, 1, 0, 1, 1)))})`,
        z.ok && !!mid && same(z.frame, mid.reach) && z.fit === mid.fit, JSON.stringify(z).slice(0, 300));
      z = (await s.send('snap.move', { hwnd, dir: 'down' })).result || {};
      check(`${label}: Win+Down on a Win+Z zone goes back to the pre-snap frame`, z.ok && z.action === 'unsnap' && same(z.frame, pre, 0), fmt(z.frame));
      // minimize (no activation), then a zone restores it through SetWindowPlacement, still without activation
      await step('left', 'left', 'left');
      await step('down', 'bl', 'bl');
      x = (await s.send('snap.move', { hwnd, dir: 'down' })).result || {};
      check(`${label}: Win+Down on the bottom quarter minimizes (SW_SHOWMINNOACTIVE)`, x.ok && x.action === 'minimize' && x.to === 'min', JSON.stringify(x).slice(0, 200));
      const rightP = await expect({ zone: 'right' });
      z = (await s.send('snap.zone', { hwnd, zone: 'right' })).result || {};
      check(`${label}: a zone restores a minimized window straight into place`, z.ok && !!rightP && same(z.frame, rightP.reach, 1) && z.moves >= 1,
        JSON.stringify({ ok: z.ok, frame: z.frame, moves: z.moves, corrected: z.corrected, reason: z.reason }));
      notes.push(`${label}: minimized -> zone took ${z.moves} move(s)${z.corrected ? `, first landed at ${fmt(z.firstFrame)} for ${fmt(z.target)}` : ''}`);
      const sorted = ms.slice().sort((a, b) => a - b);
      notes.push(`${label}: snap.move sidecar time over ${ms.length} moves: median ${sorted[sorted.length >> 1]} ms, max ${sorted[sorted.length - 1]} ms` +
        ` (median: checks ${med('check')} ms of which the passive-only fence ${med('fence')} ms, move+measure ${med('move')} ms, assist ${med('assist')} ms)`);
    }

    // Snap Assist: the zone left empty comes back in the answer
    const a = (await s.send('snap.move', { hwnd: plain.hwnd, dir: 'left' })).result || {};
    const b0 = (await s.send('snap.move', { hwnd: plain.hwnd, dir: 'left' })).result || {};
    notes.push(`assist after a snap: ${JSON.stringify((a.assist || []).concat(b0.assist || []).map((x) => x.zone.name))}`);
    check('assist: a snapped half reports the empty half as an array of zones', Array.isArray(a.assist) && Array.isArray(b0.assist));

    if (fixed.hwnd) {
      const f = (await s.send('snap.move', { hwnd: fixed.hwnd, dir: 'left' })).result || {};
      check('a fixed-size window is refused, and the reason says so', f.ok === false && /fixed size/.test(f.reason || ''), JSON.stringify(f).slice(0, 300));
      const fz = (await s.send('snap.zone', { hwnd: fixed.hwnd, zone: 'left' })).result || {};
      check('... also from Win+Z', fz.ok === false && /fixed size/.test(fz.reason || ''));
    }
    if (grand.hwnd) {
      const g = await s.send('snap.move', { hwnd: grand.hwnd, dir: 'left' });
      check('the passive fence refuses a window the harness did not start itself', !g.ok && (g.error || '').startsWith(PASSIVE), JSON.stringify(g).slice(0, 300));
    }
    const bad = await s.send('snap.zone', { hwnd: plain.hwnd, grid: [2, 1], cell: [5, 0, 1, 1] });
    check('snap.zone rejects a bad cell before touching the window', !bad.ok && /do not fit/.test(bad.error || ''));
    const gone = await s.send('snap.move', { hwnd: '12345', dir: 'left' });
    check('a closed window is refused in words', !gone.ok || (gone.result && gone.result.ok === false), JSON.stringify(gone).slice(0, 200));

    const fg1 = await s.send('snap.info', {});
    check('The user\'s active window is the same one before and after every move',
      (fg1.ok ? fg1.result.hwnd : 'none') === (fgHwnd || 'none'), 'before ' + fgHwnd + ', first change ' + fgMoved);
    check('no test window of ours ever became the active window', !fgMoved || !/ONE OF OUR/.test(fgMoved), fgMoved);
  } finally {
    // /T: the grandchild's cmd.exe waits on its powershell, so killing the tree takes both
    for (const w of wins) {
      try { require('child_process').execFileSync('taskkill', ['/PID', String(w.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* already gone */ }
    }
  }
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('no exe at ' + EXE); process.exit(2); }
  const s = startSidecar();
  const ready = await Promise.race([s.ready, sleep(8000).then(() => null)]);
  if (!check('sidecar starts passive', ready && ready.passive === true, JSON.stringify(ready))) { s.proc.kill(); process.exit(1); }
  const ping = await s.send('ping');
  const cmds = (ping.result && ping.result.features && ping.result.features.commands) || null;
  if (cmds) check('ping lists the snap commands', ['snap.move', 'snap.zone', 'snap.info', 'snap.monitors', 'snap.plan'].every((c) => cmds.includes(c)), JSON.stringify(cmds));
  else notes.push('ping has no features list yet (the seam lane adds it)');
  try {
    await pure(s);
    if (!process.argv.includes('--pure')) await live(s);
  } catch (e) { check('no exception', false, e.stack); }
  s.proc.stdin.end();
  setTimeout(() => { try { s.proc.kill(); } catch (_) { /* gone */ } }, 1500);
  for (const n of notes) console.log('  note: ' + n);
  console.log(`snap: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
