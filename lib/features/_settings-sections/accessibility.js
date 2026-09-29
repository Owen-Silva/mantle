'use strict';
/*
 * accessibility.js - the main half of Settings > Accessibility (ui/settings/sections/accessibility.js),
 * lane access, 2026-09-29. Every command is settings.accessibility.<name> and asks the sidecar:
 *   sidecar/SysAccess.cs       text size, visual effects, pointer and touch, text cursor, contrast
 *                              themes, colour filters, audio, keyboard (Sticky/Filter/Toggle keys,
 *                              access keys, Print Screen) and mouse keys: SystemParametersInfo + HKCU
 *   sidecar/SysAccessTools.cs  Magnifier, Narrator, the on-screen keyboard, voice access, live
 *                              captions: their HKCU choices, "start after sign-in", and starting them
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js). Starting a tool is a
 * real action too, so it is the same kind of write (dryRun in a test run). Nothing here needs an
 * administrator: accessibility settings are per user.
 * PRIVACY: nothing here logs.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.accessibility.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  settings: 'access.settings',
  set: 'access.set',
  start: 'access.start',
};
/** No administrator actions (sidecar/ELEVATE.md): every value here is the signed-in user's own. */
const ADMIN = [];

const commands = {
  settings: (args, env) => send(env, SIDECAR.settings, {}, 10000),

  set(args, env) {
    if (typeof args.key !== 'string' || !args.key) return { ok: false, reason: 'which setting? (key)' };
    if (args.value === undefined || args.value === null) return { ok: false, reason: 'set needs a value' };
    // a contrast theme repaints every window before SPI_SETHIGHCONTRAST returns: give it time
    return write(env, SIDECAR.set, pick(args, ['key', 'value']), { ms: args.key === 'contrastTheme' ? 30000 : 10000, value: (r) => r.now });
  },
  start(args, env) {
    if (typeof args.tool !== 'string' || !args.tool) return { ok: false, reason: 'which tool? (tool)' };
    return write(env, SIDECAR.start, pick(args, ['tool']), { ms: 10000, value: () => undefined });
  },
};

module.exports = { id: 'accessibility', commands, SIDECAR, ADMIN };
