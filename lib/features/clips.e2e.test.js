'use strict';
/*
 * clips.e2e.test.js - Win+G's Record panel and the Clips gallery END TO END in a hidden --test Mantle
 * of this checkout (lane mantle-clips2, 2026-10-15), with the FAKE recorder (lib/features/_clips-fake.js):
 * NO real Win+Alt+R is ever sent (the incident rule), the folder is a temp folder of stand-in files
 * (never Owen's Captures), the windows are invisible (lib/test-quiet.js).
 *   node lib/features/clips.e2e.test.js     -> "CLIPS E2E TEST: n passed, m failed"
 *   (MANTLE_SIDECAR_EXE=<a build with sidecar/ClipsEncode.cs> for the re-encode fallback's real answer)
 * Checks: open times (Win+G -> the panel's first frame: warm <= 50 ms, cold p95 <= 400 ms), the panel's
 * and the gallery's process RAM, the windows gone when closed/idle (nothing kept in the background),
 * a fake recording seen start to end (the panel's clock runs), the gallery lists the temp folder, a
 * lossless trim to a new file, the re-encode fallback's answer, delete + undo, Win+G handed to the Game
 * Bar in exclusive full screen (the fake opener) and taken back when it ends.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const M = require('./_clips-mp4');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'clipse2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-clips-e2e-'));
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 100); } }
const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null; };

/* a stand-in movie: 60 frames at 30 fps, keyframes every 30 (video only, a valid index) */
function standInMovie(file) {
  const { _box: box, _full: full, _u32s: u32s } = M;
  const n = 60, sizes = [], frames = [];
  for (let i = 0; i < n; i++) { const b = Buffer.alloc(150 + (i % 30 ? 0 : 500), i & 255); frames.push(b); sizes.push(b.length); }
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1mp41', 'latin1'));
  const offs = []; let o = ftyp.length + 8; for (const b of frames) { offs.push(o); o += b.length; }
  const tk = Buffer.alloc(80); tk.writeUInt32BE(1, 8); tk.writeUInt32BE(2000, 16); tk.writeUInt32BE(1280 * 65536, 72); tk.writeUInt32BE(720 * 65536, 76);
  const moov = box('moov', full('mvhd', 0, 0, u32s([0, 0, 1000, 2000]), Buffer.alloc(80)), box('trak', full('tkhd', 0, 3, tk),
    box('mdia', full('mdhd', 0, 0, u32s([0, 0, 90000, n * 3000]), Buffer.from([0x55, 0xc4, 0, 0])), full('hdlr', 0, 0, u32s([0]), Buffer.from('vide', 'latin1'), Buffer.alloc(12), Buffer.from('x\0', 'latin1')),
      box('minf', full('vmhd', 0, 1, Buffer.alloc(8)), box('stbl', full('stsd', 0, 0, u32s([0])), full('stts', 0, 0, u32s([1, n, 3000])), full('stss', 0, 0, u32s([2, 1, 31])),
        full('stsc', 0, 0, u32s([1, 1, 1, 1])), full('stsz', 0, 0, u32s([0, n, ...sizes])), full('stco', 0, 0, u32s([n, ...offs])))))));
  fs.writeFileSync(file, Buffer.concat([ftyp, box('mdat', Buffer.concat(frames)), moov]));
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const env = Object.assign({}, process.env, { MANTLE_CLIPS_FAKE: '1', MANTLE_CLIPS_DIR: DIR, MANTLE_CLIPS_FAKE_START_MS: '600', MANTLE_IDLE_UNLOAD_MS: '400', MANTLE_CLIPS_AWAY_POLL_MS: '500' });
  delete env.MANTLE_TEST_VISIBLE;
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
async function targets(port) { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page' && /\/ui\//.test(t.url)); }
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let n = 0; const pend = new Map();
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); } });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++n; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

let skipped = null;
async function main() {
  if (process.env.CI === 'true') { skipped = 'on CI'; return; }
  const g = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
  if (String(g.stdout).trim() !== '0') { skipped = 'a game is running'; return; }
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(DIR, `Mantle stand-in 2026-10-1${i} 2${i}-00-00.${i === 3 ? 'png' : 'mp4'}`), Buffer.alloc(2048, i));
  standInMovie(path.join(DIR, 'Mantle stand-in movie 2026-10-15 22-30-00.mp4'));
  const run = launch();
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 45000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const dbg = () => bar.ev(call('clips.debug'));
    const d0 = await until(async () => { const d = await dbg(); return d && d.ok ? d : null; }, 20000, 300);
    if (!check('clips.debug answers (the feature runs, test mode)', !!d0, run.out.slice(-600))) return;
    check('the folder is the temp folder, never Captures', path.resolve(d0.folder) === path.resolve(DIR), d0.folder);
    check('nothing is made before Win+G (no window, no poll, no watch)', !d0.panel && !d0.gallery && !d0.polling && !d0.watching, d0);

    // ---- open times: cold (window made) and warm (hidden window shown again)
    const cold = [], warm = [];
    for (let i = 0; i < 10; i++) {
      for (const kind of ['cold', 'warm']) {
        const n0 = (await dbg()).opens.length;
        const r = await bar.ev(call('clips.panel', { via: 'the e2e' }));
        if (!r || r.to !== 'panel') { check(`clips.panel opens the panel (${kind} ${i})`, false, r); break; }
        const d = await until(async () => { const x = await dbg(); return x.opens.length > n0 ? x : null; }, 5000, 15);
        if (!d) { check(`the ${kind} open is painted within 5 s`, false, await dbg()); break; }
        const o = d.opens[d.opens.length - 1];
        (o.cold ? cold : warm).push(o.ms);
        if (i === 0 && kind === 'cold') check('the first open made the window', o.cold === true, o);
        await bar.ev(call('clips.close', { why: 'the e2e' }));
      }
      await until(async () => (!(await dbg()).panel ? true : null), 3000, 50);   // idle-unloaded (MANTLE_IDLE_UNLOAD_MS=400)
    }
    const cp95 = pct(cold, 0.95), wmax = Math.max(...warm), wp95 = pct(warm, 0.95);
    console.log(`info: panel open (Win+G -> first frame) cold n=${cold.length} p50 ${pct(cold, 0.5)} p95 ${cp95} ms; warm n=${warm.length} p50 ${pct(warm, 0.5)} p95 ${wp95} max ${wmax} ms`);
    check('cold open p95 <= 400 ms', cold.length >= 8 && cp95 <= 400, cold);
    check('warm open <= 50 ms (p95)', warm.length >= 8 && wp95 <= 50, warm);
    const dGone = await dbg();
    check('the panel window is destroyed after its idle wait', !dGone.panel, dGone.panel);

    // ---- a fake recording, start to end; the panel's clock runs
    await bar.ev(call('clips.panel', { via: 'the e2e' }));
    const recT = await until(async () => (await targets(port)).find((t) => /\/ui\/clips\/record\.html/.test(t.url)) || null, 5000, 100);
    const panel = recT ? await attach(recT) : null; if (panel) open.push(panel);
    const dP = await dbg();
    const pm = dP.panel && dP.panel.memory;
    if (pm) console.log(`info: record panel process: working set ${(pm.workingSetSize / 1024).toFixed(1)} MB, private ${(pm.privateBytes / 1024).toFixed(1)} MB`);
    check('the panel\'s process RAM is read', !!pm, dP.panel);
    const r1 = await bar.ev(call('clips.record'));
    check('Record: the fake recorder gets the keys (never a real Win+Alt+R)', r1 && r1.ok === true && !r1.dryRun, r1);
    const on = await until(async () => { const d = await dbg(); return d.rec.on ? d : null; }, 8000, 200);
    check('the recording is seen by its growing file', !!on && /^Mantle stand-in /.test(on.rec.file || ''), on && on.rec);
    if (panel) {
      const ps = await until(async () => { const s = await panel.ev('window.__clipsPanel.state()'); return s.recording && s.ticking ? s : null; }, 4000, 150);
      check('the panel shows Recording, Stop and a running clock', !!ps && ps.button.label === 'Stop', ps || await panel.ev('window.__clipsPanel.state()'));
    }
    await sleep(1200);
    const r2 = await bar.ev(call('clips.record'));
    check('Stop: the keys again', r2 && r2.ok === true, r2);
    const off = await until(async () => { const d = await dbg(); return !d.rec.on ? d : null; }, 9000, 250);
    check('the recording ends when the file stops growing', !!off, (await dbg()).rec);
    const offPoll = await until(async () => (!(await dbg()).polling ? true : null), 3000, 200);
    check('... and nothing polls after it', !!offPoll);
    await bar.ev(call('clips.close', { why: 'the e2e' }));
    if (panel) panel.close();

    // ---- the gallery
    const tg0 = Date.now();
    const go = await bar.ev(call('clips.open', {}));
    const galT = await until(async () => (await targets(port)).find((t) => /\/ui\/clips\/index\.html/.test(t.url)) || null, 8000, 50);
    if (!check('Clips opens its window', go && go.ok && !!galT, go)) return;
    const gal = await attach(galT); open.push(gal);
    const listed = await until(async () => { try { const s = await gal.ev('window.__clips && window.__clips.state()'); return s && s.cards >= 7 ? s : null; } catch (_) { return null; } }, 8000, 30);
    const gMs = Date.now() - tg0;
    check('the gallery lists the temp folder (7 stand-ins + the recording)', !!listed, await gal.ev('window.__clips && window.__clips.state()').catch((e) => e.message));
    console.log(`info: gallery: Open -> cards on the page in ${gMs} ms (window made)`);
    const thumbs = await until(async () => { const s = await gal.ev('window.__clips.state()'); return s.painted >= 5 ? s : null; }, 6000, 100);
    check('stand-in thumbnails come in and paint', !!thumbs, await gal.ev('window.__clips.state()'));
    const dG = await dbg();
    const gm = dG.gallery && dG.gallery.memory;
    if (gm) console.log(`info: gallery process: working set ${(gm.workingSetSize / 1024).toFixed(1)} MB, private ${(gm.privateBytes / 1024).toFixed(1)} MB`);
    check('the gallery\'s process RAM is read', !!gm, dG.gallery);
    check('the folder is watched only while the gallery is open', dG.watching === true);

    // trim: lossless to a NEW file; the layout the cut refuses goes to Windows' encoder
    const mv = 'Mantle stand-in movie 2026-10-15 22-30-00.mp4';
    const tr = await gal.ev(call('clips.trim', { name: mv, startMs: 500, endMs: 1500 }));
    check('a lossless trim makes a new file and keeps the original', tr && tr.ok && tr.lossless && fs.existsSync(path.join(DIR, tr.name)) && fs.existsSync(path.join(DIR, mv)), tr);
    fs.writeFileSync(path.join(DIR, 'frag 2026-10-15 22-40-00.mp4'), Buffer.concat([M._box('ftyp', Buffer.from('isom', 'latin1')), M._box('moov', M._full('mvhd', 0, 0, M._u32s([0, 0, 1000, 0]), Buffer.alloc(80))), M._box('moof', Buffer.alloc(8)), M._box('mdat', Buffer.alloc(8))]));
    const tf = await gal.ev(call('clips.trim', { name: 'frag 2026-10-15 22-40-00.mp4', startMs: 0, endMs: 1000 }));
    check('a fragmented clip goes to the re-encode, and its failure is said in plain words', tf && tf.ok === false && /fragmented/.test(tf.why) && /re-encode/.test(tf.why), tf);
    console.log(`info: re-encode fallback answer: ${tf && tf.why}`);

    // delete + undo (the fake's bin)
    const victim = 'Mantle stand-in 2026-10-11 21-00-00.mp4';
    const de = await gal.ev(call('clips.delete', { name: victim }));
    check('delete: gone from the folder, with an undo token', de && de.ok && de.undo && !fs.existsSync(path.join(DIR, victim)), de);
    const un = await gal.ev(call('clips.undo', { token: de && de.undo }));
    check('undo: back in the folder', un && un.ok && fs.existsSync(path.join(DIR, victim)), un);

    // ---- Win+G in exclusive full screen: the Game Bar (fake opener), then Mantle's again
    await bar.ev(call('clips.fake', { quns: 3 }));
    const gb = await bar.ev(call('clips.panel', { via: 'Win+G' }));
    const dA = await dbg();
    check('exclusive full screen: Win+G goes to Windows\' Game Bar (opened once)', gb && gb.to === 'gamebar' && dA.gamebar.n === 1 && !!dA.away, { gb, gamebar: dA.gamebar, away: dA.away });
    await bar.ev(call('clips.fake', { quns: 5 }));
    const back = await until(async () => { const d = await dbg(); return !d.away ? d : null; }, 4000, 100);
    check('... and Win+G is Mantle\'s again within the backstop (500 ms here) once it ends', !!back, await dbg());
    if (back) console.log(`info: Win+G taken back after ${back.awayChecks} check(s)`);

    // ---- closing the gallery leaves nothing behind
    await gal.ev(call('clips.win', { op: 'close' })).catch(() => null);
    const gone = await until(async () => { const d = await dbg(); return !d.gallery && !d.watching ? d : null; }, 5000, 100);
    check('closing Clips destroys its window and stops the folder watch', !!gone, await dbg());
    const q = await bar.ev(call('shell.quit')).catch((e) => ({ threw: e.message }));
    check('shell.quit: the instance exits', !!(await until(() => run.exited, 30000, 250)), q);
  } finally {
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}

main().catch((err) => { failures.push(`threw: ${err.stack}`); }).finally(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* in use */ }
  if (skipped) console.log(`CLIPS E2E TEST: skipped (${skipped})`);
  console.log(`CLIPS E2E TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
});
