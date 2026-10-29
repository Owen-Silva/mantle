/* pages/details.js - Windows' Details page (TM-SPEC.md "Details"), on the shell's TM.table.
 * Rows: model.details.rows, one per process (key p<pid>; lib/features/_taskmgr-details.js rowsFrom). Default
 * columns are Windows' own; the header's right-click is Windows' two items (Hide column, Select columns: the
 * table's headerMenu option), and Select columns lists every column Windows has except Name (chooser:false,
 * always shown), persisted by the table. A null cell is an em dash whose tooltip is the row's own `why` when
 * the field is in its `unread` list, else this page's plain words. Every action's outcome is said ON its row
 * (ending..., failed + reason, needs admin + "Set up administrator access", a dry run's words), never silent.
 *
 * ONE dialog per action. Windows asks its own question before End task / End process tree / Set priority /
 * UAC virtualization; for a system or critical process main answers needsConfirm with Windows' stronger
 * words instead (the "Abandon unsaved data and shut down." box). To show exactly one of the two, the page
 * first asks main with dryRun:true and noConfirm (nothing is done): needsConfirm => main's dialog only, then
 * the command goes with confirmed:true; otherwise Windows' ordinary question, then the command goes plainly
 * (should main still answer needsConfirm, TM.run shows it: never a silent bypass). A dry run that already
 * fails (needs admin, no such command) is said on the row without asking anything. Efficiency mode and
 * Create memory dump file do the same inside the shell (TM.act.efficiency / TM.act.dump preflight).
 */
(function () {
  'use strict';
  const { esc, fmt, ICON } = TM;
  let t = null, m = {}, rowsAll = [], wantPid = null, wantMiss = 0, detErr = null;
  const outcome = new Map();   // pid -> { kind: 'busy'|'ok'|'dry'|'bad'|'admin', text, res, at, loc }
  const busy = new Set();

  /* ---- columns: Windows' Select columns list, in Windows' order (Name is always there) ---- */
  const K = (b) => fmt.kb(b);
  const N = (n) => fmt.num(n);
  const yes = (b) => (b == null ? null : b ? 'Yes' : 'No');
  const NOT = {
    user: 'Windows did not let Mantle read who runs it', arch: 'Windows did not say what it is built for', desc: 'Its file has no description, or Windows did not let Mantle read it',
    path: 'Windows did not let Mantle see where its file is', cmdline: 'Windows did not let Mantle read its command line',
    // the sidecar sends jobId null on every row (its fieldWhy: SystemFullProcessInformation is admin-only), elevated or not
    jobId: 'Mantle does not read job object IDs yet (Windows gives them only to an administrator)',
    packageName: 'Not a packaged (Store) app', cycles: 'Windows did not let Mantle read its CPU cycles', pagedPool: 'Windows did not report its pool use', npPool: 'Windows did not report its pool use',
    osContext: 'Windows did not say which Windows it was built for', enterprise: 'Windows did not report an enterprise context', shadowStack: 'Windows did not report its stack protection',
    _: 'Windows did not let Mantle read this for this process',
  };
  /* The em dash's tooltip. A Details row (rowsFrom) carries unread: [field ids Windows did not answer] and why: ONE
     plain-words string for the row (the sidecar's reason, e.g. "Windows lets only an administrator open this
     process (access denied)"): that string when the field is unread. A row without `unread` is lib's fallback
     (the snapshot's basic columns, the Details reader failed): its error is the reason. */
  const whyOf = (id, r) => {
    if (r && Array.isArray(r.unread)) { if (typeof r.why === 'string' && r.why && r.unread.includes(id)) return r.why; }
    else if (r && detErr) return detErr.charAt(0).toUpperCase() + detErr.slice(1);   // lib: "only the basic columns: <why>"
    return NOT[id] || NOT._;
  };
  const why = (id) => (r) => whyOf(id, r);
  const C = (id, label, o) => Object.assign({ id, label, title: label, def: false, why: why(id) }, o || {});
  const num = (id, label, f, o) => C(id, label, Object.assign({ num: true, w: 96, text: (r) => f(r[id]) }, o));
  /* Details rows carry no icon of their own; the shell's icon cache is keyed by an app's identity, which is its exe
     path in lower case (lib/features/_taskmgr-core.js identityOf), so a file the Processes page has an icon for
     shows it here too; any other gets the plain tile, its tooltip saying why. */
  const iconOf = (r) => TM.iconHtml(r.icon || (r.path ? String(r.path).toLowerCase() : null), r.iconWhy || (r.path ? 'Mantle has not read an icon for this file' : whyOf('path', r)));
  const COLS = [
    { id: 'name', label: 'Name', fixed: true, chooser: false, flex: true, min: 200, get: (r) => r.name,
      html: (r) => `${iconOf(r)}<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>` },
    C('packageName', 'Package name', { w: 160 }),
    num('pid', 'PID', (v) => (v == null ? null : String(v)), { def: true, w: 70 }),
    C('status', 'Status', { def: true, w: 110, html: (r) => (r.status == null ? TM.na(whyOf('status', r)) :`<span class="dst${r.status === 'Not responding' ? ' bad' : ''}">${esc(r.status)}</span>`) }),
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
    else if (res.dryRun) setOut(r, { kind: 'dry', text: res.reason || 'Test Mantle: nothing was changed.' });
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
    // one request per process and command at a time (a double click sends one); a second one is said, not dropped quietly
    if (busy.has(key)) { TM.note(`${r.name || 'That process'}: the last change is still being made. Try again in a moment.`); return { ok: false, cancelled: true }; }
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
  /* Efficiency mode: the shell preflights (a system process gets main's words INSTEAD of Windows' question, never
     both; a dry run that already fails comes back unasked) and honours Settings > "Ask me first". */
  async function efficiency(r) {
    if (!r) return;
    said(r, await TM.act.efficiency(ids(r), !effOn(r), r.name), 'Efficiency mode not changed', '');
  }
  /* Create memory dump file: the shell asks a critical process's question BEFORE its "Dumping process" dialog,
     which then says the outcome; the row says it too (the path + Open file location once the dialog is gone). */
  async function dump(r) {
    if (!r) return;
    const res = await TM.act.dump(ids(r), r.name);
    if (!res || res.cancelled) return;
    if (res.ok === false) said(r, res, 'The dump file was not created', '');
    else if (res.dryRun) setOut(r, { kind: 'dry', text: res.reason || 'Test Mantle: no dump file was written.' });
    else setOut(r, res.path ? { kind: 'ok', text: `The file has been created successfully: ${res.path}`, loc: res.path } : { kind: 'ok', text: 'The file has been created successfully.' });
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
        // affinityGet -> { mask, systemMask ("0x" hex, TM-SPEC decision 10-28), logical (how many bits systemMask
        // has set), maskWhy (mask null: the process spans processor groups) }
        const got = await TM.run('affinityGet', ids(r), { noDry: true });
        if (!document.contains(el)) return;
        const cur = got && got.ok !== false ? big(got.mask) : null;
        const sys = got && got.ok !== false ? big(got.systemMask) : null;
        // the system mask's highest bit + 1 (logical is a COUNT of set bits, short of the top CPU's number on a gappy mask)
        const n = sys ? sys.toString(2).length : ((got && got.logical) || (m.perf && m.perf.cpu && m.perf.cpu.logical) || 0);
        const cpus = [];
        for (let i = 0; i < n; i++) if (!sys || (sys >> BigInt(i)) & 1n) cpus.push(i);
        const whyEl = el.querySelector('.aff-why');
        const sayWhy = (h) => { whyEl.innerHTML = h; whyEl.hidden = !h; };
        if (!cpus.length) { el.querySelector('.aff-list').innerHTML = ''; sayWhy(TM.warnLine('bad', `Mantle could not tell how many processors this PC has${got && got.reason ? ` (${got.reason})` : ''}.`)); return; }
        const on = (i) => (cur == null ? true : !!((cur >> BigInt(i)) & 1n));
        el.querySelector('.aff-list').innerHTML = '<label class="dchk aff-all"><input type="checkbox" data-all="1"><span>&lt;All processors&gt;</span></label>' +
          cpus.map((i) => `<label class="dchk"><input type="checkbox" data-cpu="${i}"${on(i) ? ' checked' : ''}><span>CPU ${i}</span></label>`).join('');
        const curWhy = got && (got.maskWhy || got.reason);
        if (cur == null) sayWhy(`<span class="aff-note">${ICON.warn}<span>${esc(`Mantle could not read its current affinity${curWhy ? ` (${curWhy})` : ''}; every processor is ticked.`)}</span></span>`);
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

  /* ---- Analyze wait chain ----
     lib passes the sidecar's WCT reply through unchanged (TM-SPEC decision 10-28; sidecar/ProcOps.cs WaitChain):
       { ok, reason, needsAdmin, threads: [{ tid, chain: [node], deadlock, waiting, error? }], threadCount,
         truncated (only its first 512 threads were read), blocked (how many wait), deadlocks (how many are in a cycle) }
       node = { type, status, pid?, tid?, waitTime?, name? }. chain[0] is the thread itself (type 'thread'); then what
       it waits on (a lock object: type criticalSection|sendMessage|mutex|alpc|com|threadWait|processWait|
       comActivation|socketIo|smbIo|unknown, status owned|notOwned|abandoned|noAccess|unknown|error, name = the
       object's name when it has one), then the thread holding that (type 'thread': pid + tid, status blocked|
       running|pidOnly|pidOnlyRpcss|noAccess), and so on. th.error ("access denied", "the thread ended", "error N"):
       Windows answered nothing for that thread. waitTime is WCT's raw counter, no unit Windows documents: not shown
       (Windows' dialog shows none either).
     Windows' dialog: "<name> is waiting for another process (<names>)." + "End processes in the tree below that are
     not responding to continue running <name>.", a tree (the process > its waiting threads > what each waits on:
     process name + PID, thread), a box per other process, End process + Cancel. */
  const WAIT_FOR = {
    criticalSection: 'a critical section', sendMessage: 'a window message (SendMessage)', mutex: 'a mutex', alpc: 'an ALPC call',
    com: 'a COM call', threadWait: 'a thread to end', processWait: 'a process to end', comActivation: 'a COM activation',
    socketIo: 'network I/O', smbIo: 'file share (SMB) I/O', unknown: 'an object Windows did not identify',
  };
  const LOCK_STATE = { owned: 'owned', notOwned: 'not owned', abandoned: 'abandoned', noAccess: 'access denied', error: 'Windows reported an error' };
  const THREAD_STATE = { blocked: 'waiting', running: 'running', noAccess: 'access denied: Windows shows nothing past it', pidOnly: 'Windows names only its process', pidOnlyRpcss: 'Windows names only its process (RPC)', error: 'Windows reported an error' };
  const chainOf = (th) => (th && Array.isArray(th.chain) ? th.chain : []);
  const nodePid = (nd) => { const p = Number(nd && nd.pid); return nd && nd.type === 'thread' && Number.isFinite(p) && p > 0 ? p : null; };
  const procName = (pid, r) => (pid === r.pid ? r.name : ((rowsAll.find((x) => x.pid === pid) || {}).name || null));
  function waitNode(nd, r) {
    if (nd.type === 'thread') {
      const pid = nodePid(nd);
      const st = THREAD_STATE[nd.status];
      const words = pid != null
        ? `${procName(pid, r) || 'A process that is not in the list'} (PID ${pid})${nd.tid ? `, thread ${nd.tid}` : ''}${st ? ` (${st})` : ''}`
        : `A thread Windows did not name${st ? ` (${st})` : ''}`;
      // a box for another process this list has (System and the System Idle Process cannot be ended)
      const other = pid != null && pid !== r.pid;
      const can = other && pid > 4 && rowsAll.some((x) => x.pid === pid);
      if (can) return `<li><label class="dchk"><input type="checkbox" data-wpid="${pid}"><span>${esc(words)}</span></label></li>`;
      const tip = other ? (pid <= 4 ? 'Windows does not let the System process be ended' : 'It is not in the list any more, so Mantle cannot end it') : '';
      return `<li><span class="wline"${tip ? ` title="${esc(tip)}"` : ''}>${esc(words)}</span></li>`;
    }
    const st = LOCK_STATE[nd.status];
    const what = WAIT_FOR[nd.type] || `an object of type ${nd.type || 'unknown'}`;
    return `<li><span class="wline">${esc(`Waiting for ${what}${nd.name ? ` "${nd.name}"` : ''}${st ? ` (${st})` : ''}`)}</span></li>`;
  }
  function waitThread(th, r) {
    const self = chainOf(th)[0] || {};
    const head = `Thread ${th.tid != null ? th.tid : '?'} ${self.status === 'running' ? 'is running' : 'is waiting'}${th.deadlock ? ' in a deadlock' : ''}`;
    const rest = chainOf(th).slice(1).map((nd) => waitNode(nd, r)).join('');
    return `<li><span class="wthr${th.deadlock ? ' bad' : ''}">${esc(head)}</span>${rest ? `<ul>${rest}</ul>` : ''}</li>`;
  }
  /* res (ok) -> the dialog's body: Windows' lines, the tree, then what Mantle could not read (never silent). */
  function waitBody(res, r) {
    const nm = r.name;
    const thr = Array.isArray(res.threads) ? res.threads : null;
    if (!thr) return `<div class="dq">${TM.warnLine('bad', `Mantle got no list of the threads of ${nm} back, so it cannot say what it waits for.`)}</div>`;
    const others = new Map();
    for (const th of thr) for (const nd of chainOf(th).slice(1)) { const p = nodePid(nd); if (p != null && p !== r.pid && !others.has(p)) others.set(p, procName(p, r) || `PID ${p}`); }
    const reaches = (th) => chainOf(th).slice(1).some((nd) => { const p = nodePid(nd); return p != null && p !== r.pid; });
    // the threads with a chain to show (it waits on something WCT follows, or sits in a deadlock); deadlocks first,
    // then the ones that reach another process
    const shown = thr.filter((th) => th.deadlock || chainOf(th).length > 1)
      .sort((a, b) => (Number(!!b.deadlock) - Number(!!a.deadlock)) || (Number(reaches(b)) - Number(reaches(a))));
    const tree = shown.length ? `<ul class="wtree"><li><span class="wroot">${esc(nm)} (PID ${esc(r.pid)})</span><ul>${shown.map((th) => waitThread(th, r)).join('')}</ul></li></ul>` : '';
    const lines = [];
    if (r.status === 'Not responding') lines.push(`${nm} is not responding.`);
    if (others.size) lines.push(`${nm} is waiting for another process (${Array.from(others.values()).join(', ')}).`);
    else if (shown.length && shown.every((th) => chainOf(th).slice(1).every((nd) => nd.type === 'socketIo'))) lines.push(`One or more threads of ${nm} are waiting to finish network I/O.`);
    else if (shown.length) lines.push(`${nm} is not waiting for another process.`);
    else lines.push(`${nm} is running normally.`);
    const dead = thr.filter((th) => th.deadlock).length;
    if (dead) lines.push(`${dead === 1 ? 'One of its threads is' : `${dead} of its threads are`} in a deadlock: a loop of waits that cannot end on its own.`);
    if (tree.includes('data-wpid=')) lines.push(`End processes in the tree below that are not responding to continue running ${nm}.`);
    const notes = [];
    const plain = thr.filter((th) => th.waiting && !th.deadlock && chainOf(th).length <= 1).length;
    if (plain) notes.push(`${plain === 1 ? 'One more thread is' : `${plain} more threads are`} waiting on something Windows' wait chain analysis does not follow, so it cannot say what.`);
    const errs = new Map();
    for (const th of thr) if (th.error) errs.set(th.error, (errs.get(th.error) || 0) + 1);
    const nErr = Array.from(errs.values()).reduce((s, k) => s + k, 0);
    if (nErr) notes.push(`Windows answered nothing for ${nErr === 1 ? 'one thread' : `${nErr} threads`}: ${Array.from(errs, ([e, k]) => (k > 1 ? `${e} (${k})` : e)).join(', ')}.`);
    if (res.truncated) notes.push(`Mantle analyzed the first ${thr.length} of its ${res.threadCount != null ? res.threadCount : 'many'} threads.`);
    return lines.map((l) => `<p class="dq">${esc(l)}</p>`).join('') + tree + notes.map((l) => `<p class="dq wnote">${esc(l)}</p>`).join('');
  }
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
          // needsAdmin: lib retries through the elevated helper when it is set up (taskmgr.waitchain is on its list)
          api.setBody(`<div class="dq">${res.needsAdmin ? TM.adminHtml(res) : TM.warnLine('bad', `The wait chain was not read: ${res.reason}`)}</div>`);
        } else {
          api.setBody(waitBody(res, r));
          const boxes = Array.from(el.querySelectorAll('[data-wpid]'));
          if (boxes.length) {
            api.setButtons([{ id: 'end', label: 'End process', danger: true, disabled: true }, { id: 'cancel2', label: 'Cancel', primary: true }]);
            // one process can hold several chains: its boxes tick together
            const sync = (e) => {
              const b = e && e.target;
              if (b && b.dataset && b.dataset.wpid) boxes.forEach((x) => { if (x !== b && x.dataset.wpid === b.dataset.wpid) x.checked = b.checked; });
              api.button('end').disabled = !boxes.some((x) => x.checked);
            };
            boxes.forEach((b) => b.addEventListener('change', sync));
          }
        }
        const b = api.button('cancel2'); if (b) b.focus();
      },
      onButton(id, el) {
        if (id === 'end') ends = Array.from(new Set(Array.from(el.querySelectorAll('[data-wpid]:checked')).map((b) => Number(b.dataset.wpid))));
        return true;
      },
    });
    // after the dialog has closed (a critical process's own question would otherwise wait behind it): the shell's
    // endPid path, pid + created from this list (TM.run asks main's needsConfirm question first, never bypassed)
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
  // Windows' header right-click on Details: Hide column (off on Name and between cells), Select columns
  const headerMenu = (e, c) => [
    { label: 'Hide column', disabled: !c || !!c.fixed, title: c && c.fixed ? 'Name is always shown' : undefined, act: () => { if (c) t.toggleCol(c.id); } },
    { label: 'Select columns', act: () => t.selectColumns() },
  ];

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
        id: 'details', cols: COLS, sort: { by: 'name', dir: 1 }, headerMenu,
        label: 'Details. Up and down to choose, Delete to end the task, the menu key for more.',
        key: (r) => 'p' + r.pid,
        sub, cls: (r) => (r.status === 'Not responding' ? 'hung' : ''),
        onAct: (a, r) => { const o = outcome.get(r.pid); if (a === 'dumploc' && o && o.loc) TM.act.openLocation(o.loc); },
        onDelete: (r) => endTask(r, false),
        onEnter: () => {},
        onDbl: () => {},
        menu: rowMenu,
      });
    },
    render(mm) {
      m = mm;
      const st = TM.dataState('details');
      const d = m.details || {};
      rowsAll = d.rows || [];
      detErr = d.error || null;
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
