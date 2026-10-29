/* pages/services.page.test.js - Windows' Services page, clicked and typed through on the MOCK
 * (ui/taskmgr/testkit.js: headless Chromium over file://, never Electron, never a real service; every service
 * row is made up). Every action is a dry run (test=1) and is checked in window.__mockCalls.
 *   node ui/taskmgr/pages/services.page.test.js   ->  "TASKMGR SERVICES PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const ROW = (name) => `#pg-services .trow[data-key="v${name}"]`;
const DEF = ['Name', 'PID', 'Description', 'Status', 'Group'];
const MENU = ['Start', 'Stop', 'Restart', 'Open Services', 'Search online', 'Go to details'];

kit.run('TASKMGR SERVICES PAGE TEST', async (t) => {
  const { check, calls } = t;
  const heads = (p) => p.$$eval('#pg-services .thead .h', (hs) => hs.map((h) => h.querySelector('.hl').textContent.trim()));
  const menuItems = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => ({ l: b.querySelector('span').textContent, off: b.disabled })) : []; });
  const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (!b || b.disabled) return false; b.click(); return true; }, label);
  const rmenu = async (p, name) => { await p.click(ROW(name) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const dlg = async (p) => { await p.waitForSelector('#dlg .dlg'); return p.$eval('#dlg .dlg', (d) => ({ title: d.querySelector('#dlgt').textContent, body: d.querySelector('.dbody').textContent, ok: (d.querySelector('[data-b="ok"]') || {}).textContent, okOff: !!(d.querySelector('[data-b="ok"]') || {}).disabled })); };
  const noDlg = (p) => p.waitForFunction(() => document.getElementById('dlg').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  const waitCall = async (p, name, n) => { for (let i = 0; i < 60; i++) { const c = await calls(p, name); if (c.length >= (n || 1)) return c; await t.sleep(50); } return calls(p, name); };
  const last = async (p, name, n) => { const c = await waitCall(p, name, n); return c.length ? c[c.length - 1].args : {}; };
  const subText = (p, name) => p.$eval(ROW(name) + ' .tsub', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
  const waitSub = async (p, name, re) => { for (let i = 0; i < 60; i++) { const s = await subText(p, name); if (re.test(s)) return s; await t.sleep(50); } return subText(p, name); };
  const cells = (p, name) => p.$$eval(ROW(name) + ' .c', (cs) => cs.map((c) => c.textContent));
  const btns = (p) => p.$$eval('#cmdbar .cbtn', (bs) => bs.map((b) => ({ l: b.getAttribute('aria-label'), off: b.disabled, title: b.title })));
  const offOf = async (p) => { const o = {}; for (const b of await btns(p)) o[b.l] = b.off; return o; };
  const sel = (p) => p.$eval('#pg-services .trow.sel', (e) => e.dataset.key).catch(() => null);
  const inkOf = {};

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await t.open('view=services&test=1', { theme });
    await p.waitForSelector(ROW('AudioSrv'));
    inkOf[theme] = await p.$eval('#pg-services .tlist', (e) => getComputedStyle(e).color);

    /* ---- the list ---- */
    check(T + 'columns are Windows\' five', (await heads(p)).join('|') === DEF.join('|'), (await heads(p)).join('|'));
    check(T + 'every service drawn', (await p.$$('#pg-services .trow')).length === 12);
    let c = await cells(p, 'AudioSrv');
    check(T + 'a row: short name, PID, display name as Description, Running, group', c.join('|') === 'AudioSrv|1100|Windows Audio|Running|LocalServiceNetworkRestricted', c.join('|'));
    check(T + 'the long description is the Description\'s tooltip', /Manages audio/.test(await p.$eval(ROW('AudioSrv') + ' .svd', (e) => e.title)));
    const bits = await p.$$eval(ROW('BITS') + ' .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
    check(T + 'a stopped service: PID em dash, "Not running" why', bits[1].t === '—' && /Not running/.test(bits[1].w) && bits[3].t === 'Stopped', JSON.stringify(bits.slice(0, 4)));
    const names = await p.$$eval('#pg-services .trow .c.name', (cs) => cs.map((x) => x.textContent.toLowerCase()));
    check(T + 'sorted by Name by default', names.every((n, i) => i === 0 || names[i - 1] <= n), names.join(','));
    await p.click('#pg-services .thead .h[data-col="status"]');
    const sts = await p.$$eval('#pg-services .trow .c:nth-child(4)', (cs) => cs.map((x) => x.textContent));
    check(T + 'the Status header sorts by status', sts.every((x, i) => i === 0 || sts[i - 1] <= x) || sts.every((x, i) => i === 0 || sts[i - 1] >= x), sts.join(','));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.services'));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await p.waitForSelector(ROW('AudioSrv'));
    check(T + 'no sideways scroll on the page at 1280', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    /* ---- command bar: enabled by the row's status, as Windows does ---- */
    let b = await btns(p);
    check(T + 'command bar: Run new task | Start | Stop | Restart | Open services', b.map((x) => x.l).join('|') === 'Run new task|Start|Stop|Restart|Open services', b.map((x) => x.l).join('|'));
    let off = await offOf(p);
    check(T + 'nothing chosen: Start, Stop, Restart off; Open services on', off.Start && off.Stop && off.Restart && !off['Open services'], JSON.stringify(off));
    await p.click(ROW('BITS') + ' .tr');
    off = await offOf(p);
    check(T + 'a stopped service: Start on, Stop and Restart off', !off.Start && off.Stop && off.Restart, JSON.stringify(off));
    check(T + 'a disabled button says why', /not running/.test((await btns(p)).find((x) => x.l === 'Stop').title));
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Start"]');
    let all = await waitCall(p, 'taskmgr.service', 2);
    check(T + 'Start: a dry-run preflight, then service {name, op:start}', all.length === 2 && all[0].args.dryRun === true && all[1].args.name === 'BITS' && all[1].args.op === 'start' && all[1].args.dryRun === true, JSON.stringify(all));
    check(T + 'Start: no dialog (Windows asks nothing)', await noDlg(p));
    check(T + 'Start: the dry run is said on the row', /Test Mantle/.test(await waitSub(p, 'BITS', /Test Mantle/)), await subText(p, 'BITS'));
    await p.click(ROW('AudioSrv') + ' .tr');
    off = await offOf(p);
    check(T + 'a running service: Start off, Stop and Restart on', off.Start && !off.Stop && !off.Restart, JSON.stringify(off));
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Stop"]');
    let a = await last(p, 'taskmgr.service', 2);
    check(T + 'Stop: service {name:AudioSrv, op:stop}', a.name === 'AudioSrv' && a.op === 'stop', JSON.stringify(a));
    await waitSub(p, 'AudioSrv', /Test Mantle/);
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Restart"]');
    a = await last(p, 'taskmgr.service', 2);
    check(T + 'Restart: service {name:AudioSrv, op:restart}', a.name === 'AudioSrv' && a.op === 'restart', JSON.stringify(a));
    await waitSub(p, 'AudioSrv', /Test Mantle/);
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Open services"]');
    check(T + 'Open services: openServices', (await waitCall(p, 'taskmgr.openServices')).length === 1);

    /* ---- the row menu, every item ---- */
    await rmenu(p, 'AudioSrv');
    let mi = await menuItems(p);
    check(T + 'row menu: Windows\' items in Windows\' order', mi.map((x) => x.l).join('|') === MENU.join('|'), mi.map((x) => x.l).join('|'));
    check(T + 'row menu on a running service: Start off, Stop/Restart/Go to details on', mi[0].off && !mi[1].off && !mi[2].off && !mi[5].off, JSON.stringify(mi));
    await t.clearCalls(p);
    await pick(p, 'Restart');
    a = await last(p, 'taskmgr.service', 2);
    check(T + 'menu Restart: op restart', a.name === 'AudioSrv' && a.op === 'restart');
    await waitSub(p, 'AudioSrv', /Test Mantle/);
    await rmenu(p, 'AudioSrv');
    await t.clearCalls(p);
    await pick(p, 'Stop');
    a = await last(p, 'taskmgr.service', 2);
    check(T + 'menu Stop: op stop', a.name === 'AudioSrv' && a.op === 'stop');
    await waitSub(p, 'AudioSrv', /Test Mantle/);
    await rmenu(p, 'wuauserv');
    mi = await menuItems(p);
    check(T + 'row menu on a stopped service: Start on, Stop/Restart/Go to details off', !mi[0].off && mi[1].off && mi[2].off && mi[5].off, JSON.stringify(mi));
    await t.clearCalls(p);
    await pick(p, 'Start');
    a = await last(p, 'taskmgr.service', 2);
    check(T + 'menu Start: op start', a.name === 'wuauserv' && a.op === 'start');
    await rmenu(p, 'wuauserv');
    await t.clearCalls(p);
    await pick(p, 'Open Services');
    check(T + 'menu Open Services: openServices', (await waitCall(p, 'taskmgr.openServices')).length === 1);
    await rmenu(p, 'wuauserv');
    await t.clearCalls(p);
    await pick(p, 'Search online');
    a = await last(p, 'taskmgr.searchOnline');
    check(T + 'Search online: the service name', a.name === 'wuauserv', JSON.stringify(a));

    /* ---- needsConfirm (critical service): main's words, one dialog, then confirmed:true ---- */
    await p.evaluate(() => {
      const call = window.mantle.call.bind(window.mantle);
      window.mantle.call = (name, args) => (name === 'taskmgr.service' && args.name === 'EventLog' && !args.confirmed
        ? (window.__mockCalls.push({ name, args }), Promise.resolve({ ok: false, needsConfirm: true, title: 'Do you want to stop Windows Event Log?', text: 'Windows needs this service (made-up words).', check: 'I understand.', button: 'Stop service' }))
        : call(name, args));
    });
    await rmenu(p, 'EventLog');
    await t.clearCalls(p);
    await pick(p, 'Stop');
    let d = await dlg(p);
    check(T + 'needsConfirm: main\'s question, its box must be ticked first', d.title === 'Do you want to stop Windows Event Log?' && d.ok === 'Stop service' && d.okOff, JSON.stringify(d));
    check(T + 'needsConfirm: the row is not "Stopping..." while it asks', !/Stopping/.test(await subText(p, 'EventLog')));
    await p.click('#dlg .dfoot [data-b="cancel"]');
    await noDlg(p);
    check(T + 'needsConfirm, Cancel: nothing sent after the preflight', (await calls(p, 'taskmgr.service')).length === 1 && !(await subText(p, 'EventLog')));
    await rmenu(p, 'EventLog');
    await pick(p, 'Stop');
    await dlg(p);
    await p.click('#dlg .dchk input');
    await t.clearCalls(p);
    await p.click('#dlg .dfoot [data-b="ok"]');
    a = await last(p, 'taskmgr.service');
    check(T + 'needsConfirm, OK: service goes with confirmed:true', a.name === 'EventLog' && a.op === 'stop' && a.confirmed === true, JSON.stringify(a));
    check(T + 'needsConfirm, OK: only that one dialog', await noDlg(p));

    /* ---- Go to details ---- */
    await rmenu(p, 'Spooler');
    await pick(p, 'Go to details');
    await p.waitForFunction(() => document.getElementById('app').dataset.view === 'details', null, { timeout: 3000 }).catch(() => null);
    check(T + 'Go to details opens Details', (await p.$eval('#app', (e) => e.dataset.view)) === 'details');
    const v = (await calls(p, 'taskmgr.view')).pop();
    check(T + 'Go to details: the view is sent to main', v && v.args.view === 'details');

    /* ---- arriving from Details' "Go to service(s)": those services chosen and scrolled to ---- */
    await p.evaluate(() => TM.goTo('services', { names: ['Dhcp', 'Dnscache', 'Themes'] }));
    await p.waitForSelector(ROW('Dhcp') + '.sel', { timeout: 3000 }).catch(() => null);
    check(T + 'from Details: the first of its services is chosen', (await sel(p)) === 'vDhcp', await sel(p));
    const hits = await p.$$eval('#pg-services .trow.svhit', (rs) => rs.map((r) => r.dataset.key).sort());
    check(T + 'from Details: all its services are marked', hits.join(',') === 'vDhcp,vDnscache,vThemes', hits.join(','));
    await p.click(ROW('vgc') + ' .tr');
    check(T + 'choosing another row clears the marks', !(await p.$$('#pg-services .trow.svhit')).length);
    await p.fill('#q', 'audio');
    await p.evaluate(() => TM.goTo('services', { names: ['Themes'] }));
    await p.waitForFunction(() => !document.getElementById('q').value, null, { timeout: 3000 }).catch(() => null);
    await p.waitForSelector(ROW('Themes') + '.sel', { timeout: 3000 }).catch(() => null);
    check(T + 'from Details while a search hides it: the search clears and it is chosen', (await sel(p)) === 'vThemes', await sel(p));

    /* ---- keyboard ---- */
    await p.click(ROW('AudioSrv') + ' .tr');
    await p.keyboard.press('ArrowDown');
    check(T + 'Down arrow chooses the next row', (await sel(p)) === 'vBITS', await sel(p));
    await p.keyboard.press('Home');
    check(T + 'Home chooses the first row', (await sel(p)) === 'vAudioSrv', await sel(p));
    await p.keyboard.type('wu');
    check(T + 'type-ahead finds wuauserv', (await sel(p)) === 'vwuauserv', await sel(p));
    await p.keyboard.press('Shift+F10');
    await p.waitForSelector('#menus .menu');
    check(T + 'Shift+F10 opens the row menu', (await menuItems(p))[0].l === 'Start');
    await p.keyboard.press('Escape');

    /* ---- search: name or PID ---- */
    await p.fill('#q', '1012');
    let shown = await p.$$eval('#pg-services .trow', (rs) => rs.map((r) => r.dataset.key).sort());
    check(T + 'search by PID 1012: the three services in it', shown.join(',') === 'vDhcp,vDnscache,vThemes', shown.join(','));
    await p.fill('#q', 'spool');
    shown = await p.$$eval('#pg-services .trow', (rs) => rs.map((r) => r.dataset.key));
    check(T + 'search by name finds Spooler', shown.join(',') === 'vSpooler', shown.join(','));
    await p.fill('#q', 'zzz-nothing');
    check(T + 'a search that hides everything says so', /No results/.test(await p.$eval('#pg-services .tstate', (e) => e.textContent).catch(() => '')));
    await p.fill('#q', '');
    check(T + 'no page errors drawn by the shell', !(await t.shellErrors(p)).length, (await t.shellErrors(p)).join(' '));
    await t.close(p);
  }
  check('light and dark draw the list in different ink', inkOf.light && inkOf.dark && inkOf.light !== inkOf.dark, JSON.stringify(inkOf));

  /* ---- needs admin: said on the row with "Set up administrator access"; the real call is never tried ---- */
  let p = await t.open('view=services&test=1&admin=service');
  await p.waitForSelector(ROW('Spooler'));
  await rmenu(p, 'Spooler');
  await pick(p, 'Stop');
  await p.waitForSelector(ROW('Spooler') + ' [data-tmact="elevated-setup"]', { timeout: 4000 }).catch(() => null);
  check('needsAdmin: the row says why and offers Set up administrator access', /Not stopped/.test(await subText(p, 'Spooler')) && !!(await p.$(ROW('Spooler') + ' [data-tmact="elevated-setup"]')), await subText(p, 'Spooler'));
  check('needsAdmin: only the preflight was sent', (await calls(p, 'taskmgr.service')).length === 1);
  await t.close(p);
  p = await t.open('view=services&test=1&admin=service&elev=ok');
  await p.waitForSelector(ROW('Spooler'));
  await rmenu(p, 'Spooler');
  await pick(p, 'Stop');
  await waitSub(p, 'Spooler', /administrator/);
  check('needsAdmin with the helper set up: the reason, no setup button', /administrator/.test(await subText(p, 'Spooler')) && !(await p.$(ROW('Spooler') + ' [data-tmact="elevated-setup"]')), await subText(p, 'Spooler'));
  await t.close(p);

  /* ---- a failure, and main's background outcome (lastOp) ---- */
  p = await t.open('view=services&test=1&fail=service');
  await p.waitForSelector(ROW('BITS'));
  await rmenu(p, 'BITS');
  await pick(p, 'Start');
  check('a failure is said on the row with its reason', /Not started: Made-up failure/.test(await waitSub(p, 'BITS', /Made-up/)), await subText(p, 'BITS'));
  await t.close(p);
  p = await t.open('view=services');
  await p.waitForSelector(ROW('AudioSrv'));
  await p.evaluate(() => {
    const S = window.__mock.S, base = S.services;
    S.services = () => { const d = base(); const now = Date.now();
      d.rows.find((r) => r.name === 'wuauserv').lastOp = { op: 'start', ok: false, reason: 'The service did not respond in time (made up).', at: now - 60000 };
      d.rows.find((r) => r.name === 'SysMain').lastOp = { op: 'restart', ok: true, reason: null, at: now - 1000 };
      d.rows.find((r) => r.name === 'Themes').lastOp = { op: 'stop', ok: true, reason: null, at: now - 600000 };
      d.rows.find((r) => r.name === 'WSearch').lastOp = { op: 'stop', ok: false, needsAdmin: true, reason: 'Access is denied (made up).', at: now - 5000 };
      return d; };
    window.__mock.push();
  });
  check('lastOp failed: said on the row with its reason', /Not started: The service did not respond/.test(await waitSub(p, 'wuauserv', /respond/)), await subText(p, 'wuauserv'));
  check('lastOp ok, just now: said on the row', (await waitSub(p, 'SysMain', /Restarted/)) === 'Restarted', await subText(p, 'SysMain'));
  check('lastOp ok, long ago: nothing to say', !(await subText(p, 'Themes')), await subText(p, 'Themes'));
  check('lastOp needs admin: the setup button on the row', !!(await p.$(ROW('WSearch') + ' [data-tmact="elevated-setup"]')), await subText(p, 'WSearch'));
  await t.close(p);

  /* ---- nulls: an em dash with the reason ---- */
  p = await t.open('view=services&nulls=1');
  await p.waitForSelector(ROW('AudioSrv'));
  const nil = await p.$$eval(ROW('AudioSrv') + ' .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
  check('nulls: no group = em dash + why', nil[4].t === '—' && /group/.test(nil[4].w), JSON.stringify(nil[4]));
  check('nulls: the display name still shows', nil[2].t === 'Windows Audio', JSON.stringify(nil[2]));
  await t.close(p);

  /* ---- an old Mantle, a read error ---- */
  p = await t.open('view=services&old=1');
  await p.click('.nav[data-view="services"]');
  await p.waitForFunction(() => /doesn't read this page yet/.test((document.querySelector('#pg-services .tstate') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => {});
  check('an old Mantle without services data says so', /doesn't read this page yet/.test(await p.$eval('#pg-services .tstate', (e) => e.textContent).catch(() => '')));
  await t.close(p);
  p = await t.open('view=services');
  await p.evaluate(() => { window.__mock.S.services = () => ({ rows: [], error: 'Made-up read error.' }); window.__mock.push(); });
  await p.waitForFunction(() => /Made-up read error/.test((document.querySelector('#pg-services .tstate') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => null);
  check('a read error is said in the list', /Made-up read error/.test(await p.$eval('#pg-services .tstate', (e) => e.textContent).catch(() => '')));
  await t.close(p);

  /* ---- 560x420: still usable ---- */
  p = await t.open('view=services', { w: 560, h: 420 });
  await p.waitForSelector(ROW('AudioSrv'));
  check('560x420: no sideways scroll on the page', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('560x420: the command bar still offers Start/Stop/Restart', (await btns(p)).length >= 2);
  await t.close(p);
});
