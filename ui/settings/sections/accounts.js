/* accounts.js — Settings > Accounts, done natively (lane appsacct, 2026-09-29).
 *
 * Through settings.accounts.* (lib/features/_settings-sections/accounts.js -> sidecar/SysAccounts.cs):
 *   Your info             name, picture, Microsoft / local account, administrator or standard (read)
 *   Sign-in options       Windows Hello (read-only, why), dynamic lock + restart apps (HKCU switches),
 *                         use my sign-in info (read-only, why), password (read-only, why)
 *   Email & accounts      Microsoft accounts this PC knows (read-only, why)
 *   Family                read-only, why
 *   Windows backup        OneDrive and which folders it backs up (read-only, why)
 *   Other users           the local accounts (read-only: administrator, and Mantle never changes accounts)
 *   Access work or school Entra / workplace / domain / MDM (read-only, why)
 * Mantle NEVER changes Owen's account, password, PIN or users. Kit only; nothing opens Windows Settings.
 */
(function () {
  'use strict';
  const C = (kit, name) => kit.call('settings.accounts.' + name, {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const day = (ms) => { try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) { return String(ms); } };
  const rowKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 60) || '_';
  const KIND = { microsoft: 'Microsoft account', local: 'Local account', domain: 'Domain account', work: 'Work or school account' };
  const SVG = {
    person: '<circle cx="8" cy="5.4" r="2.8"/><path d="M2.6 14c.6-2.9 2.8-4.4 5.4-4.4s4.8 1.5 5.4 4.4"/>',
    key: '<circle cx="5.2" cy="10.8" r="2.6"/><path d="m7.1 9 6-6M11 5.1l1.6 1.6M9.6 6.5l1.2 1.2"/>',
    mail: '<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.4"/><path d="m2.2 4.2 5.8 4.6 5.8-4.6"/>',
    family: '<circle cx="5.2" cy="5" r="2"/><circle cx="11" cy="5.6" r="1.6"/><path d="M1.8 13c.4-2.5 1.8-3.8 3.4-3.8S8.2 10.5 8.6 13M8.8 12.6c.3-1.8 1.2-2.8 2.2-2.8s2 1 2.3 2.8"/>',
    cloud: '<path d="M4.6 12.4h7a2.6 2.6 0 0 0 .3-5.2A3.9 3.9 0 0 0 4.4 6.4a3 3 0 0 0 .2 6z"/>',
    users: '<circle cx="6" cy="5.4" r="2.4"/><path d="M1.8 13.4c.5-2.6 2.2-3.9 4.2-3.9s3.7 1.3 4.2 3.9"/><path d="M10.6 3.4a2.2 2.2 0 0 1 0 4.2M12 9.8c1.2.5 2 1.7 2.2 3.4"/>',
    work: '<rect x="1.8" y="5" width="12.4" height="8.4" rx="1.3"/><path d="M5.8 5V3.4a.9.9 0 0 1 .9-.9h2.6a.9.9 0 0 1 .9.9V5M1.8 8.6h12.4"/>',
  };
  const readPage = (fn) => (el, kit) => { const up = fn(el, kit); return up().then(() => ({ update: up, dispose() {} })); };

  // ============================================================== Your info
  const renderInfo = readPage((el, kit) => {
    const pic = kit.h('img', { alt: '', width: 96, height: 96 });
    pic.hidden = true;
    Object.assign(pic.style, { width: '96px', height: '96px', borderRadius: '50%', objectFit: 'cover' });   // CSSOM: the page's CSP refuses style attributes
    const wrap = kit.h('div', {}, pic);
    Object.assign(wrap.style, { display: 'flex', justifyContent: 'center', margin: '4px 0 14px' });
    const name = kit.status({ row: 'accounts.info.name', label: 'Name', value: 'Reading…' });
    const kind = kit.status({ row: 'accounts.info.kind', label: 'Account type', value: '' });
    const role = kit.status({ row: 'accounts.info.role', label: 'Administrator', value: '' });
    const picture = kit.status({ row: 'accounts.info.picture', label: 'Account picture', value: '' });
    el.append(wrap, kit.card(name, kind, role, picture));
    return async () => {
      const r = await C(kit, 'info');
      if (!r || r.ok === false) { const why = bad(r, 'Your account could not be read'); [name, kind, role, picture].forEach((x) => x.set({ value: '—', reason: why })); return; }
      name.set({ value: r.name || '—', help: r.user && r.user !== r.name ? 'Signed in as ' + r.user : null, info: r.readOnly, reason: r.why || null });
      kind.set({ value: KIND[r.kind] || r.kind, help: r.email || (r.domain ? 'Domain ' + r.domain : null), info: r.readOnly });
      role.set({ value: r.admin ? 'Administrator' : 'Standard user', tone: r.admin ? 'info' : null,
        help: r.admin ? (r.elevated ? 'Mantle is running with administrator rights now' : 'Windows asks before an app uses administrator rights (UAC)') : null, info: r.readOnly });
      if (r.picture) { pic.src = r.picture; pic.hidden = false; }
      picture.set({ value: r.picture ? 'Set' : 'Default', info: r.pictureWhy || r.readOnly });
    };
  });

  // ============================================================== Sign-in options
  const renderSignin = readPage((el, kit) => {
    const hello = kit.status({ row: 'accounts.signin.hello', label: 'Windows Hello: face, fingerprint and PIN', value: 'Reading…' });
    const pw = kit.status({ row: 'accounts.signin.password', label: 'Password', value: '' });
    const dyn = kit.toggle({ row: 'accounts.signin.dynamic-lock', label: 'Dynamic lock', help: 'Locks the PC when your paired phone goes out of range', value: false,
      onChange: (on) => kit.call('settings.accounts.signinSet', { name: 'dynamicLock', on }) });
    const restart = kit.toggle({ row: 'accounts.signin.restart-apps', label: 'Restart apps', help: 'Save my restartable apps and restart them when I sign back in', value: false,
      onChange: (on) => kit.call('settings.accounts.signinSet', { name: 'restartApps', on }) });
    const info = kit.status({ row: 'accounts.signin.finish-setup', label: 'Use my sign-in info to finish setting up after an update', value: '' });
    el.append(kit.group('Ways to sign in'), kit.card(hello, pw), kit.group('Additional settings'), kit.card(dyn, restart, info));
    return async () => {
      const [r, me] = await Promise.all([C(kit, 'signin'), C(kit, 'info')]);
      if (!r || r.ok === false) { const why = bad(r, 'The sign-in options could not be read'); [hello, pw, info].forEach((x) => x.set({ value: '—', reason: why })); [dyn, restart].forEach((x) => x.set({ disabled: true, reason: why })); return; }
      const h = r.hello;
      hello.set({ value: h.policyOff ? 'Turned off by a policy' : h.sensors > 0 ? h.sensors + (h.sensors === 1 ? ' sensor' : ' sensors') + ' on this PC' : h.sensors === 0 ? 'No face or fingerprint sensor' : 'Not known',
        help: 'A PIN works on every PC; face and fingerprint need a sensor', info: h.readOnly, reason: null });
      pw.set({ value: me && me.passwordSet ? 'Last set ' + day(me.passwordSet) : me && me.kind === 'microsoft' ? 'Your Microsoft account password' : '—', info: r.password });
      const dflt = (x) => (x.set ? null : 'Not set yet: Windows\' default (Off) applies');
      dyn.set({ value: r.switches.dynamicLock.on, info: dflt(r.switches.dynamicLock), disabled: false, reason: null });
      restart.set({ value: r.switches.restartApps.on, info: dflt(r.switches.restartApps), disabled: false, reason: null });
      info.set({ value: r.signinInfo.on ? 'On' : 'Off', info: r.signinInfo.readOnly });
    };
  });

  // ============================================================== linked pages
  const renderEmail = readPage((el, kit) => {
    const head = kit.status({ row: 'accounts.email', label: 'Accounts used by email, calendar and contacts', value: 'Reading…' });
    const list = kit.list({ row: 'accounts.email.list', items: [], empty: 'Reading…' });
    el.append(kit.card(head), kit.group('Microsoft accounts'), kit.card(list));
    return async () => {
      const r = await C(kit, 'linked');
      if (!r || r.ok === false) { const why = bad(r, 'The accounts could not be read'); head.set({ value: '—', reason: why }); list.set({ items: [], empty: why }); return; }
      head.set({ value: r.microsoftAccounts.length + (r.microsoftAccounts.length === 1 ? ' account' : ' accounts'), info: r.emailReadOnly, reason: null });
      list.set({ items: r.microsoftAccounts.map((a) => ({ key: rowKey(a), label: a, value: 'Microsoft account' })), empty: 'No Microsoft account is added to this PC' });
    };
  });
  const renderFamily = readPage((el, kit) => {
    const head = kit.status({ row: 'accounts.family', label: 'Your family', help: 'Screen time, content filters and activity for family members', value: 'Reading…' });
    el.append(kit.card(head));
    return async () => {
      const r = await C(kit, 'linked');
      head.set(r && r.ok !== false ? { value: 'Managed online', info: r.familyReadOnly, reason: null } : { value: '—', reason: bad(r, 'Family could not be read') });
    };
  });
  const renderBackup = readPage((el, kit) => {
    const od = kit.status({ row: 'accounts.backup.onedrive', label: 'OneDrive', value: 'Reading…' });
    const folders = kit.list({ row: 'accounts.backup.folders', items: [], empty: 'Reading…' });
    el.append(kit.card(od), kit.group('OneDrive folder backup'), kit.card(folders));
    return async () => {
      const r = await C(kit, 'linked');
      if (!r || r.ok === false) { const why = bad(r, 'Windows backup could not be read'); od.set({ value: '—', reason: why }); folders.set({ items: [], empty: why }); return; }
      const b = r.backup;
      od.set({ value: b.signedIn ? 'Signed in' : b.oneDrive ? 'Installed, not signed in' : 'Not installed', help: b.account || null, tone: b.signedIn ? 'ok' : null, info: b.readOnly, reason: null });
      folders.set({ items: b.folders.map((f) => ({ key: rowKey(f.name), label: f.name, value: f.backedUp ? 'Backed up' : 'Not backed up' })) });
    };
  });
  const renderUsers = readPage((el, kit) => {
    const head = kit.status({ row: 'accounts.users', label: 'Other users', value: 'Reading…' });
    const list = kit.list({ row: 'accounts.users.list', items: [], empty: 'Reading…' });
    el.append(kit.card(head), kit.group('Accounts on this PC'), kit.card(list));
    return async () => {
      const r = await C(kit, 'users');
      if (!r || r.ok === false) { const why = bad(r, 'The accounts on this PC could not be read'); head.set({ value: '—', reason: why }); list.set({ items: [], empty: why }); return; }
      const others = r.items.filter((u) => !u.you);
      head.set({ value: others.length + (others.length === 1 ? ' other account' : ' other accounts'), info: r.readOnly, reason: null });
      list.set({ items: r.items.map((u) => ({ key: rowKey(u.name), label: (u.fullName || u.name) + (u.you ? ' (you)' : ''), help: [u.fullName ? u.name : null, u.admin ? 'Administrator' : 'Standard user'].filter(Boolean).join(' · '),
        value: u.enabled ? 'Enabled' : 'Disabled' })), empty: 'No other accounts' });
    };
  });
  const renderWork = readPage((el, kit) => {
    const head = kit.status({ row: 'accounts.work', label: 'Access work or school', help: 'Your organization\'s email, apps and network', value: 'Reading…' });
    const list = kit.list({ row: 'accounts.work.list', items: [], empty: 'Reading…' });
    el.append(kit.card(head), kit.card(list));
    return async () => {
      const r = await C(kit, 'linked');
      if (!r || r.ok === false) { const why = bad(r, 'Work or school access could not be read'); head.set({ value: '—', reason: why }); list.set({ items: [], empty: why }); return; }
      head.set({ value: r.work.length ? r.work.length + ' connected' : 'Not connected', info: r.workReadOnly, reason: null });
      list.set({ items: r.work.map((w, i) => ({ key: 'w' + i, label: w.account || w.kind, value: w.kind })), empty: 'No work or school account is connected' });
    };
  });

  // ============================================================== the section
  const R = (row, label, keywords, uri) => (uri ? { row, label, keywords, uri } : { row, label, keywords });
  MantleSettings.section({
    id: 'accounts',
    title: 'Accounts',
    group: 'windows',
    icon: SVG.person,
    order: 60,
    help: 'Your info, sign-in options, other users',
    keywords: 'account user profile microsoft account sign in login',
    pages: [
      { id: 'info', title: 'Your info', icon: SVG.person, help: 'Name, picture, account type',
        search: [R('accounts.info.name', 'Your name', 'account name profile', 'ms-settings:yourinfo'), R('accounts.info.kind', 'Account type', 'microsoft account local account'),
          R('accounts.info.role', 'Administrator or standard user', 'admin administrator standard'), R('accounts.info.picture', 'Account picture', 'profile picture photo avatar')], render: renderInfo },
      { id: 'signin', title: 'Sign-in options', icon: SVG.key, help: 'Windows Hello, password, dynamic lock',
        search: [R('accounts.signin.hello', 'Windows Hello', 'pin face fingerprint facial recognition biometric', 'ms-settings:signinoptions'), R('accounts.signin.password', 'Password', 'change password last set'),
          R('accounts.signin.dynamic-lock', 'Dynamic lock', 'lock when away phone bluetooth', 'ms-settings:signinoptions-dynamiclock'), R('accounts.signin.restart-apps', 'Restart apps after signing in', 'restart apps sign back in'),
          R('accounts.signin.finish-setup', 'Use my sign-in info to finish setting up after an update', 'arso automatic sign in after update')], render: renderSignin },
      { id: 'email', title: 'Email & accounts', icon: SVG.mail, help: 'Accounts used by apps',
        search: [R('accounts.email', 'Email & accounts', 'email calendar contacts accounts used by other apps', 'ms-settings:emailandaccounts'), R('accounts.email.list', 'Microsoft accounts on this PC', 'microsoft account outlook')], render: renderEmail },
      { id: 'family', title: 'Family', icon: SVG.family, help: 'Family Safety',
        search: [R('accounts.family', 'Family', 'family safety parental controls child screen time', 'ms-settings:family-group')], render: renderFamily },
      { id: 'backup', title: 'Windows backup', icon: SVG.cloud, help: 'OneDrive folder backup',
        search: [R('accounts.backup.onedrive', 'OneDrive', 'onedrive backup cloud sync', 'ms-settings:backup'), R('accounts.backup.folders', 'Folders backed up to OneDrive', 'desktop documents pictures backup')], render: renderBackup },
      { id: 'users', title: 'Other users', icon: SVG.users, help: 'Accounts on this PC',
        search: [R('accounts.users', 'Other users', 'add user family other people accounts', 'ms-settings:otherusers'), R('accounts.users.list', 'Accounts on this PC', 'local accounts users administrator')], render: renderUsers },
      { id: 'work', title: 'Access work or school', icon: SVG.work, help: 'Entra ID, domain, device management',
        search: [R('accounts.work', 'Access work or school', 'work school azure ad entra domain join mdm', 'ms-settings:workplace'), R('accounts.work.list', 'Connected work or school accounts', 'organization managed')], render: renderWork },
    ],
  });
})();
