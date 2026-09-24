/* taskview.js - the Task View page (Win+Tab). Plain browser script; window.mantle is the bridge
 * (preload.js in Mantle, mock-mantle.js in a headless browser).
 *
 * ONE OPEN, FROM MAIN'S SIDE (lib/features/taskview.js):
 *   taskview.open    {seq, list, desktops, others, glass}   the page draws while the window is parked
 *   <- taskview.painted {seq, boxes}                        each visible .pv, CSS px, viewport-relative;
 *                                                           main registers the DWM thumbnails there
 *   taskview.thumbs  {seq, ok, reason, thumbs}              which pictures took, and why not
 *   taskview.icons   {seq, icons}                           icons main had to look up
 *   taskview.update  {seq, list?, desktops?, others?}       after a close / move / desktop change
 *   taskview.notice  {seq, text}                            an action failed: the reason, on screen
 *   taskview.end     {seq, why}                             the window is parked: empty the page
 * The page asks: taskview.activate {hwnd}, taskview.close {hwnd}, taskview.desk {op, ...},
 * taskview.dismiss {why}. Every call can reject with plain words, which go in the toast.
 *
 * KEYS: arrows / Home / End move; Enter switches; Esc closes (or cancels a rename); typing filters
 * (Backspace, Ctrl+Backspace); Tab moves between the windows and the desktop strip; in the strip
 * Left/Right choose, Enter switches (or adds, on +), F2 renames, Delete removes.
 */
(function () {
  'use strict';
  var Lay = window.TaskViewLayout;
  var $ = function (id) { return document.getElementById(id); };
  var grid = $('grid'), desksEl = $('desks'), stripWhy = $('stripWhy'), qEl = $('q'), qCount = $('qCount');
  var emptyEl = $('empty'), foot = $('foot'), toast = $('toast'), dragChip = $('dragChip');

  var S = {
    seq: 0, items: [], shown: [], sel: 0, first: 0, lay: null, query: '',
    desktops: null, others: [], thumbs: {}, thumbsWhy: null, glass: null,
    zone: 'grid', deskSel: 0, renaming: null, drag: null, busy: false, toastTimer: 0, reportTimer: 0,
  };

  var X_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
  var PLUS_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg>';

  function call(name, args) {
    try { return Promise.resolve(window.mantle.call(name, args || {})); } catch (err) { return Promise.reject(err); }
  }
  function words(err) { return (err && err.message) || String(err || 'it failed'); }

  function iconEl(it, cls) {
    if (it.icon) {
      var img = document.createElement('img');
      img.className = cls; img.alt = ''; img.src = it.icon;
      return img;
    }
    var d = document.createElement('div');
    d.className = cls + ' letter';
    d.textContent = (String(it.app || it.title || '?').trim()[0] || '?').toUpperCase();
    if (it.iconReason) d.title = it.iconReason;
    return d;
  }

  // ------------------------------------------------------------------ the strip

  function deskCount(id) {
    var n = 0, i;
    var cur = S.desktops && S.desktops.current;
    if (id === cur) { for (i = 0; i < S.items.length; i++) if (!S.items[i].desktop || S.items[i].desktop === cur) n++; return n; }
    for (i = 0; i < S.others.length; i++) if (S.others[i].desktop === id) n++;
    return n;
  }
  function deskTitles(id) {
    var t = [];
    for (var i = 0; i < S.others.length; i++) if (S.others[i].desktop === id) t.push(S.others[i].title);
    return t;
  }
  function canWrite() { return !!(S.desktops && S.desktops.ok && S.desktops.canWrite); }
  function deskList() { return (S.desktops && S.desktops.list) || []; }

  function renderStrip() {
    desksEl.textContent = '';
    var d = S.desktops;
    var list = deskList();
    var rw = canWrite();
    stripWhy.textContent = !d ? 'Reading the desktops...' :
      !d.ok ? 'Desktops are unavailable: ' + (d.reason || 'no reason was given') :
      !rw ? 'Switching, adding, removing and renaming desktops is off: ' + (d.writeReason || d.reason || 'no reason was given') : '';
    for (var i = 0; i < list.length; i++) {
      var dk = list[i];
      var el = document.createElement('div');
      el.className = 'desk' + (dk.id === d.current ? ' is-cur' : '') + (rw ? '' : ' is-ro') +
                     (S.zone === 'strip' && S.deskSel === i ? ' is-focus' : '');
      el.dataset.id = dk.id; el.dataset.i = String(i);
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', dk.id === d.current ? 'true' : 'false');
      var n = deskCount(dk.id);
      var mini = document.createElement('div');
      mini.className = 'mini';
      for (var k = 0; k < Math.min(n, 8); k++) mini.appendChild(document.createElement('i'));
      el.appendChild(mini);
      var row = document.createElement('div');
      row.className = 'desk-row';
      if (S.renaming === dk.id) {
        var input = document.createElement('input');
        input.className = 'desk-name-in'; input.value = dk.named ? dk.name : ''; input.placeholder = dk.name;
        input.maxLength = 100; input.id = 'renameInput';
        input.setAttribute('aria-label', 'New name for ' + dk.name);
        row.appendChild(input);
      } else {
        var nm = document.createElement('div');
        nm.className = 'desk-name'; nm.textContent = dk.name;
        row.appendChild(nm);
        var meta = document.createElement('div');
        meta.className = 'desk-meta';
        meta.textContent = n === 1 ? '1 window' : n + ' windows';
        row.appendChild(meta);
      }
      el.appendChild(row);
      var titles = dk.id === d.current ? [] : deskTitles(dk.id);
      el.title = dk.name + (dk.id === d.current ? ' (this desktop)' : '') + (titles.length ? '\n' + titles.join('\n') : '');
      if (rw && list.length > 1) {
        var x = document.createElement('button');
        x.className = 'desk-x'; x.innerHTML = X_SVG; x.title = 'Remove ' + dk.name + ' (its windows move next door)';
        x.dataset.act = 'remove';
        el.appendChild(x);
      }
      desksEl.appendChild(el);
    }
    if (rw) {
      var add = document.createElement('button');
      add.className = 'desk-add' + (S.zone === 'strip' && S.deskSel === list.length ? ' is-focus' : '');
      add.id = 'deskAdd'; add.innerHTML = PLUS_SVG; add.title = 'New desktop';
      add.dataset.act = 'create';
      desksEl.appendChild(add);
    }
    var inp = $('renameInput');
    if (inp) { inp.focus(); inp.select(); }
  }

  // ------------------------------------------------------------------ the grid

  function applyFilter(keepHwnd) {
    var idx = Lay.filter(S.items, S.query);
    S.shown = idx.map(function (i) { return S.items[i]; });
    var at = -1;
    if (keepHwnd) for (var i = 0; i < S.shown.length; i++) if (S.shown[i].hwnd === keepHwnd) { at = i; break; }
    S.sel = at >= 0 ? at : (S.shown.length ? Math.min(S.sel, S.shown.length - 1) : -1);
    if (S.sel < 0 && S.shown.length) S.sel = 0;
    qEl.textContent = S.query;
    qCount.textContent = S.query ? S.shown.length + ' of ' + S.items.length : (S.items.length ? S.items.length + (S.items.length === 1 ? ' window' : ' windows') : '');
  }

  function selHwnd() { return S.sel >= 0 && S.shown[S.sel] ? S.shown[S.sel].hwnd : null; }

  function renderGrid() {
    var W = window.innerWidth, H = window.innerHeight;
    var lay = Lay.layout(S.shown.length, W, H);
    S.lay = lay;
    S.first = Lay.firstRowFor(lay, S.sel, S.first);
    var pos = Lay.place(lay, S.first);
    grid.textContent = '';
    document.documentElement.style.setProperty('--pvw', lay.pvW + 'px');
    for (var i = 0; i < S.shown.length; i++) {
      var p = pos[i];
      if (!p.visible) continue;
      var it = S.shown[i];
      var t = document.createElement('div');
      t.className = 'tile' + (i === S.sel && S.zone === 'grid' ? ' is-sel' : '');
      t.dataset.i = String(i); t.dataset.hwnd = it.hwnd;
      t.setAttribute('role', 'option');
      t.setAttribute('aria-selected', i === S.sel ? 'true' : 'false');
      t.style.left = p.x + 'px'; t.style.top = p.y + 'px';
      t.style.width = lay.tileW + 'px'; t.style.height = lay.tileH + 'px';
      var pv = document.createElement('div');
      pv.className = 'pv';
      pv.style.width = lay.pvW + 'px'; pv.style.height = lay.pvH + 'px';
      pv.appendChild(iconEl(it, 'big'));
      var why = document.createElement('div');
      why.className = 'pv-why';
      var th = S.thumbs[it.hwnd];
      why.textContent = th && !th.ok ? 'No preview: ' + th.reason : (it.minimized || (th && th.minimized)) ? 'Minimized' : '';
      pv.appendChild(why);
      t.appendChild(pv);
      var cap = document.createElement('div');
      cap.className = 'cap';
      cap.appendChild(iconEl(it, 'ico'));
      var ttl = document.createElement('span');
      ttl.className = 'ttl'; ttl.textContent = it.title; ttl.title = it.title;
      cap.appendChild(ttl);
      if (it.hung) { var c = document.createElement('span'); c.className = 'chip warn'; c.textContent = 'Not responding'; cap.appendChild(c); }
      var x = document.createElement('button');
      x.className = 'x'; x.innerHTML = X_SVG; x.title = 'Close ' + it.title; x.dataset.act = 'close';
      cap.appendChild(x);
      t.appendChild(cap);
      grid.appendChild(t);
    }
    var hasDesk = S.desktops && S.desktops.ok;
    emptyEl.textContent = S.listReason ? 'The window list could not be read: ' + S.listReason :
                          S.items.length === 0 ? 'No windows open on this desktop' + (hasDesk && deskList().length > 1 ? '. Pick another desktop above.' : '') :
                          S.shown.length === 0 ? 'No window matches "' + S.query + '"' : '';
    if (lay.scrolls) {
      var more = lay.rows - lay.visibleRows;
      foot.dataset.scroll = 'Rows ' + (S.first + 1) + '-' + (S.first + lay.visibleRows) + ' of ' + lay.rows + ' (' + more + ' more with the arrow keys or the wheel)';
    } else delete foot.dataset.scroll;
    renderFoot();
  }

  function renderFoot() {
    var parts = [];
    if (S.glass && !S.glass.ok) parts.push('No blur: ' + (S.glass.reason || 'the blur-behind could not be applied'));
    if (S.thumbsWhy) parts.push('No live previews: ' + S.thumbsWhy);
    if (S.desktops && S.desktops.ok && S.desktops.windowsReason) parts.push(S.desktops.windowsReason);
    if (foot.dataset.scroll) parts.push(foot.dataset.scroll);
    foot.textContent = parts.join('  ·  ');
  }

  /** Measure the visible preview boxes and hand them to main (it draws DWM's pictures there). */
  function report() {
    if (!S.seq) return;
    var boxes = [];
    var tiles = grid.querySelectorAll('.tile');
    for (var i = 0; i < tiles.length; i++) {
      var r = tiles[i].querySelector('.pv').getBoundingClientRect();
      boxes.push({ hwnd: tiles[i].dataset.hwnd, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    var seq = S.seq;
    call('taskview.painted', { seq: seq, boxes: boxes, t: performance.now(), dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight }).catch(function (err) {
      if (S.seq === seq) { S.thumbsWhy = words(err); renderFoot(); }
    });
  }
  function renderAll(keepHwnd) {
    applyFilter(keepHwnd === undefined ? selHwnd() : keepHwnd);
    renderStrip();
    renderGrid();
    // Two frames, so the layout is composed in the parked window before DWM is pointed at it; OR
    // 34 ms, whichever is first: a never-shown window (the --test instance) gets rAF about once a
    // second (measured 2026-09-24: "drawn" at ~1048 ms), and the boxes are measurable already.
    var seq = S.seq, sent = false;
    var go = function () { if (sent || S.seq !== seq) return; sent = true; report(); };
    requestAnimationFrame(function () { requestAnimationFrame(go); });
    setTimeout(go, 34);
  }

  // ------------------------------------------------------------------ actions

  function showToast(text) {
    toast.innerHTML = '';
    var b = document.createElement('b'); b.textContent = 'Could not do that. ';
    toast.appendChild(b);
    toast.appendChild(document.createTextNode(text));
    toast.classList.add('on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { toast.classList.remove('on'); }, 5000);
  }

  function activate(i) {
    var it = S.shown[i];
    if (!it) return;
    call('taskview.activate', { seq: S.seq, hwnd: it.hwnd }).catch(function (err) { showToast(words(err)); });
  }
  function closeWin(i) {
    var it = S.shown[i];
    if (!it) return;
    call('taskview.close', { seq: S.seq, hwnd: it.hwnd }).catch(function (err) { showToast(words(err)); });
  }
  function dismiss(why) { call('taskview.dismiss', { seq: S.seq, why: why }).catch(function () { /* main ends it anyway */ }); }

  /** A desktop op. Main answers {desktops, others, list?}, or rejects with the reason. */
  function desk(op, args) {
    if (S.busy) return Promise.resolve(null);
    S.busy = true;
    var a = args || {};
    a.op = op; a.seq = S.seq;
    return call('taskview.desk', a).then(function (r) {
      S.busy = false;
      if (r) applyUpdate(r);
      return r;
    }, function (err) {
      S.busy = false;
      showToast(words(err));
      return null;
    });
  }

  function applyUpdate(m) {
    var keep = selHwnd();
    if (m.list) S.items = m.list;
    if (m.desktops) S.desktops = m.desktops;
    if (m.others) S.others = m.others;
    if (S.zone === 'strip') S.deskSel = Math.min(S.deskSel, deskList().length - (canWrite() ? 0 : 1));
    renderAll(keep);
  }

  function startRename(id) {
    if (!canWrite()) return;
    S.renaming = id;
    renderStrip();
  }
  function finishRename(commit) {
    var id = S.renaming;
    if (!id) return;
    var inp = $('renameInput');
    var name = inp ? inp.value.trim() : '';
    S.renaming = null;
    if (!commit) { renderStrip(); return; }
    desk('rename', { desktop: id, name: name }).then(function (r) { if (!r) renderStrip(); });
  }

  // ------------------------------------------------------------------ keys

  function setSel(i) {
    if (i < 0 || i === S.sel) return;
    S.sel = i;
    renderAll();
  }

  document.addEventListener('keydown', function (e) {
    if (!S.seq) return;
    if (S.renaming) {
      if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
      return;                                     // the input has every other key
    }
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); dismiss('esc'); return; }
    if (k === 'Tab') {
      e.preventDefault();
      if (!deskList().length) return;
      S.zone = S.zone === 'grid' ? 'strip' : 'grid';
      if (S.zone === 'strip') {
        var cur = deskList().map(function (d) { return d.id; }).indexOf(S.desktops.current);
        S.deskSel = cur >= 0 ? cur : 0;
      }
      renderAll();
      return;
    }
    if (S.zone === 'strip') {
      var last = deskList().length - (canWrite() ? 0 : 1);   // the + button is one more stop
      var dk = deskList()[S.deskSel];
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); S.deskSel = Math.max(0, Math.min(last, S.deskSel + (k === 'ArrowLeft' ? -1 : 1))); renderStrip(); return; }
      if (k === 'ArrowDown') { e.preventDefault(); S.zone = 'grid'; renderAll(); return; }
      if (k === 'Enter') { e.preventDefault(); if (dk) desk('switch', { desktop: dk.id }); else desk('create'); return; }
      if (k === 'F2' && dk) { e.preventDefault(); startRename(dk.id); return; }
      if (k === 'Delete' && dk && canWrite() && deskList().length > 1) { e.preventDefault(); desk('remove', { desktop: dk.id }); return; }
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'Home' || k === 'End') {
      e.preventDefault();
      if (k === 'ArrowUp' && S.lay && S.sel >= 0 && Math.floor(S.sel / S.lay.cols) === 0 && deskList().length) {
        S.zone = 'strip';
        var ci = deskList().map(function (d) { return d.id; }).indexOf(S.desktops.current);
        S.deskSel = ci >= 0 ? ci : 0;
        renderAll();
        return;
      }
      if (S.lay) setSel(Lay.move(S.lay, S.sel, k));
      return;
    }
    if (k === 'Enter') { e.preventDefault(); activate(S.sel); return; }
    if (k === 'Delete' && e.ctrlKey) { e.preventDefault(); closeWin(S.sel); return; }
    if (k === 'Backspace') {
      e.preventDefault();
      S.query = e.ctrlKey ? '' : S.query.slice(0, -1);
      S.sel = 0; S.first = 0;
      renderAll(null);
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (!S.query && k === ' ') return;
      S.query += k;
      S.sel = 0; S.first = 0;
      renderAll(null);
    }
  });

  // ------------------------------------------------------------------ mouse, drag

  function tileOf(el) { while (el && el !== document.body) { if (el.classList && el.classList.contains('tile')) return el; el = el.parentNode; } return null; }
  function deskOf(el) { while (el && el !== document.body) { if (el.classList && (el.classList.contains('desk') || el.classList.contains('desk-add'))) return el; el = el.parentNode; } return null; }

  document.addEventListener('pointerdown', function (e) {
    if (!S.seq || e.button !== 0) return;
    var t = tileOf(e.target);
    if (t && !(e.target.closest && e.target.closest('button'))) {
      S.drag = { hwnd: t.dataset.hwnd, i: Number(t.dataset.i), x: e.clientX, y: e.clientY, on: false, over: null };
    }
  });
  document.addEventListener('pointermove', function (e) {
    var d = S.drag;
    if (!d) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 8 || !canWrite()) return;
      d.on = true;
      var it = S.shown[d.i];
      dragChip.textContent = '';
      if (it) { dragChip.appendChild(iconEl(it, 'ico')); dragChip.appendChild(document.createTextNode(it.title)); }
      dragChip.classList.add('on');
      var src = grid.querySelector('.tile[data-hwnd="' + d.hwnd + '"]');
      if (src) src.classList.add('is-dragging');
    }
    dragChip.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY + 12) + 'px)';
    var over = deskOf(document.elementFromPoint(e.clientX, e.clientY));
    if (over !== d.over) {
      if (d.over) d.over.classList.remove('is-drop');
      if (over && over.dataset.id !== (S.desktops && S.desktops.current)) over.classList.add('is-drop');
      else over = null;
      d.over = over;
    }
  });
  document.addEventListener('pointerup', function (e) {
    var d = S.drag;
    S.drag = null;
    if (d && d.on) {
      S.justDragged = true;                       // the click that follows this pointerup is not a click
      dragChip.classList.remove('on');
      if (d.over) {
        d.over.classList.remove('is-drop');
        if (d.over.dataset.act === 'create') {
          desk('create').then(function (r) {
            var made = r && r.created;
            if (made) desk('move', { hwnd: d.hwnd, desktop: made });
          });
        } else desk('move', { hwnd: d.hwnd, desktop: d.over.dataset.id });
      } else renderGrid();
      return;
    }
  });

  document.addEventListener('click', function (e) {
    if (!S.seq) return;
    if (S.justDragged) { S.justDragged = false; return; }
    var btn = e.target.closest && e.target.closest('button');
    var t = tileOf(e.target);
    var dk = deskOf(e.target);
    if (btn && btn.dataset.act === 'close' && t) { closeWin(Number(t.dataset.i)); return; }
    if (btn && btn.dataset.act === 'remove' && dk) { desk('remove', { desktop: dk.dataset.id }); return; }
    if (btn && btn.dataset.act === 'create') { desk('create'); return; }
    if (t) { activate(Number(t.dataset.i)); return; }
    if (dk && dk.dataset.id) {
      if (e.target.classList.contains('desk-name-in')) return;
      if (e.detail > 1) return;                   // the second click of a double-click renames
      var id = dk.dataset.id;
      clearTimeout(S.clickTimer);
      // wait out a possible double-click before switching (a switch closes Task View)
      S.clickTimer = setTimeout(function () { if (canWrite()) desk('switch', { desktop: id }); }, 260);
      return;
    }
    if (e.target.closest && (e.target.closest('.pill') || e.target.closest('.toast'))) return;
    dismiss('click-away');                        // the empty glass: close, like Windows
  });
  document.addEventListener('dblclick', function (e) {
    var dk = deskOf(e.target);
    if (dk && dk.dataset.id) { clearTimeout(S.clickTimer); startRename(dk.dataset.id); }
  });
  document.addEventListener('focusout', function (e) {
    if (e.target && e.target.id === 'renameInput' && S.renaming) finishRename(true);
  });
  document.addEventListener('wheel', function (e) {
    if (!S.lay || !S.lay.scrolls) return;
    var next = Math.max(0, Math.min(S.lay.rows - S.lay.visibleRows, S.first + (e.deltaY > 0 ? 1 : -1)));
    if (next === S.first) return;
    S.first = next;
    var row = Math.floor(S.sel / S.lay.cols);
    if (row < next) S.sel = next * S.lay.cols;
    if (row >= next + S.lay.visibleRows) S.sel = (next + S.lay.visibleRows - 1) * S.lay.cols;
    renderAll();
  }, { passive: true });
  window.addEventListener('resize', function () { if (S.seq) renderAll(); });

  // ------------------------------------------------------------------ main's events

  var on = window.mantle && window.mantle.on;
  if (!on) { document.body.classList.remove('is-idle'); emptyEl.textContent = 'Task View has no bridge to Mantle (window.mantle is missing).'; return; }

  window.mantle.on('taskview.open', function (m) {
    S.seq = m.seq; S.items = m.list || []; S.desktops = m.desktops || null; S.others = m.others || [];
    S.query = ''; S.sel = 0; S.first = 0; S.thumbs = {}; S.thumbsWhy = null; S.zone = 'grid';
    S.renaming = null; S.drag = null; S.busy = false; S.glass = m.glass || null; S.listReason = m.listReason || null;
    if (m.selHwnd) {
      for (var i = 0; i < S.items.length; i++) if (S.items[i].hwnd === m.selHwnd) { S.sel = i; break; }
    }
    document.body.classList.toggle('no-glass', !(S.glass && S.glass.ok));
    document.body.classList.remove('is-idle');
    toast.classList.remove('on');
    renderAll(S.items[S.sel] ? S.items[S.sel].hwnd : null);
  });
  window.mantle.on('taskview.update', function (m) { if (m && m.seq === S.seq) applyUpdate(m); });
  window.mantle.on('taskview.icons', function (m) {
    if (!m || m.seq !== S.seq) return;
    for (var i = 0; i < S.items.length; i++) {
      var got = m.icons && m.icons[S.items[i].hwnd];
      if (got) { S.items[i].icon = got.icon || null; S.items[i].iconReason = got.reason || null; }
    }
    renderAll();
  });
  window.mantle.on('taskview.thumbs', function (m) {
    if (!m || m.seq !== S.seq) return;
    S.thumbsWhy = m.ok ? null : (m.reason || 'the previews could not be drawn');
    var changed = false;
    (m.thumbs || []).forEach(function (t) {
      var was = S.thumbs[t.hwnd];
      if (!was || was.ok !== t.ok || was.minimized !== t.minimized) changed = true;
      S.thumbs[t.hwnd] = { ok: !!t.ok, reason: t.reason || null, minimized: !!t.minimized };
    });
    // Only the words under a picture change; the boxes do not move, so no second report.
    if (changed) {
      var tiles = grid.querySelectorAll('.tile');
      for (var i = 0; i < tiles.length; i++) {
        var th = S.thumbs[tiles[i].dataset.hwnd];
        var it = S.shown[Number(tiles[i].dataset.i)];
        tiles[i].querySelector('.pv-why').textContent = th && !th.ok ? 'No preview: ' + th.reason : ((it && it.minimized) || (th && th.minimized)) ? 'Minimized' : '';
      }
    }
    renderFoot();
  });
  window.mantle.on('taskview.notice', function (m) { if (m && (!m.seq || m.seq === S.seq)) showToast(m.text || 'it failed'); });
  window.mantle.on('taskview.end', function (m) {
    if (m && m.seq && m.seq !== S.seq) return;
    S.seq = 0; S.items = []; S.shown = []; S.drag = null; S.renaming = null;
    grid.textContent = ''; desksEl.textContent = ''; dragChip.classList.remove('on');
    document.body.classList.add('is-idle');
  });
})();
