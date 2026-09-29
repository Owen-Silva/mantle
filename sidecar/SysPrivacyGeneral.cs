// SysPrivacyGeneral.cs - Settings > Privacy & security's own switches for Mantle Settings (lane
// privacy, 2026-09-28): General, Speech, Inking & typing personalization, Diagnostics & feedback,
// Activity history, Search permissions, Voice activation and For developers.
//
// WHY: see SysPrivacy.cs. Each switch here is one or a few per-user registry values that Windows'
// own Settings writes (HKCU, no administrator). Two are different and say so on their row:
//   - the diagnostic data level and activity history are kept for the whole PC / by Windows'
//     own Settings, so they are READ-ONLY here with that reason;
//   - developer mode is HKLM AppModelUnlock AllowDevelopmentWithoutDevLicense: it goes through the
//     [Elevated("privacy.developerMode")] broker action, one UAC prompt per change.
// A policy value (HKLM\SOFTWARE\Policies\...) LOCKS a switch: read-only, with the policy named.
//
//   privacy.settings                       every value below: {key: {on|value, set, locked, why}}
//   privacy.set {key, value, dryRun?}      ONE switch (bool) or choice (string / number). dryRun
//                                          validates, reads and says what it would write.
//
// PRIVACY: nothing here logs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysPrivacyGeneral {
    public static void Register(FeatureTable t) {
      t.Add("privacy.settings", Lanes.Slow, Settings);
      t.Add("privacy.set", Lanes.Slow, Set);
    }

    public const string DevDoes = "turn developer mode on or off for this PC";
    const string Cdm = @"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";
    const string SearchSet = @"Software\Microsoft\Windows\CurrentVersion\SearchSettings";
    const string Voice = @"Software\Microsoft\Speech_OneCore\Settings\VoiceActivation\UserPreferenceForAllApps";
    const string Siuf = @"Software\Microsoft\Siuf\Rules";
    const string DevKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock";

    // One switch: every (path, name) gets On[i] or Off[i] as a DWORD; it reads On when the FIRST one
    // does. Dflt = what Windows does while nothing is stored (null = unknown). A policy lock:
    // PHive\PPath\PName equal to PVal forces it to POn.
    sealed class Sw {
      public string Key, Hive = "HKCU", Words; public string[] Paths, Names; public long[] On, Off; public bool? Dflt;
      public string PHive, PPath, PName; public long PVal; public bool POn;
    }
    static Sw S(string key, string words, string path, string name, long on, long off, bool? dflt) {
      var s = new Sw(); s.Key = key; s.Words = words; s.Paths = new[] { path }; s.Names = new[] { name };
      s.On = new[] { on }; s.Off = new[] { off }; s.Dflt = dflt; return s;
    }
    static Sw P(Sw s, string hive, string path, string name, long val, bool on) { s.PHive = hive; s.PPath = path; s.PName = name; s.PVal = val; s.POn = on; return s; }

    static readonly Sw[] SWITCHES = BuildSwitches();
    static Sw[] BuildSwitches() {
      var l = new List<Sw>();
      l.Add(P(S("advertisingId", "let apps show personalized ads by using your advertising ID", @"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo", "Enabled", 1, 0, true),
              "HKLM", @"SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo", "DisabledByGroupPolicy", 1, false));
      l.Add(S("languageList", "let websites show locally relevant content by accessing your language list", @"Control Panel\International\User Profile", "HttpAcceptLanguageOptOut", 0, 1, true));
      l.Add(P(S("appLaunchTracking", "let Windows improve Start and search results by tracking app launches", @"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Start_TrackProgs", 1, 0, true),
              "HKCU", @"Software\Policies\Microsoft\Windows\EdgeUI", "DisableMFUTracking", 1, false));
      var sug = S("suggestedContent", "show suggested content in the Settings app", Cdm, "SubscribedContent-338393Enabled", 1, 0, true);
      sug.Paths = new[] { Cdm, Cdm, Cdm }; sug.Names = new[] { "SubscribedContent-338393Enabled", "SubscribedContent-353694Enabled", "SubscribedContent-353696Enabled" };
      sug.On = new long[] { 1, 1, 1 }; sug.Off = new long[] { 0, 0, 0 };
      l.Add(sug);
      l.Add(S("settingsNotifications", "show notifications in the Settings app", @"Software\Microsoft\Windows\CurrentVersion\SystemSettings\AccountNotifications", "EnableAccountNotifications", 1, 0, true));
      l.Add(P(S("onlineSpeech", "use online speech recognition", @"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy", "HasAccepted", 1, 0, false),
              "HKLM", @"SOFTWARE\Policies\Microsoft\InputPersonalization", "AllowInputPersonalization", 0, false));
      var ink = S("inkingDictionary", "build a custom inking and typing dictionary from your writing", @"Software\Microsoft\InputPersonalization", "RestrictImplicitTextCollection", 0, 1, true);
      ink.Paths = new[] { @"Software\Microsoft\InputPersonalization", @"Software\Microsoft\InputPersonalization", @"Software\Microsoft\InputPersonalization\TrainedDataStore", @"Software\Microsoft\Personalization\Settings" };
      ink.Names = new[] { "RestrictImplicitTextCollection", "RestrictImplicitInkCollection", "HarvestContacts", "AcceptedPrivacyPolicy" };
      ink.On = new long[] { 0, 0, 1, 1 }; ink.Off = new long[] { 1, 1, 0, 0 };
      l.Add(P(ink, "HKLM", @"SOFTWARE\Policies\Microsoft\InputPersonalization", "AllowInputPersonalization", 0, false));
      l.Add(S("improveInking", "send optional inking and typing data to Microsoft", @"Software\Microsoft\Input\TIPC", "Enabled", 1, 0, false));
      l.Add(P(S("tailored", "let Microsoft use your diagnostic data for tailored experiences", @"Software\Microsoft\Windows\CurrentVersion\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", 1, 0, false),
              "HKCU", @"Software\Policies\Microsoft\Windows\CloudContent", "DisableTailoredExperiencesWithDiagnosticData", 1, false));
      l.Add(P(S("cloudSearchMsa", "search your Microsoft account's cloud content", SearchSet, "IsMSACloudSearchEnabled", 1, 0, true),
              "HKLM", @"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "AllowCloudSearch", 0, false));
      l.Add(P(S("cloudSearchWork", "search your work or school account's cloud content", SearchSet, "IsAADCloudSearchEnabled", 1, 0, true),
              "HKLM", @"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "AllowCloudSearch", 0, false));
      l.Add(S("searchHistory", "keep search history on this device", SearchSet, "IsDeviceSearchHistoryEnabled", 1, 0, true));
      l.Add(P(S("searchHighlights", "show search highlights", SearchSet, "IsDynamicSearchBoxEnabled", 1, 0, true),
              "HKLM", @"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "EnableDynamicContentInWSB", 0, false));
      l.Add(P(S("voiceActivation", "let apps use voice activation", Voice, "AgentActivationEnabled", 1, 0, null),
              "HKLM", SysPrivacy.AppPrivacy, "LetAppsActivateWithVoice", 2, false));
      l.Add(P(S("voiceLock", "let apps use voice activation while the device is locked", Voice, "AgentActivationOnLockScreenEnabled", 1, 0, null),
              "HKLM", SysPrivacy.AppPrivacy, "LetAppsActivateWithVoiceAboveLock", 2, false));
      l.Add(S("endTask", "show End task when you right-click an app on the taskbar", @"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\TaskbarDeveloperSettings", "TaskbarEndTask", 1, 0, false));
      return l.ToArray();
    }
    static Sw FindSw(string key) { foreach (Sw s in SWITCHES) if (s.Key == key) return s; return null; }

    static string Locked(Sw s) {
      if (s.PPath == null) return null;
      string w;
      long? v = SysCommon.ReadNumber(s.PHive, s.PPath, s.PName, out w);
      if (v == null || v.Value != s.PVal) return null;
      return "a policy on this PC " + (s.POn ? "keeps it on" : "keeps it off") + " (" + s.PName + " = " + s.PVal + ")";
    }

    static IDictionary ReadSw(Sw s) {
      string why;
      long? v = SysCommon.ReadNumber(s.Hive, s.Paths[0], s.Names[0], out why);
      bool? on = v == null ? s.Dflt : (bool?)(v.Value == s.On[0]);
      string lk = Locked(s);
      if (lk != null) on = s.POn;
      return Json.Obj("on", on, "set", v != null, "locked", lk, "why", v == null ? why : null);
    }

    // ------------------------------------------------------------------ the choices

    static IDictionary ReadSafeSearch() {
      string why;
      long? v = SysCommon.ReadNumber("HKCU", SearchSet, "SafeSearchMode", out why);
      string val = v == 0 ? "off" : v == 2 ? "strict" : "moderate";
      return Json.Obj("value", val, "set", v != null, "locked", null, "why", v == null ? why : null);
    }

    static IDictionary ReadFeedback() {
      string w1, w2;
      long? n = SysCommon.ReadNumber("HKCU", Siuf, "NumberOfSIUFInPeriod", out w1);
      object p = SysCommon.Read("HKCU", Siuf, "PeriodInNanoSeconds", out w2);
      long? per = p is long ? (long?)(long)p : p is int ? (long?)(int)p : null;
      string val;
      if (n == null && per == null) val = "auto";
      else if (n == 0) val = "never";
      else if (n == null && per == 100000000L) val = "always";
      else if (n == 1 && per == 864000000000L) val = "day";
      else if (n == 1 && per == 6048000000000L) val = "week";
      else val = "custom";
      string lk = null;
      string w3;
      if (SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "DoNotShowFeedbackNotifications", out w3) == 1) {
        lk = "a policy on this PC turns feedback requests off (DoNotShowFeedbackNotifications = 1)"; val = "never";
      }
      return Json.Obj("value", val, "set", n != null || per != null, "locked", lk, "why", null);
    }

    static IDictionary ReadDiagLevel() {
      string w;
      long? pol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "AllowTelemetry", out w);
      long? v = pol ?? SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\DataCollection", "AllowTelemetry", out w);
      string val = v == null ? null : v == 0 ? "security" : v == 1 ? "required" : "optional";
      return Json.Obj("value", val, "raw", v, "policy", pol != null,
                      "why", pol != null ? "a policy on this PC sets it (DataCollection AllowTelemetry = " + pol.Value + ")"
                           : "Windows keeps the diagnostic data level for the whole PC, and only its own Settings (through its telemetry service) or an administrator's policy sets it");
    }

    static IDictionary ReadActivity() {
      string w;
      long? pub = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\System", "PublishUserActivities", out w);
      long? feed = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\System", "EnableActivityFeed", out w);
      bool? off = pub == 0 || feed == 0 ? (bool?)true : null;
      return Json.Obj("on", off == true ? (object)false : null, "policy", off == true,
                      "why", off == true ? "a policy on this PC turns activity history off (" + (pub == 0 ? "PublishUserActivities" : "EnableActivityFeed") + " = 0)"
                                         : "Windows keeps this switch inside its own Settings with no documented setting another program may change, so Mantle shows it read-only");
    }

    static IDictionary ReadDevMode() {
      string w;
      long? v = SysCommon.ReadNumber("HKLM", DevKey, "AllowDevelopmentWithoutDevLicense", out w);
      return Json.Obj("on", v == 1, "set", v != null, "admin", !SysCommon.Elevated(), "does", DevDoes, "why", v == null ? w : null);
    }

    static string Settings(Dictionary<string, object> req, ref object result) {
      var vals = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (Sw s in SWITCHES) vals[s.Key] = ReadSw(s);
      vals["safeSearch"] = ReadSafeSearch();
      vals["feedback"] = ReadFeedback();
      vals["diagLevel"] = ReadDiagLevel();
      vals["activity"] = ReadActivity();
      vals["developerMode"] = ReadDevMode();
      result = Json.Obj("ok", true, "values", vals, "elevated", SysCommon.Elevated(), "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ writes

    static string Set(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return "privacy.set needs key (e.g. \"advertisingId\")";
      object raw;
      if (!Json.TryGet(req, "value", out raw)) return "privacy.set needs value";
      bool dry = Json.GetBool(req, "dryRun", false);
      if (key == "diagLevel") return "Read only: " + (string)ReadDiagLevel()["why"];
      if (key == "activity") return "Read only: " + (string)ReadActivity()["why"];
      if (key == "safeSearch") return SetSafeSearch(raw, dry, ref result);
      if (key == "feedback") return SetFeedback(raw, dry, ref result);
      if (key == "developerMode") return SetDev(raw, dry, ref result);
      Sw s = FindSw(key);
      if (s == null) return "privacy.set: unknown key \"" + key + "\"";
      if (!(raw is bool)) return key + " must be true or false";
      bool on = (bool)raw;
      string lk = Locked(s);
      if (lk != null) return "Read only: " + lk + ", so Windows ignores any other choice";
      bool? before = (bool?)ReadSw(s)["on"];
      var writes = new List<object>();
      for (int i = 0; i < s.Names.Length; i++) {
        string w;
        writes.Add(SysCommon.RegWrite(s.Hive, s.Paths[i], s.Names[i], on ? s.On[i] : s.Off[i], false, SysCommon.ReadNumber(s.Hive, s.Paths[i], s.Names[i], out w)));
      }
      string would = "turn \"" + s.Words + "\" " + (on ? "on" : "off") + " (" + s.Names.Length + " value" + (s.Names.Length == 1 ? "" : "s") + " in your profile)";
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", before, "to", on, "would", would, "writes", writes, "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": privacy.set would " + would;
      for (int i = 0; i < s.Names.Length; i++) {
        string err = SysCommon.WriteNumber(s.Hive, s.Paths[i], s.Names[i], on ? s.On[i] : s.Off[i], false);
        if (err != null) return "privacy.set " + key + ": " + err + (i > 0 ? " (after " + i + " of " + s.Names.Length + " values were written)" : "");
      }
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "from", before, "to", on, "now", ReadSw(s)["on"]);
      return null;
    }

    static string SetSafeSearch(object raw, bool dry, ref object result) {
      string v = raw as string;
      long n = v == "off" ? 0 : v == "moderate" ? 1 : v == "strict" ? 2 : -1;
      if (n < 0) return "safeSearch must be \"off\", \"moderate\" or \"strict\"";
      string before = (string)ReadSafeSearch()["value"];
      string would = "set SafeSearch from " + before + " to " + v;
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", "safeSearch", "from", before, "to", v, "would", would, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": privacy.set would " + would;
      string err = SysCommon.WriteNumber("HKCU", SearchSet, "SafeSearchMode", n, false);
      if (err != null) return "privacy.set safeSearch: " + err;
      result = Json.Obj("ok", true, "dryRun", false, "key", "safeSearch", "from", before, "to", v, "now", ReadSafeSearch()["value"]);
      return null;
    }

    static string SetFeedback(object raw, bool dry, ref object result) {
      string v = raw as string;
      if (v != "auto" && v != "always" && v != "day" && v != "week" && v != "never")
        return "feedback must be \"auto\", \"always\", \"day\", \"week\" or \"never\"";
      IDictionary cur = ReadFeedback();
      if (cur["locked"] != null) return "Read only: " + (string)cur["locked"];
      string before = (string)cur["value"];
      string would = "set how often Windows asks for feedback from " + before + " to " + v;
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", "feedback", "from", before, "to", v, "would", would, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": privacy.set would " + would;
      // The values Windows' own Settings leaves for each choice (none = Automatically).
      string err = null;
      if (v == "auto") { err = PrivReg.Delete("HKCU", Siuf, "NumberOfSIUFInPeriod") ?? PrivReg.Delete("HKCU", Siuf, "PeriodInNanoSeconds"); }
      else if (v == "always") { err = PrivReg.Delete("HKCU", Siuf, "NumberOfSIUFInPeriod") ?? PrivReg.WriteQword("HKCU", Siuf, "PeriodInNanoSeconds", 100000000L); }
      else if (v == "never") { err = SysCommon.WriteNumber("HKCU", Siuf, "NumberOfSIUFInPeriod", 0, false) ?? PrivReg.Delete("HKCU", Siuf, "PeriodInNanoSeconds"); }
      else {
        err = SysCommon.WriteNumber("HKCU", Siuf, "NumberOfSIUFInPeriod", 1, false) ??
              PrivReg.WriteQword("HKCU", Siuf, "PeriodInNanoSeconds", v == "day" ? 864000000000L : 6048000000000L);
      }
      if (err != null) return "privacy.set feedback: " + err;
      result = Json.Obj("ok", true, "dryRun", false, "key", "feedback", "from", before, "to", v, "now", ReadFeedback()["value"]);
      return null;
    }

    static string SetDev(object raw, bool dry, ref object result) {
      if (!(raw is bool)) return "developerMode must be true or false";
      bool on = (bool)raw;
      bool before = (bool)ReadDevMode()["on"];
      string would = "ask for administrator permission to " + DevDoes + ", then turn developer mode " + (on ? "on" : "off") +
                     " (HKLM AppModelUnlock AllowDevelopmentWithoutDevLicense = " + (on ? 1 : 0) + ")";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", "developerMode", "from", before, "to", on, "would", would, "needsAdmin", !SysCommon.Elevated(), "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": privacy.set would " + would;
      if (!SysCommon.Elevated()) {
        result = Json.Obj("ok", false, "needsAdmin", true, "elevate", Json.Obj("action", "privacy.developerMode", "args", Json.Obj("on", on)),
                          "reason", "Windows will ask for administrator permission to " + DevDoes);
        return null;
      }
      string err = SysCommon.WriteNumber("HKLM", DevKey, "AllowDevelopmentWithoutDevLicense", on ? 1 : 0, false);
      if (err != null) return "privacy.set developerMode: " + err;
      result = Json.Obj("ok", true, "key", "developerMode", "now", on);
      return null;
    }

    /// The one value Windows' Settings switches for developer mode. (Its optional "Developer Mode"
    /// package for Device Portal and SSH is installed by Windows on demand; Mantle does not add it.)
    [Elevated("privacy.developerMode", "CheckDev", DevDoes)]
    static string DeveloperMode(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      string err = SysCommon.WriteNumber("HKLM", DevKey, "AllowDevelopmentWithoutDevLicense", on ? 1 : 0, false);
      if (err != null) return "Windows did not change developer mode (" + err + ")";
      result = Json.Obj("now", on, "value", on, "note", on ? "Developer mode is on: apps can be installed from any source and links made without an administrator" : "Developer mode is off");
      return null;
    }

    static string CheckDev(Dictionary<string, object> args) { return SysCommon.CheckOn(args); }
  }
}
