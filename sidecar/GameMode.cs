// GameMode.cs - `gamemode.*`: the Windows half of Mantle's game mode (lane gamemode, 2026-09-25).
// The decisions live in lib/features/_gamemode-plan.js (pure, unit-tested); this file only reads
// Windows and makes the few writes game mode is allowed to make, each one checked here AGAIN.
//
// WHAT GAME MODE CHANGES, and nothing else:
//   - background processes: EcoQoS ("Efficiency mode", SetProcessInformation ProcessPowerThrottling
//     EXECUTION_SPEED) and BELOW_NORMAL priority when they were NORMAL; put back afterwards. Only
//     when the value is still the one game mode set (an app that changed its own state wins).
//   - the power mode for ONE named power source (PowerSetUserConfigured{AC,DC}PowerMode, the call
//     Settings uses, as sidecar/PowerMode.cs measured), read back through PowerMode.Read().
//   - Energy saver's "turn on at" battery level on the active plan (ESBATTTHRESHOLD, DC), ONLY when
//     Owen switched "Lift Energy saver while gaming" on; put back afterwards.
//
// ANTI-CHEAT (the brief, non-negotiable). The game and its anti-cheat are NEVER opened with more
// than PROCESS_QUERY_LIMITED_INFORMATION - and this file does not even do that: the process list is
// a Toolhelp snapshot (no handle to anything), the foreground window's exe comes from
// Foreground.Read() (PROCESS_QUERY_LIMITED_INFORMATION, the same read the bar has always made), and
// every write target is refused below if it is a game, an anti-cheat, the foreground process, a
// Windows component, another session, elevated, or this sidecar - whatever main asked for. No
// injection, no hooks into another process, no memory reads, no priority change on the game.
//
// TESTS: in --passive every write is refused before Windows is called, unless it would write the
// value already there (then nothing is written and `same` says so). gamemode.guard is the pure
// refusal rule, for the tests.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class GameMode {
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
      public struct PROCESS_POWER_THROTTLING_STATE { public uint Version, ControlMask, StateMask; }

      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetPriorityClass(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetPriorityClass(IntPtr h, uint cls);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int ret);
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

      [DllImport("powrprof.dll")] public static extern uint PowerSetUserConfiguredACPowerMode(ref Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerSetUserConfiguredDCPowerMode(ref Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
      [DllImport("powrprof.dll")] public static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerWriteDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
    }

    const uint QUERY_LIMITED = 0x1000, QUERY_INFORMATION = 0x0400, SET_INFORMATION = 0x0200;
    const int ProcessPowerThrottling = 4;               // PROCESS_INFORMATION_CLASS
    const uint THROTTLE_VERSION = 1, EXECUTION_SPEED = 0x1;
    const uint NORMAL = 0x20, BELOW_NORMAL = 0x4000, IDLE = 0x40, ABOVE_NORMAL = 0x8000, HIGH = 0x80, REALTIME = 0x100;
    static readonly Guid EnergySaverSubgroup = new Guid("de830923-a562-41af-a086-e3a2c6bad2da");
    static readonly Guid EnergySaverAtSetting = new Guid("e69653ca-cf7f-4f05-aa73-cb833fa90ad4");   // ESBATTTHRESHOLD

    public static void Register(FeatureTable t) {
      t.Add("gamemode.scan", Lanes.Slow, Scan);       // foreground + game verdict [+ the process list]
      t.Add("gamemode.apply", Lanes.Slow, Apply);     // EcoQoS / priority on background processes (and back)
      t.Add("gamemode.power", Lanes.Qs, Power);       // the power mode for ONE named source
      t.Add("gamemode.saver", Lanes.Qs, Saver);       // Energy saver's "turn on at" level (opt-in)
      t.Add("gamemode.guard", Lanes.Slow, GuardCmd);  // PURE: would a target be refused, and why
      t.Add("gamemode.trim", Lanes.Slow, Trim);       // Mantle resting: its OWN Electron processes' idle pages back to Windows
    }

    [DllImport("psapi.dll", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr h);
    const uint SET_QUOTA = 0x0100;

    /// Mantle resting while a game runs (lane memfix, 2026-09-26). {pids:[...]} -> {results:[{pid, ok,
    /// why?}], trimmed}. EmptyWorkingSet on Mantle's OWN Electron processes only: the one that started
    /// this sidecar (--parent-pid) and its direct children running the same exe. Never this sidecar (its
    /// keyboard hook must never wait on a page fault), never anything else: every other pid is refused
    /// by name, from the Toolhelp list, before any handle is opened. Measured on the --test instance:
    /// the kept processes' working set 429 MB -> 77 MB 30 s later. Allowed in passive (--test) too, like
    /// MenuBar's fixture: the only processes it can reach are the calling instance's own.
    static string Trim(Dictionary<string, object> req, ref object result) {
      var pids = req.ContainsKey("pids") ? req["pids"] as List<object> : null;
      if (pids == null) return "gamemode.trim needs pids: [pid, ...]";
      string err;
      List<Proc> snap = Snapshot(out err);
      if (err != null) return err;
      Proc main = null;
      foreach (Proc p in snap) if (Program.ParentPid > 0 && p.Pid == (uint)Program.ParentPid) { main = p; break; }
      var outList = new List<object>();
      int trimmed = 0;
      foreach (object o in pids) {
        long want = 0;
        try { want = Convert.ToInt64(o, CultureInfo.InvariantCulture); } catch { want = 0; }
        IDictionary r = Json.Obj("pid", want, "ok", false);
        outList.Add(r);
        Proc p = null;
        foreach (Proc q in snap) if (q.Pid == (ulong)Math.Max(0, want)) { p = q; break; }
        if (main == null) { r["why"] = "refused: this sidecar has no Mantle process that started it (--parent-pid)"; continue; }
        if (p == null) { r["why"] = "it has exited"; continue; }
        if (p.Pid == (uint)Program.OwnPid) { r["why"] = "refused: the sidecar itself (it runs the keyboard hook)"; continue; }
        bool mine = p.Pid == main.Pid || (p.Ppid == main.Pid && string.Equals(p.File, main.File, StringComparison.OrdinalIgnoreCase));
        if (!mine) { r["why"] = "refused: " + p.File + " is not one of Mantle's own processes"; continue; }
        IntPtr h = N.OpenProcess(SET_QUOTA | QUERY_INFORMATION | QUERY_LIMITED, false, p.Pid);
        if (h == IntPtr.Zero) { r["why"] = "could not be opened (error " + Marshal.GetLastWin32Error() + ")"; continue; }
        try {
          if (EmptyWorkingSet(h)) { r["ok"] = true; trimmed++; }
          else r["why"] = "EmptyWorkingSet failed (error " + Marshal.GetLastWin32Error() + ")";
        } finally { N.CloseHandle(h); }
      }
      result = Json.Obj("results", outList, "trimmed", trimmed, "passive", Program.Passive);
      return null;
    }

    // ------------------------------------------------------------------ the never-touch rule

    /// Exe names (or name prefixes) game mode never writes to: the games and their anti-cheat, voice,
    /// music, recording, and input-device software (throttling a mouse driver's helper adds input lag).
    /// lib/features/_gamemode-plan.js carries the same list with the words the panel shows; this copy
    /// is the one a bug in main cannot get past.
    static readonly string[] NeverPrefixes = {
      "VALORANT", "Riot", "vgc", "vgtray", "vgk", "vanguard", "League", "EasyAntiCheat", "EAAntiCheat", "BEService",
      "BattlEye", "FACEIT", "javaw", "java", "Minecraft", "Roblox", "GameBar", "XboxPcApp", "steam", "EpicGames",
      "cs2", "csgo", "r5apex", "Fortnite", "RocketLeague", "GTA5", "Overwatch", "EscapeFromTarkov", "Cyberpunk2077",
      "Discord", "Spotify", "obs", "Streamlabs", "Medal", "vlc", "wmplayer", "Music.UI", "Microsoft.Media.Player",
      "TeamSpeak", "ts3client", "Mumble", "Teams", "ms-teams", "Zoom", "Skype", "WhatsApp", "audiodg",
      "lghub", "LGHUB", "Razer", "SteelSeries", "iCUE", "Corsair", "NVIDIA", "nvcontainer", "Mantle.Sidecar",
      "TabTip", "GameInput", "TextInputHost", "ctfmon", "Defender", "MsMpEng", "MpDefender", "SecurityHealth", "NisSrv",
    };

    /// The pure rule. `why` in plain words, or null when the target may be written.
    public static string Refuse(string file, string path, uint pid, uint session, bool elevated, uint fgPid, uint ownSession) {
      if (pid <= 8) return "a system process";
      if (pid == (uint)Program.OwnPid) return "Mantle's own sidecar (it runs the keyboard hook: slowing it slows every key)";
      if (fgPid != 0 && pid == fgPid) return "the app in front (the game, or what Owen is using)";
      if (session != ownSession) return "another session (a Windows service)";
      if (elevated) return "runs as administrator";
      string f = file ?? "";
      foreach (string p in NeverPrefixes)
        if (f.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return f + " is on game mode's never-touch list";
      string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      if (string.IsNullOrEmpty(path)) return "its path could not be read";
      if (!string.IsNullOrEmpty(win) && path.StartsWith(win.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
        return "a part of Windows (" + path + ")";
      return null;
    }

    static string GuardCmd(Dictionary<string, object> req, ref object result) {
      string why = Refuse(Json.GetString(req, "file"), Json.GetString(req, "path"), (uint)Math.Max(0, Json.GetInt(req, "pid", 0)),
                          (uint)Math.Max(0, Json.GetInt(req, "session", 1)), Json.GetBool(req, "elevated", false),
                          (uint)Math.Max(0, Json.GetInt(req, "fgPid", 0)), (uint)Math.Max(0, Json.GetInt(req, "ownSession", 1)));
      result = Json.Obj("refuse", why != null, "why", why);
      return null;
    }

    // ------------------------------------------------------------------ reading

    static uint OwnSession() { uint s; return N.ProcessIdToSessionId((uint)Program.OwnPid, out s) ? s : 0; }
    static uint ForegroundPid() { uint pid; IntPtr fg = N.GetForegroundWindow(); if (fg == IntPtr.Zero) return 0; N.GetWindowThreadProcessId(fg, out pid); return pid; }

    static string PrioName(uint c) {
      switch (c) {
        case NORMAL: return "normal"; case BELOW_NORMAL: return "belownormal"; case IDLE: return "idle";
        case ABOVE_NORMAL: return "abovenormal"; case HIGH: return "high"; case REALTIME: return "realtime";
      }
      return c == 0 ? null : "other";
    }

    static bool IsGameish(string file) {
      foreach (string p in NeverPrefixes) if ((file ?? "").StartsWith(p, StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    }

    sealed class Proc { public uint Pid, Ppid, Session; public string File; }

    static List<Proc> Snapshot(out string err) {
      err = null;
      var list = new List<Proc>();
      IntPtr snap = N.CreateToolhelp32Snapshot(N.TH32CS_SNAPPROCESS, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { err = "Windows would not list the processes (error " + Marshal.GetLastWin32Error() + ")"; return list; }
      try {
        var e = new N.PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(N.PROCESSENTRY32W));
        if (!N.Process32FirstW(snap, ref e)) return list;
        do {
          uint s;
          list.Add(new Proc { Pid = e.th32ProcessID, Ppid = e.th32ParentProcessID, File = e.szExeFile,
                              Session = N.ProcessIdToSessionId(e.th32ProcessID, out s) ? s : uint.MaxValue });
        } while (N.Process32NextW(snap, ref e));
      } finally { N.CloseHandle(snap); }
      return list;
    }

    /// Path, start time, CPU time, priority and elevation, from ONE QUERY_LIMITED handle. Never
    /// called for a game-ish name (the caller checks), so the game is not opened here at all.
    static void Detail(Proc p, IDictionary row) {
      IntPtr h = N.OpenProcess(QUERY_LIMITED, false, p.Pid);
      if (h == IntPtr.Zero) { row["why"] = "could not be read (error " + Marshal.GetLastWin32Error() + ")"; return; }
      try {
        var sb = new StringBuilder(1024); uint size = 1024;
        if (N.QueryFullProcessImageNameW(h, 0, sb, ref size)) row["path"] = sb.ToString(0, (int)size);
        long c, x, k, u;
        if (N.GetProcessTimes(h, out c, out x, out k, out u)) {
          row["created"] = c.ToString(CultureInfo.InvariantCulture);
          row["cpuMs"] = (k + u) / 10000;
        }
        row["prio"] = PrioName(N.GetPriorityClass(h));
        IntPtr tok;
        if (N.OpenProcessToken(h, 0x0008 /* TOKEN_QUERY */, out tok)) {
          try { int el, ret; if (N.GetTokenInformation(tok, 20 /* TokenElevation */, out el, 4, out ret)) row["elevated"] = el != 0; }
          finally { N.CloseHandle(tok); }
        }
      } finally { N.CloseHandle(h); }
    }

    /// {procs?, detail?} -> {fg:{...Foreground.Read(), game verdict}, procs?:[{pid, ppid, file, session,
    /// path?, created?, cpuMs?, prio?, elevated?}], ownPid, parentPid, ownSession, fgPid, ms}
    static string Scan(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      IDictionary fg = Foreground.Read();
      int quns = -1;
      try { quns = QunsNow(); } catch (Exception) { }
      string exe = fg["exe"] as string ?? "";
      bool covers = fg["fullscreen"] is bool && (bool)fg["fullscreen"];
      int fpid = fg["pid"] is int ? (int)fg["pid"] : 0;
      bool self = fpid != 0 && (fpid == Program.OwnPid || fpid == Program.ParentPid);
      fg["self"] = self;
      fg["verdict"] = self || fpid == 0 ? null : MenuBar.Verdict(exe, fg["title"] as string ?? "", covers, quns);
      var res = Json.Obj("fg", fg, "quns", quns, "ownPid", Program.OwnPid, "parentPid", Program.ParentPid,
                         "ownSession", (long)OwnSession());
      if (Json.GetBool(req, "procs", false)) {
        string err;
        List<Proc> all = Snapshot(out err);
        bool detail = Json.GetBool(req, "detail", false);
        uint own = OwnSession();
        var rows = new List<object>();
        foreach (Proc p in all) {
          IDictionary row = Json.Obj("pid", (long)p.Pid, "ppid", (long)p.Ppid, "file", p.File,
                                     "session", p.Session == uint.MaxValue ? (object)null : (long)p.Session);
          // Only Owen's own session, and never a game-ish name: those are listed by name and pid
          // only (enough to see the game is still running), and never opened.
          if (detail && p.Session == own && p.Pid > 8 && !IsGameish(p.File)) Detail(p, row);
          rows.Add(row);
        }
        res["procs"] = rows;
        if (err != null) res["procsReason"] = err;
      }
      res["ms"] = sw.ElapsedMilliseconds;
      result = res;
      return null;
    }

    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    static int QunsNow() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : -1; }

    // ------------------------------------------------------------------ EcoQoS and priority

    static IDictionary Eco(uint control, uint state) { return Json.Obj("control", (long)control, "state", (long)state); }

    static bool ReadEco(IntPtr h, out uint control, out uint state, out int err) {
      var s = new N.PROCESS_POWER_THROTTLING_STATE { Version = THROTTLE_VERSION };
      control = state = 0; err = 0;
      if (!N.GetProcessInformation(h, ProcessPowerThrottling, ref s, (uint)Marshal.SizeOf(s))) { err = Marshal.GetLastWin32Error(); return false; }
      control = s.ControlMask; state = s.StateMask;
      return true;
    }

    static uint PrioClass(string name) {
      switch (name) { case "normal": return NORMAL; case "belownormal": return BELOW_NORMAL; }
      return 0;
    }

    /// {items:[{pid, created, file, eco?:{control,state}, ecoIf?:{control,state}, prio?:"belownormal"|"normal",
    /// prioIf?:"normal"|"belownormal"}]} -> {results:[{pid, file, ok, same, eco:{before, after, wrote, why},
    /// prio:{before, after, wrote, why}, why}]}. `created` must match (a reused pid is left alone);
    /// ecoIf / prioIf = write only while the process still has that value (the restore path).
    static string Apply(Dictionary<string, object> req, ref object result) {
      var items = req.ContainsKey("items") ? req["items"] as List<object> : null;
      if (items == null) return "gamemode.apply needs items: [{pid, created, ...}]";
      uint fgPid = ForegroundPid(), own = OwnSession();
      var outList = new List<object>();
      foreach (object o in items) {
        var it = o as Dictionary<string, object>;
        if (it == null) continue;
        outList.Add(ApplyOne(it, fgPid, own));
      }
      result = Json.Obj("results", outList, "passive", Program.Passive);
      return null;
    }

    static bool GetMask(Dictionary<string, object> it, string key, out uint control, out uint state) {
      control = state = 0;
      var d = it.ContainsKey(key) ? it[key] as Dictionary<string, object> : null;
      if (d == null) return false;
      control = (uint)Math.Max(0, Json.GetInt(d, "control", 0));
      state = (uint)Math.Max(0, Json.GetInt(d, "state", 0));
      return true;
    }

    static IDictionary ApplyOne(Dictionary<string, object> it, uint fgPid, uint own) {
      uint pid = (uint)Math.Max(0, Json.GetInt(it, "pid", 0));
      string wantCreated = Json.GetString(it, "created");
      IDictionary r = Json.Obj("pid", (long)pid, "file", Json.GetString(it, "file"), "ok", false, "same", false);
      uint session;
      if (!N.ProcessIdToSessionId(pid, out session)) { r["why"] = "it has exited"; r["gone"] = true; return r; }
      // Look the name up in a snapshot (no handle) BEFORE opening anything: a game is never opened.
      string err, file = null;
      foreach (Proc p in Snapshot(out err)) if (p.Pid == pid) { file = p.File; break; }
      if (file == null) { r["why"] = "it has exited"; r["gone"] = true; return r; }
      r["file"] = file;
      if (IsGameish(file) || pid <= 8 || pid == (uint)Program.OwnPid || pid == fgPid || session != own) {
        r["why"] = "refused: " + Refuse(file, "?", pid, session, false, fgPid, own);
        return r;
      }
      IntPtr h = N.OpenProcess(SET_INFORMATION | QUERY_INFORMATION | QUERY_LIMITED, false, pid);
      if (h == IntPtr.Zero) h = N.OpenProcess(SET_INFORMATION | QUERY_LIMITED, false, pid);
      if (h == IntPtr.Zero) { r["why"] = "Windows would not let Mantle change it (error " + Marshal.GetLastWin32Error() + ")"; return r; }
      try {
        var sb = new StringBuilder(1024); uint size = 1024;
        string path = N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
        bool elevated = false;
        IntPtr tok;
        if (N.OpenProcessToken(h, 0x0008, out tok)) {
          try { int el, ret; if (N.GetTokenInformation(tok, 20, out el, 4, out ret)) elevated = el != 0; } finally { N.CloseHandle(tok); }
        }
        string refuse = Refuse(file, path, pid, session, elevated, fgPid, own);
        if (refuse != null) { r["why"] = "refused: " + refuse; return r; }
        long c, x, k, u;
        string created = N.GetProcessTimes(h, out c, out x, out k, out u) ? c.ToString(CultureInfo.InvariantCulture) : null;
        if (!string.IsNullOrEmpty(wantCreated) && created != wantCreated) { r["why"] = "that pid is a different process now (it restarted)"; r["gone"] = true; return r; }

        bool allOk = true, anyWrite = false, allSame = true;
        uint wc, ws;
        if (GetMask(it, "eco", out wc, out ws)) {
          uint bc, bs; int rerr;
          bool known = ReadEco(h, out bc, out bs, out rerr);
          IDictionary e = Json.Obj("before", known ? Eco(bc, bs) : null, "wrote", false);
          uint ic, istate;
          bool same = known && bc == wc && bs == ws;
          if (same) e["after"] = Eco(bc, bs);
          else if (GetMask(it, "ecoIf", out ic, out istate) && (!known || bc != ic || bs != istate)) {
            e["why"] = known ? "left as it is: the app changed its own efficiency setting since" : "its efficiency setting could not be read (error " + rerr + ")";
            e["after"] = known ? Eco(bc, bs) : null; e["skipped"] = true;
          } else if (Program.Passive) {
            e["why"] = FeatureTable.PassiveRefusal + ": it would have set efficiency mode " + (wc == 0 ? "back to Windows' choice" : ((ws & EXECUTION_SPEED) != 0 ? "on" : "off"));
            allOk = false;
          } else {
            var s = new N.PROCESS_POWER_THROTTLING_STATE { Version = THROTTLE_VERSION, ControlMask = wc, StateMask = ws };
            if (N.SetProcessInformation(h, ProcessPowerThrottling, ref s, (uint)Marshal.SizeOf(s))) {
              e["wrote"] = true; anyWrite = true;
              uint ac, as_; int aerr;
              e["after"] = ReadEco(h, out ac, out as_, out aerr) ? Eco(ac, as_) : null;
            } else { e["why"] = "Windows refused (error " + Marshal.GetLastWin32Error() + ")"; allOk = false; }
          }
          if (!same) allSame = false;
          r["eco"] = e;
        }
        string wantPrio = Json.GetString(it, "prio");
        if (!string.IsNullOrEmpty(wantPrio)) {
          uint want = PrioClass(wantPrio);
          uint before = N.GetPriorityClass(h);
          string onlyIf = Json.GetString(it, "prioIf");
          IDictionary pr = Json.Obj("before", PrioName(before), "wrote", false);
          if (want == 0) { pr["why"] = "unknown priority \"" + wantPrio + "\""; allOk = false; allSame = false; }
          else if (before == want) { pr["after"] = PrioName(before); }
          else if (!string.IsNullOrEmpty(onlyIf) && PrioName(before) != onlyIf) {
            allSame = false;
            pr["after"] = PrioName(before); pr["skipped"] = true;
            pr["why"] = "left at " + PrioName(before) + ": it was not " + onlyIf + " (the app or Owen set it)";
          } else if (Program.Passive) {
            allSame = false;
            pr["why"] = FeatureTable.PassiveRefusal + ": it would have set priority " + wantPrio; allOk = false;
          } else {
            allSame = false;
            if (N.SetPriorityClass(h, want)) { pr["wrote"] = true; anyWrite = true; pr["after"] = PrioName(N.GetPriorityClass(h)); }
            else { pr["why"] = "Windows refused (error " + Marshal.GetLastWin32Error() + ")"; allOk = false; }
          }
          r["prio"] = pr;
        }
        r["created"] = created;
        r["path"] = path;
        r["ok"] = allOk;
        r["same"] = allSame && !anyWrite;
        return r;
      } finally { N.CloseHandle(h); }
    }

    // ------------------------------------------------------------------ power mode, one source

    static string ModeGuidWord(string mode, out Guid g) {
      g = Guid.Empty;
      switch (mode) {
        case "efficiency": g = PowerMode.Efficiency; return null;
        case "balanced": g = PowerMode.Balanced; return null;
        case "performance": g = PowerMode.Performance; return null;
      }
      return "mode must be \"efficiency\", \"balanced\" or \"performance\" (got " + (mode == null ? "nothing" : "\"" + mode + "\"") + ")";
    }

    static string Configured(IDictionary st, string source) {
      var cfg = st == null ? null : st["configured"] as IDictionary;
      return cfg == null ? null : cfg[source == "ac" ? "ac" : "battery"] as string;
    }

    /// {source:"ac"|"battery", mode, onlyIf?} -> {ok, same, skipped, before, after, state, reason}.
    /// The choice for THAT source (not "whatever source is current"): a restore after Owen plugged in
    /// mid-game must put back the battery choice, not overwrite the plugged-in one.
    static string Power(Dictionary<string, object> req, ref object result) {
      string source = Json.GetString(req, "source"), mode = Json.GetString(req, "mode"), onlyIf = Json.GetString(req, "onlyIf");
      if (source != "ac" && source != "battery") return "gamemode.power needs source: \"ac\" or \"battery\"";
      Guid g; string bad = ModeGuidWord(mode, out g);
      if (bad != null) return "gamemode.power: " + bad;
      IDictionary before = PowerMode.Read();
      string was = Configured(before, source);
      if (!(before["ok"] is bool) || !(bool)before["ok"] || !(bool)before["available"]) {
        result = Json.Obj("ok", false, "same", false, "before", was, "state", before, "reason", before["reason"]); return null;
      }
      if (was == mode) { result = Json.Obj("ok", true, "same", true, "before", was, "after", was, "state", before); return null; }
      if (!string.IsNullOrEmpty(onlyIf) && was != onlyIf) {
        result = Json.Obj("ok", true, "same", false, "skipped", true, "before", was, "after", was, "state", before,
                          "reason", "left as " + PowerMode.FullName(was) + ": it was changed since game mode set " + PowerMode.FullName(onlyIf));
        return null;
      }
      if (Program.Passive) {
        result = Json.Obj("ok", false, "same", false, "before", was, "state", before,
                          "reason", FeatureTable.PassiveRefusal + ": it would have set the power mode " + (source == "ac" ? "plugged in" : "on battery") + " to " + mode);
        return null;
      }
      uint rc;
      try { rc = source == "ac" ? N.PowerSetUserConfiguredACPowerMode(ref g) : N.PowerSetUserConfiguredDCPowerMode(ref g); }
      catch (EntryPointNotFoundException) {
        result = Json.Obj("ok", false, "same", false, "before", was, "state", before, "reason", "this Windows has no per-source power mode call"); return null;
      }
      IDictionary after = PowerMode.Read();
      string got = Configured(after, source);
      bool ok = rc == 0 && got == mode;
      result = Json.Obj("ok", ok, "same", false, "before", was, "after", got, "state", after,
                        "reason", ok ? null : rc != 0 ? "Windows refused the power mode change (error " + rc + ")"
                                                      : "Windows accepted the change but still reports " + PowerMode.FullName(got));
      return null;
    }

    // ------------------------------------------------------------------ Energy saver (opt-in)

    static bool ActivePlan(out Guid plan) {
      plan = Guid.Empty;
      IntPtr p;
      if (N.PowerGetActiveScheme(IntPtr.Zero, out p) != 0 || p == IntPtr.Zero) return false;
      try { plan = (Guid)Marshal.PtrToStructure(p, typeof(Guid)); } finally { N.LocalFree(p); }
      return true;
    }

    /// {at: 0..100, onlyIf?} -> {ok, same, before, after, saver (after), reason}. Writes the active
    /// plan's on-battery "turn Energy saver on at" level and re-applies the plan, as
    /// `powercfg /setdcvalueindex SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD n` would.
    static string Saver(Dictionary<string, object> req, ref object result) {
      int at = Json.GetInt(req, "at", -1), onlyIf = Json.GetInt(req, "onlyIf", -1);
      if (at < 0 || at > 100) return "gamemode.saver needs at: 0..100";
      Guid plan;
      if (!ActivePlan(out plan)) { result = Json.Obj("ok", false, "reason", "Windows would not say which power plan is active"); return null; }
      Guid sub = EnergySaverSubgroup, set = EnergySaverAtSetting;
      uint was;
      uint rrc = N.PowerReadDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref set, out was);
      if (rrc != 0) { result = Json.Obj("ok", false, "reason", "the Energy saver level could not be read (error " + rrc + ")"); return null; }
      int saverNow = PowerMode.SaverStatus();
      if ((int)was == at) { result = Json.Obj("ok", true, "same", true, "before", (long)was, "after", (long)was, "saver", saverNow); return null; }
      if (onlyIf >= 0 && (int)was != onlyIf) {
        result = Json.Obj("ok", true, "same", false, "skipped", true, "before", (long)was, "after", (long)was, "saver", saverNow,
                          "reason", "left at " + was + "%: it was changed since game mode set " + onlyIf + "%");
        return null;
      }
      if (Program.Passive) {
        result = Json.Obj("ok", false, "same", false, "before", (long)was, "saver", saverNow,
                          "reason", FeatureTable.PassiveRefusal + ": it would have set Energy saver's turn-on level from " + was + "% to " + at + "%");
        return null;
      }
      uint wrc = N.PowerWriteDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref set, (uint)at);
      if (wrc == 0) N.PowerSetActiveScheme(IntPtr.Zero, ref plan);
      uint now;
      N.PowerReadDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref set, out now);
      // Energy saver's own status follows the level a moment later (the listener in PowerMode.cs).
      int saver = PowerMode.SaverStatus();
      for (int i = 0; i < 10 && at < 100 && saver >= 1; i++) { Thread.Sleep(150); saver = PowerMode.SaverStatus(); }
      bool ok = wrc == 0 && (int)now == at;
      result = Json.Obj("ok", ok, "same", false, "before", (long)was, "after", (long)now, "saver", saver,
                        "reason", ok ? null : wrc != 0 ? "Windows refused (error " + wrc + ")" : "Windows still reports " + now + "%");
      return null;
    }
  }
}
