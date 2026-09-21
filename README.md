# Mantle

A shell **layer** over Windows 11. explorer.exe keeps running underneath: Mantle
hides the Windows taskbar and puts its own bar, launcher and desktop layer on
screen in the instrument-glass look the browser uses. One keystroke, one tray
menu item or one crash puts Windows back exactly as it was.

Electron draws every pixel. One C# sidecar makes every Win32 call. Nothing else
talks to Windows.

```
  Electron (main.js)                        C# sidecar
  ├── bar        ui/bar/        44px        JSON lines over stdin/stdout
  ├── launcher   ui/launcher/   680x460     ├── window list / focus / close
  ├── desktop    ui/desktop/    full screen ├── hide + show the taskbar
  └── preload.js -> window.mantle           ├── reserve the work area
                                            ├── reparent the desktop under the wallpaper
                                            ├── the solo-Win-tap hook
                                            └── volume + the notification area
```

## Running it

```
npm install
npm start                 # LIVE: hides the Windows taskbar, installs the hook
npm test                  # test mode: three ordinary windows, Windows untouched
npm run shots             # test mode, capture the three windows, quit
npm run check             # node --check everything + which lane files exist
npm run build:sidecar     # compile the sidecar with the in-box csc.exe
```

Flags (`electron . <flags>`):

| flag | what it does |
| --- | --- |
| `--test` | test mode: the sidecar runs `--passive` and refuses every shell change; the three windows are plain resizable windows; nothing is hidden, hooked or reparented |
| `--profile-name=<x>` | **required with `--test`.** userData goes to `%TEMP%\mantle-test-<x>`, which also keys the single-instance lock, so a test run can never collide with the live shell. `tools/toback.ps1` and `tools/kill-test.ps1` match this flag |
| `--screenshot=<dir>` | test mode only: 4s after the windows load, capture `bar.png`, `launcher.png`, `desktop.png` into `<dir>`, then quit |
| `--bar-edge=top\|bottom` | which edge the bar sits on (default `bottom`) |
| `--no-desktop` | skip the desktop layer entirely |

## Getting Windows back

Four ways, and they all run the same restore path (taskbar shown, work area
reset, hook off, desktop detached):

1. **Ctrl+Alt+Shift+Backspace** — the kill switch. Restores, then quits.
2. The **tray menu** — *Restore Windows taskbar*, or *Quit Mantle*.
3. `mantle.call('shell.restore')` from any Mantle page (Mantle keeps running).
4. **Killing Mantle.** The sidecar watches its parent pid and its own stdin; when
   either goes away it restores everything itself before exiting. This is the one
   that matters: a crashed Electron cannot strand anyone without a taskbar.

The restore path is idempotent and swallows every error. If a step fails it says
so in the state (see below) rather than throwing.

## Nothing fails silently

Every helper, poller and fallback carries a **reason in plain words**, and the
desktop layer prints every unhappy one in its *Needs attention* strip. A log line
does not count; if it is not on screen it did not happen.

The shape, pushed to every window on every change and readable with
`mantle.call('state.get')`:

```js
{
  mode:      'live' | 'test',
  edge:      'bottom' | 'top',                  // from --bar-edge; the bar flips its popovers on it
  sidecar:   { status: 'ok'|'starting'|'down', reason },
  taskbar:   { hidden,   reason },
  workarea:  { reserved, reason },
  desktop:   { attached, mode, reason },
  hotkey:    { winTap,   reason },
  tray:      { status: 'ok'|'unavailable', reason },
  shortcuts: { killSwitch, launcher, reason }   // globalShortcut registration
}
```

A missing `ui/bar/index.html` or `ui/launcher/index.html` loads a placeholder
naming the file; a missing `lib/launcher-index.js` makes `apps.index` answer with
an empty list and a source row that says which lane owns it; a missing sidecar
exe is built once from `sidecar/build.ps1` and, if it still is not there, becomes
`sidecar: down` with the path in the reason while everything else keeps running.

## The bridge

Pages run with `contextIsolation` and `sandbox` on — no `require`, no node.
`preload.js` exposes exactly one object:

```js
mantle.call(name, args) -> Promise<result>   // rejects with an Error in plain words
mantle.on(event, cb)    -> unsubscribe()
```

| call | |
| --- | --- |
| `state.get` | the object above |
| `windows.list` | `[{hwnd, title, exe, pid, minimized, foreground, icon}]` |
| `win.focus` `win.minimize` `win.close` `win.toggle` | `{hwnd}` |
| `launcher.show` `launcher.hide` | |
| `bar.popover` | `{open, height, key}`: borrow up to 320px of extra window height so a popover is not clipped by the 44px bar. Grows away from the bar's screen edge; `{open:false}` gives it back |
| `apps.index` `apps.search` `apps.launch` | the launcher's index (`lib/launcher-index.js`) |
| `volume.get` `volume.set` | `{level, muted}` |
| `open` | `{target}`: http(s) goes to Owen's browser, `scheme:` to the shell, a path to the shell |
| `sys.stats` | `{cpu, memUsed, memTotal, battery}` |
| `tray.list` `tray.click` | the Windows notification area, mirrored |
| `shell.restore` `shell.quit` | |
| `net.probe` | `{url}` → `{ok, reason}`, loopback only (the desktop uses it for Mission Control) |

Events: `windows`, `state`, `launcher:visible`, `tray`. `windows` and `state`
also fire once immediately on subscribe, so no page renders an empty first frame.

## Layout

```
main.js              flags, windows, IPC, sidecar lifetime, tray, kill switch, restore
preload.js           window.mantle, and nothing else
lib/args.js          flag parsing; refuses to boot on a flag that would be dangerous
lib/state.js         the state object above
lib/sidecar.js       spawn, JSON lines, timeouts, restarts, the build-once attempt
lib/windows.js       the three windows, live shape and test shape
lib/apps.js          lane D's index module, wrapped so a missing one is a visible state
lib/sys-stats.js     cpu from os.cpus() deltas, memory, battery via one WMI probe
lib/tray-icon.js     the tray icon, drawn in code so the accent colour has one home
lib/placeholder.js   the "this file does not exist yet" page
lib/open-target.js   http(s) -> Owen's browser, scheme: -> shell, path -> shell
lib/net-probe.js     loopback reachability with a real reason
ui/shared/tokens.css the palette. Every colour in Mantle comes from here
ui/bar/              the bar
ui/launcher/         the launcher
ui/desktop/          the desktop layer: clock, stats, Mission Control, state strip
sidecar/             the C# sidecar and its build script
tools/toback.ps1     send a test instance's windows to the back without activating them
tools/kill-test.ps1  stop ONE test instance by profile name (never `taskkill electron.exe`)
tools/check.js       node --check everything + a present/missing list of the lane files
```

## Testing rules

Test instances only, and always this way:

```
npx electron . --test --profile-name=mainlane [--screenshot=<dir>]
powershell -NoProfile -File tools/toback.ps1 -Match mainlane      # immediately after
powershell -NoProfile -File tools/kill-test.ps1 -Match mainlane   # to stop it
```

`--profile-name` is what both scripts match, as the whole flag. Never
`taskkill electron.exe`: Owen's browser is an Electron app too.

Status: first slice, 2026-09-21.
