// PingTest.cs - "Run ping test" in the top bar's PING dropdown (lane pingtest, 2026-10-09).
// Owen: "can you make a ping test? do this seperatly asap and push it asap"; where: "In the PING
// dropdown"; extras: "Router ping" AND "Download/upload speed".
//
// ON DEMAND ONLY: nothing here runs until the page sends topbar.pingtest {action:"start"}, so the idle
// cost of the sidecar is unchanged. One run, in three phases:
//   1. PING  every location of the active ping-targets set (TopbarPing's list, the same file) plus the
//            ROUTER (the IPv4 default gateway of the interface Windows routes the internet through,
//            GetBestInterface), Rounds (20) samples each, one per target every PeriodMs (750 ms); the
//            targets' starts are spread across the period, so their samples interleave (~15 s). ICMP;
//            a location that ignores ICMP is timed by a TCP connect (TopbarPing.OnceAsync, 1 s timeout).
//            A row that has not answered its first 3 tries by either is given up on, with the reason.
//            Per row: sent, got, avg, best/worst, jitter (the mean absolute difference of consecutive
//            replies), loss %.
//   2. DOWN  HTTPS GET speed.cloudflare.com/__down?bytes=N (Cloudflare's own public speed test, no key)
//            on DownStreams (4) connections at once, until DownMs (8 s) or DownBytes (60 MB), first wins.
//   3. UP    HTTPS POST speed.cloudflare.com/__up, UpStreams (3) connections, UpMs (6 s) or UpBytes (25 MB).
//   Mbps = the bytes after the ramp (the first second of data, at most 30% of it) over the time after it.
//   An endpoint that has sent nothing after AnswerMs (5 s) fails the phase with that reason.
// CANCEL aborts every HTTP request at once and stops every ping loop (a ping in flight ends within its
// 1 s timeout, into the cancelled run's state, which nothing shows any more). Closing the dropdown does
// not cancel. The last run (its times, rows, speeds, reasons) stays until the next start; the page asks
// for it on load (action "state").
//
// EVENTS `pingtest`: the whole run state, at most every EmitEveryMs (250) while it runs, and at once on
// every phase change and at the end.
//
// HARD RULE (as TopbarPing): plain pings and HTTP to public endpoints only. Nothing here reads, touches
// or talks to Riot's client, its local API, VALORANT or Vanguard.
//
// TEST ONLY (--passive sidecars): MANTLE_SPEEDTEST_URL swaps the speed endpoint (a local server), and
// the start command's "test" object shortens rounds / period / caps or names the router ("none" = no
// router found). A live sidecar ignores both.
//
// C# 5 (see build.ps1).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Mantle {
  [MantleFeature]
  static class PingTest {
    public static void Register(FeatureTable t) {
      t.Add("topbar.pingtest", Lanes.Ui, Cmd);   // action: "start" | "cancel" | "state"
    }

    const string Endpoint = "https://speed.cloudflare.com";
    const int AnswerMs = 5000, EmitEveryMs = 250, BufLen = 65536, GiveUpAfter = 3;
    const int DownStreams = 4, UpStreams = 3;
    const long DownChunk = 10000000, UpChunk = 5000000;

    [DllImport("iphlpapi.dll")] static extern int GetBestInterface(uint destAddr, out uint bestIfIndex);

    sealed class Caps {
      public int Rounds = 20, PeriodMs = 750, DownMs = 8000, UpMs = 6000;
      public long DownBytes = 60000000, UpBytes = 25000000;
      public string Router;   // test only: an address, or "none"
      public string[] Wifi;   // test only: the Wi-Fi name at the start and at the end ("A,B")
    }
    sealed class Net { public NetworkInterface Ni; public IPAddress Gw; public string Why; }
    sealed class Row {
      public string Kind, Name, Host, Via, Method, Why, Iface;
      public bool Wifi;
      public int Port;
      public IPAddress Ip;
      public readonly List<double> S = new List<double>();   // -1 = lost
      public bool GaveUp;
    }
    sealed class Speed {
      public string State = "waiting", Why;
      public long Bytes, Ms;
      public double Mbps = -1, Live = -1;
    }
    sealed class Run {
      public int Id;
      public string Phase = "starting", Why, Label = "Ping", Test, Url, Host, ListWhy, RouterWhy, WifiChanged;
      public IDictionary Wifi;   // the network at the start: kind, name, why (WifiOf)
      public long StartedAt, EndedAt;   // unix ms; EndedAt 0 while it runs
      public Stopwatch Clock = Stopwatch.StartNew();
      public readonly List<Row> Rows = new List<Row>();
      public readonly Speed Down = new Speed(), Up = new Speed();
      public Caps Caps;
      public int PingDone, PingTotal;
      public CancellationTokenSource Cts = new CancellationTokenSource();
      public readonly List<WebRequest> Live = new List<WebRequest>();
      public long LastEmit = long.MinValue / 2;
    }

    static readonly object _g = new object();
    static Run _cur;
    static int _runs;
    static readonly byte[] UpBuf = MakeUpBuf();

    static byte[] MakeUpBuf() { var b = new byte[BufLen]; new Random(7).NextBytes(b); return b; }

    // ------------------------------------------------------------------ the command

    static string Cmd(Dictionary<string, object> req, ref object result) {
      string action = Json.GetString(req, "action") ?? "state";
      Run r;
      if (action == "start") {
        lock (_g) {
          if (_cur != null && _cur.EndedAt == 0) return "a ping test is already running";
          r = new Run();
          r.Id = ++_runs;
          r.Caps = new Caps();
          r.StartedAt = UnixMs();
          r.Url = Endpoint;
          object o;
          if (Program.Passive) {
            string env = Environment.GetEnvironmentVariable("MANTLE_SPEEDTEST_URL");
            if (!string.IsNullOrEmpty(env)) { r.Url = env.TrimEnd('/'); r.Test = "test speed endpoint from MANTLE_SPEEDTEST_URL: " + r.Url; }
            if (req.TryGetValue("test", out o) && o is Dictionary<string, object>) {
              TestCaps((Dictionary<string, object>)o, r.Caps);
              r.Test = (r.Test != null ? r.Test + "; " : "") + "test caps from the command";
            }
          }
          try { r.Host = new Uri(r.Url).Host; } catch (Exception) { r.Host = r.Url; }
          _cur = r;
        }
        Run started = r;
        Task.Run(delegate { return RunAsync(started); });
      } else if (action == "cancel") {
        lock (_g) r = _cur;
        Cancel(r);
      } else if (action != "state") {
        return "Mantle does not know that ping test request";
      }
      lock (_g) r = _cur;
      result = r != null ? Snapshot(r) : Json.Obj("phase", "idle", "caps", CapsObj(new Caps()), "host", new Uri(Endpoint).Host);
      return null;
    }

    static void TestCaps(Dictionary<string, object> t, Caps c) {
      c.Rounds = Clamp(Json.GetInt(t, "rounds", c.Rounds), 1, 50);
      c.PeriodMs = Clamp(Json.GetInt(t, "periodMs", c.PeriodMs), 50, 2000);
      c.DownMs = Clamp(Json.GetInt(t, "downMs", c.DownMs), 200, 20000);
      c.UpMs = Clamp(Json.GetInt(t, "upMs", c.UpMs), 200, 20000);
      object o;
      if (t.TryGetValue("downBytes", out o) && o is double) c.DownBytes = Math.Max(1000, Math.Min(c.DownBytes, (long)(double)o));
      if (t.TryGetValue("upBytes", out o) && o is double) c.UpBytes = Math.Max(1000, Math.Min(c.UpBytes, (long)(double)o));
      c.Router = Json.GetString(t, "router");
      string w = Json.GetString(t, "wifi");
      if (!string.IsNullOrEmpty(w)) { string[] p = w.Split(','); c.Wifi = new[] { p[0], p.Length > 1 ? p[1] : p[0] }; }
    }

    static void Cancel(Run r) {
      if (r == null) return;
      lock (_g) {
        if (r.EndedAt != 0) return;
        r.Phase = "cancelled"; r.EndedAt = UnixMs();
        if (r.Down.State == "running") r.Down.State = "cancelled";
        if (r.Up.State == "running") r.Up.State = "cancelled";
      }
      try { r.Cts.Cancel(); } catch (Exception) { }
      AbortAll(r);
      Emit(r, true);
    }

    static void AbortAll(Run r) {
      WebRequest[] live;
      lock (_g) live = r.Live.ToArray();
      foreach (WebRequest q in live) { try { q.Abort(); } catch (Exception) { } }
    }

    // ------------------------------------------------------------------ one run

    static async Task RunAsync(Run r) {
      CancellationToken ct = r.Cts.Token;
      try {
        Emit(r, true);
        if (!TopbarPing.Online()) { Finish(r, "failed", "offline: Windows reports no network connection"); return; }
        string label, err;
        List<TopbarPing.TargetCopy> targets = TopbarPing.CopyTargets(out label, out err);
        Net net = await Task.Run(delegate { return FindNet(); }).ConfigureAwait(false);
        Row router = FindRouter(r, net);
        IDictionary wifi = WifiOf(net, r.Caps, false);
        lock (_g) {
          r.Wifi = wifi;
          r.Label = label;
          r.ListWhy = err;
          if (router != null) r.Rows.Add(router);
          if (err == null) foreach (TopbarPing.TargetCopy t in targets)
            r.Rows.Add(new Row { Kind = "server", Name = t.Name, Host = t.Host, Via = t.Via, Port = t.Port, Method = t.Method, Ip = t.Ip });
        }
        ct.ThrowIfCancellationRequested();
        // fresh addresses for the servers (a DNS answer can move); one that cannot be looked up keeps its why
        var looks = new List<Task>();
        foreach (Row w in r.Rows) if (w.Kind == "server") looks.Add(Resolve(w));
        await Task.WhenAll(looks).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();

        SetPhase(r, "ping");
        await PingPhase(r, ct).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();

        SetPhase(r, "down");
        bool reached = await SpeedPhase(r, true, ct).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        if (reached) {
          SetPhase(r, "up");
          await SpeedPhase(r, false, ct).ConfigureAwait(false);
          ct.ThrowIfCancellationRequested();
        } else lock (_g) { r.Up.State = "skipped"; r.Up.Why = "upload skipped: the download could not reach " + r.Host; }
        // the network again: a test that moved networks half-way says so
        IDictionary end = WifiOf(await Task.Run(delegate { return FindNet(); }).ConfigureAwait(false), r.Caps, true);
        string a = NetWords(wifi), b = NetWords(end);
        if (a != b) lock (_g) r.WifiChanged = "the network changed during the test: " + a + " at the start, " + b + " at the end";
        Finish(r, "done", null);
      } catch (OperationCanceledException) {
        Cancel(r);
      } catch (Exception ex) {
        Finish(r, "failed", "the ping test stopped: " + TopbarPing.Inner(ex).Message.TrimEnd('.'));
      }
    }

    static void SetPhase(Run r, string phase) {
      lock (_g) { if (r.EndedAt != 0) return; r.Phase = phase; }
      Emit(r, true);
    }

    static void Finish(Run r, string phase, string why) {
      lock (_g) {
        if (r.EndedAt != 0) return;   // cancelled first: that stands
        r.Phase = phase; r.Why = why; r.EndedAt = UnixMs();
      }
      AbortAll(r);
      Emit(r, true);
    }

    // ------------------------------------------------------------------ the router

    static Row FindRouter(Run r, Net n) {
      string forced = r.Caps.Router;
      if (forced != null) {
        IPAddress fip;
        if (forced == "none" || !IPAddress.TryParse(forced, out fip)) { lock (_g) r.RouterWhy = "no router found: Windows reports no default gateway (test)"; return null; }
        return new Row { Kind = "router", Name = "Your router", Host = forced, Ip = fip, Via = "test router", Iface = "test" };
      }
      if (n.Ni == null) { lock (_g) r.RouterWhy = n.Why; return null; }
      bool wifi = n.Ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211;
      return new Row { Kind = "router", Name = "Your router", Host = n.Gw.ToString(), Ip = n.Gw, Via = n.Ni.Name, Iface = n.Ni.Name, Wifi = wifi };
    }

    /// The interface Windows routes the internet through (GetBestInterface to 1.1.1.1) and its IPv4
    /// default gateway; else the first interface that has one; else Why.
    static Net FindNet() {
      var n = new Net();
      uint idx = 0;
      int rc = -1;
      try { rc = GetBestInterface(BitConverter.ToUInt32(IPAddress.Parse("1.1.1.1").GetAddressBytes(), 0), out idx); } catch (Exception) { }
      NetworkInterface pick = null, first = null;
      IPAddress pickGw = null, firstGw = null;
      try {
        foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces()) {
          if (ni.OperationalStatus != OperationalStatus.Up) continue;
          if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
          IPInterfaceProperties ip;
          try { ip = ni.GetIPProperties(); } catch (Exception) { continue; }
          IPAddress gw = null;
          foreach (GatewayIPAddressInformation g in ip.GatewayAddresses)
            if (g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any)) { gw = g.Address; break; }
          if (gw == null) continue;
          int i4 = -1;
          try { IPv4InterfaceProperties p4 = ip.GetIPv4Properties(); if (p4 != null) i4 = p4.Index; } catch (Exception) { }
          if (rc == 0 && i4 == (int)idx) { pick = ni; pickGw = gw; break; }
          if (first == null) { first = ni; firstGw = gw; }
        }
      } catch (Exception ex) {
        n.Why = "no router found: Windows would not list the network adapters (" + ex.Message.TrimEnd('.') + ")";
        return n;
      }
      if (pick == null) { pick = first; pickGw = firstGw; }
      if (pick == null) { n.Why = "no router found: Windows reports no default gateway"; return n; }
      n.Ni = pick; n.Gw = pickGw;
      return n;
    }

    // ------------------------------------------------------------------ the Wi-Fi it ran on

    /// { kind: "wifi" | "ethernet" | "other" | "none", name, why, iface }. A Wi-Fi whose name Windows
    /// withholds has name null and why in words, never a blank.
    static IDictionary WifiOf(Net n, Caps c, bool atEnd) {
      if (c.Wifi != null) return Json.Obj("kind", "wifi", "name", c.Wifi[atEnd ? 1 : 0], "why", null, "iface", "test");
      if (n.Ni == null) return Json.Obj("kind", "none", "name", null, "why", "no network: " + (n.Why ?? "Windows reports no connection"), "iface", null);
      NetworkInterfaceType t = n.Ni.NetworkInterfaceType;
      if (t == NetworkInterfaceType.Wireless80211) {
        string why;
        string ssid = Ssid(n.Ni.Id, out why);
        return Json.Obj("kind", "wifi", "name", ssid, "why", ssid == null ? why : null, "iface", n.Ni.Name);
      }
      if (t == NetworkInterfaceType.Ethernet || t == NetworkInterfaceType.GigabitEthernet || t == NetworkInterfaceType.FastEthernetT || t == NetworkInterfaceType.FastEthernetFx)
        return Json.Obj("kind", "ethernet", "name", "Ethernet", "why", null, "iface", n.Ni.Name);
      return Json.Obj("kind", "other", "name", n.Ni.Name, "why", null, "iface", n.Ni.Name);
    }

    static string NetWords(IDictionary w) {
      string name = w["name"] as string;
      if (name != null) return (string)w["kind"] == "wifi" ? "Wi-Fi \"" + name + "\"" : name;
      return (string)w["kind"] == "wifi" ? "Wi-Fi (" + (w["iface"] as string ?? "name hidden") + ")" : "no network";
    }

    /// The SSID of the adapter's current connection (wlanapi, read-only), or null with why. Windows 11
    /// 24H2 gives it only to apps allowed to see the location: then why says which switch is off.
    static string Ssid(string adapterId, out string why) {
      why = null;
      Guid g;
      try { g = new Guid(adapterId); } catch (Exception) { why = "Wi-Fi name unknown: Windows gave no id for the adapter"; return null; }
      IntPtr h = IntPtr.Zero, data = IntPtr.Zero;
      uint neg, size;
      uint rc = Win32.WlanOpenHandle(2, IntPtr.Zero, out neg, out h);
      if (rc != 0) { why = "Wi-Fi name unknown: the Wi-Fi service did not answer (error " + rc + ")"; return null; }
      try {
        rc = Win32.WlanQueryInterface(h, ref g, Win32.WLAN_INTF_OPCODE_CURRENT_CONNECTION, IntPtr.Zero, out size, out data, IntPtr.Zero);
        if (rc == 5) { why = "Wi-Fi name hidden by Windows: " + LocationWhy(); return null; }
        if (rc != 0 || data == IntPtr.Zero) { why = "Wi-Fi name unknown: Windows would not say (error " + rc + ")"; return null; }
        var conn = (Win32.WLAN_CONNECTION_ATTRIBUTES)Marshal.PtrToStructure(data, typeof(Win32.WLAN_CONNECTION_ATTRIBUTES));
        var s = conn.wlanAssociationAttributes.dot11Ssid;
        int len = (int)s.uSSIDLength;
        if (s.ucSSID == null || len <= 0 || len > 32) { why = "Wi-Fi name hidden by Windows: " + LocationWhy(); return null; }
        return Encoding.UTF8.GetString(s.ucSSID, 0, len);
      } catch (Exception ex) {
        why = "Wi-Fi name unknown: " + ex.Message.TrimEnd('.');
        return null;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
        Win32.WlanCloseHandle(h, IntPtr.Zero);
      }
    }

    static string LocationWhy() {
      const string K = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location";
      string e;
      string machine = SysCommon.Read("HKLM", K, "Value", out e) as string;
      string user = SysCommon.Read("HKCU", K, "Value", out e) as string;
      string desktop = SysCommon.Read("HKCU", K + @"\NonPackaged", "Value", out e) as string;
      if (machine != null && machine != "Allow") return "location services are off for this PC (Settings > Privacy & security > Location)";
      if (user != null && user != "Allow") return "Location access is off for your account (Settings > Privacy & security > Location)";
      if (desktop != null && desktop != "Allow") return "Location access is off for desktop apps (Settings > Privacy & security > Location > Let desktop apps access your location)";
      return "Windows shares Wi-Fi names only with apps allowed to see your location";
    }

    static async Task Resolve(Row w) {
      try {
        Task<IPAddress[]> look = Dns.GetHostAddressesAsync(w.Host);
        if (await Task.WhenAny(look, Task.Delay(3000)).ConfigureAwait(false) != look) {
          var ignored = look.ContinueWith(delegate (Task<IPAddress[]> x) { var e = x.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
          if (w.Ip == null) lock (_g) w.Why = "could not look up " + w.Host + " in 3 s";
          return;
        }
        IPAddress[] addrs = await look.ConfigureAwait(false);
        IPAddress ip = null;
        foreach (IPAddress a in addrs) if (a.AddressFamily == AddressFamily.InterNetwork) { ip = a; break; }
        if (ip == null && addrs.Length > 0) ip = addrs[0];
        lock (_g) { if (ip != null) w.Ip = ip; else if (w.Ip == null) w.Why = "could not look up " + w.Host; }
      } catch (Exception ex) {
        if (w.Ip == null) lock (_g) w.Why = "could not look up " + w.Host + ": " + TopbarPing.Inner(ex).Message.TrimEnd('.');
      }
    }

    // ------------------------------------------------------------------ 1. ping

    static async Task PingPhase(Run r, CancellationToken ct) {
      var rows = new List<Row>();
      lock (_g) { foreach (Row w in r.Rows) if (w.Ip != null) rows.Add(w); r.PingTotal = rows.Count * r.Caps.Rounds; }
      long start = r.Clock.ElapsedMilliseconds;
      var jobs = new List<Task>();
      for (int i = 0; i < rows.Count; i++) jobs.Add(PingRow(r, rows[i], start + (long)i * r.Caps.PeriodMs / Math.Max(1, rows.Count), ct));
      await Task.WhenAll(jobs).ConfigureAwait(false);
    }

    static async Task PingRow(Run r, Row w, long at0, CancellationToken ct) {
      int rounds = r.Caps.Rounds, period = r.Caps.PeriodMs;
      string who = w.Kind == "router" ? "your router (" + w.Host + ")" : r.Label + " " + w.Name;
      int port = w.Kind == "router" ? 0 : w.Port;   // the router: ICMP only
      for (int k = 0; k < rounds; k++) {
        long wait = at0 + (long)k * period - r.Clock.ElapsedMilliseconds;
        if (wait > 0) await Task.Delay((int)wait, ct).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        string method;
        lock (_g) method = w.Method;
        TopbarPing.Rt rt;
        using (var p = new Ping()) rt = await TopbarPing.OnceAsync(who, w.Ip, port, method, p).ConfigureAwait(false);
        if (ct.IsCancellationRequested) return;
        bool giveUp = false;
        lock (_g) {
          w.S.Add(rt.Ms);
          r.PingDone++;
          if (rt.Ms >= 0) { if (w.Method == null) w.Method = rt.Method; }
          else {
            w.Why = rt.Why;
            if (w.Method == null && w.S.Count >= GiveUpAfter && Got(w) == 0) {
              giveUp = true; w.GaveUp = true;
              r.PingDone += rounds - w.S.Count;   // the rest of its rounds are not coming
            }
          }
        }
        Emit(r, false);
        if (giveUp) return;
      }
    }

    static int Got(Row w) { int n = 0; foreach (double s in w.S) if (s >= 0) n++; return n; }

    // ------------------------------------------------------------------ 2 and 3. speed

    sealed class Ctl {
      public long Cap, Reserved, Bytes;
      public bool Stop, Answered, Unreached, Refused;
      public string Why;
      public int Failed;
    }

    /// Returns false when the endpoint could not be reached at all (the upload is then skipped).
    static async Task<bool> SpeedPhase(Run r, bool down, CancellationToken ct) {
      Speed sp = down ? r.Down : r.Up;
      var c = new Ctl { Cap = down ? r.Caps.DownBytes : r.Caps.UpBytes };
      int capMs = down ? r.Caps.DownMs : r.Caps.UpMs, n = down ? DownStreams : UpStreams;
      lock (_g) sp.State = "running";
      var sw = Stopwatch.StartNew();
      var jobs = new Task[n];
      for (int i = 0; i < n; i++) jobs[i] = down ? DownWorker(r, c, ct) : UpWorker(r, c, ct);
      Task all = Task.WhenAll(jobs);
      var ts = new List<double>();
      var bs = new List<long>();
      ts.Add(0); bs.Add(0);
      while (true) {
        await Task.WhenAny(all, Task.Delay(100)).ConfigureAwait(false);
        double t = sw.Elapsed.TotalMilliseconds;
        long b = Interlocked.Read(ref c.Bytes);
        ts.Add(t); bs.Add(b);
        double live = -1;
        for (int j = ts.Count - 1; j >= 0; j--) if (t - ts[j] >= 1000 || j == 0) { if (t - ts[j] > 150 && b > 0) live = (b - bs[j]) * 8.0 / ((t - ts[j]) / 1000.0) / 1e6; break; }
        lock (_g) { sp.Bytes = b; sp.Ms = (long)t; sp.Live = live; }
        Emit(r, false);
        if (ct.IsCancellationRequested || all.IsCompleted || t >= capMs || b >= c.Cap) break;
        bool answered; lock (c) answered = c.Answered;
        if (!answered && t >= AnswerMs) { lock (c) { if (c.Why == null) c.Why = r.Host + " did not answer in " + (AnswerMs / 1000) + " s"; c.Unreached = true; } break; }
      }
      lock (c) {
        c.Stop = true;
        // the time cap came before AnswerMs (short test caps) with nothing back: the same words
        if (!c.Answered && c.Why == null && !ct.IsCancellationRequested) { c.Why = r.Host + " did not answer in " + Math.Max(1, (int)Math.Round(sw.Elapsed.TotalSeconds)) + " s"; c.Unreached = true; }
      }
      AbortAll(r);
      await Task.WhenAny(all, Task.Delay(2000)).ConfigureAwait(false);
      ct.ThrowIfCancellationRequested();
      double mbps = Mbps(ts, bs);
      string why; bool unreached, refused;
      lock (c) { why = c.Why; unreached = c.Unreached || !c.Answered; refused = c.Refused; }
      lock (_g) {
        sp.Bytes = Interlocked.Read(ref c.Bytes);
        sp.Live = -1;
        if (mbps > 0 && !refused) { sp.State = "ok"; sp.Mbps = Math.Round(mbps, 1); sp.Why = null; }
        else { sp.State = "failed"; sp.Why = (down ? "download" : "upload") + ": " + (why ?? "no data moved in " + Math.Round(sw.Elapsed.TotalSeconds) + " s"); }
      }
      Emit(r, true);
      return !(sp.State == "failed" && unreached);
    }

    /// Mbps after the ramp: the first second of data (at most 30% of it) is TCP finding its speed.
    static double Mbps(List<double> ts, List<long> bs) {
      int last = ts.Count - 1;
      if (last < 1 || bs[last] <= 0) return -1;
      int f = 0;
      while (f < last && bs[f + 1] == 0) f++;   // ts[f]: the last sample before data arrived
      double span = ts[last] - ts[f];
      if (span <= 0) return -1;
      double ramp = Math.Min(1000, 0.3 * span);
      int k = f;
      while (k < last && ts[k] < ts[f] + ramp) k++;
      double dt = ts[last] - ts[k];
      if (dt >= 300) return (bs[last] - bs[k]) * 8.0 / (dt / 1000.0) / 1e6;
      return bs[last] * 8.0 / (span / 1000.0) / 1e6;
    }

    static long Reserve(Ctl c, long chunk) {
      lock (c) {
        if (c.Stop) return 0;
        long want = Math.Min(chunk, c.Cap - c.Reserved);
        if (want <= 0) return 0;
        c.Reserved += want;
        return want;
      }
    }

    static void Fail(Ctl c, Run r, Exception ex, CancellationToken ct) {
      lock (c) {
        if (c.Stop || ct.IsCancellationRequested) return;   // our own abort, not a failure
        c.Failed++;
        if (c.Why == null) c.Why = Explain(r, ex);
        var we = TopbarPing.Inner(ex) as WebException;
        if (we != null && we.Response != null) { c.Answered = true; c.Refused = true; }   // it answered, with a refusal (HTTP 4xx/5xx)
        else if (!c.Answered) c.Unreached = true;
      }
    }

    static string Explain(Run r, Exception ex) {
      var we = TopbarPing.Inner(ex) as WebException;
      if (we != null) {
        var resp = we.Response as HttpWebResponse;
        if (resp != null) return r.Host + " refused it (HTTP " + (int)resp.StatusCode + " " + resp.StatusDescription + ")";
        if (we.Status == WebExceptionStatus.Timeout) return r.Host + " did not answer in " + (AnswerMs / 1000) + " s";
        if (we.Status == WebExceptionStatus.NameResolutionFailure) return "could not look up " + r.Host;
        if (we.Status == WebExceptionStatus.ConnectFailure) return "could not connect to " + r.Host;
        if (we.Status == WebExceptionStatus.TrustFailure || we.Status == WebExceptionStatus.SecureChannelFailure) return "a secure connection to " + r.Host + " could not be made (" + we.Message.TrimEnd('.') + ")";
        return r.Host + " could not be reached: " + we.Message.TrimEnd('.');
      }
      return r.Host + ": " + TopbarPing.Inner(ex).Message.TrimEnd('.');
    }

    static HttpWebRequest Make(Run r, string url, string method) {
      try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch (Exception) { }
      var q = (HttpWebRequest)WebRequest.Create(url);
      q.Method = method;
      q.KeepAlive = true;
      q.AllowAutoRedirect = false;
      q.UserAgent = "Mantle ping test";
      q.Timeout = AnswerMs;
      q.ReadWriteTimeout = AnswerMs;
      q.Headers["Cache-Control"] = "no-store";
      ServicePoint sp = q.ServicePoint;
      if (sp.ConnectionLimit < 8) sp.ConnectionLimit = 8;
      sp.Expect100Continue = false;
      sp.UseNagleAlgorithm = false;
      lock (_g) r.Live.Add(q);
      return q;
    }

    static void Done(Run r, WebRequest q) { lock (_g) r.Live.Remove(q); }

    static async Task DownWorker(Run r, Ctl c, CancellationToken ct) {
      var buf = new byte[BufLen];
      while (!ct.IsCancellationRequested) {
        long want = Reserve(c, DownChunk);
        if (want <= 0) return;
        HttpWebRequest q = Make(r, r.Url + "/__down?bytes=" + want, "GET");
        try {
          using (var resp = (HttpWebResponse)await q.GetResponseAsync().ConfigureAwait(false)) {
            lock (c) c.Answered = true;
            using (Stream s = resp.GetResponseStream()) {
              int got;
              while ((got = await s.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0) {
                Interlocked.Add(ref c.Bytes, got);
                bool stop; lock (c) stop = c.Stop;
                if (stop || ct.IsCancellationRequested) { q.Abort(); return; }
              }
            }
          }
        } catch (Exception ex) {
          Fail(c, r, ex, ct);
          return;
        } finally {
          Done(r, q);
        }
      }
    }

    static async Task UpWorker(Run r, Ctl c, CancellationToken ct) {
      while (!ct.IsCancellationRequested) {
        long want = Reserve(c, UpChunk);
        if (want <= 0) return;
        HttpWebRequest q = Make(r, r.Url + "/__up", "POST");
        q.ContentType = "application/octet-stream";
        q.ContentLength = want;
        q.AllowWriteStreamBuffering = false;
        try {
          Stream s = await q.GetRequestStreamAsync().ConfigureAwait(false);
          lock (c) c.Answered = true;
          long left = want;
          while (left > 0) {
            int n = (int)Math.Min(BufLen, left);
            await s.WriteAsync(UpBuf, 0, n).ConfigureAwait(false);
            Interlocked.Add(ref c.Bytes, n);
            left -= n;
            bool stop; lock (c) stop = c.Stop;
            if (stop || ct.IsCancellationRequested) { q.Abort(); try { s.Dispose(); } catch (Exception) { } return; }
          }
          s.Dispose();
          using (var resp = (HttpWebResponse)await q.GetResponseAsync().ConfigureAwait(false)) { }
        } catch (Exception ex) {
          Fail(c, r, ex, ct);
          return;
        } finally {
          Done(r, q);
        }
      }
    }

    // ------------------------------------------------------------------ the state, as JSON

    static void Emit(Run r, bool now) {
      IDictionary snap;
      lock (_g) {
        long t = r.Clock.ElapsedMilliseconds;
        if (!now && t - r.LastEmit < EmitEveryMs) return;
        if (r != _cur) return;   // an old run, cancelled and replaced: nothing shows it any more
        r.LastEmit = t;
        snap = Snapshot(r);
      }
      Features.Event("pingtest", snap);
    }

    static IDictionary CapsObj(Caps c) {
      return Json.Obj("rounds", c.Rounds, "periodMs", c.PeriodMs, "downMs", c.DownMs, "downBytes", c.DownBytes,
                      "upMs", c.UpMs, "upBytes", c.UpBytes, "answerMs", AnswerMs, "downStreams", DownStreams, "upStreams", UpStreams);
    }

    static IDictionary SpeedObj(Speed s) {
      return Json.Obj("state", s.State, "mbps", s.Mbps >= 0 ? (object)s.Mbps : null, "live", s.Live >= 0 ? (object)Math.Round(s.Live, 1) : null,
                      "bytes", s.Bytes, "ms", s.Ms, "why", s.Why);
    }

    static IDictionary Snapshot(Run r) {
      lock (_g) {
        var rows = new List<object>();
        int best = -1;
        double bestAvg = double.MaxValue;
        bool any = false;
        var objs = new List<IDictionary>();
        for (int i = 0; i < r.Rows.Count; i++) {
          Row w = r.Rows[i];
          int got = 0; double sum = 0, mn = double.MaxValue, mx = -1, jsum = 0, prev = -1; int jn = 0;
          foreach (double s in w.S) {
            if (s < 0) continue;
            got++; sum += s; if (s < mn) mn = s; if (s > mx) mx = s;
            if (prev >= 0) { jsum += Math.Abs(s - prev); jn++; }
            prev = s;
          }
          int sent = w.S.Count;
          object avg = got > 0 ? (object)Math.Round(sum / got, 1) : null;
          double loss = sent > 0 ? (sent - got) * 100.0 / sent : 0;
          var o = Json.Obj("kind", w.Kind, "name", w.Name, "host", w.Host, "via", w.Via, "method", w.Method,
                           "sent", sent, "got", got, "avg", avg,
                           "min", got > 0 ? (object)Math.Round(mn, 1) : null, "max", got > 0 ? (object)Math.Round(mx, 1) : null,
                           "jitter", jn > 0 ? (object)Math.Round(jsum / jn, 1) : null,
                           "loss", sent > 0 ? (object)Math.Round(loss) : null,
                           "last", sent > 0 && w.S[sent - 1] >= 0 ? (object)Math.Round(w.S[sent - 1], 1) : null,
                           "why", got == 0 || w.GaveUp ? (w.Why ?? (w.Ip == null ? "could not look up " + w.Host : null)) : null,
                           "gaveUp", w.GaveUp, "best", false);
          if (w.Kind == "router") { o["iface"] = w.Iface; o["wifi"] = w.Wifi; }
          // best: the lowest average among the servers that answered at least half their pings
          if (w.Kind == "server" && got > 0 && got * 2 >= sent && sum / got < bestAvg) { bestAvg = sum / got; best = i; any = true; }
          objs.Add(o);
        }
        if (any && r.Phase != "ping" && r.Phase != "starting") objs[best]["best"] = true;
        foreach (IDictionary o in objs) rows.Add(o);
        long now = UnixMs();
        double prog = 0;
        // progress over the whole run: ping 50%, download 25%, upload 25% (by time caps, close to real)
        if (r.Phase == "ping") prog = r.PingTotal > 0 ? 0.5 * r.PingDone / r.PingTotal : 0;
        else if (r.Phase == "down") prog = 0.5 + 0.25 * Math.Min(1.0, Math.Max((double)r.Down.Ms / r.Caps.DownMs, (double)r.Down.Bytes / r.Caps.DownBytes));
        else if (r.Phase == "up") prog = 0.75 + 0.25 * Math.Min(1.0, Math.Max((double)r.Up.Ms / r.Caps.UpMs, (double)r.Up.Bytes / r.Caps.UpBytes));
        else if (r.Phase == "done") prog = 1;
        return Json.Obj("run", r.Id, "phase", r.Phase, "running", r.EndedAt == 0, "why", r.Why,
                        "startedAt", r.StartedAt, "endedAt", r.EndedAt == 0 ? null : (object)r.EndedAt,
                        "elapsedMs", (r.EndedAt == 0 ? now : r.EndedAt) - r.StartedAt,
                        "progress", Math.Round(prog, 3), "pingDone", r.PingDone, "pingTotal", r.PingTotal,
                        "label", r.Label, "listWhy", r.ListWhy, "routerWhy", r.RouterWhy, "rows", rows,
                        "wifi", r.Wifi, "wifiChanged", r.WifiChanged,
                        "down", SpeedObj(r.Down), "up", SpeedObj(r.Up), "host", r.Host,
                        "caps", CapsObj(r.Caps), "test", r.Test);
      }
    }

    static long UnixMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
    static int Clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
  }
}
