'use strict';
// ON-SCREEN check for the dead-hook detector (lane mn-hook): the parts test-hook-health.js cannot
// pretend, with REAL input. Run it ONLY in the visible slot (machine idle >= 3 min, holding
// mantle-notes/visible.lock). It injects input only into its own probe window (sidecar/hook-probe.ps1:
// the letter Q into its own text box, and a mouse move of 0,0), never a Win key, Alt or Tab.
//   1. raw keyboard input really reaches the sidecar's message-only window, and a live hook resets
//      the count (no false alarm while typing);
//   2. a hook dropped the way Windows drops it is noticed from real keys and re-installed, and the
//      new hook is then called for the next key;
//   3. the pop-up watch notices its dropped mouse hook from a real (0,0) mouse move.
// Prints "hook-health-live: N passed, M failed", or "NOT RUN: <why>" when the probe is not in front.

const path = require('path');
const { spawn } = require('child_process');
const T = require('./test-lib');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const J = (x) => JSON.stringify(x).slice(0, 300);

function startProbe() {
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'hook-probe.ps1')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = [];
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  const next = (ms) => new Promise((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    waiters.push((l) => { clearTimeout(t); res(l); });
  });
  return {
    ready: next(8000),
    say: (cmd) => { const n = next(8000); p.stdin.write(cmd + '\n'); return n; },
    quit: () => { try { p.stdin.write('quit\n'); } catch (_) { /* gone */ } setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 1500); },
  };
}

(async () => {
  let s = null;
  let probe = null;
  let notRun = null;
  try {
    s = await T.startPassive();
    const hk = (args) => s.send('hotkey', args, 6000);
    let r = await hk({ op: 'hooktest', on: true });
    if (!check('test hook in, raw check on', r.ok && r.result.installed && r.result.rawCheck, J(r))) throw new Error('no hook');
    probe = startProbe();
    const ready = await probe.ready;
    if (ready !== 'ready') { notRun = `the probe window did not get the foreground (${ready})`; throw new Error(notRun); }

    // 1. live hook + real keys
    const st0 = (await hk({ op: 'status' })).result;
    let a = await probe.say('keys 5');
    if (a !== 'ok 5') { notRun = `the probe lost the foreground (${a})`; throw new Error(notRun); }
    await T.sleep(300);
    let st = (await hk({ op: 'status' })).result;
    check('real keys reach the raw-input window (10 events for 5 presses)', st.rawSeen - st0.rawSeen === 10, `${st0.rawSeen} -> ${st.rawSeen}`);
    check('a live hook: called for them, no false alarm', st.heals === 0 && st.rawSinceHook < 4 && st.lastCallbackAgoMs < 2000, J(st));

    // 2. dropped, then real keys
    await T.sleep(1700);
    r = await hk({ op: 'hookdrop' });
    check('hookdrop', r.ok && r.result.dropped === true, J(r));
    await T.sleep(1700);
    const from = s.events.length;
    a = await probe.say('keys 3');
    if (a !== 'ok 3') { notRun = `the probe lost the foreground (${a})`; throw new Error(notRun); }
    await T.sleep(400);
    const line = s.events.slice(from).find((e) => e.ev === 'log' && /^keyboard hook: Windows stopped calling it/.test(e.message || ''));
    check('real keys with the hook gone: noticed and re-installed, one line', !!line, J(s.events.slice(from).filter((e) => e.ev === 'log')));
    st = (await hk({ op: 'status' })).result;
    check('status: one heal', st.heals === 1, J(st));
    await T.sleep(1200);
    a = await probe.say('keys 1');
    await T.sleep(200);
    st = (await hk({ op: 'status' })).result;
    check('the re-installed hook is called for the next key', a === 'ok 1' && st.lastCallbackAgoMs < 800 && st.rawSinceHook < 2, J(st));

    // 3. the pop-up watch's mouse hook
    r = await hk({ op: 'popwatch', on: true, leaseMs: 15000 });
    check('pop-up watch armed', r.ok && r.result.armed === true, J(r));
    await T.sleep(600);
    r = await hk({ op: 'popdrop' });
    check('popdrop (no pretend input)', r.ok && r.result.dropped === true, J(r));
    const from2 = s.events.length;
    a = await probe.say('move');
    await T.sleep(900);
    const pl = s.events.slice(from2).find((e) => e.ev === 'log' && /^pop-up watch: input reached Windows/.test(e.message || ''));
    check('a real mouse move its dropped hook missed: noticed and re-installed', a === 'ok' && !!pl, J(s.events.slice(from2).filter((e) => e.ev === 'log')));
    await hk({ op: 'popwatch', on: false });
  } catch (e) {
    if (!notRun) check('the run', false, e.stack || e.message);
  }
  if (probe) probe.quit();
  if (s) {
    s.proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n');
    try { await s.waitExit(3000); } catch (_) { try { s.proc.kill(); } catch (__) { /* gone */ } }
    await s.stop();
  }
  if (notRun) { console.log(`hook-health-live: NOT RUN: ${notRun}`); process.exit(2); }
  console.log(`hook-health-live: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
})();
