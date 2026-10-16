#!/usr/bin/env node
// P7: how long Windows' brightness pop-up is ON SCREEN before Mantle parks it, measured on the
// test's own stand-in window (sidecar/test-osd.js startFake: class XamlExplorerHostIslandWindow,
// alpha 0, click-through, never activated, so nothing is ever seen). The sidecar runs --passive with
// the stand-in named (targetPid), so only the stand-in is ever moved; explorer is never touched.
//
// Each showing: the stand-in re-places itself on screen and shows (what explorer does), and the
// brightness change is injected `lagMs` after its SHOW (live probe 2026-09-24: Windows' SHOW leads the
// WmiMonitorBrightnessEvent by ~20 ms). The flash is the stand-in's OWN clock: its show -> the park
// reaching its window (no pipe or IPC in it).
//
//   MANTLE_SIDECAR_EXE=<exe> node tools/osd-bright-flash.js [n=20] [lagMs=20]
'use strict';
const path = require('path');
const { start, startFake } = require(path.join(__dirname, '..', 'sidecar', 'test-osd.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; }

async function main() {
  const n = Number(process.argv[2]) || 20, lag = process.argv[3] != null ? Number(process.argv[3]) : 20;
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  let fake;
  const flash = [];
  let missed = 0;
  try {
    await s.send('ping', {}, 15000);
    fake = await startFake('recentre');
    const w = await s.send('osd.bright', { op: 'watch', on: true, targetPid: fake.pid }, 10000);
    if (!w.ok) throw new Error('watch: ' + JSON.stringify(w));
    await sleep(300);
    for (let i = 0; i < n; i++) {
      await sleep(900);                                   // clear of the last change (AfterMs 800)
      const shown = await fake.cmd('show', 'shown');
      if (lag > 0) await sleep(lag);
      await s.send('osd.bright', { op: 'inject', level: 10 + (i % 80) });
      const moved = await fake.next('moved', 1500);
      if (moved) flash.push(moved.t - shown.t); else missed++;
      await sleep(60);
      await fake.cmd('hide', 'hidden');
    }
  } finally {
    if (fake) fake.quit();
    try { await s.send('osd.bright', { op: 'watch', on: false }, 3000); } catch (e) { /* gone */ }
    s.stop();
  }
  const r = (v) => v == null ? null : Math.round(v * 10) / 10;
  console.log(JSON.stringify({ exe: process.env.MANTLE_SIDECAR_EXE || 'sidecar/bin', n, lagMs: lag, parked: flash.length, missed,
    flashMs: { p50: r(pct(flash, 0.5)), p95: r(pct(flash, 0.95)), max: r(flash.length ? Math.max(...flash) : null) } }));
  setTimeout(() => process.exit(0), 1700);
}
main().catch((e) => { console.error(e.stack); process.exit(1); });
