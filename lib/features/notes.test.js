'use strict';
/*
 * notes.test.js - quick notes, in node, no Electron, no sidecar (lane tbnotes, 2026-09-27).
 *
 *   node lib/features/notes.test.js
 *
 * Every file lives in a TEMP folder made here (os.tmpdir()) and removed at the end; the user's
 * Documents is never read or written. Proves the store (round trips of nasty texts, a marker-less
 * file, atomic saves, a failed save's reason, outside changes kept aside, deleted.md first and a
 * refused delete) and the feature against a fake ctx + fake window whose "page" answers
 * executeJavaScript like window.__notesTake: dirty -> pull -> write, reload on open after an outside
 * change, delete, prune on close, the top bar's wasOpen / blur rules, stop() flushing first, a rest
 * keeping unsaved notes, a rescue file on a quit that cannot save, the --test folder never under
 * Documents, the window never shown or focused in --test, and PRIVACY: no note text in any log
 * line, health reason, command argument, broadcast, or any command result except notes.load.
 *
 * Prints one summary line, "NOTES: n passed, m failed"; exits 1 if anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const St = require('./_notes-store.js');
const F = require('./notes.js');
const hub = require('./_tools-hub.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + detail : ''));
}
const show = (x) => JSON.stringify(x);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((r) => setImmediate(r));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-notes-test-'));
const DOCS = path.join(process.env.USERPROFILE || os.homedir(), 'Documents');
const under = (p, root) => path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep) || path.resolve(p).toLowerCase() === path.resolve(root).toLowerCase();

/* ------------------------------------------------------------------ store: format */
function formatTests() {
  const nasty = [
    '', 'a', 'a\n', 'a\n\n', '\n', '\n\nx', ' ', '\t',
    '<!-- mantle:note -->', '\\<!-- mantle:note -->', '\\\\<!-- mantle:note --> x', '<!-- mantle:notes -->',
    'line1\n<!-- mantle:note -->\nline3', '  <!-- mantle:note -->', '<!-- mantle:note', '<!-- mantle:deleted 2026-01-01 -->',
    'back\\slash\\', 'C:\\Users\\x\\', '\\', 'üñíçødé · 🏒 · 日本語 · \u200b', 'x\n\n\n', 'end with marker\n<!-- mantle:note -->',
  ];
  for (const t of nasty) {
    const got = St.parse(St.serialize([t])).texts;
    check(`format: one note round-trips exactly: ${show(t)}`, eq(got, [t]), show(got));
  }
  const all = St.parse(St.serialize(nasty)).texts;
  check('format: all the nasty texts in ONE file round-trip exactly, in order', eq(all, nasty), show(all).slice(0, 200));
  const crlf = St.serialize(nasty).replace(/\n/g, '\r\n');
  check('format: the same file saved with CRLF (Notepad) reads as LF', eq(St.parse(crlf).texts, nasty));
  check('format: a "\\r\\n" inside a note is written as "\\n" (a textarea never holds \\r)', eq(St.parse(St.serialize(['a\r\nb\rc'])).texts, ['a\nb\nc']));
  check('format: a file without any marker is ONE note (hand-written)', eq(St.parse('hello\nworld\n').texts, ['hello\nworld']));
  check('format: an empty file is one empty note', eq(St.parse('').texts, ['']));
  check('format: a hand-written file keeps an escaped-looking line as is', eq(St.parse('\\<!-- mantle:note -->\n').texts, ['\\<!-- mantle:note -->']));
  check('format: text above the first marker (a hand edit) becomes a note of its own', eq(St.parse('top line\n<!-- mantle:note -->\nx\n').texts, ['top line', 'x']));
  check('format: a UTF-8 BOM is dropped', eq(St.parse('\uFEFF' + St.serialize(['a', 'b'])).texts, ['a', 'b']));
  check('format: the file is readable by hand (marker line, text, newline)', St.serialize(['one', 'two']) === '<!-- mantle:note -->\none\n<!-- mantle:note -->\ntwo\n');
  check('format: no notes is written as one empty note', St.serialize([]) === '<!-- mantle:note -->\n\n');
  const esc = St.serialize(['<!-- mantle:note -->']);
  check('format: a text line that looks like a marker is escaped with one backslash', esc === '<!-- mantle:note -->\n\\<!-- mantle:note -->\n', show(esc));
}

/* ------------------------------------------------------------------ store: files */
async function storeTests() {
  const dirA = path.join(TMP, 'a', 'Mantle Notes');
  const A = St.createStore({ dir: dirA });
  const l0 = await A.load();
  check('store: a missing file loads as one empty note', l0.ok && l0.missing && eq(l0.texts, ['']), show(l0));
  const r1 = await A.save(['first', 'second\n']);
  check('store: a save makes the folder and writes notes.md', r1.ok && fs.readFileSync(A.file, 'utf8') === St.serialize(['first', 'second\n']), show(r1));
  check('store: a save says counts (notes, characters)', r1.count === 2 && r1.chars === 12, show(r1));
  check('store: an atomic save leaves no tmp file behind', !fs.readdirSync(dirA).some((n) => /tmp-/.test(n)), show(fs.readdirSync(dirA)));
  const r1b = await A.save(['first', 'second\n']);
  check('store: saving the same text again writes nothing', r1b.ok && r1b.skipped === true, show(r1b));

  // serialized, the latest text wins
  const many = [];
  for (let i = 0; i < 6; i++) many.push(A.save([`v${i}`]));
  const rs = await Promise.all(many);
  check('store: saves run one at a time and the latest text wins', rs.every((r) => r.ok) && fs.readFileSync(A.file, 'utf8') === St.serialize(['v5']), fs.readFileSync(A.file, 'utf8'));

  // outside change
  fs.writeFileSync(A.file, 'OUTSIDE EDIT, longer than before\n');
  check('store: an outside change is seen', await A.changedOnDisk() === true);
  const r2 = await A.save(['ours after outside']);
  const copies = fs.readdirSync(dirA).filter((n) => /^notes \(changed outside Mantle \d{4}-\d\d-\d\d \d{6}\)( \d+)?\.md$/.test(n));
  check('store: an outside change is copied aside first (named with the time)', r2.ok && !!r2.outside && copies.length === 1, show({ r2, copies }));
  check('store: the copy holds the outside text', copies.length === 1 && fs.readFileSync(path.join(dirA, copies[0]), 'utf8') === 'OUTSIDE EDIT, longer than before\n');
  check('store: notes.md then holds ours', fs.readFileSync(A.file, 'utf8') === St.serialize(['ours after outside']));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(A.file, t, t);                                              // a touch (OneDrive, an editor): same text
  check('store: a touch with the same text is not an outside change', await A.changedOnDisk() === false);
  const r3 = await A.save(['after a touch']);
  check('store: ... and makes no copy', r3.ok && !r3.outside && fs.readdirSync(dirA).filter((n) => /changed outside/.test(n)).length === 1, show(r3));

  // hand-written file (never read by us) is kept aside before the first write
  const dirH = path.join(TMP, 'h');
  fs.mkdirSync(dirH, { recursive: true });
  fs.writeFileSync(path.join(dirH, 'notes.md'), 'hand written\n');
  const H = St.createStore({ dir: dirH });
  const rh = await H.save(['never loaded']);
  check('store: a file never read is kept aside before it is overwritten', rh.ok && !!rh.outside && fs.readFileSync(rh.outside, 'utf8') === 'hand written\n', show(rh));

  // failed save: a FILE named "Mantle Notes"
  const dirB = path.join(TMP, 'b', 'Mantle Notes');
  fs.mkdirSync(path.dirname(dirB), { recursive: true });
  fs.writeFileSync(dirB, 'i am a file');
  const B = St.createStore({ dir: dirB });
  let threw = null, rb = null, lb = null;
  try { lb = await B.load(); rb = await B.save(['text that cannot be saved']); } catch (e) { threw = e; }
  check('store: a failed save never throws', !threw, threw && threw.message);
  check('store: a failed save answers ok:false with a reason naming the path', rb && rb.ok === false && rb.reason.includes(dirB), show(rb));
  check('store: the reason is plain words ("a file is in the way")', rb && /a file is in the way/.test(rb.reason), rb && rb.reason);
  check('store: ... and never quotes the text', rb && !rb.reason.includes('cannot be saved'));
  check('store: loading under a file in the way is one empty note, not a throw', lb && eq(lb.texts, ['']), show(lb));

  // deleted.md
  const k = await A.appendDeleted('gone note\n<!-- mantle:note -->');
  const del = fs.readFileSync(path.join(dirA, 'deleted.md'), 'utf8');
  check('store: a deleted note is appended to deleted.md with a dated marker first', k.ok && /^<!-- mantle:deleted \d{4}-\d\d-\d\d \d\d:\d\d:\d\d -->\ngone note\n\\<!-- mantle:note -->\n$/.test(del), show(del));
  await A.appendDeleted('second gone');
  check('store: deleted.md grows (append, never overwrite)', /gone note[\s\S]*second gone/.test(fs.readFileSync(path.join(dirA, 'deleted.md'), 'utf8')));
  const dirD = path.join(TMP, 'd');
  fs.mkdirSync(path.join(dirD, 'deleted.md'), { recursive: true });        // a FOLDER where deleted.md goes
  const D = St.createStore({ dir: dirD });
  const kd = await D.appendDeleted('cannot go');
  check('store: an append that fails is refused with the reason and path', kd.ok === false && kd.reason.includes(path.join(dirD, 'deleted.md')) && !kd.reason.includes('cannot go'), show(kd));
}

/* ------------------------------------------------------------------ feature: fakes */
function fakePage() {
  const p = { rev: 0, notes: [], active: null, loaded: false, takes: 0 };
  p.take = (opts) => {
    if (!p.loaded) return null;
    p.takes++;
    if (opts && opts.prune) {
      const keep = p.notes.filter((n) => n.text.trim() !== '');
      if (keep.length && keep.length !== p.notes.length) { p.notes = keep; p.rev++; if (!keep.some((n) => n.id === p.active)) p.active = keep[0].id; }
    }
    return JSON.parse(JSON.stringify({ rev: p.rev, notes: p.notes, active: p.active }));
  };
  p.fromLoad = (r) => { p.notes = r.notes.map((n) => ({ id: n.id, text: n.text })); p.active = r.active; p.rev = (r.saved.rev || 0) + (r.dirty ? 1 : 0); p.loaded = true; };
  p.type = (text, i) => { p.notes[i === undefined ? p.notes.findIndex((n) => n.id === p.active) : i].text = text; p.rev++; };
  p.add = (text) => { const n = { id: `p${p.notes.length + 100}`, text }; p.notes.push(n); p.active = n.id; p.rev++; return n.id; };
  return p;
}
function emitter(o) {
  const L = {};
  o.on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return o; };
  o.once = (ev, fn) => { const w = (...a) => { o.off(ev, w); fn(...a); }; return o.on(ev, w); };
  o.off = (ev, fn) => { L[ev] = (L[ev] || []).filter((f) => f !== fn); return o; };
  o.emit = (ev, ...a) => { for (const f of (L[ev] || []).slice()) f(...a); };
  return o;
}
const made = [];
class FakeWin {
  constructor(opts) {
    emitter(this);
    this.opts = opts; this.shown = 0; this.focused = 0; this.destroyed = false; this.bounds = null; this.page = fakePage();
    const self = this;
    this.webContents = emitter({
      isDestroyed: () => self.destroyed,
      setWindowOpenHandler(fn) { self.openHandler = fn; },
      executeJavaScript: async (js) => self.page.take(/prune/.test(js) ? { prune: true } : undefined),
      send() {},
      isLoading: () => false,
    });
    made.push(this);
  }
  loadFile(p) { this.file = p; setImmediate(() => { if (!this.destroyed) this.webContents.emit('did-finish-load'); }); }
  setAlwaysOnTop(on, level) { this.top = [on, level]; }
  setBounds(b) { this.bounds = b; }
  show() { this.shown++; }
  showInactive() { this.shown++; }
  focus() { this.focused++; }
  hide() { this.hidden = (this.hidden || 0) + 1; }
  isFocused() { return false; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  getNativeWindowHandle() { return Buffer.alloc(8); }
}
const fakeScreen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 864 } }) };
const fakeApp = emitter({ removeListener(ev, fn) { this.off(ev, fn); } });

function fakeCtx(name, opts) {
  const o = opts || {};
  const c = { logs: [], health: [], broadcasts: [], pushes: [], commands: {}, calls: [], results: [], replays: {}, chords: {}, enabledFns: [], sends: [], settings: {}, on: true };
  const settingsFile = path.join(TMP, name, 'features', 'notes.json');
  c.ctx = {
    name: 'notes',
    flags: { test: o.live ? false : true, live: !!o.live },
    log: (t) => c.logs.push(String(t)),
    health: (ok, why) => c.health.push({ ok, why }),
    enabled: () => c.on,
    onEnabled: (fn) => c.enabledFns.push(fn),
    broadcast: (ev, p) => c.broadcasts.push({ ev, p: JSON.stringify(p) }),
    push: (w, ev, p) => { c.pushes.push({ ev, p }); return true; },
    replay: (ev, fn) => { c.replays[ev] = fn; },
    command: (verb, fn) => { c.commands[verb] = fn; return `notes.${verb}`; },
    onChord: (ch, fn) => { c.chords[ch] = fn; return () => {}; },
    page: (f) => path.join(__dirname, '..', '..', 'ui', 'notes', f || 'index.html'),
    preload: path.join(__dirname, '..', '..', 'preload.js'),
    settings: { file: settingsFile, get: (k, d) => (k in c.settings ? c.settings[k] : d), set: (k, v) => { c.settings[k] = v; } },
    sidecar: {
      ready: true,
      send: async (cmd, args) => {
        c.sends.push({ cmd, args });
        if (cmd === 'foreground') return { ok: true, result: { hwnd: '4242', title: 'made-up app' } };
        return { ok: false, error: 'passive sidecar: refused' };
      },
      on: () => () => {}, onReady: (fn) => { fn(); return () => {}; },
    },
  };
  c.call = async (verb, args) => {
    c.calls.push({ verb, args: JSON.stringify(args === undefined ? {} : args) });
    const r = await c.commands[verb](args);
    c.results.push({ verb, r: JSON.stringify(r) });
    return r;
  };
  c.win = () => made.filter((w) => !w.destroyed).pop();
  c.pageLoad = async () => { await tick(); const r = await c.call('load', {}); hub.test.notes && hub.test.notes.win() && hub.test.notes.win().page.fromLoad(r); return r; };
  return c;
}
const deps = { BrowserWindow: FakeWin, screen: fakeScreen, electron: { app: fakeApp } };

/* ------------------------------------------------------------------ feature */
const SECRETS = ['ALPHA-garden-secret-7731', 'BRAVO outside words 5512', 'CHARLIE-deleted-9001', 'DELTA unsaved 4410', 'ECHO rest words 3321', 'FOXTROT reload 8812'];

async function featureTests() {
  const all = [];

  // the --test folder
  const prevEnv = process.env.MANTLE_NOTES_DIR;
  process.env.MANTLE_NOTES_DIR = path.join(DOCS, 'Mantle Notes');
  const cR = fakeCtx('refuse');
  const wR = F._notesDir(cR.ctx);
  check('--test: a MANTLE_NOTES_DIR under Documents is refused', !under(wR.dir, DOCS) && /refused/.test(wR.note || ''), show(wR));
  delete process.env.MANTLE_NOTES_DIR;
  const wD = F._notesDir(cR.ctx);
  check('--test: without MANTLE_NOTES_DIR the folder is <settings folder>\\notes', wD.dir === path.join(path.dirname(cR.ctx.settings.file), 'notes'), show(wD));
  const wL = F._notesDir(fakeCtx('liveword', { live: true }).ctx);
  check('live: the folder is %USERPROFILE%\\Documents\\Mantle Notes (not OneDrive)', wL.dir === path.join(DOCS, 'Mantle Notes'), show(wL));

  process.env.MANTLE_NOTES_DIR = path.join(TMP, 'feat');
  const c = fakeCtx('feat');
  all.push(c);
  const h = F._install(c.ctx, deps);
  const T = hub.test.notes;
  check('test hooks: hub.test.notes is set in --test', !!T && T.dir === path.join(TMP, 'feat'), show(T && T.dir));
  check('--test: the notes folder is never under %USERPROFILE%\\Documents', !under(T.dir, DOCS) && !under(c.replays['notes.state']().folder, DOCS));
  check('state: no window before the first open', c.replays['notes.state']().windowUp === false && made.length === 0);
  check('health: healthy at install', c.health.length && c.health[c.health.length - 1].ok === true);

  // open from the top bar
  const o1 = await c.call('toggle', { x: 1500, app: '777', via: 'the top bar' });
  const w1 = c.win();
  check('toggle: opens (made on first use)', o1.ok && o1.open === true && !!w1, show(o1));
  check('window: frameless, transparent, skipTaskbar, no shadow, fixed, FOCUSABLE', w1 && w1.opts.frame === false && w1.opts.transparent === true && w1.opts.skipTaskbar === true &&
    w1.opts.hasShadow === false && w1.opts.resizable === false && w1.opts.movable === false && w1.opts.minimizable === false && w1.opts.focusable === true, show(w1 && w1.opts));
  check('window: sandboxed page with the preload bridge', w1 && w1.opts.webPreferences.sandbox === true && w1.opts.webPreferences.contextIsolation === true && w1.opts.webPreferences.nodeIntegration === false && /preload\.js$/.test(w1.opts.webPreferences.preload));
  check('window: loads ui/notes/index.html', w1 && /ui[\\/]notes[\\/]index\.html$/.test(w1.file));
  check('window: will-navigate prevented, window.open denied', w1 && typeof w1.openHandler === 'function' && w1.openHandler().action === 'deny');
  const st1 = T.state();
  check('place: under the top bar, the pad\'s right edge at the icon\'s x', st1.place && st1.place.y === 30 && st1.place.x + F.SIDE + F.PAD_W === 1500, show(st1.place));
  check('open: the app to give the keyboard back to is the one the top bar sent', st1.refocus === '777');
  const r0 = await c.pageLoad();
  check('load: a missing file is one empty note, with the file path', r0.ok && r0.notes.length === 1 && r0.notes[0].text === '' && r0.file === path.join(TMP, 'feat', 'notes.md'), show(r0));
  check('open: the page is told to put the caret in the text', c.pushes.some((p) => p.ev === 'notes.open' && p.p.focus === true));

  // dirty -> pull -> write
  w1.page.type(SECRETS[0] + '\nsecond line');
  const d1 = await c.call('dirty', { rev: w1.page.rev });
  const onDisk = fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8');
  check('dirty: main pulls the text and writes it', d1.ok && d1.saved.ok && d1.saved.rev === w1.page.rev && onDisk === St.serialize([SECRETS[0] + '\nsecond line']), show(d1));
  const d1b = await c.call('dirty', { rev: w1.page.rev });
  check('dirty: nothing new -> no second write', d1b.ok && d1b.saved.ok && w1.page.takes >= 2);
  const tabs = w1.page.add('');
  w1.page.type('note two');
  await c.call('dirty', { rev: w1.page.rev });
  check('dirty: two notes -> two markers in notes.md', St.parse(fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8')).texts.length === 2 && !!tabs);
  check('active: the active note is remembered (an index, no text)', c.settings.active === 1, show(c.settings));

  // outside change while the pad has unsaved text: kept aside, ours written, the pad told
  fs.writeFileSync(path.join(TMP, 'feat', 'notes.md'), St.serialize([SECRETS[1]]) + 'extra\n');
  w1.page.type('note two, edited');
  const d2 = await c.call('dirty', { rev: w1.page.rev });
  const aside = fs.readdirSync(path.join(TMP, 'feat')).filter((n) => /changed outside Mantle/.test(n));
  check('outside: the outside version is copied aside, then ours is written', d2.saved.ok && aside.length === 1 && fs.readFileSync(path.join(TMP, 'feat', aside[0]), 'utf8').includes(SECRETS[1]), show({ d2, aside }));
  check('outside: the pad is told (state.outside names the copy)', d2.outside && d2.outside.name === aside[0], show(d2.outside));

  // Esc: close with refocus -> in --test the sidecar is never asked to focus
  const cl = await c.call('close', { refocus: true });
  check('close: closes and saves', cl.ok && cl.open === false && T.state().open === false && cl.saved.ok, show(cl));
  check('--test: the sidecar is never asked to focus', !c.sends.some((s) => s.cmd === 'focus'), show(c.sends));

  // reload on open after an outside change, when nothing is unsaved
  fs.writeFileSync(path.join(TMP, 'feat', 'notes.md'), St.serialize([SECRETS[5], 'b']));
  c.pushes.length = 0;
  const o2 = await c.call('toggle', { via: 'chord' });
  const push = c.pushes.find((p) => p.ev === 'notes.open');
  check('reload: opening after an outside change (nothing unsaved) pushes the file\'s notes', o2.ok && push && push.p.reload && push.p.reload.notes.length === 2 && push.p.reload.notes[0].text === SECRETS[5], show(push && push.p));
  check('open: with no app given, the foreground window (read-only sidecar call) is the one to refocus', T.state().refocus === '4242' && c.sends.some((s) => s.cmd === 'foreground'));
  const pl = push && push.p.reload;
  if (pl) { w1.page.notes = pl.notes.map((n) => ({ id: n.id, text: n.text })); w1.page.active = pl.active; w1.page.rev = pl.rev; }

  // delete: deleted.md first
  w1.page.type('delete me ' + SECRETS[2], 1);
  const victim = w1.page.notes[1].id;
  const del = await c.call('delete', { id: victim });
  const dfile = path.join(TMP, 'feat', 'deleted.md');
  check('delete: the text goes to deleted.md', del.ok && fs.existsSync(dfile) && fs.readFileSync(dfile, 'utf8').includes(SECRETS[2]), show(del));
  check('delete: ... and leaves notes.md', !fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8').includes(SECRETS[2]));
  w1.page.notes.splice(1, 1); w1.page.active = w1.page.notes[0].id; w1.page.rev++;
  await c.call('dirty', { rev: w1.page.rev });
  // refused when deleted.md cannot be written
  fs.rmSync(dfile);
  fs.mkdirSync(dfile);
  const keepId = w1.page.add('keep me, deleted.md is broken');
  await c.call('dirty', { rev: w1.page.rev });
  const del2 = await c.call('delete', { id: keepId });
  check('delete: refused, with the reason, when deleted.md cannot be written', del2.ok === false && /not deleted/.test(del2.reason) && del2.reason.includes('deleted.md'), show(del2));
  check('delete: ... and the note stays in notes.md', fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8').includes('keep me, deleted.md is broken'));
  const del3 = await c.call('delete', {});
  check('delete: needs the note id', del3.ok === false);
  // a blank note has nothing to keep: deleted (even while deleted.md is broken), deleted.md not grown
  const blankId = w1.page.add('  \n ');
  await c.call('dirty', { rev: w1.page.rev });
  const del4 = await c.call('delete', { id: blankId });
  check('delete: a blank note is deleted without an entry in deleted.md', del4.ok === true && fs.statSync(dfile).isDirectory() && !fs.readdirSync(dfile).length, show(del4));
  w1.page.notes = w1.page.notes.filter((n) => n.id !== blankId); w1.page.active = w1.page.notes[0].id; w1.page.rev++;
  await c.call('dirty', { rev: w1.page.rev });

  // prune on close: an empty extra note is dropped (never the last one)
  w1.page.add('');
  await c.call('dirty', { rev: w1.page.rev });
  const before = St.parse(fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8')).texts.length;
  await c.call('close', { refocus: false });
  const after = St.parse(fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8')).texts;
  check('close: an empty extra note is dropped', after.length === before - 1 && after.every((t) => t.trim() !== ''), show({ before, after: after.length }));

  // the top bar's rules: a press that blurred the pad does not reopen it
  await c.call('toggle', { x: 1400, app: '777', via: 'the top bar' });
  check('toggle: open again (same window, not a new renderer)', T.state().open === true && c.win() === w1);
  w1.emit('blur');
  await tick(); await tick();
  check('blur: a click away closes', T.state().open === false);
  const tw = await c.call('toggle', { x: 1400, app: '777', via: 'the top bar', wasOpen: true });
  check('toggle {wasOpen:true} after a blur-close stays closed', tw.ok && tw.open === false && T.state().open === false, show(tw));
  const tg = await c.call('toggle', { x: 1400, app: '777', via: 'the top bar' });
  check('toggle within 400 ms of a blur-close stays closed', tg.open === false && T.state().open === false, show(tg));
  await c.chords['Win+Alt+N']();
  check('chord: Win+Alt+N toggles (opens)', T.state().open === true);
  await c.chords['Win+Alt+N']();
  check('chord: Win+Alt+N toggles (closes)', T.state().open === false);
  // Alt+F4
  await c.call('open', {});
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  w1.emit('close', ev);
  await tick(); await tick();
  check('Alt+F4: the window is not destroyed, the pad closes like Esc', ev.prevented && !w1.destroyed && T.state().open === false);
  // switched off
  await c.call('open', {});
  c.on = false;
  for (const fn of c.enabledFns) fn(false);
  await tick(); await tick();
  const off = await c.call('open', {});
  check('tray off: closes, and will not open', T.state().open === false && off.ok === false && /switched off/.test(off.reason), show(off));
  c.on = true;

  check('--test: the window was never shown or focused', made.every((w) => w.shown === 0 && w.focused === 0), show(made.map((w) => [w.shown, w.focused])));
  check('--test: never always-on-top (the user\'s desktop)', w1.opts.alwaysOnTop === false && !w1.top);

  // stop(): flush BEFORE the window goes
  await c.call('open', {});
  w1.page.type('typed just before quit');
  await h.stop('quit');
  check('stop: flushes the text before destroying the window', fs.readFileSync(path.join(TMP, 'feat', 'notes.md'), 'utf8').includes('typed just before quit') && w1.destroyed);
  check('stop: the test hooks are removed', hub.test.notes === undefined);

  /* a save that fails: the pad says why, the log says it ONCE, a rest keeps the text, a quit writes a rescue */
  const bad = path.join(TMP, 'bad', 'Mantle Notes');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'a file in the way');
  process.env.MANTLE_NOTES_DIR = bad;
  const cB = fakeCtx('bad');
  all.push(cB);
  const hB = F._install(cB.ctx, deps);
  await cB.call('open', {});
  const wB = cB.win();
  await cB.pageLoad();
  wB.page.type(SECRETS[3]);
  const b1 = await cB.call('dirty', { rev: wB.page.rev });
  check('failed save: dirty answers ok:true (no call-log line per keystroke) with saved.ok false', b1.ok === true && b1.saved.ok === false, show(b1));
  check('failed save: the reason names the path, in plain words', /a file is in the way/.test(b1.saved.reason) && b1.saved.reason.includes(bad), b1.saved.reason);
  wB.page.type(SECRETS[3] + ' more');
  await cB.call('dirty', { rev: wB.page.rev });
  check('failed save: logged ONCE per reason', cB.logs.filter((l) => /could not save/.test(l)).length === 1, show(cB.logs));
  check('failed save: state (for the top bar\'s warn dot) says not saved', cB.replays['notes.state']().saved.ok === false);
  await hB.stop('game', { rest: true });
  check('rest: unsaved notes are kept for after the rest', !!F._carry() && F._carry().texts[0].includes('more'));
  const cB2 = fakeCtx('bad2');
  all.push(cB2);
  const hB2 = F._install(cB2.ctx, deps);
  await tick(); await tick();
  await cB2.call('open', {});
  const lB2 = await cB2.pageLoad();
  check('wake: the pad gets the unsaved notes back, marked unsaved', lB2.dirty === true && lB2.notes[0].text.includes(SECRETS[3]) && lB2.saved.ok === false, show({ dirty: lB2.dirty, saved: lB2.saved }));
  await hB2.stop('quit');
  const rescues = fs.readdirSync(path.join(TMP, 'bad2', 'features')).filter((n) => /^notes-rescue .*\.md$/.test(n));
  check('quit that cannot save: a rescue copy is written beside the settings', rescues.length === 1 && fs.readFileSync(path.join(TMP, 'bad2', 'features', rescues[0]), 'utf8').includes(SECRETS[3]), show(rescues));
  check('quit: the log says a rescue copy was written (no text, no path, no file name)', cB2.logs.some((l) => /a rescue copy was written \(a note file; the pad lists it\)/.test(l)), show(cB2.logs));
  F._resetCarry();

  // a crashed page: health false with the reason, made again on the next open
  process.env.MANTLE_NOTES_DIR = path.join(TMP, 'crash');
  const cC = fakeCtx('crash');
  all.push(cC);
  const hC = F._install(cC.ctx, deps);
  await cC.call('open', {});
  const wC = cC.win();
  wC.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const hc = cC.health[cC.health.length - 1];
  check('crash: health false with the reason', hc.ok === false && /crashed/.test(hc.why), show(hc));
  await cC.call('open', {});
  check('crash: the next open makes a new window and is healthy again', cC.win() !== wC && cC.health[cC.health.length - 1].ok === true);
  const wC2 = cC.win();
  await cC.call('close', { refocus: false });
  const evH = { prevented: false, preventDefault() { this.prevented = true; } };
  wC2.emit('close', evH);
  check('a close of the HIDDEN pad (a Windows shutdown) is never held up', evH.prevented === false);
  wC2.destroyed = true; wC2.emit('closed');
  check('... and the pad forgets that window (made again on the next open)', cC.replays['notes.state']().windowUp === false);
  await hC.stop('quit');

  /* PRIVACY: no note text in any log line, health reason, command argument, broadcast, or result (except notes.load) */
  const leaks = [];
  const texts = SECRETS.concat(['second line', 'note two', 'typed just before quit', 'keep me, deleted.md is broken', 'delete me']);
  for (const k of all) {
    for (const t of texts) {
      for (const l of k.logs) if (l.includes(t)) leaks.push(['log', l]);
      for (const x of k.health) if (String(x.why).includes(t)) leaks.push(['health', x.why]);
      for (const x of k.calls) if (x.args.includes(t)) leaks.push(['args', x.verb, x.args]);
      for (const x of k.broadcasts) if (x.p.includes(t)) leaks.push(['broadcast', x.ev]);
      for (const x of k.results) if (x.verb !== 'load' && x.r.includes(t)) leaks.push(['result', x.verb]);
    }
  }
  check('privacy: no note text in any log line, health reason, argument, broadcast or non-load result', leaks.length === 0, show(leaks.slice(0, 3)));
  /* PRIVACY (lane r7-names, 2026-10-01; BRIEF: no file names, paths or user names in ANY log line): the
     pad may show where the notes live, the log may not. The failed saves, the rescue and the outside
     changes above all logged a path or a file name before. */
  const pathy = [];
  const home = os.homedir();
  for (const k of all) for (const l of k.logs) {
    if (l.includes(TMP) || l.toLowerCase().includes(home.toLowerCase()) || /\b[A-Za-z]:[\\/]/.test(l) || /notes-rescue|changed outside Mantle \d{4}/.test(l)) pathy.push(l);
  }
  const logged = all.reduce((n, k) => n + k.logs.length, 0);
  check('privacy: no log line holds a path, the user folder or a note file\'s name', logged > 10 && pathy.length === 0, show(pathy.slice(0, 3)));
  check('privacy: the log says counts ("... notes, ... characters")', c.logs.some((l) => /\d+ notes, \d+ characters/.test(l)), show(c.logs.slice(0, 5)));
  check('privacy: command arguments are only rev / id / x / app / via / wasOpen / refocus', all.every((k) => k.calls.every((x) => Object.keys(JSON.parse(x.args)).every((key) => ['rev', 'id', 'x', 'app', 'via', 'wasOpen', 'refocus'].includes(key)))));

  if (prevEnv === undefined) delete process.env.MANTLE_NOTES_DIR; else process.env.MANTLE_NOTES_DIR = prevEnv;
}

/* ------------------------------------------------------------------ security review 2: hostile notes.md */
async function hostileTests() {
  const MAXB = St.MAX_BYTES || 8 * 1024 * 1024, MAXC = St.MAX_COPIES || 10;   // literals too: the same test runs against the old store
  let k = 0;
  const fresh = () => { const d = path.join(TMP, 'hostile', String(++k), 'Mantle Notes'); fs.mkdirSync(d, { recursive: true }); return St.createStore({ dir: d, pid: 4242 }); };
  const others = (st) => fs.readdirSync(st.dir).filter((n) => n !== 'notes.md').map((n) => fs.readFileSync(path.join(st.dir, n)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // invalid UTF-8: an ANSI "café" (0xE9). It used to load as U+FFFD and the first save wrote that back.
  for (const [name, orig] of [
    ['an ANSI (Windows-1252) file', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x6f, 0x74, 0x65])],
    ['a UTF-16 (Notepad "Unicode") file', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo 日本\n', 'utf16le')])],
  ]) {
    const st = fresh();
    fs.writeFileSync(st.file, orig);
    const l = await st.load();
    check(`hostile: ${name} is not opened, and the pad says why`, !l.ok && /not UTF-8/.test(l.reason || '') && eq(l.texts, ['']), show(l));
    const r = await st.save(['typed after']);
    check(`hostile: ${name}'s exact bytes are kept as a copy before the first save goes over it`, r.ok && others(st).some((b) => b.equals(orig)), show(r));
  }
  // too big: over MAX_BYTES is refused unread; a save first keeps it as a copy
  {
    const st = fresh();
    fs.writeFileSync(st.file, Buffer.alloc(MAXB + 10, 0x61));
    const l = await st.load();
    check('hostile: a notes.md over 8 MB is not opened, with the size in the reason', !l.ok && /MB, over the 8\.0 MB/.test(l.reason || ''), show(l));
    check('hostile: ... and an open does not read it again (changedOnDisk answers without reading)', (await st.changedOnDisk()) === true);
    const r = await st.save(['small']);
    check('hostile: ... and a save keeps it as a copy first', r.ok && !!r.outside && fs.statSync(r.outside).size === MAXB + 10, show(r));
    const big = 'x'.repeat(MAXB + 1);
    const r2 = await st.save([big]);
    check('hostile: a save of more than 8 MB of text is refused in words (the text stays in the pad)', !r2.ok && /over the 8\.0 MB the pad saves/.test(r2.reason || '') && fs.readFileSync(st.file, 'utf8') === St.serialize(['small']), show(r2 && r2.reason));
  }
  // 100k notes: refused (each would be a tab)
  {
    const st = fresh();
    fs.writeFileSync(st.file, (St.MARKER + '\nn\n').repeat(100000));
    const t0 = Date.now();
    const l = await st.load();
    check('hostile: a notes.md with 100k notes is not opened (the pad opens 500 at most)', !l.ok && /100000 notes, over the 500/.test(l.reason || '') && Date.now() - t0 < 2000, show(l.reason));
  }
  // the rename race: notes.md held (read-only -> EPERM, retried) while a synced version lands in it
  {
    const st = fresh();
    await st.save(['mine v1']);
    fs.chmodSync(st.file, 0o444);
    const p = st.save(['mine v2']);
    await sleep(250);
    fs.chmodSync(st.file, 0o666);
    fs.writeFileSync(st.file, St.serialize(['REMOTE EDIT from the other PC']));
    const r = await p;
    const kept = others(st).some((b) => b.toString('utf8').includes('REMOTE EDIT'));
    check('hostile: a version that lands in notes.md while the save retries is kept as a copy, not renamed over', r.ok && kept && !!r.outside && fs.readFileSync(st.file, 'utf8') === St.serialize(['mine v2']), show({ r, kept }));
  }
  // a planted tmp link: the save must not write THROUGH it (symlinks need a privilege here: hard link)
  {
    const st = fresh();
    const victim = path.join(TMP, 'hostile', 'victim-tmp.txt');
    fs.writeFileSync(victim, 'VICTIM');
    try { fs.symlinkSync(victim, st.file + '.tmp-4242', 'file'); } catch (_) { fs.linkSync(victim, st.file + '.tmp-4242'); }
    const r = await st.save(['NOTE TEXT']);
    check('hostile: a planted notes.md.tmp-<pid> link is not written through (the linked file is untouched)', r.ok && fs.readFileSync(victim, 'utf8') === 'VICTIM' && fs.readFileSync(st.file, 'utf8') === St.serialize(['NOTE TEXT']), show({ r, victim: fs.readFileSync(victim, 'utf8').slice(0, 30) }));
  }
  // notes.md itself a link: the save replaces the link, never the file it points at
  {
    const st = fresh();
    const victim = path.join(TMP, 'hostile', 'victim-notes.txt');
    fs.writeFileSync(victim, St.serialize(['victim text']));
    try { fs.symlinkSync(victim, st.file, 'file'); } catch (_) { fs.linkSync(victim, st.file); }
    const l = await st.load();
    const r = await st.save([l.texts[0] + ' edited']);
    check('hostile: notes.md as a link to another file: that file is never overwritten', r.ok && fs.readFileSync(victim, 'utf8') === St.serialize(['victim text']), show(r));
  }
  // deleted.md a link: refused, nothing written into the other file
  {
    const st = fresh();
    const victim = path.join(TMP, 'hostile', 'victim-deleted.txt');
    fs.writeFileSync(victim, 'VICTIM');
    try { fs.symlinkSync(victim, st.deletedFile, 'file'); } catch (_) { fs.linkSync(victim, st.deletedFile); }
    const r = await st.appendDeleted('SECRET NOTE');
    check('hostile: deleted.md as a link to another file: the delete is refused in words, nothing written into it', !r.ok && /link to another file/.test(r.reason || '') && fs.readFileSync(victim, 'utf8') === 'VICTIM', show(r));
  }
  // an outside writer that changes notes.md before every save: copies are capped
  {
    const st = fresh();
    await st.save(['start']);
    let refused = null;
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(st.file, St.serialize([`outside ${i}`]));
      const r = await st.save([`mine ${i}`]);
      if (!r.ok && !refused) refused = { i, reason: r.reason, file: fs.readFileSync(st.file, 'utf8') };
    }
    const copies = fs.readdirSync(st.dir).filter((n) => /changed outside Mantle/.test(n)).length;
    check('hostile: an outside writer changing notes.md before every save makes at most 10 copies in 10 min', copies === MAXC, `copies=${copies}`);
    check('hostile: ... then the save is refused in words and that version is NOT overwritten', !!refused && refused.i === MAXC && /changed outside Mantle 10 times in 10 min/.test(refused.reason) && refused.file === St.serialize([`outside ${MAXC}`]), show(refused));
  }
  // the pad's tab label: the same words as before, without splitting the whole note
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'notes', 'notes.js'), 'utf8');
    const body = src.slice(src.indexOf('function label('), src.indexOf('/* ---- render ---- */'));
    // eslint-disable-next-line no-new-func
    const label = new Function('TAB_CHARS', body + '; return label;')(18);
    const old = (text) => { const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || ''; if (!line) return ''; return line.length > 18 ? line.slice(0, 17).trimEnd() + '…' : line; };
    const cases = ['', '\n\n', '  \n \t\n  hello world  \nx', 'short', 'a very long first line that goes on', '\u00a0\u2028x', '\r\nabc\r\n', '<img src=x onerror=alert(1)>', ' '.repeat(5000) + 'late words', '\n'.repeat(3) + 'y'.repeat(9000)];
    check('hostile: the pad\'s tab label reads the same as before for every case', cases.every((c) => label(c) === old(c)), show(cases.map((c) => [label(c), old(c)]).filter(([a, b]) => a !== b)));
    const huge = 'line\n'.repeat(1600000);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) label(huge);
    const per = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    check('hostile: the tab label of an 8 MB note costs under 1 ms a keystroke', per < 1, `${per.toFixed(2)} ms`);
  }
}

(async () => {
  try {
    formatTests();
    await storeTests();
    await hostileTests();
    await featureTests();
  } catch (e) {
    failures.push('threw: ' + (e && e.stack ? e.stack : e));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* a temp folder */ }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`NOTES: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
