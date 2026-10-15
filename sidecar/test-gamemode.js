// test-gamemode.js - sidecar/GameMode.cs against a PASSIVE sidecar (lane gamemode, 2026-09-25).
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-gamemode.js
// Nothing here changes Owen's machine: every write is either refused as passive (asserted) or a
// same-value request that GameMode.cs answers without calling Windows (asserted: wrote false).
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('GAMEMODE');
  const s = await T.startPassive();
  try {
    const ping = await s.send('ping', {}, 6000);
    const cmds = (ping.result && ping.result.features && ping.result.features.commands) || [];
    t.check('no feature failed to register', ping.result && ping.result.features && ping.result.features.problems.length === 0, JSON.stringify(ping.result && ping.result.features && ping.result.features.problems));
    for (const c of ['gamemode.scan', 'gamemode.apply', 'gamemode.power', 'gamemode.saver', 'gamemode.guard', 'gamemode.trim', 'gamemode.trimbg'])
      t.check(`${c} is registered`, cmds.includes(c), cmds.filter((x) => /^game/.test(x)).join(','));

    // ---- scan
    const a = await s.send('gamemode.scan', {}, 6000);
    t.check('scan answers with the foreground', a.ok && a.result && a.result.fg && 'verdict' in a.result.fg, JSON.stringify(a).slice(0, 300));
    t.check('scan without procs lists none', a.ok && !('procs' in a.result));
    const b = await s.send('gamemode.scan', { procs: true, detail: true }, 10000);
    const procs = (b.result && b.result.procs) || [];
    t.check('scan lists the processes', procs.length > 20, `n=${procs.length} ms=${b.result && b.result.ms}`);
    const own = procs.find((p) => p.pid === process.pid);
    t.check('scan reads a normal process in detail (path, start time, priority)', !!(own && own.path && own.created && own.prio), JSON.stringify(own));
    const NEVER = /^(VALORANT|Riot|vgc|vgtray|vgk|EasyAntiCheat|BEService|javaw|java|Minecraft|Roblox|Discord|Spotify)/i;
    const gameish = procs.filter((p) => NEVER.test(p.file || ''));
    t.check('ANTI-CHEAT: a game / anti-cheat / never-touch name is listed by name only, never opened',
      gameish.every((p) => !('path' in p) && !('created' in p) && !('prio' in p)),
      gameish.map((p) => `${p.file}:${p.pid}:${'path' in p ? 'OPENED' : 'not opened'}`).join(' '));
    t.check('scan took under 250 ms', b.result && b.result.ms < 250, `${b.result && b.result.ms} ms`);

    // ---- the idle cost (lane r6-cpu, 2026-09-30): the top bar asks for this list once a second and game
    // mode every 3 s, so a steady list must not ask Windows about processes it already knows. It used to
    // ask about every process it could not read (~110 here) on every scan.
    const asks = [], walls = [];
    for (let i = 0; i < 6; i++) {
      const r = (await s.send('gamemode.scan', { procs: true }, 10000)).result || {};
      asks.push(r.sessionAsks); walls.push(r.ms);
      await T.sleep(50);
    }
    t.check('scan: once the list is known, a scan asks Windows about almost no process (sessionAsks <= 5)',
      asks.slice(3).every((n) => typeof n === 'number' && n <= 5), `sessionAsks per scan: ${asks.join(',')}`);
    console.log(`  process list: ${procs.length} processes, wall ms per scan ${walls.join(',')}, sessionAsks ${asks.join(',')}`);

    // ---- guard (pure)
    const G = async (args) => ((await s.send('gamemode.guard', Object.assign({ session: 1, ownSession: 1 }, args), 4000)).result || {});
    const rows = [
      [{ file: 'VALORANT-Win64-Shipping.exe', path: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', pid: 5000 }, true],
      [{ file: 'vgc.exe', path: 'C:\\Program Files\\Riot Vanguard\\vgc.exe', pid: 5001 }, true],
      [{ file: 'javaw.exe', path: 'C:\\x\\javaw.exe', pid: 5002 }, true],
      [{ file: 'RobloxPlayerBeta.exe', path: 'C:\\x\\RobloxPlayerBeta.exe', pid: 5003 }, true],
      [{ file: 'Discord.exe', path: 'C:\\Users\\o\\AppData\\Local\\Discord\\app-1\\Discord.exe', pid: 5004 }, true],
      [{ file: 'Spotify.exe', path: 'C:\\Users\\o\\AppData\\Roaming\\Spotify\\Spotify.exe', pid: 5005 }, true],
      [{ file: 'obs64.exe', path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', pid: 5006 }, true],
      [{ file: 'explorer.exe', path: 'C:\\Windows\\explorer.exe', pid: 5007 }, true],
      [{ file: 'svchost.exe', path: 'C:\\Windows\\System32\\svchost.exe', pid: 5008 }, true],
      [{ file: 'claude.exe', path: 'C:\\Users\\o\\.local\\bin\\claude.exe', pid: 5009, session: 0 }, true],
      [{ file: 'claude.exe', path: 'C:\\Users\\o\\.local\\bin\\claude.exe', pid: 5010, elevated: true }, true],
      [{ file: 'claude.exe', path: 'C:\\Users\\o\\.local\\bin\\claude.exe', pid: 5011, fgPid: 5011 }, true],
      [{ file: 'Mantle.Sidecar.exe', path: 'C:\\Users\\o\\mantle\\sidecar\\bin\\Mantle.Sidecar.exe', pid: 5012 }, true],
      [{ file: 'lghub_agent.exe', path: 'C:\\Program Files\\LGHUB\\lghub_agent.exe', pid: 5013 }, true],
      [{ file: 'x.exe', path: '', pid: 5014 }, true],
      [{ file: 'claude.exe', path: 'C:\\Users\\o\\.local\\bin\\claude.exe', pid: 5015 }, false],
      [{ file: 'msedgewebview2.exe', path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\140\\msedgewebview2.exe', pid: 5016 }, false],
      [{ file: 'WindowsTerminal.exe', path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe', pid: 5017 }, false],
    ];
    for (const [args, refuse] of rows) {
      const r = await G(args);
      t.check(`guard ${args.file}${args.session === 0 ? ' (session 0)' : ''}${args.elevated ? ' (elevated)' : ''}${args.fgPid ? ' (in front)' : ''}: ${refuse ? 'refused' : 'allowed'}`,
        r.refuse === refuse, r.why || '');
    }
    const selfPid = (ping.result && ping.result.pid) || 0;
    t.check('guard: the sidecar itself is refused', (await G({ file: 'x.exe', path: 'C:\\x\\x.exe', pid: selfPid })).refuse === true);

    // ---- apply: passive refuses a change; a same-value request writes nothing
    const me = { pid: process.pid, created: own && own.created, file: own && own.file };
    const r1 = await s.send('gamemode.apply', { items: [Object.assign({ eco: { control: 1, state: 1 }, prio: 'belownormal', prioIf: 'normal' }, me)] }, 6000);
    const x1 = r1.result && r1.result.results && r1.result.results[0];
    const ecoWas = x1 && x1.eco && x1.eco.before;
    const ecoIsOn = ecoWas && ecoWas.control === 1 && ecoWas.state === 1;
    t.check('apply (passive): efficiency mode is refused, nothing written',
      !!x1 && x1.eco && x1.eco.wrote === false && (ecoIsOn || String(x1.eco.why).startsWith(T.PASSIVE_REFUSAL)), JSON.stringify(x1));
    t.check('apply (passive): the priority change is refused, nothing written',
      !!x1 && x1.prio && x1.prio.wrote === false && (x1.prio.before !== 'normal' || String(x1.prio.why).startsWith(T.PASSIVE_REFUSAL)), JSON.stringify(x1 && x1.prio));
    t.check('apply reports the state it found (for the restore record)', !!(x1 && x1.eco && 'before' in x1.eco && x1.prio && x1.prio.before), JSON.stringify(x1));
    if (ecoWas) {
      const r2 = await s.send('gamemode.apply', { items: [Object.assign({ eco: ecoWas, prio: x1.prio.before }, me)] }, 6000);
      const x2 = r2.result.results[0];
      t.check('apply: a same-value request succeeds and writes nothing', x2.ok === true && x2.same === true && x2.eco.wrote === false && x2.prio.wrote === false, JSON.stringify(x2));
    }
    const r3 = await s.send('gamemode.apply', { items: [Object.assign({}, me, { created: '1', eco: { control: 1, state: 1 } })] }, 6000);
    t.check('apply: a pid whose start time does not match is left alone (pid reuse)', r3.result.results[0].gone === true && !r3.result.results[0].eco, JSON.stringify(r3.result.results[0]));
    const vg = procs.find((p) => NEVER.test(p.file || '') && p.session === (b.result.ownSession));
    if (vg) {
      const r4 = await s.send('gamemode.apply', { items: [{ pid: vg.pid, eco: { control: 1, state: 1 }, prio: 'belownormal' }] }, 6000);
      const x4 = r4.result.results[0];
      t.check(`ANTI-CHEAT: apply on ${vg.file} is refused before it is opened`, x4.ok === false && /^refused: /.test(x4.why) && !x4.eco && !x4.path, JSON.stringify(x4));
    } else t.check('ANTI-CHEAT: (no never-touch process in this session to aim at; guard rows above cover it)', true);
    const r5 = await s.send('gamemode.apply', { items: [{ pid: 4, eco: { control: 1, state: 1 } }] }, 6000);
    t.check('apply: the System process is refused', r5.result.results[0].ok === false, JSON.stringify(r5.result.results[0]));

    // ---- the app in front (lane sysmon-game, 2026-09-29): never SLOWED, but always PUT BACK. A child
    // this test started stands in for "the app in front" (testFgPid: passive only); Owen's window is
    // never read for this. Before the fix the restore was refused too, and the app he was in when the
    // game closed stayed slowed until Mantle restarted.
    {
      const fk = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
      await new Promise((r) => setTimeout(r, 400));
      const sc = await s.send('gamemode.scan', { procs: true, detail: true }, 10000);
      const row = (sc.result.procs || []).find((p) => p.pid === fk.pid) || {};
      const who = { pid: fk.pid, created: row.created, file: row.file };
      const slow = (await s.send('gamemode.apply', { testFgPid: fk.pid, items: [Object.assign({ eco: { control: 1, state: 1 }, prio: 'belownormal', prioIf: 'normal' }, who)] }, 6000)).result.results[0];
      t.check('in front: slowing the app in front is refused before anything is read or written', slow.ok === false && /app in front/.test(slow.why || '') && !slow.eco && !slow.prio, JSON.stringify(slow));
      const back = (await s.send('gamemode.apply', { testFgPid: fk.pid, items: [Object.assign({ eco: { control: 0, state: 0 }, ecoIf: { control: 1, state: 1 }, prio: 'normal', prioIf: 'belownormal' }, who)] }, 6000)).result.results[0];
      t.check('in front: PUTTING BACK the app in front is allowed (never "refused: the app in front")', !/app in front/.test(back.why || '') && !!back.eco && !!back.prio, JSON.stringify(back));
      t.check('in front: ...and it writes nothing here (same value, or refused as passive)', back.eco.wrote === false && back.prio.wrote === false, JSON.stringify(back));
      const mixed = (await s.send('gamemode.apply', { testFgPid: fk.pid, items: [Object.assign({ eco: { control: 0, state: 0 }, prio: 'belownormal' }, who)] }, 6000)).result.results[0];
      t.check('in front: an item that lifts one throttle but sets another is still refused', mixed.ok === false && /app in front/.test(mixed.why || ''), JSON.stringify(mixed));
      const real = (await s.send('gamemode.apply', { items: [Object.assign({ eco: { control: 1, state: 1 } }, who)] }, 6000)).result.results[0];
      t.check('in front: without testFgPid the stand-in is not in front (passive refusal, no write)', real.eco && real.eco.wrote === false, JSON.stringify(real));
      try { fk.kill(); } catch (_) { /* gone */ }
    }

    // ---- sessions asked once per process (lane sysmon-game, 2026-09-29): the same answer every scan
    {
      const s1 = (await s.send('gamemode.scan', { procs: true }, 10000)).result;
      const s2 = (await s.send('gamemode.scan', { procs: true }, 10000)).result;
      const m1 = new Map((s1.procs || []).map((p) => [p.pid + ':' + p.file, p.session]));
      const both = (s2.procs || []).filter((p) => m1.has(p.pid + ':' + p.file));
      const diff = both.filter((p) => m1.get(p.pid + ':' + p.file) !== p.session);
      t.check('sessions: a second scan gives every process the same session', both.length > 20 && diff.length === 0, `same ${both.length}, differ ${diff.length}`);
      const mine = (s2.procs || []).find((p) => p.pid === process.pid);
      t.check('sessions: this test runs in the scan\'s own session', mine && mine.session === s2.ownSession, JSON.stringify(mine && mine.session) + ' vs ' + s2.ownSession);
      const late = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
      await new Promise((r) => setTimeout(r, 300));
      const s3 = (await s.send('gamemode.scan', { procs: true }, 10000)).result;
      const lr = (s3.procs || []).find((p) => p.pid === late.pid);
      t.check('sessions: a process started after the last scan gets its session', lr && lr.session === s3.ownSession, JSON.stringify(lr));
      const ms = [];
      for (let i = 0; i < 9; i++) ms.push((await s.send('gamemode.scan', { procs: true }, 10000)).result.ms);
      ms.sort((x, y) => x - y);
      t.check(`sessions: the 3 s watch's scan is cheap (median ${ms[4]} ms, ${(s3.procs || []).length} processes)`, ms[4] < 60, ms.join(','));
      try { late.kill(); } catch (_) { /* gone */ }
    }

    // ---- power: same value = no write; a change = passive refusal
    const pm = await s.send('powermode.get', {}, 6000);
    const st = pm.result || {};
    if (st.ok && st.available && (st.source === 'ac' || st.source === 'battery')) {
      const mine = st.configured && st.configured[st.source === 'ac' ? 'ac' : 'battery'];
      const p1 = await s.send('gamemode.power', { source: st.source, mode: mine }, 6000);
      t.check(`power: asking for the current ${st.source} choice (${mine}) is same-value, nothing written`, p1.result && p1.result.ok === true && p1.result.same === true, JSON.stringify(p1.result).slice(0, 300));
      const other = mine === 'performance' ? 'balanced' : 'performance';
      const p2 = await s.send('gamemode.power', { source: st.source, mode: other }, 6000);
      t.check(`power: a change to ${other} is refused as passive`, p2.result && p2.result.ok === false && String(p2.result.reason).startsWith(T.PASSIVE_REFUSAL), JSON.stringify(p2.result).slice(0, 300));
      const third = ['efficiency', 'balanced', 'performance'].find((m) => m !== mine && m !== other);
      const p3 = await s.send('gamemode.power', { source: st.source, mode: other, onlyIf: third }, 6000);
      t.check('power: a restore whose value was changed since is left alone', p3.result && (p3.result.skipped === true || p3.result.same === true), JSON.stringify(p3.result).slice(0, 300));
    } else t.check(`power: (not settable here: ${st.reason || 'no state'}) - skipped`, true);
    const bad = await s.send('gamemode.power', { source: 'mains', mode: 'performance' }, 4000);
    t.check('power: a bad source is an error', bad.ok === false, JSON.stringify(bad));

    // ---- saver: passive = no write
    const sv = await s.send('gamemode.saver', { at: 100 }, 6000);
    t.check('saver (passive): same value or refused, never written', sv.result && (sv.result.same === true || String(sv.result.reason).startsWith(T.PASSIVE_REFUSAL) || sv.result.ok === false), JSON.stringify(sv.result));
    const svb = sv.result && sv.result.before;
    if (typeof svb === 'number') {
      const sv2 = await s.send('gamemode.saver', { at: svb }, 6000);
      t.check(`saver: asking for the current level (${svb}%) is same-value`, sv2.result && sv2.result.same === true, JSON.stringify(sv2.result));
    }

    // ---- trim (lane memfix): only the process that started the sidecar (here: this node) and its
    // same-exe children; never the sidecar, never anything else (refused before any handle is opened)
    const kid = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 400));
    const sc2 = await s.send('gamemode.scan', { procs: true }, 10000);
    const explorer = (sc2.result.procs || []).find((p) => /^explorer\.exe$/i.test(p.file));
    const tr = await s.send('gamemode.trim', { pids: [process.pid, kid.pid, sc2.result.ownPid, explorer ? explorer.pid : 4, 999999] }, 8000);
    const rs = (tr.result && tr.result.results) || [];
    t.check('trim: the process that started the sidecar is trimmed', rs[0] && rs[0].ok === true, JSON.stringify(rs[0]));
    t.check('trim: its same-exe child is trimmed', rs[1] && rs[1].ok === true, JSON.stringify(rs[1]));
    t.check('trim: the sidecar itself is refused (the key hook)', rs[2] && rs[2].ok === false && /sidecar itself/.test(rs[2].why), JSON.stringify(rs[2]));
    t.check('trim: any other process (explorer) is refused by name', rs[3] && rs[3].ok === false && /not one of Mantle's own/.test(rs[3].why), JSON.stringify(rs[3]));
    t.check('trim: a pid that does not exist says so', rs[4] && rs[4].ok === false && /exited/.test(rs[4].why), JSON.stringify(rs[4]));
    t.check('trim: counts what it trimmed', tr.result && tr.result.trimmed === 2, JSON.stringify(tr.result && tr.result.trimmed));
    const trBad = await s.send('gamemode.trim', {}, 4000);
    t.check('trim: no pids is an error', trBad.ok === false, JSON.stringify(trBad));
    try { kid.kill(); } catch (_) { /* gone */ }
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})().catch((e) => { console.error(e); process.exit(1); });
