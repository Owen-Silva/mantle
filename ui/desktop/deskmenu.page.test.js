require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* deskmenu.page.test.js - the desktop right-click menu in the REAL desktop page (ui/desktop/index.html +
 * deskmenu.js + deskmenu.css) in headless Chromium over file://. Never Electron, never the sidecar,
 * nothing on Owen's screen. A fake window.mantle plays lib/features/deskmenu.js (emits deskmenu.prepare /
 * deskmenu.show, answers deskmenu.place) and records every call.
 *
 * Checks, light and dark: prepare opens ONE window named mantle-deskmenu (about:blank) and a second
 * prepare reuses it; show draws the five rows in order with separators, the island styles applied (panel
 * surface, radius, the Bahnschrift face, icon glyphs), tells main its size (panel + 2 x inset) and then
 * that it painted; the menu wears the page's theme (data-theme copied, dark surface differs from light);
 * Change wallpaper / Display settings / Personalize / Mantle Settings call Mantle's commands with their
 * pages and report picked ok; widgets: Hide -> body.widgets-off, every pane hidden with no layout shift,
 * saved, the next menu says Show, and Show brings them back; a command that fails keeps the menu up with
 * the reason in warning ink, re-sized, and reports picked ok:false; a newer right-click wins over an
 * older one; menu keys (deskmenu.key): Down/Up step over separators and wrap, Home/End, one highlight
 * shared with the mouse, a stale seq ignored, Enter picks, Enter with nothing highlighted closes; no page
 * errors.
 *   node ui/desktop/deskmenu.page.test.js  -> "DESKMENU PAGE TEST: n passed, m failed"
 */
'use strict';
const path = require('path');
const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(`  FAIL ${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = `
  (function () {
    var L = {};
    window.__calls = [];
    window.__fail = {};
    window.mantle = {
      on: function (name, cb) { (L[name] = L[name] || []).push(cb); return function () {}; },
      call: function (name, args) {
        window.__calls.push({ name: name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
        if (window.__fail[name]) return Promise.reject(new Error(window.__fail[name]));
        if (name === 'sys.stats') return Promise.resolve({ cpu: 12, mem: { used: 8e9, total: 16e9 } });
        if (name === 'net.probe') return Promise.resolve({ ok: false, reason: 'refused' });
        return Promise.resolve({ ok: true });
      },
    };
    window.__emit = function (name, p) { (L[name] || []).forEach(function (cb) { cb(p); }); };
  })();
`;
const calls = (p, name) => p.evaluate((n) => window.__calls.filter((c) => c.name === n).map((c) => c.args), name);

async function run(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addInitScript(FAKE);
  await ctx.addInitScript((t) => { try { document.documentElement.setAttribute('data-theme', t); } catch (_) { /* later */ } }, theme);
  await ctx.addInitScript(() => { try { localStorage.removeItem('mantle.desktop.widgets'); } catch (_) { /* none */ } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const popups = [];
  p.on('popup', (w) => popups.push(w));
  await p.goto(PAGE);
  await sleep(400);
  // the preload sets data-theme before the first paint; an init script runs before <html> exists, so set it here
  await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

  // ---- prepare: one window, reused
  await p.evaluate(() => window.__emit('deskmenu.prepare', { seq: 1 }));
  await sleep(300);
  await p.evaluate(() => window.__emit('deskmenu.prepare', { seq: 2 }));
  await sleep(200);
  check(`${theme}: prepare opens one menu window, and a second prepare reuses it`, popups.length === 1, popups.length);
  const m = popups[0];
  if (!m) { await ctx.close(); return; }
  check(`${theme}: it is about:blank`, m.url() === 'about:blank', m.url());

  // ---- show
  async function show(seq) {
    const before = (await calls(p, 'deskmenu.painted')).length;
    await p.evaluate((s) => window.__emit('deskmenu.show', { seq: s }), seq);
    for (let i = 0; i < 40 && (await calls(p, 'deskmenu.painted')).length === before; i++) await sleep(50);
  }
  await show(3);
  const place = (await calls(p, 'deskmenu.place')).pop();
  const painted = (await calls(p, 'deskmenu.painted')).pop();
  const look = await m.evaluate(() => {
    const panel = document.querySelector('.dm-panel');
    const cs = getComputedStyle(panel);
    const rows = Array.from(document.querySelectorAll('.dm-panel > *')).map((el) => el.classList.contains('dm-sep') ? '|' : el.classList.contains('dm-note') ? '' : el.querySelector('.dm-tx').textContent).filter(Boolean);
    const r = panel.getBoundingClientRect();
    const row = document.querySelector('.dm-row');
    const ic = document.querySelector('.dm-ic');
    return { rows, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none', w: Math.ceil(r.width), h: Math.ceil(r.height),
      font: getComputedStyle(row).fontFamily, iconFont: getComputedStyle(ic).fontFamily, glyph: ic.textContent.charCodeAt(0).toString(16), theme: document.documentElement.getAttribute('data-theme'),
      ink: getComputedStyle(row).color };
  });
  check(`${theme}: five rows in order, with separators`, look.rows.join(',') === 'Change wallpaper,Display settings,Personalize,|,Hide desktop widgets,|,Mantle Settings', look.rows.join(','));
  check(`${theme}: island styles applied (a surface, rounded, a shadow, the UI face, Fluent icon glyphs)`, look.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(look.radius) >= 6 && look.shadow && /Bahnschrift/.test(look.font) && /Fluent/.test(look.iconFont) && look.glyph === 'e91b', look);
  check(`${theme}: main is told the size (panel + 2 x inset 10) for that seq`, !!place && place.seq === 3 && place.inset === 10 && place.w === look.w + 20 && place.h === look.h + 20, { place, look: [look.w, look.h] });
  check(`${theme}: then that it painted (after its frames)`, !!painted && painted.seq === 3);
  check(`${theme}: the menu wears the page's theme`, look.theme === theme, look.theme);
  run.looks = run.looks || {};
  run.looks[theme] = look;

  // ---- rows run Mantle's commands
  async function clickRow(id) {
    await m.click(`.dm-row[data-id="${id}"]`);
    await sleep(150);
  }
  await clickRow('wallpaper');
  check(`${theme}: Change wallpaper opens Mantle Wallpapers`, (await calls(p, 'wallpaper.open')).length === 1);
  await clickRow('display');
  await clickRow('personalize');
  await clickRow('settings');
  const so = await calls(p, 'settings.open');
  check(`${theme}: Display settings, Personalize and Mantle Settings open their Settings pages`, so.length === 3 && so[0].section === 'display' && so[1].section === 'personalization' && !so[2].section && so.every((a) => a.via === 'the desktop menu'), so);
  const picks = await calls(p, 'deskmenu.picked');
  check(`${theme}: each pick is reported ok (main logs it and closes the menu)`, picks.length === 4 && picks.every((x) => x.ok === true) && picks.map((x) => x.id).join() === 'wallpaper,display,personalize,settings', picks);

  // ---- widgets off / on
  const panes = () => p.evaluate(() => Array.from(document.querySelectorAll('.pane[data-cover]')).filter((el) => !el.hidden).map((el) => { const r = el.getBoundingClientRect(); return { v: getComputedStyle(el).visibility, r: [r.left, r.top, r.width, r.height].map(Math.round).join() }; }));
  const pBefore = await panes();
  await clickRow('widgets');
  const off = await p.evaluate(() => ({ cls: document.body.classList.contains('widgets-off'), saved: localStorage.getItem('mantle.desktop.widgets') }));
  const pOff = await panes();
  check(`${theme}: Hide desktop widgets hides every widget pane and saves it`, off.cls && off.saved === 'off' && pOff.length > 0 && pOff.every((x) => x.v === 'hidden'), { off, pOff });
  check(`${theme}: ...with no layout shift`, JSON.stringify(pOff.map((x) => x.r)) === JSON.stringify(pBefore.map((x) => x.r)));
  await show(4);
  const label = await m.evaluate(() => document.querySelector('.dm-row[data-id="widgets"] .dm-tx').textContent);
  check(`${theme}: the next menu offers Show desktop widgets`, label === 'Show desktop widgets', label);
  await clickRow('widgets');
  const on = await p.evaluate(() => ({ cls: document.body.classList.contains('widgets-off'), saved: localStorage.getItem('mantle.desktop.widgets') }));
  check(`${theme}: Show brings them back`, !on.cls && on.saved === 'on' && (await panes()).every((x) => x.v === 'visible'), on);

  // ---- a failing command keeps the menu up with the reason
  await p.evaluate(() => { window.__fail['settings.open'] = 'the Settings feature is turned off'; });
  await show(5);
  const placesBefore = (await calls(p, 'deskmenu.place')).length;
  await clickRow('display');
  const note = await m.evaluate(() => { const n = document.querySelector('.dm-note'); return { hidden: n.hidden, text: n.textContent, color: getComputedStyle(n).color }; });
  const lastPick = (await calls(p, 'deskmenu.picked')).pop();
  const places = await calls(p, 'deskmenu.place');
  check(`${theme}: a failed row says why in the menu, in warning ink`, !note.hidden && /Display settings did not work: the Settings feature is turned off/.test(note.text) && note.color !== run.looks[theme].ink, note);
  check(`${theme}: ...reports picked ok:false with the reason, and asks to be re-sized`, lastPick && lastPick.ok === false && /turned off/.test(lastPick.reason) && places.length === placesBefore + 1 && places[places.length - 1].seq === 5, { lastPick, n: places.length - placesBefore });
  await p.evaluate(() => { window.__fail = {}; });

  // ---- a newer right-click wins
  await p.evaluate(() => { window.__emit('deskmenu.show', { seq: 6 }); window.__emit('deskmenu.show', { seq: 7 }); });
  await sleep(400);
  const seqs = (await calls(p, 'deskmenu.place')).map((x) => x.seq).filter((s) => s >= 6);
  check(`${theme}: two right-clicks in a row: the newer one is drawn (no stale size for the older)`, seqs.includes(7), seqs);

  // ---- menu keys (main hands them over from the sidecar: deskmenu.key {seq, key})
  await m.mouse.move(1, 1);   // off every row (inside the window's clear margin)
  await show(8);
  const key = async (k, seq) => { await p.evaluate((a) => window.__emit('deskmenu.key', a), { seq: seq === undefined ? 8 : seq, key: k }); await sleep(40); };
  const hl = () => m.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.dm-row.sel'));
    const panel = document.querySelector('.dm-panel');
    const plain = document.querySelector('.dm-row:not(.sel)');
    return { ids: s.map((el) => el.dataset.id), ad: panel.getAttribute('aria-activedescendant'),
      bg: s[0] ? getComputedStyle(s[0]).backgroundColor : null, plainBg: plain ? getComputedStyle(plain).backgroundColor : null };
  });
  let h = await hl();
  check(`${theme}: keys: a fresh menu has no row highlighted`, h.ids.length === 0 && !h.ad, h);
  const walk = [];
  for (const k of ['down', 'down', 'up', 'up', 'down', 'end', 'home', 'down', 'down']) { await key(k); walk.push((await hl()).ids.join('+') || '-'); }
  check(`${theme}: keys: Down/Up step over the separators and wrap; Home/End go to the ends`,
    walk.join() === 'wallpaper,display,wallpaper,settings,wallpaper,settings,wallpaper,display,personalize', walk.join());
  h = await hl();
  check(`${theme}: keys: exactly one row is highlighted, painted, and named to assistive tech`, h.ids.length === 1 && h.ad === 'dm-personalize' && h.bg && h.bg !== h.plainBg && h.bg !== 'rgba(0, 0, 0, 0)', h);
  await key('down', 7);
  check(`${theme}: keys: a key for an older menu is ignored`, (await hl()).ids.join() === 'personalize');
  // the mouse takes the highlight, and the keys go on from where it is
  const box = await m.evaluate(() => { const r = document.querySelector('.dm-row[data-id="display"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await m.mouse.move(box.x, box.y);
  await m.mouse.move(box.x + 3, box.y);
  await sleep(60);
  check(`${theme}: keys: the mouse moving onto a row takes the highlight (one row only)`, (await hl()).ids.join() === 'display', await hl());
  await key('down');
  check(`${theme}: keys: Down goes on from the row under the mouse`, (await hl()).ids.join() === 'personalize');
  await m.mouse.move(1, 1);
  await sleep(60);
  check(`${theme}: keys: the mouse leaving the menu clears the highlight`, (await hl()).ids.length === 0, await hl());
  // Enter picks the highlighted row
  const soBefore = (await calls(p, 'settings.open')).length;
  await key('down'); await key('down'); await key('down');   // wallpaper, display, personalize
  await key('enter');
  await sleep(150);
  const so2 = await calls(p, 'settings.open');
  const pk = (await calls(p, 'deskmenu.picked')).pop();
  check(`${theme}: keys: Enter runs the highlighted row (Personalize) and reports the pick`, so2.length === soBefore + 1 && so2[so2.length - 1].section === 'personalization' && pk && pk.id === 'personalize' && pk.ok === true, { so: so2.slice(-1), pk });
  // Enter with nothing highlighted closes the menu (the key was kept from the desktop)
  await show(9);
  const hidesBefore = (await calls(p, 'deskmenu.hide')).length;
  const picksBefore = (await calls(p, 'deskmenu.picked')).length;
  await key('enter', 9);
  const hides = await calls(p, 'deskmenu.hide');
  check(`${theme}: keys: Enter with no row highlighted asks main to close the menu`, hides.length === hidesBefore + 1 && /Enter/.test(hides[hides.length - 1].why), hides.slice(-1));
  check(`${theme}: keys: ...and runs nothing`, (await calls(p, 'deskmenu.picked')).length === picksBefore &&(await calls(p, 'settings.open')).length === so2.length);

  check(`${theme}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  let browser = null;
  try {
    const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
    browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
    await run(browser, 'light');
    await run(browser, 'dark');
    const L = run.looks || {};
    check('dark and light menus differ (surface and ink)', L.light && L.dark && L.light.bg !== L.dark.bg && L.light.ink !== L.dark.ink, { light: L.light && [L.light.bg, L.light.ink], dark: L.dark && [L.dark.bg, L.dark.ink] });
  } catch (e) {
    failures.push(`  FAIL the run finished (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  console.log(`DESKMENU PAGE TEST: ${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.join('\n'));
  process.exit(failures.length ? 1 : 0);
})();
