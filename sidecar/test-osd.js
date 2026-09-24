#!/usr/bin/env node
/* test-osd.js - the osd lane's sidecar commands (wave 3, 2026-09-24): powermode.* and osd.*.
 *
 * Runs the sidecar in --passive, like test-sidecar.js. WHAT IT MAY CHANGE ON OWEN'S MACHINE:
 * nothing. The only power-mode write is a SAME-VALUE one (the mode already in effect), and it is
 * confirmed by an independent read (`powercfg /getactivescheme` for the plan, the registry
 * overlay values for the mode). The Windows OSD is never hidden from here: in --passive
 * osd.flyout refuses every change, and this test checks that it does.
 *
 *   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-osd.js
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const EXE = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name);
  return false;
}

function start(args) {
  const proc = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = [];
  let nextId = 1, buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.ev !== undefined) events.push(msg);
      else if (pending.has(msg.id)) { const done = pending.get(msg.id); pending.delete(msg.id); done(msg); }
    }
  });
  function send(cmd, extra, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no reply to "${cmd}" within ${timeoutMs || 8000}ms`)); }, timeoutMs || 8000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, extra || {})) + '\n');
    });
  }
  return { proc, send, events, stop() { try { proc.stdin.end(); } catch (e) { /* gone */ } setTimeout(() => { try { proc.kill(); } catch (e) { /* gone */ } }, 1500); } };
}

/** The independent reads: powercfg for the plan, the registry for the overlays. */
function independent() {
  const out = { plan: null, ac: null, dc: null };
  try {
    const s = execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8', windowsHide: true });
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
    out.plan = m ? m[1].toLowerCase() : null;
  } catch (e) { out.planError = e.message; }
  try {
    const s = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'], { encoding: 'utf8', windowsHide: true });
    const ac = /ActiveOverlayAcPowerScheme\s+REG_SZ\s*([^\r\n]*)/.exec(s);
    const dc = /ActiveOverlayDcPowerScheme\s+REG_SZ\s*([^\r\n]*)/.exec(s);
    out.ac = ac ? ac[1].trim() : null;
    out.dc = dc ? dc[1].trim() : null;
  } catch (e) { out.regError = e.message; }
  return out;
}
const MODE_OF = { '': 'balanced', '00000000-0000-0000-0000-000000000000': 'balanced',
  '961cc777-2547-4f9d-8174-7d86181b8a7a': 'efficiency', 'ded574b5-45a0-4f42-8737-46345c09c238': 'performance' };

async function powerMode(s) {
  const before = independent();
  const t0 = Date.now();
  const g = await s.send('powermode.get');
  const getMs = Date.now() - t0;
  const r = g.result || {};
  check('powermode.get answers ok', g.ok !== false && r.ok === true, JSON.stringify(g));
  check('powermode.get names a mode', ['efficiency', 'balanced', 'performance', 'better', 'other'].includes(r.mode), r.mode);
  check('powermode.get plan matches powercfg /getactivescheme', r.plan && r.plan.guid === before.plan, JSON.stringify({ sidecar: r.plan, powercfg: before.plan }));
  check('powermode.get plan.balanced agrees with the plan guid',
    r.plan && r.plan.balanced === (r.plan.guid === '381b4222-f694-41f0-9685-ff5bb260df2e'), JSON.stringify(r.plan));
  check('available iff on Balanced', r.available === (r.plan && r.plan.balanced), JSON.stringify(r));
  check('not available -> a reason in words', r.available || (typeof r.reason === 'string' && /Balanced/.test(r.reason)), r.reason);
  check('source is ac/battery/unknown', ['ac', 'battery', 'unknown'].includes(r.source), r.source);
  const regMode = MODE_OF[(r.source === 'battery' ? before.dc : before.ac) || ''];
  check('mode agrees with the registry overlay for this power source', regMode === undefined || regMode === r.mode,
    JSON.stringify({ sidecar: r.mode, registry: before }));
  console.log(`  powermode.get: mode=${r.mode} plan="${r.plan && r.plan.name}" available=${r.available} source=${r.source} in ${getMs} ms (sidecar ${r.ms} ms)`);

  // A bad mode is refused in words, before anything is called.
  const bad = await s.send('powermode.set', { mode: 'turbo' });
  check('powermode.set refuses an unknown mode with a reason', bad.ok === false && /efficiency/.test(bad.error || ''), JSON.stringify(bad));

  // A different mode: refused (passive, or not on Balanced) with the reason, nothing written.
  const other = r.mode === 'performance' ? 'balanced' : 'performance';
  const diff = await s.send('powermode.set', { mode: other });
  const dr = diff.result || {};
  check('a different-mode set is refused in --passive (or off Balanced) with a reason',
    dr.ok === false && typeof dr.reason === 'string' && (/passive/.test(dr.reason) || /Balanced/.test(dr.reason)), JSON.stringify(diff));
  check('the refusal carries the read-back state', dr.state && dr.state.mode === r.mode, JSON.stringify(dr.state));

  // The SAME-VALUE write: the mode already in effect. Off Balanced it is refused like any other
  // (Windows ignores overlays there), so the write path itself is proven only on a Balanced plan.
  if (['efficiency', 'balanced', 'performance'].includes(r.mode)) {
    const same = await s.send('powermode.set', { mode: r.mode });
    const sr = same.result || {};
    if (r.available) {
      check('same-value set succeeds', sr.ok === true && sr.same === true, JSON.stringify(same));
    } else {
      check('same-value set off Balanced is refused with the plan reason', sr.ok === false && /Balanced/.test(sr.reason || ''), JSON.stringify(same));
      console.log('  NOT PROVEN HERE: PowerSetActiveOverlayScheme itself (the active plan is not Balanced, so no write is made)');
    }
  }
  const after = independent();
  check('independent read: plan unchanged', after.plan === before.plan, JSON.stringify({ before, after }));
  check('independent read: AC overlay unchanged', after.ac === before.ac, JSON.stringify({ before, after }));
  check('independent read: DC overlay unchanged', after.dc === before.dc, JSON.stringify({ before, after }));

  // The listeners: register, report, unregister. No change is made, so no push is expected.
  const w = await s.send('powermode.watch', { on: true });
  const wr = w.result || {};
  check('powermode.watch on answers', wr.ok === true && wr.state && wr.state.mode === r.mode, JSON.stringify(w));
  check('both listeners registered, or the reason why not', wr.watching === true || typeof wr.reason === 'string', JSON.stringify(wr));
  console.log(`  powermode.watch: mode-listener=${wr.mode} plan-listener=${wr.plan} ${wr.reason || ''}`);
  await new Promise((res) => setTimeout(res, 400));
  const pushes = s.events.filter((e) => e.ev === 'powermode');
  check('no powermode push without a change', pushes.length === 0, JSON.stringify(pushes).slice(0, 200));
  const off = await s.send('powermode.watch', { on: false });
  check('powermode.watch off answers', off.result && off.result.watching === false, JSON.stringify(off));
}

async function main() {
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  try {
    const ping = await s.send('ping', {}, 15000);
    const feats = ping.result && ping.result.features;
    check('ping lists the powermode commands', !feats || (feats.commands || []).includes('powermode.get'), JSON.stringify(feats));
    check('no feature failed to register', !feats || !(feats.problems || []).length, JSON.stringify(feats && feats.problems));
    await powerMode(s);
    if (typeof module.exports.osdTests === 'function') await module.exports.osdTests(s, check);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    s.stop();
  }
  console.log(`test-osd: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  FAIL ' + f));
  setTimeout(() => process.exit(failures.length ? 1 : 0), 1600);
}
module.exports = {
  /* osd.*: the panel-state read, the brightness watch (start/stop, no change made), and the
     read-only flyout search; a hide in --passive must be refused. */
  async osdTests(s, check) {
    const q = await s.send('osd.qs');
    const qr = q.result || {};
    check('osd.qs answers', qr.ok === true && (qr.qsOpen === false || qr.qsOpen === true), JSON.stringify(q));
    check('osd.qs: the panel is closed in a fresh sidecar', qr.qsOpen === false, JSON.stringify(qr));
    const w = await s.send('osd.watch', { on: true }, 15000);
    const wr = w.result || {};
    check('osd.watch on: watching, or the reason why not', wr.watching === true || (wr.ok === false && typeof wr.reason === 'string'), JSON.stringify(w));
    console.log('  osd.watch: watching=' + wr.watching + (wr.reason ? ' (' + wr.reason + ')' : ''));
    const off = await s.send('osd.watch', { on: false }, 15000);
    check('osd.watch off', off.result && off.result.watching === false, JSON.stringify(off));
    const fl = await s.send('osd.flyout', { op: 'find' });
    const fr = fl.result || {};
    check('osd.flyout find answers with found and a reason', fr.ok === true && typeof fr.found === 'boolean' && typeof fr.reason === 'string', JSON.stringify(fl));
    console.log('  osd.flyout: found=' + fr.found + ' host=' + fr.host + ' (' + fr.reason + ')');
    const hide = await s.send('osd.flyout', { op: 'hide' });
    check('osd.flyout hide is refused in --passive', hide.ok === false && /passive/.test(hide.error || ''), JSON.stringify(hide));
  },
};
if (require.main === module) main();
