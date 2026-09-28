/*
 * ui/bar/downloads.js — the Downloads shelf: a button in the bar's right group and its panel, like
 * macOS's Downloads stack (lane downloads, 2026-09-27). Main's half is lib/features/downloads.js.
 *
 * WHAT IT DOES
 *   - the button carries a dot when something finished downloading since the shelf was last opened;
 *     opening the shelf marks everything in it seen (the rows that were new keep their dot while open)
 *   - the newest 12 items, newest first: the file's own icon, its name, its size and its age
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
 * arguments, and names are Owen's). The pure helpers (ago, size, meta) are exported for node:
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

  /* The letters on a generic tile when Windows gave no icon: "PDF", "ZIP", "" for none. */
  function extOf(name) {
    var m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
    return m ? m[1].toUpperCase() : '';
  }

  /* A name as drawn: bidi controls out (LRM/RLM, ALM, the embeddings and overrides U+202A-202E, the
     isolates U+2066-2069), so "invoice<U+202E>fdp.exe" reads invoicefdp.exe, not invoiceexe.pdf: one
     click runs what a row names. Only the DRAWN name; the file is still addressed by its token. */
  function shown(name) {
    return String(name == null ? '' : name).replace(/[؜‎‏‪-‮⁦-⁩]/g, '');
  }
  /* Main hands icons as data:image URLs (nativeImage.toDataURL). Anything else (a file:// or UNC
     path would make Windows fetch it over SMB) is not drawn: the row gets its letter tile. */
  function iconOk(u) {
    return typeof u === 'string' && /^data:image\/(png|jpeg|bmp|gif|webp|x-icon);base64,/i.test(u);
  }

  var api = { ago: ago, size: size, meta: meta, extOf: extOf, shown: shown, iconOk: iconOk };
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
  var FOLDER = '<path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M2.2 4.7c0-.7.5-1.2 1.2-1.2h2.7l1.4 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z"/>';

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
    btn.hidden = !!(s && s.on === false);            // Owen turned the shelf off in the tray
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
  }

  /* cached: main's last read (a push said it changed); otherwise main re-reads the folder first. */
  function refresh(cached) {
    loading = !view;
    if (paint) paint();
    B.call('downloads.list', cached ? { cached: true } : {}).then(function (v) {
      loading = false;
      view = v || { ok: false, state: 'error', reason: 'downloads.list answered nothing', items: [] };
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

  function closed() { stopTicker(); paint = null; }

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
    if (iconOk(it.icon)) {
      var img = mk('img', 'dl-icon');
      img.alt = '';
      img.draggable = false;
      img.src = it.icon;
      return img;
    }
    var tile = mk('span', 'dl-icon dl-tile' + (it.dir ? ' dir' : ''));
    tile.setAttribute('aria-hidden', 'true');
    if (it.dir) tile.innerHTML = svg(FOLDER, 18);
    else tile.textContent = extOf(it.name) || '?';
    return tile;
  }

  function row(it, now) {
    var nm = shown(it.name);
    var r = mk('div', 'dl-row' + (wasFresh[it.item] ? ' fresh' : '') + (busy[it.item] ? ' busy' : ''));
    r.setAttribute('role', 'listitem');
    r.tabIndex = 0;
    r.draggable = true;
    r.title = nm + '\n' + (it.dir ? 'Click to open the folder' : 'Click to open') + ' · drag it onto an app or the desktop';
    r.addEventListener('click', function () { act(it, 'downloads.open', 'Could not open ' + nm, true); });
    r.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') act(it, 'downloads.open', 'Could not open ' + nm, true); });
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
    text.appendChild(mk('div', 'dl-meta', meta(it, now)));
    r.appendChild(text);

    var show = mk('button', 'dl-reveal');
    show.type = 'button';
    show.title = 'Show in folder';
    show.setAttribute('aria-label', 'Show ' + nm + ' in folder');
    show.innerHTML = svg(FOLDER, 15);
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
      folderBtn.title = (v && v.folder) ? 'Open ' + v.folder + ' in Explorer' : 'Open your Downloads folder in Explorer';
      folderBtn.disabled = !!busy['*'] || !!(v && v.state === 'resting');
      list.textContent = '';

      if (!v || loading) {
        list.appendChild(mk('div', 'dl-empty', 'Reading your Downloads folder…'));
      } else if (bad) {
        var u = mk('div', 'dl-empty' + (v.state === 'resting' ? '' : ' dl-bad'));
        u.appendChild(mk('div', 'big', v.state === 'missing' ? 'Downloads folder missing'
          : v.state === 'resting' ? 'Resting while a game runs'
          : v.state === 'reading' ? 'Not read yet'
          : v.state === 'unresolved' ? 'Downloads folder not found' : 'Downloads unavailable'));
        u.appendChild(mk('div', 'sub', v.reason || 'the folder could not be read and no reason was given'));
        if (v.folder) u.appendChild(mk('div', 'dl-path', v.folder));
        list.appendChild(u);
      } else if (!items.length) {
        var e = mk('div', 'dl-empty');
        e.appendChild(mk('div', 'big', 'Nothing downloaded yet'));
        e.appendChild(mk('div', 'sub', 'What you download lands here, newest first.'));
        list.appendChild(e);
      } else {
        items.forEach(function (it) { list.appendChild(row(it, now)); });
      }

      var say = note || (v && v.seenNote) || '';
      noteEl.textContent = say;
      noteEl.hidden = !say;
      var words = [];
      if (v && v.detail) words.push(v.detail);
      if (v && v.ok && !v.watching && v.watchReason) words.push('Not watching: ' + v.watchReason + '.');
      detail.textContent = words.join(' ');
      detail.hidden = !detail.textContent;
      /* Main caps a popover at 480 px (POPOVER_MAX): a note or a detail line takes its room from the list. */
      list.style.maxHeight = (say || detail.textContent) ? '300px' : '';

      /* The panel changes height as files come and go: ask main for the room again so nothing is
         cut off by the window's edge. */
      var hgt = pop.offsetHeight + 16;
      if (room && hgt !== room) {
        B.callR('bar.popover', { open: true, height: hgt, key: KEY }).catch(function (err) {
          noteEl.textContent = 'this panel may be clipped: bar.popover — ' + B.msg(err);
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
