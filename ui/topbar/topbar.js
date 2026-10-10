/* topbar.js — the macOS-style menu bar page. Main (lib/features/topbar.js) pushes:
 *   topbar.focus     the sidecar's focus snapshot (sidecar/MenuBar.cs), with the Win32 menu
 *   topbar.title     a title change, and the menu again when it changed (MDI apps swap menus)
 *   topbar.geometry  zoomed / full-screen changes of the focused window
 *   topbar.uia       a UI Automation menu read for a window with no Win32 menu
 *   topbar.stats     one system sample a second (sidecar/TopbarStats.cs), or {paused, reason}
 *   topbar.note      a plain-words problem to show on the bar (NO SILENT FAILURES)
 * and the page calls topbar.invoke / uiaInvoke / menus / window / newWindow / power / about /
 * settings / taskmgr / menuState / statsDetail / hello. Every failure comes back as a reason
 * that is shown under the menu it came from. */
(function () {
  'use strict';
  const M = window.TopbarModel;
  const mantle = window.mantle;
  const leftEl = document.getElementById('left');
  const rightEl = document.getElementById('right');
  const menusEl = document.getElementById('menus');
  const barEl = document.getElementById('bar');
  const S = { focus: null, menu: null, uia: {}, stats: null, paused: null, note: null, open: null, armed: null, titles: [],
              fit: null, vis: 0, rightKey: null, asked: null, waitT: 0,
              timer: null, timerSkew: 0, tickT: 0, notes: null };   // the two small tools (lane tbtools)
  const ARM_MS = 4000, ARM_MIN_MS = 300, HOVER_SUB_MS = 110;
  const APP_MIN = 96;   // the app's name ellipsizes down to this before any menu moves into »
  const GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M2 6h12"/></svg>';
  // THE TWO SMALL TOOLS (lane tbtools, 2026-09-27): a timer / stopwatch and quick notes at the right
  // end of the bar. Same stroke glyphs as the Mantle mark: no fill, no colour of their own.
  const TIMER_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="8" cy="9.25" r="5.25"/><path d="M8 9.25V6.5M6.25 1.75h3.5M12.3 4.45l.95-.95"/></svg>';
  const PAUSE_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5.75 4.5v7M10.25 4.5v7"/></svg>';
  const NOTE_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3.25 2.25h6.5l3 3v8.5h-9.5z"/><path d="M9.5 2.5v3h3M5.75 8.25h4.5M5.75 11h3"/></svg>';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const call = (name, args) => Promise.resolve(mantle.call(name, args || {})).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }));
  const menuSource = () => S.menu || (S.focus && S.uia[S.focus.hwnd]) || null;

  /* ---- the strip --------------------------------------------------------------------------- */
  /* The part of this window that is on its screen, in CSS px: normally innerWidth. Owen's "CPU 82%"
     cut at the right edge (2026-09-25) is what a window WIDER than its display shows: headless at
     1920 CSS px on a 1536 px screen puts CPU at 1454-1528 and RAM / GPU / NET past the edge, exactly
     his screenshot, and an Electron probe window resized to 1920 DIP while hidden laid its page out
     1920 CSS px wide on the 1536 DIP panel (scratchpad eprobe2, case C). So the strip is sized to
     the screen, not the window. screen.* and screenX are DIP and innerWidth is CSS px, equal at page
     zoom 1, which main pins (lib/features/topbar.js). NOT outerWidth / innerWidth as a zoom guess:
     in the same probe a window resized 1536 -> 1920 -> 1536 in one tick reported outerWidth 1920
     with innerWidth 1536 for its resize event, which read as zoom 0.8 and cut the strip 308 px short. */
  function visibleWidth() {
    const iw = window.innerWidth || document.documentElement.clientWidth || 0;
    const scr = window.screen, sw = scr && scr.width;
    if (!iw || !sw) return iw;
    const onScreen = (scr.availLeft || 0) + sw - (window.screenX || 0);
    if (!(onScreen >= 320)) return iw;          // nonsense (no screen yet, another display): trust the window
    return Math.floor(Math.min(iw, onScreen));
  }

  const titleHtml = (t, i, appW) =>
    `<button class="t${t.bold ? ' bold' : ''}${t.glyph ? ' glyph' : ''}${t.enabled === false ? ' dim' : ''}${S.open && S.open.ti === i ? ' open' : ''}"` +
    ` data-i="${i}" role="menuitem" aria-haspopup="true" title="${t.glyph ? 'Mantle' : appW != null && t.bold ? esc(t.label) : ''}">` +
    `${t.glyph ? GLYPH : `<span class="lbl">${esc(t.label)}</span>`}</button>`;
  const moreHtml = (i) => `<button class="t more${S.open && S.open.ti === i ? ' open' : ''}" data-i="${i}" role="menuitem"` +
    ` aria-haspopup="true" aria-label="More menus" title="More menus">»</button>`;
  const hiddenCount = () => (S.fit ? S.titles.length - S.fit.shown : 0);
  const barCount = () => (S.fit ? S.fit.shown + (hiddenCount() > 0 ? 1 : 0) : S.titles.length);

  // the strip ends at the screen's edge even when the window runs past it
  function sizeBar() {
    const vis = visibleWidth();
    S.vis = vis;
    barEl.style.right = Math.max(0, (window.innerWidth || vis) - vis) + 'px';
    const bd = document.getElementById('bdrop');   // the glass's picture ends where the strip does
    if (bd) bd.style.right = barEl.style.right;
    return vis;
  }

  function renderBar() {
    S.titles = M.titles(S.focus, menuSource());
    renderStats(true);
    layoutLeft();
  }

  // Measure every title at its natural width (one synchronous pass, nothing painted in between),
  // then let model.js decide what fits. Frozen while a menu is open, so the open title's index and
  // the » menu's contents cannot move under the pointer; closing a menu re-fits.
  function layoutLeft() {
    if (!S.open || !S.fit || S.fit.n !== S.titles.length) {
      sizeBar();
      leftEl.innerHTML = S.titles.map((t, i) => titleHtml(t, i, null)).join('') + moreHtml(S.titles.length);
      const w = [...leftEl.children].map((b) => b.getBoundingClientRect().width);
      const moreW = w.pop();
      S.fit = M.fitTitles(w, moreW, leftEl.getBoundingClientRect().width, APP_MIN);
    }
    const f = S.fit;
    leftEl.innerHTML = S.titles.slice(0, f.shown).map((t, i) => titleHtml(t, i, f.appW)).join('') + (hiddenCount() > 0 ? moreHtml(f.shown) : '');
    // through the CSSOM: the page's CSP (style-src file:) drops inline style="" attributes
    const app = f.appW != null && leftEl.querySelector('.t.bold');
    if (app) app.style.maxWidth = f.appW + 'px';
  }

  function renderStats(fromBar) {
    let html = '';
    if (S.note) html += `<span class="warn" title="${esc(S.note)}">${esc(S.note.length > 60 ? S.note.slice(0, 57) + '…' : S.note)}</span>`;
    if (S.paused) html += `<span class="paused" title="${esc(S.paused)}">stats paused</span>`;
    else {
      html += M.statCells(S.stats).map((c) =>
        `<button class="t st${c.why ? ' na' : ''}${c.warn ? ' hi' : ''}${S.open && S.open.stat === c.key ? ' open' : ''}" data-k="${c.key}"` +
        ` title="${esc(c.title || c.why || '')}"><span class="k">${c.label}</span><span class="v">${esc(c.value)}</span></button>`).join('');
    }
    html += toolsHtml();
    rightEl.innerHTML = html;
    // a note or "stats paused" changes how much room the left side has: re-fit it (not on every
    // 1 s sample: the cells keep their width, so the key does not change). The window's width is in
    // the key too, so the 1 s samples also catch a resize whose event never came.
    const key = Math.round(rightEl.getBoundingClientRect().width) + '/' + visibleWidth() + '/' + window.innerWidth;
    if (key !== S.rightKey) { S.rightKey = key; if (!fromBar) { sizeBar(); layoutLeft(); } }
  }

  /* ---- the two small tools (lane tbtools, 2026-09-27) ---------------------------------------
     TIMER: lib/features/timer.js keeps the time (it never rests: a timer still ends during a game)
     and sends timer.state on every change; this page only DRAWS it. While a timer or stopwatch runs,
     one setTimeout per shown second rewrites the cell's text (TimerCore.nextTickMs); nothing ticks
     while nothing runs, while it is paused, or while this window is hidden. Hidden by hand, the peek
     shows the bar and so the time. NOTES: the pad is its own window (lib/features/notes.js, ui/notes):
     the button opens it under itself, and shows it pressed while it is open, amber when a save failed. */
  const TC = () => window.TimerCore || null;   // lib/features/_timer-core.js, loaded by index.html
  // timer.state carries main's clock; a fake one (the self-test's) moves the page with it
  const tnow = () => Date.now() + (S.timerSkew || 0);
  function toolsHtml() {
    const C = TC();
    const cell = C ? M.timerCell(S.timer, tnow(), C) : null;
    const tOpen = S.open && S.open.tool === 'timer';
    let h;
    if (cell) {
      h = `<button class="t tool tm${cell.paused ? ' pz' : ''}${cell.up ? ' up' : ''}${tOpen ? ' open' : ''}" data-tool="timer"` +
        ` title="${esc(cell.title)}" aria-label="${esc(cell.title)}">${cell.paused ? PAUSE_GLYPH : TIMER_GLYPH}<span class="v">${esc(cell.text)}</span></button>`;
    } else {
      const why = !C ? 'Timer: its script (lib/features/_timer-core.js) did not load, so no time can be shown' : 'Timer and stopwatch';
      h = `<button class="t glyph tool${tOpen ? ' open' : ''}${C ? '' : ' bad'}" data-tool="timer" title="${esc(why)}" aria-label="Timer and stopwatch">${TIMER_GLYPH}</button>`;
    }
    const nb = M.notesButton(S.notes);
    h += `<button class="t glyph tool${nb.open ? ' open' : ''}${nb.bad ? ' bad' : ''}" data-tool="notes" title="${esc(nb.title)}" aria-label="Quick notes">${NOTE_GLYPH}</button>`;
    return h;
  }
  function retick() {
    clearTimeout(S.tickT); S.tickT = 0;
    const C = TC();
    if (!S.timer || !C || document.hidden) return;
    const ms = C.nextTickMs(S.timer, tnow());
    if (ms == null) return;
    S.tickT = setTimeout(() => { S.tickT = 0; tickCell(); retick(); }, Math.max(20, ms + 15));
  }
  // one text node per second; a new width ("9:59" after "10:00") re-lays the right side out instead
  function tickCell() {
    const v = rightEl.querySelector('.tool.tm .v');
    const cell = TC() ? M.timerCell(S.timer, tnow(), TC()) : null;
    if (!v || !cell || v.textContent.length !== cell.text.length) { renderStats(); return; }
    v.textContent = cell.text;
    v.parentElement.title = cell.title;
  }
  function toolItems(tool) {
    if (tool !== 'timer') return [];
    if (!TC()) return [{ t: 'info', bad: true, enabled: false, text: 'The timer\'s script (lib/features/_timer-core.js) did not load, so the timer cannot be shown here' }];
    return M.timerMenu(S.timer, tnow(), TC());
  }
  function openTool(tool) {
    const b = rightEl.querySelector(`[data-tool="${tool}"]`);
    const right = b ? Math.round(b.getBoundingClientRect().right) : visibleWidth() - 4;
    S.armed = null; S.edit = null;
    S.open = { ti: -1, tool, stack: [{ items: toolItems(tool), sel: -1, x: Math.max(4, right - 240), right, path: [] }] };
    renderStats();
    renderMenus();
  }
  // a new timer.state while the menu is open: new rows, the hovered row and an armed Cancel kept
  function refreshToolMenu() {
    const o = S.open;
    if (!o || o.tool !== 'timer' || S.edit) return;
    const items = toolItems('timer');
    const lv = o.stack[0];
    if (JSON.stringify(items) === JSON.stringify(lv.items)) return;
    const armedAct = S.armed && S.armed.item && S.armed.item.act;
    lv.items = items;
    if (lv.sel >= items.length) lv.sel = -1;
    o.stack.length = 1;
    S.armed = armedAct ? (items.find((x) => x.act === armedAct) ? { item: items.find((x) => x.act === armedAct), at: S.armed.at } : null) : null;
    renderMenus();
  }
  function toolClick(tool, b) {
    if (tool === 'timer') { if (S.open && S.open.tool === 'timer') closeAll(true); else openTool('timer'); return; }
    if (tool !== 'notes') return;
    // `wasOpen`: this very click's focus change may have closed the pad already (its window lost the
    // keyboard to this bar); then the click meant "close", and notes.js leaves it closed
    const wasOpen = !!(S.notes && S.notes.open);
    if (S.open) closeAll(false);
    const r = b.getBoundingClientRect();
    call('notes.toggle', { x: Math.round((window.screenX || 0) + r.right), app: (S.focus && S.focus.hwnd) || null, via: 'the top bar', wasOpen }).then((res) => {
      if (res && res.ok === false) setNote('Quick notes: ' + (res.reason || res.error || 'the pad did not open, and no reason came back'));
    });
  }

  /* ---- dropdowns --------------------------------------------------------------------------- */
  function rowHtml(it, i, sel, level) {
    if (it.t === 'sep') return '<div class="sep"></div>';
    if (it.t === 'info') return `<div class="info${it.bad ? ' bad' : ''}">${esc(it.text)}</div>`;
    if (S.edit && S.edit.item === it) {   // window layouts / the timer's own length: typed in the menu itself
      const ph = it.placeholder || 'Name it, e.g. Work', aria = it.aria || 'Layout name', ml = it.maxlength || 40;
      return `<div class="r sel edit" data-l="${level}" data-r="${i}" role="menuitem"><span class="ck"></span>` +
        `<input class="lbi" type="text" maxlength="${ml}" spellcheck="false" aria-label="${esc(aria)}" placeholder="${esc(ph)}" value="${esc(S.edit.value)}"><span></span><span></span></div>`;
    }
    const armed = S.armed && S.armed.item === it;
    const off = it.enabled === false || (it.ownerDraw && !it.label);
    const label = armed ? it.confirm : (it.label || (it.ownerDraw ? '(the app draws this item itself)' : '(untitled)'));
    const ck = it.checked ? (it.radio ? '●' : '✓') : '';
    // .on: the row whose submenu is open (dark: Helm's selected row; light draws it as .sel, as before)
    const on = i === sel && S.open && S.open.stack && S.open.stack[level + 1];
    return `<div class="r${i === sel ? ' sel' : ''}${on ? ' on' : ''}${off ? ' off' : ''}${armed ? ' armed' : ''}" data-l="${level}" data-r="${i}" role="menuitem"` +
      `${off ? ' aria-disabled="true"' : ''}><span class="ck">${ck}</span><span class="lb">${esc(label)}</span>` +
      `<span class="kb">${esc(it.key || '')}</span><span class="ar">${it.items ? '▸' : ''}</span></div>`;
  }

  /* HEIGHT. A dropdown is as tall as its content, down to the bottom of the SCREEN's work area
     (never the window's: the closed bar's window is 38 DIP, see topbar.css .dd), and scrolls
     inside past that. screen.* and screenY are DIP, equal to CSS px at the zoom main pins. */
  const DD_TOP = 30, DD_GAP = 8, DD_MIN = 72;
  function screenBottom() {
    const s = window.screen || {};
    const h = s.availHeight || s.height || window.innerHeight;
    return (s.availHeight ? (s.availTop || 0) : 0) + h - (window.screenY || 0);
  }
  // Caps one dropdown at the screen's bottom; a submenu that would run past it moves up instead
  // (as a Mac submenu does), never above the bar.
  function fitDown(dd, level) {
    const limit = screenBottom() - DD_GAP;
    let top = dd.offsetTop;
    const natural = dd.offsetHeight;
    if (level > 0 && top + natural > limit) { top = Math.max(DD_TOP, limit - natural); dd.style.top = top + 'px'; }
    if (top + natural > limit) dd.style.maxHeight = Math.max(DD_MIN, limit - top) + 'px';
  }
  // The selected row stays in view in a dropdown that scrolls (arrow keys past the fold). Done by
  // hand: scrollIntoView would also scroll #menus, and the page must never scroll.
  function keepSelVisible(dd, sel) {
    if (sel == null || sel < 0 || dd.scrollHeight <= dd.clientHeight) return;
    const row = dd.querySelector(`[data-r="${sel}"]`);
    if (!row) return;
    if (row.offsetTop < dd.scrollTop) dd.scrollTop = row.offsetTop - 5;
    else if (row.offsetTop + row.offsetHeight > dd.scrollTop + dd.clientHeight) dd.scrollTop = row.offsetTop + row.offsetHeight - dd.clientHeight + 5;
  }

  function renderMenus() {
    const o = S.open;
    // a re-render (hover, arrow keys, a fresh read) keeps each level's scroll position
    if (o && o.stack) o.stack.forEach((lv) => { if (lv.el && lv.el.isConnected) lv.scroll = lv.el.scrollTop; });
    menusEl.innerHTML = '';
    if (!o) return;
    menuGlassStart();   // dark: once per menu session (a no-op while one is open, and in light)
    if (o.stat) { renderStatMenu(o); return; }
    o.stack.forEach((lv, level) => {
      const dd = document.createElement('div');
      dd.className = 'dd' + (lv.shown ? '' : ' anim');
      dd.setAttribute('role', 'menu');
      let html = lv.items.length ? lv.items.map((it, i) => rowHtml(it, i, lv.sel, level)).join('') : '';
      if (lv.info) html += `<div class="info${lv.bad ? ' bad' : ''}">${esc(lv.info)}</div>`;
      if (!lv.items.length && !lv.info) html += '<div class="info">This menu is empty.</div>';
      dd.innerHTML = html;
      dd.style.left = lv.x + 'px';
      if (lv.y != null) dd.style.top = lv.y + 'px';
      dd._owner = lv;
      menusEl.appendChild(dd);
      // a tool's menu hangs from its button's RIGHT edge (the stat menus do the same)
      // (measured at left 0 first: placed near the screen's right edge, a wide menu - a long info
      // line - shrinks to the room left and then grows past its button once moved)
      if (lv.right != null) { dd.style.left = '0px'; dd.style.left = Math.max(4, Math.round(lv.right - dd.getBoundingClientRect().width)) + 'px'; }
      // keep a submenu on screen: flip it to the left of its parent when it would run off the right
      const r = dd.getBoundingClientRect(), vis = visibleWidth();
      if (r.right > vis - 4) dd.style.left = Math.max(4, (level > 0 ? lv.flipX : vis - 4 - r.width)) + 'px';
      fitDown(dd, level);
      if (lv.scroll) dd.scrollTop = lv.scroll;
      keepSelVisible(dd, lv.sel);
      lv.el = dd;
      placeGlass(dd, level);
    });
    if (S.edit) {
      const inp = menusEl.querySelector('input.lbi');
      if (inp && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
    notifyMain();
  }

  function titleX(ti) {
    const b = leftEl.querySelector(`[data-i="${ti}"]`);
    return b ? Math.round(b.getBoundingClientRect().left) : 8;
  }

  function openMenu(ti) {
    if (S.fit && ti === S.fit.shown && hiddenCount() > 0) { openMore(); return; }
    const t = S.titles[ti];
    if (!t) return;
    S.armed = null;
    // a UIA menu the app builds only when it opens: open the APP's own menu instead (live only)
    if (t.source === 'uia' && t.lazy) {
      closeAll(false);
      call('topbar.uiaInvoke', { hwnd: menuSource().hwnd, path: t.path, names: [t.label], expand: true }).then((r) => {
        if (!r || r.ok === false) setNote(`${t.label}: ${(r && r.reason) || 'the app did not open its menu'}`);
      });
      return;
    }
    S.open = { ti, stack: [{ items: t.items || [], sel: -1, x: titleX(ti), path: t.path || [] }] };
    renderBar();
    renderMenus();
    // Fresh greyed/checked states: the app is asked to prepare this menu (WM_INITMENUPOPUP, live
    // only) and it is read again. The first paint above uses what the focus event carried.
    if (t.source === 'win32') refreshLevel(0, t.path);
  }

  // » : the titles that did not fit, one row each; a row opens that title's menu as a submenu
  // (ArrowRight / Enter / hover), so every hidden menu works exactly as it does on the bar.
  function openMore() {
    const first = S.fit.shown;
    S.armed = null;
    const items = S.titles.slice(first).map((t, k) => ({
      t: 'item', label: t.label, items: t.items || null, pos: t.pos, id: t.id, lazy: !!t.lazy,
      enabled: t.enabled !== false, source: t.source || null, ti: first + k }));
    S.open = { ti: first, more: true, stack: [{ items, sel: -1, x: titleX(first), path: [], more: true }] };
    renderBar();
    renderMenus();
  }

  function refreshLevel(level, path) {
    const src = menuSource();
    const o = S.open;
    if (!src || !o) return;
    call('topbar.menus', { hwnd: src.hwnd, init: path }).then((r) => {
      if (S.open !== o || !o.stack[level]) return;
      const lv = o.stack[level];
      const fresh = r && r.menu ? findByPath(r.menu.items, path) : null;
      if (fresh && fresh.items) { lv.items = M.cleanItems(fresh.items); lv.info = null; }
      else if (r && r.ok === false) { lv.info = r.reason; lv.bad = true; }
      if (r && r.initNote && !lv.items.length) lv.info = r.initNote;
      if (lv.items.length === 0 && !lv.info) lv.info = 'The app fills this menu only when its own menu opens, and it stayed empty.';
      renderMenus();
    });
  }

  function findByPath(items, path) {
    let cur = null, list = items;
    for (const pos of path) {
      cur = (list || []).find((i) => i.pos === pos);
      if (!cur) return null;
      list = cur.items;
    }
    return cur;
  }

  function openSub(level, i) {
    const o = S.open;
    const lv = o.stack[level];
    const it = lv.items[i];
    // a hidden UIA title the app builds only when it opens: the same route as clicking it on the bar
    if (lv.more && it && it.source === 'uia' && it.lazy && it.enabled !== false) { openMenu(it.ti); return; }
    if (!it || !it.items || it.enabled === false) return;
    o.stack.length = level + 1;
    const row = lv.el && lv.el.querySelector(`[data-r="${i}"]`);
    const rr = row ? row.getBoundingClientRect() : { right: lv.x + 220, top: 40, left: lv.x };
    const path = lv.path.concat(it.pos);
    o.stack.push({ items: M.cleanItems(it.items), sel: -1, x: Math.round(rr.right + 2), flipX: Math.round(rr.left - 2 - 230), y: Math.round(rr.top - 6), path });
    renderMenus();
    const src = menuSource();
    if (it.lazy && src && src.source === 'win32') {
      o.stack[level + 1].info = 'Asking the app for this menu…';
      renderMenus();
      refreshLevel(level + 1, path);
    } else if (lv.more && it.source === 'win32' && src && src.source === 'win32') {
      refreshLevel(level + 1, path);   // fresh greyed / checked states, as opening it on the bar does
    }
  }

  function closeAll(refocus) {
    if (!S.open) return;
    S.open = null;
    S.armed = null;
    S.edit = null;
    menusEl.innerHTML = '';
    renderBar();
    tellClosed(!!refocus);
  }
  // The dropdowns are gone before main shrinks the window back to the bar.
  function tellClosed(refocus) {
    S.asked = null;
    clearTimeout(S.waitT); S.waitT = 0;
    menuGlassEnd();
    call('topbar.menuState', { open: false, refocus });
  }

  /* THE WINDOW FOLLOWS THE MENU. The dropdowns are laid out at full height whatever the window's
     size (fitDown caps them by the SCREEN), so their bottom is measured right, and main is asked
     for a window that tall. A dropdown that reaches past the window's current bottom waits hidden
     (.wait) until the window has grown (reveal, on resize): the page never paints a clipped slice.
     If the window never grows, the menu shows anyway and the bar says why (no silent failures). */
  const WAIT_MS = 1500;
  // The LAYOUT bottom: the fade-in's translateY(-3px) would make a rect 3 px short (and ratchet the window).
  const ddBottom = (dd) => dd.offsetTop + dd.offsetHeight;
  function notifyMain() {
    let bottom = 28;
    for (const dd of menusEl.children) bottom = Math.max(bottom, ddBottom(dd) + DD_GAP);
    if (reveal() && !S.waitT) S.waitT = setTimeout(waitedTooLong, WAIT_MS);
    if (bottom === S.asked) return;          // hover and the 1 s sample re-render at the same height
    S.asked = bottom;
    call('topbar.menuState', { open: true, height: bottom }).then((r) => {
      if (r && r.ok === false) { S.asked = null; setNote(`The menu cannot be shown in full: ${r.reason || 'the bar\'s window did not grow'}`); }
    });
  }
  // Shows every dropdown the window can show whole, hides the rest; returns how many still wait.
  function reveal() {
    const h = window.innerHeight;
    let waiting = 0;
    for (const dd of menusEl.children) {
      const fits = ddBottom(dd) <= h || !!(S.open && S.open.gaveUp);   // gave up waiting: shown as it is
      dd.classList.toggle('wait', !fits);
      if (!fits) waiting++;
      else if (dd._owner && !menusEl.classList.contains('pre')) dd._owner.shown = true;   // later re-renders do not fade in again (held for its picture = not shown yet)
    }
    if (!waiting) { clearTimeout(S.waitT); S.waitT = 0; }
    return waiting;
  }
  function waitedTooLong() {
    S.waitT = 0;
    if (!S.open || !reveal()) return;
    const need = Math.max(...[...menusEl.children].map((dd) => ddBottom(dd)));
    S.open.gaveUp = true;
    reveal();
    setNote(`The menu is cut off: it needs ${need} px and the bar's window stayed ${window.innerHeight} px tall`);
  }

  function setNote(text) {
    S.note = text || null;
    renderStats();
    if (text) setTimeout(() => { if (S.note === text) { S.note = null; renderStats(); } }, 8000);
  }

  // "Open Task Manager" (the stats pop-up): Mantle's own task manager (lane integrate, 2026-09-28);
  // when it cannot open (off, resting, not loaded) Windows' opens instead and the note says why.
  async function openTaskMgr() {
    let why = null;
    try {
      const r = await call('taskmgr.open', { view: 'apps' });
      if (r && r.ok !== false) return;
      why = (r && r.reason) || 'it did not say why';
    } catch (e) { why = (e && e.message) || String(e); }
    try {
      const x = await call('topbar.taskmgr');
      setNote(x && x.ok === false ? `Task Manager: Mantle's did not open (${why}) and Windows' did not either: ${x.reason}`
        : `Opened Windows' Task Manager: Mantle's did not open (${why})`);
    } catch (e) { setNote(`Task Manager: Mantle's did not open (${why}) and Windows' did not either: ${e.message}`); }
  }

  /* ---- doing things ------------------------------------------------------------------------ */
  function activate(level, i) {
    const o = S.open;
    if (!o || o.stat) return;
    const lv = o.stack[level];
    const it = lv.items[i];
    if (!it || it.t === 'sep' || it.enabled === false) return;
    if (it.items) { openSub(level, i); return; }
    if (S.edit && S.edit.item === it) return;   // a click in the name box
    if (it.act === 'layoutNew' || it.act === 'layoutRename' || it.act === 'timerCustom') {   // a name / a timer length, typed right here
      S.armed = null;
      S.edit = { item: it, value: it.act === 'layoutRename' ? it.layout : '' };
      lv.sel = i;
      lv.info = null; lv.bad = false;
      renderMenus();
      return;
    }
    if (it.confirm) {
      if (!S.armed || S.armed.item !== it) { S.armed = { item: it, at: Date.now() }; renderMenus(); setTimeout(() => { if (S.armed && S.armed.item === it) { S.armed = null; if (S.open) renderMenus(); } }, ARM_MS); return; }
      if (Date.now() - S.armed.at < ARM_MIN_MS) return;   // a double-click is not two decisions
    }
    const confirmed = !!(it.confirm && S.armed && S.armed.item === it);
    const f = S.focus;
    const src = menuSource();
    let p;
    if (it.act === 'layoutRestore') p = call('layouts.restore', { name: it.layout, via: 'the Mantle menu' });
    else if (it.act === 'layoutSave') p = call('layouts.save', { name: it.layout, replace: true });
    else if (it.act === 'layoutDelete') p = call('layouts.delete', { name: it.layout });
    else if (it.act === 'power') p = call('topbar.power', { action: it.power, confirmed });
    else if (it.act === 'about' || it.act === 'settings' || it.act === 'winSettings') p = call('topbar.' + it.act);
    else if (it.act === 'overGames') p = call('topbar.overGames', { on: !it.checked }).then((r) => { if (r && r.ok) it.checked = !!r.overGames; return r; });
    else if (it.act === 'hide') p = call('topbar.hidden', { on: true, via: 'the Mantle menu' });
    else if (it.act === 'show') p = call('topbar.hidden', { on: false, via: 'the Mantle menu, while peeking' });
    else if (it.act === 'newWindow') p = call('topbar.newWindow', { exe: it.exe, args: it.args });
    else if (it.act === 'timerStart') p = call('timer.start', { ms: it.ms });
    else if (it.act === 'timerStopwatch') p = call('timer.stopwatch');
    else if (it.act === 'timerPause') p = call('timer.pause');
    else if (it.act === 'timerResume') p = call('timer.resume');
    else if (it.act === 'timerAdd') p = call('timer.add', { ms: it.ms });
    else if (it.act === 'timerCancel') p = call('timer.cancel');
    else if (it.act) p = call('topbar.window', { hwnd: f && f.hwnd, action: it.act });
    else if (src && src.source === 'win32') p = call('topbar.invoke', { hwnd: src.hwnd, item: it.id });
    else if (src && src.source === 'uia') {
      const path = lv.path.concat(it.pos);
      const names = path.map((_, k) => (findByPath(src.items, path.slice(0, k + 1)) || {}).label);
      p = call('topbar.uiaInvoke', { hwnd: src.hwnd, path, names });
    } else p = Promise.resolve({ ok: false, reason: 'this item has nothing to run it with' });
    const label = it.label;
    closeAll(true);
    p.then((r) => {
      if (r && r.ok === false) setNote(`${label}: ${r.reason || r.error || 'it did not happen, and no reason came back'}`);
      else if (r && r.dryRun && r.reason) setNote(r.reason);
    });
  }

  function move(level, dir) {
    const lv = S.open.stack[level];
    const n = lv.items.length;
    for (let k = 1; k <= n; k++) {
      const j = ((lv.sel < 0 ? (dir > 0 ? -1 : 0) : lv.sel) + dir * k + n * 2) % n;
      const it = lv.items[j];
      if (it && it.t !== 'sep' && it.enabled !== false) { lv.sel = j; renderMenus(); return; }
    }
  }

  function stepTitle(dir) {
    const n = barCount();   // the titles on the bar, then » when some are hidden
    if (!n || !S.open) return;
    const cur = S.open.stat ? 0 : S.open.ti;
    openMenu((cur + dir + n) % n);
    move(0, 1);
  }

  /* ---- stat details ------------------------------------------------------------------------ */
  function openStat(key) {
    S.open = { stat: key };
    renderBar();
    renderMenus();
    call('topbar.statsDetail', { kind: key });
  }

  function renderStatMenu(o) {
    const s = S.stats || {};
    const d = s[o.stat] || {};
    const row = (n, x) => `<div class="row2"><span class="n">${esc(n)}</span><span class="x">${esc(x)}</span></div>`;
    let html = '';
    if (o.stat === 'cpu') {
      html += `<h4>CPU · ${M.pct(d.pct)}</h4>`;
      // the fills' heights go in through the CSSOM below: the CSP drops a style="" attribute
      if (d.cores && d.cores.length) html += '<div class="cores">' + d.cores.map((c) => `<div class="core" title="${M.pct(c)}"><i></i></div>`).join('') + '</div>';
      if (d.top) html += '<h4>Top processes</h4>' + d.top.map((p) => row(p.name, M.pct(p.pct))).join('');
    } else if (o.stat === 'mem') {
      html += `<h4>Memory · ${M.gb(d.used)} of ${M.gb(d.total)} GB</h4>`;
      if (d.commit != null) html += row('Committed', `${M.gb(d.commit)} of ${M.gb(d.commitLimit)} GB`);
      if (d.top) html += '<h4>Top processes</h4>' + d.top.map((p) => row(p.name, M.gb(p.bytes) + ' GB')).join('');
    } else if (o.stat === 'gpu') {
      html += `<h4>GPU · ${M.pct(d.pct)}${d.name ? ' · ' + esc(d.name) : ''}</h4>`;
      (d.engines || []).forEach((e) => { html += row(e.type, M.pct(e.pct)); });
      if (d.dedicated != null) html += row('Dedicated memory', M.gb(d.dedicated) + ' GB');
      if (d.shared != null) html += row('Shared memory', M.gb(d.shared) + ' GB');
      if (d.top) html += '<h4>Top processes</h4>' + d.top.map((p) => row(p.name, M.pct(p.pct))).join('');
    } else if (o.stat === 'net') {
      html += `<h4>Network · ↓${M.rate(d.down)} ↑${M.rate(d.up)}</h4>`;
      (d.adapters || []).forEach((a) => { html += row(a.name, `↓${M.rate(a.down)} ↑${M.rate(a.up)}`); });
    } else if (o.stat === 'ping') {
      // PING (lane topbar-ping): the server it measures, then every server of the last pick (the closest wins)
      const ok = d.state === 'ok';
      html += `<h4>Ping · ${ok ? M.pingMs(d.ms) : '--'}${d.server ? ' · ' + esc(M.pingName(d)) : ''}</h4>`;
      if (d.server) html += row('Measured to', `${d.host || ''}${d.via ? ' (' + d.via + ')' : ''}`) + row('Every', `${Math.round((d.everyMs || 2000) / 1000)} s, ${d.method === 'tcp' ? 'by connection time' : 'by ping'}`);
      if (d.picked && d.picked.length) html += `<h4>Closest server, picked every ${Math.round((d.pickEveryMs || 600000) / 60000)} min</h4>` + d.picked.map((p) => row(p.name, p.ms != null ? M.pingMs(p.ms) : /look up/.test(p.why || '') ? 'name not found' : 'no reply')).join('');
    }
    const ping = o.stat === 'ping';
    if (d.reason) html += `<div class="info${ping ? (d.state !== 'ok' && d.state !== 'measuring' ? ' bad' : '') : d.pct == null && d.used == null && d.down == null ? ' bad' : ''}">${esc(d.reason)}</div>`;
    if (ping && d.test) html += `<div class="info">${esc(d.test)}</div>`;
    if (ping && window.PingTest) html += window.PingTest.html();   // the ping test (lane pingtest): pingtest.js
    if (!d.top && o.stat !== 'net' && !ping) html += '<div class="info">Top processes arrive with the next sample.</div>';
    if (!ping) html += '<div class="sep"></div><div class="r" data-act="taskmgr"><span class="ck"></span><span class="lb">Open Task Manager</span><span class="kb">Ctrl+Shift+Esc</span><span class="ar"></span></div>';
    // The 1 s sample refreshes the SAME element: a new one each second replayed the fade-in and
    // lost the scroll position.
    let dd = menusEl.querySelector('.dd.stat');
    if (!dd || dd._owner !== o) {
      menusEl.innerHTML = '';
      dd = document.createElement('div');
      dd.className = 'dd stat' + (o.shown ? '' : ' anim');
      dd._owner = o;
      menusEl.appendChild(dd);
    }
    const scroll = dd.scrollTop;
    dd.style.maxHeight = '';
    dd.innerHTML = html;
    if (ping && window.PingTest) window.PingTest.after(dd);   // the ping test's name box keeps its text and focus
    if (d.cores) dd.querySelectorAll('.core i').forEach((el, k) => { el.style.height = Math.max(0, Math.min(100, d.cores[k] || 0)) + '%'; });
    const b = rightEl.querySelector(`[data-k="${o.stat}"]`);
    const x = b ? b.getBoundingClientRect().right - dd.getBoundingClientRect().width : 8;
    dd.style.left = Math.max(4, Math.round(x)) + 'px';
    fitDown(dd, 0);
    dd.scrollTop = scroll;
    placeGlass(dd, 0);
    notifyMain();
  }

  /* ---- input ------------------------------------------------------------------------------- */
  leftEl.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.t');
    if (!b) return;
    e.preventDefault();
    const i = +b.dataset.i;
    if (S.open && S.open.ti === i) closeAll(true); else openMenu(i);
  });
  leftEl.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.t');
    if (b && S.open && !S.open.stat && !S.open.tool && S.open.ti !== +b.dataset.i) openMenu(+b.dataset.i);   // Mac: slide across the titles
  });
  rightEl.addEventListener('mousedown', (e) => {
    const tb = e.target.closest('.tool');
    if (tb) { e.preventDefault(); toolClick(tb.dataset.tool, tb); return; }
    const b = e.target.closest('.st');
    if (!b) return;
    e.preventDefault();
    if (S.open && S.open.stat === b.dataset.k) closeAll(true); else openStat(b.dataset.k);
  });
  let hoverT = 0;
  menusEl.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.r');
    if (!r || !S.open || S.open.stat) return;
    const level = +r.dataset.l, i = +r.dataset.r;
    const lv = S.open.stack[level];
    if (lv.sel === i) return;
    lv.sel = i;
    S.open.stack.length = level + 1;
    renderMenus();
    clearTimeout(hoverT);
    if (lv.items[i] && lv.items[i].items) hoverT = setTimeout(() => { if (S.open && S.open.stack[level] === lv && lv.sel === i) openSub(level, i); }, HOVER_SUB_MS);
  });
  menusEl.addEventListener('mouseup', (e) => {
    const r = e.target.closest('.r');
    if (!r) return;
    if (r.dataset.act === 'taskmgr') { closeAll(false); openTaskMgr(); return; }
    if (window.PingTest && window.PingTest.act(r.dataset.act)) return;   // Run ping test / Cancel: the menu stays open
    activate(+r.dataset.l, +r.dataset.r);
  });
  document.addEventListener('mousedown', (e) => {
    // A click on a title re-renders the bar first, so its target is already detached here.
    if (S.open && e.target.isConnected && !e.target.closest('.dd') && !e.target.closest('#bar')) closeAll(false);   // click-away
  });
  window.addEventListener('blur', () => closeAll(false));
  // Every resize re-sizes the strip: a window growing PAST its screen keeps the same visible width,
  // so only the strip's end moves (the Electron probe's case C, 2026-09-25: 1536 -> 1920 DIP while
  // hidden). A new visible width re-fits the left too; the height changes every time a menu opens,
  // and an open menu keeps its fit anyway (layoutLeft).
  window.addEventListener('resize', () => {
    const before = S.vis;
    if (sizeBar() !== before && !S.open) layoutLeft();
    if (S.open) reveal();   // the window grew to the menu: show what now fits whole
  });
  document.addEventListener('keydown', (e) => {
    const o = S.open;
    if (!o) return;
    if (window.PingTest && window.PingTest.key(e)) return;   // typing into the ping test's name box (pingtest.js)
    if (S.edit && e.target && e.target.classList && e.target.classList.contains('lbi')) {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); S.edit = null; renderMenus(); }
      return;   // every other key types into the box
    }
    const level = o.stat ? 0 : o.stack.length - 1;
    const lv = o.stat ? null : o.stack[level];
    switch (e.key) {
      case 'Escape': if (lv && level > 0) { o.stack.pop(); renderMenus(); } else closeAll(true); break;
      case 'ArrowDown': if (lv) move(level, 1); break;
      case 'ArrowUp': if (lv) move(level, -1); break;
      // a tool's menu is not one of the app's titles: Left / Right do not walk into them
      case 'ArrowRight': if (lv && lv.items[lv.sel] && lv.items[lv.sel].items) { openSub(level, lv.sel); move(level + 1, 1); } else if (!o.tool) stepTitle(1); break;
      case 'ArrowLeft': if (lv && level > 0) { o.stack.pop(); renderMenus(); } else if (!o.tool) stepTitle(-1); break;
      case 'Enter': case ' ': if (lv && lv.sel >= 0) activate(level, lv.sel); break;
      default: {
        if (!lv || e.key.length !== 1) return;
        // the timer's menu: typing a number starts the custom length with it ("12" Enter = 12 min)
        if (o.tool === 'timer' && level === 0 && /^[0-9]$/.test(e.key)) {
          const j = lv.items.findIndex((it) => it.act === 'timerCustom');
          // the box already open but this key missed it (the input had no focus): add to it, never restart it
          if (j >= 0) { S.armed = null; S.edit = S.edit && S.edit.item === lv.items[j] ? { item: S.edit.item, value: (S.edit.value + e.key).slice(0, S.edit.item.maxlength || 12) } : { item: lv.items[j], value: e.key }; lv.sel = j; lv.info = null; lv.bad = false; renderMenus(); e.preventDefault(); return; }
        }
        const k = e.key.toLowerCase();
        const j = lv.items.findIndex((it) => it.t !== 'sep' && it.enabled !== false && (it.mn === k || (!it.mn && (it.label || '').toLowerCase().startsWith(k))));
        if (j < 0) return;
        lv.sel = j;
        if (lv.items[j].items) openSub(level, j); else activate(level, j);
      }
    }
    e.preventDefault();
  });

  /* ---- from main ----------------------------------------------------------------------------- */
  function takeFocus(f) {
    if (!f || f.self) return;                 // Mantle's own windows (this bar, the launcher) keep the last app
    const same = S.focus && S.focus.hwnd === f.hwnd;
    S.focus = f;
    S.menu = f.menu || null;
    if (!same && S.open) { S.open = null; S.armed = null; menusEl.innerHTML = ''; tellClosed(false); }
    renderBar();
    if (!S.menu && f.uia === 'try' && !S.uia[f.hwnd]) {
      const h = f.hwnd;
      call('topbar.uia', { hwnd: h }).then((r) => {
        S.uia[h] = r && r.menu ? r.menu : { source: 'none', items: [], reason: (r && (r.reason || r.error)) || 'no reason came back' };
        if (S.focus && S.focus.hwnd === h && !S.open) renderBar();
      });
    }
  }
  mantle.on('topbar.focus', takeFocus);
  /* WINDOW LAYOUTS (lane layouts): the menus follow lib/features/layouts.js; the name box's text is
     kept on every keystroke (a hover re-renders the menu). The result shows in the layouts pop-up;
     a refusal also shows here, as every menu action's does. */
  mantle.on('layouts.state', (st) => { M.layoutMenus(M.MANTLE_MENU, st); });
  // Mantle Settings can flip "Keep the top bar over full-screen games" too (lane settings): the tick follows.
  mantle.on('topbar.state', (st) => {
    const og = M.MANTLE_MENU.find((i) => i.act === 'overGames');
    if (og && st && typeof st.overGames === 'boolean') og.checked = st.overGames;
  });
  document.addEventListener('input', (e) => { if (S.edit && e.target && e.target.classList && e.target.classList.contains('lbi')) S.edit.value = e.target.value; });
  function commitEdit() {
    const ed = S.edit;
    if (!ed) return;
    if (ed.item.act === 'timerCustom') {   // the timer's length: checked here first, so a typo keeps the box and says why
      const C = TC();
      const v = C ? C.parseDuration(ed.value) : { ok: false, reason: 'the timer\'s script did not load' };
      if (!v.ok) {
        const lv = S.open && S.open.stack[S.open.stack.length - 1];
        if (lv) { lv.info = v.reason; lv.bad = true; }
        renderMenus();
        return;
      }
      S.edit = null;
      closeAll(true);
      call('timer.start', { text: ed.value }).then((r) => { if (r && r.ok === false) setNote('Timer: ' + (r.reason || r.error || 'it did not start, and no reason came back')); });
      return;
    }
    const renaming = ed.item.act === 'layoutRename';
    const label = renaming ? 'Rename ' + ed.item.layout : 'Save layout';
    const p = renaming ? call('layouts.rename', { from: ed.item.layout, to: ed.value }) : call('layouts.save', { name: ed.value });
    S.edit = null;
    closeAll(true);
    p.then((r) => { if (r && r.ok === false) setNote(label + ': ' + (r.reason || r.error || 'it did not happen, and no reason came back')); });
  }
  mantle.on('topbar.title', (ev) => {
    if (!S.focus || ev.hwnd !== S.focus.hwnd) return;
    S.focus.title = ev.title;
    if (ev.menuChanged) { S.menu = ev.menu || null; if (!S.open) renderBar(); }
  });
  mantle.on('topbar.geometry', (ev) => { if (S.focus && ev.hwnd === S.focus.hwnd) { S.focus.zoomed = ev.zoomed; S.focus.fullscreen = ev.fullscreen; } });
  mantle.on('topbar.uia', (ev) => { if (ev && ev.hwnd) { S.uia[ev.hwnd] = ev.menu; if (!S.open) renderBar(); } });
  mantle.on('topbar.stats', (ev) => {
    if (ev && ev.paused) { S.paused = ev.reason || 'paused'; renderStats(); return; }
    S.paused = null;
    S.stats = ev;
    if (S.open && S.open.stat) renderStatMenu(S.open);   // in place: no re-fade, scroll kept
    renderStats();
  });
  mantle.on('topbar.note', (ev) => setNote(ev && ev.text));
  mantle.on('topbar.close', () => closeAll(false));
  // PEEK (lane tbpeek): hidden by hand, the bar came out because the cursor rested on the top edge.
  // Its Mantle menu then offers "Show top bar" (for good) where "Hide top bar" would be a no-op.
  mantle.on('topbar.peek', (ev) => setPeek(!!(ev && ev.on)));
  // THE TWO SMALL TOOLS (lane tbtools): lib/features/timer.js and lib/features/notes.js
  mantle.on('timer.state', (st) => {
    const was = S.timer;
    S.timer = st && typeof st === 'object' ? st : null;
    // main's clock, when it is not this page's (a fake one in the self-test); real clocks agree within ms
    const skew = S.timer && typeof S.timer.now === 'number' ? S.timer.now - Date.now() : 0;
    S.timerSkew = Math.abs(skew) > 2000 ? skew : 0;
    renderStats();
    retick();
    refreshToolMenu();
    const d = S.timer && S.timer.done;
    if (d && d.popup === 'failed' && !(was && was.done && was.done.endAt === d.endAt && was.done.popup === 'failed')) setNote(`Timer done: ${d.label || ''}`);
  });
  mantle.on('notes.state', (st) => { S.notes = st && typeof st === 'object' ? st : null; renderStats(); });
  document.addEventListener('visibilitychange', retick);

  /* ---- THE GLASS, dark only (lane see-topbar, 2026-10-09) ------------------------------------
     Main (lib/features/_topbar-glass.js) sends 'topbar.backdrop' {png, under, ms}: a 1/4-scale
     picture of the desktop's own top strip, the thing really under this window (lib/topbar-strip.js),
     with `under` = Windows' wallpaper where the desktop page draws none; or {off, why, failure, keep}.
     #bdrop shows it, #bar's backdrop-filter blurs it (topbar.css). The tint is solved from the picture:
     the thinnest one (never under --lg-fill) at which ink-2, the quietest word on the strip, reads
     >= 4.5:1 against the brightest pixel of the blurred picture (model.js glassTint). A FAILURE says
     why, in the Mantle menu's first row and once on the strip; light / a peek / a full-screen window
     under the bar are the design, not a fault, and only put the bar on its fallback tint. */
  const GM = window.TopbarGlass;   // ui/topbar/glass.js: the pure parts
  const bdropEl = document.getElementById('bdrop');
  const GS = { png: null, under: null, seq: 0, settle: null, why: null, failure: false, tint: null, solve: null };
  window.__topbarGlass = GS;   // read-only, for the shots / the --test harness
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function glassOff(why, failure, keep) {
    const was = GS.failure ? GS.why : null;
    GS.why = why || null; GS.failure = !!failure;
    GM.glassMenu(M.MANTLE_MENU, GS.failure ? GS.why : null);
    if (GS.failure && GS.why !== was) setNote('The top bar is not frosted: ' + GS.why);
    if (keep && GS.png) return;   // hidden: the last picture waits for the next show
    GS.png = null; GS.under = null; GS.settle = null; GS.seq++;
    document.body.classList.remove('glass');
    bdropEl.style.backgroundImage = '';
    barEl.style.removeProperty('--tb-tint');
  }
  function setBackdrop(p) {
    if (!p || p.off) { glassOff(p && p.why, p && p.failure, p && p.keep); return; }
    const ok = (s) => typeof s === 'string' && s.slice(0, 5) === 'data:';
    if (!ok(p.png) || (p.under != null && !ok(p.under))) {
      glassOff('Mantle sent the top bar a picture of the desktop it cannot use', true, false);
      return;
    }
    if (GS.failure) GM.glassMenu(M.MANTLE_MENU, null);
    GS.why = null; GS.failure = false;
    GS.png = p.png; GS.under = p.under || null;
    bdropEl.style.backgroundImage = 'url("' + p.png + '")' + (p.under ? ', url("' + p.under + '")' : '');
    document.body.classList.add('glass');
    solveTint(++GS.seq);
  }
  // The tint for THIS picture. Until it is solved the bar shows --lg-fill-fb's weight (no flash of a
  // too-thin tint over a bright picture): the first solve lands within a frame or two.
  function loadImg(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('the picture did not decode')); im.src = src; });
  }
  async function solveTint(seq) {
    if (!GS.settle) barEl.style.setProperty('--tb-tint', cssVar('--lg-fill-fb') || 'rgba(30,31,34,.56)');
    let im, un = null;
    try { im = await loadImg(GS.png); if (GS.under) un = await loadImg(GS.under); } catch (e) {
      if (seq === GS.seq) glassOff('the picture of the desktop under the bar did not decode', true, false);
      return;
    }
    if (seq !== GS.seq) return;   // a newer picture is on its way
    const w = im.naturalWidth, h = im.naturalHeight;
    if (!w || !h) return;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (un) g.drawImage(un, 0, 0, w, h);
    g.drawImage(im, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const f = GM.parseFilter(cssVar('--lg-blur'));
    const cssW = bdropEl.clientWidth || barEl.clientWidth || window.innerWidth || w;
    // the bars' own token (lane same-bars, FINAL RULES: Helm's strip, --lg-fill-bar .75) is the floor and
    // the colour; the ceiling is --lg-fill-pop: the shared guard's inputs (glass-adapt.js guardTokens {bar})
    const GT = window.MantleGlassAdapt && window.MantleGlassAdapt.guardTokens(getComputedStyle(document.documentElement), { bar: true });
    const fill = (GT && GT.fill) || GM.parseColor(cssVar('--lg-fill')) || { r: 30, g: 31, b: 34, a: 0.50 };
    const ceil = { a: GT && GT.ceil != null ? GT.ceil : ((GM.parseColor(cssVar('--lg-fill-pop')) || { a: 0.82 }).a) };
    const ink = (GT && GT.ink) || GM.parseColor(cssVar('--lg-ink-2')) || { r: 196, g: 199, b: 206 };
    const px = GM.glassPixels(data, w, h, { sigma: f.blur * (w / cssW), saturate: f.saturate, brightness: f.brightness });
    const GA = window.MantleGlassAdapt;   // the shared guard's need (4.7: the drawn strip peaked at 4.41 when the model said 4.58)
    const r = GM.glassTint({ px, ink, tint: fill, need: (GT && GT.need) || (GA && GA.GUARD && GA.GUARD.need) || 4.7, floor: fill.a, ceil: ceil.a, step: 0.02 });
    GS.solve = r;
    // dark + look sync on: the SHARED top-band alpha (lane guard-mantle) replaces this bar's own guard
    const b = GM.barAlpha(isDark() ? GS.lookGuard : null, r.alpha, GS.settle);
    GS.settle = b.settle; GS.source = b.source;
    GS.tint = b.alpha;
    barEl.style.setProperty('--tb-tint', 'rgba(' + fill.r + ',' + fill.g + ',' + fill.b + ',' + GS.tint + ')');
  }
  mantle.on('topbar.backdrop', setBackdrop);
  /* THE SHARED TOP-BAND DARKENING (lane guard-mantle, 2026-10-10; main: lib/features/_topbar-glass.js
     makeLookGuard): {use, alpha} or {use:false, why, failure}. A failure says why in the Mantle menu's
     first rows and once on the strip; the bar keeps its own guard meanwhile. */
  GS.lookGuard = null; GS.source = 'own';
  mantle.on('topbar.guard', (g) => {
    const was = GS.lookGuard && GS.lookGuard.failure ? GS.lookGuard.why : null;
    GS.lookGuard = GM.lookGuardOf(g);
    const why = GS.lookGuard.failure ? GS.lookGuard.why : null;
    GM.guardMenu(M.MANTLE_MENU, why);
    if (why && why !== was) setNote('Top bar darkening: ' + why);
    if (GS.png) solveTint(++GS.seq);
  });
  // a theme change re-reads the tokens: the next picture is solved against the new ones
  // An OPEN menu is laid out again in the new theme's metrics (dark is Helm's: 30 px rows, padding 4/5x10,
  // so the same menu is taller), which re-asks main for the window's height and waits (.wait) until it
  // has grown; it would otherwise stay hidden or cut at the old height (Windows' own light/dark switch
  // can land while a menu is open). Into dark: its glass session starts there; out of it: it ends.
  window.addEventListener('mantle-theme', () => {
    if (GS.png) solveTint(++GS.seq);
    if (!S.open) return;
    if (!isDark()) menuGlassEnd();
    renderMenus();
  });

  /* ---- THE DROPDOWNS' GLASS, dark only (lane same-bars, 2026-10-09) ---------------------------
     THE ONE RECIPE (topbar.css .dd.glass): a blurred picture of what is behind the menu + ONE tint.
     A menu SESSION (S.open going from nothing to a menu, until tellClosed) asks main ONCE for its
     picture (glass.topbarMenu -> {png, w, h, at}: the screen under this window's width, from its top
     to the work area's bottom, in CSS px of this page; the bar is left out of it). Hovers, submenus,
     the 1 s stat sample and sliding across the titles all reuse it. The picture is blurred ONCE on a
     canvas with the token's own --lg-blur (its blur rescaled to picture px; edges clamped so no
     transparent black is pulled in; NO extra brightness) and set on #menus as --dd-bd, inherited by
     every dropdown, which places it at the screen position it covers. The tint per dropdown is the
     shared guard's (MantleGlassAdapt.guardRect over the UNBLURRED picture, blurred once in
     glassPicture): --lg-fill, thicker only where ink-2 would fall under 4.5:1.
     PRE-SHOW: until the picture is ready (or MENU_PRESHOW_MS pass) the dropdowns wait hidden
     (#menus.pre), so the first one never flashes from the fallback to glass. A failure or a timeout
     shows them on the fallback face (one layer of --lg-fill-pop) and the strip says why, once per
     reason; a picture that lands after the menu showed is not swapped in (that would be the flash). */
  const MENU_PRESHOW_MS = 250;
  const GA = window.MantleGlassAdapt;
  const MG = { seq: 0, cur: null, said: null };
  GS.menu = null;   // read-only view for the shots: {state, why, shotMs, readyMs, visibleMs, levels[]}
  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());
  function menuGlassStart() {
    if (MG.cur || !isDark()) return;
    const ses = MG.cur = { seq: ++MG.seq, t0: now(), state: 'waiting', baked: null, cache: {}, timer: 0 };
    GS.menu = { seq: ses.seq, state: 'waiting', why: null, shotMs: null, readyMs: null, visibleMs: null, levels: [] };
    menusEl.classList.add('pre');
    ses.timer = setTimeout(() => menuGlassSettle(ses, null, `its picture of the screen took longer than ${MENU_PRESHOW_MS} ms`), MENU_PRESHOW_MS);
    call('glass.topbarMenu').then((r) => menuGlassLoad(ses, r), (e) => menuGlassSettle(ses, null, (e && e.message) || String(e)));
  }
  async function menuGlassLoad(ses, r) {
    if (MG.cur !== ses || ses.state !== 'waiting') return;
    const at = r && r.at;
    if (!r || r.ok === false || typeof r.png !== 'string' || r.png.slice(0, 5) !== 'data:' || !at || !(at.w > 0) || !(at.h > 0)) {
      menuGlassSettle(ses, null, (r && r.reason) || 'Mantle sent no usable picture of the screen under it');
      return;
    }
    const v = GS.menu && GS.menu.seq === ses.seq ? GS.menu : {};
    v.shotMs = r.ms != null ? r.ms : null;
    v.replyAt = Math.round(now() - ses.t0);
    let im;
    try { im = await loadImg(r.png); } catch (_) { menuGlassSettle(ses, null, 'its picture of the screen did not decode'); return; }
    if (MG.cur !== ses || ses.state !== 'waiting') return;
    v.decodedAt = Math.round(now() - ses.t0);
    const baked = bakeMenu(im, at, v);
    v.bakedAt = Math.round(now() - ses.t0);
    menuGlassSettle(ses, baked.url ? baked : null, baked.url ? null : baked.why);
  }
  // The picture as the glass shows it, and the guard's view of it. -> {url, pic, T, sx, sy, at} or {why}
  function bakeMenu(im, at, v) {
    v = v || {};
    const t = now();
    try {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!w || !h) return { why: 'its picture of the screen is empty' };
      const sx = w / at.w, sy = h / at.h;
      const cs = getComputedStyle(document.documentElement);
      let sigma = 0;
      const f = cs.getPropertyValue('--lg-blur').trim().replace(/blur\(\s*([\d.]+)px\s*\)/, (_, b) => { sigma = parseFloat(b) * sx; return 'blur(' + sigma.toFixed(2) + 'px)'; });
      const P = Math.max(1, Math.ceil(sigma * 3));
      const a = document.createElement('canvas'); a.width = w + 2 * P; a.height = h + 2 * P;
      const ga = a.getContext('2d');
      ga.imageSmoothingEnabled = false;
      ga.drawImage(im, P, P);
      ga.drawImage(im, 0, 0, 1, h, 0, P, P, h);              // the edges, stretched out into the margin
      ga.drawImage(im, w - 1, 0, 1, h, P + w, P, P, h);
      ga.drawImage(im, 0, 0, w, 1, P, 0, w, P);
      ga.drawImage(im, 0, h - 1, w, 1, P, P + h, w, P);
      ga.drawImage(im, 0, 0, 1, 1, 0, 0, P, P);              // and the four corners
      ga.drawImage(im, w - 1, 0, 1, 1, P + w, 0, P, P);
      ga.drawImage(im, 0, h - 1, 1, 1, 0, P + h, P, P);
      ga.drawImage(im, w - 1, h - 1, 1, 1, P + w, P + h, P, P);
      const b = document.createElement('canvas'); b.width = w; b.height = h;
      const gb = b.getContext('2d');
      gb.filter = f || 'none';   // the token's filter, nothing added
      gb.drawImage(a, -P, -P);
      const url = b.toDataURL('image/png');
      v.blurMs = Math.round(now() - t);
      if (!GA) return { why: 'the shared glass rule (glass-adapt.js) did not load' };
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const gc = c.getContext('2d', { willReadFrequently: true });
      gc.drawImage(im, 0, 0);
      const T = GA.guardTokens(cs);
      const data = gc.getImageData(0, 0, w, h).data;
      if (!data || !T) return { why: 'the shared glass rule could not read its picture' };
      v.readMs = Math.round(now() - t) - v.blurMs;
      return { url, data, w, h, T, sx, sy, at };
    } catch (e) {
      return { why: `its picture could not be blurred on a canvas (${(e && e.message) || e})` };
    }
  }
  function menuGlassSettle(ses, baked, why) {
    if (MG.cur !== ses || ses.state !== 'waiting') return;
    clearTimeout(ses.timer); ses.timer = 0;
    ses.state = baked ? 'glass' : 'fallback';
    ses.baked = baked;
    const v = GS.menu && GS.menu.seq === ses.seq ? GS.menu : null;
    if (v) { v.state = ses.state; v.why = why || null; v.readyMs = Math.round(now() - ses.t0); }
    if (baked) {
      menusEl.style.setProperty('--dd-bd', 'url("' + baked.url + '")');
      menusEl.style.setProperty('--dd-bd-size', baked.at.w + 'px ' + baked.at.h + 'px');
      MG.said = null;
    } else if (why && why !== MG.said) {
      MG.said = why;
      setNote('The menu is not frosted: ' + why);
    }
    menusEl.classList.remove('pre');
    for (const dd of menusEl.children) placeGlass(dd, dd._level || 0);
    const waiting = reveal();
    if (v && !waiting && menusEl.children.length) v.visibleMs = Math.round(now() - ses.t0);
  }
  function menuGlassEnd() {
    const ses = MG.cur;
    if (!ses) return;
    clearTimeout(ses.timer);
    MG.cur = null;
    menusEl.classList.remove('pre');
    menusEl.style.removeProperty('--dd-bd');
    menusEl.style.removeProperty('--dd-bd-size');
  }
  /* The shared guard (MantleGlassAdapt.glassPicture + guardRect, the strip's rule and thresholds) for ONE
     dropdown's rectangle (picture px). Blurring the whole picture in JS cost ~170 ms at 1920x1080@125%
     (600x337 px), most of the 250 ms pre-show hold, so only the rectangle plus a margin wider than the
     blur kernel (3 sigma + 2 px) is cut out and blurred: every pixel under the dropdown reads exactly the
     neighbours it reads in the whole picture (the margin's mirrored edge is never reached), and a crop
     that meets the picture's real edge mirrors there as the whole picture does. Same answer, ~1/20 the
     work; cached per rectangle by placeGlass. */
  function menuGuard(b, rr, whole) {
    const W = b.w, H = b.h;
    const pad = whole ? Math.max(W, H) : Math.ceil(3 * ((b.T.filter && b.T.filter.blur) || 0) * b.sx) + 2;
    const x0 = Math.max(0, Math.floor(rr.x) - pad), y0 = Math.max(0, Math.floor(rr.y) - pad);
    const x1 = Math.min(W, Math.ceil(rr.x + rr.w) + pad), y1 = Math.min(H, Math.ceil(rr.y + rr.h) + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    const cw = x1 - x0, ch = y1 - y0, sub = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) sub.set(b.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4), y * cw * 4);
    const pic = GA.glassPicture({ data: sub, width: cw, height: ch }, b.T, b.sx);
    return GA.guardRect(pic, b.T, { x: rr.x - x0, y: rr.y - y0, w: rr.w, h: rr.h });
  }
  // for the shots only: the crop's answer against the whole picture's, for every open dropdown
  GS.menuGuardCompare = () => {
    const ses = MG.cur;
    if (!ses || !ses.baked) return null;
    const b = ses.baked, at = b.at;
    return [...menusEl.children].map((dd) => {
      const r = dd.getBoundingClientRect(), rr = { x: (r.left - at.x) * b.sx, y: (r.top - at.y) * b.sy, w: r.width * b.sx, h: r.height * b.sy };
      const t0 = now(), crop = menuGuard(b, rr), t1 = now(), whole = menuGuard(b, rr, true), t2 = now();
      return { crop, whole, cropMs: Math.round(t1 - t0), wholeMs: Math.round(t2 - t1) };
    });
  };
  // One dropdown on the session's picture: the piece of it the dropdown covers, and the guard's tint
  // for exactly that rectangle (cached per rectangle: a hover re-renders the same boxes).
  function placeGlass(dd, level) {
    dd._level = level;
    const ses = MG.cur;
    if (!ses || ses.state !== 'glass' || !isDark()) { dd.classList.remove('glass'); return; }
    const b = ses.baked, at = b.at, r = dd.getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 4)).join(',');
    let g = ses.cache[key];
    if (g === undefined) { const t = now(); g = ses.cache[key] = menuGuard(b, { x: (r.left - at.x) * b.sx, y: (r.top - at.y) * b.sy, w: r.width * b.sx, h: r.height * b.sy }); if (GS.menu) GS.menu.guardMs = Math.round(now() - t); }
    if (!g) {   // outside its picture (cannot happen while the picture covers the window): the fallback face
      dd.classList.remove('glass');
      if (GS.menu) GS.menu.levels[level] = { glass: false, why: 'this dropdown lies outside the picture' };
      return;
    }
    dd.style.setProperty('--dd-tint', g.tint);
    dd.style.setProperty('--dd-bd-pos', (at.x - r.left) + 'px ' + (at.y - r.top) + 'px');   // background-origin: border-box
    dd.classList.add('glass');
    if (GS.menu) GS.menu.levels[level] = { glass: true, tint: g.tint, alpha: g.alpha, engaged: g.engaged, ratio: g.ratio, short: g.short };
  }

  renderBar();
  call('topbar.hello').then((r) => {
    if (r && r.focus) takeFocus(r.focus);
    if (r && r.stats) { S.stats = r.stats; renderStats(); }
    if (r && r.note) setNote(r.note);
    const og = M.MANTLE_MENU.find((i) => i.act === 'overGames');
    if (og && r) og.checked = !!r.overGames;
    if (r) setPeek(!!r.peek);
  });
  function setPeek(on) { M.peekMenu(M.MANTLE_MENU, on); }
  // the ping test (lane pingtest, pingtest.js): its events redraw the PING dropdown while it is open
  if (window.PingTest) window.PingTest.init({ call, on: (ev, fn) => mantle.on(ev, fn), rerender: () => { if (S.open && S.open.stat === 'ping') renderMenus(); } });
  window.__topbar = S;   // for shoot.js and the --test harness: read-only inspection
}());
