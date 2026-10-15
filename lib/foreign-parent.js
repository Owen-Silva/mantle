'use strict';
/*
 * lib/foreign-parent.js -- A WINDOW WHOSE PARENT DIES IN ANOTHER PROCESS CLOSES IN ORDER, NOT IN A CRASH
 * (lane mantle-crash, 2026-10-15).
 *
 * WHAT HAPPENED. Both times Explorer exited while Mantle was alive (10-11 17:01:15, 10-14 20:11:52) Mantle's
 * main process died in the same second with 0xc000041d (STATUS_FATAL_USER_CALLBACK_EXCEPTION), fault offset
 * electron.exe+0x353cba8 both times. Symbolised with Electron 44.4.3's own breakpad symbols:
 *   PeekMessage -> (a message SENT from another thread) -> HWNDMessageHandler::OnWndProc(WM_NCDESTROY)
 *   -> DesktopNativeWidgetAura::OnHostClosed -> ~ElectronDesktopWindowTreeHostWin
 *   -> ui::NativeThemeObserver::~NativeThemeObserver: CHECK(!IsInObserverList())  -> int3 (0x80000003)
 * Electron adds every window as a NativeTheme observer on WM_NCCREATE and removes it on WM_DESTROY only
 * (electron_desktop_window_tree_host_win.cc PreHandleMSG). The desktop layer is a WS_CHILD of Explorer's
 * Progman (sidecar Desktop.cs). When the thread that owns a parent window DIES (Explorer crashing, killed,
 * End task), Windows frees that parent and sends its child in ANOTHER process WM_NCDESTROY with NO
 * WM_DESTROY before it. The observer is never removed, the CHECK fires inside a window procedure that the
 * kernel called back into, and that is fatal to the whole process. A parent closed IN ORDER (DestroyWindow
 * on its own thread) sends WM_DESTROY first and nothing breaks.
 *   Reproduced 2026-10-15 with a stand-in Progman (tools/fake-progman.cs): killed / thread exits / crashes
 *   -> the child sees WM_NCDESTROY only -> same CHECK, same offset; DestroyWindow -> WM_DESTROY, then
 *   WM_NCDESTROY, a clean 'closed'. lib/explorer-exit.e2e.test.js keeps that proof.
 *
 * THE FIX. Every Mantle window has WM_DESTROY and WM_NCDESTROY hooked (BrowserWindow.hookWindowMessage runs
 * the callback synchronously inside the window procedure, BEFORE Chromium handles the message). A
 * WM_NCDESTROY with no WM_DESTROY before it is the dying-parent case: the hook SENDS the window the
 * WM_DESTROY that Windows skipped, on Mantle's own thread, so Electron removes its observer and Chromium
 * runs its normal "destroying" step; then the WM_NCDESTROY carries on and the window closes the ordinary
 * way ('closed' fires; main.js desktopGone makes the layer again). Logged once per window, with why.
 * A window that closes normally saw WM_DESTROY first, so the hook does nothing.
 *
 * EXPLORER COMING BACK. hookShellRestart: Explorer broadcasts the registered "TaskbarCreated" message to
 * every top-level window when it starts; main.js shellRestarted() then re-attaches the desktop layer and
 * tells the features (the top bar takes its strip again). progmanThere() is the fallback poll main uses
 * once the layer's own tries ran out with no Progman.
 *
 * NOTE: hookWindowMessage keeps ONE callback per message per window. Nothing else in Mantle may hook
 * WM_DESTROY, WM_NCDESTROY or TaskbarCreated on a window, or it silently replaces this guard
 * (lib/foreign-parent.test.js checks main.js and lib/ for such a hook).
 */

const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;

/** Pure: what to do on WM_NCDESTROY. -> 'ok' (WM_DESTROY came first: the normal close) | 'finish'. */
function ncDestroyAction(seenDestroy, alreadyFinished) {
  if (seenDestroy || alreadyFinished) return 'ok';
  return 'finish';
}

let U = null;
/** user32 through koffi, bound on first use (a window that is never orphaned never loads it). */
function user32() {
  if (U) return U;
  const koffi = require('koffi');
  const lib = koffi.load('user32.dll');
  U = {
    send: lib.func('intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
    register: lib.func('uint32_t __stdcall RegisterWindowMessageW(str16 name)'),
    find: lib.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)'),
  };
  return U;
}

let taskbarCreated = 0;
/** The session's "TaskbarCreated" message: Explorer broadcasts it to every top-level window when it starts. */
function taskbarCreatedId() {
  if (!taskbarCreated) taskbarCreated = user32().register('TaskbarCreated') >>> 0;
  return taskbarCreated;
}

/**
 * Call fn('TaskbarCreated') when Explorer (re)starts. Only TOP-LEVEL windows hear the broadcast, so hooking
 * every window is fine: child windows simply never get it. Never throws. -> true when hooked.
 */
function hookShellRestart(win, fn) {
  if (process.platform !== 'win32' || !win || typeof win.hookWindowMessage !== 'function') return false;
  try {
    const id = taskbarCreatedId();
    if (!id) return false;
    win.hookWindowMessage(id, () => { try { fn('TaskbarCreated'); } catch (_) { /* the listener logs its own */ } });
    return true;
  } catch (_) {
    return false;
  }
}

/** Is Explorer's desktop window (Progman) there right now? -> true/false; null when it cannot be asked. */
function progmanThere() {
  try { return !!user32().find('Progman', null); } catch (_) { return null; }
}

/** The window's HWND as a JS number (Win32 handles fit in 32 bits even on x64). */
function hwndNumber(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

const guarded = new WeakSet();

/**
 * Hook `win` so a parent dying in another process closes it in order. Idempotent. Never throws.
 * opts: { name (for the log), log(line), sendDestroy(hwnd) (tests) }. -> true when hooked.
 */
function guardWindow(win, opts) {
  const o = opts || {};
  if (process.platform !== 'win32' || !win || guarded.has(win)) return false;
  if (typeof win.hookWindowMessage !== 'function') return false;
  const log = typeof o.log === 'function' ? o.log : (line) => process.stdout.write(`mantle: ${line}\n`);
  let hwnd;
  try { hwnd = hwndNumber(win); } catch (_) { return false; }
  const name = () => {
    if (o.name) return o.name;
    try { const m = /\/ui\/(.+?)(?:\/index\.html)?(?:[?#]|$)/.exec(String(win.webContents.getURL() || '').replace(/\\/g, '/')); if (m) return `the ${m[1]} window`; } catch (_) { /* closing */ }
    return 'a Mantle window';
  };
  let seenDestroy = false;
  let finished = false;
  try {
    win.hookWindowMessage(WM_DESTROY, () => { seenDestroy = true; });
    win.hookWindowMessage(WM_NCDESTROY, () => {
      if (ncDestroyAction(seenDestroy, finished) !== 'finish') return;
      finished = true;
      const who = name();
      try {
        if (o.sendDestroy) o.sendDestroy(hwnd);
        else user32().send(hwnd, WM_DESTROY, 0, 0);
        log(`${who}: its parent window in another process went away without closing it (Explorer exited or crashed?), ` +
          'so Mantle finished the close in order itself (sent the WM_DESTROY that Windows skipped) instead of crashing');
      } catch (err) {
        log(`${who}: its parent window in another process went away without closing it, and Mantle could not finish the close in order: ${err.message}`);
      }
    });
  } catch (err) {
    log(`${name()}: the guard against a parent dying in another process could not be set: ${err.message}`);
    return false;
  }
  guarded.add(win);
  return true;
}

module.exports = { guardWindow, hookShellRestart, progmanThere, taskbarCreatedId, ncDestroyAction, hwndNumber, WM_DESTROY, WM_NCDESTROY };
