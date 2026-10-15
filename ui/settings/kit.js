/* kit.js — Mantle Settings' section modules, the page half (lane settingsfx, 2026-09-28). The contract
 * is ui/settings/SECTIONS.md; the pure rules (shape check, sidebar, deep links, search) are model.js.
 *
 * WHY MODULES: Owen wants Mantle Settings to replace Windows Settings completely, and the categories
 * (System, Bluetooth & devices, Network & internet, ...) are built by parallel lanes that must never
 * edit this page. So each category is ONE file, ui/settings/sections/<id>.js, that calls
 * MantleSettings.section({...}) while it loads; main lists the files (settings.sections), this file
 * loads them, and settings.js draws them with the kit below.
 *
 * THE KIT is the only way a module draws: the same rows, switches, chips and reason lines as the
 * built-in sections, in the ONE theme (glass-light --lg-*), so every category looks identical. Each
 * control patches only itself (no page-wide rebuild) and shows its own reason under it when it
 * cannot act (No Silent Failures). Everything a module starts through the kit (watches, loops) is
 * stopped on dispose.
 *
 * Browser globals: MantleSettings (for modules), SettingsSections (for settings.js).
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- registry */
  const defs = Object.create(null);       // id -> the registered definition
  const errs = Object.create(null);       // id -> why it did not register
  window.MantleSettings = Object.freeze({
    /** A module file calls this once, while it loads. */
    section(def) {
      const s = document.currentScript, id = s && s.dataset ? s.dataset.section : null;
      if (!id) throw new Error('MantleSettings.section() must be called while a sections/<id>.js file loads, not later');
      if (defs[id]) { errs[id] = 'it called MantleSettings.section() twice'; return; }
      defs[id] = def;
    },
  });

  /** Load every listed file; resolves (never rejects) with [{ def } | { id, title, group, down }]
   *  for model.sectionModel. `list` = settings.sections' sections. */
  function load(list, M) {
    const items = Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string') : [];
    // A module that throws while it loads: matched by the running script (file:// can hide the
    // filename), and named with the error's own words when the page is allowed to see them.
    const onErr = (e) => {
      const cs = document.currentScript, f = String(e.filename || '');
      const hit = cs && cs.dataset && cs.dataset.section ? items.find((x) => x.id === cs.dataset.section) : items.find((x) => x.file && f.endsWith('/' + x.file));
      if (!hit || errs[hit.id]) return;
      const m = e.error && e.error.message ? e.error.message : e.message;
      errs[hit.id] = 'it threw while loading' + (m && !/^Script error\.?$/i.test(m) ? ': ' + m : ' (the error itself is only in the DevTools console)');
    };
    window.addEventListener('error', onErr);
    const one = (x) => new Promise((resolve) => {
      if (x.down || !x.file) { errs[x.id] = x.down || 'main gave no file for it'; resolve(); return; }
      const el = document.createElement('script');
      el.src = x.file;
      el.dataset.section = x.id;
      el.onload = () => resolve();
      el.onerror = () => { errs[x.id] = errs[x.id] || x.file + ' could not be read'; resolve(); };
      document.head.appendChild(el);
    });
    return Promise.all(items.map(one)).then(() => {
      window.removeEventListener('error', onErr);
      return items.map((x) => {
        let why = errs[x.id] || null;
        const def = defs[x.id];
        if (!why && !def) why = 'it loaded but never called MantleSettings.section({...})';
        if (!why) why = M.checkSection(def, x.id);
        if (!why && x.main && x.main.ok === false) why = x.main.reason || 'its main half is down';
        if (why) return { id: x.id, title: def && typeof def.title === 'string' ? def.title : x.id, group: def && def.group, down: why };
        return def;
      });
    });
  }
  function get(id) { return defs[id] || null; }
  function page(id, pageId) {
    const d = defs[id];
    return d && Array.isArray(d.pages) ? d.pages.find((p) => p.id === pageId) || null : null;
  }

  /* ---------------------------------------------------------------- the kit
     deps (from settings.js): { h, add, icon, why, call, on(ev, fn) -> off, test() -> bool,
     go(section, row, page), highlight(row) } */
  function create(deps, where) {
    const { h, icon, why } = deps;
    const offs = [];
    let dead = false;
    const msg = (e) => (e && e.message) || String(e || 'no reason came back');
    // an empty list's line is often a failure's reason: the same plain words as every "why" line
    const plainOf = (s) => (s && window.SettingsModel && window.SettingsModel.plain ? window.SettingsModel.plain(s) : s);
    const el = (x) => (x && x.el instanceof Node ? x.el : x);
    const kids = (list) => list.map((x) => (Array.isArray(x) ? kids(x) : el(x)));
    const iconOf = (name, size) => (typeof name === 'string' && name.trim().charAt(0) === '<' ? deps.svg(name, size) : icon(name, size));

    function admin() { return h('span', { class: 'admin', title: 'Needs administrator rights' }, icon('shield', 11), 'Admin'); }

    /* One row: [tile] label (+Admin) / help / reason lines | control. Every handle has
       { el, set(patch), value } and set() patches this row only. */
    function base(o, ctl, kind) {
      const r = { o: Object.assign({}, o), busy: false, note: null, value: o.value };
      r.t = h('div', { class: 'row-t' });
      r.hp = h('div', { class: 'row-h' + (o.mono ? ' mono' : '') });
      r.ws = h('div', { class: 'row-w' });
      r.c = ctl ? h('div', { class: 'row-c' }, ctl) : null;
      r.el = h('div', { class: 'row k-' + kind, 'data-row': o.row || null },
        o.icon ? h('div', { class: 'tile' }, iconOf(o.icon)) : null, h('div', { class: 'row-l' }, r.t, r.hp, r.ws), r.c);
      r.text = () => {
        r.t.replaceChildren(r.o.label || '', r.o.admin ? admin() : '');
        r.hp.textContent = r.o.help || '';
        r.hp.hidden = !r.o.help;
        const lines = [];
        if (r.o.reason) lines.push(why(r.o.reason));
        if (r.note) lines.push(why(r.note.text, r.note.tone === 'info'));
        else if (r.busy && r.o.admin) lines.push(why('Waiting for the administrator prompt…', true));
        // sidecar/ELEVATE.md: say it next to the shield, BEFORE the click
        else if (typeof r.o.admin === 'string' && r.o.admin) lines.push(why('Windows will ask for administrator permission to ' + r.o.admin + '.', true));
        if (r.o.info) lines.push(why(r.o.info, true));
        r.ws.replaceChildren(...lines);
      };
      return r;
    }
    function handle(r, paint) {
      const H = {
        el: r.el,
        get value() { return r.value; },
        set(p) {
          if (!p || typeof p !== 'object') return H;
          for (const k in p) if (k !== 'value') r.o[k] = p[k];
          if ('value' in p && !r.held) r.value = p.value;
          r.text(); paint();
          return H;
        },
      };
      r.text(); paint();
      return H;
    }
    /* A change: shown at once, then the result has the last word. ok:false (or a throw) springs it
       back and writes the reason; { value } is the read-back; a dry run springs back with its note. */
    /* a declined administrator prompt (env.elevate's kind 'cancelled') is Owen's answer, not a failure:
       a neutral note on toggles AND list actions alike (lib/features/settings.test.js pins both) */
    const CANCELLED = 'You said no to the administrator prompt; nothing changed.';
    function act(r, paint, want, fn) {
      if (typeof fn !== 'function' || r.busy || dead) return;
      const was = r.value;
      r.busy = true; r.note = null; r.value = want; r.text(); paint();
      Promise.resolve().then(() => fn(want)).then((x) => x, (e) => ({ ok: false, reason: msg(e) })).then((x) => {
        if (dead) return;
        r.busy = false;
        // springing back must reach the screen even in a text box that still has focus: paint() otherwise
        // never rewrites a focused box, which left a refused name on screen (PC rename, 2026-10-12)
        if (x && typeof x === 'object' && x.cancelled) { r.value = was; r.force = true; r.note = { tone: 'info', text: CANCELLED }; }
        else if (x && typeof x === 'object' && x.ok === false) { r.value = was; r.force = true; r.note = { tone: 'warn', text: x.reason || 'It did not take, and no reason came back' }; }
        else if (x && typeof x === 'object' && x.dryRun) { r.value = was; r.force = true; r.note = { tone: 'info', text: x.reason || 'Test run: nothing was changed' }; }
        else {
          if (x && typeof x === 'object' && 'value' in x) { r.value = x.value; r.force = true; }   // the read-back has the last word too
          if (x && typeof x === 'object' && typeof x.note === 'string' && x.note) r.note = { tone: 'info', text: x.note };
        }
        r.text(); paint(); r.force = false;
      });
    }

    const K = {
      get section() { return where.section; },
      get page() { return where.page; },
      get test() { return !!deps.test(); },
      get disposed() { return dead; },
      h, icon: iconOf, admin,
      reason: (text, o) => why(text, !!(o && o.info)),
      group(title, o) {
        o = o || {};
        return h('div', { class: 'group-t', 'data-row': o.row || null }, title, o.aside ? h('span', { class: 'aside' }, o.aside) : null);
      },
      card(...items) { return h('div', { class: 'card' }, kids(items)); },

      toggle(o) {
        const lab = h('span', { class: 'sw-l' }), b = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-label': o.label || null });
        const r = base(o, [lab, b], 'toggle');
        r.value = !!o.value;
        const paint = () => {
          lab.textContent = r.value ? 'On' : 'Off';
          b.setAttribute('aria-checked', r.value ? 'true' : 'false');
          b.classList.toggle('pending', r.busy);
          b.disabled = !!r.o.disabled;
        };
        b.addEventListener('click', () => { if (!r.o.disabled) act(r, paint, !r.value, r.o.onChange); });
        return handle(r, paint);
      },

      choice(o) {
        const opts = Array.isArray(o.options) ? o.options : [];
        const seg = o.style ? o.style === 'segmented' : opts.length <= 4 && opts.every((x) => String(x.label).length <= 14);
        const box = seg ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': o.label || null }) : h('select', { 'aria-label': o.label || null });
        // a dropdown sits in .selwrap like every other <select> in Settings: its ::after is the chevron
        const r = base(o, seg ? box : h('span', { class: 'selwrap' }, box), 'choice');
        const draw = () => {
          const list = Array.isArray(r.o.options) ? r.o.options : [];
          box.replaceChildren(...list.map((x) => (seg ? h('button', { type: 'button', role: 'radio', 'data-v': String(x.value) }, x.label) : h('option', { value: String(x.value) }, x.label))));
          r.drawn = r.o.options;
        };
        const paint = () => {
          if (r.drawn !== r.o.options) draw();
          const v = String(r.value);
          if (seg) box.querySelectorAll('button').forEach((x) => { x.setAttribute('aria-checked', x.dataset.v === v ? 'true' : 'false'); x.disabled = !!r.o.disabled || r.busy; });
          else { if (box.value !== v) box.value = v; box.disabled = !!r.o.disabled || r.busy; }
        };
        const pick = (raw) => { const x = (r.o.options || []).find((y) => String(y.value) === raw); if (x && x.value !== r.value) act(r, paint, x.value, r.o.onChange); };
        if (seg) box.addEventListener('click', (e) => { const x = e.target.closest('button[data-v]'); if (x && !x.disabled) pick(x.dataset.v); });
        else box.addEventListener('change', () => pick(box.value));
        return handle(r, paint);
      },

      slider(o) {
        const inp = h('input', { type: 'range', min: o.min == null ? 0 : o.min, max: o.max == null ? 100 : o.max, step: o.step == null ? 1 : o.step, 'aria-label': o.label || null });
        const out = h('span', { class: 'rng-v' });
        const r = base(o, [inp, out], 'slider');
        const fmt = (v) => (typeof r.o.format === 'function' ? r.o.format(v) : Math.round(v) + (r.o.unit == null ? '' : r.o.unit));
        const paint = () => { if (!r.held && +inp.value !== +r.value) inp.value = r.value; out.textContent = r.value == null ? '—' : fmt(+inp.value); inp.disabled = !!r.o.disabled; };
        let raf = 0;
        inp.addEventListener('pointerdown', () => { r.held = true; });
        const up = () => { r.held = false; };
        inp.addEventListener('pointerup', up); inp.addEventListener('pointercancel', up);
        inp.addEventListener('input', () => {
          out.textContent = fmt(+inp.value);
          if (typeof r.o.onInput === 'function' && !raf) raf = requestAnimationFrame(() => { raf = 0; try { r.o.onInput(+inp.value); } catch (_) { /* onChange reports */ } });
        });
        inp.addEventListener('change', () => { r.held = false; act(r, paint, +inp.value, r.o.onChange); });
        return handle(r, paint);
      },

      number(o) { return field(o, 'number'); },
      text(o) { return field(o, o.password ? 'password' : 'text'); },

      button(o) {
        const b = h('button', { class: 'btn' + (o.tone ? ' ' + o.tone : ''), type: 'button' });
        const r = base(o, b, 'button');
        const paint = () => { b.textContent = r.o.text || 'Go'; b.disabled = !!r.o.disabled || r.busy; };
        b.addEventListener('click', () => act(r, paint, r.value, r.o.onClick));
        return handle(r, paint);
      },

      folder(o) {
        const b = h('button', { class: 'btn', type: 'button' }, 'Choose…');
        const r = base(Object.assign({ mono: true }, o), b, 'folder');
        const paint = () => { r.hp.textContent = r.value || r.o.help || 'No folder chosen'; r.hp.hidden = false; b.disabled = !!r.o.disabled || r.busy; };
        b.addEventListener('click', () => {
          K.call('settings.pickPath', { title: r.o.label, defaultPath: r.value || undefined }).then((x) => {
            if (dead) return;
            if (!x.ok) { r.note = { tone: 'warn', text: x.reason || 'The folder dialog did not open' }; r.text(); paint(); return; }
            if (!x.cancelled && x.path) act(r, paint, x.path, r.o.onChange);
          });
        });
        return handle(r, paint);
      },

      status(o) {
        const v = h('span', { class: 'val' });
        const r = base(o, v, 'status');
        const paint = () => { v.replaceChildren(r.o.tone ? h('span', { class: 'pip ' + (r.o.tone === 'ok' ? 'ok' : r.o.tone === 'warn' ? 'warn' : '') }) : '', r.value == null ? '' : String(r.value)); };
        return handle(r, paint);
      },

      /* A list of items, each a row with its own actions: { row, items: [{ key, label, help, icon,
         mono, reason, value, actions: [{ id, text, tone, admin, disabled, reason }] }], empty,
         onAction(key, actionId, item) }. set({ items }) patches only the items that changed. */
      list(o) {
        const box = h('div', { class: 'klist', 'data-row': o.row || null });
        const L = { o: Object.assign({}, o), rows: new Map() };
        const itemRow = (it) => {
          const st = { busy: null, note: null };
          const acts = h('div', { class: 'row-c' });
          const ws = h('div', { class: 'row-w' });
          const row = h('div', { class: 'row k-item', 'data-row': o.row && it.key != null ? o.row + '.' + it.key : null },
            it.icon ? h('div', { class: 'tile' }, iconOf(it.icon)) : null,
            h('div', { class: 'row-l' }, h('div', { class: 'row-t' }, it.label || String(it.key), it.admin ? admin() : ''),
              it.help ? h('div', { class: 'row-h' + (it.mono ? ' mono' : '') }, it.help) : null, ws), acts);
          const paint = () => {
            const lines = [];
            if (it.reason) lines.push(why(it.reason));
            if (st.note) lines.push(why(st.note.text, st.note.tone === 'info'));
            ws.replaceChildren(...lines);
            acts.replaceChildren(it.value != null ? h('span', { class: 'val' }, String(it.value)) : '', ...(Array.isArray(it.actions) ? it.actions : []).map((a) => {
              const b = h('button', { class: 'btn' + (a.tone ? ' ' + a.tone : ''), type: 'button', title: a.reason || null }, a.text || a.id, a.admin ? icon('shield', 11) : null);
              b.disabled = !!a.disabled || !!st.busy;
              b.addEventListener('click', () => {
                if (typeof L.o.onAction !== 'function' || st.busy) return;
                st.busy = a.id; st.note = null; paint();
                Promise.resolve().then(() => L.o.onAction(it.key, a.id, it)).then((x) => x, (e) => ({ ok: false, reason: msg(e) })).then((x) => {
                  if (dead) return;
                  st.busy = null;
                  if (x && typeof x === 'object' && x.cancelled) st.note = { tone: 'info', text: CANCELLED };
                  else if (x && x.ok === false) st.note = { tone: 'warn', text: x.reason || 'It did not take, and no reason came back' };
                  else if (x && x.dryRun) st.note = { tone: 'info', text: x.reason || 'Test run: nothing was changed' };
                  paint();
                });
              });
              return b;
            }));
          };
          paint();
          return { el: row, sig: JSON.stringify(it) };
        };
        const draw = () => {
          const items = Array.isArray(L.o.items) ? L.o.items : [];
          const next = new Map(), els = [];
          items.forEach((it, i) => {
            const key = it && it.key != null ? String(it.key) : '#' + i, sig = JSON.stringify(it);
            const old = L.rows.get(key);
            const x = old && old.sig === sig ? old : itemRow(it || {});
            next.set(key, x); els.push(x.el);
          });
          if (!items.length) els.push(h('div', { class: 'row k-empty' }, h('div', { class: 'row-l' }, h('div', { class: 'row-h' }, plainOf(L.o.empty) || 'Nothing here'))));
          L.rows = next;
          box.replaceChildren(...els);
        };
        draw();
        return { el: box, get value() { return L.o.items; }, set(p) { if (p && typeof p === 'object') { Object.assign(L.o, p); draw(); } return this; } };
      },

      /** Always resolves: the command's own answer, or { ok:false, reason } (never a throw). */
      call(cmd, args) {
        return Promise.resolve().then(() => deps.call(cmd, args)).then(
          (x) => (x && typeof x === 'object' ? x : { ok: false, reason: 'Windows gave no answer. Try again in a moment' }),
          (e) => ({ ok: false, reason: msg(e) }));
      },
      /** mantle.on(event, fn) until dispose. -> off() */
      watch(event, fn) {
        const off = deps.on(event, (p) => { if (!dead) fn(p); });
        offs.push(off);
        return off;
      },
      /** fn() every ms while the window is visible (skipped while hidden), until dispose. -> stop() */
      every(ms, fn) {
        const L = { t: 0, stop: false };
        const tick = () => {
          if (L.stop || dead) return;
          L.t = setTimeout(() => { Promise.resolve().then(() => (document.hidden ? null : fn())).catch(() => {}).then(tick); }, Math.max(250, ms | 0));
        };
        tick();
        const stop = () => { L.stop = true; clearTimeout(L.t); };
        offs.push(stop);
        return stop;
      },
      open(n) { deps.go(n && n.section, n && n.row, n && n.page); },
      openWindows(uri) { return K.call('settings.openWindows', { uri }); },
      highlight(row) { deps.highlight(row); },
    };
    function field(o, type) {
      const inp = h('input', { class: 'inp' + (type === 'number' ? ' num' : ''), type, min: o.min, max: o.max, step: o.step, placeholder: o.placeholder || null, spellcheck: 'false', 'aria-label': o.label || null });
      const r = base(o, [inp, o.unit ? h('span', { class: 'val' }, o.unit) : null], type === 'number' ? 'number' : 'text');
      const paint = () => { if ((r.force || document.activeElement !== inp) && inp.value !== String(r.value == null ? '' : r.value)) inp.value = r.value == null ? '' : r.value; inp.disabled = !!r.o.disabled || r.busy; };
      inp.addEventListener('change', () => { act(r, paint, type === 'number' ? (inp.value === '' ? null : +inp.value) : inp.value, r.o.onChange); });
      return handle(r, paint);
    }
    K.dispose = () => { if (dead) return; dead = true; offs.splice(0).forEach((f) => { try { f(); } catch (_) { /* gone */ } }); };
    return Object.freeze(K);
  }

  window.SettingsSections = Object.freeze({ load, get, page, create });
}());
