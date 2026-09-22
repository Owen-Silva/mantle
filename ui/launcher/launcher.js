/* launcher.js — the renderer half of the launcher.
 *
 * Runs with contextIsolation on and sandbox on: there is no require, no
 * import, no Node here. `window.mantle` (lane B's preload) is the ONLY way out
 * of this page, and mock-mantle.js supplies a stand-in when this file is
 * opened straight from disk for a visual check.
 *
 * THE THEME IS THE TASKBAR'S (Owen, 2026-09-21): "everything that we build for this wrapper,
 * their UI needs to be this exact same theme as the taskbar". Two of the things that makes true
 * live in this file, because the bar's equivalents live in bar.js:
 *
 *  - THE BACKDROP. The glass is a live picture of the screen behind this window, blurred in CSS.
 *    Main sends 'launcher.backdrop' {png, w, h, rect, ms} once just before the window is shown and
 *    then about four times a second while it is up; the ONLY per-frame work here is swapping the
 *    <img> src — no layout, no reflow, one composited layer repainted. body.no-backdrop is the
 *    honest fallback (a thicker tint) and is on at boot, off from the first frame, and back on the
 *    moment the window is hidden: the picture is of a screen that is about to be wrong, and
 *    showing it again on the next open would flash a stale photograph of the desktop. A payload
 *    with no data: URL, or a State piece backdrop.launcher.ok === false, says so in the footer —
 *    "no blur: <reason>" — rather than quietly falling back to a flat pane.
 *
 *  - THE ENTER. Main shows this window and hides it instantly, so there is exactly one animation:
 *    on visibilitychange → visible, body.up lets launcher.css run the panel in over 320ms. The
 *    class comes off on hidden so the next open animates again. Nothing runs at rest.
 *
 * The standing rule behind most of the code below: nothing fails silently.
 * If the bridge is missing, if a source did not index, if a launch did not
 * happen, if the sidecar is down, if there is no blur — the launcher SAYS so,
 * in the launcher, in plain words. A console.error is not a report; nobody has
 * the console open when they tap Win.
 */
(function () {
  'use strict';

  var els = {
    panel: document.getElementById('panel'),
    bdrop: document.querySelector('.bdrop'),
    backdrop: document.getElementById('backdrop'),
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
  var indexError = '';    // why apps.index itself failed, if it did
  var backdropNote = '';  // "no blur: …" — why there is nothing blurred under the tint

  /* ---- shown / hidden, and the one animation ----------------------------
     Electron fires visibilitychange on window show and hide, which is the only signal this page
     needs: main never animates the window itself. Defined above the bridge check on purpose —
     the panel boots at opacity 0, so a page that cannot reach the bridge must still be able to
     put itself on screen to say so. */
  function panelUp() {
    /* on the NEXT frame: the first paint has to happen in the down state or there is nothing for
       the transition to run from (a class added in the same frame as the first paint just snaps). */
    requestAnimationFrame(function () { document.body.classList.add('up'); });
  }
  function panelDown() {
    document.body.classList.remove('up');
    clearBackdrop();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') panelDown();
    else panelUp();
  });
  // opened in a window that is already on screen (a browser, --test): animate it in now
  if (document.visibilityState !== 'hidden') panelUp();

  /* ---- the backdrop ------------------------------------------------------ */

  var haveBackdrop = false;

  /* The two nodes are in index.html, so this can only be false if someone edits the markup out —
     in which case say it, rather than throw on every show and leave a mystery behind. */
  function bdropNodes() {
    if (els.bdrop && els.backdrop) return true;
    noBlur('this page has no .bdrop wrapper with an <img id="backdrop"> in it, so there is nowhere to put the picture');
    return false;
  }

  function setBackdrop(p) {
    if (!bdropNodes()) return;
    if (!p || typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:') {
      noBlur('launcher.backdrop arrived without a png data URL' + (p && p.reason ? ': ' + p.reason : ''));
      return;
    }
    if (backdropNote) { backdropNote = ''; renderFooter(); }
    els.backdrop.src = p.png;                    // the ONLY per-frame work: a src swap
    if (!haveBackdrop) {
      haveBackdrop = true;
      document.body.classList.remove('no-backdrop');
      els.bdrop.classList.add('on');             // 150ms fade, once, on the first frame
    }
  }

  function clearBackdrop() {
    if (!els.bdrop || !els.backdrop) return;     // already reported by bdropNodes()
    haveBackdrop = false;
    els.bdrop.classList.remove('on');
    /* removeAttribute, never src='': an empty src re-requests the PAGE in some engines. With no
       src at all the <img> draws nothing, which is what a hidden launcher should hold. */
    els.backdrop.removeAttribute('src');
    document.body.classList.add('no-backdrop');
  }

  function noBlur(reason) {
    var text = 'no blur: ' + (reason || 'no reason given');
    if (backdropNote === text) return;
    backdropNote = text;
    renderFooter();
  }

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

  /* One place builds this strip, because three things write to it: the per-source reasons, the
     index call's own failure, and the backdrop. Anything that appends to #srcErrors by hand gets
     wiped by the next render, which is how a reason quietly disappears. */
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
    els.counts.textContent = indexError ? 'index unavailable'
      : (parts.length ? parts.join(' · ') : 'nothing indexed');
    if (indexError) lines.unshift({ text: 'index: ' + indexError, bad: true });
    if (backdropNote) lines.push({ text: backdropNote, bad: true });

    els.srcErrors.textContent = '';
    for (var j = 0; j < lines.length; j++) {
      var div = document.createElement('div');
      div.className = lines[j].bad ? 'src-error' : 'src-note';
      div.textContent = lines[j].text;
      els.srcErrors.appendChild(div);
    }
  }

  /* The shell's own health report, as far as the launcher is concerned.
     The sidecar does the Win32 work, including shortcut icons. When it is not
     ok the rows still work — they just have letter tiles — so this is a notice
     and not an error: one line, the reason included, always visible.
     backdrop.launcher {on, ok, ms, reason} is main's report about the picture behind this window.
     ONLY ok === false is worth a line: `on:false` with ok:true is main saying it is not capturing
     right now (the window is hidden), which is normal and not a fault. */
  function applyState(state) {
    var sc = state && state.sidecar;
    if (sc && sc.status && sc.status !== 'ok') {
      els.notice.hidden = false;
      els.notice.textContent = 'icons unavailable: ' + (sc.reason || 'the sidecar is ' + sc.status);
    } else {
      els.notice.hidden = true;
      els.notice.textContent = '';
    }

    var bd = state && state.backdrop && state.backdrop.launcher;
    if (bd && bd.ok === false) {
      noBlur(bd.reason || 'main reported the launcher backdrop is not ok and gave no reason');
    } else if (bd && bd.ok === true && backdropNote) {
      backdropNote = '';
      renderFooter();
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
      indexError = '';
      renderFooter();
    }, function (err) {
      sources = [];
      indexError = reasonOf(err);
      renderFooter();
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
      if (!visible) { panelDown(); return; }
      // shown: a clean slate every time, so the Win tap always behaves the same
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      els.q.value = '';
      note = null;
      refreshIndex(false);      // picks up icons that finished after the last open
      runSearch();
      els.q.focus();
      els.results.scrollTop = 0;
      /* belt to visibilitychange's braces: this event is main saying the window IS on screen, and
         a panel that boots at opacity 0 may not depend on a single signal to become visible. */
      panelUp();
    });
    mantle.on('state', applyState);
    /* the picture behind this window: ~4 a second while it is up, one frame just before it is
       shown. setBackdrop swaps the <img> src and nothing else. */
    mantle.on('launcher.backdrop', setBackdrop);
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
