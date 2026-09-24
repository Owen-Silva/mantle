// model.test.js — the clipboard panel's pure logic (model.js). Plain node, no deps.
//   node ui/clipboard/model.test.js
'use strict';
const M = require('./model.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const key = (k, mods) => Object.assign({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, mods || {});

// ---- filter
const items = [
  { id: 'a', kind: 'text', text: 'Hello World' },
  { id: 'b', kind: 'image', w: 10, h: 10 },
  { id: 'c', kind: 'files', files: [{ name: 'Report.pdf', path: 'C:\\x\\Report.pdf' }] },
  { id: 'd', kind: 'text', text: 'world peace', pinned: true },
];
check('filter: empty query keeps all, in order', M.filter(items, '').map((i) => i.id).join() === 'a,b,c,d');
check('filter: case-insensitive', M.filter(items, 'WORLD').map((i) => i.id).join() === 'a,d');
check('filter: every word must match', M.filter(items, 'world hello').map((i) => i.id).join() === 'a');
check('filter: file names', M.filter(items, 'report').map((i) => i.id).join() === 'c');
check('filter: "image" finds pictures', M.filter(items, 'image').map((i) => i.id).join() === 'b');
check('filter: "pinned" finds pins', M.filter(items, 'pinned').map((i) => i.id).join() === 'd');
check('filter: no match = empty', M.filter(items, 'zzz').length === 0);
check('filter: does not mutate', M.filter(items, 'x') !== items && items.length === 4);

// ---- previewLines
let p = M.previewLines('\n\n  \nfirst\n\tsecond\nthird\nfourth');
check('preview: leading blank lines dropped', p.lines[0] === 'first', p);
check('preview: tabs opened up', p.lines[1] === '    second', p);
check('preview: 3 lines and more=true', p.lines.length === 3 && p.more === true, p);
p = M.previewLines('one\r\ntwo');
check('preview: CRLF handled, more=false', p.lines.join('|') === 'one|two' && p.more === false, p);
p = M.previewLines('x'.repeat(500));
check('preview: a long line is cut at 240 + ellipsis', p.lines[0].length === 241 && p.lines[0].endsWith('…'));
p = M.previewLines('   \n\n  ');
check('preview: whitespace-only is blank', p.blank === true, p);
p = M.previewLines('a\n\n\n');
check('preview: trailing blank lines are not "more"', p.more === false, p);

// ---- ago / meta
const now = Date.UTC(2026, 8, 24, 12, 0, 0);
check('ago: just now', M.ago(now - 10e3, now) === 'just now');
check('ago: minutes', M.ago(now - 5 * 60e3, now) === '5 min ago');
check('ago: hours', M.ago(now - 3 * 3600e3, now) === '3 h ago');
check('ago: yesterday', M.ago(now - 26 * 3600e3, now) === 'Yesterday');
check('ago: days', M.ago(now - 3 * 86400e3, now) === '3 days ago');
check('ago: future clamps to just now', M.ago(now + 60e3, now) === 'just now');
check('meta: short text counts characters', M.meta({ kind: 'text', chars: 12, lines: 1, ts: now }, now) === '12 characters · just now');
check('meta: one character', M.meta({ kind: 'text', chars: 1, lines: 1, ts: now }, now) === '1 character · just now');
check('meta: long text counts lines', M.meta({ kind: 'text', chars: 900, lines: 40, ts: now }, now) === '40 lines · just now');
check('meta: formatted text says so', /formatted/.test(M.meta({ kind: 'text', chars: 3, lines: 1, rich: true, ts: now }, now)));
check('meta: image size', M.meta({ kind: 'image', w: 1920, h: 1080, ts: now }, now) === '1920 × 1080 image · just now');
check('meta: a picture with its file says so', M.meta({ kind: 'image', w: 2, h: 3, fileCount: 1, ts: now }, now) === '2 × 3 image and its file · just now');
check('meta: files count', M.meta({ kind: 'files', fileCount: 7, files: [], ts: now }, now) === '7 files · just now');

// ---- keyAction: the P-versus-typing rule
const E = { query: '', filterArmed: false };
check('key: Esc closes', M.keyAction(key('Escape'), E) === 'close');
check('key: Esc closes even while filtering', M.keyAction(key('Escape'), { query: 'x' }) === 'close');
check('key: arrows', M.keyAction(key('ArrowDown'), E) === 'down' && M.keyAction(key('ArrowUp'), E) === 'up');
check('key: Enter pastes', M.keyAction(key('Enter'), { query: 'abc' }) === 'paste');
check('key: Del deletes, with or without a filter', M.keyAction(key('Delete'), E) === 'delete' && M.keyAction(key('Delete'), { query: 'a' }) === 'delete');
check('key: Del at the END of a filter deletes the item', M.keyAction(key('Delete'), { query: 'ab', selStart: 2, selEnd: 2 }) === 'delete');
check('key: Del with filter text SELECTED edits the filter', M.keyAction(key('Delete'), { query: 'ab', selStart: 0, selEnd: 2 }) === null);
check('key: Del with text after the caret edits the filter', M.keyAction(key('Delete'), { query: 'ab', selStart: 1, selEnd: 1 }) === null);
check('key: Backspace belongs to the filter', M.keyAction(key('Backspace'), { query: 'a' }) === null);
check('key: p pins when the filter is empty', M.keyAction(key('p'), E) === 'pin');
check('key: P (shift) pins when the filter is empty', M.keyAction(key('P', { shiftKey: true }), E) === 'pin');
check('key: p TYPES once a filter is being typed', M.keyAction(key('p'), { query: 'ex' }) === null);
check('key: p TYPES once the filter is armed', M.keyAction(key('p'), { query: '', filterArmed: true }) === null);
check('key: Ctrl+P pins while filtering', M.keyAction(key('p', { ctrlKey: true }), { query: 'ex' }) === 'pin');
check('key: / arms an empty filter', M.keyAction(key('/'), E) === 'arm-filter');
check('key: / types into a non-empty filter', M.keyAction(key('/'), { query: 'a' }) === null);
check('key: letters type', M.keyAction(key('a'), E) === null && M.keyAction(key('Z'), E) === null);
check('key: Home/End move only without a filter', M.keyAction(key('Home'), E) === 'home' && M.keyAction(key('End'), { query: 'a' }) === null);
check('key: Alt+P is not a pin', M.keyAction(key('p', { altKey: true }), E) === null);

// ---- moveSel / reselect
check('move: down clamps at the end', M.moveSel(2, 'down', 3) === 2);
check('move: up clamps at 0', M.moveSel(0, 'up', 3) === 0);
check('move: page down', M.moveSel(1, 'pagedown', 10, 4) === 5);
check('move: page up clamps', M.moveSel(2, 'pageup', 10, 4) === 0);
check('move: empty list = -1', M.moveSel(0, 'down', 0) === -1);
check('move: from no selection, down counts from the top', M.moveSel(-1, 'down', 5) === 1);
check('reselect: same id', M.reselect('c', 0, [{ id: 'a' }, { id: 'c' }]) === 1);
check('reselect: gone id keeps the index', M.reselect('x', 1, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]) === 1);
check('reselect: index past the end clamps', M.reselect('x', 5, [{ id: 'a' }, { id: 'b' }]) === 1);
check('reselect: empty = -1', M.reselect('a', 0, []) === -1);

// ---- place: below the caret, flipped above near the bottom, always inside the work area
const work = { x: 0, y: 0, width: 1536, height: 816 };   // 1920x1080 at 125%, minus a 48 px bar
let r = M.place({ x: 300, y: 200, h: 18 }, work);
check('place: below the caret', r.panel.x === 300 && r.panel.y === 206, r.panel);
check('place: window = panel + margin', r.x === r.panel.x - M.MARGIN && r.width === M.PANEL_W + 2 * M.MARGIN, r);
r = M.place({ x: 300, y: 700, h: 18 }, work);
check('place: flips ABOVE near the bottom', r.panel.y + r.panel.height <= 700 - 18, r.panel);
r = M.place({ x: 1500, y: 100, h: 0 }, work);
check('place: clamped inside the right edge', r.panel.x + r.panel.width <= work.width - 8, r.panel);
r = M.place({ x: -50, y: -50, h: 0 }, work);
check('place: clamped inside the top-left', r.panel.x >= 8 && r.panel.y >= 8, r.panel);
r = M.place({ x: 2000, y: 300, h: 18 }, { x: 1536, y: 0, width: 1280, height: 680 });
check('place: a second display offset (neither side fits: the roomier side, clamped)', r.panel.x === 2000 && r.panel.y === 680 - 8 - 460, r.panel);
r = M.place({ x: 100, y: 100, h: 18 }, { x: 0, y: 0, width: 400, height: 300 });
check('place: a work area shorter than the panel keeps its top on screen', r.panel.y === 8 && r.panel.x >= 8, r.panel);

console.log('clipboard model: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
