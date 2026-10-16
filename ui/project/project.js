/* project.js - Win+P's pop-up page (lane qstiles, 2026-10-15). Draws what main says (project.view,
 * lib/features/project.js) through _project-core.js view(), and sends only ids back: project.move,
 * .pick, .keep, .revert, .close, .cast, .painted. It never changes a display itself.
 *
 * KEYS: Up/Down (and Left/Right) move, Home/End jump, Enter picks (or keeps, while asking), Esc closes
 * (or switches back, while asking: closing the question means no, as Windows' dialog). Win+P again is
 * the hook's, so main moves the selection and pushes it here.
 * THE FIRST PICTURE: two frames after the first project.view, the page says project.painted; main shows
 * the window then (it is drawn before it is seen) and logs the open's times (PERF R7). */
(function () {
  'use strict';
  var M = window.mantle || null, K = window.MantleProjectCore;
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), list = $('list'), hl = $('hl'), title = $('title'), note = $('note'), ask = $('ask'),
      askText = $('asktext'), drain = $('drain'), keep = $('keep'), revert = $('revert'), cast = $('cast'), count = $('count');
  var st = null, v = null, rows = {}, first = true, drainFor = null, busy = false;

  var ICON = {
    internal: '<rect x="3" y="4" width="11" height="8" rx="1.2" fill="currentColor"/><rect x="16" y="4" width="11" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".45"/>',
    clone: '<rect x="3" y="4" width="11" height="8" rx="1.2" fill="currentColor"/><rect x="16" y="4" width="11" height="8" rx="1.2" fill="currentColor"/><path d="M14.4 8h1.2" stroke="currentColor" stroke-width="1.2"/>',
    extend: '<rect x="3" y="4" width="24" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M15 4v8" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1.6 1.4"/>',
    external: '<rect x="3" y="4" width="11" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".45"/><rect x="16" y="4" width="11" height="8" rx="1.2" fill="currentColor"/>',
  };

  function call(ch, a) {
    if (!M || typeof M.call !== 'function') return Promise.reject(new Error('window.mantle is not present'));
    try { return Promise.resolve(M.call(ch, a)); } catch (e) { return Promise.reject(e); }
  }
  function said(r) { if (r && r.ok === false && r.reason) { showNote(r.reason, true); } }
  function showNote(t, warn) { note.hidden = !t; note.textContent = t || ''; note.classList.toggle('warn', !!warn); }

  K.MODES.forEach(function (m) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'row'; b.setAttribute('role', 'option'); b.dataset.mode = m.id;
    b.innerHTML = '<span class="ico"><svg viewBox="0 0 30 16" width="30" height="16" aria-hidden="true">' + ICON[m.id] + '</svg></span>' +
      '<span class="txt"><span class="lbl"></span><span class="why"></span></span><span class="now"></span>';
    b.querySelector('.lbl').textContent = m.label;
    b.addEventListener('mouseenter', function () { if (v && v.phase === 'choose' && b.getAttribute('aria-disabled') !== 'true') move(m.id); });
    b.addEventListener('click', function () { pick(m.id); });
    list.appendChild(b);
    rows[m.id] = b;
  });

  function render() {
    v = K.view(st, Date.now());
    var asking = v.phase === 'confirm' && !!v.confirm;
    card.classList.toggle('asking', asking);
    title.textContent = v.title;
    ask.hidden = !asking;
    var at = 0, i = 0;
    v.rows.forEach(function (r) {
      var b = rows[r.id];
      b.classList.toggle('current', r.current);
      b.setAttribute('aria-selected', String(r.sel));
      b.setAttribute('aria-disabled', String(r.disabled));
      b.querySelector('.now').textContent = r.current ? 'Now' : '';
      var why = b.querySelector('.why'); why.textContent = r.disabled ? r.why : ''; why.hidden = !r.disabled;
      b.title = r.disabled ? r.why : r.help;
      if (r.sel) at = i;
      i++;
    });
    // one plate that springs to the selected row (its own transition: a fast Win+P, P, P glides)
    var target = rows[v.sel];
    hl.style.transform = 'translateY(' + (target ? target.offsetTop : at * 46) + 'px)';
    hl.style.opacity = v.phase === 'choose' || v.phase === 'applying' ? '1' : '0';
    if (asking) {
      askText.textContent = v.confirm.text;
      count.hidden = false; count.textContent = v.left + ' s';
      // the hairline drains over the whole wait, once (a transition from now to the deadline)
      if (drainFor !== st.confirm.endsAt) {
        drainFor = st.confirm.endsAt;
        var ms = Math.max(0, st.confirm.endsAt - Date.now());
        drain.style.transition = 'none'; drain.style.transform = 'scaleX(' + Math.min(1, ms / K.KEEP_MS) + ')';
        requestAnimationFrame(function () { requestAnimationFrame(function () { drain.style.transition = 'transform ' + ms + 'ms linear'; drain.style.transform = 'scaleX(0)'; }); });
        keep.focus({ preventScroll: true });
      }
    } else { count.hidden = true; drainFor = null; }
    showNote(v.note, v.warn);
    cast.hidden = asking;
    if (v.phase === 'done') card.classList.remove('asking');
  }

  function move(to) {
    if (!v || v.phase !== 'choose' || !to || to === (st && st.sel)) return;
    st.sel = to; render();                                   // at once; main follows
    call('project.move', { to: to }).catch(function () {});
  }
  function step(n) { if (v && v.phase === 'choose') move(K.next(st.read, st.sel || v.sel, n)); }
  function pick(id) {
    if (busy || !v || v.phase !== 'choose') return;
    busy = true;
    call('project.pick', { mode: id }).then(function (r) { busy = false; said(r); }, function (e) { busy = false; showNote('The layout did not change: ' + (e && e.message || e), true); });
  }
  function finish(keepIt) {
    if (busy || !v || v.phase !== 'confirm') return;
    busy = true;
    call(keepIt ? 'project.keep' : 'project.revert').then(function (r) { busy = false; said(r); }, function () { busy = false; });
  }

  keep.addEventListener('click', function () { finish(true); });
  revert.addEventListener('click', function () { finish(false); });
  cast.addEventListener('click', function () { call('project.cast').then(said, function () {}); });

  document.addEventListener('keydown', function (e) {
    if (!v) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (v.phase === 'confirm') finish(false); else call('project.close').catch(function () {}); return; }
    if (v.phase === 'confirm') {
      if (k === 'Enter' && document.activeElement !== revert) { e.preventDefault(); finish(true); }
      return;
    }
    if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (k === 'Home') { e.preventDefault(); move(K.next(st.read, 'external', 1)); }   // the first pickable, from the top
    else if (k === 'End') { e.preventDefault(); move(K.next(st.read, 'internal', -1)); }
    else if (k === 'Enter' || k === ' ') { if (document.activeElement === cast) return; e.preventDefault(); pick(st.sel || v.sel); }
  });

  function take(s) {
    if (!s || typeof s !== 'object') return;
    st = s;
    if (!st.sel) st.sel = K.startSel(st.read);
    render();
    if (first) {
      first = false;
      var done = false, how = 'frames';
      var report = function () { if (done) return; done = true; card.classList.add('in'); call('project.painted', { how: how }).catch(function () {}); };
      requestAnimationFrame(function () { requestAnimationFrame(report); });
      setTimeout(function () { how = 'timer'; report(); }, 120);   // a hidden (--test) window may get no frames
    }
  }
  if (M && typeof M.on === 'function') M.on('project.view', take);
  window.__projectTake = take;     // the page test's door (mock-mantle.js drives it)
}());
