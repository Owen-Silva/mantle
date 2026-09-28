'use strict';
/*
 * downloads.test.js - the Downloads shelf, in node, no Electron, no sidecar (lane downloads, 2026-09-27).
 *
 *   node lib/features/downloads.test.js
 *
 * Every file is created in a TEMP folder made here and removed at the end; Owen's real Downloads is
 * never read. Proves: what is skipped (partials, junk) and counted, the order (newest arrival, the
 * later of creation and last write), the plain read on a real folder, "time ago" and sizes (the bar's
 * own ui/bar/downloads.js), and the feature against a fake ctx: the watch (debounced; a partial
 * being written is ignored), the dot (new since last opened, remembered), the commands by opaque
 * token, rest / off, a missing folder, a sidecar that cannot answer, and that NO log line, health
 * reason or command reason carries a file name or the folder's path.
 *
 * Prints one summary line, "DOWNLOADS TEST: n passed, m failed"; exits 1 if anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./_downloads-list.js');
const F = require('./downloads.js');
const U = require('../../ui/bar/downloads.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + detail : ''));
}
const show = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-test-'));
const H = 3600000;
function put(name, bytes, mtimeOffsetMs) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(bytes || 0));
  if (mtimeOffsetMs !== undefined) { const t = new Date(Date.now() + mtimeOffsetMs); fs.utimesSync(p, t, t); }
  return p;
}

(async () => {
  try {
    /* ------------------------------------------------ skipReason */
    for (const n of ['Unconfirmed 12345.crdownload', 'setup.exe.part', 'a.pdf.opdownload', 'x.tmp', 'old.partial', 'ALLCAPS.CRDOWNLOAD'])
      check(`a partial download is skipped: ${n}`, L.skipReason(n) === 'partial', L.skipReason(n));
    for (const n of ['desktop.ini', 'Thumbs.db', '.hidden', '~$report.docx', ''])
      check(`a hidden-by-convention name is skipped: "${n}"`, L.skipReason(n) === 'hidden', L.skipReason(n));
    for (const n of ['worksheet.pdf', 'node-v22.msi', 'notes', 'part.pdf', 'tmp.txt', 'a.crdownload.pdf'])
      check(`a finished file is shown: ${n}`, L.skipReason(n) === null, L.skipReason(n));

    /* ------------------------------------------------ shelf (pure) */
    const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
    const ents = [
      { name: 'old-copied-in.pdf', size: 5, birthMs: T0 - 1 * H, mtimeMs: T0 - 900 * H },   // copied in 1 h ago: arrival = creation
      { name: 'browser-download.zip', size: 9, birthMs: T0 - 3 * H, mtimeMs: T0 - 2 * H },  // finished 2 h ago
      { name: 'newest.docx', size: 7, birthMs: T0 - 0.5 * H, mtimeMs: T0 - 0.5 * H },
      { name: 'Unconfirmed 1.crdownload', size: 1, birthMs: T0, mtimeMs: T0 },
      { name: 'desktop.ini', size: 1, birthMs: T0, mtimeMs: T0 },
      { name: 'a-tie.txt', size: 1, birthMs: T0 - 5 * H, mtimeMs: 0 },
      { name: 'B-tie.txt', size: 1, birthMs: T0 - 5 * H, mtimeMs: 0 },
      { name: 'unit4', dir: true, size: 4096, birthMs: T0 - 4 * H, mtimeMs: T0 - 4 * H },
      null, { name: 42 },
    ];
    const sh = L.shelf(ents, { max: 12, seenAt: T0 - 1.5 * H, now: T0 + 60000 });
    check('shelf: newest arrival first, where arrival is the LATER of creation and last write',
      show(sh.items.map((i) => i.name)) === show(['newest.docx', 'old-copied-in.pdf', 'browser-download.zip', 'unit4', 'a-tie.txt', 'B-tie.txt']), show(sh.items.map((i) => i.name)));
    check('shelf: a partial is counted, never a row', sh.partial === 1 && !sh.items.some((i) => /crdownload/.test(i.name)), show(sh));
    check('shelf: junk and malformed entries are skipped', sh.skipped === 3 && sh.shown === 6, show({ skipped: sh.skipped, shown: sh.shown }));
    check('shelf: fresh = arrived after the shelf was last opened; newCount counts them',
      sh.newCount === 2 && sh.items[0].fresh && sh.items[1].fresh && !sh.items[2].fresh, show(sh.items.map((i) => i.fresh)));
    check('shelf: a folder is a row with dir:true and no size', sh.items[3].dir === true && sh.items[3].size === 0, show(sh.items[3]));
    check('shelf: at = the arrival time', sh.items[1].at === T0 - 1 * H && sh.items[2].at === T0 - 2 * H, show(sh.items.slice(1, 3)));
    const cut = L.shelf(ents, { max: 2, seenAt: 0 });
    check('shelf: max cuts the rows, newCount still counts every fresh one', cut.items.length === 2 && cut.newCount === 6, show({ n: cut.items.length, newCount: cut.newCount }));
    const stale = L.shelf([
      { name: 'setup.exe.part', size: 7, birthMs: T0 - 40 * 24 * H, mtimeMs: T0 - 40 * 24 * H },   // left behind in August
      { name: 'movie.mkv.crdownload', size: 9, birthMs: T0 - 2 * H, mtimeMs: T0 - 5 * 60000 },     // written 5 min ago
      { name: 'no-time.part', size: 1 },                                                            // the plain read: no stat
    ], { now: T0 });
    check('shelf: an abandoned partial (unwritten 10+ min) is not "still downloading"; a recent or unstatted one is',
      stale.partial === 2 && stale.skipped === 1 && stale.items.length === 0, show(stale));
    check('shelf: nothing in, nothing out', show(L.shelf(null)) === show({ items: [], newCount: 0, partial: 0, skipped: 0, shown: 0 }), show(L.shelf(null)));

    /* ------------------------------------------------ listFolder (a real temp folder) */
    put('worksheet.pdf', 1500, 2 * H);          // future mtimes so the write time decides the order
    put('lab-template.docx', 300, 3 * H);
    put('installer.msi', 10, 1 * H);
    put('Unconfirmed 777.crdownload', 50, 4 * H);
    put('big.iso.part', 50, 4 * H);
    put('desktop.ini', 5, 5 * H);
    put('~$lab-template.docx', 5, 5 * H);
    fs.mkdirSync(path.join(TMP, 'unzipped-project'));
    const t9 = new Date(Date.now() + 0.5 * H); fs.utimesSync(path.join(TMP, 'unzipped-project'), t9, t9);
    const lf = await L.listFolder(TMP, { max: 60 });
    check('listFolder: ok, with the folder and every entry', lf.ok === true && lf.folder === TMP && lf.total === 8 && lf.items.length === 8, show({ ok: lf.ok, total: lf.total, n: lf.items && lf.items.length }));
    const lsh = L.shelf(lf.items, { max: 12, seenAt: 0 });
    check('listFolder + shelf: finished files newest first, the folder in its place',
      show(lsh.items.map((i) => i.name)) === show(['lab-template.docx', 'worksheet.pdf', 'installer.msi', 'unzipped-project']), show(lsh.items.map((i) => i.name)));
    check('listFolder + shelf: 2 partials counted, desktop.ini and the ~$ lock skipped', lsh.partial === 2 && lsh.skipped === 2, show({ partial: lsh.partial, skipped: lsh.skipped }));
    check('listFolder: sizes are real', lsh.items[1].size === 1500 && lsh.items[3].dir === true, show(lsh.items.map((i) => i.size)));
    const cutf = await L.listFolder(TMP, { max: 1 });
    check('listFolder: max cuts shown entries but keeps partial names so they are still counted', L.shelf(cutf.items).partial === 2 && L.shelf(cutf.items).items.length === 1, show(L.shelf(cutf.items)));
    const miss = await L.listFolder(path.join(TMP, 'nope-folder'));
    check('listFolder: a missing folder is state "missing" with a reason', miss.ok === false && miss.state === 'missing' && /does not exist/.test(miss.reason), show(miss));
    check('listFolder: the reason never carries the path', !miss.reason.includes('nope-folder') && !miss.reason.includes(TMP), miss.reason);
    const notDir = await L.listFolder(path.join(TMP, 'worksheet.pdf'));
    check('listFolder: a file where the folder should be says so', notDir.ok === false && notDir.state === 'missing' && !notDir.reason.includes('worksheet'), show(notDir));

    /* ------------------------------------------------ the bar's words (ui/bar/downloads.js in node) */
    const N = new Date(2026, 8, 27, 15, 0, 0).getTime();
    const agoCases = [
      [N - 10 * 1000, 'just now'], [N + 30 * 1000, 'just now'], [N - 2 * 60000, '2 min ago'], [N - 59 * 60000, '59 min ago'],
      [N - 3 * H, '3 h ago'], [N - 23 * H, '23 h ago'], [new Date(2026, 8, 26, 9, 0).getTime(), 'yesterday'],
      [new Date(2026, 8, 24, 20, 0).getTime(), '3 days ago'], [new Date(2026, 8, 18, 10, 0).getTime(), 'Sep 18'],
      [new Date(2025, 11, 30, 10, 0).getTime(), 'Dec 30, 2025'], [0, ''],
    ];
    for (const [ms, want] of agoCases) check(`ago: ${want || '(none)'}`, U.ago(ms, N) === want, U.ago(ms, N));
    const sizeCases = [[0, '0 B'], [812, '812 B'], [1024, '1 KB'], [14 * 1024 + 300, '14 KB'], [2.44 * 1024 * 1024, '2.4 MB'], [148 * 1024 * 1024, '148 MB'], [1.25 * 1024 ** 3, '1.3 GB'], [-5, '0 B']];
    for (const [b, want] of sizeCases) check(`size: ${want}`, U.size(b) === want, U.size(b));
    check('meta: size and age, a folder says Folder', U.meta({ size: 2048, at: N - 2 * 60000 }, N) === '2 KB \u00b7 2 min ago' && U.meta({ dir: true, at: N - 3 * H }, N) === 'Folder \u00b7 3 h ago', U.meta({ dir: true, at: N - 3 * H }, N));
    check('extOf: the letters for a generic tile', U.extOf('a.pdf') === 'PDF' && U.extOf('README') === '' && U.extOf('x.tar.gz') === 'GZ', U.extOf('x.tar.gz'));

    /* ------------------------------------------------ the feature, against a fake ctx */
    await featureTests();
    await hostileTests();
  } catch (e) {
    failures.push('the test itself threw: ' + ((e && e.stack) || e));
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  console.log(`DOWNLOADS TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})();

function fakeCtx(opts) {
  const o = opts || {};
  const c = {
    logs: [], health: [], pushes: [], commands: {}, replays: {}, enabledFns: [], readyFns: [], sends: 0, settings: Object.assign({}, o.settings || {}),
    on: o.on !== false, ready: o.ready !== false,
  };
  c.ctx = {
    name: 'downloads',
    flags: { test: true, live: false },
    log: (t) => c.logs.push(String(t)),
    health: (ok, why) => c.health.push({ ok, why }),
    enabled: () => c.on,
    onEnabled: (fn) => c.enabledFns.push(fn),
    broadcast: (ev, p) => c.pushes.push({ ev, p }),
    replay: (ev, fn) => { c.replays[ev] = fn; },
    command: (verb, fn) => { c.commands[verb] = fn; },
    settings: {
      get: (k, d) => (k in c.settings ? c.settings[k] : d),
      set: (k, v) => { if (o.settingsThrow) { const e = new Error('EPERM: cannot write C:\\secret\\downloads.json'); e.code = 'EPERM'; throw e; } c.settings[k] = v; },
    },
    sidecar: {
      get ready() { return c.ready; },
      send: async (cmd, args) => {
        c.sends++;
        if (o.sidecarSend) return o.sidecarSend(cmd, args);
        if (cmd !== 'downloads.list') return { ok: false, error: 'unknown command' };
        const r = await L.listFolder(args.folder, { max: args.max });   // the sidecar's shape, from the real folder
        return { ok: true, result: Object.assign({}, r, { via: 'argument' }) };
      },
      onReady: (fn) => { c.readyFns.push(fn); if (c.ready) fn(); return () => {}; },
    },
  };
  c.state = () => c.replays['downloads.state']();
  c.last = () => { const p = c.pushes.filter((x) => x.ev === 'downloads.state'); return p.length ? p[p.length - 1].p : null; };
  return c;
}

function fakeWatch() {
  const w = { calls: [], cb: null, closed: 0, errFn: null };
  w.fn = (dir, o, cb) => {
    w.calls.push({ dir, o });
    w.cb = cb;
    return { close() { w.closed++; }, on(ev, fn) { if (ev === 'error') w.errFn = fn; } };
  };
  return w;
}

async function featureTests() {
  const names = () => fs.readdirSync(TMP);
  const leaks = (c, extra) => {
    const texts = c.logs.concat(c.health.map((h) => String(h.why || '')), extra || []);
    const bad = [];
    for (const t of texts) {
      if (t.includes(TMP) || t.toLowerCase().includes(TMP.toLowerCase())) bad.push(t);
      for (const n of names()) if (n.length > 4 && t.includes(n)) bad.push(t);
    }
    return bad;
  };

  /* first run: what is already there is not new */
  const w = fakeWatch();
  const opened = [];
  const c = fakeCtx();
  const h = F._install(c.ctx, { folder: TMP, watch: w.fn, electron: null, dryRun: false, open: async (p) => { opened.push(p); return p.endsWith('installer.msi') ? { ok: false, reason: `could not open ${p}: No application is associated` } : { ok: true }; } });
  await h._read('test');
  check('feature: the first run remembers "now" as last seen (settings seenAt)', typeof c.settings.seenAt === 'number' && Math.abs(c.settings.seenAt - Date.now()) < 5000, show(c.settings));
  check('feature: the watch is on the folder, not persistent', w.calls.length === 1 && w.calls[0].dir === TMP && w.calls[0].o.persistent === false, show(w.calls));
  let st = c.state();
  check('feature: state replays on, ok, 4 items, 2 downloading',
    st.on === true && st.ok === true && st.count === 4 && st.partial === 2 && st.watching === true, show(st));
  /* the temp files carry FUTURE write times (they must, to test the order), so they count as new
     against a "now" seenAt; an item written in the past does not: */
  check('feature: newCount follows arrival > seenAt', st.newCount === 4, show(st));

  /* the list: tokens, not paths */
  const v = await c.commands.list({});
  check('feature: list answers the rows newest first with an opaque item token each',
    v.ok && show(v.items.map((i) => i.name)) === show(['lab-template.docx', 'worksheet.pdf', 'installer.msi', 'unzipped-project']) && v.items.every((i) => /^d\d+$/.test(i.item)), show(v.items.map((i) => [i.item, i.name])));
  check('feature: list carries the folder (for the panel) and no icon without Electron', v.folder === TMP && v.items.every((i) => i.icon === null), show({ folder: v.folder === TMP }));
  const v2 = await c.commands.list({ cached: true });
  check('feature: the same file keeps its token across reads', v2.items[0].item === v.items[0].item, show([v.items[0].item, v2.items[0].item]));

  /* seen: the dot goes, and it is remembered */
  const s1 = await c.commands.seen({});
  check('feature: seen sets seenAt to at least the newest arrival and saves it', s1.ok && c.settings.seenAt >= v.items[0].at, show({ s1, saved: c.settings.seenAt }));
  check('feature: after seen the pushed state has newCount 0', c.last() && c.last().newCount === 0, show(c.last()));

  /* the watch: a partial being written is ignored; a finished file re-reads once after the quiet time */
  const before = c.sends;
  w.cb('change', 'Unconfirmed 777.crdownload');
  w.cb('change', 'big.iso.part');
  await sleep(F.DEBOUNCE_MS + 250);
  check('feature: a browser writing its .crdownload / .part does not re-read', c.sends === before, `${c.sends - before} reads`);
  put('fresh-notes.pdf', 99, 6 * H);
  w.cb('rename', 'fresh-notes.pdf');
  w.cb('change', 'fresh-notes.pdf');
  w.cb('rename', null);
  await sleep(200);
  check('feature: a burst of events is debounced (no read yet at 200 ms)', c.sends === before, `${c.sends - before} reads`);
  await sleep(F.DEBOUNCE_MS + 300);
  check('feature: ... then ONE re-read', c.sends === before + 1, `${c.sends - before} reads`);
  st = c.last();
  check('feature: the new finished file lights the dot (newCount 1) and is the newest row', st.newCount === 1 && st.count === 5, show(st));
  const v3 = await c.commands.list({ cached: true });
  check('feature: the new row is first and fresh', v3.items[0].name === 'fresh-notes.pdf' && v3.items[0].fresh === true && v3.items[1].fresh === false, show(v3.items.slice(0, 2).map((i) => [i.name, i.fresh])));

  /* max wait: events that never stop still read within MAX_WAIT_MS */
  const b2 = c.sends;
  const t0 = Date.now();
  while (Date.now() - t0 < F.MAX_WAIT_MS + 600) { w.cb('change', 'fresh-notes.pdf'); await sleep(150); }
  check('feature: a file written for longer than the max wait still gets read (not starved)', c.sends > b2, `${c.sends - b2} reads in ${Date.now() - t0} ms`);
  await sleep(F.DEBOUNCE_MS + 200);

  /* the commands */
  const pdf = v3.items.find((i) => i.name === 'worksheet.pdf');
  const o1 = await c.commands.open({ item: pdf.item });
  check('feature: open goes to the shell with the real path', o1.ok === true && opened[opened.length - 1] === path.join(TMP, 'worksheet.pdf'), show(o1));
  const msi = v3.items.find((i) => i.name === 'installer.msi');
  const o2 = await c.commands.open({ item: msi.item });
  check('feature: a failed open says why, WITHOUT the name or the path', o2.ok === false && /No application/.test(o2.reason) && !o2.reason.includes('installer') && !o2.reason.includes(TMP), show(o2));
  check('feature: ... and as the cause alone (the bar already says "Could not open <name>: ")', /^No application/.test(o2.reason), show(o2.reason));
  const o3 = await c.commands.open({ item: 'd99999' });
  check('feature: an unknown token is "out of date", and the list is refreshed', o3.ok === false && /out of date/.test(o3.reason), show(o3));
  const gonePath = put('soon-gone.txt', 1, 7 * H);
  await h._read('test');
  const v4 = await c.commands.list({ cached: true });
  const gone = v4.items.find((i) => i.name === 'soon-gone.txt');
  fs.unlinkSync(gonePath);
  const o4 = await c.commands.open({ item: gone.item });
  check('feature: a file deleted since the list was drawn says so, without its name', o4.ok === false && /no longer in Downloads/.test(o4.reason) && !o4.reason.includes('soon-gone'), show(o4));
  const r1 = await c.commands.reveal({ item: pdf.item });
  check('feature: reveal without Electron says so in words', r1.ok === false && /Electron/.test(r1.reason), show(r1));
  const d1 = await c.commands.drag({ item: pdf.item });
  check('feature: drag without Electron says so in words', d1.ok === false && /Electron/.test(d1.reason), show(d1));

  /* a test run: open / reveal / folder are dry runs */
  const wT = fakeWatch();
  const cT = fakeCtx();
  const hT = F._install(cT.ctx, { folder: TMP, watch: wT.fn, electron: { shell: { showItemInFolder() { throw new Error('must not be called in a test run'); } } }, open: async () => { throw new Error('must not be called in a test run'); } });
  await hT._read('test');
  const vT = await cT.commands.list({ cached: true });
  const oT = await cT.commands.open({ item: vT.items[0].item });
  const rT = await cT.commands.reveal({ item: vT.items[0].item });
  const fT = await cT.commands.folder({});
  check('feature: --test open / reveal / folder are dry runs (nothing appears in front of Owen)', oT.dryRun && rT.dryRun && fT.dryRun, show([oT, rT, fT]));

  /* rest: stop({rest}) closes the watch and says so */
  h.stop('resting while VALORANT.exe runs', { rest: true });
  check('feature: rest closes the watch', w.closed >= 1, `${w.closed}`);
  check('feature: rest pushes a "resting" state with the reason', c.last().state === 'resting' && /VALORANT/.test(c.last().reason), show(c.last()));
  const afterStop = c.sends;
  if (w.cb) w.cb('rename', 'x.pdf');
  await sleep(F.DEBOUNCE_MS + 200);
  check('feature: after stop, folder events do nothing', c.sends === afterStop, `${c.sends - afterStop}`);
  hT.stop('test over');

  /* off in the tray */
  const wO = fakeWatch();
  const cO = fakeCtx({ on: false });
  F._install(cO.ctx, { folder: TMP, watch: wO.fn, electron: null });
  check('feature: off: the state says on:false (the bar hides the button)', cO.state().on === false && /off/.test(cO.state().reason), show(cO.state()));
  const offList = await cO.commands.list({});
  check('feature: off: commands answer "off", nothing is read or watched', offList.ok === false && offList.state === 'off' && cO.sends === 0 && wO.calls.length === 0, show(offList));
  cO.on = true; for (const fn of cO.enabledFns) fn(true);
  await sleep(50);
  check('feature: turned on: it reads and watches', cO.sends >= 1 && wO.calls.length === 1, show({ sends: cO.sends, watches: wO.calls.length }));
  cO.on = false; for (const fn of cO.enabledFns) fn(false);
  check('feature: turned off again: the watch is closed and the state pushed', wO.closed >= 1 && cO.last().on === false, show(cO.last()));

  /* a missing folder: state, health, retry, no path anywhere */
  const MISSING = path.join(TMP, 'moved-away-downloads');
  const wM = fakeWatch();
  const cM = fakeCtx();
  const hM = F._install(cM.ctx, { folder: MISSING, watch: wM.fn, electron: null });
  await hM._read('test');
  const sM = cM.state();
  check('feature: a missing folder is ok:false, state missing, with a reason', sM.ok === false && sM.state === 'missing' && /does not exist/.test(sM.reason), show(sM));
  check('feature: ... health goes false with the same words (the strip shows it)', cM.health.length && cM.health[cM.health.length - 1].ok === false && /does not exist/.test(cM.health[cM.health.length - 1].why), show(cM.health));
  check('feature: ... nothing is watched', wM.calls.length === 0, show(wM.calls));
  const lM = await cM.commands.list({ cached: true });
  check('feature: ... the list answer carries the folder for the panel (only there)', lM.ok === false && lM.folder === MISSING, show({ ok: lM.ok, hasFolder: lM.folder === MISSING }));
  hM.stop('test over');

  /* the sidecar cannot answer: the plain read, said */
  const wS = fakeWatch();
  const cS = fakeCtx({ sidecarSend: async () => ({ ok: false, error: 'unknown command "downloads.list"' }) });
  const hS = F._install(cS.ctx, { folder: TMP, watch: wS.fn, electron: null });
  await hS._read('test');
  const vS = await cS.commands.list({ cached: true });
  check('feature: a sidecar that cannot answer falls back to the plain read, and says so', vS.ok && vS.items.length >= 4 && /plainer read/.test(vS.detail || '') && /unknown command/.test(vS.detail), show({ ok: vS.ok, n: vS.items.length, detail: vS.detail }));
  hS.stop('test over');
  const cN = fakeCtx({ ready: false });
  const hN = F._install(cN.ctx, { watch: fakeWatch().fn, electron: null });
  await hN._read('test');
  check('feature: no sidecar and no Electron: "unresolved", in words', cN.state().ok === false && cN.state().state === 'unresolved' && /could not be found/.test(cN.state().reason), show(cN.state()));
  hN.stop('test over');

  /* the watch fails: said, and retried later (never a tight poll) */
  const cW = fakeCtx();
  const hW = F._install(cW.ctx, { folder: TMP, watch: () => { const e = new Error(`EPERM: operation not permitted, watch '${TMP}'`); e.code = 'EPERM'; throw e; }, electron: null });
  await hW._read('test');
  const vW = await cW.commands.list({ cached: true });
  check('feature: a watch that cannot start is named (watching:false + reason), the list still works', vW.ok && vW.watching === false && /cannot be watched \(EPERM\)/.test(vW.watchReason), show({ watching: vW.watching, why: vW.watchReason }));
  hW.stop('test over');

  /* settings that cannot be written: said in the panel */
  const cX = fakeCtx({ settingsThrow: true });
  const hX = F._install(cX.ctx, { folder: TMP, watch: fakeWatch().fn, electron: null });
  await hX._read('test');
  const sX = await cX.commands.seen({});
  check('feature: seenAt that cannot be saved is a note, not silence', sX.ok && /could not remember/.test(sX.note || ''), show(sX));
  hX.stop('test over');

  /* privacy: every log line and health reason, from every run above */
  const all = [c, cT, cO, cM, cS, cN, cW, cX];
  const bad = [];
  for (const k of all) bad.push(...leaks(k, [o2.reason, o3.reason, o4.reason, show(sM), show(vS.detail), show(vW.watchReason)]));
  check('privacy: no log line, health reason or failure reason carries a file name or the folder path', bad.length === 0, show(bad.slice(0, 3)));
  const counted = c.logs.filter((l) => /^\d+ items, \d+ new/.test(l));
  check('privacy: the log says counts ("5 items, 1 new")', counted.length >= 2, show(c.logs.slice(0, 6)));
}

/* Hostile input (lane secreview-dl, 2026-09-27): each check here failed against the code before its fix. */
async function hostileTests() {
  const { execFileSync } = require('child_process');
  const HT = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-hostile-'));
  try {
    /* a saved seenAt far in the future (a corrupt or hand-edited settings file) must not hide every
       new download forever: it is reset to now, said in the log without a name */
    fs.writeFileSync(path.join(HT, 'older.txt'), 'x');
    const cF = fakeCtx({ settings: { seenAt: 1e308 } });
    const hF = F._install(cF.ctx, { folder: HT, watch: fakeWatch().fn, electron: null });
    const at = Date.now() + 2000;
    const fresh = path.join(HT, 'arrived-later.txt');
    fs.writeFileSync(fresh, 'x'); fs.utimesSync(fresh, new Date(at), new Date(at));
    const vF = await cF.commands.list({});
    check('hostile: a saved seenAt in the far future is reset, so a new download still gets the dot', vF.newCount >= 1 && hF._seenAt() <= Date.now() + 86400000, show({ newCount: vF.newCount, seenAt: hF._seenAt() }));
    check('hostile: ... and the reset is logged, with no name', cF.logs.some((l) => /seenAt/.test(l) && /reset/.test(l)) && !cF.logs.some((l) => l.includes('arrived-later')), show(cF.logs.slice(0, 4)));
    hF.stop('test over');

    /* open / reveal / drag / folder never stat on the main thread: a Downloads folder on a share that
       went away blocked main 21 s in one fs.statSync (measured on \\10.255.255.1, 2026-09-27) */
    const cS = fakeCtx({});
    const img = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' };
    const fakeEl = { shell: { showItemInFolder() {} }, webContents: {}, app: { getFileIcon: async () => img }, nativeImage: {} };
    const hS = F._install(cS.ctx, { folder: HT, watch: fakeWatch().fn, electron: fakeEl, dryRun: false, open: async () => ({ ok: true }), barContents: () => ({ startDrag() {} }) });
    const vS = await cS.commands.list({});
    const one = vS.items[0];
    const orig = fs.statSync;
    let syncStats = 0;
    fs.statSync = function () { syncStats++; return orig.apply(this, arguments); };
    let rs;
    try {
      rs = [await cS.commands.open({ item: one.item }), await cS.commands.reveal({ item: one.item }), await cS.commands.drag({ item: one.item }), await cS.commands.folder({})];
    } finally { fs.statSync = orig; }
    check('hostile: open, reveal, drag and folder make no synchronous stat on the main thread', syncStats === 0 && rs.every((r) => r.ok), show({ syncStats, rs }));
    check('hostile: every icon handed to the bar is a data:image URL (never a path or a file:// URL)', vS.items.every((i) => i.icon === null || /^data:image\//.test(i.icon)), show(vS.items.map((i) => String(i.icon).slice(0, 20))));
    /* forged tokens: a path, a traversal, a prototype key, an object, a guess past the last token */
    const forged = ['C:\\Windows\\System32\\calc.exe', '..\\..\\x', '__proto__', 'constructor', { toString: () => one.item + 'x' }, 'd999999', ''];
    const fr = [];
    for (const f of forged) for (const verb of ['open', 'reveal', 'drag']) fr.push(await cS.commands[verb]({ item: f }));
    check('hostile: a forged or stale token never opens, reveals or drags anything', fr.every((r) => r.ok === false && /out of date/.test(r.reason)), show(fr.filter((r) => r.ok !== false).slice(0, 2)));
    hS.stop('test over');

    /* a name Windows keeps with a lone UTF-16 surrogate: node reads it back as U+FFFD, a path that does
       not exist (or names a DIFFERENT file). It is counted and said, never a row that cannot open. */
    const SUR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-sur-'));
    execFileSync('powershell', ['-NoProfile', '-Command', "[IO.File]::WriteAllText(('" + SUR + "' + '\\lone' + [char]0xD800 + 'x.txt'), 'LONE')"], { windowsHide: true });
    fs.writeFileSync(path.join(SUR, 'plain.txt'), 'x');
    const ps = await L.listFolder(SUR, { max: 60 });
    const ghost = (ps.items || []).filter((i) => /\uFFFD/.test(i.name));
    check('hostile: the plain read lists no name it cannot open (a lone surrogate), and counts it', ps.ok && ghost.length === 0 && ps.unspellable === 1 && ps.items.some((i) => i.name === 'plain.txt'), show({ names: (ps.items || []).map((i) => i.name), unspellable: ps.unspellable }));
    const cU = fakeCtx({});
    const hU = F._install(cU.ctx, { folder: SUR, watch: fakeWatch().fn, electron: null });
    const vU = await cU.commands.list({});
    check('hostile: ... and the panel says so (detail), with no name', /cannot open/.test(vU.detail || '') && !/lone/.test(vU.detail || ''), show(vU.detail));
    hU.stop('test over');
    execFileSync('powershell', ['-NoProfile', '-Command', "Remove-Item -LiteralPath '" + SUR + "' -Recurse -Force"], { windowsHide: true });

    /* a big folder through the plain read: main is never blocked long (100k entries blocked it 4 s) */
    const BIG = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-big-'));
    const pad = 'n'.repeat(180);
    for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(BIG, pad + i + '.txt'), '');
    let last = process.hrtime.bigint(), worst = 0;
    const iv = setInterval(() => { const t = process.hrtime.bigint(); worst = Math.max(worst, Number(t - last) / 1e6); last = t; }, 2);
    const pb = await L.listFolder(BIG, { max: 60 });
    clearInterval(iv);
    check('hostile: the plain read of 5000 long names never blocks main more than 60 ms', pb.ok && pb.total === 5000 && pb.items.length === 60 && worst < 60, show({ worstMs: Math.round(worst), total: pb.total }));
    fs.rmSync(BIG, { recursive: true, force: true });

    /* the bar's words: a right-to-left override cannot dress an .exe as a .pdf */
    check('hostile: the bar shows a name with its bidi controls taken out (RLO cannot hide ".exe")', typeof U.shown === 'function' && U.shown('invoice\u202Efdp.exe') === 'invoicefdp.exe' && U.shown('a\u2066b\u2069\u200Fc') === 'abc' && U.shown('plain.pdf') === 'plain.pdf', typeof U.shown === 'function' ? show(U.shown('invoice\u202Efdp.exe')) : 'no U.shown');
    check('hostile: the bar draws an icon only from a data:image URL', typeof U.iconOk === 'function' && U.iconOk('data:image/png;base64,AA') && !U.iconOk('file://evil/share/x.png') && !U.iconOk('C:\\x.png') && !U.iconOk('\\\\evil\\share\\x.png') && !U.iconOk('https://x/y.png'), 'U.iconOk ' + typeof U.iconOk);
  } finally {
    try { fs.rmSync(HT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}
