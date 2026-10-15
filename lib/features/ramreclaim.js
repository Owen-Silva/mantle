'use strict';
/* ramreclaim.js — "Windows pieces Mantle replaces": turn off the Windows parts Mantle has taken over, to
 * save memory (lane mantle-ramreclaim, 2026-10-15; notes/mantle-replace-windows.md P14 + Owen's
 * decisions). The engine and the piece table: lib/features/_ramreclaim-core.js (read its header for the
 * rules). The page: ui/settings/sections/ramreclaim.js (Mantle Settings > Windows pieces).
 *
 * Commands (the page calls them):
 *   ramreclaim.list           -> { ok, on, test, pieces: [...], measuredAt, measureReason }
 *   ramreclaim.set {id, on}   -> { ok, value, reason } (on = Mantle keeps that Windows piece off)
 * On: every wanted piece is turned off (recorded first). Off (the tray switch), quit, "Restore Windows
 * taskbar": every change is put back. Windows ending the session: the sign-in pieces stay off (see the
 * core). A crash: the next start puts back what is no longer wanted and keeps what is (never twice);
 * tools/restore-windows.ps1 and tools/install-autostart.ps1 -Uninstall undo it with no Mantle running.
 * A test run (--test) reads Windows' real values and writes nothing (the dry-run registry).
 * Not rest: true on purpose: while a game runs is when the memory matters most.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const core = require('./_ramreclaim-core');

const MEASURE_TTL_MS = 15000;
const SESSION_END = /Windows is ending the session/i;

module.exports = {
  name: 'ramreclaim',
  label: 'Turn off Windows pieces Mantle replaces (saves memory)',
  defaultOn: true,
  install(ctx) {
    const test = !!(ctx.flags && ctx.flags.test);
    const journalFile = path.join(path.dirname(ctx.settings.file), 'ramreclaim-journal.json');
    const reg = (typeof module.exports._registry === 'function' && module.exports._registry(ctx))
      || (test ? core.dryRunRegistry(core.realRegistry(execFile)) : core.realRegistry(execFile));
    const R = core.createReclaim({ reg, store: core.fileStore(journalFile, fs), log: (t) => ctx.log(t), now: () => Date.now() });

    const saved = () => { const s = ctx.settings.get('pieces', {}); return s && typeof s === 'object' ? s : {}; };
    const wanted = () => { const s = saved(); return new Set(core.switches().filter((p) => (p.id in s ? !!s[p.id] : p.defaultOn)).map((p) => p.id)); };
    let stopped = false;

    const health = (out) => {
      const bad = Object.entries(out || {}).find(([, n]) => n && n.state === 'error');
      const p = bad && core.pieceById(bad[0]);
      ctx.health(!bad, bad ? `${p ? p.label : bad[0]}: ${bad[1].reason}` : undefined);
    };
    const sync = (why) => R.sync(ctx.enabled() ? wanted() : new Set()).then((out) => {
      const n = Object.values(out).filter((x) => x.state === 'applied').length;
      ctx.log(`${why}: ${n} Windows piece(s) kept off${test ? ' (test run: nothing was written)' : ''}`);
      health(out);
      return out;
    }, (e) => { ctx.log(`${why}: failed: ${e && e.message ? e.message : e}`); ctx.health(false, `could not check the Windows pieces: ${e && e.message ? e.message : e}`); });

    // start-up: a crash's leftovers are put back or kept (never applied twice), then what is wanted is applied
    sync('start');
    ctx.onEnabled((on) => { if (!stopped) sync(on ? 'switched on' : 'switched off'); });

    let measured = { at: 0, procs: null, reason: 'not measured yet' };
    let measuring = null;
    async function measureNow() {
      if (Date.now() - measured.at < MEASURE_TTL_MS && measured.procs) return measured;
      if (measuring) return measuring;
      measuring = (async () => {
        let r;
        try { r = await ctx.sidecar.send('taskmgr.snapshot', {}, { timeoutMs: 6000 }); } catch (e) { r = { ok: false, error: e && e.message }; }
        const procs = r && r.ok && r.result && Array.isArray(r.result.procs) ? r.result.procs : null;
        measured = procs ? { at: Date.now(), procs, reason: null } : { at: 0, procs: null, reason: 'Mantle’s helper did not answer, so memory is not shown right now' };
        return measured;
      })().finally(() => { measuring = null; });
      return measuring;
    }

    ctx.command('list', async () => {
      const on = ctx.enabled();
      const [st, m] = await Promise.all([R.status(wanted(), on), measureNow()]);
      const byId = new Map(st.rows.map((r) => [r.id, r]));
      const pieces = core.PIECES.map((p) => {
        const r = byId.get(p.id) || {};
        const ram = m.procs ? core.measure(m.procs, p) : null;
        return {
          id: p.id, kind: p.kind, label: p.label, action: p.action || null, help: p.help, breaks: p.breaks || null,
          admin: !!p.admin, removal: !!p.removal, how: p.how || null, why: p.why || null,
          effect: p.effect || null, ramNote: p.ramNote || null, defaultOn: !!p.defaultOn,
          wanted: !!r.wanted, state: r.state || (p.kind === 'switch' ? 'error' : p.kind), reason: r.reason || null,
          since: r.since || null, keptForSignOut: !!r.keptForSignOut, mantleChanged: !!r.mantleChanged,
          ram,
        };
      });
      return { ok: true, on, test, pieces, measuredAt: m.at || null, measureReason: m.reason, journalError: st.journalError };
    });

    ctx.command('set', async (a) => {
      const id = a && typeof a.id === 'string' ? a.id : '';
      const p = core.pieceById(id);
      if (!p) return { ok: false, reason: 'Mantle does not know that piece' };
      if (p.kind !== 'switch') return { ok: false, reason: p.why || 'Mantle does not change this one' };
      const on = !!(a && a.on);
      const s = Object.assign({}, saved(), { [id]: on });
      try { ctx.settings.set('pieces', s); } catch (e) { return { ok: false, reason: 'Mantle could not save the choice: ' + (e && e.message ? e.message : e) }; }
      if (!ctx.enabled()) return { ok: true, value: on, reason: on ? 'Saved. It takes effect when this feature is switched on in Mantle’s features' : null };
      const n = await R.set(id, on);
      if (n.state === 'error') {
        try { ctx.settings.set('pieces', Object.assign({}, saved(), { [id]: !on })); } catch (_) { /* the switch springs back either way */ }
        return { ok: false, reason: n.reason };
      }
      const out = {}; out[id] = n; health(out);
      return { ok: true, value: on, reason: n.reason || null, dryRun: test || undefined };
    });

    return {
      stop(why) {
        stopped = true;
        const keepSignOut = SESSION_END.test(String(why || ''));
        return R.undoAll({ keepSignOut }).then((r) => {
          ctx.log(`stop (${keepSignOut ? 'Windows is ending the session: the sign-in pieces stay off' : 'put back'}): ${r.ok ? 'done' : 'not all put back: ' + r.reason}`);
          return r;
        });
      },
    };
  },
};
/* Tests only (lib/features/ramreclaim.test.js): `_registry(ctx)` returns a fake registry. Never set in Mantle. */
module.exports._registry = null;
