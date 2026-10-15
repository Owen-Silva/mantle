'use strict';
/*
 * lib/features/quicklinks.js - Win+X: the launcher's Quick links mode, in place of Windows' Win+X
 * menu (lane keysrun, 2026-10-15; plan notes/mantle-replace-windows.md P9). Owen uses Win+X.
 *
 * NO NEW WINDOW: the launcher Mantle already has, in mode 'quick' (ctx.host.openLauncher). The rows
 * and their keys are lib/quick-links.js, Windows' own labels and underlined letters; the page draws
 * them with no round trip. Win+X again while the menu is up closes it, as Windows' does (the page).
 *
 * quicklinks.open {link} -> { ok, reason?, dryRun? }. The page sends a row's ID only; what it runs
 * comes from the table here, never from the page:
 *   settings  -> Mantle Settings where it claims the page, else Windows Settings (launcher-index launch)
 *   mantle    -> Mantle's Task Manager / Settings / Files, each falling back to Windows' when off
 *   exec      -> ShellExecuteEx of a Windows tool (eventvwr.msc, devmgmt.msc, ...), via run.exec
 *   terminal  -> Windows Terminal (wt.exe), or Windows PowerShell where Terminal is not installed;
 *                (Admin) asks Windows' UAC prompt ("runas")
 *   desktop   -> Win+D's minimise-all / restore toggle (sidecar hotcorners.desktop)
 * Search, Run and Shut down or sign out are the page's own (modes and a submenu over launcher.power).
 * --test: every one a dry run.
 */
const QL = require('../quick-links');
const { makeExec, probe, helperProblem } = require('./_run-exec');

const CHORD = 'Win+X';
const READY = 'Win+X opens the launcher\'s Quick links';

module.exports = {
  name: 'quicklinks',
  label: 'Quick links (Win+X)',
  defaultOn: true,
  rest: true,                 // the launcher closes while a game runs: Win+X is Windows' then
  chords: [CHORD],
  observe: [],
  install(ctx) {
    const dryRun = !!ctx.flags.test;
    const fgGrant = require('../fg-grant');
    const ex = makeExec(ctx, { dryRun, grant: () => fgGrant.grant(ctx.sidecar.pid) });

    async function terminal(admin) {
      const r = await ctx.sidecar.send('run.resolve', { file: 'wt.exe' }, { timeoutMs: 3000 });
      const wt = r.ok && r.result && r.result.found;
      const res = await ex.exec({ file: wt ? 'wt.exe' : 'powershell.exe', params: '', admin });
      if (res.ok && !wt) res.reason = 'Windows Terminal isn\'t installed, so Windows PowerShell opened instead.';
      return res;
    }

    ctx.command('open', async (a) => {
      const link = QL.byId(a && typeof a.link === 'string' ? a.link : '');
      if (!link || !link.run) return { ok: false, reason: 'That quick link isn\'t one Mantle knows.' };
      const name = QL.parse(link.label).text;
      const run = link.run;
      let res;
      switch (run.kind) {
        case 'settings': res = await ex.open({ kind: 'setting', name, path: run.uri }); break;
        case 'mantle': res = await ex.open({ kind: 'setting', mantleApp: true, name, path: run.path }); break;
        case 'exec': res = await ex.exec({ file: run.file, params: '', admin: false }); break;
        case 'terminal': res = await terminal(!!run.admin); break;
        case 'desktop': {
          if (!ctx.sidecar.ready) { res = { ok: false, reason: ex.HELPER_DOWN }; break; }
          const r = await ctx.sidecar.send('hotcorners.desktop', { dryRun }, { timeoutMs: 3000 });
          res = r.ok ? { ok: true, dryRun: dryRun || undefined, reason: dryRun ? 'dry run: would show the desktop' : undefined }
            : { ok: false, reason: helperProblem(r.error) };
          break;
        }
        default: res = { ok: false, reason: `Mantle doesn't know how to open ${name}.` };
      }
      ctx.log(`${link.id}: ${res.ok ? (res.dryRun ? 'dry run' : 'opened') : 'refused'}`);
      return Object.assign({ link: link.id }, res);
    });

    ctx.sidecar.onReady(() => probe(ctx, READY));
    ctx.onChord(CHORD, () => {
      try {
        ctx.host.openLauncher({ mode: 'quick' });
      } catch (err) {
        ctx.health(false, 'Win+X cannot open the launcher: ' + ((err && err.message) || err));
      }
    });
    ctx.health(true, READY);
    return { stop() { /* nothing in Windows was changed: the chord goes back via the seam; nothing polls */ } };
  },
};
