'use strict';
/*
 * look-host.test.js -- lib/look-host.js, Mantle's CONSUMER side of look sync, under plain node
 * (lane looksync-unit, 2026-10-10). A REAL look-sync instance on TEMP folders (LOOK_SYNC_DIR points at a
 * temp folder too, so the real %APPDATA%\look-sync is never touched -- checked at the end), a fake theme
 * core, and ~/look-sync/fake-writer.js as Helm / Quartz writing the shared file from another process.
 *
 *   node lib/look-host.test.js
 *
 * Prints "LOOK HOST TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'look-host-test-'));
process.env.LOOK_SYNC_DIR = path.join(ROOT, 'env-dir');
const REAL = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');
const WRITER = path.join(os.homedir(), 'look-sync', 'fake-writer.js');

const LS = require('./look-sync');
const accent = require('./accent');
const { makeLookHost } = require('./look-host');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const latencies = [];

function snapshot(dir) {
  const out = {};
  (function walk(d) {
    let names; try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names) {
      const f = path.join(d, n); let s; try { s = fs.statSync(f); } catch (_) { continue; }
      if (s.isDirectory()) walk(f); else out[f] = s.mtimeMs + ':' + s.size;
    }
  })(dir);
  return out;
}
const REAL_EXISTED = fs.existsSync(REAL);
const REAL_BEFORE = snapshot(REAL);
const childPids = [];

/** run fake-writer against dir -> { code, out, ms, writtenAt } */
function writer(dir, args, app) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cp = execFile(process.execPath, [WRITER, '--dir', dir, '--app', app || 'quartz', ...args], { timeout: 15000 }, (err, out, errOut) => {
      resolve({ code: err ? (err.code || 1) : 0, out: String(out || '') + String(errOut || ''), ms: Date.now() - t0, writtenAt });
    });
    childPids.push(cp.pid);
    let writtenAt = null;
    cp.stdout.on('data', () => { if (!writtenAt) writtenAt = Date.now(); });
  });
}

/* ---- a host on its own temp folders ---- */
let hostN = 0;
function makeHost(opt) {
  opt = opt || {};
  const n = ++hostN;
  const dir = opt.dir || path.join(ROOT, `share-${n}`);
  const file = opt.file || path.join(ROOT, `local-${n}`, 'look-sync.json');
  const T = { m: opt.mode || 'dark', sets: [], host: null };
  T.core = {
    mode: () => T.m,
    resolved: () => (T.m === 'light' ? 'light' : 'dark'),
    // the real theme core fires its listener synchronously, and main.js forwards it to themeChanged
    set: (m) => { T.sets.push(m); T.m = m; if (T.host) T.host.themeChanged({ mode: m }); return { ok: true }; },
  };
  const logs = [];
  const events = [];
  const host = makeLookHost({ LS: opt.LS || LS, accent, file, dir, theme: T.core, log: (l) => logs.push(l) });
  T.host = host;
  host.onChange((e) => events.push(Object.assign({ t: Date.now() }, e)));
  const H = {
    host, dir, file, T, logs, events,
    doc: () => { const r = LS.read(dir); return r.state === 'ok' ? r.doc : null; },
    local: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } },
    /** wait until pred(event) is true for an event after index `from`; -> the event or null */
    async waitEvent(from, pred, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 2000)) {
        for (let i = from; i < events.length; i++) if (pred(events[i])) return events[i];
        await sleep(5);
      }
      return null;
    },
    async waitFor(pred, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 2000)) { if (pred()) return true; await sleep(10); }
      return !!pred();
    },
  };
  return H;
}
function writeLocal(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : J(v)); }
const SEEDG = () => JSON.parse(J(LS.SEED.glass));
function glassWith(dark) { const g = SEEDG(); Object.assign(g.dark, dark); return g; }

(async () => {
  /* ======== vars ======== */
  {
    const H = makeHost();
    check('vars(dark) EMPTY at the seed values', J(H.host.vars('dark')) === '{}', J(H.host.vars('dark')));
    check('vars(light) EMPTY at the seed values', J(H.host.vars('light')) === '{}', J(H.host.vars('light')));
    H.host.close();
  }
  async function varsFor(local) {
    const H = makeHost({ file: path.join(ROOT, `vars-${hostN + 1}`, 'look-sync.json') });
    H.host.close();
    writeLocal(H.file, local);
    const H2 = makeHost({ file: H.file });
    const out = { dark: H2.host.vars('dark'), light: H2.host.vars('light') };
    H2.host.close();
    return out;
  }
  {
    const v = await varsFor({ glass: glassWith({ blurPx: 9 }) });
    check('blurPx 9 -> --lg-blur blur(9px), nothing else', J(v.dark) === J({ '--lg-blur': 'blur(9px)' }), J(v.dark));
    check('blurPx 9: light vars stay empty', J(v.light) === '{}', J(v.light));
  }
  {
    const v = await varsFor({ glass: glassWith({ dim: 0.6 }) });
    check('dim .6 -> --lg-fill-bar rgba(9,10,11,0.6)', J(v.dark) === J({ '--lg-fill-bar': 'rgba(9,10,11,0.6)' }), J(v.dark));
  }
  {
    const v = await varsFor({ glass: glassWith({ panel: -0.1 }) });
    check('panel -0.1 -> fill .73 pop .78 card .52 field .36', J(v.dark) === J({
      '--lg-fill': 'rgba(19,20,21,0.73)', '--lg-fill-pop': 'rgba(19,20,21,0.78)', '--lg-card': 'rgba(40,41,43,0.52)', '--lg-field': 'rgba(10,11,12,0.36)' }), J(v.dark));
  }
  {
    const v = await varsFor({ glass: glassWith({ panel: 0.15 }) });
    check('panel +0.15 clamps --lg-fill-pop at .97', v.dark['--lg-fill-pop'] === 'rgba(19,20,21,0.97)', J(v.dark));
    check('panel +0.15 clamps --lg-fill at .97, card .77, field .61', v.dark['--lg-fill'] === 'rgba(19,20,21,0.97)' && v.dark['--lg-card'] === 'rgba(40,41,43,0.77)' && v.dark['--lg-field'] === 'rgba(10,11,12,0.61)', J(v.dark));
  }
  {
    const v = await varsFor({ glass: glassWith({ panel: -0.3 }) });
    check('panel -0.3 clamps --lg-field at .30', v.dark['--lg-field'] === 'rgba(10,11,12,0.3)', J(v.dark));
    check('panel -0.3: fill .53 pop .58 card .32', v.dark['--lg-fill'] === 'rgba(19,20,21,0.53)' && v.dark['--lg-fill-pop'] === 'rgba(19,20,21,0.58)' && v.dark['--lg-card'] === 'rgba(40,41,43,0.32)', J(v.dark));
  }
  {
    const g = SEEDG(); g.light = { blurPx: 30, dim: 0.8, panel: 0.1 }; Object.assign(g.dark, { blurPx: 20, dim: 0.3, panel: 0.05 });
    const v = await varsFor({ glass: g });
    check('light vars never carry glass (light glass changed too)', J(v.light) === '{}', J(v.light));
    check('all dark glass changes at once: 6 vars', Object.keys(v.dark).length === 6 && v.dark['--lg-blur'] === 'blur(20px)' && v.dark['--lg-fill-bar'] === 'rgba(9,10,11,0.3)', J(v.dark));
  }
  {
    const v = await varsFor({ accent: { hue: 212 } });
    check('hue 212 dark: the 6 accent tokens + --lg-focus', J(v.dark) === J({
      '--lg-acc': '#9fb4cc', '--lg-acc-strong': '#b7c8db', '--lg-acc-on': '#11161c', '--lg-acc-soft': 'rgba(159, 180, 204, 0.14)',
      '--lg-acc-line': 'rgba(159, 180, 204, 0.42)', '--lg-acc-select': 'rgba(159, 180, 204, 0.32)',
      '--lg-focus': '0 0 0 1px rgba(20,21,22,.9), 0 0 0 3px rgba(159,180,204,.55)' }), J(v.dark));
    const t = accent.tokens(212, 'light');
    check('hue 212 light: NO vars (the light look stays exactly as today; Owen 2026-10-10)', J(v.light) === '{}' && !!t, J(v.light));
  }
  {
    const v = await varsFor({ accent: { hue: null } });
    check('hue null: no accent vars either theme', J(v.dark) === '{}' && J(v.light) === '{}', J(v));
  }

  /* ======== first-ever start seeds Dark ======== */
  {
    const H = makeHost({ mode: 'light' });
    H.host.start();
    const ok = await H.waitFor(() => H.host.view().sync.state === 'ok');
    const v = H.host.view();
    check('first start: state ok', ok && v.sync.state === 'ok', J(v.sync));
    check('first start: text mentions seeded', /seeded by Mantle/.test(v.sync.text) && /Dark/.test(v.sync.text), v.sync.text);
    check('first start: the file holds the seed (Dark)', H.doc() && H.doc().look.theme.v === 'dark' && H.doc().writer.app === 'mantle', J(H.doc() && H.doc().look.theme));
    check('first start: Mantle adopted Dark through the theme core', J(H.T.sets) === '["dark"]', J(H.T.sets));
    check('first start: adopting the seed published nothing more', H.doc().rev === 1, H.doc() && H.doc().rev);
    check('first start: vars still empty', J(H.host.vars('dark')) === '{}', J(H.host.vars('dark')));
    check('view: ranges and glass present', v.ranges && J(v.ranges.dim) === '[0.2,0.9]' && J(v.glass) === J(LS.SEED.glass.dark), J(v.glass));

    /* ======== consume: Quartz changes, measured ======== */
    const rev0 = H.doc().rev;
    let from = H.events.length;
    const w1 = await writer(H.dir, ['set', 'theme', 'light']);
    check('fake-writer set theme light ran', w1.code === 0 && /"ok":true/.test(w1.out), w1.out);
    const e1 = await H.waitEvent(from, (e) => e.why === 'apply', 3000);
    const writtenRev = H.doc() && H.doc().rev;
    if (e1 && w1.writtenAt) latencies.push(['theme', e1.t - w1.writtenAt]);
    check('consume theme: applied within 1000 ms of the write', e1 && w1.writtenAt && e1.t - w1.writtenAt <= 1000, e1 ? `${e1.t - w1.writtenAt} ms` : 'no apply event');
    check('consume theme: theme core set to light', H.T.sets[H.T.sets.length - 1] === 'light' && H.T.m === 'light', J(H.T.sets));
    check('consume theme: view theme light', H.host.view().theme === 'light', H.host.view().theme);
    await sleep(400);
    const d1 = H.doc();
    check('loop guard: applying a theme from sync published nothing (rev unchanged)', d1.rev === writtenRev && writtenRev === rev0 + 1 && d1.writer.app === 'quartz', `rev ${rev0} -> ${writtenRev} -> ${d1.rev}, writer ${d1.writer.app}`);
    check('consume theme: status names Quartz', /last change from Quartz/.test(H.host.view().sync.text) && H.host.view().sync.by === 'Quartz', H.host.view().sync.text);

    from = H.events.length;
    const w2 = await writer(H.dir, ['set', 'accent', '200']);
    const e2 = await H.waitEvent(from, (e) => e.why === 'apply' && e.varsChanged, 3000);
    if (e2 && w2.writtenAt) latencies.push(['accent', e2.t - w2.writtenAt]);
    check('consume accent: applied within 1000 ms, varsChanged', e2 && w2.writtenAt && e2.t - w2.writtenAt <= 1000, e2 ? `${e2.t - w2.writtenAt} ms` : `no event; ${w2.out}`);
    check('consume accent: dark --lg-acc is hue 200', H.host.vars('dark')['--lg-acc'] === accent.tokens(200, 'dark').acc, J(H.host.vars('dark')));
    check('consume accent: light stays untouched (no vars) while dark follows hue 200', J(H.host.vars('light')) === '{}' && H.host.vars('dark')['--lg-acc'] === accent.tokens(200, 'dark').acc, J(H.host.vars('light')));
    check('consume accent: saved to the local copy', H.local() && J(H.local().accent) === '{"hue":200}', J(H.local()));
    check('consume accent: event carries the view', e2 && e2.view && J(e2.view.accent) === '{"hue":200}', e2 && J(e2.view && e2.view.accent));
    await sleep(300);
    check('loop guard: accent from sync not published back', H.doc().writer.app === 'quartz', H.doc().writer.app);

    from = H.events.length;
    const w3 = await writer(H.dir, ['set', 'glass.dark.dim', '0.6']);
    const e3 = await H.waitEvent(from, (e) => e.why === 'apply' && e.varsChanged, 3000);
    if (e3 && w3.writtenAt) latencies.push(['glass', e3.t - w3.writtenAt]);
    check('consume glass: applied within 1000 ms, varsChanged', e3 && w3.writtenAt && e3.t - w3.writtenAt <= 1000, e3 ? `${e3.t - w3.writtenAt} ms` : `no event; ${w3.out}`);
    check('consume glass: --lg-fill-bar 0.6', H.host.vars('dark')['--lg-fill-bar'] === 'rgba(9,10,11,0.6)', J(H.host.vars('dark')));
    check('consume glass: view glass dim .6', H.host.view().glass.dim === 0.6, J(H.host.view().glass));

    /* ======== Owen picks a theme in Mantle: published by mantle ======== */
    const r0 = H.doc().rev;
    H.T.m = 'system';
    H.host.themeChanged({ mode: 'system' });
    const pub = await H.waitFor(() => { const d = H.doc(); return d && d.look.theme.v === 'system'; });
    const d2 = H.doc();
    check('themeChanged: theme published', pub && d2.rev === r0 + 1, `rev ${r0} -> ${d2.rev}`);
    check('themeChanged: by mantle', d2.look.theme.by === 'mantle' && d2.writer.app === 'mantle', J(d2.look.theme));
    H.host.themeChanged({ mode: 'system' });
    await sleep(200);
    check('themeChanged same mode again: no publish', H.doc().rev === d2.rev, H.doc().rev);
    await sleep(300);
    check('themeChanged: own write not re-applied to the theme core', H.T.sets[H.T.sets.length - 1] === 'light', J(H.T.sets));

    /* ======== setGlass / setAccent ======== */
    const r1 = H.doc().rev;
    from = H.events.length;
    const g = await H.host.setGlass({ blurPx: 9 });
    check('setGlass valid: returns the view', g && g.ok === true && g.glass.blurPx === 9 && !g.note, J(g && g.glass));
    check('setGlass valid: local file saved', H.local() && H.local().glass.dark.blurPx === 9 && H.local().glass.dark.dim === 0.6, J(H.local() && H.local().glass));
    check('setGlass valid: published', H.doc().rev === r1 + 1 && H.doc().look.glass.v.dark.blurPx === 9 && H.doc().look.glass.by === 'mantle', J(H.doc().look.glass));
    check('setGlass valid: light glass passed through untouched', J(H.doc().look.glass.v.light) === J(LS.SEED.glass.light), J(H.doc().look.glass.v.light));
    check('setGlass valid: onChange varsChanged', H.events.slice(from).some((e) => e.why === 'glass' && e.varsChanged), J(H.events.slice(from).map((e) => [e.why, e.varsChanged])));
    check('setGlass valid: --lg-blur', H.host.vars('dark')['--lg-blur'] === 'blur(9px)', J(H.host.vars('dark')));

    const before = J(H.local()), rb = H.doc().rev, vb = J(H.host.vars('dark'));
    for (const [patch, re] of [[{ dim: 0.95 }, /dim must be 0\.2\.\.0\.9/], [{ blurPx: -1 }, /blurPx/], [{ panel: 0.2 }, /panel/], [{ blurPx: '9' }, /blurPx/], [null, /without values/]]) {
      const r = await H.host.setGlass(patch);
      check(`setGlass ${J(patch)}: refused with a reason`, r && r.ok === false && re.test(r.reason), J(r));
    }
    check('setGlass out of range: nothing changed (local, shared, vars)', J(H.local()) === before && H.doc().rev === rb && J(H.host.vars('dark')) === vb, `${H.doc().rev} vs ${rb}`);

    const a = await H.host.setAccent(212);
    check('setAccent 212: returns the view', a && a.ok === true && a.accent.hue === 212, J(a && a.accent));
    check('setAccent 212: saved + published', H.local().accent.hue === 212 && H.doc().look.accent.v.hue === 212 && H.doc().look.accent.by === 'mantle', J(H.doc().look.accent));
    const ra = H.doc().rev, la = J(H.local());
    for (const bad of [400, -1, 1.5, '212']) {
      const r = await H.host.setAccent(bad);
      check(`setAccent ${J(bad)}: refused`, r && r.ok === false && /hue/.test(r.reason), J(r));
    }
    check('setAccent invalid: nothing changed', H.doc().rev === ra && J(H.local()) === la, `${H.doc().rev} vs ${ra}`);
    const an = await H.host.setAccent(null);
    check('setAccent null: back to Mantle\'s own, no accent vars', an.ok && H.host.vars('dark')['--lg-acc'] === undefined && H.doc().look.accent.v.hue === null, J(H.host.vars('dark')));

    /* ======== the switch ======== */
    const off = await H.host.setSync(false);
    check('switch off: view state off', off.sync.on === false && off.sync.state === 'off', J(off.sync));
    check('switch off: text', off.sync.text === 'Off: Mantle keeps its own look', off.sync.text);
    check('switch off: saved locally', H.local().lookSync === false, J(H.local()));
    const ro = H.doc().rev;
    const go = await H.host.setGlass({ panel: -0.1 });
    check('sync off setGlass: ok, saved locally', go.ok && H.local().glass.dark.panel === -0.1, J(H.local().glass.dark));
    check('sync off setGlass: NOT published', H.doc().rev === ro && H.doc().look.glass.v.dark.panel === 0, `${ro} -> ${H.doc().rev}`);
    check('sync off setGlass: vars follow locally', H.host.vars('dark')['--lg-fill'] === 'rgba(19,20,21,0.73)', J(H.host.vars('dark')));
    check('sync off: view still off with the text', H.host.view().sync.state === 'off' && H.host.view().sync.text === 'Off: Mantle keeps its own look', J(H.host.view().sync));
    await H.host.setAccent(30);
    check('sync off setAccent: NOT published', H.doc().rev === ro && H.local().accent.hue === 30, H.doc().rev);
    from = H.events.length;
    const setsBefore = H.T.sets.length;
    await writer(H.dir, ['set', 'accent', '100'], 'helm');
    await writer(H.dir, ['set', 'theme', 'dark'], 'helm');
    await sleep(700);
    check('switch off: remote change ignored (accent)', H.host._local().accent.hue === 30, J(H.host._local().accent));
    check('switch off: remote change ignored (theme)', H.T.sets.length === setsBefore && H.T.m === 'system', J(H.T.sets));
    check('switch off: no apply event', !H.events.slice(from).some((e) => e.why === 'apply'), J(H.events.slice(from).map((e) => e.why)));

    const on = await H.host.setSync(true);
    check('switch on: view on + ok', on.sync.on === true && on.sync.state === 'ok', J(on.sync));
    check('switch on: shared accent wins (100)', H.host._local().accent.hue === 100 && H.local().accent.hue === 100, J(H.host._local().accent));
    check('switch on: shared glass wins (panel 0, blur 9)', H.host._local().glass.dark.panel === 0 && H.host._local().glass.dark.blurPx === 9, J(H.host._local().glass.dark));
    check('switch on: shared theme wins (dark)', H.T.m === 'dark' && H.T.sets[H.T.sets.length - 1] === 'dark', J(H.T.sets));
    check('switch on: status reason starts "Now matching the others"', /^Now matching the others/.test(H.host.sync.status().reason || ''), H.host.sync.status().reason);
    check('switch on: view text says so', /Now matching the others/.test(on.sync.text), on.sync.text);
    check('switch on: adopting published nothing', H.doc().writer.app === 'helm', H.doc().writer.app);
    check('switch on: saved locally', H.local().lookSync === true, J(H.local()));

    /* ======== corrupt, then ok ======== */
    from = H.events.length;
    await writer(H.dir, ['corrupt']);
    const ec = await H.waitEvent(from, (e) => e.view.sync.state === 'corrupt', 3000);
    check('corrupt: view state corrupt with the reason', ec && /damaged/.test(ec.view.sync.reason || '') && /damaged/.test(ec.view.sync.text), ec ? J(ec.view.sync) : 'no corrupt event');
    check('corrupt: recovered (file good again, bad copy kept)', H.doc() && fs.readdirSync(H.dir).some((n) => /^look\.json\.bad-/.test(n)), J(fs.readdirSync(H.dir)));
    from = H.events.length;
    await writer(H.dir, ['set', 'accent', '150']);
    const eok = await H.waitEvent(from, (e) => e.view.sync.state === 'ok', 3000);
    check('corrupt then ok: the next change brings ok', !!eok && H.host._local().accent.hue === 150, eok ? J(eok.view.sync) : 'no ok event');

    /* ======== newer schema: read only ======== */
    from = H.events.length;
    await writer(H.dir, ['newer']);
    const en = await H.waitEvent(from, (e) => e.view.sync.state === 'newer', 3000);
    check('newer: view state newer', !!en && /newer version/.test(en.view.sync.text), en ? J(en.view.sync) : 'no newer event');
    const gn = await H.host.setGlass({ blurPx: 12 });
    check('newer: setGlass refused read-only', gn.ok === false && /newer/.test(gn.reason), J(gn));
    const an2 = await H.host.setAccent(10);
    check('newer: setAccent refused read-only', an2.ok === false && /newer/.test(an2.reason), J(an2));
    check('newer: nothing saved locally', H.local().glass.dark.blurPx === 9 && H.local().accent.hue === 150, J(H.local()));
    let newerDoc = null; try { newerDoc = JSON.parse(fs.readFileSync(path.join(H.dir, 'look.json'), 'utf8')); } catch (_) { /* */ }
    check('newer: the newer file left alone', newerDoc && newerDoc.schema === LS.SCHEMA + 1, J(newerDoc));
    H.host.close();
  }

  /* ======== unwritable / locked shared file -> error with the reason ======== */
  {
    let locked = true;
    const lockedFs = Object.assign(Object.create(fs), {
      writeFileSync(p, ...rest) {
        if (locked && /look\.json\./.test(path.basename(String(p)))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
        return fs.writeFileSync(p, ...rest);
      },
    });
    const LS2 = Object.assign({}, LS, { create: (opts) => LS.create(Object.assign({}, opts, { fs: lockedFs, retryDelays: [1, 1] })) });
    const H = makeHost({ LS: LS2 });
    H.host.start();
    await H.waitFor(() => H.host.view().sync.state === 'error');
    const v = H.host.view();
    check('locked: view state error', v.sync.state === 'error', J(v.sync));
    check('locked: the reason names the failure', /EACCES/.test(v.sync.reason || ''), v.sync.reason);
    check('locked: text says not shared', v.sync.text === 'On · not shared', v.sync.text);
    const g = await H.host.setGlass({ dim: 0.7 });
    check('locked setGlass: saved in Mantle, note says not shared', g.ok === true && /not shared/.test(g.note || '') && /EACCES/.test(g.note || '') && H.local().glass.dark.dim === 0.7, J(g.note));
    check('locked setGlass: vars still follow', H.host.vars('dark')['--lg-fill-bar'] === 'rgba(9,10,11,0.7)', J(H.host.vars('dark')));
    locked = false;
    const a = await H.host.setAccent(50);
    check('unlocked: the next change publishes and status is ok', a.ok && !a.note && a.sync.state === 'ok' && H.doc() && H.doc().look.accent.v.hue === 50, J(a.sync));
    H.host.close();
  }

  /* ======== the local file ======== */
  {
    const H = makeHost();
    await H.host.setSync(false);
    await H.host.setAccent(30);
    await H.host.setGlass({ dim: 0.7, blurPx: 12 });
    H.host.close();
    const H2 = makeHost({ file: H.file, dir: H.dir });
    const l = H2.host._local();
    check('local file persists lookSync off across a new host', l.lookSync === false && H2.host.sync.enabled === false && H2.host.view().sync.state === 'off', J(l));
    check('local file persists accent', l.accent.hue === 30, J(l.accent));
    check('local file persists glass', l.glass.dark.dim === 0.7 && l.glass.dark.blurPx === 12 && J(l.glass.light) === J(LS.SEED.glass.light), J(l.glass));
    check('local file: new host vars from it', H2.host.vars('dark')['--lg-blur'] === 'blur(12px)' && H2.host.vars('dark')['--lg-acc'] === accent.tokens(30, 'dark').acc, J(H2.host.vars('dark')));
    check('sync never ran: no shared file written', !fs.existsSync(path.join(H.dir, 'look.json')), H.dir);
    H2.host.close();

    // a value that fails validation is dropped, the rest kept
    writeLocal(H.file, { lookSync: false, accent: { hue: 999 }, glass: glassWith({ dim: 0.7 }) });
    const H3 = makeHost({ file: H.file });
    check('local file: a bad accent is dropped, good glass kept', H3.host._local().accent.hue === null && H3.host._local().glass.dark.dim === 0.7, J(H3.host._local()));
    H3.host.close();

    // a damaged local file -> defaults + a reason
    writeLocal(H.file, '{ not json');
    const H4 = makeHost({ file: H.file });
    const l4 = H4.host._local();
    check('damaged local file: defaults', l4.lookSync === true && l4.accent.hue === null && J(l4.glass) === J(LS.SEED.glass), J(l4));
    H4.host.start();
    await H4.waitFor(() => H4.host.view().sync.state === 'ok');
    const v4 = H4.host.view();
    check('damaged local file: the reason is in view.sync.reason', /could not be read/.test(v4.sync.reason || '') && /defaults/.test(v4.sync.reason || ''), v4.sync.reason);
    check('damaged local file: logged', H4.logs.some((x) => /could not be read/.test(x)), J(H4.logs));
    await H4.host.setAccent(77);
    check('damaged local file: a later save clears the reason', H4.host.view().sync.reason === null && JSON.parse(fs.readFileSync(H.file, 'utf8')).accent.hue === 77, H4.host.view().sync.reason);
    H4.host.close();
  }

  /* ======== setDesktop reaches the view ======== */
  {
    const H = makeHost();
    const from = H.events.length;
    H.host.setDesktop({ desktop: { ok: true, text: 'Shared', reason: null, rev: 4, id: 'x', title: 'X', type: 'picture', note: null }, windows: { ok: true, text: 'matches', reason: null } });
    check('setDesktop: view carries it, onChange fired', H.host.view().desktop.rev === 4 && H.host.view().windows.text === 'matches' && H.events.slice(from).some((e) => e.why === 'desktop'), J(H.host.view().desktop));
    H.host.setDesktop({ bogus: true });
    check('setDesktop malformed: ignored', H.host.view().desktop.rev === 4);
    H.host.close();
  }

  /* ======== the real store was never touched ======== */
  check('real %APPDATA%\\look-sync: existence unchanged', fs.existsSync(REAL) === REAL_EXISTED, REAL);
  const added = Object.keys(snapshot(REAL)).filter((f) => !(f in REAL_BEFORE));
  check('real %APPDATA%\\look-sync: no files created', added.length === 0, J(added));
  let realDoc = null; try { realDoc = JSON.parse(fs.readFileSync(path.join(REAL, 'look.json'), 'utf8')); } catch (_) { /* none */ }
  check('real look.json: never written by this test or its writers', !realDoc || !realDoc.writer || ![process.pid, ...childPids].includes(realDoc.writer.pid), J(realDoc && realDoc.writer));
})().catch((err) => {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
}).finally(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* temp */ }
  for (const f of failures) console.log('  FAIL ' + f);
  if (latencies.length) console.log('  apply latency after the write: ' + latencies.map(([k, ms]) => `${k} ${ms} ms`).join(', '));
  console.log(`LOOK HOST TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
