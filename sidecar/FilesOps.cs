// FilesOps.cs - Mantle Files' WRITES: files.op (copy, move, recycle, delete, rename, newfolder,
// newfile) and the Recycle Bin (list, restore, purge, empty) (lane files, 2026-09-28).
//
// WHY IFileOperation and not File.Copy: it is the engine Explorer itself uses, so Mantle gets
// Windows' own behaviour for free - UAC elevation for a protected folder, the conflict dialog,
// "New folder (2)", the Recycle Bin, cross-volume moves, long paths - and an
// IFileOperationProgressSink that reports every item as it lands. Each job runs on a NEW STA
// thread (the engine is apartment-threaded and pumps while it works) and the command answers
// {job, started} at once; progress is pushed as files.progress (throttled to ~10/s) and the end
// as files.opdone with one result per top-level item. Cancel = the sink answers
// HRESULT_FROM_WIN32(ERROR_CANCELLED) at its next callback.
//
// SAFETY: every path an op touches goes through FilesGuard first, and the op uses the NORMALISED
// path the guard checked. Recycle always carries FOF_WANTNUKEWARNING: an item that cannot be
// recycled (a network share, an oversize file) makes Windows ASK before destroying it, never
// silently. Permanent delete, purge and empty require confirmed:true.
//
// Passive (tests) adds FOF_NOERRORUI and refuses conflict:'ask' when a clash exists: a Windows
// dialog would sit modal on Owen's screen with the test waiting behind it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using FN = Mantle.FilesNative;

namespace Mantle {
  [MantleFeature]
  static class FilesOps {
    public static void Register(FeatureTable t) {
      t.Add("files.op", Lanes.Slow, Files.Safe("files.op", Op));
      t.Add("files.recycle.list", Lanes.Slow, Files.Safe("files.recycle.list", BinList));
      t.Add("files.recycle.restore", Lanes.Slow, Files.Safe("files.recycle.restore", BinRestore));
      t.Add("files.recycle.purge", Lanes.Slow, Files.Safe("files.recycle.purge", BinPurge));
      t.Add("files.recycle.empty", Lanes.Slow, Files.Safe("files.recycle.empty", BinEmpty));
    }

    const uint FOF_SILENT = 0x4, FOF_RENAMEONCOLLISION = 0x8, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40,
               FOF_NOCONFIRMMKDIR = 0x200, FOF_NOERRORUI = 0x400, FOF_WANTNUKEWARNING = 0x4000,
               FOFX_RECYCLEONDELETE = 0x00080000;
    const int E_CANCELLED = unchecked((int)0x800704C7);
    const int COPYENGINE_S_USER_IGNORED = 0x00270005;
    const int MaxItems = 100000;

    sealed class OpItem {
      public string Src, Dest, Name;     // Dest = target folder (copy/move/new/restore), Name = new name or null
      public string Dst, Key, Why;
      public int Hr;
      public bool Seen, Ok, Skipped;
    }

    sealed class OpJob {
      public FilesJob Job;
      public string Op;
      public List<OpItem> Items = new List<OpItem>();
      public uint Flags;
      public IntPtr Owner;
      public bool Bin;                   // restore / purge: Src is a Recycle Bin key
    }

    // ------------------------------------------------------------------ files.op

    static string Op(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op");
      string dest = Json.GetString(req, "dest");
      string name = Json.GetString(req, "name");
      string conflict = Json.GetString(req, "conflict") ?? "ask";
      bool confirmed = Json.GetBool(req, "confirmed", false);
      if (conflict != "ask" && conflict != "replace" && conflict != "keepboth" && conflict != "skip")
        return "files.op: conflict must be ask, replace, keepboth or skip";
      var oj = new OpJob();
      oj.Op = op;
      oj.Owner = Json.GetHwnd(req, "owner");
      var touched = new List<string>();
      object raw;
      Json.TryGet(req, "items", out raw);
      var rawItems = raw as IEnumerable;
      if (raw is string) rawItems = null;

      switch (op) {
        case "copy": case "move":
          if (rawItems == null) return "files.op " + op + " needs items";
          foreach (object o in rawItems) {
            var it = new OpItem();
            var d = o as Dictionary<string, object>;
            if (d != null) { it.Src = Json.GetString(d, "src"); it.Dest = Json.GetString(d, "dest") ?? dest; it.Name = Json.GetString(d, "name"); }
            else { it.Src = o as string; it.Dest = dest; }
            if (it.Src == null || it.Dest == null) return "files.op " + op + ": every item needs a source and a dest folder";
            if (it.Name != null && !FilesGuard.PlainName(it.Name)) return "files.op " + op + ": " + FilesGuard.NameProblem(it.Name);
            oj.Items.Add(it);
          }
          break;
        case "recycle": case "delete":
          if (op == "delete" && !confirmed) return "files.op delete is permanent and needs confirmed:true";
          if (rawItems == null) return "files.op " + op + " needs items";
          foreach (object o in rawItems) {
            var s = o as string;
            if (s == null) return "files.op " + op + ": items must be paths";
            var it = new OpItem(); it.Src = s; oj.Items.Add(it);
          }
          break;
        case "rename": {
          // items:[one path] + name, or rename many: items:[{src, name}, ...] (one job, one undo)
          if (rawItems == null) return "files.op rename needs items:[one path] or items:[{src, name}]";
          bool many = false;
          foreach (object o in rawItems) {
            var it = new OpItem();
            var d = o as Dictionary<string, object>;
            if (d != null) { it.Src = Json.GetString(d, "src"); it.Name = Json.GetString(d, "name"); many = true; }
            else { it.Src = o as string; it.Name = name; }
            oj.Items.Add(it);
          }
          if (!many && oj.Items.Count != 1) return "files.op rename takes exactly one path (or items:[{src, name}])";
          foreach (OpItem it in oj.Items) {
            if (it.Src == null) return "files.op rename: every item needs its path";
            if (!FilesGuard.PlainName(it.Name)) return "files.op rename: " + FilesGuard.NameProblem(it.Name);
          }
          break;
        }
        case "newfolder": case "newfile": {
          if (dest == null) return "files.op " + op + " needs dest: the parent folder";
          if (!FilesGuard.PlainName(name)) return "files.op " + op + ": " + FilesGuard.NameProblem(name);
          var it = new OpItem(); it.Dest = dest; it.Name = name; oj.Items.Add(it);
          break;
        }
        default:
          return "files.op: op must be copy, move, recycle, delete, rename, newfolder or newfile";
      }
      if (oj.Items.Count == 0) return "files.op " + op + ": no items";
      if (oj.Items.Count > MaxItems) return "files.op " + op + ": too many items";

      // Every path the op touches, in a fixed order per item, so the normalised list maps back.
      foreach (OpItem it in oj.Items) {
        if (op == "copy" || op == "move") {
          touched.Add(it.Src); touched.Add(it.Dest);
          touched.Add(Join(it.Dest, it.Name ?? LeafName(it.Src)));
        } else if (op == "recycle" || op == "delete") {
          touched.Add(it.Src);
        } else if (op == "rename") {
          // The new name's parent comes from the NORMALISED source (a raw "C:/x/../y" or a path
          // past 260 characters would give Path.GetDirectoryName the wrong answer or an exception).
          string ns = FilesGuard.Normalise(it.Src);
          touched.Add(it.Src);
          touched.Add(ns == null ? null : Join(FilesGuard.Parent(ns), it.Name));
        } else {
          touched.Add(it.Dest); touched.Add(Join(it.Dest, it.Name));
        }
      }
      List<string> full;
      string gerr = FilesGuard.Check(touched, out full);
      if (gerr != null) return gerr;
      int k = 0;
      foreach (OpItem it in oj.Items) {
        if (op == "copy" || op == "move") { it.Src = full[k]; it.Dest = full[k + 1]; k += 3; }
        else if (op == "recycle" || op == "delete") { it.Src = full[k]; k += 1; }
        else if (op == "rename") { it.Src = full[k]; it.Dst = full[k + 1]; k += 2; }
        else { it.Dest = full[k]; k += 2; }
      }

      // Rename onto a DIFFERENT existing item: the engine would open Windows' replace dialog (on a
      // test sidecar that is a modal on Owen's screen; live it offers to overwrite the other file).
      // Refused up front, in words, like File Explorer's own "already exists". A case-only rename
      // (a.txt -> A.txt) is the same item and goes ahead.
      if (op == "rename") {
        foreach (OpItem it in oj.Items) {
          bool same = string.Equals(it.Dst, it.Src, StringComparison.OrdinalIgnoreCase);
          if (!same && FilesGuard.Attrs(it.Dst) != FN.INVALID_FILE_ATTRIBUTES)
            return "files.op rename: a file or folder with that name already exists there (0x800700B7)";
          it.Dst = null;
        }
      }

      uint flags = FOF_SILENT | FOF_NOCONFIRMMKDIR;
      if (op == "copy" || op == "move") {
        if (conflict == "replace") flags |= FOF_NOCONFIRMATION;
        else if (conflict == "keepboth") flags |= FOF_RENAMEONCOLLISION;
        // A replace onto an existing FOLDER merges into it: in passive the whole existing tree it
        // writes into must be free of links (FilesGuard.CheckSubtree; proven hole 2026-09-29).
        if (conflict == "replace" && Program.Passive) {
          foreach (OpItem it in oj.Items) {
            string dst = Join(it.Dest, it.Name ?? LeafName(it.Src));
            uint da = FilesGuard.Attrs(dst);
            if (da == FN.INVALID_FILE_ATTRIBUTES || (da & FN.FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
            string serr = FilesGuard.CheckSubtree(dst);
            if (serr != null) return serr;
          }
        }
        if (conflict == "skip" || (conflict == "ask" && Program.Passive)) {
          int clashes = 0;
          foreach (OpItem it in oj.Items) {
            string dst = Join(it.Dest, it.Name ?? LeafName(it.Src));
            if (string.Equals(dst, it.Src, StringComparison.OrdinalIgnoreCase)) continue;
            if (FilesGuard.Attrs(dst) == FN.INVALID_FILE_ATTRIBUTES) continue;
            clashes++;
            if (conflict == "skip") { it.Skipped = true; it.Dst = dst; it.Why = "skipped: already exists"; }
          }
          if (conflict == "ask" && clashes > 0)
            return FeatureTable.PassiveRefusal + ": conflict 'ask' would open a Windows dialog (" + clashes +
                   " clashes), which a test sidecar never does";
        }
      } else if (op == "recycle") {
        flags |= FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING;
      } else if (op == "delete") {
        flags |= FOF_NOCONFIRMATION;       // Mantle already asked: that is what confirmed:true says
      } else if (op == "newfolder" || op == "newfile") {
        flags |= FOF_RENAMEONCOLLISION;
      }
      if (Program.Passive) flags |= FOF_NOERRORUI;
      oj.Flags = flags;
      return StartJob(req, oj, ref result);
    }

    static string StartJob(Dictionary<string, object> req, OpJob oj, ref object result) {
      string err;
      oj.Job = FilesJobs.Start(req, "op", out err);
      if (oj.Job == null) return err;
      var t = new Thread(delegate () {
        try { Run(oj); }
        catch (Exception ex) { Finish(oj, Marshal.GetHRForException(ex), false, "the operation failed (" + ex.GetType().Name + ")"); }
        finally { FilesJobs.End(oj.Job); }
      });
      t.IsBackground = true;
      t.Name = "mantle-files-op";
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      result = Json.Obj("job", oj.Job.Raw, "started", true);
      return null;
    }

    static string Join(string dir, string name) {
      if (dir == null || name == null) return null;
      return dir.EndsWith("\\", StringComparison.Ordinal) ? dir + name : dir + "\\" + name;
    }
    static string LeafName(string p) {
      if (p == null) return null;
      string t = p.Length > 3 ? p.TrimEnd('\\', '/') : p;
      string n = Path.GetFileName(t);
      return string.IsNullOrEmpty(n) ? null : n;
    }
    static string ParentOf(string p) {
      try { return Path.GetDirectoryName(p.Length > 3 ? p.TrimEnd('\\', '/') : p); } catch (Exception) { return null; }
    }

    /// The op thread: queue every item on one IFileOperation, run it, collect the sink's results.
    static void Run(OpJob oj) {
      FN.IFileOperation fo = null;
      uint cookie = 0;
      var sink = new Sink(oj);
      int hr = 0;
      bool aborted = false;
      var held = new List<object>();
      Dictionary<string, FN.IShellItem> bin = oj.Bin ? BinItems(held) : null;
      try {
        fo = (FN.IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(FN.CLSID_FileOperation));
        hr = fo.SetOperationFlags(oj.Flags);
        if (hr != 0) { Finish(oj, hr, false, null); return; }
        if (oj.Owner != IntPtr.Zero) fo.SetOwnerWindow(oj.Owner);
        fo.Advise(sink, out cookie);
        int queued = 0;
        foreach (OpItem it in oj.Items) {
          if (it.Skipped) continue;
          int ihr = 0;
          FN.IShellItem si = null, di = null;
          if (oj.Bin) {
            // Dest == null: the key was not in the bin when the guard ran, so it was never checked
            // and is never touched, even if it has appeared since.
            if (it.Dest == null || !bin.TryGetValue(it.Src, out si)) {
              it.Hr = unchecked((int)0x80070002); it.Why = "not in the Recycle Bin"; continue;
            }
          } else if (it.Src != null) {
            si = FN.ItemFromPath(it.Src, out ihr);
            if (si == null) { it.Hr = ihr; it.Why = FN.HrWords(ihr); continue; }
            held.Add(si);
          }
          if (oj.Op == "copy" || oj.Op == "move" || oj.Op == "restore" || oj.Op == "newfolder" || oj.Op == "newfile") {
            if (oj.Op == "restore" && !Directory.Exists(it.Dest)) {
              // Explorer recreates a deleted original folder on restore; so does Mantle (the guard
              // already cleared this path).
              try { Directory.CreateDirectory(it.Dest); } catch (Exception) { }
            }
            di = FN.ItemFromPath(it.Dest, out ihr);
            if (di == null) { it.Hr = ihr; it.Why = "the destination folder: " + FN.HrWords(ihr); continue; }
            held.Add(di);
          }
          switch (oj.Op) {
            case "copy": ihr = fo.CopyItem(si, di, it.Name, null); break;
            case "move": case "restore": ihr = fo.MoveItem(si, di, it.Name, null); break;
            case "recycle": case "delete": case "purge": ihr = fo.DeleteItem(si, null); break;
            case "rename": ihr = fo.RenameItem(si, it.Name, null); break;
            case "newfolder": ihr = fo.NewItem(di, FN.FILE_ATTRIBUTE_DIRECTORY, it.Name, null, null); break;
            case "newfile": ihr = fo.NewItem(di, FN.FILE_ATTRIBUTE_NORMAL, it.Name, null, null); break;
          }
          if (ihr != 0) { it.Hr = ihr; it.Why = FN.HrWords(ihr); continue; }
          sink.Expect(it, si);
          queued++;
        }
        if (queued > 0) {
          hr = fo.PerformOperations();
          fo.GetAnyOperationsAborted(out aborted);
        }
      } finally {
        if (fo != null && cookie != 0) { try { fo.Unadvise(cookie); } catch (Exception) { } }
        FN.Release(fo);
        foreach (object o in held) FN.Release(o);
      }
      Finish(oj, hr, aborted, null);
    }

    static void Finish(OpJob oj, int hr, bool aborted, string reason) {
      bool cancelled = oj.Job.Cancelled || hr == E_CANCELLED;
      int failed = 0, skipped = 0, total = 0;
      var results = new List<object>();
      foreach (OpItem it in oj.Items) {
        total++;
        if (it.Skipped) skipped++;
        else if (!it.Seen && it.Why == null) {
          it.Ok = false;
          it.Why = cancelled ? "cancelled" : aborted ? "not done: the operation was aborted" : "not done";
        }
        if (!it.Ok && !it.Skipped) failed++;
        results.Add(Json.Obj("src", oj.Op == "newfolder" || oj.Op == "newfile" ? null : it.Src, "dst", it.Dst,
                             "ok", it.Ok, "hr", it.Hr, "why", it.Why, "key", it.Key));
      }
      bool ok = hr >= 0 && !aborted && !cancelled && failed == 0 && reason == null;
      if (!ok && reason == null) {
        if (cancelled) reason = "cancelled";
        else if (failed > 0) reason = failed + " of " + total + " items failed";
        else if (hr < 0) reason = FN.HrWords(hr);
        else reason = "the operation was aborted";
      }
      var o = Json.Obj("job", oj.Job.Raw, "op", oj.Op, "ok", ok, "hr", hr, "reason", reason, "aborted", aborted || cancelled,
                       "results", results);
      if (skipped > 0) o["skipped"] = skipped;
      Features.Event("files.opdone", o);
    }

    /// Hears the engine. Top-level items are matched by their parsing name; the engine also
    /// reports every file inside a copied folder, and those only count toward progress.
    sealed class Sink : FN.IFileOperationProgressSink {
      readonly OpJob _oj;
      readonly Dictionary<string, OpItem> _bySrc = new Dictionary<string, OpItem>(StringComparer.OrdinalIgnoreCase);
      readonly List<OpItem> _news = new List<OpItem>();
      int _done;
      string _current;
      uint _total, _soFar;
      long _lastEmit;

      public Sink(OpJob oj) { _oj = oj; }

      public void Expect(OpItem it, FN.IShellItem si) {
        if (it.Src == null) { _news.Add(it); return; }
        string key = FN.ItemName(si, FN.SIGDN_DESKTOPABSOLUTEPARSING) ?? it.Src;
        _bySrc[key] = it;
        if (!_bySrc.ContainsKey(it.Src)) _bySrc[it.Src] = it;
      }

      int Go() { return _oj.Job.Cancelled ? E_CANCELLED : 0; }

      void Landed(FN.IShellItem item, int hr, FN.IShellItem created, bool isNew) {
        OpItem it = null;
        if (isNew) { foreach (OpItem n in _news) if (!n.Seen) { it = n; break; } }
        else {
          string p = FN.ItemName(item, FN.SIGDN_DESKTOPABSOLUTEPARSING);
          if (p != null) _bySrc.TryGetValue(p, out it);
        }
        if (it == null || it.Seen) return;
        it.Seen = true;
        it.Hr = hr;
        it.Ok = hr >= 0 && hr != COPYENGINE_S_USER_IGNORED;
        if (hr == COPYENGINE_S_USER_IGNORED) it.Why = "skipped";
        else if (hr < 0) it.Why = FN.HrWords(hr);
        if (created != null) {
          string c = FN.ItemName(created, FN.SIGDN_DESKTOPABSOLUTEPARSING);
          if (_oj.Op == "recycle") it.Key = c;
          else it.Dst = c;
        }
        _done++;
        Progress(true);
      }

      void Starting(FN.IShellItem item) {
        string n = FN.ItemName(item, FN.SIGDN_NORMALDISPLAY);
        if (n != null) _current = n;
      }

      /// ~10 events a second at most; the last item always gets one so the bar reaches the end.
      void Progress(bool itemLanded) {
        long now = Stopwatch.GetTimestamp();
        bool last = itemLanded && _done >= _oj.Items.Count;
        if (!last && (now - _lastEmit) * 1000L / Stopwatch.Frequency < 100) return;
        _lastEmit = now;
        // `item` is the current NAME, for the page only: events are never logged.
        Features.Event("files.progress", Json.Obj("job", _oj.Job.Raw, "op", _oj.Op, "done", (long)_soFar, "total", (long)_total,
                                                  "items", _done, "itemsTotal", _oj.Items.Count, "item", _current));
      }

      public int StartOperations() { return Go(); }
      public int FinishOperations(int hr) { return 0; }
      public int PreRenameItem(uint f, FN.IShellItem item, string n) { Starting(item); return Go(); }
      public int PostRenameItem(uint f, FN.IShellItem item, string n, int hr, FN.IShellItem created) { Landed(item, hr, created, false); return Go(); }
      public int PreMoveItem(uint f, FN.IShellItem item, FN.IShellItem d, string n) { Starting(item); return Go(); }
      public int PostMoveItem(uint f, FN.IShellItem item, FN.IShellItem d, string n, int hr, FN.IShellItem created) { Landed(item, hr, created, false); return Go(); }
      public int PreCopyItem(uint f, FN.IShellItem item, FN.IShellItem d, string n) { Starting(item); return Go(); }
      public int PostCopyItem(uint f, FN.IShellItem item, FN.IShellItem d, string n, int hr, FN.IShellItem created) { Landed(item, hr, created, false); return Go(); }
      public int PreDeleteItem(uint f, FN.IShellItem item) { Starting(item); return Go(); }
      public int PostDeleteItem(uint f, FN.IShellItem item, int hr, FN.IShellItem created) { Landed(item, hr, created, false); return Go(); }
      public int PreNewItem(uint f, FN.IShellItem d, string n) { _current = n; return Go(); }
      public int PostNewItem(uint f, FN.IShellItem d, string n, string t, uint a, int hr, FN.IShellItem created) { Landed(null, hr, created, true); return Go(); }
      public int UpdateProgress(uint total, uint soFar) { _total = total; _soFar = soFar; Progress(false); return Go(); }
      public int ResetTimer() { return 0; }
      public int PauseTimer() { return 0; }
      public int ResumeTimer() { return 0; }
    }

    // ------------------------------------------------------------------ Recycle Bin

    /// PKEYs the bin's shell folder answers (its GetDetailsEx columns, via IShellItem2).
    static readonly Guid FmtidDisplaced = new Guid("9B174B33-40FF-11D2-A27E-00C04FC30871");
    static readonly Guid FmtidStorage = new Guid("B725F130-47EF-101A-A5F1-02608C9EEBAC");
    const uint SFGAO_STREAM = 0x00400000;

    sealed class BinEntry { public string Key, Name, Orig; public long Del, Size; public bool Dir; }

    /// Every bin item by key (its parsing name), each IShellItem also added to `held` for release.
    static Dictionary<string, FN.IShellItem> BinItems(List<object> held) {
      var map = new Dictionary<string, FN.IShellItem>(StringComparer.OrdinalIgnoreCase);
      object o;
      Guid fid = FN.FOLDERID_RecycleBinFolder, iid = FN.IID_IShellItem;
      if (FN.SHGetKnownFolderItem(ref fid, 0, IntPtr.Zero, ref iid, out o) != 0 || o == null) return map;
      held.Add(o);
      var binFolder = (FN.IShellItem)o;
      object eo;
      Guid bhid = FN.BHID_EnumItems, eiid = FN.IID_IEnumShellItems;
      if (binFolder.BindToHandler(IntPtr.Zero, ref bhid, ref eiid, out eo) != 0 || eo == null) return map;
      held.Add(eo);
      var en = (FN.IEnumShellItems)eo;
      FN.IShellItem child;
      uint got;
      while (en.Next(1, out child, out got) == 0 && got == 1 && child != null) {
        held.Add(child);
        string key = FN.ItemName(child, FN.SIGDN_DESKTOPABSOLUTEPARSING);
        if (key != null && !map.ContainsKey(key)) map[key] = child;
      }
      return map;
    }

    /// The original full path and deletion time. A local bin item's $I twin (same name, $I for
    /// $R) holds both exactly; otherwise the bin folder's own columns are asked.
    static BinEntry Describe(string key, FN.IShellItem si) {
      var e = new BinEntry();
      e.Key = key;
      uint attrs;
      if (si.GetAttributes(FN.SFGAO_FOLDER | SFGAO_STREAM, out attrs) >= 0)
        e.Dir = (attrs & FN.SFGAO_FOLDER) != 0 && (attrs & SFGAO_STREAM) == 0;
      string origFull = null;
      try {
        string leaf = Path.GetFileName(key);
        if (leaf.StartsWith("$R", StringComparison.OrdinalIgnoreCase)) {
          string info = Path.Combine(Path.GetDirectoryName(key), "$I" + leaf.Substring(2));
          byte[] b = File.ReadAllBytes(info);
          if (b.Length >= 24) {
            long ver = BitConverter.ToInt64(b, 0);
            e.Size = BitConverter.ToInt64(b, 8);
            e.Del = FN.FtMs(BitConverter.ToInt64(b, 16));
            if (ver == 2 && b.Length >= 28) {
              int n = BitConverter.ToInt32(b, 24);
              if (n > 0 && 28 + n * 2 <= b.Length) origFull = Encoding.Unicode.GetString(b, 28, n * 2).TrimEnd('\0');
            } else if (ver == 1 && b.Length >= 24 + 520) {
              origFull = Encoding.Unicode.GetString(b, 24, 520).TrimEnd('\0');
            }
          }
        }
      } catch (Exception) { origFull = null; }
      if (!string.IsNullOrEmpty(origFull)) {
        e.Orig = Path.GetDirectoryName(origFull);
        e.Name = Path.GetFileName(origFull);
        return e;
      }
      var s2 = si as FN.IShellItem2;
      if (s2 != null) {
        var pk = new FN.PROPERTYKEY(FmtidDisplaced, 2);
        IntPtr p;
        if (s2.GetString(ref pk, out p) == 0 && p != IntPtr.Zero) { e.Orig = Marshal.PtrToStringUni(p); FN.CoTaskMemFree(p); }
        pk = new FN.PROPERTYKEY(FmtidDisplaced, 3);
        long ft;
        if (s2.GetFileTime(ref pk, out ft) == 0) e.Del = FN.FtMs(ft);
        pk = new FN.PROPERTYKEY(FmtidStorage, 12);
        ulong sz;
        if (s2.GetUInt64(ref pk, out sz) == 0) e.Size = (long)sz;
        pk = new FN.PROPERTYKEY(FmtidStorage, 10);   // PKEY_ItemNameDisplay
        if (s2.GetString(ref pk, out p) == 0 && p != IntPtr.Zero) { e.Name = Marshal.PtrToStringUni(p); FN.CoTaskMemFree(p); }
      }
      if (e.Name == null) e.Name = FN.ItemName(si, FN.SIGDN_NORMALDISPLAY);
      return e;
    }

    static string BinList(Dictionary<string, object> req, ref object result) {
      result = FilesDefer.Run(req, "mantle-files-bin", delegate (out object res) {
        var held = new List<object>();
        try {
          var items = new List<object>();
          long bytes = 0;
          foreach (KeyValuePair<string, FN.IShellItem> kv in BinItems(held)) {
            BinEntry e = Describe(kv.Key, kv.Value);
            bytes += e.Size;
            items.Add(Json.Obj("key", e.Key, "n", e.Name, "orig", e.Orig, "del", e.Del, "s", e.Size, "d", e.Dir ? 1 : 0));
          }
          res = Json.Obj("items", items, "count", items.Count, "bytes", bytes);
          return null;
        } finally { foreach (object o in held) FN.Release(o); }
      });
      return null;
    }

    /// Restore and purge touch the item's ORIGINAL location, so that is what the guard checks.
    /// The bin is read here, on the Slow lane (an STA), so a refusal is this command's own error.
    static string BinJob(Dictionary<string, object> req, string op, ref object result) {
      List<string> keys = FN.StringList(req, "keys");
      if (keys.Count == 0) return "files.recycle." + op + " needs keys";
      if (keys.Count > MaxItems) return "files.recycle." + op + ": too many keys";
      var oj = new OpJob();
      oj.Op = op; oj.Bin = true; oj.Owner = Json.GetHwnd(req, "owner");
      var held = new List<object>();
      var touched = new List<string>();
      try {
        Dictionary<string, FN.IShellItem> bin = BinItems(held);
        foreach (string key in keys) {
          var it = new OpItem();
          it.Src = key;
          FN.IShellItem si;
          if (bin.TryGetValue(key, out si)) {
            BinEntry e = Describe(key, si);
            if (e.Orig == null || e.Name == null) return "files.recycle." + op + ": an item's original location could not be read";
            it.Dest = e.Orig; it.Name = e.Name;
            touched.Add(Join(e.Orig, e.Name));
          }
          oj.Items.Add(it);
        }
      } finally { foreach (object o in held) FN.Release(o); }
      if (touched.Count > 0 || Program.Passive) {
        List<string> full;
        string gerr = FilesGuard.Check(touched, out full);
        if (gerr != null) return gerr;
        if (Program.Passive && touched.Count == 0) return FilesGuard.Refusal + " (no key is in the Recycle Bin)";
        // The op uses the normalised path the guard checked, never the raw one.
        int k = 0;
        foreach (OpItem it in oj.Items) {
          if (it.Dest == null) continue;
          it.Dest = Path.GetDirectoryName(full[k]); it.Name = Path.GetFileName(full[k]); k++;
        }
      }
      oj.Flags = FOF_SILENT | FOF_NOCONFIRMMKDIR | FOF_NOCONFIRMATION;
      if (Program.Passive) oj.Flags |= FOF_NOERRORUI;
      return StartJob(req, oj, ref result);
    }

    static string BinRestore(Dictionary<string, object> req, ref object result) {
      return BinJob(req, "restore", ref result);
    }

    static string BinPurge(Dictionary<string, object> req, ref object result) {
      if (!Json.GetBool(req, "confirmed", false)) return "files.recycle.purge is permanent and needs confirmed:true";
      return BinJob(req, "purge", ref result);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHEmptyRecycleBinW(IntPtr hwnd, string root, uint flags);
    const uint SHERB_NOCONFIRMATION = 0x1;

    static string BinEmpty(Dictionary<string, object> req, ref object result) {
      string refuse = FilesGuard.AlwaysRefusedInPassive("files.recycle.empty (it would empty the real Recycle Bin)");
      if (refuse != null) return refuse;
      if (!Json.GetBool(req, "confirmed", false)) return "files.recycle.empty is permanent and needs confirmed:true";
      if (!Json.HasKey(req, "job")) req["job"] = "empty-" + Stopwatch.GetTimestamp();
      string err;
      FilesJob job = FilesJobs.Start(req, "empty", out err);
      if (job == null) return err;
      IntPtr owner = Json.GetHwnd(req, "owner");
      var t = new Thread(delegate () {
        int hr;
        try { hr = SHEmptyRecycleBinW(owner, null, SHERB_NOCONFIRMATION); }
        catch (Exception ex) { hr = Marshal.GetHRForException(ex); }
        finally { FilesJobs.End(job); }
        // E_UNEXPECTED is what an ALREADY empty bin answers: that is success.
        bool ok = hr >= 0 || hr == unchecked((int)0x8000FFFF);
        Features.Event("files.opdone", Json.Obj("job", job.Raw, "op", "empty", "ok", ok, "hr", hr,
                                                "reason", ok ? null : FN.HrWords(hr), "aborted", hr == E_CANCELLED,
                                                "results", new List<object>()));
      });
      t.IsBackground = true;
      t.Name = "mantle-files-empty";
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      result = Json.Obj("job", job.Raw, "started", true);
      return null;
    }
  }
}
