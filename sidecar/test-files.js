// test-files.js - the sidecar half of Mantle Files: every files.* command, and above all THE GUARD
// (lane files, 2026-09-28). Prints "FILES TEST: n passed, m failed".
//
//   MANTLE_SIDECAR_EXE=<exe> MANTLE_FILES_SANDBOX=<...\lanes\files\sandbox> node sidecar/test-files.js
//
// Owen's rules, enforced here and not just hoped for:
//   - Every write runs inside <sandbox>\sc\run-<pid>, which this test creates and removes.
//   - The "outside" target for refusal probes is <sandbox>\..\outside (harmless scratch). It is
//     snapshotted first and must be byte-for-byte unchanged at the end.
//   - Every refusal probe is built so a BROKEN guard still could not harm a real file: it points
//     at outside\ or at nothing, and the always-refused commands are sent with arguments that
//     would fail validation anyway (no token, no paths, no confirmed).
//   - The Recycle Bin: one sandbox file is recycled and restored by its key, one is recycled and
//     purged by its key; recycle.list is reported as COUNTS only; empty is never sent in a form
//     that could run.
//   - Reads of real folders report counts only, never names.
'use strict';

const T = require('./test-lib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const SANDBOX = process.env.MANTLE_FILES_SANDBOX || '';
const TEMP = os.tmpdir();

function die(msg) { console.log('FILES TEST: 0 passed, 1 failed'); console.log('  FAIL ' + msg); process.exit(1); }
// Refuse to run at all unless the sandbox is exactly the kind the guard accepts: this script
// deletes its own run folder at the end, and that must never be anywhere real.
if (!SANDBOX || !path.isAbsolute(SANDBOX)) die('MANTLE_FILES_SANDBOX must be an absolute path');
if (!path.resolve(SANDBOX).toLowerCase().startsWith(path.resolve(TEMP).toLowerCase() + path.sep)) die('MANTLE_FILES_SANDBOX must be under the temp folder');
if (path.basename(SANDBOX).toLowerCase() !== 'sandbox') die('MANTLE_FILES_SANDBOX must be the folder named sandbox');

const BIG = path.join(SANDBOX, 'big10k');
const W = path.join(SANDBOX, 'sc', 'run-' + process.pid);
const OUTSIDE = path.join(path.dirname(SANDBOX), 'outside');
const LOCK = path.join(TEMP, 'mantle-electron-lock');

// ---------------------------------------------------------------- helpers

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA PNG from pixel(x, y) -> [r, g, b, a]. */
function encodePng(w, h, pixel) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = pixel(x, y), o = y * stride + 1 + x * 4;
    raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A real decode (8-bit RGB/RGBA, non-interlaced: what GDI+ writes) -> {w, h, px: RGBA}. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, lace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), t = buf.toString('ascii', pos + 4, pos + 8), d = buf.slice(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; lace = d[12]; }
    if (t === 'IDAT') idat.push(d);
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2) || lace) throw new Error(`unsupported PNG depth ${depth} type ${type}`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, data = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = data[y * (stride + 1)], cur = Buffer.from(data.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = (cur[i] + add) & 0xFF;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp]; out[(y * w + x) * 4 + 1] = cur[x * bpp + 1]; out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, px: out };
}

/** Names + sizes + mtimes of everything under `dir`, for the "outside\ unchanged" proof. */
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}|${e.isDirectory()}`);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  })(dir);
  return out.sort().join('\n');
}

/** The machine-wide measurement lock (atomic mkdir). Runs fn(true) holding it, or fn(false) if
 *  another lane held it for 2 minutes. Released the moment fn ends, on failure too. */
async function withLock(fn) {
  for (let i = 0; i < 60; i++) {
    let got = false;
    try { fs.mkdirSync(LOCK); got = true; } catch (_) { /* held by another lane */ }
    if (got) { try { return await fn(true); } finally { try { fs.rmdirSync(LOCK); } catch (_) { /* gone */ } } }
    await T.sleep(2000);
  }
  return fn(false);
}

const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const now = () => process.hrtime.bigint();

(async () => {
  const t = T.checker('FILES');
  const perf = {};

  // ---------------------------------------------------------------- setup (sandbox only)
  fs.mkdirSync(W, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  if (!fs.existsSync(path.join(OUTSIDE, 'keep.txt'))) fs.writeFileSync(path.join(OUTSIDE, 'keep.txt'), 'harmless outside scratch\n');
  fs.mkdirSync(path.join(OUTSIDE, 'jt'), { recursive: true });
  if (!fs.existsSync(path.join(OUTSIDE, 'jt', 'keep2.txt'))) fs.writeFileSync(path.join(OUTSIDE, 'jt', 'keep2.txt'), 'keep2\n');
  const outsideBefore = snapshot(OUTSIDE);
  fs.mkdirSync(BIG, { recursive: true });
  if (fs.readdirSync(BIG).length < 10000) {
    for (let i = 0; i < 10000; i++) {
      try { fs.writeFileSync(path.join(BIG, `f${String(i).padStart(5, '0')}.txt`), 'x'.repeat(i % 64), { flag: 'wx' }); } catch (_) { /* exists */ }
    }
  }
  const bigCount = fs.readdirSync(BIG).length;
  fs.writeFileSync(path.join(W, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(W, 'b.log'), 'bravo bravo\n');
  fs.mkdirSync(path.join(W, 'sub'));
  fs.writeFileSync(path.join(W, 'sub', 'c.txt'), 'charlie!\n');
  fs.mkdirSync(path.join(W, 'dest'));
  fs.writeFileSync(path.join(W, 'dest', 'a.txt'), 'older alpha, longer\n');

  const s = await T.startPassive();
  let jobN = 0;
  const nextJob = (p) => `${p}${++jobN}`;
  const refused = (r) => !r.ok && typeof r.error === 'string' && r.error.startsWith(T.PASSIVE_REFUSAL);
  async function op(args, timeout) {
    const job = nextJob('op');
    const r = await s.send('files.op', Object.assign({ job }, args), 8000);
    if (!r.ok) return { reply: r };
    const done = await s.waitEvent('files.opdone', timeout || 20000, (e) => e.job === job);
    return { reply: r, done };
  }
  async function stream(cmd, ev, args, timeout) {
    const job = nextJob(cmd.split('.')[1]);
    const t0 = now();
    let first = null;
    const r = await s.send(cmd, Object.assign({ job }, args), 8000);
    if (!r.ok) return { reply: r };
    const firstEv = s.waitEvent(ev, timeout || 20000, (e) => e.job === job).then((e) => { first = ms(t0); return e; });
    const done = await s.waitEvent(ev, timeout || 20000, (e) => e.job === job && e.done === true);
    await firstEv;
    const all = s.events.filter((e) => e.ev === ev && e.job === job);
    return { reply: r, done, first, total: ms(t0), all, items: [].concat(...all.map((e) => e.items || [])) };
  }

  try {
    // ---------------------------------------------------------------- registration
    const ping = await s.send('ping', {}, 4000);
    const feats = (ping.result && ping.result.features) || {};
    const want = ['files.roots', 'files.list', 'files.cancel', 'files.stat', 'files.size', 'files.search', 'files.recent',
      'files.types', 'files.icons', 'files.thumbs', 'files.conflicts', 'files.op', 'files.recycle.list', 'files.recycle.restore',
      'files.recycle.purge', 'files.recycle.empty', 'files.verb', 'files.verbs', 'files.handlers', 'files.openwith',
      'files.openwithdialog', 'files.clip.get', 'files.clip.set'];
    const missing = want.filter((c) => !(feats.commands || []).includes(c));
    t.check('every files.* command is registered', missing.length === 0, 'missing ' + missing.join(' '));
    t.check('no Files feature failed to register', !(feats.problems || []).some((p) => /^Files/.test(p)), JSON.stringify(feats.problems));

    // ---------------------------------------------------------------- roots / recent (counts only)
    const roots = await s.send('files.roots', {}, 8000);
    const rr = roots.result || {};
    t.check('roots answers known folders and drives', roots.ok && rr.known.length > 0 && rr.drives.length > 0, roots.error);
    t.check('roots: every drive has path/type/ready', (rr.drives || []).every((d) => d.path && d.type && typeof d.ready === 'boolean'));
    perf.roots = `${(rr.known || []).length} known, ${(rr.drives || []).length} drives, ${(rr.network || []).length} network`;
    const recent = await s.send('files.recent', { max: 20 }, 8000);
    t.check('recent answers a list', recent.ok && Array.isArray(recent.result.items), recent.error);
    perf.recent = `${recent.ok ? recent.result.items.length : '?'} items${recent.ok && recent.result.partial ? ' (partial: 2.5 s budget hit)' : ''}`;

    // ---------------------------------------------------------------- list: 10k, measured under the lock
    await withLock(async (locked) => {
      const L = await stream('files.list', 'files.items', { path: BIG }, 20000);
      const names = new Set(L.items.map((i) => i.n));
      t.check('list big10k: every item arrives', L.done && L.done.count === bigCount && names.size === bigCount,
        `count ${L.done && L.done.count}, unique ${names.size}, on disk ${bigCount}`);
      t.check('list: first event is <=100 items', L.all.length > 1 && L.all[0].items.length <= 100, `first ${L.all[0] && L.all[0].items.length}`);
      t.check('list: batches of <=1000', L.all.every((e) => e.items.length <= 1000));
      const it = L.items.find((i) => i.n === 'f00063.txt');
      t.check('list: compact item {n,d,s,m,c,a}', it && it.d === 0 && it.s === 63 && it.m > 1.7e12 && it.c > 1.7e12 && typeof it.a === 'number', JSON.stringify(it));
      perf.list10k = `${L.first} ms to first items, ${L.total} ms to done (${L.all.length} events)${locked ? '' : ' [LOCK NOT HELD]'}`;
    });
    const nf = await stream('files.list', 'files.items', { path: path.join(W, 'no-such-folder') });
    t.check('list of a missing folder: done with a name-free error', nf.done && /^not found \(0x8007000[23]\)$/.test(nf.done.error || ''), nf.done && nf.done.error);
    const dup = await s.send('files.list', { path: W }, 4000);
    t.check('list without job is refused', !dup.ok && /needs job/.test(dup.error));

    // ---------------------------------------------------------------- cancel (a size walk of C:\Windows: read-only, slow)
    {
      const job = nextJob('size');
      await s.send('files.size', { path: 'C:\\Windows', job }, 4000);
      await s.waitEvent('files.size', 8000, (e) => e.job === job);
      const c = await s.send('files.cancel', { job }, 4000);
      const end = await s.waitEvent('files.size', 10000, (e) => e.job === job && e.done);
      t.check('cancel stops a running job', c.ok && c.result.cancelled === true && end.cancelled === true, JSON.stringify(c));
      const c2 = await s.send('files.cancel', { job: 'never-started' }, 4000);
      t.check('cancel of an unknown job answers cancelled:false', c2.ok && c2.result.cancelled === false);
    }

    // ---------------------------------------------------------------- stat / size / search / types / icons / conflicts
    const st = await s.send('files.stat', { path: path.join(W, 'b.log') }, 4000);
    t.check('stat of a file', st.ok && st.result.exists && st.result.n === 'b.log' && st.result.s === 12 && st.result.d === 0 && typeof st.result.type === 'string', JSON.stringify(st.result));
    const st2 = await s.send('files.stat', { path: path.join(W, 'nope.txt') }, 4000);
    t.check('stat of a missing file: exists:false', st2.ok && st2.result.exists === false);
    const sz = await stream('files.size', 'files.size', { path: W });
    t.check('size streams the right totals', sz.done && sz.done.bytes === 6 + 12 + 9 + 20 && sz.done.files === 4 && sz.done.dirs === 2, JSON.stringify(sz.done));
    const s1 = await stream('files.search', 'files.found', { path: W, query: '*.txt' });
    t.check('search with wildcards (whole name)', s1.done && s1.done.count === 3 && s1.items.every((i) => /\.txt$/.test(i.n) && i.p), `count ${s1.done && s1.done.count}`);
    const s2 = await stream('files.search', 'files.found', { path: W, query: 'B.L' });
    t.check('search by substring, case-insensitive', s2.done && s2.done.count === 1 && s2.items[0].n === 'b.log');
    const s3 = await stream('files.search', 'files.found', { path: BIG, query: 'f0', max: 50 });
    t.check('search caps at max', s3.done && s3.done.count === 50 && s3.done.capped === true);
    const ty = await s.send('files.types', { exts: ['.txt', 'folder', '.png'] }, 4000);
    t.check('types names .txt / folder / .png', ty.ok && ['.txt', 'folder', '.png'].every((e) => typeof ty.result.types[e] === 'string' && ty.result.types[e].length > 0), JSON.stringify(ty.result));
    for (const px of [16, 256]) {
      const ic = await s.send('files.icons', { exts: ['.txt', 'folder'], px }, 8000);
      let ok = ic.ok;
      for (const e of ['.txt', 'folder']) {
        // The system image lists follow the display's DPI: at 125% the 16 px list is 20 px.
        try { const d = decodePng(Buffer.from(ic.result.icons[e], 'base64')); ok = ok && d.w >= px && d.w <= px * 2 && d.h === d.w && d.px.some((v, i) => i % 4 === 3 && v === 0) && d.px.some((v, i) => i % 4 === 3 && v === 255); } catch (err) { ok = false; }
      }
      t.check(`icons at ${px}px decode, with real alpha`, ok, ic.error);
    }
    const cf = await s.send('files.conflicts', { items: [path.join(W, 'a.txt'), path.join(W, 'b.log')], dest: path.join(W, 'dest') }, 4000);
    t.check('conflicts: the one clash, with both sides', cf.ok && cf.result.conflicts.length === 1 && cf.result.conflicts[0].dstS === 20 && cf.result.conflicts[0].s === 6, JSON.stringify(cf.result));

    // ---------------------------------------------------------------- thumbnails
    const q = (x, y) => (x < 128 ? (y < 128 ? [0, 0, 0, 0] : [0, 0, 100, 128]) : (y < 128 ? [255, 0, 0, 255] : [0, 200, 0, 255]));
    fs.writeFileSync(path.join(W, 'quad.png'), encodePng(256, 256, q));
    const th = await s.send('files.thumbs', { items: [{ path: path.join(W, 'quad.png') }, { path: path.join(W, 'a.txt') }], px: 128, mode: 'thumb' }, 20000);
    if (th.ok) {
      const [img, txt] = th.result.results;
      let d = null;
      try { d = decodePng(Buffer.from(img.png, 'base64')); } catch (_) { /* reported below */ }
      t.check('thumb of a PNG is a real thumbnail', img.kind === 'thumb' && d && d.w === img.w && d.w <= 128 && d.w >= 120, JSON.stringify({ kind: img.kind, w: img.w, why: img.why }));
      if (d) {
        const at = (fx, fy) => { const x = Math.floor(fx * d.w), y = Math.floor(fy * d.h), o = (y * d.w + x) * 4; return [...d.px.slice(o, o + 4)]; };
        const tl = at(0.25, 0.25), tr = at(0.75, 0.25), bl = at(0.25, 0.75);
        t.check('thumb keeps alpha: transparent quadrant', tl[3] === 0, JSON.stringify(tl));
        t.check('thumb keeps alpha: opaque red quadrant', tr[0] > 245 && tr[1] < 10 && tr[3] === 255, JSON.stringify(tr));
        // (0,0,100) at alpha 128 must come back as (0,0,~100,~128): un-premultiplying straight
        // bits gives ~199 (measured: 197), premultiplying them ~50.
        t.check('thumb keeps alpha: half-transparent colour is exact', Math.abs(bl[3] - 128) <= 3 && Math.abs(bl[2] - 100) <= 6, JSON.stringify(bl));
      }
      let dt = null;
      try { dt = decodePng(Buffer.from(txt.png, 'base64')); } catch (_) { /* reported below */ }
      t.check('thumb of a .txt falls back to its icon', txt.kind === 'icon' && dt && dt.w > 0, JSON.stringify({ kind: txt.kind, why: txt.why }));
    } else t.fail('files.thumbs answers', th.error);
    const many = await s.send('files.thumbs', { items: new Array(25).fill({ path: path.join(W, 'a.txt') }), px: 32 }, 8000);
    t.check('thumbs refuses more than 24 items', !many.ok && /at most 24/.test(many.error));
    // Cold vs warm: 24 PNGs that did not exist a moment ago (cold in the thumbnail cache).
    fs.mkdirSync(path.join(W, 'thumbs'));
    const tItems = [];
    for (let i = 0; i < 24; i++) {
      const f = path.join(W, 'thumbs', `t${i}.png`);
      fs.writeFileSync(f, encodePng(320, 240, (x, y) => [(x + i * 10) & 255, (y * 3 + i) & 255, (i * 37) & 255, 255]));
      tItems.push({ path: f });
    }
    await withLock(async (locked) => {
      let t0 = now();
      const cold = await s.send('files.thumbs', { items: tItems, px: 96, mode: 'thumb' }, 60000);
      const coldMs = ms(t0);
      t0 = now();
      const warm = await s.send('files.thumbs', { items: tItems, px: 96, mode: 'thumb' }, 60000);
      const warmMs = ms(t0);
      const good = (r) => r.ok && r.result.results.length === 24 && r.result.results.every((x) => x.kind === 'thumb' && x.png);
      t.check('24 thumbnails in one call, in order', good(cold) && good(warm), cold.error || warm.error);
      perf.thumbs = `cold ${(coldMs / 24).toFixed(1)} ms/item (${coldMs} ms for 24), warm ${(warmMs / 24).toFixed(1)} ms/item (${warmMs} ms)${locked ? '' : ' [LOCK NOT HELD]'}`;
    });

    // ---------------------------------------------------------------- verbs / handlers / clipboard read
    const vb = await s.send('files.verbs', { paths: [path.join(W, 'a.txt')] }, 15000);
    const countVerbs = (vs) => vs.reduce((n, v) => n + 1 + countVerbs(v.sub || []), 0);
    t.check('verbs lists the shell menu of a sandbox file', vb.ok && typeof vb.result.token === 'string' && vb.result.verbs.length > 0, vb.error);
    if (vb.ok) {
      perf.verbs = `${countVerbs(vb.result.verbs)} entries (${vb.result.verbs.length} top level)`;
      t.check('verbs carry canonical verbs (open or copy present)', JSON.stringify(vb.result.verbs).match(/"verb":"(open|copy|properties)"/i));
    }
    const hd = await s.send('files.handlers', { path: path.join(W, 'a.txt') }, 15000);
    t.check('handlers for .txt', hd.ok && hd.result.handlers.length > 0 && hd.result.handlers.every((h) => h.handler && h.name), hd.error);
    perf.handlers = hd.ok ? `${hd.result.handlers.length} for .txt` : '?';
    const cg = await s.send('files.clip.get', {}, 8000);
    t.check('clip.get reads (shape only; contents not printed)', cg.ok && Array.isArray(cg.result.paths) && typeof cg.result.cut === 'boolean', cg.error);

    // ---------------------------------------------------------------- ops in the sandbox
    let r = await op({ op: 'newfolder', dest: W, name: 'nf' });
    t.check('newfolder', r.done && r.done.ok && fs.statSync(path.join(W, 'nf')).isDirectory() && /\\nf$/.test(r.done.results[0].dst), JSON.stringify(r.done || r.reply));
    r = await op({ op: 'newfolder', dest: W, name: 'nf' });
    t.check('newfolder again renames on collision', r.done && r.done.ok && fs.existsSync(path.join(W, 'nf (2)')), JSON.stringify(r.done && r.done.results));
    r = await op({ op: 'newfile', dest: W, name: 'new.txt' });
    t.check('newfile', r.done && r.done.ok && fs.statSync(path.join(W, 'new.txt')).isFile());
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt'), path.join(W, 'sub')], dest: path.join(W, 'nf') });
    t.check('copy (a file and a folder)', r.done && r.done.ok && fs.existsSync(path.join(W, 'a.txt')) && fs.readFileSync(path.join(W, 'nf', 'sub', 'c.txt'), 'utf8') === 'charlie!\n'
      && r.done.results.every((x) => x.ok && x.dst), JSON.stringify(r.done && r.done.results.map((x) => ({ ok: x.ok, hr: x.hr, dst: !!x.dst }))));
    const prog = s.events.filter((e) => e.ev === 'files.progress');
    t.check('progress events carry job/op/items/itemsTotal', prog.length > 0 && prog.every((e) => e.job && e.op && typeof e.items === 'number' && typeof e.itemsTotal === 'number'));
    r = await op({ op: 'move', items: [{ src: path.join(W, 'b.log'), dest: path.join(W, 'nf'), name: 'moved.log' }] });
    t.check('move {src,dest,name} (the undo shape)', r.done && r.done.ok && !fs.existsSync(path.join(W, 'b.log')) && fs.readFileSync(path.join(W, 'nf', 'moved.log'), 'utf8') === 'bravo bravo\n'
      && /moved\.log$/.test(r.done.results[0].dst), JSON.stringify(r.done && r.done.results));
    r = await op({ op: 'move', items: [path.join(W, 'nf', 'moved.log')], dest: W });
    t.check('move back (plain path)', r.done && r.done.ok && fs.existsSync(path.join(W, 'moved.log')));
    r = await op({ op: 'rename', items: [path.join(W, 'moved.log')], name: 'renamed.log' });
    t.check('rename', r.done && r.done.ok && fs.existsSync(path.join(W, 'renamed.log')) && !fs.existsSync(path.join(W, 'moved.log')));
    // rename many (lane files2): items [{src, name}] in ONE job, results per item, and back again (the undo shape)
    fs.writeFileSync(path.join(W, 'm1.txt'), 'one');
    fs.writeFileSync(path.join(W, 'm2.txt'), 'two');
    r = await op({ op: 'rename', items: [{ src: path.join(W, 'm1.txt'), name: 'Trip (1).txt' }, { src: path.join(W, 'm2.txt'), name: 'Trip (2).txt' }] });
    t.check('rename many: both in one job', r.done && r.done.ok && r.done.results.length === 2 && fs.readFileSync(path.join(W, 'Trip (2).txt'), 'utf8') === 'two'
      && !fs.existsSync(path.join(W, 'm1.txt')) && r.done.results.every((x) => x.ok !== false && /Trip \(\d\)\.txt$/.test(x.dst)), JSON.stringify(r.done && r.done.results));
    r = await op({ op: 'rename', items: [{ src: path.join(W, 'Trip (1).txt'), name: 'm1.txt' }, { src: path.join(W, 'Trip (2).txt'), name: 'm2.txt' }] });
    t.check('rename many: back again', r.done && r.done.ok && fs.existsSync(path.join(W, 'm1.txt')) && fs.existsSync(path.join(W, 'm2.txt')));
    r = await op({ op: 'rename', items: [{ src: path.join(W, 'm1.txt'), name: 'fine.txt' }, { src: path.join(W, 'm2.txt'), name: '..\\..\\..\\outside\\probe.txt' }] });
    t.check('rename many: one smuggled path refuses the lot', r.reply && !r.reply.ok && fs.existsSync(path.join(W, 'm1.txt')) && !fs.existsSync(path.join(W, 'fine.txt')));
    r = await op({ op: 'rename', items: [{ src: path.join(W, 'm1.txt') }] });
    t.check('rename many: an item without a name is refused', r.reply && !r.reply.ok && fs.existsSync(path.join(W, 'm1.txt')));
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: path.join(W, 'dest'), conflict: 'skip' });
    t.check('copy conflict:skip leaves the clash alone', r.done && r.done.ok && r.done.skipped === 1 && fs.readFileSync(path.join(W, 'dest', 'a.txt'), 'utf8').startsWith('older'));
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: path.join(W, 'dest'), conflict: 'keepboth' });
    t.check('copy conflict:keepboth adds a second copy', r.done && r.done.ok && fs.readdirSync(path.join(W, 'dest')).length === 2);
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: path.join(W, 'dest'), conflict: 'replace' });
    t.check('copy conflict:replace overwrites', r.done && r.done.ok && fs.readFileSync(path.join(W, 'dest', 'a.txt'), 'utf8') === 'alpha\n');
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: path.join(W, 'dest') });
    t.check('passive: conflict ask with a clash is refused (no Windows dialog)', r.reply && refused(r.reply), r.reply && r.reply.error);

    // recycle + restore by key, recycle + purge by key (only items this test just recycled)
    fs.writeFileSync(path.join(W, 'recycle-me.txt'), 'to the bin and back\n');
    r = await op({ op: 'recycle', items: [path.join(W, 'recycle-me.txt')] });
    const key = r.done && r.done.results[0].key;
    t.check('recycle reports the bin key', r.done && r.done.ok && typeof key === 'string' && !fs.existsSync(path.join(W, 'recycle-me.txt')), JSON.stringify(r.done && { ok: r.done.ok, reason: r.done.reason, key: !!key }));
    if (key) {
      const bl = await s.send('files.recycle.list', {}, 30000);
      const mine = bl.ok && bl.result.items.find((x) => x.key === key);
      t.check('recycle.list finds it with its original folder', !!mine && mine.orig.toLowerCase() === W.toLowerCase() && mine.n === 'recycle-me.txt' && mine.del > 1.7e12, bl.error);
      perf.bin = bl.ok ? `${bl.result.count} items in the bin` : '?';
      const rj = nextJob('restore');
      const rr2 = await s.send('files.recycle.restore', { keys: [key], job: rj }, 30000);
      const rd = rr2.ok ? await s.waitEvent('files.opdone', 20000, (e) => e.job === rj) : null;
      t.check('restore by key puts it back', rd && rd.ok && fs.readFileSync(path.join(W, 'recycle-me.txt'), 'utf8') === 'to the bin and back\n', rr2.error || JSON.stringify(rd));
    }
    fs.writeFileSync(path.join(W, 'purge-me.txt'), 'gone for good\n');
    r = await op({ op: 'recycle', items: [path.join(W, 'purge-me.txt')] });
    const pkey = r.done && r.done.results[0].key;
    if (pkey) {
      const nc = await s.send('files.recycle.purge', { keys: [pkey], job: nextJob('purge') }, 8000);
      t.check('purge without confirmed is refused', !nc.ok && /confirmed/.test(nc.error));
      const pj = nextJob('purge');
      const pr = await s.send('files.recycle.purge', { keys: [pkey], job: pj, confirmed: true }, 30000);
      const pd = pr.ok ? await s.waitEvent('files.opdone', 20000, (e) => e.job === pj) : null;
      const after = await s.send('files.recycle.list', {}, 30000);
      t.check('purge by key removes only that item', pd && pd.ok && after.ok && !after.result.items.some((x) => x.key === pkey), pr.error || JSON.stringify(pd));
    } else t.fail('recycle for the purge test', JSON.stringify(r.done));
    r = await op({ op: 'delete', items: [path.join(W, 'renamed.log')] });
    t.check('delete without confirmed is refused', r.reply && !r.reply.ok && /confirmed/.test(r.reply.error) && fs.existsSync(path.join(W, 'renamed.log')));
    r = await op({ op: 'delete', items: [path.join(W, 'renamed.log'), path.join(W, 'nf (2)')], confirmed: true });
    t.check('delete with confirmed', r.done && r.done.ok && !fs.existsSync(path.join(W, 'renamed.log')) && !fs.existsSync(path.join(W, 'nf (2)')));

    // cancel an op mid-flight: copy the 10k folder, cancel on its first progress event
    {
      const job = nextJob('op');
      const c = await s.send('files.op', { op: 'copy', items: [BIG], dest: path.join(W, 'nf'), conflict: 'replace', job }, 8000);
      const p1 = c.ok ? await s.waitEvent('files.progress', 20000, (e) => e.job === job) : null;
      const cc = await s.send('files.cancel', { job }, 4000);
      const d = c.ok ? await s.waitEvent('files.opdone', 60000, (e) => e.job === job) : null;
      const copied = fs.existsSync(path.join(W, 'nf', 'big10k')) ? fs.readdirSync(path.join(W, 'nf', 'big10k')).length : 0;
      t.check('op cancel: progress, then aborted with cancelled', p1 && cc.ok && d && d.ok === false && d.aborted === true && d.reason === 'cancelled' && copied < bigCount,
        JSON.stringify({ c: c.error, d: d && { ok: d.ok, aborted: d.aborted, reason: d.reason }, copied }));
    }

    // ---------------------------------------------------------------- THE GUARD
    const probe = path.join(OUTSIDE, 'probe.txt');
    r = await op({ op: 'newfile', dest: OUTSIDE, name: 'probe.txt' });
    t.check('guard: newfile outside the sandbox is refused', r.reply && refused(r.reply) && !fs.existsSync(probe), r.reply && r.reply.error);
    r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: OUTSIDE });
    t.check('guard: copy to outside is refused', r.reply && refused(r.reply));
    r = await op({ op: 'move', items: [path.join(OUTSIDE, 'keep.txt')], dest: W });
    t.check('guard: moving an outside file IN is refused (the source is touched)', r.reply && refused(r.reply));
    r = await op({ op: 'recycle', items: [path.join(OUTSIDE, 'keep.txt')] });
    t.check('guard: recycling outside is refused', r.reply && refused(r.reply));
    r = await op({ op: 'newfile', dest: path.join(W, '..', '..', '..', 'outside'), name: 'probe.txt' });
    t.check('guard: a .. escape is refused', r.reply && refused(r.reply));
    // ...\files\sandbox2 starts with ...\files\sandbox but is NOT inside it (and does not exist).
    r = await op({ op: 'newfile', dest: W.toUpperCase() + '\\..\\..\\..\\sandbox2', name: 'probe.txt' });
    t.check('guard: a sibling that only shares the prefix is refused', r.reply && refused(r.reply));
    r = await op({ op: 'rename', items: [path.join(W, 'a.txt')], name: '..\\..\\..\\outside\\probe.txt' });
    t.check('guard: a rename that smuggles a path is refused', r.reply && !r.reply.ok && fs.existsSync(path.join(W, 'a.txt')));
    const J = path.join(SANDBOX, 'sc', 'j');
    try { fs.rmdirSync(J); } catch (_) { /* not there */ }
    fs.symlinkSync(OUTSIDE, J, 'junction');
    try {
      r = await op({ op: 'newfile', dest: J, name: 'probe.txt' });
      t.check('guard: a junction sandbox\\sc\\j -> outside is refused (newfile)', r.reply && refused(r.reply) && !fs.existsSync(probe), r.reply && r.reply.error);
      r = await op({ op: 'recycle', items: [path.join(J, 'keep.txt')] });
      t.check('guard: a junction sandbox\\sc\\j -> outside is refused (recycle)', r.reply && refused(r.reply));
      r = await op({ op: 'copy', items: [path.join(W, 'a.txt')], dest: path.join(J, 'deeper', 'not-yet') });
      t.check('guard: a not-yet-existing path under the junction is refused', r.reply && refused(r.reply));
    } finally { fs.rmdirSync(J); }
    fs.linkSync(path.join(OUTSIDE, 'keep.txt'), path.join(W, 'hardlink.txt'));
    r = await op({ op: 'copy', items: [{ src: path.join(W, 'a.txt'), dest: W, name: 'hardlink.txt' }], conflict: 'replace' });
    t.check('guard: overwriting a hard link to an outside file is refused', r.reply && refused(r.reply));
    fs.unlinkSync(path.join(W, 'hardlink.txt'));

    // 2026-09-29 adversarial pass (files-sc): each of these was PROVEN to write outside on the old build.
    // A folder MERGE (copy replace onto an existing folder) must not write through a junction or a hard
    // link hidden deeper in the existing destination tree.
    {
      const OJ = path.join(OUTSIDE, 'jt');
      fs.mkdirSync(OJ, { recursive: true });
      if (!fs.existsSync(path.join(OJ, 'keep2.txt'))) fs.writeFileSync(path.join(OJ, 'keep2.txt'), 'keep2\n');
      fs.mkdirSync(path.join(W, 'msrc', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(W, 'msrc', 'inner', 'keep2.txt'), 'THROUGH-JUNCTION\n');
      fs.writeFileSync(path.join(W, 'msrc', 'keep.txt'), 'THROUGH-HARDLINK\n');
      fs.mkdirSync(path.join(W, 'mdst', 'msrc'), { recursive: true });
      const NJ = path.join(W, 'mdst', 'msrc', 'inner');
      fs.symlinkSync(OJ, NJ, 'junction');
      try {
        r = await op({ op: 'copy', items: [path.join(W, 'msrc')], dest: path.join(W, 'mdst'), conflict: 'replace' });
        t.check('guard: a merge through a junction deep in the destination is refused', r.reply && refused(r.reply) &&
          fs.readFileSync(path.join(OJ, 'keep2.txt'), 'utf8') === 'keep2\n', r.reply && r.reply.error);
        r = await op({ op: 'move', items: [path.join(W, 'msrc')], dest: path.join(W, 'mdst'), conflict: 'replace' });
        t.check('guard: a move-merge through a junction deep in the destination is refused', r.reply && refused(r.reply) && fs.existsSync(path.join(W, 'msrc')));
      } finally { fs.rmdirSync(NJ); }
      fs.linkSync(path.join(OUTSIDE, 'keep.txt'), path.join(W, 'mdst', 'msrc', 'keep.txt'));
      r = await op({ op: 'copy', items: [path.join(W, 'msrc')], dest: path.join(W, 'mdst'), conflict: 'replace' });
      t.check('guard: a merge onto a hard link deep in the destination is refused', r.reply && refused(r.reply), r.reply && r.reply.error);
      fs.unlinkSync(path.join(W, 'mdst', 'msrc', 'keep.txt'));
      r = await op({ op: 'copy', items: [path.join(W, 'msrc')], dest: path.join(W, 'mdst'), conflict: 'replace' });
      t.check('a merge into a plain existing folder still works', r.done && r.done.ok && fs.readFileSync(path.join(W, 'mdst', 'msrc', 'keep.txt'), 'utf8') === 'THROUGH-HARDLINK\n',
        JSON.stringify(r.reply.error || (r.done && r.done.reason)));
    }
    // Names Windows reserves, or that end in a space / dot, make files most apps cannot open or delete.
    for (const nm of ['CON', 'aux.txt', 'COM1', 'lpt9.log', 'CONIN$', 'x.', 'x ']) {
      r = await op({ op: 'newfile', dest: W, name: nm });
      t.check(`names: newfile ${JSON.stringify(nm)} is refused in words`, r.reply && !r.reply.ok && /reserved by Windows|space or a dot/.test(r.reply.error) &&
        !fs.readdirSync(W).some((f) => f.toLowerCase() === nm.trim().replace(/\.$/, '').toLowerCase()), r.reply && (r.reply.error || 'it ran'));
    }
    r = await op({ op: 'rename', items: [path.join(W, 'a.txt')], name: 'NUL' });
    t.check('names: rename to NUL is refused in words', r.reply && !r.reply.ok && /reserved by Windows/.test(r.reply.error) && fs.existsSync(path.join(W, 'a.txt')), r.reply && r.reply.error);
    // Rename onto a different existing item: refused in words, never a Windows replace dialog.
    fs.writeFileSync(path.join(W, 'clash.txt'), 'other\n');
    r = await op({ op: 'rename', items: [path.join(W, 'a.txt')], name: 'clash.txt' });
    t.check('rename onto an existing name is refused with "already exists"', r.reply && !r.reply.ok && /already exists/.test(r.reply.error) &&
      fs.readFileSync(path.join(W, 'clash.txt'), 'utf8') === 'other\n', r.reply && r.reply.error);
    r = await op({ op: 'rename', items: [path.join(W, 'clash.txt')], name: 'CLASH.txt' });
    t.check('a case-only rename still works', r.done && r.done.ok && fs.readdirSync(W).includes('CLASH.txt'), JSON.stringify(r.reply.error || (r.done && r.done.reason)));
    // A path past 260 characters is a real path, not "not an absolute path".
    {
      let deep = path.join(W, 'deep');
      while (deep.length < 300) deep = path.join(deep, 'd'.repeat(40));
      fs.mkdirSync(deep, { recursive: true });
      r = await op({ op: 'newfolder', dest: deep, name: 'inside-long' });
      t.check('long path: the guard accepts a path over 260 characters', r.reply && r.reply.ok, r.reply && r.reply.error);
      t.check('long path: newfolder at depth reports in words', r.done && (r.done.ok || /\w/.test(String(r.done.reason).replace(/\(0x[0-9A-F]+\)/, ''))),
        JSON.stringify(r.done && { ok: r.done.ok, reason: r.done.reason }));
      perf.longPath = r.done ? (r.done.ok ? 'newfolder at ' + (deep.length + 12) + ' chars: ok' : 'newfolder at depth: ' + r.done.reason) : 'refused';
    }

    // always refused in passive, each sent with arguments a broken guard would still reject
    for (const [cmd, args] of [['files.verb', {}], ['files.openwith', {}], ['files.openwithdialog', {}], ['files.clip.set', {}], ['files.recycle.empty', {}]]) {
      const x = await s.send(cmd, args, 4000);
      t.check(`guard: ${cmd} is refused in passive`, refused(x), x.error);
    }
    const pz = await s.send('files.recycle.purge', { keys: ['C:\\no-such-bin-key'], job: nextJob('purge'), confirmed: true }, 30000);
    t.check('guard: purge of a key not in the bin is refused in passive', refused(pz), pz.error);

    // a sidecar with no sandbox, and ones with sandboxes the guard must not accept
    const variants = [
      ['unset', undefined],
      ['not under TEMP', 'C:\\Users\\user\\mantle-files-no-such-sandbox'],
      ['no sandbox segment', OUTSIDE],
      ['relative', 'sandbox'],
    ];
    for (const [label, val] of variants) {
      const saved = process.env.MANTLE_FILES_SANDBOX;
      if (val === undefined) delete process.env.MANTLE_FILES_SANDBOX; else process.env.MANTLE_FILES_SANDBOX = val;
      let s2 = null;
      try {
        s2 = await T.startPassive();
        const a = await s2.send('files.op', { op: 'newfile', dest: W, name: 'probe.txt', job: 'g1' }, 8000);
        const b = await s2.send('files.op', { op: 'recycle', items: [path.join(W, 'a.txt')], job: 'g2' }, 8000);
        t.check(`guard: sandbox ${label} -> every write refused`, refused(a) && refused(b) && !fs.existsSync(path.join(W, 'probe.txt')) && fs.existsSync(path.join(W, 'a.txt')), a.error);
      } finally {
        process.env.MANTLE_FILES_SANDBOX = saved;
        if (s2) await s2.stop();
      }
    }
    // The sandbox root itself a junction NAMED sandbox that points at another temp folder (outside\tgt):
    // accepted before 2026-09-29, and the write landed in outside\tgt.
    {
      const TGT = path.join(OUTSIDE, 'tgt');
      const JR = path.join(W, 'jroot');
      const JRS = path.join(JR, 'sandbox');
      fs.mkdirSync(TGT, { recursive: true });
      fs.mkdirSync(JR, { recursive: true });
      fs.symlinkSync(TGT, JRS, 'junction');
      const saved = process.env.MANTLE_FILES_SANDBOX;
      process.env.MANTLE_FILES_SANDBOX = JRS;
      let s2 = null;
      try {
        s2 = await T.startPassive();
        const a = await s2.send('files.op', { op: 'newfile', dest: JRS, name: 'probe.txt', job: 'g3' }, 8000);
        if (a.ok) await s2.waitEvent('files.opdone', 20000, (e) => e.job === 'g3').catch(() => null);
        t.check('guard: a sandbox root that is a junction to a non-sandbox folder is refused', refused(a) && !fs.existsSync(path.join(TGT, 'probe.txt')), a.error || 'accepted');
      } finally {
        process.env.MANTLE_FILES_SANDBOX = saved;
        if (s2) await s2.stop();
        fs.rmdirSync(JRS);
        try { fs.unlinkSync(path.join(TGT, 'probe.txt')); } catch (_) { /* never written */ }
        fs.rmdirSync(TGT);
      }
    }
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
    t.check('outside\\ is unchanged', snapshot(OUTSIDE) === outsideBefore);
    // Clean up the run folder, but only after proving nothing in it is a link out.
    let links = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (fs.lstatSync(p).isSymbolicLink()) links++;
        else if (e.isDirectory()) walk(p);
      }
    })(W);
    if (links === 0) fs.rmSync(W, { recursive: true, force: true });
    else t.fail('cleanup', `${links} links left in the run folder; it was NOT removed`);
    console.log('perf: ' + JSON.stringify(perf));
  }
  process.exit(t.summary());
})();
