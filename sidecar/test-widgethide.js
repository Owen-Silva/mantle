'use strict';
/*
 * test-widgethide.js - the desktop widgets' "is a window over me?" check (sidecar/WidgetCover.cs).
 *
 *   node sidecar/test-widgethide.js --exe=<your built sidecar>
 *
 * Part 1, the decision on FAKE windows (widgethide.check {fake}, passive only): every rule of the
 * ignore list, the z-order cut at the desktop, the 2 px overlap, multi-monitor.
 * Part 2, a REAL window driven through the real hooks (widgethide.watch + the pushed 'widgethide'
 * events): cover, move to another widget, minimise (what Win+D does), restore, (behind the desktop: the older Win+D
 * mechanism is proven on fake windows only), click-through, fully transparent, hidden, watch off. The window is a WinForms form
 * that never activates, is never in a taskbar, and lives at -9000,-9000, off every monitor: it
 * never appears on Owen's screen, takes no focus and no clicks. Prints one summary line.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./test-lib');

const t = T.checker('WIDGETHIDE');
const check = t.check;

// ---- part 1: fake windows ------------------------------------------------------------------
const CLOCK = { key: 'clock', l: 100, t: 100, r: 500, b: 300 };
const STATS = { key: 'stats', l: 100, t: 320, r: 500, b: 500 };
const AREAS = [CLOCK, STATS];
const over = (a, more) => Object.assign({ hwnd: '11', cls: 'Notepad', title: 'Untitled - Notepad', l: a.l + 50, t: a.t + 20, r: a.l + 300, b: a.t + 150 }, more || {});

async function decide(s, fake, areas) {
  const r = await s.send('widgethide.check', { areas: areas || AREAS, fake }, 4000);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

async function part1(s) {
  let r = await decide(s, [over(CLOCK)]);
  check('fake: an app over the clock covers the clock', r.covered.clock === true, JSON.stringify(r.covered));
  check('fake: ...and not the System tile beside it (per widget)', r.covered.stats === false, JSON.stringify(r.covered));
  check('fake: by names the covering window', r.by.clock === 'Untitled - Notepad', JSON.stringify(r.by));

  r = await decide(s, []);
  check('fake: no windows, nothing covered', r.covered.clock === false && r.covered.stats === false, JSON.stringify(r.covered));

  const ignored = [
    ['minimised', { minimized: true }, 'minimised'],
    ['cloaked (other virtual desktop)', { cloaked: true }, 'cloaked'],
    ['not visible', { visible: false }, 'not visible'],
    ['tool window (tooltip/palette)', { exStyle: 0x80 }, 'tool window'],
    ['click-through overlay', { exStyle: 0x20 | 0x80000 }, 'click-through'],
    ['fully transparent (alpha 0)', { exStyle: 0x80000, alpha: 0 }, 'fully transparent'],
    ['the taskbar', { cls: 'Shell_TrayWnd', title: '' }, 'furniture'],
    ['a second monitor\'s taskbar', { cls: 'Shell_SecondaryTrayWnd', title: '' }, 'furniture'],
    ['a menu', { cls: '#32768', title: '' }, 'furniture'],
    ['a tooltip without the tool style', { cls: 'tooltips_class32', title: '' }, 'furniture'],
    ['Windows\' own Alt+Tab / flyout host', { cls: 'XamlExplorerHostIslandWindow', title: '' }, 'furniture'],
    ['Mantle\'s bar', { who: 'parent', cls: 'Chrome_WidgetWin_1', title: 'Mantle bar' }, 'Mantle\'s own'],
    ['Mantle\'s top bar', { who: 'parent', cls: 'Chrome_WidgetWin_1', title: 'Mantle top bar' }, 'Mantle\'s own'],
    ['a Mantle pop-up with no title', { who: 'parent', cls: 'Chrome_WidgetWin_1', title: '' }, 'Mantle\'s own'],
    ['the sidecar\'s own window', { who: 'own', cls: 'WindowsForms10.Window.8.app.0.1', title: 'x' }, 'helper'],
    ['zero size', { r: CLOCK.l + 50, b: CLOCK.t + 20 }, 'zero size'],
  ];
  for (const [name, more, word] of ignored) {
    r = await decide(s, [over(CLOCK, more)]);
    const w = r.windows[0] || {};
    check(`ignored: ${name}`, r.covered.clock === false && typeof w.ignored === 'string' && w.ignored.includes(word), JSON.stringify(w));
  }

  r = await decide(s, [over(CLOCK, { who: 'parent', cls: 'Chrome_WidgetWin_1', title: 'Mantle Settings' })]);
  check('counted: Mantle Settings is an app window and DOES cover', r.covered.clock === true, JSON.stringify(r.windows[0]));
  r = await decide(s, [over(CLOCK, { exStyle: 0x80000, alpha: 30 })]);
  check('counted: a see-through (alpha 30) app still covers', r.covered.clock === true, JSON.stringify(r.windows[0]));
  r = await decide(s, [over(CLOCK, { title: '' })]);
  check('counted: an untitled app window covers, by falls back to its class', r.covered.clock === true && r.by.clock === 'Notepad', JSON.stringify(r.by));

  // z-order: the walk is top to bottom; a window after the desktop is behind it
  r = await decide(s, [{ hwnd: '1', cls: 'Progman', desktop: true }, over(CLOCK)]);
  check('z-order: a window behind the desktop does not cover (older Win+D)', r.covered.clock === false && /behind the desktop/.test(r.windows[1].ignored || ''), JSON.stringify(r.windows));
  r = await decide(s, [over(CLOCK), { hwnd: '1', cls: 'Progman', desktop: true }]);
  check('z-order: a window above the desktop covers', r.covered.clock === true, JSON.stringify(r.covered));

  // overlap threshold: touching edges is not covering
  r = await decide(s, [over(CLOCK, { l: CLOCK.r - 1, r: CLOCK.r + 300 })]);
  check('overlap: a 1 px sliver does not cover', r.covered.clock === false, JSON.stringify(r.covered));
  r = await decide(s, [over(CLOCK, { l: CLOCK.r - 2, r: CLOCK.r + 300 })]);
  check('overlap: 2 px does', r.covered.clock === true, JSON.stringify(r.covered));
  r = await decide(s, [over(CLOCK, { l: -10, t: -10, r: 4000, b: 3000 })]);
  check('maximised: one big window covers every widget', r.covered.clock === true && r.covered.stats === true, JSON.stringify(r.covered));

  // multi-monitor: virtual-screen pixels, so a window on monitor 2 (x >= 1920) never covers monitor 1
  r = await decide(s, [over(CLOCK, { l: 1920 + 100, r: 1920 + 600 })]);
  check('multi-monitor: a window on the second monitor covers nothing on the first', r.covered.clock === false && r.covered.stats === false, JSON.stringify(r.covered));
  r = await decide(s, [over(CLOCK, { l: 2000, r: 2400 })], [{ key: 'm2', l: 1920 + 50, t: 50, r: 1920 + 500, b: 400 }]);
  check('multi-monitor: ...and does cover an area that is on the second monitor', r.covered.m2 === true, JSON.stringify(r.covered));

  // stacked: the first window over a widget names it; a later one changes nothing
  r = await decide(s, [over(CLOCK, { title: 'Front' }), over(CLOCK, { hwnd: '12', title: 'Back' })]);
  check('stacked: by names the frontmost covering window', r.by.clock === 'Front', JSON.stringify(r.by));

  // bad input says why
  let bad = await s.send('widgethide.check', { areas: 'x' }, 4000);
  check('bad: areas not a list is refused with a reason', !bad.ok && /areas must be a list/.test(bad.error || ''), JSON.stringify(bad));
  bad = await s.send('widgethide.check', { areas: [{ key: 'z', l: 5, t: 5, r: 5, b: 9 }] }, 4000);
  check('bad: a zero-size area is refused', !bad.ok && /no size/.test(bad.error || ''), JSON.stringify(bad));
  bad = await s.send('widgethide.watch', { areas: [{ l: 0, t: 0, r: 9, b: 9 }] }, 4000);
  check('bad: an area with no key is refused', !bad.ok && /key/.test(bad.error || ''), JSON.stringify(bad));
}

// ---- part 2: a real window ------------------------------------------------------------------
const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms; using System.Runtime.InteropServices;
public class WhForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
}
public static class WhN {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[WhN]::SetProcessDPIAware() | Out-Null   # physical pixels, like the sidecar
$f = New-Object WhForm
$f.Text = 'widgethide-test'
$f.ShowInTaskbar = $false
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-9000, -9000)
$f.Size = New-Object System.Drawing.Size(300, 200)
$f.Opacity = 0.5
$f.Show()
[System.Windows.Forms.Application]::DoEvents()
$h = $f.Handle
[Console]::Out.WriteLine("ready " + $h.ToInt64() + " " + [System.Windows.Forms.Screen]::AllScreens.Length)
$flags = 0x0010 -bor 0x0004   # NOACTIVATE | NOZORDER
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'quit') { break }
  $a = $line.Split(' ')
  switch ($a[0]) {
    'move'    { [WhN]::SetWindowPos($h, [IntPtr]::Zero, [int]$a[1], [int]$a[2], 300, 200, $flags) | Out-Null }
    'min'     { [WhN]::ShowWindow($h, 7) | Out-Null }
    'restore' { [WhN]::ShowWindow($h, 4) | Out-Null }
    'hide'    { [WhN]::ShowWindow($h, 0) | Out-Null }
    'show'    { [WhN]::ShowWindow($h, 4) | Out-Null }
    'exadd'   { $s = [WhN]::GetWindowLongPtr($h, -20).ToInt64(); [WhN]::SetWindowLongPtr($h, -20, [IntPtr]($s -bor [int64]$a[1])) | Out-Null }
    'exdel'   { $s = [WhN]::GetWindowLongPtr($h, -20).ToInt64(); [WhN]::SetWindowLongPtr($h, -20, [IntPtr]($s -band (-bnot [int64]$a[1]))) | Out-Null }
    'alpha'   { [WhN]::SetLayeredWindowAttributes($h, 0, [byte]$a[1], 2) | Out-Null }
  }
  [System.Windows.Forms.Application]::DoEvents()
  [Console]::Out.WriteLine("ok " + $a[0])
}
$f.Close()
`;

function startHelper() {
  const file = path.join(os.tmpdir(), `widgethide-helper-${process.pid}.ps1`);
  fs.writeFileSync(file, PS);
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = [];
  const lines = [];
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line); else lines.push(line);
    }
  });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  const next = (ms) => new Promise((res, rej) => {
    if (lines.length) { res(lines.shift()); return; }
    const w = (l) => { clearTimeout(to); res(l); };
    const to = setTimeout(() => {
      const k = waiters.indexOf(w);
      if (k >= 0) waiters.splice(k, 1);
      rej(new Error(`helper said nothing in ${ms} ms; stderr: ${err.slice(0, 300)}`));
    }, ms);
    waiters.push(w);
  });
  return {
    p, file, next,
    async cmd(c) { p.stdin.write(c + '\n'); return next(5000); },
    stop() { try { p.stdin.write('quit\n'); } catch (_) { /* gone */ } setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } try { fs.unlinkSync(file); } catch (_) { /* gone */ } }, 800); },
  };
}

async function part2(s) {
  const H = startHelper();
  try {
    const ready = await H.next(30000);
    const m = /^ready (\d+) (\d+)/.exec(ready);
    check('real: the off-screen helper window is up', !!m, ready);
    if (!m) return;
    const monitors = Number(m[2]);
    // A at the window's spot, B 1000 px to the right (also off every monitor)
    const A = { key: 'a', l: -9000 + 20, t: -9000 + 20, r: -9000 + 120, b: -9000 + 120 };
    const B = { key: 'b', l: -8000 + 20, t: -9000 + 20, r: -8000 + 120, b: -9000 + 120 };
    if (process.env.WH_DEBUG) {
      const d = await s.call('widgethide.check', { areas: [A, B] }, 4000);
      process.stdout.write(JSON.stringify(d.windows.filter((w) => w.hwnd === m[1] || /widgethide/.test(w.title || ''))) + '\n');
    }
    let r = await s.call('widgethide.watch', { on: true, areas: [A, B] }, 4000);
    check('real watch: answers at once, the window covers A and not B', r.on === true && r.covered.a === true && r.covered.b === false, JSON.stringify(r));
    check('real watch: by is the window title', r.by.a === 'widgethide-test', JSON.stringify(r.by));

    // the first 'widgethide' event at or after index `from` of the sidecar's event log, or null
    const nextEv = async (from, ms) => {
      try {
        return await s.waitEvent('widgethide', ms || 2500, (e) => s.events.indexOf(e) >= from);
      } catch (_) { return null; }
    };
    const step = async (cmd, name, pred) => {
      const from = s.events.length;
      const t0 = Date.now();
      await H.cmd(cmd);
      const ev = await nextEv(from);
      const ms = Date.now() - t0;
      check(`${name} (${ev ? ms + ' ms' : 'no event'})`, !!ev && pred(ev.covered || {}), JSON.stringify(ev));
      return ev;
    };

    await step('move -8000 -9000', 'move to B: A uncovered, B covered', (c) => c.a === false && c.b === true);
    await step('move -9000 -9000', 'move back: A covered, B not', (c) => c.a === true && c.b === false);
    await step('min', 'minimise: nothing covered', (c) => c.a === false && c.b === false);
    await step('restore', 'restore: A covered again', (c) => c.a === true);
    // Win+D minimises every window, which is the 'min' step above. A window cannot be put BEHIND the
    // desktop to test the z-order cut for real (Windows keeps Progman at the bottom even against
    // HWND_BOTTOM, measured 2026-10-10), so that rule is proven on fake windows in part 1.
    await step('exadd 32', 'made click-through: uncovered', (c) => c.a === false);
    await step('exdel 32', 'click-through off: covered', (c) => c.a === true);
    await step('alpha 0', 'fully transparent: uncovered', (c) => c.a === false);
    await step('alpha 128', 'half see-through: covered', (c) => c.a === true);
    await step('hide', 'hidden: uncovered', (c) => c.a === false);
    await step('show', 'shown: covered', (c) => c.a === true);

    // an event only on a CHANGE: a small move that still covers A emits nothing
    let from = s.events.length;
    await H.cmd('move -8990 -8990');
    check('no change, no event: a move that still covers A is silent', (await nextEv(from, 1500)) === null, JSON.stringify(s.collect('widgethide').slice(-1)));

    r = await s.call('widgethide.watch', { on: false }, 4000);
    check('watch off: answers on:false with nothing covered', r.on === false && Object.keys(r.covered).length === 0, JSON.stringify(r));
    from = s.events.length;
    await H.cmd('move -8000 -9000');
    check('watch off: a move no longer emits', (await nextEv(from, 1500)) === null, '');
    check(`monitors on this machine: ${monitors} (the desktop layer and its widgets are on the primary; part 1 covers the second monitor)`, monitors >= 1, String(monitors));
  } finally {
    H.stop();
  }
}

(async () => {
  let s;
  try {
    s = await T.startPassive();
    await part1(s);
    await part2(s);
  } catch (e) {
    check('the run finished', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    if (s) await s.stop();
  }
  process.exit(t.summary());
})();
