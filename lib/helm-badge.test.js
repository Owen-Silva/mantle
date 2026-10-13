'use strict';
/*
 * helm-badge.test.js - app counts on the bar (lane badge, 2026-10-09).
 *
 *   node lib/helm-badge.test.js   -> "HELM BADGE TEST: n passed, m failed"
 *
 * Plain node, no Electron, no window: lib/helm-badge.js (parse, match, the folder watch on a REAL temp
 * file written by rename like Helm's atomic write, a dead pid, the feature with a fake ctx) and
 * ui/bar/helmbadge.js (the cell painter, in a vm with a tiny fake DOM).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const hb = require('./helm-badge');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok  ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return !!fn(); }

function atomicWrite(file, obj) { fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj)); fs.renameSync(`${file}.tmp`, file); }

async function main() {
  // ---- parseBadge ----
  const alive = (pid) => pid === 111;
  let p = hb.parseBadge(JSON.stringify({ v: 1, count: 3, waiting: 2, errors: 1, pid: 111 }), { alive });
  check('parse: count, waiting, errors', p.count === 3 && p.waiting === 2 && p.errors === 1 && p.reason === '', JSON.stringify(p));
  p = hb.parseBadge(JSON.stringify({ count: 3, waiting: 2, errors: 1, pid: 222 }), { alive });
  check('parse: a dead pid hides the count (crash left it behind)', p.count === 0 && p.reason === 'not running', JSON.stringify(p));
  p = hb.parseBadge(JSON.stringify({ count: 0, waiting: 0, errors: 0, pid: null }), { alive });
  check('parse: 0 = no badge, no reason', p.count === 0 && p.reason === '', JSON.stringify(p));
  p = hb.parseBadge(null);
  check('parse: missing file = no badge, "not running"', p.count === 0 && p.reason === 'not running');
  p = hb.parseBadge('{nope');
  check('parse: a broken file says so', p.count === 0 && /could not be read/.test(p.reason));
  p = hb.parseBadge(JSON.stringify({ waiting: 1, errors: 2 }));
  check('parse: count missing = waiting + errors; no pid = trusted', p.count === 3, JSON.stringify(p));
  p = hb.parseBadge(JSON.stringify({ count: -4, waiting: 'x' }));
  check('parse: junk numbers = 0', p.count === 0 && p.waiting === 0);
  check('pidAlive: this process yes, 0 no', hb.pidAlive(process.pid) === true && hb.pidAlive(0) === false);

  // ---- matches ----
  const item = { exe: 'c:\\users\\user\\helm\\dist\\helm\\helm.exe' };
  check('match: bare name matches any folder', hb.matches({ exe: 'helm.exe' }, item) && hb.matches({ exe: 'Helm.EXE' }, item));
  check('match: bare name does not match a suffix of another name', !hb.matches({ exe: 'helm.exe' }, { exe: 'c:\\x\\overhelm.exe' }));
  check('match: full path equal, case-insensitive', hb.matches({ exe: 'C:/Users/user/helm/dist/Helm/Helm.exe' }, item) && !hb.matches({ exe: 'C:\\other\\helm.exe' }, item));
  check('match: an item without exe (store app) never matches', !hb.matches({ exe: 'helm.exe' }, { aumid: 'x' }));

  // ---- describe ----
  check('describe', hb.describe({ count: 2, waiting: 1, errors: 1 }) === '2 need you: 1 waiting, 1 stopped on an error' && hb.describe({ count: 1, waiting: 1, errors: 0 }) === '1 needs you: 1 waiting' && hb.describe({ count: 0 }) === '');

  // ---- defaultSources / cleanSources ----
  const ds = hb.defaultSources({ APPDATA: 'C:\\A' });
  check('default source = Helm\'s badge.json under APPDATA', ds.length === 1 && ds[0].exe === 'helm.exe' && ds[0].file === path.join('C:\\A', 'Helm', 'badge.json'), JSON.stringify(ds));
  check('MANTLE_HELM_BADGE_FILE overrides the file', hb.defaultSources({ APPDATA: 'C:\\A', MANTLE_HELM_BADGE_FILE: 'C:\\t\\b.json' })[0].file === 'C:\\t\\b.json');
  const cs = hb.cleanSources([{ exe: 'a.exe', file: 'C:\\x\\a.json' }, { exe: '', file: 'C:\\y' }, { exe: 'b.exe', file: 'relative.json' }, null]);
  check('cleanSources keeps exe + absolute file only, label from exe', cs.length === 1 && cs[0].label === 'a', JSON.stringify(cs));

  // ---- createWatcher on a real folder ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-helmbadge-'));
  const file = path.join(dir, 'Helm', 'badge.json');
  const seen = [];
  const w = hb.createWatcher({ file, onChange: (s) => seen.push(s), settleMs: 20, recheckMs: 150 });
  try {
    check('watch: missing folder = 0 "not running"', w.state().count === 0 && w.state().reason === 'not running');
    fs.mkdirSync(path.dirname(file));
    atomicWrite(file, { v: 1, count: 2, waiting: 2, errors: 0, pid: process.pid, updatedAt: Date.now() });
    check('watch: folder created later is picked up by the slow re-check, count 2', await until(() => w.state().count === 2), JSON.stringify(w.state()));
    atomicWrite(file, { v: 1, count: 3, waiting: 2, errors: 1, pid: process.pid, updatedAt: Date.now() });
    check('watch: a rename-replace is seen (count 3, 1 error)', await until(() => w.state().count === 3 && w.state().errors === 1), JSON.stringify(w.state()));
    const before = seen.length;
    atomicWrite(file, { v: 1, count: 3, waiting: 2, errors: 1, pid: process.pid, updatedAt: Date.now() + 1 });
    await sleep(120);
    check('watch: same numbers = no change event', seen.length === before, `${before} -> ${seen.length}`);
    atomicWrite(file, { v: 1, count: 0, waiting: 0, errors: 0, pid: null, updatedAt: Date.now() });
    check('watch: back to 0 (Helm quit cleanly)', await until(() => w.state().count === 0 && w.state().reason === ''), JSON.stringify(w.state()));
    atomicWrite(file, { v: 1, count: 1, waiting: 1, errors: 0, pid: 2147483000, updatedAt: Date.now() });
    await sleep(150);
    check('watch: a count from a dead pid stays hidden', w.state().count === 0 && w.state().reason === 'not running', JSON.stringify(w.state()));
    fs.writeFileSync(file, '{broken');
    check('watch: a broken file is reported', await until(() => /could not be read/.test(w.state().reason)), JSON.stringify(w.state()));
  } finally { w.close(); }

  // ---- the feature with a fake ctx ----
  const f2 = path.join(dir, 'Helm', 'badge2.json');
  atomicWrite(f2, { v: 1, count: 1, waiting: 0, errors: 1, pid: process.pid, updatedAt: Date.now() });
  const casts = []; let replay = null; let enabledFn = null; const health = [];
  const ctx = {
    settings: { get: (k, d) => (k === 'sources' ? [{ exe: 'helm.exe', file: f2, label: 'Helm' }] : d) },
    enabled: () => true, onEnabled: (fn) => { enabledFn = fn; },
    broadcast: (ev, pl) => casts.push({ ev, pl }), replay: (ev, fn) => { replay = { ev, fn }; },
    health: (ok, why) => health.push({ ok, why }), log: () => {},
  };
  check('feature: name equals its future file name, contract fields', hb.feature.name === 'helmbadge' && typeof hb.feature.label === 'string' && hb.feature.defaultOn === true && typeof hb.feature.install === 'function');
  const handle = hb.feature.install(ctx);
  try {
    const last = () => casts.length && casts[casts.length - 1].pl.badges[0];
    check('feature: broadcasts helmbadge.state with the count + tooltip', casts.length && casts[0].ev === 'helmbadge.state' && last().count === 1 && last().errors === 1 && last().tip === '1 needs you: 1 stopped on an error', JSON.stringify(casts));
    check('feature: replays helmbadge.state on subscribe', replay && replay.ev === 'helmbadge.state' && replay.fn().badges[0].count === 1);
    check('feature: healthy', health.length && health[health.length - 1].ok === true);
    enabledFn(false);
    check('feature: switched off = count 0, reason "turned off"', last().count === 0 && last().reason === 'turned off');
    enabledFn(true);
    atomicWrite(f2, { v: 1, count: 4, waiting: 4, errors: 0, pid: process.pid, updatedAt: Date.now() });
    check('feature: a file change is pushed to the bar', await until(() => last().count === 4), JSON.stringify(last()));
  } finally { handle.stop(); }
  const h2 = []; const bad = hb.feature.install({ ...ctx, settings: { get: (k, d) => (k === 'sources' ? [{ exe: '', file: 'x' }] : d) }, health: (ok, why) => h2.push({ ok, why }) });
  check('feature: an unusable sources setting is a health failure in words', h2.length && h2[0].ok === false && /no usable entry/.test(h2[0].why));
  bad.stop();
  fs.rmSync(dir, { recursive: true, force: true });

  // ---- ui/bar/helmbadge.js painter in a vm with a tiny DOM ----
  function makeCell(item, tip) {
    const kids = [];
    const cls = new Set(['cell']);
    const cell = {
      _item: item, _tip: tip, title: tip, attrs: {}, kids,
      classList: { contains: (c) => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } },
      querySelector: (sel) => kids.find((k) => k.className.split(' ').includes(sel.replace(/^(:scope > )?\./, ''))) || null,
      appendChild: (k) => { k.remove = () => kids.splice(kids.indexOf(k), 1); kids.push(k); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    };
    return cell;
  }
  function el() {
    const cls = new Set();
    const e = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
      classList: { contains: (c) => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } };
    Object.defineProperty(e, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); String(v).split(' ').filter(Boolean).forEach((c) => cls.add(c)); } });
    return e;
  }
  const helmCell = makeCell({ name: 'Helm', exe: 'c:\\users\\user\\helm\\dist\\helm\\helm.exe' }, 'Helm');
  const otherCell = makeCell({ name: 'Notepad', exe: 'c:\\windows\\notepad.exe' }, 'Notepad');
  let handler = null;
  const sandbox = { window: {}, console, document: { createElement: () => el(), querySelectorAll: (sel) => (sel === '.cell' ? [helmCell, otherCell] : []), getElementById: () => null } };
  sandbox.window.mantle = { on: (ev, fn) => { if (ev === 'helmbadge.state') handler = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'bar', 'helmbadge.js'), 'utf8'), sandbox);
  const MB = sandbox.window.MantleBadges;
  check('bar: subscribes to helmbadge.state and exports MantleBadges', !!handler && MB && typeof MB.paint === 'function' && MB.error() === null);
  MB.paint(helmCell, helmCell._item); MB.paint(otherCell, otherCell._item);
  check('bar: no state yet = no badge', helmCell.kids.length === 0);
  handler({ badges: [{ exe: 'helm.exe', label: 'Helm', count: 2, waiting: 2, errors: 0, reason: '', tip: '2 need you: 2 waiting' }] });
  const badge = () => helmCell.kids.find((k) => /hb-badge/.test(k.className));
  check('bar: a push paints "2" on the Helm cell only', badge() && badge().textContent === '2' && !/warn/.test(badge().className) && otherCell.kids.length === 0, JSON.stringify(helmCell.kids.map((k) => [k.className, k.textContent])));
  check('bar: tooltip + aria-label say it', helmCell.title === 'Helm\n2 need you: 2 waiting' && helmCell.attrs['aria-label'] === 'Helm, 2 need you: 2 waiting', JSON.stringify([helmCell.title, helmCell.attrs]));
  handler({ badges: [{ exe: 'helm.exe', count: 12, waiting: 10, errors: 2, reason: '', tip: '12 need you: 10 waiting, 2 stopped on an error' }] });
  check('bar: 12 shows "9+", warn colour with an error, one line in the tooltip', badge().textContent === '9+' && /warn/.test(badge().className) && helmCell.title.split('\n').length === 2, JSON.stringify([badge().className, helmCell.title]));
  handler({ badges: [{ exe: 'helm.exe', count: 0, waiting: 0, errors: 0, reason: 'not running', tip: '' }] });
  check('bar: 0 removes the badge and the tooltip line', !badge() && helmCell.title === 'Helm' && !helmCell.classList.contains('hb-on'), JSON.stringify([helmCell.kids.length, helmCell.title]));

  // the tooltip: the line lives in _tip (ontop.js and the "+N" panel read it), a fresh base from bar.js is kept
  handler({ badges: [{ exe: 'helm.exe', count: 1, waiting: 1, errors: 0, reason: '', tip: '1 needs you: 1 waiting' }] });
  check('bar: the count line goes into _tip too (ontop.js builds on it)', helmCell._tip === 'Helm\n1 needs you: 1 waiting', JSON.stringify(helmCell._tip));
  handler({ badges: [{ exe: 'helm.exe', count: 3, waiting: 3, errors: 0, reason: '', tip: '3 need you: 3 waiting' }] });
  check('bar: a second push replaces the line, never stacks it', helmCell._tip === 'Helm\n3 need you: 3 waiting' && helmCell.title === helmCell._tip, JSON.stringify(helmCell.title));
  helmCell._tip = 'Helm - 1 window'; helmCell.title = 'Helm - 1 window';   // what bar.js updateCell does
  MB.paint(helmCell, helmCell._item);
  check('bar: a fresh base from updateCell gets the line again', helmCell.title === 'Helm - 1 window\n3 need you: 3 waiting', JSON.stringify(helmCell.title));
  helmCell._fly = true;
  handler({ badges: [{ exe: 'helm.exe', count: 5, waiting: 5, errors: 0, reason: '', tip: '5 need you: 5 waiting' }] });
  check('bar: while a flyout / drag holds the tooltip, title is untouched but _tip is current', helmCell.title === 'Helm - 1 window\n3 need you: 3 waiting' && helmCell._tip === 'Helm - 1 window\n5 need you: 5 waiting' && badge().textContent === '5', JSON.stringify([helmCell.title, helmCell._tip]));
  helmCell._fly = false;
  handler({ badges: [{ exe: 'helm.exe', count: 0, waiting: 0, errors: 0, reason: 'its badge file could not be read', tip: '' }] });
  check('bar: an unreadable file hides the count AND says why in the tooltip', !badge() && helmCell.title === 'Helm - 1 window\nCount hidden: its badge file could not be read', JSON.stringify(helmCell.title));
  handler({ badges: [{ exe: 'helm.exe', count: 0, waiting: 0, errors: 0, reason: 'turned off', tip: '' }] });
  check('bar: switched off / not running = no line (a normal state)', !badge() && helmCell.title === 'Helm - 1 window', JSON.stringify(helmCell.title));

  // "+N": an app behind it keeps its count on the button, and on its tile in the panel
  const more = makeCell(null, '');
  more.hidden = false; more.title = '2 more apps that do not fit';
  sandbox.document.querySelectorAll = (sel) => (sel === '#dock .cell.ovf' ? [helmCell] : sel === '.cell' ? [helmCell, otherCell] : []);
  handler({ badges: [{ exe: 'helm.exe', count: 2, waiting: 1, errors: 1, reason: '', tip: '2 need you: 1 waiting, 1 stopped on an error' }] });
  MB.paintMore(more);
  const moreDisc = () => more.kids.find((k) => /hb-badge/.test(k.className));
  check('bar: "+N" carries the count of an app behind it (warn: one is an error)', moreDisc() && moreDisc().textContent === '2' && /warn/.test(moreDisc().className) && more.title === '2 more apps that do not fit\nNeeds you: Helm 2', JSON.stringify([more.kids.map((k) => k.textContent), more.title]));
  MB.paintMore(more);
  check('bar: repainting "+N" never stacks the line', more.title.split('\n').length === 2, more.title);
  more.hidden = true; MB.paintMore(more);
  check('bar: a hidden "+N" carries no disc and no line', !moreDisc() && more.title === '2 more apps that do not fit', JSON.stringify([more.kids.length, more.title]));
  const tile = makeCell(null, '');
  const ico = el(); ico.className = 'ico ovf-ico';
  ico.parentNode = tile; tile.kids.push(ico);
  tile.insertBefore = (wrap, ref) => { tile.kids.splice(tile.kids.indexOf(ref), 1, wrap); wrap.kids = []; wrap.querySelector = (sel) => wrap.kids.find((k) => sel.replace(/^:scope > /, '') === '.' + k.className.split(' ')[0]) || null; wrap.appendChild = (k) => { k.remove = () => wrap.kids.splice(wrap.kids.indexOf(k), 1); k.parentNode = wrap; wrap.kids.push(k); }; };
  MB.paintTile(tile, helmCell);
  const wrapEl = tile.kids.find((k) => /hb-wrap/.test(k.className));
  check('bar: a "+N" panel tile gets the same disc, on its icon', wrapEl && wrapEl.kids[0] === ico && wrapEl.kids.some((k) => /hb-badge/.test(k.className) && k.textContent === '2') && tile.title === helmCell._tip, JSON.stringify(tile.kids.map((k) => k.className)));
  sandbox.document.querySelectorAll = (sel) => (sel === '.cell' ? [helmCell, otherCell] : []);

  // the CSS uses only the allowed tokens
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'bar', 'helmbadge.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = [...new Set((css.match(/var\(--[a-z0-9-]+\)/g) || []))].sort();
  check('css: colours only via --lg-acc / --lg-acc-on / --lg-warn / --lg-fill-strong (ring), no literals', JSON.stringify(vars) === JSON.stringify(['var(--lg-acc-on)', 'var(--lg-acc)', 'var(--lg-fill-strong)', 'var(--lg-warn)'].sort()) && !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css), JSON.stringify(vars));
}

main().catch((e) => { failures.push(`threw: ${e && e.stack}`); console.log(e); }).finally(() => {
  console.log(`HELM BADGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
});
