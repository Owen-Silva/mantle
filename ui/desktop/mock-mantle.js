/* mock-mantle.js — a stand-in for the preload bridge, and ONLY when there isn't one.
 *
 * The desktop layer has to be eyeballed without Electron running (running it would put a window
 * over Owen's screen, and lane A owns main). Opened straight off disk there is no window.mantle,
 * every subscription would silently do nothing, and the panes would be three em-dashes over
 * white — so this fills the hole with the same channel names and payload shapes main sends.
 *
 * The `if (window.mantle) return` guard is the important line: inside Electron preload.js has
 * already installed the real bridge before any page script runs, and a mock that quietly replaced
 * it would make a broken build look healthy.
 *
 * Switches (all optional; ?mock=1 just documents the intent — the mock installs either way):
 *   ?mock=1     explicit opt-in
 *   ?bg=1       paint a stand-in wallpaper on <html>, MOCK ONLY, so the glass has something behind it
 *   ?nobd=1     never send 'desktop.backdrop', to see the fallback tint and its row in the strip
 *   ?ok=1       every state piece healthy, so the "Needs attention" strip stays hidden
 */
(function () {
  'use strict';

  if (window.mantle) return;                  // real bridge present: do nothing at all.

  var q = new URLSearchParams(location.search);
  var listeners = Object.create(null);

  /* A stand-in wallpaper, MOCK ONLY: on disk there is nothing behind the page, so glass over
     white tells you nothing. Loud on purpose — if the ink survives this, a photograph is easy. */
  if (q.get('bg') === '1') {
    document.documentElement.style.background =
      'linear-gradient(120deg,#0b0d10 0%,#2f6fe0 18%,#d64545 38%,#1f8f4e 55%,#b23fd0 72%,#e0a059 88%,#0b0d10 100%)';
  }

  /* The capture main sends: the whole screen, wallpaper only, downscaled 8x. Drawn as a gradient
     with two hard blocks in it, because edges are what a blur is judged on. */
  function screenPNG() {
    var w = Math.max(80, Math.round(window.innerWidth / 8));
    var h = Math.max(45, Math.round(window.innerHeight / 8));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, w, h);
    ['#0b0d10', '#2f6fe0', '#b23fd0', '#e0a059', '#1f8f4e'].forEach(function (s, i, a) {
      grad.addColorStop(i / (a.length - 1), s);
    });
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff'; g.fillRect(w * 0.06, h * 0.10, w * 0.10, h * 0.30);
    g.fillStyle = '#0b0d10'; g.fillRect(w * 0.02, h * 0.45, w * 0.22, h * 0.06);
    return { png: c.toDataURL('image/png'), w: w, h: h };
  }

  function state() {
    var ok = q.get('ok') === '1';
    return {
      mode: 'test',
      sidecar: { status: 'ok', reason: '' },
      taskbar: { autohide: true, reason: '' },
      workarea: { reserved: true, reason: '' },
      desktop: { attached: true, reason: '' },
      hotkey: { winTap: ok, reason: ok ? '' : 'mock: no hook in a browser' },
      tray: { status: 'ok', reason: '' },
      glass: { material: 'acrylic-blur-behind', reason: '' },
      shortcuts: { killSwitch: true, launcher: true },
      'backdrop.desktop': q.get('nobd') === '1'
        ? { ok: false, ms: 0, reason: 'mock: ?nobd=1, so no screen capture was taken' }
        : { ok: true, ms: 42, reason: '' }
    };
  }

  window.mantle = {
    mode: 'mock',
    on: function (channel, cb) {
      (listeners[channel] || (listeners[channel] = [])).push(cb);
      setTimeout(function () {
        if (channel === 'state') cb(state());
        if (channel === 'desktop.backdrop' && q.get('nobd') !== '1') cb(Object.assign(screenPNG(), { rect: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, ms: 42 }));
      }, 40);
      return function off() {
        listeners[channel] = (listeners[channel] || []).filter(function (f) { return f !== cb; });
      };
    },
    call: function (channel, payload) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (channel === 'sys.stats') {
            resolve({
              cpu: 3 + Math.round(Math.random() * 9),
              memUsed: 19.4 * 1024 * 1024 * 1024,
              memTotal: 32 * 1024 * 1024 * 1024,
              battery: null,
              batteryReason: 'this machine reports no battery'
            });
          } else if (channel === 'net.probe') {
            resolve({ ok: false, reason: 'mock bridge: nothing is listening on 127.0.0.1:7373 from a file:// page' });
          } else {
            reject(new Error('unknown channel "' + channel + '" (mock bridge)'));
          }
        }, 30);
      });
    }
  };

  console.log('[mock] window.mantle installed (no real bridge found) — backdrop:', q.get('nobd') !== '1');
})();
