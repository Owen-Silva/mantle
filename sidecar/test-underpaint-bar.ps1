# test-underpaint-bar.ps1 - a FAKE top bar for sidecar/test-underpaint.js (lane mantle-topbar-zero).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sidecar/test-underpaint-bar.ps1 <x> <y> <w> <h>
#
# A WS_POPUP window made on its own thread with its own message loop: LAYERED with alpha 0 (nothing on
# screen), TRANSPARENT (click-through), TOOLWINDOW (no taskbar / Alt+Tab), NOACTIVATE + TOPMOST (like the
# real Electron bar), shown with SW_SHOWNOACTIVATE so it never takes the focus. It reads one command per
# stdin line and answers ONE JSON line each:
#   info              -> {ok, hwnd, rect:[l,t,r,b], visible, next (GW_HWNDNEXT), fg (the foreground window)}
#   move <x> <y>      -> SetWindowPos (no size, no z-order, no activation), then info
#   hide | show       -> ShowWindow(SW_HIDE | SW_SHOWNOACTIVATE), then info
#   win <hwnd>        -> any window: {ok, exists, cls, pid, style, ex, rect, visible, next}
#   fg                -> {ok, fg}
#   quit              -> {ok:true}, the window destroyed, the process exits
# The first line written (before any command) is the info of the new window. HWNDs are decimal strings.
param([int]$X = 200, [int]$Y = 300, [int]$W = 600, [int]$H = 30)

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FakeBar {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WNDCLASSEX {
    public uint cbSize, style; public WndProc lpfnWndProc; public int cbClsExtra, cbWndExtra;
    public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string lpszMenuName, lpszClassName; public IntPtr hIconSm;
  }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassExW(ref WNDCLASSEX c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int c);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr n);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  // PHYSICAL pixels like the sidecar (powershell.exe is not DPI-aware: at 125% every rect read 0.8x)
  static void Dpi() { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  static WndProc _proc;
  static IntPtr _wnd;
  static readonly ManualResetEvent _made = new ManualResetEvent(false);

  static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) {
    if (m == 0x21 /* WM_MOUSEACTIVATE */) return new IntPtr(3);   // MA_NOACTIVATE
    if (m == 0x84 /* WM_NCHITTEST */) return new IntPtr(-1);      // HTTRANSPARENT
    if (m == 0x8001 /* WM_APP+1: quit */) { DestroyWindow(h); return IntPtr.Zero; }
    if (m == 0x0002 /* WM_DESTROY */) { PostQuitMessage(0); return IntPtr.Zero; }
    return DefWindowProcW(h, m, w, l);
  }

  public static string Start(int x, int y, int w, int h) {
    Dpi();
    var t = new Thread(delegate () {
      Dpi();
      IntPtr inst = GetModuleHandleW(IntPtr.Zero);
      _proc = Proc;
      var wc = new WNDCLASSEX();
      wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)); wc.lpfnWndProc = _proc; wc.hInstance = inst; wc.lpszClassName = "MantleTestFakeBar";
      RegisterClassExW(ref wc);
      // LAYERED | TRANSPARENT | TOOLWINDOW | NOACTIVATE | TOPMOST
      _wnd = CreateWindowExW(0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8, "MantleTestFakeBar", "Mantle test fake bar", 0x80000000, x, y, w, h,
        IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
      if (_wnd != IntPtr.Zero) {
        SetLayeredWindowAttributes(_wnd, 0, 0, 2 /* LWA_ALPHA */);   // alpha 0: invisible
        ShowWindow(_wnd, 4 /* SW_SHOWNOACTIVATE */);
      }
      _made.Set();
      MSG m;
      while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessageW(ref m); }
    });
    t.IsBackground = true;
    t.Start();
    _made.WaitOne(5000);
    if (_wnd == IntPtr.Zero) return "{\"ok\":false,\"error\":\"the fake bar could not be made\"}";
    return Info();
  }

  static string H(IntPtr h) { return "\"" + h.ToInt64().ToString() + "\""; }
  static string R(IntPtr h) { RECT r; GetWindowRect(h, out r); return "[" + r.l + "," + r.t + "," + r.r + "," + r.b + "]"; }
  static string B(bool b) { return b ? "true" : "false"; }

  public static string Info() {
    return "{\"ok\":true,\"hwnd\":" + H(_wnd) + ",\"rect\":" + R(_wnd) + ",\"visible\":" + B(IsWindowVisible(_wnd)) +
      ",\"next\":" + H(GetWindow(_wnd, 2)) + ",\"fg\":" + H(GetForegroundWindow()) + "}";
  }

  public static string Do(string line) {
    string[] a = (line ?? "").Trim().Split(' ');
    string c = a[0];
    try {
      if (c == "info") return Info();
      if (c == "move") {
        SetWindowPos(_wnd, IntPtr.Zero, int.Parse(a[1]), int.Parse(a[2]), 0, 0, 0x1 | 0x4 | 0x10 /* NOSIZE NOZORDER NOACTIVATE */);
        return Info();
      }
      if (c == "hide") { ShowWindow(_wnd, 0); return Info(); }
      if (c == "show") { ShowWindow(_wnd, 4 /* SW_SHOWNOACTIVATE */); return Info(); }
      if (c == "fg") return "{\"ok\":true,\"fg\":" + H(GetForegroundWindow()) + "}";
      if (c == "win") {
        IntPtr h = new IntPtr(long.Parse(a[1]));
        if (!IsWindow(h)) return "{\"ok\":true,\"exists\":false}";
        var sb = new StringBuilder(256); GetClassNameW(h, sb, 256);
        int pid; GetWindowThreadProcessId(h, out pid);
        long style = GetWindowLongPtr(h, -16).ToInt64() & 0xFFFFFFFFL, ex = GetWindowLongPtr(h, -20).ToInt64() & 0xFFFFFFFFL;
        return "{\"ok\":true,\"exists\":true,\"cls\":\"" + sb.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"pid\":" + pid +
          ",\"style\":" + style + ",\"ex\":" + ex + ",\"rect\":" + R(h) + ",\"visible\":" + B(IsWindowVisible(h)) + ",\"next\":" + H(GetWindow(h, 2)) + "}";
      }
      if (c == "quit") { PostMessageW(_wnd, 0x8001, IntPtr.Zero, IntPtr.Zero); return "{\"ok\":true}"; }
      return "{\"ok\":false,\"error\":\"unknown command " + c.Replace("\"", "") + "\"}";
    } catch (Exception e) {
      return "{\"ok\":false,\"error\":\"" + e.Message.Replace("\\", "/").Replace("\"", "'") + "\"}";
    }
  }
}
'@

Add-Type -TypeDefinition $src -Language CSharp
[Console]::Out.WriteLine([FakeBar]::Start($X, $Y, $W, $H))
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { [FakeBar]::Do('quit') | Out-Null; break }
  if ($line.Trim() -eq '') { continue }
  [Console]::Out.WriteLine([FakeBar]::Do($line))
  [Console]::Out.Flush()
  if ($line.Trim() -eq 'quit') { Start-Sleep -Milliseconds 100; break }
}
