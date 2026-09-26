'use strict';
/* gamemode.test.js - the pure half of the Game mode tile (ui/bar/gamemode.js view()). node ui/bar/gamemode.test.js */
const G = require('./gamemode.js');
let pass = 0, fail = 0;
const fails = [];
function check(n, ok, d) { if (ok) pass++; else { fail++; fails.push(`  FAIL ${n}${d ? ` (${d})` : ''}`); } }

let v = G.view(null);
check('no answer: dead, and says so', v.dead && /did not answer/.test(v.why));
v = G.view({ error: 'gamemode.state is stopped' });
check('an error: dead with the error', v.dead && /stopped/.test(v.why));
v = G.view({ enabled: false, auto: true });
check('tray switch off: dead, says where', v.dead && /tray/.test(v.why));
v = G.view({ on: false, auto: true, watching: true, actions: [] });
check('off + watching', !v.on && v.sub === 'Off · watching for games' && v.label === 'Turn on' && v.plan.length === 4);
v = G.view({ on: false, auto: false, watching: true });
check('off + automatic off', v.sub === 'Off · automatic is off');
v = G.view({ on: false, auto: true, watching: false, reason: 'games are not being watched: the sidecar is not running' });
check('not watching: said under the switch', /not being watched/.test(v.why) && v.sub === 'Off');
v = G.view({ on: true, how: 'auto', game: { file: 'VALORANT-Win64-Shipping.exe', why: 'VALORANT-Win64-Shipping.exe is a known game' }, actions: [{ key: 'power', label: 'Power mode', status: 'done', text: 'x' }, { key: 'saver', label: 'Energy saver', status: 'blocked', text: 'y' }] });
check('on for Valorant: the short game name', v.on && v.sub === 'On · VALORANT' && v.label === 'On · VALORANT', v.sub);
check('on: why it came on', /known game/.test(v.why));
check('on: every action is a row with a badge', v.rows.length === 2 && v.rows[0].badge === 'Done' && v.rows[1].badge === 'Not done' && !v.plan);
v = G.view({ on: true, how: 'manual', game: { file: 'explorer.exe' }, actions: [] });
check('on by hand', v.sub === 'On (by hand)' && v.label === 'On');
v = G.view({ on: true, how: 'auto', dry: true, game: { file: 'javaw.exe', why: 'javaw.exe has a Minecraft window' }, actions: [{ key: 'background', label: 'B', status: 'dry', text: 'dry run: would' }] });
check('dry run: said plainly', /Test run/.test(v.why) && v.rows[0].badge === 'Dry run' && v.sub === 'On · javaw');
v = G.view({ on: false, busy: 'off', auto: true, watching: true });
check('turning off: pending', v.pending && /Putting things back/.test(v.sub));
v = G.view({ on: false, auto: true, watching: true, last: { game: 'RobloxPlayerBeta.exe', minutes: 42, why: 'RobloxPlayerBeta.exe exited', text: '12 apps back to normal' } });
check('the last game is summarised', /Last game: RobloxPlayerBeta, 42 min \(RobloxPlayerBeta\.exe exited\)\. 12 apps back to normal/.test(v.last), v.last);
v = G.view({ on: false, auto: true, watching: true, fromCrash: { text: '41 apps back to normal' } });
check('put back after a restart: said', /After Mantle restarted: 41 apps back to normal/.test(v.crash));
console.log(`GAMEMODE TILE TEST: ${pass} passed, ${fail} failed`);
if (fails.length) console.log(fails.join('\n'));
process.exit(fail ? 1 : 0);
