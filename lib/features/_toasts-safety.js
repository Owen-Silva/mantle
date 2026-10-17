'use strict';
/*
 * lib/features/_toasts-safety.js -- WINDOWS' OWN BANNERS BACK WHENEVER MANTLE'S CANNOT BE SHOWN
 * (lane mantle-notif-safety, 2026-10-17).
 *
 * Owen's rule: "If Mantle replaces a Windows surface, the Windows surface must come back if Mantle crashes
 * or closes." Mantle's banners need its notification helper (the sidecar): it reads the toasts AND it is
 * the only thing in a running Mantle that writes ShowBanner. So when the helper is dead, main is up, the
 * apps' Windows banners are still Mantle's 0, and nobody shows anything: Owen silently gets no pop-ups.
 * The helper's own exit put-back (ToastBanners.RestoreForExit) does not run when it is killed hard
 * (TerminateProcess, a native crash), and main's restore() goes THROUGH the helper.
 *
 * THIS MODULE: main's put-back that needs no helper. tools/restore-banners.ps1 (no Node, no Mantle; the
 * same rule as everywhere: an original goes back only where the value is still Mantle's 0; it never
 * writes the record, so the next take sees "back to the original" and takes the app again).
 *   - the helper is down for GRACE_MS (a normal restart is ~3 s), or it gave up: run the script now;
 *   - main exits (any 'exit' path: quit, an uncaught exception's exit, process.exit) while the helper is
 *     down and nothing was put back yet: the script runs to its end before main is gone (leave());
 *   - toasts.js stop() with the helper down: the same (its own restore() goes through the helper).
 * It never runs while the helper is up, so it never fights a running Mantle's take; and toasts.js
 * apply() waits for a run in flight (idle()) before it takes again.
 *
 * Every run is said: state() feeds Settings' notification status (_toasts-status.js) and the feature's
 * health, with the time it was put back or the reason it could not be.
 *
 * Pure: the script runner comes in as o.run() -> Promise<{code, out}> and o.sync() -> {code, out, error};
 * tests fake both.
 */

const GRACE_MS = 8000;   // the helper's first restart is 3 s away (lib/sidecar.js RESTART_DELAY_MS)

/** restore-banners.ps1's output -> { ok, back, left, why }. */
function readOut(code, out) {
  const text = String(out || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /(\d+) put back to Windows' own pop-up, (\d+) left/.exec(text);
  const back = m ? Number(m[1]) : 0;
  const left = m ? Number(m[2]) : 0;
  if (code === 0 && (/^verified$/m.test(text) || /nothing to put back|owns no app|the record is empty/.test(text))) return { ok: true, back, left, why: null };
  const problem = lines.find((l) => /^PROBLEM|^NOT VERIFIED/.test(l)) || lines[lines.length - 1] || null;
  const why = problem ? problem.replace(/^(PROBLEM|NOT VERIFIED)\s*-?\s*/, '').slice(0, 300) : `the put-back script ended with code ${code}`;
  return { ok: false, back, left, why };
}

/*
 * o: { owned() -> number (apps Mantle took, from the record), run(), sync(), log(line),
 *      now(), setTimeout, clearTimeout, graceMs, onChange() }
 */
function createSafety(o) {
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : GRACE_MS;
  const changed = () => { if (o.onChange) { try { o.onChange(); } catch (_) { /* a status repaint only */ } } };
  const S = {
    down: null,       // { why, at } while the helper is not running
    timer: null,      // the grace timer
    running: null,    // the run in flight (a promise)
    last: null,       // the last run: { at, ok, back, left, why, how, nothing?, sync? }
    disposed: false,
  };

  function run(how) {
    if (S.running) return S.running;
    if (!(o.owned() > 0)) {
      S.last = { at: now(), ok: true, back: 0, left: 0, why: null, how, nothing: true };
      changed();
      return Promise.resolve(S.last);
    }
    log(`Windows' own pop-ups are being put back (${how})`);
    S.running = Promise.resolve()
      .then(() => o.run())
      .then((r) => readOut(r && r.code, r && r.out), (err) => ({ ok: false, back: 0, left: 0, why: `the put-back script would not run (${String(err && err.message || err).split('\n')[0].slice(0, 200)})` }))
      .then((r) => {
        S.running = null;
        S.last = Object.assign({ at: now(), how }, r);
        log(r.ok ? `Windows' own pop-ups are back (${how}): ${r.back} put back, ${r.left} left as they were`
          : `Windows' own pop-ups could NOT all be put back (${how}): ${r.why}`);
        changed();
        return S.last;
      });
    return S.running;
  }

  return {
    /** The helper is not running (status down / starting after a death). Starts the grace once.
     *  opts.starting: it has not started yet in this run (Mantle's own start), said differently. */
    down(why, opts) {
      if (S.disposed) return;
      if (!S.down) S.down = { why: String(why || 'it stopped'), at: now(), starting: !!(opts && opts.starting) };
      else { S.down.why = String(why || S.down.why); if (!(opts && opts.starting)) S.down.starting = false; }
      if (S.timer || S.running || (S.last && S.last.at >= S.down.at)) { changed(); return; }
      S.timer = setT(() => { S.timer = null; if (S.down && !S.disposed) run('Mantle\'s notification helper stopped'); }, graceMs);
      if (S.timer && S.timer.unref) S.timer.unref();
      changed();
    },
    /** The helper gave up restarting (or will not start at all): no grace. */
    gaveUp(why) {
      if (S.disposed) return Promise.resolve(null);
      if (!S.down) S.down = { why: String(why || 'it stopped'), at: now() };
      if (S.timer) { clearT(S.timer); S.timer = null; }
      if (S.last && S.last.at >= S.down.at && S.last.ok) return Promise.resolve(S.last);
      return run('Mantle\'s notification helper stopped and is not coming back on its own');
    },
    /** The helper is ready again: Mantle takes the banners back (toasts.js apply, after idle()). */
    up() {
      if (S.timer) { clearT(S.timer); S.timer = null; }
      if (S.down) { S.down = null; changed(); }
    },
    /** A run in flight, so a take never races the script. */
    idle() { return S.running ? S.running.then(() => undefined, () => undefined) : Promise.resolve(); },
    /**
     * main is exiting (or the feature stops) and the helper cannot put anything back: the script runs
     * to its end HERE, synchronously, so main's exit waits for it (~1-2 s, only on this rare road). Not
     * detached: measured 2026-10-17, powershell.exe started with DETACHED_PROCESS (node's detached:true)
     * exits 0 at once and runs nothing. -> true when the script ran and said everything is back.
     */
    leave(how) {
      if (S.timer) { clearT(S.timer); S.timer = null; }
      if (!(o.owned() > 0)) return false;
      if (S.running) log(`a put-back was still running as Mantle left (${how}); running it once more to its end`);
      else if (S.last && S.down && S.last.at >= S.down.at && S.last.ok) return false;   // already back
      let r;
      try {
        const x = o.sync();
        r = x && x.error ? { ok: false, back: 0, left: 0, why: `the put-back script would not run (${String(x.error.message || x.error).split('\n')[0].slice(0, 200)})` }
          : readOut(x && x.code, x && x.out);
      } catch (err) {
        r = { ok: false, back: 0, left: 0, why: `the put-back script would not run (${String(err && err.message || err).split('\n')[0].slice(0, 200)})` };
      }
      S.last = Object.assign({ at: now(), how, sync: true }, r);
      log(r.ok ? `Windows' own pop-ups are back as Mantle leaves (${how}): ${r.back} put back, ${r.left} left as they were`
        : `Windows' own pop-ups could NOT all be put back as Mantle leaves (${how}): ${r.why}`);
      return r.ok;
    },
    dispose() { S.disposed = true; if (S.timer) { clearT(S.timer); S.timer = null; } },
    /** For the status and health: a copy. */
    state() {
      return { down: S.down ? Object.assign({}, S.down) : null, pending: !!S.timer, running: !!S.running,
        last: S.last ? Object.assign({}, S.last) : null, graceMs };
    },
  };
}

/*
 * The real runner: powershell tools/restore-banners.ps1 for <record>, hidden. A --test Mantle passes
 * -TestOnly (it owns Mantle.ToastTest ids only, and the script then refuses any other id too).
 * o: { spawn, script, recordFile, test, settingsKey? (tests), timeoutMs }
 */
function scriptRunner(o) {
  const args = () => {
    const a = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', o.script, '-RecordFile', o.recordFile];
    if (o.settingsKey) a.push('-SettingsKey', o.settingsKey);
    if (o.test) a.push('-TestOnly');
    return a;
  };
  const exe = o.exe || 'powershell.exe';
  return {
    run() {
      return new Promise((resolve, reject) => {
        let out = '';
        let child;
        try { child = o.spawn(exe, args(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { reject(err); return; }
        const t = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } reject(new Error('the put-back script did not finish in 60 s')); }, o.timeoutMs || 60000);
        if (child.stdout) child.stdout.on('data', (d) => { out += d; });
        if (child.stderr) child.stderr.on('data', (d) => { out += d; });
        child.once('error', (err) => { clearTimeout(t); reject(err); });
        child.once('close', (code) => { clearTimeout(t); resolve({ code, out }); });
      });
    },
    /** To its end, blocking (main's 'exit'): -> { code, out, error }. */
    sync() {
      const r = (o.spawnSync || require('child_process').spawnSync)(exe, args(), { windowsHide: true, encoding: 'utf8', timeout: o.syncTimeoutMs || 30000 });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error || null };
    },
    args,
  };
}

module.exports = { createSafety, scriptRunner, readOut, GRACE_MS };
