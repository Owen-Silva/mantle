/* model.test.js - the emoji picker's pure logic: the bundled data, search, recents, skin tones, keys,
 * grid moves and placement (lane mantle-emoji, 2026-10-15).   node ui/emoji/model.test.js
 * Prints "EMOJI MODEL TEST: n passed, m failed". */
'use strict';
const M = require('./model.js');
const DATA = require('./emoji-data.js');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 200)})` : name); };
const chars = (list) => list.map((i) => i.ch);

const cat = M.catalogue(DATA);
const all = cat.emoji.reduce((n, s) => n + s.items.length, 0);

/* ---- the data ---- */
check('nine emoji categories, in Unicode order', JSON.stringify(cat.emoji.map((s) => s.id)) === JSON.stringify(['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags']), cat.emoji.map((s) => s.id));
check('over 1,400 emoji bundled', all > 1400, all);
check('no tone variant is listed on its own (they come from the base)', !cat.emoji.some((s) => s.items.some((i) => /[\u{1F3FB}-\u{1F3FF}]/u.test(i.ch))));
check('every item has a name', cat.emoji.every((s) => s.items.every((i) => typeof i.name === 'string' && i.name.length > 0)));
check('the data file is compact (under 160 KB)', require('fs').statSync(require('path').join(__dirname, 'emoji-data.js')).size < 160 * 1024);
check('the symbols tab has arrows, maths, currency and punctuation', ['punct', 'currency', 'math', 'arrows'].every((id) => cat.symbols.some((s) => s.id === id && s.items.length >= 15)));
check('the kaomoji tab has the shrug', cat.kaomoji.some((s) => s.items.some((i) => i.name === 'shrug')));

/* ---- search ---- */
const s = (q, secs) => chars(M.search(secs || cat.emoji, q));
check('"joy" finds the face with tears of joy first', s('joy')[0] === '\u{1F602}', s('joy').slice(0, 3));
check('"heart" finds the red heart in the first few', s('heart').slice(0, 6).includes('❤️'), s('heart').slice(0, 6));
check('"thumbs" finds thumbs up first', s('thumbs')[0] === '\u{1F44D}', s('thumbs').slice(0, 3));
check('a keyword finds it too ("lol" -> tears of joy)', s('lol').includes('\u{1F602}'), s('lol').slice(0, 5));
check('two words narrow it ("cat heart")', s('cat heart')[0] === '\u{1F63B}', s('cat heart').slice(0, 3));
check('case and spaces do not matter', JSON.stringify(s('  ThUmBs  ')) === JSON.stringify(s('thumbs')));
check('a word start beats a word middle: "ear" is the ear first, the heart far below', s('ear')[0] === '👂' && s('ear').indexOf('❤️') > s('ear').indexOf('🦻'), s('ear').slice(0, 4));
check('rubbish finds nothing', s('zzqqxx').length === 0);
check('an empty query is no search', M.search(cat.emoji, '   ').length === 0);
check('at most 160 results', M.search(cat.emoji, 'a').length <= 160);
check('symbols search: "arrow" finds the right arrow', s('right arrow', cat.symbols)[0] === '→', s('right arrow', cat.symbols).slice(0, 3));
check('symbols search: "euro"', s('euro', cat.symbols)[0] === '€');
check('kaomoji search: "shrug"', s('shrug', cat.kaomoji)[0] === '¯\\_(ツ)_/¯');
const t0 = process.hrtime.bigint();
for (let i = 0; i < 50; i++) M.search(cat.emoji, ['s', 'sm', 'smi', 'smil', 'smile'][i % 5]);
const per = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
check('search-as-you-type is fast (< 8 ms a keystroke over the whole set)', per < 8, `${per.toFixed(2)} ms`);
console.log(`  search: ${per.toFixed(2)} ms a keystroke over ${all} emoji`);

/* ---- recents ---- */
let r = [];
for (const ch of ['a', 'b', 'c']) r = M.remember(r, ch);
check('recents: newest first', JSON.stringify(r) === '["c","b","a"]', r);
r = M.remember(r, 'a');
check('recents: a repeat moves to the front, no duplicate', JSON.stringify(r) === '["a","c","b"]', r);
let big = [];
for (let i = 0; i < 50; i++) big = M.remember(big, 'x' + i);
check(`recents: capped at ${M.RECENT_MAX}`, big.length === M.RECENT_MAX && big[0] === 'x49', big.length);
check('recents: junk in the stored list is dropped', JSON.stringify(M.remember([null, 5, '', 'q'], 'z')) === '["z","q"]');
const ri = M.recentItems(['\u{1F44D}\u{1F3FD}', '\u{1F602}'], cat);
check('recent items keep the tone they were typed in, named from the base', ri[0].ch === '\u{1F44D}\u{1F3FD}' && /thumbs up/i.test(ri[0].name) && ri[0].fixed === true, JSON.stringify(ri[0]));

/* ---- skin tones ---- */
const find = (ch) => cat.byChar[ch];
const thumbs = find('\u{1F44D}');
check('thumbs up takes a tone', thumbs && thumbs.plan && thumbs.plan[0] === 0, JSON.stringify(thumbs && thumbs.plan));
check('tone 3 on thumbs up', M.display(thumbs, 3) === '\u{1F44D}\u{1F3FD}');
check('tone 0 is the default yellow', M.display(thumbs, 0) === '\u{1F44D}');
const victory = find('✌️');
check('victory hand: the tone replaces its FE0F', victory && M.display(victory, 5) === '✌\u{1F3FF}', victory && [...M.display(victory, 5)].map((c) => c.codePointAt(0).toString(16)));
const hw = find('\u{1F9D1}‍⚕️');
if (hw) check('health worker: the tone goes after the person, the staff keeps its FE0F', M.display(hw, 1) === '\u{1F9D1}\u{1F3FB}‍⚕️', [...M.display(hw, 1)].map((c) => c.codePointAt(0).toString(16)));
const hands = find('\u{1F9D1}‍\u{1F91D}‍\u{1F9D1}');
if (hands) check('people holding hands: both people take the tone, the handshake does not', M.display(hands, 2) === '\u{1F9D1}\u{1F3FC}‍\u{1F91D}‍\u{1F9D1}\u{1F3FC}', [...M.display(hands, 2)].map((c) => c.codePointAt(0).toString(16)));
check('a face takes no tone', !find('\u{1F602}').plan && M.display(find('\u{1F602}'), 4) === '\u{1F602}');
check('clampTone: only 0..5', M.clampTone(7) === 0 && M.clampTone(-1) === 0 && M.clampTone('3') === 3 && M.clampTone(2.5) === 0);
check('stripTone gives the base back', M.stripTone('\u{1F44D}\u{1F3FD}') === '\u{1F44D}' && M.stripTone('✌\u{1F3FF}') === '✌️');

/* ---- keys ---- */
const ka = (k, c) => M.keyAction(k, c);
check('Enter inserts and stays open (Windows\' way)', ka({ key: 'Enter' }).do === 'insert' && ka({ key: 'Enter' }).close === false);
check('Shift+Enter inserts and closes', ka({ key: 'Enter', shift: true }).close === true);
check('with close-after-insert on, Enter closes and Shift+Enter stays', ka({ key: 'Enter' }, true).close === true && ka({ key: 'Enter', shift: true }, true).close === false);
check('Esc closes', ka({ key: 'Escape' }).do === 'close');
check('a letter types into the search', ka({ key: 'a', text: 'a' }).do === 'type' && ka({ key: 'a', text: 'a' }).text === 'a');
check('Backspace / Delete / Tab / arrows', ka({ key: 'Backspace' }).do === 'back' && ka({ key: 'Delete' }).do === 'clear' && ka({ key: 'Tab', shift: true }).back === true && ka({ key: 'ArrowDown' }).do === 'move');
check('an unknown key does nothing', ka({ key: 'F5' }).do === 'none' && ka(null).do === 'none');

/* ---- grid moves ---- */
const rows = M.layout([3, 10], 8);   // a short recents row, then 10 (8 + 2)
check('layout: each section starts a row', JSON.stringify(rows) === JSON.stringify([[0, 1, 2], [3, 4, 5, 6, 7, 8, 9, 10], [11, 12]]), JSON.stringify(rows));
check('down from the short row keeps the column', M.move(rows, 2, 'ArrowDown') === 5);
check('down into a shorter row clamps to its end', M.move(rows, 9, 'ArrowDown') === 12);
check('up from the top row stays', M.move(rows, 1, 'ArrowUp') === 1);
check('right runs on across sections, left stops at 0', M.move(rows, 2, 'ArrowRight') === 3 && M.move(rows, 0, 'ArrowLeft') === 0);
check('Home / End', M.move(rows, 6, 'Home') === 0 && M.move(rows, 6, 'End') === 12);
check('an empty grid has no selection', M.move([], 0, 'ArrowDown') === -1);

/* ---- placement ---- */
const work = { x: 0, y: 0, width: 1536, height: 816 };
const W = M.PANEL_W + 2 * M.MARGIN, H = M.PANEL_H + 2 * M.MARGIN;
let p = M.place({ x: 400, y: 200, h: 18 }, work);
check('under the caret, the pane\'s left edge at the caret', p.x === 400 - M.MARGIN && p.y === 200 + 6 - M.MARGIN && p.width === W && p.height === H, JSON.stringify(p));
p = M.place({ x: 400, y: 790, h: 18 }, work);
check('no room under: above the caret line', p.y + H - M.MARGIN <= 790 - 18 && p.y >= 0, JSON.stringify(p));
p = M.place({ x: 1530, y: 300, h: 0 }, work);
check('never off the right edge', p.x + W <= 1536, JSON.stringify(p));
p = M.place({ x: -50, y: -50, h: 0 }, { x: 0, y: 0, width: 800, height: 600 });
check('never off the top-left', p.x >= 0 && p.y >= 0, JSON.stringify(p));
p = M.place({ x: 2000, y: 100, h: 0 }, { x: 1920, y: 0, width: 1280, height: 1024 });
check('a second monitor\'s work area is honoured', p.x >= 1920 && p.x + W <= 3200, JSON.stringify(p));
p = M.place(null, work);
check('no anchor: centred in the work area', p.x > 0 && p.y > 0 && p.x + W <= 1536);

console.log(`EMOJI MODEL TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);
