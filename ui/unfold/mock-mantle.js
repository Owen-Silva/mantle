/* mock-mantle.js - a stand-in for the preload bridge, for the unfold page's harnesses only
 * (ui/unfold/shoot.js, ui/unfold/unfold.page.test.js; lane unfold-unlock, 2026-10-23).
 *
 * It is NOT loaded by index.html: a harness installs it before any page script with
 * page.addInitScript({ path }). It defines window.mantle only when it is absent, so it can never
 * shadow the real bridge.
 *
 *   window.mantle.call('unfold.page', msg)  recorded in window.__told as {msg, at: performance.now()}
 *   window.mantle.on('unfold.cmd', fn)      kept, so a harness can drive the page the way main does:
 *                                           window.__mockSend({op, seq, ...}) -> fn(cmd)
 *
 * Nothing here takes, keeps or sends a picture of a real screen: the harnesses draw their own. */
(function () {
  'use strict';
  if (window.mantle) return;
  var handlers = {};
  window.__told = [];
  window.mantle = {
    call: function (name, msg) {
      window.__told.push({ name: name, msg: msg, at: performance.now() });
      return Promise.resolve({ ok: true });
    },
    on: function (name, fn) { handlers[name] = fn; return function () { delete handlers[name]; }; },
  };
  window.__mockSend = function (cmd) {
    var fn = handlers['unfold.cmd'];
    return fn ? fn(cmd) : Promise.reject(new Error('the page did not listen for unfold.cmd'));
  };
})();
