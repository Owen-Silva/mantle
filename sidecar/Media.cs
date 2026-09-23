// Media.cs - "now playing": the system media sessions (Spotify, a browser tab,
// LessonPlayer, ...) read and driven through WinRT's
// Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.
//
//   {cmd:"media"}                                  get (op defaults to "get")
//   {cmd:"media", op:"get", art:true, artSize:96, aumid:"..."}
//   {cmd:"media", op:"control", action:"play"|"pause"|"toggle"|"next"|"previous"|"stop"|"seek",
//                 positionMs:<seek only>, aumid:"<optional; default = the current session>"}
//   {cmd:"media", op:"watch", on:true|false}      emits {ev:"media", ...} on changes
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
// was LessonPlayer (Contoso.LessonPlayer_8wekyb3d8bbwe!App): title "LessonPlayer",
// artist "Student", no artwork, a timeline that it last updated minutes ago.
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
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "get";
      if (op != "get" && op != "control" && op != "watch")
        return "media: unknown op '" + op + "' (use get, control or watch)";

      string action = null;
      long seekMs = 0;
      if (op == "control") {
        action = Json.GetString(req, "action");
        if (action != "play" && action != "pause" && action != "toggle" && action != "next" &&
            action != "previous" && action != "stop" && action != "seek")
          return "media: control needs action play, pause, toggle, next, previous, stop or seek" +
                 (string.IsNullOrEmpty(action) ? "" : " (got '" + action + "')");
        if (action == "seek") {
          object pv;
          if (!Json.TryGet(req, "positionMs", out pv) || !(pv is double) || (double)pv < 0 ||
              double.IsNaN((double)pv) || (double)pv > 86400000.0 * 7)
            return "media: seek needs positionMs, a number of milliseconds from 0";
          seekMs = (long)Math.Round((double)pv);
        }
        // Checked BEFORE anything reaches WinRT, so a passive test run can
        // never press a button on whatever is playing.
        if (Program.Passive) return PassiveRefusal + ": media control would change live playback";
      }
      if (op == "watch" && !Json.HasKey(req, "on")) return "media: watch needs on:true or on:false";

#if MANTLE_WINMD
      string aumid = Json.GetString(req, "aumid");
      if (op == "get") {
        bool art = Json.GetBool(req, "art", true);
        int size = Json.GetInt(req, "artSize", DefaultArtPx);
        if (size < 16) size = 16;
        if (size > 256) size = 256;
        result = Get(art, size, aumid);
      } else if (op == "control") {
        result = Control(action, seekMs, aumid);
      } else {
        result = Watch(Json.GetBool(req, "on", true));
      }
      return null;
#else
      result = Json.Obj("ok", false, "present", false, "reason", Unavailable);
      return null;
#endif
    }

#if !MANTLE_WINMD
    const string Unavailable =
      "media controls are not built into this sidecar: build.ps1 did not find the WinRT metadata " +
      "(System32\\WinMetadata\\Windows.Media.winmd and its companions) or the System.Runtime facade, " +
      "so MANTLE_WINMD was not defined";
#else
    public const int DefaultArtPx = 96;
    const int CallMs = 2000;       // one WinRT call (props, a button, opening the artwork)
    const int RequestMs = 3500;    // a whole request, under the 4 s the client waits
    const long MaxArtBytes = 8L * 1024 * 1024;

    // ------------------------------------------------------------ the thread

    static readonly object _gate = new object();
    static readonly Queue<Action> _work = new Queue<Action>();          // under _gate
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;                                              // under _gate
    static volatile string _busy;                                       // what the thread is doing, for timeouts

    /// Runs `fn` on the media thread and waits for it. If the thread does not
    /// finish in time the caller gets the reason; the late work still finishes
    /// on its own and its answer is dropped (it writes only to its own locals).
    static IDictionary OnMediaThread(string what, Func<IDictionary> fn) {
      lock (_gate) {
        if (_thread == null) {
          _thread = new Thread(Loop);
          _thread.Name = "media";
          _thread.IsBackground = true;          // never holds the process open at quit
          _thread.SetApartmentState(ApartmentState.MTA);
          _thread.Start();
        }
      }
      var done = new ManualResetEvent(false);
      IDictionary answer = null;
      lock (_gate) {
        _work.Enqueue(delegate {
          _busy = what;
          try {
            answer = fn();
          } catch (Exception ex) {
            answer = Json.Obj("ok", false, "reason", "media: " + what + " failed (" + Why(ex) + ")");
          } finally {
            _busy = null;
            done.Set();
          }
        });
      }
      _wake.Set();
      if (!done.WaitOne(RequestMs)) {
        string busy = _busy;
        return Json.Obj("ok", false, "reason",
                        "media: " + what + " did not finish within " + (RequestMs / 1000.0) + " s" +
                        (busy != null ? " (the media thread is still busy with " + busy + ")" : ""));
      }
      done.Close();
      return answer;
    }

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
      string err = WinRt.Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), CallMs,
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
      var snap = Snapshot(false, false, DefaultArtPx, null);
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

    static IDictionary Control(string action, long seekMs, string aumid) {
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

        IAsyncOperation<bool> op = null;
        string verb = action, via = action;
        switch (action) {
          case "play":     if (c.IsPlayEnabled) op = s.TryPlayAsync(); break;
          case "pause":    if (c.IsPauseEnabled) op = s.TryPauseAsync(); break;
          case "stop":     if (c.IsStopEnabled) op = s.TryStopAsync(); break;
          case "next":     verb = "next track"; if (c.IsNextEnabled) op = s.TrySkipNextAsync(); break;
          case "previous": verb = "previous track"; if (c.IsPreviousEnabled) op = s.TrySkipPreviousAsync(); break;
          case "seek":
            verb = "seeking";
            if (c.IsPlaybackPositionEnabled) op = s.TryChangePlaybackPositionAsync(TimeSpan.FromMilliseconds(seekMs).Ticks);
            break;
          case "toggle":
            verb = "play/pause";
            if (c.IsPlayPauseToggleEnabled) op = s.TryTogglePlayPauseAsync();
            // Some apps publish play and pause but not the toggle: do the half
            // that matches what it is doing now, and say which one was sent.
            else if (pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing && c.IsPauseEnabled) {
              op = s.TryPauseAsync(); via = "pause";
            } else if (c.IsPlayEnabled) {
              op = s.TryPlayAsync(); via = "play";
            }
            break;
        }
        if (op == null)
          return Json.Obj("ok", false, "action", action, "aumid", s.SourceAppUserModelId,
                          "reason", app + " does not accept " + verb + " right now");
        bool accepted;
        string cerr = WinRt.Await(op, CallMs, app + " (" + verb + ")", out accepted);
        if (cerr != null)
          return Json.Obj("ok", false, "action", action, "aumid", s.SourceAppUserModelId, "reason", cerr);
        if (!accepted)
          return Json.Obj("ok", false, "action", action, "aumid", s.SourceAppUserModelId,
                          "reason", app + " refused " + verb);
        return Json.Obj("ok", true, "action", action, "via", via, "aumid", s.SourceAppUserModelId,
                        "rev", Interlocked.Read(ref _rev));
      });
    }

    static GlobalSystemMediaTransportControlsSession FindSession(string aumid) {
      foreach (var s in _mgr.GetSessions())
        if (string.Equals(s.SourceAppUserModelId, aumid, StringComparison.OrdinalIgnoreCase)) return s;
      return null;
    }

    // ------------------------------------------------------------- snapshot

    /// Media thread. `full` adds artwork (when `art`) and the button list to
    /// the current session; every other session is described lightly.
    static IDictionary Snapshot(bool full, bool art, int artSize, string aumid) {
      string err = EnsureManager();
      if (err != null)
        return Json.Obj("ok", false, "present", false, "via", "winrt",
                        "reason", "media: Windows' media sessions are unavailable (" + err + ")");
      var cur = _mgr.GetCurrentSession();
      var all = new List<GlobalSystemMediaTransportControlsSession>(_mgr.GetSessions());
      // The same COM object comes back as the same RCW, so reference equality
      // is the precise match; the AUMID is the fallback if it ever is not.
      int curIdx = -1;
      if (cur != null) {
        for (int i = 0; i < all.Count && curIdx < 0; i++) if (ReferenceEquals(all[i], cur)) curIdx = i;
        for (int i = 0; i < all.Count && curIdx < 0; i++)
          if (all[i].SourceAppUserModelId == cur.SourceAppUserModelId) curIdx = i;
      }
      var list = new List<object>();
      for (int i = 0; i < all.Count; i++) {
        var d = Describe(all[i], false, false, artSize);
        d["current"] = i == curIdx;
        list.Add(d);
      }
      IDictionary current = cur == null ? null : Describe(cur, full, full && art, artSize);
      IDictionary picked = null;
      string pickedReason = null;
      if (!string.IsNullOrEmpty(aumid)) {
        var s = FindSession(aumid);
        if (s != null) picked = Describe(s, true, art, artSize);
        else pickedReason = "no media session from " + aumid + " is open";
      }
      var r = Json.Obj("ok", true, "present", all.Count > 0, "via", "winrt",
                       "rev", Interlocked.Read(ref _rev), "count", all.Count,
                       "current", current, "sessions", list,
                       "events", HookReason == null, "eventsReason", HookReason);
      if (!string.IsNullOrEmpty(aumid)) { r["session"] = picked; r["sessionReason"] = pickedReason; }
      if (all.Count == 0) r["reason"] = "nothing is playing: no app has a media session open";
      else if (cur == null) r["currentReason"] = "Windows has not picked a current session";
      return r;
    }

    static IDictionary Describe(GlobalSystemMediaTransportControlsSession s, bool full, bool art, int artSize) {
      string aumid = s.SourceAppUserModelId;
      var app = AppFor(aumid, false);
      var d = Json.Obj("aumid", aumid, "app", app);

      GlobalSystemMediaTransportControlsSessionMediaProperties p;
      string perr = WinRt.Await(s.TryGetMediaPropertiesAsync(), CallMs, "the track details from " + app["name"], out p);
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
        string url = p == null ? null : Artwork(p, (string)d["artKey"], artSize, out why);
        d["artwork"] = url;
        if (url == null) d["artworkReason"] = why;
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

    /// Media thread. The session's thumbnail as a PNG data URL no larger than
    /// `size` px on its long side. Cached per track and size; a failure is
    /// never cached, because apps often publish the art a moment after the
    /// title.
    static string Artwork(GlobalSystemMediaTransportControlsSessionMediaProperties p, string key, int size, out string why) {
      why = null;
      string ck = size + "|" + key;
      lock (_art) {
        string hit;
        if (_art.TryGetValue(ck, out hit)) return hit;
      }
      if (p.Thumbnail == null) { why = "the app did not publish artwork"; return null; }
      IRandomAccessStreamWithContentType st;
      why = WinRt.Await(p.Thumbnail.OpenReadAsync(), CallMs, "opening the artwork", out st);
      if (why != null) return null;
      if (st == null) { why = "the artwork stream was empty"; return null; }
      byte[] bytes;
      try {
        ulong n = st.Size;
        if (n == 0) { why = "the artwork stream was empty"; return null; }
        if ((long)n > MaxArtBytes) { why = "the artwork is " + (n / 1024) + " KB, over the " + (MaxArtBytes / 1048576) + " MB limit"; return null; }
        using (var rd = new DataReader(st)) {
          uint got;
          why = WinRt.Await(rd.LoadAsync((uint)n), CallMs, "reading the artwork", out got);
          if (why != null) return null;
          bytes = new byte[got];
          rd.ReadBytes(bytes);
        }
      } finally {
        try { st.Dispose(); } catch (Exception) { }
      }
      string url;
      try {
        url = Png(bytes, size);
      } catch (Exception ex) {
        why = "the artwork could not be decoded (" + Why(ex) + ")";
        return null;
      }
      lock (_art) {
        if (_art.Count >= 16) _art.Clear();   // a handful of tracks; no LRU needed
        _art[ck] = url;
      }
      return url;
    }

    static string Png(byte[] bytes, int size) {
      using (var ms = new MemoryStream(bytes))
      using (var img = SD.Image.FromStream(ms, false, true)) {
        int w = img.Width, h = img.Height;
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
          using (var outp = new MemoryStream()) {
            bmp.Save(outp, SD.Imaging.ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(outp.ToArray());
          }
        }
      }
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

    /// "Spotify.exe" -> "Spotify"; "Pub.LessonPlayer_hash!App" -> "LessonPlayer".
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
