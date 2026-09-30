// DevPrinters.cs - Settings > Bluetooth & devices > Printers & scanners, inside Mantle (devnet lane, 2026-09-28).
//
// WHAT: the printer list with status and queue counts, the default printer and "Let Windows manage my
// default printer", a printer's queue and its jobs, removing a printer, adding one by a share path or a
// network address, and the scanners Windows knows. Straight winspool (the print spooler's own API), the
// same calls Windows' Settings page and printui make. Nothing hands off to Windows' Settings app.
//
//   printers.list                                   every printer + the default + letWindowsManage + scanners
//   printers.setDefault {printer, dryRun?}          SetDefaultPrinter (per user)
//   printers.manage {on, dryRun?}                   HKCU LegacyDefaultPrinterMode + the "windows" broadcast
//   printers.remove {printer, dryRun?}              a connection: DeletePrinterConnection (per user);
//                                                   a local printer: DeletePrinter, admin: printers.removeLocal
//   printers.queue {printer}                        EnumJobs level 2
//   printers.cancelJob / pauseJob / resumeJob {printer, job, dryRun?}   SetJob
//   printers.addNetwork {path | address, name?, driver?, dryRun?}
//                                                   \\server\printer: AddPrinterConnection (per user);
//                                                   an IP address / host name: admin: printers.addTcp
//
// ADMIN (ELEVATE.md, [Elevated] actions in this file): printers.removeLocal {printer} and
// printers.addTcp {address, name, driver}. Their validators check every value against what the spooler
// lists right now (a known list, not "not empty"), in the sidecar and again in the elevated copy.
//
// VERIFIED 2026-09-28 by READS only (Windows 11 build 26200; re-read on 26300, 2026-09-30):
//   - "Let Windows manage my default printer" = HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows,
//     DWORD LegacyDefaultPrinterMode: present here as 0 (Windows manages), so 1 = Windows does NOT manage.
//     winspool.drv holds that value name, the key text, "DefaultPrinterModeChanged" and imports
//     SendNotifyMessageW: the broadcast after a change is WM_SETTINGCHANGE with lParam "windows", sent the
//     same non-blocking way.
//   - Scanners: Windows.Devices.Enumeration, DeviceClass.ImageScanner (the WIA scanners Settings lists).
//     List only: scanning a page is the Windows Scan app's job, not Settings'.
//
// PRIVACY: printer names, documents and owners go into replies only; logs carry counts and routes.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;
#if MANTLE_WINMD
using Windows.Devices.Enumeration;
#endif

namespace Mantle {
  [MantleFeature]
  static class DevPrinters {
    public static void Register(FeatureTable t) {
      t.Add("printers.list", Lanes.Slow, List);
      t.Add("printers.setDefault", Lanes.Slow, SetDefault);
      t.Add("printers.manage", Lanes.Slow, Manage);
      t.Add("printers.remove", Lanes.Slow, Remove);
      t.Add("printers.queue", Lanes.Slow, Queue);
      t.Add("printers.cancelJob", Lanes.Slow, CancelJob);
      t.Add("printers.pauseJob", Lanes.Slow, PauseJob);
      t.Add("printers.resumeJob", Lanes.Slow, ResumeJob);
      t.Add("printers.addNetwork", Lanes.Slow, AddNetwork);
    }

    const string WinKeyPath = @"Software\Microsoft\Windows NT\CurrentVersion\Windows";
    const string V_LEGACY = "LegacyDefaultPrinterMode";
    const int MaxName = 260;

    // ------------------------------------------------------------------ plumbing

    delegate string Job(out object result);

    /// Printer calls can wait on a print server that is off; they run on a pool thread, reply deferred.
    static void Post(Dictionary<string, object> req, string what, Job job) {
      object rid = req.ContainsKey("id") ? req["id"] : null;
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        object res = null;
        string err;
        try { err = job(out res); } catch (Exception ex) {
          err = what + " failed inside Mantle (" + ex.GetType().Name + ": " + ex.Message + ")";
        }
        Program.ReplyFromWorker(rid, err == null, err == null ? res : null, err);
      });
    }

    static string Win32Words(int err) {
      return new Win32Exception(err).Message.TrimEnd('.', ' ') + ", error " + err;
    }

    static string DryRunOf(Dictionary<string, object> req, string cmd, out bool dry) {
      dry = false;
      object v;
      if (!req.TryGetValue("dryRun", out v) || v == null) return null;
      if (!(v is bool)) return cmd + ": dryRun must be true or false";
      dry = (bool)v;
      return null;
    }

    /// A printer name as the spooler spells it: text, not control characters, not absurdly long.
    static string NameProblem(object v, string what) {
      if (!(v is string)) return what + " must be a printer name (text)";
      string s = (string)v;
      if (s.Length == 0) return what + " is empty";
      if (s.Length > MaxName) return what + " is too long to be a printer name";
      foreach (char c in s) if (c < 0x20) return what + " contains a control character";
      return null;
    }

    static string PrinterArg(Dictionary<string, object> req, string cmd, out string printer) {
      printer = null;
      object v;
      if (!req.TryGetValue("printer", out v) || v == null) return cmd + " needs printer: a name from printers.list";
      string why = NameProblem(v, cmd + ": printer");
      if (why != null) return why;
      printer = (string)v;
      return null;
    }

    // ------------------------------------------------------------------ the spooler's list

    sealed class PInfo {
      public string Name, Server, Share, Port, Driver, Comment, Location;
      public int Attributes, Status, Jobs;
      public bool Connection { get { return (Attributes & A_NETWORK) != 0 && Name.StartsWith(@"\\", StringComparison.Ordinal); } }
      public bool Local { get { return !Connection; } }
    }

    const int A_SHARED = 0x8, A_NETWORK = 0x10, A_LOCAL = 0x40, A_WORK_OFFLINE = 0x400, A_FAX = 0x4000;

    /// `flags`: PRINTER_ENUM_LOCAL (2) | PRINTER_ENUM_CONNECTIONS (4). Null + err on failure.
    static List<PInfo> Enum(int flags, out string err) {
      err = null;
      int needed, returned;
      Native.EnumPrinters(flags, null, 2, IntPtr.Zero, 0, out needed, out returned);
      var list = new List<PInfo>();
      if (needed <= 0) {
        int e = Marshal.GetLastWin32Error();
        if (e != 0 && e != 122) { err = "the print spooler did not list printers (" + Win32Words(e) + ")"; return null; }
        return list;
      }
      IntPtr buf = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.EnumPrinters(flags, null, 2, buf, needed, out needed, out returned)) {
          err = "the print spooler did not list printers (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
          return null;
        }
        int size = Marshal.SizeOf(typeof(Native.PRINTER_INFO_2));
        for (int i = 0; i < returned; i++) {
          var p = (Native.PRINTER_INFO_2)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(Native.PRINTER_INFO_2));
          var x = new PInfo();
          x.Name = p.pPrinterName ?? "";
          x.Server = p.pServerName;
          x.Share = p.pShareName;
          x.Port = p.pPortName;
          x.Driver = p.pDriverName;
          x.Comment = p.pComment;
          x.Location = p.pLocation;
          x.Attributes = p.Attributes;
          x.Status = p.Status;
          x.Jobs = p.cJobs;
          list.Add(x);
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return list;
    }

    static PInfo Find(List<PInfo> all, string name) {
      foreach (var p in all) if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) return p;
      return null;
    }

    static string Resolve(string cmd, string printer, out PInfo p) {
      p = null;
      string err;
      var all = Enum(6, out err);
      if (all == null) return cmd + ": " + err;
      p = Find(all, printer);
      if (p == null) return cmd + ": no printer by that name is installed for this user";
      return null;
    }

    static string DefaultPrinter() {
      int size = 0;
      Native.GetDefaultPrinter(null, ref size);
      if (size <= 0) return null;
      var sb = new StringBuilder(size);
      return Native.GetDefaultPrinter(sb, ref size) ? sb.ToString() : null;
    }

    static readonly string[] StatusBits = new string[] {
      "paused", "error", "being deleted", "paper jam", "out of paper", "manual feed", "paper problem", "offline",
      "I/O active", "busy", "printing", "output bin full", "not available", "waiting", "processing", "initialising",
      "warming up", "toner low", "out of toner", "page punt", "needs attention", "out of memory", "door open",
      "server unknown", "power save", "server offline", "driver update needed"
    };

    static ArrayList StatusWords(int status, int attributes) {
      var words = new ArrayList();
      for (int b = 0; b < StatusBits.Length; b++) if ((status & (1 << b)) != 0) words.Add(StatusBits[b]);
      if ((attributes & A_WORK_OFFLINE) != 0 && !words.Contains("offline")) words.Add("offline (use printer offline)");
      return words;
    }

    static IDictionary PrinterJson(PInfo p, string dflt) {
      ArrayList st = StatusWords(p.Status, p.Attributes);
      bool offline = (p.Status & 0x80) != 0 || (p.Status & 0x2000000) != 0 || (p.Attributes & A_WORK_OFFLINE) != 0;
      return Json.Obj("printer", p.Name, "port", p.Port, "driver", p.Driver, "location", p.Location,
                      "comment", p.Comment, "shared", (p.Attributes & A_SHARED) != 0, "shareName", p.Share,
                      "kind", p.Connection ? "connection" : "local",
                      "network", (p.Attributes & A_NETWORK) != 0, "fax", (p.Attributes & A_FAX) != 0,
                      "status", st, "statusText", st.Count == 0 ? "Ready" : string.Join(", ", (string[])st.ToArray(typeof(string))),
                      "offline", offline, "jobs", p.Jobs,
                      "isDefault", dflt != null && string.Equals(dflt, p.Name, StringComparison.OrdinalIgnoreCase));
    }

    /// LegacyDefaultPrinterMode: 1 = Windows does NOT manage the default. Absent = Windows' default (manage).
    static object ReadLegacy(out string err) {
      err = null;
      try {
        using (var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
        using (var k = root.OpenSubKey(WinKeyPath, false)) {
          object v = k == null ? null : k.GetValue(V_LEGACY, null);
          if (v == null || v is int) return v;
          err = V_LEGACY + " is not the DWORD Windows writes";
          return null;
        }
      } catch (Exception ex) {
        err = "the registry could not be read (" + ex.Message + ")";
        return null;
      }
    }

    // ------------------------------------------------------------------ printers.list

    static string List(Dictionary<string, object> req, ref object result) {
      Post(req, "printers.list", delegate (out object r) {
        long t0 = Stopwatch.GetTimestamp();
        string err;
        var all = Enum(6, out err);
        string dflt = DefaultPrinter();
        var rows = new ArrayList();
        if (all != null) {
          all.Sort(delegate (PInfo a, PInfo b) { return string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase); });
          foreach (var p in all) rows.Add(PrinterJson(p, dflt));
        }
        string lerr;
        object legacy = ReadLegacy(out lerr);
        bool manage = !(legacy is int && (int)legacy == 1);
        string serr;
        ArrayList scanners = Scanners(out serr);
        r = Json.Obj("ok", all != null, "printers", rows, "count", rows.Count, "default", dflt,
                     "defaultReason", dflt == null ? "this user has no default printer" : null,
                     "letWindowsManage", manage, "letWindowsManageStored", legacy,
                     "letWindowsManageWhere", @"HKCU\" + WinKeyPath + " " + V_LEGACY + " (DWORD, 1 = Windows does not manage)",
                     "letWindowsManageReason", lerr,
                     "scanners", scanners, "scannersVia", "Windows.Devices.Enumeration DeviceClass.ImageScanner (list only)",
                     "scannersReason", serr, "reason", err, "ms", Lanes.MsSince(t0));
        return null;
      });
      result = Program.Deferred;
      return null;
    }

    static ArrayList Scanners(out string err) {
      err = null;
      var list = new ArrayList();
#if MANTLE_WINMD
      DeviceInformationCollection col;
      err = WinRt.Await(DeviceInformation.FindAllAsync(DeviceClass.ImageScanner), 5000, "Windows' scanner list", out col);
      if (err != null) return list;
      foreach (DeviceInformation d in col)
        list.Add(Json.Obj("scanner", d.Id, "name", d.Name, "enabled", d.IsEnabled, "isDefault", d.IsDefault));
#else
      err = "the scanner list needs the WinRT metadata, which build.ps1 did not find (MANTLE_WINMD undefined)";
#endif
      return list;
    }

    // ------------------------------------------------------------------ default printer

    static string SetDefault(Dictionary<string, object> req, ref object result) {
      const string cmd = "printers.setDefault";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string printer;
      why = PrinterArg(req, cmd, out printer);
      if (why != null) return why;
      bool passive = Program.Passive;
      Post(req, cmd, delegate (out object r) {
        r = null;
        PInfo p;
        string err = Resolve(cmd, printer, out p);
        if (err != null) return err;
        string dflt = DefaultPrinter();
        bool already = dflt != null && string.Equals(dflt, p.Name, StringComparison.OrdinalIgnoreCase);
        string lerr;
        object legacy = ReadLegacy(out lerr);
        bool manage = !(legacy is int && (int)legacy == 1);
        string note = manage ? "\"Let Windows manage my default printer\" is on, so Windows may move the default to the printer " +
                               "you used last; switch it off (printers.manage {on:false}) to keep this one" : null;
        string would = already ? "do nothing: it is already the default printer"
                               : "make this printer the default for this user (SetDefaultPrinter)";
        if (dry) {
          r = Json.Obj("dryRun", true, "would", would, "printer", p.Name, "current", dflt, "already", already,
                       "letWindowsManage", manage, "note", note, "reason", null);
          return null;
        }
        if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
        if (!already && !Native.SetDefaultPrinter(p.Name))
          return cmd + ": Windows did not change the default printer (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
        string now = DefaultPrinter();
        bool ok = now != null && string.Equals(now, p.Name, StringComparison.OrdinalIgnoreCase);
        r = Json.Obj("ok", ok, "printer", p.Name, "default", now, "before", dflt, "letWindowsManage", manage, "note", note,
                     "reason", ok ? null : "the default read back as a different printer");
        return null;
      });
      result = Program.Deferred;
      return null;
    }

    static string Manage(Dictionary<string, object> req, ref object result) {
      const string cmd = "printers.manage";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      object v;
      if (!req.TryGetValue("on", out v) || !(v is bool)) return cmd + " needs on: true or false";
      bool on = (bool)v;
      int want = on ? 0 : 1;
      string lerr;
      object before = ReadLegacy(out lerr);
      bool now = !(before is int && (int)before == 1);
      string would = "set HKCU\\" + WinKeyPath + " " + V_LEGACY + " to " + want + " (Let Windows manage my default printer " +
                     (on ? "on" : "off") + ")" + (now == on ? ", which it already is" : "") +
                     " and broadcast WM_SETTINGCHANGE \"windows\"";
      if (dry) {
        result = Json.Obj("dryRun", true, "would", would, "on", on, "current", now, "stored", before, "reason", lerr);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
      try {
        using (var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
        using (var k = root.CreateSubKey(WinKeyPath)) {
          k.SetValue(V_LEGACY, want, RegistryValueKind.DWord);
        }
      } catch (Exception ex) {
        return cmd + ": Windows did not save the setting (" + ex.Message + ")";
      }
      // What winspool does after a default-printer change: a non-blocking broadcast.
      bool sent = Native.SendNotifyMessage(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, "windows");
      object after = ReadLegacy(out lerr);
      bool ok = after is int && (int)after == want;
      result = Json.Obj("ok", ok, "on", on, "stored", after, "before", before, "broadcast", sent,
                        "reason", !ok ? "the value read back as " + (after ?? "missing") : (sent ? null : "saved, but the WM_SETTINGCHANGE broadcast failed"));
      return null;
    }

    // ------------------------------------------------------------------ remove

    const int PRINTER_ALL_ACCESS = 0x000F000C;

    /// True when this process may open the printer for administration (the check DeletePrinter needs).
    static bool CanAdminister(string name, out int err) {
      err = 0;
      var d = new Native.PRINTER_DEFAULTS();
      d.DesiredAccess = PRINTER_ALL_ACCESS;
      IntPtr h;
      if (!Native.OpenPrinter(name, out h, ref d)) { err = Marshal.GetLastWin32Error(); return false; }
      Native.ClosePrinter(h);
      return true;
    }

    static string Remove(Dictionary<string, object> req, ref object result) {
      const string cmd = "printers.remove";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string printer;
      why = PrinterArg(req, cmd, out printer);
      if (why != null) return why;
      bool passive = Program.Passive;
      Post(req, cmd, delegate (out object r) {
        r = null;
        PInfo p;
        string err = Resolve(cmd, printer, out p);
        if (err != null) return err;
        if (p.Connection) {
          string would = "remove this user's connection to a shared printer (DeletePrinterConnection); the printer stays on its server";
          if (dry) {
            r = Json.Obj("dryRun", true, "would", would, "printer", p.Name, "route", "connection", "needsAdmin", false,
                         "jobs", p.Jobs, "reason", null);
            return null;
          }
          if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
          if (!Native.DeletePrinterConnection(p.Name))
            return cmd + ": Windows did not remove the connection (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
          Program.EmitLog("info", "printers: removed a printer connection");
          r = Json.Obj("ok", true, "printer", p.Name, "route", "connection", "removed", true, "reason", null);
          return null;
        }
        int oerr;
        bool can = CanAdminister(p.Name, out oerr);
        var elev = Json.Obj("action", "printers.removeLocal", "args", Json.Obj("printer", p.Name));
        string wouldL = "remove this printer from this PC for every user (DeletePrinter)" +
                        (p.Jobs > 0 ? "; it has " + p.Jobs + " job(s) waiting, so Windows removes it once they are gone" : "") +
                        (can ? "" : ", through one administrator prompt");
        if (dry) {
          r = Json.Obj("dryRun", true, "would", wouldL, "printer", p.Name, "route", "local", "needsAdmin", !can,
                       "adminCheck", can ? "this process can administer the printer" :
                                           "opening it for administration was refused (" + Win32Words(oerr) + ")",
                       "elevate", can ? null : elev, "jobs", p.Jobs, "reason", null);
          return null;
        }
        if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + wouldL;
        if (!can) {
          r = Json.Obj("ok", false, "printer", p.Name, "route", "local", "needsAdmin", true, "elevate", elev,
                       "reason", "removing a local printer needs an administrator: ask elevate for printers.removeLocal {printer}; nothing was changed");
          return null;
        }
        string derr = DeleteLocal(p.Name);
        if (derr != null) return cmd + ": " + derr;
        r = Json.Obj("ok", true, "printer", p.Name, "route", "local", "removed", true, "reason", null);
        return null;
      });
      result = Program.Deferred;
      return null;
    }

    static string DeleteLocal(string name) {
      var d = new Native.PRINTER_DEFAULTS();
      d.DesiredAccess = PRINTER_ALL_ACCESS;
      IntPtr h;
      if (!Native.OpenPrinter(name, out h, ref d))
        return "Windows did not open the printer for removal (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
      try {
        if (!Native.DeletePrinter(h))
          return "Windows did not remove the printer (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
      } finally {
        Native.ClosePrinter(h);
      }
      return null;
    }

    [Elevated("printers.removeLocal", "CheckRemoveLocal", "remove this printer from this PC")]
    static string RemoveLocal(Dictionary<string, object> args, ref object result) {
      string name = (string)args["printer"];
      string err = DeleteLocal(name);
      if (err != null) return err;
      result = Json.Obj("printer", name, "removed", true,
                        "note", "a printer with jobs still waiting disappears once its queue is empty");
      return null;
    }

    static string CheckRemoveLocal(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "printer");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("printer", out v)) return "a printer name is needed";
      why = NameProblem(v, "printer");
      if (why != null) return why;
      string err;
      var local = Enum(2, out err);       // PRINTER_ENUM_LOCAL: the known list
      if (local == null) return err;
      var p = Find(local, (string)v);
      if (p == null || p.Connection) return "no local printer by that name is installed on this PC";
      return null;
    }

    // ------------------------------------------------------------------ the queue

    static string Queue(Dictionary<string, object> req, ref object result) {
      const string cmd = "printers.queue";
      string printer;
      string why = PrinterArg(req, cmd, out printer);
      if (why != null) return why;
      Post(req, cmd, delegate (out object r) {
        r = null;
        PInfo p;
        string err = Resolve(cmd, printer, out p);
        if (err != null) return err;
        IntPtr h;
        if (!Native.OpenPrinterNoDefaults(p.Name, out h, IntPtr.Zero))
          return cmd + ": Windows did not open the printer (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
        try {
          var jobs = new ArrayList();
          err = EnumJobs(h, jobs);
          if (err != null) return cmd + ": " + err;
          r = Json.Obj("ok", true, "printer", p.Name, "jobs", jobs, "count", jobs.Count, "reason", null);
          return null;
        } finally {
          Native.ClosePrinter(h);
        }
      });
      result = Program.Deferred;
      return null;
    }

    static readonly string[] JobBits = new string[] {
      "paused", "error", "deleting", "spooling", "printing", "offline", "out of paper", "printed", "deleted",
      "blocked", "needs attention", "restarting", "complete", "retained", "rendering locally"
    };

    static IDictionary JobJson(Native.JOB_INFO_2 j) {
      var st = new ArrayList();
      for (int b = 0; b < JobBits.Length; b++) if ((j.Status & (1 << b)) != 0) st.Add(JobBits[b]);
      string text = !string.IsNullOrEmpty(j.pStatus) ? j.pStatus
                   : (st.Count == 0 ? "queued" : string.Join(", ", (string[])st.ToArray(typeof(string))));
      object submitted = null;
      try {
        var t = j.Submitted;
        if (t.wYear > 1600)
          submitted = new DateTime(t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, DateTimeKind.Utc)
                        .ToString("o", CultureInfo.InvariantCulture);
      } catch (Exception) { }
      return Json.Obj("job", j.JobId, "document", j.pDocument, "owner", j.pUserName,
                      "own", IsOwn(j.pUserName), "pages", j.TotalPages, "pagesPrinted", j.PagesPrinted,
                      "size", j.Size, "status", st, "statusText", text, "submitted", submitted);
    }

    static bool IsOwn(string owner) {
      return !string.IsNullOrEmpty(owner) && string.Equals(owner, Environment.UserName, StringComparison.OrdinalIgnoreCase);
    }

    static string EnumJobs(IntPtr h, ArrayList into) {
      int needed, returned;
      Native.EnumJobs(h, 0, 9999, 2, IntPtr.Zero, 0, out needed, out returned);
      if (needed <= 0) {
        int e = Marshal.GetLastWin32Error();
        if (e != 0 && e != 122) return "Windows did not list the queue (" + Win32Words(e) + ")";
        return null;
      }
      IntPtr buf = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.EnumJobs(h, 0, 9999, 2, buf, needed, out needed, out returned))
          return "Windows did not list the queue (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
        int size = Marshal.SizeOf(typeof(Native.JOB_INFO_2));
        for (int i = 0; i < returned; i++) {
          var j = (Native.JOB_INFO_2)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(Native.JOB_INFO_2));
          into.Add(JobJson(j));
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return null;
    }

    /// One job by number, or an error in words.
    static string GetJob(IntPtr h, int job, out Native.JOB_INFO_2 info) {
      info = new Native.JOB_INFO_2();
      int needed;
      Native.GetJob(h, job, 2, IntPtr.Zero, 0, out needed);
      if (needed <= 0) {
        int e = Marshal.GetLastWin32Error();
        return e == 87 ? "there is no job " + job + " in this printer's queue" : "Windows did not read the job (" + Win32Words(e) + ")";
      }
      IntPtr buf = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.GetJob(h, job, 2, buf, needed, out needed)) {
          int e = Marshal.GetLastWin32Error();
          return e == 87 ? "there is no job " + job + " in this printer's queue" : "Windows did not read the job (" + Win32Words(e) + ")";
        }
        info = (Native.JOB_INFO_2)Marshal.PtrToStructure(buf, typeof(Native.JOB_INFO_2));
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return null;
    }

    const int JOB_CONTROL_PAUSE = 1, JOB_CONTROL_RESUME = 2, JOB_CONTROL_DELETE = 5;

    static string CancelJob(Dictionary<string, object> req, ref object result) { return JobControl(req, ref result, "printers.cancelJob", JOB_CONTROL_DELETE, "cancel"); }
    static string PauseJob(Dictionary<string, object> req, ref object result) { return JobControl(req, ref result, "printers.pauseJob", JOB_CONTROL_PAUSE, "pause"); }
    static string ResumeJob(Dictionary<string, object> req, ref object result) { return JobControl(req, ref result, "printers.resumeJob", JOB_CONTROL_RESUME, "resume"); }

    /// The three share everything but the verb.
    static string JobControl(Dictionary<string, object> req, ref object result, string cmd, int control, string verb) {
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string printer;
      why = PrinterArg(req, cmd, out printer);
      if (why != null) return why;
      object v;
      if (!req.TryGetValue("job", out v) || v == null) return cmd + " needs job: a job number from printers.queue";
      if (!(v is double)) return cmd + ": job must be a number";
      double dj = (double)v;
      if (dj < 1 || dj > int.MaxValue || dj != Math.Floor(dj)) return cmd + ": job must be a whole number from printers.queue";
      int job = (int)dj;
      // A real job change in passive is refused before any lookup, so it is provable with an empty queue.
      if (!dry && Program.Passive)
        return FeatureTable.PassiveRefusal + ": " + cmd + " would " + verb + " job " + job + " on a real printer";
      bool passive = Program.Passive;
      Post(req, cmd, delegate (out object r) {
        r = null;
        PInfo p;
        string err = Resolve(cmd, printer, out p);
        if (err != null) return err;
        IntPtr h;
        if (!Native.OpenPrinterNoDefaults(p.Name, out h, IntPtr.Zero))
          return cmd + ": Windows did not open the printer (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
        try {
          Native.JOB_INFO_2 j;
          err = GetJob(h, job, out j);
          if (err != null) return cmd + ": " + err;
          bool own = IsOwn(j.pUserName);
          string would = verb + " job " + job + " on this printer" + (own ? "" : " (someone else's job: Windows allows that only to an administrator, so it would refuse)");
          if (dry) {
            r = Json.Obj("dryRun", true, "would", would, "printer", p.Name, "job", JobJson(j), "own", own,
                         "needsAdmin", !own, "reason", own ? null : "only the job's owner or an administrator can " + verb + " it");
            return null;
          }
          if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
          if (!Native.SetJob(h, job, 0, IntPtr.Zero, control)) {
            int e = Marshal.GetLastWin32Error();
            return cmd + ": Windows did not " + verb + " the job (" + Win32Words(e) + ")" +
                   (e == 5 ? "; only the job's owner or an administrator can " + verb + " it" : "");
          }
          r = Json.Obj("ok", true, "printer", p.Name, "job", job, "done", verb, "reason", null);
          return null;
        } finally {
          Native.ClosePrinter(h);
        }
      });
      result = Program.Deferred;
      return null;
    }

    // ------------------------------------------------------------------ add a printer

    static readonly Regex UncRx = new Regex(@"^\\\\[^\\/:*?""<>|\s][^\\/:*?""<>|]{0,62}\\[^\\/]{1,200}$", RegexOptions.CultureInvariant);
    static readonly Regex Ipv4Rx = new Regex(@"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", RegexOptions.CultureInvariant);
    static readonly Regex HostRx = new Regex(@"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$",
                                             RegexOptions.CultureInvariant);

    /// An IPv4 address or a DNS host name that fits the Standard TCP/IP port's 48-character field.
    static string AddressProblem(object v) {
      if (!(v is string)) return "address must be an IP address or a host name (text)";
      string s = (string)v;
      if (s.Length == 0) return "address is empty";
      if (s.Length > 48) return "address is too long for a printer port (48 characters at most)";
      Match m = Ipv4Rx.Match(s);
      if (m.Success) {
        for (int i = 1; i <= 4; i++) if (int.Parse(m.Groups[i].Value, CultureInfo.InvariantCulture) > 255) return "that is not an IPv4 address";
        return null;
      }
      if (s.IndexOf(':') >= 0) return "an IPv6 address is not supported here: use the printer's IPv4 address or host name";
      if (!HostRx.IsMatch(s)) return "address must be an IPv4 address (like 192.168.1.20) or a host name";
      return null;
    }

    /// A new printer's name: Windows refuses \ , and ! in printer names.
    static string NewNameProblem(object v) {
      string why = NameProblem(v, "name");
      if (why != null) return why;
      string s = (string)v;
      if (s.Length > 220) return "name is too long (220 characters at most)";
      if (s.IndexOfAny(new[] { '\\', ',', '!' }) >= 0) return "a printer name cannot contain \\ , or !";
      if (s.Trim().Length != s.Length) return "a printer name cannot start or end with a space";
      return null;
    }

    static List<string> Drivers(out string err) {
      err = null;
      int needed, returned;
      Native.EnumPrinterDrivers(null, null, 1, IntPtr.Zero, 0, out needed, out returned);
      var list = new List<string>();
      if (needed <= 0) {
        int e = Marshal.GetLastWin32Error();
        if (e != 0 && e != 122) err = "the print spooler did not list its drivers (" + Win32Words(e) + ")";
        return err == null ? list : null;
      }
      IntPtr buf = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.EnumPrinterDrivers(null, null, 1, buf, needed, out needed, out returned)) {
          err = "the print spooler did not list its drivers (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
          return null;
        }
        for (int i = 0; i < returned; i++) {
          IntPtr pName = Marshal.ReadIntPtr(new IntPtr(buf.ToInt64() + (long)i * IntPtr.Size));
          string n = Marshal.PtrToStringUni(pName);
          if (!string.IsNullOrEmpty(n) && !list.Contains(n)) list.Add(n);
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      list.Sort(StringComparer.CurrentCultureIgnoreCase);
      return list;
    }

    static List<string> Ports(out string err) {
      err = null;
      int needed, returned;
      Native.EnumPorts(null, 1, IntPtr.Zero, 0, out needed, out returned);
      var list = new List<string>();
      if (needed <= 0) {
        int e = Marshal.GetLastWin32Error();
        if (e != 0 && e != 122) err = "the print spooler did not list its ports (" + Win32Words(e) + ")";
        return err == null ? list : null;
      }
      IntPtr buf = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.EnumPorts(null, 1, buf, needed, out needed, out returned)) {
          err = "the print spooler did not list its ports (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
          return null;
        }
        for (int i = 0; i < returned; i++) {
          IntPtr pName = Marshal.ReadIntPtr(new IntPtr(buf.ToInt64() + (long)i * IntPtr.Size));
          string n = Marshal.PtrToStringUni(pName);
          if (!string.IsNullOrEmpty(n)) list.Add(n);
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return list;
    }

    static bool HasName(List<string> list, string s) {
      foreach (var x in list) if (string.Equals(x, s, StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    }

    static string AddNetwork(Dictionary<string, object> req, ref object result) {
      const string cmd = "printers.addNetwork";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      object path, address, name, driver;
      req.TryGetValue("path", out path);
      req.TryGetValue("address", out address);
      req.TryGetValue("name", out name);
      req.TryGetValue("driver", out driver);
      if (path != null && address != null) return cmd + ": give path (\\\\server\\printer) or address (an IP address), not both";
      if (path == null && address == null)
        return cmd + " needs path (a shared printer, \\\\server\\printer) or address (a network printer's IP address or host name)";
      bool passive = Program.Passive;
      if (path != null) {
        if (!(path is string) || !UncRx.IsMatch((string)path)) return cmd + ": path must look like \\\\server\\printer";
        if (name != null || driver != null) return cmd + ": a shared printer takes only path (its server names it and supplies the driver)";
        string unc = (string)path;
        Post(req, cmd, delegate (out object r) { return AddConnection(unc, dry, passive, out r); });
        result = Program.Deferred;
        return null;
      }
      why = AddressProblem(address);
      if (why != null) return cmd + ": " + why;
      if (name != null && (why = NewNameProblem(name)) != null) return cmd + ": " + why;
      if (driver != null && !(driver is string)) return cmd + ": driver must be a driver name from the dryRun's drivers";
      string addr = (string)address, nm = name as string, drv = driver as string;
      Post(req, cmd, delegate (out object r) { return AddTcpPlan(addr, nm, drv, dry, passive, out r); });
      result = Program.Deferred;
      return null;
    }

    static string AddConnection(string unc, bool dry, bool passive, out object r) {
      const string cmd = "printers.addNetwork";
      r = null;
      string err;
      var all = Enum(6, out err);
      if (all == null) return cmd + ": " + err;
      bool already = Find(all, unc) != null;
      string would = already ? "do nothing: this shared printer is already connected"
                             : "connect this user to the shared printer (AddPrinterConnection); Windows fetches its driver from the server";
      if (dry) {
        // The read the real add would do first: can this printer be opened at all?
        IntPtr h;
        bool reach = Native.OpenPrinterNoDefaults(unc, out h, IntPtr.Zero);
        int e = reach ? 0 : Marshal.GetLastWin32Error();
        if (reach) Native.ClosePrinter(h);
        r = Json.Obj("dryRun", true, "would", would, "route", "connection", "printer", unc, "already", already,
                     "reachable", reach, "needsAdmin", false,
                     "reason", reach ? null : "the shared printer did not answer (" + Win32Words(e) + ")");
        return null;
      }
      if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
      if (already) { r = Json.Obj("ok", true, "printer", unc, "route", "connection", "already", true, "reason", null); return null; }
      if (!Native.AddPrinterConnection(unc))
        return cmd + ": Windows did not connect to the shared printer (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
      Program.EmitLog("info", "printers: added a printer connection");
      r = Json.Obj("ok", true, "printer", unc, "route", "connection", "added", true, "reason", null);
      return null;
    }

    static string AddTcpPlan(string addr, string name, string driver, bool dry, bool passive, out object r) {
      const string cmd = "printers.addNetwork";
      r = null;
      string err;
      List<string> drivers = Drivers(out err);
      if (drivers == null) return cmd + ": " + err;
      List<string> ports = Ports(out err);
      if (ports == null) return cmd + ": " + err;
      var all = Enum(6, out err);
      if (all == null) return cmd + ": " + err;
      string port = "IP_" + addr;
      bool portExists = HasName(ports, port);
      string nm = name ?? driver;
      string problem = null;
      if (driver == null) problem = "pick a driver: one of drivers (Windows' own wizard asks the same)";
      else if (!HasName(drivers, driver)) problem = "no printer driver by that name is installed on this PC";
      else if (nm != null && Find(all, nm) != null) problem = "a printer by that name already exists: give another name";
      var elev = problem == null ? Json.Obj("action", "printers.addTcp", "args", Json.Obj("address", addr, "name", nm, "driver", driver)) : null;
      string would = problem != null ? "not add the printer yet: " + problem
                   : "add \"" + nm + "\" on a Standard TCP/IP port " + port + (portExists ? " (the port exists already)" : " (new, RAW 9100)") +
                     " with the installed driver, for every user, through one administrator prompt";
      var dl = new ArrayList();
      foreach (var d in drivers) dl.Add(d);
      if (dry) {
        r = Json.Obj("dryRun", true, "would", would, "route", "tcp", "address", addr, "port", port, "portExists", portExists,
                     "name", nm, "driver", driver, "drivers", dl, "needsAdmin", true, "elevate", elev,
                     "note", "Windows' wizard also probes the address (WSD / IPP / SNMP) to pick a driver; Mantle uses the driver you pick",
                     "reason", problem);
        return null;
      }
      if (passive) return FeatureTable.PassiveRefusal + ": " + cmd + " would " + would;
      if (problem != null) return cmd + ": " + problem;
      r = Json.Obj("ok", false, "route", "tcp", "needsAdmin", true, "elevate", elev,
                   "reason", "adding a printer by address needs an administrator: ask elevate for printers.addTcp {address, name, driver}; nothing was changed");
      return null;
    }

    [Elevated("printers.addTcp", "CheckAddTcp", "add a printer by its network address")]
    static string AddTcp(Dictionary<string, object> args, ref object result) {
      string addr = (string)args["address"], name = (string)args["name"], driver = (string)args["driver"];
      string port = "IP_" + addr;
      string err;
      var ports = Ports(out err);
      if (ports == null) return err;
      bool created = false;
      if (!HasName(ports, port)) {
        err = XcvPort(true, port, addr);
        if (err != null) return err;
        created = true;
      }
      var info = new Native.PRINTER_INFO_2();
      info.pPrinterName = name;
      info.pPortName = port;
      info.pDriverName = driver;
      info.pPrintProcessor = "winprint";
      info.pDatatype = "RAW";
      info.Priority = 1;
      IntPtr h = Native.AddPrinter(null, 2, ref info);
      if (h == IntPtr.Zero) {
        int e = Marshal.GetLastWin32Error();
        string undo = created ? XcvPort(false, port, addr) : null;
        return "Windows did not add the printer (" + Win32Words(e) + ")" +
               (created ? (undo == null ? "; the new port was removed again" : "; the new port " + port + " could not be removed (" + undo + ")") : "");
      }
      Native.ClosePrinter(h);
      result = Json.Obj("printer", name, "port", port, "portCreated", created, "driver", driver);
      return null;
    }

    static string CheckAddTcp(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "address", "name", "driver");
      if (why != null) return why;
      object a, n, d;
      if (!args.TryGetValue("address", out a)) return "an address is needed";
      why = AddressProblem(a);
      if (why != null) return why;
      if (!args.TryGetValue("name", out n)) return "a printer name is needed";
      why = NewNameProblem(n);
      if (why != null) return why;
      if (!args.TryGetValue("driver", out d) || !(d is string)) return "a driver name is needed";
      string err;
      var drivers = Drivers(out err);           // the known list: installed drivers only
      if (drivers == null) return err;
      if (!HasName(drivers, (string)d)) return "no printer driver by that name is installed on this PC";
      var all = Enum(6, out err);
      if (all == null) return err;
      if (Find(all, (string)n) != null) return "a printer by that name already exists";
      return null;
    }

    /// Adds (or removes) a Standard TCP/IP port through the port monitor's own XcvData interface.
    /// Needs SERVER_ACCESS_ADMINISTER, which only an administrator gets.
    static string XcvPort(bool add, string port, string addr) {
      var d = new Native.PRINTER_DEFAULTS();
      d.DesiredAccess = 1;   // SERVER_ACCESS_ADMINISTER
      IntPtr h;
      if (!Native.OpenPrinter(",XcvMonitor Standard TCP/IP Port", out h, ref d))
        return "Windows did not open the TCP/IP port monitor (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
      try {
        int needed, status;
        bool ok;
        if (add) {
          var pd = new Native.PORT_DATA_1();
          pd.sztPortName = port;
          pd.dwVersion = 1;
          pd.dwProtocol = 1;                 // PROTOCOL_RAWTCP_TYPE
          pd.cbSize = Marshal.SizeOf(typeof(Native.PORT_DATA_1));
          pd.sztHostAddress = addr;
          pd.sztSNMPCommunity = "public";
          pd.sztQueue = "";
          pd.sztIPAddress = "";
          pd.Reserved = new byte[540];
          pd.dwPortNumber = 9100;
          ok = Native.XcvData(h, "AddPort", ref pd, pd.cbSize, IntPtr.Zero, 0, out needed, out status);
        } else {
          var dd = new Native.DELETE_PORT_DATA_1();
          dd.psztPortName = port;
          dd.Reserved = new byte[98];
          dd.dwVersion = 1;
          ok = Native.XcvDataDelete(h, "DeletePort", ref dd, Marshal.SizeOf(typeof(Native.DELETE_PORT_DATA_1)),
                                    IntPtr.Zero, 0, out needed, out status);
        }
        if (!ok) return "the port monitor refused (" + Win32Words(Marshal.GetLastWin32Error()) + ")";
        if (status != 0) return "the port monitor answered " + Win32Words(status);
        return null;
      } finally {
        Native.ClosePrinter(h);
      }
    }

    // ------------------------------------------------------------------ Win32

    static class Native {
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct PRINTER_INFO_2 {
        public string pServerName, pPrinterName, pShareName, pPortName, pDriverName, pComment, pLocation;
        public IntPtr pDevMode;
        public string pSepFile, pPrintProcessor, pDatatype, pParameters;
        public IntPtr pSecurityDescriptor;
        public int Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs, AveragePPM;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct SYSTEMTIME {
        public short wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
      }

      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct JOB_INFO_2 {
        public int JobId;
        public string pPrinterName, pMachineName, pUserName, pDocument, pNotifyName, pDatatype, pPrintProcessor,
                      pParameters, pDriverName;
        public IntPtr pDevMode;
        public string pStatus;
        public IntPtr pSecurityDescriptor;
        public int Status, Priority, Position, StartTime, UntilTime, TotalPages, Size;
        public SYSTEMTIME Submitted;
        public int Time, PagesPrinted;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct PRINTER_DEFAULTS {
        public IntPtr pDatatype, pDevMode;
        public int DesiredAccess;
      }

      // tcpxcv.h
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct PORT_DATA_1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string sztPortName;
        public int dwVersion, dwProtocol, cbSize, dwReserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 49)] public string sztHostAddress;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string sztSNMPCommunity;
        public int dwDoubleSpool;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string sztQueue;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 16)] public string sztIPAddress;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 540)] public byte[] Reserved;
        public int dwPortNumber, dwSNMPEnabled, dwSNMPDevIndex;
      }

      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct DELETE_PORT_DATA_1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string psztPortName;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 98)] public byte[] Reserved;
        public int dwVersion, dwReserved;
      }

      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "EnumPrintersW")]
      public static extern bool EnumPrinters(int flags, string name, int level, IntPtr buf, int cb, out int needed, out int returned);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetDefaultPrinterW")]
      public static extern bool GetDefaultPrinter(StringBuilder buf, ref int size);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SetDefaultPrinterW")]
      public static extern bool SetDefaultPrinter(string name);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenPrinterW")]
      public static extern bool OpenPrinter(string name, out IntPtr h, ref PRINTER_DEFAULTS defaults);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenPrinterW")]
      public static extern bool OpenPrinterNoDefaults(string name, out IntPtr h, IntPtr defaults);
      [DllImport("winspool.drv", SetLastError = true)]
      public static extern bool ClosePrinter(IntPtr h);
      [DllImport("winspool.drv", SetLastError = true)]
      public static extern bool DeletePrinter(IntPtr h);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "DeletePrinterConnectionW")]
      public static extern bool DeletePrinterConnection(string name);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "AddPrinterConnectionW")]
      public static extern bool AddPrinterConnection(string name);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "EnumJobsW")]
      public static extern bool EnumJobs(IntPtr h, int first, int count, int level, IntPtr buf, int cb, out int needed, out int returned);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetJobW")]
      public static extern bool GetJob(IntPtr h, int job, int level, IntPtr buf, int cb, out int needed);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SetJobW")]
      public static extern bool SetJob(IntPtr h, int job, int level, IntPtr info, int command);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "EnumPrinterDriversW")]
      public static extern bool EnumPrinterDrivers(string server, string env, int level, IntPtr buf, int cb, out int needed, out int returned);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "EnumPortsW")]
      public static extern bool EnumPorts(string server, int level, IntPtr buf, int cb, out int needed, out int returned);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "AddPrinterW")]
      public static extern IntPtr AddPrinter(string server, int level, ref PRINTER_INFO_2 info);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "XcvDataW")]
      public static extern bool XcvData(IntPtr h, string dataName, ref PORT_DATA_1 input, int cbInput, IntPtr output, int cbOutput,
                                        out int needed, out int status);
      [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "XcvDataW")]
      public static extern bool XcvDataDelete(IntPtr h, string dataName, ref DELETE_PORT_DATA_1 input, int cbInput, IntPtr output,
                                              int cbOutput, out int needed, out int status);
      [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SendNotifyMessageW")]
      public static extern bool SendNotifyMessage(IntPtr hwnd, int msg, IntPtr wParam, string lParam);
    }
  }
}
