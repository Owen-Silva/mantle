// Notifications.cs - Mantle's own notification centre: the toasts Windows is
// holding in its notification centre, read, dismissed and opened from the bar.
//
//   {cmd:"notifications"}                                 list (op defaults to "list")
//   {cmd:"notifications", op:"list", fresh:true}          fresh: re-read now instead of the watch's copy
//   {cmd:"notifications", op:"watch", on:true|false}      emits {ev:"notifications", rev, count, ok, reason}
//                                                         ONLY when the set of toasts (or its health) changes,
//                                                         and {ev:"notifications.coming", rev, aumid} the moment
//                                                         a NEW toast shows in the signature, BEFORE the list is
//                                                         read (see TOAST INCOMING below)
//   {cmd:"notifications", op:"remove", ids:[n, ...]}      dismiss these toasts
//   {cmd:"notifications", op:"clear", aumid:"<optional>"} dismiss every toast (or one app's)
//   {cmd:"notifications", op:"open", toast:n}             what clicking it in Windows would do, as far as
//                                                         Windows lets another app (see OPEN below)
//
// remove / clear / open ACT, so --passive refuses them - except on toasts
// posted under TestAumid, which only a test ever posts. That exception exists
// because the alternative, a non-passive test sidecar, clears the LIVE
// Mantle's cursor clip at startup (Program.cs, EdgeClip.ClearStaleAtStartup),
// and because nothing else can prove remove/open without touching a toast of
// the user's.
//
// ------------------------------------------------------------------ MEASURED
// All on this machine, 2026-09-22, under the user's usual load (~70% CPU):
//
// THE LIST: Windows.UI.Notifications.Management.UserNotificationListener.
//   GetAccessStatus() = Allowed for this unpackaged exe. RequestAccessAsync is
//   NEVER called: access is already allowed, and asking can put a consent
//   prompt in front of the user. Denied/Unspecified is reported with the Settings
//   page that fixes it.
//   GetNotificationsAsync(Toast): 1 toast 33-193 ms (median 67); 21 toasts
//   233-765 ms wall and ~120-150 ms of THIS process's CPU per read. Reading
//   one toast's app name + text elements costs another 36-65 ms (every
//   property is a cross-process call). NotificationChanged FAILS
//   (0x80070490 Element not found) for an unpackaged exe, so the centre has
//   to poll - and polling that API every second would burn ~10% of a core
//   with 20 toasts up. Hence the change signal below.
//   The listener exposes text elements only: no images, no launch arguments,
//   no attribution line, no buttons. AppInfo.DisplayInfo.GetLogo() throws for
//   desktop apps (NullReference) and needs System.Runtime.WindowsRuntime for
//   its Size argument, so icons come from the shell instead (Apps.Info).
//
// THE CHANGE SIGNAL + THE REST OF EACH TOAST: the notification platform's own
//   database, %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db
//   (SQLite, WAL), read through the winsqlite3.dll that ships in System32.
//   Opened READ-ONLY (mode=ro): 6-25 ms to open; the signature query
//   (count, max rowid, sum of ids over the toast rows) 0.06 ms median, ~0.08 ms
//   CPU - it changed within one 100 ms poll of a toast being posted and of one
//   being removed. Notification.Id IS the listener's UserNotification.Id, and
//   Notification.Payload is the toast's full XML: launch arguments,
//   activationType, attribution text, images (hero, appLogoOverride, inline)
//   and actions. It is UNDOCUMENTED, so it is only ever an extra: the listener
//   stays the source of truth for WHICH toasts exist, and without the database
//   everything still works, slower (a listener poll every SlowPollMs) and
//   plainer (text only), and the reply says so.
//   A FileSystemWatcher on that folder saw ZERO events for a post and a remove
//   (the WAL is written through a mapped view), so it is no signal at all.
//
// TOAST INCOMING (lane mantle-toastfast, 2026-10-16: the user's banners should be up
//   within 300 ms of a toast). The chain was: the poll wait (0-400 ms) + the
//   listener read (median 67 ms) + main making the banner window when none is
//   open (median 206 ms), all in series. Now:
//   - PollMs is 100 (was 400): the signature costs ~0.06 ms, so ten looks a
//     second stay a rounding error of a core (measured before/after in the
//     lane's hold, see the commit).
//   - when the signature's max [Order] rises (a toast was ADDED, not removed),
//     {ev:"notifications.coming", rev, aumid} goes out BEFORE Refresh(), so main
//     starts the banner window while the listener read runs. aumid is the new
//     row's app (NotificationHandler.PrimaryId, the same join SysNotify.cs
//     reads) or null if that read failed; main uses it to skip apps it draws no
//     banner for. It is a hint only: the banner itself still waits for the
//     listener's list, the source of truth.
//   - NotificationChanged is TRIED once per process when the watch starts. If
//     Windows accepts the handler, an "added" change wakes the thread at once
//     (the poll stays on as the safety net); if it throws, the watch reply
//     says so (changes:"poll", changesWhy) and the poll alone carries it.
//     Re-checked 2026-10-16 from this exe (passive, watch on): it still throws
//     0x80070490 Element not found (no package identity), so today the 100 ms
//     poll is the path; the try stays so a packaged/identity build gets the
//     event without a code change.
//
// DISMISS: RemoveNotification(id) 8-37 ms, and the toast is gone from Windows'
//   own centre too. It does NOT throw for an id that does not exist, so every
//   removal is verified with GetNotification(id) == null.
//   ClearNotifications() is deliberately NOT used: it was never exercised
//   (with the user's own toasts present it would have wiped them), and it would
//   also clear a toast that arrived after the panel was drawn. "Clear all"
//   dismisses exactly the ids it was given, one RemoveNotification each.
//
// OPEN: the listener has no "activate". What Windows does on a click, and
//   what this does:
//   - activationType="protocol": Windows launches the `launch` URI. So does
//     this, through Windows.System.Launcher.LaunchUriAsync (Windows' own URI
//     launcher, with its own refusal of file: and executables): 394 ms from an
//     unpackaged MTA exe, handler received the URI (System.Uri adds a "/" to an
//     empty path: scheme://host?q becomes scheme://host/?q, the same URI).
//     The user's one real toast today (Windows Security) is this kind.
//   - anything else: Windows hands the app the launch arguments, through the
//     app's COM activator (INotificationActivationCallback, CLSID in the
//     AppUserModelId registry key or the Start-menu shortcut) or a UWP toast
//     activation. Mantle could NOT prove that route: a test activator of our
//     own registered its class object (S_OK) but DCOM never connected to it
//     (CO_E_SERVER_EXEC_FAILURE after 45 s, System log event 10010, three
//     tries). So this launches the APP by its AUMID (Apps.Launch, the route
//     the pins use) and says so: the app opens where it opens, not on the
//     message.
//   - no launchable app (a tray balloon's NotifyIconGeneratedAumid_*, a
//     system AUMID the shell does not know): refused, with that reason.
//   A toast that was opened is then dismissed, as Windows does on a click.
//
// Of the 63 apps that have ever notified on this machine: 17 packaged, 46
// unpackaged; 16 of those have a COM activator in the registry and Discord and
// Opera GX have one on their shortcut; 11 are tray balloons.
//
// THREADING: every WinRT call runs on ONE background MTA thread
// ("notifications"), like Media.cs and for the same reason (the listener's
// objects are not agile, and an STA lane would have to pump). The database
// connection lives on that thread too. The poll runs there while watching;
// requests queue behind it and the lane that asked just waits, except a
// watched `list`, served from the last read (THE WATCHED LIST). Shell calls
// (icons, launching an app) are apartment-threaded, so they run on the
// CALLER's STA lane after the thread has answered.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Xml;
using Microsoft.Win32;
using SD = System.Drawing;
#if MANTLE_WINMD
using Windows.Foundation;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;
#endif

namespace Mantle {
  static class Notifications {
    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    /// The AUMID only a test posts under. In --passive, remove/clear/open act
    /// on toasts of THIS app id and refuse every other one.
    public const string TestAumid = "Mantle.SidecarTest";

    /// The one entry point for `notifications`. Returns an error string for a
    /// malformed request (the dispatcher turns it into ok:false); every "cannot
    /// do that right now" is an answer in `result` with ok:false and a reason.
    public static string Run(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "list";
      // `stall` is a TEST op, passive only (see Stall).
      if (op != "list" && op != "watch" && op != "remove" && op != "clear" && op != "open" && !(op == "stall" && Program.Passive))
        return "notifications: unknown op '" + op + "' (use list, watch, remove, clear or open)";
      if (op == "watch" && !Json.HasKey(req, "on")) return "notifications: watch needs on:true or on:false";

      var ids = new List<uint>();
      if (op == "remove") {
        object raw;
        var list = Json.TryGet(req, "ids", out raw) ? raw as IList : null;
        if (list == null || list.Count == 0) return "notifications: remove needs ids, a non-empty list of notification ids";
        foreach (var o in list) {
          uint one;
          if (!ToId(o, out one)) return "notifications: remove got an id that is not a notification id (" + Json.Write(o) + ")";
          if (!ids.Contains(one)) ids.Add(one);
        }
      }
      uint openId = 0;
      if (op == "open") {
        object raw;
        // `toast`, NOT `id`: `id` is the PROTOCOL's request id, and a toast id
        // sent as `id` would send the reply to the wrong caller (the trayClick
        // lesson in Program.cs, repeated here on 2026-09-22 by this file's own
        // first test run).
        if (!Json.TryGet(req, "toast", out raw) || !ToId(raw, out openId))
          return "notifications: open needs toast, the notification's id";
      }
      string aumid = Json.GetString(req, "aumid");
      if (op == "clear" && Program.Passive && aumid != TestAumid)
        return PassiveRefusal + ": clear would dismiss live notifications";

#if MANTLE_WINMD
      switch (op) {
        case "list": result = List(Json.GetBool(req, "fresh", false)); break;
        case "watch": result = Watch(Json.GetBool(req, "on", true)); break;
        case "remove": result = Remove(ids, "remove"); break;
        case "clear": result = Clear(aumid); break;
        case "stall": result = Stall(Json.GetInt(req, "ms", 0)); break;
        default: result = Open(openId); break;
      }
      return null;
#else
      if (Program.Passive && op != "list" && op != "watch")
        return PassiveRefusal + ": " + op + " would change live notifications";
      result = Json.Obj("ok", false, "available", false, "reason", Unavailable);
      return null;
#endif
    }

    static bool ToId(object o, out uint id) {
      id = 0;
      if (!(o is double)) return false;
      double d = (double)o;
      if (d < 1 || d > uint.MaxValue || d != Math.Floor(d)) return false;
      id = (uint)d;
      return true;
    }

#if !MANTLE_WINMD
    const string Unavailable =
      "the notification centre is not built into this sidecar: build.ps1 did not find the WinRT metadata " +
      "(System32\\WinMetadata\\Windows.UI.winmd and its companions) or the System.Runtime facade, " +
      "so MANTLE_WINMD was not defined";
#else
    const int CallMs = 3000;          // one WinRT call (the list read peaked at 765 ms under load)
    const int RequestMs = 3500;       // a whole request, under the client's timeout
    const int PollMs = 100;           // the database signature: ~0.06 ms a look (was 400: TOAST INCOMING)
    const int SlowPollMs = 5000;      // no database: the listener itself, ~70-800 ms a read
    const int ReconcileMs = 60000;    // a full listener read even when the signature says "same"
    const int DbRetryMs = 60000;      // a database that would not open is tried again this often
    const long MaxImageBytes = 8L * 1024 * 1024;
    const int MaxLines = 6, MaxLineChars = 400;

    // ------------------------------------------------------------ the thread

    static readonly object _gate = new object();
    static readonly Queue<Action> _work = new Queue<Action>();          // under _gate
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;                                              // under _gate
    static volatile string _busy;
    static volatile bool _watching;

    /// Runs `fn` on the notifications thread and waits for it. A late answer
    /// is dropped (the work writes only to its own locals and the thread's
    /// own state, which stays consistent either way).
    static void EnsureThread() {
      lock (_gate) {
        if (_thread == null) {
          _thread = new Thread(Loop);
          _thread.Name = "notifications";
          _thread.IsBackground = true;
          _thread.SetApartmentState(ApartmentState.MTA);
          _thread.Start();
        }
      }
    }

    /// TESTS ONLY (passive only, Run refuses it otherwise): parks the notifications thread for `ms`
    /// WITHOUT waiting for it, so test-lane-latency.js can prove a watched `list` never waits behind
    /// whatever the thread is doing.
    static IDictionary Stall(int ms) {
      ms = Math.Max(0, Math.Min(10000, ms));
      EnsureThread();
      lock (_gate) _work.Enqueue(delegate { _busy = "a test stall"; Thread.Sleep(ms); _busy = null; });
      _wake.Set();
      return Json.Obj("ok", true, "stalledMs", ms);
    }

    static IDictionary OnThread(string what, Func<IDictionary> fn) {
      EnsureThread();
      var done = new ManualResetEvent(false);
      IDictionary answer = null;
      lock (_gate) {
        _work.Enqueue(delegate {
          _busy = what;
          try {
            answer = fn();
          } catch (Exception ex) {
            answer = Json.Obj("ok", false, "reason", "notifications: " + what + " failed (" + Why(ex) + ")");
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
                        "notifications: " + what + " did not finish within " + (RequestMs / 1000.0) + " s" +
                        (busy != null ? " (the notifications thread is still busy with " + busy + ")" : ""));
      }
      done.Close();
      return answer;
    }

    static void Loop() {
      while (true) {
        int wait = Timeout.Infinite;
        if (_watching) wait = _db != null ? PollMs : SlowPollMs;
        _wake.WaitOne(wait);
        while (true) {
          Action a;
          lock (_gate) {
            if (_work.Count == 0) break;
            a = _work.Dequeue();
          }
          a();
        }
        if (!_watching) continue;
        try {
          Tick();
        } catch (Exception ex) {
          NoteTrouble("the notification poll failed (" + Why(ex) + ")");
        }
      }
    }

    static string _lastTrouble;                                         // thread only
    /// Logs a poll failure ONCE per distinct reason (a failing poll would
    /// otherwise log 150 times a minute); the reason also rides in every reply.
    static void NoteTrouble(string why) {
      _snapTrouble = why;
      if (why == _lastTrouble) return;
      _lastTrouble = why;
      Program.EmitLog("warn", "notifications: " + why);
    }

    // ------------------------------------------------------------ the state
    // All of it is touched on the notifications thread only.

    static NotifDb _db;
    static string _dbReason;          // why the database is not in use (null = it is)
    static long _dbRetryTs;
    static string _sig;               // the database signature the snapshot was built at
    static bool _haveSnap;
    static long _nextSlowTs, _nextReconcileTs;
    static long _rev;
    static string _setSig = "";       // the id set + health the last event described
    static readonly List<IDictionary> _toasts = new List<IDictionary>();          // newest first
    static readonly Dictionary<uint, IDictionary> _byId = new Dictionary<uint, IDictionary>();
    static readonly Dictionary<uint, string[]> _launchOf = new Dictionary<uint, string[]>();  // id -> {launch, activationType}
    static readonly Dictionary<string, string> _nameOf = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    static string _access = "unknown";
    static string _snapReason;        // why the list is empty/unavailable (null = fine)
    static string _snapTrouble;       // the last poll failure, if the last poll failed

    static long Now() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }

    /// One poll: the cheap signature, and a real read only when it moved.
    static void Tick() {
      string sig = DbSignature();
      long now = Now();
      bool kicked = _kick, added = _kickAdded;
      _kick = false; _kickAdded = false;
      bool due = kicked || !_haveSnap || now >= _nextReconcileTs ||
                 (sig != null ? sig != _sig : now >= _nextSlowTs);
      if (!due) return;
      // TOAST INCOMING: say so BEFORE the 70-800 ms listener read, so main can start the banner window.
      if (_haveSnap && (sig != null ? Added(sig) : added)) EmitComing();
      Refresh(sig);
    }

    /// The signature's max [Order] ("count/maxOrder/sumIds"), or -1 when there is none to compare.
    static long MaxOrder(string sig) {
      if (sig == null) return -1;
      string[] p = sig.Split('/');
      long v;
      return p.Length == 3 && long.TryParse(p[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : -1;
    }

    /// A toast was ADDED since the snapshot's signature: its max [Order] rose. False when either side
    /// has no signature (the database just opened or came back: that is not a new toast).
    static bool Added(string sig) {
      long was = MaxOrder(_sig);
      return was >= 0 && MaxOrder(sig) > was;
    }

    static string _comingTrouble;     // the last reason the new toast's app could not be read (logged once)
    static long _comings;             // how many "coming" events went out (the watch reply carries it)

    /// Thread. {ev:"notifications.coming"}: a toast was just ADDED; the list read follows at once.
    static void EmitComing() {
      if (!_watching) return;
      string aumid = null;
      if (_db != null) {
        try {
          aumid = _db.NewestAumid();
          _comingTrouble = null;
        } catch (Exception ex) {
          // Not fatal and not the list's health: main makes the window without knowing the app.
          string why = "the new toast's app could not be read from the database (" + Why(ex) + "); main is told a toast is coming without it";
          if (why != _comingTrouble) { _comingTrouble = why; Program.EmitLog("warn", "notifications: " + why); }
        }
      }
      _comings++;
      Program.Emit(Json.Obj("ev", "notifications.coming", "rev", _rev, "aumid", aumid));
    }

    // ---- NotificationChanged: tried once per process (TOAST INCOMING)
    static volatile bool _kick, _kickAdded;   // set by the event's thread, read by Tick
    static string _changes;                   // null = not tried yet, "event" or "poll"
    static string _changesWhy;                // why it is "poll" (null when the event is on)

    /// Thread. Subscribes NotificationChanged if Windows lets this exe; says why not otherwise.
    static void TryChangeEvent() {
      if (_changes != null) return;
      try {
        UserNotificationListener.Current.NotificationChanged += OnChanged;
        _changes = "event";
        _changesWhy = null;
        Program.EmitLog("info", "notifications: Windows sends notification changes; the " + PollMs + " ms check stays on as a safety net");
      } catch (Exception ex) {
        _changes = "poll";
        _changesWhy = "Windows would not send Mantle notification changes (" + Why(ex) + "), so Mantle checks for new ones every " + PollMs + " ms";
        Program.EmitLog("info", "notifications: " + _changesWhy);
      }
    }

    /// Windows' thread: an added toast wakes the notifications thread now instead of at the next poll.
    static void OnChanged(UserNotificationListener sender, UserNotificationChangedEventArgs args) {
      try {
        if (args.ChangeKind == UserNotificationChangedKind.Added) _kickAdded = true;
      } catch (Exception) { _kickAdded = true; }
      _kick = true;
      _wake.Set();
    }

    /// Thread. The signature, or null when the database cannot be used (the
    /// reason is in _dbReason, and the poll falls back to the listener).
    static string DbSignature() {
      if (_db == null) {
        if (Now() < _dbRetryTs) return null;
        string why;
        _db = NotifDb.Open(out why);
        _dbReason = why;
        if (_db != null && _db.ShmWhy != null)
          Program.EmitLog("info", "notifications: " + _db.ShmWhy + "; each 100 ms look asks SQLite instead (a little more CPU, same speed)");
        if (_db == null) {
          _dbRetryTs = Now() + DbRetryMs;
          return null;
        }
      }
      try {
        return _db.Signature();
      } catch (Exception ex) {
        DropDb("the notification database stopped answering (" + Why(ex) + ")");
        return null;
      }
    }

    static void DropDb(string why) {
      try { if (_db != null) _db.Dispose(); } catch (Exception) { }
      _db = null;
      _dbReason = why;
      _dbRetryTs = Now() + DbRetryMs;
    }

    /// Thread. Re-reads the list from the listener and rebuilds the snapshot,
    /// reusing the parsed detail of every toast it already knew. Emits the
    /// change event when the set (or its health) changed and a watch is on.
    static void Refresh(string sig) {
      _sig = sig;
      long now = Now();
      _nextSlowTs = now + SlowPollMs;
      _nextReconcileTs = now + ReconcileMs;
      _haveSnap = true;
      _snapTrouble = null;

      var listener = UserNotificationListener.Current;
      UserNotificationListenerAccessStatus access;
      try {
        access = listener.GetAccessStatus();
      } catch (Exception ex) {
        SetEmpty("unknown", "Windows would not say whether Mantle may read notifications (" + Why(ex) + ")");
        return;
      }
      _access = access.ToString();
      if (access != UserNotificationListenerAccessStatus.Allowed) {
        SetEmpty(_access, access == UserNotificationListenerAccessStatus.Denied
          ? "Windows is not letting apps read your notifications (Settings > Privacy & security > Notifications > " +
            "Let apps access your notifications is off)"
          : "Windows has not been asked whether Mantle may read your notifications, and Mantle never asks " +
            "(it would pop a prompt): turn on Settings > Privacy & security > Notifications > Let apps access your notifications");
        return;
      }

      IReadOnlyList<UserNotification> list;
      string err = WinRt.Await(listener.GetNotificationsAsync(NotificationKinds.Toast), CallMs,
                               "reading Windows' notification list", out list);
      if (err != null) {
        // Keep the last good list on screen, but say it is stale.
        _snapTrouble = err;
        NoteTrouble(err);
        EmitIfChanged();
        return;
      }

      Dictionary<long, string> payloads = null;
      if (_db != null) {
        try {
          payloads = _db.Payloads();
        } catch (Exception ex) {
          DropDb("the notification database stopped answering (" + Why(ex) + ")");
        }
      }

      var seen = new HashSet<uint>();
      var fresh = new List<IDictionary>();
      foreach (var n in list) {
        uint id;
        try { id = n.Id; } catch (Exception) { continue; }
        seen.Add(id);
        IDictionary d;
        if (!_byId.TryGetValue(id, out d) || (payloads != null && (string)d["textFrom"] == "listener" && payloads.ContainsKey(id))) {
          string xml = null;
          if (payloads != null) payloads.TryGetValue(id, out xml);
          d = Detail(n, id, xml);
          _byId[id] = d;
        }
        fresh.Add(d);
      }
      foreach (var k in new List<uint>(_byId.Keys)) if (!seen.Contains(k)) { _byId.Remove(k); _launchOf.Remove(k); }

      fresh.Sort(delegate (IDictionary a, IDictionary b) {
        int c = ((long)b["timeMs"]).CompareTo((long)a["timeMs"]);
        return c != 0 ? c : ((uint)b["id"]).CompareTo((uint)a["id"]);
      });
      _toasts.Clear();
      _toasts.AddRange(fresh);
      _snapReason = null;
      _lastTrouble = null;
      EmitIfChanged();
    }

    static void SetEmpty(string access, string reason) {
      _access = access;
      _toasts.Clear();
      _byId.Clear();
      _launchOf.Clear();
      _snapReason = reason;
      EmitIfChanged();
    }

    static string Via() { return _db != null ? "listener+database" : "listener"; }

    static void EmitIfChanged() {
      var sb = new StringBuilder();
      foreach (var t in _toasts) sb.Append(t["id"]).Append(',');
      sb.Append('|').Append(_access).Append('|').Append(_snapReason).Append('|').Append(_dbReason).Append('|').Append(_snapTrouble);
      string s = sb.ToString();
      bool changed = s != _setSig;
      if (changed) { _setSig = s; _rev++; }
      // Published BEFORE the change event, so the read that event triggers already sees it.
      _pub = Snapshot();
      if (!changed || !_watching) return;
      Program.Emit(Json.Obj("ev", "notifications", "rev", _rev, "count", _toasts.Count,
                            "ok", _snapReason == null && _snapTrouble == null,
                            "reason", _snapReason ?? _snapTrouble));
    }

    // ------------------------------------------------------------------ ops

    /// THE WATCHED LIST, WITHOUT WAITING (lane mantle-lanes, 2026-10-15). While the watch is on, the
    /// thread re-reads the list whenever it changes and publishes the result here; a plain `list` is
    /// served from it and never queues behind the thread. Before, every `list` waited for whatever the
    /// thread was doing (a 70-800 ms listener read, a database read), and held the slow lane meanwhile:
    /// 1.6-3.7 s, 10 times in 3 days. `fresh`, an unwatched list and the first read still go to the thread.
    static volatile IDictionary _pub;

    static IDictionary List(bool fresh) {
      IDictionary pub = _pub;
      IDictionary snap;
      if (!fresh && _watching && pub != null) snap = CopyOf(pub);
      else {
        snap = OnThread("reading the notifications", delegate {
          if (fresh || !_watching || !_haveSnap) Refresh(DbSignature());
          return Snapshot();
        });
      }
      FillApps(snap["toasts"] as IList);
      return snap;
    }

    /// A copy of a published snapshot and of each toast record in it: the caller's lane adds the app
    /// icons to the copy, and the published one is shared by every reader.
    static IDictionary CopyOf(IDictionary pub) {
      var c = new OrderedDictionary();
      foreach (DictionaryEntry e in pub) c[e.Key] = e.Value;
      var toasts = new List<object>();
      var src = pub["toasts"] as IList;
      if (src != null) {
        foreach (object o in src) {
          var t = new OrderedDictionary();
          foreach (DictionaryEntry e in (IDictionary)o) t[e.Key] = e.Value;
          toasts.Add(t);
        }
      }
      c["toasts"] = toasts;
      c["watching"] = _watching;
      return c;
    }

    /// Thread. COPIES of the toast records: the caller's lane adds the app
    /// icons to them, and the cached originals must never be written from two
    /// threads.
    static IDictionary Snapshot() {
      var copies = new List<object>();
      foreach (var t in _toasts) {
        var c = new OrderedDictionary();
        foreach (DictionaryEntry e in t) c[e.Key] = e.Value;
        copies.Add(c);
      }
      string trouble = _snapTrouble;
      return Json.Obj(
        "ok", _snapReason == null && trouble == null,
        "available", true,
        "access", _access,
        "rev", _rev,
        "count", copies.Count,
        "toasts", copies,
        "via", Via(),
        "watching", _watching,
        // Why the list is plainer or slower than it could be: shown, not hidden.
        "detail", _db != null ? null
          : "text only, and new notifications show within " + (SlowPollMs / 1000) + " s rather than at once: " +
            (_dbReason ?? "the notification database is not open yet"),
        "reason", _snapReason ?? (trouble != null ? "showing the last list Mantle could read: " + trouble : null));
    }

    static IDictionary Watch(bool on) {
      _watching = on;
      return OnThread(on ? "starting the notification watch" : "stopping the notification watch", delegate {
        if (on) {
          TryChangeEvent();
          string sig = DbSignature();
          // A watch re-armed after a pause: a toast added meanwhile is "coming" like any other.
          if (_haveSnap && sig != null && Added(sig)) EmitComing();
          Refresh(sig);
        }
        return Json.Obj("ok", _snapReason == null, "watching", on, "rev", _rev,
                        "via", Via(), "pollMs", _db != null ? PollMs : SlowPollMs,
                        // TOAST INCOMING: this exe emits notifications.coming (main checks for it), and
                        // whether Windows' change event is on or the poll alone carries the watch, and why.
                        "coming", _db != null || _changes == "event", "comings", _comings,
                        "changes", _changes, "changesWhy", _changesWhy,
                        // how each look is made: the WAL-index header, else data_version, else the full query
                        "looks", _db == null ? null : _db.Looks,
                        "looksWhy", _db == null ? null : _db.LooksWhy,
                        "detail", _db != null ? null : _dbReason,
                        "reason", _snapReason);
      });
    }

    static bool PassiveBlocks(string aumid) {
      return Program.Passive && !string.Equals(aumid, TestAumid, StringComparison.OrdinalIgnoreCase);
    }

    /// Dismisses exactly these ids. Each one is checked before (so a toast that
    /// is already gone is reported as missing, not as removed) and after (the
    /// API does not throw for an unknown id, so "no error" proves nothing).
    static IDictionary Remove(List<uint> ids, string what) {
      return OnThread("dismissing " + ids.Count + " notification" + (ids.Count == 1 ? "" : "s"), delegate {
        var listener = UserNotificationListener.Current;
        var removed = new List<object>();
        var missing = new List<object>();
        var failed = new List<object>();
        foreach (uint id in ids) {
          UserNotification n = null;
          try { n = listener.GetNotification(id); } catch (Exception) { }
          if (n == null) { missing.Add(id); continue; }
          string aumid = AumidOf(n);
          if (PassiveBlocks(aumid)) {
            failed.Add(Json.Obj("id", id, "reason", PassiveRefusal + ": " + what + " would dismiss a live notification"));
            continue;
          }
          try {
            listener.RemoveNotification(id);
          } catch (Exception ex) {
            failed.Add(Json.Obj("id", id, "reason", "Windows refused to dismiss it (" + Why(ex) + ")"));
            continue;
          }
          UserNotification after = null;
          try { after = listener.GetNotification(id); } catch (Exception) { }
          if (after == null) removed.Add(id);
          else failed.Add(Json.Obj("id", id, "reason", "Windows accepted the dismissal but the notification is still there"));
        }
        if (removed.Count > 0) Refresh(DbSignature());
        string reason = null;
        if (failed.Count > 0) reason = failed.Count + " of " + ids.Count + " could not be dismissed: " + (string)((IDictionary)failed[0])["reason"];
        return Json.Obj("ok", failed.Count == 0, "removed", removed, "missing", missing, "failed", failed, "reason", reason);
      });
    }

    static IDictionary Clear(string aumid) {
      IDictionary pick = OnThread("listing what to clear", delegate {
        Refresh(DbSignature());
        var ids = new List<object>();
        foreach (var t in _toasts)
          if (string.IsNullOrEmpty(aumid) || string.Equals((string)t["aumid"], aumid, StringComparison.OrdinalIgnoreCase)) ids.Add(t["id"]);
        return Json.Obj("ok", _snapReason == null, "ids", ids, "reason", _snapReason);
      });
      if (!(pick["ok"] is bool) || !(bool)pick["ok"]) return pick;
      var list = new List<uint>();
      foreach (var o in (IList)pick["ids"]) list.Add((uint)o);
      if (list.Count == 0) return Json.Obj("ok", true, "removed", new List<object>(), "missing", new List<object>(), "failed", new List<object>(), "reason", null);
      return Remove(list, "clear");
    }

    // ----------------------------------------------------------------- open

    static IDictionary Open(uint id) {
      IDictionary what = OnThread("finding notification " + id, delegate {
        UserNotification n = null;
        try { n = UserNotificationListener.Current.GetNotification(id); } catch (Exception) { }
        if (n == null) return Json.Obj("ok", false, "id", id, "reason", "that notification is gone (dismissed or expired)");
        string aumid = AumidOf(n);
        // Fresh from the database: the launch arguments are not in the listener.
        string launch = null, activation = null;
        string[] la;
        if (_launchOf.TryGetValue(id, out la)) { launch = la[0]; activation = la[1]; }
        if (_db != null) {
          try {
            string xml = _db.PayloadFor(id);
            if (xml != null) {
              var doc = LoadXml(xml);
              launch = Attr(doc.DocumentElement, "launch");
              activation = Attr(doc.DocumentElement, "activationType");
            }
          } catch (Exception) { }
        }
        string name;
        _nameOf.TryGetValue(aumid ?? "", out name);
        return Json.Obj("ok", true, "id", id, "aumid", aumid, "app", name ?? aumid, "launch", launch, "activation", activation);
      });
      if (!(what["ok"] is bool) || !(bool)what["ok"]) return what;
      string app = (string)what["aumid"];
      string appName = (string)what["app"];
      if (PassiveBlocks(app)) return Json.Obj("ok", false, "id", id, "reason", PassiveRefusal + ": open would start an app on the live desktop");

      string uri = what["launch"] as string;
      bool protocol = string.Equals(what["activation"] as string, "protocol", StringComparison.OrdinalIgnoreCase);
      string via, err, note = null;
      if (protocol && !string.IsNullOrEmpty(uri)) {
        via = "protocol";
        IDictionary r = OnThread("opening the notification's link", delegate {
          Uri u;
          if (!Uri.TryCreate(uri, UriKind.Absolute, out u))
            return Json.Obj("ok", false, "reason", appName + "'s notification links to something that is not a web-style address, so Mantle will not launch it");
          bool launched;
          string lerr = WinRt.Await(Windows.System.Launcher.LaunchUriAsync(u), CallMs, "Windows' URI launcher", out launched);
          if (lerr != null) return Json.Obj("ok", false, "reason", lerr);
          return Json.Obj("ok", launched, "reason", launched ? null : "Windows would not open the notification's " + u.Scheme + ": link (no app takes it, or it is blocked)");
        });
        err = (r["ok"] is bool && (bool)r["ok"]) ? null : (string)r["reason"];
      } else {
        via = "app";
        string known;
        err = LaunchableWhy(app, out known);
        if (err == null) err = Apps.Launch(app);
        note = "Windows would also have told " + (appName ?? "the app") + " which notification was clicked; Mantle cannot pass that on yet, so the app opens where it usually opens";
      }
      if (err != null) return Json.Obj("ok", false, "id", id, "via", via, "reason", err);

      // Windows dismisses a toast that was clicked; so does Mantle.
      IDictionary rm = Remove(new List<uint> { id }, "open");
      bool gone = rm["removed"] is IList && ((IList)rm["removed"]).Count > 0;
      return Json.Obj("ok", true, "id", id, "via", via, "dismissed", gone, "note", note,
                      "reason", gone ? null : "it opened, but it could not be dismissed: " + rm["reason"]);
    }

    // ------------------------------------------------------------- one toast

    static string AumidOf(UserNotification n) {
      try {
        var ai = n.AppInfo;
        return ai == null ? null : ai.AppUserModelId;
      } catch (Exception) { return null; }
    }

    /// Thread. The record for one toast: listener identity + the database's
    /// payload when there is one, the listener's text elements when not.
    static IDictionary Detail(UserNotification n, uint id, string xml) {
      string aumid = AumidOf(n) ?? "";
      string name;
      if (!_nameOf.TryGetValue(aumid, out name)) {
        try { name = n.AppInfo.DisplayInfo.DisplayName; } catch (Exception) { name = null; }
        if (string.IsNullOrEmpty(name)) name = null;
        _nameOf[aumid] = name;
      }
      long timeMs = 0;
      try { timeMs = (n.CreationTime.UtcTicks - 621355968000000000L) / 10000; } catch (Exception) { }

      var d = Json.Obj("id", id, "aumid", aumid, "app", name ?? FallbackName(aumid), "timeMs", timeMs,
                       "title", null, "body", null, "attribution", null,
                       "logo", null, "logoCircle", false, "hero", null, "image", null, "imageNotes", null,
                       "opens", "app", "textFrom", "listener", "scenario", null);
      if (aumid.StartsWith("NotifyIconGeneratedAumid_", StringComparison.OrdinalIgnoreCase)) d["opens"] = "none";

      var lines = new List<string>();
      string parseWhy = null;
      if (xml != null) {
        try {
          ParsePayload(xml, aumid, d, lines, id);
          d["textFrom"] = "payload";
        } catch (Exception ex) {
          parseWhy = "the notification's content could not be read (" + Why(ex) + ")";
          lines.Clear();
        }
      }
      if ((string)d["textFrom"] == "listener") {
        try {
          var vis = n.Notification.Visual;
          var b = vis.GetBinding(KnownNotificationBindings.ToastGeneric);
          if (b == null && vis.Bindings.Count > 0) b = vis.Bindings[0];
          if (b != null) foreach (var t in b.GetTextElements()) AddLine(lines, t.Text);
        } catch (Exception ex) {
          if (parseWhy == null) parseWhy = "Windows would not give the notification's text (" + Why(ex) + ")";
        }
      }
      if (lines.Count > 0) d["title"] = lines[0];
      if (lines.Count > 1) d["body"] = string.Join("\n", lines.GetRange(1, lines.Count - 1));
      if (lines.Count == 0 && parseWhy != null) d["body"] = parseWhy;
      return d;
    }

    static string FallbackName(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return "Unknown app";
      if (aumid.StartsWith("NotifyIconGeneratedAumid_", StringComparison.OrdinalIgnoreCase)) return "A notification-area icon";
      return aumid;
    }

    static void AddLine(List<string> lines, string s) {
      if (s == null) return;
      s = s.Trim();
      // {progressTitle}-style placeholders are filled from data Windows keeps
      // elsewhere; showing the braces would be noise.
      if (s.Length == 0 || (s.StartsWith("{") && s.EndsWith("}"))) return;
      if (s.Length > MaxLineChars) s = s.Substring(0, MaxLineChars - 1) + "\u2026";
      if (lines.Count < MaxLines) lines.Add(s);
    }

    static XmlDocument LoadXml(string xml) {
      // No DTDs, no resolver: the payload is another app's text.
      var settings = new XmlReaderSettings();
      settings.DtdProcessing = DtdProcessing.Prohibit;
      settings.XmlResolver = null;
      var doc = new XmlDocument();
      doc.XmlResolver = null;
      using (var r = XmlReader.Create(new StringReader(xml), settings)) doc.Load(r);
      return doc;
    }

    static string Attr(XmlElement e, string name) {
      if (e == null || !e.HasAttribute(name)) return null;
      return e.GetAttribute(name);
    }

    static void ParsePayload(string xml, string aumid, IDictionary d, List<string> lines, uint id) {
      var doc = LoadXml(xml);
      XmlElement root = doc.DocumentElement;
      if (root == null || root.Name != "toast") throw new FormatException("not a toast payload");
      string launch = Attr(root, "launch"), activation = Attr(root, "activationType");
      _launchOf[id] = new[] { launch, activation };
      if (string.Equals(activation, "protocol", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(launch))
        d["opens"] = "protocol";
      // alarm / reminder / incomingCall / urgent: Windows keeps those on screen until they are answered,
      // and so do Mantle's own banners (lib/features/_toasts-core.js)
      string scenario = Attr(root, "scenario");
      if (!string.IsNullOrEmpty(scenario) && scenario.Length <= 40) d["scenario"] = scenario;

      // The app's own timestamp, when it set one, is what Windows shows.
      DateTimeOffset shown;
      string ts = Attr(root, "displayTimestamp");
      if (ts != null && DateTimeOffset.TryParse(ts, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out shown))
        d["timeMs"] = (shown.UtcTicks - 621355968000000000L) / 10000;

      XmlElement binding = null;
      foreach (XmlNode b in root.SelectNodes("visual/binding")) {
        var be = b as XmlElement;
        if (be == null) continue;
        if (binding == null || string.Equals(be.GetAttribute("template"), "ToastGeneric", StringComparison.OrdinalIgnoreCase)) binding = be;
      }
      if (binding == null) throw new FormatException("the payload has no visual binding");

      foreach (XmlNode t in binding.SelectNodes(".//text")) {
        var te = t as XmlElement;
        if (te == null) continue;
        if (string.Equals(te.GetAttribute("placement"), "attribution", StringComparison.OrdinalIgnoreCase)) {
          string a = (te.InnerText ?? "").Trim();
          if (a.Length > 0 && d["attribution"] == null) d["attribution"] = a.Length > MaxLineChars ? a.Substring(0, MaxLineChars) : a;
          continue;
        }
        AddLine(lines, te.InnerText);
      }

      var notes = new List<object>();
      foreach (XmlNode i in binding.SelectNodes(".//image")) {
        var ie = i as XmlElement;
        if (ie == null) continue;
        string placement = ie.GetAttribute("placement");
        string key = string.Equals(placement, "appLogoOverride", StringComparison.OrdinalIgnoreCase) ? "logo"
                   : string.Equals(placement, "hero", StringComparison.OrdinalIgnoreCase) ? "hero" : "image";
        if (d[key] != null) continue;
        string why;
        string url = ImageFor(ie.GetAttribute("src"), aumid, key, out why);
        if (url != null) {
          d[key] = url;
          if (key == "logo") d["logoCircle"] = string.Equals(ie.GetAttribute("hint-crop"), "circle", StringComparison.OrdinalIgnoreCase);
        } else if (why != null) {
          notes.Add(key + ": " + why);
        }
      }
      if (notes.Count > 0) d["imageNotes"] = notes;
    }

    /// A payload image as a PNG data URL (the bar's CSP allows file: and data:
    /// images only), or null with the reason.
    static string ImageFor(string src, string aumid, string key, out string why) {
      why = null;
      if (string.IsNullOrEmpty(src)) return null;
      string path = null;
      string lower = src.ToLowerInvariant();
      if (lower.StartsWith("http://") || lower.StartsWith("https://")) {
        why = "a web picture; Mantle does not download notification images";
        return null;
      }
      if (lower.StartsWith("ms-appdata:///")) {
        int bang = aumid.IndexOf('!');
        if (bang <= 0) { why = "an app-data picture from an app that is not packaged"; return null; }
        string pfn = aumid.Substring(0, bang);
        string rest = Uri.UnescapeDataString(src.Substring("ms-appdata:///".Length)).Replace('/', '\\');
        string[] roots = { "local\\", "LocalState", "roaming\\", "RoamingState", "temp\\", "TempState" };
        for (int r = 0; r < roots.Length; r += 2) {
          if (rest.StartsWith(roots[r], StringComparison.OrdinalIgnoreCase)) {
            path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                "Packages", pfn, roots[r + 1], rest.Substring(roots[r].Length));
            break;
          }
        }
        if (path == null) { why = "an app-data picture in a folder Mantle does not know"; return null; }
      } else if (lower.StartsWith("ms-appx:")) {
        why = "a picture inside the app's package (ms-appx), which Mantle does not read yet";
        return null;
      } else if (lower.StartsWith("file:")) {
        Uri u;
        if (!Uri.TryCreate(src, UriKind.Absolute, out u) || !u.IsFile) { why = "a file address Mantle could not read"; return null; }
        path = u.LocalPath;
      } else if (src.Length > 2 && src[1] == ':' && (src[2] == '\\' || src[2] == '/')) {
        path = src;
      } else {
        why = "a picture address Mantle does not know (" + (src.Length > 40 ? src.Substring(0, 40) + "\u2026" : src) + ")";
        return null;
      }
      try {
        var fi = new FileInfo(path);
        if (!fi.Exists) { why = "the picture file is gone"; return null; }
        if (fi.Length > MaxImageBytes) { why = "the picture is over " + (MaxImageBytes >> 20) + " MB"; return null; }
        int bw = key == "logo" ? 64 : 360, bh = key == "logo" ? 64 : (key == "hero" ? 180 : 240);
        return Png(File.ReadAllBytes(path), bw, bh);
      } catch (Exception ex) {
        why = "the picture could not be read (" + ex.Message + ")";
        return null;
      }
    }

    /// Fits the image inside bw x bh (never enlarges) and returns a PNG data URL.
    internal static string Png(byte[] bytes, int bw, int bh) {
      using (var ms = new MemoryStream(bytes))
      using (var img = SD.Image.FromStream(ms, false, true)) {
        double k = Math.Min(1.0, Math.Min((double)bw / img.Width, (double)bh / img.Height));
        int w = Math.Max(1, (int)Math.Round(img.Width * k)), h = Math.Max(1, (int)Math.Round(img.Height * k));
        using (var bmp = new SD.Bitmap(w, h, SD.Imaging.PixelFormat.Format32bppArgb)) {
          using (var g = SD.Graphics.FromImage(bmp)) {
            g.InterpolationMode = SD.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = SD.Drawing2D.PixelOffsetMode.HighQuality;
            g.DrawImage(img, 0, 0, w, h);
          }
          using (var outp = new MemoryStream()) {
            bmp.Save(outp, SD.Imaging.ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(outp.ToArray());
          }
        }
      }
    }

    // ------------------------------------------------ app icons (caller's lane)

    sealed class AppMeta { public string Name, Icon, LaunchWhy; }
    static readonly Dictionary<string, AppMeta> _apps = new Dictionary<string, AppMeta>(StringComparer.OrdinalIgnoreCase);

    /// Caller's lane (STA): the shell's name + icon for each app, cached for
    /// the sidecar's life. Falls back to the icon file an unpackaged app
    /// registered under Software\Classes\AppUserModelId (Windows Security's
    /// is C:\WINDOWS\system32\WindowsSecurityIcon.png), then to none - the bar
    /// draws a letter then.
    static void FillApps(IList toasts) {
      if (toasts == null) return;
      foreach (IDictionary t in toasts) {
        string aumid = t["aumid"] as string ?? "";
        AppMeta m = Meta(aumid);
        t["icon"] = m.Icon;
        if (m.Name != null && (t["app"] as string) == aumid) t["app"] = m.Name;
        if ((string)t["opens"] == "app" && m.LaunchWhy != null) {
          t["opens"] = "none";
          t["opensWhy"] = m.LaunchWhy;
        } else if ((string)t["opens"] == "none") {
          t["opensWhy"] = m.LaunchWhy ?? "it came from a notification-area icon, and Windows gives other apps no way to click one";
        }
      }
    }

    static AppMeta Meta(string aumid) {
      AppMeta m;
      lock (_apps) { if (_apps.TryGetValue(aumid, out m)) return m; }
      m = new AppMeta();
      if (aumid.StartsWith("NotifyIconGeneratedAumid_", StringComparison.OrdinalIgnoreCase)) {
        m.LaunchWhy = "it came from a notification-area icon, and Windows gives other apps no way to click one";
      } else if (aumid.Length == 0) {
        m.LaunchWhy = "Windows did not say which app sent it";
      } else {
        string name, png;
        string why = Apps.Info(aumid, out name, out png);
        if (why == null) {
          m.Name = name;
          m.Icon = png;
        } else {
          m.LaunchWhy = "the shell does not know this app, so Mantle cannot start it";
        }
        if (m.Icon == null) m.Icon = RegisteredIcon(aumid);
      }
      lock (_apps) _apps[aumid] = m;
      return m;
    }

    static string LaunchableWhy(string aumid, out string name) {
      AppMeta m = Meta(aumid ?? "");
      name = m.Name;
      return m.LaunchWhy;
    }

    static string RegisteredIcon(string aumid) {
      foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
        try {
          using (var k = root.OpenSubKey(@"Software\Classes\AppUserModelId\" + aumid)) {
            if (k == null) continue;
            string icon = k.GetValue("IconUri") as string;
            if (string.IsNullOrEmpty(icon)) return null;
            icon = Environment.ExpandEnvironmentVariables(icon);
            if (!File.Exists(icon) || new FileInfo(icon).Length > MaxImageBytes) return null;
            return Png(File.ReadAllBytes(icon), 32, 32);
          }
        } catch (Exception) { }
      }
      return null;
    }

    internal static string Why(Exception ex) {
      string msg = (ex.Message ?? "").Trim();
      int nl = msg.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) msg = msg.Substring(0, nl).Trim();
      return "HRESULT 0x" + ex.HResult.ToString("X8") + (msg.Length > 0 ? ": " + msg : "");
    }
#endif
  }

#if MANTLE_WINMD
  /// The notification platform's own database, READ-ONLY, through the
  /// winsqlite3.dll in System32 (no SQLite to ship). Undocumented, so every
  /// use is optional and checked: the schema is verified at open, and any
  /// error drops the connection (Notifications falls back to the listener and
  /// says why). One connection, owned by the notifications thread; between
  /// statements it holds no lock on the file.
  sealed class NotifDb : IDisposable {
    const int SQLITE_OK = 0, SQLITE_ROW = 100, SQLITE_DONE = 101;
    const int SQLITE_OPEN_READONLY = 0x1, SQLITE_OPEN_URI = 0x40;

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_close_v2(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_busy_timeout(IntPtr db, int ms);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_prepare16_v2(IntPtr db, [MarshalAs(UnmanagedType.LPWStr)] string sql, int n, out IntPtr st, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_bind_int64(IntPtr st, int i, long v);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_step(IntPtr st);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_finalize(IntPtr st);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_reset(IntPtr st);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern long sqlite3_column_int64(IntPtr st, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_column_type(IntPtr st, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern IntPtr sqlite3_column_blob(IntPtr st, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_column_bytes(IntPtr st, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern IntPtr sqlite3_errmsg16(IntPtr db);

    IntPtr _h;

    public static string DbPath() {
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                          @"Microsoft\Windows\Notifications\wpndatabase.db");
    }

    /// null + the reason when the database cannot be used.
    public static NotifDb Open(out string why) {
      why = null;
      string path = DbPath();
      if (!File.Exists(path)) { why = "Windows' notification database is not where Mantle looks (" + path + ")"; return null; }
      IntPtr h = IntPtr.Zero;
      try {
        // mode=ro: SQLite will not write a byte of it. The URI form needs the
        // path percent-encoded, which Uri.AbsolutePath does.
        string uri = "file:" + new Uri(path).AbsolutePath + "?mode=ro";
        int rc = sqlite3_open_v2(Encoding.UTF8.GetBytes(uri + "\0"), out h, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, IntPtr.Zero);
        if (rc != SQLITE_OK) {
          string m = h != IntPtr.Zero ? Marshal.PtrToStringUni(sqlite3_errmsg16(h)) : "";
          if (h != IntPtr.Zero) sqlite3_close_v2(h);
          why = "Windows' notification database would not open read-only (SQLite " + rc + (m.Length > 0 ? ": " + m : "") + ")";
          return null;
        }
        sqlite3_busy_timeout(h, 250);
        var db = new NotifDb { _h = h };
        string schema = db.Text("select sql from sqlite_master where type='table' and name='Notification'");
        if (schema == null || schema.IndexOf("[Payload]", StringComparison.Ordinal) < 0 ||
            schema.IndexOf("[Type]", StringComparison.Ordinal) < 0 || schema.IndexOf("[Id]", StringComparison.Ordinal) < 0 ||
            schema.IndexOf("[Order]", StringComparison.Ordinal) < 0) {
          db.Dispose();
          why = "Windows' notification database is not laid out the way Mantle knows (a Windows update may have changed it)";
          return null;
        }
        db.MapShm(path + "-shm");
        return db;
      } catch (DllNotFoundException) {
        if (h != IntPtr.Zero) sqlite3_close_v2(h);
        why = "winsqlite3.dll is not on this machine, so Mantle cannot read Windows' notification database";
        return null;
      } catch (Exception ex) {
        if (h != IntPtr.Zero) sqlite3_close_v2(h);
        why = "Windows' notification database could not be read (" + ex.Message + ")";
        return null;
      }
    }

    IntPtr Prepare(string sql) {
      IntPtr st;
      int rc = sqlite3_prepare16_v2(_h, sql, -1, out st, IntPtr.Zero);
      if (rc != SQLITE_OK) throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
      return st;
    }

    string Blob(IntPtr st, int col) {
      if (sqlite3_column_type(st, col) == 5) return null;       // NULL
      int len = sqlite3_column_bytes(st, col);
      var b = new byte[len];
      if (len > 0) Marshal.Copy(sqlite3_column_blob(st, col), b, 0, len);
      return Encoding.UTF8.GetString(b);
    }

    string Text(string sql) {
      IntPtr st = Prepare(sql);
      try {
        int rc = sqlite3_step(st);
        if (rc == SQLITE_ROW) return Blob(st, 0);
        if (rc == SQLITE_DONE) return null;
        throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
      } finally { sqlite3_finalize(st); }
    }

    // THE LOOK, 10 times a second (TOAST INCOMING, 2026-10-16). Preparing the signature query on every
    // look made the 100 ms poll cost ~0.19% of a core against ~0.10% at 400 ms (lane mantle-toastfast,
    // 301 s idle, passive). So both statements are prepared ONCE and reset after each step (a reset
    // also ends the read, so the platform's WAL checkpoints are never held up), and the full signature
    // runs only when `pragma data_version` says another connection committed since the last one.
    // data_version is SQLite's documented "did anyone else write" counter; it is still checked against
    // the full signature at least every FullEvery looks, and the first time the two disagree the
    // shortcut is turned off for good and the log says why (ShortcutWhy).
    const int FullEvery = 20;         // 2 s at PollMs 100
    IntPtr _verSt, _sigSt;
    long _ver = long.MinValue;
    string _sigCache;
    int _sinceFull;
    public string ShortcutWhy;        // null = data_version is trusted

    /// How each look is made now (the watch reply's "looks"), and why it is not the cheapest one.
    public string Looks { get { return ShortcutWhy != null ? "full signature" : ShmWhy != null ? "data_version" : "wal-index header"; } }
    public string LooksWhy { get { return ShortcutWhy ?? ShmWhy; } }
    /// lane mantle-notif-safety: a shortcut switched off mid-run reaches main as an event too (Settings'
    /// notification status shows it), not only as a log line.
    void EmitLooks() {
      Program.Emit(Json.Obj("ev", "notifications.looks", "looks", Looks, "looksWhy", LooksWhy));
    }

    long DataVersion() {
      if (_verSt == IntPtr.Zero) _verSt = Prepare("pragma data_version");
      try {
        int rc = sqlite3_step(_verSt);
        if (rc != SQLITE_ROW) throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
        return sqlite3_column_int64(_verSt, 0);
      } finally { sqlite3_reset(_verSt); }
    }

    string FullSignature() {
      if (_sigSt == IntPtr.Zero) _sigSt = Prepare("select count(*), coalesce(max([Order]), 0), coalesce(sum(Id), 0) from Notification where Type = 'toast'");
      try {
        int rc = sqlite3_step(_sigSt);
        if (rc != SQLITE_ROW) throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
        return sqlite3_column_int64(_sigSt, 0) + "/" + sqlite3_column_int64(_sigSt, 1) + "/" + sqlite3_column_int64(_sigSt, 2);
      } finally { sqlite3_reset(_sigSt); }
    }

    // THE CHEAPEST LOOK (same lane, after the hold's 180 s idle run still put the 100 ms watch at ~2.8x
    // the 400 ms one's share): what each look cost was the SQLite READ TRANSACTION itself (its -shm
    // locks and WAL header read), not the prepare, and 100 ms is four times the transactions. So before
    // any SQLite call, the look compares the WAL-INDEX HEADER: the first 48 bytes of the database's
    // -shm file, which every commit rewrites (SQLite's documented WAL-index format,
    // sqlite.org/walformat.html; it is how SQLite's own readers notice a write). It is read through
    // our own read-only mapping of that file, so a quiet look makes no system call. Only when those
    // bytes moved does the look ask data_version and then the full signature. The forced full look
    // every FullEvery still runs, and if the signature moved while every look since saw the header
    // unchanged, the header shortcut is switched off and logged (ShmWhy). Without the mapping (no -shm
    // file, a different layout) every look takes the data_version path, as before.
    // MEASURED with exact cycles (QueryProcessCycleTime, passive, watch on, 151 s side by side): 4.1 M
    // cycles/s for the 400 ms sidecar, 4.3 M for this one, 3.0 M with no watch at all, so the 100 ms
    // watch costs ~0.2 M cycles/s more, about 0.006% of a core: what is left is the 4x thread wakes.
    // Process "CPU ms" (15.6 ms clock ticks) is too coarse for this: the same run read 234 ms for all three.
    IntPtr _shmView;
    readonly byte[] _shmNow = new byte[48], _shmLast = new byte[48];
    bool _shmHave, _shmQuietRun = true;
    public string ShmWhy;             // null = the header shortcut is in use

    const uint GENERIC_READ = 0x80000000, FILE_SHARE_ALL = 0x7, OPEN_EXISTING = 3, PAGE_READONLY = 0x02, FILE_MAP_READ = 0x4;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateFileMappingW(IntPtr file, IntPtr sa, uint protect, uint hi, uint lo, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr MapViewOfFile(IntPtr map, uint access, uint offHi, uint offLo, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern bool UnmapViewOfFile(IntPtr view);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    /// Maps the first 96 bytes of the -shm file read-only (the view keeps the mapping alive, so both
    /// handles close at once). Shares read, write and delete, so it never stands in SQLite's way.
    public void MapShm(string shm) {
      IntPtr f = CreateFileW(shm, GENERIC_READ, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (f == new IntPtr(-1)) { ShmWhy = "the notification database's -shm file could not be opened (error " + Marshal.GetLastWin32Error() + ")"; return; }
      IntPtr m = CreateFileMappingW(f, IntPtr.Zero, PAGE_READONLY, 0, 0, IntPtr.Zero);
      int err = Marshal.GetLastWin32Error();
      CloseHandle(f);
      if (m == IntPtr.Zero) { ShmWhy = "the notification database's -shm file could not be mapped (error " + err + ")"; return; }
      _shmView = MapViewOfFile(m, FILE_MAP_READ, 0, 0, new UIntPtr(96));
      err = Marshal.GetLastWin32Error();
      CloseHandle(m);
      if (_shmView == IntPtr.Zero) ShmWhy = "the notification database's -shm file could not be viewed (error " + err + ")";
    }

    /// True when the WAL-index header is byte-identical to the last look (nothing was committed).
    bool ShmQuiet() {
      if (_shmView == IntPtr.Zero || ShmWhy != null) return false;
      Marshal.Copy(_shmView, _shmNow, 0, 48);
      bool same = _shmHave;
      for (int i = 0; same && i < 48; i++) same = _shmNow[i] == _shmLast[i];
      Buffer.BlockCopy(_shmNow, 0, _shmLast, 0, 48);
      _shmHave = true;
      return same;
    }

    /// Changes whenever a toast is added, replaced (new rowid) or removed.
    public string Signature() {
      bool quiet = ShmQuiet();
      if (_sigCache != null && ShortcutWhy == null && _sinceFull + 1 < FullEvery) {
        _sinceFull++;
        _shmQuietRun &= quiet;
        if (quiet) return _sigCache;                  // nothing committed: no SQLite call at all
        long dv = DataVersion();
        if (dv == _ver) return _sigCache;
        _ver = dv; _sigCache = FullSignature(); _sinceFull = 0; _shmQuietRun = true;
        return _sigCache;
      }
      // the first look, the forced full look every FullEvery, or every look once data_version is off
      _shmQuietRun &= quiet;
      long v = DataVersion();
      string s = FullSignature();
      if (_sigCache != null && ShortcutWhy == null && s != _sigCache) {
        if (_shmQuietRun && _shmView != IntPtr.Zero && ShmWhy == null) {
          ShmWhy = "the notification database changed while its WAL-index header did not, so every look now asks SQLite";
          Program.EmitLog("warn", "notifications: " + ShmWhy);
          EmitLooks();
        }
        if (v == _ver) {
          ShortcutWhy = "the notification database changed without its data_version moving, so every look now reads the full signature";
          Program.EmitLog("warn", "notifications: " + ShortcutWhy);
          EmitLooks();
        }
      }
      _ver = v; _sigCache = s; _sinceFull = 0; _shmQuietRun = true;
      return s;
    }

    /// id -> payload XML for every toast row (about 2 ms for ten rows).
    public Dictionary<long, string> Payloads() {
      var d = new Dictionary<long, string>();
      IntPtr st = Prepare("select Id, Payload from Notification where Type = 'toast'");
      try {
        int rc;
        while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
          string xml = Blob(st, 1);
          if (xml != null) d[sqlite3_column_int64(st, 0)] = xml;
        }
        if (rc != SQLITE_DONE) throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
      } finally { sqlite3_finalize(st); }
      return d;
    }

    /// The app (AUMID) of the newest toast row, or null when there is none. The same
    /// Notification -> NotificationHandler join SysNotify.cs reads.
    public string NewestAumid() {
      IntPtr st = Prepare("select h.PrimaryId from Notification n join NotificationHandler h on h.RecordId = n.HandlerId " +
                          "where n.Type = 'toast' order by n.[Order] desc limit 1");
      try {
        int rc = sqlite3_step(st);
        if (rc == SQLITE_ROW) return Blob(st, 0);
        if (rc == SQLITE_DONE) return null;
        throw new IOException("SQLite " + rc + ": " + Marshal.PtrToStringUni(sqlite3_errmsg16(_h)));
      } finally { sqlite3_finalize(st); }
    }

    public string PayloadFor(uint id) {
      IntPtr st = Prepare("select Payload from Notification where Id = ?1 and Type = 'toast'");
      try {
        sqlite3_bind_int64(st, 1, id);
        return sqlite3_step(st) == SQLITE_ROW ? Blob(st, 0) : null;
      } finally { sqlite3_finalize(st); }
    }

    public void Dispose() {
      if (_shmView != IntPtr.Zero) { UnmapViewOfFile(_shmView); _shmView = IntPtr.Zero; }
      if (_verSt != IntPtr.Zero) { sqlite3_finalize(_verSt); _verSt = IntPtr.Zero; }
      if (_sigSt != IntPtr.Zero) { sqlite3_finalize(_sigSt); _sigSt = IntPtr.Zero; }
      if (_h != IntPtr.Zero) { sqlite3_close_v2(_h); _h = IntPtr.Zero; }
    }
  }
#endif
}
