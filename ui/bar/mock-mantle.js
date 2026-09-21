/* mock-mantle.js — a stand-in for the preload bridge, and ONLY when there isn't one.
 *
 * WHY this file exists: the bar has to be designed, screenshotted and eyeballed without
 * Electron running (lane B owns the main process; running Electron here would put a window
 * over Owen's screen). So when the page is opened straight off disk in a browser there is no
 * `window.mantle`, and every subscription would silently do nothing — the exact failure mode
 * we refuse. This file fills that hole with a fake bridge that behaves like the real one:
 * same channel names, same payload shapes, async replies (30 ms, so code that assumes a
 * synchronous answer breaks here rather than in production), and a console line per call.
 *
 * WHY the `if (window.mantle) return` guard: inside Electron the preload has already installed
 * the real bridge before any page script runs. This file must never shadow it — a mock that
 * quietly replaced the real bridge would make a broken build look healthy.
 *
 * URL switches for screenshots / manual poking:
 *   ?windows=20   emit 20 windows instead of 6 (proves the icon-only overflow path)
 *   ?state=down   sidecar reported down, so the amber status chip is on screen
 *   ?edge=top     pretend the bar is docked at the top (bar.js also honours this)
 */
(function () {
  'use strict';

  if (window.mantle) return;                 // real bridge present: do nothing at all.

  var q = new URLSearchParams(location.search);
  var WIN_COUNT = Math.max(0, parseInt(q.get('windows'), 10) || 6);
  var SIDECAR_DOWN = q.get('state') === 'down';

  /* Two genuine 32x32 PNGs (generated, not placeholders) so the icon path is exercised with
     real bitmaps; the rest of the windows carry icon:null so the letter-tile fallback is
     exercised too. Real Windows icons arrive from the sidecar as PNG data URLs. */
  var ICON_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42mNgGIxA28r1Py3wgFpOlCNobTleR9DLcqyOoLflGI4YdQA+RUVrT4HxgDgAZjmtHEGyA6jtCJKigBaOIDoR0soRJOUCWjiC5GxIbUeQVQ5Q0xFDzwEDGgUDmggHNBsOaEFErOUbtu7HiYd2ZTTg1fFoi2hYt4wHX8dkUHTNBkXnlN4AAH64+BZg5hbDAAAAAElFTkSuQmCC';
  var ICON_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlUlEQVR42u2X3Q2AMAiEO4zvvruJ2zmam+gAbcodBrg0NuGpgfuaUH5aUzzHvj0RVioOQUSLTyGyxIcQ2eIdBON0X+fUwgAsYQ8IDMCKoxAQABOYhTABPK9ifGgAb6K6AKwgX+8pADQpmRhuACbzf4A1AUqSsOQblhciiVJc3owk2rHEQCIxki03GestJhKrmcRymn1e2n9aWzMoGqMAAAAASUVORK5CYII=';

  /* Titles deliberately include a very long one and a couple of near-identical ones: the long
     one proves the ellipsis, the near-identical pair proves the icon-only mode is still
     readable (tooltip carries the full title). */
  var TITLES = [
    'mantle — bar.js — Visual Studio Code',
    'Mantle build brief, lane C: the bar — and a title long enough to need the ellipsis treatment',
    'Terminal',
    'Mail — Inbox (14)',
    'Spotify Premium',
    'Settings'
  ];
  var ICONS = [ICON_A, null, null, ICON_B, null, null];

  function makeWindows(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({
        hwnd: 100000 + i * 17,                      // stable per index: the diffing key
        title: TITLES[i % TITLES.length] + (i >= TITLES.length ? ' (' + (i + 1) + ')' : ''),
        icon: ICONS[i % ICONS.length],
        foreground: i === 0,                        // exactly one foreground window
        minimized: i === 2                          // one minimized, so the dim state shows
      });
    }
    return out;
  }
  var windows = makeWindows(WIN_COUNT);

  function state() {
    return {
      mode: 'test',
      edge: q.get('edge') === 'top' ? 'top' : 'bottom',
      sidecar: SIDECAR_DOWN
        ? { ok: false, reason: 'sidecar exited: exit code 1' }
        : { ok: true, reason: '' },
      taskbar: { hidden: true, reason: '' },        // test mode never touches the real taskbar
      desktop: { attached: true, reason: '' },
      tray: { available: false, reason: 'explorer exposes 0 legacy tray buttons on this build' },
      hotkey: { on: false, reason: 'test mode: hook not installed' }
    };
  }

  var volume = { level: 0.42, muted: false };

  var listeners = Object.create(null);

  function emit(channel, payload) {
    var ls = listeners[channel];
    if (!ls) return;
    for (var i = 0; i < ls.length; i++) { try { ls[i](payload); } catch (e) { console.error('[mock] listener threw on', channel, e); } }
  }

  /* Replies. Anything not listed rejects by name, which is what the real bridge should also do:
     a typo in a channel name must surface in the UI, never resolve to undefined. */
  function reply(channel, payload) {
    switch (channel) {
      case 'state.get':   return state();
      case 'sys.stats':   return { battery: { percent: 72, charging: false }, volume: { level: volume.level, muted: volume.muted } };
      case 'volume.get':  return { level: volume.level, muted: volume.muted };
      case 'volume.set':
        if (payload && typeof payload.level === 'number') volume.level = Math.max(0, Math.min(1, payload.level));
        if (payload && typeof payload.muted === 'boolean') volume.muted = payload.muted;
        return { level: volume.level, muted: volume.muted };
      case 'tray.list':
        // The unavailable case is the interesting one: the bar must say WHY the tray is empty.
        throw new Error(state().tray.reason);
      case 'win.toggle':
      case 'win.close': {
        var hwnd = payload && payload.hwnd;
        if (channel === 'win.close') windows = windows.filter(function (w) { return w.hwnd !== hwnd; });
        else windows = windows.map(function (w) {
          if (w.hwnd !== hwnd) return { hwnd: w.hwnd, title: w.title, icon: w.icon, foreground: false, minimized: w.minimized };
          return { hwnd: w.hwnd, title: w.title, icon: w.icon, foreground: !w.foreground && !w.minimized, minimized: w.foreground ? true : false };
        });
        setTimeout(function () { emit('windows', windows); }, 0);
        return { ok: true };
      }
      case 'launcher.show':
      case 'tray.click':
      case 'open':
      case 'shell.restore':
      case 'shell.quit':
      case 'bar.popover':
        return { ok: true, mock: true };
      default:
        throw new Error('unknown channel "' + channel + '" (mock bridge)');
    }
  }

  window.mantle = {
    mode: 'mock',                                   // bar.js shows this, so a mock is never mistaken for the real thing

    /* on(): every channel replays its current value once on subscribe, because the bar is a
       readout — it must be correct the instant it is created, not after the next change. */
    on: function (channel, cb) {
      (listeners[channel] || (listeners[channel] = [])).push(cb);
      setTimeout(function () {
        if (channel === 'windows') cb(windows);
        else if (channel === 'tray') cb([]);          // tray unavailable on this build
        else if (channel === 'state') cb(state());
      }, 30);
      return function off() {
        listeners[channel] = (listeners[channel] || []).filter(function (f) { return f !== cb; });
      };
    },

    call: function (channel, payload) {
      console.log('[mock] call', channel, payload || '');
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(reply(channel, payload)); }
          catch (e) { console.warn('[mock] call rejected', channel, e.message); reject(e); }
        }, 30);
      });
    }
  };

  console.log('[mock] window.mantle installed (no real bridge found) — windows:', WIN_COUNT, 'sidecar down:', SIDECAR_DOWN);
})();
