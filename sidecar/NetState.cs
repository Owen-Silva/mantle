// NetState.cs - {cmd:"net"}: what the bar's network readout shows, and a watch that PUSHES it
// (qsx lane, 2026-09-23).
//
// WHY: the readout beside the volume glyph was a fixed Wi-Fi drawing in index.html. It never
// changed: full bars with the Wi-Fi off, on Ethernet, with no internet, or with no network at all.
// The user: "you need to make the Internet thing ... actually work".
//
//   {op:"get"}                        one fresh reading (a pool thread answers)
//   {op:"watch", on, fast?}           a watch that pushes {ev:"net", ...} whenever what the
//                                     readout shows changes; `fast` while the quick-settings panel
//                                     is open (a 1 s re-check instead of 5 s)
//
// THE READING. Which adapter would carry traffic to the internet is Windows' own routing answer
// (GetBestInterface for a public address), so a VPN or a second adapter cannot fool it; its LUID
// says Wi-Fi or Ethernet. Whether there IS internet is the Network List Manager's connectivity -
// the same NCSI verdict Windows' own icon draws its "no internet" globe from. The Wi-Fi details
// (radio, network, signal) are Network.Read's.
//
//   kind       "wifi" | "ethernet" | "other" (a VPN, a phone tether) | "none"
//   internet   true | false | null (null: Windows could not be asked, with the reason)
//
// THE WATCH is event-first: an address change (connect, disconnect, radio off) wakes it at once,
// and so does the Network List Manager's ConnectivityChanged (a network that loses its internet
// but keeps its address), which also hands over the new verdict, so a re-check does not ask for
// it (GetConnectivity cost 48-123 ms a call here, measured 2026-09-23). The re-check every 5 s
// (1 s with `fast`) is for what has no event - a signal that fades - and asks the Network List
// Manager itself only when its events could not be subscribed, or once a minute as a backstop.
// It emits only when something the readout shows has changed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

namespace Mantle {
  static class NetState {
    const int SlowTickMs = 5000, FastTickMs = 1000, SettleMs = 250;

    // NLM_CONNECTIVITY flags (netlistmgr.h).
    const int NLM_IPV4_SUBNET = 0x10, NLM_IPV4_LOCAL = 0x20, NLM_IPV4_INTERNET = 0x40;
    const int NLM_IPV6_SUBNET = 0x100, NLM_IPV6_LOCAL = 0x200, NLM_IPV6_INTERNET = 0x400;

    [ComImport, Guid("DCB00000-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    interface INetworkListManager {
      [PreserveSig] int GetNetworks(int flags, out IntPtr enumNetworks);
      [PreserveSig] int GetNetwork(Guid networkId, out IntPtr network);
      [PreserveSig] int GetNetworkConnections(out IntPtr enumConnections);
      [PreserveSig] int GetNetworkConnection(Guid connectionId, out IntPtr connection);
      [PreserveSig] int get_IsConnectedToInternet(out short connected);
      [PreserveSig] int get_IsConnected(out short connected);
      [PreserveSig] int GetConnectivity(out int connectivity);
    }

    [ComImport, Guid("DCB00001-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface INetworkListManagerEvents {
      [PreserveSig] int ConnectivityChanged(int newConnectivity);
    }

    /// Runs on an RPC thread: it only records and wakes the watch.
    sealed class ConnectivitySink : INetworkListManagerEvents {
      public int ConnectivityChanged(int newConnectivity) {
        Interlocked.Exchange(ref _pushedConn, newConnectivity);
        Interlocked.Exchange(ref _connChanged, 1);
        _wake.Set();
        return 0;
      }
    }

    static int _pushedConn, _connChanged;
    const int NlmBackstopMs = 60000;

    static class Native {
      [DllImport("iphlpapi.dll")] public static extern int GetBestInterface(uint destAddr, out uint bestIfIndex);
      [DllImport("iphlpapi.dll")] public static extern int ConvertInterfaceIndexToLuid(uint index, out ulong luid);
      [DllImport("iphlpapi.dll", CharSet = CharSet.Unicode)]
      public static extern int ConvertInterfaceLuidToAlias(ref ulong luid, System.Text.StringBuilder alias, UIntPtr length);
    }

    // IANA ifType, which Windows keeps in the top 16 bits of an interface's LUID (NET_LUID.Info.IfType).
    const int IF_TYPE_ETHERNET_CSMACD = 6, IF_TYPE_PPP = 23, IF_TYPE_SOFTWARE_LOOPBACK = 24,
              IF_TYPE_PROP_VIRTUAL = 53, IF_TYPE_IEEE80211 = 71, IF_TYPE_TUNNEL = 131,
              IF_TYPE_WWANPP = 243, IF_TYPE_WWANPP2 = 244;

    delegate IDictionary Work();

    public static string Run(Dictionary<string, object> req, object id, bool passive, out object result) {
      result = null;
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "get";
      if (op == "watch") {
        if (!Json.HasKey(req, "on")) return "net watch needs on: true or false";
        bool on = Json.GetBool(req, "on", false);
        bool fast = Json.GetBool(req, "fast", false);
        result = Watch(on, fast);
        return null;
      }
      if (op != "get") return "net: unknown op \"" + op + "\" (it does get, watch)";
      long arrived = Stopwatch.GetTimestamp();
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        IDictionary r;
        INetworkListManager nlm = null;
        try {
          nlm = NewNlm();
          r = Read(nlm, "get");
        } catch (Exception ex) {
          r = Json.Obj("ok", false, "reason", "the network state could not be read (" + ex.GetType().Name + ": " + ex.Message + ")");
        } finally {
          if (nlm != null) { try { Marshal.ReleaseComObject(nlm); } catch (Exception) { } }
        }
        r["waitedMs"] = Lanes.MsSince(arrived);
        Program.ReplyFromWorker(id, true, r, null);
      });
      result = Program.Deferred;
      return null;
    }

    static INetworkListManager NewNlm() {
      Type t = Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B"));
      return t == null ? null : (INetworkListManager)Activator.CreateInstance(t);
    }

    // ------------------------------------------------------------------ one reading

    /// Never throws: every part that cannot be read says why in `reason`.
    /// `knownConn` >= 0: the connectivity the Network List Manager last pushed, so it is not asked.
    static IDictionary Read(INetworkListManager nlm, string via, int knownConn = -1) {
      long t0 = Stopwatch.GetTimestamp();
      var reasons = new List<string>();

      // Which adapter carries internet traffic: Windows' route to a public address, and that
      // adapter's type and name from its LUID. NOT NetworkInterface.GetAllNetworkInterfaces():
      // matching the index through GetIPProperties() cost 280-500 ms a read here (measured
      // 2026-09-23, one GetPerAdapterInfo per adapter); the LUID route is two local calls.
      string kind = "none", adapter = null, adapterType = null;
      uint best;
      int rc = -1;
      try { rc = Native.GetBestInterface(0x08080808, out best); } catch (Exception) { best = 0; }
      if (rc == 0 && best != 0) {
        ulong luid;
        int lrc = -1;
        try { lrc = Native.ConvertInterfaceIndexToLuid(best, out luid); } catch (Exception) { luid = 0; }
        if (lrc == 0 && luid != 0) {
          int ifType = (int)((luid >> 48) & 0xFFFF);
          switch (ifType) {
            case IF_TYPE_IEEE80211: kind = "wifi"; adapterType = "wifi"; break;
            case IF_TYPE_ETHERNET_CSMACD: kind = "ethernet"; adapterType = "ethernet"; break;
            case IF_TYPE_WWANPP: case IF_TYPE_WWANPP2: kind = "other"; adapterType = "mobile"; break;
            case IF_TYPE_PPP: kind = "other"; adapterType = "ppp"; break;
            case IF_TYPE_TUNNEL: kind = "other"; adapterType = "tunnel"; break;
            case IF_TYPE_PROP_VIRTUAL: kind = "other"; adapterType = "virtual"; break;
            case IF_TYPE_SOFTWARE_LOOPBACK: kind = "none"; adapterType = "loopback"; break;
            default: kind = "other"; adapterType = "iftype " + ifType; break;
          }
          try {
            var sb = new System.Text.StringBuilder(257);
            if (Native.ConvertInterfaceLuidToAlias(ref luid, sb, (UIntPtr)257) == 0) adapter = sb.ToString();
          } catch (Exception) { }
        } else {
          kind = "other";
          reasons.Add("Windows routes to the internet through adapter " + best + ", whose type could not be read (" + lrc + ")");
        }
      }
      long routeMs = Lanes.MsSince(t0);

      // Internet or not: the Network List Manager's verdict.
      long tNlm = Stopwatch.GetTimestamp();
      object internet = null;
      int conn = 0;
      if (knownConn >= 0) {
        conn = knownConn;
        internet = (conn & (NLM_IPV4_INTERNET | NLM_IPV6_INTERNET)) != 0;
      } else if (nlm == null) reasons.Add("the Network List Manager is not available, so internet access is unknown");
      else {
        try {
          int hr = nlm.GetConnectivity(out conn);
          if (hr == 0) internet = (conn & (NLM_IPV4_INTERNET | NLM_IPV6_INTERNET)) != 0;
          else reasons.Add("the Network List Manager did not answer (HRESULT 0x" + hr.ToString("X8") + "), so internet access is unknown");
        } catch (Exception ex) {
          reasons.Add("the Network List Manager failed (" + ex.Message + "), so internet access is unknown");
        }
      }

      long nlmMs = Lanes.MsSince(tNlm);
      // The Wi-Fi details: shared with the panel's cache (QuickSettings.WifiRecent), and not
      // asked at all on Ethernet, where the readout does not show them.
      long tWifi = Stopwatch.GetTimestamp();
      IDictionary wifi = kind == "ethernet"
        ? Json.Obj("present", null, "on", null, "connected", false, "ssid", null, "signal", 0, "band", null,
                   "reason", "not read: the internet goes through Ethernet")
        : QuickSettings.WifiRecent(1500);
      long wifiMs = Lanes.MsSince(tWifi);
      bool wifiPresent = wifi["present"] is bool && (bool)wifi["present"];
      bool wifiOn = wifi["on"] is bool && (bool)wifi["on"];
      bool wifiConnected = wifi["connected"] is bool && (bool)wifi["connected"];

      // A Wi-Fi association with no route yet (the first second of a connect) still reads as Wi-Fi.
      if (kind == "none" && wifiConnected) kind = "wifi";

      string state;
      if (kind == "none") state = !wifiPresent ? "disconnected" : !wifiOn ? "wifi-off" : "disconnected";
      else if (internet is bool && !(bool)internet) state = "no-internet";
      else state = "connected";

      bool local = (conn & (NLM_IPV4_SUBNET | NLM_IPV4_LOCAL | NLM_IPV6_SUBNET | NLM_IPV6_LOCAL)) != 0;
      return Json.Obj("ok", true, "state", state, "kind", kind, "internet", internet, "local", local,
                      "connectivity", conn, "adapter", adapter, "adapterType", adapterType,
                      "wifi", Json.Obj("present", wifiPresent, "on", wifiOn, "connected", wifiConnected,
                                       "ssid", wifi["ssid"], "signal", wifi["signal"], "band", wifi["band"],
                                       "reason", wifi["reason"]),
                      "reason", reasons.Count > 0 ? string.Join("; ", reasons.ToArray()) : null,
                      "via", via, "ms", Lanes.MsSince(t0),
                      "partsMs", Json.Obj("route", routeMs, "nlm", nlmMs, "wifi", wifiMs));
    }

    /// What the readout shows, as one string: only a change in it is pushed.
    static string Shown(IDictionary r) {
      var w = r["wifi"] as IDictionary;
      int signal = w != null && w["signal"] is int ? (int)w["signal"] : 0;
      int bars = signal <= 0 ? 0 : Math.Min(4, (signal + 24) / 25);
      return r["state"] + "|" + r["kind"] + "|" + r["internet"] + "|" + r["adapter"] + "|" +
             (w == null ? "" : w["present"] + "|" + w["on"] + "|" + w["connected"] + "|" + w["ssid"] + "|" + bars + "|" + w["band"]) +
             "|" + r["reason"];
    }

    // ------------------------------------------------------------------ the watch

    // ONE THREAD AT A TIME: each start gets a new generation and its own wake event, so an
    // off followed at once by an on (the old thread still inside a read) leaves the old
    // thread to finish and exit on its own, and never two loops emitting.
    static readonly object _lock = new object();
    static AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;
    static volatile bool _on, _fast;
    static volatile int _gen;
    static int _addressChanged;
    static string _lastShown;
    static long _events;
    static IDictionary _last;
    static IConnectionPoint _cp;        // the watch thread's subscription, for its finally
    static int _cookie;
    static volatile bool _advised;

    static IDictionary Watch(bool on, bool fast) {
      lock (_lock) {
        if (!on) {
          bool was = _on;
          _on = false;
          _gen++;
          _wake.Set();
          return Json.Obj("ok", true, "watching", false, "stopped", was, "events", _events, "reason", null);
        }
        bool wasFast = _fast;
        _fast = fast;
        if (_on && _thread != null && _thread.IsAlive) {
          if (fast && !wasFast) _wake.Set();    // the panel opened: re-check now
          return Json.Obj("ok", true, "watching", true, "started", false, "fast", fast, "events", _events,
                          "last", _last, "reason", null);
        }
        _on = true;
        _lastShown = null;
        int gen = ++_gen;
        var wake = new AutoResetEvent(false);
        _wake = wake;
        _thread = new Thread(delegate () { Loop(gen, wake); });
        _thread.IsBackground = true;
        _thread.Name = "mantle-net-watch";
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
        return Json.Obj("ok", true, "watching", true, "started", true, "fast", fast, "events", _events, "reason", null);
      }
    }

    public static IDictionary Snapshot() {
      lock (_lock) {
        return Json.Obj("watching", _on, "fast", _fast, "events", _events, "connectivityEvents", _advised,
                        "state", _last == null ? null : _last["state"], "kind", _last == null ? null : _last["kind"],
                        "readMs", _last == null ? null : _last["ms"]);
      }
    }

    static void OnAddressChanged(object sender, EventArgs e) {
      Interlocked.Exchange(ref _addressChanged, 1);
      _wake.Set();
    }

    static void Loop(int gen, AutoResetEvent wake) {
      INetworkListManager nlm = null;
      NetworkAddressChangedEventHandler onAddr = OnAddressChanged;
      NetworkAvailabilityChangedEventHandler onAvail = delegate (object s, NetworkAvailabilityEventArgs e) { OnAddressChanged(s, e); };
      bool hooked = false;
      try {
        try { nlm = NewNlm(); } catch (Exception ex) {
          Program.EmitLog("warn", "net watch: the Network List Manager could not be created (" + ex.Message +
                                  "), so internet access shows as unknown");
        }
        try {
          NetworkChange.NetworkAddressChanged += onAddr;
          NetworkChange.NetworkAvailabilityChanged += onAvail;
          hooked = true;
        } catch (Exception ex) {
          Program.EmitLog("warn", "net watch: Windows' address-change events could not be subscribed (" + ex.Message +
                                  "), so a change shows at the next re-check instead of at once");
        }
        // The Network List Manager's own push of the internet verdict.
        IConnectionPoint cp = null;
        int cookie = 0;
        bool advised = false;
        if (nlm != null) {
          try {
            var cpc = (IConnectionPointContainer)nlm;
            Guid iid = typeof(INetworkListManagerEvents).GUID;
            cpc.FindConnectionPoint(ref iid, out cp);
            cp.Advise(new ConnectivitySink(), out cookie);
            advised = true;
          } catch (Exception ex) {
            Program.EmitLog("warn", "net watch: the Network List Manager's events could not be subscribed (" + ex.Message +
                                    "), so internet access is asked at every re-check instead");
          }
        }
        _cp = cp;
        _cookie = cookie;
        _advised = advised;
        int lastConn = -1;
        long lastAskTs = 0;
        string via = "start";
        while (_on && gen == _gen) {
          int known = -1;
          if (Interlocked.Exchange(ref _connChanged, 0) == 1) { known = Thread.VolatileRead(ref _pushedConn); via = "connectivity"; }
          // an address change is a new network: ask, rather than trust the last verdict
          else if (advised && lastConn >= 0 && via != "address" && Lanes.MsSince(lastAskTs) < NlmBackstopMs) known = lastConn;
          IDictionary r = Read(nlm, via, known);
          if (known < 0) lastAskTs = Stopwatch.GetTimestamp();
          if (r["connectivity"] is int && (r["internet"] is bool)) lastConn = (int)r["connectivity"];
          string shown = Shown(r);
          lock (_lock) _last = r;
          if (shown != _lastShown) {
            _lastShown = shown;
            _events++;
            var ev = Json.Obj("ev", "net");
            foreach (DictionaryEntry e in r) ev[e.Key] = e.Value;
            Program.Emit(ev);
          }
          bool woke = wake.WaitOne(_fast ? FastTickMs : SlowTickMs);
          if (!_on || gen != _gen) break;
          if (woke && Interlocked.Exchange(ref _addressChanged, 0) == 1) {
            // A connect or disconnect is a burst of address changes: read once it settles.
            Thread.Sleep(SettleMs);
            Interlocked.Exchange(ref _addressChanged, 0);
            via = "address";
          } else via = woke ? "asked" : "tick";
        }
      } catch (Exception ex) {
        Program.EmitLog("warn", "net watch stopped (" + ex.GetType().Name + ": " + ex.Message + ")");
        Program.Emit(Json.Obj("ev", "net", "ok", false, "state", "unknown", "reason",
                              "the network watch stopped (" + ex.Message + ")"));
      } finally {
        if (_advised && _cp != null) { try { _cp.Unadvise(_cookie); } catch (Exception) { } }
        _cp = null;
        _advised = false;
        if (hooked) {
          try { NetworkChange.NetworkAddressChanged -= onAddr; } catch (Exception) { }
          try { NetworkChange.NetworkAvailabilityChanged -= onAvail; } catch (Exception) { }
        }
        if (nlm != null) { try { Marshal.ReleaseComObject(nlm); } catch (Exception) { } }
        lock (_lock) { if (gen == _gen) _on = false; }
      }
    }
  }
}
