/* pages/startup.page.test.js - Windows' Startup apps page, clicked and typed through on the MOCK
 * (ui/taskmgr/testkit.js: headless Chromium over file://, never Electron, never a real startup entry; every
 * app is made up). Every action is a dry run (test=1) and is checked in window.__mockCalls.
 *   node ui/taskmgr/pages/startup.page.test.js   ->  "TASKMGR STARTUP PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const ROW = (item) => `#pg-startup .trow[data-key="s${item}"]`;
const DEF = ['Name', 'Publisher', 'Status', 'Startup impact'];
const ALL = ['Name', 'Publisher', 'Status', 'Startup impact', 'Startup type', 'Disk I/O at startup', 'CPU at startup', 'Running now', 'Disabled time', 'Command line'];

kit.run('TASKMGR STARTUP PAGE TEST', async (t) => {
  const { check, calls } = t;
  const heads = (p) => p.$$eval('#pg-startup .thead .h', (hs) => hs.map((h) => h.querySelector('.hl').textContent.trim()));
  const menuLabels = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => b.querySelector('span').textContent) : []; });
  const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (!b || b.disabled) return false; b.click(); return true; }, label);
  const rmenu = async (p, item) => { await p.click(ROW(item) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const dlg = async (p) => { await p.waitForSelector('#dlg .dlg'); return p.$eval('#dlg .dlg', (d) => ({ title: d.querySelector('#dlgt').textContent, body: d.querySelector('.dbody').textContent, ok: (d.querySelector('[data-b="ok"]') || {}).textContent, okOff: !!(d.querySelector('[data-b="ok"]') || {}).disabled })); };
  const noDlg = (p) => p.waitForFunction(() => document.getElementById('dlg').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  const waitCall = async (p, name, n) => { for (let i = 0; i < 60; i++) { const c = await calls(p, name); if (c.length >= (n || 1)) return c; await t.sleep(50); } return calls(p, name); };
  const last = async (p, name, n) => { const c = await waitCall(p, name, n); return c.length ? c[c.length - 1].args : {}; };
  const subText = (p, item) => p.$eval(ROW(item) + ' .tsub', (e) => e.textContent).catch(() => '');
  const waitSub = async (p, item, re) => { for (let i = 0; i < 60; i++) { const s = await subText(p, item); if (re.test(s)) return s; await t.sleep(50); } return subText(p, item); };
  const cells = (p, item) => p.$$eval(ROW(item) + ' .c', (cs) => cs.map((c) => c.textContent));
  const cmdBtn = (p, label) => p.$eval(`#cmdbar [aria-label="${label}"]`, (b) => ({ off: b.disabled, title: b.title })).catch(() => null);
  const inkOf = {};

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await t.open('view=startup&test=1', { theme });
    await p.waitForSelector(ROW('discord'));
    inkOf[theme] = await p.$eval('#pg-startup .tlist', (e) => getComputedStyle(e).color);

    /* ---- the list ---- */
    check(T + 'default columns are Windows\' four', (await heads(p)).join('|') === DEF.join('|'), (await heads(p)).join('|'));
    check(T + 'every startup entry drawn', (await p.$$('#pg-startup .trow')).length === 8);
    check(T + 'title is Startup apps', (await p.$eval('#ptitle', (e) => e.textContent)) === 'Startup apps');
    check(T + 'Last BIOS time right of the title', (await p.$eval('#pextra', (e) => e.textContent.trim())) === 'Last BIOS time: 7.4 seconds', await p.$eval('#pextra', (e) => e.textContent));
    let c = await cells(p, 'discord');
    check(T + 'a row: Name, Publisher, Enabled, High', c.join('|') === 'Discord|Discord Inc.|Enabled|High', c.join('|'));
    c = await cells(p, 'teams');
    check(T + 'a disabled row says Disabled, impact None', c[2] === 'Disabled' && c[3] === 'None', c.join('|'));
    const names = await p.$$eval('#pg-startup .trow .c.name', (cs) => cs.map((x) => x.textContent.toLowerCase()));
    check(T + 'sorted by Name by default', names.every((n, i) => i === 0 || names[i - 1] <= n), names.join(','));
    await p.click('#pg-startup .thead .h[data-col="impact"]');
    let imp = await p.$$eval('#pg-startup .trow .c:nth-child(4)', (cs) => cs.map((x) => x.textContent));
    const rank = { High: 4, Medium: 3, Low: 2, None: 1 };
    const rs = imp.map((x) => rank[x] || 0);
    const asc = rs.every((x, i) => i === 0 || rs[i - 1] <= x), desc = rs.every((x, i) => i === 0 || rs[i - 1] >= x);
    check(T + 'Startup impact sorts by weight (High > Medium > Low > None), not by letters', asc || desc, imp.join(','));
    await p.click('#pg-startup .thead .h[data-col="name"]');
    if ((await p.$$eval('#pg-startup .trow .c.name', (cs) => cs.map((x) => x.textContent)))[0] !== 'Discord') await p.click('#pg-startup .thead .h[data-col="name"]');
    check(T + 'no sideways scroll on the page at 1280', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    /* ---- header right-click: the column checklist (Windows' ten) ---- */
    await p.click('#pg-startup .thead .h[data-col="publisher"]', { button: 'right' });
    const hm = await menuLabels(p);
    check(T + 'header right-click lists Windows\' ten columns', ALL.every((x) => hm.includes(x)) && hm.length === ALL.length, hm.join('|'));
    await pick(p, 'Command line');
    for (const col of ['Startup type', 'Disk I/O at startup', 'CPU at startup', 'Running now', 'Disabled time']) {
      await p.click('#pg-startup .thead .h[data-col="name"]', { button: 'right' });
      await pick(p, col);
    }
    check(T + 'every extra column can be shown', (await heads(p)).length === 10, (await heads(p)).join('|'));
    c = await cells(p, 'discord');
    check(T + 'extra cells: type, Disk I/O in MB, CPU in ms, Running, blank disabled time, command line', c[4] === 'Registry' && c[5] === '38.0 MB' && c[6] === '2,100 ms' && c[7] === 'Running' && c[8] === '' && c[9] === 'Update.exe --processStart Discord.exe', c.join('|'));
    c = await cells(p, 'teams');
    check(T + 'a disabled entry: Windows\' short disabled time, blank Running now', /^9\/3\/2026 6:02 PM$/.test(c[8]) && c[7] === '', c.join('|'));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await p.waitForSelector(ROW('discord'));
    check(T + 'the column choice is remembered after a reload', (await heads(p)).length === 10);
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.startup'));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await p.waitForSelector(ROW('discord'));

    /* ---- command bar: Run new task | Enable/Disable | Properties ---- */
    let cb = await p.$$eval('#cmdbar .cbtn', (bs) => bs.map((b) => b.getAttribute('aria-label')));
    check(T + 'command bar with nothing chosen: Run new task | Enable | Properties, both off', cb.join('|') === 'Run new task|Enable|Properties' && (await cmdBtn(p, 'Enable')).off && (await cmdBtn(p, 'Properties')).off, cb.join('|'));
    await p.click(ROW('discord') + ' .tr');
    cb = await p.$$eval('#cmdbar .cbtn', (bs) => bs.map((b) => b.getAttribute('aria-label')));
    check(T + 'an enabled row: the button says Disable', cb.join('|') === 'Run new task|Disable|Properties', cb.join('|'));
    await p.click(ROW('teams') + ' .tr');
    check(T + 'a disabled row: the button says Enable', !!(await cmdBtn(p, 'Enable')) && !(await cmdBtn(p, 'Enable')).off);
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Enable"]');
    let all = await waitCall(p, 'taskmgr.startupSet', 2);
    check(T + 'Enable: a dry-run preflight, then startupSet {item, enabled:true}', all.length === 2 && all[0].args.dryRun === true && all[1].args.item === 'teams' && all[1].args.enabled === true && all[1].args.dryRun === true, JSON.stringify(all));
    check(T + 'Enable: no dialog (Windows asks nothing)', await noDlg(p));
    check(T + 'Enable: the dry run is said on the row', /Test Mantle/.test(await waitSub(p, 'teams', /Test Mantle/)), await subText(p, 'teams'));
    await p.click(ROW('discord') + ' .tr');
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Disable"]');
    let a = await last(p, 'taskmgr.startupSet', 2);
    check(T + 'Disable: startupSet {item:discord, enabled:false}', a.item === 'discord' && a.enabled === false, JSON.stringify(a));
    await t.clearCalls(p);
    await p.click('#cmdbar [aria-label="Properties"]');
    a = await last(p, 'taskmgr.properties');
    check(T + 'Properties: its file', /Update\.exe$/.test(a.path || ''), JSON.stringify(a));

    /* ---- the row menu, every item ---- */
    await rmenu(p, 'discord');
    check(T + 'row menu (enabled): Disable, Open file location, Search online, Properties', (await menuLabels(p)).join('|') === 'Disable|Open file location|Search online|Properties', (await menuLabels(p)).join('|'));
    await t.clearCalls(p);
    await pick(p, 'Disable');
    a = await last(p, 'taskmgr.startupSet', 2);
    check(T + 'menu Disable: startupSet enabled:false', a.item === 'discord' && a.enabled === false);
    await rmenu(p, 'teams');
    check(T + 'row menu (disabled): Enable first', (await menuLabels(p))[0] === 'Enable');
    await t.clearCalls(p);
    await pick(p, 'Open file location');
    a = await last(p, 'taskmgr.openLocation');
    check(T + 'Open file location: its path', /ms-teams\.exe$/.test(a.path || ''), JSON.stringify(a));
    await rmenu(p, 'teams');
    await t.clearCalls(p);
    await pick(p, 'Search online');
    a = await last(p, 'taskmgr.searchOnline');
    check(T + 'Search online: its name', a.name === 'Microsoft Teams', JSON.stringify(a));
    await rmenu(p, 'teams');
    await t.clearCalls(p);
    await pick(p, 'Properties');
    a = await last(p, 'taskmgr.properties');
    check(T + 'menu Properties: its path', /ms-teams\.exe$/.test(a.path || ''), JSON.stringify(a));

    /* ---- keyboard ---- */
    await p.keyboard.press('Escape');
    await p.click(ROW('discord') + ' .tr');
    await p.keyboard.press('ArrowDown');
    const sel = () => p.$eval('#pg-startup .trow.sel', (e) => e.dataset.key).catch(() => null);
    check(T + 'Down arrow chooses the next row', (await sel()) === 'slively', await sel());
    await p.keyboard.press('End');
    check(T + 'End chooses the last row', (await sel()) === 'ssecui', await sel());
    await p.keyboard.type('sp');
    check(T + 'type-ahead finds Spotify', (await sel()) === 'sspotify', await sel());
    await p.keyboard.press('Shift+F10');
    await p.waitForSelector('#menus .menu');
    check(T + 'Shift+F10 opens the row menu', (await menuLabels(p))[0] === 'Disable');
    await p.keyboard.press('Escape');

    /* ---- search: name or publisher ---- */
    await p.fill('#q', 'valve');
    let shown = await p.$$eval('#pg-startup .trow', (rs) => rs.map((r) => r.dataset.key));
    check(T + 'search by publisher (Valve) finds Steam', shown.join(',') === 'ssteam', shown.join(','));
    await p.fill('#q', 'micro');
    shown = await p.$$eval('#pg-startup .trow', (rs) => rs.map((r) => r.dataset.key));
    check(T + 'search "micro": the Microsoft entries', shown.length === 3, shown.join(','));
    await p.fill('#q', 'zzz-nothing');
    check(T + 'a search that hides everything says so', /No results/.test(await p.$eval('#pg-startup .tstate', (e) => e.textContent).catch(() => '')));
    await p.fill('#q', '');

    /* ---- needsConfirm (main's words, one dialog), then confirmed:true ---- */
    await p.evaluate(() => {
      const call = window.mantle.call.bind(window.mantle);
      window.mantle.call = (name, args) => (name === 'taskmgr.startupSet' && args.item === 'secui' && !args.confirmed
        ? (window.__mockCalls.push({ name, args }), Promise.resolve({ ok: false, needsConfirm: true, title: 'Do you want to disable Windows Security notification icon?', text: 'Windows needs it (made-up words).', button: 'Disable' }))
        : call(name, args));
    });
    await t.clearCalls(p);
    await rmenu(p, 'secui');
    await pick(p, 'Disable');
    let d = await dlg(p);
    check(T + 'needsConfirm: main\'s question is the one dialog', d.title === 'Do you want to disable Windows Security notification icon?' && d.ok === 'Disable', JSON.stringify(d));
    await p.click('#dlg .dfoot [data-b="cancel"]');
    await noDlg(p);
    check(T + 'needsConfirm, Cancel: nothing sent after the preflight', (await calls(p, 'taskmgr.startupSet')).length === 1 && !(await subText(p, 'secui')));
    await rmenu(p, 'secui');
    await pick(p, 'Disable');
    await dlg(p);
    await t.clearCalls(p);
    await p.click('#dlg .dfoot [data-b="ok"]');
    a = await last(p, 'taskmgr.startupSet');
    check(T + 'needsConfirm, OK: startupSet goes with confirmed:true', a.item === 'secui' && a.confirmed === true && a.enabled === false, JSON.stringify(a));
    check(T + 'needsConfirm, OK: only that one dialog', await noDlg(p));
    check(T + 'no page errors drawn by the shell', !(await t.shellErrors(p)).length, (await t.shellErrors(p)).join(' '));
    await t.close(p);
  }
  check('light and dark draw the list in different ink', inkOf.light && inkOf.dark && inkOf.light !== inkOf.dark, JSON.stringify(inkOf));

  /* ---- needs admin: said on the row with "Set up administrator access"; the real call is never tried ---- */
  let p = await t.open('view=startup&test=1&admin=startupSet');
  await p.waitForSelector(ROW('discord'));
  await p.click(ROW('discord') + ' .tr');
  await p.click('#cmdbar [aria-label="Disable"]');
  await p.waitForSelector(ROW('discord') + ' [data-tmact="elevated-setup"]', { timeout: 4000 }).catch(() => null);
  check('needsAdmin: the row says why and offers Set up administrator access', /administrator/i.test(await subText(p, 'discord')) && !!(await p.$(ROW('discord') + ' [data-tmact="elevated-setup"]')), await subText(p, 'discord'));
  check('needsAdmin: only the preflight was sent', (await calls(p, 'taskmgr.startupSet')).length === 1);
  await t.clearCalls(p);
  await p.click(ROW('discord') + ' [data-tmact="elevated-setup"]');
  check('Set up administrator access calls elevatedSetup', (await waitCall(p, 'taskmgr.elevatedSetup')).length === 1);
  await t.close(p);

  /* ---- a failure: said on the row with its reason ---- */
  p = await t.open('view=startup&test=1&fail=startupSet');
  await p.waitForSelector(ROW('steam'));
  await rmenu(p, 'steam');
  await pick(p, 'Disable');
  check('a failure is said on the row with its reason', /Not disabled: Made-up failure/.test(await waitSub(p, 'steam', /Made-up/)), await subText(p, 'steam'));
  await t.close(p);

  /* ---- nulls: an em dash with the reason ---- */
  p = await t.open('view=startup&nulls=1');
  await p.waitForSelector(ROW('lively'));
  const nil = await p.$$eval(ROW('lively') + ' .c', (cs) => cs.map((x) => ({ t: x.textContent, w: x.title })));
  check('nulls: no publisher = em dash + why', nil[1].t === '—' && /publisher/.test(nil[1].w), JSON.stringify(nil[1]));
  check('nulls: no Startup impact = em dash + why', nil[3].t === '—' && /measured/.test(nil[3].w), JSON.stringify(nil[3]));
  const bios = await p.$eval('#pextra', (e) => ({ t: e.textContent.trim(), w: (e.querySelector('.na') || {}).title }));
  check('nulls: Last BIOS time = em dash + why', bios.t === 'Last BIOS time: —' && /firmware/.test(bios.w || ''), JSON.stringify(bios));
  await t.close(p);

  /* ---- loading, an old Mantle, a read error ---- */
  p = await t.open('view=startup&old=1');
  await p.click('.nav[data-view="startup"]');
  await p.waitForFunction(() => /doesn't read this page yet/.test((document.querySelector('#pg-startup .tstate') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => {});
  check('an old Mantle without startup data says so', /doesn't read this page yet/.test(await p.$eval('#pg-startup .tstate', (e) => e.textContent).catch(() => '')));
  await t.close(p);
  p = await t.open('view=startup');
  await p.evaluate(() => { window.__mock.S.startup = () => ({ rows: [], biosSec: null, error: 'Made-up read error.' }); window.__mock.push(); });
  await p.waitForFunction(() => /Made-up read error/.test((document.querySelector('#pg-startup .tstate') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => null);
  check('a read error is said in the list', /Made-up read error/.test(await p.$eval('#pg-startup .tstate', (e) => e.textContent).catch(() => '')));
  await p.evaluate(() => { window.__mock.S.startup = () => ({ rows: [{ item: 'x', name: 'Made Up', publisher: null, enabled: true, impact: null, type: 'Registry', diskIO: null, cpuMs: null, running: false, disabledAt: null, cmdline: 'x.exe', path: 'C:\\x.exe' }], biosSec: 3.2, error: null, partial: true, note: 'Startup impact needs administrator rights (made up).' }); window.__mock.push(); });
  await p.waitForSelector(ROW('x'));
  check('a partial read says its note above the list', /administrator rights/.test(await p.$eval('#pg-startup .su-part', (e) => (e.hidden ? '' : e.textContent))));
  await t.close(p);

  /* ---- 560x420: still usable ---- */
  p = await t.open('view=startup', { w: 560, h: 420 });
  await p.waitForSelector(ROW('discord'));
  check('560x420: no sideways scroll on the page', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('560x420: the rows are drawn', (await p.$$('#pg-startup .trow')).length === 8);
  await t.close(p);
});
