// AltTab.cs - Mantle's own Alt+Tab, and Win+N / Win+A opening Mantle's panels.
//
// WHO DOES WHAT (2026-09-23):
//   Hotkey.cs    owns the ONE low-level keyboard hook, on its own thread, and
//                asks KeyMachine (below) what to do with every keystroke.
//   KeyMachine   every keyboard decision, as a PURE state machine: no Win32, no
//                clock, no allocation. The hook feeds it real keys; the test
//                harness feeds it scripted ones (`hotkey {op:'simulate'}`), so
//                tap / hold+cycle / Shift+Tab / Esc / Alt-before-Tab /
//                Tab-before-Alt / auto-repeat / Win held are all provable
//                without a hook and without a single synthetic keystroke.
//   Switcher     the session: which windows, in what order, which one is
//                selected, and ACTIVATING the chosen one. It runs on the hook's
//                thread and needs nothing from Electron, which is the whole
//                point: if the overlay page is slow, hung or crashed, releasing
//                Alt still switches (Owen's hard requirement: "Alt+Tab must
//                never go dead"). Electron only DRAWS the session.
//
// THE THREE RULES THE HOOK NEVER BREAKS:
//   1. An Alt keyup, a Win keyup, or any modifier (Shift, Ctrl) is NEVER
//      swallowed. A modifier whose up is eaten leaves Windows believing it is
//      held forever (see Hotkey.cs). Only Tab, Esc, the arrows and, with Win
//      held, N and A are ever swallowed - and a swallowed keydown always has
//      its keyup swallowed too, so no app ever sees half a keystroke.
//   2. "Is Alt held" comes from the EVENT (LLKHF_ALTDOWN, the system's own key
//      state), never from our bookkeeping alone. Our bookkeeping can miss a
//      keyup - an elevated window in front hides keys from a non-elevated hook
//      (documented under UIPI) - and a machine that trusted it would swallow a
//      plain Tab forever after. Win is read the same way (GetAsyncKeyState).
//   3. Before the real Alt-up that ends a hold in which we swallowed a key, we
//      inject VK 0xFF, exactly like the solo-Win trick. The focused app saw
//      Alt-down and then (because Tab was eaten) nothing, so without a partner
//      key it would treat the Alt-up as a solo Alt tap and open its menu bar.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {

  /// Every keyboard decision the hook makes. PURE: the caller supplies the
  /// modifier states (the hook reads them from the system, a test scripts
  /// them), and Step answers what to do with the key plus at most one event.
  sealed class KeyMachine {
    public const int Pass = 0, Swallow = 1, DummyFirst = 2;

    public const int EvNone = 0, EvWinTap = 1, EvOpen = 2, EvNext = 3, EvPrev = 4,
                     EvLeft = 5, EvRight = 6, EvUp = 7, EvDown = 8, EvCommit = 9,
                     EvCancel = 10, EvStale = 11, EvWinKey = 12, EvChord = 13, EvKey = 14;
    public static readonly string[] EventNames = {
      "none", "wintap", "open", "next", "prev", "left", "right", "up", "down",
      "commit", "cancel", "stale", "winkey", "chord", "key"
    };

    // FEATURE CHORDS (wave 3, 2026-09-24). The chords lib/features/*.js may take from Windows,
    // and the keys they may watch. A chord is its key plus an EXACT modifier set: Win+Left does
    // not match Win+Shift+Left (move to the other monitor), Win+S does not match Win+Shift+S, and
    // Ctrl and Alt held are never a chord unless the chord names them (Win+Alt+T, Win+Ctrl+T). Index = bit
    // in Chords / Observe. The names are the protocol (main sends them, events carry them):
    // append, never reorder.
    //
    // THE VOLUME KEYS AS CHORDS (osd lane, 2026-09-24): bare VolumeUp / VolumeDown / VolumeMute, no
    // modifier (Win/Shift/Ctrl/Alt + a volume key stays Windows'). Windows' own flyout host cannot
    // be found on 25H2 (sidecar/Osd.cs), so the only way to have Mantle's pop-up and not Windows' is
    // that Windows never sees the key: taken, Mantle steps the volume itself (osd.volume). Unlike a
    // Win chord, a held Volume Up/Down REPEATS (each auto-repeat is one more event, one more step,
    // as Windows does); a held Mute is one toggle (ChordRepeats).
    //
    // WIN+ALT+T (lane tbvideo, 2026-09-26): the top bar's hide / show. The first chord with Alt in
    // its set (ChordAlt): Win+T (Windows' taskbar cycling) and Win+Ctrl+Alt+T stay Windows'. Taken,
    // both Win and Alt get their partner key before their keyup (0xFF), so neither Start nor the
    // focused app's menu bar opens. Windows' own use of it is Game Bar's recording-timer toggle.
    //
    // WIN+CTRL+T (lane ontop, 2026-09-27): "Keep on top" for the window in front (PowerToys' key).
    // The first chord with Ctrl in its set (ChordCtrl), added the way Alt was: only this chord
    // names Ctrl, so every other chord still refuses a held Ctrl, and Win+Ctrl+Shift+T /
    // Win+Ctrl+Alt+T stay Windows'. Not a Windows shortcut: RegisterHotKey(MOD_WIN|MOD_CONTROL, 'T')
    // succeeded on 25H2 (26200) and 26H2 (26300) while Win+T, Win+Alt+T and Win+Ctrl+D were refused as taken
    // (error 1409), the control that the probe sees explorer's keys. Taken, Win gets its partner key
    // before its keyup (Start stays shut) and so does CTRL (_swallowedInCtrl): with the T eaten, a
    // Ctrl down/up with nothing between is a "lone Ctrl tap" to whatever watches for one (Windows'
    // "show the pointer when I press Ctrl", double-Ctrl tools). The Ctrl keyup itself always passes.
    //
    // WIN+ALT+N (lane tbtools, 2026-09-27): the top bar's quick notes pad. A second Alt chord, taken
    // exactly like Win+Alt+T (ChordAlt: Win and Alt both get the partner key before their keyup).
    // Not a Windows shortcut: RegisterHotKey(MOD_WIN|MOD_ALT, 'N') succeeded on 25H2 (26200) and 26H2 (26300) while
    // the controls Win+Alt+T, Win+Alt+R, Win+Alt+G and Win+Alt+K (Game Bar's) were refused as taken
    // (error 1409). Win+N (notifications), Win+Ctrl+Alt+N and Win+Alt+Shift+N stay Windows'.
    //
    // WIN+I (lane settings, 2026-09-28): Mantle Settings, in place of Windows' Settings app. A plain
    // Win chord like Win+V (VK 0x49, no Shift/Alt/Ctrl in its set), so Win+Shift+I, Win+Ctrl+I and
    // Win+Alt+I stay Windows' by the exact-modifier rule, and the Win-up gets the partner key.
    //
    // CTRL+SHIFT+ESC (lane taskmgr, 2026-09-28): Mantle's task manager, in place of Windows'. The
    // first chord with NO Win and two modifiers: exactly Ctrl+Shift held (ChordCtrl + ChordShift),
    // so plain Esc, Ctrl+Esc (Start), Alt+Esc (window cycling), Ctrl+Alt+Esc and Win+Ctrl+Shift+Esc
    // stay Windows'. Esc is also the switcher's cancel key: this table is asked FIRST (Step), and
    // any Esc that is not exactly Ctrl+Shift falls through to EscDown unchanged (an open Alt+Tab
    // has Alt held, so it can never be this chord). Taken, the Ctrl-up gets the partner key
    // (_swallowedInCtrl, as Win+Ctrl+T) so nothing reads a lone Ctrl tap; no Win is involved.
    //
    // WIN+E (lane files, 2026-09-28): Mantle Files, in place of File Explorer. A plain Win chord
    // like Win+I (VK 0x45), so Win+Shift+E, Win+Ctrl+E and Win+Alt+E stay Windows'.
    public static readonly string[] ChordNames = {
      "Win+S", "Win+V", "Win+Tab", "Win+Left", "Win+Right", "Win+Up", "Win+Down", "Win+Z",
      "Win+Shift+S", "PrintScreen", "VolumeUp", "VolumeDown", "VolumeMute", "Win+Alt+T", "Win+Ctrl+T", "Win+Alt+N", "Win+I",
      "Ctrl+Shift+Esc", "Win+E"
    };
    static readonly int[] ChordVk = { 0x53, 0x56, 0x09, 0x25, 0x27, 0x26, 0x28, 0x5A, 0x53, 0x2C, 0xAF, 0xAE, 0xAD, 0x54, 0x54, 0x4E, 0x49, 0x1B, 0x45 };
    static readonly bool[] ChordWin = { true, true, true, true, true, true, true, true, true, false, false, false, false, true, true, true, true, false, true };
    static readonly bool[] ChordShift = { false, false, false, false, false, false, false, false, true, false, false, false, false, false, false, false, false, true, false };
    static readonly bool[] ChordAlt = { false, false, false, false, false, false, false, false, false, false, false, false, false, true, false, true, false, false, false };
    static readonly bool[] ChordCtrl = { false, false, false, false, false, false, false, false, false, false, false, false, false, false, true, false, false, true, false };
    static readonly bool[] ChordRepeats = { false, false, false, false, false, false, false, false, false, false, true, true, false, false, false, false, false, false, false };
    /// Observed keys are REPORTED on every keydown (auto-repeat included: a held Volume Up keeps
    /// stepping) and NEVER swallowed: Windows still changes the volume itself. A volume key that
    /// is also a TAKEN chord is the chord's (swallowed, a chord event); untaken, it is observed.
    public static readonly string[] KeyNames = { "VolumeUp", "VolumeDown", "VolumeMute" };
    static readonly int[] KeyVk = { 0xAF, 0xAE, 0xAD };
    // vk -> which chords use it (bitmask) / which observed key it is (-1 none). Built once, so the
    // hook proc answers "is this key anyone's?" with one array read and no allocation.
    static readonly int[] _vkChords = BuildVkChords();
    static readonly int[] _vkKey = BuildVkKey();

    static int[] BuildVkChords() {
      var t = new int[256];
      for (int c = 0; c < ChordVk.Length; c++) t[ChordVk[c]] |= 1 << c;
      return t;
    }
    static int[] BuildVkKey() {
      var t = new int[256];
      for (int i = 0; i < t.Length; i++) t[i] = -1;
      for (int k = 0; k < KeyVk.Length; k++) t[KeyVk[k]] = k;
      return t;
    }

    /// A chord or key name -> its bit number, or -1. For the protocol parser, not the hook.
    public static int ChordBit(string name) { return Array.IndexOf(ChordNames, name); }
    public static int KeyBit(string name) { return Array.IndexOf(KeyNames, name); }

    /// A bitmask -> its names, in table order (Status, simulate).
    public static List<object> NamesOf(int mask, string[] names) {
      var o = new List<object>();
      for (int i = 0; i < names.Length; i++) if ((mask & (1 << i)) != 0) o.Add(names[i]);
      return o;
    }

    public const int VK_TAB = 0x09, VK_ESCAPE = 0x1B, VK_LEFT = 0x25, VK_UP = 0x26,
                     VK_RIGHT = 0x27, VK_DOWN = 0x28, VK_MENU = 0x12, VK_LMENU = 0xA4,
                     VK_RMENU = 0xA5, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_A = 0x41, VK_N = 0x4E,
                     VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3;

    // Which features are on. Written by the ui lane (Hotkey.Configure), read by
    // the hook thread: plain bools that only ever flip whole.
    public volatile bool WinTap, AltTab, WinKeys;
    // The feature chords taken and the keys watched, as bitmasks over ChordNames / KeyNames.
    // Written whole by the ui lane (Hotkey.Configure), read by the hook thread.
    public volatile int Chords, Observe;

    // The answer to the last Step, besides its return value.
    public int Event, Arg;

    /// A switcher session is open: between the Tab that opened it and the
    /// Alt-up / Esc / click / watchdog that ended it.
    public bool Active;

    bool _winDown, _otherPressed, _swallowedInWin;   // the solo-Win gesture, as before
    bool _altHeld, _swallowedInAlt;
    bool _swallowedInCtrl;   // a Ctrl chord (Win+Ctrl+T) ate its key: the Ctrl-up gets the partner key
    bool _tabDown, _tabSwallowed, _escSwallowed;
    int _arrowMask, _letterMask;
    // Per vk, for the chord keys only: this press was TAKEN as a chord (its repeats and keyup are
    // swallowed with it) / this press WENT THROUGH to Windows (its repeats never turn into a
    // chord: a Tab held down and THEN Win is not Win+Tab, or the app would see a Tab-down whose
    // keyup we ate). Allocated once; Reset clears them in place.
    readonly bool[] _chordDown = new bool[256];
    readonly bool[] _notChord = new bool[256];
    readonly int[] _chordOf = new int[256];

    public bool AltHeld { get { return _altHeld; } }
    public bool SwallowedInAlt { get { return _swallowedInAlt; } }
    public bool SwallowedInWin { get { return _swallowedInWin; } }

    public static bool IsAlt(int vk) { return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU; }
    public static bool IsWin(int vk) { return vk == VK_LWIN || vk == VK_RWIN; }
    public static bool IsCtrl(int vk) { return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL; }
    public bool SwallowedInCtrl { get { return _swallowedInCtrl; } }

    /// The keydowns Step needs Shift/Ctrl/Win for. Everything else is decided
    /// from the event alone, so an ordinary keystroke costs no system call.
    public static bool NeedsModifiers(int vk) { return vk == VK_TAB || vk == VK_N || vk == VK_A; }

    /// NeedsModifiers plus the keys of the feature chords that are ON (or one already taken, so
    /// its repeats are judged against the modifiers really held). With no chords on, a key costs
    /// exactly what it did before chords existed.
    public bool NeedsMods(int vk) {
      if (NeedsModifiers(vk)) return true;
      if ((uint)vk >= 256) return false;
      return (Chords & _vkChords[vk]) != 0 || _chordDown[vk];
    }

    public void Reset() {
      Active = false; Event = EvNone; Arg = 0;
      _winDown = _otherPressed = _swallowedInWin = false;
      _altHeld = _swallowedInAlt = false;
      _swallowedInCtrl = false;
      _tabDown = _tabSwallowed = _escSwallowed = false;
      _arrowMask = _letterMask = 0;
      Array.Clear(_chordDown, 0, _chordDown.Length);
      Array.Clear(_notChord, 0, _notChord.Length);
    }

    /// One key event. altFlag is the event's LLKHF_ALTDOWN; shift/ctrl/winHeld
    /// are only meaningful for NeedsModifiers keys; otherAltDown only for an Alt
    /// keyup (is the OTHER Alt key still down, so the system still sees Alt).
    public int Step(int vk, bool down, bool altFlag, bool shift, bool ctrl, bool winHeld, bool otherAltDown) {
      Event = EvNone;
      Arg = 0;

      if (IsWin(vk)) {
        if (down) {
          // Key repeat re-fires this; only the FIRST press arms the gesture.
          if (!_winDown) { _winDown = true; _otherPressed = false; _swallowedInWin = false; }
          return Pass;
        }
        bool solo = _winDown && !_otherPressed;
        // Start opens on a Win-up Windows saw as solo: our own solo tap (the
        // launcher), and a Win+N / Win+A whose letter we ate.
        bool dummy = (solo && WinTap) || _swallowedInWin;
        if (solo && WinTap) Event = EvWinTap;
        _winDown = false; _otherPressed = false; _swallowedInWin = false;
        return dummy ? DummyFirst : Pass;
      }

      if (down && _winDown) _otherPressed = true;    // it was a chord, not a tap

      if (IsAlt(vk)) {
        if (down) {
          if (!_altHeld) { _altHeld = true; _swallowedInAlt = false; }
          return Pass;
        }
        // AN ALT KEYUP IS NEVER SWALLOWED - rule 1 in the header.
        if (otherAltDown) return Pass;               // the other Alt still holds it down
        bool dummyA = _swallowedInAlt;
        _altHeld = false; _swallowedInAlt = false;
        if (Active) { Active = false; Event = EvCommit; }
        return dummyA ? DummyFirst : Pass;
      }

      // A CTRL KEYUP IS NEVER SWALLOWED either (rule 1). After a Ctrl chord ate its key it gets the
      // partner key first, exactly like Alt's (rule 3): nothing then reads it as a lone Ctrl tap.
      if (!down && IsCtrl(vk)) {
        bool dummyC = _swallowedInCtrl;
        _swallowedInCtrl = false;
        return dummyC ? DummyFirst : Pass;
      }

      if (!down) return KeyUp(vk);

      // Rule 2: a keydown that says Alt is NOT down while we think it is means
      // we never saw its keyup. Believe the event.
      if (!altFlag) Stale();

      if ((uint)vk < 256) {
        if (_vkChords[vk] != 0) {
          int cr = ChordDown(vk, altFlag, shift, ctrl, winHeld);
          if (cr >= 0) return cr;
        }
        int key = _vkKey[vk];
        if (key >= 0 && (Observe & (1 << key)) != 0) { Event = EvKey; Arg = key; return Pass; }
      }

      switch (vk) {
        case VK_TAB: return TabDown(altFlag, shift, ctrl, winHeld);
        case VK_ESCAPE: return EscDown(altFlag);
        case VK_LEFT: case VK_UP: case VK_RIGHT: case VK_DOWN: return ArrowDown(vk, altFlag);
        case VK_N: case VK_A: return LetterDown(vk, altFlag, shift, ctrl, winHeld);
      }
      return Pass;
    }

    int TabDown(bool altFlag, bool shift, bool ctrl, bool winHeld) {
      bool repeat = _tabDown;
      _tabDown = true;
      if (repeat) {
        // Auto-repeat keeps the fate of the press it belongs to: a Tab that
        // began as a plain Tab (before Alt, or with Ctrl/Win) stays plain to
        // its keyup; a swallowed one stays swallowed, and keeps cycling while
        // the session is open. It never REOPENS a session Esc just closed.
        if (!_tabSwallowed) return Pass;
        if (Active && altFlag) Event = shift ? EvPrev : EvNext;
        return Swallow;
      }
      // Ctrl+Alt+Tab (Windows' sticky switcher) and Win+Alt+Tab stay Windows'.
      if (!altFlag || !AltTab || ctrl || winHeld) { _tabSwallowed = false; return Pass; }
      _tabSwallowed = true;
      _altHeld = true;             // the event says Alt is down, even if we missed its keydown
      _swallowedInAlt = true;
      if (Active) Event = shift ? EvPrev : EvNext;
      else { Active = true; Event = EvOpen; Arg = shift ? 1 : 0; }
      return Swallow;
    }

    int EscDown(bool altFlag) {
      if (_escSwallowed) return Swallow;             // auto-repeat of the Esc that cancelled
      if (Active && altFlag) {
        _escSwallowed = true; _swallowedInAlt = true;
        Active = false; Event = EvCancel;
        return Swallow;
      }
      return Pass;
    }

    int ArrowDown(int vk, bool altFlag) {
      int bit = 1 << (vk - VK_LEFT);
      if ((_arrowMask & bit) != 0) {                 // auto-repeat of a swallowed arrow
        if (Active && altFlag) Event = ArrowEvent(vk);
        return Swallow;
      }
      if (Active && altFlag) {
        _arrowMask |= bit; _swallowedInAlt = true;
        Event = ArrowEvent(vk);
        return Swallow;
      }
      return Pass;
    }

    static int ArrowEvent(int vk) {
      return vk == VK_LEFT ? EvLeft : vk == VK_RIGHT ? EvRight : vk == VK_UP ? EvUp : EvDown;
    }

    int LetterDown(int vk, bool altFlag, bool shift, bool ctrl, bool winHeld) {
      int bit = vk == VK_N ? 1 : 2;
      if ((_letterMask & bit) != 0) return Swallow;  // auto-repeat of a swallowed Win+N
      // Exactly Win+N / Win+A: Win+Shift+A, Win+Ctrl+N and friends stay Windows'.
      if (!WinKeys || !winHeld || shift || ctrl || altFlag) return Pass;
      _letterMask |= bit;
      _swallowedInWin = true;                        // so the Win-up gets its partner key
      Event = EvWinKey; Arg = vk;
      return Swallow;
    }

    static bool ChordMatches(int c, bool altFlag, bool shift, bool ctrl, bool winHeld) {
      return altFlag == ChordAlt[c] && ctrl == ChordCtrl[c] && winHeld == ChordWin[c] && shift == ChordShift[c];
    }

    /// A keydown of a key some chord uses: Swallow, or -1 = not a chord, carry on as before (Tab,
    /// the arrows and the letters still get the switcher's and Win+N's rules after this).
    int ChordDown(int vk, bool altFlag, bool shift, bool ctrl, bool winHeld) {
      if (_chordDown[vk]) {
        // Auto-repeat of a chord we took: swallowed, and no second event (a held Win+Left is one
        // snap, not twenty). Only while its modifiers still match: if they do not, its keyup
        // went where the hook could not see it (an elevated window), and this is a fresh press.
        // A held Volume Up/Down is the exception: every repeat is one more step, as in Windows.
        int held = _chordOf[vk];
        if (ChordMatches(held, altFlag, shift, ctrl, winHeld)) {
          if (ChordRepeats[held]) { Event = EvChord; Arg = held; }
          return Swallow;
        }
        _chordDown[vk] = false;
      } else if (_notChord[vk]) {
        return -1;                                   // a press that went through stays Windows'
      }
      int chords = Chords & _vkChords[vk];
      for (int c = 0; chords != 0 && c < ChordVk.Length; c++) {
        if ((chords & (1 << c)) == 0 || !ChordMatches(c, altFlag, shift, ctrl, winHeld)) continue;
        _chordDown[vk] = true;
        _chordOf[vk] = c;
        // Windows saw Win go down and (because we ate the key) nothing else: without a partner
        // key before the Win-up, Start would open. Exactly as for Win+N.
        if (ChordWin[c]) _swallowedInWin = true;
        // Likewise Alt: an Alt-up with nothing seen since its keydown opens the app's menu bar.
        if (ChordAlt[c]) { _altHeld = true; _swallowedInAlt = true; }
        // And Ctrl (Win+Ctrl+T): its keyup gets the partner key too.
        if (ChordCtrl[c]) _swallowedInCtrl = true;
        Event = EvChord; Arg = c;
        return Swallow;
      }
      _notChord[vk] = true;
      return -1;
    }

    int KeyUp(int vk) {
      if ((uint)vk < 256) {
        _notChord[vk] = false;
        // A chord's keyup goes with its keydown, whatever is held now.
        if (_chordDown[vk]) { _chordDown[vk] = false; return Swallow; }
      }
      switch (vk) {
        case VK_TAB: {
          bool sw = _tabSwallowed;
          _tabDown = false; _tabSwallowed = false;
          return sw ? Swallow : Pass;
        }
        case VK_ESCAPE: {
          bool sw = _escSwallowed;
          _escSwallowed = false;
          return sw ? Swallow : Pass;
        }
        case VK_LEFT: case VK_UP: case VK_RIGHT: case VK_DOWN: {
          int bit = 1 << (vk - VK_LEFT);
          bool sw = (_arrowMask & bit) != 0;
          _arrowMask &= ~bit;
          return sw ? Swallow : Pass;
        }
        case VK_N: case VK_A: {
          int bit = vk == VK_N ? 1 : 2;
          bool sw = (_letterMask & bit) != 0;
          _letterMask &= ~bit;
          return sw ? Swallow : Pass;
        }
      }
      return Pass;                                   // Shift, Ctrl and everything else
    }

    void Stale() {
      if (!_altHeld) return;
      _altHeld = false; _swallowedInAlt = false;
      if (Active) { Active = false; Event = EvStale; }
    }

    /// A click on a tile, a cancel from the overlay, or Alt+Tab being turned
    /// off: the session ends while Alt may still be held. The hold's
    /// bookkeeping is KEPT, so the Alt-up that follows still gets its 0xFF.
    public bool EndSession() {
      bool was = Active;
      Active = false;
      return was;
    }

    /// The watchdog saw Alt up and the hook never did: the keyup went where we
    /// cannot see it (an elevated window, a secure desktop, a delayed hook).
    public void AltGoneUnseen() {
      _altHeld = false; _swallowedInAlt = false;
      Active = false;
    }
  }

  /// The pure arithmetic of a session: where the selection starts and moves.
  static class SwitchMath {
    /// Windows' own rule: the CURRENT window is the first tile and the
    /// selection starts on the SECOND, so a quick tap goes back to the previous
    /// window. When the foreground is not a listed window (the desktop, Mantle's
    /// own launcher) the first tile IS the previous window, so it starts there.
    /// Shift+Tab starts at the far end, as in Windows.
    public static int Initial(int n, bool fgFirst, bool backwards) {
      if (n <= 0) return -1;
      if (backwards) return n - 1;
      if (fgFirst) return n >= 2 ? 1 : 0;
      return 0;
    }

    /// Tab / Shift+Tab / Left / Right wrap. Up / Down move a whole row of the
    /// grid main laid out (`cols`, sent back per session); before main has said,
    /// or in a single row, they stay put. Down from a short last row's column
    /// lands on the last tile, the way a grid of text does.
    public static int Move(int sel, int n, int cols, int ev) {
      if (n <= 0) return -1;
      if (sel < 0 || sel >= n) sel = 0;
      switch (ev) {
        case KeyMachine.EvNext: case KeyMachine.EvRight: return (sel + 1) % n;
        case KeyMachine.EvPrev: case KeyMachine.EvLeft: return (sel - 1 + n) % n;
        case KeyMachine.EvDown: {
          if (cols <= 0 || cols >= n) return sel;
          int t = sel + cols;
          if (t < n) return t;
          int lastRowStart = ((n - 1) / cols) * cols;
          return sel < lastRowStart ? n - 1 : sel;
        }
        case KeyMachine.EvUp: {
          if (cols <= 0 || cols >= n) return sel;
          int t = sel - cols;
          return t >= 0 ? t : sel;
        }
      }
      return sel;
    }
  }

  /// P/Invoke the alttab lane needs that Win32.cs does not have. Kept here, not
  /// in the shared Win32.cs, so two lanes never edit one declaration file.
  static class KeysNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
      public IntPtr hwnd;
      public uint message;
      public IntPtr wParam, lParam;
      public uint time;
      public int ptX, ptY;
    }

    public const uint PM_NOREMOVE = 0;
    public const uint WM_TIMER = 0x0113;
    public const uint LLKHF_ALTDOWN = 0x20;
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const long WS_EX_TOPMOST = 0x8;

    [DllImport("user32.dll")] public static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostThreadMessageW(int threadId, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr proc);
    [DllImport("user32.dll")] public static extern bool KillTimer(IntPtr hwnd, UIntPtr id);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);

    public static bool KeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  }

  /// The session: the window list, the selection, and the switch itself. Every
  /// method here runs on the hook's thread (Hotkey.cs), except Activate, which
  /// runs on a thread of its own so a hung target can never stall the hook.
  static class Switcher {
    // Shell furniture that is never "an app window". A COPY of WindowList's
    // SkipClasses (Windows.cs), which is private to that file: the switcher has
    // to build its list itself, with no icon lookups, in a millisecond, on the
    // hook's thread. test-switcher (lib/switcher.test.js) compares this list
    // with `windows` on the live desktop, so the two cannot drift silently.
    static readonly HashSet<string> SkipClasses = new HashSet<string>(StringComparer.Ordinal) {
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
      "Windows.UI.Core.CoreWindow", "MSCTFIME UI", "Default IME", "Button",
      "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland"
    };
    // Another Mantle's windows (a test instance next to the live one): the same
    // titles main.js's isMantleWindow() drops, on Chromium's window class.
    static readonly HashSet<string> MantleTitles = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "Mantle bar", "Mantle desktop", "Mantle launcher", "Mantle wallpapers", "Mantle switcher",
      // wave 3 (2026-09-24): every feature page is Mantle's own too, never a window to switch to
      "Mantle task view", "Mantle volume", "Mantle clipboard", "Mantle snap", "Mantle screenshot", "Mantle top bar"
    };
    // Mantle's APP windows (lane settings, 2026-09-28): a window Owen works in like any app's (Mantle
    // Settings), so Alt+Tab and the bar's window list (WindowList.Build) show it although it is
    // Mantle's own process, which every other Mantle window is skipped for. Exact title (the page's
    // <title>), Chromium's window class, and still never a tool window or an owned one.
    static readonly HashSet<string> MantleAppTitles = new HashSet<string>(StringComparer.Ordinal) { "Mantle Settings", "Mantle Task Manager", "Mantle Files" };
    public static bool IsMantleApp(string cls, string title) { return cls == "Chrome_WidgetWin_1" && title != null && MantleAppTitles.Contains(title); }

    public sealed class Item {
      public IntPtr Hwnd;
      public string Title;
      public int Pid, Z;
      public bool Minimized, Topmost, Hung;
      public long Stamp;             // activation order (bigger = more recent), 0 = never seen active
    }

    // ------------------------------------------------------------ MRU order
    //
    // WHERE THE ORDER COMES FROM (decided 2026-09-23; the measurement is in the
    // lane report): Windows' Alt+Tab is "most recently ACTIVATED first". The
    // EnumWindows z-order is the same thing most of the time, because
    // activating a window raises it - but not for an always-on-top window,
    // which z-order puts first however long ago it was used, so a quick Alt+Tab
    // would jump to a pinned PiP instead of the window you just left. So we
    // record every activation (EVENT_SYSTEM_FOREGROUND, an out-of-context
    // WinEvent: no input, nothing moved) and sort by that; windows never seen
    // active since the hook started come after, in z-order, always-on-top last.
    static Win32.WinEventProc _fgProc;       // static: the GC must never collect a live hook proc
    static IntPtr _fgHook;
    static readonly Dictionary<long, long> _stamps = new Dictionary<long, long>();
    static long _clock;

    public static bool Tracking { get { return _fgHook != IntPtr.Zero; } }

    /// On the hook thread (its message loop delivers the callbacks).
    public static void StartTracking() {
      if (_fgHook != IntPtr.Zero) return;
      _fgProc = OnForeground;
      _fgHook = Win32.SetWinEventHook(KeysNative.EVENT_SYSTEM_FOREGROUND, KeysNative.EVENT_SYSTEM_FOREGROUND,
                                      IntPtr.Zero, _fgProc, 0, 0,
                                      Win32.WINEVENT_OUTOFCONTEXT | Win32.WINEVENT_SKIPOWNPROCESS);
      if (_fgHook == IntPtr.Zero)
        KeyEvents.Log("warn", "alt+tab: the foreground-change hook could not be installed, so the switcher " +
                              "orders windows by z-order alone (an always-on-top window will sort first)");
      Stamp(Win32.GetForegroundWindow());
    }

    public static void StopTracking() {
      try { if (_fgHook != IntPtr.Zero) Win32.UnhookWinEvent(_fgHook); } catch (Exception) { }
      _fgHook = IntPtr.Zero;
      _fgProc = null;
      _stamps.Clear();
    }

    static void OnForeground(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      Stamp(hwnd);
    }

    static void Stamp(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return;
      IntPtr root = Win32.GetAncestor(hwnd, Win32.GA_ROOTOWNER);
      if (root == IntPtr.Zero) root = hwnd;
      _stamps[root.ToInt64()] = ++_clock;
      if (_stamps.Count > 400) Prune();
    }

    static void Prune() {
      var dead = new List<long>();
      foreach (var kv in _stamps) if (!Win32.IsWindow(new IntPtr(kv.Key))) dead.Add(kv.Key);
      foreach (long k in dead) _stamps.Remove(k);
    }

    /// The same filter as WindowList.Build (Windows.cs), minus everything slow.
    public static List<Item> Snapshot(out IntPtr fgRoot) {
      var found = new List<Item>();
      int ownPid = Program.OwnPid, parentPid = Program.ParentPid;
      int z = 0;
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        try {
          if (!Win32.IsWindowVisible(hwnd)) return true;
          if (Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;
          long ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
          if ((ex & Win32.WS_EX_TOOLWINDOW) != 0) return true;
          string title = Win32.GetWindowText(hwnd);
          if (title.Length == 0) return true;
          string cls = Win32.GetClassName(hwnd);
          if (SkipClasses.Contains(cls)) return true;
          if (Win32.IsCloaked(hwnd)) return true;
          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          if (pid == ownPid) return true;
          if (parentPid > 0 && pid == parentPid && !IsMantleApp(cls, title)) return true;
          if (cls == "Chrome_WidgetWin_1" && MantleTitles.Contains(title.Trim())) return true;
          var it = new Item();
          it.Hwnd = hwnd; it.Title = title; it.Pid = pid; it.Z = z++;
          it.Minimized = Win32.IsIconic(hwnd);
          it.Topmost = (ex & KeysNative.WS_EX_TOPMOST) != 0;
          it.Hung = KeysNative.IsHungAppWindow(hwnd);
          long st;
          it.Stamp = _stamps.TryGetValue(hwnd.ToInt64(), out st) ? st : 0;
          found.Add(it);
        } catch (Exception) {
          // One odd window must never cost the whole list.
        }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      IntPtr fg = Win32.GetForegroundWindow();
      fgRoot = fg == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(fg, Win32.GA_ROOTOWNER);
      if (fgRoot == IntPtr.Zero) fgRoot = fg;
      return found;
    }

    /// PURE. Most recently activated first; the current window always first.
    public static void Order(List<Item> items, IntPtr fgRoot) {
      items.Sort(delegate (Item a, Item b) {
        if (a == b) return 0;
        bool af = a.Hwnd == fgRoot, bf = b.Hwnd == fgRoot;
        if (af != bf) return af ? -1 : 1;
        bool at = a.Stamp > 0, bt = b.Stamp > 0;
        if (at != bt) return at ? -1 : 1;
        if (at && a.Stamp != b.Stamp) return a.Stamp > b.Stamp ? -1 : 1;
        if (!at && a.Topmost != b.Topmost) return a.Topmost ? 1 : -1;
        return a.Z.CompareTo(b.Z);
      });
    }

    // -------------------------------------------------------------- session
    // All of this is touched on the hook thread only.
    static int _seq, _sel = -1, _cols;
    static List<Item> _items;
    static IntPtr _fgRoot;
    static UIntPtr _watch = UIntPtr.Zero;
    static long _commitTs;

    public static int Seq { get { return _seq; } }

    // The watchdog: while a session is open, every 40 ms, is Alt still down?
    // It is the answer to "what if we never see the Alt-up" - rule 2's case,
    // and a hook Windows stopped calling. 40 ms is invisible next to a human
    // letting go of a key, and it only ticks while a session is open.
    const uint WatchMs = 40;

    /// Every thread message the hook thread posts to itself, and the ones the
    /// ui lane posts on main's behalf (pick, cancel, grid, config).
    public static void OnThreadMessage(uint msg, IntPtr wp, IntPtr lp) {
      switch (msg) {
        case Hotkey.MSG_KEYEVENT: OnKey(wp.ToInt32(), lp.ToInt32()); break;
        case Hotkey.MSG_PICK: OnPick(wp.ToInt32(), lp.ToInt32()); break;
        case Hotkey.MSG_CANCEL: OnCancelFromMain(wp.ToInt32()); break;
        case Hotkey.MSG_GRID: if (wp.ToInt32() == _seq && lp.ToInt32() > 0) _cols = lp.ToInt32(); break;
        case Hotkey.MSG_CONFIG:
          if (!Hotkey.Machine.AltTab && Hotkey.Machine.EndSession())
            Close("Mantle's Alt+Tab was turned off while it was open");
          break;
        case KeysNative.WM_TIMER: OnWatch(); break;
      }
    }

    static void OnKey(int ev, int arg) {
      switch (ev) {
        case KeyMachine.EvOpen: Open(arg == 1); break;
        case KeyMachine.EvNext: case KeyMachine.EvPrev: case KeyMachine.EvLeft:
        case KeyMachine.EvRight: case KeyMachine.EvUp: case KeyMachine.EvDown:
          if (_items == null) break;
          _sel = SwitchMath.Move(_sel, _items.Count, _cols, ev);
          KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "move", "seq", _seq, "sel", _sel,
                                     "key", KeyMachine.EventNames[ev]));
          break;
        case KeyMachine.EvCommit: Commit("alt-up"); break;
        case KeyMachine.EvCancel: Close("Esc"); break;
        case KeyMachine.EvStale:
          Close("Alt came up where Mantle could not see it (an elevated window takes keys away from " +
                "Mantle's hook), so nothing was switched");
          break;
        case KeyMachine.EvWinKey:
          KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "winkey", "key", arg == KeyMachine.VK_N ? "n" : "a"));
          break;
        // A feature chord (swallowed) or an observed key (not): main routes it to the feature
        // (lib/features.js). The key was already decided in the hook; this is only the telling.
        case KeyMachine.EvChord:
          if (arg >= 0 && arg < KeyMachine.ChordNames.Length)
            KeyEvents.Enqueue(Json.Obj("ev", "chord", "chord", KeyMachine.ChordNames[arg]));
          break;
        case KeyMachine.EvKey:
          if (arg >= 0 && arg < KeyMachine.KeyNames.Length)
            KeyEvents.Enqueue(Json.Obj("ev", "key", "key", KeyMachine.KeyNames[arg]));
          break;
      }
    }

    static void Open(bool backwards) {
      long keyTs = Hotkey.LastOpenTs;
      _seq++;
      IntPtr fgRoot;
      var items = Snapshot(out fgRoot);
      Order(items, fgRoot);
      _items = items;
      _fgRoot = fgRoot;
      _cols = 0;
      bool fgFirst = items.Count > 0 && items[0].Hwnd == fgRoot;
      _sel = SwitchMath.Initial(items.Count, fgFirst, backwards);

      var list = new List<object>(items.Count);
      foreach (Item it in items) list.Add(ItemJson(it));
      var open = Json.Obj("ev", "switcher", "op", "open", "seq", _seq, "sel", _sel,
                          "backwards", backwards, "current", fgFirst ? 0 : -1, "list", list,
                          "tracking", Tracking,
                          // key -> this line, on the hook thread: the sidecar's share of
                          // "first paint within ~100 ms", said on every open.
                          "ms", keyTs == 0 ? 0.0 : Math.Round((Stopwatch.GetTimestamp() - keyTs) * 1000.0 / Stopwatch.Frequency, 2),
                          // The keypress itself on the QueryPerformanceCounter clock, in ms.
                          // Node's process.hrtime() reads the SAME counter (libuv's uv_hrtime
                          // is QPC / frequency), so main can measure key -> on screen end to
                          // end, across the two processes, with no clock guesswork.
                          "keyAt", keyTs == 0 ? 0.0 : Math.Round(keyTs * 1000.0 / Stopwatch.Frequency, 3));
      AddMonitor(open, fgRoot);
      KeyEvents.Enqueue(open);
      ArmWatch();
    }

    public static IDictionary ItemJson(Item it) {
      return Json.Obj("hwnd", it.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                      "title", it.Title, "pid", it.Pid, "minimized", it.Minimized,
                      "topmost", it.Topmost, "hung", it.Hung);
    }

    /// The monitor of the window being switched FROM, in physical px (this
    /// process is per-monitor DPI aware). The overlay is centred on it.
    static void AddMonitor(IDictionary d, IntPtr near) {
      IntPtr mon = near != IntPtr.Zero ? Win32.MonitorFromWindow(near, Win32.MONITOR_DEFAULTTONEAREST) : IntPtr.Zero;
      if (mon == IntPtr.Zero) {
        var pt = new Win32.POINT();
        mon = Win32.MonitorFromPoint(pt, 1 /* MONITOR_DEFAULTTOPRIMARY */);
      }
      var mi = new Win32.MONITORINFO();
      mi.cbSize = (uint)Marshal.SizeOf(typeof(Win32.MONITORINFO));
      if (mon == IntPtr.Zero || !Win32.GetMonitorInfoW(mon, ref mi)) return;
      d["mon"] = new object[] { mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom };
      d["work"] = new object[] { mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom };
    }

    static void Commit(string via) {
      KillWatch();
      if (_items == null) return;
      int seq = _seq, sel = _sel;
      IntPtr target = sel >= 0 && sel < _items.Count ? _items[sel].Hwnd : IntPtr.Zero;
      string title = sel >= 0 && sel < _items.Count ? _items[sel].Title : null;
      IntPtr from = _fgRoot;
      _items = null;
      _commitTs = Stopwatch.GetTimestamp();
      KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "commit", "seq", seq, "sel", sel,
                                 "hwnd", target.ToInt64().ToString(CultureInfo.InvariantCulture), "via", via));
      if (target == IntPtr.Zero) {
        Activated(seq, target, title, via, false, null, "there was no window to switch to", "none", 0);
        return;
      }
      if (target == from && RootOf(Win32.GetForegroundWindow()) == target) {
        Activated(seq, target, title, via, true, "already", null, null, 0);
        return;
      }
      long ts = _commitTs;
      var t = new Thread(delegate () { Activate(seq, target, title, via, ts); });
      t.IsBackground = true;
      t.Name = "mantle-switch";
      t.Start();
    }

    static void Close(string why) {
      KillWatch();
      if (_items == null) return;
      _items = null;
      KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "cancel", "seq", _seq, "why", why));
    }

    static void OnPick(int seq, int index) {
      if (!Hotkey.Machine.Active || seq != _seq || _items == null) {
        KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "refused", "seq", seq,
                                   "reason", "that Alt+Tab had already ended when the click arrived"));
        return;
      }
      if (index < 0 || index >= _items.Count) {
        KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "refused", "seq", seq,
                                   "reason", "tile " + index + " is not in this Alt+Tab (it has " + _items.Count + ")"));
        return;
      }
      Hotkey.Machine.EndSession();       // Alt may still be held: its keyup still gets the 0xFF
      _sel = index;
      KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "move", "seq", _seq, "sel", _sel, "key", "click"));
      Commit("click");
    }

    static void OnCancelFromMain(int seq) {
      if (seq != _seq || !Hotkey.Machine.EndSession()) return;
      Close("closed from the switcher window");
    }

    static void ArmWatch() {
      KillWatch();
      _watch = KeysNative.SetTimer(IntPtr.Zero, UIntPtr.Zero, WatchMs, IntPtr.Zero);
    }

    static void KillWatch() {
      if (_watch != UIntPtr.Zero) KeysNative.KillTimer(IntPtr.Zero, _watch);
      _watch = UIntPtr.Zero;
    }

    static void OnWatch() {
      var m = Hotkey.Machine;
      if (!m.Active) { KillWatch(); return; }
      if (KeysNative.KeyDown(KeyMachine.VK_MENU)) return;       // Alt still held: the normal case
      // Alt is up and the hook never said so.
      m.AltGoneUnseen();
      IntPtr fg = RootOf(Win32.GetForegroundWindow());
      if (fg == _fgRoot) {
        // Same window in front, so nothing else took the keys: the hook itself
        // missed the keyup (Windows skips a hook that answers too slowly, and
        // on Windows 7+ may drop it without telling us). Finish the switch the
        // person asked for, then put the hook back so the next one is seen.
        Commit("watchdog");
        Hotkey.Rehook("Alt came up without the keyboard hook seeing it");
      } else {
        Close("the window in front changed while Alt was held and Mantle never saw Alt come up (an " +
              "elevated window takes keys away from Mantle's hook), so nothing was switched");
      }
    }

    static IntPtr RootOf(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return IntPtr.Zero;
      IntPtr r = Win32.GetAncestor(hwnd, Win32.GA_ROOTOWNER);
      return r == IntPtr.Zero ? hwnd : r;
    }

    // ------------------------------------------------------------ activation
    //
    // On its own thread: ShowWindow on a hung window blocks, and nothing that
    // can block may run on the hook's thread.
    //
    // FOREGROUND RIGHTS: SetForegroundWindow from a background process is
    // refused unless that process has foreground permission, and "the system
    // automatically enables calls to SetForegroundWindow if the user presses
    // the ALT key" (LockSetForegroundWindow, documented) - which the person has
    // just done. So a plain SetForegroundWindow goes first and is expected to
    // land ("direct"). If it does not, the bar's own ladder takes over
    // (WindowList.Focus: restore, AttachThreadInput, then the Alt nudge), the
    // exact code a taskbar click uses. `how` says which one landed, so the
    // first live run measures it instead of us guessing.
    //
    // `cause` is for the notice's plain sentence, `err` for the log and the notice's small print:
    // "closed" (gone before the switch), "hung" (Windows reports it not responding and would not
    // bring it forward), "refused" (Windows kept another window in front), "error" (this threw).
    static void Activate(int seq, IntPtr hwnd, string title, string via, long commitTs) {
      string how = null, err = null, cause = null;
      try {
        if (!Win32.IsWindow(hwnd)) {
          err = "the window closed before Mantle could switch to it";
          cause = "closed";
        } else {
          bool hung = KeysNative.IsHungAppWindow(hwnd);
          // A window with a modal dialog up is really the dialog: Windows'
          // own switcher activates the owner's last active popup too.
          IntPtr popup = KeysNative.GetLastActivePopup(hwnd);
          IntPtr focusTo = popup != IntPtr.Zero && popup != hwnd && Win32.IsWindowVisible(popup) &&
                           KeysNative.IsWindowEnabled(popup) ? popup : hwnd;
          bool iconic = Win32.IsIconic(hwnd);
          Win32.SetForegroundWindow(focusTo);
          if (RootOf(Win32.GetForegroundWindow()) == hwnd) {
            how = "direct";
            // Async: a hung app must not hold this thread either.
            if (iconic) Win32.ShowWindowAsync(hwnd, Win32.SW_RESTORE);
          } else {
            string ferr = WindowList.Focus(hwnd);
            if (ferr == null && focusTo != hwnd) Win32.SetForegroundWindow(focusTo);
            if (ferr == null || RootOf(Win32.GetForegroundWindow()) == hwnd) how = "ladder";
            else {
              err = "SetForegroundWindow was refused, then the focus ladder: " + ferr +
                    (hung ? "; Windows also reports that window as not responding" : "");
              cause = !Win32.IsWindow(hwnd) ? "closed" : hung ? "hung" : "refused";
            }
          }
        }
      } catch (Exception ex) {
        err = "switching threw " + ex.GetType().Name + ": " + ex.Message;
        cause = "error";
      }
      Activated(seq, hwnd, title, via, err == null, how, err, cause, Lanes.MsSince(commitTs));
    }

    static void Activated(int seq, IntPtr hwnd, string title, string via, bool ok, string how, string err,
                          string cause, long ms) {
      var d = Json.Obj("ev", "switcher", "op", "activated", "seq", seq,
                       "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                       "title", title, "via", via, "ok", ok, "how", how, "ms", ms);
      if (!ok) { d["reason"] = err; d["cause"] = cause ?? "error"; }
      KeyEvents.Enqueue(d);
    }

    // ------------------------------------------------------------ test forms

    /// `hotkey {op:'list'}`: the list an Alt+Tab would show right now, in order.
    /// Read-only (EnumWindows and friends), so it runs in passive too.
    public static IDictionary ListNow() {
      IntPtr fgRoot;
      var items = Snapshot(out fgRoot);
      Order(items, fgRoot);
      var list = new List<object>(items.Count);
      foreach (Item it in items) list.Add(ItemJson(it));
      bool fgFirst = items.Count > 0 && items[0].Hwnd == fgRoot;
      var d = Json.Obj("list", list, "current", fgFirst ? 0 : -1,
                       "sel", SwitchMath.Initial(items.Count, fgFirst, false),
                       "tracking", Tracking,
                       "fg", fgRoot.ToInt64().ToString(CultureInfo.InvariantCulture));
      AddMonitor(d, fgRoot);
      return d;
    }

    /// `hotkey {op:'order', fg, windows:[{hwnd, z, stamp, topmost}]}`: Order()
    /// on made-up windows. Pure.
    public static string OrderFake(Dictionary<string, object> req, out object result) {
      result = null;
      object raw;
      if (!Json.TryGet(req, "windows", out raw) || !(raw is IList)) return "order needs windows: [{hwnd, z, stamp, topmost}]";
      var items = new List<Item>();
      foreach (object o in (IList)raw) {
        var w = o as Dictionary<string, object>;
        if (w == null) return "order: every window must be an object";
        var it = new Item();
        it.Hwnd = Json.GetHwnd(w, "hwnd");
        it.Z = Json.GetInt(w, "z", items.Count);
        it.Stamp = Json.GetInt(w, "stamp", 0);
        it.Topmost = Json.GetBool(w, "topmost", false);
        it.Title = "";
        items.Add(it);
      }
      IntPtr fg = Json.GetHwnd(req, "fg");
      Order(items, fg);
      var hw = new List<object>();
      foreach (Item it in items) hw.Add(it.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture));
      bool fgFirst = items.Count > 0 && items[0].Hwnd == fg;
      result = Json.Obj("order", hw,
                        "sel", SwitchMath.Initial(items.Count, fgFirst, false),
                        "selBackwards", SwitchMath.Initial(items.Count, fgFirst, true));
      return null;
    }

    /// `hotkey {op:'simulate', events:[...]}`: KeyMachine and SwitchMath driven
    /// by a script instead of a keyboard. Exactly the calls the hook makes,
    /// including ignoring injected keys BEFORE the machine sees them. Pure.
    ///   event: {vk, down:true|false, alt, shift, ctrl, win, otherAlt, injected}
    ///       or {do:'watchdog'} (Alt found up by the watchdog)
    ///       or {do:'pick', index} (a click on a tile)
    ///   n / cols / fgFirst: the pretend session's tile count, grid and whether
    ///       the current window is tile 0 (default 5, 0, true).
    ///   winTap / altTab / winKeys (default false, true, false), chords / observe
    ///       (lists of names, default none): which features the pretend machine has on.
    ///   A step reports {swallow, dummy, event, sel, active} plus chord / key names.
    public static string Simulate(Dictionary<string, object> req, out object result) {
      result = null;
      object raw;
      if (!Json.TryGet(req, "events", out raw) || !(raw is IList))
        return "simulate needs events: [{vk, down, alt, shift, ctrl, win, otherAlt, injected}]";
      var m = new KeyMachine();
      m.WinTap = Json.GetBool(req, "winTap", false);
      m.AltTab = Json.GetBool(req, "altTab", true);
      m.WinKeys = Json.GetBool(req, "winKeys", false);
      int chordMask, keyMask;
      string cerr = Hotkey.ParseNames(req, "chords", KeyMachine.ChordNames, out chordMask);
      if (cerr != null) return cerr;
      cerr = Hotkey.ParseNames(req, "observe", KeyMachine.KeyNames, out keyMask);
      if (cerr != null) return cerr;
      m.Chords = chordMask < 0 ? 0 : chordMask;
      m.Observe = keyMask < 0 ? 0 : keyMask;
      int n = Json.GetInt(req, "n", 5), cols = Json.GetInt(req, "cols", 0);
      bool fgFirst = Json.GetBool(req, "fgFirst", true);
      int sel = -1, committed = -2;
      var steps = new List<object>();
      int i = 0;
      foreach (object o in (IList)raw) {
        var e = o as Dictionary<string, object>;
        if (e == null) return "simulate: event " + i + " is not an object";
        string what = Json.GetString(e, "do");
        int r = KeyMachine.Pass;
        bool ignored = false;
        int ev = KeyMachine.EvNone, arg = 0;
        if (what == "watchdog") {
          if (m.Active) { m.AltGoneUnseen(); ev = KeyMachine.EvCommit; }
          else m.AltGoneUnseen();
        } else if (what == "pick") {
          int idx = Json.GetInt(e, "index", -1);
          if (m.Active && idx >= 0 && idx < n) { m.EndSession(); sel = idx; ev = KeyMachine.EvCommit; }
        } else if (what != null) {
          return "simulate: unknown do '" + what + "' at event " + i;
        } else {
          if (!Json.HasKey(e, "vk")) return "simulate: event " + i + " has no vk";
          int vk = Json.GetInt(e, "vk", 0);
          bool down = Json.GetBool(e, "down", true);
          if (Json.GetBool(e, "injected", false)) {
            ignored = true;           // Hotkey.HookProc returns before the machine for these
          } else {
            r = m.Step(vk, down, Json.GetBool(e, "alt", false), Json.GetBool(e, "shift", false),
                       Json.GetBool(e, "ctrl", false), Json.GetBool(e, "win", false),
                       Json.GetBool(e, "otherAlt", false));
            ev = m.Event; arg = m.Arg;
          }
        }
        if (ev == KeyMachine.EvOpen) sel = SwitchMath.Initial(n, fgFirst, arg == 1);
        else if (ev >= KeyMachine.EvNext && ev <= KeyMachine.EvDown) sel = SwitchMath.Move(sel, n, cols, ev);
        else if (ev == KeyMachine.EvCommit) committed = sel;
        var step = Json.Obj("i", i, "swallow", (r & KeyMachine.Swallow) != 0, "dummy", (r & KeyMachine.DummyFirst) != 0,
                            "event", KeyMachine.EventNames[ev], "sel", sel, "active", m.Active);
        if (ev == KeyMachine.EvWinKey) step["key"] = arg == KeyMachine.VK_N ? "n" : "a";
        if (ev == KeyMachine.EvChord) step["chord"] = KeyMachine.ChordNames[arg];
        if (ev == KeyMachine.EvKey) step["key"] = KeyMachine.KeyNames[arg];
        if (ignored) step["ignored"] = true;
        steps.Add(step);
        i++;
      }
      result = Json.Obj("steps", steps, "active", m.Active, "altHeld", m.AltHeld,
                        "committed", committed == -2 ? (object)null : committed);
      return null;
    }
  }

  /// Events from the hook thread (and the activation threads) to stdout, in
  /// order, on a thread of their own. The hook thread may NEVER write to
  /// stdout itself: if Electron stops reading, the pipe fills, the write
  /// blocks, and a blocked hook thread is every keystroke on the desktop
  /// waiting on Mantle - until Windows times the hook out and drops it.
  static class KeyEvents {
    static readonly Queue<object> _q = new Queue<object>();
    static Thread _t;
    const int Max = 256;             // a human cannot press keys faster than this drains

    public static void Enqueue(object payload) {
      lock (_q) {
        if (_q.Count >= Max) _q.Dequeue();     // drop the oldest rather than grow without bound
        _q.Enqueue(payload);
        Monitor.Pulse(_q);
        if (_t == null) {
          _t = new Thread(Run);
          _t.IsBackground = true;
          _t.Name = "mantle-keys-out";
          _t.Start();
        }
      }
    }

    /// Program.EmitLog's line, but through the queue: safe on the hook thread.
    public static void Log(string level, string message) {
      Enqueue(Json.Obj("ev", "log", "level", level, "message", message));
    }

    static void Run() {
      while (true) {
        object p;
        lock (_q) {
          while (_q.Count == 0) Monitor.Wait(_q);
          p = _q.Dequeue();
        }
        try { Program.Emit(p); } catch (Exception) { }
      }
    }
  }
}
