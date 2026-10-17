/* qs-tiles.test.js - node ui/bar/qs-tiles.test.js (pure node, a small fake DOM, no browser, no Electron)
 *
 * Regression (lane mantle-integrate6, 2026-10-17): attach() made the open panel `live`, and listen()'s
 * qstiles.state / project.state handlers call live.paint() - but `me` had no paint, so every state push
 * while Quick Settings was open threw "live.paint is not a function" (popclose e2e caught it in main as
 * '[The bar] mantle.on("project.state") handler threw'). Fails on d0deee1, passes once me.paint = paint. */
'use strict';
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }

// ---- a fake DOM: just what qs-tiles.js touches ----
const attached = new Set();
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.className = ''; this.dataset = {}; this.children = []; this.attrs = {};
    this.hidden = false; this.title = ''; this.innerHTML = ''; this.type = ''; this.parentNode = null; this._text = ''; this._on = {};
    const set = this._cls = new Set();
    this.classList = {
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, on) => { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
}
global.document = { createElement: (t) => new FakeEl(t), contains: (n) => attached.has(n) };
global.window = { matchMedia: () => ({ matches: true }) };
global.requestAnimationFrame = () => 0;                  // the post-paint refresh is not under test here
const timers = [];
global.setInterval = (f, ms) => { timers.push({ f, ms }); return timers.length; };
global.clearInterval = () => {};

const Q = require('./qs-tiles.js');

// ---- a fake bar ctx: on() keeps the handler, the way preload's mantle.on does ----
const handlers = {};
const calls = [];
const ctx = {
  on(name, fn) { handlers[name] = fn; return () => { delete handlers[name]; }; },
  call(name, args) { calls.push(name); return Promise.resolve(name === 'qstiles.set' ? { ok: true } : null); },
  close() {},
};
// what preload does with a handler that throws: it reports it (the popclose e2e reads that as a failure)
function push(name, s) {
  try { handlers[name](s); return null; } catch (e) { return String((e && e.message) || e); }
}

Q.listen(ctx);
check('listen() subscribes to qstiles.state and project.state', typeof handlers['qstiles.state'] === 'function' && typeof handlers['project.state'] === 'function', Object.keys(handlers));

const q0 = { dnd: { ok: true, on: false, writable: true }, airplane: { ok: true, on: false, canSet: true }, focus: null };
check('a qstiles.state push with the panel closed does not throw', push('qstiles.state', q0) === null);
check('a project.state push with the panel closed does not throw', push('project.state', { phase: 'idle' }) === null);

const pop = new FakeEl('div'), panel = new FakeEl('div'), grid = new FakeEl('div');
panel.appendChild(grid);
attached.add(grid);
const r = Q.attach(pop, grid, ctx);
check('attach() returns { paint, closed }', !!r && typeof r.paint === 'function' && typeof r.closed === 'function');
check('attach() builds the five tiles in order', grid.children.map((b) => b.dataset.tile).join() === Q.ORDER.join(), grid.children.map((b) => b.dataset.tile));
const tile = (k) => grid.children.find((b) => b.dataset.tile === k);
check('first paint is from the held state (Do not disturb Off)', tile('dnd').textContent.includes('Off') && !tile('dnd').classList.contains('on'), tile('dnd').textContent);

// THE REGRESSION: state pushes while the panel is open
let err = push('qstiles.state', { dnd: { ok: true, on: true, writable: true }, airplane: { ok: true, on: false, canSet: true }, focus: null });
check('a qstiles.state push while Quick Settings is open does not throw', err === null, err);
check('...and repaints the open panel (Do not disturb turns on)', tile('dnd').classList.contains('on') && tile('dnd').attrs['aria-pressed'] === 'true', { cls: [...tile('dnd')._cls], sub: tile('dnd').textContent });

err = push('project.state', { phase: 'idle', read: { current: 'extend', displays: 2 } });
check('a project.state push while Quick Settings is open does not throw', err === null, err);
check('...and repaints the Project tile from it', tile('project').textContent.includes('Extend'), tile('project').textContent);

// a panel that left the document closes itself on its next paint, and is no longer live
attached.delete(grid);
err = push('qstiles.state', q0);
check('a push after the panel left the document does not throw', err === null, err);
err = push('qstiles.state', { dnd: { ok: true, on: true, writable: true }, airplane: { ok: true, on: true, canSet: true }, focus: null });
check('...and a later push no longer paints the dead panel (Airplane stays off)', err === null && tile('airplane').attrs['aria-pressed'] === 'false', { err, now: tile('airplane').attrs['aria-pressed'] });

console.log(`QS TILES TEST: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
