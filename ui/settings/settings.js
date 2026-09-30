/* settings.js — Mantle Settings, the page (lane settings-ui, 2026-09-28; main: lib/features/settings.js).
 *
 * WHY THIS PAGE: Owen, 2026-09-28: "add a mantle section or something to the existing settings and
 * then make the existing settings better and the mantle style". So Win+I opens this: the Windows
 * settings Mantle can drive itself (brightness, night light, sound, Bluetooth, Wi-Fi, power, startup
 * apps) done natively through the SAME backends the bar's quick settings use, every Mantle feature
 * and option, and a deep link into the real Settings app for everything else.
 *
 * HOW IT DRAWS: one pure view function per section builds the page as a fresh DOM tree, and morph()
 * folds it into the live one (keyed by data-k), so a push every second never steals focus, never
 * resets a slider under the pointer and never loses a typed password. Every click goes through one
 * delegated handler keyed by data-act. Controls show the READ-BACK: a set's reply (qs.set returns
 * the part as Windows reads it after the set) is what the control shows, so a refused switch springs
 * back, and its reason is written under it.
 *
 * NO SILENT FAILURES (Owen's rule): every control that cannot read or act says why in words right
 * under it (--lg-warn); a section whose read failed says why and offers Try again; a set that did
 * not take leaves a note under its row. This page never logs anything.
 *
 * LIVE VALUES while visible: the qs.watch lease (re-asserted every 30 s), the bar's pushes (qs,
 * volume, net, battery, btdevices, powermode, gamemode.state, corners.state), per-section re-reads
 * (mixer 2 s, Wi-Fi list 4 s, Bluetooth's device watch), a re-read on window focus and on
 * settings.changed. All of it stops when the window hides.
 */
(function () {
  'use strict';
  const M = window.SettingsModel;
  const mantle = window.mantle || null;
  const $ = (id) => document.getElementById(id);
  const pageEl = $('page'), navEl = $('nav'), findEl = $('find'), scroller = $('scroller'), bannerEl = $('banner');
  const NO_BRIDGE = 'Settings is not connected to Mantle, so nothing can be read or changed. Close this window and open Settings again (Win+I)';

  /* ---------------------------------------------------------------- the bridge */
  const msg = (e) => (e && e.message) || String(e || 'no reason came back');
  function call(name, args) {
    if (!mantle || typeof mantle.call !== 'function') return Promise.reject(new Error(NO_BRIDGE));
    try { return Promise.resolve(mantle.call(name, args)); } catch (e) { return Promise.reject(e); }
  }
  function on(ev, fn) {
    if (!mantle || typeof mantle.on !== 'function') return;
    try { mantle.on(ev, (p) => { try { fn(p); } catch (e) { S.problems['ev:' + ev] = 'A live update (' + ev + ') could not be shown: ' + msg(e); schedule(); } }); }
    catch (e) { S.problems['ev:' + ev] = 'Live updates for ' + ev + ' are off: ' + msg(e); }
  }

  /* ---------------------------------------------------------------- state */
  const S = {
    view: 'home', section: 'home', lastView: null,
    query: '', sel: 0, results: null,
    test: false, maxed: false,
    d: Object.create(null),          // data slots: key -> { st: idle|loading|ok|fail, v, reason, at, gen }
    notes: Object.create(null),      // row id -> { tone: warn|info, text }
    pending: Object.create(null),    // row id -> true while a set is in flight
    qsBusy: Object.create(null),     // qs part -> sets in flight
    shown: Object.create(null),      // a held slider's number
    pointerEl: null,                 // the range under the pointer
    flash: null,                     // { row } the search / nav jump highlight
    expand: null,                    // the Wi-Fi row with its password field open
    problems: Object.create(null),   // page-wide problems (banner): key -> words
    toast: null,                     // { tone, text } a note with no row to sit under
    btWatchWhy: null, index: null,
    // section modules (kit.js, SECTIONS.md): the sidebar model, the sidebar item that is current, the
    // module page shown (null = its overview or a one-page section), the view to go back to after a
    // search, the crumb over a built-in drawn as a module's page, the mounted module
    model: M.sectionModel([]), navId: 'home', page: null, baseView: 'home', crumb: null, mod: null, modsReady: false, modelSeq: 0,
    hist: [], hi: -1, histMove: false,   // back / forward: [{ section, page, scroll }] and where we are in it
  };

  /* ---------------------------------------------------------------- data slots */
  const LOAD = {
    qs: () => call('qs.get'), net: () => call('net.get'), battery: () => call('battery.get'),
    pm: () => call('powermode.get'), gm: () => call('gamemode.state'), mantle: () => call('settings.mantle'),
    about: () => call('settings.about'), catalog: () => call('settings.catalog'), displays: () => call('settings.displays'),
    startup: () => call('settings.startup'), audio: () => call('qs.audio.devices'), sessions: () => call('qs.audio.sessions'),
    bt: () => call('qs.bt.list'), wifi: () => call('qs.wifi.list'), features: () => call('features.list'),
    corners: () => call('corners.state'),
  };
  /* These carry their own ok/reason per part or as a state the section draws (a Wi-Fi radio that
     is off answers ok:true; a battery that cannot be read is drawn as that); for the rest, ok:false
     IS the failed read. */
  const PARTIAL = { qs: 1, net: 1, battery: 1, pm: 1, gm: 1, bt: 1, wifi: 1, corners: 1 };
  const WHAT = {
    qs: 'Quick settings', net: 'The network', battery: 'The battery', pm: 'The power mode', gm: 'Game mode',
    mantle: 'Mantle\'s features', about: 'Mantle\'s version', catalog: 'The Windows Settings pages', displays: 'The displays',
    startup: 'The startup apps', audio: 'The playback devices', sessions: 'The apps with sound', bt: 'The Bluetooth devices',
    wifi: 'The Wi-Fi networks', features: 'Mantle\'s feature list', corners: 'Hot corners',
  };
  const NEEDS = {
    home: ['qs', 'net', 'battery', 'pm', 'mantle', 'audio'], display: ['qs', 'displays'], sound: ['qs', 'audio', 'sessions'],
    bluetooth: ['qs', 'bt'], network: ['qs', 'net', 'wifi'], power: ['pm', 'battery', 'gm', 'qs'], notifications: ['mantle'],
    apps: ['startup', 'features'], mantle: ['mantle', 'corners'], shortcuts: ['mantle'], about: ['about'],
  };

  /* ---------------------------------------------------------------- glass (lane settingsfx2) */
  /* Main asks DWM for acrylic behind this window and says so in the URL (?glass=acrylic). The page turns
     clear (settings.css html.glass) only once DWM's read-back says acrylic AND a light frame
     (settings.glass, replayed on subscribe): measured in real Electron, the light frame can take seconds
     to land while the sidecar is busy, and until then Windows' dark-mode acrylic would sit under dark
     text. Refused = solid, and About says why. DWM draws the backdrop only on the ACTIVE window, so
     while the window is in the background the page stands on the opaque --lg-ground. */
  const docEl = document.documentElement;
  const glassAsked = /[?&]glass=acrylic(&|$)/.test(location.search);
  S.glass = glassAsked ? { material: 'acrylic', ok: null, why: null } : null;
  function glassApply() {
    docEl.classList.toggle('glass', !!(glassAsked && S.glass && S.glass.ok === true));
    docEl.classList.toggle('inactive', !document.hasFocus());
  }
  function glassTake(g) {
    if (!g || typeof g !== 'object') return;
    S.glass = g;
    glassApply();
    if (S.view === 'about') schedule();
  }
  glassApply();
  window.addEventListener('focus', () => docEl.classList.remove('inactive'));
  window.addEventListener('blur', () => docEl.classList.add('inactive'));

  function slot(k) { return S.d[k] || (S.d[k] = { st: 'idle', v: null, reason: null, at: 0, gen: 0 }); }
  function take(k, r) {
    const s = slot(k);
    if (k === 'qs' && r && typeof r === 'object') { qsTake(r); return; }
    if (r == null || typeof r !== 'object') { s.st = 'fail'; s.reason = 'Mantle answered with nothing'; }
    else if (r.ok === false && !PARTIAL[k]) { s.st = 'fail'; s.reason = r.reason || 'no reason came back'; }
    else { s.st = 'ok'; s.v = r; s.reason = null; }
    s.at = Date.now();
    if (k === 'mantle' || k === 'catalog') rebuildIndex();
  }
  function read(k) {
    const s = slot(k), gen = ++s.gen;
    if (s.st !== 'ok') s.st = 'loading';
    return LOAD[k]().then((r) => { if (gen === s.gen) { take(k, r); schedule(k); } },
      (e) => { if (gen === s.gen) { s.st = 'fail'; s.reason = msg(e); s.at = Date.now(); if (k === 'mantle' || k === 'catalog') rebuildIndex(); schedule(k); } });
  }
  function ensure(sec) { return Promise.all((NEEDS[sec] || []).map(read)); }
  function rebuildIndex() {
    S.index = M.buildIndex({ mantle: slot('mantle').v, catalog: slot('catalog').v, model: S.model });
    if (S.view === 'search') S.results = null;
  }

  /* ---------------------------------------------------------------- quick-settings parts
     The bar's rules (ui/bar/bar.js qsTake/qsHeld): a push never moves a part the page is holding
     (a set in flight, a slider under the pointer); the reply to a set has the last word. */
  function qsHeld(k) {
    if (k === 'volume' && (S.qsBusy.volume || S.qsBusy.mute)) return true;
    if (S.qsBusy[k]) return true;
    return !!(S.pointerEl && S.pointerEl.dataset.part === k);
  }
  function qsTake(d) {
    const s = slot('qs'), cur = s.v, next = Object.assign({}, d);
    if (cur) Object.keys(next).forEach((k) => { if (cur[k] && typeof cur[k] === 'object' && qsHeld(k)) next[k] = cur[k]; });
    s.v = next; s.st = 'ok'; s.reason = null; s.at = Date.now();
  }
  function qp(k) {
    const s = slot('qs');
    if (s.v && s.v[k]) return s.v[k];
    if (s.st === 'fail') return { ok: false, reason: 'quick settings could not be read: ' + s.reason };
    if (s.v && s.v.ok === false) return { ok: false, reason: s.v.reason || 'quick settings could not be read, and no reason came back' };
    return null;
  }
  const partOk = (p) => !!(p && p.ok !== false);

  function qsSet(part, value, rowId, guess) {
    const key = part === 'mute' ? 'volume' : part;
    const q = slot('qs').v;
    if (guess && q && q[key]) { q[key] = Object.assign({}, q[key]); guess(q[key]); }
    S.qsBusy[part] = (S.qsBusy[part] || 0) + 1;
    delete S.notes[rowId];
    schedule();
    const settle = () => { S.qsBusy[part] = Math.max(0, (S.qsBusy[part] || 0) - 1); if (!S.qsBusy[part]) delete S.qsBusy[part]; };
    return call('qs.set', { part, value }).then((r) => {
      settle();
      if (!r || typeof r !== 'object') r = { ok: false, reason: 'Windows gave no answer. Try again in a moment' };
      const qv = slot('qs').v;
      if (r.state && typeof r.state === 'object' && qv) qv[key] = Object.assign({}, r.state);   // the read-back, not the click
      if (r.ok === false) {
        note(rowId, 'warn', 'Not changed: ' + (r.reason || 'Windows gave no reason'));
        if (!r.state) read('qs');
      }
      schedule();
      return r;
    }, (e) => { settle(); note(rowId, 'warn', 'Not changed: ' + msg(e)); read('qs'); return null; });
  }
  /* A dragged slider sends at most one set at a time; the newest value waits for the reply. */
  const lvl = Object.create(null);
  function levelSet(part, v, rowId) {
    const L = lvl[part] || (lvl[part] = { want: null, busy: false });
    L.want = v;
    if (L.busy) return;
    const go = () => {
      const want = L.want; L.want = null; L.busy = true;
      qsSet(part, want, rowId, (p) => { p.level = want; if (part === 'volume' && want > 0) p.muted = false; })
        .then(() => { L.busy = false; if (L.want !== null) go(); });
    };
    go();
  }

  /* ---------------------------------------------------------------- notes and actions */
  function note(rowId, tone, text) {
    const n = { tone, text };
    if (rowId) S.notes[rowId] = n; else S.toast = n;
    if (tone === 'info') setTimeout(() => { if (rowId ? S.notes[rowId] === n : S.toast === n) { if (rowId) delete S.notes[rowId]; else S.toast = null; schedule(); } }, 7000);
    schedule();
  }
  /* One set, with its row pending while it runs; `apply` gets every object reply (a refusal carries
     the read-back too). ok:false and a thrown error both land under the row in words. */
  function act(rowId, promise, apply) {
    if (rowId) { S.pending[rowId] = true; delete S.notes[rowId]; }
    S.toast = null;
    schedule();
    return promise.then((r) => {
      if (rowId) delete S.pending[rowId];
      if (!r || typeof r !== 'object') r = { ok: false, reason: 'Mantle answered with nothing' };
      if (apply) apply(r);
      if (r.ok === false) note(rowId, 'warn', r.reason || 'It did not work, and no reason came back');
      else if (r.dryRun) note(rowId, 'info', 'Test run: nothing was changed');
      schedule();
      return r;
    }, (e) => { if (rowId) delete S.pending[rowId]; note(rowId, 'warn', msg(e)); return null; });
  }
  const rowOf = (el) => { const r = el && el.closest('[data-row]'); return r ? r.getAttribute('data-row') : null; };
  const feat = (name) => { const m = slot('mantle').v; return m && Array.isArray(m.features) ? m.features.find((f) => f.name === name) : null; };
  function putFeature(F) {
    const m = slot('mantle').v;
    if (!m || !F || !Array.isArray(m.features)) return;
    const i = m.features.findIndex((f) => f.name === F.name);
    if (i >= 0) m.features[i] = F;
    rebuildIndex();
  }
  function putOption(name, O) {
    const f = feat(name);
    if (!f || !O || !Array.isArray(f.options)) return;
    const i = f.options.findIndex((o) => o.key === O.key);
    if (i >= 0) f.options[i] = O;
  }
  function openWin(uri, rowId) {
    // a page a section module claims is Mantle's now: go there instead of out to Windows (lane wire)
    // (not when that IS the page on screen with no row to show: then Windows' page is the "more")
    const to = M.claimOf(S.model, uri);
    const here = to && !to.row && S.navId === to.section && (S.page || null) === (to.page || null);
    if (to && !here) return go(to.section, to.row, to.page);
    return act(rowId, call('settings.openWindows', { uri }), (r) => {
      if (r.ok !== false && r.dryRun) r.dryRun = false, note(rowId, 'info', 'Test run: Windows Settings was not opened (' + uri + ')');
    });
  }

  const ACT = {
    nav: (t) => go(t.dataset.section || null, t.dataset.row || null, t.dataset.page || null),
    back: () => { histGo(-1); },
    remount: () => { unmount(); S.lastView = null; schedule(); },
    win: (t) => openWin(t.dataset.uri || 'ms-settings:', rowOf(t)),
    retry: (t) => { (t.dataset.what || '').split(',').filter(Boolean).forEach(read); },
    'win-op': (t) => {
      const op = t.dataset.op;
      call('settings.window', { op }).then((r) => {
        if (r && r.ok === false) note(null, 'warn', 'The window could not ' + op + ': ' + (r.reason || 'no reason came back'));
        else if (r && typeof r.maximized === 'boolean') { S.maxed = r.maximized; schedule(); }
      }, (e) => note(null, 'warn', 'The window could not ' + op + ': ' + msg(e)));
    },
    dismiss: () => { S.toast = null; schedule(); },
    qs: (t) => {
      const part = t.dataset.part, p = qp(part), rowId = rowOf(t);
      if (!p) return;
      const want = !p.on;
      qsSet(part, want, rowId, (x) => { x.on = want; if (part === 'wifi' && !want) x.connected = false; }).then(() => {
        if (part === 'wifi') { read('wifi'); read('net'); }
        if (part === 'bluetooth') read('bt');
      });
    },
    mute: (t) => {
      const p = qp('volume');
      if (!p) return;
      const want = !p.muted;
      qsSet('mute', want, rowOf(t), (x) => { x.muted = want; });
    },
    'app-mute': (t) => {
      const key = t.dataset.key, s = session(key);
      if (!s) return;
      sessionSet(key, { muted: !s.muted }, rowOf(t));
    },
    'bt-conn': (t) => {
      const op = t.dataset.op, device = t.dataset.dev, rowId = rowOf(t);
      act(rowId, call(op === 'connect' ? 'qs.bt.connect' : 'qs.bt.disconnect', { device }), () => read('bt'));
    },
    'wifi-scan': (t) => {
      S.pending['network.scan'] = true; schedule();
      act('network.networks', call('qs.wifi.scan'), () => { delete S.pending['network.scan']; read('wifi'); })
        .then(() => { delete S.pending['network.scan']; schedule(); });
    },
    'wifi-go': (t) => {
      const n = wifiNet(t.dataset.net);
      if (!n) return;
      if (n.action === 'password') { S.expand = t.dataset.net; schedule(); setTimeout(() => { const i = pageEl.querySelector('.pw input'); if (i) i.focus(); }, 30); return; }
      wifiConnect(n, t.dataset.net, null, rowOf(t));
    },
    'wifi-pw': (t) => {
      const n = wifiNet(t.dataset.net), row = t.closest('[data-row]'), inp = row && row.querySelector('.pw input');
      const pw = inp ? inp.value : '';
      if (inp) inp.value = '';
      if (!n) return;
      if (!pw) { note(rowOf(t), 'warn', 'Type the network\'s password first'); return; }
      S.expand = null;
      wifiConnect(n, t.dataset.net, pw, rowOf(t));
    },
    'wifi-cancel': (t) => { const row = t.closest('[data-row]'), inp = row && row.querySelector('.pw input'); if (inp) inp.value = ''; S.expand = null; schedule(); },
    'wifi-off': (t) => act(rowOf(t), call('qs.wifi.disconnect'), () => { read('wifi'); read('net'); }),
    pm: (t) => act('power.mode', call('powermode.set', { mode: t.dataset.mode }), (r) => { if (r.state) take('pm', r.state); else read('pm'); }),
    enable: (t) => enable(t.dataset.feature, t.getAttribute('aria-checked') !== 'true', rowOf(t)),
    'opt-bool': (t) => optionSet(t.dataset.feature, t.dataset.key, t.getAttribute('aria-checked') !== 'true', rowOf(t)),
    'opt-choice': (t) => { const o = option(t.dataset.feature, t.dataset.key); const c = o && o.choices && o.choices[+t.dataset.i]; if (c) optionSet(t.dataset.feature, t.dataset.key, c.value, rowOf(t)); },
    'opt-reset': (t) => optionSet(t.dataset.feature, t.dataset.key, null, rowOf(t)),
    'opt-folder': (t) => act(rowOf(t), call('settings.pickFolder', { feature: t.dataset.feature, key: t.dataset.key }), (r) => { if (r.option) putOption(t.dataset.feature, r.option); }),
    switcher: (t) => switcher(t.dataset.key, t.getAttribute('aria-checked') !== 'true', rowOf(t)),
    'sc-toggle': (t) => {
      const sc = shortcut(t.dataset.keys), want = t.getAttribute('aria-checked') !== 'true';
      if (!sc || !sc.toggle) return;
      if (sc.toggle.kind === 'feature') enable(sc.toggle.feature, want, rowOf(t));
      else switcher(sc.toggle.key, want, rowOf(t));
    },
    startup: (t) => {
      const want = t.getAttribute('aria-checked') !== 'true';
      act(rowOf(t), call('settings.startupSet', { item: t.dataset.item, on: want }), (r) => {
        if (r.item && typeof r.item === 'object') putStartup(r.item);
        if (r.ok !== false && r.dryRun) { r.dryRun = false; note(rowOf(t), 'info', 'Test run: nothing was changed'); }
        if (!r.item) read('startup');
      });
    },
    taskmgr: (t) => act(rowOf(t), call('taskmgr.open', { view: 'apps' })),
    logs: (t) => act(rowOf(t), call('settings.openLogs'), (r) => {
      if (r.ok !== false && r.dryRun) { r.dryRun = false; note(rowOf(t), 'info', 'Test run: the log folder was not opened'); }
    }),
    result: (t) => { const flat = S.results ? S.results.flat : []; const h = flat[+t.dataset.i]; if (h) activate(h); },
  };
  const CHANGE = {
    out: (t) => act('sound.output', call('qs.audio.default', { device: t.value }), () => { read('audio'); read('sessions'); read('qs'); }),
    'opt-select': (t) => { const o = option(t.dataset.feature, t.dataset.key); const c = o && o.choices && o.choices[+t.value]; if (c) optionSet(t.dataset.feature, t.dataset.key, c.value, rowOf(t)); },
    'opt-num': (t) => {
      const v = t.value.trim() === '' ? null : Number(t.value);
      if (v !== null && !isFinite(v)) { note(rowOf(t), 'warn', 'That is not a number'); return; }
      optionSet(t.dataset.feature, t.dataset.key, v, rowOf(t));
    },
    'opt-text': (t) => optionSet(t.dataset.feature, t.dataset.key, t.value, rowOf(t)),
    corner: (t) => act('mantle.corners', call('corners.set', { corner: t.dataset.corner, action: t.value, via: 'Mantle Settings' }), (r) => {
      const v = Object.assign({}, r); delete v.ok; delete v.reason;
      if (v.actions) take('corners', v);
    }),
  };
  const INPUT = {
    level: (t) => { const v = +t.value; S.shown[t.dataset.part] = v; levelSet(t.dataset.part, v, rowOf(t)); paintVal(t, v); },
    'app-level': (t) => { const v = +t.value; sessionLevel(t.dataset.key, v, rowOf(t)); paintVal(t, v); },
  };
  function paintVal(t, v) { const o = t.parentNode && t.parentNode.querySelector('.rng-v'); if (o) o.textContent = Math.round(v) + '%'; }

  function enable(name, want, rowId) {
    return act(rowId, call('settings.enable', { feature: name, on: want }), (r) => {
      if (r.feature) putFeature(r.feature);
      read('mantle');
      if (name === 'taskmgr') read('features');
    });
  }
  function option(name, key) { const f = feat(name); return f && Array.isArray(f.options) ? f.options.find((o) => o.key === key) : null; }
  function optionSet(name, key, value, rowId) {
    return act(rowId, call('settings.option', { feature: name, key, value }), (r) => { if (r.option) putOption(name, r.option); });
  }
  function switcher(key, want, rowId) {
    return act(rowId, call('settings.switcher', { [key]: want }), (r) => {
      const m = slot('mantle').v;
      if (r.switcher && m) m.switcher = r.switcher;
      read('mantle');
    });
  }
  function shortcut(keys) { const m = slot('mantle').v; return m && Array.isArray(m.shortcuts) ? m.shortcuts.find((s) => s.keys === keys) : null; }
  function putStartup(item) {
    const v = slot('startup').v;
    if (!v || !Array.isArray(v.items)) return;
    const i = v.items.findIndex((x) => x.item === item.item);
    if (i >= 0) v.items[i] = item;
  }

  /* the mixer: one app's level, throttled like the main sliders */
  function session(key) { const v = slot('sessions').v; return v && Array.isArray(v.sessions) ? v.sessions.find((s) => s.key === key) : null; }
  function sessionSet(key, args, rowId) {
    return act(rowId, call('qs.audio.session', Object.assign({ key }, args)), (r) => {
      const s = session(key);
      if (s && r.session && typeof r.session === 'object') Object.assign(s, { level: r.session.level, muted: r.session.muted });
    });
  }
  const slv = Object.create(null);
  function sessionLevel(key, v, rowId) {
    const L = slv[key] || (slv[key] = { want: null, busy: false });
    L.want = v;
    if (L.busy) return;
    const go = () => { const want = L.want; L.want = null; L.busy = true; sessionSet(key, { level: want }, rowId).then(() => { L.busy = false; if (L.want !== null) go(); }); };
    go();
  }

  /* Wi-Fi: the row key is the network's hex name (unique, and what connect takes) */
  function wifiKey(n, i) { return n.hex || n.ssid || ('hidden-' + i); }
  function wifiNet(k) { const v = slot('wifi').v; return v && Array.isArray(v.networks) ? v.networks.find((n, i) => wifiKey(n, i) === k) : null; }
  function wifiConnect(n, k, password, rowId) {
    const args = n.hex ? { hex: n.hex, ssid: n.ssid || undefined } : { ssid: n.ssid };
    if (password) args.password = password;
    S.pending['network.join.' + k] = true;
    return act(rowId, call('qs.wifi.connect', args), () => { read('wifi'); read('net'); read('qs'); })
      .then(() => { delete S.pending['network.join.' + k]; schedule(); });
  }

  /* ---------------------------------------------------------------- DOM helpers */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, a) {
    const el = document.createElement(tag);
    if (a) for (const k in a) {
      const v = a[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    if (a && a['data-val'] != null && (tag === 'input' || tag === 'select')) el.value = String(a['data-val']);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => add(el, x)); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  const ICON = {
    home: '<path d="M2.5 7.2L8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z"/>',
    display: '<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M5.5 13.5h5M8 11v2.5"/>',
    sound: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 5.8a3 3 0 0 1 0 4.4M12.3 4.2a5.3 5.3 0 0 1 0 7.6"/>',
    bluetooth: '<path d="M4.8 5.2l6 5.2L8 12.9V3.1l2.8 2.6-6 5.2"/>',
    network: '<path d="M1.8 6.2a9 9 0 0 1 12.4 0M3.9 8.4a6 6 0 0 1 8.2 0M6 10.6a3 3 0 0 1 4 0"/><path d="M8 12.7v.01"/>',
    power: '<rect x="1.8" y="4.8" width="11" height="6.4" rx="1.2"/><path d="M14.2 7v2M4 7v2M6 7v2"/>',
    notifications: '<path d="M4 11V7.3a4 4 0 0 1 8 0V11l1 1.2H3z"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/>',
    apps: '<rect x="2.3" y="2.3" width="4.6" height="4.6" rx="1"/><rect x="9.1" y="2.3" width="4.6" height="4.6" rx="1"/><rect x="2.3" y="9.1" width="4.6" height="4.6" rx="1"/><rect x="9.1" y="9.1" width="4.6" height="4.6" rx="1"/>',
    mantle: '<path d="M8 2.2l5.8 3L8 8.2 2.2 5.2z"/><path d="M2.2 8.1L8 11.1l5.8-3M2.2 10.9L8 13.9l5.8-3"/>',
    shortcuts: '<rect x="1.5" y="4" width="13" height="8" rx="1.3"/><path d="M4 6.6h.01M6.3 6.6h.01M8.6 6.6h.01M10.9 6.6h.01M12 6.6h.01M5 9.4h6"/>',
    about: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.1v.01"/>',
    brightness: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
    mute: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 6.2l3.4 3.6M13.9 6.2l-3.4 3.6"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"/>',
    arrow: '<path d="M5.3 3.3h7.4v7.4M12.4 3.6L3.6 12.4"/>',
    chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    warn: '<path d="M8 2.2l6.2 10.9H1.8z"/><path d="M8 6.4v3M8 11.2v.01"/>',
    lock: '<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.2"/><path d="M5.5 7.2V5.5a2.5 2.5 0 0 1 5 0v1.7"/>',
    moon: '<path d="M12.8 10.2A5.4 5.4 0 0 1 5.8 3.2a5.4 5.4 0 1 0 7 7z"/>',
    mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.8 7.8a4.2 4.2 0 0 0 8.4 0M8 12v2"/>',
    shield: '<path d="M8 1.8l5 1.9v3.9c0 3.1-2.1 5.5-5 6.6-2.9-1.1-5-3.5-5-6.6V3.7z"/>',
    game: '<path d="M4.5 5h7a3 3 0 0 1 2.9 3.8l-.7 2.6a1.4 1.4 0 0 1-2.4.6L10 10.5H6L4.7 12a1.4 1.4 0 0 1-2.4-.6l-.7-2.6A3 3 0 0 1 4.5 5z"/><path d="M5.2 7v2M4.2 8h2M10.5 7.6h.01M11.8 8.6h.01"/>',
  };
  const tpl = document.createElement('template');
  /* LAG (lane settingsfx): every render drew every icon by parsing SVG markup; each one is now parsed
     once and cloned (a clone is a fraction of a parse). */
  const iconCache = new Map();
  function icon(name, size) {
    const s = size || 16, k = name + '|' + s;
    let n = iconCache.get(k);
    if (!n) {
      tpl.innerHTML = '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>';
      n = tpl.content.firstChild;
      tpl.content.removeChild(n);
      iconCache.set(k, n);
    }
    return n.cloneNode(true);
  }
  /* a module's own 16x16 icon markup (SECTIONS.md: icon may be an ICON name or '<path .../>') */
  function svgOf(markup, size) {
    const s = size || 16;
    tpl.innerHTML = '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + String(markup).replace(/<\/?(script|foreignObject)[^>]*>/gi, '') + '</svg>';
    return tpl.content.firstChild;
  }
  const iconAny = (name, size) => (typeof name === 'string' && name.trim().charAt(0) === '<' ? svgOf(name, size) : icon(ICON[name] ? name : 'apps', size));
  function sig(level) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('class', 'sig'); svg.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) {
      const r = document.createElementNS(SVGNS, 'rect');
      const bh = 3 + i * 3;
      r.setAttribute('x', String(1.5 + i * 3.6)); r.setAttribute('y', String(14 - bh)); r.setAttribute('width', '2.4'); r.setAttribute('height', String(bh)); r.setAttribute('rx', '.6');
      r.setAttribute('fill', 'currentColor');
      if (i >= level) r.setAttribute('class', 'off');
      svg.appendChild(r);
    }
    return svg;
  }

  /* ---- morph: fold a freshly built tree into the live one. Nodes are matched by tag + data-k, so
     a row keeps its DOM (focus, a typed password, a slider under the pointer) across re-renders. */
  const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-k') || '' : '');
  const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
  function held(el) {
    if (el === S.pointerEl) return true;
    return el === document.activeElement && el.tagName === 'INPUT' && el.type !== 'range';
  }
  function morph(from, to) {
    const fa = from.attributes, ta = to.attributes;
    for (let i = fa.length - 1; i >= 0; i--) if (!to.hasAttribute(fa[i].name)) from.removeAttribute(fa[i].name);
    for (let i = 0; i < ta.length; i++) if (from.getAttribute(ta[i].name) !== ta[i].value) from.setAttribute(ta[i].name, ta[i].value);
    let fc = from.firstChild, tc = to.firstChild;
    while (tc) {
      const next = tc.nextSibling;
      if (tc.__keep) {                     // an unchanged row (keep()): its live node stays exactly as it is
        if (tc.__keep === fc) fc = fc.nextSibling; else from.insertBefore(tc.__keep, fc);
        tc = next;
        continue;
      }
      let live;
      if (fc && same(fc, tc)) {
        live = fc;
        if (fc.nodeType === 1) morph(fc, tc); else if (fc.nodeValue !== tc.nodeValue) fc.nodeValue = tc.nodeValue;
        fc = fc.nextSibling;
      } else {
        const k = keyOf(tc);
        let m = null;
        if (k) for (let x = fc; x; x = x.nextSibling) if (x.nodeType === 1 && x.nodeName === tc.nodeName && keyOf(x) === k) { m = x; break; }
        if (m) { from.insertBefore(m, fc); morph(m, tc); live = m; } else { from.insertBefore(tc, fc); live = tc; }
      }
      if (tc.__memo) { const e = kept.get(tc.__memo); if (e) e.el = live; }
      tc = next;
    }
    while (fc) { const n = fc.nextSibling; from.removeChild(fc); fc = n; }
    // after the children: a select's value needs its options in place first
    if ((from.tagName === 'INPUT' || from.tagName === 'SELECT') && to.hasAttribute('data-val') && !held(from) && from.value !== to.value) from.value = to.value;
  }

  /* ROW PATCHING (lane settingsfx2, measured in real Electron): every live push (qs ~1/s while watched,
     volume, net, the mixer's 2 s read) re-ran the view, and on Sound, Home and Network that rebuilt every
     row as fresh DOM (the mixer's app icons as new <img>s each time) for morph() to diff. keep(id, deps,
     build) builds a row only when what it shows changed; an unchanged row is a placeholder that morph()
     skips, so its live node is never touched. deps must name EVERYTHING the row draws from; the row's
     note, pending set and search flash are added here. Forgotten when the view changes (renderNow). */
  const kept = new Map();                  // row id -> { sig, el }: the rows of this view as last drawn
  function keep(id, deps, build) {
    const sig = JSON.stringify([deps, S.notes[id] || null, !!S.pending[id], !!(S.flash && S.flash.row === id)]);
    const e = kept.get(id);
    if (e && e.sig === sig && e.el && e.el.isConnected) { const ph = document.createElement('i'); ph.__keep = e.el; return ph; }
    const n = build();
    if (n && n.nodeType === 1) { n.__memo = id; kept.set(id, { sig, el: null }); } else kept.delete(id);
    return n;
  }

  /* ---------------------------------------------------------------- building blocks */
  /* main's reasons are sentence fragments ("the sidecar is restarting"); on their own line they read as a sentence */
  const cap = (s) => { const t = String(s == null ? '' : s); return t.charAt(0).toUpperCase() + t.slice(1); };
  function why(text, info) {
    return h('div', { class: 'why' + (info ? ' info' : '') }, info ? null : icon('warn', 12), h('span', null, cap(M.plain(text))));
  }
  /* A row: { id, label, help, mono, tile, ctl, why, info, cls, title } */
  function row(o) {
    const n = S.notes[o.id];
    return h('div', { class: 'row' + (o.cls ? ' ' + o.cls : '') + (S.flash && S.flash.row === o.id ? ' flash' : ''), 'data-k': o.id, 'data-row': o.id },
      o.tile || null,
      h('div', { class: 'row-l' },
        h('div', { class: 'row-t' }, o.label),
        o.help ? h('div', { class: 'row-h' + (o.mono ? ' mono' : ''), title: o.title || null }, o.help) : null,
        o.why ? why(o.why) : null,
        o.info ? why(o.info, true) : null,
        n ? why(n.text, n.tone === 'info') : null,
        o.extra || null),
      o.ctl ? h('div', { class: 'row-c' }, o.ctl) : null);
  }
  function sw(on, attrs, o) {
    o = o || {};
    return [h('span', { class: 'sw-l' }, on ? 'On' : 'Off'),
      h('button', Object.assign({ class: 'sw' + (o.pending ? ' pending' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
        'aria-label': o.label || null, 'aria-disabled': o.pending ? 'true' : null, disabled: !!o.disabled }, attrs))];
  }
  function btn(text, attrs, cls) { return h('button', Object.assign({ class: 'btn' + (cls ? ' ' + cls : ''), type: 'button' }, attrs), text); }
  function winBtn(text, uri) { return h('button', { class: 'btn quiet', type: 'button', 'data-act': 'win', 'data-uri': uri }, text, icon('arrow', 12)); }
  function tile(content, cls) { return h('div', { class: 'tile' + (cls ? ' ' + cls : '') }, content); }
  function card(key) { const c = h('div', { class: 'card', 'data-k': key }); for (let i = 1; i < arguments.length; i++) add(c, arguments[i]); return c; }
  function groupT(text, key, aside) { return h('div', { class: 'group-t' + (S.flash && S.flash.row === key ? ' flash' : ''), 'data-k': 'g:' + key, 'data-row': key.indexOf('.') > 0 ? key : null }, text, aside ? h('span', { class: 'aside' }, aside) : null); }
  function crumbTo(section, label) { return [h('button', { class: 'crumb', type: 'button', 'data-k': 'crumb', 'data-act': 'nav', 'data-section': section }, label), h('span', { class: 'crumb-sep', 'data-k': 'sep' }, ' › ')]; }
  /* a built-in drawn as a page of a section module gets that module's crumb before its title */
  function head(title, summary) {
    return [h('h1', { 'data-k': 'h1' }, S.crumb ? crumbTo(S.crumb.section, S.crumb.label) : null, title), h('p', { class: 'summary', 'data-k': 'summary' }, summary)];
  }
  /* the line under a title: each reading its own unbreakable item (settings.css draws the dot between
     them), and anything that needs a look its own item behind the warn glyph (lane setlook) */
  function sumParts(parts) { return parts.filter(Boolean).map((p) => (typeof p === 'string' ? h('span', { class: 'sp' }, p) : h('span', { class: 'sp w' }, icon('warn', 12), p.warn))); }
  /* The related pages at the foot of a built-in section. A page a section module claims now is
     Mantle's: it goes there (a "Related settings" card, in-window); only the rest still open Windows
     Settings (lane wire, 2026-09-29). Row ids keep their index in MORE, so a note stays on its row. */
  function moreCard(sec) {
    const links = M.more(sec, S.model).map((l, i) => Object.assign({ i }, l));
    if (!links.length) return null;
    const out = [];
    const mine = links.filter((l) => l.to), win = links.filter((l) => !l.to);
    if (mine.length) {
      const c = card('rel-' + sec, mine.map((l) => {
        const id = 'more.' + sec + '.' + l.i;
        // data-row here is where it GOES (ACT.nav), as on every nav button
        return h('button', { class: 'row clickable', type: 'button', 'data-k': id, 'data-act': 'nav',
            'data-section': l.to.section, 'data-page': l.to.page || null, 'data-row': l.to.row || null },
          h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, l.label)),
          h('span', { class: 'arr' }, icon('chev', 14)));
      }));
      c.classList.add('more');
      out.push(groupT('Related settings', 'rel-' + sec), c);
    }
    if (win.length) {
      const c = card('more-' + sec, win.map((l) => {
        const id = 'more.' + sec + '.' + l.i, n = S.notes[id];
        return h('button', { class: 'row clickable', type: 'button', 'data-k': id, 'data-row': id, 'data-act': 'win', 'data-uri': l.uri },
          h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, l.label), n ? why(n.text, n.tone === 'info') : null),
          h('span', { class: 'arr' }, icon('arrow', 14)));
      }));
      c.classList.add('more');
      out.push(groupT('More in Windows Settings', 'more-' + sec), c);
    }
    return out;
  }
  /* null when the slot is readable, else a card that says it is loading or why it failed */
  function gate(keys, key) {
    const ks = Array.isArray(keys) ? keys : [keys];
    for (const k of ks) {
      const s = slot(k);
      if (s.st === 'fail' && !(s.v && PARTIAL[k])) return failCard(k, s.reason, key);
    }
    for (const k of ks) {
      const s = slot(k);
      if (!s.v) return card(key || 'wait-' + k, h('div', { class: 'loading' }, 'Reading ' + WHAT[k].replace(/^The /, 'the ') + '…'));
    }
    return null;
  }
  function failCard(k, reason, key) {
    return card(key || 'fail-' + k, h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')),
      h('div', { class: 'row-l' }, WHAT[k] + ' could not be read: ' + (reason || 'no reason came back')),
      btn('Try again', { 'data-act': 'retry', 'data-what': k })));
  }
  const pend = (id) => !!S.pending[id];

  /* ---------------------------------------------------------------- sections */
  const V = {};

  /* ---- section modules: a category's overview (its pages, like Windows 11), a DOWN module, and
     the mount that hands a module page its own DOM (renderNow never morphs inside it) ---- */
  V.overview = function () {
    const e = S.model.mods[S.navId] || { id: S.navId, label: S.navId, help: '' }, pages = S.model.pages[S.navId] || [];
    return [head(e.label, e.help || M.plural(pages.length, 'page')),
      card('ov-' + e.id, pages.map((p) => h('button', { class: 'row clickable', type: 'button', 'data-k': 'p:' + p.id, 'data-row': 'page:' + p.id, 'data-act': 'nav', 'data-section': e.id, 'data-page': p.id },
        tile(iconAny(p.icon || e.icon || 'apps')), h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, p.title), p.help ? h('div', { class: 'row-h' }, p.help) : null),
        h('span', { class: 'arr' }, icon('chev', 14)))))];
  };
  V.down = function () {
    const e = S.model.mods[S.navId] || { label: S.navId, down: 'it is not loaded' };
    return [head(e.label, 'This section is down, so nothing of it is drawn'),
      card('down-' + S.navId, h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')), h('div', { class: 'row-l' }, cap(e.down || 'no reason came back'))))];
  };
  const SS = window.SettingsSections;
  const kitDeps = {
    h, add, why, call, icon: iconAny, svg: svgOf,
    on(ev, fn) {
      if (!mantle || typeof mantle.on !== 'function') return () => {};
      try {
        const off = mantle.on(ev, (p) => { try { fn(p); } catch (e) { S.problems['ev:' + ev] = 'A live update (' + ev + ') could not be shown: ' + msg(e); schedule(); } });
        return typeof off === 'function' ? off : () => {};
      } catch (e) { S.problems['ev:' + ev] = 'Live updates for ' + ev + ' are off: ' + msg(e); schedule(); return () => {}; }
    },
    test: () => S.test,
    go: (section, row, page) => { go(section || null, row || null, page || null); },
    highlight: (row) => { if (typeof row === 'string' && row) { S.flash = { row }; jumpTo(row, 0); } },
  };
  function modKey() { return S.navId + '/' + (S.page || ''); }
  function unmount() {
    const m = S.mod;
    if (!m) return;
    S.mod = null;
    try { if (m.handle && typeof m.handle.dispose === 'function') m.handle.dispose(); } catch (_) { /* its kit below still stops every watch and loop */ }
    m.kit.dispose();
  }
  function modFail(title, e) {
    return card('mod-fail', h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')),
      h('div', { class: 'row-l' }, title + ' could not be drawn: ' + msg(e)), btn('Try again', { 'data-act': 'remount' })));
  }
  function mount() {
    const key = modKey();
    if (S.mod && S.mod.key === key) return;
    unmount();
    const e = S.model.mods[S.navId] || { label: S.navId, help: '' }, def = SS.get(S.navId), pg = S.page ? SS.page(S.navId, S.page) : null;
    const title = pg ? pg.title : e.label, help = pg ? pg.help : e.help;
    const root = h('div', { class: 'modroot' });
    pageEl.replaceChildren(h('h1', null, pg ? crumbTo(S.navId, e.label) : null, title), help ? h('p', { class: 'summary' }, help) : '', root);
    const kit = SS.create(kitDeps, { section: S.navId, page: S.page });
    const m = S.mod = { key, kit, handle: null };
    const fail = (err) => { if (S.mod !== m) return; kit.dispose(); root.replaceChildren(modFail(title, err)); };
    try {
      const render = pg ? pg.render : def && def.render;
      if (typeof render !== 'function') throw new Error('it has no render(el, kit)');
      Promise.resolve(render(root, kit)).then((hd) => { if (S.mod === m) m.handle = hd && typeof hd === 'object' ? hd : null; else if (hd && typeof hd.dispose === 'function') hd.dispose(); }, fail);
    } catch (err) { fail(err); }
  }
  function modUpdate() {
    const m = S.mod;
    if (!m || !m.handle || typeof m.handle.update !== 'function') return;
    try { const p = m.handle.update(); if (p && typeof p.catch === 'function') p.catch((e) => { S.problems.modupdate = 'This page could not refresh: ' + msg(e); schedule(); }); }
    catch (e) { S.problems.modupdate = 'This page could not refresh: ' + msg(e); schedule(); }
  }

  V.home = function () {
    const vol = qp('volume'), br = qp('brightness'), bt = qp('bluetooth'), nl = qp('nightlight');
    const net = slot('net'), bat = slot('battery'), pm = slot('pm'), mn = slot('mantle'), au = slot('audio');
    const outName = au.v && Array.isArray(au.v.devices) ? (au.v.devices.find((d) => d.isDefault) || {}).name : null;
    const tiles = [];
    const cant = [];
    // tip: the tile's full words when s is only a count (the Mantle tile: its reasons are the card below)
    function T(key, section, ico, k, v, s, warn, tip) {
      if (s && warn) cant.push(k);
      if (s && warn) s = M.plain(s);   // a failure's reason in plain words, never "the sidecar is restarting"
      // a number keeps its unit on its line ("3 hr 4 min left" never breaks as "3 / hr")
      if (s && !warn) s = String(s).replace(/(\d) (?=[A-Za-z%])/g, '$1 ');
      tiles.push(keep('tile-' + key, [section, ico, k, v, s || null, !!warn, tip || null], () => h('button', { class: 'tileb', type: 'button', 'data-k': 'tile-' + key, 'data-act': 'nav', 'data-section': section },
        h('span', { class: 't-k' }, icon(ico), k), h('span', { class: 't-v' }, v),
        s ? h('span', { class: 't-s' + (warn ? ' warn' : ''), title: cap(tip || s) }, warn ? icon('warn', 12) : null, cap(s)) : null)));
    }
    // sound
    if (!vol) T('sound', 'sound', 'sound', 'Sound', '…', 'Reading the volume');
    else if (!partOk(vol)) T('sound', 'sound', 'sound', 'Sound', 'Unavailable', vol.reason, true);
    else T('sound', 'sound', 'sound', 'Sound', vol.muted ? 'Muted' : M.pct(vol.level), au.st === 'fail' ? 'Output device: ' + au.reason : outName || 'Default output', au.st === 'fail');
    // network
    const nw = M.netWords(net.v);
    if (net.st === 'fail') T('network', 'network', 'network', 'Network', 'Unavailable', net.reason, true);
    else if (!net.v) T('network', 'network', 'network', 'Network', '…', 'Reading the network');
    else {
      const n = net.v, w = n.wifi || {};
      T('network', 'network', 'network', 'Network', n.ok === false ? 'Unavailable' : n.kind === 'ethernet' ? 'Ethernet' : w.connected ? (w.ssid || 'Wi-Fi') : 'Not connected', nw.text, nw.warn);
    }
    // bluetooth
    if (!bt) T('bt', 'bluetooth', 'bluetooth', 'Bluetooth', '…', 'Reading the radio');
    else if (!partOk(bt)) T('bt', 'bluetooth', 'bluetooth', 'Bluetooth', 'Unavailable', bt.reason, true);
    else if (bt.present === false) T('bt', 'bluetooth', 'bluetooth', 'Bluetooth', 'No radio', 'This PC has no Bluetooth radio');
    else T('bt', 'bluetooth', 'bluetooth', 'Bluetooth', bt.on ? 'On' : 'Off', bt.on ? 'Paired devices can connect' : 'Paired devices cannot connect');
    // power
    const bw = M.batteryWords(bat.v);
    const pmv = pm.v && pm.v.ok !== false ? M.PM_LABEL[pm.v.mode] || pm.v.mode : null;
    if (bat.st === 'fail' || (bat.v && bat.v.ok === false)) T('power', 'power', 'power', 'Power & battery', 'Unavailable', bat.reason || bw.text, true);
    else if (!bat.v) T('power', 'power', 'power', 'Power & battery', '…', 'Reading the battery');
    else T('power', 'power', 'power', 'Power & battery', bw.none ? 'Mains power' : bw.percent != null ? Math.round(bw.percent) + '%' : 'Unknown',
      [pmv ? 'Power mode: ' + pmv : pm.st === 'fail' || (pm.v && pm.v.ok === false) ? 'Power mode: ' + ((pm.v && pm.v.reason) || pm.reason) : null, bw.none ? null : bw.text.replace(/^\d+% · /, '')].filter(Boolean).join(' · '),
      bw.warn || pm.st === 'fail' || !!(pm.v && pm.v.ok === false));
    // display
    if (!br) T('display', 'display', 'brightness', 'Display', '…', 'Reading the brightness');
    else if (!partOk(br) || br.present === false) T('display', 'display', 'brightness', 'Display', 'No brightness control', br.reason || 'This display does not expose its brightness', true);
    else T('display', 'display', 'brightness', 'Display', 'Brightness ' + M.pct(br.level), nl && partOk(nl) ? 'Night light ' + (nl.on ? 'on' : 'off') : nl ? 'Night light: ' + nl.reason : '', nl && !partOk(nl));
    // mantle
    if (mn.st === 'fail') T('mantle', 'mantle', 'mantle', 'Mantle', 'Unavailable', 'Mantle\'s features could not be read: ' + mn.reason, true);
    else if (!mn.v) T('mantle', 'mantle', 'mantle', 'Mantle', '…', 'Reading Mantle\'s features');
    else {
      const hh = M.health(mn.v.features);
      // the tile only COUNTS what needs a look: each one, with its reason, is a line of the card below
      T('mantle', 'mantle', 'mantle', 'Mantle', hh.on + ' of ' + hh.total + ' features on',
        hh.bad.length ? M.plural(hh.bad.length, 'feature') + ' ' + (hh.bad.length === 1 ? 'needs' : 'need') + ' a look' : hh.resting.length ? 'Resting: ' + hh.resting.map((r) => r.label).join(', ') : 'All healthy', hh.bad.length > 0,
        hh.bad.length ? hh.bad.map((b) => b.label + ': ' + b.reason).join('; ') : null);
    }
    // The tiles ARE the readings, so the line under the title only names what needs a look (lane setlook:
    // it used to repeat every tile's reading and ran on into a warning sentence)
    const out = head('Home', sumParts([cant.length ? { warn: 'Needs a look: ' + cant.join(', ') } : null]));
    out.push(h('div', { class: 'tiles', 'data-k': 'tiles' }, tiles));
    if (mn.v) {
      const hh = M.health(mn.v.features);
      // Settings' own problems (its icon file missing, ...) from settings.mantle, then the features
      const own = Array.isArray(mn.v.problems) ? mn.v.problems : [];
      if (hh.bad.length || hh.resting.length || own.length) {
        out.push(groupT(hh.bad.length || own.length ? 'Mantle needs a look' : 'Mantle is resting', 'home-attn'));
        out.push(keep('home-attn', [own, hh.bad.map((b) => [b.name, b.label, b.reason]), hh.resting.map((b) => [b.name, b.label, b.reason])], () => {
          const c = card('home-attn', own.map((p, i) => h('div', { class: 'row', 'data-k': 'own-' + i },
            h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, 'Mantle Settings'), why(p)))), attnLines(hh.bad), hh.resting.map((b) => attnRow(b, 'rest',
            h('div', { class: 'row-h' }, 'Resting while ' + String(b.reason).replace(/^while\s+/i, '')))));
          c.classList.add('attn');
          return c;
        }));
      }
    }
    return out.concat(moreCard('home'));
  };
  /* Home's "needs a look" card: ONE line per feature, and each reason said ONCE. Features that share a
     reason sit under it: a sidecar restart takes several down with the same words, and one keys cause
     (Mantle has not taken the shell, a test run) reaches every feature with only its chords differing,
     so keys faults group by M.health's cause and each line keeps its own chords. A feature alone
     carries its whole reason beside its name. Every line opens the feature's row on the Mantle page. */
  function attnRow(b, cls, words) {
    return h('button', { class: 'row clickable' + (cls ? ' ' + cls : ''), type: 'button', 'data-k': 'attn-' + b.name, 'data-act': 'nav', 'data-row': M.featureRow(b.name), 'data-section': 'mantle' },
      h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, b.label), words || null),
      h('span', { class: 'arr' }, icon('chev', 14)));
  }
  function attnLines(bad) {
    const by = new Map();
    bad.forEach((b) => { const k = b.cause ? 'k:' + b.cause : 'r:' + cap(b.reason); if (!by.has(k)) by.set(k, []); by.get(k).push(b); });
    const out = [];
    // does the label already name the chords ("Search (Win+S)")? then a line need not repeat them
    const named = (b) => /Win\+/.test(b.label) || b.keys.split(', ').some((c) => b.label.indexOf(c) >= 0);
    by.forEach((list) => {
      const b0 = list[0];
      if (list.length === 1) {
        out.push(attnRow(b0, null, why(!b0.cause ? b0.reason : named(b0) ? 'Its keys are ' + b0.cause : 'Its keys (' + b0.keys + ') are ' + b0.cause)));
        return;
      }
      out.push(h('div', { class: 'attn-why', 'data-k': 'why-' + b0.name }, icon('warn', 12), h('span', null, b0.cause ? 'Their keys are ' + b0.cause : cap(b0.reason))));
      // under a keys cause, a line names its own chords unless its label already does
      list.forEach((b) => out.push(attnRow(b, 'under', b.cause && b.keys && !named(b) ? h('div', { class: 'row-h' }, b.keys) : null)));
    });
    return out;
  }

  V.display = function () {
    const br = qp('brightness'), nl = qp('nightlight');
    const out = head('Display', sumParts([
      br && partOk(br) && br.present !== false ? 'Brightness ' + M.pct(br.level) : br ? { warn: 'No brightness control' } : null,
      nl && partOk(nl) ? 'Night light ' + (nl.on ? 'on' : 'off') : null,
      slot('displays').v && slot('displays').v.displays ? M.plural(slot('displays').v.displays.length, 'display') : null,
    ]));
    out.push(groupT('Brightness & colour', 'display-bc'));
    const brLive = partOk(br) && br && br.present !== false;
    const brHeld = qsHeld('brightness');
    const brV = brHeld && S.shown.brightness != null ? S.shown.brightness : br && typeof br.level === 'number' ? br.level : 0;
    out.push(card('display-bc',
      row({ id: 'display.brightness', label: 'Brightness', tile: tile(icon('brightness')),
        help: !br ? 'Reading…' : brLive ? 'Changes the built-in screen\'s backlight' : null,
        why: br && !brLive ? (br.reason || 'This display does not expose its brightness to Windows') : null,
        ctl: [h('input', { type: 'range', min: 0, max: 100, step: 1, 'data-val': Math.round(brV), 'data-input': 'level', 'data-part': 'brightness', 'aria-label': 'Brightness', disabled: !brLive }),
          h('span', { class: 'rng-v' }, brLive ? Math.round(brV) + '%' : '—')] }),
      row({ id: 'display.nightlight', label: 'Night light', tile: tile(icon('moon')),
        help: 'Warmer colours to help you sleep; its schedule is in Windows Settings',
        why: nl && !partOk(nl) ? nl.reason : nl && nl.present === false ? (nl.reason || 'Night light is not set up on this PC') : null,
        ctl: sw(!!(nl && nl.on), { 'data-act': 'qs', 'data-part': 'nightlight' }, { label: 'Night light', disabled: !nl || !partOk(nl) || nl.present === false, pending: !!S.qsBusy.nightlight }) })));
    out.push(groupT('Displays', 'display.monitors', 'Read only here'));
    const g = gate('displays', 'display-list');
    if (g) out.push(g);
    else {
      const ds = slot('displays').v.displays || [];
      if (!ds.length) out.push(card('display-list', h('div', { class: 'empty' }, 'Windows reported no displays')));
      ds.forEach((d, i) => {
        out.push(card('disp-' + i,
          row({ id: 'display.monitor.' + i, label: d.label || 'Display ' + (i + 1), tile: tile(icon('display')),
            help: [d.primary ? 'Main display' : null, d.internal ? 'Built-in' : 'External'].filter(Boolean).join(' · '),
            ctl: winBtn('Change in Windows Settings', 'ms-settings:display') }),
          h('div', { class: 'facts', 'data-k': 'facts' }, M.displayFacts(d).map((f) => h('div', { 'data-k': f[0] }, h('div', { class: 'fk' }, f[0]), h('div', { class: 'fv' }, f[1]))))));
      });
    }
    return out.concat(moreCard('display'));
  };

  V.sound = function () {
    const vol = qp('volume'), au = slot('audio'), ss = slot('sessions');
    const devs = au.v && Array.isArray(au.v.devices) ? au.v.devices : [];
    const def = devs.find((d) => d.isDefault);
    const apps = ss.v && Array.isArray(ss.v.sessions) ? ss.v.sessions : [];
    const out = head('Sound', sumParts([def ? def.name : null, vol && partOk(vol) ? (vol.muted ? 'Muted' : 'Volume ' + M.pct(vol.level)) : vol ? { warn: 'Volume unavailable' } : null,
      ss.v && ss.v.ok !== false ? M.plural(apps.length, 'app') + ' with sound' : null]));
    out.push(groupT('Output', 'sound-out'));
    const volLive = partOk(vol) && !!vol;
    const vHeld = qsHeld('volume');
    const vV = vHeld && S.shown.volume != null ? S.shown.volume : vol && typeof vol.level === 'number' ? vol.level : 0;
    const outRow = () => {
    let outCtl, outWhy = null;
    if (au.st === 'fail') { outWhy = 'The playback devices could not be read: ' + au.reason; outCtl = btn('Try again', { 'data-act': 'retry', 'data-what': 'audio' }); }
    else if (!au.v) outCtl = h('span', { class: 'state' }, 'Reading…');
    else if (au.v.ok === false) { outWhy = au.v.reason || 'The playback devices could not be read'; outCtl = btn('Try again', { 'data-act': 'retry', 'data-what': 'audio' }); }
    else if (!devs.length) { outWhy = 'Windows reports no active playback device'; outCtl = winBtn('Sound devices', 'ms-settings:sound-devices'); }
    else outCtl = h('span', { class: 'selwrap' }, h('select', { 'data-change': 'out', 'data-val': def ? def.id : '', 'aria-label': 'Output device', disabled: pend('sound.output') },
      devs.map((d) => h('option', { value: d.id, 'data-k': d.id, selected: d.isDefault }, d.name))));
    return row({ id: 'sound.output', label: 'Output device', help: 'Where sound plays: the default for every app', tile: tile(icon('sound')), why: outWhy, ctl: outCtl });
    };
    out.push(card('sound-out',
      keep('sound.output', [au.st, au.reason, au.v, pend('sound.output')], outRow),
      keep('sound.volume', [vol, vHeld, Math.round(vV), volLive], () => row({ id: 'sound.volume', label: 'Volume', tile: tile(icon(vol && vol.muted ? 'mute' : 'sound')),
        help: !vol ? 'Reading…' : volLive ? (vol.muted ? 'Muted' : 'The default output\'s level') : null, why: vol && !volLive ? vol.reason : null,
        ctl: [h('input', { type: 'range', min: 0, max: 100, step: 1, 'data-val': Math.round(vV), 'data-input': 'level', 'data-part': 'volume', 'aria-label': 'Volume', disabled: !volLive }),
          h('span', { class: 'rng-v' }, volLive ? Math.round(vV) + '%' : '—'),
          h('button', { class: 'ibtn' + (vol && vol.muted ? ' on' : ''), type: 'button', 'data-act': 'mute', 'aria-pressed': vol && vol.muted ? 'true' : 'false', 'aria-label': vol && vol.muted ? 'Unmute' : 'Mute', title: vol && vol.muted ? 'Unmute' : 'Mute', disabled: !volLive }, icon(vol && vol.muted ? 'mute' : 'sound'))] }))));
    out.push(groupT('Input', 'sound-in'));
    const ins = au.v && Array.isArray(au.v.inputs) ? au.v.inputs : null;
    out.push(card('sound-in', keep('sound.input', [ins], () => row({ id: 'sound.input', label: 'Input device', cls: 'dim', tile: tile(icon('mic')),
      help: ins && ins.length ? (ins.find((d) => d.isDefault) || ins[0]).name : null,
      info: ins && ins.length ? null : 'Mantle reads playback devices only, so the microphone is chosen in Windows Settings',
      ctl: winBtn('Open', 'ms-settings:sound-devices') }))));
    out.push(groupT('Volume mixer', 'sound.mixer', ss.v && ss.v.device ? 'On ' + ss.v.device.name : null));
    const g = gate('sessions', 'sound-mix');
    if (g) out.push(g);
    else if (ss.v.ok === false) out.push(card('sound-mix', h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')), h('div', { class: 'row-l' }, ss.v.reason || 'The apps playing sound could not be read'), btn('Try again', { 'data-act': 'retry', 'data-what': 'sessions' }))));
    else if (!apps.length) out.push(card('sound-mix', h('div', { class: 'empty' }, 'No app has sound open right now')));
    else out.push(card('sound-mix', apps.map((a) => {
      const id = 'sound.mixer.' + a.key, busy = !!(slv[a.key] && slv[a.key].busy);
      return keep(id, [a, busy], () => row({ id, cls: 'mix', label: h('span', { class: 'mixname', title: a.name }, a.name),
        tile: tile(a.icon ? h('img', { src: a.icon, alt: '' }) : M.letter(a.name)),
        help: a.system ? 'Windows\' own sounds' : a.active ? 'Playing' : (a.sessions > 1 ? a.sessions + ' sessions' : 'Quiet'),
        ctl: [h('input', { type: 'range', min: 0, max: 100, step: 1, 'data-val': Math.round(a.level || 0), 'data-input': 'app-level', 'data-key': a.key, 'aria-label': a.name + ' volume', 'aria-busy': busy ? 'true' : null }),
          h('span', { class: 'rng-v' }, Math.round(a.level || 0) + '%'),
          h('button', { class: 'ibtn' + (a.muted ? ' on' : ''), type: 'button', 'data-act': 'app-mute', 'data-key': a.key, 'aria-pressed': a.muted ? 'true' : 'false', 'aria-label': (a.muted ? 'Unmute ' : 'Mute ') + a.name, title: a.muted ? 'Unmute' : 'Mute' }, icon(a.muted ? 'mute' : 'sound'))] }));
    })));
    return out.concat(moreCard('sound'));
  };

  V.bluetooth = function () {
    const bt = qp('bluetooth'), l = slot('bt');
    const devs = l.v && Array.isArray(l.v.devices) ? l.v.devices : [];
    const conn = devs.filter((d) => d.connected).length;
    const radioOn = !!(bt && bt.on);
    const out = head('Bluetooth & devices', sumParts([bt ? (!partOk(bt) ? { warn: 'Radio unavailable' } : bt.present === false ? 'No radio' : radioOn ? 'On' : 'Off') : null,
      l.v && l.v.ok !== false && devs.length ? conn + ' of ' + M.plural(devs.length, 'paired device') + ' connected' : null]));
    out.push(groupT('Bluetooth', 'bt-radio'));
    out.push(card('bt-radio', row({ id: 'bluetooth.radio', label: 'Bluetooth', tile: tile(icon('bluetooth')),
      help: !bt ? 'Reading…' : partOk(bt) && bt.present !== false ? (radioOn ? 'Discoverable to your paired devices' : 'Paired devices cannot connect while it is off') : null,
      why: bt && !partOk(bt) ? bt.reason : bt && bt.present === false ? 'This PC has no Bluetooth radio' : null,
      ctl: sw(radioOn, { 'data-act': 'qs', 'data-part': 'bluetooth' }, { label: 'Bluetooth', disabled: !bt || !partOk(bt) || bt.present === false, pending: !!S.qsBusy.bluetooth }) })));
    out.push(groupT('Paired devices', 'bluetooth.devices'));
    const g = gate('bt', 'bt-devs');
    if (g) out.push(g);
    else if (l.v.ok === false) out.push(card('bt-devs', h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')), h('div', { class: 'row-l' }, l.v.reason || 'The paired devices could not be read'), btn('Try again', { 'data-act': 'retry', 'data-what': 'bt' }))));
    else if (l.v.present === false) out.push(card('bt-devs', h('div', { class: 'empty' }, l.v.radioReason || l.v.reason || 'This PC has no Bluetooth radio')));
    else {
      const rows = [];
      if (S.btWatchWhy) rows.push(h('div', { class: 'empty', 'data-k': 'watchwhy' }, why('The device watch could not start (' + S.btWatchWhy + '), so this list re-reads every 3 s')));
      if (l.v.on === false) rows.push(h('div', { class: 'empty', 'data-k': 'off' }, why('Bluetooth is off, so paired devices cannot connect. Turn it on above.', true)));
      if (!devs.length) rows.push(h('div', { class: 'empty', 'data-k': 'none' }, 'No devices are paired with this PC yet'));
      devs.forEach((d) => {
        const id = 'bluetooth.dev.' + d.id, busy = (l.v.busy && l.v.busy.device === d.id) || pend(id);
        const bat = d.connected ? (typeof d.battery === 'number' ? d.battery + '% battery' : null) : null;
        let ctl = null, info = null;
        if (busy) ctl = btn(l.v.busy && l.v.busy.op === 'disconnect' ? 'Disconnecting…' : 'Connecting…', { disabled: true }, 'pending');
        else if (d.connected && (d.canConnect || d.audio)) ctl = btn('Disconnect', { 'data-act': 'bt-conn', 'data-op': 'disconnect', 'data-dev': d.id, disabled: l.v.on === false });
        else if (d.canConnect) ctl = btn('Connect', { 'data-act': 'bt-conn', 'data-op': 'connect', 'data-dev': d.id, disabled: l.v.on === false });
        else info = d.connectWhy || 'Mantle cannot connect this kind of device';
        rows.push(row({ id, label: d.name || 'Unnamed device', tile: tile(M.letter(d.kind === 'other' ? d.name : d.kind), d.connected ? 'acc' : ''),
          help: [d.connected ? 'Connected' : 'Not connected', bat, d.connected && d.battery == null && d.batteryWhy ? 'battery not reported' : null].filter(Boolean).join(' · '),
          info: info, ctl }));
      });
      out.push(card('bt-devs', rows));
    }
    out.push(h('p', { class: 'footnote', 'data-k': 'bt-foot' }, 'Pairing a new device happens in Windows Settings. ',
      h('button', { class: 'lnk', type: 'button', 'data-act': 'win', 'data-uri': 'ms-settings:bluetooth' }, 'Add a device')));
    return out.concat(moreCard('bluetooth'));
  };

  V.network = function () {
    const w = qp('wifi'), net = slot('net'), wl = slot('wifi');
    const nw = M.netWords(net.v);
    const out = head('Network & Wi-Fi', sumParts([net.st === 'fail' ? { warn: 'The network could not be read' } : net.v ? (nw.warn ? { warn: nw.text } : nw.text) : null,
      w && partOk(w) && w.present !== false ? 'Wi-Fi ' + (w.on ? 'on' : 'off') : null]));
    out.push(groupT('Wi-Fi', 'net-wifi'));
    const wOn = !!(w && w.on);
    out.push(card('net-wifi',
      keep('network.wifi', [w, !!S.qsBusy.wifi], () => row({ id: 'network.wifi', label: 'Wi-Fi', tile: tile(icon('network')),
        help: !w ? 'Reading…' : partOk(w) && w.present !== false ? (wOn ? 'The wireless radio is on' : 'The wireless radio is off') : null,
        why: w && !partOk(w) ? w.reason : w && w.present === false ? 'This PC has no Wi-Fi adapter' : null,
        ctl: sw(wOn, { 'data-act': 'qs', 'data-part': 'wifi' }, { label: 'Wi-Fi', disabled: !w || !partOk(w) || w.present === false, pending: !!S.qsBusy.wifi }) })),
      keep('network.status', [net.st, net.reason, net.v], () => row({ id: 'network.status', label: 'Connection', tile: tile(icon('network')),
        help: net.v && net.v.ok !== false && !nw.warn ? nw.text + (net.v.adapter ? ' · ' + net.v.adapter : '') : !net.v && net.st !== 'fail' ? 'Reading…' : null,
        why: net.st === 'fail' ? 'The network could not be read: ' + net.reason : nw.warn ? nw.text : null,
        ctl: net.v && net.v.ok !== false && net.v.internet ? h('span', { class: 'state ok' }, h('span', { class: 'pip ok' }), 'Internet') : null }))));
    const scanning = pend('network.scan');
    out.push(groupT('Available networks', 'network.networks',
      h('button', { class: 'ibtn' + (scanning ? ' spin' : ''), type: 'button', 'data-act': 'wifi-scan', title: 'Look for networks', 'aria-label': 'Look for networks', disabled: scanning || !(wl.v && wl.v.on) }, icon('refresh'))));
    const g = gate('wifi', 'net-list');
    const nn = S.notes['network.networks'];
    if (g) out.push(g);
    else if (wl.v.ok === false) out.push(card('net-list', h('div', { class: 'fail' }, h('span', { class: 'row-ico' }, icon('warn')), h('div', { class: 'row-l' }, wl.v.reason || 'The Wi-Fi networks could not be read'), btn('Try again', { 'data-act': 'retry', 'data-what': 'wifi' }))));
    else if (wl.v.present === false) out.push(card('net-list', h('div', { class: 'empty' }, wl.v.reason || 'This PC has no Wi-Fi adapter')));
    else if (!wl.v.on) out.push(card('net-list', h('div', { class: 'empty' }, 'Wi-Fi is off, so no networks are listed. Turn it on above.')));
    else {
      const nets = Array.isArray(wl.v.networks) ? wl.v.networks : [];
      const rows = [];
      if (nn) rows.push(h('div', { class: 'empty', 'data-k': 'scan-note' }, why(nn.text, nn.tone === 'info')));
      if (wl.v.last && wl.v.last.ok === false) rows.push(h('div', { class: 'empty', 'data-k': 'last' }, why('The last try did not join ' + (wl.v.last.ssid || 'the network') + ': ' + (wl.v.last.reason || 'no reason came back'))));
      if (!nets.length) rows.push(h('div', { class: 'empty', 'data-k': 'none' }, 'No networks in range. Refresh to look again.'));
      nets.forEach((n, i) => {
        const k = wifiKey(n, i), id = 'network.net.' + k, joining = pend('network.join.' + k) || n.connecting;
        rows.push(keep(id, [n, !!joining, S.expand === k], () => {
        const bars = Math.max(1, Math.min(4, Math.ceil((n.signal || 0) / 25)));
        let ctl = null, info = null;
        if (joining) ctl = btn('Connecting…', { disabled: true }, 'pending');
        else if (n.action === 'disconnect' || n.connected) ctl = btn('Disconnect', { 'data-act': 'wifi-off' });
        else if (n.action === 'connect' || n.action === 'open' || n.action === 'password') ctl = S.expand === k ? null : btn('Connect', { 'data-act': 'wifi-go', 'data-net': k });
        else { info = 'Mantle cannot join it: ' + (n.why || 'Windows\' own Wi-Fi list has to'); ctl = winBtn('Open in Windows', 'ms-settings:network-wifi'); }
        const pw = S.expand === k ? h('div', { class: 'pw', 'data-k': 'pw' },
          h('input', { class: 'inp', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Network password', 'aria-label': 'Password for ' + (n.ssid || 'the network'), 'data-enter': 'wifi-pw', 'data-net': k }),
          btn('Connect', { 'data-act': 'wifi-pw', 'data-net': k }, 'acc'), btn('Cancel', { 'data-act': 'wifi-cancel' }, 'quiet')) : null;
        return row({ id, label: n.hidden ? 'Hidden network' : n.ssid, tile: tile(sig(bars), n.connected ? 'acc' : ''),
          help: [n.connected ? 'Connected' : null, n.secure ? n.security || 'Secured' : 'Open', n.known && !n.connected ? 'Saved' : null].filter(Boolean).join(' · '),
          info, extra: pw, ctl });
        }));
      });
      out.push(card('net-list', rows));
    }
    return out.concat(moreCard('network'));
  };

  V.power = function () {
    const pm = slot('pm'), bat = slot('battery'), gm = slot('gm'), pw = qp('power');
    const bw = M.batteryWords(bat.v);
    const p = pm.v;
    const out = head('Power & battery', sumParts([bat.v && !bw.none ? (bw.warn ? { warn: bw.text } : bw.text) : bw.none ? 'Mains power' : null,
      p && p.ok !== false ? M.PM_LABEL[p.inForce || p.mode] || p.mode : null]));
    out.push(groupT('Power', 'pw-mode'));
    let modeWhy = null, modeCtl;
    if (pm.st === 'fail') modeWhy = 'The power mode could not be read: ' + pm.reason;
    else if (p && p.ok === false) modeWhy = p.reason || 'The power mode could not be read';
    else if (p && (p.available === false || p.settable === false)) modeWhy = p.reason || 'Windows will not let the power mode be set right now';
    const canSet = !!(p && p.ok !== false && p.available !== false && p.settable !== false);
    if (!p && pm.st !== 'fail') modeCtl = h('span', { class: 'state' }, 'Reading…');
    else modeCtl = h('div', { class: 'seg' + (pend('power.mode') ? ' pending' : ''), role: 'radiogroup', 'aria-label': 'Power mode' },
      ['efficiency', 'balanced', 'performance'].map((m) => h('button', { type: 'button', role: 'radio', 'data-k': m, 'aria-checked': p && (p.inForce || p.mode) === m ? 'true' : 'false', 'data-act': 'pm', 'data-mode': m, disabled: !canSet }, M.PM_LABEL[m].replace('Best ', ''))));
    const saverOn = !!((p && p.saver) || (pw && pw.saver) || (bat.v && bat.v.saver));
    out.push(card('pw-mode',
      row({ id: 'power.mode', label: 'Power mode', tile: tile(icon('power')), help: canSet ? 'How Windows trades battery life for speed' : null, why: modeWhy, ctl: modeCtl }),
      row({ id: 'power.saver', label: 'Energy saver', tile: tile(icon('brightness')), help: saverOn ? 'On: Windows is saving power' : 'Off',
        info: 'Windows lets only its own Settings switch Energy saver', ctl: winBtn('Open', 'ms-settings:batterysaver') })));
    out.push(groupT('Battery', 'pw-bat'));
    out.push(bat.st === 'fail' ? failCard('battery', bat.reason, 'pw-bat') : card('pw-bat',
      row({ id: 'power.battery', label: bw.none ? 'No battery' : 'Battery', tile: tile(bw.percent != null ? String(Math.round(bw.percent)) : icon('power')),
        help: bat.v ? (bw.warn ? null : bw.text) : 'Reading…', why: bw.warn ? bw.text : null, info: bat.v && !bw.warn && bw.reason ? bw.reason : null })));
    out.push(groupT('Game mode', 'pw-gm'));
    const g = gm.v;
    let gHelp = 'Reading…', gWhy = null;
    if (gm.st === 'fail') { gHelp = null; gWhy = 'Game mode could not be read: ' + gm.reason; }
    else if (g) {
      if (g.enabled === false) gHelp = 'Switched off in Mantle';
      else if (g.on) gHelp = 'On' + (g.game && g.game.file ? ' · ' + g.game.file : '') + (g.how === 'manual' ? ' · turned on by hand' : '');
      else gHelp = 'Off · ' + (g.watching === false ? 'games are not being watched' : g.auto ? 'turns on by itself when a game starts' : 'turns on only by hand');
      if (g.watching === false && g.reason) gWhy = g.reason;
    }
    out.push(card('pw-gm', row({ id: 'power.gamemode', label: 'Game mode', tile: tile(icon('game')), help: gHelp, why: gWhy,
      ctl: btn('Game mode options', { 'data-act': 'nav', 'data-section': 'mantle', 'data-row': M.featureRow('gamemode') }) })));
    return out.concat(moreCard('power'));
  };

  V.notifications = function () {
    const m = slot('mantle'), swr = m.v && m.v.switcher;
    const out = head('Notifications', sumParts(['Do not disturb is switched in Windows Settings', swr ? 'Mantle\'s panels ' + (swr.winKeys ? 'on' : 'off') : null]));
    out.push(groupT('Notifications', 'ntf'));
    let pWhy = null;
    if (m.st === 'fail') pWhy = 'Mantle\'s switches could not be read: ' + m.reason;
    else if (swr && swr.ok === false) pWhy = swr.reason || 'The switcher is not healthy, and gave no reason';
    else if (swr && swr.winKeysReason) pWhy = swr.winKeysReason;
    out.push(card('ntf',
      row({ id: 'notifications.dnd', label: 'Do not disturb', tile: tile(icon('notifications')), help: 'Silences notification banners',
        why: 'Mantle cannot switch Do not disturb yet (no backend for it)',
        ctl: [winBtn('Open in Windows', 'ms-settings:quiethours'), sw(false, {}, { disabled: true, label: 'Do not disturb' })] }),
      row({ id: 'notifications.panels', label: 'Mantle\'s notification and quick settings panels', tile: tile(icon('mantle')),
        help: 'Win+N opens the notification center and Win+A quick settings, both drawn by Mantle', why: pWhy,
        ctl: sw(!!(swr && swr.winKeys), { 'data-act': 'switcher', 'data-key': 'winKeys' }, { label: 'Win+N and Win+A panels', disabled: !swr, pending: pend('notifications.panels') }) })));
    return out.concat(moreCard('notifications'));
  };

  V.apps = function () {
    const st = slot('startup'), fl = slot('features');
    const items = st.v && Array.isArray(st.v.items) ? st.v.items : [];
    const onN = items.filter((i) => i.enabled).length;
    const out = head('Apps', sumParts([st.v ? onN + ' of ' + M.plural(items.length, 'startup app') + ' on' : st.st === 'fail' ? { warn: 'Startup apps could not be read' } : null]));
    out.push(groupT('Startup apps', 'apps.startup', st.v ? onN + ' of ' + items.length + ' start when you sign in' : null));
    const g = gate('startup', 'apps-startup');
    if (g) out.push(g);
    else {
      const rows = [];
      (Array.isArray(st.v.problems) ? st.v.problems : []).forEach((p, i) => rows.push(h('div', { class: 'empty', 'data-k': 'prob-' + i }, why(p))));
      if (!items.length) rows.push(h('div', { class: 'empty', 'data-k': 'none' }, 'Nothing is set to start when you sign in'));
      items.forEach((it) => {
        const id = 'apps.startup.' + it.item;
        rows.push(row({ id, label: it.name || it.item, tile: tile(M.letter(it.name)),
          help: [it.sourceLabel || it.source, M.shortCommand(it.command, 56)].filter(Boolean).join(' · '), title: it.command || null,
          why: it.canToggle === false ? (it.reason || 'Mantle cannot switch this entry, and gave no reason') : null,
          ctl: sw(!!it.enabled, { 'data-act': 'startup', 'data-item': it.item }, { label: 'Start ' + (it.name || 'this app') + ' when you sign in', disabled: it.canToggle === false, pending: pend(id) }) }));
      });
      out.push(card('apps-startup', rows));
    }
    out.push(h('p', { class: 'footnote', 'data-k': 'st-foot' }, 'Store apps start themselves through their own startup tasks, which are listed in Windows Settings. ',
      h('button', { class: 'lnk', type: 'button', 'data-act': 'win', 'data-uri': 'ms-settings:startupapps' }, 'Open Startup apps')));
    out.push(groupT('Apps', 'apps-more'));
    let tm;
    if (fl.st === 'fail') tm = { can: false, why: 'Mantle\'s feature list could not be read: ' + fl.reason };
    else if (!fl.v) tm = { can: false, why: null, wait: true };
    else tm = M.taskmgr(fl.v);
    out.push(card('apps-more',
      row({ id: 'apps.taskmgr', label: 'Task manager', tile: tile(icon('apps')), help: tm.wait ? 'Reading…' : tm.can ? 'Mantle\'s own view of what is running' : null, why: tm.why,
        ctl: btn('Open', { 'data-act': 'taskmgr', disabled: !tm.can }) }),
      row({ id: 'apps.installed', label: 'Installed apps', tile: tile(icon('apps')), help: 'Uninstall and repair apps', ctl: winBtn('Open', 'ms-settings:appsfeatures') }),
      row({ id: 'apps.defaults', label: 'Default apps', tile: tile(icon('apps')), help: 'The browser, and which app opens each file type', ctl: winBtn('Open', 'ms-settings:defaultapps') })));
    return out.concat(moreCard('apps'));
  };

  function optionCtl(f, o) {
    const id = M.optionRow(f.name, o.key), p = pend(id), base = { 'data-feature': f.name, 'data-key': o.key };
    const reset = !o.isDefault && o.type !== 'bool' ? btn('Reset', Object.assign({ 'data-act': 'opt-reset', title: 'Back to ' + (o.defaultLabel || M.optionValue(Object.assign({}, o, { value: o.default }))) }, base), 'quiet') : null;
    const off = !f.enabled || p;
    if (o.type === 'bool') return sw(!!o.value, Object.assign({ 'data-act': 'opt-bool' }, base), { label: o.label, pending: p, disabled: !f.enabled });
    if (o.type === 'choice') {
      const cs = Array.isArray(o.choices) ? o.choices : [];
      const short = cs.length <= 3 && cs.reduce((n, c) => n + String(c.label).length, 0) <= 30;
      if (short) return [reset, h('div', { class: 'seg' + (p ? ' pending' : ''), role: 'radiogroup', 'aria-label': o.label },
        cs.map((c, i) => h('button', Object.assign({ type: 'button', role: 'radio', 'data-k': 'c' + i, 'aria-checked': c.value === o.value ? 'true' : 'false', 'data-act': 'opt-choice', 'data-i': i, disabled: off }, base), c.label)))];
      const cur = cs.findIndex((c) => c.value === o.value);
      return [reset, h('span', { class: 'selwrap' }, h('select', Object.assign({ 'data-change': 'opt-select', 'data-val': cur, 'aria-label': o.label, disabled: off }, base),
        cs.map((c, i) => h('option', { value: i, 'data-k': 'c' + i, selected: i === cur }, c.label))))];
    }
    if (o.type === 'number') return [reset, h('input', Object.assign({ class: 'inp num', type: 'number', min: o.min, max: o.max, step: o.step || 'any', 'data-val': o.value == null ? '' : o.value, 'data-change': 'opt-num', placeholder: o.placeholder || (o.default != null ? String(o.default) : null), 'aria-label': o.label, disabled: off }, base)), o.unit ? h('span', { class: 'unit' }, o.unit) : null];
    if (o.type === 'text') return [reset, h('input', Object.assign({ class: 'inp txt', type: 'text', spellcheck: 'false', 'data-val': o.value == null ? '' : o.value, 'data-change': 'opt-text', placeholder: o.placeholder || o.defaultLabel || null, 'aria-label': o.label, disabled: off }, base))];
    if (o.type === 'folder') return [reset, btn('Change…', Object.assign({ 'data-act': 'opt-folder', disabled: off }, base))];
    return h('span', { class: 'state warn' }, 'This page cannot edit a "' + o.type + '" option yet');
  }

  function cornersRow(f) {
    const c = slot('corners'), v = c.v, id = 'mantle.corners';
    const nm = (v && v.names) || {};
    let body = null, whyText = null;
    if (c.st === 'fail' && !v) whyText = 'Hot corners could not be read: ' + c.reason;
    else if (!v) body = h('div', { class: 'loading', 'data-k': 'wait' }, 'Reading hot corners…');
    else {
      if (v.watch && v.watch.ok === false) whyText = 'The corners cannot fire: ' + (v.watch.reason || 'no reason came back');
      const fails = v.fails && typeof v.fails === 'object' ? Object.keys(v.fails) : [];
      if (!whyText && fails.length) whyText = 'The last try did not run: ' + fails.map((k) => (nm[k] || k) + ' (' + ((v.fails[k] && v.fails[k].said) || 'no reason came back') + ')').join('; ');
      const acts = v.actions || {}, choices = Array.isArray(v.choices) ? v.choices : [];
      body = h('div', { class: 'corners', 'data-k': 'grid' }, (v.corners || []).map((k) => {
        const name = String(nm[k] || k);
        return h('label', { 'data-k': k }, name.charAt(0).toUpperCase() + name.slice(1),
          h('span', { class: 'selwrap' }, h('select', { 'data-change': 'corner', 'data-corner': k, 'data-val': acts[k] || 'off', disabled: !f.enabled || pend(id), 'aria-label': name + ' corner' },
            choices.map((ch) => h('option', { value: ch.id, 'data-k': ch.id, selected: acts[k] === ch.id }, ch.label)))));
      }));
    }
    return [row({ id, cls: 'sub', label: 'Hot corners', help: f.enabled ? 'Push the pointer into a screen corner to run its action' : 'Turn Hot corners on to use them',
      why: whyText, ctl: c.st === 'fail' ? btn('Try again', { 'data-act': 'retry', 'data-what': 'corners' }) : null }), body];
  }

  V.mantle = function () {
    const m = slot('mantle');
    const fs = m.v && Array.isArray(m.v.features) ? m.v.features : [];
    const hh = M.health(fs);
    const out = head('Mantle', sumParts([m.v ? M.plural(hh.total, 'feature') + ' · ' + hh.on + ' on' : null,
      hh.bad.length ? { warn: hh.bad.length + ' need' + (hh.bad.length === 1 ? 's' : '') + ' attention' } : null,
      hh.resting.length ? hh.resting.length + ' resting' : null]));
    const g = gate('mantle', 'mantle-all');
    if (g) { out.push(g); return out.concat(moreCard('mantle')); }
    const swr = m.v.switcher || {};
    out.push(groupT('Window switcher', 'mantle-sw'));
    out.push(card('mantle-sw',
      swr.ok === false ? h('div', { class: 'empty', 'data-k': 'swbad' }, why(swr.reason || 'The switcher is not healthy, and gave no reason')) : null,
      row({ id: 'mantle.switcher', label: 'Alt+Tab', tile: tile(icon('mantle')), help: 'Mantle\'s window switcher instead of Windows\'', why: swr.altTabReason || null,
        ctl: sw(!!swr.altTab, { 'data-act': 'switcher', 'data-key': 'altTab' }, { label: 'Alt+Tab switcher', pending: pend('mantle.switcher') }) }),
      row({ id: 'mantle.switcher.winKeys', label: 'Win+N and Win+A', tile: tile(icon('notifications')), help: 'Mantle\'s notification center and quick settings panels', why: swr.winKeysReason || null,
        ctl: sw(!!swr.winKeys, { 'data-act': 'switcher', 'data-key': 'winKeys' }, { label: 'Win+N and Win+A panels', pending: pend('mantle.switcher.winKeys') }) })));
    out.push(groupT('Features', 'mantle.features', 'The same switches as the tray menu'));
    fs.forEach((f) => {
      const id = M.featureRow(f.name), fst = M.featureState(f);
      const opts = Array.isArray(f.options) ? f.options : [];
      out.push(card('feat-' + f.name,
        row({ id, label: f.label || f.name, tile: tile(M.letter(f.label || f.name), f.enabled && fst.tone === 'ok' ? 'acc' : ''),
          help: fst.tone === 'warn' ? null : fst.text, why: fst.tone === 'warn' ? fst.text : null,
          ctl: sw(!!f.enabled, { 'data-act': 'enable', 'data-feature': f.name }, { label: f.label || f.name, pending: pend(id) }) }),
        opts.map((o) => {
          const oid = M.optionRow(f.name, o.key);
          const val = o.type === 'folder' ? M.optionValue(o) : null;
          return row({ id: oid, cls: 'sub', label: o.label || o.key, help: o.type === 'folder' ? val : o.help || null, mono: o.type === 'folder' && o.value != null,
            info: o.type === 'folder' && o.help ? o.help : null, ctl: optionCtl(f, o) });
        }),
        f.name === 'corners' ? cornersRow(f) : null));
    });
    return out.concat(moreCard('mantle'));
  };

  V.shortcuts = function () {
    const m = slot('mantle');
    const list = m.v && Array.isArray(m.v.shortcuts) ? m.v.shortcuts : [];
    const live = list.filter((s) => s.live).length;
    const out = head('Keyboard shortcuts', sumParts([m.v ? M.plural(list.length, 'key') + ' Mantle can own · ' + live + ' live now' : null]));
    const g = gate('mantle', 'sc-all');
    if (g) { out.push(g); return out.concat(moreCard('shortcuts')); }
    out.push(groupT('Every key Mantle owns', 'shortcuts.list'));
    out.push(card('sc',
      h('div', { class: 'row sc-row sc-head', 'data-k': 'sc-head' }, h('div', null, 'Keys'), h('div', null, 'What it does'), h('div', null, 'State'), h('div', null, 'On')),
      list.map((s) => {
        const id = M.shortcutRow(s.keys), n = S.notes[id];
        return h('div', { class: 'row sc-row' + (S.flash && S.flash.row === id ? ' flash' : ''), 'data-k': id, 'data-row': id },
          h('div', null, M.keyCaps(s.keys).map((k, i) => h('span', { class: 'kc', 'data-k': 'k' + i }, k))),
          h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, s.what),
            (s.ownerLabel || s.owner) && (s.ownerLabel || s.owner) !== s.what ? h('div', { class: 'row-h' }, 'Part of ' + (s.ownerLabel || s.owner)) : null,
            n ? why(n.text, n.tone === 'info') : null),
          h('div', { class: 'state ' + (s.live ? 'ok' : s.on ? 'warn' : '') }, h('span', { class: 'pip ' + (s.live ? 'ok' : s.on ? 'warn' : '') }), s.live ? 'Mantle has it' : cap(s.why || (s.on ? 'Not live, and no reason came back' : 'Off'))),
          h('div', { class: 'row-c' }, h('button', { class: 'sw' + (pend(id) ? ' pending' : ''), type: 'button', role: 'switch', 'aria-checked': s.on ? 'true' : 'false', 'aria-label': s.keys + ' ' + s.what, 'data-act': 'sc-toggle', 'data-keys': s.keys, disabled: !s.toggle, 'aria-disabled': pend(id) ? 'true' : null })));
      })));
    out.push(h('p', { class: 'footnote', 'data-k': 'sc-foot' }, 'Rebinding is not available yet. A key that is off, or not live, goes to Windows as usual.'));
    return out.concat(moreCard('shortcuts'));
  };

  V.about = function () {
    const a = slot('about');
    const out = head('About Mantle', sumParts([a.v ? 'Mantle ' + (a.v.version || '') : null, a.v && a.v.mode === 'test' ? 'test copy' : null]));
    const g = gate('about', 'about-all');
    if (g) { out.push(g); return out.concat(moreCard('about')); }
    const v = a.v;
    const up = typeof v.uptimeMs === 'number' ? v.uptimeMs + (Date.now() - a.at) : null;
    let since = '';
    if (v.startedAt) { try { since = new Date(v.startedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { since = String(v.startedAt); } }
    out.push(groupT('Mantle', 'about-m'));
    out.push(card('about-m',
      row({ id: 'about.version', label: 'Mantle ' + (v.version || '(version unknown)'), tile: tile(icon('mantle'), 'acc'),
        help: v.commit ? 'Build ' + String(v.commit).slice(0, 7) : null, info: v.commit ? null : 'The exact build is unknown: ' + (v.commitReason || 'no reason came back') }),
      row({ id: 'about.uptime', label: 'Running since ' + (since || 'an unknown time'), tile: tile(icon('about')), help: up != null ? 'Up for ' + M.dur(up) : null }),
      row({ id: 'about.mode', label: v.mode === 'test' ? 'Test copy' : 'Running as your shell', tile: tile(icon('about')),
        help: v.mode === 'test' ? 'A test copy of Mantle: switches here show what they would do and change nothing on this PC' : 'Mantle starts when you sign in and replaces the Windows taskbar, Start and Settings' })));
    const gl = S.glass;
    out.push(groupT('Window', 'about-w'));
    out.push(card('about-w', row({ id: 'about.glass', tile: tile(icon('display')),
      label: !gl ? 'Solid window' : gl.ok === true ? 'Frosted glass window' : gl.ok === false ? 'Solid window (glass is off)' : 'Frosted glass: checking with Windows…',
      help: !gl ? 'This window was opened without the frosted glass look' : gl.ok === true ? 'The frosted glass shows while the window is active; Windows draws it solid while it is in the background' : null,
      why: gl && gl.ok === false ? gl.why || 'no reason came back' : null })));
    out.push(groupT('Runtime', 'about.runtime'));
    out.push(card('about-rt', h('div', { class: 'facts', 'data-k': 'rt', style: null },
      [['Electron', v.electron], ['Chromium', v.chrome], ['Node', v.node], ['Windows', v.windows]].map((f) => h('div', { 'data-k': f[0] }, h('div', { class: 'fk' }, f[0]), h('div', { class: 'fv' }, f[1] || 'Not reported'))))));
    out.push(groupT('Logs', 'about-l'));
    out.push(card('about-l',
      row({ id: 'about.logs', label: 'Log folder', tile: tile(icon('apps')), help: v.logDir || v.logFile || 'Not reported', mono: !!(v.logDir || v.logFile), title: v.logFile || null,
        ctl: btn('Open log folder', { 'data-act': 'logs' }) }),
      row({ id: 'about.windows', label: 'All Windows settings', tile: tile(icon('display')), help: 'The Windows Settings app, for anything Mantle does not cover',
        ctl: winBtn('Open', 'ms-settings:') })));
    return out.concat(moreCard('about'));
  };

  /* ---------------------------------------------------------------- search */
  function mark(label, q) {
    const i = String(label).toLowerCase().indexOf(String(q).trim().toLowerCase());
    if (!q.trim() || i < 0) return label;
    const n = q.trim().length;
    return [label.slice(0, i), h('mark', null, label.slice(i, i + n)), label.slice(i + n)];
  }
  function vSearch() {
    if (!S.index) rebuildIndex();
    if (!S.results) S.results = M.grouped(M.search(S.index, S.query));
    const R = S.results, q = S.query.trim();
    if (S.sel >= R.flat.length) S.sel = 0;
    const out = head('Results for “' + q + '”', sumParts([R.flat.length ? M.plural(R.flat.length, 'match', 'matches') + ' · arrow keys and Enter' : 'No matches']));
    const cat = slot('catalog'), mn = slot('mantle');
    const probs = [];
    if (cat.st === 'fail') probs.push('Windows Settings pages are not searched: ' + cat.reason);
    if (mn.st === 'fail') probs.push('Mantle\'s features and shortcuts are not searched: ' + mn.reason);
    if (probs.length) out.push(card('s-probs', probs.map((p, i) => h('div', { class: 'empty', 'data-k': 'p' + i }, why(p)))));
    if (!R.flat.length) {
      out.push(card('s-none', h('div', { class: 'noresults' }, h('div', { class: 'row-t' }, 'Nothing in Mantle Settings matches “' + q + '”.'),
        btn('Search Windows Settings', { 'data-act': 'win', 'data-uri': 'ms-settings:' }, 'acc'))));
      return out;
    }
    let idx = 0;
    function item(hh) {
      const e = hh.entry, i = idx++;
      const sec = M.SECTIONS.find((s) => s.id === e.section);
      const where = e.kind === 'catalog' ? (e.section ? 'Covered here: ' + (sec ? sec.label : e.section) : 'Opens Windows Settings')
        : e.kind === 'section' ? 'Section' : (sec ? sec.label : '') + (e.kind === 'option' ? ' › ' + e.sub : '');
      return h('button', { class: 'row clickable res-i', type: 'button', role: 'option', 'data-k': 'r:' + e.id, 'data-act': 'result', 'data-i': i, 'aria-selected': i === S.sel ? 'true' : 'false', id: 'res-' + i },
        tile(icon(e.kind === 'catalog' && !e.section ? 'arrow' : sec ? sec.id : 'mantle'), i === S.sel ? 'acc' : ''),
        h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, mark(e.label, q)), h('div', { class: 'row-h' }, e.kind === 'shortcut' ? e.sub + ' · keyboard shortcut' : where)),
        e.kind === 'catalog' && !e.section ? h('span', { class: 'kind' }, 'Windows Settings') : h('span', { class: 'arr' }, icon('chev', 14)));
    }
    if (R.mantle.length) { out.push(h('div', { class: 'res-g', 'data-k': 'g-m' }, 'In Mantle Settings')); out.push(card('s-m', R.mantle.map(item))); }
    if (R.windows.length) { out.push(h('div', { class: 'res-g', 'data-k': 'g-w' }, 'Windows Settings')); out.push(card('s-w', R.windows.map(item))); }
    return out;
  }
  function activate(hh) {
    const e = hh.entry;
    if (e.kind === 'catalog' && !e.section) { openWin(e.uri, null); return; }
    go(e.section, e.kind === 'section' || e.kind === 'page' ? null : e.row, e.page || null);
  }
  function onFind() {
    S.query = findEl.value;
    S.results = null; S.sel = 0;
    S.view = S.query.trim() ? 'search' : S.baseView;
    findEl.setAttribute('aria-expanded', S.view === 'search' ? 'true' : 'false');
    renderNow();
    scroller.scrollTop = 0;
  }
  function moveSel(d) {
    if (S.view !== 'search' || !S.results || !S.results.flat.length) return;
    S.sel = Math.max(0, Math.min(S.results.flat.length - 1, S.sel + d));
    renderNow();
    const el = $('res-' + S.sel);
    if (el) { el.scrollIntoView({ block: 'nearest' }); findEl.setAttribute('aria-activedescendant', el.id); }
  }

  /* ---------------------------------------------------------------- navigation */
  /* Anywhere: a built-in section, a module section / page, or a row (whose own place wins). The
     sidebar item is S.navId; S.section is the BUILT-IN whose data and loops apply (null while a
     module draws: its kit runs its own). */
  /* Back / forward (quality pass 2026-09-29; before it a search hit or a deep link left no way back but
     the sidebar). Like Windows 11 Settings: the arrow at the top left, Alt+Left / Alt+Right, and the
     mouse's back/forward buttons. One entry per place (section + page), with its scroll position. */
  const HIST_MAX = 50;
  function histHere() { return S.hi >= 0 ? S.hist[S.hi] : null; }
  function histPush(r) {
    const cur = histHere();
    if (cur && cur.section === r.section && cur.page === r.page) return;
    if (cur) cur.scroll = scroller.scrollTop;
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push({ section: r.section, page: r.page, scroll: 0 });
    if (S.hist.length > HIST_MAX) S.hist.shift();
    S.hi = S.hist.length - 1;
  }
  function histGo(step) {
    // Back from search results closes the search and returns to the page it was typed over
    if (step < 0 && S.view === 'search') { findEl.value = ''; onFind(); return true; }
    const to = S.hi + step;
    if (to < 0 || to >= S.hist.length) return false;
    const cur = histHere();
    if (cur) cur.scroll = scroller.scrollTop;
    S.hi = to;
    const e = S.hist[to];
    S.histMove = true;
    try { go(e.section, null, e.page); } finally { S.histMove = false; }
    const y = e.scroll || 0;
    // a module page draws after its render() resolves: put the scroll back once it has height
    let tries = 0;
    const put = () => { if (S.hist[S.hi] !== e) return; scroller.scrollTop = y; if (scroller.scrollTop < y - 2 && ++tries < 20) setTimeout(put, 50); };
    requestAnimationFrame(put);
    return true;
  }
  function go(section, rowId, page) {
    const r = M.resolve(S.model, { section, page, row: rowId });
    if (!S.histMove) histPush(r);
    const was = S.navId + '/' + S.page + '/' + S.view;
    S.navId = r.section; S.page = r.page; S.flash = null;
    S.crumb = r.page && r.view ? { section: r.section, label: (S.model.mods[r.section] || {}).label || r.section } : null;
    S.view = r.down ? 'down' : r.view ? r.view : S.model.pages[r.section] && !r.page ? 'overview' : 'mod';
    S.section = r.view || null;
    S.baseView = S.view;
    if (findEl.value) { findEl.value = ''; S.query = ''; S.results = null; findEl.setAttribute('aria-expanded', 'false'); }
    const p = ensure(S.section);
    if (was !== S.navId + '/' + S.page + '/' + S.view) scroller.scrollTop = 0;
    startLoops(S.section);
    renderNow();
    if (r.row) { S.flash = { row: r.row }; jumpTo(r.row, 0); }
    return p;
  }
  function jumpTo(id, tries) {
    renderNow();
    const el = pageEl.querySelector('[data-row="' + CSS.escape(id) + '"]');
    if (!el) {
      if (tries < 25) { setTimeout(() => { if (S.flash && S.flash.row === id) jumpTo(id, tries + 1); }, 100); return; }
      S.flash = null;
      note(null, 'warn', 'That setting is not on this page right now: Mantle did not report it');
      return;
    }
    el.scrollIntoView({ block: 'center' });
    // a module's rows are its own DOM (never re-rendered by this page): the highlight goes on directly
    if (S.view === 'mod') { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1700); }
    // a group title's own control (the Wi-Fi refresh), else the first control in the card under it
    const ctl = 'button:not(:disabled), input:not(:disabled), select:not(:disabled)';
    const scope = el.classList.contains('group-t') && !el.querySelector(ctl) ? el.nextElementSibling : el;
    const c = (scope && (scope.querySelector('.row-c button:not(:disabled), .row-c input:not(:disabled), .row-c select:not(:disabled)') ||
      scope.querySelector(ctl))) || (el.tagName === 'BUTTON' ? el : null);
    if (c) c.focus({ preventScroll: true });
    setTimeout(() => { if (S.flash && S.flash.row === id) { S.flash = null; schedule(); } }, 1700);
  }
  function nav(n) {
    n = n || {};
    if (n.query) { go(n.section || S.navId, null, n.page || null); findEl.value = String(n.query); onFind(); findEl.focus(); return Promise.resolve(); }
    // a row names its own section ('mantle.option.gamemode.auto' lives in Mantle), whatever section came with it
    return go(n.section || null, n.row || null, n.page || null);
  }

  /* ---------------------------------------------------------------- loops and watches */
  let loops = [];
  function stopLoops() { loops.forEach((f) => f()); loops = []; }
  function every(fn, ms) {
    const L = { dead: false, t: 0 };
    const tick = () => { if (!L.dead) L.t = setTimeout(() => { Promise.resolve().then(fn).catch(() => {}).then(tick); }, ms); };
    tick();
    loops.push(() => { L.dead = true; clearTimeout(L.t); });
  }
  function startLoops(sec) {
    stopLoops();
    if (document.hidden) return;
    every(() => qsWatch(true), 30000);             // re-assert: the bar's panel closing turns main's watch off
    if (S.problems.qswatch) every(() => read('qs'), 5000);
    if (sec === 'sound') { every(() => read('sessions'), 2000); every(() => read('audio'), 6000); }
    if (sec === 'network') every(() => read('wifi'), 4000);
    if (sec === 'home') every(() => read('audio'), 10000);
    if (sec === 'apps') every(() => read('features'), 10000);
    if (sec === 'about') every(() => schedule(), 1000);
    if (sec === 'bluetooth') btWatch();
  }
  function btWatch() {
    const L = { dead: false, t: 0, lastTry: 0 };
    const step = () => {
      if (L.dead) return;
      const tryWatch = !S.btWatchWhy || Date.now() - L.lastTry > 30000;
      const p = tryWatch ? (L.lastTry = Date.now(), call('qs.bt.watch', { on: true }).then((r) => {
        if (r && r.ok === false) throw new Error(r.reason || 'no reason came back');
        S.btWatchWhy = null;
      })).catch((e) => { S.btWatchWhy = msg(e); }) : Promise.resolve();
      p.then(() => {
        if (L.dead) return;
        if (S.btWatchWhy) read('bt');
        schedule();
        L.t = setTimeout(step, S.btWatchWhy ? 3000 : 30000);
      });
    };
    step();
    loops.push(() => { L.dead = true; clearTimeout(L.t); call('qs.bt.watch', { on: false }).catch(() => { /* its lease lapses by itself */ }); });
  }
  function qsWatch(want) {
    return call('qs.watch', { on: !!want, who: 'settings' }).then((r) => {
      if (want && r && r.ok === false) throw new Error(r.reason || 'no reason came back');
      if (want && S.problems.qswatch) { delete S.problems.qswatch; startLoops(S.section); }
    }).catch((e) => {
      if (!want) return;
      const had = !!S.problems.qswatch;
      S.problems.qswatch = 'Volume, brightness, Wi-Fi and Bluetooth do not update by themselves: qs.watch was refused (' + msg(e) + '), so this page re-reads them every 5 s';
      if (!had) startLoops(S.section);
      schedule();
    });
  }
  let awake = false;
  function wake() {
    if (awake || document.hidden) return;
    awake = true;
    qsWatch(true);
    startLoops(S.section);
    ensure(S.section);
  }
  function sleep() {
    if (!awake) return;
    awake = false;
    stopLoops();
    call('qs.watch', { on: false, who: 'settings' }).catch(() => { /* main's lease runs out by itself */ });
  }

  /* ---------------------------------------------------------------- render */
  /* LAG (lane settingsfx, measured on the mock): every live push (volume, net, qs every ~2 s...) rebuilt
     and diffed the WHOLE page, 6-20 ms of main thread each, even on a page that does not show that
     value. A push now names its data slot, and the page is rebuilt only if the view on screen reads it;
     otherwise only the sidebar and banner are looked at, and the sidebar only when its inputs moved. */
  const USES = {
    home: ['qs', 'net', 'battery', 'pm', 'mantle', 'audio'], display: ['qs', 'displays'], sound: ['qs', 'audio', 'sessions'],
    bluetooth: ['qs', 'bt'], network: ['qs', 'net', 'wifi'], power: ['pm', 'battery', 'gm', 'qs'], notifications: ['mantle', 'qs'],
    apps: ['startup', 'features', 'corners', 'mantle'], mantle: ['mantle', 'corners', 'features'], shortcuts: ['mantle'],
    about: ['about', 'catalog', 'mantle', 'qs'], search: ['mantle', 'catalog'], overview: [], down: [], mod: [],
  };
  let raf = 0, pageDirty = false;
  function schedule(k) {
    if (!k || !USES[S.view] || USES[S.view].indexOf(k) >= 0) pageDirty = true;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pageDirty) renderNow(); else { renderNav(); renderBanner(); } });
  }
  let navKey = '';
  function renderNav() {
    const m = slot('mantle').v;
    const bad = m ? M.health(m.features).bad.length : 0;
    const key = [S.modelSeq, S.navId, S.view === 'search', bad].join('|');
    if (key === navKey) return;
    navKey = key;
    const tmp = h('div', { id: 'nav', class: 'nav', role: 'list' });
    let group = undefined;
    S.model.nav.forEach((s) => {
      if (s.group !== group) { group = s.group; if (group) add(tmp, h('div', { class: 'nav-g', 'data-k': 'g-' + group }, group === 'windows' ? 'Windows' : 'Mantle')); }
      const cur = S.view !== 'search' && S.navId === s.id;
      const dot = s.down ? h('span', { class: 'ndot', title: 'Could not be loaded: ' + M.plain(s.down) }) : s.id === 'mantle' && bad ? h('span', { class: 'ndot', title: bad + ' not healthy' }) : null;
      add(tmp, h('button', { class: 'nav-i', type: 'button', role: 'listitem', 'data-k': s.id, 'data-act': 'nav', 'data-section': s.id, 'aria-current': cur ? 'page' : null, title: s.down ? s.label + ' could not be loaded: ' + M.plain(s.down) : null },
        iconAny(s.icon || s.id), h('span', null, s.label), dot));
    });
    morph(navEl, tmp);
  }
  function renderBanner() {
    const lines = Object.keys(S.problems).map((k) => S.problems[k]);
    const kids = lines.map((l, i) => h('div', { 'data-k': 'p' + i }, icon('warn', 14), h('span', null, M.plain(l))));
    if (S.toast) kids.push(h('div', { 'data-k': 'toast', class: S.toast.tone === 'info' ? 'info' : '' }, S.toast.text, ' ', h('button', { class: 'btn quiet', type: 'button', 'data-act': 'dismiss' }, 'Dismiss')));
    const tmp = h('div', { id: 'banner', class: 'banner', role: 'alert' }, kids);
    if (!kids.length) tmp.setAttribute('hidden', '');
    morph(bannerEl, tmp);
  }
  function renderNow() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pageDirty = false;
    renderNav();
    renderBanner();
    const vk = S.view === 'search' ? 'search' : S.view + ':' + modKey();
    if (vk !== S.lastView) { if (S.view !== 'mod' || S.mod) { unmount(); pageEl.replaceChildren(); } scroller.scrollTop = 0; S.lastView = vk; kept.clear(); }
    if (S.view === 'mod') mount();          // a module page owns its DOM: never morphed from here
    else {
      const tmp = h('div', { id: 'page', class: 'page' });
      add(tmp, S.view === 'search' ? vSearch() : (V[S.view] || V.home)());
      morph(pageEl, tmp);
    }
    document.body.classList.toggle('maxed', S.maxed);
    const bb = $('backbtn');
    if (bb) bb.disabled = !(S.hi > 0 || S.view === 'search');
    const ab = slot('about').v;
    $('testchip').hidden = !(S.test || (ab && ab.mode === 'test'));
  }

  /* ---------------------------------------------------------------- input */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    const f = ACT[t.dataset.act];
    if (f) { e.preventDefault(); f(t, e); }
  });
  pageEl.addEventListener('input', (e) => { const t = e.target, f = t.dataset && INPUT[t.dataset.input]; if (f) f(t); });
  pageEl.addEventListener('change', (e) => { const t = e.target, f = t.dataset && CHANGE[t.dataset.change]; if (f) f(t); });
  pageEl.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') S.pointerEl = e.target; });
  const release = () => { if (S.pointerEl) { S.pointerEl = null; schedule(); } };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  pageEl.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t.dataset && t.dataset.enter) {
      e.preventDefault();
      const b = t.closest('[data-row]').querySelector('[data-act="' + t.dataset.enter + '"]');
      if (b) b.click();
    } else if (e.key === 'Escape' && t.type === 'password') {
      e.preventDefault(); t.value = ''; S.expand = null; schedule();
    } else if (e.key === 'Enter' && t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'text')) {
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  findEl.addEventListener('input', onFind);
  findEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (S.view === 'search' && S.results && S.results.flat[S.sel]) activate(S.results.flat[S.sel]); else if (S.view === 'search') openWin('ms-settings:', null); }
    else if (e.key === 'Escape') { e.preventDefault(); if (findEl.value) { findEl.value = ''; onFind(); } }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findEl.focus(); findEl.select(); return; }
    // back / forward: Alt+Left / Alt+Right (as in Windows Settings and every browser), the keyboard's own keys
    if ((e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') || e.key === 'BrowserBack') { e.preventDefault(); histGo(-1); return; }
    if ((e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') || e.key === 'BrowserForward') { e.preventDefault(); histGo(1); return; }
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
    if (e.key === 'Escape' && !typing && findEl.value) { e.preventDefault(); findEl.value = ''; onFind(); return; }
    // just typing finds: a printable key with no modifier, outside any field, goes to the search box
    if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && e.key !== ' ') findEl.focus();
  });
  // the mouse's back / forward buttons (buttons 3 and 4)
  document.addEventListener('mouseup', (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); histGo(e.button === 3 ? -1 : 1); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) sleep(); else wake(); });
  window.addEventListener('focus', () => { if (!document.hidden) { ensure(S.section); modUpdate(); if (S.view === 'search') { read('mantle'); read('catalog'); } } });
  window.addEventListener('pagehide', sleep);
  window.addEventListener('resize', () => {
    const mx = window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight;
    if (mx !== S.maxed) { S.maxed = mx; schedule(); }
  });

  /* ---------------------------------------------------------------- events from main */
  on('qs', (d) => { qsTake(d); schedule('qs'); });
  on('volume', (v) => {
    if (!v || typeof v !== 'object' || qsHeld('volume')) return;
    const q = slot('qs').v;
    if (!q) return;
    q.volume = v.ok !== false && typeof v.level === 'number' ? { ok: true, level: v.level, muted: !!v.muted, reason: null }
      : { ok: false, level: null, muted: false, reason: v.reason || 'the volume could not be read, and no reason came back' };
    schedule('qs');
  });
  on('net', (r) => { take('net', r); schedule('net'); });
  on('battery', (r) => { take('battery', r); schedule('battery'); });
  on('btdevices', (r) => { if (r && typeof r === 'object' && Array.isArray(r.devices)) { take('bt', r); schedule('bt'); } });
  on('powermode', (r) => { take('pm', r); schedule('pm'); });
  on('gamemode.state', (r) => { take('gm', r); schedule('gm'); });
  on('corners.state', (r) => { take('corners', r); schedule('corners'); });
  on('settings.changed', () => { read('mantle'); if (S.section === 'apps') read('features'); if (S.section === 'mantle') read('corners'); modUpdate(); });
  on('settings.nav', (n) => { nav(n); });
  on('settings.glass', glassTake);

  /* ---------------------------------------------------------------- start */
  function boot() {
    if (!mantle) S.problems.bridge = cap(NO_BRIDGE) + '.';
    renderNow();
    const first = call('settings.hello').then((r) => {
      if (!r || typeof r !== 'object') r = { ok: false, reason: 'it answered with nothing' };
      if (r.ok === false) S.problems.hello = 'Mantle did not say which page to open (' + (r.reason || 'no reason came back') + '), so this is Home.';
      S.test = !!r.test;
      if (r.glass) glassTake(r.glass);
      return r;
    }, (e) => {
      if (mantle) S.problems.hello = 'Mantle did not say which page to open (' + msg(e) + '), so this is Home.';
      return {};
    });
    // The section modules (SECTIONS.md): listed by main, loaded here, in before the first nav so a
    // deep link into a module lands.
    const mods = call('settings.sections').then((r) => {
      if (!r || typeof r !== 'object') r = { ok: false, reason: 'Mantle gave no list of sections', sections: [] };
      if (r.ok === false) S.problems.sections = 'Some Settings sections may be missing: ' + (r.reason || 'no reason came back');
      return SS.load(r.sections, M);
    }, (e) => {
      if (mantle) S.problems.sections = 'The Settings sections beyond the built-in ones could not be listed (' + msg(e) + ')';
      return [];
    }).then((list) => { S.model = M.sectionModel(list); S.modelSeq++; S.modsReady = true; rebuildIndex(); });
    const booted = Promise.all([first, mods]).then(([r]) => {
      awake = !document.hidden;
      if (awake) qsWatch(true);
      const extra = [read('catalog'), slot('mantle').st === 'idle' ? read('mantle') : null];
      return Promise.all([nav({ section: r.section, page: r.page, row: r.row, query: r.query })].concat(extra));
    });
    booted.catch(() => {}).then(() => {
      renderNow();
      requestAnimationFrame(() => requestAnimationFrame(() => { document.documentElement.dataset.ready = '1'; }));
    });
  }
  boot();
}());
