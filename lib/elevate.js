'use strict';
/*
 * elevate.js - the main-process half of the elevation broker (sidecar/Elevate.cs, sidecar/ELEVATE.md).
 *
 *   const elevate = require('./elevate');
 *   const r = await elevate(ctx.sidecar, 'system.renamePc', { name: 'OWEN-PC' }, { why: 'settings.system' });
 *   // { ok: true, result, kind: 'ok' }  or  { ok: false, reason: 'plain words', kind }
 *
 * Also callable as elevate(action, args, { sidecar, why | via, owner, log, test }), which is the
 * shape Mantle Settings uses for env.elevate. Without a sidecar in either place it uses the one
 * given to elevate.use(sidecar), and says so in plain words if there is none.
 *
 * `sidecar` is a feature's ctx.sidecar (send -> {ok, result|error}, never rejects) or the raw
 * Sidecar from lib/sidecar.js (call -> result, rejects). Both push the `elevate` event.
 *
 * NEVER throws. Logs the action name, who asked and the outcome kind; NEVER the args or the
 * reason (a reason can quote an arg: a PC name, a DNS server).
 *
 * kind: ok | cancelled (Owen said no: not an error) | timeout | refused (a validator or safety
 * check) | failed (Windows said no) | busy (another prompt is open) | error (the sidecar could
 * not be asked).
 */

const ACTION_RX = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const RUN_TIMEOUT_MS = 8000;      // elevate.run itself answers at once; this is only its reply
const MARGIN_MS = 5000;           // on top of the sidecar's own timeout, before we stop waiting

let bound = null;                 // { sidecar, log } from use()

function use(sidecar, opts) {
  bound = sidecar ? { sidecar, log: opts && typeof opts.log === 'function' ? opts.log : null } : null;
}

function fail(kind, reason) { return { ok: false, kind, reason }; }

function words(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/** One request, one shape back: { ok, result } or { ok:false, error }. Never rejects. */
async function send(sidecar, cmd, args, timeoutMs) {
  try {
    if (typeof sidecar.send === 'function') {
      const r = await sidecar.send(cmd, args, { timeoutMs });
      return r && typeof r === 'object' ? r : { ok: false, error: `the sidecar gave no answer to ${cmd}` };
    }
    return { ok: true, result: await sidecar.call(cmd, args, timeoutMs) };
  } catch (e) {
    return { ok: false, error: words(e) };
  }
}

/** Subscribe to `ev`; returns an unsubscribe that works for ctx.sidecar and an EventEmitter. */
function listen(sidecar, ev, fn) {
  try {
    const off = sidecar.on(ev, fn);
    if (typeof off === 'function') return off;
    return () => { try { sidecar.removeListener(ev, fn); } catch (_) { /* gone already */ } };
  } catch (e) {
    return null;
  }
}

/** A BrowserWindow, an HWND string or a number -> the decimal HWND string the sidecar wants. */
function ownerHwnd(owner) {
  if (owner === undefined || owner === null) return undefined;
  if (typeof owner === 'string' && /^\d+$/.test(owner)) return owner;
  if (typeof owner === 'number' && Number.isSafeInteger(owner) && owner > 0) return String(owner);
  if (owner && typeof owner.getNativeWindowHandle === 'function') {
    try {
      if (typeof owner.isDestroyed === 'function' && owner.isDestroyed()) return undefined;
      const b = owner.getNativeWindowHandle();
      return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
    } catch (_) { return undefined; }
  }
  return undefined;
}

/** Plain words from the sidecar's refusal of elevate.run -> the kind it is. */
function kindOfRunError(text) {
  if (/already open/.test(text)) return 'busy';
  if (/^cannot run|did not answer|not running|is not ready|has exited|sidecar/i.test(text)) return 'error';
  return 'refused';
}

function fromOutcome(o) {
  if (o && o.ok === true) return { ok: true, kind: 'ok', result: o.result === undefined ? {} : o.result };
  return fail(o && typeof o.kind === 'string' ? o.kind : 'failed',
              o && typeof o.reason === 'string' && o.reason ? o.reason : 'the administrator step said no without saying why');
}

async function elevate(a, b, c, d) {
  // Two shapes: (sidecar, action, args, opts) and (action, args, opts).
  let sidecar, action, args, opts;
  if (typeof a === 'string') { action = a; args = b; opts = c || {}; sidecar = opts.sidecar; }
  else { sidecar = a; action = b; args = c; opts = d || {}; }
  if (!sidecar && bound) sidecar = bound.sidecar;
  const logFn = typeof opts.log === 'function' ? opts.log : bound && bound.log ? bound.log : (t) => console.log(`mantle: ${t}`);
  const log = (t) => { try { logFn(t); } catch (_) { /* a broken logger never breaks the call */ } };
  const why = String(opts.why || opts.via || 'unnamed caller').slice(0, 80);

  if (typeof action !== 'string' || !ACTION_RX.test(action)) {
    return fail('refused', `"${String(action).slice(0, 60)}" is not an administrator action name (area.action)`);
  }
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return fail('refused', `${action}: its args must be an object`);
  if (!sidecar || (typeof sidecar.send !== 'function' && typeof sidecar.call !== 'function')) {
    log(`elevate: ${action} (asked by ${why}) -> error: no sidecar`);
    return fail('error', 'Mantle cannot ask for administrator rights: its administrator helper was given no sidecar to ask');
  }

  // Listen BEFORE asking: a quick "no" can arrive before elevate.run's own reply.
  const seen = new Map();
  let waiter = null;
  const off = listen(sidecar, 'elevate', (msg) => {
    if (!msg || typeof msg.ticket !== 'number') return;
    if (waiter && waiter.ticket === msg.ticket) waiter.done(msg);
    else seen.set(msg.ticket, msg);
  });
  if (!off) return fail('error', 'Mantle cannot ask for administrator rights: the sidecar does not deliver events');

  try {
    log(`elevate: ${action} asked by ${why}`);
    const req = { action, args };
    const hwnd = ownerHwnd(opts.owner);
    if (hwnd) req.owner = hwnd;
    const run = await send(sidecar, 'elevate.run', req, RUN_TIMEOUT_MS);
    if (!run.ok) {
      const text = words(run.error);
      const kind = kindOfRunError(text);
      log(`elevate: ${action} -> ${kind}`);
      return fail(kind, text);
    }
    const ticket = run.result && run.result.ticket;
    if (typeof ticket !== 'number') {
      log(`elevate: ${action} -> error: no ticket`);
      return fail('error', 'the sidecar started the administrator step but gave no ticket to wait on');
    }
    const margin = Number.isFinite(opts.marginMs) && opts.marginMs >= 0 ? opts.marginMs : MARGIN_MS;   // tests only
    const limit = (Number(run.result.timeoutMs) || 90000) + margin;

    const outcome = seen.has(ticket) ? seen.get(ticket) : await new Promise((resolve) => {
      // Not unref'd: a caller is awaiting this, and it is bounded (~95 s).
      const timer = setTimeout(() => { waiter = null; resolve(null); }, limit);
      waiter = { ticket, done: (msg) => { clearTimeout(timer); waiter = null; resolve(msg); } };
    });

    let r;
    if (outcome) r = fromOutcome(outcome);
    else {
      // No event: ask once, in case it was lost (a reload), before saying we do not know.
      const st = await send(sidecar, 'elevate.status', { ticket }, RUN_TIMEOUT_MS);
      if (st.ok && st.result && st.result.state === 'done') r = fromOutcome(st.result);
      else r = fail('timeout', `Mantle stopped waiting for the administrator step after ${Math.round(limit / 1000)} s` +
                    (st.ok ? '' : ` (${words(st.error)})`) + `; check whether ${action} happened before trying again`);
    }
    log(`elevate: ${action} (ticket ${ticket}) -> ${r.kind}`);
    return r;
  } catch (e) {
    log(`elevate: ${action} -> error`);
    return fail('error', `the administrator request did not go through (${words(e)})`);
  } finally {
    off();
  }
}

module.exports = elevate;
module.exports.elevate = elevate;
module.exports.use = use;
module.exports._ownerHwnd = ownerHwnd;
module.exports._kindOfRunError = kindOfRunError;
