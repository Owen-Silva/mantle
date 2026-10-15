'use strict';
/* apppower.js - App power: per-app CPU, memory and graphics controls from the top bar's meters
 * (lane mantle-power, 2026-10-14). Owen: "i want to be able to do the cpu limits and gpu and ram and
 * stuff from here" (the CPU / RAM / GPU dropdowns).
 *
 * The parts (contract: mantle-notes/power-CONTRACT.md):
 *   - ui/topbar: each TOP PROCESSES row opens a small panel (Efficiency mode, Priority, CPU limit,
 *     Lower memory priority, Free up memory, Memory limit, Lower graphics priority, Graphics
 *     preference, Remember for this app); ui/settings/sections/apppower.js lists the saved rules;
 *   - lib/apppower-core.js: which app a row is, what is never offered, the rules, the words;
 *     its `live` state decorates every stats sample (lib/features/topbar.js onStats);
 *   - sidecar/AppPower.cs: the writes, and the watcher that applies the table to processes started
 *     later (an app restarted, a new child), restoring an app whose rule went away.
 *
 * Rules: one per app (key), "remembered" ones in <userData>/features/apppower.json (re-applied when
 * Mantle or the app starts again), the rest for this session only. The whole table goes to the
 * sidecar on every change and after every sidecar restart (it re-opens its named limits).
 *
 * A --test instance never changes a real app: every write is a dry run (the sidecar checks
 * everything and writes nothing), except rules for the throwaway exe named by
 * MANTLE_APPPOWER_TEST_EXE (the sidecar tests' burner). Turning the feature off in the tray hands
 * every app back to Windows (an empty table restores them). Quitting Mantle leaves apps as they are;
 * the next start takes them over again.
 *
 * PHASE 2 (Auto mode) plugs in through core.live.setAuto(rules): see lib/apppower-core.js.
 */
const core = require('../apppower-core');

const OFF = 'App power is turned off in Mantle’s tray menu';
const NO_ANSWER = 'Windows didn’t answer in time. Try again in a moment';
const GONE = 'That app has closed or left the list. Open the meter again';
const TEST_ONLY = 'This test copy of Mantle only changes its own test app, so it left this one alone';
const NOT_DONE = 'Mantle’s helper couldn’t make that change. Try again in a moment';
const KEY_MAX = 1200;

module.exports = {
  name: 'apppower',
  label: 'App power (CPU, memory and graphics limits)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) {
    const live = core.live;
    const test = !!(ctx.flags && ctx.flags.test);
    const testExe = test ? String(process.env.MANTLE_APPPOWER_TEST_EXE || '').toLowerCase().replace(/\.exe$/, '') : '';
    const dry = (exe) => test && !(testExe && String(exe || '').toLowerCase() === testExe);
    live.test = test;
    live.ownExe = process.execPath;
    live.rules.clear();
    live.status.clear();
    let sidecarUp = false;

    // the saved rules (each one checked: an old or hand-edited file never reaches the sidecar as it is)
    let dropped = 0;
    for (const r of [].concat(ctx.settings.get('rules', []) || [])) {
      const c = core.cleanRule(Object.assign({}, r, { remember: true }));
      if (c) live.rules.set(c.key, c); else dropped++;
    }
    if (dropped) ctx.log(`app power: ${dropped} saved rule(s) were not valid and were skipped`);

    async function sc(cmd, args, ms) {
      let r;
      try { r = await ctx.sidecar.send(cmd, args, { timeoutMs: ms || 5000 }); } catch (e) { r = { ok: false, error: e && e.message }; }
      if (r && r.ok && r.result && r.result.ok !== false) return { ok: true, result: r.result };
      const why = r && r.result && r.result.reason ? String(r.result.reason) : null;
      const err = String((r && (r.error || (r.result && r.result.error))) || '');
      ctx.log(`app power: ${cmd} failed: ${err || why || 'no reason'}`);
      // the words on the row match what happened: a refusal is not "Windows didn't answer"
      // (lane mantle-power-e2e: a passive test sidecar's refusal used to read as a time-out)
      return { ok: false, reason: why || (/passive/i.test(err) ? TEST_ONLY : !err || /time|answer|not running|exited|restart|gone|closed/i.test(err) ? NO_ANSWER : NOT_DONE) };
    }

    function persist() {
      const saved = [...live.rules.values()].filter((r) => r.remember)
        .map((r) => ({ key: r.key, exe: r.exe, path: r.path, label: r.label, set: r.set, at: r.at }));
      try { ctx.settings.set('rules', saved); return { ok: true }; } catch (e) {
        ctx.log(`app power: saving the rules failed: ${e && e.message}`);
        return { ok: false, reason: 'Mantle couldn’t save this for next time' };
      }
    }

    function takeStatus(list, all) {
      if (!Array.isArray(list)) return;
      if (all) live.status.clear();
      for (const s of list) if (s && typeof s.key === 'string') live.status.set(s.key, { applied: s.applied || 0, denied: s.denied || [], shared: s.shared == null ? null : !!s.shared });
    }

    // ONE send at a time, the latest table wins (a burst of clicks is one write per settle)
    let chain = Promise.resolve();
    function send() {
      const p = chain.then(async () => {
        if (!sidecarUp) return { ok: false, reason: 'Mantle’s helper is starting. Try again in a moment' };
        const on = ctx.enabled();
        const table = on ? live.table() : [];
        if (!test) {
          const r = await sc('apppower.rules', { rules: core.sidecarRules(table) });
          if (r.ok) takeStatus(r.result.status, true);
          return r;
        }
        // --test: the real table holds only the throwaway exe's rules; the rest is a dry run for the states
        const real = await sc('apppower.rules', { rules: core.sidecarRules(table.filter((t) => !dry(t.exe))) });
        if (!real.ok) return real;
        const d = await sc('apppower.rules', { rules: core.sidecarRules(table), dryRun: true });
        if (d.ok) takeStatus(d.result.status, true);
        return d;
      });
      chain = p.catch(() => {});
      return p;
    }
    live.onChange = () => { send(); };

    function infoOf(a) {
      const key = a && typeof a.key === 'string' && a.key.length <= KEY_MAX ? a.key : '';
      const info = key ? (live.known.get(key) || live.rules.get(key)) : null;
      return info ? { key, info } : null;
    }
    const no = (reason, extra) => Object.assign({ ok: false, reason }, extra || {});

    /* ---- the dropdown's commands ---------------------------------------------------------- */
    ctx.command('set', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const t = infoOf(a);
      if (!t) return no(GONE);
      const { key, info } = t;
      const cur = live.rules.get(key);
      const label = (cur && cur.label) || info.label;
      const why = core.protectedWhy(info.exe, info.path, info.access, label, live.ownExe);
      if (why) return no(why);
      const ch = core.applyChange(cur ? cur.set : null, a && a.change, live.caps);
      if (!ch.ok) return no(ch.reason, { row: live.row(key) });
      if (a.change && 'gpuPref' in a.change) {
        if (!info.path) return no('Mantle couldn’t find where this app lives, so it can’t set its graphics preference');
        const g = await sc('apppower.gpupref', { path: info.path, pref: a.change.gpuPref, dryRun: dry(info.exe) });
        if (!g.ok) return no(g.reason, { row: live.row(key) });
      }
      const remember = !(a && a.remember === false);
      if (core.isDefaultSet(ch.set)) live.rules.delete(key);
      else live.rules.set(key, { key, exe: info.exe, path: info.path || null, label, set: ch.set, remember, at: Date.now() });
      const s = await send();
      if (!s.ok) {   // the helper did not take it: put the old rule back so what is shown stays true
        if (cur) live.rules.set(key, cur); else live.rules.delete(key);
        return no(s.reason, { row: live.row(key) });
      }
      const saved = persist();
      return { ok: true, row: live.row(key), dryRun: dry(info.exe) || undefined, reason: saved.ok ? null : saved.reason };
    });

    ctx.command('remember', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const t = infoOf(a);
      const r = t && live.rules.get(t.key);
      if (!r) return no('There is nothing set for this app to remember');
      r.remember = !!(a && a.on);
      const saved = persist();
      return saved.ok ? { ok: true, row: live.row(t.key) } : no(saved.reason, { row: live.row(t.key) });
    });

    ctx.command('trim', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const t = infoOf(a);
      if (!t) return no(GONE);
      const { info } = t;
      const why = core.protectedWhy(info.exe, info.path, info.access, info.label, live.ownExe);
      if (why) return no(why);
      const r = await sc('apppower.trim', { match: { exe: info.exe, path: info.path || null }, dryRun: dry(info.exe) }, 8000);
      if (!r.ok) return r;
      const x = r.result;
      const deny = core.denyWords(info.label, x.n || 0, x.denied);
      if (!x.n && deny) return no(deny);
      if (x.dryRun) return { ok: true, freed: 0, dryRun: true, text: 'Test run: nothing was freed' };
      const freed = Math.max(0, (x.before || 0) - (x.after || 0));
      const text = freed >= 1024 * 1024 ? `Freed ${core.fmtBytes(freed)}` : 'Nothing more to free right now';
      return { ok: true, freed, text, reason: deny };
    });

    async function backToNormal(keys) {
      const before = new Map(live.rules);
      for (const k of keys) {
        const r = live.rules.get(k);
        if (r && r.set.gpuPref !== 'default' && r.path) await sc('apppower.gpupref', { path: r.path, pref: 'default', dryRun: dry(r.exe) });
        live.rules.delete(k);
      }
      const s = await send();
      if (!s.ok) { live.rules.clear(); for (const [k, v] of before) live.rules.set(k, v); return s; }
      const saved = persist();
      return saved.ok ? { ok: true } : no(saved.reason);
    }

    ctx.command('reset', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const t = infoOf(a);
      if (!t) return no(GONE);
      const r = await backToNormal([t.key]);
      return r.ok ? { ok: true, row: live.row(t.key) } : r;
    });

    /* ---- Mantle Settings' Power section ---------------------------------------------------- */
    const listRules = () => [...live.rules.values()].sort((x, y) => x.label.localeCompare(y.label))
      .map((r) => ({ key: r.key, exe: r.exe, path: r.path, label: r.label, set: Object.assign({}, r.set), summary: core.summary(r.set), remembered: !!r.remember }));
    ctx.command('rules', async () => ({ ok: true, on: ctx.enabled(), rules: listRules(), test }));
    ctx.command('forget', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const key = a && typeof a.key === 'string' ? a.key : '';
      if (!live.rules.has(key)) return no('That rule is already gone');
      const r = await backToNormal([key]);
      return r.ok ? { ok: true, rules: listRules() } : r;
    });
    ctx.command('resetAll', async () => {
      if (!ctx.enabled()) return no(OFF);
      const removed = [...live.rules.values()].map((r) => ({ key: r.key, exe: r.exe, path: r.path, label: r.label, set: Object.assign({}, r.set), remember: r.remember }));
      const r = await backToNormal(removed.map((x) => x.key));
      return r.ok ? { ok: true, removed, rules: listRules() } : r;
    });
    // Undo for "Reset all" / Remove: the rules it returned, back as they were
    ctx.command('restoreRules', async (a) => {
      if (!ctx.enabled()) return no(OFF);
      const list = a && Array.isArray(a.rules) ? a.rules.slice(0, 200) : [];
      const before = new Map(live.rules);
      let n = 0;
      for (const x of list) {
        const c = core.cleanRule(x && x.remembered === false ? Object.assign({}, x, { remember: false }) : x);
        if (c) { live.rules.set(c.key, Object.assign(c, { at: Date.now() })); n++; }
      }
      if (!n) return no('There was nothing to put back');
      const s = await send();
      if (!s.ok) { live.rules.clear(); for (const [k, v] of before) live.rules.set(k, v); return s; }
      const saved = persist();
      return { ok: true, restored: n, rules: listRules(), reason: saved.ok ? null : saved.reason };
    });

    /* ---- wiring ---------------------------------------------------------------------------- */
    ctx.sidecar.on('apppower', (ev) => {
      if (ev && Array.isArray(ev.status)) { if (!test) takeStatus(ev.status, false); return; }
      // one watcher pass failed (sidecar/AppPower.cs WatchLoop); it carries on and tries again 2 s later
      if (ev && ev.reason) ctx.log(`app power: ${ev.reason}`);
    });
    ctx.sidecar.onReady(async () => {
      sidecarUp = true;
      const c = await sc('apppower.caps', {}, 6000);
      if (c.ok) live.caps = { gpus: c.result.gpus == null ? null : c.result.gpus, gpuLow: !!c.result.gpuLow, gpuLowWhy: c.result.gpuLowWhy || null, gpuPref: !!c.result.gpuPref };
      else ctx.log('app power: the graphics checks did not answer; graphics controls stay hidden');
      live.running = ctx.enabled();
      const s = await send();
      ctx.health(true);
      if (!s.ok && live.rules.size) ctx.log(`app power: the saved rules were not applied yet: ${s.reason}`);
    });
    ctx.onEnabled((on) => {
      live.running = !!on && sidecarUp;
      send();   // off: an empty table hands every app back to Windows; on: the rules again
    });
    live.running = false;

    return {
      stop() { live.running = false; live.onChange = null; },
    };
  },
};
