'use strict';
/* gamemode.test.js - the pure half of the Game mode tile (ui/bar/gamemode.js view()). node ui/bar/gamemode.test.js
 * The clicks are in gamemode.page.test.js (real tile, headless, through uislot.sh). */
const G = require('./gamemode.js');
let pass = 0, fail = 0;
const fails = [];
function check(n, ok, d) { if (ok) pass++; else { fail++; fails.push(`  FAIL ${n}${d ? ` (${d})` : ''}`); } }
// Words a person should never read on the tile (the brief's jargon list).
const JARGON = { test: (s) => /sidecar|hwnd|\bIPC\b|renderer|dryRun|dry run|AUMID|0x[0-9a-f]{4,}|undefined|\bnull\b|NaN|\[object/i.test(s) || /\bE[A-Z]{4,}\b/.test(s) };
function words(v) { return [v.sub, v.label, v.why, v.tip, v.last, v.crash, v.rest].concat(v.rows.map((r) => r.label + ' ' + r.badge + ' ' + r.text), (v.plan || []).map((p) => p.label + ' ' + p.text)).join(' | '); }

let v = G.view(null);
check('no answer: dead, says so and what to do', v.dead && v.warn && /didn't answer/.test(v.why) && /reopen/.test(v.why));
v = G.view({ error: 'gamemode.state: sidecar is stopped' });
check('an error: dead, plain words (no raw error on the tile)', v.dead && !JARGON.test(words(v)), words(v));
v = G.view({ enabled: false, auto: true });
check('tray switch off: dead, says where to turn it back on', v.dead && /tray/.test(v.why) && /Turn it back on/.test(v.why));
v = G.view({ on: false, auto: true, watching: true, actions: [] });
check('off + watching: the status says it starts with games, the switch says "Turn on"', !v.on && v.sub === 'Off · starts with your games' && v.label === 'Turn on' && !v.why, v.sub);
check('off: Details shows what it does when on (5 rows, resting last)', v.plan.length === 5 && v.plan[4].label === 'Mantle resting');
v = G.view({ on: false, auto: false, watching: true });
check('off + automatic off', v.sub === 'Off · starts only by hand');
v = G.view({ on: false, auto: true, watching: false, reason: "games are not being watched: Mantle's background helper is restarting" });
check('not watching: status + the reason in warning ink', v.sub === 'Off · not watching' && v.warn && /^Games are not being watched/.test(v.why), v.why);
v = G.view({ on: true, how: 'auto', game: { file: 'VALORANT-Win64-Shipping.exe', why: 'VALORANT-Win64-Shipping.exe is a known game' }, actions: [{ key: 'power', label: 'Power mode', status: 'done', text: 'x' }, { key: 'saver', label: 'Energy saver', status: 'blocked', text: 'y' }] });
check('on for Valorant: the short game name in the status', v.on && v.sub === 'On for VALORANT', v.sub);
check('on: the switch says what a click does', v.label === 'Turn off' && /Turn game mode off/.test(v.tip));
check('on: why it came on is a Details row, not the line under the switch', !v.why && v.rows[0].key === 'why' && /known game/.test(v.rows[0].text));
check('on: every action is a row with a badge', v.rows.length === 3 && v.rows[1].badge === 'Done' && v.rows[2].badge === 'Not done' && !v.plan);
v = G.view({ on: true, how: 'manual', game: { file: 'explorer.exe' }, actions: [{ key: 'notify', label: 'Notifications', status: 'info', text: 'windows does this' }] });
check('on by hand: "On", no app name', v.sub === 'On' && v.label === 'Turn off');
check('a note row has no badge and starts with a capital', v.rows[0].badge === '' && v.rows[0].text === 'Windows does this');
v = G.view({ on: true, how: 'auto', dry: true, game: { file: 'javaw.exe', why: 'javaw.exe has a Minecraft window' }, actions: [{ key: 'background', label: 'B', status: 'dry', text: 'test run: would' }] });
check('test run: said plainly', /^Test run/.test(v.why) && v.rows[1].badge === 'Test run' && v.sub === 'On for javaw');
v = G.view({ on: false, busy: 'off', auto: true, watching: true });
check('turning off: pending, says it is putting things back', v.pending && v.sub === 'Putting things back…' && v.label === 'Turning off…');
v = G.view({ on: false, busy: 'on', auto: true, watching: true });
check('turning on: pending', v.pending && v.label === 'Turning on…');
v = G.view({ on: false, auto: true, watching: true, last: { game: 'RobloxPlayerBeta.exe', minutes: 42, why: 'RobloxPlayerBeta.exe exited', text: '12 apps back to normal' } });
check('the last game is summarised in Details', v.last === 'Last game: RobloxPlayerBeta, 42 min. 12 apps back to normal.', v.last);
v = G.view({ on: false, auto: true, watching: true, last: { game: null, minutes: undefined, text: 'x' } });
check('last game by hand, minutes unknown: no "undefined"', /turned on by hand, under a minute/.test(v.last) && !JARGON.test(v.last), v.last);
v = G.view({ on: false, auto: true, watching: true, fromCrash: { text: '41 apps back to normal', ok: true } });
check('put back after a restart: said, not as a warning', v.why === 'After Mantle restarted: 41 apps back to normal' && !v.warn);
v = G.view({ on: false, auto: true, watching: true, fromCrash: { text: 'NOT put back: x', ok: false } });
check('put back after a restart, with a failure: a warning', v.warn);
v = G.view({ on: false, auto: true, watching: true, leftover: { text: 'Not put back yet: claude.exe: refused. Mantle tries again every 30 s', tries: 1 } });
check('what could not be put back: the line under the switch, in warning ink', v.warn && /^Not put back yet/.test(v.why));
// Mantle resting while a game runs (lane memfix): the status says so; the words with the memory are a Details row.
const restText = 'Mantle is resting while VALORANT runs: closed 9 windows (launcher, switcher); Mantle\'s memory 585 MB -> 330 MB';
v = G.view({ on: false, auto: true, watching: true, rest: { on: true, why: 'VALORANT runs', text: restText } });
check('resting, game mode off: the status says so', v.sub === 'Off · Mantle is resting');
check('resting: the long words stay in Details, not under the switch', v.rest === restText && !v.why);
check('resting: a Details row first', v.rows.length === 1 && v.rows[0].key === 'rest' && v.rows[0].status === 'done' && v.rows[0].text === restText);
v = G.view({ on: true, how: 'auto', game: { file: 'VALORANT-Win64-Shipping.exe' }, auto: true, actions: [{ key: 'power', label: 'Power mode', status: 'done', text: 'x' }], rest: { on: true, why: 'VALORANT runs', text: restText } });
check('resting, game mode on: status unchanged, rest row before the actions', v.sub === 'On for VALORANT' && v.rows[0].key === 'rest' && v.rows[1].key === 'power');
v = G.view({ on: false, auto: true, watching: true, rest: { on: false, text: 'Mantle could not rest while VALORANT runs: no answer' } });
check('could not rest: said under the switch in warning ink', /could not rest/.test(v.why) && v.warn && v.sub === 'Off · starts with your games');
v = G.view({ on: false, auto: true, watching: true, rest: { on: false, last: { text: 'Mantle rested 42 min (VALORANT runs) and is back: VALORANT exited' } } });
check('after the game: the rest is in the last line', /Mantle rested 42 min .* is back: VALORANT exited\./.test(v.last) && !v.rest);
// No jargon in any state a person can see.
const states = [null, { error: 'x' }, { enabled: false }, { on: false, auto: true, watching: true },
  { on: true, how: 'auto', game: { file: 'cs2.exe', why: 'cs2.exe is a known game' }, actions: [{ key: 'mantle', label: 'Mantle itself', status: 'done', text: '3 Mantle processes in Efficiency mode' }] },
  { on: true, how: 'manual', dry: true, game: {}, actions: [] }, { on: false, busy: 'off' }];
check('no jargon, "undefined" or "null" in any state', states.every((s) => !JARGON.test(words(G.view(s)))), states.map((s) => words(G.view(s))).filter((w) => JARGON.test(w)).join(' || '));
console.log(`GAMEMODE TILE TEST: ${pass} passed, ${fail} failed`);
if (fails.length) console.log(fails.join('\n'));
process.exit(fail ? 1 : 0);
