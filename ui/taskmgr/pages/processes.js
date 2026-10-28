/* pages/processes.js - Windows' Processes page (TM-SPEC.md "Processes"), on the shell's TM.table.
 * Rows: model.apps (+ model.mantleRow) / model.background / model.windows, grouped "Apps (n)", "Background
 * processes (n)", "Windows processes (n)"; a row expands to its processes (main sends them only while open:
 * command `expand`). Totals over the numeric headers from model.totals; heat on the numbers.
 * Mantle's own outcome reporting stays ON the row (sub line): closing / closed / still running (+ Force close)
 * / failed / trimming / trimmed / dry run. Trim memory is Mantle's one extra, in the row menu only.
 */
(function () {
  'use strict';
  const { esc, fmt, ICON, store } = TM;
  const MB = 1048576;
  const keyPid = (k) => { const n = parseInt(String(k || '').split('|')[0], 10); return isFinite(n) ? n : null; };
  const pidOf = (r) => (r.pid != null ? r.pid : keyPid(r.key));
  const S = { group: store.get('proc.group', true), status: store.get('proc.status', 'all'), res: store.get('proc.res', { mem: 'values', disk: 'values', net: 'values' }) };
  let t = null, m = {};
  const lv = (x, steps) => { if (!(x > 0)) return 0; let i = 0; while (i < steps.length && x >= steps[i]) i++; return i; };
  const memTotal = () => (m.mem && m.mem.total) || (m.perf && m.perf.mem && m.perf.mem.total) || 0;
  const NOT = {
    disk: 'Disk use per app was not measured (Mantle\'s helper did not report it)',
    net: 'Network use per app is not measured on this PC',
    gpu: 'GPU use per app was not measured',
    gpuEngine: 'No GPU engine reported', publisher: 'Windows did not report a publisher', cmdline: 'Windows did not let Mantle read its command line',
    power: 'Power use was not estimated', powerTrend: 'Power use was not estimated',
  };
  const tot = (k, label) => () => {
    const v = m.totals ? m.totals[k] : k === 'cpu' ? m.cpu : k === 'mem' && memTotal() ? (m.mem.used / memTotal()) * 100 : null;
    return { v: v == null ? null : Math.round(v) + '%', title: v == null ? `${label}: not measured` : `${label}: ${Math.round(v)}% in use`, hi: v >= 80 };
  };
  const statusText = (r) => {
    if (r.hung) return 'Not responding';
    if (S.status === 'none') return '';
    if (r.suspended || r.status === 'Suspended') return S.status === 'all' || S.status === 'suspended' ? 'Suspended' : '';
    if (r.efficiency || r.status === 'Efficiency mode') return S.status === 'all' || S.status === 'efficiency' ? 'Efficiency mode' : '';
    return r.status || '';
  };
  const COLS = [
    { id: 'name', label: 'Name', fixed: true, flex: true, min: 220, get: (r) => r.name || r.file,
      html: (r) => `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(r.title && r.title !== r.name ? `${r.name} · ${r.title}` : r.name || r.file)}">${esc(r.name || r.file)}</span>${r.count > 1 ? `<span class="k">(${r.count})</span>` : ''}` +
        (r.protected ? `<span class="plock" title="${esc(r.protected)}">${ICON.lock}</span>` : '') },
    { id: 'type', label: 'Type', def: false, w: 130, text: (r) => ({ app: 'App', mantle: 'App', background: 'Background process', windows: 'Windows process' }[r.type || r.kind] || null) },
    { id: 'status', label: 'Status', w: 130, get: statusText, html: (r) => {
      const s = statusText(r);
      if (!s) return '';
      const ic = s === 'Suspended' ? ICON.pause : s === 'Efficiency mode' ? ICON.leaf : '';
      return `<span class="pst${s === 'Not responding' ? ' bad' : ''}" title="${esc(s)}">${ic}<span>${esc(s)}</span></span>`;
    } },
    { id: 'publisher', label: 'Publisher', def: false, w: 160, text: (r) => r.publisher, why: () => NOT.publisher },
    { id: 'pid', label: 'PID', def: false, num: true, w: 70, get: pidOf, text: (r) => (r.count > 1 ? '' : pidOf(r)) },
    { id: 'processName', label: 'Process name', def: false, w: 140, text: (r) => r.processName || r.file },
    { id: 'cmdline', label: 'Command line', def: false, w: 260, text: (r) => r.cmdline, why: () => NOT.cmdline },
    { id: 'cpu', label: 'CPU', num: true, w: 76, text: (r) => fmt.pct(r.cpu), heat: (r) => lv(r.cpu, [0.5, 3, 10, 25, 50]), total: tot('cpu', 'CPU') },
    { id: 'mem', label: 'Memory', num: true, w: 96, text: (r) => (S.res.mem === 'percents' && memTotal() ? fmt.pct((r.mem / memTotal()) * 100) : fmt.mb(r.mem)), heat: (r) => lv(r.mem / MB, [50, 150, 400, 900, 1600]), total: tot('mem', 'Memory') },
    { id: 'disk', label: 'Disk', num: true, w: 84, text: (r) => (S.res.disk === 'percents' ? null : fmt.rate(r.disk)), why: (r) => (S.res.disk === 'percents' && r.disk != null ? 'Disk as a percent of the disk is not measured per app' : NOT.disk), heat: (r) => lv((r.disk || 0) / MB, [0.1, 1, 5, 20, 60]), total: tot('disk', 'Disk') },
    { id: 'net', label: 'Network', num: true, w: 84, text: (r) => (S.res.net === 'percents' ? null : fmt.mbps(r.net)), why: (r) => (S.res.net === 'percents' && r.net != null ? 'Network as a percent of the link is not measured per app' : NOT.net), heat: (r) => lv(((r.net || 0) * 8) / 1e6, [0.1, 1, 5, 25, 100]), total: tot('net', 'Network') },
    { id: 'gpu', label: 'GPU', num: true, def: false, w: 70, text: (r) => fmt.pct(r.gpu), why: () => NOT.gpu, heat: (r) => lv(r.gpu, [0.5, 3, 10, 25, 50]), total: tot('gpu', 'GPU') },
    { id: 'gpuEngine', label: 'GPU engine', def: false, w: 120, text: (r) => r.gpuEngine, why: () => NOT.gpuEngine },
    { id: 'power', label: 'Power usage', def: false, w: 110, text: (r) => r.power, why: () => NOT.power },
    { id: 'powerTrend', label: 'Power usage trend', def: false, w: 130, text: (r) => r.powerTrend, why: () => NOT.powerTrend },
  ];

  /* ---- Mantle's outcome on the row (main's state: what happened and why) ---- */
  function sub(r) {
    const s = r.state;
    if (!s) return '';
    const map = {
      closing: [`Ending...${s.why ? ' ' + s.why : ''}`, ''],
      closed: [`Ended · freed about ${fmt.mbi(s.freed)}`, ''],
      'still-running': [s.why, 'bad'],
      failed: [s.why, 'bad'],
      trimming: ['Trimming memory...', ''],
      trimmed: [`Memory trimmed: ${fmt.mbi(s.before)} → ${fmt.mbi(s.after)}${s.why ? ' · ' + s.why : ''}`, ''],
      dry: [s.why || 'Test Mantle: nothing was done', ''],
    };
    const [text, cls] = map[s.state] || [s.why || 'Done', ''];
    const force = s.state === 'still-running' && r.actions && r.actions.force ? '<span class="grow"></span><button type="button" class="btn sm" data-act="force">Force close</button>' : '';
    return `<div class="st ${cls}" role="status">${cls === 'bad' ? TM.warnLine('', text) : `<span>${esc(text)}</span>`}${force}</div>`;
  }

  /* ---- actions ---- */
  const isExplorer = (r) => /^explorer\.exe$/i.test(r.file || r.processName || '') && (r.kind === 'windows' || r.type === 'windows');
  const busy = new Set();
  async function act(action, r, extra) {
    if (busy.has(r.key + action)) return;          // a double click sends one request
    busy.add(r.key + action);
    const res = await TM.run('act', Object.assign({ action, key: r.key }, extra || {}), { noDry: true });
    busy.delete(r.key + action);
    if (res.ok === false) TM.say(res); else TM.note(null);
  }
  async function endTask(r, it) {
    if (!r) return;
    if (it && it.depth) {   // one process of an app: Windows ends that process
      TM.say(await TM.run('endPid', { pid: r.pid, created: r.created }));
      return;
    }
    if (isExplorer(r)) return restartExplorer();
    const a = r.actions || {};
    // a Windows process: main answers with Windows' own warning (needsConfirm); TM.run asks, then sends it again confirmed
    if (r.kind === 'windows' || r.type === 'windows') return act('close', r);
    if (r.hung && a.force) return act('force', r, { confirmed: true });
    if (a.close) return act('close', r);
    TM.note(`${r.name} can't be ended: ${r.protected || a.why || 'Mantle does not end it'}`);
  }
  async function forceClose(r) {
    const c = await TM.confirm({ title: `Force close ${r.name}?`, body: 'It ends at once, and anything unsaved in it is lost.', ok: 'Force close' });
    if (c.ok) act('force', r, { confirmed: true });
  }
  async function restartExplorer() {
    const res = await TM.run('restartExplorer', {});
    TM.note(res.ok ? (res.dryRun ? res.reason : null) : `Windows Explorer did not restart: ${res.reason}`);
  }
  async function efficiency(r, it) {
    const res = await TM.act.efficiency(it && it.depth ? { pid: r.pid } : { key: r.key, pid: pidOf(r) }, !r.efficiency, r.name || r.file);
    if (!res.cancelled) TM.note(res.ok ? (res.dryRun ? res.reason : null) : res.reason);
    TM.refresh();
  }
  const canEnd = (r, it) => !!r && (!!(it && it.depth) || isExplorer(r) || r.kind === 'windows' || !!(r.actions && (r.actions.close || r.actions.force)));
  const endWhy = (r) => (r ? r.protected || (r.actions && r.actions.why) || 'Mantle does not end it' : 'Choose a process first');
  const canEff = (r) => !!r && r.kind !== 'windows' && r.type !== 'windows' && r.kind !== 'mantle';

  function resMenu() {
    const one = (k, label) => ({ label, sub: [['values', 'Values'], ['percents', 'Percents']].map(([v, l]) => ({ label: l, radio: true, checked: S.res[k] === v, act: () => { S.res[k] = v; store.set('proc.res', S.res); TM.refresh(); } })) });
    return [one('mem', 'Memory'), one('disk', 'Disk'), one('net', 'Network')];
  }
  function viewMenu() {
    const st = (v, l) => ({ label: l, radio: true, checked: S.status === v, act: () => { S.status = v; store.set('proc.status', v); TM.refresh(); } });
    return [
      { label: 'Group by type', checked: S.group, act: () => { S.group = !S.group; store.set('proc.group', S.group); TM.refresh(); } },
      { label: 'Expand all', act: () => t.expandAll() },
      { label: 'Collapse all', act: () => t.collapseAll() },
      { sep: true },
      { label: 'Status values', sub: [st('all', 'Show suspended and efficiency mode status'), st('suspended', 'Show suspended status'), st('efficiency', 'Show efficiency mode status'), st('none', 'Hide status')] },
      { label: 'Resource values', sub: resMenu },
    ];
  }
  function rowMenu(r, it) {
    const child = !!(it && it.depth);
    const n = r.count || 0;
    const items = [];
    if (!child && n > 1) items.push({ label: t.open.has(it.k) ? 'Collapse' : 'Expand', act: () => t.toggle(it.k) });
    if (isExplorer(r) && !child) items.push({ label: 'Restart', act: () => restartExplorer() });
    else items.push({ label: 'End task', key: 'Delete', disabled: !canEnd(r, it), title: canEnd(r, it) ? undefined : endWhy(r), act: () => endTask(r, it) });
    items.push({ label: 'Resource values', sub: resMenu });
    items.push({ label: 'Efficiency mode', checked: !!r.efficiency, disabled: !canEff(r), title: canEff(r) ? undefined : 'Windows does not allow Efficiency mode for Windows processes', act: () => efficiency(r, it) });
    items.push({ label: 'Create memory dump file', disabled: pidOf(r) == null, act: () => TM.act.dump(pidOf(r), r.name || r.file) });
    items.push({ sep: true });
    items.push({ label: 'Go to details', disabled: pidOf(r) == null, act: () => TM.act.goToDetails(pidOf(r)) });
    items.push({ label: 'Open file location', disabled: !(r.canReveal || r.path), act: () => TM.act.openLocation(r.path, child ? null : r.key) });
    items.push({ label: 'Search online', act: () => TM.act.searchOnline(r.name || r.file) });
    items.push({ label: 'Properties', disabled: !r.path, title: r.path ? undefined : 'Windows did not let Mantle see where its file is', act: () => TM.act.properties(r.path) });
    if (!child && r.actions && r.actions.trim) items.push({ sep: true }, { label: 'Trim memory', title: 'Hands its unused memory back to Windows; it keeps running (Mantle)', act: () => act('trim', r) });
    return items;
  }

  TM.page({
    id: 'processes',
    init(root) {
      root.innerHTML = '<div id="recent" class="recent" hidden></div><div class="ptbl"></div>';
      t = TM.table(root.querySelector('.ptbl'), {
        id: 'processes', cols: COLS, sort: { by: 'cpu', dir: -1 }, label: 'Processes. Up and down to choose, Enter or Right to expand, Delete to end the task, the menu key for more.',
        key: (r) => r.key || ('p' + r.pid),
        count: (r) => (r.members === undefined && !r.count ? 0 : r.count > 1 ? r.count : 0),
        children: (r) => r.members || null,
        onExpand: (r, open) => { TM.run('expand', { key: r.key, open }, { noDry: true }).then((x) => { if (x.ok === false) TM.note(`Its processes did not load (${x.reason}).`); }); },
        sub, cls: (r) => (r.hung ? 'hung' : '') + (r.kind === 'mantle' ? ' mantle' : ''),
        onAct: (a, r) => { if (a === 'force') forceClose(r); },
        onDelete: (r, e, it) => endTask(r, it),
        menu: rowMenu,
        headMenu: () => [{ label: 'Resource values', sub: resMenu }],
      });
    },
    render(mm) {
      m = mm;
      const ls = (rows) => (rows || []).filter((r) => TM.match(r.name, r.file, r.title, r.publisher, pidOf(r)));
      const apps = ls(m.mantleRow ? [m.mantleRow].concat(m.apps || []) : m.apps), bg = ls(m.background), win = ls(m.windows);
      if (!m.loaded) { t.state(m.error ? TM.stateHtml('error', m.error) : TM.stateHtml('loading', 'Reading running apps...')); t.render({ rows: [] }); return; }
      const any = apps.length + bg.length + win.length;
      t.state(TM.q && !any ? TM.stateHtml('noq') : null);
      t.render(S.group ? { groups: [{ id: 'apps', title: 'Apps', rows: apps }, { id: 'background', title: 'Background processes', rows: bg }, { id: 'windows', title: 'Windows processes', rows: win }] } : { rows: apps.concat(bg, win) });
      const rec = (m.recent || []).slice(0, 3);
      const re = document.getElementById('recent');
      re.hidden = !rec.length;
      TM.setHtml(re, rec.map((x) => (x.ok ? `<span>${esc(x.name)}: ${esc(x.text)}</span>` : TM.warnLine('bad', `${x.name}: ${x.text}`))).join(''));
    },
    commands() {
      const it = t && t.selectedItem(), r = it && it.r;
      const ex = r && !it.depth && isExplorer(r);
      return [
        ex ? { id: 'restart', label: 'Restart', icon: ICON.restart, act: () => restartExplorer(), title: 'Restart Windows Explorer' }
          : { id: 'end', label: 'End task', icon: ICON.end, key: 'Delete', disabled: !canEnd(r, it), title: r ? (canEnd(r, it) ? 'End task' : endWhy(r)) : 'End task (choose a process first)', act: () => endTask(r, it) },
        { id: 'eff', label: 'Efficiency mode', icon: ICON.leaf, checked: !!(r && r.efficiency), disabled: !canEff(r), title: r ? (canEff(r) ? 'Efficiency mode' : 'Windows does not allow Efficiency mode for Windows processes') : 'Efficiency mode (choose a process first)', act: () => efficiency(r, it) },
        { id: 'view', label: 'View', icon: ICON.view, menu: viewMenu },
      ];
    },
    endTask() { const it = t && t.selectedItem(); if (it) endTask(it.r, it); },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
    show(arg) { if (arg && arg.key && t) t.select(arg.key, true); },
  });
}());
