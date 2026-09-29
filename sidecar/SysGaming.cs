// SysGaming.cs - Settings > Gaming for Mantle Settings (lane gameupd, 2026-09-29): Xbox Game Bar,
// Captures and Windows' own Game Mode.
//
// WHY: Mantle Settings replaces Windows Settings (ui/settings/SECTIONS.md). Every switch on Windows'
// three Gaming pages is a per-user value Windows' own Settings writes (HKCU, no administrator):
//   HKCU\Software\Microsoft\GameBar                         UseNexusForGameBarEnabled (controller
//                                                           button), AutoGameModeEnabled (Game Mode)
//   HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR  the capture options (the same names as
//                                                           Windows.Media.Capture.AppCaptureSettings)
// A policy (HKLM\SOFTWARE\Policies\Microsoft\Windows\GameDVR AllowGameDVR = 0) LOCKS every capture
// row: read-only, with the policy named. The captures folder is READ-ONLY with its reason (Windows
// keeps captures in the Videos folder's Captures folder and has no setting that moves only them).
//
// BACKGROUND RECORDING COSTS FRAMES: while it is on, the GPU encodes the last seconds of every game
// all the time. Owen's laptop (i3-1215U, integrated graphics) feels that, so the reads carry it and
// the page says it. A test never switches it on: every test write is dryRun (and a passive sidecar
// refuses a real write).
//
//   gaming.get                        every value below: {key: {on|value, set, locked, why}} + the
//                                     Game Bar package, the captures folder, the policy
//   gaming.set {key, value, dryRun?}  ONE switch (bool) or choice (string). dryRun validates, reads
//                                     and says what it would write.
//
// PRIVACY: nothing here logs. The captures folder path reaches the page only in the result.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysGaming {
    public static void Register(FeatureTable t) {
      t.Add("gaming.get", Lanes.Slow, Get);
      t.Add("gaming.set", Lanes.Slow, Set);
    }

    const string GB = @"Software\Microsoft\GameBar";
    const string DVR = @"Software\Microsoft\Windows\CurrentVersion\GameDVR";
    const string POL = @"SOFTWARE\Policies\Microsoft\Windows\GameDVR";
    public const string FpsCost = "background recording keeps the graphics chip encoding the last seconds of every game, which costs frames on this PC's integrated graphics";

    // A switch: one DWORD, On/Off values, what Windows does while nothing is stored, and whether
    // the capture policy locks it.
    sealed class Sw { public string Key, Words, Path, Name; public long On, Off; public bool Dflt, Capture; }
    static Sw S(string key, string words, string path, string name, bool dflt, bool capture) {
      var s = new Sw(); s.Key = key; s.Words = words; s.Path = path; s.Name = name; s.On = 1; s.Off = 0; s.Dflt = dflt; s.Capture = capture; return s;
    }
    static readonly Sw[] SWITCHES = new[] {
      S("controller", "open Game Bar with the Xbox button on a controller", GB, "UseNexusForGameBarEnabled", true, false),
      S("gameMode", "Windows Game Mode", GB, "AutoGameModeEnabled", true, false),
      S("background", "background recording (record what happened)", DVR, "HistoricalCaptureEnabled", false, true),
      S("battery", "background recording while on battery", DVR, "HistoricalCaptureOnBatteryAllowed", true, true),
      S("wireless", "background recording while projecting wirelessly", DVR, "HistoricalCaptureOnWirelessDisplayAllowed", true, true),
      S("audio", "capture audio when recording a game", DVR, "AudioCaptureEnabled", true, true),
      S("mic", "turn the microphone on by default when recording", DVR, "MicrophoneCaptureEnabled", false, true),
      S("cursor", "capture the mouse cursor when recording a game", DVR, "CursorCaptureEnabled", true, true),
    };
    static Sw FindSw(string key) { foreach (Sw s in SWITCHES) if (s.Key == key) return s; return null; }

    // A choice: page value <-> stored number. Qword = a REG_QWORD (MaximumRecordLength, 100 ns ticks).
    // Unit = also write HistoricalBufferLengthUnit = 1 (seconds) with it.
    sealed class Ch { public string Key, Words, Name, Dflt; public string[] Vals, Labels; public long[] Raw; public bool Qword, Unit; }
    static Ch C(string key, string words, string name, string dflt, string[] vals, string[] labels, long[] raw) {
      var c = new Ch(); c.Key = key; c.Words = words; c.Name = name; c.Dflt = dflt; c.Vals = vals; c.Labels = labels; c.Raw = raw; return c;
    }
    const long MIN = 600000000L;   // one minute in 100 ns ticks
    static readonly Ch[] CHOICES = BuildChoices();
    static Ch[] BuildChoices() {
      var l = new List<Ch>();
      l.Add(C("frameRate", "video frame rate", "VideoEncodingFrameRateMode", "30", new[] { "30", "60" }, new[] { "30 fps", "60 fps" }, new long[] { 0, 1 }));
      l.Add(C("quality", "video quality", "VideoEncodingBitrateMode", "standard", new[] { "standard", "high" }, new[] { "Standard", "High" }, new long[] { 2, 1 }));
      l.Add(C("audioQuality", "audio quality", "AudioEncodingBitrate", "128", new[] { "128", "192" }, new[] { "128 kbps", "192 kbps" }, new long[] { 128000, 192000 }));
      var b = C("buffer", "how much background recording keeps (record the last)", "HistoricalBufferLength", "30",
                new[] { "15", "30", "60", "180", "300", "600" }, new[] { "15 seconds", "30 seconds", "1 minute", "3 minutes", "5 minutes", "10 minutes" }, new long[] { 15, 30, 60, 180, 300, 600 });
      b.Unit = true; l.Add(b);
      var m = C("maxLength", "the longest recording", "MaximumRecordLength", "120", new[] { "30", "60", "120", "240" },
                new[] { "30 minutes", "1 hour", "2 hours", "4 hours" }, new long[] { 30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN });
      m.Qword = true; l.Add(m);
      return l.ToArray();
    }
    static Ch FindCh(string key) { foreach (Ch c in CHOICES) if (c.Key == key) return c; return null; }

    // ------------------------------------------------------------------ reads

    static string PolicyLock() {
      string w;
      long? v = SysCommon.ReadNumber("HKLM", POL, "AllowGameDVR", out w);
      if (v == null || v.Value != 0) return null;
      return "a policy on this PC turns Game Bar captures off (GameDVR AllowGameDVR = 0)";
    }

    static IDictionary ReadSw(Sw s, string lk) {
      string why;
      long? v = SysCommon.ReadNumber("HKCU", s.Path, s.Name, out why);
      bool on = v == null ? s.Dflt : v.Value == s.On;
      string locked = s.Capture ? lk : null;
      if (locked != null) on = false;
      return Json.Obj("on", on, "set", v != null, "locked", locked, "why", v == null ? why : null);
    }

    static long? ReadRaw(Ch c, out string why) {
      if (!c.Qword) return SysCommon.ReadNumber("HKCU", DVR, c.Name, out why);
      object o = SysCommon.Read("HKCU", DVR, c.Name, out why);
      if (o == null) return null;
      if (o is long) return (long)o;
      if (o is int) return (long)(int)o;
      why = "not a number (" + o.GetType().Name + ")";
      return null;
    }

    static IDictionary ReadCh(Ch c, string lk) {
      string why;
      long? raw = ReadRaw(c, out why);
      string val = raw == null ? c.Dflt : null;
      if (raw != null) for (int i = 0; i < c.Raw.Length; i++) if (c.Raw[i] == raw.Value) val = c.Vals[i];
      if (c.Unit && raw != null) {
        string w2;
        long? unit = SysCommon.ReadNumber("HKCU", DVR, "HistoricalBufferLengthUnit", out w2);
        if (unit != null && unit.Value != 1) val = null;   // 0 = megabytes: not one of Windows' choices
      }
      var opts = new List<object>();
      for (int i = 0; i < c.Vals.Length; i++) opts.Add(Json.Obj("value", c.Vals[i], "label", c.Labels[i]));
      return Json.Obj("value", val ?? "custom", "raw", raw, "set", raw != null, "options", opts, "locked", lk,
                      "why", raw == null ? why : val == null ? "another program stored a value that is not one of Windows' choices" : null);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);
    static readonly Guid FOLDERID_Videos = new Guid("18989B1D-99B5-455B-841C-AB7C74E4DDFC");

    static IDictionary ReadFolder() {
      IntPtr p;
      int hr = SHGetKnownFolderPath(FOLDERID_Videos, 0, IntPtr.Zero, out p);
      if (hr != 0) return Json.Obj("path", null, "exists", false, "why", "Windows did not say where the Videos folder is (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")");
      string videos;
      try { videos = Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
      string dir = Path.Combine(videos, "Captures");
      bool exists = false; int files = 0; string why = null;
      try {
        exists = Directory.Exists(dir);
        if (exists) files = Directory.GetFiles(dir).Length;
        else why = "the folder is made the first time something is captured";
      } catch (Exception ex) { why = "it could not be read: " + SysCommon.Why(ex); }
      return Json.Obj("path", dir, "exists", exists, "files", files, "why", why);
    }

    static bool GameBarInstalled() {
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages", false)) {
          if (k == null) return false;
          foreach (string n in k.GetSubKeyNames()) if (n.StartsWith("Microsoft.XboxGamingOverlay_", StringComparison.OrdinalIgnoreCase)) return true;
        }
      } catch (Exception) { }
      return false;
    }

    static IDictionary Values() {
      string lk = PolicyLock();
      var vals = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (Sw s in SWITCHES) vals[s.Key] = ReadSw(s, lk);
      foreach (Ch c in CHOICES) vals[c.Key] = ReadCh(c, lk);
      return vals;
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      string w1, w2;
      long? app = SysCommon.ReadNumber("HKCU", DVR, "AppCaptureEnabled", out w1);
      long? dvr = SysCommon.ReadNumber("HKCU", @"System\GameConfigStore", "GameDVR_Enabled", out w2);
      bool capOff = app == 0 || dvr == 0;
      result = Json.Obj("ok", true, "values", Values(), "policy", PolicyLock(), "gameBar", GameBarInstalled(),
                        "capturesOff", capOff ? "Game Bar captures are switched off for this account (" + (app == 0 ? "GameDVR AppCaptureEnabled" : "GameConfigStore GameDVR_Enabled") + " = 0)" : null,
                        "folder", ReadFolder(), "fpsCost", FpsCost, "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ writes

    static string Set(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return "gaming.set needs key (e.g. \"gameMode\")";
      object raw;
      if (!Json.TryGet(req, "value", out raw)) return "gaming.set needs value";
      bool dry = Json.GetBool(req, "dryRun", false);
      if (key == "folder") return "Read only: Windows keeps captures in the Captures folder inside your Videos folder, and it moves only when the Videos folder moves";
      string lk = PolicyLock();
      Sw s = FindSw(key);
      if (s != null) return SetSw(s, raw, dry, lk, ref result);
      Ch c = FindCh(key);
      if (c != null) return SetCh(c, raw, dry, lk, ref result);
      return "gaming.set: unknown key \"" + key + "\"";
    }

    static string SetSw(Sw s, object raw, bool dry, string lk, ref object result) {
      if (!(raw is bool)) return s.Key + " must be true or false";
      bool on = (bool)raw;
      if (s.Capture && lk != null) return "Read only: " + lk + ", so Windows ignores any other choice";
      bool before = (bool)ReadSw(s, lk)["on"];
      string w;
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", s.Path, s.Name, on ? s.On : s.Off, false, SysCommon.ReadNumber("HKCU", s.Path, s.Name, out w)));
      string would = "turn " + s.Words + " " + (on ? "on" : "off") + " (" + s.Name + " = " + (on ? s.On : s.Off) + " in your profile)";
      if (s.Key == "background" && on) would += "; " + FpsCost;
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "key", s.Key, "from", before, "to", on, "would", would, "writes", writes, "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": gaming.set would " + would;
      string err = SysCommon.WriteNumber("HKCU", s.Path, s.Name, on ? s.On : s.Off, false);
      if (err != null) return "gaming.set " + s.Key + ": " + err;
      result = Json.Obj("ok", true, "dryRun", false, "key", s.Key, "from", before, "to", on, "now", ReadSw(s, lk)["on"]);
      return null;
    }

    static string SetCh(Ch c, object raw, bool dry, string lk, ref object result) {
      string v = raw as string;
      int at = v == null ? -1 : Array.IndexOf(c.Vals, v);
      if (at < 0) return c.Key + " must be one of \"" + string.Join("\", \"", c.Vals) + "\"";
      if (lk != null) return "Read only: " + lk + ", so Windows ignores any other choice";
      IDictionary cur = ReadCh(c, lk);
      string before = (string)cur["value"];
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", DVR, c.Name, c.Raw[at], false, cur["raw"]));
      if (c.Qword) ((IDictionary)writes[0])["type"] = "REG_QWORD";
      if (c.Unit) {
        string w;
        writes.Add(SysCommon.RegWrite("HKCU", DVR, "HistoricalBufferLengthUnit", 1, false, SysCommon.ReadNumber("HKCU", DVR, "HistoricalBufferLengthUnit", out w)));
      }
      string would = "set " + c.Words + " from " + before + " to " + c.Labels[at] + " (" + c.Name + " = " + c.Raw[at] + (c.Unit ? ", HistoricalBufferLengthUnit = 1 (seconds)" : "") + " in your profile)";
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "key", c.Key, "from", before, "to", v, "would", would, "writes", writes, "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": gaming.set would " + would;
      string err = c.Qword ? WriteQword(DVR, c.Name, c.Raw[at]) : SysCommon.WriteNumber("HKCU", DVR, c.Name, c.Raw[at], false);
      if (err == null && c.Unit) err = SysCommon.WriteNumber("HKCU", DVR, "HistoricalBufferLengthUnit", 1, false);
      if (err != null) return "gaming.set " + c.Key + ": " + err;
      result = Json.Obj("ok", true, "dryRun", false, "key", c.Key, "from", before, "to", v, "now", ReadCh(c, lk)["value"]);
      return null;
    }

    /// One REG_QWORD in HKCU, read back (SysCommon.WriteNumber writes DWORDs only).
    static string WriteQword(string key, string name, long value) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.CreateSubKey(key, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the settings key could not be opened for writing";
          k.SetValue(name, value, RegistryValueKind.QWord);
        }
      } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
      string why;
      object back = SysCommon.Read("HKCU", key, name, out why);
      if (!(back is long) || (long)back != value) return "the value was written but reads back differently (" + (why ?? "another program may have put it back") + ")";
      return null;
    }
  }
}
