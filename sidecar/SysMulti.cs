// SysMulti.cs - Mantle Settings > System: Multitasking, Clipboard, Nearby sharing, Projecting to this
// PC and Remote Desktop, natively (lane sysset, 2026-09-28).
//
// WHY: the small System pages of Windows' Settings are each a handful of per-user switches. Mantle
// owns snapping and Alt+Tab itself (the page shows Mantle's own options next to these), but Windows'
// switches still decide what Windows does wherever Mantle steps aside, so they are shown and changed
// here too.
//
//   sysmulti.get {}                                  every switch below: {value, default, set, writable, why}
//   sysmulti.set {key, value, dryRun?}               one switch; `value` is a bool or, for the
//                                                    choices, a number from the row's `choices`
//   sysmulti.clearClipboard {dryRun?}                "Clear clipboard data" (Windows' history, not Mantle's)
//   system.remoteDesktop {on}   [Elevated]           Remote Desktop on/off (Pro and up only)
//
// WHERE EACH LIVES (names are the ones Windows' Settings writes; Advanced values are DWORD, missing =
// Windows' default, which is what `default` says):
//   snap          HKCU Control Panel\Desktop WindowArrangementActive (REG_SZ "1"/"0"), changed through
//                 the DOCUMENTED SystemParametersInfo(SPI_SETWINARRANGING) so it applies at once
//   snapAssist, snapFlyout (EnableSnapAssistFlyout), snapBar (EnableSnapBar), snapGroups
//   (EnableTaskGroups), snapFill (SnapFill), jointResize (JointResize), shake (DisallowShaking,
//   INVERTED: 0 = shake on; Windows 11's default is off), desktopsTaskbar (VirtualDesktopTaskbarFilter
//   1 = only this desktop), desktopsAltTab (VirtualDesktopAltTabFilter), altTabTabs
//   (MultiTaskingAltTabFilter 3 = windows only, 2 = 3 recent tabs, 1 = 5, 0 = 20): HKCU Explorer\Advanced,
//   then WM_SETTINGCHANGE is broadcast (what Settings does). Explorer re-reading each one without a
//   restart is NOT PROVEN LIVE.
//   clipboardHistory / clipboardSync / clipboardAutoSync   HKCU Software\Microsoft\Clipboard
//   EnableClipboardHistory / EnableCloudClipboard / CloudClipboardAutomaticUpload.
//   nearbySharing HKCU ...\CDP NearShareChannelUserAuthzPolicy (0 off, 1 my devices, 2 everyone nearby);
//   measured here: 0. The Connected Devices service noticing without a sign-out is NOT PROVEN LIVE.
//   Remote Desktop: HKLM ...\Terminal Server fDenyTSConnections (0 = allowed) + the "Remote Desktop"
//   firewall rule group. THIS PC IS WINDOWS 11 HOME (EditionID Core), which cannot host Remote
//   Desktop at all: that is Microsoft's edition licensing, so the row is read-only with that reason.
//
// PASSIVE: reads and every dryRun answer; a real write answers FeatureTable.PassiveRefusal.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Mantle {
  [MantleFeature]
  static class SysMulti {
    const string Adv = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
    const string Clip = @"Software\Microsoft\Clipboard";
    const string Cdp = @"Software\Microsoft\Windows\CurrentVersion\CDP";
    const string DesktopKey = @"Control Panel\Desktop";
    const string TsKey = @"SYSTEM\CurrentControlSet\Control\Terminal Server";

    sealed class Row {
      public string Key, RegKey, Name; public long Default; public bool Inverted, AsString; public long[] Choices;
      public Row(string key, string regKey, string name, long dflt) { Key = key; RegKey = regKey; Name = name; Default = dflt; }
    }

    static readonly Row[] Rows = {
      new Row("snap", DesktopKey, "WindowArrangementActive", 1) { AsString = true },
      new Row("snapAssist", Adv, "SnapAssist", 1),
      new Row("snapFlyout", Adv, "EnableSnapAssistFlyout", 1),
      new Row("snapBar", Adv, "EnableSnapBar", 1),
      new Row("snapGroups", Adv, "EnableTaskGroups", 1),
      new Row("snapFill", Adv, "SnapFill", 1),
      new Row("jointResize", Adv, "JointResize", 1),
      new Row("shake", Adv, "DisallowShaking", 1) { Inverted = true },
      new Row("desktopsTaskbar", Adv, "VirtualDesktopTaskbarFilter", 1) { Choices = new long[] { 0, 1 } },
      new Row("desktopsAltTab", Adv, "VirtualDesktopAltTabFilter", 1) { Choices = new long[] { 0, 1 } },
      new Row("altTabTabs", Adv, "MultiTaskingAltTabFilter", 3) { Choices = new long[] { 0, 1, 2, 3 } },
      new Row("clipboardHistory", Clip, "EnableClipboardHistory", 0),
      new Row("clipboardSync", Clip, "EnableCloudClipboard", 0),
      new Row("clipboardAutoSync", Clip, "CloudClipboardAutomaticUpload", 0),
      new Row("nearbySharing", Cdp, "NearShareChannelUserAuthzPolicy", 0) { Choices = new long[] { 0, 1, 2 } },
    };

    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, IntPtr pv, uint winIni);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, out int pv, uint winIni);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
    const uint SPI_GETWINARRANGING = 0x0082, SPI_SETWINARRANGING = 0x0083;

    public static void Register(FeatureTable t) {
      t.Add("sysmulti.get", Lanes.Slow, Get);
      t.Add("sysmulti.set", Lanes.Slow, Set);
      t.Add("sysmulti.clearClipboard", Lanes.Slow, ClearClipboard);
    }

    public static string Edition() {
      string why;
      object v = SysCommon.Read("HKLM", @"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID", out why);
      return v as string;
    }

    /// PURE: can this edition host Remote Desktop? null = yes, else Microsoft's reason.
    public static string RdpWhy(string edition) {
      if (edition == null) return "Windows did not say which edition this is";
      string e = edition.ToLowerInvariant();
      if (e == "core" || e.StartsWith("core") || e == "home")
        return "Windows 11 Home cannot host Remote Desktop: Microsoft only licenses the Remote Desktop host in Pro, Enterprise and Education. This PC can still connect OUT to other PCs.";
      return null;
    }

    static long Value(Row r, out bool set, out string why) {
      long? n = SysCommon.ReadNumber("HKCU", r.RegKey, r.Name, out why);
      set = n.HasValue;
      long raw = n.HasValue ? n.Value : r.Default;
      return r.Inverted ? (raw != 0 ? 0 : 1) : raw;
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      try {
        var rows = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (Row r in Rows) {
          bool set; string why;
          long v = Value(r, out set, out why);
          if (r.Key == "snap") { int live; if (SystemParametersInfo(SPI_GETWINARRANGING, 0, out live, 0)) v = live != 0 ? 1 : 0; }
          object shown = r.Choices != null ? (object)v : (object)(v != 0);
          rows[r.Key] = Json.Obj("value", shown, "set", set, "writable", true, "why", null,
                                 "choices", r.Choices != null ? (object)new List<long>(r.Choices) : null);
        }
        string edition = Edition();
        string rdpWhy = RdpWhy(edition);
        string twhy;
        long? deny = SysCommon.ReadNumber("HKLM", TsKey, "fDenyTSConnections", out twhy);
        result = Json.Obj(
          "ok", true, "rows", rows, "edition", edition,
          "remoteDesktop", Json.Obj("on", deny.HasValue ? (object)(deny.Value == 0) : false,
                                    "writable", rdpWhy == null, "needsAdmin", true, "elevate", rdpWhy == null ? "system.remoteDesktop" : null,
                                    "why", rdpWhy ?? "Windows will ask for administrator permission to " + RdpAdmin.Does),
          "projecting", Json.Obj("available", false, "writable", false,
                                 "why", "Projecting to this PC needs Windows' optional Wireless Display feature; Mantle cannot install optional features yet"));
        return null;
      } catch (Exception ex) { return "sysmulti.get failed: " + SysCommon.Why(ex); }
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      try {
        string key = Json.GetString(req, "key");
        Row r = null;
        foreach (Row x in Rows) if (x.Key == key) r = x;
        if (r == null) {
          var names = new List<string>();
          foreach (Row x in Rows) names.Add(x.Key);
          return "sysmulti.set needs key: one of " + string.Join(", ", names.ToArray());
        }
        long want;
        if (r.Choices != null) {
          string nerr = SysCommon.Number(req, "value", "sysmulti.set", 0, 99, out want);
          if (nerr != null) return nerr;
          if (Array.IndexOf(r.Choices, want) < 0) return "sysmulti.set " + key + " takes one of " + string.Join(", ", Array.ConvertAll(r.Choices, c => c.ToString()));
        } else {
          bool on;
          string berr = SysCommon.Bool(req, "value", "sysmulti.set", out on);
          if (berr != null) return berr;
          want = on ? 1 : 0;
        }
        long raw = r.Inverted ? (want != 0 ? 0 : 1) : want;
        bool set; string why;
        long before = Value(r, out set, out why);
        var writes = new List<object>();
        if (r.Key == "snap") writes.Add(Json.Obj("api", "SystemParametersInfo", "action", "SPI_SETWINARRANGING", "value", raw, "flags", "SPIF_UPDATEINIFILE|SPIF_SENDCHANGE"));
        else {
          writes.Add(SysCommon.RegWrite("HKCU", r.RegKey, r.Name, raw, r.AsString, set ? (object)(r.Inverted ? (before != 0 ? 0 : 1) : before) : null));
          writes.Add(Json.Obj("api", "SendMessageTimeout", "msg", "WM_SETTINGCHANGE", "lParam", "TraySettings"));
        }
        if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, r.Choices != null ? (object)before : (object)(before != 0), null, false); return null; }
        if (Program.Passive) return SysCommon.Passive("changed the " + key + " setting");
        if (r.Key == "snap") {
          if (!SystemParametersInfo(SPI_SETWINARRANGING, (uint)raw, IntPtr.Zero, 0x3))
            return "Windows refused the change (error " + Marshal.GetLastWin32Error() + ")";
          int live;
          if (!SystemParametersInfo(SPI_GETWINARRANGING, 0, out live, 0) || (live != 0) != (raw != 0))
            return "Windows accepted the change but still reports snapping " + (live != 0 ? "on" : "off");
        } else {
          string err = SysCommon.WriteNumber("HKCU", r.RegKey, r.Name, raw, r.AsString);
          if (err != null) return err;
          IntPtr res;
          SendMessageTimeout((IntPtr)0xffff, 0x001A, IntPtr.Zero, "TraySettings", 0x2 /* ABORTIFHUNG */, 1000, out res);
        }
        result = Json.Obj("ok", true, "key", key, "value", r.Choices != null ? (object)want : (object)(want != 0));
        return null;
      } catch (Exception ex) { return "sysmulti.set failed: " + SysCommon.Why(ex); }
    }

    static string ClearClipboard(Dictionary<string, object> req, ref object result) {
      var writes = SysCommon.List(Json.Obj("api", "Windows.ApplicationModel.DataTransfer.Clipboard.ClearHistory"));
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, null, null, false); return null; }
      if (Program.Passive) return SysCommon.Passive("cleared Windows' clipboard history");
#if MANTLE_WINMD
      try {
        bool ok = Windows.ApplicationModel.DataTransfer.Clipboard.ClearHistory();
        if (!ok) return "Windows did not clear its clipboard history (it answered false)";
        result = Json.Obj("ok", true, "note", "Windows' clipboard history is cleared (pinned items stay). Mantle's own Win+V history is separate.");
        return null;
      } catch (Exception ex) { return "Windows refused to clear its clipboard history: " + SysCommon.Why(ex); }
#else
      return "this sidecar was built without WinRT (see build.ps1), so Windows' clipboard history cannot be reached";
#endif
    }

    /// Remote Desktop, administrator half. Validator refuses Home editions with Microsoft's reason.
    static class RdpAdmin {
      public const string Does = "turn Remote Desktop on or off";

      [Elevated("system.remoteDesktop", "Check", Does)]
      static string RemoteDesktop(Dictionary<string, object> args, ref object result) {
        bool on = (bool)args["on"];
        string err = SysCommon.WriteNumber("HKLM", TsKey, "fDenyTSConnections", on ? 0 : 1, false);
        if (err != null) return "Windows did not change Remote Desktop: " + err;
        // The firewall half, through the documented HNetCfg.FwPolicy2 COM object (what Settings does).
        string fw = null;
        try {
          Type t = Type.GetTypeFromProgID("HNetCfg.FwPolicy2", true);
          object pol = Activator.CreateInstance(t);
          t.InvokeMember("EnableRuleGroup", System.Reflection.BindingFlags.InvokeMethod, null, pol,
                         new object[] { 0x7fffffff /* all profiles */, "@FirewallAPI.dll,-28752" /* Remote Desktop */, on });
        } catch (Exception ex) { fw = SysCommon.Why(ex); }
        result = Json.Obj("on", on, "note", fw == null ? null : "Remote Desktop is " + (on ? "on" : "off") + ", but its firewall rules could not be changed (" + fw + ")");
        return null;
      }

      static string Check(Dictionary<string, object> args) {
        string why = SysCommon.CheckOn(args);
        if (why != null) return why;
        return RdpWhy(Edition());
      }
    }
  }
}
