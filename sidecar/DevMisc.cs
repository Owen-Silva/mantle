// DevMisc.cs - Cameras, AutoPlay and USB for Mantle Settings' Bluetooth & devices (lane devnet, 2026-09-28).
//
// WHY: the rest of Windows 11's Bluetooth & devices category, done natively (Owen: Mantle "should
// do everything windows can do and more and not ever rely on any old windows feature").
//
//   devcam.list                          every camera Windows knows: name, enabled, where it sits
//                                        (front / back / external), its device instance
//   camera.setEnabled {device, on}       [Elevated] switch a camera off or on, as Settings > Cameras'
//                                        Disable button does (it needs an administrator there too).
//                                        devcam.plan {device, on} is its non-elevated dry run.
//   autoplay.get                         "Use AutoPlay for all media and devices" and the default
//                                        action per kind of media, with every choice Windows offers
//   autoplay.enable {on, dryRun?}        the master switch (HKCU ...\AutoplayHandlers DisableAutoplay)
//   autoplay.choose {media, handler, dryRun?}   one kind of media's default
//   usb.get / usb.set {key, value, dryRun?}     "Connection notifications" (NotifyOnUsbErrors) and
//                                        "Show a notification if this PC is charging slowly over USB"
//                                        (NotifyOnWeakCharger), HKCU\Software\Microsoft\Shell\USB;
//                                        and USB battery saver (machine-wide: its dryRun is here,
//                                        the change is [Elevated] usb.setBatterySaver {on})
//
// WHERE THE VALUES LIVE, and how that was found (reads only, 2026-09-28): the value names are the
// strings in Windows' own settings handlers. UsbSettingsHandlers.dll and usbui.dll name
// "Shell\USB", "NotifyOnUsbErrors" and "NotifyOnWeakCharger"; SettingsHandlers_StorageSense.dll
// writes AutoplayHandlers\UserChosenExecuteHandlers\StorageOnArrival AND
// EventHandlersDefaultSelection\StorageOnArrival for "Removable drive"; SettingsHandlers_nt.dll
// holds DisableAutoplay. "Memory card" is the CameraAlternate\ShowPicturesOnArrival event (shell32's
// strings name CameraAlternate; the Settings page itself reaches it through shell COM, so that
// mapping is inferred, not read out of the page). A missing value means Windows' default: USB
// notifications on, AutoPlay on, and "not chosen" (Windows shows its choose-what-happens toast).
//
// NO DEFAULT CAMERA: Windows 11 has no system-wide default camera (SettingsHandlers_Camera.dll
// offers enable/disable, brightness, contrast, rotation and effects; each app picks its own
// camera), so devcam.list says so rather than inventing one.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;
#if MANTLE_WINMD
using Windows.Devices.Enumeration;
#endif

namespace Mantle {
  [MantleFeature]
  static class DevMisc {
    public static void Register(FeatureTable t) {
      t.Add("devcam.list", Lanes.Slow, CamList);
      t.Add("devcam.plan", Lanes.Slow, CamPlan);
      t.Add("autoplay.get", Lanes.Slow, AutoGet);
      t.Add("autoplay.enable", Lanes.Slow, AutoEnable);
      t.Add("autoplay.choose", Lanes.Slow, AutoChoose);
      t.Add("usb.get", Lanes.Ui, UsbGet);
      t.Add("usb.set", Lanes.Slow, UsbSet);
    }

    static class Native {
      [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
      public static extern int SHLoadIndirectString(string source, StringBuilder outBuf, int cch, IntPtr reserved);
      [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
      public static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Disable_DevNode(uint devInst, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Enable_DevNode(uint devInst, uint flags);
    }

    const int CR_SUCCESS = 0, CR_NO_SUCH_DEVNODE = 0x0D, CR_ACCESS_DENIED = 0x33;
    const uint CM_DISABLE_UI_NOT_OK = 0x4, CM_DISABLE_PERSIST = 0x8;
    const uint DN_STARTED = 0x8, CM_PROB_DISABLED = 0x16;
    // A camera's device instance: bus\ids\instance, the characters Windows uses there and nothing else.
    static readonly Regex InstanceRx = new Regex(@"^[A-Za-z0-9_]{1,16}\\[A-Za-z0-9_&.\-{}#]{1,200}\\[A-Za-z0-9_&.\-{}#]{1,200}$");

    static bool Dry(Dictionary<string, object> req) { return Json.GetBool(req, "dryRun", false); }

    // ------------------------------------------------------------------ cameras

    static string CamList(Dictionary<string, object> req, ref object result) {
#if MANTLE_WINMD
      DeviceInformationCollection all;
      string werr = WinRt.Await(DeviceInformation.FindAllAsync(DeviceInformation.GetAqsFilterFromDeviceClass(DeviceClass.VideoCapture),
                                  new string[] { "System.Devices.DeviceInstanceId" }), 5000, "the camera list", out all);
      if (werr != null) return "devcam.list: " + werr;
      var rows = new List<object>();
      foreach (DeviceInformation d in all) {
        string inst = null;
        object v;
        if (d.Properties.TryGetValue("System.Devices.DeviceInstanceId", out v)) inst = v as string;
        string where = "external";
        try {
          if (d.EnclosureLocation != null) {
            switch (d.EnclosureLocation.Panel) {
              case Panel.Front: where = "front"; break;
              case Panel.Back: where = "back"; break;
              case Panel.Unknown: where = d.EnclosureLocation.InLid ? "lid" : "external"; break;
              default: where = d.EnclosureLocation.Panel.ToString().ToLowerInvariant(); break;
            }
          }
        } catch (Exception) { where = "unknown"; }
        rows.Add(Json.Obj("device", inst, "name", d.Name, "enabled", d.IsEnabled && DevNodeRunning(inst),
                          "where", where, "reason", inst == null ? "Windows gave no device instance for this camera, so it cannot be switched" : null));
      }
      result = Json.Obj("ok", true, "cameras", rows, "defaultCamera", null,
                        "defaultReason", "Windows 11 has no system-wide default camera: each app chooses its own",
                        "reason", rows.Count == 0 ? "Windows lists no camera on this PC" : null);
      return null;
#else
      return "devcam.list: this sidecar was built without WinRT (MANTLE_WINMD), so it cannot list cameras";
#endif
    }

    /// True unless the device node is known to be disabled (a problem code 22).
    static bool DevNodeRunning(string inst) {
      if (string.IsNullOrEmpty(inst)) return true;
      uint dn;
      if (Native.CM_Locate_DevNodeW(out dn, inst, 0) != CR_SUCCESS) return true;
      uint status, problem;
      if (Native.CM_Get_DevNode_Status(out status, out problem, dn, 0) != CR_SUCCESS) return true;
      return problem != CM_PROB_DISABLED;
    }

    /// The whole check for camera.setEnabled: runs before the prompt, in the elevated copy, and for devcam.plan.
    static string CheckSetEnabled(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "device", "on");
      if (why != null) return why;
      object d, on;
      if (!args.TryGetValue("device", out d) || !(d is string)) return "a camera's device instance is needed (device)";
      if (!InstanceRx.IsMatch((string)d)) return "that is not a device instance Windows would name";
      if (!args.TryGetValue("on", out on) || !(on is bool)) return "on must be true or false";
      return null;
    }

    static string CamPlan(Dictionary<string, object> req, ref object result) {
      var args = new Dictionary<string, object>(StringComparer.Ordinal);
      object v;
      if (req.TryGetValue("device", out v)) args["device"] = v;
      if (req.TryGetValue("on", out v)) args["on"] = v;
      string why = CheckSetEnabled(args);
      if (why != null) return "devcam.plan: " + why;
      string inst = (string)args["device"];
      uint dn;
      int cr = Native.CM_Locate_DevNodeW(out dn, inst, 0);
      if (cr != CR_SUCCESS) return "devcam.plan: Windows has no device " + (cr == CR_NO_SUCH_DEVNODE ? "by that instance" : "it could find (CM error " + cr + ")");
      bool on = (bool)args["on"];
      bool running = DevNodeRunning(inst);
      result = Json.Obj("ok", true, "dryRun", true, "device", inst, "enabledNow", running, "on", on,
                        "action", "camera.setEnabled", "elevated", true,
                        "would", running == on ? "change nothing: the camera is already " + (on ? "on" : "off")
                                               : (on ? "switch the camera back on" : "switch the camera off for every app (Windows keeps it off across restarts)") +
                                                 " after an administrator prompt",
                        "reason", null);
      return null;
    }

    [Elevated("camera.setEnabled", "CheckSetEnabled", "switch this camera on or off")]
    static string CamSetEnabled(Dictionary<string, object> args, ref object result) {
      // CM_Disable_DevNode / CM_Enable_DevNode directly: the same device switch Device Manager and
      // Settings > Cameras use. No command line anywhere (ELEVATE.md).
      string inst = (string)args["device"];
      bool on = (bool)args["on"];
      uint dn;
      int cr = Native.CM_Locate_DevNodeW(out dn, inst, 0);
      if (cr != CR_SUCCESS) return "Windows could not find that camera (CM error " + cr + ")";
      cr = on ? Native.CM_Enable_DevNode(dn, 0) : Native.CM_Disable_DevNode(dn, CM_DISABLE_UI_NOT_OK | CM_DISABLE_PERSIST);
      if (cr == CR_ACCESS_DENIED) return "Windows refused: switching a camera needs an administrator (CM error 0x33)";
      if (cr != CR_SUCCESS) return "Windows did not " + (on ? "switch the camera on" : "switch the camera off") +
                                   " (CM error 0x" + cr.ToString("X", CultureInfo.InvariantCulture) + "); an app using it can hold it on";
      result = Json.Obj("device", inst, "on", on, "note", null);
      return null;
    }

    // ------------------------------------------------------------------ AutoPlay

    const string AP = @"Software\Microsoft\Windows\CurrentVersion\Explorer\AutoplayHandlers";
    const string APLM = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\AutoplayHandlers";

    // media key -> [label, the event whose handler list is offered, the settings page it is on].
    static readonly string[][] Media = {
      new[] { "StorageOnArrival", "Removable drive", "StorageOnArrival", "settings" },
      new[] { @"CameraAlternate\ShowPicturesOnArrival", "Memory card", "ShowPicturesOnArrival", "settings" },
      new[] { "ShowPicturesOnArrival", "Pictures", "ShowPicturesOnArrival", "classic" },
      new[] { "PlayVideoFilesOnArrival", "Videos", "PlayVideoFilesOnArrival", "classic" },
      new[] { "PlayMusicFilesOnArrival", "Music", "PlayMusicFilesOnArrival", "classic" },
      new[] { "MixedContentOnArrival", "Mixed content", "MixedContentOnArrival", "classic" },
      new[] { "PlayCDAudioOnArrival", "Audio CD", "PlayCDAudioOnArrival", "classic" },
      new[] { "PlayEnhancedCDOnArrival", "Enhanced audio CD", "PlayEnhancedCDOnArrival", "classic" },
      new[] { "PlayDVDMovieOnArrival", "DVD movie", "PlayDVDMovieOnArrival", "classic" },
      new[] { "HandleCDBurningOnArrival", "Blank CD", "HandleCDBurningOnArrival", "classic" },
      new[] { "AutorunINFLegacyArrival", "Software and games", "AutorunINFLegacyArrival", "classic" },
    };
    static readonly string[] Always = { "MSTakeNoAction", "MSOpenFolder", "MSPromptEachTime" };

    static string Indirect(string s) {
      if (string.IsNullOrEmpty(s) || s[0] != '@') return s;
      var sb = new StringBuilder(512);
      return Native.SHLoadIndirectString(s, sb, sb.Capacity, IntPtr.Zero) == 0 ? sb.ToString() : null;
    }

    static string HandlerLabel(string handler) {
      foreach (RegistryKey root in new RegistryKey[] { Registry.LocalMachine, Registry.CurrentUser }) {
        string path = (root == Registry.LocalMachine ? APLM : AP) + @"\Handlers\" + handler;
        try {
          using (RegistryKey k = root.OpenSubKey(path)) {
            if (k == null) continue;
            string action = Indirect(k.GetValue("Action") as string);
            string provider = Indirect(k.GetValue("Provider") as string);
            if (action == null) return null;
            return provider != null && provider != action ? action + " (" + provider + ")" : action;
          }
        } catch (Exception) { }
      }
      return null;
    }

    /// The handler names Windows offers for an event: HKLM's and HKCU's registrations, plus the
    /// three every event has (take no action, open folder, ask me every time).
    static List<string> Choices(string ev) {
      var names = new List<string>();
      foreach (RegistryKey root in new RegistryKey[] { Registry.LocalMachine, Registry.CurrentUser }) {
        try {
          using (RegistryKey k = root.OpenSubKey((root == Registry.LocalMachine ? APLM : AP) + @"\EventHandlers\" + ev)) {
            if (k == null) continue;
            foreach (string n in k.GetValueNames()) if (n.Length > 0 && !names.Contains(n)) names.Add(n);
          }
        } catch (Exception) { }
      }
      foreach (string a in Always) if (!names.Contains(a)) names.Add(a);
      return names;
    }

    static string ReadChosen(string media) {
      int slash = media.LastIndexOf('\\');
      string sub = AP + @"\UserChosenExecuteHandlers" + (slash > 0 ? @"\" + media.Substring(0, slash) : "");
      string name = slash > 0 ? media.Substring(slash + 1) : media;
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(sub)) return k == null ? null : k.GetValue(name) as string;
      } catch (Exception) { return null; }
    }

    static bool AutoplayOn(out string why) {
      why = null;
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(AP)) {
          object v = k == null ? null : k.GetValue("DisableAutoplay");
          return !(v is int && (int)v != 0);
        }
      } catch (Exception ex) { why = "AutoPlay's switch could not be read (" + ex.Message + ")"; return true; }
    }

    static string AutoGet(Dictionary<string, object> req, ref object result) {
      string why;
      bool on = AutoplayOn(out why);
      var media = new List<object>();
      foreach (string[] m in Media) {
        var choices = new List<object>();
        foreach (string h in Choices(m[2])) {
          string label = HandlerLabel(h);
          choices.Add(Json.Obj("handler", h, "label", label ?? h, "reason", label == null ? "Windows has no readable name for this handler" : null));
        }
        string chosen = ReadChosen(m[0]);
        media.Add(Json.Obj("media", m[0], "label", m[1], "page", m[3], "chosen", chosen, "choices", choices,
                           "chosenWords", chosen == null ? "not chosen yet: Windows asks with a notification" : null));
      }
      result = Json.Obj("ok", true, "enabled", on, "media", media, "reason", why);
      return null;
    }

    static string AutoEnable(Dictionary<string, object> req, ref object result) {
      object v;
      if (!Json.TryGet(req, "on", out v) || !(v is bool)) return "autoplay.enable needs on: true or false";
      bool on = (bool)v;
      string why;
      bool now = AutoplayOn(out why);
      string would = (on == now ? "leave AutoPlay " : "turn AutoPlay ") + (on ? "on" : "off") + " for all media and devices";
      if (Dry(req)) { result = Json.Obj("ok", true, "dryRun", true, "from", now, "to", on, "would", would, "reason", why); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": autoplay.enable would " + would;
      try {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(AP)) k.SetValue("DisableAutoplay", on ? 0 : 1, RegistryValueKind.DWord);
      } catch (Exception ex) { return "autoplay.enable: Windows did not save it (" + ex.Message + ")"; }
      result = Json.Obj("ok", true, "dryRun", false, "from", now, "to", on, "now", AutoplayOn(out why), "reason", why);
      return null;
    }

    static string AutoChoose(Dictionary<string, object> req, ref object result) {
      string media = Json.GetString(req, "media"), handler = Json.GetString(req, "handler");
      if (string.IsNullOrEmpty(media)) return "autoplay.choose needs media (e.g. \"StorageOnArrival\")";
      if (string.IsNullOrEmpty(handler)) return "autoplay.choose needs handler (one of that media's choices)";
      string[] m = null;
      foreach (string[] x in Media) if (x[0] == media) m = x;
      if (m == null) return "autoplay.choose: unknown media \"" + media + "\"";
      if (!Choices(m[2]).Contains(handler)) return "autoplay.choose: that handler is not one Windows offers for " + m[1];
      string before = ReadChosen(media);
      string would = "make \"" + (HandlerLabel(handler) ?? handler) + "\" what happens for " + m[1];
      if (Dry(req)) { result = Json.Obj("ok", true, "dryRun", true, "media", media, "from", before, "to", handler, "would", would, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": autoplay.choose would " + would;
      int slash = media.LastIndexOf('\\');
      string tail = slash > 0 ? @"\" + media.Substring(0, slash) : "";
      string name = slash > 0 ? media.Substring(slash + 1) : media;
      try {
        // Both keys, as Settings' own handler writes them (SettingsHandlers_StorageSense.dll).
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(AP + @"\UserChosenExecuteHandlers" + tail)) k.SetValue(name, handler, RegistryValueKind.String);
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(AP + @"\EventHandlersDefaultSelection" + tail)) k.SetValue(name, handler, RegistryValueKind.String);
      } catch (Exception ex) { return "autoplay.choose: Windows did not save it (" + ex.Message + ")"; }
      result = Json.Obj("ok", true, "dryRun", false, "media", media, "from", before, "to", handler, "now", ReadChosen(media), "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ USB

    const string USB = @"Software\Microsoft\Shell\USB";
    static readonly string[][] UsbKeys = {
      new[] { "notifyErrors", "NotifyOnUsbErrors", "Connection notifications: show one if there are issues connecting to USB devices" },
      new[] { "notifyWeakCharger", "NotifyOnWeakCharger", "Show a notification if this PC is charging slowly over USB" },
    };

    static bool UsbValue(string reg, out string why) {
      why = null;
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(USB)) {
          object v = k == null ? null : k.GetValue(reg);
          return !(v is int && (int)v == 0);        // missing = Windows' default, on
        }
      } catch (Exception ex) { why = ex.Message; return true; }
    }

    static string UsbGet(Dictionary<string, object> req, ref object result) {
      var rows = new List<object>();
      foreach (string[] k in UsbKeys) {
        string why;
        bool on = UsbValue(k[1], out why);
        rows.Add(Json.Obj("key", k[0], "label", k[2], "on", on, "reason", why == null ? null : "could not be read (" + why + ")"));
      }
      string bwhy;
      bool saver = BatterySaverOn(out bwhy);
      rows.Add(Json.Obj("key", "batterySaver", "label", "USB battery saver: stop USB devices from draining the battery when the screen is off",
                        "on", saver, "elevated", true, "action", "usb.setBatterySaver",
                        "reason", bwhy == null ? null : "could not be read (" + bwhy + ")"));
      result = Json.Obj("ok", true, "settings", rows, "reason", null);
      return null;
    }

    // USB battery saver is MACHINE-wide: HKLM\SYSTEM\CurrentControlSet\Control\USB\AutomaticSurpriseRemoval
    // AttemptRecoveryFromUsbPowerDrain (found by reading the registry for the name that
    // UsbSettingsHandlers.dll and SettingsHandlers_OneCore_PowerAndSleep.dll carry). Windows' Settings
    // writes it through its own system broker without a prompt; Mantle is not elevated, so it takes
    // one administrator prompt (usb.setBatterySaver).
    const string USBLM = @"SYSTEM\CurrentControlSet\Control\USB\AutomaticSurpriseRemoval";

    static bool BatterySaverOn(out string why) {
      why = null;
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(USBLM)) {
          object v = k == null ? null : k.GetValue("AttemptRecoveryFromUsbPowerDrain");
          return !(v is int && (int)v == 0);
        }
      } catch (Exception ex) { why = ex.Message; return true; }
    }

    static string CheckBatterySaver(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "on");
      if (why != null) return why;
      object on;
      if (!args.TryGetValue("on", out on) || !(on is bool)) return "on must be true or false";
      return null;
    }

    [Elevated("usb.setBatterySaver", "CheckBatterySaver", "change USB battery saver for every user of this PC")]
    static string SetBatterySaver(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      try {
        using (RegistryKey k = Registry.LocalMachine.CreateSubKey(USBLM))
          k.SetValue("AttemptRecoveryFromUsbPowerDrain", on ? 1 : 0, RegistryValueKind.DWord);
      } catch (Exception ex) { return "Windows did not save USB battery saver (" + ex.Message + ")"; }
      string why;
      result = Json.Obj("on", BatterySaverOn(out why), "note", null);
      return null;
    }

    static string UsbSet(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      string[] spec = null;
      foreach (string[] k in UsbKeys) if (k[0] == key) spec = k;
      object v;
      if (spec == null && key != "batterySaver") return "usb.set needs key: notifyErrors, notifyWeakCharger or batterySaver";
      if (!Json.TryGet(req, "value", out v) || !(v is bool)) return "usb.set needs value: true or false";
      bool on = (bool)v;
      string why;
      if (spec == null) {
        // batterySaver: the plan here, the change through the elevated action.
        bool cur = BatterySaverOn(out why);
        if (!Dry(req)) return "usb.set: USB battery saver is machine-wide; change it with the elevated action usb.setBatterySaver {on}";
        result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", cur, "to", on, "elevated", true, "action", "usb.setBatterySaver",
                          "would", (cur == on ? "change nothing: USB battery saver is already " : "turn USB battery saver ") + (on ? "on" : "off") +
                                   (cur == on ? "" : " for every user, after an administrator prompt"), "reason", why);
        return null;
      }
      bool now = UsbValue(spec[1], out why);
      string would = "turn \"" + spec[2] + "\" " + (on ? "on" : "off");
      if (Dry(req)) { result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", now, "to", on, "would", would, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": usb.set would " + would;
      try {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(USB)) k.SetValue(spec[1], on ? 1 : 0, RegistryValueKind.DWord);
      } catch (Exception ex) { return "usb.set: Windows did not save it (" + ex.Message + ")"; }
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "from", now, "to", on, "now", UsbValue(spec[1], out why), "reason", null);
      return null;
    }
  }
}
