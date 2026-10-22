// test-lanes.js - the focus lane (sidecar/Lanes.cs) and a focus that never waits on another app
// (WindowList.Focus / AttachAndRaise, sidecar/Windows.cs). Lane sidefix, 2026-09-27.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-lanes.js
//
// THE BUG: live under Valorant, `focus` took ~5.2 s on the ui lane (a synchronous ShowWindow and
// AttachThreadInput to the game's thread), the bar's `place` queued behind it past its 4 s limit,
// and main hid the bar instead of parking it. Proved here two ways:
//   1. routing: park the focus lane (`sleep`), and `place`/`foreground` still answer in ms, while
//      focus/minimize/close/toggle queue behind the park (their passive refusal arrives late);
//   2. a FIXTURE whose thread is deliberately hung: `focus.rehearse` runs Focus's own
//      blocking-prone steps on it (restore, attach, a call made while attached, the raise), and a
//      concurrent `place` must not move. Measured in ms; run against a pre-fix exe for "before".
//
// PASSIVE, like every sidecar test. focus.rehearse never takes the foreground and never taps Alt;
// the fixture is a WinForms window at -6000,-6000 with WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW, shown
// without activation, compiled into %TEMP%, killed by pid at the end (and by itself after 120 s).
// `place` moves only the sidecar's own never-visible loop window. Nothing of the user's is touched.
//
// Prints one summary line, "LANES TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const DIR = path.join(os.tmpdir(), 'mantle-focus');
const FIX_EXE = path.join(DIR, 'mantle-focus-fixture.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const FIXTURE_CS = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class FixForm : Form {
  public static string Log;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80; return cp; }   // NOACTIVATE | TOOLWINDOW
  }
  public static void Say(string s) { try { File.AppendAllText(Log, s + "\r\n"); } catch (Exception) { } }
}

static class P {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [STAThread]
  static void Main(string[] a) {
    FixForm.Log = a[0];
    var t = new System.Windows.Forms.Timer(); t.Interval = 120000; t.Tick += delegate { Application.ExitThread(); }; t.Start();
    var m = new FixForm();
    m.Text = "Mantle focus fixture";
    m.StartPosition = FormStartPosition.Manual;
    m.Location = new Point(-6000, -6000);
    m.Size = new Size(240, 160);
    m.FormClosed += delegate { FixForm.Say("CLOSED"); Application.ExitThread(); };
    m.Shown += delegate { FixForm.Say("HWND main " + m.Handle.ToInt64()); };
    // Commands from the test, one line in <log>.cmd (polled; the fixture never reads input):
    //   MIN      minimise itself without activating (SW_SHOWMINNOACTIVE)
    //   HANG ms  stop pumping messages for ms (Windows calls it hung after ~5 s)
    //   STATE    say STATE MIN or STATE NORMAL
    string cmdPath = a[0] + ".cmd";
    var poll = new System.Windows.Forms.Timer(); poll.Interval = 40;
    poll.Tick += delegate {
      string c = null;
      try { if (File.Exists(cmdPath)) { c = File.ReadAllText(cmdPath).Trim(); File.Delete(cmdPath); } } catch (Exception) { c = null; }
      if (string.IsNullOrEmpty(c)) return;
      string[] q = c.Split(' ');
      if (q[0] == "MIN") { ShowWindow(m.Handle, 7); FixForm.Say("MINNED " + IsIconic(m.Handle)); }
      else if (q[0] == "STATE") FixForm.Say("STATE " + (IsIconic(m.Handle) ? "MIN" : "NORMAL"));
      else if (q[0] == "HANG" && q.Length == 2) { FixForm.Say("HANGING"); Thread.Sleep(int.Parse(q[1])); FixForm.Say("AWAKE"); }
    };
    poll.Start();
    m.Show();
    Application.Run();
  }
}
`;

function buildFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  const src = path.join(DIR, 'fixture.cs');
  fs.writeFileSync(src, FIXTURE_CS);
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/out:' + FIX_EXE, src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixture did not compile: ' + (r.stdout || '') + (r.stderr || ''));
}

async function launch() {
  const log = path.join(DIR, `log-${process.pid}.txt`);
  try { fs.unlinkSync(log); } catch (_) { /* first run */ }
  const proc = spawn(FIX_EXE, [log], { stdio: 'ignore', windowsHide: false });
  const lines = () => { try { return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  const clear = () => { try { fs.writeFileSync(log, ''); } catch (_) { /* gone */ } };
  const t0 = Date.now();
  let hwnd = null;
  while (Date.now() - t0 < 10000 && !hwnd) {
    for (const l of lines()) { const m = /^HWND main (\d+)$/.exec(l); if (m) hwnd = m[1]; }
    if (!hwnd) await T.sleep(100);
  }
  if (!hwnd) { try { proc.kill(); } catch (_) { /* gone */ } throw new Error('the fixture never reported its window'); }
  return { proc, log, hwnd, lines, clear, cmd: (line) => fs.writeFileSync(log + '.cmd', line) };
}

async function waitLine(fx, re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = fx.lines().find((l) => re.test(l));
    if (hit) return hit;
    await T.sleep(40);
  }
  return null;
}

// A ui-lane answer slower than this while focus work runs is a delay caused by it. Not 250 like
// test-sidecar's lane check: with nothing else running, `place` itself peaked at 79-111 ms and once
// 252 ms under the user's normal load (2026-09-27). The pre-fix exe delayed it 3,279-6,751 ms.
const UI_MAX_MS = 500;

const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : String(x));

(async () => {
  const t = T.checker('LANES');
  const notes = [];
  let s = null, fx = null;
  try {
    s = await T.startPassive();
    const ping = await s.call('ping', {}, 4000);
    const selfHwnd = ping.selfHwnd;
    const lanes = (ping.load && ping.load.lanes) || [];
    t.check('ping reports a focus lane', lanes.some((l) => l && l.name === 'focus'), JSON.stringify(lanes.map((l) => l.name)));
    t.check('ping lists focus.rehearse', ((ping.features && ping.features.commands) || []).includes('focus.rehearse'));

    async function timed(cmd, extra, timeoutMs) {
      const t0 = process.hrtime.bigint();
      const r = await s.send(cmd, extra, timeoutMs || 12000);
      return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    }
    // The bar's own move, on the sidecar's own never-visible loop window.
    const place = () => timed('place', { hwnd: selfHwnd, x: -7000, y: -7000, w: 120, h: 40 });
    const fore = () => timed('foreground', {});

    // `place` and `foreground` sampled every ~40 ms until `until` settles (and for at least minMs).
    async function sampleWhile(until, minMs) {
      let settled = false;
      until.then(() => { settled = true; }, () => { settled = true; });
      const t0 = Date.now();
      const pl = [], fg = [];
      let bad = null;
      while (!settled || Date.now() - t0 < minMs) {
        const a = await place(); pl.push(a.ms); if (!a.r.ok && !bad) bad = 'place: ' + JSON.stringify(a.r).slice(0, 160);
        const b = await fore(); fg.push(b.ms); if (!b.r.ok && !bad) bad = 'foreground: ' + JSON.stringify(b.r).slice(0, 160);
        await T.sleep(40);
      }
      return { pl, fg, bad };
    }

    // ---- baseline: nothing else running ------------------------------------------------------
    const base = await sampleWhile(Promise.resolve(), 600);
    t.check('baseline: place and foreground answer', !base.bad, base.bad);
    notes.push(`baseline: place p50 ${f0(pct(base.pl, 0.5))} / max ${f0(Math.max(...base.pl))} ms, foreground max ${f0(Math.max(...base.fg))} ms`);

    // ---- 1. routing: the focus lane parked, the ui lane untouched ---------------------------
    {
      const parkMs = 2500;
      const t0 = Date.now();
      const parked = s.send('sleep', { lane: 'focus', ms: parkMs }, 8000);
      await T.sleep(50);
      const verbs = ['focus', 'minimize', 'close', 'toggle'].map((v) =>
        s.send(v, { hwnd: '1' }, 8000).then((r) => ({ v, r, at: Date.now() - t0 })));
      const smp = await sampleWhile(T.sleep(1500), 0);
      const pr = await parked;
      const vr = await Promise.all(verbs);
      t.check('sleep {lane:"focus"} parks the focus lane', pr.ok && pr.result && pr.result.lane === 'focus' &&
        pr.result.thread === 'mantle-lane-focus', JSON.stringify(pr).slice(0, 160));
      t.check(`focus lane parked: place and foreground still answer in ms (max ${f0(Math.max(...smp.pl, ...smp.fg))} ms)`,
        !smp.bad && Math.max(...smp.pl, ...smp.fg) < UI_MAX_MS, smp.bad || smp.pl.map(f0).join(','));
      t.check('focus / minimize / close / toggle run on the focus lane (they queue behind the park)',
        vr.every((x) => x.at >= parkMs - 300 && x.r.ok === false && /passive/.test(x.r.error || '')),
        vr.map((x) => `${x.v}@${x.at}ms:${(x.r.error || '').slice(0, 40)}`).join(' | '));
      notes.push(`focus lane parked ${parkMs} ms: place max ${f0(Math.max(...smp.pl))} ms, foreground max ${f0(Math.max(...smp.fg))} ms; ` +
        `verbs answered at ${vr.map((x) => x.at).join('/')} ms`);
    }

    // ---- 2. a focus on a hung window ----------------------------------------------------------
    buildFixture();
    fx = await launch();
    const decoy = await s.send('focus.rehearse', { hwnd: selfHwnd }, 4000);
    t.check('focus.rehearse refuses anything but the fixture', decoy.ok === false && /only runs on the test fixture/.test(decoy.error || ''),
      JSON.stringify(decoy).slice(0, 160));

    // 2a. minimised, then hung: not yet "not responding" to Windows, so the attach is tried and
    //     the call made while attached waits on the sleeping thread.
    {
      const HANG = 7000;
      fx.clear(); fx.cmd('MIN');
      t.check('fixture: minimised itself', !!(await waitLine(fx, /^MINNED True$/, 3000)));
      fx.clear(); fx.cmd('HANG ' + HANG);
      t.check('fixture: hanging on purpose', !!(await waitLine(fx, /^HANGING$/, 3000)));
      await T.sleep(250);
      const reh = timed('focus.rehearse', { hwnd: fx.hwnd }, 15000);
      const smp = await sampleWhile(reh, 1500);
      const { r, ms } = await reh;
      const mid = await s.send('ping', {}, 4000);
      const out = mid.ok && mid.result.load ? mid.result.load.focusHelpersOut : undefined;
      const res = r.result || {};
      const placeMax = Math.max(...smp.pl), foreMax = Math.max(...smp.fg);
      notes.push(`hung fixture (attach tried): focus.rehearse ${f0(ms)} ms [${JSON.stringify(res).slice(0, 200)}]; ` +
        `concurrent place p50 ${f0(pct(smp.pl, 0.5))} / max ${f0(placeMax)} ms (${smp.pl.length} samples), foreground max ${f0(foreMax)} ms; helpersOut ${out}`);
      t.check(`hung: a concurrent place is not delayed (max ${f0(placeMax)} ms)`, !smp.bad && placeMax < UI_MAX_MS, smp.bad || smp.pl.map(f0).join(','));
      t.check(`hung: a concurrent foreground is not delayed (max ${f0(foreMax)} ms)`, foreMax < UI_MAX_MS, smp.fg.map(f0).join(','));
      t.check(`hung: focus.rehearse returns within 1 s (${f0(ms)} ms), on the focus lane`,
        r.ok && ms < 1000 && res.thread === 'mantle-lane-focus', JSON.stringify(r).slice(0, 200));
      t.check('hung: it says it stopped waiting, in words', typeof res.late === 'string' && /did not answer within \d+ ms/.test(res.late),
        String(res.late));
      t.check('hung: the restore was posted, not sent', res.restore === 'posted', String(res.restore));
      t.check('hung: ping counts the one helper still out', out === 1, String(out));
      t.check('fixture: woke up', !!(await waitLine(fx, /^AWAKE$/, HANG + 3000)));
      // The helper returns once the fixture has pumped the message it was waiting on.
      const w0 = Date.now();
      let back = null;
      while (Date.now() - w0 < 3000) {
        const p = await s.send('ping', {}, 4000);
        back = p.ok && p.result.load ? p.result.load.focusHelpersOut : undefined;
        if (back === 0) break;
        await T.sleep(100);
      }
      notes.push(`the helper was back ${Date.now() - w0} ms after the fixture said AWAKE`);
      t.check('awake: the helper came back and detached (focusHelpersOut 0 within 3 s)', back === 0, String(back));
      fx.clear(); fx.cmd('STATE');
      const st = await waitLine(fx, /^STATE /, 3000);
      t.check('awake: the posted restore landed (the fixture is no longer minimised)', st === 'STATE NORMAL', String(st));
    }

    // 2b. hung long enough that Windows calls it "not responding": the attach is skipped.
    //     A CONTROL second first, with no focus at all: when Windows declares the window hung it
    //     puts up a ghost window, and the window list (ui lane) resolving it cost a one-off
    //     ~170-410 ms `place` in two runs. That is not focus's doing, so it is measured apart.
    {
      const HANG = 11000;
      fx.clear(); fx.cmd('HANG ' + HANG);
      t.check('fixture: hanging again', !!(await waitLine(fx, /^HANGING$/, 3000)));
      await T.sleep(5700);
      const ctl = await sampleWhile(Promise.resolve(), 1200);
      notes.push(`not-responding fixture, control (no focus): place max ${f0(Math.max(...ctl.pl))} ms, foreground max ${f0(Math.max(...ctl.fg))} ms`);
      const reh = timed('focus.rehearse', { hwnd: fx.hwnd }, 15000);
      const smp = await sampleWhile(reh, 1000);
      const { r, ms } = await reh;
      const res = r.result || {};
      const placeMax = Math.max(...smp.pl);
      notes.push(`not-responding fixture (attach skipped): focus.rehearse ${f0(ms)} ms [${JSON.stringify(res).slice(0, 200)}]; ` +
        `concurrent place max ${f0(placeMax)} ms`);
      t.check(`not responding: focus.rehearse skips the attach and returns fast (${f0(ms)} ms)`,
        r.ok && ms < 300 && /not responding/.test(res.attach || '') && res.late === null, JSON.stringify(r).slice(0, 200));
      t.check(`not responding: a concurrent place is not delayed (max ${f0(placeMax)} ms)`, !smp.bad && placeMax < UI_MAX_MS,
        smp.bad || smp.pl.map(f0).join(','));
      await waitLine(fx, /^AWAKE$/, HANG);
    }

    const fin = await s.send('ping', {}, 4000);
    const fl = fin.ok ? fin.result.load.lanes : [];
    t.check('every lane drained at the end', fl.every((l) => l.queued === 0 && (!l.busy || l.busy === 'ping')), JSON.stringify(fl));
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    if (fx) { try { fx.proc.kill(); } catch (_) { /* gone */ } }
    if (s) await s.stop();
  }
  for (const n of notes) console.log('  ' + n);
  process.exit(t.summary());
})();
