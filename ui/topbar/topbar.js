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
  const S = { focus: null, menu: null, uia: {}, stats: null, paused: null, note: null, open: null, armed: null, titles: [] };
  const ARM_MS = 4000, ARM_MIN_MS = 300, HOVER_SUB_MS = 110;
  const GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M2 6h12"/></svg>';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const call = (name, args) => Promise.resolve(mantle.call(name, args || {})).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }));
  const menuSource = () => S.menu || (S.focus && S.uia[S.focus.hwnd]) || null;

  /* ---- the strip --------------------------------------------------------------------------- */
  function renderBar() {
    S.titles = M.titles(S.focus, menuSource());
    leftEl.innerHTML = S.titles.map((t, i) =>
      `<button class="t${t.bold ? ' bold' : ''}${t.glyph ? ' glyph' : ''}${t.enabled === false ? ' dim' : ''}${S.open && S.open.ti === i ? ' open' : ''}"` +
      ` data-i="${i}" role="menuitem" aria-haspopup="true" title="${t.glyph ? 'Mantle' : ''}">${t.glyph ? GLYPH : esc(t.label)}</button>`).join('');
    renderStats();
  }

  function renderStats() {
    let html = '';
    if (S.note) html += `<span class="warn" title="${esc(S.note)}">${esc(S.note.length > 60 ? S.note.slice(0, 57) + '…' : S.note)}</span>`;
    if (S.paused) html += `<span class="paused" title="${esc(S.paused)}">stats paused</span>`;
    else {
      html += M.statCells(S.stats).map((c) =>
        `<button class="t st${c.why ? ' na' : ''}${S.open && S.open.stat === c.key ? ' open' : ''}" data-k="${c.key}"` +
        ` title="${esc(c.why || '')}"><span class="k">${c.label}</span><span class="v">${esc(c.value)}</span></button>`).join('');
    }
    rightEl.innerHTML = html;
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

  function renderMenus() {
    menusEl.innerHTML = '';
    const o = S.open;
    if (!o) return;
    if (o.stat) { renderStatMenu(o); return; }
    o.stack.forEach((lv, level) => {
      const dd = document.createElement('div');
      dd.className = 'dd';
      dd.setAttribute('role', 'menu');
      let html = lv.items.length ? lv.items.map((it, i) => rowHtml(it, i, lv.sel, level)).join('') : '';
      if (lv.info) html += `<div class="info${lv.bad ? ' bad' : ''}">${esc(lv.info)}</div>`;
      if (!lv.items.length && !lv.info) html += '<div class="info">This menu is empty.</div>';
      dd.innerHTML = html;
      dd.style.left = lv.x + 'px';
      if (lv.y != null) dd.style.top = lv.y + 'px';
      menusEl.appendChild(dd);
      // keep a submenu on screen: flip it to the left of its parent when it would run off the right
      const r = dd.getBoundingClientRect();
      if (r.right > window.innerWidth - 4) dd.style.left = Math.max(4, (level > 0 ? lv.flipX : window.innerWidth - 4 - r.width)) + 'px';
      lv.el = dd;
    });
    notifyMain();
  }

  function titleX(ti) {
    const b = leftEl.querySelector(`[data-i="${ti}"]`);
    return b ? Math.round(b.getBoundingClientRect().left) : 8;
  }

  function openMenu(ti) {
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
    }
  }

  function closeAll(refocus) {
    if (!S.open) return;
    S.open = null;
    S.armed = null;
    menusEl.innerHTML = '';
    renderBar();
    call('topbar.menuState', { open: false, refocus: !!refocus });
  }

  function notifyMain() {
    let bottom = 28;
    for (const dd of menusEl.children) bottom = Math.max(bottom, Math.ceil(dd.getBoundingClientRect().bottom) + 8);
    call('topbar.menuState', { open: true, height: bottom });
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
    const n = S.titles.length;
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
      if (d.cores && d.cores.length) html += '<div class="cores">' + d.cores.map((c) => `<div class="core" title="${M.pct(c)}"><i style="height:${Math.max(0, Math.min(100, c || 0))}%"></i></div>`).join('') + '</div>';
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
    const dd = document.createElement('div');
    dd.className = 'dd stat';
    dd.innerHTML = html;
    menusEl.appendChild(dd);
    const b = rightEl.querySelector(`[data-k="${o.stat}"]`);
    const x = b ? b.getBoundingClientRect().right - dd.getBoundingClientRect().width : 8;
    dd.style.left = Math.max(4, Math.round(x)) + 'px';
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
    if (!same && S.open) { S.open = null; menusEl.innerHTML = ''; call('topbar.menuState', { open: false, refocus: false }); }
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
    if (S.open && S.open.stat) { menusEl.innerHTML = ''; renderStatMenu(S.open); }
    renderStats();
  });
  mantle.on('topbar.note', (ev) => setNote(ev && ev.text));
  mantle.on('topbar.close', () => closeAll(false));

  renderBar();
  call('topbar.hello').then((r) => {
    if (r && r.focus) takeFocus(r.focus);
    if (r && r.stats) { S.stats = r.stats; renderStats(); }
    if (r && r.note) setNote(r.note);
    const og = M.MANTLE_MENU.find((i) => i.act === 'overGames');
    if (og && r) og.checked = !!r.overGames;
  });
  window.__topbar = S;   // for shoot.js and the --test harness: read-only inspection
}());
