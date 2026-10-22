require('../../tools/dev-env.js').lowcpu();
/* notes-page.test.js — the quick notes pad's PAGE (ui/notes), driven for real (lane topbar-notes,
 * quality pass 2026-09-29). Headless chromium over file:// with the pad's own mock-mantle.js playing
 * main: it TYPES and CLICKS through tabs, a new note, delete + Undo, keyboard (Ctrl+N, Ctrl+Tab,
 * arrows on the tabs, Esc), the autosave debounce and its 3 s cap, a slow save, a failed save, find
 * across notes (Ctrl+F, Enter, Shift+Enter, F3, Esc, the mark on the current match), huge text, unicode, and PRIVACY (no typed text
 * in any mantle.call argument). Never Electron, never the user's notes: every note is made up.
 *
 *   node ui/notes/notes-page.test.js          (MANTLE_SHOOT_OUT=<dir> for the shots)
 * Prints "NOTES PAGE: n passed, m failed". A game running = skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('os').tmpdir(), 'mantle-notes-shots');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const show = (v) => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  try { return parseInt(execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim(), 10) || 0; } catch (_) { return -1; }
}

async function run() {
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 380 }, deviceScaleFactor: 1.5, colorScheme: 'light' });
  const errors = [];
  async function open(mode, extra) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await page.goto(`${PAGE}?mock=${mode}${extra || ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 }).catch(() => {});
    return page;
  }
  const N = (page) => page.evaluate(() => window.__notes);
  const calls = (page, name) => page.evaluate((n) => window.__mockCalls.filter((c) => !n || c.name === n).map((c) => ({ name: c.name, args: c.args })), name);
  const shot = async (page, name) => { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
  const focusId = (page) => page.evaluate(() => (document.activeElement && (document.activeElement.id || document.activeElement.className)) || '');
  const SECRET = 'zqx-secret-words-7731';
  // find's mark: where it is on screen, and whether it is exactly on the match
  const markAt = (page) => page.evaluate(() => {
    const m = document.querySelector('#mirror mark'), t = document.getElementById('text');
    if (!m) return null;
    const r = m.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, text: m.textContent, vis: getComputedStyle(document.getElementById('hl')).visibility,
      inside: r.top >= tr.top && r.bottom <= tr.bottom && r.left >= tr.left && r.right <= tr.right };
  });
  /** The match's row shot twice: as the page draws it (the textarea's words over the wash, wash off
   *  for the shot) and with the textarea's words hidden and the mirror's shown instead. The two shots
   *  must line up best with NO shift: moved by one device pixel either way (1.5x) they differ more, so
   *  the mirror wraps and places that row's glyphs where the text has them (within a pixel; the two
   *  paint paths anti-alias a little differently, so the shots are never byte-equal). */
  async function aligned(page) {
    const clip = await page.evaluate(() => {
      const t = document.getElementById('text'), m = document.querySelector('#mirror mark');
      if (!m) return null;
      let r = m.getClientRects()[0], tr = t.getBoundingClientRect();
      if (r.top < tr.top || r.bottom > tr.bottom) {          // bring it into view first (the mark follows)
        t.scrollTop += r.top - tr.top - t.clientHeight / 3;
        t.dispatchEvent(new Event('scroll'));
        r = m.getClientRects()[0];
      }
      return { x: Math.ceil(tr.left), y: Math.floor(r.top), width: Math.floor(t.clientWidth) - 2, height: Math.ceil(r.bottom) - Math.floor(r.top) };
    });
    if (!clip || clip.height < 8) return { same: false, clip };
    const set = (on) => page.evaluate((on) => {
      const t = document.getElementById('text'), mi = document.getElementById('mirror'), m = mi.querySelector('mark');
      const ink = on ? getComputedStyle(t).color : '';
      m.style.background = 'transparent'; m.style.boxShadow = 'none';
      t.style.color = on ? 'transparent' : '';
      mi.style.color = ink; m.style.color = ink;
    }, on);
    await set(false);
    const a = await page.screenshot({ clip });
    await set(true);
    const b = await page.screenshot({ clip });
    await page.evaluate(() => { const t = document.getElementById('text'), mi = document.getElementById('mirror'); t.style.color = ''; mi.style.color = ''; const m = mi.querySelector('mark'); if (m) m.removeAttribute('style'); });
    const r = await page.evaluate(async ([a, b]) => {
      const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
      const px = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const da = px(ia), db = px(ib), W = ia.width, H = ia.height, out = {};
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let sum = 0;
        for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) { const k = (y * W + x) * 4, k2 = ((y + dy) * W + x + dx) * 4; sum += Math.abs(da[k] - db[k2]) + Math.abs(da[k + 1] - db[k2 + 1]) + Math.abs(da[k + 2] - db[k2 + 2]); }
        out[dx + ',' + dy] = sum;
      }
      return out;
    }, [a.toString('base64'), b.toString('base64')]);
    const off = Object.keys(r).filter((k) => k !== '0,0').map((k) => r[k]);
    return { same: r['0,0'] < Math.min(...off) * 0.75, diff: r, clip };
  }

  /* ---- load + the quiet footer ---- */
  let p = await open('3notes');
  let s = await N(p);
  check('load: three tabs named by their first lines', s.loaded && s.tabs.length === 3 && s.tabs[0] === 'Project 4 - specs' && s.tabs[1] === 'Errands Tue 6:15', show(s.tabs));
  {
    // a first line longer than a tab: cut with an ellipsis, the whole line on hover (its own page)
    const pc = await open('3notes');
    await pc.click('#text');
    await pc.keyboard.press('Control+Home');
    await pc.keyboard.type('Grocery list for the long weekend trip ');
    const cut = await pc.evaluate(() => { const b = document.querySelector('.tab.on'); return { t: b.textContent, title: b.title }; });
    check('load: a cut tab label shows the whole first line on hover', cut.t.endsWith('…') && cut.t.length <= 18 && /^Grocery list for the long weekend trip Project 4 - specs$/.test(cut.title), show(cut));
    await pc.close();
  }
  check('load: a label that fits has no redundant tooltip', await p.evaluate(() => !document.querySelectorAll('.tab')[0].hasAttribute('title')));
  check('load: the footer is quiet ("3 notes · Saved <time>"), no warn', /^3 notes · Saved \d/.test(s.footer) && !s.warn, s.footer);
  check('load: the caret is in the text', (await focusId(p)) === 'text');
  check('tabs: only the open note\'s tab is in the Tab order (roving)', await p.evaluate(() => [...document.querySelectorAll('.tab')].map((b) => b.tabIndex).join() === '0,-1,-1'));
  await shot(p, '01-pad');

  /* ---- typing: debounce 400 ms, the pull, the tab label, privacy ---- */
  await p.click('#text');
  await p.keyboard.press('Control+End');
  await p.keyboard.type(`\n${SECRET}`);
  const d0 = (await calls(p, 'notes.dirty')).length;
  await sleep(200);
  const d1 = (await calls(p, 'notes.dirty')).length;
  await sleep(450);
  const d2 = (await calls(p, 'notes.dirty')).length;
  check('autosave: nothing is sent while typing (debounce)', d0 === 0 && d1 === 0, `${d0},${d1}`);
  check('autosave: one notes.dirty ~400 ms after typing stops', d2 === 1, d2);
  const pulled = await p.evaluate(() => window.__mockSaved);
  check('autosave: main pulls the typed text (the pull)', pulled && pulled.notes[0].text.endsWith(SECRET), show(pulled && pulled.notes[0].text.slice(-40)));
  check('privacy: no typed text in any mantle.call argument', !show(await calls(p)).includes(SECRET));
  s = await N(p);
  check('autosave: the footer stays quiet through a fast save (no "Saving…" flash)', /^3 notes · Saved/.test(s.footer), s.footer);
  // a long burst: saved within 3 s even though typing never pauses 400 ms
  await p.evaluate(() => { window.__mockCalls.length = 0; });
  for (let i = 0; i < 26; i++) { await p.keyboard.type('x'); await sleep(140); }
  check('autosave: a long burst of typing is saved within 3 s (no pause needed)', (await calls(p, 'notes.dirty')).length >= 1, (await calls(p, 'notes.dirty')).length);
  await sleep(500);

  /* ---- new note, switching, keyboard ---- */
  await p.click('#add');
  s = await N(p);
  check('new: "+" adds a note after the open one and opens it', s.tabs.length === 4 && s.tabs[1] === 'New note' && s.active === s.notes[1].id, show(s.tabs));
  check('new: the caret goes into the new note', (await focusId(p)) === 'text');
  await p.keyboard.type('Second new 🙂 café 中文');
  await p.keyboard.press('Control+n');
  s = await N(p);
  check('new: Ctrl+N adds another', s.tabs.length === 5 && s.tabs[2] === 'New note', show(s.tabs));
  await p.keyboard.press('Control+Tab');
  let s2 = await N(p);
  check('keys: Ctrl+Tab opens the next note', s2.active === s2.notes[3].id, show([s2.active, s2.notes.map((n) => n.id)]));
  await p.keyboard.press('Control+Shift+Tab');
  await p.keyboard.press('Control+Shift+Tab');
  s2 = await N(p);
  check('keys: Ctrl+Shift+Tab goes back', s2.active === s2.notes[1].id);
  await p.click('.tab >> nth=0');
  s2 = await N(p);
  check('tabs: a click opens that note, the caret stays in the text', s2.active === s2.notes[0].id && (await focusId(p)) === 'text');
  await p.focus('.tab.on');
  await p.keyboard.press('ArrowRight');
  s2 = await N(p);
  check('tabs: ArrowRight on a tab opens the next note and keeps the keyboard on the tabs', s2.active === s2.notes[1].id && /tab/.test(await focusId(p)), await focusId(p));
  await p.keyboard.press('End');
  s2 = await N(p);
  check('tabs: End opens the last note', s2.active === s2.notes[s2.notes.length - 1].id);
  await p.keyboard.press('Enter');
  check('tabs: Enter on a tab puts the caret in its text', (await focusId(p)) === 'text');
  await sleep(500);
  const uni = (await p.evaluate(() => window.__mockSaved)).notes.find((n) => n.text.startsWith('Second new'));
  check('unicode: emoji, accents and CJK are pulled exactly as typed', uni && uni.text === 'Second new 🙂 café 中文', show(uni));

  /* ---- delete: one click, Undo ---- */
  await p.click('.tab >> nth=1');
  const victim = (await N(p)).notes[1];
  await p.evaluate(() => { window.__mockDelDelay = 300; });
  await p.click('#del');
  await p.keyboard.type('LOST');                     // typed while the delete is on its way
  s = await N(p);
  check('delete: one click deletes (no "are you sure")', s.deleting === true && s.footer === 'Deleting…', show([s.deleting, s.footer]));
  check('delete: the text is read-only while the delete is on its way (no keystroke lost into it)', s.readOnly === true && !s.notes[1].text.includes('LOST'), show(s.notes[1]));
  await sleep(450);
  s = await N(p);
  check('delete: the note is gone, the one before it opens', !s.notes.some((n) => n.id === victim.id) && s.active === s.notes[0].id, show(s.tabs));
  check('delete: the footer says "Note deleted" with an Undo button', s.footer === 'Note deleted' && s.undo && await p.isVisible('#undo'), s.footer);
  check('delete: the text is writable again', s.readOnly === false);
  const delCall = (await calls(p, 'notes.delete')).pop();
  check('delete: notes.delete carries the id only (no text)', delCall && Object.keys(delCall.args).join() === 'id' && delCall.args.id === victim.id, show(delCall));
  await shot(p, '02-undo');
  await p.click('#undo');
  s = await N(p);
  check('undo: the note comes back at its place with its text, and opens', s.notes[1] && s.notes[1].text === victim.text && s.active === s.notes[1].id, show(s.tabs));
  check('undo: the Undo button goes, the footer is quiet again', !s.undo && !(await p.isVisible('#undo')) && /notes · Saved|^\d+ notes$/.test(s.footer), s.footer);
  await sleep(500);
  check('undo: the restored note is saved again', (await p.evaluate(() => window.__mockSaved)).notes.some((n) => n.text === victim.text));
  // a double click deletes ONE note
  await p.evaluate(() => { window.__mockDelDelay = 0; });
  const before = (await N(p)).notes.length;
  await p.dblclick('#del');
  await sleep(200);
  check('delete: a double click deletes one note, not two', (await N(p)).notes.length === before - 1, `${before} -> ${(await N(p)).notes.length}`);
  // undo times out
  await sleep(8200);
  s = await N(p);
  check('undo: offered for 8 s, then gone', !s.undo && !(await p.isVisible('#undo')), show([s.undo, s.footer]));
  // a refused delete
  await p.evaluate(() => { window.__mockDelFail = 1; });
  const keep = (await N(p)).notes.length;
  await p.click('#del');
  await sleep(150);
  s = await N(p);
  check('delete: refused -> the note stays and the footer says why (warn)', s.notes.length === keep && s.warn && /^Not deleted: could not keep .*disk is full/.test(s.footer), s.footer);
  check('delete: ... saying "Not deleted" once, not twice', !/not deleted: not deleted/i.test(s.footer), s.footer);
  await p.evaluate(() => { window.__mockDelFail = 0; });
  // delete every note: the last one leaves one blank note, and Delete is then off
  for (let i = 0; i < 10 && (await N(p)).notes.length > 1; i++) { await p.click('#del'); await sleep(450); }
  await p.click('#del'); await sleep(450);
  s = await N(p);
  check('delete: deleting the last note leaves one blank note', s.notes.length === 1 && s.notes[0].text === '' && s.tabs[0] === 'New note', show(s.notes));
  check('delete: with one blank note Delete is off (nothing to delete)', s.delDisabled === true);
  await p.click('#undo');
  s = await N(p);
  check('undo: undoing the last note\'s delete brings it back instead of the blank one', s.notes.length === 1 && s.notes[0].text !== '', show(s.notes.map((n) => n.text.length)));
  await p.close();

  /* ---- Esc closes the pad and hands the keyboard back ---- */
  p = await open('3notes');
  await p.keyboard.press('Escape');
  const cl = await calls(p, 'notes.close');
  check('Esc: closes the pad and gives the keyboard back (notes.close {refocus:true})', cl.length === 1 && cl[0].args.refocus === true, show(cl));
  await p.close();

  /* ---- find across notes ---- */
  p = await open('3notes');
  await p.evaluate(() => document.getElementById('text').setSelectionRange(0, 0));   // caret at the top: the first Enter = the first match
  await p.keyboard.press('Control+f');
  s = await N(p);
  check('find: Ctrl+F opens the find row with the keyboard in it', s.find.open && (await focusId(p)) === 'q' && await p.isVisible('#find'));
  await p.keyboard.type('the');
  await sleep(200);
  s = await N(p);
  const expect = s.notes.reduce((a, n) => a + (n.text.toLowerCase().match(/the/g) || []).length, 0);
  check('find: counts every match in every note', s.find.hits === expect && expect > 0 && new RegExp(`^${expect} in \\d notes?$`).test(s.find.count), show([s.find, expect]));
  const nohit = await p.evaluate(() => [...document.querySelectorAll('.tab')].map((b) => b.classList.contains('nohit')));
  const want = s.notes.map((n) => !/the/i.test(n.text));
  check('find: tabs without a match step back', show(nohit) === show(want), show([nohit, want]));
  await p.keyboard.press('Enter');
  s = await N(p);
  const note = s.notes.find((n) => n.id === s.active);
  check('find: Enter opens the note of the next match and selects it', s.find.cur === 0 && note.text.slice(s.sel[0], s.sel[1]).toLowerCase() === 'the' && /^1 of \d+$/.test(s.find.count), show([s.sel, s.find.count]));
  check('find: the keyboard stays in the find box (Enter again = next)', (await focusId(p)) === 'q');
  // find's mark: a textarea paints no selection while the find box has the keyboard, so the match is
  // drawn behind the text; it must sit exactly ON the match
  let mk = await markAt(p);
  check('find mark: the match is marked while the keyboard is in the find box', s.find.marked && mk && mk.inside && mk.vis === 'visible' && mk.text.toLowerCase() === 'the' && mk.w > 8, show(mk));
  let al = await aligned(p);
  check('find mark: it sits exactly on the match (its hidden words give the same pixels as the text)', al.same, show(al));
  await shot(p, '03-find');
  const seen = [s.active + ':' + s.sel[0]];
  let unmarked = 0;
  for (let i = 1; i < expect; i++) { await p.keyboard.press('Enter'); s = await N(p); seen.push(s.active + ':' + s.sel[0]); if (!s.find.marked) unmarked++; }
  check('find: Enter walks through every match once, across notes', new Set(seen).size === expect, show(seen));
  check('find mark: every match is marked in turn, in whichever note it is', unmarked === 0, unmarked);
  al = await aligned(p);
  check('find mark: after the walk the mark is still exactly on its match', al.same, show(al));
  await p.keyboard.press('Enter');
  s = await N(p);
  check('find: after the last match it wraps to the first', s.find.cur === 0 && s.active + ':' + s.sel[0] === seen[0], show([s.find.cur, seen[0]]));
  await p.keyboard.press('Shift+Enter');
  s = await N(p);
  check('find: Shift+Enter goes back (wraps to the last)', s.find.cur === expect - 1 && s.active + ':' + s.sel[0] === seen[expect - 1]);
  await p.keyboard.press('F3');
  s = await N(p);
  check('find: F3 = next', s.find.cur === 0);
  await p.focus('#text');
  s = await N(p);
  check('find mark: the text taking the keyboard hands over to its own selection (no double wash)', !s.find.marked && s.find.open, show(s.find));
  await p.focus('#q');
  s = await N(p);
  check('find mark: back in the find box, the same match is marked again', s.find.marked && s.find.cur === 0, show(s.find));
  await p.fill('#q', 'nothing like this');
  await sleep(200);
  s = await N(p);
  check('find: no match says "No matches"', s.find.count === 'No matches' && s.find.hits === 0 && await p.evaluate(() => document.getElementById('next').disabled));
  check('find mark: a new query clears the mark', !s.find.marked, show(s.find));
  await p.fill('#q', `${SECRET}x`);
  check('privacy: find sends nothing to Mantle', !show(await calls(p)).includes(SECRET) && !(await calls(p)).some((c) => /find|search/.test(c.name)));
  await p.keyboard.press('Escape');
  s = await N(p);
  check('find: Esc closes the find row (not the pad) and the caret goes back to the text', !s.find.open && !(await p.isVisible('#find')) && (await calls(p, 'notes.close')).length === 0 && (await focusId(p)) === 'text');
  check('find: closing it clears the stepped-back tabs', await p.evaluate(() => !document.querySelector('.tab.nohit')));
  check('find mark: closing find hides the mark and drops its copy of the text', !s.find.marked && await p.evaluate(() => document.getElementById('mirror').textContent === ''));
  // the mouse's way in: the magnifier beside "+", its shortcut in the tooltip; a second click closes
  check('find button: says what it does and its shortcut', (await p.getAttribute('#findbtn', 'title')) === 'Find in all notes (Ctrl+F)' && (await p.getAttribute('#findbtn', 'aria-expanded')) === 'false');
  await p.click('#findbtn');
  s = await N(p);
  check('find button: a click opens the find row with the keyboard in it, the button shows it is on', s.find.open && (await focusId(p)) === 'q'
    && (await p.getAttribute('#findbtn', 'aria-expanded')) === 'true' && await p.evaluate(() => document.getElementById('findbtn').classList.contains('on')));
  await p.click('#findbtn');
  s = await N(p);
  check('find button: a second click closes it, the caret back in the text', !s.find.open && (await focusId(p)) === 'text' && (await p.getAttribute('#findbtn', 'aria-expanded')) === 'false');
  await p.keyboard.press('Escape');
  check('Esc: a second Esc closes the pad', (await calls(p, 'notes.close')).length === 1);
  await p.close();
  // find in a long note scrolls to the hit; the selection seeds the query
  p = await open('long');
  await p.evaluate(() => { const t = document.getElementById('text'); t.scrollTop = 0; t.setSelectionRange(0, 0); });
  await p.keyboard.press('Control+f');
  await p.keyboard.type('38. a made');
  await p.keyboard.press('Enter');
  s = await N(p);
  const box = await p.evaluate(() => { const t = document.getElementById('text'); return { top: t.scrollTop, h: t.clientHeight, max: t.scrollHeight }; });
  check('find: a match far down a long note is scrolled into view', s.find.cur === 0 && box.top > box.h, show(box));
  mk = await markAt(p);
  check('find mark: far down a long note the match is marked, in view', s.find.marked && mk && mk.inside && mk.text === '38. a made', show(mk));
  al = await aligned(p);
  check('find mark: ...and exactly on its words after the scroll', al.same, show(al));
  await shot(p, '04-find-long');
  {
    // the mark rides along when the text scrolls, and a new width lays it out again
    const y0 = mk.y;
    await p.evaluate(() => { document.getElementById('text').scrollTop -= 40; });
    await sleep(50);
    const mk2 = await markAt(p);
    check('find mark: it moves with the text when the text scrolls', mk2 && Math.abs(mk2.y - (y0 + 40)) < 1, show([y0, mk2]));
    // the pad is a fixed-size window; a narrower pad (another display scale) = a window resize
    const w0 = await p.evaluate(() => document.getElementById('text').clientWidth);
    await p.evaluate(() => { document.getElementById('pad').style.setProperty('--pad-w', '300px'); window.dispatchEvent(new Event('resize')); });
    await sleep(80);
    const w1 = await p.evaluate(() => [document.getElementById('text').clientWidth, parseFloat(document.getElementById('mirror').style.width)]);
    check('find mark: a narrower pad lays the mark out at the new width of the text', w1[0] < w0 - 50 && w1[0] === w1[1], show([w0, w1]));
    al = await aligned(p);
    check('find mark: ...re-wrapped with the text, still on its words', (await N(p)).find.marked && al.same, show(al));
    await shot(p, '04b-find-narrow');
    await p.evaluate(() => { document.getElementById('pad').style.removeProperty('--pad-w'); window.dispatchEvent(new Event('resize')); });
  }
  await p.keyboard.press('Escape');
  await p.evaluate(() => { const t = document.getElementById('text'); t.focus(); const i = t.value.indexOf('unit 3'); t.setSelectionRange(i, i + 6); });
  await p.keyboard.press('Control+f');
  check('find: a short selection in the text becomes the query', (await p.inputValue('#q')) === 'unit 3');
  await p.close();

  /* ---- a slow save, a failed save ---- */
  p = await open('slow');
  await p.click('#text'); await p.keyboard.type('a');
  await sleep(1250);
  check('slow save: "Saving…" shows once a save takes over 0.7 s', (await N(p)).footer === 'Saving…', (await N(p)).footer);
  await sleep(1000);
  check('slow save: ... then the quiet saved line', /^3 notes · Saved/.test((await N(p)).footer), (await N(p)).footer);
  await p.close();
  p = await open('3notes');
  await p.evaluate(() => { window.__mockFail = 'could not save C:\\Users\\you\\Documents\\Mantle Notes\\notes.md: Windows refused access to it (read-only, or another program holds it)'; });
  await p.click('#text'); await p.keyboard.type(' kept');
  await sleep(550);
  s = await N(p);
  check('failed save: the footer says Not saved with the reason (warn)', s.warn && /^Not saved: .*read-only/.test(s.footer) && /kept here/.test(s.footer), s.footer);
  check('failed save: the text stays in the pad', s.notes[0].text.endsWith(' kept'));
  check('failed save: the path is the footer\'s tooltip', /notes\.md/.test(await p.evaluate(() => document.getElementById('foot').title)));
  await shot(p, '05-failed');
  await p.evaluate(() => { window.__mockFail = null; });
  await p.keyboard.type('!');
  await sleep(550);
  check('failed save: the next save that works clears the warning', !(await N(p)).warn, (await N(p)).footer);
  await p.close();

  /* ---- huge text ---- */
  p = await open('3notes');
  const perf = await p.evaluate(() => {
    const t = document.getElementById('text');
    const big = 'a long line of made up words for the size test\n'.repeat(80000);   // ~3.8 MB
    const t0 = performance.now();
    t.value = big; t.dispatchEvent(new Event('input', { bubbles: true }));
    const t1 = performance.now();
    // the keystroke: Chromium's own edit of a 3.8 MB textarea (not the page's code, and slow under
    // lowcpu's cap) is timed apart from the page's input handler, which is what this page controls
    t.setRangeText('z', t.value.length, t.value.length, 'end');
    const t2 = performance.now();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    const t3 = performance.now();
    return { paste: t1 - t0, edit: t2 - t1, key: t3 - t2, len: t.value.length };
  });
  check('huge: a 3.8 MB paste is handled in under 150 ms, the page\'s work per keystroke in it under 16 ms', perf.paste < 150 && perf.key < 16, show(perf));
  console.log(`huge: paste ${Math.round(perf.paste)} ms, the browser's own edit ${Math.round(perf.edit)} ms, the page's handler ${perf.key.toFixed(1)} ms`);
  await p.keyboard.press('Control+f');
  const fperf = await p.evaluate(async () => { const q = document.getElementById('q'); q.value = 'size'; const t0 = performance.now(); q.dispatchEvent(new Event('input')); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return { ms: performance.now() - t0, n: window.__notes.find.hits, c: window.__notes.find.count }; });
  check('huge: find over 3.8 MB answers in under 250 ms and caps its count', fperf.ms < 250 && fperf.n === 999 && /999\+/.test(fperf.c), show(fperf));
  check('huge: ...and marks the match it jumped to', (await N(p)).find.marked);
  {
    // one paragraph too long to copy (60k characters before the match): no mark, but the jump still
    // selects and scrolls to it, fast, with no error
    const lp = await p.evaluate(() => {
      const t = document.getElementById('text');
      t.value = 'filler '.repeat(9000) + 'needle at the end'; t.dispatchEvent(new Event('input', { bubbles: true }));
      const q = document.getElementById('q'); q.value = 'needle'; q.dispatchEvent(new Event('input'));
      const t0 = performance.now(); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      return { ms: performance.now() - t0, sel: [t.selectionStart, t.selectionEnd], at: t.value.indexOf('needle'), top: t.scrollTop };
    });
    const s2 = await N(p);
    check('huge paragraph: the jump selects and scrolls to the match without a mark, under 250 ms', lp.sel[0] === lp.at && lp.top > 0 && !s2.find.marked && lp.ms < 250, show([lp, s2.find]));
  }
  await p.close();

  /* ---- other states ---- */
  p = await open('empty');
  s = await N(p);
  check('empty: one blank note, the placeholder says what to do, Delete is off', s.notes.length === 1 && s.delDisabled && (await p.getAttribute('#text', 'placeholder')) === 'Type a note. It saves as you type.' && s.footer === '1 note', show([s.footer, s.delDisabled]));
  await shot(p, '06-empty');
  await p.close();
  p = await open('outside');
  check('outside change: the notice names the kept copy', /changed outside Mantle.*kept as/.test((await N(p)).notice));
  await p.close();
  p = await open('failed');
  s = await N(p);
  check('failed at load (unsaved notes from before a rest): warn with the reason', s.warn && /^Not saved: .*disk is full/.test(s.footer), s.footer);
  await p.close();
  p = await open('many');
  s = await N(p);
  check('many: nine tabs, the open one scrolled into view', s.tabs.length === 9 && await p.evaluate(() => { const b = document.querySelector('.tab.on'), t = document.getElementById('tabs'); return b.offsetLeft >= t.scrollLeft && b.offsetLeft + b.offsetWidth <= t.scrollLeft + t.clientWidth + 1; }));
  await shot(p, '07-many');
  await p.close();
  p = await open('nobridge');
  s = await N(p);
  check('no bridge: says it cannot save, typing is off', s.warn && /no bridge/.test(s.footer) && s.readOnly);
  await p.close();
  // a reload after an outside change (notes.open with reload) replaces the notes
  p = await open('3notes');
  await p.evaluate(() => window.mantle.emit('notes.open', { focus: true, reload: { notes: [{ id: 'r1', text: 'reloaded one' }, { id: 'r2', text: 'reloaded two' }], active: 'r2', rev: 0 } }));
  s = await N(p);
  check('reload: an outside change pushed on open replaces the tabs and opens the same place', s.tabs.join('|') === 'reloaded one|reloaded two' && s.active === 'r2', show(s.tabs));
  // blur while unsaved sends the save at once
  await p.click('#text'); await p.keyboard.type('b');
  await p.evaluate(() => { window.__mockCalls.length = 0; window.dispatchEvent(new Event('blur')); });
  check('blur: unsaved text is sent at once, no debounce wait', (await calls(p, 'notes.dirty')).length === 1);
  await p.close();

  check('no page errors in any state', !errors.length, errors.join(' | '));
  await browser.close();
}

(async () => {
  const g = gaming();
  if (g > 0) { console.log('NOTES PAGE: skipped, a game is running'); process.exit(0); }
  else { try { await run(); } catch (e) { failures.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); } }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`NOTES PAGE: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
