// Media.cs - "now playing": the system media sessions (Spotify, a browser tab,
// a video app, ...) read and driven through WinRT's
// Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.
//
//   {cmd:"media"}                                  get (op defaults to "get")
//   {cmd:"media", op:"get", art:true, artSize:192, aumid:"..."}
//   {cmd:"media", op:"control", action:"play"|"pause"|"toggle"|"next"|"previous"|"stop"|"seek",
//                 positionMs:<seek only>, aumid:"<optional; default = the current session>",
//                 dryRun:true -> finds the session, says which call it WOULD send, sends nothing
//                 (the only control a --passive sidecar accepts)}
//   {cmd:"media", op:"watch", on:true|false}      emits {ev:"media", ...} on changes
//   --passive only, for sidecar/test-media.js: op "arttest" (the art encoder on an image made
//   here), "stalltest" (keep the media thread busy), "changetest" (fire the change hook;
//   its "artmiss" and "midread" drive the art retry and the as-of rev).
// Every argument is type-checked (a wrong type is an error, never a silent default).
//
// ART (lane media-sc, 2026-09-29): the card draws art at 72 DIP, so the default is 192 px (sharp
// to 250% scaling; 96 px was upscaled and soft at 150/200%). Opaque art is sent as JPEG q90, PNG
// only when a pixel is transparent. Measured on generated 600x600 art: old PNG@96 41.7 KB /
// 21 ms, PNG@192 162 KB / 40 ms, JPEG@192 14.1 KB / 35 ms; a 3000x3000 source ~435 ms either way.
// Images over 16 megapixels are refused from the header before any decode.
//
// TIME (same lane): a request's WinRT calls share one deadline (BudgetMs from when it was asked),
// so one hung app cannot push the answer past RequestMs; a job whose caller already gave up is
// dropped, never run late (a pause the user was told failed must not land seconds later).
//
// HOW THIS BUILDS WITHOUT THE WINDOWS SDK (measured 2026-09-22). build.ps1's
// MANTLE_WINRT route wants the SDK's UNION Windows.winmd because
// System.Runtime.WindowsRuntime's AsTask()/GetAwaiter() are compiled against it:
// against the split winmds in System32\WinMetadata this csc answers
//   CS0012: The type 'Windows.Foundation.IAsyncOperation`1<T0>' is defined in an
//   assembly that is not referenced ... 'Windows, Version=255.255.255.255 ...'
// But ONLY those extension methods need the union file. The WinRT types
// themselves compile fine from the split winmds, so this file never touches
// System.Runtime.WindowsRuntime at all: WinRt.Await below drives each
// IAsyncOperation's own Completed callback into a ManualResetEvent. Everything
// it needs ships with Windows:
//   System32\WinMetadata\Windows.Foundation.winmd / Windows.Media.winmd /
//                        Windows.Storage.winmd       the WinRT metadata
//   System.Runtime.dll (the facade; build.ps1 already finds the GAC copy)
//                                                   what the winmds' base types
//                                                   resolve through
//   Framework64\v4.0.30319\System.Runtime.InteropServices.WindowsRuntime.dll
//                                                   the facade for the event
//                                                   add/remove helpers csc emits
// and the file compiles only when build.ps1 found them and defined
// MANTLE_WINMD. Without it, the stub at the bottom answers every call with the
// reason, so a missing file is never a silent blank in the bar.
//
// WHY A THREAD OF ITS OWN (measured 2026-09-22): the manager and session
// classes are MarshalingBehavior=Standard, NOT agile, so an object is tied to
// the apartment that made it. The sidecar's lanes are STA threads (Lanes.cs);
// an STA-owned media object would need that lane to pump before anyone else
// could use it, and its change events would queue behind icon loads. So every
// WinRT call here runs on ONE background MTA thread ("media"), the lane that
// asked just waits for the answer, and the events (which arrive on thread-pool
// threads) only bump a counter and wake that thread.
//
// Measured on this machine, 2026-09-22, under Owen's usual load: RequestAsync
// 14-48 ms, GetSessions under 5 ms, TryGetMediaPropertiesAsync 3-20 ms,
// hooking a session's three events 9 ms, unhooking 2 ms. The one live session
// was a Store app (Publisher.App_hash!App): title the app's own name,
// artist a placeholder, no artwork, a timeline that it last updated minutes ago.
// Artwork cost is the image decode: a 3840x2400 JPEG took ~3 s to decode and
// downscale, so the PNG is cached per track (album art is usually ~300-600 px
// and far cheaper).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using SD = System.Drawing;
#if MANTLE_WINMD
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;
#endif

namespace Mantle {
  static class Media {
    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    /// The one entry point for `media`. Returns an error string for a
    /// malformed request (the dispatcher turns it into ok:false); every
    /// "cannot do that right now" is an answer in `result` with ok:false and a
    /// plain-English reason, like the Quick Settings replies.
    public static string Run(Dictionary<string, object> req, ref object result) {
      object opv;
      if (Json.TryGet(req, "op", out opv) && !(opv is string)) return "media: op must be a string (get, control or watch)";
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "get";
      bool testOp = op == "arttest" || op == "stalltest" || op == "changetest";
      if (op != "get" && op != "control" && op != "watch" && !testOp)
        return "media: unknown op '" + Clip(op) + "' (use get, control or watch)";
      // Test ops never touch a media session; they exist so the art encoder and
      // the busy-thread paths can be driven without a real player.
      if (testOp && !Program.Passive) return "media: " + op + " is a test op and only runs in --passive";

      // Every optional argument is type-checked, so a wrong type is a clear
      // error rather than a silent default (on:"false" used to mean TRUE).
      object v;
      if (Json.TryGet(req, "aumid", out v) && !(v is string)) return "media: aumid must be a string (the app's id from a get)";
      if (Json.TryGet(req, "art", out v) && !(v is bool)) return "media: art must be true or false";
      if (Json.TryGet(req, "dryRun", out v) && !(v is bool)) return "media: dryRun must be true or false";
      int artSize = DefaultArtPx;
      if (Json.TryGet(req, "artSize", out v)) {
        if (!(v is double) || double.IsNaN((double)v) || double.IsInfinity((double)v))
          return "media: artSize must be a number of pixels (16 to 256)";
        // Clamped as a double first: (int) of a huge double is int.MinValue.
        artSize = (int)Math.Round(Math.Max(16.0, Math.Min(256.0, (double)v)));
      }
      bool dryRun = Json.GetBool(req, "dryRun", false);

      string action = null;
      long seekMs = 0;
      if (op == "control") {
        object av;
        if (Json.TryGet(req, "action", out av) && !(av is string)) return "media: action must be a string";
        action = Json.GetString(req, "action");
        if (action != "play" && action != "pause" && action != "toggle" && action != "next" &&
            action != "previous" && action != "stop" && action != "seek")
          return "media: control needs action play, pause, toggle, next, previous, stop or seek" +
                 (string.IsNullOrEmpty(action) ? "" : " (got '" + Clip(action) + "')");
        if (action == "seek") {
          object pv;
          if (!Json.TryGet(req, "positionMs", out pv) || !(pv is double) || (double)pv < 0 ||
              double.IsNaN((double)pv) || (double)pv > 86400000.0 * 7)
            return "media: seek needs positionMs, a number of milliseconds from 0";
          seekMs = (long)Math.Round((double)pv);
        }
        // Checked BEFORE anything reaches WinRT, so a passive test run can
        // never press a button on whatever is playing. dryRun is allowed: it
        // finds the target and says what it WOULD send, and sends nothing.
        if (Program.Passive && !dryRun) return PassiveRefusal + ": media control would change live playback";
      }
      if (op == "watch") {
        object ov;
        if (!Json.TryGet(req, "on", out ov)) return "media: watch needs on:true or on:false";
        if (!(ov is bool)) return "media: watch needs on:true or on:false (a boolean)";
      }

#if MANTLE_WINMD
      string aumid = Json.GetString(req, "aumid");
      if (op == "get") {
        result = Get(Json.GetBool(req, "art", true), artSize, aumid);
      } else if (op == "control") {
        result = Control(action, seekMs, aumid, dryRun);
      } else if (op == "watch") {
        result = Watch(Json.GetBool(req, "on", true));
      } else if (op == "arttest") {
        string terr = ArtTest(req, artSize, ref result);
        if (terr != null) return terr;
      } else if (op == "stalltest") {
        result = StallTest(req);
      } else {
        result = ChangeTest(req);
      }
      return null;
#else
      result = Json.Obj("ok", false, "present", false, "reason", Unavailable);
      return null;
#endif
    }

    /// An argument echoed in an error, cut short so a huge string cannot
    /// flood the reply.
    static string Clip(string s) {
      if (s == null) return "";
      return s.Length <= 40 ? s : s.Substring(0, 40) + "...";
    }

    // The card draws art at 72 DIP; 192 px stays sharp up to 250% scaling
    // (96 px was upscaled, and looked soft, at 150% and 200%).
    // Outside the #if: Handle's artSize check reads it in BOTH builds, and the
    // union-winmd build (no MANTLE_WINMD) failed with CS0103 while it lived below.
    public const int DefaultArtPx = 192;

#if !MANTLE_WINMD
    const string Unavailable =
      "media controls are not built into this sidecar: build.ps1 did not find the WinRT metadata " +
      "(System32\\WinMetadata\\Windows.Media.winmd and its companions) or the System.Runtime facade, " +
      "so MANTLE_WINMD was not defined";
#else
    const int CallMs = 2000;       // one WinRT call (props, a button, opening the artwork)
    const int RequestMs = 3500;    // a whole request, under the 4 s the client waits
    const int BudgetMs = RequestMs - 300;   // what the work itself may spend, so the answer beats RequestMs
    const int MinCallMs = 50;      // less time left than this: skip the call, say so
    const long MaxArtBytes = 8L * 1024 * 1024;
    // Decoding costs memory and time by PIXELS, not file size: a small PNG can
    // claim 30000x30000 (3.6 GB to decode). Album art is ~300-3000 px a side.
    const long MaxArtPixels = 4096L * 4096;
    const int JpegQuality = 90;

    // ------------------------------------------------------------ the thread

    static readonly object _gate = new object();
    static readonly Queue<Action> _work = new Queue<Action>();          // under _gate
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;                                              // under _gate
    static volatile string _busy;                                       // what the thread is doing, for timeouts

    sealed class Job { public bool Abandoned; }                         // Abandoned under _gate
    static long _deadlineTs;                                            // media thread only; 0 = no deadline
    static long _dropped;                                               // Interlocked: jobs skipped because their caller gave up

    /// Runs `fn` on the media thread and waits for it. If the thread does not
    /// finish in time the caller gets the reason. A job whose caller has
    /// already given up is DROPPED when its turn comes (never run late: a
    /// pause the user was told failed must not land seconds afterwards, and
    /// a hung app must not grow a queue of dead reads). A job that has started
    /// runs under a deadline (BudgetMs from when it was asked), so one slow app
    /// cannot eat the whole answer.
    static void EnsureThread() {
      lock (_gate) {
        if (_thread == null) {
          _thread = new Thread(Loop);
          _thread.Name = "media";
          _thread.IsBackground = true;          // never holds the process open at quit
          _thread.SetApartmentState(ApartmentState.MTA);
          _thread.Start();
        }
      }
    }

    static IDictionary OnMediaThread(string what, Func<IDictionary> fn) {
      EnsureThread();
      var done = new ManualResetEvent(false);
      var job = new Job();
      long asked = Stopwatch.GetTimestamp();
      IDictionary answer = null;
      lock (_gate) {
        _work.Enqueue(delegate {
          lock (_gate) {
            if (job.Abandoned) { Interlocked.Increment(ref _dropped); return; }
          }
          _busy = what;
          _deadlineTs = asked + BudgetMs * Stopwatch.Frequency / 1000;
          try {
            answer = fn();
          } catch (Exception ex) {
            answer = Json.Obj("ok", false, "reason", "media: " + what + " failed (" + Why(ex) + ")");
          } finally {
            _deadlineTs = 0;
            _busy = null;
            done.Set();
          }
        });
      }
      _wake.Set();
      if (!done.WaitOne(RequestMs)) {
        lock (_gate) job.Abandoned = true;
        string busy = _busy;
        return Json.Obj("ok", false, "reason",
                        "media: " + what + " did not finish within " + (RequestMs / 1000.0) + " s" +
                        (busy != null ? " (the media thread is still busy with " + busy + ")" : ""));
      }
      done.Close();
      return answer;
    }

    /// Media thread: the time one more WinRT call may take, or 0 when the
    /// current job's deadline is too close to start one.
    static int CallBudget() {
      long due = _deadlineTs;
      if (due == 0) return CallMs;
      long ms = (due - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
      if (ms < MinCallMs) return 0;
      return (int)Math.Min(CallMs, ms);
    }

    const string OutOfTime = "skipped: the request ran out of time (another app was slow to answer)";

    static void Loop() {
      while (true) {
        long due;
        lock (_gate) due = _eventDueTs;
        int wait = Timeout.Infinite;
        if (due != 0) {
          long ms = (due - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
          wait = ms <= 0 ? 0 : (int)Math.Min(ms, int.MaxValue);
        }
        _wake.WaitOne(wait);
        while (true) {
          Action a;
          lock (_gate) {
            if (_work.Count == 0) break;
            a = _work.Dequeue();
          }
          a();
        }
        try {
          FlushEvents();
        } catch (Exception ex) {
          Program.EmitLog("warn", "media: a change event could not be sent (" + Why(ex) + ")");
        }
      }
    }

    // ------------------------------------------------------ manager + events

    static GlobalSystemMediaTransportControlsSessionManager _mgr;       // media thread only
    // Why change events are NOT live (null = they are). Two parts, because a
    // manager-level refusal must not be wiped by the next good session rehook.
    static string _mgrHookReason, _sessionHookReason;                   // media thread only
    static string HookReason { get { return _mgrHookReason ?? _sessionHookReason; } }
    static volatile bool _watching;
    static volatile bool _testMidRead;                                  // --passive changetest "midread": one change during the next read
    static long _rev;                                                   // Interlocked
    static readonly List<string> _reasons = new List<string>();         // under _gate
    static long _eventDueTs;                                            // under _gate; 0 = nothing pending


    // Debounce: one burst of changes (a track change fires properties,
    // playback AND timeline within a few ms) becomes ONE event. Timeline-only
    // changes wait longer, because some players republish their position
    // every second and the bar can extrapolate it from positionAtMs anyway.
    const int DebounceMs = 200;
    const int TimelineDebounceMs = 1000;

    sealed class Hook {
      public GlobalSystemMediaTransportControlsSession S;
      public TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> Props;
      public TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> Playback;
      public TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> Timeline;
    }
    static readonly List<Hook> _hooks = new List<Hook>();               // media thread only

    /// Any thread (WinRT raises these on thread-pool threads). Cheap on
    /// purpose: bump the revision, note why, wake the media thread.
    static void Changed(string reason) {
      Interlocked.Increment(ref _rev);
      lock (_gate) {
        if (!_reasons.Contains(reason)) _reasons.Add(reason);
        long now = Stopwatch.GetTimestamp();
        long due = now + (reason == "timeline" ? TimelineDebounceMs : DebounceMs) * Stopwatch.Frequency / 1000;
        if (_eventDueTs == 0 || due < _eventDueTs) _eventDueTs = due;
      }
      _wake.Set();
    }

    /// Media thread. The manager, and the event hooks that keep `rev` honest,
    /// are set up on first use of any op and kept for the sidecar's life.
    static string EnsureManager() {
      if (_mgr != null) return null;
      GlobalSystemMediaTransportControlsSessionManager m;
      int ms = CallBudget();
      if (ms == 0) return OutOfTime;
      string err = WinRt.Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), ms,
                               "Windows' media session manager", out m);
      if (err != null) return err;
      if (m == null) return "Windows returned no media session manager";
      _mgr = m;
      try {
        m.SessionsChanged += delegate { Changed("sessions"); };
        m.CurrentSessionChanged += delegate { Changed("current"); };
        _mgrHookReason = null;
      } catch (Exception ex) {
        _mgrHookReason = "Windows refused the media change events (" + Why(ex) + "), so the bar must poll";
      }
      Rehook();
      return null;
    }

    /// Media thread. Sessions come and go, so on every sessions/current change
    /// the per-session hooks are dropped and rebuilt for the new list.
    static void Rehook() {
      foreach (var h in _hooks) {
        try {
          h.S.MediaPropertiesChanged -= h.Props;
          h.S.PlaybackInfoChanged -= h.Playback;
          h.S.TimelinePropertiesChanged -= h.Timeline;
        } catch (Exception) {
          // The session is already gone; its events went with it.
        }
      }
      _hooks.Clear();
      if (_mgr == null) return;
      _sessionHookReason = null;
      try {
        foreach (var s in _mgr.GetSessions()) {
          var h = new Hook();
          h.S = s;
          h.Props = delegate { Changed("media"); };
          h.Playback = delegate { Changed("playback"); };
          h.Timeline = delegate { Changed("timeline"); };
          s.MediaPropertiesChanged += h.Props;
          s.PlaybackInfoChanged += h.Playback;
          s.TimelinePropertiesChanged += h.Timeline;
          _hooks.Add(h);
        }
      } catch (Exception ex) {
        _sessionHookReason = "a media session's change events could not be hooked (" + Why(ex) + "), so the bar must poll";
      }
    }

    /// Media thread: send the debounced event if one is due.
    static void FlushEvents() {
      List<string> reasons;
      lock (_gate) {
        if (_eventDueTs == 0 || Stopwatch.GetTimestamp() < _eventDueTs) return;
        reasons = new List<string>(_reasons);
        _reasons.Clear();
        _eventDueTs = 0;
      }
      if (reasons.Contains("sessions") || reasons.Contains("current")) Rehook();
      if (!_watching) return;

      // Light on purpose: no artwork (a data URL per event would be tens of
      // KB). `artKey` changes when the track does, which is the client's cue
      // to call get for the new art.
      IDictionary snap;
      _deadlineTs = Stopwatch.GetTimestamp() + BudgetMs * Stopwatch.Frequency / 1000;
      try {
        snap = Snapshot(false, false, DefaultArtPx, null);
      } finally {
        _deadlineTs = 0;
      }
      Program.Emit(Json.Obj("ev", "media", "rev", Interlocked.Read(ref _rev), "reasons", reasons,
                            "present", snap["present"], "current", snap["current"],
                            "count", snap["count"], "reason", snap["reason"]));
    }

    // ------------------------------------------------------------------ ops

    static IDictionary Get(bool art, int artSize, string aumid) {
      IDictionary snap = OnMediaThread("reading the media sessions", delegate {
        return Snapshot(true, art, artSize, aumid);
      });
      // App names come from the shell (Apps.Info), whose objects are
      // apartment-threaded, so they are filled in HERE on the caller's STA lane
      // rather than on the MTA media thread.
      FillApp(snap["current"] as IDictionary, true);
      FillApp(snap["session"] as IDictionary, true);
      var list = snap["sessions"] as IList;
      if (list != null) foreach (var s in list) FillApp(s as IDictionary, true);
      return snap;
    }

    static IDictionary Watch(bool on) {
      _watching = on;
      return OnMediaThread("starting the media watch", delegate {
        string err = EnsureManager();
        if (err != null) {
          _watching = false;
          return Json.Obj("ok", false, "watching", false,
                          "reason", "media: Windows' media sessions are unavailable (" + err + ")");
        }
        return Json.Obj("ok", HookReason == null, "watching", on, "events", HookReason == null,
                        "rev", Interlocked.Read(ref _rev), "reason", HookReason);
      });
    }

    static IDictionary Control(string action, long seekMs, string aumid, bool dryRun) {
      return OnMediaThread("media " + action, delegate {
        string err = EnsureManager();
        if (err != null)
          return Json.Obj("ok", false, "action", action,
                          "reason", "media: Windows' media sessions are unavailable (" + err + ")");
        GlobalSystemMediaTransportControlsSession s;
        if (!string.IsNullOrEmpty(aumid)) {
          // An explicit target is never swapped for the current session: a
          // button meant for one app must not land on another.
          s = FindSession(aumid);
          if (s == null)
            return Json.Obj("ok", false, "action", action,
                            "reason", "nothing to control: no media session from " + aumid + " is open");
        } else {
          s = _mgr.GetCurrentSession();
          if (s == null)
            return Json.Obj("ok", false, "action", action,
                            "reason", "nothing to control: no app has a media session open");
        }
        string app = AppFor(s.SourceAppUserModelId, false)["name"] as string;
        var pb = s.GetPlaybackInfo();
        var c = pb == null ? null : pb.Controls;
        if (c == null)
          return Json.Obj("ok", false, "action", action, "reason", app + " did not say which buttons it accepts");

        // First decide WHICH call this press becomes (nothing is sent yet), so
        // dryRun can answer exactly what a real press would do.
        string verb = action, via = null;
        bool isPlaying = pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        switch (action) {
          case "play":     if (c.IsPlayEnabled) via = "play"; break;
          case "pause":    if (c.IsPauseEnabled) via = "pause"; break;
          case "stop":     if (c.IsStopEnabled) via = "stop"; break;
          case "next":     verb = "next track"; if (c.IsNextEnabled) via = "next"; break;
          case "previous": verb = "previous track"; if (c.IsPreviousEnabled) via = "previous"; break;
          case "seek":     verb = "seeking"; if (c.IsPlaybackPositionEnabled) via = "seek"; break;
          case "toggle":
            verb = "play/pause";
            if (c.IsPlayPauseToggleEnabled) via = "toggle";
            // Some apps publish play and pause but not the toggle: do the half
            // that matches what it is doing now, and say which one was sent.
            else if (isPlaying && c.IsPauseEnabled) via = "pause";
            else if (c.IsPlayEnabled) via = "play";
            break;
        }
        string target = s.SourceAppUserModelId;
        if (via == null)
          return Json.Obj("ok", false, "action", action, "aumid", target, "dryRun", dryRun,
                          "reason", app + " does not accept " + verb + " right now");
        if (dryRun)
          return Json.Obj("ok", true, "dryRun", true, "sent", false, "action", action, "via", via,
                          "aumid", target, "positionMs", action == "seek" ? (object)seekMs : null,
                          "rev", Interlocked.Read(ref _rev));

        // A press that could only land late is not sent at all.
        int ms = CallBudget();
        if (ms == 0)
          return Json.Obj("ok", false, "action", action, "aumid", target, "reason", app + " (" + verb + ") " + OutOfTime);
        IAsyncOperation<bool> op = null;
        switch (via) {
          case "play":     op = s.TryPlayAsync(); break;
          case "pause":    op = s.TryPauseAsync(); break;
          case "stop":     op = s.TryStopAsync(); break;
          case "next":     op = s.TrySkipNextAsync(); break;
          case "previous": op = s.TrySkipPreviousAsync(); break;
          case "seek":     op = s.TryChangePlaybackPositionAsync(TimeSpan.FromMilliseconds(seekMs).Ticks); break;
          case "toggle":   op = s.TryTogglePlayPauseAsync(); break;
        }
        bool accepted;
        string cerr = WinRt.Await(op, ms, app + " (" + verb + ")", out accepted);
        if (cerr != null)
          return Json.Obj("ok", false, "action", action, "aumid", target, "reason", cerr);
        if (!accepted)
          return Json.Obj("ok", false, "action", action, "aumid", target,
                          "reason", app + " refused " + verb);
        return Json.Obj("ok", true, "action", action, "via", via, "aumid", target,
                        "rev", Interlocked.Read(ref _rev));
      });
    }

    static GlobalSystemMediaTransportControlsSession FindSession(string aumid) {
      foreach (var s in _mgr.GetSessions())
        if (string.Equals(AumidOf(s), aumid, StringComparison.OrdinalIgnoreCase)) return s;
      return null;
    }

    /// A session's app id, or null when the session closed under us (its
    /// RCW then throws on every call; seen as RPC_E_DISCONNECTED).
    static string AumidOf(GlobalSystemMediaTransportControlsSession s) {
      try { return s.SourceAppUserModelId; } catch (Exception) { return null; }
    }

    // ------------------------------------------------------------- snapshot

    /// Media thread. `full` adds artwork (when `art`) and the button list to
    /// the current session; every other session is described lightly.
    static IDictionary Snapshot(bool full, bool art, int artSize, string aumid) {
      string err = EnsureManager();
      if (err != null)
        return Json.Obj("ok", false, "present", false, "via", "winrt",
                        "reason", "media: Windows' media sessions are unavailable (" + err + ")");
      // The revision this answer is AS OF, taken before anything is read (lane
      // r6-art, 2026-09-30). It used to be taken at the end: a change that
      // landed DURING the read (Spotify publishes the art a moment after the
      // title) gave a reply with the NEW rev but the old picture, and main
      // skips an event whose rev it already has, so the art never came.
      long rev = Interlocked.Read(ref _rev);
      if (full && _testMidRead) { _testMidRead = false; Changed("media"); }   // --passive changetest "midread": a get only
      var cur = _mgr.GetCurrentSession();
      var all = new List<GlobalSystemMediaTransportControlsSession>(_mgr.GetSessions());
      // The same COM object comes back as the same RCW, so reference equality
      // is the precise match; the AUMID is the fallback if it ever is not.
      // Sessions come and go WHILE this reads them (a tab closes, a player
      // quits): a session that throws is left out and counted, instead of
      // failing the whole read.
      int skipped = 0;
      string curAumid = cur == null ? null : AumidOf(cur);
      int curIdx = -1;
      if (cur != null) {
        for (int i = 0; i < all.Count && curIdx < 0; i++) if (ReferenceEquals(all[i], cur)) curIdx = i;
        for (int i = 0; i < all.Count && curIdx < 0; i++)
          if (curAumid != null && AumidOf(all[i]) == curAumid) curIdx = i;
      }
      var list = new List<object>();
      for (int i = 0; i < all.Count; i++) {
        IDictionary d;
        try {
          d = Describe(all[i], false, false, artSize);
        } catch (Exception) {
          skipped++;
          continue;
        }
        d["current"] = i == curIdx;
        list.Add(d);
      }
      IDictionary current = null;
      string curGone = null;
      if (cur != null) {
        try {
          current = Describe(cur, full, full && art, artSize);
        } catch (Exception ex) {
          curGone = "the playing app's media session closed while Mantle was reading it (" + Why(ex) + ")";
        }
      }
      IDictionary picked = null;
      string pickedReason = null;
      if (!string.IsNullOrEmpty(aumid)) {
        var s = FindSession(aumid);
        if (s != null) {
          try {
            picked = Describe(s, true, art, artSize);
          } catch (Exception ex) {
            pickedReason = "that app's media session closed while Mantle was reading it (" + Why(ex) + ")";
          }
        } else pickedReason = "no media session from " + aumid + " is open";
      }
      int count = all.Count - skipped;
      var r = Json.Obj("ok", true, "present", count > 0, "via", "winrt",
                       "rev", rev, "count", count,
                       "current", current, "sessions", list,
                       "events", HookReason == null, "eventsReason", HookReason);
      if (skipped > 0) r["skipped"] = skipped;
      if (!string.IsNullOrEmpty(aumid)) { r["session"] = picked; r["sessionReason"] = pickedReason; }
      if (count == 0) r["reason"] = "nothing is playing: no app has a media session open";
      else if (curGone != null) r["currentReason"] = curGone;
      else if (cur == null) r["currentReason"] = "Windows has not picked a current session";
      return r;
    }

    static IDictionary Describe(GlobalSystemMediaTransportControlsSession s, bool full, bool art, int artSize) {
      string aumid = s.SourceAppUserModelId;
      var app = AppFor(aumid, false);
      var d = Json.Obj("aumid", aumid, "app", app);

      GlobalSystemMediaTransportControlsSessionMediaProperties p = null;
      int ms = CallBudget();
      string perr = ms == 0 ? OutOfTime
        : WinRt.Await(s.TryGetMediaPropertiesAsync(), ms, "the track details from " + app["name"], out p);
      string title = null, artist = null, album = null;
      if (p != null) {
        title = Blank(p.Title);
        artist = Blank(p.Artist);
        album = Blank(p.AlbumTitle);
        d["title"] = title;
        d["subtitle"] = Blank(p.Subtitle);
        d["artist"] = artist;
        d["album"] = album;
        d["albumArtist"] = Blank(p.AlbumArtist);
        d["trackNumber"] = p.TrackNumber > 0 ? (object)p.TrackNumber : null;
        d["kind"] = p.PlaybackType.HasValue ? p.PlaybackType.Value.ToString().ToLowerInvariant() : null;
        d["hasArt"] = p.Thumbnail != null;
      } else {
        d["title"] = null;
        d["detailsReason"] = perr ?? (app["name"] + " did not publish any track details");
      }
      // Stable per track, so the client knows when to fetch new art.
      d["artKey"] = aumid + "|" + title + "|" + artist + "|" + album;

      var pb = s.GetPlaybackInfo();
      string status = pb == null ? "unknown" : StatusName(pb.PlaybackStatus);
      d["status"] = status;
      d["playing"] = status == "playing";
      double rate = pb != null && pb.PlaybackRate.HasValue ? pb.PlaybackRate.Value : 1.0;
      if (full && pb != null) {
        var c = pb.Controls;
        d["can"] = c == null ? null : Json.Obj(
          "play", c.IsPlayEnabled, "pause", c.IsPauseEnabled, "toggle", c.IsPlayPauseToggleEnabled,
          "next", c.IsNextEnabled, "previous", c.IsPreviousEnabled, "stop", c.IsStopEnabled,
          "seek", c.IsPlaybackPositionEnabled);
        d["shuffle"] = pb.IsShuffleActive.HasValue ? (object)pb.IsShuffleActive.Value : null;
        d["repeat"] = pb.AutoRepeatMode.HasValue ? pb.AutoRepeatMode.Value.ToString().ToLowerInvariant() : null;
        d["rate"] = rate;
      }
      d["timeline"] = Timeline(s, status == "playing", rate, app["name"] as string);

      if (art) {
        string why = "no track details, so no artwork";
        bool again = true;
        string url = p == null ? null : Artwork(p, (string)d["artKey"], artSize, out why, out again);
        d["artwork"] = url;
        if (url == null) {
          d["artworkReason"] = why;
          if (again) ArtRetry((string)d["artKey"]);
        }
      }
      return d;
    }

    static IDictionary Timeline(GlobalSystemMediaTransportControlsSession s, bool playing, double rate, string app) {
      GlobalSystemMediaTransportControlsSessionTimelineProperties t;
      try {
        t = s.GetTimelineProperties();
      } catch (Exception ex) {
        return Json.Obj("available", false, "reason", "the position could not be read (" + Why(ex) + ")");
      }
      if (t == null) return Json.Obj("available", false, "reason", app + " does not publish a position");
      double start = t.StartTime.TotalMilliseconds, end = t.EndTime.TotalMilliseconds;
      double dur = end - start;
      if (dur <= 0)
        return Json.Obj("available", false, "reason", app + " does not publish a position or length");
      double pos = t.Position.TotalMilliseconds - start;
      long at = 0;
      try { at = t.LastUpdatedTime.ToUnixTimeMilliseconds(); } catch (Exception) { }
      // The app reports a position AT a time; while playing, the real position
      // has moved on since. positionNowMs is that estimate (clamped), so a
      // progress bar can tick without asking again.
      double now = pos;
      if (playing && at > 0) {
        double since = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - at;
        if (since > 0) now = pos + since * rate;
      }
      if (now < 0) now = 0;
      if (now > dur) now = dur;
      return Json.Obj("available", true, "durationMs", (long)Math.Round(dur),
                      "positionMs", (long)Math.Round(pos), "positionAtMs", at > 0 ? (object)at : null,
                      "positionNowMs", (long)Math.Round(now),
                      "seekMinMs", (long)Math.Round(t.MinSeekTime.TotalMilliseconds - start),
                      "seekMaxMs", (long)Math.Round(t.MaxSeekTime.TotalMilliseconds - start));
    }

    // -------------------------------------------------------------- artwork

    static readonly Dictionary<string, string> _art = new Dictionary<string, string>();   // under _art

    // ART RETRY (lane r6-art, 2026-09-30). Owen's card showed the note glyph
    // over a paused Spotify song and never got the picture. A read that finds
    // no art is not cached (the app may publish it a moment later), but the
    // card only reads again on a change event, and a PAUSED player sends
    // none: so a missed picture stayed missed until the next song. Now a read
    // that found no art for a reason that can pass (none published yet, a
    // slow app, an empty stream) makes the watch send one more change event,
    // reason "art", at the next of these times after the track's FIRST miss;
    // a read in between (a click, another change) uses none up. A too-big or
    // damaged image is refused for good and never retried. At most 4 extra
    // reads per artless track, over 45 s, then quiet.
    static readonly int[] ArtRetryAtMs = { 1000, 4000, 15000, 45000 };
    static readonly Dictionary<string, long> _artMiss = new Dictionary<string, long>();   // under _art: track -> first miss

    /// Media thread. Schedules the next "art" event for `key` (a track), or
    /// nothing when its retries are spent or no one is watching. Every
    /// artless read calls this, so a debounced event that flushed EARLY (and
    /// cleared the due time) cannot lose the later retries.
    static long ArtRetry(string key) {
      if (!_watching || key == null) return -1;
      long now = Stopwatch.GetTimestamp(), f = Stopwatch.Frequency, due = 0;
      lock (_art) {
        long first;
        // a song played again later (over 10 min) starts afresh
        if (!_artMiss.TryGetValue(key, out first) || now - first > 600L * f) {
          if (_artMiss.Count >= 32) _artMiss.Clear();   // a handful of tracks; no LRU needed
          first = now;
          _artMiss[key] = first;
        }
        foreach (int at in ArtRetryAtMs) {
          long t = first + at * f / 1000;
          if (t > now) { due = t; break; }
        }
        if (due == 0) return -1;                         // spent: the app has no art for this track
      }
      // A NEW revision, so the event is not one the client already has (main
      // skips an event whose rev equals its last read's).
      Interlocked.Increment(ref _rev);
      lock (_gate) {
        if (!_reasons.Contains("art")) _reasons.Add("art");
        if (_eventDueTs == 0 || due < _eventDueTs) _eventDueTs = due;
      }
      _wake.Set();
      return (due - now) * 1000 / f;   // ms until the event, for the test op
    }

    /// Media thread. The session's thumbnail as a data URL no larger than
    /// `size` px on its long side (JPEG when opaque, PNG when it has any
    /// transparency; see Encode). Cached per track and size; a failure is
    /// never cached, because apps often publish the art a moment after the
    /// title.
    static string Artwork(GlobalSystemMediaTransportControlsSessionMediaProperties p, string key, int size, out string why, out bool again) {
      why = null;
      again = true;   // every failure below is worth another look, except a too-big or unreadable image
      string ck = size + "|" + key;
      lock (_art) {
        string hit;
        if (_art.TryGetValue(ck, out hit)) return hit;
      }
      if (p.Thumbnail == null) { why = "the app did not publish artwork"; return null; }
      int ms = CallBudget();
      if (ms == 0) { why = OutOfTime; return null; }
      IRandomAccessStreamWithContentType st;
      why = WinRt.Await(p.Thumbnail.OpenReadAsync(), ms, "opening the artwork", out st);
      if (why != null) return null;
      if (st == null) { why = "the artwork stream was empty"; return null; }
      byte[] bytes;
      try {
        ulong n = st.Size;
        if (n == 0) { why = "the artwork stream was empty"; return null; }
        if ((long)n > MaxArtBytes) { again = false; why = "the artwork is " + (n / 1024) + " KB, over the " + (MaxArtBytes / 1048576) + " MB limit"; return null; }
        ms = CallBudget();
        if (ms == 0) { why = OutOfTime; return null; }
        using (var rd = new DataReader(st)) {
          uint got;
          why = WinRt.Await(rd.LoadAsync((uint)n), ms, "reading the artwork", out got);
          if (why != null) return null;
          bytes = new byte[got];
          rd.ReadBytes(bytes);
        }
      } finally {
        try { st.Dispose(); } catch (Exception) { }
      }
      string url, type;
      int ow, oh;
      why = Encode(bytes, size, null, out url, out type, out ow, out oh);
      again = false;   // decoded, or refused for good (damaged, too large): either way no retry
      if (why != null) return null;
      lock (_art) {
        if (_art.Count >= 16) _art.Clear();   // a handful of tracks; no LRU needed
        _art[ck] = url;
        _artMiss.Remove(key);
      }
      return url;
    }

    static SD.Imaging.ImageCodecInfo _jpeg;   // under _art

    /// Any thread. Decodes `bytes`, scales to `size` px on the long side with
    /// high-quality bicubic, and encodes a data URL: JPEG (quality 90) when
    /// every output pixel is opaque, which is ~5-10x smaller than PNG for a
    /// photo, else PNG so transparent art keeps its edges. `force` ("png" /
    /// "jpeg") is for the test op's before/after measurement only. Returns the
    /// plain-words reason on failure; never throws.
    static string Encode(byte[] bytes, int size, string force, out string url, out string type, out int ow, out int oh) {
      url = null; type = null; ow = 0; oh = 0;
      if (bytes == null || bytes.Length == 0) return "the artwork stream was empty";
      try {
        using (var ms = new MemoryStream(bytes))
        // validateImageData:false reads only the header, so the pixel count is
        // known BEFORE anything big is decoded; DrawImage decodes afterwards.
        using (var img = SD.Image.FromStream(ms, false, false)) {
          int w = img.Width, h = img.Height;
          if (w <= 0 || h <= 0) return "the artwork has no size";
          if ((long)w * h > MaxArtPixels)
            return "the artwork is " + w + " x " + h + " px, too large to decode (the limit is " + (MaxArtPixels / 1000000) + " megapixels)";
          double k = Math.Min(1.0, (double)size / Math.Max(w, h));
          int tw = Math.Max(1, (int)Math.Round(w * k)), th = Math.Max(1, (int)Math.Round(h * k));
          using (var bmp = new SD.Bitmap(tw, th, SD.Imaging.PixelFormat.Format32bppArgb)) {
            using (var g = SD.Graphics.FromImage(bmp))
            using (var ia = new SD.Imaging.ImageAttributes()) {
              g.InterpolationMode = SD.Drawing2D.InterpolationMode.HighQualityBicubic;
              g.PixelOffsetMode = SD.Drawing2D.PixelOffsetMode.HighQuality;
              g.CompositingQuality = SD.Drawing2D.CompositingQuality.HighQuality;
              // TileFlipXY stops bicubic from pulling transparent black in at
              // the edges, which otherwise leaves a dark hairline round the art.
              ia.SetWrapMode(SD.Drawing2D.WrapMode.TileFlipXY);
              g.DrawImage(img, new SD.Rectangle(0, 0, tw, th), 0, 0, w, h, SD.GraphicsUnit.Pixel, ia);
            }
            bool jpeg = force == "jpeg" || (force != "png" && Opaque(bmp));
            using (var outp = new MemoryStream()) {
              SD.Imaging.ImageCodecInfo codec = jpeg ? JpegCodec() : null;
              if (jpeg && codec != null) {
                using (var ep = new SD.Imaging.EncoderParameters(1)) {
                  ep.Param[0] = new SD.Imaging.EncoderParameter(SD.Imaging.Encoder.Quality, (long)JpegQuality);
                  bmp.Save(outp, codec, ep);
                }
                type = "jpeg";
              } else {
                bmp.Save(outp, SD.Imaging.ImageFormat.Png);
                type = "png";
              }
              url = "data:image/" + type + ";base64," + Convert.ToBase64String(outp.ToArray());
              ow = tw; oh = th;
              return null;
            }
          }
        }
      } catch (Exception) {
        // GDI+ answers a corrupt or truncated file with "Out of memory" or
        // "Parameter is not valid"; neither means anything to a user.
        url = null; type = null;
        return "the artwork is not an image Mantle can read (the file is damaged or in an unknown format)";
      }
    }

    /// True when every pixel of a 32bpp ARGB bitmap has alpha 255. Scans the
    /// output (at most 256 x 256), not the source's pixel format, because a
    /// paletted PNG can carry transparency its format flag does not show and
    /// an "ARGB" PNG is often fully opaque.
    static bool Opaque(SD.Bitmap bmp) {
      var rect = new SD.Rectangle(0, 0, bmp.Width, bmp.Height);
      var data = bmp.LockBits(rect, SD.Imaging.ImageLockMode.ReadOnly, SD.Imaging.PixelFormat.Format32bppArgb);
      try {
        int stride = Math.Abs(data.Stride);
        var row = new byte[stride];
        for (int y = 0; y < bmp.Height; y++) {
          System.Runtime.InteropServices.Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, stride);
          for (int x = 0; x < bmp.Width; x++) if (row[x * 4 + 3] != 255) return false;
        }
        return true;
      } finally {
        bmp.UnlockBits(data);
      }
    }

    static SD.Imaging.ImageCodecInfo JpegCodec() {
      lock (_art) {
        if (_jpeg == null)
          foreach (var c in SD.Imaging.ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") { _jpeg = c; break; }
        return _jpeg;
      }
    }

    // ---------------------------------------------------- test ops (--passive only)

    /// {op:"arttest", kind, w, h, artSize, force?} - runs Encode on an image
    /// made HERE, so the art path is testable without a real player. Kinds:
    /// photo (opaque JPEG), png (opaque PNG), alpha (PNG, transparent corners),
    /// corrupt (random bytes), truncated (half a JPEG), huge (a valid PNG
    /// header claiming 30000 x 30000, no pixels), empty.
    static string ArtTest(Dictionary<string, object> req, int artSize, ref object result) {
      string kind = Json.GetString(req, "kind") ?? "photo";
      string force = Json.GetString(req, "force");
      int w = Json.GetInt(req, "w", 600), h = Json.GetInt(req, "h", 600);
      if (w < 1 || h < 1 || w > 5000 || h > 5000) return "media: arttest needs w and h from 1 to 5000";
      byte[] src;
      switch (kind) {
        case "photo": src = MakeImage(w, h, false, SD.Imaging.ImageFormat.Jpeg); break;
        case "png": src = MakeImage(w, h, false, SD.Imaging.ImageFormat.Png); break;
        case "alpha": src = MakeImage(w, h, true, SD.Imaging.ImageFormat.Png); break;
        case "truncated": {
          byte[] full = MakeImage(w, h, false, SD.Imaging.ImageFormat.Jpeg);
          src = new byte[full.Length / 2];
          Array.Copy(full, src, src.Length);
          break;
        }
        case "corrupt": src = new byte[4096]; new Random(7).NextBytes(src); break;
        case "huge": src = PngHeaderOnly(30000, 30000); break;
        case "empty": src = new byte[0]; break;
        default: return "media: arttest kind must be photo, png, alpha, truncated, corrupt, huge or empty";
      }
      var sw = Stopwatch.StartNew();
      string url, type;
      int ow, oh;
      string why = Encode(src, artSize, force, out url, out type, out ow, out oh);
      sw.Stop();
      result = Json.Obj("ok", why == null, "kind", kind, "srcBytes", src.Length, "type", type,
                        "urlBytes", url == null ? 0 : url.Length, "w", ow, "h", oh,
                        "ms", Math.Round(sw.Elapsed.TotalMilliseconds, 1), "reason", why,
                        "prefix", url == null ? null : url.Substring(0, Math.Min(32, url.Length)));
      // r6-art: withUrl:true hands back the whole data URL, so a page test can draw exactly
      // what the card gets (an opaque image comes out as JPEG).
      if (Json.GetBool(req, "withUrl", false)) ((IDictionary)result)["url"] = url;
      return null;
    }

    /// A photo-like test image: smooth gradients plus noise (so it compresses
    /// like real art, not like a flat fill). `alpha` makes the corners clear.
    static byte[] MakeImage(int w, int h, bool alpha, SD.Imaging.ImageFormat fmt) {
      var rnd = new Random(42);
      using (var bmp = new SD.Bitmap(w, h, SD.Imaging.PixelFormat.Format32bppArgb)) {
        var rect = new SD.Rectangle(0, 0, w, h);
        var data = bmp.LockBits(rect, SD.Imaging.ImageLockMode.WriteOnly, SD.Imaging.PixelFormat.Format32bppArgb);
        var row = new byte[data.Stride];
        double r2 = Math.Min(w, h) * 0.5;
        for (int y = 0; y < h; y++) {
          for (int x = 0; x < w; x++) {
            int n = rnd.Next(-24, 25);
            row[x * 4 + 0] = (byte)Math.Max(0, Math.Min(255, 255 * x / w + n));
            row[x * 4 + 1] = (byte)Math.Max(0, Math.Min(255, 255 * y / h + n));
            row[x * 4 + 2] = (byte)Math.Max(0, Math.Min(255, 128 + (int)(100 * Math.Sin(x * 0.05 + y * 0.03)) + n));
            double dx = x - w / 2.0, dy = y - h / 2.0;
            row[x * 4 + 3] = (byte)(alpha && dx * dx + dy * dy > r2 * r2 ? 0 : 255);
          }
          System.Runtime.InteropServices.Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
        }
        bmp.UnlockBits(data);
        using (var ms = new MemoryStream()) {
          bmp.Save(ms, fmt);
          return ms.ToArray();
        }
      }
    }

    /// A PNG that is only a signature and a valid IHDR (with its CRC): what a
    /// hostile or broken app could hand over to make the decoder allocate GBs.
    static byte[] PngHeaderOnly(int w, int h) {
      var ms = new MemoryStream();
      ms.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
      var chunk = new byte[17];
      chunk[0] = (byte)'I'; chunk[1] = (byte)'H'; chunk[2] = (byte)'D'; chunk[3] = (byte)'R';
      BigEndian(chunk, 4, (uint)w);
      BigEndian(chunk, 8, (uint)h);
      chunk[12] = 8; chunk[13] = 2;              // 8-bit RGB, deflate, no filter, no interlace
      var len = new byte[4];
      BigEndian(len, 0, 13);
      ms.Write(len, 0, 4);
      ms.Write(chunk, 0, 17);
      var crc = new byte[4];
      BigEndian(crc, 0, Crc32(chunk));
      ms.Write(crc, 0, 4);
      return ms.ToArray();
    }

    static void BigEndian(byte[] b, int at, uint v) {
      b[at] = (byte)(v >> 24); b[at + 1] = (byte)(v >> 16); b[at + 2] = (byte)(v >> 8); b[at + 3] = (byte)v;
    }

    static uint Crc32(byte[] b) {
      uint c = 0xFFFFFFFF;
      foreach (byte x in b) {
        c ^= x;
        for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
      }
      return c ^ 0xFFFFFFFF;
    }

    /// {op:"stalltest", ms} - keeps the media thread busy for `ms` (max 10 s)
    /// WITHOUT waiting, so a test can prove a request behind a hung app
    /// answers in time, and that work its caller gave up on is dropped, not
    /// run late. ms 0 just reports the dropped count.
    static IDictionary StallTest(Dictionary<string, object> req) {
      int ms = Json.GetInt(req, "ms", 0);
      if (ms < 0) ms = 0;
      if (ms > 10000) ms = 10000;
      if (ms > 0) {
        EnsureThread();
        lock (_gate) {
          _work.Enqueue(delegate {
            _busy = "a test stall";
            try { Thread.Sleep(ms); } finally { _busy = null; }
          });
        }
        _wake.Set();
      }
      return Json.Obj("ok", true, "stalled", ms, "dropped", Interlocked.Read(ref _dropped));
    }

    /// {op:"changetest", reason, n} - fires the same change hook WinRT's
    /// events call, n times in a burst, so a test can prove the debounce
    /// (one event per burst), the emit while watching and the silence after
    /// watch off, without touching any real player.
    static IDictionary ChangeTest(Dictionary<string, object> req) {
      string reason = Json.GetString(req, "reason") ?? "media";
      // r6-art: "artmiss" runs the art retry for a made-up `track` (as an
      // artless read does) and answers in how many ms its event is due (-1 =
      // none); "midread" fires one change in the middle of the NEXT read, so a
      // test can prove the reply's rev is as of the start of that read.
      if (reason == "artmiss") {
        string track = Json.GetString(req, "track");
        if (string.IsNullOrEmpty(track)) return Json.Obj("ok", false, "reason", "changetest artmiss needs a track string");
        EnsureThread();
        long dueMs = ArtRetry("test|" + track);
        return Json.Obj("ok", true, "dueMs", dueMs, "watching", _watching, "rev", Interlocked.Read(ref _rev));
      }
      if (reason == "midread") {
        _testMidRead = true;
        return Json.Obj("ok", true, "armed", true, "rev", Interlocked.Read(ref _rev));
      }
      if (reason != "media" && reason != "playback" && reason != "timeline")
        return Json.Obj("ok", false, "reason", "changetest reason must be media, playback, timeline, artmiss or midread");
      int n = Math.Max(1, Math.Min(100, Json.GetInt(req, "n", 1)));
      EnsureThread();
      for (int i = 0; i < n; i++) Changed(reason);
      return Json.Obj("ok", true, "fired", n, "watching", _watching, "rev", Interlocked.Read(ref _rev));
    }

    // ----------------------------------------------------------- app names

    static readonly Dictionary<string, IDictionary> _apps = new Dictionary<string, IDictionary>(StringComparer.OrdinalIgnoreCase);

    /// {aumid, name, icon, nameVia}. `shell` is true only on an STA lane: the
    /// shell's AppsFolder lookup (Apps.Info) is apartment-threaded. Win32
    /// players report a bare exe name ("Spotify.exe"), which the shell does not
    /// know, so those are named from the running process's file description.
    /// Only real lookups are cached; the AUMID guess is retried next time.
    static IDictionary AppFor(string aumid, bool shell) {
      if (aumid == null) aumid = "";
      lock (_apps) {
        IDictionary hit;
        if (_apps.TryGetValue(aumid, out hit) && (!shell || (string)hit["nameVia"] != "aumid")) return hit;
      }
      string name = null, icon = null, via = null;
      if (shell && aumid.Length > 0 && !aumid.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
        string n, png;
        if (Apps.Info(aumid, out n, out png) == null && !string.IsNullOrEmpty(n)) { name = n; icon = png; via = "shell"; }
      }
      if (name == null && aumid.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
        name = ProcessDescription(aumid.Substring(0, aumid.Length - 4));
        if (name != null) via = "process";
      }
      if (string.IsNullOrEmpty(name)) { name = GuessName(aumid); via = "aumid"; }
      var d = Json.Obj("aumid", aumid, "name", name, "icon", icon, "nameVia", via);
      if (via != "aumid") lock (_apps) _apps[aumid] = d;
      else lock (_apps) { if (!_apps.ContainsKey(aumid)) _apps[aumid] = d; }
      return d;
    }

    /// The caller's STA lane: upgrade an AUMID-guessed name to the shell's.
    static void FillApp(IDictionary d, bool shell) {
      if (d == null) return;
      var a = d["app"] as IDictionary;
      if (a == null || (string)a["nameVia"] != "aumid") return;
      d["app"] = AppFor(d["aumid"] as string, shell);
    }

    static string ProcessDescription(string exeStem) {
      Process[] ps = null;
      try {
        ps = Process.GetProcessesByName(exeStem);
        foreach (var p in ps) {
          try {
            // Trimmed BEFORE the test: csc stamps an exe with no version info
            // with a FileDescription of one space, which came back as an empty
            // app name on 2026-09-22.
            string desc = (p.MainModule.FileVersionInfo.FileDescription ?? "").Trim();
            if (desc.Length > 0) return desc;
          } catch (Exception) {
            // Another user's or an elevated process: try the next one.
          }
        }
      } catch (Exception) {
      } finally {
        if (ps != null) foreach (var p in ps) p.Dispose();
      }
      return null;
    }

    /// "Spotify.exe" -> "Spotify"; "Pub.Player_hash!App" -> "Player".
    static string GuessName(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return "An app";
      string s = aumid;
      int bang = s.IndexOf('!');
      if (bang > 0) s = s.Substring(0, bang);
      int us = s.IndexOf('_');
      if (us > 0) s = s.Substring(0, us);
      if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
      int dot = s.LastIndexOf('.');
      if (dot >= 0 && dot < s.Length - 1) s = s.Substring(dot + 1);
      return s.Length > 0 ? s : aumid;
    }

    // --------------------------------------------------------------- helpers

    static string StatusName(GlobalSystemMediaTransportControlsSessionPlaybackStatus st) {
      switch (st) {
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing: return "playing";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused: return "paused";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped: return "stopped";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Changing: return "changing";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Opened: return "opened";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed: return "closed";
        default: return "unknown";
      }
    }

    static string Blank(string s) { return string.IsNullOrEmpty(s) ? null : s; }

    internal static string Why(Exception ex) {
      if (ex is AggregateException && ex.InnerException != null) ex = ex.InnerException;
      string msg = (ex.Message ?? "").Trim();
      int nl = msg.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) msg = msg.Substring(0, nl).Trim();
      return "HRESULT 0x" + ex.HResult.ToString("X8") + (msg.Length > 0 ? ": " + msg : "");
    }
#endif
  }

#if MANTLE_WINMD
  /// Awaiting a WinRT IAsyncOperation WITHOUT System.Runtime.WindowsRuntime
  /// (whose AsTask needs the SDK's union Windows.winmd at compile time - see
  /// the top of this file). The operation's own Completed callback sets an
  /// event; the caller waits with a timeout, and a timed-out operation is
  /// cancelled. Usable from any thread; Bluetooth.cs can use it the same way
  /// for Windows.Devices.Radios (measured 2026-09-22: GetRadiosAsync 64 ms cold,
  /// 2 ms warm, from both MTA and STA threads, versus 3+ s for powershell.exe).
  static class WinRt {
    public static string Await<T>(IAsyncOperation<T> op, int timeoutMs, string what, out T value) {
      value = default(T);
      if (op == null) return what + " did not start";
      var done = new ManualResetEvent(false);
      AsyncStatus status = AsyncStatus.Started;
      try {
        // WinRT calls the handler at once if the operation has already
        // finished, so there is no window between starting and hooking.
        op.Completed = delegate (IAsyncOperation<T> o, AsyncStatus s) { status = s; done.Set(); };
      } catch (Exception ex) {
        return what + " could not be awaited (" + Media.Why(ex) + ")";
      }
      if (!done.WaitOne(timeoutMs)) {
        // The late callback may still Set the event, so it is left to the GC
        // rather than closed under it.
        try { op.Cancel(); } catch (Exception) { }
        return what + " did not answer within " + (timeoutMs / 1000.0) + " s";
      }
      done.Close();
      try {
        switch (status) {
          case AsyncStatus.Completed:
            value = op.GetResults();
            return null;
          case AsyncStatus.Canceled:
            return what + " was cancelled";
          default:
            Exception err = null;
            try { err = op.ErrorCode; } catch (Exception) { }
            return what + " failed" + (err != null ? " (" + Media.Why(err) + ")" : "");
        }
      } catch (Exception ex) {
        return what + " failed (" + Media.Why(ex) + ")";
      } finally {
        try { op.Close(); } catch (Exception) { }
      }
    }
  }
#endif
}
