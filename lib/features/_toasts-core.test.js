'use strict';
/*
 * _toasts-core.test.js - which toast gets a banner, what it says, when Mantle stays quiet, where a click
 * goes (lib/features/_toasts-core.js). Pure node.
 *   node lib/features/_toasts-core.test.js   -> "TOASTS CORE TEST: n passed, m failed"
 */
const C = require('./_toasts-core');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const NOW = 1760500000000;
const t = (id, extra) => Object.assign({ id, aumid: 'com.owensilva.helm', app: 'Helm', title: `T${id}`, body: 'b', timeMs: NOW - 1000 }, extra || {});

// ---- the picker
{
  const p = C.createPicker();
  check('the first list is only the baseline', p.next({ ok: true, toasts: [t(1), t(2)] }, NOW).length === 0);
  const n = p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW);
  check('a new id is new', n.length === 1 && n[0].id === 3, n);
  check('the same list again: nothing', p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW).length === 0);
  check('a failed read changes nothing', p.next({ ok: false, toasts: [] }, NOW).length === 0);
  const after = p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW);
  check('no burst after a failed read', after.length === 0, after);
  check('a removed toast that comes back is not new... unless it was gone from a good read',
    p.next({ ok: true, toasts: [t(3)] }, NOW).length === 0 && p.next({ ok: true, toasts: [t(3), t(1)] }, NOW).length === 1);
  const old = p.next({ ok: true, toasts: [t(3), t(1), t(9, { timeMs: NOW - C.FRESH_MS - 5000 })] }, NOW);
  check('a toast older than FRESH_MS is never bannered', old.length === 0, old);
  const notime = p.next({ ok: true, toasts: [t(3), t(1), t(10, { timeMs: 0 })] }, NOW);
  check('a toast with no time is bannered', notime.length === 1 && notime[0].id === 10);
  p.reset();
  check('after reset the next list is a baseline again', p.next({ ok: true, toasts: [t(3), t(1), t(11)] }, NOW).length === 0);
}

// ---- the banner
{
  const b = C.bannerOf({ id: 5, aumid: 'x', app: '  Helm  ', icon: 'data:image/png;base64,AA', logo: 'javascript:alert(1)', title: 'Done   in 14s',
    body: 'line one\nline two', hero: 'data:image/png;base64,BB', scenario: 'reminder', opens: 'protocol' }, NOW);
  check('banner: app trimmed', b.app === 'Helm');
  check('banner: text collapsed to one line of spaces', b.title === 'Done in 14s' && b.body === 'line one line two', b);
  check('banner: a non-picture url is dropped', b.logo === null);
  check('banner: hero stands in for image', b.image === 'data:image/png;base64,BB');
  check('banner: reminder is sticky', b.sticky === true);
  check('banner: protocol kept', b.opens === 'protocol');
  check('banner: no app name -> "An app"', C.bannerOf({ id: 1 }, NOW).app === 'An app');
  check('banner: incomingCall sticky, plain not', C.bannerOf({ id: 1, scenario: 'incomingCall' }).sticky && !C.bannerOf({ id: 1 }).sticky);
}

// ---- quiet
check('quiet: DND priority', C.quietWhy({ ok: true, dnd: 1, quns: 5 }) === 'Do not disturb is on');
check('quiet: DND alarms', /alarms/.test(C.quietWhy({ ok: true, dnd: 2, quns: 5 })));
check('quiet: a full-screen game', /game/.test(C.quietWhy({ ok: true, dnd: 0, quns: 3 })));
check('quiet: the lock screen', /locked/.test(C.quietWhy({ ok: true, dnd: 0, quns: 1 })));
check('quiet: accepts = not quiet', C.quietWhy({ ok: true, dnd: 0, quns: 5 }) === null);
check('quiet: unknown reads are not quiet', C.quietWhy({ ok: true, dnd: null, quns: null }) === null && C.quietWhy(null) === null);

// ---- click
check('click: a link toast opens its link', C.clickPlan({ opens: 'protocol' }, { hwnd: '9' }).act === 'link');
check('click: an app with a window -> that window', C.clickPlan({ opens: 'app' }, { hwnd: 123 }).act === 'window' && C.clickPlan({ opens: 'app' }, { hwnd: 123 }).hwnd === '123');
check('click: no window -> the list', C.clickPlan({ opens: 'app' }, null).act === 'list' && C.clickPlan({ opens: 'none' }, null).act === 'list');

console.log(`TOASTS CORE TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
