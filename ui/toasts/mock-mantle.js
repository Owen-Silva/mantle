/* mock-mantle.js - only when the page is opened on its own (no preload, so no window.mantle): a fake main
 * that answers every call and shows three sample banners and one of Mantle's own (the updater's, with
 * its buttons: Update runs a pretend download, Later takes it away), so the page can be looked at in a
 * browser. Inside Mantle (and in the page tests, which install their own fake first) it does nothing. */
(function () {
  'use strict';
  if (window.mantle) return;
  var on = {};
  function emit(ch, p) { (on[ch] || []).forEach(function (f) { f(p); }); }
  var OWN = { id: -1, own: true, app: 'Mantle', title: 'Mantle v0.2.0 is out', body: 'You are on v0.1.0. Update downloads it, installs it and restarts Mantle.',
    detail: null, progress: null, tone: 'info', actions: [{ id: 'later', label: 'Later' }, { id: 'update', label: 'Update', primary: true }], sticky: true, opens: 'none' };
  function own(extra) { return Object.assign({}, OWN, extra); }
  function pretendUpdate() {
    var pct = 0;
    var t = setInterval(function () {
      pct += 7;
      if (pct < 100) { emit('toasts.update', { banner: own({ title: 'Updating Mantle', body: '', actions: [], progress: { text: 'Downloading v0.2.0...', pct: pct } }) }); return; }
      clearInterval(t);
      emit('toasts.update', { banner: own({ title: 'Updating Mantle', body: '', actions: [], progress: { text: 'Installing...', pct: null } }) });
      setTimeout(function () {
        emit('toasts.update', { banner: own({ title: 'Update failed: the install step stopped', body: 'Still on v0.1.0. Nothing was changed.', tone: 'error',
          detail: 'git merge --ff-only v0.1.1\nnpm install\nLog: <the log file>', actions: [{ id: 'dismiss', label: 'Close' }] }) });
      }, 2500);
    }, 300);
  }
  window.mantle = {
    on: function (ch, fn) { (on[ch] = on[ch] || []).push(fn); return function () {}; },
    call: function (ch, a) {
      if (ch === 'toasts.ready') {
        setTimeout(function () {
          emit('toasts.show', { banners: [
            { id: 1, app: 'Helm', title: 'Done in 14s', body: 'The build finished and every test passed.', opens: 'app' },
            { id: 2, app: 'Discord', title: 'Jordan', body: 'are you on tonight? we need a fifth for ranked', opens: 'app' },
            { id: 3, app: 'Windows Security', title: 'Scan finished', body: 'No current threats.', opens: 'protocol' },
            OWN,
          ] });
        }, 200);
      }
      if (ch === 'toasts.action') {
        if (a && a.action === 'update') { pretendUpdate(); return Promise.resolve({ ok: true, keep: true, reason: null }); }
        return Promise.resolve({ ok: true, keep: false, reason: null });
      }
      if (ch === 'toasts.copy') return Promise.resolve({ ok: false, reason: 'the page is open on its own, with no Mantle to copy through' });
      return Promise.resolve({ ok: true });
    },
  };
})();
