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
//     the user switched "Lift Energy saver while gaming" on; put back afterwards.
//
// ANTI-CHEAT (the brief, non-negotiable). The game and its anti-cheat are NEVER opened with more
// than PROCESS_QUERY_LIMITED_INFORMATION - and this file barely does that: the process list is a
// system-wide process read (no handle; each process's session is asked once per run of it, which
// Windows answers through a QUERY_LIMITED open - see Snapshot), the foreground window's exe comes from
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
      [StructLayout(LayoutKind.Sequential)]
      public struct PROCESS_POWER_THROTTLING_STATE { public uint Version, ControlMask, StateMask; }

      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
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
      t.Add("gamemode.scan", Lanes.Scan, Scan);       // foreground + game verdict [+ the process list]: its own lane (Lanes.cs)
      t.Add("gamemode.apply", Lanes.Slow, Apply);     // EcoQoS / priority on background processes (and back)
      t.Add("gamemode.power", Lanes.Qs, Power);       // the power mode for ONE named source
      t.Add("gamemode.saver", Lanes.Qs, Saver);       // Energy saver's "turn on at" level (opt-in)
      t.Add("gamemode.guard", Lanes.Slow, GuardCmd);  // PURE: would a target be refused, and why
      t.Add("gamemode.trim", Lanes.Slow, Trim);       // Mantle resting: its OWN Electron processes' idle pages back to Windows
      t.Add("gamemode.trimbg", Lanes.Slow, TrimBg);   // the boost: ONE trim per idle background process, once per game
      WarmScan();                                     // the first game check finds a finished read (THE SCAN WORKER)
    }

    [DllImport("psapi.dll", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr h);
    const uint SET_QUOTA = 0x0100;

    /// Mantle resting while a game runs (lane memfix, 2026-09-26). {pids:[...]} -> {results:[{pid, ok,
    /// why?}], trimmed}. EmptyWorkingSet on Mantle's OWN Electron processes only: the one that started
    /// this sidecar (--parent-pid) and its direct children running the same exe. Never this sidecar (its
    /// keyboard hook must never wait on a page fault), never anything else: every other pid is refused
    /// by name, from the process list, before any handle is opened. Measured on the --test instance:
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

    // ------------------------------------------------------------------ the boost's one trim

    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);

    /// Never trimmed by the boost, only eased: an agent may be mid-task in them (_gamemode-plan.js NO_TRIM).
    static readonly string[] NoTrimPrefixes = { "Helm", "claude" };

    /// The test burner only: an mpburn-* exe under %TEMP% (sidecar/apppower-burner.js), the rule App
    /// power's passive writes use (AppPower.IsTestTarget). The user's apps never live there by that name.
    static bool IsBurner(string path) {
      if (string.IsNullOrEmpty(path)) return false;
      string temp;
      try { temp = System.IO.Path.GetFullPath(System.IO.Path.GetTempPath()); } catch (Exception) { return false; }
      if (!AppPower.LongPath(path).StartsWith(AppPower.LongPath(temp), StringComparison.OrdinalIgnoreCase)) return false;
      return System.IO.Path.GetFileName(path).StartsWith("mpburn-", StringComparison.OrdinalIgnoreCase);
    }

    /// Which part of a Chromium / Electron app this is, from its command line's --type= switch (a
    /// QUERY_LIMITED handle is enough: ProcessCommandLineInformation, Windows 8.1+). "" = no --type (an
    /// app's main process, or not a Chromium app); null = the line could not be read. The line itself is
    /// never kept, returned or logged (it can carry a file name).
    static string ChromiumType(IntPtr h) {
      int len = 8192, ret;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int st = NtQueryInformationProcess(h, 60, buf, len, out ret);
        if (st == STATUS_INFO_LENGTH_MISMATCH && ret > len && ret < (1 << 20)) {
          Marshal.FreeHGlobal(buf); len = ret; buf = Marshal.AllocHGlobal(len);
          st = NtQueryInformationProcess(h, 60, buf, len, out ret);
        }
        if (st != 0) return null;
        int n = Marshal.ReadInt16(buf, 0) & 0xFFFF;
        IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size);
        if (s == IntPtr.Zero || n == 0) return "";
        string line = Marshal.PtrToStringUni(s, n / 2);
        int i = line.IndexOf(" --type=", StringComparison.Ordinal);
        if (i < 0) return "";
        int j = i + 8, k = j;
        while (k < line.Length && line[k] != ' ' && line[k] != '"') k++;
        return line.Substring(j, k - j).ToLowerInvariant();
      } finally { Marshal.FreeHGlobal(buf); }
    }

    static string HelperWords(string type) {
      if (type == "gpu-process") return "its app's graphics process (only an app's pages are trimmed)";
      if (type == "utility") return "a helper of its app (network, sound or storage; only an app's pages are trimmed)";
      if (type.StartsWith("crashpad", StringComparison.Ordinal)) return "its app's crash reporter";
      return "a helper of its app (only an app's pages are trimmed)";
    }

    /// GAME-MODE BOOST (lane mantle-boost, 2026-10-15; design notes: valorant-stutter section 6). ONE
    /// EmptyWorkingSet per idle background process, once per game, chosen by main (_gamemode-plan.js
    /// trimPlan) and checked AGAIN here. {items:[{pid, created, file}], dry?, testFgPid? (passive only)}
    /// -> {results:[{pid, file, ok, gone?, why?, kind?, wsBefore, wsAfter?, freed?}], trimmed, freed, passive}.
    /// Refused BY NAME from the process list before any handle: a game, an anti-cheat or anything on the
    /// never-touch list, Helm and Claude. Refused from the list: this sidecar, Mantle's main process and
    /// its own Electron children (they rest instead), a process with same-exe children (an app's main
    /// process: its windows live there), a reused pid. Refused after a QUERY_LIMITED|SET_QUOTA open: the
    /// app in front, another session, elevated, Windows' own, a Chromium helper that is not a page.
    /// Nothing is closed or suspended; trimmed pages come back by themselves when the app touches them.
    /// A passive (--test) sidecar trims only the test burner; anything else says what it would have done.
    static string TrimBg(Dictionary<string, object> req, ref object result) {
      var items = req.ContainsKey("items") ? req["items"] as List<object> : null;
      if (items == null) return "gamemode.trimbg needs items: [{pid, created, file}]";
      bool dry = Json.GetBool(req, "dry", false);
      uint fgPid = ForegroundPid(), own = OwnSession();
      if (Program.Passive && req.ContainsKey("testFgPid")) fgPid = (uint)Math.Max(0, Json.GetInt(req, "testFgPid", 0));
      string err;
      List<Proc> snap = Snapshot(out err);
      if (err != null) return err;
      var byPid = new Dictionary<uint, Proc>();
      foreach (Proc p in snap) byPid[p.Pid] = p;
      var parents = new HashSet<uint>();          // processes with a child running the same exe
      foreach (Proc p in snap) {
        Proc q;
        if (p.Ppid != p.Pid && byPid.TryGetValue(p.Ppid, out q) && q.Created <= p.Created && string.Equals(q.File, p.File, StringComparison.OrdinalIgnoreCase)) parents.Add(q.Pid);
      }
      Proc main = null;
      if (Program.ParentPid > 0) byPid.TryGetValue((uint)Program.ParentPid, out main);
      var outList = new List<object>();
      var done = new List<IDictionary>();
      int trimmed = 0;
      foreach (object o in items) {
        var it = o as Dictionary<string, object>;
        if (it == null) continue;
        uint pid = (uint)Math.Max(0, Json.GetInt(it, "pid", 0));
        string wantCreated = Json.GetString(it, "created");
        IDictionary r = Json.Obj("pid", (long)pid, "file", Json.GetString(it, "file"), "ok", false);
        outList.Add(r);
        Proc p;
        if (!byPid.TryGetValue(pid, out p)) { r["why"] = "it has exited"; r["gone"] = true; continue; }
        r["file"] = p.File;
        if (!string.IsNullOrEmpty(wantCreated) && p.Created.ToString(CultureInfo.InvariantCulture) != wantCreated) { r["why"] = "that pid is a different process now (it restarted)"; r["gone"] = true; continue; }
        r["wsBefore"] = p.Ws;
        string f = p.File ?? "";
        if (pid <= 8 || IsGameish(f)) { r["why"] = "refused: " + (pid <= 8 ? "a system process" : f + " is on game mode's never-touch list"); continue; }
        string noTrim = null;
        foreach (string n in NoTrimPrefixes) if (f.StartsWith(n, StringComparison.OrdinalIgnoreCase)) noTrim = n;
        if (noTrim != null) { r["why"] = "refused: Helm and Claude are only eased (an agent may be working)"; continue; }
        if (pid == (uint)Program.OwnPid) { r["why"] = "refused: the sidecar itself (it runs the keyboard hook)"; continue; }
        if (main != null && (pid == main.Pid || (p.Ppid == main.Pid && string.Equals(f, main.File, StringComparison.OrdinalIgnoreCase)))) { r["why"] = "refused: Mantle's own processes rest instead"; continue; }
        if (parents.Contains(pid)) { r["why"] = "refused: its app's main process (its windows live there)"; continue; }
        if (pid == fgPid) { r["why"] = "refused: the app in front"; continue; }
        uint session;
        if (!N.ProcessIdToSessionId(pid, out session)) { r["why"] = "it has exited"; r["gone"] = true; continue; }
        IntPtr h = N.OpenProcess(SET_QUOTA | QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) { r["why"] = "Windows would not let Mantle trim it (error " + Marshal.GetLastWin32Error() + ")"; continue; }
        try {
          var sb = new StringBuilder(1024); uint size = 1024;
          string path = N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
          bool elevated = false;
          IntPtr tok;
          if (N.OpenProcessToken(h, 0x0008, out tok)) {
            try { int el, ret; if (N.GetTokenInformation(tok, 20, out el, 4, out ret)) elevated = el != 0; } finally { N.CloseHandle(tok); }
          }
          string refuse = Refuse(f, path, pid, session, elevated, fgPid, own);
          if (refuse != null) { r["why"] = "refused: " + refuse; continue; }
          long c, x, k, u;
          if (!N.GetProcessTimes(h, out c, out x, out k, out u) || c != p.Created) { r["why"] = "that pid is a different process now (it restarted)"; r["gone"] = true; continue; }
          string kind = ChromiumType(h);
          r["kind"] = kind == null ? "unknown" : kind.Length == 0 ? "main" : kind;
          if (kind != null && kind.Length > 0 && kind != "renderer") { r["why"] = "refused: " + HelperWords(kind); continue; }
          if (kind == null && byPid.ContainsKey(p.Ppid) && string.Equals(byPid[p.Ppid].File, f, StringComparison.OrdinalIgnoreCase)) {
            r["why"] = "refused: which part of its app it is could not be read"; continue;
          }
          if (dry) { r["why"] = "test run: would hand its idle memory back to Windows"; r["dry"] = true; continue; }
          if (Program.Passive && !IsBurner(path)) { r["why"] = FeatureTable.PassiveRefusal + ": it would have handed back the idle memory of " + f; r["passive"] = true; continue; }
          if (EmptyWorkingSet(h)) { r["ok"] = true; trimmed++; done.Add(r); }
          else r["why"] = "Windows refused (error " + Marshal.GetLastWin32Error() + ")";
        } finally { N.CloseHandle(h); }
      }
      // The working sets AFTER, from one more list read (no handle): what each one handed back.
      long freed = 0;
      if (done.Count > 0) {
        List<Proc> after = Snapshot(out err);
        var now = new Dictionary<uint, long>();
        foreach (Proc p in after) now[p.Pid] = p.Ws;
        foreach (IDictionary r in done) {
          long ws, before = Convert.ToInt64(r["wsBefore"], CultureInfo.InvariantCulture);
          uint pid = (uint)Convert.ToInt64(r["pid"], CultureInfo.InvariantCulture);
          if (!now.TryGetValue(pid, out ws)) continue;
          r["wsAfter"] = ws;
          long d = Math.Max(0, before - ws);
          r["freed"] = d;
          freed += d;
        }
      }
      result = Json.Obj("results", outList, "trimmed", trimmed, "freed", freed, "passive", Program.Passive);
      return null;
    }

    // ------------------------------------------------------------------ the never-touch rule

    /// Exe names (or name prefixes) game mode never writes to: the games and their anti-cheat, voice,
    /// music, recording, and input-device software (throttling a mouse driver's helper adds input lag).
    /// lib/features/_gamemode-plan.js carries the same list with the words the panel shows; this copy
    /// is the one a bug in main cannot get past.
    ///
    /// GamePrefixes: the games, their clients (Riot Client, League's) and their anti-cheat, name for name
    /// _gamemode-plan.js NEVER[0..1]. Task Manager's guard (TaskMgr.cs) refuses exactly these as well:
    /// ONE list, read by both. lane gamequiet, 2026-09-28: Task Manager kept its own copy, it lacked
    /// "Riot", the user trimmed RiotClientServices 10 s before Valorant launched and Riot Client hung twice.
    /// lib/features/taskmgr.test.js fails when this list and NEVER[0..1] differ.
    internal static readonly string[] GamePrefixes = {
      "VALORANT", "Riot", "vgc", "vgtray", "vgk", "vanguard", "League", "EasyAntiCheat", "EAAntiCheat", "BEService",
      "BattlEye", "FACEIT", "javaw", "java", "Minecraft", "Roblox",
      "cs2", "csgo", "r5apex", "Fortnite", "RocketLeague", "GTA5", "Overwatch", "EscapeFromTarkov", "Cyberpunk2077",
    };
    static readonly string[] OtherNeverPrefixes = {
      "GameBar", "XboxPcApp", "steam", "EpicGames",
      "Discord", "Spotify", "obs", "Streamlabs", "Medal", "vlc", "wmplayer", "Music.UI", "Microsoft.Media.Player",
      "TeamSpeak", "ts3client", "Mumble", "Teams", "ms-teams", "Zoom", "Skype", "WhatsApp", "audiodg",
      "lghub", "LGHUB", "Razer", "SteelSeries", "iCUE", "Corsair", "NVIDIA", "nvcontainer", "Mantle.Sidecar",
      "TabTip", "GameInput", "TextInputHost", "ctfmon", "Defender", "MsMpEng", "MpDefender", "SecurityHealth", "NisSrv",
      // lane mantle-boost, 2026-10-15: the boost never touches sound, input or the network path (the
      // 10-14 freezes were Wi-Fi), nor Windows' shell. Same names as _gamemode-plan.js NEVER.
      "RtkAud", "Realtek", "Nahimic", "Dolby", "Waves", "MaxxAudio", "voicemeeter", "EarTrumpet", "SoundSwitch", "Krisp",
      "PowerToys", "AutoHotkey", "Logi", "Wacom", "WTablet", "DS4Windows", "x360ce", "ViGEm", "Synaptics", "SynTP", "ETDCtrl",
      "tailscale", "openvpn", "wireguard", "NordVPN", "ProtonVPN", "ExpressVPN", "Surfshark", "mullvad", "Cloudflare", "warp-svc", "ZeroTier", "Killer",
      "explorer",
    };
    // Declared after both halves: static initialisers run in the order they are written.
    static readonly string[] NeverPrefixes = Join(GamePrefixes, OtherNeverPrefixes);

    internal static string[] Join(string[] a, string[] b) {
      var r = new string[a.Length + b.Length];
      a.CopyTo(r, 0);
      b.CopyTo(r, a.Length);
      return r;
    }

    /// The pure rule. `why` in plain words, or null when the target may be written.
    public static string Refuse(string file, string path, uint pid, uint session, bool elevated, uint fgPid, uint ownSession) {
      if (pid <= 8) return "a system process";
      if (pid == (uint)Program.OwnPid) return "Mantle's own sidecar (it runs the keyboard hook: slowing it slows every key)";
      if (fgPid != 0 && pid == fgPid) return "the app in front (the game, or what you are using)";
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

    sealed class Proc { public uint Pid, Ppid, Session; public string File; public long Created, CpuMs, Ws; public int BasePrio; public Inst I; }

    /// ONE RUN OF ONE PROCESS, kept for its whole life (lane mantle-lanes, 2026-10-15). Keyed by pid and
    /// checked against its start time, parent pid and exe name, so a reused pid is a new entry. It holds
    /// what never changes while the process runs: its session (asked once) and, for the user's own
    /// non-game processes, the exe path and whether it runs elevated (one QUERY_LIMITED open, once).
    /// Everything that does change - CPU time, priority - comes from the process list read itself,
    /// which carries both, so a scan opens only processes it has never seen.
    ///
    /// THE SESSION keeps its old meaning: null when Windows will not let Mantle read the process (the
    /// ProcessIdToSessionId answer). Game mode's plan counts such a process as Windows' own and leaves
    /// it out of its lists; the record's own session field would put ~6 of Windows' own processes (the
    /// compositor, the logon process) on the panel as "could not be read". It is asked ONCE per
    /// process (lane sysmon-game, 2026-09-29: ProcessIdToSessionId opens the process with QUERY_LIMITED
    /// under the hood, and the game watch must not open the game and its anti-cheat every tick), and
    /// an unreadable answer is remembered too, after it failed on three scans in a row (a process
    /// caught while it starts can refuse once). The detail open follows the same rule.
    sealed class Inst {
      public uint Ppid; public long Created; public string File;
      public uint Session = uint.MaxValue; public int Tries;        // under _procLock
      // Written by the scan worker only. Detailed goes true LAST, so a reader that sees it sees the rest.
      public volatile bool Detailed;
      public volatile string Why;                                   // the open failed (null = it worked)
      public string Path; public object Elevated; public int DetailTries;
    }
    const int UnreadableTries = 3;
    static Dictionary<uint, Inst> _inst = new Dictionary<uint, Inst>();
    const int SystemProcessInformation = 5;
    const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
    static IntPtr _procBuf = IntPtr.Zero;
    static int _procBufLen = 512 * 1024;
    static readonly object _procLock = new object();

    static List<Proc> Snapshot(out string err) { int asks; return Snapshot(out err, out asks); }

    /// THE PROCESS LIST: one NtQuerySystemInformation(SystemProcessInformation) read (lane r6-cpu,
    /// 2026-09-30). It was a Toolhelp snapshot, which is a copy of this very read: the rows are the same
    /// (pid, parent, exe name). MEASURED (this PC, ~310 processes, ~3,700 threads, thread cycle time):
    /// Toolhelp 6.5 ms of CPU a list, this read 3.1 ms. The buffer is kept (~0.5 MB) and grown when the
    /// list outgrows it: no allocation per call. The same record carries each process's start time,
    /// CPU time and base priority, so none of those needs a handle.
    /// asks = how many sessions this read had to ask Windows for (the scan reply says it; a test holds it down).
    static List<Proc> Snapshot(out string err, out int asks) {
      err = null;
      asks = 0;
      var list = new List<Proc>();
      lock (_procLock) {
        int rc = STATUS_INFO_LENGTH_MISMATCH, got = 0;
        for (int tries = 0; tries < 4 && rc == STATUS_INFO_LENGTH_MISMATCH; tries++) {
          if (_procBuf == IntPtr.Zero) _procBuf = Marshal.AllocHGlobal(_procBufLen);
          rc = N.NtQuerySystemInformation(SystemProcessInformation, _procBuf, _procBufLen, out got);
          if (rc == STATUS_INFO_LENGTH_MISMATCH) {
            Marshal.FreeHGlobal(_procBuf);
            _procBuf = IntPtr.Zero;
            _procBufLen = Math.Max(got, _procBufLen) + 128 * 1024;   // room for the processes that start meanwhile
          }
        }
        if (rc != 0) { err = "Windows would not list the processes (status 0x" + rc.ToString("X8") + ")"; return list; }
        // SYSTEM_PROCESS_INFORMATION: CreateTime at 32, UserTime 40, KernelTime 48 (100 ns units), ImageName
        // (UNICODE_STRING) at 56, then BasePriority, UniqueProcessId, InheritedFromUniqueProcessId.
        bool x64 = IntPtr.Size == 8;
        // WorkingSetSize (SIZE_T) at 144 / 104: the boost's before and after, read with no handle.
        int oBuf = x64 ? 64 : 60, oPrio = x64 ? 72 : 64, oPid = x64 ? 80 : 68, oPpid = x64 ? 88 : 72, oWs = x64 ? 144 : 104;
        long at = _procBuf.ToInt64();
        var next = new Dictionary<uint, Inst>(_inst.Count + 16);
        for (int n = 0; n < 65536; n++) {
          IntPtr e = new IntPtr(at);
          uint pid = (uint)Marshal.ReadIntPtr(e, oPid).ToInt64();
          uint ppid = (uint)Marshal.ReadIntPtr(e, oPpid).ToInt64();
          long created = Marshal.ReadInt64(e, 32);
          long cpuMs = (Marshal.ReadInt64(e, 40) + Marshal.ReadInt64(e, 48)) / 10000;
          int basePrio = Marshal.ReadInt32(e, oPrio);
          long ws = Marshal.ReadIntPtr(e, oWs).ToInt64();
          int len = Marshal.ReadInt16(e, 56) & 0xFFFF;
          IntPtr name = Marshal.ReadIntPtr(e, oBuf);
          // Toolhelp's names, exactly: the idle process has no image name and is "[System Process]" there.
          string file = len > 0 && name != IntPtr.Zero ? Marshal.PtrToStringUni(name, len / 2) : pid == 0 ? "[System Process]" : "";
          Inst seen;
          if (!_inst.TryGetValue(pid, out seen) || seen.Created != created || seen.Ppid != ppid || !string.Equals(seen.File, file, StringComparison.Ordinal)) {
            seen = new Inst { Ppid = ppid, Created = created, File = file };
          }
          if (seen.Session == uint.MaxValue && seen.Tries < UnreadableTries) {
            uint s;
            seen.Tries++;
            asks++;
            if (N.ProcessIdToSessionId(pid, out s)) seen.Session = s;
          }
          next[pid] = seen;
          list.Add(new Proc { Pid = pid, Ppid = ppid, File = file, Session = seen.Session, Created = created, CpuMs = cpuMs, Ws = ws, BasePrio = basePrio, I = seen });
          int step = Marshal.ReadInt32(e, 0);
          if (step <= 0) break;
          at += step;
        }
        _inst = next;   // only live processes are kept: the cache never grows
      }
      return list;
    }

    /// Would a detail scan open this process? Only the user's own session, never a game-ish name (those are
    /// listed by name and pid only, enough to see the game is still running, and never opened).
    static bool Detailable(Proc p, uint own) { return p.Session == own && p.Pid > 8 && !IsGameish(p.File); }

    /// The detail of every process this table has NOT seen yet (scan worker only). One QUERY_LIMITED
    /// handle each, once per run of a process: the exe path and the elevation. Returns how many it opened.
    static int FillDetail(List<Proc> all, uint own) {
      int opened = 0;
      foreach (Proc p in all) {
        Inst i = p.I;
        if (i.Detailed && (i.Why == null || i.DetailTries >= UnreadableTries)) continue;   // the common case, first: no string compares
        if (!Detailable(p, own)) continue;
        opened++;
        IntPtr h = N.OpenProcess(QUERY_LIMITED, false, p.Pid);
        if (h == IntPtr.Zero) {
          i.DetailTries++;
          i.Why = "could not be read (error " + Marshal.GetLastWin32Error() + ")";
          i.Detailed = true;
          continue;
        }
        try {
          var sb = new StringBuilder(1024); uint size = 1024;
          i.Path = N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
          IntPtr tok;
          if (N.OpenProcessToken(h, 0x0008 /* TOKEN_QUERY */, out tok)) {
            try { int el, ret; if (N.GetTokenInformation(tok, 20 /* TokenElevation */, out el, 4, out ret)) i.Elevated = el != 0; }
            finally { N.CloseHandle(tok); }
          }
        } finally { N.CloseHandle(h); }
        i.Why = null;
        i.Detailed = true;
      }
      return opened;
    }

    /// The priority class from the list's base priority (the mapping SetPriorityClass makes; checked on
    /// this PC against GetPriorityClass for every process Mantle can open: 146 of 146 the same).
    static string PrioOf(int basePrio) {
      switch (basePrio) {
        case 4: return PrioName(IDLE); case 6: return PrioName(BELOW_NORMAL); case 8: return PrioName(NORMAL);
        case 10: return PrioName(ABOVE_NORMAL); case 13: return PrioName(HIGH); case 24: return PrioName(REALTIME);
      }
      return "other";
    }

    // ================================================================ THE SCAN WORKER
    // (lane mantle-lanes, 2026-10-15). The live log showed gamemode.scan holding the scan lane for up to
    // 7,013 ms - a read that takes 5-15 ms on an idle PC - and the top bar's 3 s game check timing out
    // behind it 9 times in 3 days (and a hot corner's 1.5 s one). Which call stalls (the window in front,
    // Windows' full-screen state, the process list, a process open) was never logged. Now the read runs
    // on its own thread, and a request waits for it at most ScanBudgetMs: a read that is slower than that
    // is answered from the last finished read, marked stale with its age and what the worker is stuck
    // on, so no caller waits behind a stall and the log names the slow step. Once the read in flight
    // has been stuck past StaleLimitMs, the old answer is no longer passed off: that is an error
    // naming the step.
    const int ScanBudgetMs = 400, StaleLimitMs = 10000, FirstReadMs = 8000;
    const long ScanSlowLogMs = 1000, ScanSlowLogEveryMs = 60000;

    sealed class ScanRead {
      public long Taken;              // every request numbered up to this one is answered by this read
      public long AtAwake;            // awake ms when the read began (Lanes.AwakeMs)
      public IDictionary Fg;
      public int Quns = -1;
      public uint Own;
      public List<Proc> Procs;
      public string ProcErr, Error;
      public int Asks, Opened;
      public long Ms;
    }

    static readonly object _scanGate = new object();
    static Thread _scanThread;                 // under _scanGate
    static long _wantSeq, _takenSeq;           // under _scanGate
    static ScanRead _last;                     // under _scanGate; never changed once published
    static volatile string _scanStage;         // what the worker is doing now (null = waiting)
    static long _scanStageAt;                  // awake ms the stage began (Interlocked)
    static long _slowLogAt, _slowSkipped;      // under _scanGate
    static long _testStallMs;                  // Interlocked; passive tests only (see Scan)
    static long _readAt;                       // Interlocked: awake ms the worker's current read began

    static void EnsureScanWorker() {
      lock (_scanGate) {
        if (_scanThread != null) return;
        _scanThread = new Thread(ScanLoop);
        _scanThread.IsBackground = true;
        _scanThread.Name = "mantle-gamescan";
        // STA, AboveNormal: what the scan lane was (Lanes.cs), so the calls behave as they always did.
        _scanThread.SetApartmentState(ApartmentState.STA);
        _scanThread.Priority = ThreadPriority.AboveNormal;
        _scanThread.Start();
      }
    }

    /// Starts a read now, so the first caller (the top bar, seconds after start) finds one finished.
    static void WarmScan() {
      EnsureScanWorker();
      lock (_scanGate) { _wantSeq++; Monitor.PulseAll(_scanGate); }
    }

    static void ScanLoop() {
      for (;;) {
        long seq;
        lock (_scanGate) {
          while (_wantSeq <= _takenSeq) Monitor.Wait(_scanGate);
          seq = _takenSeq = _wantSeq;
        }
        ScanRead r;
        try { r = ReadOnce(seq); }
        catch (Exception ex) { r = new ScanRead { Taken = seq, AtAwake = Lanes.AwakeMs(), Error = "the read failed (" + ex.GetType().Name + ": " + ex.Message + ")" }; }
        _scanStage = null;
        lock (_scanGate) { _last = r; Monitor.PulseAll(_scanGate); }
      }
    }

    static void Stage(string what) {
      Interlocked.Exchange(ref _scanStageAt, Lanes.AwakeMs());
      _scanStage = what;
    }

    static string StageNow() {
      string s = _scanStage;
      return s == null ? null : s + " for " + Math.Max(0, Lanes.AwakeMs() - Interlocked.Read(ref _scanStageAt)) + " ms";
    }

    /// One whole read, on the worker: the window in front, the full-screen state, the game verdict, the
    /// process list (sessions asked for new processes only) and the detail of new processes only.
    static ScanRead ReadOnce(long seq) {
      var sw = Stopwatch.StartNew();
      long t0 = Lanes.AwakeMs(), t;
      Interlocked.Exchange(ref _readAt, t0);
      var r = new ScanRead { Taken = seq, AtAwake = t0 };
      long[] ms = new long[5];
      Stage("reading the window in front");
      t = Lanes.AwakeMs();
      IDictionary fg = Foreground.Read();
      ms[0] = Lanes.AwakeMs() - t;
      Stage("asking Windows whether a full-screen app runs");
      t = Lanes.AwakeMs();
      try { r.Quns = QunsNow(); } catch (Exception) { }
      ms[1] = Lanes.AwakeMs() - t;
      Stage("deciding whether the window in front is a game");
      t = Lanes.AwakeMs();
      string exe = fg["exe"] as string ?? "";
      bool covers = fg["fullscreen"] is bool && (bool)fg["fullscreen"];
      int fpid = fg["pid"] is int ? (int)fg["pid"] : 0;
      bool self = fpid != 0 && (fpid == Program.OwnPid || fpid == Program.ParentPid);
      fg["self"] = self;
      fg["verdict"] = self || fpid == 0 ? null : MenuBar.Verdict(exe, fg["title"] as string ?? "", covers, r.Quns);
      r.Fg = fg;
      r.Own = OwnSession();
      ms[2] = Lanes.AwakeMs() - t;
      Stage("listing the processes");
      t = Lanes.AwakeMs();
      long stall = Interlocked.Exchange(ref _testStallMs, 0);   // passive tests only (see Scan)
      if (stall > 0) Thread.Sleep((int)stall);
      string err;
      r.Procs = Snapshot(out err, out r.Asks);
      r.ProcErr = err;
      ms[3] = Lanes.AwakeMs() - t;
      Stage("reading the processes that started since the last look");
      t = Lanes.AwakeMs();
      if (err == null) r.Opened = FillDetail(r.Procs, r.Own);
      ms[4] = Lanes.AwakeMs() - t;
      _scanStage = null;
      r.Ms = sw.ElapsedMilliseconds;
      long awake = Lanes.AwakeMs() - t0;
      if (awake >= ScanSlowLogMs) {
        long skipped = -1;
        lock (_scanGate) {
          if (_slowLogAt != 0 && Lanes.AwakeMs() - _slowLogAt < ScanSlowLogEveryMs) _slowSkipped++;
          else { skipped = _slowSkipped; _slowSkipped = 0; _slowLogAt = Lanes.AwakeMs(); }
        }
        // Step names and counts only: never a window title, an exe name or a path.
        if (skipped >= 0)
          Program.EmitLog("warn", "gamemode.scan: one read took " + awake + " ms (the window in front " + ms[0] + " ms, the full-screen state " +
                                  ms[1] + " ms, the game verdict " + ms[2] + " ms, the process list " + ms[3] + " ms with " + r.Asks +
                                  " session(s) asked, new processes " + ms[4] + " ms with " + r.Opened + " opened); callers got the last read meanwhile" +
                                  (skipped > 0 ? "; " + skipped + " more like it in the last " + (ScanSlowLogEveryMs / 1000) + " s" : ""));
      }
      return r;
    }

    /// {procs?, detail?} -> {fg:{...Foreground.Read(), game verdict}, procs?:[{pid, ppid, file, session,
    /// path?, created?, cpuMs?, prio?, elevated?, why?, pending?}], sessionAsks?, opened?, ownPid, parentPid,
    /// ownSession, fgPid, ms (the read), waitMs (this request), stale?, ageMs?, staleWhy?}
    /// `pending`: a detail row whose first look is still running (only in a stale answer); the plan
    /// leaves it out until the next scan.
    /// DIFF-ONLY ANSWERS (lane mantle-idlefix-game, 2026-10-17). A caller that names itself ("key":
    /// game mode's shared game watch, lib/features/_game-watch.js) is remembered: the rows of its last
    /// answer (pid, parent, exe, session) under a number, sent as "procsGen". When it sends that number
    /// back ("since") on a names-only read, the answer carries only what changed since: "came" = the rows
    /// of pids that are new or whose row differs (a reused pid), "gone" = the pids no longer there, and
    /// "procsSince" = the number they apply to; no "procs" (~310 rows at rest, every read). Any other
    /// since (or none, a detail read, a failed list) gets the whole list as before, so an answer the
    /// caller never got costs one whole list, never a wrong one. Returns true when it answered with changes.
    class ProcBase { public int Gen; public Dictionary<uint, string> Rows; }
    static readonly Dictionary<string, ProcBase> _procBases = new Dictionary<string, ProcBase>();
    static int _procGen;
    const int ProcBaseKeys = 8;   // a handful of callers at most; more = a caller making up keys: start over

    static string RowSig(Proc p) {
      return p.Ppid.ToString(CultureInfo.InvariantCulture) + "|" + (p.File ?? "") + "|" +
             (p.Session == uint.MaxValue ? "-" : p.Session.ToString(CultureInfo.InvariantCulture));
    }

    static bool DiffOnly(Dictionary<string, object> req, ScanRead r, bool detail, List<object> rows, IDictionary res) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key) || r.ProcErr != null || r.Procs == null) return false;
      var now = new Dictionary<uint, string>(r.Procs.Count);
      foreach (Proc p in r.Procs) now[p.Pid] = RowSig(p);
      bool asked = !detail && Json.HasKey(req, "since");
      int since = asked ? Json.GetInt(req, "since", -1) : -1;
      lock (_procBases) {
        ProcBase b;
        bool have = _procBases.TryGetValue(key, out b);
        int gen = ++_procGen;
        res["procsGen"] = (long)gen;
        if (!have && _procBases.Count >= ProcBaseKeys) _procBases.Clear();
        _procBases[key] = new ProcBase { Gen = gen, Rows = now };
        if (!asked || !have || b.Gen != since) return false;
        var came = new List<object>();
        int i = 0;
        foreach (Proc p in r.Procs) {
          string was;
          if (!b.Rows.TryGetValue(p.Pid, out was) || was != now[p.Pid]) came.Add(rows[i]);
          i++;
        }
        var gone = new List<object>();
        foreach (KeyValuePair<uint, string> e in b.Rows) if (!now.ContainsKey(e.Key)) gone.Add((long)e.Key);
        res["came"] = came;
        res["gone"] = gone;
        res["procsSince"] = (long)since;
        return true;
      }
    }

    static string Scan(Dictionary<string, object> req, ref object result) {
      var wait = Stopwatch.StartNew();
      // TESTS ONLY, and only in passive (a scan writes nothing either way): the read this request starts
      // stalls this long while "listing the processes", so test-lane-latency.js can prove a stalled read
      // never holds the lane.
      if (Program.Passive && Json.HasKey(req, "testStallMs"))
        Interlocked.Exchange(ref _testStallMs, Math.Max(0, Math.Min(15000, Json.GetInt(req, "testStallMs", 0))));
      EnsureScanWorker();
      // NOTHING TO ANSWER WITH YET (the sidecar's first read, cold: 0.1 s here, ~4 s on a 2-core CI
      // runner): wait as long as the caller will (its ttl, less a margin), because an error there is
      // worse than a late first answer. Once any read has finished, never more than ScanBudgetMs.
      long ttl = Json.GetInt(req, "ttl", 0);
      long firstMs = ttl > 0 ? Math.Max(ScanBudgetMs, ttl - 250) : FirstReadMs;
      ScanRead r;
      bool fresh;
      lock (_scanGate) {
        long seq = ++_wantSeq;
        Monitor.PulseAll(_scanGate);
        for (;;) {
          if (_last != null && _last.Taken >= seq) break;
          long left = (_last == null ? firstMs : ScanBudgetMs) - wait.ElapsedMilliseconds;
          if (left <= 0) break;
          // The worker is still in an OLDER read that has already run past the budget: it is stuck,
          // and this request's read cannot even start, so waiting is pointless. Answer now. (A second
          // caller queued behind the first one would otherwise pay the budget again.)
          if (_last != null && _takenSeq < seq && _scanStage != null && Lanes.AwakeMs() - Interlocked.Read(ref _readAt) >= ScanBudgetMs) break;
          Monitor.Wait(_scanGate, (int)Math.Min(left, 50));
        }
        r = _last;
        fresh = r != null && r.Taken >= seq;
      }
      string stage = StageNow() ?? "finishing";
      if (r == null) return "gamemode.scan: the first look at the window in front and the processes is still running (" + stage + ")";
      long age = Math.Max(0, Lanes.AwakeMs() - r.AtAwake);
      // Stuck = the read in flight has run past StaleLimitMs (not "the last answer is old": after a
      // quiet minute the last read IS old, and one slow read then is still just slow).
      long running = _scanStage != null ? Math.Max(0, Lanes.AwakeMs() - Interlocked.Read(ref _readAt)) : 0;
      if (!fresh && running > StaleLimitMs)
        return "gamemode.scan: the game check has been stuck for " + (running / 1000) + " s (" + stage + "), so there is no current answer";
      if (r.Error != null) return "gamemode.scan: " + r.Error;
      var fg = new System.Collections.Specialized.OrderedDictionary();
      foreach (DictionaryEntry e in r.Fg) fg[e.Key] = e.Value;
      var res = Json.Obj("fg", fg, "quns", r.Quns, "ownPid", Program.OwnPid, "parentPid", Program.ParentPid,
                         "ownSession", (long)r.Own);
      if (Json.GetBool(req, "procs", false)) {
        bool detail = Json.GetBool(req, "detail", false);
        var rows = new List<object>();
        int pending = 0;
        foreach (Proc p in r.Procs) {
          IDictionary row = Json.Obj("pid", (long)p.Pid, "ppid", (long)p.Ppid, "file", p.File,
                                     "session", p.Session == uint.MaxValue ? (object)null : (long)p.Session);
          if (detail && Detailable(p, r.Own)) {
            Inst i = p.I;
            if (!i.Detailed) { row["pending"] = true; pending++; }
            else {
              string why = i.Why;
              if (why != null) row["why"] = why;
              else {
                if (i.Path != null) row["path"] = i.Path;
                row["created"] = p.Created.ToString(CultureInfo.InvariantCulture);
                row["cpuMs"] = p.CpuMs;
                row["ws"] = p.Ws;
                row["prio"] = PrioOf(p.BasePrio);
                if (i.Elevated != null) row["elevated"] = i.Elevated;
              }
            }
          }
          rows.Add(row);
        }
        if (!DiffOnly(req, r, detail, rows, res)) res["procs"] = rows;
        res["sessionAsks"] = r.Asks;
        res["opened"] = r.Opened;
        if (pending > 0) res["pending"] = pending;
        if (r.ProcErr != null) res["procsReason"] = r.ProcErr;
      }
      res["ms"] = r.Ms;
      res["waitMs"] = wait.ElapsedMilliseconds;
      if (!fresh) {
        res["stale"] = true;
        res["ageMs"] = age;
        res["staleWhy"] = "the game check is still busy " + stage + "; this is the last finished one, " + age + " ms old";
      }
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
      // TESTS ONLY, and only in passive (which writes nothing): stand a process the test started in
      // for "the app in front", so the in-front rule is proved without touching the user's window.
      if (Program.Passive && req.ContainsKey("testFgPid")) fgPid = (uint)Math.Max(0, Json.GetInt(req, "testFgPid", 0));
      // ONE process-list read for the whole batch (lane mantle-lanes, 2026-10-15): it was one read per
      // item, up to CHUNK full lists in a row on the slow lane, each one taking the list lock the game
      // check needs.
      string listErr;
      var names = new Dictionary<uint, string>();
      foreach (Proc p in Snapshot(out listErr)) names[p.Pid] = p.File;
      var outList = new List<object>();
      foreach (object o in items) {
        var it = o as Dictionary<string, object>;
        if (it == null) continue;
        outList.Add(ApplyOne(it, fgPid, own, names));
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

    /// Does this item only LIFT game mode's throttle (Efficiency mode off / Windows' choice, priority
    /// back to normal)? Then it cannot slow the process it names. Anything else is not easing.
    static bool Easing(Dictionary<string, object> it) {
      bool any = false;
      uint c, s;
      if (GetMask(it, "eco", out c, out s)) {
        if ((c & EXECUTION_SPEED) != 0 && (s & EXECUTION_SPEED) != 0) return false;
        any = true;
      }
      string p = Json.GetString(it, "prio");
      if (!string.IsNullOrEmpty(p)) {
        if (p != "normal") return false;
        any = true;
      }
      return any;
    }

    static IDictionary ApplyOne(Dictionary<string, object> it, uint fgPid, uint own, Dictionary<uint, string> names) {
      uint pid = (uint)Math.Max(0, Json.GetInt(it, "pid", 0));
      string wantCreated = Json.GetString(it, "created");
      IDictionary r = Json.Obj("pid", (long)pid, "file", Json.GetString(it, "file"), "ok", false, "same", false);
      uint session;
      if (!N.ProcessIdToSessionId(pid, out session)) { r["why"] = "it has exited"; r["gone"] = true; return r; }
      // Look the name up in the batch's process list (no handle) BEFORE opening anything: a game is never opened.
      string file;
      if (!names.TryGetValue(pid, out file)) { r["why"] = "it has exited"; r["gone"] = true; return r; }
      r["file"] = file;
      // PUTTING BACK is allowed on the app in front (lane sysmon-game, 2026-09-29): the in-front rule is
      // there so game mode never slows what the user is using. It used to refuse the restore too, so the app
      // he was in when the game closed stayed in Efficiency mode at below-normal priority until Mantle
      // restarted. A write that only lifts the throttle can never slow anything.
      if (Easing(it)) fgPid = 0;
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
        // Mantle's MAIN process is never slowed: its desktop layer sits inside Explorer's desktop (97dec56
        // left it out of the plan; this is the copy a bug in main cannot get past). Putting back is allowed.
        // (A passive sidecar writes nothing to it anyway: test-gamemode.js uses its own process for the refusals.)
        if (!Program.Passive && Program.ParentPid > 0 && pid == (uint)Program.ParentPid && !Easing(it)) { r["why"] = "refused: Mantle's main process (slowing it can stall Explorer)"; return r; }
        // A passive (--test) sidecar writes only to the test burner (sidecar/apppower-burner.js), like App power.
        bool passiveNo = Program.Passive && !IsBurner(path);
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
          } else if (passiveNo) {
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
            pr["why"] = "left at " + PrioName(before) + ": it was not " + onlyIf + " (the app or you set it)";
          } else if (passiveNo) {
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
    /// The choice for THAT source (not "whatever source is current"): a restore after the user plugged in
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
