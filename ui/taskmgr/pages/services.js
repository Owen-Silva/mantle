/* pages/services.js - Windows' Services page (TM-SPEC.md "Services"), on the shell's TM.table.
 * Rows: model.services.rows, one per service (key v<name>). Columns are Windows' five: Name (the service's
 * short name), PID, Description (Windows shows the DISPLAY name here; the long description is its tooltip),
 * Status, Group. Start / Stop / Restart enable from the row's status, as Windows does.
 *
 * `service` {name, op}. Windows asks nothing first, so neither does this page; for a critical service main
 * answers needsConfirm, so the page asks main with dryRun:true and noConfirm first (nothing is done):
 * needsConfirm => main's dialog only, then the command goes with confirmed:true; a dry run that already fails
 * (needs admin, no such command) is said on the row without trying. Every outcome is said ON its row (busy,
 * done, a dry run's words, failed + reason, needs admin + "Set up administrator access"), and so is main's
 * background outcome row.lastOp {op, ok, reason, at}: never silent.
 * Details' "Go to service(s)" arrives as show({names}): those rows are marked, the first chosen and scrolled to.
 */
(function () {
  'use strict';
  const { esc, ICON } = TM;
  let t = null, m = {}, rowsAll = [], want = null, wantMiss = 0, selfSel = false;
  const hit = new Set();        // the services Details sent us to (Windows selects them all)
  const outcome = new Map();    // name -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, head, at }
  const busy = new Set();
  const timers = new Set();

  const NOT = {
    pid: (r) => (isStopped(r) ? 'Not running, so it has no process' : 'Windows did not say which process runs it'),
    display: () => 'Windows did not report its display name',
    status: () => 'Windows did not report its status',
    group: () => 'Not in a shared service host group (it runs in its own process), or Windows did not say',
  };
  const whyOf = (id) => (r) => (r.why && r.why[id]) || NOT[id](r);
  const stat = (r) => String(r.status || '').toLowerCase();
  const isStopped = (r) => stat(r) === 'stopped';
  const isRunning = (r) => stat(r) === 'running' || stat(r) === 'paused';
  const pending = (r) => /pending|starting|stopping|continu|pausing/.test(stat(r));

  const COLS = [
    { id: 'name', label: 'Name', fixed: true, flex: true, min: 160, get: (r) => String(r.name || '').toLowerCase(),
      html: (r) => `<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>` },
    { id: 'pid', label: 'PID', title: 'PID', num: true, w: 70, def: true, get: (r) => (r.pid ? r.pid : -1), text: (r) => (r.pid ? String(r.pid) : null), why: whyOf('pid') },
    { id: 'desc', label: 'Description', title: 'Description', w: 300, def: true, get: (r) => String(r.display || '').toLowerCase(),
      html: (r) => (r.display == null ? TM.na(whyOf('display')(r)) : `<span class="svd" title="${esc(r.desc || r.display)}">${esc(r.display)}</span>`) },
    { id: 'status', label: 'Status', title: 'Status', w: 96, def: true, text: (r) => r.status || null, why: whyOf('status') },
    { id: 'group', label: 'Group', title: 'Group', w: 200, def: true, why: whyOf('group') },
  ];

  /* ---- outcomes on the row ---- */
  const OPW = {
    start: { busy: 'Starting...', done: 'Started', head: 'Not started' },
    stop: { busy: 'Stopping...', done: 'Stopped', head: 'Not stopped' },
    restart: { busy: 'Restarting...', done: 'Restarted', head: 'Not restarted' },
  };
  function setOut(r, o) {
    if (o) outcome.set(r.name, Object.assign({ at: Date.now() }, o)); else outcome.delete(r.name);
    if (o && (o.kind === 'ok' || o.kind === 'dry')) { const at = outcome.get(r.name).at; setTimeout(() => { const x = outcome.get(r.name); if (x && x.at === at) { outcome.delete(r.name); TM.refresh(); } }, 15000); }
    TM.refresh();
  }
  function said(r, res, op) {
    const w = OPW[op];
    if (!res || res.cancelled) { setOut(r, null); return res; }
    if (res.ok === false) setOut(r, res.needsAdmin ? { kind: 'admin', res, head: w.head } : { kind: 'bad', text: `${w.head}: ${res.reason || 'Mantle gave no reason.'}` });
    // a dry run always says so first; lib's reason (what it found, e.g. "it is not running") follows in brackets
    else if (res.dryRun) setOut(r, { kind: 'dry', text: `Test Mantle: ${r.name} was not ${op === 'stop' ? 'stopped' : op + 'ed'}${res.reason ? ` (${String(res.reason).replace(/[.\s]+$/, '')})` : ''}.` });
    else setOut(r, { kind: 'ok', text: w.done });
    return res;
  }
  // main's background outcome, when it is newer than anything this page said; a success fades after 15 s
  function lastOpOut(r) {
    const L = r.lastOp;
    if (!L || !OPW[L.op]) return null;
    const at = typeof L.at === 'number' ? L.at : 0;
    const mine = outcome.get(r.name);
    if (mine && mine.at >= at) return null;
    const w = OPW[L.op];
    if (L.ok === false) return L.needsAdmin ? { kind: 'admin', res: L, head: w.head } : { kind: 'bad', text: `${w.head}: ${L.reason || 'Windows gave no reason.'}` };
    const age = Date.now() - at;
    if (age >= 15000) return null;
    const tk = r.name + at;
    if (!timers.has(tk)) { timers.add(tk); setTimeout(() => { timers.delete(tk); TM.refresh(); }, 15000 - age + 50); }
    return { kind: 'ok', text: L.reason || w.done };
  }
  function sub(r) {
    const o = lastOpOut(r) || outcome.get(r.name);
    if (!o) return '';
    if (o.kind === 'busy') return `<div class="st" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(o.text)}</span></div>`;
    if (o.kind === 'admin') return `<div class="st bad svadm" role="status">${o.head ? `<span>${esc(o.head)}:</span>` : ''}${TM.adminHtml(o.res)}</div>`;
    return `<div class="st${o.kind === 'bad' ? ' bad' : ''}" role="status">${o.kind === 'bad' ? TM.warnLine('', o.text) : `<span>${esc(o.text)}</span>`}</div>`;
  }

  /* ---- Start / Stop / Restart: one dialog at most (main's), see the header ---- */
  async function svc(r, op) {
    if (!r || !can(r, op).ok) return;
    const key = r.name;
    if (busy.has(key)) return;
    busy.add(key);
    TM.refresh();
    let res;
    try {
      const args = { name: r.name, op };
      const pre = await TM.run('service', Object.assign({}, args, { dryRun: true }), { noConfirm: true, noDry: true });
      if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
        const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'OK', check: pre.check || null, width: 460 });
        if (!c.ok) res = { ok: false, cancelled: true };
        else { setOut(r, { kind: 'busy', text: OPW[op].busy }); res = await TM.run('service', Object.assign({}, args, { confirmed: true })); }
      } else if (pre.ok === false) res = pre;     // needs admin / failed / no such command: said without trying
      else { setOut(r, { kind: 'busy', text: OPW[op].busy }); res = await TM.run('service', args); }
    } finally { busy.delete(key); }
    said(r, res, op);
  }
  // what Windows allows for this row's status (disabled items say why)
  function can(r, op) {
    if (!r) return { ok: false, why: 'choose a service first' };
    if (busy.has(r.name)) return { ok: false, why: 'Mantle is still waiting for the last one' };
    if (pending(r)) return { ok: false, why: `it is ${stat(r)}` };
    if (op === 'start') return isStopped(r) ? { ok: true } : { ok: false, why: r.status ? 'it is already running' : 'Windows did not report its status' };
    if (!isRunning(r)) return { ok: false, why: r.status ? 'it is not running' : 'Windows did not report its status' };
    if (r.canStop === false) return { ok: false, why: 'Windows does not let this service be stopped' };
    return { ok: true };
  }
  // the shell runs openServices and says the outcome on the window (a dry run's words, or why it did not open)
  const openServices = () => TM.act.openServices();
  const noPid = (r) => !r.pid;
  const goDetails = (r) => { if (r && r.pid) TM.goTo('details', { pid: r.pid }); };

  /* ---- menus ---- */
  function item(r, op, label) {
    const c = can(r, op);
    return { label, disabled: !c.ok, title: c.ok ? undefined : `${label} (${c.why})`, act: () => svc(r, op) };
  }
  function rowMenu(r) {
    return [
      item(r, 'start', 'Start'),
      item(r, 'stop', 'Stop'),
      item(r, 'restart', 'Restart'),
      { sep: true },
      { label: 'Open Services', act: openServices },
      { label: 'Search online', act: () => TM.act.searchOnline(r.name) },
      { label: 'Go to details', disabled: noPid(r), title: noPid(r) ? whyOf('pid')(r) : undefined, act: () => goDetails(r) },
    ];
  }
  const selRow = () => (t ? t.selected() : null);
  function cmd(id, op, label, icon) {
    const r = selRow();
    const c = can(r, op);
    return { id, label, icon, disabled: !c.ok, title: c.ok ? label : `${label} (${c.why})`, act: () => svc(selRow(), op) };
  }

  /* ---- arriving from Details' "Go to service(s)" ---- */
  function tryWant() {
    if (!want || !t) return;
    const keys = t.order.filter((k) => hit.has(k.slice(1)));
    if (keys.length) { selfSel = true; try { t.select(keys[0], true); } finally { selfSel = false; } want = null; wantMiss = 0; return; }
    if (rowsAll.some((r) => hit.has(r.name)) && TM.q) { setTimeout(() => TM.setQuery(''), 0); return; }   // a search hides them: show them
    if (rowsAll.length && ++wantMiss >= 3) { TM.note(`${want.join(', ')} ${want.length === 1 ? 'is' : 'are'} not in the list of services.`); want = null; wantMiss = 0; hit.clear(); }
  }

  TM.page({
    id: 'services',
    init(root) {
      root.innerHTML = '<div class="svtbl"></div>';
      t = TM.table(root.querySelector('.svtbl'), {
        id: 'services', cols: COLS, sort: { by: 'name', dir: 1 },
        label: 'Services. Up and down to choose, the menu key for more.',
        key: (r) => 'v' + r.name,
        sub, cls: (r) => (hit.has(r.name) ? 'svhit' : ''),
        onSelect: () => { if (!selfSel && hit.size) { hit.clear(); TM.refresh(); } },
        onEnter: () => {},
        onDbl: () => {},
        menu: rowMenu,
      });
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('services');
      const d = m.services || {};
      rowsAll = d.rows || [];
      if (st !== 'ok') {
        t.state(st === 'unsupported' ? TM.stateHtml('unsupported') : st === 'error' ? TM.stateHtml('error', d.error || 'Mantle could not read the list of services.') : TM.stateHtml('loading', 'Reading services...'));
        t.render({ rows: [] });
        return;
      }
      const live = new Set(rowsAll.map((r) => r.name));
      for (const k of Array.from(outcome.keys())) if (!live.has(k)) outcome.delete(k);
      const rows = rowsAll.filter((r) => TM.match(r.name, r.display, r.pid));
      t.state(TM.q && !rows.length ? TM.stateHtml('noq') : !rows.length ? TM.stateHtml('empty', 'No services were reported.') : null);
      t.render({ rows });
      if (d.error) TM.note(`Services: ${d.error}`);
      tryWant();
    },
    commands() {
      return [
        cmd('start', 'start', 'Start', ICON.play),
        cmd('stop', 'stop', 'Stop', ICON.stop),
        cmd('restart', 'restart', 'Restart', ICON.restart),
        { sep: true },
        { id: 'open', label: 'Open services', icon: ICON.open, title: 'Open services', act: openServices },
      ];
    },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
    show(arg) {
      if (arg && Array.isArray(arg.names) && arg.names.length) {
        hit.clear(); arg.names.forEach((n) => hit.add(String(n)));
        want = arg.names.map(String); wantMiss = 0;
        tryWant();
      }
    },
  });
}());
