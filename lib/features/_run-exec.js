'use strict';
/*
 * _run-exec.js - the one road Run (Win+R) and Quick links (Win+X) launch by (lane keysrun, 2026-10-15).
 * Not a feature (underscore): lib/features/run.js and quicklinks.js each make one with makeExec(ctx).
 *
 *   exec({ file, params, admin }) -> { ok, reason?, dryRun?, pid? }   never throws
 *     ShellExecuteEx in the sidecar (sidecar/Run.cs run.exec): file and params kept apart, params
 *     verbatim, "runas" for admin (Windows' own UAC prompt). Main hands its foreground right to the
 *     sidecar first (lib/fg-grant.js), so the new window comes up in front. A launch Windows has not
 *     answered within the sidecar's 300 ms (a UAC prompt waiting for Owen) finishes as a `run` event.
 *     --test: a DRY RUN through the same command (dryRun:true), which still looks the program up
 *     (run.resolve's lookup), so an unknown command gets its real words without anything starting.
 *   open(item) -> lib/launcher-index.js launch(): Mantle Files / Settings / Task Manager, a Settings
 *     page through Mantle Settings, a URL through the launcher's browser road (dry run in --test).
 *   helperProblem(err) -> plain words for a sidecar refusal.
 */
const runLine = require('../run-line');

const HELPER_DOWN = 'Mantle\'s helper isn\'t running, so this can\'t run right now. It restarts by itself; until then Win+R and Win+X open Windows\' own.';
const HELPER_OLD = 'Mantle\'s helper is older than Run and Quick links. Restart Mantle to update it.';
const EARLY_KEEP_MS = 60000;

function helperProblem(err) {
  const m = String(err == null ? '' : err);
  if (/unknown command|no such command|not a command/i.test(m)) return HELPER_OLD;
  if (/^refused: sidecar is passive/.test(m)) return 'Test mode: nothing was started.';
  return m ? m.charAt(0).toUpperCase() + m.slice(1).replace(/\.?$/, '.') : 'Mantle\'s helper did not say why it refused.';
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

function makeExec(ctx, opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;
  const waiters = new Map();      // ticket -> { resolve, timer }
  const early = new Map();        // ticket -> { ev, at }: the outcome beat its own "pending" reply here
  ctx.sidecar.on('run', (ev) => {
    if (!ev || typeof ev.ticket !== 'string') return;
    const w = waiters.get(ev.ticket);
    if (w) { waiters.delete(ev.ticket); clearTimeout(w.timer); w.resolve(ev); return; }
    const now = Date.now();
    for (const [t, e] of early) if (now - e.at > EARLY_KEEP_MS) early.delete(t);
    early.set(ev.ticket, { ev, at: now });
  });
  const wait = (ticket, ms) => new Promise((resolve) => {
    const got = early.get(ticket);
    if (got) { early.delete(ticket); resolve(got.ev); return; }
    const timer = setTimeout(() => { waiters.delete(ticket); resolve({ ok: false, timedOut: true }); }, ms);
    if (timer.unref) timer.unref();
    waiters.set(ticket, { resolve, timer });
  });

  async function exec(a) {
    const file = String((a && a.file) || '');
    const params = String((a && a.params) || '');
    const admin = !!(a && a.admin);
    const verb = admin ? 'runas' : 'open';
    if (!file.trim()) return { ok: false, reason: 'Type a program, folder, document or website.' };
    if (!ctx.sidecar.ready) return { ok: false, reason: HELPER_DOWN };
    if (dryRun) {
      const r = await ctx.sidecar.send('run.exec', { file, params, verb, dryRun: true }, { timeoutMs: 4000 });
      if (!r.ok) return { ok: false, dryRun: true, reason: helperProblem(r.error) };
      const f = r.result && r.result.found;
      const isUri = SCHEME_RE.test(file) && !/^[a-zA-Z]:/.test(file);
      if (!isUri && !(f && f.found)) return { ok: false, dryRun: true, code: 2, reason: runLine.words({ ok: false, code: 2 }, file, admin) };
      const what = isUri ? file : f.found;
      return { ok: true, dryRun: true, reason: `dry run: would ${admin ? 'run as administrator' : 'open'} ${what}${params ? ' with ' + params : ''}` };
    }
    if (typeof o.grant === 'function') { try { o.grant(); } catch (_) { /* the window may open behind: never a reason not to run */ } }
    const r = await ctx.sidecar.send('run.exec', { file, params, verb }, { timeoutMs: 3000 });
    if (!r.ok) return { ok: false, reason: helperProblem(r.error) };
    let out = r.result || {};
    if (out.pending) {
      out = await wait(String(out.ticket), admin ? 180000 : 30000);
      if (out.timedOut) {
        return { ok: false, reason: admin ? 'Mantle stopped waiting for Windows\' administrator prompt. If you say yes to it, it still runs.'
          : `Windows hasn't said whether "${file}" started. It may still open.` };
      }
    }
    if (out.ok) return { ok: true, pid: out.pid || null };
    return { ok: false, code: out.code, reason: runLine.words(out, file, admin) };
  }

  async function open(item) {
    let res;
    try {
      res = await require('../launcher-index').launch(item, { dryRun });
    } catch (err) {
      return { ok: false, reason: `It didn't open: ${(err && err.message) || err}.` };
    }
    if (dryRun && res) res.dryRun = true;
    return res || { ok: false, reason: 'It didn\'t open, and no reason came back.' };
  }

  return { exec, open, helperProblem, HELPER_DOWN };
}

/** On every sidecar start: does this helper know run.exec? An old exe does not; say so and hand the chord back. */
async function probe(ctx, chordWords) {
  const r = await ctx.sidecar.send('run.resolve', { file: 'cmd.exe' }, { timeoutMs: 4000 });
  if (r.ok) { ctx.health(true, chordWords); return true; }
  if (/unknown command|no such command|not a command/i.test(String(r.error))) { ctx.health(false, HELPER_OLD); return false; }
  ctx.log(`run.resolve probe failed: ${String(r.error).slice(0, 200)}`);   // transient: keep the chord
  return true;
}

module.exports = { makeExec, probe, helperProblem, HELPER_DOWN, HELPER_OLD };
