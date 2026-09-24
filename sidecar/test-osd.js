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
    check('ping lists osd.bright', !feats || (feats.commands || []).includes('osd.bright'), JSON.stringify(feats && feats.commands));
    if (typeof module.exports.brightTests === 'function') await module.exports.brightTests(s, check);
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

  /* osd.bright: Windows' BRIGHTNESS pop-up, replaced (osd3, 2026-09-24). Nothing here changes the
     brightness (not even a same-value write) and nothing of explorer's is ever moved: the rules run
     on made-up windows (op:'match'), the passive dry run is proved with op:'simulate', and the real
     hook -> move -> verify -> put-back road runs on a STAND-IN window of this test's own helper
     process (class XamlExplorerHostIslandWindow, alpha 0 + click-through + no-activate: it never
     draws a pixel or takes a click, and lives under 20 s), named with targetPid (passive only). */
  async brightTests(s, check) {
    const m = async (window, showAt, brightAt, now) => ((await s.send('osd.bright', { op: 'match', window, showAt, brightAt, now })).result || {});
    const mon = [0, 0, 1920, 1080];
    const fly = { cls: 'XamlExplorerHostIslandWindow', proc: 'explorer', x: 827, y: 1004, w: 266, h: 76, scale: 1.25, monitor: mon };
    const W = (o) => Object.assign({}, fly, o);
    let r = await m(fly, 1000, [1020], 1100);
    check('match: the flyout + a brightness change 20 ms AFTER its SHOW is hidden', r.verdict === 'hide', JSON.stringify(r));
    r = await m(fly, 1000, [700], 1100);
    check('match: a brightness change 300 ms BEFORE the SHOW is hidden', r.verdict === 'hide' && /before/.test(r.reason), JSON.stringify(r));
    r = await m(W({ w: 211, h: 76 }), 1000, [1030], 1100);
    check('match: the narrower 169x61 variant is hidden too', r.verdict === 'hide', JSON.stringify(r));
    r = await m(fly, 1000, [], 2000);
    check('match: the same class WITHOUT a brightness change is never touched', r.verdict === 'ignore' && /no brightness change/.test(r.reason), JSON.stringify(r));
    r = await m(fly, 1000, [], 1100);
    check('match: no brightness change yet (100 ms after the SHOW) waits', r.verdict === 'wait', JSON.stringify(r));
    r = await m(fly, 1000, [2200], 2300);
    check('match: a brightness change 1.2 s after is not this pop-up', r.verdict === 'ignore', JSON.stringify(r));
    r = await m(fly, 1000, [100], 2000);
    check('match: a brightness change 0.9 s before is not this pop-up', r.verdict === 'ignore', JSON.stringify(r));
    r = await m(W({ cls: 'Shell_TrayWnd' }), 1000, [1020], 1100);
    check('match: another class with a brightness change is never touched', r.verdict === 'ignore' && /class/.test(r.reason), JSON.stringify(r));
    r = await m(W({ cls: 'TopLevelWindowForOverflowXamlIsland' }), 1000, [1020], 1100);
    check('match: explorer\'s other XAML island class is never touched', r.verdict === 'ignore', JSON.stringify(r));
    r = await m(W({ proc: 'chrome' }), 1000, [1020], 1100);
    check('match: the same class in another process is never touched', r.verdict === 'ignore' && /chrome/.test(r.reason), JSON.stringify(r));
    r = await m(W({ x: 0, y: 0, w: 1920, h: 1080 }), 1000, [1020], 1100);
    check('match: the full-screen explorer XAML layer (same class) is never touched', r.verdict === 'ignore' && /size/.test(r.reason), JSON.stringify(r));
    r = await m(W({ x: 10, y: 10 }), 1000, [1020], 1100);
    check('match: a flyout-sized window at the top-left is never touched', r.verdict === 'ignore' && /centred|bottom/.test(r.reason), JSON.stringify(r));
    r = await m(W({ x: 1654, y: 1004 }), 1000, [1020], 1100);
    check('match: a flyout-sized window bottom-RIGHT (a toast/tray flyout) is never touched', r.verdict === 'ignore', JSON.stringify(r));

    // ---- the watch, passive
    const seen = () => s.events.length;
    const waitFor = async (from, pred, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        for (let i = from; i < s.events.length; i++) if (pred(s.events[i])) return s.events[i];
        if (Date.now() > end) return null;
        await new Promise((res) => setTimeout(res, 15));
      }
    };
    const osdEv = (e) => e.ev === 'osd' && e.kind === 'brightness';
    r = (await s.send('osd.bright', { op: 'watch', on: true }, 10000));
    check('osd.bright watch starts in --passive (the watch itself is read-only)', r.ok && r.result.watching === true && r.result.dry === true, JSON.stringify(r));
    const explorerPid = r.result && r.result.shellPid;
    r = await s.send('osd.bright', { op: 'watch', on: true, targetPid: explorerPid });
    check('targetPid may never be explorer\'s', r.ok === false && /explorer/.test(r.error), JSON.stringify(r));
    let at = seen();
    await s.send('osd.bright', { op: 'inject', level: 40 });
    let e = await waitFor(at, osdEv, 1500);
    check('a brightness change with no Windows pop-up: flyout "none" (Mantle shows nothing)', e && e.flyout === 'none' && e.level === 40, JSON.stringify(e));
    at = seen();
    r = await s.send('osd.bright', { op: 'simulate', level: 70 });
    e = await waitFor(at, osdEv, 1500);
    const log = await waitFor(at, (x) => x.ev === 'log' && /DRY RUN/.test(x.message || ''), 1500);
    check('simulate (passive): a made-up pop-up is a DRY RUN event with the level', r.ok && e && e.flyout === 'dry' && e.dry === true && e.level === 70, JSON.stringify({ r, e }));
    check('simulate: the dry run has its log line', !!log, JSON.stringify(log));

    // ---- the stand-in window
    let fake;
    try { fake = await startFake('recentre'); } catch (err) { check('the stand-in window helper starts', false, err.message); }
    if (!fake) return;
    try {
      const home = fake.ready.rect;
      // 1. passive, NOT named: a flyout-shaped window of another process, WITH a brightness change: untouched
      at = seen();
      await s.send('osd.bright', { op: 'inject', level: 50 });
      await fake.cmd('show', 'shown');
      await new Promise((res) => setTimeout(res, 400));
      let rc = await fake.cmd('rect', 'rect');
      e = await waitFor(at, (x) => osdEv(x) && x.flyout !== 'none', 50);
      check('another process\'s flyout-shaped window + a brightness change: never moved', rc.x === home.x && rc.y === home.y && rc.visible && !e, JSON.stringify({ rc, home, e }));
      await fake.cmd('hide', 'hidden');

      // 2. named stand-in: really moved, verified, measured (brightness change just BEFORE the SHOW)
      r = await s.send('osd.bright', { op: 'watch', on: true, targetPid: fake.pid });
      check('watch with the test\'s own stand-in named', r.ok && r.result.targetPid === fake.pid, JSON.stringify(r));
      await new Promise((res) => setTimeout(res, 300));   // the hook thread re-hooks on its next message
      const lat = [], after = [];
      for (let i = 0; i < 8; i++) {
        at = seen();
        await s.send('osd.bright', { op: 'inject', level: 10 * i });
        const shown = await fake.cmd('show', 'shown');
        const moved = await fake.next('moved', 1500);
        e = await waitFor(at, (x) => osdEv(x) && x.phase === 'change' && x.flyout === 'hidden', 1500);
        if (moved) lat.push(moved.t - shown.t);
        if (e && typeof e.hiddenAfterMs === 'number') after.push(e.hiddenAfterMs);
        if (i === 0) {
          rc = await fake.cmd('rect', 'rect');
          check('stand-in: parked off screen at (Park + x, Park + y), still "shown"', rc.x === -24000 + home.x && rc.y === -24000 + home.y && rc.visible, JSON.stringify({ rc, home }));
          check('stand-in: the push says hidden, parked, with the level', e && e.how === 'parked' && e.level === 0 && e.dry === false, JSON.stringify(e));
        }
        const end0 = seen();
        await fake.cmd('hide', 'hidden');
        const end = await waitFor(end0, (x) => osdEv(x) && x.phase === 'end', 1500);
        if (i === 0) check('stand-in: its HIDE ends the session with a summary', end && end.why === 'Windows hid it' && /off screen/.test(end.summary || ''), JSON.stringify(end));
      }
      const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
      check('stand-in: every one of 8 shows was moved off screen', lat.length === 8 && after.length === 8, JSON.stringify({ lat, after }));
      console.log(`  measured: SHOW -> off screen, as the stand-in saw it: median ${med(lat) && med(lat).toFixed(2)} ms, max ${Math.max(...lat).toFixed(2)} ms (${lat.length}); as the sidecar measured it: median ${med(after)} ms`);
      check('stand-in: moved off screen within one 60 Hz frame (median < 16 ms)', med(lat) !== null && med(lat) < 16, JSON.stringify(lat));

      // 3. brightness change AFTER the SHOW: waits, then moves
      await new Promise((res) => setTimeout(res, 700));   // clear of the last injected change
      at = seen();
      await fake.cmd('show', 'shown');
      await new Promise((res) => setTimeout(res, 60));
      rc = await fake.cmd('rect', 'rect');
      check('stand-in: SHOW with no brightness change yet is left alone while it waits', rc.x === home.x, JSON.stringify(rc));
      await s.send('osd.bright', { op: 'inject', level: 55 });
      e = await waitFor(at, (x) => osdEv(x) && x.flyout === 'hidden', 1500);
      rc = await fake.cmd('rect', 'rect');
      check('stand-in: the brightness change 60 ms later moves it', e && e.level === 55 && rc.x === -24000 + home.x, JSON.stringify({ e, rc }));
      await fake.cmd('hide', 'hidden');
      await waitFor(at, (x) => osdEv(x) && x.phase === 'end', 1500);

      // 4. watch off puts it back (it is parked and hidden now)
      rc = await fake.cmd('rect', 'rect');
      r = await s.send('osd.bright', { op: 'watch', on: false });
      await new Promise((res) => setTimeout(res, 150));
      const back = await fake.cmd('rect', 'rect');
      check('watch off: the parked stand-in is put back where it was', rc.x === -24000 + home.x && back.x === home.x && back.y === home.y && r.result.restored >= 1, JSON.stringify({ rc, back, r }));
    } finally { fake.quit(); }

    // 5. "keep" mode (the helper never re-places itself, like an explorer that honours the park)
    try { fake = await startFake('keep'); } catch (err) { check('the stand-in helper starts (keep)', false, err.message); return; }
    try {
      const home = fake.ready.rect;
      await s.send('osd.bright', { op: 'watch', on: true, targetPid: fake.pid });
      await new Promise((res) => setTimeout(res, 300));
      at = seen();
      await s.send('osd.bright', { op: 'inject', level: 30 });
      await fake.cmd('show', 'shown');
      await waitFor(at, (x) => osdEv(x) && x.flyout === 'hidden', 1500);
      await fake.cmd('hide', 'hidden');
      await waitFor(at, (x) => osdEv(x) && x.phase === 'end', 1500);
      at = seen();
      await s.send('osd.bright', { op: 'inject', level: 40 });
      await fake.cmd('show', 'shown');
      e = await waitFor(at, (x) => osdEv(x) && x.flyout === 'hidden', 1500);
      check('keep: shown again ALREADY parked = "prepark", 0 ms on screen', e && e.how === 'prepark' && e.hiddenAfterMs === 0 && e.level === 40, JSON.stringify(e));
      await fake.cmd('hide', 'hidden');
      await waitFor(at, (x) => osdEv(x) && x.phase === 'end', 1500);
      // a parked window that shows with NO brightness change is not the brightness pop-up: put back
      at = seen();
      await new Promise((res) => setTimeout(res, 700));   // clear of the last injected change
      await fake.cmd('show', 'shown');
      await new Promise((res) => setTimeout(res, 1100));
      const rc = await fake.cmd('rect', 'rect');
      e = await waitFor(at, (x) => osdEv(x) && x.flyout === 'hidden', 50);
      check('keep: a parked window shown WITHOUT a brightness change is put back on screen', rc.x === home.x && rc.y === home.y && !e, JSON.stringify({ rc, home, e }));
      await fake.cmd('hide', 'hidden');
    } finally { fake.quit(); }

    // 6. "fight" mode: the window moves itself back every time; re-parked 3x, then SW_HIDE
    try { fake = await startFake('fight'); } catch (err) { check('the stand-in helper starts (fight)', false, err.message); return; }
    try {
      await s.send('osd.bright', { op: 'watch', on: true, targetPid: fake.pid });
      await new Promise((res) => setTimeout(res, 300));
      at = seen();
      await s.send('osd.bright', { op: 'inject', level: 20 });
      await fake.cmd('show', 'shown');
      e = await waitFor(at, (x) => osdEv(x) && (x.flyout === 'hidden' && x.how === 'hidden' || x.flyout === 'failed'), 2500);
      await new Promise((res) => setTimeout(res, 200));
      const rc = await fake.cmd('rect', 'rect');
      check('fight: a window that keeps coming back is hidden instead (SW_HIDE fallback)', e && e.flyout === 'hidden' && e.how === 'hidden' && e.fights >= 3 && rc.visible === false, JSON.stringify({ e, rc }));
      const st = (await s.send('osd.bright', { op: 'state' })).result || {};
      check('state counts the sessions', st.hidden >= 10 && st.prepark >= 1 && st.dryRuns === 0, JSON.stringify(st));
    } finally {
      fake.quit();
      await s.send('osd.bright', { op: 'watch', on: false });
    }
  },
};

/** The stand-in: this test's own window of class XamlExplorerHostIslandWindow, invisible (alpha 0),
 *  click-through, never activated, bottom-centre of the primary work area at 213x61 logical px.
 *  modes: keep (placed once), recentre (re-placed before every show), fight (moves itself back). */
const FAKE_CS = String.raw`
using System; using System.Diagnostics; using System.Globalization; using System.Runtime.InteropServices; using System.Threading;
static class Fake {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WNDCLASS { public uint style; public WndProc proc; public int cls, wnd; public IntPtr inst, icon, cursor, bg; public string menu, name; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct WINDOWPOS { public IntPtr h, after; public int x, y, cx, cy; public uint flags; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string t, uint st, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint t, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint r);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint a, uint b, out RECT r, uint c);
  static WndProc keep; static IntPtr win; static string mode; static int hx, hy; static bool armed;
  static double Now() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
  static string N(double d) { return d.ToString("F3", CultureInfo.InvariantCulture); }
  static void Out(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
  static void Rect(string ev) { RECT r; GetWindowRect(win, out r); Out("{\"ev\":\"" + ev + "\",\"t\":" + N(Now()) + ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + ",\"visible\":" + (IsWindowVisible(win) ? "true" : "false") + "}"); }
  static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) {
    if (m == 0x0047 && h == win) {
      var p = (WINDOWPOS)Marshal.PtrToStructure(l, typeof(WINDOWPOS));
      if ((p.flags & 0x0002) == 0 && p.x < -10000) {
        if (armed) { armed = false; Out("{\"ev\":\"moved\",\"t\":" + N(Now()) + ",\"x\":" + p.x + ",\"y\":" + p.y + "}"); }
        if (mode == "fight") SetWindowPos(win, IntPtr.Zero, hx, hy, 0, 0, 0x0001 | 0x0004 | 0x0010 | 0x4000);
      }
    }
    return DefWindowProcW(h, m, w, l);
  }
  static int Main(string[] a) {
    mode = a.Length > 0 ? a[0] : "keep";
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    keep = Proc;
    var wc = new WNDCLASS(); wc.proc = keep; wc.name = "XamlExplorerHostIslandWindow"; wc.inst = Marshal.GetHINSTANCE(typeof(Fake).Module);
    RegisterClassW(ref wc);
    win = CreateWindowExW(0x08000000 | 0x00080000 | 0x00000020 | 0x00000080 | 0x00000008, "XamlExplorerHostIslandWindow", "", 0x80000000, -32000, -32000, 10, 10, IntPtr.Zero, IntPtr.Zero, wc.inst, IntPtr.Zero);
    SetLayeredWindowAttributes(win, 0, 0, 2);
    RECT work; SystemParametersInfoW(0x0030, 0, out work, 0);
    double sc = GetDpiForWindow(win) / 96.0; if (sc <= 0) sc = 1;
    int W = (int)Math.Round(213 * sc), H = (int)Math.Round(61 * sc);
    hx = (work.L + work.R) / 2 - W / 2; hy = work.B - H - (int)Math.Round(12 * sc);
    SetWindowPos(win, IntPtr.Zero, hx, hy, W, H, 0x0004 | 0x0010);
    uint tid = GetCurrentThreadId(); MSG m; PeekMessageW(out m, IntPtr.Zero, 0, 0, 0);
    var th = new Thread(delegate () {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        uint c = line == "show" ? 1u : line == "hide" ? 2u : line == "rect" ? 3u : line == "quit" ? 4u : 0u;
        if (c != 0) PostThreadMessageW(tid, 0x8000 + c, IntPtr.Zero, IntPtr.Zero);
      }
      PostThreadMessageW(tid, 0x8004, IntPtr.Zero, IntPtr.Zero);
    });
    th.IsBackground = true; th.Start();
    Out("{\"ev\":\"ready\",\"pid\":" + Process.GetCurrentProcess().Id + "}");
    Rect("home");
    while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.h == IntPtr.Zero && m.m > 0x8000 && m.m <= 0x8004) {
        uint c = m.m - 0x8000;
        if (c == 1) {
          if (mode != "keep") SetWindowPos(win, IntPtr.Zero, hx, hy, 0, 0, 0x0001 | 0x0004 | 0x0010);
          armed = true; double t0 = Now(); ShowWindow(win, 4);
          Out("{\"ev\":\"shown\",\"t\":" + N(t0) + "}");
        } else if (c == 2) { armed = false; ShowWindow(win, 0); Out("{\"ev\":\"hidden\"}"); }
        else if (c == 3) Rect("rect");
        else break;
        continue;
      }
      DispatchMessageW(ref m);
    }
    return 0;
  }
}`;

async function startFake(mode) {
  const fs = require('fs'), os = require('os'), crypto = require('crypto');
  const dir = path.join(os.tmpdir(), 'mantle-osd-fakeflyout');
  fs.mkdirSync(dir, { recursive: true });
  const tag = crypto.createHash('sha1').update(FAKE_CS).digest('hex').slice(0, 10);
  const exe = path.join(dir, `fakeflyout-${tag}.exe`);
  if (!fs.existsSync(exe)) {
    const src = path.join(dir, `fakeflyout-${tag}.cs`);
    fs.writeFileSync(src, FAKE_CS);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['-nologo', '-out:' + exe, src], { windowsHide: true });
  }
  const proc = spawn(exe, [mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const got = [];
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) try { got.push(JSON.parse(line)); } catch (e) { /* not ours */ }
    }
  });
  let read = 0;
  async function next(ev, ms) {
    const end = Date.now() + (ms || 2000);
    for (;;) {
      while (read < got.length) { const x = got[read++]; if (x.ev === ev) return x; }
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 5));
    }
  }
  const cmd = async (c, ev) => { read = got.length; proc.stdin.write(c + '\n'); const x = await next(ev, 2000); if (!x) throw new Error(`stand-in: no "${ev}" after "${c}"`); return x; };
  const ready = await next('ready', 8000);
  const home = await next('home', 2000);
  if (!ready || !home) { try { proc.kill(); } catch (e) { /* gone */ } throw new Error('the stand-in window helper did not start'); }
  return { pid: ready.pid, ready: { rect: home }, cmd, next, quit() { try { proc.stdin.write('quit\n'); } catch (e) { /* gone */ } setTimeout(() => { try { proc.kill(); } catch (e) { /* gone */ } }, 500); } };
}
if (require.main === module) main();
