/* apps.test.js -- lib/apps.js, the launcher index wrapper, without Electron or the sidecar.
 *
 * WHAT: the index module is read from disk ONCE PER INDEX BUILD, not on every search or
 * launch (core-needs, 2026-09-30); a rebuild still picks up an edited module; a missing,
 * broken or incomplete module is a visible state and never a throw.
 * HOW: a throwaway index module in a temp dir counts how many times Node evaluated it.
 * Nothing is launched: the fake module's launch() only echoes what it was given.
 *
 *   node lib/apps.test.js
 *   APPS_JS=<path to another apps.js> node lib/apps.test.js   (run the same checks on a baseline copy)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Apps, SEARCH_LIMIT } = require(process.env.APPS_JS ? path.resolve(process.env.APPS_JS) : './apps.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, what) { if (cond) pass++; else { fail++; failures.push(what); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-apps-test-'));
const evals = () => global.__appsTestEvals || 0;

/** A fake lib/launcher-index.js at version `v`. */
function writeModule(file, v, extra) {
  fs.writeFileSync(file, `'use strict';
global.__appsTestEvals = (global.__appsTestEvals || 0) + 1;
const V = ${JSON.stringify(v)};
module.exports = {
  build: async ({ icon }) => ({
    items: [{ id: 'a', name: 'Alpha', v: V, iconFn: typeof icon }, { id: 'b', name: 'Beta', v: V }],
    sources: [{ name: 'fake', count: 2, status: 'ok' }],
  }),
  search: (q, items) => {
    if (q === 'boom') throw new Error('search blew up');
    if (q === 'many') return Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, name: 'M' + i }));
    if (q.startsWith('http')) return [{ id: 'url:' + q, kind: 'url', name: q }];
    return items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  },
  launch: async (item, o) => ({ ok: true, reason: 'v' + V + ':' + item.id, sawDry: !!o.dryRun, sawPort: !!o.spotifyPort }),
  ${extra || ''}
};
`);
}

(async () => {
  const file = path.join(dir, 'launcher-index.js');
  writeModule(file, 1);
  const apps = new Apps({ modulePath: file, icon: async () => null });

  // ---- one read per build -------------------------------------------------
  const idx = await apps.index();
  ok(idx.items.length === 2 && idx.items[0].iconFn === 'function', `index: built from the module, icon resolver passed (${idx.items.length} items)`);
  const afterBuild = evals();
  ok(afterBuild === 1, `index: the module was evaluated once for the build (${afterBuild})`);

  let hits = 0;
  for (let i = 0; i < 50; i++) hits += (await apps.search('al')).length;
  ok(hits === 50, `search: 50 searches each found Alpha (${hits})`);
  ok(evals() === afterBuild, `search: 50 keystrokes did NOT re-read the module (evaluated ${evals() - afterBuild} more times, want 0)`);

  const l = await apps.launch('a', { dryRun: true, spotifyPort: true });
  ok(l.ok && l.reason === 'v1:a' && l.sawDry && l.sawPort && l.dryRun === true, `launch: runs the built module's launch with dryRun + spotifyPort (${JSON.stringify(l)})`);
  ok(evals() === afterBuild, 'launch: did NOT re-read the module');

  // a synthetic row (a typed URL) exists only in the last hits
  const u = await apps.search('https://example.com');
  const lu = await apps.launch(u[0].id, { dryRun: true });
  ok(lu.ok && lu.reason === 'v1:url:https://example.com', `launch: a row only search() made can still be launched (${lu.reason})`);

  const many = await apps.search('many');
  ok(many.length === SEARCH_LIMIT, `search: capped at ${SEARCH_LIMIT} (${many.length})`);

  const none = await apps.launch('nope', { dryRun: true });
  ok(!none.ok && /nothing in the index/.test(none.reason), `launch: an unknown id says so (${none.reason})`);

  // ---- an edited module is picked up by the next REBUILD, not before -------
  writeModule(file, 2);
  const beforeEdit = evals();
  const l1 = await apps.launch('a', { dryRun: true });
  ok(l1.reason === 'v1:a' && evals() === beforeEdit, `edit: until the rebuild, search/launch keep the module the index was built by (${l1.reason})`);
  const idx2 = await apps.index({ refresh: true });
  ok(evals() === beforeEdit + 1 && idx2.items[0].v === 2, `edit: index {refresh} re-read the module once and built from v2 (evals +${evals() - beforeEdit})`);
  const l2 = await apps.launch('a', { dryRun: true });
  ok(l2.reason === 'v2:a', `edit: after the rebuild, launch uses v2 (${l2.reason})`);
  ok(evals() === beforeEdit + 1, 'edit: and did not read it a third time');

  // ---- search() that throws: [] and the reason lands in the index sources ----
  const boom = await apps.search('boom');
  ok(Array.isArray(boom) && boom.length === 0, 'search: a throwing search() is [] (no throw)');
  const after = await apps.index();
  ok(after.sources.some((s) => s.status === 'error' && /search\(\) failed: search blew up/.test(s.reason)), 'search: its reason is in the next apps.index sources');

  // ---- a missing module -------------------------------------------------------
  const missingFile = path.join(dir, 'later', 'launcher-index.js');
  const miss = new Apps({ modulePath: missingFile, icon: async () => null });
  const mi = await miss.index();
  ok(mi.items.length === 0 && /missing/.test(mi.sources[0].reason), `missing: a visible source row (${mi.sources[0].reason})`);
  ok((await miss.search('al')).length === 0, 'missing: search is [] (no throw)');
  const ml = await miss.launch('a');
  ok(!ml.ok && /missing/.test(ml.reason), `missing: launch says why (${ml.reason})`);
  // ...that appears later is picked up by the next rebuild
  fs.mkdirSync(path.dirname(missingFile), { recursive: true });
  writeModule(missingFile, 3);
  ok((await miss.search('al')).length === 0, 'missing -> present: not before the rebuild');
  const mi2 = await miss.index({ refresh: true });
  ok(mi2.items.length === 2 && (await miss.search('al')).length === 1, 'missing -> present: the rebuild finds it and search works');

  // ---- a module with a syntax error, and one without launch() -----------------
  const badFile = path.join(dir, 'bad', 'launcher-index.js');
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, 'module.exports = { build: async () => ({ items: [] }) ,,, };');
  const bad = new Apps({ modulePath: badFile, icon: async () => null });
  const bi = await bad.index();
  ok(bi.items.length === 0 && /would not load/.test(bi.sources[0].reason), `syntax error: a visible reason (${bi.sources[0].status})`);
  ok((await bad.search('x')).length === 0, 'syntax error: search is [] (no throw)');

  const partFile = path.join(dir, 'part', 'launcher-index.js');
  fs.mkdirSync(path.dirname(partFile), { recursive: true });
  fs.writeFileSync(partFile, 'module.exports = { build: async () => ({ items: [] }), search: () => [] };');
  const part = new Apps({ modulePath: partFile, icon: async () => null });
  const pi = await part.index();
  ok(/does not export launch\(\)/.test(pi.sources[0].reason), `no launch(): a visible reason (${pi.sources[0].reason})`);

  // ---- build() that throws or returns junk -------------------------------------
  const junkFile = path.join(dir, 'junk', 'launcher-index.js');
  fs.mkdirSync(path.dirname(junkFile), { recursive: true });
  fs.writeFileSync(junkFile, 'module.exports = { build: async () => ({ nope: 1 }), search: () => [], launch: async () => ({ ok: true }) };');
  const junk = new Apps({ modulePath: junkFile, icon: async () => null });
  const ji = await junk.index();
  ok(ji.items.length === 0 && ji.sources.some((s) => /did not return an items array/.test(s.reason)), 'build() junk: a visible reason');

  // ---- two callers share one sweep ----------------------------------------------
  writeModule(file, 4);
  const shareBefore = evals();
  const [s1, s2] = await Promise.all([apps.index({ refresh: true }), apps.index({ refresh: true })]);
  ok(s1 === s2 && evals() === shareBefore + 1, `concurrent: two refreshes share one build and one read (evals +${evals() - shareBefore})`);

  // ---- the refresh timer never holds the process open ------------------------------
  apps.startRefresh();
  ok(apps._timer && typeof apps._timer.hasRef === 'function' ? !apps._timer.hasRef() : true, 'refresh timer: unref\'d');
  apps.stopRefresh();
  ok(apps._timer === null, 'refresh timer: stopped');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp dir: the OS cleans it */ }
  for (const f of failures) console.log('  FAIL: ' + f);
  console.log('APPS TEST: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('APPS TEST: crashed: ' + err.message); process.exit(1); });
