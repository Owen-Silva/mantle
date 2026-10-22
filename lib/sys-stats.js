'use strict';
const os = require('os');

/*
 * CPU, memory and battery for the desktop tile.
 *
 * WHY no native module: this process runs all day behind everything the user does.
 * os.cpus() already carries per-core busy/idle tick totals, so a percentage is a
 * subtraction between two calls -- no sampler thread, no polling loop of our own,
 * no dependency. The desktop page asks every five seconds and the difference is
 * measured across exactly that gap.
 *
 * Battery is the one thing Node cannot see, and it is NOT read here any more
 * (2026-09-23). This file used to spawn PowerShell for Win32_Battery, which
 * disagreed with Windows' own icon: 71 % where Windows said 72 (WMI truncates),
 * "charging" for any laptop on AC (BatteryStatus 2 only means that), up to a
 * minute stale, and one slow PowerShell start (killed at 5 s) marked the machine
 * battery-less for the rest of the session. main.js now hands stats() the
 * sidecar's reading (sidecar/Battery.cs: GetSystemPowerStatus, pushed on
 * change), and this only reshapes it for the tile.
 */

let prevCpu = null;      // {idle, total} from the last call

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

/** 0-100 busy percentage since the previous call (first call: since boot). */
function cpuPercent() {
  const now = cpuTotals();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) {
    // No previous sample yet, so this is the average since boot. It is a real
    // number, just a slow-moving one; the next call five seconds later is live.
    return clampPct(100 * (1 - now.idle / Math.max(1, now.total)));
  }
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  if (dTotal <= 0) return 0;
  return clampPct(100 * (1 - dIdle / dTotal));
}

function clampPct(n) {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The tile's {battery, batteryReason} from one sidecar reading (Battery.cs), or
 * from nothing. battery is {percent, charging, plugged} or null; the reason keeps
 * the two strings the desktop tile tests for: 'ok', and 'this machine reports no
 * battery' (the one null that needs no explanation on screen). `charging` now
 * means charging: a laptop on AC held at a charge limit is plugged, not charging.
 */
function tileBattery(r) {
  if (!r || typeof r !== 'object') return { battery: null, batteryReason: 'no battery reading has arrived yet' };
  if (r.ok === false) return { battery: null, batteryReason: r.reason || 'the battery reading failed, and it gave no reason' };
  if (r.present === false) return { battery: null, batteryReason: 'this machine reports no battery' };
  if (typeof r.percent !== 'number') return { battery: null, batteryReason: r.reason || 'Windows does not know the battery percentage yet' };
  return {
    battery: { percent: r.percent, charging: r.charging === true, plugged: r.ac === true },
    batteryReason: 'ok',
  };
}

/**
 * The whole tile's worth of numbers. {cpu, memUsed, memTotal, battery, batteryReason}.
 * `readBattery` is main's: an async function answering the sidecar's latest
 * reading. It may reject; the tile then says why instead of losing the line.
 */
async function stats(readBattery) {
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  let tile;
  try {
    tile = tileBattery(readBattery ? await readBattery() : null);
  } catch (err) {
    tile = { battery: null, batteryReason: `the battery cannot be read: ${err.message}` };
  }
  return { cpu: cpuPercent(), memUsed, memTotal, battery: tile.battery, batteryReason: tile.batteryReason };
}

module.exports = { stats, cpuPercent, tileBattery };
