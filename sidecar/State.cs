// State.cs - the note Mantle leaves on the kitchen table.
//
// WHY THIS FILE EXISTS. On 2026-09-21 Mantle left the Windows taskbar stuck
// hidden and the machine needed a reboot (the full story is at the top of
// Taskbar.cs). The fix has two halves. The first is that Mantle no longer holds
// any shell state a dead process has to undo. The second is this: BEFORE
// touching anything, the sidecar writes down what the shell looked like, so a
// standalone recovery script - or Owen at a command prompt, with Mantle gone
// and unable to run - can put Windows back without guessing.
//
// The file is written:
//   * at startup, with the ORIGINAL state, before anything is changed
//     (reading ABM_GETSTATE and SPI_GETWORKAREA changes nothing, so this
//      happens in --passive too);
//   * after every change we make;
//   * at the end of the restore path, with restored:true.
//
// Writes are ATOMIC-ish by the only means available without a real filesystem
// API: the content goes to "<path>.tmp" first and is then copied over the
// target, so a reader never sees a half-written file. If it cannot be written
// at all, that is a warn on the wire with the reason - never a silent failure,
// and never fatal: a sidecar that cannot write its notes still works.
//
// Shape (lane B's recovery script reads exactly this):
//   { "writtenAt": "<ISO>", "pid": <n>, "units": "physical",
//     "original": { "abmState": <n>, "workarea": [l,t,r,b] },
//     "changed":  { "autohide": <bool>, "appbars": ["<hwnd>", ...],
//                   "taskbarRegion": <bool> },   // TaskbarHide.cs: an empty window region is held
//                                                // on the taskbar (restore-windows.ps1 clears it)
//     "restored": <bool> }
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Mantle {
  static class ShellState {
    static string _path;
    static bool _enabled;

    static int _origAbmState;
    static Win32.RECT _origWorkArea;

    static bool _autohideChanged;
    static bool _taskbarRegion;
    static readonly List<long> _appbars = new List<long>();
    static bool _restored;

    static readonly object _lock = new object();
    static string _lastWriteError;

    /// Set by the shutdown path. A failed write then comes back as a RETURN
    /// VALUE for the restore event instead of going to stdout - because the
    /// whole reason the 2026-09-21 crash test lost its `restored:true` was a
    /// stdout write that blocked forever on a pipe with no reader.
    public static bool Quiet;

    /// --state-file=<path>. Absent is legal (the sidecar still runs), but it
    /// costs a recovery script its only source of truth, so it is announced.
    public static void Configure(string path) {
      _path = path;
      _enabled = !string.IsNullOrEmpty(path);
    }

    public static bool Enabled { get { return _enabled; } }
    public static string Path { get { return _path; } }

    /// Read-only, runs in every mode including --passive, before any change.
    public static void CaptureOriginal() {
      Taskbar.CaptureOriginal();
      WorkArea.CaptureOriginal();
      _origAbmState = Taskbar.OriginalState;
      _origWorkArea = WorkArea.Original;
    }

    public static void SetAutohideChanged(bool changed) {
      lock (_lock) { _autohideChanged = changed; }
      Write();
    }

    public static void SetTaskbarRegion(bool held) {
      lock (_lock) { _taskbarRegion = held; }
      Write();
    }

    public static void AddAppBar(long hwnd) {
      lock (_lock) { if (!_appbars.Contains(hwnd)) _appbars.Add(hwnd); }
      Write();
    }

    public static void RemoveAppBar(long hwnd) {
      lock (_lock) { _appbars.Remove(hwnd); }
      Write();
    }

    /// Returns null once the file is on disk, or plain words about why not.
    public static string MarkRestored(bool restored) {
      lock (_lock) { _restored = restored; }
      return Write();
    }

    /// Never throws. Returns plain words on failure (also emitted as a warn),
    /// or null when the file is on disk - or when there is no file to write.
    public static string Write() {
      if (!_enabled) return null;
      string json;
      string target = _path;
      lock (_lock) {
        var appbars = new List<string>();
        foreach (long h in _appbars) appbars.Add(h.ToString(CultureInfo.InvariantCulture));
        json = Json.Write(Json.Obj(
          "writtenAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
          "pid", Program.OwnPid,
          // What the numbers below MEAN. The sidecar makes itself DPI-aware in
          // Program.InitDpi, so they are physical pixels - a recovery script
          // feeding `workarea` back to SPI_SETWORKAREA from a DPI-unaware
          // process would otherwise set an area 80% of the right size. If
          // awareness could not be turned on, this says so instead of lying.
          "units", Program.DpiAware ? "physical" : "virtualised",
          "original", Json.Obj(
            "abmState", _origAbmState,
            "workarea", new object[] { _origWorkArea.left, _origWorkArea.top, _origWorkArea.right, _origWorkArea.bottom }),
          "changed", Json.Obj(
            "autohide", _autohideChanged,
            "appbars", appbars.ToArray(),
            "taskbarRegion", _taskbarRegion),
          "restored", _restored));
      }

      try {
        string dir = System.IO.Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        string tmp = target + ".tmp";
        // UTF-8 with no BOM: the same convention as the wire protocol, so a
        // reader that handles our stdout handles this file too.
        File.WriteAllText(tmp, json + "\n", new UTF8Encoding(false));
        File.Copy(tmp, target, true);
        try { File.Delete(tmp); } catch (Exception) { }
        _lastWriteError = null;
        return null;
      } catch (Exception ex) {
        string msg = "could not write the state file " + target + ": " + ex.Message +
                     " (a recovery script will not know the original shell state)";
        // Say it once per distinct reason: this can be called several times a
        // second during shutdown and a wall of identical warnings helps nobody.
        if (_lastWriteError != msg && !Quiet) {
          _lastWriteError = msg;
          try { Program.EmitLog("warn", msg); } catch (Exception) { }
        }
        return msg;
      }
    }
  }
}
