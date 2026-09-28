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
// THE HELD HANDLE (lane spotdeath, 2026-09-27). The hidden Spotify dies during games and nothing said
// how. So once spotify.mem has passed a RUNNING root through the whole guard (path + `created`), this
// file keeps ONE SYNCHRONIZE | QUERY_LIMITED handle on that root between reads (static, under a lock),
// used for nothing but WaitForSingleObject(0), GetExitCodeProcess and GetProcessTimes: never to read
// memory, trim, suspend or end anything. When the root is then reported exited, the result carries
// `exitCode` (the uint: 0 = it quit, 0xC0000xxx = it crashed, anything else = whatever ended it chose
// that code, e.g. TerminateProcess(code)) and `exitedAt` (the exit FILETIME, same format as `created`),
// and the handle is closed. Released on that exit, on a new root (or a new `created` for the same pid;
// the old one is closed first), and when the sidecar ends. Nothing held (the exit came before any
// read, or the sidecar restarted since) = no exitCode and no exitedAt: never guessed.
// The zombie trap: while a handle is held, an exited process can STILL be in the Toolhelp list. So
// both commands first ask the held handle (when it is the asked root) whether it has exited, and if it
// has, answer "has exited" right there: no snapshot, no targets, spotify.trim touches nothing.
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
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc fn, IntPtr lParam);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    }

    const uint QUERY_LIMITED = 0x1000, SET_QUOTA = 0x0100, GW_OWNER = 4;
    const uint SYNCHRONIZE = 0x00100000, WAIT_OBJECT_0 = 0, WAIT_FAILED = 0xFFFFFFFF, STILL_ACTIVE = 259;
    const int MAX_DEPTH = 6;

    // The held handle (see the header): one root at a time, every read and write under `held`.
    static readonly object held = new object();
    static IntPtr heldH = IntPtr.Zero;
    static uint heldPid;
    static long heldCreated;

    /// How the held root ended. Code null = GetExitCodeProcess failed; At null = no exit time read.
    sealed class Exit { public object Code; public string At; }

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

    /// secreview-sp lane (2026-09-27): the guard read each pid on handles it has closed again, so by the
    /// time the trim opens its own handle the pid may belong to another process (Windows reuses pids).
    /// Checked again on the very handle EmptyWorkingSet gets, which pins the process: the same start
    /// time the guard saw and the same image. null = the same process.
    static string SameProcess(IntPtr h, Target t, string exe) {
      if (t.Created == 0) return "refused: its start time was never read, so it cannot be told from a reused pid";
      long c, x, k, u;
      if (!N.GetProcessTimes(h, out c, out x, out k, out u)) return "refused: its start time could not be read again (error " + Marshal.GetLastWin32Error() + ")";
      if (c != t.Created) return "refused: pid " + t.Pid + " is now a different process (its pid was reused after the check)";
      var sb = new StringBuilder(1024); uint size = 1024;
      if (!N.QueryFullProcessImageNameW(h, 0, sb, ref size)) return "refused: its path could not be read again (error " + Marshal.GetLastWin32Error() + ")";
      if (!string.Equals(sb.ToString(0, (int)size), exe, StringComparison.OrdinalIgnoreCase)) return "refused: it is no longer " + exe;
      return null;
    }

    /// Hold the one SYNCHRONIZE | QUERY_LIMITED handle on a root that just passed the whole guard. Kept
    /// while it is the same process (pid and start time); anything else closes the old handle first. A
    /// handle whose start time is not `created` (the root ended and its pid was reused between the guard
    /// and here) is closed at once and nothing is held. No start time known = nothing held.
    static void Hold(uint pid, long created) {
      if (pid == 0 || created == 0) return;
      lock (held) {
        if (heldH != IntPtr.Zero && heldPid == pid && heldCreated == created) return;
        Release();
        IntPtr h = N.OpenProcess(SYNCHRONIZE | QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return;
        long c, x, k, u;
        if (!N.GetProcessTimes(h, out c, out x, out k, out u) || c != created) { N.CloseHandle(h); return; }
        heldH = h; heldPid = pid; heldCreated = created;
      }
    }

    /// Close and forget the held handle. The caller holds the `held` lock.
    static void Release() {
      if (heldH != IntPtr.Zero) N.CloseHandle(heldH);
      heldH = IntPtr.Zero; heldPid = 0; heldCreated = 0;
    }

    /// When the held handle is the asked root (same pid, and the same start time when the caller passes
    /// `created`) and that process has EXITED: its exit code and exit time, and the handle is closed and
    /// forgotten. null = nothing held for this root, or it is still running (the handle stays).
    static Exit TakeExit(uint root, string wantCreated) {
      lock (held) {
        if (heldH == IntPtr.Zero || heldPid != root) return null;
        if (!string.IsNullOrEmpty(wantCreated) && wantCreated != heldCreated.ToString(CultureInfo.InvariantCulture)) return null;
        uint w = N.WaitForSingleObject(heldH, 0);
        uint code;
        bool haveCode = N.GetExitCodeProcess(heldH, out code);
        // Signalled is the answer; only when the wait itself failed does the exit code decide.
        bool exited = w == WAIT_OBJECT_0 || (w == WAIT_FAILED && haveCode && code != STILL_ACTIVE);
        if (!exited) return null;
        var e = new Exit();
        if (haveCode) e.Code = (long)code;
        long c, x, k, u;
        if (N.GetProcessTimes(heldH, out c, out x, out k, out u) && x != 0) e.At = x.ToString(CultureInfo.InvariantCulture);
        Release();
        return e;
      }
    }

    static string ExitedWhy(uint root) { return "the Spotify Mantle started (pid " + root + ") has exited"; }

    /// Adds exitCode / exitedAt to a result only when the held handle said how the root ended.
    static void AddExit(IDictionary d, Exit e) {
      if (e == null) return;
      d["exitCode"] = e.Code;
      d["exitedAt"] = e.At;
    }

    /// The guard, both steps. Fills `targets` (root first) and `refused` ({pid, file, why}). Returns
    /// a plain-words error only for a request that cannot be answered at all. `exited` is set only when
    /// the root is reported exited AND the held handle said how (see the header).
    static string Resolve(string verb, Dictionary<string, object> req, out string exe, out bool running, out string rootWhy,
                          out long rootCreated, out Exit exited, List<Target> targets, List<object> refused) {
      exe = ExpectedExe(); running = false; rootWhy = null; rootCreated = 0; exited = null;
      if (exe == null) return "this sidecar has no APPDATA, so it does not know where Spotify.exe is";
      string asked = Json.GetString(req, "exe");
      if (!string.IsNullOrEmpty(asked) && !string.Equals(asked, exe, StringComparison.OrdinalIgnoreCase))
        return "refused: this sidecar only reaches " + exe + ", not " + asked;
      int rootInt = Json.GetInt(req, "root", 0);
      if (rootInt <= 0) return "spotify." + verb + " needs root: the pid of the Spotify.exe Mantle started";
      uint root = (uint)rootInt;
      string wantCreated = Json.GetString(req, "created");
      // The zombie trap: a held root that has exited can still be in the Toolhelp list, so ask the
      // handle first and answer "has exited" before any snapshot.
      exited = TakeExit(root, wantCreated);
      if (exited != null) { rootWhy = ExitedWhy(root); return null; }
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
      if (!byPid.TryGetValue(root, out rp)) { rootWhy = ExitedWhy(root); exited = TakeExit(root, wantCreated); return null; }
      if (!IsSpotifyName(rp.File)) { rootWhy = "refused: pid " + root + " is " + rp.File + ", not Spotify.exe"; refused.Add(Json.Obj("pid", root, "file", rp.File, "why", rootWhy)); return null; }
      string why = CheckPath(root, exe, out rootCreated);
      if (why != null) { rootWhy = "pid " + root + " " + why; refused.Add(Json.Obj("pid", root, "file", rp.File, "why", why)); return null; }
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
      string exe, rootWhy; bool running; long created; Exit exited;
      string err = Resolve("mem", req, out exe, out running, out rootWhy, out created, out exited, targets, refused);
      if (err != null) return err;
      // Only spotify.mem takes the held handle, and only on a root that passed the whole guard.
      if (running) Hold((uint)Json.GetInt(req, "root", 0), created);
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
      IDictionary d = Json.Obj("exe", exe, "root", Json.GetInt(req, "root", 0), "running", running, "why", rootWhy,
                        "created", created == 0 ? null : created.ToString(CultureInfo.InvariantCulture),
                        "n", procs.Count, "ws", sWs, "pws", pwsOk ? (object)sPws : null, "priv", sPriv, "visible", visible,
                        "procs", procs, "refused", refused, "ms", sw.ElapsedMilliseconds);
      AddExit(d, exited);
      result = d;
      return null;
    }

    static string Trim(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      var targets = new List<Target>();
      var refused = new List<object>();
      string exe, rootWhy; bool running; long created; Exit exited;
      string err = Resolve("trim", req, out exe, out running, out rootWhy, out created, out exited, targets, refused);
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
          string same = SameProcess(h, t, exe);
          if (same != null) { r["why"] = same; refused.Add(Json.Obj("pid", t.Pid, "file", null, "why", same)); continue; }
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
      IDictionary d = Json.Obj("exe", exe, "root", Json.GetInt(req, "root", 0), "running", running, "why", rootWhy,
                        "created", created == 0 ? null : created.ToString(CultureInfo.InvariantCulture),
                        "trimmed", trimmed, "results", rows, "refused", refused,
                        "before", before, "after", after, "trimmedBefore", trimmedBefore, "trimmedAfter", trimmedAfter,
                        "passive", Program.Passive, "ms", sw.ElapsedMilliseconds);
      AddExit(d, exited);
      result = d;
      return null;
    }
  }
}
