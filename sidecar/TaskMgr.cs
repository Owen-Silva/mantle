// TaskMgr.cs - the native half of Mantle's task manager (lane taskmgr, 2026-09-28).
//
// WHY: the user opens Windows' Task Manager for one job: free RAM before and while they play Valorant
// (they close Spotify by hand for ~300 MB). lib/features/taskmgr.js is that job, RAM first; this
// file reads the process table and does the three things a row can ask for. It is asked ONLY
// while the task manager window is open (about every 1.5 s): nothing here runs on its own.
//
// THE MEMORY NUMBER. Task Manager's Processes tab "Memory" column is the PRIVATE WORKING SET
// (Windows 11 labels it "Memory (active private working set)"; for a desktop app that is not a
// suspended Store app the two are the same pages). The snapshot reads it for EVERY process in one
// call, with no handle opened: NtQuerySystemInformation(SystemProcessInformation), field
// SYSTEM_PROCESS_INFORMATION.WorkingSetPrivateSize (x64 offset 0x08, the same read
// sidecar/TopbarStats.cs does). The per-handle equivalent, GetProcessMemoryInfo with
// PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize, is what `taskmgr.verify` answers, so the
// two methods can be compared read-only; `taskmgr.trim` reports its before/after with EX2 on the
// very handle it trims through.
//
// THE ACTIONS, and the rules they keep:
//   - Everything is BY PID, never by image name. Each pid comes with the creation time the
//     snapshot saw (`created`, a FILETIME as a decimal string: it does not fit a JSON double); a
//     pid whose process is gone or whose creation time differs (Windows reused the number) is
//     refused. A handle is held on every checked pid until the action is done, so the number
//     cannot be reused in between.
//   - close: WM_CLOSE to the group's visible top-level windows. No window: taskkill without /F
//     (Windows' own "please close"). force: taskkill /F. /T is used only when the group IS the
//     root's whole live tree; otherwise every pid is named (/PID a /PID b), so a game Steam or the
//     Riot Client started (its own row) is never taken down with its launcher.
//   - trim: EmptyWorkingSet per pid (the pages go to Windows' standby list; commit is unchanged).
//   - The guard below refuses Windows' own processes, session 0, games and anti-cheat, Lively,
//     explorer, and Mantle itself (this sidecar, the Electron that started it and that Electron's
//     whole tree), whatever the page asked. lib/features/_taskmgr-core.js decides the same thing
//     first and shows the reason on the row; this is the second lock.
//   - dryRun answers what WOULD be done and touches nothing. A passive (test) sidecar refuses
//     every real close/trim with FeatureTable.PassiveRefusal, so a test cannot close anything.
//
// Nothing here logs a process name, path, title or command line (the user's rule for mantle.log);
// errors carry pids and Win32 codes only. Names travel only in replies, to the window.
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class TaskMgr {
    static class N {
      [StructLayout(LayoutKind.Sequential)]
      public struct PMC_EX2 {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                       QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage,
                       PrivateUsage, PrivateWorkingSetSize;
        public ulong SharedCommitUsage;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct MEMORYSTATUSEX {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
      }
      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
      [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC_EX2 c, uint size);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool EmptyWorkingSet(IntPtr h);
      [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
    }

    const uint QUERY_LIMITED = 0x1000, SET_QUOTA = 0x0100, SYNCHRONIZE = 0x00100000, STILL_ACTIVE = 259;
    const uint WM_CLOSE = 0x0010, GW_OWNER = 4;
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x80;

    /// Windows' own processes: never closed, never trimmed (lower-case image names).
    static readonly HashSet<string> SystemNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "system", "registry", "secure system", "memory compression", "idle", "smss.exe", "csrss.exe", "wininit.exe",
      "winlogon.exe", "services.exe", "lsass.exe", "lsaiso.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe",
      "msmpeng.exe", "nissrv.exe", "securityhealthservice.exe", "sihost.exe", "ctfmon.exe", "audiodg.exe",
      "explorer.exe", "mantle.sidecar.exe", "taskmgr.exe", "conhost.exe", "runtimebroker.exe", "startmenuexperiencehost.exe",
      "shellexperiencehost.exe", "searchhost.exe", "textinputhost.exe", "applicationframehost.exe", "dllhost.exe",
      "userinit.exe", "wudfhost.exe", "spoolsv.exe"
    };
    /// Games, their clients (Riot Client, League's) and their anti-cheat: game mode's OWN list,
    /// GameMode.GamePrefixes (= lib/features/_gamemode-plan.js NEVER[0..1]), not a copy. This used to
    /// be a copy, it lacked "Riot", and a trim of RiotClientServices hung Riot Client twice (lane
    /// gamequiet, 2026-09-28). Then Lively, the user's wallpaper app. Prefixes of the image name.
    static readonly string[] NeverPrefixes = GameMode.Join(GameMode.GamePrefixes, new[] { "Lively" });

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.snapshot", Lanes.Slow, Snapshot);     // RAM, every process (private working set, CPU time), app windows
      t.Add("taskmgr.close", Lanes.Slow, Close);           // {procs:[{pid,created}], root, force?, dryRun?}
      t.Add("taskmgr.trim", Lanes.Slow, Trim);             // {procs:[{pid,created}], dryRun?} -> before/after per pid
      t.Add("taskmgr.cmdline", Lanes.Slow, CmdLine);       // {pid, created} -> the exe path and command line (reopen)
      t.Add("taskmgr.verify", Lanes.Slow, Verify);         // {pids:[...]} -> EX2 PrivateWorkingSetSize per pid, read only
      t.Add("taskmgr.frame", Lanes.Slow, Frame);           // {hwnd, light?} -> Mantle's OWN window: light frame, read back
    }

    // ------------------------------------------------------------------ the window's frame
    //
    // The task manager window asks Windows for its acrylic system backdrop (Electron's
    // backgroundMaterial). Electron follows Windows' app mode, and in dark mode DWM tints that
    // backdrop, and its inactive fallback, dark under Mantle's light page (it reads grey).
    // DWMWA_USE_IMMERSIVE_DARK_MODE = 0 on that ONE window makes it the light acrylic. Only a window
    // of Mantle's own Electron (this sidecar's parent) is touched, so passive (test) mode allows it,
    // like Glass.cs; any other hwnd is refused. Without `light` it only reads.
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_SYSTEMBACKDROP_TYPE = 38;

    static string Frame(Dictionary<string, object> req, ref object result) {
      object v;
      double hv = req.TryGetValue("hwnd", out v) && v is double ? (double)v : 0;
      if (hv <= 0) return "frame needs the window's hwnd";
      IntPtr hwnd = new IntPtr((long)hv);
      if (!Win32.IsWindow(hwnd)) return "that window does not exist";
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      if (Program.ParentPid <= 0 || pid != Program.ParentPid) return "refused: not a window of Mantle's own Electron";
      bool set = req.ContainsKey("light");
      if (set) {
        int dark = Json.GetBool(req, "light", true) ? 0 : 1;
        int hr = Win32.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        if (hr != 0) return "Windows refused the frame colour (HRESULT 0x" + hr.ToString("X8") + ")";
      }
      int d, b;
      if (Win32.DwmGetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, out d, sizeof(int)) != 0) d = -1;
      if (Win32.DwmGetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, out b, sizeof(int)) != 0) b = -1;
      result = Json.Obj("dark", d, "backdrop", b, "set", set);
      return null;
    }

    // ------------------------------------------------------------------ the snapshot

    sealed class Proc {
      public uint Pid, Ppid, Session; public long Created, Cpu, Pws; public string File;
    }

    static IntPtr _buf = IntPtr.Zero;
    static int _len = 1 << 20;
    static readonly object _gate = new object();
    // pid|created -> exe path ("" = could not be read); path -> description. Pruned per snapshot.
    static readonly Dictionary<string, string> _paths = new Dictionary<string, string>(StringComparer.Ordinal);
    static readonly Dictionary<string, string> _descs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// One NtQuerySystemInformation(SystemProcessInformation) read. x64 offsets of
    /// SYSTEM_PROCESS_INFORMATION: NextEntryOffset 0x00, WorkingSetPrivateSize 0x08, CreateTime 0x20,
    /// UserTime 0x28, KernelTime 0x30, ImageName 0x38 (Length) / 0x40 (Buffer), UniqueProcessId 0x50,
    /// InheritedFromUniqueProcessId 0x58, SessionId 0x64. Null + why when the read failed.
    static List<Proc> ReadProcs(out string why) {
      why = null;
      var list = new List<Proc>(400);
      if (IntPtr.Size != 8) { why = "the process table is read with x64 offsets and this sidecar is 32-bit"; return null; }
      lock (_gate) {
        int ret = 0, st = 0;
        for (int tries = 0; tries < 5; tries++) {
          if (_buf == IntPtr.Zero) _buf = Marshal.AllocHGlobal(_len);
          st = N.NtQuerySystemInformation(5, _buf, _len, out ret);
          if (st != unchecked((int)0xC0000004)) break;   // STATUS_INFO_LENGTH_MISMATCH: grow and retry
          Marshal.FreeHGlobal(_buf); _buf = IntPtr.Zero; _len = Math.Max(_len * 2, ret + 65536);
        }
        if (st != 0) { why = "Windows did not hand over the process table (NTSTATUS 0x" + st.ToString("X8") + ")"; return null; }
        long off = 0;
        while (true) {
          IntPtr p = new IntPtr(_buf.ToInt64() + off);
          var r = new Proc();
          r.Pid = (uint)Marshal.ReadInt64(p, 0x50);
          r.Ppid = (uint)Marshal.ReadInt64(p, 0x58);
          r.Session = (uint)Marshal.ReadInt32(p, 0x64);
          r.Pws = Marshal.ReadInt64(p, 0x08);
          r.Created = Marshal.ReadInt64(p, 0x20);
          r.Cpu = Marshal.ReadInt64(p, 0x28) + Marshal.ReadInt64(p, 0x30);
          int len = Marshal.ReadInt16(p, 0x38) & 0xFFFF;
          IntPtr nb = Marshal.ReadIntPtr(p, 0x40);
          r.File = r.Pid == 0 ? "Idle" : nb == IntPtr.Zero ? "System" : Marshal.PtrToStringUni(nb, len / 2);
          list.Add(r);
          int next = Marshal.ReadInt32(p, 0);
          if (next == 0) break;
          off += next;
        }
      }
      return list;
    }

    static string Key(uint pid, long created) { return pid.ToString(CultureInfo.InvariantCulture) + "|" + created.ToString(CultureInfo.InvariantCulture); }
    static string Str(long v) { return v.ToString(CultureInfo.InvariantCulture); }

    static string PathOf(uint pid) {
      IntPtr h = N.OpenProcess(QUERY_LIMITED, false, pid);
      if (h == IntPtr.Zero) return "";
      try {
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        return N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : "";
      } finally { N.CloseHandle(h); }
    }

    static string DescOf(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      string d;
      if (_descs.TryGetValue(path, out d)) return d;
      try { d = FileVersionInfo.GetVersionInfo(path).FileDescription; } catch (Exception) { d = null; }
      d = string.IsNullOrEmpty(d) ? null : d.Trim();
      _descs[path] = d;
      return d;
    }

    /// Visible, unowned, uncloaked, titled, non-tool top-level windows: the ones that make a
    /// process an "app" (Task Manager's Apps group), by pid. A Store app's frame
    /// (ApplicationFrameHost) is credited to the app inside it.
    static Dictionary<uint, List<IntPtr>> AppWindowsByPid() {
      var m = new Dictionary<uint, List<IntPtr>>();
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        try {
          if (!Win32.IsWindowVisible(hwnd) || Win32.GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
          if ((Win32.GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64() & WS_EX_TOOLWINDOW) != 0) return true;
          if (Win32.GetWindowTextLengthW(hwnd) == 0 || Win32.IsCloaked(hwnd)) return true;
          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          if (Win32.GetClassName(hwnd) == "ApplicationFrameWindow") {
            int inner = 0;
            Win32.EnumChildWindows(hwnd, delegate (IntPtr c, IntPtr l2) {
              int cp; Win32.GetWindowThreadProcessId(c, out cp);
              if (cp != pid) { inner = cp; return false; }
              return true;
            }, IntPtr.Zero);
            if (inner > 0) pid = inner;
          }
          List<IntPtr> l;
          if (!m.TryGetValue((uint)pid, out l)) m[(uint)pid] = l = new List<IntPtr>();
          l.Add(hwnd);
        } catch (Exception) { /* one odd window never costs the list */ }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return m;
    }

    static string Snapshot(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      string why;
      List<Proc> procs = ReadProcs(out why);
      if (procs == null) return why;
      var mem = new N.MEMORYSTATUSEX();
      mem.dwLength = (uint)Marshal.SizeOf(typeof(N.MEMORYSTATUSEX));
      IDictionary memo = N.GlobalMemoryStatusEx(ref mem)
        ? Json.Obj("total", (long)mem.ullTotalPhys, "avail", (long)mem.ullAvailPhys, "used", (long)(mem.ullTotalPhys - mem.ullAvailPhys),
                   "load", (int)mem.dwMemoryLoad, "commit", (long)(mem.ullTotalPageFile - mem.ullAvailPageFile), "commitLimit", (long)mem.ullTotalPageFile)
        : Json.Obj("reason", "Windows did not report memory (GlobalMemoryStatusEx error " + Marshal.GetLastWin32Error() + ")");
      Dictionary<uint, List<IntPtr>> wins = AppWindowsByPid();
      var live = new HashSet<string>(StringComparer.Ordinal);
      var rows = new List<object>(procs.Count);
      int noPath = 0;
      long idle = -1;
      foreach (Proc p in procs) {
        if (p.Pid == 0) { idle = p.Cpu; continue; }   // the Idle process: its time is every core's idle time
        string k = Key(p.Pid, p.Created);
        live.Add(k);
        string path;
        if (!_paths.TryGetValue(k, out path)) { path = p.Pid == 4 ? "" : PathOf(p.Pid); _paths[k] = path; }
        if (path.Length == 0) noPath++;
        List<IntPtr> w;
        int nwin = wins.TryGetValue(p.Pid, out w) ? w.Count : 0;
        string title = nwin > 0 ? Win32.GetWindowText(w[0]) : null;
        // "Not responding": Windows' own test (the window has not taken a message for 5 s), the one
        // Windows' Task Manager and the ghost window use. Asked only of the few app windows.
        int hung = 0;
        if (nwin > 0) foreach (IntPtr h in w) { try { if (N.IsHungAppWindow(h)) hung++; } catch (Exception) { } }
        rows.Add(Json.Obj("pid", (long)p.Pid, "ppid", (long)p.Ppid, "file", p.File, "created", Str(p.Created),
          "pws", p.Pws, "cpu", p.Cpu, "session", (long)p.Session, "path", path.Length > 0 ? path : null,
          "desc", DescOf(path), "windows", nwin, "title", title, "hung", hung));
      }
      // Forget the processes that are gone (the cache is keyed pid|created, so a reused pid is new).
      var dead = new List<string>();
      foreach (string k in _paths.Keys) if (!live.Contains(k)) dead.Add(k);
      foreach (string k in dead) _paths.Remove(k);
      if (_descs.Count > 2000) _descs.Clear();
      // idle: the Idle process's CPU time (100 ns units, summed over cores): the machine's busy share is
      // 1 - its growth / (elapsed x cores), the number Windows' Task Manager shows as CPU.
      result = Json.Obj("t", DateTime.UtcNow.Ticks / 10000.0, "cpus", Environment.ProcessorCount, "mem", memo, "idle", idle,
        "procs", rows, "selfPid", (long)Program.OwnPid, "parentPid", (long)Program.ParentPid, "noPath", noPath,
        "method", "NtQuerySystemInformation(SystemProcessInformation).WorkingSetPrivateSize", "ms", sw.ElapsedMilliseconds);
      return null;
    }

    // ------------------------------------------------------------------ the guard

    /// Null when `file` may be closed or trimmed, else the plain-words reason it may not.
    static string Refuse(Proc p, Dictionary<uint, Proc> byPid) {
      if (p == null) return "it is not running";
      if (p.Pid <= 4) return "a Windows system process";
      if (p.Session == 0) return "a Windows service (session 0)";
      if (SystemNames.Contains(p.File)) return "a Windows or Mantle process";
      foreach (string n in NeverPrefixes)
        if (p.File.StartsWith(n, StringComparison.OrdinalIgnoreCase))
          return n == "Lively" ? "Lively, the wallpaper app"
            : n == "Riot" || n == "League" ? "a game's client (" + n + "): Mantle never closes or trims it, a trim made Riot Client hang"
            : "a game or its anti-cheat";
      // Mantle: this sidecar, the Electron that started it, and everything under that Electron.
      uint self = (uint)Program.OwnPid, parent = (uint)Program.ParentPid;
      Proc q = p;
      for (int depth = 0; q != null && depth < 32; depth++) {
        if (q.Pid == self || (parent > 0 && q.Pid == parent)) return "Mantle itself";
        Proc up;
        if (q.Ppid == 0 || q.Ppid == q.Pid || !byPid.TryGetValue(q.Ppid, out up) || up.Created > q.Created) break;
        q = up;
      }
      return null;
    }

    sealed class Held { public uint Pid; public IntPtr H; public Proc P; }

    /// Parse procs:[{pid, created}], check each against the table, and hold a handle on the ones
    /// that pass. refused gets {pid, why} for the rest.
    static List<Held> Take(Dictionary<string, object> req, uint access, List<object> refused, out Dictionary<uint, Proc> byPid, out string err) {
      err = null;
      byPid = new Dictionary<uint, Proc>();
      object raw;
      var asked = Json.TryGet(req, "procs", out raw) ? raw as List<object> : null;
      if (asked == null || asked.Count == 0) { err = "needs procs: [{pid, created}] from taskmgr.snapshot"; return null; }
      if (asked.Count > 256) { err = "refused: more than 256 processes in one request"; return null; }
      string why;
      List<Proc> table = ReadProcs(out why);
      if (table == null) { err = why; return null; }
      foreach (Proc p in table) byPid[p.Pid] = p;
      var held = new List<Held>();
      foreach (object o in asked) {
        var d = o as Dictionary<string, object>;
        int pid = d == null ? 0 : Json.GetInt(d, "pid", 0);
        string created = d == null ? null : Json.GetString(d, "created");
        Proc p;
        if (pid <= 0 || !byPid.TryGetValue((uint)pid, out p)) { refused.Add(Json.Obj("pid", pid, "why", "it is no longer running")); continue; }
        if (created != Str(p.Created)) { refused.Add(Json.Obj("pid", pid, "why", "refused: that pid is now a different process (Windows reused the number)")); continue; }
        string no = Refuse(p, byPid);
        if (no != null) { refused.Add(Json.Obj("pid", pid, "why", "refused: " + no)); continue; }
        IntPtr h = N.OpenProcess(access, false, (uint)pid);
        if (h == IntPtr.Zero) {
          int e = Marshal.GetLastWin32Error();
          refused.Add(Json.Obj("pid", pid, "why", e == 5 ? "access denied: it runs as administrator or another user" : "Windows would not open it (error " + e + ")"));
          continue;
        }
        long c, x, k, u;
        uint code;
        if (!N.GetProcessTimes(h, out c, out x, out k, out u) || c != p.Created || !N.GetExitCodeProcess(h, out code) || code != STILL_ACTIVE) {
          N.CloseHandle(h);
          refused.Add(Json.Obj("pid", pid, "why", "it exited while Mantle was checking it"));
          continue;
        }
        var hd = new Held(); hd.Pid = (uint)pid; hd.H = h; hd.P = p;
        held.Add(hd);
      }
      return held;
    }

    static void Release(List<Held> held) { if (held != null) foreach (Held h in held) N.CloseHandle(h.H); }

    static bool DryRun(Dictionary<string, object> req) { return Json.GetBool(req, "dryRun", false); }

    // ------------------------------------------------------------------ close

    static string Close(Dictionary<string, object> req, ref object result) {
      bool dry = DryRun(req), force = Json.GetBool(req, "force", false);
      if (!dry && Program.Passive) return FeatureTable.PassiveRefusal;
      int root = Json.GetInt(req, "root", 0);
      var refused = new List<object>();
      Dictionary<uint, Proc> byPid;
      string err;
      List<Held> held = Take(req, QUERY_LIMITED | SYNCHRONIZE, refused, out byPid, out err);
      if (held == null) return err;
      try {
        if (held.Count == 0) { result = Json.Obj("done", false, "how", "none", "refused", refused, "dryRun", dry, "why", "nothing in the group could be closed"); return null; }
        var pids = new HashSet<uint>();
        foreach (Held h in held) pids.Add(h.Pid);
        // The root's whole live tree: /T is only safe when every one of those is in the group.
        var tree = new HashSet<uint>();
        bool rootOk = root > 0 && pids.Contains((uint)root);
        if (rootOk) {
          tree.Add((uint)root);
          for (bool grew = true; grew; ) {
            grew = false;
            foreach (Proc p in byPid.Values)
              if (!tree.Contains(p.Pid) && tree.Contains(p.Ppid) && byPid[p.Ppid].Created <= p.Created) { tree.Add(p.Pid); grew = true; }
          }
        }
        bool wholeTree = rootOk && pids.IsSupersetOf(tree);

        if (!force) {
          var targets = new List<IntPtr>();
          foreach (KeyValuePair<uint, List<IntPtr>> kv in AppWindowsByPid())
            if (pids.Contains(kv.Key)) targets.AddRange(kv.Value);
          if (targets.Count > 0) {
            int posted = 0, failed = 0, lastErr = 0;
            if (!dry) foreach (IntPtr w in targets) {
              if (Win32.PostMessageW(w, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) posted++; else { failed++; lastErr = Marshal.GetLastWin32Error(); }
            }
            result = Json.Obj("done", dry || posted > 0, "how", "wm_close", "windows", targets.Count, "posted", posted, "failed", failed,
              "why", dry ? "dry run: would send WM_CLOSE to " + targets.Count + " window(s)"
                : failed > 0 ? "WM_CLOSE could not be sent to " + failed + " window(s) (error " + lastErr + (lastErr == 5 ? ": it runs as administrator" : "") + ")" : null,
              "refused", refused, "dryRun", dry);
            return null;
          }
        }
        var args = new StringBuilder();
        if (wholeTree) args.Append("/PID ").Append(root).Append(" /T");
        else foreach (Held h in held) args.Append(args.Length > 0 ? " " : "").Append("/PID ").Append(h.Pid);
        if (force) args.Append(" /F");
        string line = "taskkill " + args.ToString();
        if (dry) { result = Json.Obj("done", true, "how", force ? "taskkill_force" : "taskkill", "command", line, "wholeTree", wholeTree, "refused", refused, "dryRun", true, "why", "dry run: would run " + line); return null; }
        int code; string output;
        RunTaskkill(args.ToString(), out code, out output);
        result = Json.Obj("done", code == 0, "how", force ? "taskkill_force" : "taskkill", "command", line, "wholeTree", wholeTree, "code", code,
          "why", code == 0 ? null : TaskkillWords(output, code, force), "refused", refused, "dryRun", false);
        return null;
      } finally { Release(held); }
    }

    static void RunTaskkill(string args, out int code, out string output) {
      code = -1; output = "";
      try {
        var psi = new ProcessStartInfo(System.IO.Path.Combine(Environment.SystemDirectory, "taskkill.exe"), args);
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
        using (Process p = Process.Start(psi)) {
          string o = p.StandardOutput.ReadToEnd(), e = p.StandardError.ReadToEnd();
          if (!p.WaitForExit(8000)) { output = "taskkill did not finish in 8 s"; return; }
          code = p.ExitCode;
          output = (o + " " + e).Trim();
        }
      } catch (Exception ex) { output = "taskkill could not be started: " + ex.Message; }
    }

    /// taskkill's own words, shortened to the reason (no process names: taskkill prints pids).
    static string TaskkillWords(string output, int code, bool force) {
      string o = (output ?? "").Replace("\r", " ").Replace("\n", " ");
      if (o.IndexOf("forcefully", StringComparison.OrdinalIgnoreCase) >= 0)
        return "it has no window to close and would only end with Force close";
      if (o.IndexOf("Access is denied", StringComparison.OrdinalIgnoreCase) >= 0)
        return "access denied: it runs as administrator or is protected";
      if (o.IndexOf("not found", StringComparison.OrdinalIgnoreCase) >= 0)
        return "it had already exited";
      o = o.Trim();
      if (o.Length > 240) o = o.Substring(0, 240);
      return "taskkill" + (force ? " /F" : "") + " answered " + code + (o.Length > 0 ? ": " + o : "");
    }

    // ------------------------------------------------------------------ trim

    static long Pws(IntPtr h, out long ws) {
      ws = -1;
      var c = new N.PMC_EX2();
      c.cb = (uint)Marshal.SizeOf(typeof(N.PMC_EX2));
      if (!N.GetProcessMemoryInfo(h, ref c, c.cb)) return -1;
      ws = (long)c.WorkingSetSize.ToUInt64();
      return (long)c.PrivateWorkingSetSize.ToUInt64();
    }

    static string Trim(Dictionary<string, object> req, ref object result) {
      bool dry = DryRun(req);
      if (!dry && Program.Passive) return FeatureTable.PassiveRefusal;
      var refused = new List<object>();
      Dictionary<uint, Proc> byPid;
      string err;
      List<Held> held = Take(req, QUERY_LIMITED | SET_QUOTA, refused, out byPid, out err);
      if (held == null) return err;
      try {
        var rows = new List<object>();
        long before = 0, after = 0;
        int trimmed = 0;
        foreach (Held h in held) {
          long ws, ws2;
          long b = Pws(h.H, out ws);
          IDictionary r = Json.Obj("pid", (long)h.Pid, "before", b, "ok", false);
          if (dry) { r["ok"] = true; r["after"] = b; }
          else if (N.EmptyWorkingSet(h.H)) { r["ok"] = true; trimmed++; r["after"] = Pws(h.H, out ws2); }
          else { int e = Marshal.GetLastWin32Error(); r["why"] = e == 5 ? "access denied" : "EmptyWorkingSet failed (error " + e + ")"; r["after"] = b; }
          if (b > 0) before += b;
          long a = (long)(r["after"] ?? -1L);
          if (a > 0) after += a;
          rows.Add(r);
        }
        result = Json.Obj("trimmed", trimmed, "before", before, "after", after, "rows", rows, "refused", refused, "dryRun", dry,
          "why", dry ? "dry run: would call EmptyWorkingSet on " + held.Count + " process(es)" : null);
        return null;
      } finally { Release(held); }
    }

    // ------------------------------------------------------------------ command line (reopen after a game)

    static string CmdLine(Dictionary<string, object> req, ref object result) {
      int pid = Json.GetInt(req, "pid", 0);
      string created = Json.GetString(req, "created");
      if (pid <= 0) return "cmdline needs pid";
      IntPtr h = N.OpenProcess(QUERY_LIMITED, false, (uint)pid);
      if (h == IntPtr.Zero) {
        int e = Marshal.GetLastWin32Error();
        result = Json.Obj("ok", false, "why", e == 5 ? "Windows did not let Mantle read it (it runs as administrator)" : e == 87 ? "it is no longer running" : "Windows would not open it (error " + e + ")");
        return null;
      }
      try {
        long c, x, k, u;
        if (created != null && (!N.GetProcessTimes(h, out c, out x, out k, out u) || Str(c) != created)) {
          result = Json.Obj("ok", false, "why", "that pid is now a different process");
          return null;
        }
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        string path = N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
        // ProcessCommandLineInformation (60, Windows 8.1+): a UNICODE_STRING followed by its text.
        int len = 8192, ret;
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
          int st = N.NtQueryInformationProcess(h, 60, buf, len, out ret);
          if (st == unchecked((int)0xC0000004) && ret > len && ret < (1 << 20)) {
            Marshal.FreeHGlobal(buf); len = ret; buf = Marshal.AllocHGlobal(len);
            st = N.NtQueryInformationProcess(h, 60, buf, len, out ret);
          }
          string line = null;
          if (st == 0) {
            int n = Marshal.ReadInt16(buf, 0) & 0xFFFF;
            IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size);
            if (s != IntPtr.Zero && n > 0) line = Marshal.PtrToStringUni(s, n / 2);
          }
          result = Json.Obj("ok", path != null, "path", path, "cmdline", line,
            "why", path == null ? "its exe path could not be read" : line == null ? "its command line could not be read (NTSTATUS 0x" + st.ToString("X8") + "); it would reopen without arguments" : null);
        } finally { Marshal.FreeHGlobal(buf); }
        return null;
      } finally { N.CloseHandle(h); }
    }

    // ------------------------------------------------------------------ verify (read only)

    static string Verify(Dictionary<string, object> req, ref object result) {
      object raw;
      var asked = Json.TryGet(req, "pids", out raw) ? raw as List<object> : null;
      if (asked == null) return "verify needs pids: [...]";
      var rows = new List<object>();
      long sum = 0;
      int read = 0;
      foreach (object o in asked) {
        uint pid = o is double ? (uint)(double)o : 0;
        IntPtr h = N.OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) { rows.Add(Json.Obj("pid", (long)pid, "pws", -1L, "why", "error " + Marshal.GetLastWin32Error())); continue; }
        try {
          long ws, pws = Pws(h, out ws);
          if (pws >= 0) { sum += pws; read++; }
          rows.Add(Json.Obj("pid", (long)pid, "pws", pws, "ws", ws));
        } finally { N.CloseHandle(h); }
      }
      result = Json.Obj("method", "GetProcessMemoryInfo(PROCESS_MEMORY_COUNTERS_EX2).PrivateWorkingSetSize", "sum", sum, "read", read, "rows", rows);
      return null;
    }
  }
}
