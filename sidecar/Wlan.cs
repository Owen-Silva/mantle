// Wlan.cs - `wlan`: the Wi-Fi LIST behind the '>' on the Quick Settings Wi-Fi
// tile. The networks in range, a scan when asked, connect and disconnect.
//
// Owen wants Mantle's panel to be the whole of Windows 11's Wi-Fi flyout, so he
// never has to open Windows' own. Network.cs answers "am I connected, how well";
// this file answers "what else is out there, and get me onto it".
//
// NOTHING HERE WAITS ON A LANE. `wlan` is handed off the way `search` is
// (Search.cs): the case in Program.Run validates the request on the ui lane,
// queues it here and answers Program.Deferred, and a pool thread does the work
// and replies. A scan waits for Windows' scan-complete notification (up to
// ScanWaitMs) and a connect waits for the connection result (up to
// ConnectWaitMs): parked on the slow lane either one would hold up every icon
// load behind it for seconds, and on the ui lane every button press.
//
// NATIVE API, NOT netsh, for the reason Network.cs gives (a process launch per
// read). Every buffer wlanapi allocates is freed with WlanFreeMemory, every
// handle is closed, and every notification registration dies with its handle.
//
// THE PASSWORD. It arrives in the request, is taken OUT of the request's
// dictionary before anything else runs (Run), goes into the profile XML that
// WlanSetProfile receives, and nowhere else: never a log line, an error, a
// reply, or the "last result" kept for a reopened panel.
//
// WHAT A TEST MAY DO (Owen's machine, 2026-09-23 brief): list and scan freely -
// they change nothing. connect, disconnect and every profile write are refused
// in --passive. What proves them without touching his Wi-Fi is `probe`, which
// calls each write entry point against an interface GUID that cannot exist (and
// hands WlanSetProfile a deliberately invalid profile on top), and `profile`,
// which returns the generated XML for a test key. Both run ONLY in --passive.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Threading;
using System.Xml;

namespace Mantle {
  static class Wlan {
    // A driver must finish a scan within 4 s (the WDI rule), so 6 s is a real
    // failure, not a slow scan. The measured figure is in the report of the
    // 2026-09-23 qsx lane and in `scan.ms` of every reply.
    const int ScanWaitMs = 6000;
    // WPA2 with a DHCP lease is ~2-5 s; an enterprise or captive network can be
    // slower, but those are never connected from here.
    const int ConnectWaitMs = 25000;
    const int DisconnectWaitMs = 5000;
    // How long a connect's outcome is shown to a panel that is opened again.
    const int LastKeepMs = 120000;

    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    // ------------------------------------------------------------ constants
    const uint SOURCE_NONE = 0, SOURCE_ACM = 0x08;
    const uint ACM_SCAN_COMPLETE = 7, ACM_SCAN_FAIL = 8, ACM_CONNECTION_COMPLETE = 10,
               ACM_CONNECTION_ATTEMPT_FAIL = 11, ACM_DISCONNECTED = 21;
    const uint NET_CONNECTED = 0x1, NET_HAS_PROFILE = 0x2;
    const uint BSS_INFRASTRUCTURE = 1;
    const uint MODE_PROFILE = 0;
    // WLAN_AVAILABLE_NETWORK is 628 bytes of 4-byte fields (offsets below);
    // WLAN_PROFILE_INFO is WCHAR[256] + DWORD.
    const int NET_SIZE = 628, PROFILE_INFO_SIZE = 516;
    const uint ERROR_INVALID_PARAMETER = 87, ERROR_NOT_FOUND = 1168;

    /// The interface GUID `probe` aims at: "mantle-probe----" in hex, so it can
    /// never be a real adapter, and anyone reading a trace knows whose it is.
    static readonly Guid ProbeGuid = new Guid("6d616e74-6c65-2d70-726f-62652d2d2d2d");
    const string ProbeProfile = "mantle-probe-profile-that-does-not-exist";

    static readonly string[] IfaceStates = {
      "not ready", "connected", "ad hoc", "disconnecting", "disconnected", "associating", "discovering", "authenticating"
    };

    static class Native {
      [StructLayout(LayoutKind.Sequential)]
      public struct WLAN_NOTIFICATION_DATA {
        public uint NotificationSource;
        public uint NotificationCode;
        public Guid InterfaceGuid;
        public uint dwDataSize;
        public IntPtr pData;
      }

      /// x64: mode, 4 bytes of padding, then three pointers; Sequential layout
      /// puts the padding where the C compiler does.
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct WLAN_CONNECTION_PARAMETERS {
        public uint wlanConnectionMode;
        [MarshalAs(UnmanagedType.LPWStr)] public string strProfile;
        public IntPtr pDot11Ssid;
        public IntPtr pDesiredBssidList;
        public uint dot11BssType;
        public uint dwFlags;
      }

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate void NotificationCallback(IntPtr data, IntPtr context);

      [DllImport("wlanapi.dll")]
      public static extern uint WlanGetAvailableNetworkList(IntPtr h, ref Guid iface, uint flags, IntPtr reserved, out IntPtr list);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanGetProfileList(IntPtr h, ref Guid iface, IntPtr reserved, out IntPtr list);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanScan(IntPtr h, ref Guid iface, IntPtr ssid, IntPtr ieData, IntPtr reserved);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanConnect(IntPtr h, ref Guid iface, ref WLAN_CONNECTION_PARAMETERS p, IntPtr reserved);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanDisconnect(IntPtr h, ref Guid iface, IntPtr reserved);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanSetProfile(IntPtr h, ref Guid iface, uint flags, string xml, string allUserSecurity,
                                               [MarshalAs(UnmanagedType.Bool)] bool overwrite, IntPtr reserved, out uint reasonCode);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanDeleteProfile(IntPtr h, ref Guid iface, string profile, IntPtr reserved);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanReasonCodeToString(uint code, uint bufferSize, StringBuilder buffer, IntPtr reserved);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanRegisterNotification(IntPtr h, uint source, [MarshalAs(UnmanagedType.Bool)] bool ignoreDuplicate,
                                                         NotificationCallback callback, IntPtr context, IntPtr reserved, out uint previous);
    }

    // ================================================================ dispatch

    /// On the ui lane: validate, hand the work to a pool thread, return. Every
    /// op replies from its worker (result = Program.Deferred), so not one
    /// wlanapi call - not even the reason-text lookup - runs on the lane.
    /// Returns a plain-words error for a request that cannot run at all.
    public static string Run(Dictionary<string, object> req, object id, bool passive, out object result) {
      result = null;
      // The password leaves the request FIRST, before any branch can fail or
      // log: nothing downstream (an error, a coalescing key, a late "expired")
      // can quote what is no longer there.
      string password = null;
      object pw;
      if (req.TryGetValue("password", out pw)) {
        req.Remove("password");
        if (pw != null && !(pw is string)) return "wlan: password must be a string";
        password = (string)pw;
      }

      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "list";
      long arrived = Stopwatch.GetTimestamp();
      int ttl = TtlOf(req);

      switch (op) {
        case "list":
          Post(id, arrived, ttl, delegate () { return List(); });
          result = Program.Deferred;
          return null;

        case "scan":
          StartScan(id, arrived, ttl);
          result = Program.Deferred;
          return null;

        case "connect": {
          string ssid = Json.GetString(req, "ssid");
          string hex = Json.GetString(req, "hex");
          if (string.IsNullOrEmpty(ssid) && string.IsNullOrEmpty(hex)) return "wlan connect needs ssid (the network's name) or hex";
          if (ssid != null && Encoding.UTF8.GetByteCount(ssid) > 32) return "wlan connect: a network name is at most 32 bytes";
          if (hex != null && !IsHex(hex, 2, 64)) return "wlan connect: hex must be the network name's bytes as 2-64 hex digits";
          if (password != null) {
            string perr = CheckPassword(password);
            if (perr != null) return "wlan connect: " + perr;
          }
          bool auto = Json.GetBool(req, "auto", true);
          // A HIDDEN network (hidden:true, lane net2): it is in no scan, so the request names its
          // security and Mantle writes a nonBroadcast profile, then connects by that profile.
          bool hidden = Json.GetBool(req, "hidden", false);
          string hAuth = null, hEnc = null;
          if (hidden) {
            if (string.IsNullOrEmpty(ssid)) return "wlan connect: a hidden network needs ssid (its exact name)";
            if (!SchemaWords(Json.GetString(req, "security"), out hAuth, out hEnc)) return "wlan connect: a hidden network needs security: open, wpa, wpa2 or wpa3";
            if (hAuth == "open" && password != null) return "wlan connect: an open network takes no password";
            if (hAuth != "open" && password == null) return "wlan connect: a secured hidden network needs its password";
          }
          if (passive) return PassiveRefusal + ": wlan connect would join a network on the live machine";
          lock (_lock) {
            if (_connecting != null)
              return "wlan connect: Mantle is already connecting to \"" + _connecting + "\"; wait for that to finish";
            _connecting = ssid ?? hex;
            _connectingTs = Stopwatch.GetTimestamp();
          }
          string pwLocal = password;
          password = null;
          if (hidden) {
            string ha = hAuth, he = hEnc;
            Post(id, arrived, ttl, delegate () { return ConnectHidden(ssid, ha, he, pwLocal, auto); },
                 delegate () { lock (_lock) _connecting = null; });
          } else {
            Post(id, arrived, ttl, delegate () { return Connect(ssid, hex, pwLocal, auto); },
                 delegate () { lock (_lock) _connecting = null; });
          }
          result = Program.Deferred;
          return null;
        }

        case "disconnect":
          if (passive) return PassiveRefusal + ": wlan disconnect would drop the live Wi-Fi connection";
          lock (_lock) {
            if (_connecting != null)
              return "wlan disconnect: Mantle is connecting to \"" + _connecting + "\" right now; wait for that to finish";
          }
          Post(id, arrived, ttl, delegate () { return Disconnect(); });
          result = Program.Deferred;
          return null;

        case "reason": {
          // Read-only and instant: WLAN_REASON_CODE -> the sentence Windows uses.
          object raw;
          if (!Json.TryGet(req, "code", out raw) || !(raw is double)) return "wlan reason needs code: a WLAN_REASON_CODE number";
          double d = (double)raw;
          if (d < 0 || d > uint.MaxValue || d != Math.Floor(d)) return "wlan reason: code must be a whole number from 0 to 4294967295";
          uint code = (uint)d;
          Post(id, arrived, ttl, delegate () {
            return Json.Obj("ok", true, "code", code, "hex", "0x" + code.ToString("x", CultureInfo.InvariantCulture),
                            "text", ReasonText(code), "reason", null);
          });
          result = Program.Deferred;
          return null;
        }

        case "profile": {
          // TEST ONLY: the XML a connect would hand WlanSetProfile, for a test key.
          // Never in a live sidecar: that would be a way to echo a password back.
          string security = Json.GetString(req, "security");
          string ssid = Json.GetString(req, "ssid");
          if (string.IsNullOrEmpty(ssid)) return "wlan profile needs ssid";
          string auth, enc;
          if (!SchemaWords(security, out auth, out enc)) return "wlan profile: security must be open, wpa, wpa2 or wpa3";
          string perr = auth == "open"
            ? (password != null ? "an open network takes no password" : null)
            : (password == null ? "a secured network needs a password" : CheckPassword(password));
          if (perr != null) return "wlan profile: " + perr;
          if (!passive) return "wlan profile is a test command and only runs in --passive";
          byte[] raw = Encoding.UTF8.GetBytes(ssid);
          if (raw.Length > 32) return "wlan profile: a network name is at most 32 bytes";
          string testKey = password;
          bool testAuto = Json.GetBool(req, "auto", true);
          bool testHidden = Json.GetBool(req, "hidden", false);
          Post(id, arrived, ttl, delegate () {
            string xml = ProfileXml(ProfileName(ssid), raw, ssid, auth, enc, testKey, testAuto, testHidden);
            return Json.Obj("ok", true, "xml", xml, "wellFormed", WellFormed(xml), "profileName", ProfileName(ssid), "reason", null);
          });
          result = Program.Deferred;
          return null;
        }

        case "probe":
          // TEST ONLY: every write entry point, aimed at an interface that does not exist.
          if (!passive) return "wlan probe is a test command and only runs in --passive";
          Post(id, arrived, ttl, delegate () { return Probe(); });
          result = Program.Deferred;
          return null;

        default:
          return "wlan: unknown op \"" + op + "\" (it does list, scan, connect, disconnect, reason)";
      }
    }

    static int TtlOf(Dictionary<string, object> req) {
      object raw;
      if (req.TryGetValue("ttl", out raw) && raw is double) {
        double d = (double)raw;
        if (d > 0 && d < int.MaxValue) return (int)d;
      }
      return 0;
    }

    delegate IDictionary Work();

    /// One job on a pool thread (MTA, background: wlanapi is free-threaded and
    /// must never hold the process open). A caller that has already given up is
    /// told so instead of having the work done for nobody - the same load
    /// shedding Program applies on the lanes.
    static void Post(object id, long arrivedTs, int ttlMs, Work work) { Post(id, arrivedTs, ttlMs, work, null); }

    /// release runs exactly once, whether the work ran, threw or was skipped as
    /// expired, and BEFORE the reply: connect's in-flight guard must drop on the
    /// skipped path too (else every later connect is refused until a restart),
    /// and a caller that lists the moment its connect answers must not still
    /// read "connecting".
    static void Post(object id, long arrivedTs, int ttlMs, Work work, Action release) {
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        long waited = Lanes.MsSince(arrivedTs);
        bool expired = ttlMs > 0 && waited >= ttlMs;
        IDictionary r = null;
        if (!expired) {
          try {
            r = work();
          } catch (Exception ex) {
            // Every path below answers its own failures; this is the belt for a bug.
            r = Json.Obj("ok", false, "reason", "the Wi-Fi request failed inside Mantle (" + ex.GetType().Name + ": " + ex.Message + ")");
          }
        }
        if (release != null) release();   // a lock and an assignment: it cannot fail
        if (expired)
          Program.ReplyFromWorker(id, false, null, "expired: \"wlan\" waited " + waited + " ms, past the caller's " +
                                  ttlMs + " ms deadline, so it was skipped rather than run for nobody");
        else
          Program.ReplyFromWorker(id, true, r, null);
      });
    }

    // ================================================================== state
    // Only names and outcomes. Never a password.

    static readonly object _lock = new object();
    static string _connecting;        // the network a connect is in flight for, or null
    static long _connectingTs;
    static IDictionary _last;         // the last connect/disconnect outcome
    static long _lastTs;
    static long _lastScanTs;          // when our last scan finished (0 = never)

    sealed class Waiting {
      public object Id;
      public long ArrivedTs;
      public int TtlMs;
    }
    static List<Waiting> _scanWaiters;   // non-null while a scan runs; later scans ride on it

    // ============================================================== the list

    sealed class Net {
      public byte[] Ssid;
      public string Name;
      public bool NameIsText;
      public string Hex;
      public string Profile;
      public bool Connected;
      public int Signal;
      public bool Secure;
      public uint Auth, Cipher;
      public bool Connectable;
      public uint NotConnectableReason;
    }

    /// The whole answer for the Wi-Fi view. Never throws: no adapter, a radio
    /// that is off and a stopped service are ordinary answers with a reason.
    public static IDictionary List() {
      var sw = Stopwatch.StartNew();
      IntPtr h = IntPtr.Zero;
      try {
        // No service and no adapter are ANSWERS (ok, present:false, the
        // reason), as in Network.Read; only a read that broke is ok:false.
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Unavailable(true, false, false, err, sw);

        Guid g;
        string ifName;
        uint ifState;
        int ifCount;
        err = PickInterface(h, out g, out ifName, out ifState, out ifCount);
        if (err != null) return Unavailable(true, false, false, err, sw);

        if (!RadioOn(h, g)) return Unavailable(true, true, false, "the Wi-Fi radio is switched off", sw);

        List<Net> nets = ReadNetworks(h, g, out err);
        if (nets == null) return Unavailable(false, true, true, err, sw);

        // Windows is mid-connection (associating / discovering / authenticating):
        // the network it is joining shows "Connecting", whoever started it.
        string joining = null;
        if (ifState >= 5 && ifState <= 7) joining = CurrentSsid(h, g);
        string ours;
        long oursMs;
        lock (_lock) {
          ours = _connecting;
          oursMs = ours == null ? 0 : Lanes.MsSince(_connectingTs);
        }

        var list = new List<object>();
        foreach (Net n in nets) list.Add(Describe(n, joining, ours));

        IDictionary last = null;
        lock (_lock) {
          if (_last != null && Lanes.MsSince(_lastTs) < LastKeepMs) {
            last = Copy(_last);
            last["agoMs"] = Lanes.MsSince(_lastTs);
          }
        }
        long scanned;
        lock (_lock) scanned = _lastScanTs == 0 ? -1 : Lanes.MsSince(_lastScanTs);

        return Json.Obj("ok", true, "present", true, "on", true,
                        "iface", Json.Obj("name", ifName, "state", StateName(ifState), "count", ifCount),
                        "networks", list,
                        "connecting", ours == null ? null : Json.Obj("ssid", ours, "ms", oursMs),
                        "last", last,
                        "scannedAgoMs", scanned < 0 ? (object)null : (object)scanned,
                        "readMs", sw.ElapsedMilliseconds,
                        "reason", null);
      } catch (Exception ex) {
        return Unavailable(false, true, false, "the Wi-Fi networks could not be read (" + ex.Message + ")", sw);
      } finally {
        Close(h);
      }
    }

    static IDictionary Unavailable(bool ok, bool present, bool on, string reason, Stopwatch sw) {
      return Json.Obj("ok", ok, "present", present, "on", on, "iface", null, "networks", new List<object>(),
                      "connecting", null, "last", null, "scannedAgoMs", null, "readMs", sw.ElapsedMilliseconds,
                      "reason", reason);
    }

    /// One row: what it is, and what a click on it can honestly do.
    static IDictionary Describe(Net n, string joining, string ours) {
      string kind, label, why;
      Classify(n.Auth, n.Cipher, n.Secure, out kind, out label, out why);
      bool known = n.Profile != null;
      bool connecting = !n.Connected && n.NameIsText &&
                        ((joining != null && joining == n.Name) || (ours != null && (ours == n.Name || ours == n.Hex)));
      string action;
      if (n.Connected) { action = "disconnect"; why = null; }
      else if (n.Ssid.Length == 0) {
        action = "settings";
        why = "it hides its name, and joining it means typing that name, which Windows' own Wi-Fi list asks for";
      } else if (!n.NameIsText) {
        action = "settings";
        why = "its name is not valid text, so Mantle cannot write a profile for it";
      } else if (known) { action = "connect"; why = null; }
      else if (!n.Connectable) {
        action = "settings";
        why = "Windows says it cannot connect to this network: " + ReasonText(n.NotConnectableReason);
      } else if (kind == "open") action = "open";
      else if (kind == "personal") action = "password";
      else action = "settings";
      return Json.Obj("ssid", n.Ssid.Length == 0 ? null : n.Name, "hex", n.Hex, "hidden", n.Ssid.Length == 0,
                      "signal", n.Signal, "secure", n.Secure, "security", label,
                      "known", known, "connected", n.Connected, "connecting", connecting,
                      "action", action, "why", why);
    }

    /// The security type in Windows' words, and whether Mantle can set it up.
    /// kind: open | personal (a password) | settings (Windows' own list, with why).
    static void Classify(uint auth, uint cipher, bool secure, out string kind, out string label, out string why) {
      why = null;
      const string wep = "it uses WEP, an obsolete security type Mantle does not set up; Windows' own Wi-Fi list can still connect it";
      const string ent = "it uses enterprise (802.1X) sign-in - a user name and password or a certificate - which Windows' own Wi-Fi list asks for";
      switch (auth) {
        case 1:   // DOT11_AUTH_ALGO_80211_OPEN: open, unless a WEP key rides on it
          if (!secure || cipher == 0) { kind = "open"; label = "Open"; return; }
          kind = "settings"; label = "WEP"; why = wep; return;
        case 2: kind = "settings"; label = "WEP"; why = wep; return;
        case 3: kind = "settings"; label = "WPA-Enterprise"; why = ent; return;
        case 4: kind = "personal"; label = "WPA-Personal"; break;
        case 6: kind = "settings"; label = "WPA2-Enterprise"; why = ent; return;
        case 7: kind = "personal"; label = "WPA2-Personal"; break;
        case 8: kind = "settings"; label = "WPA3-Enterprise 192-bit"; why = ent; return;
        case 9: kind = "personal"; label = "WPA3-Personal"; break;
        case 10:
          kind = "settings"; label = "Enhanced Open";
          why = "it uses Enhanced Open (OWE), which Mantle does not set up yet; Windows' own Wi-Fi list can connect it";
          return;
        case 11: kind = "settings"; label = "WPA3-Enterprise"; why = ent; return;
        default:
          kind = "settings"; label = "Security type " + auth;
          why = "Mantle does not recognise its security type (" + auth + "), so it leaves the connection to Windows";
          return;
      }
      // A personal network: Mantle writes its profile only for a cipher it knows.
      string enc = CipherWord(cipher);
      if (enc == null) {
        kind = "settings";
        why = "its encryption (cipher 0x" + cipher.ToString("x", CultureInfo.InvariantCulture) + ") is not one Mantle sets up; Windows' own Wi-Fi list can connect it";
      }
    }

    static string CipherWord(uint cipher) {
      switch (cipher) {
        case 0x02: return "TKIP";
        case 0x04: return "AES";                // CCMP
        case 0x08: return "GCMP";
        case 0x09: return "GCMP256";
        case 0x100: return "AES";               // "use the group cipher": RSN networks are CCMP
        default: return null;
      }
    }

    static string AuthWord(uint auth) {
      switch (auth) {
        case 1: return "open";
        case 4: return "WPAPSK";
        case 7: return "WPA2PSK";
        case 9: return "WPA3SAE";
        default: return null;
      }
    }

    /// The test op's security names -> the profile schema's words.
    static bool SchemaWords(string security, out string auth, out string enc) {
      auth = null; enc = null;
      switch (security) {
        case "open": auth = "open"; enc = "none"; return true;
        case "wpa": auth = "WPAPSK"; enc = "TKIP"; return true;
        case "wpa2": auth = "WPA2PSK"; enc = "AES"; return true;
        case "wpa3": auth = "WPA3SAE"; enc = "AES"; return true;
        default: return false;
      }
    }

    static List<Net> ReadNetworks(IntPtr h, Guid g, out string err) {
      err = null;
      IntPtr data = IntPtr.Zero;
      try {
        uint rc = Native.WlanGetAvailableNetworkList(h, ref g, 0, IntPtr.Zero, out data);
        if (rc != 0 || data == IntPtr.Zero) {
          err = "Windows would not list the networks in range (" + ErrorText(rc) + ")";
          return null;
        }
        int count = Marshal.ReadInt32(data);
        var byHex = new Dictionary<string, Net>(StringComparer.Ordinal);
        var order = new List<Net>();
        var strict = new UTF8Encoding(false, true);
        for (int i = 0; i < count && i < 1024; i++) {
          IntPtr p = new IntPtr(data.ToInt64() + 8 + (long)i * NET_SIZE);
          uint bss = (uint)Marshal.ReadInt32(p, 548);
          if (bss != BSS_INFRASTRUCTURE) continue;          // ad hoc: Windows 11 does not offer those either
          int len = Marshal.ReadInt32(p, 512);
          if (len < 0 || len > 32) continue;
          var ssid = new byte[len];
          if (len > 0) Marshal.Copy(new IntPtr(p.ToInt64() + 516), ssid, 0, len);
          string hex = HexOf(ssid);
          uint flags = (uint)Marshal.ReadInt32(p, 620);
          string profile = (flags & NET_HAS_PROFILE) != 0 ? WString(p, 0, 256) : null;
          if (profile != null && profile.Length == 0) profile = null;

          Net n;
          if (byHex.TryGetValue(hex, out n)) {
            // Windows lists a network once per saved profile plus once without
            // one: fold them into one row that keeps the profile. Every hidden
            // network has the empty name, so they fold into ONE "hidden" row,
            // which is what Windows 11 shows too.
            if (n.Profile == null && profile != null) n.Profile = profile;
            if ((flags & NET_CONNECTED) != 0) { n.Connected = true; if (profile != null) n.Profile = profile; }
            n.Signal = Math.Max(n.Signal, Signal(p));
            n.Connectable = n.Connectable || Marshal.ReadInt32(p, 556) != 0;
            continue;
          }
          n = new Net();
          n.Ssid = ssid;
          n.Hex = hex;
          try { n.Name = strict.GetString(ssid); n.NameIsText = true; }
          catch (Exception) { n.Name = Encoding.UTF8.GetString(ssid); n.NameIsText = false; }
          if (n.NameIsText && !XmlSafe(n.Name)) n.NameIsText = false;
          n.Profile = profile;
          n.Connected = (flags & NET_CONNECTED) != 0;
          n.Signal = Signal(p);
          n.Connectable = Marshal.ReadInt32(p, 556) != 0;
          n.NotConnectableReason = (uint)Marshal.ReadInt32(p, 560);
          n.Secure = Marshal.ReadInt32(p, 608) != 0;
          n.Auth = (uint)Marshal.ReadInt32(p, 612);
          n.Cipher = (uint)Marshal.ReadInt32(p, 616);
          byHex[hex] = n;
          order.Add(n);
        }
        // Windows 11's order: the connected network, then the ones it knows,
        // then the rest; strongest first within each.
        order.Sort(delegate (Net a, Net b) {
          int ra = a.Connected ? 0 : a.Profile != null ? 1 : a.Ssid.Length == 0 ? 3 : 2;
          int rb = b.Connected ? 0 : b.Profile != null ? 1 : b.Ssid.Length == 0 ? 3 : 2;
          if (ra != rb) return ra.CompareTo(rb);
          if (a.Signal != b.Signal) return b.Signal.CompareTo(a.Signal);
          return string.CompareOrdinal(a.Name, b.Name);
        });
        return order;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    static int Signal(IntPtr p) {
      int s = Marshal.ReadInt32(p, 604);
      return s < 0 ? 0 : s > 100 ? 100 : s;
    }

    // ================================================================= scan

    static void StartScan(object id, long arrivedTs, int ttlMs) {
      var w = new Waiting();
      w.Id = id;
      w.ArrivedTs = arrivedTs;
      w.TtlMs = ttlMs;
      bool start;
      lock (_lock) {
        start = _scanWaiters == null;
        if (start) _scanWaiters = new List<Waiting>();
        _scanWaiters.Add(w);
      }
      if (!start) return;                  // a scan is already running: this caller rides on it
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        IDictionary reply;
        try {
          IDictionary scan = ScanOnce();
          reply = List();
          reply["scan"] = scan;
        } catch (Exception ex) {
          reply = Json.Obj("ok", false, "reason", "the Wi-Fi scan failed inside Mantle (" + ex.Message + ")");
        }
        List<Waiting> all;
        lock (_lock) { all = _scanWaiters; _scanWaiters = null; }
        foreach (Waiting x in all) Program.ReplyFromWorker(x.Id, true, reply, null);
      });
    }

    /// WlanScan returns at once; the list is only new when Windows says the
    /// scan finished. So: listen, scan, wait for complete/fail (or ScanWaitMs).
    static IDictionary ScanOnce() {
      var sw = Stopwatch.StartNew();
      IntPtr h = IntPtr.Zero;
      int token = 0;
      try {
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", err);
        Guid g;
        string ifName;
        uint ifState;
        int ifCount;
        err = PickInterface(h, out g, out ifName, out ifState, out ifCount);
        if (err != null) return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", err);
        if (!RadioOn(h, g))
          return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", "the Wi-Fi radio is off, so there is nothing to scan with");

        var w = new Waiter(g, new uint[] { ACM_SCAN_COMPLETE, ACM_SCAN_FAIL }, null);
        string lerr;
        token = Listen(h, w, out lerr);
        uint rc = Native.WlanScan(h, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (rc != 0)
          return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", "Windows refused to scan (" + ErrorText(rc) + ")");
        if (token == 0) {
          // No notifications: wait the driver's 4 s budget and read what is there.
          Thread.Sleep(4000);
          lock (_lock) _lastScanTs = Stopwatch.GetTimestamp();
          return Json.Obj("ok", true, "ms", sw.ElapsedMilliseconds,
                          "reason", "Windows' scan notifications were unavailable (" + lerr + "), so Mantle waited 4 s and read the list");
        }
        if (!w.Done.WaitOne(ScanWaitMs))
          return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds,
                          "reason", "Windows did not report the scan finished within " + (ScanWaitMs / 1000) + " s, so this is the list as it stood");
        if (w.Code == ACM_SCAN_FAIL)
          return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", "the scan failed: " + ReasonText(w.ReasonCode));
        lock (_lock) _lastScanTs = Stopwatch.GetTimestamp();
        return Json.Obj("ok", true, "ms", sw.ElapsedMilliseconds, "reason", null);
      } catch (Exception ex) {
        return Json.Obj("ok", false, "ms", sw.ElapsedMilliseconds, "reason", "the scan could not run (" + ex.Message + ")");
      } finally {
        Unlisten(h, token);
        Close(h);
      }
    }

    // ============================================================== connect

    /// Join `ssid` (or the network whose name is `hex`). A saved network is
    /// joined with its profile; an open or password network gets a generated
    /// profile first, and if that first connect fails the profile is deleted
    /// again, so a mistyped password leaves nothing behind (Windows does the
    /// same). The reply is the read-back, not the request.
    static IDictionary Connect(string ssid, string hex, string password, bool auto) {
      var sw = Stopwatch.StartNew();
      IntPtr h = IntPtr.Zero;
      int token = 0;
      string shown = ssid ?? hex;
      string profile = null;
      bool made = false;
      try {
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Outcome(false, shown, err, 0, sw);
        Guid g;
        string ifName;
        uint ifState;
        int ifCount;
        err = PickInterface(h, out g, out ifName, out ifState, out ifCount);
        if (err != null) return Outcome(false, shown, err, 0, sw);
        if (!RadioOn(h, g)) return Outcome(false, shown, "the Wi-Fi radio is off; turn Wi-Fi on first", 0, sw);

        List<Net> nets = ReadNetworks(h, g, out err);
        if (nets == null) return Outcome(false, shown, err, 0, sw);
        Net n = null;
        foreach (Net x in nets) {
          if (hex != null ? string.Equals(x.Hex, hex, StringComparison.OrdinalIgnoreCase) : (x.NameIsText && x.Name == ssid)) { n = x; break; }
        }
        if (n == null)
          return Outcome(false, shown, "\"" + shown + "\" is not in range any more (it is not in Windows' list of networks); refresh and try again", 0, sw);
        shown = n.Name;
        if (n.Connected) {
          password = null;
          return Outcome(true, shown, null, 0, sw);
        }
        if (!n.NameIsText) return Outcome(false, shown, "its name is not valid text, so Mantle cannot write a profile for it", 0, sw);

        profile = n.Profile;
        if (profile != null) {
          if (password != null) {
            password = null;
            return Outcome(false, shown, "\"" + shown + "\" is already saved in Windows, so Mantle connects with the saved password; " +
                                         "to change it, use Windows Wi-Fi settings", 0, sw);
          }
        } else {
          string kind, label, why;
          Classify(n.Auth, n.Cipher, n.Secure, out kind, out label, out why);
          if (!n.Connectable) {
            password = null;
            return Outcome(false, shown, "Windows says it cannot connect to this network: " + ReasonText(n.NotConnectableReason), 0, sw);
          }
          string auth = AuthWord(n.Auth), enc = kind == "open" ? "none" : CipherWord(n.Cipher);
          if (kind == "open") {
            if (password != null) { password = null; return Outcome(false, shown, "\"" + shown + "\" is an open network: it takes no password", 0, sw); }
          } else if (kind == "personal") {
            if (password == null) return Outcome(false, shown, "\"" + shown + "\" needs its password", 0, sw);
          } else {
            password = null;
            return Outcome(false, shown, why, 0, sw);
          }
          string name = ProfileName(n.Name);
          // Never overwrite a saved profile: it may hold a key Owen still wants.
          if (ProfileExists(h, g, name)) {
            password = null;
            return Outcome(false, shown, "Windows already has a saved network called \"" + name + "\" that does not match the one in range now; " +
                                         "change or forget it in Windows Wi-Fi settings", 0, sw);
          }
          string xml = ProfileXml(name, n.Ssid, n.Name, auth, enc, password, auto);
          password = null;
          if (!WellFormed(xml)) {
            xml = null;
            return Outcome(false, shown, "Mantle built a profile Windows could not read (a Mantle bug; nothing was changed)", 0, sw);
          }
          uint why2;
          uint rc = Native.WlanSetProfile(h, ref g, 0, xml, null, false, IntPtr.Zero, out why2);
          xml = null;                      // the last copy of the key; nothing below needs it
          if (rc != 0)
            return Outcome(false, shown, "Windows refused the network profile (" + ErrorText(rc) +
                                         (why2 != 0 ? "; " + ReasonText(why2) : "") + ")", why2, sw);
          profile = name;
          made = true;
        }

        // Listen BEFORE connecting, or a fast connect could finish unheard.
        var w = new Waiter(g, new uint[] { ACM_CONNECTION_COMPLETE, ACM_CONNECTION_ATTEMPT_FAIL }, profile);
        string lerr;
        token = Listen(h, w, out lerr);
        var cp = new Native.WLAN_CONNECTION_PARAMETERS();
        cp.wlanConnectionMode = MODE_PROFILE;
        cp.strProfile = profile;
        cp.dot11BssType = BSS_INFRASTRUCTURE;
        uint crc = Native.WlanConnect(h, ref g, ref cp, IntPtr.Zero);
        if (crc != 0) {
          string gone = made ? Forget(h, g, profile) : null;
          return Outcome(false, shown, "Windows refused to start connecting (" + ErrorText(crc) + ")" + gone, 0, sw);
        }

        bool heard;
        uint code = 0;
        bool ok;
        if (token != 0) {
          heard = w.Done.WaitOne(ConnectWaitMs);
          code = w.ReasonCode;
          ok = heard && w.Code == ACM_CONNECTION_COMPLETE && code == 0;
        } else {
          // No notifications (they failed to register): poll the connection.
          heard = false;
          ok = false;
          for (int waited = 0; waited < ConnectWaitMs; waited += 500) {
            Thread.Sleep(500);
            if (CurrentSsid(h, g) == shown && ConnectedNow(h, g)) { ok = true; heard = true; break; }
          }
        }
        string reason = ok ? null
          : !heard ? "Windows did not finish connecting within " + (ConnectWaitMs / 1000) + " s"
          : ReasonText(code);
        if (!ok && made) reason += Forget(h, g, profile);
        return Outcome(ok, shown, reason, code, sw);
      } catch (Exception ex) {
        string gone = made && h != IntPtr.Zero && profile != null ? ForgetQuietly(h, profile) : "";
        return Outcome(false, shown, "the connection could not be made (" + ex.GetType().Name + ": " + ex.Message + ")" + gone, 0, sw);
      } finally {
        password = null;
        Unlisten(h, token);
        Close(h);
      }
    }

    /// A hidden network (lane net2): no scan lists it, so there is nothing to match. Writes a
    /// nonBroadcast profile for the name and security given, then connects by it and waits the
    /// same way Connect does. Never overwrites a saved profile; a failed join removes the profile
    /// it made.
    static IDictionary ConnectHidden(string ssid, string auth, string enc, string password, bool auto) {
      var sw = Stopwatch.StartNew();
      IntPtr h = IntPtr.Zero;
      int token = 0;
      string profile = null;
      bool made = false;
      try {
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Outcome(false, ssid, err, 0, sw);
        Guid g; string ifName; uint ifState; int ifCount;
        err = PickInterface(h, out g, out ifName, out ifState, out ifCount);
        if (err != null) return Outcome(false, ssid, err, 0, sw);
        if (!RadioOn(h, g)) return Outcome(false, ssid, "the Wi-Fi radio is off; turn Wi-Fi on first", 0, sw);
        string name = ProfileName(ssid);
        if (ProfileExists(h, g, name)) {
          password = null;
          return Outcome(false, ssid, "Windows already has a saved network called \"" + name + "\"; connect to it from the saved networks, or forget it first", 0, sw);
        }
        string xml = ProfileXml(name, Encoding.UTF8.GetBytes(ssid), ssid, auth, enc, password, auto, true);
        password = null;
        if (!WellFormed(xml)) { xml = null; return Outcome(false, ssid, "Mantle built a profile Windows could not read (a Mantle bug; nothing was changed)", 0, sw); }
        uint why2;
        uint rc = Native.WlanSetProfile(h, ref g, 0, xml, null, false, IntPtr.Zero, out why2);
        xml = null;
        if (rc != 0) return Outcome(false, ssid, "Windows refused the network profile (" + ErrorText(rc) + (why2 != 0 ? "; " + ReasonText(why2) : "") + ")", why2, sw);
        profile = name;
        made = true;
        var w = new Waiter(g, new uint[] { ACM_CONNECTION_COMPLETE, ACM_CONNECTION_ATTEMPT_FAIL }, profile);
        string lerr;
        token = Listen(h, w, out lerr);
        var cp = new Native.WLAN_CONNECTION_PARAMETERS();
        cp.wlanConnectionMode = MODE_PROFILE;
        cp.strProfile = profile;
        cp.dot11BssType = BSS_INFRASTRUCTURE;
        uint crc = Native.WlanConnect(h, ref g, ref cp, IntPtr.Zero);
        if (crc != 0) return Outcome(false, ssid, "Windows refused to start connecting (" + ErrorText(crc) + ")" + Forget(h, g, profile), 0, sw);
        bool heard, ok;
        uint code = 0;
        if (token != 0) {
          heard = w.Done.WaitOne(ConnectWaitMs);
          code = w.ReasonCode;
          ok = heard && w.Code == ACM_CONNECTION_COMPLETE && code == 0;
        } else {
          heard = false; ok = false;
          for (int waited = 0; waited < ConnectWaitMs; waited += 500) {
            Thread.Sleep(500);
            if (CurrentSsid(h, g) == ssid && ConnectedNow(h, g)) { ok = true; heard = true; break; }
          }
        }
        string reason = ok ? null : !heard ? "Windows did not find or join the hidden network within " + (ConnectWaitMs / 1000) + " s" : ReasonText(code);
        if (!ok) reason += Forget(h, g, profile);
        return Outcome(ok, ssid, reason, code, sw);
      } catch (Exception ex) {
        string gone = made && h != IntPtr.Zero && profile != null ? ForgetQuietly(h, profile) : "";
        return Outcome(false, ssid, "the connection could not be made (" + ex.GetType().Name + ": " + ex.Message + ")" + gone, 0, sw);
      } finally {
        password = null;
        Unlisten(h, token);
        Close(h);
      }
    }

    /// Delete the profile THIS connect created, after it failed. Returns the
    /// text to append to the reason (it is part of what happened).
    static string Forget(IntPtr h, Guid g, string profile) {
      uint rc = Native.WlanDeleteProfile(h, ref g, profile, IntPtr.Zero);
      return rc == 0 ? " (the profile Mantle had just saved for it was removed again)"
                     : " (and the profile Mantle had just saved could not be removed: " + ErrorText(rc) + "; forget it in Windows Wi-Fi settings)";
    }

    /// Forget() for the exception path, where the interface must be found again.
    /// A failure here still says so: a profile left behind is Owen's to clean up.
    static string ForgetQuietly(IntPtr h, string profile) {
      const string left = " (and the profile Mantle had just saved may still be there; forget it in Windows Wi-Fi settings)";
      try {
        Guid g;
        string n;
        uint s;
        int c;
        if (PickInterface(h, out g, out n, out s, out c) != null) return left;
        return Forget(h, g, profile);
      } catch (Exception) {
        return left;
      }
    }

    static IDictionary Disconnect() {
      var sw = Stopwatch.StartNew();
      IntPtr h = IntPtr.Zero;
      int token = 0;
      try {
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Outcome(false, null, err, 0, sw, "disconnect");
        Guid g;
        string ifName;
        uint ifState;
        int ifCount;
        err = PickInterface(h, out g, out ifName, out ifState, out ifCount);
        if (err != null) return Outcome(false, null, err, 0, sw, "disconnect");
        string was = CurrentSsid(h, g);
        if (!ConnectedNow(h, g)) return Outcome(true, was, "Wi-Fi was not connected to any network", 0, sw, "disconnect");

        var w = new Waiter(g, new uint[] { ACM_DISCONNECTED }, null);
        string lerr;
        token = Listen(h, w, out lerr);
        uint rc = Native.WlanDisconnect(h, ref g, IntPtr.Zero);
        if (rc != 0) return Outcome(false, was, "Windows refused to disconnect (" + ErrorText(rc) + ")", 0, sw, "disconnect");
        if (token != 0) w.Done.WaitOne(DisconnectWaitMs);
        else Thread.Sleep(1000);
        bool still = ConnectedNow(h, g) && CurrentSsid(h, g) == was;
        return Outcome(!still, was, still ? "Windows still reports a connection to \"" + was + "\" after " + (DisconnectWaitMs / 1000) + " s" : null,
                       0, sw, "disconnect");
      } catch (Exception ex) {
        return Outcome(false, null, "Wi-Fi could not be disconnected (" + ex.Message + ")", 0, sw, "disconnect");
      } finally {
        Unlisten(h, token);
        Close(h);
      }
    }

    static IDictionary Outcome(bool ok, string ssid, string reason, uint code, Stopwatch sw) {
      return Outcome(ok, ssid, reason, code, sw, "connect");
    }

    /// The reply to a connect or disconnect: the outcome in words, plus the
    /// Wi-Fi state read back AFTER it, which also goes into QuickSettings'
    /// cache so the tile shows the new network on its very next read.
    static IDictionary Outcome(bool ok, string ssid, string reason, uint code, Stopwatch sw, string op) {
      IDictionary now = null;
      string readErr = null;
      try {
        now = Network.Read();
        QuickSettings.WifiChanged(now);
      } catch (Exception ex) {
        // The outcome still stands and the tile refreshes on its own; the reply
        // says the read-back is missing rather than leaving wifi quietly null.
        readErr = "the Wi-Fi state could not be read back afterwards (" + ex.Message + ")";
      }
      var d = Json.Obj("ok", ok, "op", op, "ssid", ssid,
                       "connected", now != null && true.Equals(now["connected"]) && (op == "disconnect" || Equals(now["ssid"], ssid)),
                       "code", code, "codeHex", "0x" + code.ToString("x", CultureInfo.InvariantCulture),
                       "ms", sw.ElapsedMilliseconds, "wifi", now, "wifiReason", readErr, "reason", reason);
      lock (_lock) {
        _last = Json.Obj("op", op, "ok", ok, "ssid", ssid, "reason", reason);
        _lastTs = Stopwatch.GetTimestamp();
      }
      return d;
    }

    // ======================================================= profile writing

    /// The WLAN profile for a network that has none yet, in the schema's own
    /// words (http://www.microsoft.com/networking/WLAN/profile/v1): auth is
    /// open / WPAPSK / WPA2PSK / WPA3SAE, enc none / TKIP / AES / GCMP /
    /// GCMP256. The SSID goes in as HEX (which Windows uses when both are
    /// present) and as text; every text value is XML-escaped. A 64-digit key is
    /// the raw PSK (networkKey), anything else a passphrase.
    public static string ProfileXml(string profileName, byte[] ssid, string ssidText, string auth, string enc, string key, bool auto) {
      return ProfileXml(profileName, ssid, ssidText, auth, enc, key, auto, false);
    }

    /// `hidden`: SSIDConfig/nonBroadcast=true, so Windows probes for a network that hides its name.
    public static string ProfileXml(string profileName, byte[] ssid, string ssidText, string auth, string enc, string key, bool auto, bool hidden) {
      var sb = new StringBuilder(1024);
      sb.Append("<?xml version=\"1.0\"?>");
      sb.Append("<WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\">");
      sb.Append("<name>").Append(Esc(profileName)).Append("</name>");
      sb.Append("<SSIDConfig><SSID><hex>").Append(HexOf(ssid)).Append("</hex>");
      if (ssidText != null && XmlSafe(ssidText)) sb.Append("<name>").Append(Esc(ssidText)).Append("</name>");
      sb.Append("</SSID>");
      if (hidden) sb.Append("<nonBroadcast>true</nonBroadcast>");
      sb.Append("</SSIDConfig>");
      sb.Append("<connectionType>ESS</connectionType>");
      sb.Append("<connectionMode>").Append(auto ? "auto" : "manual").Append("</connectionMode>");
      sb.Append("<MSM><security><authEncryption>");
      sb.Append("<authentication>").Append(auth).Append("</authentication>");
      sb.Append("<encryption>").Append(enc).Append("</encryption>");
      sb.Append("<useOneX>false</useOneX>");
      sb.Append("</authEncryption>");
      if (key != null) {
        bool raw = key.Length == 64 && IsHex(key, 64, 64);
        sb.Append("<sharedKey><keyType>").Append(raw ? "networkKey" : "passPhrase").Append("</keyType>");
        sb.Append("<protected>false</protected><keyMaterial>").Append(Esc(key)).Append("</keyMaterial></sharedKey>");
      }
      sb.Append("</security></MSM></WLANProfile>");
      return sb.ToString();
    }

    /// Windows names a profile after its network; a name that is not valid
    /// XML text has its control characters replaced.
    static string ProfileName(string ssid) {
      var sb = new StringBuilder(ssid.Length);
      foreach (char c in ssid) sb.Append(c < ' ' || c == '￾' || c == '￿' ? '_' : c);
      return sb.ToString();
    }

    /// WPA-Personal: 8-63 printable ASCII characters, or the raw key as exactly
    /// 64 hex digits. Said in words, never echoing the password itself.
    static string CheckPassword(string pw) {
      if (pw.Length == 64 && IsHex(pw, 64, 64)) return null;
      if (pw.Length < 8) return "a Wi-Fi password is at least 8 characters";
      if (pw.Length > 63) return "a Wi-Fi password is at most 63 characters (or exactly 64 hex digits)";
      foreach (char c in pw)
        if (c < 0x20 || c > 0x7e) return "a Wi-Fi password may only use the printable ASCII characters (letters, digits, spaces and symbols)";
      return null;
    }

    static bool WellFormed(string xml) {
      try {
        var doc = new XmlDocument();
        doc.XmlResolver = null;
        doc.LoadXml(xml);
        return doc.DocumentElement != null && doc.DocumentElement.LocalName == "WLANProfile";
      } catch (Exception) {
        return false;                 // the message could quote the key: never pass it on
      }
    }

    static bool ProfileExists(IntPtr h, Guid g, string name) {
      IntPtr data = IntPtr.Zero;
      try {
        if (Native.WlanGetProfileList(h, ref g, IntPtr.Zero, out data) != 0 || data == IntPtr.Zero) return false;
        int count = Marshal.ReadInt32(data);
        for (int i = 0; i < count && i < 4096; i++) {
          IntPtr p = new IntPtr(data.ToInt64() + 8 + (long)i * PROFILE_INFO_SIZE);
          if (string.Equals(WString(p, 0, 256), name, StringComparison.Ordinal)) return true;
        }
        return false;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    // ============================================================ the probe

    /// Every write entry point, called against ProbeGuid, which cannot be a
    /// real adapter (it is checked against the real ones first). Proves each
    /// P/Invoke signature binds and returns an error code rather than
    /// crashing. WlanSetProfile additionally gets a profile that is not a
    /// profile, and connect / delete a profile name that does not exist, so
    /// each of those would fail twice over even if the GUID were accepted.
    static IDictionary Probe() {
      IntPtr h = IntPtr.Zero;
      try {
        string err;
        h = Open(out err);
        if (h == IntPtr.Zero) return Json.Obj("ok", false, "reason", err);

        IntPtr list;
        if (Win32.WlanEnumInterfaces(h, IntPtr.Zero, out list) == 0 && list != IntPtr.Zero) {
          try {
            int count = Marshal.ReadInt32(list);
            int stride = Marshal.SizeOf(typeof(Win32.WLAN_INTERFACE_INFO));
            for (int i = 0; i < count; i++) {
              var info = (Win32.WLAN_INTERFACE_INFO)Marshal.PtrToStructure(
                new IntPtr(list.ToInt64() + 8 + (long)i * stride), typeof(Win32.WLAN_INTERFACE_INFO));
              if (info.InterfaceGuid == ProbeGuid)
                return Json.Obj("ok", false, "reason", "a real adapter has the probe's GUID; nothing was called");
            }
          } finally {
            Win32.WlanFreeMemory(list);
          }
        }

        Guid g = ProbeGuid;
        var codes = Json.Obj();
        codes["scan"] = Native.WlanScan(h, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        var cp = new Native.WLAN_CONNECTION_PARAMETERS();
        cp.wlanConnectionMode = MODE_PROFILE;
        cp.strProfile = ProbeProfile;
        cp.dot11BssType = BSS_INFRASTRUCTURE;
        codes["connect"] = Native.WlanConnect(h, ref g, ref cp, IntPtr.Zero);
        codes["disconnect"] = Native.WlanDisconnect(h, ref g, IntPtr.Zero);
        uint why;
        codes["setProfile"] = Native.WlanSetProfile(h, ref g, 0, "<not-a-wlan-profile/>", null, false, IntPtr.Zero, out why);
        codes["setProfileReason"] = why;
        codes["deleteProfile"] = Native.WlanDeleteProfile(h, ref g, ProbeProfile, IntPtr.Zero);
        IntPtr pl;
        codes["profileList"] = Native.WlanGetProfileList(h, ref g, IntPtr.Zero, out pl);
        if (pl != IntPtr.Zero) Win32.WlanFreeMemory(pl);
        IntPtr nl;
        codes["networkList"] = Native.WlanGetAvailableNetworkList(h, ref g, 0, IntPtr.Zero, out nl);
        if (nl != IntPtr.Zero) Win32.WlanFreeMemory(nl);

        // The notification callback, on the REAL handle: registering changes nothing.
        var w = new Waiter(g, new uint[0], null);
        string lerr;
        int token = Listen(h, w, out lerr);
        codes["notify"] = token != 0 ? 0 : 1;
        Unlisten(h, token);

        var sb = new StringBuilder(512);
        codes["reasonText"] = Native.WlanReasonCodeToString(0, (uint)sb.Capacity, sb, IntPtr.Zero);

        var names = Json.Obj("87", "ERROR_INVALID_PARAMETER", "1168", "ERROR_NOT_FOUND", "1206", "ERROR_BAD_PROFILE",
                             "5", "ERROR_ACCESS_DENIED", "0", "ERROR_SUCCESS");
        return Json.Obj("ok", true, "guid", g.ToString(), "codes", codes, "names", names,
                        "notifyReason", lerr, "reason", null);
      } finally {
        Close(h);
      }
    }

    // ========================================================= notifications
    // wlanapi calls back on its own thread. Each registration carries a token
    // as its context, so a callback wakes only the operation that asked.

    sealed class Waiter {
      public readonly Guid Iface;
      public readonly uint[] Codes;
      public readonly string Profile;          // connection codes must name this profile (null = any)
      public readonly ManualResetEvent Done = new ManualResetEvent(false);
      public uint Code, ReasonCode;
      public bool Fired;
      public Waiter(Guid iface, uint[] codes, string profile) { Iface = iface; Codes = codes; Profile = profile; }
    }

    static readonly Dictionary<int, Waiter> _waiters = new Dictionary<int, Waiter>();
    static int _nextToken;
    // Static, so the GC can never collect the delegate wlanapi is holding.
    static readonly Native.NotificationCallback _callback = OnNotification;

    static int Listen(IntPtr h, Waiter w, out string err) {
      err = null;
      int token;
      lock (_waiters) {
        token = ++_nextToken;
        if (token <= 0) token = _nextToken = 1;
        _waiters[token] = w;
      }
      uint prev;
      uint rc;
      try {
        rc = Native.WlanRegisterNotification(h, SOURCE_ACM, true, _callback, new IntPtr(token), IntPtr.Zero, out prev);
      } catch (Exception ex) {
        rc = uint.MaxValue;
        err = ex.Message;
      }
      if (rc != 0) {
        lock (_waiters) _waiters.Remove(token);
        if (err == null) err = ErrorText(rc);
        return 0;
      }
      return token;
    }

    static void Unlisten(IntPtr h, int token) {
      if (token == 0) return;
      if (h != IntPtr.Zero) {
        uint prev;
        try { Native.WlanRegisterNotification(h, SOURCE_NONE, true, null, IntPtr.Zero, IntPtr.Zero, out prev); } catch (Exception) { }
      }
      lock (_waiters) _waiters.Remove(token);
    }

    static void OnNotification(IntPtr data, IntPtr context) {
      try {
        if (data == IntPtr.Zero) return;
        Waiter w;
        lock (_waiters) { if (!_waiters.TryGetValue(context.ToInt32(), out w)) return; }
        var n = (Native.WLAN_NOTIFICATION_DATA)Marshal.PtrToStructure(data, typeof(Native.WLAN_NOTIFICATION_DATA));
        if (n.NotificationSource != SOURCE_ACM || n.InterfaceGuid != w.Iface) return;
        if (Array.IndexOf(w.Codes, n.NotificationCode) < 0) return;
        uint reason = 0;
        string profile = null;
        if (n.NotificationCode == ACM_CONNECTION_COMPLETE || n.NotificationCode == ACM_CONNECTION_ATTEMPT_FAIL ||
            n.NotificationCode == ACM_DISCONNECTED) {
          // WLAN_CONNECTION_NOTIFICATION_DATA: mode(4) profile(WCHAR[256]) ssid(36)
          // bssType(4) security(4) reason@560
          if (n.pData != IntPtr.Zero && n.dwDataSize >= 564) {
            profile = WString(n.pData, 4, 256);
            reason = (uint)Marshal.ReadInt32(n.pData, 560);
          }
          if (w.Profile != null && profile != null && !string.Equals(profile, w.Profile, StringComparison.Ordinal)) return;
        } else if (n.NotificationCode == ACM_SCAN_FAIL && n.pData != IntPtr.Zero && n.dwDataSize >= 4) {
          reason = (uint)Marshal.ReadInt32(n.pData);
        }
        lock (w) {
          if (w.Fired) return;
          w.Fired = true;
          w.Code = n.NotificationCode;
          w.ReasonCode = reason;
        }
        w.Done.Set();
      } catch (Exception) {
        // Never throw into wlanapi's thread.
      }
    }

    // ================================================================ helpers

    static IntPtr Open(out string err) {
      err = null;
      IntPtr h;
      uint negotiated;
      uint rc = Win32.WlanOpenHandle(2, IntPtr.Zero, out negotiated, out h);
      if (rc != 0 || h == IntPtr.Zero) {
        err = "the Wi-Fi service did not answer (WlanOpenHandle: " + ErrorText(rc) +
              "); this machine may have no wireless hardware, or WLAN AutoConfig may be stopped";
        return IntPtr.Zero;
      }
      return h;
    }

    static void Close(IntPtr h) {
      if (h != IntPtr.Zero) { try { Win32.WlanCloseHandle(h, IntPtr.Zero); } catch (Exception) { } }
    }

    /// The adapter everything acts on: the connected one, else the first.
    static string PickInterface(IntPtr h, out Guid g, out string name, out uint state, out int count) {
      g = Guid.Empty;
      name = null;
      state = 0;
      count = 0;
      IntPtr list;
      uint rc = Win32.WlanEnumInterfaces(h, IntPtr.Zero, out list);
      if (rc != 0 || list == IntPtr.Zero) return "no wireless interface could be enumerated (" + ErrorText(rc) + ")";
      try {
        count = Marshal.ReadInt32(list);
        if (count <= 0) return "this machine has no Wi-Fi adapter";
        int stride = Marshal.SizeOf(typeof(Win32.WLAN_INTERFACE_INFO));
        for (int i = 0; i < count; i++) {
          var info = (Win32.WLAN_INTERFACE_INFO)Marshal.PtrToStructure(
            new IntPtr(list.ToInt64() + 8 + (long)i * stride), typeof(Win32.WLAN_INTERFACE_INFO));
          if (i == 0 || info.isState == Win32.WLAN_INTERFACE_STATE_CONNECTED) {
            g = info.InterfaceGuid;
            name = info.strInterfaceDescription;
            state = info.isState;
            if (info.isState == Win32.WLAN_INTERFACE_STATE_CONNECTED) break;
          }
        }
        return null;
      } finally {
        Win32.WlanFreeMemory(list);
      }
    }

    static bool RadioOn(IntPtr h, Guid g) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref g, Win32.WLAN_INTF_OPCODE_RADIO_STATE, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return false;
        int phys = Marshal.ReadInt32(data);
        for (int i = 0; i < phys && i < 64; i++) {
          long at = data.ToInt64() + 4 + (long)i * 12;
          uint soft = (uint)Marshal.ReadInt32(new IntPtr(at + 4));
          uint hard = (uint)Marshal.ReadInt32(new IntPtr(at + 8));
          if (soft != Win32.DOT11_RADIO_STATE_OFF && hard != Win32.DOT11_RADIO_STATE_OFF) return true;
        }
        return false;
      } catch (Exception) {
        return false;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    /// The SSID of the current (or in-progress) connection, or null.
    static string CurrentSsid(IntPtr h, Guid g) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref g, Win32.WLAN_INTF_OPCODE_CURRENT_CONNECTION, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return null;
        var conn = (Win32.WLAN_CONNECTION_ATTRIBUTES)Marshal.PtrToStructure(data, typeof(Win32.WLAN_CONNECTION_ATTRIBUTES));
        var s = conn.wlanAssociationAttributes.dot11Ssid;
        int len = (int)s.uSSIDLength;
        return s.ucSSID != null && len > 0 && len <= 32 ? Encoding.UTF8.GetString(s.ucSSID, 0, len) : null;
      } catch (Exception) {
        return null;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    static bool ConnectedNow(IntPtr h, Guid g) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref g, Win32.WLAN_INTF_OPCODE_CURRENT_CONNECTION, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return false;
        return (uint)Marshal.ReadInt32(data) == Win32.WLAN_INTERFACE_STATE_CONNECTED;
      } catch (Exception) {
        return false;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    static string StateName(uint s) {
      return s < IfaceStates.Length ? IfaceStates[s] : "state " + s;
    }

    /// WLAN_REASON_CODE -> Windows' own sentence for it.
    public static string ReasonText(uint code) {
      try {
        var sb = new StringBuilder(512);
        uint rc = Native.WlanReasonCodeToString(code, (uint)sb.Capacity, sb, IntPtr.Zero);
        string s = rc == 0 ? sb.ToString().Trim() : null;
        if (!string.IsNullOrEmpty(s)) return s;
      } catch (Exception) { }
      return "Windows gave reason code 0x" + code.ToString("x", CultureInfo.InvariantCulture) + " and no text for it";
    }

    /// A Win32 error code in words (FormatMessage through Win32Exception).
    static string ErrorText(uint rc) {
      string text;
      try { text = new System.ComponentModel.Win32Exception((int)rc).Message; } catch (Exception) { text = null; }
      return "error " + rc + (string.IsNullOrEmpty(text) ? "" : ": " + text.TrimEnd('.', ' ', '\r', '\n'));
    }

    static string WString(IntPtr p, int offset, int maxChars) {
      string s = Marshal.PtrToStringUni(new IntPtr(p.ToInt64() + offset), maxChars);
      int nul = s.IndexOf('\0');
      return nul >= 0 ? s.Substring(0, nul) : s;
    }

    static string HexOf(byte[] b) {
      var sb = new StringBuilder(b.Length * 2);
      foreach (byte x in b) sb.Append(x.ToString("X2", CultureInfo.InvariantCulture));
      return sb.ToString();
    }

    static bool IsHex(string s, int minLen, int maxLen) {
      if (s == null || s.Length < minLen || s.Length > maxLen) return false;
      foreach (char c in s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
      return true;
    }

    /// XML 1.0 text: no control characters (tab/LF/CR aside) and no U+FFFE/F.
    static bool XmlSafe(string s) {
      foreach (char c in s) {
        if (c < ' ' && c != '\t' && c != '\n' && c != '\r') return false;
        if (c == '￾' || c == '￿') return false;
      }
      return true;
    }

    static string Esc(string s) {
      return SecurityElement.Escape(s);
    }

    static IDictionary Copy(IDictionary d) {
      var c = Json.Obj();
      foreach (DictionaryEntry e in d) c[e.Key] = e.Value;
      return c;
    }
  }
}
