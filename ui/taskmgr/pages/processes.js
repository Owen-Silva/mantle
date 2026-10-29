/* pages/processes.js - Windows' Processes page (TM-SPEC.md "Processes"), on the shell's TM.table.
 * Rows: model.apps (+ model.mantleRow) / model.background / model.windows, grouped "Apps (n)", "Background
 * processes (n)", "Windows processes (n)" (View > Group by type off = one list). A row expands like Windows':
 * an app of several processes to its processes (main sends them only while it is open: command `expand`), a
 * process that owns a window to that window (its title). Totals over the numeric headers come from
 * model.totals; heat on the numbers. Anything not measured is an em dash whose tooltip says why (the row's own
 * why.<field> first, then the reasons below).
 * Mantle's own outcome stays ON the row (its sub line): ending / ended / still running (+ Force close, asked
 * on the row) / failed / trimming / trimmed / dry run / needs administrator. Trim memory is Mantle's one
 * extra, in the row menu only. Force close is never in the command bar: it is only the way out when End
 * task's polite close left the app running.
 */
(function () {
  'use strict';
  const { esc, fmt, ICON, store } = TM;
  const MB = 1048576;
  const keyPid = (k) => { const n = parseInt(String(k || '').split('|')[0], 10); return isFinite(n) ? n : null; };
  const pidOf = (r) => (r.pid != null ? r.pid : keyPid(r.key));

  /* ---- View settings (persisted, this window only) ---- */
  const oldStatus = store.get('proc.status', null);   // the first version kept one word
  const S = {
    group: store.get('proc.group', true),
    st: store.get('proc.status2', oldStatus === 'none' ? { susp: false, eff: false } : oldStatus === 'suspended' ? { susp: true, eff: false } : oldStatus === 'efficiency' ? { susp: false, eff: true } : { susp: true, eff: true }),
    res: Object.assign({ mem: 'values', disk: 'values', net: 'values' }, store.get('proc.res', {})),
  };
  let t = null, m = {};
  const WIN_GLYPH = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2 5.8h12" stroke="currentColor" stroke-width="1.1"/></svg>';
  const lv = (x, steps) => { if (!(x > 0)) return 0; let i = 0; while (i < steps.length && x >= steps[i]) i++; return i; };
  const memTotal = () => (m.mem && m.mem.total) || (m.perf && m.perf.mem && m.perf.mem.total) || 0;
  /* the em dash's reason when the row did not send its own (row.why.<field>) */
  const NOT = {
    disk: "Disk use per process was not measured (Mantle's helper did not report it)",
    net: 'Network use per process needs administrator access to measure (Windows counts it per process only for administrators)',
    gpu: 'GPU use per process was not measured',
    publisher: 'Windows did not report a publisher for this file',
    cmdline: 'Windows did not let Mantle read its command line',
    power: "Windows' power estimate is not readable without administrator access",
    diskPct: 'Disk as a percent is not shown: Windows does not report how much of the disk one process uses, only its MB/s',
    netPct: 'Network as a percent is not shown: the link speed per process is not measured, only its Mbps',
    memPct: 'Total memory was not reported, so no percent can be worked out',
    pid: 'An app of several processes has no single PID: expand it to see each one',
  };
  const isWin = (r) => r.kind === 'window';
  const W = (f) => (r) => (isWin(r) ? '' : f(r));      // a window row: blank numbers, like Windows
  const totWhy = (k) => (m.totals && m.totals.why && m.totals.why[k]) || null;
  const tot = (k, label) => () => {
    const T = m.totals || null;
    const v = T ? T[k] : k === 'cpu' ? m.cpu : k === 'mem' && memTotal() && m.mem ? (m.mem.used / memTotal()) * 100 : null;
    if (v == null) return { v: null, title: `${label}: ${totWhy(k) || 'not measured on this PC'}` };
    return { v: Math.round(v) + '%', title: `${label}: ${Math.round(v)}% in use`, hi: v >= 80 };
  };
  /* Status: Windows writes "Not responding"; Suspended and Efficiency mode are icons (with the words as the tooltip) */
  const statusOf = (r) => {
    if (r.hung || r.status === 'Not responding') return 'Not responding';
    if ((r.suspended || r.status === 'Suspended') && S.st.susp) return 'Suspended';
    if ((r.efficiency || r.status === 'Efficiency mode') && S.st.eff) return 'Efficiency mode';
    return '';
  };
  const TYPE = { app: 'App', mantle: 'App', background: 'Background process', windows: 'Windows process' };
  const COLS = [
    { id: 'name', label: 'Name', fixed: true, flex: true, min: 180, get: (r) => r.name || r.file, html: nameHtml },
    { id: 'type', label: 'Type', def: false, w: 140, text: (r) => (isWin(r) || r._child ? '' : TYPE[r.type || r.kind] || null), why: () => 'Mantle did not say which group this row is in' },
    { id: 'status', label: 'Status', w: 110, get: statusOf, html: (r) => {
      const s = statusOf(r);
      if (!s) return '';
      if (s === 'Not responding') return `<span class="pst bad">${esc(s)}</span>`;
      const ic = s === 'Suspended' ? ICON.pause : ICON.leaf;
      const tip = s === 'Suspended' ? 'This process is suspended' : 'This process is running in Efficiency mode';
      return `<span class="pst ${s === 'Suspended' ? 'sus' : 'eff'}" title="${esc(tip)}" role="img" aria-label="${esc(s)}">${ic}</span>`;
    } },
    { id: 'publisher', label: 'Publisher', def: false, w: 170, text: W((r) => r.publisher), why: () => NOT.publisher },
    { id: 'pid', label: 'PID', def: false, num: true, w: 70, get: (r) => (r.count > 1 || isWin(r) ? null : pidOf(r)), text: (r) => (r.count > 1 || isWin(r) ? '' : pidOf(r)), why: () => NOT.pid },
    { id: 'processName', label: 'Process name', def: false, w: 150, text: W((r) => r.processName || r.file) },
    { id: 'cmdline', label: 'Command line', def: false, w: 280, text: W((r) => r.cmdline), why: () => NOT.cmdline },
    { id: 'cpu', label: 'CPU', num: true, w: 76, get: (r) => r.cpu, text: W((r) => fmt.pct(r.cpu)), heat: (r) => lv(r.cpu, [0.5, 3, 10, 25, 50]), total: tot('cpu', 'CPU') },
    { id: 'mem', label: 'Memory', num: true, w: 100, get: (r) => r.mem, title: 'Memory (active private working set)',
      text: W((r) => (S.res.mem === 'percents' ? (memTotal() ? fmt.pct((r.mem / memTotal()) * 100) : null) : fmt.mb(r.mem))),
      why: () => (S.res.mem === 'percents' ? NOT.memPct : 'Memory was not reported'), heat: (r) => lv(r.mem / MB, [50, 150, 400, 900, 1600]), total: tot('mem', 'Memory') },
    { id: 'disk', label: 'Disk', num: true, w: 84, get: (r) => r.disk, text: W((r) => (S.res.disk === 'percents' ? null : fmt.rate(r.disk))),
      why: (r) => (S.res.disk === 'percents' && r.disk != null ? NOT.diskPct : NOT.disk), heat: (r) => lv((r.disk || 0) / MB, [0.1, 1, 5, 20, 60]), total: tot('disk', 'Disk') },
    { id: 'net', label: 'Network', num: true, w: 88, get: (r) => r.net, text: W((r) => (S.res.net === 'percents' ? null : fmt.mbps(r.net))),
      why: (r) => (S.res.net === 'percents' && r.net != null ? NOT.netPct : NOT.net), heat: (r) => lv(((r.net || 0) * 8) / 1e6, [0.1, 1, 5, 25, 100]), total: tot('net', 'Network') },
    { id: 'gpu', label: 'GPU', num: true, def: false, w: 70, get: (r) => r.gpu, text: W((r) => fmt.pct(r.gpu)), why: () => NOT.gpu, heat: (r) => lv(r.gpu, [0.5, 3, 10, 25, 50]), total: tot('gpu', 'GPU') },
    // no engine while it uses no GPU is Windows' blank; an unmeasured GPU is the em dash
    { id: 'gpuEngine', label: 'GPU engine', def: false, w: 120, whyKey: 'gpu', text: W((r) => (r.gpuEngine ? r.gpuEngine : r.gpu == null ? null : '')), why: () => NOT.gpu },
    { id: 'power', label: 'Power usage', def: false, w: 110, text: W((r) => r.power), why: () => NOT.power },
    { id: 'powerTrend', label: 'Power usage trend', def: false, w: 130, whyKey: 'power', text: W((r) => r.powerTrend), why: () => NOT.power },
  ];

  /* Windows' minimum window (560 px): the default columns narrow so they still fit without a sideways scroll */
  const WIDE = { name: 180, status: 110, cpu: 76, mem: 100, disk: 84, net: 88 }, NARROW = { name: 134, status: 80, cpu: 56, mem: 84, disk: 70, net: 76 };
  let narrow = null;
  function fit() {
    const n = innerWidth < 720;
    if (n === narrow) return;
    narrow = n;
    for (const c of COLS) { const w = (n ? NARROW : WIDE)[c.id]; if (w == null) continue; if (c.flex) c.min = w; else c.w = w; }
    if (t) { t.relayout(); t.render(); }
  }
  fit();
  window.addEventListener('resize', fit);

  function nameHtml(r) {
    if (isWin(r)) return `<span class="ic tile win" aria-hidden="true">${WIN_GLYPH}</span><span class="n" title="${esc(r.name)}">${esc(r.name)}</span>`;
    const nm = r.name || r.file || '';
    const tip = r.title && r.title !== nm && !(r.count === 1 && r.windows) ? `${nm} · ${r.title}` : nm;
    return `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(tip)}">${esc(nm)}</span>${r.count > 1 ? `<span class="k">(${r.count})</span>` : ''}` +
      (r.protected ? `<span class="plock" title="${esc(r.protected)}">${ICON.lock}</span>` : '');
  }

  /* ---- children: an app's processes (while open), a process's window ---- */
  // a window row: its title; its owner is the app (the top-level row) whose End task / Switch to it uses
const winRow = (r) => ({ kind: 'window', key: 'w' + (pidOf(r) != null ? pidOf(r) : r.key), name: r.title, pid: pidOf(r), _owner: r._child ? r._parent : r, _child: true, _parent: r });
  const hasWin = (r) => !!(r.title && (r.windows > 0 || r.windows === undefined));
  const countOf = (r) => (isWin(r) ? 0 : r.count > 1 ? r.count : hasWin(r) ? 1 : 0);
  function childrenOf(r) {
    if (r.count > 1) {
      if (!r.members) return null;   // main sends them once `expand` reached it: "Loading..."
      return r.members.map((x) => Object.assign({}, x, { _child: true, _parent: r, icon: x.icon || r.icon, iconWhy: x.iconWhy || r.iconWhy, path: x.path || r.path }));
    }
    return hasWin(r) ? [winRow(r)] : [];
  }

  /* ---- Mantle's outcome on the row: main's state first, else what this page heard back (12 s) ---- */
  const local = new Map();   // row item key -> { state, why, res, at }
  let ask = null;            // the item key whose "Force close?" question is open on its row
  function outcome(it, o) { if (!it) return; if (o) local.set(it.k, Object.assign({ at: Date.now() }, o)); else local.delete(it.k); TM.refresh(); }
  function sub(r, it) {
    if (ask && it && ask === it.k) {
      return `<div class="st ask" role="alertdialog" aria-label="Force close ${esc(r.name)}?"><span>Force close ${esc(r.name)}? It ends at once, and anything unsaved in it is lost.</span><span class="grow"></span>` +
        '<button type="button" class="btn sm dng" data-act="force-yes">Force close</button><button type="button" class="btn sm" data-act="force-no" title="Cancel (Esc)">Cancel</button></div>';
    }
    let s = r.state || null;
    const mine = it && local.get(it.k);
    if (mine && Date.now() - mine.at > 12000) local.delete(it.k);
    else if (mine && (!s || mine.at > (s.at || 0))) s = mine;
    if (!s) return '';
    if (s.state === 'admin') return `<div class="st adm" role="status">${TM.adminHtml(s.res)}</div>`;
    const map = {
      closing: [`Ending...${s.why ? ' ' + s.why : ''}`, ''],
      closed: [`Ended${s.freed ? ` · freed about ${fmt.mbi(s.freed)}` : ''}`, ''],
      'still-running': [s.why || 'It is still running.', 'bad'],
      failed: [s.why || 'It did not work, and no reason came back.', 'bad'],
      trimming: ['Trimming memory...', ''],
      trimmed: [`Memory trimmed: ${fmt.mbi(s.before)} → ${fmt.mbi(s.after)}${s.why ? ' · ' + s.why : ''}`, ''],
      dry: [s.why || 'Test Mantle: nothing was done.', ''],
    };
    const [text, cls] = map[s.state] || [s.why || 'Done.', ''];
    const force = s.state === 'still-running' && r.actions && r.actions.force ? '<span class="grow"></span><button type="button" class="btn sm" data-act="force">Force close</button>' : '';
    return `<div class="st ${cls}" role="status">${cls === 'bad' ? TM.warnLine('', text) : `<span>${esc(text)}</span>`}${force}</div>`;
  }
  /* one answer from main -> the row: refused (needsAdmin with the setup button), dry run, or nothing (main's state speaks) */
  function heard(it, res, head) {
    if (!res || res.cancelled) return res;
    if (res.ok === false && res.needsAdmin) outcome(it, { state: 'admin', res: Object.assign({}, res, { reason: head ? `${head}: ${res.reason}` : res.reason }) });
    else if (res.ok === false) outcome(it, { state: 'failed', why: head ? `${head}: ${res.reason}` : res.reason });
    else if (res.dryRun) outcome(it, { state: 'dry', why: res.reason || res.why || 'Test Mantle: nothing was done.' });
    else outcome(it, null);
    return res;
  }

  /* ---- actions ---- */
  const isExplorer = (r) => !!r && !r._child && /^explorer\.exe$/i.test(r.file || r.processName || '') && (r.kind === 'windows' || r.type === 'windows');
  const isWinProc = (r) => r.kind === 'windows' || r.type === 'windows';
  const busy = new Set();
  async function act(action, r, it, extra) {
    const id = (it ? it.k : r.key) + '|' + action;
    if (busy.has(id)) return null;          // a double click sends one request
    busy.add(id);
    try {
      const res = await TM.run('act', Object.assign({ action, key: r.key }, extra || {}), { noDry: true });
      return heard(it, res, { close: 'Not ended', force: 'Not force closed', trim: 'Not trimmed' }[action]);
    } finally { busy.delete(id); }
  }
  /* End task, Windows' way: a window row ends its app; one process of an app ends that process; Windows
     Explorer restarts; a Windows process asks Windows' question first (main's needsConfirm, TM.run asks);
     a frozen app is ended at once (it cannot hear a polite close); any other app is closed politely, and if it
     keeps running its row offers Force close. */
  async function endTask(r, it, plain) {
    if (!r) return null;
    if (isWin(r)) return endTask(r._owner, it ? t.rows.get(it.k.split('>')[0]) || it : null);   // its app, like Windows
    if (r._child) return heard(it, await TM.run('endPid', { pid: r.pid, created: r.created }), 'Not ended');
    if (isExplorer(r) && !plain) return restartExplorer(it);   // the button and Delete say Restart; the menu has both
    const a = r.actions || {};
    if (isWinProc(r)) return act('close', r, it);
    if (r.hung && a.force) return act('force', r, it, { confirmed: true });
    if (a.close) return act('close', r, it);
    outcome(it, { state: 'failed', why: `Not ended: ${r.protected || a.why || 'Mantle does not end it'}` });
    return null;
  }
  function askForce(it) {
    ask = it ? it.k : null;
    TM.refresh();
    const b = ask && t.el.querySelector(`[data-key="${CSS.escape(ask)}"] [data-act="force-no"]`);
    if (b) b.focus();   // Cancel has the focus: Enter cannot force by accident
  }
  async function restartExplorer(it) {
    return heard(it, await TM.run('restartExplorer', {}), 'Windows Explorer did not restart');
  }
  async function efficiency(r, it) {
    if (!canEff(r)) return null;
    const res = await TM.act.efficiency(r._child ? { pid: r.pid } : { key: r.key, pid: pidOf(r) }, !r.efficiency, r.name || r.file);
    return heard(it, res, r.efficiency ? 'Efficiency mode was not turned off' : 'Efficiency mode was not turned on');
  }
  async function switchTo(r, it, op) {
    const o = isWin(r) ? r._owner : r._child ? r._parent : r;
    const args = { key: o.key, pid: pidOf(r) };
    if (op) args.op = op;
    const res = await TM.run('switchTo', args, { noDry: true });
    if (res.ok !== false && !res.dryRun && m.settings && m.settings.minimizeOnUse) TM.run('win', { op: 'min' }, { noDry: true });
    return heard(it, res, { front: 'Not brought to front', minimize: 'Not minimized', maximize: 'Not maximized' }[op] || 'Not switched to');
  }
  const canEnd = (r) => !!r && (isWin(r) ? canEnd(r._owner) : !!r._child || isExplorer(r) || isWinProc(r) || !!(r.actions && (r.actions.close || r.actions.force)));
  const endWhy = (r) => (r && isWin(r) ? endWhy(r._owner) : r ? r.protected || (r.actions && r.actions.why) || 'Mantle does not end it' : 'Choose a process first');
  const canEff = (r) => !!r && !isWin(r) && !isWinProc(r) && r.kind !== 'mantle' && !(r._parent && (isWinProc(r._parent) || r._parent.kind === 'mantle'));
  const effWhy = (r) => (!r ? 'Choose a process first' : isWin(r) ? 'A window has no Efficiency mode: choose its process' : r.kind === 'mantle' || (r._parent && r._parent.kind === 'mantle') ? 'Mantle itself: Efficiency mode would slow the task manager you are using' : 'Windows does not allow Efficiency mode for Windows processes');
  const pathOf = (r) => r.path || (r._parent && r._parent.path) || null;

  /* ---- menus ---- */
  function resMenu() {
    const one = (k, label) => ({ label, sub: [['values', 'Values'], ['percents', 'Percents']].map(([v, l]) => ({ label: l, radio: true, checked: S.res[k] === v,
      title: v === 'percents' && k !== 'mem' ? (k === 'disk' ? NOT.diskPct : NOT.netPct) : undefined,
      act: () => { S.res[k] = v; store.set('proc.res', S.res); TM.refresh(); } })) });
    return [one('mem', 'Memory'), one('disk', 'Disk'), one('net', 'Network')];
  }
  const setStatus = (st) => { S.st = st; store.set('proc.status2', st); TM.refresh(); };
  function statusMenu() {
    return [
      { label: 'Show suspended status', checked: S.st.susp, act: () => setStatus({ susp: !S.st.susp, eff: S.st.eff }) },
      { label: 'Show efficiency mode status', checked: S.st.eff, act: () => setStatus({ susp: S.st.susp, eff: !S.st.eff }) },
      { label: 'Hide status', checked: !S.st.susp && !S.st.eff, act: () => setStatus(S.st.susp || S.st.eff ? { susp: false, eff: false } : { susp: true, eff: true }) },
    ];
  }
  function viewMenu() {
    return [
      { label: 'Group by type', checked: S.group, act: () => { S.group = !S.group; store.set('proc.group', S.group); TM.refresh(); } },
      { label: 'Expand all', act: () => t.expandAll() },
      { label: 'Collapse all', act: () => t.collapseAll() },
      { sep: true },
      { label: 'Status values', sub: statusMenu },
      { label: 'Resource values', sub: resMenu },
    ];
  }
  function rowMenu(r, it) {
    const items = [];
    if (isWin(r)) {
      return [
        { label: 'Switch to', act: () => switchTo(r, it) },
        { label: 'Bring to front', act: () => switchTo(r, it, 'front') },
        { label: 'Minimize', act: () => switchTo(r, it, 'minimize') },
        { label: 'Maximize', act: () => switchTo(r, it, 'maximize') },
        { sep: true },
        { label: 'End task', key: 'Delete', disabled: !canEnd(r._owner), title: canEnd(r._owner) ? undefined : endWhy(r._owner), act: () => endTask(r, it) },
      ];
    }
    const child = !!r._child, pid = pidOf(r);
    if (countOf(r) > 0) items.push({ label: t.open.has(it.k) ? 'Collapse' : 'Expand', act: () => t.toggle(it.k) });
    if (!child && r.windows > 0 && (r.type === 'app' || r.kind === 'app' || r.kind === 'mantle')) items.push({ label: 'Switch to', act: () => switchTo(r, it) });
    if (isExplorer(r)) items.push({ label: 'Restart', act: () => restartExplorer(it) });
    items.push({ label: 'End task', key: isExplorer(r) ? undefined : 'Delete', disabled: !canEnd(r), title: canEnd(r) ? undefined : endWhy(r), act: () => endTask(r, it, true) });
    items.push({ sep: true }, { label: 'Resource values', sub: resMenu }, { sep: true });
    items.push({ label: 'Efficiency mode', checked: !!r.efficiency, disabled: !canEff(r), title: canEff(r) ? undefined : effWhy(r), act: () => efficiency(r, it) });
    items.push({ label: 'Create memory dump file', disabled: pid == null, title: pid == null ? 'No process ID was reported' : undefined, act: () => TM.act.dump(pid, r.name || r.file) });
    items.push({ sep: true });
    items.push({ label: 'Go to details', disabled: pid == null, act: () => TM.act.goToDetails(pid) });
    const p = pathOf(r);
    items.push({ label: 'Open file location', disabled: !(r.canReveal || p), title: r.canReveal || p ? undefined : 'Windows did not let Mantle see where its file is', act: () => TM.act.openLocation(p, child ? null : r.key) });
    items.push({ label: 'Search online', act: () => TM.act.searchOnline(r.processName || r.file || r.name) });
    items.push({ label: 'Properties', disabled: !p, title: p ? undefined : 'Windows did not let Mantle see where its file is', act: () => TM.act.properties(p) });
    if (!child && r.actions && r.actions.trim) items.push({ sep: true }, { label: 'Trim memory', title: 'Hands its unused memory back to Windows; it keeps running (Mantle)', act: () => act('trim', r, it) });
    return items;
  }

  /* ---- the rows Windows shows: Mantle's own row leads the apps ---- */
  function lists() {
    const keep = (rows) => (rows || []).filter((r) => TM.match(r.name, r.file, r.processName, r.title, r.publisher, pidOf(r)) ||
      (r.members && r.members.some((x) => TM.match(x.name, x.file, x.title, x.pid))));
    return { apps: keep(m.mantleRow ? [m.mantleRow].concat(m.apps || []) : m.apps), bg: keep(m.background), win: keep(m.windows) };
  }

  TM.page({
    id: 'processes',
    init(root) {
      root.innerHTML = '<div class="recent" hidden></div><div class="ptbl"></div>';
      t = TM.table(root.querySelector('.ptbl'), {
        id: 'processes', cols: COLS, sort: { by: 'name', dir: 1 },
        label: 'Processes. Up and down to choose, Enter or Right to expand, Left to collapse, Delete to end the task, the menu key for more.',
        key: (r) => (r._child && !isWin(r) ? 'p' + r.pid : r.key || 'p' + r.pid),
        count: countOf,
        children: childrenOf,
        onExpand: (r, open) => {
          if (ask && !open) ask = null;
          if (!(r.count > 1) || r._child) return;   // only an app of several processes needs main to send them
          TM.run('expand', { key: r.key, open }, { noDry: true }).then((x) => { if (x.ok === false) TM.note(`Its processes did not load (${x.reason}).`); });
        },
        sub,
        cls: (r) => (r.hung ? 'hung' : '') + (r.kind === 'mantle' ? ' mantle' : '') + (isWin(r) ? ' win' : ''),
        onAct: (a, r, b, e, it) => {
          if (a === 'force') askForce(it);
          else if (a === 'force-no') { ask = null; TM.refresh(); t.focus(); }
          else if (a === 'force-yes') { ask = null; act('force', r, it, { confirmed: true }); t.focus(); }
        },
        // Enter / double-click: a window row switches to it (Windows' default there); any other row opens or closes
        onEnter: (r, it) => (isWin(r) ? switchTo(r, it) : t.toggle(it.k)),
        onDbl: (r, it) => (isWin(r) ? switchTo(r, it) : t.toggle(it.k)),
        onDelete: (r, e, it) => endTask(r, it),
        menu: rowMenu,
        headMenu: () => [{ label: 'Resource values', sub: resMenu }],
      });
      /* Windows' header menu lists the columns that can be hidden: Name is not one of them (the shell's
         chooser lists it greyed out), so this page opens the same items without it. */
      const head = t.el.querySelector('.thead');
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        TM.menu.open(t.headItems().filter((x) => !(x.disabled && x.label === 'Name')), { x: e.clientX, y: e.clientY });
      }, true);
      /* the row's own question: Esc answers Cancel */
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && ask && e.target.closest('.st.ask')) { e.preventDefault(); e.stopPropagation(); ask = null; TM.refresh(); t.focus(); }
      });
    },
    render(mm) {
      m = mm || {};
      if (!m.loaded) { t.state(m.error ? TM.stateHtml('error', m.error) : TM.stateHtml('loading', 'Reading running apps...')); t.render({ rows: [] }); return; }
      const { apps, bg, win } = lists();
      t.state(TM.q && !(apps.length + bg.length + win.length) ? TM.stateHtml('noq') : m.error ? TM.stateHtml('error', m.error) : null);
      t.render(S.group ? { groups: [{ id: 'apps', title: 'Apps', rows: apps }, { id: 'background', title: 'Background processes', rows: bg }, { id: 'windows', title: 'Windows processes', rows: win }] } : { rows: apps.concat(bg, win) });
      if (ask && !t.rows.has(ask)) ask = null;
      const rec = (m.recent || []).slice(0, 3);
      const re = t.el.parentElement.previousElementSibling;
      if (re.hidden !== !rec.length) re.hidden = !rec.length;
      TM.setHtml(re, rec.map((x) => (x.ok ? `<span>${esc(x.name)}: ${esc(x.text)}</span>` : TM.warnLine('bad', `${x.name}: ${x.text}`))).join(''));
    },
    commands() {
      const it = t && t.selectedItem(), r = it && it.r;
      const ex = isExplorer(r);
      return [
        ex ? { id: 'restart', label: 'Restart', icon: ICON.restart, act: () => restartExplorer(it), title: 'Restart Windows Explorer', key: 'Delete' }
          : { id: 'end', label: 'End task', icon: ICON.end, key: 'Delete', disabled: !canEnd(r), title: r ? (canEnd(r) ? 'End task' : endWhy(r)) : 'End task (choose a process first)', act: () => endTask(r, it) },
        { id: 'eff', label: 'Efficiency mode', icon: ICON.leaf, checked: !!(r && r.efficiency), disabled: !canEff(r), title: canEff(r) ? 'Efficiency mode' : effWhy(r), act: () => efficiency(r, it) },
        { id: 'view', label: 'View', icon: ICON.view, menu: viewMenu },
      ];
    },
    endTask() { const it = t && t.selectedItem(); if (it) endTask(it.r, it); },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
    show(arg) { if (arg && arg.key && t) t.select(arg.key, true); },
  });
  // for the page test and the bench (read-only views of the page's own state)
  window.__procPage = { get t() { return t; }, S, local };
}());
