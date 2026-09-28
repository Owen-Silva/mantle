// Downloads.cs - the Downloads shelf's read of the Downloads folder (lane downloads, 2026-09-27).
//
// ONE command, and it is a READ (so a passive test sidecar answers it too):
//
//   downloads.list {folder?, max?}
//     -> {ok:true, folder, via, total, hidden, unspellable, items:[{name, dir, size, birthMs, mtimeMs}]}
//        (unspellable: names left out because they hold a lone UTF-16 surrogate, see WellFormed)
//     -> {ok:false, state:'unresolved'|'missing'|'unreadable', reason, folder?, via}
//
// WHY THE SIDECAR (and not node's fs): the shelf must skip hidden and system files, and node cannot
// see Windows file attributes at all. One FindFirstFile walk also brings every entry's attributes,
// size and both times at once, where node needs a stat per file.
//
// THE FOLDER: with no `folder` argument it is the Downloads KNOWN FOLDER (FOLDERID_Downloads), so a
// Downloads moved into OneDrive or onto another drive is followed. KF_FLAG_DONT_VERIFY: a folder that
// no longer exists still names its path, and the answer says "missing" instead of failing blind.
// `folder` is for tests (a temp folder); lib/features/downloads.js passes it only under --test.
//
// Order: newest ARRIVAL first, where arrival = the later of the creation and last-write times (a file
// copied in keeps an old write time but gets a new creation time; a browser's finished download gets a
// new write time). Only the newest `max` (default 60, cap 500) are returned; `total` counts every
// visible entry. Partial downloads (.crdownload ...) are NOT dropped here: that policy lives in one
// place, lib/features/_downloads-list.js.
//
// PRIVACY: file names are Owen's. Nothing here logs a name or a path, and no reason carries one (an
// IOException's message usually repeats the path, so only its HRESULT is quoted).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace Mantle {
  [MantleFeature]
  static class Downloads {
    public static void Register(FeatureTable t) {
      // a directory walk: the slow lane, never the ui lane the bar's clicks go through
      t.Add("downloads.list", Lanes.Slow, List);
    }

    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long Ms(DateTime utc) {
      if (utc <= Epoch) return 0;
      return (long)(utc - Epoch).TotalMilliseconds;
    }

    sealed class Entry {
      public string Name; public bool Dir; public long Size; public long Birth; public long Mtime;
      public long Arrival { get { return Birth > Mtime ? Birth : Mtime; } }
    }

    static string List(Dictionary<string, object> req, ref object result) {
      string folder = Json.GetString(req, "folder");
      string via = "argument";
      int max = Json.GetInt(req, "max", 60);
      if (max < 0) max = 0;
      if (max > 500) max = 500;

      if (string.IsNullOrEmpty(folder)) {
        string why;
        folder = KnownDownloads(out why);
        via = "known folder";
        if (folder == null) {
          result = Json.Obj("ok", false, "state", "unresolved", "via", via, "reason", why);
          return null;
        }
      }
      if (!Directory.Exists(folder)) {
        result = Json.Obj("ok", false, "state", "missing", "folder", folder, "via", via,
          "reason", "the Downloads folder does not exist (it was moved, renamed or deleted)");
        return null;
      }

      var all = new List<Entry>();
      int hidden = 0, unspellable = 0;
      try {
        foreach (FileSystemInfo fsi in new DirectoryInfo(folder).EnumerateFileSystemInfos()) {
          FileAttributes a;
          try { a = fsi.Attributes; } catch (Exception) { hidden++; continue; }
          if ((a & (FileAttributes.Hidden | FileAttributes.System)) != 0) { hidden++; continue; }
          // A name with a lone UTF-16 surrogate cannot cross the wire: UTF-8 turns it into U+FFFD, a
          // path that does not exist or names a DIFFERENT file (its U+FFFD twin). Counted, not listed.
          if (!WellFormed(fsi.Name)) { unspellable++; continue; }
          var e = new Entry { Name = fsi.Name, Dir = (a & FileAttributes.Directory) != 0 };
          try {
            e.Birth = Ms(fsi.CreationTimeUtc);
            e.Mtime = Ms(fsi.LastWriteTimeUtc);
            if (!e.Dir) { var fi = fsi as FileInfo; e.Size = fi != null ? fi.Length : 0; }
          } catch (Exception) { /* listed without times: it sorts last, it is not hidden */ }
          all.Add(e);
        }
      } catch (UnauthorizedAccessException) {
        result = Json.Obj("ok", false, "state", "unreadable", "folder", folder, "via", via,
          "reason", "Windows refused to list the Downloads folder (access denied)");
        return null;
      } catch (Exception ex) {
        result = Json.Obj("ok", false, "state", "unreadable", "folder", folder, "via", via,
          "reason", "the Downloads folder could not be listed (" + ex.GetType().Name + ", HRESULT 0x" + ex.HResult.ToString("X8") + ")");
        return null;
      }

      all.Sort((x, y) => {
        int c = y.Arrival.CompareTo(x.Arrival);
        return c != 0 ? c : string.Compare(x.Name, y.Name, StringComparison.OrdinalIgnoreCase);
      });
      var items = new ArrayList();
      for (int i = 0; i < all.Count && i < max; i++) {
        var e = all[i];
        items.Add(Json.Obj("name", e.Name, "dir", e.Dir, "size", e.Size, "birthMs", e.Birth, "mtimeMs", e.Mtime));
      }
      result = Json.Obj("ok", true, "folder", folder, "via", via, "total", all.Count, "hidden", hidden,
                        "unspellable", unspellable, "items", items);
      return null;
    }

    /// False when s holds a lone surrogate (NTFS keeps any UTF-16 unit; UTF-8 cannot carry one).
    static bool WellFormed(string s) {
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        if (char.IsHighSurrogate(c)) {
          if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { i++; continue; }
          return false;
        }
        if (char.IsLowSurrogate(c)) return false;
      }
      return true;
    }

    /// FOLDERID_Downloads, or null with the reason. Never throws.
    static string KnownDownloads(out string why) {
      why = null;
      IntPtr p = IntPtr.Zero;
      try {
        Guid g = new Guid("374DE290-123F-4565-9164-39C4925E467B");   // FOLDERID_Downloads
        int hr = DlNative.SHGetKnownFolderPath(ref g, DlNative.KF_FLAG_DONT_VERIFY, IntPtr.Zero, out p);
        if (hr != 0 || p == IntPtr.Zero) {
          why = "Windows has no Downloads known folder for this account (HRESULT 0x" + hr.ToString("X8") + ")";
          return null;
        }
        string s = Marshal.PtrToStringUni(p);
        if (string.IsNullOrEmpty(s)) { why = "Windows answered an empty path for the Downloads known folder"; return null; }
        return s;
      } catch (Exception e) {
        why = "the Downloads known folder could not be read (" + e.GetType().Name + ")";
        return null;
      } finally {
        if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p);
      }
    }
  }

  static class DlNative {
    public const uint KF_FLAG_DONT_VERIFY = 0x00004000;
    [DllImport("shell32.dll")]
    public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  }
}
