/* files.js — the Mantle Files window: tabs, the nav pane, the address bar and search, the command
 * bar, keyboard, context menus, and every call to main. The page never touches the disk: each read
 * and write is window.mantle.call('files.<verb>', {w, ...}) and main answers or streams events back.
 *
 * Rules this file keeps:
 *  - Nothing fails silently. Every { ok:false, reason } becomes a toast with that reason; a failed
 *    operation lists each failed item and its `why`. Test-mode dry runs say so, quietly.
 *  - Big folders paint on the FIRST batch (~100 items) and keep appending; the list is virtualised
 *    (list.js), so 10,000 rows cost the same to scroll as 40.
 *  - Selection is kept by key (name / path), so a live refresh or a re-sort never loses it.
 */
(function () {
  'use strict';
  const MF = window.MF;
  const M = MF.model;
  const el = MF.el;
  const $ = (id) => document.getElementById(id);
  const WKEY = (() => { const v = new URLSearchParams(location.search).get('w'); return v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : v; })();

  /* ---- glyphs: 16 px line icons in the island's ink ------------------------------------------- */
  const sv = (d, s) => `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const FOLDER_D = '<path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3.3l1.5 1.5h5.4c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/>';
  const I = {
    back: sv('<path d="M13 8H3M7 4L3 8l4 4"/>'), fwd: sv('<path d="M3 8h10M9 4l4 4-4 4"/>'), up: sv('<path d="M8 13V3M4 7l4-4 4 4"/>'),
    refresh: sv('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/>'),
    chev: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><path d="M4 2.5L6.5 5 4 7.5"/></svg>',
    chevDown: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><path d="M2.5 4L5 6.5 7.5 4"/></svg>',
    search: sv('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>', 14), plus: sv('<path d="M8 3v10M3 8h10"/>'),
    x: sv('<path d="M4 4l8 8M12 4l-8 8"/>', 12),
    folder: sv(FOLDER_D), newfolder: sv(FOLDER_D + '<path d="M8 7.3v3.4M6.3 9h3.4"/>'),
    newfile: sv('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3M8 8v4M6 10h4"/>'),
    cut: sv('<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.8 10L12 2M10.2 10L4 2"/>'),
    copy: sv('<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.2c0-.6-.5-1-1-1H3.2c-.6 0-1 .4-1 1V10c0 .6.4 1 1 1H5"/>'),
    paste: sv('<rect x="3" y="3" width="10" height="11" rx="1.2"/><path d="M6 2h4v2.2H6z"/>'),
    rename: sv('<rect x="1.8" y="4.5" width="12.4" height="7" rx="1.2"/><path d="M4.5 8h3.5M10.5 3v10M9.3 3h2.4M9.3 13h2.4"/>'),
    del: sv('<path d="M3 4h10M6.5 4V2.5h3V4M4.3 4l.8 9.5h5.8l.8-9.5"/><path d="M6.8 6.5v4.5M9.2 6.5v4.5"/>'),
    sort: sv('<path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5"/>'),
    view: sv('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
    details: sv('<path d="M5 4h9M5 8h9M5 12h9M2 4h.5M2 8h.5M2 12h.5"/>'),
    list: sv('<path d="M2 4h4M2 8h4M2 12h4M9.5 4h4.5M9.5 8h4.5M9.5 12h4.5"/>'),
    group: sv('<path d="M2 3.5h12M4 6.5h10M4 9h10M2 12h12"/>'),
    more: sv('<circle cx="3.5" cy="8" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="12.5" cy="8" r=".8" fill="currentColor"/>'),
    preview: sv('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2"/><path d="M9.5 2.5v11"/>'),
    props: sv('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".45" fill="currentColor"/>'),
    undo: sv('<path d="M4 6h6a3.5 3.5 0 0 1 0 7H6"/><path d="M6.5 3.5L4 6l2.5 2.5"/>'),
    home: sv('<path d="M2.5 7.2L8 2.8l5.5 4.4v6H9.7V9.6H6.3v3.6H2.5z"/>'),
    desktop: sv('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1"/><path d="M6 13.5h4M8 11v2.5"/>'),
    downloads: sv('<path d="M8 2v8M4.5 6.8L8 10.3l3.5-3.5M2.5 13.5h11"/>'),
    documents: sv('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3M6 8h4M6 10.5h4"/>'),
    pictures: sv('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2"/><circle cx="5.5" cy="6.2" r="1.2"/><path d="M2 11.5l3.5-3 2.5 2 2.5-2.5 3.5 3.5"/>'),
    music: sv('<path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/>'),
    videos: sv('<rect x="1.8" y="3" width="12.4" height="10" rx="1.2"/><path d="M6.5 5.8v4.4L10.3 8z"/>'),
    onedrive: sv('<path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .3-5.6A4 4 0 0 0 4.3 7a2.8 2.8 0 0 0 .2 5.5z"/>'),
    pc: sv('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1"/><path d="M5.5 13.5h5"/>'),
    drive: sv('<rect x="1.8" y="4.5" width="12.4" height="7" rx="1.4"/><circle cx="11.5" cy="8" r=".55" fill="currentColor"/><path d="M4 8h4"/>'),
    usb: sv('<rect x="4.5" y="1.8" width="7" height="12.4" rx="1.4"/><path d="M6.5 4h3"/>'),
    bin: sv('<path d="M3 4h10M6.5 4V2.5h3V4M4.3 4l.8 9.5h5.8l.8-9.5"/><path d="M6.8 6.5v4.5M9.2 6.5v4.5"/>'),
    network: sv('<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c1.8 1.8 2.6 3.9 2.6 6.2s-.8 4.4-2.6 6.2M8 1.8C6.2 3.6 5.4 5.7 5.4 8s.8 4.4 2.6 6.2"/>'),
    pin: sv('<path d="M10 1.8L14.2 6l-2.3.8-2.4 2.4-.3 3-5.4-5.4 3-.3 2.4-2.4z"/><path d="M5.2 10.8L1.8 14.2"/>'),
    restore: sv('<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.5V5h2.5"/>'),
    zip: sv('<rect x="2.5" y="2" width="11" height="12" rx="1.2"/><path d="M8 2v1.5M8 5v1.5M8 8v1.5"/><rect x="6.8" y="10" width="2.4" height="2.2" rx=".4"/>'),
    newwin: sv('<path d="M9 2.5h4.5V7M13.5 2.5L8 8M12 9.5v3.5H3V4h3.5"/>'),
    newtab: sv('<rect x="1.8" y="3" width="12.4" height="10.5" rx="1.2"/><path d="M1.8 6h5.5V3"/>'),
    link: sv('<path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/>'),
    selectall: sv('<rect x="2" y="2" width="12" height="12" rx="1.5" stroke-dasharray="2 2"/><path d="M5 8l2 2 4-4"/>'),
    openwith: sv('<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 8h4M8 6v4"/>'),
    hidden: sv('<path d="M1.8 8s2.3-4.3 6.2-4.3S14.2 8 14.2 8 11.9 12.3 8 12.3 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>'),
    terminal: sv('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2"/><path d="M4.5 6.5L6.8 8.5 4.5 10.5M8.5 10.5h3"/>'),
    filter: sv('<path d="M2 3h12l-4.6 5.4v4.4l-2.8 1.4V8.4z"/>'),
    warn: sv('<path d="M8 2.2l6.2 10.9H1.8z"/><path d="M8 6.4v3M8 11.2v.01"/>', 14),   // Settings' warn glyph
  };
  const KNOWN = [['desktop', 'Desktop'], ['downloads', 'Downloads'], ['documents', 'Documents'], ['pictures', 'Pictures'], ['music', 'Music'], ['videos', 'Videos'], ['onedrive', 'OneDrive']];
  const VIRTUAL_LABEL = { 'mantle:home': 'Home', 'mantle:thispc': 'This PC', 'mantle:recycle': 'Recycle Bin', 'mantle:network': 'Network' };
  const VIRTUAL_ICON = { 'mantle:home': 'home', 'mantle:thispc': 'pc', 'mantle:recycle': 'bin', 'mantle:network': 'network' };

  /* ---- state ---------------------------------------------------------------------------------- */
  const S = {
    booted: false, home: null, test: false, sandbox: null, names: {}, known: {}, roots: null, pins: [], undoLabel: null,
    options: { showHidden: false, showExtensions: true, defaultView: 'details' },
    tabs: [], active: 0, nextTab: 1, select: null,
    icons: new Map(), iconWant: new Map(), iconTimer: null, iconWhyShown: false,
    types: {}, typeWant: new Set(), typePend: new Set(), typeTimer: null,
    thumbs: new Map(), thumbWant: new Map(), thumbPend: new Set(), thumbTimer: null,
    cut: new Set(), ops: new Map(), early: new Map(), placeSel: null, folderProps: false, navThisPc: true,
  };
  MF.perf = { runs: [] };
  const cur = () => S.tabs[S.active];
  const tabById = (id) => S.tabs.find((t) => t.id === id);

  /* ---- talking to main ------------------------------------------------------------------------ */
  function api(name, args) {
    if (!window.mantle) return Promise.resolve({ ok: false, reason: 'no bridge to Mantle: this page only works inside Mantle' });
    const a = Object.assign({ w: WKEY }, args || {});
    return Promise.resolve().then(() => window.mantle.call(name, a)).then((r) => (r == null ? {} : r), (e) => ({ ok: false, reason: (e && e.message) || String(e) }));
  }
  const toast = MF.toast;
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /** The one place replies are judged: a refusal or failure is loud, a test-mode dry run quiet. */
  function report(r, what) {
    if (!r || r.ok === false) { toast(`${what}: ${(r && r.reason) || 'no answer from Mantle'}`, { kind: 'err' }); return false; }
    if (r.dryRun) { toast(r.reason || 'test mode: nothing was done', { kind: 'quiet' }); return false; }
    return true;
  }

  /* ---- paths, names, icons, types --------------------------------------------------------------- */
  function pathOf(it, tab) {
    if (it.p) return it.p;
    if (it.binKey) return null;
    const t = tab || cur();
    return t && !M.isVirtual(t.path) ? M.joinPath(t.path, it.n) : null;
  }
  const nameOf = (it) => M.displayName(it.n, it.d, S.options.showExtensions);
  const typeOf = (it) => M.typeOf(it, S.types);
  const extKey = (it) => (it.d ? 'folder' : M.extOf(it.n, false));
  function iconClass(px) {
    const need = px * (window.devicePixelRatio || 1);
    return need <= 16 ? 16 : need <= 32 ? 32 : need <= 48 ? 48 : 256;
  }
  function iconOf(it, px) {
    const cls = iconClass(px);
    const k = cls + '|' + extKey(it);
    const hit = S.icons.get(k);
    if (hit !== undefined) return hit;
    let want = S.iconWant.get(cls);
    if (!want) { want = new Set(); S.iconWant.set(cls, want); }
    want.add(extKey(it));
    if (!S.iconTimer) S.iconTimer = setTimeout(pumpIcons, 0);
    return null;
  }
  function pumpIcons() {
    S.iconTimer = null;
    for (const [cls, want] of S.iconWant) {
      const exts = [...want];
      S.iconWant.delete(cls);
      for (const e of exts) S.icons.set(cls + '|' + e, null);        // asked once; a miss stays a blank, not a loop
      for (let i = 0; i < exts.length; i += 200) {
        api('files.icons', { exts: exts.slice(i, i + 200), px: cls }).then((r) => {
          if (!r || r.ok === false || r.why) {
            if (!S.iconWhyShown) { S.iconWhyShown = true; toast(`Some icons are missing: ${(r && (r.why || r.reason)) || 'no answer'}`, { kind: 'quiet' }); }
          }
          const got = (r && r.icons) || {};
          let n = 0;
          for (const e of Object.keys(got)) { S.icons.set(cls + '|' + e, got[e]); n++; }
          if (n) { list.repaint(); if (MF.side.mode) MF.side.update(); }
        });
      }
    }
  }
  function wantTypes(items) {
    for (const it of items) {
      if (it.d) continue;
      const e = M.extOf(it.n, false);
      if (e && S.types[e] === undefined && !S.typePend.has(e)) S.typeWant.add(e);
    }
    if (S.typeWant.size && !S.typeTimer) S.typeTimer = setTimeout(pumpTypes, 30);
  }
  function pumpTypes() {
    S.typeTimer = null;
    const exts = [...S.typeWant].slice(0, 200);
    for (const e of exts) { S.typeWant.delete(e); S.typePend.add(e); }
    if (S.typeWant.size) S.typeTimer = setTimeout(pumpTypes, 30);
    api('files.types', { exts }).then((r) => {
      const got = (r && r.types) || {};
      for (const e of exts) { S.typePend.delete(e); S.types[e] = got[e] || M.typeOf({ n: 'x' + e, d: 0 }, {}); }
      const t = cur();
      if (t && (t.view.sort === 'type' || t.view.group === 'type')) arrange(t); else list.repaint();
    });
  }
  /* Thumbnails: only for what is on screen, de-duplicated, cached by path|m|s|px. A request is sent
     60 ms after scrolling settles, so a fling past 5,000 photos asks for the last screenful only. */
  function thumbPx() { const t = cur(); const g = MF.GRID[t.view.size] || MF.GRID.medium; return Math.min(512, Math.round(g.ic * (window.devicePixelRatio || 1))); }
  function thumbOf(it) {
    const p = pathOf(it);
    if (!p) return null;
    const px = thumbPx();
    const key = M.thumbKey(p, it.m, it.s, px);
    const hit = S.thumbs.get(key);
    if (hit !== undefined) return hit;
    if (!S.thumbPend.has(key)) { S.thumbWant.set(key, { path: p, m: it.m, s: it.s, px }); clearTimeout(S.thumbTimer); S.thumbTimer = setTimeout(pumpThumbs, 60); }
    return null;
  }
  function pumpThumbs() {
    const t = cur();
    if (!t || t.view.view !== 'grid') { S.thumbWant.clear(); return; }
    const onScreen = new Set(list.visible().map((it) => { const p = pathOf(it); return p ? M.thumbKey(p, it.m, it.s, thumbPx()) : ''; }));
    const want = [...S.thumbWant].filter(([k]) => onScreen.has(k));
    S.thumbWant.clear();
    for (let i = 0; i < want.length; i += 24) {
      const chunk = want.slice(i, i + 24);
      for (const [k] of chunk) S.thumbPend.add(k);
      const px = chunk[0][1].px;
      api('files.thumbs', { items: chunk.map(([, v]) => ({ path: v.path, m: v.m, s: v.s })), px, mode: 'thumb' }).then((r) => {
        const res = (r && r.results) || [];
        const done = new Set();
        chunk.forEach(([k], j) => {
          S.thumbPend.delete(k);
          const one = res[j];
          if (!one || one.skipped) return;                    // scrolled away in main's queue: ask again when seen
          S.thumbs.set(k, one.url ? { url: one.url, kind: one.kind || 'thumb' } : null);
          done.add(k);
        });
        if (S.thumbs.size > 4000) { let n = 0; for (const k of S.thumbs.keys()) { S.thumbs.delete(k); if (++n >= 1000) break; } }
        if (done.size && cur() === t) list.refill((it) => { const p = pathOf(it); return p && done.has(M.thumbKey(p, it.m, it.s, px)); });
      });
    }
  }
  function colText(it, id) {
    if (id === 'date') return M.fmtDate(it.m);
    if (id === 'type') return typeOf(it);
    if (id === 'size') return it.d ? '' : M.fmtSize(it.s || 0);
    if (id === 'created') return M.fmtDate(it.c);
    if (id === 'location') return it.loc || '';
    if (id === 'deleted') return M.fmtDate(it.del);
    if (id === 'status') { const st = M.syncState(it); return st ? st.label : cur() && cur().cloud ? 'On this device' : ''; }
    if (id === 'match') return it.hit === 'content' ? it.snip || 'in the text' : it.hit === 'name' ? 'Name' : '';
    return '';
  }
  function labelOf(p) {
    if (!p) return '';
    if (VIRTUAL_LABEL[p]) return VIRTUAL_LABEL[p];
    const nm = S.names[p.toLowerCase()];
    if (nm) return nm;
    return M.isRoot(p) ? p.slice(0, 2) : M.baseName(p);
  }

  /* ---- tabs ------------------------------------------------------------------------------------- */
  function tabObj() {
    return {
      id: S.nextTab++, path: null, hist: [], fwd: [], kind: 'folder', colset: 'folder', items: [], shown: [], groups: null, index: new Map(),
      sel: new Set(), focusKey: null, anchorKey: null, scroll: 0, view: null, folderView: null, crumbs: [], parent: null, job: null, loading: false,
      error: null, watchWhy: null, place: null, search: null, refresh: null, wantSel: null, painted: false, t0: 0,
    };
  }
  function newTab(path, background) {
    const t = tabObj();
    S.tabs.splice(S.active + 1, 0, t);
    if (!background) S.active = S.active + 1;
    go(t, path || 'mantle:home', { push: false });
    renderTabs();
    if (!background) showTab();
    reportTabs();
    return t;
  }
  function closeTab(i) {
    const t = S.tabs[i];
    if (!t) return;
    if (S.tabs.length === 1) { api('files.win', { op: 'close' }).then((r) => report(r, 'The window did not close')); return; }
    cancelJobs(t);
    S.tabs.splice(i, 1);
    if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
    else if (i < S.active) S.active--;
    renderTabs();
    showTab();
    reportTabs();
  }
  function activate(i) {
    if (i === S.active || !S.tabs[i]) return;
    if (list.renaming) list.renaming.finish(true);
    S.active = i;
    renderTabs();
    showTab();
    reportTabs();
  }
  let tabsTimer = null;
  function reportTabs() {
    clearTimeout(tabsTimer);
    tabsTimer = setTimeout(() => {
      api('files.tabs', { tabs: S.tabs.map((t) => ({ tab: t.id, path: t.path })), active: S.active }).then((r) => { if (r && r.ok === false) toast(`Your tabs were not remembered: ${r.reason}`, { kind: 'quiet' }); });
    }, 300);
  }
  function renderTabs() {
    const box = $('tabs');
    box.textContent = '';
    S.tabs.forEach((t, i) => {
      const d = el('div', 'tab' + (i === S.active ? ' on' : ''));
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-selected', i === S.active ? 'true' : 'false');
      const label = t.search ? `Search: ${t.search.query}` : labelOf(t.path);
      d.title = t.search ? label : (M.isVirtual(t.path) ? label : t.path || '');
      const ic = el('span');
      ic.innerHTML = I[VIRTUAL_ICON[t.path]] || I.folder;
      ic.firstChild.classList.add('ti');
      d.appendChild(ic.firstChild);
      d.appendChild(el('span', 'tl', label || 'Loading…'));
      const x = el('button', 'tx');
      x.type = 'button';
      x.title = 'Close tab (Ctrl+W)';
      x.setAttribute('aria-label', 'Close tab');
      x.innerHTML = I.x;
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(S.tabs.indexOf(t)); });
      d.appendChild(x);
      d.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(S.tabs.indexOf(t)); } else if (e.button === 0) activate(S.tabs.indexOf(t)); });
      d.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); activate(S.tabs.indexOf(t)); } });
      box.appendChild(d);
    });
  }

  /* ---- navigation -------------------------------------------------------------------------------- */
  function kindOf(p) {
    if (p === 'mantle:home') return 'home';
    if (p === 'mantle:thispc' || p === 'mantle:network') return 'place';
    if (p === 'mantle:recycle') return 'recycle';
    return 'folder';
  }
  function defaultView(kind) {
    const base = { view: S.options.defaultView || 'details', sort: 'name', dir: 'asc', group: 'none', cols: null, size: 'medium' };
    if (kind === 'recycle') return Object.assign(base, { view: 'details', sort: 'deleted', dir: 'desc' });
    if (kind === 'home') return Object.assign(base, { view: 'details', sort: 'date', dir: 'desc' });
    return base;
  }
  function cancelJobs(t) {
    for (const j of [t.job, t.refresh && t.refresh.job, t.search && t.search.job]) if (j) api('files.cancel', { job: j });
    t.job = null;
    t.refresh = null;
  }
  /** Open a path in a tab. how: { push (history, default true), select: [keys] } */
  /** Inside the OneDrive folder (placeholders: the Status column shows what is on this device). */
  function isCloud(p) {
    const od = S.known && S.known.onedrive;
    if (!od || !p) return false;
    const a = String(p).toLowerCase();
    const b = String(od).toLowerCase().replace(/\\+$/, '');
    return a === b || a.startsWith(b + '\\');
  }
  async function go(tab, path, how) {
    const o = how || {};
    const p = M.normPath(path);
    if (!p) { toast(`That is not a folder path: ${path}`, { kind: 'err' }); return; }
    if (list.renaming && tab === cur()) list.renaming.finish(true);
    if (tab.path && o.push !== false && !M.samePath(tab.path, p)) { tab.hist.push({ path: tab.path, scroll: tab.scroll, focus: tab.focusKey }); tab.fwd = []; }
    if (tab.search) endSearch(tab, true);
    cancelJobs(tab);
    Object.assign(tab, {
      path: p, kind: kindOf(p), items: [], shown: [], groups: null, index: new Map(), sel: new Set(), focusKey: o.focus || null, anchorKey: null,
      scroll: o.scroll || 0, error: null, watchWhy: null, place: null, loading: true, painted: false, t0: performance.now(), wantSel: o.select ? { keys: o.select, until: Date.now() + 8000 } : null,
      filter: null,
    });
    tab.cloud = tab.kind === 'folder' && isCloud(p);
    tab.colset = tab.kind === 'home' ? 'home' : tab.kind === 'recycle' ? 'recycle' : tab.cloud ? 'cloud' : 'folder';
    tab.crumbs = M.crumbs(p, S.names);
    tab.parent = M.parentOf(p);
    tab.view = defaultView(tab.kind);
    const run = { path: p, kind: tab.kind, t0: tab.t0, first: null, all: null, count: 0 };
    tab.run = run;
    if (tab === cur()) { renderTabs(); showTab(); }
    reportTabs();
    const r = await api('files.list', { tab: tab.id, path: p });
    if (tab.path !== p || tab.run !== run) return;          // navigated on meanwhile
    if (!r || r.ok === false) {
      tab.loading = false;
      tab.error = (r && r.reason) || 'no answer from Mantle';
      if (tab === cur()) showTab();
      return;
    }
    tab.path = r.path || p;
    tab.parent = r.parent !== undefined ? r.parent : tab.parent;
    if (Array.isArray(r.crumbs) && r.crumbs.length) tab.crumbs = r.crumbs;
    if (r.view) tab.view = Object.assign(defaultView(tab.kind), r.view);
    tab.watchWhy = r.watchWhy || null;
    if (tab.kind === 'place') {
      tab.place = { drives: r.drives || [], known: r.known || [], network: r.network || [] };
      tab.loading = false;
      if (r.drives) { S.roots = Object.assign({}, S.roots || {}, { drives: r.drives, network: r.network || [] }); renderNav(); }
    } else if (tab.kind === 'recycle') {
      tab.items = (r.recycle || []).map(binItem);
      tab.binCount = r.count;
      tab.binBytes = r.bytes;
      tab.loading = false;
      wantTypes(tab.items);
      arrange(tab);
    } else if (tab.kind === 'home') {
      await loadHome(tab);
    } else {
      tab.job = r.job;
      drainEarly(tab, r.job);
    }
    if (tab === cur()) showTab();
  }
  function binItem(b) {
    return { n: b.n, d: b.d ? 1 : 0, s: b.s || 0, m: b.del || 0, c: 0, a: b.d ? 16 : 32, key: 'bin|' + b.key, binKey: b.key, loc: b.orig || '', del: b.del || 0 };
  }
  async function loadHome(tab) {
    const h = await api('files.home');
    if (tab.path !== 'mantle:home') return;
    tab.loading = false;
    if (!h || h.ok === false) { tab.error = `Home could not be read: ${(h && h.reason) || 'no answer'}`; return; }
    const items = [];
    for (const pin of h.pins || []) items.push({ n: pin.label || M.baseName(pin.path), d: 1, s: 0, m: 0, c: 0, a: 16, p: pin.path, loc: M.parentOf(pin.path) || '', key: 'pin|' + pin.path.toLowerCase(), _grp: 'Pinned', _grank: 0, pin: true, missing: !!pin.missing });
    for (const rc of h.recent || []) items.push({ n: rc.n || M.baseName(rc.path), d: rc.d ? 1 : 0, s: 0, m: rc.m || 0, c: 0, a: rc.d ? 16 : 32, p: rc.path, loc: M.parentOf(rc.path) || '', key: 'rec|' + rc.path.toLowerCase(), _grp: 'Recent', _grank: 1 });
    tab.items = items;
    tab.watchWhy = h.recentWhy || null;
    wantTypes(items);
    arrange(tab);
  }
  function back(tab) {
    const t = tab || cur();
    const h = t.hist.pop();
    if (!h) return;
    t.fwd.push({ path: t.path, scroll: t.scroll, focus: t.focusKey });
    go(t, h.path, { push: false, scroll: h.scroll, select: h.focus ? [h.focus] : null, focus: h.focus });
  }
  function forward(tab) {
    const t = tab || cur();
    const h = t.fwd.pop();
    if (!h) return;
    t.hist.push({ path: t.path, scroll: t.scroll, focus: t.focusKey });
    go(t, h.path, { push: false, scroll: h.scroll });
  }
  function up() {
    const t = cur();
    if (t.search) { endSearch(t); return; }
    const from = t.path;
    const target = t.parent || (M.isVirtual(t.path) ? null : 'mantle:thispc');
    if (!target) return;
    go(t, target, { select: M.isVirtual(from) ? null : [M.baseName(from)] });
  }

  /* ---- streamed listings ------------------------------------------------------------------------ */
  function drainEarly(tab, job) {
    const evs = S.early.get(job);
    if (!evs) return;
    S.early.delete(job);
    for (const ev of evs) (ev._found ? onFound : onItems)(ev);
  }
  const opEarly = new Map();                 // job -> an opdone that arrived before its files.op reply
  let opDoneFn = null;                       // listen()'s onOpDone
  /** track()/undo() learned `job`: if its opdone already came, finish it now (true = do not start a card). */
  function claimOpDone(job) {
    const ev = opEarly.get(job);
    if (!ev) return false;
    opEarly.delete(job);
    try { if (opDoneFn) opDoneFn(ev); } catch (e) { toast(`Mantle Files hit a bug handling files.opdone: ${e.message}`, { kind: 'err' }); }
    return true;
  }
  function early(ev) {
    let a = S.early.get(ev.job);
    if (!a) { a = []; S.early.set(ev.job, a); if (S.early.size > 20) S.early.delete(S.early.keys().next().value); }
    a.push(ev);
  }
  function onItems(ev) {
    const tab = tabById(ev.tab);
    if (!tab) return;
    if (tab.refresh && tab.refresh.job === ev.job) {
      for (const it of ev.items || []) tab.refresh.items.push(it);
      if (ev.done) {
        const rf = tab.refresh;
        tab.refresh = null;
        if (ev.error) { toast(`${labelOf(tab.path)} could not be refreshed: ${ev.error}`, { kind: 'err' }); return; }
        tab.items = rf.items;
        wantTypes(tab.items);
        arrange(tab);
      }
      return;
    }
    // Events can overtake the files.list reply (main relays them synchronously; the reply waits on a
    // promise): keep them for the job we are waiting to learn, a first listing's OR a refresh's.
    // (A dropped refresh 'done' left tab.refresh hanging: a rename did not show until F5. lane files2)
    if (tab.job !== ev.job) { if ((tab.loading && tab.job == null) || (tab.refresh && tab.refresh.job == null)) early(ev); return; }
    const items = ev.items || [];
    for (let i = 0; i < items.length; i++) tab.items.push(items[i]);
    wantTypes(items);
    if (ev.done) {
      tab.loading = false;
      tab.job = null;
      if (ev.error) tab.error = `This folder could not be read: ${ev.error}`;
      arrange(tab);
      if (tab.run) { tab.run.count = tab.items.length; tab.run.sidecarMs = ev.ms; afterPaint(() => { if (tab.run && tab.run.all == null) { tab.run.all = performance.now() - tab.run.t0; MF.perf.runs.push(tab.run); } }); }
      if (tab === cur()) showTab();
    } else if (!tab.painted) arrange(tab);
    else scheduleArrange(tab);
  }
  function scheduleArrange(tab) {
    if (tab.arrTimer) return;
    // while a big folder streams in, re-sort at most every 150 ms; each batch still counts in the status bar
    tab.arrTimer = setTimeout(() => { tab.arrTimer = null; arrange(tab); }, 150);
    if (tab === cur()) renderStatus();
  }
  function afterPaint(fn) { requestAnimationFrame(() => setTimeout(fn, 0)); }

  /** Hide, sort, group; keep selection by key; apply a pending "select these when they appear". */
  function arrange(tab) {
    if (tab.arrTimer) { clearTimeout(tab.arrTimer); tab.arrTimer = null; }
    const t0 = performance.now();
    const src = tab.search ? tab.search.items : tab.items;
    const r = M.arrange(src, { filter: tab.filter, sort: tab.view.sort, dir: tab.view.dir, group: tab.view.group, showHidden: S.options.showHidden, types: S.types, now: Date.now(), dateField: tab.kind === 'recycle' ? 'del' : 'm' });
    tab.shown = r.shown;
    tab.groups = r.groups;
    const idx = new Map();
    for (let i = 0; i < r.shown.length; i++) idx.set(MF.keyOf(r.shown[i]), i);
    tab.index = idx;
    let selGone = false;
    for (const k of tab.sel) if (!idx.has(k)) { tab.sel.delete(k); selGone = true; }
    tab.arrangeMs = performance.now() - t0;
    if (tab !== cur()) return;
    if (tab.kind !== 'place') list.refresh();
    if (tab.wantSel) {
      const have = tab.wantSel.keys.filter((k) => idx.has(k));
      if (have.length) {
        list.selectKeys(have);
        if (have.length === tab.wantSel.keys.length || Date.now() > tab.wantSel.until) tab.wantSel = null;
      } else if (Date.now() > tab.wantSel.until) tab.wantSel = null;
    } else if (tab.wantIdx != null && !tab.sel.size && tab.shown.length) {
      const i = Math.min(tab.wantIdx, tab.shown.length - 1);
      tab.wantIdx = null;
      list.selectOnly(i);
      list.reveal(i);
    } else if (selGone) list.changed();
    if (S.select && tab === S.tabs[0] && !tab.loading) {
      const k = S.select;
      S.select = null;
      if (idx.has(k)) list.selectKeys([k]);
      else { const hit = [...idx.keys()].find((x) => String(x).toLowerCase() === String(k).toLowerCase()); if (hit) list.selectKeys([hit]); }
    }
    renderStatus();
    renderEmpty();
  }

  /* ---- refresh (F5 and 'files.changed') --------------------------------------------------------- */
  async function relist(tab) {
    if (!tab || !tab.path) return;
    if (tab.search) return;
    if (tab.kind === 'home') { const sel = [...tab.sel]; await loadHome(tab); if (tab === cur()) { list.selectKeys(sel, false); showTab(); } return; }
    if (tab.kind !== 'folder') {
      const r = await api('files.list', { tab: tab.id, path: tab.path });
      if (!r || r.ok === false) { toast(`${labelOf(tab.path)} could not be refreshed: ${(r && r.reason) || 'no answer'}`, { kind: 'err' }); return; }
      if (tab.kind === 'recycle') { tab.items = (r.recycle || []).map(binItem); tab.binCount = r.count; tab.binBytes = r.bytes; arrange(tab); }
      else { tab.place = { drives: r.drives || [], known: r.known || [], network: r.network || [] }; }
      if (tab === cur()) showTab();
      return;
    }
    if (tab.loading) return;                                   // the first listing is still streaming
    if (tab.refresh) api('files.cancel', { job: tab.refresh.job });
    const rf = { job: null, items: [] };
    tab.refresh = rf;
    const r = await api('files.list', { tab: tab.id, path: tab.path });
    if (tab.refresh !== rf) return;
    if (!r || r.ok === false) { tab.refresh = null; toast(`${labelOf(tab.path)} could not be refreshed: ${(r && r.reason) || 'no answer'}`, { kind: 'err' }); return; }
    rf.job = r.job;
    tab.watchWhy = r.watchWhy || null;
    const evs = S.early.get(r.job);
    if (evs) { S.early.delete(r.job); for (const ev of evs) onItems(ev); }
  }
  const relistTimers = new Map();
  function relistSoon(tab) {
    clearTimeout(relistTimers.get(tab.id));
    relistTimers.set(tab.id, setTimeout(() => { relistTimers.delete(tab.id); relist(tab); }, 200));
  }

  /* ---- search ------------------------------------------------------------------------------------ */
  let searchTimer = null;
  async function startSearch(q) {
    const tab = cur();
    const query = String(q || '').trim();
    if (!query) { if (tab.search) endSearch(tab); return; }
    if (tab.kind !== 'folder') { toast('Search works inside a folder: open one first', { kind: 'quiet' }); return; }
    if (tab.search && tab.search.job) api('files.cancel', { job: tab.search.job });
    if (!tab.search) { tab.folderView = tab.view; tab.folderScroll = tab.scroll; }
    const contents = !!S.options.searchContents && !/[*?]/.test(query);
    tab.search = { query, contents, job: null, items: [], done: false, count: 0, capped: false, denied: 0, t0: performance.now() };
    tab.view = { view: tab.folderView.view === 'grid' ? 'grid' : 'details', sort: 'name', dir: 'asc', group: 'none', cols: null, size: tab.folderView.size };
    tab.colset = contents ? 'searchc' : 'search';
    tab.sel = new Set();
    tab.focusKey = null;
    tab.scroll = 0;
    arrange(tab);
    list.setTab(tab, false);
    showTab();
    const s = tab.search;
    const r = await api('files.search', { tab: tab.id, path: tab.path, query, contents });
    if (tab.search !== s) { if (r && r.job) api('files.cancel', { job: r.job }); return; }
    if (!r || r.ok === false) { s.done = true; s.error = (r && r.reason) || 'no answer'; showTab(); return; }
    s.job = r.job;
    const evs = S.early.get(r.job);
    if (evs) { S.early.delete(r.job); for (const ev of evs) onFound(ev); }
  }
  function onFound(ev) {
    const tab = tabById(ev.tab);
    if (!tab) return;
    if (!tab.search || tab.search.job !== ev.job) { if (tab.search && tab.search.job == null) { ev._found = true; early(ev); } return; }
    const s = tab.search;
    for (const it of ev.items || []) { it.loc = M.parentOf(it.p) || ''; s.items.push(it); }
    wantTypes(ev.items || []);
    if (ev.done) {
      Object.assign(s, { done: true, count: ev.count, capped: !!ev.capped, denied: ev.denied || 0, skipped: ev.skipped || 0, ms: ev.ms, error: ev.error || null, job: null });
      arrange(tab);
      if (tab === cur()) showTab();
    } else if (s.items.length === (ev.items || []).length) arrange(tab);
    else scheduleArrange(tab);
  }
  function endSearch(tab, silent) {
    const t = tab || cur();
    if (!t.search) return;
    if (t.search.job) api('files.cancel', { job: t.search.job });
    t.search = null;
    t.view = t.folderView || defaultView(t.kind);
    t.colset = t.cloud ? 'cloud' : 'folder';
    t.sel = new Set();
    t.scroll = t.folderScroll || 0;
    if (t === cur()) $('search').value = '';
    if (silent) return;
    arrange(t);
    if (t === cur()) { list.setTab(t, false); showTab(); }
  }

  /* ---- views ------------------------------------------------------------------------------------ */
  function saveView(tab) {
    if (tab.search) return;
    const v = tab.view;
    api('files.setview', { path: tab.path, view: v.view, sort: v.sort, dir: v.dir, group: v.group, cols: v.cols || undefined, size: v.size }).then((r) => {
      if (r && r.ok === false) toast(`This folder's view was not remembered: ${r.reason}`, { kind: 'quiet' });
    });
  }
  function setView(patch) {
    const t = cur();
    if (t.kind === 'place') return;
    const before = t.view;
    t.view = Object.assign({}, t.view, patch);
    if (patch.cols !== undefined) delete t.view.colsParsed;
    else if (before.colsParsed) t.view.colsParsed = before.colsParsed;
    saveView(t);
    if (patch.sort !== undefined || patch.dir !== undefined || patch.group !== undefined) arrange(t);
    else list.setTab(t, true);
    renderCmdbar();
    renderStatus();
    const k = t.focusKey != null ? t.index.get(t.focusKey) : undefined;
    if (k !== undefined) list.reveal(k);
  }
  function sortBy(key) {
    const t = cur();
    if (t.view.sort === key) setView({ dir: t.view.dir === 'asc' ? 'desc' : 'asc' });
    else setView({ sort: key, dir: ['date', 'size', 'created', 'deleted'].includes(key) ? 'desc' : 'asc' });
  }
  const VIEWS = [['details', null, 'Details', I.details, 'Ctrl+Shift+6'], ['list', null, 'List', I.list, 'Ctrl+Shift+5'],
    ['grid', 'small', 'Small icons', I.view, 'Ctrl+Shift+4'], ['grid', 'medium', 'Medium icons', I.view, 'Ctrl+Shift+3'], ['grid', 'large', 'Large icons', I.view, 'Ctrl+Shift+2']];
  function viewItems() {
    const t = cur();
    return VIEWS.map(([v, size, label, icon, key]) => ({ label, key, check: t.view.view === v && (!size || t.view.size === size), act: () => setView(size ? { view: v, size } : { view: v }) }));
  }
  function sortItems() {
    const t = cur();
    const set = M.COLSETS[t.colset] || M.COLSETS.folder;
    const out = set.all.map((id) => ({ label: M.colLabel(id, t.colset), check: t.view.sort === M.COLS[id].sort, act: () => sortBy(M.COLS[id].sort) }));
    out.push({ sep: true }, { label: 'Ascending', check: t.view.dir === 'asc', act: () => setView({ dir: 'asc' }) }, { label: 'Descending', check: t.view.dir === 'desc', act: () => setView({ dir: 'desc' }) });
    return out;
  }
  function groupItems() {
    const t = cur();
    return [['none', 'None'], ['type', 'Type'], ['date', t.kind === 'recycle' ? 'Date deleted' : 'Date modified'], ['size', 'Size'], ['letter', 'First letter']]
      .map(([g, label]) => ({ label, check: t.view.group === g, act: () => setView({ group: g }) }));
  }
  function columnMenu(x, y) {
    const t = cur();
    const set = M.COLSETS[t.colset] || M.COLSETS.folder;
    const cols = list.detailCols();
    MF.menu.open(set.all.map((id) => ({
      label: M.colLabel(id, t.colset), check: cols.some((c) => c.id === id), disabled: id === 'name',
      act: () => {
        const now = list.detailCols().slice();
        const i = now.findIndex((c) => c.id === id);
        if (i >= 0) now.splice(i, 1); else now.push({ id, w: M.COLS[id].w });
        setView({ cols: M.encodeCols(now) });
      },
    })), x, y);
  }

  /* ---- selection helpers -------------------------------------------------------------------------- */
  function selItems(tab) {
    const t = tab || cur();
    if (!t || !t.sel.size) return [];
    const idx = [];
    for (const k of t.sel) { const i = t.index.get(k); if (i !== undefined) idx.push(i); }
    idx.sort((a, b) => a - b);
    return idx.map((i) => t.shown[i]);
  }
  const selPaths = () => selItems().map((it) => pathOf(it)).filter(Boolean);
  const isFolderTab = () => { const t = cur(); return t && t.kind === 'folder' && !t.search && !t.loading && !t.error; };
  const canWriteHere = () => { const t = cur(); return t && t.kind === 'folder' && !t.search; };

  /* ---- operations ------------------------------------------------------------------------------- */
  /** Every started job lands here: progress card, and what to do when it finishes. */
  function track(r, op, info) {
    const words = info.label || M.opWords(op);
    if (!r || r.ok === false) { toast(`${words} did not start: ${(r && r.reason) || 'no answer from Mantle'}`, { kind: 'err' }); return false; }
    if (r.dryRun) { toast(r.reason || 'test mode: nothing was done', { kind: 'quiet' }); return false; }
    if (r.needConflict) { conflictFlow(r, info); return false; }
    if (!r.job) { toast(cap(r.reason || 'nothing to do'), { kind: 'quiet' }); return false; }
    S.ops.set(r.job, Object.assign({ op: r.op || op, label: words, dest: r.dest || null }, info));
    if (!claimOpDone(r.job)) MF.progress.start(r.job, { label: words });
    return true;
  }
  async function conflictFlow(r, info) {
    const dest = r.dest || info.dest;
    const choice = await MF.dialog.conflict({ conflicts: r.conflicts || [], op: r.op, count: (r.items || []).length, destLabel: labelOf(dest) });
    if (!choice) { toast('Nothing was copied or moved', { kind: 'quiet' }); return; }
    const r2 = await api('files.op', { op: r.op, items: r.items, dest, conflict: choice });
    track(r2, r.op, transferInfo(r.op, (r.items || []).length, dest));
  }
  function transferInfo(op, n, dest) {
    return {
      label: `${op === 'move' ? 'Moving' : 'Copying'} ${M.plural(n, 'item')} to ${labelOf(dest)}`, dest,
      after: (ev) => {
        const t = cur();
        if (!ev.ok || !t || !M.samePath(t.path, dest)) return;
        const keys = (ev.results || []).filter((x) => x && x.ok !== false && x.dst).map((x) => M.baseName(x.dst));
        if (keys.length) t.wantSel = { keys, until: Date.now() + 6000 };
      },
    };
  }
  function startOp(args, info) { return api('files.op', args).then((r) => track(r, args.op, info)); }

  function newItem(kind) {
    const t = cur();
    if (!canWriteHere()) return;
    const name = kind === 'newfolder' ? 'New folder' : 'New Text Document.txt';
    startOp({ op: kind, dest: t.path, name }, {
      label: kind === 'newfolder' ? 'Creating a folder' : 'Creating a text document',
      after: (ev) => {
        if (!ev.ok || cur() !== t) return;
        const dst = ev.results && ev.results[0] && ev.results[0].dst;
        const n = dst ? M.baseName(dst) : name;
        // show it now and rename in place; the live refresh brings the same name a moment later
        if (!t.items.some((x) => x.n.toLowerCase() === n.toLowerCase())) { const now = Date.now(); t.items.push({ n, d: kind === 'newfolder' ? 1 : 0, s: 0, m: now, c: now, a: kind === 'newfolder' ? 16 : 32 }); arrange(t); }
        const i = t.index.get(n);
        if (i === undefined) return;
        list.selectOnly(i);
        list.beginRename(i, commitRename);
      },
    });
  }
  function renameSel() {
    const t = cur();
    const items = selItems();
    if (!items.length || t.kind === 'recycle' || t.kind === 'place') return;
    if (items.length > 1) { renameMany(items); return; }
    const it = items[0];
    if (it.pin || !pathOf(it)) return;
    list.beginRename(t.index.get(MF.keyOf(it)), commitRename);
  }
  /** F2 with several selected: Mantle's rename-many dialog, then ONE job (one Ctrl+Z puts all back). */
  async function renameMany(sel) {
    const t = cur();
    const items = sel.filter((it) => !it.pin && pathOf(it));
    if (!items.length) return;
    const taken = (t.search ? [] : t.items.map((x) => x.n));
    const plan = await MF.dialog.renameMany({ items, taken });
    if (!plan || !plan.length || cur() !== t) return;
    const spec = plan.map((x) => ({ src: pathOf(items[x.index]), name: x.name }));
    startOp({ op: 'rename', items: spec }, {
      label: `Renaming ${M.plural(spec.length, 'item')}`,
      after: (ev) => {
        if (cur() !== t) return;
        const keys = (ev.results || []).filter((x) => x && x.ok !== false && x.dst).map((x) => M.baseName(x.dst));
        if (keys.length && !t.search) t.wantSel = { keys, until: Date.now() + 6000 };
      },
    });
  }
  function commitRename(it, name) {
    const why = M.validName(name);
    if (why) { toast(`"${it.n}" was not renamed: ${why}`, { kind: 'err' }); return; }
    const t = cur();
    const src = pathOf(it);
    startOp({ op: 'rename', items: [src], name }, {
      label: `Renaming "${it.n}"`,
      after: (ev) => {
        if (!ev.ok) return;
        const dst = ev.results && ev.results[0] && ev.results[0].dst;
        const nn = dst ? M.baseName(dst) : name;
        it.n = nn;
        delete it._k;
        if (it.p) it.p = M.joinPath(M.parentOf(it.p), nn);
        if (cur() === t) { arrange(t); list.selectKeys([MF.keyOf(it)]); }
      },
    });
  }
  function recycleSel() {
    const t = cur();
    if (t.kind === 'recycle') { purgeBin(false); return; }
    const items = selItems().filter((it) => pathOf(it) && !it.pin);
    if (!items.length) return;
    const first = t.index.get(MF.keyOf(items[0]));
    startOp({ op: 'recycle', items: items.map((it) => pathOf(it)) }, {
      label: `Moving ${M.plural(items.length, 'item')} to the Recycle Bin`,
      undoToast: (ev) => `Moved ${M.plural((ev.results || []).filter((x) => x && x.ok !== false).length || items.length, 'item')} to the Recycle Bin`,
      after: (ev) => { if (ev.ok && cur() === t) t.wantIdx = first; },
    });
  }
  async function deleteForGood() {
    const t = cur();
    if (t.kind === 'recycle') { purgeBin(false); return; }
    const items = selItems().filter((it) => pathOf(it) && !it.pin);
    if (!items.length) return;
    const ok = await MF.dialog.confirm({
      title: items.length === 1 ? `Delete "${items[0].n}" permanently?` : `Delete ${M.plural(items.length, 'item')} permanently?`,
      body: ['This skips the Recycle Bin. It cannot be undone.'], ok: 'Delete permanently', danger: true,
    });
    if (!ok) return;
    startOp({ op: 'delete', items: items.map((it) => pathOf(it)), confirmed: true }, { label: `Deleting ${M.plural(items.length, 'item')} permanently` });
  }
  async function clip(op) {
    const paths = selPaths();
    if (!paths.length) return;
    const r = await api('files.clip', { op, paths });
    if (!report(r, op === 'cut' ? 'Not cut' : 'Not copied')) return;
    if (r.note) toast(r.note, { kind: 'quiet' });
  }
  async function paste(dest) {
    const d = dest || cur().path;
    const r = await api('files.paste', { dest: d });
    if (r && r.ok === false) { toast(`Nothing was pasted: ${r.reason}`, { kind: r.reason === 'the clipboard has no files' ? 'quiet' : 'err' }); return; }
    track(r, r.op || 'copy', transferInfo(r.op || 'copy', (r && r.count) || (r && r.items || []).length || 1, d));
  }
  async function undo() {
    const r = await api('files.undo');
    if (!r || r.ok === false) { const why = (r && r.reason) || 'no answer'; toast(cap(why), { kind: why === 'nothing to undo' ? 'quiet' : 'err' }); return; }
    if (r.job) { S.ops.set(r.job, { op: 'undo', label: r.label || 'Undoing' }); if (!claimOpDone(r.job)) MF.progress.start(r.job, { label: r.label || 'Undoing' }); }
  }
  async function copyPath(paths) {
    const ps = paths || selPaths();
    if (!ps.length) { const t = cur(); if (!M.isVirtual(t.path)) ps.push(t.path); else return; }
    const r = await api('files.copypath', { paths: ps });
    if (!r || r.ok === false) { report(r, 'The path was not copied'); return; }
    toast(r.dryRun ? `test mode: the path was not put on the clipboard (${M.plural(ps.length, 'path')})` : ps.length === 1 ? 'Path copied' : `${M.plural(ps.length, 'path')} copied`, { kind: 'quiet' });
  }
  async function zipSel() {
    const items = selPaths();
    if (!items.length) return;
    const t = cur();
    const r = await api('files.zip', { items });
    track(r, 'zip', { label: `Compressing ${M.plural(items.length, 'item')}`, after: (ev) => { if (ev.ok && r.dest && cur() === t) t.wantSel = { keys: [M.baseName(r.dest)], until: Date.now() + 6000 }; } });
  }
  async function unzipSel() {
    const items = selItems();
    if (items.length !== 1) return;
    const t = cur();
    const r = await api('files.unzip', { path: pathOf(items[0]) });
    track(r, 'unzip', { label: `Extracting "${items[0].n}"`, after: (ev) => { if (r.dest && cur() === t) t.wantSel = { keys: [M.baseName(r.dest)], until: Date.now() + 6000 }; } });
  }
  async function pin(path, on) {
    const r = await api('files.pin', { path, on });
    if (!report(r, on ? 'Not pinned' : 'Not unpinned')) return;
    if (r.pins) { S.pins = r.pins; renderNav(); }
  }
  async function restoreBin(all) {
    const t = cur();
    const items = all ? t.items : selItems();
    if (!items.length) return;
    const r = await api('files.recycle', { op: 'restore', keys: items.map((it) => it.binKey) });
    track(r, 'restore', { label: `Restoring ${M.plural(items.length, 'item')}` });
  }
  async function purgeBin() {
    const items = selItems();
    if (!items.length) return;
    const ok = await MF.dialog.confirm({
      title: items.length === 1 ? `Delete "${items[0].n}" for good?` : `Delete ${M.plural(items.length, 'item')} for good?`,
      body: ['They leave the Recycle Bin and cannot be restored.'], ok: 'Delete permanently', danger: true,
    });
    if (!ok) return;
    const r = await api('files.recycle', { op: 'purge', keys: items.map((it) => it.binKey), confirmed: true });
    track(r, 'purge', { label: `Deleting ${M.plural(items.length, 'item')} for good` });
  }
  async function emptyBin() {
    const t = cur();
    const n = t.kind === 'recycle' ? (t.binCount != null ? t.binCount : t.items.length) : null;
    const ok = await MF.dialog.confirm({
      title: 'Empty the Recycle Bin?',
      body: [n != null ? `All ${M.plural(n, 'item')}${t.binBytes ? ` (${M.fmtSize(t.binBytes)})` : ''} will be deleted for good, from every drive.` : 'Everything in it will be deleted for good, from every drive.', 'This cannot be undone.'],
      ok: 'Empty the Recycle Bin', danger: true,
    });
    if (!ok) return;
    const r = await api('files.recycle', { op: 'empty', confirmed: true });
    track(r, 'empty', { label: 'Emptying the Recycle Bin' });
  }
  function openItem(it, how) {
    const t = cur();
    if (it.binKey) { S.folderProps = false; if (MF.side.mode !== 'props') MF.side.toggle('props'); else MF.side.update(); return; }
    const p = pathOf(it);
    if (!p) return;
    if (it.d) {
      if (how === 'tab') newTab(p, true);
      else if (how === 'window') api('files.newwindow', { path: p }).then((r) => report(r, 'No new window'));
      else go(t, p);
      return;
    }
    api('files.open', { path: p }).then((r) => report(r, `"${it.n}" did not open`));
  }
  function openSel(how) {
    const items = selItems();
    if (!items.length) return;
    const dirs = items.filter((it) => it.d);
    if (items.length === 1 || how) { for (const it of how ? items : [items[0]]) openItem(it, how); return; }
    if (dirs.length) newTab(pathOf(dirs[0]), false);
    for (const it of items.filter((x) => !x.d).slice(0, 15)) openItem(it);
  }
  function dragOut() {
    const paths = selPaths();
    if (!paths.length) return;
    api('files.drag', { paths }).then((r) => report(r, 'The drag did not start'));
  }

  /* ---- drag and drop IN ------------------------------------------------------------------------- */
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropEl = null;
  let dropClear = null;
  function dropTarget(e) {
    const t = cur();
    const ni = e.target.closest && e.target.closest('.ni');
    if (ni && ni._path) return { path: ni._path, el: ni, cls: 'drop' };
    const cell = e.target.closest && e.target.closest('.cell');
    if (cell && cell._it && cell._it.d && pathOf(cell._it) && !cell._it.binKey) return { path: pathOf(cell._it), el: cell, cls: 'drop' };
    if (t.kind === 'recycle') return { path: 'mantle:recycle', el: $('main'), cls: 'dropping' };
    if (t.kind === 'folder' && !t.error) return { path: t.path, el: $('main'), cls: 'dropping' };
    return null;
  }
  function setDropEl(target) {
    const next = target ? target.el : null;
    if (dropEl && (dropEl !== next || !target)) dropEl.classList.remove('drop', 'dropping');
    dropEl = next;
    if (next) next.classList.add(target.cls);
  }
  function onDragOver(e) {
    if (!hasFiles(e)) return;
    const target = dropTarget(e);
    if (!target) return;
    e.preventDefault();
    // Always report COPY to Windows: a source that sees "move" may delete its originals itself, before
    // our own move has read them. The real copy-or-move is decided by main (files.drop effect).
    e.dataTransfer.dropEffect = 'copy';
    setDropEl(target);
    clearTimeout(dropClear);
    dropClear = setTimeout(() => setDropEl(null), 150);
  }
  async function onDrop(e) {
    if (!hasFiles(e)) return;
    const target = dropTarget(e);
    setDropEl(null);
    if (!target) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => { try { return window.mantle.pathForFile(f); } catch (_) { return ''; } }).filter(Boolean);
    if (!paths.length) { toast('Only files and folders can be dropped here', { kind: 'err' }); return; }
    if (target.path === 'mantle:recycle') { startOp({ op: 'recycle', items: paths }, { label: `Moving ${M.plural(paths.length, 'item')} to the Recycle Bin` }); return; }
    if (M.isVirtual(target.path)) { toast(`${labelOf(target.path)} does not take files`, { kind: 'quiet' }); return; }
    const effect = e.ctrlKey ? 'copy' : e.shiftKey ? 'move' : 'auto';
    const r = await api('files.drop', { paths, dest: target.path, effect });
    if (r && r.ok === false) { toast(`Nothing was dropped: ${r.reason}`, { kind: 'err' }); return; }
    track(r, r.op || 'copy', transferInfo(r.op || (effect === 'move' ? 'move' : 'copy'), (r && r.count) || (r && r.items || paths).length, target.path));
  }

  /* ---- commands: one table for the command bar, the keyboard and the menus ------------------------ */
  const one = () => selItems().length === 1;
  const anyReal = () => selItems().some((it) => pathOf(it) && !it.pin);
  const CMD = {
    newfolder: { label: 'New folder', key: 'Ctrl+Shift+N', icon: I.newfolder, ok: canWriteHere, run: () => newItem('newfolder') },
    newfile: { label: 'New text document', icon: I.newfile, ok: canWriteHere, run: () => newItem('newfile') },
    cut: { label: 'Cut', key: 'Ctrl+X', icon: I.cut, ok: () => anyReal(), run: () => clip('cut') },
    copy: { label: 'Copy', key: 'Ctrl+C', icon: I.copy, ok: () => selPaths().length > 0, run: () => clip('copy') },
    paste: { label: 'Paste', key: 'Ctrl+V', icon: I.paste, ok: canWriteHere, run: () => paste() },
    rename: { label: 'Rename', key: 'F2', icon: I.rename, ok: () => anyReal() && cur().kind !== 'recycle' && (one() || !cur().search), run: renameSel },
    del: { label: 'Delete', key: 'Delete', icon: I.del, ok: () => (cur().kind === 'recycle' ? selItems().length > 0 : anyReal()), run: recycleSel },
    purge: { label: 'Delete permanently', key: 'Shift+Delete', icon: I.del, ok: () => anyReal(), run: deleteForGood },
    undo: { label: 'Undo', key: 'Ctrl+Z', icon: I.undo, ok: () => !!S.undoLabel, run: undo },
    copypath: { label: 'Copy path', key: 'Ctrl+Shift+C', icon: I.link, ok: () => true, run: () => copyPath() },
    zip: { label: 'Compress to ZIP file', icon: I.zip, ok: () => anyReal(), run: zipSel },
    unzip: { label: 'Extract all', icon: I.zip, ok: () => one() && M.extOf(selItems()[0].n, selItems()[0].d) === '.zip', run: unzipSel },
    selectall: { label: 'Select all', key: 'Ctrl+A', icon: I.selectall, ok: () => cur().shown.length > 0, run: () => list.selectAll() },
    refresh: { label: 'Refresh', key: 'F5', icon: I.refresh, ok: () => true, run: () => refresh() },
    preview: { label: 'Preview pane', key: 'Alt+P', icon: I.preview, ok: () => true, run: () => { MF.side.toggle('preview'); renderCmdbar(); } },
    props: { label: 'Properties', key: 'Alt+Enter', icon: I.props, ok: () => true, run: () => { S.folderProps = !selItems().length; if (MF.side.mode === 'props') MF.side.update(); else MF.side.toggle('props'); renderCmdbar(); } },
    restore: { label: 'Restore', icon: I.restore, ok: () => selItems().length > 0, run: () => restoreBin(false) },
    restoreall: { label: 'Restore all items', icon: I.restore, ok: () => cur().items.length > 0, run: () => restoreBin(true) },
    empty: { label: 'Empty Recycle Bin', icon: I.bin, ok: () => cur().kind !== 'recycle' || cur().items.length > 0, run: emptyBin },
    purgebin: { label: 'Delete permanently', icon: I.del, ok: () => selItems().length > 0, run: purgeBin },
    hidden: { label: 'Show hidden items', icon: I.hidden, ok: () => true, run: () => setOpt('showHidden', !S.options.showHidden) },
    invert: { label: 'Invert selection', icon: I.selectall, ok: () => cur().shown.length > 0, run: () => list.invert() },
    selectnone: { label: 'Select none', icon: I.x, ok: () => cur().sel.size > 0, run: () => list.clear() },
    terminal: { label: 'Open in Terminal', icon: I.terminal, ok: () => termPath() !== null, run: () => openTerminal(termPath()) },
    compact: { label: 'Compact view', icon: I.details, ok: () => true, run: () => setOpt('compact', !S.options.compact) },
    checkboxes: { label: 'Item check boxes', icon: I.selectall, ok: () => true, run: () => setOpt('checkboxes', !S.options.checkboxes) },
    clearfilter: { label: 'Clear filters', icon: I.x, ok: () => M.filterActive(cur().filter), run: () => setFilter(null) },
    exts: { label: 'Show file name extensions', icon: I.documents, ok: () => true, run: () => setOpt('showExtensions', !S.options.showExtensions) },
  };
  function runCmd(id) { const c = CMD[id]; if (c && c.ok()) c.run(); }
  /** Where 'Open in Terminal' opens: the one selected folder, else the folder on screen. */
  function termPath() {
    const t = cur();
    if (!t || t.kind !== 'folder') return null;
    const sel = selItems();
    if (sel.length === 1 && sel[0].d && pathOf(sel[0])) return pathOf(sel[0]);
    return t.search ? null : t.path;
  }
  function openTerminal(p) {
    if (!p) return;
    api('files.terminal', { path: p }).then((r) => report(r, 'The terminal did not open'));
  }
  /* ---- filters (kind / date modified / size), per tab; a new folder starts unfiltered ----------- */
  function setFilter(f) {
    const t = cur();
    if (!t || t.kind === 'place') return;
    t.filter = M.filterActive(f) ? f : null;
    arrange(t);
    renderCmdbar();
    renderFbar();
    renderStatus();
  }
  function filterItems() {
    const t = cur();
    const f = t.filter || { kind: [], date: null, size: null };
    const kinds = f.kind || [];
    const kindSub = M.KINDS.map(([k, label]) => ({ label, check: kinds.includes(k), act: () => setFilter(Object.assign({}, f, { kind: kinds.includes(k) ? kinds.filter((x) => x !== k) : kinds.concat([k]) })) }));
    const one = (list, key) => [{ label: 'Any', check: !f[key], act: () => setFilter(Object.assign({}, f, { [key]: null })) }, { sep: true }]
      .concat(list.map(([k, label]) => ({ label, check: f[key] === k, act: () => setFilter(Object.assign({}, f, { [key]: k })) })));
    return [
      { label: 'Kind', icon: I.documents, sub: kindSub },
      { label: 'Date modified', icon: I.sort, sub: one(M.DATE_FILTERS, 'date') },
      { label: 'Size', icon: I.drive, sub: one(M.SIZE_FILTERS, 'size') },
      { sep: true },
      { label: 'Search file contents too', check: !!S.options.searchContents, act: () => setContents(!S.options.searchContents) },
      { sep: true },
      menuCmd('clearfilter'),
    ];
  }
  async function setContents(on) {
    await setOpt('searchContents', !!on);
    const t = cur();
    if (t && t.search) startSearch(t.search.query);
    else renderFbar();
  }
  /** The strip under the command bar: while searching, where it looks; with a filter, what it hides. */
  function renderFbar() {
    const bar = $('fbar');
    const t = cur();
    if (!bar) return;
    bar.textContent = '';
    const on = t && t.kind !== 'place' && (t.search || M.filterActive(t.filter));
    bar.hidden = !on;
    if (!on) return;
    if (t.search) {
      bar.appendChild(el('span', 'fl', 'Search in'));
      const seg = el('div', 'seg sm');
      for (const [v, label] of [[false, 'File names'], [true, 'Names and contents']]) {
        const b = el('button', 'segb' + (!!S.options.searchContents === v ? ' on' : ''), label);
        b.type = 'button';
        b.addEventListener('click', () => { if (!!S.options.searchContents !== v) setContents(v); });
        seg.appendChild(b);
      }
      bar.appendChild(seg);
      if (t.search.contents) bar.appendChild(el('span', 'fnote', 'Reads text files, Word, Excel, PowerPoint and OpenDocument files itself: no Windows index needed.'));
      else if (S.options.searchContents && /[*?]/.test(t.search.query)) bar.appendChild(el('span', 'fnote', 'A * or ? search matches names only.'));
    }
    if (M.filterActive(t.filter)) {
      const chip = el('button', 'fchip');
      chip.type = 'button';
      chip.title = 'Clear the filter';
      chip.appendChild(el('span', null, M.filterWords(t.filter)));
      const x = el('span', 'fx');
      x.innerHTML = I.x;
      chip.appendChild(x);
      chip.addEventListener('click', () => setFilter(null));
      bar.appendChild(chip);
    }
  }
  function refresh() {
    const t = cur();
    if (t.search) { startSearch(t.search.query); return; }
    if (t.kind === 'folder' && (t.error || t.loading)) { go(t, t.path, { push: false }); return; }
    api('files.roots', { fresh: true }).then(applyRoots);
    relist(t);
  }
  async function setOpt(key, value) {
    const r = await api('files.setopt', { key, value });
    if (!report(r, 'Not changed')) return;
    if (r.options) applyOpts(r.options);
  }
  function applyOpts(o) {
    const had = S.options;
    S.options = Object.assign({}, S.options, o);
    if (had.showHidden !== S.options.showHidden) for (const t of S.tabs) arrange(t);
    if (had.showExtensions !== S.options.showExtensions) list.repaint();
    if (had.compact !== S.options.compact || had.checkboxes !== S.options.checkboxes) { const t = cur(); if (t && t.kind !== 'place') list.setTab(t, true); }
    renderCmdbar();
    renderFbar();
  }

  /* ---- the command bar ------------------------------------------------------------------------ */
  function cmdBtn(id, labelled, extra) {
    const c = CMD[id];
    const b = el('button', 'cmd');
    b.type = 'button';
    b.dataset.cmd = id;
    b.title = c.key ? `${c.label} (${c.key})` : c.label;
    b.innerHTML = c.icon;
    if (labelled) b.appendChild(el('span', 'lb', c.label));
    b.addEventListener('click', () => runCmd(id));
    if (extra) extra(b);
    return b;
  }
  function dropBtn(label, icon, items) {
    const b = el('button', 'cmd');
    b.type = 'button';
    b.innerHTML = icon;
    b.appendChild(el('span', 'lb', label));
    const dd = el('span', 'dd');
    dd.innerHTML = I.chevDown;
    b.appendChild(dd);
    b.title = label;
    b.addEventListener('click', () => { const r = b.getBoundingClientRect(); MF.menu.open(items(), r.left, r.bottom + 2); });
    return b;
  }
  function renderCmdbar() {
    const bar = $('cmdbar');
    const t = cur();
    bar.textContent = '';
    if (!t) return;
    const sep = () => bar.appendChild(el('span', 'vsep'));
    if (t.kind === 'recycle') {
      bar.appendChild(cmdBtn('empty', true, (b) => b.classList.add('warn')));
      bar.appendChild(cmdBtn('restore', true));
      bar.appendChild(cmdBtn('restoreall', true));
      bar.appendChild(cmdBtn('purgebin', false));
      sep();
    } else if (t.kind === 'place') {
      bar.appendChild(el('span', 'lb pnote', t.path === 'mantle:thispc' ? 'Drives and folders on this PC' : 'Network locations'));
    } else {
      bar.appendChild(dropBtn('New', I.plus, () => [
        { label: 'Folder', icon: I.newfolder, key: 'Ctrl+Shift+N', disabled: !canWriteHere(), act: () => newItem('newfolder') },
        { label: 'Text document', icon: I.newfile, disabled: !canWriteHere(), act: () => newItem('newfile') },
      ]));
      sep();
      for (const id of ['cut', 'copy', 'paste', 'rename', 'del']) bar.appendChild(cmdBtn(id, false));
      sep();
    }
    if (t.kind !== 'place') {
      bar.appendChild(dropBtn('Sort', I.sort, () => sortItems().concat([{ sep: true }, { label: 'Group by', icon: I.group, sub: groupItems() }])));
      bar.appendChild(dropBtn('View', I.view, () => viewItems().concat([{ sep: true }, { label: 'Compact view', check: !!S.options.compact, act: () => runCmd('compact') },
        { label: 'Item check boxes', check: !!S.options.checkboxes, act: () => runCmd('checkboxes') }, { sep: true }, { label: 'Show hidden items', check: S.options.showHidden, act: () => runCmd('hidden') },
        { label: 'Show file name extensions', check: S.options.showExtensions, act: () => runCmd('exts') }])));
      const fb = dropBtn(M.filterActive(t.filter) ? 'Filtered' : 'Filter', I.filter, filterItems);
      if (M.filterActive(t.filter)) fb.classList.add('on');
      bar.appendChild(fb);
      sep();
      const more = el('button', 'cmd');
      more.type = 'button';
      more.title = 'More';
      more.setAttribute('aria-label', 'More commands');
      more.innerHTML = I.more;
      more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        const items = [];
        if (t.kind !== 'recycle') items.push(menuCmd('undo', S.undoLabel ? { label: `Undo: ${S.undoLabel}` } : null), { sep: true }, menuCmd('selectall'), menuCmd('invert'), menuCmd('selectnone'), { sep: true }, menuCmd('copypath'), menuCmd('zip'), menuCmd('unzip'), menuCmd('terminal'), { sep: true }, menuCmd('purge', { warn: true }));
        else items.push(menuCmd('selectall'), menuCmd('invert'), menuCmd('selectnone'));
        items.push({ sep: true }, menuCmd('refresh'));
        MF.menu.open(items, r.left, r.bottom + 2);
      });
      bar.appendChild(more);
    }
    bar.appendChild(el('span', 'grow'));
    if (t.kind !== 'recycle' && t.kind !== 'place') bar.appendChild(cmdBtn('undo', false, (b) => { b.title = S.undoLabel ? `Undo: ${S.undoLabel} (Ctrl+Z)` : 'Nothing to undo'; }));
    bar.appendChild(cmdBtn('preview', true, (b) => b.classList.toggle('on', MF.side.mode === 'preview')));
    bar.appendChild(cmdBtn('props', true, (b) => b.classList.toggle('on', MF.side.mode === 'props')));
    updateCmdbar();
  }
  function updateCmdbar() {
    for (const b of $('cmdbar').querySelectorAll('[data-cmd]')) { const c = CMD[b.dataset.cmd]; b.disabled = !c.ok(); }
    const t = cur();
    $('back').disabled = !t || !t.hist.length;
    $('fwd').disabled = !t || !t.fwd.length;
    $('up').disabled = !t || (!t.parent && !t.search && (M.isVirtual(t.path) || !t.path));
  }
  function menuCmd(id, over) {
    const c = CMD[id];
    return Object.assign({ label: c.label, icon: c.icon, key: c.key, disabled: !c.ok(), act: c.run }, over || {});
  }

  /* ---- context menus ------------------------------------------------------------------------------ */
  const HIDE_VERBS = new Set(['open', 'cut', 'copy', 'paste', 'delete', 'rename', 'properties', 'link', 'copyaspath', 'pintohome']);
  function shellVerbs(paths) {
    return async () => {
      const r = await api('files.verbs', { paths });
      if (!r || r.ok === false) throw new Error((r && r.reason) || 'no answer from Mantle');
      const map = (list) => (list || []).filter((v) => !HIDE_VERBS.has(String(v.verb || '').toLowerCase())).map((v) => (v.sub && v.sub.length
        ? { label: v.label, sub: map(v.sub) }
        : { label: v.label, act: () => api('files.verb', { token: r.token, cmd: v.cmd }).then((x) => report(x, `"${v.label}" did not run`)) }));
      const out = map(r.verbs);
      return out.length ? out : [{ note: 'Windows offers nothing else for this' }];
    };
  }
  function openWith(path) {
    return async () => {
      const r = await api('files.handlers', { path });
      if (!r || r.ok === false) throw new Error((r && r.reason) || 'no answer from Mantle');
      const icon = (s) => (!s ? null : /^(data:|file:)/.test(s) ? s : 'data:image/png;base64,' + s);
      const out = (r.handlers || []).map((h) => ({ label: h.name, img: icon(h.icon), act: () => api('files.openwith', { path, handler: h.handler }).then((x) => report(x, `${h.name} did not open it`)) }));
      if (!out.length) out.push({ note: 'Windows lists no apps for this kind of file' });
      out.push({ sep: true }, { label: 'Choose another app', act: () => api('files.openwithdialog', { path }).then((x) => report(x, "Windows' Open with did not open")) });
      return out;
    };
  }
  function itemMenu(x, y) {
    const t = cur();
    const items = selItems();
    if (!items.length) return;
    const it = items[0];
    const single = items.length === 1;
    const out = [];
    if (t.kind === 'recycle') {
      out.push(menuCmd('restore'), menuCmd('purgebin', { warn: true }), { sep: true }, menuCmd('props'));
      MF.menu.open(out, x, y);
      return;
    }
    const p = pathOf(it);
    out.push({ label: 'Open', key: 'Enter', icon: it.d ? I.folder : I.openwith, act: () => openSel() });
    if (it.d && single) {
      out.push({ label: 'Open in new tab', icon: I.newtab, act: () => openItem(it, 'tab') }, { label: 'Open in new window', icon: I.newwin, act: () => openItem(it, 'window') });
      if (p) out.push({ label: 'Open in Terminal', icon: I.terminal, act: () => openTerminal(p) });
    }
    if (!it.d && single && p) out.push({ label: 'Open with', icon: I.openwith, sub: openWith(p) });
    if (t.search || t.kind === 'home') out.push({ label: 'Open file location', icon: I.folder, act: () => { const loc = M.parentOf(p); if (loc) go(t, loc, { select: [it.n] }); } });
    out.push({ sep: true }, menuCmd('cut'), menuCmd('copy'));
    if (it.d && single && canWriteHere()) out.push({ label: 'Paste into this folder', icon: I.paste, act: () => paste(p) });
    out.push(menuCmd('copypath'), { sep: true }, menuCmd('rename'), menuCmd('del'), { sep: true }, menuCmd('zip'));
    if (single && M.extOf(it.n, it.d) === '.zip') out.push(menuCmd('unzip'));
    if (it.d && single && p) {
      const pinned = S.pins.some((x) => M.samePath(x.path, p));
      out.push({ label: pinned ? 'Unpin from Home' : 'Pin to Home', icon: I.pin, act: () => pin(p, !pinned) });
    }
    const paths = items.map((x) => pathOf(x)).filter(Boolean);
    if (paths.length) out.push({ sep: true }, { label: 'More', icon: I.more, sub: shellVerbs(paths) });
    out.push({ sep: true }, menuCmd('props', { act: () => { S.folderProps = false; if (MF.side.mode !== 'props') MF.side.toggle('props'); else MF.side.update(); renderCmdbar(); } }));
    MF.menu.open(out, x, y);
  }
  function backgroundMenu(x, y) {
    const t = cur();
    const out = [
      { label: 'View', icon: I.view, sub: viewItems() },
      { label: 'Sort by', icon: I.sort, sub: sortItems() },
      { label: 'Group by', icon: I.group, sub: groupItems() },
      { sep: true },
    ];
    if (t.kind === 'recycle') out.push(menuCmd('empty', { warn: true }), menuCmd('restoreall'), { sep: true }, menuCmd('refresh'));
    else {
      out.push({ label: 'New', icon: I.plus, disabled: !canWriteHere(), sub: [menuCmd('newfolder', { label: 'Folder' }), menuCmd('newfile', { label: 'Text document' })] });
      out.push(menuCmd('paste'), menuCmd('undo', S.undoLabel ? { label: `Undo: ${S.undoLabel}` } : null), menuCmd('refresh'), { sep: true });
      out.push({ label: 'Show hidden items', check: S.options.showHidden, act: () => runCmd('hidden') }, { label: 'Show file name extensions', check: S.options.showExtensions, act: () => runCmd('exts') });
      if (!M.isVirtual(t.path)) {
        const pinned = S.pins.some((p) => M.samePath(p.path, t.path));
        out.push({ sep: true }, { label: 'Open in Terminal', icon: I.terminal, disabled: !!t.search, act: () => openTerminal(t.path) });
        out.push({ label: pinned ? 'Unpin from Home' : 'Pin to Home', icon: I.pin, act: () => pin(t.path, !pinned) }, { label: 'Copy path', icon: I.link, act: () => copyPath([t.path]) });
        out.push({ label: 'Properties', icon: I.props, key: 'Alt+Enter', act: () => { list.clear(); S.folderProps = true; if (MF.side.mode !== 'props') MF.side.toggle('props'); else MF.side.update(); renderCmdbar(); } });
      }
    }
    MF.menu.open(out, x, y);
  }
  function placeMenu(x, y, path) {
    const pinned = S.pins.some((p) => M.samePath(p.path, path));
    MF.menu.open([
      { label: 'Open', icon: I.folder, act: () => go(cur(), path) },
      { label: 'Open in new tab', icon: I.newtab, act: () => newTab(path, true) },
      { label: 'Open in new window', icon: I.newwin, act: () => api('files.newwindow', { path }).then((r) => report(r, 'No new window')) },
      { sep: true },
      { label: pinned ? 'Unpin from Home' : 'Pin to Home', icon: I.pin, disabled: M.isVirtual(path), act: () => pin(path, !pinned) },
      { label: 'Copy path', icon: I.link, disabled: M.isVirtual(path), act: () => copyPath([path]) },
    ], x, y);
  }

  /* ---- nav pane --------------------------------------------------------------------------------- */
  function applyRoots(r) {
    if (!r || r.ok === false) { toast(`Drives and folders could not be listed: ${(r && r.reason) || 'no answer'}`, { kind: 'err' }); if (r && r.pins) S.pins = r.pins; renderNav(); return; }
    S.roots = r;
    S.known = {};
    for (const k of r.known || []) S.known[k.key] = k.path;
    // the known folders can land after the first listing: a tab already inside OneDrive gets its Status column now
    for (const t of S.tabs) {
      if (t.kind !== 'folder' || t.search) continue;
      const c = isCloud(t.path);
      if (c === !!t.cloud) continue;
      t.cloud = c;
      t.colset = c ? 'cloud' : 'folder';
      if (t.view) delete t.view.colsParsed;
      if (t === cur()) list.setTab(t, true);
    }
    for (const d of r.drives || []) { const k = d.path.toLowerCase(); if (!S.names[k]) S.names[k] = `${d.label || (d.type === 'removable' ? 'USB drive' : 'Local Disk')} (${d.path.slice(0, 2)})`; }
    for (const [k, label] of KNOWN) if (S.known[k] && !S.names[S.known[k].toLowerCase()]) S.names[S.known[k].toLowerCase()] = label;
    if (r.pins) S.pins = r.pins;
    renderNav();
  }
  function navBtn(path, label, icon, cls) {
    const b = el('button', 'ni' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b._path = path;
    b.innerHTML = icon || I.folder;
    b.appendChild(el('span', 'nl', label));
    b.title = M.isVirtual(path) ? label : path;
    b.addEventListener('click', () => go(cur(), path));
    b.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); newTab(path, true); } });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); placeMenu(e.clientX, e.clientY, path); });
    return b;
  }
  function freeBar(d) {
    const bar = el('div', 'dbar');
    const i = el('i');
    const used = d.total > 0 ? 1 - d.free / d.total : 0;
    i.style.width = Math.round(used * 100) + '%';
    if (d.total > 0 && d.free / d.total < 0.1) bar.classList.add('low');
    bar.appendChild(i);
    return bar;
  }
  function renderNav() {
    const box = $('navpane');
    box.textContent = '';
    box.appendChild(navBtn('mantle:home', 'Home', I.home));
    for (const p of S.pins) box.appendChild(navBtn(p.path, p.label || M.baseName(p.path), I.pin, 'sub' + (p.missing ? ' missing' : '')));
    box.appendChild(el('div', 'nsep'));
    let any = false;
    for (const [k, label] of KNOWN) if (S.known[k]) { box.appendChild(navBtn(S.known[k], label, I[k] || I.folder)); any = true; }
    if (any) box.appendChild(el('div', 'nsep'));
    const pc = navBtn('mantle:thispc', 'This PC', I.pc);
    const tw = el('span', 'ntw');
    tw.innerHTML = S.navThisPc ? I.chevDown : I.chev;
    tw.title = S.navThisPc ? 'Hide drives' : 'Show drives';
    tw.addEventListener('click', (e) => { e.stopPropagation(); S.navThisPc = !S.navThisPc; renderNav(); });
    pc.insertBefore(tw, pc.firstChild);
    box.appendChild(pc);
    if (S.navThisPc) {
      for (const d of (S.roots && S.roots.drives) || []) {
        const label = S.names[d.path.toLowerCase()] || d.path;
        const b = navBtn(d.path, label, d.type === 'removable' ? I.usb : d.type === 'network' ? I.network : I.drive, 'sub drive' + (d.ready === false ? ' missing' : ''));
        const lab = b.querySelector('.nl');
        const dv = el('span', 'dv');
        b.replaceChild(dv, lab);
        dv.appendChild(lab);
        if (d.ready !== false && d.total > 0) dv.appendChild(freeBar(d));
        b.title = d.ready === false ? `${label}: ${d.why || 'not ready'}` : `${label}: ${M.fmtSize(d.free)} free of ${M.fmtSize(d.total)}`;
        box.appendChild(b);
      }
    }
    box.appendChild(navBtn('mantle:recycle', 'Recycle Bin', I.bin));
    box.appendChild(navBtn('mantle:network', 'Network', I.network));
    for (const n of (S.roots && S.roots.network) || []) box.appendChild(navBtn(n.path, n.label, I.network, 'sub'));
    markNav();
  }
  function markNav() {
    const t = cur();
    for (const b of $('navpane').querySelectorAll('.ni')) b.classList.toggle('on', !!t && M.samePath(b._path, t.path) && !t.search);
  }

  /* ---- address bar ------------------------------------------------------------------------------ */
  function renderCrumbs() {
    const t = cur();
    const box = $('crumbs');
    box.textContent = '';
    const ic = el('span', 'cicon');
    ic.innerHTML = I[VIRTUAL_ICON[t.path]] || I.folder;
    box.appendChild(ic);
    const crumbs = t.crumbs || [];
    crumbs.forEach((c, i) => {
      if (i) { const s = el('span', 'csep'); s.innerHTML = I.chev; box.appendChild(s); }
      const b = el('button', 'crumb' + (i === crumbs.length - 1 && !t.search ? ' cur' : ''), c.label);
      b.type = 'button';
      b.title = M.isVirtual(c.path) ? c.label : c.path;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (t.search && i === crumbs.length - 1) endSearch(t); else if (!M.samePath(c.path, t.path)) go(t, c.path); });
      b.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); newTab(c.path, true); } });
      box.appendChild(b);
    });
    if (t.search) {
      const s = el('span', 'csep'); s.innerHTML = I.chev; box.appendChild(s);
      box.appendChild(el('span', 'crumb cur', `Search results for "${t.search.query}"`));
    }
    box.scrollLeft = box.scrollWidth;                      // a deep path keeps its LAST folders in view
  }
  function editAddress() {
    const t = cur();
    const inp = $('addrinput');
    $('address').classList.add('editing');
    $('crumbs').hidden = true;
    inp.hidden = false;
    inp.value = M.isVirtual(t.path) ? labelOf(t.path) : t.path;
    inp.focus();
    inp.select();
  }
  function endAddress() {
    $('address').classList.remove('editing');
    $('crumbs').hidden = false;
    $('addrinput').hidden = true;
  }
  function submitAddress() {
    const t = cur();
    const r = M.resolveTyped($('addrinput').value, { cwd: t.path, home: S.home, known: S.known });
    if (!r.ok) { toast(cap(r.reason), { kind: 'err' }); return; }
    endAddress();
    list.sc.focus({ preventScroll: true });
    go(t, r.path);
  }

  /* ---- This PC / Network ------------------------------------------------------------------------ */
  function renderPlace() {
    const t = cur();
    const box = $('place');
    box.textContent = '';
    const pl = t.place;
    if (!pl) { if (t.loading) box.appendChild(el('div', 'pnote', 'Reading drives…')); return; }
    const tile = (path, name, sub, icon, extra) => {
      const b = el('button', 'ptile' + (M.samePath(S.placeSel, path) ? ' sel' : ''));
      b.type = 'button';
      b.innerHTML = icon;
      const v = el('span', 'pv');
      v.appendChild(el('span', 'pn', name));
      if (extra) v.appendChild(extra);
      if (sub) v.appendChild(el('span', 'ps', sub));
      b.appendChild(v);
      b.title = path;
      b.addEventListener('click', () => { S.placeSel = path; for (const x of box.querySelectorAll('.ptile')) x.classList.toggle('sel', x === b); });
      b.addEventListener('dblclick', () => go(t, path));
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); go(t, path); } });
      b.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); newTab(path, true); } });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); S.placeSel = path; placeMenu(e.clientX, e.clientY, path); });
      return b;
    };
    if (t.path === 'mantle:thispc') {
      const known = (pl.known || []).filter((k) => KNOWN.some(([key]) => key === k.key));
      if (known.length) {
        box.appendChild(el('div', 'ptitle', 'Folders'));
        const g = el('div', 'pgrid');
        for (const k of known) g.appendChild(tile(k.path, KNOWN.find(([key]) => key === k.key)[1], k.path, I[k.key] || I.folder));
        box.appendChild(g);
      }
      box.appendChild(el('div', 'ptitle', 'Devices and drives'));
      const g = el('div', 'pgrid');
      for (const d of pl.drives || []) {
        const name = S.names[d.path.toLowerCase()] || d.path;
        const bar = d.ready !== false && d.total > 0 ? (() => { const b = el('div', 'pbar'); const i = el('i'); i.style.width = Math.round((1 - d.free / d.total) * 100) + '%'; if (d.free / d.total < 0.1) b.classList.add('low'); b.appendChild(i); return b; })() : null;
        const sub = d.ready === false ? `Not ready: ${d.why || 'no answer'}` : d.total > 0 ? `${M.fmtSize(d.free)} free of ${M.fmtSize(d.total)}${d.fs ? ' · ' + d.fs : ''}` : d.fs || '';
        const b = tile(d.path, name, sub, d.type === 'removable' ? I.usb : d.type === 'network' ? I.network : I.drive, bar);
        if (d.ready === false) b.classList.add('off');
        g.appendChild(b);
      }
      if (!(pl.drives || []).length) box.appendChild(el('div', 'pnote', 'No drives were listed.'));
      box.appendChild(g);
      if ((pl.network || []).length) {
        box.appendChild(el('div', 'ptitle', 'Network locations'));
        const n = el('div', 'pgrid');
        for (const x of pl.network) n.appendChild(tile(x.path, x.label, x.path, I.network));
        box.appendChild(n);
      }
    } else {
      box.appendChild(el('div', 'ptitle', 'Network locations'));
      if ((pl.network || []).length) {
        const n = el('div', 'pgrid');
        for (const x of pl.network) n.appendChild(tile(x.path, x.label, x.path, I.network));
        box.appendChild(n);
      } else box.appendChild(el('div', 'pnote', 'No network shortcuts yet.'));
      box.appendChild(el('div', 'pnote', 'To open a shared folder, type its address in the address bar, like \\\\server\\share (Ctrl+L).'));
    }
  }

  /* ---- the rest of the chrome ---------------------------------------------------------------------- */
  function renderBanner() {
    const t = cur();
    const b = $('banner');
    b.textContent = '';
    b.className = 'banner';
    let text = null;
    let quiet = false;
    let retry = false;
    if (t.error) { text = t.error; retry = true; }
    else if (t.search) {
      const s = t.search;
      quiet = true;
      if (s.error) { text = `The search did not run: ${s.error}`; quiet = false; }
      else if (!s.done) text = `Searching "${s.query}" in ${labelOf(t.path)} and its subfolders… ${M.plural(s.items.length, 'result')} so far`;
      else {
        const parts = [`${M.plural(s.items.length, 'result')} for "${s.query}" in ${labelOf(t.path)} and its subfolders`];
        if (s.capped) parts.push(`stopped at ${M.fmtCount(s.items.length)}: type more to narrow it`);
        if (s.denied) parts.push(`${M.plural(s.denied, 'folder')} could not be read`);
        text = parts.join(' · ');
      }
    } else if (t.kind === 'home' && t.watchWhy) { text = t.watchWhy; quiet = true; }
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    if (quiet) b.classList.add('quiet');
    else b.insertAdjacentHTML('beforeend', I.warn);                // a problem: the warn glyph before its words
    b.appendChild(el('span', null, text));
    if (retry) {
      b.appendChild(el('span', 'grow'));
      const r = el('button', null, 'Try again');
      r.type = 'button';
      r.addEventListener('click', () => go(t, t.path, { push: false }));
      b.appendChild(r);
    }
  }
  function renderEmpty() {
    const t = cur();
    const e = $('empty');
    let text = null;
    if (t.kind !== 'place' && !t.loading && !t.error && !t.shown.length) {
      if (t.search) text = t.search.done ? `Nothing named like "${t.search.query}" here or in its subfolders.` : null;
      else if (t.kind === 'recycle') text = 'The Recycle Bin is empty.';
      else if (t.kind === 'home') text = 'Pin folders here from their right-click menu. Files you open show up here too.';
      else if (t.items.length) text = `This folder has only hidden items (${M.fmtCount(t.items.length)}). View > Show hidden items shows them.`;
      else text = 'This folder is empty.';
    }
    e.hidden = !text;
    e.textContent = text || '';
  }
  function renderStatus() {
    const t = cur();
    if (!t) return;
    const src = t.search ? t.search.items : t.items;
    let count;
    if (t.kind === 'place') count = t.place ? M.plural((t.place.drives || []).length, 'drive') : '';
    else if (t.loading || (t.search && !t.search.done)) count = `${M.fmtCount(src.length)} items so far`;
    else {
      count = M.plural(t.shown.length, 'item');
      const hid = src.length - t.shown.length;
      if (hid > 0) count += M.filterActive(t.filter) ? ` (${M.fmtCount(hid)} filtered out)` : ` (${M.fmtCount(hid)} hidden)`;
      if (t.search && t.search.contents && t.search.done && t.search.skipped) count += ` · ${M.plural(t.search.skipped, 'file')} not read (binary or over 8 MB)`;
      if (t.kind === 'recycle' && t.binBytes) count += ` · ${M.fmtSize(t.binBytes)}`;
    }
    $('stcount').textContent = count;
    const sel = t.sel.size ? selItems(t) : [];
    if (sel.length) {
      const s = M.summarize(sel);
      $('stsel').textContent = `${M.plural(sel.length, 'item')} selected${s.files ? ' · ' + M.fmtSize(s.bytes) : ''}`;
    } else $('stsel').textContent = '';
    const note = t.watchWhy && t.kind === 'folder' ? t.watchWhy : S.test ? `Test mode${S.sandbox ? ': writes only inside the test sandbox' : ': writes are refused'}` : '';
    $('stnote').textContent = note;
    $('stnote').title = note;
    const loading = t.loading || (t.search && !t.search.done && !t.search.error);
    $('stload').hidden = !loading;
    $('stload').textContent = loading ? 'Loading…' : '';
    $('vdetails').classList.toggle('on', t.view && t.view.view === 'details');
    $('vgrid').classList.toggle('on', t.view && t.view.view === 'grid');
  }
  /** Show the active tab: which surface, chrome, list. */
  function showTab() {
    const t = cur();
    if (!t) return;
    const place = t.kind === 'place';
    $('scroller').hidden = place;
    $('place').hidden = !place;
    if (place) { $('colhead').hidden = true; renderPlace(); } else list.setTab(t, false);
    $('search').value = t.search ? t.search.query : '';
    $('search').placeholder = t.kind === 'folder' ? `Search ${labelOf(t.path)}` : 'Search';
    $('searchbox').classList.toggle('on', !!t.search);
    $('searchclear').hidden = !t.search && !$('search').value;
    renderCrumbs();
    renderBanner();
    renderEmpty();
    renderCmdbar();
    renderFbar();
    renderStatus();
    markNav();
    if (MF.side.mode) MF.side.update();
  }

  /* ---- the list's host -------------------------------------------------------------------------- */
  let sideTimer = null;
  const host = {
    nameOf, iconOf, thumbOf, colText, sortBy, columnMenu,
    isCut: (it) => { if (!S.cut.size) return false; const p = pathOf(it); return !!p && S.cut.has(p.toLowerCase()); },
    showExt: () => S.options.showExtensions,
    opt: (k) => !!S.options[k],
    zoom: (d) => {
      const t = cur();
      if (!t || t.kind === 'place') return;
      const steps = [{ view: 'details' }, { view: 'list' }, { view: 'grid', size: 'small' }, { view: 'grid', size: 'medium' }, { view: 'grid', size: 'large' }];
      const at = steps.findIndex((x) => x.view === t.view.view && (!x.size || x.size === t.view.size));
      const next = steps[Math.max(0, Math.min(steps.length - 1, (at < 0 ? 0 : at) + d))];
      if (next.view !== t.view.view || next.size !== (t.view.view === 'grid' ? t.view.size : undefined)) setView(next);
    },
    colsChanged: (cols) => { const t = cur(); t.view.cols = M.encodeCols(cols); saveView(t); },
    contextMenu: (x, y, onItem) => { if (onItem) itemMenu(x, y); else backgroundMenu(x, y); },
    open: (i) => { const t = cur(); const it = t.shown[i]; if (it) openItem(it); },
    middle: (i) => { const t = cur(); const it = t.shown[i]; if (it && it.d && pathOf(it)) newTab(pathOf(it), true); },
    mouseNav: (d) => (d < 0 ? back() : forward()),
    dragOut,
    selChanged: () => {
      S.folderProps = false;
      renderStatus();
      updateCmdbar();
      if (MF.side.mode) { clearTimeout(sideTimer); sideTimer = setTimeout(() => MF.side.update(), 120); }
    },
    painted: () => {
      const t = cur();
      if (!t || t.painted || !t.shown.length) return;
      t.painted = true;
      const run = t.run;
      if (run && run.first == null) afterPaint(() => { if (run.first == null) run.first = performance.now() - run.t0; });
    },
  };
  const list = new MF.List(host);
  list.frameCb = () => { const t = cur(); if (t && t.view.view === 'grid' && S.thumbWant.size) { clearTimeout(S.thumbTimer); S.thumbTimer = setTimeout(pumpThumbs, 60); } };
  MF.side.init({
    api, w: WKEY, nameOf, typeOf, iconOf, tab: cur,
    pathOf: (it) => (it.binKey ? null : pathOf(it)),
    driveOf: (p) => (p && M.isRoot(p) ? ((S.roots && S.roots.drives) || []).find((d) => M.samePath(M.normPath(d.path), M.normPath(p))) || null : null),
    selected: () => {
      const t = cur();
      if (S.folderProps && t && !M.isVirtual(t.path)) return [{ n: labelOf(t.path), d: 1, s: 0, m: 0, a: 16, p: t.path }];
      if (t && t.kind === 'place' && S.placeSel) return [{ n: labelOf(S.placeSel), d: 1, s: 0, m: 0, a: 16, p: S.placeSel }];
      return selItems();
    },
  });
  MF.progress.onCancel = (job) => api('files.cancel', { job }).then((r) => { if (r && r.ok === false) toast(`It could not be cancelled: ${r.reason}`, { kind: 'err' }); });

  /* ---- keyboard ---------------------------------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    if (MF.dialog.isOpen() || MF.menu.isOpen()) return;
    const k = e.key;
    const low = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const tgt = e.target;
    const typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA');
    const t = cur();
    if (!t) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    // window-wide, even while typing in the address or search box
    if (ctrl && !e.altKey) {
      if (low === 't') { stop(); newTab('mantle:home'); return; }
      if (low === 'w' || k === 'F4') { stop(); closeTab(S.active); return; }
      if (k === 'Tab') { stop(); activate((S.active + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length); return; }
      if (low === 'n' && !e.shiftKey) { stop(); api('files.newwindow', { path: t.path }).then((r) => report(r, 'No new window')); return; }
      if (low === 'l') { stop(); editAddress(); return; }
      if (low === 'f' || low === 'e') { stop(); $('search').focus(); $('search').select(); return; }
      if (low === 'r') { stop(); refresh(); return; }
    }
    if (e.altKey && !ctrl) {
      if (k === 'ArrowLeft') { stop(); back(); return; }
      if (k === 'ArrowRight') { stop(); forward(); return; }
      if (k === 'ArrowUp') { stop(); up(); return; }
      if (low === 'd') { stop(); editAddress(); return; }
      if (low === 'p' && e.shiftKey) { stop(); runCmd('props'); return; }
      if (low === 'p') { stop(); runCmd('preview'); return; }
      if (k === 'Enter') { stop(); runCmd('props'); return; }
    }
    if (k === 'F4' && !ctrl && !e.altKey) { stop(); editAddress(); return; }
    if (k === 'F3') { stop(); $('search').focus(); $('search').select(); return; }
    if (k === 'F5') { stop(); refresh(); return; }
    if (typing) return;
    if (k === 'Escape') {
      if (t.search) { stop(); endSearch(t); return; }
      if (t.sel.size) { stop(); list.clear(); return; }
      if (MF.side.mode) { stop(); MF.side.close(); renderCmdbar(); }
      return;
    }
    if (t.kind === 'place') {
      if (k === 'Backspace') { stop(); back(); }
      return;
    }
    if (k === 'Backspace') { stop(); back(); return; }
    if (k === 'Enter') { stop(); openSel(ctrl ? 'tab' : null); return; }
    if (k === 'F2') { stop(); runCmd('rename'); return; }
    if (k === 'Delete') { stop(); runCmd(e.shiftKey ? 'purge' : 'del'); return; }
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      stop();
      const i = list.focusIndex();
      const r = list.sc.getBoundingClientRect();
      if (i >= 0 && t.sel.size) { const p = list.xyOf(i); itemMenu(r.left + p.x + 40 - list.sc.scrollLeft, r.top + p.y - list.sc.scrollTop + 20); } else backgroundMenu(r.left + 40, r.top + 40);
      return;
    }
    if (ctrl && !e.altKey) {
      if (low === 'a') { stop(); list.selectAll(); return; }
      if (low === 'c' && e.shiftKey) { stop(); runCmd('copypath'); return; }
      if (low === 'c') { stop(); runCmd('copy'); return; }
      if (low === 'x') { stop(); runCmd('cut'); return; }
      if (low === 'v') { stop(); runCmd('paste'); return; }
      if (low === 'z') { stop(); runCmd('undo'); return; }
      if (low === 'n' && e.shiftKey) { stop(); runCmd('newfolder'); return; }
      if (e.shiftKey && /^Digit[2-6]$/.test(e.code)) {
        stop();
        const n = Number(e.code.slice(5));
        setView(n === 6 ? { view: 'details' } : n === 5 ? { view: 'list' } : { view: 'grid', size: n === 4 ? 'small' : n === 3 ? 'medium' : 'large' });
        return;
      }
    }
    if (list.key(e)) { stop(); return; }
    if (k.length === 1 && !ctrl && !e.altKey && k !== ' ') { stop(); list.typeAhead(k); }
  });
  // mouse buttons 4 and 5 (back / forward), anywhere in the window
  document.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); back(); } else if (e.button === 4) { e.preventDefault(); forward(); } });
  document.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });

  /* ---- wiring the static chrome -------------------------------------------------------------------- */
  function wire() {
    $('back').innerHTML = I.back;
    $('fwd').innerHTML = I.fwd;
    $('up').innerHTML = I.up;
    $('refresh').innerHTML = I.refresh;
    $('newtab').innerHTML = I.plus;
    $('sicon').innerHTML = I.search;
    $('searchclear').innerHTML = I.x;
    $('vdetails').innerHTML = I.details;
    $('vgrid').innerHTML = I.view;
    $('back').addEventListener('click', () => back());
    $('fwd').addEventListener('click', () => forward());
    $('up').addEventListener('click', up);
    $('refresh').addEventListener('click', refresh);
    $('newtab').addEventListener('click', () => newTab('mantle:home'));
    $('vdetails').addEventListener('click', () => setView({ view: 'details' }));
    $('vgrid').addEventListener('click', () => setView({ view: 'grid', size: cur().view.size === 'small' ? 'medium' : cur().view.size || 'medium' }));
    for (const b of document.querySelectorAll('.wc button')) b.addEventListener('click', () => api('files.win', { op: b.dataset.op }).then((r) => report(r, 'The window button did nothing')));
    $('address').addEventListener('click', (e) => { if (!e.target.closest('.crumb') && $('addrinput').hidden) editAddress(); });
    const inp = $('addrinput');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitAddress(); } else if (e.key === 'Escape') { e.preventDefault(); endAddress(); list.sc.focus({ preventScroll: true }); }
    });
    inp.addEventListener('blur', () => setTimeout(endAddress, 0));
    const sq = $('search');
    sq.addEventListener('input', () => { $('searchclear').hidden = !sq.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => startSearch(sq.value), 450); });
    sq.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); startSearch(sq.value); }
      else if (e.key === 'Escape') { e.preventDefault(); clearTimeout(searchTimer); sq.value = ''; $('searchclear').hidden = true; endSearch(cur()); list.sc.focus({ preventScroll: true }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list.sc.focus({ preventScroll: true }); if (cur().shown.length && !cur().sel.size) list.selectOnly(0); }
    });
    $('searchclear').addEventListener('click', () => { clearTimeout(searchTimer); sq.value = ''; $('searchclear').hidden = true; endSearch(cur()); });
    const main = $('main');
    for (const box of [main, $('navpane')]) { box.addEventListener('dragover', onDragOver); box.addEventListener('drop', onDrop); }
    // a stray drop anywhere else must not navigate the window to the file
    document.addEventListener('dragover', (e) => { if (hasFiles(e) && !e.defaultPrevented) e.dataTransfer.dropEffect = 'none'; });
    document.addEventListener('drop', (e) => e.preventDefault());
    $('place').addEventListener('contextmenu', (e) => { if (!e.target.closest('.ptile')) e.preventDefault(); });
    const setActive = (on) => document.documentElement.classList.toggle('inactive', !on);
    window.addEventListener('blur', () => setActive(false));
    window.addEventListener('focus', () => setActive(true));
    setActive(document.hasFocus());
  }

  /* ---- events from main ---------------------------------------------------------------------------- */
  function listen() {
    const on = (ev, fn) => window.mantle.on(ev, (p) => { try { fn(p || {}); } catch (e) { toast(`Mantle Files hit a bug handling ${ev}: ${e.message}`, { kind: 'err' }); } });
    on('files.items', onItems);
    on('files.found', onFound);
    on('files.size', (ev) => MF.side.onSize(ev));
    on('files.progress', (ev) => MF.progress.update(ev));
    on('files.opdone', onOpDone);
    opDoneFn = onOpDone;
    function onOpDone(ev) {
      // A fast op's opdone can overtake the files.op reply: hold it until track()/undo() claims the
      // job (claimOpDone), or 3 s, so the card is not started AFTER its end and never closed.
      if (ev && ev.job && !S.ops.has(ev.job) && !ev._late) {
        opEarly.set(ev.job, ev);
        setTimeout(() => { if (opEarly.delete(ev.job)) onOpDone(Object.assign({}, ev, { _late: true })); }, 3000);
        return;
      }
      const info = S.ops.get(ev.job) || { label: cap(M.opWords(ev.op)) };
      S.ops.delete(ev.job);
      MF.progress.end(ev.job);
      const results = ev.results || [];
      const fails = M.failLines(results);
      if (ev.aborted) toast(`${info.label}: cancelled${results.length ? ` after ${M.plural(results.filter((x) => x && x.ok !== false).length, 'item')}` : ''}`, { kind: 'quiet' });
      else if (!ev.ok) {
        const head = fails.length ? `${info.label}: ${M.fmtCount(fails.length)} of ${M.plural(results.length, 'item')} failed` : `${info.label} failed: ${ev.reason || (ev.hr ? `Windows error 0x${(ev.hr >>> 0).toString(16)}` : 'no reason was given')}`;
        toast(head, { kind: 'err', lines: fails });
      } else if (ev.wasUndo) toast(`Undone: ${info.label}`, { kind: 'quiet' });
      else if (info.undoToast && ev.undoable) toast(info.undoToast(ev), { kind: 'info', action: { label: 'Undo', fn: undo } });
      // search results do not refresh by themselves: drop what moved away, rename what was renamed
      const moved = new Set(results.filter((x) => x && x.ok !== false && x.src && ['recycle', 'delete', 'move'].includes(ev.op)).map((x) => x.src.toLowerCase()));
      if (moved.size) for (const t of S.tabs) if (t.search) { const n = t.search.items.length; t.search.items = t.search.items.filter((it) => !moved.has(String(it.p).toLowerCase())); if (t.search.items.length !== n) arrange(t); }
      if (info.after) { try { info.after(ev); } catch (e) { toast(`Mantle Files hit a bug after ${info.label}: ${e.message}`, { kind: 'err' }); } }
    }
    on('files.changed', (ev) => {
      const dirs = (ev.dirs || []).map((d) => String(d).toLowerCase());
      for (const t of S.tabs) if (t.path && dirs.includes(t.path.toLowerCase()) && (ev.tab == null || !ev.live || ev.tab === t.id)) relistSoon(t);
      if (dirs.some((d) => M.isRoot(d))) for (const t of S.tabs) if (t.kind === 'place') relistSoon(t);
    });
    on('files.undo', (ev) => { S.undoLabel = ev.label || null; renderCmdbar(); });
    on('files.opts', (ev) => { if (ev.options) applyOpts(ev.options); });
    on('files.nav', (ev) => { if (!ev.path) return; if (ev.newTab) newTab(ev.path); else go(cur(), ev.path); });
    on('files.pins', (ev) => { S.pins = ev.pins || []; renderNav(); for (const t of S.tabs) if (t.kind === 'home') relistSoon(t); });
    on('files.notice', (ev) => { if (ev.text) toast(ev.text, { kind: 'info' }); });
    on('files.clip', (ev) => { S.cut = ev.cut && ev.count ? new Set((ev.paths || []).map((p) => String(p).toLowerCase())) : new Set(); list.render(); });
  }

  /* ---- boot --------------------------------------------------------------------------------------- */
  async function boot() {
    wire();
    const t = tabObj();
    S.tabs = [t];
    S.active = 0;
    if (!window.mantle) {
      Object.assign(t, { path: 'mantle:home', kind: 'home', view: defaultView('home'), error: 'No bridge to Mantle: this page only works inside Mantle (or over file:// with mock-mantle.js).' });
      renderTabs();
      showTab();
      document.documentElement.dataset.ready = '1';
      return;
    }
    listen();
    const b = await api('files.boot');
    if (!b || b.ok === false) {
      Object.assign(t, { path: 'mantle:home', kind: 'home', view: defaultView('home'), error: `Mantle Files could not start: ${(b && b.reason) || 'no answer from Mantle'}` });
      renderTabs();
      showTab();
      document.documentElement.dataset.ready = '1';
      return;
    }
    S.home = b.home || null;
    S.test = !!b.test;
    S.sandbox = b.sandbox || null;
    S.names = Object.assign({}, b.names || {});
    S.pins = b.pins || [];
    S.undoLabel = b.undo ? b.undo.label : null;
    S.select = b.select || null;
    if (b.options) S.options = Object.assign({}, S.options, b.options);
    $('testchip').hidden = !S.test;
    if (b.notice) toast(b.notice, { kind: 'info' });
    wantTypes([{ n: 'x', d: 0 }]);
    api('files.types', { exts: ['folder'] }).then((r) => { if (r && r.types && r.types.folder) { S.types.folder = r.types.folder; list.repaint(); } });
    renderTabs();
    renderNav();
    api('files.roots').then(applyRoots);
    await go(t, b.path || 'mantle:home', { push: false });
    list.sc.focus({ preventScroll: true });
    document.documentElement.dataset.ready = '1';
  }

  MF.app = { S, cur, go, newTab, closeTab, activate, list, arrange, setView, sortBy, startSearch, endSearch, relist, itemMenu, backgroundMenu, runCmd, api, editAddress, selItems, back, up, setFilter, setContents, filterItems };
  boot();
}());
