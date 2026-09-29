// Files.cs - Mantle Files' READ commands: roots, list, stat, size, search, recent, types, icons,
// cancel, conflicts (lane files, 2026-09-28). The contract is
// scratchpad/lanes/files/CONTRACT.md; lib/features/files.js is the other end.
//
// WHY streamed: a folder of 10,000 files is one FindFirstFileEx pass (tens of ms) but one JSON
// line of 10,000 items would make the page wait for the last one before drawing the first. So a
// list answers {job, started} at once and its own thread pushes `files.items` events: the first
// after <=100 items or 16 ms (the page paints a screenful immediately), then ~1000 items or every
// 50 ms. search and size stream the same way; files.cancel stops any of them.
//
// Everything here is a READ and is allowed in --passive. PRIVACY: names and paths go into
// results and events (the page needs them) but never into EmitLog or an error string.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using FN = Mantle.FilesNative;

namespace Mantle {
  [MantleFeature]
  static class Files {
    public static void Register(FeatureTable t) {
      t.Add("files.roots", Lanes.Slow, Safe("files.roots", Roots));
      t.Add("files.list", Lanes.Slow, Safe("files.list", List));
      t.Add("files.cancel", Lanes.Slow, Safe("files.cancel", Cancel));
      t.Add("files.stat", Lanes.Slow, Safe("files.stat", Stat));
      t.Add("files.size", Lanes.Slow, Safe("files.size", Size));
      t.Add("files.search", Lanes.Slow, Safe("files.search", Search));
      t.Add("files.recent", Lanes.Slow, Safe("files.recent", Recent));
      t.Add("files.types", Lanes.Slow, Safe("files.types", Types));
      t.Add("files.icons", Lanes.Slow, Safe("files.icons", Icons));
      t.Add("files.conflicts", Lanes.Slow, Safe("files.conflicts", Conflicts));
    }

    /// Features.TryRun would put ex.Message in the error, and a .NET IO message can quote the
    /// path. Every Files command goes through this instead: the type name only.
    internal static FeatureCommand Safe(string name, FeatureCommand fn) {
      return delegate (Dictionary<string, object> req, ref object result) {
        try { return fn(req, ref result); }
        catch (Exception ex) { return name + " failed: " + ex.GetType().Name; }
      };
    }

    static readonly long Freq = Stopwatch.Frequency;
    static long MsSince(long ts) { return (Stopwatch.GetTimestamp() - ts) * 1000L / Freq; }

    // ------------------------------------------------------------------ cancel

    static string Cancel(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "job");
      if (string.IsNullOrEmpty(key)) return "files.cancel needs job";
      result = Json.Obj("cancelled", FilesJobs.Cancel(key));
      return null;
    }

    // ------------------------------------------------------------------ list

    static string List(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.list needs path: an absolute folder (C:\\... or \\\\server\\share)";
      string err;
      FilesJob job = FilesJobs.Start(req, "list", out err);
      if (job == null) return err;
      var t = new Thread(delegate () {
        try { RunList(job, path); }
        catch (Exception ex) { Done("files.items", job, new List<object>(), 0, "files.list failed: " + ex.GetType().Name, null); }
        finally { FilesJobs.End(job); }
      });
      t.IsBackground = true;
      t.Name = "mantle-files-list";
      t.Start();
      result = Json.Obj("job", job.Raw, "started", true);
      return null;
    }

    /// "C:" -> "C:\*", "C:\x\" -> "C:\x\*"; a long path gets the \\?\ prefix, which also turns
    /// off Win32's normalisation, so slashes are fixed first.
    static string Pattern(string path) {
      string p = path.Replace('/', '\\');
      if (p.Length == 2 && p[1] == ':') p += "\\";
      string pat = p.EndsWith("\\", StringComparison.Ordinal) ? p + "*" : p + "\\*";
      if (pat.Length >= 248 && !pat.StartsWith("\\\\?\\", StringComparison.Ordinal))
        pat = pat.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + pat.Substring(2) : "\\\\?\\" + pat;
      return pat;
    }

    static void RunList(FilesJob job, string path) {
      var batch = new List<object>(128);
      int count = 0;
      bool sentAny = false;
      string error = null;
      long lastFlush = job.StartTs;
      FN.WIN32_FIND_DATAW f;
      IntPtr h = FN.FindFirstFileExW(Pattern(path), FN.FindExInfoBasic, out f, FN.FindExSearchNameMatch,
                                     IntPtr.Zero, FN.FIND_FIRST_EX_LARGE_FETCH);
      if (h == FN.INVALID_HANDLE_VALUE) {
        int e = Marshal.GetLastWin32Error();
        // ERROR_FILE_NOT_FOUND for "x\*" means NO entries at all: an empty drive root (a folder
        // always has . and ..). Anything else is a real failure.
        uint a = FN.GetFileAttributesW(path);
        if (!(e == 2 && a != FN.INVALID_FILE_ATTRIBUTES && (a & FN.FILE_ATTRIBUTE_DIRECTORY) != 0)) error = FN.Win32Words(e);
      } else {
        try {
          do {
            if (job.Cancelled) break;
            string n = f.cFileName;
            if (n == "." || n == "..") continue;
            batch.Add(FN.Item(ref f));
            count++;
            int lim = sentAny ? 1000 : 100;
            long msLim = sentAny ? 50 : 16;
            long now = Stopwatch.GetTimestamp();
            if (batch.Count >= lim || (now - lastFlush) * 1000L / Freq >= msLim) {
              Features.Event("files.items", Json.Obj("job", job.Raw, "items", batch, "done", false));
              batch = new List<object>(1024);
              sentAny = true;
              lastFlush = now;
            }
          } while (FN.FindNextFileW(h, out f));
          int e2 = Marshal.GetLastWin32Error();
          if (!job.Cancelled && e2 != 18 && e2 != 0) error = FN.Win32Words(e2);   // 18 = no more files
        } finally { FN.FindClose(h); }
      }
      Done("files.items", job, batch, count, error, null);
    }

    static void Done(string ev, FilesJob job, List<object> items, int count, string error, IDictionary extra) {
      var o = Json.Obj("job", job.Raw, "items", items, "done", true, "count", count, "ms", job.Ms);
      if (error != null) o["error"] = error;
      if (job.Cancelled) o["cancelled"] = true;
      if (extra != null) foreach (DictionaryEntry kv in extra) o[kv.Key] = kv.Value;
      Features.Event(ev, o);
    }

    // ------------------------------------------------------------------ stat

    static string Stat(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.stat needs path: an absolute path";
      uint attrs; long size, m, c, acc;
      FN.WIN32_FILE_ATTRIBUTE_DATA d;
      if (FN.GetFileAttributesExW(path, 0, out d)) {
        attrs = d.dwFileAttributes;
        size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow;
        m = FN.FtMs(d.ftWriteLow, d.ftWriteHigh); c = FN.FtMs(d.ftCreationLow, d.ftCreationHigh);
        acc = FN.FtMs(d.ftAccessLow, d.ftAccessHigh);
      } else {
        int e = Marshal.GetLastWin32Error();
        if (e == 2 || e == 3 || e == 123 || e == 161 || e == 267) { result = Json.Obj("exists", false); return null; }
        // A locked file (pagefile.sys: sharing violation) or a denied one: its folder's listing
        // still knows it, so ask that instead of failing.
        FN.WIN32_FIND_DATAW f;
        IntPtr h = FN.FindFirstFileExW(path.TrimEnd('\\'), FN.FindExInfoBasic, out f, FN.FindExSearchNameMatch, IntPtr.Zero, 0);
        if (h == FN.INVALID_HANDLE_VALUE) return "files.stat: " + FN.Win32Words(e);
        FN.FindClose(h);
        attrs = f.dwFileAttributes;
        size = ((long)f.nFileSizeHigh << 32) | f.nFileSizeLow;
        m = FN.FtMs(f.ftWriteLow, f.ftWriteHigh); c = FN.FtMs(f.ftCreationLow, f.ftCreationHigh);
        acc = FN.FtMs(f.ftAccessLow, f.ftAccessHigh);
      }
      bool dir = (attrs & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
      string trimmed = path.Length > 3 ? path.TrimEnd('\\', '/') : path;
      string name = Path.GetFileName(trimmed);
      if (string.IsNullOrEmpty(name)) name = trimmed;
      string ext = dir ? "folder" : Path.GetExtension(trimmed);
      string target = null;
      if (!dir && string.Equals(ext, ".lnk", StringComparison.OrdinalIgnoreCase)) {
        FN.WIN32_FIND_DATAW unused;
        target = LinkTarget(path, false, out unused);
      }
      result = Json.Obj("exists", true, "n", name, "d", dir ? 1 : 0, "s", dir ? 0 : size, "m", m, "c", c, "acc", acc,
                        "a", (long)attrs, "type", TypeName(ext), "target", target);
      return null;
    }

    /// A .lnk's stored target path, read WITHOUT Resolve (Resolve can search the disk and show
    /// UI). `wantFind`: also the file data the link stored about its target, so a network target
    /// is described without touching the network. Null when the link has no file-system target.
    internal static string LinkTarget(string lnk, bool wantFind, out FN.WIN32_FIND_DATAW find) {
      return LinkTarget(lnk, wantFind, out find, null);
    }

    /// `shared`: one ShellLink object reused for a whole scan (Load may be called again on it).
    /// MEASURED on the Recent folder: a new object per link cost ~25 ms each, 2.1 s for 20.
    internal static string LinkTarget(string lnk, bool wantFind, out FN.WIN32_FIND_DATAW find, object shared) {
      find = new FN.WIN32_FIND_DATAW();
      object o = shared;
      IntPtr pfd = IntPtr.Zero;
      try {
        if (o == null) o = Activator.CreateInstance(Type.GetTypeFromCLSID(FN.CLSID_ShellLink));
        if (((FN.IPersistFile)o).Load(lnk, 0) != 0) return null;
        var sb = new StringBuilder(1024);
        if (wantFind) pfd = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FN.WIN32_FIND_DATAW)) + 16);
        if (((FN.IShellLinkW)o).GetPath(sb, sb.Capacity, pfd, 0) != 0) return null;
        if (wantFind) find = (FN.WIN32_FIND_DATAW)Marshal.PtrToStructure(pfd, typeof(FN.WIN32_FIND_DATAW));
        return sb.Length > 0 ? sb.ToString() : null;
      } catch (Exception) {
        return null;
      } finally {
        if (pfd != IntPtr.Zero) Marshal.FreeHGlobal(pfd);
        if (shared == null) FN.Release(o);
      }
    }

    // ------------------------------------------------------------------ size

    static string Size(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.size needs path: an absolute path";
      string err;
      FilesJob job = FilesJobs.Start(req, "size", out err);
      if (job == null) return err;
      var t = new Thread(delegate () {
        try { RunSize(job, path); }
        catch (Exception ex) {
          Features.Event("files.size", Json.Obj("job", job.Raw, "done", true, "ms", job.Ms, "error", "files.size failed: " + ex.GetType().Name));
        } finally { FilesJobs.End(job); }
      });
      t.IsBackground = true;
      t.Name = "mantle-files-size";
      t.Start();
      result = Json.Obj("job", job.Raw, "started", true);
      return null;
    }

    /// A junction or symlink (a NAME-SURROGATE reparse point) is not walked: it would count
    /// another folder's bytes twice or loop forever. Cloud placeholders (OneDrive) are reparse
    /// points too but NOT surrogates, so they are walked and counted like any folder.
    static bool IsLink(ref FN.WIN32_FIND_DATAW f) {
      return (f.dwFileAttributes & FN.FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (f.dwReserved0 & 0x20000000) != 0;
    }

    static void RunSize(FilesJob job, string path) {
      long bytes = 0; int files = 0, dirs = 0, denied = 0;
      string error = null;
      long lastEmit = Stopwatch.GetTimestamp();
      FN.WIN32_FILE_ATTRIBUTE_DATA d;
      if (!FN.GetFileAttributesExW(path, 0, out d)) {
        error = FN.Win32Words(Marshal.GetLastWin32Error());
      } else if ((d.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) == 0) {
        bytes = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow; files = 1;
      } else {
        var stack = new Stack<string>();
        stack.Push(path);
        while (stack.Count > 0 && !job.Cancelled) {
          string dir = stack.Pop();
          FN.WIN32_FIND_DATAW f;
          IntPtr h = FN.FindFirstFileExW(Pattern(dir), FN.FindExInfoBasic, out f, FN.FindExSearchNameMatch, IntPtr.Zero, FN.FIND_FIRST_EX_LARGE_FETCH);
          if (h == FN.INVALID_HANDLE_VALUE) { if (Marshal.GetLastWin32Error() != 2) denied++; continue; }
          try {
            do {
              string n = f.cFileName;
              if (n == "." || n == "..") continue;
              if (IsLink(ref f)) continue;
              if ((f.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0) {
                dirs++;
                stack.Push(dir.EndsWith("\\", StringComparison.Ordinal) ? dir + n : dir + "\\" + n);
              } else {
                files++;
                bytes += ((long)f.nFileSizeHigh << 32) | f.nFileSizeLow;
              }
            } while (!job.Cancelled && FN.FindNextFileW(h, out f));
          } finally { FN.FindClose(h); }
          if (MsSince(lastEmit) >= 250) {
            Features.Event("files.size", Json.Obj("job", job.Raw, "bytes", bytes, "files", files, "dirs", dirs,
                                                  "denied", denied, "done", false, "ms", job.Ms));
            lastEmit = Stopwatch.GetTimestamp();
          }
        }
      }
      var o = Json.Obj("job", job.Raw, "bytes", bytes, "files", files, "dirs", dirs, "denied", denied, "done", true, "ms", job.Ms);
      if (error != null) o["error"] = error;
      if (job.Cancelled) o["cancelled"] = true;
      Features.Event("files.size", o);
    }

    // ------------------------------------------------------------------ search

    const int SearchDefaultMax = 5000, SearchHardMax = 100000;

    static string Search(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.search needs path: an absolute folder";
      string q = (Json.GetString(req, "query") ?? "").Trim();
      if (q.Length == 0) return "files.search needs query: the text to look for";
      if (q.Length > 260) return "files.search: query is longer than 260 characters";
      int max = Json.GetInt(req, "max", SearchDefaultMax);
      if (max < 1 || max > SearchHardMax) return "files.search: max must be 1.." + SearchHardMax;
      Regex rx = null;
      if (q.IndexOf('*') >= 0 || q.IndexOf('?') >= 0) {
        // Wildcards match the WHOLE name, as Explorer and cmd do: "*.txt" ends in .txt.
        rx = new Regex("^" + Regex.Escape(q).Replace("\\*", ".*").Replace("\\?", ".") + "$",
                       RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline);
      }
      string err;
      FilesJob job = FilesJobs.Start(req, "search", out err);
      if (job == null) return err;
      var t = new Thread(delegate () {
        try { RunSearch(job, path, q, rx, max); }
        catch (Exception ex) { Done("files.found", job, new List<object>(), 0, "files.search failed: " + ex.GetType().Name, null); }
        finally { FilesJobs.End(job); }
      });
      t.IsBackground = true;
      t.Name = "mantle-files-search";
      t.Start();
      result = Json.Obj("job", job.Raw, "started", true);
      return null;
    }

    /// Breadth first, so the matches nearest the folder the user is in arrive first.
    static void RunSearch(FilesJob job, string root, string q, Regex rx, int max) {
      var batch = new List<object>(128);
      int count = 0, denied = 0;
      bool sentAny = false, capped = false;
      long lastFlush = job.StartTs;
      var queue = new Queue<string>();
      queue.Enqueue(root);
      while (queue.Count > 0 && !job.Cancelled && !capped) {
        string dir = queue.Dequeue();
        FN.WIN32_FIND_DATAW f;
        IntPtr h = FN.FindFirstFileExW(Pattern(dir), FN.FindExInfoBasic, out f, FN.FindExSearchNameMatch, IntPtr.Zero, FN.FIND_FIRST_EX_LARGE_FETCH);
        if (h == FN.INVALID_HANDLE_VALUE) { if (Marshal.GetLastWin32Error() != 2) denied++; continue; }
        try {
          do {
            string n = f.cFileName;
            if (n == "." || n == "..") continue;
            string full = dir.EndsWith("\\", StringComparison.Ordinal) ? dir + n : dir + "\\" + n;
            bool isDir = (f.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (isDir && !IsLink(ref f)) queue.Enqueue(full);
            bool hit = rx != null ? rx.IsMatch(n) : n.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!hit) continue;
            IDictionary item = FN.Item(ref f);
            item["p"] = full;
            batch.Add(item);
            count++;
            if (count >= max) { capped = true; break; }
            int lim = sentAny ? 1000 : 100;
            long msLim = sentAny ? 50 : 16;
            long now = Stopwatch.GetTimestamp();
            if (batch.Count >= lim || (now - lastFlush) * 1000L / Freq >= msLim) {
              Features.Event("files.found", Json.Obj("job", job.Raw, "items", batch, "done", false));
              batch = new List<object>(1024);
              sentAny = true;
              lastFlush = now;
            }
          } while (!job.Cancelled && FN.FindNextFileW(h, out f));
        } finally { FN.FindClose(h); }
      }
      Done("files.found", job, batch, count, null, Json.Obj("capped", capped, "denied", denied));
    }

    // ------------------------------------------------------------------ recent

    /// MEASURED 2026-09-28 on Owen's Recent folder (129 links): 20 items took 0.3-2.1 s and 40
    /// took 4.8 s, because reading some links costs seconds. Past this budget the answer is what
    /// was found so far, with partial:true, rather than a timeout on the page.
    const int RecentBudgetMs = 2500;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);

    static string Recent(Dictionary<string, object> req, ref object result) {
      int max = Json.GetInt(req, "max", 50);
      if (max < 1 || max > 1000) return "files.recent: max must be 1..1000";
      result = FilesDefer.Run(req, "mantle-files-recent", delegate (out object res) {
        res = null;
        string dir = Environment.GetFolderPath(Environment.SpecialFolder.Recent);
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) { res = Json.Obj("items", new List<object>()); return null; }
        FileInfo[] links;
        try { links = new DirectoryInfo(dir).GetFiles("*.lnk"); }
        catch (Exception ex) { return "files.recent: the Recent folder could not be read (" + ex.GetType().Name + ")"; }
        Array.Sort(links, delegate (FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
        var items = new List<object>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long t0 = Stopwatch.GetTimestamp();
        bool partial = false;
        object shell = Activator.CreateInstance(Type.GetTypeFromCLSID(FN.CLSID_ShellLink));
        try {
          foreach (FileInfo li in links) {
            if (items.Count >= max) break;
            if (MsSince(t0) > RecentBudgetMs) { partial = true; break; }
            FN.WIN32_FIND_DATAW fd;
            string target = LinkTarget(li.FullName, true, out fd, shell);
            if (string.IsNullOrEmpty(target) || !FN.IsAbsolute(target) || !seen.Add(target)) continue;
            bool isDir;
            if (target.StartsWith("\\\\", StringComparison.Ordinal) || GetDriveTypeW(target.Substring(0, 3)) != 3) {
              // A network, mapped, removable or optical target is described from what the link
              // stored: an offline share would hold this answer for the SMB timeout (tens of
              // seconds). GetDriveType itself does no I/O.
              isDir = (fd.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
            } else {
              uint a = FN.GetFileAttributesW(target);
              if (a == FN.INVALID_FILE_ATTRIBUTES) continue;     // the target is gone: dropped
              isDir = (a & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
            }
            string t = target.Length > 3 ? target.TrimEnd('\\') : target;
            string n = Path.GetFileName(t);
            if (string.IsNullOrEmpty(n)) n = t;
            long used = (long)(li.LastWriteTimeUtc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            items.Add(Json.Obj("path", target, "n", n, "d", isDir ? 1 : 0, "m", used));
          }
        } finally { FN.Release(shell); }
        res = Json.Obj("items", items, "partial", partial);
        return null;
      });
      return null;
    }

    // ------------------------------------------------------------------ types

    static readonly Dictionary<string, string> _types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// An extension the shell can be asked about without a file: ".png", "" (no extension) or
    /// "folder". Anything with a path character is refused (null).
    static bool ValidExt(string ext) {
      if (ext == null || ext.Length > 40) return false;
      if (ext == "folder" || ext.Length == 0) return true;
      return ext[0] == '.' && ext.IndexOfAny(new char[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|', '\0' }) < 0;
    }

    internal static string TypeName(string ext) {
      if (!ValidExt(ext)) return null;
      lock (_types) { string c; if (_types.TryGetValue(ext, out c)) return c; }
      bool folder = ext == "folder";
      var sfi = new FN.SHFILEINFOW();
      IntPtr ok = FN.SHGetFileInfoW(folder ? "folder" : "file" + ext,
                                    folder ? FN.FILE_ATTRIBUTE_DIRECTORY : FN.FILE_ATTRIBUTE_NORMAL, ref sfi,
                                    (uint)Marshal.SizeOf(typeof(FN.SHFILEINFOW)), FN.SHGFI_TYPENAME | FN.SHGFI_USEFILEATTRIBUTES);
      string name = ok != IntPtr.Zero ? sfi.szTypeName : null;
      if (name != null) lock (_types) _types[ext] = name;
      return name;
    }

    static string Types(Dictionary<string, object> req, ref object result) {
      List<string> exts = FN.StringList(req, "exts");
      if (exts.Count > 2000) return "files.types: at most 2000 exts per call";
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string e in exts) o[e] = TypeName(e);
      result = Json.Obj("types", o);
      return null;
    }

    // ------------------------------------------------------------------ icons

    static readonly Dictionary<string, string> _icons = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    const int SHIL_LARGE = 0, SHIL_SMALL = 1, SHIL_EXTRALARGE = 2, SHIL_JUMBO = 4;
    const int ILD_TRANSPARENT = 1;

    static string Icons(Dictionary<string, object> req, ref object result) {
      int px = Json.GetInt(req, "px", 32);
      int shil;
      switch (px) {
        case 16: shil = SHIL_SMALL; break;
        case 32: shil = SHIL_LARGE; break;
        case 48: shil = SHIL_EXTRALARGE; break;
        case 256: shil = SHIL_JUMBO; break;
        default: return "files.icons: px must be 16, 32, 48 or 256";
      }
      List<string> exts = FN.StringList(req, "exts");
      if (exts.Count > 500) return "files.icons: at most 500 exts per call";
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string e in exts) o[e] = ExtIcon(e, shil, px);
      result = Json.Obj("icons", o);
      return null;
    }

    /// The per-EXTENSION icon (SHGFI_USEFILEATTRIBUTES: no disk read, so a slow drive or a
    /// thousand-file folder costs nothing), from the system image list at `px`, alpha kept.
    internal static string ExtIcon(string ext, int shil, int px) {
      if (!ValidExt(ext)) return null;
      string key = ext + "|" + px;
      lock (_icons) { string c; if (_icons.TryGetValue(key, out c)) return c; }
      int w, h;
      byte[] bits = ExtIconBits(ext, shil, out w, out h);
      if (bits == null) return null;
      if (px == 256 && FitsTopLeft(bits, w, h, 48)) {
        // No 256 px art for this type: the jumbo list holds the 48 px icon in its top-left corner.
        // Centre the 48 px one instead, as Explorer does, so it does not sit in a corner.
        int sw, sh;
        byte[] small = ExtIconBits(ext, SHIL_EXTRALARGE, out sw, out sh);
        if (small != null && sw <= w && sh <= h) {
          var canvas = new byte[w * h * 4];
          int ox = (w - sw) / 2, oy = (h - sh) / 2;
          for (int y = 0; y < sh; y++) Buffer.BlockCopy(small, y * sw * 4, canvas, ((oy + y) * w + ox) * 4, sw * 4);
          bits = canvas;
        }
      }
      string png = FN.Png(bits, w, h, false);
      lock (_icons) _icons[key] = png;
      return png;
    }

    static byte[] ExtIconBits(string ext, int shil, out int w, out int h) {
      w = 0; h = 0;
      bool folder = ext == "folder";
      var sfi = new FN.SHFILEINFOW();
      IntPtr ok = FN.SHGetFileInfoW(folder ? "folder" : "file" + ext,
                                    folder ? FN.FILE_ATTRIBUTE_DIRECTORY : FN.FILE_ATTRIBUTE_NORMAL, ref sfi,
                                    (uint)Marshal.SizeOf(typeof(FN.SHFILEINFOW)), FN.SHGFI_SYSICONINDEX | FN.SHGFI_USEFILEATTRIBUTES);
      if (ok == IntPtr.Zero) return null;
      object o;
      Guid iid = FN.IID_IImageList;
      if (FN.SHGetImageList(shil, ref iid, out o) != 0 || o == null) return null;
      IntPtr hicon = IntPtr.Zero;
      try {
        if (((FN.IImageList)o).GetIcon(sfi.iIcon, ILD_TRANSPARENT, out hicon) != 0 || hicon == IntPtr.Zero) return null;
        return FN.IconBits(hicon, out w, out h);
      } finally {
        if (hicon != IntPtr.Zero) FN.DestroyIcon(hicon);
        FN.Release(o);
      }
    }

    static bool FitsTopLeft(byte[] bits, int w, int h, int n) {
      if (w <= n || h <= n) return false;
      for (int y = 0; y < h; y++)
        for (int x = (y < n ? n : 0); x < w; x++)
          if (bits[(y * w + x) * 4 + 3] != 0) return false;
      return true;
    }

    // ------------------------------------------------------------------ conflicts

    static string Conflicts(Dictionary<string, object> req, ref object result) {
      string dest = Json.GetString(req, "dest");
      if (!FN.IsAbsolute(dest)) return "files.conflicts needs dest: an absolute folder";
      List<string> items = FN.StringList(req, "items");
      if (items.Count > 100000) return "files.conflicts: too many items";
      var list = new List<object>();
      foreach (string src in items) {
        if (!FN.IsAbsolute(src)) continue;
        string t = src.Length > 3 ? src.TrimEnd('\\', '/') : src;
        string name = Path.GetFileName(t);
        if (string.IsNullOrEmpty(name)) continue;
        string dst = dest.EndsWith("\\", StringComparison.Ordinal) ? dest + name : dest + "\\" + name;
        FN.WIN32_FILE_ATTRIBUTE_DATA dd, sd;
        if (!FN.GetFileAttributesExW(dst, 0, out dd)) continue;
        bool haveSrc = FN.GetFileAttributesExW(src, 0, out sd);
        bool sDir = haveSrc && (sd.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
        bool dDir = (dd.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0;
        list.Add(Json.Obj("src", src, "dst", dst, "d", sDir ? 1 : 0,
                          "s", haveSrc && !sDir ? (((long)sd.nFileSizeHigh << 32) | sd.nFileSizeLow) : 0,
                          "m", haveSrc ? FN.FtMs(sd.ftWriteLow, sd.ftWriteHigh) : 0,
                          "dstS", dDir ? 0 : (((long)dd.nFileSizeHigh << 32) | dd.nFileSizeLow),
                          "dstM", FN.FtMs(dd.ftWriteLow, dd.ftWriteHigh), "dstD", dDir ? 1 : 0));
      }
      result = Json.Obj("conflicts", list);
      return null;
    }

    // ------------------------------------------------------------------ roots

    static readonly string[] KnownKeys = { "desktop", "downloads", "documents", "pictures", "music", "videos", "onedrive", "home", "recent" };
    static readonly Guid[] KnownIds = {
      new Guid("B4BFCC3A-DB2C-424C-B029-7FE99A87C641"), new Guid("374DE290-123F-4565-9164-39C4925E467B"),
      new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7"), new Guid("33E28130-4E1E-4676-835A-98395C3BC3BB"),
      new Guid("4BD8D571-6D19-48D3-BE97-422220080E43"), new Guid("18989B1D-99B5-455B-841C-AB7C74E4DDFC"),
      new Guid("A52BBA46-E9E1-435f-B3D9-28DAA648C0F6"), new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173"),
      new Guid("AE50C081-EBD2-438A-8655-8A092E34987A")
    };
    const int DriveCapMs = 1500;

    static string Roots(Dictionary<string, object> req, ref object result) {
      result = FilesDefer.Run(req, "mantle-files-roots", delegate (out object res) {
        res = Json.Obj("known", KnownFolders(), "drives", Drives(), "network", NetworkShortcuts());
        return null;
      });
      return null;
    }

    static List<object> KnownFolders() {
      var list = new List<object>();
      for (int i = 0; i < KnownKeys.Length; i++) {
        Guid g = KnownIds[i];
        IntPtr p;
        // KF_FLAG_DONT_VERIFY: a redirected folder on an offline share must not stall this.
        if (FN.SHGetKnownFolderPath(ref g, 0x4000, IntPtr.Zero, out p) != 0 || p == IntPtr.Zero) continue;
        string path;
        try { path = Marshal.PtrToStringUni(p); } finally { FN.CoTaskMemFree(p); }
        if (string.IsNullOrEmpty(path)) continue;
        if (FN.GetFileAttributesW(path) == FN.INVALID_FILE_ATTRIBUTES) continue;   // only folders that exist
        list.Add(Json.Obj("key", KnownKeys[i], "path", path));
      }
      return list;
    }

    sealed class DriveSlot {
      public string Path, Type, Label = "", Fs = "", Why = "";
      public long Total, Free;
      public bool Ready;
      public volatile bool Done;
    }

    /// One thread per drive, all capped by ONE shared 1.5 s deadline: a mapped drive whose server
    /// is gone blocks GetDiskFreeSpaceEx for the SMB timeout, and it must cost this answer
    /// 1.5 s at most (ready:false), never the whole nav pane.
    static List<object> Drives() {
      var slots = new List<DriveSlot>();
      DriveInfo[] all;
      try { all = DriveInfo.GetDrives(); } catch (Exception) { all = new DriveInfo[0]; }
      foreach (DriveInfo di in all) {
        var s = new DriveSlot();
        s.Path = di.Name;
        switch (di.DriveType) {
          case DriveType.Fixed: s.Type = "fixed"; break;
          case DriveType.Removable: s.Type = "removable"; break;
          case DriveType.Network: s.Type = "network"; break;
          case DriveType.CDRom: s.Type = "cdrom"; break;
          case DriveType.Ram: s.Type = "ram"; break;
          default: s.Type = "unknown"; break;
        }
        slots.Add(s);
        DriveInfo d = di;
        DriveSlot slot = s;
        var t = new Thread(delegate () {
          try {
            slot.Ready = d.IsReady;
            if (slot.Ready) {
              try { slot.Label = d.VolumeLabel ?? ""; } catch (Exception) { }
              try { slot.Fs = d.DriveFormat ?? ""; } catch (Exception) { }
              slot.Total = d.TotalSize;
              slot.Free = d.AvailableFreeSpace;
            } else slot.Why = "not ready";
          } catch (Exception ex) { slot.Ready = false; slot.Why = "could not be read (" + ex.GetType().Name + ")"; }
          slot.Done = true;
        });
        t.IsBackground = true;
        t.Name = "mantle-files-drive";
        t.Start();
      }
      long deadline = Stopwatch.GetTimestamp() + DriveCapMs * Freq / 1000;
      var list = new List<object>();
      foreach (DriveSlot s in slots) {
        while (!s.Done && Stopwatch.GetTimestamp() < deadline) Thread.Sleep(5);
        if (!s.Done) list.Add(Json.Obj("path", s.Path, "label", "", "fs", "", "type", s.Type, "total", 0, "free", 0,
                                        "ready", false, "why", "did not answer in 1.5 s"));
        else list.Add(Json.Obj("path", s.Path, "label", s.Label, "fs", s.Fs, "type", s.Type, "total", s.Total, "free", s.Free,
                               "ready", s.Ready, "why", s.Why));
      }
      return list;
    }

    /// "Network Shortcuts" = %APPDATA%\Microsoft\Windows\Network Shortcuts: folder shortcuts (a
    /// folder holding target.lnk) and plain .lnk files. Only entries with a file-system target
    /// are listed; an FTP/web one has none and the page could not open it.
    static List<object> NetworkShortcuts() {
      var list = new List<object>();
      string dir;
      try {
        dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                           "Microsoft\\Windows\\Network Shortcuts");
        if (!Directory.Exists(dir)) return list;
        FN.WIN32_FIND_DATAW unused;
        foreach (string sub in Directory.GetDirectories(dir)) {
          string lnk = Path.Combine(sub, "target.lnk");
          if (!File.Exists(lnk)) continue;
          string target = LinkTarget(lnk, false, out unused);
          if (!string.IsNullOrEmpty(target)) list.Add(Json.Obj("label", Path.GetFileName(sub), "path", target));
        }
        foreach (string lnk in Directory.GetFiles(dir, "*.lnk")) {
          string target = LinkTarget(lnk, false, out unused);
          if (!string.IsNullOrEmpty(target)) list.Add(Json.Obj("label", Path.GetFileNameWithoutExtension(lnk), "path", target));
        }
      } catch (Exception ex) {
        Program.EmitLog("warn", "files.roots: the Network Shortcuts folder could not be read (" + ex.GetType().Name +
                                "), " + list.Count + " entries listed");
      }
      return list;
    }
  }
}
