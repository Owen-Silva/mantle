/* mock-mantle.js - plays main for the welcome page when it is opened over file:// without Electron
 * (ui/welcome/welcome.page.test.js and its shots). The real preload.js defines window.mantle first, so
 * under Electron this file does nothing.
 *
 * Query: theme=light|dark (default light)
 *        mock=default | cornersoff | cornerschanged | cornersslow | donefail | restorefail | nobridge
 *        desk=1 paints a made-up desktop behind the clear window (shots only)
 * window.__mockCalls lists every call made; window.__mockClosed is true once main would close it.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var mode = q.get('mock') || 'default';
  var theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  if (q.get('desk') === '1') {
    // a stand-in for whatever desktop is behind the clear window: shots only, never the real page
    document.documentElement.style.background = theme === 'dark'
      ? 'linear-gradient(135deg, #1d2430 0%, #2a2f3a 45%, #3a3430 100%)'
      : 'linear-gradient(125deg, #c9d6ea 0%, #e6dcef 38%, #f1e3d6 62%, #cfe3dc 100%)';
  }
  if (mode === 'nobridge') return;
  var calls = window.__mockCalls = [];
  window.__mockClosed = false;
  var wait = function (ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); };
  var CORNERS = {
    default: { enabled: true, actions: { tl: 'taskview', tr: 'off', bl: 'off', br: 'desktop' } },
    cornersoff: { enabled: false, actions: { tl: 'taskview', tr: 'off', bl: 'off', br: 'desktop' } },
    cornerschanged: { enabled: true, actions: { tl: 'launcher', tr: 'lock', bl: 'off', br: 'desktop' } },
  };
  window.mantle = {
    call: function (name, args) {
      calls.push({ name: name, args: args || {} });
      switch (name) {
        case 'welcome.state': return Promise.resolve({ ok: true, via: 'first start', test: q.get('test') === '1', firstRun: true, reason: 'mock' });
        case 'corners.state':
          if (mode === 'cornersslow') return wait(1500, CORNERS.cornerschanged);
          return Promise.resolve(CORNERS[mode] || CORNERS.default);
        case 'welcome.done':
          if (mode === 'donefail') return Promise.resolve({ ok: false, recorded: false, reason: 'the first-run flag could not be saved (EACCES)' });
          window.__mockClosed = true;
          return Promise.resolve({ ok: true, recorded: true, flag: { state: 'done', how: args && args.how } });
        case 'shell.restore':
          if (mode === 'restorefail') return wait(50).then(function () { throw new Error('the sidecar did not answer in 4 s'); });
          return wait(50, { ok: true });
        default: return Promise.reject(new Error('Mantle has no command called "' + name + '"'));
      }
    },
    on: function () { return function () {}; },
  };
})();
