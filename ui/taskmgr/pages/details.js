/* pages/details.js - Windows' Details page (TM-SPEC.md "Details"), on the shell's TM.table.
 * Rows: model.details.rows, one per process (key p<pid>). Default columns are Windows' own; the header's
 * right-click is Windows' two items (Hide column, Select columns), and Select columns lists every column
 * Windows has, persisted by the table. Every action's outcome is said ON its row (ending..., failed + reason,
 * needs admin + "Set up administrator access", a dry run's words), never silent.
 *
 * ONE dialog per action. Windows asks its own question before End task / End process tree / Set priority /
 * UAC virtualization; for a system or critical process main answers needsConfirm with Windows' stronger
 * words instead (the "Abandon unsaved data and shut down." box). To show exactly one of the two, the page
 * first asks main with dryRun:true and noConfirm (nothing is done): needsConfirm => main's dialog only, then
 * the command goes with confirmed:true; otherwise Windows' ordinary question, then the command goes plainly
 * (should main still answer needsConfirm, TM.run shows it: never a silent bypass). A dry run that already
 * fails (needs admin, no such command) is said on the row without asking anything.
 */
(function () {
  'use strict';
  const { esc, fmt, ICON } = TM;
  let t = null, m = {}, rowsAll = [], wantPid = null, wantMiss = 0;
  const outcome = new Map();   // pid -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, at, loc }
  const busy = new Set();

  /* ---- columns: Windows' Select columns list, in Windows' order (Name is always there) ---- */
  const K = (b) => fmt.kb(b);
  const N = (n) => fmt.num(n);
  const yes = (b) => (b == null ? null : b ? 'Yes' : 'No');
  const NOT = {
    user: 'Windows did not let Mantle read who runs it', arch: 'Windows did not say what it is built for', desc: 'Its file has no description, or Windows did not let Mantle read it',
    path: 'Windows did not let Mantle see where its file is', cmdline: 'Windows did not let Mantle read its command line', jobId: 'Not in a job object, or Windows did not say',
    packageName: 'Not a packaged (Store) app', cycles: 'Windows did not let Mantle read its CPU cycles', pagedPool: 'Windows did not report its pool use', npPool: 'Windows did not report its pool use',
    osContext: 'Windows did not say which Windows it was built for', enterprise: 'Windows did not report an enterprise context', shadowStack: 'Windows did not report its stack protection',
    _: 'Windows did not let Mantle read this for this process',
  };
  const why = (id) => () => NOT[id] || NOT._;
  const C = (id, label, o) => Object.assign({ id, label, title: label, def: false, why: why(id) }, o || {});
  const num = (id, label, f, o) => C(id, label, Object.assign({ num: true, w: 96, text: (r) => f(r[id]) }, o));
  const COLS = [
    { id: 'name', label: 'Name', fixed: true, flex: true, min: 200, get: (r) => r.name,
      html: (r) => `${TM.iconHtml(r.icon, r.iconWhy)}<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>` },
    C('packageName', 'Package name', { w: 160 }),
    num('pid', 'PID', (v) => (v == null ? null : String(v)), { def: true, w: 70 }),
    C('status', 'Status', { def: true, w: 110, html: (r) => (r.status == null ? TM.na(NOT._) : `<span class="dst${r.status === 'Not responding' ? ' bad' : ''}">${esc(r.status)}</span>`) }),
    C('user', 'User name', { def: true, w: 120 }),
    C('sessionId', 'Session ID', { num: true, w: 80 }),
    C('jobId', 'Job object ID', { num: true, w: 96 }),
    num('cpu', 'CPU', (v) => (typeof v === 'number' && isFinite(v) ? String(Math.round(v)).padStart(2, '0') : null), { def: true, w: 56 }),
    num('cpuTimeSec', 'CPU time', fmt.hms, { w: 90 }),
    num('cycles', 'Cycle', N, { w: 130 }),
    num('ws', 'Working set (memory)', K, { w: 110 }),
    num('wsPeak', 'Peak working set (memory)', K, { w: 110 }),
    num('wsDelta', 'Working set delta (memory)', K, { w: 110 }),
    num('mem', 'Memory (active private working set)', K, { def: true, w: 110 }),
    num('privateWs', 'Memory (private working set)', K, { w: 110 }),
    num('sharedWs', 'Memory (shared working set)', K, { w: 110 }),
    num('commit', 'Commit size', K, { w: 100 }),
    num('pagedPool', 'Paged pool', K, { w: 90 }),
    num('npPool', 'NP pool', K, { w: 80 }),
    num('pageFaults', 'Page faults', N, { w: 100 }),
    num('pfDelta', 'PF delta', N, { w: 80 }),
    C('basePriority', 'Base priority', { w: 100 }),
    num('handles', 'Handles', N, { w: 76 }),
    num('threads', 'Threads', N, { w: 70 }),
    num('userObjects', 'User objects', N, { w: 90 }),
    num('gdiObjects', 'GDI objects', N, { w: 86 }),
    num('ioReads', 'I/O reads', N, { w: 96 }),
    num('ioWrites', 'I/O writes', N, { w: 96 }),
    num('ioOther', 'I/O other', N, { w: 96 }),
    num('ioReadBytes', 'I/O read bytes', N, { w: 120 }),
    num('ioWriteBytes', 'I/O write bytes', N, { w: 120 }),
    num('ioOtherBytes', 'I/O other bytes', N, { w: 120 }),
    C('path', 'Image path name', { w: 260 }),
    C('cmdline', 'Command line', { w: 260 }),
    C('osContext', 'Operating system context', { w: 140 }),
    C('platform', 'Platform', { w: 80 }),
    C('arch', 'Architecture', { def: true, w: 96 }),
    C('elevated', 'Elevated', { w: 76, text: (r) => yes(r.elevated) }),
    C('uacVirt', 'UAC virtualization', { w: 120 }),
    C('desc', 'Description', { def: true, w: 260 }),
    C('dep', 'Data Execution Prevention', { w: 140 }),
    C('enterprise', 'Enterprise Context', { w: 120 }),
    C('powerThrottling', 'Power Throttling', { w: 120 }),
    C('shadowStack', 'Hardware-enforced Stack Protection', { w: 160 }),
  ];

  /* ---- outcomes on the row ---- */
  function setOut(r, o) {
    if (o) outcome.set(r.pid, Object.assign({ at: Date.now() }, o)); else outcome.delete(r.pid);
    if ((o && (o.kind === 'ok' || o.kind === 'dry'))) { const at = outcome.get(r.pid).at; setTimeout(() => { const x = outcome.get(r.pid); if (x && x.at === at) { outcome.delete(r.pid); TM.refresh(); } }, 15000); }
    TM.refresh();
  }
  /* res -> the row's words. done: the words of a real success ('' = nothing to say) */
  function said(r, res, head, done) {
    if (!res || res.cancelled) { setOut(r, null); return res; }
    if (res.ok === false) setOut(r, res.needsAdmin ? { kind: 'admin', res, head } : { kind: 'bad', text: `${head}: ${res.reason}` });
    else if (res.dryRun) setOut(r, { kind: 'dry', text: res.reason || `Test Mantle: ${head.toLowerCase()} was not done.` });
    else setOut(r, done ? { kind: 'ok', text: done } : null);
    return res;
  }
  function sub(r) {
    const o = outcome.get(r.pid);
    if (!o) return '';
    if (o.kind === 'busy') return `<div class="st" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(o.text)}</span></div>`;
    if (o.kind === 'admin') return `<div class="st bad dadm" role="status">${o.head ? `<span>${esc(o.head)}:</span>` : ''}${TM.adminHtml(o.res)}</div>`;
    const loc = o.loc ? '<span class="grow"></span><button type="button" class="btn sm" data-act="dumploc">Open file location</button>' : '';
    return `<div class="st${o.kind === 'bad' ? ' bad' : ''}" role="status">${o.kind === 'bad' ? TM.warnLine('', o.text) : `<span>${esc(o.text)}</span>`}${loc}</div>`;
  }

  /* ---- one dialog per action (see the header) ---- */
  const ids = (r) => ({ pid: r.pid, created: r.created });
  async function guarded(r, cmd, args, ask, busyWords) {
    const key = r.pid + cmd;
    if (busy.has(key)) return { ok: false, cancelled: true };
    busy.add(key);
    try {
      const pre = await TM.run(cmd, Object.assign({}, args, { dryRun: true }), { noConfirm: true, noDry: true });
      if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
        const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'OK', check: pre.check || null, width: 460 });
        if (!c.ok) return { ok: false, cancelled: true };
        if (busyWords) setOut(r, { kind: 'busy', text: busyWords });
        return await TM.run(cmd, Object.assign({}, args, { confirmed: true }));
      }
      if (pre.ok === false) return pre;        // needs admin / failed / no such command: said without asking
      if (ask) { const c = await ask(); if (!c.ok) return { ok: false, cancelled: true }; }
      if (busyWords) setOut(r, { kind: 'busy', text: busyWords });
      return await TM.run(cmd, args);
    } finally { busy.delete(key); }
  }

  async function endTask(r, tree) {
    if (!r) return;
    const nm = r.name;
    const ask = () => (tree
      ? TM.confirm({ title: `Do you want to end the process tree of ${nm}?`, body: 'If open programs are associated with this process tree, they will close and you will lose any unsaved data. If you end a system process, it might result in system instability. Are you sure you want to continue?', ok: 'End process tree', width: 460 })
      : TM.confirm({ title: `Do you want to end ${nm}?`, body: 'If an open program is associated with this process, it will close and you will lose any unsaved data. If you end a system process, it might result in system instability. Are you sure you want to continue?', ok: 'End process', width: 460 }));
    const res = await guarded(r, 'endPid', Object.assign(ids(r), tree ? { tree: true } : {}), ask, tree ? 'Ending the process tree...' : 'Ending...');
    said(r, res, tree ? 'The process tree was not ended' : 'Not ended', tree ? 'Process tree ended' : 'Ended');
  }
  const PRIO = [['realtime', 'Realtime'], ['high', 'High'], ['abovenormal', 'Above normal'], ['normal', 'Normal'], ['belownormal', 'Below normal'], ['low', 'Low']];
  const prioOf = (r) => { const b = String(r.basePriority || '').toLowerCase().replace(/\s+/g, ''); return b === 'idle' ? 'low' : b; };
  async function priority(r, cls, label) {
    const ask = () => TM.confirm({ title: `Do you want to change the priority of ${r.name}?`, body: 'Changing the priority of certain processes could cause system instability.', ok: 'Change priority', width: 460 });
    said(r, await guarded(r, 'priority', Object.assign(ids(r), { cls }), ask, `Setting priority to ${label}...`), 'Priority not changed', `Priority set to ${label}`);
  }
  const uacCan = (r) => r.uacVirt === 'Enabled' || r.uacVirt === 'Disabled';
  async function uacVirt(r) {
    const on = r.uacVirt !== 'Enabled';
    const ask = () => TM.confirm({ title: `Do you want to change UAC virtualization for ${r.name}?`, body: 'Changing UAC virtualization might cause problems with this program. Are you sure you want to continue?', ok: 'Change virtualization', width: 460 });
    said(r, await guarded(r, 'uacVirt', Object.assign(ids(r), { on }), ask), 'UAC virtualization not changed', `UAC virtualization ${on ? 'enabled' : 'disabled'}`);
  }
  const effOn = (r) => !!(r && (r.efficiency || r.status === 'Efficiency mode'));
  async function efficiency(r) {
    if (!r) return;
    const on = !effOn(r);
    // a system process: main's words only; otherwise the shell's Windows question (Settings > Ask me first)
    const pre = await TM.run('efficiency', Object.assign(ids(r), { on, dryRun: true }), { noConfirm: true, noDry: true });
    let res;
    if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
      const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'Turn on Efficiency mode', check: pre.check || null, width: 460 });
      res = c.ok ? await TM.run('efficiency', Object.assign(ids(r), { on, confirmed: true })) : { ok: false, cancelled: true };
    } else if (pre.ok === false) res = pre;
    else res = await TM.act.efficiency(ids(r), on, r.name);
    said(r, res, 'Efficiency mode not changed', '');
  }
  async function dump(r) {
    // the shell's dump dialog runs the command inside itself, so a needsConfirm there would wait behind it:
    // a critical process is asked here first and its outcome said on the row
    const pre = await TM.run('dump', Object.assign(ids(r), { dryRun: true }), { noConfirm: true, noDry: true });
    if (pre.ok === false && pre.needsConfirm && (pre.title || pre.text)) {
      const c = await TM.confirm({ title: pre.title, body: pre.text, ok: pre.button || 'Create dump file', check: pre.check || null, width: 460 });
      if (!c.ok) return;
      setOut(r, { kind: 'busy', text: `Dumping ${r.name}...` });
      const res = await TM.run('dump', Object.assign(ids(r), { confirmed: true }));
      if (res.ok && !res.dryRun && res.path) setOut(r, { kind: 'ok', text: `The file has been created successfully: ${res.path}`, loc: res.path });
      else said(r, res, 'The dump file was not created', '');
      return;
    }
    if (pre.ok === false) { said(r, pre, 'The dump file was not created', ''); return; }
    TM.act.dump(r.pid, r.name);
  }

  /* ---- Set affinity: Windows' "Processor affinity" ---- */
  const big = (x) => { try { if (typeof x === 'number' && isFinite(x)) return BigInt(Math.floor(x)); if (typeof x === 'bigint') return x; const s = String(x || '').trim(); if (/^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s)) return BigInt(s); } catch (_) { /* unreadable */ } return null; };
  const maskStr = (b) => '0x' + b.toString(16).toUpperCase();
  async function affinity(r) {
    let chosen = null;
    await TM.dialog({
      title: 'Processor affinity', width: 400, cls: 'daff',
      body: `<p class="dq">Which processors are allowed to run ${esc(r.name)}?</p><div class="aff-list" role="group" aria-label="Processors"><p class="aff-wait"><span class="spin" aria-hidden="true"></span>Reading its current affinity...</p></div><div class="aff-why" hidden></div>`,
      buttons: [{ id: 'ok', label: 'OK', primary: true, disabled: true }, { id: 'cancel', label: 'Cancel' }],
      async init(el, api) {
        const got = await TM.run('affinityGet', ids(r), { noDry: true });
        if (!document.contains(el)) return;
        const cur = got && got.ok !== false ? big(got.mask) : null;
        const sys = got && got.ok !== false ? big(got.systemMask) : null;
        let n = (got && got.logical) || (m.perf && m.perf.cpu && m.perf.cpu.logical) || 0;
        if (!n && sys) n = sys.toString(2).length;
        const cpus = [];
        for (let i = 0; i < n; i++) if (!sys || (sys >> BigInt(i)) & 1n) cpus.push(i);
        const whyEl = el.querySelector('.aff-why');
        const sayWhy = (h) => { whyEl.innerHTML = h; whyEl.hidden = !h; };
        if (!cpus.length) { el.querySelector('.aff-list').innerHTML = ''; sayWhy(TM.warnLine('bad', `Mantle could not tell how many processors this PC has${got && got.reason ? ` (${got.reason})` : ''}.`)); return; }
        const on = (i) => (cur == null ? true : !!((cur >> BigInt(i)) & 1n));
        el.querySelector('.aff-list').innerHTML = '<label class="dchk aff-all"><input type="checkbox" data-all="1"><span>&lt;All processors&gt;</span></label>' +
          cpus.map((i) => `<label class="dchk"><input type="checkbox" data-cpu="${i}"${on(i) ? ' checked' : ''}><span>CPU ${i}</span></label>`).join('');
        if (cur == null) sayWhy(`<span class="aff-note">${ICON.warn}<span>${esc(`Mantle could not read its current affinity${got && got.reason ? ` (${got.reason})` : ''}; every processor is ticked.`)}</span></span>`);
        const all = el.querySelector('[data-all]'), boxes = Array.from(el.querySelectorAll('[data-cpu]'));
        const sync = () => {
          const k = boxes.filter((b) => b.checked).length;
          all.checked = k === boxes.length; all.indeterminate = k > 0 && k < boxes.length;
          api.button('ok').disabled = k === 0;
          const z = el.querySelector('.aff-zero');
          if (!k && !z) whyEl.insertAdjacentHTML('afterbegin', `<span class="aff-zero bad">${ICON.warn}<span>The process must have affinity with at least one processor.</span></span>`);
          else if (k && z) z.remove();
          whyEl.hidden = !whyEl.innerHTML.trim();
        };
        all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); sync(); });
        boxes.forEach((b) => b.addEventListener('change', sync));
        sync();
        all.focus();
      },
      onButton(id, el) {
        if (id !== 'ok') return true;
        let mk = 0n;
        el.querySelectorAll('[data-cpu]:checked').forEach((b) => { mk |= 1n << BigInt(b.dataset.cpu); });
        if (!mk) return false;
        chosen = maskStr(mk);
        return true;
      },
    });
    if (!chosen) return;
    // no ordinary question in Windows here; a critical process gets main's words through TM.run
    setOut(r, { kind: 'busy', text: 'Setting affinity...' });
    said(r, await TM.run('affinity', Object.assign(ids(r), { mask: chosen })), 'Affinity not changed', 'Affinity set');
  }

  /* ---- Analyze wait chain ---- */
  const pidIn = (x) => { if (x && x.pid != null) return Number(x.pid); const mm = /\(PID (\d+)\)/i.exec(String((x && x.on) || '')); return mm ? Number(mm[1]) : null; };
  async function waitChain(r) {
    let res = null, ends = [];
    await TM.dialog({
      title: 'Analyze wait chain', width: 480, cls: 'dwait',
      body: `<p class="dq"><span class="spin" aria-hidden="true"></span>Analyzing ${esc(r.name)}...</p>`,
      buttons: [{ id: 'cancel2', label: 'Close', primary: true }],
      async init(el, api) {
        res = await TM.run('waitChain', { pid: r.pid, created: r.created }, { noDry: true });
        if (!document.contains(el)) return;
        if (res.ok === false) {
          api.setBody(`<div class="dq">${res.needsAdmin ? TM.adminHtml(res) : TM.warnLine('bad', `The wait chain was not read: ${res.reason}`)}</div>`);
        } else if (!(res.threads && res.threads.length)) {
          api.setBody(`<p class="dq">${esc(r.name)} is running normally.</p>`);
        } else {
          const items = res.threads.map((th, i) => {
            const p = pidIn(th);
            const line = `Thread ${th.tid != null ? th.tid : '?'}: ${th.state || 'Waiting'}${th.on ? ` on ${th.on}` : ''}`;
            return `<li>${p != null && p !== r.pid ? `<label class="dchk"><input type="checkbox" data-wpid="${p}" data-i="${i}"><span>${esc(line)}</span></label>` : `<span class="wline">${esc(line)}</span>`}</li>`;
          }).join('');
          api.setBody(`<p class="dq">${esc(r.name)} is waiting for another process.</p><p class="dq">End processes in the tree below that are not responding to continue running ${esc(r.name)}.</p>` +
            `<ul class="wtree"><li><span class="wroot">${esc(r.name)} (PID ${esc(r.pid)})</span><ul>${items}</ul></li></ul>`);
          api.setButtons([{ id: 'end', label: 'End process', danger: true, disabled: true }, { id: 'cancel2', label: 'Cancel', primary: true }]);
          const sync = () => { api.button('end').disabled = !el.querySelector('[data-wpid]:checked'); };
          el.querySelectorAll('[data-wpid]').forEach((b) => b.addEventListener('change', sync));
        }
        const b = api.button('cancel2'); if (b) b.focus();
      },
      onButton(id, el) {
        if (id === 'end') ends = Array.from(el.querySelectorAll('[data-wpid]:checked')).map((b) => Number(b.dataset.wpid));
        return true;
      },
    });
    // after the dialog has closed (a critical process's own question would otherwise wait behind it)
    for (const p of ends) {
      const row = rowsAll.find((x) => x.pid === p);
      if (!row) { setOut(r, { kind: 'bad', text: `PID ${p} was not ended: it is not in the list any more` }); continue; }
      setOut(row, { kind: 'busy', text: 'Ending...' });
      said(row, await TM.run('endPid', ids(row)), 'Not ended', 'Ended');
    }
    return res;
  }

  /* ---- Go to service(s) ---- */
  async function goToServices(r) {
    const res = await TM.run('goToServices', ids(r), { noDry: true });
    if (res.ok === false) { said(r, res, 'Its services were not found', ''); return; }
    const names = res.names || [];
    if (!names.length) { setOut(r, { kind: 'dry', text: `No services run in ${r.name} (PID ${r.pid}).` }); return; }
    TM.goTo('services', { names });
  }

  /* ---- menus ---- */
  const noPath = (r) => !r.path;
  function rowMenu(r) {
    const cur = prioOf(r);
    return [
      { label: 'End task', key: 'Delete', act: () => endTask(r, false) },
      { label: 'End process tree', act: () => endTask(r, true) },
      { label: 'Efficiency mode', checked: effOn(r), act: () => efficiency(r) },
      { sep: true },
      { label: 'Set priority', sub: () => PRIO.map(([cls, label]) => ({ label, radio: true, checked: cur === cls, act: () => priority(r, cls, label) })) },
      { label: 'Set affinity', act: () => affinity(r) },
      { sep: true },
      { label: 'Analyze wait chain', act: () => waitChain(r) },
      { label: 'UAC virtualization', disabled: !uacCan(r), title: uacCan(r) ? undefined : `UAC virtualization is ${String(r.uacVirt || 'not reported').toLowerCase()} for this process`, act: () => uacVirt(r) },
      { label: 'Create memory dump file', act: () => dump(r) },
      { sep: true },
      { label: 'Open file location', disabled: noPath(r), title: noPath(r) ? NOT.path : undefined, act: () => TM.act.openLocation(r.path) },
      { label: 'Search online', act: () => TM.act.searchOnline(r.name) },
      { label: 'Properties', disabled: noPath(r), title: noPath(r) ? NOT.path : undefined, act: () => TM.act.properties(r.path) },
      { label: 'Go to service(s)', act: () => goToServices(r) },
    ];
  }
  // Windows' header right-click on Details: Hide column, Select columns
  function headMenu(e) {
    const h = e.target.closest('[data-col]');
    const id = h && h.dataset.col;
    const c = COLS.find((x) => x.id === id);
    TM.menu.open([
      { label: 'Hide column', disabled: !c || c.fixed, title: c && c.fixed ? 'Name is always shown' : undefined, act: () => t.toggleCol(id) },
      { label: 'Select columns', act: () => t.selectColumns() },
    ], { x: e.clientX, y: e.clientY });
  }

  const selRow = () => (t ? t.selected() : null);
  function tryWant() {
    if (wantPid == null || !t) return;
    const k = 'p' + wantPid;
    if (t.rows.has(k)) { wantPid = null; wantMiss = 0; t.select(k, true); return; }
    if (rowsAll.some((r) => r.pid === wantPid) && TM.q) { setTimeout(() => TM.setQuery(''), 0); return; }   // a search hides it: Windows shows it
    if (rowsAll.length && ++wantMiss >= 3) { TM.note(`PID ${wantPid} is not running any more.`); wantPid = null; wantMiss = 0; }
  }

  TM.page({
    id: 'details',
    init(root) {
      root.innerHTML = '<div class="dtbl"></div>';
      const host = root.querySelector('.dtbl');
      t = TM.table(host, {
        id: 'details', cols: COLS, sort: { by: 'name', dir: 1 }, selectDialog: true,
        label: 'Details. Up and down to choose, Delete to end the task, the menu key for more.',
        key: (r) => 'p' + r.pid,
        sub, cls: (r) => (r.status === 'Not responding' ? 'hung' : ''),
        onAct: (a, r) => { const o = outcome.get(r.pid); if (a === 'dumploc' && o && o.loc) TM.act.openLocation(o.loc); },
        onDelete: (r) => endTask(r, false),
        onEnter: () => {},
        onDbl: () => {},
        menu: rowMenu,
      });
      host.addEventListener('contextmenu', (e) => { if (e.target.closest('.thead')) { e.preventDefault(); e.stopPropagation(); headMenu(e); } }, true);
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('details');
      const d = m.details || {};
      rowsAll = d.rows || [];
      if (st !== 'ok') {
        t.state(st === 'unsupported' ? TM.stateHtml('unsupported') : st === 'error' ? TM.stateHtml('error', d.error || 'Mantle could not read the list of processes.') : TM.stateHtml('loading', 'Reading processes...'));
        t.render({ rows: [] });
        return;
      }
      const live = new Set(rowsAll.map((r) => r.pid));
      for (const p of Array.from(outcome.keys())) if (!live.has(p)) outcome.delete(p);
      const rows = rowsAll.filter((r) => TM.match(r.name, r.pid, r.desc));
      t.state(TM.q && !rows.length ? TM.stateHtml('noq') : !rows.length ? TM.stateHtml('empty', 'No processes were reported.') : null);
      t.render({ rows });
      if (d.error) TM.note(`Details: ${d.error}`);
      tryWant();
    },
    commands() {
      const r = selRow();
      const pick = 'choose a process first';
      return [
        { id: 'end', label: 'End task', icon: ICON.end, key: 'Delete', disabled: !r, title: r ? 'End task' : `End task (${pick})`, act: () => endTask(selRow(), false) },
        { id: 'props', label: 'Properties', icon: ICON.props, disabled: !r || noPath(r), title: !r ? `Properties (${pick})` : noPath(r) ? NOT.path : 'Properties', act: () => { const x = selRow(); if (x) TM.act.properties(x.path); } },
        { id: 'eff', label: 'Efficiency mode', icon: ICON.leaf, checked: effOn(r), disabled: !r, title: r ? 'Efficiency mode' : `Efficiency mode (${pick})`, act: () => efficiency(selRow()) },
      ];
    },
    endTask() { endTask(selRow(), false); },
    focus(first) { if (first && !t.sel && t.order.length) t.select(t.order[0], true); t.focus(); },
    show(arg) { if (arg && arg.pid != null) { wantPid = Number(arg.pid); wantMiss = 0; tryWant(); } },
  });
}());
