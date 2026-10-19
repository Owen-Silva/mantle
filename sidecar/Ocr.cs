// Ocr.cs - Windows' own OCR (Windows.Media.Ocr) for the screenshot overlay's "Copy text" mode
// (ocr lane, 2026-09-27).
//
// WHAT IT IS FOR. Owen drags over a paused video, a slide, an image or a PDF that will not
// select, and gets the TEXT on his clipboard. The pixels are the SAME frozen frame `shot.grab`
// took (Screenshot.cs keeps it in memory until `shot.release`): `shot.ocr` crops the selection out
// of it and hands the crop to Recognize() here, in memory. No second capture, no file.
//
// THE ENGINE, and why it is this one (measured on Owen's machine, 2026-09-27):
//   * Windows.Media.Ocr is Windows' own recogniser: local, offline, no cloud, no keys. It ships
//     with the OS; its languages are the installed language packs' OCR components (en-US here).
//   * In process, through the SPLIT winmds in System32\WinMetadata (build.ps1's MANTLE_WINMD
//     route, the one Media.cs found): OcrEngine is in Windows.Media.winmd, SoftwareBitmap in
//     Windows.Graphics.winmd, Language in Windows.Globalization.winmd. No SDK, nothing to install.
//     The IAsyncOperation is awaited with WinRt.Await (Media.cs), not AsTask (which would drag in
//     the SDK-only union Windows.winmd).
//   * The alternative was powershell.exe loading the same WinRT types; it needs a file on disk
//     (a StorageFile to decode) and a process start per recognition - see lib/features/screenshot.js's
//     header for the numbers that decided it.
//
// SMALL TEXT. Screen text is small (13-16 px at 100%) and the engine reads it much better at 2x,
// so every crop is resampled to 2x (high-quality bicubic) before recognition, unless 2x would pass
// the engine's MaxImageDimension (10000 here). MEASURED 2026-09-27 on 3 lines of Segoe UI drawn
// into a synthetic frame (sidecar/test-ocr.js's text), character accuracy at 1x / 2x / 3x:
//   10 px: 37.5 / 92.4 / 91.7 %    11 px: 97.9 / 100 / 100 %    12 px: 97.9 / 98.6 / 100 %
//   13 px: 97.2 / 100 / 100 %      14 px: 97.9 / 100 / 97.2 %   16-48 px: 100 % at every scale
// and 2x cost 9-24 ms for those crops (68 ms for a 1158x288 one). 3x bought nothing. The scale
// used is in every reply.
//
// PRIVACY. The crop and the text never touch disk and nothing here logs them: the text only goes
// back to main in the reply, and every error string is about the engine, never the content.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
#if MANTLE_WINMD
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;
#endif

namespace Mantle {
  [MantleFeature]
  static class Ocr {
    public static void Register(FeatureTable t) {
      t.Add("ocr.status", Lanes.Slow, Status);
    }

    /// Crops smaller than this (either side, physical px) cannot hold a line of text.
    public const int MinSide = 8;
    /// Every crop is recognised at this scale (SMALL TEXT above), unless that passes MaxImageDimension.
    const int Upscale = 2;

    static readonly object _lock = new object();
#if MANTLE_WINMD
    static OcrEngine _engine;
    static string _engineWhy;     // why there is no engine, once known
    static int _engineWhyAt;      // Environment.TickCount when it was last tried (Engine: retried after EngineRetryMs)
    static double _engineMs = -1;
#endif
    /// A missing engine is asked again after this long (screenshot.js asks ocr.status every 30 s while unavailable).
    public const int EngineRetryMs = 30000;

    /// {} -> {ok, available, lang, langs[], maxDim, via, why?, engineMs}
    /// `available:false` is an answer, not an error: `why` says what is missing, in plain words.
    static string Status(Dictionary<string, object> req, ref object result) {
#if MANTLE_WINMD
      var langs = new List<object>();
      string why = null, lang = null;
      uint maxDim = 0;
      try {
        foreach (var l in OcrEngine.AvailableRecognizerLanguages) langs.Add(l.LanguageTag);
        maxDim = OcrEngine.MaxImageDimension;
      } catch (Exception ex) {
        why = "Windows' OCR could not be asked for its languages (" + Why(ex) + ")";
      }
      if (why == null) {
        OcrEngine e = Engine(out why);
        if (e != null) { try { lang = e.RecognizerLanguage.LanguageTag; } catch (Exception) { } }
      }
      result = Json.Obj("ok", true, "available", why == null, "lang", lang, "langs", langs,
        "maxDim", (long)maxDim, "via", "winrt", "why", why, "engineMs", Math.Round(_engineMs, 2),
        "retryMs", EngineRetryMs);
      return null;
#else
      result = Json.Obj("ok", true, "available", false, "lang", null, "langs", new List<object>(),
        "via", "none", "why", Unavailable);
      return null;
#endif
    }

#if !MANTLE_WINMD
    const string Unavailable = "this sidecar was built without WinRT (build.ps1 found no " +
      "System32\\WinMetadata winmds), so Windows' OCR cannot be reached";
#endif

#if MANTLE_WINMD
    /// The engine for the user's profile languages, made once. Null with `why` when there is none.
    /// NO ENGINE IS NOT FOREVER (lane capture-shot, 2026-09-29): the reason used to be kept for the
    /// sidecar's whole life, so a language added in Windows Settings (or one failed first try on a
    /// busy start-up) left Copy text off until Mantle restarted. It is kept EngineRetryMs, then asked again.
    static OcrEngine Engine(out string why) {
      lock (_lock) {
        why = _engineWhy;
        if (_engine != null) return _engine;
        if (_engineWhy != null && unchecked(Environment.TickCount - _engineWhyAt) < EngineRetryMs) return null;
        _engineWhy = null;
        var sw = Stopwatch.StartNew();
        try {
          _engine = OcrEngine.TryCreateFromUserProfileLanguages();
          if (_engine == null) {
            // No profile language has OCR: fall back to ANY installed recogniser, and say none is
            // installed if there is none (Settings > Time & language > Language > Optional features).
            foreach (var l in OcrEngine.AvailableRecognizerLanguages) {
              _engine = OcrEngine.TryCreateFromLanguage(l);
              if (_engine != null) break;
            }
          }
          if (_engine == null)
            _engineWhy = "no OCR language is installed (Windows Settings > Time & language > Language & region: " +
                         "add a language with its optical character recognition feature)";
        } catch (Exception ex) {
          _engineWhy = "Windows' OCR engine could not be created (" + Why(ex) + ")";
        }
        _engineMs = sw.Elapsed.TotalMilliseconds;
        _engineWhyAt = Environment.TickCount;
        why = _engineWhy;
        return _engine;
      }
    }
#endif

    /// Recognises the text in a top-down 32-bit BGRX crop (`bgra`, stride = w * 4; the fourth
    /// byte is ignored). On success `result` is {lines:[{text, x, y, w, h}], lang, scale, angle,
    /// ms:{scale, ocr}} with line boxes in CROP pixels (before the scale-up). Returns an error or null.
    public static string Recognize(byte[] bgra, int w, int h, int forceScale, out IDictionary result) {
      result = null;
      if (w < MinSide || h < MinSide) return "the selection is too small to hold text (" + w + "x" + h + " px)";
#if MANTLE_WINMD
      string why;
      OcrEngine engine = Engine(out why);
      if (engine == null) return why;
      var sw = Stopwatch.StartNew();
      int scale = forceScale >= 1 && forceScale <= 4 ? forceScale : PickScale(w, h, (int)OcrEngine.MaxImageDimension);
      double down = 1.0;
      int sw2 = w * scale, sh2 = h * scale;
      int max = (int)OcrEngine.MaxImageDimension;
      if (max > 0 && (sw2 > max || sh2 > max)) {
        down = Math.Min((double)max / sw2, (double)max / sh2);
        sw2 = Math.Max(1, (int)(sw2 * down)); sh2 = Math.Max(1, (int)(sh2 * down));
      }
      byte[] px = (sw2 == w && sh2 == h) ? Opaque(bgra) : Resample(bgra, w, h, sw2, sh2);
      double scaleMs = sw.Elapsed.TotalMilliseconds;
      sw.Restart();
      OcrResult res;
      try {
        var dw = new DataWriter();
        dw.WriteBytes(px);
        IBuffer buf = dw.DetachBuffer();
        SoftwareBitmap sb = SoftwareBitmap.CreateCopyFromBuffer(buf, BitmapPixelFormat.Bgra8, sw2, sh2, BitmapAlphaMode.Premultiplied);
        try {
          string err = WinRt.Await(engine.RecognizeAsync(sb), 15000, "Windows' OCR", out res);
          if (err != null) return err;
        } finally {
          try { sb.Dispose(); } catch (Exception) { }
        }
      } catch (Exception ex) {
        return "Windows' OCR could not read the selection (" + Why(ex) + ")";
      }
      double ocrMs = sw.Elapsed.TotalMilliseconds;
      double k = (double)sw2 / w;     // result px per crop px
      var lines = new List<object>();
      foreach (OcrLine line in res.Lines) {
        double l = double.MaxValue, t = double.MaxValue, r = double.MinValue, b = double.MinValue;
        foreach (OcrWord word in line.Words) {
          double bx, by, bw, bh;
          if (!BoxOf(word, out bx, out by, out bw, out bh)) continue;
          l = Math.Min(l, bx); t = Math.Min(t, by); r = Math.Max(r, bx + bw); b = Math.Max(b, by + bh);
        }
        if (l == double.MaxValue) { l = t = r = b = 0; }
        lines.Add(Json.Obj("text", line.Text, "x", Math.Round(l / k, 1), "y", Math.Round(t / k, 1),
          "w", Math.Round((r - l) / k, 1), "h", Math.Round((b - t) / k, 1)));
      }
      double? angle = null;
      try { angle = res.TextAngle; } catch (Exception) { }
      string lang = null;
      try { lang = engine.RecognizerLanguage.LanguageTag; } catch (Exception) { }
      result = Json.Obj("lines", lines, "lang", lang, "scale", Math.Round(k, 3),
        "angle", angle.HasValue ? (object)Math.Round(angle.Value, 2) : null,
        "ms", Json.Obj("scale", Math.Round(scaleMs, 2), "ocr", Math.Round(ocrMs, 2)));
      return null;
#else
      return Unavailable;
#endif
    }

#if MANTLE_WINMD
    /// A word's BoundingRect, read by REFLECTION. MEASURED (2026-09-27): Windows.Foundation.Rect is
    /// a projected struct whose .NET half lives in System.Runtime.WindowsRuntime.dll, and csc refuses
    /// to touch it without that reference ("CS0012: Windows.Foundation.Rect is defined in an assembly
    /// that is not referenced") - the same assembly whose AsTask drags in the SDK-only union winmd
    /// (build.ps1). At run time the CLR hands back the projected struct, so its X/Y/Width/Height
    /// properties are read by name instead. False (no box) if any of that fails.
    static System.Reflection.PropertyInfo _boxProp;
    static bool BoxOf(OcrWord word, out double x, out double y, out double w, out double h) {
      x = y = w = h = 0;
      try {
        if (_boxProp == null) _boxProp = typeof(OcrWord).GetProperty("BoundingRect");
        object r = _boxProp != null ? _boxProp.GetValue(word, null) : null;
        if (r == null) return false;
        Type t = r.GetType();
        x = Convert.ToDouble(t.GetProperty("X").GetValue(r, null));
        y = Convert.ToDouble(t.GetProperty("Y").GetValue(r, null));
        w = Convert.ToDouble(t.GetProperty("Width").GetValue(r, null));
        h = Convert.ToDouble(t.GetProperty("Height").GetValue(r, null));
        return true;
      } catch (Exception) {
        return false;
      }
    }
#endif

    /// Upscale (2x), or less when that would pass the engine's own limit on either side.
    public static int PickScale(int w, int h, int maxDim) {
      int s = Upscale;
      while (s > 1 && maxDim > 0 && (w * s > maxDim || h * s > maxDim)) s--;
      return s;
    }

    /// The same pixels with the fourth byte forced opaque (BitBlt leaves it undefined).
    static byte[] Opaque(byte[] bgra) {
      var o = (byte[])bgra.Clone();
      for (int i = 3; i < o.Length; i += 4) o[i] = 255;
      return o;
    }

    static byte[] Resample(byte[] bgra, int w, int h, int w2, int h2) {
      using (var src = new Bitmap(w, h, PixelFormat.Format32bppRgb))
      using (var dst = new Bitmap(w2, h2, PixelFormat.Format32bppArgb)) {
        BitmapData sd = src.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
        try {
          for (int y = 0; y < h; y++) Marshal.Copy(bgra, y * w * 4, new IntPtr(sd.Scan0.ToInt64() + (long)y * sd.Stride), w * 4);
        } finally { src.UnlockBits(sd); }
        using (var g = Graphics.FromImage(dst)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.CompositingMode = CompositingMode.SourceCopy;
          using (var ia = new ImageAttributes()) {
            ia.SetWrapMode(WrapMode.TileFlipXY);      // no dark fringe from sampling past the edge
            g.DrawImage(src, new Rectangle(0, 0, w2, h2), 0, 0, w, h, GraphicsUnit.Pixel, ia);
          }
        }
        var o = new byte[w2 * h2 * 4];
        BitmapData dd = dst.LockBits(new Rectangle(0, 0, w2, h2), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
          for (int y = 0; y < h2; y++) Marshal.Copy(new IntPtr(dd.Scan0.ToInt64() + (long)y * dd.Stride), o, y * w2 * 4, w2 * 4);
        } finally { dst.UnlockBits(dd); }
        for (int i = 3; i < o.Length; i += 4) o[i] = 255;
        return o;
      }
    }

    static string Why(Exception ex) {
      if (ex is AggregateException && ex.InnerException != null) ex = ex.InnerException;
      string msg = (ex.Message ?? "").Trim();
      int nl = msg.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) msg = msg.Substring(0, nl).Trim();
      return "HRESULT 0x" + ex.HResult.ToString("X8") + (msg.Length > 0 ? ": " + msg : "");
    }
  }
}
