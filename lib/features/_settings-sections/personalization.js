'use strict';
/*
 * personalization.js - the main half of Settings > Personalization (ui/settings/sections/personalization.js),
 * lane perso, 2026-09-29. Every command is settings.personalization.<name> and asks the sidecar:
 *   sidecar/SysPerso.cs        Colors, Windows' background, lock screen switches, and the read-only
 *                              rest (themes, device usage, touch keyboard, Dynamic Lighting)
 *   sidecar/SysPersoLock.cs    the lock screen picture (WinRT LockScreen)
 *   sidecar/SysPersoFonts.cs   installed fonts; add and remove fonts for YOU (no administrator)
 * Mantle's OWN wallpaper (lib/wallpaper.js) and its bar / launcher options (settings.mantle) are read by
 * the page directly: they are Mantle commands, not Windows settings.
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js). Nothing here needs an
 * administrator: fonts for everyone are read-only with the reason instead.
 * PRIVACY: nothing here logs; paths and font names reach the page only in results.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.personalization.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  colors: 'perso.colors',
  background: 'perso.background',
  more: 'perso.more',
  set: 'perso.set',
  lock: 'perso.lock',
  lockPicture: 'perso.lockPicture',
  fonts: 'perso.fonts',
  fontInstall: 'perso.fontInstall',
  fontRemove: 'perso.fontRemove',
};

const commands = {
  colors: (args, env) => send(env, SIDECAR.colors, {}, 8000),
  background: (args, env) => send(env, SIDECAR.background, {}, 15000),
  more: (args, env) => send(env, SIDECAR.more, {}, 10000),
  lock: (args, env) => send(env, SIDECAR.lock, {}, 10000),
  fonts: (args, env) => send(env, SIDECAR.fonts, {}, 20000),

  set(args, env) {
    if (typeof args.key !== 'string' || !args.key) return { ok: false, reason: 'which setting? (key)' };
    if (args.value === undefined) return { ok: false, reason: 'set needs a value' };
    return write(env, SIDECAR.set, pick(args, ['key', 'value']), { ms: 15000, value: (r) => r.now });
  },
  lockPicture(args, env) {
    if (typeof args.path !== 'string' || !args.path) return { ok: false, reason: 'which picture? (path)' };
    return write(env, SIDECAR.lockPicture, pick(args, ['path']), { ms: 30000, value: (r) => r.now });
  },
  fontInstall(args, env) {
    if (typeof args.path !== 'string' || !args.path) return { ok: false, reason: 'which font file? (path)' };
    return write(env, SIDECAR.fontInstall, pick(args, ['path']), { ms: 30000, value: () => undefined });
  },
  fontRemove(args, env) {
    if (typeof args.face !== 'string' || !args.face) return { ok: false, reason: 'which font? (face)' };
    return write(env, SIDECAR.fontRemove, pick(args, ['face']), { ms: 15000, value: () => undefined });
  },
};

module.exports = { id: 'personalization', commands, SIDECAR };
