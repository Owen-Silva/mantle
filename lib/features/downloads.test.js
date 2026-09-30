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
    check('kindOf: one glyph family by type', U.kindOf('a.PDF') === 'doc' && U.kindOf('x.tar.gz') === 'archive' && U.kindOf('setup.msi') === 'app' && U.kindOf('clip.mp4') === 'video' && U.kindOf('pic.HEIC') === 'image' && U.kindOf('README') === 'file' && U.kindOf('y.zip', true) === 'folder', [U.kindOf('a.PDF'), U.kindOf('x.tar.gz'), U.kindOf('README')].join());
    check('sentence: a clause becomes a sentence', U.sentence('the folder is gone') === 'The folder is gone.' && U.sentence('done (x)') === 'Done (x).' && U.sentence('ok!') === 'Ok!' && U.sentence('') === '' && U.sentence(null) === '', U.sentence('the folder is gone'));

    /* ------------------------------------------------ the feature, against a fake ctx */
    await featureTests();
    await hostileTests();
    await passTests();
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
  check('feature: list carries the folder (for the panel) and no icon (the bar draws its own glyph family)', v.folder === TMP && v.items.every((i) => i.icon === undefined), show({ folder: v.folder === TMP }));
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
  check('feature: a failed open says why, WITHOUT the name or the path', o2.ok === false && /no app set for this kind of file/.test(o2.reason) && !o2.reason.includes('installer') && !o2.reason.includes(TMP), show(o2));
  check('feature: ... as the cause alone, in plain words that say what to do next', /^Windows has no app set for this kind of file\. Use Show in folder, then right-click it and choose Open with$/.test(o2.reason), show(o2.reason));
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
  check('feature: reveal without Electron says so in words', r1.ok === false && /not available/.test(r1.reason) && !L.JARGON.test(r1.reason), show(r1));
  const d1 = await c.commands.drag({ item: pdf.item });
  check('feature: drag without Electron says so in words', d1.ok === false && /not available/.test(d1.reason) && !L.JARGON.test(d1.reason), show(d1));

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
  check('feature: a sidecar that cannot answer falls back to the plain read, and says so in plain words', vS.ok && vS.items.length >= 4 && /simpler list/.test(vS.detail || '') && !L.JARGON.test(vS.detail), show({ ok: vS.ok, n: vS.items.length, detail: vS.detail }));
  check('feature: ... the sidecar own words go to the log only', cS.logs.some((l) => /plain read: the sidecar could not answer: .*unknown command/.test(l)), show(cS.logs.slice(-3)));
  hS.stop('test over');
  const cN = fakeCtx({ ready: false });
  const hN = F._install(cN.ctx, { watch: fakeWatch().fn, electron: null });
  await hN._read('test');
  check('feature: no helper and no Electron: unresolved, in plain words', cN.state().ok === false && cN.state().state === 'unresolved' && /did not say where/.test(cN.state().reason), show(cN.state()));
  hN.stop('test over');

  /* the watch fails: said, and retried later (never a tight poll) */
  const cW = fakeCtx();
  const hW = F._install(cW.ctx, { folder: TMP, watch: () => { const e = new Error(`EPERM: operation not permitted, watch '${TMP}'`); e.code = 'EPERM'; throw e; }, electron: null });
  await hW._read('test');
  const vW = await cW.commands.list({ cached: true });
  check('feature: a watch that cannot start is named (watching:false + reason), the list still works', vW.ok && vW.watching === false && /when you open this panel/.test(vW.watchReason) && !L.JARGON.test(vW.watchReason) && cW.logs.some((l) => /cannot be watched \(EPERM\)/.test(l)), show({ watching: vW.watching, why: vW.watchReason }));
  hW.stop('test over');

  /* settings that cannot be written: said in the panel */
  const cX = fakeCtx({ settingsThrow: true });
  const hX = F._install(cX.ctx, { folder: TMP, watch: fakeWatch().fn, electron: null });
  await hX._read('test');
  const sX = await cX.commands.seen({});
  check('feature: seenAt that cannot be saved is a note, not silence', sX.ok && /could not save/.test(sX.note || '') && !L.JARGON.test(sX.note), show(sX));
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
    check('hostile: no row carries an icon URL at all (nothing for the page to fetch)', vS.items.every((i) => !('icon' in i)), show(vS.items.map((i) => typeof i.icon)));
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
    /* The BEST of up to 3 walks: a real block (one long synchronous step) repeats on every walk; a
       machine busy with other work (other test lanes, a build) stalls a timer once and not the next
       time (a single walk measured 119 ms under load, 20-30 ms idle, 2026-09-29). */
    let worst = Infinity, pb = null;
    for (let tries = 0; tries < 3 && worst >= 60; tries++) {
      let last = process.hrtime.bigint(), w = 0;
      const iv = setInterval(() => { const t = process.hrtime.bigint(); w = Math.max(w, Number(t - last) / 1e6); last = t; }, 2);
      pb = await L.listFolder(BIG, { max: 60 });
      clearInterval(iv);
      worst = Math.min(worst, w);
    }
    check('hostile: the plain read of 5000 long names never blocks main more than 60 ms', pb.ok && pb.total === 5000 && pb.items.length === 60 && worst < 60, show({ worstMs: Math.round(worst), total: pb.total }));
    fs.rmSync(BIG, { recursive: true, force: true });

    /* the bar's words: a right-to-left override cannot dress an .exe as a .pdf */
    check('hostile: the bar shows a name with its bidi controls taken out (RLO cannot hide ".exe")', typeof U.shown === 'function' && U.shown('invoice\u202Efdp.exe') === 'invoicefdp.exe' && U.shown('a\u2066b\u2069\u200Fc') === 'abc' && U.shown('plain.pdf') === 'plain.pdf', typeof U.shown === 'function' ? show(U.shown('invoice\u202Efdp.exe')) : 'no U.shown');
    check('hostile: the bar draws no image from main (its glyphs are its own SVG)', typeof U.iconOk === 'undefined' && typeof U.kindOf === 'function', typeof U.iconOk);
  } finally {
    try { fs.rmSync(HT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

/* ---------------------------------------------------------------- quality pass (lane topbar-dl, 2026-09-29)
   The REAL fs.watch on a temp folder (a file appears, a partial is renamed, a file is removed), rest +
   wake, the watch dying with its folder and the retry, unicode names through the token, drag with the
   right file, and no jargon in anything the panel can show. */
async function passTests() {
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return !!(await fn()); };
  const REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-real-'));
  const shownText = [];
  const collect = (...xs) => { for (const x of xs) if (x) shownText.push(String(x)); };
  try {
    /* The 100 ms gaps: Windows stamps file times from the ~15.6 ms clock tick, up to ~12 ms off
       Date.now() (measured 2026-09-30: 274 of 300 back-to-back files shared the previous one's mtime).
       Without them older.txt, seenAt and report.pdf can land in ONE tick, so the order falls to the name
       tiebreak and "new" to the skew (2 of 3 runs failed on the ship tree). A real download is not
       that close to the moment the shelf was opened. */
    fs.writeFileSync(path.join(REAL, 'older.txt'), 'o');
    await sleep(100);
    const c = fakeCtx({});
    const h = F._install(c.ctx, { folder: REAL, electron: null });   // the REAL fs.watch
    await h._read('test');
    check('pass: the real watch is on (fs.watch on the temp folder)', c.state().watching === true && c.state().count === 1, show(c.state()));
    await sleep(100);
    const s0 = c.sends;
    fs.writeFileSync(path.join(REAL, 'report.pdf'), 'p');
    const saw = await until(() => c.state().count === 2, 5000);
    check('pass: a new file appears on its own (watch, 700 ms quiet, a re-read)', saw && c.sends - s0 >= 1 && c.sends - s0 <= 3, show({ count: c.state().count, reads: c.sends - s0 }));
    const v1 = await c.commands.list({ cached: true });
    check('pass: ... it is the newest row and new (the dot)', v1.items[0].name === 'report.pdf' && v1.items[0].fresh === true && c.state().newCount >= 1, show(v1.items.map((i) => [i.name, i.fresh])));
    fs.writeFileSync(path.join(REAL, 'movie.mkv.crdownload'), 'x');
    await until(() => c.state().partial === 1, 5000);
    const v2 = await c.commands.list({ cached: true });
    check('pass: a partial is "still downloading", never a row', c.state().partial === 1 && !v2.items.some((i) => /crdownload/.test(i.name)), show({ partial: c.state().partial }));
    fs.renameSync(path.join(REAL, 'movie.mkv.crdownload'), path.join(REAL, 'movie.mkv'));
    await until(() => c.state().partial === 0 && c.state().count === 3, 5000);
    const v3 = await c.commands.list({ cached: true });
    check('pass: the finished rename appears as the real file', v3.items.some((i) => i.name === 'movie.mkv') && c.state().partial === 0, show(v3.items.map((i) => i.name)));
    fs.unlinkSync(path.join(REAL, 'report.pdf'));
    await until(() => c.state().count === 2, 5000);
    const v4 = await c.commands.list({ cached: true });
    check('pass: a removed file disappears', !v4.items.some((i) => i.name === 'report.pdf') && c.state().count === 2, show(v4.items.map((i) => i.name)));

    await c.commands.seen({});
    const saved = c.settings.seenAt;
    h.stop('resting while VALORANT.exe runs', { rest: true });
    const sBefore = c.sends;
    await sleep(100);   // off the tick seenAt was taken in (see the note on older.txt above)
    fs.writeFileSync(path.join(REAL, 'during-game.zip'), 'z');
    await sleep(1200);
    check('pass: while resting, a new file costs nothing (no read)', c.sends === sBefore, `${c.sends - sBefore} reads`);
    const c2 = fakeCtx({ settings: { seenAt: saved } });
    const h2 = F._install(c2.ctx, { folder: REAL, electron: null });   // wake = lib/features.js installs it again
    await h2._read('test');
    check('pass: wake reopens the watch and sees what came in during the game', c2.state().watching === true && c2.state().count === 3, show(c2.state()));
    check('pass: ... only that file is new (seenAt survived the rest)', c2.state().newCount === 1, show({ newCount: c2.state().newCount }));
    h2.stop('test over');

    const GONE = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-gone-'));
    fs.writeFileSync(path.join(GONE, 'a.txt'), 'a');
    const w = fakeWatch();
    const c3 = fakeCtx({});
    const h3 = F._install(c3.ctx, { folder: GONE, watch: w.fn, electron: null, retryMs: 300 });
    await h3._read('test');
    fs.rmSync(GONE, { recursive: true, force: true });
    const r0 = c3.sends;
    w.errFn(Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
    await until(() => c3.state().state === 'missing', 2000);
    check('pass: the watch dying with its folder re-reads at once: "missing", not stale rows', c3.state().state === 'missing' && c3.sends > r0, show(c3.state()));
    const vg = await c3.commands.list({ cached: true });
    collect(vg.reason, vg.detail, vg.watchReason);
    check('pass: ... the panel is told when Mantle looks again (retryMs)', vg.ok === false && vg.retryMs === 300, show({ ok: vg.ok, retryMs: vg.retryMs }));
    const r1 = c3.sends;
    await sleep(800);
    check('pass: a missing folder is looked for again on the retry timer (not faster)', c3.sends - r1 >= 1 && c3.sends - r1 <= 3, `${c3.sends - r1} reads in 800 ms at a 300 ms retry`);
    fs.mkdirSync(GONE); fs.writeFileSync(path.join(GONE, 'back.txt'), 'b');
    await until(() => c3.state().state === 'ok', 2000);
    check('pass: the folder back: ok again and watched again', c3.state().state === 'ok' && w.calls.length === 2, show({ st: c3.state().state, watches: w.calls.length }));
    h3.stop('test over');
    fs.rmSync(GONE, { recursive: true, force: true });

    /* A watch that errors every time it is opened while the folder is FINE (a network drive, an AV
       filter): the immediate re-read must not re-arm the watch at once, or read -> watch -> error ->
       read spins as fast as the disk answers. One read per error, re-watched on the retry timer. */
    const FLAKY = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-flaky-'));
    fs.writeFileSync(path.join(FLAKY, 'a.txt'), 'a');
    let flakyWatches = 0;
    const flakyWatch = () => {
      flakyWatches++;
      let fn = null;
      const wt = { close() {}, on(ev, f) { if (ev === 'error') fn = f; } };
      setTimeout(() => { if (fn) fn(Object.assign(new Error('EPERM'), { code: 'EPERM' })); }, 5);
      return wt;
    };
    const c5 = fakeCtx({});
    const h5 = F._install(c5.ctx, { folder: FLAKY, watch: flakyWatch, electron: null, retryMs: 300 });
    await h5._read('test');
    const s5 = c5.sends;
    await sleep(700);
    h5.stop('test over');
    check('pass: a watch that keeps failing on a fine folder does not spin (reads and re-watches follow the retry timer)',
      c5.sends - s5 <= 6 && flakyWatches <= 5, `${c5.sends - s5} reads, ${flakyWatches} watches in 700 ms at a 300 ms retry`);
    check('pass: ... and the panel still says new downloads show up on open', c5.state().state === 'ok' && c5.state().watching === false, show({ st: c5.state().state, watching: c5.state().watching }));
    fs.rmSync(FLAKY, { recursive: true, force: true });

    const UNI = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-uni-'));
    const uni = ['résumé.pdf', '数学.docx', 'party 🎉.zip', 'x'.repeat(200) + '.txt'];
    for (const n of uni) fs.writeFileSync(path.join(UNI, n), 'u');
    const opened = [], dragged = [];
    const img = { isEmpty: () => false };
    const fakeEl = { shell: { showItemInFolder: (p) => opened.push('reveal:' + p) }, webContents: {}, app: { getFileIcon: async () => img }, nativeImage: {} };
    const c4 = fakeCtx({});
    const h4 = F._install(c4.ctx, { folder: UNI, watch: fakeWatch().fn, electron: fakeEl, dryRun: false, open: async (p) => { opened.push('open:' + p); return { ok: true }; }, barContents: () => ({ startDrag: (o) => dragged.push(o) }) });
    const vu = await c4.commands.list({});
    const byName = (n) => vu.items.find((i) => i.name === n);
    check('pass: unicode and 200-character names are listed exactly', uni.every((n) => !!byName(n)), show(vu.items.map((i) => i.name.length)));
    await c4.commands.open({ item: byName(uni[2]).item });
    await c4.commands.reveal({ item: byName(uni[1]).item });
    const dr = await c4.commands.drag({ item: byName(uni[0]).item });
    check('pass: open goes to open-target with the exact emoji path', opened[0] === 'open:' + path.join(UNI, uni[2]), show(opened.length));
    check('pass: Show in folder selects the exact CJK path', opened[1] === 'reveal:' + path.join(UNI, uni[1]), show(opened.length));
    check('pass: drag starts on the bar with the right file and its icon', dr.ok && dragged.length === 1 && dragged[0].file === path.join(UNI, uni[0]) && dragged[0].icon === img, show({ ok: dr.ok, n: dragged.length }));
    h4.stop('test over');
    fs.rmSync(UNI, { recursive: true, force: true });

    const cN = fakeCtx({ ready: false });
    const hN = F._install(cN.ctx, { electron: null, watch: fakeWatch().fn });
    await hN._read('test');
    collect(cN.state().reason);
    hN.stop('test over');
    const cX = fakeCtx({ settingsThrow: true, sidecarSend: async () => ({ ok: false, error: 'the sidecar timed out after 6000 ms (downloads.list)' }) });
    const hX = F._install(cX.ctx, { folder: REAL, watch: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }, electron: null });
    const vX = await cX.commands.list({});
    collect(vX.detail, vX.watchReason, (await cX.commands.seen({})).note);
    collect((await cX.commands.open({ item: 'd999' })).reason, (await cX.commands.reveal({ item: 'forged' })).reason, (await cX.commands.drag({ item: '' })).reason);
    hX.stop('test over');
    const cO = fakeCtx({ on: false });
    const hO = F._install(cO.ctx, { folder: REAL, watch: fakeWatch().fn, electron: null });
    collect(cO.state().reason, (await cO.commands.list({})).reason);
    hO.stop('test over');
    collect(L.fsWhy({ code: 'EACCES' }, 'list').reason, L.fsWhy({ code: 'EIO' }, 'list').reason, L.fsWhy({ code: 'ENOTDIR' }, 'list').reason);
    const jargon = shownText.filter((t) => L.JARGON.test(t));
    check('pass: nothing the panel can show carries jargon (codes, HRESULT, sidecar, Electron, null)', shownText.length >= 12 && jargon.length === 0, show({ n: shownText.length, bad: jargon.slice(0, 3) }));
    check('pass: the jargon filter catches what it must', L.JARGON.test('failed (EPERM)') && L.JARGON.test('HRESULT 0x80070005') && L.JARGON.test('the sidecar is down') && L.JARGON.test('IOException') && !L.JARGON.test('Every file in Explorer is here'), 'JARGON');
  } finally {
    try { fs.rmSync(REAL, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}
