// SysStorageFiles.cs - the file-system half of Settings > System > Storage (lane storage, 2026-09-29):
// a fast folder walker, the cleanup kinds' FIXED folders and rules, and the ONE place Mantle deletes
// anything (StorageFiles.Delete), behind a path guard. SysStorage.cs is the command half.
//
// WHY its own walker: the category scan walks the whole Windows folder. DirectoryInfo allocates per
// file and follows junctions (double counting, loops); this uses FindFirstFileExW with basic info and
// FIND_FIRST_EX_LARGE_FETCH, never enters a reparse point (a junction or link counts 0), and counts a
// cloud-only placeholder (a OneDrive file that is not on this PC) as 0 bytes, like Windows does.
//
// THE DELETE RULES (binding; test-sysstorage.js proves them in a sandbox, never on Owen's files):
//   - Delete() takes the files AND the allowed roots. Every file passes Inside(): a plain full local
//     path (no "..", no ".", no stream, no odd characters), under one allowed root that is at least
//     three levels deep (never a drive or C:\Windows itself), and NO link or junction anywhere from the
//     root down to the file - a junction inside a temp folder cannot lead a cleanup out of it;
//   - a file is deleted only if it still has the size and last-write time the plan saw (else "changed");
//   - a file in use or refused by Windows is skipped and counted; nothing is retried, forced or unlocked;
//   - Downloads never deletes: its entries go to the Recycle Bin (SHFileOperation FOF_ALLOWUNDO).
//
// PRIVACY: nothing here logs. Reasons carry counts and codes, never a path or a name.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  /// One file (or, for Downloads, one top-level entry) a plan would remove, as the plan saw it.
  sealed class StorageTarget {
    public string Path;
    public long Size;
    public long WriteTicks;   // UTC FILETIME ticks
    public bool IsDir;
  }

  /// A walk's running totals and hooks. Stop is polled between entries.
  sealed class StorageWalk {
    public long Bytes, Files, Dirs, Denied, Links, CloudOnly;
    public Func<bool> Stop;
    public Action<string, long, long, long> OnFile;   // full path, size, last write, creation (UTC FILETIME)
    public Action Tick;                               // every 2048 entries
    public HashSet<string> Skip;                      // folders (upper case) not to enter
    int _n;
    internal void Count() { if (Tick != null && (++_n & 2047) == 0) Tick(); }
  }

  /// What one Delete() did.
  sealed class StorageDeleted {
    public int Removed, Skipped, Refused, Changed, Gone;
    public long Freed;
    public string FirstRefusal;
    public void Add(StorageDeleted o) {
      Removed += o.Removed; Skipped += o.Skipped; Refused += o.Refused; Changed += o.Changed; Gone += o.Gone; Freed += o.Freed;
      if (FirstRefusal == null) FirstRefusal = o.FirstRefusal;
    }
    public IDictionary Json() {
      return Mantle.Json.Obj("removed", Removed, "freed", Freed, "skipped", Skipped, "changed", Changed, "gone", Gone,
                             "refused", Refused, "refusedWhy", FirstRefusal);
    }
  }

  static class StorageFiles {
    public const uint A_READONLY = 0x1, A_DIR = 0x10, A_REPARSE = 0x400, A_OFFLINE = 0x1000, A_RECALL_OPEN = 0x40000, A_RECALL_DATA = 0x400000;
    public const string GONE = "gone";
    static readonly IntPtr INVALID = new IntPtr(-1);
    const uint NO_ATTR = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FIND_DATA {
      public uint Attr;
      public uint CLow, CHigh, ALow, AHigh, WLow, WHigh;
      public uint SizeHigh, SizeLow, R0, R1;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string Alt;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ATTR_DATA {
      public uint Attr;
      public uint CLow, CHigh, ALow, AHigh, WLow, WHigh;
      public uint SizeHigh, SizeLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT {
      public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
      public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
    }

    static class Native {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern IntPtr FindFirstFileExW(string name, int level, out FIND_DATA data, int op, IntPtr filter, int flags);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern bool FindNextFileW(IntPtr h, out FIND_DATA data);
      [DllImport("kernel32.dll")] public static extern bool FindClose(IntPtr h);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern uint GetFileAttributesW(string name);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern bool GetFileAttributesExW(string name, int level, out ATTR_DATA data);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern bool DeleteFileW(string name);
      [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
      public static extern int SHFileOperationW(ref SHFILEOPSTRUCT op);
      [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
      public static extern int SHQueryRecycleBinW(string root, IntPtr info);
      [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
      public static extern int SHEmptyRecycleBinW(IntPtr hwnd, string root, uint flags);
      [DllImport("shell32.dll")]
      public static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);
    }

    /// The \\?\ form, so paths past 260 characters still work.
    public static string Long(string p) {
      if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p;
      if (p.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + p.Substring(2);
      return @"\\?\" + p;
    }

    static long FT(uint lo, uint hi) { return ((long)hi << 32) | lo; }

    /// Attributes of a path, or NO_ATTR (0xFFFFFFFF) when it cannot be read.
    public static uint Attr(string p) { return Native.GetFileAttributesW(Long(p)); }
    public static bool Exists(string p) { return Attr(p) != NO_ATTR; }

    // ------------------------------------------------------------------ known folders
    public static readonly Guid Documents = new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7");
    public static readonly Guid Pictures = new Guid("33E28130-4E1E-4676-835A-98395C3BC3BB");
    public static readonly Guid Videos = new Guid("18989B1D-99B5-455B-841C-AB7C74E4DDFC");
    public static readonly Guid Music = new Guid("4BD8D571-6D19-48D3-BE97-422220080E43");
    public static readonly Guid Downloads = new Guid("374DE290-123F-4565-9164-39C4925E467B");
    public static readonly Guid Desktop = new Guid("B4BFCC3A-DB2C-424C-B029-7FE99A87C641");
    public static readonly Guid LocalAppData = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
    public static readonly Guid UserPrograms = new Guid("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB");
    public static readonly Guid Profile = new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173");

    /// A known folder's path (redirections and OneDrive moves included), or null.
    public static string Known(Guid id) {
      IntPtr p;
      if (Native.SHGetKnownFolderPath(id, 0, IntPtr.Zero, out p) != 0) return null;
      try { string s = Marshal.PtrToStringUni(p); return string.IsNullOrEmpty(s) ? null : s.TrimEnd('\\'); }
      finally { Marshal.FreeCoTaskMem(p); }
    }

    public static string WindowsDir() { return Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\'); }
    /// "C:" - the drive Windows runs from.
    public static string SystemDrive() { return WindowsDir().Substring(0, 2).ToUpperInvariant(); }

    // ------------------------------------------------------------------ walking
    /// Walks `root` (recursively, or only `pattern` at its top), counting into `w`.
    public static void Walk(string root, StorageWalk w, bool recurse, string pattern) {
      root = root.TrimEnd('\\');
      uint ra = Attr(root.Length == 2 ? root + "\\" : root);
      if (ra == NO_ATTR) { if (Marshal.GetLastWin32Error() == 5) w.Denied++; return; }
      if ((ra & A_REPARSE) != 0 && root.Length > 3) { w.Links++; return; }
      var stack = new Stack<string>();
      stack.Push(root);
      while (stack.Count > 0) {
        if (w.Stop != null && w.Stop()) return;
        string dir = stack.Pop();
        FIND_DATA fd;
        IntPtr h = Native.FindFirstFileExW(Long(dir) + "\\" + (pattern ?? "*"), 1, out fd, 0, IntPtr.Zero, 2);
        if (h == INVALID) {
          int e = Marshal.GetLastWin32Error();
          if (e != 2 && e != 3 && e != 18) w.Denied++;   // not found / no match is not "denied"
          continue;
        }
        w.Dirs++;
        try {
          do {
            string n = fd.Name;
            if (n == "." || n == "..") continue;
            w.Count();
            if ((fd.Attr & A_DIR) != 0) {
              if ((fd.Attr & A_REPARSE) != 0) { w.Links++; continue; }
              if (!recurse) continue;
              string sub = dir + "\\" + n;
              if (w.Skip != null && w.Skip.Contains(sub.ToUpperInvariant())) continue;
              stack.Push(sub);
              continue;
            }
            if ((fd.Attr & A_REPARSE) != 0) { w.Links++; continue; }
            w.Files++;
            if ((fd.Attr & (A_OFFLINE | A_RECALL_DATA | A_RECALL_OPEN)) != 0) { w.CloudOnly++; continue; }
            long size = FT(fd.SizeLow, fd.SizeHigh);
            w.Bytes += size;
            if (w.OnFile != null) w.OnFile(dir + "\\" + n, size, FT(fd.WLow, fd.WHigh), FT(fd.CLow, fd.CHigh));
          } while (Native.FindNextFileW(h, out fd) && !(w.Stop != null && w.Stop()));
        } finally { Native.FindClose(h); }
      }
    }

    /// The top-level entries of a folder (files and real folders, links skipped), each sized.
    public static List<StorageTarget> TopEntries(string root, StorageWalk total, Func<bool> stop) {
      var list = new List<StorageTarget>();
      FIND_DATA fd;
      IntPtr h = Native.FindFirstFileExW(Long(root) + "\\*", 1, out fd, 0, IntPtr.Zero, 2);
      if (h == INVALID) {
        int e = Marshal.GetLastWin32Error();
        if (e != 2 && e != 3 && e != 18) total.Denied++;
        return list;
      }
      try {
        do {
          string n = fd.Name;
          if (n == "." || n == "..") continue;
          if ((fd.Attr & A_REPARSE) != 0) { total.Links++; continue; }
          string p = root + "\\" + n;
          if ((fd.Attr & A_DIR) != 0) {
            var w = new StorageWalk { Stop = stop };
            Walk(p, w, true, null);
            total.Bytes += w.Bytes; total.Files += w.Files; total.Denied += w.Denied; total.Links += w.Links; total.CloudOnly += w.CloudOnly;
            list.Add(new StorageTarget { Path = p, Size = w.Bytes, IsDir = true });
          } else {
            long size = FT(fd.SizeLow, fd.SizeHigh);
            bool cloud = (fd.Attr & (A_OFFLINE | A_RECALL_DATA | A_RECALL_OPEN)) != 0;
            total.Files++;
            if (cloud) total.CloudOnly++; else total.Bytes += size;
            list.Add(new StorageTarget { Path = p, Size = cloud ? 0 : size, WriteTicks = FT(fd.WLow, fd.WHigh) });
          }
        } while (Native.FindNextFileW(h, out fd) && !(stop != null && stop()));
      } finally { Native.FindClose(h); }
      return list;
    }

    // ------------------------------------------------------------------ the guard
    static readonly char[] BadChars = { '/', ':', '*', '?', '"', '<', '>', '|' };

    /// null = `path` may be touched under one of `roots`; GONE = it is not there any more; else the
    /// plain-words reason it is refused (never the path itself).
    public static string Inside(string path, IList<string> roots) {
      string why = Plain(path);
      if (why != null) return why;
      string root = null;
      if (roots != null) foreach (string r0 in roots) {
        if (r0 == null) continue;
        string r = r0.TrimEnd('\\');
        if (Plain(r) != null || r.Split('\\').Length < 3) continue;          // never a drive or a top folder
        if (path.Length > r.Length + 1 && path[r.Length] == '\\' &&
            string.Compare(path, 0, r, 0, r.Length, StringComparison.OrdinalIgnoreCase) == 0) { root = r; break; }
      }
      if (root == null) return "outside the folders this cleanup may touch";
      uint a = Attr(root);
      if (a == NO_ATTR) return GONE;
      if ((a & A_REPARSE) != 0) return "the cleanup folder is itself a link";
      string cur = root;
      foreach (string s in path.Substring(root.Length + 1).Split('\\')) {
        cur = cur + "\\" + s;
        a = Attr(cur);
        if (a == NO_ATTR) return GONE;
        if ((a & A_REPARSE) != 0) return "a link or junction sits on the way to the file";
      }
      return null;
    }

    /// A plain full local path: "X:\a\b", no empty, "." or ".." parts, no stream or wildcard.
    public static string Plain(string path) {
      if (string.IsNullOrEmpty(path) || path.Length > 32000 || path.IndexOf('\0') >= 0) return "not a usable path";
      string[] segs = path.Split('\\');
      if (segs.Length < 2 || segs[0].Length != 2 || segs[0][1] != ':' || !char.IsLetter(segs[0][0])) return "not a full local path";
      for (int i = 1; i < segs.Length; i++) {
        string s = segs[i];
        if (s.Length == 0) return "an empty part in the path";
        if (s == "." || s == "..") return "a path that climbs with . or ..";
        if (s.IndexOfAny(BadChars) >= 0) return "a character Windows does not allow in a name";
        if (s.EndsWith(".", StringComparison.Ordinal) || s.EndsWith(" ", StringComparison.Ordinal)) return "a name ending in a dot or a space";
      }
      return null;
    }

    // ------------------------------------------------------------------ deleting
    /// THE only delete in Mantle's storage code. Each target: guard, unchanged-since-plan check, then
    /// DeleteFile (or the Recycle Bin when `recycle`). Never forces, never retries.
    public static StorageDeleted Delete(IList<StorageTarget> list, IList<string> roots, bool recycle, Func<bool> stop, Action<StorageDeleted> tick) {
      var r = new StorageDeleted();
      int n = 0;
      foreach (StorageTarget t in list) {
        if (stop != null && stop()) break;
        if (tick != null && (++n & 255) == 0) tick(r);
        string g = Inside(t.Path, roots);
        if (g == GONE) { r.Gone++; continue; }
        if (g != null) { r.Refused++; if (r.FirstRefusal == null) r.FirstRefusal = g; continue; }
        if (!t.IsDir) {
          ATTR_DATA fa;
          if (!Native.GetFileAttributesExW(Long(t.Path), 0, out fa)) { r.Gone++; continue; }
          if ((fa.Attr & A_DIR) != 0) { r.Changed++; continue; }
          if (FT(fa.SizeLow, fa.SizeHigh) != t.Size || FT(fa.WLow, fa.WHigh) != t.WriteTicks) { r.Changed++; continue; }
          if ((fa.Attr & A_READONLY) != 0 && !recycle) { r.Skipped++; continue; }   // read-only: left alone, like Disk Cleanup
        } else if ((Attr(t.Path) & A_DIR) == 0) { r.Changed++; continue; }
        bool ok; int err;
        if (recycle) ok = Recycle(t.Path, out err);
        else { ok = Native.DeleteFileW(Long(t.Path)); err = ok ? 0 : Marshal.GetLastWin32Error(); }
        if (ok) { r.Removed++; r.Freed += t.Size; }
        else if (err == 2 || err == 3) r.Gone++;
        else r.Skipped++;   // 5 denied, 32/33 in use, anything else: left where it is
      }
      if (tick != null) tick(r);
      return r;
    }

    /// One entry to the Recycle Bin. FOF_WANTNUKEWARNING: an entry too big for the bin is NEVER
    /// deleted silently - Windows asks first.
    static bool Recycle(string path, out int err) {
      var op = new SHFILEOPSTRUCT { wFunc = 3 /* FO_DELETE */, pFrom = path + "\0",
        fFlags = (ushort)(0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000) };   // ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI | WANTNUKEWARNING
      err = Native.SHFileOperationW(ref op);
      if (err == 0 && op.fAnyOperationsAborted) err = 1223;   // ERROR_CANCELLED
      return err == 0 && Exists(path) == false;
    }

    // ------------------------------------------------------------------ the Recycle Bin
    /// Items and bytes in the Recycle Bin (`root` "C:\" for one drive, null for all). false = unread.
    public static bool RecycleBin(string root, out long bytes, out long items, out int hr) {
      bytes = 0; items = 0;
      bool x64 = IntPtr.Size == 8;
      int size = x64 ? 24 : 20, off = x64 ? 8 : 4;
      IntPtr p = Marshal.AllocHGlobal(size);
      try {
        for (int i = 0; i < size; i++) Marshal.WriteByte(p, i, 0);
        Marshal.WriteInt32(p, 0, size);
        hr = Native.SHQueryRecycleBinW(root, p);
        if (hr != 0) return false;
        bytes = Marshal.ReadInt64(p, off);
        items = Marshal.ReadInt64(p, off + 8);
        return true;
      } finally { Marshal.FreeHGlobal(p); }
    }

    /// Empties every drive's Recycle Bin with no dialog, progress or sound. null = done.
    public static string EmptyRecycleBin() {
      int hr = Native.SHEmptyRecycleBinW(IntPtr.Zero, null, 0x1 | 0x2 | 0x4);   // NOCONFIRMATION | NOPROGRESSUI | NOSOUND
      if (hr == 0 || hr == unchecked((int)0x8000FFFF) /* E_UNEXPECTED: already empty */) return null;
      return "Windows did not empty the Recycle Bin (0x" + hr.ToString("X8") + ")";
    }
  }
}
