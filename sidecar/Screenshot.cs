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
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class Screenshot {
    public static void Register(FeatureTable t) {
      t.Add("shot.grab", Lanes.Capture, Grab);
      t.Add("shot.save", Lanes.Capture, Save);
      t.Add("shot.release", Lanes.Capture, Release);
      t.Add("shot.folder", Lanes.Slow, Folder);
      t.Add("shot.ocr", Lanes.Capture, OcrCmd);     // "Copy text": Ocr.cs reads the same frozen frame
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
        catch (Exception e) { return "shot.grab: the frame folder could not be made (" + e.Message + ")"; }
        int stale = DeleteStaleFrames(dir);

        int vx = ShotNative.GetSystemMetrics(76), vy = ShotNative.GetSystemMetrics(77);
        int vw = ShotNative.GetSystemMetrics(78), vh = ShotNative.GetSystemMetrics(79);
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
              return "shot.grab: the frame for monitor " + (i + 1) + " could not be written (" + e2.Message + ")";
            }
            f.Files.Add(file);
          }
          mons.Add(Json.Obj(
            "index", i, "name", m.Device, "primary", m.Primary,
            "x", m.X, "y", m.Y, "w", m.W, "h", m.H,
            "work", Json.Obj("x", m.WX, "y", m.WY, "w", m.WW, "h", m.WH),
            "dpi", m.Dpi, "scale", Math.Round(m.Dpi / 96.0, 4), "dpiSource", m.DpiSource,
            "file", file, "bytes", bytes,
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

    /// A top-down 32-bit BI_BITFIELDS BMP of one rect of the frame. Returns its size in bytes.
    static long WriteBmp(string path, Frame f, int sx, int sy, int w, int h) {
      const int head = 14 + 40 + 12;
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
      PutI32(hdr, 54, 0x00FF0000);
      PutI32(hdr, 58, 0x0000FF00);
      PutI32(hdr, 62, 0x000000FF);
      int stride = f.W * 4;
      int chunkRows = Math.Max(1, (1 << 20) / Math.Max(1, rowBytes));
      var buf = new byte[chunkRows * rowBytes];
      using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16)) {
        fs.Write(hdr, 0, head);
        long basePtr = f.Bits.ToInt64();
        for (int y0 = 0; y0 < h; y0 += chunkRows) {
          int n = Math.Min(chunkRows, h - y0);
          if (sx == 0 && w == f.W) {
            Marshal.Copy(new IntPtr(basePtr + (long)(sy + y0) * stride), buf, 0, n * rowBytes);
          } else {
            for (int k = 0; k < n; k++)
              Marshal.Copy(new IntPtr(basePtr + (long)(sy + y0 + k) * stride + (long)sx * 4), buf, k * rowBytes, rowBytes);
          }
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
        return FeatureTable.PassiveRefusal + ": would have written a screenshot to " + dir + " (a passive sidecar only writes under %TEMP%)";
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
        catch (Exception e) { return "shot.save: the folder " + dir + " could not be made (" + e.Message + ")"; }
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
        if (path == null) return "shot.save: 999 files named \"" + name + "\" already exist in " + dir;
        writeMs = sw.Elapsed.TotalMilliseconds;

        result = Json.Obj("ok", true, "path", path, "name", used + ".png", "w", w, "h", h,
          "x", x, "y", y, "bytes", png.Length,
          "ms", Json.Obj("crop", Math.Round(cropMs, 2), "encode", Math.Round(encMs, 2),
                         "write", Math.Round(writeMs, 2), "total", Math.Round(total.Elapsed.TotalMilliseconds, 2)));
        return null;
      } catch (Exception e) {
        return "shot.save: the screenshot could not be saved (" + e.GetType().Name + ": " + e.Message + ")";
      } finally {
        if (bmp != null) bmp.Dispose();
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
        why = "the Screenshots known folder could not be read (" + e.Message + ")";
      }
      string pics = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
      if (string.IsNullOrEmpty(pics)) return "shot.folder: neither the Screenshots folder nor Pictures could be found (" + why + ")";
      result = Json.Obj("ok", true, "path", Path.Combine(pics, "Screenshots"), "source", "Pictures\\Screenshots", "reason", why);
      return null;
    }

    /* ---- helpers ------------------------------------------------------------------------- */

    /// null when `dir` is an absolute folder under %TEMP%; else the reason.
    static string CheckTempDir(string dir, string what) {
      if (string.IsNullOrEmpty(dir)) return what + " need a dir (an absolute folder under %TEMP%)";
      try {
        if (!Path.IsPathRooted(dir)) return what + " need an absolute dir, not \"" + dir + "\"";
        string full = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        string tmp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\";
        if (!full.StartsWith(tmp, StringComparison.OrdinalIgnoreCase))
          return what + " may only go under " + tmp + " (they are pictures of the screen), not " + dir;
        return null;
      } catch (Exception e) {
        return what + ": the dir " + dir + " is not a usable path (" + e.Message + ")";
      }
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
