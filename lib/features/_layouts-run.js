'use strict';
/* _layouts-run.js - WINDOW LAYOUTS, putting one back (lane layouts, 2026-09-27). The steps, with
 * every Windows call injected, so lib/features/layouts.test.js drives it on a fake sidecar and
 * sidecar/test-layouts.js on the real one with fixture windows:
 *
 *   1. read the windows and monitors (sidecar layouts.windows)
 *   2. work out each entry's frame now (_layouts-core targetOf) and pair entries with open windows
 *      (_layouts-core match: same app, best title words, each window once)
 *   3. place each pair (sidecar layouts.place, one at a time; a refusal or a failure is that
 *      entry's reason, the others carry on)
 *   4. start the apps of the entries left over (launchPlan: one start per app), then watch for their
 *      NEW windows for up to waitMs (10 s) and place each once it has stood still for settleMs
 *   5. what is still unmatched is "not found", each with its reason
 *
 * Windows that are not in the layout are never touched: only matched hwnds are ever sent to
 * layouts.place. DRY RUN (a --test instance, or opts.dryRun): Owen's windows are only asked what
 * would happen (layouts.place dryRun) and nothing is started; a test's own fixtures (w.ours) are real.
 */
const core = require('./_layouts-core');

const REFUSAL = /administrator|not responding|did not answer|Mantle's own|Windows' shell|refused: sidecar is passive|UIPI/i;

async function restore(layout, deps) {
  const d = Object.assign({ waitMs: 10000, settleMs: 700, pollMs: 400, placeTimeoutMs: 6000 }, deps || {});
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = d.now || Date.now;
  const log = d.log || (() => {});
  const dryAll = !!d.dryRun;
  const name = layout.name;
  const entries = layout.entries || [];

  const read = async () => {
    const r = await d.send('layouts.windows', {}, { timeoutMs: 6000 });
    if (!r || !r.ok) throw new Error((r && r.error) || 'the sidecar did not answer');
    return r.result || {};
  };
  let snap;
  try { snap = await read(); } catch (err) {
    return { ok: false, reason: `could not read the open windows (${err.message})` };
  }
  const monitors = snap.monitors || [];
  if (!monitors.length) return { ok: false, reason: 'Windows reported no monitors, so there is nowhere to put the windows' };

  const targets = entries.map((e) => core.targetOf(e, monitors));
  const results = entries.map((e) => ({ app: e.app || 'An app', kind: null }));
  const pairs = core.match(entries, snap.windows || [], targets);
  const known = new Set((snap.windows || []).map((w) => w.hwnd));
  const used = new Set();

  async function place(i, w, opened) {
    const e = entries[i], tg = targets[i], res = results[i];
    used.add(w.hwnd);
    const dry = dryAll || (d.test && !w.ours);
    const args = { hwnd: w.hwnd, pid: w.pid, frame: tg.frame, state: tg.state, dryRun: dry };
    const r = await d.send('layouts.place', args, { timeoutMs: d.placeTimeoutMs });
    if (!r || !r.ok) {
      const why = String((r && r.error) || 'the sidecar gave no reason');
      res.kind = REFUSAL.test(why) ? 'refused' : 'failed';
      res.why = /^(that |Windows )/.test(why) ? `${e.app}: ${why}` : why;
      return;
    }
    const x = r.result || {};
    if (x.dryRun) { res.kind = opened ? 'wouldOpen' : 'wouldPlace'; res.note = x.would ? 'would ' + x.would : null; return; }
    res.kind = opened ? 'opened' : (x.already ? 'already' : 'placed');
    if (x.note) res.note = x.note;
    if (x.state === 'max' && x.monitorOk === false) res.note = 'it maximised on another monitor than the saved one';
  }

  // 3. the windows that are already open
  for (let i = 0; i < entries.length; i++) {
    if (!targets[i]) { results[i].kind = 'failed'; results[i].why = `${entries[i].app}: no monitor to put it on`; continue; }
    const w = pairs[i].window;
    if (w) await place(i, w, false);
  }

  // 4. start what is missing: one start per app (VS Code opens its own windows back, two entries of
  //    one app wait for two new windows)
  const missing = entries.map((e, i) => i).filter((i) => !results[i].kind);
  const groups = new Map();
  for (const i of missing) {
    const e = entries[i];
    const key = (e.aumid ? 'a:' + String(e.aumid).toLowerCase() : 'e:' + String(e.exe || '').toLowerCase());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const waiting = [];
  for (const [, idx] of groups) {
    const e = entries[idx[0]];
    const plan = core.launchPlan(e, { exists: d.exists, browserExe: d.browserExe, browserDir: d.browserDir });
    if (plan.how === 'none') { for (const i of idx) { results[i].kind = 'notfound'; results[i].why = plan.why; } continue; }
    const fixture = !!(d.isFixtureExe && d.isFixtureExe(plan.exe || e.exe));
    if (dryAll || (d.test && !fixture)) {
      for (const i of idx) { results[i].kind = 'wouldOpen'; results[i].note = plan.how === 'aumid' ? 'would start its app, then place its window' : 'would start its program, then place its window'; }
      continue;
    }
    let started = null;
    if (plan.how === 'aumid') {
      const r = await d.send('launch', { aumid: plan.aumid }, { timeoutMs: 8000 });
      const ok = r && r.ok && (!r.result || r.result.ok !== false);
      if (ok) started = 'aumid';
      else if (plan.fallbackExe) {
        const s = await d.spawn(plan.fallbackExe, []);
        if (s && s.ok) started = 'exe';
        else started = null;
        if (!started) { for (const i of idx) { results[i].kind = 'notfound'; results[i].why = `${e.app} isn't open, and it would not start (${(s && s.reason) || 'no reason came back'})`; } continue; }
      } else {
        const why = (r && (r.error || (r.result && r.result.reason))) || 'no reason came back';
        for (const i of idx) { results[i].kind = 'notfound'; results[i].why = `${e.app} isn't open, and Windows would not start it (${why})`; }
        continue;
      }
    } else {
      const s = await d.spawn(plan.exe, plan.args || []);
      if (!s || !s.ok) {
        for (const i of idx) { results[i].kind = 'notfound'; results[i].why = `${e.app} isn't open, and it would not start (${(s && s.reason) || 'no reason came back'})`; }
        continue;
      }
      started = 'exe';
    }
    log(`started ${core.appNameOf({ exe: e.exe }) || 'an app'} for layout (${idx.length} window${idx.length === 1 ? '' : 's'} to place)`);
    waiting.push(...idx);
  }

  // ... and watch for their windows
  if (waiting.length) {
    const firstSeen = new Map();
    const t0 = now();
    let pending = waiting.slice();
    let readErr = null;
    while (pending.length && now() - t0 < d.waitMs) {
      await sleep(d.pollMs);
      let s;
      try { s = await read(); readErr = null; } catch (err) { readErr = err.message; continue; }
      const fresh = (s.windows || []).filter((w) => !known.has(w.hwnd) && !used.has(w.hwnd));
      const t = now();
      for (const w of fresh) if (!firstSeen.has(w.hwnd)) firstSeen.set(w.hwnd, t);
      // a window is placed once it has stood still for settleMs (apps put their own saved spot first)
      const ready = fresh.filter((w) => t - firstSeen.get(w.hwnd) >= d.settleMs);
      if (!ready.length) continue;
      const sub = pending.map((i) => entries[i]);
      const m = core.match(sub, ready, pending.map((i) => targets[i]));
      const next = [];
      for (let k = 0; k < pending.length; k++) {
        const w = m[k].window;
        if (w) await place(pending[k], w, true);
        else next.push(pending[k]);
      }
      pending = next;
    }
    for (const i of pending) {
      const e = entries[i];
      const sameApp = waiting.filter((j) => j !== i && core.tierOf(entries[j], e) > 0 && results[j].kind === 'opened').length;
      results[i].kind = 'notfound';
      results[i].why = readErr ? `${e.app} was started, but its window could not be looked for (${readErr})`
        : sameApp ? `${e.app} opened ${sameApp} window${sameApp === 1 ? '' : 's'}, and this layout had ${sameApp + 1}`
          : `${e.app} was started, but no window of it showed within ${Math.round(d.waitMs / 1000)} s`;
    }
  }

  const dry = dryAll || !!d.test;
  const sum = core.summarize(name, results, { dryRun: dry && results.some((r) => /^would/.test(r.kind)) });
  return Object.assign({ ok: true, name, dryRun: dry, results }, sum);
}

module.exports = { restore, REFUSAL };
