/* model.test.js — plain node, no framework: node ui/files/model.test.js
 * Prints one line per failure and the summary "FILES MODEL TEST: n passed, m failed". */
'use strict';
const M = require('./model.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const it = (n, o) => Object.assign({ n, d: 0, s: 0, m: 0, c: 0, a: 32 }, o || {});
const names = (arr) => arr.map((x) => x.n);

/* paths */
eq('norm drive', M.normPath('c:'), 'C:\\');
eq('norm slashes', M.normPath('c:/Users//x/'), 'C:\\Users\\x');
eq('norm dots', M.normPath('C:\\a\\b\\..\\.\\c'), 'C:\\a\\c');
eq('norm dotdot at root', M.normPath('C:\\..\\..'), 'C:\\');
eq('norm unc', M.normPath('\\\\srv\\share\\'), '\\\\srv\\share');
eq('norm unc alone', M.normPath('\\\\srv'), null);
eq('norm relative', M.normPath('foo\\bar'), null);
eq('norm virtual', M.normPath('mantle:home'), 'mantle:home');
eq('parent', M.parentOf('C:\\a\\b'), 'C:\\a');
eq('parent of child of root', M.parentOf('C:\\a'), 'C:\\');
eq('parent of root', M.parentOf('C:\\'), null);
eq('parent of share', M.parentOf('\\\\srv\\share'), null);
eq('parent of virtual', M.parentOf('mantle:thispc'), null);
eq('join root', M.joinPath('C:\\', 'x'), 'C:\\x');
eq('join', M.joinPath('C:\\a', 'x'), 'C:\\a\\x');
eq('basename', M.baseName('C:\\a\\b.txt'), 'b.txt');

/* crumbs */
eq('crumbs drive', M.crumbs('C:\\Users\\kim', { 'c:\\': 'Local Disk (C:)' }), [
  { label: 'This PC', path: 'mantle:thispc' }, { label: 'Local Disk (C:)', path: 'C:\\' }, { label: 'Users', path: 'C:\\Users' }, { label: 'kim', path: 'C:\\Users\\kim' }]);
eq('crumbs unc', M.crumbs('\\\\nas\\team\\q1').map((c) => c.path), ['mantle:network', '\\\\nas\\team', '\\\\nas\\team\\q1']);
eq('crumbs home', M.crumbs('mantle:home'), [{ label: 'Home', path: 'mantle:home' }]);

/* typed paths */
const ctx = { cwd: 'C:\\Users\\kim\\Documents', home: 'C:\\Users\\kim', known: { downloads: 'C:\\Users\\kim\\Downloads' } };
eq('typed abs', M.resolveTyped('d:/Photos/', ctx), { ok: true, path: 'D:\\Photos' });
eq('typed drive only', M.resolveTyped('e:', ctx), { ok: true, path: 'E:\\' });
eq('typed drive relative', M.resolveTyped('c:temp', ctx), { ok: true, path: 'C:\\temp' });
eq('typed relative', M.resolveTyped('Budget\\2026', ctx), { ok: true, path: 'C:\\Users\\kim\\Documents\\Budget\\2026' });
eq('typed dotdot', M.resolveTyped('..', ctx), { ok: true, path: 'C:\\Users\\kim' });
eq('typed quoted', M.resolveTyped('"C:\\Program Files"', ctx), { ok: true, path: 'C:\\Program Files' });
eq('typed userprofile', M.resolveTyped('%USERPROFILE%\\Music', ctx), { ok: true, path: 'C:\\Users\\kim\\Music' });
eq('typed appdata lower', M.resolveTyped('%appdata%', ctx), { ok: true, path: 'C:\\Users\\kim\\AppData\\Roaming' });
eq('typed localappdata', M.resolveTyped('%LOCALAPPDATA%\\Temp', ctx), { ok: true, path: 'C:\\Users\\kim\\AppData\\Local\\Temp' });
eq('typed windir', M.resolveTyped('%windir%\\System32', ctx), { ok: true, path: 'C:\\Windows\\System32' });
eq('typed env override', M.resolveTyped('%PROJ%\\src', Object.assign({ env: { PROJ: 'D:\\work' } }, ctx)), { ok: true, path: 'D:\\work\\src' });
eq('typed unknown var', M.resolveTyped('%NOPE%\\x', ctx).ok, false);
eq('typed tilde', M.resolveTyped('~\\Desktop', ctx), { ok: true, path: 'C:\\Users\\kim\\Desktop' });
eq('typed known word', M.resolveTyped('Downloads', ctx), { ok: true, path: 'C:\\Users\\kim\\Downloads' });
eq('typed shell', M.resolveTyped('shell:downloads', ctx), { ok: true, path: 'C:\\Users\\kim\\Downloads' });
eq('typed this pc', M.resolveTyped('This PC', ctx), { ok: true, path: 'mantle:thispc' });
eq('typed recycle', M.resolveTyped('recycle bin', ctx), { ok: true, path: 'mantle:recycle' });
eq('typed unc short', M.resolveTyped('\\\\nas', ctx).ok, false);
eq('typed unc', M.resolveTyped('\\\\nas\\team', ctx), { ok: true, path: '\\\\nas\\team' });
eq('typed empty', M.resolveTyped('  ', ctx).ok, false);
eq('typed relative from virtual', M.resolveTyped('foo', { cwd: 'mantle:home' }).ok, false);

/* names */
eq('ext', M.extOf('a.b.PNG'), '.png');
eq('ext none', M.extOf('Makefile'), '');
eq('ext dotfile', M.extOf('.gitignore'), '.gitignore');
eq('ext folder', M.extOf('a.b', true), '');
eq('stem', M.stemLength('report.final.docx'), 12);
eq('stem dotfile', M.stemLength('.env'), 4);
eq('stem folder', M.stemLength('v1.2', true), 4);
eq('display hides ext', M.displayName('a.txt', false, false), 'a');
eq('display keeps dotfile', M.displayName('.env', false, false), '.env');
eq('valid', M.validName('Notes 2.txt'), null);
eq('invalid char', typeof M.validName('a:b'), 'string');
eq('invalid trailing dot', typeof M.validName('abc.'), 'string');
eq('invalid reserved', typeof M.validName('con.txt'), 'string');
eq('invalid empty', typeof M.validName('   '), 'string');

/* types */
eq('type folder', M.typeOf(it('x', { d: 1 }), { folder: 'File folder' }), 'File folder');
eq('type known', M.typeOf(it('x.png'), { '.png': 'PNG File' }), 'PNG File');
eq('type unknown', M.typeOf(it('x.qqq'), {}), 'QQQ File');
eq('type bare', M.typeOf(it('README'), {}), 'File');

/* natural sort */
const nat = M.sortItems([it('file10.txt'), it('File2.txt'), it('file1.txt'), it('b'), it('A'), it('_x'), it('1 a')], { sort: 'name' });
eq('natural order', names(nat), ['_x', '1 a', 'A', 'b', 'file1.txt', 'File2.txt', 'file10.txt']);
eq('leading zeros', names(M.sortItems([it('a010'), it('a9'), it('a0009')], { sort: 'name' })), ['a0009', 'a9', 'a010']);
eq('big numbers', names(M.sortItems([it('v12345678901234567890'), it('v99')], { sort: 'name' })), ['v99', 'v12345678901234567890']);
eq('folders first', names(M.sortItems([it('a.txt'), it('zeta', { d: 1 }), it('beta', { d: 1 })], { sort: 'name' })), ['beta', 'zeta', 'a.txt']);
eq('folders first desc', names(M.sortItems([it('a.txt'), it('b.txt'), it('zeta', { d: 1 }), it('beta', { d: 1 })], { sort: 'name', dir: 'desc' })), ['zeta', 'beta', 'b.txt', 'a.txt']);
eq('sort size', names(M.sortItems([it('a', { s: 5 }), it('b', { s: 1 }), it('c', { s: 3 })], { sort: 'size' })), ['b', 'c', 'a']);
eq('sort size desc', names(M.sortItems([it('a', { s: 5 }), it('b', { s: 1 }), it('c', { s: 3 })], { sort: 'size', dir: 'desc' })), ['a', 'c', 'b']);
eq('sort date ties by name', names(M.sortItems([it('b', { m: 1 }), it('a', { m: 1 }), it('c', { m: 0 })], { sort: 'date' })), ['c', 'a', 'b']);
eq('sort type', names(M.sortItems([it('a.txt'), it('b.png'), it('c.doc')], { sort: 'type', types: { '.txt': 'Text Document', '.png': 'PNG File', '.doc': 'Word' } })), ['b.png', 'a.txt', 'c.doc']);
eq('sort location', names(M.sortItems([it('a', { loc: 'D:\\z' }), it('b', { loc: 'C:\\y' })], { sort: 'location' })), ['b', 'a']);
eq('sort does not mutate', (() => { const a = [it('b'), it('a')]; M.sortItems(a, {}); return names(a); })(), ['b', 'a']);

/* hidden */
eq('hide hidden', names(M.filterHidden([it('a'), it('b', { a: 2 }), it('c', { a: 6 })], false)), ['a']);
eq('show hidden', M.filterHidden([it('a'), it('b', { a: 2 })], true).length, 2);

/* grouping */
const now = new Date(2026, 8, 30, 15, 0).getTime();      // Wednesday 30 Sep 2026, 3 pm local
const at = (y, mo, d, h) => new Date(y, mo, d, h || 12).getTime();
const bands = M.dateBands(now);
const g = (t) => bands[M.dateGroup(t, bands)][0];
eq('date today', g(at(2026, 8, 30, 1)), 'Today');
eq('date yesterday', g(at(2026, 8, 29)), 'Yesterday');
eq('date this week', g(at(2026, 8, 27)), 'Earlier this week');
eq('date last week', g(at(2026, 8, 22)), 'Last week');
eq('date this month', g(at(2026, 8, 5)), 'Earlier this month');
eq('date last month', g(at(2026, 7, 5)), 'Last month');
eq('date this year', g(at(2026, 1, 5)), 'Earlier this year');
eq('date long ago', g(at(2019, 1, 5)), 'A long time ago');
eq('date future', g(at(2026, 9, 3)), 'In the future');
eq('date zero', g(0), 'A long time ago');
const grouped = M.arrange([it('b.txt', { m: at(2026, 8, 30) }), it('a.txt', { m: at(2019, 0, 1) }), it('c.txt', { m: at(2026, 8, 29) })], { group: 'date', now });
eq('arrange date groups', grouped.groups, [{ label: 'Today', start: 0, count: 1 }, { label: 'Yesterday', start: 1, count: 1 }, { label: 'A long time ago', start: 2, count: 1 }]);
eq('arrange date shown', names(grouped.shown), ['b.txt', 'c.txt', 'a.txt']);
eq('size group', ['a', 'b', 'c', 'd'].map((n, i) => M.sizeGroup(it(n, { s: [0, 100, 2e6, 5e9][i] })).label), ['Empty', 'Tiny (under 16 KB)', 'Medium (1 to 128 MB)', 'Gigantic (over 4 GB)']);
eq('size group folder', M.sizeGroup(it('x', { d: 1 })).label, 'Folders');
const lg = M.arrange([it('beta'), it('9 lives'), it('alpha'), it('#tag'), it('Apple')], { group: 'letter' });
eq('letter groups', lg.groups.map((x) => x.label), ['#', '0–9', 'A', 'B']);
eq('letter group shown', names(lg.shown), ['#tag', '9 lives', 'alpha', 'Apple', 'beta']);
const tg = M.arrange([it('a.txt'), it('f', { d: 1 }), it('b.png')], { group: 'type', types: { '.txt': 'Text Document', '.png': 'PNG File', folder: 'File folder' } });
eq('type groups folders first', tg.groups.map((x) => x.label), ['File folder', 'PNG File', 'Text Document']);
eq('arrange none', M.arrange([it('b'), it('a')], { group: 'none' }).groups, null);
eq('arrange hides', M.arrange([it('b', { a: 2 }), it('a')], {}).shown.length, 1);
const sec = M.arrange([it('r1', { _grp: 'Recent', _grank: 1 }), it('p1', { _grp: 'Pinned', _grank: 0, d: 1 })], { group: 'none' });
eq('sections', sec.groups.map((x) => x.label), ['Pinned', 'Recent']);

/* numbers in words */
eq('size bytes', M.fmtSize(0), '0 bytes');
eq('size byte', M.fmtSize(1), '1 byte');
eq('size kb', M.fmtSize(1536), '1.5 KB');
eq('size kb round', M.fmtSize(1024), '1 KB');
eq('size mb', M.fmtSize(12.34 * 1048576), '12.3 MB');
eq('size big mb', M.fmtSize(345 * 1048576), '345 MB');
eq('size gb', M.fmtSize(1.25 * 1073741824), '1.3 GB');
eq('size 1000 KB rolls', M.fmtSize(1000 * 1024), '1 MB');
eq('size null', M.fmtSize(null), '');
eq('count', M.fmtCount(1234567), '1,234,567');
eq('date fmt', M.fmtDate(new Date(2026, 8, 28, 14, 5).getTime()), '9/28/2026 2:05 PM');
eq('date fmt midnight', M.fmtDate(new Date(2026, 0, 2, 0, 7).getTime()), '1/2/2026 12:07 AM');
eq('date fmt none', M.fmtDate(0), '');
eq('plural', [M.plural(1, 'item'), M.plural(3, 'item')], ['1 item', '3 items']);

/* columns */
eq('cols default', M.parseCols(null, 'folder').map((c) => c.id), ['name', 'date', 'type', 'size']);
eq('cols parse', M.parseCols(['date:200', 'name:333', 'bogus', 'size'], 'folder'), [{ id: 'name', w: 333 }, { id: 'date', w: 200 }, { id: 'size', w: 96 }]);
eq('cols clamp', M.parseCols(['name:5'], 'folder')[0].w, 120);
eq('cols encode', M.encodeCols([{ id: 'name', w: 250.4 }]), ['name:250']);
eq('col label recycle', M.colLabel('location', 'recycle'), 'Original location');

/* odds and ends */
const shown = [it('alpha'), it('beta'), it('bravo'), it('charlie')];
eq('typeahead', M.findTypeAhead(shown, 'b', 0), 1);
eq('typeahead next', M.findTypeAhead(shown, 'b', 2), 2);
eq('typeahead wraps', M.findTypeAhead(shown, 'a', 1), 0);
eq('typeahead miss', M.findTypeAhead(shown, 'zz', 0), -1);
eq('summarize', M.summarize([it('a', { s: 10 }), it('b', { d: 1 }), it('c', { s: 5 })]), { count: 3, files: 2, dirs: 1, bytes: 15 });
eq('fail lines', M.failLines([{ src: 'C:\\a\\x.txt', ok: false, why: 'in use' }, { src: 'C:\\a\\y', ok: true }, { src: 'C:\\a\\z', ok: false, hr: -2147024891 }]),
  [{ name: 'x.txt', why: 'It is open in another app. Close it there, then try again.' }, { name: 'z', why: 'Windows did not allow this. It may need administrator rights, or the item is protected.' }]);
eq('thumb key', M.thumbKey('C:\\A.png', 5, 6, 96), 'c:\\a.png|5|6|96');

/* speed: 10,000 names sort in well under a frame budget per key (numbers go to shoot.js too) */
const big = [];
for (let i = 0; i < 10000; i++) big.push(it(`Item ${(i * 7919) % 10000} part ${i % 13}.${['txt', 'png', 'docx', 'zip'][i % 4]}`, { s: (i * 104729) % 9999991, m: 1.7e12 + ((i * 7) % 1000) * 3.6e6, d: i % 20 === 0 ? 1 : 0 }));
for (const k of ['name', 'date', 'type', 'size']) {
  for (const x of big) delete x._k;
  const t0 = process.hrtime.bigint();
  M.sortItems(big, { sort: k });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  eq(`sort 10k by ${k} under 250 ms (${ms.toFixed(1)} ms)`, ms < 250, true);
}

/* filters (lane files2) */
{
  const now = new Date(2026, 8, 29, 15, 0, 0).getTime();
  const day = 864e5;
  const xs = [it('Photos', { d: 1, a: 16, m: now - 2 * day }), it('a.jpg', { s: 2e6, m: now - 60 * 1000 }), it('b.PNG', { s: 0, m: now - 3 * day }),
    it('c.mp4', { s: 2e9, m: now - 400 * day }), it('d.docx', { s: 20000, m: now - 20 * day }), it('e.xyz', { s: 5, m: now - 100 * day }),
    it('f.ts', { s: 300, m: now }), it('g', { s: 1, m: now })];
  eq('kindOf', xs.map(M.kindOf), ['folder', 'picture', 'picture', 'video', 'document', 'other', 'code', 'other']);
  eq('filter: none keeps all', M.filterItems(xs, null, now).length, 8);
  eq('filter: kind pictures', names(M.filterItems(xs, { kind: ['picture'] }, now)), ['a.jpg', 'b.PNG']);
  eq('filter: kind folder + other', names(M.filterItems(xs, { kind: ['folder', 'other'] }, now)), ['Photos', 'e.xyz', 'g']);
  eq('filter: today', names(M.filterItems(xs, { date: 'today' }, now)), ['a.jpg', 'f.ts', 'g']);
  eq('filter: last 7 days', names(M.filterItems(xs, { date: 'week' }, now)), ['Photos', 'a.jpg', 'b.PNG', 'f.ts', 'g']);
  eq('filter: older than a year', names(M.filterItems(xs, { date: 'older' }, now)), ['c.mp4']);
  eq('filter: size empty drops folders', names(M.filterItems(xs, { size: 'empty' }, now)), ['b.PNG']);
  eq('filter: size huge', names(M.filterItems(xs, { size: 'huge' }, now)), ['c.mp4']);
  eq('filter: tiny', names(M.filterItems(xs, { size: 'tiny' }, now)), ['e.xyz', 'f.ts', 'g']);
  eq('filter: combined', names(M.filterItems(xs, { kind: ['picture', 'document'], date: 'month', size: 'small' }, now)), ['d.docx']);
  eq('filter words', M.filterWords({ kind: ['picture', 'video'], date: 'week', size: 'large' }), 'Pictures, Videos · Last 7 days · Large');
  eq('filter words: empty', M.filterWords({ kind: [], date: null }), '');
  eq('arrange applies the filter', names(M.arrange(xs, { filter: { kind: ['code'] }, now }).shown), ['f.ts']);
}
/* OneDrive status */
eq('sync: pinned', M.syncState(it('x', { a: 0x80000 | 32 })).key, 'pinned');
eq('sync: online only (recall on access)', M.syncState(it('x', { a: 0x400000 | 32 })).key, 'cloud');
eq('sync: plain file outside a cloud folder', M.syncState(it('x')), null);
eq('sync: plain file inside one', M.syncState(it('x', { cloud: true })).label, 'On this device');
eq('sort by status', names(M.sortItems([it('a', { a: 0x400000 }), it('b', { a: 0x80000 }), it('c', { cloud: true })], { sort: 'status' })), ['b', 'c', 'a']);
/* rename many */
{
  const sel = [it('IMG_001.JPG'), it('IMG_002.JPG'), it('notes', { d: 1 })];
  const taken = ['IMG_001.JPG', 'IMG_002.JPG', 'notes', 'Trip (2).JPG', 'other.txt'];
  const n = M.renamePlan(sel, { mode: 'number', base: 'Trip', start: 1 }, taken);
  eq('number: names', n.rows.map((r) => r.to), ['Trip (1).JPG', 'Trip (2).JPG', 'Trip (3)']);
  eq('number: a clash with an unselected item is caught', n.rows.map((r) => r.why), [null, 'another item already has this name', null]);
  eq('number: not ok while a row clashes', [n.ok, n.why], [false, '1 name cannot be used']);
  const n2 = M.renamePlan(sel, { mode: 'number', base: 'Trip', start: 5, ext: 'lower' }, taken);
  eq('number: start 5, lower-case extensions', [n2.rows.map((r) => r.to), n2.ok, n2.changed], [['Trip (5).jpg', 'Trip (6).jpg', 'Trip (7)'], true, 3]);
  const r = M.renamePlan(sel, { mode: 'replace', find: 'img_', replace: 'Holiday ' }, taken);
  eq('replace: stem only, case-insensitive', r.rows.map((x) => x.to), ['Holiday 001.JPG', 'Holiday 002.JPG', 'notes']);
  eq('replace: ok, 2 changed', [r.ok, r.changed], [true, 2]);
  const rc = M.renamePlan(sel, { mode: 'replace', find: 'img_', replace: 'x', matchCase: true }, taken);
  eq('replace: match case finds nothing', [rc.ok, rc.why], [false, 'nothing would change']);
  const rx = M.renamePlan(sel, { mode: 'replace', find: '^IMG_0*(\\d+)', replace: 'Shot $1', regex: true }, taken);
  eq('replace: regex with a group', rx.rows.map((x) => x.to), ['Shot 1.JPG', 'Shot 2.JPG', 'notes']);
  const bad = M.renamePlan(sel, { mode: 'replace', find: '0', replace: ':' }, taken);
  eq('replace: an invalid character is caught per row', bad.rows[0].why, 'a name cannot contain \\ / : * ? " < > |');
  const dup = M.renamePlan(sel, { mode: 'replace', find: '00\\d', replace: 'x', regex: true }, taken);
  eq('replace: two rows landing on one name', dup.rows.map((x) => x.why), [null, 'two items would get this name', null]);
  const swap = M.renamePlan([it('a.txt'), it('b.txt')], { mode: 'replace', find: 'a', replace: 'b' }, ['a.txt', 'b.txt']);
  eq('replace: onto another selected item\'s current name is refused (no order games)', swap.rows[0].why, 'another selected item has this name now');
  eq('replace: a bad regex says why', /not valid/.test(M.renamePlan(sel, { mode: 'replace', find: '(', regex: true }, taken).why), true);
  // REAL patterns this node's V8 refuses (the same engine as the page): plain words on screen, the
  // engine's reason (without the person's pattern) kept as detail for the log (lane pagewords).
  const RE_CASES = [['(', 'a "(" is never closed'], ['a)', 'a ")" has no "(" before it'], ['[abc', 'a "[" is never closed'], ['*x', 'nothing before it to repeat'],
    ['a{3,1}', 'first number is bigger'], ['x\\', 'ends with a lone \\'], ['[z-a]', 'runs backwards'], ['(?<n>a)(?<n>b)', 'same name'], ['(?<1x>a)', 'not a valid name']];
  for (const [pat, words] of RE_CASES) {
    const pl = M.renamePlan(sel, { mode: 'replace', find: pat, regex: true }, taken);
    eq(`bad regex ${pat}: plain words`, pl.ok === false && pl.why.startsWith('that pattern is not valid: ') && pl.why.includes(words), true);
    if (!pl.why.includes(words)) console.log('   why was:', pl.why, '| detail:', pl.detail);
    eq(`bad regex ${pat}: no engine jargon on screen`, /Invalid regular expression|quantifier|\/gi?:/i.test(pl.why), false);
    eq(`bad regex ${pat}: the engine's reason kept for the log, without the pattern`, /^Invalid regular expression: \S/.test(pl.detail) && !pl.detail.includes(`/${pat}/`), true);
  }
  const odd = M.patternProblem(new SyntaxError('Invalid regular expression: /x/: Something new from V8'));
  eq('bad regex: an unknown reason still says what to check', [/brackets/.test(odd.words), odd.detail], [true, 'Invalid regular expression: Something new from V8']);
}

/* errors in plain words (contract 3): no code, no jargon, each says what to do next (lane files-ui) */
{
  const P = M.plainReason;
  const noCode = (s) => !/0x[0-9a-f]{4,}|\bE[A-Z]{3,}\b|Windows error|sidecar|dry ?run|undefined|null\b|NaN/i.test(s);
  eq('plain: access denied from the sidecar', P('Access is denied. (0x80070005)'), 'Windows did not allow this. It may need administrator rights, or the item is protected.');
  eq('plain: in use', /open in another app. Close it there/.test(P('The process cannot access the file because it is being used by another process. (0x80070020)')), true);
  eq('plain: missing (node code)', /not there any more.*F5/.test(P("ENOENT: no such file or directory, open 'x'")), true);
  eq('plain: drive not ready', /drive is not ready.*try again/.test(P('The device is not ready. (0x80070015)')), true);
  eq('plain: offline OneDrive file', /OneDrive is not running.*Start OneDrive/.test(P('The cloud file provider is not running. (0x8007016A)')), true);
  eq('plain: disk full', /not enough free space/.test(P('There is not enough space on the disk. (0x80070070)')), true);
  eq('plain: network', /network location cannot be reached/.test(P('The network path was not found. (0x80070035)')), true);
  eq('plain: no answer', /Mantle did not answer/.test(P('')), true);
  eq('plain: sidecar jargon never shows', /Mantle did not answer/.test(P('the sidecar is not running')), true);
  // Unknown words keep their words; the code becomes plain-error's sentence, exactly as main already sends it.
  eq('plain: unknown words keep their words, lose the code', P('The media is sealed by policy X (0x80071234)'), 'The media is sealed by policy X (Windows reported an unexpected error).');
  // ONE TABLE (lane pagewords): Files' sentence for a raw reason == its sentence for main's plain version of it
  const PW = require('../../lib/plain-error.js');
  const RAWS = ['Access is denied. (0x80070005)', '(0x80070020)', 'The cloud file provider is not running. (0x8007016A)', '(0x80070187)', '(0x80070015)', '(0x80070070)', '(0x80070035)',
    '(0x800700CE)', '(0x80070013)', '(0x800700B7)', '(0x80070002)', '(0x80070003)', '(0x8007007B)', '(0x80070091)', '(0x80070570)', '(0x800704C7)', 'EBUSY: resource busy', 'EACCES: permission denied',
    "ENOENT: no such file or directory, open 'x'", 'ENOSPC: no space left', '(0x80004005)', 'job fo12 failed (0x80004005)', 'COMException (0x8024402C)', 'they are already in this folder', ''];
  const disagree = RAWS.filter((r) => P(r) !== P(PW.plain(r))).map((r) => `${r} -> ${P(r)} | ${P(PW.plain(r))}`);
  eq('one table: a raw reason and main\'s plain version of it land on the same sentence', disagree, []);
  const codeLike = (s) => /0x[0-9a-f]{4,}/i.test(s) || /\bE[A-Z]{3,}\b/.test(s) || /Windows error|sidecar|dry ?run|undefined|NaN/i.test(s);
  eq('one table: every Files sentence is code-free', RAWS.map(P).filter(codeLike), []);
  eq('one table: main\'s internal error reads as Files\' own', P(PW.INTERNAL), 'Mantle Files hit an internal error. Try again; if it keeps happening, restart Mantle.');
  eq('preload: a lost bridge reads as no answer', P('Mantle did not answer. Try again; if it keeps happening, restart Mantle.'), 'Mantle did not answer. Try again; if it keeps happening, restart Mantle.');
  let bugE = null; try { null.f(); } catch (e) { bugE = e; }
  const bd = M.bugDetail(Object.assign(bugE, { stack: 'TypeError: x\n    at go (file:///C:/Users/Robin/mantle/ui/files/files.js:812:9)' }));
  eq('bug detail: Name: message and Mantle\'s own path, no home folder', [/^TypeError: Cannot read properties of null/.test(bd), /\(at ui\/files\/files\.js:812\)$/.test(bd), /Robin|file:/.test(bd)], [true, true, false]);
  eq('plain: a bare unknown code says something useful', noCode(P('(0x80004005)')) && P('(0x80004005)').length > 20, true);
  eq('plain: already plain stays', P('they are already in this folder'), 'They are already in this folder.');
  const all = ['Access is denied. (0x80070005)', 'x (0x80070002)', 'EBUSY: resource busy', 'Windows error 0x80070570', 'hr -2147024864', 'job fo12 failed (0x80004005)', 'dry run: nothing'];
  eq('plain: none of them shows a code or jargon', all.map(P).filter((s) => !noCode(s)), []);
  eq('fail lines map through the plain words', M.failLines([{ src: 'C:\\a\\x.txt', ok: false, hr: -2147024864 }])[0].why, 'It is open in another app. Close it there, then try again.');
  eq('time left: unknown at first', M.timeLeft(10, 100, 500), '');
  eq('time left: minutes', M.timeLeft(25, 100, 60000), 'About 3 minutes left');
  eq('time left: seconds', M.timeLeft(50, 100, 20000), 'About 20 seconds left');
  // lane mantle-warm: the saved-view note shown until the live listing replaces the cached rows
  const T0 = 1800000000000;
  eq('cache note: a few seconds old', M.cacheNote(T0 - 3000, T0), 'Saved view from a few seconds ago · refreshing…');
  eq('cache note: seconds', M.cacheNote(T0 - 34000, T0), 'Saved view from 30 seconds ago · refreshing…');
  eq('cache note: one minute', M.cacheNote(T0 - 61000, T0), 'Saved view from 1 minute ago · refreshing…');
  eq('cache note: hours', M.cacheNote(T0 - 2 * 3600000, T0), 'Saved view from 2 hours ago · refreshing…');
  eq('cache note: days', M.cacheNote(T0 - 3 * 86400000, T0), 'Saved view from 3 days ago · refreshing…');
  eq('cache note: unknown age says only that it is saved', M.cacheNote(0, T0), 'Saved view · refreshing…');
  eq('cache note: a clock that went back says no age (never "-5 seconds ago")', M.cacheNote(T0 + 5000, T0), 'Saved view · refreshing…');
  eq('time left: done', M.timeLeft(100, 100, 60000), '');
  const its = ['C:\\a\\1.txt', 'C:\\a\\2.txt', 'C:\\a\\3.txt', 'C:\\a\\4.txt'];
  const cf = [{ src: its[0] }, { src: its[1] }, { src: its[2] }];
  eq('conflict groups: one answer for all', M.conflictGroups(its, cf, { all: 'replace' }), [{ conflict: 'replace', items: its }]);
  eq('conflict groups: one each, the free item rides with the first group', M.conflictGroups(its, cf, { each: { [its[0]]: 'replace', [its[1]]: 'skip', [its[2]]: 'keepboth' } }),
    [{ conflict: 'keepboth', items: [its[3], its[2]] }, { conflict: 'replace', items: [its[0]] }]);
  eq('conflict groups: every clash skipped, the free one still goes (safely)', M.conflictGroups(its, cf, { each: { [its[0]]: 'skip', [its[1]]: 'skip', [its[2]]: 'skip' } }),
    [{ conflict: 'skip', items: [its[3]] }]);
  eq('conflict groups: all skipped and nothing free = nothing to do', M.conflictGroups(its.slice(0, 1), cf.slice(0, 1), { each: { [its[0]]: 'skip' } }), []);
  eq('conflict groups: cancelled', M.conflictGroups(its, cf, null), []);
  eq('conflict groups: "skip" for all, nothing free = nothing to do', M.conflictGroups(its.slice(0, 3), cf, { all: 'skip' }), []);
  eq('conflict groups: "skip" for all, only the free one goes', M.conflictGroups(its, cf, { all: 'skip' }), [{ conflict: 'skip', items: [its[3]] }]);
}

console.log(`FILES MODEL TEST: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
