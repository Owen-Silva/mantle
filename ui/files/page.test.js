require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* page.test.js — Mantle Files, the REAL page (index.html + model/list/panes/files.js) on its MOCK
 * (mock-mantle.js: made-up folders; nothing reads or writes a real disk), driven by clicks and keys in
 * headless Chromium over file://. Lane files-ui, 2026-09-29: a first, short pass that covers what that
 * lane changed (designed error / empty states, plain-word errors, the conflict dialog, undo in the
 * toast, progress cards with Cancel, redo feature detection, tooltips). Run it through the UI slot:
 *   bash <lanes>/bin/uislot.sh files-ui node ui/files/page.test.js
 * Prints "FILES PAGE TEST: n passed, m failed".
 */
'use strict';
const fs = require('fs');
const path = require('path');

let chromium = null;
for (const c of ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core']) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const HOME = 'C:\\Users\\Robin';
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 240)})` : name); return ok; };
const HEX = /0x[0-9a-f]{4,}|\bE(NOENT|ACCES|PERM|BUSY)\b|Windows error|sidecar|undefined|\[object/i;

async function main() {
  if (!chromium) { console.log('FILES PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = (fn, arg) => page.evaluate(fn, arg);
  const until = async (fn, arg, ms) => { try { await page.waitForFunction(fn, arg, { timeout: ms || 4000 }); return true; } catch (_) { return false; } };
  const go = async (p) => { await q((x) => MF.app.go(MF.app.cur(), x), p); await until((x) => { const t = MF.app.cur(); return t.path.toLowerCase() === x.toLowerCase() && !t.loading; }, p); };
  try {
    await page.goto(PAGE + '?path=' + encodeURIComponent(HOME + '\\Documents'));
    check('boots', await until(() => document.documentElement.dataset.ready === '1', null, 8000));

    // 1. an unreadable folder: the designed error state, plain words, Try again + Go back
    await go(HOME + '\\Private');
    const st = await q(() => { const e = document.getElementById('empty'); return { hidden: e.hidden, cls: e.className, text: e.textContent, btns: [...e.querySelectorAll('button')].map((b) => b.textContent), banner: document.getElementById('banner').hidden }; });
    check('error state shows', !st.hidden && /err/.test(st.cls), JSON.stringify(st));
    check('error state: plain words, no code', /could not be opened/.test(st.text) && /Windows did not allow this/.test(st.text) && !HEX.test(st.text), st.text);
    check('error state: Try again and Go back', st.btns.join('|') === 'Try again|Go back', st.btns.join('|'));
    check('error state: no duplicate banner', st.banner === true);
    await page.click('#empty button:has-text("Go back")');
    check('Go back leaves the error', await until(() => MF.app.cur().path.endsWith('Documents') && document.getElementById('empty').hidden));

    // 2. a search with no results: its own state and two ways on
    await q(() => MF.app.startSearch('zzqqxx'));
    await until(() => MF.app.cur().search && MF.app.cur().search.done);
    const ss = await q(() => ({ text: document.getElementById('empty').textContent, btns: [...document.querySelectorAll('#empty button')].map((b) => b.textContent) }));
    check('no-results state', /No results for "zzqqxx"/.test(ss.text), ss.text);
    check('no-results offers contents + clear', ss.btns.join('|') === 'Search file contents too|Clear the search', ss.btns.join('|'));
    await page.click('#empty button:has-text("Clear the search")');
    check('Clear the search ends it', await until(() => !MF.app.cur().search));

    // 3. Delete -> "Moved 1 item to the Recycle Bin" with Undo; Undo brings it back
    const n0 = await q(() => MF.app.cur().items.length);
    const victim = await q(() => { const t = MF.app.cur(); const i = t.shown.findIndex((x) => !x.d && !/locked/i.test(x.n)); MF.app.list.selectOnly(i); return t.shown[i].n; });
    await page.keyboard.press('Delete');
    check('recycle toast with Undo', await until(() => [...document.querySelectorAll('.toast')].some((t) => /Moved 1 item to the Recycle Bin/.test(t.textContent) && t.querySelector('.ta'))));
    await until((n) => MF.app.cur().items.length === n - 1, n0);
    await page.click('.toast .ta');
    check('Undo in the toast restores it', await until((v) => MF.app.cur().items.some((x) => x.n === v), victim, 5000), victim);

    // 4. the conflict dialog: one clash, Replace / Skip / Keep both / Cancel, Enter = Keep both
    const pick = await q(() => { const t = MF.app.cur(); return { file: t.shown.find((x) => !x.d && !/locked/i.test(x.n)).n, dir: t.shown.find((x) => x.d).n }; });
    const docs = HOME + '\\Documents';
    const sub = docs + '\\' + pick.dir;
    const copyAndPaste = async () => {
      await go(docs);
      await q((n) => { const t = MF.app.cur(); MF.app.list.selectOnly(t.index.get(n)); }, pick.file);
      await page.keyboard.press('Control+c');
      await go(sub);
      await page.keyboard.press('Control+v');
    };
    await copyAndPaste();
    await until((n) => MF.app.cur().items.some((x) => x.n === n), pick.file, 5000);
    await copyAndPaste();
    check('conflict dialog opens', await until(() => !document.getElementById('modal').hidden && document.querySelector('.dlg.conf')));
    const cd = await q(() => ({ h: document.querySelector('.dlg.conf h2').textContent, btns: [...document.querySelectorAll('.dlg .btns button')].map((b) => b.textContent), focus: document.activeElement && document.activeElement.textContent }));
    check('conflict dialog names the item and the folder', cd.h.includes(pick.file) && cd.h.includes(pick.dir), cd.h);
    check('conflict dialog buttons', cd.btns.join('|') === 'Replace|Skip|Keep both|Cancel', cd.btns.join('|'));
    check('Keep both has the focus (Enter never overwrites)', cd.focus === 'Keep both', cd.focus);
    await page.keyboard.press('Enter');
    const stem = pick.file.replace(/\.[^.]+$/, '');
    check('Keep both adds " (2)"', await until((s) => MF.app.cur().items.some((x) => x.n.startsWith(s + ' (2)')), stem, 5000));

    // 5. a slow copy shows a progress card with a Cancel button that works
    await q(() => { window.__mockSlow = true; });
    await q((n) => { const t = MF.app.cur(); MF.app.list.selectOnly(t.index.get(n)); }, pick.file);
    await page.keyboard.press('Control+c');
    await go(HOME + '\\Desktop');                   // a folder without that name: no clash, a plain copy
    await page.keyboard.press('Control+v');
    const gotCard = await until(() => document.querySelector('.pcard .pcancel'), null, 3000);
    check('progress card with Cancel', gotCard);
    if (gotCard) {
      await page.click('.pcard .pcancel');
      check('Cancel ends the card and says so', await until(() => !document.querySelector('.pcard') && [...document.querySelectorAll('.toast')].some((t) => /cancelled/i.test(t.textContent)), null, 5000));
    }
    await q(() => { window.__mockSlow = false; for (const d of document.querySelectorAll('.dlg .btns button')) if (d.textContent === 'Cancel') d.click(); });

    // 6. redo is feature-detected: no redo UI until main says it knows redo; then Ctrl+Y calls it
    check('no redo button before main announces redo', await q(() => !document.querySelector('[data-cmd="redo"]')));
    await q(() => window.mantle.emit('files.undo', { label: 'Rename of 1 item', redo: 'Recycle of 1 item' }));
    const rb = await q(() => { const b = document.querySelector('[data-cmd="redo"]'); return b && { title: b.title, disabled: b.disabled }; });
    check('redo button appears with its label and shortcut', rb && /Redo: Recycle of 1 item \(Ctrl\+Y\)/.test(rb.title) && !rb.disabled, JSON.stringify(rb));
    await page.focus('#scroller');
    await page.keyboard.press('Control+y');
    check('Ctrl+Y calls redo', await until(() => window.__mockCalls.some((c) => c.name === 'files.redo')));

    // 6a. (round 3) two clashes: "Do this for both", and ticking it answers the second too
    await go(HOME + '\\Downloads');
    await q(() => { MF.app.list.selectKeys(['Plan.docx', 'Reading list.txt']); MF.app.runCmd('copy'); });
    await go(HOME + '\\Documents');
    await q(() => MF.app.runCmd('paste'));
    const two = await until(() => document.querySelector('.dlg.conf .fck span'), null, 3000);
    const lbl = two ? await q(() => document.querySelector('.dlg.conf .fck span').textContent) : '';
    check('two clashes: "Do this for both"', lbl === 'Do this for both', lbl);
    if (two) {
      await q(() => { document.querySelector('.dlg.conf .fck input').click(); [...document.querySelectorAll('.dlg .btns button')].find((b) => b.textContent === 'Skip').click(); });
      check('ticked + Skip: no second question, nothing copied', await until(() => document.getElementById('modal').hidden && [...document.querySelectorAll('.toast')].some((t) => /Nothing was copied: every item was skipped/.test(t.textContent)), null, 3000), await q(() => JSON.stringify({ modal: document.getElementById('modal').hidden, dlg: (document.querySelector('.dlg h2') || {}).textContent, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })));
    }

    // 6b. (round 3) an empty folder, a huge folder, and Paste with nothing copied
    await go(HOME + '\\Desktop\\Sort later');
    const em = await q(() => { const e = document.getElementById('empty'); return { hidden: e.hidden, t: (e.querySelector('.st-t') || {}).textContent, s: (e.querySelector('.st-s') || {}).textContent, btns: e.querySelectorAll('button').length }; });
    check('empty folder: its own state with the next step', !em.hidden && em.t === 'This folder is empty' && /Ctrl\+V/.test(em.s) && em.btns === 0, JSON.stringify(em));
    await go(HOME + '\\Big folder');
    const big = await q(() => ({ n: MF.app.cur().items.length, dom: document.querySelectorAll('#scroller .cell').length, empty: document.getElementById('empty').hidden }));
    check('10,000 items listed, only the visible ones drawn', big.n === 10000 && big.dom > 0 && big.dom < 400 && big.empty, JSON.stringify(big));
    await q(() => window.mantle.call('files.clip', { paths: [], op: 'copy' }));
    await go(HOME + '\\Documents');
    await page.focus('#scroller');
    await page.keyboard.press('Control+v');
    check('Paste with nothing copied says what to do', await until(() => [...document.querySelectorAll('.toast')].some((t) => /Nothing to paste: copy or cut some files first/.test(t.textContent))));

    // 5b. (lane pagewords, 2026-10-14) a pattern the browser will not compile, in Rename many: plain
    // words on screen, the engine's reason as the tooltip and in the console (main copies it into mantle.log)
    const warns = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text()); });
    await go(HOME + '\\Documents');
    await q(() => { const t = MF.app.cur(); const idx = t.shown.map((x, i) => (x.d ? -1 : i)).filter((i) => i >= 0).slice(0, 2); MF.app.list.selectOnly(idx[0]); t.sel.add(MF.keyOf(t.shown[idx[1]])); MF.app.list.render(); });
    await q(() => MF.app.runCmd('rename'));
    check('rename many: the dialog opens', await until(() => !!document.querySelector('.rn-sum')));
    await page.click('.segb[data-mode="replace"]');
    await page.click('label.fck:has-text("Regular expression")');
    await page.fill('.rn-find', '(');
    await until(() => /not valid/.test(document.querySelector('.rn-sum').textContent));
    const rs = await q(() => { const s = document.querySelector('.rn-sum'); return { t: s.textContent, title: s.title }; });
    check('bad pattern: plain words', rs.t === 'That pattern is not valid: a "(" is never closed', JSON.stringify(rs));
    check('bad pattern: no engine jargon on screen', !/Invalid regular expression|\/gi?:|SyntaxError/.test(rs.t), rs.t);
    check('bad pattern: the engine\'s reason is the tooltip', /^Invalid regular expression: Unterminated group/.test(rs.title), rs.title);
    await page.fill('.rn-find', '((');
    await page.fill('.rn-find', '(');
    check('bad pattern: the reason is logged once', warns.filter((w) => /Mantle Files: rename: Invalid regular expression: Unterminated group/.test(w)).length === 1, warns.join(' | '));
    await page.fill('.rn-find', '(a)');
    check('a good pattern clears the tooltip', await until(() => !document.querySelector('.rn-sum').title));
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('.rn-sum'));

    // 5c. (lane pagewords) a bug in the page's own code after an operation: the toast says it in plain
    // words, the browser's "TypeError: ..." and where it was thrown go to the console only
    await go(HOME + '\\Documents');
    await q(() => { MF.app.list.selectOnly = () => { null.f(); }; });
    await q(() => MF.app.runCmd('newfolder'));
    check('page bug: a plain toast', await until(() => [...document.querySelectorAll('.toast.err')].some((t) => /Mantle Files hit a bug after creating a folder/.test(t.textContent))));
    const bt = await q(() => ([...document.querySelectorAll('.toast.err')].find((t) => /hit a bug/.test(t.textContent)) || {}).textContent || '');
    check('page bug: says what to do, no browser words on screen', /press F5/.test(bt) && /Mantle's log/.test(bt) && !/TypeError|Cannot read|null|\.js/.test(bt), bt);
    check('page bug: the browser\'s words and where are logged', warns.some((w) => /Mantle Files: Mantle Files hit a bug after creating a folder: TypeError: Cannot read properties of null.*\(at ui\/files\/(?:files|page)\b/.test(w) || /hit a bug after creating a folder: TypeError: Cannot read properties of null/.test(w)), warns.join(' | '));
    check('page bug: no file address in the log line', !warns.some((w) => /hit a bug/.test(w) && /file:\/\//.test(w)), warns.filter((w) => /hit a bug/.test(w)).join(' | '));
    await page.reload();
    await until(() => document.documentElement.dataset.ready === '1', null, 8000);
    await q(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

    // 7. every icon-only button says what it is
    const bare = await q(() => [...document.querySelectorAll('button')].filter((b) => !b.closest('#menus,#toasts,.hidden') && b.offsetParent && !b.textContent.trim() && !b.title).map((b) => b.id || b.className));
    check('every icon-only button has a tooltip', !bare.length, bare.join(', '));

    // 8. nothing on screen shows a code or jargon
    const body = await q(() => document.body.innerText);
    check('no codes or jargon on screen', !HEX.test(body), (body.match(HEX) || [''])[0]);
    check('no page errors', !errors.length, errors.join(' | '));

    // 9. (lane mantle-files) a COLD window draws the cached first view at once, then the live listing replaces it
    await page.goto(PAGE + '?cache=1&path=' + encodeURIComponent(HOME + '\\Documents'));
    check('cold + cache: the cached row shows before the live listing', await until(() => { const t = MF.app && MF.app.cur(); return !!(t && t.fromCache && t.items.some((x) => x.n === 'Only in the cache.txt')); }, null, 4000));
    check('cold + cache: the live listing replaces it', await until(() => { const t = MF.app.cur(); return !t.fromCache && !t.items.some((x) => x.n === 'Only in the cache.txt') && t.items.length > 1; }, null, 5000));
    check('cold + cache: painted (cached) then interactive told once each', await until(() => { const s = window.__openStages || []; return s.length === 2 && s[0].stage === 'painted' && s[0].cached && s[1].stage === 'interactive'; }, null, 4000), await q(() => JSON.stringify(window.__openStages || [])));
    // ...and when the folder is gone by then, its error replaces the cached rows (no stale list left up)
    await page.goto(PAGE + '?cache=1&path=' + encodeURIComponent(HOME + '\\Private'));
    check('cold + cache, folder unreadable: the error replaces the cached rows', await until(() => { const t = MF.app && MF.app.cur(); return !!(t && !t.fromCache && t.error && !t.items.length && !document.getElementById('empty').hidden); }, null, 5000));
    // 10. keepReady's spare: boots, waits, and only draws when an open takes it ('files.start')
    await page.goto(PAGE + '?spare=1&startms=400&path=' + encodeURIComponent(HOME + '\\Documents'));
    await new Promise((r) => setTimeout(r, 200));
    check('spare: waits for its open (no folder yet)', await q(() => document.documentElement.dataset.ready !== '1' && !(window.__mockCalls || []).some((c) => c.name === 'files.list')));
    check('spare: the open that takes it shows the folder', await until(() => document.documentElement.dataset.ready === '1' && MF.app.cur().path.endsWith('Documents') && !MF.app.cur().loading && MF.app.cur().items.length > 0, null, 5000));
    check('spare: no page errors', !errors.length, errors.join(' | '));
  } catch (e) {
    check('ran to the end', false, e.message);
  } finally {
    await browser.close();
  }
  for (const f of failures) console.log('FAIL', f);
  console.log(`FILES PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
main();
