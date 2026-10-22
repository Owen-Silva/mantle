/*
 * ui/bar/downloads.js — the Downloads shelf: a button in the bar's right group and its panel, like
 * macOS's Downloads stack (lane downloads, 2026-09-27). Main's half is lib/features/downloads.js.
 *
 * WHAT IT DOES
 *   - the button carries a dot when something finished downloading since the shelf was last opened;
 *     opening the shelf marks everything in it seen (the rows that were new keep their dot while open)
 *   - the newest 12 items, newest first: its type's glyph (one family, drawn here), its name, and
 *     its size and age on one quiet line under it; the full name on hover; Up/Down/Home/End/Enter/Esc once main hands the
 *     bar the keyboard (qs.keyboard)
 *   - click opens it with its default app; the folder button shows it selected in Explorer; a row can
 *     be DRAGGED out onto another app or the desktop (main runs the real Windows drag)
 *   - "Open Downloads folder" at the bottom; "1 still downloading" at the top while a browser is
 *     still writing (the partial file itself is never a row)
 *
 * NO SILENT FAILURES: a folder that is missing or cannot be read says so, with the reason, in the
 * panel and on the button (muted, tooltip); an open / show / drag that fails says why inside the
 * panel; a plainer read (the sidecar could not answer) and a watch that stopped are named in the foot.
 *
 * Rows are addressed by main's opaque `item` token, never by path (a failed command is logged with its
 * arguments, and names are the user's). The pure helpers (ago, size, meta) are exported for node:
 * lib/features/downloads.test.js loads this file.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MantleDownloads = api;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /* ------------------------------------------------------------------ pure */

  /* "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago", then "Sep 20" (with the year when
     it is not this year). A time a little in the future (a clock skew) is "just now". */
  function ago(ms, now) {
    if (!ms || !isFinite(ms)) return '';
    var n = typeof now === 'number' ? now : Date.now();
    var d = n - ms;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + ' min ago';
    if (d < 86400000) return Math.floor(d / 3600000) + ' h ago';
    var today = new Date(n);
    var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var days = Math.ceil((midnight - ms) / 86400000);
    if (days <= 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    var t = new Date(ms);
    var o = { month: 'short', day: 'numeric' };
    if (t.getFullYear() !== today.getFullYear()) o.year = 'numeric';
    return t.toLocaleDateString('en-US', o);
  }

  /* Windows' units (1024), one decimal under 10: "812 B", "14 KB", "2.4 MB", "1.2 GB". */
  function size(bytes) {
    var b = Math.max(0, Number(bytes) || 0);
    if (b < 1024) return b + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return (b < 10 ? Math.round(b * 10) / 10 : Math.round(b)) + ' ' + u[i];
  }

  function meta(it, now) {
    return [it.dir ? 'Folder' : size(it.size), ago(it.at, now)].filter(Boolean).join(' · ');
  }

  /* What kind of thing a row is, for its glyph: ONE icon family drawn here (same 16 grid, same 1.25
     stroke as the bar's own glyphs), never Windows' per-app icons, which clash side by side and were
     a getFileIcon + data URL per type on main (quality pass, 2026-09-29). */
  var KINDS = {
    image: 'png jpg jpeg gif webp bmp tif tiff heic heif svg ico avif raw cr2 nef psd',
    video: 'mp4 mov mkv avi webm wmv m4v flv mpg mpeg 3gp',
    audio: 'mp3 wav flac m4a aac ogg opus wma mid midi',
    archive: 'zip rar 7z tar gz tgz bz2 xz zst cab',
    app: 'exe msi msix msixbundle appx appxbundle bat cmd ps1 appref-ms apk jar',
    disk: 'iso img vhd vhdx dmg',
    sheet: 'xls xlsx xlsm csv ods numbers tsv',
    slides: 'ppt pptx odp key',
    code: 'js mjs cjs ts tsx jsx json html htm css py cs cpp c h java go rs rb php sh xml yml yaml toml ini sql ipynb',
    doc: 'pdf doc docx odt rtf txt md epub pages log'
  };
  var KIND_OF = {};
  Object.keys(KINDS).forEach(function (k) { KINDS[k].split(' ').forEach(function (x) { KIND_OF[x] = k; }); });
  function kindOf(name, dir) {
    if (dir) return 'folder';
    var m = /\.([a-z0-9-]{1,12})$/i.exec(String(name || ''));
    return (m && KIND_OF[m[1].toLowerCase()]) || 'file';
  }

  /* A name as drawn: bidi controls out (LRM/RLM, ALM, the embeddings and overrides U+202A-202E, the
     isolates U+2066-2069), so "invoice<U+202E>fdp.exe" reads invoicefdp.exe, not invoiceexe.pdf: one
     click runs what a row names. Only the DRAWN name; the file is still addressed by its token. */
  function shown(name) {
    return String(name == null ? '' : name).replace(/[؜‎‏‪-‮⁦-⁩]/g, '');
  }
  /* Main's reasons are clauses ("the Downloads folder does not exist (…)"); on screen they are
     sentences: a capital first, a full stop last. */
  function sentence(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return '';
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?…]$/.test(t) ? t : t + '.';
  }

  var api = { ago: ago, size: size, meta: meta, kindOf: kindOf, shown: shown, sentence: sentence };
  if (!root || !root.document) return api;   // node: the helpers only

  /* ------------------------------------------------------------------ the bar */

  var KEY = 'dl';
  var B = null;
  var btn = null, dot = null;
  var state = null;        // main's last 'downloads.state'
  var view = null;         // the last downloads.list answer
  var loading = false;
  var paint = null;        // repaints the open panel in place; null while it is closed
  var room = 0;            // the popover height last asked of main
  var ticker = 0;          // re-renders the ages while the panel is open
  var note = '';           // the last action's failure (or a test run's words), until the next action
  var busy = Object.create(null);       // item -> true while an action on it is in flight
  var wasFresh = Object.create(null);   // items that were new when the panel opened

  var ARROW = '<path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" d="M8 2.3v7.6M5 7.1l3 2.9 3-2.9"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" d="M2.6 10.1v1.9c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4v-1.9"/>';
  var FOLDER = '<path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M2.2 4.7c0-.7.5-1.2 1.2-1.2h2.7l1.4 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z"/>';

  /* The row glyphs: one family (16 grid, 1.25 stroke, round joins), drawn in a 28 px tile. */
  var PAGE = 'M4.3 1.9h4.6l3.3 3.3v8a1 1 0 0 1-1 1H4.3a1 1 0 0 1-1-1V2.9a1 1 0 0 1 1-1zM8.9 2v2.3a1 1 0 0 0 1 1h2.2';
  var FRAME = 'M2.6 3.2h10.8a.9.9 0 0 1 .9.9v7.8a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.1a.9.9 0 0 1 .9-.9z';
  var GLYPH = {
    file: PAGE,
    doc: PAGE + 'M5.5 8.2h5M5.5 10.3h5M5.5 12.4h3',
    sheet: PAGE + 'M5.4 7.9h5.2v4.7H5.4zM5.4 10.25h5.2M8 7.9v4.7',
    code: PAGE + 'M6.7 8.3 5.3 9.8l1.4 1.5M9.3 8.3l1.4 1.5-1.4 1.5',
    archive: PAGE + 'M6.9 2v1.1M6.9 4.3v1.1M6.9 6.6v1.1M5.9 8.9h2v2.4h-2z',
    image: FRAME + 'M1.9 11.3l3.5-3.5 2.7 2.7 1.7-1.7 3.6 3.6M11.2 6.2a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
    video: FRAME + 'M6.6 5.8v4.4L10.3 8z',
    audio: 'M6 11.9V3.7l6.4-1.4v8.3M6 11.9a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0zM12.4 10.6a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0z',
    slides: 'M1.8 2.9h12.4M2.7 2.9v6.8a.8.8 0 0 0 .8.8h9a.8.8 0 0 0 .8-.8V2.9M8 10.5v2.3M6 13.7l2-.9 2 .9',
    app: 'M2.6 2.9h10.8a.9.9 0 0 1 .9.9v8.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V3.8a.9.9 0 0 1 .9-.9zM1.7 5.6h12.6',
    disk: 'M14.2 8a6.2 6.2 0 1 1-12.4 0 6.2 6.2 0 0 1 12.4 0zM9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
    folder: 'M2.2 4.7c0-.7.5-1.2 1.2-1.2h2.7l1.4 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z'
  };
  var KIND_WORD = { file: 'File', doc: 'Document', sheet: 'Spreadsheet', code: 'Code', archive: 'Archive', image: 'Image',
    video: 'Video', audio: 'Audio', slides: 'Presentation', app: 'App or installer', disk: 'Disk image', folder: 'Folder' };
  function glyph(kind, px) {
    return svg('<path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" d="' + (GLYPH[kind] || GLYPH.file) + '"/>', px);
  }

  function svg(body, px) {
    return '<svg viewBox="0 0 16 16" width="' + px + '" height="' + px + '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function init(helpers) {
    B = helpers;
    btn = document.getElementById('downloads');
    if (!btn) return;
    dot = btn.querySelector('.dldot');
    btn.addEventListener('click', open);
    btn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); open(); });
    document.addEventListener('keydown', onKey);
    renderBtn();
    B.on('downloads.state', update, function (reason) {
      state = { on: true, ok: false, state: 'error', reason: 'the bar cannot hear about your downloads: ' + reason, newCount: 0 };
      renderBtn(); health();
    });
  }

  function update(s) {
    state = s || null;
    renderBtn();
    health();
    if (paint && B.popKey() === KEY && state && view && state.rev !== view.rev) refresh(true);
  }

  var BAD = { missing: 1, unreadable: 1, unresolved: 1, error: 1 };
  function isBad(s) { return !!(s && (s.ok === false || BAD[s.state])); }

  function renderBtn() {
    if (!btn) return;
    var s = state;
    btn.hidden = !!(s && s.on === false);            // the user turned the shelf off in the tray
    var bad = isBad(s);
    var resting = s && (s.state === 'resting' || s.state === 'stopped');
    var fresh = !bad && !resting && s && s.newCount > 0;
    btn.classList.toggle('off', bad || !!resting);
    btn.classList.toggle('new', !!fresh);
    if (dot) dot.hidden = !fresh;
    btn.title = !s ? 'Downloads — reading…'
      : bad ? 'Downloads unavailable — ' + (s.reason || 'no reason was given')
      : resting ? 'Downloads — ' + (s.reason || s.state)
      : fresh ? 'Downloads — ' + s.newCount + ' new'
      : 'Downloads';
    btn.setAttribute('aria-label', btn.title);
  }

  /* A folder that cannot be read is a chip in the strip, not only a muted button. */
  function health() {
    if (isBad(state)) B.fail('downloads', 'downloads off', state.reason || 'the Downloads folder could not be read and no reason was given', 'warn');
    else B.clearFail('downloads');
  }

  /* ------------------------------------------------------------------ the panel */

  function open() {
    B.openPop(KEY, btn, build);
    if (B.popKey() !== KEY) { stopTicker(); paint = null; return; }   // it was open, and that click closed it
    wasFresh = Object.create(null);
    note = '';
    refresh(false);
    startTicker();
    keyboard(true);
  }

  /* The keyboard. The bar window is not focusable at rest, so arrows / Enter / Esc reach this panel
     only when main hands the bar the keyboard (qs.keyboard, as the jump list does); closing gives it
     back. Refused (a test instance, another window kept focus): the mouse still works, and the list's
     tooltip says why the keys do not. */
  var kbd = false, kbdGen = 0;
  function keyboard(on) {
    var gen = ++kbdGen;
    if (!on) {
      if (kbd) { kbd = false; B.call('qs.keyboard', { on: false }).catch(function () {}); }
      return;
    }
    B.call('qs.keyboard', { on: true }).then(function (r) {
      var got = !!(r && r.ok);
      if (gen !== kbdGen || B.popKey() !== KEY) {   // closed (or reopened) meanwhile: give it straight back
        if (got) B.call('qs.keyboard', { on: false }).catch(function () {});
        return;
      }
      kbd = got;
      kbdNote = got ? '' : 'Arrow keys do not reach this panel: ' + String((r && r.reason) || 'Windows kept the keyboard on another window').split(', so ')[0];
      if (paint) paint();
    }, function (e) {
      if (gen !== kbdGen) return;
      kbdNote = 'Arrow keys do not reach this panel: ' + B.msg(e);
      if (paint) paint();
    });
  }
  var kbdNote = '';

  /* Up / Down / Home / End walk the rows (the first Down from nowhere lands on the newest); Enter on a
     row opens it (the row's own handler). Esc is bar.js's (it closes every panel). */
  function onKey(ev) {
    if (!paint || B.popKey() !== KEY) return;
    var k = ev.key;
    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
    var rows = Array.prototype.slice.call(document.querySelectorAll('.pop.dl .dl-row'));
    if (!rows.length) return;
    var at = rows.indexOf(document.activeElement && document.activeElement.closest ? document.activeElement.closest('.dl-row') : null);
    var to = k === 'Home' ? 0 : k === 'End' ? rows.length - 1
      : at < 0 ? (k === 'ArrowDown' ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, at + (k === 'ArrowDown' ? 1 : -1)));
    ev.preventDefault();
    rows[to].focus();
    if (rows[to].scrollIntoView) rows[to].scrollIntoView({ block: 'nearest' });
  }

  /* cached: main's last read (a push said it changed); otherwise main re-reads the folder first. */
  function refresh(cached) {
    loading = !view;
    if (paint) paint();
    B.call('downloads.list', cached ? { cached: true } : {}).then(function (v) {
      loading = false;
      view = v || { ok: false, state: 'error', reason: 'Mantle got no answer when it read the folder', items: [] };
      var any = false;
      (view.items || []).forEach(function (it) { if (it.fresh) { wasFresh[it.item] = true; any = true; } });
      if (paint) paint();
      if (any || (state && state.newCount > 0)) seeAll();
    }, function (e) {
      loading = false;
      var m = B.msg(e);
      /* A game is running: the feature rests (lib/features.js restAll) and its commands say so. That
         is expected, not a failure, so it is not drawn as one. */
      var resting = /is resting while/.test(m);
      view = { ok: false, state: resting ? 'resting' : 'error', reason: resting ? m : 'could not read your downloads: ' + m, items: [] };
      if (paint) paint();
    });
  }

  function seeAll() {
    B.callR('downloads.seen').then(function (r) {
      if (r && r.note) { note = r.note; if (paint) paint(); }
    }, function (e) {
      note = 'could not mark these as seen, so the dot may stay: ' + B.msg(e);
      if (paint) paint();
    });
  }

  function closed() { stopTicker(); paint = null; keyboard(false); busy = Object.create(null); }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (!paint || B.popKey() !== KEY) { stopTicker(); paint = null; return; }
      paint();
    }, 30000);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = 0; } }

  function act(it, channel, what, closeOnOk) {
    var k = it ? it.item : '*';
    if (busy[k]) return Promise.resolve();   // a double-click or a held Enter: one open, not two
    busy[k] = true;
    note = '';
    if (paint) paint();
    return B.callR(channel, it ? { item: it.item } : {}).then(function (r) {
      delete busy[k];
      if (r && r.dryRun) note = r.reason || 'test run: nothing was opened';
      else if (r && r.note) note = r.note;
      else if (closeOnOk) { B.closePop(); return; }
      if (paint) paint();
    }, function (e) {
      delete busy[k];
      note = what + ': ' + B.msg(e);
      if (/out of date|no longer in Downloads/.test(note)) refresh(true);
      if (paint) paint();
    });
  }

  function iconEl(it) {
    var kind = kindOf(it.name, it.dir);
    var tile = mk('span', 'dl-icon dl-k-' + kind);
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = glyph(kind, 18);
    return tile;
  }

  function row(it, now) {
    var nm = shown(it.name);
    var m = meta(it, now);
    var r = mk('div', 'dl-row' + (wasFresh[it.item] ? ' fresh' : '') + (busy[it.item] ? ' busy' : ''));
    r.setAttribute('role', 'listitem');
    r.setAttribute('aria-label', nm + ', ' + (wasFresh[it.item] ? 'new, ' : '') + KIND_WORD[kindOf(it.name, it.dir)] + ', ' + m);
    r.dataset.item = it.item;
    r.tabIndex = 0;
    r.draggable = true;
    /* The full name (a long one is cut with an ellipsis in the row) and what the row does. */
    r.title = nm + '\n' + (it.dir ? 'Click to open the folder' : 'Click to open') + ', or drag it into an app or onto the desktop';
    r.addEventListener('click', function () { act(it, 'downloads.open', 'Could not open ' + nm, true); });
    /* Only the ROW's own Enter: an Enter on its Show in folder button bubbles here too, and must not
       also open the file. */
    r.addEventListener('keydown', function (ev) {
      if (ev.target !== r || ev.repeat) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(it, 'downloads.open', 'Could not open ' + nm, true); }
    });
    /* The HTML drag is cancelled and main starts the real Windows drag of the file instead. */
    r.addEventListener('dragstart', function (ev) {
      ev.preventDefault();
      B.callR('downloads.drag', { item: it.item }).catch(function (e) {
        note = 'Could not drag ' + nm + ': ' + B.msg(e);
        if (/out of date|no longer in Downloads/.test(note)) refresh(true);
        if (paint) paint();
      });
    });

    r.appendChild(iconEl(it));
    var text = mk('div', 'dl-text');
    text.appendChild(mk('div', 'dl-name', nm));
    text.appendChild(mk('div', 'dl-meta', m));
    r.appendChild(text);

    var show = mk('button', 'dl-reveal');
    show.type = 'button';
    show.title = 'Show in folder';
    show.setAttribute('aria-label', 'Show ' + nm + ' in folder');
    show.innerHTML = svg(FOLDER, 16);
    show.addEventListener('click', function (ev) {
      ev.stopPropagation();
      act(it, 'downloads.reveal', 'Could not show ' + nm + ' in its folder', true);
    });
    r.appendChild(show);
    return r;
  }

  function build(pop) {
    pop.classList.add('dl');
    room = 0;

    var head = mk('div', 'dl-head');
    var h = mk('h3', null, 'Downloads');
    var sub = mk('span', 'dl-sub');
    head.appendChild(h);
    head.appendChild(sub);
    pop.appendChild(head);

    var list = mk('div', 'dl-list');
    list.setAttribute('role', 'list');
    pop.appendChild(list);

    var noteEl = mk('div', 'note');
    pop.appendChild(noteEl);

    var foot = mk('div', 'dl-foot');
    var detail = mk('div', 'dl-detail');
    var folderBtn = mk('button', 'qslink dl-folder');
    folderBtn.type = 'button';
    folderBtn.innerHTML = svg(FOLDER, 14);
    folderBtn.appendChild(document.createTextNode('Open Downloads folder'));
    folderBtn.addEventListener('click', function () { act(null, 'downloads.folder', 'Could not open the Downloads folder', true); });
    foot.appendChild(detail);
    foot.appendChild(folderBtn);
    pop.appendChild(foot);

    paint = function () {
      if (B.popKey() !== KEY) { paint = null; return; }
      var v = view;
      var now = Date.now();
      var items = (v && v.items) || [];
      var bad = v && v.ok === false;
      var partial = (v && v.partial) || (state && state.partial) || 0;
      sub.textContent = partial ? partial + ' still downloading…' : '';
      sub.hidden = !partial;
      /* No folder to open (missing, not found): the button is off and says why, not a click that fails. */
      var noFolder = !!(v && (v.state === 'missing' || v.state === 'unresolved'));
      folderBtn.title = noFolder ? 'There is no Downloads folder to open right now'
        : (v && v.folder) ? 'Open ' + v.folder + ' in File Explorer' : 'Open your Downloads folder in File Explorer';
      folderBtn.disabled = !!busy['*'] || noFolder || !!(v && v.state === 'resting');
      list.title = kbdNote;
      /* A repaint (a push, the 30 s age tick, an action) rebuilds the rows: keep the keyboard on the
         same file and the list where it was scrolled, or both jump back to the top every 30 s. */
      var ae = document.activeElement;
      var focusItem = ae && list.contains(ae) && ae.closest('.dl-row') ? ae.closest('.dl-row').dataset.item : null;
      var focusReveal = !!(focusItem && ae.classList.contains('dl-reveal'));
      var scrollTop = list.scrollTop;
      list.textContent = '';

      if (!v || loading) {
        list.appendChild(mk('div', 'dl-empty', 'Reading your Downloads folder…'));
      } else if (bad) {
        var u = mk('div', 'dl-empty' + (v.state === 'resting' ? '' : ' dl-bad'));
        u.appendChild(mk('div', 'big', v.state === 'missing' ? 'Your Downloads folder is missing'
          : v.state === 'resting' ? 'Paused while you play'
          : v.state === 'reading' ? 'Not read yet'
          : v.state === 'unresolved' ? 'Downloads folder not found'
          : v.state === 'unreadable' ? 'Mantle cannot read your Downloads folder' : 'Downloads unavailable'));
        /* The heading already says it is missing: the line under it says only the why ("It was moved,
           renamed or deleted."), not the same fact twice. */
        var why = String(v.reason || 'the folder could not be read and no reason was given');
        var twice = v.state === 'missing' && /^the Downloads folder does not exist \((.+)\)$/.exec(why);
        u.appendChild(mk('div', 'sub', sentence(twice ? twice[1] : why)));
        if (v.folder) u.appendChild(mk('div', 'dl-path', v.folder));
        /* No dead end: what happens next, in words (main looks again every v.retryMs). */
        if (v.retryMs && v.state !== 'resting')
          u.appendChild(mk('div', 'dl-next', 'Mantle looks again every ' + Math.round(v.retryMs / 60000) + ' minutes and each time you open this panel.'));
        list.appendChild(u);
      } else if (!items.length) {
        var e = mk('div', 'dl-empty');
        e.appendChild(mk('div', 'big', 'Nothing downloaded yet'));
        e.appendChild(mk('div', 'sub', 'Files you download show up here, newest first.'));
        list.appendChild(e);
      } else {
        items.forEach(function (it) { list.appendChild(row(it, now)); });
        if (focusItem) {
          var back = list.querySelector('.dl-row[data-item="' + focusItem.replace(/[^\w-]/g, '') + '"]');
          if (back) (focusReveal ? back.querySelector('.dl-reveal') : back).focus({ preventScroll: true });
        }
      }
      list.scrollTop = scrollTop;

      var say = note || (v && v.seenNote) || '';
      noteEl.textContent = say ? sentence(say) : '';
      noteEl.hidden = !say;
      var words = [];
      if (v && v.detail) words.push(sentence(v.detail));
      if (v && v.ok && !v.watching && v.watchReason) words.push(sentence(v.watchReason));
      detail.textContent = words.join(' ');
      detail.hidden = !detail.textContent;
      /* Sized for 480 px, under main's 640 cap (POPOVER_MAX): a note or a detail line takes its room from the list. */
      list.style.maxHeight = (say || detail.textContent) ? '300px' : '';

      /* The panel changes height as files come and go: ask main for the room again so nothing is
         cut off by the window's edge. */
      var hgt = pop.offsetHeight + 16;
      if (room && hgt !== room) {
        B.callR('bar.popover', { open: true, height: hgt, key: KEY }).catch(function (err) {
          noteEl.textContent = 'This panel may be cut off at the screen edge: ' + B.msg(err);
          noteEl.hidden = false;
        });
      }
      room = hgt;
    };
    paint();
  }

  api.init = init;
  api.open = function () { if (B && B.popKey() !== KEY) open(); };
  api.closed = closed;
  api.KEY = KEY;
  api.ARROW = ARROW;
  return api;
}));
