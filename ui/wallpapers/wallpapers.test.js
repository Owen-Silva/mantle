require('../../tools/dev-env.js').lowcpu();
/* wallpapers.test.js -- the Wallpapers window, clicked and typed through (lane launch-desk, 2026-09-29).
 *
 * Headless chromium over file:// (never Electron, never the user's library): the REAL ui/wallpapers page with
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
const PAGE = 'file:///' + path.join(ROOT, 'ui', 'wallpapers', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'launch-desk');
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
  // The built-in photos: the REAL catalog and thumbs (window.__PRESETS, set by the test), with
  // failure modes: nopresets (catalog unreadable), badpreset (a photo gone, a thumb gone, a damaged
  // line), oldmain (a main that sends no presets), builtinpick (a built-in one is on the desktop).
  const presetItems = (window.__PRESETS || []).map((p) => Object.assign({ type: 'picture', typeLabel: 'Picture', preset: true, origin: 'Built in',
    health: { ok: true, reason: '' }, runtime: null, thumbNote: '' }, p));
  if (mode === 'badpreset') {
    presetItems[1].health = { ok: false, reason: 'its photo "cloud-peaks.jpg" is missing from Mantle\'s built-in wallpapers folder' };
    presetItems[2].thumbNote = 'Its small preview is missing, so the full photo is shown instead.';
  }
  if (mode === 'builtinpick') selected = 'builtin:night-fjord';
  const presetsOf = () => (mode === 'nopresets'
    ? { ok: false, reason: 'the list of built-in wallpapers (catalog.json) is missing from this copy of Mantle', note: '', categories: [], items: [] }
    : { ok: true, reason: '', note: mode === 'badpreset' ? 'In the list of built-in wallpapers, 1 line was damaged and left out.' : '',
      categories: presetItems.map((p) => p.category).filter((c, i, a) => a.indexOf(c) === i),
      items: presetItems.map((p) => Object.assign({}, p, { selected: p.id === selected })) });
  const currentOf = () => {
    const it = items.concat(presetItems).find((i) => i.id === selected);
    return it ? { id: it.id, title: it.title, type: it.type, typeLabel: it.typeLabel, preset: !!it.preset, category: it.category || '', credit: it.credit || '',
      creditUrl: it.creditUrl || '', thumbUrl: it.thumbUrl, health: it.health } : null;
  };
  let userPaused = false;
  const undo = new Map();
  let cb = null;
  const listing = () => Object.assign({
    dir: 'C:\\made\\up', loadError: '', importing: null, lively: null, livelyInstalled: false, test: false, userPaused,
    items: items.map((it) => Object.assign({}, it, { selected: it.id === selected })),
    playback: { ok: true, reason: selected ? (userPaused ? 'paused: you paused it' : 'playing') : 'no wallpaper is chosen', paused: userPaused, rulesOk: true },
    rules: { from: 'lively', reason: '', lines: [{ label: 'An app is full screen or maximised', value: 'pause', honoured: true, note: '' }] },
  }, mode === 'oldmain' ? {} : { presets: presetsOf(), current: currentOf() });
  const push = () => setTimeout(() => cb && cb(listing()), 10);
  const call = async (cmd, a) => {
    window.__calls.push([cmd, a || {}]);
    if (cmd === 'wallpaper.set') {
      const it = items.concat(presetItems).find((i) => i.id === a.id);
      if (!it) throw new Error('no such wallpaper');
      if (!it.health.ok) throw new Error('"' + it.title + '" cannot play: ' + it.health.reason);
      selected = a.id; push(); return { ok: true, id: a.id };
    }
    if (cmd === 'wallpaper.shuffle') {
      if (mode === 'shufflefail') throw new Error('none of the Snow photos can be used right now');
      const pool = presetItems.filter((p) => p.health.ok && p.id !== selected && (!a.category || a.category === 'All' || p.category === a.category));
      if (!pool.length) throw new Error('none of the built-in photos can be used right now');
      selected = pool[pool.length - 1].id; push(); return { ok: true, id: selected, title: pool[pool.length - 1].title };
    }
    if (cmd === 'wallpaper.creditOpen') {
      const p = presetItems.find((x) => x.id === a.id);
      if (!p) throw new Error('only a built-in wallpaper has a photo page');
      return { ok: true, dryRun: true, url: p.creditUrl, reason: 'Test run, nothing opened: Mantle would open ' + p.creditUrl };
    }
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

// The real built-in catalog (assets/backgrounds, read-only), shaped the way lib/wallpaper.js lists it.
const BG = path.join(ROOT, 'assets', 'backgrounds');
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
const PRESETS = JSON.parse(fs.readFileSync(path.join(BG, 'catalog.json'), 'utf8')).map((x) => ({
  id: 'builtin:' + x.file.replace(/\.[^.]+$/, '').toLowerCase(), title: x.title, category: x.category, credit: x.credit, creditUrl: x.url,
  thumbUrl: fileUrl(path.join(BG, 'thumbs', x.file)),
}));

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true, args: ['--allow-file-access-from-files'] });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(`window.__PRESETS = ${JSON.stringify(PRESETS)};`);
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

    /* ---- the built-in photos (lane mantle-bg-presets): their own view, never mixed in ---- */
    await page.goto(PAGE + '?m=main', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    const cardIds = () => page.$$eval('#grid .card[data-id]', (a) => a.map((c) => c.dataset.id));
    const tickIds = () => page.$$eval('#grid .card .tick', (a) => a.map((t) => t.closest('.card').dataset.id).join());
    const vw = await page.evaluate(() => ({ yours: document.getElementById('view-yours').getAttribute('aria-selected'), n1: document.getElementById('n-yours').textContent,
      n2: document.getElementById('n-builtin').textContent, cats: document.getElementById('cats').hidden, sh: document.getElementById('shuffle').hidden, credit: document.getElementById('credit').hidden }));
    check('views: opens on Your library when one of their own is on the desktop, with both counts', vw.yours === 'true' && vw.n1 === '6' && vw.n2 === '23' && vw.cats && vw.sh && vw.credit, JSON.stringify(vw));
    check('views: their library shows only their own cards', (await cardIds()).join() === 'w1,w2,w3,w4,w5,w6');
    await page.click('#view-builtin');
    await page.waitForTimeout(80);
    const bIds = await cardIds();
    check('built-in: 23 cards, in the catalog\'s order, none of theirs', bIds.length === 23 && bIds.join() === PRESETS.map((p) => p.id).join(), bIds.length);
    const chips = await page.$$eval('#cats .cat', (a) => a.map((c) => c.textContent + (c.getAttribute('aria-pressed') === 'true' ? '*' : '')));
    check('built-in: Helm\'s category chips, All first and chosen', chips.join('|') === 'All*|Mountains|Forest|Water|Coast|Desert|Sky & Night|Snow|City|Abstract|Minimal', chips.join('|'));
    check('built-in: Shuffle is there', await page.$eval('#shuffle', (b) => !b.hidden && b.textContent.trim() === 'Shuffle'));
    check('built-in: the credit line says where the photos are from while one of theirs is on the desktop', /Photos from Unsplash, free under the Unsplash License/.test(await page.textContent('#credit')));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#grid .card .thumb img')).slice(0, 6).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
    const th = await page.$$eval('#grid .card .thumb img', (a) => ({ n: a.length, thumbs: a.every((i) => /\/assets\/backgrounds\/thumbs\/.+\.jpg$/.test(i.src)), loaded: a.slice(0, 6).filter((i) => i.complete && i.naturalWidth > 0).length }));
    check('built-in: every card shows its real thumb (the first row loaded)', th.n === 23 && th.thumbs && th.loaded === 6, JSON.stringify(th));
    check('built-in: the card names the category and says "Photo"', /Photo/i.test(await page.textContent('.card[data-id="builtin:stone"] .chip')) && /Mountains/.test(await page.textContent('.card[data-id="builtin:stone"] .card-meta')));
    check('built-in: the hover text credits the photographer', /Photo by Fabrizio Conti on Unsplash/.test(await page.getAttribute('.card[data-id="builtin:stone"]', 'title')));
    check('built-in: no tick while one of their own is on the desktop', (await tickIds()) === '');
    await page.click('#cats .cat[data-cat="Snow"]');
    await page.waitForTimeout(60);
    check('chips: Snow shows its 2 photos and is the chosen chip', (await cardIds()).join() === 'builtin:snow-peak,builtin:snow-ridge' &&
      (await page.$$eval('#cats .cat[aria-pressed="true"]', (a) => a.map((c) => c.dataset.cat).join())) === 'Snow' && /Snow/.test(await page.getAttribute('#grid', 'aria-label')));
    await page.screenshot({ path: path.join(OUT, 'wp-08-builtin-snow.png') });
    await page.click('#shuffle');
    await page.waitForTimeout(120);
    const shCall = await lastCall('wallpaper.shuffle');
    check('shuffle: sends the chosen category', JSON.stringify(shCall) === JSON.stringify(['wallpaper.shuffle', { category: 'Snow' }]), JSON.stringify(shCall));
    check('shuffle: the photo it picked gets the tick', (await tickIds()) === 'builtin:snow-ridge');
    check('shuffle: the credit line names it and its photographer', /^Windswept ridge · /.test((await page.textContent('#credit')).trim()) && /· Photo by .+ on Unsplash/.test(await page.textContent('#credit')), await page.textContent('#credit'));
    check('header: says the built-in one is on the desktop', /on your desktop: .+ \(built in\)/.test(await page.textContent('#head-sub')), await page.textContent('#head-sub'));
    await page.click('#cats .cat[data-cat="All"]');
    await page.click('.card[data-id="builtin:stone"]');
    await page.waitForTimeout(60);
    const det = await page.evaluate(() => ({ t: document.querySelector('#detail .d-title').textContent, m: document.querySelector('#detail .d-meta').textContent,
      c: (document.querySelector('#detail .d-credit') || {}).textContent, set: document.getElementById('d-set').textContent, dis: document.getElementById('d-set').disabled,
      rm: !!document.getElementById('d-remove'), pz: !!document.getElementById('d-pause'), props: document.querySelector('#detail .props').hidden }));
    check('details: a built-in photo shows its title, "Built-in photo · Mountains" and the credit', det.t === 'Stone summit' && det.m === 'Built-in photo · Mountains' && det.c === 'Photo by Fabrizio Conti on Unsplash', JSON.stringify(det));
    check('details: Set is offered; no Remove, Pause or customising for a built-in one', det.set === 'Set as wallpaper' && !det.dis && !det.rm && !det.pz && det.props, JSON.stringify(det));
    await page.click('#d-set');
    await page.waitForTimeout(80);
    check('set: "Set as wallpaper" sets the built-in photo', JSON.stringify(await lastCall('wallpaper.set')) === JSON.stringify(['wallpaper.set', { id: 'builtin:stone' }]));
    check('set: the tick moves to it, and only it', (await tickIds()) === 'builtin:stone');
    check('set: its details say it is on the desktop', (await page.textContent('#d-set')).trim() === 'On your desktop' && await page.$eval('#d-set', (b) => b.disabled));
    check('set: the credit line under the grid names it', (await page.textContent('#credit')).replace(/\s+/g, ' ').trim() === 'Stone summit · Photo by Fabrizio Conti on Unsplash', await page.textContent('#credit'));
    await page.screenshot({ path: path.join(OUT, 'wp-09-builtin.png') });
    await page.dblclick('.card[data-id="builtin:lake"]');
    await page.waitForTimeout(80);
    check('set: a double-click sets a built-in photo', ((await lastCall('wallpaper.set')) || [])[1].id === 'builtin:lake' && (await tickIds()) === 'builtin:lake');
    await page.focus('.card[data-id="builtin:lake"]');
    await page.keyboard.press('ArrowRight');
    check('keys: arrows move between built-in cards', (await activeId()) === 'builtin:misty-lake', await activeId());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check('keys: Enter sets the built-in card', ((await lastCall('wallpaper.set')) || [])[1].id === 'builtin:misty-lake');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(50);
    check('keys: Delete on a built-in card removes nothing and says why', !(await page.evaluate(() => window.__calls.some((c) => c[0] === 'wallpaper.remove' && /^builtin:/.test(c[1].id)))) &&
      /is built in: it ships with Mantle, so it cannot be removed/.test(await page.textContent('#notice')) && await page.$eval('#notice', (n) => !n.hidden));
    await page.click('#detail .d-credit .credit-link');
    await page.waitForTimeout(60);
    check('credit: its link asks main to open that photo\'s page', JSON.stringify(await lastCall('wallpaper.creditOpen')) === JSON.stringify(['wallpaper.creditOpen', { id: 'builtin:misty-lake' }]));
    check('credit: a test run says it opened nothing', /Test run, nothing opened: Mantle would open https:\/\/unsplash\.com\//.test(await page.textContent('#notice')));
    const tok = await page.evaluate(() => {
      const probe = (v, prop) => { const d = document.createElement('div'); d.style[prop] = 'var(' + v + ')'; document.body.appendChild(d); const c = getComputedStyle(d)[prop]; d.remove(); return c; };
      const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : 'missing'; };
      return {
        chip: cs('#cats .cat[aria-pressed="true"]', 'backgroundColor') === probe('--lg-press', 'backgroundColor'),
        seg: cs('#view-builtin', 'backgroundColor') === probe('--lg-press', 'backgroundColor'),
        segInk: cs('#view-builtin', 'color') === probe('--lg-ink', 'color'),
        credit: cs('#credit', 'color') === probe('--lg-ink-3', 'color'),
        link: cs('#credit .credit-link', 'color') === probe('--lg-acc', 'color'),
        tick: cs('.card .tick', 'backgroundColor') === probe('--lg-acc', 'backgroundColor'),
        rule: cs('#credit', 'borderTopColor') === probe('--lg-edge-out', 'borderTopColor'),
      };
    });
    check('theme: the new parts resolve to the --lg-* tokens (' + (process.env.MANTLE_THEME || 'light') + ')', Object.values(tok).every(Boolean), JSON.stringify(tok));
    await page.focus('#view-builtin');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
    check('tabs: Left moves to Your library, and the keyboard goes with it', await page.evaluate(() => document.activeElement.id === 'view-yours' && document.getElementById('view-yours').getAttribute('aria-selected') === 'true') && (await cardIds()).length === 6);
    check('views: their library is untouched and none of their cards has the tick', (await cardIds()).join() === 'w1,w2,w3,w4,w5,w6' && (await tickIds()) === '');
    await page.dblclick('.card[data-id="w2"]');
    await page.waitForTimeout(80);
    check('switch back: one of their own is set again', ((await lastCall('wallpaper.set')) || [])[1].id === 'w2' && (await tickIds()) === 'w2' && !/built in/.test(await page.textContent('#head-sub')));
    await page.click('#view-builtin');
    await page.waitForTimeout(60);
    check('switch back: no built-in card keeps a tick', (await tickIds()) === '' && /Photos from Unsplash/.test(await page.textContent('#credit')));
    check('built-in: no jargon on the page', !JARGON.test(await page.evaluate(() => document.body.innerText)));

    await page.goto(PAGE + '?m=builtinpick', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    await page.waitForTimeout(80);
    check('opens on Built-in when a built-in photo is on the desktop, its details shown', (await page.getAttribute('#view-builtin', 'aria-selected')) === 'true' && (await tickIds()) === 'builtin:night-fjord' &&
      (await page.textContent('#detail .d-title')) === 'Fjord at night' && /Photo by .+ on Unsplash/.test(await page.textContent('#credit')), await page.textContent('#detail .d-title'));

    await page.goto(PAGE + '?m=badpreset', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    await page.click('#view-builtin');
    await page.waitForTimeout(60);
    const bad = await page.$eval('.card[data-id="builtin:cloud-peaks"]', (c) => ({ bad: c.classList.contains('is-bad'), text: c.textContent }));
    check('a missing photo: its card is marked and says why', bad.bad && /missing from Mantle's built-in wallpapers folder/.test(bad.text), JSON.stringify(bad));
    await page.focus('.card[data-id="builtin:cloud-peaks"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    check('a missing photo: Enter says why instead of trying', !(await page.evaluate(() => window.__calls.some((c) => c[0] === 'wallpaper.set'))) && /Can't use "Peaks in cloud"/.test(await page.textContent('#notice')));
    await page.click('.card[data-id="builtin:cloud-peaks"]');
    check('a missing photo: its Set button is off, and its details say why', await page.$eval('#d-set', (b) => b.disabled) && /missing from Mantle's built-in wallpapers folder/.test(await page.textContent('#detail .d-state')));
    check('a damaged catalog line: the note says so', /1 line was damaged and left out/.test(await page.textContent('#views-note')) && await page.$eval('#views-note', (n) => !n.hidden));
    await page.click('.card[data-id="builtin:valley-fog"]');
    check('a missing thumb: the card and the details say the full photo is shown', /small preview is missing/.test(await page.getAttribute('.card[data-id="builtin:valley-fog"]', 'title')) && /small preview is missing/.test(await page.textContent('#detail')));
    await page.screenshot({ path: path.join(OUT, 'wp-10-builtin-bad.png') });

    await page.goto(PAGE + '?m=nopresets', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    check('no catalog: the Built-in tab is marked and says why on hover', (await page.textContent('#n-builtin')) === '!' && /Can't read them: the list of built-in wallpapers/.test(await page.getAttribute('#view-builtin', 'title')));
    await page.click('#view-builtin');
    await page.waitForTimeout(60);
    const np = await page.evaluate(() => ({ empty: !document.getElementById('empty').hidden, text: document.getElementById('empty').textContent, cats: document.getElementById('cats').hidden, sh: document.getElementById('shuffle').hidden, cards: document.querySelectorAll('#grid .card').length }));
    check('no catalog: the view says why, with no chips, Shuffle or cards', np.empty && /The built-in wallpapers could not be read/.test(np.text) && /catalog\.json\) is missing/.test(np.text) && /Your own library is not affected/.test(np.text) && np.cats && np.sh && np.cards === 0, JSON.stringify(np));
    await page.screenshot({ path: path.join(OUT, 'wp-11-builtin-none.png') });

    await page.goto(PAGE + '?m=shufflefail', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    await page.click('#view-builtin');
    await page.click('#shuffle');
    await page.waitForTimeout(60);
    check('shuffle refused: the reason is on screen', /Could not shuffle: none of the Snow photos can be used right now/.test(await page.textContent('#notice')) && await page.$eval('#notice', (n) => n.classList.contains('bad')) && await page.$eval('#shuffle', (b) => !b.disabled));

    await page.goto(PAGE + '?m=oldmain', { waitUntil: 'load' });
    await page.waitForSelector('#grid .card[data-id]');
    check('an older main (no presets sent): their library still works', (await cardIds()).length === 6);
    await page.click('#view-builtin');
    await page.waitForTimeout(60);
    check('an older main: the Built-in view says why it is empty', /sent no built-in wallpapers/.test(await page.textContent('#empty')));

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
    await page.click('#empty-builtin').catch(() => {});
    await page.waitForTimeout(60);
    check('empty: "Or pick one of the built-in photos" opens the Built-in view', (await page.getAttribute('#view-builtin', 'aria-selected')) === 'true' && (await page.$$eval('#grid .card[data-id]', (a) => a.length)) === 23);
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
    await page.click('#view-builtin');
    await page.waitForTimeout(80);
    const nb = await page.evaluate(() => ({ over: document.documentElement.scrollWidth > window.innerWidth, cards: document.querySelectorAll('#grid .card').length,
      gridH: Math.round(document.getElementById('grid').getBoundingClientRect().height), chipsIn: Array.from(document.querySelectorAll('#cats .cat')).every((c) => c.getBoundingClientRect().right <= document.querySelector('.grid-pane').getBoundingClientRect().right) }));
    check('narrow: the Built-in view wraps its chips and still shows cards, no sideways scroll', !nb.over && nb.chipsIn && nb.cards === 23 && nb.gridH >= 120, JSON.stringify(nb));
    await page.screenshot({ path: path.join(OUT, 'wp-12-narrow-builtin.png') });
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

/* MANTLE_THEME=dark|light: every context this browser opens gets <html data-theme> set before first
   paint and the 'mantle-theme' event fired, the way the app's theme plumbing does it. Unset = light. */
function themeEvery(browser) {
  const t = process.env.MANTLE_THEME;
  if (!t) return;
  const nc = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await nc(o);
    await c.addInitScript((theme) => {
      let done = false;
      const set = () => {
        if (done || !document.documentElement) return;
        done = true;
        document.documentElement.dataset.theme = theme;
        window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } }));
      };
      set();
      if (!done) new MutationObserver((_, mo) => { set(); if (done) mo.disconnect(); }).observe(document, { childList: true });
    }, t);
    return c;
  };
  browser.newPage = async (o) => (await browser.newContext(o)).newPage();
}
