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

/** The power PLANS (powermode.plan): the list against `powercfg /list`, then ONLY a same-value
 *  switch (the active plan onto itself), confirmed by `powercfg /getactivescheme` before and after. */
async function powerPlans(s) {
  const before = independent();
  let listed = [];
  try {
    const out = execFileSync('powercfg', ['/list'], { encoding: 'utf8', windowsHide: true });
    const re = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\(([^)]*)\)(\s*\*)?/gi;
    let m;
    while ((m = re.exec(out))) listed.push({ guid: m[1].toLowerCase(), name: m[2], active: !!m[3] });
  } catch (e) { check('powercfg /list runs', false, e.message); }
  const t0 = Date.now();
  const g = await s.send('powermode.get');
  const getMs = Date.now() - t0;
  const r = g.result || {};
  const plans = Array.isArray(r.plans) ? r.plans : [];
  check('powermode.get lists the installed plans', plans.length > 0 && plans.every((p) => p.guid && typeof p.name === 'string'), JSON.stringify(r.plans));
  check('exactly one plan is active, and it is powercfg\'s active one',
    plans.filter((p) => p.active).length === 1 && plans.find((p) => p.active).guid === before.plan, JSON.stringify({ plans, powercfg: before.plan }));
  check('the plans are powercfg /list\'s plans (same GUIDs and names)',
    listed.length === plans.length && listed.every((l) => plans.some((p) => p.guid === l.guid && p.name === l.name)),
    JSON.stringify({ sidecar: plans.map((p) => [p.guid, p.name]), powercfg: listed.map((l) => [l.guid, l.name]) }));
  check('Balanced is flagged by its GUID', plans.every((p) => p.balanced === (p.guid === '381b4222-f694-41f0-9685-ff5bb260df2e')));
  console.log(`  powermode plans: ${plans.map((p) => `${p.name}${p.active ? ' *' : ''}`).join(' | ')} (get with plans ${getMs} ms)`);

  const bad = await s.send('powermode.plan', { plan: 'balanced please' });
  check('powermode.plan refuses a non-GUID in words', bad.ok === false && /needs plan: the GUID/.test(bad.error || ''), JSON.stringify(bad));
  const none = await s.send('powermode.plan', { plan: '12345678-1234-1234-1234-123456789abc' });
  check('powermode.plan refuses a plan that is not installed', none.ok === false && /no installed power plan/.test(none.error || ''), JSON.stringify(none));
  const other = plans.find((p) => !p.active);
  if (other) {
    const d = await s.send('powermode.plan', { plan: other.guid });
    const dr = d.result || {};
    check('a switch to ANOTHER plan is refused in --passive, naming both plans',
      dr.ok === false && /passive/.test(dr.reason || '') && dr.reason.includes(other.name), JSON.stringify(d));
  }
  const active = plans.find((p) => p.active);
  if (active) {
    const same = await s.send('powermode.plan', { plan: active.guid });
    const sr = same.result || {};
    check('the SAME-VALUE plan switch succeeds and reads back the same plan',
      sr.ok === true && sr.same === true && sr.state && sr.state.plan && sr.state.plan.guid === before.plan, JSON.stringify(same));
    console.log(`  powermode.plan same-value: PowerSetActiveScheme ${sr.setMs} ms`);
  }
  const after = independent();
  check('independent read (powercfg /getactivescheme): the plan is unchanged', after.plan === before.plan, JSON.stringify({ before, after }));
}

async function main() {
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  try {
    const ping = await s.send('ping', {}, 15000);
    const feats = ping.result && ping.result.features;
    check('ping lists the powermode commands', !feats || (feats.commands || []).includes('powermode.get'), JSON.stringify(feats));
    check('no feature failed to register', !feats || !(feats.problems || []).length, JSON.stringify(feats && feats.problems));
    await powerMode(s);
    await powerPlans(s);
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
  /* osd.*: the panel-state read, and osd.volume - one volume-key press. Every step here is a DRY
     run (the arithmetic, no write) or a real step that --passive must refuse; the volume is read
     before and after, and must not have moved. */
  async osdTests(s, check) {
    const q = await s.send('osd.qs');
    const qr = q.result || {};
    check('osd.qs answers', qr.ok === true && (qr.qsOpen === false || qr.qsOpen === true), JSON.stringify(q));
    check('osd.qs: the panel is closed in a fresh sidecar (QuickSettings.PanelOpen)', qr.qsOpen === false, JSON.stringify(qr));

    const before = (await s.send('volume', {}, 8000)).result || {};
    check('the volume can be read', typeof before.level === 'number', JSON.stringify(before));

    // A dry step from the REAL level: what VolumeUp would do right now.
    const d = await s.send('osd.volume', { op: 'up', dry: true }, 8000);
    const dr = d.result || {};
    const wantUp = Math.min(100, Math.floor(before.level / 2) * 2 + 2);
    check('osd.volume dry up from the device: from = the real level, level = the next even step, unmuted',
      d.ok !== false && dr.dry === true && dr.from && dr.from.level === before.level && dr.level === wantUp && dr.muted === false,
      JSON.stringify({ reply: d, before }));

    // The arithmetic, from pretend levels (Windows' keys: 2 per press, snapped to even, unmute).
    const table = [
      ['up', 33, false, 34, false], ['up', 34, false, 36, false], ['up', 99, false, 100, false], ['up', 100, false, 100, false],
      ['up', 0, false, 2, false], ['down', 33, false, 32, false], ['down', 34, false, 32, false], ['down', 1, false, 0, false],
      ['down', 0, false, 0, false], ['up', 40, true, 42, false], ['down', 40, true, 38, false], ['mute', 40, false, 40, true],
      ['mute', 40, true, 40, false], ['mute', 0, false, 0, true], ['up', 150, false, 100, false],   // 150 is read as 100
    ];
    for (const [op, level, muted, wl, wm] of table) {
      const r = await s.send('osd.volume', { op, dry: true, from: { level, muted } });
      const x = r.result || {};
      check(`osd.volume dry ${op} from ${level}${muted ? ' muted' : ''} -> ${wl}${wm ? ' muted' : ''}`,
        r.ok !== false && x.level === wl && x.muted === wm && x.changed === (wl !== Math.min(100, level) || wm !== muted), JSON.stringify(r));
    }
    const s5 = await s.send('osd.volume', { op: 'up', dry: true, step: 5, from: { level: 33, muted: false } });
    check('osd.volume step 5: 33 -> 35', s5.result && s5.result.level === 35, JSON.stringify(s5));

    // Refusals, in words.
    const bad = [
      [{ op: 'louder', dry: true }, /needs op 'up', 'down' or 'mute'/, 'an unknown op'],
      [{ dry: true }, /needs op/, 'no op'],
      [{ op: 'up', dry: true, step: 0 }, /step must be 1-10/, 'step 0'],
      [{ op: 'up', from: { level: 10 } }, /dry run only/, '`from` without dry'],
      [{ op: 'up', dry: true, from: { muted: true } }, /needs a level/, '`from` without a level'],
    ];
    for (const [args, re, what] of bad) {
      const r = await s.send('osd.volume', args);
      check(`osd.volume refuses ${what} in words`, r.ok === false && re.test(r.error || ''), JSON.stringify(r));
    }
    for (const op of ['up', 'down', 'mute']) {
      const r = await s.send('osd.volume', { op });
      check(`a REAL ${op} step is refused in --passive`, r.ok === false && /passive/.test(r.error || '') && /stepped the volume/.test(r.error || ''), JSON.stringify(r));
    }

    // A held key: 30 dry steps back to back (the audio lane runs them in order).
    const ms = [];
    let from = { level: 10, muted: false };
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      const r = await s.send('osd.volume', { op: 'up', dry: true, from });
      ms.push(Date.now() - t0);
      if (r.result) from = { level: r.result.level, muted: r.result.muted };
    }
    check('30 held-key dry steps climb 10 -> 70', from.level === 70, JSON.stringify(from));
    const dev = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await s.send('osd.volume', { op: 'up', dry: true });
      dev.push(Date.now() - t0);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`  osd.volume round trip: pretend level median ${med(ms)} ms (max ${Math.max(...ms)}); from the device median ${med(dev)} ms (max ${Math.max(...dev)})`);

    const after = (await s.send('volume', {}, 8000)).result || {};
    check('Owen\'s volume did not move (level and mute read before and after)',
      after.level === before.level && after.muted === before.muted, JSON.stringify({ before, after }));
  },
};
if (require.main === module) main();
