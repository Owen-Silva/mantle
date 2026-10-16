require('C:/Users/user/dev-tools/tools/lowcpu.js');
'use strict';
/* qstiles.page.test.js - lane qstiles (2026-10-15): quick settings' new tiles CLICKED in the real bar, the
 * QS paint budget measured, and Win+P's pop-up page driven by the keyboard. Headless Chromium over file://
 * with the mock bridges (ui/bar/mock-mantle.js, ui/project/mock-mantle.js): nothing real is touched.
 *   node ui/bar/qstiles.page.test.js [--shots=<dir>]   (through the heavy-test queue: one browser)
 * The budget (plan P8): QS pagePaint p95 <= 80 ms WITH the new tiles, from the click to the second frame. */
const path = require('path');
const H = require('./page-harness.js');

const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS = shotsArg ? shotsArg.slice('--shots='.length) : null;
const JARGON = (s) => /sidecar|hwnd|\bIPC\b|dryRun|undefined|\bnull\b|NaN|\[object|qstiles\.|project\./i.test(s);
const PROJECT = 'file:///' + path.resolve(__dirname, '../project/index.html').replace(/\\/g, '/');
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

(async () => {
  const t = H.suite('QSTILES PAGE TEST');
  if (H.gaming && H.gaming()) { console.log('a game is running: skipped'); process.exit(0); }
  await H.withBrowser(async (open) => {
    const qs = async (q, o) => { const pg = await open(q, Object.assign({ h: 900 }, o)); await pg.click('#network', { wait: 400 }); return pg; };
    const tiles = (pg) => pg.eval(() => Array.from(document.querySelectorAll('.qsgrid .qstile')).map((b) => ({
      name: b.querySelector('.qslbl').textContent, sub: b.querySelector('.qssub').textContent, on: b.classList.contains('on'),
      dead: b.classList.contains('dead'), tip: b.title, tile: b.dataset.tile || null })));

    // 1) the nine tiles, in order, drawn from the held state
    let pg = await qs('?mode=pill');
    let ts = await tiles(pg);
    t.check('nine tiles: the four + Airplane mode, Do not disturb, Focus, Project, Cast',
      ts.map((x) => x.name).join('|') === 'Wi-Fi|Bluetooth|Night light|Energy saver|Airplane mode|Do not disturb|Focus|Project|Cast', ts.map((x) => x.name));
    const nt = ts.filter((x) => x.tile);
    t.check('the new tiles show their state at once (no "Reading")', nt.every((x) => x.sub && x.sub !== 'Reading…'), nt.map((x) => x.sub));
    t.check('Project shows the current layout', nt.find((x) => x.tile === 'project').sub === 'Extend');
    t.check('Cast says it is Windows\' panel', /Windows/.test(nt.find((x) => x.tile === 'cast').sub) && /Win\+K/.test(nt.find((x) => x.tile === 'cast').tip));
    t.check('no jargon on any new tile', !nt.some((x) => JARGON(x.sub + ' ' + x.tip)), nt.map((x) => x.tip));
    t.check('the panel asked for fresh reads only after drawing', (await pg.calls('qstiles.refresh')).length === 1 && (await pg.calls('project.refresh')).length === 1);
    t.check('no page errors', pg.errors.length === 0, pg.errors);
    if (SHOTS) await pg.page.locator('.pop.qs').screenshot({ path: path.join(SHOTS, 'qs-tiles.png') }).catch((e) => console.log('shot: ' + e.message));

    // 2) clicks: DND / airplane / focus switch through qstiles.set; project / cast open and close the panel
    await pg.reset();
    await pg.click('.qstile[data-tile="dnd"]', { wait: 300 });
    let c = await pg.calls('qstiles.set');
    ts = await tiles(pg);
    t.check('Do not disturb: one set, on, and the tile is lit', c.length === 1 && c[0].p.tile === 'dnd' && c[0].p.on === true && ts.find((x) => x.tile === 'dnd').on, c);
    await pg.click('.qstile[data-tile="airplane"]', { wait: 300 });
    t.check('Airplane mode: set on', (await pg.calls('qstiles.set')).some((x) => x.p.tile === 'airplane' && x.p.on === true));
    await pg.click('.qstile[data-tile="focus"]', { wait: 300 });
    ts = await tiles(pg);
    t.check('Focus: starts, shows minutes left', ts.find((x) => x.tile === 'focus').on && /min left/.test(ts.find((x) => x.tile === 'focus').sub), ts.find((x) => x.tile === 'focus'));
    await pg.click('.qstile[data-tile="project"]', { wait: 300 });
    t.check('Project: opens the Win+P pop-up and closes quick settings', (await pg.calls('project.open')).length === 1 && !(await pg.visible('.pop.qs')));
    await pg.close();
    pg = await qs('?mode=pill');
    await pg.click('.qstile[data-tile="cast"]', { wait: 300 });
    t.check('Cast: hands to Windows\' panel', (await pg.calls('project.cast')).length === 1);
    await pg.close();

    // 3) a refusal is said under the grid; dead tiles say why
    pg = await qs('?mode=pill&qx=dead');
    ts = await tiles(pg);
    t.check('dead: Do not disturb and Airplane mode are dead with reasons', ts.find((x) => x.tile === 'dnd').dead && /quiet-hours/.test(ts.find((x) => x.tile === 'dnd').tip) && ts.find((x) => x.tile === 'airplane').dead);
    await pg.click('.qstile[data-tile="dnd"]', { wait: 200 });
    t.check('dead: a click says why in the panel, sends nothing', (await pg.calls('qstiles.set')).length === 0 && /quiet-hours/.test(await pg.text('.qsx-notes')));
    await pg.close();
    pg = await qs('?mode=pill&displays=1');
    ts = await tiles(pg);
    t.check('one display: the Project tile says so in its tip', /Only one display/.test(ts.find((x) => x.tile === 'project').tip));
    await pg.close();

    // 4) THE BUDGET: click -> the second frame with every tile drawn, 12 opens (first two dropped as warm-up)
    const measure = async (q, init) => {
      const p = await open(q, { h: 900, init: init || '' });
      const out = [];
      for (let i = 0; i < 12; i++) {
        const ms = await p.eval(() => new Promise((res) => {
          const t0 = performance.now();
          document.querySelector('#network').click();
          requestAnimationFrame(() => requestAnimationFrame(() => res(document.querySelectorAll('.qsgrid .qstile').length ? performance.now() - t0 : -1)));
        }));
        out.push(ms);
        await p.key('Escape', 120);
        if (await p.visible('.pop.qs')) await p.click('#network', { wait: 120 });
      }
      await p.close();
      return out.slice(2);
    };
    const withT = await measure('?mode=pill');
    const without = await measure('?mode=pill', 'Object.defineProperty(window, "MantleQsTiles", { value: null, writable: false });');
    const p95 = pct(withT, 0.95), p50 = pct(withT, 0.5), b95 = pct(without, 0.95);
    console.log(`  QS pagePaint WITH the new tiles: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (n=${withT.length}); without them: p95 ${b95.toFixed(1)} ms`);
    t.check(`QS pagePaint p95 <= 80 ms with the new tiles (${p95.toFixed(1)} ms)`, withT.every((x) => x >= 0) && p95 <= 80, withT);

    // 5) Win+P's pop-up page: keyboard, the current layout, one display, the question
    pg = await open('?mode=pill', { w: 420, h: 480 });
    const pp = pg.page;
    const go = async (q) => { await pp.goto(PROJECT + q, { waitUntil: 'load' }); await pp.waitForTimeout(500); };
    const view = () => pp.evaluate(() => ({
      title: document.getElementById('title').textContent,
      rows: Array.from(document.querySelectorAll('.row')).map((r) => ({ m: r.dataset.mode, sel: r.getAttribute('aria-selected') === 'true', cur: r.classList.contains('current'), dis: r.getAttribute('aria-disabled') === 'true' })),
      note: document.getElementById('note').hidden ? '' : document.getElementById('note').textContent,
      asking: !document.getElementById('ask').hidden, ask: document.getElementById('asktext').textContent,
      calls: window.__MOCK_CALLS__.map((x) => x.ch + (x.a && (x.a.to || x.a.mode) ? ':' + (x.a.to || x.a.mode) : '')),
      shown: document.getElementById('card').classList.contains('in'),
    }));
    await go('?current=extend');
    let v = await view();
    t.check('pop-up: four choices, Windows\' order, Extend marked and selected', v.rows.map((r) => r.m).join() === 'internal,clone,extend,external' && v.rows[2].cur && v.rows[2].sel, v.rows);
    t.check('pop-up: it told main it painted (and arrived)', v.calls.includes('project.painted') && v.shown, v.calls);
    if (SHOTS) await pp.locator('#card').screenshot({ path: path.join(SHOTS, 'project-popup.png') }).catch((e) => console.log('shot: ' + e.message));
    await pp.keyboard.press('ArrowDown'); await pp.waitForTimeout(80);
    v = await view();
    t.check('pop-up: Down moves to Second screen only (and tells main)', v.rows[3].sel && v.calls.includes('project.move:external'), v.calls);
    await pp.keyboard.press('ArrowDown'); await pp.waitForTimeout(80);
    t.check('pop-up: it wraps to PC screen only', (await view()).rows[0].sel);
    await pp.keyboard.press('ArrowDown'); await pp.waitForTimeout(80);
    await pp.keyboard.press('Enter'); await pp.waitForTimeout(250);
    v = await view();
    t.check('pop-up: Enter picks the selection (Duplicate)', v.calls.includes('project.pick:clone'), v.calls);
    t.check('pop-up: the 15 s question shows', v.asking && v.title === 'Keep these display settings?' && /15 s|1[0-5] s/.test(v.ask), v);
    if (SHOTS) await pp.locator('#card').screenshot({ path: path.join(SHOTS, 'project-ask.png') }).catch(() => {});
    await pp.keyboard.press('Escape'); await pp.waitForTimeout(200);
    v = await view();
    t.check('pop-up: Esc while asking = switch back (revert)', v.calls.includes('project.revert'), v.calls);
    await go('?current=extend');
    await pp.keyboard.press('Escape'); await pp.waitForTimeout(150);
    t.check('pop-up: Esc while choosing closes it', (await view()).calls.includes('project.close'));
    await go('?displays=1');
    v = await view();
    t.check('pop-up: one display says so plainly', /Only one display is connected/.test(v.note) && v.rows.filter((r) => r.dis).length === 3, v);
    await pp.keyboard.press('ArrowDown'); await pp.waitForTimeout(80);
    t.check('pop-up: one display: arrows stay on PC screen only', (await view()).rows[0].sel);
    await go('?current=extend&dark=1');
    if (SHOTS) await pp.locator('#card').screenshot({ path: path.join(SHOTS, 'project-popup-dark.png') }).catch(() => {});
    t.check('pop-up: no page errors', pg.errors.length === 0, pg.errors);
    await pg.close();
  });
  t.done();
})().catch((e) => { console.log('QSTILES PAGE TEST: crashed: ' + (e && e.stack || e)); process.exit(1); });
