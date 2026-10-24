// maxfold-testwin.cs - ONE invisible test window for the maximize unfold's tests (lane unfold-max, 2026-10-23).
//
// Built and started by sidecar/maxfold-testwin.js (csc.exe into %TEMP%, never into the sidecar build: this
// file lives in a sub-folder, and build.ps1 compiles only sidecar\*.cs). Used by sidecar/test-maxfold.js and
// by lib/features/_maxfold-selftest.js. It is a child of the test harness, so a passive sidecar counts it as
// the harness's own window (Snap.OursToMove's rule) and animates it; nothing else.
//
// The window: a normal captioned top-level window (WS_OVERLAPPEDWINDOW, so MaxFold.cs does not skip it as a
// tool window or a full-screen one), UNTITLED, OWNED by a hidden window (never in the taskbar or Alt+Tab),
// DISABLED (never takes a click or the focus), layered at alpha 0 + WS_EX_TRANSPARENT (invisible and
// click-through), WS_EX_NOACTIVATE, shown without activation at the BOTTOM of the z-order, and it closes
// itself after <life> seconds even if the harness dies. MAXFOLD_TEST_VISIBLE=1 gives it alpha 255 (only
// inside an on-screen slot). It paints an app-like pattern (toolbar, sidebar, text, colour blocks, a chart),
// so blur, darkening and tint are measurable.
//
//   maxfold-testwin.exe <mode normal|tiny|popup|tool> <life s> <x> <y> <w> <h>
//   stdout first line:  HWND <n> PID <n> FREQ <qpc ticks per second>
//   stdin, one command per line, one answer line each:
//     max | restore | min | unmin -> OK <cmd> zoomed=<bool> iconic=<bool> qpc=<QPC just before the change>
//                                   (max/restore WITHOUT activation: WS_MAXIMIZE + SetWindowPos(NOACTIVATE), see Run)
//     move x y w h               -> OK move          (SetWindowPos, no activation)
//     seed                       -> OK seed          (a 1 px size nudge and back: a location change)
//     fg                         -> FG <foreground hwnd>
//     affinity                   -> AFF <ok> <err>   (WDA_MONITOR: "hides itself from capture")
//     attr                       -> ATTR hr=0x... v=<DWMWA_TRANSITIONS_FORCEDISABLED as read back>
//     rect                       -> RECT l t r b frame l t r b
//     info <hwnd>                -> INFO vis=<0|1> ex=0x.. style=0x.. lwa=<ok>/<alpha>/<flags> rect l t r b above=<GW_HWNDPREV of THIS window>
//     bands <hwnd> <n> <png|->   -> BANDS ok=.. w=.. h=.. dx=.. dy=.. diff=<mean |o-s|> max=.. | per band: lumO lumS gradO gradS tintO tintS diff r g b ; ...
//                                   (<hwnd> = the overlay, grabbed with PrintWindow(PW_RENDERFULLCONTENT); this
//                                    window grabbed the same way and aligned by the two window rects)
//     grab <hwnd> <png>          -> GRAB ok=.. w=.. h=..
//     close                      -> (the window closes; the process ends)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class MaxFoldTestWin {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; public RECT(int l, int t, int r, int b) { L = l; T = t; R = r; B = b; } }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WNDCLASSEX {
    public uint cbSize, style; public WndProc proc; public int cls, wnd; public IntPtr inst, icon, cursor, bg; public string menu, name; public IntPtr iconSm; }
  [StructLayout(LayoutKind.Sequential)] struct BMIH { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int x, y; public uint clr, imp; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MINMAXINFO { public POINT res, maxSize, maxPos, minTrack, maxTrack; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cb; public RECT mon, work; public uint flags; }

  [DllImport("user32.dll")] static extern bool GetMessageW(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WNDCLASSEX c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLongW(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int i, uint dpi);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte a, out uint f);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern IntPtr BeginPaint(IntPtr h, byte[] ps);
  [DllImport("user32.dll")] static extern bool EndPaint(IntPtr h, byte[] ps);
  [DllImport("user32.dll")] static extern int FillRect(IntPtr dc, ref RECT r, IntPtr br);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO mi);
  [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint c);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMIH bi, uint u, out IntPtr bits, IntPtr s, uint o);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
  [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int m);
  [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint c);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontW(int h, int w, int e, int o, int wt, uint i, uint u, uint s, uint cs, uint op, uint cp, uint q, uint pf, string face);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int cb);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(IntPtr h, int a, out int v, int cb);

  static WndProc wp;
  static IntPtr H;
  static string Mode = "normal";
  static readonly Queue<string> Q = new Queue<string>();
  static readonly object Out = new object();
  static IntPtr Font, FontBig;
  static readonly CultureInfo IC = CultureInfo.InvariantCulture;

  static void Say(string s) { lock (Out) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

  static void Box(IntPtr dc, int l, int t, int r, int b, uint bgr) { RECT x = new RECT(l, t, r, b); IntPtr br = CreateSolidBrush(bgr); FillRect(dc, ref x, br); DeleteObject(br); }
  static void Text(IntPtr dc, int x, int y, string s, uint bgr) { SetTextColor(dc, bgr); TextOutW(dc, x, y, s, s.Length); }

  // A realistic app, repeated across the whole width so EVERY column band has edges to blur: a dark
  // toolbar with menu words, a sidebar list, text lines, colour blocks and a bar chart.
  static void Paint(IntPtr h) {
    byte[] ps = new byte[72]; IntPtr dc = BeginPaint(h, ps); RECT c; GetClientRect(h, out c);
    SetBkMode(dc, 1);
    Box(dc, 0, 0, c.R, c.B, 0x00F7F5F4);
    Box(dc, 0, 0, c.R, 46, 0x00423A2B);
    IntPtr old = SelectObject(dc, FontBig);
    Text(dc, 16, 11, "Mantle Notes", 0x00FFFFFF);
    SelectObject(dc, Font);
    string[] menu = { "File", "Edit", "View", "Insert", "Format", "Tools", "Help" };
    for (int x = 190, i = 0; x < c.R - 40; x += 70, i++) Text(dc, x, 14, menu[i % menu.Length], 0x00E0D8D0);
    Box(dc, 0, 46, 230, c.B, 0x00EFE8E6);
    for (int i = 0; i < 40; i++) {
      int y = 64 + i * 34; if (y > c.B - 20) break;
      if (i == 2) Box(dc, 8, y - 6, 222, y + 24, 0x00E83644);
      Text(dc, 24, y, "Folder item " + (i + 1), i == 2 ? 0x00FFFFFFu : 0x00403830u);
    }
    string line = "The quick brown fox jumps over the lazy dog. 0123456789 Sphinx of black quartz, judge my vow. ";
    string wide = line + line + line + line;
    for (int y = 104, k = 0; y < c.B - 24; y += 24, k++) Text(dc, 260, y, k % 5 == 4 ? wide.Substring(0, 120) : wide, 0x00302824);
    for (int bx = 300; bx < c.R - 200; bx += 520) {
      int by = 140;
      Box(dc, bx, by, bx + 340, by + 200, 0x00E83644);
      Box(dc, bx + 30, by + 30, bx + 160, by + 170, 0x0030A0F0);
      Box(dc, bx + 180, by + 60, bx + 310, by + 170, 0x0060C060);
      for (int i = 0; i < 24; i++) { int hh = 20 + (i * 37) % 120; Box(dc, bx + i * 14, by + 380 - hh, bx + i * 14 + 9, by + 380, 0x00905030); }
    }
    SelectObject(dc, old);
    EndPaint(h, ps);
  }

  static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) {
    if (m == 0x000F) { Paint(h); return IntPtr.Zero; }
    if (m == 0x0014) return new IntPtr(1);
    if (m == 0x0024 && (Mode == "tiny" || Mode == "popup")) {
      MINMAXINFO mm = (MINMAXINFO)Marshal.PtrToStructure(l, typeof(MINMAXINFO));
      if (Mode == "tiny") { mm.maxSize.x = 200; mm.maxSize.y = 130; mm.maxTrack.x = 200; mm.maxTrack.y = 130; }
      else {
        MONITORINFO mi = new MONITORINFO(); mi.cb = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfoW(MonitorFromWindow(h, 2), ref mi);
        mm.maxPos.x = 0; mm.maxPos.y = 0; mm.maxSize.x = mi.mon.R - mi.mon.L; mm.maxSize.y = mi.mon.B - mi.mon.T;
        mm.maxTrack.x = mm.maxSize.x; mm.maxTrack.y = mm.maxSize.y;
      }
      Marshal.StructureToPtr(mm, l, false); return IntPtr.Zero;
    }
    if (m == 0x0113) { DestroyWindow(h); return IntPtr.Zero; }
    if (m == 0x0002) { PostQuitMessage(0); return IntPtr.Zero; }
    if (m == 0x8001) { string cmd = null; lock (Q) if (Q.Count > 0) cmd = Q.Dequeue(); if (cmd != null) Run(cmd); return IntPtr.Zero; }
    return DefWindowProcW(h, m, w, l);
  }

  static RECT Frame(IntPtr h) { RECT f; if (DwmGetWindowAttribute(h, 9, out f, 16) != 0) GetWindowRect(h, out f); return f; }

  static byte[] Grab(IntPtr h, out int w, out int hh, out bool ok) {
    RECT r; GetWindowRect(h, out r); w = Math.Max(1, r.R - r.L); hh = Math.Max(1, r.B - r.T);
    IntPtr scr = GetDC(IntPtr.Zero);
    var bi = new BMIH(); bi.biSize = 40; bi.biWidth = w; bi.biHeight = -hh; bi.biPlanes = 1; bi.biBitCount = 32;
    IntPtr bits; IntPtr dib = CreateDIBSection(scr, ref bi, 0, out bits, IntPtr.Zero, 0); IntPtr mem = CreateCompatibleDC(scr); IntPtr old = SelectObject(mem, dib);
    ok = PrintWindow(h, mem, 2);
    byte[] px = new byte[w * hh * 4]; Marshal.Copy(bits, px, 0, px.Length);
    SelectObject(mem, old); DeleteObject(dib); DeleteDC(mem); ReleaseDC(IntPtr.Zero, scr);
    return px;
  }

  static void Save(byte[] px, int w, int h, string path) {
    byte[] c = (byte[])px.Clone(); for (int i = 3; i < c.Length; i += 4) c[i] = 255;
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb); var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(c, 0, bd.Scan0, c.Length); bmp.UnlockBits(bd); bmp.Save(path, ImageFormat.Png); bmp.Dispose();
  }

  static double Lum(byte[] p, int i) { return 0.114 * p[i] + 0.587 * p[i + 1] + 0.299 * p[i + 2]; }

  // The overlay (o, ow x oh) against this window (s, sw x sh), overlay pixel (x, y) = window pixel (x+dx, y+dy).
  // Per column band of the overlay: mean luminance (o, s), mean |horizontal luminance step| (sharpness; o, s),
  // mean blue minus green (the indigo cast; o, s), mean |o - s| over the three channels, mean r g b of o.
  static string Bands(byte[] o, int ow, int oh, byte[] s, int sw, int sh, int dx, int dy, int n, out double all, out int mx) {
    var sb = new StringBuilder(); long dAll = 0, nAll = 0; mx = 0;
    for (int b = 0; b < n; b++) {
      int l = ow * b / n, r = ow * (b + 1) / n;
      double lo = 0, ls = 0, go = 0, gs = 0, to = 0, ts = 0, df = 0, rr = 0, gg = 0, bb = 0; long cnt = 0;
      for (int y = 2; y < oh - 2; y += 2) {
        int sy = y + dy; if (sy < 0 || sy >= sh) continue;
        for (int x = l + 1; x < r - 2; x++) {
          int sx = x + dx; if (sx < 0 || sx + 1 >= sw) continue;
          int i = (y * ow + x) * 4, j = (sy * sw + sx) * 4;
          double Lo = Lum(o, i), Ls = Lum(s, j);
          lo += Lo; ls += Ls; go += Math.Abs(Lum(o, i + 4) - Lo); gs += Math.Abs(Lum(s, j + 4) - Ls);
          to += o[i] - o[i + 1]; ts += s[j] - s[j + 1];
          for (int k = 0; k < 3; k++) { int d = Math.Abs(o[i + k] - s[j + k]); df += d; dAll += d; nAll++; if (d > mx) mx = d; }
          bb += o[i]; gg += o[i + 1]; rr += o[i + 2]; cnt++;
        }
      }
      if (cnt == 0) cnt = 1;
      sb.Append(string.Format(IC, "{0}{1:F1} {2:F1} {3:F2} {4:F2} {5:F1} {6:F1} {7:F2} {8:F1} {9:F1} {10:F1}", b == 0 ? "" : " ; ",
        lo / cnt, ls / cnt, go / cnt, gs / cnt, to / cnt, ts / cnt, df / (3.0 * cnt), rr / cnt, gg / cnt, bb / cnt));
    }
    all = nAll == 0 ? -1 : dAll / (double)nAll;
    return sb.ToString();
  }

  static string B(bool v) { return v ? "true" : "false"; }

  static RECT Normal;
  static bool HaveNormal;
  const uint NOACT = 0x0010 | 0x0004 | 0x0020; // NOACTIVATE | NOZORDER | FRAMECHANGED

  static void Maximize() {
    int style = GetWindowLong(H, -16);
    if ((style & 0x01000000) != 0) return; // already maximized
    RECT r; GetWindowRect(H, out r); Normal = r; HaveNormal = true;
    MONITORINFO mi = new MONITORINFO(); mi.cb = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfoW(MonitorFromWindow(H, 2), ref mi);
    RECT t;
    if (Mode == "popup") t = mi.mon;
    else {
      uint dpi = GetDpiForWindow(H); if (dpi == 0) dpi = 96;
      int b = GetSystemMetricsForDpi(32 /*SM_CXSIZEFRAME*/, dpi) + GetSystemMetricsForDpi(92 /*SM_CXPADDEDBORDER*/, dpi);
      t = new RECT(mi.work.L - b, mi.work.T - b, mi.work.R + b, mi.work.B + b);
      if (Mode == "tiny") t = new RECT(mi.work.L, mi.work.T, mi.work.L + 200, mi.work.T + 130);
    }
    SetWindowLongW(H, -16, style | 0x01000000);   // WS_MAXIMIZE: what IsZoomed reads
    SetWindowPos(H, IntPtr.Zero, t.L, t.T, t.R - t.L, t.B - t.T, NOACT);
  }

  static void Restore() {
    int style = GetWindowLong(H, -16);
    if ((style & 0x01000000) == 0 && !IsIconic(H)) return;
    if (IsIconic(H)) { ShowWindow(H, 4); style = GetWindowLong(H, -16); }
    SetWindowLongW(H, -16, style & ~0x01000000);
    if (HaveNormal) SetWindowPos(H, IntPtr.Zero, Normal.L, Normal.T, Normal.R - Normal.L, Normal.B - Normal.T, NOACT);
    else SetWindowPos(H, IntPtr.Zero, 0, 0, 0, 0, NOACT | 0x0001 | 0x0002);
  }

  static void Run(string cmd) {
    string[] a = cmd.Split(' ');
    try {
      switch (a[0]) {
        case "max": case "restore": case "min": case "unmin": {
          // NEVER ShowWindow(SW_MAXIMIZE/SW_RESTORE): they ACTIVATE, and once the foreground lock has run out
          // (no input for a while: Owen watching a video) even this disabled no-activate window takes the
          // foreground (measured 2026-10-23: 5 times in one run). So maximize/restore are made the way the
          // sidecar sees them, without activation: the WS_MAXIMIZE style + one SetWindowPos(NOACTIVATE) to the
          // rect Windows would use (the work area grown by the resize border), and back.
          long q = Stopwatch.GetTimestamp();
          if (a[0] == "max") Maximize(); else if (a[0] == "restore") Restore();
          else if (a[0] == "min") ShowWindow(H, 7);   // SW_SHOWMINNOACTIVE
          else ShowWindow(H, 4);                      // SW_SHOWNOACTIVATE: back from minimized
          Say("OK " + a[0] + " zoomed=" + B(IsZoomed(H)) + " iconic=" + B(IsIconic(H)) + " qpc=" + q);
          break;
        }
        case "move": SetWindowPos(H, IntPtr.Zero, int.Parse(a[1]), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), 0x0014); Say("OK move"); break;
        case "seed": {
          RECT r; GetWindowRect(H, out r);
          SetWindowPos(H, IntPtr.Zero, 0, 0, r.R - r.L - 1, r.B - r.T, 0x0016);
          SetWindowPos(H, IntPtr.Zero, 0, 0, r.R - r.L, r.B - r.T, 0x0016);
          Say("OK seed"); break;
        }
        case "fg": Say("FG " + GetForegroundWindow().ToInt64()); break;
        case "affinity": { bool ok = SetWindowDisplayAffinity(H, 1); Say("AFF " + B(ok) + " " + Marshal.GetLastWin32Error()); break; }
        case "attr": { int v; int hr = DwmGetWindowAttributeInt(H, 3, out v, 4); Say("ATTR hr=0x" + hr.ToString("X8") + " v=" + v); break; }
        case "rect": { RECT r; GetWindowRect(H, out r); RECT f = Frame(H); Say("RECT " + r.L + " " + r.T + " " + r.R + " " + r.B + " frame " + f.L + " " + f.T + " " + f.R + " " + f.B); break; }
        case "info": {
          IntPtr t = new IntPtr(long.Parse(a[1])); uint key, fl; byte al; bool lok = GetLayeredWindowAttributes(t, out key, out al, out fl);
          RECT r; GetWindowRect(t, out r);
          Say("INFO vis=" + (IsWindowVisible(t) ? 1 : 0) + " ex=0x" + GetWindowLong(t, -20).ToString("X8") + " style=0x" + GetWindowLong(t, -16).ToString("X8") +
              " lwa=" + B(lok) + "/" + al + "/" + fl + " rect " + r.L + " " + r.T + " " + r.R + " " + r.B + " above=" + GetWindow(H, 3).ToInt64());
          break;
        }
        case "grab": {
          IntPtr t = new IntPtr(long.Parse(a[1])); int w, h; bool ok; byte[] px = Grab(t, out w, out h, out ok);
          if (a.Length > 2 && a[2] != "-") Save(px, w, h, a[2]);
          Say("GRAB ok=" + B(ok) + " w=" + w + " h=" + h); break;
        }
        case "bands": {
          IntPtr t = new IntPtr(long.Parse(a[1])); int n = a.Length > 2 ? Math.Max(1, Math.Min(64, int.Parse(a[2]))) : 20;
          int ow, oh, sw, sh; bool ok1, ok2;
          byte[] o = Grab(t, out ow, out oh, out ok1); byte[] s = Grab(H, out sw, out sh, out ok2);
          RECT wr; GetWindowRect(H, out wr); RECT orc; GetWindowRect(t, out orc);
          int dx = orc.L - wr.L, dy = orc.T - wr.T; double all; int mx;
          string bands = Bands(o, ow, oh, s, sw, sh, dx, dy, n, out all, out mx);
          if (a.Length > 3 && a[3] != "-") Save(o, ow, oh, a[3]);
          if (a.Length > 4 && a[4] != "-") Save(s, sw, sh, a[4]);
          Say("BANDS ok=" + B(ok1 && ok2) + " w=" + ow + " h=" + oh + " dx=" + dx + " dy=" + dy + " diff=" + all.ToString("F3", IC) + " max=" + mx + " | " + bands);
          break;
        }
        case "close": DestroyWindow(H); break;
        default: Say("ERR unknown " + a[0]); break;
      }
    } catch (Exception ex) { Say("ERR " + ex.GetType().Name + ": " + ex.Message); }
  }

  [STAThread] static int Main(string[] args) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    if (args.Length > 0) Mode = args[0];
    int life = args.Length > 1 ? int.Parse(args[1]) : 60;
    int x = args.Length > 2 ? int.Parse(args[2]) : 120, y = args.Length > 3 ? int.Parse(args[3]) : 90;
    int w = args.Length > 4 ? int.Parse(args[4]) : 1000, h = args.Length > 5 ? int.Parse(args[5]) : 640;
    Font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
    FontBig = CreateFontW(-19, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
    wp = Proc;
    var wc = new WNDCLASSEX(); wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)); wc.proc = wp; wc.name = "MantleMaxfoldTestWin"; wc.inst = Marshal.GetHINSTANCE(typeof(MaxFoldTestWin).Module);
    RegisterClassExW(ref wc);
    // The hidden owner: a tool popup, never shown (so the test window is in no taskbar and no Alt+Tab).
    IntPtr owner = CreateWindowExW(0x80, "MantleMaxfoldTestWin", "", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.inst, IntPtr.Zero);
    // LAYERED | TRANSPARENT | NOACTIVATE; WS_OVERLAPPEDWINDOW | WS_DISABLED.
    uint ex = 0x00080000 | 0x20 | 0x08000000, style = 0x00CF0000 | 0x08000000;
    if (Mode == "tool") ex |= 0x80;
    if (Mode == "popup") {
      style = 0x80000000 | 0x00010000 | 0x08000000; // WS_POPUP | WS_MAXIMIZEBOX | WS_DISABLED: no caption
      MONITORINFO mi = new MONITORINFO(); mi.cb = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfoW(MonitorFromWindow(owner, 1), ref mi);
      x = mi.mon.L + 100; y = mi.mon.T + 100; w = 900; h = 600;
    }
    H = CreateWindowExW(ex, "MantleMaxfoldTestWin", "", style, x, y, w, h, owner, IntPtr.Zero, wc.inst, IntPtr.Zero);
    SetLayeredWindowAttributes(H, 0, (byte)(Environment.GetEnvironmentVariable("MAXFOLD_TEST_VISIBLE") == "1" ? 255 : 0), 2);
    ShowWindow(H, 8);                                     // SW_SHOWNA
    SetWindowPos(H, new IntPtr(1), 0, 0, 0, 0, 0x13);     // HWND_BOTTOM, NOSIZE | NOMOVE | NOACTIVATE
    SetTimer(H, new IntPtr(1), (uint)(life * 1000), IntPtr.Zero);
    Say("HWND " + H.ToInt64() + " PID " + Process.GetCurrentProcess().Id + " FREQ " + Stopwatch.Frequency);
    var reader = new Thread(delegate () {
      string l;
      while ((l = Console.In.ReadLine()) != null) { l = l.Trim(); if (l.Length == 0) continue; lock (Q) Q.Enqueue(l); PostMessageW(H, 0x8001, IntPtr.Zero, IntPtr.Zero); }
      PostMessageW(H, 0x0010, IntPtr.Zero, IntPtr.Zero); // stdin closed (the harness died): WM_CLOSE
    });
    reader.IsBackground = true; reader.Start();
    MSG m;
    while (GetMessageW(out m, IntPtr.Zero, 0, 0)) { TranslateMessage(ref m); DispatchMessageW(ref m); }
    return 0;
  }
}
