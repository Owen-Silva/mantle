/* pages/users.page.test.js - Windows' Users page, clicked through on the MOCK (ui/taskmgr/testkit.js: headless
 * Chromium over file://, never Electron; every user, process and number is made up).
 * SAFETY: Sign off and Disconnect on the real machine would end or lock Owen's session. Every action here is a
 * dry run (test=1); the last check proves EVERY user command the page sent carried dryRun:true.
 *   node ui/taskmgr/pages/users.page.test.js   ->  "TASKMGR USERS PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const PG = '#pg-users';
const UROW = (s) => `${PG} .trow[data-key="u${s}"]`;
const DEF = ['User', 'Status', 'CPU', 'Memory', 'Disk', 'Network'];
const USERCMDS = ['taskmgr.userSignOff', 'taskmgr.userDisconnect', 'taskmgr.userConnect'];

kit.run('TASKMGR USERS PAGE TEST', async (t) => {
  const { check, calls } = t;
  const sent = [];       // every user command from every page opened, for the closing safety check
  const heads = (p) => p.$$eval(`${PG} .thead .h`, (hs) => hs.map((h) => h.querySelector('.hl').textContent.trim()));
  const menuItems = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => ({ l: b.querySelector('span').textContent, off: b.disabled, tip: b.title })) : []; });
  const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (!b || b.disabled) return false; b.click(); return true; }, label);
  const rmenu = async (p, sel) => { await p.click(sel + ' > .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const dlg = async (p) => { await p.waitForSelector('#dlg .dlg'); return p.$eval('#dlg .dlg', (d) => ({ title: d.querySelector('#dlgt').textContent, body: d.querySelector('.dbody').textContent, ok: (d.querySelector('[data-b="ok"]') || {}).textContent, focus: document.activeElement && document.activeElement.dataset.b })); };
  const press = (p, id) => p.click(`#dlg .dfoot [data-b="${id}"]`);
  const noDlg = (p) => p.waitForFunction(() => document.getElementById('dlg').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  const waitCall = async (p, name, n) => { for (let i = 0; i < 60; i++) { const c = await calls(p, name); if (c.length >= (n || 1)) return c; await t.sleep(50); } return calls(p, name); };
  const subText = (p, sel) => p.$eval(sel + ' > .tsub', (e) => e.textContent).catch(() => '');
  const waitSub = async (p, sel, re) => { for (let i = 0; i < 60; i++) { const s = await subText(p, sel); if (re.test(s)) return s; await t.sleep(50); } return subText(p, sel); };
  const collect = async (p) => { for (const n of USERCMDS) for (const c of await calls(p, n)) sent.push(c); };
  const close = async (p) => { await collect(p); await t.close(p); };
  const open = async (q, o) => { const p = await t.open(q, o); await p.waitForSelector(UROW(1)); return p; };
  const cmd = (label) => `#cmdbar button[aria-label="${label}"]`;
  const ink = {};

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await open('view=users&test=1', { theme });
    ink[theme] = await p.$eval(UROW(1) + ' .c.name .n', (e) => getComputedStyle(e).color);

    /* ---- the list ---- */
    check(T + "default columns are Windows'", (await heads(p)).join('|') === DEF.join('|'), (await heads(p)).join('|'));
    const tots = await p.$$eval(`${PG} .thead .tv`, (vs) => vs.map((v) => v.textContent));
    check(T + 'totals over CPU, Memory, Disk, Network (as on Processes)', tots.join('|') === '23%|66%|3%|1%', tots.join('|'));
    const nm = await p.$eval(UROW(1) + ' .c.name', (c) => c.textContent);
    check(T + 'a user: "<name> (<processes>)"', /^alex\s*\(\d+\)$/.test(nm), nm);
    const u2 = await p.$$eval(UROW(2) + ' > .tr .c', (cs) => cs.map((c) => c.textContent));
    check(T + 'a disconnected user: Status "Disconnected"', u2[1] === 'Disconnected', u2.join('|'));
    check(T + 'heat shading on the numbers', (await p.$$(`${PG} .trow .c.h1, ${PG} .trow .c.h2, ${PG} .trow .c.h3, ${PG} .trow .c.h4, ${PG} .trow .c.h5`)).length > 0);
    check(T + 'no sideways scroll on the page at 1280', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    /* ---- expand to the user's processes ---- */
    await p.click(UROW(1) + ' [data-act="expand"]');
    await p.waitForSelector(`${PG} .trow.child`, { timeout: 3000 }).catch(() => {});
    const kids = await p.$$eval(`${PG} .trow.child`, (rs) => rs.map((r) => r.dataset.key));
    check(T + "expand: the user's processes under them", kids.length > 3 && kids.every((k) => /^u1>p\d+$/.test(k)), kids.slice(0, 3).join(','));
    const kid = `${PG} .trow[data-key="${kids[0]}"]`;

    /* ---- Settings > Show full account name ---- */
    await p.evaluate(() => { window.__mock.S.settings.fullAccountName = true; window.__mock.push(); });
    await p.waitForFunction(() => /Alex Made-Up/.test(document.querySelector('#pg-users .trow[data-key="u1"] .c.name').textContent), null, { timeout: 3000 }).catch(() => {});
    check(T + 'fullAccountName: the full name shows', /^Alex Made-Up\s*\(\d+\)$/.test(await p.$eval(UROW(1) + ' .c.name', (c) => c.textContent)));
    await p.evaluate(() => { window.__mock.S.settings.fullAccountName = false; window.__mock.push(); });

    /* ---- header right-click: Windows' columns ---- */
    await p.click(`${PG} .thead .h[data-col="cpu"]`, { button: 'right' });
    const hm = (await menuItems(p)).map((x) => x.l);
    check(T + 'header menu: ID, Session, Client name, GPU, GPU engine', ['ID', 'Session', 'Client name', 'GPU', 'GPU engine'].every((w) => hm.includes(w)), hm.join('|'));
    await pick(p, 'GPU');
    check(T + 'header menu adds GPU (with its total)', (await heads(p)).includes('GPU'));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.users'));

    /* ---- the user row menu ---- */
    await rmenu(p, UROW(1));
    let mi = await menuItems(p);
    check(T + "user menu: Windows' items", mi.map((x) => x.l).join('|') === 'Collapse|Connect|Disconnect|Sign off|Manage user accounts', mi.map((x) => x.l).join('|'));
    check(T + 'Connect is off on your own session, with why', mi[1] && mi[1].off && /your own session/.test(mi[1].tip), JSON.stringify(mi[1]));

    /* Sign off: Windows' exact warning; Cancel sends nothing real */
    await t.clearCalls(p);
    await pick(p, 'Sign off');
    let d = await dlg(p);
    check(T + "Sign off: Windows' exact warning", d.title === 'Sign out user' && d.body.trim() === 'Do you want to sign out alex? Any unsaved data for the user may be lost.' && d.ok === 'Sign out user' /* main's needsConfirm words (sidecar Users.cs) */, JSON.stringify(d));
    check(T + 'Sign off: Cancel has the focus', d.focus === 'cancel', d.focus);
    await press(p, 'cancel');
    await noDlg(p);
    let so = await calls(p, 'taskmgr.userSignOff');
    check(T + 'Sign off cancelled: only the dry-run preflight was sent', so.length === 1 && so[0].args.dryRun === true && so[0].args.session === 1, JSON.stringify(so));
    await collect(p); await t.sleep(200); await t.clearCalls(p);   // one request per process at a time: let End task's answer come back
    await rmenu(p, UROW(1));
    await pick(p, 'Sign off');
    await dlg(p);
    await press(p, 'ok');
    await noDlg(p);
    so = await waitCall(p, 'taskmgr.userSignOff', 2);
    check(T + 'Sign off confirmed: sent again with confirmed:true (as a dry run) for session 1', so.length === 2 && so[1].args.session === 1 && so[1].args.dryRun === true && so[1].args.confirmed === true, JSON.stringify(so));
    check(T + 'Sign off: the outcome on the row', /Test Mantle/.test(await waitSub(p, UROW(1), /Test Mantle/)));

    /* Disconnect from the command bar: Windows' question */
    await collect(p); await t.sleep(200); await t.clearCalls(p);   // one request per process at a time: let End task's answer come back
    await p.click(UROW(1) + ' > .tr');
    await p.click(cmd('Disconnect'));
    d = await dlg(p);
    check(T + "Disconnect: Windows' question", d.title === 'Disconnect user' && d.body.trim() === 'Do you want to disconnect alex?' && d.ok === 'Disconnect user', JSON.stringify(d));
    await press(p, 'ok');
    await noDlg(p);
    const dc = await waitCall(p, 'taskmgr.userDisconnect', 2);
    check(T + 'Disconnect: preflight + the dry run for session 1', dc.length === 2 && dc.every((c) => c.args.dryRun === true && c.args.session === 1), JSON.stringify(dc));

    /* a disconnected user: Disconnect off, Connect on (no question; dry run) */
    await rmenu(p, UROW(2));
    mi = await menuItems(p);
    check(T + 'a disconnected user: Disconnect is off with why', mi[2] && mi[2].off && /already disconnected/.test(mi[2].tip), JSON.stringify(mi[2]));
    await pick(p, 'Connect');
    const cn = await waitCall(p, 'taskmgr.userConnect', 2);
    check(T + 'Connect: preflight + the dry run for session 2', cn.length === 2 && cn.every((c) => c.args.dryRun === true && c.args.session === 2), JSON.stringify(cn));
    check(T + 'Connect: no dialog', await p.evaluate(() => document.getElementById('dlg').hidden));
    check(T + 'Connect: the outcome on the row', /Test Mantle/.test(await waitSub(p, UROW(2), /Test Mantle/)));
    await p.click(UROW(2) + ' > .tr');
    check(T + 'command bar Disconnect is off for a disconnected user', await p.$eval(cmd('Disconnect'), (b) => b.disabled));

    /* Manage user accounts */
    await p.click(cmd('Manage user accounts'));
    check(T + 'Manage user accounts: asked of Mantle', (await waitCall(p, 'taskmgr.manageUsers')).length === 1);

    /* ---- a process row ---- */
    await rmenu(p, kid);
    mi = await menuItems(p);
    check(T + 'process menu: End task, Go to details, Open file location, Search online, Properties', mi.map((x) => x.l).join('|') === 'End task|Go to details|Open file location|Search online|Properties', mi.map((x) => x.l).join('|'));
    await pick(p, 'End task');
    const ep = (await waitCall(p, 'taskmgr.endPid')).pop();
    check(T + 'End task: endPid for that pid, a dry run', ep && ('p' + ep.args.pid) === kids[0].split('>')[1] && ep.args.dryRun === true, JSON.stringify(ep));
    await collect(p); await t.sleep(200); await t.clearCalls(p);   // one request per process at a time: let End task's answer come back
    await p.click(kid + ' > .tr');
    await p.keyboard.press('Delete');
    check(T + 'Delete on a process: End task', (await waitCall(p, 'taskmgr.endPid')).length === 1);
    await p.click(UROW(1) + ' > .tr');
    await p.keyboard.press('Delete');
    await t.sleep(150);
    check(T + 'Delete on a user does nothing', (await calls(p, 'taskmgr.endPid')).length === 1 && (await calls(p, 'taskmgr.userSignOff')).length === 0);
    await rmenu(p, kid);
    await pick(p, 'Go to details');
    await p.waitForFunction(() => document.getElementById('app').dataset.view === 'details', null, { timeout: 3000 }).catch(() => {});
    check(T + 'Go to details: the Details page', await p.evaluate(() => document.getElementById('app').dataset.view === 'details'));
    await p.evaluate(() => TM.goTo('users'));
    await p.waitForSelector(UROW(1));

    /* ---- search ---- */
    await p.fill('#q', 'jordan');
    await t.sleep(100);
    let keys = await p.$$eval(`${PG} .trow:not(.child)`, (rs) => rs.map((r) => r.dataset.key));
    check(T + 'search by user name', keys.join(',') === 'u2', keys.join(','));
    await p.fill('#q', 'Made-up Notes');
    await t.sleep(100);
    keys = await p.$$eval(`${PG} .trow`, (rs) => rs.map((r) => r.dataset.key));
    check(T + 'search by a process name: its user, open, with only that process', keys.join(',') === 'u2,u2>p5120', keys.join(','));
    await p.fill('#q', 'zzz');
    await t.sleep(100);
    check(T + 'no match: Clear search', !!(await p.$(`${PG} .tstate [data-tmact="clearq"]`)));
    await p.fill('#q', '');
    check(T + 'no page errors drawn', (await t.shellErrors(p)).length === 0, (await t.shellErrors(p)).join('\n'));
    await close(p);
  }
  check('light and dark differ (tokens follow the theme)', ink.light && ink.dark && ink.light !== ink.dark, JSON.stringify(ink));

  /* ---- needsConfirm from main: ITS dialog only, then confirmed ---- */
  {
    const p = await open('view=users&test=1');
    await p.evaluate(() => {
      const orig = window.mantle.call.bind(window.mantle);
      window.mantle.call = (name, args) => {
        if (name === 'taskmgr.userSignOff' && !(args || {}).confirmed) { window.__mockCalls.push({ name, args }); return Promise.resolve({ ok: false, needsConfirm: true, title: 'Made-up title from main', text: 'Made-up words from main.', check: 'Made-up box to tick.', button: 'Sign out' }); }
        return orig(name, args);
      };
    });
    await rmenu(p, UROW(1));
    await pick(p, 'Sign off');
    const d = await dlg(p);
    check("needsConfirm: main's dialog, not Windows' ordinary one", d.title === 'Made-up title from main' && d.ok === 'Sign out', JSON.stringify(d));
    check('needsConfirm: its box must be ticked first', await p.$eval('#dlg [data-b="ok"]', (b) => b.disabled));
    await p.click('#dlg [data-c="req"]');
    await press(p, 'ok');
    await noDlg(p);
    const so = await waitCall(p, 'taskmgr.userSignOff', 2);
    check('needsConfirm: then sent once with confirmed (a dry run)', so.length === 2 && so[1].args.confirmed === true && so[1].args.dryRun === true, JSON.stringify(so));
    check('needsConfirm: exactly one dialog was shown', await p.evaluate(() => document.getElementById('dlg').hidden));
    await close(p);
  }
  /* ---- needsAdmin: said on the row with Set up administrator access, no question ---- */
  {
    const p = await open('view=users&test=1&admin=userSignOff,userDisconnect');
    await rmenu(p, UROW(1));
    await pick(p, 'Sign off');
    await p.waitForSelector(UROW(1) + ' [data-tmact="elevated-setup"]', { timeout: 3000 }).catch(() => {});
    check('needsAdmin (Sign off): on the row with Set up administrator access', !!(await p.$(UROW(1) + ' [data-tmact="elevated-setup"]')));
    check('needsAdmin (Sign off): no dialog', await p.evaluate(() => document.getElementById('dlg').hidden));
    check('needsAdmin (Sign off): only the preflight was sent', (await calls(p, 'taskmgr.userSignOff')).length === 1);
    await close(p);
  }
  {
    const p = await open('view=users&test=1&elev=ok&admin=userDisconnect');
    await rmenu(p, UROW(1));
    await pick(p, 'Disconnect');
    await t.sleep(300);
    const s = await subText(p, UROW(1));
    check('needsAdmin with the helper set up: the reason, no setup button', /access is denied/i.test(s) && !(await p.$(UROW(1) + ' [data-tmact="elevated-setup"]')), s);
    await close(p);
  }
  /* ---- a failure and a missing command: said on the row ---- */
  {
    const p = await open('view=users&test=1&fail=userDisconnect&missing=userConnect');
    await rmenu(p, UROW(1));
    await pick(p, 'Disconnect');
    check('a failure: on the row with its reason', /was not disconnected: Made-up failure/.test(await waitSub(p, UROW(1), /Made-up/)));
    await rmenu(p, UROW(2));
    await pick(p, 'Connect');
    check('no such command: said plainly on the row', /can't do that yet/.test(await waitSub(p, UROW(2), /yet/)));
    await close(p);
  }
  /* ---- nulls: em dashes with their reasons ---- */
  {
    const p = await open('view=users&nulls=1');
    const c = await p.$$eval(UROW(1) + ' > .tr .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
    check('nulls: Disk is an em dash with why', c[4].t === '—' && /not measured/.test(c[4].w), JSON.stringify(c[4]));
    check('nulls: Network is an em dash with why', c[5].t === '—' && /administrator/.test(c[5].w), JSON.stringify(c[5]));
    const tv = await p.$eval(`${PG} .thead .h[data-col="disk"] .tv`, (e) => ({ t: e.textContent, w: e.title })).catch(() => null);
    check('nulls: the Disk total is an em dash with why', tv && tv.t === '—' && tv.w.length >= 12 /* main's own why when it sends one */, JSON.stringify(tv));
    await p.evaluate(() => { window.__mock.S.settings.fullAccountName = true; window.__mock.push(); });
    await t.sleep(200);
    const n = await p.$eval(UROW(1) + ' .c.name .n', (e) => ({ t: e.textContent, w: e.title }));
    check('nulls: no full name = the user name, and the tooltip says why', n.t === 'alex' && /full name/.test(n.w), JSON.stringify(n));
    await close(p);
  }
  /* ---- the window's minimum size ---- */
  for (const theme of ['light', 'dark']) {
    const p = await open('view=users', { theme, w: 560, h: 420 });
    const s = await p.evaluate(() => ({ page: document.documentElement.scrollWidth <= innerWidth, rows: document.querySelectorAll('#pg-users .trow').length }));
    check(`[${theme}] 560x420: no page-level sideways scroll, rows drawn`, s.page && s.rows >= 2, JSON.stringify(s));
    await close(p);
  }
  /* ---- SAFETY: nothing real was ever asked ---- */
  check('SAFETY: every Sign off / Disconnect / Connect sent was a dry run', sent.length > 0 && sent.every((c) => c.args.dryRun === true), JSON.stringify(sent.filter((c) => c.args.dryRun !== true)));
});
