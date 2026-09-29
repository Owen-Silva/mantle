/* taskmgr.js — the task manager's page (lib/features/taskmgr.js draws nothing itself).
 *
 * Main pushes `taskmgr.model` after every sample (1.5 s focused, 3 s behind); this page keeps only
 * what is on screen: the view, which rows are expanded, which row has its Force close confirm open.
 * Rows are KEYED and patched in place (numbers every tick, the rest only when it changes), so a
 * button under the pointer is never swapped out between mousedown and click.
 * Every action's outcome comes back on the row from main (state + why): nothing here guesses.
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
  const CHEV = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

  const P = { m: null, view: 'apps', open: new Set(), confirm: null, collapsed: new Set(['windows']), note: null, icons: new Map(), hover: false };

  /* g.icon is a REFERENCE (the app's identity); the pictures arrive once each on taskmgr.icons. */
  function icon(g) {
    const url = g.icon ? P.icons.get(g.icon) : null;
    return url ? `<img class="ic" src="${esc(url)}" alt="" decoding="async">` : `<span class="ic tile" title="${esc(g.iconWhy || 'no icon yet')}">${esc((g.name || '?').slice(0, 1).toUpperCase())}</span>`;
  }
  function stateLine(g) {
    if (P.confirm === g.key) {
      return `<div class="st bad"><span>Force close ${esc(g.name)}? It ends at once and anything unsaved in it is lost.</span><span class="grow"></span>` +
        `<button type="button" class="go" data-act="force-yes">Force close</button><button type="button" data-act="force-no">Cancel</button></div>`;
    }
    const s = g.state;
    if (!s) return '';
    const map = {
      closing: [`Closing…${s.why ? ' ' + s.why : ''}`, ''],
      closed: [`Closed · freed about ${mb(s.freed)}`, 'good'],
      'still-running': [s.why, 'bad'],
      failed: [s.why, 'bad'],
      trimming: ['Trimming…', ''],
      trimmed: [`Trimmed: ${mb(s.before)} → ${mb(s.after)}${s.why ? ' · ' + s.why : ''}`, 'good'],
      dry: [s.why || 'Dry run', ''],
    };
    const [text, cls] = map[s.state] || [s.why || s.state, ''];
    const force = s.state === 'still-running' && g.actions && g.actions.force ? '<span class="grow"></span><button type="button" data-act="force">Force close</button>' : '';
    return `<div class="st ${cls}" role="status"><span>${esc(text)}</span>${force}</div>`;
  }
  /* The parts of a row that change only when its meaning changes (not every tick). */
  function staticHtml(g) {
    const a = g.actions || {};
    const btns = [];
    if (a.trim) btns.push('<button type="button" data-act="trim" title="Hand its idle memory back to Windows (EmptyWorkingSet)">Trim</button>');
    if (a.close) btns.push('<button type="button" data-act="close" title="Ask it to close, like its own close button">Close</button>');
    if (a.force) btns.push('<button type="button" class="danger" data-act="force" title="End it now (asks first)">Force close</button>');
    const tags = [g.game ? '<span class="tag">game</span>' : '', g.handledBy === 'spotify' ? '<span class="tag">Spotify card</span>' : '', g.elevated ? '<span class="tag" title="Windows would not let Mantle read it: it runs as administrator or another user">admin</span>' : ''].join('');
    const why = g.protected || (g.game && a.why) || (g.elevated ? 'Runs as administrator: Mantle may not be allowed to close it' : null);
    return `<div class="rmain">` +
      (g.count > 1 ? `<button type="button" class="chev" data-act="expand" aria-label="Show its ${g.count} processes" aria-expanded="${P.open.has(g.key)}">${CHEV}</button>` : '<span></span>') +
      icon(g) +
      `<div class="nm"><span class="n" title="${esc(g.title || g.name)}">${esc(g.name)}</span>${g.count > 1 ? `<span class="k">(${g.count})</span>` : ''}${tags}</div>` +
      `<span class="mem"></span><span class="cpu"></span><div class="acts">${btns.join('')}</div>` +
      (why ? `<div class="why">${g.protected ? LOCK : ''}<span>${esc(why)}</span></div>` : '') +
      `</div><div class="stw"></div><div class="mw"></div>`;
  }
  function membersHtml(g) {
    if (!P.open.has(g.key) || !g.members) return '';
    return '<div class="members">' + g.members.map((m) => `<div class="mrow"><span>${esc(m.file)} · pid ${m.pid}${m.windows ? ' · window' : ''}</span><span>${mb(m.mem)}</span><span>${pct(m.cpu)}</span><span></span></div>`).join('') + '</div>';
  }

  /* Keyed patching: one element per row key, rebuilt only when its static part changes.
     While the pointer is over the list the ORDER holds (rows already there keep their places, new
     ones go to the end): a row never slides out from under the cursor between hover and click, and
     no row is moved at all. Leaving the list re-sorts it. */
  function patchList(host, rows, build, sig) {
    const have = new Map(Array.from(host.children).filter((e) => e.dataset.key).map((e) => [e.dataset.key, e]));
    if (P.hover && have.size) {
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
  }
  function buildRow(el, g) {
    const s = staticHtml(g);
    if (el._s !== s) {
      el.innerHTML = s; el._s = s;
      el._mem = el.querySelector('.mem'); el._cpu = el.querySelector('.cpu'); el._sw = el.querySelector('.stw'); el._mm = el.querySelector('.mw');
    }
    // Only what CHANGED is written: an equal textContent write still replaces the text node and
    // dirties layout, and ~200 rows of that was most of a tick's cost.
    const cls = 'row' + (P.open.has(g.key) ? ' open' : '') + (g.kind === 'mantle' ? ' mantle' : '');
    if (el.className !== cls) el.className = cls;
    const mt = mb(g.mem), ct = pct(g.cpu);
    if (el._mem._t !== mt) { el._mem.textContent = mt; el._mem._t = mt; }
    if (el._cpu._t !== ct) { el._cpu.textContent = ct; el._cpu._t = ct; }
    const st = stateLine(g), mw = membersHtml(g);
    if (el._sw._h !== st) { el._sw.innerHTML = st; el._sw._h = st; }
    if (el._mm._h !== mw) { el._mm.innerHTML = mw; el._mm._h = mw; }
  }
  function section(host, id, title, rows) {
    let head = host.querySelector(`.sect[data-s="${id}"]`), box = host.querySelector(`.sbox[data-s="${id}"]`);
    if (!head) {
      head = document.createElement('div'); head.className = 'sect'; head.dataset.s = id;
      box = document.createElement('div'); box.className = 'sbox'; box.dataset.s = id;
      host.appendChild(head); host.appendChild(box);
    }
    const coll = P.collapsed.has(id);
    const h = `<button type="button" data-act="section" aria-expanded="${!coll}">${coll ? '▸' : '▾'}</button><span>${esc(title)} (${rows.length})</span>`;
    if (head._h !== h) { head.innerHTML = h; head._h = h; }
    box.hidden = coll;
    patchList(box, coll ? [] : rows, buildRow);
  }

  function renderApps(m) {
    const host = $('list');
    const apps = m.mantleRow ? [m.mantleRow].concat(m.apps) : m.apps;
    section(host, 'apps', 'Apps', apps);
    section(host, 'background', 'Background', m.background);
    section(host, 'windows', 'Windows processes', m.windows);
  }

  function renderGame(m) {
    const g = m.prep || { rows: [], absent: [] };
    $('auto').checked = !!g.auto;
    const ticked = g.rows.filter((r) => r.ticked);
    $('gsum').textContent = mb(ticked.reduce((s, r) => s + r.mem, 0));
    $('free').disabled = !ticked.length;
    const lf = g.lastFree, la = g.lastAuto;
    const lines = [];
    if (lf) {
      lines.push(`<span class="h">${lf.dryRun ? 'Dry run (test Mantle): nothing was closed' : 'Free up RAM'} · ${lf.none ? esc(lf.none) : `freed about ${mb(lf.freed)} so far`}</span>`);
      for (const r of lf.results || []) if (!r.ok) lines.push(`<span class="bad">${esc(r.name)}: ${esc(r.why)}</span>`);
      for (const r of lf.reopen || []) lines.push(r.can ? `<span>${esc(r.name)} reopens after your next game${r.why ? ' (' + esc(r.why) + ')' : ''}</span>` : `<span class="bad">${esc(r.name)} will not reopen: ${esc(r.why)}</span>`);
    }
    if (la && la.at) {
      const when = new Date(la.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      lines.push(`<span class="h">When ${esc(la.game || 'a game')} started (${esc(when)}): ${la.none ? esc(la.none) : `freed about ${mb(la.freed)}`}</span>`);
      for (const r of la.results || []) if (r.state !== 'closed') lines.push(`<span class="bad">${esc(r.name)}: ${esc(r.why || r.state || 'not closed')}</span>`);
      if (la.reopened) for (const r of la.reopened.results || []) lines.push(r.ok ? `<span>${esc(r.name)} was started again after the game</span>` : `<span class="bad">${esc(r.name)} was not started again: ${esc(r.why)}</span>`);
    }
    $('lastfree').hidden = !lines.length;
    $('lastfree').innerHTML = lines.join('');
    const rows = g.rows.concat((g.absent || []).map((a) => ({ key: 'absent:' + a.identity, identity: a.identity, name: a.name, mem: -1, tickable: true, ticked: true, reopen: a.reopen, absent: true })));
    const host = $('prep');
    if (!rows.length) { host.innerHTML = '<div class="empty">Nothing that could be closed is running.</div>'; return; }
    if (host.querySelector('.empty')) host.innerHTML = '';
    patchList(host, rows, (el, r) => {
      const why = !r.tickable ? r.why : r.absent ? 'Not running now' : r.reopenWhy ? r.reopenWhy : r.elevated ? 'Runs as administrator: Mantle may not be allowed to close it' : null;
      const bad = r.reopenWhy && /^Cannot/.test(r.reopenWhy);
      const s = `<div class="prow${r.tickable ? '' : ' off'}">` +
        (r.tickable ? `<input type="checkbox" data-act="tick" ${r.ticked ? 'checked' : ''} aria-label="Close ${esc(r.name)} before games">` : `<span class="lock" title="${esc(r.why)}">${LOCK}</span>`) +
        (r.absent ? '<span class="ic tile">·</span>' : icon(r)) +
        `<span class="n">${esc(r.name)}</span><span class="mem">${r.mem >= 0 ? mb(r.mem) : ''}</span>` +
        (r.tickable && r.ticked ? `<label class="reo"><input type="checkbox" data-act="reopen" ${r.reopen ? 'checked' : ''}>Reopen it</label>` : '<span></span>') +
        (why ? `<div class="pwhy${bad ? ' bad' : ''}">${esc(why)}</div>` : '') + '</div>';
      if (el._s !== s) { el.innerHTML = s; el._s = s; el.className = ''; }
    });
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
    $('v-startup').hidden = P.view !== 'startup';
    if (m.mem && m.mem.total) {
      setText($('ramtext'), `${gb(m.mem.used)} in use of ${gb(m.mem.total)} · ${gb(m.mem.avail)} available`);
      const f = Math.max(0, Math.min(1, m.mem.used / m.mem.total));
      $('ramfill').style.transform = 'scaleX(' + f.toFixed(3) + ')';   // the compositor moves it: no layout per tick
      $('rambar').classList.toggle('hi', f > 0.85);
      $('rambar').setAttribute('aria-label', `Memory ${Math.round(f * 100)}% in use`);
    } else setText($('ramtext'), m.mem && m.mem.reason ? m.mem.reason : m.loaded ? 'Windows did not report memory' : 'Reading…');
    setText($('mantleuse'), m.mantle ? `Mantle: ${mb(m.mantle.mem)}` : 'Mantle: —');
    const look = m.look || {};
    // the glass: Windows' dark backdrop under this light page reads grey, so without the light frame the page keeps its solid ground
    const frame = look.light === false ? 'dark' : 'light';
    if (document.documentElement.dataset.frame !== frame) document.documentElement.dataset.frame = frame;
    const notes = [m.error, P.note, look.iconWhy ? `This window's own icon: ${look.iconWhy}.` : null, look.lightWhy ? `Glass: ${look.lightWhy}; the window stays solid.` : null,
      m.test ? 'Test Mantle: every Close, Force close and Trim is a dry run.' : null].filter(Boolean);
    $('note').hidden = !notes.length;
    setText($('note'), notes.join(' · '));
    const rec = (m.recent || []).slice(0, 3);
    $('recent').hidden = !rec.length;
    setHtml($('recent'), rec.map((r) => `<span class="${r.ok ? '' : 'bad'}">${esc(r.name)}: ${esc(r.text)}</span>`).join(''));
    if (P.view === 'apps') renderApps(m);
    if (P.view === 'game') renderGame(m);
    document.documentElement.dataset.ready = '1';
  }

  function rowOf(key) {
    const m = P.m || {};
    return [].concat(m.mantleRow ? [m.mantleRow] : [], m.apps || [], m.background || [], m.windows || []).find((g) => g.key === key);
  }
  async function act(action, key, extra) {
    try {
      const r = await call('taskmgr.act', Object.assign({ action, key }, extra || {}));
      P.note = r && r.ok === false && !r.needsConfirm && !rowOf(key) ? r.reason : null;
    } catch (e) { P.note = `${action} did not reach Mantle: ${e.message}`; }
    render();
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], [data-view], [data-op]');
    if (!b) return;
    if (b.dataset.view) { P.view = b.dataset.view; call('taskmgr.view', { view: P.view }).catch(() => {}); render(); return; }
    if (b.dataset.op) { call('taskmgr.win', { op: b.dataset.op }).catch((err) => { P.note = err.message; render(); }); return; }
    const row = b.closest('[data-key]');
    const key = row && row.dataset.key;
    switch (b.dataset.act) {
      case 'section': { const id = b.closest('.sect').dataset.s; if (P.collapsed.has(id)) P.collapsed.delete(id); else P.collapsed.add(id); render(); return; }
      case 'expand': {
        // its processes travel only while it is open (main's compact model): ask, then draw
        const open = !P.open.has(key);
        if (open) P.open.add(key); else P.open.delete(key);
        render();
        call('taskmgr.expand', { key, open }).catch((err) => { P.note = `Its processes did not load: ${err.message}`; render(); });
        return;
      }
      case 'close': case 'trim': P.confirm = null; act(b.dataset.act, key); return;
      case 'force': P.confirm = key; render(); return;
      case 'force-no': P.confirm = null; render(); return;
      case 'force-yes': P.confirm = null; act('force', key, { confirmed: true }); return;
      default: return;
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    const row = t.closest('[data-key]');
    const r = row && P.m && P.m.prep ? P.m.prep.rows.concat((P.m.prep.absent || []).map((a) => ({ key: 'absent:' + a.identity, identity: a.identity }))).find((x) => x.key === row.dataset.key) : null;
    try {
      let res = null;
      if (t.id === 'auto') res = await call('taskmgr.auto', { on: t.checked });
      else if (t.dataset.act === 'tick' && r) res = await call('taskmgr.tick', { identity: r.identity, on: t.checked });
      else if (t.dataset.act === 'reopen' && r) res = await call('taskmgr.tick', { identity: r.identity, reopen: t.checked });
      P.note = res && res.ok === false ? res.reason : null;
    } catch (err) { P.note = err.message; }
    render();
  });
  $('free').addEventListener('click', async () => {
    $('free').disabled = true;
    try { const r = await call('taskmgr.free', {}); P.note = r && r.ok === false ? r.reason : null; } catch (e) { P.note = `Free up RAM did not reach Mantle: ${e.message}`; }
    render();
  });
  $('wintm').addEventListener('click', async () => {
    try { const r = await call('taskmgr.windowsTaskManager', {}); P.note = r && r.ok === false ? r.reason : r && r.dryRun ? r.reason : null; } catch (e) { P.note = e.message; }
    render();
  });
  $('opensettings').addEventListener('click', async () => {
    const n = $('settingsnote');
    try {
      const r = await call('settings.open', { section: 'apps', row: 'apps.startup', via: 'the task manager' });
      n.hidden = !(r && r.ok === false);
      n.textContent = r && r.ok === false ? `Mantle Settings did not open: ${r.reason}` : '';
    } catch (e) { n.hidden = false; n.textContent = `Mantle Settings did not open: ${e.message}`; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && P.confirm) { P.confirm = null; render(); } });

  if (!window.mantle) { P.note = 'This page is not connected to Mantle (no bridge): nothing here can act.'; P.m = { loaded: false }; render(); return; }
  // pictures first, so the replayed model finds them
  window.mantle.on('taskmgr.icons', (o) => { let n = 0; for (const k of Object.keys(o || {})) { if (P.icons.get(k) !== o[k]) { P.icons.set(k, o[k]); n++; } } if (n && P.m) render(); });
  const list = $('list');
  list.addEventListener('pointerenter', () => { P.hover = true; });
  list.addEventListener('pointerleave', () => { P.hover = false; render(); });
  // What a tick costs this page (script + DOM, not the layout after it), read by the lane's CDP bench:
  // two performance.now() calls a tick.
  const PERF = window.__taskmgrPerf = { ticks: 0, ms: 0, max: 0 };
  window.mantle.on('taskmgr.model', (m) => {
    const t = performance.now();
    P.m = m;
    if (m && m.view && !P.seenView) { P.view = m.view; P.seenView = true; }
    render();
    const dt = performance.now() - t;
    PERF.ticks++; PERF.ms += dt; if (dt > PERF.max) PERF.max = dt;
  });
  window.mantle.on('taskmgr.view', (v) => { if (v && v.view) { P.view = v.view; render(); } });
  call('taskmgr.state').then((m) => { if (!P.m) { P.m = m; P.view = m.view || P.view; P.seenView = true; render(); } }).catch((e) => { P.note = `Mantle did not answer: ${e.message}`; P.m = { loaded: false }; render(); });
}());
