/* launcher.js — the renderer half of the launcher.
 *
 * Runs with contextIsolation on and sandbox on: there is no require, no
 * import, no Node here. `window.mantle` (lane B's preload) is the ONLY way out
 * of this page, and mock-mantle.js supplies a stand-in when this file is
 * opened straight from disk for a visual check.
 *
 * The standing rule behind most of the code below: nothing fails silently.
 * If the bridge is missing, if a source did not index, if a launch did not
 * happen, if the sidecar is down — the launcher SAYS so, in the launcher, in
 * plain words. A console.error is not a report; nobody has the console open
 * when they tap Win.
 */
(function () {
  'use strict';

  var els = {
    panel: document.getElementById('panel'),
    q: document.getElementById('q'),
    results: document.getElementById('results'),
    counts: document.getElementById('counts'),
    srcErrors: document.getElementById('srcErrors'),
    notice: document.getElementById('notice'),
  };

  var mantle = window.mantle;

  var rows = [];        // the items currently on screen
  var sel = 0;          // index of the selected row
  var sources = [];     // last { name, count, status, reason }[] from apps.index
  var searchSeq = 0;    // drops a slow response that arrived after a newer one
  var note = null;      // { id, text, ok } — the line printed under one row
  var hideTimer = null;

  /* ---- the bridge must exist -------------------------------------------- */
  if (!mantle || typeof mantle.call !== 'function') {
    els.results.textContent = '';
    var dead = document.createElement('div');
    dead.className = 'empty is-bad';
    dead.textContent = 'The Mantle bridge is missing: window.mantle was never injected, ' +
      'so nothing can be searched or opened. The launcher window was probably created without its preload script.';
    els.results.appendChild(dead);
    els.counts.textContent = 'not connected';
    return;
  }

  /* ---- glyphs for the rows with no bitmap -------------------------------
     Drawn inline rather than pulled from Segoe Fluent Icons: the icon font is
     not guaranteed on every build, and a missing glyph box in the icon column
     is exactly the kind of quiet breakage this project does not allow. */
  var GLYPH = {
    command: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3.2 3.2L3 10.4"/><path d="M8.4 11.4H13"/></svg>',
    setting: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"><path d="M2 4.5h12M2 11.5h12"/><circle cx="6" cy="4.5" r="1.9" fill="currentColor" stroke="none"/>' +
      '<circle cx="10.5" cy="11.5" r="1.9" fill="currentColor" stroke="none"/></svg>',
    url: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/>' +
      '<path d="M8 2c1.9 2 2.9 4 2.9 6S9.9 12 8 14C6.1 12 5.1 10 5.1 8S6.1 4 8 2z"/></svg>',
  };

  function iconCell(item) {
    var cell = document.createElement('div');
    cell.className = 'ico';
    if (item.icon) {
      var img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      // a data URL that does not decode must not leave an empty square
      img.addEventListener('error', function () {
        cell.textContent = (item.name || '?').trim().charAt(0) || '?';
        cell.classList.add('is-letter');
      });
      cell.appendChild(img);
      return cell;
    }
    if (GLYPH[item.kind]) {
      cell.innerHTML = GLYPH[item.kind];          // a constant string, never user text
      return cell;
    }
    cell.classList.add('is-letter');
    cell.textContent = (item.name || '?').trim().charAt(0) || '?';
    return cell;
  }

  /* ---- rendering --------------------------------------------------------- */

  function render() {
    els.results.textContent = '';

    if (!rows.length) {
      var blank = document.createElement('div');
      blank.className = 'empty';
      var typed = els.q.value.trim();
      blank.textContent = typed ? 'Nothing matches ‘' + typed + '’' : 'Nothing to show yet.';
      els.results.appendChild(blank);
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      var item = rows[i];
      var row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' is-sel' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      row.dataset.i = String(i);

      var main = document.createElement('div');
      main.className = 'row-main';
      main.appendChild(iconCell(item));

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name || '(unnamed)';
      main.appendChild(name);

      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = item.subtitle || '';
      main.appendChild(sub);

      row.appendChild(main);

      // the reason a launch did not happen sits under the row it belongs to
      if (note && note.id === item.id) {
        var why = document.createElement('div');
        why.className = 'why' + (note.ok ? ' is-ok' : '');
        why.textContent = note.text;
        row.appendChild(why);
      }
      els.results.appendChild(row);
    }

    var selEl = els.results.children[sel];
    if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
  }

  function renderFooter() {
    var parts = [];
    var lines = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i] || {};
      parts.push((s.name || '?') + ' ' + (typeof s.count === 'number' ? s.count : '?'));
      if (s.reason) {
        lines.push({ text: (s.name || '?') + ': ' + s.reason, bad: s.status !== 'ok' });
      }
    }
    els.counts.textContent = parts.length ? parts.join(' · ') : 'nothing indexed';

    els.srcErrors.textContent = '';
    for (var j = 0; j < lines.length; j++) {
      var div = document.createElement('div');
      div.className = lines[j].bad ? 'src-error' : 'src-note';
      div.textContent = lines[j].text;
      els.srcErrors.appendChild(div);
    }
  }

  /* The sidecar does the Win32 work, including shortcut icons. When it is not
     ok the rows still work — they just have letter tiles — so this is a notice
     and not an error: one line, the reason included, always visible. */
  function renderNotice(state) {
    var sc = state && state.sidecar;
    if (sc && sc.status && sc.status !== 'ok') {
      els.notice.hidden = false;
      els.notice.textContent = 'icons unavailable: ' + (sc.reason || 'the sidecar is ' + sc.status);
    } else {
      els.notice.hidden = true;
      els.notice.textContent = '';
    }
  }

  /* ---- talking to main --------------------------------------------------- */

  function showProblem(text) {
    rows = [];
    note = null;
    els.results.textContent = '';
    var bad = document.createElement('div');
    bad.className = 'empty is-bad';
    bad.textContent = text;
    els.results.appendChild(bad);
  }

  function refreshIndex(force) {
    return mantle.call('apps.index', { refresh: !!force }).then(function (res) {
      sources = (res && res.sources) || [];
      renderFooter();
    }, function (err) {
      sources = [];
      els.counts.textContent = 'index unavailable';
      els.srcErrors.textContent = '';
      var div = document.createElement('div');
      div.className = 'src-error';
      div.textContent = 'index: ' + reasonOf(err);
      els.srcErrors.appendChild(div);
    });
  }

  function reasonOf(err) {
    if (!err) return 'no reason given';
    if (typeof err === 'string') return err;
    return String(err.message || err);
  }

  var searchTimer = null;
  function queueSearch() {
    // 40ms: long enough that a fast typist does not fire a call per keystroke,
    // short enough that the list feels attached to the keyboard
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 40);
  }

  function runSearch() {
    var mine = ++searchSeq;
    var q = els.q.value;
    mantle.call('apps.search', { q: q }).then(function (res) {
      if (mine !== searchSeq) return;              // a newer query already answered
      rows = Array.isArray(res) ? res : (res && res.items) || [];
      sel = 0;
      note = null;
      render();
    }, function (err) {
      if (mine !== searchSeq) return;
      showProblem('The search failed: ' + reasonOf(err));
    });
  }

  function move(delta) {
    if (!rows.length) return;
    sel = (sel + delta + rows.length) % rows.length;   // wraps: 12 rows, one hand
    render();
  }

  function select(i) {
    if (i === sel || i < 0 || i >= rows.length) return;
    sel = i;
    render();
  }

  function activate() {
    var item = rows[sel];
    if (!item) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    mantle.call('apps.launch', { id: item.id }).then(function (res) {
      if (res && res.ok) {
        if (res.reason) {
          /* It opened, but not the way you asked (a plain PowerShell window
             because wt.exe is missing, say). Show the difference for a beat
             before the window goes, so the surprise is explained. */
          note = { id: item.id, text: res.reason, ok: true };
          render();
          hideTimer = setTimeout(function () { mantle.call('launcher.hide'); }, 1400);
        } else {
          mantle.call('launcher.hide');
        }
        return;
      }
      // it did not open: stay open and say why, under the row
      note = { id: item.id, text: (res && res.reason) || 'it did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the launch request failed: ' + reasonOf(err), ok: false };
      render();
    });
  }

  /* ---- input ------------------------------------------------------------- */

  els.q.addEventListener('input', queueSearch);
  // the focused underline is CSS (.slot:focus-within), not a class toggled here

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); mantle.call('launcher.hide'); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); activate(); return; }
    if (e.key === 'Home' && rows.length) { e.preventDefault(); select(0); return; }
    if (e.key === 'End' && rows.length) { e.preventDefault(); select(rows.length - 1); return; }
    // any other key belongs to the input, wherever focus drifted to
    if (document.activeElement !== els.q && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      els.q.focus();
    }
  });

  function rowIndexFrom(target) {
    var el = target && target.closest ? target.closest('.row') : null;
    return el ? Number(el.dataset.i) : -1;
  }
  els.results.addEventListener('mousemove', function (e) {
    var i = rowIndexFrom(e.target);
    if (i >= 0) select(i);
  });
  els.results.addEventListener('click', function (e) {
    var i = rowIndexFrom(e.target);
    if (i < 0) return;
    select(i);
    activate();
  });

  /* ---- events from main --------------------------------------------------- */

  if (typeof mantle.on === 'function') {
    mantle.on('launcher:visible', function (visible) {
      if (!visible) return;
      // shown: a clean slate every time, so the Win tap always behaves the same
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      els.q.value = '';
      note = null;
      refreshIndex(false);      // picks up icons that finished after the last open
      runSearch();
      els.q.focus();
      els.results.scrollTop = 0;
    });
    mantle.on('state', renderNotice);
  } else {
    // the bridge exists but cannot deliver events: say it rather than sit there
    els.notice.hidden = false;
    els.notice.textContent = 'live updates unavailable: this build of the bridge has no mantle.on(), ' +
      'so the launcher cannot tell when it is shown or when the sidecar changes.';
  }

  /* ---- boot ---------------------------------------------------------------- */
  refreshIndex(false);
  runSearch();
  els.q.focus();
})();
