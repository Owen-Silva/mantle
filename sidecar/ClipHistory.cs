// ClipHistory.cs - Mantle's clipboard history, the sidecar half of Win+V (wave 3, 2026-09-24).
//
// THE ROUTE, MEASURED BEFORE CHOSEN (2026-09-24, a read-only probe exe built with the same split
// winmds this build uses, printing counts and formats only):
//   - Windows' own history (WinRT Windows.ApplicationModel.DataTransfer.Clipboard) is reachable
//     from a windowless desktop process, but ONLY from an STA thread: from MTA the first call
//     throws COMException 0x8000001D. From STA, IsHistoryEnabled answered in 15 ms and
//     GetHistoryItemsAsync in 11 ms - with status ClipboardHistoryDisabled and 0 items, because
//     on Owen's machine the Settings switch has never been turned on
//     (HKCU\Software\Microsoft\Clipboard\EnableClipboardHistory is absent = off; cloud sync is
//     off too). The WinRT API also has NO pin/unpin at all.
//   - So the WinRT route would open an empty panel that tells Owen to go flip a switch, and still
//     need Mantle's own pins. This file keeps Mantle's OWN history instead, from
//     WM_CLIPBOARDUPDATE (AddClipboardFormatListener on a message-only window). It works whatever
//     the Settings switch says, and `clip.list` still reports that switch so the panel can say
//     which history it is showing.
//
// PRIVACY, which is the design and not an afterthought:
//   - Content lives in MEMORY ONLY. Nothing Owen copied is written to disk, a log or an event;
//     every event and log line carries counts, format names, sizes and timings.
//   - A copy a password manager has flagged never enters the history at all (Microsoft's
//     documented "Cloud Clipboard and Clipboard History Formats"; PrivacyVerdict is the rule):
//       ExcludeClipboardContentFromMonitorProcessing  present = skip, content never read
//       Clipboard Viewer Ignore                       present = skip (KeePass and older tools)
//       CanIncludeInClipboardHistory                  DWORD 0 = skip
//       CanUploadToCloudClipboard                     DWORD 0 = skip, EVEN when CanInclude... says
//                                                     yes: an app that bothered to say "this must
//                                                     not leave the machine" is treated as secret
//     The first two are checked before the clipboard is opened (the content is never touched),
//     then ALL FOUR again inside the open, so a copy that changed in between cannot slip past.
//     A flag that is present but unreadable or shorter than a DWORD FAILS CLOSED (= skip).
//   - PINS are the only thing that persists: DPAPI (CurrentUser) encrypted, capped at 25 items
//     and 4 MB each, in the file the caller names. Undo (clip.restore) holds a deleted item in
//     MEMORY only, and only until the panel closes (clip.forget) or a minute passes.
//   - A PASSIVE (test) sidecar never stores anything it did not seed or simulate itself: its
//     listener, if asked for, only counts copies and their formats. clip.capture runs the SAME
//     decision path as a real copy over a test's own fixture formats, so every rule here is
//     proved without reading or writing Owen's clipboard.
//
// THREADING: the listener window, the reads and the writes all live on ONE dedicated STA thread
// with its own message loop - NOT the ui lane. GetClipboardData on a delay-rendered format sends
// WM_RENDERFORMAT to the owning app and waits for it; a hung owner would otherwise freeze the
// thread that also runs the low-level keyboard hook, and Windows silently unhooks a hook that
// stalls. Commands read an in-memory snapshot under a lock and marshal writes to that thread.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Mantle {
  [MantleFeature]
  static class ClipHistory {
    // ------------------------------------------------------------------ limits
    // 25 items and 4 MB an item are Windows' own clipboard-history limits, so Mantle's history
    // holds what Windows' would. The memory budget is what stops 25 4K screenshots from making
    // the sidecar a 800 MB process: images are kept as PNG, and the oldest unpinned items go.
    // Fields, not consts, only so a PASSIVE sidecar's clip.limits can shrink them: a test proves
    // "too large" and "too many" with kilobyte fixtures instead of 100 MB ones.
    const int DefMaxItems = 25;
    const long DefMaxItemBytes = 4L * 1024 * 1024;
    const long DefMaxImageSourceBytes = 96L * 1024 * 1024;   // a raw 8K DIB is ~130 MB: not held
    const long DefMemoryBudget = 64L * 1024 * 1024;
    static int MaxItems = DefMaxItems;
    static long MaxItemBytes = DefMaxItemBytes;
    static long MaxImageSourceBytes = DefMaxImageSourceBytes;
    static long MemoryBudget = DefMemoryBudget;
    const int MaxPins = 25;
    const int TextForPage = 2000;                        // enough to filter on and to preview
    const int MaxFilesForPage = 20;
    const int DebounceMs = 80;
    const int UndoMs = 60000;                            // a deleted item is kept (in memory) this long at most

    // ------------------------------------------------------------------ state
    sealed class Item {
      public string Id;
      public long Ts;               // ms since the epoch, UTC
      public bool Pinned;
      public string Kind;           // "text" | "image" | "files"
      public string Text;           // CF_UNICODETEXT
      public byte[] Html;           // "HTML Format", as the app wrote it (UTF-8 with its header)
      public byte[] Rtf;            // "Rich Text Format"
      public byte[] Png;            // the image, as PNG (original PNG bytes when the app gave some)
      public int W, H;
      public string Thumb;          // data URL for the panel
      public string[] Files;        // CF_HDROP paths
      public string ImageHash;      // the picture's source bytes: the same picture copied again is the same item
      public long Bytes;
    }

    static readonly object _gate = new object();
    static readonly List<Item> _items = new List<Item>();   // newest first
    static long _nextId = 1;
    static long _rev = 1;
    static string _pinsFile;
    static string _mode = "off";            // off | history | observe
    static string _error;                   // the listener's standing problem, in words
    static string _pinsError;               // the pins file's, in words
    static bool _pinsUnreadable;            // the file on disk could not be opened: set aside before a save, never overwritten
    // Undo: what the last Delete / Clear all took out, with where each item was. Memory only.
    static readonly List<KeyValuePair<int, Item>> _trash = new List<KeyValuePair<int, Item>>();
    static long _trashAt;
    static readonly Dictionary<string, int> _skipped = new Dictionary<string, int>(StringComparer.Ordinal);
    static int _captured, _observed, _ownWrites;
    static readonly List<object> _recent = new List<object>();   // last few captures: formats and sizes ONLY

    public static void Register(FeatureTable t) {
      t.Add("clip.start", Lanes.Ui, Start);
      t.Add("clip.stop", Lanes.Ui, Stop);
      t.Add("clip.status", Lanes.Ui, Status);
      t.Add("clip.list", Lanes.Ui, List);
      t.Add("clip.arm", Lanes.Ui, Arm);
      t.Add("clip.pin", Lanes.Ui, Pin);
      t.Add("clip.delete", Lanes.Ui, Delete);
      t.Add("clip.clear", Lanes.Ui, Clear);
      t.Add("clip.restore", Lanes.Ui, Restore);
      t.Add("clip.forget", Lanes.Ui, Forget);
      t.Add("clip.seed", Lanes.Ui, Seed);
      t.Add("clip.capture", Lanes.Ui, CaptureSim);
      t.Add("clip.limits", Lanes.Ui, Limits);
      // Not the ui lane: a paste waits (up to ~1 s) for the clipboard, the focus change and the
      // keys to be released, and the ui lane runs the keyboard hook that must never wait.
      t.Add("clip.paste", Lanes.Qs, Paste);
    }

    // ================================================================ commands

    /// {pinsFile?, listen? (default true), observe? (counts only)} -> status.
    static string Start(Dictionary<string, object> req, ref object result) {
      string pins = Json.GetString(req, "pinsFile");
      bool listen = Json.GetBool(req, "listen", true);
      bool observe = Json.GetBool(req, "observe", false) || Program.Passive;
      lock (_gate) {
        if (!string.IsNullOrEmpty(pins) && pins != _pinsFile) {
          _pinsFile = pins;
          LoadPinsLocked();
        }
      }
      string err = null;
      if (listen) err = Listener.Start(observe);
      else Listener.Stop();
      lock (_gate) {
        _mode = !listen ? "off" : (err != null ? "off" : (observe ? "observe" : "history"));
        _error = err;
        _rev++;
      }
      result = StatusObj(false);
      return null;
    }

    static string Stop(Dictionary<string, object> req, ref object result) {
      Listener.Stop();
      lock (_gate) {
        // Memory-only means GONE when the feature is switched off: keep the pins, drop the rest.
        _items.RemoveAll(delegate (Item i) { return !i.Pinned; });
        _trash.Clear();
        _mode = "off";
        _error = null;
        _rev++;
      }
      result = StatusObj(false);
      return null;
    }

    static string Status(Dictionary<string, object> req, ref object result) {
      result = StatusObj(false);
      return null;
    }

    static string List(Dictionary<string, object> req, ref object result) {
      result = StatusObj(true);
      return null;
    }

    /// Records what Win+V was pressed over: the foreground window, where its caret is (when the
    /// app has a system caret) and where the pointer is. Physical pixels; main converts to DIP.
    static string Arm(Dictionary<string, object> req, ref object result) {
      IntPtr fg = Win32.GetForegroundWindow();
      int pid = 0;
      int tid = fg != IntPtr.Zero ? Win32.GetWindowThreadProcessId(fg, out pid) : 0;
      object caret = null;
      if (tid != 0) {
        var gti = new Native.GUITHREADINFO();
        gti.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
        if (Native.GetGUIThreadInfo(tid, ref gti) && gti.hwndCaret != IntPtr.Zero &&
            gti.rcCaret.bottom > gti.rcCaret.top) {
          Win32.POINT p;
          p.x = gti.rcCaret.left;
          p.y = gti.rcCaret.bottom;
          if (Native.ClientToScreen(gti.hwndCaret, ref p))
            caret = Json.Obj("x", p.x, "y", p.y, "h", gti.rcCaret.bottom - gti.rcCaret.top);
        }
      }
      Win32.POINT cur;
      object cursor = Native.GetCursorPos(out cur) ? Json.Obj("x", cur.x, "y", cur.y) : null;
      bool elevated = fg != IntPtr.Zero && pid != 0 && IsElevated(pid);
      result = Json.Obj("ok", true,
                        "hwnd", fg.ToInt64().ToString(CultureInfo.InvariantCulture),
                        "pid", pid,
                        "caret", caret,
                        "cursor", cursor,
                        "elevated", elevated,
                        "selfElevated", SelfElevated());
      return null;
    }

    /// {item, pinned} -> the new status (`item`, not `id`: `id` is the protocol's request id). Pins are the one thing written to disk (encrypted).
    static string Pin(Dictionary<string, object> req, ref object result) {
      string id = Json.GetString(req, "item");
      bool pinned = Json.GetBool(req, "pinned", true);
      lock (_gate) {
        Item it = FindLocked(id);
        if (it == null) return "that item is no longer in the clipboard history";
        if (pinned && !it.Pinned) {
          int n = 0;
          foreach (Item x in _items) if (x.Pinned) n++;
          if (n >= MaxPins) return MaxPins + " items are pinned already; unpin one first";
          if (it.Bytes > MaxItemBytes)
            return "too large to pin (" + Mb(it.Bytes) + ", the limit is " + Mb(MaxItemBytes) + ")";
        }
        if (it.Pinned != pinned) {
          it.Pinned = pinned;
          _rev++;
          SavePinsLocked();
        }
      }
      result = StatusObj(false);
      return null;
    }

    static string Delete(Dictionary<string, object> req, ref object result) {
      string id = Json.GetString(req, "item");
      lock (_gate) {
        Item it = FindLocked(id);
        if (it == null) return "that item is no longer in the clipboard history";
        int at = _items.IndexOf(it);
        _items.Remove(it);
        _trash.Clear();
        // kept for undo ONLY when the caller offers undo (and forgets it when the panel closes)
        if (Json.GetBool(req, "undo", false)) _trash.Add(new KeyValuePair<int, Item>(at, it));
        _trashAt = NowMs();
        _rev++;
        if (it.Pinned) SavePinsLocked();
      }
      result = StatusObj(false);
      return null;
    }

    /// Clear all, like Windows' "Clear all": pinned items stay. Undoable, like Delete.
    static string Clear(Dictionary<string, object> req, ref object result) {
      int removed;
      lock (_gate) {
        _trash.Clear();
        bool undo = Json.GetBool(req, "undo", false);
        for (int k = 0; undo && k < _items.Count; k++)
          if (!_items[k].Pinned) _trash.Add(new KeyValuePair<int, Item>(k, _items[k]));
        _trashAt = NowMs();
        removed = _items.RemoveAll(delegate (Item i) { return !i.Pinned; });
        _rev++;
      }
      IDictionary s = StatusObj(false);
      s["removed"] = removed;
      result = s;
      return null;
    }

    /// Undo the last Delete or Clear all: every item goes back where it was, pinned ones pinned
    /// (and saved again). An item copied again meanwhile is not doubled.
    static string Restore(Dictionary<string, object> req, ref object result) {
      int restored = 0;
      lock (_gate) {
        if (_trash.Count == 0 || NowMs() - _trashAt > UndoMs) { _trash.Clear(); return "there is nothing to undo"; }
        bool pins = false;
        foreach (KeyValuePair<int, Item> kv in _trash) {   // ascending positions: each lands where it was
          Item t = kv.Value;
          bool dup = false;
          foreach (Item x in _items) if (x == t || SameContent(x, t, t.ImageHash)) { dup = true; break; }
          if (dup) continue;
          _items.Insert(Math.Min(kv.Key, _items.Count), t);
          if (t.Pinned) pins = true;
          restored++;
        }
        _trash.Clear();
        _rev++;
        if (pins) SavePinsLocked();
      }
      IDictionary s = StatusObj(false);
      s["restored"] = restored;
      result = s;
      return null;
    }

    /// The panel closed: nothing can be undone any more, so the deleted items leave memory now.
    static string Forget(Dictionary<string, object> req, ref object result) {
      int n;
      lock (_gate) { n = _trash.Count; _trash.Clear(); }
      result = Json.Obj("ok", true, "forgot", n);
      return null;
    }

    /// TEST ONLY (passive): smaller limits, so a test proves "too large", "too many" and the
    /// memory budget with kilobyte fixtures. {} puts the real limits back.
    static string Limits(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "clip.limits is a test-only command; a live sidecar keeps its limits";
      lock (_gate) {
        MaxItems = Math.Max(1, Math.Min(DefMaxItems, Json.GetInt(req, "maxItems", DefMaxItems)));
        MaxItemBytes = Math.Max(16, Math.Min(DefMaxItemBytes, (long)Json.GetInt(req, "maxItemBytes", (int)DefMaxItemBytes)));
        MaxImageSourceBytes = Math.Max(16, Math.Min(DefMaxImageSourceBytes, (long)Json.GetInt(req, "maxImageSourceBytes", (int)DefMaxImageSourceBytes)));
        MemoryBudget = Math.Max(16, Math.Min(DefMemoryBudget, (long)Json.GetInt(req, "memoryBudget", (int)DefMemoryBudget)));
      }
      result = Json.Obj("ok", true, "maxItems", MaxItems, "maxItemBytes", MaxItemBytes,
                        "maxImageSourceBytes", MaxImageSourceBytes, "memoryBudget", MemoryBudget);
      return null;
    }

    /// TEST ONLY (passive): one copy, from a fixture instead of the clipboard, through the SAME
    /// Capture a real copy takes (privacy flags, kinds, sizes, dedupe, trim). Nothing of Owen's
    /// clipboard is opened, read or written.
    ///   {formats:[{name, text?, repeat?, html?, rtf?, image?:{w,h,color,noise?}, as?:'png'|'dib',
    ///              files?:[...], dword?, b64?, size?, nodata?}], busy?, observe?}
    static string CaptureSim(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "clip.capture is a test-only command; a live sidecar only records real copies";
      object v;
      var list = Json.TryGet(req, "formats", out v) ? v as List<object> : null;
      if (list == null) return "clip.capture needs formats:[...]";
      var src = new SimSource();
      src.Busy = Json.GetBool(req, "busy", false);
      foreach (object o in list) {
        var d = o as Dictionary<string, object>;
        string name = d != null ? Json.GetString(d, "name") : null;
        if (string.IsNullOrEmpty(name)) return "clip.capture: every format needs a name";
        byte[] data;
        string err = SimBytes(name, d, out data);
        if (err != null) return "clip.capture: " + err;
        src.Put(Fmt.ByName(name), data);
      }
      string outcome = Capture(Json.GetBool(req, "observe", false), src, false);
      IDictionary s = StatusObj(false);
      s["outcome"] = outcome;
      result = s;
      return null;
    }

    static string SimBytes(string name, Dictionary<string, object> d, out byte[] data) {
      data = null;
      if (Json.GetBool(d, "nodata", false)) return null;   // present, but GetClipboardData gives nothing
      string b64 = Json.GetString(d, "b64");
      if (b64 != null) { data = B64(b64) ?? new byte[0]; return null; }
      object dv;
      if (Json.TryGet(d, "dword", out dv)) { data = BitConverter.GetBytes(Json.GetInt(d, "dword", 0)); return null; }
      int size = Json.GetInt(d, "size", 0);
      if (size > 0) { data = new byte[Math.Min(size, 200 * 1024 * 1024)]; return null; }
      if (name == "CF_UNICODETEXT") {
        string t = Json.GetString(d, "text") ?? "";
        int rep = Math.Max(1, Json.GetInt(d, "repeat", 1));
        var sb = new StringBuilder(t.Length * rep);
        for (int i = 0; i < rep; i++) sb.Append(t);
        data = Codec.Utf16zBytes(sb.ToString());
        return null;
      }
      if (name == "HTML Format") { data = Codec.HtmlClipboardBytes(Json.GetString(d, "html") ?? ""); return null; }
      if (name == "Rich Text Format") { data = Encoding.ASCII.GetBytes((Json.GetString(d, "rtf") ?? "{\\rtf1 }") + "\0"); return null; }
      if (name == "CF_HDROP") {
        object fv;
        var fl = Json.TryGet(d, "files", out fv) ? fv as List<object> : null;
        if (fl == null || fl.Count == 0) return "CF_HDROP needs files:[...]";
        var arr = new string[fl.Count];
        for (int i = 0; i < arr.Length; i++) arr[i] = Convert.ToString(fl[i], CultureInfo.InvariantCulture);
        data = Codec.EncodeDropFiles(arr);
        return null;
      }
      if (name == "PNG" || name == "CF_DIB" || name == "CF_DIBV5") {
        object iv;
        var img = Json.TryGet(d, "image", out iv) ? iv as Dictionary<string, object> : null;
        if (img == null) return name + " needs image:{w,h,color}";
        using (Bitmap bmp = FixtureBitmap(img)) data = name == "PNG" ? Codec.ToPng(bmp) : Codec.ToDib(bmp);
        return null;
      }
      data = new byte[4];   // any other format: present, with a few bytes
      return null;
    }

    /// A fixture picture: one colour, a white diagonal (so a flip cannot pass unnoticed) and, with
    /// noise:true, random pixels, which is what makes a PNG large.
    static Bitmap FixtureBitmap(Dictionary<string, object> d) {
      int w = Math.Max(1, Math.Min(4000, Json.GetInt(d, "w", 64)));
      int h = Math.Max(1, Math.Min(4000, Json.GetInt(d, "h", 48)));
      Color c;
      try { c = ColorTranslator.FromHtml(Json.GetString(d, "color") ?? "#4436E8"); }
      catch (Exception) { c = Color.FromArgb(0x44, 0x36, 0xE8); }
      var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.Clear(c);
        using (var pen = new Pen(Color.White, Math.Max(1, Math.Min(w, h) / 8)))
          g.DrawLine(pen, 0, 0, w / 2, h / 2);
      }
      if (Json.GetBool(d, "noise", false)) {
        var rnd = new Random(Json.GetInt(d, "seed", 7));
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try {
          var row = new byte[w * 4];
          for (int y = 0; y < h; y++) {
            rnd.NextBytes(row);
            for (int x = 3; x < row.Length; x += 4) row[x] = 255;
            Marshal.Copy(row, 0, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), row.Length);
          }
        } finally { bmp.UnlockBits(bd); }
      }
      return bmp;
    }

    /// TEST ONLY: fake items, so the panel, the codecs and paste's dry run can be proved without
    /// reading or writing Owen's clipboard. A live sidecar refuses it.
    ///   {items:[{kind:'text', text, html?, agoMs?, pinned?} | {kind:'image', w, h, color:'#RRGGBB'}
    ///           | {kind:'files', paths:[...]}], reset?:true}
    static string Seed(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "clip.seed is a test-only command; a live sidecar does not take fake items";
      object v;
      var list = Json.TryGet(req, "items", out v) ? v as List<object> : null;
      if (list == null) return "clip.seed needs items:[...]";
      var made = new List<Item>();
      foreach (object o in list) {
        var d = o as Dictionary<string, object>;
        if (d == null) return "every seeded item must be an object";
        string kind = Json.GetString(d, "kind") ?? "text";
        var it = new Item();
        it.Kind = kind;
        it.Ts = NowMs() - Json.GetInt(d, "agoMs", 0);
        it.Pinned = Json.GetBool(d, "pinned", false);
        if (kind == "text") {
          it.Text = Json.GetString(d, "text") ?? "";
          string html = Json.GetString(d, "html");
          if (html != null) it.Html = Codec.HtmlClipboardBytes(html);
        } else if (kind == "image") {
          string col = Json.GetString(d, "color");
          if (col != null && !System.Text.RegularExpressions.Regex.IsMatch(col, "^#[0-9A-Fa-f]{6}$"))
            return "clip.seed: color must be #RRGGBB";
          using (Bitmap bmp = FixtureBitmap(d)) {
            it.Png = Codec.ToPng(bmp);
            it.W = bmp.Width; it.H = bmp.Height;
            it.Thumb = Codec.Thumb(bmp);
          }
          it.ImageHash = ImgHash(it.Png);
        } else if (kind == "files") {
          object pv;
          var paths = Json.TryGet(d, "paths", out pv) ? pv as List<object> : null;
          if (paths == null || paths.Count == 0) return "clip.seed: a files item needs paths:[...]";
          var arr = new string[paths.Count];
          for (int i = 0; i < arr.Length; i++) arr[i] = Convert.ToString(paths[i], CultureInfo.InvariantCulture);
          it.Files = arr;
        } else {
          return "clip.seed: kind must be text, image or files";
        }
        Finish(it);
        made.Add(it);
      }
      lock (_gate) {
        if (Json.GetBool(req, "reset", false)) { _items.Clear(); _trash.Clear(); }
        // items[0] ends up on top: a test reads the panel in the order it wrote the fixture.
        for (int i = made.Count - 1; i >= 0; i--) {
          made[i].Id = "c" + (_nextId++).ToString(CultureInfo.InvariantCulture);
          _items.Insert(0, made[i]);
        }
        TrimLocked();
        _rev++;
      }
      result = StatusObj(false);
      return null;
    }

    /// {item, hwnd, dryRun?} -> puts the item on the clipboard, brings `hwnd` back to the front and
    /// presses Ctrl+V into it. This is the product acting on Owen's own Win+V + Enter.
    ///
    /// dryRun does NONE of that: it builds every clipboard format exactly as a real paste would,
    /// decodes them back with the same readers the listener uses, and says what it would have
    /// done. Tests only ever use this path; a passive sidecar refuses the real one.
    ///
    /// plain:true pastes the words only: a formatted text item as bare text (no HTML, no RTF), a
    /// files item as its paths, one per line. A picture has no plain form and pastes as itself.
    static string Paste(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      string id = Json.GetString(req, "item");
      bool dry = Json.GetBool(req, "dryRun", false);
      bool plain = Json.GetBool(req, "plain", false);
      IntPtr target = Json.GetHwnd(req, "hwnd");
      Item it;
      lock (_gate) it = FindLocked(id);
      if (it == null) return "that item is no longer in the clipboard history";

      string text = it.Text;
      byte[] html = it.Html, rtf = it.Rtf, png = it.Png;
      string[] files = it.Files;
      bool plainApplied = false;
      if (plain && it.Kind == "text") { html = null; rtf = null; plainApplied = true; }
      else if (plain && it.Kind == "files" && files != null) {
        text = string.Join("\r\n", files); files = null; html = null; rtf = null; plainApplied = true;
      }

      List<Codec.Format> formats;
      string encErr = Codec.Encode(text, html, rtf, png, files, out formats);
      if (encErr != null) return "could not prepare the item for the clipboard: " + encErr;

      bool targetOk = target != IntPtr.Zero && Win32.IsWindow(target);
      int tpid = 0;
      if (targetOk) Win32.GetWindowThreadProcessId(target, out tpid);
      bool targetElevated = targetOk && tpid != 0 && IsElevated(tpid);
      bool uipiBlocked = targetElevated && !SelfElevated();

      var fl = new List<object>();
      foreach (Codec.Format f in formats) fl.Add(Json.Obj("name", f.Name, "bytes", f.Data.Length));

      if (dry) {
        string rt = Codec.RoundTrip(text, html, rtf, png, files, formats);
        result = Json.Obj("ok", true, "dryRun", true, "id", id, "kind", it.Kind, "plain", plainApplied,
                          "formats", fl, "roundTrip", rt == null, "roundTripError", rt,
                          "target", Json.Obj("hwnd", target.ToInt64().ToString(CultureInfo.InvariantCulture),
                                             "exists", targetOk, "elevated", targetElevated),
                          "wouldFocus", targetOk,
                          "wouldSend", targetOk && !uipiBlocked ? "Ctrl+V" : null,
                          "wouldSay", !targetOk ? "no window to paste into; the item would only be copied"
                                      : (uipiBlocked ? UipiWords : null),
                          "ms", sw.ElapsedMilliseconds);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": would have written the clipboard and pressed Ctrl+V";

      string werr = Listener.Write(formats);
      if (werr != null) return "could not put the item on the clipboard: " + werr;
      lock (_gate) {
        if (_items.Remove(it)) {   // deleted meanwhile (another click): it stays deleted
          it.Ts = NowMs();
          _items.Insert(0, it);
          _rev++;
          if (it.Pinned) SavePinsLocked();   // the pins file keeps the order across a restart
        }
      }
      Features.Event("clip", Json.Obj("what", "changed", "rev", Rev(), "count", Count(), "why", "paste"));

      string why = null;
      bool pasted = false;
      if (!targetOk) why = "there was no window to paste into, so it is only on the clipboard";
      else if (uipiBlocked) why = UipiWords;
      else {
        string ferr = WindowList.Focus(target);
        if (ferr == null) ferr = WaitForeground(target, 400);
        if (ferr != null) why = ferr + ". It is on the clipboard: press Ctrl+V";
        else {
          string kerr = WaitModifiersUp(700);
          if (kerr == null) kerr = SendCtrlV();
          if (kerr != null) why = kerr;
          else pasted = true;
        }
      }
      if (!pasted) Program.EmitLog("warn", "clipboard: pasted:false (" + why + ")");
      result = Json.Obj("ok", true, "copied", true, "pasted", pasted, "reason", why, "plain", plainApplied,
                        "formats", fl, "ms", sw.ElapsedMilliseconds);
      return null;
    }

    const string UipiWords = "Windows does not let Mantle type into an administrator window. It is on the clipboard: press Ctrl+V";

    // ================================================================ snapshot

    static IDictionary StatusObj(bool withItems) {
      lock (_gate) {
        var skipped = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, int> kv in _skipped) skipped[kv.Key] = kv.Value;
        int pinned = 0;
        long bytes = 0;
        foreach (Item i in _items) { if (i.Pinned) pinned++; bytes += i.Bytes; }
        IDictionary o = Json.Obj("ok", true,
                                 "rev", _rev,
                                 "source", "mantle",
                                 "mode", _mode,
                                 "passive", Program.Passive,
                                 "error", _error,
                                 "pinsError", _pinsError,
                                 "count", _items.Count,
                                 "pinned", pinned,
                                 "bytes", bytes,
                                 "undo", _trash.Count,
                                 "windowsHistory", WindowsHistorySwitch(),
                                 "stats", Json.Obj("captured", _captured, "observed", _observed,
                                                   "ownWrites", _ownWrites, "skipped", skipped,
                                                   "recent", new List<object>(_recent)));
        if (withItems) {
          var list = new List<object>();
          foreach (Item i in _items) list.Add(ItemObj(i));
          o["items"] = list;
        }
        return o;
      }
    }

    static IDictionary ItemObj(Item i) {
      IDictionary o = Json.Obj("id", i.Id, "kind", i.Kind, "ts", i.Ts, "pinned", i.Pinned, "bytes", i.Bytes,
                               "rich", i.Html != null || i.Rtf != null);
      if (i.Text != null) {
        o["chars"] = i.Text.Length;
        o["lines"] = CountLines(i.Text);
        o["text"] = i.Text.Length > TextForPage ? i.Text.Substring(0, TextForPage) : i.Text;
      }
      if (i.Png != null) { o["w"] = i.W; o["h"] = i.H; o["thumb"] = i.Thumb; }
      if (i.Files != null) {
        var fl = new List<object>();
        for (int k = 0; k < i.Files.Length && k < MaxFilesForPage; k++) {
          string p = i.Files[k];
          string name;
          try { name = Path.GetFileName(p.TrimEnd('\\')); } catch (Exception) { name = p; }
          if (string.IsNullOrEmpty(name)) name = p;
          fl.Add(Json.Obj("name", name, "path", p));
        }
        o["files"] = fl;
        o["fileCount"] = i.Files.Length;
      }
      return o;
    }

    /// Windows' own Settings switch, reported so the panel can say which history it shows.
    /// null = unreadable. A missing value is Windows' default, which is OFF.
    static object WindowsHistorySwitch() {
      try {
        using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Clipboard")) {
          object v = k != null ? k.GetValue("EnableClipboardHistory") : null;
          bool on = v is int && (int)v != 0;
          return Json.Obj("enabled", on);
        }
      } catch (Exception) { return null; }
    }

    // ================================================================ helpers

    static Item FindLocked(string id) {
      if (string.IsNullOrEmpty(id)) return null;
      foreach (Item i in _items) if (i.Id == id) return i;
      return null;
    }

    static long Rev() { lock (_gate) return _rev; }
    static int Count() { lock (_gate) return _items.Count; }

    static long NowMs() {
      return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    static int CountLines(string s) {
      if (string.IsNullOrEmpty(s)) return 0;
      int n = 1;
      foreach (char c in s) if (c == '\n') n++;
      return n;
    }

    static string Mb(long b) {
      return (b / 1048576.0).ToString("0.#", CultureInfo.InvariantCulture) + " MB";
    }

    static void Bump(string reason) {
      lock (_gate) {
        int n;
        _skipped.TryGetValue(reason, out n);
        _skipped[reason] = n + 1;
      }
    }

    static void Recent(IDictionary entry) {
      lock (_gate) {
        _recent.Insert(0, entry);
        while (_recent.Count > 8) _recent.RemoveAt(_recent.Count - 1);
      }
    }

    static void Finish(Item it) {
      long b = 0;
      if (it.Text != null) b += it.Text.Length * 2L;
      if (it.Html != null) b += it.Html.Length;
      if (it.Rtf != null) b += it.Rtf.Length;
      if (it.Png != null) b += it.Png.Length;
      if (it.Files != null) foreach (string f in it.Files) b += f.Length * 2L;
      it.Bytes = b;
    }

    static string ImgHash(byte[] image) {
      if (image == null) return null;
      using (SHA1 sha = SHA1.Create()) return Convert.ToBase64String(sha.ComputeHash(image));
    }

    /// "The same copy" is what the person SEES, not which formats the app added: the same words
    /// copied from a web page (text + HTML) and from Notepad (text only) are ONE item, as are the
    /// same files and the same picture. The newer copy's formats win (see Capture).
    static bool SameContent(Item x, Item it, string imgHash) {
      if (x.Kind != it.Kind) return false;
      if (x.Kind == "text") return x.Text != null && x.Text == it.Text;
      if (x.Kind == "image") return x.ImageHash != null && x.ImageHash == imgHash;
      if (x.Kind == "files") {
        if (x.Files == null || it.Files == null || x.Files.Length != it.Files.Length) return false;
        for (int k = 0; k < x.Files.Length; k++)
          if (!string.Equals(x.Files[k], it.Files[k], StringComparison.OrdinalIgnoreCase)) return false;
        return true;
      }
      return false;
    }

    /// Drop the oldest UNPINNED items past the count or the memory budget. Pins never count.
    static void TrimLocked() {
      int unpinned = 0;
      long bytes = 0;
      foreach (Item i in _items) if (!i.Pinned) { unpinned++; bytes += i.Bytes; }
      for (int k = _items.Count - 1; k >= 0 && (unpinned > MaxItems || bytes > MemoryBudget); k--) {
        if (_items[k].Pinned) continue;
        bytes -= _items[k].Bytes;
        unpinned--;
        _items.RemoveAt(k);
      }
    }

    static string WaitForeground(IntPtr target, int ms) {
      IntPtr root = Win32.GetAncestor(target, Win32.GA_ROOT);
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < ms) {
        IntPtr fg = Win32.GetForegroundWindow();
        if (fg == target || (fg != IntPtr.Zero && Win32.GetAncestor(fg, Win32.GA_ROOT) == root)) return null;
        Thread.Sleep(15);
      }
      return "the window did not come back to the front within " + ms + " ms";
    }

    /// Ctrl+V while Shift, Alt or Win is still down is a DIFFERENT chord (Ctrl+Alt+V, Ctrl+Shift+V
    /// are real commands in real apps), so the keys Owen used to choose the item must be up first.
    static string WaitModifiersUp(int ms) {
      int[] vks = { 0x10, 0x11, 0x12, 0x5B, 0x5C };   // Shift, Ctrl, Alt, LWin, RWin
      var sw = Stopwatch.StartNew();
      while (true) {
        bool held = false;
        foreach (int vk in vks) if ((Native.GetAsyncKeyState(vk) & 0x8000) != 0) held = true;
        if (!held) return null;
        if (sw.ElapsedMilliseconds > ms)
          return "a Shift, Ctrl, Alt or Win key was still held down, so Mantle did not press Ctrl+V. It is on the clipboard: press Ctrl+V";
        Thread.Sleep(15);
      }
    }

    /// Ctrl down, V down, V up, Ctrl up in ONE SendInput call: SendInput is atomic per call, so no
    /// other input can land between the halves (the reasoning in Keys.cs).
    static string SendCtrlV() {
      const ushort VK_CONTROL = 0x11, VK_V = 0x56;
      var inputs = new Win32.INPUT[4];
      ushort[] vk = { VK_CONTROL, VK_V, VK_V, VK_CONTROL };
      for (int i = 0; i < 4; i++) {
        inputs[i].type = Win32.INPUT_KEYBOARD;
        inputs[i].u.ki.wVk = vk[i];
        inputs[i].u.ki.dwFlags = i >= 2 ? Win32.KEYEVENTF_KEYUP : 0;
      }
      uint sent = Win32.SendInput(4, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
      if (sent != 4) {
        // the numbers go to the log; the panel gets the sentence
        Program.EmitLog("warn", "clipboard: SendInput sent " + sent + " of 4 (error " + Marshal.GetLastWin32Error() + ")");
        return "Windows blocked the Ctrl+V keystroke. It is on the clipboard: press Ctrl+V";
      }
      return null;
    }

    static bool IsElevated(int pid) {
      IntPtr proc = Native.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
      if (proc == IntPtr.Zero) return false;   // cannot even query it: treat as ordinary, the paste will say if it fails
      try { return TokenElevated(proc); }
      finally { Native.CloseHandle(proc); }
    }

    static bool _selfKnown, _self;
    static bool SelfElevated() {
      if (!_selfKnown) { _self = TokenElevated(Native.GetCurrentProcess()); _selfKnown = true; }
      return _self;
    }

    static bool TokenElevated(IntPtr proc) {
      IntPtr tok;
      if (!Native.OpenProcessToken(proc, 0x0008 /* TOKEN_QUERY */, out tok)) return false;
      try {
        int elevation = 0, len;
        bool ok = Native.GetTokenInformation(tok, 20 /* TokenElevation */, out elevation, 4, out len);
        return ok && elevation != 0;
      } finally { Native.CloseHandle(tok); }
    }

    // ================================================================ capture

    /// Where Capture reads a copy from: the real clipboard (LiveSource, on the listener thread)
    /// or a test's fixture (SimSource, clip.capture in a passive sidecar). ONE decision path for
    /// both, so the privacy rule, the kinds, the sizes and the dedupe are all proved by tests that
    /// never open Owen's clipboard.
    interface IClipSource {
      bool Has(uint fmt);
      byte[] Read(uint fmt, long cap, ref bool tooLarge);
      bool Open();
      void Close();
      List<object> Names();
    }

    sealed class LiveSource : IClipSource {
      readonly IntPtr _hwnd;
      public LiveSource(IntPtr hwnd) { _hwnd = hwnd; }
      public bool Has(uint fmt) { return Native.IsClipboardFormatAvailable(fmt); }
      public byte[] Read(uint fmt, long cap, ref bool tooLarge) { return ReadClipboard(fmt, cap, ref tooLarge); }
      public bool Open() { return Listener.Open(_hwnd); }
      public void Close() { Native.CloseClipboard(); }
      public List<object> Names() {
        var names = new List<object>();
        uint f = 0;
        int guard = 0;
        while ((f = Native.EnumClipboardFormats(f)) != 0 && guard++ < 64) names.Add(Fmt.Name(f));
        return names;
      }
    }

    sealed class SimSource : IClipSource {
      readonly List<uint> _order = new List<uint>();
      readonly Dictionary<uint, byte[]> _data = new Dictionary<uint, byte[]>();
      public bool Busy;
      public void Put(uint fmt, byte[] data) { if (!_data.ContainsKey(fmt)) _order.Add(fmt); _data[fmt] = data; }
      public bool Has(uint fmt) { return _data.ContainsKey(fmt); }
      public byte[] Read(uint fmt, long cap, ref bool tooLarge) {
        byte[] d;
        if (!_data.TryGetValue(fmt, out d) || d == null || d.Length == 0) return null;
        if (d.Length > cap) { tooLarge = true; return null; }
        return d;
      }
      public bool Open() { return !Busy; }
      public void Close() { }
      public List<object> Names() {
        var l = new List<object>();
        foreach (uint f in _order) l.Add(Fmt.Name(f));
        return l;
      }
    }

    /// THE PRIVACY RULE, in one place. null = the copy may be kept; else the flag that said no.
    /// FAILS CLOSED: a CanInclude / CanUpload flag that is present but unreadable, or shorter
    /// than a DWORD, counts as "no". The flag's DATA is read (never the copy's) - that needs the
    /// clipboard open, which is why Capture asks again inside the open.
    static string PrivacyVerdict(IClipSource s) {
      if (s.Has(Fmt.Exclude)) return "exclude";
      if (s.Has(Fmt.ViewerIgnore)) return "viewerIgnore";
      bool big = false;
      if (s.Has(Fmt.CanInclude) && !DwordYes(s.Read(Fmt.CanInclude, 16, ref big))) return "canInclude";
      if (s.Has(Fmt.CanUpload) && !DwordYes(s.Read(Fmt.CanUpload, 16, ref big))) return "canUpload";
      return null;
    }

    static bool DwordYes(byte[] d) { return d != null && d.Length >= 4 && BitConverter.ToInt32(d, 0) != 0; }

    /// One skipped copy: counted, in the recent list and an event - reason and timing only.
    static string Skip(string reason, Stopwatch sw, List<object> names) {
      Bump(reason);
      Recent(Json.Obj("result", "skipped", "reason", reason, "formats", names, "ms", sw.ElapsedMilliseconds));
      Features.Event("clip", Json.Obj("what", "skipped", "reason", reason));
      return "skipped:" + reason;
    }

    /// Runs on the listener thread after a clipboard change settles (live), or for clip.capture
    /// (a test's fixture). Returns the outcome in a word: added | moved | observed | own |
    /// skipped:<reason> (private ones as skipped:private:<which flag>).
    static string Capture(bool observe, IClipSource src, bool live) {
      var sw = Stopwatch.StartNew();
      if (live) {
        uint seq = Native.GetClipboardSequenceNumber();
        if (seq != 0 && seq == Listener.OwnSeq) { lock (_gate) _ownWrites++; return "own"; }
      }

      // Flags readable WITHOUT opening the clipboard: the content is never touched.
      if (src.Has(Fmt.Exclude) || src.Has(Fmt.ViewerIgnore))
        return Skip("private", sw, null) + (src.Has(Fmt.Exclude) ? ":exclude" : ":viewerIgnore");
      if (!src.Open()) return Skip("busy", sw, null);
      string text = null, priv = null;
      byte[] html = null, rtf = null, png = null, dib = null, drop = null;
      bool tooLarge = false;
      List<object> names = null;
      try {
        // ALL FOUR flags again, inside the open: the copy may have changed since the check above.
        priv = PrivacyVerdict(src);
        if (priv == null) {
          names = src.Names();
          if (!observe) {
            if (src.Has(Fmt.CF_HDROP)) drop = src.Read(Fmt.CF_HDROP, MaxItemBytes, ref tooLarge);
            if (src.Has(Fmt.CF_UNICODETEXT)) {
              byte[] t = src.Read(Fmt.CF_UNICODETEXT, MaxItemBytes, ref tooLarge);
              if (t != null) text = Codec.Utf16z(t);
            }
            if (src.Has(Fmt.Html)) html = src.Read(Fmt.Html, MaxItemBytes, ref tooLarge);
            if (src.Has(Fmt.Rtf)) rtf = src.Read(Fmt.Rtf, MaxItemBytes, ref tooLarge);
            bool hasText = text != null && text.Trim().Length > 0;
            if (!hasText) {
              if (src.Has(Fmt.Png)) png = src.Read(Fmt.Png, MaxImageSourceBytes, ref tooLarge);
              if (png == null && src.Has(Fmt.CF_DIBV5)) dib = src.Read(Fmt.CF_DIBV5, MaxImageSourceBytes, ref tooLarge);
              if (png == null && dib == null && src.Has(Fmt.CF_DIB)) dib = src.Read(Fmt.CF_DIB, MaxImageSourceBytes, ref tooLarge);
            }
          }
        }
      } finally {
        src.Close();
      }
      long openMs = sw.ElapsedMilliseconds;

      if (priv != null) return Skip("private", sw, null) + ":" + priv;
      if (observe) {
        lock (_gate) _observed++;
        Recent(Json.Obj("result", "observed", "formats", names, "ms", openMs));
        Features.Event("clip", Json.Obj("what", "observed", "formats", names.Count));
        return "observed";
      }

      var it = new Item();
      string[] files = drop != null ? Codec.DecodeDropFiles(drop) : null;
      bool hasT = text != null && text.Trim().Length > 0;
      bool hasFiles = files != null && files.Length > 0;
      // A picture WITH a file is a screenshot tool offering both (measured 2026-09-24, observe
      // mode: PNG + CF_DIB + CF_HDROP + FileContents in one copy). It is a picture in the panel,
      // and a paste sets both, so Explorer still gets the file and an editor the pixels.
      if ((png != null || dib != null) && !hasT) { it.Kind = "image"; it.Html = html; if (hasFiles) it.Files = files; }
      else if (hasFiles) { it.Kind = "files"; it.Files = files; }
      else if (hasT) { it.Kind = "text"; it.Text = text; it.Html = html; it.Rtf = rtf; }
      else return Skip(tooLarge ? "tooLarge" : (names.Count == 0 || text != null ? "empty" : "unsupported"), sw, names);

      string imgHash = it.Kind == "image" ? ImgHash(png ?? dib) : null;
      lock (_gate) {
        foreach (Item x in _items) {
          if (!SameContent(x, it, imgHash)) continue;
          // The same thing copied again (from anywhere, with whatever extra formats): ONE item,
          // moved to the top, holding the NEWEST copy's formats - what a paste now should give.
          // This is also the screenshot tool's second write (the picture, then the picture plus
          // its saved file ~250 ms later): one copy, and the item gains the file.
          _items.Remove(x);
          x.Html = it.Html;
          x.Rtf = it.Rtf;
          if (x.Kind == "image") x.Files = it.Files;
          Finish(x);
          x.Ts = NowMs();
          _items.Insert(0, x);
          if (x.Pinned) SavePinsLocked();
          _rev++;
          _captured++;
          Recent(Json.Obj("result", "moved", "kind", x.Kind, "formats", names, "bytes", x.Bytes, "ms", sw.ElapsedMilliseconds));
          Features.Event("clip", Json.Obj("what", "changed", "rev", _rev, "count", _items.Count, "why", "again"));
          return "moved";
        }
      }

      if (it.Kind == "image") {
        it.ImageHash = imgHash;
        string ierr = null;
        try {
          Bitmap bmp = png != null ? Codec.FromPng(png) : Codec.FromDib(dib);
          using (bmp) {
            it.Png = png ?? Codec.ToPng(bmp);
            it.W = bmp.Width; it.H = bmp.Height;
            it.Thumb = Codec.Thumb(bmp);
          }
        } catch (Exception ex) { ierr = ex.GetType().Name; }
        if (ierr != null || it.Png == null) {
          Bump("unreadableImage");
          Recent(Json.Obj("result", "skipped", "reason", "unreadableImage", "why", ierr, "formats", names, "ms", sw.ElapsedMilliseconds));
          Features.Event("clip", Json.Obj("what", "skipped", "reason", "unreadableImage"));
          return "skipped:unreadableImage";
        }
      }
      Finish(it);
      if (it.Bytes > MaxItemBytes * 2) {   // a PNG may be larger than its DIB was; 8 MB is the ceiling
        Bump("tooLarge");
        Recent(Json.Obj("result", "skipped", "reason", "tooLarge", "bytes", it.Bytes, "ms", sw.ElapsedMilliseconds));
        Features.Event("clip", Json.Obj("what", "skipped", "reason", "tooLarge"));
        return "skipped:tooLarge";
      }
      lock (_gate) {
        it.Id = "c" + (_nextId++).ToString(CultureInfo.InvariantCulture);
        it.Ts = NowMs();
        _items.Insert(0, it);
        TrimLocked();
        _rev++;
        _captured++;
      }
      Recent(Json.Obj("result", "added", "kind", it.Kind, "formats", names, "bytes", it.Bytes,
                      "openMs", openMs, "ms", sw.ElapsedMilliseconds));
      Features.Event("clip", Json.Obj("what", "changed", "rev", Rev(), "count", Count(), "why", "copy"));
      return "added";
    }

    /// One format's bytes, or null. Larger than `cap` = null and tooLarge set (never half an item).
    static byte[] ReadClipboard(uint fmt, long cap, ref bool tooLarge) {
      IntPtr h = Native.GetClipboardData(fmt);
      if (h == IntPtr.Zero) return null;
      long size = (long)Native.GlobalSize(h).ToUInt64();
      if (size <= 0) return null;
      if (size > cap) { tooLarge = true; return null; }
      IntPtr p = Native.GlobalLock(h);
      if (p == IntPtr.Zero) return null;
      try {
        var b = new byte[size];
        Marshal.Copy(p, b, 0, (int)size);
        return b;
      } finally { Native.GlobalUnlock(h); }
    }

    // ================================================================ pins (DPAPI)

    static readonly byte[] PinsEntropy = Encoding.UTF8.GetBytes("Mantle.ClipHistory.pins.v1");

    static void LoadPinsLocked() {
      _pinsError = null;
      _pinsUnreadable = false;
      _items.RemoveAll(delegate (Item i) { return i.Pinned; });
      if (string.IsNullOrEmpty(_pinsFile)) return;
      // A save that died between writing the new file and putting it in place leaves only the
      // .tmp (the old save order deleted first): that file IS the pins.
      string tmp = _pinsFile + ".tmp";
      try { if (!File.Exists(_pinsFile) && File.Exists(tmp)) File.Move(tmp, _pinsFile); } catch (Exception) { }
      if (!File.Exists(_pinsFile)) return;
      try {
        byte[] plain = Dpapi(File.ReadAllBytes(_pinsFile), false);
        if (plain == null) {
          _pinsUnreadable = true;
          _pinsError = "the saved pins could not be opened (they belong to another Windows user, or the file is damaged)";
          return;
        }
        var root = Json.Parse(Encoding.UTF8.GetString(plain)) as Dictionary<string, object>;
        object v;
        var list = root != null && Json.TryGet(root, "items", out v) ? v as List<object> : null;
        if (list == null) { _pinsUnreadable = true; _pinsError = "the saved pins are in a form this Mantle does not know"; return; }
        var loaded = new List<Item>();
        foreach (object o in list) {
          var d = o as Dictionary<string, object>;
          if (d == null) continue;
          var it = new Item();
          it.Pinned = true;
          it.Kind = Json.GetString(d, "kind") ?? "text";
          object tsv;
          it.Ts = Json.TryGet(d, "ts", out tsv) && tsv is double ? (long)(double)tsv : NowMs();
          it.Text = Json.GetString(d, "text");
          it.Html = B64(Json.GetString(d, "html"));
          it.Rtf = B64(Json.GetString(d, "rtf"));
          it.Png = B64(Json.GetString(d, "png"));
          object fv;
          var fl = Json.TryGet(d, "files", out fv) ? fv as List<object> : null;
          if (fl != null) {
            it.Files = new string[fl.Count];
            for (int k = 0; k < fl.Count; k++) it.Files[k] = Convert.ToString(fl[k], CultureInfo.InvariantCulture);
          }
          if (it.Png != null) {
            try {
              using (Bitmap bmp = Codec.FromPng(it.Png)) { it.W = bmp.Width; it.H = bmp.Height; it.Thumb = Codec.Thumb(bmp); }
            } catch (Exception) { continue; }
          }
          if (it.Png != null) it.ImageHash = ImgHash(it.Png);
          Finish(it);
          it.Id = "c" + (_nextId++).ToString(CultureInfo.InvariantCulture);
          loaded.Add(it);
          if (loaded.Count >= MaxPins) break;
        }
        _items.AddRange(loaded);
        _items.Sort(delegate (Item a, Item b) { return b.Ts.CompareTo(a.Ts); });
        _rev++;
      } catch (Exception ex) {
        _pinsUnreadable = true;
        Program.EmitLog("warn", "clipboard: pins file unreadable (" + ex.GetType().Name + ")");
        _pinsError = "the saved pins could not be read";
      }
    }

    static void SavePinsLocked() {
      if (string.IsNullOrEmpty(_pinsFile)) { _pinsError = "pins are kept only until Mantle restarts: there is no file to save them in"; return; }
      try {
        var list = new List<object>();
        foreach (Item i in _items) {
          if (!i.Pinned) continue;
          list.Add(Json.Obj("kind", i.Kind, "ts", i.Ts, "text", i.Text,
                            "html", i.Html != null ? Convert.ToBase64String(i.Html) : null,
                            "rtf", i.Rtf != null ? Convert.ToBase64String(i.Rtf) : null,
                            "png", i.Png != null ? Convert.ToBase64String(i.Png) : null,
                            "files", i.Files != null ? new List<object>(i.Files) : null));
        }
        byte[] sealedBytes = Dpapi(Encoding.UTF8.GetBytes(Json.Write(Json.Obj("v", 1, "items", list))), true);
        if (sealedBytes == null) { _pinsError = "Windows would not encrypt the pinned items, so they were not saved"; return; }
        string dir = Path.GetDirectoryName(_pinsFile);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        // A file that could not be opened is set aside, never overwritten: it may be another
        // Windows user's pins, or recoverable.
        if (_pinsUnreadable && File.Exists(_pinsFile)) {
          string aside = _pinsFile + ".unreadable";
          if (File.Exists(aside)) File.Delete(aside);
          File.Move(_pinsFile, aside);
          _pinsUnreadable = false;
        }
        string tmp = _pinsFile + ".tmp";
        File.WriteAllBytes(tmp, sealedBytes);
        // Replace swaps the files in one step; there is never a moment with no pins file at all.
        if (File.Exists(_pinsFile)) File.Replace(tmp, _pinsFile, null);
        else File.Move(tmp, _pinsFile);
        _pinsError = null;
      } catch (Exception ex) {
        Program.EmitLog("warn", "clipboard: pins not saved (" + ex.GetType().Name + ")");
        _pinsError = "the pinned items could not be saved to disk";
      }
    }

    static byte[] B64(string s) {
      if (string.IsNullOrEmpty(s)) return null;
      try { return Convert.FromBase64String(s); } catch (Exception) { return null; }
    }

    /// CryptProtectData / CryptUnprotectData, CurrentUser scope (no LOCAL_MACHINE flag), no UI.
    /// P/Invoke because System.Security.dll (ProtectedData) is not among build.ps1's references.
    static byte[] Dpapi(byte[] input, bool protect) {
      var inBlob = new Native.DATA_BLOB();
      var entBlob = new Native.DATA_BLOB();
      var outBlob = new Native.DATA_BLOB();
      GCHandle hIn = GCHandle.Alloc(input, GCHandleType.Pinned);
      GCHandle hEnt = GCHandle.Alloc(PinsEntropy, GCHandleType.Pinned);
      try {
        inBlob.cbData = input.Length; inBlob.pbData = hIn.AddrOfPinnedObject();
        entBlob.cbData = PinsEntropy.Length; entBlob.pbData = hEnt.AddrOfPinnedObject();
        bool ok = protect
          ? Native.CryptProtectData(ref inBlob, "Mantle pinned clipboard items", ref entBlob, IntPtr.Zero, IntPtr.Zero, 1, ref outBlob)
          : Native.CryptUnprotectData(ref inBlob, IntPtr.Zero, ref entBlob, IntPtr.Zero, IntPtr.Zero, 1, ref outBlob);
        if (!ok || outBlob.pbData == IntPtr.Zero) return null;
        var r = new byte[outBlob.cbData];
        Marshal.Copy(outBlob.pbData, r, 0, outBlob.cbData);
        return r;
      } finally {
        hIn.Free(); hEnt.Free();
        if (outBlob.pbData != IntPtr.Zero) Native.LocalFree(outBlob.pbData);
      }
    }

    // ================================================================ formats

    static class Fmt {
      public const uint CF_UNICODETEXT = 13, CF_DIB = 8, CF_DIBV5 = 17, CF_HDROP = 15;
      public static readonly uint Html = Native.RegisterClipboardFormatW("HTML Format");
      public static readonly uint Rtf = Native.RegisterClipboardFormatW("Rich Text Format");
      public static readonly uint Png = Native.RegisterClipboardFormatW("PNG");
      public static readonly uint DropEffect = Native.RegisterClipboardFormatW("Preferred DropEffect");
      public static readonly uint Exclude = Native.RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing");
      public static readonly uint ViewerIgnore = Native.RegisterClipboardFormatW("Clipboard Viewer Ignore");
      public static readonly uint CanInclude = Native.RegisterClipboardFormatW("CanIncludeInClipboardHistory");
      public static readonly uint CanUpload = Native.RegisterClipboardFormatW("CanUploadToCloudClipboard");

      public static uint ByName(string name) {
        switch (name) {
          case "CF_UNICODETEXT": return CF_UNICODETEXT;
          case "CF_DIB": return CF_DIB;
          case "CF_HDROP": return CF_HDROP;
          case "CF_DIBV5": return CF_DIBV5;
          default: return Native.RegisterClipboardFormatW(name);
        }
      }

      /// A format's NAME (never its data): standard ids by their CF_ name, registered ones by
      /// the name the app registered.
      public static string Name(uint f) {
        switch (f) {
          case 1: return "CF_TEXT"; case 2: return "CF_BITMAP"; case 3: return "CF_METAFILEPICT";
          case 7: return "CF_OEMTEXT"; case 8: return "CF_DIB"; case 13: return "CF_UNICODETEXT";
          case 14: return "CF_ENHMETAFILE"; case 15: return "CF_HDROP"; case 16: return "CF_LOCALE";
          case 17: return "CF_DIBV5";
        }
        if (f >= 0xC000) {
          var sb = new StringBuilder(128);
          int n = Native.GetClipboardFormatNameW(f, sb, sb.Capacity);
          if (n > 0) return sb.ToString(0, n);
        }
        return "#" + f.ToString(CultureInfo.InvariantCulture);
      }
    }

    // ================================================================ codecs (pure, testable)

    static class Codec {
      public sealed class Format {
        public string Name; public byte[] Data;
        public Format(string name, byte[] data) { Name = name; Data = data; }
      }

      public static string Utf16z(byte[] b) {
        int n = b.Length & ~1;
        for (int i = 0; i + 1 < b.Length; i += 2) if (b[i] == 0 && b[i + 1] == 0) { n = i; break; }
        return Encoding.Unicode.GetString(b, 0, n);
      }

      public static byte[] Utf16zBytes(string s) {
        return Encoding.Unicode.GetBytes(s + "\0");
      }

      /// A CF_HTML payload (the header with byte offsets the format requires) around `fragment`.
      public static byte[] HtmlClipboardBytes(string fragment) {
        const string pre = "<html><body><!--StartFragment-->", post = "<!--EndFragment--></body></html>";
        string hdr = "Version:0.9\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
        int hdrLen = string.Format(CultureInfo.InvariantCulture, hdr, 0, 0, 0, 0).Length;
        int startHtml = hdrLen;
        int startFrag = startHtml + Encoding.UTF8.GetByteCount(pre);
        int endFrag = startFrag + Encoding.UTF8.GetByteCount(fragment);
        int endHtml = endFrag + Encoding.UTF8.GetByteCount(post);
        string all = string.Format(CultureInfo.InvariantCulture, hdr, startHtml, endHtml, startFrag, endFrag) + pre + fragment + post;
        return Encoding.UTF8.GetBytes(all + "\0");
      }

      public static byte[] EncodeDropFiles(string[] paths) {
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(20);        // pFiles: the list starts right after this 20-byte DROPFILES
        w.Write(0); w.Write(0);   // pt
        w.Write(0);         // fNC
        w.Write(1);         // fWide: UTF-16
        foreach (string p in paths) w.Write(Encoding.Unicode.GetBytes(p + "\0"));
        w.Write(Encoding.Unicode.GetBytes("\0"));
        w.Flush();
        return ms.ToArray();
      }

      public static string[] DecodeDropFiles(byte[] b) {
        if (b == null || b.Length < 20) return null;
        int off = BitConverter.ToInt32(b, 0);
        bool wide = BitConverter.ToInt32(b, 16) != 0;
        if (off < 20 || off >= b.Length) return null;
        var list = new List<string>();
        int i = off;
        while (i < b.Length) {
          int start = i;
          if (wide) {
            while (i + 1 < b.Length && !(b[i] == 0 && b[i + 1] == 0)) i += 2;
            if (i == start) break;
            list.Add(Encoding.Unicode.GetString(b, start, i - start));
            i += 2;
          } else {
            while (i < b.Length && b[i] != 0) i++;
            if (i == start) break;
            list.Add(Encoding.Default.GetString(b, start, i - start));
            i++;
          }
          if (list.Count > 10000) break;
        }
        return list.ToArray();
      }

      public static Bitmap FromPng(byte[] png) {
        // Bitmap keeps reading its stream lazily, so it is copied into a fresh bitmap that owns
        // its pixels and the stream can go.
        using (var ms = new MemoryStream(png))
        using (var src = new Bitmap(ms)) {
          var copy = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
          using (Graphics g = Graphics.FromImage(copy)) g.DrawImage(src, 0, 0, src.Width, src.Height);
          return copy;
        }
      }

      /// A packed DIB (BITMAPINFOHEADER / V4 / V5 + masks + palette + bits). 24 and 32 bpp -
      /// what screenshots and browsers put there - are decoded here directly; anything else goes
      /// through GDI+ as a BMP file. 32 bpp alpha is IGNORED on purpose: many apps leave it 0,
      /// which would read as a fully transparent picture.
      public static Bitmap FromDib(byte[] dib) {
        if (dib == null || dib.Length < 40) throw new InvalidDataException("DIB too short");
        int hdr = BitConverter.ToInt32(dib, 0);
        int w = BitConverter.ToInt32(dib, 4);
        int hRaw = BitConverter.ToInt32(dib, 8);
        int bpp = BitConverter.ToInt16(dib, 14);
        int comp = BitConverter.ToInt32(dib, 16);
        int clrUsed = BitConverter.ToInt32(dib, 32);
        int h = Math.Abs(hRaw);
        if (w <= 0 || h <= 0 || (long)w * h > 60000000L) throw new InvalidDataException("DIB size out of range");
        int masks = (hdr == 40 && comp == 3) ? 12 : 0;            // BI_BITFIELDS after a v3 header
        int palette = bpp <= 8 ? (clrUsed != 0 ? clrUsed : (1 << bpp)) * 4 : clrUsed * 4;
        int bits = hdr + masks + palette;
        if ((bpp == 32 || bpp == 24) && (comp == 0 || comp == 3)) {
          int stride = ((w * bpp + 31) / 32) * 4;
          if (bits + (long)stride * h > dib.Length) {
            // A writer that set BI_BITFIELDS but left the three masks out: the pixels start
            // right after the header.
            if (masks == 12 && bits - 12 + (long)stride * h <= dib.Length) bits -= 12;
            else throw new InvalidDataException("DIB shorter than its pixels");
          }
          var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
          BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
          try {
            var row = new byte[w * 4];
            int px = bpp / 8;
            for (int y = 0; y < h; y++) {
              int srcRow = hRaw > 0 ? (h - 1 - y) : y;   // positive height = bottom-up
              int s = bits + srcRow * stride;
              for (int x = 0; x < w; x++) {
                row[x * 4] = dib[s + x * px];
                row[x * 4 + 1] = dib[s + x * px + 1];
                row[x * 4 + 2] = dib[s + x * px + 2];
                row[x * 4 + 3] = 255;
              }
              Marshal.Copy(row, 0, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), row.Length);
            }
          } finally { bmp.UnlockBits(bd); }
          return bmp;
        }
        var file = new byte[14 + dib.Length];
        file[0] = (byte)'B'; file[1] = (byte)'M';
        BitConverter.GetBytes(file.Length).CopyTo(file, 2);
        BitConverter.GetBytes(14 + bits).CopyTo(file, 10);
        Buffer.BlockCopy(dib, 0, file, 14, dib.Length);
        return FromPng(file);   // GDI+ sniffs the format: this is "load an image from bytes"
      }

      /// 32 bpp BI_RGB, bottom-up, composited onto WHITE: apps that read CF_DIB mostly ignore
      /// alpha, and a transparent pixel with RGB 0 would paste as black. The PNG format carries
      /// the real alpha for the apps that read it.
      public static byte[] ToDib(Bitmap src) {
        int w = src.Width, h = src.Height;
        using (var flat = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
          using (Graphics g = Graphics.FromImage(flat)) { g.Clear(Color.White); g.DrawImage(src, 0, 0, w, h); }
          BitmapData bd = flat.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          try {
            int stride = w * 4;
            var dib = new byte[40 + (long)stride * h];
            BitConverter.GetBytes(40).CopyTo(dib, 0);
            BitConverter.GetBytes(w).CopyTo(dib, 4);
            BitConverter.GetBytes(h).CopyTo(dib, 8);
            BitConverter.GetBytes((short)1).CopyTo(dib, 12);
            BitConverter.GetBytes((short)32).CopyTo(dib, 14);
            BitConverter.GetBytes(0).CopyTo(dib, 16);
            BitConverter.GetBytes(stride * h).CopyTo(dib, 20);
            for (int y = 0; y < h; y++)
              Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), dib, 40 + (h - 1 - y) * stride, stride);
            for (int i = 40 + 3; i < dib.Length; i += 4) dib[i] = 0;   // BI_RGB: the 4th byte is reserved
            return dib;
          } finally { flat.UnlockBits(bd); }
        }
      }

      public static byte[] ToPng(Bitmap bmp) {
        using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
      }

      /// A small JPEG for the panel: at most 480x180 px (the row is ~330 DIP wide and 90 tall,
      /// at up to 150% scale), on white, quality 85 - tens of KB where a PNG of a screenshot
      /// would be hundreds.
      public static string Thumb(Bitmap src) {
        double k = Math.Min(1.0, Math.Min(480.0 / src.Width, 180.0 / src.Height));
        int tw = Math.Max(1, (int)Math.Round(src.Width * k)), th = Math.Max(1, (int)Math.Round(src.Height * k));
        using (var t = new Bitmap(tw, th, PixelFormat.Format24bppRgb)) {
          using (Graphics g = Graphics.FromImage(t)) {
            g.Clear(Color.White);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, 0, 0, tw, th);
          }
          ImageCodecInfo jpeg = null;
          foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) jpeg = c;
          using (var ms = new MemoryStream()) {
            if (jpeg != null) {
              var ep = new EncoderParameters(1);
              ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
              t.Save(ms, jpeg, ep);
              return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
            }
            t.Save(ms, ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
          }
        }
      }

      /// Every clipboard format a paste of this item sets, in the order it sets them.
      public static string Encode(string text, byte[] html, byte[] rtf, byte[] png, string[] files, out List<Format> list) {
        list = new List<Format>();
        if (files != null && files.Length > 0) {
          list.Add(new Format("CF_HDROP", EncodeDropFiles(files)));
          list.Add(new Format("Preferred DropEffect", BitConverter.GetBytes(5)));   // copy, as Explorer's Ctrl+C
        }
        if (text != null) list.Add(new Format("CF_UNICODETEXT", Utf16zBytes(text)));
        if (html != null) list.Add(new Format("HTML Format", html));
        if (rtf != null) list.Add(new Format("Rich Text Format", rtf));
        if (png != null) {
          try {
            using (Bitmap bmp = FromPng(png)) {
              list.Add(new Format("PNG", png));
              list.Add(new Format("CF_DIB", ToDib(bmp)));
            }
          } catch (Exception) { return "its picture could not be read"; }
        }
        if (list.Count == 0) return "the item has nothing to paste";
        return null;
      }

      /// Decode every encoded format back with the listener's own readers and compare. null = equal.
      public static string RoundTrip(string text, byte[] html, byte[] rtf, byte[] png, string[] files, List<Format> formats) {
        foreach (Format f in formats) {
          switch (f.Name) {
            case "CF_UNICODETEXT":
              if (Utf16z(f.Data) != text) return "text did not survive the round trip";
              break;
            case "CF_HDROP":
              string[] back = DecodeDropFiles(f.Data);
              if (back == null || back.Length != files.Length) return "the file list did not survive the round trip";
              for (int i = 0; i < back.Length; i++) if (back[i] != files[i]) return "a file path did not survive the round trip";
              break;
            case "CF_DIB":
              using (Bitmap a = FromPng(png))
              using (Bitmap b = FromDib(f.Data)) {
                if (a.Width != b.Width || a.Height != b.Height) return "the picture changed size in the round trip";
                // Opaque pixels must match exactly; the corners and the middle cover a flip or a mirror.
                int[][] pts = { new[] { 0, 0 }, new[] { a.Width - 1, 0 }, new[] { 0, a.Height - 1 },
                                new[] { a.Width - 1, a.Height - 1 }, new[] { a.Width / 4, a.Height / 4 } };
                foreach (int[] p in pts) {
                  Color ca = a.GetPixel(p[0], p[1]), cb = b.GetPixel(p[0], p[1]);
                  if (ca.A == 255 && (ca.R != cb.R || ca.G != cb.G || ca.B != cb.B))
                    return "the picture's pixels changed in the round trip (at " + p[0] + "," + p[1] + ")";
                }
              }
              break;
            case "HTML Format":
              if (html == null || f.Data.Length != html.Length) return "the HTML did not survive the round trip";
              break;
            case "Rich Text Format":
              if (rtf == null || f.Data.Length != rtf.Length) return "the rich text did not survive the round trip";
              break;
          }
        }
        return null;
      }
    }

    // ================================================================ the listener thread

    static class Listener {
      const int WM_CLIPBOARDUPDATE = 0x031D;
      const int WM_WORK = 0x8000 + 0x51;   // WM_APP + 0x51: "drain the work queue"

      static readonly object _lk = new object();
      static Thread _thread;
      static Win _win;
      static bool _observe;
      static readonly Queue<Action> _work = new Queue<Action>();
      public static uint OwnSeq;           // the sequence number our own last write produced

      sealed class Win : NativeWindow {
        public System.Windows.Forms.Timer Debounce;
        public Win() {
          var cp = new CreateParams();
          cp.Caption = "Mantle clipboard history";
          cp.Parent = new IntPtr(-3);        // HWND_MESSAGE: never shown, never in any z-order
          CreateHandle(cp);
          Debounce = new System.Windows.Forms.Timer();
          Debounce.Interval = DebounceMs;
          Debounce.Tick += delegate (object s, EventArgs e) {
            Debounce.Stop();
            try { Capture(_observe, new LiveSource(Handle), true); }
            catch (Exception ex) {
              try { Native.CloseClipboard(); } catch (Exception) { }
              Bump("error");
              Program.EmitLog("warn", "clipboard: a copy could not be read (" + ex.GetType().Name + ")");
            }
          };
        }
        protected override void WndProc(ref Message m) {
          if (m.Msg == WM_CLIPBOARDUPDATE) {
            // Apps often open/set/close several times for one copy: wait for it to settle.
            Debounce.Stop(); Debounce.Start();
            m.Result = IntPtr.Zero;
            return;
          }
          if (m.Msg == WM_WORK) { Drain(); return; }
          base.WndProc(ref m);
        }
      }

      static void Drain() {
        while (true) {
          Action a;
          lock (_lk) { if (_work.Count == 0) return; a = _work.Dequeue(); }
          try { a(); } catch (Exception ex) { Program.EmitLog("warn", "clipboard: listener work failed (" + ex.GetType().Name + ")"); }
        }
      }

      /// Start (or re-mode) the listener. Returns null, or why it could not listen.
      public static string Start(bool observe) {
        lock (_lk) {
          _observe = observe;
          if (_thread != null && _win != null) return null;
        }
        string err = null;
        var ready = new ManualResetEvent(false);
        var t = new Thread(delegate () {
          try {
            var w = new Win();
            if (!Native.AddClipboardFormatListener(w.Handle)) {
              Program.EmitLog("warn", "clipboard: AddClipboardFormatListener failed (error " + Marshal.GetLastWin32Error() + ")");
              err = "Windows did not let Mantle watch the clipboard";
              w.DestroyHandle();
              ready.Set();
              return;
            }
            lock (_lk) _win = w;
            ready.Set();
            Application.Run();
            Native.RemoveClipboardFormatListener(w.Handle);
            w.Debounce.Dispose();
            w.DestroyHandle();
          } catch (Exception ex) {
            Program.EmitLog("warn", "clipboard: listener thread failed (" + ex.GetType().Name + ")");
            err = "Mantle's clipboard watcher stopped unexpectedly";
            ready.Set();
          }
        });
        t.Name = "mantle-clip";
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        if (!ready.WaitOne(3000)) return "Mantle could not start watching the clipboard in time";
        if (err != null) return err;
        lock (_lk) _thread = t;
        return null;
      }

      public static void Stop() {
        Thread t;
        lock (_lk) { t = _thread; _thread = null; }
        if (t == null) return;
        Post(delegate () { Application.ExitThread(); });
        t.Join(2000);
        lock (_lk) _win = null;
      }

      static void Post(Action a) {
        IntPtr h;
        lock (_lk) { _work.Enqueue(a); h = _win != null ? _win.Handle : IntPtr.Zero; }
        if (h != IntPtr.Zero) Native.PostMessageW(h, WM_WORK, IntPtr.Zero, IntPtr.Zero);
      }

      /// Run on the listener thread and wait. Writes happen there because the clipboard's owner
      /// window must belong to a thread that pumps messages (WM_DESTROYCLIPBOARD etc.).
      static string Invoke(Func<string> fn, int timeoutMs) {
        bool running;
        lock (_lk) running = _win != null;
        if (!running) return "clipboard history is not running";
        string r = null;
        var done = new ManualResetEvent(false);
        Post(delegate () { try { r = fn(); } finally { done.Set(); } });
        if (!done.WaitOne(timeoutMs)) return "the clipboard did not answer in time; try again";
        return r;
      }

      /// Opens the clipboard, retrying for ~150 ms: another app may hold it for a moment.
      public static bool Open(IntPtr hwnd) {
        for (int i = 0; i < 6; i++) {
          if (Native.OpenClipboard(hwnd)) return true;
          Thread.Sleep(25);
        }
        return false;
      }

      public static string Write(List<Codec.Format> formats) {
        return Invoke(delegate () {
          IntPtr hwnd = _win.Handle;
          if (!Open(hwnd)) return "another app is holding the clipboard; try again";
          try {
            if (!Native.EmptyClipboard()) { Program.EmitLog("warn", "clipboard: EmptyClipboard failed (error " + Marshal.GetLastWin32Error() + ")"); return "Windows did not let Mantle change the clipboard"; }
            foreach (Codec.Format f in formats) {
              uint id = Fmt.ByName(f.Name);
              IntPtr h = Native.GlobalAlloc(0x0002 /* GMEM_MOVEABLE */, new UIntPtr((ulong)f.Data.Length));
              if (h == IntPtr.Zero) return "there was not enough memory to put it on the clipboard";
              IntPtr p = Native.GlobalLock(h);
              Marshal.Copy(f.Data, 0, p, f.Data.Length);
              Native.GlobalUnlock(h);
              if (Native.SetClipboardData(id, h) == IntPtr.Zero) {
                Native.GlobalFree(h);
                Program.EmitLog("warn", "clipboard: SetClipboardData " + f.Name + " failed (error " + Marshal.GetLastWin32Error() + ")");
                return "Windows did not accept the item on the clipboard";
              }
            }
          } finally {
            Native.CloseClipboard();
            OwnSeq = Native.GetClipboardSequenceNumber();
          }
          lock (_gate) _ownWrites++;
          return null;
        }, 3000);
      }
    }

    // ================================================================ P/Invoke (this file only)

    static class Native {
      [StructLayout(LayoutKind.Sequential)]
      public struct GUITHREADINFO {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public Win32.RECT rcCaret;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct DATA_BLOB { public int cbData; public IntPtr pbData; }

      [DllImport("user32.dll", SetLastError = true)] public static extern bool AddClipboardFormatListener(IntPtr hwnd);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr hwnd);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
      [DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
      [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetClipboardData(uint fmt);
      [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
      [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint fmt);
      [DllImport("user32.dll", SetLastError = true)] public static extern uint EnumClipboardFormats(uint fmt);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormatW(string name);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClipboardFormatNameW(uint fmt, StringBuilder sb, int max);
      [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
      [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(int tid, ref GUITHREADINFO gti);
      [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Win32.POINT p);
      [DllImport("user32.dll")] public static extern bool GetCursorPos(out Win32.POINT p);
      [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalLock(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GlobalUnlock(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern UIntPtr GlobalSize(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalFree(IntPtr h);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, int access, out IntPtr token);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out int value, int len, out int retLen);
      [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool CryptProtectData(ref DATA_BLOB dataIn, string descr, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB dataOut);
      [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool CryptUnprotectData(ref DATA_BLOB dataIn, IntPtr descr, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB dataOut);
    }
  }
}
