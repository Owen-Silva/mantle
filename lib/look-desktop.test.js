'use strict';
/*
 * look-desktop.test.js -- lib/look-desktop.js, Mantle's desktop wallpaper PUBLISHER, under plain node
 * (lane looksync-unit, 2026-10-10). A REAL look-sync instance on a TEMP folder (LOOK_SYNC_DIR points at
 * a temp folder too, so the real %APPDATA%\look-sync is never touched -- checked at the end); fakes for
 * nativeImage, wall-still frame(), capturePage, lib/wallpaper.js current() and Windows' wallpaper.
 *
 *   node lib/look-desktop.test.js
 *
 * Prints "LOOK DESKTOP TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'look-desktop-test-'));
process.env.LOOK_SYNC_DIR = path.join(ROOT, 'env-dir');
const REAL = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');

const LS = require('./look-sync');
const GF = require('./gif-frame');
const { makeDesktopPublisher, coverSize, KEEP } = require('./look-desktop');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

/* ---- the real store, snapshotted so the end can prove nothing was written there ---- */
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

/* ---- fake nativeImage: a picture file holds "IMG:<w>x<h>"; a data URL is "data:fake;<w>x<h>" ---- */
function img(w, h, src) {
  return {
    w, h, src,
    isEmpty: () => !(w > 0 && h > 0),
    getSize: () => ({ width: w, height: h }),
    resize: ({ width, height }) => img(width, height, src + '>resized'),
    toJPEG: (q) => Buffer.from(`JPEG ${w}x${h} q${q} ${src}`),
  };
}
const EMPTY = img(0, 0, 'empty');
const NI = { fromPath: 0, fromDataURL: 0, fromBitmap: 0, bitmaps: [] };
const nativeImage = {
  createFromPath(file) {
    NI.fromPath++;
    let t; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return EMPTY; }
    const m = /^IMG:(\d+)x(\d+)/.exec(t);
    return m ? img(Number(m[1]), Number(m[2]), path.basename(file)) : EMPTY;
  },
  createFromDataURL(url) {
    NI.fromDataURL++;
    const m = /^data:fake;(\d+)x(\d+)$/.exec(String(url));
    return m ? img(Number(m[1]), Number(m[2]), 'frame') : EMPTY;
  },
  createFromBitmap(buf, sz) {
    NI.fromBitmap++;
    NI.bitmaps.push({ len: buf.length, w: sz.width, h: sz.height });
    return buf.length === sz.width * sz.height * 4 ? img(sz.width, sz.height, 'bitmap') : EMPTY;
  },
};

/* ---- one rig: a temp shared folder, a real sync, fakes, the publisher ---- */
let rigN = 0;
function rig(opt) {
  opt = opt || {};
  const dir = opt.dir || path.join(ROOT, `share-${++rigN}`);
  const sync = opt.sync || LS.create({ app: 'mantle', dir, enabled: true, retryDelays: [1, 1] });
  const R = {
    dir, sync,
    cur: opt.cur || { ready: true, rest: false, restReason: null, item: null, reason: 'none picked' },
    frame: { ok: true, png: 'data:fake;1920x1080', w: 1920, h: 1080 },
    frameCalls: 0, captureCalls: 0,
    capture: null,                    // a function returning a Promise<image>, set per test
    win: { picture: null, fit: 'fill' },
    winGets: 0, winSets: [], winFail: null,
    lock: { picture: null }, lockGets: 0, lockSets: [], lockFail: null, lockThrow: false,
    after: [], states: [], logs: [],
    publishes: [], stillExistedAtPublish: [],
    // the shared top-band darkening: a fake computer (lib/look-guard.js has its own tests), the glass, the monitor
    glass: { dim: 0.5, blurPx: 5 }, monitor: [1536, 864], guardCalls: [], guardFail: null, guardAlpha: 0.54, guardThrow: false,
    // guard.light (2026-10-14): the light glass rides beside the dark one (R.light unless R.glass names its own)
    light: { dim: 0.45, blurPx: 12 }, lightAlpha: 0.47, lightFail: null,
  };
  const realPublish = sync.publishDesktop.bind(sync);
  R.publishFail = null;
  sync.publishDesktop = (rec) => {
    R.publishes.push(rec);
    R.stillExistedAtPublish.push(rec.still ? fs.existsSync(rec.still) : null);
    if (R.publishFail) return Promise.resolve({ ok: false, reason: R.publishFail });
    return realPublish(rec);
  };
  const windows = opt.noWindows ? null : {
    get: async () => { R.winGets++; return { ok: true, picture: R.win.picture, fit: R.win.fit, reason: null }; },
    set: async (file) => {
      R.winSets.push(file);
      if (R.winFail) return { ok: false, reason: R.winFail };
      R.win.picture = file; R.win.fit = 'fill';
      return { ok: true, reason: null };
    },
  };
  // the lock screen (sidecar perso.lock / perso.lockPicture in the app): a fake, never the real one
  const lock = opt.noLock ? null : {
    get: async () => { R.lockGets++; return { ok: true, picture: R.lock.picture }; },
    set: async (file) => {
      R.lockSets.push(file);
      if (R.lockThrow) throw new Error('Read only: this sidecar was built without WinRT');
      if (R.lockFail) return { ok: false, reason: R.lockFail };
      R.lock.picture = file;
      return { ok: true };
    },
  };
  R.pub = makeDesktopPublisher({
    sync, LS,
    current: () => R.cur,
    screen: () => ({ w: 1920, h: 1080 }),
    nativeImage,
    gifFrame: GF.firstFrame,
    frame: async () => { R.frameCalls++; return R.frame; },
    capture: () => { R.captureCalls++; return R.capture ? R.capture() : Promise.reject(new Error('no capture set')); },
    windows,
    lock,
    afterWindows: (why) => R.after.push(why),
    test: !!opt.test,
    waitMs: opt.waitMs || 20000,
    onChange: (st) => R.states.push(JSON.parse(J(st))),
    log: (l) => R.logs.push(l),
    guard: opt.noGuard ? undefined : { compute: async (a) => {
      R.guardCalls.push({ jpeg: !!a.jpeg, file: a.file || null, dim: a.dim, blurPx: a.blurPx, monitor: a.monitor, light: a.light ? JSON.parse(J(a.light)) : null });
      if (R.guardThrow) throw new Error('boom');
      if (R.guardFail) return { ok: false, reason: R.guardFail, lightReason: R.guardFail };
      const out = { ok: true, ms: 1, short: false, guard: { dark: { alpha: R.guardAlpha, contrast: 4.32, dim: a.dim, blurPx: a.blurPx, region: { topDip: 0, heightDip: R.guardBand || 100 }, monitor: a.monitor } } };
      if (!a.light) out.lightReason = 'no light glass was given to work it out for';
      else if (R.lightFail) out.lightReason = R.lightFail;
      else out.guard.light = { alpha: Math.max(R.lightAlpha, a.light.dim), contrast: 4.9, dim: a.light.dim, blurPx: a.light.blurPx, region: { topDip: 0, heightDip: R.guardBand || 100 }, monitor: a.monitor };
      return out;
    } },
    glass: () => (R.glass && R.glass.light === undefined && R.light ? Object.assign({}, R.glass, { light: R.light }) : R.glass),
    monitor: () => R.monitor,
  });
  R.go = async (why) => { R.pub.check(why || 'test'); await R.pub.settle(); };
  R.doc = () => { const r = LS.read(dir); return r.state === 'ok' ? r.doc : null; };
  R.rec = () => { const d = R.doc(); return d ? d.desktop || null : null; };
  R.stills = () => { try { return fs.readdirSync(path.join(dir, 'stills')).filter((n) => /^wall-\d+\.jpg$/.test(n)).sort(); } catch (_) { return []; } };
  /* every state change fired onChange: the last thing onChange saw is what state() says now */
  R.inSync = (name) => check(`${name}: onChange saw the latest state`, R.states.length > 0 && J(R.states[R.states.length - 1]) === J(R.pub.state()),
    `${J(R.states[R.states.length - 1])} vs ${J(R.pub.state())}`);
  return R;
}

function picture(name, w, h, type) {
  const f = path.join(ROOT, name);
  fs.writeFileSync(f, `IMG:${w}x${h}`);
  return { id: `${type || 'picture'}:${name}`, title: name, type: type || 'picture', file: f, thumb: null, state: null, ok: true, reason: null };
}
const curOf = (item, extra) => Object.assign({ ready: true, rest: false, restReason: null, item, reason: null }, extra || {});

(async () => {
  /* ---- coverSize ---- */
  check('coverSize: 4K on 1080p -> 1920x1080', J(coverSize(3840, 2160, 1920, 1080)) === J({ w: 1920, h: 1080 }));
  check('coverSize: small picture not upscaled', J(coverSize(800, 600, 1920, 1080)) === J({ w: 800, h: 600 }));
  check('coverSize: tall picture still covers the width', J(coverSize(3000, 6000, 1920, 1080)) === J({ w: 1920, h: 3840 }));
  check('coverSize: no size -> null', coverSize(0, 10, 1920, 1080) === null);
  check('KEEP is 3', KEEP === 3);

  /* ---- picture: 4K scaled to cover the screen; Windows set to the original file ---- */
  {
    const R = rig();
    const it = picture('big.jpg', 3840, 2160);
    R.cur = curOf(it);
    await R.go('picture');
    const rec = R.rec();
    check('picture: record ok', rec && rec.ok === true && rec.reason === null, J(rec));
    check('picture: record names the wallpaper', rec && rec.id === it.id && rec.type === 'picture' && rec.title === 'big.jpg' && rec.file === it.file, J(rec));
    check('picture: still scaled to 1920x1080', rec && J(rec.stillSize) === '[1920,1080]', rec && J(rec.stillSize));
    check('picture: still is a JPEG of the scaled picture', rec && rec.still && /^JPEG 1920x1080 q90 big\.jpg>resized/.test(fs.readFileSync(rec.still, 'utf8')), rec && rec.still);
    check('picture: still in <dir>/stills named wall-<n>.jpg', rec && path.dirname(rec.still) === path.join(R.dir, 'stills') && /^wall-\d+\.jpg$/.test(path.basename(rec.still)), rec && rec.still);
    check('picture: still existed when publishDesktop was called', J(R.stillExistedAtPublish) === '[true]', J(R.stillExistedAtPublish));
    check('picture: record by mantle', rec && rec.by === 'mantle' && rec.rev === R.doc().rev, J(rec));
    check('picture: Windows set to the ORIGINAL file', J(R.winSets) === J([it.file]), J(R.winSets));
    check('picture: afterWindows called once', R.after.length === 1, J(R.after));
    const st = R.pub.state();
    check('picture: state desktop ok with the rev', st.desktop.ok === true && st.desktop.rev === rec.rev && /Shared with Helm and Quartz: "big\.jpg"/.test(st.desktop.text), J(st.desktop));
    check('picture: state windows ok', st.windows.ok === true && st.windows.reason === null, J(st.windows));
    R.inSync('picture');

    /* the same wallpaper again: no new rev, no Windows call */
    const rev = R.doc().rev, sets = R.winSets.length, n = R.states.length;
    await R.go('same again'); await R.go('same again 2');
    check('same wallpaper: no new rev', R.doc().rev === rev, `${rev} -> ${R.doc().rev}`);
    check('same wallpaper: nothing published', R.publishes.length === 1, R.publishes.length);
    check('same wallpaper: Windows not touched', R.winSets.length === sets, J(R.winSets));
    check('same wallpaper: no state churn', R.states.length === n, `${n} -> ${R.states.length}`);

    /* steady state: the still is named for its record's rev */
    const small = picture('small.png', 800, 600);
    R.cur = curOf(small);
    await R.go('another');
    const rec2 = R.rec();
    check('different wallpaper: new rev', rec2 && rec2.rev > rev && rec2.id === small.id, J(rec2));
    check('small picture: not upscaled (800x600)', rec2 && J(rec2.stillSize) === '[800,600]' && /^JPEG 800x600 q90 small\.png$/.test(fs.readFileSync(rec2.still, 'utf8')), rec2 && J(rec2.stillSize));
    check('steady state: still named wall-<record rev>.jpg', rec2 && path.basename(rec2.still) === `wall-${rec2.rev}.jpg`, `${rec2 && rec2.still} rev ${rec2 && rec2.rev}`);
    check('different picture: Windows set to its file', R.winSets[R.winSets.length - 1] === small.file && R.after.length === 2, J(R.winSets));
    R.inSync('second picture');
    R.sync.close();
  }

  /* ---- builtin ---- */
  {
    const R = rig();
    const it = picture('snow-peak.jpg', 2560, 1440, 'builtin');
    R.cur = curOf(it);
    await R.go('builtin');
    const rec = R.rec();
    check('builtin: record ok, type builtin', rec && rec.ok && rec.type === 'builtin' && rec.file === it.file, J(rec));
    check('builtin: still 1920x1080', rec && J(rec.stillSize) === '[1920,1080]', rec && J(rec.stillSize));
    check('builtin: Windows set to the original file', J(R.winSets) === J([it.file]), J(R.winSets));
    R.inSync('builtin');
    R.sync.close();
  }

  /* ---- gif: the REAL gif-frame on a real 2x1 GIF ---- */
  {
    const R = rig();
    const f = path.join(ROOT, 'tiny.gif');
    fs.writeFileSync(f, Buffer.from('R0lGODlhAgABAIAAAP8AAAAA/ywAAAAAAgABAAACAgQKADs=', 'base64'));
    R.cur = curOf({ id: 'gif:tiny', title: 'Tiny', type: 'gif', file: f, thumb: null, state: 'loading', ok: true, reason: null });
    const fc = R.frameCalls;
    await R.go('gif');
    const rec = R.rec();
    check('gif: published at once (a GIF is not waited for)', rec && rec.ok === true && rec.type === 'gif', J(rec));
    check('gif: first frame through gif-frame -> createFromBitmap 2x1', J(NI.bitmaps[NI.bitmaps.length - 1]) === J({ len: 8, w: 2, h: 1 }), J(NI.bitmaps));
    check('gif: still 2x1 (not upscaled)', rec && J(rec.stillSize) === '[2,1]', rec && J(rec.stillSize));
    check('gif: frame() not needed', R.frameCalls === fc, R.frameCalls);
    check('gif: Windows set to the STILL', J(R.winSets) === J([rec && rec.still]), J(R.winSets));
    R.inSync('gif');
    R.sync.close();
  }

  /* ---- video: waits for 'playing', uses frame() ---- */
  {
    const R = rig();
    const it = { id: 'video:waves', title: 'Waves', type: 'video', file: path.join(ROOT, 'waves.mp4'), thumb: null, state: 'loading', ok: true, reason: null };
    R.frame = { ok: true, png: 'data:fake;2560x1440', w: 2560, h: 1440 };
    R.cur = curOf(it);
    await R.go('video loading');
    check('video loading: nothing published', R.publishes.length === 0 && R.rec() === null, J(R.rec()));
    check('video loading: state says waiting', R.pub.state().desktop.ok === null && /Waiting for "Waves" to start playing/.test(R.pub.state().desktop.text), R.pub.state().desktop.text);
    R.inSync('video waiting');
    await R.go('video still loading');
    check('video still loading: still nothing', R.publishes.length === 0, R.publishes.length);
    R.cur = curOf(Object.assign({}, it, { state: 'playing' }));
    await R.go('video playing');
    const rec = R.rec();
    check('video playing: published', rec && rec.ok === true && rec.type === 'video' && rec.file === it.file, J(rec));
    check('video: frame() used', R.frameCalls === 1, R.frameCalls);
    check('video: still from the frame (2560x1440 -> 1920x1080)', rec && J(rec.stillSize) === '[1920,1080]' && /frame/.test(fs.readFileSync(rec.still, 'utf8')), rec && J(rec.stillSize));
    check('video: Windows set to the still', J(R.winSets) === J([rec && rec.still]), J(R.winSets));
    R.inSync('video');
    R.sync.close();
  }

  /* ---- video: the wait times out and what there is gets published ---- */
  {
    const R = rig({ waitMs: 60 });
    R.cur = curOf({ id: 'video:slow', title: 'Slow', type: 'video', file: path.join(ROOT, 'slow.mp4'), thumb: null, state: 'loading', ok: true, reason: null });
    await R.go('slow video');
    check('video timeout: not published before the timeout', R.publishes.length === 0, R.publishes.length);
    const t0 = Date.now();
    while (!R.rec() && Date.now() - t0 < 1500) await sleep(20);
    await R.pub.settle();
    const rec = R.rec();
    check('video timeout: published what there is after waitMs', rec && rec.ok === true && rec.id === 'video:slow', `after ${Date.now() - t0} ms: ${J(rec)}`);
    check('video timeout: state shared, not waiting', R.pub.state().desktop.ok === true, J(R.pub.state().desktop));
    const n = R.publishes.length;
    await sleep(200); await R.pub.settle();
    check('video timeout: published once, no timer loop', R.publishes.length === n && n === 1, `${n} -> ${R.publishes.length}`);
    R.inSync('video timeout');
    R.sync.close();
  }

  /* ---- web: capture used; capture rejects -> thumbnail with a note; both fail -> ok:false ---- */
  {
    const R = rig();
    const web = { id: 'web:aurora', title: 'Aurora', type: 'web', file: path.join(ROOT, 'aurora', 'index.html'), thumb: null, state: 'playing', ok: true, reason: null };
    R.capture = async () => img(1920, 1080, 'capture');
    R.cur = curOf(web);
    await R.go('web');
    const rec = R.rec();
    check('web: capture used', R.captureCalls === 1, R.captureCalls);
    check('web: record ok with the captured still', rec && rec.ok && /capture/.test(fs.readFileSync(rec.still, 'utf8')) && J(rec.stillSize) === '[1920,1080]', J(rec));
    check('web: Windows set to the still', R.winSets[R.winSets.length - 1] === (rec && rec.still), J(R.winSets));
    check('web: no note when capture worked', R.pub.state().desktop.note === null, R.pub.state().desktop.note);
    R.inSync('web');

    const thumb = path.join(ROOT, 'web-thumb.jpg'); fs.writeFileSync(thumb, 'IMG:640x360');
    R.capture = () => Promise.reject(new Error('page is gone'));
    R.cur = curOf(Object.assign({}, web, { id: 'web:thumbed', thumb }));
    await R.go('web thumb');
    const rec2 = R.rec();
    check('web capture rejects: thumbnail used', rec2 && rec2.ok && rec2.id === 'web:thumbed' && J(rec2.stillSize) === '[640,360]' && /web-thumb/.test(fs.readFileSync(rec2.still, 'utf8')), J(rec2));
    const st = R.pub.state().desktop;
    check('web capture rejects: note in state()', st.ok === true && /page is gone/.test(st.note || '') && /thumbnail/.test(st.note || '') && st.text.includes(st.note), J(st));
    R.inSync('web thumb');

    R.cur = curOf(Object.assign({}, web, { id: 'web:nothing', thumb: null }));
    await R.go('web nothing');
    const rec3 = R.rec();
    check('web both fail: ok:false record, still null', rec3 && rec3.ok === false && rec3.still === null && rec3.stillSize === null && rec3.id === 'web:nothing', J(rec3));
    check('web both fail: reason says both', rec3 && /page is gone/.test(rec3.reason) && /no thumbnail/.test(rec3.reason), rec3 && rec3.reason);
    const st3 = R.pub.state().desktop;
    check('web both fail: state ok:false with the reason', st3.ok === false && st3.reason === rec3.reason && /no picture of "Aurora"/.test(st3.text), J(st3));
    check('web both fail: no still written for it', R.stillExistedAtPublish[R.stillExistedAtPublish.length - 1] === null, J(R.stillExistedAtPublish));
    R.inSync('web both fail');
    R.sync.close();
  }

  /* ---- web waits like video ---- */
  {
    const R = rig();
    R.capture = async () => img(1920, 1080, 'capture');
    const web = { id: 'web:late', title: 'Late', type: 'web', file: path.join(ROOT, 'late.html'), thumb: null, state: 'loading', ok: true, reason: null };
    R.cur = curOf(web);
    await R.go('web loading');
    check('web loading: not published, not captured', R.publishes.length === 0 && R.captureCalls === 0, `${R.publishes.length} ${R.captureCalls}`);
    R.cur = curOf(Object.assign({}, web, { state: 'ready' }));
    await R.go('web ready');
    check('web ready: published', R.rec() && R.rec().ok && R.captureCalls === 1, J(R.rec()));
    R.sync.close();
  }

  /* ---- no wallpaper / a broken wallpaper ---- */
  {
    const R = rig();
    R.cur = { ready: true, rest: false, restReason: null, item: null, reason: 'none picked' };
    await R.go('none');
    const rec = R.rec();
    check('no wallpaper: ok:false record', rec && rec.ok === false && rec.still === null && rec.id === null, J(rec));
    check('no wallpaper: the reason', rec && /no Mantle wallpaper is chosen/.test(rec.reason) && /none picked/.test(rec.reason), rec && rec.reason);
    check('no wallpaper: state', R.pub.state().desktop.ok === false && /no Mantle wallpaper/.test(R.pub.state().desktop.text) && R.pub.state().desktop.rev === rec.rev, J(R.pub.state().desktop));
    check('no wallpaper: Windows not touched', R.winSets.length === 0 && R.winGets === 0, J(R.winSets));
    R.inSync('no wallpaper');
    const rev = R.doc().rev;
    await R.go('none again');
    check('no wallpaper again: not re-published', R.doc().rev === rev && R.publishes.length === 1, R.publishes.length);

    R.cur = curOf({ id: 'video:gone', title: 'Gone', type: 'video', file: path.join(ROOT, 'gone.mp4'), thumb: null, state: null, ok: false, reason: 'the video file is missing' });
    await R.go('broken');
    const rec2 = R.rec();
    check('item.ok false: ok:false record with its reason', rec2 && rec2.ok === false && rec2.reason === 'the video file is missing' && rec2.still === null && rec2.id === 'video:gone', J(rec2));
    check('item.ok false: not waited for, no frame asked', R.frameCalls === 0, R.frameCalls);
    check('item.ok false: state carries the reason', R.pub.state().desktop.ok === false && R.pub.state().desktop.reason === 'the video file is missing', J(R.pub.state().desktop));
    R.inSync('broken wallpaper');
    R.sync.close();
  }

  /* ---- game rest ---- */
  {
    const R = rig();
    const a = picture('rest-a.jpg', 1920, 1080);
    R.cur = curOf(a);
    await R.go('before game');
    const rev = R.doc().rev, recBefore = J(R.rec());
    R.cur = curOf(picture('rest-b.jpg', 1920, 1080), { rest: true, restReason: 'a game runs' });
    await R.go('game');
    check('rest: nothing published', R.publishes.length === 1 && R.doc().rev === rev, R.publishes.length);
    check('rest: the last record stays', J(R.rec()) === recBefore, J(R.rec()));
    check('rest: state says kept while a game runs', /kept while a game runs/.test(R.pub.state().desktop.text) && R.pub.state().desktop.ok === true, R.pub.state().desktop.text);
    R.inSync('rest');
    await R.go('game again');
    check('rest twice: text not doubled', (R.pub.state().desktop.text.match(/kept while a game runs/g) || []).length === 1, R.pub.state().desktop.text);
    R.cur = curOf(a);
    await R.go('game over');
    check('after rest, same wallpaper: not re-published', R.publishes.length === 1 && R.doc().rev === rev, R.publishes.length);
    check('after rest: the game note is gone', !/game/.test(R.pub.state().desktop.text) && R.pub.state().desktop.ok === true, R.pub.state().desktop.text);
    R.inSync('after rest');
    R.sync.close();
  }

  /* ---- stills pruned: last 3 kept, never the current one ---- */
  {
    const R = rig();
    for (let i = 1; i <= 5; i++) { R.cur = curOf(picture(`p${i}.jpg`, 1920, 1080)); await R.go(`p${i}`); }
    const left = R.stills();
    const cur = path.basename(R.rec().still);
    check('prune: only the last 3 stills kept', left.length === 3, J(left));
    check('prune: the current still is one of them', left.includes(cur), `${cur} in ${J(left)}`);
    const nums = left.map((n) => Number(/\d+/.exec(n)[0])).sort((x, y) => x - y);
    check('prune: the 3 kept are the newest', nums[2] === R.rec().rev, J(nums));

    // higher-numbered stills from elsewhere (a reset look.json) must never push the current one out
    for (const n of [900, 901, 902]) fs.writeFileSync(path.join(R.dir, 'stills', `wall-${n}.jpg`), 'old');
    fs.writeFileSync(path.join(R.dir, 'stills', 'wall-77.jpg.123.tmp'), 'junk');
    R.cur = curOf(picture('p6.jpg', 1920, 1080)); await R.go('p6');
    const cur6 = R.rec().still;
    check('prune: current still kept even when 3 higher ones exist', fs.existsSync(cur6), cur6);
    check('prune: stale temp files removed', !fs.existsSync(path.join(R.dir, 'stills', 'wall-77.jpg.123.tmp')), J(fs.readdirSync(path.join(R.dir, 'stills'))));
    R.sync.close();
  }

  /* ---- startup adoption ---- */
  {
    const dir = path.join(ROOT, 'adopt');
    const A = rig({ dir });
    const it = picture('adopt.jpg', 1920, 1080);
    A.cur = curOf(it);
    await A.go('first run');
    const rev = A.doc().rev;
    A.sync.close();

    const B = rig({ dir });
    B.win.picture = it.file;   // Windows still matches from the last run
    B.cur = curOf(it);
    await B.go('second run');
    check('adopt: not re-published', B.publishes.length === 0 && B.doc().rev === rev, `${B.publishes.length} rev ${B.doc().rev}`);
    check('adopt: state shared with the old rev', B.pub.state().desktop.ok === true && B.pub.state().desktop.rev === rev, J(B.pub.state().desktop));
    check('adopt: Windows checked, already matching, not set', B.winGets === 1 && B.winSets.length === 0 && B.pub.state().windows.ok === true, `${B.winGets} ${J(B.winSets)}`);
    B.inSync('adopt');
    await B.go('second run again');
    check('adopt: a later check of the same wallpaper stays quiet', B.publishes.length === 0, B.publishes.length);
    B.sync.close();

    // a started sync (record read from its doc, not the file) adopts too
    const S = LS.create({ app: 'mantle', dir, enabled: true });
    S.start();
    const t0 = Date.now(); while (!S.desktop().record && Date.now() - t0 < 1000) await sleep(10);
    const C = rig({ dir, sync: S });
    C.cur = curOf(it);
    await C.go('third run, started sync');
    check('adopt (started sync): not re-published', C.publishes.length === 0 && C.doc().rev === rev, C.publishes.length);
    S.close();

    fs.unlinkSync(A.rec().still);
    const D = rig({ dir });
    D.cur = curOf(it);
    await D.go('still missing');
    const rec = D.rec();
    check('adopt: still missing -> re-published', D.publishes.length === 1 && rec.rev > rev && fs.existsSync(rec.still), J(rec));
    D.sync.close();

    const E = rig({ dir });
    E.cur = curOf(picture('other.jpg', 1920, 1080));
    await E.go('different wallpaper at start');
    check('adopt: a different wallpaper at start is published', E.publishes.length === 1 && E.rec().id === 'picture:other.jpg', J(E.rec()));
    E.sync.close();
  }

  /* ---- the shared top-band darkening (desktop.guard, lane guard-mantle) ---- */
  {
    const G = rig();
    const it = picture('guard.jpg', 1920, 1272);
    G.cur = curOf(it);
    await G.go('guard: first');
    let rec = G.rec();
    const d = rec && rec.guard && rec.guard.dark;
    check('guard: the record carries guard.dark', !!d && d.alpha === 0.54 && d.contrast === 4.32 && d.dim === 0.5 && d.blurPx === 5
      && J(d.region) === J({ topDip: 0, heightDip: 100 }) && J(d.monitor) === J([1536, 864]), J(rec));
    check('guard: no guardReason beside a guard', rec.guardReason === undefined, rec.guardReason);
    const l0 = rec && rec.guard && rec.guard.light;
    check('guard.light: the record carries guard.light for the light glass', !!l0 && l0.alpha === 0.47 && l0.contrast === 4.9 && l0.dim === 0.45 && l0.blurPx === 12
      && J(l0.region) === J({ topDip: 0, heightDip: 100 }) && J(l0.monitor) === J([1536, 864]), J(rec.guard));
    check('guard.light: no guardLightReason beside it', rec.guardLightReason === undefined, rec.guardLightReason);
    check('guard.light: the computer was asked for the light glass', J(G.guardCalls[0].light) === J({ dim: 0.45, blurPx: 12 }), J(G.guardCalls[0]));
    check('guard.light: state carries the light value', J(G.pub.state().guard.light) === J({ ok: true, alpha: 0.47, contrast: 4.9, reason: null }), J(G.pub.state().guard));
    check('guard: worked out from the JPEG just written, for the glass and monitor', G.guardCalls.length === 1 && G.guardCalls[0].jpeg === true
      && G.guardCalls[0].dim === 0.5 && G.guardCalls[0].blurPx === 5 && J(G.guardCalls[0].monitor) === J([1536, 864]), J(G.guardCalls));
    check('guard: state says the value', G.pub.state().guard.ok === true && G.pub.state().guard.alpha === 0.54 && /54%/.test(G.pub.state().guard.text) && G.pub.state().guard.working === false, J(G.pub.state().guard));
    G.inSync('guard');
    const still1 = rec.still, rev1 = rec.rev, n1 = G.publishes.length, size1 = rec.stillSize;

    await G.go('guard: same glass');
    check('guard: same wallpaper + same glass -> not republished', G.publishes.length === n1 && G.guardCalls.length === 1, G.publishes.length);

    G.glass = { dim: 0.6, blurPx: 5 };
    G.guardAlpha = 0.6;
    await G.go('the dark glass changed');
    rec = G.rec();
    check('guard: a dim change republishes', G.publishes.length === n1 + 1 && rec.rev > rev1 && rec.guard.dark.dim === 0.6 && rec.guard.dark.alpha === 0.6, J(rec));
    check('guard: ... from the same still (no new still written)', rec.still === still1 && G.stills().length === 1 && G.guardCalls[1].file === still1, `${rec.still} ${J(G.stills())}`);
    check('guard: ... the rest of the record unchanged', rec.ok === true && rec.id === it.id && rec.title === it.title && J(rec.stillSize) === J(size1), J(rec));
    check('guard: ... state follows the new rev', G.pub.state().desktop.rev === rec.rev && G.pub.state().guard.alpha === 0.6, J(G.pub.state()));
    G.inSync('guard dim');

    G.glass = { dim: 0.6, blurPx: 9 };
    await G.go('the dark glass changed');
    rec = G.rec();
    check('guard: a blur change republishes', G.publishes.length === n1 + 2 && rec.guard.dark.blurPx === 9 && G.guardCalls[2].blurPx === 9, J(rec.guard));

    G.monitor = [1920, 1080];
    await G.go('display metrics changed');
    rec = G.rec();
    check('guard: a monitor change republishes', G.publishes.length === n1 + 3 && J(rec.guard.dark.monitor) === J([1920, 1080]), J(rec.guard));

    // the light glass: a light dim or a light blur change republishes (same still), dark untouched
    const darkNow = J(rec.guard.dark);
    G.light = { dim: 0.55, blurPx: 12 };
    await G.go('the glass changed');
    rec = G.rec();
    check('guard.light: a light dim change republishes', G.publishes.length === n1 + 4 && rec.guard.light.dim === 0.55 && rec.guard.light.alpha === 0.55 && J(rec.guard.dark) === darkNow, J(rec.guard));
    G.light = { dim: 0.55, blurPx: 20 };
    await G.go('the glass changed');
    rec = G.rec();
    check('guard.light: a light blur change republishes', G.publishes.length === n1 + 5 && rec.guard.light.blurPx === 20 && G.guardCalls[G.guardCalls.length - 1].light.blurPx === 20, J(rec.guard));
    await G.go('the glass changed');
    check('guard.light: the same light glass again -> not republished', G.publishes.length === n1 + 5, G.publishes.length);
    // light fails alone: the dark value still ships; no light field; guardLightReason says why; state says it
    G.lightFail = 'the light band could not be read';
    G.light = { dim: 0.5, blurPx: 20 };
    await G.go('the glass changed');
    rec = G.rec();
    check('guard.light failure: dark still shared, no light field, guardLightReason', rec.guard && rec.guard.dark && rec.guard.light === undefined && rec.guardLightReason === G.lightFail && rec.guardReason === undefined, J(rec));
    check('guard.light failure: state says why (dark ok)', G.pub.state().guard.ok === true && G.pub.state().guard.light.ok === false && G.pub.state().guard.light.reason === G.lightFail, J(G.pub.state().guard));
    G.lightFail = null;
    G.light = { dim: 0.45, blurPx: 12 };
    await G.go('the glass changed');
    rec = G.rec();
    check('guard.light: recovers at the next change (guardLightReason dropped)', rec.guard.light && rec.guard.light.dim === 0.45 && rec.guardLightReason === undefined, J(rec));

    // a guard-only republish whose write fails: said, and not retried in a loop
    G.glass = { dim: 0.5, blurPx: 5 };
    G.publishFail = 'EPERM on look.json';
    const before = G.publishes.length;
    await G.go('the dark glass changed');
    check('guard: a failed republish is said', G.pub.state().guard.ok === false && /EPERM/.test(G.pub.state().guard.reason || ''), J(G.pub.state().guard));
    await G.go('again');
    check('guard: ... and not retried until the next change', G.publishes.length === before + 1, G.publishes.length - before);
    G.publishFail = null;
    G.glass = { dim: 0.52, blurPx: 5 };
    await G.go('the dark glass changed');
    check('guard: the next change publishes again', G.rec().guard.dark.dim === 0.52 && G.pub.state().guard.ok === true, J(G.rec().guard));

    // the still is gone when the glass changes: the wallpaper is published again from scratch
    fs.unlinkSync(G.rec().still);
    G.glass = { dim: 0.56, blurPx: 5 };
    await G.go('the dark glass changed');
    rec = G.rec();
    check('guard: still gone at a glass change -> a new still + record', fs.existsSync(rec.still) && rec.guard.dark.dim === 0.56 && G.guardCalls[G.guardCalls.length - 1].jpeg === true, J(rec));
    G.sync.close();
  }
  {
    // RACE: a theme another app wrote a moment before a desktop write is APPLIED, never swallowed
    const W = rig();
    W.cur = curOf(picture('race.jpg', 1920, 1080));
    await W.go('race: first');
    const applied = [];
    W.sync.on('apply', (e) => applied.push(e.changes || {}));
    const q = LS.create({ app: 'quartz', dir: W.dir, enabled: true, retryDelays: [1, 1] });
    const qr = await q.publish('theme', 'light');
    W.glass = { dim: 0.62, blurPx: 5 };
    await W.go('the dark glass changed');   // republish lands right after Quartz's write, before any watcher
    check('race: Quartz\'s theme reached this Mantle before its desktop write', qr.ok && applied.some((c) => c.theme === 'light'), J(applied));
    check('race: ... and the file still says light, with the new guard', W.doc().look.theme.v === 'light' && W.rec().guard.dark.dim === 0.62, J(W.doc().look.theme));
    q.close(); W.sync.close();
  }
  {
    // FAILURE: no guard field, guardReason, state says why; the wallpaper itself is still shared
    const F = rig();
    F.guardFail = 'the still\'s top band could not be read as pixels';
    F.cur = curOf(picture('fail.jpg', 1920, 1080));
    await F.go('guard fails');
    const rec = F.rec();
    check('guard failure: no guard field', rec.guard === undefined, J(rec.guard));
    check('guard failure: guardReason says why', rec.guardReason === F.guardFail, rec.guardReason);
    check('guard failure: guardLightReason too (no light field either)', rec.guardLightReason === F.guardFail, rec.guardLightReason);
    check('guard failure: the wallpaper is still shared', rec.ok === true && fs.existsSync(rec.still), J(rec));
    check('guard failure: state says why', F.pub.state().guard.ok === false && F.pub.state().guard.reason === F.guardFail && /not shared/.test(F.pub.state().guard.text), J(F.pub.state().guard));
    F.inSync('guard failure');
    F.sync.close();

    const T = rig();
    T.guardThrow = true;
    T.cur = curOf(picture('throw.jpg', 1920, 1080));
    await T.go('guard throws');
    check('guard throws: guardReason carries the error', T.rec().guard === undefined && /boom/.test(T.rec().guardReason || ''), T.rec().guardReason);
    T.sync.close();

    const N = rig({ noGuard: true });
    N.cur = curOf(picture('noguard.jpg', 1920, 1080));
    await N.go('no computer');
    check('guard: no computer -> guardReason', /no way to work it out/.test(N.rec().guardReason || ''), N.rec().guardReason);
    N.sync.close();

    const Z = rig();
    Z.cur = { ready: true, rest: false, item: null, reason: 'none picked' };
    await Z.go('no wallpaper');
    check('guard: no wallpaper -> guardReason, no guard', Z.rec().guard === undefined && /no Mantle wallpaper/.test(Z.rec().guardReason || ''), J(Z.rec()));
    check('guard.light: no wallpaper -> guardLightReason', /no Mantle wallpaper/.test(Z.rec().guardLightReason || ''), J(Z.rec()));
    Z.sync.close();
  }
  {
    // a record from before the shared darkening (no guard) is adopted, then worked out again at start
    const dir = path.join(ROOT, 'adopt-old');
    const A = rig({ dir, noGuard: true });
    const it = picture('old.jpg', 1920, 1080);
    A.cur = curOf(it);
    await A.go('old Mantle');
    const old = A.rec();
    A.sync.close();
    const B = rig({ dir });
    B.win.picture = it.file;
    B.cur = curOf(it);
    await B.go('new Mantle starts');
    const rec = B.rec();
    check('adopt old record: republished once with a guard', B.publishes.length === 1 && rec.rev > old.rev && rec.guard && rec.guard.dark.alpha === 0.54 && rec.guardReason === undefined, J(rec));
    check('adopt old record: from the same still', rec.still === old.still && B.guardCalls.length === 1 && B.guardCalls[0].file === old.still, J(B.guardCalls));
    await B.go('again');
    check('adopt old record: then quiet', B.publishes.length === 1, B.publishes.length);
    B.sync.close();

    // adopted with a guard for another dim: worked out again
    const C = rig({ dir });
    C.win.picture = it.file;
    C.cur = curOf(it);
    C.glass = { dim: 0.7, blurPx: 5 };
    await C.go('started with another dim');
    check('adopt: a guard for another dim is worked out again', C.publishes.length === 1 && C.rec().guard.dark.dim === 0.7, J(C.rec().guard));
    C.sync.close();

    // adopted with a guard worked out over the OLD 144 DIP band (live 2026-10-10 kept snow-peak at .54 so): worked out again
    const D1 = rig({ dir });
    D1.win.picture = it.file; D1.cur = curOf(it); D1.glass = { dim: 0.6, blurPx: 5 }; D1.guardBand = 144;
    await D1.go('a record over the old band');
    const oldBand = D1.rec() && D1.rec().guard && D1.rec().guard.dark.region.heightDip;
    D1.sync.close();
    const D = rig({ dir });
    D.win.picture = it.file; D.cur = curOf(it); D.glass = { dim: 0.6, blurPx: 5 };
    await D.go('started after the band change');
    check('adopt: a guard over the old 144 DIP band is worked out again at 100', oldBand === 144 && D.publishes.length === 1 && D.rec().guard.dark.region.heightDip === 100, J([oldBand, D.publishes.length, D.rec() && D.rec().guard]));
    D.sync.close();
  }

  /* ---- Windows' wallpaper ---- */
  {
    const R = rig();
    const it = picture('match.jpg', 1920, 1080);
    R.win.picture = it.file.toUpperCase(); R.win.fit = 'fill';
    R.cur = curOf(it);
    await R.go('already matching');
    check('windows matching (case-insensitive path, fill): set not called', R.winSets.length === 0 && R.winGets === 1, J(R.winSets));
    check('windows matching: state ok', R.pub.state().windows.ok === true, J(R.pub.state().windows));
    check('windows matching: no afterWindows', R.after.length === 0, J(R.after));
    R.sync.close();

    const F = rig();
    const it2 = picture('fit.jpg', 1920, 1080);
    F.win.picture = it2.file; F.win.fit = 'center';
    F.cur = curOf(it2);
    await F.go('wrong fit');
    check('windows right file, wrong fit: set called', J(F.winSets) === J([it2.file]), J(F.winSets));
    F.sync.close();

    const X = rig();
    X.winFail = 'the sidecar is not running';
    X.cur = curOf(picture('fail.jpg', 1920, 1080));
    await X.go('set fails');
    const w = X.pub.state().windows;
    check('windows set fails: ok:false with the reason', w.ok === false && w.reason === 'the sidecar is not running' && /not changed/.test(w.text), J(w));
    check('windows set fails: desktop still shared', X.pub.state().desktop.ok === true, J(X.pub.state().desktop));
    check('windows set fails: no afterWindows', X.after.length === 0, J(X.after));
    X.inSync('windows fails');
    X.winFail = null;
    X.cur = curOf(picture('fail2.jpg', 1920, 1080));
    await X.go('set works again');
    check('windows set works next change: ok, afterWindows once', X.pub.state().windows.ok === true && X.after.length === 1, J(X.after));
    X.sync.close();

    const T = rig({ test: true });
    T.cur = curOf(picture('test.jpg', 1920, 1080));
    await T.go('test run');
    check('test run: Windows never called', T.winGets === 0 && T.winSets.length === 0 && T.after.length === 0, `${T.winGets} ${J(T.winSets)}`);
    check('test run: text says test run', /Test run/.test(T.pub.state().windows.text) && T.pub.state().windows.ok === null, J(T.pub.state().windows));
    check('test run: desktop still published', T.rec() && T.rec().ok === true, J(T.rec()));
    T.inSync('test run');
    T.sync.close();

    /* ---- the lock screen follows the wallpaper (lane mantle-rim, 2026-10-10) ---- */
    const K = rig();
    const kp = picture('lock-a.jpg', 1920, 1080);
    K.cur = curOf(kp);
    await K.go('lock: a picture');
    check('lock: set to the picture file itself, once', J(K.lockSets) === J([kp.file]) && K.lockGets === 1, J([K.lockGets, K.lockSets]));
    check('lock: status ok, says it matches', K.pub.state().lock.ok === true && /lock screen matches/.test(K.pub.state().lock.text), J(K.pub.state().lock));
    K.inSync('lock: a picture');
    const kw = picture('lock-b.webp', 1920, 1080);
    K.cur = curOf(kw);
    await K.go('lock: a webp');
    const krec = K.rec();
    check('lock: a picture the lock screen cannot show (.webp) -> the still', K.lockSets.length === 2 && K.lockSets[1] === (krec && krec.still) && /\.jpg$/i.test(K.lockSets[1] || ''), J(K.lockSets));
    K.lockFail = 'Read only: the lock screen picture needs Windows 10 or later';
    K.cur = curOf(picture('lock-c.jpg', 1920, 1080));
    await K.go('lock: fails');
    check('lock: a failure is a status WITH its reason', K.pub.state().lock.ok === false && K.pub.state().lock.reason === K.lockFail && /not changed/.test(K.pub.state().lock.text), J(K.pub.state().lock));
    check('lock: a failure is logged', K.logs.some((l) => /lock screen was not changed: Read only/.test(l)), J(K.logs.slice(-3)));
    check('lock: Windows\' wallpaper still matched despite it', K.pub.state().windows.ok === true, J(K.pub.state().windows));
    K.inSync('lock: fails');
    K.lockFail = null; K.lockThrow = true;
    K.cur = curOf(picture('lock-d.jpg', 1920, 1080));
    await K.go('lock: throws');
    check('lock: a thrown error becomes the reason', K.pub.state().lock.ok === false && /Read only: this sidecar/.test(K.pub.state().lock.reason || ''), J(K.pub.state().lock));
    K.lockThrow = false;
    K.sync.close();
    const K2 = rig();
    const kq = picture('lock-same.jpg', 1920, 1080);
    K2.lock.picture = kq.file.toUpperCase();
    K2.cur = curOf(kq);
    await K2.go('lock: already showing it');
    check('lock: already showing that picture (case-insensitive) -> not set again', K2.lockGets === 1 && K2.lockSets.length === 0 && K2.pub.state().lock.ok === true, J([K2.lockGets, K2.lockSets]));
    K2.sync.close();
    const KT = rig({ test: true });
    KT.cur = curOf(picture('lock-test.jpg', 1920, 1080));
    await KT.go('lock: test run');
    check('lock: a TEST RUN never touches the lock screen', KT.lockGets === 0 && KT.lockSets.length === 0, J([KT.lockGets, KT.lockSets]));
    check('lock: test run status says so', KT.pub.state().lock.ok === null && /Test run/.test(KT.pub.state().lock.text), J(KT.pub.state().lock));
    KT.sync.close();
    const KN = rig({ noLock: true });
    KN.cur = curOf(picture('lock-none.jpg', 1920, 1080));
    await KN.go('lock: no way to reach it');
    check('lock: no lock route -> a status with the reason', KN.pub.state().lock.ok === false && /no way to reach the lock screen/.test(KN.pub.state().lock.reason || ''), J(KN.pub.state().lock));
    KN.sync.close();

    const N = rig({ noWindows: true });
    N.cur = curOf(picture('nosidecar.jpg', 1920, 1080));
    await N.go('no sidecar');
    check('no windows object: ok:false with a reason', N.pub.state().windows.ok === false && /no sidecar/.test(N.pub.state().windows.reason), J(N.pub.state().windows));
    N.sync.close();
  }

  /* ---- the shared file cannot be written ---- */
  {
    const R = rig();
    R.publishFail = 'disk full';
    R.cur = curOf(picture('nowrite.jpg', 1920, 1080));
    await R.go('publish fails');
    const st = R.pub.state().desktop;
    check('publishDesktop fails: state ok:false with the reason', st.ok === false && st.reason === 'disk full' && /could not be written/.test(st.text), J(st));
    check('publishDesktop fails: Windows not touched', R.winSets.length === 0, J(R.winSets));
    R.inSync('publish fails');
    R.publishFail = null;
    await R.go('next change');
    check('publishDesktop fails: the next check tries again and works', R.rec() && R.rec().ok === true && R.pub.state().desktop.ok === true, J(R.pub.state().desktop));
    R.sync.close();

    // the folder itself is a FILE: the still and the record both fail, with the reason
    const blocker = path.join(ROOT, 'blocked');
    fs.writeFileSync(blocker, 'not a folder');
    const B = rig({ dir: blocker });
    B.cur = curOf(picture('blocked.jpg', 1920, 1080));
    await B.go('unwritable folder');
    const sb = B.pub.state().desktop;
    check('unwritable folder: state ok:false with a reason', sb.ok === false && typeof sb.reason === 'string' && sb.reason.length > 0, J(sb));
    check('unwritable folder: never threw, no record', B.rec() === null && fs.readFileSync(blocker, 'utf8') === 'not a folder', J(sb));
    B.inSync('unwritable folder');
    B.sync.close();
  }

  /* ---- a throwing current() / frame never throws out ---- */
  {
    const R = rig();
    R.cur = null;
    let threw = false;
    try { await R.go('null current'); } catch (_) { threw = true; }
    check('current() null: no throw, nothing published', !threw && R.publishes.length === 0);
    R.cur = { ready: false };
    await R.go('not ready');
    check('current() not ready: nothing published', R.publishes.length === 0);
    R.frame = { ok: false, reason: 'the page is asleep' };
    R.cur = curOf({ id: 'video:nf', title: 'NF', type: 'video', file: path.join(ROOT, 'nf.mp4'), thumb: null, state: 'playing', ok: true, reason: null });
    await R.go('frame fails');
    check('video frame fails, no thumbnail: ok:false with the reason', R.rec() && R.rec().ok === false && /the page is asleep/.test(R.rec().reason), J(R.rec()));
    R.sync.close();
  }

  /* ---- the real store was never touched ---- */
  check('real %APPDATA%\\look-sync: existence unchanged', fs.existsSync(REAL) === REAL_EXISTED, REAL);
  const after = snapshot(REAL);
  const added = Object.keys(after).filter((f) => !(f in REAL_BEFORE));
  check('real %APPDATA%\\look-sync: no files created', added.length === 0, J(added));
  let realDoc = null; try { realDoc = JSON.parse(fs.readFileSync(path.join(REAL, 'look.json'), 'utf8')); } catch (_) { /* none */ }
  check('real look.json: never written by this test', !realDoc || !realDoc.writer || realDoc.writer.pid !== process.pid, J(realDoc && realDoc.writer));
})().catch((err) => {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
}).finally(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* temp */ }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`LOOK DESKTOP TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
