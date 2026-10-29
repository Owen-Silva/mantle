'use strict';
/*
 * lib/packaged-entry.js -- the entry point of a copy installed by Mantle-Setup.exe ONLY.
 *
 * installer/electron-builder.yml sets "main" to this file in the installed copy's package.json
 * (extraMetadata). A clone's package.json says "main": "main.js", so a clone never loads this file and
 * behaves exactly as before. What it decides is in lib/packaged.js (and proven by lib/packaged.test.js).
 *
 *   run -> rewrite process.argv (e.g. add --live and --log=) and load main.js, unchanged, in this process.
 *          Nothing has run before it but this file, so main.js's own pre-ready work (command-line switches,
 *          the single-instance lock, the --live gate) happens exactly as it does in a clone.
 *   ask -> the first-start warning. This process never loads main.js and never touches the shell: on
 *          "Start Mantle" it records the consent, registers the logon task if that box was ticked, then
 *          relaunches itself with --live and exits. "Not now" exits and changes nothing.
 */
const path = require('path');
const os = require('os');
const { app } = require('electron');
const P = require('./packaged');

const ROOT = path.join(__dirname, '..');
const profile = app.getPath('userData');            // %APPDATA%\mantle: the profile main.js uses
const log = path.join(profile, 'mantle.log');
const decision = P.plan(process.argv.slice(1), P.readConsent(profile), log);

if (decision.action === 'run') {
  process.argv.splice(1, process.argv.length - 1, ...decision.argv);
  require('../main.js');
} else {
  firstStart();
}

function firstStart() {
  const { dialog } = require('electron');
  // This process shows one box. Its own Chromium files go to a temp folder, so Mantle's profile gets
  // nothing from it but the consent (lib/welcome.js reads that profile to decide the welcome tour).
  app.setPath('userData', path.join(os.tmpdir(), 'mantle-first-start'));
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }   // the box is already up
  app.on('window-all-closed', () => { /* there are no windows; the box decides when to exit */ });
  app.whenReady().then(async () => {
    let r;
    try {
      r = await dialog.showMessageBox(P.dialogOptions());
    } catch (err) {
      dialog.showErrorBox('Mantle did not start', `The first-start warning could not be shown (${err.message}). Nothing was changed.`);
      app.exit(1);
      return;
    }
    if (!r || r.response !== 0) { app.exit(0); return; }          // Not now: nothing changed
    const w = P.writeConsent(profile, { at: new Date().toISOString(), version: app.getVersion(), autostart: !!r.checkboxChecked });
    if (!w.ok) { dialog.showErrorBox('Mantle did not start', `${w.reason}. Nothing was changed.`); app.exit(1); return; }
    if (r.checkboxChecked) {
      const a = registerAutostart();
      if (!a.ok) {
        await dialog.showMessageBox({ type: 'warning', title: 'Mantle', noLink: true, buttons: ['OK'],
          message: 'Mantle will not start when you sign in',
          detail: `${a.reason}\n\nMantle starts now anyway. Start it from the Start menu next time.` });
      }
    }
    app.relaunch({ args: P.liveArgs(log) });
    app.exit(0);
  });
}

/** tools/install-autostart.ps1 -Exe <this Mantle.exe>, waited for. -> { ok } or { ok: false, reason } */
function registerAutostart() {
  const { execFileSync } = require('child_process');
  const c = P.autostartCommand(ROOT, process.execPath);
  try {
    execFileSync(c.file, c.args, { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const said = String((err && err.stdout) || '').trim().split(/\r?\n/).filter(Boolean).pop();
    return { ok: false, reason: said || `the "Mantle" logon task could not be registered (${err.message})` };
  }
}
