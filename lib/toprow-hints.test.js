'use strict';
/* toprow-hints.test.js -- plain node. Prints "TOPROW HINTS: N passed, M failed". */
const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./toprow-hints.js');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) { if (cond) passed++; else { failed++; fails.push(name); process.stdout.write(`FAIL ${name}\n`); } }
const tick = () => new Promise((r) => setImmediate(r));
async function flush(n) { for (let i = 0; i < (n || 4); i++) await tick(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a fake net for deterministic tests -------------------------------------------------------- */
class FakeSock extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
}
function fakeNet() {
  const n = {
    handler: null, busy: false,
    createServer(h) {
      n.handler = h;
      const s = new EventEmitter();
      s.listen = (p, cb) => { n.lastPipe = p; setImmediate(() => { if (n.busy) s.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })); else cb(); }); };
      s.close = () => {};
      return s;
    },
    connect() { const k = new FakeSock(); n.handler(k); return k; },
  };
  return n;
}
const QUARTZ = { ok: true, pid: 11, path: 'C:\\Users\\user\\AppData\\Local\\Quartz\\Quartz.exe' };
const HELM = { ok: true, pid: 22, path: 'C:\\Users\\user\\helm\\node_modules\\electron\\dist\\electron.exe' };
function rig(extra) {
  const r = { fw: [], logs: [], calls: [], procs: {}, t: 1e6, dark: true, net: fakeNet() };
  r.h = T.makeHints(Object.assign({
    netImpl: r.net, home: 'C:\\Users\\user', retryMs: 40,
    now: () => r.t, dark: () => r.dark, log: (m) => r.logs.push(m),
    forward: (hw, app, top, meta) => r.fw.push({ hw, app, top, meta }),
    procOf: async (hw) => { r.calls.push(hw); const p = r.procs[hw]; if (p instanceof Error) throw p; return p || QUARTZ; },
  }, extra || {}));
  let seq = 0;
  r.msg = (o) => JSON.stringify(Object.assign({ v: 1, app: 'quartz', hwnd: '100', seq: ++seq, t: 5, top: { kind: 'flat', rgb: [1, 2, 3] } }, o || {}));
  r.send = (sock, s) => sock.emit('data', Buffer.from(s, 'utf8'));
  return r;
}

async function unit() {
  /* pure helpers */
  ok(T.pipePath('x') === '\\\\.\\pipe\\x' && T.pipePath('\\\\.\\pipe\\y') === '\\\\.\\pipe\\y', 'pipePath');
  const N = T.normaliseTop;
  ok(JSON.stringify(N({ kind: 'wash', rgb: [1, 2, 3], alpha: 0.5 }).top) === '{"kind":"wash","rgb":[1,2,3],"alpha":0.5}', 'wash valid');
  ok(N({ kind: 'wash', rgb: [1, 2, 3], alpha: 1.5 }).bad === 'bad top (wash)', 'wash alpha > 1');
  ok(N({ kind: 'wash', rgb: [1, 2, 3] }).bad === 'bad top (wash)', 'wash no alpha');
  ok(N({ kind: 'wash', rgb: [1, 2, 256], alpha: 0.5 }).bad === 'bad top (wash)', 'wash rgb 256');
  ok(JSON.stringify(N({ kind: 'flat', rgb: [0, 128, 255], extra: 1 }).top) === '{"kind":"flat","rgb":[0,128,255]}', 'flat valid');
  ok(N({ kind: 'flat', rgb: [1.5, 2, 3] }).bad === 'bad top (flat)', 'flat float');
  ok(N({ kind: 'flat', rgb: [1, 2] }).bad === 'bad top (flat)', 'flat two');
  ok(N({ kind: 'flat', rgb: '1,2,3' }).bad === 'bad top (flat)', 'flat string');
  ok(JSON.stringify(N({ kind: 'cols', cols: [[1, 2, 3], [4, 5, 6]] }).top) === '{"kind":"cols","cols":[1,2,3,4,5,6]}', 'cols valid, flat array');
  ok(N({ kind: 'cols', cols: [] }).bad === 'bad top (cols)', 'cols empty');
  ok(N({ kind: 'cols', cols: new Array(4097).fill([1, 1, 1]) }).bad === 'bad top (cols)', 'cols 4097');
  ok(N({ kind: 'cols', cols: new Array(4096).fill([1, 1, 1]) }).top.cols.length === 480 * 3, 'cols 4096 ok, 480 out');
  ok(N({ kind: 'cols', cols: [[1, 2, 3], [4, 5]] }).bad === 'bad top (cols)', 'cols bad entry');
  ok(N({ kind: 'none' }).top.kind === 'none', 'none');
  ok(N({ kind: 'glow' }).bad === 'bad top' && N(null).bad === 'bad top' && N([1]).bad === 'bad top', 'unknown kind');
  const alt = []; for (let i = 0; i < 960; i++) alt.push(i % 2 ? [255, 255, 255] : [0, 0, 0]);
  const ra = T.resampleCols(alt, 480);
  ok(ra.length === 1440 && ra.every((v) => v === 128), 'resample averages pairs');
  const ramp = []; for (let i = 0; i < 1000; i++) ramp.push([Math.floor(i * 255 / 999), 0, 0]);
  const rr = T.resampleCols(ramp, 480);
  let mono = true; for (let i = 1; i < 480; i++) if (rr[i * 3] < rr[(i - 1) * 3]) mono = false;
  ok(rr.length === 1440 && mono && rr[0] <= 1 && rr[479 * 3] >= 253, 'resample a ramp keeps it monotone');
  const H = 'C:\\Users\\user';
  ok(T.appOwns('quartz', 'D:\\x\\Quartz.exe', H), 'Quartz.exe anywhere');
  ok(T.appOwns('quartz', 'c:\\users\\user\\browser\\node_modules\\electron\\dist\\electron.exe', H), 'electron under browser');
  ok(T.appOwns('quartz', 'C:\\Users\\user\\browser-toprow\\node_modules\\electron\\dist\\electron.exe', H), 'electron under browser-* worktree');
  ok(!T.appOwns('quartz', 'C:\\Users\\user\\browserx\\electron.exe', H), 'browserx is not browser');
  ok(!T.appOwns('quartz', 'C:\\Users\\user\\browser-\\electron.exe', H), 'browser- with no suffix');
  ok(!T.appOwns('quartz', 'C:\\Users\\user\\helm\\electron.exe', H), 'helm electron is not quartz');
  ok(T.appOwns('helm', 'C:\\Users\\user\\helm-looksync\\node_modules\\electron\\dist\\electron.exe', H), 'electron under helm-* worktree');
  ok(T.appOwns('helm', 'C:\\Program Files\\Helm\\Helm.exe', H), 'Helm.exe');
  ok(!T.appOwns('helm', 'C:\\Users\\user\\mantle\\node_modules\\electron\\dist\\electron.exe', H), 'mantle electron is not helm');
  ok(!T.appOwns('helm', 'C:\\Windows\\chrome.exe', H) && !T.appOwns('zed', 'Quartz.exe', H), 'other exe / app');

  /* start, framing, forwarding */
  {
    const r = rig();
    const st = await r.h.start();
    ok(st.ok && r.net.lastPipe === T.DEFAULT_PIPE, 'start ok on the default pipe');
    const s = r.net.connect();
    const m1 = r.msg();
    r.send(s, m1.slice(0, 20)); r.send(s, m1.slice(20) + '\n');
    await flush();
    ok(r.fw.length === 1 && r.fw[0].hw === '100' && r.fw[0].app === 'quartz' && r.fw[0].top.kind === 'flat', 'split across chunks');
    ok(r.fw[0].meta.seq === 1 && r.fw[0].meta.t === 5 && r.fw[0].meta.recvAt === r.t, 'meta seq/t/recvAt');
    r.send(s, r.msg({ top: { kind: 'flat', rgb: [9, 9, 9] } }) + '\n' + r.msg({ top: { kind: 'flat', rgb: [8, 8, 8] } }) + '\n');
    await flush();
    ok(r.fw.length === 3 && r.fw[2].top.rgb[0] === 8, 'two messages in one chunk');
    r.send(s, r.msg({ top: { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 } }) + '\r\n');
    await flush();
    ok(r.fw.length === 4 && r.fw[3].top.kind === 'wash' && r.fw[3].top.alpha === 0.5, 'CRLF');
    ok(r.calls.length === 1, 'window check ran once (cached)');
    const v = r.h.view();
    ok(v.listening && v.clients === 1 && v.hints.quartz === 1 && v.hints.helm === 0, 'view counts');
    const cols = []; for (let i = 0; i < 600; i++) cols.push([i % 10, 0, 0]);
    r.send(s, r.msg({ top: { kind: 'cols', cols } }) + '\n');
    await flush();
    ok(r.fw.length === 5 && r.fw[4].top.cols.length === 1440, 'cols resampled to 480');

    // 8 KB cap
    const big = 'x'.repeat(3000);
    r.send(s, big); r.send(s, big); r.send(s, big); r.send(s, big + big + big);
    ok(r.h.view().ignored['line over 8 KB'] === 1, 'over-long line counted once');
    r.send(s, 'still the long line\n' + r.msg({ top: { kind: 'flat', rgb: [7, 7, 7] } }) + '\n');
    await flush();
    ok(r.fw.length === 6 && r.fw[5].top.rgb[0] === 7, 'after an over-long line, the next line works');
    r.send(s, '{"pad":"' + 'y'.repeat(9000) + '"}\n');
    ok(r.h.view().ignored['line over 8 KB'] === 2, 'over-long line in one chunk counted');
    const exact = r.msg({ top: { kind: 'flat', rgb: [6, 6, 6] }, pad: '' });
    const padded = exact.slice(0, -1) + ',"z":"' + 'z'.repeat(8192 - exact.length - 7) + '"}';
    ok(Buffer.byteLength(padded) === 8192, 'built an exactly 8 KB line');
    r.send(s, padded + '\r\n');
    await flush();
    ok(r.fw.length === 7 && r.fw[6].top.rgb[0] === 6, 'an exactly 8 KB line (CRLF) is accepted');

    // bad input
    const before = r.fw.length;
    r.send(s, '{nope\n');
    r.send(s, JSON.stringify({ v: 2, app: 'quartz', hwnd: '100', seq: 999, t: 1, top: { kind: 'none' } }) + '\n');
    r.send(s, r.msg({ app: 'chrome' }) + '\n');
    r.send(s, r.msg({ hwnd: '0' }) + '\n' + r.msg({ hwnd: '12a' }) + '\n' + r.msg({ hwnd: 123 }) + '\n' + r.msg({ hwnd: '-5' }) + '\n');
    r.send(s, r.msg({ seq: 1 }) + '\n');
    r.send(s, r.msg({ seq: 1.5 }) + '\n');
    r.send(s, r.msg({ top: { kind: 'flat', rgb: [300, 0, 0] } }) + '\n');
    r.send(s, '\n\n   \n');
    r.send(s, Buffer.from([0xff, 0xfe, 0x00, 0x0a]).toString('latin1'));
    await flush();
    const ig = r.h.view().ignored;
    ok(r.fw.length === before, 'nothing bad was forwarded');
    ok(ig['not valid JSON'] === 2, 'bad JSON counted');
    ok(ig['not protocol v1'] === 1, 'wrong v counted');
    ok(ig['unknown app'] === 1, 'unknown app counted');
    ok(ig['bad hwnd'] === 4, 'bad hwnd counted');
    ok(ig['seq not increasing'] === 1, 'seq not increasing counted');
    ok(ig['bad seq'] === 1, 'bad seq counted');
    ok(ig['bad top (flat)'] === 1, 'bad top counted');
    ok(r.logs.filter((l) => /not valid JSON/.test(l)).length === 1, 'a reason is logged once');
    r.t += 61000;
    r.send(s, '{nope\n');
    ok(r.logs.filter((l) => /not valid JSON/.test(l)).length === 2, 'and again after a minute');

    // kind none forgets; disconnect forgets
    r.send(s, r.msg({ hwnd: '200', top: { kind: 'flat', rgb: [1, 1, 1] } }) + '\n');
    await flush();
    const n0 = r.fw.length;
    r.send(s, r.msg({ hwnd: '200', top: { kind: 'none' } }) + '\n');
    await flush();
    ok(r.fw.length === n0 + 1 && r.fw[n0].hw === '200' && r.fw[n0].top === null, 'kind none forgets (forward null)');
    ok(r.h.view().hints.quartz === 1, 'one hint left');
    s.destroy();
    await flush();
    ok(r.fw[r.fw.length - 1].hw === '100' && r.fw[r.fw.length - 1].top === null && r.h.view().hints.quartz === 0 && r.h.view().clients === 0, 'disconnect forgets');
    // the seq resets for a new connection (an app restart starts over)
    const s2 = r.net.connect();
    r.send(s2, JSON.stringify({ v: 1, app: 'quartz', hwnd: '100', seq: 1, t: 1, top: { kind: 'flat', rgb: [2, 2, 2] } }) + '\n');
    await flush();
    ok(r.fw[r.fw.length - 1].top && r.fw[r.fw.length - 1].top.rgb[0] === 2, 'a new connection may start its seq over');
    ok(r.calls.length === 3 && r.calls[2] === '100', 'a new connection re-checks the window');
    r.h.stop();
  }

  /* process check */
  {
    const r = rig();
    await r.h.start();
    const s = r.net.connect();
    r.procs['300'] = { ok: true, pid: 5, path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' };
    r.send(s, r.msg({ hwnd: '300' }) + '\n');
    await flush();
    ok(r.fw.length === 0 && r.h.view().ignored['window is not that app\'s'] === 1, 'check fails: a foreign window is ignored');
    r.send(s, r.msg({ hwnd: '300' }) + '\n');
    await flush();
    ok(r.calls.length === 1 && r.h.view().ignored['window is not that app\'s'] === 2, 'a failure is cached');
    r.procs['300'] = QUARTZ;
    r.t += 31000;
    r.send(s, r.msg({ hwnd: '300' }) + '\n');
    await flush();
    ok(r.calls.length === 2 && r.fw.length === 1, 'a failure is re-checked after 30 s');
    // pending: two messages before the check answers -> only the latest goes out
    r.send(s, r.msg({ hwnd: '400', top: { kind: 'flat', rgb: [1, 0, 0] } }) + '\n' + r.msg({ hwnd: '400', top: { kind: 'flat', rgb: [2, 0, 0] } }) + '\n');
    await flush();
    ok(r.fw.length === 2 && r.fw[1].top.rgb[0] === 2 && r.calls.filter((c) => c === '400').length === 1, 'while a check runs, the latest message waits');
    // pid change: an ok window re-verified after 30 s now belongs to something else
    r.t += 31000;
    r.procs['400'] = { ok: true, pid: 99, path: 'C:\\Windows\\notepad.exe' };
    r.send(s, r.msg({ hwnd: '400', top: { kind: 'flat', rgb: [3, 0, 0] } }) + '\n');
    await flush();
    const last = r.fw[r.fw.length - 1];
    ok(r.fw[r.fw.length - 2].top.rgb[0] === 3 && last.hw === '400' && last.top === null, 'pid change: re-verified, the hint is dropped');
    const nf = r.fw.length;
    r.send(s, r.msg({ hwnd: '400' }) + '\n');
    await flush();
    ok(r.fw.length === nf, 'and the window is ignored after');
    // pid change, still the app's
    r.procs['500'] = { ok: true, pid: 1, path: QUARTZ.path };
    r.send(s, r.msg({ hwnd: '500' }) + '\n');
    await flush();
    r.t += 31000;
    r.procs['500'] = { ok: true, pid: 2, path: QUARTZ.path };
    r.send(s, r.msg({ hwnd: '500' }) + '\n');
    await flush();
    ok(r.h.view().hints.quartz === 2 && r.logs.some((l) => /now belongs to process 2/.test(l)), 'pid change, same app: kept, logged');
    // procOf that throws
    r.procs['600'] = new Error('sidecar gone');
    r.send(s, r.msg({ hwnd: '600' }) + '\n');
    await flush();
    ok(r.h.view().ignored['window check failed'] === 1, 'a throwing check counts as failed');
    // helm: Helm path for a quartz message fails, for helm passes
    r.procs['700'] = HELM;
    r.send(s, r.msg({ hwnd: '700', app: 'helm' }) + '\n');
    await flush();
    ok(r.h.view().hints.helm === 1, 'helm window from ~/helm passes');
    r.h.stop();
  }

  /* light theme, resendAll, forget, mismatch, a throwing forward */
  {
    const r = rig();
    await r.h.start();
    const s = r.net.connect();
    r.dark = false;
    r.send(s, r.msg() + '\n');
    await flush();
    ok(r.fw.length === 0 && r.h.view().ignored['light theme'] === 1 && r.calls.length === 0, 'light theme: ignored, no check');
    r.dark = true;
    r.send(s, r.msg({ hwnd: '100' }) + '\n' + r.msg({ hwnd: '101' }) + '\n');
    await flush();
    ok(r.fw.length === 2, 'dark: forwarded');
    r.dark = false;
    r.h.resendAll();
    ok(r.fw.length === 4, 'resendAll forwards every kept hint');
    r.send(s, r.msg({ hwnd: '101' }) + '\n');
    await flush();
    ok(r.fw.length === 5 && r.fw[4].hw === '101' && r.fw[4].top === null, 'light theme: a new look for a kept window drops the stale one');
    r.dark = true;
    await flush();
    ok(r.fw.length === 5, 'dark again: nothing replayed by itself');
    r.h.resendAll();
    ok(r.fw.length === 6 && r.fw[5].hw === '100' && r.fw[5].meta === r.fw[0].meta, 'resendAll after dark returns: the kept one, same meta');
    r.h.forget('100');
    ok(r.fw.length === 6 && r.h.view().hints.quartz === 0, 'forget: no forward, gone');
    r.h.mismatch('quartz', '100', 'capture off by 20 levels');
    r.h.mismatch('quartz', '100', 'capture off by 20 levels');
    ok(r.logs.filter((l) => /disagreed/.test(l)).length === 1, 'mismatch logged once');
    const v = r.h.view();
    ok(v.apps.quartz.mismatch === 'capture off by 20 levels' && v.apps.quartz.since === r.t && v.apps.helm.mismatch === null, 'mismatch state per app');
    r.h.mismatch('helm', '9', 'capture off by 20 levels');
    ok(r.logs.filter((l) => /disagreed/.test(l)).length === 2, 'mismatch logged once per app');
    r.h.confirmed('quartz');
    ok(r.h.view().apps.quartz.mismatch === null && r.h.view().apps.helm.mismatch, 'confirmed clears that app only');
    r.h.mismatch('quartz', '100', 'capture off by 20 levels');
    ok(r.logs.filter((l) => /disagreed/.test(l)).length === 2 && r.h.view().apps.quartz.mismatch, 'same reason again: state set, not logged again');
    r.h.stop();

    const r2 = rig({ forward: () => { throw new Error('boom'); } });
    await r2.h.start();
    const s2 = r2.net.connect();
    let threw = false;
    try { r2.send(s2, r2.msg() + '\n'); await flush(); s2.destroy(); await flush(); } catch (_) { threw = true; }
    ok(!threw && r2.logs.some((l) => /bug in forward/.test(l)), 'a throwing forward never escapes');
    r2.h.stop();
  }

  /* EADDRINUSE (fake) and the retry */
  {
    const r = rig();
    r.net.busy = true;
    const st = await r.h.start();
    ok(!st.ok && /already listening/.test(st.reason) && !r.h.view().listening && r.h.view().reason === st.reason, 'busy pipe: plain reason, view says why');
    r.net.busy = false;
    await sleep(120);
    ok(r.h.view().listening && r.h.view().reason === null, 'busy pipe is retried');
    r.h.stop();
  }
}

/* ---- washRow --------------------------------------------------------------------------------------- */
function pic(w, h, f) { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); const i = (y * w + x) * 4; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; } return { w, h, data: d }; }
/** Reference: draw the still cover-fit on the screen (nearest), blur it there with sigma = blur*dpr phys
 * px (mirrored at the screen edges: these tests keep the kernel off the edges), average n columns. */
function reference(p, map, n, blurPx) {
  const d = map.display, st = map.strip, s = Math.max(d.w / p.w, d.h / p.h);
  const ox = (p.w * s - d.w) / 2, oy = (p.h * s - d.h) / 2, sig = blurPx * (map.dpr || 1);
  const at = (X, Y) => { const u = Math.min(p.w - 1, Math.max(0, Math.floor((X + 0.5 - d.x + ox) / s))), v = Math.min(p.h - 1, Math.max(0, Math.floor((Y + 0.5 - d.y + oy) / s))); return p.data[(v * p.w + u) * 4]; };
  const rad = Math.ceil(3 * sig), ker = []; let sum = 0;
  for (let k = -rad; k <= rad; k++) { const v = Math.exp(-(k * k) / (2 * sig * sig)); ker.push(v); sum += v; }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = st.x + st.w * i / n, b = st.x + st.w * (i + 1) / n;
    let acc = 0, cnt = 0;
    for (let X = Math.floor(a); X < Math.ceil(b); X++) {
      let v = 0;
      for (let j = -rad; j <= rad; j++) for (let k = -rad; k <= rad; k++) v += ker[j + rad] * ker[k + rad] * at(X + k, st.y + j);
      acc += v / (sum * sum); cnt++;
    }
    out.push(acc / cnt);
  }
  return out;
}
function washTests() {
  // a vertical (non-linear) gradient, cover 2x, dpr 1.5, blur 5
  const g = pic(200, 100, (x, y) => Math.round(255 * (y / 99) * (y / 99)));
  const map = { display: { x: 0, y: 0, w: 400, h: 200 }, strip: { x: 0, y: 60, w: 400 }, dpr: 1.5 };
  const w1 = T.washRow(g, map, 4, 5);
  const ref = reference(g, map, 4, 5);
  let worst = 0; for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(w1[i * 3] - ref[i]), Math.abs(w1[i * 3 + 2] - ref[i]));
  ok(w1.length === 12 && worst <= 2, `vertical gradient matches the blurred reference within 2 levels (worst ${worst.toFixed(2)}, got ${w1[0]}, want ${ref[0].toFixed(2)})`);
  const unblurred = Math.round(255 * Math.pow((60.5 / 2 - 0.5) / 99, 2));
  ok(Math.abs(w1[0] - unblurred) <= 2, 'and close to the row itself (the gradient is smooth)');
  // left/right split, a wider picture cover-cropped, on a second monitor
  const sp = pic(300, 100, (x) => (x < 150 ? 0 : 255));
  const m2 = { display: { x: 1920, y: 0, w: 200, h: 100 }, strip: { x: 1920, y: 40, w: 200 }, dpr: 1 };
  const w2 = T.washRow(sp, m2, 8, 2);
  const r2 = reference(sp, m2, 8, 2);
  let worst2 = 0, mono = true;
  for (let i = 0; i < 8; i++) { worst2 = Math.max(worst2, Math.abs(w2[i * 3] - r2[i])); if (i && w2[i * 3] < w2[(i - 1) * 3]) mono = false; }
  ok(w2[0] <= 2 && w2[3] <= 2 && w2[5 * 3] >= 253 && w2[7 * 3] >= 253 && mono, `split: columns follow, centred cover (${Array.from(w2.filter((_, i) => i % 3 === 0)).join(',')})`);
  ok(w2[4 * 3 - 3] < 20 && w2[4 * 3] > 235 && worst2 <= 2, `split: the edge falls between columns 3 and 4 and matches the reference (worst ${worst2.toFixed(2)})`);
  // a strip narrower than the display, shifted right
  const m3 = { display: { x: 1920, y: 0, w: 200, h: 100 }, strip: { x: 2020, y: 40, w: 100 }, dpr: 1 };
  const w3 = T.washRow(sp, m3, 2, 2);
  ok(w3[0] >= 250 && w3[3] >= 253, 'a strip on the right half is all white');
  // a crop gives the same answer as the whole picture (washRowFor's band)
  const two = pic(320, 180, (x, y) => Math.round((x * 0.6 + y * 0.8) % 256));
  const m4 = { display: { x: 0, y: 0, w: 640, h: 360 }, strip: { x: 100, y: 50, w: 400 }, dpr: 1.25 };
  const whole = T.washRow(two, m4, 16, 5);
  const plan = T.washPlan(320, 180, m4.display, m4.strip, 5, 1.25);
  const c = plan.src, cd = new Uint8ClampedArray(c.width * c.height * 4);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) for (let k = 0; k < 4; k++) cd[(y * c.width + x) * 4 + k] = two.data[((y + c.y) * 320 + x + c.x) * 4 + k];
  const part = T.washRow({ w: c.width, h: c.height, data: cd }, Object.assign({}, m4, { full: { w: 320, h: 180 }, crop: { x: c.x, y: c.y } }), 16, 5);
  let worst4 = 0; for (let i = 0; i < whole.length; i++) worst4 = Math.max(worst4, Math.abs(whole[i] - part[i]));
  ok(plan.src.height < 180 && worst4 <= 1, `a band crop matches the whole picture (worst ${worst4}, band ${c.width}x${c.height})`);
  // no blur: just the row
  const w5 = T.washRow(g, Object.assign({}, map, { strip: { x: 0, y: 61, w: 400 } }), 1, 0);
  const v30 = Math.round(255 * Math.pow(30 / 99, 2)), v31 = Math.round(255 * Math.pow(31 / 99, 2));
  ok(Math.abs(w5[0] - (0.75 * v30 + 0.25 * v31)) <= 1, 'blur 0 samples the row itself (bilinear between pixel centres)');
  // a big blur plans a smaller picture
  const pb = T.washPlan(2560, 1440, { x: 0, y: 0, w: 2560, h: 1440 }, { x: 0, y: 40, w: 2560 }, 40, 1.5);
  ok(pb && Math.abs(pb.f - 8 / 60) < 1e-9 && pb.out.w <= 2560 * pb.f + 1, 'a big blur works on a smaller picture');
}

/* ---- end to end: a real pipe, a real client, the fake-client tool ------------------------------ */
async function e2e() {
  const name = `look-sync-toprow-test-${process.pid}-${Date.now()}`;
  const fw = [];
  const logs = [];
  const h = T.makeHints({ pipeName: name, procOf: async () => QUARTZ, dark: () => true, forward: (hw, app, top, meta) => fw.push({ hw, app, top, meta }), log: (m) => logs.push(m) });
  const st = await h.start();
  ok(st.ok && h.view().listening, 'real pipe listens');
  const h2 = T.makeHints({ pipeName: name, procOf: async () => QUARTZ, dark: () => true, forward: () => {}, log: () => {} });
  const st2 = await h2.start();
  ok(!st2.ok && /already listening/.test(st2.reason || ''), `a second listener gets EADDRINUSE in plain words (${st2.reason})`);
  h2.stop();

  const c = net.connect(T.pipePath(name));
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); });
  c.write(JSON.stringify({ v: 1, app: 'quartz', hwnd: '4242', seq: 1, t: Date.now(), top: { kind: 'wash', rgb: [20, 30, 40], alpha: 0.5 } }) + '\n');
  for (let i = 0; i < 100 && fw.length < 1; i++) await sleep(10);
  ok(fw.length === 1 && fw[0].hw === '4242' && fw[0].top.kind === 'wash', 'real client: forward called');
  c.end();
  for (let i = 0; i < 100 && fw.length < 2; i++) await sleep(10);
  ok(fw.length === 2 && fw[1].top === null, 'real client disconnect: forgotten');

  // the fake-client tool, line mode
  const tool = path.join(__dirname, '..', 'tools', 'toprow-fake-client.js');
  const ch = spawn(process.execPath, [tool, '--pipe', name, '--app', 'quartz', '--hwnd', '777', '--stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  ch.stdout.on('data', (d) => { out += d; });
  await sleep(300);
  ch.stdin.write('{"kind":"flat","rgb":[5,6,7]}\n');
  ch.stdin.write('hwnd 778\n{"kind":"cols","cols":[[1,2,3],[4,5,6]]}\n');
  for (let i = 0; i < 200 && fw.length < 4; i++) await sleep(10);
  ok(fw.length === 4 && fw[2].hw === '777' && fw[2].top.rgb[2] === 7 && fw[3].hw === '778' && fw[3].top.cols.length === 6, 'fake client line mode reaches Mantle');
  ok(/^sent \d+\.\d \d+$/m.test(out), `fake client prints "sent <wall ms> <seq>" (${out.trim().split('\n')[0]})`);
  ch.stdin.end();
  const code = await new Promise((res) => { ch.on('exit', res); setTimeout(() => res('timeout'), 4000); });
  ok(code === 0, `fake client exits on EOF (${code})`);
  for (let i = 0; i < 100 && fw.length < 6; i++) await sleep(10);
  ok(fw.length === 6 && fw[4].top === null && fw[5].top === null, 'its disconnect forgets both windows');
  h.stop();

  // the tool with no server: no throw, exit 2
  const nos = spawn(process.execPath, [tool, '--pipe', name + '-nobody', '--hwnd', '1', '--top', '{"kind":"none"}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o2 = '', e2 = '';
  nos.stdout.on('data', (d) => { o2 += d; }); nos.stderr.on('data', (d) => { e2 += d; });
  const code2 = await new Promise((res) => { nos.on('exit', res); setTimeout(() => res('timeout'), 4000); });
  ok(code2 === 2 && /no server/.test(o2) && !e2, `fake client with no server: exit 2, no throw (${code2}, ${e2.trim()})`);
}

(async () => {
  try { await unit(); } catch (e) { failed++; process.stdout.write(`FAIL unit threw: ${e.stack}\n`); }
  try { washTests(); } catch (e) { failed++; process.stdout.write(`FAIL washRow threw: ${e.stack}\n`); }
  try { await e2e(); } catch (e) { failed++; process.stdout.write(`FAIL e2e threw: ${e.stack}\n`); }
  process.stdout.write(`TOPROW HINTS: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
