'use strict';
/*
 * accounts.js - the main half of Settings > Accounts (ui/settings/sections/accounts.js), lane appsacct,
 * 2026-09-29. Every command is settings.accounts.<name> and asks sidecar/SysAccounts.cs:
 *   info        your name, picture, Microsoft / local account, administrator or standard
 *   signin      Windows Hello (read-only), dynamic lock + restart apps (HKCU), sign-in info (read-only)
 *   signinSet {name: dynamicLock|restartApps, on}   the only writes here: HKCU Winlogon, dryRun in tests
 *   users       the local accounts (read-only)
 *   linked      Email & accounts, Access work or school, Windows backup (read-only)
 * Mantle NEVER changes Owen's account, password, PIN or users: there is no command for it.
 * PRIVACY: nothing here logs names or emails.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.accounts.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  info: 'accounts.info',
  signin: 'accounts.signin',
  signinSet: 'accounts.signinSet',
  users: 'accounts.users',
  linked: 'accounts.linked',
};

const commands = {
  info: (args, env) => send(env, SIDECAR.info, {}, 10000),
  signin: (args, env) => send(env, SIDECAR.signin, {}, 10000),
  signinSet(args, env) {
    if (args.name !== 'dynamicLock' && args.name !== 'restartApps') return { ok: false, reason: 'name must be dynamicLock or restartApps' };
    if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true or false' };
    return write(env, SIDECAR.signinSet, pick(args, ['name', 'on']), { ms: 8000, value: (r) => r.now });
  },
  users: (args, env) => send(env, SIDECAR.users, {}, 10000),
  linked: (args, env) => send(env, SIDECAR.linked, {}, 10000),
};

module.exports = { id: 'accounts', commands, SIDECAR };
