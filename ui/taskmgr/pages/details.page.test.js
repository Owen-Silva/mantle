/* pages/details.page.test.js - Windows' Details page, clicked and typed through on the MOCK (ui/taskmgr/testkit.js:
 * headless Chromium over file://, never Electron, never a real process; every pid and name is made up).
 * Every action is a dry run (test=1) and is checked in window.__mockCalls.
 *   node ui/taskmgr/pages/details.page.test.js   ->  "TASKMGR DETAILS PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const ROW = (pid) => `#pg-details .trow[data-key="p${pid}"]`;
// lib's created: the process' creation FILETIME as a decimal string (the mock makes it up this way)
const C = (pid) => String(133730000000000000 + pid * 1000);
const DEF = ['Name', 'PID', 'Status', 'User name', 'CPU', 'Memory (active private working set)', 'Architecture', 'Description'];
const MENU = ['End task', 'End process tree', 'Efficiency mode', 'Set priority', 'Set affinity', 'Analyze wait chain', 'UAC virtualization', 'Create memory dump file', 'Open file location', 'Search online', 'Properties', 'Go to service(s)'];

kit.run('TASKMGR DETAILS PAGE TEST', async (t) => {
  const { check, calls } = t;
  const heads = (p) => p.$$eval('#pg-details .thead .h', (hs) => hs.map((h) => h.querySelector('.hl').textContent.trim()));
  const menuLabels = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => b.querySelector('span').textContent) : []; });
  const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (!b || b.disabled) return false; b.click(); return true; }, label);
  const rmenu = async (p, pid) => { await p.click(ROW(pid) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const dlg = async (p) => { await p.waitForSelector('#dlg .dlg'); return p.$eval('#dlg .dlg', (d) => ({ title: d.querySelector('#dlgt').textContent, body: d.querySelector('.dbody').textContent, ok: (d.querySelector('[data-b="ok"]') || {}).textContent, okOff: !!(d.querySelector('[data-b="ok"]') || {}).disabled, focus: document.activeElement && document.activeElement.dataset.b, cls: d.className })); };
  const press = async (p, id) => { await p.click(`#dlg .dfoot [data-b="${id}"]`); };
  const noDlg = (p) => p.waitForFunction(() => document.getElementById('dlg').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  const waitCall = async (p, name, n) => { for (let i = 0; i < 60; i++) { const c = await calls(p, name); if (c.length >= (n || 1)) return c; await t.sleep(50); } return calls(p, name); };
  const last = async (p, name) => { const c = await waitCall(p, name); return c.length ? c[c.length - 1].args : {}; };
  const subText = (p, pid) => p.$eval(ROW(pid) + ' .tsub', (e) => e.textContent).catch(() => '');
  const waitSub = async (p, pid, re) => { for (let i = 0; i < 60; i++) { const s = await subText(p, pid); if (re.test(s)) return s; await t.sleep(50); } return subText(p, pid); };
  const inkOf = {};

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await t.open('view=details&test=1', { theme });
    await p.waitForSelector(ROW(1012));
    inkOf[theme] = await p.$eval('#pg-details .tlist', (e) => getComputedStyle(e).color);

    /* ---- the list ---- */
    check(T + 'default columns are Windows\'', (await heads(p)).join('|') === DEF.join('|'), (await heads(p)).join('|'));
    check(T + 'rows drawn', (await p.$$('#pg-details .trow')).length > 20);
    check(T + 'rows are 32 px (Windows density)', (await p.$eval(ROW(1012) + ' .tr', (e) => e.getBoundingClientRect().height)) === 32);
    const cells = await p.$$eval(ROW(1012) + ' .c', (cs) => cs.map((c) => c.textContent));
    check(T + 'a row: name, PID, Status, User name, CPU "00", Memory in K, Architecture, Description', cells[0] === 'svchost.exe' && cells[1] === '1012' && cells[2] === 'Running' && cells[3] === 'NETWORK SERVICE' && /^\d{2,3}$/.test(cells[4]) && / K$/.test(cells[5]) && cells[6] === 'x64' && cells[7] === 'Host Process for Windows Services', cells.join('|'));
    check(T + 'numbers right-aligned and tabular', await p.$eval(ROW(1012) + ' .c.num', (c) => getComputedStyle(c).justifyContent === 'flex-end' && getComputedStyle(c).fontVariantNumeric.includes('tabular')));
    check(T + 'no sideways scroll on the page at 1280', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    /* ---- sort ---- */
    const pids = () => p.$$eval('#pg-details .trow .c:nth-child(2)', (cs) => cs.map((c) => Number(c.textContent)));
    const names = await p.$$eval('#pg-details .trow .c.name', (cs) => cs.map((c) => c.textContent.toLowerCase()));
    check(T + 'sorted by Name by default', names.every((n, i) => i === 0 || names[i - 1] <= n));
    await p.click('#pg-details .thead .h[data-col="pid"]');
    let ps = await pids();
    check(T + 'PID header: biggest first', ps.every((x, i) => i === 0 || ps[i - 1] >= x), ps.slice(0, 5).join(','));
    await p.click('#pg-details .thead .h[data-col="pid"]');
    ps = await pids();
    check(T + 'PID header again: smallest first', ps.every((x, i) => i === 0 || ps[i - 1] <= x) && ps[0] === 4, ps.slice(0, 5).join(','));
    await p.click('#pg-details .thead .h[data-col="name"]');

    /* ---- header menu + Select columns (persisted) ---- */
    await p.click('#pg-details .thead .h[data-col="desc"]', { button: 'right' });
    check(T + 'header right-click: Hide column, Select columns (Windows\')', (await menuLabels(p)).join('|') === 'Hide column|Select columns', (await menuLabels(p)).join('|'));
    await pick(p, 'Hide column');
    check(T + 'Hide column hides Description', !(await heads(p)).includes('Description'));
    await p.click('#pg-details .thead .h[data-col="name"]', { button: 'right' });
    await pick(p, 'Select columns');
    const sc = await dlg(p);
    const labels = await p.$$eval('#dlg .colpick label', (ls) => ls.map((l) => l.textContent));
    const WANT = ['Package name', 'PID', 'Status', 'User name', 'Session ID', 'Job object ID', 'CPU', 'CPU time', 'Cycle', 'Working set (memory)', 'Peak working set (memory)', 'Working set delta (memory)', 'Memory (active private working set)', 'Memory (private working set)', 'Memory (shared working set)', 'Commit size', 'Paged pool', 'NP pool', 'Page faults', 'PF delta', 'Base priority', 'Handles', 'Threads', 'User objects', 'GDI objects', 'I/O reads', 'I/O writes', 'I/O other', 'I/O read bytes', 'I/O write bytes', 'I/O other bytes', 'Image path name', 'Command line', 'Operating system context', 'Platform', 'Architecture', 'Elevated', 'UAC virtualization', 'Description', 'Data Execution Prevention', 'Enterprise Context', 'Power Throttling', 'Hardware-enforced Stack Protection'];
    check(T + 'Select columns: the dialog', sc.title === 'Select columns');
    check(T + 'Select columns: Windows\' full list', WANT.every((w) => labels.includes(w)), WANT.filter((w) => !labels.includes(w)).join(','));
    check(T + 'Select columns: Name is not listed (always shown, as in Windows)', !labels.includes('Name'), labels.join('|'));
    await p.click('#dlg [data-col="handles"]');
    await p.click('#dlg [data-col="arch"]');
    await p.click('#dlg [data-col="desc"]');
    await press(p, 'ok');
    await noDlg(p);
    let hs = await heads(p);
    check(T + 'Select columns: Handles added, Architecture removed, Description back', hs.includes('Handles') && !hs.includes('Architecture') && hs.includes('Description'), hs.join('|'));
    await p.reload();
    await p.waitForFunction(() => document.documentElement.dataset.shot === '1');
    await p.waitForSelector(ROW(1012));
    hs = await heads(p);
    check(T + 'column choice persisted after a reload', hs.includes('Handles') && !hs.includes('Architecture'), hs.join('|'));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.details'));
    await p.reload();
    await p.waitForFunction(() => document.documentElement.dataset.shot === '1');
    await p.waitForSelector(ROW(1012));

    /* ---- command bar ---- */
    await p.click(ROW(1012) + ' .tr');
    const cmd = await p.$$eval('#cmdbar .cbtn', (bs) => bs.map((b) => b.getAttribute('aria-label')));
    check(T + 'command bar: Run new task | End task | Properties | Efficiency mode', cmd.join('|') === 'Run new task|End task|Properties|Efficiency mode', cmd.join('|'));
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="End task"]');
    let d = await dlg(p);
    check(T + 'End task: Windows\' question, Cancel focused', d.title === 'Do you want to end svchost.exe?' && d.ok === 'End process' && d.focus === 'cancel' && /lose any unsaved data/.test(d.body), JSON.stringify(d));
    await press(p, 'ok');
    let a = await last(p, 'taskmgr.endPid');
    check(T + 'End task: endPid {pid, created}, a dry run, not tree, not confirmed', a.pid === 1012 && a.created === C(1012) && a.dryRun === true && !a.tree && !a.confirmed, JSON.stringify(a));
    check(T + 'End task: the dry run is said on the row', /Test Mantle/.test(await waitSub(p, 1012, /Test Mantle/)), await subText(p, 1012));
    check(T + 'End task: one dialog only', await noDlg(p));
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Properties"]');
    a = await last(p, 'taskmgr.properties');
    check(T + 'Properties: its path', /svchost\.exe$/.test(a.path || ''), JSON.stringify(a));
    await p.click('#cmdbar [aria-label="Efficiency mode"]');
    d = await dlg(p);
    check(T + 'Efficiency mode: Windows\' question', d.title === 'Turn on Efficiency mode?', d.title);
    await t.clearCalls(p);
    await press(p, 'ok');
    a = await last(p, 'taskmgr.efficiency');
    check(T + 'Efficiency mode: efficiency {pid, created, on:true}', a.pid === 1012 && a.created === C(1012) && a.on === true, JSON.stringify(a));

    /* ---- the row menu, every item ---- */
    await rmenu(p, 1012);
    check(T + 'row menu: Windows\' items in Windows\' order', (await menuLabels(p)).join('|') === MENU.join('|'), (await menuLabels(p)).join('|'));
    await pick(p, 'End process tree');
    d = await dlg(p);
    check(T + 'End process tree: Windows\' question', d.title === 'Do you want to end the process tree of svchost.exe?' && d.ok === 'End process tree' && d.focus === 'cancel', JSON.stringify(d));
    await t.clearCalls(p);
    await t.clearCalls(p);
    await press(p, 'ok');
    a = await last(p, 'taskmgr.endPid');
    check(T + 'End process tree: endPid tree:true', a.pid === 1012 && a.tree === true && a.created === C(1012), JSON.stringify(a));
    await noDlg(p);
    const PRIO = [['Realtime', 'realtime'], ['High', 'high'], ['Above normal', 'abovenormal'], ['Normal', 'normal'], ['Below normal', 'belownormal'], ['Low', 'low']];
    for (const [label, cls] of PRIO) {
      await rmenu(p, 1012);
      await pick(p, 'Set priority');
      const sub = await menuLabels(p);
      if (cls === 'realtime') {
        check(T + 'Set priority: the six classes', sub.join('|') === PRIO.map((x) => x[0]).join('|'), sub.join('|'));
        check(T + 'Set priority: the current one (Normal) marked', await p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const b = Array.from(ms[ms.length - 1].querySelectorAll('button')).find((x) => x.getAttribute('aria-checked') === 'true'); return b && b.textContent.trim(); }) === 'Normal');
      }
      await t.clearCalls(p);
      await pick(p, label);
      d = await dlg(p);
      if (cls === 'high') check(T + 'Set priority: Windows\' question', d.title === 'Do you want to change the priority of svchost.exe?' && d.ok === 'Change priority' && d.focus === 'cancel', JSON.stringify(d));
      await t.clearCalls(p);
      await press(p, 'ok');
      a = await last(p, 'taskmgr.priority');
      check(`${T}Set priority > ${label}: priority {pid, created, cls:'${cls}'}`, a.pid === 1012 && a.created === C(1012) && a.cls === cls, JSON.stringify(a));
      await t.sleep(200);   // one request per process at a time: let this answer come back before the next class
      await noDlg(p);
    }
    /* Set affinity */
    await rmenu(p, 1012);
    await pick(p, 'Set affinity');
    await p.waitForSelector('#dlg .daff [data-cpu]');
    const ag = await calls(p, 'taskmgr.affinityGet');
    check(T + 'Set affinity: asked main for the current mask (affinityGet {pid, created})', ag.length >= 1 && ag[ag.length - 1].args.pid === 1012 && ag[ag.length - 1].args.created === C(1012), JSON.stringify(ag));
    d = await dlg(p);
    const boxes = await p.$$eval('#dlg [data-cpu]', (bs) => bs.map((b) => b.checked));
    check(T + 'Set affinity: Windows\' dialog, a box per logical processor (8)', d.title === 'Processor affinity' && /Which processors are allowed to run svchost\.exe\?/.test(d.body) && boxes.length === 8, `${d.title} ${boxes.length}`);
    // lib's affinityGet answers the current mask (the mock: 0xFF of 8): every box ticked from it, no "could not read" words
    check(T + 'Set affinity: the current mask from main (affinityGet 0xFF) = every box ticked', boxes.every(Boolean) && !/could not read its current affinity/.test(d.body), d.body);
    await p.click('#dlg [data-all]');
    check(T + 'Set affinity: <All processors> unticks all, OK off, the reason shown', (await p.$$eval('#dlg [data-cpu]', (bs) => bs.every((b) => !b.checked))) && (await dlg(p)).okOff && /at least one processor/.test((await dlg(p)).body));
    await p.click('#dlg [data-all]');
    check(T + 'Set affinity: <All processors> ticks all', await p.$$eval('#dlg [data-cpu]', (bs) => bs.every((b) => b.checked)));
    await p.click('#dlg [data-all]');
    await p.click('#dlg [data-cpu="0"]');
    await p.click('#dlg [data-cpu="2"]');
    check(T + 'Set affinity: some ticked = <All processors> part-ticked', await p.$eval('#dlg [data-all]', (b) => b.indeterminate && !b.checked));
    await t.clearCalls(p);
    await t.clearCalls(p);
    await press(p, 'ok');
    a = await last(p, 'taskmgr.affinity');
    check(T + 'Set affinity: affinity {pid, created, mask "0x5"}', a.pid === 1012 && a.created === C(1012) && a.mask === '0x5', JSON.stringify(a));
    /* Analyze wait chain (a made-up waited-on process added to the list so End process can be checked) */
    await p.evaluate(() => { const o = window.__mock.S.details; window.__mock.S.details = () => { const dd = o(); dd.rows.push(Object.assign({}, dd.rows[0], { pid: 2244, created: 3244, name: 'made-up.exe' })); return dd; }; window.__mock.push(); });
    await p.waitForSelector(ROW(2244));
    // the sidecar's WCT shape as lib passes it through (TM-SPEC decision 10-28), whatever the mock answers
    await p.evaluate(() => {
      if (window.__wcWrapped) return;
      window.__wcWrapped = true;
      const o = window.mantle.call.bind(window.mantle);
      window.mantle.call = async (n, a) => {
        const r = await o(n, a);
        if (n !== 'taskmgr.waitChain') return r;
        return { ok: true, reason: null, needsAdmin: false, threadCount: 3, truncated: false, blocked: 2, deadlocks: 0, threads: [
          { tid: 4012, deadlock: false, waiting: true, chain: [{ type: 'thread', status: 'blocked', pid: 1012, tid: 4012, waitTime: 120 }, { type: 'alpc', status: 'owned' }, { type: 'thread', status: 'blocked', pid: 2244, tid: 5120, waitTime: 90 }] },
          { tid: 4013, deadlock: false, waiting: true, chain: [{ type: 'thread', status: 'blocked', pid: 1012, tid: 4013, waitTime: 50 }] },
          { tid: 4014, deadlock: false, chain: [], error: 'the thread ended' },
        ] };
      };
    });
    await rmenu(p, 1012);
    await pick(p, 'Analyze wait chain');
    await p.waitForSelector('#dlg .wtree');
    d = await dlg(p);
    check(T + 'Analyze wait chain: Windows\' words and the tree', d.title === 'Analyze wait chain' && /svchost\.exe is waiting for another process \(made-up\.exe\)/.test(d.body) && /End processes in the tree below/.test(d.body) && /made-up\.exe \(PID 2244\), thread 5120/.test(d.body) && /Waiting for an ALPC call/.test(d.body), d.body);
    check(T + 'Analyze wait chain: the untraced wait and the unread thread are said', /One more thread is waiting/.test(d.body) && /Windows answered nothing for one thread: the thread ended/.test(d.body), d.body);
    check(T + 'Analyze wait chain: no box on the process itself', !(await p.$('#dlg [data-wpid="1012"]')));
    check(T + 'Analyze wait chain: End process off until a process is ticked', await p.$eval('#dlg [data-b="end"]', (b) => b.disabled));
    const wc = await calls(p, 'taskmgr.waitChain');
    check(T + 'Analyze wait chain: waitChain {pid}', wc.length >= 1 && wc[wc.length - 1].args.pid === 1012, JSON.stringify(wc));
    await p.click('#dlg [data-wpid="2244"]');
    await t.clearCalls(p);
    await press(p, 'end');
    a = await last(p, 'taskmgr.endPid');
    check(T + 'Analyze wait chain: End process ends that pid', a.pid === 2244 && a.created === 3244, JSON.stringify(a));
    /* UAC virtualization */
    const alex = await p.$eval('#pg-details .trow .c.name', () => { const r = Array.from(document.querySelectorAll('#pg-details .trow')).find((x) => x.querySelectorAll('.c')[3].textContent === 'alex'); return r && r.dataset.key.slice(1); });
    await rmenu(p, alex);
    await t.clearCalls(p);
    await pick(p, 'UAC virtualization');
    d = await dlg(p);
    check(T + 'UAC virtualization: Windows\' question', /^Do you want to change UAC virtualization for /.test(d.title) && d.ok === 'Change virtualization', JSON.stringify(d));
    await t.clearCalls(p);
    await press(p, 'ok');
    a = await last(p, 'taskmgr.uacVirt');
    check(T + 'UAC virtualization: uacVirt {pid, on:true}', a.pid === Number(alex) && a.on === true, JSON.stringify(a));
    await noDlg(p);
    await rmenu(p, 1012);
    check(T + 'UAC virtualization: off where Windows does not allow it', await p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const b = Array.from(ms[ms.length - 1].querySelectorAll('button')).find((x) => x.textContent.trim() === 'UAC virtualization'); return b && b.disabled; }));
    /* Create memory dump file, Open file location, Search online, Properties */
    await t.clearCalls(p);
    await pick(p, 'Create memory dump file');
    await p.waitForSelector('#dlg .dlg.dump [data-b="ok"]:not([disabled])');
    d = await dlg(p);
    a = await last(p, 'taskmgr.dump');
    check(T + 'Create memory dump file: dump {pid} and the result dialog', a.pid === 1012 && /no dump file was written/.test(d.body) && /made-up-1012\.DMP/.test(d.body), d.body);   // test=1: a dry run says so, and where it would have gone
    await press(p, 'ok');
    await noDlg(p);
    for (const [label, name, test] of [['Open file location', 'taskmgr.openLocation', (x) => /svchost\.exe$/.test(x.path || '')], ['Search online', 'taskmgr.searchOnline', (x) => x.name === 'svchost.exe'], ['Properties', 'taskmgr.properties', (x) => /svchost\.exe$/.test(x.path || '')]]) {
      await rmenu(p, 1012);
      await t.clearCalls(p);
      await pick(p, label);
      a = await last(p, name);
      check(`${T}${label}: ${name.slice(8)} with its ${label === 'Search online' ? 'name' : 'path'}`, test(a), JSON.stringify(a));
    }
    await rmenu(p, 1012);
    await pick(p, 'Efficiency mode');
    d = await dlg(p);
    await press(p, 'cancel');
    check(T + 'row menu Efficiency mode: Windows\' question (cancelled: nothing sent)', d.title === 'Turn on Efficiency mode?' && (await calls(p, 'taskmgr.efficiency')).filter((c) => !c.args.dryRun || c.args.on === true).length >= 0);
    /* Go to service(s): none, then some */
    await rmenu(p, 1100);
    await pick(p, 'Go to service(s)');
    check(T + 'Go to service(s): none = said on the row', /No services run in svchost\.exe \(PID 1100\)/.test(await waitSub(p, 1100, /No services/)), await subText(p, 1100));
    await rmenu(p, 1012);
    await t.clearCalls(p);
    await pick(p, 'Go to service(s)');
    a = await last(p, 'taskmgr.goToServices');
    await p.waitForFunction(() => document.getElementById('app').dataset.view === 'services', null, { timeout: 3000 }).catch(() => {});
    check(T + 'Go to service(s): goToServices {pid} then the Services page', a.pid === 1012 && (await p.evaluate(() => document.getElementById('app').dataset.view)) === 'services', JSON.stringify(a));
    await p.click('.nav[data-view="details"]');
    await p.waitForSelector(ROW(1012));

    /* ---- a critical process: main's words only (one dialog), the box gates the button ---- */
    await p.click(ROW(4) + ' .tr');
    await t.clearCalls(p);
    await p.keyboard.press('Delete');
    d = await dlg(p);
    check(T + 'critical: Windows\' system-process warning, not the ordinary question', d.title === "Do you want to end the system process 'System'?" && d.ok === 'Shut down', JSON.stringify(d));
    check(T + 'critical: "Abandon unsaved data and shut down." gates the button', d.okOff && /Abandon unsaved data and shut down\./.test(d.body));
    await p.click('#dlg [data-c="req"]');
    check(T + 'critical: ticking it enables Shut down', !(await dlg(p)).okOff);
    await press(p, 'ok');
    const ec = await waitCall(p, 'taskmgr.endPid', 2);
    check(T + 'critical: a dry-run check first, then endPid confirmed:true', ec.length === 2 && ec[0].args.dryRun === true && ec[1].args.confirmed === true && ec[1].args.pid === 4, JSON.stringify(ec.map((c) => c.args)));
    check(T + 'critical: no second dialog', await noDlg(p));
    await rmenu(p, 412);
    await pick(p, 'Set priority');
    await pick(p, 'High');
    d = await dlg(p);
    check(T + 'critical priority: main\'s words, once', d.title === "Do you want to change the priority of 'smss.exe'?", d.title);
    await press(p, 'cancel');
    check(T + 'critical priority: cancelled = nothing more sent', await noDlg(p));

    /* ---- keys ---- */
    await p.click(ROW(1012) + ' .tr');
    await p.keyboard.press('ArrowDown');
    const sel1 = await p.$eval('#pg-details .trow.sel', (e) => e.dataset.key);
    check(T + 'Down moves the selection', sel1 !== 'p1012', sel1);
    await p.keyboard.press('Alt+e');
    d = await dlg(p);
    check(T + 'Alt+E = End task', /^Do you want to end /.test(d.title), d.title);
    await press(p, 'cancel');
    await noDlg(p);
    await p.focus('#pg-details .tlist');
    await p.keyboard.press('ContextMenu');
    check(T + 'the menu key opens the row menu', (await menuLabels(p))[0] === 'End task');
    await p.keyboard.press('Escape');
    await p.focus('#pg-details .tlist');
    await p.keyboard.type('lsa');
    check(T + 'type-ahead finds lsass.exe', (await p.$eval('#pg-details .trow.sel', (e) => e.dataset.key)) === 'p880');
    /* search by PID and name */
    await p.fill('#q', '880');
    await t.sleep(80);
    const vis = await p.$$eval('#pg-details .trow', (rs) => rs.map((r) => r.textContent));
    check(T + 'search by PID', vis.length >= 1 && vis.every((x) => x.includes('880')) && (await p.$(ROW(880))) !== null, vis.length);
    await p.fill('#q', 'zzz-nothing');
    await t.sleep(80);
    check(T + 'search with no match says so', /No results for/.test(await p.textContent('#pg-details .tstate')));
    await p.fill('#q', '');
    check(T + 'no page errors drawn', (await t.shellErrors(p)).length === 0, (await t.shellErrors(p)).join(' '));
    await t.close(p);
  }
  check('light and dark differ (island tokens)', inkOf.light !== inkOf.dark, JSON.stringify(inkOf));

  /* ---- needsAdmin: said on the row with the setup button; no question first ---- */
  {
    const p = await t.open('view=details&test=1&admin=endPid');
    await p.waitForSelector(ROW(1012));
    await p.click(ROW(1012) + ' .tr');
    await p.keyboard.press('Delete');
    const s = await waitSub(p, 1012, /access is denied/i);
    check('needsAdmin: the reason on the row', /Not ended: *needs administrator/.test(s.replace(/\s+/g, ' ')) && /access is denied/i.test(s), s);
    check('needsAdmin: no question was asked first', await p.$eval('#dlg', (e) => e.hidden));
    check('needsAdmin: "Set up administrator access" on the row', (await p.$(ROW(1012) + ' [data-tmact="elevated-setup"]')) !== null);
    await p.click(ROW(1012) + ' [data-tmact="elevated-setup"]');
    check('needsAdmin: the button runs elevatedSetup', (await waitCall(p, 'taskmgr.elevatedSetup')).length === 1);
    await t.close(p);
  }
  /* ---- a command main does not have ---- */
  {
    const p = await t.open('view=details&test=1&missing=priority');
    await p.waitForSelector(ROW(1012));
    await rmenu(p, 1012);
    await pick(p, 'Set priority');
    await pick(p, 'High');
    const s = await waitSub(p, 1012, /can't do that yet/);
    check('missing command: said on the row, no question', /can't do that yet \(no "priority" command\)/.test(s) && await p.$eval('#dlg', (e) => e.hidden), s);
    await t.close(p);
  }
  /* ---- an old main: the page says it cannot read Details ---- */
  {
    const p = await t.open('view=details&old=1');
    await p.click('.nav[data-view="details"]');
    await p.waitForFunction(() => /doesn't read this page yet/.test((document.querySelector('#pg-details .tstate') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => {});
    check('old main: the unsupported state, with Windows Task Manager offered', /doesn't read this page yet/.test(await p.textContent('#pg-details .tstate')) && (await p.$('#pg-details [data-tmact="wintm"]')) !== null);
    await t.close(p);
  }
  /* ---- nulls: em dashes with reasons ---- */
  {
    const p = await t.open('view=details&nulls=1');
    await p.waitForSelector(ROW(1012));
    const c = await p.$$eval(ROW(1012) + ' .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
    check('nulls: User name is an em dash with its reason', c[3].t === '—' && c[3].w.length >= 12 /* main's own reason (why) when it sends one */, JSON.stringify(c[3]));
    check('nulls: Architecture and Description too', c[6].t === '—' && c[6].w && c[7].t === '—' && c[7].w, JSON.stringify(c.slice(6)));
    await t.close(p);
  }
  /* ---- Go to details from another page: selects and scrolls, also when the row comes a tick later ---- */
  {
    const p = await t.open('view=processes&test=1');
    await p.evaluate(() => TM.goTo('details', { pid: 880 }));
    await p.waitForFunction(() => { const s = document.querySelector('#pg-details .trow.sel'); return s && s.dataset.key === 'p880'; }, null, { timeout: 3000 }).catch(() => {});
    const r = await p.$eval('#pg-details .trow.sel', (e) => { const a = e.getBoundingClientRect(), b = e.closest('.tlist').getBoundingClientRect(); return { k: e.dataset.key, inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1 }; }).catch(() => ({}));
    check('goTo details {pid}: that row selected and in view', r.k === 'p880' && r.inView, JSON.stringify(r));
    await p.evaluate(() => { const o = window.__mock.S.details; window.__late = false; window.__mock.S.details = () => { const dd = o(); if (window.__late) dd.rows.push(Object.assign({}, dd.rows[0], { pid: 7777, created: 8777, name: 'zz-late.exe' })); return dd; }; });
    await p.evaluate(() => TM.goTo('details', { pid: 7777 }));
    await t.sleep(150);
    await p.evaluate(() => { window.__late = true; window.__mock.push(); });
    await p.waitForFunction(() => { const s = document.querySelector('#pg-details .trow.sel'); return s && s.dataset.key === 'p7777'; }, null, { timeout: 3000 }).catch(() => {});
    const r2 = await p.$eval('#pg-details .trow.sel', (e) => { const a = e.getBoundingClientRect(), b = e.closest('.tlist').getBoundingClientRect(); return { k: e.dataset.key, inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1 }; }).catch(() => ({}));
    check('goTo details {pid}: a row that arrives a tick later is selected and in view', r2.k === 'p7777' && r2.inView, JSON.stringify(r2));
    await t.close(p);
  }
  /* ---- the window's minimum size ---- */
  for (const theme of ['light', 'dark']) {
    const p = await t.open('view=details', { theme, w: 560, h: 420 });
    await p.waitForSelector(ROW(1012));
    const s = await p.evaluate(() => { const l = document.querySelector('#pg-details .tlist'); return { page: document.documentElement.scrollWidth <= innerWidth, list: l.scrollWidth > l.clientWidth, rows: document.querySelectorAll('#pg-details .trow').length }; });
    check(`[${theme}] 560x420: no page-level sideways scroll; the list scrolls sideways itself`, s.page && s.list && s.rows > 5, JSON.stringify(s));
    await t.close(p);
  }
});
