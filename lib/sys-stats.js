'use strict';
const os = require('os');
const { spawn } = require('child_process');

/*
 * CPU, memory and battery for the desktop tile.
 *
 * WHY no native module: this process runs all day behind everything Owen does.
 * os.cpus() already carries per-core busy/idle tick totals, so a percentage is a
 * subtraction between two calls -- no sampler thread, no polling loop of our own,
 * no dependency. The desktop page asks every five seconds and the difference is
 * measured across exactly that gap.
 *
 * Battery is the one thing Node cannot see. Win32_Battery through PowerShell can,
 * but spawning a process is not free, so we probe once at startup: no battery
 * (a desktop) means we never probe again and report null forever. A battery means
 * a re-probe at most once a minute, cached in between.
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

const battery = {
  supported: null,        // null = not probed yet, false = no battery on this machine
  value: null,            // {percent, charging}
  at: 0,
  reason: 'battery has not been probed yet',
  inflight: null,
};

const BATTERY_MAX_AGE_MS = 60 * 1000;

/**
 * Resolve {percent, charging} or null. Never rejects: a machine with no battery
 * and a machine whose WMI is unhappy both just mean "no battery line on the tile",
 * and the reason is available on batteryReason() for anything that wants to say why.
 */
function readBattery() {
  if (battery.supported === false) return Promise.resolve(null);
  if (battery.value && Date.now() - battery.at < BATTERY_MAX_AGE_MS) return Promise.resolve(battery.value);
  if (battery.inflight) return battery.inflight;

  // BatteryStatus 2 means "AC power" in the CIM schema, i.e. plugged in.
  const script = '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
    'if ($b) { "{0} {1}" -f $b.EstimatedChargeRemaining, $b.BatteryStatus } else { "none" }';

  battery.inflight = new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      battery.supported = false;
      battery.reason = `could not read the battery: ${err.message}`;
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 5000);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      battery.supported = false;
      battery.reason = `could not read the battery: ${err.message}`;
      resolve(null);
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text || text === 'none') {
        battery.supported = false;
        battery.value = null;
        battery.reason = 'this machine reports no battery';
        resolve(null);
        return;
      }
      const m = text.match(/(\d+)\s+(\d+)/);
      if (!m) {
        battery.supported = false;
        battery.reason = `the battery query answered something unexpected: "${text.slice(0, 80)}"`;
        resolve(null);
        return;
      }
      battery.supported = true;
      battery.value = { percent: Number(m[1]), charging: Number(m[2]) === 2 };
      battery.at = Date.now();
      battery.reason = 'ok';
      resolve(battery.value);
    });
  }).finally(() => { battery.inflight = null; });

  return battery.inflight;
}

function batteryReason() { return battery.reason; }

/** The whole tile's worth of numbers. {cpu, memUsed, memTotal, battery}. */
async function stats() {
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  return {
    cpu: cpuPercent(),
    memUsed,
    memTotal,
    battery: await readBattery(),
    batteryReason: batteryReason(),
  };
}

module.exports = { stats, cpuPercent, readBattery, batteryReason };
