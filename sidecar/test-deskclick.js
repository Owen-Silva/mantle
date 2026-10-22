'use strict';
// Functional test: the desktop right-click hook (sidecar/DeskClick.cs; lane mantle-deskmenu, 2026-10-15).
//
// Drives the REAL sidecar (passive) against tools/fake-progman.cs "desk": a stand-in desktop
// (MantleFakeProgman > SHELLDLL_DefView > SysListView32) off every monitor. A real low-level mouse hook
// is installed, but a passive sidecar only ever takes clicks on the stand-in's class, so nothing on
// the user's screen is touched, and no input is ever made: deskmenu.testclick runs one right-click
// through the hook's own decision on the hook thread.
//   1. passive without a stand-in class is refused; armed with one = hooked;
//   2. the empty stand-in desktop: the down and the up are kept, 'down' + 'open' events with a seq;
//      main's ack stops the fallback;
//   3. Shift+right-click passes (Explorer's menu); a point that is not the desktop passes;
//   4. no ack in time: a 'fallback' event (a passive sidecar never clicks), two in a row stand the hook
//      down (everything passes) until main arms it again;
//   5. desktop icons shown: passes (the click may be on an icon);
//   6. EXPLORER RESTART: the stand-in killed and a new one made: the next click is taken (nothing cached);
//   7. HOOK HEALTH: the hook dropped the way Windows drops it, input after it: re-installed once, logged;
//      a second check waits for the new hook to be called first;
//   8. the decision on a right button is far under the 1 ms hook budget (p95), and idle costs no CPU;
//   9. disarm unhooks; quit with the hook in exits cleanly.
// Prints "DESKCLICK TEST: n passed, m failed".
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const ROOT = path.join(__dirname, '..');
const FAKE_SRC = path.join(ROOT, 'tools', 'fake-progman.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const DESK = { x: -30000, y: -30000, w: 400, h: 300 };
const IN = { x: DESK.x + 200, y: DESK.y + 150 };
const C = T.checker('DESKCLICK');
const check = C.check || ((n, ok, d) => C(n, ok, d));
const J = (x) => JSON.stringify(x).slice(0, 300);

function fakeExe() {
  const src = fs.readFileSync(FAKE_SRC);
  const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const dir = path.join(os.tmpdir(), 'mantle-fake-progman');
  const exe = path.join(dir, `fake-progman-${tag}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(CSC, ['-nologo', '-optimize', `-out:${exe}`, FAKE_SRC], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('csc could not build tools/fake-progman.cs: ' + ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 400));
  return exe;
}
async function startDesk(exe, icons) {
  const f = { out: '' };
  f.proc = spawn(exe, ['desk'].concat(icons ? ['icons'] : []), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  f.proc.stdout.on('data', (c) => { f.out += c.toString('utf8'); });
  const end = Date.now() + 8000;
  while (!/^desk /m.test(f.out) && Date.now() < end) await T.sleep(50);
  const m = /^desk ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)/m.exec(f.out);
  f.ok = !!m;
  if (m) { f.progman = String(parseInt(m[1], 16)); f.defview = String(parseInt(m[2], 16)); f.list = String(parseInt(m[3], 16)); }
  // the window Windows would report under the cursor: the icon list when it shows, else the icon layer
  f.at = m ? Object.assign({ under: icons ? f.list : f.defview }, IN) : IN;
  return f;
}
function killDesk(f) { if (f && f.proc && f.proc.exitCode === null) { try { process.kill(f.proc.pid); } catch (_) { /* gone */ } } }
const evs = (s, from, op) => s.events.slice(from).filter((e) => e.ev === 'deskmenu' && (!op || e.op === op));

(async () => {
  let s = null;
  const desks = [];
  try {
    const exe = fakeExe();
    let desk = await startDesk(exe, false);
    desks.push(desk);
    if (!check('the stand-in desktop starts', desk.ok, desk.out)) return;
    s = await T.startPassive({ exe: process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe') });

    // 1. arming
    let refused = null;
    try { await s.call('deskmenu.arm', { on: true }); } catch (e) { refused = e.message; }
    check('passive, no stand-in class: refused (a test never takes the real desktop)', /passive/.test(refused || '') && /real desktop/.test(refused || ''), refused);
    let st = await s.call('deskmenu.arm', { on: true, testClass: 'MantleFakeProgman', ackMs: 400 });
    check('armed on the stand-in: hooked', st.armed === true && st.hooked === true && st.testClass === 'MantleFakeProgman', J(st));

    // 2. the empty desktop
    let from = s.events.length;
    let r = await s.call('deskmenu.testclick', desk.at);
    check('right-click on the empty stand-in desktop: down AND up kept', r.taken === true && r.down === true && r.up === true, J(r));
    await T.sleep(50);
    const down = evs(s, from, 'down')[0], open = evs(s, from, 'open')[0];
    check('a down event then an open event with the same seq and the point (physical px)', !!down && !!open && down.seq === open.seq && open.x === IN.x && open.y === IN.y, J(evs(s, from)));
    const a = await s.call('deskmenu.ack', { seq: open ? open.seq : -1 });
    check('main\'s ack is taken', a.acked === true, J(a));
    await T.sleep(600);
    check('acked in time: no fallback', evs(s, from, 'fallback').length === 0, J(evs(s, from)));
    const late = await s.call('deskmenu.ack', { seq: open ? open.seq : -1 });
    check('a second ack for the same seq is not taken again', late.acked === false, J(late));

    // 3. passes
    r = await s.call('deskmenu.testclick', Object.assign({ shift: true }, desk.at));
    check('Shift+right-click passes to Explorer', r.taken === false && r.why === 'shift', J(r));
    r = await s.call('deskmenu.testclick', { x: 5, y: 500 });   // the REAL WindowFromPoint, on the user's real screen: never the stand-in
    check('a right-click on a real window (not the stand-in desktop) passes', r.taken === false && /not the desktop|nothing under/.test(r.why || ''), J(r));

    // 4. no ack: fallback, then stand down
    from = s.events.length;
    await s.call('deskmenu.testclick', desk.at);
    await T.sleep(700);
    const fb = evs(s, from, 'fallback');
    check('no ack within ackMs: a fallback event saying why (a passive sidecar never clicks)', fb.length === 1 && fb[0].replayed === false && /did not open within 400 ms/.test(fb[0].why || '') && fb[0].standDown === false, J(fb));
    const logs = s.events.slice(from).filter((e) => e.ev === 'log' && /desktop right-click/.test(e.message || ''));
    check('...and one log line in plain words', logs.length === 1 && /test sidecar never clicks/.test(logs[0].message), J(logs));
    await s.call('deskmenu.testclick', desk.at);
    await T.sleep(700);
    st = await s.call('deskmenu.status');
    check('two misses in a row: the hook stands down and says why', st.standDown === true && /2 times in a row/.test(st.standWhy || ''), J(st));
    r = await s.call('deskmenu.testclick', desk.at);
    check('...standing down, a desktop right-click passes to Explorer', r.taken === false, J(r));
    st = await s.call('deskmenu.arm', { on: true, testClass: 'MantleFakeProgman', ackMs: 400 });
    r = await s.call('deskmenu.testclick', desk.at);
    check('main arming again ends the stand-down', st.standDown === false && r.taken === true, J({ st, r }));
    await s.call('deskmenu.ack', { seq: r.seq });

    // 4b. main cannot show it: nack = the click goes to Explorer at once, with main's reason
    from = s.events.length;
    r = await s.call('deskmenu.testclick', desk.at);
    const nk = await s.call('deskmenu.nack', { seq: r.seq, why: 'the desktop layer is not there' });
    await T.sleep(100);
    const nf = evs(s, from, 'fallback');
    check('nack: taken, and a fallback event with the reason main gave at once (no ackMs wait)', nk.taken === true && nf.length === 1 && /could not open: the desktop layer is not there/.test(nf[0].why || ''), J({ nk, nf }));
    await s.call('deskmenu.arm', { on: true, testClass: 'MantleFakeProgman', ackMs: 400 });

    // 5. icons shown
    killDesk(desk);
    await T.sleep(300);
    desk = await startDesk(exe, true);
    desks.push(desk);
    r = await s.call('deskmenu.testclick', desk.at);
    check('desktop icons shown: the right-click stays Explorer\'s (it may be on an icon)', desk.ok && r.taken === false && r.why === 'icons', J(r));

    // 6. Explorer restart
    killDesk(desk);
    await T.sleep(300);
    r = await s.call('deskmenu.testclick', desk.at);
    check('Explorer gone (no desktop at that point): passes', r.taken === false, J(r));
    desk = await startDesk(exe, false);
    desks.push(desk);
    from = s.events.length;
    r = await s.call('deskmenu.testclick', desk.at);
    check('EXPLORER RESTART: the new desktop\'s right-click is taken (nothing was cached)', desk.ok && r.taken === true, J(r));
    await s.call('deskmenu.ack', { seq: r.seq });

    // 7. hook health
    st = await s.call('deskmenu.health');
    check('health on a live hook: alive (or a key/elevated-window answer, never dead)', !/dead/.test(st.verdict || ''), J(st));
    await T.sleep(1700);   // past QuietMs since the hook's last call
    from = s.events.length;
    const dr = await s.call('deskmenu.testdrop', { input: true });
    check('the hook dropped the way Windows drops it', dr.dropped === true, J(dr));
    st = await s.call('deskmenu.health');
    check('HOOK HEALTH: input after the hook\'s last call = dead, re-installed', st.verdict === 'dead; re-installed', J(st));
    await T.sleep(50);
    const healLog = s.events.slice(from).filter((e) => e.ev === 'log' && /the hook was put back/.test(e.message || ''));
    check('...one plain log line', healLog.length === 1 && /Windows drops a hook that answers too slowly/.test(healLog[0].message), J(healLog));
    const st2 = await s.call('deskmenu.status');
    check('...status: heals 1, still hooked', st2.heals === 1 && st2.hooked === true, J(st2));
    await T.sleep(1700);
    await s.call('deskmenu.testdrop', { input: true });
    st = await s.call('deskmenu.health');
    check('a second drop before the new hook was ever called: no second re-install (one per silent run)', /waiting for it to be called once/.test(st.verdict || ''), J(st));
    r = await s.call('deskmenu.testclick', desk.at);
    check('the decision still works after a re-install', r.taken === true, J(r));
    await s.call('deskmenu.ack', { seq: r.seq });

    // 8. cost
    for (let i = 0; i < 40; i++) {
      const q = await s.call('deskmenu.testclick', i % 3 === 0 ? { x: 5, y: 500 } : desk.at);
      if (q.taken) await s.call('deskmenu.ack', { seq: q.seq });
    }
    st = await s.call('deskmenu.status');
    const d = st.decisionUs || {};
    console.log('decision us: ' + JSON.stringify(d));
    check(`decision time per right button: p95 ${d.p95} us, max ${d.max} us (budget 1000 us p95)`, d.n >= 40 && d.p95 < 1000, J(d));
    const t0 = (await s.call('deskmenu.status')).threadCpuMs;
    await T.sleep(5000);
    const st5 = await s.call('deskmenu.status');
    console.log('hook thread cpu ms in 5 s idle: ' + (st5.threadCpuMs - t0) + '; last call ' + st5.lastCallAgoMs + ' ms ago');
    check('idle: the hook thread uses no CPU while nothing clicks (no polling; its 20 s health timer aside)', t0 >= 0 && st5.threadCpuMs - t0 < 1, J({ t0, t1: st5.threadCpuMs }));

    // 9. off and quit
    st = await s.call('deskmenu.arm', { on: false });
    check('disarm: unhooked', st.armed === false && st.hooked === false, J(st));
    await s.call('deskmenu.arm', { on: true, testClass: 'MantleFakeProgman' });
    const q0 = Date.now();
    await s.stop();
    const ex = s.proc.exitCode;
    check(`quit with the hook in: exits cleanly (code ${ex}, ${Date.now() - q0} ms)`, ex === 0, ex);
    s = null;
  } catch (e) {
    check('no exception in the test itself', false, e.stack);
  } finally {
    if (s) { try { await s.stop(); } catch (_) { /* gone */ } }
    for (const f of desks) killDesk(f);
    process.exitCode = C.summary ? C.summary() : 0;
  }
})();
