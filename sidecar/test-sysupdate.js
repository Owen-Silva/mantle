// test-sysupdate.js - SysUpdate.cs (Settings > Windows Update) against a PASSIVE sidecar (lane gameupd,
// 2026-09-29).
//
//   node sidecar/test-sysupdate.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes Windows Update: no check is started (the ONLINE check is proven by its dryRun and the
// passive refusal only), nothing is paused or resumed, the active hours stay, and the administrator
// actions are proven by elevate.list only (never run, so no UAC prompt). Nothing is ever installed,
// uninstalled or restarted. The reads (status, the OFFLINE list, history) are real. Prints counts and
// shapes only, never an update's title.
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSUPDATE');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 20000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 240);
  const msOrNull = (v) => v === null || (typeof v === 'number' && v > 1.0e12 && v < 2.2e12);

  try {
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['update.status', 'update.list', 'update.history', 'update.check', 'update.pause', 'update.activeHours']) t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /Update/.test(p));
    t.check('no SysUpdate registration problems', probs.length === 0, probs.join('; '));
    const el = await send('elevate.list');
    const acts = (el.ok && el.result && el.result.actions) || [];
    const pa = acts.find((a) => a.action === 'update.pause'), ah = acts.find((a) => a.action === 'update.activeHours');
    t.check('update.pause is an elevated action with its words', !!pa && pa.does === 'pause or resume Windows Update for this PC', short(pa));
    t.check('update.activeHours is an elevated action with its words', !!ah && /active hours/.test(ah.does), short(ah));
    const eprobs = ((el.result && el.result.problems) || []).filter((p) => /update/i.test(p));
    t.check('no elevate problems for the update actions', eprobs.length === 0, eprobs.join('; '));

    // --- status (reads)
    const st = await send('update.status', {}, 30000);
    const x = st.ok && st.result;
    t.check('update.status answers', !!x, short(st));
    if (x) {
      t.check('build: a name and a build number', /Windows/.test(x.build.name) && /^\d{5}(\.\d+)?$/.test(x.build.build), short(x.build));
      t.check('last checked / installed: ms or null, a null says why when the agent failed', msOrNull(x.lastCheck) && msOrNull(x.lastInstall) && (x.wuaWhy === null || typeof x.wuaWhy === 'string'));
      t.check('restart required: a bool or null', x.rebootRequired === null || typeof x.rebootRequired === 'boolean');
      t.check('pause: paused bool, until ms or null, max days, admin words', typeof x.pause.paused === 'boolean' && msOrNull(x.pause.until) && x.pause.maxDays > 0 && /pause or resume/.test(x.pause.does), short(x.pause));
      t.check('active hours: two hours 0-23', [x.hours.start, x.hours.end].every((h) => Number.isInteger(h) && h >= 0 && h <= 23), short(x.hours));
      t.check('advanced switches: five, each on/set, with the read-only reason', ['latest', 'otherProducts', 'expedite', 'metered', 'restartNotify'].every((k) => typeof x.flags[k].on === 'boolean' && typeof x.flags[k].set === 'boolean') && /only pause and active hours/.test(x.flags.why));
      t.check('delivery optimization: words or why, and the read-only reason', (typeof x.delivery.words === 'string' || typeof x.delivery.why === 'string') && typeof x.delivery.readOnly === 'string', short(x.delivery));
      t.check('insider: joined bool and why it is read-only', typeof x.insider.joined === 'boolean' && /Microsoft account/.test(x.insider.why));
      t.check('no check is running', x.check.running === false, short(x.check));
      console.log(`  (build ${x.build.version || '?'} ${x.build.build}, checked ${x.lastCheck ? Math.round((Date.now() - x.lastCheck) / 3600e3) + ' h ago' : 'never'}, restart ${x.rebootRequired}, paused ${x.pause.paused}, hours ${x.hours.start}-${x.hours.end}, delivery ${x.delivery.mode}, insider ${x.insider.joined})`);
    }

    // --- the OFFLINE list and the history (reads)
    const ls = await send('update.list', {}, 90000);
    t.check('update.list answers pending and optional (offline)', ls.ok && Array.isArray(ls.result.pending) && Array.isArray(ls.result.optional) && ls.result.offline === true, short(ls));
    if (ls.ok) {
      const all = ls.result.pending.concat(ls.result.optional);
      t.check('every update: a title, KBs, a kind, a size or null', all.every((u) => typeof u.title === 'string' && Array.isArray(u.kb) && ['update', 'driver', 'definition', 'security', 'feature'].includes(u.kind) && (u.size === null || u.size >= 0)));
      console.log(`  (${ls.result.pending.length} pending, ${ls.result.optional.length} optional)`);
    }
    const hi = await send('update.history', { count: 20 }, 60000);
    t.check('update.history answers', hi.ok && Array.isArray(hi.result.items) && Number.isInteger(hi.result.total), short(hi));
    if (hi.ok) {
      const it = hi.result.items;
      t.check('history: at most 20, each titled, dated, install/uninstall, a result word', it.length <= 20 && it.every((h) => h.title && msOrNull(h.date) && ['install', 'uninstall'].includes(h.op) && typeof h.result === 'string' && typeof h.ok === 'boolean'));
      t.check('history: newest first', it.every((h, i) => i === 0 || !h.date || !it[i - 1].date || it[i - 1].date >= h.date));
      console.log(`  (history: ${hi.result.total} total, ${it.length} read, ${it.filter((h) => !h.ok).length} not succeeded)`);
    }
    const hb = await send('update.history', { count: 500 });
    t.check('history refuses a count over 200', hb.ok === false && /1 to 200/.test(hb.error), short(hb));

    // --- check for updates: dryRun only (a real one is a network action)
    const cd = await send('update.check', { dryRun: true });
    t.check('check dryRun says it is a network check that installs nothing', cd.ok && cd.result.dryRun && /network check: nothing is downloaded or installed/.test(cd.result.would), short(cd));
    const cr = await send('update.check', {});
    t.check('a real check is refused in passive', refused(cr), short(cr));

    // --- pause / active hours: dryRun + validation + passive refusal (no prompt)
    const p1 = await send('update.pause', { weeks: 1, dryRun: true });
    t.check('pause 1 week dryRun names the administrator prompt and the date', p1.ok && p1.result.dryRun && /administrator permission/.test(p1.result.would) && /until \d{4}-\d\d-\d\d/.test(p1.result.would), short(p1));
    const p0 = await send('update.pause', { weeks: 0, dryRun: true });
    t.check('resume dryRun', p0.ok && p0.result.dryRun && /resume updates/.test(p0.result.would), short(p0));
    for (const [a, re] of [[{ weeks: 6, dryRun: true }, /0 \(resume\) to 5/], [{ weeks: 1.5, dryRun: true }, /whole number/], [{ weeks: '1', dryRun: true }, /whole number/], [{ dryRun: true }, /whole number/]]) {
      const r = await send('update.pause', a);
      t.check(`pause refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }
    const pr = await send('update.pause', { weeks: 1 });
    t.check('a real pause is refused in passive (no prompt)', refused(pr), short(pr));
    if (x) {
      const h1 = await send('update.activeHours', { start: x.hours.start, end: x.hours.end === x.hours.start ? (x.hours.start + 8) % 24 : x.hours.end, dryRun: true });
      t.check('active hours dryRun names the administrator prompt', h1.ok && h1.result.dryRun && /administrator permission/.test(h1.result.would) || /^Read only/.test(h1.error || ''), short(h1));
    }
    for (const [a, re] of [[{ start: 24, end: 5, dryRun: true }, /0 to 23/], [{ start: 8, end: 8, dryRun: true }, /at least one hour/], [{ start: 1, end: 22, dryRun: true }, /18 hours/], [{ start: 8, dryRun: true }, /start and end/]]) {
      const r = await send('update.activeHours', a);
      t.check(`active hours refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }
    const hr = await send('update.activeHours', { start: 8, end: 17 });
    t.check('a real active hours change is refused in passive (no prompt)', refused(hr) || /^Read only/.test(hr.error || ''), short(hr));

    const again = await send('update.status', {}, 30000);
    t.check('nothing changed (pause, active hours, no check running)', again.ok && x && again.result.pause.paused === x.pause.paused && again.result.pause.until === x.pause.until &&
      again.result.hours.start === x.hours.start && again.result.hours.end === x.hours.end && again.result.check.running === false, short(again.result && again.result.pause));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
