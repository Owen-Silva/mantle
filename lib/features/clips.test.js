'use strict';
/* clips.test.js - the pure half of Clips + the Win+G Record panel (lane mantle-clips, 2026-10-15):
 * the gallery model, Game Bar's names, trim names (never overwrite), Win+G routing, the Record
 * button's plan, and the LOSSLESS MP4 cut on a synthetic movie (H.264-like video with keyframes every
 * 30 samples + AAC-like audio; every sample's bytes say which track and sample it is, so the cut
 * file is checked byte for byte). No Electron, no sidecar, nothing of the user's.
 *   node lib/features/clips.test.js   -> "CLIPS UNIT: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./_clips-core');
const M = require('./_clips-mp4');

let passed = 0; const failed = [];
function check(name, ok, detail) { if (ok) passed++; else failed.push(`${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`); }

/* ---- names ---- */
let p = C.parseName('VALORANT   2026-09-26 16-52-26.mp4');
check('a Game Bar video name gives its title', p.title === 'VALORANT', p);
check('... and its local time', p.at === new Date(2026, 8, 26, 16, 52, 26).getTime(), p);
p = C.parseName('Main@thinkorswim [build 1989] 11_22_2025 4_29_39 PM.png');
check('a Game Bar screenshot name (12-hour) gives title and time', p.title === 'Main@thinkorswim [build 1989]' && p.at === new Date(2025, 10, 22, 16, 29, 39).getTime(), p);
p = C.parseName('Google Gemini - Opera 1_22_2026 12_05_08 AM.png');
check('12 AM is hour 0', p.at === new Date(2026, 0, 22, 0, 5, 8).getTime(), p);
p = C.parseName('my own clip.mp4');
check('any other name keeps its stem and no time', p.title === 'my own clip' && p.at === null, p);

/* ---- gallery ---- */
const now = new Date(2026, 9, 15, 22, 0, 0).getTime();
const ents = [
  { name: 'A 2026-10-15 09-00-00.mp4', size: 5e6, mtimeMs: 1 },
  { name: 'B 10_14_2026 8_00_00 PM.png', size: 4e5, mtimeMs: 1 },
  { name: 'C 2026-05-20 16-34-12.mp4', size: 77186332, mtimeMs: 1 },
  { name: 'desktop.ini', size: 10, mtimeMs: 1 },
  { name: 'Mantle recording.mp4', size: 1e6, mtimeMs: new Date(2026, 9, 15, 21, 0, 0).getTime(), birthtimeMs: new Date(2026, 9, 15, 21, 0, 0).getTime() },
];
let g = C.gallery(ents, { 'A 2026-10-15 09-00-00.mp4': { durationMs: 38000, width: 1920, height: 1080 } }, { now });
check('the gallery skips what is not a video or a picture', g.counts.all === 4, g.counts);
check('newest first by the time it was taken', g.items.map((i) => i.title).join('|') === 'Mantle recording|A|B|C', g.items.map((i) => i.title));
check('grouped by day: Today, Yesterday, then dates', g.groups.map((x) => x.label).join('|') === 'Today|Yesterday|May 20', g.groups.map((x) => x.label));
check('the cached duration and size ride on the item', g.items[1].durationMs === 38000 && g.items[1].width === 1920, g.items[1]);
check('sizes read plainly', C.sizeWords(77186332) === '74 MB' && C.sizeWords(4e5) === '391 KB', [C.sizeWords(77186332), C.sizeWords(4e5)]);
g = C.gallery(ents, {}, { now, filter: 'image' });
check('the Pictures filter shows pictures only, and the counts stay whole', g.items.length === 1 && g.counts.video === 3, g.counts);
check('a new version of a file is a new thumbnail', C.thumbKey({ name: 'a.mp4', size: 1, mtimeMs: 1 }) !== C.thumbKey({ name: 'a.mp4', size: 1, mtimeMs: 2 }));
check('the same file is the same thumbnail', C.thumbKey({ name: 'A.MP4', size: 1, mtimeMs: 1 }) === C.thumbKey({ name: 'a.mp4', size: 1, mtimeMs: 1 }));
check('clock words', C.clock(7400) === '0:07' && C.clock(3723000) === '1:02:03', [C.clock(7400), C.clock(3723000)]);

/* ---- trim names ---- */
const taken = new Set(['VALORANT 2026-09-26 16-52-26 (0m11s-0m40s).mp4']);
let n = C.trimName('VALORANT 2026-09-26 16-52-26.mp4', 11200, 40000, (x) => taken.has(x));
check('a trim never takes a name that is there: it counts on', n === 'VALORANT 2026-09-26 16-52-26 (0m11s-0m40s) 2.mp4', n);
n = C.trimName('VALORANT 2026-09-26 16-52-26 (0m11s-0m40s).mp4', 1000, 5000, () => false);
check('a trim of a trim does not stack the ranges', n === 'VALORANT 2026-09-26 16-52-26 (0m01s-0m05s).mp4', n);

/* ---- Win+G routing and the Record button ---- */
const app = { hwnd: '100', exe: 'C:\\Program Files\\Opera\\opera.exe', title: 'Northwind - Opera', cls: 'Chrome_WidgetWin_1' };
let r = C.route({ on: true, panel: true, quns: 5, target: app });
check('an ordinary app: Win+G opens the panel', r.to === 'panel', r);
r = C.route({ on: true, panel: true, quns: 3, target: { exe: 'game.exe' } });
check('exclusive full screen: Win+G is Windows\' Game Bar, with the reason', r.to === 'gamebar' && /exclusive full-screen/.test(r.why), r);
r = C.route({ on: true, panel: false, quns: 5 });
check('the setting off: Game Bar', r.to === 'gamebar' && /setting is off/.test(r.why), r);
r = C.route({ on: true, panel: true, quns: 2, game: 'VALORANT', target: { exe: 'VALORANT-Win64-Shipping.exe' } });
check('a borderless game: the panel, as a normal window', r.to === 'panel' && /borderless/.test(r.why), r);
let plan = C.recordPlan({ target: app, quns: 5 });
check('an ordinary app: Record presses Win+Alt+R for the user', plan.can && plan.how === 'keys', plan);
plan = C.recordPlan({ target: { hwnd: '5', exe: 'D:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe' }, quns: 5 });
check('a game in front: NO synthetic key, a hint instead', !plan.can && plan.how === 'hint' && /never sends keys to a game/.test(plan.why), plan);
plan = C.recordPlan({ target: { hwnd: '6', exe: 'C:\\x\\javaw.exe', title: 'Minecraft 1.21.11 - Multiplayer' } });
check('Minecraft Java (javaw + its title) is a game', plan.how === 'hint', plan);
plan = C.recordPlan({ target: app, resting: true });
check('while Mantle rests for a game, Record never sends keys either', plan.how === 'hint', plan);
plan = C.recordPlan({ target: { hwnd: '7', exe: 'C:\\Windows\\explorer.exe', cls: 'Progman', desktop: true } });
check('the desktop: nothing to record, said plainly', !plan.can && plan.how === 'none' && /desktop/.test(plan.why), plan);
plan = C.recordPlan({ target: { hwnd: '0' } });
check('nothing in front: said plainly', plan.how === 'none', plan);
check('the app label', C.appLabel(app) === 'Opera' && C.appLabel({ exe: 'C:\\x\\notepad.exe', title: 'notes.txt - Notepad' }) === 'Notepad', [C.appLabel(app)]);

/* ---- the lossless cut, on a synthetic movie ---- */
const { _box: box, _full: full, _u32s: u32s } = M;
function sampleBytes(track, i, len) { const b = Buffer.alloc(len); for (let k = 0; k < len; k++) b[k] = (track * 101 + i * 7 + k) & 255; b.writeUInt16BE(i, 0); b[2] = track; return b; }
function makeMovie(file) {
  const V = { n: 300, ts: 90000, d: 3000, key: 30 }, A = { n: 470, ts: 48000, d: 1024 };
  const vs = [], as = [];
  for (let i = 0; i < V.n; i++) vs.push(sampleBytes(1, i, 200 + (i % 30 === 0 ? 900 : i % 17)));
  for (let i = 0; i < A.n; i++) as.push(sampleBytes(2, i, 60 + (i % 5)));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1mp41', 'latin1'));
  // source layout: all video, then all audio, one sample per chunk (offsets known before the moov)
  const mdatBody = Buffer.concat([...vs, ...as]);
  const mdat = box('mdat', mdatBody);
  const dataAt = ftyp.length + 8;
  const vOff = [], aOff = []; let o = dataAt;
  for (const b of vs) { vOff.push(o); o += b.length; }
  for (const b of as) { aOff.push(o); o += b.length; }
  const hdlr = (t) => full('hdlr', 0, 0, u32s([0]), Buffer.from(t, 'latin1'), Buffer.alloc(12), Buffer.from('x\0', 'latin1'));
  const mdhd = (ts, dur) => full('mdhd', 0, 0, u32s([0, 0, ts, dur]), Buffer.from([0x55, 0xc4, 0, 0]));
  const tkhd = (id, dur, w, h) => { const b = Buffer.alloc(80); b.writeUInt32BE(id, 8); b.writeUInt32BE(dur, 16); b.writeUInt32BE(w * 65536, 72); b.writeUInt32BE(h * 65536, 76); return full('tkhd', 0, 3, b); };
  const stbl = (sizes, offs, d, sync) => box('stbl',
    full('stsd', 0, 0, u32s([0])),
    full('stts', 0, 0, u32s([1, sizes.length, d])),
    ...(sync ? [full('stss', 0, 0, u32s([sync.length, ...sync]))] : []),
    full('stsc', 0, 0, u32s([1, 1, 1, 1])),
    full('stsz', 0, 0, u32s([0, sizes.length, ...sizes])),
    full('stco', 0, 0, u32s([offs.length, ...offs])));
  const trak = (id, ts, n, d, handler, sizes, offs, sync, w, h) => box('trak', tkhd(id, Math.round(n * d / ts * 1000), w, h),
    box('mdia', mdhd(ts, n * d), hdlr(handler), box('minf', full(handler === 'vide' ? 'vmhd' : 'smhd', 0, 1, Buffer.alloc(handler === 'vide' ? 8 : 4)), stbl(sizes, offs, d, sync))));
  const sync = []; for (let i = 0; i < V.n; i += V.key) sync.push(i + 1);
  const mvhd = full('mvhd', 0, 0, u32s([0, 0, 1000, 10000]), Buffer.alloc(80));
  const moov = box('moov', mvhd,
    trak(1, V.ts, V.n, V.d, 'vide', vs.map((b) => b.length), vOff, sync, 1920, 1080),
    trak(2, A.ts, A.n, A.d, 'soun', as.map((b) => b.length), aOff, null, 0, 0));
  fs.writeFileSync(file, Buffer.concat([ftyp, mdat, moov]));
  return { vs, as, V, A };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-unit-'));
  try {
    const src = path.join(dir, 'Stand-in 2026-10-15 22-00-00.mp4');
    const src2 = makeMovie(src);
    const qi = await M.quickInfo(src);
    check('quickInfo reads the length and the picture size from the index alone', qi.durationMs === 10000 && qi.width === 1920 && qi.height === 1080, qi);
    const dst = path.join(dir, C.trimName(path.basename(src), 2200, 5000, (x) => fs.existsSync(path.join(dir, x))));
    const r2 = await M.cut(src, dst, 2200, 5000);
    check('the cut starts on the keyframe at or before the asked start (2.0 s for 2.2 s)', r2.startMs === 2000, r2);
    check('... and ends at the asked end', r2.endMs === 5000, r2);
    const mv = await M.readMovie(dst);
    const v = mv.tracks.find((t) => t.handler === 'vide'), a = mv.tracks.find((t) => t.handler === 'soun');
    check('the cut has 90 video frames (2.0 .. 4.97 s at 30 fps)', v.s.n === 90, v.s.n);
    check('its first frame is a keyframe, and keyframes stay every 30', v.s.sync[0] === 1 && v.s.sync[30] === 1 && v.s.sync[1] === 0, Array.from(v.s.sync.slice(0, 3)));
    const fd = fs.openSync(dst, 'r');
    const readS = (t, i) => { const b = Buffer.alloc(t.s.size[i]); fs.readSync(fd, b, 0, b.length, t.s.offset[i]); return b; };
    let same = true;
    for (let i = 0; i < v.s.n; i++) if (!readS(v, i).equals(src2.vs[60 + i])) { same = false; break; }
    check('every video frame is copied byte for byte (frames 60..149)', same);
    const firstA = src2.as.findIndex((_, i) => i * 1024 / 48000 >= 2.0 - 1e-6);
    let sameA = a.s.n > 0;
    for (let i = 0; i < a.s.n; i++) if (!readS(a, i).equals(src2.as[firstA + i])) { sameA = false; break; }
    check('the audio starts at the same moment and is copied byte for byte', sameA, { n: a.s.n, firstA });
    check('the audio ends at the asked end', Math.abs((firstA + a.s.n) * 1024 / 48000 - 5.0) < 1024 / 48000 + 1e-6, a.s.n);
    fs.closeSync(fd);
    check('the new file says its own length (3.0 s, give or take the last audio frame)', Math.abs(mv.mvhd.duration - 3000) <= 22, mv.mvhd);
    check('the source is untouched', fs.statSync(src).size === fs.readFileSync(src).length && (await M.quickInfo(src)).durationMs === 10000);
    let threw = null;
    try { await M.cut(src, dst, 0, 1000); } catch (err) { threw = err.message; }
    check('a cut never overwrites a file that is there', threw && /already there/.test(threw), threw);
    check('no half-written ".part" file is left', !fs.readdirSync(dir).some((f) => f.endsWith('.part')), fs.readdirSync(dir));
    const frag = path.join(dir, 'frag.mp4');
    fs.writeFileSync(frag, Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), box('moov', full('mvhd', 0, 0, u32s([0, 0, 1000, 0]), Buffer.alloc(80))), box('moof', Buffer.alloc(8)), box('mdat', Buffer.alloc(8))]));
    threw = null;
    try { await M.cut(frag, path.join(dir, 'frag-cut.mp4'), 0, 1000); } catch (err) { threw = err.message; }
    check('a fragmented movie is refused with a plain reason', threw && /fragmented/.test(threw), threw);
    const unfinished = path.join(dir, 'unfinished.mp4');
    fs.writeFileSync(unfinished, Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), box('mdat', Buffer.alloc(64))]));
    threw = null;
    try { await M.readMovie(unfinished); } catch (err) { threw = err.message; }
    check('a clip still recording (no index yet) is refused with that reason', threw && /still be recording/.test(threw), threw);
  } catch (err) {
    failed.push(`threw: ${err.stack}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`CLIPS UNIT: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAIL ${f}`);
  process.exitCode = failed.length ? 1 : 0;
})();
