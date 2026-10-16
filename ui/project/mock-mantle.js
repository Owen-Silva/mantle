/* mock-mantle.js - the Project pop-up opened as a plain file (page tests, pictures). Only when there is
 * no real bridge (window.mantle from preload.js). ?displays=1|2 ?current=extend ?ask=1 ?dark=1.
 * Records calls in window.__MOCK_CALLS__ and answers like lib/features/project.js does, with NOTHING real. */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  document.documentElement.setAttribute('data-theme', q.get('dark') === '1' ? 'dark' : 'light');
  document.addEventListener('DOMContentLoaded', function () { document.body.classList.add('mock'); if (q.get('dark') === '1') document.body.classList.add('dark'); });
  var two = q.get('displays') !== '1';
  var read = { current: q.get('current') || (two ? 'extend' : 'internal'), available: two ? ['internal', 'clone', 'extend', 'external'] : ['internal'],
               unavailable: two ? {} : { clone: 'there is no second display', extend: 'there is no second display', external: 'there is no second display' },
               connected: two ? 2 : 1, pending: null };
  var st = { on: true, read: read, phase: 'choose', sel: null, confirm: null, note: null, open: true, test: true };
  if (q.get('ask') === '1') { st.phase = 'confirm'; st.confirm = { token: 'mock', to: 'clone', from: 'extend', endsAt: Date.now() + 15000, dry: false }; }
  var subs = [];
  window.__MOCK_CALLS__ = [];
  function push() { var s = JSON.parse(JSON.stringify(st)); subs.forEach(function (f) { f(s); }); }
  window.__MOCK_PUSH__ = function (patch) { Object.assign(st, patch || {}); push(); };
  window.mantle = {
    mode: 'mock',
    on: function (ch, cb) { if (ch === 'project.view') { subs.push(cb); setTimeout(push, 10); } return function () {}; },
    call: function (ch, a) {
      window.__MOCK_CALLS__.push({ ch: ch, a: a || null });
      if (ch === 'project.move') { st.sel = a.to; return Promise.resolve({ ok: true, sel: st.sel }); }
      if (ch === 'project.pick') {
        if (a.mode === st.read.current) return Promise.resolve({ ok: true, changed: false });
        st.phase = 'confirm'; st.confirm = { token: 'mock', to: a.mode, from: st.read.current, endsAt: Date.now() + 15000, dry: true };
        setTimeout(push, 0); return Promise.resolve({ ok: true, dryRun: true });
      }
      if (ch === 'project.keep' || ch === 'project.revert') {
        var kept = ch === 'project.keep';
        st.phase = 'done'; st.note = kept ? 'Kept' : 'Put back'; st.confirm = null; setTimeout(push, 0);
        return Promise.resolve({ ok: true, kept: kept });
      }
      return Promise.resolve({ ok: true });
    },
  };
}());
