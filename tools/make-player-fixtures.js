'use strict';
/*
 * make-player-fixtures.js - builds the tiny media files lib/features/player.e2e.test.js plays (lane
 * mantle-player2, 2026-10-17). Committed output, so the e2e never needs ffmpeg; rerun this only to change them.
 *
 *   node tools/make-player-fixtures.js [--ffmpeg=<ffmpeg.exe>]
 *
 * OUTPUT: lib/features/fixtures/player/
 *   videos/clip-h264.mp4   30 s H.264 + AAC (long enough for resume: Mantle keeps a spot from 10 s to end-15 s)
 *   videos/clip-h264.srt   its sidecar subtitles (two cues)
 *   videos/clip-vp9.webm   VP9 + Opus
 *   videos/clip-h264.mkv   H.264 + AAC in Matroska
 *   videos/clip-hevc.mp4   HEVC (hvc1) + AAC
 *   videos/clip-2audio.mp4 H.264 + two AAC sound tracks (English, French)
 *   videos/clip-mjpeg.avi  Motion JPEG + PCM in AVI
 *   videos/broken.mp4      an MP4 cut short: its header is there, its index (moov) is not
 *   music/song-a.mp3       ID3v2.3 tags + front cover (APIC)
 *   music/song-b.m4a       AAC, iTunes tags + cover (covr)
 *   music/song-c.opus      Opus, Vorbis comments + METADATA_BLOCK_PICTURE cover
 * Every sound is a sine at -30 dBFS (amplitude 0.0316), 160x90 pictures, a few KB each. The tests run muted anyway.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'lib', 'features', 'fixtures', 'player');
const FF = (process.argv.find((a) => a.startsWith('--ffmpeg=')) || '').slice('--ffmpeg='.length) ||
  'C:/Users/user/media-tools/video/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe';
const TMP = path.join(OUT, '.tmp');

function ff(args, what) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(what + ' failed: ' + (r.stderr || r.error || r.status));
}
// this ffmpeg (Remotion's) has no testsrc/color/aevalsrc: sound is lavfi sine (amplitude 1/8, -18 dBFS) taken down 12 dB to -30 dBFS,
// pictures are BMP frames drawn here
const tone = (sec, hz) => ['-f', 'lavfi', '-i', 'sine=frequency=' + (hz || 440) + ':sample_rate=44100:duration=' + sec + ',volume=-12dB'];
let FRAMES = null;
const pic = (sec) => ['-framerate', '10', '-i', path.join(FRAMES, 'f%04d.bmp'), '-t', String(sec)];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-crf', '32'];
const aac = ['-c:a', 'aac', '-b:a', '48k', '-ac', '1'];

function flacPictureBlock(png) {
  const mime = Buffer.from('image/png'), desc = Buffer.from('Cover');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(desc.length), desc, u32(64), u32(64), u32(24), u32(0), u32(png.length), png]);
}
/** a 24-bit BMP; px(x, y) -> [r, g, b] */
function bmp(w, h, px) {
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h, b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, h - 1 - y), o = 54 + y * row + x * 3; b[o] = c[2]; b[o + 1] = c[1]; b[o + 2] = c[0]; }
  return b;
}

function main() {
  for (const d of ['videos', 'music']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const V = (n) => path.join(OUT, 'videos', n), A = (n) => path.join(OUT, 'music', n), T = (n) => path.join(TMP, n);

  // 30 s of 160x90 frames at 10 fps: a soft blue-grey field, a tile sliding across, and a bar per second
  FRAMES = path.join(TMP, 'frames'); fs.mkdirSync(FRAMES, { recursive: true });
  for (let i = 0; i < 300; i++) {
    const tx = Math.round((i % 50) / 49 * 120), sec = Math.floor(i / 10);
    fs.writeFileSync(path.join(FRAMES, 'f' + String(i + 1).padStart(4, '0') + '.bmp'), bmp(160, 90, (x, y) => {
      if (x >= tx && x < tx + 40 && y >= 25 && y < 65) return [79, 70, 229];
      if (y >= 80 && y < 84 && x < 5 + sec * 5) return [99, 102, 241];
      const g = 236 - Math.round(y / 6); return [g - 8, g - 4, g];
    }));
  }
  // the cover: 64x64 PNG, flat accent with a lighter square (no text, so no font)
  fs.writeFileSync(T('cover.bmp'), bmp(64, 64, (x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? [199, 210, 254] : [79, 70, 229])));
  ff(['-i', T('cover.bmp'), '-frames:v', '1', '-c:v', 'png', T('cover.png')], 'cover');

  ff(pic(30).concat(tone(30), h264, aac, ['-shortest', '-movflags', '+faststart', V('clip-h264.mp4')]), 'clip-h264.mp4');
  fs.writeFileSync(V('clip-h264.srt'), '1\r\n00:00:00,500 --> 00:00:04,000\r\nThe first line\r\n\r\n2\r\n00:00:05,000 --> 00:00:09,000\r\nThe second line\r\n');
  ff(pic(3).concat(tone(3), ['-c:v', 'libvpx-vp9', '-b:v', '60k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '32k', '-shortest', V('clip-vp9.webm')]), 'clip-vp9.webm');
  ff(pic(3).concat(tone(3), h264, aac, ['-shortest', V('clip-h264.mkv')]), 'clip-h264.mkv');
  ff(pic(3).concat(tone(3), ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '34', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], aac, ['-shortest', '-movflags', '+faststart', V('clip-hevc.mp4')]), 'clip-hevc.mp4');
  ff(pic(3).concat(tone(3, 440), tone(3, 660), ['-map', '0:v', '-map', '1:a', '-map', '2:a'], h264, aac,
    ['-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English', '-metadata:s:a:1', 'language=fra', '-metadata:s:a:1', 'title=French',
      '-shortest', '-movflags', '+faststart', V('clip-2audio.mp4')]), 'clip-2audio.mp4');
  ff(pic(3).concat(tone(3), ['-c:v', 'mjpeg', '-q:v', '24', '-c:a', 'pcm_s16le', '-ac', '1', '-ar', '22050', '-shortest', V('clip-mjpeg.avi')]), 'clip-mjpeg.avi');
  // broken: an MP4 with its index at the END, cut to its first 6 KB (ftyp + the start of mdat, no moov)
  ff(pic(3).concat(tone(3), h264, aac, ['-shortest', T('whole.mp4')]), 'whole.mp4');
  fs.writeFileSync(V('broken.mp4'), fs.readFileSync(T('whole.mp4')).subarray(0, 6144));

  ff(tone(3, 523).concat(['-i', T('cover.png'), '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-c:v', 'png', '-id3v2_version', '3',
    '-metadata', 'title=Glass Morning', '-metadata', 'artist=Mantle Test Band', '-metadata', 'album=Quiet Things', '-metadata', 'track=1', '-metadata', 'date=2026',
    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', A('song-a.mp3')]), 'song-a.mp3');
  ff(tone(3, 587).concat(['-i', T('cover.png'), '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-c:v', 'png', '-disposition:v', 'attached_pic', '-f', 'mp4',
    '-metadata', 'title=Paper Lanterns', '-metadata', 'artist=Mantle Test Band', '-metadata', 'album=Quiet Things', '-metadata', 'track=2', '-metadata', 'date=2026', A('song-b.m4a')]), 'song-b.m4a');
  const mbp = flacPictureBlock(fs.readFileSync(T('cover.png'))).toString('base64');
  ff(tone(3, 659).concat(['-c:a', 'libopus', '-b:a', '24k', '-ac', '1', '-metadata', 'title=Jumpy Polygons', '-metadata', 'artist=Mantle Test Band', '-metadata', 'album=Quiet Things',
    '-metadata', 'track=3', '-metadata', 'date=2026', '-metadata', 'METADATA_BLOCK_PICTURE=' + mbp, A('song-c.opus')]), 'song-c.opus');

  fs.rmSync(TMP, { recursive: true, force: true });
  for (const d of ['videos', 'music']) for (const f of fs.readdirSync(path.join(OUT, d))) console.log('make-player-fixtures: ' + d + '/' + f + ' ' + fs.statSync(path.join(OUT, d, f)).size + ' bytes');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('make-player-fixtures FAILED: ' + (e && e.message || e)); process.exit(1); }
}
