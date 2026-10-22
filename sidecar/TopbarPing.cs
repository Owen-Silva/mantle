// TopbarPing.cs - the PING readout right of NET on the top bar (lane topbar-ping, 2026-10-09).
// The user: "can we have something up on the topbar to the right of the NET that shows my ping?", then
// "can you ping the valorant server?"
//
// WHAT IT MEASURES: the round trip to the VALORANT data centre he would play on. Riot's game servers
// do not answer ping, so each NA location is stood in for by a public endpoint in that place (AWS
// region endpoints, Akamai/Linode speed-test hosts). The list is DATA: sidecar/ping-targets.json
// (beside bin\, so a git checkout carries it), one set per game/region; add a set, point "use" at it.
//
// HARD RULE (the user, 2026-10-09): plain network round trips to public endpoints ONLY. Nothing here
// reads Riot's lockfile or local API, looks at or into any Riot/VALORANT/Vanguard process, or holds
// any Riot token. Vanguard is a kernel anti-cheat and his account matters more than accuracy.
//
// HOW: System.Net.NetworkInformation.Ping (IcmpSendEcho2 underneath: no ping.exe, no process
// spawned), SendPingAsync with a 1 s timeout. A host that never answers ICMP falls back to a TCP
// connect to its port (443): SYN -> SYN/ACK is one round trip; the socket is closed at once, no TLS.
//   PICK  at start, every pickEveryMin (10) minutes, and after 3 misses in a row on the chosen one:
//         every target 3 times (targets in parallel), the lowest round trip wins - what Valorant's
//         matchmaking does with its own pings. While nothing is chosen yet the bar says measuring;
//         a later re-pick runs while the current one keeps showing. Nothing answers: "--" plus why,
//         and a fresh pick every 15 s.
//   ECHO  the chosen one every 2 s, never two in flight, started from TopbarStats' 1 s sampler tick
//         (Step), so it pauses with the stats (bar hidden, session locked, screen off). Replies land
//         on the thread pool, which only stores them; the NEXT 1 s sample carries them.
//
// PAYLOAD `ping` in every topbarstats sample: state "measuring" | "ok" | "timeout" | "offline" |
// "unreachable" | "error"; ms (null unless ok); label ("Valorant"); server, host, via, method;
// reason in plain words when not ok; picked (each target's best from the last pick, or its why).
//
// TEST ONLY: MANTLE_PING_TARGETS=<path to a targets json> swaps the list, and only in a --passive
// sidecar (test instances and sidecar tests); a live sidecar ignores it.
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
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Mantle {
  static class TopbarPing {
    public const int EveryMs = 2000, TimeoutMs = 1000, MissesToRepick = 3, TriesPerPick = 3, RetryPickMs = 15000;
    static readonly byte[] Payload = new byte[32];

    sealed class Target {
      public string Name, Host, Via, Method, Why;   // Method: null (unknown yet) | "icmp" | "tcp"
      public int Port;
      public IPAddress Ip;
      public double Best = -1;
    }

    static readonly object _g = new object();
    static bool _loaded;
    static string _loadErr, _source, _testNote, _label = "Ping";
    static List<Target> _targets = new List<Target>();
    static int _pickEveryMs = 600000;
    static Target _cur;
    static int _misses, _busy, _picking, _echoes, _picks;
    static bool _pickNow;
    static long _lastStart = long.MinValue / 2, _nextPick;
    static string _state = "measuring", _reason;
    static object _ms;
    static List<object> _picked;
    static Ping _ping;

    // ------------------------------------------------------------------ the target list (data)

    static void Load() {
      if (_loaded) return;
      _loaded = true;
      string path = null;
      string env = Program.Passive ? Environment.GetEnvironmentVariable("MANTLE_PING_TARGETS") : null;
      if (!string.IsNullOrEmpty(env)) { path = env; _testNote = "test targets from MANTLE_PING_TARGETS: " + env; }
      else {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        foreach (string p in new[] { Path.Combine(dir, "ping-targets.json"), Path.Combine(dir, "..", "ping-targets.json") })
          if (File.Exists(p)) { path = Path.GetFullPath(p); break; }
        if (path == null) { _loadErr = "the list of servers to ping is missing (no ping-targets.json beside or above " + dir + ")"; return; }
      }
      _source = path;
      try {
        var root = Json.Parse(File.ReadAllText(path)) as Dictionary<string, object>;
        object o;
        string use = root != null && root.TryGetValue("use", out o) ? o as string : null;
        var sets = root != null && root.TryGetValue("sets", out o) ? o as Dictionary<string, object> : null;
        var set = use != null && sets != null && sets.TryGetValue(use, out o) ? o as Dictionary<string, object> : null;
        if (set == null) { _loadErr = "the list of servers to ping (" + path + ") has no set named by \"use\""; return; }
        if (set.TryGetValue("label", out o) && o is string) _label = (string)o;
        if (set.TryGetValue("pickEveryMin", out o) && o is double && (double)o >= 1) _pickEveryMs = (int)((double)o * 60000);
        var list = set.TryGetValue("targets", out o) ? o as List<object> : null;
        if (list != null) foreach (object e in list) {
          var d = e as Dictionary<string, object>;
          if (d == null) continue;
          var t = new Target();
          t.Name = d.TryGetValue("name", out o) ? o as string : null;
          t.Host = d.TryGetValue("host", out o) ? o as string : null;
          t.Via = d.TryGetValue("via", out o) ? o as string : null;
          t.Port = d.TryGetValue("port", out o) && o is double ? (int)(double)o : 0;
          if (!string.IsNullOrEmpty(t.Name) && !string.IsNullOrEmpty(t.Host)) _targets.Add(t);
        }
        if (_targets.Count == 0) _loadErr = "the list of servers to ping (" + path + ") names no servers";
      } catch (Exception ex) {
        _loadErr = "the list of servers to ping (" + path + ") could not be read: " + ex.Message.TrimEnd('.');
      }
    }

    // ------------------------------------------------------------------ the sampler thread's side

    /// Back to "measuring" after a pause: the last reply is stale. The chosen server stays.
    public static void Reset() {
      lock (_g) { _state = "measuring"; _ms = null; _reason = null; _lastStart = long.MinValue / 2; }
    }

    /// Called on the sampler thread once per 1 s tick: starts a pick or an echo when one is due.
    public static IDictionary Step(long nowMs) {
      bool pick = false, echo = false;
      lock (_g) {
        Load();
        if (_loadErr == null) {
          if ((_cur == null || _pickNow || nowMs >= _nextPick) && _picking == 0) { _picking = 1; _pickNow = false; pick = true; _picks++; }
          if (_cur != null && nowMs - _lastStart >= EveryMs - 250 && _busy == 0) { _busy = 1; _lastStart = nowMs; echo = true; _echoes++; }
        }
      }
      if (pick) { var tk = PickAsync(nowMs); }
      if (echo) { var tk = EchoAsync(); }
      return Snapshot();
    }

    // ------------------------------------------------------------------ pick the closest

    static async Task PickAsync(long startedAt) {
      List<object> picked = new List<object>();
      Target best = null;
      try {
        Target[] all;
        lock (_g) all = _targets.ToArray();
        var jobs = new Task[all.Length];
        for (int i = 0; i < all.Length; i++) jobs[i] = MeasureTarget(all[i]);
        await Task.WhenAll(jobs).ConfigureAwait(false);
        foreach (Target t in all) {
          picked.Add(Json.Obj("name", t.Name, "via", t.Via, "ms", t.Best >= 0 ? (object)Math.Round(t.Best, 1) : null, "method", t.Method, "why", t.Best >= 0 ? null : t.Why));
          if (t.Best >= 0 && (best == null || t.Best < best.Best)) best = t;
        }
        bool online = best != null || Online();
        lock (_g) {
          _picked = picked;
          if (best != null) {
            bool changed = _cur != best;
            _cur = best; _misses = 0;
            if (changed || _state != "ok") { _state = "ok"; _ms = Math.Round(best.Best, 1); _reason = null; }
            _nextPick = startedAt + _pickEveryMs;
          } else {
            _cur = null;
            string why = all.Length > 0 ? all[0].Why : null;
            _state = online ? "unreachable" : "offline"; _ms = null;
            _reason = online ? "none of the " + all.Length + " " + _label + " servers answered (" + (why ?? "no reply") + ")"
                             : "offline: Windows reports no network connection";
            _nextPick = startedAt + RetryPickMs;
          }
        }
      } catch (Exception ex) {
        lock (_g) { _state = "error"; _ms = null; _reason = "the ping could not choose a server: " + ex.Message.TrimEnd('.'); _nextPick = startedAt + RetryPickMs; }
      } finally {
        lock (_g) _picking = 0;
      }
    }

    /// Measures one target into locals, then publishes them at once: an echo in flight on the
    /// current server never sees a half-reset target.
    static async Task MeasureTarget(Target t) {
      IPAddress ip = null;
      string method = null, why = null;
      double best = -1;
      try {
        IPAddress[] addrs = await Dns.GetHostAddressesAsync(t.Host).ConfigureAwait(false);
        foreach (IPAddress a in addrs) if (a.AddressFamily == AddressFamily.InterNetwork) { ip = a; break; }
        if (ip == null && addrs.Length > 0) ip = addrs[0];
        if (ip == null) why = "could not look up " + t.Host;
      } catch (Exception ex) {
        why = "could not look up " + t.Host + ": " + Inner(ex).Message.TrimEnd('.');
      }
      if (ip != null) {
        using (var p = new Ping()) {
          for (int i = 0; i < TriesPerPick; i++) {
            Rt r = await OnceAsync(Who(t), ip, t.Port, method, p).ConfigureAwait(false);
            if (r.Ms >= 0) { method = r.Method; if (best < 0 || r.Ms < best) best = r.Ms; }
            else { why = r.Why; if (method == null) break; }   // neither ICMP nor TCP answered at all: next target
          }
        }
      }
      lock (_g) { t.Ip = ip ?? t.Ip; t.Method = method; t.Best = best; t.Why = best >= 0 ? null : why; }
    }

    // ------------------------------------------------------------------ one round trip

    internal sealed class Rt { public double Ms = -1; public string Method, Why; }   // internal: PingTest.cs times its samples with it

    /// One round trip: ICMP echo, or a TCP connect to port when the host does not answer ICMP.
    /// method: what worked before (null = not known yet). A host that answers ICMP never falls
    /// back to TCP: a miss is a miss.
    internal static async Task<Rt> OnceAsync(string who, IPAddress ip, int port, string method, Ping p) {
      var res = new Rt();
      if (method != "tcp") {
        try {
          PingReply r = await p.SendPingAsync(ip, TimeoutMs, Payload, new PingOptions(64, true)).ConfigureAwait(false);
          if (r.Status == IPStatus.Success) { res.Ms = r.RoundtripTime; res.Method = "icmp"; return res; }
          res.Why = r.Status == IPStatus.TimedOut ? "no reply from " + who + " in " + (TimeoutMs / 1000) + " s"
                                                 : who + " could not be reached (Windows says: " + Words(r.Status.ToString()) + ")";
        } catch (Exception ex) {
          res.Why = "the ping to " + who + " could not be sent: " + Inner(ex).Message.TrimEnd('.');
        }
        if (method == "icmp" || port <= 0) return res;
      }
      var c = new TcpClient(ip.AddressFamily);
      var sw = Stopwatch.StartNew();
      try {
        Task ct = c.ConnectAsync(ip, port);
        Task first = await Task.WhenAny(ct, Task.Delay(TimeoutMs)).ConfigureAwait(false);
        if (first != ct) {
          var ignored = ct.ContinueWith(delegate (Task x) { var e = x.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
          res.Why = "no reply from " + who + " in " + (TimeoutMs / 1000) + " s";
          return res;
        }
        await ct.ConfigureAwait(false);
        res.Ms = sw.Elapsed.TotalMilliseconds; res.Method = "tcp"; res.Why = null;
        return res;
      } catch (Exception ex) {
        res.Why = who + " could not be reached: " + Inner(ex).Message.TrimEnd('.');
        return res;
      } finally {
        c.Close();
      }
    }

    // ------------------------------------------------------------------ the chosen one, every 2 s

    static async Task EchoAsync() {
      try {
        Target t; IPAddress ip; string method;
        lock (_g) { t = _cur; ip = t != null ? t.Ip : null; method = t != null ? t.Method : null; if (_ping == null) _ping = new Ping(); }
        if (t == null || ip == null) return;
        Rt r = await OnceAsync(Who(t), ip, t.Port, method, _ping).ConfigureAwait(false);
        bool online = r.Ms >= 0 || Online();
        lock (_g) {
          if (t != _cur) return;   // a re-pick moved on while this was in flight
          if (r.Ms >= 0) { _misses = 0; _state = "ok"; _ms = Math.Round(r.Ms, 1); _reason = null; if (t.Method == null) t.Method = r.Method; return; }
          _misses++;
          _state = !online ? "offline" : r.Why != null && r.Why.StartsWith("no reply", StringComparison.Ordinal) ? "timeout" : "unreachable";
          _ms = null;
          _reason = !online ? "offline: Windows reports no network connection" : r.Why;
          if (_misses >= MissesToRepick) { _pickNow = true; _misses = 0; _reason += "; looking for another " + _label + " server"; }
        }
      } catch (Exception ex) {
        lock (_g) { _state = "error"; _ms = null; _reason = "the ping could not be sent: " + ex.Message.TrimEnd('.'); }
      } finally {
        lock (_g) _busy = 0;
      }
    }


    /// For PingTest.cs (lane pingtest, 2026-10-09): a copy of the loaded list (the same file, the same
    /// MANTLE_PING_TARGETS rule) with each target's last known address and method. err: why there is none.
    internal sealed class TargetCopy { public string Name, Host, Via, Method; public int Port; public IPAddress Ip; }
    internal static List<TargetCopy> CopyTargets(out string label, out string err) {
      var list = new List<TargetCopy>();
      lock (_g) {
        Load();
        label = _label; err = _loadErr;
        foreach (Target t in _targets) list.Add(new TargetCopy { Name = t.Name, Host = t.Host, Via = t.Via, Method = t.Method, Port = t.Port, Ip = t.Ip });
      }
      return list;
    }

    // ------------------------------------------------------------------ helpers

    static string Who(Target t) { return _label + " " + t.Name; }
    internal static bool Online() { try { return NetworkInterface.GetIsNetworkAvailable(); } catch (Exception) { return true; } }
    internal static Exception Inner(Exception e) {
      while (e != null && (e is AggregateException || e is PingException) && e.InnerException != null) e = e.InnerException;
      return e ?? new Exception("no reason given");
    }
    /// "DestinationHostUnreachable" -> "destination host unreachable"
    static string Words(string camel) {
      var sb = new StringBuilder();
      foreach (char c in camel) { if (char.IsUpper(c) && sb.Length > 0) sb.Append(' '); sb.Append(char.ToLowerInvariant(c)); }
      return sb.ToString();
    }

    static IDictionary Snapshot() {
      lock (_g) {
        if (_loadErr != null)
          return Json.Obj("state", "error", "ms", null, "label", _label, "reason", _loadErr, "everyMs", EveryMs);
        Target t = _cur;
        string reason = _reason;
        if (_state == "measuring")
          reason = t == null ? "finding the closest " + _label + " server (" + _targets.Count + " to try)" : "measuring the ping to " + Who(t);
        return Json.Obj("state", _state, "ms", _ms, "label", _label,
                        "server", t != null ? t.Name : null, "host", t != null ? t.Host : null, "via", t != null ? t.Via : null,
                        "method", t != null ? t.Method : null, "reason", reason, "picked", _picked,
                        "everyMs", EveryMs, "timeoutMs", TimeoutMs, "pickEveryMs", _pickEveryMs, "echoes", _echoes, "picks", _picks, "test", _testNote);
      }
    }
  }
}
