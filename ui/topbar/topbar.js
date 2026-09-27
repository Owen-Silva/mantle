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
              fit: null, vis: 0, rightKey: null, asked: null, waitT: 0 };
  const ARM_MS = 4000, ARM_MIN_MS = 300, HOVER_SUB_MS = 110;
  const APP_MIN = 96;   // the app's name ellipsizes down to this before any menu moves into »
  const GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M2 6h12"/></svg>';

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
        `<button class="t st${c.why ? ' na' : ''}${S.open && S.open.stat === c.key ? ' open' : ''}" data-k="${c.key}"` +
        ` title="${esc(c.why || '')}"><span class="k">${c.label}</span><span class="v">${esc(c.value)}</span></button>`).join('');
    }
    rightEl.innerHTML = html;
    // a note or "stats paused" changes how much room the left side has: re-fit it (not on every
    // 1 s sample: the cells keep their width, so the key does not change). The window's width is in
    // the key too, so the 1 s samples also catch a resize whose event never came.
    const key = Math.round(rightEl.getBoundingClientRect().width) + '/' + visibleWidth() + '/' + window.innerWidth;
    if (key !== S.rightKey) { S.rightKey = key; if (!fromBar) { sizeBar(); layoutLeft(); } }
  }

  /* ---- dropdowns --------------------------------------------------------------------------- */
  function rowHtml(it, i, sel, level) {
    if (it.t === 'sep') return '<div class="sep"></div>';
    const armed = S.armed && S.armed.item === it;
    const off = it.enabled === false || (it.ownerDraw && !it.label);
    const label = armed ? it.confirm : (it.label || (it.ownerDraw ? '(the app draws this item itself)' : '(untitled)'));
    const ck = it.checked ? (it.radio ? '●' : '✓') : '';
    return `<div class="r${i === sel ? ' sel' : ''}${off ? ' off' : ''}${armed ? ' armed' : ''}" data-l="${level}" data-r="${i}" role="menuitem"` +
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
      // keep a submenu on screen: flip it to the left of its parent when it would run off the right
      const r = dd.getBoundingClientRect(), vis = visibleWidth();
      if (r.right > vis - 4) dd.style.left = Math.max(4, (level > 0 ? lv.flipX : vis - 4 - r.width)) + 'px';
      fitDown(dd, level);
      if (lv.scroll) dd.scrollTop = lv.scroll;
      keepSelVisible(dd, lv.sel);
      lv.el = dd;
    });
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
    menusEl.innerHTML = '';
    renderBar();
    tellClosed(!!refocus);
  }
  // The dropdowns are gone before main shrinks the window back to the bar.
  function tellClosed(refocus) {
    S.asked = null;
    clearTimeout(S.waitT); S.waitT = 0;
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
      else if (dd._owner) dd._owner.shown = true;   // later re-renders do not fade in again
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

  /* ---- doing things ------------------------------------------------------------------------ */
  function activate(level, i) {
    const o = S.open;
    if (!o || o.stat) return;
    const lv = o.stack[level];
    const it = lv.items[i];
    if (!it || it.t === 'sep' || it.enabled === false) return;
    if (it.items) { openSub(level, i); return; }
    if (it.confirm) {
      if (!S.armed || S.armed.item !== it) { S.armed = { item: it, at: Date.now() }; renderMenus(); setTimeout(() => { if (S.armed && S.armed.item === it) { S.armed = null; if (S.open) renderMenus(); } }, ARM_MS); return; }
      if (Date.now() - S.armed.at < ARM_MIN_MS) return;   // a double-click is not two decisions
    }
    const confirmed = !!(it.confirm && S.armed && S.armed.item === it);
    const f = S.focus;
    const src = menuSource();
    let p;
    if (it.act === 'power') p = call('topbar.power', { action: it.power, confirmed });
    else if (it.act === 'about' || it.act === 'settings') p = call('topbar.' + it.act);
    else if (it.act === 'overGames') p = call('topbar.overGames', { on: !it.checked }).then((r) => { if (r && r.ok) it.checked = !!r.overGames; return r; });
    else if (it.act === 'hide') p = call('topbar.hidden', { on: true, via: 'the Mantle menu' });
    else if (it.act === 'show') p = call('topbar.hidden', { on: false, via: 'the Mantle menu, while peeking' });
    else if (it.act === 'newWindow') p = call('topbar.newWindow', { exe: it.exe, args: it.args });
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
    }
    if (d.reason) html += `<div class="info${d.pct == null && d.used == null && d.down == null ? ' bad' : ''}">${esc(d.reason)}</div>`;
    if (!d.top && o.stat !== 'net') html += '<div class="info">Top processes arrive with the next sample.</div>';
    html += '<div class="sep"></div><div class="r" data-act="taskmgr"><span class="ck"></span><span class="lb">Open Task Manager</span><span class="kb">Ctrl+Shift+Esc</span><span class="ar"></span></div>';
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
    if (d.cores) dd.querySelectorAll('.core i').forEach((el, k) => { el.style.height = Math.max(0, Math.min(100, d.cores[k] || 0)) + '%'; });
    const b = rightEl.querySelector(`[data-k="${o.stat}"]`);
    const x = b ? b.getBoundingClientRect().right - dd.getBoundingClientRect().width : 8;
    dd.style.left = Math.max(4, Math.round(x)) + 'px';
    fitDown(dd, 0);
    dd.scrollTop = scroll;
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
    if (b && S.open && !S.open.stat && S.open.ti !== +b.dataset.i) openMenu(+b.dataset.i);   // Mac: slide across the titles
  });
  rightEl.addEventListener('mousedown', (e) => {
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
    if (r.dataset.act === 'taskmgr') { closeAll(false); call('topbar.taskmgr').then((x) => { if (x && x.ok === false) setNote('Task Manager: ' + x.reason); }); return; }
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
    const level = o.stat ? 0 : o.stack.length - 1;
    const lv = o.stat ? null : o.stack[level];
    switch (e.key) {
      case 'Escape': if (lv && level > 0) { o.stack.pop(); renderMenus(); } else closeAll(true); break;
      case 'ArrowDown': if (lv) move(level, 1); break;
      case 'ArrowUp': if (lv) move(level, -1); break;
      case 'ArrowRight': if (lv && lv.items[lv.sel] && lv.items[lv.sel].items) { openSub(level, lv.sel); move(level + 1, 1); } else stepTitle(1); break;
      case 'ArrowLeft': if (lv && level > 0) { o.stack.pop(); renderMenus(); } else stepTitle(-1); break;
      case 'Enter': case ' ': if (lv && lv.sel >= 0) activate(level, lv.sel); break;
      default: {
        if (!lv || e.key.length !== 1) return;
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
  window.__topbar = S;   // for shoot.js and the --test harness: read-only inspection
}());
