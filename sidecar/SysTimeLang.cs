// SysTimeLang.cs - Settings > Time & language > Language, Typing and Speech for Mantle Settings
// (lane timelang, 2026-09-28). Page: ui/settings/sections/time.js.
//
//   syslang.get                        display language, preferred languages with their keyboards,
//                                      installed display languages, typing switches, advanced keyboard
//                                      settings, voices and speech recognizers. Each row says where
//                                      Windows keeps it, and every read-only one says why.
//   syslang.setTyping {key, value, dryRun}   ONE typing switch (HKCU DWORD, from the fixed table below)
//   syslang.setPerAppInput {on, dryRun}      "Let me use a different input method for each app window":
//                                      SPI_SETTHREADLOCALINPUTSETTINGS (0x104F), saved + announced
//
// READ-ONLY here, with the reason on the row (see Reasons below): adding or removing a language
// (Windows downloads a language pack from Microsoft through its Language features, administrator),
// the display language (Windows applies it only at the next sign-in, through its own language
// profile API), reordering the preferred languages and the default input method (Windows' language
// profile API, bcp47langs/winlangdb, which Mantle has not wired yet), the language bar (Windows'
// text input framework), voices and recognizers (installed by Windows' speech features).
//
// MEASURED on the user's desktop 2026-09-28 (reads only): TabletTip\1.7 and Input\Settings hold none of
// the typing switches (Windows' defaults apply); one preferred language with one keyboard; 3
// OneCore voices, 2 SAPI voices, 1 desktop recognizer. PRIVACY: nothing here logs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysLang {
    public static void Register(FeatureTable t) {
      t.Add("syslang.get", Lanes.Slow, Get);
      t.Add("syslang.setTyping", Lanes.Slow, SetTyping);
      t.Add("syslang.setPerAppInput", Lanes.Slow, SetPerAppInput);
    }

    static class Native {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetLocaleInfoEx(string locale, uint type, StringBuilder data, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetUserPreferredUILanguages(uint flags, out uint count, char[] buf, ref uint len);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint ui, ref int pv, uint ini);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint ui, IntPtr pv, uint ini);
    }

    const string TipKey = @"Software\Microsoft\TabletTip\1.7";
    const string InputKey = @"Software\Microsoft\Input\Settings";
    const string ProfileKey = @"Control Panel\International\User Profile";

    // The typing switches: key, HKCU key, value name, Windows' default when the value is absent, label.
    static readonly string[,] Typing = {
      { "touchSuggestions", TipKey, "EnableTextPrediction", "1", "Show text suggestions when typing on the touch keyboard" },
      { "hwSuggestions", InputKey, "EnableHwkbTextPrediction", "0", "Show text suggestions when typing on the physical keyboard" },
      { "multilingual", InputKey, "MultilingualEnabled", "0", "Multilingual text suggestions" },
      { "autocorrect", TipKey, "EnableAutocorrection", "1", "Autocorrect misspelled words" },
      { "highlight", TipKey, "EnableSpellchecking", "1", "Highlight misspelled words" },
      { "hwAutocorrect", InputKey, "EnableHwkbAutocorrection", "0", "Autocorrect misspelled words I type on the physical keyboard" },
      { "spaceAfter", TipKey, "EnablePredictionSpaceInsertion", "1", "Add a space after I choose a text suggestion" },
      { "doubleTapPeriod", TipKey, "EnableDoubleTapSpace", "1", "Add a period after I double-tap the Spacebar" },
      { "insights", InputKey, "InsightsEnabled", "1", "Typing insights" },
    };

    static string Display(string tag) {
      var sb = new StringBuilder(256);
      return Native.GetLocaleInfoEx(tag, 0x02 /* LOCALE_SLOCALIZEDDISPLAYNAME */, sb, sb.Capacity) > 0 ? sb.ToString() : null;
    }

    static List<string> Multi(string hive, string key, string name, out string why) {
      object v = SysCommon.Read(hive, key, name, out why);
      var list = new List<string>();
      string[] a = v as string[];
      if (a != null) {
        foreach (string s in a) if (!string.IsNullOrEmpty(s)) list.Add(s);
      } else if (v is string && ((string)v).Length > 0) {
        list.Add((string)v);
      }
      return list;
    }

    /// A keyboard entry "0409:00000409" -> the layout's name; a text service (TIP) entry -> its words.
    static string KeyboardName(string entry) {
      int colon = entry.IndexOf(':');
      string rest = colon >= 0 ? entry.Substring(colon + 1) : entry;
      if (rest.Length == 8) {
        string why;
        string text = SysCommon.Read("HKLM", @"SYSTEM\CurrentControlSet\Control\Keyboard Layouts\" + rest, "Layout Text", out why) as string;
        if (text != null) return text;
      }
      return rest.StartsWith("{", StringComparison.Ordinal) ? "Input method (text service)" : "Keyboard " + rest;
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      string why;
      // --- preferred languages and their keyboards
      List<string> tags = Multi("HKCU", ProfileKey, "Languages", out why);
      var langs = new List<object>();
      foreach (string tag in tags) {
        var kbs = new List<object>();
        try {
          using (RegistryKey k = Registry.CurrentUser.OpenSubKey(ProfileKey + "\\" + tag, false)) {
            if (k != null) foreach (string n in k.GetValueNames()) if (n.IndexOf(':') > 0) kbs.Add(Json.Obj("entry", n, "name", KeyboardName(n)));
          }
        } catch (Exception) { }
        langs.Add(Json.Obj("tag", tag, "name", Display(tag) ?? tag, "keyboards", kbs));
      }
      // --- the display language: what Windows uses now, and a pending change
      uint count, len = 0;
      string now = null;
      if (Native.GetUserPreferredUILanguages(8 /* MUI_LANGUAGE_NAME */, out count, null, ref len) && len > 0) {
        char[] buf = new char[len];
        if (Native.GetUserPreferredUILanguages(8, out count, buf, ref len)) {
          string all = new string(buf);
          int z = all.IndexOf('\0');
          now = z > 0 ? all.Substring(0, z) : null;
        }
      }
      string w1, w2;
      List<string> overrideList = Multi("HKCU", @"Control Panel\Desktop", "PreferredUILanguages", out w1);
      List<string> pending = Multi("HKCU", @"Control Panel\Desktop", "PreferredUILanguagesPending", out w2);
      var installed = new List<object>();
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\MUI\UILanguages", false)) {
          if (k != null) foreach (string n in k.GetSubKeyNames()) installed.Add(Json.Obj("tag", n, "name", Display(n) ?? n));
        }
      } catch (Exception) { }

      // --- typing
      var typing = new List<object>();
      for (int i = 0; i < Typing.GetLength(0); i++) {
        string tw;
        long? v = SysCommon.ReadNumber("HKCU", Typing[i, 1], Typing[i, 2], out tw);
        bool dflt = Typing[i, 3] == "1";
        typing.Add(Json.Obj("key", Typing[i, 0], "label", Typing[i, 4], "on", v == null ? dflt : v.Value != 0, "set", v != null,
                            "registry", @"HKCU\" + Typing[i, 1] + "\\" + Typing[i, 2],
                            "info", v == null ? "Not set on this PC, so Windows' default (" + (dflt ? "on" : "off") + ") applies" : null));
      }

      // --- advanced keyboard settings
      string ow;
      string over = SysCommon.Read("HKCU", ProfileKey, "InputMethodOverride", out ow) as string;
      int perApp = 0;
      bool perAppOk = Native.SystemParametersInfoW(0x104E /* SPI_GETTHREADLOCALINPUTSETTINGS */, 0, ref perApp, 0);
      string lw;
      long? bar = SysCommon.ReadNumber("HKCU", @"Software\Microsoft\CTF\LangBar", "ShowStatus", out lw);
      string barText = bar == null ? "not set (Windows' default: the input indicator, no floating bar)" : bar == 0 ? "floating on the desktop" : bar == 3 ? "hidden" : bar == 4 ? "docked in the taskbar" : "state " + bar;
      IDictionary keyboard = Json.Obj(
        "defaultInput", Json.Obj("value", over, "name", over == null ? null : KeyboardName(over),
          "text", over == null ? "Use language list (recommended)" : KeyboardName(over), "registry", @"HKCU\" + ProfileKey + @"\InputMethodOverride",
          "reason", "Windows sets this through its language profile API (bcp47langs SetInputMethodOverride), which Mantle has not wired yet, so it is shown here but not changed"),
        "perAppInput", Json.Obj("on", perAppOk ? (object)(perApp != 0) : null, "api", "SPI_GETTHREADLOCALINPUTSETTINGS",
          "reason", perAppOk ? null : "Windows did not answer the read (error " + Marshal.GetLastWin32Error() + ")"),
        "languageBar", Json.Obj("value", bar, "text", barText, "registry", @"HKCU\Software\Microsoft\CTF\LangBar\ShowStatus",
          "reason", "the language bar belongs to Windows' text input framework (CTF), which applies it itself; Mantle shows it but does not change it"));

      // --- speech
      string dw;
      string defVoice = SysCommon.Read("HKCU", @"Software\Microsoft\Speech_OneCore\Voices", "DefaultTokenId", out dw) as string;
      var voices = new List<object>();
      Tokens(@"SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens", "Windows (OneCore)", defVoice, voices);
      Tokens(@"SOFTWARE\Microsoft\Speech\Voices\Tokens", "Desktop apps (SAPI 5)", null, voices);
      var recognizers = new List<object>();
      Tokens(@"SOFTWARE\Microsoft\Speech_OneCore\Recognizers\Tokens", "Windows (OneCore)", null, recognizers);
      Tokens(@"SOFTWARE\Microsoft\Speech\Recognizers\Tokens", "Desktop apps (SAPI 5)", null, recognizers);

      result = Json.Obj("ok", true,
        "display", Json.Obj("now", now, "name", now == null ? null : Display(now), "override", overrideList.Count > 0 ? overrideList[0] : null,
          "pending", pending.Count > 0 ? pending[0] : null, "installed", installed,
          "reason", "Windows switches the display language only at the next sign-in, through its own language profile API; Mantle shows it but does not change it yet"),
        "languages", langs,
        "languagesReason", tags.Count == 0 ? "the preferred languages list could not be read (" + why + ")" : null,
        "addReason", "adding a language downloads its language pack from Microsoft (Windows' Language features, administrator), so Mantle does not add or remove languages",
        "orderReason", "Windows keeps this list through its language profile API (winlangdb SetUserLanguages), which Mantle has not wired yet, so the order is shown but not changed",
        "typing", typing, "keyboard", keyboard,
        "speech", Json.Obj("voices", voices, "recognizers", recognizers,
          "defaultVoice", defVoice == null ? null : defVoice.Substring(defVoice.LastIndexOf('\\') + 1),
          "reason", "voices and speech recognizers are installed with Windows' speech language features (a download from Microsoft), so Mantle lists them but does not add or remove them"));
      return null;
    }

    static void Tokens(string key, string source, string defaultPath, List<object> into) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(key, false)) {
          if (k == null) return;
          foreach (string n in k.GetSubKeyNames()) {
            using (RegistryKey t = k.OpenSubKey(n, false)) {
              if (t == null) continue;
              string name = t.GetValue("") as string ?? n;
              string lang = null, gender = null;
              using (RegistryKey at = t.OpenSubKey("Attributes", false)) {
                if (at != null) { lang = at.GetValue("Language") as string; gender = at.GetValue("Gender") as string; }
              }
              string tag = null;
              if (lang != null) {
                int lcid;
                string first = lang.Split(';')[0];
                if (int.TryParse(first, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out lcid)) {
                  try { tag = new CultureInfo(lcid).Name; } catch (Exception) { tag = null; }
                }
              }
              into.Add(Json.Obj("token", n, "name", name, "language", tag, "languageName", tag == null ? null : Display(tag), "gender", gender,
                                "source", source, "isDefault", defaultPath != null && defaultPath.EndsWith("\\" + n, StringComparison.OrdinalIgnoreCase)));
            }
          }
        }
      } catch (Exception) { }
    }

    static string SetTyping(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      int i = -1;
      for (int j = 0; j < Typing.GetLength(0); j++) if (Typing[j, 0] == key) i = j;
      if (i < 0) return "syslang.setTyping: unknown key \"" + (key ?? "") + "\"";
      bool on;
      string bad = SysCommon.Bool(req, "value", "syslang.setTyping", out on);
      if (bad != null) return bad;
      string why;
      long? before = SysCommon.ReadNumber("HKCU", Typing[i, 1], Typing[i, 2], out why);
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", Typing[i, 1], Typing[i, 2], on ? 1 : 0, false, before));
      string would = "turn \"" + Typing[i, 4] + "\" " + (on ? "on" : "off");
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, false);
        r["would"] = would;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      string err = SysCommon.WriteNumber("HKCU", Typing[i, 1], Typing[i, 2], on ? 1 : 0, false);
      if (err != null) return "syslang.setTyping: " + err;
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "now", on, "reason", null);
      return null;
    }

    static string SetPerAppInput(Dictionary<string, object> req, ref object result) {
      bool on;
      string bad = SysCommon.Bool(req, "on", "syslang.setPerAppInput", out on);
      if (bad != null) return bad;
      int before = 0;
      if (!Native.SystemParametersInfoW(0x104E, 0, ref before, 0)) return "syslang.setPerAppInput: the current value could not be read (error " + Marshal.GetLastWin32Error() + ")";
      var writes = SysCommon.List(Json.Obj("api", "SystemParametersInfo", "action", "SPI_SETTHREADLOCALINPUTSETTINGS (0x104F)", "value", on, "before", before != 0,
                                           "flags", "SPIF_UPDATEINIFILE | SPIF_SENDCHANGE"));
      string would = "turn " + (on ? "on" : "off") + " a different input method for each app window";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before != 0, null, false);
        r["would"] = would;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      if (!Native.SystemParametersInfoW(0x104F, 0, new IntPtr(on ? 1 : 0), 0x03))
        return "syslang.setPerAppInput: Windows refused the change (error " + Marshal.GetLastWin32Error() + ")";
      int back = 0;
      Native.SystemParametersInfoW(0x104E, 0, ref back, 0);
      result = Json.Obj("ok", true, "dryRun", false, "now", back != 0, "reason", (back != 0) == on ? null : "Windows took the change but reads back " + (back != 0 ? "on" : "off"));
      return null;
    }
  }
}
