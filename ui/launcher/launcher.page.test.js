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
    page = await open('?mode=search&q=report');
    await page.waitForTimeout(900);
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
