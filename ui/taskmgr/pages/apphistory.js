/* pages/apphistory.js - Windows' App history page (TM-SPEC.md "App history"), on the shell's TM.table.
 * model.apphistory = { since, rows: [{ name, identity, cpuTimeSec, net, metered, tiles, nonMetered, downloads,
 * uploads, app?, path?, icon?, why? }], source: 'srum'|'mantle'|null, meteredBasis?, error|null }.
 *
 * Windows' own words (Taskmgr.exe.mui / Windows.UI.TaskManager.en-US.pri, read 10-28):
 *   "Resource usage since <date> for current user account." (Settings > Show history for all processes:
 *   "... for current user and system accounts."), "Delete usage history" (the command bar; Windows asks no
 *   question first), "No data available", the five default columns and their tooltips, and the row menu
 *   ("App history Context": Switch to, Search online, Properties). Header right-click = the column list (adds
 *   Non-metered network, Downloads, Uploads).
 * source 'mantle' = Mantle's own record (no administrator access yet): the page says so on one line, with
 * "Set up administrator access" (TM.adminHtml) for Windows' full history. Null = em dash + why.
 */
(function () {
  'use strict';
  const { esc } = TM;
  let t = null, m = {}, rowsAll = [], lineEl = null, srcEl = null, outEl = null;
  const outcome = new Map();     // row key -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, head, at }
  let pageOut = null;            // Delete usage history's outcome: { kind, text, res }
  const MB = 1024 * 1024;
  const TRASH = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.7 9h6.2l.7-9M6.8 6.8v4.2M9.2 6.8v4.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* Windows writes every network figure in MB, one decimal ("0 MB" at rest) */
  const mbs = (b) => (typeof b !== 'number' || !isFinite(b) || b < 0 ? null : b === 0 ? '0 MB' : TM.fmt.commas((b / MB).toFixed(1)) + ' MB');
  const ah = () => m.apphistory || {};
  const mantleSrc = () => ah().source === 'mantle';
  /* the em dash's reason when the row did not send its own (row.why.<field>) */
  const NOT = {
    cpuTimeSec: () => 'Windows did not report CPU time for this app',
    net: () => (mantleSrc() ? "Mantle's own record does not count network use per app; Windows' history (administrator access) does" : 'Windows did not record network use for this app'),
    metered: () => (mantleSrc() ? "Mantle's own record does not count metered network use; Windows' history (administrator access) does" : 'Windows did not record which of its network use was metered'),
    nonMetered: () => (mantleSrc() ? "Mantle's own record does not count non-metered network use; Windows' history (administrator access) does" : 'Windows did not record its non-metered network use'),
    tiles: () => 'Windows did not record live tile or notification traffic for this app',
    downloads: () => (mantleSrc() ? "Mantle's own record does not count downloads per app; Windows' history (administrator access) does" : 'Windows did not record its downloads'),
    uploads: () => (mantleSrc() ? "Mantle's own record does not count uploads per app; Windows' history (administrator access) does" : 'Windows did not record its uploads'),
    path: 'Windows did not say where its file is, so Properties cannot open',
  };
  const num = (id, label, tip, f, o) => Object.assign({ id, label, title: tip || label, num: true, w: 120, text: (r) => f(r[id]), why: NOT[id] }, o || {});
  const COLS = [
    { id: 'name', label: 'Name', title: 'Name', fixed: true, flex: true, min: 220, get: (r) => r.name,
      html: (r) => `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>` },
    num('cpuTimeSec', 'CPU time', 'Amount of time spent by the CPU executing instructions', TM.fmt.hms, { w: 100 }),
    num('net', 'Network', 'Amount of network activity, including downloads and uploads', mbs),
    // the metered tooltip: lib's meteredBasis (what "metered" counts here) when it sends one
    Object.defineProperty(num('metered', 'Metered network', null, mbs, { w: 130 }), 'title', { get: () => ah().meteredBasis || 'Network activity over a metered network connection' }),
    num('tiles', 'Tile updates', 'Total network usage for notifications', mbs),
    num('nonMetered', 'Non-metered network', 'Amount of network activity over a non-metered connection', mbs, { def: false, w: 150 }),
    num('downloads', 'Downloads', 'Downloads', mbs, { def: false }),
    num('uploads', 'Uploads', 'Uploads', mbs, { def: false }),
  ];
  const keyOf = (r) => 'a:' + (r.identity || r.name);

  /* ---- outcomes on the row (and Delete usage history's on the page's own line) ---- */
  function setOut(r, o) {
    const k = keyOf(r);
    if (o) outcome.set(k, Object.assign({ at: Date.now() }, o)); else outcome.delete(k);
    if (o && (o.kind === 'ok' || o.kind === 'dry')) { const at = outcome.get(k).at; setTimeout(() => { const x = outcome.get(k); if (x && x.at === at) { outcome.delete(k); TM.refresh(); } }, 15000); }
    TM.refresh();
  }
  function said(r, res, head, done) {
    if (!res || res.cancelled) { setOut(r, null); return res; }
    if (res.ok === false) setOut(r, res.needsAdmin ? { kind: 'admin', res, head } : { kind: 'bad', text: `${head}: ${res.reason}` });
    else if (res.dryRun) setOut(r, { kind: 'dry', text: res.reason || `Test Mantle: ${head.toLowerCase()} was not done.` });
    else setOut(r, done ? { kind: 'ok', text: done } : null);
    return res;
  }
  function outHtml(o) {
    if (!o) return '';
    if (o.kind === 'busy') return `<div class="st" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(o.text)}</span></div>`;
    if (o.kind === 'admin') return `<div class="st bad dadm" role="status">${o.head ? `<span>${esc(o.head)}:</span>` : ''}${TM.adminHtml(o.res)}</div>`;
    return `<div class="st${o.kind === 'bad' ? ' bad' : ''}" role="status">${o.kind === 'bad' ? TM.warnLine('', o.text) : `<span>${esc(o.text)}</span>`}</div>`;
  }
  const sub = (r) => outHtml(outcome.get(keyOf(r)));

  /* ---- Delete usage history: Windows deletes at once (no question in its resources); a needsConfirm from
     main is still shown by TM.run, and the command is never sent twice while one is in flight ---- */
  let clearing = false;
  async function clearHistory() {
    if (clearing) return null;
    clearing = true;
    pageOut = { kind: 'busy', text: 'Deleting usage history...' };
    TM.refresh();
    let res;
    try { res = await TM.run('clearHistory', {}); } finally { clearing = false; }
    if (!res || res.cancelled) pageOut = null;
    else if (res.ok === false) pageOut = res.needsAdmin ? { kind: 'admin', res, head: 'Usage history was not deleted' } : { kind: 'bad', text: `Usage history was not deleted: ${res.reason}` };
    else if (res.dryRun) pageOut = { kind: 'dry', text: res.reason || 'Test Mantle: usage history was not deleted.' };
    else pageOut = { kind: 'ok', text: 'Usage history deleted.' };
    const at = Date.now(); pageOut.at = at;
    if (pageOut.kind === 'ok' || pageOut.kind === 'dry') setTimeout(() => { if (pageOut && pageOut.at === at) { pageOut = null; TM.refresh(); } }, 15000);
    TM.refresh();
    return res;
  }

  /* ---- the row menu: Windows' "App history Context" ---- */
  async function switchTo(r) {
    setOut(r, { kind: 'busy', text: `Opening ${r.name}...` });
    said(r, await TM.run('switchTo', { identity: r.identity, name: r.name }), `${r.name} did not open`, '');
  }
  function rowMenu(r) {
    return [
      { label: 'Switch to', act: () => switchTo(r) },
      { label: 'Search online', act: () => TM.act.searchOnline(r.name) },
      { label: 'Properties', disabled: !r.path, title: r.path ? undefined : NOT.path, act: () => TM.act.properties(r.path) },
    ];
  }

  /* ---- the lines over the list ---- */
  const dateWords = (ms) => { const d = new Date(ms); return isNaN(d) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }); };
  function sinceHtml() {
    const all = !!(m.settings && m.settings.historyAllProcesses);
    // SRUM scope 'allUsers' = the current user's id was not in Windows' map, so every account is summed (notes say so)
    const who = ah().scope === 'allUsers' ? 'for all user accounts.' : all ? 'for current user and system accounts.' : 'for current user account.';
    const d = ah().since != null ? dateWords(ah().since) : null;
    const date = d ? esc(d) : TM.na((ah().why && ah().why.since) || (ah().source === 'srum' ? 'Windows did not say when its record began' : 'Mantle did not say when this record began'));
    return `Resource usage since ${date} ${who}`;
  }
  function srcHtml() {
    const a = ah();
    if (a.source === 'srum') {
      // Windows' own history (SRUM, through the helper): its notes say what is missing (e.g. a table, so a column is 0)
      const n = Array.isArray(a.notes) ? a.notes.filter(Boolean) : a.notes ? [String(a.notes)] : [];
      return n.length ? TM.warnLine('', `Windows' App history: ${n.join('; ')}.`) : '';
    }
    if (a.source !== 'mantle') return '';
    const d = a.since != null ? dateWords(a.since) : null;
    // admin access set up but Windows' read failed: lib's error says why (never "needs administrator access")
    const reason = a.error || `This is Mantle's own record${d ? `, kept since ${d}` : ''}: Windows' full app history needs administrator access.`;
    return TM.adminHtml({ reason });
  }
  function lines(on) {
    lineEl.hidden = !on;
    TM.setHtml(lineEl, on ? sinceHtml() : '');
    const s = on ? srcHtml() : '';
    TM.setHtml(srcEl, s);
    srcEl.hidden = !s;
    const o = outHtml(pageOut);
    TM.setHtml(outEl, o);
    outEl.hidden = !o;
  }

  TM.page({
    id: 'apphistory',
    init(root) {
      root.innerHTML = '<div class="ahhead"><p class="ahsince"></p><div class="ahsrc" hidden></div><div class="ahout" hidden></div></div><div class="ahtbl"></div>';
      lineEl = root.querySelector('.ahsince'); srcEl = root.querySelector('.ahsrc'); outEl = root.querySelector('.ahout');
      t = TM.table(root.querySelector('.ahtbl'), {
        id: 'apphistory', cols: COLS, sort: { by: 'name', dir: 1 },
        label: 'App history. Up and down to choose, the menu key for more.',
        key: keyOf, sub,
        onEnter: (r) => switchTo(r),
        onDbl: () => {},
        menu: rowMenu,
      });
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('apphistory');
      const a = ah();
      lines(st === 'ok');
      if (st !== 'ok') {
        // loading: lib's note says what is being read (Windows' own history through the helper)
        t.state(st === 'unsupported' ? TM.stateHtml('unsupported') : st === 'error' ? TM.stateHtml('error', a.error || 'Mantle could not read the app history.') : TM.stateHtml('loading', (a.loading && a.note) || 'Reading app history...'));
        t.render({ rows: [] });
        return;
      }
      const all = !!(m.settings && m.settings.historyAllProcesses);
      rowsAll = (a.rows || []).filter((r) => all || r.app !== false);
      const live = new Set(rowsAll.map(keyOf));
      for (const k of Array.from(outcome.keys())) if (!live.has(k)) outcome.delete(k);
      const rows = rowsAll.filter((r) => TM.match(r.name, r.identity));
      t.state(TM.q && !rows.length ? TM.stateHtml('noq') : !rows.length ? TM.stateHtml('empty', 'No data available') : null);
      t.render({ rows });
      if (a.error && a.source !== 'mantle') TM.note(`App history: ${a.error}`);   // 'mantle': said on the source line
    },
    commands() {
      return [
        { id: 'clear', label: 'Delete usage history', icon: TRASH, disabled: clearing, title: clearing ? 'Deleting usage history...' : 'Delete usage history', act: () => clearHistory() },
      ];
    },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
  });
}());
