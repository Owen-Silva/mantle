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
 */
(function () {
  'use strict';
  var mantle = window.mantle;
  var MAX = 3;
  var LIFE_MS = window.__toastLifeMs || 6000;
  var RESUME_MS = window.__toastResumeMs || 1500;
  var STALE_MS = 20000;
  var OUT_MS = 200;
  var FLIP_MS = 180;
  var ROOM_TOP = 8;          // px the shape keeps above the stack
  var shrinkT = null;
  var stack = document.getElementById('stack');
  var tpl = document.getElementById('tpl');
  var items = [];            // newest first: { b, el, shown, left, due, timer, leaving, at }
  var hover = false;
  var more = null;
  var last = { h: -1, count: -1 };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function now() { return Date.now(); }
  function letterOf(s) { var m = /[A-Za-z0-9]/.exec(String(s || '')); return m ? m[0].toUpperCase() : '?'; }
  function find(id) { for (var i = 0; i < items.length; i++) if (items[i].b.id === id) return items[i]; return null; }
  function live() { return items.filter(function (it) { return !it.leaving; }); }

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
    var opens = b.opens === 'protocol' ? 'Open it' : 'Go to ' + (b.app || 'the app');
    el.title = opens + ' (it stays in your notifications)';
    el.setAttribute('aria-label', [b.app, b.title, b.body].filter(Boolean).join('. '));
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
    (banners || []).forEach(function (b) {
      if (!b || b.id === undefined || find(b.id)) return;
      items.unshift({ b: b, el: build(b), shown: false, left: LIFE_MS, due: 0, timer: null, leaving: false, at: t });
    });
    render();
  }
  /* FLIP: whatever `change` does to the stack, the cards that stay slide from where they were. Held at
     the start until main has the new shape (done), so a card never moves outside the window's shape. */
  function flip(change) {
    var before = new Map();
    if (!reduced) Array.prototype.forEach.call(stack.children, function (c) { if (!c.hidden) before.set(c, c.getBoundingClientRect().top); });
    var done = change();
    var anims = [];
    before.forEach(function (top, c) {
      if (!c.isConnected || c.hidden || !c.animate) return;
      var dy = top - c.getBoundingClientRect().top;
      if (Math.abs(dy) <= 1) return;
      var a = c.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'translateY(0)' }], { duration: FLIP_MS, easing: 'cubic-bezier(.2,.8,.2,1)', composite: 'add' });
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
    items = items.filter(function (it) { return it.shown || it.leaving || t - it.at < STALE_MS || live().indexOf(it) < MAX; });
    var on = live().slice(0, MAX);
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
      live().forEach(function (it) { leave(it, 'opened the list', true); });
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

  /* ---- the glide with the bar (lane mantle-corner, 2026-10-16). Owen: "this ... needs to go in the
     corner not up like this ... just have them smoothly move up if the taskbar comes up". Main sends
     toasts.lift { px, kind, ms } on the tick the bar's own page is told: px = how far above the corner
     the stack rests now, kind 'up' = the bar's spring (toasts.css #stack.glide-up), 'down' = its exit.
     A CSS transition, as the bar's: a reversal half-way goes back from where it is, the same way the
     bar's does, so the two stay together through rapid toggles. ms 0, nothing on screen, or reduced
     motion: no travel, it is simply there (reduced motion: a 120 ms fade-up of what is on screen). */
  var lift = 0, waitT = null;
  /* Reduced motion (lane mantle-corner3): the bar's pill does not move then, it only fades where it rests
     (ui/bar/bar.css), so a stack jumping DOWN at once would sit on the fading pill. It waits out the bar's
     fade (the ms main sends for a down is longer than it) and then jumps; up jumps at once (out of the way). */
  function glide(p) {
    clearTimeout(waitT); waitT = null;
    var px = Math.max(0, Math.round(Number(p && p.px) || 0));
    var ms = Math.max(0, Math.round(Number(p && p.ms) || 0));
    var shown = live().length > 0;
    if (reduced && shown && ms && px < lift) { waitT = setTimeout(function () { waitT = null; glide({ px: px, kind: p.kind, ms: 0 }); }, ms); return; }
    var still = !ms || reduced || !shown;
    stack.classList.toggle('glide-up', !!(p && p.kind === 'up'));
    if (still) stack.classList.add('still');
    else stack.style.setProperty('--glide-ms', ms + 'ms');
    stack.style.setProperty('--lift', px + 'px');
    if (still) {
      void stack.offsetWidth;   // commit the jump before transitions come back on
      stack.classList.remove('still');
      if (reduced && shown && px !== lift && stack.animate) stack.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
    }
    lift = px;
  }

  /* ---- main */
  mantle.on('toasts.show', function (p) { add(p && p.banners); if (p && Array.isArray(p.ids)) keep(p.ids); });
  mantle.on('toasts.ids', function (p) { keep(p && p.ids); });
  mantle.on('toasts.lift', glide);
  mantle.call('toasts.ready', {}).catch(function () {});

  // read-only view for the page tests
  window.__toasts = {
    state: function () {
      return {
        hover: hover,
        items: items.map(function (it) {
          return { id: it.b.id, shown: it.shown, leaving: it.leaving, why: it.why || null, onScreen: it.el.isConnected, sticky: !!it.b.sticky,
            running: !!it.timer, left: it.timer ? Math.max(0, it.due - now()) : it.left };
        }),
        more: more && !more.hidden ? more.textContent : null,
        last: last,
        lift: lift, glideUp: stack.classList.contains('glide-up'), transform: getComputedStyle(stack).transform,
      };
    },
  };
})();
