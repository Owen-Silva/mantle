// test-spotifymem.js - sidecar/SpotifyMem.cs (spotify.mem / spotify.trim) and its GUARD, against a
// PASSIVE sidecar started with APPDATA pointed at a scratch folder (lane sptrim, 2026-09-26).
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-spotifymem.js
// the user's Spotify is never reached: the sidecar only ever acts on <its APPDATA>\Spotify\Spotify.exe,
// and here that is a stand-in (a copy of cmd.exe / ping.exe named Spotify.exe) this test started.
// The stand-ins are ended by PID at the end, never by image name.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-spmem-'));
const APPDATA = path.join(ROOT, 'AppData');
const EXE = path.join(APPDATA, 'Spotify', 'Spotify.exe');          // the path the sidecar will accept (a cmd.exe copy)
const OTHER = path.join(ROOT, 'Other', 'Spotify.exe');             // Spotify.exe at ANOTHER path (a ping.exe copy)
const started = [];

function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
function run(exe, cmdline) {
  const p = spawn(exe, [cmdline], { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true });
  started.push(p.pid);
  return p.pid;
}
function endAll() {
  for (const pid of started) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

(async () => {
  const t = T.checker('SPOTIFYMEM');
  copy(path.join(SYS, 'cmd.exe'), EXE);
  copy(path.join(SYS, 'PING.EXE'), OTHER);
  const wait = ' -n 90 127.0.0.1 >nul';
  // R: the "Spotify Mantle started", with three children: a Spotify.exe at the RIGHT path (K, itself
  // running ping), a Spotify.exe at ANOTHER path, and a plain ping.exe.
  const R = run(EXE, `/d /c start /b "" "${OTHER}"${wait} & start /b "" "${EXE}" /d /c ping${wait} & ping${wait}`);
  const B = run(EXE, `/d /c ping${wait}`);                          // right path, but NOT in R's tree
  const C = run(OTHER, wait.replace(' >nul', ''));                  // Spotify.exe at another path, on its own
  await T.sleep(1500);

  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = APPDATA;
  let s;
  try { s = await T.startPassive(); } finally { process.env.APPDATA = oldAppData; }
  try {
    const ping = await s.send('ping', {}, 6000);
    const cmds = (ping.result && ping.result.features && ping.result.features.commands) || [];
    t.check('spotify.mem and spotify.trim are registered', cmds.includes('spotify.mem') && cmds.includes('spotify.trim'), cmds.filter((c) => /^spotify/.test(c)).join(','));

    // ---- the tree, read only
    const m = await s.call('spotify.mem', { root: R });
    const pids = (m.procs || []).map((p) => p.pid);
    const K = pids.find((p) => p !== R);
    t.check('mem: the expected exe is THIS sidecar\'s APPDATA\\Spotify\\Spotify.exe', m.exe && m.exe.toLowerCase() === EXE.toLowerCase(), m.exe);
    t.check('mem: the root and its Spotify.exe child at the right path, nothing else', m.running && pids[0] === R && pids.length === 2 && K > 0, JSON.stringify(pids));
    const refusedWhy = (m.refused || []).map((x) => `${x.file}: ${x.why}`).join(' | ');
    t.check('mem: a child Spotify.exe at ANOTHER path is refused, by its path', (m.refused || []).some((x) => /Spotify\.exe/i.test(x.file) && /not .*AppData/i.test(x.why)), refusedWhy);
    t.check('mem: a child that is not Spotify.exe is refused by name', (m.refused || []).some((x) => /^ping/i.test(x.file) && /is not Spotify\.exe/.test(x.why)), refusedWhy);
    t.check('mem: each process has working set and private working set', (m.procs || []).every((p) => p.ws > 0 && p.pws >= 0 && p.pws <= p.ws && p.priv > 0), JSON.stringify(m.procs));
    t.check('mem: the sums add up', m.ws === m.procs.reduce((a, p) => a + p.ws, 0) && m.pws === m.procs.reduce((a, p) => a + p.pws, 0), `${m.ws} ${m.pws}`);
    t.check('mem: no visible windows (hidden console stand-ins)', m.visible === 0, String(m.visible));
    t.check('mem: the root\'s start time is returned', /^\d+$/.test(m.created || ''), m.created);
    t.check('mem: cheap (under 60 ms)', m.ms < 60, `${m.ms} ms`);

    // ---- refusals
    const nn = await s.call('spotify.mem', { root: process.pid });
    t.check('REFUSE a non-Spotify root by name (node.exe), no process listed', !nn.running && nn.n === 0 && /is node\.exe, not Spotify\.exe/i.test(nn.why || ''), JSON.stringify(nn).slice(0, 300));
    const oc = await s.call('spotify.mem', { root: C });
    t.check('REFUSE a Spotify.exe at another path as the root', !oc.running && oc.n === 0 && /not .*AppData/i.test(oc.why || ''), oc.why);
    const ob = await s.call('spotify.mem', { root: R, pids: [B] });
    t.check('REFUSE a right-path Spotify.exe OUTSIDE the tree', ob.n === 0 && (ob.refused || []).some((x) => x.pid === B && /not in the tree/.test(x.why)), JSON.stringify(ob.refused));
    const op = await s.call('spotify.mem', { root: R, pids: [process.pid, C] });
    t.check('REFUSE a named non-Spotify pid and an other-path Spotify.exe in pids', op.n === 0 && (op.refused || []).filter((x) => x.pid === process.pid || x.pid === C).length === 2, JSON.stringify(op.refused));
    const ok2 = await s.call('spotify.mem', { root: R, pids: [K] });
    t.check('pids narrows to a pid that IS in the tree', ok2.n === 1 && ok2.procs[0].pid === K, JSON.stringify(ok2.procs));
    const cr = await s.call('spotify.mem', { root: R, created: '12345' });
    t.check('REFUSE the root when it is not the process first seen (created differs)', !cr.running && cr.n === 0 && /different Spotify\.exe/.test(cr.why || ''), cr.why);
    const cr2 = await s.call('spotify.mem', { root: R, created: m.created });
    t.check('the same created is accepted', cr2.running && cr2.n === 2, String(cr2.n));
    const ex = await s.send('spotify.mem', { root: R, exe: 'C:\\Elsewhere\\Spotify.exe' }, 4000);
    t.check('REFUSE an exe other than the sidecar\'s own', !ex.ok && /only reaches/.test(ex.error || ''), ex.error);
    const nr = await s.send('spotify.trim', {}, 4000);
    t.check('trim without root is an error in words', !nr.ok && /spotify\.trim needs root/.test(nr.error || ''), nr.error);
    const gone = await s.call('spotify.mem', { root: 4 * 1000 * 1000 - 4 });
    t.check('an exited root reads as not running, with a reason', !gone.running && /has exited/.test(gone.why || ''), gone.why);

    // ---- trim
    const tn = await s.call('spotify.trim', { root: process.pid });
    t.check('trim REFUSES a non-Spotify root: nothing trimmed', tn.trimmed === 0 && (tn.results || []).length === 0 && !tn.running, JSON.stringify(tn).slice(0, 300));
    const tc = await s.call('spotify.trim', { root: C });
    t.check('trim REFUSES a Spotify.exe at another path: nothing trimmed', tc.trimmed === 0 && (tc.results || []).length === 0, JSON.stringify(tc.refused));
    const tb = await s.call('spotify.trim', { root: R, pids: [B] });
    t.check('trim REFUSES a pid outside the tree: nothing trimmed', tb.trimmed === 0 && (tb.results || []).length === 0 && tb.refused.some((x) => x.pid === B), JSON.stringify(tb.refused));
    const tr = await s.call('spotify.trim', { root: R, created: m.created, skip: [K] });
    const rowR = (tr.results || []).find((x) => x.pid === R), rowK = (tr.results || []).find((x) => x.pid === K);
    t.check('trim: the root is trimmed', rowR && rowR.ok === true && rowR.afterWs <= rowR.beforeWs, JSON.stringify(rowR));
    t.check('trim: a skipped pid is left alone and said', rowK && rowK.skipped === true && rowK.ok === false && !('afterWs' in rowK), JSON.stringify(rowK));
    t.check('trim: one trimmed, the refused children listed', tr.trimmed === 1 && tr.refused.length >= 2, `${tr.trimmed} ${JSON.stringify(tr.refused)}`);
    t.check('trim: before/after sums are returned', tr.before > 0 && tr.after >= 0 && tr.after <= tr.before, `${tr.before} -> ${tr.after}`);
    t.check('trim works in passive (the guard is the same in both modes)', tr.passive === true);
  } finally {
    await s.stop();
    endAll();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* a stand-in still exiting */ }
  }
  process.exit(t.summary());
})().catch((e) => { endAll(); console.error('SPOTIFYMEM TEST: crashed:', e && e.stack || e); process.exit(1); });
