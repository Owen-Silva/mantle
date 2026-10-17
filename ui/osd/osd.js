/* osd.js - Mantle's volume/brightness pop-up and the Android-style panel behind it (osd lane,
 * wave 3, 2026-09-24).
 *
 * WHAT MAIN SENDS (lib/features/osd.js):
 *   osd.show   {kind:'volume'|'brightness', state:{ok, level 0-100, muted, reason}, expand, below, via}
 *              a volume key (Mantle takes them), the bar's wheel or right-click; kind 'brightness'
 *              when the sidecar has moved Windows' own brightness pop-up off screen (the keys are
 *              firmware's, so they cannot be taken: lib/features/osd.js, osd3 2026-09-24)
 *   osd.level  {kind, state}   the level moved while the pop-up is up (the sidecar's volume watch)
 *   osd.hide   {why}           gone at once (the feature was switched off, the display changed)
 *   osd.lift   {px, kind, ms}  how far up the pane rests: above the bar's pill while the bar is up
 *                              (ui/shared/bar-follow.js on #lift; lib/bar-follow.js in main)
 *   osd.show {hold: true}      --test only (main's testShow): no fade until main hides it
 * WHAT THE PAGE ASKS:
 *   osd.size   {w, h}   the surface's size plus its shadow margin: main sizes and places the window
 *   osd.faded  {}       the fade finished: main hides the window (it takes no clicks while hidden)
 *   qs.set, qs.audio.sessions, qs.audio.session - main's existing Quick Settings commands, so the
 *   pop-up changes Windows exactly the way the panel does and gets the same read-backs.
 *
 * THE RULES IT KEEPS
 *   - It never takes focus: the window is non-activating (main), so nothing here may depend on
 *     keyboard focus. The volume keys drive it; the pointer does the rest.
 *   - Fades 1.5 s after the last key / level change / the pointer leaving, never while the pointer
 *     is over it or a slider is held (osd-model.js fader).
 *   - A slider sends like the panel's (ui/bar/qs-send.js): one set in flight, only the newest value
 *     waiting, the last one always sent. THE READ-BACK WINS: every reply repaints from what Windows
 *     reports, and a refused change springs back with its reason under the row.
 *   - Nothing unavailable is blank: a dead level says why, an unreadable mixer says why.
 */
(function () {
  'use strict';
  var M = window.MantleOsdModel;
  var B = window.mantle;
  var Send = window.MantleQsSend;
  var POLL_MS = 1500;                        // the mixer's own refresh while it is open (qs-more.js)

  var el = {};
  ['lift', 'osd', 'panel', 'dev', 'apps', 'note', 'pill', 'glyph', 'level', 'num', 'more', 'why'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var kind = 'volume';
  var st = { volume: null, brightness: null };  // the newest reading of each, as main reports it
  var why = null;                                // a master set that did not take
  var open = false, shown = false, fading = 0, pollT = 0, gen = 0, seq = null;
  var pinned = false;                            // --test only (main's testShow, show {hold:true}): no fade until it goes
  var mix = { data: null, memo: null, rows: {}, keys: '' };
  var dragging = false;

  function call(ch, args) {
    try { return Promise.resolve(B.call(ch, args)); } catch (e) { return Promise.reject(e); }
  }
  function msg(e) { return e && e.message ? e.message : String(e || 'no reason given'); }
  function sentence(s) { s = String(s || ''); return /[.!?…]$/.test(s) ? s : s + '.'; }

  var fader = M.fader({ onFade: fadeOut });

  // ------------------------------------------------------------------ the master level

  var master = Send ? Send.sender(function (v) { return setMaster(v); }, {
    minGapMs: 16,
    onIdle: function () { paint(); fader.hold(dragging || pinned); },
  }) : { push: function (v) { setMaster(v); }, busy: function () { return false; } };

  function held() { return dragging || master.busy(); }

  function setMaster(v) {
    var k = kind;
    return call('qs.set', { part: k, value: v }).then(function (r) {
      r = r || { ok: false, reason: 'qs.set answered with nothing' };
      if (r.state && typeof r.state === 'object') st[k] = Object.assign({}, r.state);
      why = r.ok === false ? label(k) + ' did not change: ' + M.plain(r.reason) : null;
      if (!held()) paint();
      return r;
    }, function (e) {
      why = label(k) + ' did not change: ' + M.plain(msg(e));
      paint();
      return { ok: false, reason: msg(e) };
    });
  }

  function label(k) { return k === 'brightness' ? 'Brightness' : 'Volume'; }

  var mutePending = false;
  el.glyph.addEventListener('click', function () {
    fader.poke();
    if (kind !== 'volume' || mutePending) return;
    var cur = st.volume;
    if (!cur || cur.ok === false) return;
    var want = !cur.muted;
    st.volume = Object.assign({}, cur, { muted: want });   // the click shows at once...
    mutePending = true;
    paint();
    call('qs.set', { part: 'mute', value: want }).then(function (r) {
      mutePending = false;
      r = r || { ok: false, reason: 'qs.set answered with nothing' };
      if (r.state && typeof r.state === 'object') st.volume = Object.assign({}, r.state);  // ...the read-back decides
      else if (r.ok === false) st.volume = cur;                                             // refused: spring back
      why = r.ok === false ? (want ? 'Mute' : 'Unmute') + ' did not take: ' + M.plain(r.reason) : null;
      paint();
    }, function (e) {
      mutePending = false;
      st.volume = cur;
      why = (want ? 'Mute' : 'Unmute') + ' did not take: ' + M.plain(msg(e));
      paint();
    });
  });

  el.level.addEventListener('pointerdown', function () { dragging = true; fader.hold(true); });
  // ONE pointerup for every slider on the page (the master and each app row's)
  window.addEventListener('pointerup', function () {
    for (var k in mix.rows) mix.rows[k].drag = false;
    if (dragging) { dragging = false; if (!master.busy()) paint(); }
    fader.hold(anyHeld());
  });
  el.level.addEventListener('input', function () {
    var v = Number(el.level.value);
    el.level.style.setProperty('--p', v);
    el.num.textContent = String(v);
    if (kind === 'volume') el.glyph.innerHTML = M.volumeSvg(v, !!(st.volume && st.volume.muted));
    else el.glyph.innerHTML = M.sunSvg(v);
    fader.poke();
    master.push(v);
  });
  el.level.addEventListener('change', function () { master.push(Number(el.level.value)); });

  // ------------------------------------------------------------------ painting

  function paint() {
    var s = st[kind] || { ok: false, reason: label(kind).toLowerCase() + ' has not been read yet' };
    var d = M.describe(kind, s);
    el.osd.dataset.kind = kind;
    el.osd.classList.toggle('muted', kind === 'volume' && !!d.muted);
    el.osd.classList.toggle('dead', !!d.dead);
    if (kind === 'volume') {
      el.glyph.innerHTML = M.volumeSvg(d.dead ? null : d.fill, !!d.muted);
      el.glyph.title = d.dead ? d.aria : d.muted ? 'Unmute (mute key)' : 'Mute (mute key)';
      el.glyph.setAttribute('aria-pressed', String(!!d.muted));
      el.glyph.classList.toggle('on', !!d.muted);
      el.glyph.classList.toggle('pending', mutePending);
      el.glyph.disabled = !!d.dead;
    } else {
      el.glyph.innerHTML = M.sunSvg(d.dead ? null : d.fill);
      el.glyph.title = d.aria;
      el.glyph.removeAttribute('aria-pressed');
      el.glyph.classList.remove('on', 'pending');
      el.glyph.disabled = true;
    }
    el.level.disabled = !!d.dead;
    el.level.setAttribute('aria-label', label(kind));
    if (!held()) {
      el.level.value = String(d.fill);
      el.level.style.setProperty('--p', d.fill);
      el.num.textContent = d.value;
    }
    el.pill.title = d.aria;
    var line = d.dead ? sentence(label(kind) + ' is unavailable: ' + M.plain(s.reason)) : why ? sentence(why) : '';
    el.why.textContent = line;
    el.why.hidden = !line;
    el.more.setAttribute('aria-expanded', String(open));
    el.more.title = open ? 'Hide the apps' : 'Show every app’s volume';
    report();
  }

  // ------------------------------------------------------------------ showing and fading

  function show(p) {
    p = p || {};
    var k = p.kind === 'brightness' ? 'brightness' : 'volume';
    // A brightness change while the pointer is in the open panel does not pull it away from Owen.
    if (shown && open && k !== kind && fader.state().hovered) return;
    if (p.state && typeof p.state === 'object' && !(held() && k === kind)) st[k] = Object.assign({}, p.state);
    if (k !== kind) { why = null; kind = k; if (k !== 'volume') setOpen(false); }
    document.body.toggleAttribute('data-below', !!p.below);
    if (typeof p.seq === 'number') seq = p.seq;   // echoed in osd.faded, so main never hides a newer show
    var fresh = !shown;
    if (fading) { clearTimeout(fading); fading = 0; }
    el.osd.classList.remove('fading');
    el.osd.hidden = false;
    shown = true;
    if (p.expand && kind === 'volume') setOpen(true);
    if (p.hold === true) { pinned = true; fader.hold(true); }
    paint();
    fader.poke();
    // dark: one picture of what is behind the pop-up per show, not per key repeat (ui/shared/hud-backdrop.js)
    if (fresh && window.MantleHudBackdrop) window.MantleHudBackdrop.request('shown', { hold: true });
  }

  function level(p) {
    if (!p || !p.state) return;
    var k = p.kind === 'brightness' ? 'brightness' : 'volume';
    st[k] = Object.assign({}, p.state);
    if (!shown || k !== kind) return;
    if (!held()) paint();
    if (!fader.state().hovered) fader.poke();
  }

  /* The fade is the CSS one (--lg-dur-out on --lg-ease); with reduced motion there is none, so the
     window goes at once instead of sitting there invisible for the length of a fade nobody sees. */
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function fadeMs() {
    if (reduce && reduce.matches) return 0;
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--lg-dur-out').trim();
    var v = parseFloat(raw) * (/[^m]s$/.test(raw) ? 1000 : 1);   // '260ms' or '.26s'
    return isFinite(v) && v >= 0 && v <= 1000 ? v : 260;
  }

  function fadeOut() {
    el.osd.classList.add('fading');
    var s = seq;
    fading = setTimeout(function () {
      fading = 0;
      gone();
      call('osd.faded', { seq: s }).catch(function () { /* main hides it on its own backstop */ });
    }, fadeMs());
  }

  function gone() {
    shown = false;
    el.osd.hidden = true;
    el.osd.classList.remove('fading');
    setOpen(false);
    pinned = false;
    fader.reset();
    why = null;
  }

  el.osd.addEventListener('mouseenter', function () { fader.hover(true); });
  el.osd.addEventListener('mouseleave', function () { fader.hover(false); });
  el.osd.addEventListener('pointerdown', function () { fader.poke(); }, true);
  var wheelAcc = 0;
  el.osd.addEventListener('wheel', function (e) {
    // the wheel over the pop-up nudges whatever it shows, 2 per notch like Windows' own keys
    if (el.level.disabled) return;
    if (e.target && e.target.closest && e.target.closest('.apps')) return;   // the list scrolls
    e.preventDefault();
    // a mouse notch is one step; a touchpad's many small deltas add up to one per notch's worth
    var w = M.wheel(wheelAcc, e.deltaY, e.deltaMode);
    wheelAcc = w.acc;
    if (!w.steps) return;
    // snapped to the even steps the keys use (33 -> 34 up, 33 -> 32 down), so wheel and keys agree
    var v = Number(el.level.value);
    for (var i = 0; i < Math.abs(w.steps); i++) v = w.steps > 0 ? Math.floor(v / 2) * 2 + 2 : Math.ceil(v / 2) * 2 - 2;
    v = Math.max(0, Math.min(100, v));
    if (v === Number(el.level.value)) { fader.poke(); return; }
    el.level.value = String(v);
    el.level.dispatchEvent(new Event('input'));
  }, { passive: false });
  document.addEventListener('keydown', function (e) {
    // The window is non-activating, so this is only reached if main ever focuses it; Esc still closes.
    if (e.key === 'Escape') { fader.reset(); fadeOut(); }
  });

  // ------------------------------------------------------------------ the size main gives the window

  var lastSize = '';
  function report() {
    if (el.osd.hidden) return;
    var r = el.osd.getBoundingClientRect();
    var m = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m')) || 18;
    var w = Math.ceil(r.width + 2 * m), h = Math.ceil(r.height + 2 * m);
    var key = w + 'x' + h;
    if (key === lastSize) return;
    lastSize = key;
    call('osd.size', { w: w, h: h, open: open }).catch(function () { /* the window keeps its size */ });
  }
  if (window.ResizeObserver) new ResizeObserver(function () { lastSize = ''; report(); }).observe(el.osd);

  // ------------------------------------------------------------------ the per-app panel

  el.more.addEventListener('click', function () { setOpen(!open); fader.poke(); });

  function setOpen(on) {
    on = !!on && kind === 'volume';
    if (on === open) return;
    open = on;
    el.osd.classList.toggle('open', open);
    el.panel.hidden = !open;
    gen++;
    clearTimeout(pollT); pollT = 0;
    if (open) readApps();
    else { mix.keys = ''; mix.rows = {}; el.apps.textContent = ''; }
    paint();
  }

  function readApps() {
    var g = gen;
    call('qs.audio.sessions').then(function (r) {
      if (g !== gen || !open) return;
      mix.data = r || { ok: false, reason: 'qs.audio.sessions gave no answer', sessions: [] };
      renderApps();
    }, function (e) {
      if (g !== gen || !open) return;
      mix.data = { ok: false, reason: 'the apps playing sound could not be asked for: ' + msg(e), sessions: [] };
      renderApps();
    }).then(function () {
      if (g !== gen || !open) return;
      pollT = setTimeout(readApps, POLL_MS);   // apps that start or stop sound come and go live
    });
  }

  function inUse(key) {
    var row = mix.rows[key];
    return !!row && (row.drag || row.send.busy() || row.err || row.hover);
  }

  function renderApps() {
    var r = mix.data;
    if (!r) return;
    el.dev.textContent = r.device && r.device.name ? r.device.name : '';
    el.dev.title = r.device && r.device.name ? 'Playing on ' + r.device.name : '';
    var listed = M.listApps(r.ok === false ? [] : r.sessions, mix.memo, Date.now(), inUse);
    mix.memo = listed.memo;
    var keys = (r.ok === false ? 'x:' + r.reason : '') + '|' + listed.rows.map(function (s) { return s.key; }).join('|');
    if (keys !== mix.keys) {
      mix.keys = keys;
      var old = mix.rows;
      mix.rows = {};
      el.apps.textContent = '';
      if (r.ok === false) {
        stateBlock('The apps can’t be read', M.plain(r.reason), true);
      } else if (!listed.rows.length) {
        stateBlock('No apps are playing sound', 'An app appears here while it plays sound' +
          (r.device && r.device.name ? ' on ' + r.device.name : '') + '.', false);
      } else {
        listed.rows.forEach(function (s) {
          var row = old[s.key] || appRow(s);      // a row that stays keeps its element: no jump under the pointer
          mix.rows[s.key] = row;
          el.apps.appendChild(row.el);
        });
      }
    }
    listed.rows.forEach(function (s) {
      var row = mix.rows[s.key];
      if (row) paintApp(row, Object.assign({}, s, row.s && row.s.icon && !s.icon ? { icon: row.s.icon } : {}));
    });
    report();
  }

  function stateBlock(title, text, bad) {
    var d = document.createElement('div');
    d.className = 'state' + (bad ? ' bad' : '');
    var b = document.createElement('b'); b.textContent = title;
    d.appendChild(b);
    d.appendChild(document.createTextNode(sentence(text)));
    if (bad) {
      var again = document.createElement('button');
      again.type = 'button'; again.className = 'retry'; again.textContent = 'Try again';
      again.addEventListener('click', function () { clearTimeout(pollT); readApps(); });
      d.appendChild(document.createElement('br'));
      d.appendChild(again);
    }
    el.apps.appendChild(d);
  }

  function appIcon(s) {
    var box = document.createElement('span');
    box.className = 'aico';
    if (s.icon) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = s.icon;
      img.onerror = function () { box.textContent = ''; box.appendChild(letter(s, 'the icon did not load')); };
      box.appendChild(img);
    } else {
      box.appendChild(letter(s, s.system ? 'Windows system sounds' : (s.iconReason || 'no icon was given')));
    }
    return box;
  }
  function letter(s, whyNot) {
    var l = document.createElement('span');
    l.className = 'aletter';
    l.textContent = ((M.appName(s)).replace(/[^0-9A-Za-z]/g, '').charAt(0) || '?').toUpperCase();
    l.title = whyNot;
    return l;
  }

  function appRow(s) {
    var row = { key: s.key, s: s, drag: false, err: null, hover: false, pendingMute: false };
    row.el = document.createElement('div');
    row.el.className = 'app';
    row.el.setAttribute('role', 'listitem');
    row.ico = appIcon(s);
    var mid = document.createElement('div');
    mid.className = 'atop';
    row.name = document.createElement('span'); row.name.className = 'aname';
    row.val = document.createElement('span'); row.val.className = 'aval';
    mid.appendChild(row.name); mid.appendChild(row.val);
    row.range = document.createElement('input');
    row.range.type = 'range'; row.range.min = '0'; row.range.max = '100'; row.range.step = '1';
    row.range.className = 'level';
    row.mute = document.createElement('button');
    row.mute.type = 'button'; row.mute.className = 'amute';
    row.errEl = document.createElement('div'); row.errEl.className = 'aerr'; row.errEl.hidden = true;
    row.el.appendChild(row.ico); row.el.appendChild(mid); row.el.appendChild(row.mute);
    row.el.appendChild(row.range); row.el.appendChild(row.errEl);

    var born = gen;
    row.send = Send ? Send.sender(function (v) { return setApp(row, { level: v }); }, {
      minGapMs: 16,
      onIdle: function () { if (born === gen) paintApp(row, row.s); fader.hold(anyHeld()); },
    }) : { push: function (v) { setApp(row, { level: v }); }, busy: function () { return false; } };
    row.el.addEventListener('mouseenter', function () { row.hover = true; });
    row.el.addEventListener('mouseleave', function () { row.hover = false; });
    row.range.addEventListener('pointerdown', function () { row.drag = true; fader.hold(true); });
    row.range.addEventListener('input', function () {
      var v = Number(row.range.value);
      row.range.style.setProperty('--p', v);
      row.val.textContent = String(v);
      fader.poke();
      row.send.push(v);
    });
    row.range.addEventListener('change', function () { row.send.push(Number(row.range.value)); });
    row.mute.addEventListener('click', function () {
      if (row.pendingMute) return;
      var want = !row.s.muted;
      row.pendingMute = true;
      paintApp(row, Object.assign({}, row.s, { muted: want }));   // at once; the read-back decides
      setApp(row, { muted: want });
    });
    return row;
  }

  function anyHeld() {
    if (held() || pinned) return true;
    for (var k in mix.rows) if (mix.rows[k].drag || mix.rows[k].send.busy()) return true;
    return false;
  }

  function paintApp(row, s) {
    row.s = s;
    var name = M.appName(s);
    row.el.classList.toggle('idle', !s.active);
    row.name.textContent = name;
    row.name.title = name + (s.path ? '\n' + s.path : '') + (s.sessions > 1 ? '\n' + s.sessions + ' audio sessions, one slider' : '');
    var busy = row.drag || row.send.busy();
    if (!busy && typeof s.level === 'number') {
      row.range.value = String(s.level);
      row.range.style.setProperty('--p', s.level);
      row.val.textContent = String(s.level);
    }
    row.range.classList.toggle('muted', !!s.muted);
    row.range.setAttribute('aria-label', 'Volume for ' + name);
    row.mute.innerHTML = M.volumeSvg(s.muted ? 0 : s.level, !!s.muted);
    row.mute.classList.toggle('on', !!s.muted);
    row.mute.classList.toggle('pending', row.pendingMute);
    row.mute.title = (s.muted ? 'Unmute ' : 'Mute ') + name;
    row.mute.setAttribute('aria-pressed', String(!!s.muted));
    row.errEl.textContent = row.err ? sentence(row.err) : '';
    row.errEl.hidden = !row.err;
  }

  function setApp(row, change) {
    var g = gen;
    var args = { key: row.key };
    if (change.level !== undefined) args.level = change.level;
    if (change.muted !== undefined) args.muted = change.muted;
    function done(r) {
      if (change.muted !== undefined) row.pendingMute = false;
      if (g !== gen) return r;
      var what = change.muted !== undefined ? (change.muted ? 'Mute' : 'Unmute') : 'The level';
      row.err = r.ok ? null : what + ' did not take: ' + M.plain(r.reason);
      // THE READ-BACK WINS: the row shows what the session holds now, never the click
      if (r.session) paintApp(row, Object.assign({}, row.s, r.session, { icon: row.s.icon, iconReason: row.s.iconReason }));
      else paintApp(row, row.s.muted !== undefined && change.muted !== undefined ? Object.assign({}, row.s, { muted: !change.muted }) : row.s);
      return r;
    }
    return call('qs.audio.session', args).then(function (r) {
      return done(r || { ok: false, reason: 'qs.audio.session gave no answer' });
    }, function (e) {
      return done({ ok: false, reason: 'the change could not be asked for: ' + msg(e) });
    });
  }

  // ------------------------------------------------------------------ wiring

  if (!B || typeof B.on !== 'function') {
    // Opened outside Mantle with no mock: say so rather than draw a blank.
    el.osd.hidden = false;
    el.why.hidden = false;
    el.why.textContent = 'This page is Mantle’s volume pop-up; it needs Mantle (or ui/osd/mock-mantle.js) to run.';
    return;
  }
  /* THE GLIDE WITH THE BAR (lane corner-follow-osd, 2026-10-17; ui/shared/bar-follow.js). Main places
     the window as if the bar were not there and sends osd.lift {px, kind, ms}: how far up the pane rests
     (above the bar's pill while the bar is up), on the bar's own clock. #lift carries the transform, so
     the pane's own fade is untouched. DARK: the baked picture under the pane (ui/shared/hud-backdrop.js)
     is mapped to where the pane was when it was baked, and its shot can hold the pill that has gone
     since, so once a glide that travelled is over the pane asks for ONE fresh picture (no hold: the old
     one stays up until the new one is baked). Light: nothing to bake. */
  var follow = window.MantleBarFollow ? window.MantleBarFollow.attach(el.lift, {
    event: 'osd.lift',
    shown: function () { return shown; },
    backdrop: 'the pop-up glided with the bar',   // dark: ui/shared/bar-follow.js reshoot
  }) : { lift: function () { return 0; } };

  B.on('osd.show', show);
  B.on('osd.level', level);
  B.on('osd.hide', function () { if (fading) { clearTimeout(fading); fading = 0; } gone(); });
  // main's own speaker reading, if the seam delivers it here too: the same value as osd.level
  B.on('volume', function (v) {
    if (!v || typeof v !== 'object') return;
    level({ kind: 'volume', state: { ok: v.ok !== false && typeof v.level === 'number', level: v.level, muted: !!v.muted, reason: v.reason || null } });
  });

  window.__osd = { show: show, level: level, setOpen: setOpen, fader: fader, state: function () {
    return { kind: kind, shown: shown, open: open, fading: !!fading, st: st, why: why, rows: Object.keys(mix.rows), fade: fader.state(), pinned: pinned,
      // the glide: the lift main last sent, the transform it makes, and the pane's own box (no transform in it)
      lift: follow.lift(), glideUp: el.lift.classList.contains('glide-up'), transform: getComputedStyle(el.lift).transform,
      pane: { top: el.lift.offsetTop + el.osd.offsetTop, height: el.osd.offsetHeight, bottomGap: window.innerHeight - (el.lift.offsetTop + el.lift.offsetHeight) } };
  } };
})();
