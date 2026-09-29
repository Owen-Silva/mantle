// FilesGuard.cs - the one gate every Mantle Files write goes through (lane files, 2026-09-28).
//
// WHY it exists: every test sidecar runs --passive, and Owen's rule is that tests NEVER touch his
// real files. A live sidecar IS the Explorer replacement, so it writes wherever he points it; a
// passive one writes only inside a sandbox the test names, and a bug anywhere in a test (a wrong
// path, a `..`, a junction) must land on this refusal instead of on his Documents.
//
// The rule (contract, "Guard"):
//   live (not --passive)       every write allowed.
//   passive                    a write is allowed ONLY when env MANTLE_FILES_SANDBOX names a root
//                              that is absolute, under Path.GetTempPath(), has a path segment named
//                              `sandbox`, and exists - AND every path the write touches is inside
//                              that root, twice over:
//                                1. lexically, after GetFullPath (so `..` cannot climb out),
//                                   case-insensitive, trailing-slash safe;
//                                2. physically: the nearest EXISTING ancestor's final path
//                                   (GetFinalPathNameByHandle, following junctions and symlinks)
//                                   is inside the root's own final path, so a junction planted in
//                                   the sandbox cannot point a write at the real disk.
//                              A file with more than one hard link is refused too: overwriting it
//                              would change its twin, which may live anywhere on the volume.
//   passive, always refused    shell verbs, Open with, the Open with dialog, clipboard writes and
//                              emptying the Recycle Bin: none of those can be confined to a folder.
//
// Callers MUST use the normalised path Check() hands back for the operation itself: the path that
// was checked is the path that gets written, never a re-parse of the caller's string.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using FN = Mantle.FilesNative;

namespace Mantle {
  static class FilesGuard {
    public const string EnvVar = "MANTLE_FILES_SANDBOX";
    /// The contract's words; a test matches the FeatureTable.PassiveRefusal prefix.
    public const string Refusal = FeatureTable.PassiveRefusal + ": outside the files test sandbox";

    /// Null when this write may go ahead (live, or passive with every path inside the sandbox);
    /// otherwise the refusal. `full` gets the normalised paths, in order, for the caller to use.
    /// The refusal never names a path: main logs it.
    public static string Check(IList<string> paths, out List<string> full) {
      full = new List<string>();
      foreach (string p in paths) {
        string f = Normalise(p);
        if (f == null) return "files: a path is not an absolute local or network path";
        full.Add(f);
      }
      if (!Program.Passive) return null;
      string root, rootFinal;
      string why = SandboxRoot(out root, out rootFinal);
      if (why != null) return Refusal + " (" + why + ")";
      foreach (string f in full) {
        if (!Inside(root, f)) return Refusal;
        string anc = NearestExisting(f);
        if (anc == null) return Refusal + " (no part of a path exists)";
        string fin = FinalPath(anc);
        if (fin == null) return Refusal + " (a path could not be resolved)";
        if (!Inside(rootFinal, fin)) return Refusal + " (a link inside the sandbox points out of it)";
        if (string.Equals(anc, f, StringComparison.OrdinalIgnoreCase) && LinkCount(f) > 1)
          return Refusal + " (a file with several hard links could change its twin outside)";
      }
      return null;
    }

    public static string Check(string path, out string full) {
      List<string> all;
      string err = Check(new List<string> { path }, out all);
      full = all.Count > 0 ? all[0] : null;
      return err;
    }

    /// The writes a test sidecar NEVER does, sandbox or not: they reach outside any folder
    /// (another app, the shared clipboard, the whole Recycle Bin).
    public static string AlwaysRefusedInPassive(string what) {
      if (!Program.Passive) return null;
      return FeatureTable.PassiveRefusal + ": " + what + " is never run by a test sidecar";
    }

    /// GetFullPath resolves `.`/`..`, forward slashes, and Win32's trailing dot/space trimming,
    /// exactly as the file system will see the name. Only absolute drive or UNC paths qualify;
    /// device paths (\\?\, \\.\) and alternate data streams (a second ':') never do.
    public static string Normalise(string p) {
      if (string.IsNullOrEmpty(p) || p.Length > 32000) return null;
      if (p.IndexOf('\0') >= 0) return null;
      if (p.StartsWith("\\\\?\\", StringComparison.Ordinal) || p.StartsWith("\\\\.\\", StringComparison.Ordinal)) return null;
      if (p.StartsWith("//", StringComparison.Ordinal)) return null;
      bool drive = p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/');
      bool unc = p.StartsWith("\\\\", StringComparison.Ordinal);
      if (!drive && !unc) return null;
      if (p.IndexOf(':', 2) >= 0) return null;
      string f;
      try { f = Path.GetFullPath(p); } catch (Exception) { return null; }
      if (f.Length > 3) f = f.TrimEnd('\\');
      return f;
    }

    /// Validates the env root; null when usable, else a name-free reason.
    static string SandboxRoot(out string root, out string rootFinal) {
      root = null; rootFinal = null;
      string env = Environment.GetEnvironmentVariable(EnvVar);
      if (string.IsNullOrEmpty(env)) return EnvVar + " is not set";
      string r = Normalise(env);
      if (r == null || r.StartsWith("\\\\", StringComparison.Ordinal)) return EnvVar + " is not an absolute local path";
      string temp = Normalise(Path.GetTempPath());
      if (temp == null) return "the temp folder could not be read";
      if (!Inside(temp, r) || string.Equals(temp, r, StringComparison.OrdinalIgnoreCase))
        return EnvVar + " is not under the temp folder";
      bool seg = false;
      foreach (string s in r.Split('\\')) if (string.Equals(s, "sandbox", StringComparison.OrdinalIgnoreCase)) seg = true;
      if (!seg) return EnvVar + " has no path segment named sandbox";
      if (!Directory.Exists(r)) return EnvVar + " does not exist";
      // The root itself may not be a link out of temp: compare the physical paths too.
      string rf = FinalPath(r), tf = FinalPath(temp);
      if (rf == null || tf == null) return "the sandbox could not be resolved";
      if (!Inside(tf, rf) || string.Equals(tf, rf, StringComparison.OrdinalIgnoreCase))
        return EnvVar + " resolves outside the temp folder";
      root = r; rootFinal = rf;
      return null;
    }

    /// `p` equals `root` or sits below it. Both are normalised (no trailing backslash except a
    /// bare drive root), so "...\sandbox2" can never pass as inside "...\sandbox".
    public static bool Inside(string root, string p) {
      if (root == null || p == null) return false;
      if (string.Equals(root, p, StringComparison.OrdinalIgnoreCase)) return true;
      string pre = root.EndsWith("\\", StringComparison.Ordinal) ? root : root + "\\";
      return p.StartsWith(pre, StringComparison.OrdinalIgnoreCase);
    }

    static string NearestExisting(string f) {
      string cur = f;
      while (!string.IsNullOrEmpty(cur)) {
        if (FN.GetFileAttributesW(cur) != FN.INVALID_FILE_ATTRIBUTES) return cur;
        string up;
        try { up = Path.GetDirectoryName(cur); } catch (Exception) { return null; }
        if (up == null || up.Length >= cur.Length) return null;
        cur = up;
      }
      return null;
    }

    const uint FILE_READ_ATTRIBUTES = 0x80;
    const uint SHARE_ALL = 0x1 | 0x2 | 0x4;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;   // lets CreateFile open a directory

    /// The physical path after every junction and symlink, "C:\..." form (or \\server\share\...).
    /// Null when it cannot be opened: the caller refuses (fail closed).
    public static string FinalPath(string p) {
      IntPtr h = FN.CreateFileW(p, FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
                                FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
      if (h == FN.INVALID_HANDLE_VALUE || h == IntPtr.Zero) return null;
      try {
        var sb = new StringBuilder(1024);
        uint n = FN.GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
        if (n >= sb.Capacity) { sb = new StringBuilder((int)n + 2); n = FN.GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); }
        if (n == 0 || n >= sb.Capacity) return null;
        string s = sb.ToString();
        if (s.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) s = "\\\\" + s.Substring(8);
        else if (s.StartsWith("\\\\?\\", StringComparison.Ordinal)) s = s.Substring(4);
        if (s.Length > 3) s = s.TrimEnd('\\');
        return s;
      } finally { FN.CloseHandle(h); }
    }

    static int LinkCount(string p) {
      IntPtr h = FN.CreateFileW(p, FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
                                FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
      if (h == FN.INVALID_HANDLE_VALUE || h == IntPtr.Zero) return 0;
      try {
        FN.BY_HANDLE_FILE_INFORMATION info;
        if (!FN.GetFileInformationByHandle(h, out info)) return 0;
        if ((info.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0) return 1;
        return (int)info.nNumberOfLinks;
      } finally { FN.CloseHandle(h); }
    }

    /// A plain file name for rename / new folder / new file: no separators, no wildcard or device
    /// characters, not "." or "..". Anything else could smuggle a path past the parent check.
    public static bool PlainName(string name) {
      if (string.IsNullOrEmpty(name) || name.Length > 255) return false;
      if (name == "." || name == "..") return false;
      if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
      if (name.IndexOfAny(new char[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }) >= 0) return false;
      if (name.TrimEnd(' ', '.').Length == 0) return false;
      return true;
    }
  }
}
