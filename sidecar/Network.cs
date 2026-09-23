// Network.cs - `wifi`: what the Wi-Fi icon in Mantle's bar needs to know, and
// the switch behind it.
//
// WHY THE NATIVE API AND NOT netsh. Owen's complaint about the stock bar is
// that its buttons "just go to settings now"; Mantle's answer is a panel of its
// own, which means the bar polls this state about twice a second. A netsh or
// PowerShell call per poll is a process launch per poll - tens of milliseconds
// and a flash of CPU, forever. WlanQueryInterface answers in microseconds.
//
// The handle is opened and closed per call ON PURPOSE. It is cheap, and it
// means this file holds NO state: a sidecar that dies mid-call leaves Windows
// with nothing to clean up, which is the rule the whole process is built on.
//
// EVERY NATIVE BUFFER HERE IS FREED. WlanEnumInterfaces and WlanQueryInterface
// both allocate, and the caller owns what comes back - a leak here would grow
// every time the panel opens.
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static class Network {

    /// The full answer for the bar, in one pass. Never throws: a machine with
    /// no Wi-Fi radio is an ordinary answer (present:false with the reason),
    /// not a failure.
    public static IDictionary Read() {
      bool present = false, on = false, connected = false;
      string ssid = null, band = null, reason = null;
      int signal = 0;

      IntPtr h = IntPtr.Zero;
      try {
        uint negotiated;
        uint rc = Win32.WlanOpenHandle(2, IntPtr.Zero, out negotiated, out h);
        if (rc != 0 || h == IntPtr.Zero)
          return Json.Obj("ok", true, "present", false, "on", false, "connected", false,
                          "ssid", null, "signal", 0, "band", null,
                          "reason", "the Wi-Fi service did not answer (WlanOpenHandle error " + rc +
                                    "); this machine may have no wireless hardware or WLAN AutoConfig may be stopped");

        IntPtr list;
        rc = Win32.WlanEnumInterfaces(h, IntPtr.Zero, out list);
        if (rc != 0 || list == IntPtr.Zero)
          return Json.Obj("ok", true, "present", false, "on", false, "connected", false,
                          "ssid", null, "signal", 0, "band", null,
                          "reason", "no wireless interface could be enumerated (error " + rc + ")");

        try {
          int count = Marshal.ReadInt32(list);
          if (count <= 0)
            return Json.Obj("ok", true, "present", false, "on", false, "connected", false,
                            "ssid", null, "signal", 0, "band", null,
                            "reason", "this machine has no wireless interface");

          present = true;
          int stride = Marshal.SizeOf(typeof(Win32.WLAN_INTERFACE_INFO));
          for (int i = 0; i < count; i++) {
            IntPtr p = new IntPtr(list.ToInt64() + 8 + (long)i * stride);
            var info = (Win32.WLAN_INTERFACE_INFO)Marshal.PtrToStructure(p, typeof(Win32.WLAN_INTERFACE_INFO));
            Guid guid = info.InterfaceGuid;

            if (RadioOn(h, guid)) on = true;
            if (info.isState == Win32.WLAN_INTERFACE_STATE_CONNECTED && !connected) {
              string s;
              int q;
              if (Connection(h, guid, out s, out q)) {
                connected = true;
                ssid = s;
                signal = q;
                band = Band(h, guid);
              }
            }
          }
        } finally {
          Win32.WlanFreeMemory(list);
        }

        if (!on) reason = "the Wi-Fi radio is switched off";
        else if (!connected) reason = "the Wi-Fi radio is on but not connected to a network";
      } catch (Exception ex) {
        reason = "the Wi-Fi state could not be read (" + ex.Message + ")";
      } finally {
        if (h != IntPtr.Zero) { try { Win32.WlanCloseHandle(h, IntPtr.Zero); } catch (Exception) { } }
      }

      return Json.Obj("ok", true, "present", present, "on", on, "connected", connected,
                      "ssid", ssid, "signal", signal, "band", band, "reason", reason);
    }

    /// Turn every wireless radio on this machine on or off, then report what
    /// the machine says afterwards rather than what we asked for - a hardware
    /// switch or a group policy can refuse, and a UI that shows the requested
    /// state instead of the real one is lying to the user.
    public static IDictionary Set(bool want, out IDictionary readBack) {
      readBack = null;
      IntPtr h = IntPtr.Zero;
      string reason = null;
      int changed = 0, refused = 0;
      uint lastError = 0;

      try {
        uint negotiated;
        uint rc = Win32.WlanOpenHandle(2, IntPtr.Zero, out negotiated, out h);
        if (rc != 0 || h == IntPtr.Zero)
          return Json.Obj("ok", false, "present", false, "on", false, "connected", false,
                          "ssid", null, "signal", 0, "band", null,
                          "reason", "the Wi-Fi service did not answer (WlanOpenHandle error " + rc + ")");

        IntPtr list;
        rc = Win32.WlanEnumInterfaces(h, IntPtr.Zero, out list);
        if (rc != 0 || list == IntPtr.Zero)
          return Json.Obj("ok", false, "present", false, "on", false, "connected", false,
                          "ssid", null, "signal", 0, "band", null,
                          "reason", "no wireless interface could be enumerated (error " + rc + ")");

        try {
          int count = Marshal.ReadInt32(list);
          int stride = Marshal.SizeOf(typeof(Win32.WLAN_INTERFACE_INFO));
          for (int i = 0; i < count; i++) {
            IntPtr p = new IntPtr(list.ToInt64() + 8 + (long)i * stride);
            var info = (Win32.WLAN_INTERFACE_INFO)Marshal.PtrToStructure(p, typeof(Win32.WLAN_INTERFACE_INFO));
            Guid guid = info.InterfaceGuid;
            foreach (uint phy in Phys(h, guid)) {
              uint e = SetPhy(h, guid, phy, want);
              if (e == 0) changed++;
              else { refused++; lastError = e; }
            }
          }
        } finally {
          Win32.WlanFreeMemory(list);
        }

        if (changed == 0 && refused > 0)
          reason = "Windows refused to switch the Wi-Fi radio (error " + lastError +
                   (lastError == 5 ? ": access denied - changing the radio needs an elevated process" : "") +
                   "); a hardware switch, airplane mode or a group policy can also block it";
      } catch (Exception ex) {
        reason = "the Wi-Fi radio could not be switched (" + ex.Message + ")";
      } finally {
        if (h != IntPtr.Zero) { try { Win32.WlanCloseHandle(h, IntPtr.Zero); } catch (Exception) { } }
      }

      // Read it back: the reply is the STATE, not the request. The plain copy
      // goes to QuickSettings' cache, so the panel's next read is this one.
      var now = Read();
      readBack = Json.Obj();
      foreach (DictionaryEntry e in now) readBack[e.Key] = e.Value;
      if (reason != null) {
        now["ok"] = false;
        now["reason"] = reason;
      }
      return now;
    }

    // ------------------------------------------------------------- internals

    static bool RadioOn(IntPtr h, Guid guid) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref guid, Win32.WLAN_INTF_OPCODE_RADIO_STATE, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return false;
        int phys = Marshal.ReadInt32(data);
        for (int i = 0; i < phys && i < 64; i++) {
          long at = data.ToInt64() + 4 + (long)i * 12;
          uint soft = (uint)Marshal.ReadInt32(new IntPtr(at + 4));
          uint hard = (uint)Marshal.ReadInt32(new IntPtr(at + 8));
          // Either one being OFF means no radio; UNKNOWN is treated as on,
          // because that is what Windows shows.
          if (soft != Win32.DOT11_RADIO_STATE_OFF && hard != Win32.DOT11_RADIO_STATE_OFF) return true;
        }
        return false;
      } catch (Exception) {
        return false;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    static uint[] Phys(IntPtr h, Guid guid) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref guid, Win32.WLAN_INTF_OPCODE_RADIO_STATE, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero)
          return new uint[] { 0 };
        int phys = Marshal.ReadInt32(data);
        if (phys <= 0 || phys > 64) return new uint[] { 0 };
        var found = new uint[phys];
        for (int i = 0; i < phys; i++)
          found[i] = (uint)Marshal.ReadInt32(new IntPtr(data.ToInt64() + 4 + (long)i * 12));
        return found;
      } catch (Exception) {
        return new uint[] { 0 };
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    static uint SetPhy(IntPtr h, Guid guid, uint phyIndex, bool on) {
      var state = new Win32.WLAN_PHY_RADIO_STATE();
      state.dwPhyIndex = phyIndex;
      state.dot11SoftwareRadioState = on ? Win32.DOT11_RADIO_STATE_ON : Win32.DOT11_RADIO_STATE_OFF;
      // The hardware state is read-only; it is left at "unknown" deliberately.
      state.dot11HardwareRadioState = Win32.DOT11_RADIO_STATE_UNKNOWN;
      int size = Marshal.SizeOf(typeof(Win32.WLAN_PHY_RADIO_STATE));
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(state, buf, false);
        return Win32.WlanSetInterface(h, ref guid, Win32.WLAN_INTF_OPCODE_RADIO_STATE, (uint)size, buf, IntPtr.Zero);
      } catch (Exception) {
        return uint.MaxValue;
      } finally {
        Marshal.FreeHGlobal(buf);
      }
    }

    static bool Connection(IntPtr h, Guid guid, out string ssid, out int signal) {
      ssid = null;
      signal = 0;
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref guid, Win32.WLAN_INTF_OPCODE_CURRENT_CONNECTION, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return false;
        var conn = (Win32.WLAN_CONNECTION_ATTRIBUTES)
          Marshal.PtrToStructure(data, typeof(Win32.WLAN_CONNECTION_ATTRIBUTES));
        var s = conn.wlanAssociationAttributes.dot11Ssid;
        int len = (int)s.uSSIDLength;
        if (s.ucSSID != null && len > 0 && len <= 32) ssid = Encoding.UTF8.GetString(s.ucSSID, 0, len);
        signal = (int)conn.wlanAssociationAttributes.wlanSignalQuality;
        if (signal < 0) signal = 0;
        if (signal > 100) signal = 100;
        return true;
      } catch (Exception) {
        return false;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }

    /// From the channel number, which is the only band signal the WLAN API
    /// gives without parsing PHY types: 1-14 is 2.4 GHz, 32-177 is 5 GHz.
    /// Anything else (including 6 GHz, whose channel numbers overlap 2.4) is
    /// reported as null rather than guessed at.
    static string Band(IntPtr h, Guid guid) {
      IntPtr data = IntPtr.Zero;
      try {
        uint size;
        if (Win32.WlanQueryInterface(h, ref guid, Win32.WLAN_INTF_OPCODE_CHANNEL_NUMBER, IntPtr.Zero,
                                     out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) return null;
        int ch = Marshal.ReadInt32(data);
        if (ch >= 1 && ch <= 14) return "2.4 GHz";
        if (ch >= 32 && ch <= 177) return "5 GHz";
        return null;
      } catch (Exception) {
        return null;
      } finally {
        if (data != IntPtr.Zero) Win32.WlanFreeMemory(data);
      }
    }
  }
}
