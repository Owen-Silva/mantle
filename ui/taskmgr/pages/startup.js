/* pages/startup.js - Windows' Startup apps page (TM-SPEC.md "Startup apps"), on the shell's TM.table.
 * Rows: model.startup.rows, one per startup entry (key s<item>). "Last BIOS time" sits right of the title
 * (model.startup.biosSec). Default columns are Windows' four; the header's right-click is the shell's column
 * checklist, which lists Windows' extra six (Startup type, Disk I/O at startup, CPU at startup, Running now,
 * Disabled time, Command line), remembered by the table.
 *
 * Enable / Disable is `startupSet` {item, enabled}. Windows asks nothing first, so neither does this page; but
 * main may still answer needsConfirm, so the page asks main with dryRun:true and noConfirm first (nothing is
 * done): needsConfirm => main's dialog only, then the command goes with confirmed:true; a dry run that already
 * fails (needs admin, no such command) is said on the row without trying. Every outcome is said ON its row
 * (busy, done, a dry run's words, failed + reason, needs admin + "Set up administrator access"), never silent.
 */
(function () {
  'use strict';
  const { esc, fmt, ICON } = TM;
  let t = null, m = {}, rowsAll = [];
  const outcome = new Map();   // item -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, head, at }
  const busy = new Set();

  /* ---- columns: Windows' own, in Windows' order (Name is always there) ---- */
  const NOT = {
    publisher: 'Its file names no publisher, or Windows did not let Mantle read it',
    impact: 'Windows has not measured this one yet, or Mantle could not read its measurement',
    type: 'Windows did not say where this entry is registered',
    diskIO: 'Windows has not measured its disk use at startup, or reading it needs administrator rights',
    cpuMs: 'Windows has not measured its CPU time at startup, or reading it needs administrator rights',
    running: 'Mantle could not tell whether it is running',
    disabledAt: 'Windows did not record when it was disabled',
    cmdline: 'Windows did not say what this entry runs',
    _: 'Windows did not report this for this entry',
  };
  const IMPACT_RANK = { high: 4, medium: 3, low: 2, none: 1, 'not measured': 0 };
  const pad = (n) => String(n).padStart(2, '0');
  // Windows' short date and time: 9/3/2026 6:02 PM. lib sends disabledAt as ISO-8601 UTC (sidecar Startup.cs)
  // or ms; any other value is not a time (em dash).
  const msOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN);
  const when = (v) => { const ms = msOf(v); if (!isFinite(ms)) return null; const d = new Date(ms); const h = d.getHours(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`; };
  // the em dash's reason: the row's own why, else the page's (model.startup.why: impact, biosSec, ...), else ours
  const C = (id, label, o) => Object.assign({ id, label, title: label, def: false, why: (r) => (r.why && r.why[id]) || (m.startup && m.startup.why && m.startup.why[id]) || NOT[id] || NOT._ }, o || {});
  const COLS = [
    { id: 'name', label: 'Name', fixed: true, flex: true, min: 200, get: (r) => String(r.name || '').toLowerCase(),
      html: (r) => `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>` },
    C('publisher', 'Publisher', { def: true, w: 190 }),
    C('status', 'Status', { def: true, w: 96, get: (r) => (r.enabled ? 1 : 0), text: (r) => (r.enabled == null ? null : r.enabled ? 'Enabled' : 'Disabled') }),
    C('impact', 'Startup impact', { def: true, w: 120, get: (r) => (r.impact == null ? -1 : IMPACT_RANK[String(r.impact).toLowerCase()] ?? 0) }),
    // Windows' column says Registry or Folder; lib's label ("Registry, this user") stays in the tooltip
    C('type', 'Startup type', { w: 110, get: (r) => String(r.type || ''),
      html: (r) => (r.type == null ? TM.na((r.why && r.why.type) || NOT.type) : `<span title="${esc(r.type)}">${esc(/^registry/i.test(r.type) ? 'Registry' : /folder/i.test(r.type) ? 'Folder' : r.type)}</span>`) }),
    C('diskIO', 'Disk I/O at startup', { num: true, w: 130, get: (r) => r.diskIO, text: (r) => fmt.mb(r.diskIO) }),
    C('cpuMs', 'CPU at startup', { num: true, w: 110, get: (r) => r.cpuMs, text: (r) => (typeof r.cpuMs === 'number' && isFinite(r.cpuMs) ? `${fmt.num(r.cpuMs)} ms` : null) }),
    // Windows leaves both blank when there is nothing to say (not running / never disabled): blank, not unknown
    C('running', 'Running now', { w: 100, get: (r) => (r.running ? 1 : 0), text: (r) => (r.running == null ? null : r.running ? 'Running' : '') }),
    C('disabledAt', 'Disabled time', { w: 150, get: (r) => msOf(r.disabledAt) || 0, text: (r) => (r.disabledAt != null ? when(r.disabledAt) : r.enabled === false ? null : '') }),
    C('cmdline', 'Command line', { w: 280 }),
  ];

  /* ---- outcomes on the row ---- */
  function setOut(r, o) {
    if (o) outcome.set(r.item, Object.assign({ at: Date.now() }, o)); else outcome.delete(r.item);
    if (o && (o.kind === 'ok' || o.kind === 'dry')) { const at = outcome.get(r.item).at; setTimeout(() => { const x = outcome.get(r.item); if (x && x.at === at) { outcome.delete(r.item); TM.refresh(); } }, 15000); }
    TM.refresh();
  }
  function said(r, res, head, done) {
    if (!res || res.cancelled) { setOut(r, null); return res; }
    if (res.ok === false) setOut(r, res.needsAdmin ? { kind: 'admin', res, head } : { kind: 'bad', text: `${head}: ${res.reason || 'Mantle gave no reason.'}` });
    else if (res.dryRun) setOut(r, { kind: 'dry', text: res.reason || `Test Mantle: ${head.toLowerCase()}.` });
    else setOut(r, done ? { kind: 'ok', text: done } : null);
    return res;
  }
  function sub(r) {
    const o = outcome.get(r.item);
    if (!o) return '';
    if (o.kind === 'busy') return `<div class="st" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(o.text)}</span></div>`;
    if (o.kind === 'admin') return `<div class="st bad suadm" role="status">${o.head ? `<span>${esc(o.head)}:</span>` : ''}${TM.adminHtml(o.res)}</div>`;
    return `<div class="st${o.kind === 'bad' ? ' bad' : ''}" role="status">${o.kind === 'bad' ? TM.warnLine('', o.text) : `<span>${esc(o.text)}</span>`}</div>`;
  }

  /* ---- Enable / Disable: one dialog at most (main's), see the header ---- */
  async function guarded(r, cmd, args, busyWords) {
    const key = r.item + cmd;
    if (busy.has(key)) return { ok: false, cancelled: true };
    busy.add(key);
    try {
      const pre = await TM.run(cmd, Object.assign({}, args, { dryRun: true }), { noConfirm: true, noDry: true });
      if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
        const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'OK', check: pre.check || null, width: 460 });
        if (!c.ok) return { ok: false, cancelled: true };
        setOut(r, { kind: 'busy', text: busyWords });
        return await TM.run(cmd, Object.assign({}, args, { confirmed: true }));
      }
      if (pre.ok === false) return pre;        // needs admin / failed / no such command: said without trying
      setOut(r, { kind: 'busy', text: busyWords });
      return await TM.run(cmd, args);
    } finally { busy.delete(key); }
  }
  async function toggle(r) {
    if (!r) return;
    const on = !r.enabled;
    const res = await guarded(r, 'startupSet', { item: r.item, enabled: on }, on ? 'Enabling...' : 'Disabling...');
    said(r, res, on ? 'Not enabled' : 'Not disabled', on ? 'Enabled' : 'Disabled');
  }

  /* ---- menus ---- */
  const noPath = (r) => !r.path;
  const NOPATH = 'Windows did not say where its file is';
  function rowMenu(r) {
    return [
      { label: r.enabled ? 'Disable' : 'Enable', act: () => toggle(r) },
      { sep: true },
      { label: 'Open file location', disabled: noPath(r), title: noPath(r) ? NOPATH : undefined, act: () => TM.act.openLocation(r.path) },
      { label: 'Search online', act: () => TM.act.searchOnline(r.name) },
      { label: 'Properties', disabled: noPath(r), title: noPath(r) ? NOPATH : undefined, act: () => TM.act.properties(r.path) },
    ];
  }
  const selRow = () => (t ? t.selected() : null);

  TM.page({
    id: 'startup',
    init(root) {
      root.innerHTML = '<div class="sutbl"><p class="su-part" hidden></p></div>';
      const host = root.querySelector('.sutbl');
      t = TM.table(host, {
        id: 'startup', cols: COLS, sort: { by: 'name', dir: 1 },
        label: 'Startup apps. Up and down to choose, the menu key for more.',
        key: (r) => 's' + r.item,
        sub, cls: (r) => (r.enabled === false ? 'off' : ''),
        onEnter: () => {},
        onDbl: () => {},
        menu: rowMenu,
      });
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('startup');
      const d = m.startup || {};
      rowsAll = d.rows || [];
      const part = document.querySelector('#pg-startup .su-part');
      const pnote = st === 'ok' && (d.note || (d.error && rowsAll.length ? d.error : null));
      if (part) { const h = pnote ? TM.warnLine('', pnote) : ''; if (part._h !== h) { part.innerHTML = h; part._h = h; } part.hidden = !pnote; }
      if (st !== 'ok') {
        t.state(st === 'unsupported' ? TM.stateHtml('unsupported') : st === 'error' ? TM.stateHtml('error', d.error || 'Mantle could not read the startup apps.') : TM.stateHtml('loading', 'Reading startup apps...'));
        t.render({ rows: [] });
        return;
      }
      const live = new Set(rowsAll.map((r) => r.item));
      for (const k of Array.from(outcome.keys())) if (!live.has(k)) outcome.delete(k);
      const rows = rowsAll.filter((r) => TM.match(r.name, r.publisher));
      t.state(TM.q && !rows.length ? TM.stateHtml('noq') : !rows.length ? TM.stateHtml('empty', 'There are no startup items to display.') : null);
      t.render({ rows });
    },
    extra(mm) {
      const d = mm.startup;
      if (!d || d.loading) return '';
      const v = d.biosSec;
      const val = typeof v === 'number' && isFinite(v) ? `<span class="v">${esc(v.toFixed(1))} seconds</span>`
        : TM.na((d.why && d.why.biosSec) || 'Windows did not record how long the firmware took to start on this PC (no FwPOSTTime)');
      return `<span class="su-bios">Last BIOS time: ${val}</span>`;
    },
    commands() {
      const r = selRow();
      const pick = 'choose an app first';
      const lab = r && r.enabled ? 'Disable' : 'Enable';
      return [
        { id: 'toggle', label: lab, icon: r && r.enabled ? ICON.disable : ICON.enable, disabled: !r, title: r ? lab : `${lab} (${pick})`, act: () => toggle(selRow()) },
        { id: 'props', label: 'Properties', icon: ICON.props, disabled: !r || noPath(r), title: !r ? `Properties (${pick})` : noPath(r) ? NOPATH : 'Properties', act: () => { const x = selRow(); if (x) TM.act.properties(x.path); } },
      ];
    },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
  });
}());
