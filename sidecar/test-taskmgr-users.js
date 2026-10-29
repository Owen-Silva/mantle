// test-taskmgr-users.js - sidecar/Users.cs (taskmgr.users / userop) and sidecar/StartupMeta.cs
// (taskmgr.startupmeta) against a PASSIVE sidecar (lane tm-users, 2026-10-28).
//
//   node sidecar/test-taskmgr-users.js --exe=<Mantle.Sidecar.exe>     (or MANTLE_SIDECAR_EXE)
//
// NOBODY IS SIGNED OUT, DISCONNECTED OR CONNECTED: every userop here is unconfirmed (Windows' confirm
// answer), a dryRun, a refusal decided before any WTS call, or ONE real disconnect sent to a passive
// sidecar that must refuse it before acting. That one is only sent after the sidecar said passive:true
// in its ready event AND refused a real service start as passive. Signoff is never sent real.
// Prints counts, session numbers and timings only (no user names, full names or paths).
//
// Prints "TASKMGR USERS SIDECAR: n passed, m failed".
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

(async () => {
  const t = T.checker('TASKMGR USERS SIDECAR');
  const s = await T.startPassive();
  try {
    // ---------------------------------------------------------------- taskmgr.users
    let t0 = Date.now();
    const u = await s.call('taskmgr.users', {}, 6000);
    const uWall = Date.now() - t0;
    t0 = Date.now();
    const u2 = await s.call('taskmgr.users', {}, 6000);
    const u2Wall = Date.now() - t0;
    console.log(`  (read-only) ${u.rows.length} signed-in session(s); users first ${u.ms} ms (wall ${uWall}), repeat ${u2.ms} ms (wall ${u2Wall})`);
    t.check('users: rows is a non-empty array', Array.isArray(u.rows) && u.rows.length >= 1, JSON.stringify(u.rows && u.rows.length));
    t.check('users: every row has the shape', u.rows.every((r) => Number.isInteger(r.session) && r.session >= 1 && typeof r.user === 'string' && r.user
      && (r.domain === null || typeof r.domain === 'string') && (r.fullName === null || typeof r.fullName === 'string')
      && (r.status === null || r.status === 'Disconnected') && typeof r.state === 'string' && typeof r.self === 'boolean'
      && (r.logon === null || /^\d+$/.test(r.logon))));
    const self = u.rows.filter((r) => r.self);
    t.check('users: exactly one row is this sidecar\'s own session', self.length === 1, String(self.length));
    const me = self[0];
    t.check('users: own session is active with a blank status (Windows shows nothing for active)', me && me.state === 'active' && me.status === null, JSON.stringify(me && { state: me.state, status: me.status }));
    t.check('users: own session has a logon time in the past', me && me.logon && BigInt(me.logon) < BigInt(Date.now() + 11644473600000) * 10000n, String(me && me.logon));
    t.check('users: a full name, or null with why.fullName', u.rows.every((r) => r.fullName !== null) || (u.why && typeof u.why.fullName === 'string' && u.why.fullName.length > 0), JSON.stringify(u.why));
    console.log(`  (read-only) own session ${me && me.session}; full name ${me && me.fullName ? 'read' : 'null (' + (u.why && u.why.fullName) + ')'}`);
    t.check('users: a repeat call returns the same sessions', JSON.stringify(u2.rows.map((r) => r.session)) === JSON.stringify(u.rows.map((r) => r.session)));

    // ---------------------------------------------------------------- taskmgr.userop
    if (me) {
      const base = { session: me.session, user: me.user, logon: me.logon };
      const c1 = await s.call('taskmgr.userop', Object.assign({ op: 'signoff' }, base), 4000);
      t.check('userop signoff unconfirmed: Windows\' confirm, nothing touched', c1.ok === false && c1.needsConfirm === true && c1.title === 'Sign out user'
        && c1.text === `Do you want to sign out ${me.user}? Any unsaved data for the user may be lost.` && c1.button === 'Sign out user' && c1.dryRun === false,
        JSON.stringify({ ok: c1.ok, needsConfirm: c1.needsConfirm, button: c1.button }));
      const c2 = await s.call('taskmgr.userop', Object.assign({ op: 'signoff', dryRun: true }, base), 4000);
      t.check('userop signoff dryRun unconfirmed: the confirm still comes first', c2.ok === false && c2.needsConfirm === true && c2.dryRun === true && c2.button === 'Sign out user');
      const c3 = await s.call('taskmgr.userop', Object.assign({ op: 'disconnect', dryRun: true }, base), 4000);
      t.check('userop disconnect dryRun unconfirmed: confirm first', c3.ok === false && c3.needsConfirm === true && c3.title === 'Disconnect user'
        && c3.text === `Do you want to disconnect ${me.user}?` && c3.button === 'Disconnect user');
      const c4 = await s.call('taskmgr.userdisconnect', base, 4000);
      t.check('userdisconnect (helper name) unconfirmed: confirm first', c4.op === 'disconnect' && c4.needsConfirm === true && c4.ok === false);
      const c5 = await s.call('taskmgr.usersignoff', Object.assign({ dryRun: true }, base), 4000);
      t.check('usersignoff (helper name) dry unconfirmed: confirm first', c5.op === 'signoff' && c5.needsConfirm === true && c5.ok === false);

      const d1 = await s.call('taskmgr.userop', Object.assign({ op: 'signoff', dryRun: true, confirmed: true }, base), 4000);
      t.check('userop signoff confirmed+dryRun: would sign out, nothing touched', d1.ok === true && d1.dryRun === true && /^dry run: would sign out /.test(d1.reason) && !d1.needsConfirm && d1.session === me.session, JSON.stringify({ ok: d1.ok, dryRun: d1.dryRun }));
      const d2 = await s.call('taskmgr.userop', Object.assign({ op: 'disconnect', dryRun: true, confirmed: true }, base), 4000);
      t.check('userop disconnect confirmed+dryRun: would disconnect', d2.ok === true && d2.dryRun === true && /^dry run: would disconnect /.test(d2.reason) && d2.state === 'active');
      const d3 = await s.call('taskmgr.userop', Object.assign({ op: 'connect', dryRun: true }, base), 4000);
      t.check('userop connect to own session: refused in plain words', d3.ok === false && d3.reason === 'that is already your session' && !d3.needsConfirm);

      // a reused session number: wrong user / wrong logon time are refused before any confirm or act
      const r1 = await s.call('taskmgr.userop', { session: me.session, user: me.user + '-not-them', op: 'signoff', dryRun: true, confirmed: true }, 4000);
      t.check('userop: a different user on that session number is refused', r1.ok === false && /different user/.test(r1.reason) && !r1.needsConfirm);
      const r2 = await s.call('taskmgr.userop', Object.assign({}, base, { logon: '1', op: 'disconnect', dryRun: true, confirmed: true }), 4000);
      t.check('userop: a different logon time on that session is refused', r2.ok === false && /signed in again/.test(r2.reason));
      const r3 = await s.call('taskmgr.userop', { session: 9999, user: me.user, op: 'signoff', dryRun: true, confirmed: true }, 4000);
      t.check('userop: a session with nobody signed in is refused', r3.ok === false && /nobody is signed in to session 9999/.test(r3.reason));

      // bad requests are plain errors
      const e1 = await s.send('taskmgr.userop', { session: me.session, user: me.user, op: 'lock', dryRun: true }, 4000);
      t.check('userop: a bad op is a plain error', e1.ok === false && /op must be disconnect, connect or signoff/.test(e1.error), JSON.stringify(e1.error));
      const e2 = await s.send('taskmgr.userop', { session: 0, user: me.user, op: 'signoff', dryRun: true }, 4000);
      t.check('userop: session 0 is a plain error', e2.ok === false && /needs session/.test(e2.error));
      const e3 = await s.send('taskmgr.userop', { session: me.session, op: 'signoff', dryRun: true }, 4000);
      t.check('userop: no user is a plain error (a reused number is never acted on)', e3.ok === false && /needs user/.test(e3.error));

      // passive: ONE real (confirmed) disconnect, only once the sidecar has proved it is passive
      const probe = await s.send('taskmgr.service', { name: 'Spooler', op: 'start' }, 4000);
      const passiveProved = s.ready.passive === true && probe.ok === false && probe.error === T.PASSIVE_REFUSAL;
      t.check('passive: the sidecar says passive and refused a real service start', passiveProved, JSON.stringify({ passive: s.ready.passive, probe: probe.error }));
      if (passiveProved) {
        const p1 = await s.send('taskmgr.userop', Object.assign({ op: 'disconnect', confirmed: true }, base), 4000);
        t.check('passive: a confirmed real disconnect is refused before anything', p1.ok === false && p1.error === T.PASSIVE_REFUSAL, JSON.stringify(p1.error || p1.result));
      }
      const after = await s.call('taskmgr.users', {}, 6000);
      const me2 = after.rows.find((r) => r.self);
      t.check('users: own session still active and the same logon afterwards', me2 && me2.state === 'active' && me2.logon === me.logon);
    }

    // ---------------------------------------------------------------- taskmgr.startupmeta
    const win = process.env.SystemRoot || 'C:\\Windows';
    const explorer = path.join(win, 'explorer.exe');
    const spaced = [process.execPath, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows NT', 'Accessories', 'wordpad.exe')]
      .find((p) => / /.test(p) && fs.existsSync(p));
    const cmds = [
      `"${explorer}" /n`,                                    // 0 quoted with args
      spaced ? `${spaced} --version` : null,                 // 1 unquoted with spaces, CreateProcess-style
      path.join(win, 'System32', 'notepad'),                 // 2 unquoted, no extension -> .exe
      'explorer.exe',                                        // 3 bare name -> SearchPath
      '%windir%\\explorer.exe',                              // 4 environment variable
      'rundll32.exe shell32.dll,Control_RunDLL',             // 5 rundll32 -> the DLL
      `cmd.exe /c start "" "${explorer}"`,                   // 6 cmd /c start "" X -> X
      'C:\\no\\such\\folder\\nothing-here.exe -x',           // 7 missing -> null
    ].filter((c) => c !== null);
    const iSp = spaced ? 1 : -1, off = spaced ? 0 : -1;
    t0 = Date.now();
    const m = await s.call('taskmgr.startupmeta', { commands: cmds }, 8000);
    const mWall = Date.now() - t0;
    t0 = Date.now();
    const m2 = await s.call('taskmgr.startupmeta', { commands: cmds }, 8000);
    const m2Wall = Date.now() - t0;
    console.log(`  (read-only) startupmeta ${cmds.length} commands: first ${m.ms} ms (wall ${mWall}), repeat ${m2.ms} ms (wall ${m2Wall}); biosSec ${m.biosSec}`);
    const eq = (a, b) => typeof a === 'string' && a.toLowerCase() === String(b).toLowerCase();
    t.check('startupmeta: one row per command, in order, with the shape', Array.isArray(m.rows) && m.rows.length === cmds.length
      && m.rows.every((r, i) => r.command === cmds[i] && r.impact === null && r.diskIO === null && r.cpuMs === null && 'path' in r && 'publisher' in r));
    t.check('startupmeta: why.impact says why impact is null', m.why && m.why.impact === 'Windows measures startup impact itself and keeps it for administrators');
    t.check('startupmeta: biosSec a number, or null with why.bios', (typeof m.biosSec === 'number' && m.biosSec > 0 && m.biosSec < 600) || (m.biosSec === null && typeof m.why.bios === 'string'), JSON.stringify({ b: m.biosSec, w: m.why.bios }));
    t.check('startupmeta: quoted explorer -> its path, publisher Microsoft Corporation', eq(m.rows[0].path, explorer) && m.rows[0].publisher === 'Microsoft Corporation', JSON.stringify(m.rows[0].publisher));
    if (spaced) t.check('startupmeta: an unquoted path with spaces resolves like CreateProcess', eq(m.rows[iSp].path, spaced) && typeof m.rows[iSp].publisher === 'string');
    else t.check('startupmeta: found an exe under a spaced folder to test with', false);
    t.check('startupmeta: no extension -> .exe appended', eq(m.rows[2 + off].path, path.join(win, 'System32', 'notepad.exe')), m.rows[2 + off].path ? 'other path' : 'null');
    t.check('startupmeta: a bare name is searched', eq(m.rows[3 + off].path, explorer), m.rows[3 + off].path ? 'other path' : 'null');
    t.check('startupmeta: environment variables expanded', eq(m.rows[4 + off].path, explorer));
    t.check('startupmeta: rundll32 -> the DLL it loads', /\\shell32\.dll$/i.test(m.rows[5 + off].path || '') && m.rows[5 + off].publisher === 'Microsoft Corporation');
    t.check('startupmeta: cmd /c start "" X -> X', eq(m.rows[6 + off].path, explorer));
    t.check('startupmeta: a missing program -> path and publisher null, why.publisher says so', m.rows[7 + off].path === null && m.rows[7 + off].publisher === null && /could not find the program/.test(m.why.publisher || ''));
    t.check('startupmeta: a repeat is as answered and no slower than the first by much (cache)', JSON.stringify(m2.rows) === JSON.stringify(m.rows) && m2.ms <= m.ms + 20, `${m.ms} -> ${m2.ms}`);

    // a Start-menu shortcut -> its target (LinkInfo), never the .lnk itself when the link has a local target
    const smDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    let lnks = [];
    try { lnks = fs.readdirSync(smDir).filter((f) => /\.lnk$/i.test(f)).slice(0, 20).map((f) => path.join(smDir, f)); } catch (_) { /* none */ }
    if (lnks.length) {
      const L = await s.call('taskmgr.startupmeta', { commands: lnks }, 8000);
      const resolved = L.rows.filter((r) => r.path && !/\.lnk$/i.test(r.path) && fs.existsSync(r.path));
      t.check('startupmeta: Start-menu shortcuts resolve to their targets', resolved.length >= 1, `${resolved.length}/${lnks.length}`);
      console.log(`  (read-only) ${resolved.length}/${lnks.length} shortcuts resolved to a target`);
    }

    // the 256 cap and bad input
    const many = Array.from({ length: 256 }, (_, i) => (i % 2 ? `"${explorer}"` : 'C:\\no\\such\\x' + i + '.exe'));
    t0 = Date.now();
    const mm = await s.call('taskmgr.startupmeta', { commands: many }, 10000);
    console.log(`  (read-only) startupmeta 256 commands: ${mm.ms} ms (wall ${Date.now() - t0})`);
    t.check('startupmeta: 256 commands answered', mm.rows.length === 256);
    const big = await s.send('taskmgr.startupmeta', { commands: many.concat(['x']) }, 6000);
    t.check('startupmeta: 257 commands refused in plain words', big.ok === false && /more than 256 commands/.test(big.error), JSON.stringify(big.error));
    const bad = await s.send('taskmgr.startupmeta', { commands: 'notepad.exe' }, 4000);
    t.check('startupmeta: commands must be a list', bad.ok === false && /needs commands/.test(bad.error));
    const odd = await s.call('taskmgr.startupmeta', { commands: [null, 7, '', '"unclosed'] }, 4000);
    t.check('startupmeta: odd entries -> rows with a null path, no failure', odd.rows.length === 4 && odd.rows.every((r) => r.path === null));
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
