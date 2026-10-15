/*
 * deskmenu.js -- the desktop right-click menu, drawn by THIS page into a window it opens itself (lane
 * mantle-deskmenu, 2026-10-15; lib/features/deskmenu.js says why the desktop page hosts it: no new
 * renderer, nothing kept hidden for good).
 *
 *   'deskmenu.prepare'  a right-click on the empty desktop began: make the menu window if there is none
 *   'deskmenu.show'     {seq}: it ended. Draw the rows, tell main the size (deskmenu.place: main puts the
 *                       window at the click and shows it), then deskmenu.painted after its second frame.
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
  const INSET = 10;                         // the clear margin around the panel: room for its shadow
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

  function render() {
    const { doc, panel } = ui;
    panel.textContent = '';
    for (const r of rows()) {
      if (r.sep) { const s = doc.createElement('div'); s.className = 'dm-sep'; s.setAttribute('role', 'separator'); panel.appendChild(s); continue; }
      const b = doc.createElement('div');
      b.className = 'dm-row';
      b.setAttribute('role', 'menuitem');
      b.dataset.id = r.id;
      const ic = doc.createElement('span'); ic.className = 'dm-ic'; ic.textContent = ICON[r.id] || ''; ic.setAttribute('aria-hidden', 'true');
      const tx = doc.createElement('span'); tx.className = 'dm-tx'; tx.textContent = r.label;
      b.append(ic, tx);
      b.addEventListener('click', () => pick(r, b));
      panel.appendChild(b);
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
