'use strict';
/*
 * lib/features/updates.js -- "a new Mantle is out": the check, the banner, the Update button
 * (lane mantle-updater, 2026-10-22). The work itself is lib/updater.js; this is when it runs and what the
 * user sees.
 *
 * WHEN: FIRST_CHECK_MS after start, then every CHECK_EVERY_MS (6 h). A check that could not reach GitHub
 * tries again in 30 min; a rate limit waits for the time GitHub gave. Never while the switch is off (tray >
 * Features, or Mantle Settings; on by default), never in a --test run, a linked git worktree, a folder that
 * is not a git clone, or one with the opt-out file (lib/updater.js offWhy): those never ask GitHub at all.
 *
 * WHAT THE USER SEES: Mantle's own banner (lib/own-banners.js, drawn by lib/features/toasts.js in the island
 * glass): "Mantle v0.2.0 is out" with Update and Later, or, when this folder cannot be updated from inside
 * Mantle, why not and the commands to do it by hand. Update shows its steps in the same banner; a failure
 * stays up with the reason and the log path. Later hides that release's banner for LATER_MS; the tray keeps
 * an "Update Mantle to v0.2.0…" row meanwhile, which brings the banner back.
 * NO SILENT FAILURES: a check that failed ("Couldn't check for updates: no internet connection ...") is this
 * feature's health, so the tray's first row and the desktop's Needs attention strip say it. The opt-out,
 * --test and worktree cases are not faults: `updates.state` says them, nothing else nags.
 *
 * AFTER THE RESTART: the new Mantle's install() calls updater.confirmStart(), which tells the restart watcher
 * it is up and shows "Mantle updated to v0.2.0". If the watcher had to give up (the new Mantle never came
 * up, Windows was put back), the next start shows that, once.
 *
 * TEST ONLY: MANTLE_UPDATE_TEST=<json file> { apiBase, owner, repo, cloneUrl, originUrl, firstMs, everyMs,
 * confirmMs } points a --test run at a fake release source (a local bare repo, a fake API on 127.0.0.1), so
 * the banner and the button can be driven end to end. Ignored, and said, without --test.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const U = require('../updater');

const ROOT = path.join(__dirname, '..', '..');
const RETRY_MS = 30 * 60 * 1000;
const LATER_MS = 24 * 60 * 60 * 1000;
const UPDATED_SHOW_MS = 15000;
const KEY = 'updates';

function testSource(flags, log) {
  const f = process.env.MANTLE_UPDATE_TEST;
  if (!f) return null;
  if (!flags.test) { log(`MANTLE_UPDATE_TEST=${f} is ignored: it is honoured only with --test`); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && typeof j.apiBase === 'string' && /^http:\/\/127\.0\.0\.1:\d+/.test(j.apiBase)) return j;
    log(`MANTLE_UPDATE_TEST is ignored: its apiBase must be http://127.0.0.1:<port>`);
  } catch (err) { log(`MANTLE_UPDATE_TEST is ignored: ${err.message}`); }
  return null;
}
const short = (s) => String(s || '').slice(0, 7);

module.exports = {
  name: 'updates',
  label: 'Check for Mantle updates',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) {
    const host = ctx.host.updates || null;
    const banners = ctx.host.ownBanners || null;
    const src = testSource(ctx.flags, (l) => ctx.log(l));
    const store = {
      get: () => ctx.settings.get('cache', null),
      set: (v) => { try { ctx.settings.set('cache', v); } catch (err) { ctx.log(`the release cache was not saved (${err.message})`); } },
    };
    const up = U.createUpdater(Object.assign({
      root: (host && host.root) || ROOT,
      userData: app.getPath('userData'),
      test: !!ctx.flags.test,
      testSource: !!src,
      live: !!ctx.flags.live,
      store,
      restart: async (why) => (host && typeof host.restart === 'function' ? host.restart(why) : { ok: false, reason: 'this Mantle has no restart road for updates' }),
      log: (l) => ctx.log(l),
    }, src ? { owner: src.owner, repo: src.repo, apiBase: src.apiBase, cloneUrl: src.cloneUrl, originUrl: src.originUrl, confirmMs: src.confirmMs } : {}));
    const firstMs = src && src.firstMs ? src.firstMs : U.FIRST_CHECK_MS;
    const everyMs = src && src.everyMs ? src.everyMs : U.CHECK_EVERY_MS;
    const S = { stopped: false, timer: null, view: null, updating: false, progress: null, failure: null, posted: null, updatedT: null };

    // ---- the tray row and the health
    function publish(view) {
      S.view = view;
      if (view.status === 'error') ctx.health(false, view.reason);
      else ctx.health(true);
      const label = view.status === 'available' && view.release ? `Update Mantle to ${view.release.tag}…` : null;
      try { if (host && typeof host.tray === 'function') host.tray(label); } catch (err) { ctx.log(`the tray row could not be set (${err.message})`); }
    }

    // ---- the banner
    function post(b) {
      if (!banners) { ctx.log(`no banner surface in this Mantle: "${b.title}" is in updates.state and the tray only`); return false; }
      S.posted = b.kind;
      banners.post(KEY, Object.assign({ app: 'Mantle', sticky: true, tone: 'info' }, b), onAction);
      return true;
    }
    function drop() { S.posted = null; if (banners) banners.drop(KEY); }
    function laterFor(tag) { return ctx.settings.get('laterTag', null) === tag && Date.now() < Number(ctx.settings.get('laterUntil', 0)); }
    function availableBanner(v) {
      const tag = v.release.tag;
      const named = v.release.name && v.release.name !== tag ? `${v.release.name}. ` : '';
      if (v.canUpdate) {
        return { kind: 'available', title: `Mantle ${tag} is out`,
          body: `${named}Update installs it and restarts Mantle by itself. The Windows taskbar stays as it is.`,
          actions: [{ id: 'update', label: 'Update', primary: true }, { id: 'later', label: 'Later' }] };
      }
      return { kind: 'manual', title: `Mantle ${tag} is out`,
        body: `${named}There is no Update button because ${v.why}. To update by hand:`,
        detail: v.manual, actions: [{ id: 'later', label: 'Later' }] };
    }
    function showFor(v, force) {
      if (S.updating || S.failure) return;
      if (v.status !== 'available' || !v.release) { if (S.posted === 'available' || S.posted === 'manual') drop(); return; }
      if (!force && laterFor(v.release.tag)) return;
      post(availableBanner(v));
    }
    function progressBanner(p) {
      const tag = S.view && S.view.release ? S.view.release.tag : 'the new version';
      return { kind: 'progress', title: `Updating Mantle to ${tag}`, body: 'Mantle restarts by itself when this is done.',
        progress: { text: p.text, pct: typeof p.pct === 'number' ? p.pct : null }, actions: [] };
    }

    async function startUpdate() {
      if (S.updating) return { ok: false, reason: 'an update is already running' };
      S.updating = true;
      S.failure = null;
      post(progressBanner({ text: 'Starting', pct: 2 }));
      let r;
      try {
        r = await up.apply((p) => { S.progress = p; if (!S.stopped) post(progressBanner(p)); });
      } catch (err) { r = { ok: false, reason: `Mantle was not updated: ${err.message}`, log: up.logPath }; }
      if (r.ok) return r;   // Mantle is on its way out; the banner says "Restarting" until it goes
      S.updating = false;
      S.failure = r;
      if (!S.stopped) {
        post({ kind: 'failed', tone: 'error', title: 'Mantle was not updated', body: r.reason,
          detail: `Log: ${r.log || up.logPath}`, actions: [{ id: 'ok', label: 'OK' }] });
      }
      return r;
    }

    async function onAction(action) {
      if (action === 'update') { startUpdate().catch((err) => ctx.log(`update failed: ${err.message}`)); return { keep: true }; }
      if (action === 'later') {
        const tag = S.view && S.view.release ? S.view.release.tag : null;
        try { ctx.settings.set('laterTag', tag); ctx.settings.set('laterUntil', Date.now() + LATER_MS); } catch (err) { ctx.log(`"Later" was not saved (${err.message})`); }
        S.posted = null;
        return { keep: false };
      }
      if (action === 'ok' || action === 'close') {
        if (S.updating) return { keep: action !== 'close' };   // the steps go on; a failure comes back up
        if (S.failure) S.failure = null;
        if (S.posted === 'restart-failed') up.clearFailed();
        if (S.posted === 'available' || S.posted === 'manual') return onAction('later');
        S.posted = null;
        return { keep: false };
      }
      return { keep: true };
    }

    // ---- the checks
    function schedule(ms) {
      clearTimeout(S.timer); S.timer = null;
      if (S.stopped || !ctx.enabled() || up.offWhy()) return;
      S.timer = setTimeout(() => { S.timer = null; tick().catch((err) => ctx.log(`check failed: ${err.message}`)); }, Math.max(1000, ms));
      if (S.timer.unref) S.timer.unref();
    }
    async function tick(force) {
      if (S.stopped) return S.view;
      if (S.updating) { schedule(everyMs); return S.view; }
      const v = await up.check();
      if (S.stopped) return v;
      publish(v);
      ctx.log(`check: ${v.status}: ${v.reason}${v.status === 'available' ? (v.canUpdate ? ' (Update offered)' : ` (no button: ${v.why})`) : ''}`);
      showFor(v, force);
      if (v.status === 'off') return v;
      schedule(v.status === 'error' ? (v.retryAt ? Math.max(60000, v.retryAt - Date.now()) : RETRY_MS) : everyMs);
      return v;
    }

    // ---- what a page, the tray or a test asks
    ctx.command('state', async () => ({ ok: true, enabled: ctx.enabled(), off: up.offWhy(), view: S.view, updating: S.updating,
      progress: S.progress, failure: S.failure, posted: S.posted, log: up.logPath }));
    ctx.command('check', async () => {
      if (!ctx.enabled()) return { ok: false, reason: 'update checks are turned off (tray > Features, or Mantle Settings)' };
      const v = await tick(true);
      return { ok: v.status !== 'error', reason: v.reason, view: v };
    });
    ctx.command('show', async () => {
      if (!S.view || S.view.status !== 'available') return { ok: false, reason: S.view ? S.view.reason : 'Mantle has not checked for updates yet' };
      if (!banners) return { ok: false, reason: 'this Mantle has no banner surface' };
      try { ctx.settings.set('laterUntil', 0); } catch (_) { /* the banner shows anyway */ }
      showFor(S.view, true);
      return { ok: true };
    });
    ctx.command('update', async () => startUpdate());

    // ---- start: the restart's other half, then the first check
    const back = up.confirmStart();
    if (back.swept) ctx.log(`removed ${back.swept} sidecar file(s) left by an earlier update`);
    if (back.updated) {
      post({ kind: 'updated', tone: 'ok', title: `Mantle updated to ${back.updated.tag}`, body: `It was on ${short(back.updated.from)}. What happened is in the update log.`,
        detail: `Log: ${back.updated.log || up.logPath}`, actions: [{ id: 'ok', label: 'OK' }] });
      S.updatedT = setTimeout(() => { if (S.posted === 'updated') drop(); }, UPDATED_SHOW_MS);
      if (back.failed) up.clearFailed();
    } else if (back.failed) {
      const f = back.failed;
      post({ kind: 'restart-failed', tone: 'error', title: `The update to ${f.tag} did not start`,
        body: f.restore && f.restore.ran
          ? `Mantle did not come back after updating, so Windows was put back${f.restore.ok ? '' : ' (not confirmed)'}. This Mantle was started again by hand.`
          : 'Mantle did not come back after updating. This Mantle was started again by hand.',
        detail: `To go back to the version before: git reset --keep ${short(f.from)}, then npm install and npm run build:sidecar\nLog: ${f.log || up.logPath}`,
        actions: [{ id: 'ok', label: 'OK' }] });
    }
    const off = up.offWhy();
    publish(off ? { status: 'off', reason: off, release: null } : { status: 'idle', reason: 'Mantle has not checked for updates yet', release: null });
    if (off) ctx.log(`no update checks: ${off}`);
    else if (ctx.enabled()) schedule(firstMs);

    ctx.onEnabled((on) => {
      if (on) { schedule(5000); return; }
      clearTimeout(S.timer); S.timer = null;
      if (!S.updating && (S.posted === 'available' || S.posted === 'manual')) drop();
      publish({ status: 'off', reason: 'update checks are turned off', release: null });
    });

    return {
      stop() {
        S.stopped = true;
        clearTimeout(S.timer); S.timer = null;
        clearTimeout(S.updatedT); S.updatedT = null;
        if (!S.updating) drop();
        try { if (host && typeof host.tray === 'function') host.tray(null); } catch (_) { /* the tray is going too */ }
      },
    };
  },
};
