'use strict';
/*
 * _clips-fake.js - a FAKE sidecar recorder for a --test Mantle (lane mantle-clips2, 2026-10-15).
 *
 * INCIDENT RULE (part 1 recorded ~8 s of Owen's Helm window by accident): the page and e2e tests never
 * send a real Win+Alt+R. A --test Mantle started with MANTLE_CLIPS_FAKE=1 and MANTLE_CLIPS_DIR=<a temp
 * folder> answers the recorder's sidecar calls here instead:
 *   gaming.get / gaming.set     the folder is MANTLE_CLIPS_DIR, the mic a plain switch
 *   record.target               a stand-in window "Mantle stand-in" (set() changes it: quns, a game)
 *   record.keys                 starts / stops a FAKE recording: a file "Mantle stand-in <time>.mp4"
 *                               appears startMs later in the folder and grows every 300 ms until the
 *                               next record.keys, exactly what main watches for Windows' recorder
 *   files.thumbs                a stand-in picture (a PNG made here), never a shell thumbnail
 *   files.clip.set, clips.share answered ok, nothing reaches the clipboard or the share broker
 *   files.op recycle / files.recycle.restore   moved to and from <folder>\.bin, with files.opdone
 * Everything else (clips.reencode: the REAL encoder, which a passive sidecar runs only under %TEMP%)
 * goes to the real sidecar. clips.js refuses to load this outside --test, and refuses a folder that is
 * not under %TEMP%.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/* ---- a tiny PNG encoder (RGB, no filter), for stand-in thumbnails ---- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function standInPng(seed, w, h) {
  const W = w || 320, H = h || 180;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const hue = (seed * 47) % 360;
  const rgb = (hh, s, l) => { const k = (n) => (n + hh / 30) % 12; const a = s * Math.min(l, 1 - l); return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))); };
  const c0 = rgb(hue, 0.35, 0.42), c1 = rgb((hue + 40) % 360, 0.30, 0.70);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const t = Math.min(1, Math.max(0, (x / W) * 0.7 + (y / H) * 0.3));
      const horizon = y > H * 0.62 ? 0.82 : 1;           // a calm "scene": sky, ground
      const sun = Math.hypot(x - W * 0.72, y - H * 0.34) < H * 0.12 ? 1.18 : 1;
      const i = y * (W * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[i + k] = Math.max(0, Math.min(255, Math.round((c0[k] + (c1[k] - c0[k]) * t) * horizon * sun)));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function underTemp(p) {
  const t = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
  return path.resolve(String(p || '')).toLowerCase().startsWith(t);
}
function stamp(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`; }

function make(o) {
  const dir = o.dir;
  if (!dir || !underTemp(dir)) throw new Error(`the fake recorder's folder must be under %TEMP% (${dir})`);
  fs.mkdirSync(dir, { recursive: true });
  const real = o.real || null;
  const subs = new Map();
  const T = {
    target: { hwnd: '4242', pid: process.pid, exe: 'C:\\Mantle\\stand-in\\standin.exe', title: 'Mantle stand-in', cls: 'MantleStandIn', fullscreen: false, quns: 5, desktop: false, mantle: false, game: null },
    rec: null, startMs: Number(o.startMs) > 0 ? Number(o.startMs) : 900, keys: 0, mic: false, shares: 0, copies: 0, thumbs: 0, seed: 0,
  };
  const emit = (ev, m) => { for (const fn of Array.from(subs.get(ev) || [])) { try { fn(m); } catch (_) { /* a listener threw */ } } };
  const ok = (result) => Promise.resolve({ ok: true, result: result || {} });
  const no = (error) => Promise.resolve({ ok: false, error });

  function startRec() {
    const name = `Mantle stand-in ${stamp(new Date())}.mp4`;
    const file = path.join(dir, name);
    const r = { name, file, timer: null, made: false };
    T.rec = r;
    r.timer = setTimeout(function grow() {
      if (T.rec !== r) return;
      fs.appendFileSync(file, Buffer.alloc(64 * 1024, 0x2a));   // not a movie: main watches its size
      r.made = true;
      r.timer = setTimeout(grow, 300);
    }, T.startMs);
  }
  function stopRec() {
    const r = T.rec; T.rec = null;
    if (r) clearTimeout(r.timer);
    return r;
  }
  const H = {
    'gaming.get': () => ok({ folder: dir, mic: { on: T.mic } }),
    'gaming.set': (a) => { if (a && a.key === 'mic' && !a.dryRun) T.mic = !!a.value; return ok({ fake: true }); },
    'record.target': () => ok(Object.assign({}, T.target)),
    'record.keys': (a) => {
      if (!a || String(a.hwnd) !== String(T.target.hwnd)) return no('the window in front changed, so no keys were sent');
      if (T.target.game) return no('Mantle never sends keys to a game');
      T.keys++;
      if (T.rec) stopRec(); else startRec();
      return ok({ sent: true, fake: true });
    },
    'files.thumbs': (a) => { T.thumbs++; return ok({ results: ((a && a.items) || []).map(() => ({ png: standInPng(++T.seed) })) }); },
    'files.clip.set': () => { T.copies++; return ok({ fake: true }); },
    'clips.share': () => { T.shares++; return ok({ shown: true, fake: true }); },
    'files.op': (a) => {
      if (!a || a.op !== 'recycle') return no('the fake knows only recycle');
      const bin = path.join(dir, '.bin');
      fs.mkdirSync(bin, { recursive: true });
      const results = (a.items || []).map((p) => {
        if (!underTemp(p)) return { ok: false, why: 'not under %TEMP%' };
        const key = `k${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        try { fs.renameSync(p, path.join(bin, `${key}__${path.basename(p)}`)); return { ok: true, key }; } catch (e) { return { ok: false, why: e.message }; }
      });
      setTimeout(() => emit('files.opdone', { job: a.job, results }), 30);
      return ok({ job: a.job });
    },
    'files.recycle.restore': (a) => {
      const bin = path.join(dir, '.bin');
      for (const key of (a && a.keys) || []) {
        const f = (fs.existsSync(bin) ? fs.readdirSync(bin) : []).find((n) => n.startsWith(`${key}__`));
        if (!f) return no('that item is not in the bin');
        fs.renameSync(path.join(bin, f), path.join(dir, f.slice(key.length + 2)));
      }
      return ok({ restored: true });
    },
  };
  return {
    fake: true,
    send(cmd, args, opts) {
      if (H[cmd]) { try { return H[cmd](args || {}); } catch (e) { return no(e.message); } }
      return real ? real.send(cmd, args, opts) : no(`the fake sidecar has no ${cmd}`);
    },
    on(ev, fn) {
      const set = subs.get(ev) || new Set(); set.add(fn); subs.set(ev, set);
      const off = real && real.on ? real.on(ev, fn) : null;
      return () => { set.delete(fn); if (typeof off === 'function') off(); };
    },
    onReady(fn) { if (real && real.onReady) return real.onReady(fn); setTimeout(fn, 0); return () => {}; },
    set(p) { if (p && p.target) Object.assign(T.target, p.target); if (p && typeof p.quns === 'number') T.target.quns = p.quns; return this.state(); },
    state() { return { target: Object.assign({}, T.target), recording: T.rec ? { name: T.rec.name, made: T.rec.made } : null, keys: T.keys, mic: T.mic, shares: T.shares, copies: T.copies, thumbs: T.thumbs }; },
    stop() { stopRec(); },
  };
}

module.exports = { make, standInPng, underTemp };
