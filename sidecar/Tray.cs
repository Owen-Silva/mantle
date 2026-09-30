// Tray.cs - reading explorer's notification area (the "system tray").
//
// STATUS: best effort, and the protocol says so. Windows 11's tray is a XAML
// surface; the legacy ToolbarWindow32 controls this code reads may be absent or
// empty depending on the build. When that happens the command answers
//   "tray unavailable: <exact reason>"
// which is a real answer, not a silent empty list - the Electron side can show
// the reason instead of a tray that looks broken.
//
// HOW IT WORKS when it works: the tray icons live in a common toolbar control
// inside explorer.exe. TB_GETBUTTON wants a buffer IN THE TOOLBAR'S OWN
// PROCESS, so we allocate one inside explorer with VirtualAllocEx, ask the
// toolbar to fill it, and read it back with ReadProcessMemory. Each button's
// dwData points at a TRAYDATA holding the owner window, the icon id, the
// callback message and the HICON.
//
// 64-BIT ONLY: the struct layouts below are the x64 ones (TBBUTTON is 32 bytes,
// TRAYDATA is 32 bytes). The sidecar is AnyCPU and so runs 64-bit alongside a
// 64-bit explorer; a 32-bit build would read garbage.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static class Tray {
    class Entry {
      public IntPtr Owner;
      public uint Id;
      public uint CallbackMessage;
    }

    /// id string -> where to send a click. Refreshed by every List() call.
    static readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);

    /// The toolbars that have ever held tray icons, in the order we try them.
    static List<IntPtr> Toolbars(out string why) {
      why = null;
      var found = new List<IntPtr>();
      IntPtr tray = Win32.FindWindowW("Shell_TrayWnd", null);
      if (tray == IntPtr.Zero) { why = "no Shell_TrayWnd window (explorer is not running the shell)"; return found; }

      // Name the step that failed, not just "it did not work". On Windows 11
      // 25H2 (this machine) Shell_TrayWnd has NO child HWNDs at all - the whole
      // taskbar is XAML - so the answer is "no TrayNotifyWnd", and a reader
      // knows immediately that this is a shell-architecture wall and not a bug.
      string trayNotify = null;
      IntPtr notify = Win32.FindWindowExW(tray, IntPtr.Zero, "TrayNotifyWnd", null);
      if (notify == IntPtr.Zero) {
        trayNotify = "Shell_TrayWnd has no TrayNotifyWnd child window (this build draws the tray in XAML, with no legacy HWNDs to read)";
      } else {
        IntPtr pager = Win32.FindWindowExW(notify, IntPtr.Zero, "SysPager", null);
        IntPtr tb = pager != IntPtr.Zero
          ? Win32.FindWindowExW(pager, IntPtr.Zero, "ToolbarWindow32", null)
          : Win32.FindWindowExW(notify, IntPtr.Zero, "ToolbarWindow32", null);
        if (tb != IntPtr.Zero) found.Add(tb);
        else trayNotify = "TrayNotifyWnd has no ToolbarWindow32 (SysPager " + (pager != IntPtr.Zero ? "present" : "missing") + ")";
      }

      IntPtr overflow = Win32.FindWindowW("NotifyIconOverflowWindow", null);
      if (overflow != IntPtr.Zero) {
        IntPtr tb = Win32.FindWindowExW(overflow, IntPtr.Zero, "ToolbarWindow32", null);
        if (tb != IntPtr.Zero) found.Add(tb);
      }

      if (found.Count == 0)
        why = trayNotify + "; no NotifyIconOverflowWindow either";
      return found;
    }

    public static List<object> List() {
      string why;
      var toolbars = Toolbars(out why);
      // No legacy toolbar (Windows 11 26200 and 26300, measured): answer from the XAML
      // tray instead - see TrayUia.cs. If that fails too, name both failures.
      if (toolbars.Count == 0) return FromXaml(why);

      var result = new List<object>();
      _entries.Clear();
      int totalButtons = 0;

      foreach (IntPtr tb in toolbars) {
        int count = Win32.SendMessageW(tb, Win32.TB_BUTTONCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0) continue;
        totalButtons += count;
        ReadToolbar(tb, count, result);
      }

      if (totalButtons == 0)
        return FromXaml("explorer exposes 0 legacy tray buttons on this build (Windows 11 draws the tray in XAML)");
      return result;
    }

    static List<object> FromXaml(string legacyWhy) {
      try { return TrayUia.List(); }
      catch (Exception ex) {
        throw new InvalidOperationException("tray unavailable: " + ex.Message + " (legacy route: " + legacyWhy + ")");
      }
    }

    const int TBBUTTON_SIZE = 32;   // x64
    const int REMOTE_BUF = 4096;

    static void ReadToolbar(IntPtr tb, int count, List<object> result) {
      int pid;
      Win32.GetWindowThreadProcessId(tb, out pid);
      IntPtr proc = Win32.OpenProcess(
        Win32.PROCESS_VM_OPERATION | Win32.PROCESS_VM_READ | Win32.PROCESS_VM_WRITE | Win32.PROCESS_QUERY_LIMITED_INFORMATION,
        false, pid);
      if (proc == IntPtr.Zero)
        throw new InvalidOperationException("tray unavailable: cannot open explorer (pid " + pid +
          ") for reading - Win32 error " + Marshal.GetLastWin32Error());

      IntPtr remote = IntPtr.Zero;
      IntPtr local = Marshal.AllocHGlobal(REMOTE_BUF);
      try {
        remote = Win32.VirtualAllocEx(proc, IntPtr.Zero, new IntPtr(REMOTE_BUF),
          Win32.MEM_COMMIT | Win32.MEM_RESERVE, Win32.PAGE_READWRITE);
        if (remote == IntPtr.Zero)
          throw new InvalidOperationException("tray unavailable: could not allocate a buffer inside explorer - Win32 error " +
            Marshal.GetLastWin32Error());

        for (int i = 0; i < count; i++) {
          try {
            if (Win32.SendMessageW(tb, Win32.TB_GETBUTTON, new IntPtr(i), remote) == IntPtr.Zero) continue;
            IntPtr read;
            if (!Win32.ReadProcessMemory(proc, remote, local, new IntPtr(TBBUTTON_SIZE), out read)) continue;

            int idCommand = Marshal.ReadInt32(local, 4);
            byte fsState = Marshal.ReadByte(local, 8);
            IntPtr dwData = Marshal.ReadIntPtr(local, 16);
            if ((fsState & 0x08) != 0) continue;   // TBSTATE_HIDDEN
            if (dwData == IntPtr.Zero) continue;

            // TRAYDATA (x64): hwnd@0, uID@8, uCallbackMessage@12, reserved@16, hIcon@24
            if (!Win32.ReadProcessMemory(proc, dwData, local, new IntPtr(32), out read)) continue;
            IntPtr owner = Marshal.ReadIntPtr(local, 0);
            uint uid = (uint)Marshal.ReadInt32(local, 8);
            uint callback = (uint)Marshal.ReadInt32(local, 12);
            IntPtr hIcon = Marshal.ReadIntPtr(local, 24);

            string tooltip = ReadText(tb, proc, remote, local, idCommand);
            string icon = null;
            if (hIcon != IntPtr.Zero) {
              // The HICON belongs to explorer, but icon handles are per-session
              // user objects, so CopyIcon across processes is legal. Copy so our
              // DestroyIcon can never free explorer's original.
              IntPtr mine = Win32.CopyIcon(hIcon);
              if (mine != IntPtr.Zero) {
                icon = Icons.FromHIcon(mine);
                Win32.DestroyIcon(mine);
              }
            }

            string id = owner.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + uid;
            _entries[id] = new Entry { Owner = owner, Id = uid, CallbackMessage = callback };
            result.Add(Json.Obj("id", id, "tooltip", tooltip ?? "", "icon", icon));
          } catch (Exception ex) {
            Program.EmitLog("warn", "skipped a tray button: " + ex.Message);
          }
        }
      } finally {
        if (remote != IntPtr.Zero) Win32.VirtualFreeEx(proc, remote, IntPtr.Zero, Win32.MEM_RELEASE);
        Marshal.FreeHGlobal(local);
        Win32.CloseHandle(proc);
      }
    }

    static string ReadText(IntPtr tb, IntPtr proc, IntPtr remote, IntPtr local, int idCommand) {
      try {
        int chars = Win32.SendMessageW(tb, Win32.TB_GETBUTTONTEXTW, new IntPtr(idCommand), remote).ToInt32();
        if (chars <= 0) return "";
        int bytes = Math.Min(chars * 2, REMOTE_BUF - 2);
        IntPtr read;
        if (!Win32.ReadProcessMemory(proc, remote, local, new IntPtr(bytes), out read)) return "";
        return Marshal.PtrToStringUni(local, bytes / 2);
      } catch (Exception) {
        return "";
      }
    }

    public static string Click(string id, string button) {
      if (string.IsNullOrEmpty(id)) return "no tray id given";
      if (TrayUia.Owns(id)) return TrayUia.Click(id, button);
      Entry e;
      if (!_entries.TryGetValue(id, out e)) {
        // The caller may not have listed yet (or explorer re-created the icons).
        try { List(); } catch (Exception ex) { return ex.Message; }
        if (!_entries.TryGetValue(id, out e))
          return "no tray icon with id " + id + " (it may have been removed since the last tray listing)";
      }
      if (!Win32.IsWindow(e.Owner))
        return "the app owning tray icon " + id + " has exited";

      uint down = button == "right" ? Win32.WM_RBUTTONDOWN : Win32.WM_LBUTTONDOWN;
      uint up = button == "right" ? Win32.WM_RBUTTONUP : Win32.WM_LBUTTONUP;
      // The shell convention: wParam = the icon id, lParam = the mouse message.
      Win32.PostMessageW(e.Owner, e.CallbackMessage, new IntPtr(e.Id), new IntPtr(down));
      Win32.PostMessageW(e.Owner, e.CallbackMessage, new IntPtr(e.Id), new IntPtr(up));
      return null;
    }
  }
}
