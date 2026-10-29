/* taskmgr.js - the task manager's SHELL (lib/features/taskmgr.js draws nothing itself).
 *
 * The stock Windows 11 Task Manager in Mantle's skin (the user, 2026-10-28: "the functionality should be
 * exactly the same"; contract mantle-wt/TM-SPEC.md). This file owns everything the pages share:
 *   - the title bar (search, window buttons), the nav rail (hamburger, auto-collapse when narrow),
 *     each page's title + command bar ("Run new task" first on every page);
 *   - the model: main pushes `taskmgr.model`; only the VISIBLE page renders it (hidden pages do no work,
 *     a hidden window does none either);
 *   - TM.table(): the one table every list page uses (keyed rows patched in place, sort, column chooser,
 *     column resize, groups, expandable children, heat shading, totals over the numeric headers, keys);
 *   - TM.menu (context menus with submenus, check and radio items), TM.dialog / TM.confirm (in-window
 *     modal dialogs), the Run new task and Create dump file dialogs, the shared row actions;
 *   - TM.run(): every command goes through it; it never throws, a failure comes back as {ok:false, reason}
 *     and a needsAdmin answer can offer "Set up administrator access" (TM.adminHtml).
 * A page is pages/<id>.js calling TM.page({...}); see the PAGE CONTRACT comment above TM.page below.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A call that never reached Mantle comes back from preload.js as a whole sentence ("Mantle did not answer.
  // Try again; ...") (lane truthlog): such a sentence is used whole, after the head.
  const WHOLE = /^(Mantle did not answer\.|This page asked Mantle for something)/;
  function failWords(head, e, tail) {
    const m = String((e && e.message) || e || 'no reason given');
    const t = tail && !/nothing was done/i.test(m) ? ` ${tail}` : '';
    if (!WHOLE.test(m)) return `${head} (${m}).${tail ? ` ${tail}` : ''}`;
    const cut = m.indexOf('. ') + 1 || m.length;
    const one = m.slice(0, cut);
    const lead = /^Mantle did not answer/.test(head) ? one : `${head}: ${one.replace(/^This /, 'this ')}`;
    return `${lead}${t}${m.slice(cut)}`;
  }

  /* ---------------------------------------------------------------- formatting (Windows' units) */
  const MB = 1048576, GB = 1073741824;
  // thousands by hand: toLocaleString (ICU) was the old page's top cost, ~37 ms a tick over ~200 rows
  const commas = (n) => { const s = String(n); const i = s.indexOf('.'); const a = i < 0 ? s : s.slice(0, i); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (i < 0 ? '' : s.slice(i)); };
  const ok = (x) => typeof x === 'number' && isFinite(x);
  const fmt = {
    commas,
    num: (n) => (ok(n) ? commas(Math.round(n)) : null),
    pct: (x) => (!ok(x) ? null : x <= 0 ? '0%' : x < 10 ? x.toFixed(1) + '%' : Math.round(x) + '%'),
    pct0: (x) => (ok(x) ? Math.round(x) + '%' : null),
    mb: (b) => (ok(b) && b >= 0 ? commas((b / MB).toFixed(1)) + ' MB' : null),
    mbi: (b) => (ok(b) && b >= 0 ? commas(Math.round(b / MB)) + ' MB' : null),
    gb: (b, d) => (ok(b) ? (b / GB).toFixed(d == null ? 1 : d) + ' GB' : null),
    kb: (b) => (ok(b) ? commas(Math.round(b / 1024)) + ' K' : null),
    // Windows' Disk column: MB/s, one decimal, "0 MB/s" at rest
    rate: (bps) => (!ok(bps) ? null : bps / MB < 0.05 ? '0 MB/s' : (bps / MB).toFixed(1) + ' MB/s'),
    // Windows' Network column: Mbps, one decimal, "0 Mbps" at rest
    mbps: (Bps) => (!ok(Bps) ? null : (Bps * 8) / 1e6 < 0.05 ? '0 Mbps' : ((Bps * 8) / 1e6).toFixed(1) + ' Mbps'),
    bytes: (b) => { if (!ok(b)) return null; const a = Math.abs(b); return a >= GB ? (b / GB).toFixed(1) + ' GB' : a >= MB ? (b / MB).toFixed(1) + ' MB' : a >= 1024 ? Math.round(b / 1024) + ' KB' : Math.round(b) + ' B'; },
    bps: (Bps) => { if (!ok(Bps)) return null; const b = Bps; return b >= GB ? (b / GB).toFixed(1) + ' GB/s' : b >= MB ? (b / MB).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s'; },
    bits: (bits) => { if (!ok(bits)) return null; return bits >= 1e9 ? (bits / 1e9).toFixed(1) + ' Gbps' : bits >= 1e6 ? (bits / 1e6).toFixed(1) + ' Mbps' : bits >= 1e3 ? Math.round(bits / 1e3) + ' Kbps' : Math.round(bits) + ' bps'; },
    // Windows' Up time: d:hh:mm:ss
    uptime: (s) => { if (!ok(s)) return null; s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, x = s % 60; const p = (n) => String(n).padStart(2, '0'); return `${d}:${p(h)}:${p(m)}:${p(x)}`; },
    // Windows' CPU time: h:mm:ss
    hms: (s) => { if (!ok(s)) return null; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; const p = (n) => String(n).padStart(2, '0'); return `${h}:${p(m)}:${p(x)}`; },
  };

  /* ---------------------------------------------------------------- glyphs (one 1.1-1.2 stroke family) */
  const svg = (d, w) => `<svg viewBox="0 0 16 16" width="${w || 16}" height="${w || 16}" aria-hidden="true">${d}</svg>`;
  const S = 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
  const ICON = {
    warn: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1.6 11 10.4H1z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6 5v2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="6" cy="9" r=".6" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    chev: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    down: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    check: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dot: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="2.4" fill="currentColor"/></svg>',
    dots: svg('<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>'),
    app: '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 6.5h13" stroke="currentColor" stroke-width="1.1"/></svg>',
    run: svg(`<rect x="2" y="2.5" width="12" height="11" rx="2" ${S}/><path d="M2 5.5h12M6 9.5h4M8 7.5v4" ${S}/>`),
    end: svg(`<circle cx="8" cy="8" r="5.6" ${S}/><path d="M4.1 11.9 11.9 4.1" ${S}/>`),
    leaf: svg(`<path d="M3 13c0-6 3.6-9.6 10-10-.4 6.4-4 10-10 10z" ${S}/><path d="M3 13 9 7" ${S}/>`),
    view: svg(`<circle cx="8" cy="8" r="2.2" ${S}/><path d="M1.6 8C3 5.2 5.3 3.8 8 3.8S13 5.2 14.4 8C13 10.8 10.7 12.2 8 12.2S3 10.8 1.6 8z" ${S}/>`),
    props: svg(`<rect x="2.5" y="2.5" width="11" height="11" rx="2" ${S}/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" ${S}/>`),
    play: svg(`<path d="M5 3.2v9.6L12.6 8z" ${S}/>`),
    stop: svg(`<rect x="4" y="4" width="8" height="8" rx="1.2" ${S}/>`),
    restart: svg(`<path d="M12.8 8A4.8 4.8 0 1 1 11.3 4.5" ${S}/><path d="M12.6 2.4v2.8H9.8" ${S}/>`),
    open: svg(`<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5" ${S}/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" ${S}/>`),
    enable: svg(`<circle cx="8" cy="8" r="5.6" ${S}/><path d="M5.4 8.2 7.2 10l3.4-3.8" ${S}/>`),
    disable: svg(`<circle cx="8" cy="8" r="5.6" ${S}/><path d="M4.1 11.9 11.9 4.1" ${S}/>`),
    user: svg(`<circle cx="8" cy="5.6" r="2.6" ${S}/><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" ${S}/>`),
    disconnect: svg(`<path d="M6.5 9.5 4.6 11.4a2 2 0 0 1-2.8-2.8L3.7 6.7M9.5 6.5l1.9-1.9a2 2 0 0 1 2.8 2.8l-1.9 1.9M2.5 2.5l11 11" ${S}/>`),
    tree: svg(`<rect x="2" y="2.5" width="5" height="3.5" rx="1" ${S}/><rect x="9" y="10" width="5" height="3.5" rx="1" ${S}/><path d="M4.5 6v5.75H9" ${S}/>`),
    pause: svg(`<path d="M6 4v8M10 4v8" ${S}/>`),
  };
  const na = (why) => `<span class="na" title="${esc(why || 'Not reported')}">—</span>`;
  const warnLine = (cls, text) => `<span class="${cls}">${ICON.warn}<span>${esc(text)}</span></span>`;

  /* ---------------------------------------------------------------- storage (this window only) */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('taskmgr.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('taskmgr.' + k, JSON.stringify(v)); } catch (_) { /* a private profile: not remembered */ } },
  };

  /* ---------------------------------------------------------------- pages and nav */
  const NAV = [
    { id: 'processes', label: 'Processes', icon: svg(`<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" ${S}/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" ${S}/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" ${S}/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2" ${S}/>`) },
    { id: 'performance', label: 'Performance', icon: svg(`<path d="M1.8 9h2.6l1.6-4.6 3 8 1.7-5.1 1 1.7h2.5" ${S}/>`) },
    { id: 'apphistory', label: 'App history', icon: svg(`<path d="M2.7 8a5.3 5.3 0 1 0 1.6-3.8" ${S}/><path d="M2.5 2.4v2.4h2.4M8 5.2V8l2 1.4" ${S}/>`) },
    { id: 'startup', label: 'Startup apps', icon: svg(`<path d="M2.6 11.5a5.6 5.6 0 1 1 10.8 0" ${S}/><path d="M8 10.2 10.6 6.4" ${S}/><circle cx="8" cy="10.4" r="1" fill="currentColor"/>`) },
    { id: 'users', label: 'Users', icon: svg(`<circle cx="6" cy="5.6" r="2.3" ${S}/><path d="M1.8 13c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6" ${S}/><path d="M10.3 3.6a2.2 2.2 0 0 1 0 4.1M12 9.6c1.2.5 2 1.6 2.3 3.4" ${S}/>`) },
    { id: 'details', label: 'Details', icon: svg(`<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" ${S}/><circle cx="3" cy="4.5" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="11.5" r=".9" fill="currentColor"/>`) },
    { id: 'services', label: 'Services', icon: svg(`<path d="M3 5.2h2.3a1.4 1.4 0 1 1 2.6 0h2.3v2.3a1.4 1.4 0 1 1 0 2.6v2.4H7.9a1.4 1.4 0 1 0-2.6 0H3z" ${S}/>`) },
    { id: 'game', label: 'Get ready to game', sep: true, icon: svg(`<path d="M5.2 4.6h5.6a3 3 0 0 1 2.9 3.8l-.6 2.4a1.5 1.5 0 0 1-2.6.6l-1-1.2H6.5l-1 1.2a1.5 1.5 0 0 1-2.6-.6l-.6-2.4a3 3 0 0 1 2.9-3.8z" ${S}/><path d="M5.2 6.6v2M4.2 7.6h2" ${S}/><circle cx="10.6" cy="7" r=".7" fill="currentColor"/><circle cx="11.2" cy="8.6" r=".7" fill="currentColor"/>`) },
    { id: 'settings', label: 'Settings', foot: true, icon: svg(`<circle cx="8" cy="8" r="2" ${S}/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" ${S}/><circle cx="8" cy="8" r="4.4" ${S}/>`) },
  ];
  const ORDER = NAV.map((n) => n.id);
  const VIEW_ALIAS = { apps: 'processes' };
  const normView = (v) => { v = VIEW_ALIAS[v] || v; return ORDER.includes(v) ? v : 'processes'; };

  const P = {
    m: null, view: 'processes', q: '', note: null, icons: new Map(), pages: new Map(), inited: new Set(),
    unsupported: new Set(), seenView: false, got: false, dirty: false, railPref: store.get('rail', 'open'), railOverlay: false,
  };

  /* PAGE CONTRACT. TM.page({
       id,                      one of ORDER
       title,                   the page header's title (default: its nav label)
       search: true|false,      whether the title bar's search filters this page (false = the box is disabled here)
       init(root),              once, the first time the page is shown: build into root (its <section>)
       show(arg), hide(),       on every switch to / away from it (arg: TM.goTo's second argument)
       render(m),               every model while it is visible, and after TM.refresh(); keep it cheap
       commands(m) -> [items],  its command bar AFTER "Run new task" (see cmdbar() for the item shape)
       extra(m) -> html,        optional words right of the title (e.g. Startup's "Last BIOS time")
       endTask(),               Alt+E (and Delete when its list has focus, via its table)
       focus(),                 Ctrl+Tab / page switch: put the focus on its list
     }) */
  function page(def) {
    if (!def || !ORDER.includes(def.id)) throw new Error(`TM.page: unknown page id "${def && def.id}"`);
    def.title = def.title || NAV.find((n) => n.id === def.id).label;
    P.pages.set(def.id, def);
    return def;
  }

  /* ---------------------------------------------------------------- the bridge */
  const call = (name, args) => (window.mantle ? window.mantle.call(name, args) : Promise.reject(new Error('This page is not connected to Mantle')));
  /* Every page command: 'taskmgr.<cmd>'. Never throws. A test Mantle (model.test) gets dryRun:true on top of
     whatever main does in test mode itself. */
  const CONFIRM_OK = { endPid: 'End process', act: 'End process', priority: 'Change priority', affinity: 'OK', efficiency: 'Turn on Efficiency mode', uacVirt: 'Change virtualization', dump: 'Create dump file', restartExplorer: 'Restart', service: 'OK' };
  async function run(cmd, args, opts) {
    const a = Object.assign({}, args || {});
    if (P.m && P.m.test && a.dryRun === undefined && !(opts && opts.noDry)) a.dryRun = true;
    try {
      const r = await call(cmd.includes('.') ? cmd : 'taskmgr.' + cmd, a);
      if (r && r.ok === false && !r.reason && !r.needsConfirm) r.reason = 'Mantle said no and gave no reason.';
      /* a write aimed at a system or critical process: main sends Windows' own warning words (needsConfirm + title +
         text [+ check: the box Windows makes you tick, button: its words]); the user answers Windows' dialog, then the
         same command goes again with confirmed:true. Cancel = { cancelled:true } (nothing to say). */
      if (r && r.ok === false && r.needsConfirm && (r.title || r.text) && !a.confirmed && !(opts && opts.noConfirm)) {
        const c = await confirm({ title: r.title, body: r.text, ok: r.button || CONFIRM_OK[cmd] || 'OK', check: r.check || null, width: 460 });
        if (!c.ok) return { ok: false, cancelled: true, reason: 'Cancelled.' };
        return run(cmd, Object.assign({}, args, { confirmed: true }), opts);
      }
      return r || { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      // main has no such command yet (the data lane has not landed it): said as that, not as a crash
      if (/no command|unknown command|not a command|no handler/i.test(msg)) return { ok: false, missing: true, reason: `This Mantle can't do that yet (no "${cmd}" command).` };
      return { ok: false, reason: failWords('Mantle did not answer', e, 'Nothing was done.') };
    }
  }
  /* The words + way out for a needsAdmin answer: the reason, and when the elevated helper is not set up,
     the one-click "Set up administrator access" (command elevatedSetup, one UAC prompt, once). The button
     carries data-tmact="elevated-setup"; the shell handles it wherever it is drawn. */
  function adminHtml(r) {
    const e = (P.m && P.m.elevated) || null;
    const why = (r && r.reason) || 'Windows needs administrator rights for this.';
    const can = !e || !e.installed || e.stale || e.running === false;
    const state = e && e.reason ? ` (${e.reason})` : '';
    return `<span class="adminwhy">${ICON.warn}<span>${esc(why)}${esc(can && e ? state : '')}</span></span>` +
      (can ? '<button type="button" class="btn sm" data-tmact="elevated-setup" title="One Windows prompt, once: Mantle then does admin tasks without asking again">Set up administrator access</button>' : '');
  }
  async function elevatedSetup() {
    const r = await run('elevatedSetup', {}, { noDry: false });
    note(r.ok ? (r.dryRun ? (r.reason || 'Test Mantle: administrator access was not set up.') : null) : `Administrator access was not set up: ${r.reason}`);
    refresh();
    return r;
  }

  /* The standard outcome on the window: a dry run says what it would have done, a refusal its reason (a
     needsAdmin one with the setup button), a cancelled confirm nothing, a plain success clears the line. */
  function say(r, head) {
    if (!r || r.cancelled) return r;
    if (r.ok === false) note(r.needsAdmin ? { admin: r, head } : head ? `${head}: ${r.reason}` : r.reason);
    else note(r.dryRun ? r.reason || 'Test Mantle: nothing was done.' : null);
    return r;
  }

  /* ---------------------------------------------------------------- notes (one line each, on the window) */
  function note(text) { P.note = text || null; renderNotes(); }
  function renderNotes() {
    const m = P.m || {};
    const look = m.look || {};
    const W = window.MantleWallBdrop;
    const wallWhy = W && W.state === 'off' && document.documentElement.dataset.theme === 'dark' ? `No wallpaper picture: ${W.reason || 'no reason came back'}; the window stays solid.` : null;
    const s = m.settings || {};
    const paused = s.updateSpeed === 'paused' || m.sampleMs === 0 ? 'Updates are paused (Settings > Real time update speed). F5 refreshes once.' : null;
    const notes = [P.note, look.iconWhy ? `This window's own icon: ${look.iconWhy}.` : null, look.lightWhy ? `Glass: ${look.lightWhy}; the window stays solid.` : null, wallWhy].filter(Boolean);
    const lines = notes.map((t) => (t && t.admin ? `<span class="nl adm">${t.head ? `<span>${esc(t.head)}:</span>` : ''}${adminHtml(t.admin)}</span>` : warnLine('nl', t)));
    if (paused) lines.push(`<span class="nl quiet">${ICON.pause}<span>${esc(paused)}</span></span>`);
    if (m.test) lines.push('<span class="nl quiet"><span>Test Mantle: every action only says what it would do.</span></span>');
    const el = $('note');
    el.hidden = !lines.length;
    setHtml(el, lines.join(''));
  }

  /* ---------------------------------------------------------------- tiny DOM helpers */
  const setText = (el, t) => { if (el._t !== t) { el.textContent = t; el._t = t; } };
  const setHtml = (el, h) => { if (el._h !== h) { el.innerHTML = h; el._h = h; } };

  /* ---------------------------------------------------------------- icons (main sends each picture once) */
  function iconHtml(ref, why) {
    const url = ref ? P.icons.get(ref) : null;
    return url ? `<img class="ic" src="${esc(url)}" alt="" decoding="async">` : `<span class="ic tile" title="${esc(why || 'No icon')}">${ICON.app}</span>`;
  }

  /* ================================================================ MENUS
     items: { label, act(), key, disabled, title, danger, checked (true|false = a check item), radio (with
     checked), sub: [items] | () => items, sep: true }. Opens at a point {x,y} or under an anchor element. */
  const menus = $('menus');
  const M = { stack: [], anchor: null, onClose: null };
  function itemsOf(x) { return (typeof x === 'function' ? x() : x) || []; }
  function menuOpen(items, at, opts) {
    menuClose(false);
    items = itemsOf(items).filter(Boolean);
    if (!items.length) return;
    M.anchor = (opts && opts.anchor) || (at && at.nodeType === 1 ? at : null);
    M.onClose = (opts && opts.onClose) || null;
    M.refocus = document.activeElement;
    if (M.anchor) M.anchor.setAttribute('aria-expanded', 'true');
    panel(items, at, 0);
  }
  function panel(items, at, depth, parentBtn) {
    while (M.stack.length > depth) { const p = M.stack.pop(); p.el.remove(); }
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    const hasCheck = items.some((it) => it && (it.checked !== undefined));
    el.innerHTML = items.map((it, i) => {
      if (it.sep) return '<div class="msep" role="separator"></div>';
      const sub = !!it.sub;
      const mark = it.checked === undefined ? '' : it.checked ? (it.radio ? ICON.dot : ICON.check) : '';
      return `<button type="button" role="${it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem'}" data-i="${i}" class="${it.danger ? 'danger' : ''}${sub ? ' hassub' : ''}"` +
        `${it.checked !== undefined ? ` aria-checked="${!!it.checked}"` : ''}${it.disabled ? ' disabled aria-disabled="true"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}${sub ? ' aria-haspopup="menu"' : ''}>` +
        (hasCheck ? `<i class="mk">${mark}</i>` : '') + `<span>${esc(it.label)}</span>` + (it.key ? `<kbd>${esc(it.key)}</kbd>` : '') + (sub ? `<i class="sa">${ICON.chev}</i>` : '') + '</button>';
    }).join('');
    menus.appendChild(el);
    const rec = { el, items, parentBtn };
    M.stack.push(rec);
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let x, y;
    if (parentBtn) { const r = parentBtn.getBoundingClientRect(); x = r.right - 2; y = r.top - 5; if (x + mw > innerWidth - 4) x = r.left - mw + 2; }
    else if (at && at.nodeType === 1) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 4; if (y + mh > innerHeight - 6) y = r.top - 4 - mh; }
    else { x = at.x; y = at.y; }
    if (x + mw > innerWidth - 6) x = innerWidth - 6 - mw;
    if (y + mh > innerHeight - 6) y = Math.max(6, innerHeight - 6 - mh);
    el.style.left = Math.max(6, x) + 'px';
    el.style.top = Math.max(6, y) + 'px';
    const first = el.querySelector('button:not([disabled])');
    if (first) first.focus();
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(rec, Number(b.dataset.i), b, false); });
    el.addEventListener('pointerover', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      b.focus({ preventScroll: true });
      const it = items[Number(b.dataset.i)];
      clearTimeout(M.hoverT);
      M.hoverT = setTimeout(() => {
        const at2 = M.stack.indexOf(rec);
        if (at2 < 0) return;
        if (it && it.sub && !b.disabled) { if (!M.stack[at2 + 1] || M.stack[at2 + 1].parentBtn !== b) panel(itemsOf(it.sub), null, at2 + 1, b); }
        else while (M.stack.length > at2 + 1) M.stack.pop().el.remove();
      }, 180);
    });
    el.addEventListener('keydown', (e) => menuKey(e, rec));
    return rec;
  }
  function pick(rec, i, b, byKey) {
    const it = rec.items[i];
    if (!it || it.disabled) return;
    const d = M.stack.indexOf(rec);
    if (it.sub) { panel(itemsOf(it.sub), null, d + 1, b); if (byKey) { const f = M.stack[d + 1] && M.stack[d + 1].el.querySelector('button:not([disabled])'); if (f) f.focus(); } return; }
    menuClose(true);
    if (typeof it.act === 'function') { try { it.act(); } catch (err) { note(`That did not work (${err.message}).`); } }
  }
  function menuKey(e, rec) {
    const bs = Array.from(rec.el.querySelectorAll('button:not([disabled])'));
    const i = bs.indexOf(document.activeElement);
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); if (bs.length) bs[(i + (k === 'ArrowDown' ? 1 : bs.length - 1) + (i < 0 && k === 'ArrowDown' ? 0 : 0)) % bs.length].focus(); }
    else if (k === 'Home' || k === 'End') { e.preventDefault(); if (bs.length) bs[k === 'Home' ? 0 : bs.length - 1].focus(); }
    else if (k === 'ArrowRight') { e.preventDefault(); const b = document.activeElement; if (b && b.classList.contains('hassub')) pick(rec, Number(b.dataset.i), b, true); }
    else if (k === 'ArrowLeft' || (k === 'Escape' && M.stack.length > 1)) {
      e.preventDefault(); e.stopPropagation();
      const d = M.stack.indexOf(rec);
      if (d > 0) { const pb = rec.parentBtn; while (M.stack.length > d) M.stack.pop().el.remove(); if (pb) pb.focus(); }
      else if (k === 'Escape') menuClose(true);
    } else if (k === 'Escape' || k === 'Tab') { e.preventDefault(); e.stopPropagation(); menuClose(true); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); const b = document.activeElement; if (b && b.dataset.i) pick(rec, Number(b.dataset.i), b, true); }
    else if (k.length === 1 && /\S/.test(k)) {
      // the first item starting with that letter (Windows menus' access by letter)
      const L = k.toLowerCase();
      const hit = bs.find((b, j) => j > i && b.textContent.trim().toLowerCase().startsWith(L)) || bs.find((b) => b.textContent.trim().toLowerCase().startsWith(L));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  }
  function menuClose(refocus) {
    if (!M.stack.length) return;
    clearTimeout(M.hoverT);
    while (M.stack.length) M.stack.pop().el.remove();
    if (M.anchor) M.anchor.setAttribute('aria-expanded', 'false');
    const back = refocus && (M.anchor && document.contains(M.anchor) ? M.anchor : M.refocus);
    const cb = M.onClose;
    M.anchor = null; M.onClose = null; M.refocus = null;
    if (back && back.focus && (!P.dlg || P.dlg.contains(back))) back.focus({ preventScroll: true });
    if (cb) cb();
  }
  const menuIsOpen = () => M.stack.length > 0;
  document.addEventListener('pointerdown', (e) => {
    if (!M.stack.length) return;
    if (M.stack.some((p) => p.el.contains(e.target))) return;
    if (M.anchor && M.anchor.contains(e.target)) return;
    menuClose(false);
  }, true);
  window.addEventListener('blur', () => menuClose(false));

  /* ================================================================ DIALOGS
     TM.dialog({ title, body (html), buttons: [{ id, label, primary, danger, disabled }], init(el, api),
       onButton(id, el) -> false keeps it open, width }) -> Promise<{ button, el }>. Esc / the X = 'cancel'.
     One at a time (a second replaces nothing: it waits its turn). Focus stays inside; it goes back after. */
  const dlgHost = $('dlg');
  let dlgQueue = Promise.resolve();
  function dialog(o) {
    const run1 = () => new Promise((resolve) => {
      const back = document.activeElement;
      menuClose(false);
      const btns = (o.buttons || [{ id: 'ok', label: 'OK', primary: true }]);
      dlgHost.innerHTML = `<div class="scrim"></div><div class="dlg${o.cls ? ' ' + o.cls : ''}" role="dialog" aria-modal="true" aria-labelledby="dlgt">` +
        `<div class="dhead"><h2 id="dlgt">${esc(o.title || '')}</h2><button type="button" class="dx" data-b="cancel" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.1"/></svg></button></div>` +
        `<div class="dbody">${o.body || ''}</div>` +
        `<div class="dfoot">${btns.map((b) => `<button type="button" class="btn${b.primary ? ' acc' : ''}${b.danger ? ' dng' : ''}" data-b="${esc(b.id)}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('')}</div></div>`;
      dlgHost.hidden = false;
      const el = dlgHost.querySelector('.dlg');
      if (o.width) el.style.width = Number(o.width) + 'px';   // CSSOM: the page's CSP blocks style attributes
      P.dlg = el;
      const api = {
        el,
        button: (id) => el.querySelector(`.dfoot [data-b="${CSS.escape(id)}"]`),
        close: (id) => done(id),
        setBody: (h) => { el.querySelector('.dbody').innerHTML = h; },
        setTitle: (t) => { el.querySelector('#dlgt').textContent = t; },
        setButtons: (list) => { el.querySelector('.dfoot').innerHTML = list.map((b) => `<button type="button" class="btn${b.primary ? ' acc' : ''}${b.danger ? ' dng' : ''}" data-b="${esc(b.id)}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join(''); },
      };
      let closed = false;
      async function done(id) {
        if (closed) return;
        if (o.onButton && id !== 'cancel') {
          let keep;
          try { keep = await o.onButton(id, el, api); } catch (err) { keep = false; }
          if (keep === false) return;
        }
        if (o.onButton && id === 'cancel' && o.onCancel) o.onCancel(el);
        closed = true;
        dlgHost.hidden = true;
        dlgHost.innerHTML = '';
        P.dlg = null;
        if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
        resolve({ button: id, el });
      }
      el.addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b && !b.disabled) done(b.dataset.b); });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!menuIsOpen()) done('cancel'); return; }
        if (e.key === 'Enter' && !e.target.closest('button, textarea, [data-noenter]')) {
          const p = btns.find((b) => b.primary);
          const pb = p && api.button(p.id);
          if (pb && !pb.disabled) { e.preventDefault(); done(p.id); }
        }
        if (e.key === 'Tab') {
          const f = Array.from(el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]')).filter((x) => x.offsetParent !== null);
          if (!f.length) return;
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      });
      if (o.init) o.init(el, api);
      const auto = el.querySelector('[autofocus]') || el.querySelector('.dbody input:not([disabled]), .dbody select') || (btns.find((b) => b.primary) && api.button(btns.find((b) => b.primary).id)) || el.querySelector('.dfoot button');
      if (auto && !el.contains(document.activeElement)) auto.focus();   // init may have chosen (a confirm focuses Cancel)
    });
    const p = dlgQueue.then(run1);
    dlgQueue = p.catch(() => {});
    return p;
  }
  /* Windows' confirm: a question, a reason, a danger button and Cancel (focused, so Enter cannot do harm).
     check: words of a checkbox the user must tick before the button works (Windows' "Abandon unsaved data
     and shut down."); dontAsk: words of an optional "don't ask again" box. -> {ok, checked} */
  async function confirm(o) {
    const body = `<p class="dq">${esc(o.body || '')}</p>` +
      (o.check ? `<label class="dchk"><input type="checkbox" data-c="req"><span>${esc(o.check)}</span></label>` : '') +
      (o.dontAsk ? `<label class="dchk"><input type="checkbox" data-c="dont"><span>${esc(o.dontAsk)}</span></label>` : '');
    let checked = false;
    const r = await dialog({
      title: o.title, body, cls: 'confirm', width: o.width || 440,
      buttons: [{ id: 'ok', label: o.ok || 'OK', danger: o.danger !== false, disabled: !!o.check }, { id: 'cancel', label: o.cancel || 'Cancel' }],
      init(el, api) {
        const req = el.querySelector('[data-c="req"]');
        if (req) req.addEventListener('change', () => { api.button('ok').disabled = !req.checked; });
        const dont = el.querySelector('[data-c="dont"]');
        if (dont) dont.addEventListener('change', () => { checked = dont.checked; });
        api.button('cancel').focus();
      },
    });
    return { ok: r.button === 'ok', checked };
  }

  /* ================================================================ RUN NEW TASK (every page's first command)
     Windows' "Create new task": Open [combo with history], Browse..., [ ] administrative privileges, OK/Cancel.
     History = this window's own list of what was run from here (newest first, 26 like Windows' RunMRU). */
  async function runTaskDialog() {
    const hist = store.get('runHistory', []);
    let last = null;
    await dialog({
      title: 'Create new task', width: 460, cls: 'runtask',
      body: `<div class="rt-top">${ICON.run}<p>Type the name of a program, folder, document, or Internet resource, and Windows will open it for you.</p></div>` +
        `<div class="rt-row"><label for="rt-cmd">Open:</label><div class="combo"><input id="rt-cmd" type="text" spellcheck="false" autocomplete="off" value="${esc(hist[0] || '')}" aria-label="Open" autofocus>` +
        `<button type="button" class="cbtn" id="rt-hist" aria-label="Recent" title="Recent"${hist.length ? '' : ' disabled'}>${ICON.down}</button></div></div>` +
        `<label class="dchk rt-admin"><input type="checkbox" id="rt-admin"><span>Create this task with administrative privileges.</span></label>` +
        '<div class="rt-why" id="rt-why" hidden></div>',
      buttons: [{ id: 'ok', label: 'OK', primary: true }, { id: 'cancel', label: 'Cancel' }, { id: 'browse', label: 'Browse...' }],
      init(el, api) {
        const inp = el.querySelector('#rt-cmd');
        inp.select();
        const okb = api.button('ok');
        const sync = () => { okb.disabled = !inp.value.trim(); };
        inp.addEventListener('input', sync); sync();
        el.querySelector('#rt-hist').addEventListener('click', (e) => {
          menuOpen(hist.map((h) => ({ label: h, act: () => { inp.value = h; sync(); inp.focus(); } })), e.currentTarget.closest('.combo'));
        });
        inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); el.querySelector('#rt-hist').click(); } });
      },
      async onButton(id, el) {
        const why = el.querySelector('#rt-why');
        const say = (h) => { why.innerHTML = h; why.hidden = !h; };
        const inp = el.querySelector('#rt-cmd');
        if (id === 'browse') {
          const r = await run('browse', { for: 'runTask' }, { noDry: true });
          if (r.ok && r.path) { inp.value = /\s/.test(r.path) ? `"${r.path}"` : r.path; inp.dispatchEvent(new Event('input')); inp.focus(); say(''); }
          else if (!r.ok) say(warnLine('bad', `Browse did not open: ${r.reason}`));
          return false;
        }
        const cmd = inp.value.trim();
        if (!cmd) return false;
        const admin = el.querySelector('#rt-admin').checked;
        api0.busy(el, true);
        const r = await run('runTask', { cmd, admin });
        api0.busy(el, false);
        last = r;
        if (!r.ok) { say(r.needsAdmin ? adminHtml(r) : warnLine('bad', `Windows cannot find '${cmd}', or it did not start: ${r.reason}`)); return false; }
        store.set('runHistory', [cmd].concat(hist.filter((h) => h.toLowerCase() !== cmd.toLowerCase())).slice(0, 26));
        if (r.dryRun) note(r.reason || `Test Mantle: "${cmd}" was not run.`);
        return true;
      },
    });
    return last;
  }
  const api0 = { busy(el, on) { el.querySelectorAll('.dfoot button').forEach((b) => { if (on) { b._d = b.disabled; b.disabled = true; } else b.disabled = !!b._d; }); el.classList.toggle('busy', on); } };

  /* ================================================================ SHARED ROW ACTIONS (Processes, Details, ...) */
  const act = {
    /* Windows' "Create memory dump file": a progress dialog, then where the file went + Open file location. */
    async dump(pid, name) {
      let res = null;
      await dialog({
        title: 'Dumping process', width: 440, cls: 'dump',
        body: `<p class="dq"><span class="spin" aria-hidden="true"></span>Dumping ${esc(name || 'the process')} (PID ${esc(pid)})...</p>`,
        buttons: [{ id: 'ok', label: 'OK', primary: true, disabled: true }],
        async init(el, a) {
          res = await run('dump', { pid });
          if (!document.contains(el)) return;
          if (res.ok && !res.dryRun) {
            a.setTitle('Dump process');
            a.setBody(`<p class="dq">The file has been created successfully.</p><p class="dpath" title="${esc(res.path)}">${esc(res.path || '')}</p>`);
            a.setButtons([{ id: 'loc', label: 'Open file location' }, { id: 'ok', label: 'OK', primary: true }]);
          } else {
            a.setTitle('Dump process');
            a.setBody(res.ok ? `<p class="dq">${esc(res.reason || 'Test Mantle: no dump file was written.')}</p>` : `<div class="dq">${res.needsAdmin ? adminHtml(res) : warnLine('bad', `The dump file was not created: ${res.reason}`)}</div>`);
            a.setButtons([{ id: 'ok', label: 'OK', primary: true }]);
          }
          const b = a.button('ok'); if (b) b.focus();
        },
        async onButton(id) { if (id === 'loc' && res && res.path) { const r = await act.openLocation(res.path); return r.ok ? true : false; } return true; },
      });
      return res;
    },
    async openLocation(path, key) {
      const r = key ? await run('reveal', { key }) : await run('openLocation', { path });
      note(r.ok ? (r.dryRun || r.reason ? r.reason || 'Test Mantle: the folder was not opened.' : null) : `The file location did not open: ${r.reason}`);
      return r;
    },
    async searchOnline(name) {
      const r = await run('searchOnline', { name });
      note(r.ok ? (r.dryRun ? r.reason || `Test Mantle: no browser was opened for "${name}".` : null) : `The search did not open: ${r.reason}`);
      return r;
    },
    async properties(path) {
      const r = await run('properties', { path });
      note(r.ok ? (r.dryRun ? r.reason || 'Test Mantle: Properties was not opened.' : null) : `Properties did not open: ${r.reason}`);
      return r;
    },
    /* Efficiency mode, with Windows' question first unless Settings > "Ask me before applying Efficiency mode"
       is off (or the box in the question was ticked). target: { pid } or { key }; name for the words. */
    async efficiency(target, on, name) {
      const s = (P.m && P.m.settings) || {};
      if (on && s.askBeforeEfficiency !== false) {
        const c = await confirm({ title: 'Turn on Efficiency mode?', body: `Efficiency mode lowers the priority of ${name || 'this process'} and improves power efficiency. This might cause instability for some processes.`, ok: 'Turn on Efficiency mode', danger: false, dontAsk: "Don't ask me again" });
        if (!c.ok) return { ok: false, cancelled: true };
        if (c.checked) run('setting', { key: 'askBeforeEfficiency', value: false }, { noDry: true });
      }
      return run('efficiency', Object.assign({}, target, { on: !!on }));
    },
    goToDetails(pid) { goTo('details', { pid }); },
    async windowsTaskManager() {
      const r = await run('windowsTaskManager', {});
      note(r.ok ? (r.dryRun ? r.reason : null) : r.reason);
      return r;
    },
  };

  /* ================================================================ THE TABLE
     TM.table(host, o): one list page's table. Builds .tbl (head + state + list) into host.
     o = {
       id,                      storage key: its columns, widths and sort are remembered per table
       cols: [{ id, label, title, num, w, min, flex, def (shown by default), fixed (cannot be hidden),
                get(r) (sort value; default r[id]), text(r) (cell words; null/undefined = an em dash),
                why(r) (the em dash's reason), html(r) (cell html, rebuilt only when it changes),
                heat(r) -> 0..5, total() -> { v, title, hi } (the number over the header), menu (header
                menu group label, e.g. 'Resource values') }],
       sort: { by, dir },       default sort (dir 1 = A-Z / small first, -1 = big first)
       key(r), children(r) (array while expanded, null = loading), count(r) (children it can show; > 0 = chevron),
       onExpand(r, open), sub(r) -> html under the row (its outcome, a question), cls(r) -> classes,
       onAct(act, r, btn, e) (a [data-act] button in a row or its sub line), onEnter(r), onDbl(r),
       onDelete(r, e), menu(r) -> items (right-click, the menu key, Shift+F10), onSelect(r),
       headMenu() -> extra items for the header's right-click, selectDialog: true (adds "Select columns...")
       label: the list's aria-label, empty: words when nothing at all, emptyQ(q): words when a search hides all
     }
     t.render({ groups: [{ id, title, rows }] } | { rows }) patches the DOM; t.state(html|null) shows a state
     (loading / could not read) instead of the list; t.sel / t.select(key) / t.selected(); t.expandAll() /
     t.collapseAll(); t.visible() (its shown column ids); t.setVisible(ids); t.focus(). */
  function table(host, o) {
    const saved = store.get('tbl.' + o.id, {}) || {};
    const byId = new Map(o.cols.map((c) => [c.id, c]));
    const t = {
      o, el: null, sel: null, open: new Set(), order: [], rows: new Map(), hover: false, ta: { s: '', at: 0 },
      vis: Array.isArray(saved.vis) && saved.vis.length ? saved.vis.filter((id) => byId.has(id)) : o.cols.filter((c) => c.def !== false).map((c) => c.id),
      w: saved.w && typeof saved.w === 'object' ? saved.w : {},
      sort: saved.sort && byId.has(saved.sort.by) && (saved.sort.dir === 1 || saved.sort.dir === -1) ? saved.sort : (o.sort || { by: o.cols[0].id, dir: 1 }),
      sortOff: false, last: null,
    };
    o.cols.forEach((c) => { if (c.fixed && !t.vis.includes(c.id)) t.vis.unshift(c.id); });
    const root = document.createElement('div');
    root.className = 'tbl';
    root.innerHTML = '<div class="thead" role="row"><div class="tin"></div></div><div class="tstate" hidden></div>' +
      `<div class="tlist" tabindex="0" role="grid" aria-label="${esc(o.label || '')}"><div class="tin"></div></div>`;
    host.appendChild(root);
    t.el = root;
    const head = root.firstChild, headIn = head.firstChild, stateEl = root.children[1], list = root.children[2], listIn = list.firstChild;
    t.list = list;
    list.addEventListener('scroll', () => { if (head.scrollLeft !== list.scrollLeft) head.scrollLeft = list.scrollLeft; }, { passive: true });
    const save = () => store.set('tbl.' + o.id, { vis: t.vis, w: t.w, sort: t.sort });
    const cols = () => t.vis.map((id) => byId.get(id)).filter(Boolean);

    function template() {
      let min = 0;
      const parts = cols().map((c) => {
        const w = t.w[c.id];
        if (w) { min += w; return w + 'px'; }
        if (c.flex) { const mn = c.min || 160; min += mn; return `minmax(${mn}px, 1fr)`; }
        const ww = c.w || 90; min += ww; return ww + 'px';
      });
      return { tpl: parts.join(' '), min };
    }
    function layout() {
      const { tpl, min } = template();
      root.style.setProperty('--cols', tpl);
      root.style.setProperty('--minw', min + 'px');
      head.classList.toggle('totals', cols().some((c) => c.total));
      t.headSig = null;
    }
    function renderHead() {
      const parts = cols().map((c) => {
        const on = t.sort.by === c.id && !t.sortOff;
        const tot = c.total ? c.total() : null;
        const arrow = on ? `<i class="sarrow">${t.sort.dir === 1 ? '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1.5 5.5 4 3l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</i>` : '';
        const tv = tot ? `<span class="tv${tot.hi ? ' hi' : ''}"${tot.title ? ` title="${esc(tot.title)}"` : ''}>${tot.v == null ? '—' : esc(tot.v)}</span>` : '';
        return `<button type="button" class="h${c.num ? ' num' : ''}${on ? ' on' : ''}" data-col="${esc(c.id)}" role="columnheader" aria-sort="${on ? (t.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}" title="${esc(c.title || c.label)}">` +
          `${tv}<span class="hl">${arrow}<span>${esc(c.label)}</span></span><span class="rz" data-rz="${esc(c.id)}" aria-hidden="true"></span></button>`;
      });
      const h = parts.join('');
      if (t.headSig !== h) { headIn.innerHTML = h; t.headSig = h; }
    }
    function cmp(a, b) {
      const c = byId.get(t.sort.by);
      if (!c) return 0;
      const ga = c.get ? c.get(a) : a[c.id], gb = c.get ? c.get(b) : b[c.id];
      let d;
      if (ga == null && gb == null) d = 0; else if (ga == null) return 1; else if (gb == null) return -1;
      else if (typeof ga === 'number' && typeof gb === 'number') d = ga - gb;
      else { const x = String(ga).toLowerCase(), y = String(gb).toLowerCase(); d = x < y ? -1 : x > y ? 1 : 0; }
      return d * t.sort.dir || (o.key(a) < o.key(b) ? -1 : 1);
    }
    function ordered(rows, prevPos) {
      let out = t.sortOff ? rows.slice() : rows.slice().sort(cmp);
      // while the pointer is over the list (or a menu is open), rows keep their places: a row never
      // slides out from under the cursor between hover and click. New rows go after them.
      if (prevPos && (t.hover || menuIsOpen())) out = out.map((r, i) => [r, prevPos.has(o.key(r)) ? prevPos.get(o.key(r)) : 1e9 + i]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
      return out;
    }
    function flatten(data) {
      const prev = t.prevPos;
      const items = [];
      const pushRows = (rows, depth, pk) => {
        for (const r of ordered(rows, prev)) {
          const k = (pk ? pk + '>' : '') + o.key(r);
          items.push({ k, r, depth, pk });
          const n = o.count ? o.count(r) : 0;
          if (n > 0 && t.open.has(k)) {
            const ch = o.children ? o.children(r) : null;
            if (ch && ch.length) pushRows(ch, depth + 1, k);
            else if (!ch) items.push({ k: k + '>~', loading: true, depth: depth + 1 });
          }
        }
      };
      if (data.groups) for (const g of data.groups) { if (!g.rows.length && !g.keep) continue; items.push({ k: 'g:' + g.id, group: g }); pushRows(g.rows, 0, null); }
      else pushRows(data.rows || [], 0, null);
      return items;
    }
    function rowEl(it) {
      const el = document.createElement('div');
      el.dataset.key = it.k;
      return el;
    }
    function buildGroup(el, g) {
      const h = `<span class="gt">${esc(g.title)} (${g.rows.length})</span>${g.extra || ''}`;
      if (el._s !== h) { el.innerHTML = h; el._s = h; el.className = 'tgroup'; el.setAttribute('role', 'row'); }
    }
    function buildRow(el, it, cs, sig) {
      const r = it.r;
      if (it.loading) { if (el._s !== 'loading') { el.className = 'trow child loading'; el.innerHTML = `<div class="tr"><span class="c name"><span class="ind d${Math.min(it.depth, 4)}"></span><span class="nochev"></span><span class="spin" aria-hidden="true"></span>Loading...</span></div>`; el._s = 'loading'; } return; }
      if (el._sig !== sig) {
        el.innerHTML = '<div class="tr" role="row">' + cs.map((c) => `<span class="c${c.num ? ' num' : ''}${c.flex ? ' name' : ''}" role="gridcell"></span>`).join('') + '</div><div class="tsub"></div>';
        el._sig = sig; el._cells = Array.from(el.firstChild.children); el._sub = el.lastChild;
        el._sub._h = undefined;
      }
      const n = o.count ? o.count(r) : 0;
      const open = t.open.has(it.k);
      const cls = 'trow' + (it.depth ? ' child' : '') + (t.sel === it.k ? ' sel' : '') + (n > 0 ? ' exp' : '') + (open ? ' open' : '') + (o.cls ? ' ' + (o.cls(r, it) || '') : '');
      if (el.className !== cls) { el.className = cls; el.setAttribute('aria-selected', String(t.sel === it.k)); }
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], cell = el._cells[i];
        if (c.flex || c.html) {
          let h = c.html ? c.html(r, it) : esc(c.text ? c.text(r) : r[c.id]);
          if (c.flex) h = `<span class="ind d${Math.min(it.depth, 4)}"></span>` + (n > 0 ? `<button type="button" class="chev" data-act="expand" tabindex="-1" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'}" title="${open ? 'Collapse' : 'Expand'} (Enter)">${ICON.chev}</button>` : '<span class="nochev"></span>') + h;
          if (cell._h !== h) { cell.innerHTML = h; cell._h = h; }
        } else {
          let v = c.text ? c.text(r) : r[c.id];
          let why = null;
          if (v == null) { why = (r.why && r.why[c.whyKey || c.id]) || (c.why ? c.why(r) : 'Not reported'); v = '—'; }
          v = String(v);
          if (cell._t !== v) { cell.textContent = v; cell._t = v; }
          if (cell._w !== why) { if (why) cell.title = why; else cell.removeAttribute('title'); cell._w = why; cell.classList.toggle('nil', !!why); }
        }
        if (c.heat) {
          const lv = c.heat(r) | 0;
          if (cell._lv !== lv) { if (cell._lv) cell.classList.remove('h' + cell._lv); if (lv) cell.classList.add('h' + lv); cell._lv = lv; }
        }
      }
      const sub = o.sub ? o.sub(r, it) || '' : '';
      if (el._sub._h !== sub) { el._sub.innerHTML = sub; el._sub._h = sub; el._sub.hidden = !sub; }
    }
    t.render = function (data) {
      if (!data) data = t.last || { rows: [] };
      t.last = data;
      renderHead();
      const items = flatten(data);
      const cs = cols();
      const sig = t.vis.join(',');
      const have = new Map();
      for (const e of listIn.children) if (e.dataset.key) have.set(e.dataset.key, e);
      let prev = null;
      t.order = [];
      t.rows.clear();
      const pos = new Map();
      for (const it of items) {
        let el = have.get(it.k);
        if (el) have.delete(it.k); else el = rowEl(it);
        if (it.group) buildGroup(el, it.group);
        else { buildRow(el, it, cs, sig); if (!it.loading) { t.order.push(it.k); t.rows.set(it.k, it); } }
        if (it.r && !it.depth) pos.set(o.key(it.r), pos.size);
        else if (it.r) pos.set(o.key(it.r), pos.size);
        const want = prev ? prev.nextSibling : listIn.firstChild;
        if (want !== el) listIn.insertBefore(el, want);
        prev = el;
      }
      for (const el of have.values()) el.remove();
      t.prevPos = pos;
      if (t.sel && !t.rows.has(t.sel)) t.sel = null;
      return items;
    };
    t.state = function (html) { if (stateEl._h !== (html || '')) { stateEl.innerHTML = html || ''; stateEl._h = html || ''; } stateEl.hidden = !html; };
    t.selected = () => (t.sel && t.rows.get(t.sel) ? t.rows.get(t.sel).r : null);
    t.selectedItem = () => (t.sel ? t.rows.get(t.sel) || null : null);
    t.select = function (k, scroll) {
      t.sel = k;
      t.render();
      const it = k && t.rows.get(k);
      if (o.onSelect) o.onSelect(it ? it.r : null, it);
      refreshCmd();
      if (scroll && k) { const el = listIn.querySelector(`[data-key="${CSS.escape(k)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
    };
    t.findKey = (pred) => { for (const [k, it] of t.rows) if (pred(it.r, it)) return k; return null; };
    t.focus = () => list.focus({ preventScroll: true });
    t.toggle = function (k, open) {
      const it = t.rows.get(k);
      if (!it || !(o.count && o.count(it.r) > 0)) return;
      const want = open === undefined ? !t.open.has(k) : open;
      if (want === t.open.has(k)) return;
      if (want) t.open.add(k); else t.open.delete(k);
      if (o.onExpand) o.onExpand(it.r, want, it);
      t.render();
    };
    t.expandAll = () => { for (const [k, it] of t.rows) if (!it.depth && o.count && o.count(it.r) > 0 && !t.open.has(k)) { t.open.add(k); if (o.onExpand) o.onExpand(it.r, true, it); } t.render(); };
    t.collapseAll = () => { for (const k of Array.from(t.open)) { const it = t.rows.get(k); t.open.delete(k); if (it && o.onExpand) o.onExpand(it.r, false, it); } t.render(); };
    t.visible = () => t.vis.slice();
    t.setVisible = (ids) => { const v = o.cols.filter((c) => c.fixed || ids.includes(c.id)).map((c) => c.id); t.vis = v; save(); layout(); t.render(); };
    t.toggleCol = (id) => { const c = byId.get(id); if (!c || c.fixed) return; const on = t.vis.includes(id); t.setVisible(on ? t.vis.filter((x) => x !== id) : t.vis.concat(id).sort((a, b) => o.cols.findIndex((c2) => c2.id === a) - o.cols.findIndex((c2) => c2.id === b))); };
    t.sortBy = (id) => {
      const c = byId.get(id);
      if (!c) return;
      t.sort = t.sort.by === id && !t.sortOff ? { by: id, dir: -t.sort.dir } : { by: id, dir: c.num ? -1 : 1 };
      t.sortOff = false;
      save(); t.render();
    };
    t.relayout = layout;
    layout();

    /* --- header: sort on click, resize by the right edge, right-click = the column chooser --- */
    head.addEventListener('click', (e) => { if (e.target.closest('.rz') || t.justResized) return; const b = e.target.closest('[data-col]'); if (b) t.sortBy(b.dataset.col); });
    head.addEventListener('pointerdown', (e) => {
      const rz = e.target.closest('.rz');
      if (!rz || e.button !== 0) return;
      e.preventDefault();
      const id = rz.dataset.rz, cell = rz.parentElement, x0 = e.clientX, w0 = cell.getBoundingClientRect().width;
      const c = byId.get(id);
      rz.setPointerCapture(e.pointerId);
      const mv = (ev) => { t.w[id] = Math.max(c && c.num ? 48 : 70, Math.round(w0 + ev.clientX - x0)); layout(); };
      const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); save(); t.justResized = true; setTimeout(() => { t.justResized = false; }, 0); };
      rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
    });
    head.addEventListener('dblclick', (e) => { const rz = e.target.closest('.rz'); if (rz) { delete t.w[rz.dataset.rz]; save(); layout(); } });
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); menuOpen(headItems(), { x: e.clientX, y: e.clientY }); });
    function headItems() {
      const plain = o.cols.filter((c) => !c.menu);
      const items = plain.map((c) => ({ label: c.label, checked: t.vis.includes(c.id), disabled: !!c.fixed, act: () => t.toggleCol(c.id) }));
      const groups = new Map();
      for (const c of o.cols.filter((x) => x.menu)) { if (!groups.has(c.menu)) groups.set(c.menu, []); groups.get(c.menu).push(c); }
      for (const [g, cs] of groups) items.push({ label: g, sub: cs.map((c) => ({ label: c.label, checked: t.vis.includes(c.id), act: () => t.toggleCol(c.id) })) });
      const extra = o.headMenu ? o.headMenu() : [];
      if (extra.length) items.push({ sep: true }, ...extra);
      if (o.selectDialog) items.push({ sep: true }, { label: 'Select columns', act: () => selectColumns() });
      return items;
    }
    async function selectColumns() {
      const body = '<p class="dq">Select the columns that will appear in the table.</p><div class="colpick" role="group">' +
        o.cols.map((c) => `<label class="dchk"><input type="checkbox" data-col="${esc(c.id)}"${t.vis.includes(c.id) ? ' checked' : ''}${c.fixed ? ' disabled' : ''}><span>${esc(c.title || c.label)}</span></label>`).join('') + '</div>';
      const r = await dialog({ title: 'Select columns', body, width: 420, cls: 'selcols', buttons: [{ id: 'ok', label: 'OK', primary: true }, { id: 'cancel', label: 'Cancel' }] });
      if (r.button !== 'ok') return;
      t.setVisible(Array.from(r.el.querySelectorAll('[data-col]:checked')).map((i) => i.dataset.col));
    }
    t.selectColumns = selectColumns;
    t.headItems = headItems;

    /* --- rows: choose, expand, act, menu --- */
    list.addEventListener('pointerenter', () => { t.hover = true; });
    list.addEventListener('pointerleave', () => { t.hover = false; if (t.last) t.render(); });
    list.addEventListener('click', (e) => {
      const rowEl2 = e.target.closest('.trow[data-key]');
      if (!rowEl2 || rowEl2.classList.contains('loading')) return;
      const k = rowEl2.dataset.key, it = t.rows.get(k);
      const b = e.target.closest('[data-act]');
      if (t.sel !== k) t.select(k);
      if (b && it) { if (b.dataset.act === 'expand') t.toggle(k); else if (o.onAct) o.onAct(b.dataset.act, it.r, b, e, it); }
      if (!b || b.dataset.act === 'expand') t.focus();
    });
    list.addEventListener('dblclick', (e) => {
      const rowEl2 = e.target.closest('.trow[data-key]');
      if (!rowEl2 || e.target.closest('button')) return;
      const it = t.rows.get(rowEl2.dataset.key);
      if (!it) return;
      if (o.onDbl) o.onDbl(it.r, it); else t.toggle(it.k);
    });
    list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rowEl2 = e.target.closest('.trow[data-key]');
      if (!rowEl2) return;
      const it = t.rows.get(rowEl2.dataset.key);
      if (!it) return;
      if (t.sel !== it.k) t.select(it.k);
      if (o.menu) menuOpen(o.menu(it.r, it), { x: e.clientX, y: e.clientY });
    });
    list.addEventListener('keydown', (e) => {
      if (e.target !== list || menuIsOpen() || P.dlg) return;
      const k = e.key;
      const i = t.order.indexOf(t.sel);
      const it = t.sel ? t.rows.get(t.sel) : null;
      const move = (to) => { e.preventDefault(); if (t.order.length) t.select(t.order[Math.max(0, Math.min(t.order.length - 1, to))], true); };
      if (o.onKey && o.onKey(e, it ? it.r : null, it)) return;
      const page2 = Math.max(1, Math.floor(list.clientHeight / 32) - 1);
      if (k === 'ArrowDown') move(i < 0 ? 0 : i + 1);
      else if (k === 'ArrowUp') move(i < 0 ? 0 : i - 1);
      else if (k === 'Home') move(0);
      else if (k === 'End') move(t.order.length - 1);
      else if (k === 'PageDown' || k === 'PageUp') move((i < 0 ? 0 : i) + (k === 'PageDown' ? page2 : -page2));
      else if (!it) return;
      else if (k === 'ArrowRight') { e.preventDefault(); if (o.count && o.count(it.r) > 0 && !t.open.has(it.k)) t.toggle(it.k, true); else if (t.open.has(it.k)) move(i + 1); }
      else if (k === 'ArrowLeft') { e.preventDefault(); if (t.open.has(it.k)) t.toggle(it.k, false); else if (it.pk) t.select(it.pk, true); }
      else if (k === 'Enter') { e.preventDefault(); if (o.onEnter) o.onEnter(it.r, it); else t.toggle(it.k); }
      else if (k === 'Delete') { e.preventDefault(); if (o.onDelete) o.onDelete(it.r, e, it); }
      else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const el = listIn.querySelector(`[data-key="${CSS.escape(it.k)}"] .tr`);
        if (el && o.menu) { const r = el.getBoundingClientRect(); menuOpen(o.menu(it.r, it), { x: r.left + 40, y: r.bottom }); }
      } else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && k !== ' ') {
        // type-ahead, like any Windows list: the next row whose name starts with what was typed
        e.preventDefault();
        const now = Date.now();
        t.ta.s = now - t.ta.at > 900 ? k.toLowerCase() : t.ta.s + k.toLowerCase();
        t.ta.at = now;
        const nameCol = o.cols.find((c) => c.flex) || o.cols[0];
        const nm = (x) => String(nameCol.get ? nameCol.get(x.r) : x.r[nameCol.id] || '').toLowerCase();
        const start = t.ta.s.length === 1 ? i + 1 : Math.max(0, i);
        const keys = t.order.slice(start).concat(t.order.slice(0, start));
        const hit = keys.find((kk) => nm(t.rows.get(kk)).startsWith(t.ta.s));
        if (hit) t.select(hit, true);
      }
    });
    return t;
  }

  /* ================================================================ THE SHELL: rail, title, command bar */
  function buildRail() {
    const main = NAV.filter((n) => !n.foot), foot = NAV.filter((n) => n.foot);
    const b = (n) => `${n.sep ? '<div class="navsep" role="separator"></div>' : ''}<button type="button" class="nav" role="tab" data-view="${n.id}" title="${esc(n.label)}" aria-label="${esc(n.label)}">${n.icon}<span>${esc(n.label)}</span></button>`;
    $('navs').innerHTML = main.map(b).join('');
    $('navfoot').innerHTML = foot.map(b).join('');
  }
  function railState() {
    const narrow = innerWidth < 900;
    const app = $('app');
    const st = narrow ? (P.railOverlay ? 'overlay' : 'closed') : P.railPref;
    if (app.dataset.rail !== st) app.dataset.rail = st;
    $('ham').setAttribute('aria-expanded', String(st !== 'closed'));
    const lbl = st === 'closed' ? 'Open navigation' : 'Close navigation';
    $('ham').title = lbl; $('ham').setAttribute('aria-label', lbl);
  }
  $('ham').addEventListener('click', () => {
    if (innerWidth < 900) P.railOverlay = !P.railOverlay;
    else { P.railPref = P.railPref === 'open' ? 'closed' : 'open'; store.set('rail', P.railPref); }
    railState();
  });
  window.addEventListener('resize', () => { if (innerWidth >= 900) P.railOverlay = false; railState(); menuClose(false); });
  document.addEventListener('pointerdown', (e) => { if (P.railOverlay && !$('rail').contains(e.target)) { P.railOverlay = false; railState(); } }, true);

  /* The command bar: "Run new task" + the page's items. item = { id, label, icon, act(btn), disabled, title,
     key (shortcut words for the tooltip), menu: items|() => items (a dropdown, drawn with a chevron),
     checked (a toggle), primary, more: true (only in the "..." overflow, like Windows' See more) }.
     Drawn again only when its words or states change. */
  let cmdItems = [];
  function cmdbar() {
    const pg = P.pages.get(P.view);
    const own = pg && pg.commands ? (pg.commands(P.m || {}) || []).filter(Boolean) : [];
    const items = [{ id: 'run', label: 'Run new task', icon: ICON.run, act: () => runTaskDialog(), title: 'Run new task' }].concat(own.length ? [{ sep: true }] : [], own);
    cmdItems = items;
    const main = items.filter((it) => !it.more), more = items.filter((it) => it.more);
    const btn = (it, i) => {
      if (it.sep) return '<span class="csep" role="separator"></span>';
      const tip = (it.title || it.label) + (it.key ? ` (${it.key})` : '');
      return `<button type="button" class="cbtn${it.primary ? ' primary' : ''}${it.checked ? ' on' : ''}" data-ci="${i}"${it.disabled ? ' disabled' : ''} title="${esc(tip)}" aria-label="${esc(it.label)}"` +
        `${it.menu ? ' aria-haspopup="menu" aria-expanded="false"' : ''}${it.checked !== undefined ? ` aria-pressed="${!!it.checked}"` : ''}>${it.icon || ''}<span class="cl">${esc(it.label)}</span>${it.menu ? `<i class="cdd">${ICON.down}</i>` : ''}</button>`;
    };
    let h = main.map((it) => btn(it, items.indexOf(it))).join('');
    if (more.length) h += `<button type="button" class="cbtn more" data-more="1" aria-haspopup="menu" aria-expanded="false" aria-label="See more" title="See more">${ICON.dots}</button>`;
    setHtml($('cmdbar'), h);
  }
  function refreshCmd() { cmdbar(); }
  $('cmdbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.more) {
      if (menuIsOpen() && M.anchor === b) { menuClose(false); return; }
      menuOpen(cmdItems.filter((it) => it.more && !it.sep).map((it) => ({ label: it.label, act: it.menu ? undefined : () => it.act(b), sub: it.menu || undefined, disabled: it.disabled, checked: it.checked, title: it.title, key: it.key })), b, { anchor: b });
      return;
    }
    const it = cmdItems[Number(b.dataset.ci)];
    if (!it) return;
    if (it.menu) { if (menuIsOpen() && M.anchor === b) menuClose(false); else menuOpen(it.menu, b, { anchor: b }); return; }
    if (it.act) it.act(b);
  });

  /* ---- switching pages ---- */
  function show(id, arg) {
    id = normView(id);
    const pg = P.pages.get(id);
    menuClose(false);
    if (P.view !== id) { const old = P.pages.get(P.view); if (old && old.hide && P.inited.has(P.view)) old.hide(); }
    P.view = id;
    for (const s of document.querySelectorAll('.page')) s.hidden = s.dataset.page !== id;
    for (const b of document.querySelectorAll('.nav')) { const on = b.dataset.view === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    $('app').dataset.view = id;
    setText($('ptitle'), pg ? pg.title : NAV.find((n) => n.id === id).label);
    const searchable = !pg || pg.search !== false;
    $('q').disabled = !searchable;
    $('search').classList.toggle('off', !searchable);
    $('search').title = searchable ? 'Search (Ctrl+F)' : 'Search works on the list pages';
    if (pg && !P.inited.has(id)) { P.inited.add(id); try { pg.init($('pg-' + id)); } catch (e) { note(`The ${pg.title} page did not build (${e.message}).`); } }
    if (pg && pg.show) pg.show(arg);
    if (P.railOverlay) { P.railOverlay = false; railState(); }
    render();
  }
  async function setView(id, arg) {
    id = normView(id);
    const same = id === P.view;
    show(id, arg);
    if (same) return;
    store.set('lastView', id);
    const r = await run('view', { view: id }, { noDry: true });
    // main answered with another page: that Mantle cannot read this page's data yet (said by the page)
    if (r && r.ok !== false && r.view && normView(r.view) !== id && P.view === id) { P.unsupported.add(id); render(); }
    else if (r && r.ok === false && P.view === id) { P.unsupported.add(id); P.unsupportedWhy = r.reason; render(); }
  }
  function goTo(id, arg) { setView(id, arg); }
  /* A page's data in the model: 'ok' | 'error' | 'loading' | 'unsupported' (main does not send it yet) */
  function dataState(key, view) {
    const m = P.m || {};
    const d = m[key];
    if (d && d.loading) return 'loading';
    if (d && d.error && !(d.rows && d.rows.length)) return 'error';
    if (d) return 'ok';
    if (P.unsupported.has(view || P.view)) return 'unsupported';
    return 'loading';
  }
  /* The list's own states, drawn the same on every page */
  function stateHtml(kind, words, buttons) {
    if (kind === 'loading') return `<div class="lsx"><span class="spin" aria-hidden="true"></span><span>${esc(words || 'Reading...')}</span></div>`;
    if (kind === 'unsupported') return `<div class="lsx bad">${ICON.warn}<span>${esc(words || "This Mantle doesn't read this page yet: its helper needs updating.")}</span>${buttons || '<button type="button" class="btn sm" data-tmact="wintm">Open Windows Task Manager</button>'}</div>`;
    if (kind === 'error') return `<div class="lsx bad">${ICON.warn}<span>${esc(words || 'Mantle could not read this list.')}</span>${buttons || ''}</div>`;
    if (kind === 'empty') return `<div class="lsx"><span>${esc(words || 'Nothing to show.')}</span>${buttons || ''}</div>`;
    if (kind === 'noq') return `<div class="lsx"><span>No results for “${esc(P.q.trim())}”.</span><button type="button" class="btn sm" data-tmact="clearq">Clear search</button></div>`;
    return '';
  }

  /* ---- search: the title bar's box filters the current page (name, publisher or PID) ---- */
  const q = $('q');
  function setQuery(v) {
    P.q = v;
    if (q.value !== v) q.value = v;
    $('qx').hidden = !v;
    render();
  }
  q.addEventListener('input', () => setQuery(q.value));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q.value) setQuery(''); else focusPage(); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); focusPage(true); }
  });
  $('qx').addEventListener('click', () => { setQuery(''); q.focus(); });
  /* the words a row matches on: TM.match(row fields...) */
  function match(...fields) {
    const s = P.q.trim().toLowerCase();
    if (!s) return true;
    for (const f of fields) if (f != null && String(f).toLowerCase().includes(s)) return true;
    return false;
  }
  function focusPage(first) {
    const pg = P.pages.get(P.view);
    if (pg && pg.focus) pg.focus(first);
  }

  /* ---- the whole window's clicks and keys ---- */
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav[data-view]');
    if (nav) { setView(nav.dataset.view); return; }
    const op = e.target.closest('[data-op]');
    if (op) { run('win', { op: op.dataset.op }, { noDry: true }).then((r) => { if (r.ok === false) note(`The window did not answer (${r.reason}).`); }); return; }
    const a = e.target.closest('[data-tmact]');
    if (a) {
      const w = a.dataset.tmact;
      if (w === 'elevated-setup') elevatedSetup();
      else if (w === 'wintm') act.windowsTaskManager();
      else if (w === 'clearq') { setQuery(''); q.focus(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (P.dlg) return;   // a dialog keeps its own keys
    const k = e.key;
    if ((e.ctrlKey && (k === 'f' || k === 'F')) || (k === 'F3' && !e.shiftKey)) { e.preventDefault(); if (!q.disabled) { q.focus(); q.select(); } return; }
    if (e.ctrlKey && k === 'Tab') {
      e.preventDefault();
      const i = ORDER.indexOf(P.view);
      setView(ORDER[(i + (e.shiftKey ? ORDER.length - 1 : 1)) % ORDER.length]);
      focusPage();
      return;
    }
    if (k === 'F5') { e.preventDefault(); run('refresh', {}, { noDry: true }).then((r) => (r.missing ? run('sample', {}, { noDry: true }) : r)).then((r) => { if (r.ok === false) note(`Refresh did not run: ${r.reason}`); }); return; }
    if (e.altKey && (k === 'e' || k === 'E')) { e.preventDefault(); const pg = P.pages.get(P.view); if (pg && pg.endTask) pg.endTask(); return; }
    if (k === 'Escape') {
      if (menuIsOpen()) { menuClose(true); return; }
      if (P.railOverlay) { P.railOverlay = false; railState(); return; }
      if (P.q && document.activeElement !== q) { setQuery(''); return; }
    }
  });

  /* ================================================================ RENDER (the visible page only) */
  const PERF = window.__taskmgrPerf = { ticks: 0, ms: 0, max: 0 };
  function render() {
    const m = P.m;
    if (!m) return;
    if (!window.__mantleRows && ((m.apps && m.apps.length) || m.loaded)) {
      // the open's "interactive" moment (lib/features/_open-timing.js): the first render with rows in it, once
      window.__mantleRows = { at: Date.now() };
      try { window.dispatchEvent(new Event('mantle-rows')); } catch (_) { /* the timing just says unknown */ }
    }
    const look = m.look || {};
    const frame = look.light === false ? 'dark' : 'light';
    if (document.documentElement.dataset.frame !== frame) document.documentElement.dataset.frame = frame;
    renderNotes();
    const pg = P.pages.get(P.view);
    if (pg && P.inited.has(P.view)) {
      try { pg.render(m); } catch (e) { note(`The ${pg.title} page could not draw (${e.message}).`); if (window.__tmErrors) window.__tmErrors.push(e); else window.__tmErrors = [e]; }
      setHtml($('pextra'), pg.extra ? pg.extra(m) || '' : '');
    }
    cmdbar();
    document.documentElement.dataset.ready = '1';
  }
  function refresh() { render(); }

  /* ================================================================ the public surface */
  window.TM = {
    page, table, run, call, note, say, refresh, render, setView, goTo, dataState, stateHtml, adminHtml, elevatedSetup, match, failWords,
    esc, fmt, ICON, na, warnLine, iconHtml, store, act, confirm, dialog, runTaskDialog,
    menu: { open: menuOpen, close: menuClose, isOpen: menuIsOpen },
    get m() { return P.m || {}; }, get view() { return P.view; }, get q() { return P.q.trim().toLowerCase(); }, get rawQ() { return P.q; },
    setQuery, focusSearch: () => { q.focus(); q.select(); }, NAV: NAV.slice(), ORDER: ORDER.slice(), setText, setHtml,
  };

  /* ================================================================ start (after every pages/*.js registered) */
  function start() {
    buildRail();
    railState();
    if (!window.mantle) { P.m = { loaded: false, error: 'Not connected to Mantle.' }; note('This page is not connected to Mantle, so nothing here can act.'); show('processes'); return; }
    window.mantle.on('taskmgr.icons', (o) => { let n = 0; for (const k of Object.keys(o || {})) { if (P.icons.get(k) !== o[k]) { P.icons.set(k, o[k]); n++; } } if (n && P.m) render(); });
    window.addEventListener('mantle-wall', () => { if (P.m) render(); });
    window.mantle.on('taskmgr.model', (m) => {
      const t0 = performance.now();
      P.m = m;
      P.got = true;
      if (m && m.view && !P.seenView) { P.seenView = true; show(m.view); }
      // a hidden window does no drawing; it catches up when it is shown
      if (document.hidden) { P.dirty = true; return; }
      render();
      const dt = performance.now() - t0;
      PERF.ticks++; PERF.ms += dt; if (dt > PERF.max) PERF.max = dt;
    });
    window.mantle.on('taskmgr.view', (v) => { if (v && v.view) { P.seenView = true; menuClose(false); show(v.view); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && P.dirty) { P.dirty = false; render(); } });
    P.m = { loaded: false };
    show('processes');
    call('taskmgr.state').then((m) => { if (!P.got) { P.got = true; P.m = m || { loaded: false }; P.seenView = true; show((m && m.view) || 'processes'); } })
      .catch((e) => { P.m = { loaded: false, error: failWords('Mantle did not answer', e) }; render(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
}());
