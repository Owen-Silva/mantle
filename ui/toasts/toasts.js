/*
 * toasts.js - Mantle's notification banners, the page (lane mantle-toasts, 2026-10-15). Main
 * (lib/features/toasts.js) pushes:
 *   toasts.show { banners: [{ id, aumid, app, icon, logo, logoCircle, title, body, attribution, image, sticky, opens }], ids }
 *   toasts.ids  { ids }   every toast still in the notification centre: a banner whose toast went away goes too
 * and this page calls toasts.ready (it listens), toasts.layout { h, count } after every change (h = the
 * stack's height from the window's BOTTOM plus 8 px above it: main shapes the window to exactly that,
 * so no invisible pane eats clicks; count 0 starts the window's 30 s goodbye), toasts.click { id, banner }
 * and toasts.more.
 *
 * THE STACK (bottom right, lane mantle-toasts3): newest nearest the corner, older ones above it, at
 * most MAX on screen; the rest are "+N more" on top (a click opens the list). Every re-layout slides the
 * cards to their new places (FLIP); the window never moves while it does (main changes only its shape),
 * and a SHORTER stack is reported once the slide is over, so the shape never cuts a card mid-slide.
 * A hidden banner older than STALE_MS is dropped (it is in the list). Each banner leaves LIFE_MS after it
 * came on screen; a sticky one (alarm, reminder, call) waits for you, as in Windows. Hovering the stack
 * holds every timer; leaving gives each at least RESUME_MS more.
 * Removal never waits on an animation event (a hidden --test window never fires transitionend): a timer
 * of OUT_MS takes the card out, then the cards below slide up into place (FLIP, Web Animations).
 *
 * MANTLE'S OWN BANNERS (banner.own, lib/own-banners.js: the updater's). Same card, plus copyable detail,
 * a progress line and a right-aligned row of buttons (tpl-own). Main also pushes
 *   toasts.update { banner }  the card with that id changes IN PLACE (same card, same place, no exit/enter)
 *   toasts.drop   { id }      the card leaves (the normal exit)
 * and this page calls toasts.action { id, action } for a button or the X (action 'close'), and
 * toasts.copy { id } for Copy. A button is disabled while its action runs (one update, never two); the
 * answer's keep:false takes the card away, ok:false shows its reason on the card. A click on the card's
 * body opens nothing (no toasts.click). They are sticky, always on screen before an app's (never under
 * "+N more"), and "+N more" never takes them away.
 */
(function () {
  'use strict';
  var mantle = window.mantle;
  var MAX = 3;
  var LIFE_MS = window.__toastLifeMs || 6000;
  var RESUME_MS = window.__toastResumeMs || 1500;
  var STALE_MS = 20000;
  var OUT_MS = 200;   // the exit is 45 % of --m-dur-s (144 ms): it lands inside this
  // the shared spring (glass-light.css --m-spring), read once and proven parseable, or the old curve
  var SPRING = (function () {
    var old = 'cubic-bezier(.2,.8,.2,1)';
    try {
      var s = getComputedStyle(document.documentElement).getPropertyValue('--m-spring').replace(/\s+/g, ' ').trim();
      if (!s) return old;
      document.documentElement.animate([], { duration: 1, easing: s }).cancel();
      return s;
    } catch (_) { return old; }
  })();
  var FLIP_MS = 240;   // --m-dur-xs: the cards below move up on the shared spring (lane mantle-motion)
  var ROOM_TOP = 8;          // px the shape keeps above the stack
  var shrinkT = null;
  var stack = document.getElementById('stack');
  var tpl = document.getElementById('tpl');
  var tplOwn = document.getElementById('tpl-own');
  var COPIED_MS = 2500;      // "Copied" stays this long; a failure stays until the next try
  var items = [];            // newest first: { b, el, shown, left, due, timer, leaving, at }
  var hover = false;
  var more = null;
  var last = { h: -1, count: -1 };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function now() { return Date.now(); }
  function letterOf(s) { var m = /[A-Za-z0-9]/.exec(String(s || '')); return m ? m[0].toUpperCase() : '?'; }
  function find(id) { for (var i = 0; i < items.length; i++) if (items[i].b.id === id) return items[i]; return null; }
  function findLive(id) { for (var i = 0; i < items.length; i++) if (items[i].b.id === id && !items[i].leaving) return items[i]; return null; }
  function byEl(el) { for (var i = 0; i < items.length; i++) if (items[i].el === el) return items[i]; return null; }
  function live() { return items.filter(function (it) { return !it.leaving; }); }
  function words(err) { return err && err.message ? err.message : String(err); }

  function build(b) {
    var el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = String(b.id);
    if (b.sticky) el.classList.add('sticky');
    var ic = el.querySelector('.app-icon');
    if (b.icon) {
      var img = document.createElement('img');
      img.alt = '';
      img.addEventListener('error', function () { ic.replaceChildren(letter()); });
      img.src = b.icon;
      ic.appendChild(img);
    } else ic.appendChild(letter());
    function letter() { var l = document.createElement('span'); l.className = 'letter'; l.textContent = letterOf(b.app); return l; }
    el.querySelector('.app').textContent = b.app || 'An app';
    el.querySelector('.title').textContent = b.title || '';
    el.querySelector('.body').textContent = b.body || '';
    el.querySelector('.attr').textContent = b.attribution || '';
    var logo = el.querySelector('.logo');
    if (b.logo) {
      logo.hidden = false;
      if (b.logoCircle) logo.classList.add('circle');
      logo.addEventListener('error', function () { logo.hidden = true; report(); });
      logo.src = b.logo;
    }
    var pic = el.querySelector('.pic');
    if (b.image) {
      pic.hidden = false;
      pic.addEventListener('load', function () { report(); });
      pic.addEventListener('error', function () { pic.hidden = true; report(); });
      pic.src = b.image;
    }
    el.setAttribute('aria-label', [b.app, b.title, b.body].filter(Boolean).join('. '));
    if (b.own) { buildOwn(el, b); return el; }
    var opens = b.opens === 'protocol' ? 'Open it' : 'Go to ' + (b.app || 'the app');
    el.title = opens + ' (it stays in your notifications)';
    el.addEventListener('click', function (e) {
      if (e.target.closest('.x')) return;
      var it = find(b.id);
      if (!it || it.leaving) return;
      mantle.call('toasts.click', { id: b.id, banner: { id: b.id, aumid: b.aumid, opens: b.opens } }).catch(function () {});
      leave(it, 'clicked');
    });
    el.querySelector('.x').addEventListener('click', function (e) {
      e.stopPropagation();
      var it = find(b.id);
      if (it) leave(it, 'closed');
    });
    return el;
  }

  /* ---- Mantle's own banners: the parts (tpl-own) and how they change in place */
  function buildOwn(el, b) {
    el.classList.add('own');
    var box = tplOwn.content.firstElementChild.cloneNode(true);
    el.querySelector('.main').after(box);
    var x = el.querySelector('.x');
    x.title = 'Close';
    // no click on the card itself: Mantle's own banner opens nothing; its buttons and the X do
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      var it = byEl(el);
      if (it) act(it, 'close');
    });
    box.querySelector('.own-copy').addEventListener('click', function (e) {
      e.stopPropagation();
      var it = byEl(el);
      if (it) copy(it);
    });
    fillOwn(el, b, null);
  }
  /** The card's words and parts from banner b. `was` (the banner it showed) keeps what did not change as it
      is: the detail's text (so a selection survives a progress tick) and the buttons. */
  function fillOwn(el, b, was) {
    el.classList.toggle('tone-error', b.tone === 'error');
    el.classList.toggle('tone-ok', b.tone === 'ok');
    el.querySelector('.app').textContent = b.app || 'Mantle';
    el.querySelector('.title').textContent = b.title || '';
    el.querySelector('.body').textContent = b.body || '';
    el.setAttribute('aria-label', [b.app || 'Mantle', b.title, b.body].filter(Boolean).join('. '));
    // detail
    var dw = el.querySelector('.own-detail-wrap'), pre = el.querySelector('.own-detail');
    dw.hidden = !b.detail;
    if (b.detail && pre.textContent !== b.detail) { pre.textContent = b.detail; say(el, ''); }
    // progress
    var pw = el.querySelector('.own-progress'), p = b.progress;
    pw.hidden = !p;
    if (p) {
      var ind = typeof p.pct !== 'number' || !isFinite(p.pct);
      var pct = ind ? 0 : Math.max(0, Math.min(100, p.pct));
      var bar = pw.querySelector('.own-bar');
      pw.querySelector('.own-pwords').textContent = p.text || '';
      pw.querySelector('.own-ppct').textContent = ind ? '' : Math.round(pct) + '%';
      bar.classList.toggle('ind', ind);
      bar.firstElementChild.style.transform = ind ? '' : 'scaleX(' + (pct / 100) + ')';
      bar.setAttribute('aria-label', p.text || 'Progress');
      if (ind) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    // buttons: rebuilt only when they changed; the primary last (nearest the corner), the rest in order
    var acts = Array.isArray(b.actions) ? b.actions : [];
    var sig = JSON.stringify(acts);
    var row = el.querySelector('.own-actions');
    if (!was || row.dataset.sig !== sig) {
      row.replaceChildren();
      acts.filter(function (a) { return !a.primary; }).concat(acts.filter(function (a) { return a.primary; })).forEach(function (a) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'own-btn' + (a.primary ? ' primary' : '');
        btn.dataset.action = String(a.id);
        btn.textContent = a.label;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var it = byEl(el);
          if (it) act(it, String(a.id));
        });
        row.appendChild(btn);
      });
      row.dataset.sig = sig;
    }
    row.hidden = !acts.length;
    var it = byEl(el);
    if (it) { note(it, null, true); sync(it); }
  }
  /** A button or the X: disabled while main runs it; keep:false takes the card away, ok:false says why. */
  function act(it, action) {
    if (it.leaving || it.pending[action]) return;
    it.pending[action] = true;
    note(it, null);
    sync(it);
    function done(r, why) {
      delete it.pending[action];
      sync(it);
      if (it.leaving) return;
      var close = action === 'close';
      if ((r && r.keep === false) || (close && !(r && r.keep === true))) { leave(it, close ? 'closed' : 'done (' + action + ')'); return; }
      if (why) note(it, why);
      else if (!r || r.ok === false) note(it, (r && r.reason) || 'That did not work, and no reason came back.');
    }
    var p;
    try { p = mantle.call('toasts.action', { id: it.b.id, action: action }); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(function (r) { done(r, null); }, function (err) { done(null, 'Mantle did not answer (' + words(err) + ').'); });
  }
  /** The buttons and the X follow what is running. */
  function sync(it) {
    var row = it.el.querySelector('.own-actions');
    if (row) Array.prototype.forEach.call(row.children, function (btn) {
      var busy = !!it.pending[btn.dataset.action];
      btn.disabled = busy;
      if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
    });
    it.el.querySelector('.x').disabled = !!it.pending.close;
  }
  /** A failure under the card's text, in words; null clears it. The card may grow, so the shape follows
      (quiet: the caller reports, as update() does). */
  function note(it, text, quiet) {
    var n = it.el.querySelector('.own-note');
    if (!n) return;
    var want = text ? String(text) : '';
    if (n.textContent === want && n.hidden === !want) return;
    function change() { n.textContent = want; n.hidden = !want; return quiet ? null : report(); }
    if (quiet || !it.el.isConnected) change();
    else flip(change, it.el);
  }
  function say(el, text, bad) {
    var s = el.querySelector('.own-copy-say');
    if (!s) return;
    s.textContent = text || '';
    s.title = text || '';
    s.classList.toggle('bad', !!bad);
  }
  /** Copy: main writes the detail to the clipboard (toasts.copy); "Copied", or why not. */
  function copy(it) {
    var btn = it.el.querySelector('.own-copy');
    if (btn.disabled) return;
    btn.disabled = true;
    clearTimeout(it.sayT);
    say(it.el, '');
    var p;
    try { p = mantle.call('toasts.copy', { id: it.b.id }); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(function (r) {
      if (r && r.ok) { say(it.el, 'Copied'); it.sayT = setTimeout(function () { say(it.el, ''); }, COPIED_MS); }
      else say(it.el, 'Not copied: ' + ((r && r.reason) || 'no reason came back'), true);
    }, function (err) {
      say(it.el, 'Not copied: Mantle did not answer (' + words(err) + ')', true);
    }).then(function () { btn.disabled = false; });
  }
  /** toasts.update: the card with that id changes in place; none up = it comes up as new. */
  function update(b) {
    if (!b || b.id === undefined) return;
    var it = findLive(b.id);
    if (!it) { add([b]); return; }
    if (!b.own) return;   // an app's banner never changes in place
    var was = it.b;
    flip(function () {
      it.b = b;
      fillOwn(it.el, b, was);
      return report();
    }, it.el);
  }
  /** A card with this id that is still on its way out goes now, so the new one is the only one. */
  function purge(id) {
    items.slice().forEach(function (it) {
      if (it.b.id !== id || !it.leaving) return;
      clearTimeout(it.timer); it.timer = null;
      it.el.remove();
      items.splice(items.indexOf(it), 1);
    });
  }

  /* ---- timers: run only while on screen and not hovered */
  function arm(it) {
    clearTimeout(it.timer); it.timer = null;
    if (it.b.sticky || it.leaving || hover || !it.shown) return;
    it.due = now() + it.left;
    it.timer = setTimeout(function () { it.timer = null; leave(it, 'timed out'); }, it.left);
  }
  function hold() {
    hover = true;
    items.forEach(function (it) {
      if (it.timer) { clearTimeout(it.timer); it.timer = null; it.left = Math.max(0, it.due - now()); }
    });
  }
  function resume() {
    hover = false;
    items.forEach(function (it) {
      if (it.shown && !it.leaving && !it.b.sticky) { it.left = Math.max(it.left, RESUME_MS); arm(it); }
    });
  }
  stack.addEventListener('mouseenter', hold);
  stack.addEventListener('mouseleave', resume);

  /* ---- the stack */
  function add(banners) {
    var t = now();
    var again = [];
    (banners || []).forEach(function (b) {
      if (!b || b.id === undefined) return;
      if (b.own) {
        // Mantle's own: one already up changes in place; one still on its way out goes now
        if (findLive(b.id)) { again.push(b); return; }
        purge(b.id);
      } else if (find(b.id)) return;
      items.unshift({ b: b, el: build(b), shown: false, left: LIFE_MS, due: 0, timer: null, leaving: false, at: t, pending: {} });
    });
    render();
    again.forEach(update);
  }
  /* FLIP: whatever `change` does to the stack, the cards that stay slide from where they were. Held at
     the start until main has the new shape (done), so a card never moves outside the window's shape.
     `still`: a card that changed in place (Mantle's own, toasts.update) grows or shrinks from its bottom
     and is not slid itself; only the cards above it move. */
  function flip(change, still) {
    var before = new Map();
    if (!reduced) Array.prototype.forEach.call(stack.children, function (c) { if (!c.hidden && c !== still) before.set(c, c.getBoundingClientRect().top); });
    var done = change();
    var anims = [];
    before.forEach(function (top, c) {
      if (!c.isConnected || c.hidden || !c.animate) return;
      var dy = top - c.getBoundingClientRect().top;
      if (Math.abs(dy) <= 1) return;
      var a = c.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'translateY(0)' }], { duration: FLIP_MS, easing: SPRING, composite: 'add' });
      if (done) a.pause();
      anims.push(a);
    });
    if (done && anims.length) Promise.resolve(done).then(function () { anims.forEach(function (a) { a.play(); }); });
    return done;
  }
  function render() { return flip(layout); }
  function layout() {
    var t = now();
    // a banner that never made it on screen and is old by now is dropped: it is in the list
    // (Mantle's own never: it is not in the list, and it waits for the user)
    items = items.filter(function (it) { return it.b.own || it.shown || it.leaving || t - it.at < STALE_MS || live().indexOf(it) < MAX; });
    // Mantle's own first, then the newest apps' up to MAX: an own banner is never under "+N more"
    var lv = live();
    var on = lv.filter(function (it) { return it.b.own; }).slice(0, MAX);
    lv.forEach(function (it) { if (on.length < MAX && !it.b.own) on.push(it); });
    var fresh = [];
    // DOM order = items order (newest first); only the first MAX live ones (and leaving ones) are in it
    var want = items.filter(function (it) { return it.leaving || on.indexOf(it) >= 0; });
    want.forEach(function (it, i) {
      var at = stack.children[i];
      if (at !== it.el) stack.insertBefore(it.el, at || moreEl());
      if (!it.shown && !it.leaving) fresh.push(it);
    });
    Array.prototype.slice.call(stack.querySelectorAll('.toast')).forEach(function (el) {
      if (!want.some(function (it) { return it.el === el; })) el.remove();
    });
    var rest = live().length - on.length;
    var m = moreEl();
    m.hidden = rest <= 0;
    m.textContent = '+' + rest + ' more';
    m.title = 'Open your notifications (' + rest + ' more)';
    if (m.parentNode !== stack || stack.lastElementChild !== m) stack.appendChild(m);
    var done = report();
    // in after main has sized the window for them, so a card never slides in clipped
    fresh.forEach(function (it) { it.shown = true; });
    Promise.resolve(done).then(function () {
      setTimeout(function () {
        fresh.forEach(function (it) { if (!it.leaving) { it.el.classList.add('in'); arm(it); } });
      }, 16);
    });
    return done;
  }
  function moreEl() {
    if (more) return more;
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.hidden = true;
    more.addEventListener('click', function () {
      mantle.call('toasts.more', {}).catch(function () {});
      live().forEach(function (it) { if (!it.b.own) leave(it, 'opened the list', true); });
      render();
    });
    stack.appendChild(more);
    return more;
  }
  function leave(it, why, quiet) {
    if (it.leaving) return;
    it.leaving = true;
    it.why = why;
    clearTimeout(it.timer); it.timer = null;
    var el = it.el;
    if (!el.isConnected || reduced) { gone(it); return; }
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(function () { gone(it); }, OUT_MS);
    if (!quiet) render();   // the next hidden one comes up now, not after the animation
  }
  function gone(it) {
    // the cards above slide down into the gap instead of jumping (flip)
    flip(function () {
      it.el.remove();
      var i = items.indexOf(it);
      if (i >= 0) items.splice(i, 1);
      return layout();
    });
  }
  /* What main shapes the window to. Taller: at once (and the slide waits for it). Shorter: once the
     cards have slid into place (`settled`), so the shape never cuts one mid-slide. */
  function report(settled) {
    var count = live().length;
    // offsetTop, not the box on screen: the stack's lift (the glide with the bar) is a transform, and main
    // adds where the stack is lifted to; h is the stack's own height from the corner (lane mantle-corner)
    var h = count ? Math.ceil(window.innerHeight - stack.offsetTop + ROOM_TOP) : 0;
    if (h === last.h && count === last.count) return null;
    if (count && last.count > 0 && h < last.h && !settled && !reduced) {
      if (!shrinkT) shrinkT = setTimeout(function () { shrinkT = null; report(true); }, FLIP_MS + 20);
      return null;
    }
    clearTimeout(shrinkT); shrinkT = null;
    last = { h: h, count: count };
    return mantle.call('toasts.layout', { h: h, count: count }).catch(function () {});
  }
  function keep(ids) {
    if (!Array.isArray(ids)) return;
    var set = new Set(ids);
    items.slice().forEach(function (it) { if (!set.has(it.b.id) && !it.leaving) leave(it, 'it left the notification list'); });
  }

  /* ---- the glide with the bar (lane mantle-corner, 2026-10-16; ui/shared/bar-follow.js since lane
     mantle-corner-follow). The user: "this ... needs to go in the corner not up like this ... just have them
     smoothly move up if the taskbar comes up". Main sends toasts.lift { px, kind, ms } on the tick the bar's
     own page is told; the shared follow runs the transition (and reduced motion's wait-then-jump). */
  var follow = window.MantleBarFollow.attach(stack, { shown: function () { return live().length > 0; } });
  var glide = follow.glide;

  /* ---- main */
  mantle.on('toasts.show', function (p) { add(p && p.banners); if (p && Array.isArray(p.ids)) keep(p.ids); });
  mantle.on('toasts.ids', function (p) { keep(p && p.ids); });
  mantle.on('toasts.update', function (p) { update(p && p.banner); });
  mantle.on('toasts.drop', function (p) { var it = p ? findLive(p.id) : null; if (it) leave(it, 'Mantle took it away'); });
  mantle.on('toasts.lift', glide);
  mantle.call('toasts.ready', {}).catch(function () {});

  // read-only view for the page tests
  window.__toasts = {
    state: function () {
      return {
        hover: hover,
        items: items.map(function (it) {
          return { id: it.b.id, shown: it.shown, leaving: it.leaving, why: it.why || null, onScreen: it.el.isConnected, sticky: !!it.b.sticky,
            running: !!it.timer, left: it.timer ? Math.max(0, it.due - now()) : it.left,
            own: !!it.b.own, pending: Object.keys(it.pending || {}) };
        }),
        more: more && !more.hidden ? more.textContent : null,
        last: last,
        lift: follow.lift(), glideUp: stack.classList.contains('glide-up'), transform: getComputedStyle(stack).transform,
      };
    },
  };
})();
