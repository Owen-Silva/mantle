# Mantle

A shell layer over Windows 11. explorer.exe keeps running underneath; Mantle hides the
Windows taskbar and draws its own bar, launcher and desktop layer in Owen's instrument-glass
look. A kill switch (Ctrl+Alt+Shift+Backspace) or the tray menu puts Windows back instantly.

Electron for the UI (shares the design tokens with ~/browser), one C# sidecar compiled with
the built-in csc.exe for every Win32 call (window list, focus, taskbar hide, work area,
wallpaper-layer reparenting, solo-Win hotkey, volume, tray).

Status: first slice under construction, 2026-09-21.
