/* pages/users.js - Windows' Users page (TM-SPEC.md "Users"), on the shell's TM.table.
 * model.users = { rows: [{ session, user, fullName, status, cpu, mem, disk, net, current?, sessionName?, client?,
 * gpu?, gpuEngine?, why?, procs: [{ name, pid, created?, cpu, mem, disk, net, processName, path?, icon? }] }] }.
 * Each user expands to their processes (like Processes); totals over the headers and heat shading as on Processes.
 *
 * Windows' own words (Taskmgr.exe / Windows.UI.TaskManager.en-US.pri, read 10-28):
 *   command bar: Run new task | Disconnect | Manage user accounts;
 *   row menu ("User Context"): Expand / Collapse, Connect, Disconnect, Sign off, Manage user accounts;
 *   Sign off asks "Do you want to continue?" / "If you sign out a user, the user's unsaved data might be lost."
 *   [Sign out user]; Disconnect asks "Disconnect user" / "Are you sure you want to disconnect the selected
 *   user(s)?". Select columns: ID, Session, Client name, Status, CPU, Memory, Disk, Network, GPU, GPU engine.
 *   The user's name is "<name> (<processes>)"; Settings > Show full account name shows the full name.
 *
 * ONE dialog per action, as on Details: the page first asks main with dryRun:true and noConfirm (nothing is
 * done). needsConfirm => main's dialog only, then the command goes with confirmed:true; otherwise Windows'
 * question above, then the command goes plainly. A dry run that already fails (needs admin, no such command)
 * is said on the row without asking. SAFETY: Sign off / Disconnect on your own session end or lock it; the
 * tests only ever send them as dry runs.
 */
(function () {
  'use strict';
  const { esc, fmt, ICON } = TM;
  let t = null, m = {}, viewRows = [];
  const outcome = new Map();     // row key -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, head, at }
  const busy = new Set();
  const MB = 1024 * 1024;
  const lv = (x, steps) => { if (!(x > 0)) return 0; let i = 0; while (i < steps.length && x >= steps[i]) i++; return i; };
  const isUser = (r) => !!(r && r._u);
  const full = () => !!(m.settings && m.settings.fullAccountName);

  /* ---- the em dash's reason when the row did not send its own (row.why.<field>) ---- */
  const NOT = {
    cpu: 'CPU use was not reported',
    mem: 'Memory was not reported',
    disk: "Disk use per user was not measured (Mantle's helper did not report it)",
    net: 'Network use per user needs administrator access to measure (Windows counts it per process only for administrators)',
    gpu: 'GPU use per user was not measured',
    gpuEngine: 'GPU engine per user was not reported',
    session: 'Windows did not report the session ID',
    sessionName: 'Windows did not report the session name',
    client: 'Not a remote session, or Windows did not report the client name',
    status: 'Windows did not report this session\'s state',
    fullName: 'Windows did not report a full name for this account',
    path: 'Windows did not let Mantle see where its file is',
  };
  const totWhy = (k) => (m.totals && m.totals.why && m.totals.why[k]) || null;
  const tot = (k, label) => () => {
    const T = m.totals || null;
    const v = T ? T[k] : null;
    if (v == null) return { v: null, title: `${label}: ${totWhy(k) || 'not measured on this PC'}` };
    return { v: Math.round(v) + '%', title: `${label}: ${Math.round(v)}% in use`, hi: v >= 80 };
  };
  const C = (id, label, o) => Object.assign({ id, label, title: label, def: false, why: () => NOT[id] || 'Not reported' }, o || {});
  // a process row: blank where Windows leaves the cell blank (ID, Session, Client name are the user's)
  const U = (f) => (r) => (isUser(r) ? f(r) : '');
  const nameOf = (r) => (full() && r.fullName ? r.fullName : r.user);
  const COLS = [
    { id: 'name', label: 'User', title: 'User', fixed: true, flex: true, min: 220, get: (r) => (isUser(r) ? nameOf(r) : r.name),
      html: (r) => {
        if (!isUser(r)) return `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(r.processName || r.name)}">${esc(r.name)}</span>`;
        const nm = nameOf(r);
        const tip = full() && !r.fullName ? `${r.user}: ${(r.why && r.why.fullName) || NOT.fullName}` : full() ? `${r.fullName} (${r.user})` : r.user;
        const n = (r.procs || []).length;
        return `<span class="ic uic" aria-hidden="true">${ICON.user}</span><span class="n" title="${esc(tip)}">${esc(nm)}</span><span class="k">(${n})</span>`;
      } },
    C('session', 'ID', { num: true, w: 56, text: U((r) => (r.session == null ? null : String(r.session))) }),
    C('sessionName', 'Session', { w: 100, text: U((r) => r.sessionName) }),
    C('client', 'Client name', { w: 110, text: U((r) => r.client) }),
    C('status', 'Status', { def: true, w: 110, text: (r) => (isUser(r) ? r.status : r.status || ''), why: () => NOT.status }),
    C('cpu', 'CPU', { def: true, num: true, w: 76, get: (r) => r.cpu, text: (r) => fmt.pct(r.cpu), heat: (r) => lv(r.cpu, [0.5, 3, 10, 25, 50]), total: tot('cpu', 'CPU') }),
    C('mem', 'Memory', { def: true, num: true, w: 100, get: (r) => r.mem, text: (r) => fmt.mb(r.mem), heat: (r) => lv(r.mem / MB, isUser(r) ? [500, 1500, 4000, 9000, 16000] : [50, 150, 400, 900, 1600]), total: tot('mem', 'Memory') }),
    C('disk', 'Disk', { def: true, num: true, w: 84, get: (r) => r.disk, text: (r) => fmt.rate(r.disk), heat: (r) => lv((r.disk || 0) / MB, [0.1, 1, 5, 20, 60]), total: tot('disk', 'Disk') }),
    C('net', 'Network', { def: true, num: true, w: 88, get: (r) => r.net, text: (r) => fmt.mbps(r.net), heat: (r) => lv(((r.net || 0) * 8) / 1e6, [0.1, 1, 5, 25, 100]), total: tot('net', 'Network') }),
    C('gpu', 'GPU', { num: true, w: 70, get: (r) => r.gpu, text: (r) => fmt.pct(r.gpu), heat: (r) => lv(r.gpu, [0.5, 3, 10, 25, 50]), total: tot('gpu', 'GPU') }),
    C('gpuEngine', 'GPU engine', { w: 110 }),
  ];
  const keyOf = (r) => (isUser(r) ? 'u' + r.session : 'p' + r.pid);

  /* ---- outcomes on the row ---- */
  function setOut(k, o) {
    if (o) outcome.set(k, Object.assign({ at: Date.now() }, o)); else outcome.delete(k);
    if (o && (o.kind === 'ok' || o.kind === 'dry')) { const at = outcome.get(k).at; setTimeout(() => { const x = outcome.get(k); if (x && x.at === at) { outcome.delete(k); TM.refresh(); } }, 15000); }
    TM.refresh();
  }
  function said(k, res, head, done) {
    if (!res || res.cancelled) { setOut(k, null); return res; }
    if (res.ok === false) setOut(k, res.needsAdmin ? { kind: 'admin', res, head } : { kind: 'bad', text: `${head}: ${res.reason}` });
    else if (res.dryRun) setOut(k, { kind: 'dry', text: res.reason || `Test Mantle: ${head.toLowerCase()} was not done.` });
    else setOut(k, done ? { kind: 'ok', text: done } : null);
    return res;
  }
  function sub(r) {
    const o = outcome.get(keyOf(r));
    if (!o) return '';
    if (o.kind === 'busy') return `<div class="st" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(o.text)}</span></div>`;
    if (o.kind === 'admin') return `<div class="st bad dadm" role="status">${o.head ? `<span>${esc(o.head)}:</span>` : ''}${TM.adminHtml(o.res)}</div>`;
    return `<div class="st${o.kind === 'bad' ? ' bad' : ''}" role="status">${o.kind === 'bad' ? TM.warnLine('', o.text) : `<span>${esc(o.text)}</span>`}</div>`;
  }

  /* ---- one dialog per action (see the header) ---- */
  async function guarded(k, cmd, args, ask, busyWords) {
    const bk = k + cmd;
    if (busy.has(bk)) return { ok: false, cancelled: true };
    busy.add(bk);
    try {
      const pre = await TM.run(cmd, Object.assign({}, args, { dryRun: true }), { noConfirm: true, noDry: true });
      if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
        const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'OK', check: pre.check || null, width: 460 });
        if (!c.ok) return { ok: false, cancelled: true };
        if (busyWords) setOut(k, { kind: 'busy', text: busyWords });
        return await TM.run(cmd, Object.assign({}, args, { confirmed: true }));
      }
      if (pre.ok === false) return pre;        // needs admin / failed / no such command: said without asking
      if (ask) { const c = await ask(); if (!c.ok) return { ok: false, cancelled: true }; }
      if (busyWords) setOut(k, { kind: 'busy', text: busyWords });
      return await TM.run(cmd, args);
    } finally { busy.delete(bk); }
  }
  const who = (u) => (u.fullName && full() ? u.fullName : u.user) || `session ${u.session}`;
  async function disconnect(u) {
    if (!u) return;
    const k = keyOf(u);
    const ask = () => TM.confirm({ title: 'Disconnect user', body: 'Are you sure you want to disconnect the selected user(s)?', ok: 'Disconnect user', width: 440 });
    said(k, await guarded(k, 'userDisconnect', { session: u.session }, ask, `Disconnecting ${who(u)}...`), `${who(u)} was not disconnected`, `${who(u)} disconnected`);
  }
  async function signOff(u) {
    if (!u) return;
    const k = keyOf(u);
    const ask = () => TM.confirm({ title: 'Do you want to continue?', body: "If you sign out a user, the user's unsaved data might be lost.", ok: 'Sign out user', width: 440 });
    said(k, await guarded(k, 'userSignOff', { session: u.session }, ask, `Signing out ${who(u)}...`), `${who(u)} was not signed out`, `${who(u)} signed out`);
  }
  async function connect(u) {
    if (!u) return;
    const k = keyOf(u);
    said(k, await guarded(k, 'userConnect', { session: u.session }, null, `Connecting to ${who(u)}...`), `Not connected to ${who(u)}`, '');
  }
  async function manageUsers() {
    const r = await TM.run('manageUsers', {});
    TM.note(r.ok ? (r.dryRun ? r.reason || 'Test Mantle: Settings > Accounts > Other users was not opened.' : null) : `Manage user accounts did not open: ${r.reason}`);
    return r;
  }
  /* a user's process: End task as on Processes (no question; a critical process gets main's needsConfirm) */
  async function endTask(p) {
    if (!p || isUser(p)) return;
    const k = keyOf(p);
    if (busy.has(k + 'end')) return;
    busy.add(k + 'end');
    setOut(k, { kind: 'busy', text: 'Ending...' });
    try { said(k, await TM.run('endPid', { pid: p.pid, created: p.created }), 'Not ended', 'Ended'); } finally { busy.delete(k + 'end'); }
  }

  /* ---- menus ---- */
  const connectWhy = (u) => (u.current ? 'This is your own session: you are already connected to it' : null);
  const discWhy = (u) => (String(u.status || '').toLowerCase() === 'disconnected' ? `${who(u)} is already disconnected` : null);
  function userMenu(u, it) {
    const open = t.open.has(it.k);
    return [
      { label: open ? 'Collapse' : 'Expand', disabled: !(u.procs || []).length, title: (u.procs || []).length ? undefined : 'No processes were reported for this user', act: () => t.toggle(it.k) },
      { sep: true },
      { label: 'Connect', disabled: !!connectWhy(u), title: connectWhy(u) || undefined, act: () => connect(u) },
      { label: 'Disconnect', disabled: !!discWhy(u), title: discWhy(u) || undefined, act: () => disconnect(u) },
      { label: 'Sign off', act: () => signOff(u) },
      { sep: true },
      { label: 'Manage user accounts', act: () => manageUsers() },
    ];
  }
  function procMenu(p) {
    return [
      { label: 'End task', key: 'Delete', act: () => endTask(p) },
      { sep: true },
      { label: 'Go to details', act: () => TM.goTo('details', { pid: p.pid }) },
      { label: 'Open file location', disabled: !p.path, title: p.path ? undefined : NOT.path, act: () => TM.act.openLocation(p.path) },
      { label: 'Search online', act: () => TM.act.searchOnline(p.processName || p.name) },
      { label: 'Properties', disabled: !p.path, title: p.path ? undefined : NOT.path, act: () => TM.act.properties(p.path) },
    ];
  }
  const rowMenu = (r, it) => (isUser(r) ? userMenu(r, it) : procMenu(r));
  /* the selected user (or the user whose process is selected) */
  function selUser() {
    const it = t ? t.selectedItem() : null;
    if (!it) return null;
    if (isUser(it.r)) return it.r;
    const pk = it.pk && t.rows.get(it.pk);
    return pk ? pk.r : null;
  }

  TM.page({
    id: 'users',
    init(root) {
      root.innerHTML = '<div class="utbl"></div>';
      t = TM.table(root.querySelector('.utbl'), {
        id: 'users', cols: COLS, sort: { by: 'name', dir: 1 },
        label: 'Users. Up and down to choose, right and left to open and close a user, the menu key for more.',
        key: keyOf, sub,
        count: (r) => (isUser(r) ? r._kids.length : 0),
        children: (r) => r._kids,
        cls: (r) => (isUser(r) ? 'urow' : ''),
        onDelete: (r) => { if (!isUser(r)) endTask(r); },
        menu: rowMenu,
      });
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('users');
      const d = m.users || {};
      if (st !== 'ok') {
        t.state(st === 'unsupported' ? TM.stateHtml('unsupported') : st === 'error' ? TM.stateHtml('error', d.error || 'Mantle could not read the signed-in users.') : TM.stateHtml('loading', 'Reading users...'));
        t.render({ rows: [] });
        return;
      }
      const q = TM.q;
      const live = new Set();
      viewRows = [];
      for (const u of d.rows || []) {
        const procs = (u.procs || []).map((p) => Object.assign({}, p));
        const uv = Object.assign({}, u, { _u: true, _kids: procs });
        live.add(keyOf(uv)); procs.forEach((p) => live.add(keyOf(p)));
        if (!q || TM.match(u.user, u.fullName)) { viewRows.push(uv); continue; }
        const hit = procs.filter((p) => TM.match(p.name, p.processName, p.pid));
        if (hit.length) { uv._kids = hit; viewRows.push(uv); t.open.add(keyOf(uv)); }   // a match inside: shown open, like Windows
      }
      for (const k of Array.from(outcome.keys())) if (!live.has(k)) outcome.delete(k);
      t.state(q && !viewRows.length ? TM.stateHtml('noq') : !viewRows.length ? TM.stateHtml('empty', 'No signed-in users were reported.') : null);
      t.render({ rows: viewRows });
      if (d.error) TM.note(`Users: ${d.error}`);
    },
    commands() {
      const u = selUser();
      const w = u ? discWhy(u) : 'Disconnect (choose a user first)';
      return [
        { id: 'disc', label: 'Disconnect', icon: ICON.disconnect, disabled: !!w, title: w || 'Disconnect', act: () => disconnect(selUser()) },
        { id: 'manage', label: 'Manage user accounts', icon: ICON.user, title: 'Open the Settings page to manage user accounts', act: () => manageUsers() },
      ];
    },
    endTask() { const it = t && t.selectedItem(); if (it && !isUser(it.r)) endTask(it.r); },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
  });
}());
