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
 * A copy installed with Mantle-Setup.exe (app.isPackaged) does check: it compares versions, and its banner
 * is "Mantle v0.2.0 is out" with Download (the release's Mantle-Setup.exe in the browser) and Later, or Open
 * release page when the release has no installer. A link that cannot be opened says why, with the link.
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
 * A RELEASE THAT DID NOT START (lane mantle-failed-release, 2026-10-23): lib/updater.js keeps a record of it
 * past that once. When the check finds the same tag again, the banner warns first ("Mantle v0.3.1 did not
 * start last time", the reason, the version this folder is on) with Try again (the same update) and Skip this
 * version (kept on disk: no banner and no tray row for that tag until a different release is out). A record
 * that cannot be read or saved is this feature's health (tray, Needs attention); a skip that cannot be saved
 * says so on the banner.
 *
 * TEST ONLY: MANTLE_UPDATE_TEST=<json file> { apiBase, owner, repo, cloneUrl, originUrl, firstMs, everyMs,
 * confirmMs, updatedShowMs } points a --test run at a fake release source (a local bare repo, a fake API on
 * 127.0.0.1), so the banner and the button can be driven end to end; updatedShowMs keeps "Mantle updated"
 * up longer, for the e2e's light and dark photos. Ignored, and said, without --test.
 */
const fs = require('fs');
const path = require('path');
const E = require('electron');
const { app } = E;
const U = require('../updater');

const ROOT = path.join(__dirname, '..', '..');
const RETRY_MS = 30 * 60 * 1000;
const LATER_MS = 24 * 60 * 60 * 1000;
const UPDATED_SHOW_MS = 15000;
const KEY = 'updates';
const SETUP_ASSET = 'Mantle-Setup.exe';
/** The banner kinds that offer a release (dropped when it is gone, turned off, or answered OK/close). */
const OFFERS = Object.freeze(['available', 'manual', 'download']);
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u);

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
/** A failure's reason under the title "Mantle was not updated": without saying it twice (the reason starts so,
    for the log and updates.state), and as a sentence unless it starts with a command's name (npm, git). */
function underTitle(reason) {
  const s = String(reason || '').replace(/^Mantle was not updated:\s*/, '');
  return /^(npm|git)\b/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
const pad = (n) => String(n).padStart(2, '0');
/** "2026-10-23 14:05" in local time, for when a record says something happened. */
function stamp(ms) {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) && Number(ms) > 0 ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : 'at a time Mantle did not record';
}
/** A release that did not start last time (view.failedBefore): what happened, and which version this is now. */
function failedBeforeWords(v) {
  const f = v.failedBefore;
  const reason = String(f.reason || 'it did not finish starting after the update').trim().replace(/\.+$/, '');
  const back = f.from && v.head && v.head === f.from
    ? `You are back on the version you had before (${short(f.from)}).`
    : `You are on ${v.head ? `an earlier version (${short(v.head)})` : 'an earlier version'}, which does not have it.`;
  return `Last time, ${reason}. ${back}`;
}
/** The banner for an available release (view.status 'available'). Pure: the tests build it without Mantle. */
function availableBanner(v) {
  const tag = v.release.tag;
  const named = v.release.name && v.release.name !== tag ? `${v.release.name}. ` : '';
  if (v.packaged) {
    // installed with Mantle-Setup.exe: the new installer is the update
    const asset = v.asset || SETUP_ASSET;
    if (v.download) {
      return { kind: 'download', title: `Mantle ${tag} is out`,
        body: `${named}This copy was installed with ${asset}. Download the new installer and run it: it asks Mantle to put Windows back and quit, installs the update and starts Mantle again.`,
        actions: [{ id: 'download', label: 'Download', primary: true }, { id: 'later', label: 'Later' }] };
    }
    const why = String(v.downloadWhy || `the ${tag} release has no ${asset} yet`).replace(/\.+$/, '');
    return { kind: 'download', title: `Mantle ${tag} is out`,
      body: `${named}This copy was installed with ${asset}, but Mantle cannot link the installer because ${why}.${v.page ? ' Open the release page to see the release on GitHub.' : ' To update by hand:'}`,
      ...(v.page ? {} : { detail: v.manual }),
      actions: v.page ? [{ id: 'page', label: 'Open release page', primary: true }, { id: 'later', label: 'Later' }] : [{ id: 'later', label: 'Later' }] };
  }
  if (v.failedBefore) {
    // it did not start last time: warn first, then the two choices
    const f = v.failedBefore;
    const title = `Mantle ${tag} did not start last time`;
    const what = failedBeforeWords(v);
    if (v.canUpdate) {
      return { kind: 'available', tone: 'error', title,
        body: `${what} Try again to install it once more, or skip this version until a newer one is out.`,
        detail: `Tried ${stamp(f.at)}${f.log ? `\nLog: ${f.log}` : ''}`,
        actions: [{ id: 'retry', label: 'Try again', primary: true }, { id: 'skip', label: 'Skip this version' }] };
    }
    return { kind: 'manual', tone: 'error', title,
      body: `${what} There is no Update button because ${v.why}. To try it again by hand:`,
      detail: v.manual, actions: [{ id: 'skip', label: 'Skip this version' }, { id: 'later', label: 'Later' }] };
  }
  // the record could not be read: the offer stands, and it says what it cannot know
  const unread = v.recordUnread ? ' Mantle could not read its record of updates that did not start, so it cannot say if this one failed before.' : '';
  if (v.canUpdate) {
    return { kind: 'available', title: `Mantle ${tag} is out`,
      body: `${named}Update installs it and restarts Mantle by itself. The Windows taskbar stays as it is.${unread}`,
      actions: [{ id: 'update', label: 'Update', primary: true }, { id: 'later', label: 'Later' }] };
  }
  return { kind: 'manual', title: `Mantle ${tag} is out`,
    body: `${named}There is no Update button because ${v.why}.${unread} To update by hand:`,
    detail: v.manual, actions: [{ id: 'later', label: 'Later' }] };
}
/** The banner when "Skip this version" could not be kept (r: lib/updater.js skipRelease's answer). */
function skipFailedBanner(tag, r, logPath) {
  return { kind: 'skip-failed', tone: 'error', title: `Mantle could not skip ${tag}`,
    body: `${r.reason || 'No reason was given'}${/[.]$/.test(r.reason || '') ? '' : '.'} Mantle offers ${tag} again at the next check.`,
    detail: `Log: ${logPath}`, actions: [{ id: 'ok', label: 'OK' }] };
}

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
      // a copy installed with Mantle-Setup.exe has no git clone: it compares versions and links the installer.
      // A --test run's fake source may hand in its own `packaged` ({ version, asset } or null).
      packaged: src && src.packaged !== undefined ? src.packaged : (app.isPackaged ? { version: app.getVersion(), asset: SETUP_ASSET } : null),
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
      else if (view.recordError) ctx.health(false, view.recordError);   // the failed-release record: never quietly
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
    function showFor(v, force) {
      if (S.updating || S.failure) return;
      if (v.status !== 'available' || !v.release) { if (OFFERS.includes(S.posted)) drop(); return; }
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
        post({ kind: 'failed', tone: 'error', title: 'Mantle was not updated', body: underTitle(r.reason),
          detail: `Log: ${r.log || up.logPath}`, actions: [{ id: 'ok', label: 'OK' }] });
      }
      return r;
    }

    /** "Skip this version": kept on disk until a different release is out; a save that fails says so. */
    function skip() {
      const tag = S.view && S.view.release ? S.view.release.tag : null;
      const r = tag ? up.skipRelease(tag) : { ok: false, reason: 'there is no release to skip' };
      if (r.ok) {
        S.posted = null;
        publish(r.view && r.view.status === 'skipped' ? r.view : Object.assign({}, S.view, { status: 'skipped', reason: `Mantle ${tag} is skipped`, recordError: null }));
        ctx.log(`skipped ${tag}: it did not start last time`);
        return { keep: false };
      }
      ctx.log(`"Skip this version" was not kept: ${r.reason}`);
      publish(Object.assign({}, S.view, { recordError: r.reason }));
      post(skipFailedBanner(tag || 'this version', r, up.logPath));
      return { keep: true };
    }

    /** Download / Open release page (a copy installed with Mantle-Setup.exe): the browser opens the link. */
    async function openLink(action) {
      const v = S.view || {};
      const tag = v.release ? v.release.tag : 'the new version';
      const url = action === 'download' ? v.download : v.page;
      let reason = null;
      if (!isHttps(url)) reason = `the ${action === 'download' ? 'installer' : 'release page'} link is ${url ? 'not an https link' : 'missing'}`;
      else {
        try {
          if (!E.shell || typeof E.shell.openExternal !== 'function') reason = 'this Mantle cannot open links in the browser';
          else await E.shell.openExternal(url);
        } catch (err) { reason = `Windows could not open the link (${(err && err.message) || 'no reason given'})`; }
      }
      if (!reason) { ctx.log(`opened ${url} for ${tag}`); return onAction('later'); }
      ctx.log(`the ${action === 'download' ? 'download' : 'release page'} for ${tag} was not opened: ${reason}`);
      post({ kind: 'link-failed', tone: 'error', title: `Mantle could not open the ${action === 'download' ? 'download' : 'release page'} for ${tag}`,
        body: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Open the link below in a browser yourself.`,
        detail: url ? String(url) : (v.manual || null), actions: [{ id: 'ok', label: 'OK' }] });
      return { keep: true };
    }

    async function onAction(action) {
      if (action === 'update' || action === 'retry') { startUpdate().catch((err) => ctx.log(`update failed: ${err.message}`)); return { keep: true }; }
      if (action === 'skip') return skip();
      if (action === 'download' || action === 'page') return openLink(action);
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
        if (OFFERS.includes(S.posted)) return onAction('later');
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
      // a test run may keep it up longer (updatedShowMs), so its light and dark photos are both of the card
      S.updatedT = setTimeout(() => { if (S.posted === 'updated') drop(); }, src && Number(src.updatedShowMs) > 0 ? Number(src.updatedShowMs) : UPDATED_SHOW_MS);
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
    if (back.record) {
      if (!back.record.ok) ctx.log(`the record of the update that did not start: ${back.record.reason}`);
      else if (back.record.cleared) ctx.log('the release that did not start before has started now: its record is gone');
      else if (back.record.rec && !back.record.already) ctx.log(`kept the record that ${back.record.rec.tag} did not start: the next check warns before offering it`);
    }
    const off = up.offWhy();
    publish(off ? { status: 'off', reason: off, release: null } : { status: 'idle', reason: 'Mantle has not checked for updates yet', release: null, recordError: up.recordError });
    if (off) ctx.log(`no update checks: ${off}`);
    else if (ctx.enabled()) schedule(firstMs);

    ctx.onEnabled((on) => {
      if (on) { schedule(5000); return; }
      clearTimeout(S.timer); S.timer = null;
      if (!S.updating && OFFERS.includes(S.posted)) drop();
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
  // pure, for lib/features/updates.test.js
  availableBanner, failedBeforeWords, skipFailedBanner, stamp,
};
