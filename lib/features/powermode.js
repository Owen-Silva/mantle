'use strict';
/* powermode.js - the Power mode switch in the quick-settings panel (osd lane, wave 3, 2026-09-24).
 * The control is ui/bar/powermode.js; the sidecar half is sidecar/PowerMode.cs (powrprof's overlay
 * API, measured on the user's machine there). This file only relays: the panel's commands, and the
 * sidecar's 'powermode' push (a change made in Windows Settings, a plan switch, plugging in) to
 * every page as 'powermode', which the open panel listens for.
 *
 * Nothing in Windows is changed by installing or stopping this: a set happens only on a click, and
 * it is Windows' own setting (Settings > System > Power shows the same value), so stop() leaves it.
 *
 * QUALITY PASS (lane sysmon-power, 2026-09-29):
 *   - every argument is checked HERE before it reaches the sidecar (a mode is one of three words, a
 *     plan is a GUID); a bad one is answered in plain words and nothing is sent;
 *   - a --test instance sends every set and plan switch as a dryRun (the sidecar checks everything a
 *     real one would and writes nothing), and says so in the reply;
 *   - a failure that is Mantle's own (no answer, a timeout) reaches the page in plain words; the
 *     technical detail goes to the log only. Tested by lib/features/powermode.test.js.
 */
const MODES = ['efficiency', 'balanced', 'performance'];
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const OFF = 'the power mode switch is turned off in Mantle’s tray menu';
const NO_ANSWER = 'Windows did not answer in time. Try again in a moment';
const TEST_RUN = 'this is a test run, so Windows was not changed';

module.exports = {
  name: 'powermode',
  label: 'Power mode switch (quick settings)',
  defaultOn: true,
  chords: [],
  observe: [],
  MODES,
  install(ctx) {
    let last = null;
    const dry = !!(ctx.flags && ctx.flags.test);

    async function read() {
      const r = await ctx.sidecar.send('powermode.get', {}, { timeoutMs: 3000 });
      if (!r.ok) {
        ctx.log(`get failed: ${r.error}`);
        return { ok: false, mode: null, available: false, reason: 'Windows did not answer in time, so Mantle could not read the power mode' };
      }
      last = r.result;
      return r.result;
    }

    /* A sidecar reply after a write: in a test run the reply is a dryRun, and the page must not
       read "ok" as "Windows changed" - it says what would have happened instead. */
    function answer(r, what) {
      const res = r.result || {};
      if (res.state) last = res.state;
      if (res.dryRun && res.ok && !res.same) return Object.assign({}, res, { ok: false, reason: TEST_RUN });
      return res;
    }

    ctx.command('get', async () => {
      if (!ctx.enabled()) return { ok: false, mode: null, available: false, reason: OFF };
      return read();
    });
    ctx.command('set', async (a) => {
      const mode = a && a.mode;
      if (!MODES.includes(mode)) return { ok: false, mode: null, state: last, reason: 'that is not a power mode Windows has' };
      if (!ctx.enabled()) return { ok: false, mode, state: last, reason: OFF };
      const r = await ctx.sidecar.send('powermode.set', dry ? { mode, dryRun: true } : { mode }, { timeoutMs: 4000 });
      if (!r.ok) { ctx.log(`set ${mode} failed: ${r.error}`); return { ok: false, mode, state: await read(), reason: NO_ANSWER }; }
      const res = answer(r, 'set');
      ctx.log(`set ${mode}${dry ? ' (dry run)' : ''}: ${res.ok ? 'taken' : 'refused'}${res.reason ? ` (${res.reason})` : ''}`);
      return res;
    });

    // A power PLAN switch (when the plan is not Balanced the panel offers the plans; Windows applies
    // a mode only on Balanced). The user's click only: nothing here switches a plan by itself.
    ctx.command('plan', async (a) => {
      const plan = a && a.plan;
      if (typeof plan !== 'string' || !GUID.test(plan)) return { ok: false, plan: null, state: last, reason: 'that is not a power plan on this PC' };
      if (!ctx.enabled()) return { ok: false, plan, state: last, reason: OFF };
      const r = await ctx.sidecar.send('powermode.plan', dry ? { plan, dryRun: true } : { plan }, { timeoutMs: 6000 });
      if (!r.ok) { ctx.log(`plan failed: ${r.error}`); return { ok: false, plan, state: await read(), reason: NO_ANSWER }; }
      const res = answer(r, 'plan');
      const name = (res.state && res.state.plan && res.state.plan.name) || plan;
      ctx.log(`plan${dry ? ' (dry run)' : ''}: ${res.ok ? `taken (now "${name}")` : 'refused'}${res.reason ? ` (${res.reason})` : ''}`);
      return res;
    });

    ctx.sidecar.on('powermode', (ev) => {
      const s = Object.assign({}, ev);
      delete s.ev;
      last = s;
      ctx.broadcast('powermode', s);
    });
    ctx.sidecar.onReady(async () => {
      const w = await ctx.sidecar.send('powermode.watch', { on: true }, { timeoutMs: 4000 });
      if (!w.ok) { ctx.health(false, `power mode changes are not being watched: ${w.error}`); return; }
      const st = w.result && w.result.state;
      if (st) last = st;
      // Healthy even off the Balanced plan: the control is drawn muted with that reason, which is
      // the truth about Windows, not a Mantle failure.
      ctx.health(true);
      // mode = the choice for this power source (Settings' value); inForce = what Windows runs (2026-09-25).
      ctx.log(`mode=${st && st.mode} inForce=${st && st.inForce} source=${st && st.source} saver=${st && st.saver}` +
        ` settable=${st && st.settable} available=${st && st.available} plan="${st && st.plan && st.plan.name}"` +
        `${w.result.reason ? ` watch: ${w.result.reason}` : ''}`);
    });

    return {
      stop() { ctx.sidecar.send('powermode.watch', { on: false }, { timeoutMs: 1500 }); },
    };
  },
};
