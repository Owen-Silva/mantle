// SysStorage.cs - Mantle Settings > System > Storage, the sidecar half (lane storage, 2026-09-29).
// The page is ui/settings/sections/system.js (renderStorage); the main half is
// lib/features/_settings-sections/system.js. The walker, the guard and the one delete live in
// SysStorageFiles.cs.
//
// WHAT (everything Windows' Storage page does, natively):
//   sysstorage.get        drives (used / free), Storage Sense's settings, the scan's state          (Slow)
//   sysstorage.advanced   disks & volumes and storage pools (WMI, root\Microsoft\Windows\Storage),
//                         where new content is saved, backup state                                  (Slow)
//   sysstorage.scan       {drive?} starts the category scan on its OWN thread and returns at once;
//                         events {ev:'sysstorage', what:'progress'|'done'|'cancelled'|'failed', scan,
//                         done, total, bytes, files, category} - counts and bytes, never a name     (Slow)
//   sysstorage.scanStop   cancels a running scan                                                    (Ui)
//   sysstorage.recommend  large or unused files the last scan saw in the user's own folders (read only) (Ui)
//   sysstorage.temp       the cleanup kinds' sizes                                                  (Slow, worker)
//   sysstorage.plan       {kinds[]} -> what a cleanup WOULD remove (counts, bytes) + a plan token   (Slow, worker)
//   sysstorage.cleanup    {plan, confirm:true, dryRun} carries out THAT plan, nothing more          (Slow, worker)
//   sysstorage.senseSet   {key, value, account?, dryRun} one Storage Sense setting                  (Slow)
//   sysstorage.sandboxTest  test sidecars only: runs the real delete inside the test sandbox        (Slow)
//   [Elevated] sysstorage.cleanSystem {kinds} - the administrator kinds (Windows' temp folder,
//                         Delivery Optimization files, Windows Update downloads)
//
// WHY a plan + token: the user confirms EXACTLY what he saw. The plan keeps the file list it measured; the
// cleanup deletes only those files, only if each still has the size and time the plan saw, and only
// once. Downloads and the Recycle Bin are in a plan ONLY when the request names them (the page never
// ticks them for him), Downloads goes to the Recycle Bin rather than being deleted, and a Recycle Bin
// that grew since the plan is left alone.
//
// MEASURED here (2026-09-29, one 256 GB NVMe): Storage Sense keeps its switches as DWORDs named "01",
// "04", "08", "32", "256", "512", "2048" under HKCU\...\StorageSense\Parameters\StoragePolicy and OneDrive's
// cloud content per account in a subkey "OneDrive!<sid>!Personal|<guid>" ("02" on, "128" days); the
// Delivery Optimization cache and C:\Windows\Temp refuse a non-administrator listing (5), Windows
// Update's download folder can be read but not changed; MSFT_Disk / MSFT_Partition / MSFT_Volume /
// MSFT_StoragePool answer a non-administrator in ~1 s.
//
// PRIVACY: nothing here logs. Events carry counts, bytes and category keys only; file names and
// folders travel only in replies (the page shows them to the user).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysStorage {
    const string SenseKey = @"Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy";
    const string PolicyKey = @"SOFTWARE\Policies\Microsoft\Windows\StorageSense";
    const int PlanSec = 900;
    const long BigMin = 20L << 20, LargeMin = 100L << 20;
    static readonly long[] Cadences = { 1, 7, 30, 0 };
    static readonly long[] Ages = { 0, 1, 14, 30, 60 };
    static readonly string[] KINDS = { "temp", "thumbnails", "systemTemp", "deliveryOptimization", "windowsUpdate", "recycleBin", "downloads" };
    static readonly string[] CATS = { "apps", "documents", "pictures", "videos", "music", "temp", "system", "otherUsers", "other" };
    const string AdminWhy = "Windows only lets an administrator look inside this folder, so its size is not known here; the administrator cleanup measures it when it runs";
    static readonly object _gate = new object();

    public static void Register(FeatureTable t) {
      t.Add("sysstorage.get", Lanes.Slow, Get);
      t.Add("sysstorage.advanced", Lanes.Slow, Advanced);
      t.Add("sysstorage.scan", Lanes.Slow, Scan);
      t.Add("sysstorage.scanStop", Lanes.Ui, ScanStop);
      t.Add("sysstorage.recommend", Lanes.Ui, Recommend);
      t.Add("sysstorage.temp", Lanes.Slow, Temp);
      t.Add("sysstorage.plan", Lanes.Slow, Plan);
      t.Add("sysstorage.cleanup", Lanes.Slow, Cleanup);
      t.Add("sysstorage.senseSet", Lanes.Slow, SenseSet);
      t.Add("sysstorage.sandboxTest", Lanes.Slow, SandboxTest);
    }

    /// Plain words from a worker: the message IS the reply's error (never a path).
    sealed class Refusal : Exception { public Refusal(string m) : base(m) { } }

    /// Runs `work` on its own below-normal thread and answers from there (the Slow lane stays free).
    static string Later(Dictionary<string, object> req, ref object result, Func<object> work) {
      object rid = req.ContainsKey("id") ? req["id"] : null;
      var th = new Thread(delegate () {
        object res = null; string err = null;
        try { res = work(); }
        catch (Refusal r) { err = r.Message; }
        catch (Exception ex) { err = "storage: it failed (" + SysCommon.Why(ex) + ")"; }
        Program.ReplyFromWorker(rid, err == null, res, err);
      });
      th.IsBackground = true;
      th.Priority = ThreadPriority.BelowNormal;
      th.Start();
      result = Program.Deferred;
      return null;
    }

    static string Size(long b) {
      string[] u = { "bytes", "KB", "MB", "GB", "TB" };
      double v = b; int i = 0;
      while (v >= 1024 && i < u.Length - 1) { v /= 1024; i++; }
      return (i == 0 ? b.ToString(CultureInfo.InvariantCulture) : v.ToString(v >= 100 ? "0" : "0.0", CultureInfo.InvariantCulture)) + " " + u[i];
    }
    static string Plural(long n, string one) { return n.ToString("N0", CultureInfo.InvariantCulture) + " " + one + (n == 1 ? "" : "s"); }
    static string Iso(long fileTimeUtc) {
      try { return DateTime.FromFileTimeUtc(fileTimeUtc).ToString("o", CultureInfo.InvariantCulture); } catch (Exception) { return null; }
    }

    // ================================================================== drives
    static string DriveType_(DriveType t) {
      switch (t) {
        case DriveType.Fixed: return "fixed";
        case DriveType.Removable: return "removable";
        case DriveType.CDRom: return "cdrom";
        case DriveType.Ram: return "ram";
      }
      return "other";
    }

    static List<object> Drives() {
      var list = new List<object>();
      string sys = StorageFiles.SystemDrive();
      DriveInfo[] all;
      try { all = DriveInfo.GetDrives(); } catch (Exception ex) { throw new Refusal("the drives could not be listed (" + SysCommon.Why(ex) + ")"); }
      foreach (DriveInfo d in all) {
        DriveType t;
        try { t = d.DriveType; } catch (Exception) { continue; }
        if (t == DriveType.Network || t == DriveType.NoRootDirectory || t == DriveType.Unknown) continue;
        string letter = d.Name.Substring(0, 2).ToUpperInvariant();
        bool ready = false;
        try { ready = d.IsReady; } catch (Exception) { ready = false; }
        if (!ready) {
          if (t == DriveType.CDRom) continue;
          list.Add(Json.Obj("drive", letter, "type", DriveType_(t), "ready", false, "system", letter == sys,
                            "reason", "the drive is not ready (no media in it, or it is locked)"));
          continue;
        }
        string label = null, fmt = null, why = null; long total = 0, free = 0;
        try { total = d.TotalSize; free = d.TotalFreeSpace; label = d.VolumeLabel; fmt = d.DriveFormat; }
        catch (Exception ex) { why = "its size could not be read (" + SysCommon.Why(ex) + ")"; }
        list.Add(Json.Obj("drive", letter, "label", label, "type", DriveType_(t), "format", fmt, "total", total, "free", free,
                          "used", total - free, "system", letter == sys, "ready", why == null, "reason", why));
      }
      return list;
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      result = Json.Obj("drives", Drives(), "systemDrive", StorageFiles.SystemDrive(), "sense", SenseRead(),
                        "scan", ScanSnap(false), "admin", SysCommon.Elevated());
      return null;
    }

    // ================================================================== Storage Sense
    static IDictionary Setting(object value, bool set, string pol, long? polValue, object polShown, string note) {
      bool locked = polValue != null;
      return Json.Obj("value", locked ? polShown : value, "writable", !locked,
                      "why", locked ? "Read only here: a group policy on this PC sets this (" + pol + "), and Windows' own Settings cannot change it either" : null,
                      "set", set, "note", note);
    }

    static long? N(string key, string name) { string w; return SysCommon.ReadNumber("HKCU", key, name, out w); }
    static long? P(string name) { string w; return SysCommon.ReadNumber("HKLM", PolicyKey, name, out w); }

    /// Days from a switch + a days value: switch 0 = Never (0), else the days (or Windows' default).
    static long Days(long? sw, long? days, long dflt) {
      if (sw == null && days == null) return dflt;
      if (sw != null && sw.Value == 0) return 0;
      return days != null ? days.Value : dflt;
    }

    /// The OneDrive accounts Storage Sense keeps a cloud-content rule for (subkey names).
    static List<string> CloudAccounts() {
      var list = new List<string>();
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(SenseKey, false)) {
          if (k == null) return list;
          foreach (string n in k.GetSubKeyNames()) {
            if (!n.StartsWith("OneDrive!", StringComparison.Ordinal) || n.IndexOf('\\') >= 0) continue;
            using (RegistryKey s = k.OpenSubKey(n, false)) {
              if (s != null && s.GetValue("128", null) != null) list.Add(n);
            }
          }
        }
      } catch (Exception) { }
      return list;
    }

    static int OneDriveSignedIn() {
      int n = 0;
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(@"Software\Microsoft\OneDrive\Accounts", false)) {
          if (k == null) return 0;
          foreach (string s in k.GetSubKeyNames())
            using (RegistryKey a = k.OpenSubKey(s, false)) if (a != null && a.GetValue("UserFolder", null) != null) n++;
        }
      } catch (Exception) { }
      return n;
    }

    static string CloudLabel(string acct) {
      string[] p = acct.Split('!');
      string kind = p.Length >= 3 ? p[2].Split('|')[0] : "";
      if (kind == "Personal") return "OneDrive (personal)";
      if (kind.StartsWith("Business", StringComparison.Ordinal)) return "OneDrive (work or school)";
      return "OneDrive";
    }

    /// One setting's current value in the page's units (bool or days).
    static object SenseValue(string key, string acct) {
      switch (key) {
        case "on": { long? v = N(SenseKey, "01"); return v != null && v.Value == 1; }
        case "temp": { long? v = N(SenseKey, "04"); return v == null || v.Value == 1; }
        case "cadence": { long? v = N(SenseKey, "2048"); return v != null ? v.Value : 0; }
        case "recycleDays": return Days(N(SenseKey, "08"), N(SenseKey, "256"), 30);
        case "downloadsDays": return Days(N(SenseKey, "32"), N(SenseKey, "512"), 0);
        case "cloudDays": return Days(N(SenseKey + "\\" + acct, "02"), N(SenseKey + "\\" + acct, "128"), 0);
      }
      return null;
    }

    static IDictionary SenseRead() {
      long? on = N(SenseKey, "01"), tmp = N(SenseKey, "04"), cad = N(SenseKey, "2048");
      long? pOn = P("AllowStorageSenseGlobal"), pTmp = P("AllowStorageSenseTemporaryFilesCleanup"), pCad = P("ConfigStorageSenseGlobalCadence");
      long? pRb = P("ConfigStorageSenseRecycleBinCleanupThreshold"), pDl = P("ConfigStorageSenseDownloadsCleanupThreshold"), pCl = P("ConfigStorageSenseCloudContentDehydrationThreshold");
      bool rbSet = N(SenseKey, "08") != null || N(SenseKey, "256") != null, dlSet = N(SenseKey, "32") != null || N(SenseKey, "512") != null;
      var cloud = new List<object>();
      foreach (string a in CloudAccounts()) {
        IDictionary s = Setting(SenseValue("cloudDays", a), true, "ConfigStorageSenseCloudContentDehydrationThreshold", pCl, pCl, null);
        s["account"] = a; s["label"] = CloudLabel(a);
        cloud.Add(s);
      }
      int od = OneDriveSignedIn();
      return Json.Obj(
        "on", Setting(on != null && on.Value == 1, on != null, "AllowStorageSenseGlobal", pOn, pOn != null && pOn.Value == 1,
                      on == null ? "Not set yet: Windows keeps Storage Sense off until it is turned on" : null),
        "temp", Setting(tmp == null || tmp.Value == 1, tmp != null, "AllowStorageSenseTemporaryFilesCleanup", pTmp, pTmp != null && pTmp.Value == 1, null),
        "cadence", Setting(cad != null ? cad.Value : 0, cad != null, "ConfigStorageSenseGlobalCadence", pCad, pCad, null),
        "recycleDays", Setting(SenseValue("recycleDays", null), rbSet, "ConfigStorageSenseRecycleBinCleanupThreshold", pRb, pRb,
                               rbSet ? null : "Not set yet: Windows' default (30 days) applies"),
        "downloadsDays", Setting(SenseValue("downloadsDays", null), dlSet, "ConfigStorageSenseDownloadsCleanupThreshold", pDl, pDl, null),
        "cloud", cloud,
        "cloudWhy", cloud.Count == 0 ? "No OneDrive account has cloud content on this PC, so there is nothing for Storage Sense to put back online" : null,
        "cloudNote", cloud.Count > 0 && od == 0 ? "OneDrive is not signed in right now, so this rule has nothing to act on until it is" : null,
        "cadences", new List<object>(new object[] { 1L, 7L, 30L, 0L }),
        "ages", new List<object>(new object[] { 0L, 1L, 14L, 30L, 60L }));
    }

    static string SenseSet(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      bool dry = Json.GetBool(req, "dryRun", false);
      object v;
      if (!Json.TryGet(req, "value", out v)) return "sysstorage.senseSet needs value";
      string reg = SenseKey, pol, acct = null;
      var names = new List<string>(); var vals = new List<long>();
      switch (key) {
        case "on":
        case "temp":
          if (!(v is bool)) return "sysstorage.senseSet " + key + " needs value: true or false";
          names.Add(key == "on" ? "01" : "04"); vals.Add((bool)v ? 1 : 0);
          pol = key == "on" ? "AllowStorageSenseGlobal" : "AllowStorageSenseTemporaryFilesCleanup";
          break;
        case "cadence": {
          long c;
          string why = SysCommon.Number(req, "value", "sysstorage.senseSet cadence", 0, 30, out c);
          if (why != null || Array.IndexOf(Cadences, c) < 0) return "sysstorage.senseSet cadence needs value 1 (every day), 7 (every week), 30 (every month) or 0 (when free space is low)";
          names.Add("2048"); vals.Add(c); pol = "ConfigStorageSenseGlobalCadence";
          break;
        }
        case "recycleDays":
        case "downloadsDays":
        case "cloudDays": {
          long d;
          string why = SysCommon.Number(req, "value", "sysstorage.senseSet " + key, 0, 60, out d);
          if (why != null || Array.IndexOf(Ages, d) < 0) return "sysstorage.senseSet " + key + " needs value 0 (never), 1, 14, 30 or 60 days";
          if (key == "cloudDays") {
            acct = Json.GetString(req, "account");
            if (string.IsNullOrEmpty(acct) || !CloudAccounts().Contains(acct)) return "sysstorage.senseSet cloudDays needs account: one of the OneDrive accounts sysstorage.get listed";
            reg = SenseKey + "\\" + acct;
          }
          string sw = key == "recycleDays" ? "08" : key == "downloadsDays" ? "32" : "02";
          string days = key == "recycleDays" ? "256" : key == "downloadsDays" ? "512" : "128";
          names.Add(sw); vals.Add(d == 0 ? 0 : 1);
          if (d != 0) { names.Add(days); vals.Add(d); }
          pol = key == "recycleDays" ? "ConfigStorageSenseRecycleBinCleanupThreshold" : key == "downloadsDays" ? "ConfigStorageSenseDownloadsCleanupThreshold" : "ConfigStorageSenseCloudContentDehydrationThreshold";
          break;
        }
        default:
          return "sysstorage.senseSet needs key: on, temp, cadence, recycleDays, downloadsDays or cloudDays";
      }
      object before = SenseValue(key, acct);
      var writes = new List<object>();
      for (int i = 0; i < names.Count; i++) writes.Add(SysCommon.RegWrite("HKCU", reg, names[i], vals[i], false, N(reg, names[i])));
      string refuse = P(pol) != null ? "a group policy on this PC sets this (" + pol + ")" : null;
      if (dry) {
        IDictionary d = SysCommon.Dry(writes, before, refuse, false);
        d["key"] = key; d["value"] = v;
        result = d;
        return null;
      }
      if (refuse != null) return "Read only here: " + refuse;
      if (Program.Passive) return SysCommon.Passive("set Storage Sense's " + key + " to " + Convert.ToString(v, CultureInfo.InvariantCulture));
      for (int i = 0; i < names.Count; i++) {
        string err = SysCommon.WriteNumber("HKCU", reg, names[i], vals[i], false);
        if (err != null) return "Storage Sense's " + key + ": " + err;
      }
      result = Json.Obj("key", key, "value", SenseValue(key, acct), "changed", true);
      return null;
    }

    // ================================================================== cleanup kinds
    static bool AdminKind(string k) { return k == "systemTemp" || k == "deliveryOptimization" || k == "windowsUpdate"; }
    static bool YoursKind(string k) { return k == "downloads" || k == "recycleBin"; }
    static string KindAction(string k) { return k == "recycleBin" ? "empty" : k == "downloads" ? "recycle" : "delete"; }

    static string KindLabel(string k) {
      switch (k) {
        case "temp": return "Temporary files";
        case "thumbnails": return "Thumbnails";
        case "systemTemp": return "Windows temporary files";
        case "deliveryOptimization": return "Delivery Optimization files";
        case "windowsUpdate": return "Windows Update cleanup";
        case "recycleBin": return "Recycle Bin";
        case "downloads": return "Downloads";
      }
      return k;
    }

    static string KindRule(string k) {
      switch (k) {
        case "temp": return "Files in your temporary folder that nothing has changed for 7 days";
        case "thumbnails": return "Explorer's saved picture previews; Windows makes them again when it needs them";
        case "systemTemp": return "Files in Windows' own temporary folder unchanged for 7 days";
        case "deliveryOptimization": return "Update pieces Windows keeps to share with other PCs";
        case "windowsUpdate": return "Update files Windows Update downloaded more than 10 days ago";
        case "recycleBin": return "Everything in the Recycle Bin on every drive, gone for good";
        case "downloads": return "Everything in your Downloads folder, moved to the Recycle Bin";
      }
      return "";
    }

    static string KindRoot(string k) {
      string win = StorageFiles.WindowsDir();
      switch (k) {
        case "temp": return Path.GetTempPath().TrimEnd('\\');
        case "thumbnails": { string la = StorageFiles.Known(StorageFiles.LocalAppData); return la == null ? null : la + @"\Microsoft\Windows\Explorer"; }
        case "systemTemp": return win + @"\Temp";
        case "deliveryOptimization": return win + @"\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache";
        case "windowsUpdate": return win + @"\SoftwareDistribution\Download";
        case "downloads": return StorageFiles.Known(StorageFiles.Downloads);
      }
      return null;
    }

    static int KindAge(string k) { return k == "temp" || k == "systemTemp" ? 7 : k == "windowsUpdate" ? 10 : 0; }

    /// One kind, measured: what a cleanup would remove (Bytes / Files) out of what is there (All*).
    sealed class Collected {
      public string Kind, Root, Reason;
      public string Via;   // null = Mantle walked the folder; "service" = the size came from the Delivery Optimization service (no file count)
      public long Bytes, Files, AllBytes, AllFiles, Entries = -1;
      public bool Measured = true;
      public List<StorageTarget> Targets = new List<StorageTarget>();
      public IDictionary Json() {
        bool counted = Measured && Via == null;
        return Mantle.Json.Obj("kind", Kind, "label", KindLabel(Kind), "rule", KindRule(Kind), "action", KindAction(Kind),
          "bytes", Measured ? (object)Bytes : null, "files", counted ? (object)Files : null,
          "allBytes", Measured ? (object)AllBytes : null, "allFiles", counted ? (object)AllFiles : null,
          "entries", Entries >= 0 ? (object)Entries : null, "admin", AdminKind(Kind), "yours", YoursKind(Kind),
          "measured", Measured, "via", Via, "reason", Reason);
      }
    }

    static Collected Collect(string kind, bool keep) {
      var c = new Collected { Kind = kind };
      if (kind == "recycleBin") {
        long b, n; int hr;
        if (StorageFiles.RecycleBin(null, out b, out n, out hr)) { c.Bytes = c.AllBytes = b; c.Files = c.AllFiles = n; }
        else { c.Measured = false; c.Reason = "Windows did not say how full the Recycle Bin is (0x" + hr.ToString("X8") + ")"; }
        return c;
      }
      string root = KindRoot(kind);
      c.Root = root;
      if (root == null) { c.Measured = false; c.Reason = "Windows did not say where this folder is"; return c; }
      if (!StorageFiles.Exists(root)) {
        if (Marshal.GetLastWin32Error() == 5) { c.Measured = false; c.Reason = AdminWhy; if (!keep) ServiceSize(c); }
        return c;   // not there: nothing to clean
      }
      var w = new StorageWalk();
      if (kind == "downloads") {
        List<StorageTarget> top = StorageFiles.TopEntries(root, w, null);
        c.Bytes = c.AllBytes = w.Bytes; c.Files = c.AllFiles = w.Files; c.Entries = top.Count;
        if (keep) c.Targets = top;
      } else {
        int age = KindAge(kind);
        long cutoff = age > 0 ? DateTime.UtcNow.AddDays(-age).ToFileTimeUtc() : long.MaxValue;
        long bytes = 0, files = 0;
        List<StorageTarget> list = c.Targets;
        w.OnFile = delegate (string p, long size, long wr, long cr) {
          if (wr > cutoff || cr > cutoff) return;
          bytes += size; files++;
          if (keep) list.Add(new StorageTarget { Path = p, Size = size, WriteTicks = wr });
        };
        StorageFiles.Walk(root, w, kind != "thumbnails", kind == "thumbnails" ? "thumbcache_*.db" : null);
        c.AllBytes = w.Bytes; c.AllFiles = w.Files; c.Bytes = bytes; c.Files = files;
      }
      if (w.Denied > 0 && w.Dirs == 0) { c.Measured = false; c.Reason = AdminWhy; c.Targets.Clear(); }
      else if (w.Denied > 0) c.Reason = Plural(w.Denied, "folder") + " inside could not be read, so the size is a little low";
      if (!keep) ServiceSize(c);
      return c;
    }

    /// Delivery Optimization's cache sits in NETWORK SERVICE's profile, which only an administrator may
    /// list. The Delivery Optimization service publishes its own cache size to everyone: WMI
    /// root\Microsoft\Windows\DeliveryOptimization, MSFT_DOCurrentStatus.CacheSizeBytes (the source of
    /// Get-DeliveryOptimizationPerfSnap's CacheSizeBytes, DeliveryOptimizationStatus.psm1). A read only, capped
    /// at 5 s; never used for a cleanup's file list (the administrator cleanup walks the folder itself).
    static void ServiceSize(Collected c) {
      if (c.Kind != "deliveryOptimization" || c.Measured) return;
      try {
        using (var s = new ManagementObjectSearcher(@"root\Microsoft\Windows\DeliveryOptimization", "SELECT CacheSizeBytes FROM MSFT_DOCurrentStatus")) {
          s.Options.Timeout = TimeSpan.FromSeconds(5);
          foreach (ManagementBaseObject o in s.Get()) {
            object v = null;
            try { v = o["CacheSizeBytes"]; } catch (ManagementException) { }
            o.Dispose();
            if (v == null) continue;
            long b = Convert.ToInt64(v, CultureInfo.InvariantCulture);
            if (b < 0) continue;
            c.Measured = true; c.Via = "service"; c.Bytes = c.AllBytes = b; c.Files = c.AllFiles = 0; c.Reason = null;
            return;
          }
        }
        c.Reason = AdminWhy + ", and the Delivery Optimization service did not report its cache size";
      } catch (Exception ex) {
        c.Reason = AdminWhy + ", and the Delivery Optimization service did not answer (" + SysCommon.Why(ex) + ")";
      }
    }

    static string KindsArg(object o, string cmd, bool adminOnly, out List<string> kinds) {
      kinds = new List<string>();
      IList l = o as IList;
      string allowed = adminOnly ? "systemTemp, deliveryOptimization or windowsUpdate" : string.Join(", ", KINDS);
      if (l == null || l.Count < 1 || l.Count > KINDS.Length) return cmd + " needs kinds: a list of " + allowed;
      foreach (object x in l) {
        string s = x as string;
        if (s == null || Array.IndexOf(KINDS, s) < 0 || (adminOnly && !AdminKind(s))) return cmd + " kinds may only name " + allowed;
        if (kinds.Contains(s)) return cmd + " names " + s + " twice";
        kinds.Add(s);
      }
      return null;
    }

    static string Temp(Dictionary<string, object> req, ref object result) {
      return Later(req, ref result, delegate {
        var list = new List<object>();
        foreach (string k in KINDS) list.Add(Collect(k, false).Json());
        return Json.Obj("kinds", list, "admin", SysCommon.Elevated());
      });
    }

    // ================================================================== plan + cleanup
    sealed class PlanRec {
      public string Token;
      public List<string> Kinds;
      public Dictionary<string, Collected> Got = new Dictionary<string, Collected>();
      public DateTime At;
      public bool Used;
    }
    static readonly List<PlanRec> _plans = new List<PlanRec>();
    static int _planN;

    static string Plan(Dictionary<string, object> req, ref object result) {
      object o; Json.TryGet(req, "kinds", out o);
      List<string> kinds;
      string why = KindsArg(o, "sysstorage.plan", false, out kinds);
      if (why != null) return why;
      return Later(req, ref result, delegate {
        var rec = new PlanRec { Kinds = kinds, At = DateTime.UtcNow };
        var items = new List<object>();
        long tb = 0, tf = 0; bool admin = false, uncounted = false;
        foreach (string k in kinds) {
          Collected c = Collect(k, !AdminKind(k));
          rec.Got[k] = c;
          items.Add(c.Json());
          if (c.Measured) { tb += c.Bytes; tf += c.Files; if (c.Via != null) uncounted = true; }
          if (AdminKind(k)) admin = true;
        }
        lock (_gate) {
          rec.Token = "plan-" + (++_planN).ToString(CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
          _plans.Add(rec);
          while (_plans.Count > 4) _plans.RemoveAt(0);
        }
        var left = new List<object>();
        if (!kinds.Contains("downloads")) left.Add("downloads");
        if (!kinds.Contains("recycleBin")) left.Add("recycleBin");
        return Json.Obj("plan", rec.Token, "items", items, "totalBytes", tb, "totalFiles", tf, "uncounted", uncounted,
                        "needsAdmin", admin && !SysCommon.Elevated(), "expiresInSec", PlanSec, "leftAlone", left,
                        "note", "Nothing is deleted until this plan is confirmed");
      });
    }

    static string Words(string k, Collected c) {
      if (!c.Measured) return KindLabel(k) + ": what the administrator cleanup finds (" + KindRule(k).ToLowerInvariant() + ")";
      if (k == "recycleBin") return "empty the Recycle Bin (" + Plural(c.Files, "item") + ", " + Size(c.Bytes) + ")";
      if (k == "downloads") return "move " + Plural(c.Entries < 0 ? 0 : c.Entries, "item") + " from Downloads to the Recycle Bin (" + Size(c.Bytes) + ")";
      return "delete " + Plural(c.Files, "file") + " (" + Size(c.Bytes) + ") of " + KindLabel(k);
    }

    static string Cleanup(Dictionary<string, object> req, ref object result) {
      string token = Json.GetString(req, "plan");
      bool dry = Json.GetBool(req, "dryRun", false);
      object cf;
      bool confirm = Json.TryGet(req, "confirm", out cf) && cf is bool && (bool)cf;
      if (string.IsNullOrEmpty(token)) return "sysstorage.cleanup needs plan: the token sysstorage.plan answered";
      PlanRec rec;
      lock (_gate) { rec = _plans.Find(delegate (PlanRec p) { return p.Token == token; }); }
      if (rec == null) return "that cleanup plan is unknown or was replaced; review the cleanup again";
      if ((DateTime.UtcNow - rec.At).TotalSeconds > PlanSec) return "that cleanup plan is more than 15 minutes old; review the cleanup again";
      if (rec.Used) return "that cleanup plan was already carried out; review the cleanup again";
      if (!confirm) return "sysstorage.cleanup needs confirm: true - the explicit yes to the plan that was shown";
      var writes = new List<object>();
      var adminKinds = new List<object>();
      long bytes = 0, files = 0;
      foreach (string k in rec.Kinds) {
        Collected c = rec.Got[k];
        writes.Add(Json.Obj("api", "files", "kind", k, "action", KindAction(k), "files", c.Measured ? (object)c.Files : null,
                            "bytes", c.Measured ? (object)c.Bytes : null, "admin", AdminKind(k), "words", Words(k, c)));
        if (c.Measured) { bytes += c.Bytes; files += c.Files; }
        if (AdminKind(k) && !SysCommon.Elevated()) adminKinds.Add(k);
      }
      if (dry) {
        IDictionary d = SysCommon.Dry(writes, null, null, adminKinds.Count > 0);
        d["plan"] = token; d["kinds"] = new List<object>(rec.Kinds.ToArray());
        d["adminKinds"] = adminKinds; d["totalBytes"] = bytes; d["totalFiles"] = files;
        result = d;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive("removed " + Plural(files, "file") + " (" + Size(bytes) + ") in " + Plural(rec.Kinds.Count, "kind"));
      lock (_gate) {
        if (rec.Used) return "that cleanup plan was already carried out; review the cleanup again";
        rec.Used = true;
      }
      return Later(req, ref result, delegate { return RunCleanup(rec, adminKinds); });
    }

    static IDictionary RunCleanup(PlanRec rec, List<object> adminKinds) {
      var per = new List<object>();
      var all = new StorageDeleted();
      int last = Environment.TickCount;
      Action<StorageDeleted> tick = delegate (StorageDeleted d) {
        if (Environment.TickCount - last < 400) return;
        last = Environment.TickCount;
        Features.Event("sysstorage", Json.Obj("what", "cleanProgress", "removed", all.Removed + d.Removed, "freed", all.Freed + d.Freed));
      };
      // 1. the Recycle Bin first (as planned), and only if it has not grown since the plan was shown
      if (rec.Kinds.Contains("recycleBin")) {
        Collected c = rec.Got["recycleBin"];
        long b, n; int hr; string why;
        if (!c.Measured) why = "the Recycle Bin was not measured when the plan was made, so it was left alone";
        else if (!StorageFiles.RecycleBin(null, out b, out n, out hr)) why = "Windows did not say how full the Recycle Bin is, so it was left alone";
        else if (n > c.Files || b > c.Bytes) why = "the Recycle Bin holds more than when the plan was shown, so it was left alone; review the cleanup again";
        else {
          why = StorageFiles.EmptyRecycleBin();
          if (why == null) { all.Removed += (int)Math.Min(n, int.MaxValue); all.Freed += b; }
        }
        per.Add(Json.Obj("kind", "recycleBin", "removed", why == null ? c.Files : 0, "freed", why == null ? c.Bytes : 0, "reason", why));
      }
      // 2. the kinds the user's own rights cover; Downloads goes to the Recycle Bin
      foreach (string k in rec.Kinds) {
        if (k == "recycleBin" || AdminKind(k)) continue;
        Collected c = rec.Got[k];
        StorageDeleted d = StorageFiles.Delete(c.Targets, new string[] { c.Root }, k == "downloads", null, tick);
        IDictionary j = d.Json(); j["kind"] = k;
        if (d.Skipped > 0) j["reason"] = Plural(d.Skipped, "file") + " in use or refused by Windows were left where they are";
        per.Add(j);
        all.Add(d);
      }
      // 3. administrator kinds: here only when this sidecar is itself elevated, else the page asks
      if (SysCommon.Elevated()) foreach (string k in rec.Kinds) {
        if (!AdminKind(k)) continue;
        IDictionary j = CleanKind(k, all);
        per.Add(j);
      }
      return Json.Obj("kinds", per, "removed", all.Removed, "freed", all.Freed, "skipped", all.Skipped, "changed", all.Changed,
                      "refused", all.Refused, "admin", adminKinds.Count > 0
                        ? Json.Obj("elevate", "sysstorage.cleanSystem", "does", CleanDoes, "args", Json.Obj("kinds", adminKinds))
                        : null);
    }

    /// One administrator kind, measured again and removed (the elevated copy has no plan to read).
    static IDictionary CleanKind(string k, StorageDeleted all) {
      Collected c = Collect(k, true);
      if (!c.Measured) return Json.Obj("kind", k, "removed", 0, "freed", 0, "reason", c.Reason);
      StorageDeleted d = StorageFiles.Delete(c.Targets, new string[] { c.Root }, false, null, null);
      all.Add(d);
      IDictionary j = d.Json(); j["kind"] = k;
      if (d.Skipped > 0) j["reason"] = Plural(d.Skipped, "file") + " in use by Windows were left where they are";
      return j;
    }

    const string CleanDoes = "delete the Windows system files you chose to clean up";

    [Elevated("sysstorage.cleanSystem", "CheckCleanSystem", CleanDoes)]
    static string CleanSystem(Dictionary<string, object> args, ref object result) {
      if (Program.Passive) return SysCommon.Passive("deleted Windows system files");
      List<string> kinds;
      object o; args.TryGetValue("kinds", out o);
      string why = KindsArg(o, "sysstorage.cleanSystem", true, out kinds);
      if (why != null) return why;
      var per = new List<object>();
      var all = new StorageDeleted();
      foreach (string k in kinds) per.Add(CleanKind(k, all));
      result = Json.Obj("kinds", per, "removed", all.Removed, "freed", all.Freed, "skipped", all.Skipped,
                        "note", "Removed " + Plural(all.Removed, "file") + " (" + Size(all.Freed) + ")" +
                                (all.Skipped > 0 ? "; " + Plural(all.Skipped, "file") + " in use were left" : ""));
      return null;
    }

    static string CheckCleanSystem(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "kinds");
      if (why != null) return why;
      object o; args.TryGetValue("kinds", out o);
      List<string> kinds;
      return KindsArg(o, "sysstorage.cleanSystem", true, out kinds);
    }

    // ================================================================== the category scan
    sealed class Step { public string Cat, Root, Pattern; public bool Recurse = true, User; public HashSet<string> Skip; }
    sealed class Big { public string Path; public long Size, Write; public bool Large; }
    sealed class ScanRec {
      public string Token, Drive, Cat, State = "running", Reason;
      public volatile bool Cancel;
      public DateTime Started, Ended;
      public int Done, Total;
      public long Bytes, Files;
      public IDictionary Result;
      public List<Big> Bigs = new List<Big>();
    }
    static ScanRec _scan;
    static int _scanN;

    static string CatLabel(string c) {
      switch (c) {
        case "apps": return "Installed apps";
        case "documents": return "Documents";
        case "pictures": return "Pictures";
        case "videos": return "Videos";
        case "music": return "Music";
        case "temp": return "Temporary files";
        case "system": return "System & reserved";
        case "otherUsers": return "Other people";
        case "other": return "Other";
      }
      return c;
    }

    static List<Step> Steps(string drive) {
      var s = new List<Step>();
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      string win = StorageFiles.WindowsDir();
      Action<Step> add = delegate (Step st) {
        if (string.IsNullOrEmpty(st.Root)) return;
        st.Root = st.Root.TrimEnd('\\');
        if (!(st.Root.Length == 2 ? st.Root : st.Root.Substring(0, 2)).Equals(drive, StringComparison.OrdinalIgnoreCase)) return;
        if (!seen.Add(st.Root + "|" + st.Pattern)) return;
        s.Add(st);
      };
      add(new Step { Cat = "apps", Root = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) });
      add(new Step { Cat = "apps", Root = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) });
      add(new Step { Cat = "apps", Root = StorageFiles.Known(StorageFiles.UserPrograms) });
      add(new Step { Cat = "documents", Root = StorageFiles.Known(StorageFiles.Documents), User = true });
      add(new Step { Cat = "documents", Root = StorageFiles.Known(StorageFiles.Desktop), User = true });
      add(new Step { Cat = "pictures", Root = StorageFiles.Known(StorageFiles.Pictures), User = true });
      add(new Step { Cat = "videos", Root = StorageFiles.Known(StorageFiles.Videos), User = true });
      add(new Step { Cat = "music", Root = StorageFiles.Known(StorageFiles.Music), User = true });
      add(new Step { Cat = "temp", Root = Path.GetTempPath() });
      add(new Step { Cat = "temp", Root = win + @"\Temp" });
      add(new Step { Cat = "temp", Root = StorageFiles.Known(StorageFiles.Downloads), User = true });
      string la = StorageFiles.Known(StorageFiles.LocalAppData);
      if (la != null) add(new Step { Cat = "temp", Root = la + @"\Microsoft\Windows\Explorer", Pattern = "thumbcache_*.db", Recurse = false });
      var skip = new HashSet<string>(); skip.Add((win + @"\Temp").ToUpperInvariant());
      add(new Step { Cat = "system", Root = win, Skip = skip });
      foreach (string f in new string[] { "pagefile.sys", "hiberfil.sys", "swapfile.sys" })
        add(new Step { Cat = "system", Root = drive, Pattern = f, Recurse = false });
      string prof = StorageFiles.Known(StorageFiles.Profile);
      if (prof != null) {
        int cut = prof.LastIndexOf('\\');
        string users = cut > 2 ? prof.Substring(0, cut) : null;
        if (users != null) {
          try {
            foreach (string d in Directory.GetDirectories(users)) {
              string n = d.Substring(users.Length + 1);
              if (d.Equals(prof, StringComparison.OrdinalIgnoreCase) || n == "Public" || n == "Default" || n == "Default User" || n == "All Users") continue;
              if ((StorageFiles.Attr(d) & StorageFiles.A_REPARSE) != 0) continue;
              add(new Step { Cat = "otherUsers", Root = d });
            }
          } catch (Exception) { }
        }
      }
      return s;
    }

    static void Progress(ScanRec r) {
      Features.Event("sysstorage", Json.Obj("what", "progress", "scan", r.Token, "drive", r.Drive, "done", r.Done, "total", r.Total,
                                            "bytes", r.Bytes, "files", r.Files, "category", r.Cat));
    }

    static string Scan(Dictionary<string, object> req, ref object result) {
      string drive = Json.GetString(req, "drive");
      if (string.IsNullOrEmpty(drive)) drive = StorageFiles.SystemDrive();
      drive = drive.TrimEnd('\\').ToUpperInvariant();
      if (drive.Length != 2 || drive[1] != ':' || drive[0] < 'A' || drive[0] > 'Z') return "sysstorage.scan needs drive: a letter like \"C:\"";
      bool ready = false;
      try { var di = new DriveInfo(drive); ready = di.IsReady && (di.DriveType == DriveType.Fixed || di.DriveType == DriveType.Removable); }
      catch (Exception) { ready = false; }
      if (!ready) return "that drive is not a ready local drive, so it cannot be scanned";
      ScanRec r;
      lock (_gate) {
        if (_scan != null && _scan.State == "running")
          return "a scan is already running (" + _scan.Done + " of " + _scan.Total + " steps); stop it first";
        List<Step> steps = Steps(drive);
        r = new ScanRec { Token = "scan-" + (++_scanN).ToString(CultureInfo.InvariantCulture), Drive = drive, Started = DateTime.UtcNow, Total = steps.Count };
        _scan = r;
        var th = new Thread(delegate () { RunScan(r, steps); });
        th.IsBackground = true;
        th.Priority = ThreadPriority.BelowNormal;
        th.Start();
      }
      result = Json.Obj("started", true, "scan", r.Token, "drive", drive, "total", r.Total);
      return null;
    }

    static void RunScan(ScanRec r, List<Step> steps) {
      try {
        var cats = new Dictionary<string, long[]>();
        foreach (string c in CATS) cats[c] = new long[5];   // bytes, files, denied, links, cloud-only
        long unusedCut = DateTime.UtcNow.AddDays(-365).ToFileTimeUtc();
        int last = Environment.TickCount;
        Progress(r);
        foreach (Step st in steps) {
          if (r.Cancel) break;
          r.Cat = st.Cat;
          long b0 = r.Bytes, f0 = r.Files;
          var w = new StorageWalk { Skip = st.Skip };
          w.Stop = delegate { return r.Cancel; };
          w.Tick = delegate {
            r.Bytes = b0 + w.Bytes; r.Files = f0 + w.Files;
            if (Environment.TickCount - last >= 300) { last = Environment.TickCount; Progress(r); }
          };
          if (st.User) w.OnFile = delegate (string p, long size, long wr, long cr) {
            if (size < BigMin) return;
            bool large = size >= LargeMin;
            if (!large && wr >= unusedCut) return;
            lock (r.Bigs) {
              r.Bigs.Add(new Big { Path = p, Size = size, Write = wr, Large = large });
              if (r.Bigs.Count > 400) { r.Bigs.Sort(delegate (Big a, Big b) { return b.Size.CompareTo(a.Size); }); r.Bigs.RemoveRange(100, r.Bigs.Count - 100); }
            }
          };
          StorageFiles.Walk(st.Root, w, st.Recurse, st.Pattern);
          long[] a2 = cats[st.Cat];
          a2[0] += w.Bytes; a2[1] += w.Files; a2[2] += w.Denied; a2[3] += w.Links; a2[4] += w.CloudOnly;
          r.Bytes = b0 + w.Bytes; r.Files = f0 + w.Files;
          if (!r.Cancel) r.Done++;
        }
        if (r.Cancel) {
          lock (_gate) { r.State = "cancelled"; r.Ended = DateTime.UtcNow; }
          Features.Event("sysstorage", Json.Obj("what", "cancelled", "scan", r.Token, "drive", r.Drive, "done", r.Done, "total", r.Total));
          return;
        }
        long rbB, rbN; int hr;
        if (StorageFiles.RecycleBin(r.Drive + "\\", out rbB, out rbN, out hr)) { cats["temp"][0] += rbB; cats["temp"][1] += rbN; }
        var di = new DriveInfo(r.Drive);
        long total = di.TotalSize, free = di.TotalFreeSpace, used = total - free;
        long others = 0;
        foreach (string c in CATS) if (c != "system" && c != "other") others += cats[c][0];
        long room = Math.Max(0, used - others);
        bool capped = cats["system"][0] > room;
        if (capped) cats["system"][0] = room;
        long sum = others + cats["system"][0];
        cats["other"][0] = Math.Max(0, used - sum);
        var list = new List<object>();
        foreach (string c in CATS) {
          long[] v = cats[c];
          string why = null;
          if (c == "other") why = null;
          else if (c == "otherUsers" && v[2] > 0) why = "Windows only lets an administrator look inside other people's folders, so their files are counted under Other";
          else if (v[2] > 0) why = Plural(v[2], "folder") + " could not be read (Windows keeps them for administrators or itself); what they hold is counted under Other";
          string note = null;
          if (c == "system" && capped) note = "An estimate: Windows keeps many files in two of its folders at once (hard links), so walking it counts them twice; shown as the space the other categories leave";
          if (c == "other") note = "Everything the scan could not put in a category: app data, ProgramData, restore points and folders only Windows can read";
          if (c == "temp") note = "Temporary folders, thumbnails, Downloads and this drive's Recycle Bin";
          if (c == "documents") note = "Documents and Desktop";
          if (c == "apps") note = "Program Files and your own apps folder; Store apps sit in a folder only Windows can read, so they count under Other";
          if (c == "system") note = note ?? "The Windows folder, the page file and the hibernation file. An estimate: files Windows keeps in two of its folders at once (hard links) count each time";
          list.Add(Json.Obj("key", c, "label", CatLabel(c), "bytes", v[0], "files", c == "other" ? null : (object)v[1],
                            "denied", c == "other" ? null : (object)v[2], "cloudOnly", c == "other" ? null : (object)v[4], "reason", why, "note", note));
        }
        IDictionary res = Json.Obj("scan", r.Token, "drive", r.Drive, "total", total, "free", free, "used", used, "categories", list,
                                   "ms", (long)(DateTime.UtcNow - r.Started).TotalMilliseconds);
        lock (_gate) { r.Result = res; r.State = "done"; r.Ended = DateTime.UtcNow; }
        IDictionary ev = Json.Obj("what", "done");
        foreach (DictionaryEntry kv in res) ev[kv.Key] = kv.Value;
        Features.Event("sysstorage", ev);
      } catch (Exception ex) {
        lock (_gate) { r.State = "failed"; r.Reason = "the scan stopped: " + SysCommon.Why(ex); r.Ended = DateTime.UtcNow; }
        Features.Event("sysstorage", Json.Obj("what", "failed", "scan", r.Token, "reason", r.Reason));
      }
    }

    /// The running or last scan, in counts (the page redraws from it when it opens).
    static IDictionary ScanSnap(bool withBig) {
      ScanRec r;
      lock (_gate) { r = _scan; }
      if (r == null) return Json.Obj("state", "none");
      return Json.Obj("state", r.State, "scan", r.Token, "drive", r.Drive, "done", r.Done, "total", r.Total, "bytes", r.Bytes,
                      "files", r.Files, "category", r.Cat, "reason", r.Reason, "result", r.Result,
                      "at", r.Ended == DateTime.MinValue ? null : r.Ended.ToString("o", CultureInfo.InvariantCulture));
    }

    static string ScanStop(Dictionary<string, object> req, ref object result) {
      ScanRec r;
      lock (_gate) { r = _scan; }
      bool running = r != null && r.State == "running";
      if (running) r.Cancel = true;
      result = Json.Obj("stopping", running, "scan", r == null ? null : r.Token);
      return null;
    }

    static string Recommend(Dictionary<string, object> req, ref object result) {
      ScanRec r;
      lock (_gate) { r = _scan; }
      const string rule = "Files of 100 MB or more, or of 20 MB or more that nothing has changed for a year, in your own folders";
      if (r == null || r.State != "done") {
        result = Json.Obj("files", new List<object>(), "rule", rule,
                          "reason", r != null && r.State == "running" ? "The scan is still running; the list comes when it ends" : "Scan a drive first: this list comes from the last scan");
        return null;
      }
      List<Big> bigs;
      lock (r.Bigs) { bigs = new List<Big>(r.Bigs); }
      bigs.Sort(delegate (Big a, Big b) { return b.Size.CompareTo(a.Size); });
      var list = new List<object>();
      foreach (Big b in bigs) {
        if (list.Count >= 25) break;
        int cut = b.Path.LastIndexOf('\\');
        list.Add(Json.Obj("name", b.Path.Substring(cut + 1), "folder", b.Path.Substring(0, cut), "bytes", b.Size,
                          "modified", Iso(b.Write), "why", b.Large ? "large" : "unused"));
      }
      result = Json.Obj("files", list, "rule", rule, "drive", r.Drive,
                        "at", r.Ended.ToString("o", CultureInfo.InvariantCulture),
                        "reason", list.Count == 0 ? "The last scan found no large or unused files in your own folders" : null);
      return null;
    }

    // ================================================================== advanced storage settings
    static List<Dictionary<string, object>> Wmi(string cls, string props, out string why) {
      var list = new List<Dictionary<string, object>>();
      why = null;
      try {
        using (var s = new ManagementObjectSearcher(@"root\Microsoft\Windows\Storage", "SELECT " + props + " FROM " + cls)) {
          s.Options.Timeout = TimeSpan.FromSeconds(8);
          foreach (ManagementBaseObject o in s.Get()) {
            var d = new Dictionary<string, object>();
            foreach (string p0 in props.Split(',')) {
              string p = p0.Trim();
              try { d[p] = o[p]; } catch (ManagementException) { d[p] = null; }
            }
            list.Add(d);
            o.Dispose();
          }
        }
      } catch (Exception ex) { why = "Windows' storage service did not answer (" + SysCommon.Why(ex) + ")"; }
      return list;
    }

    static long L(object v) { try { return v == null ? 0 : Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch (Exception) { return 0; } }
    static int I(object v) { try { return v == null ? -1 : Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch (Exception) { return -1; } }
    static string Letter(object v) {
      char c = '\0';
      if (v is char) c = (char)v; else if (v is ushort) c = (char)(ushort)v; else if (v is string && ((string)v).Length > 0) c = ((string)v)[0];
      return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' ? char.ToUpperInvariant(c) + ":" : null;
    }

    static string Bus(int b) {
      switch (b) {
        case 1: return "SCSI"; case 2: return "ATAPI"; case 3: return "ATA"; case 4: return "FireWire"; case 6: return "Fibre Channel";
        case 7: return "USB"; case 8: return "RAID"; case 9: return "iSCSI"; case 10: return "SAS"; case 11: return "SATA"; case 12: return "SD card";
        case 13: return "MMC"; case 15: return "Virtual disk file"; case 16: return "Storage Spaces"; case 17: return "NVMe"; case 18: return "SCM"; case 19: return "UFS";
      }
      return "Unknown bus";
    }
    static string Media(int m) { return m == 3 ? "HDD" : m == 4 ? "SSD" : m == 5 ? "SCM" : null; }
    static string Health(int h) { return h == 0 ? "Healthy" : h == 1 ? "Warning" : h == 2 ? "Unhealthy" : "Health unknown"; }
    static string PartKind(object gpt, object mbr) {
      string g = gpt as string;
      if (!string.IsNullOrEmpty(g)) {
        g = g.ToLowerInvariant();
        if (g.Contains("c12a7328-f81f-11d2-ba4b-00a0c93ec93b")) return "EFI system partition";
        if (g.Contains("e3c9e316-0b5c-4db8-817d-f92df00215ae")) return "Microsoft reserved";
        if (g.Contains("de94bba4-06d1-4d40-a16a-bfd50179d6ac")) return "Recovery";
        if (g.Contains("ebd0a0a2-b9e5-4433-87c0-68b6b72699c7")) return "Basic data";
        return "Other partition";
      }
      int m = I(mbr);
      if (m == 7 || m == 6 || m == 12 || m == 14) return "Basic data";
      if (m == 39) return "Recovery";
      return m > 0 ? "Other partition" : "Partition";
    }

    static string Advanced(Dictionary<string, object> req, ref object result) {
      string wd, wp, wpt, wv, wpool;
      var disks = Wmi("MSFT_Disk", "Number, FriendlyName, Size, BusType, PartitionStyle, HealthStatus, IsBoot, IsSystem", out wd);
      var phys = Wmi("MSFT_PhysicalDisk", "DeviceId, MediaType", out wp);
      var parts = Wmi("MSFT_Partition", "DiskNumber, PartitionNumber, DriveLetter, Size, GptType, MbrType, AccessPaths", out wpt);
      var vols = Wmi("MSFT_Volume", "DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining, HealthStatus, Path", out wv);
      var pools = Wmi("MSFT_StoragePool", "FriendlyName, IsPrimordial, Size, AllocatedSize, HealthStatus", out wpool);
      var dl = new List<object>();
      foreach (var d in disks) {
        int num = I(d["Number"]);
        string media = null;
        foreach (var p in phys) if (Convert.ToString(p["DeviceId"], CultureInfo.InvariantCulture) == num.ToString(CultureInfo.InvariantCulture)) media = Media(I(p["MediaType"]));
        var pl = new List<object>();
        var mine = parts.FindAll(delegate (Dictionary<string, object> p) { return I(p["DiskNumber"]) == num; });
        mine.Sort(delegate (Dictionary<string, object> a, Dictionary<string, object> b) { return I(a["PartitionNumber"]).CompareTo(I(b["PartitionNumber"])); });
        foreach (var p in mine) {
          string letter = Letter(p["DriveLetter"]);
          string[] paths = p["AccessPaths"] as string[];
          Dictionary<string, object> vol = null;
          foreach (var v in vols) {
            string vl = Letter(v["DriveLetter"]), vp = v["Path"] as string;
            if (letter != null && vl == letter) { vol = v; break; }
            if (letter == null && vp != null && paths != null && Array.IndexOf(paths, vp) >= 0) { vol = v; break; }
          }
          pl.Add(Json.Obj("number", I(p["PartitionNumber"]), "letter", letter, "kind", PartKind(p["GptType"], p["MbrType"]),
                          "bytes", L(p["Size"]), "label", vol == null ? null : vol["FileSystemLabel"] as string,
                          "fs", vol == null ? null : vol["FileSystem"] as string, "free", vol == null ? null : (object)L(vol["SizeRemaining"]),
                          "health", vol == null ? null : Health(I(vol["HealthStatus"]))));
        }
        int ps = I(d["PartitionStyle"]);
        dl.Add(Json.Obj("number", num, "name", d["FriendlyName"] as string, "bytes", L(d["Size"]), "bus", Bus(I(d["BusType"])), "media", media,
                        "style", ps == 2 ? "GPT" : ps == 1 ? "MBR" : "Not initialised", "health", Health(I(d["HealthStatus"])),
                        "boot", d["IsBoot"] is bool && (bool)d["IsBoot"], "system", d["IsSystem"] is bool && (bool)d["IsSystem"], "partitions", pl));
      }
      var pooled = new List<object>();
      foreach (var p in pools) {
        if (p["IsPrimordial"] is bool && (bool)p["IsPrimordial"]) continue;
        pooled.Add(Json.Obj("name", p["FriendlyName"] as string, "bytes", L(p["Size"]), "allocated", L(p["AllocatedSize"]), "health", Health(I(p["HealthStatus"]))));
      }
      result = Json.Obj(
        "disks", dl, "disksReason", wd ?? wpt ?? wv,
        "disksWhy", "Read only here: formatting, resizing or changing a drive letter can lose data, so Mantle shows disks and volumes but does not change them",
        "pools", pooled, "poolsReason", wpool,
        "poolsWhy", "Read only here: making or changing a storage pool erases the drives added to it, so Mantle shows pools but does not change them",
        "saveLocations", SaveLocations(),
        "backup", Backup());
      return null;
    }

    static List<object> SaveLocations() {
      int fixedDrives = 0;
      try { foreach (DriveInfo d in DriveInfo.GetDrives()) { try { if (d.DriveType == DriveType.Fixed && d.IsReady) fixedDrives++; } catch (Exception) { } } } catch (Exception) { }
      string why = "Read only here: Windows changes this by moving that folder (for apps, its app volume) to another drive, which Mantle does not do yet" +
                   (fixedDrives <= 1 ? "; this PC has one drive, so there is nowhere else to save anyway" : "");
      string w;
      object pr = SysCommon.Read("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx", "PackageRoot", out w);
      string apps = pr as string;
      if (string.IsNullOrEmpty(apps)) apps = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
      var list = new List<object>();
      string[][] rows = {
        new string[] { "apps", "New apps will save to", apps },
        new string[] { "documents", "New documents will save to", StorageFiles.Known(StorageFiles.Documents) },
        new string[] { "music", "New music will save to", StorageFiles.Known(StorageFiles.Music) },
        new string[] { "photos", "New photos and videos will save to", StorageFiles.Known(StorageFiles.Pictures) },
        new string[] { "movies", "New movies and TV shows will save to", StorageFiles.Known(StorageFiles.Videos) },
      };
      foreach (string[] r in rows) {
        string p = r[2];
        string drive = p != null && p.Length >= 2 && p[1] == ':' ? p.Substring(0, 2).ToUpperInvariant() : null;
        list.Add(Json.Obj("kind", r[0], "label", r[1], "drive", drive, "writable", false,
                          "why", drive == null ? "Windows did not say where this is saved" : why));
      }
      return list;
    }

    static IDictionary Backup() {
      string la = StorageFiles.Known(StorageFiles.LocalAppData);
      bool fh = la != null && File.Exists(la + @"\Microsoft\Windows\FileHistory\Configuration\Config1.xml");
      int od = OneDriveSignedIn();
      return Json.Obj("fileHistory", fh, "oneDrive", od > 0,
        "why", "Read only here: File History and Windows Backup run in their own apps; Mantle only reports whether they are set up");
    }

    // ================================================================== the sandbox test (test sidecars only)
    /// Runs the REAL guard and delete inside ...\lanes\storage\sandbox and nowhere else. `extra` paths
    /// are offered to the guard as if a plan held them (with their real size and time, so only the
    /// guard can stop them); `stale` makes the first sandbox file's planned size wrong (it must survive).
    static string SandboxTest(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "sysstorage.sandboxTest only runs in a test sidecar (--passive)";
      string box = (Json.GetString(req, "sandbox") ?? "").TrimEnd('\\');
      bool dry = Json.GetBool(req, "dryRun", false), stale = Json.GetBool(req, "stale", false);
      string temp = Path.GetTempPath().TrimEnd('\\');
      if (!box.EndsWith(@"\lanes\storage\sandbox", StringComparison.OrdinalIgnoreCase)) return "the sandbox must be a folder ending in lanes\\storage\\sandbox";
      if (!box.StartsWith(temp + "\\", StringComparison.OrdinalIgnoreCase)) return "the sandbox must be inside the temporary folder";
      if (StorageFiles.Plain(box) != null) return "the sandbox is not a plain full path";
      uint a = StorageFiles.Attr(box);
      if (a == 0xFFFFFFFF || (a & StorageFiles.A_DIR) == 0) return "the sandbox folder does not exist";
      if ((a & StorageFiles.A_REPARSE) != 0) return "the sandbox is a link";
      var targets = new List<StorageTarget>();
      var w = new StorageWalk();
      w.OnFile = delegate (string p, long size, long wr, long cr) { targets.Add(new StorageTarget { Path = p, Size = size, WriteTicks = wr }); };
      StorageFiles.Walk(box, w, true, null);
      string staleName = null;
      if (stale && targets.Count > 0) { targets[0].Size += 1; staleName = targets[0].Path.Substring(targets[0].Path.LastIndexOf('\\') + 1); }
      int inBox = targets.Count;
      object ex;
      if (Json.TryGet(req, "extra", out ex) && ex is IList) foreach (object o in (IList)ex) {
        string p = o as string;
        if (p == null || p.Length > 1000) continue;
        var t = new StorageTarget { Path = p, Size = -1 };
        try { var fi = new FileInfo(p); if (fi.Exists) { t.Size = fi.Length; t.WriteTicks = fi.LastWriteTimeUtc.ToFileTimeUtc(); } } catch (Exception) { }
        targets.Add(t);
      }
      var roots = new string[] { box };
      var verdicts = new List<object>();
      for (int i = inBox; i < targets.Count; i++) {
        string g = StorageFiles.Inside(targets[i].Path, roots);
        verdicts.Add(Json.Obj("index", i - inBox, "allowed", g == null, "why", g));
      }
      if (dry) {
        int ok = 0;
        foreach (StorageTarget t in targets) if (StorageFiles.Inside(t.Path, roots) == null) ok++;
        result = Json.Obj("dryRun", true, "would", Json.Obj("files", ok, "refused", targets.Count - ok), "inSandbox", inBox, "verdicts", verdicts, "links", w.Links);
        return null;
      }
      StorageDeleted d = StorageFiles.Delete(targets, roots, false, null, null);
      result = Json.Obj("deleted", d.Json(), "inSandbox", inBox, "verdicts", verdicts, "links", w.Links, "stale", staleName);
      return null;
    }
  }
}
