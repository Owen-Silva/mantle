/* pages/apphistory.page.test.js - Windows' App history page, clicked through on the MOCK (ui/taskmgr/testkit.js:
 * headless Chromium over file://, never Electron; every app and number is made up). Every action is a dry run
 * (test=1) and is checked in window.__mockCalls.
 *   node ui/taskmgr/pages/apphistory.page.test.js   ->  "TASKMGR APP HISTORY PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const PG = '#pg-apphistory';
// a row's key is 'a:' + lib's identity (a lower-cased path, a package name, or file:<exe>): find rows by their name
const NAMES = { 'google chrome': 'Google Chrome', discord: 'Discord', 'microsoft store': 'Microsoft Store', 'made-up-bgsvc': 'made-up-tool' };
const ROW = (id) => `${PG} .trow:has(.n:text-is("${NAMES[id] || id}"))`;
const DEF = ['Name', 'CPU time', 'Network', 'Metered network', 'Tile updates'];

kit.run('TASKMGR APP HISTORY PAGE TEST', async (t) => {
  const { check, calls } = t;
  const heads = (p) => p.$$eval(`${PG} .thead .h`, (hs) => hs.map((h) => h.querySelector('.hl').textContent.trim()));
  const menuItems = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => ({ l: b.querySelector('span').textContent, off: b.disabled, tip: b.title })) : []; });
  const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (!b || b.disabled) return false; b.click(); return true; }, label);
  const rmenu = async (p, id) => { await p.click(ROW(id) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const dlg = async (p) => { await p.waitForSelector('#dlg .dlg'); return p.$eval('#dlg .dlg', (d) => ({ title: d.querySelector('#dlgt').textContent, body: d.querySelector('.dbody').textContent, ok: (d.querySelector('[data-b="ok"]') || {}).textContent })); };
  const noDlg = (p) => p.waitForFunction(() => document.getElementById('dlg').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  const waitCall = async (p, name, n) => { for (let i = 0; i < 60; i++) { const c = await calls(p, name); if (c.length >= (n || 1)) return c; await t.sleep(50); } return calls(p, name); };
  const text = (p, sel) => p.$eval(sel, (e) => e.textContent).catch(() => '');
  const waitText = async (p, sel, re) => { for (let i = 0; i < 60; i++) { const s = await text(p, sel); if (re.test(s)) return s; await t.sleep(50); } return text(p, sel); };
  const clearBtn = `#cmdbar button[aria-label="Delete usage history"]`;
  const settle = (p) => p.waitForSelector(`${PG} .trow`);   // any row: the default list is the Store apps
  const ink = {};

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await t.open('view=apphistory&test=1', { theme });
    await settle(p);
    ink[theme] = await p.$eval(`${PG} .ahsince`, (e) => getComputedStyle(e).color);

    /* ---- the list and its line ---- */
    check(T + "default columns are Windows'", (await heads(p)).join('|') === DEF.join('|'), (await heads(p)).join('|'));
    const since = await text(p, `${PG} .ahsince`);
    check(T + "the line: Windows' words with the date", /^Resource usage since \d{1,2}\/\d{1,2}\/2026 for current user account\.$/.test(since), since);
    const src = await p.$eval(`${PG} .ahsrc`, (e) => ({ hidden: e.hidden, t: e.textContent, btn: !!e.querySelector('[data-tmact="elevated-setup"]') }));
    check(T + "source 'mantle': one plain line saying so, with Set up administrator access", !src.hidden && /Mantle's own record/.test(src.t) && /administrator access/.test(src.t) && src.btn, JSON.stringify(src));
    // like Windows, the default list is the Store apps (lib's app:true); desktop apps and the rest need the setting
    check(T + 'a desktop app or non-app process is hidden while "Show history for all processes" is off', !(await p.$(ROW('google chrome'))) && !(await p.$(ROW('made-up-bgsvc'))) && !!(await p.$(ROW('microsoft store'))));
    check(T + 'no sideways scroll on the page at 1280', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    /* ---- Settings > Show history for all processes (left on for the rest of this theme: the rows below are desktop apps) ---- */
    await p.evaluate(() => { window.__mock.S.settings.historyAllProcesses = true; window.__mock.push(); });
    await p.waitForSelector(ROW('made-up-bgsvc'), { timeout: 3000 }).catch(() => {});
    check(T + 'historyAllProcesses: the desktop apps and the non-app row show', !!(await p.$(ROW('made-up-bgsvc'))) && !!(await p.$(ROW('google chrome'))));
    check(T + "historyAllProcesses: Windows' other line", /for current user and system accounts\.$/.test(await waitText(p, `${PG} .ahsince`, /system accounts/)));
    const cells = await p.$$eval(ROW('google chrome') + ' .c', (cs) => cs.map((c) => ({ t: c.textContent, w: c.title })));
    // Mantle's own record is CPU time only: Network is an em dash carrying the row's own why (lib's why.net)
    check(T + "a row: name, CPU time h:mm:ss, Network an em dash with the row's own why", cells[0].t === 'Google Chrome' && cells[1].t === '11:32:00' && cells[2].t === '—' && /event tracing as administrator/.test(cells[2].w), JSON.stringify(cells.slice(0, 3)));
    check(T + 'numbers right-aligned', await p.$eval(ROW('google chrome') + ' .c.num', (c) => getComputedStyle(c).justifyContent === 'flex-end'));
    check(T + 'column tooltips are Windows\'', (await p.$eval(`${PG} .thead .h[data-col="cpuTimeSec"]`, (h) => h.title)) === 'Amount of time spent by the CPU executing instructions');

    /* ---- header right-click: the columns, Windows' extra three ---- */
    await p.click(`${PG} .thead .h[data-col="net"]`, { button: 'right' });
    const hm = (await menuItems(p)).map((x) => x.l);
    check(T + 'header menu lists Non-metered network, Downloads, Uploads', ['Non-metered network', 'Downloads', 'Uploads'].every((w) => hm.includes(w)), hm.join('|'));
    await pick(p, 'Downloads');
    check(T + 'header menu adds Downloads', (await heads(p)).includes('Downloads'));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.apphistory'));

    /* ---- sort ---- */
    await p.click(`${PG} .thead .h[data-col="cpuTimeSec"]`);
    const first = await p.$eval(`${PG} .trow .c.name`, (c) => c.textContent);
    check(T + 'CPU time header: most first', first === 'Google Chrome', first);
    await p.click(`${PG} .thead .h[data-col="name"]`);

    /* ---- row menu: Windows' App history Context ---- */
    await rmenu(p, 'google chrome');
    let mi = await menuItems(p);
    check(T + 'row menu: Switch to, Search online, Properties', mi.map((x) => x.l).join('|') === 'Switch to|Search online|Properties', mi.map((x) => x.l).join('|'));
    await pick(p, 'Switch to');
    const sw = (await waitCall(p, 'taskmgr.switchTo')).pop();
    check(T + 'Switch to: asked of Mantle as a dry run, by its identity', sw && /\\chrome\.exe$/.test(sw.args.identity) && sw.args.dryRun === true, JSON.stringify(sw));
    await p.keyboard.press('Escape');
    await rmenu(p, 'made-up-bgsvc');
    mi = await menuItems(p);
    check(T + 'Properties off with its reason when no file path came (the row\'s why.path)', mi[2] && mi[2].off && /where this app's file is/.test(mi[2].tip), JSON.stringify(mi[2]));
    await p.keyboard.press('Escape');
    check(T + 'Switch to: the outcome on the row', /Test Mantle/.test(await waitText(p, ROW('google chrome') + ' .tsub', /Test Mantle/)));
    await rmenu(p, 'microsoft store');
    mi = await menuItems(p);
    check(T + 'Properties on when the row has a path', mi[2] && !mi[2].off);
    await pick(p, 'Properties');
    const pr = (await waitCall(p, 'taskmgr.properties')).pop();
    check(T + 'Properties: asked with the path', pr && /WinStore\.App\.exe$/.test(pr.args.path), JSON.stringify(pr));
    await rmenu(p, 'discord');
    await pick(p, 'Search online');
    const so = (await waitCall(p, 'taskmgr.searchOnline')).pop();
    check(T + 'Search online: the app name', so && so.args.name === 'Discord', JSON.stringify(so));

    /* ---- Delete usage history: Windows asks nothing; the outcome is said on the page ---- */
    await t.clearCalls(p);
    await p.click(clearBtn);
    const ch = (await waitCall(p, 'taskmgr.clearHistory')).pop();
    check(T + 'Delete usage history: one dry run, no dialog', ch && ch.args.dryRun === true && (await calls(p, 'taskmgr.clearHistory')).length === 1 && (await p.evaluate(() => document.getElementById('dlg').hidden)), JSON.stringify(ch));
    check(T + 'Delete usage history: its outcome on the page', /Test Mantle/.test(await waitText(p, `${PG} .ahout`, /Test Mantle/)));

    /* ---- main's needsConfirm: its dialog, once, then confirmed ---- */
    await t.clearCalls(p);
    await p.evaluate(() => {
      const orig = window.mantle.call.bind(window.mantle);
      window.mantle.call = (name, args) => {
        if (name === 'taskmgr.clearHistory' && !(args || {}).confirmed) { window.__mockCalls.push({ name, args }); return Promise.resolve({ ok: false, needsConfirm: true, title: 'Made-up title from main', text: 'Made-up words from main.', button: 'Delete' }); }
        return orig(name, args);
      };
    });
    await p.click(clearBtn);
    const d = await dlg(p);
    check(T + "needsConfirm: main's dialog with main's words", d.title === 'Made-up title from main' && /Made-up words/.test(d.body) && d.ok === 'Delete', JSON.stringify(d));
    await p.click('#dlg .dfoot [data-b="ok"]');
    await noDlg(p);
    const cc = await waitCall(p, 'taskmgr.clearHistory', 2);
    check(T + 'needsConfirm: sent again with confirmed (still a dry run)', cc.length === 2 && cc[1].args.confirmed === true && cc[1].args.dryRun === true, JSON.stringify(cc));

    /* ---- search ---- */
    await p.fill('#q', 'disc');
    await t.sleep(100);
    const names = await p.$$eval(`${PG} .trow .c.name`, (cs) => cs.map((c) => c.textContent));
    check(T + 'search filters by name', names.length === 1 && names[0] === 'Discord', names.join('|'));
    await p.fill('#q', 'zzz');
    await t.sleep(100);
    check(T + 'search with no match: Windows\' empty state + Clear search', !!(await p.$(`${PG} .tstate [data-tmact="clearq"]`)));
    await p.fill('#q', '');
    check(T + 'no page errors drawn', (await t.shellErrors(p)).length === 0, (await t.shellErrors(p)).join('\n'));
    await t.close(p);
  }
  check('light and dark differ (tokens follow the theme)', ink.light && ink.dark && ink.light !== ink.dark, JSON.stringify(ink));

  /* ---- source 'srum': no Mantle line ---- */
  {
    const p = await t.open('view=apphistory&test=1&ah=srum');
    await settle(p);
    check("source 'srum': the Mantle-record line is gone", await p.$eval(`${PG} .ahsrc`, (e) => e.hidden));
    await t.close(p);
  }
  /* ---- needs admin / failure / missing command on Delete usage history ---- */
  {
    const p = await t.open('view=apphistory&test=1&admin=clearHistory');
    await settle(p);
    await p.click(clearBtn);
    await p.waitForSelector(`${PG} .ahout [data-tmact="elevated-setup"]`, { timeout: 3000 }).catch(() => {});
    check('needsAdmin: said on the page with Set up administrator access', !!(await p.$(`${PG} .ahout [data-tmact="elevated-setup"]`)));
    check('needsAdmin: no dialog', await p.evaluate(() => document.getElementById('dlg').hidden));
    await t.close(p);
  }
  {
    const p = await t.open('view=apphistory&test=1&fail=clearHistory');
    await settle(p);
    await p.click(clearBtn);
    check('a failure: said with its reason', /Usage history was not deleted: Made-up failure/.test(await waitText(p, `${PG} .ahout`, /Made-up/)));
    await t.close(p);
  }
  {
    const p = await t.open('view=apphistory&test=1&missing=clearHistory');
    await settle(p);
    await p.click(clearBtn);
    check('no such command: said plainly', /can't do that yet/.test(await waitText(p, `${PG} .ahout`, /yet/)));
    await t.close(p);
  }
  /* ---- nulls: em dashes with their reasons ---- */
  {
    // Windows' own history (srum) with nothing reported: no row why, so the page's words; all processes on for Discord
    const p = await t.open('view=apphistory&ah=srum&nulls=1');
    await settle(p);
    await p.evaluate(() => { window.__mock.S.settings.historyAllProcesses = true; window.__mock.push(); });
    await p.waitForSelector(ROW('discord'), { timeout: 3000 }).catch(() => {});
    const c = await p.$$eval(ROW('discord') + ' .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
    check('nulls: Network is an em dash with why', c[2].t === '—' && /did not record network use/.test(c[2].w), JSON.stringify(c[2]));
    check('nulls: Metered network too', c[3].t === '—' && !!c[3].w, JSON.stringify(c[3]));
    const s =await p.$eval(`${PG} .ahsince .na`, (e) => ({ t: e.textContent, w: e.title })).catch(() => null);
    check('nulls: no start date = em dash with why', s && s.t === '—' && !!s.w, JSON.stringify(s));
    await t.close(p);
  }
  /* ---- empty, loading, old main ---- */
  {
    const p = await t.open('view=apphistory&ah=empty');
    await p.waitForSelector(`${PG} .tstate`, { timeout: 3000 }).catch(() => {});
    check("no rows: Windows' \"No data available\"", /No data available/.test(await text(p, `${PG} .tstate`)));
    await t.close(p);
  }
  {
    const p = await t.open('view=processes&old=1');   // an old main opens on Processes; the page is chosen in the rail
    await p.click('.nav[data-view="apphistory"]');
    await t.sleep(300);
    check('an old main: says this Mantle does not read the page yet', /doesn't read this page yet/.test(await text(p, `${PG} .tstate`)));
    check('an old main: the since line is hidden', await p.$eval(`${PG} .ahsince`, (e) => e.hidden));
    await t.close(p);
  }
  /* ---- the window's minimum size ---- */
  for (const theme of ['light', 'dark']) {
    const p = await t.open('view=apphistory', { theme, w: 560, h: 420 });
    await settle(p);
    const s = await p.evaluate(() => ({ page: document.documentElement.scrollWidth <= innerWidth, rows: document.querySelectorAll('#pg-apphistory .trow').length }));
    check(`[${theme}] 560x420: no page-level sideways scroll, rows drawn`, s.page && s.rows >= 3, JSON.stringify(s));
    await t.close(p);
  }
});
