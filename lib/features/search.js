/* lib/features/search.js — Win+S: Mantle's launcher, opened in search mode, searching everything.
 *
 * Owen, 2026-09-24: replace Windows Search. Win+S opens the launcher with {mode:'search'} (the
 * page shows the search placeholder); the launcher's box - also when he just taps Win and types -
 * searches apps, commands, ~100 Settings pages, arithmetic, files in the Windows Search index,
 * and ends with "Search the web for …". The page side is ui/launcher/* (calc.js, groups.js).
 *
 * OFF (the tray checkbox) = Win+S goes back to Windows. The launcher keeps its search either way:
 * it is Mantle's own window, and these commands only do what its rows already ask for.
 *
 * What it adds to the launcher that main.js did not already give it (the page is ui/launcher/*):
 *   search.files     file rows through sidecar/SearchIndex.cs (`search.files`: prefix > word >
 *                    contains, latest-wins), same shape as main's launcher.files
 *   search.openFile  open / show-in-folder for a file row, a DRY RUN in --test
 *   search.copy      the calculator row's Enter: copy the answer (worked out again here), DRY RUN in --test
 *   search.web       "Search the web for …", DRY RUN in --test
 *   search.status    the Windows Search service / index report (sidecar `search.status`)
 * and the Win+S chord, which opens the launcher with {mode:'search'}.
 *
 * HEALTH. Win+S is only taken from Windows while this is healthy. A stopped WSearch service or an
 * unindexed profile does NOT make it unhealthy: apps, Settings, the calculator and the web row all
 * still work, and the Files group says why it has nothing. Unhealthy = the launcher itself cannot
 * be opened, which is the one thing Win+S is for.
 */
'use strict';
const index = require('../launcher-index.js');

module.exports = {
  name: 'search',
  label: 'Search (Win+S)',
  defaultOn: true,
  chords: ['Win+S'],
  observe: [],
  install(ctx) {
    const dryRun = !!ctx.flags.test;          // a test instance never opens, launches or copies
    let clipboard = null;
    try { clipboard = require('electron').clipboard; } catch (_) { /* outside Electron: copy says so */ }

    // launcher-index's files() wants (cmd, args, ms) -> result, throwing the sidecar's words
    const sidecar = (cmd, args, ms) => ctx.sidecar.send(cmd, args, { timeoutMs: ms }).then((r) => {
      if (!r.ok) throw new Error(r.error || 'the sidecar answered without a reason');
      return r.result;
    });

    ctx.command('files', (a) => index.files(a, { sidecar, cmd: 'search.files' }));
    ctx.command('openFile', (a) => index.openFile(a, { dryRun }));
    ctx.command('copy', async (a) => index.copyCalc(a, { dryRun, clipboard }));
    ctx.command('web', (a) => index.openWeb(a, { dryRun }));
    ctx.command('status', async (a) => {
      const r = await ctx.sidecar.send('search.status', { fresh: !!(a && a.fresh) }, { timeoutMs: 4000 });
      return r.ok ? r.result : { ok: false, reason: 'the sidecar could not report on Windows Search: ' + r.error };
    });

    ctx.onChord('Win+S', () => {
      try {
        ctx.host.openLauncher({ mode: 'search' });
      } catch (err) {
        ctx.health(false, 'Win+S cannot open the launcher: ' + ((err && err.message) || err));
        return;
      }
      // TEST ONLY, and only when asked for: drive the opened launcher page through a scripted
      // search (dry runs only) and log counts and timings. Never loaded in a live run.
      if (ctx.test && process.env.MANTLE_SEARCH_SELFTEST === '1') {
        require('./_search-selftest.js').run(ctx).catch((err) => ctx.log('selftest crashed: ' + ((err && err.stack) || err)));
      }
    });

    // The index's state, once per sidecar start, into mantle.log (the page shows it per query).
    ctx.sidecar.onReady(async () => {
      const r = await ctx.sidecar.send('search.status', {}, { timeoutMs: 4000 });
      if (!r.ok) { ctx.log('Windows Search status unavailable: ' + r.error); return; }
      const s = r.result || {};
      ctx.log('Windows Search: service ' + s.service + ', profile indexed ' + s.scopeIndexed + (s.reason ? ' (' + s.reason + ')' : ''));
    });
    ctx.health(true, 'Win+S opens the launcher in search mode');

    return { stop() { /* nothing in Windows was changed: the chord goes back via the seam */ } };
  },
};
