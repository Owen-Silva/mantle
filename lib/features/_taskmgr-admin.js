'use strict';
/**
 * _taskmgr-admin.js - THE ONE SEAM every admin-capable task manager operation goes through
 * (lane tm-data, 2026-10-28).
 *
 * WHY: Mantle's sidecar is not elevated, so Windows answers "access denied" for other users'
 * processes, services, Details fields of system processes, startup impact and so on. Owen chose
 * "always admin, no prompt": a separate lane builds an elevated helper (lib/features/_taskmgr-elevated.js,
 * createElevated(ctx).run(op, args)). Until that is plugged in, a denied answer comes back as
 * { ok:false, needsAdmin:true, reason } and the page shows it (never a silent no-op). Once a runner is
 * set with setElevated(), the same call is retried through it, and nothing else in taskmgr.js changes.
 *
 * call(ctx, verb, args, opts) -> { ok, result?, reason?, needsAdmin?, via: 'sidecar'|'elevated' }
 *   verb  the sidecar command ('taskmgr.service', ...)
 *   opts  { timeoutMs, retry: true (default) } - retry:false never goes to the elevated helper
 *         (reads that only need it for a few fields, where the caller decides).
 */

let elevated = null;   // createElevated(ctx): { status() -> {installed, stale, ...}, run(op, args, {timeoutMs}) }

function setElevated(runner) { elevated = runner && typeof runner.run === 'function' ? runner : null; }
/** True when a runner is plugged in AND its helper is set up and current (status() never prompts). */
function hasElevated() {
  if (!elevated) return false;
  if (typeof elevated.status !== 'function') return true;
  try { const s = elevated.status(); return !!(s && s.installed && !s.stale); } catch (_) { return false; }
}

/* What a needsAdmin answer says while the helper is not set up: the page's button has these words. */
const SETUP_HINT = 'Set up administrator access to let Mantle do this (Windows asks once)';
function withHint(reason) {
  const r = String(reason || 'needs administrator');
  return /Set up administrator access/.test(r) ? r : `${r.replace(/[.\s]+$/, '')}. ${SETUP_HINT}.`;
}

const DENIED = /access (is )?denied|needs administrator|error 5\b|ERROR_ACCESS_DENIED/i;

/** True when a sidecar answer (envelope or result) says Windows refused for lack of rights. */
function isDenied(r) {
  if (!r) return false;
  const x = r.result && typeof r.result === 'object' ? r.result : null;
  if (x && x.needsAdmin) return true;
  if (r.needsAdmin) return true;
  const words = (x && (x.reason || x.why)) || r.error || r.reason || '';
  return !r.ok && DENIED.test(String(words));
}

function words(r, fallback) {
  const x = r && r.result && typeof r.result === 'object' ? r.result : null;
  return (x && (x.reason || x.why)) || (r && (r.reason || r.error)) || fallback;
}

/** Normalise any sidecar/elevated answer into the spec's { ok, reason?, needsAdmin? } plus result. */
function shape(r, via) {
  if (!r) return { ok: false, reason: 'no answer', via };
  const x = r.result && typeof r.result === 'object' ? r.result : null;
  const ok = !!r.ok && !(x && x.ok === false);
  const out = { ok, result: x || r.result, via };
  if (!ok) out.reason = words(r, 'it did not work');
  if (isDenied(r)) { out.needsAdmin = true; if (ok === false && !/administrator/i.test(out.reason || '')) out.reason = `needs administrator: ${out.reason}`; }
  if (x && x.dryRun) out.dryRun = true;
  return out;
}

async function call(ctx, verb, args, opts) {
  const o = opts || {};
  let r;
  try { r = await ctx.sidecar.send(verb, args || {}, { timeoutMs: o.timeoutMs || 6000 }); } catch (e) { r = { ok: false, error: e && e.message || String(e) }; }
  const first = shape(r, 'sidecar');
  if (!first.needsAdmin) return first;
  if (!hasElevated()) { if (!first.ok) first.reason = withHint(first.reason); first.setup = true; return first; }
  if (o.retry === false) return first;
  return runElevated(verb, args, o);
}

async function runElevated(verb, args, o) {
  let e;
  try { e = await elevated.run(verb, args || {}, { timeoutMs: (o && o.timeoutMs) || 10000 }); } catch (err) { e = { ok: false, error: `the administrator helper failed (${err && err.message || err})` }; }
  const second = shape(e, 'elevated');
  if (!second.ok && !second.reason) second.reason = 'the administrator helper did not answer';
  return second;
}

/** An elevated-only read (taskmgr.netsample / apphistory / startupimpact / details): the helper or a
    clean { ok:false, needsAdmin, setup, reason naming "Set up administrator access" }. Never prompts. */
async function callElevated(verb, args, opts) {
  if (!hasElevated()) return { ok: false, needsAdmin: true, setup: true, reason: withHint('Windows keeps this for administrators'), via: 'elevated' };
  return runElevated(verb, args, opts || {});
}

module.exports = { call, callElevated, setElevated, hasElevated, isDenied, shape, withHint, SETUP_HINT };
