// NetProxy.cs - Settings > Network & internet > Proxy (lane net2, 2026-09-28).
//
//   netproxy.get {}      autoDetect, script {on, url}, manual {on, server, port, bypass[], local}
//   netproxy.set {autoDetect?, script?:{on, url?}, manual?:{on, server?, port?, bypass?, local?}, dryRun}
//
// WHERE IT LIVES: the per-user WinINet "LAN" connection settings Windows' Proxy page edits: the
// flags (direct / proxy / script / auto-detect) in Internet Settings\Connections\DefaultConnectionSettings
// and the strings beside it. A write goes through InternetSetOption(PER_CONNECTION_OPTION), the
// documented call that writes all of it consistently, then SETTINGS_CHANGED + REFRESH so running
// apps pick it up, exactly as the Settings page does. Per-user: no administrator needed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class NetProxy {
    const string IS = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    const int FLAG_DIRECT = 1, FLAG_PROXY = 2, FLAG_SCRIPT = 4, FLAG_DETECT = 8;
    static readonly Regex HostRx = new Regex(@"^[A-Za-z0-9.\-\[\]:_]{1,253}$");
    static readonly Regex BypassRx = new Regex(@"^[A-Za-z0-9.\-\[\]:_*]{1,253}$");

    static class Native {
      [DllImport("wininet.dll", SetLastError = true)]
      public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);
    }

    public static void Register(FeatureTable t) {
      t.Add("netproxy.get", Lanes.Slow, Get);
      t.Add("netproxy.set", Lanes.Slow, Set);
    }

    sealed class State {
      public bool Detect, ScriptOn, ManualOn, Local;
      public string Script, Server;
      public int Port;
      public List<string> Bypass = new List<string>();
    }

    static State Read(out string why) {
      why = null;
      var s = new State();
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(IS)) {
          if (k == null) { why = "the proxy settings could not be opened"; return s; }
          string server = k.GetValue("ProxyServer") as string ?? "";
          string over = k.GetValue("ProxyOverride") as string ?? "";
          s.Script = k.GetValue("AutoConfigURL") as string;
          int flags = -1;
          using (RegistryKey c = k.OpenSubKey("Connections")) {
            byte[] b = c == null ? null : c.GetValue("DefaultConnectionSettings") as byte[];
            if (b != null && b.Length > 8) flags = b[8];
          }
          if (flags < 0) {                                  // never saved: fall back to the plain values
            object pe = k.GetValue("ProxyEnable");
            flags = (pe is int && (int)pe != 0 ? FLAG_PROXY : 0) | (s.Script != null ? FLAG_SCRIPT : 0) | FLAG_DETECT;
          }
          s.Detect = (flags & FLAG_DETECT) != 0;
          s.ScriptOn = (flags & FLAG_SCRIPT) != 0 && !string.IsNullOrEmpty(s.Script);
          s.ManualOn = (flags & FLAG_PROXY) != 0;
          // "host:port" (or a per-protocol list "http=h:p;https=h:p", shown as it is).
          int colon = server.LastIndexOf(':');
          int port;
          if (server.IndexOf('=') < 0 && colon > 0 && int.TryParse(server.Substring(colon + 1), out port)) { s.Server = server.Substring(0, colon); s.Port = port; }
          else s.Server = server.Length > 0 ? server : null;
          foreach (string p in over.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) {
            string x = p.Trim();
            if (x == "<local>") s.Local = true; else if (x.Length > 0) s.Bypass.Add(x);
          }
        }
      } catch (Exception ex) { why = "the proxy settings could not be read (" + SysCommon.Why(ex) + ")"; }
      return s;
    }

    static IDictionary Shape(State s) {
      return Json.Obj("autoDetect", s.Detect,
                      "script", Json.Obj("on", s.ScriptOn, "url", s.Script),
                      "manual", Json.Obj("on", s.ManualOn, "server", s.Server, "port", s.Port > 0 ? (object)s.Port : null,
                                         "bypass", new List<object>(s.Bypass.ToArray()), "local", s.Local));
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      string why;
      State s = Read(out why);
      if (why != null) return "netproxy.get: " + why;
      IDictionary r = Shape(s);
      r["ok"] = true; r["reason"] = null;
      result = r;
      return null;
    }

    static Dictionary<string, object> Sub(Dictionary<string, object> req, string key, out string err) {
      err = null;
      object v;
      if (!req.TryGetValue(key, out v)) return null;
      var d = v as Dictionary<string, object>;
      if (d == null) err = "netproxy.set: " + key + " must be an object";
      return d;
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      const string cmd = "netproxy.set";
      bool dry = Json.GetBool(req, "dryRun", false);
      string why;
      State s = Read(out why);
      if (why != null) return cmd + ": " + why;
      var changes = new List<object>();
      bool b;
      if (req.ContainsKey("autoDetect")) {
        string e = SysCommon.Bool(req, "autoDetect", cmd, out b);
        if (e != null) return e;
        if (b != s.Detect) changes.Add(b ? "detect proxy settings automatically" : "stop detecting proxy settings automatically");
        s.Detect = b;
      }
      string err;
      Dictionary<string, object> sc = Sub(req, "script", out err);
      if (err != null) return err;
      if (sc != null) {
        string e = SysCommon.Bool(sc, "on", cmd + " script", out b);
        if (e != null) return e;
        if (sc.ContainsKey("url")) {
          string url = Json.GetString(sc, "url") ?? "";
          if (url.Length > 2048 || url.IndexOf(' ') >= 0 || !Regex.IsMatch(url, "^(https?|file)://[^\\s\"]+$"))
            return cmd + ": the script address must be a web address like http://proxy.example/proxy.pac";
          s.Script = url;
        }
        if (b && string.IsNullOrEmpty(s.Script)) return cmd + ": type the setup script's address first";
        if (b != s.ScriptOn) changes.Add(b ? "use the setup script" : "stop using the setup script");
        s.ScriptOn = b;
      }
      Dictionary<string, object> m = Sub(req, "manual", out err);
      if (err != null) return err;
      if (m != null) {
        string e = SysCommon.Bool(m, "on", cmd + " manual", out b);
        if (e != null) return e;
        if (m.ContainsKey("server")) {
          string sv = Json.GetString(m, "server") ?? "";
          if (!HostRx.IsMatch(sv)) return cmd + ": the proxy server must be a name or address (letters, digits, . - :)";
          s.Server = sv;
        }
        if (m.ContainsKey("port")) {
          long port;
          e = SysCommon.Number(m, "port", cmd, 1, 65535, out port);
          if (e != null) return e;
          s.Port = (int)port;
        }
        if (m.ContainsKey("bypass")) {
          var l = m["bypass"] as List<object>;
          if (l == null || l.Count > 200) return cmd + ": bypass must be a list of up to 200 addresses";
          s.Bypass.Clear();
          foreach (object o in l) {
            string x = o as string;
            if (x == null || !BypassRx.IsMatch(x)) return cmd + ": \"" + (x ?? "?") + "\" is not an address Windows can skip the proxy for (letters, digits, . - : and *)";
            s.Bypass.Add(x);
          }
        }
        if (m.ContainsKey("local")) { e = SysCommon.Bool(m, "local", cmd, out b); if (e != null) return e; s.Local = b; b = (bool)m["on"]; }
        if (b && (string.IsNullOrEmpty(s.Server) || s.Port <= 0)) return cmd + ": type the proxy server's address and port first";
        if (b != s.ManualOn) changes.Add(b ? "send web traffic through " + s.Server + ":" + s.Port : "stop using the manual proxy");
        else if (b) changes.Add("update the manual proxy");
        s.ManualOn = b;
      }
      if (changes.Count == 0 && sc == null && m == null && !req.ContainsKey("autoDetect")) return cmd + " needs autoDetect, script or manual";
      string would = changes.Count == 0 ? "change nothing: the proxy is already set that way"
                                        : string.Join("; ", changes.ConvertAll(delegate (object o) { return (string)o; }).ToArray());
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "plan", Shape(s), "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      string werr = Write(s);
      if (werr != null) return cmd + ": " + werr;
      State now = Read(out why);
      result = Json.Obj("ok", true, "now", why == null ? Shape(now) : null, "reason", why);
      return null;
    }

    /// INTERNET_PER_CONN_OPTION_LIST for the LAN connection, marshalled by hand (the option's
    /// union is a pointer wide), then SETTINGS_CHANGED + REFRESH.
    static string Write(State s) {
      int flags = FLAG_DIRECT | (s.ManualOn ? FLAG_PROXY : 0) | (s.ScriptOn ? FLAG_SCRIPT : 0) | (s.Detect ? FLAG_DETECT : 0);
      var bypass = new List<string>(s.Bypass);
      if (s.Local) bypass.Add("<local>");
      string server = string.IsNullOrEmpty(s.Server) ? "" : s.Server + (s.Port > 0 ? ":" + s.Port : "");
      // {DWORD dwOption; union {DWORD; LPWSTR; FILETIME} Value}: the union is 8 bytes either way.
      int ptr = IntPtr.Size, optSize = ptr == 8 ? 16 : 12;
      IntPtr opts = Marshal.AllocCoTaskMem(optSize * 4);
      var strs = new List<IntPtr>();
      IntPtr list = IntPtr.Zero;
      try {
        object[][] items = {
          new object[] { 1, flags }, new object[] { 2, server },
          new object[] { 3, string.Join(";", bypass.ToArray()) }, new object[] { 4, s.Script ?? "" } };
        for (int i = 0; i < 4; i++) {
          IntPtr o = new IntPtr(opts.ToInt64() + i * optSize);
          Marshal.WriteInt32(o, 0, (int)items[i][0]);
          IntPtr v = new IntPtr(o.ToInt64() + ptr);
          if (items[i][1] is int) { Marshal.WriteIntPtr(v, IntPtr.Zero); Marshal.WriteInt32(v, (int)items[i][1]); }
          else { IntPtr p = Marshal.StringToCoTaskMemUni((string)items[i][1]); strs.Add(p); Marshal.WriteIntPtr(v, p); }
        }
        // {DWORD dwSize; LPWSTR pszConnection; DWORD dwOptionCount; DWORD dwOptionError; LPOPTION pOptions}
        int size = ptr == 8 ? 32 : 20;
        list = Marshal.AllocCoTaskMem(size);
        for (int i = 0; i < size; i += 4) Marshal.WriteInt32(list, i, 0);
        Marshal.WriteInt32(list, 0, size);
        Marshal.WriteIntPtr(list, ptr, IntPtr.Zero);           // null = the LAN settings
        Marshal.WriteInt32(list, ptr * 2, 4);
        Marshal.WriteIntPtr(list, ptr == 8 ? 24 : 16, opts);
        if (!Native.InternetSetOption(IntPtr.Zero, 75, list, size))
          return "Windows did not accept the proxy settings (error " + Marshal.GetLastWin32Error() + ")";
        Native.InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);   // SETTINGS_CHANGED
        Native.InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);   // REFRESH
        return null;
      } finally {
        foreach (IntPtr p in strs) Marshal.FreeCoTaskMem(p);
        Marshal.FreeCoTaskMem(opts);
        if (list != IntPtr.Zero) Marshal.FreeCoTaskMem(list);
      }
    }
  }
}
