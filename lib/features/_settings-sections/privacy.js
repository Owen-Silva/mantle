'use strict';
/*
 * privacy.js - the main half of Settings > Privacy & security (ui/settings/sections/privacy.js),
 * lane privacy, 2026-09-28. Every command is settings.privacy.<name> and asks the sidecar:
 *   sidecar/SysPrivacy.cs          App permissions: the CapabilityAccessManager ConsentStore
 *                                  (device-wide switch, "let apps", "let desktop apps", each app)
 *   sidecar/SysPrivacyGeneral.cs   General, Speech, Inking & typing, Diagnostics & feedback, Activity
 *                                  history, Search permissions, Voice activation, For developers
 *   sidecar/SysPrivacySecurity.cs  Windows Security, Find my device, encryption, the indexer (READ-ONLY)
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js). The two machine-wide
 * writes (a permission for every user, developer mode) come back from the sidecar as needsAdmin and
 * become ONE administrator prompt each through env.elevate (sidecar/ELEVATE.md); a test run never
 * reaches that path (the sidecar's dryRun answers instead).
 * PRIVACY: nothing here logs; app names and paths reach the page only in results.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.privacy.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  caps: 'privacy.caps',
  cap: 'privacy.cap',
  capSet: 'privacy.capSet',
  settings: 'privacy.settings',
  set: 'privacy.set',
  security: 'privacy.security',
};
/** The administrator actions a write may turn into (SysPrivacy*.cs [Elevated]). */
const ADMIN = ['privacy.deviceAccess', 'privacy.developerMode'];

const commands = {
  caps: (args, env) => send(env, SIDECAR.caps, {}, 10000),
  cap: (args, env) => send(env, SIDECAR.cap, pick(args, ['capability']), 15000),
  settings: (args, env) => send(env, SIDECAR.settings, {}, 8000),
  security: (args, env) => send(env, SIDECAR.security, {}, 30000),

  capSet(args, env) {
    if (typeof args.allow !== 'boolean') return { ok: false, reason: 'allow must be true or false' };
    return write(env, SIDECAR.capSet, pick(args, ['capability', 'scope', 'app', 'allow']), { ms: 10000, value: (r) => r.now });
  },
  set(args, env) {
    if (typeof args.key !== 'string' || !args.key) return { ok: false, reason: 'which setting? (key)' };
    return write(env, SIDECAR.set, pick(args, ['key', 'value']), { ms: 10000, value: (r) => r.now });
  },
};

module.exports = { id: 'privacy', commands, SIDECAR, ADMIN };
