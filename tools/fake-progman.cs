// fake-progman.cs -- a STAND-IN for Explorer's desktop window (Progman), for lib/explorer-exit.e2e.test.js.
//
// Mantle's desktop layer lives as a WS_CHILD of Explorer's Progman (sidecar Desktop.cs). When Explorer
// dies (a crash, End task, Task Manager's Restart), Windows tears Progman down from Explorer's dying
// thread and our layer, a child owned by ANOTHER process, gets WM_NCDESTROY with no WM_DESTROY before it.
// Tests must never touch the real explorer.exe, so this process plays Progman: it adopts a window from
// another process the way Desktop.cs does, then goes away the way it is told to.
//
//   fake-progman.exe parent <hexHwnd> <mode> [seconds]
//     hold        pump messages until this process is killed from outside (Explorer killed / crashed)
//     exitthread  the window's thread returns without destroying it (win32k cleans up after it)
//     destroy     DestroyWindow on its own thread after [seconds] (Explorer closing its desktop in order)
//   fake-progman.exe iswin <hexHwnd>       prints 1 or 0
//
// Prints "adopted <child> into <parent>" once the child is in place. Built with the csc.exe that ships
// with Windows (the test compiles it into %TEMP%), so it needs no SDK on a runner either.
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class FakeProgman {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WNDCLASS { public uint style; public WndProc proc; public int cls, wnd; public IntPtr inst, icon, cursor, bg; public string menu, name; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtrW(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint r);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  static WndProc _keep;

  static int Main(string[] a) {
    if (a.Length >= 2 && a[0] == "iswin") { Console.WriteLine(IsWindow(new IntPtr(Convert.ToInt64(a[1], 16))) ? "1" : "0"); return 0; }
    if (a.Length < 3 || a[0] != "parent") { Console.Error.WriteLine("usage: fake-progman parent <hexHwnd> hold|exitthread|destroy [seconds] | iswin <hexHwnd>"); return 2; }
    IntPtr child = new IntPtr(Convert.ToInt64(a[1], 16));
    string mode = a[2];
    double secs = a.Length > 3 ? double.Parse(a[3], System.Globalization.CultureInfo.InvariantCulture) : 2.0;
    if (!IsWindow(child)) { Console.WriteLine("no such window " + a[1]); return 3; }
    var t = new Thread(() => Run(child, mode, secs));
    t.Start();
    t.Join();
    Console.WriteLine("window thread ended; child is window: " + IsWindow(child)); Console.Out.Flush();
    Thread.Sleep(3000);
    return 0;
  }

  static void Pump(double seconds) {
    var until = DateTime.UtcNow.AddSeconds(seconds);
    while (DateTime.UtcNow < until) {
      MSG m; while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessageW(ref m); }
      Thread.Sleep(10);
    }
  }

  static void Run(IntPtr child, string mode, double secs) {
    _keep = DefWindowProcW;
    var wc = new WNDCLASS { proc = _keep, name = "MantleFakeProgman" };
    RegisterClassW(ref wc);
    // off every monitor, never activated: WS_POPUP | WS_VISIBLE; WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
    IntPtr me = CreateWindowExW(0x80 | 0x08000000, "MantleFakeProgman", "Mantle fake Progman", 0x90000000, -32000, -32000, 400, 300, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    long style = GetWindowLongPtrW(child, -16).ToInt64();
    SetParent(child, me);
    SetWindowLongPtrW(child, -16, new IntPtr(style | 0x40000000 | 0x10000000));   // WS_CHILD | WS_VISIBLE, exactly as Desktop.cs does
    Console.WriteLine("adopted " + child.ToString("x") + " into " + me.ToString("x") + " (" + mode + ")"); Console.Out.Flush();
    if (mode == "hold") { Pump(86400); return; }
    Pump(secs);
    if (mode == "destroy") {
      bool ok = DestroyWindow(me);
      Console.WriteLine("DestroyWindow returned " + ok); Console.Out.Flush();
      Pump(2);
    } else {
      Console.WriteLine("window thread returning without DestroyWindow"); Console.Out.Flush();
    }
  }
}
