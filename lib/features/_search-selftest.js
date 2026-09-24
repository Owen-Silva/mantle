/* _search-selftest.js — the Win+S end-to-end check, run INSIDE a --test Mantle.
 *
 * Loaded by lib/features/search.js only when ctx.test exists (a --test instance) AND
 * MANTLE_SEARCH_SELFTEST=1, right after a Win+S chord (delivered by the seam's --test-chord, so it
 * went through the same routing the keyboard hook uses) has opened the launcher. The leading "_"
 * keeps the seam from loading it as a feature.
 *
 * It types into the REAL launcher page (DOM input events inside the test instance's own page - no
 * OS input, nothing on Owen's desktop receives a key), waits for the rows, and presses Enter ONLY on
 * rows whose Enter is a dry run in --test: the calculator (search.copy), the web row (search.web)
 * and a file row (search.openFile). It refuses to press Enter on anything else. An app, Settings or
 * power row is never activated: apps.launch has no dry run.
 *
 * PRIVACY: logs kinds, counts and timings. No file names, no paths.
 */
'use strict';

function launcherWindow() {
  const { BrowserWindow } = require('electron');
  return BrowserWindow.getAllWindows().find((w) => {
    try { return !w.isDestroyed() && /ui[\\/]launcher[\\/]index\.html$/i.test(decodeURIComponent(w.webContents.getURL())); }
    catch (_) { return false; }
  }) || null;
}

/* Runs in the launcher page. Returns a plain JSON report. */
function inPage() {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = () => $('.row.is-sel');
  const kinds = () => $$('.row').map((r) => r.dataset.kind);
  const groups = () => $$('.grp').map((g) => g.textContent);
  async function until(fn, ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (fn()) return Math.round(performance.now() - t0);
      await sleep(3);
    }
    return -1;
  }
  async function type(q, fn, ms) {
    const box = $('#q');
    box.value = q;
    const t0 = performance.now();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const took = await until(fn, ms || 3000);
    return took < 0 ? -1 : Math.round(performance.now() - t0);
  }
  function key(k, extra) { document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, extra || {}))); }
  const rowNamed = (kind, name) => $$('.row').some((r) => r.dataset.kind === kind && (r.querySelector('.name') || {}).textContent === name);
  const why = () => ($('.why') || {}).textContent || '';
  // Enter only on a row whose Enter is a dry run in --test
  function enterOn(kind, extra) {
    const s = sel();
    if (!s || s.dataset.kind !== kind || ['calc', 'web', 'file'].indexOf(kind) < 0) return 'refused: selected row is ' + (s && s.dataset.kind);
    key('Enter', extra);
    return 'pressed';
  }

  return (async () => {
    const out = {};
    out.opened = await until(() => document.body.dataset.mode === 'search', 3000);
    out.placeholder = $('#q').placeholder;
    out.emptyBox = $('#q').value === '';

    out.settingsBlu = await type('blu', () => rowNamed('setting', 'Bluetooth & devices'));
    out.settingsDarkMode = await type('dark mode', () => rowNamed('setting', 'Colors'));
    out.settingsWallpaper = await type('wallpaper', () => rowNamed('setting', 'Background'));

    out.calc = await type('6*7', () => rowNamed('calc', '= 42'));
    out.calcFirst = kinds()[0] === 'calc';
    out.calcNoFileGroup = groups().indexOf('Files') < 0;
    out.calcEnter = enterOn('calc');
    out.calcCopyDry = await until(() => /dry run: would copy 42/.test(why()), 3000);
    out.calcBad = await type('1/0', () => $$('.row.is-calc.is-bad').length === 1);

    // files: the pending line first, then rows (or the index's reason) from search.files
    const fq = 'launcher';
    const box = $('#q');
    box.value = fq;
    const t0 = performance.now();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    out.filesPendingSeen = (await until(() => !!$('.grp-status.is-pending'), 1000)) >= 0;
    const settled = await until(() => kinds().indexOf('file') >= 0 || $('.grp-status.is-error') || $('.grp-status.is-empty'), 8000);
    out.filesMs = settled < 0 ? -1 : Math.round(performance.now() - t0);
    out.fileRows = kinds().filter((k) => k === 'file').length;
    out.filesError = $('.grp-status.is-error') ? 'error line shown' : '';
    out.groupsForFiles = groups();
    out.lastIsWeb = kinds()[kinds().length - 1] === 'web';
    out.footer = ($('#counts') || {}).textContent.replace(/[^·\w ]/g, '').slice(0, 120);
    if (out.fileRows) {
      for (let i = 0; i < 8 && sel() && sel().dataset.kind !== 'file'; i++) { key('Tab'); await sleep(20); }
      out.fileEnter = enterOn('file');
      out.fileOpenDry = await until(() => /dry run/.test(why()), 3000);
      out.fileReveal = enterOn('file', { ctrlKey: true });
      out.fileRevealDry = await until(() => /dry run: would run .*(showItemInFolder|select)/.test(why()), 3000);
    }

    out.web = await type('mantle shell', () => $$('.row[data-kind="web"] .name').some((n) => /mantle shell/.test(n.textContent)));
    key('End');
    await sleep(20);
    out.webEnter = enterOn('web');
    out.webDry = await until(() => /dry run/.test(why()) && /google\.com\/search\?q=mantle\+shell/.test(why()), 3000);

    // arrows walk across groups as one list
    await type('se', () => kinds().length > 3);
    const before = Number(sel().dataset.i);
    key('ArrowDown'); key('ArrowDown'); key('ArrowDown');
    await sleep(20);
    out.arrowsMove = Number(sel().dataset.i) === before + 3;
    out.groupsForSe = groups();

    key('Escape');
    out.hideAsked = true;
    return out;
  })();
}

async function run(ctx) {
  const t0 = Date.now();
  let win = null;
  for (let i = 0; i < 50 && !win; i++) { win = launcherWindow(); if (!win) await new Promise((r) => setTimeout(r, 100)); }
  if (!win) { ctx.log('selftest: FAIL no launcher window found'); return; }
  // showLauncher waits for a backdrop frame before it shows the window and broadcasts
  // launcher:visible (the page's reset). Once isVisible() is true that broadcast has been sent,
  // and the script below is queued behind it - so the reset can never land mid-test.
  for (let i = 0; i < 100 && !win.isVisible(); i++) await new Promise((r) => setTimeout(r, 20));
  if (!win.isVisible()) { ctx.log('selftest: FAIL the launcher never became visible after Win+S'); return; }
  let rep;
  try {
    rep = await win.webContents.executeJavaScript('(' + inPage.toString() + ')()', true);
  } catch (err) {
    ctx.log('selftest: FAIL the page script threw: ' + ((err && err.message) || err));
    return;
  }
  const checks = [
    ['opened in search mode', rep.opened >= 0],
    ['search placeholder', rep.placeholder === 'Search apps, files, settings and the web'],
    ['box empty on open', rep.emptyBox],
    ['"blu" -> Bluetooth & devices', rep.settingsBlu >= 0],
    ['"dark mode" -> Colors', rep.settingsDarkMode >= 0],
    ['"wallpaper" -> Background', rep.settingsWallpaper >= 0],
    ['"6*7" -> = 42 first', rep.calc >= 0 && rep.calcFirst],
    ['no Files group for arithmetic', rep.calcNoFileGroup],
    ['calc Enter = dry-run copy', rep.calcEnter === 'pressed' && rep.calcCopyDry >= 0],
    ['1/0 shows a no-answer row', rep.calcBad >= 0],
    ['files: pending line, then rows or a reason', rep.filesPendingSeen && rep.filesMs >= 0],
    ['web row is last', rep.lastIsWeb],
    ['web Enter = dry run with the Google URL', rep.webEnter === 'pressed' && rep.webDry >= 0],
    ['arrows walk across groups', rep.arrowsMove],
  ];
  if (rep.fileRows) {
    checks.push(['file Enter = dry-run open', rep.fileEnter === 'pressed' && rep.fileOpenDry >= 0]);
    checks.push(['file Ctrl+Enter = dry-run reveal', rep.fileReveal === 'pressed' && rep.fileRevealDry >= 0]);
  }
  const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
  ctx.log('selftest timings (ms, input -> row on screen): blu ' + rep.settingsBlu + ', dark mode ' + rep.settingsDarkMode +
          ', wallpaper ' + rep.settingsWallpaper + ', 6*7 ' + rep.calc + ', 1/0 ' + rep.calcBad + ', files ' + rep.filesMs +
          ' (' + rep.fileRows + ' rows' + (rep.filesError ? ', ' + rep.filesError : '') + '), web ' + rep.web);
  ctx.log('selftest groups: "launcher" ' + JSON.stringify(rep.groupsForFiles) + ', "se" ' + JSON.stringify(rep.groupsForSe) + '; footer "' + rep.footer + '"');
  ctx.log('SEARCH SELFTEST: ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed' +
          (failed.length ? ' (' + failed.join('; ') + ')' : '') + ' in ' + (Date.now() - t0) + ' ms');
}

module.exports = { run };
