// Icons.cs - exe/shortcut icon -> 64x64 PNG data URL, cached per path.
//
// WHY 64 (core-needs, 2026-09-30; was 32): the bar and the launcher draw an app icon at 24-32 CSS
// px, 48-64 device px at 150-200 %, so a 32 px picture was blown up and soft. The shell's image
// factory (Apps.ImageForPath) renders 64 from the icon's own large frame; SHGetFileInfo, which only
// has the 32 px "large" icon, is now the fallback. Tray icons (FromHIcon) stay 32: they are drawn
// at 16 CSS px.
//
// WHY a cache: the window list is rebuilt on every change and on a 2 s poll.
// Extracting an icon costs a shell round trip, so doing it per rebuild would
// make the sidecar the slowest thing in the shell. Icons for a given exe path
// never change while the machine is up, so one extraction per path is enough.
//
// WHY failures are cached too: a path that cannot yield an icon (denied, gone,
// a UWP host with no classic icon) would otherwise be retried 30 times a minute
// forever. We store a null and log ONCE per path - no silent failures, but no
// spam either.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace Mantle {
  static class Icons {
    public const int Size = 64;
    const int TraySize = 32;
    static readonly Dictionary<string, string> _cache =
      new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// data:image/png;base64,... or null. Never throws.
    /// The answer ForPath already has for a path, without extracting anything. -> true when it is
    /// known (url may then be null: that path has no icon). The window list on the ui lane uses this;
    /// the extraction runs off it (WindowList.QueueIcon, lane r7-fg).
    public static bool TryCached(string path, out string url) {
      url = null;
      if (string.IsNullOrEmpty(path)) return true;
      lock (_cache) return _cache.TryGetValue(path, out url);
    }

    public static string ForPath(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      string hit;
      // Locked: `icon` and `lnk` both land here, and a lane change must never
      // turn into a corrupted Dictionary. The extraction stays outside it.
      lock (_cache) { if (_cache.TryGetValue(path, out hit)) return hit; }

      string url = null;
      string why = null;
      try {
        url = Extract(path, out why);
      } catch (Exception ex) {
        why = ex.Message;
      }
      lock (_cache) _cache[path] = url;
      if (url == null) {
        // Once per path, in the UI the Electron side can actually show.
        Program.EmitLog("warn", "no icon for " + path + (why == null ? "" : " (" + why + ")"));
      }
      return url;
    }

    static string Extract(string path, out string why) {
      why = null;
      // Check first, because the exception .NET raises for a missing file is
      // just the path repeated back - useless in a log line that already has it.
      if (!File.Exists(path)) { why = "no such file"; return null; }
      // The sharp one first: the icon's own 64/128/256 frame, the picture Explorer draws at 64.
      string sharp = Apps.ImageForPath(path, Size);
      if (sharp != null) return sharp;
      IntPtr hIcon = IntPtr.Zero;
      bool destroy = false;
      Icon managed = null;
      try {
        // SHGetFileInfo is the one call that resolves .lnk shortcuts to the
        // target's icon AND handles exes, so it is the primary path.
        var info = new Win32.SHFILEINFO();
        IntPtr res = Win32.SHGetFileInfoW(path, 0, ref info,
          (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Win32.SHFILEINFO)),
          Win32.SHGFI_ICON | Win32.SHGFI_LARGEICON);
        if (res != IntPtr.Zero && info.hIcon != IntPtr.Zero) {
          hIcon = info.hIcon;
          destroy = true;
        } else {
          // Fallback: ExtractAssociatedIcon works on plain exe paths even when
          // the shell API declines (it reads the PE resource directly).
          try {
            managed = Icon.ExtractAssociatedIcon(path);
          } catch (Exception ex) {
            why = "ExtractAssociatedIcon: " + ex.Message;
          }
          if (managed == null && why == null) why = "shell returned no icon";
        }

        using (Icon ico = managed ?? (hIcon != IntPtr.Zero ? Icon.FromHandle(hIcon) : null)) {
          if (ico == null) { if (why == null) why = "no icon handle"; return null; }
          using (Bitmap raw = ico.ToBitmap())
          using (Bitmap sized = Resize(raw, Size))
          using (var ms = new MemoryStream()) {
            sized.Save(ms, ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
          }
        }
      } finally {
        // Icon.FromHandle does NOT own the handle, so the shell's HICON is ours
        // to destroy. Leaking these exhausts the desktop heap after a few
        // thousand extractions.
        if (destroy && hIcon != IntPtr.Zero) Win32.DestroyIcon(hIcon);
      }
    }

    static Bitmap Resize(Bitmap src, int px) {
      if (src.Width == px && src.Height == px) return new Bitmap(src);
      var dst = new Bitmap(px, px, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(dst)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(src, new Rectangle(0, 0, px, px));
      }
      return dst;
    }

    /// For the tray, where the icon arrives as a live HICON rather than a path.
    public static string FromHIcon(IntPtr hIcon) {
      if (hIcon == IntPtr.Zero) return null;
      try {
        using (var ico = Icon.FromHandle(hIcon))
        using (Bitmap raw = ico.ToBitmap())
        using (Bitmap sized = Resize(raw, TraySize))
        using (var ms = new MemoryStream()) {
          sized.Save(ms, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
        }
      } catch (Exception) {
        return null;
      }
    }
  }
}
