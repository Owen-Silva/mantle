'use strict';
/**
 * lib/surface-gate.js - one pop-up's open/close requests as ONE state machine, and the keyboard
 * it must hold while it is up (lane mn-launch, 2026-10-12; audit #5, #7, #14).
 *
 * WHY (audit #14): the launcher's first show waits for a backdrop frame and the clipboard panel
 * waits for clip.arm + clip.list (up to ~1.1 s). A close during that gap was dropped (hide returned
 * early on "not visible"), so the pop-up appeared after you dismissed it; a second Win+V during it
 * started a second open instead of closing. Here every request bumps a sequence number and the
 * pending show checks it before it shows: the LAST intent wins, like Spotlight / Raycast.
 *
 * WHY (audit #7): show() + focus() is refused when Mantle is not the foreground app, and a panel
 * that never got focus can never lose it, so close-on-blur never fires and the keys go to the app
 * behind. ensureKeyboard() checks, retries once through the sidecar's focus ladder, and says in
 * plain words when it still could not; watchOutside() then closes it on a click outside or Esc.
 *
 *   createGate({prepare, reveal, conceal, isShown, log, now})
 *     .open(from)    -> Promise<{opened, reason}>   (a second open while opening joins the first)
 *     .close(why)    -> {closed, was}               (cancels a pending open too)
 *     .toggle(from)  -> Promise<{opened|closed,...}> (opening or shown -> close; hidden -> open)
 *     .state         'hidden' | 'opening' | 'shown'
 * Nothing here throws to the caller: prepare's failure still shows (it only lost its nicety).
 */

/** A toggle this soon after watchOutside closed the pop-up is the same click (the Start button). */
const SAME_CLICK_MS = 600;

function createGate(o) {
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const isShown = o.isShown || (() => false);
  let state = 'hidden';
  let seq = 0;
  let pending = null;          // the open in flight: {seq, promise}
  let lastClose = { why: null, at: 0 };

  // The window can be hidden or remade behind the gate's back (a page reload, resting for a game).
  function current() {
    if (state === 'shown' && !isShown()) state = 'hidden';
    return state;
  }

  function open(from) {
    const s = current();
    if (s === 'opening' && pending) return pending.promise;
    if (s === 'shown') {
      try { o.reveal({ again: true, from }); } catch (err) { log(`could not bring it forward again (${err.message})`); }
      return Promise.resolve({ opened: true, again: true });
    }
    const my = ++seq;
    state = 'opening';
    const alive = () => seq === my;
    const promise = (async () => {
      try { if (o.prepare) await o.prepare({ alive, from }); }
      catch (err) { log(`opening went on without its first step (${err && err.message})`); }
      if (!alive()) return { opened: false, reason: 'it was closed before it finished opening' };
      state = 'shown';
      try { o.reveal({ again: false, from }); }
      catch (err) { state = 'hidden'; return { opened: false, reason: `it could not be shown (${err.message})` }; }
      return { opened: true };
    })().finally(() => { if (pending && pending.seq === my) pending = null; });
    pending = { seq: my, promise };
    return promise;
  }

  function close(why) {
    const was = current();
    seq++;                     // a pending open sees this and does not show
    pending = null;
    state = 'hidden';
    lastClose = { why: why || null, at: now() };
    if (was === 'shown' || isShown()) {
      try { o.conceal(why); } catch (err) { log(`could not hide it (${err.message})`); }
    }
    return { closed: was !== 'hidden', was };
  }

  function toggle(from) {
    const s = current();
    if (s !== 'hidden') return Promise.resolve(close('toggle'));
    // The click that watchOutside already treated as "outside" is the Start button's own click:
    // it has closed the pop-up, so it must not open it again a moment later.
    if (lastClose.why === 'outside' && now() - lastClose.at < SAME_CLICK_MS) {
      lastClose = { why: null, at: 0 };
      return Promise.resolve({ closed: true, was: 'shown', reason: 'the same click closed it' });
    }
    return open(from);
  }

  return {
    open, close, toggle,
    get state() { return current(); },
    get seq() { return seq; },
  };
}

/**
 * After a show: does the window have the keyboard? If not, ONE retry through `retry()` (the
 * foreground right + the sidecar's 'focus' ladder), then a verdict:
 *   onResult({ok: true, how: 'direct'|'retry'}) or onResult({ok: false, reason})
 * `alive()` false (closed meanwhile) ends it silently. Timers are injectable for tests.
 */
function ensureKeyboard(o) {
  const st = o.setTimeout || setTimeout;
  const wait = (ms) => new Promise((r) => { const t = st(r, ms); if (t && t.unref) t.unref(); });
  return (async () => {
    await wait(o.firstMs == null ? 80 : o.firstMs);
    if (!o.alive()) return null;
    if (o.isFocused()) { const r = { ok: true, how: 'direct' }; o.onResult(r); return r; }
    let why = null;
    try { await o.retry(); } catch (err) { why = (err && err.message) || String(err); }
    await wait(o.settleMs == null ? 120 : o.settleMs);
    if (!o.alive()) return null;
    if (o.isFocused()) { const r = { ok: true, how: 'retry' }; o.onResult(r); return r; }
    const r = { ok: false, reason: why || 'Windows kept the keyboard on the app in front' };
    o.onResult(r);
    return r;
  })();
}

/* ---- the outside-click / Esc watch for a pop-up that has no keyboard ---------------------- */

let keys;            // undefined = not tried; null = could not bind
let keysWhy = null;
function nativeKeys() {
  if (keys !== undefined) return keys;
  keys = null;
  if (process.platform !== 'win32') { keysWhy = 'this is not Windows'; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const get = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    keys = { down: (vk) => (get(vk) & 0x8000) !== 0 };
  } catch (err) {
    keysWhy = `koffi could not bind user32.dll (${String(err && err.message).split('\n')[0]})`;
  }
  return keys;
}

const VK = { LBUTTON: 0x01, RBUTTON: 0x02, MBUTTON: 0x04, ESCAPE: 0x1B };

/**
 * While a pop-up is shown WITHOUT the keyboard, nothing tells Mantle about a click elsewhere or
 * Esc (they go to the app in front). Poll the button and Esc state (GetAsyncKeyState, ~20 a second)
 * and call onOutside('outside' | 'esc') on a fresh press: a button going down with the cursor
 * outside bounds(), or Esc going down. A press inside the pop-up gives it the keyboard; the caller
 * stops the watch on its 'focus' event.
 *   watchOutside({bounds() -> {x,y,width,height}, cursor() -> {x,y}, onOutside, keys?, every?})
 *     -> {stop(), ok, reason}   ok false (no binding) = nothing is watched, reason says why.
 */
function watchOutside(o) {
  const k = o.keys !== undefined ? o.keys : nativeKeys();   // keys: null = none (a test)
  if (!k) return { stop() {}, ok: false, reason: (o.keys === undefined && keysWhy) || 'there is no key-state binding' };
  const watched = [VK.LBUTTON, VK.RBUTTON, VK.MBUTTON, VK.ESCAPE];
  const prev = new Map(watched.map((vk) => [vk, safeDown(k, vk)]));   // a press already held is not new
  const si = o.setInterval || setInterval;
  const ci = o.clearInterval || clearInterval;
  let t = null;
  const stop = () => { if (t) { ci(t); t = null; } };
  const tick = () => {
    for (const vk of watched) {
      const d = safeDown(k, vk);
      const fresh = d && !prev.get(vk);
      prev.set(vk, d);
      if (!fresh) continue;
      if (vk === VK.ESCAPE) { stop(); o.onOutside('esc'); return; }
      const b = o.bounds();
      const c = o.cursor();
      const inside = b && c && c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      if (!inside) { stop(); o.onOutside('outside'); return; }
    }
  };
  t = si(tick, o.every || 50);
  if (t && t.unref) t.unref();
  return { stop, ok: true, reason: null, tick };
}
function safeDown(k, vk) { try { return !!k.down(vk); } catch (_) { return false; } }

/** The sentence a pop-up shows when it could not take the keyboard. Plain words, no codes. */
function noKeyboardWords(reason, watching) {
  const why = String(reason || 'Windows kept the keyboard on the app in front').replace(/[.\s]+$/, '');
  return watching
    ? `No keyboard: ${why}. Click here to type; click outside or press Esc to close.`
    : `No keyboard: ${why}. Click here to type, or click here and press Esc to close.`;
}

module.exports = { createGate, ensureKeyboard, watchOutside, noKeyboardWords, SAME_CLICK_MS, VK };
