'use strict';
/*
 * tools/toast-poster.js - posts SILENT test toasts from a throwaway app id, with a precise post time
 * (lane mantle-toastfast, 2026-10-16), for the tests that time a toast's way to Mantle's banner.
 *
 *   const P = require('../tools/toast-poster');
 *   const p = await P.open();            // registers Mantle.ToastTest.fast<random>, ShowBanner 0 FIRST
 *   const r = await p.post('title');     // { title, before, after }: epoch ms around Show(), sub-ms
 *   await p.clear();                     // removes every toast this id posted from Windows' centre
 *   await p.close();                     // clear + delete the id's registry keys, pass or fail
 *
 * NEVER OWEN'S APPS: the only id is Mantle.ToastTest.fast<random>. Its Notifications\Settings key is
 * made with ShowBanner 0 BEFORE the first post, so Windows never pops a banner on Owen's screen, and a
 * live Mantle leaves Mantle.ToastTest* ids to Windows (_toasts-owner.js leftToWindows), so it draws none
 * either; a --test Mantle manages ONLY those ids. The toasts are silent (<audio silent="true"/>).
 * ONE PowerShell process posts them all (stdin lines), so a post costs no PowerShell start; the stamps
 * come from GetSystemTimePreciseAsFileTime, the same clock as Date.now() in node and in Electron.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const AUMID_KEY = 'HKCU\\Software\\Classes\\AppUserModelId';
const reg = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });

const PS1 = `param([string]$Aumid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MantlePT { [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long t); public static double Now() { long t; GetSystemTimePreciseAsFileTime(out t); return (t - 116444736000000000L) / 10000.0; } }'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$inv = [Globalization.CultureInfo]::InvariantCulture
$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'quit') { break }
  try {
    if ($line -eq 'clear') { [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($Aumid); [Console]::Out.WriteLine('cleared'); continue }
    $title = [Security.SecurityElement]::Escape($line)
    $x = New-Object Windows.Data.Xml.Dom.XmlDocument
    $x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>A test from Mantle. It goes away by itself.</text></binding></visual><audio silent="true"/></toast>')
    $t = [Windows.UI.Notifications.ToastNotification]::new($x)
    $t.Tag = 'f' + [Math]::Abs($line.GetHashCode()); $t.Group = 'mantle'
    $a = [MantlePT]::Now(); $n.Show($t); $b = [MantlePT]::Now()
    [Console]::Out.WriteLine('posted ' + $a.ToString('F3', $inv) + ' ' + $b.ToString('F3', $inv))
  } catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message) }
}
`;

async function open(opts) {
  const o = opts || {};
  const aumid = o.aumid || 'Mantle.ToastTest.fast' + Math.random().toString(36).slice(2, 8);
  if (!/^Mantle\.ToastTest/.test(aumid)) throw new Error('toast-poster posts only from Mantle.ToastTest* ids');
  reg(['add', `${AUMID_KEY}\\${aumid}`, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Mantle test', '/f']);
  reg(['add', `${SET}\\${aumid}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
  const q = reg(['query', `${SET}\\${aumid}`, '/v', 'ShowBanner']);
  if (q.status !== 0 || !/ShowBanner\s+REG_DWORD\s+0x0\b/i.test(q.stdout)) {
    cleanupKeys(aumid);
    throw new Error(`could not set ShowBanner 0 for ${aumid} first, so nothing is posted (Windows would pop its own banner)`);
  }
  const file = path.join(os.tmpdir(), `mantle-toast-poster-${process.pid}.ps1`);
  fs.writeFileSync(file, PS1);
  const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Aumid', aumid], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  const waiters = [];
  const lines = [];
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const w = waiters.shift();
      if (w) w(line); else lines.push(line);
    }
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const next = (ms) => new Promise((res, rej) => {
    if (lines.length) return res(lines.shift());
    const t = setTimeout(() => { const k = waiters.indexOf(fn); if (k >= 0) waiters.splice(k, 1); rej(new Error(`the poster did not answer within ${ms} ms${stderr ? ': ' + stderr.slice(0, 300) : ''}`)); }, ms);
    const fn = (l) => { clearTimeout(t); res(l); };
    waiters.push(fn);
  });
  let closed = false;
  const p = {
    aumid,
    async post(title) {
      proc.stdin.write(String(title).replace(/[\r\n]/g, ' ') + '\n');
      const l = await next(15000);
      const m = /^posted (\d+\.\d+) (\d+\.\d+)$/.exec(l);
      if (!m) throw new Error(`post failed: ${l}`);
      return { title, before: Number(m[1]), after: Number(m[2]) };
    },
    async clear() { proc.stdin.write('clear\n'); const l = await next(15000); if (l !== 'cleared') throw new Error(`clear failed: ${l}`); },
    async close() {
      if (closed) return; closed = true;
      try { await p.clear(); } catch (_) { /* the keys still go */ }
      try { proc.stdin.write('quit\n'); } catch (_) { /* gone */ }
      await new Promise((res) => { const t = setTimeout(() => { try { proc.kill(); } catch (_) { /* gone */ } res(); }, 3000); proc.on('exit', () => { clearTimeout(t); res(); }); });
      try { fs.unlinkSync(file); } catch (_) { /* gone */ }
      cleanupKeys(aumid);
    },
  };
  try {
    const first = await next(30000);
    if (first !== 'ready') throw new Error(`the poster did not start: ${first}`);
  } catch (e) { await p.close(); throw e; }
  return p;
}

function cleanupKeys(aumid) {
  for (const k of [`${SET}\\${aumid}`, `${AUMID_KEY}\\${aumid}`]) reg(['delete', k, '/f']);
}

/** p50 / p95 / max of a list of numbers (nearest rank). */
function stats(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { n: s.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]), min: Math.round(s[0]) };
}

module.exports = { open, stats };
