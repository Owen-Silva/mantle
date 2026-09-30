'use strict';
/*
 * open-target.test.js - what lib/open-target.js refuses before anything reaches the shell
 * (core-lib quality pass, 2026-09-29).
 *
 *   node lib/open-target.test.js
 *
 * WHY: openTarget hands any "scheme:" to shell.openExternal and anything else to shell.openPath.
 * main.js's 'open' command filters what a PAGE may pass (openTargetVerdict), but openTarget is also
 * called by lib/features/downloads.js and anything added later, so it now refuses the targets no
 * Mantle surface ever means on its own: script schemes (javascript:, vbscript:, data:), file: URLs
 * (which run an .exe through the browser road), the scheme handlers used in real Windows exploits
 * (ms-msdt:, search-ms:, ms-officecmd:, ms-appinstaller:, ...), network (UNC) paths, which leak the
 * Windows sign-in hash to whoever runs the share, and control characters (an argument split).
 * Failed first: every refusal below was opened (or reached the "outside Electron" line) before.
 * Runs in plain node: the checks come before the Electron shell is needed.
 */
const { openTarget, refuseReason } = require('./open-target');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}

const REFUSED = [
  ['javascript:alert(1)', /script/],
  ['JavaScript:alert(1)', /script/],
  ['vbscript:msgbox', /script/],
  ['data:text/html,<b>x</b>', /script|data/],
  ['file:///C:/Windows/System32/calc.exe', /file: address/],
  ['FILE://server/share/x.exe', /file: address/],
  ['ms-msdt:/id PCWDiagnostic', /Mantle never opens/],
  ['search-ms:query=x&crumb=location:\\\\evil\\share', /Mantle never opens/],
  ['search:query=x', /Mantle never opens/],
  ['ms-officecmd:{}', /Mantle never opens/],
  ['ms-appinstaller:?source=https://evil/x.appx', /Mantle never opens/],
  ['ms-cxh-full://0', /Mantle never opens/],
  ['\\\\evil.example\\share\\setup.exe', /network location/],
  ['//evil.example/share/setup.exe', /network location/],
  ['\\\\?\\C:\\Windows\\notepad.exe', /network location|device path/],
  ['https://example.com/\n--inspect', /control character/],
  ['C:\\Users\\x\u0000.txt', /control character/],
];
const ALLOWED = [
  'https://example.com/a?b=c',
  'http://localhost:7373/',
  'ms-settings:display',
  'mailto:someone@example.com',
  'steam://run/730',
  'C:\\Users\\user\\Downloads\\notes.txt',
  'D:/Games',
];

(async () => {
  check('refuseReason is exported', typeof refuseReason === 'function');
  for (const [t, re] of REFUSED) {
    const why = typeof refuseReason === 'function' ? refuseReason(t) : null;
    check(`refused: ${JSON.stringify(t).slice(0, 50)}`, typeof why === 'string' && re.test(why), String(why));
    const r = await openTarget(t);
    check(`openTarget refuses it before the shell: ${JSON.stringify(t).slice(0, 40)}`, r.ok === false && !/outside Electron/.test(r.reason) && re.test(r.reason), JSON.stringify(r));
    check(`the words are plain (no code, no stack): ${JSON.stringify(t).slice(0, 30)}`, r.ok === false && !/Error:|ENOENT|undefined|null|\bat \w+ \(/.test(r.reason), r.reason);
  }
  for (const t of ALLOWED) {
    const why = typeof refuseReason === 'function' ? refuseReason(t) : 'missing';
    check(`allowed: ${t}`, why === null, String(why));
    const r = await openTarget(t);
    check(`openTarget lets it through to the shell step: ${t}`, r.ok === false && /outside Electron/.test(r.reason), JSON.stringify(r));
  }
  const empty = await openTarget('   ');
  check('empty target: refused in words', empty.ok === false && /empty/.test(empty.reason), JSON.stringify(empty));
  const notString = await openTarget({ toString() { return 'javascript:x'; } });
  check('a non-string target: refused', notString.ok === false, JSON.stringify(notString));
  const long = await openTarget('https://example.com/' + 'a'.repeat(40000));
  check('a 40 000-character target: refused as too long', long.ok === false && /too long/.test(long.reason), long.reason && long.reason.slice(0, 120));

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`OPEN TARGET TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
