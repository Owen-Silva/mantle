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
//
// Hardened 2026-09-29 (lane files-sc, adversarial pass; every hole below was PROVEN on the old build
// against harmless scratch and has a test in test-files.js):
//   - a folder MERGE (copy/move with replace onto an existing folder) wrote THROUGH a junction or a
//     hard link hidden deeper in the existing destination: CheckSubtree() now walks that tree.
//   - a sandbox root that is itself a junction to another temp folder was accepted: the root's
//     physical path must now carry the `sandbox` segment too.
//   - Path.GetFullPath (legacy .NET: no long paths) refused every path over 260 characters as
//     "not an absolute path", live too; Win32 GetFullPathNameW does the same normalisation the file
//     system does, at any length, and every physical check uses the \\?\ form so it sees long paths.
//   - reserved device names (CON, AUX, COM1, ...) and names ending in a space or a dot were accepted
//     and made files most apps cannot open or delete; NameProblem() refuses them, in words.
// NOT covered (honest limit): a link swapped in by another process BETWEEN this check and the
// engine's write. The guard is a net for test mistakes, not a wall against a concurrent attacker
// who already has the same user rights (and could write outside directly).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
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
        if (f == null) return "files: " + PathProblem(p);
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFullPathNameW(string name, uint len, StringBuilder buf, IntPtr filePart);

    /// Win32's own GetFullPathNameW resolves `.`/`..`, forward slashes, and the trailing dot/space
    /// trimming, exactly as the file system will see the name, at ANY length (Path.GetFullPath in
    /// this legacy-path .NET threw past 260). Only absolute drive or UNC paths qualify; device paths
    /// (\\?\, \\.\, or a name like NUL that Win32 turns into one) and alternate data streams (a
    /// second ':') never do.
    public static string Normalise(string p) {
      if (string.IsNullOrEmpty(p) || p.Length > 32000) return null;
      if (p.IndexOf('\0') >= 0) return null;
      if (p.StartsWith("\\\\?\\", StringComparison.Ordinal) || p.StartsWith("\\\\.\\", StringComparison.Ordinal)) return null;
      if (p.StartsWith("//", StringComparison.Ordinal)) return null;
      bool drive = p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/');
      bool unc = p.StartsWith("\\\\", StringComparison.Ordinal);
      if (!drive && !unc) return null;
      if (p.IndexOf(':', 2) >= 0) return null;
      string f = FullPath(p);
      if (f == null) return null;
      if (f.StartsWith("\\\\?\\", StringComparison.Ordinal) || f.StartsWith("\\\\.\\", StringComparison.Ordinal)) return null;
      if (f.IndexOf(':', 2) >= 0) return null;
      bool fDrive = f.Length >= 3 && char.IsLetter(f[0]) && f[1] == ':' && f[2] == '\\';
      if (!fDrive && !f.StartsWith("\\\\", StringComparison.Ordinal)) return null;
      if (f.Length > 3) f = f.TrimEnd('\\');
      return f;
    }

    static string FullPath(string p) {
      var sb = new StringBuilder(Math.Max(p.Length + 16, 300));
      uint n = GetFullPathNameW(p, (uint)sb.Capacity, sb, IntPtr.Zero);
      if (n >= sb.Capacity) { sb = new StringBuilder((int)n + 2); n = GetFullPathNameW(p, (uint)sb.Capacity, sb, IntPtr.Zero); }
      if (n == 0 || n >= sb.Capacity) return null;
      return sb.ToString();
    }

    /// Why Normalise refused `p`, in words, never naming it.
    public static string PathProblem(string p) {
      if (string.IsNullOrEmpty(p)) return "a path is missing";
      if (p.StartsWith("\\\\?\\", StringComparison.Ordinal) || p.StartsWith("\\\\.\\", StringComparison.Ordinal))
        return "a device path (\\\\?\\ or \\\\.\\) is not accepted; use a normal C:\\ or \\\\server\\share path";
      if (p.Length >= 3 && p.IndexOf(':', 2) >= 0) return "a path names a hidden file stream (a second ':'), which is not accepted";
      bool drive = p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/');
      if (!drive && !p.StartsWith("\\\\", StringComparison.Ordinal)) return "a path is not an absolute local or network path";
      if (p.IndexOf('\0') >= 0 || p.Length > 32000) return "a path is not valid";
      return "a path names a device reserved by Windows (like CON or NUL), not a file";
    }

    /// The \\?\ form of a NORMALISED path: Win32 calls on it work past 260 characters and apply
    /// no further parsing, so they see exactly the path that was checked.
    public static string Ext(string f) {
      if (f == null || f.StartsWith("\\\\?\\", StringComparison.Ordinal)) return f;
      if (f.StartsWith("\\\\", StringComparison.Ordinal)) return "\\\\?\\UNC\\" + f.Substring(2);
      return "\\\\?\\" + (f.Length == 2 ? f + "\\" : f);
    }

    /// Attributes of a normalised path, long paths included; INVALID_FILE_ATTRIBUTES when missing.
    public static uint Attrs(string f) {
      if (f == null) return FN.INVALID_FILE_ATTRIBUTES;
      return FN.GetFileAttributesW(f.Length >= 248 ? Ext(f) : f);
    }

    /// Passive only: before a folder MERGE (copy / move / restore onto an existing folder), every
    /// entry of the existing destination tree must be a plain file or folder: the engine writes
    /// into that tree, so a junction or symlink deep inside it would carry the write out of the
    /// sandbox, and a file with a hard-link twin would change the twin. Null = safe.
    public const int SubtreeCap = 50000;
    public static string CheckSubtree(string dir) {
      if (!Program.Passive) return null;
      var stack = new Stack<string>();
      stack.Push(dir);
      int seen = 0;
      while (stack.Count > 0) {
        string d = stack.Pop();
        FN.WIN32_FIND_DATAW f;
        IntPtr h = FN.FindFirstFileExW(Ext(d) + "\\*", FN.FindExInfoBasic, out f, FN.FindExSearchNameMatch, IntPtr.Zero, 0);
        if (h == FN.INVALID_HANDLE_VALUE) {
          if (Marshal.GetLastWin32Error() == 2) continue;
          return Refusal + " (a folder the merge would write into could not be read)";
        }
        try {
          do {
            string n = f.cFileName;
            if (n == "." || n == "..") continue;
            if (++seen > SubtreeCap) return Refusal + " (the folder the merge would write into is too big to verify)";
            string p = d + "\\" + n;
            if ((f.dwFileAttributes & FN.FILE_ATTRIBUTE_REPARSE_POINT) != 0)
              return Refusal + " (a link inside the folder the merge would write into points elsewhere)";
            if ((f.dwFileAttributes & FN.FILE_ATTRIBUTE_DIRECTORY) != 0) stack.Push(p);
            else if (LinkCount(p) > 1) return Refusal + " (a file with several hard links could change its twin outside)";
          } while (FN.FindNextFileW(h, out f));
        } finally { FN.FindClose(h); }
      }
      return null;
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
      if (!HasSandboxSegment(r)) return EnvVar + " has no path segment named sandbox";
      uint ra = FN.GetFileAttributesW(Ext(r));
      if (ra == FN.INVALID_FILE_ATTRIBUTES || (ra & FN.FILE_ATTRIBUTE_DIRECTORY) == 0) return EnvVar + " does not exist";
      // The root itself may not be a link out of temp: compare the physical paths too. And the
      // PHYSICAL root must be a sandbox as well: a junction named `sandbox` that points at some
      // other temp folder was accepted before 2026-09-29 and let writes land there.
      string rf = FinalPath(r), tf = FinalPath(temp);
      if (rf == null || tf == null) return "the sandbox could not be resolved";
      if (!Inside(tf, rf) || string.Equals(tf, rf, StringComparison.OrdinalIgnoreCase))
        return EnvVar + " resolves outside the temp folder";
      if (!HasSandboxSegment(rf)) return EnvVar + " is a link to a folder that is not a sandbox";
      root = r; rootFinal = rf;
      return null;
    }

    static bool HasSandboxSegment(string p) {
      foreach (string s in p.Split('\\')) if (string.Equals(s, "sandbox", StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    }

    /// `p` equals `root` or sits below it. Both are normalised (no trailing backslash except a
    /// bare drive root), so "...\sandbox2" can never pass as inside "...\sandbox".
    public static bool Inside(string root, string p) {
      if (root == null || p == null) return false;
      if (string.Equals(root, p, StringComparison.OrdinalIgnoreCase)) return true;
      string pre = root.EndsWith("\\", StringComparison.Ordinal) ? root : root + "\\";
      return p.StartsWith(pre, StringComparison.OrdinalIgnoreCase);
    }

    /// String-only parent of a normalised path (Path.GetDirectoryName throws past 260 here);
    /// null at a drive root or a bare \\server\share.
    public static string Parent(string f) {
      if (f == null) return null;
      int i = f.LastIndexOf('\\');
      if (i < 0) return null;
      if (f.StartsWith("\\\\", StringComparison.Ordinal)) {
        int share = f.IndexOf('\\', 2);
        share = share < 0 ? -1 : f.IndexOf('\\', share + 1);
        if (share < 0 || i <= share) return null;
        return f.Substring(0, i);
      }
      if (i == 2 && f.Length == 3) return null;          // "C:\"
      return i == 2 ? f.Substring(0, 3) : f.Substring(0, i);
    }

    static string NearestExisting(string f) {
      string cur = f;
      while (!string.IsNullOrEmpty(cur)) {
        if (FN.GetFileAttributesW(Ext(cur)) != FN.INVALID_FILE_ATTRIBUTES) return cur;
        string up = Parent(cur);
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
      IntPtr h = FN.CreateFileW(Ext(p), FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
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
      IntPtr h = FN.CreateFileW(Ext(p), FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
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
    public static bool PlainName(string name) { return NameProblem(name) == null; }

    static readonly string[] Devices = { "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$" };

    /// Null for a name Explorer itself would accept; otherwise the reason in plain words (the
    /// same rules File Explorer applies, so nothing Mantle makes is a file other apps choke on).
    public static string NameProblem(string name) {
      if (string.IsNullOrEmpty(name) || name.TrimEnd(' ', '.').Length == 0) return "a name cannot be empty";
      if (name == "." || name == "..") return "a name cannot be . or ..";
      if (name.Length > 255) return "a name can be at most 255 characters";
      if (name.IndexOfAny(new char[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }) >= 0)
        return "a name cannot contain any of \\ / : * ? \" < > |";
      if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return "a name cannot contain control characters";
      if (name.EndsWith(" ", StringComparison.Ordinal) || name.EndsWith(".", StringComparison.Ordinal))
        return "a name cannot end with a space or a dot";
      // Win32 reserves these device names, with any extension and any case ("con.txt", "COM1.log");
      // the stem is what comes before the first dot, trailing spaces ignored.
      string stem = name;
      int dot = stem.IndexOf('.');
      if (dot >= 0) stem = stem.Substring(0, dot);
      stem = stem.TrimEnd(' ').ToUpperInvariant();
      bool dev = Array.IndexOf(Devices, stem) >= 0;
      if (!dev && stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal))) {
        char c = stem[3];
        dev = (c >= '0' && c <= '9') || c == '¹' || c == '²' || c == '³';
      }
      if (dev) return "that name is reserved by Windows (CON, PRN, AUX, NUL, COM1-9 and LPT1-9 cannot be used)";
      return null;
    }
  }
}
