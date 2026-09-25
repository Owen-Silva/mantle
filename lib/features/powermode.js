'use strict';
/* powermode.js - the Power mode switch in the quick-settings panel (osd lane, wave 3, 2026-09-24).
 * The control is ui/bar/powermode.js; the sidecar half is sidecar/PowerMode.cs (powrprof's overlay
 * API, measured on Owen's machine there). This file only relays: the panel's two commands, and the
 * sidecar's 'powermode' push (a change made in Windows Settings, a plan switch, plugging in) to
 * every page as 'powermode', which the open panel listens for.
 *
 * Nothing in Windows is changed by installing or stopping this: a set happens only on a click, and
 * it is Windows' own setting (Settings > System > Power shows the same value), so stop() leaves it.
 */
module.exports = {
  name: 'powermode',
  label: 'Power mode switch (quick settings)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) {
    let last = null;

    async function read() {
      const r = await ctx.sidecar.send('powermode.get', {}, { timeoutMs: 3000 });
      if (!r.ok) return { ok: false, mode: null, available: false, reason: `the power mode could not be read (${r.error})` };
      last = r.result;
      return r.result;
    }

    ctx.command('get', async () => {
      if (!ctx.enabled()) return { ok: false, mode: null, available: false, reason: 'the power-mode switch is off in Mantle’s tray menu' };
      return read();
    });
    ctx.command('set', async (a) => {
      if (!ctx.enabled()) return { ok: false, mode: a && a.mode, state: last, reason: 'the power-mode switch is off in Mantle’s tray menu' };
      const r = await ctx.sidecar.send('powermode.set', { mode: a && a.mode }, { timeoutMs: 4000 });
      if (!r.ok) return { ok: false, mode: a && a.mode, state: await read(), reason: r.error };
      if (r.result && r.result.state) last = r.result.state;
      ctx.log(`set ${a && a.mode}: ${r.result && r.result.ok ? 'taken' : 'refused'}${r.result && r.result.reason ? ` (${r.result.reason})` : ''}`);
      return r.result;
    });

    // A power PLAN switch (when the plan is not Balanced the panel offers the plans; Windows applies
    // a mode only on Balanced). Owen's click only: nothing here switches a plan by itself.
    ctx.command('plan', async (a) => {
      if (!ctx.enabled()) return { ok: false, plan: a && a.plan, state: last, reason: 'the power-mode switch is off in Mantle’s tray menu' };
      const r = await ctx.sidecar.send('powermode.plan', { plan: a && a.plan }, { timeoutMs: 6000 });
      if (!r.ok) return { ok: false, plan: a && a.plan, state: await read(), reason: r.error };
      if (r.result && r.result.state) last = r.result.state;
      const name = (r.result && r.result.state && r.result.state.plan && r.result.state.plan.name) || (a && a.plan);
      ctx.log(`plan ${a && a.plan}: ${r.result && r.result.ok ? `taken (now "${name}")` : 'refused'}${r.result && r.result.reason ? ` (${r.result.reason})` : ''}`);
      return r.result;
    });

    ctx.sidecar.on('powermode', (ev) => {
      const s = Object.assign({}, ev);
      delete s.ev;
      last = s;
      ctx.broadcast('powermode', s);
    });
    ctx.sidecar.onReady(async () => {
      const w = await ctx.sidecar.send('powermode.watch', { on: true }, { timeoutMs: 4000 });
      if (!w.ok) { ctx.health(false, `power-mode changes are not watched: ${w.error}`); return; }
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
