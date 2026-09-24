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
    hint: document.getElementById('hint'),
  };

  var mantle = window.mantle;

  var rows = [];        // the items currently on screen: appRows and fileRows, merged by score
  var sel = 0;          // index of the selected row
  var appRows = [];     // the last apps.search answer (apps, commands, settings, power, a URL)
  var userMoved = false; // the selection was moved by hand since the last query, so keep it

  /* FILE ROWS. They come from the Windows Search index through the sidecar (launcher.files), on
     their own debounce, after the app rows: an index query is 50-300 ms on this machine where
     apps.search is a few, so the app rows never wait for them. They slot in by score - the same
     scale apps.search uses, with files capped below any app whose name starts with the query -
     and ties go to the app. */
  var fileRows = [];    // the last answered file rows
  var fileQ = '';       // the query they answered, lowercased
  var fileSeq = 0;      // drops an answer that arrived after a newer query
  var fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
  var fileTimer = null;
  var filePending = false; // a file query is due or on its way for what is typed now
  var FILE_DEBOUNCE_MS = 150;
  var FILE_MIN = 2;     // one letter matches half the disk (1.3 s for "a", measured)

  /* ASK FIRST. Restart, Shut down and Sign out carry item.confirm ("Press Enter again to …").
     The first Enter arms the row; a second Enter on the SAME row within ARM_MS sends it. Moving
     off the row, typing, Esc, hiding the launcher or the timeout all disarm it. A held Enter
     cannot confirm (auto-repeat is ignored, and nothing confirms within ARM_MIN_MS of arming). */
  var armed = null;     // { id, at, timer }
  var ARM_MS = 5000;
  var ARM_MIN_MS = 250;
  var sources = [];     // last { name, count, status, reason }[] from apps.index
  var searchSeq = 0;    // drops a slow response that arrived after a newer one
  var note = null;      // { id, text, ok } — the line printed under one row
  var hideTimer = null;
  var indexError = '';    // why apps.index itself failed, if it did
  var backdropNote = '';  // "no blur: …" — why there is nothing blurred under the tint
  /* WIN+S (2026-09-24). The rows are laid out in labelled groups by groups.js (Calculator, Apps,
     Commands, Settings, Power, Files, then "Search the web" last); rows is still the ONE flat list
     the arrow keys walk, in on-screen order. calc.js answers arithmetic on every keystroke with no
     round trip. Both are plain scripts loaded before this one; a page without them says so. */
  var Calc = window.MantleCalc;
  var Groups = window.MantleGroups;
  var view = { groups: [], flat: [] };
  var mode = 'apps';          // 'search' when Win+S opened the launcher (placeholder, empty state)
  var pendingOpen = null;     // a launcher.open {mode, query} waiting for the window to be shown
  var PLACEHOLDER = {
    apps: 'Apps, files, settings, commands, or a URL',
    search: 'Search apps, files, settings and the web',
  };

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
    disarm();       // an armed Shut down must not still be armed the next time the launcher opens
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
    // power and session rows carry item.glyph, one per action, so Lock never looks like Shut down
    lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/>' +
      '<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
    sleep: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z"/></svg>',
    hibernate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 9.8A5 5 0 1 1 6.2 3.5a4 4 0 0 0 6.3 6.3z"/>' +
      '<path d="M3 14.5h10"/></svg>',
    restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M11.8 1.8v2.8H9"/></svg>',
    power: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v5.5"/><path d="M4.6 4.2a5 5 0 1 0 6.8 0"/></svg>',
    signout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h2.5"/>' +
      '<path d="M10 5l3 3-3 3"/><path d="M13 8H6.5"/></svg>',
    calc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.8" width="10" height="12.4" rx="1.6"/>' +
      '<path d="M5.5 4.8h5"/><path d="M5.6 8.2h.01M8 8.2h.01M10.4 8.2h.01M5.6 11h.01M8 11h.01M10.4 11h.01"/></svg>',
    web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8H4.5A1.5 1.5 0 0 0 3 3.3v9.4a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.8z"/>' +
      '<path d="M9 1.8v4h4"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.3A1.3 1.3 0 0 1 3.1 3h3l1.5 1.7h5.3a1.3 1.3 0 0 1 1.3 1.3v5.7A1.3 1.3 0 0 1 12.9 13H3.1a1.3 1.3 0 0 1-1.3-1.3z"/></svg>',
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
    var glyph = GLYPH[item.glyph] || GLYPH[item.kind];
    if (glyph) {
      cell.innerHTML = glyph;                     // a constant string, never user text
      return cell;
    }
    cell.classList.add('is-letter');
    cell.textContent = (item.name || '?').trim().charAt(0) || '?';
    return cell;
  }

  /* ---- rendering --------------------------------------------------------- */

  function render() {
    els.results.textContent = '';

    renderHint();

    if (!rows.length) {
      var blank = document.createElement('div');
      blank.className = 'empty';
      var typed = els.q.value.trim();
      blank.textContent = !typed ? (mode === 'search' ? 'Type to search apps, files, settings and the web.' : 'Nothing to show yet.')
        : filePending ? 'Nothing matches ‘' + typed + '’ yet. Searching your files…'
        : 'Nothing matches ‘' + typed + '’';
      els.results.appendChild(blank);
      return;
    }

    var at = 0;
    for (var g = 0; g < view.groups.length; g++) {
      var grp = view.groups[g];
      var head = document.createElement('div');
      head.className = 'grp';
      head.setAttribute('role', 'presentation');
      head.textContent = grp.label;
      els.results.appendChild(head);
      for (var r = 0; r < grp.rows.length; r++, at++) els.results.appendChild(rowEl(grp.rows[r], at));
      if (grp.status) {
        // what the Files group is doing, or why it has nothing: never a selectable row
        var st = document.createElement('div');
        st.className = 'grp-status is-' + grp.status.kind;
        st.setAttribute('role', 'status');
        st.textContent = grp.status.text;
        els.results.appendChild(st);
      }
    }

    var selEl = els.results.querySelector('.row.is-sel');
    if (selEl && selEl.scrollIntoView) {
      // the first row of a group brings its header into view with it
      var prev = selEl.previousElementSibling;
      if (prev && prev.classList.contains('grp') && prev.scrollIntoView) prev.scrollIntoView({ block: 'nearest' });
      selEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function rowEl(item, i) {
    {
      var isArmed = !!(armed && armed.id === item.id);
      var row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' is-sel' : '') + (isArmed ? ' is-armed' : '') +
        (item.kind === 'calc' ? ' is-calc' : '') + (item.bad ? ' is-bad' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      row.dataset.i = String(i);
      row.dataset.kind = item.kind || '';      // for the --test self-check (lib/features/_search-selftest.js)
      // a file row's subtitle is its folder, cut short; the whole path is one hover away
      if (item.kind === 'file') row.title = item.path || '';

      var main = document.createElement('div');
      main.className = 'row-main';
      main.appendChild(iconCell(item));

      var name = document.createElement('div');
      name.className = 'name';
      // armed: the row itself says what the next Enter does, in the place the eye already is
      name.textContent = isArmed ? item.confirm : (item.name || '(unnamed)');
      main.appendChild(name);

      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = isArmed ? 'Esc cancels' : (item.subtitle || '');
      main.appendChild(sub);

      if (isArmed) {
        /* the time left, as a hairline that runs out: a CSS animation over ARM_MS, started when
           this node is created, so nothing ticks in script while the row waits */
        var bar = document.createElement('div');
        bar.className = 'arm-bar';
        bar.style.animationDuration = ARM_MS + 'ms';
        bar.style.animationDelay = -(Date.now() - armed.at) + 'ms';
        main.appendChild(bar);
      }

      row.appendChild(main);

      // the reason a launch did not happen sits under the row it belongs to
      if (note && note.id === item.id) {
        var why = document.createElement('div');
        why.className = 'why' + (note.ok ? ' is-ok' : '');
        why.textContent = note.text;
        row.appendChild(why);
      }
      return row;
    }
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
    /* The file search is not an indexed source of ours - Windows keeps that index - so it reports
       per query: how many rows and how long the index took, or why there are none. */
    if (fileState.status === 'ok') parts.push('files ' + fileState.n + ' in ' + fileState.ms + ' ms');
    else if (fileState.status === 'error') parts.push('files unavailable');
    // (the index's reason itself - stopped service, unindexed profile - is the Files group's own
    // status line since Win+S, right where the missing rows would be; not repeated down here)

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

  /* What Enter does right now, in the footer: it changes on an armed row and on a file row
     (the only rows with a second action), so the key that does it is never a secret. */
  function renderHint() {
    if (!els.hint) return;
    var item = rows[sel];
    /* One line in a 680px footer beside the counts: with more than one group, "Tab next group"
       takes the place of "Esc closes" (Esc is the one key everybody already tries). */
    var tab = view.groups.length > 1;
    var tail = tab ? ' · Tab next group' : ' · Esc closes';
    var text = 'Enter opens' + tail;
    if (armed && item && armed.id === item.id) text = 'Enter again to confirm · Esc cancels';
    else if (item && item.kind === 'file') text = 'Enter opens · Ctrl+Enter shows in folder' + (tab ? ' · Tab next group' : '');
    else if (item && item.kind === 'calc') text = (item.bad ? 'No answer to copy' : 'Enter copies the answer') + tail;
    else if (item && item.kind === 'web') text = 'Enter searches the web' + tail;
    if (els.hint.textContent !== text) els.hint.textContent = text;
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
    // 12ms (was 40): Win+S asked for apps/settings/calc on screen in ~50 ms, and MEASURED in a
    // --test Mantle on 2026-09-24 the 40ms debounce put input -> row at 48-77 ms, while the
    // search itself is ~0.3 ms (lib/launcher-search.test.js) plus one IPC hop. 12ms still folds
    // a burst of keys (auto-repeat, a paste) into one call.
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 12);
  }

  function runSearch() {
    var mine = ++searchSeq;
    var q = els.q.value;
    mantle.call('apps.search', { q: q }).then(function (res) {
      if (mine !== searchSeq) return;              // a newer query already answered
      appRows = Array.isArray(res) ? res : (res && res.items) || [];
      userMoved = false;
      note = null;
      mergeRows();
    }, function (err) {
      if (mine !== searchSeq) return;
      showProblem('The search failed: ' + reasonOf(err));
    });
  }

  /* ---- file rows ----------------------------------------------------------- */

  /* A file query only for something that could be a file name: two letters or more, and NOT
     arithmetic - "2*(3+4)" wants its answer, and a "No files match" under it is noise (and a
     query with % in it is the one LIKE cannot run, see sidecar/SearchIndex.cs). */
  function wantsFiles(q) {
    if (q.length < FILE_MIN) return false;
    try { if (Calc && Calc.evaluate(q)) return false; } catch (e) { /* the calc row reports its own failure */ }
    return true;
  }

  function queueFiles() {
    if (fileTimer) clearTimeout(fileTimer);
    filePending = wantsFiles(els.q.value.trim());
    fileTimer = setTimeout(runFiles, FILE_DEBOUNCE_MS);
  }

  function runFiles() {
    fileTimer = null;
    var q = els.q.value.trim();
    var mine = ++fileSeq;
    if (!wantsFiles(q)) {
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
      renderFooter();
      mergeRows();
      return;
    }
    // fileState keeps the LAST answer's line in the footer until this one lands: a count that
    // blinks out on every keystroke would be noise, not news
    callPreferring('search.files', 'launcher.files', { q: q }).then(function (res) {
      if (mine !== fileSeq) return;                // a newer query is on its way
      filePending = false;
      if (res && res.superseded) { mergeRows(); return; }   // nothing newer is coming from us: no rows
      if (res && res.ok) {
        fileRows = Array.isArray(res.items) ? res.items : [];
        fileQ = q.toLowerCase();
        fileState = { status: 'ok', reason: res.reason || '', ms: res.ms || 0, n: fileRows.length };
      } else {
        fileRows = []; fileQ = '';
        fileState = { status: 'error', reason: (res && res.reason) || 'the file search failed and gave no reason', ms: 0, n: 0 };
      }
      renderFooter();
      mergeRows();
    }, function (err) {
      if (mine !== fileSeq) return;
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'error', reason: 'the file search request failed: ' + reasonOf(err), ms: 0, n: 0 };
      renderFooter();
      mergeRows();
    });
  }

  /* While the next answer is on its way, the last one's rows stay if their names still match
     what is typed now: typing "repo" after "rep" narrows the list instead of blanking it for
     the 150 ms debounce plus the query. */
  function stillMatches(name, q) {
    var n = String(name || '').toLowerCase();
    if (n.indexOf(q) === 0) return true;
    var words = n.split(/[^a-z0-9]+/);
    var terms = q.split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return false;
    return terms.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0; }); });
  }

  /* appRows + fileRows + the calculator -> view (groups.js) -> rows, the flat on-screen order.
     A file row from the last answer stays while its name still matches what is typed (typing
     "repo" after "rep" narrows the list instead of blanking it). The selection follows its ROW
     when the person has moved it by hand; otherwise it stays on the first row. */
  function mergeRows() {
    var typed = els.q.value;
    var q = typed.trim().toLowerCase();
    var keepId = userMoved && rows[sel] ? rows[sel].id : null;
    var files = q.length >= FILE_MIN
      ? fileRows.filter(function (f) { return fileQ === q || stillMatches(f.name, q); })
      : [];
    var calc = null;
    try { calc = Calc ? Calc.evaluate(typed) : null; } catch (e) { calc = { ok: false, expr: typed.trim(), reason: 'the calculator failed: ' + reasonOf(e) }; }
    if (!Groups) {
      showProblem('ui/launcher/groups.js did not load, so the results cannot be laid out (check index.html loads it before launcher.js).');
      return;
    }
    view = Groups.build({ q: typed, appRows: appRows, fileRows: files, fileState: fileState, filePending: filePending, calc: calc });
    rows = view.flat;
    sel = 0;
    if (keepId) {
      for (var i = 0; i < rows.length; i++) if (rows[i].id === keepId) { sel = i; break; }
    }
    if (armed && !rows.some(function (r) { return r.id === armed.id; })) disarm();
    render();
  }

  /* A Win+S feature command when this Mantle has it (lib/features/search.js), otherwise main's
     original one. ONLY "there is no such command" falls back: any other failure is the answer. */
  function callPreferring(name, fallback, args) {
    return mantle.call(name, args).then(null, function (err) {
      if (/no command called|no "/.test(reasonOf(err))) return mantle.call(fallback, args);
      throw err;
    });
  }

  /* ---- ask first ------------------------------------------------------------ */

  function arm(item) {
    disarm();
    armed = { id: item.id, at: Date.now(), timer: setTimeout(function () { disarm(); render(); }, ARM_MS) };
    render();
  }

  function disarm() {
    if (!armed) return false;
    clearTimeout(armed.timer);
    armed = null;
    return true;
  }

  function move(delta) {
    if (!rows.length) return;
    sel = (sel + delta + rows.length) % rows.length;   // wraps: 12 rows, one hand
    userMoved = true;
    if (armed && rows[sel].id !== armed.id) disarm();
    render();
  }

  function select(i) {
    if (i === sel || i < 0 || i >= rows.length) return;
    sel = i;
    userMoved = true;
    if (armed && rows[sel].id !== armed.id) disarm();
    render();
  }

  /* Power rows: the first Enter on one that asks first arms it; the second sends it. Lock and
     Sleep go straight through. A dry run (a --test Mantle, or MANTLE_POWER_DRYRUN=1) comes back
     ok with the command it WOULD have run, printed under the row, and the launcher stays up. */
  function activatePower(item) {
    if (item.confirm) {
      if (!armed || armed.id !== item.id) { arm(item); return; }
      if (Date.now() - armed.at < ARM_MIN_MS) return;   // a double-click is not two decisions
    }
    var confirmed = !!(item.confirm && armed && armed.id === item.id);
    disarm();
    mantle.call('launcher.power', { action: item.path, confirmed: confirmed }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun || res.reason) { note = { id: item.id, text: res.reason, ok: true }; render(); }
        return;                                   // for real: main has already hidden the launcher
      }
      note = { id: item.id, text: (res && res.reason) || item.name + ' did not happen, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the ' + item.name + ' request failed: ' + reasonOf(err), ok: false };
      render();
    });
  }

  /* File rows: Enter opens it with its default app, Ctrl+Enter (or Ctrl+click) shows it selected
     in its folder. */
  function activateFile(item, reveal) {
    callPreferring('search.openFile', 'launcher.openFile', { path: item.path, reveal: !!reveal }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun) { note = { id: item.id, text: res.reason, ok: true }; render(); return; }
        // launcher.openFile hides the window itself; search.openFile (a feature) cannot, so ask.
        // A second hide of a hidden launcher is a no-op in main.
        mantle.call('launcher.hide');
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'it did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the open request failed: ' + reasonOf(err), ok: false };
      render();
    });
  }

  /* The calculator row: Enter copies the answer. Main works it out again from the expression and
     copies only that number (lib/launcher-index.js copyCalc); a --test Mantle only says what it
     would copy. A row with no answer says so and copies nothing. */
  function activateCalc(item) {
    if (item.bad) { note = { id: item.id, text: 'there is no answer to copy: ' + item.name, ok: false }; render(); return; }
    mantle.call('search.copy', { expr: item.expr }).then(function (res) {
      if (res && res.ok) {
        note = { id: item.id, text: res.dryRun ? res.reason : 'Copied ' + (res.copied || item.copy), ok: true };
        render();
        if (!res.dryRun) hideTimer = setTimeout(function () { mantle.call('launcher.hide'); }, 700);
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'nothing was copied, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the copy request failed: ' + reasonOf(err), ok: false };
      render();
    });
  }

  /* "Search the web for …": main builds the URL from the text and opens it the way a typed URL
     opens (lib/launcher-index.js openWeb). A dry run stays open and says what it would have done. */
  function activateWeb(item) {
    // what is typed NOW, not the row's copy of it: the row is rebuilt only when apps.search answers,
    // so an End+Enter inside that gap would search the previous text (caught by the selftest)
    var typed = els.q.value.trim() || item.path;
    mantle.call('search.web', { q: typed }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun || res.reason) { note = { id: item.id, text: res.reason, ok: true }; render(); }
        if (!res.dryRun) hideTimer = setTimeout(function () { mantle.call('launcher.hide'); }, res.reason ? 1400 : 0);
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'the search did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the web search request failed: ' + reasonOf(err), ok: false };
      render();
    });
  }

  function activate(alt) {
    var item = rows[sel];
    if (!item) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (item.kind === 'power') { activatePower(item); return; }
    if (item.kind === 'file') { activateFile(item, alt); return; }
    if (item.kind === 'calc') { activateCalc(item); return; }
    if (item.kind === 'web') { activateWeb(item); return; }

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

  els.q.addEventListener('input', function () {
    disarm();                                     // typing is changing your mind
    queueSearch();
    queueFiles();
  });
  // the focused underline is CSS (.slot:focus-within), not a class toggled here

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // the first Esc takes back an armed Shut down; only the next one closes the launcher
      if (disarm()) { render(); return; }
      mantle.call('launcher.hide');
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // a HELD Enter repeats; on a power row that would arm and confirm in one press
      if (e.repeat && rows[sel] && rows[sel].kind === 'power') return;
      activate(e.ctrlKey);
      return;
    }
    if (e.key === 'Tab' && rows.length && Groups) {
      e.preventDefault();
      select(Groups.jumpGroup(view.groups, sel, e.shiftKey ? -1 : 1));
      return;
    }
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
    activate(e.ctrlKey);
  });

  /* ---- events from main --------------------------------------------------- */

  if (typeof mantle.on === 'function') {
    mantle.on('launcher:visible', function (visible) {
      if (!visible) { disarm(); panelDown(); return; }
      // shown: a clean slate every time, so the Win tap always behaves the same
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      els.q.value = '';
      if (pendingOpen && Date.now() - pendingOpen.at > 2000) pendingOpen = null;
      applyMode(pendingOpen ? pendingOpen.mode : 'apps');
      if (pendingOpen && pendingOpen.query) els.q.value = pendingOpen.query;
      pendingOpen = null;
      if (els.q.value.trim().length >= FILE_MIN) queueFiles();
      note = null;
      disarm();
      if (fileTimer) { clearTimeout(fileTimer); fileTimer = null; }
      fileSeq++;                  // an answer still on its way is for the last session's query
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
      renderFooter();
      refreshIndex(false);      // picks up icons that finished after the last open
      runSearch();
      els.q.focus();
      els.results.scrollTop = 0;
      /* belt to visibilitychange's braces: this event is main saying the window IS on screen, and
         a panel that boots at opacity 0 may not depend on a single signal to become visible. */
      panelUp();
    });
    /* Win+S: main sends 'launcher.open' {mode, query} just BEFORE showLauncher(), and showLauncher
       ALWAYS broadcasts launcher:visible true - even when the window is already up (main.js,
       showLauncher) - and that handler resets the launcher. So the mode only waits here, and the
       reset above applies it. A stale one (the show never came) is dropped after 2 s so it cannot
       leak into the next plain Win tap. */
    mantle.on('launcher.open', function (p) {
      pendingOpen = { mode: (p && p.mode) || 'apps', query: (p && p.query) || '', at: Date.now() };
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

  function applyMode(m) {
    mode = m === 'search' ? 'search' : 'apps';
    document.body.dataset.mode = mode;
    els.q.placeholder = PLACEHOLDER[mode];
  }

  /* ---- boot ---------------------------------------------------------------- */
  refreshIndex(false);
  runSearch();
  els.q.focus();
})();
