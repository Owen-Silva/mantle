/* clipboard.js — the Win+V panel: draws the history main hands it, and turns keys and clicks into
 * the feature's commands. Keyboard-first: the filter box holds the focus, and the list keys are
 * read before the box sees them (the key rules are in model.js keyAction).
 *
 * From main:  clipboard.show {list, arm}   clipboard.changed {list}   clipboard.notice {title, text}
 *             clipboard.keyboard {ok, text}   (the panel could not take the keyboard, and why)
 *             clipboard.hide
 * To main:    clipboard.paste {item}  clipboard.pin {item, pinned}  clipboard.delete {item}
 *             clipboard.clear  clipboard.close  clipboard.painted {count}
 *
 * Nothing here logs item content: errors go to the console as sentences about what failed.
 */
(function () {
  'use strict';
  var M = window.mantle;
  var CM = window.ClipModel;
  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list'), q = $('q'), foot = $('foot'), banner = $('banner'), count = $('count');
  var clearAll = $('clearAll'), filterBox = $('filterBox');

  var S = { list: null, arm: null, items: [], shown: [], sel: 0, armed: false, busy: false, noteTimer: 0 };

  var SVG_PIN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10 8.5 12.5 3.5 7.5 6 7.5 8.5 5Z"/><path d="M6 10 2.5 13.5"/></svg>';
  var SVG_X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4 12 12M12 4 4 12"/></svg>';
  var SVG_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4Z"/><path d="M9 1.5v3h3"/></svg>';
  var SVG_DIR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13Z"/></svg>';
  var SVG_PINMARK = '<svg class="pinmark" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10 8.5 12.5 3.5 7.5 6 7.5 8.5 5Z"/></svg>';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- drawing -----------------------------------------------------------------------------

  function render(keepId) {
    var list = S.list || {};
    S.items = list.items || [];
    var prevId = keepId !== undefined ? keepId : (S.shown[S.sel] || {}).id;
    S.shown = CM.filter(S.items, q.value);
    S.sel = CM.reselect(prevId, S.sel, S.shown);

    var n = S.items.length, pins = list.pinned || 0;
    count.textContent = n ? (n + (n === 1 ? ' item' : ' items') + (pins ? ', ' + pins + ' pinned' : '')) : '';
    clearAll.disabled = !(n - pins > 0);
    filterBox.classList.toggle('armed', S.armed && !q.value);
    filterBox.classList.toggle('typing', !!q.value);

    drawBanner(list);
    drawFoot();

    listEl.textContent = '';
    var now = Date.now();
    S.shown.forEach(function (it, i) { listEl.appendChild(row(it, i, now)); });
    document.body.classList.toggle('is-empty', S.shown.length === 0);
    if (!S.shown.length) drawEmpty(list);
    markSel(true);
  }

  function row(it, i, now) {
    var r = el('div', 'row kind-' + it.kind + (it.pinned ? ' pinned' : ''));
    r.id = 'row-' + it.id;
    r.setAttribute('role', 'option');
    r.dataset.i = String(i);
    var body = el('div', 'body');
    if (it.kind === 'image') {
      var box = el('div', 'img');
      if (it.thumb) {
        var img = el('img');
        img.alt = 'Picture, ' + it.w + ' by ' + it.h;
        img.src = it.thumb;
        box.appendChild(img);
      }
      body.appendChild(box);
    } else if (it.kind === 'files') {
      var fl = el('div', 'files');
      var files = it.files || [];
      files.slice(0, 3).forEach(function (f) {
        var line = el('div', 'file');
        line.innerHTML = /\.[A-Za-z0-9]{1,6}$/.test(f.name) ? SVG_FILE : SVG_DIR;
        line.appendChild(el('span', null, f.name));
        line.title = f.path || f.name;
        fl.appendChild(line);
      });
      var total = it.fileCount || files.length;
      if (total > 3) fl.appendChild(el('div', 'more', '+ ' + (total - 3) + ' more'));
      body.appendChild(fl);
    } else {
      var p = CM.previewLines(it.text, 3);
      var t = el('div', 'txt' + (p.blank ? ' blank' : ''), p.blank ? 'Only spaces or line breaks' : p.lines.join('\n'));
      body.appendChild(t);
    }
    var meta = el('div', 'meta');
    if (it.pinned) meta.innerHTML = SVG_PINMARK;
    meta.appendChild(document.createTextNode(CM.meta(it, now)));
    body.appendChild(meta);
    r.appendChild(body);

    var acts = el('div', 'acts');
    var pin = el('button', 'act pin');
    pin.type = 'button';
    pin.tabIndex = -1;
    pin.title = it.pinned ? 'Unpin (P)' : 'Pin: keep it after Clear all and restarts (P)';
    pin.setAttribute('aria-pressed', it.pinned ? 'true' : 'false');
    pin.innerHTML = SVG_PIN;
    pin.addEventListener('click', function (e) { e.stopPropagation(); act('pin', i); });
    var del = el('button', 'act del');
    del.type = 'button';
    del.tabIndex = -1;
    del.title = 'Delete (Del)';
    del.innerHTML = SVG_X;
    del.addEventListener('click', function (e) { e.stopPropagation(); act('delete', i); });
    acts.appendChild(pin);
    acts.appendChild(del);
    r.appendChild(acts);

    r.addEventListener('click', function () { S.sel = i; markSel(false); act('paste', i); });
    // mousemove, not mouseenter: a pointer that happens to rest where the panel opens must not
    // steal the selection from the keyboard.
    r.addEventListener('mousemove', function () { if (S.sel !== i) { S.sel = i; markSel(false); } });
    return r;
  }

  function markSel(scroll) {
    var rows = listEl.children;
    for (var k = 0; k < rows.length; k++) {
      var on = k === S.sel;
      rows[k].classList.toggle('sel', on);
      rows[k].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        q.setAttribute('aria-activedescendant', rows[k].id);
        if (scroll) rows[k].scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function drawBanner(list) {
    var msg = null, info = false;
    if (list.mode === 'off' && list.error) msg = 'Not recording new copies: ' + list.error + '.';
    else if (list.mode === 'off' && S.list && S.list.stopped) msg = 'Clipboard history is switched off in the Mantle tray menu.';
    else if (list.mode === 'observe') { msg = 'Test mode: new copies are counted, not kept.'; info = true; }
    if (!msg && list.pinsError) msg = 'Pinned items: ' + list.pinsError + '.';
    if (!msg && S.arm && S.arm.elevated && !S.arm.selfElevated) {
      msg = 'The window you came from runs as administrator. Windows does not let Mantle type into it: choose an item, then press Ctrl+V.';
    }
    if (!msg && S.arm && S.arm.error) msg = S.arm.error;
    // The LAST copy was not kept: say why (it clears itself with the next copy that is kept).
    var last = list.stats && list.stats.recent && list.stats.recent[0];
    if (!msg && last && last.result === 'skipped' && SKIP_WORDS[last.reason]) {
      msg = 'Your last copy is not here: ' + SKIP_WORDS[last.reason] + '.';
      info = last.reason === 'private';
    }
    banner.textContent = msg || '';
    banner.classList.toggle('on', !!msg);
    banner.classList.toggle('info', !!msg && info);
  }

  var SKIP_WORDS = {
    private: 'the app that copied it marked it private (password managers do), so Mantle never keeps it',
    busy: 'another app was holding the clipboard when it changed',
    tooLarge: 'it is larger than the 4 MB an item can be',
    unreadableImage: 'its picture could not be read',
    unsupported: 'it holds no text, picture or files that Mantle can keep',
    error: 'it could not be read',
  };

  function drawEmpty(list) {
    var t, x;
    if (S.items.length && q.value) {
      t = 'Nothing matches “' + q.value + '”';
      x = 'Backspace edits the filter.';
    } else if (list.loadError) {
      t = 'The clipboard history could not be read';
      x = list.loadError;
    } else {
      t = 'Nothing copied yet';
      x = 'Copy text, a picture or files and it shows up here. Mantle keeps this history in memory only; pinned items are saved, encrypted.';
    }
    $('emptyTitle').textContent = t;
    $('emptyText').textContent = x;
  }

  function drawFoot() {
    var pinKey = (q.value || S.armed) ? 'Ctrl+P' : 'P';
    var keys = [['↑↓', 'choose'], ['Enter', 'paste'], [pinKey, 'pin'], ['Del', 'delete'], ['Esc', 'close']];
    foot.textContent = '';
    keys.forEach(function (k) {
      var s = el('span');
      s.appendChild(el('b', null, k[0]));
      s.appendChild(document.createTextNode(k[1]));
      foot.appendChild(s);
    });
  }

  // ---- actions -----------------------------------------------------------------------------

  function act(what, i) {
    var it = S.shown[i != null ? i : S.sel];
    if (what === 'close') return call('clipboard.close', {});
    if (what === 'clear') return call('clipboard.clear', {}).then(apply);
    if (!it) return Promise.resolve();
    if (what === 'paste') {
      if (S.busy) return Promise.resolve();
      S.busy = true;
      return call('clipboard.paste', { item: it.id }).then(function () { S.busy = false; }, function () { S.busy = false; });
    }
    if (what === 'pin') return call('clipboard.pin', { item: it.id, pinned: !it.pinned }).then(apply);
    if (what === 'delete') {
      // the selection stays at the same index, so Del Del Del walks down the list
      return call('clipboard.delete', { item: it.id }).then(function (res) { apply(res, null); });
    }
    return Promise.resolve();
  }

  function apply(list, keepId) {
    if (list && list.items) { S.list = list; render(keepId); }
  }

  /** Every call's failure is SHOWN, in the notice, with main's own sentence. */
  function call(name, args) {
    return M.call(name, args).catch(function (err) {
      notice({ title: 'That did not work', text: err && err.message ? err.message : String(err) });
      return null;
    });
  }

  function notice(p) {
    $('noteTitle').textContent = p.title || '';
    $('noteText').textContent = p.text || '';
    document.body.classList.add('noting');
    clearTimeout(S.noteTimer);
    S.noteTimer = setTimeout(function () { document.body.classList.remove('noting'); }, p.ms || 5000);
  }

  // ---- keys --------------------------------------------------------------------------------

  document.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    var a = CM.keyAction(e, { query: q.value, filterArmed: S.armed, selStart: q.selectionStart, selEnd: q.selectionEnd });
    if (!a) return;
    e.preventDefault();
    if (document.body.classList.contains('noting') && a !== 'close') document.body.classList.remove('noting');
    if (a === 'arm-filter') { S.armed = true; render(); return; }
    if (a === 'up' || a === 'down' || a === 'pageup' || a === 'pagedown' || a === 'home' || a === 'end') {
      S.sel = CM.moveSel(S.sel, a, S.shown.length, 4);
      markSel(true);
      return;
    }
    act(a);
  }, true);

  q.addEventListener('input', function () {
    if (!q.value) S.armed = false;
    render(null);
    S.sel = S.shown.length ? 0 : -1;
    markSel(true);
  });
  q.addEventListener('blur', function () { setTimeout(function () { if (document.hasFocus()) q.focus(); }, 0); });
  clearAll.addEventListener('click', function () { act('clear'); q.focus(); });

  // ---- main's side -------------------------------------------------------------------------

  M.on('clipboard.show', function (p) {
    p = p || {};
    clearTimeout(S.noteTimer);
    document.body.classList.remove('noting');
    S.list = p.list || { items: [], loadError: p.error || null };
    S.arm = p.arm || null;
    S.armed = false;
    S.busy = false;
    q.value = '';
    S.sel = 0;
    render(null);
    S.sel = S.shown.length ? 0 : -1;
    markSel(true);
    listEl.scrollTop = 0;
    q.focus();
    if (p.notice) notice(p.notice);
    var report = function () {
      M.call('clipboard.painted', { count: S.shown.length, vw: window.innerWidth, vh: window.innerHeight }).catch(function () {});
    };
    // A HIDDEN window runs no animation frames at all (measured in the --test run, 2026-09-24:
    // the second Win+V waited out main's whole 300 ms cap), and main only shows it after this
    // report. So hidden = the DOM is final, report now; visible = two frames, the one with this
    // list in it produced and not just scheduled.
    var ready = function () {
      if (document.visibilityState !== 'visible') setTimeout(report, 0);
      else requestAnimationFrame(function () { requestAnimationFrame(report); });
    };
    // Dark: main shows the window only after the report, so the picture of what is behind it is
    // taken (and baked) first and the panel never opens as the thick fallback face. Light: at once.
    var bd = window.MantleHudBackdrop;
    if (bd && document.documentElement.getAttribute('data-theme') === 'dark') bd.request('opened').then(ready, ready);
    else ready();
  });

  M.on('clipboard.changed', function (p) { if (p && p.list) apply(p.list); });
  M.on('clipboard.notice', function (p) {
    if (!p) return;
    notice(p);
    // a notice brings the panel up without the opening path: one picture for it too (dark only)
    if (window.MantleHudBackdrop && document.visibilityState !== 'visible') window.MantleHudBackdrop.request('notice', { hold: true });
  });
  M.on('clipboard.hide', function () { q.value = ''; S.armed = false; S.kbNote = false; document.body.classList.remove('noting'); });
  /* main could not give the panel the keyboard (lib/surface-gate.js): say so until it has it (a
     click in the panel) or it closes. Never silent: the keys were going to the app behind. */
  M.on('clipboard.keyboard', function (p) {
    if (p && !p.ok) {
      var t = String(p.text || 'Click here to type.').replace(/^No keyboard:\s*/, '');
      S.kbNote = true;
      notice({ title: 'No keyboard', text: t.charAt(0).toUpperCase() + t.slice(1), ms: 10 * 60 * 1000 });
    } else if (S.kbNote) {
      S.kbNote = false;
      document.body.classList.remove('noting');
    }
  });

  window.__clip = S;   // the mock harness and shoot.js read the page's state from here
}());
