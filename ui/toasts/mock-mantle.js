/* mock-mantle.js - only when the page is opened on its own (no preload, so no window.mantle): a fake main
 * that answers every call and shows three sample banners, so the page can be looked at in a browser.
 * Inside Mantle (and in the page tests, which install their own fake first) it does nothing. */
(function () {
  'use strict';
  if (window.mantle) return;
  var on = {};
  window.mantle = {
    on: function (ch, fn) { (on[ch] = on[ch] || []).push(fn); return function () {}; },
    call: function (ch) {
      if (ch === 'toasts.ready') {
        setTimeout(function () {
          (on['toasts.show'] || []).forEach(function (f) {
            f({ banners: [
              { id: 1, app: 'Helm', title: 'Done in 14s', body: 'The build finished and every test passed.', opens: 'app' },
              { id: 2, app: 'Discord', title: 'Owen', body: 'are you on tonight? we need a fifth for ranked', opens: 'app' },
              { id: 3, app: 'Windows Security', title: 'Scan finished', body: 'No current threats.', opens: 'protocol' },
            ] });
          });
        }, 200);
      }
      return Promise.resolve({ ok: true });
    },
  };
})();
