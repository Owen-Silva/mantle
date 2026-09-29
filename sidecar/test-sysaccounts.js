// test-sysaccounts.js - SysAccounts.cs (Settings > Accounts) against a PASSIVE sidecar (lane appsacct,
// 2026-09-29).
//
//   node sidecar/test-sysaccounts.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes an account, a password, a PIN or a user: SysAccounts.cs has no such command, and this
// test checks the source for the APIs that would. The two HKCU switches are proven by dryRun, and a real
// write is sent only with the value it ALREADY has (so even a broken passive guard changes nothing) and
// must be refused. Prints counts and shapes only, never a name or an email.
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSACCOUNTS');
  const src = fs.readFileSync(path.join(__dirname, 'SysAccounts.cs'), 'utf8');
  t.check('source: no API that changes an account, password, PIN or group', !/NetUserAdd|NetUserDel|NetUserSetInfo|NetUserChangePassword|NetLocalGroupAddMembers|NetLocalGroupDelMembers|SetPassword|DeleteUser|net user/i.test(src.replace(/^\s*\/\/.*$/gm, '')) &&
    !/\bNgc/.test(src.replace(/^\s*\/\/.*$/gm, '')));
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 20000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 200);
  try {
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['accounts.info', 'accounts.signin', 'accounts.signinSet', 'accounts.users', 'accounts.linked']) t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);

    const i = await send('accounts.info');
    const x = i.ok && i.result;
    t.check('info: a name, a user, a kind, admin bool', !!x && typeof x.name === 'string' && typeof x.user === 'string' && ['microsoft', 'local', 'domain', 'work'].includes(x.kind) && typeof x.admin === 'boolean', short(x && { kind: x.kind, admin: x.admin }));
    t.check('info: a picture data URL or why not', !!x && ((typeof x.picture === 'string' && /^data:image\/(png|jpeg);base64,/.test(x.picture)) || typeof x.pictureWhy === 'string'));
    t.check('info: read-only with the reason', !!x && /never changes your account/.test(x.readOnly));
    t.check('info: a Microsoft account carries its email', !!x && (x.kind !== 'microsoft' || /@/.test(x.email || '')));
    if (x) console.log(`  (kind ${x.kind}, admin ${x.admin}, elevated ${x.elevated}, picture ${x.picture ? Math.round(x.picture.length / 1024) + ' KB' : 'none'}, password set ${x.passwordSet ? 'known' : 'n/a'})`);

    const g = await send('accounts.signin');
    const gx = g.ok && g.result;
    t.check('signin: Hello read-only with the reason, sensors counted', !!gx && Number.isInteger(gx.hello.sensors) && /Windows Hello's own secure flow/.test(gx.hello.readOnly), short(gx && gx.hello.sensors));
    t.check('signin: dynamic lock and restart apps on/set', !!gx && ['dynamicLock', 'restartApps'].every((k) => typeof gx.switches[k].on === 'boolean' && typeof gx.switches[k].set === 'boolean'));
    t.check('signin: sign-in info read-only with the reason; password words', !!gx && typeof gx.signinInfo.on === 'boolean' && /Read only/.test(gx.signinInfo.readOnly) && /never changes your password or PIN/.test(gx.password));
    if (gx) {
      const d = await send('accounts.signinSet', { name: 'dynamicLock', on: !gx.switches.dynamicLock.on, dryRun: true });
      t.check('signinSet dryRun names the HKCU Winlogon value', d.ok && d.result.dryRun && /HKCU Winlogon EnableGoodbye = [01]/.test(d.result.would), short(d));
      const r = await send('accounts.signinSet', { name: 'restartApps', on: gx.switches.restartApps.on });
      t.check('a real signinSet is refused in passive (sent with the value it already has)', refused(r), short(r));
    }
    for (const [a, re] of [[{ name: 'EnableGoodbye', on: true, dryRun: true }, /needs name/], [{ name: 'dynamicLock', on: 'yes', dryRun: true }, /true or false/]]) {
      const r = await send('accounts.signinSet', a);
      t.check(`signinSet refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }

    const u = await send('accounts.users');
    t.check('users: a list with you in it, each admin/enabled bools', u.ok && Array.isArray(u.result.items) && u.result.items.some((x) => x.you) && u.result.items.every((x) => typeof x.admin === 'boolean' && typeof x.enabled === 'boolean') && /Read only/.test(u.result.readOnly), short(u.ok ? u.result.items.length : u));
    if (u.ok) console.log(`  (users: ${u.result.items.length}, ${u.result.items.filter((x) => x.admin).length} administrators)`);

    const l = await send('accounts.linked');
    const lx = l.ok && l.result;
    t.check('linked: Microsoft accounts, work list, backup folders, each read-only with a reason', !!lx && Array.isArray(lx.microsoftAccounts) && Array.isArray(lx.work) && lx.backup.folders.length === 5 &&
      [lx.emailReadOnly, lx.workReadOnly, lx.familyReadOnly, lx.backup.readOnly].every((w) => /^Read only/.test(w)), short(l));
    if (lx) console.log(`  (linked: ${lx.microsoftAccounts.length} Microsoft account(s), ${lx.work.length} work item(s), OneDrive ${lx.backup.oneDrive}/${lx.backup.signedIn}, ${lx.backup.folders.filter((f) => f.backedUp).length} folder(s) backed up)`);

    const g2 = await send('accounts.signin');
    t.check('nothing changed (the two switches)', g2.ok && gx && JSON.stringify(g2.result.switches) === JSON.stringify(gx.switches));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
