// Morph.cs - `morph` and `region`: move and resize one of Mantle's own windows
// along an eased curve, with rounded corners that follow the size.
//
// WHY IT IS HERE AND NOT IN CSS. Mantle's launcher grows out of the bar: one
// rectangle becomes another. Inside the page that is a trivial CSS transition -
// but the WINDOW does not move, so the animation is clipped to whichever
// rectangle is bigger and the effect is ruined. Only the OS can animate the
// window, and Electron's own setBounds does it in one jump. So the sidecar
// drives the frames.
//
// THE THREAD, and why there is exactly one per window. A 60 fps animation has
// to wake up every ~16 ms for a fifth of a second. Doing that on the message
// loop would stall every command and every hook callback behind it, so each
// morph gets a dedicated background thread that does nothing but sleep, compute
// and call SetWindowPos. It NEVER touches stdout except through Program.Emit,
// which holds the one write lock - a half-written line desyncs the protocol
// forever.
//
// SLEEP, NEVER SPIN. The frame deadline is computed from a Stopwatch and the
// thread sleeps to it. A spin loop would burn a whole core to move a window,
// which on this machine is exactly the bug that got measured and banned.
//
// THE LAST FRAME IS ASSIGNED, NOT INTERPOLATED. At t=1 the code takes the
// target values verbatim rather than trusting 0.9999*dx to round back: the
// caller's promise is that the window ENDS at `to`, and a pixel of float error
// there is a visible seam against the bar.
//
// CANCELLATION. A second morph for the same window supersedes the first: the
// old one stops on its next frame boundary and answers its own request with
// ok:false / "cancelled", so a caller awaiting it is never left hanging. The
// new thread waits for the old one to leave before it starts, so two threads
// never drive the same window.
//
// SAFETY. Same footing as `glass`, `place` and `corners`: one window, the
// caller's own, no shell state, nothing to undo after we die. Pointing it at
// the taskbar is refused outright.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace Mantle {
  static class Morph {
    /// ~60 fps. Not a promise - a busy machine gives what it gives, and the
    /// curve is sampled from the CLOCK, not from the frame count, so a dropped
    /// frame shortens the animation rather than slowing it down.
    const double FrameMs = 1000.0 / 60.0;
    /// A window animation longer than two seconds is a bug, not a design.
    public const int MaxMs = 2000;

    class Job {
      public object Id;
      public IntPtr Hwnd;
      public Thread Thread;
      public volatile bool Cancelled;
    }

    static readonly Dictionary<long, Job> _jobs = new Dictionary<long, Job>();
    static readonly object _lock = new object();

    public struct Box { public int X, Y, W, H, R; }

    // ------------------------------------------------------------------ verbs

    /// Starts the animation and returns null; THE REPLY IS SENT BY THE THREAD,
    /// after the last frame lands. A non-null return is a refusal that happened
    /// before anything moved, and the caller replies with it as usual.
    public static string Start(IntPtr hwnd, Box from, Box to, int ms, double[] ease, object id) {
      string bad = Check(hwnd, "morph");
      if (bad != null) return bad;
      if (from.W <= 0 || from.H <= 0 || to.W <= 0 || to.H <= 0)
        return "morph: from and to both need a positive w and h in physical pixels";
      if (ms < 0) ms = 0;
      if (ms > MaxMs) ms = MaxMs;

      Job old;
      var job = new Job();
      job.Id = id;
      job.Hwnd = hwnd;

      lock (_lock) {
        _jobs.TryGetValue(hwnd.ToInt64(), out old);
        if (old != null) old.Cancelled = true;
        _jobs[hwnd.ToInt64()] = job;
      }

      job.Thread = new Thread(delegate () {
        // Let the superseded animation finish its frame and answer its own
        // caller before this one starts driving the same window.
        if (old != null && old.Thread != null) {
          try { old.Thread.Join(200); } catch (Exception) { }
        }
        Run(job, from, to, ms, ease);
      });
      job.Thread.IsBackground = true;   // must never hold the process open
      job.Thread.Name = "mantle-morph";
      job.Thread.Start();
      return null;
    }

    /// `morph {hwnd, cancel:true}`: stop the animation, leave the window
    /// exactly where the last frame put it and change NOTHING else - no region
    /// cleared, no rect restored. Stopping an animation is not undoing it.
    public static bool Cancel(IntPtr hwnd) {
      Job job;
      lock (_lock) {
        if (!_jobs.TryGetValue(hwnd.ToInt64(), out job)) return false;
        _jobs.Remove(hwnd.ToInt64());
      }
      if (job == null) return false;
      job.Cancelled = true;
      return true;
    }

    /// Every running morph, stopped. Called from the shutdown path: by then
    /// stdout is already silenced, so the threads simply stop touching windows.
    public static void CancelAll() {
      List<Job> all;
      lock (_lock) {
        all = new List<Job>(_jobs.Values);
        _jobs.Clear();
      }
      foreach (Job j in all) j.Cancelled = true;
    }

    /// `region`: round (or un-round) the window AT ITS CURRENT SIZE. Separate
    /// from `corners` on purpose - DWM's corner preference rounds the frame the
    /// compositor draws, a window region actually clips the window, which is
    /// what a frameless panel needs while it is being resized.
    public static string SetRegion(IntPtr hwnd, int r, out int usedR) {
      usedR = 0;
      string bad = Check(hwnd, "region");
      if (bad != null) return bad;
      Win32.RECT rect;
      if (!Win32.GetWindowRect(hwnd, out rect)) return "region: the window's rect could not be read";
      int w = rect.right - rect.left, h = rect.bottom - rect.top;
      if (r < 0) r = 0;
      usedR = r;
      return ApplyRegion(hwnd, w, h, r);
    }

    // ------------------------------------------------------------- the animation

    static void Run(Job job, Box from, Box to, int ms, double[] ease) {
      int frames = 0;
      var sw = Stopwatch.StartNew();
      try {
        while (true) {
          if (job.Cancelled) { Finish(job, frames, true); return; }
          if (!Win32.IsWindow(job.Hwnd)) { Finish(job, frames, true); return; }

          double p = ms <= 0 ? 1.0 : sw.Elapsed.TotalMilliseconds / ms;
          if (p > 1.0) p = 1.0;
          bool last = p >= 1.0;
          double e = last ? 1.0 : Bezier.Solve(p, ease);

          // The last frame is the caller's exact rect, never a rounded lerp.
          int x = last ? to.X : Lerp(from.X, to.X, e);
          int y = last ? to.Y : Lerp(from.Y, to.Y, e);
          int w = last ? to.W : Lerp(from.W, to.W, e);
          int h = last ? to.H : Lerp(from.H, to.H, e);
          int r = last ? to.R : Lerp(from.R, to.R, e);
          if (w < 1) w = 1;
          if (h < 1) h = 1;

          Win32.SetWindowPos(job.Hwnd, IntPtr.Zero, x, y, w, h, Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
          ApplyRegion(job.Hwnd, w, h, r);
          frames++;

          if (last) break;

          // Sleep to the NEXT frame boundary, measured from the start, so a
          // slow frame does not push every later one back.
          double next = frames * FrameMs;
          double wait = next - sw.Elapsed.TotalMilliseconds;
          if (wait > ms - sw.Elapsed.TotalMilliseconds) wait = ms - sw.Elapsed.TotalMilliseconds;
          // 1 ms rather than 0: Sleep(0) yields but can spin hot behind a busy
          // machine, and this thread's whole job is to be cheap.
          Thread.Sleep(wait > 1 ? (int)Math.Round(wait) : 1);
        }
        Finish(job, frames, job.Cancelled);
      } catch (Exception ex) {
        lock (_lock) { Job cur; if (_jobs.TryGetValue(job.Hwnd.ToInt64(), out cur) && cur == job) _jobs.Remove(job.Hwnd.ToInt64()); }
        Program.ReplyFromWorker(job.Id, false, null, "morph failed after " + frames + " frames: " + ex.Message);
      }
    }

    static void Finish(Job job, int frames, bool cancelled) {
      lock (_lock) {
        Job cur;
        if (_jobs.TryGetValue(job.Hwnd.ToInt64(), out cur) && cur == job) _jobs.Remove(job.Hwnd.ToInt64());
      }
      if (cancelled) { Program.ReplyCancelled(job.Id); return; }
      var rect = new Win32.RECT();
      Win32.GetWindowRect(job.Hwnd, out rect);
      Program.ReplyFromWorker(job.Id, true,
        Json.Obj("ok", true,
                 "rect", new object[] { rect.left, rect.top, rect.right, rect.bottom },
                 "frames", frames), null);
    }

    static int Lerp(int a, int b, double t) { return (int)Math.Round(a + (b - a) * t); }

    /// r > 0 rounds, r == 0 clears. The +1s are not a typo: a region's right
    /// and bottom edges are EXCLUSIVE, so a w-wide window needs a w+1 region or
    /// it loses its last column of pixels.
    static string ApplyRegion(IntPtr hwnd, int w, int h, int r) {
      if (r <= 0) {
        Win32.SetWindowRgn(hwnd, IntPtr.Zero, true);
        return null;
      }
      IntPtr rgn = Win32.CreateRoundRectRgn(0, 0, w + 1, h + 1, r * 2, r * 2);
      if (rgn == IntPtr.Zero) return "region: the rounded region could not be created (GDI refused it)";
      if (Win32.SetWindowRgn(hwnd, rgn, true) == 0) {
        // Only on FAILURE is the region still ours to free. On success Windows
        // owns it, and deleting it would crash the window's next paint.
        try { Win32.DeleteObject(rgn); } catch (Exception) { }
        return "region: SetWindowRgn was refused for this window";
      }
      return null;
    }

    static string Check(IntPtr hwnd, string what) {
      if (hwnd == IntPtr.Zero) return what + ": no hwnd given";
      if (!Win32.IsWindow(hwnd)) return what + ": window " + hwnd.ToInt64() + " no longer exists";
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
        return what + ": that window IS the Windows taskbar (" + cls + "); this command only ever " +
               "moves a window Mantle owns";
      return null;
    }
  }

  /// The CSS cubic-bezier(x1,y1,x2,y2) solve, which is the same one every
  /// browser uses: the curve is parametric, so the progress the caller gives us
  /// (an X) has to be turned into the curve parameter (a t) before Y means
  /// anything. Newton-Raphson converges in a handful of steps for the ordinary
  /// curves; bisection is the fallback for the flat-derivative ones where
  /// Newton would walk off the curve.
  static class Bezier {
    /// CSS `ease`, the default when the caller does not name a curve.
    public static readonly double[] Default = new double[] { 0.25, 0.1, 0.25, 1.0 };

    /// Returns null when the array is a usable curve, or why it is not.
    public static string Validate(double[] e) {
      if (e == null) return null;   // absent is fine: Default is used
      if (e.Length != 4) return "ease must be four numbers: [x1,y1,x2,y2]";
      for (int i = 0; i < 4; i++)
        if (double.IsNaN(e[i]) || double.IsInfinity(e[i])) return "ease must be four real numbers: [x1,y1,x2,y2]";
      // y may overshoot (that is what a springy curve is); x may not, or the
      // curve is not a function of time and has no single answer.
      if (e[0] < 0 || e[0] > 1 || e[2] < 0 || e[2] > 1)
        return "ease: x1 and x2 must be between 0 and 1 (y1 and y2 may overshoot)";
      return null;
    }

    public static double Solve(double x, double[] e) {
      if (e == null || e.Length != 4) e = Default;
      double x1 = e[0], y1 = e[1], x2 = e[2], y2 = e[3];
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      double t = SolveX(x, x1, x2);
      return SampleY(t, y1, y2);
    }

    static double SampleX(double t, double x1, double x2) {
      double cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
      return ((ax * t + bx) * t + cx) * t;
    }

    static double SampleY(double t, double y1, double y2) {
      double cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
      return ((ay * t + by) * t + cy) * t;
    }

    static double SampleDx(double t, double x1, double x2) {
      double cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
      return (3 * ax * t + 2 * bx) * t + cx;
    }

    static double SolveX(double x, double x1, double x2) {
      const double Eps = 1e-6;
      double t = x;
      for (int i = 0; i < 8; i++) {
        double err = SampleX(t, x1, x2) - x;
        if (Math.Abs(err) < Eps) return t;
        double d = SampleDx(t, x1, x2);
        if (Math.Abs(d) < 1e-6) break;   // flat: Newton would jump off the curve
        t -= err / d;
      }
      double lo = 0, hi = 1;
      t = x;
      while (lo < hi) {
        double v = SampleX(t, x1, x2);
        if (Math.Abs(v - x) < Eps) return t;
        if (x > v) lo = t; else hi = t;
        double mid = (lo + hi) / 2;
        if (Math.Abs(mid - t) < 1e-9) return mid;
        t = mid;
      }
      return t;
    }
  }
}
