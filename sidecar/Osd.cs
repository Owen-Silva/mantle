// Osd.cs - `osd.*`: what Mantle's volume pop-up needs from the sidecar (osd lane, wave 3,
// 2026-09-24).
//
//   osd.volume {op, step?, dry?, from?}   one VOLUME KEY press, done the way Windows does it:
//                    op 'up' / 'down' move the master volume by `step` (default 2, Windows' own
//                    step: 50 notches from 0 to 100), snapped to a multiple of the step (33 -> 34
//                    up, 33 -> 32 down), clamped to 0-100, and they UNMUTE (Windows' keys unmute
//                    on either; not measured here - a test may not press a key). op 'mute' toggles
//                    mute and leaves the level. Audio lane, so a held key's repeats are applied one
//                    after another and none reads a level the previous one has not written yet.
//                    dry:true computes the answer WITHOUT writing (allowed in passive): from the
//                    real device, or from `from:{level, muted}` so a --test instance can step a
//                    pretend level up and down with this exact arithmetic. A real step is refused
//                    in passive.
//   osd.qs           {qsOpen}: is the quick-settings panel open. The pop-up stays down while it is:
//                    the open panel already shows the level (QuickSettings.PanelOpen).
//
// WHY MANTLE STEPS THE VOLUME ITSELF (2026-09-24): Windows' own volume/brightness flyout host could
// not be found on Windows 11 25H2 (26200.9550: no NativeHWNDHost + DirectUIHWND in explorer, nothing
// flyout-like among explorer.exe / ShellHost.exe windows at rest), so it cannot be hidden. Instead the
// keyboard hook TAKES VolumeUp / VolumeDown / VolumeMute (KeyMachine chords in AltTab.cs, only while
// lib/features/osd.js is on and healthy): a key Windows never sees shows no Windows flyout, and this
// command does what the key would have done. The BRIGHTNESS keys are handled in the laptop's firmware
// (a WmiMonitorBrightnessEvent, no key reaches the hook), so they cannot be taken; Mantle shows no
// brightness pop-up at all rather than a second one over Windows' own.
using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Mantle {
  [MantleFeature]
  static class Osd {
    public static void Register(FeatureTable t) {
      t.Add("osd.volume", Lanes.Audio, Step);   // CoreAudio COM: the same lane as `volume`
      t.Add("osd.qs", Lanes.Ui, Qs);            // one field read: fast
    }

    // ------------------------------------------------------------------ is the panel open

    static string Qs(Dictionary<string, object> req, ref object result) {
      result = Json.Obj("ok", true, "qsOpen", QuickSettings.PanelOpen);
      return null;
    }

    // ------------------------------------------------------------------ one volume key

    /// The arithmetic of one press. PURE (proved through `dry` in sidecar/test-osd.js).
    public static void Target(string op, int step, int level, bool muted, out int toLevel, out bool toMuted) {
      level = Math.Max(0, Math.Min(100, level));
      if (op == "mute") { toLevel = level; toMuted = !muted; return; }
      toMuted = false;
      if (op == "up") toLevel = Math.Min(100, (level / step) * step + step);
      else toLevel = Math.Max(0, ((level + step - 1) / step) * step - step);
    }

    static string Step(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op");
      if (op != "up" && op != "down" && op != "mute")
        return "osd.volume needs op 'up', 'down' or 'mute' (got " + (op == null ? "none" : "'" + op + "'") + ")";
      int step = Json.GetInt(req, "step", 2);
      if (step < 1 || step > 10) return "osd.volume step must be 1-10 (got " + step + ")";
      bool dry = Json.GetBool(req, "dry", false);
      object fromRaw;
      var from = Json.TryGet(req, "from", out fromRaw) ? fromRaw as Dictionary<string, object> : null;
      if (from != null && !dry) return "osd.volume: `from` is for a dry run only (a real press always reads the device)";
      if (!dry && Program.Passive) return FeatureTable.PassiveRefusal + ": it would have stepped the volume " + op;

      long t0 = Stopwatch.GetTimestamp();
      int level; bool muted;
      try {
        if (from != null) {
          if (!Json.HasKey(from, "level")) return "osd.volume: `from` needs a level";
          level = Math.Max(0, Math.Min(100, Json.GetInt(from, "level", 0)));
          muted = Json.GetBool(from, "muted", false);
        } else {
          Volume.Apply(null, null, out level, out muted);
        }
      } catch (Exception ex) {
        return "the volume could not be read: " + ex.Message;
      }
      int toLevel; bool toMuted;
      Target(op, step, level, muted, out toLevel, out toMuted);
      bool changed = toLevel != level || toMuted != muted;
      int gotLevel = toLevel; bool gotMuted = toMuted;
      if (!dry && changed) {
        try {
          Volume.Apply(toLevel != level ? (int?)toLevel : null, toMuted != muted ? (bool?)toMuted : null,
                       out gotLevel, out gotMuted);
        } catch (Exception ex) {
          return "the volume could not be stepped " + op + ": " + ex.Message;
        }
      }
      long ms = (Stopwatch.GetTimestamp() - t0) * 1000 / Stopwatch.Frequency;
      result = Json.Obj("ok", true, "op", op, "dry", dry, "level", gotLevel, "muted", gotMuted,
                        "from", Json.Obj("level", level, "muted", muted), "changed", changed, "ms", ms);
      return null;
    }
  }
}
