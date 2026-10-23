'use strict';
/*
 * lib/update-watch.test.js -- the restart watcher's LIVE restore road, run for real (lane mantle-verify, 2026-10-22).
 *
 * lib/updater.test.js drives watch() with every dependency faked. This file runs the watcher's REAL restore
 * step (realDeps().restore: powershell.exe -File <cfg.restoreScript> -SparePid <its pid>, judged by the word
 * "verified") with cfg.live = true, the case where the new Mantle never says it is up, but against a STUB
 * restore script written into a fresh temp folder. So:
 *   - tools/restore-windows.ps1 is never run (the test refuses to start if the configured script is it, or is
 *     outside its temp folder): the real one stops Mantle and writes the taskbar's auto-hide flag, which is
 *     the user's live shell;
 *   - the stub only appends a line to a file beside itself;
 *   - the message box (realDeps().tell) is replaced by a recorder: a test never puts a window on the screen.
 * Not covered here, and why: the real restore script (it would touch the live taskbar) and the message box
 * itself (a window on the screen).
 *
 *   node lib/update-watch.test.js   -> "UPDATE WATCH TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { watch, realDeps } = require('./update-watch');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ` -- ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''));
  return ok;
}

const ROOT = path.join(__dirname, '..');
const REAL_RESTORE = path.resolve(ROOT, 'tools', 'restore-windows.ps1');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-watch-live-'));

/** A stand-in restore script: says it ran (and with which -SparePid) in ran.txt beside itself, touches nothing else. */
function stub(name, { ok }) {
  const dir = path.join(T, name);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'restore-stub.ps1');
  fs.writeFileSync(file, [
    'param([int]$SparePid = 0)',
    '# lib/update-watch.test.js: a stand-in for tools/restore-windows.ps1. It touches nothing; it only says it ran.',
    "Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ran.txt') -Value \"SparePid=$SparePid\"",
    ok ? "Write-Output 'restore stub: Windows is back (verified)'; exit 0"
      : "Write-Output 'restore stub: the taskbar could not be read back'; exit 1",
    '',
  ].join('\r\n'));
  return { dir, file, ran: path.join(dir, 'ran.txt') };
}
/** Refuse anything but a stub inside T: the real script must never run from a test. */
function safe(script) {
  const p = path.resolve(script);
  return p.toLowerCase() !== REAL_RESTORE.toLowerCase() && p.toLowerCase().startsWith(T.toLowerCase() + path.sep) && path.basename(p) === 'restore-stub.ps1';
}
function cfgFor(dir, script, id) {
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;   // the old Mantle, already gone
  return { id, oldPid: dead, pendingFile: path.join(dir, 'update-pending.json'), doneFile: path.join(dir, 'update-done.json'),
    failedFile: path.join(dir, 'update-failed.json'), releaseFile: path.join(dir, 'update-failed-release.json'), logFile: path.join(dir, 'update.log'), confirmMs: 800, exitMs: 2000,
    live: true, restoreScript: script, from: 'aaaaaaa1111', to: 'bbbbbbb2222', tag: 'v9.9.9', how: 'cd "C:\\the\\mantle\\folder"\nnpm run live' };
}
async function run(cfg) {
  const told = [];
  const order = [];
  const real = realDeps(cfg);
  const deps = Object.assign({}, real, {
    restore: async (script) => { order.push('restore'); return real.restore(script); },
    writeJson: (f, v) => { order.push('failed-record'); return real.writeJson(f, v); },
    tell: async (title, text) => { order.push('tell'); told.push({ title, text }); return true; },   // never a message box
  });
  const r = await watch(cfg, deps);
  const log = (() => { try { return fs.readFileSync(cfg.logFile, 'utf8'); } catch (_) { return ''; } })();
  const rec = (() => { try { return JSON.parse(fs.readFileSync(cfg.failedFile, 'utf8')); } catch (_) { return null; } })();
  return { r, told, order, log, rec };
}

async function main() {
  // 1. the stub says verified: Windows "back", then the user told, in that order
  {
    const s = stub('ok', { ok: true });
    const cfg = cfgFor(s.dir, s.file, 'live-1');
    fs.writeFileSync(cfg.pendingFile, JSON.stringify({ id: 'live-1', tag: 'v9.9.9' }));
    if (!check('the configured restore script is the stub in the test\'s temp folder, never tools/restore-windows.ps1', safe(cfg.restoreScript), cfg.restoreScript)) return;
    const { r, told, order, log, rec } = await run(cfg);
    const ran = fs.existsSync(s.ran) ? fs.readFileSync(s.ran, 'utf8').trim().split(/\r?\n/) : [];
    check('never up within confirmMs (live): the watcher gives up with "failed"', r.result === 'failed', r);
    check('it ran the restore script once, through powershell -File, with -SparePid = its own pid', ran.length === 1 && ran[0] === `SparePid=${process.pid}`, ran);
    check('restore first, then the failed record, then the user told', order.join(',') === 'restore,failed-record,tell', order);
    check('the failed record: restore ran and was verified, with the tag, the commits and the way back', rec && rec.restore && rec.restore.ran === true && rec.restore.ok === true &&
      /verified/.test(rec.restore.out) && rec.tag === 'v9.9.9' && rec.from === cfg.from && rec.how === cfg.how && rec.log === cfg.logFile, rec);
    const t = told[0] || {};
    check('the message: titled, says Windows is back, how to start Mantle again, and where the log is', t.title === 'Mantle did not restart' && /did not start again after updating to v9\.9\.9/.test(t.text) &&
      /Windows has been put back/.test(t.text) && t.text.includes(cfg.how) && t.text.includes(cfg.logFile), t);
    check('the pending record is removed, so a Mantle started by hand does not call this an update', !fs.existsSync(cfg.pendingFile));
    const mem = (() => { try { return JSON.parse(fs.readFileSync(cfg.releaseFile, 'utf8')); } catch (_) { return null; } })();
    check('the release that did not start is recorded for the next check (tag, commit, from, reason), with no temp file left', mem && mem.tag === 'v9.9.9' && mem.sha === cfg.to && mem.from === cfg.from &&
      mem.reason === 'it did not finish starting within 1 second' && mem.skipped === false && fs.readdirSync(s.dir).every((f) => !/\.tmp-/.test(f)), mem);
    check('the log: gave up after the limit, restore verified, the user told', /did not say it was up within 1 s/.test(log) && /restore-windows\.ps1: verified/.test(log) && /the user was told \(message box\)/.test(log), log.slice(-700));
  }
  // 2. the stub cannot confirm: the record and the message say so, and how to get the taskbar back by hand
  {
    const s = stub('fails', { ok: false });
    const cfg = cfgFor(s.dir, s.file, 'live-2');
    if (!check('(2) the configured restore script is the stub, never the real one', safe(cfg.restoreScript), cfg.restoreScript)) return;
    const { r, told, log, rec } = await run(cfg);
    check('restore not verified (exit 1): still "failed", the stub ran once', r.result === 'failed' && fs.existsSync(s.ran) && fs.readFileSync(s.ran, 'utf8').trim() === `SparePid=${process.pid}`, r);
    check('the failed record says the restore ran and was NOT verified, with its words', rec && rec.restore.ran === true && rec.restore.ok === false && /could not be read back/.test(rec.restore.out), rec);
    const t = told[0] || {};
    check('the message says it could not confirm, and how to get the taskbar back (Task Manager, restart Explorer)', /could not confirm it/.test(t.text) && /Windows Explorer/.test(t.text) && t.text.includes(cfg.how), t.text);
    check('the log says NOT verified (exit 1)', /restore-windows\.ps1: NOT verified \(exit 1\)/.test(log), log.slice(-500));
  }
  // 3. the new Mantle confirms just in time: no restore, no message (the live road stays quiet when all is well)
  {
    const s = stub('up', { ok: true });
    const cfg = cfgFor(s.dir, s.file, 'live-3');
    cfg.confirmMs = 5000;
    setTimeout(() => fs.writeFileSync(cfg.doneFile, JSON.stringify({ id: 'live-3', pid: process.pid })), 600);
    const { r, told, order } = await run(cfg);
    check('confirmed within the limit (live): "up", the stub never ran, nothing told', r.result === 'up' && !fs.existsSync(s.ran) && told.length === 0 && order.length === 0, { r, order });
  }
}

main().catch((err) => { failures.push(`threw: ${err && err.stack ? err.stack : err}`); }).finally(() => {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* a temp folder */ }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`UPDATE WATCH TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
});
