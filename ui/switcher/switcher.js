/* switcher.js — the page of Mantle's Alt+Tab overlay.
 *
 * IT DRAWS; IT DECIDES NOTHING. The sidecar owns every Alt+Tab (the keys, the order, the
 * selection, the switch) and main owns the window (lib/switcher.js). This page is handed a
 * session, draws it while the window is still parked off screen, measures where the preview boxes
 * landed and says so (switcher.painted): main registers the DWM thumbnails at those boxes and
 * only then moves the window on screen. If this page is slow, hung or gone, Alt+Tab still
 * switches: nothing here is on that road.
 *
 * Events from main:  switcher.session / .move / .windows / .end / .icons / .thumbs / .backdrop
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
    tiles: [],        // [{el, pv, why, ico, cap, ttl}]
    win: null,        // the window's size in DIP: the panel's at open; a live list can grow it
    cap: null,        // where the backdrop picture was taken, in window DIP (switcher.windows pins it)
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
  var BLEED = 14;      // the backdrop is taken this much past the panel on every side (lib/switcher.js captureBackdrop)

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

  /** `win`: the window's DIP size, when it is bigger than the panel (a list that changed while the
   *  switcher was up): the panel stays centred across it, at the same top. */
  function setGeometry(lay, win) {
    var pl = win && win.w > lay.panelW ? (win.w - lay.panelW) / 2 : lay.margin;
    var v = {
      '--m': px(lay.margin), '--pl': px(pl), '--pw': px(lay.panelW), '--ph': px(lay.panelH),
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
    el.dataset.hwnd = String(it.hwnd);
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
    // sentence case, like every other label in Mantle
    if (it.hung) cap.appendChild(chip('Not responding', true));
    else if (it.minimized) cap.appendChild(chip('Minimized', false));
    el.appendChild(pv);
    el.appendChild(cap);
    return { el: el, pv: pv, why: why, ico: ico, cap: cap, ttl: ttl };
  }

  /** A tile that stays through a list change: only what changed on it is touched. */
  function refreshTile(t, was, it) {
    if ((was.title || '') !== (it.title || '')) {
      t.el.title = it.title || '';
      t.ttl.textContent = it.title || 'Untitled window';
      if (!it.icon && t.ico.classList.contains('letter')) t.ico.textContent = letterOf(it.title);
    }
    if (!!was.hung !== !!it.hung || !!was.minimized !== !!it.minimized) {
      var old = t.cap.querySelector('.chip');
      if (old) old.remove();
      if (it.hung) t.cap.appendChild(chip('Not responding', true));
      else if (it.minimized) t.cap.appendChild(chip('Minimized', false));
    }
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
    lastPic = null;
  }

  // The picture is the capture's quarter size and the canvas stretches it over its box, so
  // --lg-blur's radius (CSS px of this window) shrinks by the same factor before it is drawn.
  function paintBackdrop(img) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var ctx = bcan.getContext('2d');
    var boxW = bcan.clientWidth;
    if (!ctx || !w || !h || !boxW) return false;
    var token = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim() || 'blur(5px)';   // = the dark token (Helm's blur); only if --lg-blur failed to load
    bcan.width = w;
    bcan.height = h;
    ctx.filter = token.replace(/blur\(\s*([\d.]+)px\s*\)/, function (_m, n) {
      return 'blur(' + (Number(n) * w / boxW).toFixed(2) + 'px)';
    });
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    lastPic = img;
    adaptBackdrop();
    return true;
  }

  /* DARK ONLY: THE ONE READABILITY GUARD (ui/shared/glass-adapt.js guard(), the top bar's rule, same
     code and thresholds; lane same-shell, 2026-10-09, replacing see-glass-b's picture dimming). The pane
     is one layer of --lg-fill over the blurred capture; the tint thickens (never the picture dimming)
     only as far as --lg-ink-2 needs for 4.5:1 over the brightest blurred pixel, capped at --lg-fill-pop,
     into --pane-tint on :root (the dark .panel reads it). With --lg-fill-pop = --lg-fill (the FINAL
     tokens) there is nothing to thicken and nothing is read. Once per capture, never on a timer; in
     light nothing runs. window.__switcherGlass is a read-only view. */
  var GA = window.MantleGlassAdapt || null;
  var lastPic = null;
  var adaptSaid = '';
  function adaptBackdrop() {
    root.style.removeProperty('--pane-tint');
    window.__switcherGlass = null;
    if (root.getAttribute('data-theme') !== 'dark' || !lastPic) return;
    var T = GA ? GA.guardTokens(getComputedStyle(root)) : null;
    if (T && !(T.ceil > T.fill.a + 1e-9)) { window.__switcherGlass = { alpha: T.fill.a, engaged: false, why: 'ceiling = fill' }; adaptSaid = ''; return; }
    var px = T ? GA.pixelsOf(lastPic) : null;
    // the raw capture (not the canvas, which is already blurred): guard() blurs it the way the page does
    var r = px ? GA.guard(px, { tokens: T, picPerCss: lastPic.naturalWidth / (bcan.clientWidth || lastPic.naturalWidth) }) : null;
    if (r) {
      window.__switcherGlass = { alpha: r.alpha, ratio: r.ratio, engaged: r.engaged };
      if (r.engaged) root.style.setProperty('--pane-tint', r.tint);
      adaptSaid = '';
      return;
    }
    var why = GA ? 'the capture behind the switcher could not be read back' : 'ui/shared/glass-adapt.js did not load';
    if (adaptSaid !== why) { adaptSaid = why; console.warn('[switcher] dark glass at the token tint: ' + why); }
  }
  window.addEventListener('mantle-theme', adaptBackdrop);

  M.on('switcher.session', function (p) {
    if (!p || !p.lay) return;
    S.t0 = performance.now();
    S.seq = p.seq;
    S.open = true;
    S.capLost = false;
    S.list = Array.isArray(p.list) ? p.list : [];
    S.lay = p.lay;
    S.win = p.win || { w: p.lay.w, h: p.lay.h };
    S.cap = { x: p.lay.margin - BLEED, y: p.lay.margin - BLEED, w: p.lay.panelW + 2 * BLEED, h: p.lay.panelH + 2 * BLEED };
    S.sel = -1;
    S.feet = {};
    foot.textContent = '';
    body.classList.remove('noting');
    body.classList.remove('is-live');
    ['--bcx', '--bcy', '--bcw', '--bch'].forEach(function (k) { root.style.removeProperty(k); });
    S.noteId = 0;
    clearBackdrop();
    setGeometry(p.lay, S.win);
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

  /*
   * THE LIST CHANGED WHILE IT IS UP (lib/switcher.js onReflow, lane mn-alttab, 2026-10-12): a
   * window opened, closed, hid, was minimised or renamed. Re-rendered IN PLACE, the way macOS does it:
   *   - a tile that stays is the SAME element (no rebuild, so nothing flashes); only its title or
   *     its chip is touched if that changed;
   *   - a new tile fades in (--lg-dur-ui-slow on --lg-ease-ui); a closed one leaves, and the ones
   *     after it take its slot;
   *   - the tiles keep their size and columns (Layout.reflow) and the panel keeps its centre and
   *     top, so the width only changes when a single row gets shorter or longer;
   *   - a panel losing a row glides up; one gaining a row snaps, because a DWM preview cannot be
   *     clipped and would hang below a panel still growing;
   *   - the backdrop picture stays where it was taken (pinned, never stretched); if the window had
   *     to grow past it, it fades out to the plain pane and the foot says so.
   * Nothing moves that did not change, and the previews follow from the new report.
   */
  M.on('switcher.windows', function (p) {
    if (!p || p.seq !== S.seq || !S.open || !p.lay) return;
    var list = Array.isArray(p.list) ? p.list : [];
    var was = {};
    S.list.forEach(function (it, i) { was[it.hwnd] = { it: it, t: S.tiles[i] }; });
    var stays = {};
    var tiles = list.map(function (it, i) {
      var o = was[it.hwnd];
      var t;
      if (o) {
        stays[it.hwnd] = true;
        t = o.t;
        if (!('icon' in it)) { it.icon = o.it.icon; it.iconReason = o.it.iconReason; }
        refreshTile(t, o.it, it);
      } else {
        t = tileOf(it, i);
        t.el.classList.add('is-new');
      }
      t.el.dataset.i = String(i);
      t.el.classList.remove('is-sel');
      t.el.setAttribute('aria-selected', 'false');
      return t;
    });
    S.list.forEach(function (it, i) { if (!stays[it.hwnd]) S.tiles[i].el.remove(); });
    // Insert only what is new: the merge keeps the order of the tiles that stay, so they are never moved.
    var ref = rows.firstChild;
    tiles.forEach(function (t) {
      if (t.el === ref) { ref = ref.nextSibling; return; }
      rows.insertBefore(t.el, ref);
    });
    var oldH = S.lay ? S.lay.panelH : 0;
    body.classList.toggle('is-live', p.lay.panelH < oldH - 0.5);
    S.list = list;
    S.tiles = tiles;
    S.lay = p.lay;
    if (p.win) S.win = p.win;
    setGeometry(p.lay, S.win);
    pinBackdrop(!!p.grew);
    body.classList.toggle('is-empty', list.length === 0);
    S.sel = -1;
    // the rows it starts at, clamped to the new grid (this also redoes "n more below")
    setFirst(S.lay.scroll ? Math.max(0, Math.min(S.first, S.lay.rows - S.lay.visibleRows)) : 0);
    select(typeof p.sel === 'number' && p.sel < list.length ? p.sel : -1);
    report('reflow');
  });

  /** Keep the backdrop where it was taken; past it (the window grew), fade to the plain pane. */
  function pinBackdrop(grew) {
    if (!S.cap || !S.lay) return;
    if (grew) {
      S.capLost = true;
      if (bdrop.classList.contains('on')) {
        body.classList.remove('snap');
        bdrop.classList.remove('on');
        body.classList.add('no-backdrop');
        setFoot('blur', WORDS.noBlur);
      }
      return;
    }
    var pl = S.win && S.win.w > S.lay.panelW ? (S.win.w - S.lay.panelW) / 2 : S.lay.margin;
    root.style.setProperty('--bcx', px(S.cap.x - pl));
    root.style.setProperty('--bcy', px(S.cap.y - S.lay.margin));
    root.style.setProperty('--bcw', px(S.cap.w));
    root.style.setProperty('--bch', px(S.cap.h));
  }

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
    if (S.capLost) { setFoot('blur', WORDS.noBlur); return; }    // taken for a smaller window than this one now is
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
    // the window too: if the list changed under the click, main sends it to where that window is now
    M.call('switcher.pick', { seq: S.seq, index: index, hwnd: t.dataset.hwnd }).then(function (r) {
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
