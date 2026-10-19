require('../../tools/dev-env.js').lowcpu();
/* kit-field.test.js — a kit text / number box springs back ON SCREEN when its change does not take, even
 * while the box still has focus (lane mn-suite, 2026-10-12).
 *
 * WHY: the kit never rewrote a focused box, so after a refusal, a dry run or a declined administrator
 * prompt the person's rejected text stayed in the box while the stored value had sprung back (the PC
 * rename "empty name springs back" bug). act() now forces the repaint on every spring-back and on a
 * read-back value.
 *
 * Drives the real ui/settings/kit.js in headless chromium (file://, the settings mock page so kit.js and
 * its CSS load as in the app): SettingsSections.create() with a minimal deps object, K.text() / K.number()
 * rows in the page, real typing into a focused box, then 'change' fired WITHOUT a blur (Enter-to-commit
 * keeps focus). Nothing real is read or written.
 *
 *   node ui/settings/kit-field.test.js      Prints "KIT FIELD TEST: n passed, m failed".
 */
'use strict';
const path = require('path');

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' (' + JSON.stringify(detail).slice(0, 300) + ')' : '')); return ok; };

/* in the page: one kit row per case, typed into with focus kept, committed with a 'change' and no blur */
async function runCase(page, c) {
  return page.evaluate(async (c) => {
    const h = (tag, attrs, ...kids) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
      const add = (x) => { if (x == null || x === false) return; if (Array.isArray(x)) x.forEach(add); else el.append(x instanceof Node ? x : String(x)); };
      kids.forEach(add);
      return el;
    };
    const deps = {
      h, why: (text) => h('div', { class: 'why' }, text), icon: () => h('span'), svg: () => h('span'),
      call: async () => ({ ok: true }), on: () => () => {}, test: () => true, go: () => {}, highlight: () => {},
    };
    const K = window.SettingsSections.create(deps, { section: 'kit-test', page: null });
    const answers = {
      refused: { ok: false, reason: 'Use letters, numbers and hyphens' },
      dryrun: { dryRun: true, reason: 'Test run: nothing was changed' },
      declined: { cancelled: true },
      threw: 'throw',
      readback: { ok: true, value: c.readback },
      plain: { ok: true },
    };
    const row = (c.kind === 'number' ? K.number : K.text)({
      label: 'Box', value: c.start,
      // sync: the answer comes back at once (a page-side validation refusal, like the PC name check); else after 30 ms
      onChange: () => { if (c.sync) { if (answers[c.answer] === 'throw') throw new Error('the bridge broke'); return answers[c.answer]; } return new Promise((res, rej) => setTimeout(() => (answers[c.answer] === 'throw' ? rej(new Error('the bridge broke')) : res(answers[c.answer])), 30)); },
    });
    document.body.append(row.el);
    const inp = row.el.querySelector('input');
    inp.focus();
    const hadFocus = document.activeElement === inp;
    inp.select();
    // real keystrokes come from playwright below; here the box is ready
    window.__kitCase = { inp, row, hadFocus };
    return { hadFocus, shown: inp.value };
  }, c).then(async (pre) => {
    if (c.type) await page.keyboard.type(c.type); else await page.keyboard.press('Backspace');
    const mid = await page.evaluate(() => {
      const { inp } = window.__kitCase;
      const focusedAtCommit = document.activeElement === inp;
      inp.dispatchEvent(new Event('change', { bubbles: true }));   // commit while the box keeps focus
      return { typed: inp.value, focusedAtCommit };
    });
    await page.waitForTimeout(250);
    const post = await page.evaluate(() => {
      const { inp, row } = window.__kitCase;
      const out = { shown: inp.value, stored: row.value, note: (row.el.querySelector('.row-w') || {}).textContent || '', disabled: inp.disabled };
      row.el.remove();
      return out;
    });
    return Object.assign({ pre, mid }, post);
  });
}

(async () => {
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('./test-browser.js').launch(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(PAGE + '?section=home', { waitUntil: 'load' });
    await page.waitForFunction(() => window.SettingsSections && typeof window.SettingsSections.create === 'function', null, { timeout: 8000 }).catch(() => {});
    if (!check('kit.js loaded (window.SettingsSections.create)', await page.evaluate(() => !!(window.SettingsSections && window.SettingsSections.create)))) return;

    const springs = [
      ['text', 'refused', 'DESKTOP-1', '', 'an empty name'],
      ['text', 'refused', 'DESKTOP-1', 'bad name!', 'a bad name'],
      ['text', 'dryrun', 'DESKTOP-1', 'NEWNAME', 'a dry run'],
      ['text', 'declined', 'DESKTOP-1', 'NEWNAME', 'a declined administrator prompt'],
      ['text', 'threw', 'DESKTOP-1', 'NEWNAME', 'a call that threw'],
      ['number', 'refused', 30, '999', 'a refused number'],
    ];
    for (const [kind0, answer, start, type, what0] of springs.flatMap((x) => [x, [x[0], x[1], x[2], x[3], x[4] + ' (answered at once)', true]])) {
      const sync = what0.endsWith('(answered at once)'); const kind = kind0, what = what0;
      const r = await runCase(page, { kind, answer, start, type, sync });
      check(`${kind} / ${what}: the box had focus when it was committed`, r.pre.hadFocus && r.mid.focusedAtCommit, r.mid);
      check(`${kind} / ${what}: the person's text was in the box before the answer`, r.mid.typed === type, r.mid.typed);
      check(`${kind} / ${what}: the stored value springs back`, String(r.stored) === String(start), r.stored);
      check(`${kind} / ${what}: the BOX shows the old value again, though it still has focus`, r.shown === String(start), { shown: r.shown, want: String(start) });
      check(`${kind} / ${what}: and says why`, r.note.trim().length > 0, r.note);
      check(`${kind} / ${what}: the box is usable again`, r.disabled === false);
    }
    // a read-back value has the last word on screen too (e.g. Windows trims or upper-cases a name)
    let r = await runCase(page, { kind: 'text', answer: 'readback', start: 'DESKTOP-1', type: 'newname', readback: 'NEWNAME' });
    check('text / a read-back value: the box shows what was stored, not what was typed', r.shown === 'NEWNAME' && r.stored === 'NEWNAME', { shown: r.shown, stored: r.stored });
    // a plain success keeps the typed text (nothing is rewritten under the person's cursor)
    r = await runCase(page, { kind: 'text', answer: 'plain', start: 'DESKTOP-1', type: 'KEEPME' });
    check('text / a plain success: the typed text stays and is stored', r.shown === 'KEEPME' && r.stored === 'KEEPME', { shown: r.shown, stored: r.stored });
    check('no page error', errs.length === 0, errs);
  } finally { await browser.close(); }
})().catch((e) => failures.push('the test threw: ' + (e && e.stack || e))).then(() => {
  console.log(`KIT FIELD TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = failures.length ? 1 : 0;
});
