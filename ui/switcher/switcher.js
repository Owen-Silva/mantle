/* switcher.js — the page of Mantle's Alt+Tab overlay.
 *
 * IT DRAWS; IT DECIDES NOTHING. The sidecar owns every Alt+Tab (the keys, the order, the
 * selection, the switch) and main owns the window (lib/switcher.js). This page is handed a
 * session, draws it while the window is still parked off screen, measures where the preview boxes
 * landed and says so (switcher.painted): main registers the DWM thumbnails at those boxes and
 * only then moves the window on screen. If this page is slow, hung or gone, Alt+Tab still
 * switches: nothing here is on that road.
 *
 * Events from main:  switcher.session / .move / .end / .icons / .thumbs / .backdrop
 *                    switcher.notice / .notice.end
 * Calls to main:     switcher.ready, switcher.painted, switcher.pick (a click), switcher.dismiss
 */
(function () {
  'use strict';

  var M = window.mantle;
  var Lay = window.SwitcherLayout;
  var root = document.documentElement;
  var body = document.body;
  var $ = function (id) { return document.getElementById(id); };
  var rows = $('rows');
  var bdrop = $('bdrop');
  var bcan = $('backdrop');
  var foot = $('foot');
  var noteT = $('noteTitle');
  var noteX = $('noteText');

  var S = {
    seq: 0,
    open: false,
    list: [],
    tiles: [],        // [{el, pv, why, ico}]
    sel: -1,
    lay: null,
    first: 0,
    t0: 0,
    bseq: 0,          // the session the backdrop on screen belongs to
    noteId: 0,
    feet: {},         // what is degraded in this Alt+Tab, by topic
  };

  if (!M || typeof M.on !== 'function') {
    // Loaded with neither the preload nor the mock: say so where a person looking at it will see.
    body.classList.add('noting');
    noteT.textContent = "The switcher couldn't connect to Mantle";
    noteX.textContent = 'Restart Mantle from its tray icon to fix it. Alt+Tab still switches windows meanwhile.';
    return;
  }

  /* ---- the words on screen ---------------------------------------------------------------------
   * Plain, short, and each one says what it means for the person (quality pass, 2026-09-29). The
   * machinery behind them (DWM error codes, capture failures, a sidecar that did not answer) is in
   * main's log, never here: BRIEF "no jargon on screen", and No Silent Failures still holds because
   * every degraded thing below still says so, in words. */
  var WORDS = {
    noPreviews: "Previews aren't available right now",
    offset: 'Previews may sit a little off their tiles',
    noBlur: 'No background blur this time',
    order: 'Shown in screen order, not most recent first',
    pick: "That click didn't switch. Let go of Alt to switch instead.",
  };

  /** The reason inside a preview box that has no picture, in plain words. */
  function plainThumb(reason) {
    var r = String(reason || '');
    if (/(has|window) closed/i.test(r)) return 'This window has closed';
    if (/not allowed|refused access|access denied/i.test(r)) return "Windows doesn't let Mantle preview this window";
    if (/cloak|hidden|another desktop|suspended/i.test(r)) return 'Windows is keeping this window out of sight, so there is no preview';
    if (/0 x 0|no room/i.test(r)) return 'This window has no size right now, so there is no preview';
    return "Windows didn't give Mantle a preview of this window";
  }

  function px(v) { return (Math.round(Number(v) * 100) / 100) + 'px'; }

  function setGeometry(lay) {
    var v = {
      '--m': px(lay.margin), '--pw': px(lay.panelW), '--ph': px(lay.panelH),
      '--pad': px(lay.pad), '--gap': px(lay.gap), '--cols': String(Math.max(1, lay.cols || 1)),
      '--tw': px(lay.tileW), '--th': px(lay.tileH), '--pvw': px(lay.previewW), '--pvh': px(lay.previewH),
      '--inset': px(lay.inset), '--caph': px(lay.capH), '--gw': px(lay.gridW), '--gh': px(lay.gridH),
    };
    for (var k in v) root.style.setProperty(k, v[k]);
  }

  function setFirst(first) {
    S.first = first;
    root.style.setProperty('--first', String(first));
    // Whole rows are hidden when there are too many windows; say how many, or they are just gone.
    var lay = S.lay;
    if (lay && lay.scroll) {
      var above = first * lay.cols;
      var below = Math.max(0, S.list.length - (first + lay.visibleRows) * lay.cols);
      var bits = [];
      if (above) bits.push(above + ' more above');
      if (below) bits.push(below + ' more below');
      setFoot('scroll', bits.join(', '));
    } else if (S.feet.scroll) {
      setFoot('scroll', '');
    }
  }

  /* ---- the foot line: every degraded thing in this Alt+Tab, in words ------------------------ */
  function setFoot(topic, words) {
    if (words) S.feet[topic] = words; else delete S.feet[topic];
    var all = [];
    for (var k in S.feet) all.push(S.feet[k]);
    foot.textContent = all.join(' · ');
    foot.title = foot.textContent;
  }

  /* ---- tiles ----------------------------------------------------------------------------------- */
  function letterOf(title) {
    var m = String(title || '').match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '?';
  }

  function letterIcon(title, why) {
    var s = document.createElement('span');
    s.className = 'ico letter';
    s.textContent = letterOf(title);
    // The letter IS the fallback; the reason rides along for whoever hovers it.
    if (why) s.title = why;
    return s;
  }

  function iconEl(it) {
    if (!it.icon) return letterIcon(it.title, it.iconReason);
    var img = document.createElement('img');
    img.className = 'ico';
    img.alt = '';
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(letterIcon(it.title, 'the icon image would not decode'), img);
    });
    img.src = it.icon;
    return img;
  }

  function chip(text, warn) {
    var c = document.createElement('span');
    c.className = warn ? 'chip warn' : 'chip';
    c.textContent = text;
    return c;
  }

  function tileOf(it, i) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.dataset.i = String(i);
    el.title = it.title || '';
    var pv = document.createElement('div');
    pv.className = 'pv';
    var why = document.createElement('span');
    why.className = 'pv-why';
    pv.appendChild(why);
    var cap = document.createElement('div');
    cap.className = 'cap';
    var ico = iconEl(it);
    cap.appendChild(ico);
    var ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = it.title || 'Untitled window';
    cap.appendChild(ttl);
    if (it.hung) cap.appendChild(chip('not responding', true));
    else if (it.minimized) cap.appendChild(chip('minimized', false));
    el.appendChild(pv);
    el.appendChild(cap);
    return { el: el, pv: pv, why: why, ico: ico, cap: cap };
  }

  /** Move the ring. True if the visible rows changed (the previews must follow). */
  function select(i) {
    var old = S.tiles[S.sel];
    if (old) { old.el.classList.remove('is-sel'); old.el.setAttribute('aria-selected', 'false'); }
    S.sel = i;
    var t = S.tiles[i];
    if (t) { t.el.classList.add('is-sel'); t.el.setAttribute('aria-selected', 'true'); }
    var first = Lay ? Lay.firstRow(S.lay, i, S.first) : 0;
    if (first !== S.first) { setFirst(first); return true; }
    return false;
  }

  /* ---- telling main where the pictures go --------------------------------------------------- */

  /**
   * After the NEXT frame has been produced (two rAFs), measure every VISIBLE preview box and hand
   * them to main. Only visible rows: a picture for a row scrolled out of the grid would be drawn
   * by DWM over the panel's edge, because DWM does not know about CSS clipping.
   */
  function report(why) {
    if (!S.open) return;
    var seq = S.seq;
    // Where the time goes, for main's log: the drawing itself, then the first and second frame.
    var built = performance.now() - S.t0;
    var raf1 = 0;
    requestAnimationFrame(function () {
      raf1 = performance.now() - S.t0;
      requestAnimationFrame(function () {
        if (!S.open || S.seq !== seq) return;
        var lay = S.lay;
        var boxes = [];
        var from = S.first * lay.cols;
        var to = Math.min(S.list.length, (S.first + lay.visibleRows) * lay.cols);
        for (var i = from; i < to; i++) {
          var r = S.tiles[i].pv.getBoundingClientRect();
          boxes.push({ hwnd: S.list[i].hwnd, x: r.left, y: r.top, w: r.width, h: r.height });
        }
        M.call('switcher.painted', {
          seq: seq, why: why, boxes: boxes,
          dpr: window.devicePixelRatio || 1,
          vw: window.innerWidth, vh: window.innerHeight,
          ms: Math.round((performance.now() - S.t0) * 10) / 10,
          built: Math.round(built * 10) / 10,
          raf1: Math.round(raf1 * 10) / 10,
          vis: document.visibilityState,
        }).catch(function () {
          setFoot('thumbs', WORDS.noPreviews);
        });
      });
    });
  }

  /* ---- events from main ------------------------------------------------------------------------ */

  // Every caller runs while the window is parked, so nothing fades (switcher.css body.snap).
  function clearBackdrop() {
    body.classList.add('snap');
    bdrop.classList.remove('on');
    body.classList.add('no-backdrop');
    bcan.width = 0;
    bcan.height = 0;
    S.bseq = 0;
  }

  // The picture is the capture's quarter size and the canvas stretches it over its box, so
  // --lg-blur's radius (CSS px of this window) shrinks by the same factor before it is drawn.
  function paintBackdrop(img) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var ctx = bcan.getContext('2d');
    var boxW = bcan.clientWidth;
    if (!ctx || !w || !h || !boxW) return false;
    var token = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim() || 'blur(12px)';
    bcan.width = w;
    bcan.height = h;
    ctx.filter = token.replace(/blur\(\s*([\d.]+)px\s*\)/, function (_m, n) {
      return 'blur(' + (Number(n) * w / boxW).toFixed(2) + 'px)';
    });
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    return true;
  }

  M.on('switcher.session', function (p) {
    if (!p || !p.lay) return;
    S.t0 = performance.now();
    S.seq = p.seq;
    S.open = true;
    S.list = Array.isArray(p.list) ? p.list : [];
    S.lay = p.lay;
    S.sel = -1;
    S.feet = {};
    foot.textContent = '';
    body.classList.remove('noting');
    S.noteId = 0;
    clearBackdrop();
    setGeometry(p.lay);
    setFirst(0);
    body.classList.toggle('is-empty', S.list.length === 0);
    var frag = document.createDocumentFragment();
    S.tiles = S.list.map(function (it, i) {
      var t = tileOf(it, i);
      frag.appendChild(t.el);
      return t;
    });
    rows.textContent = '';
    rows.appendChild(frag);
    select(typeof p.sel === 'number' ? p.sel : -1);
    if (p.tracking === false) setFoot('order', WORDS.order);
    report('session');
  });

  M.on('switcher.move', function (p) {
    if (!p || p.seq !== S.seq || !S.open) return;
    if (select(p.sel)) report('scroll');
  });

  M.on('switcher.end', function (p) {
    if (!p || p.seq !== S.seq) return;
    S.open = false;
    rows.textContent = '';
    S.tiles = [];
    S.list = [];
    clearBackdrop();
    S.feet = {};
    foot.textContent = '';
  });

  M.on('switcher.icons', function (p) {
    if (!p || p.seq !== S.seq || !p.icons) return;
    S.list.forEach(function (it, i) {
      var got = p.icons[it.hwnd];
      if (!got) return;
      it.icon = got.icon || null;
      it.iconReason = got.reason || null;
      var t = S.tiles[i];
      var fresh = iconEl(it);
      t.cap.replaceChild(fresh, t.ico);
      t.ico = fresh;
    });
  });

  M.on('switcher.thumbs', function (p) {
    if (!p || p.seq !== S.seq) return;
    var by = {};
    (p.thumbs || []).forEach(function (t) { by[t.hwnd] = t; });
    var failed = 0;
    S.tiles.forEach(function (tile, i) {
      var t = by[S.list[i].hwnd];
      if (!t) return;                       // scrolled out of view: no box was sent for it
      tile.why.textContent = t.ok ? '' : plainThumb(t.reason);
      if (!t.ok) failed++;
    });
    if (p.ok === false) setFoot('thumbs', WORDS.noPreviews);
    else if (p.reason) setFoot('thumbs', WORDS.offset);
    else setFoot('thumbs', failed && failed === (p.thumbs || []).length ? WORDS.noPreviews : '');
  });

  M.on('switcher.backdrop', function (p) {
    if (!p || p.seq !== S.seq || !S.open) return;
    if (!p.png) {
      setFoot('blur', WORDS.noBlur);
      return;
    }
    var seq = p.seq;
    var img = new Image();
    img.src = p.png;
    // decode() does the PNG work off this thread; what is left here is one small blur.
    img.decode().then(function () {
      if (S.seq !== seq || !S.open) return;
      if (!paintBackdrop(img)) { setFoot('blur', WORDS.noBlur); return; }
      S.bseq = seq;
      // A picture that lands after the window came on screen cross-fades in; before, it snaps.
      body.classList.toggle('snap', !p.shown);
      bdrop.classList.add('on');
      body.classList.remove('no-backdrop');
    }, function () {
      if (S.seq === seq && S.open) setFoot('blur', WORDS.noBlur);
    });
  });

  M.on('switcher.notice', function (p) {
    if (!p || !p.lay) return;
    S.open = false;
    rows.textContent = '';
    S.tiles = [];
    clearBackdrop();
    foot.textContent = '';
    S.noteId = p.id;
    setGeometry({ margin: p.lay.margin, panelW: p.lay.panelW, panelH: p.lay.panelH, pad: 0, gap: 0, cols: 1, tileW: 0, tileH: 0, previewW: 0, previewH: 0, inset: 0, capH: 0, gridW: 0, gridH: 0 });
    body.classList.remove('is-empty');
    body.classList.add('noting');
    noteT.textContent = p.title || 'Alt+Tab';
    noteX.textContent = p.text || '';
    var id = p.id;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (S.noteId !== id) return;
        M.call('switcher.painted', { notice: id, vw: window.innerWidth, vh: window.innerHeight }).catch(function () {});
      });
    });
  });

  M.on('switcher.notice.end', function (p) {
    if (!p || p.id !== S.noteId) return;
    S.noteId = 0;
    body.classList.remove('noting');
  });

  /* ---- the mouse ------------------------------------------------------------------------------- */

  // No focus, no text selection, ever: this window is never activated.
  document.addEventListener('mousedown', function (e) { e.preventDefault(); });

  rows.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tile') : null;
    if (!t || !S.open) return;
    var index = Number(t.dataset.i);
    M.call('switcher.pick', { seq: S.seq, index: index }).then(function (r) {
      if (r && r.ok === false) setFoot('pick', WORDS.pick);
    }).catch(function () {
      setFoot('pick', WORDS.pick);
    });
  });

  $('note').addEventListener('click', function () {
    M.call('switcher.dismiss', {}).catch(function () {});
  });

  // The window is resized for every Alt+Tab; main waits for a report from the new size.
  window.addEventListener('resize', function () { if (S.open) report('resize'); });

  M.call('switcher.ready', {}).catch(function (err) {
    console.error('switcher.ready did not reach Mantle: ' + err.message);
  });
})();
