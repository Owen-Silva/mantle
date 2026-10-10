/* taskmgr.js — the task manager's page (lib/features/taskmgr.js draws nothing itself).
 *
 * Main pushes `taskmgr.model` after every sample (1.5 s focused, 3 s behind); this page keeps only
 * what is on screen: the view, the sort, the search, the chosen row, which rows are expanded, which
 * row has its Force close confirm open, and the open menu.
 * Rows are KEYED and patched in place (numbers every tick, the rest only when it changes), so a
 * button under the pointer is never swapped out between mousedown and click.
 * Every action's outcome comes back on the row from main (state + why): nothing here guesses.
 *
 * SYSMON PASS (2026-09-29, Owen: "minimalistic and super easy to use and obvious what to do"):
 *   - Search (Ctrl+F, or just start typing) over name, file and window title; Esc clears it.
 *   - Sort by Name / Memory / CPU from the column headers (remembered in this window).
 *   - A chosen row (click, or Up/Down) with Windows' keys: Delete closes, Shift+Delete force closes
 *     (asks first), Enter/Right shows its processes, Left hides them, the menu key opens its menu.
 *   - One primary action per row (Close) on hover or when chosen; the rest in its menu (the "..."
 *     button or a right-click): Force close, Trim memory, Show processes, Open file location.
 *   - "Not responding" apps say so and offer Force close straight away (Close cannot reach them).
 *   - CPU and memory for the whole PC, with their last minutes as a line.
 *   - Loading, empty-search and could-not-read states drawn in the list itself.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const call = (name, args) => (window.mantle ? window.mantle.call(name, args) : Promise.reject(new Error('no bridge to Mantle')));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MB = 1048576;
  // thousands by hand: toLocaleString (ICU) was the page's top cost, ~37 ms a tick over ~200 rows
  const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const mb = (b) => (b >= 0 ? commas(Math.round(b / MB)) + ' MB' : '—');
  const gb = (b) => (b / 1073741824).toFixed(1) + ' GB';
  const pct = (x) => (x >= 0 ? (x < 10 ? x.toFixed(1) : Math.round(x)) + '%' : '');
  const LOCK = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
  // the warn glyph: every reason something went wrong is this + one line of --lg-warn words (no pill)
  const WARN = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1.6 11 10.4H1z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6 5v2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="6" cy="9" r=".6" fill="currentColor"/></svg>';
  const warnLine = (cls, text) => `<span class="${cls}">${WARN}<span>${esc(text)}</span></span>`;
  const CHEV = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/></svg>';
  // an app with no picture: a plain window outline (the same 1.1 stroke family), never a letter
  const APPIC = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 6.5h13" stroke="currentColor" stroke-width="1.1"/></svg>';

  const store = { get(k, d) { try { const v = localStorage.getItem('taskmgr.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('taskmgr.' + k, JSON.stringify(v)); } catch (_) { /* a private profile: the sort just is not remembered */ } } };
  const SORT0 = { by: 'mem', dir: -1 };
  const sort0 = store.get('sort', SORT0);
  const P = { m: null, view: 'apps', open: new Set(), confirm: null, collapsed: new Set(['windows']), note: null, icons: new Map(), hover: false,
    sort: sort0 && ['name', 'mem', 'cpu'].includes(sort0.by) && (sort0.dir === 1 || sort0.dir === -1) ? sort0 : SORT0,
    q: '', sel: null, menu: null, busy: new Set(), order: [] };

  /* g.icon is a REFERENCE (the app's identity); the pictures arrive once each on taskmgr.icons. */
  function icon(g) {
    const url = g.icon ? P.icons.get(g.icon) : null;
    return url ? `<img class="ic" src="${esc(url)}" alt="" decoding="async">` : `<span class="ic tile" title="${esc(g.iconWhy || 'No icon yet')}">${APPIC}</span>`;
  }
  function stateLine(g) {
    if (P.confirm === g.key) {
      return `<div class="st ask" role="alertdialog" aria-label="Force close ${esc(g.name)}?"><span>Force close ${esc(g.name)}? It ends at once and anything unsaved in it is lost.</span><span class="grow"></span>` +
        `<button type="button" class="go" data-act="force-yes">Force close</button><button type="button" data-act="force-no" title="Cancel (Esc)">Cancel</button></div>`;
    }
    const s = g.state;
    if (!s) return '';
    const map = {
      closing: [`Closing…${s.why ? ' ' + s.why : ''}`, ''],
      closed: [`Closed · freed about ${mb(s.freed)}`, 'good'],
      'still-running': [s.why, 'bad'],
      failed: [s.why, 'bad'],
      trimming: ['Trimming memory…', ''],
      trimmed: [`Memory trimmed: ${mb(s.before)} → ${mb(s.after)}${s.why ? ' · ' + s.why : ''}`, 'good'],
      dry: [s.why || 'Test Mantle: nothing was done', ''],
    };
    const [text, cls] = map[s.state] || [s.why || 'Done', ''];
    const force = s.state === 'still-running' && g.actions && g.actions.force ? '<span class="grow"></span><button type="button" data-act="force">Force close</button>' : '';
    return `<div class="st ${cls}" role="status">${cls === 'bad' ? warnLine('', text) : `<span>${esc(text)}</span>`}${force}</div>`;
  }
  /* The words under a row: why it cannot be closed, or may not be. */
  function whyOf(g) {
    const a = g.actions || {};
    return g.protected || (g.game && a.why) || (g.elevated ? 'Runs as administrator: Mantle may not be allowed to close it' : null);
  }
  /* Every reason at least 3 rows of a section share: said ONCE, in full, under the section's header
     (most rows first) instead of under every row. Each of those rows still names its reason on its own
     line: the lock and the reason's short name (the words before its colon), or its admin/game tag. */
  function sharedWhy(rows) {
    const n = new Map(), locked = new Set();
    for (const g of rows) { const w = whyOf(g); if (w) { n.set(w, (n.get(w) || 0) + 1); if (g.protected) locked.add(w); } }
    const out = new Map();
    for (const [w, c] of Array.from(n).sort((x, y) => y[1] - x[1])) if (c >= 3) out.set(w, { c, lock: locked.has(w) });
    return out.size ? out : null;
  }
  const shortWhy = (w) => { const i = w.indexOf(':'); return i > 0 && i <= 40 ? w.slice(0, i) : ''; };
  /* The row's menu: everything it can do, the keys beside them. Empty = no menu button. */
  function menuItems(g) {
    const a = g.actions || {};
    const items = [];
    if (a.close) items.push({ act: 'close', label: 'Close', key: 'Delete' });
    if (a.force) items.push({ act: 'force', label: 'Force close…', key: 'Shift+Delete', danger: true });
    if (a.trim) items.push({ act: 'trim', label: 'Trim memory', hint: 'Hands its unused memory back to Windows; it keeps running' });
    if (g.count > 1) items.push({ act: 'expand', label: P.open.has(g.key) ? 'Hide processes' : `Show its ${g.count} processes`, key: 'Enter' });
    if (g.canReveal) items.push({ act: 'reveal', label: 'Open file location' });
    return items;
  }
  /* The parts of a row that change only when its meaning changes (not every tick). */
  function staticHtml(g, shared) {
    const a = g.actions || {};
    const btns = [];
    // ONE primary action: Close; a frozen app cannot hear Close, so it gets Force close instead
    if (g.hung && a.force) btns.push('<button type="button" class="danger" data-act="force" title="End it now (Shift+Delete). Asks first.">Force close</button>');
    else if (a.close) btns.push('<button type="button" data-act="close" title="Ask it to close, like its own close button (Delete)">Close</button>');
    if (menuItems(g).length) btns.push(`<button type="button" class="more" data-act="menu" aria-haspopup="menu" aria-label="More for ${esc(g.name)}" title="More: force close, trim memory, open file location">${DOTS}</button>`);
    const tags = [g.hung ? '<span class="tag bad">Not responding</span>' : '', g.game ? '<span class="tag">Game</span>' : '', g.handledBy === 'spotify' ? '<span class="tag" title="The Spotify card closes an idle Spotify when a game starts">Spotify card</span>' : '', g.elevated ? '<span class="tag" title="Windows would not let Mantle read it: it runs as administrator or another user">Admin</span>' : ''].join('');
    const why0 = whyOf(g);
    const said = !!(why0 && shared && shared.has(why0));   // the section header says it once
    const why = said ? null : why0;
    const lk = said && g.protected ? `<span class="lk" title="${esc(why0)}">${LOCK}<span>${esc(shortWhy(why0))}</span></span>` : '';
    return `<div class="rmain">` +
      (g.count > 1 ? `<button type="button" class="chev" data-act="expand" tabindex="-1" aria-label="Show its ${g.count} processes" aria-expanded="${P.open.has(g.key)}" title="Show its ${g.count} processes (Enter)">${CHEV}</button>` : '<span></span>') +
      icon(g) +
      `<div class="nm"><span class="n" title="${esc(g.title && g.title !== g.name ? `${g.name} · ${g.title}` : g.name)}">${esc(g.name)}</span>${g.count > 1 ? `<span class="k">(${g.count})</span>` : ''}${tags}${lk}</div>` +
      `<span class="mem"></span><span class="cpu"></span><div class="acts${g.hung ? ' always' : ''}">${btns.join('')}</div>` +
      (why ? `<div class="why">${g.protected ? LOCK : ''}<span>${esc(why)}</span></div>` : '') +
      `</div><div class="stw"></div><div class="mw"></div>`;
  }
  function membersHtml(g) {
    if (!P.open.has(g.key)) return '';
    if (!g.members) return '<div class="members"><div class="mrow quiet"><span>Loading its processes…</span></div></div>';
    return '<div class="members">' + g.members.map((m) => `<div class="mrow"><span title="${esc(m.file)}">${esc(m.file)} <span class="pid">PID ${m.pid}</span>${m.windows ? ' · window' : ''}</span><span>${mb(m.mem)}</span><span>${pct(m.cpu)}</span><span></span></div>`).join('') + '</div>';
  }

  /* Keyed patching: one element per row key, rebuilt only when its static part changes.
     While the pointer is over the list (or a row's menu is open) the ORDER holds (rows already there
     keep their places, new ones go to the end): a row never slides out from under the cursor between
     hover and click. Leaving the list re-sorts it. */
  function patchList(host, rows, build, sig) {
    const have = new Map(Array.from(host.children).filter((e) => e.dataset.key).map((e) => [e.dataset.key, e]));
    if ((P.hover || P.menu) && have.size) {
      const pos = new Map(Array.from(have.keys()).map((k, i) => [k, i]));
      rows = rows.slice().sort((a, b) => (pos.has(a.key) ? pos.get(a.key) : 1e9) - (pos.has(b.key) ? pos.get(b.key) : 1e9));
    }
    let prev = null;
    for (const r of rows) {
      let el = have.get(r.key);
      if (el) have.delete(r.key);
      else { el = document.createElement('div'); el.dataset.key = r.key; }
      build(el, r, sig);
      const want = prev ? prev.nextSibling : host.firstChild;
      if (want !== el) host.insertBefore(el, want);
      prev = el;
    }
    for (const el of have.values()) el.remove();
    return rows;
  }
  function buildRow(el, g, shared) {
    const s = staticHtml(g, shared);
    if (el._s !== s) {
      el.innerHTML = s; el._s = s;
      el._mem = el.querySelector('.mem'); el._cpu = el.querySelector('.cpu'); el._sw = el.querySelector('.stw'); el._mm = el.querySelector('.mw');
      el.setAttribute('role', 'listitem');
    }
    // Only what CHANGED is written: an equal textContent write still replaces the text node and
    // dirties layout, and ~200 rows of that was most of a tick's cost.
    const cls = 'row' + (P.open.has(g.key) ? ' open' : '') + (g.kind === 'mantle' ? ' mantle' : '') + (P.sel === g.key ? ' sel' : '') + (g.hung ? ' hung' : '');
    if (el.className !== cls) { el.className = cls; el.setAttribute('aria-selected', String(P.sel === g.key)); }
    const mt = mb(g.mem), ct = pct(g.cpu);
    if (el._mem._t !== mt) { el._mem.textContent = mt; el._mem._t = mt; }
    if (el._cpu._t !== ct) { el._cpu.textContent = ct; el._cpu._t = ct; }
    const st = stateLine(g), mw = membersHtml(g);
    if (el._sw._h !== st) { el._sw.innerHTML = st; el._sw._h = st; }
    if (el._mm._h !== mw) { el._mm.innerHTML = mw; el._mm._h = mw; }
  }

  /* sort + search, in the page (the model is ~200 compact rows: cheap) */
  function cmp(a, b) {
    const s = P.sort;
    let d;
    if (s.by === 'name') { const x = String(a.name || '').toLowerCase(), y = String(b.name || '').toLowerCase(); d = x < y ? -1 : x > y ? 1 : 0; }
    else d = ((a[s.by] || 0) - (b[s.by] || 0)) || (b.mem - a.mem);
    return d * s.dir || (a.key < b.key ? -1 : 1);
  }
  function matches(g, q) {
    if (!q) return true;
    return String(g.name || '').toLowerCase().includes(q) || String(g.file || '').toLowerCase().includes(q) || String(g.title || '').toLowerCase().includes(q);
  }
  function section(host, id, title, rows, searching) {
    let head = host.querySelector(`.sect[data-s="${id}"]`), box = host.querySelector(`.sbox[data-s="${id}"]`);
    if (!head) {
      head = document.createElement('div'); head.className = 'sect'; head.dataset.s = id;
      box = document.createElement('div'); box.className = 'sbox'; box.dataset.s = id;
      host.appendChild(head); host.appendChild(box);
    }
    // a search opens every section that has a match and hides the ones that have none
    const coll = !searching && P.collapsed.has(id);
    head.hidden = box.hidden = searching && !rows.length;
    const shared = coll ? null : sharedWhy(rows);
    const h = `<button type="button" class="stog" data-act="section" aria-expanded="${!coll}" title="${coll ? 'Show' : 'Hide'} ${esc(title)}">${CHEV}<span>${esc(title)}</span><span class="cnt">${rows.length}</span></button>` +
      (shared ? Array.from(shared, ([w, v]) => `<span class="sect-why">${v.lock ? LOCK : ''}<span>${esc(w)} (${v.c} below)</span></span>`).join('') : '');
    if (head._h !== h) { head.innerHTML = h; head._h = h; }
    if (!head.hidden) box.hidden = coll;
    return patchList(box, coll ? [] : rows, buildRow, shared);
  }

  function renderApps(m) {
    const host = $('list');
    const q = P.q.trim().toLowerCase();
    const pick = (rows) => (rows || []).filter((g) => matches(g, q)).sort(cmp);
    const apps = pick(m.mantleRow ? [m.mantleRow].concat(m.apps || []) : m.apps);
    const bg = pick(m.background), win = pick(m.windows);
    const shownRows = [];
    if (m.loaded) {
      shownRows.push(...section(host, 'apps', 'Apps', apps, !!q), ...section(host, 'background', 'Background', bg, !!q), ...section(host, 'windows', 'Windows processes', win, !!q));
    }
    P.order = shownRows.map((g) => g.key);
    // the list's own states: reading, could not read, nothing matches
    const ls = $('liststate');
    let st = '';
    if (!m.loaded && m.error) st = `<div class="lsx bad">${WARN}<span>${esc(m.error)}</span></div>`;
    else if (!m.loaded) st = '<div class="lsx"><span class="spin" aria-hidden="true"></span><span>Reading running apps…</span></div>';
    else if (q && !shownRows.length) st = `<div class="lsx"><span>No running app matches “${esc(P.q.trim())}”.</span><button type="button" class="btn" data-act="clearq">Clear search</button></div>`;
    ls.hidden = !st;
    if (ls._h !== st) { ls.innerHTML = st; ls._h = st; }
    if (P.sel && !P.order.includes(P.sel)) P.sel = null;
    document.querySelectorAll('.cols [data-sort]').forEach((b) => {
      const on = b.dataset.sort === P.sort.by;
      b.classList.toggle('on', on);
      b.setAttribute('aria-sort', on ? (P.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      b.querySelector('i').innerHTML = on ? `<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="${P.sort.dir === 1 ? 'M1.5 5.5 4 3l2.5 2.5' : 'M1.5 2.5 4 5l2.5-2.5'}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : '';
    });
  }

  /* Outcomes that failed for the same reason: the reason said once, after every app it hit
     ("Discord, Steam: <why>"), in the order they came. Plain text; warnLine escapes it. */
  function grouped(list, whyFn) {
    const by = new Map();
    for (const r of list) { const w = whyFn(r); if (!by.has(w)) by.set(w, []); by.get(w).push(r.name); }
    return Array.from(by, ([w, names]) => `${names.join(', ')}: ${w}`);
  }

  function renderGame(m) {
    const g = m.prep || { rows: [], absent: [] };
    $('auto').checked = !!g.auto;
    const ticked = g.rows.filter((r) => r.ticked);
    $('gsum').textContent = mb(ticked.reduce((s, r) => s + r.mem, 0));
    if (!P.freeing) $('free').disabled = !ticked.length;
    $('free').title = ticked.length ? `Close the ${ticked.length} ticked app${ticked.length > 1 ? 's' : ''} now` : 'Tick at least one app below first';
    const lf = g.lastFree, la = g.lastAuto;
    const lines = [];
    if (lf) {
      lines.push(`<span class="h">${lf.dryRun ? 'Test Mantle: nothing was closed' : 'Free up RAM'} · ${lf.none ? esc(lf.none) : `freed about ${mb(lf.freed)} so far`}</span>`);
      for (const t of grouped((lf.results || []).filter((r) => !r.ok), (r) => r.why)) lines.push(warnLine('bad', t));
      for (const r of lf.reopen || []) lines.push(r.can ? `<span>${esc(r.name)} reopens after your next game${r.why ? ' (' + esc(r.why) + ')' : ''}</span>` : warnLine('bad', `${r.name} will not reopen: ${r.why}`));
    }
    if (la && la.at) {
      const when = new Date(la.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      lines.push(`<span class="h">When ${esc(la.game || 'a game')} started (${esc(when)}): ${la.none ? esc(la.none) : `freed about ${mb(la.freed)}`}</span>`);
      for (const t of grouped((la.results || []).filter((r) => r.state !== 'closed'), (r) => r.why || 'not closed')) lines.push(warnLine('bad', t));
      if (la.reopened) for (const r of la.reopened.results || []) lines.push(r.ok ? `<span>${esc(r.name)} was started again after the game</span>` : warnLine('bad', `${r.name} was not started again: ${r.why}`));
    }
    $('lastfree').hidden = !lines.length;
    $('lastfree').innerHTML = lines.join('');
    const rows = g.rows.concat((g.absent || []).map((a) => ({ key: 'absent:' + a.identity, identity: a.identity, name: a.name, mem: -1, tickable: true, ticked: true, reopen: a.reopen, absent: true })));
    const host = $('prep');
    if (!m.loaded) { host.innerHTML = '<div class="empty"><span class="spin" aria-hidden="true"></span>Reading running apps…</div>'; return; }
    if (!rows.length) { host.innerHTML = '<div class="empty">No apps that can be closed are running right now.</div>'; return; }
    if (host.querySelector('.empty')) host.innerHTML = '';
    patchList(host, rows, (el, r) => {
      const why = !r.tickable ? r.why : r.absent ? 'Not running now' : r.reopenWhy ? r.reopenWhy : r.elevated ? 'Runs as administrator: Mantle may not be allowed to close it' : null;
      const bad = r.reopenWhy && /^Cannot/.test(r.reopenWhy);
      const s = `<div class="prow${r.tickable ? '' : ' off'}">` +
        (r.tickable ? `<input type="checkbox" data-act="tick" ${r.ticked ? 'checked' : ''} aria-label="Close ${esc(r.name)} before games">` : `<span class="lock" title="${esc(r.why)}">${LOCK}</span>`) +
        (r.absent ? `<span class="ic tile">${APPIC}</span>` : icon(r)) +
        `<span class="n" title="${esc(r.name)}">${esc(r.name)}</span><span class="mem">${r.mem >= 0 ? mb(r.mem) : ''}</span>` +
        (r.tickable && r.ticked ? `<label class="reo" title="Start it again when the game ends"><input type="checkbox" data-act="reopen" ${r.reopen ? 'checked' : ''}>Reopen it</label>` : '<span></span>') +
        (why ? (bad ? `<div class="pwhy bad">${WARN}<span>${esc(why)}</span></div>` : `<div class="pwhy">${esc(why)}</div>`) : '') + '</div>';
      if (el._s !== s) { el.innerHTML = s; el._s = s; el.className = ''; }
    });
  }

  /* a line over the last HIST samples, drawn right-aligned (a new window's line grows in from the right) */
  function spark(svg, vals) {
    const N = 60, W = 120, H = 30;
    const v = (vals || []).slice(-N);
    const key = v.join(',');
    if (svg._k === key) return;
    svg._k = key;
    if (v.length < 2) { svg.querySelector('.line').setAttribute('d', ''); svg.querySelector('.area').setAttribute('d', ''); return; }
    const x0 = W - ((v.length - 1) / (N - 1)) * W;
    const pts = v.map((y, i) => [x0 + (i / (N - 1)) * W, H - 1 - (Math.max(0, Math.min(100, y)) / 100) * (H - 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    svg.querySelector('.line').setAttribute('d', line);
    svg.querySelector('.area').setAttribute('d', `${line} L${W} ${H} L${x0.toFixed(1)} ${H} Z`);
  }

  // writes that would not change anything are skipped: each one dirties style or layout
  const setText = (el, t) => { if (el._t !== t) { el.textContent = t; el._t = t; } };
  const setHtml = (el, h) => { if (el._h !== h) { el.innerHTML = h; el._h = h; } };
  function render() {
    const m = P.m;
    if (!m) return;
    document.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('on', t.dataset.view === P.view); t.setAttribute('aria-selected', t.dataset.view === P.view); });
    $('v-apps').hidden = P.view !== 'apps';
    $('v-game').hidden = P.view !== 'game';
    if (m.mem && m.mem.total) {
      const f = Math.max(0, Math.min(1, m.mem.used / m.mem.total));
      setText($('memv'), Math.round(f * 100) + '%');
      // what is still free is what a game needs (the big number already says how much is used); the rest on hover
      setText($('ramtext'), `${gb(m.mem.avail)} available of ${gb(m.mem.total)}`);
      const full = `${gb(m.mem.used)} of ${gb(m.mem.total)} in use · ${gb(m.mem.avail)} available`;
      if ($('s-mem').title !== full) $('s-mem').title = full;
      $('s-mem').classList.toggle('hi', f > 0.85);
    } else { setText($('memv'), '—'); setText($('ramtext'), m.mem && m.mem.reason ? m.mem.reason : m.loaded ? 'Windows did not report memory' : 'Reading…'); }
    setText($('cpuv'), m.cpu >= 0 && m.cpu !== null ? Math.round(m.cpu) + '%' : '—');
    setText($('cpus'), m.cpu >= 0 && m.cpu !== null ? (m.cpus ? `${m.cpus} logical processors` : '') : m.loaded ? 'Measuring…' : 'Reading…');
    $('s-cpu').classList.toggle('hi', m.cpu > 85);
    spark($('cpuspark'), m.hist && m.hist.cpu);
    spark($('memspark'), m.hist && m.hist.mem);
    setText($('mantleuse'), m.mantle ? `Mantle uses ${mb(m.mantle.mem)}` : '');
    const look = m.look || {};
    // the glass: Windows' dark backdrop under this light page reads grey, so without the light frame the page keeps its solid ground
    const frame = look.light === false ? 'dark' : 'light';
    if (document.documentElement.dataset.frame !== frame) document.documentElement.dataset.frame = frame;
    // one line each: a warning is the warn glyph + its words; the test-Mantle line is quiet ink.
    // A read error shows here only while there IS a list (with none, the list itself says it).
    // lane helm-wall-apps (2026-10-09): in dark the page paints the wallpaper (ui/shared/wall-bdrop.js); with no
    // picture the window keeps its solid face and says why here
    const W = window.MantleWallBdrop;
    const wallWhy = W && W.state === 'off' && document.documentElement.dataset.theme === 'dark' ? `No wallpaper picture: ${W.reason || 'no reason came back'}; the window stays solid.` : null;
    const notes = [m.loaded ? m.error : null, P.note, look.iconWhy ? `This window's own icon: ${look.iconWhy}.` : null, look.lightWhy ? `Glass: ${look.lightWhy}; the window stays solid.` : null, wallWhy].filter(Boolean);
    const lines = notes.map((t) => warnLine('nl', t)).concat(m.test ? ['<span class="nl quiet"><span>Test Mantle: Close, Force close and Trim memory only say what they would do.</span></span>'] : []);
    $('note').hidden = !lines.length;
    setHtml($('note'), lines.join(''));
    const rec = (m.recent || []).slice(0, 3);
    $('recent').hidden = !rec.length;
    setHtml($('recent'), rec.map((r) => r.ok ? `<span>${esc(r.name)}: ${esc(r.text)}</span>` : warnLine('bad', `${r.name}: ${r.text}`)).join(''));
    if (P.view === 'apps') renderApps(m);
    if (P.view === 'game') renderGame(m);
    document.documentElement.dataset.ready = '1';
  }

  function rowOf(key) {
    const m = P.m || {};
    return [].concat(m.mantleRow ? [m.mantleRow] : [], m.apps || [], m.background || [], m.windows || []).find((g) => g.key === key);
  }
  async function act(action, key, extra) {
    if (P.busy.has(key + action)) return;          // a double click sends one request
    P.busy.add(key + action);
    try {
      const r = await call('taskmgr.act', Object.assign({ action, key }, extra || {}));
      P.note = r && r.ok === false && !r.needsConfirm && !rowOf(key) ? r.reason : null;
    } catch (e) { P.note = `Mantle did not answer (${e.message}). Nothing was done.`; }
    finally { P.busy.delete(key + action); }
    render();
  }
  function select(key, scroll) {
    P.sel = key;
    render();
    if (scroll && key) { const el = $('list').querySelector(`[data-key="${CSS.escape(key)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }
  function toggleExpand(key) {
    const g = rowOf(key);
    if (!g || g.count < 2) return;
    // its processes travel only while it is open (main's compact model): ask, then draw
    const open = !P.open.has(key);
    if (open) P.open.add(key); else P.open.delete(key);
    render();
    call('taskmgr.expand', { key, open }).catch((err) => { P.note = `Its processes did not load (${err.message}).`; render(); });
  }
  function askForce(key) {
    const g = rowOf(key);
    if (!g || !g.actions || !g.actions.force) return;
    P.confirm = key;
    P.sel = key;
    render();
    const b = $('list').querySelector(`[data-key="${CSS.escape(key)}"] [data-act="force-no"]`);
    if (b) b.focus();                                 // Enter would not force by accident: Cancel has focus
  }
  async function reveal(key) {
    try { const r = await call('taskmgr.reveal', { key }); P.note = r && (r.ok === false || r.dryRun || r.reason) ? r.reason : null; } catch (e) { P.note = `The folder did not open (${e.message}).`; }
    render();
  }
  function doItem(act0, key) {
    if (act0 === 'close' || act0 === 'trim') { P.confirm = null; act(act0, key); }
    else if (act0 === 'force') askForce(key);
    else if (act0 === 'expand') toggleExpand(key);
    else if (act0 === 'reveal') reveal(key);
    else if (act0 === 'startup') openStartup();
    else if (act0 === 'wintm') openWinTm();
  }

  /* ---- the one menu (a row's "...", a right-click, or the header's More) ---- */
  const menu = $('menu');
  function openMenu(items, anchor, at, key) {
    if (!items.length) return;
    P.menu = { key, items, anchor };
    menu.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}"${it.hint ? ` title="${esc(it.hint)}"` : ''}><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('');
    menu.hidden = false;
    const r = at || anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = at ? at.x : r.right - mw, y = at ? at.y : r.bottom + 4;
    if (x + mw > innerWidth - 6) x = innerWidth - 6 - mw;
    if (y + mh > innerHeight - 6) y = (at ? at.y : r.top - 4) - mh;
    menu.style.left = Math.max(6, x) + 'px';
    menu.style.top = Math.max(6, y) + 'px';
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  }
  function closeMenu(refocus) {
    if (!P.menu) return;
    const a = P.menu.anchor;
    P.menu = null;
    menu.hidden = true;
    menu.innerHTML = '';
    if (a) a.setAttribute('aria-expanded', 'false');
    if (refocus && a && document.contains(a)) a.focus(); else if (refocus) $('list').focus();
    render();
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || !P.menu) return;
    const it = P.menu.items[Number(b.dataset.i)], key = P.menu.key;
    closeMenu(false);
    if (it) doItem(it.act, key);
  });
  menu.addEventListener('keydown', (e) => {
    const bs = Array.from(menu.querySelectorAll('button'));
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); bs[e.key === 'Home' ? 0 : bs.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  document.addEventListener('pointerdown', (e) => { if (P.menu && !menu.contains(e.target) && e.target !== P.menu.anchor && !(P.menu.anchor && P.menu.anchor.contains(e.target))) closeMenu(false); }, true);
  window.addEventListener('blur', () => closeMenu(false));
  window.addEventListener('resize', () => closeMenu(false));

  async function openStartup() {
    try {
      const r = await call('settings.open', { section: 'apps', row: 'apps.startup', via: 'the task manager' });
      P.note = r && r.ok === false ? `Mantle Settings did not open: ${r.reason}` : null;
    } catch (e) { P.note = `Mantle Settings did not open (${e.message}).`; }
    render();
  }
  async function openWinTm() {
    try { const r = await call('taskmgr.windowsTaskManager', {}); P.note = r && r.ok === false ? r.reason : r && r.dryRun ? r.reason : null; } catch (e) { P.note = `Windows Task Manager did not start (${e.message}).`; }
    render();
  }
  const HEAD_MENU = [{ act: 'startup', label: 'Startup apps', hint: 'Choose which apps start with Windows (Mantle Settings)' }, { act: 'wintm', label: 'Windows Task Manager', hint: "Windows' own Task Manager, for details and services" }];

  /* ---- clicks ---- */
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], [data-view], [data-op], [data-sort], #more, #qx');
    const rowEl = e.target.closest('#list [data-key]');
    if (rowEl && (!b || b === rowEl)) { if (P.sel !== rowEl.dataset.key) select(rowEl.dataset.key); $('list').focus({ preventScroll: true }); return; }
    if (!b) return;
    if (b.id === 'more') { if (P.menu && P.menu.anchor === b) closeMenu(false); else openMenu(HEAD_MENU, b, null, null); return; }
    if (b.id === 'qx') { setQuery(''); $('q').focus(); return; }
    if (b.dataset.view) { closeMenu(false); P.view = b.dataset.view; call('taskmgr.view', { view: P.view }).catch(() => {}); render(); return; }
    if (b.dataset.op) { call('taskmgr.win', { op: b.dataset.op }).catch((err) => { P.note = `The window did not answer (${err.message}).`; render(); }); return; }
    if (b.dataset.sort) {
      const by = b.dataset.sort;
      P.sort = P.sort.by === by ? { by, dir: -P.sort.dir } : { by, dir: by === 'name' ? 1 : -1 };
      store.set('sort', P.sort);
      render();
      return;
    }
    const row = b.closest('[data-key]');
    const key = row && row.dataset.key;
    if (key && row.closest('#list') && P.sel !== key) { P.sel = key; }
    switch (b.dataset.act) {
      case 'section': { const id = b.closest('.sect').dataset.s; if (P.collapsed.has(id)) P.collapsed.delete(id); else P.collapsed.add(id); render(); return; }
      case 'expand': toggleExpand(key); return;
      case 'menu': { const g = rowOf(key); if (P.menu && P.menu.anchor === b) closeMenu(false); else if (g) openMenu(menuItems(g), b, null, key); return; }
      case 'close': case 'trim': P.confirm = null; act(b.dataset.act, key); return;
      case 'force': askForce(key); return;
      case 'force-no': P.confirm = null; render(); $('list').focus(); return;
      case 'force-yes': P.confirm = null; act('force', key, { confirmed: true }); $('list').focus(); return;
      case 'clearq': setQuery(''); $('q').focus(); return;
      default: return;
    }
  });
  // right-click a row: the same menu, at the pointer
  $('list').addEventListener('contextmenu', (e) => {
    const rowEl = e.target.closest('[data-key]');
    e.preventDefault();
    if (!rowEl) return;
    const g = rowOf(rowEl.dataset.key);
    if (!g) return;
    P.sel = g.key;
    render();
    openMenu(menuItems(g), null, { x: e.clientX, y: e.clientY }, g.key);
  });
  $('list').addEventListener('dblclick', (e) => {
    const rowEl = e.target.closest('[data-key]');
    if (rowEl && !e.target.closest('button')) toggleExpand(rowEl.dataset.key);
  });

  /* ---- search ---- */
  const q = $('q');
  function setQuery(v) {
    P.q = v;
    if (q.value !== v) q.value = v;
    $('qx').hidden = !v;
    if (P.view !== 'apps' && v) { P.view = 'apps'; call('taskmgr.view', { view: 'apps' }).catch(() => {}); }
    render();
    $('list').scrollTop = 0;
  }
  q.addEventListener('input', () => setQuery(q.value));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q.value) setQuery(''); else $('list').focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (P.order.length) { select(P.order.includes(P.sel) ? P.sel : P.order[0], true); $('list').focus(); } }
  });

  /* ---- keys: Windows' Task Manager's, on the list ---- */
  $('list').addEventListener('keydown', (e) => {
    // keys on a button inside a row are that button's (Enter presses it); the list's keys are the list's own
    if (P.menu || e.target !== e.currentTarget) return;
    const k = e.key;
    const i = P.order.indexOf(P.sel);
    const move = (to) => { e.preventDefault(); if (P.order.length) select(P.order[Math.max(0, Math.min(P.order.length - 1, to))], true); };
    if (k === 'ArrowDown') move(i < 0 ? 0 : i + 1);
    else if (k === 'ArrowUp') move(i < 0 ? 0 : i - 1);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(P.order.length - 1);
    else if (k === 'PageDown' || k === 'PageUp') move((i < 0 ? 0 : i) + (k === 'PageDown' ? 10 : -10));
    else if (!P.sel) {
      // typing on the list searches it
      if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && k !== ' ') { e.preventDefault(); q.focus(); setQuery(P.q + k); }
      return;
    } else if (k === 'Delete') {
      e.preventDefault();
      const g = rowOf(P.sel);
      if (!g) return;
      if (e.shiftKey || g.hung) askForce(g.key);
      else if (g.actions && g.actions.close) { P.confirm = null; act('close', g.key); }
      else { P.note = `${g.name} can't be closed: ${whyOf(g) || (g.actions && g.actions.why) || 'Mantle does not close it'}`; render(); }
    } else if (k === 'Enter' || k === 'ArrowRight') { e.preventDefault(); if (!P.open.has(P.sel)) toggleExpand(P.sel); }
    else if (k === 'ArrowLeft') { e.preventDefault(); if (P.open.has(P.sel)) toggleExpand(P.sel); }
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const g = rowOf(P.sel), el = $('list').querySelector(`[data-key="${CSS.escape(P.sel)}"] .rmain`);
      if (g && el) { const r = el.getBoundingClientRect(); openMenu(menuItems(g), null, { x: r.left + 60, y: r.bottom }, g.key); }
    } else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && k !== ' ') { e.preventDefault(); q.focus(); setQuery(P.q + k); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && (e.key === 'f' || e.key === 'F')) || e.key === 'F3') { e.preventDefault(); if (P.view !== 'apps') { P.view = 'apps'; render(); } q.focus(); q.select(); return; }
    if (e.key === 'Escape') {
      if (P.menu) { closeMenu(true); return; }
      if (P.confirm) { P.confirm = null; render(); $('list').focus(); return; }
      if (P.q && document.activeElement !== q) { setQuery(''); return; }
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'q') return;          // the search box's own change (on blur) is not a setting: it must not wipe a note
    const row = t.closest('[data-key]');
    const r = row && P.m && P.m.prep ? P.m.prep.rows.concat((P.m.prep.absent || []).map((a) => ({ key: 'absent:' + a.identity, identity: a.identity }))).find((x) => x.key === row.dataset.key) : null;
    try {
      let res = null;
      if (t.id === 'auto') res = await call('taskmgr.auto', { on: t.checked });
      else if (t.dataset.act === 'tick' && r) res = await call('taskmgr.tick', { identity: r.identity, on: t.checked });
      else if (t.dataset.act === 'reopen' && r) res = await call('taskmgr.tick', { identity: r.identity, reopen: t.checked });
      P.note = res && res.ok === false ? res.reason : null;
    } catch (err) { P.note = `Mantle did not answer (${err.message}). Nothing was saved.`; }
    render();
  });
  $('free').addEventListener('click', async () => {
    if (P.freeing) return;
    P.freeing = true;
    $('free').disabled = true;
    $('free').textContent = 'Freeing…';
    try { const r = await call('taskmgr.free', {}); P.note = r && r.ok === false ? r.reason : null; } catch (e) { P.note = `Free up RAM did not reach Mantle (${e.message}). Nothing was closed.`; }
    P.freeing = false;
    $('free').textContent = 'Free up RAM';
    render();
  });

  if (!window.mantle) { P.note = 'This page is not connected to Mantle, so nothing here can act.'; P.m = { loaded: false, error: 'Not connected to Mantle.' }; render(); return; }
  // pictures first, so the replayed model finds them
  window.mantle.on('taskmgr.icons', (o) => { let n = 0; for (const k of Object.keys(o || {})) { if (P.icons.get(k) !== o[k]) { P.icons.set(k, o[k]); n++; } } if (n && P.m) render(); });
  const list = $('list');
  list.addEventListener('pointerenter', () => { P.hover = true; });
  list.addEventListener('pointerleave', () => { P.hover = false; render(); });
  // What a tick costs this page (script + DOM, not the layout after it), read by the lane's CDP bench:
  // two performance.now() calls a tick.
  const PERF = window.__taskmgrPerf = { ticks: 0, ms: 0, max: 0 };
  window.addEventListener('mantle-wall', () => { if (P.m) render(); });
  window.mantle.on('taskmgr.model', (m) => {
    const t = performance.now();
    P.m = m;
    P.got = true;
    if (m && m.view && !P.seenView) { P.view = m.view === 'game' ? 'game' : 'apps'; P.seenView = true; }
    render();
    const dt = performance.now() - t;
    PERF.ticks++; PERF.ms += dt; if (dt > PERF.max) PERF.max = dt;
  });
  window.mantle.on('taskmgr.view', (v) => { if (v && v.view) { P.view = v.view === 'game' ? 'game' : 'apps'; closeMenu(false); render(); } });
  P.m = { loaded: false };               // the list says it is reading until the first model
  call('taskmgr.state').then((m) => { if (!P.got) { P.got = true; P.m = m; P.view = m.view === 'game' ? 'game' : 'apps'; P.seenView = true; render(); } }).catch((e) => { P.m = { loaded: false, error: `Mantle did not answer (${e.message}).` }; render(); });
  render();
}());
