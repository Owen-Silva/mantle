'use strict';
/*
 * time.js - the main half of Settings > Time & language (ui/settings/sections/time.js), lane
 * timelang, 2026-09-28. Every command is settings.time.<name> and asks the sidecar:
 *   sidecar/SysTime.cs        date & time: zone, DST, set time / zone automatically, the clock, Sync
 *                             now, additional clocks, seconds in the tray clock
 *   sidecar/SysTimeRegion.cs  country or region, regional format, format overrides, live preview
 *   sidecar/SysTimeLang.cs    languages, typing switches, advanced keyboard, voices and recognizers
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js write()). The four
 * administrator rows (set time automatically, set time zone automatically, set the clock, Sync now)
 * answer needsAdmin from the sidecar and write() turns that into ONE administrator prompt for that
 * action (sidecar/ELEVATE.md); in a test run they are the sidecar's dry-run plan, never a prompt.
 * Nothing here logs a zone, a language or a clock name.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.time.<name> -> [sidecar command, allowed args, timeout ms]: the reads. */
const READS = {
  get: ['systime.get', [], 8000],
  zones: ['systime.zones', [], 10000],
  region: ['sysregion.get', [], 10000],
  lists: ['sysregion.lists', [], 20000],
  preview: ['sysregion.preview', ['locale'], 8000],
  lang: ['syslang.get', [], 10000],
};

/** settings.time.<name> -> [sidecar command, allowed args, read-back picker]: the writes. */
const WRITES = {
  setZone: ['systime.setZone', ['zone'], (r) => r.now],
  setDst: ['systime.setDst', ['on'], (r) => r.now],
  // three controls share it (switch, zone, name): no single read-back; the page re-reads instead
  setExtraClock: ['systime.setExtraClock', ['slot', 'on', 'zone', 'name'], undefined],
  setTray: ['systime.setTray', ['key', 'value'], (r) => r.now],
  setFormat: ['sysregion.setFormat', ['key', 'value'], (r) => r.now],
  setLocale: ['sysregion.setLocale', ['locale'], (r) => r.now],
  setGeo: ['sysregion.setGeo', ['geo'], (r) => r.now],
  setTyping: ['syslang.setTyping', ['key', 'value'], (r) => r.now],
  setPerAppInput: ['syslang.setPerAppInput', ['on'], (r) => r.now],
  // administrator rows: a real call answers needsAdmin -> one prompt (write() does it)
  setAutoSync: ['systime.setAutoSync', ['on'], undefined],
  setAutoZone: ['systime.setAutoZone', ['on'], undefined],
  setClock: ['systime.setClock', ['year', 'month', 'day', 'hour', 'minute', 'second'], undefined],
  syncNow: ['systime.syncNow', [], undefined],
};

/** The [Elevated] action behind each administrator row (the page's shield words match their `does`). */
const ADMIN = {
  setAutoSync: 'time.setAutoSync',
  setAutoZone: 'time.setAutoZone',
  setClock: 'time.setClock',
  syncNow: 'time.syncNow',
};

const commands = {};
for (const [name, [cmd, keys, ms]] of Object.entries(READS)) {
  commands[name] = (args, env) => send(env, cmd, pick(args, keys), ms);
}
for (const [name, [cmd, keys, value]] of Object.entries(WRITES)) {
  commands[name] = async (args, env) => {
    const r = await write(env, cmd, pick(args, keys), { ms: ADMIN[name] ? 20000 : 10000, value: value || (() => undefined) });
    // An administrator change that went through: the page re-reads; `note` is shown under the row.
    if (ADMIN[name] && r && r.ok && !r.dryRun) return Object.assign({}, r, { changed: true });
    return r;
  };
}

module.exports = { id: 'time', commands, READS, WRITES, ADMIN };
