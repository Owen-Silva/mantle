require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* wallpapers.test.js -- the Wallpapers window, clicked and typed through (lane launch-desk, 2026-09-29).
 *
 * Headless chromium over file:// (never Electron, never Owen's library): the REAL ui/wallpapers page with
 * a fake window.mantle (FAKE below) that plays lib/wallpaper.js's side over MADE-UP wallpapers, records
 * every call, and pushes a new listing after each change the way main does. Checks the common tasks:
 * pick, set (click, double-click, Enter), arrow-key grid navigation, remove + Undo, Pause/Play, Esc,
 * a drop that carries no files, and the designed empty / loading / failed / broken-wallpaper states.
 * Shots go to MANTLE_SHOOT_OUT (default <lane dir>/shots/desk). Line 1 is the machine-wide CPU cap.
 *
 *   node ui/wallpapers/wallpapers.test.js                    the dev tree (must pass)
 *   node ui/wallpapers/wallpapers.test.js --base=<dir>       serve <dir>/ui/wallpapers/*.{js,css,html}
 *                                                            instead (the pre-pass page: expected to FAIL)
 * Run it through the lane's uislot.sh. Prints "WALLPAPERS PAGE TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///' + path.join(ROOT, 'ui', 'wallpapers', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/7e5085b9-5bec-43fe-aecd-5fe5701b290a/scratchpad/lanes/launch/shots/desk';
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7);

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

/* Runs IN THE PAGE before its scripts. Everything here is made up. */
const FAKE = String.raw`(() => {
  const mode = new URLSearchParams(location.search).get('m') || 'main';
  window.__calls = [];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhQHwZ6hNWgAAAABJRU5ErkJggg==';
  const mk = (id, title, extra) => Object.assign({ id, title, type: 'video', typeLabel: 'Video', thumbUrl: png, needsThumb: false, probeUrl: null,
    origin: 'Added 2026-09-20', originPath: '', desc: '', author: '', health: { ok: true, reason: '' }, runtime: null, hasProps: false, sysinfo: false }, extra || {});
  let items = mode === 'empty' ? [] : [
    mk('w1', 'Earth from space'),
    mk('w2', 'Rain on glass', { type: 'picture', typeLabel: 'Picture' }),
    mk('w3', 'A very long wallpaper name that goes on and on well past the edge of its own card'),
    mk('w4', 'Aurora', { type: 'gif', typeLabel: 'GIF' }),
    mk('w5', 'Gone video', { health: { ok: false, reason: 'its file "gone.mp4" is missing from Mantle\'s wallpaper folder. Remove it, then add it again' } }),
    mk('w6', 'Night city'),
  ];
  let selected = items.length ? 'w1' : null;
  let userPaused = false;
  const undo = new Map();
  let cb = null;
  const listing = () => ({
    dir: 'C:\\made\\up', loadError: '', importing: null, lively: null, livelyInstalled: false, test: false, userPaused,
    items: items.map((it) => Object.assign({}, it, { selected: it.id === selected })),
    playback: { ok: true, reason: selected ? (userPaused ? 'paused: you paused it' : 'playing') : 'no wallpaper is chosen', paused: userPaused, rulesOk: true },
    rules: { from: 'lively', reason: '', lines: [{ label: 'An app is full screen or maximised', value: 'pause', honoured: true, note: '' }] },
  });
  const push = () => setTimeout(() => cb && cb(listing()), 10);
  const call = async (cmd, a) => {
    window.__calls.push([cmd, a || {}]);
    if (cmd === 'wallpaper.set') { if (!items.find((i) => i.id === a.id)) throw new Error('no such wallpaper'); selected = a.id; push(); return { ok: true }; }
    if (cmd === 'wallpaper.remove') {
      const i = items.findIndex((x) => x.id === a.id);
      undo.set(a.id, { it: items[i], i, sel: selected === a.id });
      items.splice(i, 1);
      if (selected === a.id) selected = items[0] ? items[0].id : null;
      push();
      return { ok: true, selected, undoMs: 20000 };
    }
    if (cmd === 'wallpaper.undoRemove') { const u = undo.get(a.id); if (!u) throw new Error('too late'); items.splice(u.i, 0, u.it); if (u.sel) selected = a.id; undo.delete(a.id); push(); return { ok: true }; }
    if (cmd === 'wallpaper.setPaused') { userPaused = !!a.paused; push(); return { ok: true, paused: userPaused }; }
    if (cmd === 'wallpaper.add') return { canceled: true, results: [] };
    if (cmd === 'wallpaper.window') return { ok: true };
    if (cmd === 'wallpaper.list') { if (mode === 'down') throw new Error('Mantle is not answering'); return listing(); }
    return { ok: true };
  };
  if (mode === 'down') { window.mantle = { call }; return; }
  window.mantle = {
    call,
    pathForFile: () => '',
    on(name, fn) {
      if (name === 'wallpaper.library') { cb = fn; setTimeout(() => fn(listing()), mode === 'slow' ? 1500 : 0); }
      return () => {};
    },
  };
})();`;

const JARGON = /sidecar|hwnd|\bIPC\b|renderer|dryRun|undefined|\bnull\b|NaN|\[object|Chromium|ENOENT|0x8007/;

async function run() {
  if (!fs.existsSync(CHROME)) { failures.push('no chromium at ' + CHROME); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(FAKE);
    if (BASE) {
      await ctx.route(/\/ui\/wallpapers\/(wallpapers\.(js|css)|index\.html)(\?.*)?$/, (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop();
        route.fulfill({ path: path.join(BASE, 'ui', 'wallpapers', name) });
      });
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const calls = () => page.evaluate(() => window.__calls.slice());
    const lastCall = async (cmd) => (await calls()).filter((c) => c[0] === cmd).pop() || null;
    const activeId = () => page.evaluate(() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null);

    /* ---- loading, then the grid ---- */
    await page.goto(PAGE + '?m=slow', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const skel = await page.$$eval('#grid .card.skel', (a) => a.length);
    check('loading: placeholder cards before the library arrives', skel >= 3, skel);
    await page.screenshot({ path: path.join(OUT, 'wp-01-loading.png') });
    await page.waitForSelector('#grid .card[data-id]', { timeout: 4000 }).catch(() => {});

    await page.goto(PAGE + '?m=main', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]', { timeout: 4000 });
    await page.waitForTimeout(100);
    check('grid: every wallpaper is a card', (await page.$$eval('#grid .card[data-id]', (a) => a.length)) === 6);
    check('grid: the one on the desktop has a tick, and only it', (await page.$$eval('#grid .card .tick', (a) => a.map((t) => t.closest('.card').dataset.id).join())) === 'w1');
    const tabStops = await page.$$eval('#grid .card[data-id]', (a) => a.filter((c) => c.tabIndex === 0).length);
    check('grid: one tab stop for the whole grid', tabStops === 1, tabStops);
    check('details: the one on the desktop is shown first, with its state', /Earth from space/.test(await page.textContent('#detail .d-title')) && (await page.textContent('#d-set')).trim() === 'On your desktop' && await page.$eval('#d-set', (b) => b.disabled));
    const long = await page.$eval('.card[data-id="w3"] .card-title', (e) => ({ cut: e.scrollWidth > e.clientWidth, title: e.closest('.card').title }));
    check('grid: a long name is cut with an ellipsis and shown whole on hover', long.cut && long.title.startsWith('A very long wallpaper name that goes on and on well past the edge of its own card'), JSON.stringify(long));
    await page.screenshot({ path: path.join(OUT, 'wp-02-grid.png') });

    /* ---- pick, then set with the button ---- */
    await page.click('.card[data-id="w2"]');
    check('pick: a click shows that wallpaper on the right', /Rain on glass/.test(await page.textContent('#detail .d-title')));
    check('pick: the picked card gets the grey wash', await page.$eval('.card[data-id="w2"]', (c) => c.classList.contains('is-focus')));
    check('set: the primary action says what it does', (await page.textContent('#d-set')).trim() === 'Set as wallpaper');
    await page.click('#d-set');
    await page.waitForTimeout(80);
    check('set: "Set as wallpaper" sets that one', JSON.stringify((await lastCall('wallpaper.set')) || []) === JSON.stringify(['wallpaper.set', { id: 'w2' }]));
    check('set: the tick moves to it', (await page.$$eval('#grid .card .tick', (a) => a.map((t) => t.closest('.card').dataset.id).join())) === 'w2');

    /* ---- double-click sets ---- */
    await page.dblclick('.card[data-id="w4"]');
    await page.waitForTimeout(80);
    check('set: a double-click sets it', ((await lastCall('wallpaper.set')) || [])[1] && (await lastCall('wallpaper.set'))[1].id === 'w4');

    /* ---- keyboard ---- */
    await page.focus('.card[data-id="w1"]');
    await page.keyboard.press('ArrowRight');
    check('keys: Right moves to the next card', (await activeId()) === 'w2', await activeId());
    const cols = await page.evaluate(() => { const c = Array.from(document.querySelectorAll('#grid .card')); return c.findIndex((x) => x.offsetTop !== c[0].offsetTop); });
    await page.keyboard.press('ArrowDown');
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
    check('keys: Down moves a whole row', (await activeId()) === ids[Math.min(5, 1 + (cols > 0 ? cols : 6))], `${await activeId()} cols=${cols}`);
    await page.keyboard.press('End');
    check('keys: End goes to the last card', (await activeId()) === 'w6');
    await page.keyboard.press('Home');
    check('keys: Home goes to the first card', (await activeId()) === 'w1');
    check('keys: the details follow the keyboard', /Earth from space/.test(await page.textContent('#detail .d-title')));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check('keys: Enter sets the card', ((await lastCall('wallpaper.set')) || [])[1] && (await lastCall('wallpaper.set'))[1].id === 'w3');

    /* ---- remove, with undo ---- */
    await page.focus('.card[data-id="w6"]');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(100);
    check('remove: Delete removes at once (no "are you sure")', JSON.stringify(await lastCall('wallpaper.remove')) === JSON.stringify(['wallpaper.remove', { id: 'w6' }]));
    check('remove: the card is gone', !(await page.$('.card[data-id="w6"]')));
    const nt = await page.$eval('#notice', (n) => ({ shown: !n.hidden, text: n.textContent }));
    check('remove: the notice says what was removed and offers Undo', nt.shown && /Removed "Night city"/.test(nt.text) && !!(await page.$('#undo')), JSON.stringify(nt));
    const ul = await page.$eval('#undo', (b) => { const s = getComputedStyle(b); return { bg: s.backgroundColor, bw: s.borderTopWidth, col: s.color }; }).catch(() => null);
    check('remove: Undo is a quiet accent word, not a grey system button', !!ul && /rgba\(0, 0, 0, 0\)|transparent/.test(ul.bg) && ul.bw === '0px', JSON.stringify(ul));
    await page.screenshot({ path: path.join(OUT, 'wp-03-undo.png') });
    await page.click('#undo');
    await page.waitForTimeout(100);
    check('undo: it comes back', !!(await page.$('.card[data-id="w6"]')) && (await lastCall('wallpaper.undoRemove')) !== null);
    await page.click('.card[data-id="w5"]');
    await page.click('#d-remove');
    await page.waitForTimeout(100);
    check('remove: the Remove button works too and moves the pick on', JSON.stringify(await lastCall('wallpaper.remove')) === JSON.stringify(['wallpaper.remove', { id: 'w5' }]) && /Night city|Aurora/.test(await page.textContent('#detail .d-title')));

    /* ---- Pause / Play ---- */
    await page.click('.card .tick');
    const pz = await page.$('#d-pause');
    check('pause: the wallpaper on the desktop has a Pause button', !!pz && (await pz.textContent()).trim() === 'Pause');
    if (pz) {
      await pz.click();
      await page.waitForTimeout(100);
      const after = await page.$eval('#d-pause', (b) => ({ t: b.textContent.trim(), p: b.getAttribute('aria-pressed') }));
      check('pause: pressing it pauses, and it then says Play', JSON.stringify(await lastCall('wallpaper.setPaused')) === JSON.stringify(['wallpaper.setPaused', { paused: true }]) && after.t === 'Play' && after.p === 'true', JSON.stringify(after));
      await page.screenshot({ path: path.join(OUT, 'wp-04-paused.png') });
      await page.click('#d-pause');
      await page.waitForTimeout(100);
      check('pause: Play plays it again', ((await lastCall('wallpaper.setPaused')) || [])[1].paused === false);
    }

    /* ---- a broken wallpaper ---- */
    await page.goto(PAGE + '?m=main', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    await page.click('.card[data-id="w5"]');
    check('broken: its card says why in plain words', /missing from Mantle's wallpaper folder/.test(await page.textContent('.card[data-id="w5"]')));
    check('broken: "Set as wallpaper" is off for it', await page.$eval('#d-set', (b) => b.disabled));
    const look = await page.evaluate(() => {
      const d = getComputedStyle(document.getElementById('d-set')).backgroundColor;
      const probe = document.createElement('button'); probe.className = 'btn primary'; document.body.appendChild(probe);
      const on = getComputedStyle(probe).backgroundColor; probe.remove();
      return { d, on, cardState: document.querySelector('.card[data-id="w5"] .card-bad, .card[data-id="w5"]').textContent };
    });
    check('broken: its off "Set as wallpaper" does not look pressable (no accent fill)', look.d !== look.on, JSON.stringify(look));
    check('broken: the reason starts a sentence (capital letter)', /Its file/.test(look.cardState), look.cardState);
    await page.focus('.card[data-id="w5"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    const bn = await page.$eval('#notice', (n) => ({ shown: !n.hidden, bad: n.classList.contains('bad'), text: n.textContent }));
    check('broken: Enter on it says why instead of trying (not silent)', !(await page.evaluate(() => window.__calls.some((c) => c[0] === 'wallpaper.set' && c[1] && c[1].id === 'w5'))) &&
      bn.shown && bn.bad && /Can't use "/.test(bn.text) && /missing from Mantle's wallpaper folder/.test(bn.text), JSON.stringify(bn));

    /* ---- a drop with no files; Esc ---- */
    await page.evaluate(() => { const e = new Event('drop', { bubbles: true, cancelable: true }); e.dataTransfer = { files: [], types: [] }; window.dispatchEvent(e); });
    check('drop: a drop that carries no files says so', /Nothing was added/.test(await page.textContent('#notice')) && await page.$eval('#notice', (n) => !n.hidden));
    await page.focus('.card[data-id="w1"]');
    await page.keyboard.press('Escape');
    check('Esc: first dismisses the notice', await page.$eval('#notice', (n) => n.hidden));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    check('Esc: then closes the window', JSON.stringify(await lastCall('wallpaper.window')) === JSON.stringify(['wallpaper.window', { action: 'close' }]));
    const txt = await page.evaluate(() => document.body.innerText);
    check('words: no jargon anywhere on the page', !JARGON.test(txt), (txt.match(JARGON) || [])[0]);

    /* ---- empty, and a library that cannot be read ---- */
    await page.goto(PAGE + '?m=empty', { waitUntil: 'load' });
    await page.waitForTimeout(150);
    const em = await page.$eval('#empty', (e) => ({ shown: !e.hidden, text: e.textContent, btn: !!e.querySelector('button') }));
    check('empty: says there are none and offers "Add wallpapers…"', em.shown && /No wallpapers yet/.test(em.text) && em.btn, JSON.stringify(em));
    const mid = await page.evaluate(() => { const p = document.querySelector('.grid-pane').getBoundingClientRect(); const b = document.querySelector('#empty b').getBoundingClientRect(); return (b.top - p.top) / p.height; });
    check('empty: the message sits in the middle of the pane, not at its foot', mid > 0.25 && mid < 0.6, mid.toFixed(2));
    if (em.btn) {
      await page.click('#empty button');
      await page.waitForTimeout(50);
      check('empty: its button opens the add dialog', JSON.stringify(await lastCall('wallpaper.add')) === JSON.stringify(['wallpaper.add', { pick: 'files' }]));
    }
    await page.screenshot({ path: path.join(OUT, 'wp-05-empty.png') });
    await page.goto(PAGE + '?m=down', { waitUntil: 'load' });
    await page.waitForTimeout(150);
    const dn = await page.$eval('#empty', (e) => ({ shown: !e.hidden, text: e.textContent }));
    check('failed: a library that cannot be read says so and what to do', dn.shown && /could not be read/.test(dn.text) && /open it again/.test(dn.text), JSON.stringify(dn));
    check('failed: no placeholder cards are left spinning', (await page.$$eval('#grid .card.skel', (a) => a.length)) === 0);
    await page.screenshot({ path: path.join(OUT, 'wp-06-failed.png') });

    /* ---- narrow window ---- */
    await page.setViewportSize({ width: 760, height: 480 });
    await page.goto(PAGE + '?m=main', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('narrow: the smallest window has no sideways scroll', !over);
    const setVis = await page.evaluate(() => { const b = document.getElementById('d-set'); if (!b) return 'no button'; const r = b.getBoundingClientRect(); return r.bottom <= innerHeight ? 'ok' : 'below the fold at ' + Math.round(r.bottom); });
    check('narrow: the details show "Set as wallpaper" without scrolling', setVis === 'ok', setVis);
    await page.screenshot({ path: path.join(OUT, 'wp-07-narrow.png') });
    check('page: no script errors', !errors.length, errors.join(' | '));
  } finally {
    await browser.close();
  }
}

run().catch((err) => failures.push('crashed: ' + (err && err.message ? err.message.split('\n')[0] : err))).finally(() => {
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALLPAPERS PAGE TEST${BASE ? ' (against base)' : ''}: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
