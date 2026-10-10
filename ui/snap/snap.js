/* snap.js - the page behind Mantle's snap window: the Win+Z picker, Snap Assist and the notice
 * (wave 3, 2026-09-24).
 *
 * MAIN DRIVES, THE PAGE DRAWS. lib/features/snap.js sizes and places the window, then says
 *   snap.show  {seq, mode:'picker', app:{exe,title}}
 *              {seq, mode:'assist', zone:{name}, candidates:[{hwnd,title,exe,icon,minimized}], left}
 *              {seq, mode:'notice', title, text}
 *   snap.thumbs {seq, ok, reason, thumbs:[{hwnd, ok, reason}]}   (how each live picture went)
 *   snap.hide  {seq}
 * and the page answers
 *   snap.painted  {seq, mode, boxes:[{hwnd,x,y,w,h}] (CSS px), dpr, vw, vh, ms}   (drawn: reveal me)
 *   snap.pick     {seq, layout, zone}  (picker)   |   {seq, hwnd}  (assist)
 *   snap.dismiss  {seq, why: 'esc' | 'click-away'}
 *
 * KEYBOARD, everywhere: arrows move, Enter/Space choose, Esc closes; Tab walks like the arrows.
 * Picker: Left/Right walk every zone of every layout in reading order, Up/Down jump a row of
 * layouts, 1-5 pick a layout. Assist: arrows move through the grid, whole rows scroll.
 */
(function () {
  'use strict';
  var M = window.mantle;
  var L = window.SnapLayouts;
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    seq: 0,
    mode: 'none',
    shownAt: 0,
    pick: { li: 0, zi: 0 },
    cands: [],
    sel: 0,
    first: 0,          // first visible row of the assist grid
    lay: null,
    why: {},           // hwnd -> the reason its picture is missing
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setMode(m) {
    S.mode = m;
    document.body.className = 'mode-' + m + (m === 'assist' && !S.cands.length ? ' is-empty' : '');
  }

  if (!M || !L) {
    setMode('notice');
    $('noticeTitle').textContent = 'The snap page cannot work';
    $('noticeText').textContent = !M ? 'window.mantle is missing (preload.js did not run).' : 'layouts.js did not load.';
    return;
  }

  function call(cmd, args) {
    try {
      var r = M.call(cmd, args);
      if (r && typeof r.catch === 'function') r.catch(function (err) { console.error('snap: ' + cmd + ' failed: ' + err.message); });
      return r;
    } catch (err) { console.error('snap: ' + cmd + ' threw: ' + err.message); return null; }
  }

  /** After the frame with this state is produced (two rAFs), tell main: it reveals on this. */
  function painted() {
    var seq = S.seq, t0 = S.shownAt;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (seq !== S.seq) return;
        call('snap.painted', {
          seq: seq, mode: S.mode, boxes: S.mode === 'assist' ? boxes() : [],
          dpr: window.devicePixelRatio || 1, vw: window.innerWidth, vh: window.innerHeight,
          ms: Math.round((performance.now() - t0) * 10) / 10,
        });
      });
    });
  }

  function dismiss(why) {
    if (S.mode === 'none') return;
    call('snap.dismiss', { seq: S.seq, why: why });
  }

  /* ---- Win+Z: the picker ------------------------------------------------------------------- */

  function buildPicker(p) {
    var app = p.app || {};
    $('pickApp').textContent = app.exe || app.title ? 'for ' + (app.exe || app.title) : '';
    var host = $('layouts');
    host.textContent = '';
    L.LAYOUTS.forEach(function (lay, li) {
      var tile = el('div', 'layout');
      tile.setAttribute('role', 'group');
      tile.setAttribute('aria-label', (li + 1) + ': ' + lay.label);
      tile.style.gridTemplateColumns = 'repeat(' + lay.grid[0] + ', 1fr)';
      tile.style.gridTemplateRows = 'repeat(' + lay.grid[1] + ', 1fr)';
      lay.zones.forEach(function (z, zi) {
        var b = el('button', 'zone');
        b.type = 'button';
        b.tabIndex = -1;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-label', lay.label + ', ' + lay.names[zi]);
        b.title = lay.names[zi];
        b.style.gridColumn = (z[0] + 1) + ' / span ' + z[2];
        b.style.gridRow = (z[1] + 1) + ' / span ' + z[3];
        b.dataset.li = li;
        b.dataset.zi = zi;
        b.addEventListener('mouseenter', function () { selectZone(li, zi); });
        b.addEventListener('click', function () { selectZone(li, zi); pickZone(); });
        tile.appendChild(b);
      });
      host.appendChild(tile);
    });
    S.pick = { li: 0, zi: 0 };
    selectZone(0, 0);
  }

  function selectZone(li, zi) {
    S.pick = { li: li, zi: zi };
    var zs = document.querySelectorAll('.zone');
    for (var i = 0; i < zs.length; i++) {
      var on = Number(zs[i].dataset.li) === li && Number(zs[i].dataset.zi) === zi;
      zs[i].classList.toggle('sel', on);
      zs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var lay = L.LAYOUTS[li];
    $('pickFoot').textContent = lay.label + ': ' + lay.names[zi] + ' · Enter snaps · Esc closes';
  }

  /** Every zone of every layout in reading order: what Left/Right/Tab walk. */
  function flat() {
    var out = [];
    L.LAYOUTS.forEach(function (lay, li) { lay.zones.forEach(function (_z, zi) { out.push([li, zi]); }); });
    return out;
  }

  function stepZone(d) {
    var f = flat();
    var i = 0;
    for (var k = 0; k < f.length; k++) if (f[k][0] === S.pick.li && f[k][1] === S.pick.zi) i = k;
    var n = f[(i + d + f.length) % f.length];
    selectZone(n[0], n[1]);
  }

  function stepRow(d) {
    var li = S.pick.li + d * L.COLS;
    if (li < 0 || li >= L.LAYOUTS.length) return;
    selectZone(li, Math.min(S.pick.zi, L.LAYOUTS[li].zones.length - 1));
  }

  function pickZone() {
    var lay = L.LAYOUTS[S.pick.li];
    call('snap.pick', { seq: S.seq, layout: lay.id, zone: S.pick.zi });
  }

  /* ---- Snap Assist ------------------------------------------------------------------------- */

  var TILE_MAX = 300, TILE_MIN = 150, CAP = 28, TILE_PAD = 6, GAP = 8;

  /** Tiles as large as fit (TILE_MAX .. TILE_MIN wide, previews 16:10), whole rows only. */
  function layoutAssist(n, W, H) {
    var tw = TILE_MAX, cols, rows, th;
    for (; ; tw -= 10) {
      cols = Math.max(1, Math.floor((W + GAP) / (tw + GAP)));
      rows = Math.ceil(n / cols);
      th = Math.round((tw - 2 * TILE_PAD) * 10 / 16) + 2 * TILE_PAD + CAP;
      if (rows * th + (rows - 1) * GAP <= H || tw <= TILE_MIN) break;
    }
    var vis = Math.max(1, Math.min(rows, Math.floor((H + GAP) / (th + GAP))));
    var usedW = cols * tw + (cols - 1) * GAP;
    var usedH = vis * th + (vis - 1) * GAP;
    return { tw: tw, th: th, cols: cols, rows: rows, vis: vis,
             x0: Math.max(0, Math.floor((W - usedW) / 2)), y0: Math.max(0, Math.floor((H - usedH) / 2)) };
  }

  function letter(c, cls) {
    var s = el('span', cls || 'letter', ((c.exe || c.title || '?').replace(/\.exe$/i, '').charAt(0) || '?').toUpperCase());
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function iconOr(c, big) {
    if (c.icon && /^data:image\//.test(c.icon)) {
      var i = el('img');
      i.src = c.icon;
      i.alt = '';
      return i;
    }
    return letter(c, big ? 'letter' : 'letter');
  }

  function buildAssist(p) {
    S.cands = Array.isArray(p.candidates) ? p.candidates : [];
    S.sel = Math.max(0, Math.min(Number(p.sel) || 0, S.cands.length - 1));
    S.first = 0;
    S.why = {};
    var zoneName = (p.zone && p.zone.name) || 'this space';
    $('assistTitle').textContent = 'Snap Assist';
    $('assistZone').textContent = 'choose a window for the ' + zoneName + (p.left > 0 ? ' (' + p.left + ' more after this)' : '');
    $('assistFoot').className = 'foot';
    $('assistFoot').textContent = S.cands.length
      ? 'Arrows choose a window · Enter puts it here · Esc closes'
      : 'Esc closes';
    var host = $('tiles');
    host.textContent = '';
    S.cands.forEach(function (c, i) {
      var t = el('div', 'tile');
      t.setAttribute('role', 'option');
      t.dataset.i = i;
      t.dataset.hwnd = String(c.hwnd);
      var pv = el('div', 'pv');
      pv.appendChild(iconOr(c, true));
      pv.appendChild(el('div', 'pv-why', ''));
      var cap = el('div', 'cap');
      cap.appendChild(iconOr(c, false));
      cap.appendChild(el('span', 't', c.title || c.exe || 'Untitled window'));
      if (c.minimized) cap.appendChild(el('span', 'min', '· minimized'));
      t.appendChild(pv);
      t.appendChild(cap);
      t.addEventListener('mouseenter', function () { selectTile(i, false); });
      t.addEventListener('click', function () { selectTile(i, false); pickTile(); });
      host.appendChild(t);
    });
    setMode('assist');
    placeTiles();
  }

  function placeTiles() {
    var host = $('tiles');
    var r = host.getBoundingClientRect();
    var lay = S.lay = layoutAssist(S.cands.length, r.width, r.height);
    var tiles = host.querySelectorAll('.tile');
    var pvh = Math.round((lay.tw - 2 * TILE_PAD) * 10 / 16);
    for (var i = 0; i < tiles.length; i++) {
      var row = Math.floor(i / lay.cols), col = i % lay.cols;
      var vr = row - S.first;
      var t = tiles[i];
      if (vr < 0 || vr >= lay.vis) { t.style.display = 'none'; continue; }
      t.style.display = '';
      t.style.left = (lay.x0 + col * (lay.tw + GAP)) + 'px';
      t.style.top = (lay.y0 + vr * (lay.th + GAP)) + 'px';
      t.style.width = lay.tw + 'px';
      t.style.height = lay.th + 'px';
      t.firstChild.style.height = pvh + 'px';
      t.classList.toggle('sel', i === S.sel);
      t.setAttribute('aria-selected', i === S.sel ? 'true' : 'false');
    }
    var old = host.querySelector('.more');
    if (old) old.remove();
    var hidden = S.cands.length - Math.min(S.cands.length, (S.first + lay.vis) * lay.cols);
    if (hidden > 0 || S.first > 0) {
      host.appendChild(el('div', 'more', (S.first > 0 ? 'more above · ' : '') + (hidden > 0 ? hidden + ' more below' : '')));
    }
  }

  function selectTile(i, scroll) {
    if (!S.cands.length) return;
    S.sel = Math.max(0, Math.min(i, S.cands.length - 1));
    var lay = S.lay;
    var row = Math.floor(S.sel / lay.cols);
    var moved = false;
    if (scroll && row < S.first) { S.first = row; moved = true; }
    if (scroll && row >= S.first + lay.vis) { S.first = row - lay.vis + 1; moved = true; }
    placeTiles();
    if (moved) painted();      // other windows are on screen now: main re-registers the pictures
  }

  function pickTile() {
    var c = S.cands[S.sel];
    if (c) call('snap.pick', { seq: S.seq, hwnd: String(c.hwnd) });
  }

  /** The visible preview boxes, in CSS px from the page's top-left: where DWM draws. */
  function boxes() {
    var out = [];
    var tiles = document.querySelectorAll('.tile');
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].style.display === 'none') continue;
      var r = tiles[i].firstChild.getBoundingClientRect();
      out.push({ hwnd: tiles[i].dataset.hwnd, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }

  M.on('snap.thumbs', function (p) {
    if (!p || p.seq !== S.seq) return;
    (p.thumbs || []).forEach(function (t) {
      var tile = document.querySelector('.tile[data-hwnd="' + String(t.hwnd).replace(/"/g, '') + '"]');
      if (!tile) return;
      tile.querySelector('.pv-why').textContent = t.ok ? '' : (t.reason || 'no picture');
    });
    if (p.ok === false || p.reason) {
      $('assistFoot').className = 'foot warn';
      $('assistFoot').textContent = 'No live pictures: ' + (p.reason || 'unknown reason');
    }
  });

  // Windows kept the keyboard on another window: say so where the key hints are.
  M.on('snap.nokeys', function (p) {
    if (!p || p.seq !== S.seq) return;
    var f = S.mode === 'picker' ? $('pickFoot') : S.mode === 'assist' ? $('assistFoot') : null;
    if (!f) return;
    f.className = 'foot warn';
    f.textContent = p.text || 'The keyboard is on another window: click instead.';
  });

  /* ---- the notice -------------------------------------------------------------------------- */

  function buildNotice(p) {
    $('noticeTitle').textContent = p.title || 'Could not snap';
    $('noticeText').textContent = p.text || '';
    setMode('notice');
  }

  /* ---- main's events ----------------------------------------------------------------------- */

  M.on('snap.show', function (p) {
    if (!p || typeof p.seq !== 'number') return;
    S.seq = p.seq;
    S.shownAt = performance.now();
    if (p.mode === 'picker') { setMode('picker'); buildPicker(p); }
    else if (p.mode === 'assist') buildAssist(p);
    else buildNotice(p);
    painted();
    // dark: one picture of what is behind the panel per show; main takes it once the window has moved
    // in from its parking spot (ui/shared/hud-backdrop.js, main.js hudBackdrop)
    if (window.MantleHudBackdrop) window.MantleHudBackdrop.request('shown', { hold: true });
  });

  M.on('snap.hide', function (p) {
    if (p && typeof p.seq === 'number' && p.seq !== S.seq) return;
    setMode('none');
    $('tiles').textContent = '';
    S.cands = [];
  });

  document.addEventListener('keydown', function (e) {
    if (S.mode === 'none') return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); dismiss('esc'); return; }
    if (S.mode === 'notice') { if (k === 'Enter' || k === ' ') { e.preventDefault(); dismiss('esc'); } return; }
    if (S.mode === 'picker') {
      if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) stepZone(1);
      else if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) stepZone(-1);
      else if (k === 'ArrowDown') stepRow(1);
      else if (k === 'ArrowUp') stepRow(-1);
      else if (k === 'Enter' || k === ' ') pickZone();
      else if (/^[1-9]$/.test(k) && Number(k) <= L.LAYOUTS.length) selectZone(Number(k) - 1, 0);
      else return;
      e.preventDefault();
      return;
    }
    if (S.mode === 'assist' && S.lay) {
      var c = S.lay.cols;
      if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) selectTile(S.sel + 1, true);
      else if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) selectTile(S.sel - 1, true);
      else if (k === 'ArrowDown') selectTile(Math.min(S.sel + c, S.cands.length - 1), true);
      else if (k === 'ArrowUp') { if (S.sel - c >= 0) selectTile(S.sel - c, true); }
      else if (k === 'Home') selectTile(0, true);
      else if (k === 'End') selectTile(S.cands.length - 1, true);
      else if (k === 'Enter' || k === ' ') pickTile();
      else return;
      e.preventDefault();
    }
  });

  // Click-away: the transparent margin round the pane is part of this window.
  $('stage').addEventListener('mousedown', function (e) {
    if (S.mode !== 'none' && !$('panel').contains(e.target)) dismiss('click-away');
  });
  // ...and anything outside the window takes the focus away from it.
  window.addEventListener('blur', function () { dismiss('click-away'); });

  // A resize by main (the next Snap Assist zone is another size) re-lays the tiles.
  window.addEventListener('resize', function () {
    if (S.mode === 'assist' && S.cands.length) { placeTiles(); painted(); }
  });

  window.__snap = S;   // for the mock harness and the --test self-check
})();
