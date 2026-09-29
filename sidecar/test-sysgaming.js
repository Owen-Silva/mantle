// test-sysgaming.js - SysGaming.cs (Settings > Gaming: Xbox Game Bar, Captures, Windows Game Mode)
// against a PASSIVE sidecar (lane gameupd, 2026-09-29).
//
//   node sidecar/test-sysgaming.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes Owen's settings, and above all never switches background recording on (it costs
// frames on his integrated graphics): every write is proven by its dryRun (a passive sidecar answers
// it because it changes nothing) and by the passive refusal of the real write, and the values are
// read again at the end to prove nothing moved. Prints counts and shapes only, never the folder path.
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSGAMING');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 15000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 240);
  const SW = ['controller', 'gameMode', 'background', 'battery', 'wireless', 'audio', 'mic', 'cursor'];
  const CH = { frameRate: ['30', '60'], quality: ['standard', 'high'], audioQuality: ['128', '192'], buffer: ['15', '30', '60', '180', '300', '600'], maxLength: ['30', '60', '120', '240'] };

  try {
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['gaming.get', 'gaming.set']) t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /Gaming/.test(p));
    t.check('no SysGaming registration problems', probs.length === 0, probs.join('; '));

    const g = await send('gaming.get');
    const x = g.ok && g.result;
    const v = x && x.values;
    t.check('gaming.get answers values', !!v, short(g));
    if (v) {
      t.check('every switch is on/off with set and a lock field', SW.every((k) => v[k] && typeof v[k].on === 'boolean' && typeof v[k].set === 'boolean' && 'locked' in v[k]), short(SW.filter((k) => !v[k])));
      t.check('a switch not stored says why', SW.every((k) => v[k].set || typeof v[k].why === 'string'));
      t.check('every choice is one of its values or custom, with its options', Object.keys(CH).every((k) => v[k] && (CH[k].includes(v[k].value) || v[k].value === 'custom') && v[k].options.length === CH[k].length));
      t.check('a custom choice says why', Object.keys(CH).every((k) => v[k].value !== 'custom' || typeof v[k].why === 'string'));
      t.check('the policy is null or words', x.policy === null || /AllowGameDVR = 0/.test(x.policy), short(x.policy));
      t.check('the Game Bar package is a bool', typeof x.gameBar === 'boolean');
      t.check('the captures folder: a path ending in Captures, or why not', (typeof x.folder.path === 'string' && /\\Captures$/.test(x.folder.path)) || typeof x.folder.why === 'string');
      t.check('the captures folder: exists is a bool, files a count', typeof x.folder.exists === 'boolean' && Number.isInteger(x.folder.files || 0));
      t.check('the fps cost is said', /costs frames/.test(x.fpsCost));
      console.log(`  (game mode ${v.gameMode.on}, background recording ${v.background.on}, controller ${v.controller.on}${v.controller.set ? '' : ' (default)'}, ${v.frameRate.value} fps, quality ${v.quality.value}, buffer ${v.buffer.value}, max ${v.maxLength.value}, Game Bar ${x.gameBar}, policy ${!!x.policy}, captures folder ${x.folder.exists ? x.folder.files + ' files' : 'none'})`);

      // dryRun of the CURRENT value of every row (a no-op even if it were real)
      for (const k of SW) {
        if (v[k].locked) continue;
        const d = await send('gaming.set', { key: k, value: v[k].on, dryRun: true });
        t.check(`${k} dryRun says what it would write`, d.ok && d.result.dryRun && /^turn /.test(d.result.would) && d.result.writes.length === 1 && d.result.writes[0].hive === 'HKCU', short(d));
      }
      for (const k of Object.keys(CH)) {
        if (v[k].locked) continue;
        const to = v[k].value === 'custom' ? CH[k][0] : v[k].value;
        const d = await send('gaming.set', { key: k, value: to, dryRun: true });
        t.check(`${k} dryRun says what it would write`, d.ok && d.result.dryRun && /^set /.test(d.result.would) && d.result.writes[0].hive === 'HKCU', short(d));
      }
      // switching background recording ON is only ever a dry run, and it says what it costs
      if (!v.background.locked) {
        const bg = await send('gaming.set', { key: 'background', value: true, dryRun: true });
        t.check('background recording ON dryRun names the fps cost', bg.ok && bg.result.dryRun && /costs frames/.test(bg.result.would), short(bg));
        const bgr = await send('gaming.set', { key: 'background', value: true });
        t.check('a real background recording ON is refused in passive', refused(bgr), short(bgr));
      }
      const bf = await send('gaming.set', { key: 'buffer', value: '60', dryRun: true });
      t.check('record the last writes the length and the unit (seconds)', !v.buffer.locked ? bf.ok && bf.result.writes.length === 2 && bf.result.writes[1].name === 'HistoricalBufferLengthUnit' : true, short(bf));
      const ml = await send('gaming.set', { key: 'maxLength', value: '60', dryRun: true });
      t.check('the longest recording is a QWORD of 100 ns ticks', !v.maxLength.locked ? ml.ok && ml.result.writes[0].type === 'REG_QWORD' && ml.result.writes[0].value === 36000000000 : true, short(ml));
      const rg = await send('gaming.set', { key: 'gameMode', value: v.gameMode.on });
      t.check('a real Game Mode change is refused in passive', refused(rg), short(rg));
      const rc = await send('gaming.set', { key: 'frameRate', value: v.frameRate.value === 'custom' ? '30' : v.frameRate.value });
      t.check('a real choice change is refused in passive', refused(rc), short(rc));
      const again = await send('gaming.get');
      const a = again.ok && again.result.values;
      t.check('nothing changed', !!a && SW.every((k) => a[k].on === v[k].on && a[k].set === v[k].set) && Object.keys(CH).every((k) => a[k].value === v[k].value && a[k].raw === v[k].raw), short(a));
    }
    const bads = [
      [{ value: true }, /needs key/], [{ key: 'gameMode' }, /needs value/], [{ key: 'gameMode', value: 1, dryRun: true }, /true or false/],
      [{ key: 'nope', value: true, dryRun: true }, /unknown key/], [{ key: 'frameRate', value: '120', dryRun: true }, /must be one of/],
      [{ key: 'buffer', value: 60, dryRun: true }, /must be one of/], [{ key: 'folder', value: 'x', dryRun: true }, /^Read only/],
    ];
    for (const [args, re] of bads) {
      const r = await send('gaming.set', args);
      t.check(`set refuses ${short(args).slice(0, 60)}`, r.ok === false && re.test(r.error), short(r));
    }
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
