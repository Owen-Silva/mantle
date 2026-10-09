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
// make the sidecar the slowest thing in the shell. One extraction per path is
// enough AS LONG AS THE FILE IS THE SAME FILE.
//
// WHY the cache checks the file (mantle-icon, 2026-10-08). The old rule here was "icons for a
// given exe path never change while the machine is up", and it is false: an app rebuilt or
// updated IN PLACE keeps its path and gets a new picture. Owen's bar showed Helm's OLD icon (a
// ship's wheel) for a whole day after helm.exe was rebuilt with a new one (a round "H"). Two
// caches held it, and only one was Mantle's:
//   - WINDOWS' OWN. The shell's image factory (and SHGetFileInfo) answer from Explorer's icon
//     cache, keyed by path. MEASURED on this PC: overwrite an exe with a different one at the
//     same path and the factory still returns the OLD picture, in a fresh process and even after
//     SHChangeNotify(SHCNE_UPDATEITEM). Mantle restarted 10 h after the rebuild and was still
//     handed the wheel; Windows only caught up hours later.
//   - THIS ONE, which kept whatever it was first handed until Mantle restarted.
// So: (1) an .exe or .ico picture is read STRAIGHT FROM THE FILE (PrivateExtractIconsW reads the
// file's own icon resources, no shell cache), and a shortcut whose icon comes from an .exe or
// .ico is read from that file the same way; the image factory stays for everything else and as
// the fallback. (2) Each entry remembers the file's last-write time and size (and, for a
// shortcut, its icon file's); a lookup re-stats them at most once per StatEveryMs, and a change
// reads the picture again. A rebuild or update shows its new icon without a Mantle restart, and
// a path that did not change costs one stat every 2 s at most.
//
// WHY failures are cached too: a path that cannot yield an icon (denied, gone,
// a UWP host with no classic icon) would otherwise be retried 30 times a minute
// forever. We store a null and log ONCE per path and reason - no silent failures,
// but no spam either. A failure is tried again when the file changes (a missing
// exe that appears, a half-written one that is finished).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static class Icons {
    public const int Size = 64;
    const int TraySize = 32;
    /// How often a cached path's file is stat'ed again. Window lists are rebuilt every 250 ms
    /// while things move: this keeps that to one stat per path per 2 s.
    const int StatEveryMs = 2000;

    sealed class Entry {
      public string Url;        // the picture, or null: that path has no icon (Why says why)
      public string Why;
      public string Source;     // the file the picture was read from when that is not the path itself (a shortcut's icon file)
      public string Stamp;      // last-write ticks + size of the path (and Source) when the picture was read
      public int CheckedAt;     // Environment.TickCount of the last stat
      public bool Stale;        // the file changed since: read it again on the next ForPath
    }

    static readonly Dictionary<string, Entry> _cache =
      new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint PrivateExtractIconsW(string file, int index, int cx, int cy,
      [Out] IntPtr[] icons, [Out] uint[] ids, uint count, uint flags);

    /// "ticks:size" for an existing file, "-" for none. One GetFileAttributesEx; never throws.
    static string FileStamp(string path) {
      if (string.IsNullOrEmpty(path)) return "";
      try {
        var fi = new FileInfo(path);
        if (!fi.Exists) return "-";
        return fi.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" +
               fi.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
      } catch (Exception) {
        return "?";
      }
    }

    static string StampOf(string path, string source) {
      return source == null ? FileStamp(path) : FileStamp(path) + "|" + FileStamp(source);
    }

    /// Caller holds _cache. True when e still describes the file on disk (stat'ed at most once per
    /// StatEveryMs); false marks it Stale for good, so the next ForPath reads the picture again.
    static bool Fresh(string path, Entry e) {
      if (e.Stale) return false;
      int now = Environment.TickCount;
      if (unchecked(now - e.CheckedAt) < StatEveryMs) return true;
      e.CheckedAt = now;
      if (StampOf(path, e.Source) == e.Stamp) return true;
      e.Stale = true;
      return false;
    }

    // ---- read again in the background: TryCached's caller is the window list on the ui lane ----
    static readonly List<string> _refreshQueue = new List<string>();
    static readonly HashSet<string> _refreshQueued = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static System.Threading.Thread _refreshThread;
    static int _refreshed;     // 1 = a picture changed: Windows.OnTick sends the list again (TakeRefreshed)

    /// True once after a background re-read changed a picture (then false until the next one).
    public static bool TakeRefreshed() {
      return System.Threading.Interlocked.Exchange(ref _refreshed, 0) == 1;
    }

    static void QueueRefresh(string path) {
      lock (_refreshQueue) {
        if (!_refreshQueued.Add(path)) return;
        _refreshQueue.Add(path);
        if (_refreshThread != null) return;
        try {
          var t = new System.Threading.Thread(RefreshLoop);
          t.IsBackground = true;
          t.Name = "mantle-icon-refresh";
          t.SetApartmentState(System.Threading.ApartmentState.STA);   // the image factory and IShellLink are COM
          t.Start();
          _refreshThread = t;
        } catch (Exception ex) {
          // the paths stay in _refreshQueued, so this is logged once per path, not on every tick
          _refreshQueue.Clear();
          Program.EmitLog("warn", "a changed app icon could not be read again in the background, so the window list keeps the old one until Mantle restarts (" + ex.Message + ")");
        }
      }
    }

    static void RefreshLoop() {
      while (true) {
        string path;
        lock (_refreshQueue) {
          if (_refreshQueue.Count == 0) { _refreshThread = null; return; }
          path = _refreshQueue[0];
          _refreshQueue.RemoveAt(0);
        }
        string before = null;
        lock (_cache) { Entry old; if (_cache.TryGetValue(path, out old)) before = old.Url; }
        string after = null;
        try { after = ForPath(path); } catch (Exception ex) { Program.EmitLog("warn", "a changed app icon could not be read again: " + ex.Message); }
        lock (_refreshQueue) _refreshQueued.Remove(path);
        if (!string.Equals(before, after, StringComparison.Ordinal)) System.Threading.Interlocked.Exchange(ref _refreshed, 1);
      }
    }

    /// data:image/png;base64,... or null. Never throws.
    /// The answer ForPath already has for a path, without extracting anything. -> true when it is
    /// known (url may then be null: that path has no icon). The window list on the ui lane uses this;
    /// the extraction runs off it (WindowList.QueueIcon, lane r7-fg). A path whose file CHANGED
    /// still answers its old picture here (no blank while the new one is read) and is read again on
    /// a background thread; TakeRefreshed then tells the window list to send itself again.
    public static bool TryCached(string path, out string url) {
      url = null;
      if (string.IsNullOrEmpty(path)) return true;
      Entry e;
      bool stale;
      lock (_cache) {
        if (!_cache.TryGetValue(path, out e)) return false;
        url = e.Url;
        stale = !Fresh(path, e);
      }
      if (stale) QueueRefresh(path);
      return true;
    }

    public static string ForPath(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      Entry prev;
      // Locked: `icon` and `lnk` both land here, and a lane change must never
      // turn into a corrupted Dictionary. The extraction stays outside it.
      lock (_cache) {
        if (_cache.TryGetValue(path, out prev) && Fresh(path, prev)) return prev.Url;
      }

      string url = null;
      string why = null;
      string source = null;
      // Stamped BEFORE reading: a file rewritten while it is read then looks changed next time,
      // and is read again, rather than keeping a half-built picture.
      string stamp = FileStamp(path);
      try {
        url = Extract(path, out why, out source);
      } catch (Exception ex) {
        why = ex.Message;
      }
      if (source != null) stamp = stamp + "|" + FileStamp(source);
      var e = new Entry { Url = url, Why = why, Source = source, Stamp = stamp, CheckedAt = Environment.TickCount };
      lock (_cache) _cache[path] = e;
      if (url == null) {
        // Once per path and reason, in the UI the Electron side can actually show.
        if (prev == null || prev.Url != null || prev.Why != why)
          Program.EmitLog("warn", "no icon for " + path + (why == null ? "" : " (" + why + ")"));
      } else if (prev != null && prev.Url != null && prev.Url != url) {
        Program.EmitLog("info", "an app's icon file changed on disk, so its new icon was read");
      }
      return url;
    }

    /// The file a shortcut's picture comes from, when it is an .exe or .ico Mantle can read
    /// directly: its icon location if it has one, else its target. Null otherwise (an item-list
    /// shortcut, a document target, an icon in a system DLL): the shell reads those.
    static string LnkIconFile(string lnk, out int index) {
      index = 0;
      object com = null;
      try {
        com = new ShellLink();
        ((System.Runtime.InteropServices.ComTypes.IPersistFile)com).Load(lnk, Win32.STGM_READ);
        var link = (IShellLinkW)com;
        var sb = new StringBuilder(1040);
        int idx = 0;
        link.GetIconLocation(sb, sb.Capacity, out idx);
        string file = Environment.ExpandEnvironmentVariables(sb.ToString()).Trim().Trim('"');
        if (file.Length == 0) {
          sb.Length = 0;
          link.GetPath(sb, sb.Capacity, IntPtr.Zero, Win32.SLGP_RAWPATH);
          file = Environment.ExpandEnvironmentVariables(sb.ToString()).Trim().Trim('"');
          idx = 0;
        }
        if (!OwnIconFile(file) || !File.Exists(file)) return null;
        index = idx;
        return file;
      } catch (Exception) {
        return null;     // the shell route below still draws it
      } finally {
        if (com != null) { try { Marshal.FinalReleaseComObject(com); } catch (Exception) { } }
      }
    }

    static bool OwnIconFile(string file) {
      if (string.IsNullOrEmpty(file)) return false;
      string ext = Path.GetExtension(file);
      return string.Equals(ext, ".exe", StringComparison.OrdinalIgnoreCase) ||
             string.Equals(ext, ".ico", StringComparison.OrdinalIgnoreCase);
    }

    /// The picture read from the file itself (its icon resources), Size x Size, or null.
    static string FromFile(string file, int index) {
      var icons = new IntPtr[1];
      var ids = new uint[1];
      uint got;
      try { got = PrivateExtractIconsW(file, index, Size, Size, icons, ids, 1, 0); }
      catch (Exception) { return null; }
      if (got == 0 || got == 0xFFFFFFFF || icons[0] == IntPtr.Zero) return null;
      try {
        using (var ico = Icon.FromHandle(icons[0]))
        using (Bitmap raw = ico.ToBitmap())
        using (Bitmap sized = Resize(raw, Size))
        using (var ms = new MemoryStream()) {
          sized.Save(ms, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
        }
      } catch (Exception) {
        return null;
      } finally {
        Win32.DestroyIcon(icons[0]);
      }
    }

    static string Extract(string path, out string why, out string source) {
      why = null;
      source = null;
      // Check first, because the exception .NET raises for a missing file is
      // just the path repeated back - useless in a log line that already has it.
      if (!File.Exists(path)) { why = "no such file"; return null; }
      // From the file itself first, for the pictures an app rebuild changes (see WHY the cache checks).
      if (OwnIconFile(path)) {
        string own = FromFile(path, 0);
        if (own != null) return own;
      } else if (string.Equals(Path.GetExtension(path), ".lnk", StringComparison.OrdinalIgnoreCase)) {
        int index;
        string file = LnkIconFile(path, out index);
        if (file != null) {
          source = file;
          string own = FromFile(file, index);
          if (own != null) return own;
        }
      }
      // The sharp one: the icon's own 64/128/256 frame, the picture Explorer draws at 64.
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
