'use strict';
/* _ontop-core.js - the rules of "Keep on top" (lane ontop, 2026-09-27), with no Electron in it: the
 * sidecar is injected, so lib/features/ontop.test.js proves every rule against a fake Windows.
 * lib/features/ontop.js wires it to ctx; sidecar/WindowTop.cs is the Windows half.
 *
 * THE RULES
 *   - Mantle only ever takes away what Mantle gave. A pin is recorded ONLY when Mantle turned the
 *     window from not-on-top to on-top (sidecar `was:false`, `changed:true`). A window that was
 *     already on top by its own choice (a picture-in-picture, Task Manager's "Always on top") is
 *     refused, in words, and is never un-pinned by Mantle: not by the chord, not at quit.
 *   - Every pin carries its window's pid. A handle whose pid changed is another program's window
 *     now, and is never touched.
 *   - A pinned window that closes, or that something else takes off top, is forgotten (sweep).
 *   - releaseAll (quit, feature stop, switched off) puts every Mantle pin back to not-on-top.
 *   - suspend / resume (game rest): the pins go back to not-on-top while a game runs, and are put
 *     on top again after it, each one only if it is the same window (pid), still open, not on top
 *     already, and still pinnable.
 *   - adopt (start-up): pins a crashed Mantle left behind (the saved list) are put back.
 *   - Nothing is silent: every outcome is { did, text, reason } for the pop-up, and one log line.
 */

const PASSIVE = 'refused: sidecar is passive (test mode)';

/* PLAIN WORDS ON SCREEN (lane windows-layouts, 2026-09-29; BRIEF: never "sidecar", API names, error
   codes). The sidecar's reasons are written for the log; this turns one into what a pop-up or a menu
   may show. The log keeps the raw text. Also used by window layouts (_layouts-core / _layouts-run). */
const HELPER_DOWN = 'Mantle’s window helper didn’t answer (it may be restarting): try again in a moment';
function plain(why) {
  let s = String(why == null ? '' : why).trim();
  if (!s) return 'no reason came back';
  if (s.startsWith(PASSIVE) || /^refused: sidecar is passive/.test(s)) return 'test run: Mantle only changes its own test windows';
  if (/unknown command|older than .*sidecar|build:sidecar/i.test(s)) return 'part of Mantle is out of date: restart Mantle after updating it';
  if (/sidecar|timed out|did not answer in time/i.test(s)) return HELPER_DOWN;
  s = s.replace(/,? and Windows does not let Mantle \(which does not\) (change|move) its windows \(UIPI\)/g, ', so Windows doesn’t let Mantle $1 it')
    .replace(/ runs above Mantle \(as administrator, or protected\), and Windows refused the change \(access denied, UIPI\)/g, ' runs as administrator (or is protected), so Windows refused the change')
    .replace(/ \(access denied \(it runs above Mantle, UIPI\)\)/g, ': it runs as administrator (or is protected)')
    .replace(/ \(access denied, UIPI\)/g, ': it runs as administrator (or is protected)')
    .replace(/\s*\((?:[A-Za-z]+ )?(?:Win32 )?error -?\d+\)/g, '')
    .replace(/\s*\(UIPI\)/g, '')
    .replace(/\s*\b0x[0-9a-f]{6,8}\b/gi, '')
    .replace(/\b(ENOENT|EACCES|EPERM|EBUSY)\b:?\s*/g, '');
  return s.trim() || 'no reason came back';
}

function createCore(o) {
  const pins = new Map();   // hwnd (string) -> { hwnd, pid, name, exe, at, via }
  const log = (t) => { try { o.log(t); } catch (_) { /* logging never breaks a pin */ } };
  const list = () => Array.from(pins.values()).map((p) => Object.assign({}, p));

  function changed() {
    try { o.save(list()); } catch (err) {
      log(`could not save the pin list (${err && err.message}); if Mantle crashes now, those windows stay on top`);
    }
    if (o.onChange) { try { o.onChange(list()); } catch (err) { log(`the pin-state push failed: ${err && err.message}`); } }
  }

  // reason: plain words for the pop-up and the bar menu; raw: the sidecar's words, for the log only
  function out(did, text, reason, name) {
    const ok = did === 'pinned' || did === 'unpinned' || did === 'dry' || did === 'none';
    const res = { ok, did, text, reason: reason ? plain(reason) : null, name: name || null, tone: ok ? (did === 'dry' ? 'quiet' : '') : 'warn' };
    Object.defineProperty(res, 'raw', { value: reason || null, enumerable: false });
    return res;
  }
  function said(r) { return String((r && (r.error || r.reason)) || 'no reason came back'); }
  function passive(r) { return !!o.test && said(r).startsWith(PASSIVE); }
  function note(res, via) {
    // one log line per outcome; a refusal / failure carries its (raw) reason
    const why = res.raw || res.reason;
    const tail = why ? `: ${why}` : '';
    if (res.did === 'pinned' || res.did === 'unpinned') return;   // pin() / unpin() log their own line with the window
    log(`${res.did}${via ? ` (${via})` : ''}: ${res.text}${tail}`);
  }

  async function pin(t, via) {
    const name = t.name || 'this window';
    if (t.refuse) { const r = out('refused', `Can’t keep ${name} on top`, t.refuse, name); note(r, via); return r; }
    if (t.topmost) {
      const r = out('refused', `${name} is already on top`, 'it keeps itself on top (its own setting), so Mantle leaves it exactly as it is', name);
      note(r, via);
      return r;
    }
    const s = await o.send('ontop.set', { hwnd: t.hwnd, on: true, pid: t.pid });
    if (!s.ok) {
      const r = passive(s) ? out('dry', `Dry run: would keep ${name} on top`, 'test run: Mantle only changes its own test windows', name)
        : out('failed', `Couldn’t keep ${name} on top`, said(s), name);
      note(r, via);
      return r;
    }
    if (!s.result.changed) {
      // it went on top by itself between the read and the set: not Mantle's, so not recorded
      const r = out('refused', `${name} is already on top`, 'it put itself on top just now, so Mantle leaves it as it is', name);
      note(r, via);
      return r;
    }
    const p = { hwnd: String(t.hwnd), pid: t.pid, name, exe: t.exe || '', at: Date.now(), via: via || '' };
    pins.set(p.hwnd, p);
    log(`kept on top: ${name} (${p.exe || '?'}, window ${p.hwnd}) via ${p.via}${s.result.tries > 1 ? `, took ${s.result.tries} tries` : ''}`);
    changed();
    return out('pinned', `Kept on top: ${name}`, null, name);
  }

  async function unpin(p, via) {
    const s = await o.send('ontop.set', { hwnd: p.hwnd, on: false, pid: p.pid });
    if (!s.ok && /has closed|closed while/.test(said(s))) {
      pins.delete(p.hwnd);
      log(`forgot ${p.name} (window ${p.hwnd}) via ${via}: it had closed`);
      changed();
      return out('unpinned', `No longer on top: ${p.name}`, 'its window had closed', p.name);
    }
    if (!s.ok) {
      const r = passive(s) ? out('dry', `Dry run: would stop keeping ${p.name} on top`, 'test run: Mantle only changes its own test windows', p.name)
        : out('failed', `Couldn’t stop keeping ${p.name} on top`, said(s), p.name);
      note(r, via);
      return r;   // still recorded: it IS still on top, and quit will try again
    }
    pins.delete(p.hwnd);
    log(`no longer on top: ${p.name} (window ${p.hwnd}) via ${via}`);
    changed();
    return out('unpinned', `No longer on top: ${p.name}`, null, p.name);
  }

  /** The chord: flip the window in front. `t` = the sidecar's facts (ontop.front / ontop.info). */
  async function toggle(t, via) {
    if (!t || !t.hwnd || t.hwnd === '0') {
      const r = out('refused', 'Nothing to keep on top', (t && t.refuse) || 'no window is in front');
      note(r, via);
      return r;
    }
    const p = pins.get(String(t.hwnd));
    if (p && p.pid === t.pid) return unpin(p, via);
    if (p) { pins.delete(p.hwnd); log(`forgot ${p.name} (window ${p.hwnd}): its handle now belongs to another program`); changed(); }
    return pin(t, via);
  }

  /** The menu: an explicit on / off for one window. */
  async function set(t, on, via) {
    if (!t || !t.hwnd || t.hwnd === '0') { const r = out('refused', 'That window has closed', t && t.refuse); note(r, via); return r; }
    const p = pins.get(String(t.hwnd));
    const mine = p && p.pid === t.pid;
    if (on) return mine ? out('none', `${p.name} is already kept on top`, null, p.name) : toggle(t, via);
    if (mine) return unpin(p, via);
    const name = t.name || 'this window';
    const r = t.topmost ? out('refused', `${name} keeps itself on top`, 'Mantle did not put it there, so Mantle does not take it away', name)
      : out('none', `${name} is not kept on top`, null, name);
    note(r, via);
    return r;
  }

  /** Forget pins whose window closed or went off top by someone else's hand. */
  let sweeping = false;
  async function sweep() {
    if (!pins.size) return { checked: 0 };
    // one at a time: the timer ticks every 2 s, a slow sidecar answers in up to 4 s (they stacked up)
    if (sweeping) return { checked: 0, busy: true };
    sweeping = true;
    let s;
    try { s = await o.send('ontop.check', { hwnds: list().map((p) => ({ hwnd: p.hwnd, pid: p.pid })) }); } finally { sweeping = false; }
    if (!s || !s.ok) return { checked: 0, error: said(s) };
    let dropped = 0;
    for (const w of s.result.windows || []) {
      const p = pins.get(String(w.hwnd));
      if (!p) continue;
      if (w.alive && w.topmost) continue;
      pins.delete(p.hwnd);
      dropped++;
      log(`forgot ${p.name} (window ${p.hwnd}): ${w.alive ? 'something else took it off top (the app itself, most likely); Mantle leaves it' : 'its window closed'}`);
    }
    if (dropped) changed();
    return { checked: (s.result.windows || []).length, dropped };
  }

  /** Every Mantle pin back to not-on-top (quit, stop, switched off). Returns what was put back. */
  async function releaseAll(why) {
    const all = list();
    if (!all.length) return { put: [], closed: 0, failed: [] };
    const put = [], failed = [];
    let closed = 0;
    for (const p of all) {
      const s = await o.send('ontop.set', { hwnd: p.hwnd, on: false, pid: p.pid });
      if (s.ok) put.push(p);
      else if (/has closed|closed while/.test(said(s))) closed++;
      else if (passive(s)) put.push(p);   // --test: never really pinned, nothing to put back
      else failed.push(`${p.name}: ${said(s)}`);
      pins.delete(p.hwnd);
    }
    log(`put back ${put.length} window(s) kept on top (${why})${closed ? `; ${closed} had closed` : ''}${failed.length ? `; COULD NOT put back ${failed.join('; ')}` : ''}`);
    changed();
    return { put, closed, failed };
  }

  /** Rest: off top while the game runs; the list comes back to resume(). */
  async function suspend(why) {
    const r = await releaseAll(`a game runs: ${why}`);
    return r.put.map((p) => ({ hwnd: p.hwnd, pid: p.pid, name: p.name, exe: p.exe }));
  }

  /** After the game: each saved pin goes back on top, if it is still the same, open, pinnable window. */
  async function resume(saved, why) {
    const back = [], skipped = [];
    for (const p of saved || []) {
      const i = await o.send('ontop.info', { hwnd: p.hwnd });
      if (!i.ok) { skipped.push(`${p.name}: it closed`); continue; }
      const t = i.result;
      if (t.pid !== p.pid) { skipped.push(`${p.name}: it closed`); continue; }
      if (t.topmost) { skipped.push(`${p.name}: already on top by itself`); continue; }
      const r = await pin(Object.assign({}, t, { name: p.name }), `back after ${why}`);
      if (r.did === 'pinned') back.push(p.name);
      else skipped.push(`${p.name}: ${r.reason || r.text}`);
    }
    if ((saved || []).length) log(`after ${why}: ${back.length} of ${saved.length} window(s) on top again${skipped.length ? `; not: ${skipped.join('; ')}` : ''}`);
    return { back, skipped };
  }

  /** Start-up: a previous Mantle that crashed left these on top. They were Owen's choice, so the ones
      still open (same pid) and still on top are KEPT and are Mantle's pins again: the badge comes
      back, Win+Ctrl+T takes them off, quit puts them back (lane windows-layouts, 2026-09-29). They
      used to be taken off top with only a log line: a pinned video dropped behind with no word. */
  async function adopt(left) {
    const items = Array.isArray(left) ? left.filter((p) => p && p.hwnd && p.pid) : [];
    if (!items.length) return { kept: 0 };
    const s = await o.send('ontop.check', { hwnds: items.map((p) => ({ hwnd: String(p.hwnd), pid: p.pid })) });
    if (!s || !s.ok) { log(`a previous Mantle left ${items.length} window(s) kept on top; could not check them (${said(s)})`); return { kept: 0, error: said(s) }; }
    let kept = 0;
    for (const w of s.result.windows || []) {
      if (!w.alive || !w.topmost) continue;
      const p = items.find((x) => String(x.hwnd) === String(w.hwnd));
      if (!p || pins.has(String(w.hwnd))) continue;
      const name = typeof p.name === 'string' && p.name ? p.name.slice(0, 48) : 'a window';
      pins.set(String(w.hwnd), { hwnd: String(w.hwnd), pid: p.pid, name, exe: '', at: Date.now(), via: 'kept after a restart' });
      kept++;
    }
    log(`a previous Mantle left ${items.length} window(s) kept on top: ${kept} still on top, kept`);
    changed();
    return { kept };
  }

  return { toggle, set, sweep, releaseAll, suspend, resume, adopt, list, get size() { return pins.size; } };
}

module.exports = { createCore, PASSIVE, plain };
