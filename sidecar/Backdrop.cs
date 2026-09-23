// Backdrop.cs - `backdrop`: a downscaled PNG of what is behind Mantle's bar, so
// the UI can blur its own backdrop.
//
// WHY MANTLE BLURS ITSELF. Measured on this build (2026-09-21): DWM's acrylic
// accent IGNORES the tint alpha - 1% and 40% render identically as a fixed,
// near-opaque frost - and plain blur-behind paints a black slab. Neither is a
// usable backdrop for a bar that is meant to read as glass over the wallpaper.
// So the page takes a picture of what is behind it and blurs THAT, in CSS,
// where the look is actually controllable.
//
// WHAT THIS COSTS, and why the shape of the call matters. A screen grab is the
// most expensive thing in this protocol, so:
//
//   * the caller asks for ONE rect, not the screen;
//   * `scale` (default 4) means the bitmap that crosses the wire is 1/16th the
//     pixels - and a backdrop is about to be blurred anyway, so the detail
//     would be thrown away regardless;
//   * the memory DC and the DDB are CACHED and reused whenever the same size
//     comes round again, which is every frame of a bar that does not resize;
//   * the reply carries `ms`, measured, so the caller can see what it is
//     spending instead of guessing.
//
// CAPTUREBLT is in the raster op deliberately: without it layered and
// DWM-composed windows are missing from the grab and the "glass" shows holes.
//
// WHAT THIS DOES NOT DO: window affinity. main.js takes Mantle's own bar out of
// the capture (Electron setContentProtection / WDA_EXCLUDEFROMCAPTURE) right
// before calling, because that is a property of ITS window - the sidecar
// setting affinity on someone else's window would be exactly the kind of
// invisible, sticky state this process is not allowed to hold.
//
// READ-ONLY, so it runs in --passive: BitBlt out of the screen DC changes
// nothing on the desktop.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  static class Backdrop {
    /// A single capture wider or taller than this is a caller bug, not a
    /// backdrop: 4096 is past any physical screen edge on this machine.
    public const int MaxSide = 4096;
    public const int MinScale = 1;
    public const int MaxScale = 8;
    public const int DefaultScale = 4;

    // The cache: one memory DC and one DDB, kept while the size repeats.
    static IntPtr _memDc = IntPtr.Zero, _bmp = IntPtr.Zero, _oldBmp = IntPtr.Zero;
    static int _cw, _ch;

    /// Returns null on success. Never leaves a GDI object behind on any path:
    /// the cached pair is reused or replaced, everything else is freed here.
    ///
    /// Runs on the CAPTURE lane (Lanes.cs), its own thread, so a grab can never
    /// make a button wait. The lock is for the one other caller of the cached
    /// pair: Release() on the shutdown path.
    public static string Capture(int x, int y, int w, int h, int scale,
                                 out string png, out int outW, out int outH, out double ms, out int usedScale) {
      lock (_gdiLock) {
        return CaptureLocked(x, y, w, h, scale, out png, out outW, out outH, out ms, out usedScale);
      }
    }

    static readonly object _gdiLock = new object();

    static string CaptureLocked(int x, int y, int w, int h, int scale,
                                out string png, out int outW, out int outH, out double ms, out int usedScale) {
      png = null;
      outW = outH = 0;
      ms = 0;
      usedScale = scale < MinScale ? MinScale : (scale > MaxScale ? MaxScale : scale);

      if (w <= 0 || h <= 0) return "backdrop: w and h must be positive physical pixels";
      if (w > MaxSide) w = MaxSide;
      if (h > MaxSide) h = MaxSide;

      // Against the VIRTUAL screen, so a capture on a second monitor (where x
      // or y can be negative) is legal and a nonsense rect is not.
      int vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
      int vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
      int vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
      int vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
      if (vw <= 0 || vh <= 0) return "backdrop: the virtual screen size could not be read";
      if (x < vx || y < vy || x + w > vx + vw || y + h > vy + vh)
        return "backdrop: the rect " + x + "," + y + " " + w + "x" + h +
               " is outside the screen (the desktop is " + vx + "," + vy + " " + vw + "x" + vh +
               " in physical pixels)";

      var sw = Stopwatch.StartNew();
      IntPtr screen = IntPtr.Zero;
      try {
        screen = Win32.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return "backdrop: the screen DC could not be opened";

        string err = EnsureSurface(screen, w, h);
        if (err != null) return err;

        // CAPTUREBLT: include layered/composed windows, or the grab has holes.
        if (!Win32.BitBlt(_memDc, 0, 0, w, h, screen, x, y, Win32.SRCCOPY | Win32.CAPTUREBLT))
          return "backdrop: BitBlt failed (Win32 error " + Marshal.GetLastWin32Error() + ")";

        outW = Math.Max(1, (int)Math.Round((double)w / usedScale));
        outH = Math.Max(1, (int)Math.Round((double)h / usedScale));

        // FromHbitmap copies the DDB into a managed bitmap; the cached DDB
        // stays ours and is reused on the next call.
        using (Bitmap shot = Image.FromHbitmap(_bmp)) {
          if (outW == w && outH == h) {
            png = Encode(shot);
          } else {
            // 24bpp: the screen has no alpha, and a third fewer bytes to
            // compress on every frame of a bar that repaints.
            using (var small = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
            using (var g = Graphics.FromImage(small)) {
              // Bilinear, not bicubic: this is about to be blurred in CSS, so
              // the extra sharpness would cost time for nothing.
              g.InterpolationMode = InterpolationMode.HighQualityBilinear;
              g.PixelOffsetMode = PixelOffsetMode.HighQuality;
              g.CompositingMode = CompositingMode.SourceCopy;
              g.DrawImage(shot, new Rectangle(0, 0, outW, outH));
              png = Encode(small);
            }
          }
        }
        ms = sw.Elapsed.TotalMilliseconds;
        return null;
      } catch (Exception ex) {
        return "backdrop: the capture failed (" + ex.GetType().Name + ": " + ex.Message + ")";
      } finally {
        if (screen != IntPtr.Zero) Win32.ReleaseDC(IntPtr.Zero, screen);
      }
    }

    static string Encode(Bitmap b) {
      using (var msOut = new MemoryStream()) {
        b.Save(msOut, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(msOut.ToArray());
      }
    }

    /// The cache. Same size as last time: nothing allocated at all. Different
    /// size: the old pair is freed first, so a resizing bar cannot leak GDI
    /// handles one frame at a time.
    static string EnsureSurface(IntPtr screen, int w, int h) {
      if (_memDc != IntPtr.Zero && _bmp != IntPtr.Zero && _cw == w && _ch == h) return null;
      Release();

      _memDc = Win32.CreateCompatibleDC(screen);
      if (_memDc == IntPtr.Zero) return "backdrop: a memory DC could not be created";
      _bmp = Win32.CreateCompatibleBitmap(screen, w, h);
      if (_bmp == IntPtr.Zero) { Release(); return "backdrop: a " + w + "x" + h + " bitmap could not be created"; }
      _oldBmp = Win32.SelectObject(_memDc, _bmp);
      _cw = w;
      _ch = h;
      return null;
    }

    /// Frees the cached pair. Safe to call twice; safe to call when empty.
    /// From the shutdown path it gives up after 200 ms rather than wait for a
    /// capture in progress: the handles are process-owned and die with us, and
    /// a restore must never queue behind a screen grab. (From inside Capture
    /// the lock is already ours, so this is immediate.)
    public static void Release() {
      if (!Monitor.TryEnter(_gdiLock, 200)) return;
      try { ReleaseLocked(); } finally { Monitor.Exit(_gdiLock); }
    }

    static void ReleaseLocked() {
      try {
        if (_memDc != IntPtr.Zero && _oldBmp != IntPtr.Zero) Win32.SelectObject(_memDc, _oldBmp);
      } catch (Exception) { }
      try { if (_bmp != IntPtr.Zero) Win32.DeleteObject(_bmp); } catch (Exception) { }
      try { if (_memDc != IntPtr.Zero) Win32.DeleteDC(_memDc); } catch (Exception) { }
      _bmp = _memDc = _oldBmp = IntPtr.Zero;
      _cw = _ch = 0;
    }
  }
}
