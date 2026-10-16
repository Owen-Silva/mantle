/* mock-mantle.js - a stand-in for preload's window.mantle, for the emoji page test and its screenshots
 * (lane mantle-emoji). Injected before the page's scripts (page.addInitScript). Nothing is typed:
 * emoji.insert is recorded and answers as main does in a --test run (a dry run). Drive it with
 *   window.__mock.emit('emoji.show', {...})   window.__mock.calls   window.__mock.answer[name] = fn
 */
(function () {
  'use strict';
  var subs = {};
  var mock = {
    calls: [],
    recents: [],
    answer: {},
    emit: function (name, payload) { (subs[name] || []).forEach(function (fn) { fn(payload); }); },
  };
  window.__mock = mock;
  window.mantle = {
    call: function (name, args) {
      mock.calls.push({ name: name, args: args || {} });
      if (mock.answer[name]) return Promise.resolve(mock.answer[name](args || {}));
      if (name === 'emoji.insert') {
        var r = [args.ch].concat(mock.recents.filter(function (x) { return x !== args.ch; })).slice(0, 32);
        mock.recents = r;
        return Promise.resolve({ typed: false, dryRun: true, recents: r });
      }
      return Promise.resolve({ ok: true });
    },
    on: function (name, fn) { (subs[name] = subs[name] || []).push(fn); return function () {}; },
  };
  // an init script can run before <html> exists: the default theme goes on as soon as it does
  var light = function () { if (!document.documentElement.getAttribute('data-theme')) document.documentElement.setAttribute('data-theme', 'light'); };
  if (document.documentElement) light();
  else new MutationObserver(function (_m, o) { if (document.documentElement) { o.disconnect(); light(); } }).observe(document, { childList: true });
})();
