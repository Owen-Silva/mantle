// SpotifyMem.cs - `spotify.mem` and `spotify.trim` (lane sptrim, 2026-09-26): the memory of the
// Spotify that Mantle started HIDDEN, read cheaply every ~30 s and trimmed when it creeps over a
// threshold. The decisions (when, which processes, how often) live in lib/features/_spotify-trim.js;
// this file only reads and trims, and checks every target HERE, on every call, whatever main asked.
//
// THE GUARD (both commands). Only the root pid the caller names (the Spotify.exe Mantle launched) and
// the processes descended from it, and only while each one's image IS %APPDATA%\Spotify\Spotify.exe
// (this sidecar's own APPDATA; compared ignoring case, as Windows compares paths). In this order:
//   1. the Toolhelp list, no handle opened: the pid exists, its file is Spotify.exe, and it is the
//      root or its parent chain reaches the root. Anything else is refused BY NAME right there;
//   2. ONE PROCESS_QUERY_LIMITED_INFORMATION handle: QueryFullProcessImageName must be the expected
//      path; GetProcessTimes says a descendant started after the root (a reused pid is not a child)
//      and the root is the process the caller first saw (`created`, when it passes it back).
// Only a process that passed both is ever opened for more: spotify.trim opens PROCESS_SET_QUOTA |
// QUERY_LIMITED and calls EmptyWorkingSet (its pages go to Windows' standby list; commit unchanged).
// Nothing is suspended, throttled or re-prioritised: Spotify plays the music. gamemode.trim (Mantle's
// own processes only) is a separate command with its own guard and is not used here.
//
// THE READ: GetProcessMemoryInfo(PROCESS_MEMORY_COUNTERS_EX2) on that same QUERY_LIMITED handle:
// WorkingSetSize, PrivateUsage (commit) and PrivateWorkingSetSize, which is the number Task Manager's
// "Memory" column shows. Plus which of the tree's processes own a visible top-level window (the test
// .NET's MainWindowHandle makes: visible and unowned), so main can tell the window was shown. No
// PowerShell and no performance counters: a few milliseconds.
//
// PASSIVE (--test): both commands work, like gamemode.trim, because the guard is the same in both
// modes: they can only ever reach a Spotify.exe under this process's %APPDATA%. The tests
// (sidecar/test-spotifymem.js) start their sidecar with APPDATA pointed at a scratch folder, so the
// only "Spotify.exe" they can reach is a stand-in they started themselves.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class SpotifyMem {
    static class N {
      public const uint TH32CS_SNAPPROCESS = 0x2;
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct PROCESSENTRY32W {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct PMC_EX2 {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                       QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage,
                       PrivateUsage, PrivateWorkingSetSize;
        public ulong SharedCommitUsage;
      }
      public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC_EX2 c, uint size);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool EmptyWorkingSet(IntPtr h);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc fn, IntPtr lParam);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    }

    const uint QUERY_LIMITED = 0x1000, SET_QUOTA = 0x0100, GW_OWNER = 4;
    const int MAX_DEPTH = 6;

    public static void Register(FeatureTable t) {
      t.Add("spotify.mem", Lanes.Slow, Mem);    // {root, created?, exe?, pids?} -> each process's memory, read only
      t.Add("spotify.trim", Lanes.Slow, Trim);  // {root, created?, exe?, pids?, skip?} -> EmptyWorkingSet on the rest
    }

    /// The one path this file ever reaches: %APPDATA%\Spotify\Spotify.exe of THIS process.
    static string ExpectedExe() {
      string ad = Environment.GetEnvironmentVariable("APPDATA");
      return string.IsNullOrEmpty(ad) ? null : Path.Combine(ad, "Spotify", "Spotify.exe");
    }

    sealed class Proc { public uint Pid, Ppid; public string File; }
    sealed class Target { public uint Pid, Ppid; public long Created; }

    static List<Proc> Snapshot(out string err) {
      err = null;
      var list = new List<Proc>();
      IntPtr snap = N.CreateToolhelp32Snapshot(N.TH32CS_SNAPPROCESS, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { err = "Windows would not list the processes (error " + Marshal.GetLastWin32Error() + ")"; return list; }
      try {
        var e = new N.PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(N.PROCESSENTRY32W));
        if (!N.Process32FirstW(snap, ref e)) return list;
        do list.Add(new Proc { Pid = e.th32ProcessID, Ppid = e.th32ParentProcessID, File = e.szExeFile });
        while (N.Process32NextW(snap, ref e));
      } finally { N.CloseHandle(snap); }
      return list;
    }

    static bool IsSpotifyName(string file) { return string.Equals(file, "Spotify.exe", StringComparison.OrdinalIgnoreCase); }

    /// Step 2 of the guard: path and start time from ONE QUERY_LIMITED handle. null = passed.
    static string CheckPath(uint pid, string exe, out long created) {
      created = 0;
      IntPtr h = N.OpenProcess(QUERY_LIMITED, false, pid);
      if (h == IntPtr.Zero) return "could not be read (error " + Marshal.GetLastWin32Error() + ")";
      try {
        var sb = new StringBuilder(1024); uint size = 1024;
        if (!N.QueryFullProcessImageNameW(h, 0, sb, ref size)) return "its path could not be read (error " + Marshal.GetLastWin32Error() + ")";
        string path = sb.ToString(0, (int)size);
        if (!string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) return "refused: it is " + path + ", not " + exe;
        long c, x, k, u;
        if (N.GetProcessTimes(h, out c, out x, out k, out u)) created = c;
        return null;
      } finally { N.CloseHandle(h); }
    }

    /// The guard, both steps. Fills `targets` (root first) and `refused` ({pid, file, why}). Returns
    /// a plain-words error only for a request that cannot be answered at all.
    static string Resolve(string verb, Dictionary<string, object> req, out string exe, out bool running, out string rootWhy,
                          out long rootCreated, List<Target> targets, List<object> refused) {
      exe = ExpectedExe(); running = false; rootWhy = null; rootCreated = 0;
      if (exe == null) return "this sidecar has no APPDATA, so it does not know where Spotify.exe is";
      string asked = Json.GetString(req, "exe");
      if (!string.IsNullOrEmpty(asked) && !string.Equals(asked, exe, StringComparison.OrdinalIgnoreCase))
        return "refused: this sidecar only reaches " + exe + ", not " + asked;
      int rootInt = Json.GetInt(req, "root", 0);
      if (rootInt <= 0) return "spotify." + verb + " needs root: the pid of the Spotify.exe Mantle started";
      uint root = (uint)rootInt;
      string err;
      List<Proc> snap = Snapshot(out err);
      if (err != null) return err;

      var byPid = new Dictionary<uint, Proc>();
      var kids = new Dictionary<uint, List<Proc>>();
      foreach (Proc p in snap) {
        byPid[p.Pid] = p;
        List<Proc> l;
        if (!kids.TryGetValue(p.Ppid, out l)) { l = new List<Proc>(); kids[p.Ppid] = l; }
        l.Add(p);
      }
      Proc rp;
      if (!byPid.TryGetValue(root, out rp)) { rootWhy = "the Spotify Mantle started (pid " + root + ") has exited"; return null; }
      if (!IsSpotifyName(rp.File)) { rootWhy = "refused: pid " + root + " is " + rp.File + ", not Spotify.exe"; refused.Add(Json.Obj("pid", root, "file", rp.File, "why", rootWhy)); return null; }
      string why = CheckPath(root, exe, out rootCreated);
      if (why != null) { rootWhy = "pid " + root + " " + why; refused.Add(Json.Obj("pid", root, "file", rp.File, "why", why)); return null; }
      string wantCreated = Json.GetString(req, "created");
      if (!string.IsNullOrEmpty(wantCreated) && wantCreated != rootCreated.ToString(CultureInfo.InvariantCulture)) {
        rootWhy = "refused: pid " + root + " is a different Spotify.exe from the one Mantle started (it started at another time)";
        refused.Add(Json.Obj("pid", root, "file", rp.File, "why", rootWhy));
        return null;
      }
      running = true;

      // The tree, breadth first from the root, by the Toolhelp parent links; never deeper than
      // MAX_DEPTH and never the same pid twice (Windows reuses pids, so the links can loop).
      var inTree = new Dictionary<uint, Target>();
      var seen = new HashSet<uint>();
      var level = new List<Proc> { rp };
      seen.Add(root);
      inTree[root] = new Target { Pid = root, Ppid = rp.Ppid, Created = rootCreated };
      var treeOrder = new List<uint> { root };
      for (int d = 0; d < MAX_DEPTH && level.Count > 0; d++) {
        var next = new List<Proc>();
        foreach (Proc parent in level) {
          List<Proc> ch;
          if (!kids.TryGetValue(parent.Pid, out ch)) continue;
          foreach (Proc c in ch) {
            if (c.Pid == 0 || !seen.Add(c.Pid)) continue;
            if (!IsSpotifyName(c.File)) { refused.Add(Json.Obj("pid", c.Pid, "file", c.File, "why", "refused: " + c.File + " is not Spotify.exe")); continue; }
            long cc;
            string cw = CheckPath(c.Pid, exe, out cc);
            if (cw != null) { refused.Add(Json.Obj("pid", c.Pid, "file", c.File, "why", cw)); continue; }
            if (cc != 0 && rootCreated != 0 && cc < rootCreated) { refused.Add(Json.Obj("pid", c.Pid, "file", c.File, "why", "refused: it started before the Spotify Mantle started, so it is not its child (a reused pid)")); continue; }
            inTree[c.Pid] = new Target { Pid = c.Pid, Ppid = c.Ppid, Created = cc };
            treeOrder.Add(c.Pid);
            next.Add(c);
          }
        }
        level = next;
      }

      // `pids` narrows it: each must be in the tree, or it is refused by name, never opened.
      var only = req.ContainsKey("pids") ? req["pids"] as List<object> : null;
      if (only == null) { foreach (uint p in treeOrder) targets.Add(inTree[p]); return null; }
      foreach (object o in only) {
        long want = 0;
        try { want = Convert.ToInt64(o, CultureInfo.InvariantCulture); } catch { want = 0; }
        Target t;
        if (want > 0 && want <= uint.MaxValue && inTree.TryGetValue((uint)want, out t)) { targets.Add(t); continue; }
        Proc q;
        string file = want > 0 && want <= uint.MaxValue && byPid.TryGetValue((uint)want, out q) ? q.File : null;
        refused.Add(Json.Obj("pid", want, "file", file, "why",
          file == null ? "it is not running"
          : !IsSpotifyName(file) ? "refused: " + file + " is not Spotify.exe"
          : "refused: this Spotify.exe is not in the tree of the Spotify Mantle started (pid " + root + ")"));
      }
      return null;
    }

    /// Working set, private working set and commit of one process that passed the guard. -1 = unread.
    static void Read(uint pid, out long ws, out long pws, out long priv) {
      ws = pws = priv = -1;
      IntPtr h = N.OpenProcess(QUERY_LIMITED, false, pid);
      if (h == IntPtr.Zero) return;
      try {
        var c = new N.PMC_EX2();
        c.cb = (uint)Marshal.SizeOf(typeof(N.PMC_EX2));
        if (!N.GetProcessMemoryInfo(h, ref c, c.cb)) return;
        ws = (long)c.WorkingSetSize.ToUInt64();
        pws = (long)c.PrivateWorkingSetSize.ToUInt64();
        priv = (long)c.PrivateUsage.ToUInt64();
      } finally { N.CloseHandle(h); }
    }

    /// pid -> how many visible, unowned top-level windows it has (.NET's MainWindowHandle test).
    static Dictionary<uint, int> VisibleWindows() {
      var m = new Dictionary<uint, int>();
      N.EnumWindows(delegate (IntPtr hwnd, IntPtr lp) {
        if (!N.IsWindowVisible(hwnd) || N.GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
        uint pid;
        N.GetWindowThreadProcessId(hwnd, out pid);
        int n;
        m.TryGetValue(pid, out n);
        m[pid] = n + 1;
        return true;
      }, IntPtr.Zero);
      return m;
    }

    static string Mem(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      var targets = new List<Target>();
      var refused = new List<object>();
      string exe, rootWhy; bool running; long created;
      string err = Resolve("mem", req, out exe, out running, out rootWhy, out created, targets, refused);
      if (err != null) return err;
      var vis = running ? VisibleWindows() : new Dictionary<uint, int>();
      var procs = new List<object>();
      long sWs = 0, sPws = 0, sPriv = 0; int visible = 0; bool pwsOk = true;
      foreach (Target t in targets) {
        long ws, pws, priv;
        Read(t.Pid, out ws, out pws, out priv);
        int v; vis.TryGetValue(t.Pid, out v);
        visible += v;
        if (ws >= 0) sWs += ws;
        if (pws >= 0) sPws += pws; else pwsOk = false;
        if (priv >= 0) sPriv += priv;
        procs.Add(Json.Obj("pid", t.Pid, "ppid", t.Ppid, "ws", ws, "pws", pws, "priv", priv, "visible", v));
      }
      result = Json.Obj("exe", exe, "root", Json.GetInt(req, "root", 0), "running", running, "why", rootWhy,
                        "created", created == 0 ? null : created.ToString(CultureInfo.InvariantCulture),
                        "n", procs.Count, "ws", sWs, "pws", pwsOk ? (object)sPws : null, "priv", sPriv, "visible", visible,
                        "procs", procs, "refused", refused, "ms", sw.ElapsedMilliseconds);
      return null;
    }

    static string Trim(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      var targets = new List<Target>();
      var refused = new List<object>();
      string exe, rootWhy; bool running; long created;
      string err = Resolve("trim", req, out exe, out running, out rootWhy, out created, targets, refused);
      if (err != null) return err;
      var skip = new HashSet<uint>();
      var sk = req.ContainsKey("skip") ? req["skip"] as List<object> : null;
      if (sk != null) foreach (object o in sk) { try { long v = Convert.ToInt64(o, CultureInfo.InvariantCulture); if (v > 0 && v <= uint.MaxValue) skip.Add((uint)v); } catch { /* not a pid */ } }

      var rows = new List<object>();
      long before = 0, after = 0, trimmedBefore = 0, trimmedAfter = 0; int trimmed = 0;
      foreach (Target t in targets) {
        long ws0, pws0, priv0;
        Read(t.Pid, out ws0, out pws0, out priv0);
        IDictionary r = Json.Obj("pid", t.Pid, "ok", false, "beforeWs", ws0, "beforePws", pws0);
        rows.Add(r);
        if (skip.Contains(t.Pid)) {
          r["skipped"] = true; r["why"] = "left alone: the caller asked (it plays the audio)";
          if (pws0 >= 0) { before += pws0; after += pws0; }
          continue;
        }
        IntPtr h = N.OpenProcess(SET_QUOTA | QUERY_LIMITED, false, t.Pid);
        if (h == IntPtr.Zero) { r["why"] = "could not be opened to trim (error " + Marshal.GetLastWin32Error() + ")"; continue; }
        try {
          if (N.EmptyWorkingSet(h)) { r["ok"] = true; trimmed++; }
          else r["why"] = "EmptyWorkingSet failed (error " + Marshal.GetLastWin32Error() + ")";
        } finally { N.CloseHandle(h); }
        long ws1, pws1, priv1;
        Read(t.Pid, out ws1, out pws1, out priv1);
        r["afterWs"] = ws1; r["afterPws"] = pws1;
        if (pws0 >= 0) before += pws0;
        if (pws1 >= 0) after += pws1;
        if ((bool)r["ok"] && pws0 >= 0 && pws1 >= 0) { trimmedBefore += pws0; trimmedAfter += pws1; }
      }
      result = Json.Obj("exe", exe, "root", Json.GetInt(req, "root", 0), "running", running, "why", rootWhy,
                        "created", created == 0 ? null : created.ToString(CultureInfo.InvariantCulture),
                        "trimmed", trimmed, "results", rows, "refused", refused,
                        "before", before, "after", after, "trimmedBefore", trimmedBefore, "trimmedAfter", trimmedAfter,
                        "passive", Program.Passive, "ms", sw.ElapsedMilliseconds);
      return null;
    }
  }
}
