'use strict';
/*
 * lib/features/updates.test.js -- the updates feature's side of "a release that did not start" (lane
 * mantle-failed-release, 2026-10-23): the warning banner's words and choices, Try again, Skip this version
 * (and a skip that cannot be saved), and a record that cannot be read showing as the feature's health.
 * lib/updater.js is replaced by a fake here (its own tests are lib/updater.test.js); electron by a stub.
 * Nothing touches git, the network, or a window.
 *
 *   node lib/features/updates.test.js   -> "UPDATES FEATURE TEST: n passed, m failed"
 */
const os = require('os');
const Module = require('module');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ` -- ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''));
  return ok;
}
const tick = () => new Promise((r) => setImmediate(r));

const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return realLoad.apply(this, arguments);
};
const F = require('./updates');
const U = require('../updater');
Module._load = realLoad;

const FROM = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const failedBefore = { tag: 'v0.3.1', sha: 'f'.repeat(40), from: FROM, at: new Date(2026, 9, 23, 14, 5).getTime(), reason: 'it did not finish starting within 3 minutes', log: 'D:\\data\\update.log', skipped: false };
const release = { tag: 'v0.3.1', name: 'Mantle v0.3.1' };
const warnView = () => ({ status: 'available', release, head: FROM, canUpdate: true, why: null, manual: 'git fetch ...', failedBefore, recordError: null, recordUnread: false, reason: 'Mantle v0.3.1 is out; it did not start last time' });

// ---------------------------------------------------------------- the words (pure)
{
  check('stamp: local date and time, minutes', F.stamp(new Date(2026, 9, 23, 14, 5).getTime()) === '2026-10-23 14:05', F.stamp(new Date(2026, 9, 23, 14, 5).getTime()));
  check('stamp: no time recorded says so', F.stamp(undefined) === 'at a time Mantle did not record' && F.stamp(0) === 'at a time Mantle did not record');
  const b = F.availableBanner(warnView());
  check('warning banner: the title says this version did not start last time', b.title === 'Mantle v0.3.1 did not start last time' && b.kind === 'available', b);
  check('warning banner: the reason, and that the user is back on the version from before (its short commit)',
    b.body.startsWith('Last time, it did not finish starting within 3 minutes. You are back on the version you had before (a1b2c3d).'), b.body);
  check('warning banner: what to do, in one plain sentence', /Try again to install it once more, or skip this version until a newer one is out\.$/.test(b.body), b.body);
  check('warning banner: two choices, Try again (primary) and Skip this version, no Update/Later', b.actions.length === 2 && b.actions[0].id === 'retry' && b.actions[0].label === 'Try again' && b.actions[0].primary === true &&
    b.actions[1].id === 'skip' && b.actions[1].label === 'Skip this version' && !b.actions[1].primary, b.actions);
  check('warning banner: the error tone of "did not start" banners, when it was tried, and the log', b.tone === 'error' && b.detail === 'Tried 2026-10-23 14:05\nLog: D:\\data\\update.log', b);
  const other = F.availableBanner(Object.assign(warnView(), { head: '9'.repeat(40) }));
  check('warning banner on another earlier commit: says which, without claiming it is the one from before', /You are on an earlier version \(9999999\), which does not have it\./.test(other.body) && !/back on/.test(other.body), other.body);
  const m = F.availableBanner(Object.assign(warnView(), { canUpdate: false, why: 'it is on branch dev, not master', manual: 'cd x\ngit merge --ff-only v0.3.1' }));
  check('warning banner, no Update button: the reason, why there is no button, the commands, Skip this version and Later',
    m.kind === 'manual' && m.title === 'Mantle v0.3.1 did not start last time' && /^Last time, .* There is no Update button because it is on branch dev, not master\. To try it again by hand:$/.test(m.body) &&
    m.detail === 'cd x\ngit merge --ff-only v0.3.1' && m.actions.map((a) => a.id).join() === 'skip,later', m);
  const plain = F.availableBanner(Object.assign(warnView(), { failedBefore: null }));
  check('no record: the usual banner, unchanged (Update and Later, info tone)', plain.title === 'Mantle v0.3.1 is out' && !plain.tone && plain.actions.map((a) => a.id).join() === 'update,later' &&
    plain.body === 'Mantle v0.3.1. Update installs it and restarts Mantle by itself. The Windows taskbar stays as it is.', plain);
  const unread = F.availableBanner(Object.assign(warnView(), { failedBefore: null, recordUnread: true }));
  check('a record that could not be read: the offer stands, and the banner says what Mantle cannot know', /Mantle could not read its record of updates that did not start, so it cannot say if this one failed before\.$/.test(unread.body) &&
    unread.actions.map((a) => a.id).join() === 'update,later', unread.body);
  const s = F.skipFailedBanner('v0.3.1', { ok: false, reason: 'Mantle could not save its record of the update that did not start (D:\\data\\update-failed-release.json): EPERM.' }, 'D:\\data\\update.log');
  check('skip not saved: the title, the reason, what happens next, the log, OK', s.kind === 'skip-failed' && s.tone === 'error' && s.title === 'Mantle could not skip v0.3.1' &&
    s.body === 'Mantle could not save its record of the update that did not start (D:\\data\\update-failed-release.json): EPERM. Mantle offers v0.3.1 again at the next check.' &&
    s.detail === 'Log: D:\\data\\update.log' && s.actions.map((a) => a.id).join() === 'ok', s);
}

// ---------------------------------------------------------------- the feature, with a fake updater
function harness(o) {
  const H = { posted: [], drops: 0, health: [], trays: [], cmds: {}, settings: new Map(), logs: [], cur: null };
  const fake = H.up = {
    view: null, skipAnswer: null, skipped: [], applied: 0, recordError: (o && o.recordError) || null,
    offWhy: () => null,
    confirmStart: () => ({ swept: 0, updated: null, failed: null, record: (o && o.startRecord) || null }),
    check: async () => fake.view,
    skipRelease: (tag) => { fake.skipped.push(tag); return fake.skipAnswer; },
    apply: async () => { fake.applied++; return { ok: true, restarting: true }; },
    clearFailed: () => true, logPath: 'D:\\data\\update.log', files: { release: 'D:\\data\\update-failed-release.json' },
  };
  const ctx = {
    flags: { test: true },
    host: {
      ownBanners: { post: (key, b, onAction) => { H.posted.push(b); H.cur = { b, onAction }; return H.posted.length; }, drop: () => { H.drops++; H.cur = null; } },
      updates: { tray: (label) => H.trays.push(label), restart: async () => ({ ok: false, reason: 'the fake never restarts' }) },
    },
    settings: { get: (k, d) => (H.settings.has(k) ? H.settings.get(k) : d), set: (k, v) => H.settings.set(k, v) },
    log: (l) => H.logs.push(l),
    health: (ok, why) => H.health.push({ ok, why: why || null }),
    command: (name, fn) => { H.cmds[name] = fn; },
    enabled: () => true,
    onEnabled: () => {},
  };
  const real = U.createUpdater;
  U.createUpdater = () => fake;
  try { H.inst = F.install(ctx); } finally { U.createUpdater = real; }
  H.lastHealth = () => H.health[H.health.length - 1];
  H.lastTray = () => H.trays[H.trays.length - 1];
  return H;
}

async function main() {
  {
    // a record fault found at start (confirmStart could not keep the record) is the feature's health at once
    const H = harness({ startRecord: { ok: false, reason: 'Mantle could not save its record of the update that did not start (D:\\x): EPERM.' }, recordError: 'Mantle could not save its record of the update that did not start (D:\\x): EPERM.' });
    check('start: a record that could not be saved shows as the feature\'s health, with its reason', H.lastHealth().ok === false && /could not save its record/.test(H.lastHealth().why), H.health);
    check('start: ...and the log says it', H.logs.some((l) => /the record of the update that did not start: Mantle could not save/.test(l)), H.logs);
    H.inst.stop();
  }
  {
    const H = harness();
    H.up.view = warnView();
    const r = await H.cmds.check();
    check('check: the warning banner is posted for the release that did not start', r.ok && H.cur && H.cur.b.title === 'Mantle v0.3.1 did not start last time' && H.cur.b.actions.map((a) => a.id).join() === 'retry,skip', H.cur && H.cur.b);
    check('check: the tray keeps its "Update Mantle to v0.3.1…" row, health fine', H.lastTray() === 'Update Mantle to v0.3.1…' && H.lastHealth().ok === true, { tray: H.lastTray(), health: H.lastHealth() });
    // the X is not a choice to skip: it is Later, as for every offer
    const closed = await H.cur.onAction('close');
    check('the X on the warning: Later (hidden for a day), NOT a skip', closed.keep === false && H.settings.get('laterTag') === 'v0.3.1' && H.up.skipped.length === 0, { closed, skipped: H.up.skipped });
    H.settings.set('laterUntil', 0);
    await H.cmds.check();
    // Skip this version, saved
    H.up.skipAnswer = { ok: true, view: Object.assign(warnView(), { status: 'skipped', canUpdate: false, reason: 'Mantle v0.3.1 is skipped because it did not start last time. Mantle offers the next newer version.' }) };
    const sk = await H.cur.onAction('skip');
    check('Skip this version: the updater keeps it for that tag, the banner goes', sk.keep === false && H.up.skipped.join() === 'v0.3.1', { sk, skipped: H.up.skipped });
    check('...the tray row goes and the health stays fine', H.lastTray() === null && H.lastHealth().ok === true, { trays: H.trays, health: H.lastHealth() });
    const st = await H.cmds.state();
    check('...updates.state says skipped', st.view && st.view.status === 'skipped', st.view);
    // the next check answers "skipped": nothing posted
    const n = H.posted.length;
    H.up.view = H.up.skipAnswer.view;
    await H.cmds.check();
    check('a check that answers "skipped" posts nothing and offers no tray row', H.posted.length === n && H.lastTray() === null, { posted: H.posted.length - n, tray: H.lastTray() });
    // Skip that cannot be saved
    H.up.view = warnView();
    await H.cmds.check();
    H.up.skipAnswer = { ok: false, reason: 'Mantle could not save its record of the update that did not start (D:\\data\\update-failed-release.json): EPERM.', why: 'EPERM' };
    const sk2 = await H.cur.onAction('skip');
    check('a skip that cannot be saved: a banner says so, with the reason and what happens next', sk2.keep === true && H.cur.b.kind === 'skip-failed' && H.cur.b.title === 'Mantle could not skip v0.3.1' &&
      /EPERM\. Mantle offers v0\.3\.1 again at the next check\.$/.test(H.cur.b.body), H.cur.b);
    check('...and it is the feature\'s health (tray, Needs attention) with the same reason', H.lastHealth().ok === false && /could not save its record/.test(H.lastHealth().why), H.lastHealth());
    const ok = await H.cur.onAction('ok');
    check('...OK takes that banner down', ok.keep === false && (await H.cmds.state()).posted === null, ok);
    // a record that could not be read: health, and the offer still stands
    H.up.view = Object.assign(warnView(), { failedBefore: null, recordUnread: true, recordError: 'Mantle could not read its record of the update that did not start (D:\\data\\update-failed-release.json): it is not valid JSON (x). Delete that file to start a new record.' });
    await H.cmds.check();
    check('an unreadable record: the usual offer, with the sentence about what Mantle cannot know', H.cur.b.title === 'Mantle v0.3.1 is out' && /cannot say if this one failed before/.test(H.cur.b.body), H.cur.b);
    check('...and the health says the record could not be read, where, and what to do', H.lastHealth().ok === false && /could not read its record/.test(H.lastHealth().why) && /Delete that file/.test(H.lastHealth().why), H.lastHealth());
    H.inst.stop();
  }
  {
    // Try again = the same update
    const H = harness();
    H.up.view = warnView();
    await H.cmds.check();
    const r = await H.cur.onAction('retry');
    await tick(); await tick();
    check('Try again runs the update (apply), and the banner turns into its progress', r.keep === true && H.up.applied === 1 && H.posted.some((b) => b.kind === 'progress' && b.title === 'Updating Mantle to v0.3.1'), { r, applied: H.up.applied, kinds: H.posted.map((b) => b.kind) });
    H.inst.stop();
  }
}

main().catch((err) => { failures.push(`threw: ${err && err.stack ? err.stack : err}`); }).finally(() => {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`UPDATES FEATURE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
});
