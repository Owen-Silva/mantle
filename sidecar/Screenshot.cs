// Screenshot.cs - `shot.*`: the freeze-frame behind Mantle's Win+Shift+S (wave 3, 2026-09-24).
//
// WHAT IT IS FOR. Win+Shift+S (and PrintScreen) must freeze EVERY monitor at the same instant,
// cover each with a dimmed copy of itself, and cut the user's selection out of that copy - not
// out of a second, later grab, because by then a tooltip has closed or a video frame has moved.
// So the sidecar keeps the whole frame in memory from `shot.grab` until `shot.release`, and
// `shot.save` crops from THAT.
//
// THE FAST PATH, AND WHY IT IS NOT `backdrop` (Backdrop.cs). `backdrop` answers with a PNG as a
// base64 data URL over stdout: right for a 1/16th-size strip four times a second, wrong for a
// full-resolution freeze-frame, where the PNG encode and ~11 MB of base64 per 1080p screen would
// sit between the chord and the overlay. What is reused is its capture: one BitBlt out of the
// screen DC with CAPTUREBLT (so layered and DWM-composed windows are in the grab). What changes:
//
//   * ONE BitBlt of the whole VIRTUAL screen into a DIB section, so every monitor is frozen in
//     the same call (the sidecar is per-monitor DPI aware - Program.cs - so this is physical
//     pixels on every monitor, whatever its scale);
//   * each monitor's part is written to a BMP file in a TEMP folder: a BMP is the DIB's own bytes
//     behind a 66-byte header, so "encoding" it is a memcpy, and the overlay page shows it with a
//     plain <img>;
//   * the header is BI_BITFIELDS with no alpha mask, so a browser ignores the fourth byte, which
//     BitBlt leaves undefined (a layered window can leave it non-zero, which as alpha would punch
//     holes in the frozen frame).
//   * RAW PIXELS (lane speeddebt, 2026-10-15): the pixels are written in RGBA order with the fourth
//     byte set to 255 (masks R 0xFF, G 0xFF00, B 0xFF0000), so the bytes after the 66-byte header
//     are EXACTLY a canvas ImageData, top-down. The overlay page puts them on a canvas as they are
//     (putImageData) instead of the browser decoding the BMP (46 ms median, 112 p95 live on this
//     i3); the file is still a valid BMP for the card's <img> pieces. The reorder is one integer
//     pass over each 1 MB chunk while it is written (`pixels` in the reply says the layout).
// Measured timings are in the `ms` of every reply, and in lib/features/screenshot.js's header.
//
// PRIVACY. The frames ARE Owen's screen, so: they only ever go to a folder under %TEMP% (a grab
// refuses any other `dir`), each grab deletes the frames the previous one left (a crash included),
// and `shot.release` deletes this grab's. Nothing here logs a pixel. `synthetic:true` fills the
// frame with a generated pattern INSTEAD of the screen, so tests can check pixels end to end
// without ever reading his.
//
// PASSIVE (--passive, the test sidecar): a grab only reads the screen and writes to temp, so it
// runs. `shot.save` writes a file, so in passive it only writes under %TEMP% and refuses anywhere
// else - a test can never put a file in his Pictures folder, even by mistake.
//
// `shot.owner` (lane shotfix, 2026-09-28) names the PROCESS behind a window found in front of the
// overlay, so screenshot.js can tell Windows' own shell UI (Start, Search, the notification centre,
// Windows' snip: all "Windows.UI.Core.CoreWindow") from a real failure. File name and class only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class Screenshot {
    public static void Register(FeatureTable t) {
      t.Add("shot.grab", Lanes.Capture, Grab);
      t.Add("shot.save", Lanes.Capture, Save);
      t.Add("shot.copy", Lanes.Capture, Copy);      // the clipboard, straight from the frame (no PNG in between)
      t.Add("shot.release", Lanes.Capture, Release);
      t.Add("shot.folder", Lanes.Slow, Folder);
      t.Add("shot.ocr", Lanes.Capture, OcrCmd);     // "Copy text": Ocr.cs reads the same frozen frame
      t.Add("shot.owner", Lanes.Capture, Owner);    // which process owns a window in front of the overlay
    }

    /// The frame names start with this, and only files that do are ever deleted from `dir`.
    public const string FramePrefix = "mantle-shot-";
    /// More than this many physical pixels in the virtual screen (about three 4K monitors and
    /// a bit) is refused with the size, rather than a DIB allocation failing somewhere odd.
    public const long MaxPixels = 40000000L;
    const int MaxWindows = 400;

    sealed class Frame {
      public int Id;
      public IntPtr Bmp = IntPtr.Zero;
      public IntPtr Bits = IntPtr.Zero;
      public int X, Y, W, H;
      public bool Synthetic;
      public List<string> Files = new List<string>();
    }

    static readonly object _lock = new object();
    static Frame _cur;
    static int _nextId = 1;

    /* ---- shot.grab ------------------------------------------------------------------------ */

    /// {dir, exclude?:[hwnd,...], synthetic?:bool, text?:[line,...], textAt?:{x,y}, textPx?, textPad?}
    ///   -> {grab, virt, monitors[], windows[], textBox, ms}
    /// `text` (synthetic only, for the OCR tests) draws known lines over the pattern: DrawSyntheticText.
    static string Grab(Dictionary<string, object> req, ref object result) {
      string dir = Json.GetString(req, "dir");
      string derr = CheckTempDir(dir, "shot.grab: the frames");
      if (derr != null) return derr;
      bool synthetic = Json.GetBool(req, "synthetic", false);
      var exclude = new HashSet<long>();
      object ex;
      if (Json.TryGet(req, "exclude", out ex) && ex is List<object>) {
        foreach (object o in (List<object>)ex) {
          long n = 0;
          if (o is double) n = (long)(double)o;
          else if (o is string) long.TryParse((string)o, out n);
          if (n != 0) exclude.Add(n);
        }
      }

      var total = Stopwatch.StartNew();
      lock (_lock) {
        FreeLocked();
        try { Directory.CreateDirectory(dir); }
        catch (Exception e) { return "shot.grab: the frame folder could not be made (" + Reason(e) + ")"; }
        int stale = DeleteStaleFrames(dir);

        int vx = ShotNative.GetSystemMetrics(76), vy = ShotNative.GetSystemMetrics(77);
        int vw = ShotNative.GetSystemMetrics(78), vh = ShotNative.GetSystemMetrics(79);
        // Tests only (synthetic): `size` {w,h} makes the frame that big (a 4K frame on a 1080p
        // desktop, for timings), `fill` tiles a picture from under %TEMP% over the pattern
        // (screen-like content, for encode timings). Never the screen, so nothing of Owen's.
        object sizeObj;
        if (synthetic && Json.TryGet(req, "size", out sizeObj) && sizeObj is Dictionary<string, object>) {
          int sw0 = Json.GetInt((Dictionary<string, object>)sizeObj, "w", 0), sh0 = Json.GetInt((Dictionary<string, object>)sizeObj, "h", 0);
          if (sw0 > 0 && sh0 > 0) { vw = sw0; vh = sh0; }
        }
        string fill = synthetic ? Json.GetString(req, "fill") : null;
        if (!string.IsNullOrEmpty(fill)) {
          string ferr = CheckTempDir(Path.GetDirectoryName(fill), "shot.grab: a fill picture");
          if (ferr != null) return ferr;
        }
        if (vw <= 0 || vh <= 0) return "shot.grab: the virtual screen size could not be read";
        if ((long)vw * vh > MaxPixels)
          return "shot.grab: the desktop is " + vw + "x" + vh + " physical pixels, more than the " +
                 MaxPixels + " a freeze-frame is allowed to hold";

        var f = new Frame();
        f.Id = _nextId++;
        f.X = vx; f.Y = vy; f.W = vw; f.H = vh; f.Synthetic = synthetic;

        double bltMs, writeMs;
        IDictionary textBox = null;      // synthetic `text` only (tests): where it was drawn
        var sw = Stopwatch.StartNew();
        IntPtr screen = ShotNative.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return "shot.grab: the screen DC could not be opened";
        try {
          var bmi = new ShotNative.BITMAPINFOHEADER();
          bmi.biSize = 40; bmi.biWidth = vw; bmi.biHeight = -vh;   // negative: top-down rows
          bmi.biPlanes = 1; bmi.biBitCount = 32; bmi.biCompression = 0;
          IntPtr bits;
          f.Bmp = ShotNative.CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
          if (f.Bmp == IntPtr.Zero || bits == IntPtr.Zero)
            return "shot.grab: a " + vw + "x" + vh + " frame could not be allocated (Win32 error " +
                   Marshal.GetLastWin32Error() + ")";
          f.Bits = bits;
          if (synthetic) {
            FillSynthetic(f);
            if (!string.IsNullOrEmpty(fill)) {
              string ferr = FillFrom(f, fill);
              if (ferr != null) { FreeFrame(f); return "shot.grab: " + ferr; }
            }
            object tl;
            if (Json.TryGet(req, "text", out tl) && tl is List<object> && ((List<object>)tl).Count > 0) {
              object at;
              Json.TryGet(req, "textAt", out at);
              textBox = DrawSyntheticText(f, (List<object>)tl, at as Dictionary<string, object>, Json.GetInt(req, "textPx", 20), Json.GetInt(req, "textPad", -1));
            }
          } else {
            IntPtr mem = ShotNative.CreateCompatibleDC(screen);
            if (mem == IntPtr.Zero) { FreeFrame(f); return "shot.grab: a memory DC could not be created"; }
            IntPtr old = ShotNative.SelectObject(mem, f.Bmp);
            bool ok = ShotNative.BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, 0x00CC0020 | 0x40000000);
            int bltErr = Marshal.GetLastWin32Error();
            ShotNative.SelectObject(mem, old);
            ShotNative.DeleteDC(mem);
            if (!ok) { FreeFrame(f); return "shot.grab: BitBlt failed (Win32 error " + bltErr + ")"; }
          }
          ShotNative.GdiFlush();
        } finally {
          ShotNative.ReleaseDC(IntPtr.Zero, screen);
        }
        bltMs = sw.Elapsed.TotalMilliseconds;

        sw.Restart();
        var mons = new List<object>();
        List<ShotNative.MonitorRow> rows = ShotNative.Monitors();
        if (rows.Count == 0) { FreeFrame(f); return "shot.grab: Windows listed no monitors"; }
        for (int i = 0; i < rows.Count; i++) {
          ShotNative.MonitorRow m = rows[i];
          int l = Math.Max(m.X, vx), tp = Math.Max(m.Y, vy);
          int r = Math.Min(m.X + m.W, vx + vw), b = Math.Min(m.Y + m.H, vy + vh);
          string file = null;
          long bytes = 0;
          if (r > l && b > tp) {
            file = Path.Combine(dir, FramePrefix + f.Id + "-" + i + ".bmp");
            try { bytes = WriteBmp(file, f, l - vx, tp - vy, r - l, b - tp); }
            catch (Exception e2) {
              FreeFrame(f);
              return "shot.grab: the frame for monitor " + (i + 1) + " could not be written (" + Reason(e2) + ")";
            }
            f.Files.Add(file);
          }
          mons.Add(Json.Obj(
            "index", i, "name", m.Device, "primary", m.Primary,
            "x", m.X, "y", m.Y, "w", m.W, "h", m.H,
            "work", Json.Obj("x", m.WX, "y", m.WY, "w", m.WW, "h", m.WH),
            "dpi", m.Dpi, "scale", Math.Round(m.Dpi / 96.0, 4), "dpiSource", m.DpiSource,
            "file", file, "bytes", bytes,
            // RAW PIXELS: the bytes from offset on are an ImageData (RGBA, alpha 255, top-down).
            "pixels", file != null ? Json.Obj("offset", BmpHead, "format", "rgba", "w", r - l, "h", b - tp) : null,
            "frame", Json.Obj("x", l, "y", tp, "w", Math.Max(0, r - l), "h", Math.Max(0, b - tp))));
        }
        writeMs = sw.Elapsed.TotalMilliseconds;

        sw.Restart();
        List<object> wins = ListWindows(exclude, vx, vy, vw, vh);
        double winMs = sw.Elapsed.TotalMilliseconds;

        _cur = f;
        result = Json.Obj("ok", true, "grab", f.Id, "synthetic", synthetic,
          "virt", Json.Obj("x", vx, "y", vy, "w", vw, "h", vh),
          "monitors", mons, "windows", wins, "staleDeleted", stale, "textBox", textBox,
          "ms", Json.Obj("blt", Math.Round(bltMs, 2), "write", Math.Round(writeMs, 2),
                         "windows", Math.Round(winMs, 2), "total", Math.Round(total.Elapsed.TotalMilliseconds, 2)));
        return null;
      }
    }

    /// The test pattern: every pixel's colour is a function of its VIRTUAL-screen position, so a
    /// crop can be checked exactly, pixel for pixel: B = x mod 256, G = y mod 256,
    /// R = (x div 256) * 16 + (y div 256) mod 16 ... folded into 8 bits. The fourth byte is set to
    /// deliberate junk, to prove the frame BMP and the saved PNG both ignore it.
    static void FillSynthetic(Frame f) {
      var row = new byte[f.W * 4];
      for (int y = 0; y < f.H; y++) {
        int vy = f.Y + y;
        for (int x = 0; x < f.W; x++) {
          int vx = f.X + x;
          int o = x * 4;
          row[o] = (byte)(vx & 255);
          row[o + 1] = (byte)(vy & 255);
          row[o + 2] = (byte)((((vx >> 8) & 15) << 4) | ((vy >> 8) & 15));
          row[o + 3] = (byte)((x * 7 + y * 3) & 255);
        }
        Marshal.Copy(row, 0, new IntPtr(f.Bits.ToInt64() + (long)y * f.W * 4), row.Length);
      }
    }

    /// Tests only: tile a picture (under %TEMP%) over the whole frame. null = done, else the reason.
    static string FillFrom(Frame f, string file) {
      try {
        using (var src = new Bitmap(file)) {
          int tw = src.Width, th = src.Height;
          BitmapData bd = src.LockBits(new Rectangle(0, 0, tw, th), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
          try {
            var row = new byte[f.W * 4];
            for (int y = 0; y < f.H; y++) {
              int sy = y % th;
              for (int x0 = 0; x0 < f.W; x0 += tw) {
                int n = Math.Min(tw, f.W - x0);
                Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)sy * bd.Stride), row, x0 * 4, n * 4);
              }
              Marshal.Copy(row, 0, new IntPtr(f.Bits.ToInt64() + (long)y * f.W * 4), row.Length);
            }
          } finally { src.UnlockBits(bd); }
        }
        return null;
      } catch (Exception e) {
        return "the fill picture could not be read (" + e.GetType().Name + ")";
      }
    }

    /// Where a frame BMP's pixels start: 14 (file) + 40 (info) + 12 (the three masks).
    const int BmpHead = 14 + 40 + 12;

    /// A top-down 32-bit BI_BITFIELDS BMP of one rect of the frame. Returns its size in bytes.
    static long WriteBmp(string path, Frame f, int sx, int sy, int w, int h) {
      const int head = BmpHead;
      int rowBytes = w * 4;
      long size = head + (long)rowBytes * h;
      var hdr = new byte[head];
      hdr[0] = 0x42; hdr[1] = 0x4D;                     // "BM"
      PutI32(hdr, 2, (int)size);
      PutI32(hdr, 10, head);
      PutI32(hdr, 14, 40);
      PutI32(hdr, 18, w);
      PutI32(hdr, 22, -h);                              // top-down, like the DIB
      hdr[26] = 1;                                      // planes
      hdr[28] = 32;                                     // bits per pixel
      PutI32(hdr, 30, 3);                               // BI_BITFIELDS: the masks below, no alpha
      PutI32(hdr, 34, rowBytes * h);
      PutI32(hdr, 38, 3780);                            // 96 dpi in pixels per metre
      PutI32(hdr, 42, 3780);
      PutI32(hdr, 54, 0x000000FF);                      // R: the first byte (RGBA order, see RAW PIXELS)
      PutI32(hdr, 58, 0x0000FF00);                      // G
      PutI32(hdr, 62, 0x00FF0000);                      // B
      int stride = f.W * 4;
      int chunkRows = Math.Max(1, (1 << 20) / Math.Max(1, rowBytes));
      var px = new int[chunkRows * w];
      var buf = new byte[chunkRows * rowBytes];
      using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16)) {
        fs.Write(hdr, 0, head);
        long basePtr = f.Bits.ToInt64();
        for (int y0 = 0; y0 < h; y0 += chunkRows) {
          int n = Math.Min(chunkRows, h - y0);
          if (sx == 0 && w == f.W) {
            Marshal.Copy(new IntPtr(basePtr + (long)(sy + y0) * stride), px, 0, n * w);
          } else {
            for (int k = 0; k < n; k++)
              Marshal.Copy(new IntPtr(basePtr + (long)(sy + y0 + k) * stride + (long)sx * 4), px, k * w, w);
          }
          // BGRX (the DIB, little-endian 0xXXRRGGBB) -> RGBA with alpha 255 (0xFFBBGGRR).
          int count = n * w;
          for (int i = 0; i < count; i++) {
            uint v = (uint)px[i];
            px[i] = unchecked((int)(0xFF000000u | (v & 0x0000FF00u) | ((v >> 16) & 0xFFu) | ((v & 0xFFu) << 16)));
          }
          Buffer.BlockCopy(px, 0, buf, 0, n * rowBytes);
          fs.Write(buf, 0, n * rowBytes);
        }
      }
      return size;
    }

    static void PutI32(byte[] b, int at, int v) {
      b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); b[at + 2] = (byte)(v >> 16); b[at + 3] = (byte)(v >> 24);
    }

    /// Top-level windows in z-order (topmost first), for the overlay's Window mode: visible, not
    /// minimised, not cloaked (another virtual desktop, a UWP app that is suspended), not
    /// click-through (WS_EX_TRANSPARENT: an invisible overlay would otherwise "win" every hover),
    /// on the screen, and not one of `exclude` (Mantle's own overlay windows). Rects are DWM's
    /// extended frame bounds - the window as drawn, without the invisible resize border that
    /// GetWindowRect includes on Windows 10 and 11.
    static List<object> ListWindows(HashSet<long> exclude, int vx, int vy, int vw, int vh) {
      var outList = new List<object>();
      var cls = new StringBuilder(64);
      ShotNative.EnumWindows(delegate (IntPtr h, IntPtr lp) {
        if (outList.Count >= MaxWindows) return false;
        if (exclude.Contains(h.ToInt64())) return true;
        if (!ShotNative.IsWindowVisible(h) || ShotNative.IsIconic(h)) return true;
        int exStyle = ShotNative.GetWindowLongW(h, -20);
        if ((exStyle & 0x20) != 0) return true;
        int cloaked;
        if (ShotNative.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
        ShotNative.RECT r;
        if (ShotNative.DwmGetWindowAttribute(h, 9, out r, 16) != 0 && !ShotNative.GetWindowRect(h, out r)) return true;
        if (r.Right <= r.Left || r.Bottom <= r.Top) return true;
        if (r.Right <= vx || r.Bottom <= vy || r.Left >= vx + vw || r.Top >= vy + vh) return true;
        cls.Length = 0;
        ShotNative.GetClassNameW(h, cls, cls.Capacity);
        string c = cls.ToString();
        string kind = (c == "Progman" || c == "WorkerW") ? "desktop" : "window";
        outList.Add(Json.Obj("hwnd", h.ToInt64().ToString(), "kind", kind,
          "x", r.Left, "y", r.Top, "w", r.Right - r.Left, "h", r.Bottom - r.Top));
        return true;
      }, IntPtr.Zero);
      return outList;
    }

    /* ---- shot.save ------------------------------------------------------------------------ */

    /// {grab, x, y, w, h (physical, virtual-screen coords), dir, name} -> {path, name, w, h, bytes, ms}
    /// `name` has no extension; if "<name>.png" exists, "<name> (2).png" and so on, the way
    /// Windows names a second file of the same name, and never overwrites anything.
    static string Save(Dictionary<string, object> req, ref object result) {
      string dir = Json.GetString(req, "dir");
      string name = Json.GetString(req, "name");
      if (string.IsNullOrEmpty(dir) || !Path.IsPathRooted(dir)) return "shot.save: dir must be an absolute folder path";
      if (string.IsNullOrEmpty(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        return "shot.save: name must be a plain file name without a folder";
      if (Program.Passive && CheckTempDir(dir, "x") != null)
        return FeatureTable.PassiveRefusal + ": would have written a screenshot outside %TEMP% (a passive sidecar only writes under %TEMP%)";
      int id = Json.GetInt(req, "grab", 0);
      int x = Json.GetInt(req, "x", 0), y = Json.GetInt(req, "y", 0);
      int w = Json.GetInt(req, "w", 0), h = Json.GetInt(req, "h", 0);
      if (w <= 0 || h <= 0) return "shot.save: w and h must be positive physical pixels";

      var total = Stopwatch.StartNew();
      Bitmap bmp = null;
      double cropMs, encMs, writeMs;
      try {
        var sw = Stopwatch.StartNew();
        lock (_lock) {
          if (_cur == null || _cur.Id != id)
            return "shot.save: capture " + id + " is gone (it was released, or a newer one replaced it)";
          int l = Math.Max(x, _cur.X), t = Math.Max(y, _cur.Y);
          int r = Math.Min(x + w, _cur.X + _cur.W), b = Math.Min(y + h, _cur.Y + _cur.H);
          if (r <= l || b <= t) return "shot.save: the rect " + x + "," + y + " " + w + "x" + h + " is outside the capture";
          x = l; y = t; w = r - l; h = b - t;
          // Format32bppRgb: 32-bit rows (a straight copy of the DIB's) whose fourth byte GDI+
          // ignores, so the PNG comes out opaque RGB whatever BitBlt left there.
          bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
          BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
          try {
            int stride = _cur.W * 4;
            var row = new byte[w * 4];
            long src = _cur.Bits.ToInt64() + (long)(y - _cur.Y) * stride + (long)(x - _cur.X) * 4;
            long dst = bd.Scan0.ToInt64();
            for (int k = 0; k < h; k++) {
              Marshal.Copy(new IntPtr(src + (long)k * stride), row, 0, row.Length);
              Marshal.Copy(row, 0, new IntPtr(dst + (long)k * bd.Stride), row.Length);
            }
          } finally {
            bmp.UnlockBits(bd);
          }
        }
        cropMs = sw.Elapsed.TotalMilliseconds;

        sw.Restart();
        byte[] png;
        using (var ms = new MemoryStream()) {
          bmp.Save(ms, ImageFormat.Png);
          png = ms.ToArray();
        }
        encMs = sw.Elapsed.TotalMilliseconds;

        sw.Restart();
        try { Directory.CreateDirectory(dir); }
        catch (Exception e) { return "shot.save: the folder could not be made (" + Reason(e) + ")"; }
        string path = null, used = null;
        for (int n = 1; n <= 999 && path == null; n++) {
          string cand = n == 1 ? name : name + " (" + n + ")";
          string p = Path.Combine(dir, cand + ".png");
          if (File.Exists(p)) continue;
          try {
            using (var fs = new FileStream(p, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              fs.Write(png, 0, png.Length);
            }
            path = p; used = cand;
          } catch (IOException) {
            if (!File.Exists(p)) throw;            // not a name clash: a real write failure
          }
        }
        if (path == null) return "shot.save: 999 screenshots with this name already exist in that folder";
        writeMs = sw.Elapsed.TotalMilliseconds;

        result = Json.Obj("ok", true, "path", path, "name", used + ".png", "w", w, "h", h,
          "x", x, "y", y, "bytes", png.Length,
          "ms", Json.Obj("crop", Math.Round(cropMs, 2), "encode", Math.Round(encMs, 2),
                         "write", Math.Round(writeMs, 2), "total", Math.Round(total.Elapsed.TotalMilliseconds, 2)));
        return null;
      } catch (Exception e) {
        return "shot.save: the screenshot could not be saved (" + Reason(e) + ")";
      } finally {
        if (bmp != null) bmp.Dispose();
      }
    }

    /* ---- shot.copy ------------------------------------------------------------------------ */

    /// {grab, x, y, w, h (physical, virtual-screen coords), dryRun?, dump?}
    ///   -> {format:"CF_DIB", w, h, x, y, bytes, dryRun, dumped?, ms:{crop, clipboard, total}}
    ///
    /// WHY (lane shotspeed, 2026-09-27). The copy used to wait for the PNG encode (80-260 ms),
    /// then main decoded that PNG and re-encoded it to hand `clipboard.write` an image/png Blob:
    /// "copied" came 863 ms (p50) after the selection, and a paste inside that second got the OLD
    /// clipboard. Now the clipboard gets a CF_DIB cut straight from the frozen frame (no encode at
    /// all: a row copy), BEFORE shot.save encodes the file. CF_DIB is the format PrintScreen's own
    /// bitmap reaches every app as: Paint, Discord and browsers read it (Chromium turns it into
    /// image/png itself). 32 bpp BI_RGB, bottom-up, the fourth byte set to 255: BitBlt leaves it
    /// undefined, and Chromium reads a 32-bit DIB as premultiplied alpha, so 0 in a black area
    /// would paste as transparent while 255 is opaque everywhere.
    ///
    /// `dryRun` builds the very same memory block and frees it instead of handing it to Windows
    /// (a test's copy, never Owen's clipboard); `dump` (a folder under %TEMP%, dryRun only) also
    /// writes it as "<dump>\clip-<grab>.bmp" so a test can check it pixel for pixel. A passive
    /// sidecar refuses a real copy.
    static string Copy(Dictionary<string, object> req, ref object result) {
      int id = Json.GetInt(req, "grab", 0);
      int x = Json.GetInt(req, "x", 0), y = Json.GetInt(req, "y", 0);
      int w = Json.GetInt(req, "w", 0), h = Json.GetInt(req, "h", 0);
      bool dry = Json.GetBool(req, "dryRun", false);
      string dump = dry ? Json.GetString(req, "dump") : null;
      if (w <= 0 || h <= 0) return "shot.copy: w and h must be positive physical pixels";
      if (!dry && Program.Passive) return FeatureTable.PassiveRefusal + ": would have put a screenshot on the clipboard";
      if (!string.IsNullOrEmpty(dump)) { string derr = CheckTempDir(dump, "shot.copy: a dump"); if (derr != null) return derr; }

      var total = Stopwatch.StartNew();
      IntPtr hMem = IntPtr.Zero;
      long bytes;
      double cropMs = 0, clipMs = 0;
      string dumped = null;
      try {
        lock (_lock) {
          if (_cur == null || _cur.Id != id)
            return "shot.copy: capture " + id + " is gone (it was released, or a newer one replaced it)";
          int l = Math.Max(x, _cur.X), t = Math.Max(y, _cur.Y);
          int r = Math.Min(x + w, _cur.X + _cur.W), b = Math.Min(y + h, _cur.Y + _cur.H);
          if (r <= l || b <= t) return "shot.copy: the rect " + x + "," + y + " " + w + "x" + h + " is outside the capture";
          x = l; y = t; w = r - l; h = b - t;
          int stride = w * 4;
          bytes = 40 + (long)stride * h;
          hMem = ShotNative.GlobalAlloc(0x0002 /* GMEM_MOVEABLE */, new UIntPtr((ulong)bytes));
          if (hMem == IntPtr.Zero) return "shot.copy: no memory for a " + w + "x" + h + " picture (" + (bytes >> 20) + " MB)";
          IntPtr p = ShotNative.GlobalLock(hMem);
          if (p == IntPtr.Zero) return "shot.copy: the picture's memory could not be locked";
          try {
            // BITMAPINFOHEADER: 40 bytes, positive height = bottom-up rows, 32 bpp, BI_RGB.
            var hdr = new byte[40];
            PutI32(hdr, 0, 40); PutI32(hdr, 4, w); PutI32(hdr, 8, h);
            hdr[12] = 1; hdr[14] = 32;
            PutI32(hdr, 20, stride * h);
            Marshal.Copy(hdr, 0, p, 40);
            var row = new byte[stride];
            long src = _cur.Bits.ToInt64() + (long)(y - _cur.Y) * _cur.W * 4 + (long)(x - _cur.X) * 4;
            long dst = p.ToInt64() + 40;
            for (int k = 0; k < h; k++) {
              Marshal.Copy(new IntPtr(src + (long)k * _cur.W * 4), row, 0, stride);
              for (int i = 3; i < stride; i += 4) row[i] = 255;
              Marshal.Copy(row, 0, new IntPtr(dst + (long)(h - 1 - k) * stride), stride);
            }
            cropMs = total.Elapsed.TotalMilliseconds;
            if (!string.IsNullOrEmpty(dump)) {
              Directory.CreateDirectory(dump);
              dumped = Path.Combine(dump, "clip-" + id + ".bmp");
              var fh = new byte[14];
              fh[0] = (byte)'B'; fh[1] = (byte)'M';
              PutI32(fh, 2, (int)(14 + bytes)); PutI32(fh, 10, 14 + 40);
              var all = new byte[bytes];
              Marshal.Copy(p, all, 0, (int)bytes);
              using (var fs = new FileStream(dumped, FileMode.Create, FileAccess.Write, FileShare.None)) {
                fs.Write(fh, 0, fh.Length);
                fs.Write(all, 0, all.Length);
              }
            }
          } finally {
            ShotNative.GlobalUnlock(hMem);
          }
        }

        if (!dry) {
          var sw = Stopwatch.StartNew();
          bool keep;
          string werr = ClipOwner.SetDib(hMem, out keep);
          clipMs = sw.Elapsed.TotalMilliseconds;
          if (keep) hMem = IntPtr.Zero;             // Windows owns it now (or the late work frees it)
          if (werr != null) return "shot.copy: " + werr;
        }
        result = Json.Obj("ok", true, "format", "CF_DIB", "w", w, "h", h, "x", x, "y", y, "bytes", bytes,
          "dryRun", dry, "dumped", dumped,
          "ms", Json.Obj("crop", Math.Round(cropMs, 2), "clipboard", Math.Round(clipMs, 2),
                         "total", Math.Round(total.Elapsed.TotalMilliseconds, 2)));
        return null;
      } catch (Exception e) {
        return "shot.copy: the screenshot could not be copied (" + Reason(e) + ")";
      } finally {
        if (hMem != IntPtr.Zero) ShotNative.GlobalFree(hMem);
      }
    }

    /// The clipboard's owner window must belong to a thread that PUMPS messages (Windows sends the
    /// owner WM_DESTROYCLIPBOARD when another app empties the clipboard; a thread parked on the
    /// capture lane's queue would hang that app). So: one message-only window on its own STA
    /// thread, made at the first copy and kept, the way ClipHistory.cs's listener does it.
    static class ClipOwner {
      const int WM_WORK = 0x8000 + 0x52;            // WM_APP + 0x52
      static readonly object _lk = new object();
      static readonly object _start = new object();
      static readonly Queue<Action> _work = new Queue<Action>();
      static Win _win;

      sealed class Win : System.Windows.Forms.NativeWindow {
        public Win() {
          var cp = new System.Windows.Forms.CreateParams();
          cp.Caption = "Mantle screenshot clipboard";
          cp.Parent = new IntPtr(-3);                 // HWND_MESSAGE: never shown, never in any z-order
          CreateHandle(cp);
        }
        protected override void WndProc(ref System.Windows.Forms.Message m) {
          if (m.Msg == WM_WORK) { Drain(); return; }
          base.WndProc(ref m);
        }
      }

      static void Drain() {
        while (true) {
          Action a;
          lock (_lk) { if (_work.Count == 0) return; a = _work.Dequeue(); }
          try { a(); } catch (Exception) { }
        }
      }

      static string Ensure() {
        lock (_start) {
          lock (_lk) if (_win != null) return null;
          string err = null;
          var ready = new ManualResetEvent(false);
          var t = new Thread(delegate () {
            try {
              var w = new Win();
              lock (_lk) _win = w;
            } catch (Exception e) { err = "its window could not be made (" + e.Message + ")"; ready.Set(); return; }
            ready.Set();
            System.Windows.Forms.Application.Run();
          });
          t.IsBackground = true;
          t.Name = "shot-clipboard";
          t.SetApartmentState(ApartmentState.STA);
          t.Start();
          if (!ready.WaitOne(3000)) return "the clipboard thread did not start within 3 s";
          return err;
        }
      }

      /// Empty the clipboard and give it `hDib` as CF_DIB. null = done. `keep` true = the caller
      /// must NOT free hDib: Windows owns it, or (a timeout after the work began) it may yet.
      public static string SetDib(IntPtr hDib, out bool keep) {
        keep = false;
        string e0 = Ensure();
        if (e0 != null) return "the clipboard could not be reached: " + e0;
        string r = null;
        bool started = false, cancelled = false, taken = false;
        var done = new ManualResetEvent(false);
        IntPtr hwnd;
        lock (_lk) {
          _work.Enqueue(delegate () {
            lock (_lk) { if (cancelled) return; started = true; }
            try {
              IntPtr me = _win.Handle;
              bool open = false;
              for (int i = 0; i < 6 && !open; i++) { open = ShotNative.OpenClipboard(me); if (!open) Thread.Sleep(25); }
              if (!open) { r = "another app is holding the clipboard"; return; }
              try {
                if (!ShotNative.EmptyClipboard()) { r = "Windows would not empty the clipboard (error " + Marshal.GetLastWin32Error() + ")"; return; }
                if (ShotNative.SetClipboardData(8 /* CF_DIB */, hDib) == IntPtr.Zero)
                  r = "Windows refused the picture (error " + Marshal.GetLastWin32Error() + ")";
                else taken = true;
              } finally { ShotNative.CloseClipboard(); }
            } catch (Exception ex) { r = ex.GetType().Name + ": " + ex.Message; }
            finally {
              bool late;
              lock (_lk) late = cancelled;
              if (late && !taken) ShotNative.GlobalFree(hDib);   // the caller gave up on it: ours to free
              done.Set();
            }
          });
          hwnd = _win.Handle;
        }
        ShotNative.PostMessageW(hwnd, WM_WORK, IntPtr.Zero, IntPtr.Zero);
        if (!done.WaitOne(3000)) {
          lock (_lk) {
            if (done.WaitOne(0)) { keep = taken; return r; }   // it finished just now after all
            cancelled = true;
            keep = started;                  // begun: it frees hDib itself unless Windows took it
          }
          return "the clipboard did not answer within 3 s";
        }
        keep = taken;
        return r;
      }
    }

    /* ---- shot.ocr (the overlay's "Copy text" mode, Ocr.cs) --------------------------------- */

    /// {grab, x, y, w, h (physical, virtual-screen coords)} -> {lines:[{text,x,y,w,h}], lang, scale,
    /// angle, x, y, w, h, ms:{crop, scale, ocr, total}}. The crop comes from the SAME frozen frame
    /// as shot.save, in memory: no file, and nothing here logs the pixels or the text.
    static string OcrCmd(Dictionary<string, object> req, ref object result) {
      int id = Json.GetInt(req, "grab", 0);
      int x = Json.GetInt(req, "x", 0), y = Json.GetInt(req, "y", 0);
      int w = Json.GetInt(req, "w", 0), h = Json.GetInt(req, "h", 0);
      if (w <= 0 || h <= 0) return "shot.ocr: w and h must be positive physical pixels";
      var total = Stopwatch.StartNew();
      byte[] px;
      lock (_lock) {
        if (_cur == null || _cur.Id != id)
          return "shot.ocr: capture " + id + " is gone (it was released, or a newer one replaced it)";
        int l = Math.Max(x, _cur.X), t = Math.Max(y, _cur.Y);
        int r = Math.Min(x + w, _cur.X + _cur.W), b = Math.Min(y + h, _cur.Y + _cur.H);
        if (r <= l || b <= t) return "shot.ocr: the rect " + x + "," + y + " " + w + "x" + h + " is outside the capture";
        x = l; y = t; w = r - l; h = b - t;
        px = new byte[(long)w * h * 4];
        int stride = _cur.W * 4;
        long src = _cur.Bits.ToInt64() + (long)(y - _cur.Y) * stride + (long)(x - _cur.X) * 4;
        for (int k = 0; k < h; k++) Marshal.Copy(new IntPtr(src + (long)k * stride), px, k * w * 4, w * 4);
      }
      double cropMs = total.Elapsed.TotalMilliseconds;
      IDictionary rec;
      string err = Ocr.Recognize(px, w, h, Json.GetInt(req, "scale", 0), out rec);
      Array.Clear(px, 0, px.Length);
      if (err != null) return "shot.ocr: " + err;
      rec["x"] = x; rec["y"] = y; rec["w"] = w; rec["h"] = h;
      var ms = (IDictionary)rec["ms"];
      ms["crop"] = Math.Round(cropMs, 2);
      ms["total"] = Math.Round(total.Elapsed.TotalMilliseconds, 2);
      result = rec;
      return null;
    }

    /// --test only (synthetic grabs): known text drawn black on white over the pattern, at `at`
    /// {x, y} physical px from the PRIMARY monitor's top-left, `px` high (the font's em size),
    /// one entry of `lines` per line, on a white box `textPad` px bigger all round (default: one em).
    /// Returns the white box it drew, in virtual-screen px.
    static IDictionary DrawSyntheticText(Frame f, List<object> lines, Dictionary<string, object> at, int emPx, int padPx) {
      int ox = 0, oy = 0;
      foreach (ShotNative.MonitorRow m in ShotNative.Monitors()) if (m.Primary) { ox = m.X; oy = m.Y; }
      ox += at != null ? Json.GetInt(at, "x", 60) : 60;
      oy += at != null ? Json.GetInt(at, "y", 60) : 60;
      if (emPx < 6) emPx = 6;
      if (emPx > 200) emPx = 200;
      using (var bmp = new Bitmap(f.W, f.H, f.W * 4, PixelFormat.Format32bppRgb, f.Bits))
      using (var g = Graphics.FromImage(bmp))
      using (var font = new Font("Segoe UI", emPx, FontStyle.Regular, GraphicsUnit.Pixel)) {
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        float lh = font.GetHeight(g);
        float bw = 0;
        foreach (object o in lines) bw = Math.Max(bw, g.MeasureString(o as string ?? "", font).Width);
        int pad = padPx >= 0 ? Math.Min(padPx, 2000) : Math.Max(8, emPx);
        var box = new Rectangle(ox - f.X - pad, oy - f.Y - pad, (int)Math.Ceiling(bw) + 2 * pad, (int)Math.Ceiling(lh * lines.Count) + 2 * pad);
        g.FillRectangle(Brushes.White, box);
        for (int i = 0; i < lines.Count; i++)
          g.DrawString(lines[i] as string ?? "", font, Brushes.Black, ox - f.X, oy - f.Y + i * lh);
        g.Flush();
        return Json.Obj("x", box.X + f.X, "y", box.Y + f.Y, "w", box.Width, "h", box.Height, "lineH", Math.Round(lh, 2));
      }
    }

    /* ---- shot.release / shot.folder -------------------------------------------------------- */

    /// Frees the frame and deletes its files. Always safe; `id` (optional) only releases if it is
    /// still the current one (`grab`, not `id`: `id` is the request id), so a late release can never throw away a newer capture.
    static string Release(Dictionary<string, object> req, ref object result) {
      int id = Json.GetInt(req, "grab", 0);
      lock (_lock) {
        bool had = _cur != null && (id == 0 || _cur.Id == id);
        int files = had ? _cur.Files.Count : 0;
        if (had) FreeLocked();
        result = Json.Obj("ok", true, "released", had, "filesDeleted", files);
      }
      return null;
    }

    /// Where Windows saves screenshots: the Screenshots KNOWN FOLDER (it follows a OneDrive or
    /// user move of Pictures), else Pictures\Screenshots with the reason. Read-only.
    static string Folder(Dictionary<string, object> req, ref object result) {
      string why = null;
      try {
        IntPtr p;
        Guid g = new Guid("b7bede81-df94-4682-a7d8-57a52620b86f");  // FOLDERID_Screenshots
        int hr = ShotNative.SHGetKnownFolderPath(ref g, 0, IntPtr.Zero, out p);
        if (hr == 0 && p != IntPtr.Zero) {
          string s = Marshal.PtrToStringUni(p);
          Marshal.FreeCoTaskMem(p);
          if (!string.IsNullOrEmpty(s)) { result = Json.Obj("ok", true, "path", s, "source", "known folder"); return null; }
          why = "the Screenshots known folder is empty";
        } else {
          why = "the Screenshots known folder is not set up (HRESULT 0x" + hr.ToString("X8") + ")";
        }
      } catch (Exception e) {
        why = "the Screenshots known folder could not be read (" + Reason(e) + ")";
      }
      string pics = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
      if (string.IsNullOrEmpty(pics)) return "shot.folder: neither the Screenshots folder nor Pictures could be found (" + why + ")";
      result = Json.Obj("ok", true, "path", Path.Combine(pics, "Screenshots"), "source", "Pictures\\Screenshots", "reason", why);
      return null;
    }

    /* ---- shot.owner --------------------------------------------------------------------------- */

    /// {windows:[hwnd,...]} -> {owners:[{window, exists, pid, exe, cls, why?}]}: the process behind
    /// each window measured in front of the overlay. `exe` is the file name only (ScreenClippingHost.exe,
    /// StartMenuExperienceHost.exe, ...), `cls` the window class; never a title. Read-only, so it runs
    /// in passive too. At most 16 windows (screenshot.js asks for one or two).
    static string Owner(Dictionary<string, object> req, ref object result) {
      object w;
      if (!Json.TryGet(req, "windows", out w) || !(w is List<object>)) return "shot.owner: windows must be a list of window handles";
      var list = (List<object>)w;
      if (list.Count > 16) return "shot.owner: at most 16 windows at a time (got " + list.Count + ")";
      var rows = new List<object>();
      foreach (object o in list) {
        long n = 0;
        if (o is double) n = (long)(double)o;
        else if (o is string) long.TryParse((string)o, out n);
        IntPtr h = new IntPtr(n);
        if (n == 0 || !Win32.IsWindow(h)) { rows.Add(Json.Obj("window", n.ToString(), "exists", false)); continue; }
        int pid;
        Win32.GetWindowThreadProcessId(h, out pid);
        string p = Win32.GetProcessPath(pid);
        string cls = Win32.GetClassName(h) ?? "";
        if (string.IsNullOrEmpty(p)) {
          rows.Add(Json.Obj("window", n.ToString(), "exists", true, "pid", pid, "exe", "", "cls", cls,
                            "why", "its process (pid " + pid + ") could not be opened to read its name"));
        } else {
          rows.Add(Json.Obj("window", n.ToString(), "exists", true, "pid", pid, "exe", Path.GetFileName(p), "cls", cls));
        }
      }
      result = Json.Obj("ok", true, "owners", rows);
      return null;
    }

    /* ---- helpers ------------------------------------------------------------------------- */

    /// null when `dir` is an absolute folder under %TEMP%; else the reason.
    static string CheckTempDir(string dir, string what) {
      if (string.IsNullOrEmpty(dir)) return what + " need a dir (an absolute folder under %TEMP%)";
      try {
        if (!Path.IsPathRooted(dir)) return what + " need an absolute dir";
        string full = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        string tmp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\";
        if (!full.StartsWith(tmp, StringComparison.OrdinalIgnoreCase))
          return what + " may only go under %TEMP% (they are pictures of the screen)";
        return null;
      } catch (Exception e) {
        return what + ": the dir is not a usable path (" + Reason(e) + ")";
      }
    }

    /// An exception's reason for a reply, WITHOUT the path .NET puts in it ("Access to the path
    /// 'C:\...' is denied."): a reply's words reach mantle.log, and no log line may name a folder or
    /// a file (lane capture-shot, 2026-09-29: a save into a locked folder logged its full path). The
    /// type name stays first for the log; the page gets plain words (screenshot.js plainError).
    static string Reason(Exception e) {
      string m = (e.Message ?? "").Trim();
      m = System.Text.RegularExpressions.Regex.Replace(m, "\\s*'[^'\\r\\n]*[\\\\/][^'\\r\\n]*'", "");
      m = System.Text.RegularExpressions.Regex.Replace(m, "\\s*\"[^\"\\r\\n]*[\\\\/][^\"\\r\\n]*\"", "");
      m = System.Text.RegularExpressions.Regex.Replace(m, "\\s*[A-Za-z]:\\\\\\S*", "");
      int nl = m.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) m = m.Substring(0, nl).Trim();
      return e.GetType().Name + (m.Length > 0 ? ": " + m : "");
    }

    static int DeleteStaleFrames(string dir) {
      int n = 0;
      try {
        foreach (string p in Directory.GetFiles(dir, FramePrefix + "*.bmp")) {
          try { File.Delete(p); n++; } catch (Exception) { }
        }
      } catch (Exception) { }
      return n;
    }

    static void FreeLocked() {
      if (_cur == null) return;
      FreeFrame(_cur);
      _cur = null;
    }

    static void FreeFrame(Frame f) {
      foreach (string p in f.Files) { try { File.Delete(p); } catch (Exception) { } }
      f.Files.Clear();
      if (f.Bmp != IntPtr.Zero) { try { ShotNative.DeleteObject(f.Bmp); } catch (Exception) { } }
      f.Bmp = IntPtr.Zero;
      f.Bits = IntPtr.Zero;
    }
  }

  /// This feature's own P/Invoke (Win32.cs is shared by every lane).
  static class ShotNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // shot.copy: the clipboard, and the global memory block it takes.
    [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalFree(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER {
      public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
      public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
      public uint biClrUsed; public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
      public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
    public delegate bool MonitorEnumProc(IntPtr mon, IntPtr hdc, ref RECT r, IntPtr lp);

    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool GdiFlush();
    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT v, int size);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFOEX mi);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dx, out uint dy);
    [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

    public sealed class MonitorRow {
      public string Device; public bool Primary;
      public int X, Y, W, H, WX, WY, WW, WH;
      public int Dpi; public string DpiSource;
    }

    /// Every monitor with its physical rect, work area and EFFECTIVE dpi (the scale Settings
    /// shows: 96 = 100%, 144 = 150%). GetDpiForMonitor is in shcore (Windows 8.1+); if it is
    /// refused the monitor is reported at 96 with the reason, never silently.
    public static List<MonitorRow> Monitors() {
      var list = new List<MonitorRow>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr mon, IntPtr hdc, ref RECT rr, IntPtr lp) {
        var mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfoW(mon, ref mi)) return true;
        var row = new MonitorRow();
        row.Device = mi.szDevice ?? "";
        row.Primary = (mi.dwFlags & 1) != 0;
        row.X = mi.rcMonitor.Left; row.Y = mi.rcMonitor.Top;
        row.W = mi.rcMonitor.Right - mi.rcMonitor.Left; row.H = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
        row.WX = mi.rcWork.Left; row.WY = mi.rcWork.Top;
        row.WW = mi.rcWork.Right - mi.rcWork.Left; row.WH = mi.rcWork.Bottom - mi.rcWork.Top;
        row.Dpi = 96; row.DpiSource = "GetDpiForMonitor";
        try {
          uint dx, dy;
          int hr = GetDpiForMonitor(mon, 0, out dx, out dy);
          if (hr == 0 && dx > 0) row.Dpi = (int)dx;
          else row.DpiSource = "GetDpiForMonitor failed (HRESULT 0x" + hr.ToString("X8") + "), assumed 96";
        } catch (Exception e) {
          row.DpiSource = "GetDpiForMonitor unavailable (" + e.GetType().Name + "), assumed 96";
        }
        list.Add(row);
        return true;
      }, IntPtr.Zero);
      return list;
    }
  }
}
