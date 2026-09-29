// FilesThumbs.cs - files.thumbs: real thumbnails (and per-FILE icons) for Mantle Files, rendered
// by the shell's IShellItemImageFactory on two STA workers of its own (lane files, 2026-09-28).
//
// WHY its own workers: a thumbnail can take 5-200 ms (a cold video frame far more), and on the
// Slow lane that would hold up every icon load and launch behind a folder of photos. The command
// answers Program.Deferred; the workers take items one at a time from one queue (so two calls
// share both workers) and the worker that finishes a call's LAST item replies, in request order.
//
// WHY a watchdog: a broken thumbnail provider (a codec pack, a corrupt file) can hang GetImage
// forever, and a hung worker would leave every later call unanswered. An item stuck for 8 s is
// answered with a `why`, its worker is abandoned (it is a background thread; it exits if the
// provider ever returns) and a fresh worker takes its place.
//
// Alpha: the factory hands back a 32bpp DIB whose bits are read directly (Bitmap.FromHbitmap
// would drop alpha). The contract expected PREMULTIPLIED bits; MEASURED 2026-09-28 on this
// Windows 11 build they are STRAIGHT alpha, for thumbnails and icons alike: a (0,0,100) pixel at
// alpha 128 came back as 197 when un-premultiplied, and all 48 half-transparent edge pixels of
// the .txt icon came out brighter than the image list's (straight) copy. So they are encoded as
// straight ARGB, and test-files.js checks the exact colour. Every HBITMAP is DeleteObject'ed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using FN = Mantle.FilesNative;

namespace Mantle {
  [MantleFeature]
  static class FilesThumbs {
    public static void Register(FeatureTable t) {
      t.Add("files.thumbs", Lanes.Slow, Files.Safe("files.thumbs", Thumbs));
    }

    const int WorkerCount = 2, MaxItems = 24, StallMs = 8000;
    /// Base64 characters per reply: the main side's line cap is 4 MB, and 24 photo thumbnails at
    /// 256 px can exceed it. Items past the budget come back png:null with a `why` to ask again.
    const int BudgetChars = 3000000;
    const int SIIGBF_RESIZETOFIT = 0x0, SIIGBF_ICONONLY = 0x4, SIIGBF_THUMBNAILONLY = 0x8;

    sealed class Batch {
      public object Id;
      public FilesJob Job;
      public List<string> Paths;
      public object[] Results;
      public int Left;
      public int Px;
      public bool Thumb;
    }
    sealed class Unit { public Batch B; public int I; public int Answered; }
    sealed class Worker { public volatile Unit Cur; public long CurTs; public volatile bool Abandoned; }

    static readonly object _lock = new object();
    static readonly Queue<Unit> _queue = new Queue<Unit>();
    static readonly List<Worker> _workers = new List<Worker>();
    static Timer _watchdog;
    static int _replaced;

    static string Thumbs(Dictionary<string, object> req, ref object result) {
      object raw;
      var paths = new List<string>();
      if (Json.TryGet(req, "items", out raw) && raw is IEnumerable && !(raw is string)) {
        foreach (object o in (IEnumerable)raw) {
          var d = o as Dictionary<string, object>;
          string p = d != null ? Json.GetString(d, "path") : o as string;
          paths.Add(p);
        }
      }
      if (paths.Count > MaxItems) return "files.thumbs: at most " + MaxItems + " items per call";
      int px = Json.GetInt(req, "px", 96);
      if (px < 16 || px > 1024) return "files.thumbs: px must be 16..1024";
      string mode = Json.GetString(req, "mode") ?? "thumb";
      if (mode != "thumb" && mode != "icon") return "files.thumbs: mode must be thumb or icon";
      if (paths.Count == 0) { result = Json.Obj("results", new List<object>()); return null; }
      FilesJob job = null;
      if (Json.HasKey(req, "job")) {
        string err;
        job = FilesJobs.Start(req, "thumbs", out err);
        if (job == null) return err;
      }
      var b = new Batch();
      b.Id = req.ContainsKey("id") ? req["id"] : null;
      b.Job = job; b.Paths = paths; b.Px = px; b.Thumb = mode == "thumb";
      b.Results = new object[paths.Count];
      b.Left = paths.Count;
      lock (_lock) {
        for (int i = 0; i < paths.Count; i++) { var u = new Unit(); u.B = b; u.I = i; _queue.Enqueue(u); }
        while (_workers.Count < WorkerCount) StartWorker();
        if (_watchdog == null) _watchdog = new Timer(Watch, null, 1000, 1000);
        Monitor.PulseAll(_lock);
      }
      result = Program.Deferred;
      return null;
    }

    /// Caller holds _lock.
    static void StartWorker() {
      var w = new Worker();
      _workers.Add(w);
      var t = new Thread(Loop);
      t.IsBackground = true;
      t.Name = "mantle-files-thumbs";
      t.SetApartmentState(ApartmentState.STA);   // the shell's image factories are apartment-threaded
      t.Start(w);
    }

    static void Loop(object state) {
      var w = (Worker)state;
      while (true) {
        Unit u;
        lock (_lock) {
          while (_queue.Count == 0) Monitor.Wait(_lock);
          u = _queue.Dequeue();
          w.Cur = u;
          w.CurTs = Stopwatch.GetTimestamp();
        }
        object r;
        if (u.B.Job != null && u.B.Job.Cancelled) r = Fail("cancelled");
        else {
          try { r = Render(u.B.Paths[u.I], u.B.Px, u.B.Thumb); }
          catch (Exception ex) { r = Fail("failed (" + ex.GetType().Name + ")"); }
        }
        lock (_lock) w.Cur = null;
        Complete(u, r);
        if (w.Abandoned) return;   // the watchdog already answered for this item and replaced us
      }
    }

    static IDictionary Fail(string why) { return Json.Obj("png", null, "w", 0, "h", 0, "kind", null, "why", why); }

    static IDictionary Render(string path, int px, bool thumb) {
      if (!FN.IsAbsolute(path)) return Fail("not an absolute path");
      object o;
      Guid iid = FN.IID_IShellItemImageFactory;
      int hr = FN.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out o);
      if (hr != 0 || o == null) return Fail(FN.HrWords(hr));
      try {
        var f = (FN.IShellItemImageFactory)o;
        var sz = new FN.SIZE();
        sz.cx = px; sz.cy = px;
        IntPtr hb = IntPtr.Zero;
        string kind = "thumb";
        hr = -1;
        if (thumb) hr = f.GetImage(sz, SIIGBF_RESIZETOFIT | SIIGBF_THUMBNAILONLY, out hb);
        if (hr != 0 || hb == IntPtr.Zero) {
          // No thumbnail handler for this type (.txt, a folder): its icon, at the same size.
          kind = "icon";
          hr = f.GetImage(sz, SIIGBF_RESIZETOFIT | SIIGBF_ICONONLY, out hb);
        }
        if (hr != 0 || hb == IntPtr.Zero) return Fail(FN.HrWords(hr));
        try {
          int w, h;
          byte[] bits = FN.ReadBits(hb, out w, out h);
          if (bits == null) return Fail("the image could not be read");
          return Json.Obj("png", FN.Png(bits, w, h, false), "w", w, "h", h, "kind", kind, "why", null);
        } finally { FN.DeleteObject(hb); }
      } finally { FN.Release(o); }
    }

    /// Exactly one answer per item (the watchdog and a late worker race for it), and the last
    /// answer of a call sends the reply.
    static void Complete(Unit u, object r) {
      if (Interlocked.CompareExchange(ref u.Answered, 1, 0) != 0) return;
      u.B.Results[u.I] = r;
      if (Interlocked.Decrement(ref u.B.Left) != 0) return;
      int used = 0;
      foreach (object o in u.B.Results) {
        var d = o as IDictionary;
        var png = d != null ? d["png"] as string : null;
        if (png == null) continue;
        if (used + png.Length > BudgetChars) {
          d["png"] = null; d["kind"] = null;
          d["why"] = "over the 3 MB reply budget: ask for this one again";
        } else used += png.Length;
      }
      FilesJobs.End(u.B.Job);
      Program.ReplyFromWorker(u.B.Id, true, Json.Obj("results", u.B.Results), null);
    }

    static void Watch(object unused) {
      var stuck = new List<Unit>();
      lock (_lock) {
        long now = Stopwatch.GetTimestamp();
        for (int i = _workers.Count - 1; i >= 0; i--) {
          Worker w = _workers[i];
          Unit u = w.Cur;
          if (u == null || (now - w.CurTs) * 1000L / Stopwatch.Frequency < StallMs) continue;
          w.Abandoned = true;
          _workers.RemoveAt(i);
          stuck.Add(u);
          _replaced++;
          StartWorker();
        }
      }
      foreach (Unit u in stuck) {
        Program.EmitLog("warn", "files.thumbs: a thumbnail provider did not answer in " + (StallMs / 1000) +
                                " s; its worker was replaced (" + _replaced + " so far)");
        Complete(u, Fail("the thumbnail provider did not answer in 8 s"));
      }
    }
  }
}
