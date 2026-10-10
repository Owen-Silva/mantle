'use strict';
/*
 * look-desktop.js -- Mantle PUBLISHES the desktop wallpaper to Helm and Quartz, and makes Windows' own
 * wallpaper the same picture (lane looksync-mantle, 2026-10-10; spec ~/look-sync/CONTRACT.md section 4
 * and "Owen's answers").
 *
 * Owen: "the plan is the windows wallpaper is set and quartz and helm are just see through straight to
 * that". Mantle owns the desktop, so on every wallpaper change it:
 *   1. writes a STILL of it to %APPDATA%\look-sync\stills\wall-<rev>.jpg (FIRST, so the record never
 *      points at a file that is not there), the last 3 kept:
 *        picture / builtin  the picture itself as a JPEG, scaled down to cover the screen at most
 *        gif                its FIRST frame (lib/gif-frame.js; nativeImage cannot read a GIF)
 *        video              the frame on screen now, at full scale (lib/wall-still.js frame())
 *        web                the desktop page's capturePage(), else the package's thumbnail, else
 *                           ok:false with the reason
 *   2. publishes look.json `desktop` (lib/look-sync.js publishDesktop), even while look sync is OFF;
 *   3. sets WINDOWS' wallpaper to the same picture (a picture or built-in photo: its own file; anything
 *      else: the still), fit Fill like Mantle's cover, through the sidecar's IDesktopWallpaper
 *      (perso.set, sidecar/SysPerso.cs), then has the desktop layer re-check that it is still in front
 *      of the wallpaper. A test run never touches Windows.
 * Once per change, never on a timer: a video or web wallpaper is waited for (one timeout per change)
 * until the desktop page says it plays. While a game rests Mantle (wallpaper unloaded) nothing is
 * published, so the last record stays. Every outcome is in state() for Mantle Settings: no silent
 * failures, and a fallback says it is one.
 *
 * makeDesktopPublisher(o):
 *   o.sync          the look-sync instance (publishDesktop, desktop(), dir)
 *   o.LS            lib/look-sync.js (read)
 *   o.current()     lib/wallpaper.js current()
 *   o.screen()      {w, h} physical pixels of the primary display (the desktop layer's display)
 *   o.nativeImage   electron's nativeImage (tests: a fake with the same few methods)
 *   o.gifFrame(buf) lib/gif-frame.js firstFrame
 *   o.frame()       wall-still frame()  -> {ok, png, w, h} | {ok:false, reason, wait?}
 *   o.capture()     Promise<nativeImage> of the desktop page (capturePage), may reject
 *   o.windows       { get() -> Promise<{ok, picture, fit, reason}>, set(file) -> Promise<{ok, reason}> } | null
 *   o.afterWindows(why)  the desktop layer's in-front re-check after Windows' wallpaper changed
 *   o.test          true in a --test run: Windows' wallpaper is never changed
 *   o.waitMs        how long a video / web wallpaper is waited for before publishing what there is (20 s)
 *   o.onChange(st)  after every state change
 *   o.log(line)
 * -> { check(why), state(), settle() }   Never throws.
 */
const fs = require('fs');
const path = require('path');

const KEEP = 3;
const JPEG_Q = 90;
const WIN_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.webp']);
const TYPE_WORDS = { builtin: 'built-in photo', picture: 'picture', gif: 'GIF', video: 'video', web: 'web wallpaper' };

function words(e) { return e && e.message ? e.message : String(e); }
const samePath = (a, b) => !!a && !!b && path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

/** The size that still covers a w x h screen, never bigger than the picture (cover fit, at most the screen). */
function coverSize(iw, ih, sw, sh) {
  if (!(iw > 0 && ih > 0)) return null;
  if (!(sw > 0 && sh > 0)) return { w: iw, h: ih };
  const s = Math.min(1, Math.max(sw / iw, sh / ih));
  return { w: Math.max(1, Math.round(iw * s)), h: Math.max(1, Math.round(ih * s)) };
}

function stillRev(name) { const m = /^wall-(\d+)\.jpg$/i.exec(name); return m ? Number(m[1]) : null; }

function makeDesktopPublisher(o) {
  const say = (l) => { try { o.log(l); } catch (_) { /* a log line is never worth a failure */ } };
  const waitMs = o.waitMs > 0 ? o.waitMs : 20000;
  const stillsDir = path.join(o.sync.dir, 'stills');
  const st = {
    desktop: { ok: null, text: 'Not shared yet: Mantle is reading its wallpaper', reason: null, rev: null, id: null, title: null, type: null, note: null },
    windows: { ok: null, text: o.test ? 'Test run: Windows\' wallpaper is left alone' : 'Not checked yet', reason: null },
  };
  let lastKey = null;        // the wallpaper last published (or adopted at start)
  let started = false;
  let running = null;        // the publish in flight
  let again = null;          // a check asked for while one ran
  let waitTimer = null, waitKey = null;
  let windowsDoneKey = null; // the still / file Windows was last matched to

  function changed() { try { if (o.onChange) o.onChange(state()); } catch (e) { say(`a look listener threw: ${words(e)}`); } }
  function state() { return { desktop: Object.assign({}, st.desktop), windows: Object.assign({}, st.windows) }; }
  function keyOf(cur) {
    if (!cur || !cur.ready) return null;
    if (!cur.item) return 'none';
    const i = cur.item;
    return [i.id, i.type, i.file || '', i.ok ? 'ok' : 'bad'].join('|');
  }

  /* ---- the still -------------------------------------------------------- */

  function fromImage(img, why) {
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return { ok: false, reason: why || 'the picture decoded empty' };
    const sz = img.getSize();
    let scr = null;
    try { scr = o.screen(); } catch (_) { scr = null; }
    const c = coverSize(sz.width, sz.height, scr && scr.w, scr && scr.h);
    if (!c) return { ok: false, reason: 'the picture has no size' };
    const out = c.w !== sz.width || c.h !== sz.height ? img.resize({ width: c.w, height: c.h, quality: 'best' }) : img;
    const jpeg = out.toJPEG(JPEG_Q);
    if (!jpeg || !jpeg.length) return { ok: false, reason: 'the picture would not encode as a JPEG' };
    return { ok: true, jpeg, w: c.w, h: c.h };
  }
  function fromFile(file, what) {
    if (!file) return { ok: false, reason: `the ${what} has no file` };
    if (!fs.existsSync(file)) return { ok: false, reason: `the ${what}'s file is missing` };
    let img;
    try { img = o.nativeImage.createFromPath(file); } catch (e) { return { ok: false, reason: `the ${what} could not be read: ${words(e)}` }; }
    return fromImage(img, `the ${what} could not be decoded (Mantle reads JPEG and PNG pictures directly)`);
  }
  async function fromFrame(what) {
    let r;
    try { r = await o.frame(); } catch (e) { r = { ok: false, reason: words(e) }; }
    if (!r || !r.ok) return { ok: false, reason: `the desktop could not hand over the ${what}'s frame: ${(r && r.reason) || 'no reason came back'}` };
    let img;
    try { img = o.nativeImage.createFromDataURL(r.png); } catch (e) { return { ok: false, reason: `the ${what}'s frame would not decode: ${words(e)}` }; }
    return fromImage(img, `the ${what}'s frame decoded empty`);
  }
  async function fromGif(file) {
    let buf;
    try { buf = await fs.promises.readFile(file); } catch (e) { return { ok: false, reason: `the GIF could not be read (${e.code || words(e)})` }; }
    const f = o.gifFrame(buf);
    if (!f || !f.ok) return { ok: false, reason: `the GIF's first frame could not be decoded: ${(f && f.reason) || 'no reason came back'}` };
    let img;
    try { img = o.nativeImage.createFromBitmap(f.bgra, { width: f.w, height: f.h }); } catch (e) { return { ok: false, reason: `the GIF's first frame would not convert: ${words(e)}` }; }
    return fromImage(img, 'the GIF\'s first frame converted empty');
  }
  async function fromCapture() {
    let img;
    try { img = await o.capture(); } catch (e) { return { ok: false, reason: `the desktop page could not be photographed: ${words(e)}` }; }
    return fromImage(img, 'the desktop page photographed empty');
  }

  /** -> {ok, jpeg, w, h, note} | {ok:false, reason} */
  async function makeStill(item) {
    const t = item.type;
    if (t === 'builtin' || t === 'picture') {
      const a = fromFile(item.file, TYPE_WORDS[t]);
      if (a.ok) return a;
      const b = await fromFrame(TYPE_WORDS[t]);
      if (b.ok) return Object.assign(b, { note: `the picture itself could not be used (${a.reason}), so the desktop's drawing of it was` });
      return { ok: false, reason: `${a.reason}; ${b.reason}` };
    }
    if (t === 'gif') {
      const a = await fromGif(item.file);
      if (a.ok) return a;
      const b = await fromFrame('GIF');
      if (b.ok) return Object.assign(b, { note: `${a.reason}, so the frame on screen was used` });
      return { ok: false, reason: `${a.reason}; ${b.reason}` };
    }
    if (t === 'video') {
      const a = await fromFrame('video');
      if (a.ok) return a;
      const b = item.thumb ? fromFile(item.thumb, 'video\'s thumbnail') : { ok: false, reason: 'it has no thumbnail' };
      if (b.ok) return Object.assign(b, { note: `${a.reason}, so its thumbnail was used` });
      return { ok: false, reason: `${a.reason}; ${b.reason}` };
    }
    if (t === 'web') {
      const a = await fromCapture();
      if (a.ok) return a;
      const b = item.thumb ? fromFile(item.thumb, 'package\'s thumbnail') : { ok: false, reason: 'the package has no thumbnail' };
      if (b.ok) return Object.assign(b, { note: `${a.reason}, so the package's thumbnail was used` });
      return { ok: false, reason: `${a.reason}; ${b.reason}` };
    }
    return { ok: false, reason: `Mantle does not know the wallpaper type "${t}"` };
  }

  async function writeStill(jpeg) {
    // the record's rev will be the doc's + 1; a missing / damaged file is re-made first (one more rev)
    let next = 2;
    try { const r = o.LS.read(o.sync.dir); if (r && r.state === 'ok' && r.doc && Number.isInteger(r.doc.rev)) next = r.doc.rev + 1; } catch (_) { /* 2 */ }
    const name = `wall-${next}.jpg`;
    const file = path.join(stillsDir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(stillsDir, { recursive: true });
      await fs.promises.writeFile(tmp, jpeg);
      await fs.promises.rename(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* never made */ }
      return { ok: false, reason: `the still could not be saved in ${stillsDir} (${e.code || words(e)})` };
    }
    return { ok: true, file };
  }

  function prune(keepFile) {
    let names = [];
    try { names = fs.readdirSync(stillsDir); } catch (_) { return; }
    const stills = names.map((n) => ({ n, r: stillRev(n) })).filter((x) => x.r !== null).sort((a, b) => b.r - a.r);
    for (const x of stills.slice(KEEP)) {
      const f = path.join(stillsDir, x.n);
      if (keepFile && samePath(f, keepFile)) continue;
      try { fs.unlinkSync(f); } catch (e) { say(`an old still could not be removed (${e.code || words(e)})`); }
    }
    for (const n of names) if (/\.tmp$/i.test(n)) { try { fs.unlinkSync(path.join(stillsDir, n)); } catch (_) { /* in use */ } }
  }

  /* ---- Windows' own wallpaper ------------------------------------------- */

  async function matchWindows(target, label) {
    if (!target) return;
    if (o.test) { st.windows = { ok: null, text: 'Test run: Windows\' wallpaper is left alone', reason: null }; return; }
    if (!o.windows) { st.windows = { ok: false, text: 'Windows\' wallpaper was not changed', reason: 'this Mantle has no way to reach Windows\' wallpaper (no sidecar)' }; return; }
    if (windowsDoneKey && samePath(windowsDoneKey, target)) return;
    let cur = null;
    try { cur = await o.windows.get(); } catch (e) { cur = { ok: false, reason: words(e) }; }
    if (cur && cur.ok && samePath(cur.picture, target) && (!cur.fit || cur.fit === 'fill')) {
      windowsDoneKey = target;
      st.windows = { ok: true, text: 'Windows\' wallpaper matches', reason: null };
      return;
    }
    let r;
    try { r = await o.windows.set(target); } catch (e) { r = { ok: false, reason: words(e) }; }
    if (!r || !r.ok) {
      st.windows = { ok: false, text: 'Windows\' wallpaper was not changed', reason: (r && r.reason) || 'Windows gave no reason' };
      say(`Windows' wallpaper was not changed: ${st.windows.reason}`);
      return;
    }
    windowsDoneKey = target;
    st.windows = { ok: true, text: r.note ? `Windows' wallpaper matches (${r.note})` : 'Windows\' wallpaper matches', reason: null };
    say(`Windows' wallpaper now matches ${label}`);
    try { if (o.afterWindows) o.afterWindows(`Windows' wallpaper changed to match ${label}`); } catch (e) { say(`the desktop layer re-check threw: ${words(e)}`); }
  }

  /* ---- one publish -------------------------------------------------------- */

  async function publish(cur, key) {
    const t0 = Date.now();
    if (!cur.item) {
      const reason = `no Mantle wallpaper is chosen, so the desktop shows Windows' own wallpaper (${cur.reason || 'none picked'})`;
      const r = await o.sync.publishDesktop({ ok: false, reason, id: null, type: null, title: null, file: null, still: null, stillSize: null });
      st.desktop = { ok: false, text: 'Not shared: no Mantle wallpaper is chosen', reason, rev: r.ok ? r.rev : null, id: null, title: null, type: null, note: null };
      if (!r.ok) st.desktop.reason = `${reason}; the record could not be written either: ${r.reason}`;
      lastKey = r.ok ? key : null;
      return;
    }
    const it = cur.item;
    const base = { id: it.id, type: it.type, title: it.title, file: it.file || null };
    let s = it.ok ? await makeStill(it) : { ok: false, reason: it.reason || 'the wallpaper cannot play' };
    let w = null;
    if (s.ok) {
      w = await writeStill(s.jpeg);
      if (!w.ok) s = { ok: false, reason: w.reason };
    }
    const rec = s.ok
      ? Object.assign(base, { ok: true, reason: null, still: w.file, stillSize: [s.w, s.h] })
      : Object.assign(base, { ok: false, reason: s.reason, still: null, stillSize: null });
    const r = await o.sync.publishDesktop(rec);
    const quoted = `"${it.title}"`;
    if (!r.ok) {
      st.desktop = { ok: false, text: `Not shared: ${quoted} could not be written to the shared look file`, reason: r.reason, rev: null, id: it.id, title: it.title, type: it.type, note: null };
      lastKey = null;   // tried again at the next change
      say(`the desktop record could not be written: ${r.reason}`);
      return;
    }
    lastKey = key;
    if (s.ok) {
      st.desktop = { ok: true, text: `Shared with Helm and Quartz: ${quoted} (rev ${r.rev})`, reason: null, rev: r.rev, id: it.id, title: it.title, type: it.type, note: s.note || null };
      if (s.note) st.desktop.text += `; ${s.note}`;
      say(`shared the desktop wallpaper: ${it.type} ${it.id}, still ${s.w}x${s.h} (rev ${r.rev}, ${Date.now() - t0} ms)${s.note ? `; ${s.note}` : ''}`);
      prune(w.file);
      const own = (it.type === 'builtin' || it.type === 'picture') && it.file && WIN_EXT.has(path.extname(it.file).toLowerCase());
      await matchWindows(own ? it.file : w.file, quoted);
    } else {
      st.desktop = { ok: false, text: `Not shared: Mantle has no picture of ${quoted}`, reason: s.reason, rev: r.rev, id: it.id, title: it.title, type: it.type, note: null };
      say(`the desktop wallpaper has no still (${it.type} ${it.id}): ${s.reason}`);
    }
  }

  /** At start: the record Mantle wrote last time still describes this wallpaper (and its still is there). */
  function adoptable(cur) {
    if (!cur.item) return false;
    let rec = null;
    try { rec = o.sync.desktop().record; } catch (_) { rec = null; }
    if (!rec) {
      try { const r = o.LS.read(o.sync.dir); rec = r && r.doc ? r.doc.desktop || null : null; } catch (_) { rec = null; }
    }
    if (!rec || !rec.ok || rec.id !== cur.item.id || rec.type !== cur.item.type || (rec.file || null) !== (cur.item.file || null)) return false;
    if (!rec.still || !fs.existsSync(rec.still)) return false;
    st.desktop = { ok: true, text: `Shared with Helm and Quartz: "${cur.item.title}" (rev ${rec.rev})`, reason: null, rev: rec.rev, id: rec.id, title: rec.title, type: rec.type, note: null };
    return rec;
  }

  async function run(why) {
    const cur = (() => { try { return o.current(); } catch (e) { return { ready: false, reason: words(e) }; } })();
    if (!cur || !cur.ready) return;
    if (cur.rest) {
      // a game unloaded the wallpaper: the last record stays true (contract section 4)
      if (st.desktop.ok && !/while a game/.test(st.desktop.text)) { st.desktop = Object.assign({}, st.desktop, { text: `${st.desktop.text}; kept while a game runs` }); changed(); }
      return;
    }
    const key = keyOf(cur);
    if (key === lastKey) {
      if (/; kept while a game runs$/.test(st.desktop.text || '')) { st.desktop.text = st.desktop.text.replace(/; kept while a game runs$/, ''); changed(); }
      return;
    }
    if (!started) {
      started = true;
      const rec = adoptable(cur);
      if (rec) {
        lastKey = key;
        say(`the desktop record from Mantle's last run still holds (${rec.type} ${rec.id}, rev ${rec.rev})`);
        const own = (rec.type === 'builtin' || rec.type === 'picture') && rec.file && WIN_EXT.has(path.extname(rec.file).toLowerCase());
        await matchWindows(own ? rec.file : rec.still, `"${rec.title}"`);
        changed();
        return;
      }
    }
    const it = cur.item;
    const drawn = !it || !it.ok || it.type === 'builtin' || it.type === 'picture' || it.type === 'gif' || it.state === 'playing' || it.state === 'ready' || it.state === 'error';
    if (!drawn) {
      // (the late re-check carries `${key}|late`: it must fall through to publish, not start a new wait)
      if (waitKey !== key && waitKey !== `${key}|late`) {
        clearTimeout(waitTimer);
        waitKey = key;
        st.desktop = { ok: null, text: `Waiting for "${it.title}" to start playing before sharing it`, reason: null, rev: st.desktop.rev, id: it.id, title: it.title, type: it.type, note: null };
        changed();
        waitTimer = setTimeout(() => { waitTimer = null; if (waitKey === key) { waitKey = `${key}|late`; check('the wallpaper took too long to start; sharing what there is'); } }, waitMs);
        if (waitTimer.unref) waitTimer.unref();
      }
      if (waitKey !== `${key}|late`) return;
    }
    clearTimeout(waitTimer); waitTimer = null; waitKey = null;
    await publish(cur, key);
    changed();
    void why;
  }

  /** Call on every wallpaper / State change (cheap when nothing changed). Never throws. */
  function check(why) {
    if (running) { again = why || 'again'; return running; }
    running = run(why).catch((e) => {
      st.desktop = Object.assign({}, st.desktop, { ok: false, text: 'Not shared: publishing the wallpaper failed', reason: words(e) });
      say(`publishing the desktop wallpaper threw: ${e && e.stack ? e.stack : e}`);
      changed();
    }).finally(() => {
      running = null;
      if (again) { const w = again; again = null; check(w); }
    });
    return running;
  }

  return {
    check,
    state,
    /** Tests: resolves once nothing is running or queued. */
    async settle() { while (running) { await running; await new Promise((r) => setTimeout(r, 0)); } },
  };
}

module.exports = { makeDesktopPublisher, coverSize, KEEP };
