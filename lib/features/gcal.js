'use strict';
/*
 * gcal.js - Google Calendar in the clock's calendar: live, READ-ONLY (lane mantle-gcal, 2026-10-16).
 *
 * Owen, 10-16 16:45: the clock flyout should "sync with my Google Calendar"; he picked Sign in with Google.
 * The flyout (ui/bar/bar.js buildCalPop + ui/bar/gcal.js) draws a dot under each day with events and the
 * selected day's agenda; Settings > Time & language > Date & time has the Google Calendar group
 * (ui/settings/sections/time.js). This file wires Electron to the engine:
 *   _gcal-core.js    PKCE, consent URL, client file, event rows, errors, backoff (pure)
 *   _gcal-google.js  the only requests (Google's token/revoke endpoints and the Calendar API)
 *   _gcal-auth.js    loopback sign-in in the user's own browser
 *   _gcal-store.js   token + client encrypted with safeStorage (DPAPI), the event cache, in <userData>\gcal
 *   _gcal-sync.js    the background sync, backoff, sign out
 *
 * THE OPEN PATH HAS NO NETWORK AND NO IPC: the bar holds the last 'gcal.events' push (replayed on
 * subscribe) and draws from it. Only AFTER the first frame does it send gcal.opened (refresh if > 2 min old).
 *
 * PRIVACY (https://owen-silva.github.io/mantle/privacy.html): scope calendar.readonly only; data used only
 * for the dots and the day's list; token only on this PC, encrypted by Windows; the cache only on this PC;
 * no servers of Mantle's own, no analytics; traffic only to Google plus opening an event's htmlLink in the
 * user's browser; Sign out revokes at Google and deletes the token AND the cache. Nothing here logs an
 * event title, a calendar name, an address or a token.
 *
 * --test: no request ever leaves the PC. Sign-in, the file picker and opening an event answer a dry run.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('./_gcal-sync');
const { createGoogle } = require('./_gcal-google');
const { createStore } = require('./_gcal-store');
const auth = require('./_gcal-auth');

const TEST_WHY = 'test run: nothing is sent to Google';

/* Where "Choose Google client file…" opens: Owen keeps his at %USERPROFILE%\.secrets\google; else Downloads. */
function clientFolder() {
  const mine = path.join(os.homedir(), '.secrets', 'google');
  try { if (fs.statSync(mine).isDirectory()) return mine; } catch (e) { /* not there */ }
  return path.join(os.homedir(), 'Downloads');
}

const feature = {
  name: 'gcal',
  label: 'Google Calendar in the clock\'s calendar',
  defaultOn: true,
  rest: true,
  install(ctx) {
    const { app, safeStorage, shell, dialog, powerMonitor, net, BrowserWindow } = require('electron');
    const test = !!(ctx.flags && ctx.flags.test);
    const store = createStore({ dir: path.join(app.getPath('userData'), 'gcal'), safeStorage });
    const refuse = () => Promise.reject(Object.assign(new Error(TEST_WHY), { reason: TEST_WHY }));
    const google = test
      ? { exchange: refuse, refresh: refuse, revoke: refuse, calendarList: refuse, events: refuse }
      : createGoogle({ fetch: (u, o) => fetch(u, o) });

    let last = { status: null, events: null };
    const engine = createEngine({
      store, google,
      signIn: (client) => auth.signIn({ client, google, openExternal: (u) => shell.openExternal(u) }),
      choices: () => ctx.settings.get('calendars', {}) || {},
      saveChoices: (v) => ctx.settings.set('calendars', v),
      isOnline: () => (net && typeof net.isOnline === 'function' ? net.isOnline() : true),
      log: (t) => ctx.log(t),
      publish(status, events) {
        last.status = Object.assign({}, status, { enabled: ctx.enabled(), test });
        ctx.broadcast('gcal.status', last.status);
        if (events) { last.events = events; ctx.broadcast('gcal.events', events); }
      },
    });
    ctx.replay('gcal.status', () => last.status || Object.assign(engine.status(), { enabled: ctx.enabled(), test }));
    ctx.replay('gcal.events', () => last.events || engine.eventsPayload());

    let running = false;
    const begin = () => { if (!running && ctx.enabled()) { running = true; engine.start(); } };
    const pause = () => {
      engine.stop(); running = false;
      last.status = Object.assign(engine.status(), { enabled: false, test });
      ctx.broadcast('gcal.status', last.status);
    };

    const onResume = () => { if (running && !test) engine.resume(); };
    powerMonitor.on('resume', onResume);

    ctx.command('status', async () => Object.assign(engine.status(), { enabled: ctx.enabled(), test }));
    ctx.command('signIn', async () => {
      if (test) return { ok: true, dryRun: true, reason: TEST_WHY };
      if (!ctx.enabled()) return { ok: false, reason: 'Google Calendar is turned off in Mantle\'s tray menu' };
      return engine.signIn();
    });
    ctx.command('signOut', async () => {
      if (test) return { ok: true, dryRun: true, reason: TEST_WHY };
      return engine.signOut();
    });
    ctx.command('pickClient', async () => {
      if (test) return { ok: true, dryRun: true, reason: 'test run: no file dialog is opened' };
      const owner = BrowserWindow.getFocusedWindow();
      const opts = { title: 'Choose your Google client file', defaultPath: clientFolder(), properties: ['openFile'],
        filters: [{ name: 'Google client file', extensions: ['json'] }] };
      const r = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true, reason: 'no file was chosen' };
      let text;
      try {
        const st = fs.statSync(r.filePaths[0]);
        if (st.size > 64 * 1024) return { ok: false, reason: 'that file is too big to be a Google client file' };
        text = fs.readFileSync(r.filePaths[0], 'utf8');
      } catch (e) { return { ok: false, reason: 'that file could not be read (' + e.code + ')' }; }
      return engine.setClient(text);
    });
    ctx.command('setCalendar', async (a) => engine.setCalendar(a && a.calendar, !!(a && a.on)));
    ctx.command('opened', async () => (running && !test ? engine.opened() : { ok: true, synced: false }));
    ctx.command('want', async (a) => (running && !test ? engine.want(a && a.year, a && a.month) : { ok: true, covered: false, reason: test ? TEST_WHY : 'Google Calendar is turned off' }));
    ctx.command('open', async (a) => {
      const link = engine.linkOf(a && a.event);
      if (link === undefined) return { ok: false, reason: 'that event is no longer in the calendar' };
      if (!link) return { ok: false, reason: 'Google gave no web page for this event' };
      if (test) return { ok: true, dryRun: true, reason: 'test run: the browser is not opened' };
      try { await shell.openExternal(link); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'your browser could not be opened (' + String(e.message || e).slice(0, 60) + ')' }; }
    });

    ctx.onEnabled((on) => { if (on) begin(); else pause(); });
    begin();
    if (!running) pause();
    ctx.health(true);   // no DPAPI is said by Sign in itself (engine.signIn); the flyout works either way

    return {
      stop() {
        engine.stop(); running = false;
        try { powerMonitor.removeListener('resume', onResume); } catch (e) { /* gone */ }
      },
    };
  },
};

module.exports = feature;
module.exports._clientFolder = clientFolder;
