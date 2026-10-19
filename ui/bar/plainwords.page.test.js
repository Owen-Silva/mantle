require('../../tools/dev-env.js').lowcpu();
/* plainwords.page.test.js - a raw error code never reaches the bar's rendered text
 * (lane mn-plainwords-bar, 2026-10-12; Owen's bar: "plain words, no raw codes", and still no
 * silent failures).
 *
 * WHAT: the real index.html + bar.js + qs-more.js on the mock bridge (page-harness.js, headless
 * Chromium over file://). Every channel the quick-settings panel and its three '>' views read is
 * answered with a failure worded EXACTLY the way the sidecar words it (AudioMixer.cs, Display.cs,
 * Bluetooth.cs, Network.cs, Battery.cs: "... could not be read (COMException: ... (0x88890004))"):
 *   qs.get              volume, wifi, bluetooth, brightness, nightlight and power all ok:false
 *   battery.get         the footer's power line (GetSystemPowerStatus, Win32 error 5)
 *   qs.wifi.list        the Wi-Fi '>' view
 *   qs.bt.list          the Bluetooth '>' view
 *   qs.audio.devices    the sound '>' view: playback devices
 *   qs.audio.sessions   the sound '>' view: the mixer
 * Two runs, each in the light and the dark theme:
 *   RAW    the replies as the sidecar words them. The CONTROL: the codes must be seen on screen,
 *          or the PLAIN run below proves nothing.
 *   PLAIN  the same replies passed through lib/plain-error.js toPage(channel, reply) in node first,
 *          which is what main.js does to every reply, push and replay before it crosses to a page.
 *          No code may remain in the rendered text (innerText of the whole bar document, every
 *          view) nor in a tooltip / aria-label, and the plain words must be there instead.
 * The RAW text is also run through the PLAIN assertions and must FAIL them (not vacuous).
 *
 *   node ui/bar/plainwords.page.test.js
 *   PLAINWORDS_KNOWN_GAPS=0 node ui/bar/plainwords.page.test.js   leaves out the .NET Framework wordings
 *       (see GAPS below; toPage cleans them since 10-14, so they are in by default)
 * Prints "BAR PLAINWORDS PAGE TEST: n passed, m failed".
 */
'use strict';
const H = require('./page-harness.js');
const { toPage } = require('../../lib/plain-error');
const t = H.suite('BAR PLAINWORDS PAGE TEST');

/* ---- the replies, as the sidecar words them ---------------------------------------------------- */
const REASON = {
  // AudioMixer.cs / Volume.cs: "... could not be read (" + ex.GetType().Name + ": " + ex.Message + ")"
  volume: 'the volume could not be read (COMException: The device was unplugged or changed. (0x88890004))',
  // Network.cs: "the Wi-Fi state could not be read (" + ex.Message + ")" - a WinRT COMException's message
  wifi: 'the Wi-Fi state could not be read (The device is not ready. (Exception from HRESULT: 0x80070015))',
  // Bluetooth.cs: "the in-process Bluetooth API failed (" + ex.GetType().Name + ": " + ex.Message + ")"
  bluetooth: 'the in-process Bluetooth API failed (COMException: Error HRESULT E_FAIL has been returned from a call to a COM component.)',
  // Display.cs: "the brightness could not be read (" + ex.GetType().Name + ": " + ex.Message + ")"
  brightness: 'the brightness could not be read (ManagementException: Not supported )',
  // Display.cs night light: "(" + ex.Message + ")"; a busy settings file, said by Node's errno
  nightlight: 'the night light state could not be read (EBUSY: resource busy or locked, open)',
  // Battery.cs
  power: 'Windows would not report the power status (GetSystemPowerStatus failed, Win32 error 5)',
  // AudioMixer.cs lines 296 and 468
  devices: 'the playback devices could not be read (COMException: The device was unplugged or changed. (0x88890004))',
  sessions: 'the app volumes could not be read (UnauthorizedAccessException: Access to the audio session is denied. (0x80070005))',
  // Bluetooth.cs line 257, the paired-device list
  btlist: 'the in-process Bluetooth API failed (COMException: The RPC server is unavailable. (0x800706BA))',
  // NetWifi.cs / Wlan.cs
  wifilist: 'the Wi-Fi networks could not be read (Win32Exception: The group or resource is not in the correct state to perform the requested operation (5023))'
};

/* GAPS: real .NET Framework wordings that toPage once left part of a code in (found 2026-10-12, fixed
   2026-10-14). In by default; PLAINWORDS_KNOWN_GAPS=0 leaves them out. */
const GAPS = process.env.PLAINWORDS_KNOWN_GAPS !== '0';
if (GAPS) {
  REASON.wifi = 'the Wi-Fi state could not be read (Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED)))';
  REASON.wifilist = 'the Wi-Fi networks could not be read (UnauthorizedAccessException: Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED)))';
}

function rawReplies() {
  const R = REASON;
  const qs = {
    volume:     { ok: false, level: null, muted: false, reason: R.volume },
    wifi:       { ok: false, present: true, on: null, connected: false, ssid: null, signal: 0, band: null, reason: R.wifi },
    bluetooth:  { ok: false, present: true, on: false, via: '', reason: R.bluetooth },
    brightness: { ok: false, present: false, level: null, reason: R.brightness },
    nightlight: { ok: false, present: true, on: false, reason: R.nightlight },
    power:      { ok: false, reason: R.power }
  };
  // main.js qsCompose: the whole snapshot's reason is every dead part's reason, joined
  qs.ok = false;
  qs.reason = Object.keys(qs).filter((k) => qs[k] && qs[k].reason).map((k) => qs[k].reason).join('; ');
  return {
    'qs.get': qs,
    // the same picture as main's watch pushes it while the panel is open (broadcast('qs', qsCompose));
    // toPage's where-name for it is main's own: 'push qs'
    'push qs': JSON.parse(JSON.stringify(qs)),
    'battery.get': { ok: false, reason: R.power },
    'qs.wifi.list': { ok: false, present: true, on: true, networks: [], reason: R.wifilist },
    'qs.bt.list': { ok: false, present: true, on: true, devices: [], reason: R.btlist },
    'qs.audio.devices': { ok: false, devices: [], defaultId: null, readMs: 4, reason: R.devices },
    'qs.audio.sessions': { ok: false, sessions: [], reason: R.sessions }
  };
}

/* what main.js does to each reply before the page gets it (mantle:call -> toPage(name, result)) */
function plainReplies() {
  const raw = rawReplies();
  const out = {};
  for (const ch of Object.keys(raw)) out[ch] = toPage(ch, raw[ch]);
  return out;
}

/* The page's reply hook: our answers for the failing channels; the watches answered ok so the
   mock's own pushes never overwrite the failure; everything else falls through to the mock. */
function replySource(replies) {
  const calls = Object.assign({}, replies); delete calls['push qs'];
  return '(function () { var R = ' + JSON.stringify(calls) + ';' +
    ' return function (ch, p) {' +
    '  if (Object.prototype.hasOwnProperty.call(R, ch)) return JSON.parse(JSON.stringify(R[ch]));' +
    '  if (ch === "qs.watch" || ch === "qs.bt.watch") return { ok: true };' +
    '  return undefined; }; })()';
}

/* ---- the assertions --------------------------------------------------------------------------- */
const CODE = [
  ['a hex code (0x........)', /0x[0-9a-f]{8}/i],
  ['an exception name', /exception/i],
  ['the word HRESULT', /hresult/i],
  ['a bare number in brackets, like (5)', /\(\d+\)/],
  ['the word win32', /win32/i],
  ['an upper-case errno, like EBUSY', /\bE[A-Z]{3,}\b/]
];
function codesIn(text) { return CODE.filter(([, re]) => re.test(text)).map(([name, re]) => name + ': "' + snippet(text, re) + '"'); }
function snippet(text, re) {
  const m = re.exec(text); if (!m) return '';
  const a = Math.max(0, m.index - 70), b = Math.min(text.length, m.index + m[0].length + 30);
  return text.slice(a, b).replace(/\s+/g, ' ');
}

/* the words each plain reply must leave on screen (no silent failure): taken from toPage itself,
   so the test follows the module's wording rather than retyping it */
function plainPhrase(s) { const m = /\(([^()]*)\)\s*$/.exec(s); return m ? m[1].trim() : s; }

/* Everything a user can read on the page: the rendered text of the whole document, and every
   tooltip and aria-label (a hover is still "on screen"). */
function readAll(pg) {
  return pg.eval(() => {
    const text = document.body.innerText || '';
    const tips = [];
    document.querySelectorAll('[title], [aria-label]').forEach((e) => {
      if (e.title) tips.push(e.title);
      const a = e.getAttribute('aria-label'); if (a) tips.push(a);
    });
    return { text, tips: tips.join('\n') };
  });
}

const W = { w: 1280, h: 900 };

async function visit(open, replies, theme) {
  const pg = await open('?mode=pill', Object.assign({ reply: replySource(replies) }, W));
  await pg.eval((th) => {
    document.documentElement.dataset.theme = th;
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: th } }));
  }, theme);
  const seen = {};
  await pg.click('#network', { wait: 700 });
  seen.panelOpen = await pg.eval(() => !document.getElementById('pop').hidden);
  /* main's qs.get answers ok:false when volume or power is dead (qsCompose), and the bar's callR
     turns that into a rejected read; the parts then land through the watch's push, as live. */
  await pg.emit('qs', replies['push qs']);
  await pg.wait(400);
  seen.panel = await readAll(pg);
  seen.notes = await pg.eval(() => Array.from(document.querySelectorAll('#pop .note')).map((n) => n.textContent));

  const views = [
    ['wifi', '.qsx-split .qsx-chev[title="Show Wi-Fi networks"], .qsx-chev[aria-label="Show Wi-Fi networks"]'],
    ['bt', '.qsx-chev[title="Show Bluetooth devices"], .qsx-chev[aria-label="Show Bluetooth devices"]'],
    ['sound', '.qsx-more']
  ];
  for (const [name, sel] of views) {
    const there = await pg.count(sel);
    if (!there) { seen[name] = null; continue; }
    await pg.click(sel, { wait: 1300 });
    seen[name] = await readAll(pg);
    seen[name].states = await pg.eval(() => Array.from(document.querySelectorAll('#pop .qsx-statewhy, #pop .qsx-errwhy')).map((n) => n.textContent));
    if (await pg.count('.qsx-back')) await pg.click('.qsx-back', { wait: 500 });
  }
  seen.theme = await pg.eval(() => document.documentElement.dataset.theme);
  seen.errors = pg.errors.filter((e) => !/favicon/i.test(e));
  await pg.close();
  return seen;
}

function everything(seen) {
  return ['panel', 'wifi', 'bt', 'sound'].filter((k) => seen[k]).map((k) => seen[k].text + '\n' + seen[k].tips).join('\n');
}

async function run() {
  if (H.gaming()) { console.log('a game is running: the browser half is skipped'); t.check('not skipped (a game was running)', false); return; }
  const raw = rawReplies();
  const plain = plainReplies();
  if (GAPS) console.log('GAPS in: the .NET "(Exception from HRESULT: ... (E_...))" wordings are in');

  // node-side sanity: toPage really changed every reason, and nothing it gave back still has a code
  for (const ch of Object.keys(raw)) {
    const before = JSON.stringify(raw[ch]), after = JSON.stringify(plain[ch]);
    t.check(`toPage changed the ${ch} reply`, before !== after);
  }

  // the words toPage chose, per reason, that must be on screen in the PLAIN run
  const want = {
    'Volume note (qs.get volume)': plainPhrase(plain['qs.get'].volume.reason),
    'Wi-Fi note (qs.get wifi)': plainPhrase(plain['qs.get'].wifi.reason),
    'Bluetooth note (qs.get bluetooth)': plainPhrase(plain['qs.get'].bluetooth.reason),
    'Brightness note (qs.get brightness)': plainPhrase(plain['qs.get'].brightness.reason),
    'Night light note (qs.get nightlight)': plainPhrase(plain['qs.get'].nightlight.reason)
  };
  const wantView = {
    wifi: plainPhrase(plain['qs.wifi.list'].reason),
    sound: plainPhrase(plain['qs.audio.devices'].reason)
  };
  console.log('plain words expected on screen:', JSON.stringify(Object.assign({}, want, { 'Wi-Fi view': wantView.wifi, 'Sound view': wantView.sound })));

  await H.withBrowser(async (open) => {
    for (const theme of ['light', 'dark']) {
      const R = await visit(open, raw, theme);
      const P = await visit(open, plain, theme);
      const tag = `[${theme}]`;
      t.check(`${tag} the theme took`, R.theme === theme && P.theme === theme, [R.theme, P.theme]);
      t.check(`${tag} quick settings opens (RAW and PLAIN)`, R.panelOpen && P.panelOpen);
      t.check(`${tag} the page threw nothing`, !R.errors.length && !P.errors.length, R.errors.concat(P.errors));
      for (const v of ['wifi', 'bt', 'sound'])
        t.check(`${tag} the ${v} '>' view opened`, !!R[v] && !!P[v]);

      // ---- RAW: the control. The codes are visible, so the test can see them.
      const rawAll = everything(R);
      t.check(`${tag} RAW control: the panel's notes show the exception name (COMException)`, /COMException/.test(R.panel.text), R.notes);
      t.check(`${tag} RAW control: a hex code is on screen`, /0x[0-9a-f]{8}/i.test(rawAll));
      t.check(`${tag} RAW control: the errno EBUSY is on screen`, /\bEBUSY\b/.test(rawAll));
      t.check(`${tag} RAW control: the sound view shows the exception name`, !!R.sound && /Exception/.test(R.sound.text), R.sound && R.sound.states);
      t.check(`${tag} RAW control: the Wi-Fi view shows the exception name`, !!R.wifi && /Exception/.test(R.wifi.text), R.wifi && R.wifi.states);
      const rawHits = codesIn(rawAll);
      t.check(`${tag} RAW control FAILS the PLAIN assertions (the test is not vacuous)`, rawHits.length >= 4, rawHits);

      // ---- PLAIN: no code anywhere the user can read
      for (const k of ['panel', 'wifi', 'bt', 'sound']) {
        if (!P[k]) continue;
        const hitsText = codesIn(P[k].text);
        t.check(`${tag} PLAIN ${k}: no raw code in the rendered text`, !hitsText.length, hitsText);
        const hitsTips = codesIn(P[k].tips);
        t.check(`${tag} PLAIN ${k}: no raw code in a tooltip or aria-label`, !hitsTips.length, hitsTips);
      }
      // ---- PLAIN: and the plain words are there instead (no silent failure)
      for (const [name, words] of Object.entries(want))
        t.check(`${tag} PLAIN: ${name} says "${words}"`, P.panel.text.indexOf(words) >= 0, P.notes);
      t.check(`${tag} PLAIN: the Wi-Fi view says "${wantView.wifi}"`, !!P.wifi && P.wifi.text.indexOf(wantView.wifi) >= 0, P.wifi && P.wifi.states);
      t.check(`${tag} PLAIN: the sound view says "${wantView.sound}"`, !!P.sound && P.sound.text.indexOf(wantView.sound) >= 0, P.sound && P.sound.states);
      t.check(`${tag} PLAIN: every dead part still has a note (one per part, none blank)`,
        P.notes.length >= 5 && P.notes.every((n) => n && n.trim().length > 10), P.notes);
      if (theme === 'light') {
        console.log('  RAW codes the PLAIN assertions catch:', JSON.stringify(rawHits.map((h) => h.split(':')[0])));
        console.log('  PLAIN panel notes:', JSON.stringify(P.notes));
        console.log('  PLAIN view states:', JSON.stringify({ wifi: P.wifi && P.wifi.states, bt: P.bt && P.bt.states, sound: P.sound && P.sound.states }));
      }
    }
  });
}

run().catch((e) => { t.check('the run finished', false, String(e && e.stack || e)); }).then(() => t.done());
