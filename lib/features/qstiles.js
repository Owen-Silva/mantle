'use strict';
/*
 * lib/features/qstiles.js - quick settings' new tiles: Do not disturb, Airplane mode and Focus (lane
 * qstiles, 2026-10-15; plan notes/mantle-replace-windows.md P8). Project and Cast are
 * lib/features/project.js's (Win+P's pop-up and Windows' Cast panel); the words are _qstiles-core.js.
 *
 * REUSED SETTERS, NOT NEW ONES: Do not disturb is Mantle Settings > Notifications' sysnotify.dnd
 * (the shell's quiet-hours profile, read back after the write); Airplane mode is Mantle Settings >
 * Network's netair.set (Windows' radio management, read back). Mobile hotspot is NOT a tile: Mantle
 * Settings has no hotspot switch yet (its page says so: the tethering API is not wired), so a tile
 * would be a lie or a link; Windows' own quick settings still has it.
 *
 * FOCUS = Mantle's timer + Do not disturb (Windows' Focus is its Clock timer + Do not disturb): a
 * click starts a 30 min "Focus" timer (lib/features/timer.js through _tools-hub.js) and turns Do not
 * disturb on if it was off. When that timer ends, is cancelled, or Focus is clicked again, Do not
 * disturb goes back to what it was. The record is written BEFORE Do not disturb is touched (R10), so
 * a restart mid-focus still puts it back; a quit puts it back too.
 *
 * NOTHING WAITS ON THE PANEL (R3, P8's budget): the bar holds the last state (qstiles.state is
 * replayed on subscribe and pushed on every change), paints from it, then asks qstiles.refresh after
 * the paint. The reads are three small calls on the qs/notif lanes, never the ui lane.
 * --test: every switch is a dry run; the state is never changed by a test.
 */
const C = require('./_qstiles-core');
const hub = require('./_tools-hub');

const FOCUS_LABEL = 'Focus';

function words(e) { return String((e && e.message) || e || 'no reason given').split('\n')[0]; }
function plainErr(e) {
  const m = words(e);
  return (/sidecar|ipc|timed? ?out|undefined|\bnull\b|passive/i.test(m) || /\bE[A-Z]{3,}\b/.test(m)) ? 'Mantle\'s helper did not answer. Try again in a moment' : m;
}

module.exports = {
  name: 'qstiles',
  label: 'Quick settings tiles (Do not disturb, Airplane mode, Focus)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) {
    const test = !!ctx.flags.test;
    let stopped = false, reading = null;
    let dnd = null, airplane = null, readAt = 0, readError = null;
    let focus = clean(ctx.settings.get('focus', null));
    const busy = new Set();

    function clean(f) {
      if (!f || typeof f !== 'object' || typeof f.endAt !== 'number') return null;
      return { on: true, endAt: f.endAt, minutes: f.minutes || C.FOCUS_MIN, dndByFocus: !!f.dndByFocus, startedAt: f.startedAt || null };
    }
    function save() {
      try { ctx.settings.set('focus', focus); } catch (e) { ctx.log(`the focus record could not be saved (${words(e)})`); }
    }
    function timerOk() {
      if (!hub.timer) return { ok: false, reason: 'Mantle\'s timer is not running (switched off in the tray, or still starting)' };
      return { ok: true, reason: null };
    }
    function state() {
      return { on: ctx.enabled(), dnd, airplane, focus, timer: timerOk(), readAt, readError, busy: Array.from(busy), test };
    }
    const emit = () => { if (!stopped) ctx.broadcast('qstiles.state', state()); };
    ctx.replay('qstiles.state', state);

    const send = (cmd, args, ms) => ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 4000 });

    /** The three reads, at once, never on an open path. One round at a time. */
    function read(why) {
      if (stopped) return Promise.resolve();
      if (reading) return reading;
      if (!ctx.sidecar.ready) { readError = 'Mantle\'s helper is starting'; emit(); return Promise.resolve(); }
      const t0 = Date.now();
      reading = Promise.all([send('sysnotify.dndGet'), send('netair.get', {}, 8000), send('toasts.quiet', {}, 2000)]).then(([d, a, q]) => {
        reading = null;
        if (stopped) return;
        const errs = [];
        if (d.ok && d.result) {
          const x = d.result;
          const active = q.ok && q.result && (q.result.dnd === 1 || q.result.dnd === 2);
          dnd = { ok: x.ok !== false, on: x.on == null ? null : !!x.on, writable: x.writable !== false, reason: x.reason || null,
                  rule: !x.on && active ? (q.result.dnd === 2 ? 'alarms only' : 'priority only') : null };
        } else { dnd = { ok: false, on: null, writable: false, reason: plainErr(d.error) }; errs.push('Do not disturb: ' + words(d.error)); }
        if (a.ok && a.result) {
          const x = a.result;
          airplane = { ok: x.ok !== false, on: x.airplane == null ? null : !!x.airplane, canSet: !!x.canSet, reason: x.reason || null };
        } else { airplane = { ok: false, on: null, canSet: false, reason: plainErr(a.error) }; errs.push('airplane mode: ' + words(a.error)); }
        readAt = Date.now(); readError = errs.length ? errs.join('; ') : null;
        if (errs.length) ctx.log(`read (${why}) in ${readAt - t0} ms with problems: ${readError}`);
        emit();
      }, (e) => { reading = null; readError = words(e); emit(); });
      return reading;
    }

    async function setDnd(on, why) {
      const r = await send('sysnotify.dnd', { on: !!on, dryRun: test }, 6000);
      if (!r.ok) return { ok: false, reason: `Do not disturb did not change: ${plainErr(r.error)}` };
      if (r.result && r.result.dryRun) return { ok: true, dryRun: true, reason: `test run: would turn Do not disturb ${on ? 'on' : 'off'} (${why})` };
      dnd = Object.assign({}, dnd || { ok: true, writable: true }, { on: !!r.result.on, rule: null });
      ctx.log(`Do not disturb ${on ? 'on' : 'off'} (${why})`);
      return { ok: true };
    }

    async function setAirplane(on) {
      const r = await send('netair.set', { on: !!on, dryRun: test }, 8000);
      if (!r.ok) return { ok: false, reason: `Airplane mode did not change: ${plainErr(r.error)}` };
      if (r.result && r.result.dryRun) return { ok: true, dryRun: true, reason: `test run: would ${r.result.would || `turn airplane mode ${on ? 'on' : 'off'}`}` };
      airplane = Object.assign({}, airplane || { ok: true, canSet: true }, { on: r.result.now == null ? !!on : !!r.result.now });
      ctx.log(`airplane mode ${airplane.on ? 'on' : 'off'}`);
      return { ok: airplane.on === !!on, reason: airplane.on === !!on ? null : 'Windows still reports airplane mode ' + (airplane.on ? 'on' : 'off') };
    }

    function focusTimerRunning() {
      const v = hub.timer && hub.timer.view();
      return !!(v && v.kind === 'timer' && v.label === FOCUS_LABEL);
    }

    async function startFocus(minutes) {
      const t = timerOk();
      if (!t.ok) return { ok: false, reason: `Focus did not start: ${t.reason}` };
      const ms = Math.round(minutes * 60000);
      const dndWasOn = !!(dnd && dnd.on);
      const canQuiet = !!(dnd && dnd.ok !== false && dnd.writable !== false);
      if (test) return { ok: true, dryRun: true, reason: `test run: would start a ${minutes} min Focus timer${!dndWasOn && canQuiet ? ' and turn Do not disturb on' : ''}` };
      const r = await hub.timer.start(ms, FOCUS_LABEL);
      if (r && r.ok === false) return { ok: false, reason: `Focus did not start: ${r.reason || 'the timer refused'}` };
      // the record first (R10): a crash after the switch still finds what to put back
      focus = { on: true, endAt: Date.now() + ms, minutes, dndByFocus: !dndWasOn && canQuiet, startedAt: Date.now() };
      save();
      let note = null;
      if (focus.dndByFocus) {
        const d = await setDnd(true, 'Focus started');
        if (!d.ok) { focus.dndByFocus = false; save(); note = `${d.reason}; Focus runs without it`; }
      } else if (!canQuiet) note = `Do not disturb could not be switched (${(dnd && dnd.reason) || 'not read yet'}); Focus runs without it`;
      ctx.log(`Focus started: ${minutes} min${focus.dndByFocus ? ', Do not disturb on' : ''}`);
      return { ok: true, reason: note };
    }

    async function endFocus(why, cancelTimer) {
      const f = focus;
      if (!f) return { ok: true };
      focus = null; save();
      if (cancelTimer && focusTimerRunning() && hub.timer) { try { await hub.timer.cancel(); } catch (e) { ctx.log(`the Focus timer did not cancel (${words(e)})`); } }
      let note = null;
      if (f.dndByFocus) {
        const d = test ? { ok: true } : await setDnd(false, `Focus ended: ${why}`);
        if (!d.ok) note = `${d.reason}. Turn Do not disturb off from its tile`;
      }
      ctx.log(`Focus ended (${why})${f.dndByFocus ? '; Do not disturb put back off' : ''}`);
      return { ok: true, reason: note };
    }

    /* ---- the timer says when Focus is over (ended, cancelled from the top bar, replaced) ---- */
    const untimer = hub.onTimer(() => {
      if (stopped || !focus || focusTimerRunning()) return;
      endFocus('its timer is no longer running', false).then(emit, emit);
    });
    // A restart mid-focus: the timer comes back from its own file; if it did not, put Do not disturb back.
    const settleT = setTimeout(() => {
      if (stopped || !focus || focusTimerRunning()) return;
      endFocus('its timer did not come back after Mantle restarted', false).then(emit, emit);
    }, test ? 200 : 8000);
    if (settleT.unref) settleT.unref();

    /* ---- commands (the bar's tiles) ---- */
    ctx.command('state', async () => state());
    ctx.command('refresh', async () => { await read('the panel opened'); return state(); });
    ctx.command('set', async (a) => {
      const tile = a && typeof a.tile === 'string' ? a.tile : '';
      const on = !!(a && a.on);
      if (!ctx.enabled()) return { ok: false, reason: 'These tiles are switched off in Mantle\'s tray menu', state: state() };
      if (busy.has(tile)) return { ok: false, reason: 'Still switching: wait a moment', state: state() };
      let r;
      busy.add(tile); emit();
      try {
        if (tile === 'dnd') {
          r = await setDnd(on, 'its tile');
          // turning it off by hand while Focus holds it: Focus keeps its timer but no longer owns Do not disturb
          if (r.ok && !on && focus && focus.dndByFocus) { focus.dndByFocus = false; save(); }
        } else if (tile === 'airplane') r = await setAirplane(on);
        else if (tile === 'focus') r = on ? await startFocus(C.FOCUS_MIN) : await endFocus('its tile', true);
        else r = { ok: false, reason: `There is no "${tile}" tile` };
      } catch (e) { r = { ok: false, reason: plainErr(e) }; }
      busy.delete(tile);
      if (!r.dryRun) read('after a switch');
      emit();
      return Object.assign({ tile }, r, { state: state() });
    });

    ctx.onEnabled(() => emit());
    ctx.sidecar.onReady(() => { const t = setTimeout(() => read('start'), test ? 50 : 3000); if (t.unref) t.unref(); });
    ctx.health(true, 'Quick settings has Do not disturb, Airplane mode and Focus');

    return {
      stop(why) {
        stopped = true;
        clearTimeout(settleT);
        try { untimer(); } catch (_) { /* gone */ }
        // R10: Focus's Do not disturb is put back on the way out; the record stays if that fails
        if (focus && focus.dndByFocus && !test) {
          send('sysnotify.dnd', { on: false }, 2000).then((r) => { if (r.ok) { focus = null; save(); } });
          ctx.log(`stopped (${why || 'no reason'}): putting Do not disturb back off (Focus had it on)`);
        }
      },
      _test: { state, read, setDnd, setAirplane, startFocus, endFocus },
    };
  },
};
