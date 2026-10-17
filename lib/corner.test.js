'use strict';
/* corner.test.js - lib/corner.js, who is in the bottom-right corner (lane mantle-toasts3, 2026-10-15).
 *   node lib/corner.test.js   -> "CORNER TEST: n passed, m failed" */
const corner = require('./corner');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }

corner.reset();
const heard = [];
const off = corner.onChange((why) => heard.push(why));
check('empty at first', corner.list().length === 0);
check('set: a card is up, rounded, listeners told', corner.set('the screenshot card', { x: 1224.4, y: 680, width: 312, height: 122.6 }) === true
  && JSON.stringify(corner.list()) === JSON.stringify([{ key: 'the screenshot card', x: 1224, y: 680, width: 312, height: 123, lift: 0, rest: 0 }]) && heard.length === 1 && /card is up/.test(heard[0]), { list: corner.list(), heard });
check('set: the same rect again is no change (no one told)', corner.set('the screenshot card', { x: 1224, y: 680, width: 312, height: 123 }) === false && heard.length === 1);
check('set: a new size is a change', corner.set('the screenshot card', { x: 1260, y: 700, width: 276, height: 102 }) === true && heard.length === 2 && corner.list()[0].width === 276);
check('set: an empty or broken rect clears it', corner.set('the screenshot card', { x: 1, y: 2, width: 0, height: 5 }) === true && corner.list().length === 0 && /went/.test(heard[2]));
check('set null when already gone: no change', corner.set('the screenshot card', null) === false && heard.length === 3);
corner.changed('a bar pop-up opened (bell)');
check('changed(): passes the reason on', heard[3] === 'a bar pop-up opened (bell)', heard);
corner.onChange(() => { throw new Error('boom'); });
corner.changed('again');
check('a throwing listener never stops the others', heard[4] === 'again', heard);
off();
corner.changed('after off');
check('off(): no longer told', heard.length === 5);
// lane mantle-corner-follow: a thing that glides with the bar says how far it rises (opts.lift); a new lift is a change
const heard2 = []; corner.onChange((why) => heard2.push(why)); const nh = 0;
check('set with opts.lift: kept, rounded, listed', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { lift: 55.6 }) === true && corner.list().find((r) => r.key === 'the record panel').lift === 56 && heard2.length === nh + 1, corner.list());
check('... the same rect with a NEW lift is a change (the banners re-place)', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { lift: 0 }) === true && corner.list().find((r) => r.key === 'the record panel').lift === 0 && heard2.length === nh + 2);
check('... the same rect and lift again: no change', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }) === false && heard2.length === nh + 2);
// lane mantle-corner-follow2: where it rests with the bar HIDDEN (opts.rest, never above lift); a new rest is a change
const nr = heard2.length;
check('set with opts.rest: kept, rounded, listed', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { lift: 56, rest: 17.4 }) === true && corner.list().find((r) => r.key === 'the record panel').rest === 17 && heard2.length === nr + 1, corner.list());
check('... a NEW rest alone is a change', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { lift: 56, rest: 24 }) === true && heard2.length === nr + 2);
check('... rest is never above lift (the bar hidden never lifts it more than the bar up)', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { lift: 10, rest: 24 }) === true && corner.list().find((r) => r.key === 'the record panel').rest === 10);
check('... no lift: no rest either', corner.set('the record panel', { x: 1160, y: 600, width: 376, height: 258 }, { rest: 24 }) === true && corner.list().find((r) => r.key === 'the record panel').rest === 0);
corner.set('the record panel', null);
corner.reset();

console.log(`CORNER TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
