// UnderRow.cs - `underrow`: ONE physical row of the screen, averaged into n columns, for the top bar's
// colour under it (lib/topbar-under.js, lane mantle-topbar-under, 2026-10-11).
//
// Owen: "can we make it so that it changes colors faster like imediatly? so theres no delay?" The bar
// reads the row right under it many times a second while it changes, so each read must be cheap.
// `backdrop` (Backdrop.cs) answers with a PNG: FromHbitmap + a GDI+ PNG encode + base64 here, and a
// zlib inflate + a column average in main, for a 1-pixel-high strip. This does the same read with
// none of that: BitBlt the row into a cached 32-bpp top-down DIB section (its bits are ours to read,
// no copy out of a DDB), average the columns here, and answer n*3 bytes (r,g,b per column) in base64.
// Its own DC and DIB, so it never thrashes Backdrop's cached surface (the glass reads other sizes).
//
// The columns are EXACTLY lib/topbar-under.js columnsOf: column c covers physical x in
// [floor(c*w/n), max(x0+1, floor((c+1)*w/n))), rounded mean per channel.
//
// Runs on the CAPTURE lane (Lanes.cs), like `backdrop`, and in passive mode (the --test sidecar).
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Mantle {
  static class UnderRow {
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern IntPtr CreateDIBSection(IntPtr dc, ref Win32.BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    const int MaxW = 16384;
    static readonly object _lock = new object();
    static IntPtr _dc = IntPtr.Zero, _bmp = IntPtr.Zero, _old = IntPtr.Zero, _bits = IntPtr.Zero;
    static int _w;
    static byte[] _row = new byte[0];

    /// Returns null on success, else the reason in words. cols = base64 of n*3 bytes.
    public static string Read(int x, int y, int w, int n, out string cols, out double ms) {
      cols = null;
      ms = 0;
      if (w <= 0) return "underrow: w must be positive physical pixels";
      if (w > MaxW) w = MaxW;
      if (n <= 0 || n > w) return "underrow: n must be between 1 and w (" + w + ")";
      int vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
      int vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
      int vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
      int vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
      if (vw <= 0 || vh <= 0) return "underrow: the virtual screen size could not be read";
      if (x < vx || y < vy || x + w > vx + vw || y + 1 > vy + vh)
        return "underrow: the row " + x + "," + y + " " + w + "x1 is outside the screen (the desktop is " +
               vx + "," + vy + " " + vw + "x" + vh + " in physical pixels)";
      lock (_lock) {
        var sw = Stopwatch.StartNew();
        IntPtr screen = Win32.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return "underrow: the screen DC could not be opened";
        try {
          string err = Ensure(screen, w);
          if (err != null) return err;
          // CAPTUREBLT: include layered windows, as `backdrop` does
          if (!Win32.BitBlt(_dc, 0, 0, w, 1, screen, x, y, Win32.SRCCOPY | Win32.CAPTUREBLT))
            return "underrow: BitBlt failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
          GdiFlush();
          Marshal.Copy(_bits, _row, 0, w * 4);
          var outb = new byte[n * 3];
          for (int c = 0; c < n; c++) {
            int x0 = (int)((long)c * w / n);
            int x1 = Math.Max(x0 + 1, (int)((long)(c + 1) * w / n));
            if (x1 > w) x1 = w;
            int r = 0, g = 0, b = 0, k = 0;
            for (int px = x0; px < x1; px++) {
              int i = px * 4;   // BGRA
              b += _row[i]; g += _row[i + 1]; r += _row[i + 2]; k++;
            }
            if (k > 0) {
              // Math.round in JS rounds .5 up; MidpointRounding.AwayFromZero is the same for positives
              outb[c * 3] = (byte)Math.Round((double)r / k, MidpointRounding.AwayFromZero);
              outb[c * 3 + 1] = (byte)Math.Round((double)g / k, MidpointRounding.AwayFromZero);
              outb[c * 3 + 2] = (byte)Math.Round((double)b / k, MidpointRounding.AwayFromZero);
            }
          }
          cols = Convert.ToBase64String(outb);
          ms = sw.Elapsed.TotalMilliseconds;
          return null;
        } catch (Exception ex) {
          return "underrow: the read failed (" + ex.GetType().Name + ": " + ex.Message + ")";
        } finally {
          Win32.ReleaseDC(IntPtr.Zero, screen);
        }
      }
    }

    static string Ensure(IntPtr screen, int w) {
      if (_dc != IntPtr.Zero && _bmp != IntPtr.Zero && _w == w) return null;
      Release();
      _dc = Win32.CreateCompatibleDC(screen);
      if (_dc == IntPtr.Zero) return "underrow: a memory DC could not be created";
      var bi = new Win32.BITMAPINFOHEADER();
      bi.biSize = (uint)Marshal.SizeOf(typeof(Win32.BITMAPINFOHEADER));
      bi.biWidth = w;
      bi.biHeight = -1;   // top-down
      bi.biPlanes = 1;
      bi.biBitCount = 32;
      bi.biCompression = Win32.BI_RGB;
      IntPtr bits;
      _bmp = CreateDIBSection(_dc, ref bi, Win32.DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
      if (_bmp == IntPtr.Zero || bits == IntPtr.Zero) { Release(); return "underrow: the row bitmap could not be created"; }
      _bits = bits;
      _old = Win32.SelectObject(_dc, _bmp);
      _w = w;
      _row = new byte[w * 4];
      return null;
    }

    static void Release() {
      if (_dc != IntPtr.Zero && _old != IntPtr.Zero) Win32.SelectObject(_dc, _old);
      if (_bmp != IntPtr.Zero) Win32.DeleteObject(_bmp);
      if (_dc != IntPtr.Zero) Win32.DeleteDC(_dc);
      _dc = _bmp = _old = _bits = IntPtr.Zero;
      _w = 0;
    }
  }
}
