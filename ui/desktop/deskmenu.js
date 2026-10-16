/*
 * deskmenu.js -- the desktop right-click menu, drawn by THIS page into a window it opens itself (lane
 * mantle-deskmenu, 2026-10-15; lib/features/deskmenu.js says why the desktop page hosts it: no new
 * renderer, nothing kept hidden for good).
 *
 *   'deskmenu.prepare'  a right-click on the empty desktop began: make the menu window if there is none
 *   'deskmenu.show'     {seq}: it ended. Draw the rows, tell main the size (deskmenu.place: main puts the
 *                       window at the click and shows it), then deskmenu.painted after its second frame.
 *   'deskmenu.key'      {seq, key}: up | down | home | end move the highlight, enter picks its row.
 *
 * The menu window is about:blank: it has no bridge of its own, so every row runs Mantle's command from
 * this page (window.mantle). A row that fails keeps the menu up with the reason in warning ink, and main
 * logs it (deskmenu.picked). Rows: Change wallpaper (Mantle Wallpapers), Display settings and Personalize
 * (Mantle Settings pages), the desktop widgets on/off, Mantle Settings.
 *
 * Desktop widgets on/off is this page's own switch (localStorage, so it survives a restart and an
 * Explorer restart's new layer): body.widgets-off hides every widget pane (deskmenu.css).
 */
(function () {
  'use strict';
  const M = window.mantle;
  if (!M || typeof M.on !== 'function' || typeof M.call !== 'function') return;
  const KEY = 'mantle.desktop.widgets';
  const NAME = 'mantle-deskmenu';
  const INSET = 20;                         // the clear margin around the panel: room for its whole shadow (deskmenu.css --dm-shadow)
  const CSS = ['../shared/tokens.css', '../shared/glass-light.css', 'deskmenu.css'].map((h) => new URL(h, location.href).href);
  // Segoe Fluent Icons glyphs (tokens.css --icon-font)
  const ICON = { wallpaper: '', display: '', personalize: '', widgets: '', settings: '' };

  let win = null;     // the menu window
  let ui = null;      // {doc, panel, ready}
  let seqNow = 0;

  function widgetsOn() { try { return localStorage.getItem(KEY) !== 'off'; } catch (_) { return true; } }
  function applyWidgets() { document.body.classList.toggle('widgets-off', !widgetsOn()); }
  applyWidgets();

  function toggleWidgets() {
    const on = !widgetsOn();
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {
      return { ok: false, reason: `the setting could not be saved (${e && e.message ? e.message : e})` };
    }
    applyWidgets();
    return { ok: true, on };
  }

  function rows() {
    const via = 'the desktop menu';
    return [
      { id: 'wallpaper', label: 'Change wallpaper', run: () => M.call('wallpaper.open') },
      { id: 'display', label: 'Display settings', run: () => M.call('settings.open', { section: 'display', via }) },
      { id: 'personalize', label: 'Personalize', run: () => M.call('settings.open', { section: 'personalization', via }) },
      { sep: true },
      { id: 'widgets', label: widgetsOn() ? 'Hide desktop widgets' : 'Show desktop widgets', run: toggleWidgets },
      { sep: true },
      { id: 'settings', label: 'Mantle Settings', run: () => M.call('settings.open', { via }) },
    ];
  }

  /** The menu window, made once and kept while main keeps it. -> true when it is there. */
  function ensure() {
    if (win && !win.closed && ui && ui.doc === win.document) return true;
    win = window.open('about:blank', NAME, 'popup');
    if (!win) { ui = null; return false; }
    const doc = win.document;
    doc.title = 'Mantle desktop menu';
    doc.documentElement.classList.add('dm-root');
    const loads = CSS.map((href) => new Promise((res) => {
      const l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = () => res(true);
      l.onerror = () => res(false);
      doc.head.appendChild(l);
    }));
    doc.body.className = 'dm-body';
    const panel = doc.createElement('div');
    panel.className = 'dm-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Desktop');
    doc.body.appendChild(panel);
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
    ui = { doc, panel, ready: Promise.all(loads) };
    return true;
  }

  /** The menu wears this page's theme (data-theme and the look's other attributes on <html>). */
  function syncTheme() {
    const from = document.documentElement, to = ui.doc.documentElement;
    for (const a of Array.from(from.attributes)) if (a.name !== 'class' && to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
    for (const a of Array.from(to.attributes)) if (a.name !== 'class' && !from.hasAttribute(a.name)) to.removeAttribute(a.name);
  }

  /** THE HIGHLIGHT: one row at most, moved by the mouse and by the menu keys alike (as in Windows' own
      menus: the keys go on from the row the mouse is on, and moving the mouse takes the highlight back). */
  function setSel(i) {
    if (!ui || !ui.items) return;
    const n = ui.items.length;
    const next = (Number.isInteger(i) && i >= 0 && i < n) ? i : -1;
    ui.items.forEach((it, k) => it.el.classList.toggle('sel', k === next));
    ui.sel = next;
    if (next >= 0) ui.panel.setAttribute('aria-activedescendant', ui.items[next].el.id);
    else ui.panel.removeAttribute('aria-activedescendant');
  }

  /** PURE: the row a menu key moves the highlight to. sel = -1 (none) .. n-1. Down from none is the first
      row and Up from none the last; both wrap; Home and End are the ends. */
  function step(sel, n, key) {
    if (!(n > 0)) return -1;
    if (key === 'home') return 0;
    if (key === 'end') return n - 1;
    if (key === 'down') return sel < 0 ? 0 : (sel + 1) % n;
    if (key === 'up') return sel < 0 ? n - 1 : (sel - 1 + n) % n;
    return sel;
  }

  function render() {
    const { doc, panel } = ui;
    panel.textContent = '';
    ui.items = [];
    ui.sel = -1;
    panel.removeAttribute('aria-activedescendant');
    for (const r of rows()) {
      if (r.sep) { const s = doc.createElement('div'); s.className = 'dm-sep'; s.setAttribute('role', 'separator'); panel.appendChild(s); continue; }
      const b = doc.createElement('div');
      b.className = 'dm-row';
      b.setAttribute('role', 'menuitem');
      b.id = `dm-${r.id}`;
      b.dataset.id = r.id;
      const ic = doc.createElement('span'); ic.className = 'dm-ic'; ic.textContent = ICON[r.id] || ''; ic.setAttribute('aria-hidden', 'true');
      const tx = doc.createElement('span'); tx.className = 'dm-tx'; tx.textContent = r.label;
      b.append(ic, tx);
      const at = ui.items.length;
      b.addEventListener('click', () => pick(r, b));
      b.addEventListener('mousemove', () => { if (ui.sel !== at) setSel(at); });
      ui.items.push({ r, el: b });
      panel.appendChild(b);
    }
    if (!ui.leaveWired) {
      panel.addEventListener('mouseleave', () => setSel(-1));
      ui.leaveWired = true;
    }
    const note = doc.createElement('div');
    note.className = 'dm-note';
    note.hidden = true;
    panel.appendChild(note);
    ui.note = note;
  }

  function size() {
    const r = ui.panel.getBoundingClientRect();
    return { w: Math.ceil(r.width) + INSET * 2, h: Math.ceil(r.height) + INSET * 2, inset: INSET };
  }

  async function pick(r, el) {
    if (el.classList.contains('busy')) return;
    el.classList.add('busy');
    let ok = true, reason = null;
    try {
      const res = await r.run();
      if (res && res.ok === false) { ok = false; reason = res.reason || res.error || 'no reason was given'; }
    } catch (e) { ok = false; reason = e && e.message ? e.message : String(e); }
    el.classList.remove('busy');
    M.call('deskmenu.picked', { id: r.id, ok, reason }).catch((e) => console.warn('[deskmenu] main did not hear the pick: ' + (e && e.message)));
    if (!ok && ui && ui.note) {
      ui.note.textContent = `${r.label} did not work: ${reason}`;
      ui.note.hidden = false;
      const s = size();
      M.call('deskmenu.place', Object.assign({ seq: seqNow }, s)).catch(() => { /* the menu keeps its size */ });
    }
  }

  // MENU KEYS (lib/popwatch.js): the menu window never takes the keyboard, so main hands over the bare
  // Up/Down/Home/End/Enter the sidecar took while this menu is open. Enter with nothing highlighted
  // closes the menu (the key was kept from the desktop, so it must not do nothing).
  M.on('deskmenu.key', (p) => {
    if (!p || p.seq !== seqNow || !ui || !ui.items || !win || win.closed) return;
    const key = String(p.key || '');
    if (key === 'enter') {
      const it = ui.sel >= 0 ? ui.items[ui.sel] : null;
      if (it) pick(it.r, it.el);
      else M.call('deskmenu.hide', { why: 'Enter with no row highlighted' }).catch(() => { /* Esc still closes it */ });
      return;
    }
    setSel(step(ui.sel, ui.items.length, key));
  });

  M.on('deskmenu.prepare', () => { try { ensure(); } catch (e) { console.warn('[deskmenu] the menu window could not be made: ' + (e && e.message)); } });

  M.on('deskmenu.show', async (p) => {
    const seq = p && p.seq;
    seqNow = seq;
    let made = false;
    try { made = ensure(); } catch (e) { made = false; }
    if (!made) {
      M.call('deskmenu.place', { seq, error: 'the desktop page could not open the menu window' }).catch(() => {});
      return;
    }
    const styled = await ui.ready;
    if (seq !== seqNow) return;                       // a newer right-click took over
    if (styled.some((x) => !x)) console.warn('[deskmenu] a menu style sheet did not load, so the menu may look plain');
    syncTheme();
    render();
    const res = await M.call('deskmenu.place', Object.assign({ seq }, size())).catch((e) => ({ ok: false, reason: e.message }));
    if (!res || res.ok === false || !win || win.closed) return;
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
      M.call('deskmenu.painted', { seq }).catch(() => { /* the timing line is lost, nothing else */ });
    }));
  });
})();
