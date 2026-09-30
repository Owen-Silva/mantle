'use strict';
/* open-route.test.js - the bar's Settings links open MANTLE Settings (lane barfiles, 2026-09-29).
   Plain node; nothing is opened: the real launcher-index launch() runs against a fake Electron app
   whose 'mantle-open' listener answers like lib/features/settings.js, and every path that would
   reach Windows is either a dry run or a fake.   node lib/open-route.test.js */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const R = require('./open-route');
const L = require('./launcher-index');

let passed = 0, failed = 0;
function ok(cond, label, detail) { if (cond) passed++; else { failed++; console.log('  FAIL: ' + label + (detail !== undefined ? ' -- ' + detail : '')); } }

(async () => {
  // 1. the mapping
  ok(R.settingsItem('ms-settings:').path === 'mantle:settings', 'the gear (root ms-settings:) -> Mantle Settings Home');
  ok(R.settingsItem('ms-settings://').path === 'mantle:settings', 'root with slashes -> Home too');
  ok(R.settingsItem('ms-availablenetworks:').path === 'ms-settings:network-wifi', 'ms-availablenetworks: -> the Wi-Fi page');
  ok(R.settingsItem('ms-settings:batterysaver').path === 'ms-settings:batterysaver' && R.settingsItem('MS-SETTINGS:sound').kind === 'setting', 'any ms-settings: page is a setting row, any case');
  ok(R.settingsItem('https://example.com') === null && R.settingsItem('C:\\x') === null && R.settingsItem(null) === null, 'anything else is not a Settings link');

  // 2. every link the bar sends, through the REAL launch(): Mantle's page, the right section
  const seen = [];
  const app = new EventEmitter();
  app.on('mantle-open', (what, o) => { if (what === 'settings' && o && o.reply) { seen.push({ section: o.section, page: o.page, uri: o.uri, via: o.via }); o.reply.handled = true; o.reply.ok = true; } });
  const was = L._setElectronForTest({ app });
  const opened = [];
  const deps = { launch: L.launch, openTarget: async (t) => { opened.push(t); return { ok: true }; }, dryRun: false };
  const bar = [];
  for (const f of ['bar.js', 'bt.js', 'qs-more.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'bar', f), 'utf8');
    for (const m of src.match(/'ms-(?:settings|availablenetworks):[a-z0-9-]*'/g) || []) bar.push(m.slice(1, -1));
  }
  const uris = Array.from(new Set(bar));
  ok(uris.length >= 8, 'the bar\'s own Settings links were found in its source (' + uris.length + ')');
  for (const u of uris) {
    seen.length = 0;
    const r = await R.openRouted(u, deps);
    const covered = u === 'ms-settings:' || !!seen.length;
    if (seen.length) ok(r.ok && !r.fellBack && seen[0].via === 'the launcher', u + ' -> Mantle Settings (' + seen[0].section + '/' + seen[0].page + ')', JSON.stringify(r));
    else ok(!covered, u + ' is not claimed by any Mantle Settings section (it would open Windows\' page)', JSON.stringify(r));
  }
  ok(opened.length === 0, 'no bar Settings link reached openTarget (Windows) while Mantle Settings answered', opened.join(', '));
  seen.length = 0;
  await R.openRouted('ms-settings:', deps);
  ok(seen.length === 1 && seen[0].section === null && seen[0].uri === 'ms-settings:', 'the gear opens Mantle Settings at Home', JSON.stringify(seen));
  seen.length = 0;
  await R.openRouted('ms-settings:batterysaver', deps);
  ok(seen.length === 1 && seen[0].section === 'system' && seen[0].page === 'power', 'Energy saver opens System > Power', JSON.stringify(seen));
  seen.length = 0;
  await R.openRouted('ms-availablenetworks:', deps);
  ok(seen.length === 1 && seen[0].section === 'internet' && seen[0].page === 'wifi', 'ms-availablenetworks: opens Internet > Wi-Fi', JSON.stringify(seen));

  // 3. a page no section claims: the real launch() as a DRY run says it would open Windows' page
  const dry = await R.openRouted('ms-settings:zz-no-such-page', Object.assign({}, deps, { dryRun: true }));
  ok(dry.ok && /dry run/.test(dry.reason) && !/Mantle Settings/.test(dry.reason), 'an unclaimed page is Windows\' own (dry run)', JSON.stringify(dry));
  L._setElectronForTest(was);

  // 4. Mantle Settings off / resting: launch() opened Windows' page -> fellBack carries the reason
  const fb = await R.openRouted('ms-settings:bluetooth', { launch: async () => ({ ok: true, reason: 'opened Windows Settings: Mantle Settings is resting while VALORANT runs' }), openTarget: async () => ({ ok: true }) });
  ok(fb.ok && fb.fellBack === 'Mantle Settings is resting while VALORANT runs' && fb.routed === 'ms-settings:bluetooth', 'a fallback says why (the bar shows fellBack)', JSON.stringify(fb));
  const plain = await R.openRouted('ms-settings:sound', { launch: async () => ({ ok: true }), openTarget: async () => ({ ok: true }) });
  ok(plain.ok && !plain.fellBack, 'a clean open has no fellBack');
  const threw = await R.openRouted('ms-settings:sound', { launch: async () => { throw new Error('boom'); } });
  ok(threw.ok === false && /boom/.test(threw.reason), 'a throwing launch is a reason, never a rejection', JSON.stringify(threw));
  const refused = await R.openRouted('ms-settings:sound', { launch: async () => ({ ok: false, reason: 'no' }) });
  ok(refused.ok === false && refused.reason === 'no', 'a refusal passes through with its reason');

  // 5. anything else still goes to openTarget unchanged
  const other = [];
  const o = await R.openRouted('https://example.com', { launch: async () => { throw new Error('must not launch'); }, openTarget: async (t) => { other.push(t); return { ok: true, via: 'openTarget' }; } });
  ok(o.via === 'openTarget' && other[0] === 'https://example.com', 'a URL or a path goes to openTarget as before');

  // 6. main.js routes 'open' through it (source check: the wiring is one line)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // main.js now checks the target first (openTargetVerdict), then routes: the handler body must still end in openRouted.
  const openBody = (/'open': async \(a\) => (?:\{[\s\S]*?\n  \},|[^\n]*)/.exec(main) || [''])[0];
  ok(/openRouted\(/.test(openBody), 'main.js \'open\' goes through openRouted');

  console.log('OPEN ROUTE TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
