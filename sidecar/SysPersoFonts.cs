// SysPersoFonts.cs - Settings > Personalization > Fonts for Mantle Settings (lane perso, 2026-09-29).
//
// WHY: Windows' Fonts page lists every installed font family and lets you add and remove fonts. The
// list is the two registries Windows itself keeps: HKLM ...\Windows NT\CurrentVersion\Fonts (fonts for
// everyone, files in C:\Windows\Fonts) and the same key under HKCU (fonts for you only, files in
// %LOCALAPPDATA%\Microsoft\Windows\Fonts). Families come from GDI+ (InstalledFontCollection), and each
// registry face is filed under the longest family name it starts with.
//   - Fonts for YOU are added and removed here without an administrator: the file is copied to (or
//     deleted from) your fonts folder, the HKCU value written (or removed), GDI told
//     (AddFontResource / RemoveFontResource) and every window told with WM_FONTCHANGE.
//   - Fonts for EVERYONE are READ-ONLY here with the reason: adding or removing one writes
//     C:\Windows\Fonts and HKLM, which needs an administrator, and a missing system font can break
//     Windows' own text, so Mantle does not offer it.
//
//   perso.fonts                          {families:[{name, faces:[{face, file, scope}], scope}], counts}
//   perso.fontInstall {path, dryRun?}    install one .ttf / .otf / .ttc for you
//   perso.fontRemove {face, dryRun?}     remove one of YOUR fonts (face = its registry value name)
//
// PRIVACY: nothing here logs; file names reach the page only in replies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysPersoFonts {
    public static void Register(FeatureTable t) {
      t.Add("perso.fonts", Lanes.Slow, Fonts);
      t.Add("perso.fontInstall", Lanes.Slow, Install);
      t.Add("perso.fontRemove", Lanes.Slow, Remove);
    }

    const string FontsKey = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
    public const string SystemWhy = "fonts for everyone live in C:\\Windows\\Fonts and the machine's registry, which need an administrator, and removing one can break Windows' own text, so Mantle shows them read-only";
    static readonly string[] Ext = { ".ttf", ".otf", ".ttc" };

    static string UserDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Fonts"); }
    static string SysDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts"); }

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceW(string file);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceW(string file);

    /// "Arial Bold (TrueType)" -> "Arial Bold".
    static string Strip(string face) {
      int p = face.LastIndexOf(" (", StringComparison.Ordinal);
      return p > 0 && face.EndsWith(")") ? face.Substring(0, p) : face;
    }

    sealed class Face { public string Value, File, Scope, Name; }
    static List<Face> ReadFaces(string hive, out string why) {
      why = null;
      var l = new List<Face>();
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = b.OpenSubKey(FontsKey, false)) {
          if (k == null) return l;
          foreach (string n in k.GetValueNames()) {
            string f = k.GetValue(n, null) as string;
            if (f == null) continue;
            var x = new Face(); x.Value = n; x.Scope = hive == "HKLM" ? "system" : "user"; x.Name = Strip(n);
            x.File = Path.IsPathRooted(f) ? f : Path.Combine(hive == "HKLM" ? SysDir() : UserDir(), f);
            l.Add(x);
          }
        }
      } catch (Exception ex) { why = "the " + (hive == "HKLM" ? "system" : "your") + " font list could not be read: " + SysCommon.Why(ex); }
      return l;
    }

    static string Fonts(Dictionary<string, object> req, ref object result) {
      string w1, w2;
      List<Face> faces = ReadFaces("HKLM", out w1);
      faces.AddRange(ReadFaces("HKCU", out w2));
      var fams = new List<string>();
      string famWhy = null;
      try { using (var c = new InstalledFontCollection()) foreach (FontFamily f in c.Families) fams.Add(f.Name); }
      catch (Exception ex) { famWhy = "the family names could not be read: " + SysCommon.Why(ex); }
      fams.Sort((a, b) => b.Length.CompareTo(a.Length));   // longest first: "Segoe UI Black" before "Segoe UI"
      var by = new SortedDictionary<string, List<Face>>(StringComparer.OrdinalIgnoreCase);
      foreach (Face f in faces) {
        string fam = null;
        foreach (string part in f.Name.Split(new[] { " & " }, StringSplitOptions.RemoveEmptyEntries)) {
          foreach (string n in fams) if (part.StartsWith(n, StringComparison.OrdinalIgnoreCase) && (part.Length == n.Length || part[n.Length] == ' ')) { fam = n; break; }
          if (fam != null) break;
        }
        if (fam == null) fam = f.Name;
        List<Face> l;
        if (!by.TryGetValue(fam, out l)) by[fam] = l = new List<Face>();
        l.Add(f);
      }
      var list = new List<object>();
      int user = 0;
      foreach (KeyValuePair<string, List<Face>> kv in by) {
        var fl = new List<object>();
        bool anyUser = false, anySys = false;
        foreach (Face f in kv.Value) {
          fl.Add(Json.Obj("face", f.Value, "name", f.Name, "file", f.File, "scope", f.Scope, "type", Path.GetExtension(f.File).TrimStart('.').ToUpperInvariant()));
          if (f.Scope == "user") { anyUser = true; user++; } else anySys = true;
        }
        list.Add(Json.Obj("name", kv.Key, "faces", fl, "scope", anyUser && anySys ? "both" : anyUser ? "user" : "system"));
      }
      result = Json.Obj("ok", true, "families", list, "faces", (long)faces.Count, "userFaces", (long)user,
                        "why", w1 ?? w2 ?? famWhy, "systemWhy", SystemWhy, "userDir", UserDir());
      return null;
    }

    static string Install(Dictionary<string, object> req, ref object result) {
      string p = Json.GetString(req, "path");
      bool dry = Json.GetBool(req, "dryRun", false);
      if (string.IsNullOrEmpty(p) || !Path.IsPathRooted(p)) return "perso.fontInstall needs path: the full path to a .ttf, .otf or .ttc file";
      string ext = Path.GetExtension(p).ToLowerInvariant();
      if (Array.IndexOf(Ext, ext) < 0) return "only TrueType and OpenType font files (.ttf, .otf, .ttc) can be installed";
      if (!File.Exists(p)) return "that font file does not exist (or Mantle may not read it)";
      string family;
      try {
        using (var c = new PrivateFontCollection()) {
          c.AddFontFile(p);
          if (c.Families.Length == 0) return "that file holds no font Windows can read";
          family = c.Families[0].Name;
        }
      } catch (Exception ex) { return "that file is not a font Windows can read (" + SysCommon.Why(ex) + ")"; }
      string dir = UserDir(), target = Path.Combine(dir, Path.GetFileName(p));
      string value = family + (ext == ".otf" ? " (OpenType)" : " (TrueType)");
      string w;
      if (SysCommon.Read("HKCU", FontsKey, value, out w) != null) return "\"" + family + "\" is already installed for you";
      if (File.Exists(target) && !string.Equals(Path.GetFullPath(target), Path.GetFullPath(p), StringComparison.OrdinalIgnoreCase))
        return "a font file with that name is already in your fonts folder";
      string would = "install the font \"" + family + "\" for you (copy it to your fonts folder, add it to your font list, then tell open apps)";
      var writes = SysCommon.List(Json.Obj("api", "copy", "to", target),
                                  Json.Obj("api", "registry", "hive", "HKCU", "key", FontsKey, "name", value, "type", "REG_SZ", "value", target),
                                  Json.Obj("api", "AddFontResource + WM_FONTCHANGE"));
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "family", family, "would", would, "writes", writes, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      try {
        Directory.CreateDirectory(dir);
        if (!File.Exists(target)) File.Copy(p, target);
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.CreateSubKey(FontsKey, RegistryKeyPermissionCheck.ReadWriteSubTree)) k.SetValue(value, target, RegistryValueKind.String);
      } catch (Exception ex) { return "Windows refused the install (" + SysCommon.Why(ex) + ")"; }
      int n = AddFontResourceW(target);
      FontChanged();
      result = Json.Obj("ok", true, "dryRun", false, "family", family, "face", value, "now", true,
                        "note", n > 0 ? "\"" + family + "\" is installed for you" : "\"" + family + "\" is installed for you; apps see it after they restart (Windows did not load it at once)");
      return null;
    }

    static string Remove(Dictionary<string, object> req, ref object result) {
      string face = Json.GetString(req, "face");
      bool dry = Json.GetBool(req, "dryRun", false);
      if (string.IsNullOrEmpty(face)) return "perso.fontRemove needs face (the font's name in your font list)";
      string w;
      string file = SysCommon.Read("HKCU", FontsKey, face, out w) as string;
      if (file == null) {
        if (SysCommon.Read("HKLM", FontsKey, face, out w) != null) return "Read only: " + SystemWhy;
        return "there is no font called \"" + face + "\" installed for you";
      }
      if (!Path.IsPathRooted(file)) file = Path.Combine(UserDir(), file);
      bool inUserDir = file.StartsWith(UserDir() + "\\", StringComparison.OrdinalIgnoreCase);
      string would = "remove the font \"" + Strip(face) + "\" you installed (from your font list" + (inUserDir ? " and your fonts folder" : "") + ", then tell open apps)";
      var writes = SysCommon.List(Json.Obj("api", "RemoveFontResource + WM_FONTCHANGE"),
                                  Json.Obj("api", "registry", "hive", "HKCU", "key", FontsKey, "name", face, "delete", true),
                                  inUserDir ? Json.Obj("api", "delete", "file", file) : null);
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "face", face, "would", would, "writes", writes, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      RemoveFontResourceW(file);
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(FontsKey, true)) { if (k != null) k.DeleteValue(face, false); }
      } catch (Exception ex) { return "Windows refused to remove it from your font list (" + SysCommon.Why(ex) + ")"; }
      FontChanged();
      string note = "\"" + Strip(face) + "\" is removed";
      if (inUserDir) {
        try { File.Delete(file); }
        catch (Exception ex) { note += "; its file is still in your fonts folder because an app has it open (" + SysCommon.Why(ex) + "): it goes after a restart or when that app closes"; }
      }
      result = Json.Obj("ok", true, "dryRun", false, "face", face, "now", false, "note", note);
      return null;
    }

    static void FontChanged() {
      IntPtr res;
      SendMessageTimeoutW(new IntPtr(0xFFFF), 0x001D /* WM_FONTCHANGE */, IntPtr.Zero, IntPtr.Zero, 0x0002, 1000, out res);
    }
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr res);
  }
}
