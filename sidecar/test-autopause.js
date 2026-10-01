// test-autopause.js - `autopause.peaks` on a PASSIVE sidecar (r5-autopause lane, 2026-09-30; the
// background meter, its warming answer, no delay to other commands and sleep-when-idle: r6-apfix).
//   node sidecar/test-autopause.js --exe=<your private build>
// READ ONLY: the command has no write op at all. The real machine's sessions are read and only
// COUNTS and shapes are printed (never an exe name). To prove the process-tree walk end to end, the
// test plays a SILENT wav (all-zero samples: nothing is heard) from a grandchild it starts itself
// (node -> cmd.exe -> powershell.exe SoundPlayer) and checks the sidecar ties that audio session back
// to this node process through the chain. It stops only the pids it started.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./test-lib');

function silentWav(file, seconds) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

(async () => {
  const c = T.checker('AUTOPAUSE-PEAKS');
  const s = await T.startPassive({ exe: T.exePath(process.argv) });
  let player = null;
  const wav = path.join(os.tmpdir(), `mantle-autopause-silent-${process.pid}.wav`);
  try {
    // 0. The request never does audio work (r6-apfix): the FIRST ask answers at once, "warming", and the
    //    meter thread's first reading follows within a second.
    let t0 = Date.now();
    const first = await s.call('autopause.peaks', {}, 5000);
    const firstMs = Date.now() - t0;
    c.check('the first ask answers at once (no audio work in the request)', firstMs < 300 && first.ok === true, `${firstMs} ms`);
    c.check('the first answer says warming, with no peaks yet', first.warming === true && Array.isArray(first.sessions) && first.sessions.length === 0, String(first.warming));
    async function fresh() {
      for (let i = 0; i < 40; i++) { const x = await s.call('autopause.peaks', {}, 5000); if (!x.warming) return x; await T.sleep(50); }
      return null;
    }
    t0 = Date.now();
    // 1. Shape of a real read (counts only).
    const r = await fresh();
    c.check('the first reading lands within 2 s', !!r && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    c.check('answers ok', r && r.ok === true, r && r.reason);
    c.check('devices counted', typeof r.devices === 'number' && r.devices >= 0, String(r.devices));
    const rows = Array.isArray(r.sessions) ? r.sessions : [];
    let shapeBad = 0, chainBad = 0, maxChain = 0;
    for (const x of rows) {
      if (typeof x.pid !== 'number' || typeof x.sys !== 'boolean' || typeof x.active !== 'boolean' || typeof x.peak !== 'number' || x.peak < 0 || x.peak > 1 || !Array.isArray(x.chain)) shapeBad++;
      if (!x.sys && x.chain.length && x.chain[0].pid !== x.pid) chainBad++;
      for (const e of x.chain) if (typeof e.pid !== 'number' || typeof e.exe !== 'string' || e.exe !== e.exe.toLowerCase() || !(e.pkg === null || typeof e.pkg === 'string')) chainBad++;
      maxChain = Math.max(maxChain, x.chain.length);
    }
    c.check('every session row has pid/sys/active/peak 0..1/chain', shapeBad === 0, `${shapeBad} bad of ${rows.length}`);
    c.check('every chain starts at its own pid; entries are {pid, exe lower-case, pkg|null}', chainBad === 0, `${chainBad} bad`);
    c.check('chains stop at 9 entries (the process + 8 ancestors)', maxChain <= 9, String(maxChain));
    c.check('the reading is fresh (ageMs under 1.5 s)', typeof r.ageMs === 'number' && r.ageMs >= 0 && r.ageMs < 1500, `${r.ageMs} ms`);
    console.log(`  real read: ${rows.length} sessions on ${r.devices} devices, ${rows.filter((x) => x.active).length} active, ` +
      `${rows.filter((x) => x.peak > 0.0008).length} audible, ${r.readMs} ms, deepest chain ${maxChain}`);

    // 2. The tree walk, end to end: a silent grandchild's session leads back to this process.
    silentWav(wav, 6);
    player = spawn('cmd.exe', ['/d', '/c', 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true, stdio: 'ignore' });
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      await T.sleep(250);
      const rr = await s.call('autopause.peaks', {}, 5000);
      for (const x of rr.sessions || []) {
        const at = (x.chain || []).findIndex((e) => e.pid === process.pid);
        if (at >= 2) { found = { x, at }; break; }
      }
    }
    c.check('a grandchild\'s audio session is tied to this process through the chain', !!found, 'no session led back here in 5 s');
    if (found) {
      c.check('the walk passes the middle process (cmd.exe)', found.x.chain[1] && found.x.chain[1].exe === 'cmd.exe', found.x.chain[1] && found.x.chain[1].exe);
      c.check('silent audio reads peak 0', found.x.peak === 0, String(found.x.peak));
      c.check('a classic exe has no package family', found.x.chain[0].pkg === null, String(found.x.chain[0].pkg));
    }

    // 4. Never delays another command: 40 asks at the live rate with a ui-lane ping beside each; every
    //    peaks answer and every ping is quick (the meter reads on its own thread).
    const pk = [], pg = [];
    for (let i = 0; i < 40; i++) {
      const a = Date.now();
      await Promise.all([s.call('autopause.peaks', { everyMs: 250 }, 5000).then(() => pk.push(Date.now() - a)),
        s.send('ping', {}, 5000).then(() => pg.push(Date.now() - a))]);
      await T.sleep(25);
    }
    const mx = (xs) => Math.max.apply(null, xs);
    c.check('peaks answers stay quick while the meter works (max under 150 ms)', mx(pk) < 150, `max ${mx(pk)} ms`);
    c.check('a ping beside it stays quick (max under 150 ms)', mx(pg) < 150, `max ${mx(pg)} ms`);
    // 5. Idle = asleep: 3.5 s with no ask and the meter has dropped everything (the next ask is "warming").
    await T.sleep(3500);
    const after = await s.call('autopause.peaks', {}, 5000);
    c.check('no asks for 3.5 s: the meter slept (next answer warming)', after.warming === true, String(after.warming));
    const woke = await fresh();
    c.check('and it wakes on the next ask', !!woke && woke.ok === true, woke ? 'ok' : 'never');

    // 3. Passive changes nothing: the command takes no write arguments (an unknown one is ignored, still a read).
    const again = await s.call('autopause.peaks', { level: 0, dryRun: false, everyMs: 5 }, 5000);
    c.check('extra arguments never turn it into a write', again && again.ok === true && Array.isArray(again.sessions));
  } catch (e) {
    c.fail('crashed', (e && e.message) || String(e));
  } finally {
    if (player && player.pid) { try { spawn('taskkill', ['/pid', String(player.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* gone */ } }
    await T.sleep(300);
    try { fs.unlinkSync(wav); } catch (_) { /* in use or gone */ }
    await s.stop();
  }
  process.exit(c.summary());
})();
