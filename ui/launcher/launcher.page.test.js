require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* launcher.page.test.js — the REAL launcher page (index.html + calc/groups/launcher.js) on its MOCK
 * (mock-mantle.js: a fake index, every launch/power/file/web call a dry run; nothing opens), driven by
 * keys and clicks in headless Chromium over file://. Round 3 (2026-09-30): proves the launch-ui lane's
 * page edits: one launch per decision (double Enter, held Enter, double-click), the keycap footer, the
 * loading / no-match / not-connected states, plain words (no "sidecar", codes or "undefined"), the
 * source-problem lines, PageDown/PageUp, the focus staying in the box, and Win+S with a query typed.
 * Lane mn-launch (2026-10-12, audit #5/#7): a close and reopen keeps the query (selected), an action
 * or 90 s clears it, Win+S over an open launcher applies its mode, and the no-keyboard line.
 *   bash <lanes>/bin/uislot.sh <lane> node ui/launcher/launcher.page.test.js
 * Prints "LAUNCHER PAGE TEST: n passed, m failed".
 */
'use strict';
const fs = require('fs');
const path = require('path');

let chromium = null;
for (const c of ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core']) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 240)})` : name); return ok; };
const JARGON = /0x[0-9a-f]{4,}|\bE(NOENT|ACCES|PERM|BUSY)\b|sidecar|undefined|\bnull\b|NaN|\[object/i;

/* Counts every bridge call by name (wraps the mock's call once the page has booted). */
const SPY = () => {
  window.__calls = [];
  const real = window.mantle.call;
  window.mantle.call = function (n, a) { window.__calls.push({ n, a }); return real.apply(this, arguments); };
};
/* Installed before any page script: the first apps.search answers only after 700 ms (a cold index). */
const SLOW_FIRST = () => {
  let v;
  Object.defineProperty(window, 'mantle', { configurable: true, get() { return v; }, set(m) {
    const real = m.call; let first = true;
    m.call = function (n, a) {
      if (n === 'apps.search' && first) { first = false; return new Promise((r) => setTimeout(r, 700)).then(() => real.call(m, n, a)); }
      return real.call(m, n, a);
    };
    v = m;
  } });
};

async function main() {
  if (!chromium) { console.log('LAUNCHER PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const errors = [];
  const open = async (qs, init) => {
    const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
    page.on('pageerror', (e) => errors.push(e.message));
    if (init) await page.addInitScript(init);
    await page.goto(PAGE + (qs || ''), { waitUntil: 'load' });
    return page;
  };
  const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('#results .row')].map((r) => ({ name: (r.querySelector('.name') || r).textContent, sel: r.classList.contains('is-sel'), why: (r.querySelector('.why') || {}).textContent || '' })));
  const hint = (page) => page.evaluate(() => [...document.querySelectorAll('#hint .k')].map((k) => k.textContent.trim()).join(' | '));
  const typeQ = async (page, text) => { await page.fill('#q', text); await page.waitForTimeout(260); };
  const calls = (page, n) => page.evaluate((x) => window.__calls.filter((c) => c.n === x).length, n);
  try {
    /* 1. boot: rows, keycap footer, a screen-reader count, the focus in the box */
    let page = await open('');
    await page.waitForTimeout(250);
    await page.evaluate(SPY);
    let rows = await rowsOf(page);
    check('boots with rows', rows.length > 3, rows.length);
    check('first row selected', rows[0] && rows[0].sel);
    let h = await hint(page);
    check('footer keycaps: Enter + verb, Esc Close', /^Enter (Open|Run)/.test(h) && /Esc Close$/.test(h), h);
    const counts = await page.textContent('#counts');
    check('count line says results', /^\d+ results?$/.test(counts), counts);
    check('focus in the box', await page.evaluate(() => document.activeElement.id === 'q'));

    /* 2. the source problem (the mock's commands source is broken): plain words, detail on hover */
    const src = await page.evaluate(() => [...document.querySelectorAll('#srcErrors > div')].map((d) => ({ t: d.textContent, title: d.title })));
    check('source problem in plain words', src.length === 1 && src[0].t === 'Your PowerShell commands could not be read.', JSON.stringify(src));
    check('source detail kept on hover', src[0] && /commands:/.test(src[0].title));

    /* 3. one launch per decision */
    await typeQ(page, 'chrome');
    rows = await rowsOf(page);
    check('typing finds Chrome first', rows[0] && rows[0].name === 'Chrome', rows[0] && rows[0].name);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check('double Enter launches once', await calls(page, 'apps.launch') === 1, await calls(page, 'apps.launch'));
    await page.waitForTimeout(600);
    await page.evaluate(() => document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })));
    await page.waitForTimeout(80);
    check('a held (repeating) Enter launches nothing', await calls(page, 'apps.launch') === 1, await calls(page, 'apps.launch'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check('a later Enter launches again', await calls(page, 'apps.launch') === 2, await calls(page, 'apps.launch'));
    await page.waitForTimeout(600);
    await page.dblclick('#results .row >> nth=0');
    await page.waitForTimeout(120);
    check('double-click launches once', await calls(page, 'apps.launch') === 3, await calls(page, 'apps.launch'));
    check('a click keeps the focus in the box', await page.evaluate(() => document.activeElement.id === 'q'));

    /* 4. no match: says so, the web row is the way on, Enter's verb says it */
    await typeQ(page, 'zzqqxx');
    const none = await page.evaluate(() => { const e = document.querySelector('#results .empty.is-none'); return e ? e.textContent : ''; });
    check('no-match line above the web row', /No apps, settings or commands match ‘zzqqxx’/.test(none), none);
    h = await hint(page);
    check('Enter verb on the web row', /^Enter Search the web/.test(h), h);
    check('count says 1 result', (await page.textContent('#counts')) === '1 result', await page.textContent('#counts'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    rows = await rowsOf(page);
    check('web search is a dry run note under the row', /would open/.test(rows[0] && rows[0].why) && !JARGON.test(rows[0].why), rows[0] && rows[0].why);

    /* 5. power rows: first Enter arms (the footer says Confirm / Cancel), the second sends once */
    await typeQ(page, 'restart');
    rows = await rowsOf(page);
    const ri = rows.findIndex((r) => r.name === 'Restart');
    check('Restart is listed', ri >= 0, JSON.stringify(rows.map((r) => r.name)));
    for (let i = 0; i < ri; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    h = await hint(page);
    check('armed: Enter Confirm, Esc Cancel', h === 'Enter Confirm | Esc Cancel', h);
    check('arming sends nothing', await calls(page, 'launcher.power') === 0);
    await page.keyboard.press('Enter');                       // too soon (a double press): ignored
    await page.waitForTimeout(300);
    check('a second Enter within 250 ms is not a decision', await calls(page, 'launcher.power') === 0);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    check('second Enter sends one power call, confirmed', await page.evaluate(() => { const c = window.__calls.filter((x) => x.n === 'launcher.power'); return c.length === 1 && c[0].a.confirmed === true; }));

    /* 6. PageDown / PageUp / Home / End on a long list; Tab jumps groups */
    await typeQ(page, '');
    rows = await rowsOf(page);
    await page.keyboard.press('PageDown');
    let si = (await rowsOf(page)).findIndex((r) => r.sel);
    check('PageDown moves a page', si > 1, si);
    await page.keyboard.press('PageUp');
    si = (await rowsOf(page)).findIndex((r) => r.sel);
    check('PageUp comes back to the top', si === 0, si);
    await page.keyboard.press('End');
    si = (await rowsOf(page)).findIndex((r) => r.sel);
    check('End selects the last row', si === rows.length - 1, `${si} of ${rows.length}`);
    await page.keyboard.press('Home');
    await typeQ(page, 's');
    const groups = await page.evaluate(() => document.querySelectorAll('#results .grp').length);
    if (groups > 1) {
      h = await hint(page);
      check('Tab keycap when there are groups', /Tab Next group/.test(h), h);
    }

    /* 6b. an open 30 s after the last refresh rebuilds the app list in the background, once;
       an unchanged list is not searched again */
    await page.evaluate(() => { window.__calls.length = 0; const real = Date.now; Date.now = () => real() + 31000; window.__mockShow(); });
    await page.waitForTimeout(500);
    const fresh = await page.evaluate(() => ({ idx: window.__calls.filter((c) => c.n === 'apps.index' && c.a && c.a.refresh === true).length, s: window.__calls.filter((c) => c.n === 'apps.search').length }));
    check('open after 30 s: one background rebuild', fresh.idx === 1, JSON.stringify(fresh));
    check('unchanged list: one search (the open\'s own), not two', fresh.s === 1, JSON.stringify(fresh));
    await page.evaluate(() => { window.__calls.length = 0; window.__mockShow(); });
    await page.waitForTimeout(400);
    check('a second open right after: no rebuild', await page.evaluate(() => window.__calls.filter((c) => c.n === 'apps.index' && c.a && c.a.refresh === true).length) === 0);

    /* 7. no jargon anywhere on the page */
    const body = await page.evaluate(() => document.body.innerText);
    check('no jargon on screen', !JARGON.test(body), (body.match(JARGON) || [])[0]);
    await page.close();

    /* 8. a failing launch says why under the row, in plain words */
    page = await open('?fail=1');
    await page.waitForTimeout(250);
    await typeQ(page, 'terminal');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    rows = await rowsOf(page);
    const why = (rows.find((r) => r.why) || {}).why || '';
    check('failed launch: reason under the row, no code', why && !JARGON.test(why) && /not found/.test(why), why);
    check('a file name at the start keeps its case', /^wt\.exe not found/.test(why), why);
    await page.close();

    /* 9. the helper is down: a quiet notice, no "sidecar" */
    page = await open('?state=down');
    await page.waitForTimeout(250);
    const notice = await page.evaluate(() => { const n = document.getElementById('notice'); return n.hidden ? '' : n.textContent; });
    check('helper-down notice in plain words', /App icons are unavailable/.test(notice) && !JARGON.test(notice), notice);
    await page.close();

    /* 10. a slow first answer: the loading line, then rows (no "No results" flash) */
    page = await open('', SLOW_FIRST);
    await page.waitForTimeout(300);
    const loading = await page.evaluate(() => ({ e: (document.querySelector('#results .empty') || {}).textContent || '', c: document.getElementById('counts').textContent }));
    check('loading line while the index answers', loading.e === 'Getting your apps ready…' && loading.c === 'Loading', JSON.stringify(loading));
    await page.waitForTimeout(800);
    check('rows after the slow answer', (await rowsOf(page)).length > 3);
    await page.close();

    /* 11. Win+S with a query already typed searches files for it (the reset used to cancel it) */
    // Waits for what the user sees, the Files group or a file row (zero-fail lane, 2026-10-14): a
    // blind 900 ms sleep failed on a loaded PC/runner while the mock's 50 ms open + 150 ms debounce
    // + 90 ms answer were still landing. 4 s bounds a search that never runs.
    page = await open('?mode=search&q=report');
    const seenFiles = await page.waitForFunction(() => [...document.querySelectorAll('#results .row')].some((r) => /file/.test(r.className) || r.dataset.kind === 'file')
      || [...document.querySelectorAll('#results .grp')].some((g) => /file/i.test(g.textContent)), null, { timeout: 4000, polling: 50 }).then(() => true, () => false);
    if (!seenFiles) console.log('launcher.page: the Files group did not appear within 4 s of a Win+S open with a query');
    const fileRows = await page.evaluate(() => [...document.querySelectorAll('#results .row')].filter((r) => /file/.test(r.className) || r.dataset.kind === 'file').length);
    const fileCalls = await page.evaluate(() => document.querySelectorAll('#results .row').length);
    check('Win+S query: rows shown', fileCalls > 0, fileCalls);
    h = await hint(page);
    const hasFile = await page.evaluate(() => [...document.querySelectorAll('#results .grp')].some((g) => /file/i.test(g.textContent)));
    check('Win+S query: the file search ran', hasFile || fileRows > 0, h);
    await page.close();

    /* 12. no bridge at all: one plain sentence */
    // (the mock's window.mantle is swallowed, as if no preload had run)
    page = await open('', () => { Object.defineProperty(window, 'mantle', { configurable: true, get() { return undefined; }, set() {} }); });
    await page.waitForTimeout(150);
    const dead = await page.evaluate(() => (document.querySelector('#results .empty.is-bad') || {}).textContent || '');
    check('not connected: plain sentence', /could not connect to Mantle/.test(dead) && !JARGON.test(dead), dead);
    await page.close();

    /* 13. (audit #5) a close and reopen keeps what you typed, selected; an action or 90 s clears it */
    page = await open('');
    await page.waitForTimeout(250);
    await page.evaluate(SPY);
    await page.evaluate(() => window.__mockShow());
    await typeQ(page, 'note');
    const qState = () => page.evaluate(() => { const q = document.getElementById('q'); return { v: q.value, s: q.selectionStart, e: q.selectionEnd, f: document.activeElement.id, mode: document.body.dataset.mode }; });
    await page.evaluate(() => { window.__mockHide(); window.__mockShow(); });
    await page.waitForTimeout(260);
    let qs = await qState();
    check('reopen: the query survives a close', qs.v === 'note', JSON.stringify(qs));
    check('reopen: it is selected and focused, so typing replaces it', qs.s === 0 && qs.e === 4 && qs.f === 'q', JSON.stringify(qs));
    rows = await rowsOf(page);
    check('reopen: its results are shown', rows.length > 0 && /note/i.test(rows[0].name), rows.map((r) => r.name).join());
    await page.keyboard.type('calc');
    qs = await qState();
    check('reopen: typing replaced the kept query', qs.v === 'calc', qs.v);
    await typeQ(page, 'note');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__mockHide(); window.__mockShow(); });
    await page.waitForTimeout(200);
    check('Esc then reopen: kept (Esc is a close, not an action)', (await qState()).v === 'note');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    check('Enter launched the row', (await calls(page, 'apps.launch')) === 1);
    await page.evaluate(() => { window.__mockHide(); window.__mockShow(); });
    await page.waitForTimeout(200);
    check('after an action: the next open starts clean', (await qState()).v === '');
    await typeQ(page, 'note');
    await page.evaluate(() => { window.__mockHide(); const real = Date.now; Date.now = () => real() + 91000; window.__mockShow(); Date.now = real; });
    await page.waitForTimeout(200);
    check('reopened after 90 s: starts clean', (await qState()).v === '');
    /* Win+S over an OPEN launcher: main sends launcher.open and no new launcher:visible */
    await typeQ(page, 'note');
    await page.evaluate(() => window.__mockEmit('launcher.open', { mode: 'search', query: 'report', from: 'mock' }));
    await page.waitForTimeout(260);
    qs = await qState();
    check('Win+S over an open launcher: its mode and query land', qs.mode === 'search' && qs.v === 'report' && qs.f === 'q', JSON.stringify(qs));
    await page.evaluate(() => { window.__mockHide(); window.__mockShow(); });
    await page.waitForTimeout(200);
    qs = await qState();
    check('a plain reopen after it keeps that search', qs.mode === 'search' && qs.v === 'report', JSON.stringify(qs));

    /* 14. (audit #7) no keyboard: main says why, the page shows it in words, and it goes on a close */
    const kbd = () => page.evaluate(() => { const k = document.getElementById('kbdNote'); return k ? { hidden: k.hidden, text: k.textContent, shown: !!(k.offsetWidth && k.offsetHeight) } : null; });
    check('no keyboard: the line is hidden normally', (await kbd()) && (await kbd()).hidden && !(await kbd()).shown);
    const kbText = 'No keyboard: Windows refused the foreground change. Click here to type; click outside or press Esc to close.';
    await page.evaluate((t) => window.__mockEmit('launcher.keyboard', { ok: false, text: t }), kbText);
    let kb = await kbd();
    check('no keyboard: the line is shown, in plain words', kb && !kb.hidden && kb.shown && kb.text === kbText && !JARGON.test(kb.text), JSON.stringify(kb));
    await page.evaluate(() => window.__mockEmit('launcher.keyboard', { ok: true }));
    kb = await kbd();
    check('keyboard arrived: the line goes', kb && kb.hidden && !kb.shown, JSON.stringify(kb));
    await page.evaluate((t) => window.__mockEmit('launcher.keyboard', { ok: false, text: t }), kbText);
    await page.evaluate(() => window.__mockHide());
    kb = await kbd();
    check('closed: the line goes with it', kb && kb.hidden, JSON.stringify(kb));
    await page.close();

    /* the blur fails (lane pagewords, 2026-10-14): dark theme, and the browser refuses to draw the
       backdrop picture the way Chromium does (InvalidStateError from drawImage). The footer says it in
       true plain words (the picture arrived; it is the blur that failed), the browser's reason is the
       line's tooltip and goes to the console (main copies it into mantle.log), never on screen. */
    page = await open('', () => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', 'dark'));
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (img) {
        if (img && img.id === 'backdrop') throw new DOMException("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The HTMLImageElement provided is in the 'broken' state.", 'InvalidStateError');
        return draw.apply(this, arguments);
      };
    });
    const consoleLines = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consoleLines.push(m.text()); });
    const blurLine = () => page.evaluate(() => [...document.querySelectorAll('#srcErrors > div')].map((d) => ({ t: d.textContent, title: d.title })).find((x) => /see-through/.test(x.t)) || null);
    let bl = null;
    for (let i = 0; i < 20 && !bl; i++) { await page.waitForTimeout(100); bl = await blurLine(); }
    check('blur fails: a true plain line in the footer', bl && bl.t === 'The see-through effect is off: the picture behind this window could not be blurred.', JSON.stringify(bl));
    check('blur fails: no browser words on screen', bl && !/drawImage|InvalidStateError|HTMLImageElement|DOMException/.test(bl.t), bl && bl.t);
    check('blur fails: the browser\'s reason is the tooltip', bl && /^no blur: the picture behind the launcher could not be blurred: InvalidStateError: Failed to execute 'drawImage'/.test(bl.title), bl && bl.title);
    await page.waitForTimeout(100);
    check('blur fails: the reason is logged once', consoleLines.filter((l) => /launcher: no blur: the picture behind the launcher could not be blurred: InvalidStateError/.test(l)).length === 1, consoleLines.join(' | '));
    check('blur fails: no dark wall was claimed', await page.evaluate(() => !window.__launcherWall));
    await page.close();

    /* ---- Win+R: Run mode (lane keysrun, 2026-10-15) ---- */
    const st = (p) => p.evaluate(() => { const q = document.getElementById('q'); return { mode: document.body.dataset.mode, q: q.value, ph: q.placeholder, ro: q.readOnly, all: q.selectionStart === 0 && q.selectionEnd === q.value.length && q.value.length > 0, hidden: document.documentElement.dataset.mockHidden || '' }; });
    const heads = (p) => p.evaluate(() => [...document.querySelectorAll('#results .grp')].map((g) => g.textContent));
    const lastArgs = (p, n) => p.evaluate((x) => { const c = window.__calls.filter((k) => k.n === x); return c.length ? c[c.length - 1].a : null; }, n);
    const whys = (p) => p.evaluate(() => [...document.querySelectorAll('#results .why')].map((w) => w.textContent));
    page = await open('');
    await page.waitForTimeout(150);
    await page.evaluate(SPY);
    await page.evaluate(() => window.__mockOpen('run', ''));
    await page.waitForTimeout(150);
    let s = await st(page);
    check('run: Win+R opens Run mode', s.mode === 'run' && /program, folder, document or website/.test(s.ph) && !s.ro, JSON.stringify(s));
    check('run: the last line is in the box, selected (as Windows\' Run box)', s.q === 'perfmon /report' && s.all, JSON.stringify(s));
    check('run: nothing searched on the way up (no apps.search, no file query)', (await calls(page, 'apps.search')) === 0 && (await calls(page, 'launcher.files')) === 0 && (await calls(page, 'search.files')) === 0);
    check('run: the history was asked for once', (await calls(page, 'run.history')) === 1);
    let rr = await rowsOf(page);
    check('run: row 0 is the line, then Recent', rr[0].name === 'perfmon /report' && rr[0].sel && rr.some((x) => x.name === '%appdata%\\.minecraft') && JSON.stringify(await heads(page)) === '["Run","Recent"]', JSON.stringify(rr));
    check('run: the footer names Run, admin and Esc', /Enter Run \| Ctrl\+Shift\+Enter As administrator \| Esc Close/.test(await hint(page)), await hint(page));
    await typeQ(page, '%app');
    rr = await rowsOf(page);
    check('run: typing filters the history at once (starts-with first)', rr.map((x) => x.name).join('|') === '%app|%appdata%\\.minecraft|%appdata%', rr.map((x) => x.name).join('|'));
    await typeQ(page, '%appdata%\\.m');
    rr = await rowsOf(page);
    check('run: the folder being typed in completes', rr.some((x) => x.name === '%appdata%\\.minecraft\\') && (await heads(page)).includes('In this folder'), JSON.stringify(rr));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    check('run: Tab copies the selected row into the box', (await st(page)).q === '%appdata%\\.minecraft', (await st(page)).q);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    let la = await lastArgs(page, 'run.exec');
    check('run: Enter sends the line as typed, not as admin', la && la.line === '%appdata%\\.minecraft' && la.admin === false, JSON.stringify(la));
    check('run: the dry run says where it went (a folder: Mantle Files)', (await whys(page)).some((w) => /would open Mantle Files at %appdata%\\.minecraft/.test(w)), JSON.stringify(await whys(page)));
    await typeQ(page, 'perfmon /report');
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForTimeout(150);
    la = await lastArgs(page, 'run.exec');
    check('run: Ctrl+Shift+Enter runs it as administrator', la && la.line === 'perfmon /report' && la.admin === true, JSON.stringify(la));
    await typeQ(page, 'notarealprogram');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const wn = await whys(page);
    check('run: an unknown command gets plain words under it, and the launcher stays', wn.includes('Windows can\'t find "notarealprogram". Check the spelling, then try again.') && !(await st(page)).hidden, JSON.stringify(wn));
    check('run: the error has no jargon', wn.every((w) => !JARGON.test(w)), JSON.stringify(wn));
    await typeQ(page, 'Sys');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    la = await lastArgs(page, 'run.exec');
    check('run: Enter on a history row runs that row', la && la.line === 'SystemPropertiesPerformance.exe' && (await st(page)).q === 'SystemPropertiesPerformance.exe', JSON.stringify(la));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    check('run: Esc closes', (await st(page)).hidden === '1');
    await page.evaluate(() => { window.__mockHide(); delete document.documentElement.dataset.mockHidden; window.__mockShow(); });
    await page.waitForTimeout(150);
    s = await st(page);
    check('run: a Win tap afterwards is the plain launcher', s.mode === 'apps' && !s.ro && s.q === '', JSON.stringify(s));
    await page.close();

    /* the UAC prompt took the screen and the launcher closed: a refused admin run brings it back with why */
    page = await open('?runcancel=1');
    await page.waitForTimeout(150);
    await page.evaluate(SPY);
    await page.evaluate(() => window.__mockOpen('run', ''));
    await page.waitForTimeout(120);
    await typeQ(page, 'regedit');
    await page.evaluate(() => window.__mockHide());
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForTimeout(250);
    s = await st(page);
    const wc = await whys(page);
    check('run: a refused UAC prompt reopens Run with the line and why', (await calls(page, 'launcher.show')) === 1 && s.mode === 'run' && s.q === 'regedit' &&
      wc.includes('You said no to the administrator prompt, so "regedit" didn\'t run.'), JSON.stringify({ s, wc }));
    await page.close();

    /* ---- Win+X: Quick links ---- */
    page = await open('');
    await page.waitForTimeout(150);
    await page.evaluate(SPY);
    await page.evaluate(() => window.__mockOpen('quick', ''));
    await page.waitForTimeout(150);
    s = await st(page);
    rr = await rowsOf(page);
    const letters = () => page.evaluate(() => [...document.querySelectorAll('#results .row .name u')].map((u) => u.textContent).join(''));
    check('quick: Win+X opens Quick links (the box takes no text)', s.mode === 'quick' && s.ro, JSON.stringify(s));
    check('quick: Windows\' rows in Windows\' order', rr.map((x) => x.name).join('|') === 'Installed apps|Mobility Center|Power Options|Event Viewer|System|Device Manager|Network Connections|Disk Management|Computer Management|Terminal|Terminal (Admin)|Task Manager|Settings|File Explorer|Search|Run|Shut down or sign out|Desktop', rr.map((x) => x.name).join('|'));
    check('quick: Windows\' underlined letters', (await letters()) === 'pbOVyMwkgiATnESRuD', await letters());
    check('quick: grouped, and nothing searched', JSON.stringify(await heads(page)) === '["Tools","Open","Power and desktop"]' && (await calls(page, 'apps.search')) === 0);
    await page.keyboard.press('m');
    await page.waitForTimeout(120);
    la = await lastArgs(page, 'quicklinks.open');
    check('quick: M opens Device Manager (the id only goes to main)', la && la.link === 'devices' && Object.keys(la).join() === 'link' && (await whys(page)).includes('dry run: would open Device Manager'), JSON.stringify(la));
    await page.keyboard.press('Shift+A');
    await page.waitForTimeout(120);
    la = await lastArgs(page, 'quicklinks.open');
    check('quick: a capital letter works too (A = Terminal (Admin))', la && la.link === 'terminaladmin', JSON.stringify(la));
    const before = await calls(page, 'quicklinks.open');
    await page.keyboard.press('z');
    await page.waitForTimeout(80);
    check('quick: a letter with no row does nothing', (await calls(page, 'quicklinks.open')) === before && (await st(page)).q === '');
    await page.keyboard.press('u');
    await page.waitForTimeout(120);
    rr = await rowsOf(page);
    check('quick: U opens the Shut down or sign out submenu, Windows\' letters', rr.map((x) => x.name).join('|') === 'Sign out|Sleep|Hibernate|Shut down|Restart' && (await letters()) === 'iSHuR', rr.map((x) => x.name).join('|') + ' ' + (await letters()));
    await page.keyboard.press('u');
    await page.waitForTimeout(120);
    rr = await rowsOf(page);
    check('quick: U once arms Shut down (asks first), nothing sent', rr.some((x) => x.name === 'Press U again to shut down') && (await calls(page, 'launcher.power')) === 0, JSON.stringify(rr));
    await page.waitForTimeout(300);
    await page.keyboard.press('u');
    await page.waitForTimeout(150);
    la = await lastArgs(page, 'launcher.power');
    check('quick: U again shuts down (dry run, confirmed)', la && la.action === 'shutdown' && la.confirmed === true, JSON.stringify(la));
    await page.keyboard.press('s');
    await page.waitForTimeout(150);
    la = await lastArgs(page, 'launcher.power');
    check('quick: S sleeps at once (Sleep does not ask)', la && la.action === 'sleep' && la.confirmed === false, JSON.stringify(la));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('quick: Esc in the submenu goes back to Quick links', (await rowsOf(page)).length === 18 && !(await st(page)).hidden);
    await page.keyboard.press('r');
    await page.waitForTimeout(150);
    s = await st(page);
    check('quick: R switches to Run in the same window', s.mode === 'run' && !s.ro && s.q === 'perfmon /report', JSON.stringify(s));
    await page.evaluate(() => window.__mockEmit('launcher.open', { mode: 'quick', query: '', from: 'mock' }));
    await page.waitForTimeout(120);
    check('quick: Win+X over Run brings Quick links back', (await st(page)).mode === 'quick' && (await rowsOf(page)).length === 18);
    await page.keyboard.press('d');
    await page.waitForTimeout(120);
    check('quick: D is Desktop', ((await lastArgs(page, 'quicklinks.open')) || {}).link === 'desktop');
    await page.evaluate(() => window.__mockEmit('launcher.open', { mode: 'quick', query: '', from: 'mock' }));
    await page.waitForTimeout(80);
    check('quick: Win+X again closes it, as Windows\' does', (await st(page)).hidden === '1');
    check('quick: every line on screen is plain words', (await whys(page)).every((w) => !JARGON.test(w)), JSON.stringify(await whys(page)));
    await page.close();

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures.push('crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e));
  } finally {
    await browser.close();
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`LAUNCHER PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
main();
