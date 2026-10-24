'use strict';
/* maxfold.js - a quick unfold when any app window maximizes or restores (lane unfold-max, 2026-10-23).
 *
 * The animation itself is the sidecar's (sidecar/MaxFold.cs): it watches windows, draws DWM
 * thumbnails of the live window into a click-through overlay and plays the iPhone Duo's unfold over
 * ~0.24 s (scratch/SPEC.md "Sidecar", scratch/SPEC-LOOK.md). This file only:
 *   - reads the motion numbers from ui/shared/unfold.css + glass-light.css (lib/features/_maxfold-tokens.js,
 *     every fallback said once in the log) and sends them as maxfold.config {on, ...} when the sidecar is
 *     up (again after every sidecar restart) and on each flip of the switch;
 *   - turns it off (maxfold.config {on:false}) on the switch, stop() and a game rest: the sidecar then
 *     unhooks, hides its overlay, gives back the one window attribute it changes and ends its thread;
 *   - keeps the sidecar's 'maxfold' events as counts, logs a finished play as one line of numbers and a
 *     skip reason at most once a minute per reason. NEVER a window name, title, app or path: only the
 *     fields named below are read from an event, and a reason is logged only if it is one of the
 *     sidecar's own phrases;
 *   - answers maxfold.state (the sidecar's state + the tokens + the counts).
 * In --test the overlay is invisible (invisible:true; a passive sidecar animates only its own test windows).
 */
const fs = require('fs');
const path = require('path');
const T = require('./_maxfold-tokens');

const OLD = 'the sidecar is older than this feature (rebuild it)';
const SAY_EVERY_MS = 60 * 1000;

// The sidecar's skip reasons (scratch/SPEC.md "Decide"). Anything else is logged as "another reason":
// a reason is free text from another process, and a window name must never reach mantle.log.
const REASONS = [
  'switched off',
  'a test run only animates its own test windows',
  "one of Mantle's own windows",
  'a full-screen app or game is running',
  'the window is full screen',
  'a tool window',
  'the window is being dragged',
  'too small to animate',
  'the window is hidden or on another desktop',
  'the app hides itself from screen capture',
  'Windows animates this restore itself',
  'Windows animates this one',
  'the window changed before the unfold could start',
];
const HEX_REASON = /^Windows would not let Mantle draw the window \(0x[0-9A-Fa-f]{1,8}\)$/;

/** A skip reason as it may be logged: one of the known phrases, else "another reason". */
function cleanReason(r) {
  const s = typeof r === 'string' ? r.trim() : '';
  if (REASONS.indexOf(s) >= 0 || HEX_REASON.test(s)) return s;
  return 'another reason';
}

const ACTIONS = ['maximize', 'restore'];
function cleanAction(a) { return ACTIONS.indexOf(a) >= 0 ? a : 'a change'; }

function num(v, digits) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '?';
  const f = Math.pow(10, digits == null ? 1 : digits);
  return String(Math.round(n * f) / f);
}

/** A finished play -> one line of numbers. Only these fields are read. */
function doneLine(ev) {
  const e = ev || {};
  return `done: ${cleanAction(e.action)}, first frame ${num(e.firstFrameMs)} ms, ${num(e.frames, 0)} frames,` +
    ` worst gap ${num(e.gapMaxMs)} ms, missed ${num(e.missedDelta, 0)}${e.cancelled ? ', cancelled' : ''}${e.endedSharp === false ? ', did not end sharp' : ''}`;
}

function isOld(err) {
  return /unknown command|unknown cmd|no such command/i.test(String(err || ''));
}

// Fallback lines are said once per process (an install after a game rest does not repeat them).
const said = new Set();

function readCss(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), error: null }; } catch (e) { return { text: '', error: e.code || 'unreadable' }; }
}

module.exports = {
  name: 'maxfold',
  label: 'Unfold when windows maximize',
  defaultOn: true,
  chords: [],
  observe: [],
  rest: true,
  install(ctx) {
    const shared = path.join(path.dirname(path.dirname(ctx.page('index.html'))), 'shared');
    const uf = readCss(path.join(shared, 'unfold.css'));
    const gl = readCss(path.join(shared, 'glass-light.css'));
    const tokens = T.readTokens(uf.text, gl.text);
    const notes = [];
    if (uf.error) notes.push(`ui/shared/unfold.css could not be read (${uf.error})`);
    if (gl.error) notes.push(`ui/shared/glass-light.css could not be read (${gl.error})`);
    for (const line of notes.concat(tokens.fallbacks)) {
      if (said.has(line)) continue;
      said.add(line);
      ctx.log(`fallback: ${line}`);
    }

    const test = !!(ctx.flags && ctx.flags.test);
    const counts = { plays: 0, done: 0, cancelled: 0, skips: {}, restoredStale: 0 };
    const lastSaid = new Map(); // reason -> { at, held }
    let stopped = false;
    let seq = 0;
    let last = null;      // the last config answer
    let lastError = null; // the last config failure, logged once per distinct text

    async function apply(why) {
      const want = !stopped && ctx.enabled();
      const my = ++seq;
      const r = await ctx.sidecar.send('maxfold.config', T.buildConfig(tokens, { on: want, test }), { timeoutMs: want ? 4000 : 2000 });
      if (my !== seq) return r; // a newer apply went after this one
      if (!r.ok) {
        const old = isOld(r.error);
        const text = old ? OLD : `the sidecar did not take the settings (${r.error})`;
        if (text !== lastError) { lastError = text; ctx.log(`config ${want ? 'on' : 'off'} (${why}) failed: ${old ? OLD : r.error}`); }
        if (stopped) return r; // nothing to say on the strip once stopped
        if (old || want) ctx.health(false, text);
        else ctx.health(true);
        return r;
      }
      lastError = null;
      const res = r.result || {};
      last = res;
      if (!stopped) {
        // Not armed is a failure only when it should be on (off + not armed is the point).
        if (want && res.armed === false) ctx.health(false, typeof res.why === 'string' && res.why ? res.why : 'the sidecar did not switch it on');
        else ctx.health(true);
      }
      ctx.log(`config ${want ? 'on' : 'off'} (${why}): armed=${res.armed} hooked=${res.hooked} winAnim=${res.winAnim}` +
        ` reduced=${res.reduced} passive=${res.passive}${want && res.armed === false && res.why ? ` why: ${res.why}` : ''}`);
      return r;
    }

    function onSkip(ev) {
      const reason = cleanReason(ev.reason);
      counts.skips[reason] = (counts.skips[reason] || 0) + 1;
      const now = module.exports._now();
      const s = lastSaid.get(reason);
      if (s && now - s.at < SAY_EVERY_MS) { s.held++; return; }
      const more = s && s.held ? ` (and ${s.held} more since the last line)` : '';
      lastSaid.set(reason, { at: now, held: 0 });
      ctx.log(`skip: ${cleanAction(ev.action)}, ${reason}${more}`);
    }

    ctx.sidecar.on('maxfold', (ev) => {
      const e = ev || {};
      if (e.kind === 'play') counts.plays++;
      else if (e.kind === 'skip') onSkip(e);
      else if (e.kind === 'done') {
        counts.done++;
        if (e.cancelled) counts.cancelled++;
        ctx.log(doneLine(e));
      } else if (e.kind === 'restored-stale') {
        counts.restoredStale++;
        ctx.log('put back the window animation Mantle had switched off before it stopped unexpectedly');
      }
    });

    ctx.command('state', async () => {
      const r = await ctx.sidecar.send('maxfold.state', {}, { timeoutMs: 3000 });
      return {
        ok: r.ok,
        reason: r.ok ? null : (isOld(r.error) ? OLD : r.error),
        on: ctx.enabled(),
        sidecar: r.ok ? r.result : null,
        config: last,
        tokens: { ms: tokens.ms, curveFrom: tokens.curveFrom, curvePoints: tokens.curve.length, tint: tokens.tint, tintFrom: tokens.tintFrom,
          blurFrac: tokens.blurFrac, blurFrom: tokens.blurFrom, fallbacks: tokens.fallbacks.slice() },
        counts: JSON.parse(JSON.stringify(counts)),
      };
    });

    ctx.sidecar.onReady(() => apply('sidecar ready'));
    ctx.onEnabled((on) => apply(on ? 'switched on' : 'switched off'));

    // the end-to-end selftest (lib/features/maxfold.e2e.test.js), --test only, never in a live run
    let selftest = null;
    if (test && process.env.MANTLE_MAXFOLD_SELFTEST === '1') {
      selftest = require('./_maxfold-selftest.js');
      selftest.start({ ctx, apply, counts });
    }

    return {
      stop(why, how) {
        stopped = true;
        if (selftest) selftest.stop();
        return apply(how && how.rest ? 'resting' : 'stopped');
      },
    };
  },
  // test seams (pure)
  _now: () => Date.now(),
  _cleanReason: cleanReason,
  _doneLine: doneLine,
  _resetSaid: () => said.clear(),
};
