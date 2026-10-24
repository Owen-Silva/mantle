// maxfold-testwin.js - builds and starts the maximize unfold's invisible test window
// (sidecar/testwins/maxfold-testwin.cs; lane unfold-max, 2026-10-23). Not a test itself: a helper for
// sidecar/test-maxfold.js and lib/features/_maxfold-selftest.js.
//
//   const W = require('./maxfold-testwin');
//   const exe = W.build();                         // csc.exe -> %TEMP%\mantle-maxfold-test\testwin-<hash>.exe (cached)
//   const w = await W.start({ mode: 'normal' });   // {hwnd, pid, freq, cmd(line, prefix, ms), close(), proc}
//   const r = await w.cmd('max', 'OK');            // the answer line
//
// The window is the harness's own child (or, with via:'cmd', a GRANDCHILD through cmd.exe: a window a
// passive sidecar must NOT treat as the harness's own). See the .cs header for the commands.
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, 'testwins', 'maxfold-testwin.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const DIR = path.join(os.tmpdir(), 'mantle-maxfold-test');

/** The helper exe, compiled once per source version. Throws with csc's own words on failure. */
function build() {
  const src = fs.readFileSync(SRC);
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  fs.mkdirSync(DIR, { recursive: true });
  const exe = path.join(DIR, `testwin-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  const tmp = `${exe}.${process.pid}.tmp.exe`;
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/optimize+', '/r:System.Drawing.dll', `/out:${tmp}`, SRC],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    throw new Error(`the test window helper did not build: ${String((r.stdout || '') + (r.stderr || '') || r.error || '').slice(0, 800)}`);
  }
  try { fs.renameSync(tmp, exe); } catch (e) { if (!fs.existsSync(exe)) throw e; try { fs.unlinkSync(tmp); } catch (_) { /* raced */ } }
  return exe;
}

/**
 * Start one test window. opts: {mode='normal'|'tiny'|'popup'|'tool', life=90 (s), x, y, w, h, via='direct'|'cmd',
 * exe (default build()), env}. Resolves once it printed its HWND line.
 */
function start(opts) {
  const o = opts || {};
  const exe = o.exe || build();
  const args = [o.mode || 'normal', String(o.life || 90), String(o.x == null ? 120 : o.x), String(o.y == null ? 90 : o.y),
    String(o.w || 1000), String(o.h || 640)];
  const env = Object.assign({}, process.env, o.env || {});
  const proc = o.via === 'cmd'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env, windowsVerbatimArguments: true })
    : spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  proc.stdin.on('error', () => {});
  let buf = '';
  const lines = [];
  const waiters = [];
  let exited = null;
  function pump() {
    while (waiters.length && lines.length) {
      const w = waiters[0];
      const i = lines.findIndex((l) => w.prefixes.some((p) => l.startsWith(p)));
      if (i < 0) break;
      const l = lines.splice(i, 1)[0];
      waiters.shift(); clearTimeout(w.t); w.resolve(l);
    }
  }
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let k;
    while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k).replace(/\r$/, ''); buf = buf.slice(k + 1); if (l) lines.push(l); }
    pump();
  });
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; for (const w of waiters.splice(0)) { clearTimeout(w.t); w.reject(new Error(`the test window ended (code ${code})`)); } });
  function next(prefixes, ms) {
    return new Promise((resolve, reject) => {
      const w = { prefixes: prefixes.concat(['ERR']), resolve, reject, t: null };
      w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error(`no "${prefixes[0]}" answer from the test window in ${ms} ms`)); }, ms);
      waiters.push(w);
      pump();
    });
  }
  const me = {
    proc,
    get exited() { return exited; },
    cmd(line, prefix, ms) {
      if (exited) return Promise.reject(new Error('the test window has ended'));
      const p = next([prefix || line.split(' ')[0].toUpperCase()], ms || 8000);
      try { proc.stdin.write(line + '\n'); } catch (e) { return Promise.reject(e); }
      return p;
    },
    async close() {
      if (exited) return;
      try { proc.stdin.write('close\n'); } catch (_) { /* gone */ }
      const until = Date.now() + 3000;
      while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      if (!exited) { try { proc.kill(); } catch (_) { /* gone */ } }
    },
  };
  return next(['HWND'], o.readyMs || 10000).then((l) => {
    const m = /^HWND (\d+) PID (\d+) FREQ (\d+)/.exec(l);
    if (!m) throw new Error(`the test window said "${l.slice(0, 120)}" instead of its handle`);
    me.hwnd = Number(m[1]); me.pid = Number(m[2]); me.freq = Number(m[3]);
    return me;
  });
}

/** "BANDS ok=.. w=.. | b0 ; b1 ..." -> {ok, w, h, dx, dy, diff, max, bands:[{lumO, lumS, gradO, gradS, tintO, tintS, diff, r, g, b}]} */
function parseBands(line) {
  const m = /^BANDS ok=(\w+) w=(\d+) h=(\d+) dx=(-?\d+) dy=(-?\d+) diff=(-?[\d.]+) max=(\d+) \| (.*)$/.exec(String(line || ''));
  if (!m) return null;
  const names = ['lumO', 'lumS', 'gradO', 'gradS', 'tintO', 'tintS', 'diff', 'r', 'g', 'b'];
  const bands = m[8].split(' ; ').map((s) => {
    const v = s.trim().split(/\s+/).map(Number);
    const o = {}; names.forEach((n, i) => { o[n] = v[i]; }); return o;
  });
  return { ok: m[1] === 'true', w: +m[2], h: +m[3], dx: +m[4], dy: +m[5], diff: +m[6], max: +m[7], bands };
}

/** "INFO vis=1 ex=0x.. style=0x.. lwa=true/0/2 rect l t r b above=n" -> object */
function parseInfo(line) {
  const m = /^INFO vis=(\d) ex=0x([0-9A-F]+) style=0x([0-9A-F]+) lwa=(\w+)\/(\d+)\/(\d+) rect (-?\d+) (-?\d+) (-?\d+) (-?\d+) above=(-?\d+)/.exec(String(line || ''));
  if (!m) return null;
  return { visible: m[1] === '1', ex: parseInt(m[2], 16) >>> 0, style: parseInt(m[3], 16) >>> 0, lwaOk: m[4] === 'true',
    alpha: +m[5], lwaFlags: +m[6], rect: { l: +m[7], t: +m[8], r: +m[9], b: +m[10] }, above: +m[11] };
}

module.exports = { build, start, parseBands, parseInfo, SRC, DIR };
