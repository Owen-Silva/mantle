'use strict';
/*
 * lib/packaged.js -- what a copy installed by Mantle-Setup.exe does when it is started (lane inst-mantle,
 * 2026-10-29). Pure: no Electron here, so lib/packaged.test.js proves every decision with plain node.
 * lib/packaged-entry.js is the installed copy's entry point and does what this module decides.
 *
 * WHY: a clone goes live only when asked by name (`npm run live`, `electron . --live`), and prints the way
 * back before it touches anything. An installed copy has no terminal: it is started from the Start menu, from
 * the installer's last step, or from the "Mantle" logon task. So the same promise is kept with a window:
 *
 *   - a plain start (no --live, --test, --quit or --open) with no consent on record shows the warning
 *     (dialogOptions below): what Mantle changes, "at your own risk", every way to get Windows back, and an
 *     opt-in for starting at sign-in that is OFF. "Not now" changes nothing and leaves nothing behind.
 *     "Start Mantle" records the consent (CONSENT_FILE in Mantle's profile) and starts Mantle live.
 *   - a plain start with consent on record starts Mantle live, as `npm run live` would.
 *   - --live, --test, --quit and --open pass straight through, exactly as in a clone.
 *
 * Every live start of an installed copy writes its log to <profile>\mantle.log (--log=), because there is
 * no console to print the recovery lines to.
 */
const path = require('path');

const CONSENT_FILE = 'installed-consent.json';
const START_MENU_RESTORE = 'Start > All apps > Mantle > Restore Windows taskbar';

/** Does argv already say what to do? (the flags lib/args.js treats as a decision) */
function decided(argv) {
  return argv.some((a) => typeof a === 'string' && (a === '--live' || a === '--test' || a === '--quit' || a === '--open' || a.startsWith('--open=')));
}

/**
 * argv: process.argv.slice(1) of the installed Mantle.exe. consent: readConsent's answer. log: the log path.
 * -> { action: 'run', argv, why } (start main.js with this argv) or { action: 'ask', why } (show the warning).
 */
function plan(argv, consent, log) {
  const a = Array.isArray(argv) ? argv.filter((x) => typeof x === 'string') : [];
  const hasLog = a.some((x) => x.startsWith('--log='));
  const withLog = (list) => (hasLog || !log ? list : list.concat([`--log=${log}`]));
  if (a.includes('--live')) return { action: 'run', argv: withLog(a), why: 'asked for --live by name' };
  if (decided(a)) return { action: 'run', argv: a, why: 'a test run or a message to a running Mantle, as in a clone' };
  if (consent && consent.ok && consent.accepted) return { action: 'run', argv: withLog(a.concat(['--live'])), why: `the warning was accepted on ${consent.at || 'an earlier start'}` };
  return { action: 'ask', why: consent && consent.reason ? consent.reason : 'the warning has not been accepted yet' };
}

/** -> { ok: true, accepted, at } or { ok: false, accepted: false, reason } (a file that cannot be read is said, never guessed). */
function readConsent(dir, fsImpl) {
  const fs = fsImpl || require('fs');
  const file = path.join(dir, CONSENT_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, accepted: false, at: null };
    return { ok: false, accepted: false, reason: `${file} could not be read (${(err && err.code) || (err && err.message) || err}), so the warning is shown again` };
  }
  let j;
  try { j = JSON.parse(String(text).replace(/^﻿/, '')); } catch (err) {
    return { ok: false, accepted: false, reason: `${file} is not readable JSON (${err.message}), so the warning is shown again` };
  }
  if (!j || j.accepted !== true) return { ok: true, accepted: false, at: null };
  return { ok: true, accepted: true, at: typeof j.at === 'string' ? j.at : null };
}

/** Records the consent: written to a temp file and renamed, so a half-written file is never read. -> { ok, file } or { ok: false, reason } */
function writeConsent(dir, info, fsImpl) {
  const fs = fsImpl || require('fs');
  const file = path.join(dir, CONSENT_FILE);
  const body = JSON.stringify(Object.assign({ accepted: true }, info || {}), null, 2) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: `Mantle could not record your answer in ${file} (${(err && err.code) || (err && err.message) || err}), so it did not start` };
  }
}

/** The warning, as Electron dialog.showMessageBox options. Button 0 starts Mantle; Esc, the close box and button 1 do nothing. */
function dialogOptions() {
  return {
    type: 'warning',
    title: 'Mantle',
    message: 'Start Mantle over your Windows taskbar?',
    detail: [
      'Mantle puts the Windows taskbar on auto-hide and draws its own bar, launcher and desktop over it. While it runs it also answers the Win key, Alt+Tab and notification pop-ups. Explorer keeps running underneath.',
      '',
      'Use it at your own risk: Mantle is built and tested on one Windows 11 PC.',
      '',
      'To get Windows back:',
      '•  Quit Mantle from the ••• menu on its bar, or press Ctrl+Alt+Shift+Backspace anywhere.',
      `•  If the taskbar stays hidden: ${START_MENU_RESTORE}.`,
      '•  Last resort: Ctrl+Shift+Esc, select Windows Explorer, then Restart.',
      '•  Uninstalling Mantle puts Windows back before it removes anything.',
      '',
      'Nothing has changed yet.',
    ].join('\n'),
    buttons: ['Start Mantle', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    checkboxLabel: 'Also start Mantle when I sign in',
    checkboxChecked: false,
  };
}

/** The command that registers the "Mantle" logon task for this installed exe (tools/install-autostart.ps1 -Exe). */
function autostartCommand(root, exe) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'install-autostart.ps1'), '-Exe', exe],
  };
}

/** The relaunch after "Start Mantle": live, with the log. */
function liveArgs(log) {
  return ['--live', `--log=${log}`];
}

module.exports = { CONSENT_FILE, START_MENU_RESTORE, decided, plan, readConsent, writeConsent, dialogOptions, autostartCommand, liveArgs };
