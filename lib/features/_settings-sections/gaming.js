'use strict';
/*
 * gaming.js - the main half of Settings > Gaming (ui/settings/sections/gaming.js), lane gameupd,
 * 2026-09-29. Every command is settings.gaming.<name> and asks sidecar/SysGaming.cs:
 *   get   Xbox Game Bar, Captures and Windows' Game Mode: every value, the capture policy, the Game
 *         Bar package and the captures folder (read-only).
 *   set   ONE switch or choice: a dry run in a test run, the read-back otherwise (_devices-bridge.js).
 *         Every value is per-user (HKCU), so there is no administrator path here.
 * Mantle's OWN game mode (lib/features/gamemode.js) is not touched here: the page reads it with the
 * same commands the Mantle section uses (gamemode.state, settings.mantle, settings.option,
 * settings.enable).
 * PRIVACY: nothing here logs; the captures folder path reaches the page only in results.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.gaming.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = { get: 'gaming.get', set: 'gaming.set' };
/** No administrator actions: Game Bar, Captures and Game Mode are all per-user values. */
const ADMIN = [];

const commands = {
  get: (args, env) => send(env, SIDECAR.get, {}, 8000),
  set(args, env) {
    if (typeof args.key !== 'string' || !args.key) return { ok: false, reason: 'which setting? (key)' };
    if (typeof args.value !== 'boolean' && typeof args.value !== 'string') return { ok: false, reason: 'value must be on/off or one of the choices' };
    return write(env, SIDECAR.set, pick(args, ['key', 'value']), { ms: 8000, value: (r) => r.now });
  },
};

module.exports = { id: 'gaming', commands, SIDECAR, ADMIN };
