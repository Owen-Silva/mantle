// Lanes.cs - who runs which request, and when a request is not worth running.
//
// THE BUG THIS EXISTS FOR (live, 2026-09-22). Every command used to run on ONE
// thread, the message-loop thread, in arrival order. Under Owen's normal load
// (four simulation workers on ~70% of the CPU) the Bluetooth read - a
// powershell.exe launch - took 3+ s, and brightness (WMI) queued behind it.
// Electron gives up on a call after 4 s, but a request it had given up on was
// still executed later, so the queue never drained while new work kept
// arriving: 4 fps backdrop captures, the desktop recheck, a Quick Settings
// round every 2 s. The log showed 32 timeouts, 49 late answers and 7 successes
// in 150 lines, and the bar's buttons did nothing because `place` and `focus`
// were waiting behind screen grabs.
//
// THREE THINGS FIX IT, all here:
//
//   1. LANES. Latency-critical work (place, morph, keys, hit tests,
//      the cached Quick Settings reads) stays on the message-loop
//      thread - the "ui" lane - because hooks, the loop window and everything
//      SetWinEventHook touched are tied to that thread. Work that can be slow
//      and has no thread affinity gets its own worker:
//        capture  `backdrop` only: a GDI grab 4 times a second must never make
//                 a button wait, and must never wait behind an icon load.
//        slow     icons, shortcuts, app ids, pins, launch, the tray, and the
//                 Quick Settings SWITCHES (a radio or WMI call can take seconds).
//        audio    volume: fast, but it spikes under load and a dragged slider
//                 must not wait behind an icon load.
//        focus    focus / minimize / close / toggle: they act on ANOTHER app's
//                 window, and Windows can make the caller wait on that app's
//                 thread (see the registry comment below).
//      capture and slow are STA threads, because the shell's link and icon objects
//      are apartment-threaded; audio and focus are MTA. The registry that says which command goes where
//      is `_laneOf` in the Lanes class below.
//
//   2. DEADLINES. The client sends `ttl` (its own timeout in ms) with every
//      request. The stdin thread stamps the arrival time, and a lane that picks
//      the request up after the deadline answers "expired" at once instead of
//      doing the work for a caller who has already given up. Undo requests
//      (quit, restore, remove, release) are exempt: those are always worth
//      doing, late or not.
//
//   3. COALESCING. A queued request with the same coalesce key as a newer one
//      absorbs it: one execution, one answer per waiting id. That turns a
//      backlog of identical backdrop grabs (or a dragged brightness slider)
//      into one piece of work.
//
// Plus `Cached` at the bottom: the stale-while-revalidate cache that takes the
// slow Quick Settings READS off every lane entirely.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace Mantle {

  /// One id waiting for an answer, with its own deadline. A coalesced request
  /// has several.
  sealed class Waiter {
    public object Id;
    public long ArrivedTs;     // Stopwatch timestamp, stamped on the stdin thread
    public int TtlMs;          // 0 = no deadline (an old client, or a caller that waits forever)

    public long WaitedMs(long nowTs) {
      return (nowTs - ArrivedTs) * 1000 / Stopwatch.Frequency;
    }

    public bool Expired(long nowTs) {
      return TtlMs > 0 && WaitedMs(nowTs) >= TtlMs;
    }
  }

  /// A parsed request on its way to a lane.
  sealed class Request {
    public string Cmd;
    public Dictionary<string, object> Req;
    public string CoalesceKey;               // null = never merged
    public bool MergeAnywhere;               // see Lanes.CoalesceKey
    public string Lane;                      // Lanes.Ui / Capture / Slow, decided once in Program.Route
    public readonly List<Waiter> Waiters = new List<Waiter>();
    public bool Exempt;                       // an undo: never skipped for being late

    public object Id { get { return Waiters.Count > 0 ? Waiters[0].Id : null; } }

    /// A newer request with the same key: its arguments win (the newest
    /// brightness is the one the slider is at now), its caller joins the queue
    /// of people waiting for this one execution, and the request keeps its
    /// EARLIER place in the lane.
    public void Absorb(Request newer) {
      Req = newer.Req;
      Waiters.AddRange(newer.Waiters);
    }
  }

  /// A worker thread with its own FIFO. The ui lane is NOT one of these: it is
  /// the message loop itself, reached with BeginInvoke (see Program).
  sealed class Lane {
    public readonly string Name;
    readonly Action<Request> _exec;
    readonly LinkedList<Request> _queue = new LinkedList<Request>();
    readonly object _lock = new object();
    volatile string _busyCmd;
    long _busySinceTs;

    public Lane(string name, Action<Request> exec, ApartmentState apartment, ThreadPriority priority) {
      Name = name;
      _exec = exec;
      var t = new Thread(Loop);
      t.IsBackground = true;                  // must never hold the process open
      t.Name = "mantle-lane-" + name;
      // STA for the shell lanes: IShellLink, SHGetFileInfo and the AppsFolder
      // items are apartment-threaded and are created on this thread. MTA for
      // audio, which CoreAudio is happy in and which needs no pumping.
      t.SetApartmentState(apartment);
      // PRIORITY IS NOT COSMETIC (measured 2026-09-22 with four simulation
      // workers on the CPU): `volume` took 68 ms p50 on a Normal-priority
      // worker against 5 ms on the message loop, because a woken Normal
      // thread queues behind the busy Normal-priority processes at every wait
      // (the lane's own wake-up, then each RPC into audiosrv), while the loop
      // thread gets the GUI boost when a message arrives. AboveNormal brought
      // it back to 4.7 ms. Only the short, latency-critical lanes get it.
      t.Priority = priority;
      t.Start();
    }

    /// False (and nothing queued) when the lane already holds Lanes.MaxQueued requests; the
    /// caller answers "busy". An undo (Request.Exempt) is always queued.
    public bool Post(Request r) {
      lock (_lock) {
        if (r.CoalesceKey != null) {
          // Newest first. Without MergeAnywhere only the tail may absorb, so
          // a request never jumps ahead of one that was queued before it.
          for (LinkedListNode<Request> n = _queue.Last; n != null; n = n.Previous) {
            if (n.Value.CoalesceKey == r.CoalesceKey) {
              n.Value.Absorb(r);
              Interlocked.Increment(ref Lanes.Merged);
              return true;
            }
            if (!r.MergeAnywhere) break;
          }
        }
        if (!r.Exempt && _queue.Count >= Lanes.MaxQueued) return false;
        _queue.AddLast(r);
        Monitor.Pulse(_lock);
        return true;
      }
    }

    public int Queued { get { lock (_lock) return _queue.Count; } }

    void Loop() {
      for (;;) {
        Request r;
        lock (_lock) {
          while (_queue.Count == 0) Monitor.Wait(_lock);
          r = _queue.First.Value;
          _queue.RemoveFirst();
        }
        _busySinceTs = Stopwatch.GetTimestamp();
        _busyCmd = r.Cmd;
        try { _exec(r); } catch (Exception) { /* Execute answers every error itself */ }
        _busyCmd = null;
      }
    }

    public IDictionary Snapshot() {
      int depth;
      lock (_lock) depth = _queue.Count;
      string busy = _busyCmd;
      return Json.Obj("name", Name, "queued", depth, "busy", busy,
                      "busyMs", busy == null ? (object)null : (object)Lanes.MsSince(_busySinceTs));
    }
  }

  static class Lanes {
    public const string Ui = "ui", Capture = "capture", Slow = "slow", Audio = "audio", Qs = "qs", Focus = "focus";

    // ============================================================ THE REGISTRY
    //
    // TO ADD A COMMAND: write its `case` in Program.Run as usual. If it can be
    // slow (a process launch, WMI, COM that talks to another process, a file
    // system walk, UI Automation) AND it has no thread affinity (no hook, no
    // window this process created, no SetWinEventHook), give it ONE line here.
    // Anything not listed runs on ui, which is the safe default for anything
    // that touches hooks or windows - and the wrong place for anything slow,
    // because every button press waits behind it.
    //
    //   capture  screen grabs only
    //   slow     icons, shortcuts, app ids, pins, launch, the tray, media,
    //            notifications - "may take seconds, nobody is dragging it"
    //   qs       the Quick Settings SWITCHES (_switchArg below): Wi-Fi and
    //            Bluetooth radios, brightness, night light. Their own lane
    //            since 2026-09-23: on slow, a dragged brightness slider queued
    //            behind icon loads, tray reads and notification lists, which is
    //            part of why Owen found the panel "doesn't work well at all".
    //   audio    volume, read and set: a CoreAudio RPC is ~5 ms but spikes to
    //            200+ under load (measured 2026-09-22), too slow for ui, and a
    //            dragged slider must not queue behind an icon load
    static readonly Dictionary<string, string> _laneOf = new Dictionary<string, string>(StringComparer.Ordinal) {
      { "backdrop", Capture }, { "underrow", Capture }, { "underwatch", Capture }, { "underpaint", Capture }, { "underhint", Capture }, { "winproc", Capture },
      { "icon", Slow }, { "lnk", Slow }, { "app", Slow }, { "pins", Slow }, { "launch", Slow },
      // Tray.cs reads explorer's toolbar with cross-process SendMessage, and
      // may grow a UI Automation fallback: both are slow and thread-agnostic.
      { "tray", Slow }, { "trayClick", Slow },
      { "volume", Audio },
      // AudioMixer.cs: playback devices, the default one, per-app levels. The
      // same CoreAudio RPCs as volume (a session list measured in the qsx lane
      // report, 2026-09-23). `wlan` is NOT listed, on purpose: like `search`
      // its case only validates and hands off to its own pool threads, so it
      // never waits behind an icon load for a 4 s scan to even start.
      // `btdevices` (BtDevices.cs) is unlisted for the same reason.
      { "audio", Audio },
      // Media.cs: WinRT session manager and thumbnails, run on its own MTA
      // thread while the slow lane waits.
      { "media", Slow },
      // Notifications.cs: the listener read (up to ~0.8 s under load) runs on
      // its own MTA thread while the slow lane waits; icons are shell calls.
      { "notifications", Slow },
      // The four window verbs (Windows.cs). Their own lane since 2026-09-27: on
      // ui, a `focus` under Valorant took ~5.2 s (a synchronous ShowWindow and
      // an AttachThreadInput to the game's thread), the bar's `place` queued
      // behind it past its 4 s limit, and main hid the bar instead of parking
      // it. WindowList.Focus no longer blocks either (async restore, a bounded
      // attach), but a verb that acts on another app's window can always meet
      // a thread that will not answer, so none of them may share a lane with
      // the bar's own moves. `focus.rehearse` (the test's stand-in) rides here
      // too, registered from Windows.cs.
      { "focus", Focus }, { "minimize", Focus }, { "close", Focus }, { "toggle", Focus },
    };

    // Commands whose READ is served from a cache (QuickSettings.cs) or is one
    // registry value, so it is instant and stays on ui, but whose SWITCH blocks
    // on the hardware and goes to qs. The value is the argument whose presence
    // makes it a switch.
    static readonly Dictionary<string, string> _switchArg = new Dictionary<string, string>(StringComparer.Ordinal) {
      { "wifi", "on" }, { "bluetooth", "on" }, { "brightness", "level" }, { "nightlight", "on" },
    };

    /// For a command added at run time rather than in the table above.
    public static void Register(string cmd, string lane) {
      lock (_laneOf) _laneOf[cmd] = lane;
    }

    static readonly Dictionary<string, Lane> _workers = new Dictionary<string, Lane>(StringComparer.Ordinal);

    public static int Expired, Merged;         // Interlocked counters, reported by ping
    public static int Refused;                 // Interlocked: requests answered "busy" (a full lane)

    /// THE QUEUE CEILING, per lane (ui included). Until 2026-09-29 every queue was unbounded:
    /// a caller stuck in a loop - or one lane stalled behind a hung call while requests kept
    /// arriving - grew it without limit, and every entry was an answer owed later instead of
    /// now. Past this depth a request is answered "busy" at once (core-sc, test-protocol.js).
    /// Mantle's real peak is a few dozen (icons for every window at start); 1024 is far above
    /// it. Undos (Request.Exempt) are never refused.
    public const int MaxQueued = 1024;

    // The ui lane's own bookkeeping. It is the message loop, so it has no
    // queue object of ours - just a count of posted-but-not-started requests.
    public static int UiQueued;
    public static volatile string UiBusyCmd;
    public static long UiBusySinceTs;

    public static void Start(Action<Request> exec) {
      _workers[Capture] = new Lane(Capture, exec, ApartmentState.STA, ThreadPriority.AboveNormal);
      _workers[Slow] = new Lane(Slow, exec, ApartmentState.STA, ThreadPriority.Normal);
      _workers[Audio] = new Lane(Audio, exec, ApartmentState.MTA, ThreadPriority.AboveNormal);
      // STA like slow, where these switches ran until 2026-09-23 (the WinRT radio
      // and WMI calls were proven there); AboveNormal like audio, because a slider
      // is being dragged.
      _workers[Qs] = new Lane(Qs, exec, ApartmentState.STA, ThreadPriority.AboveNormal);
      // MTA: no COM here, only user32 calls on other processes' windows. AboveNormal: a click
      // on the bar is waiting for it.
      _workers[Focus] = new Lane(Focus, exec, ApartmentState.MTA, ThreadPriority.AboveNormal);
    }

    /// The worker for a lane name, or null for ui (the message loop).
    public static Lane Worker(string lane) {
      Lane w;
      return lane != null && _workers.TryGetValue(lane, out w) ? w : null;
    }

    public static long MsSince(long ts) {
      return (Stopwatch.GetTimestamp() - ts) * 1000 / Stopwatch.Frequency;
    }

    /// Which lane a request runs on.
    public static string For(string cmd, Dictionary<string, object> req) {
      if (cmd == "sleep") {
        // Test-only (passive only, see Program): lets the harness park a
        // chosen lane and prove the others still answer.
        string l = Json.GetString(req, "lane");
        return l == Ui || l == Capture || l == Audio || l == Qs || l == Focus ? l : Slow;
      }
      string arg;
      if (_switchArg.TryGetValue(cmd, out arg)) return Json.HasKey(req, arg) ? Qs : Ui;
      string lane;
      lock (_laneOf) { if (_laneOf.TryGetValue(cmd, out lane)) return lane; }
      return Ui;
    }

    /// Requests that are the same work: a later one may ride on an earlier
    /// one's execution. Only worker lanes coalesce (ui is the message loop).
    /// `anywhere`: the match may be anywhere in the queue (a screen grab has no
    /// order relative to anything else). Otherwise only the LAST queued request
    /// may absorb it, so a read can never overtake a switch queued before it.
    public static string CoalesceKey(string cmd, Dictionary<string, object> req, out bool anywhere) {
      anywhere = false;
      if (cmd == "backdrop") {
        anywhere = true;
        return "backdrop:" + Json.GetInt(req, "x", 0) + "," + Json.GetInt(req, "y", 0) + "," +
               Json.GetInt(req, "w", 0) + "," + Json.GetInt(req, "h", 0) + "," +
               Json.GetInt(req, "scale", Backdrop.DefaultScale);
      }
      if (cmd == "underrow") {
        anywhere = true;
        return "underrow:" + Json.GetInt(req, "x", 0) + "," + Json.GetInt(req, "y", 0) + "," +
               Json.GetInt(req, "w", 0) + "," + Json.GetInt(req, "n", 0);
      }
      // The newest level is the only one that matters to a dragged slider.
      if (cmd == "brightness" && Json.HasKey(req, "level")) return "brightness.set";
      // A now-playing read: the same question asked twice is one answer.
      // Transport ops (play, pause, ...) are never merged.
      if (cmd == "media") {
        string mop = Json.GetString(req, "op");
        if (string.IsNullOrEmpty(mop) || mop == "get")
          return "media.get:" + Json.GetBool(req, "art", true) + ":" + Json.GetInt(req, "artSize", 96) + ":" +
                 Json.GetString(req, "aumid");
        return null;
      }
      // A notification list asked twice is one answer; remove/clear/open never merge.
      if (cmd == "notifications") {
        string nop = Json.GetString(req, "op");
        if (string.IsNullOrEmpty(nop) || nop == "list") return "notifications.list:" + Json.GetBool(req, "fresh", false);
        return null;
      }
      if (cmd == "volume") {
        bool lv = Json.HasKey(req, "level"), mu = Json.HasKey(req, "muted");
        if (!lv && !mu) return "volume.read";
        if (lv && !mu) return "volume.level";
        if (mu && !lv) return "volume.mute";
      }
      // The sound view's reads, asked twice, are one answer; a dragged app
      // slider only needs its newest level. Default changes never merge.
      if (cmd == "audio") {
        string aop = Json.GetString(req, "op");
        if (string.IsNullOrEmpty(aop) || aop == "devices") return "audio.devices";
        if (aop == "sessions") return "audio.sessions";
        if (aop == "session" && Json.HasKey(req, "level") && !Json.HasKey(req, "muted"))
          return "audio.session.level:" + Json.GetString(req, "key");
        return null;
      }
      return null;
    }

    /// Undo requests are always executed, however late: a caller that timed
    /// out on "give the cursor back" still wants the cursor back.
    public static bool IsExempt(string cmd, Dictionary<string, object> req) {
      switch (cmd) {
        case "quit": return true;
        case "edgeclip": return Json.HasKey(req, "on") && !Json.GetBool(req, "on", true);
        case "tbhide": return Json.HasKey(req, "on") && !Json.GetBool(req, "on", true);
        case "taskbar": return Json.GetBool(req, "restore", false);
        case "appbar": return Json.GetBool(req, "remove", false);
        // Turning ANY of the hook's three features off is an undo (Hotkey.cs).
        case "hotkey": return (Json.HasKey(req, "winTap") && !Json.GetBool(req, "winTap", true)) ||
                              (Json.HasKey(req, "altTab") && !Json.GetBool(req, "altTab", true)) ||
                              (Json.HasKey(req, "winKeys") && !Json.GetBool(req, "winKeys", true));
        case "desktop": return Json.GetBool(req, "detach", false);
        case "morph": return Json.GetBool(req, "cancel", false);
        case "workarea": return Json.GetBool(req, "reset", false);
        // The top bar (MenuBar.cs, TopbarStats.cs): giving the strip back, and switching its
        // hooks and its 1 s sampler off, are undos - a caller that timed out still wants them.
        case "topbar.release": return true;
        case "topbar.watch": return Json.HasKey(req, "on") && !Json.GetBool(req, "on", true);
        case "topbar.stats": return Json.HasKey(req, "on") && !Json.GetBool(req, "on", true);
        case "topbar.guard": return Json.HasKey(req, "on") && !Json.GetBool(req, "on", true);
        default: return false;
      }
    }

    public static IDictionary Snapshot() {
      string busy = UiBusyCmd;
      var lanes = new List<object>();
      lanes.Add(Json.Obj("name", Ui, "queued", Thread.VolatileRead(ref UiQueued), "busy", busy,
                         "busyMs", busy == null ? (object)null : (object)MsSince(UiBusySinceTs)));
      foreach (string name in new string[] { Capture, Slow, Audio, Qs, Focus }) {
        Lane w = Worker(name);
        if (w != null) lanes.Add(w.Snapshot());
      }
      return Json.Obj("lanes", lanes,
                      "expired", Thread.VolatileRead(ref Expired),
                      "merged", Thread.VolatileRead(ref Merged),
                      "refused", Thread.VolatileRead(ref Refused),
                      "maxQueued", MaxQueued,
                      // Focus attach helpers the focus lane stopped waiting for and that are still
                      // stuck on another app's thread (WindowList.AttachAndRaise). Non-zero for long
                      // = some app is not answering; each one detaches the moment it returns.
                      "focusHelpersOut", WindowList.HelpersOut);
    }
  }

  /// STALE-WHILE-REVALIDATE for a read that is too slow for any lane (a
  /// PowerShell round trip, a WMI query, a WLAN RPC under load).
  ///
  /// Get() NEVER blocks on the read: it hands back the last answer with its
  /// age (`ageMs`, and `stale:true` past freshMs) and, if that answer is older
  /// than freshMs, starts ONE background refresh. So the cadence is "every
  /// freshMs while somebody is looking, never while nobody is" - no timers,
  /// no work while the Quick Settings panel is closed.
  ///
  /// Put() is for a SWITCH that has just read the hardware back: it replaces
  /// the value and bumps a generation, so a refresh that started BEFORE the
  /// switch and lands after it cannot overwrite the new state with the old.
  sealed class Cached {
    readonly string _name;
    readonly Func<IDictionary> _read;
    readonly int _freshMs;
    readonly object _lock = new object();
    IDictionary _value;
    long _atTs;
    bool _refreshing, _again;
    int _gen;
    long _firstAskTs;

    // Its own long-lived refresh thread, signalled with an event. NOT a new
    // Thread per refresh: Thread.Start blocks until the new thread is running,
    // and under Owen's load that cost 15-20 ms - paid on the ui lane by the
    // read that kicked the refresh (measured 2026-09-22). Set() never blocks.
    readonly AutoResetEvent _kick = new AutoResetEvent(false);

    public Cached(string name, int freshMs, Func<IDictionary> read) {
      _name = name;
      _freshMs = freshMs;
      _read = read;
      var t = new Thread(RefreshLoop);
      t.IsBackground = true;
      t.Name = "mantle-refresh-" + name;
      t.Start();
    }

    /// The cached answer plus `ageMs`/`stale`, or null when nothing has ever
    /// been read (a refresh is then already running; see Pending()).
    public IDictionary Get() {
      IDictionary copy = null;
      bool kick = false;
      lock (_lock) {
        long now = Stopwatch.GetTimestamp();
        if (_value == null && _firstAskTs == 0) _firstAskTs = now;
        long age = _value == null ? long.MaxValue : (now - _atTs) * 1000 / Stopwatch.Frequency;
        if (age >= _freshMs) {
          if (_refreshing) { /* already on its way */ }
          else { _refreshing = true; kick = true; }
        }
        if (_value != null) {
          copy = Json.Obj();
          foreach (DictionaryEntry e in _value) copy[e.Key] = e.Value;
          copy["ageMs"] = age;
          copy["stale"] = age >= _freshMs;
        }
      }
      if (kick) StartRefresh();
      return copy;
    }

    /// How long the very first read has been running, for the placeholder's
    /// reason. 0 when nobody has asked yet.
    public long PendingMs() {
      lock (_lock) return _firstAskTs == 0 ? 0 : Lanes.MsSince(_firstAskTs);
    }

    /// Start a refresh now if none is running; if one is, run another straight
    /// after it (its answer may predate whatever made the caller ask).
    public void Refresh() {
      bool kick = false;
      lock (_lock) {
        if (_refreshing) _again = true;
        else { _refreshing = true; kick = true; }
      }
      if (kick) StartRefresh();
    }

    public void Put(IDictionary v) {
      lock (_lock) {
        _gen++;
        _value = v;
        _atTs = Stopwatch.GetTimestamp();
      }
    }

    /// For a reader that is not this cache's refresh thread (QuickSettings' watch):
    /// take Gen() before the read and Offer() the result after. Like a refresh, it
    /// is dropped if a switch Put() a newer read-back while it was in flight, and
    /// Offer() says so, so the watch never pushes a state older than the cache's.
    public int Gen() {
      lock (_lock) return _gen;
    }

    public bool Offer(int gen, IDictionary v) {
      if (v == null) return false;
      lock (_lock) {
        if (gen != _gen) return false;
        _value = v;
        _atTs = Stopwatch.GetTimestamp();
        return true;
      }
    }

    /// A copy of the value if it is at most maxAgeMs old, else null. Never kicks a refresh.
    public IDictionary PeekFresh(int maxAgeMs) {
      lock (_lock) {
        if (_value == null || Lanes.MsSince(_atTs) > maxAgeMs) return null;
        var copy = Json.Obj();
        foreach (DictionaryEntry e in _value) copy[e.Key] = e.Value;
        return copy;
      }
    }

    public IDictionary Peek() {
      lock (_lock) {
        if (_value == null) return null;
        var copy = Json.Obj();
        foreach (DictionaryEntry e in _value) copy[e.Key] = e.Value;
        return copy;
      }
    }

    public IDictionary Snapshot() {
      lock (_lock) {
        return Json.Obj("ageMs", _value == null ? (object)null : (object)Lanes.MsSince(_atTs),
                        "refreshing", _refreshing, "freshMs", _freshMs);
      }
    }

    void StartRefresh() {
      _kick.Set();
    }

    void RefreshLoop() {
      for (;;) {
        _kick.WaitOne();
        int gen;
        lock (_lock) gen = _gen;
        RefreshOnce(gen);
      }
    }

    void RefreshOnce(int gen) {
      IDictionary v;
      try {
        v = _read();
      } catch (Exception ex) {
        // The readers catch their own failures; this is the belt for a bug.
        v = Json.Obj("ok", false, "reason", _name + " could not be read (" + ex.GetType().Name + ": " + ex.Message + ")");
      }
      bool again;
      lock (_lock) {
        // A switch landed while this read was in flight: its read-back is
        // newer than ours, so ours is thrown away.
        if (v != null && gen == _gen) {
          _value = v;
          _atTs = Stopwatch.GetTimestamp();
        }
        again = _again;
        _again = false;
        _refreshing = again;
      }
      if (again) StartRefresh();   // the loop picks it up straight away
    }
  }
}
