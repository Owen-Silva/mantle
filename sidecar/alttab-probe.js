// alttab-probe.js - the Alt+Tab live-list tests' OWN windows (lane mn-alttab, 2026-10-12). Used by
// sidecar/test-alttab-live.js and lib/switcher.live.test.js.
//
// A small C# program (compiled once with the csc.exe that ships with Windows, into %TEMP%) that opens,
// closes, minimises and cloaks ordinary top-level windows on command, so the tests can change the
// desktop's window list while a switcher session is up. Each window is a real app window as far as
// the switcher's filter goes (visible, titled, not a tool window, not owned, its own process), and
// still puts NOTHING on Owen's screen:
//   - layered at alpha 0 and click-through (WS_EX_LAYERED | WS_EX_TRANSPARENT), far off every monitor;
//   - never activated (WS_EX_NOACTIVATE, shown with SW_SHOWNOACTIVATE / SW_SHOWMINNOACTIVE), so the
//     foreground window never changes;
//   - on no bar: its per-window AppUserModelID is Mantle's own (com.owensilva.mantle), which the live
//     bar's window list drops (main.js isMantleWindow), and WS_EX_NOACTIVATE keeps it off Windows'
//     taskbar. The switcher's own filter does not look at AUMIDs, so the tests see it there.
// The process exits by itself after 3 minutes, or when its stdin closes.
//
//   const P = require('./alttab-probe'); const p = await P.start();
//   const h = await p.open(1); await p.min(1); await p.cloak(1); await p.close(1); p.quit();
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(os.tmpdir(), 'mantle-alttab-probe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const TITLE = 'Mantle Alt+Tab probe';

const SRC = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Probe {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PKEY k);
    int GetValue(ref PKEY k, out PV v);
    int SetValue(ref PKEY k, ref PV v);
    int Commit();
  }
  [StructLayout(LayoutKind.Sequential)] struct PKEY { public Guid fmt; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 16)] struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IPropertyStore ps);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);

  sealed class Win : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        var cp = base.CreateParams;
        cp.ExStyle |= 0x00080000 | 0x00000020 | 0x08000000;   // LAYERED | TRANSPARENT | NOACTIVATE
        return cp;
      }
    }
  }

  static readonly Dictionary<string, Win> wins = new Dictionary<string, Win>();
  static Control host;

  static void SetAumid(IntPtr h) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore ps;
    if (SHGetPropertyStoreForWindow(h, ref iid, out ps) != 0 || ps == null) return;
    var k = new PKEY { fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var v = new PV { vt = 31, p = Marshal.StringToCoTaskMemUni("com.owensilva.mantle") };
    ps.SetValue(ref k, ref v);
    ps.Commit();
    Marshal.FreeCoTaskMem(v.p);
    Marshal.ReleaseComObject(ps);
  }

  static string Do(string line) {
    var a = line.Trim().Split(new[] { ' ' }, 3);
    string cmd = a[0], n = a.Length > 1 ? a[1] : "";
    Win w;
    wins.TryGetValue(n, out w);
    switch (cmd) {
      case "open": {
        if (w != null) return "err " + n + " already open";
        w = new Win();
        w.Text = a.Length > 2 ? a[2] : "Mantle Alt+Tab probe " + n;
        w.StartPosition = FormStartPosition.Manual;
        w.Bounds = new System.Drawing.Rectangle(-30000 + 40 * wins.Count, -30000, 320, 200);
        w.ShowInTaskbar = true;
        IntPtr h = w.Handle;
        SetAumid(h);
        w.Opacity = 0;
        ShowWindow(h, 4);                    // SW_SHOWNOACTIVATE
        wins[n] = w;
        return "ok " + n + " " + h.ToInt64();
      }
      case "close": if (w == null) return "err " + n + " not open"; wins.Remove(n); w.Close(); w.Dispose(); return "ok " + n;
      case "min": if (w == null) return "err " + n + " not open"; ShowWindow(w.Handle, 7); return "ok " + n;   // SW_SHOWMINNOACTIVE
      case "restore": if (w == null) return "err " + n + " not open"; ShowWindow(w.Handle, 4); return "ok " + n;
      case "cloak":
      case "uncloak": {
        if (w == null) return "err " + n + " not open";
        int on = cmd == "cloak" ? 1 : 0;
        int hr = DwmSetWindowAttribute(w.Handle, 13, ref on, 4);   // DWMWA_CLOAK
        return hr == 0 ? "ok " + n : "err " + n + " DwmSetWindowAttribute " + hr;
      }
      case "title": if (w == null) return "err " + n + " not open"; w.Text = a.Length > 2 ? a[2] : ""; return "ok " + n;
      case "quit": Application.Exit(); return "ok quit";
      default: return "err unknown " + cmd;
    }
  }

  [STAThread]
  static void Main() {
    host = new Control();
    host.CreateControl();
    IntPtr force = host.Handle;
    var reader = new Thread(delegate () {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        string l = line, r;
        try { r = (string)host.Invoke(new Func<string>(delegate () { return Do(l); })); }
        catch (Exception ex) { r = "err " + ex.GetType().Name + ": " + ex.Message; }
        Console.Out.WriteLine(r);
        Console.Out.Flush();
      }
      try { host.BeginInvoke(new MethodInvoker(Application.Exit)); } catch (Exception) { }
    });
    reader.IsBackground = true;
    reader.Start();
    var bye = new System.Windows.Forms.Timer { Interval = 180000 };
    bye.Tick += delegate { Application.Exit(); };
    bye.Start();
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    Application.Run();
  }
}
`;

function build() {
  const hash = crypto.createHash('sha1').update(SRC).digest('hex').slice(0, 10);
  const exe = path.join(DIR, `mantle-alttab-probe-${hash}.exe`);
  if (fs.existsSync(exe)) return { exe };
  fs.mkdirSync(DIR, { recursive: true });
  const cs = path.join(DIR, `probe-${hash}.cs`);
  fs.writeFileSync(cs, SRC);
  const r = spawnSync(CSC, ['/nologo', '/target:exe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${exe}`, cs], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(exe)) return { error: `csc failed: ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 600) };
  return { exe };
}

async function start() {
  const b = build();
  if (b.error) throw new Error(b.error);
  const proc = spawn(b.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  const waiting = [];
  const lines = [];
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (waiting.length) waiting.shift()(line); else lines.push(line);
    }
  });
  proc.stderr.on('data', () => {});
  const next = (ms) => new Promise((res, rej) => {
    if (lines.length) { res(lines.shift()); return; }
    const t = setTimeout(() => rej(new Error(`the probe did not answer in ${ms} ms`)), ms);
    waiting.push((l) => { clearTimeout(t); res(l); });
  });
  const first = await next(15000);
  if (first !== 'ready') throw new Error(`the probe said "${first}" instead of ready`);
  const cmd = async (line) => {
    proc.stdin.write(line + '\n');
    const r = await next(8000);
    if (!/^ok\b/.test(r)) throw new Error(`probe "${line}": ${r}`);
    return r;
  };
  return {
    pid: proc.pid,
    async open(n, title) { const r = await cmd(`open ${n}${title ? ` ${title}` : ''}`); return r.split(' ')[2]; },
    close: (n) => cmd(`close ${n}`),
    min: (n) => cmd(`min ${n}`),
    restore: (n) => cmd(`restore ${n}`),
    cloak: (n) => cmd(`cloak ${n}`),
    uncloak: (n) => cmd(`uncloak ${n}`),
    title: (n, t) => cmd(`title ${n} ${t}`),
    quit() { try { proc.stdin.write('quit\n'); proc.stdin.end(); } catch (_) { /* gone */ } setTimeout(() => { try { proc.kill(); } catch (_) { /* gone */ } }, 1500).unref(); },
  };
}

module.exports = { start, build, TITLE };
