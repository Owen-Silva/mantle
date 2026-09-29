'use strict';
/*
 * _devices-bridge.js - the one road from a Settings section's main half to the sidecar, for the
 * Bluetooth & devices and Network & internet sections (lane devnet, 2026-09-28).
 *
 * WHY ONE HELPER: every command of those two sections is "ask the sidecar, in plain words back",
 * and every WRITE has the same three rules (ui/settings/SECTIONS.md):
 *   - in a test run (env.test) it is the sidecar's own dryRun, answered { ok:true, dryRun:true, reason }
 *     so the control springs back and shows what WOULD have happened;
 *   - a real write answers { ok:true, value } with the read-back (what Windows says now);
 *   - a failure is { ok:false, reason } in the sidecar's own words, never a bare "failed".
 * Arguments pass through a per-command whitelist (never an `id` key: lib/features/README.md), and
 * nothing here logs a name, SSID, address or path (only command names and lengths).
 */

/** Only the listed keys of `args`, dropping undefined. */
function pick(args, keys) {
  const out = {};
  for (const k of keys || []) if (args && args[k] !== undefined) out[k] = args[k];
  return out;
}

/** The sidecar's answer as a page answer: { ok:true, ...result } or { ok:false, reason }. */
async function send(env, cmd, args, ms) {
  let r;
  try {
    r = await env.sidecar.send(cmd, args || {}, { timeoutMs: ms || 8000 });
  } catch (e) {
    return { ok: false, reason: `${cmd} could not be asked (${e && e.message ? e.message : e})` };
  }
  if (!r) return { ok: false, reason: `${cmd} gave no answer` };
  if (r.ok === false) return { ok: false, reason: r.error || r.reason || `${cmd} failed and gave no reason` };
  const res = r.result && typeof r.result === 'object' ? r.result : { value: r.result };
  if (res.ok === false) return Object.assign({}, res, { ok: false, reason: res.reason || res.error || `${cmd} failed and gave no reason` });
  return Object.assign({}, res, { ok: true });
}

/**
 * A write. `opts.value(result)` picks the read-back (default: result.now); `opts.ms` the timeout.
 * In a test run the sidecar gets dryRun:true and the page gets the test-run shape.
 */
async function write(env, cmd, args, opts) {
  const o = opts || {};
  const dry = !!env.test;
  const r = await send(env, cmd, Object.assign({}, args, { dryRun: dry }), o.ms);
  // A write that needs an administrator answers { needsAdmin, elevate:{action, args} }: that click
  // becomes ONE administrator prompt for exactly that action (sidecar/ELEVATE.md).
  if (!r.ok && !dry && r.needsAdmin && r.elevate && typeof r.elevate.action === 'string') {
    return elevated(env, r.elevate.action, r.elevate.args || {});
  }
  if (!r.ok) return r;
  if (r.dryRun) {
    const would = r.would || r.refusal || 'do it';
    return Object.assign({}, r, { ok: true, dryRun: true, reason: `Test run, nothing changed: Mantle would ${would}` });
  }
  if (dry) return { ok: false, reason: `${cmd} did not answer as a dry run in a test run, so its answer is not trusted` };
  const value = o.value ? o.value(r) : r.now;
  return Object.assign({}, r, value === undefined ? {} : { value });
}

/**
 * An administrator action. In a test run: the non-elevated plan command (`plan`, a dryRun-only
 * sidecar read) answers instead, so no prompt can ever appear from a test.
 */
async function elevated(env, action, args, plan) {
  if (env.test) {
    if (!plan) return { ok: true, dryRun: true, reason: `Test run, nothing changed: Mantle would ask for administrator permission (${action})` };
    // plan.args are sent as given: a plan command is read-only by itself, or they carry dryRun:true.
    const r = await send(env, plan.cmd, plan.args || args, plan.ms);
    if (!r.ok) return r;
    return Object.assign({}, r, { ok: true, dryRun: true, reason: `Test run, nothing changed: Mantle would ${r.would || action}` });
  }
  const r = await env.elevate(action, args);
  if (!r || r.ok !== true) {
    const kind = r && r.kind;
    if (kind === 'cancelled') return { ok: false, cancelled: true, kind, reason: 'You said no to the administrator prompt; nothing changed.' };
    return { ok: false, kind: kind || 'error', reason: (r && r.reason) || `${action} did not answer` };
  }
  return Object.assign({ ok: true, kind: 'ok' }, r.result || {});
}

/** Relays a sidecar event to the open Settings page as settings.<id>.<name>, until stop. */
function relay(env, ev, name) {
  if (!env.sidecar || typeof env.sidecar.on !== 'function') return () => {};
  return env.sidecar.on(ev, (payload) => {
    try { env.push(`settings.${env.id}.${name}`, payload); } catch (_) { /* the window is gone */ }
  });
}

module.exports = { pick, send, write, elevated, relay };
