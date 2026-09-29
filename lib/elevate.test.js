'use strict';
/*
 * elevate.test.js - lib/elevate.js against fake sidecars (no exe, no prompt, ~1 s).
 *   node lib/elevate.test.js
 * The real broker round trip through lib/elevate.js is in sidecar/test-elevate.js.
 */
const { EventEmitter } = require('events');
const elevate = require('./elevate');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(detail ? `${name} (${detail})` : name);
}
const show = (x) => JSON.stringify(x).slice(0, 200);

/** A ctx.sidecar-shaped fake: send -> {ok,result|error}; on() returns unsubscribe. */
function ctxFake(script) {
  const em = new EventEmitter();
  const sent = [];
  return {
    sent, em,
    send(cmd, args, o) { sent.push({ cmd, args, o }); return Promise.resolve(script(cmd, args, (m) => em.emit('elevate', m))); },
    on(ev, fn) { em.on(ev, fn); return () => em.removeListener(ev, fn); },
  };
}

(async () => {
  const logs = [];
  const log = (x) => logs.push(x);

  // 1. both call shapes; the event can arrive BEFORE elevate.run's reply
  const early = ctxFake((cmd, args, push) => {
    if (cmd !== 'elevate.run') return { ok: false, error: 'unexpected ' + cmd };
    push({ ev: 'elevate', ticket: 7, ok: true, kind: 'ok', result: { name: args.args.name } });
    return { ok: true, result: { ticket: 7, timeoutMs: 1000 } };
  });
  const a = await elevate(early, 'system.renamePc', { name: 'SECRET-NAME' }, { why: 'unit', log });
  check('shape (sidecar, action, args, opts) + early event', a.ok === true && a.kind === 'ok' && a.result.name === 'SECRET-NAME', show(a));
  const b = await elevate('system.renamePc', { name: 'SECRET-NAME' }, { sidecar: early, via: 'settings.system', test: true, log });
  check('shape (action, args, {sidecar}) as Mantle Settings calls it', b.ok === true && b.result.name === 'SECRET-NAME', show(b));
  check('elevate.run got {action, args} and no reserved key', early.sent[0].args.action === 'system.renamePc' &&
    !('id' in early.sent[0].args) && !('cmd' in early.sent[0].args), show(early.sent[0]));
  check('the listener is removed afterwards', early.em.listenerCount('elevate') === 0, String(early.em.listenerCount('elevate')));
  check('module is callable directly and as .elevate (settings.js accepts either)', typeof elevate === 'function' && elevate.elevate === elevate);

  // 2. no sidecar anywhere -> plain words, kind error
  const none = await elevate('system.renamePc', { name: 'X1' }, { log });
  check('no sidecar: kind error in plain words', none.ok === false && none.kind === 'error' && /given no sidecar/.test(none.reason), show(none));
  elevate.use(early, { log });
  const bound = await elevate('system.renamePc', { name: 'X1' }, {});
  check('use(sidecar) binds the default', bound.ok === true, show(bound));
  elevate.use(null);

  // 3. refusals before anything is sent
  const bad = ctxFake(() => ({ ok: false, error: 'never' }));
  const r1 = await elevate(bad, 'rm -rf', {}, { log });
  const r2 = await elevate(bad, 'system.renamePc', [1], { log });
  check('a bad action name is refused without asking', r1.kind === 'refused' && bad.sent.length === 0, show(r1));
  check('array args are refused without asking', r2.kind === 'refused' && bad.sent.length === 0, show(r2));

  // 4. the sidecar's own refusals -> kinds
  const said = (error) => ctxFake(() => ({ ok: false, error }));
  const busy = await elevate(said('another administrator prompt is already open (to rename this PC); answer that one first'), 'system.renamePc', { name: 'A1' }, { log });
  check('busy', busy.kind === 'busy' && /already open/.test(busy.reason), show(busy));
  const val = await elevate(said('a PC name cannot contain spaces'), 'system.renamePc', { name: 'a b' }, { log });
  check('validator words -> refused, words as given', val.kind === 'refused' && val.reason === 'a PC name cannot contain spaces', show(val));
  const down = await elevate(said('cannot run "elevate.run": the sidecar is not running'), 'system.renamePc', { name: 'A1' }, { log });
  check('sidecar down -> error', down.kind === 'error', show(down));

  // 5. outcomes: cancelled / failed / missing reason
  const outcome = (o) => ctxFake((cmd, args, push) => {
    if (cmd === 'elevate.run') { setTimeout(() => push(Object.assign({ ev: 'elevate', ticket: 3 }, o)), 5); return { ok: true, result: { ticket: 3, timeoutMs: 1000 } }; }
    return { ok: false, error: 'unexpected' };
  });
  const c = await elevate(outcome({ ok: false, kind: 'cancelled', reason: 'you said no to the administrator prompt, so Mantle did not rename this PC' }), 'system.renamePc', { name: 'A1' }, { log });
  check('cancelled passes through with its words', c.ok === false && c.kind === 'cancelled' && /you said no/.test(c.reason), show(c));
  const f = await elevate(outcome({ ok: false, kind: 'failed' }), 'system.renamePc', { name: 'A1' }, { log });
  check('a reasonless failure still gets words', f.kind === 'failed' && /without saying why/.test(f.reason), show(f));
  const other = ctxFake((cmd, args, push) => {
    if (cmd === 'elevate.run') { setTimeout(() => { push({ ev: 'elevate', ticket: 99, ok: true }); push({ ev: 'elevate', ticket: 4, ok: true, kind: 'ok', result: { mine: 1 } }); }, 5); return { ok: true, result: { ticket: 4, timeoutMs: 1000 } }; }
    return { ok: false, error: 'unexpected' };
  });
  const o = await elevate(other, 'system.renamePc', { name: 'A1' }, { log });
  check("another ticket's event is not taken for ours", o.ok && o.result.mine === 1, show(o));

  // 6. no event: elevate.status once, then a timeout in words
  const lost = ctxFake((cmd, args) => cmd === 'elevate.run' ? { ok: true, result: { ticket: 5, timeoutMs: 20 } }
    : { ok: true, result: { ticket: args.ticket, state: 'done', ok: true, kind: 'ok', result: { via: 'status' } } });
  const l = await elevate(lost, 'system.renamePc', { name: 'A1' }, { log, marginMs: 20 });
  check('a lost event is recovered through elevate.status', l.ok && l.result.via === 'status' && lost.sent[1].cmd === 'elevate.status', show(l));
  const gone = ctxFake((cmd) => cmd === 'elevate.run' ? { ok: true, result: { ticket: 6, timeoutMs: 20 } }
    : { ok: false, error: 'no administrator step has ticket 6 (the sidecar may have restarted since), so whether it happened is unknown' });
  const g = await elevate(gone, 'system.renamePc', { name: 'A1' }, { log, marginMs: 20 });
  check('no event and no status: kind timeout, says check first', g.kind === 'timeout' && /check whether system\.renamePc happened/.test(g.reason), show(g));
  const noTicket = await elevate(ctxFake(() => ({ ok: true, result: {} })), 'system.renamePc', { name: 'A1' }, { log });
  check('no ticket -> error in words', noTicket.kind === 'error' && /no ticket/.test(noTicket.reason), show(noTicket));

  // 7. the raw Sidecar shape: call() resolves or rejects, EventEmitter events
  const raw = new EventEmitter();
  raw.call = (cmd) => {
    if (cmd === 'elevate.run') { setTimeout(() => raw.emit('elevate', { ev: 'elevate', ticket: 8, ok: true, kind: 'ok', result: { raw: true } }), 5); return Promise.resolve({ ticket: 8, timeoutMs: 1000 }); }
    return Promise.reject(new Error('unexpected'));
  };
  const rr = await elevate(raw, 'system.renamePc', { name: 'A1' }, { log });
  check('raw Sidecar: call + EventEmitter', rr.ok && rr.result.raw === true && raw.listenerCount('elevate') === 0, show(rr));
  const rawDown = new EventEmitter();
  rawDown.call = () => Promise.reject(new Error('cannot run "elevate.run": the sidecar is not running'));
  const rd = await elevate(rawDown, 'system.renamePc', { name: 'A1' }, { log });
  check('raw Sidecar: a rejection never throws', rd.ok === false && rd.kind === 'error', show(rd));

  // 8. owner -> decimal HWND string
  const H = elevate._ownerHwnd;
  const buf = Buffer.alloc(8); buf.writeBigUInt64LE(0x1a2b3cn, 0);
  check('owner: a BrowserWindow', H({ getNativeWindowHandle: () => buf, isDestroyed: () => false }) === String(0x1a2b3c));
  check('owner: a destroyed window is left out', H({ getNativeWindowHandle: () => buf, isDestroyed: () => true }) === undefined);
  check('owner: a decimal string and a number', H('12345') === '12345' && H(678) === '678' && H('12ab') === undefined && H(null) === undefined);
  const withOwner = ctxFake((cmd, args, push) => { push({ ev: 'elevate', ticket: 9, ok: true, kind: 'ok', result: {} }); return { ok: true, result: { ticket: 9, timeoutMs: 1000 } }; });
  await elevate(withOwner, 'system.renamePc', { name: 'A1' }, { owner: '4242', log });
  check('owner travels as "owner"', withOwner.sent[0].args.owner === '4242', show(withOwner.sent[0].args));

  // 9. logging: action names, never args
  check('logs name actions and never carry args', logs.length > 5 && logs.some((x) => /system\.renamePc/.test(x)) &&
    logs.every((x) => !/SECRET-NAME|a b\b/.test(x)), logs.slice(0, 4).join(' | '));
  const thrower = await elevate(early, 'system.renamePc', { name: 'A1' }, { log: () => { throw new Error('bad logger'); } });
  check('a throwing logger does not break the call', thrower.ok === true, show(thrower));

  console.log(`ELEVATE LIB TEST: ${passed} passed, ${failures.length} failed`);
  for (const x of failures) console.log(`  FAIL ${x}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`ELEVATE LIB TEST: crashed: ${e.stack}`); process.exit(1); });
