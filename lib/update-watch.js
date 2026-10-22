'use strict';
/*
 * lib/update-watch.js -- makes sure Mantle comes back after an update, or that Windows does
 * (lane mantle-updater, 2026-10-22).
 *
 * lib/updater.js copies THIS file into <userData> before the update's merge (so the version that started the
 * update is the one that watches it) and runs it detached, as plain node (ELECTRON_RUN_AS_NODE), with one
 * argument: a JSON config file. It must stay self-contained: node's own modules only.
 *
 *   1. wait for the old Mantle (cfg.oldPid) to exit. Its shutdown() has already put Windows back (the
 *      verified restore: app bar removed, the taskbar's auto-hide flag back, read back), as every restart does.
 *      If the old Mantle is still running after a while and the pending record is gone, the update was
 *      called off: exit quietly.
 *   2. wait up to cfg.confirmMs for the NEW Mantle to say it is up: it writes cfg.doneFile with the same id
 *      (updater.confirmStart(), when the updates feature starts).
 *   3. it never said so: a live run runs tools/restore-windows.ps1 (it stops only Mantle and puts the
 *      taskbar back, reading first and writing only what differs, so it is safe if Windows is already fine),
 *      writes cfg.failedFile (the next Mantle shows it), and tells the user in a message box how to start
 *      Mantle again. A --test run never runs the restore script (it would stop the user's real Mantle) and
 *      shows no box (a test never puts a window on the user's screen): the failed file and the log say it.
 *
 * Every step is a line in cfg.logFile.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function realDeps(cfg) {
  return {
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } },
    exists: (f) => fs.existsSync(f),
    readJson,
    writeJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2)),
    sleep,
    now: Date.now,
    log: (line) => { try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} watcher: ${line}\n`); } catch (_) { /* nowhere else to say it */ } },
    restore: (script) => new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
          const out = `${stdout || ''}${stderr || ''}`.trim();
          resolve({ ok: !err && /verified/i.test(out), code: err ? (err.code || 1) : 0, out: out.slice(-1500) });
        });
    }),
    tell: (title, text) => new Promise((resolve) => {
      // The text goes through a file: no quoting of the user's own words into a command line.
      const f = path.join(os.tmpdir(), `mantle-update-message-${process.pid}.txt`);
      try { fs.writeFileSync(f, text, 'utf8'); } catch (_) { resolve(false); return; }
      const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const ps = `Add-Type -AssemblyName PresentationFramework; $t = Get-Content -Raw -Encoding UTF8 -LiteralPath ${lit(f)}; ` +
        `[void][System.Windows.MessageBox]::Show($t, ${lit(title)}, 'OK', 'Warning'); Remove-Item -LiteralPath ${lit(f)} -ErrorAction SilentlyContinue`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
        { windowsHide: false }, (err) => resolve(!err));
    }),
  };
}

/**
 * The whole watch, with its world injected (the tests pass fakes). -> { result: 'up'|'called-off'|'failed', ... }
 */
async function watch(cfg, deps) {
  const d = deps;
  const step = 250;
  const confirmed = () => { const j = d.exists(cfg.doneFile) ? d.readJson(cfg.doneFile) : null; return !!(j && j.id === cfg.id); };
  d.log(`watching the update to ${cfg.tag} (id ${cfg.id}); waiting for pid ${cfg.oldPid} to exit`);
  // 1. the old Mantle exits (its shutdown has a 12 s hard stop; arranging the relaunch can take a few more)
  const exitBy = d.now() + (cfg.exitMs || 120000);
  while (d.alive(cfg.oldPid)) {
    if (!d.exists(cfg.pendingFile) && !confirmed()) { d.log('the pending record is gone while the old Mantle runs: the update was called off'); return { result: 'called-off' }; }
    if (d.now() > exitBy) { d.log(`pid ${cfg.oldPid} is still running after ${Math.round((cfg.exitMs || 120000) / 1000)} s; watching for the new Mantle anyway`); break; }
    await d.sleep(step);
  }
  // 2. the new Mantle says it is up
  const upBy = d.now() + (cfg.confirmMs || 180000);
  while (d.now() <= upBy) {
    if (confirmed()) { d.log('the new Mantle is up'); return { result: 'up' }; }
    await d.sleep(step * 2);
  }
  if (confirmed()) { d.log('the new Mantle is up'); return { result: 'up' }; }
  // 3. it never came: Windows back, then say so
  d.log(`the new Mantle did not say it was up within ${Math.round((cfg.confirmMs || 180000) / 1000)} s`);
  let restore = { ran: false, ok: null, out: 'not run: this was a --test run, and the restore script would stop the real Mantle' };
  if (cfg.live) {
    const r = await d.restore(cfg.restoreScript);
    restore = { ran: true, ok: r.ok, out: r.out };
    d.log(`restore-windows.ps1: ${r.ok ? 'verified' : `NOT verified (exit ${r.code})`}\n${r.out}`);
  }
  const rec = { id: cfg.id, at: d.now(), from: cfg.from, to: cfg.to, tag: cfg.tag, restore, how: cfg.how, log: cfg.logFile };
  try { d.writeJson(cfg.failedFile, rec); } catch (err) { d.log(`the failed record could not be written: ${err.message}`); }
  const text = [
    `Mantle did not start again after updating to ${cfg.tag}.`,
    restore.ran ? (restore.ok ? 'Windows has been put back: the taskbar is back and works as usual.' : 'Mantle tried to put Windows back, and could not confirm it. If the taskbar is missing, press Ctrl+Shift+Esc, find Windows Explorer, and choose Restart.') : '',
    '',
    'To start Mantle again, open a terminal and run:',
    cfg.how || '',
    '',
    `What happened is in: ${cfg.logFile}`,
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
  if (cfg.live) {
    const shown = await d.tell('Mantle did not restart', text);
    d.log(shown ? 'the user was told (message box)' : 'the message box did not show; the failed record and this log say it');
  } else {
    d.log(`test run: no message box; it would have said:\n${text}`);
  }
  return { result: 'failed', restore, text };
}

async function main() {
  const cfg = readJson(process.argv[2] || '');
  if (!cfg || !cfg.id) process.exit(2);
  const r = await watch(cfg, realDeps(cfg));
  process.exit(r.result === 'failed' ? 1 : 0);
}

if (require.main === module) main();

module.exports = { watch, realDeps };
