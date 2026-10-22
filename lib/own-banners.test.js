'use strict';
/* own-banners.test.js - lib/own-banners.js on its own (pure node: no Electron, no window).
 * Pins: post shows a banner under a stable negative id; a second post of the same key updates it in
 * place (same id, same place in the list, update:true); drop takes it away and a re-post comes back
 * under the same id; list() hands out copies; onChange tells every listener and survives one that
 * throws; act routes to the poster's onAction (button keeps by default, the X drops), honours a
 * promise's { keep }, refuses an unknown id / unknown button / a second run of the same action, and
 * turns a throw or a rejection into { ok:false, reason } in words. Never throws.
 *   node lib/own-banners.test.js   -> "OWN BANNERS TEST: n passed, m failed"
 */
const { createOwnBanners, clean } = require('./own-banners');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

(async () => {
  const logs = [];
  const ob = createOwnBanners({ log: (l) => logs.push(l) });
  const evs = [];
  const off = ob.onChange((e) => evs.push(e));

  // ---- post: a banner, its id, what the page gets
  const acts = [];
  const id1 = ob.post('updates', {
    app: 'Mantle', title: 'Mantle v0.2.0 is out', body: 'You are on v0.1.0.', tone: 'info', sticky: true,
    actions: [{ id: 'later', label: 'Later' }, { id: 'update', label: 'Update', primary: true }],
  }, (a) => { acts.push(a); return undefined; });
  check('post: the first key gets id -1', id1 === -1, id1);
  let l = ob.list();
  check('list: one banner, page-shaped (own, sticky, no detail, no progress, info tone)',
    l.length === 1 && l[0].id === -1 && l[0].own === true && l[0].sticky === true && l[0].detail === null && l[0].progress === null && l[0].tone === 'info' && l[0].app === 'Mantle', l);
  check('list: the buttons in order, primary marked', l[0].actions.length === 2 && l[0].actions[1].id === 'update' && l[0].actions[1].primary === true && l[0].actions[0].primary === false, l[0].actions);
  check('onChange: post, not an update', evs.length === 1 && evs[0].type === 'post' && evs[0].id === -1 && evs[0].update === false && evs[0].banner.title === 'Mantle v0.2.0 is out', evs);

  // ---- a second key gets the next id; list keeps post order
  const id2 = ob.post('other', { title: 'Second', body: 'b', sticky: true });
  check('a second key gets id -2, app defaults to Mantle', id2 === -2 && ob.list()[1].app === 'Mantle', ob.list());

  // ---- update in place: same id, same place, update:true
  ob.post('updates', { app: 'Mantle', title: 'Updating Mantle', body: '', progress: { text: 'Downloading...', pct: 42.5 }, sticky: true }, (a) => { acts.push(a); });
  l = ob.list();
  check('update in place: same id, still first in the list, new title and progress',
    l.length === 2 && l[0].id === -1 && l[0].title === 'Updating Mantle' && l[0].progress.text === 'Downloading...' && l[0].progress.pct === 42.5 && l[0].actions.length === 0, l);
  check('onChange: the update says update:true', evs[evs.length - 1].type === 'post' && evs[evs.length - 1].update === true && evs[evs.length - 1].id === -1);

  // ---- list() hands out copies
  l[0].title = 'changed by a caller'; l[0].progress.pct = 99;
  check('list() is a copy (a caller cannot change what is posted)', ob.list()[0].title === 'Updating Mantle' && ob.list()[0].progress.pct === 42.5);

  // ---- clean: pct clamped, null = indeterminate, bad tone, bad buttons left out (and logged)
  check('clean: pct 150 -> 100, -3 -> 0, null/undefined -> null (indeterminate)',
    clean({ progress: { text: 'x', pct: 150 } }, -9).banner.progress.pct === 100 && clean({ progress: { pct: -3 } }, -9).banner.progress.pct === 0
    && clean({ progress: { text: 'x', pct: null } }, -9).banner.progress.pct === null && clean({ progress: { text: 'x' } }, -9).banner.progress.pct === null);
  check('clean: an unknown tone is info; error stays error', clean({ tone: 'neon' }, -9).banner.tone === 'info' && clean({ tone: 'error' }, -9).banner.tone === 'error');
  const nLogs = logs.length;
  ob.post('bad', { title: 'Bad buttons', actions: [{ id: 'close', label: 'Close' }, { id: 'a' }, { label: 'no id' }, { id: 'ok', label: 'OK' }, { id: 'ok', label: 'OK again' }] });
  const bad = ob.list().find((b) => b.title === 'Bad buttons');
  check('clean: "close", a label-less, an id-less and a duplicate button are left out, and the log says so',
    bad && bad.actions.length === 1 && bad.actions[0].id === 'ok' && logs.length === nLogs + 1 && /left out/.test(logs[logs.length - 1]), { bad, log: logs.slice(nLogs) });
  check('clean: a long detail is capped with an ellipsis', clean({ detail: 'x'.repeat(5000) }, -9).banner.detail.length === 4000 && clean({ detail: 'x'.repeat(5000) }, -9).banner.detail.endsWith('…'));
  let threw = null;
  try { ob.post('', { title: 'x' }); } catch (err) { threw = err; }
  check('post with an empty key throws a TypeError (a caller bug, loud)', threw instanceof TypeError);
  threw = null;
  try { ob.post('k', null); } catch (err) { threw = err; }
  check('post with no banner throws a TypeError', threw instanceof TypeError);

  // ---- drop: leaves the list, onChange drop; a re-post keeps the id
  check('drop: true when one was up', ob.drop('bad') === true);
  check('drop: false when none is up', ob.drop('bad') === false && ob.drop('never') === false);
  check('onChange: drop event with its id', evs[evs.length - 1].type === 'drop' && evs[evs.length - 1].id === -3, evs[evs.length - 1]);
  ob.drop('other');
  check('re-post of a dropped key comes back under the same id (-2), at the end of the list', ob.post('other', { title: 'Back' }) === -2 && ob.list().pop().id === -2);
  ob.drop('other');

  // ---- act: a button keeps the card by default and reaches onAction
  ob.post('updates', { title: 'Mantle v0.2.0 is out', actions: [{ id: 'later', label: 'Later' }, { id: 'update', label: 'Update', primary: true }] }, (a) => { acts.push(a); });
  let r = await ob.act(-1, 'update');
  check('act: a button reaches onAction and keeps the card by default', r.ok === true && r.keep === true && r.reason === null && acts[acts.length - 1] === 'update' && ob.list().some((b) => b.id === -1), r);

  // ---- a promise result: keep:false drops it
  ob.post('updates', { title: 'Mantle v0.2.0 is out', actions: [{ id: 'later', label: 'Later' }] }, async (a) => { await tick(20); acts.push(a); return { keep: false }; });
  const nEv = evs.length;
  r = await ob.act(-1, 'later');
  check('act: a promise resolving to { keep:false } drops the banner', r.ok === true && r.keep === false && !ob.list().some((b) => b.id === -1) && evs.slice(nEv).some((e) => e.type === 'drop' && e.id === -1), { r, list: ob.list() });

  // ---- the X: close drops by default; { keep:true } keeps it
  ob.post('updates', { title: 'Close me' }, (a) => { acts.push(a); });
  r = await ob.act(-1, 'close');
  check('act close: reaches onAction and the banner leaves', r.ok === true && r.keep === false && acts[acts.length - 1] === 'close' && !ob.list().some((b) => b.id === -1), r);
  ob.post('updates', { title: 'Keep me' }, () => ({ keep: true }));
  r = await ob.act(-1, 'close');
  check('act close: { keep:true } keeps it', r.ok === true && r.keep === true && ob.list().some((b) => b.id === -1), r);
  ob.post('updates', { title: 'No handler' });
  r = await ob.act(-1, 'close');
  check('act close with no handler: the banner simply leaves', r.ok === true && r.keep === false && !ob.list().some((b) => b.id === -1), r);

  // ---- unknown id, unknown button, no handler for a button: words, never a throw
  r = await ob.act(-77, 'update');
  check('act: an unknown id answers ok:false with a reason', r.ok === false && /no banner -77/.test(r.reason), r);
  r = await ob.act('nonsense', 'update');
  check('act: a non-number id answers ok:false with a reason', r.ok === false && typeof r.reason === 'string', r);
  ob.post('updates', { title: 'Buttons', actions: [{ id: 'update', label: 'Update' }] });
  r = await ob.act(-1, 'reboot');
  check('act: a button the banner does not have answers ok:false, keep:true', r.ok === false && r.keep === true && /no "reboot" button/.test(r.reason), r);
  r = await ob.act(-1, 'update');
  check('act: a button with no handler answers ok:false in words', r.ok === false && r.keep === true && /nothing is set up/.test(r.reason), r);

  // ---- onAction throwing / rejecting -> { ok:false, reason }, and the log has it
  ob.post('updates', { title: 'Throws', actions: [{ id: 'update', label: 'Update' }] }, () => { throw new Error('the download server said 503'); });
  r = await ob.act(-1, 'update');
  check('act: onAction throwing becomes { ok:false, keep:true, reason }', r.ok === false && r.keep === true && r.reason === 'the download server said 503' && logs.some((x) => /503/.test(x)), r);
  ob.post('updates', { title: 'Rejects', actions: [{ id: 'update', label: 'Update' }] }, async () => { throw new Error('no network'); });
  r = await ob.act(-1, 'update');
  check('act: onAction rejecting becomes { ok:false, reason }', r.ok === false && r.reason === 'no network', r);
  ob.post('updates', { title: 'Close throws' }, () => { throw new Error('boom'); });
  r = await ob.act(-1, 'close');
  check('act close: onAction throwing still takes the card away (ok:false, keep:false)', r.ok === false && r.keep === false && !ob.list().some((b) => b.id === -1), r);
  ob.post('updates', { title: 'Says no', actions: [{ id: 'update', label: 'Update' }] }, () => ({ ok: false, reason: 'git is not on PATH' }));
  r = await ob.act(-1, 'update');
  check('act: a poster answering { ok:false, reason } is passed on', r.ok === false && r.keep === true && r.reason === 'git is not on PATH', r);

  // ---- a double click: the same action is refused while it runs; an update in place does not reset that
  let release;
  let runs = 0;
  ob.post('updates', { title: 'Slow', actions: [{ id: 'update', label: 'Update' }] }, (a) => { runs++; return new Promise((res) => { release = res; }); });
  const first = ob.act(-1, 'update');
  await tick();
  const second = await ob.act(-1, 'update');
  check('act: a second "update" while the first runs is refused (one update, not two)', second.ok === false && /already running/.test(second.reason) && runs === 1, second);
  ob.post('updates', { title: 'Slow, updated', actions: [{ id: 'update', label: 'Update' }] }, () => { runs++; return { keep: true }; });
  const third = await ob.act(-1, 'update');
  check('... still refused after an update in place while it runs', third.ok === false && runs === 1, third);
  release({ keep: true });
  r = await first;
  check('... the first one finishes normally', r.ok === true && r.keep === true, r);
  r = await ob.act(-1, 'update');
  check('... and once it is done the button works again', r.ok === true && runs === 2, r);

  // ---- a listener that throws does not stop the others; unsubscribe works
  const seen = [];
  const offBad = ob.onChange(() => { throw new Error('listener bug'); });
  const offGood = ob.onChange((e) => seen.push(e.type));
  ob.post('updates', { title: 'Listeners' });
  check('onChange: a throwing listener is logged and the next one still hears it', seen.length === 1 && logs.some((x) => /listener .*threw \(listener bug\)/.test(x)), { seen, logs: logs.slice(-2) });
  offBad(); offGood(); off();
  const before = evs.length;
  ob.post('updates', { title: 'Nobody listening' });
  check('unsubscribe: no more events', evs.length === before && seen.length === 1);
  let threwOn = null;
  try { ob.onChange(null); } catch (err) { threwOn = err; }
  check('onChange(null) throws a TypeError', threwOn instanceof TypeError);

  // ---- no options at all: still works, no log needed
  const bare = createOwnBanners();
  bare.post('x', { title: 'x' }, () => { throw new Error('quiet'); });
  r = await bare.act(-1, 'close');
  check('createOwnBanners() with no options works and never throws', r.ok === false && r.keep === false && bare.list().length === 0, r);

  console.log(`OWN BANNERS TEST: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`OWN BANNERS TEST: CRASHED ${e.stack}`); process.exit(1); });
