'use strict';
/*
 * wallpaper-presets.test.js -- lib/wallpaper-presets.js, the built-in wallpapers' catalog, under
 * plain node (lane mantle-bg-presets, 2026-10-09). No Electron. Reads the REAL assets/backgrounds/
 * (read-only) for the shipped catalog, and damages COPIES of it in a temp folder for the failure
 * states: no catalog, a broken one, a missing photo, an empty photo, a missing thumb, damaged and
 * repeated lines. Ids are pinned below: a saved pick must keep naming the same photo.
 *
 *   node lib/wallpaper-presets.test.js
 *
 * Prints "WALLPAPER PRESETS TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const PR = require('./wallpaper-presets');
const WL = require('./wallpaper-lively');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}

const REAL = PR.dirFor(path.resolve(__dirname, '..'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-presets-test-'));
function copyCatalog(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(path.join(d, 'thumbs'), { recursive: true });
  for (const f of fs.readdirSync(REAL)) if (fs.statSync(path.join(REAL, f)).isFile()) fs.copyFileSync(path.join(REAL, f), path.join(d, f));
  for (const f of fs.readdirSync(path.join(REAL, 'thumbs'))) fs.copyFileSync(path.join(REAL, 'thumbs', f), path.join(d, 'thumbs', f));
  return d;
}

// The 23 ids a saved pick can hold, in catalog order. Changing one breaks somebody's saved pick.
const PINNED = ['stone', 'cloud-peaks', 'valley-fog', 'forest', 'misty-woods', 'pine-slope', 'lake', 'misty-lake', 'crater-lake',
  'foggy-cliffs', 'rolling-wave', 'desert-dunes', 'night-dune', 'crescent-moon', 'night-fjord', 'snow-peak', 'snow-ridge',
  'city-valley', 'tower-fog', 'fog-flow', 'sand-ripples', 'open-sea', 'dark-water'].map((x) => 'builtin:' + x);
const CATS = ['Mountains', 'Forest', 'Water', 'Coast', 'Desert', 'Sky & Night', 'Snow', 'City', 'Abstract', 'Minimal'];

try {
  /* ---- the shipped catalog ---------------------------------------------------------------- */
  const cat = PR.load(REAL);
  check('shipped: the catalog loads', cat.ok && !cat.reason && !cat.note, JSON.stringify({ ok: cat.ok, reason: cat.reason, note: cat.note }));
  check('shipped: 23 photos', cat.items.length === 23, cat.items.length);
  const ids = cat.items.map((x) => x.id);
  check('shipped: ids are builtin:<file name>, in catalog order (pinned)', JSON.stringify(ids.slice().sort()) === JSON.stringify(PINNED.slice().sort()), ids.join());
  check('shipped: ids are unique', new Set(ids).size === ids.length);
  check('shipped: the 10 categories, in Helm\'s order', JSON.stringify(cat.categories) === JSON.stringify(CATS), cat.categories.join());
  check('shipped: every photo is usable', cat.items.every((x) => PR.health(x).ok), cat.items.filter((x) => !PR.health(x).ok).map((x) => x.id).join());
  check('shipped: every photo has its own thumb (no fallback note)', cat.items.every((x) => { const t = PR.thumbOf(x); return t.url && /\/thumbs\//.test(t.url) && !t.note; }));
  check('shipped: every photo has a title, a category and a credit with an https photo page',
    cat.items.every((x) => x.title && CATS.includes(x.category) && x.credit && /^https:\/\/unsplash\.com\//.test(x.creditUrl)));
  check('shipped: every photo is a picture item with an absolute path inside the folder',
    cat.items.every((x) => x.type === 'picture' && x.preset === true && path.isAbsolute(x.abs) && WL.isInside(REAL, x.abs)));
  const stone = cat.items.find((x) => x.id === 'builtin:stone');
  check('shipped: "Stone summit" by Fabrizio Conti', stone && stone.title === 'Stone summit' && stone.credit === 'Fabrizio Conti' && stone.category === 'Mountains');
  check('shipped: CREDITS.md credits every photographer in the catalog',
    (() => { const c = fs.readFileSync(path.join(REAL, 'CREDITS.md'), 'utf8'); return cat.items.every((x) => c.includes(x.credit) && c.includes('## ' + x.file)); })());
  check('shipped: Helm\'s own wallpaper.png is not one of them', !fs.existsSync(path.join(REAL, 'wallpaper.png')) && !ids.includes('builtin:wallpaper'));

  /* ---- ids ------------------------------------------------------------------------------------ */
  check('ids: from the file name, lower case, extension dropped', PR.idOf('Forest.JPG') === 'builtin:forest' && PR.idOf('a.b.webp') === 'builtin:a.b');
  check('ids: a preset id is recognised', PR.isPresetId('builtin:forest') && PR.isPresetId('builtin:sky_2.v2'));
  check('ids: library and Lively ids are not preset ids', !PR.isPresetId('m1abc2def') && !PR.isPresetId('vid00001.aaa') && !PR.isPresetId('forest'));
  check('ids: malformed ones are refused', ['builtin:', 'builtin:../x', 'builtin:a/b', 'builtin:A B', 'builtin:' + 'x'.repeat(65), null, 42].every((x) => !PR.isPresetId(x)));
  check('ids: a preset id can never be a library id (the colon), so it never names a folder', PINNED.every((x) => !WL.safeId(x)));
  const reordered = copyCatalog('reordered');
  const rawList = JSON.parse(fs.readFileSync(path.join(reordered, 'catalog.json'), 'utf8'));
  fs.writeFileSync(path.join(reordered, 'catalog.json'), JSON.stringify(rawList.slice().reverse().map((x) => Object.assign({}, x, { title: x.title + ' (renamed)' }))));
  const rc = PR.load(reordered);
  check('ids: stable when the catalog is reordered and retitled', rc.ok && rc.items.every((x) => cat.items.some((y) => y.id === x.id && y.file === x.file)) && rc.items.length === 23);

  /* ---- find ---------------------------------------------------------------------------------- */
  check('find: a known id gives that photo', PR.find(cat, 'builtin:lake') === cat.items.find((x) => x.id === 'builtin:lake'));
  check('find: a non-preset id gives null', PR.find(cat, 'm123') === null);
  const gone = PR.find(cat, 'builtin:old-photo');
  const gh = PR.health(gone);
  check('find: an id no longer in the catalog is a stand-in that says why', gone && gone.preset && gone.title === 'Old photo' && !gh.ok && /no longer one of Mantle's built-in wallpapers/.test(gh.reason), JSON.stringify(gh));
  const noCat = PR.load(path.join(TMP, 'nowhere'));
  const goneNoCat = PR.health(PR.find(noCat, 'builtin:lake'));
  check('find: with the catalog unreadable, a saved pick says the catalog is the reason', !goneNoCat.ok && /cannot be read: the list of built-in wallpapers/.test(goneNoCat.reason), goneNoCat.reason);

  /* ---- the failure states ------------------------------------------------------------------ */
  check('missing catalog: not ok, with the reason in words', !noCat.ok && /catalog\.json\) is missing/.test(noCat.reason) && noCat.items.length === 0, noCat.reason);
  const broken = copyCatalog('broken');
  fs.writeFileSync(path.join(broken, 'catalog.json'), '[{ "file": "stone.jpg", ');
  const bc = PR.load(broken);
  check('broken catalog: not ok, says it could not be read', !bc.ok && /could not be read \(/.test(bc.reason) && !bc.items.length, bc.reason);
  fs.writeFileSync(path.join(broken, 'catalog.json'), '{"file":"stone.jpg"}');
  const nl = PR.load(broken);
  check('a catalog that is not a list: not ok, says so', !nl.ok && /not a list/.test(nl.reason), nl.reason);
  fs.writeFileSync(path.join(broken, 'catalog.json'), JSON.stringify([{ file: '../evil.jpg' }, { file: 'x.exe' }, null, { title: 'no file' }]));
  const none = PR.load(broken);
  check('a catalog with no usable lines: not ok, says so', !none.ok && /no usable photos/.test(none.reason), none.reason);
  fs.writeFileSync(path.join(broken, 'catalog.json'), JSON.stringify([{ file: '../evil.jpg' }, { file: 'C:\\x.jpg' }, rawList[0], rawList[0], rawList[1]]));
  const dl = PR.load(broken);
  check('damaged and repeated lines: left out, counted in the note, the rest still load',
    dl.ok && dl.items.length === 2 && /2 lines were damaged and left out/.test(dl.note) && /1 photo was listed twice/.test(dl.note), JSON.stringify({ n: dl.items.length, note: dl.note }));
  check('damaged lines: nothing outside the folder is ever listed', dl.items.every((x) => WL.isInside(broken, x.abs)));
  const plain = copyCatalog('plain');
  const pl = JSON.parse(fs.readFileSync(path.join(plain, 'catalog.json'), 'utf8'));
  pl[0] = { file: pl[0].file };   // no title, category, credit or url
  pl[1] = Object.assign({}, pl[1], { url: 'javascript:alert(1)' });
  fs.writeFileSync(path.join(plain, 'catalog.json'), JSON.stringify(pl));
  const pc = PR.load(plain);
  check('a bare line: titled from its file, category Other, no credit', pc.items[0].title === 'stone' && pc.items[0].category === 'Other' && pc.items[0].credit === '' && pc.categories.includes('Other'));
  check('a credit link that is not https is dropped, never opened', pc.items[1].creditUrl === '');

  const dmg = copyCatalog('damaged-files');
  fs.unlinkSync(path.join(dmg, 'forest.jpg'));
  fs.writeFileSync(path.join(dmg, 'lake.jpg'), '');
  fs.unlinkSync(path.join(dmg, 'thumbs', 'stone.jpg'));
  fs.unlinkSync(path.join(dmg, 'thumbs', 'forest.jpg'));
  const dc = PR.load(dmg);
  const byId = (id) => dc.items.find((x) => x.id === id);
  const fh = PR.health(byId('builtin:forest'));
  check('missing photo: still listed, health not ok, the reason names the photo', dc.ok && byId('builtin:forest') && !fh.ok && /"forest\.jpg" is missing from Mantle's built-in wallpapers folder/.test(fh.reason), fh.reason);
  const lh = PR.health(byId('builtin:lake'));
  check('empty photo: health not ok, says it is empty', !lh.ok && /"lake\.jpg" is empty/.test(lh.reason), lh.reason);
  const st = PR.thumbOf(byId('builtin:stone'));
  check('missing thumb: the full photo is shown instead, and a note says so', st.url === pathToFileURL(path.join(dmg, 'stone.jpg')).href && /small preview is missing/.test(st.note), JSON.stringify(st));
  check('missing thumb AND photo: no picture at all, health says why', PR.thumbOf(byId('builtin:forest')).url === null);
  check('the rest are untouched', dc.items.filter((x) => PR.health(x).ok).length === 21);

  /* ---- shuffle -------------------------------------------------------------------------------- */
  const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
  const s1 = PR.shuffle(cat, 'All', 'builtin:stone', seq([0]));
  check('shuffle: never the one on the desktop now', s1 && s1.id !== 'builtin:stone', s1 && s1.id);
  const many = new Set();
  for (let i = 0; i < 400; i++) { const p = PR.shuffle(cat, 'Snow', 'builtin:snow-peak'); if (p) many.add(p.id); }
  check('shuffle: stays in the chosen category', many.size === 1 && many.has('builtin:snow-ridge'), [...many].join());
  const spread = new Set();
  for (let i = 0; i < 2000; i++) spread.add(PR.shuffle(cat, 'All', null).id);
  check('shuffle: reaches every photo', spread.size === 23, spread.size);
  check('shuffle: the last index is in range', PR.shuffle(cat, 'All', null, () => 0.9999999).id === cat.items[22].id);
  check('shuffle: a category of one gives that one, even if it is current', (() => {
    const one = { ok: true, categories: [cat.items[0].category], items: [cat.items[0]] };
    const p = PR.shuffle(one, cat.items[0].category, cat.items[0].id);
    return !!p && p.id === cat.items[0].id;
  })());
  check('shuffle: unusable photos are never picked', (() => {
    for (let i = 0; i < 300; i++) { const p = PR.shuffle(dc, 'All', null); if (!p || p.id === 'builtin:forest' || p.id === 'builtin:lake') return false; }
    return true;
  })());
  check('shuffle: nothing usable gives null', PR.shuffle(noCat, 'All', null) === null && PR.shuffle(cat, 'No such', null) === null);

  /* ---- the library keeps a built-in pick across a restart -------------------------------- */
  const libDir = path.join(TMP, 'lib');
  const L1 = new WL.Library(libDir, { keepSelected: PR.isPresetId });
  L1.load();
  L1.data.selected = 'builtin:night-fjord';
  L1.save();
  const L2 = new WL.Library(libDir, { keepSelected: PR.isPresetId });
  L2.load();
  check('library: a built-in pick survives a reload (restart)', L2.data.selected === 'builtin:night-fjord' && !L2.loadError, L2.data.selected);
  check('library: the built-in pick never becomes an item', L2.data.items.length === 0);
  const L3 = new WL.Library(libDir);
  L3.load();
  check('library: without the option an unknown pick is still dropped (old behaviour kept)', L3.data.selected === null);
  L1.data.selected = 'm-not-there';
  L1.save();
  const L4 = new WL.Library(libDir, { keepSelected: PR.isPresetId });
  L4.load();
  check('library: a vanished library pick is still dropped with the option', L4.data.selected === null);
} catch (err) {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* the temp cleaner gets it */ }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALLPAPER PRESETS TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
