/* performance.page.test.js - the Performance page (pages/performance.js) clicked and typed through on the mock
 * (ui/taskmgr/testkit.js: headless Chromium over file://, never Electron, never a real process; every number is
 * MADE UP by mock-mantle.js). Every device card and its pane, the list's keys, the "..." items, every right-click
 * item, null fields (em dash + reason), an old main, no drawing while hidden, light + dark, the minimum size, and
 * the cost of one update.
 *   node ui/taskmgr/pages/performance.page.test.js  ->  "TASKMGR PERFORMANCE PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('../testkit.js');

const R = '#pg-performance';
const PANES = {
  CPU: { title: 'CPU', paths: 1, has: ['12th Gen Intel(R) Core(TM) i3-1215U', '% Utilization', '100%', '60 seconds', 'Utilization 23%', 'Speed 2.83 GHz', 'Processes 247', 'Threads 3480', 'Handles 112345', 'Up time 3:05:23:11',
    'Base speed: 1.20 GHz', 'Sockets: 1', 'Cores: 6', 'Logical processors: 8', 'Virtualization: Enabled', 'L1 cache: 544 KB', 'L2 cache: 4.5 MB', 'L3 cache: 10.0 MB'] },
  Memory: { title: 'Memory', paths: 1, has: ['16.0 GB', 'Memory usage', 'Memory composition', 'In use (Compressed) 10.6 GB (402 MB)', 'Available 5.4 GB', 'Committed 14.2/22.5 GB', 'Cached 4.9 GB',
    'Paged pool 612 MB', 'Non-paged pool 498 MB', 'Speed: 4267 MT/s', 'Slots used: 2 of 2', 'Form factor: Row of chips', 'Hardware reserved: 298 MB'] },
  'Disk 0 (C:)': { title: 'Disk 0 (C:)', paths: 3, has: ['NVMe Made-Up SSD 512GB', 'Active time', 'Disk transfer rate', '5 MB/s', 'Average response time 0.6 ms', 'Read speed 1.2 MB/s', 'Write speed 420 KB/s',
    'Capacity: 477 GB', 'Formatted: 476 GB', 'System disk: Yes', 'Page file: Yes', 'Type: SSD'] },
  'Disk 1 (D:)': { title: 'Disk 1 (D:)', paths: 3, has: ['USB Made-Up Drive', 'Read speed 0 KB/s', 'System disk: No', 'Type: HDD'] },
  'Wi-Fi': { title: 'Wi-Fi', paths: 2, has: ['Made-Up Wi-Fi 6 AX201', 'Throughput', 'Send 208 Kbps', 'Receive 3.3 Mbps', 'Adapter name: Wi-Fi', 'SSID: Made-Up Network', 'Connection type: 802.11ax',
    'IPv4 address: 192.0.2.24', 'IPv6 address: fe80::1c2b:3a4d:5e6f:7a8b%14', 'Signal strength:'] },
  Ethernet: { title: 'Ethernet', paths: 2, has: ['Made-Up USB GbE', 'Throughput', 'Send 0 Kbps', 'Adapter name: Ethernet', 'Connection type: Ethernet'] },
  'GPU 0': { title: 'GPU', paths: 6, has: ['Intel(R) UHD Graphics', '3D', 'Copy', 'Video Encode', 'Video Decode', 'Dedicated GPU memory usage', '128 MB', 'Shared GPU memory usage', '5.9 GB',
    'Utilization 4%', 'Dedicated GPU memory 0/128 MB', 'GPU Memory 0.6/6.0 GB', 'Shared GPU memory 0.6/5.9 GB', 'Driver version: 31.0.101.5592', 'Driver date: 6/12/2026',
    'DirectX version: DirectX 12 (FL 12.1)', 'Physical location: PCI bus 0, device 2, function 0', 'Hardware reserved memory: 0 MB'] },
};
const CARDS = ['CPU 23% 2.83 GHz', 'Memory 10.6/16.0 GB (66%)', 'Disk 0 (C:) SSD 3%', 'Disk 1 (D:) HDD 0%', 'Wi-Fi Wi-Fi S: 0.2 R: 3.3 Mbps', 'Ethernet Ethernet S: 0 R: 0 Kbps', 'GPU 0 Intel(R) UHD Graphics 4%'];

kit.run('TASKMGR PERFORMANCE PAGE TEST', async (t) => {
  const { check, calls } = t;
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
  const cards = (p) => p.$$eval(`${R} .pc`, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const paneText = async (p) => flat(await p.$eval(`${R} .pf-pane`, (e) => Array.from(e.querySelectorAll('.pp-title, .pp-model, .pg-gl, .pp-c, .pp-kr, .pp-compw')).map((x) => x.textContent.replace(/\s+/g, ' ')).join(' | ').replace(/:\s*/g, ': ').replace(/ \| /g, ' | ')));
  const cellText = (p) => p.$eval(`${R} .pf-pane`, (e) => Array.from(e.querySelectorAll('.pp-c, .pp-kr')).map((x) => Array.from(x.children).map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')));
  const pick = (p, title) => p.evaluate((tt) => { const c = Array.from(document.querySelectorAll('#pg-performance .pc')).find((x) => x.querySelector('.pc-t').textContent === tt); if (c) c.click(); return !!c; }, title);
  const selTitle = (p) => p.$eval(`${R} .pc[aria-selected="true"] .pc-t`, (e) => e.textContent);
  const drawn = (p, sel) => p.$$eval(`${R} .pf-pane ${sel || 'path.l'}`, (ps) => ps.filter((x) => (x.getAttribute('d') || '').length > 40).length);
  const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  const menuLabels = (p) => p.evaluate(() => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; return m ? Array.from(m.querySelectorAll('button')).map((b) => b.querySelector('span').textContent) : []; });
  const menuChecked = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const b = Array.from(ms[ms.length - 1].querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); return b ? b.getAttribute('aria-checked') : 'missing'; }, label);
  async function choose(p, ...labels) {
    for (const l of labels) {
      const okk = await p.evaluate((x) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((y) => y.querySelector('span').textContent === x); if (b) b.click(); return !!b; }, l);
      if (!okk) throw new Error(`no menu item "${l}" (menu: ${(await menuLabels(p)).join(', ')})`);
      await p.waitForTimeout(60);
    }
    await p.waitForTimeout(60);
  }
  const graphMenu = async (p) => { await p.click(`${R} .pp-graphs .pg-box`, { button: 'right' }); await p.waitForTimeout(60); };
  const moreMenu = async (p) => { await p.click('#cmdbar .cbtn.more'); await p.waitForTimeout(60); };
  const stubClip = (p, fail) => p.evaluate((f) => {
    window.__clip = [];
    const w = f ? () => Promise.reject(new Error('Document is not focused.')) : (x) => { window.__clip.push(x); return Promise.resolve(); };
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: w }, configurable: true }); } catch (_) { navigator.clipboard.writeText = w; }
    document.execCommand = () => false;
  }, !!fail);
  const clip = (p) => p.evaluate(() => window.__clip.slice());
  const noteText = (p) => p.$eval('#note', (e) => (e.hidden ? '' : e.textContent));
  const store = (p, k) => p.evaluate((x) => localStorage.getItem('taskmgr.perf.' + x), k);
  // the accent the graphs must use: the --lg-acc token resolved by the browser
  const accent = (p) => p.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--lg-acc)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });

  for (const theme of ['light', 'dark']) {
    const T = `[${theme}] `;
    const p = await t.open('view=performance', { theme });
    await p.waitForSelector(`${R} .pc`);
    /* ---- the list: Windows' order and words ---- */
    check(T + 'list: every device card, Windows order and live lines', JSON.stringify(await cards(p)) === JSON.stringify(CARDS), JSON.stringify(await cards(p)));
    check(T + 'list: each card has its sparkline drawn', (await p.$$eval(`${R} .pc-sp path.l`, (ps) => ps.filter((x) => (x.getAttribute('d') || '').length > 40).length)) >= 8);
    check(T + 'graphs use the accent token (stroke = --lg-acc)', (await p.$eval(`${R} .pf-pane path.l.m`, (e) => getComputedStyle(e).stroke)) === await accent(p));
    check(T + 'no NaN / undefined / null words', !/NaN|undefined|null/.test(await p.$eval(R, (e) => e.textContent)));
    /* ---- every device's pane ---- */
    for (const [card, want] of Object.entries(PANES)) {
      check(`${T}${card}: its card is there`, await pick(p, card));
      const txt = await paneText(p);
      const cells = (await cellText(p)).join(' | ');
      const all = txt + ' | ' + cells;
      const miss = want.has.filter((w) => !all.includes(w));
      check(`${T}${card}: pane title "${want.title}"`, (await p.textContent(`${R} .pp-title`)) === want.title, await p.textContent(`${R} .pp-title`));
      check(`${T}${card}: every Windows label and number`, !miss.length, `missing: ${miss.join(' / ')} in: ${all.slice(0, 400)}`);
      check(`${T}${card}: graphs drawn (${want.paths})`, (await drawn(p)) >= want.paths, await drawn(p));
      check(`${T}${card}: the card is marked chosen`, (await selTitle(p)) === card);
    }
    if (theme === 'light') {
      await pick(p, 'Memory');
      const segs = await p.$$eval(`${R} .pp-comp .seg`, (es) => es.map((e) => e.title.split('\n')[0] + '|' + Math.round(e.getBoundingClientRect().width)));
      check('Memory composition: In use / Modified / Standby / Free with sizes in the tooltips', /^In use \(10\.4 GB\)/.test(segs[0]) && /^Modified \(205 MB\)/.test(segs[1]) && /^Standby \(4\.7 GB\)/.test(segs[2]) && /^Free \(717 MB\)/.test(segs[3]), segs.join(', '));
      check('Memory composition: widths follow the sizes', Number(segs[0].split('|')[1]) > Number(segs[2].split('|')[1]) && Number(segs[2].split('|')[1]) > Number(segs[3].split('|')[1]), segs.join(', '));
      await pick(p, 'Wi-Fi');
      { // signal is percent 0..100 (TM-SPEC 10-28): a bar per quarter, the words say both
        const on = await p.$$eval(`${R} .pp-sig rect.on`, (r) => r.length), t = await p.$eval(`${R} .pp-sig`, (e) => e.title);
        const m = /(\d) of 4 bars \((\d+)%\)/.exec(t);
        check('Wi-Fi: signal strength drawn as bars with words', !!m && +m[1] === on && on === (+m[2] <= 0 ? 0 : Math.min(4, Math.ceil(+m[2] / 25))), t);
      }
      check('Wi-Fi: the send line is dashed, receive solid (legend matches)', (await p.$eval(`${R} .pf-pane path.l.s`, (e) => getComputedStyle(e).strokeDasharray)) !== 'none' && (await p.$eval(`${R} .pf-pane path.l.m`, (e) => getComputedStyle(e).strokeDasharray)) === 'none');

      /* ---- keys on the list ---- */
      await pick(p, 'CPU');
      await p.focus(`${R} .pc[aria-selected="true"]`);
      await p.keyboard.press('ArrowDown');
      check('keys: Down chooses the next device', (await selTitle(p)) === 'Memory' && (await p.textContent(`${R} .pp-title`)) === 'Memory');
      check('keys: the focus moves with the choice', await p.evaluate(() => document.activeElement.getAttribute('aria-selected') === 'true' && document.activeElement.textContent.startsWith('Memory')));
      await p.keyboard.press('End');
      check('keys: End chooses the last device', (await selTitle(p)) === 'GPU 0');
      await p.keyboard.press('ArrowUp');
      check('keys: Up chooses the one before', (await selTitle(p)) === 'Ethernet');
      await p.keyboard.press('Home');
      await p.keyboard.press('ArrowUp');
      check('keys: Home chooses CPU and Up stays there', (await selTitle(p)) === 'CPU');
      check('the chosen device is remembered', (await store(p, 'sel')) === '"cpu"');
      check('list: one tab stop, the chosen card', (await p.$$eval(`${R} .pc[tabindex="0"]`, (e) => e.length)) === 1);

      /* ---- the "..." items ---- */
      await moreMenu(p);
      check('"...": Open Resource Monitor, Copy, Graph summary view', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Open Resource Monitor', 'Copy', 'Graph summary view']), (await menuLabels(p)).join(', '));
      await t.clearCalls(p);
      await choose(p, 'Open Resource Monitor');
      check('"...": Open Resource Monitor asks Mantle (openResmon)', (await calls(p, 'taskmgr.openResmon')).length === 1);
      await stubClip(p);
      await moreMenu(p);
      await choose(p, 'Copy');
      await p.waitForTimeout(80);
      const c1 = (await clip(p))[0] || '';
      check('"...": Copy puts Windows\' CPU summary on the clipboard', /^CPU\r\n\r\n\t12th Gen Intel\(R\) Core\(TM\) i3-1215U\r\n/.test(c1) && c1.includes('\tBase speed:\t1.20 GHz\r\n') && c1.includes('\tL3 cache:\t10.0 MB\r\n') && c1.includes('\tUtilization\t23%\r\n') && c1.includes('\tUp time\t3:05:23:11\r\n'), JSON.stringify(c1).slice(0, 300));
      await moreMenu(p);
      check('"...": Graph summary view starts unticked', (await menuChecked(p, 'Graph summary view')) === 'false');
      await choose(p, 'Graph summary view');
      check('Graph summary view: the graph alone (no list, header, rail or numbers)', await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv')) && !(await vis(p, `${R} .pf-side`)) && !(await vis(p, '.phead')) && !(await vis(p, '.rail')) && !(await vis(p, `${R} .pp-stats`)) && await vis(p, `${R} .pg-box`));
      check('Graph summary view is remembered', (await store(p, 'gsv')) === 'true');
      await p.dblclick(`${R} .pp-graphs .pg-box`);
      await p.waitForTimeout(60);
      check('Graph summary view: a double-click on the graph leaves it', !(await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv'))) && await vis(p, '.phead') && await vis(p, `${R} .pf-side`));
      await p.dblclick(`${R} .pp-graphs .pg-box`);
      await p.waitForTimeout(60);
      check('Graph summary view: a double-click on the graph enters it (Windows)', await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv')));
      await p.keyboard.press('Escape');
      await p.waitForTimeout(60);
      check('Graph summary view: Esc leaves it (Mantle hides the header there)', !(await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv'))));

      /* ---- the graph's right-click: CPU ---- */
      await graphMenu(p);
      check('CPU graph menu: Change graph to, Show kernel times, Graph summary view, View, Copy', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Change graph to', 'Show kernel times', 'Graph summary view', 'View', 'Copy']), (await menuLabels(p)).join(', '));
      await choose(p, 'Change graph to');
      check('Change graph to: Overall utilization (ticked) / Logical processors', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Overall utilization', 'Logical processors']) && (await menuChecked(p, 'Overall utilization')) === 'true');
      await choose(p, 'Logical processors');
      check('Logical processors: one graph per logical processor (8)', (await p.$$eval(`${R} .pp-cores .pg-g`, (e) => e.length)) === 8 && (await drawn(p, '.pp-cores path.l')) === 8);
      check('Logical processors: a 4 x 2 grid', (await p.$eval(`${R} .pp-cores`, (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)) === 4);
      check('Logical processors: Windows\' caption', (await p.$eval(`${R} .pp-grp.cores > .pg-gl`, (e) => e.textContent)).includes('% Utilization over 60 seconds'));
      check('Logical processors is remembered', (await store(p, 'cpuGraph')) === '"logical"');
      await graphMenu(p);
      await choose(p, 'Show kernel times');
      check('Show kernel times with logical processors: says kernel time is whole-CPU only (not faked per core)', /kernel times: whole CPU only/.test(await p.$eval(`${R} .pp-grp.cores > .pg-gl`, (e) => e.textContent)) && (await p.$$eval(`${R} .pp-cores path.l.k`, (e) => e.length)) === 0);
      await graphMenu(p);
      await choose(p, 'Change graph to', 'Overall utilization');
      check('Show kernel times: the kernel share is shaded under the total', (await drawn(p, 'path.l.k')) === 1 && (await p.$$eval(`${R} .pf-pane path.a.k`, (e) => e.length)) === 1);
      check('Show kernel times: the shade is the stronger accent tint', (await p.$eval(`${R} path.a.k`, (e) => getComputedStyle(e).fill)) !== (await p.$eval(`${R} path.a.m`, (e) => getComputedStyle(e).fill)));
      await graphMenu(p);
      check('Show kernel times is ticked in the menu', (await menuChecked(p, 'Show kernel times')) === 'true');
      await choose(p, 'Show kernel times');
      check('Show kernel times off: the shade goes', (await p.$$eval(`${R} path.a.k`, (e) => e.length)) === 0 && (await store(p, 'kernel')) === 'false');
      await graphMenu(p);
      await choose(p, 'View');
      check('View: every device, the shown one ticked', JSON.stringify(await menuLabels(p)) === JSON.stringify(['CPU', 'Memory', 'Disk 0 (C:)', 'Disk 1 (D:)', 'Wi-Fi', 'Ethernet', 'GPU 0']) && (await menuChecked(p, 'CPU')) === 'true');
      await choose(p, 'Memory');
      check('View > Memory shows Memory', (await selTitle(p)) === 'Memory' && (await p.textContent(`${R} .pp-title`)) === 'Memory');
      await graphMenu(p);
      check('Memory graph menu: no CPU-only items', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Graph summary view', 'View', 'Copy']), (await menuLabels(p)).join(', '));
      await choose(p, 'Copy');
      await p.waitForTimeout(80);
      const c2 = (await clip(p)).pop() || '';
      check('graph menu Copy: Windows\' Memory summary', /^Memory\r\n\r\n\t16\.0 GB\r\n/.test(c2) && c2.includes('\tSpeed:\t4267 MT/s\r\n') && c2.includes('\tIn use (Compressed)\t10.6 GB (402 MB)\r\n'), JSON.stringify(c2).slice(0, 300));
      await graphMenu(p);
      await choose(p, 'Graph summary view');
      check('graph menu: Graph summary view on', await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv')));
      await graphMenu(p);
      check('graph menu: Graph summary view ticked', (await menuChecked(p, 'Graph summary view')) === 'true');
      await choose(p, 'Graph summary view');
      check('graph menu: Graph summary view off', !(await p.evaluate(() => document.getElementById('app').classList.contains('perf-gsv'))));
      await p.keyboard.press('Control+c');
      await p.waitForTimeout(80);
      check('Ctrl+C copies the shown device (Windows)', /^Memory\r\n/.test((await clip(p)).pop() || ''));

      /* ---- GPU: Change graph to, the engine picker ---- */
      await pick(p, 'GPU 0');
      await graphMenu(p);
      check('GPU graph menu: Change graph to, Graph summary view, View, Copy', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Change graph to', 'Graph summary view', 'View', 'Copy']), (await menuLabels(p)).join(', '));
      await choose(p, 'Change graph to', 'Single engine');
      check('GPU: Single engine draws one engine graph', (await p.$$eval(`${R} .pg-pick`, (e) => e.length)) === 1 && await vis(p, `${R} .pp-grp.one .pg-pick`));
      await graphMenu(p);
      await choose(p, 'Change graph to', 'Multiple engines');
      check('GPU: Multiple engines draws four, in a 2 x 2 grid', (await p.$$eval(`${R} .pp-grp.quad .pg-pick`, (e) => e.length)) === 4);
      await p.click(`${R} .pg-pick[data-slot="0"]`);
      await p.waitForTimeout(60);
      check('GPU engine picker: every engine, the shown one ticked', JSON.stringify(await menuLabels(p)) === JSON.stringify(['3D', 'Copy', 'Video Encode', 'Video Decode']) && (await menuChecked(p, '3D')) === 'true');
      await choose(p, 'Video Decode');
      check('GPU engine picker: the slot shows the chosen engine, remembered', flat(await p.textContent(`${R} .pg-pick[data-slot="0"]`)) === 'Video Decode' && JSON.parse(await store(p, 'gpuEng')).gpu0[0] === 'Video Decode');
      await p.click(`${R} .pg-pick[data-slot="0"]`);
      await p.waitForTimeout(60);
      await choose(p, '3D');

      /* ---- the list's right-click ---- */
      await p.click(`${R} .pc >> nth=0`, { button: 'right' });
      await p.waitForTimeout(60);
      check('list menu: Hide graphs, Summary view, Copy', JSON.stringify(await menuLabels(p)) === JSON.stringify(['Hide graphs', 'Summary view', 'Copy']), (await menuLabels(p)).join(', '));
      await choose(p, 'Hide graphs');
      check('Hide graphs: the cards lose their sparklines', !(await vis(p, `${R} .pc-sp`)) && (await store(p, 'hideGraphs')) === 'true');
      await p.click(`${R} .pc >> nth=0`, { button: 'right' });
      await p.waitForTimeout(60);
      await choose(p, 'Hide graphs');
      check('Hide graphs off: the sparklines are back', await vis(p, `${R} .pc-sp`));
      await p.click(`${R} .pc >> nth=0`, { button: 'right' });
      await p.waitForTimeout(60);
      await choose(p, 'Summary view');
      check('Summary view: the list alone', !(await vis(p, `${R} .pf-pane`)) && await vis(p, `${R} .pf-list`) && !(await vis(p, '.phead')));
      await p.dblclick(`${R} .pc >> nth=0`);
      await p.waitForTimeout(60);
      check('Summary view: a double-click on the list leaves it', await vis(p, `${R} .pf-pane`) && await vis(p, '.phead'));

      /* ---- Copy refused: said on the window, never silent ---- */
      await stubClip(p, true);
      await moreMenu(p);
      await choose(p, 'Copy');
      await p.waitForTimeout(80);
      check('Copy refused: the window says why', /Copy did not work \(Document is not focused\)\. Nothing was copied\./.test(await noteText(p)), await noteText(p));
      await stubClip(p);
      await moreMenu(p);
      await choose(p, 'Copy');
      await p.waitForTimeout(80);
      check('Copy works again: the failure line goes', !/Copy did not work/.test(await noteText(p)));

      /* ---- the cost of one update (page visible), and nothing redrawn when nothing changed ---- */
      for (const [label, card, prep] of [['CPU', 'CPU', null], ['GPU', 'GPU 0', null], ['CPU logical processors', 'CPU', 'logical']]) {
        await pick(p, card);
        if (prep) { await graphMenu(p); await choose(p, 'Change graph to', 'Logical processors'); }
        const r = await p.evaluate(async () => {
          const rot = (a, k) => (Array.isArray(a) ? a.slice(k % a.length).concat(a.slice(0, k % a.length)) : a);
          const P0 = Object.assign({}, window.__taskmgrPerf), s0 = window.__tmPerfStat.paths;
          for (let k = 1; k <= 40; k++) {
            const m = window.__mock.model(), f = m.perf;
            f.cpu.hist = rot(f.cpu.hist, k); f.cpu.kernelHist = rot(f.cpu.kernelHist, k); f.cpu.perCore = f.cpu.perCore.map((a) => rot(a, k)); f.cpu.pct = 20 + (k % 7);
            f.mem.hist = rot(f.mem.hist, k);
            for (const d of f.disks) { d.hist = rot(d.hist, k); d.readHist = rot(d.readHist, k); d.writeHist = rot(d.writeHist, k); }
            for (const n of f.nets) { n.sendHist = rot(n.sendHist, k); n.recvHist = rot(n.recvHist, k); }
            for (const g of f.gpus) { for (const e of g.engines) e.hist = rot(e.hist, k); g.sharedHist = rot(g.sharedHist, k); }
            window.mantle.emit('taskmgr.model', m);
            await new Promise((res) => setTimeout(res, 0));
          }
          const P1 = Object.assign({}, window.__taskmgrPerf), s1 = window.__tmPerfStat.paths;
          const m0 = window.__mock.model();
          window.mantle.emit('taskmgr.model', m0);
          const s2 = window.__tmPerfStat.paths, t2 = window.__taskmgrPerf.ms, n2 = window.__taskmgrPerf.ticks;
          for (let k = 0; k < 5; k++) { window.mantle.emit('taskmgr.model', window.__mock.model()); await new Promise((res) => setTimeout(res, 0)); }
          return { ticks: P1.ticks - P0.ticks, ms: P1.ms - P0.ms, paths: s1 - s0, idle: window.__tmPerfStat.paths - s2, idleMs: (window.__taskmgrPerf.ms - t2) / Math.max(1, window.__taskmgrPerf.ticks - n2) };
        });
        const per = r.ms / Math.max(1, r.ticks);
        console.log(`  cost: ${label}: ${per.toFixed(2)} ms per update over ${r.ticks} changing updates (${(r.paths / Math.max(1, r.ticks)).toFixed(1)} paths redrawn each); ${r.idleMs.toFixed(2)} ms when nothing changed (${r.idle} paths redrawn)`);
        check(`cost: ${label}: under 4 ms per update`, per < 4, per.toFixed(2));
        check(`cost: ${label}: unchanged numbers redraw no path`, r.idle === 0, r.idle);
      }
      await graphMenu(p);
      await choose(p, 'Change graph to', 'Overall utilization');

      /* ---- nothing is drawn while the page is hidden ---- */
      await pick(p, 'CPU');
      await p.click('.nav[data-view="processes"]');
      await p.waitForTimeout(150);
      const before = await p.evaluate(() => ({ h: document.getElementById('pg-performance').innerHTML, d: window.__tmPerfStat.draws, pth: window.__tmPerfStat.paths }));
      await p.evaluate(async () => {
        for (let k = 0; k < 5; k++) { const m = window.__mock.model(); m.perf.cpu.pct = 88; m.perf.cpu.hist = m.perf.cpu.hist.map((v) => v + k + 1); window.mantle.emit('taskmgr.model', m); await new Promise((r) => setTimeout(r, 20)); }
      });
      const after = await p.evaluate(() => ({ h: document.getElementById('pg-performance').innerHTML, d: window.__tmPerfStat.draws, pth: window.__tmPerfStat.paths }));
      check('hidden: five models changed nothing on the Performance page', before.h === after.h && before.d === after.d && before.pth === after.pth, `draws ${before.d} -> ${after.d}, paths ${before.pth} -> ${after.pth}`);
      const back = await p.evaluate(() => { document.querySelector('.nav[data-view="performance"]').click(); return document.querySelector('#pg-performance .pc .pc-l').textContent; });
      check('shown again: it catches up at once with the last model', back.startsWith('88%'), back);
    }
    check(T + 'no page threw while drawing', !(await t.shellErrors(p)).length, (await t.shellErrors(p)).join(' / '));
    await t.close(p);
  }

  /* ---- nulls: every nullable field an em dash with its reason ---- */
  {
    const p = await t.open('view=performance&nulls=1');
    await p.waitForSelector(`${R} .pc`);
    check('nulls: the disk card drops its type line (no made-up type)', (await cards(p))[2] === 'Disk 0 (C:) 3%', (await cards(p))[2]);
    const want = { CPU: ['Speed', 'Base speed:', 'Threads', 'Handles', 'L1 cache:'], Memory: ['Cached', 'Speed:', 'Slots used:', 'Form factor:', 'Hardware reserved:', 'In use (Compressed)'], 'Disk 0 (C:)': ['Average response time', 'Capacity:', 'Type:'],
      'Wi-Fi': ['SSID:', 'IPv4 address:', 'IPv6 address:', 'Signal strength:', 'Connection type:'], 'GPU 0': ['Driver version:', 'Driver date:', 'DirectX version:', 'Physical location:', 'Dedicated GPU memory', 'Shared GPU memory'] };
    let total = 0;
    for (const [card, labels] of Object.entries(want)) {
      await pick(p, card);
      const nas = await p.$$eval(`${R} .pf-pane .na`, (es) => es.map((e) => ({ t: e.textContent, why: e.title, at: (e.closest('.pp-c, .pp-kr, .pp-compw, .pg-gl') || {}).textContent || '' })));
      total += nas.length;
      const bad = nas.filter((n) => n.t !== '—' || n.why.length < 12);
      check(`nulls: ${card}: every em dash carries a reason`, nas.length && !bad.length, JSON.stringify(bad[0] || nas.length));
      const miss = labels.filter((l) => !nas.some((n) => n.at.replace(/\s+/g, ' ').includes(l)));
      check(`nulls: ${card}: ${labels.join(', ')} are em dashes`, !miss.length, miss.join(', '));
      check(`nulls: ${card}: no NaN / undefined / null words`, !/NaN|undefined|null/.test(await p.$eval(R, (e) => e.textContent)));
    }
    await pick(p, 'Memory');
    check('nulls: Memory composition says it was not reported', await p.$eval(`${R} .pp-compna .na`, (e) => /how memory is split/.test(e.title)).catch(() => false) && (await p.$$eval(`${R} .pp-comp .seg:not([hidden])`, (e) => e.length)) === 0);
    console.log(`  nulls: ${total} em dashes, each with a reason`);
    check('nulls: no page threw while drawing', !(await t.shellErrors(p)).length);
    await t.close(p);
  }

  /* ---- an old main: only the legacy cpu + mem fields; the rest said plainly ---- */
  {
    const p = await t.open('view=performance&old=1');
    await p.click('.nav[data-view="performance"]');
    await p.waitForSelector(`${R} .pc`);
    await p.waitForTimeout(150);
    const cs = await cards(p);
    check('old main: CPU and Memory only, from the legacy fields', JSON.stringify(cs) === JSON.stringify(['CPU 23%', 'Memory 10.6/16.0 GB (66%)']), JSON.stringify(cs));
    check('old main: the list says disks, network and GPU need a newer helper', /Disks, network and GPU: this Mantle's helper doesn't report them yet/.test(await p.$eval(`${R} .pf-old`, (e) => (e.hidden ? '' : e.textContent))));
    await pick(p, 'CPU');
    const txt = (await cellText(p)).join(' | ');
    check('old main: CPU utilization from the legacy number', txt.includes('Utilization 23%') && txt.includes('Logical processors: 8'), txt.slice(0, 200));
    check('old main: CPU graph drawn from the legacy history', (await drawn(p)) === 1);
    check('old main: the unknowns are em dashes saying the helper needs updating', await p.$eval(`${R} .pp-kr .na`, (e) => /needs updating/.test(e.title)));
    await pick(p, 'Memory');
    const mt = (await cellText(p)).join(' | ');
    check('old main: Memory in use and available', mt.includes('In use (Compressed) 10.6 GB (—)') && mt.includes('Available 5.4 GB'), mt.slice(0, 200));
    await moreMenu(p);
    await choose(p, 'Open Resource Monitor');
    await p.waitForTimeout(150);
    check('old main: Open Resource Monitor says this Mantle cannot yet', /Resource Monitor did not open: This Mantle can't do that yet/.test(await noteText(p)), await noteText(p));
    check('old main: no page threw while drawing', !(await t.shellErrors(p)).length);
    await t.close(p);
  }

  /* ---- the window's minimum size: no sideways scroll on any pane ---- */
  for (const theme of ['light', 'dark']) {
    const p = await t.open('view=performance', { theme, w: 560, h: 420 });
    await p.waitForSelector(`${R} .pc`);
    const bad = [];
    for (const card of Object.keys(PANES)) {
      await pick(p, card);
      const r = await p.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const pane = q('#pg-performance .pf-pane'), list = q('#pg-performance .pf-list'), box = q('#pg-performance .pg-box');
        return { doc: document.documentElement.scrollWidth - innerWidth, pane: pane.scrollWidth - pane.clientWidth, list: list.scrollWidth - list.clientWidth, gh: box.getBoundingClientRect().height, gw: box.getBoundingClientRect().width };
      });
      if (r.doc > 0 || r.pane > 0 || r.list > 0 || r.gh < 40 || r.gw < 120) bad.push(`${card} ${JSON.stringify(r)}`);
    }
    check(`[${theme}] 560x420: every pane fits sideways, its graph readable`, !bad.length, bad.join(' / '));
    await t.close(p);
  }
});
