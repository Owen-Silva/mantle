// test-keysrun-chord.js - Win+R (Run) and Win+X (Quick links), lane keysrun 2026-10-15, through the PURE
// key machine (`hotkey {op:'simulate'}`): no real keystroke, no hook (passive sidecar). Plain Win chords
// like Win+E: taken only when main lists them, the Win-up gets the partner key (0xFF) so Start stays
// shut, and EXACTLY Win+R / Win+X: Shift, Ctrl or Alt held leaves them Windows'.
// Also sidecar/Run.cs (run.exec / run.resolve / run.mru) in passive mode, and FAIL-OPEN: the hook is
// this process's, so the sidecar must be gone when Mantle is (parent death, or main closing the pipe).
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-keysrun-chord.js
//
// Step words (as sidecar/test-sidecar.js): S = swallowed, D = partner key before it, P = passed.
'use strict';
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, R: 0x52, X: 0x58, E: 0x45 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('KEYSRUN CHORD');
  const s = await T.startPassive();
  try {
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false);
    const w = { win: true };
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N', 'Win+I', 'Win+E', 'Win+R', 'Win+X'];

    const unknown = await s.send('hotkey', { chords: ['Win+Q'] }, 4000);
    t.check('the protocol knows Win+R and Win+X (an unknown chord error lists them)', unknown.ok === false && /Win\+R\b/.test(unknown.error) && /Win\+X\b/.test(unknown.error), JSON.stringify(unknown));
    const refused = await s.send('hotkey', { chords: ['Win+R', 'Win+X'] }, 4000);
    t.check('passive refuses to take them (never hooks)', refused.ok === false && /passive/.test(refused.error), JSON.stringify(refused));

    for (const [key, vk] of [['R', VK.R], ['X', VK.X]]) {
      const c = 'Win+' + key;
      await sim(`${c} is taken when on; the Win-up gets the partner key (Start stays shut)`, { chords: [c] },
        [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'S chord:' + c, 'S', 'D']);
      await sim(`${c} is taken with every other chord on beside it`, { chords: ALL },
        [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'S chord:' + c, 'S', 'D']);
      await sim(`a held ${c} is one event`, { chords: [c] },
        [winD, kv(vk, true, w), kv(vk, true, w), kv(vk, true, w), kv(vk, false, w), winU], ['P', 'S chord:' + c, 'S', 'S', 'S', 'D']);
      await sim(`${c} is Windows' own when Mantle does not list it (off, unhealthy, resting, or main gone)`, { chords: ['Win+S', 'Win+E'] },
        [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'P', 'P', 'P']);
      await sim(`${c} is Windows' own with NO chords at all (a fresh sidecar main never configured)`, { chords: [] },
        [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'P', 'P', 'P']);
      await sim(`Win+Shift+${key} stays Windows'`, { chords: ALL },
        [winD, kv(VK.LSHIFT, true, w), kv(vk, true, { win: true, shift: true }), kv(vk, false, { win: true, shift: true }), kv(VK.LSHIFT, false, w), winU],
        ['P', 'P', 'P', 'P', 'P', 'P']);
      await sim(`Win+Ctrl+${key} stays Windows'`, { chords: ALL },
        [kv(VK.LCTRL, true), winD, kv(vk, true, { win: true, ctrl: true }), kv(vk, false, { win: true, ctrl: true }), winU, kv(VK.LCTRL, false)],
        ['P', 'P', 'P', 'P', 'P', 'P']);
      await sim(`Win+Alt+${key} stays Windows'`, { chords: ALL, altTab: false },
        [winD, kv(VK.LALT, true, w), kv(vk, true, { win: true, alt: true }), kv(vk, false, { win: true, alt: true }), kv(VK.LALT, false, w), winU],
        ['P', 'P', 'P', 'P', 'P', 'P']);
      await sim(`a plain ${key} while ${c} is on is just a letter`, { chords: ALL }, [kv(vk, true), kv(vk, false)], ['P', 'P']);
      await sim(`a ${key} held BEFORE Win stays Windows' to its keyup`, { chords: [c] }, [kv(vk, true), winD, kv(vk, false, w), winU], ['P', 'P', 'P', 'P']);
    }
    await sim('Win+R then Win+X with Win held: two chords', { chords: ['Win+R', 'Win+X'] },
      [winD, kv(VK.R, true, w), kv(VK.R, false, w), kv(VK.X, true, w), kv(VK.X, false, w), winU], ['P', 'S chord:Win+R', 'S', 'S chord:Win+X', 'S', 'D']);
    await sim('Win+E is still Files\' with Win+R and Win+X on beside it', { chords: ALL },
      [winD, kv(VK.E, true, w), kv(VK.E, false, w), winU], ['P', 'S chord:Win+E', 'S', 'D']);

    /* ---- sidecar/Run.cs, passive ---- */
    const res = async (file) => { const r = await s.send('run.resolve', { file }, 4000); return r.ok ? r.result : { error: r.error }; };
    const cmd = await res('cmd.exe');
    t.check('run.resolve: cmd.exe is found (System32)', cmd.found && /\\cmd\.exe$/i.test(cmd.found) && cmd.via === 'search', JSON.stringify(cmd));
    const cmdNoExt = await res('cmd');
    t.check('run.resolve: "cmd" finds cmd.exe through PATHEXT', cmdNoExt.found && /\\cmd\.exe$/i.test(cmdNoExt.found), JSON.stringify(cmdNoExt));
    const devmgmt = await res('devmgmt.msc');
    t.check('run.resolve: devmgmt.msc (a Win+X tool) is found', devmgmt.found && /devmgmt\.msc$/i.test(devmgmt.found), JSON.stringify(devmgmt));
    const nope = await res('notarealprogram12345');
    t.check('run.resolve: an unknown name is not found', nope.found === null && nope.via === null, JSON.stringify(nope));
    const winDir = await res(process.env.SystemRoot || 'C:\\Windows');
    t.check('run.resolve: a folder is found as a folder', winDir.found && winDir.dir === true && winDir.via === 'path', JSON.stringify(winDir));
    const badName = await res('cmd\r\nnotepad');
    t.check('run.resolve: a line break is refused', badName.error && /line break/.test(badName.error), JSON.stringify(badName));

    const live = await s.send('run.exec', { file: 'notepad.exe', params: '', verb: 'open' }, 4000);
    t.check('run.exec: passive refuses to start anything', live.ok === false && live.error.startsWith(T.PASSIVE_REFUSAL), JSON.stringify(live));
    const dry = await s.send('run.exec', { file: 'perfmon', params: '/report  "a b" & | x', verb: 'runas', dryRun: true }, 4000);
    t.check('run.exec dryRun: file and params kept apart, params verbatim, runas, the profile as the folder',
      dry.ok && dry.result.dryRun === true && dry.result.file === 'perfmon' && dry.result.params === '/report  "a b" & | x' && dry.result.verb === 'runas' &&
      dry.result.dir.toLowerCase() === os.homedir().toLowerCase() && /perfmon\.exe$/i.test(dry.result.found.found), JSON.stringify(dry));
    const ctl = await s.send('run.exec', { file: 'calc', params: 'a\nb', verb: 'open', dryRun: true }, 4000);
    t.check('run.exec: a line break in the arguments is refused', ctl.ok === false && /line break/.test(ctl.error), JSON.stringify(ctl));
    const verb = await s.send('run.exec', { file: 'calc', verb: 'edit', dryRun: true }, 4000);
    t.check('run.exec: only open and runas', verb.ok === false && /only opens or runs as administrator/.test(verb.error), JSON.stringify(verb));
    const empty = await s.send('run.exec', { file: '  ', verb: 'open' }, 4000);
    t.check('run.exec: nothing to run is refused', empty.ok === false && /nothing to run/.test(empty.error), JSON.stringify(empty));
    const mru = await s.send('run.mru', {}, 4000);
    t.check('run.mru: Windows\' Run history reads as a list of lines (read-only)', mru.ok && Array.isArray(mru.result.items) && mru.result.items.every((x) => typeof x === 'string' && !/\\1$/.test(x)), JSON.stringify(mru).slice(0, 300));
  } catch (e) {
    t.check('the run finished', false, e.stack || e.message);
  } finally {
    await s.stop();
  }

  /* ---- FAIL-OPEN: the hook lives in the sidecar, and the sidecar never outlives Mantle ---- */
  try {
    const fakeMain = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const state = path.join(os.tmpdir(), `mantle-keysrun-failopen-${process.pid}.state.json`);
    const sc = T.spawnSidecar(T.exePath(), ['--passive', '--parent-pid=' + fakeMain.pid, '--state-file=' + state]);
    await sc.waitEvent('ready', 8000);
    const t0 = Date.now();
    fakeMain.kill();
    const ex = await sc.waitExit(5000).catch((e) => ({ error: e.message }));
    t.check('fail-open: Mantle dies -> the sidecar (and its keyboard hook) is gone within 5 s', !ex.error, JSON.stringify(ex));
    if (!ex.error) t.log ? t.log(`parent death -> exit in ${Date.now() - t0} ms`) : console.log(`  parent death -> sidecar exit in ${Date.now() - t0} ms`);

    const sc2 = T.spawnSidecar(T.exePath(), ['--passive', '--parent-pid=' + process.pid, '--state-file=' + state]);
    await sc2.waitEvent('ready', 8000);
    const t1 = Date.now();
    sc2.proc.stdin.end();
    const ex2 = await sc2.waitExit(5000).catch((e) => ({ error: e.message }));
    t.check('fail-open: main closes the pipe (a crash or quit) -> the sidecar is gone within 5 s', !ex2.error, JSON.stringify(ex2));
    if (!ex2.error) console.log(`  stdin closed -> sidecar exit in ${Date.now() - t1} ms`);
  } catch (e) {
    t.check('the fail-open run finished', false, e.stack || e.message);
  }
  process.exit(t.summary());
})();
