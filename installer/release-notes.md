**Mantle-Setup.exe**: the first Windows installer for Mantle. One click, for your user only, no admin prompt; it installs to `%LOCALAPPDATA%\Programs\Mantle` and adds Start menu > Mantle with two entries, **Mantle** and **Restore Windows taskbar**.

> **At your own risk.** Mantle takes over parts of the Windows shell (the taskbar, the Win key, Alt+Tab, notification banners, the desktop layer). It has been built and tested on one Windows 11 machine.

- **The installer is not code-signed.** Windows SmartScreen says "Windows protected your PC": choose **More info**, then **Run anyway**.
- **Nothing goes live by itself.** Mantle's first start shows a warning with every way to get Windows back, and asks before it starts. Starting at sign-in is a box you tick there; it is off.
- **Getting Windows back:** quit Mantle from the ••• menu on its bar, or press Ctrl+Alt+Shift+Backspace. If the taskbar stays hidden: Start > All apps > Mantle > **Restore Windows taskbar**. Last resort: Ctrl+Shift+Esc, select Windows Explorer, Restart.
- **Uninstall** in Settings > Apps > Installed apps. It asks Mantle to put Windows back and quit, checks that the taskbar is back, and only then removes Mantle. Your settings in `%APPDATA%\mantle` stay.
- **Updates:** Mantle tells you when a new release is out and links its installer. Run it: it puts Windows back, replaces Mantle and starts it again.

Running Mantle from a `git clone` works exactly as before; see the README.
