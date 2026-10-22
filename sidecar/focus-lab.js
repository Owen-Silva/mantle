// focus-lab.js - a real foreground lock, built from Mantle's OWN test windows, for the focus ladder
// (WindowList.Focus, sidecar/Windows.cs). Lane mn-focus, 2026-10-12. Used by test-focus-ladder.js.
//
// WHAT IT REBUILDS: the user clicks a pin on the bar. The bar is focusable:false (WS_EX_NOACTIVATE), so
// the click lands in Electron's process WITHOUT making it the foreground process; the app he was in
// keeps the foreground; and the process that then calls SetForegroundWindow is the sidecar, which
// neither is the foreground process nor received that click. Here:
//   A        an ordinary window in its own process: clicked first, so Windows makes it foreground
//   B        an ordinary window in its own process: the one to bring forward
//   bar      a WS_EX_NOACTIVATE | TOPMOST tool window in its own process, clicked second (A stays in
//            front); on its click it can hand its foreground right on (AllowSetForegroundWindow) to
//            a pid it was told, exactly what main.js now does for the sidecar
//   caller   a process that tries one technique at a time (the sidecar's rungs, one by one)
//   clicker  the only process that injects the clicks, so the caller never gets credit for them
// Every window's title starts "Mantle focus fixture" and the exe is mantle-focus-fixture.exe under
// %TEMP%, which is what the sidecar's focus.fixture accepts and nothing else.
//
// ON SCREEN, so ONLY inside the visible slot (BRIEF.md): the caller of start() checks idle and holds
// the lock. Safety: the clicker refuses to click any point whose window is not one of these; the bar
// process watches every key and mouse event (low-level hooks) and says REAL on the first one that was
// not injected, and the run stops there. Each process exits by itself after 3 minutes.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(os.tmpdir(), 'mantle-focus-lab');
const EXE = path.join(DIR, 'mantle-focus-fixture.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const TITLE = 'Mantle focus fixture';

const LAB_CS = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool AttachThreadInput(int a, int b, bool f);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool f);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, int tid);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate IntPtr HookProc(int c, IntPtr w, IntPtr l);
  public struct LII { public uint cb; public uint t; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  public static IntPtr Root(IntPtr h) { if (h == IntPtr.Zero) return h; IntPtr r = GetAncestor(h, 3); return r == IntPtr.Zero ? h : r; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  public static INPUT Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.flags = up ? 2u : 0u; return i; }
  public static INPUT Mouse(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; return i; }
  public static void Send(params INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
}

class Lab {
  public static string Log;
  public static void Say(string s) { try { File.AppendAllText(Log, s + "\r\n"); } catch (Exception) { } }
  public static void Poll(Action<string[]> on) {
    string cmdPath = Log + ".cmd";
    var poll = new System.Windows.Forms.Timer(); poll.Interval = 25;
    poll.Tick += delegate {
      string c = null;
      try { if (File.Exists(cmdPath)) { c = File.ReadAllText(cmdPath).Trim(); File.Delete(cmdPath); } } catch (Exception) { c = null; }
      if (string.IsNullOrEmpty(c)) return;
      foreach (string line in c.Split('\n')) { string l = line.Trim(); if (l.Length > 0) on(l.Split(' ')); }
    };
    poll.Start();
  }
}

class BarForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80 | 0x8; return cp; }   // NOACTIVATE | TOOLWINDOW | TOPMOST
  }
}

static class P {
  static W.HookProc kb, ms;   // kept alive
  static int grantPid;

  [STAThread]
  static void Main(string[] a) {
    W.SetProcessDPIAware();
    Lab.Log = a[1];
    var life = new System.Windows.Forms.Timer(); life.Interval = 180000; life.Tick += delegate { Application.ExitThread(); }; life.Start();
    int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
    string role = a[0];
    if (role == "win" || role == "bar") {
      Form f = role == "bar" ? (Form)new BarForm() : new Form();
      f.Text = "Mantle focus fixture " + a[2];
      f.FormBorderStyle = role == "bar" ? FormBorderStyle.None : FormBorderStyle.FixedSingle;
      f.StartPosition = FormStartPosition.Manual;
      f.Location = new Point(int.Parse(a[3]), int.Parse(a[4]));
      f.Size = new Size(int.Parse(a[5]), int.Parse(a[6]));
      f.BackColor = ColorTranslator.FromHtml(a[7]);
      f.ShowInTaskbar = role != "bar";
      f.TopMost = true;   // all of them: an app of the user's maximised behind must not cover the clicks
      f.Shown += delegate { Lab.Say("HWND " + f.Handle.ToInt64() + " PID " + pid); };
      f.Activated += delegate { Lab.Say("ACT 1"); };
      f.Deactivate += delegate { Lab.Say("ACT 0"); };
      f.MouseUp += delegate {
        // THIS process got the click: hand the right on first, exactly like main.js does.
        if (grantPid > 0) { bool ok = W.AllowSetForegroundWindow(grantPid); Lab.Say("GRANT " + grantPid + " " + (ok ? 1 : 0) + " " + Marshal.GetLastWin32Error()); }
        Lab.Say("CLICK");
      };
      if (role == "bar") {
        IntPtr mod = W.GetModuleHandle(null);
        kb = delegate (int c, IntPtr w, IntPtr l) { if (c >= 0 && (Marshal.ReadInt32(l, 8) & 0x12) == 0) Lab.Say("REAL key"); return W.CallNextHookEx(IntPtr.Zero, c, w, l); };
        ms = delegate (int c, IntPtr w, IntPtr l) { if (c >= 0 && (Marshal.ReadInt32(l, 12) & 0x3) == 0) Lab.Say("REAL mouse"); return W.CallNextHookEx(IntPtr.Zero, c, w, l); };
        W.SetWindowsHookEx(13, kb, mod, 0);
        W.SetWindowsHookEx(14, ms, mod, 0);
      }
      Lab.Poll(delegate (string[] q) {
        if (q[0] == "QUIT") Application.ExitThread();
        else if (q[0] == "GRANT") grantPid = int.Parse(q[1]);
        else if (q[0] == "MIN") f.WindowState = FormWindowState.Minimized;
      });
      f.Show();
      Application.Run();
      return;
    }
    // caller / clicker: no window, a message loop for the timers.
    Lab.Say("PID " + pid);
    Lab.Poll(delegate (string[] q) {
      if (q[0] == "QUIT") Application.ExitThread();
      else if (q[0] == "IDLE") { var l = new W.LII(); l.cb = 8; W.GetLastInputInfo(ref l); Lab.Say("IDLE " + q[1] + " " + unchecked((uint)Environment.TickCount - l.t)); }
      else if (q[0] == "FG") Lab.Say("FG " + q[1] + " " + W.Root(W.GetForegroundWindow()).ToInt64());
      else if (q[0] == "CLICK") Click(q[1], int.Parse(q[2]), int.Parse(q[3]));
      else if (q[0] == "TRY") Try(q[1], q[2], new IntPtr(long.Parse(q[3])));
    });
    Application.Run();
  }

  static void Click(string seq, int x, int y) {
    var p = new W.POINT(); p.x = x; p.y = y;
    IntPtr at = W.Root(W.WindowFromPoint(p));
    if (!W.Title(at).StartsWith("Mantle focus fixture", StringComparison.Ordinal)) { Lab.Say("CLICKED " + seq + " refused"); return; }
    W.POINT was; W.GetCursorPos(out was);
    W.SetCursorPos(x, y);
    Thread.Sleep(30);
    W.Send(W.Mouse(0x2), W.Mouse(0x4));   // LEFTDOWN, LEFTUP at the cursor
    Thread.Sleep(60);
    W.SetCursorPos(was.x, was.y);
    Lab.Say("CLICKED " + seq + " ok");
  }

  static bool Landed(IntPtr target) { return W.Root(W.GetForegroundWindow()) == target; }

  // One technique, alone, from this process (neither foreground nor the one that got the click).
  static void Try(string seq, string how, IntPtr target) {
    bool sfw = false; int err = 0; string attach = "-";
    switch (how) {
      case "direct": sfw = W.SetForegroundWindow(target); err = Marshal.GetLastWin32Error(); break;
      case "attach": {
        IntPtr fg = W.GetForegroundWindow(); int fpid; int ft = W.GetWindowThreadProcessId(fg, out fpid);
        bool r = false; var done = new ManualResetEvent(false);
        ThreadPool.QueueUserWorkItem(delegate {
          int me = W.GetCurrentThreadId();
          bool at = ft != 0 && W.AttachThreadInput(me, ft, true);
          attach = at ? "1" : "0:" + Marshal.GetLastWin32Error();
          r = W.SetForegroundWindow(target);
          if (at) W.AttachThreadInput(me, ft, false);
          done.Set();
        });
        done.WaitOne(1500); sfw = r; break;
      }
      case "alt": W.Send(W.Key(0x12, false), W.Key(0x12, true)); sfw = W.SetForegroundWindow(target); break;
      case "altdummy": W.Send(W.Key(0x12, false), W.Key(0xFF, false), W.Key(0xFF, true), W.Key(0x12, true)); Thread.Sleep(20); sfw = W.SetForegroundWindow(target); break;
      case "althold": W.Send(W.Key(0x12, false)); Thread.Sleep(20); sfw = W.SetForegroundWindow(target); W.Send(W.Key(0xFF, false), W.Key(0xFF, true), W.Key(0x12, true)); break;
      case "switch": W.SwitchToThisWindow(target, true); sfw = true; break;
    }
    bool f0 = Landed(target); Thread.Sleep(50); bool f50 = Landed(target); Thread.Sleep(200); bool f250 = Landed(target);
    Lab.Say("RES " + seq + " " + how + " sfw=" + (sfw ? 1 : 0) + " err=" + err + " attach=" + attach + " fg0=" + (f0 ? 1 : 0) + " fg50=" + (f50 ? 1 : 0) + " fg250=" + (f250 ? 1 : 0));
  }
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function build() {
  fs.mkdirSync(DIR, { recursive: true });
  const src = path.join(DIR, 'lab.cs');
  fs.writeFileSync(src, LAB_CS);
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/out:' + EXE, src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('the focus lab did not compile: ' + (r.stdout || '') + (r.stderr || ''));
  return EXE;
}

/** One lab process: its log lines, a way to send it commands, and wait for an answer. */
function proc(role, name, args) {
  const log = path.join(DIR, `${name}-${process.pid}.txt`);
  try { fs.unlinkSync(log); } catch (_) { /* first run */ }
  try { fs.unlinkSync(log + '.cmd'); } catch (_) { /* none */ }
  const p = spawn(EXE, [role, log].concat(args || []), { stdio: 'ignore', windowsHide: false });
  const lines = () => { try { return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  const cmd = (line) => fs.appendFileSync(log + '.cmd', line + '\n');
  async function wait(re, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 3000)) {
      const hit = lines().find((l) => re.test(l));
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }
  return { p, log, lines, cmd, wait, name, kill: () => { try { cmd('QUIT'); } catch (_) { /* gone */ } setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 800); } };
}

/** Milliseconds since the last input on this machine (GetLastInputInfo), from a lab process with no window. */
async function idleNow() {
  build();
  const c = proc('caller', 'idle');
  try {
    if (!(await c.wait(/^PID \d+$/, 8000))) return NaN;
    c.cmd('IDLE 1');
    const l = await c.wait(/^IDLE 1 /, 3000);
    return l ? Number(l.split(' ')[2]) : NaN;
  } finally { c.kill(); }
}

/**
 * Start the five processes. Windows at fixed, mid-screen physical pixels (away from the top row and
 * the bottom edge, where the live shell reacts to the pointer). Returns the lab, or throws.
 */
async function start() {
  build();
  const A = proc('win', 'A', ['A', '300', '260', '360', '240', '#c8d2dc']);
  const B = proc('win', 'B', ['B', '720', '260', '360', '240', '#dcd2c8']);
  const bar = proc('bar', 'bar', ['bar', '520', '560', '360', '70', '#a0a8b0']);
  const caller = proc('caller', 'caller');
  const clicker = proc('caller', 'clicker');
  const all = [A, B, bar, caller, clicker];
  const info = {};
  for (const x of all) {
    const l = await x.wait(/^(HWND \d+ PID \d+|PID \d+)$/, 10000);
    if (!l) { all.forEach((y) => y.kill()); throw new Error(`the lab's ${x.name} never started`); }
    const m = /HWND (\d+) PID (\d+)/.exec(l) || /PID (\d+)/.exec(l);
    info[x.name] = m.length === 3 ? { hwnd: m[1], pid: Number(m[2]) } : { pid: Number(m[1]) };
  }
  let seq = 0;
  const lab = {
    A, B, bar, caller, clicker, info,
    /** The first input that was not injected, or null. */
    real: () => bar.lines().find((l) => /^REAL/.test(l)) || null,
    async idleMs() { const s = ++seq; clicker.cmd(`IDLE ${s}`); const l = await clicker.wait(new RegExp(`^IDLE ${s} `), 3000); return l ? Number(l.split(' ')[2]) : NaN; },
    async fg() { const s = ++seq; clicker.cmd(`FG ${s}`); const l = await clicker.wait(new RegExp(`^FG ${s} `), 3000); return l ? l.split(' ')[2] : null; },
    async click(x, y) { const s = ++seq; clicker.cmd(`CLICK ${s} ${x} ${y}`); const l = await clicker.wait(new RegExp(`^CLICKED ${s} `), 3000); return !!l && / ok$/.test(l); },
    /** Click A (Windows makes it foreground), then the bar (A stays in front). True when that holds. */
    async setScene(grantPid) {
      bar.cmd(`GRANT ${grantPid || 0}`);
      await sleep(80);
      if (!(await lab.click(440, 380))) return 'the click on A was refused (something covers it)';
      await sleep(250);
      if ((await lab.fg()) !== info.A.hwnd) return 'A did not come to the front when clicked';
      const before = bar.lines().filter((l) => l === 'CLICK').length;
      if (!(await lab.click(700, 595))) return 'the click on the bar was refused (something covers it)';
      const t0 = Date.now();
      while (bar.lines().filter((l) => l === 'CLICK').length === before && Date.now() - t0 < 1500) await sleep(20);
      if (bar.lines().filter((l) => l === 'CLICK').length === before) return 'the bar never saw its click';
      if ((await lab.fg()) !== info.A.hwnd) return 'the bar click took the foreground (it must not)';
      return null;
    },
    async tryHow(how) { const s = ++seq; caller.cmd(`TRY ${s} ${how} ${info.B.hwnd}`); return caller.wait(new RegExp(`^RES ${s} `), 4000); },
    stop() { all.forEach((x) => x.kill()); },
  };
  return lab;
}

module.exports = { build, start, idleNow, DIR, EXE, TITLE };
