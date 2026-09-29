/* privacy.js — Settings > Privacy & security, done natively (lane privacy, 2026-09-28).
 *
 * Owen: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". So every page of Windows' Privacy & security is here, reading and changing the
 * same values Windows' own Settings does, through settings.privacy.* (lib/features/_settings-sections/
 * privacy.js -> sidecar/SysPrivacy*.cs). Nothing links out to ms-settings.
 *
 * Pages: Security (Windows Security, Find my device, Device encryption, For developers), Windows
 * permissions (General, Speech, Inking & typing, Diagnostics & feedback, Activity history, Search
 * permissions, Searching Windows) and App permissions: one page per permission (Location, Camera,
 * Microphone, ... Text and image generation) with the switch for everyone on this PC (administrator),
 * "Let apps access", "Let desktop apps access" and every app with when it last used it.
 *
 * What Windows keeps from other programs is READ-ONLY with the exact reason on its row: Windows
 * Security's switches (only its own app, tamper protection blocks the rest on purpose), encryption,
 * Find my device, the diagnostic data level, activity history, and anything a policy locks.
 * Kit only (ui/settings/SECTIONS.md): no CSS of its own.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.privacy.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  // An app's family name or path as a row key: row ids allow letters, digits and _ . + - only.
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  // The administrator action's own words (SysPrivacy.cs DeviceDoes / SysPrivacyGeneral.cs DevDoes).
  const DEVICE_DOES = 'change a privacy permission for everyone who uses this PC';
  const DEV_DOES = 'turn developer mode on or off for this PC';
  const SECURITY_APP = 'Read only here: changes belong to the Windows Security app (its tamper protection blocks every other program on purpose)';
  const SECURITY_ROW = 'Read only here: only the Windows Security app changes this';
  const when = (ms) => { try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return String(ms); } };

  const SVG = {
    pin: '<path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8z"/><circle cx="8" cy="6.5" r="1.6"/>',
    camera: '<rect x="1.5" y="4" width="10" height="8" rx="1.5"/><path d="M11.5 7l3-2v6l-3-2"/>',
    folder: '<path d="M1.5 4.5v8h13v-6.5H7.5L6 4.5z"/>',
    person: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2"/>',
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l4 4"/>',
    code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
    spark: '<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/>',
  };

  // ============================================================== App permissions
  // [page id, ConsentStore key, title, what apps get ("access <noun>"), icon, uri, keywords]
  const CAPS = [
    ['location', 'location', 'Location', 'your location', SVG.pin, 'ms-settings:privacy-location', 'gps where place maps location services'],
    ['camera', 'webcam', 'Camera', 'your camera', SVG.camera, 'ms-settings:privacy-webcam', 'webcam video camera access'],
    ['microphone', 'microphone', 'Microphone', 'your microphone', 'mic', 'ms-settings:privacy-microphone', 'mic audio record voice'],
    ['notifications', 'userNotificationListener', 'Notifications', 'your notifications', 'notifications', 'ms-settings:privacy-notifications', 'notification listener read toasts'],
    ['account-info', 'userAccountInformation', 'Account info', 'your account info', SVG.person, 'ms-settings:privacy-accountinfo', 'name picture account information'],
    ['contacts', 'contacts', 'Contacts', 'your contacts', SVG.person, 'ms-settings:privacy-contacts', 'people address book'],
    ['calendar', 'appointments', 'Calendar', 'your calendar', 'apps', 'ms-settings:privacy-calendar', 'appointments events schedule'],
    ['phone-calls', 'phoneCall', 'Phone calls', 'phone calls', 'apps', 'ms-settings:privacy-phonecalls', 'call dial phone'],
    ['call-history', 'phoneCallHistory', 'Call history', 'your call history', 'apps', 'ms-settings:privacy-callhistory', 'calls log history'],
    ['email', 'email', 'Email', 'your email', 'apps', 'ms-settings:privacy-email', 'mail messages'],
    ['tasks', 'userDataTasks', 'Tasks', 'your tasks', 'apps', 'ms-settings:privacy-tasks', 'to do todo'],
    ['messaging', 'chat', 'Messaging', 'messaging (text or MMS)', 'apps', 'ms-settings:privacy-messaging', 'sms mms text chat'],
    ['radios', 'radios', 'Radios', 'radios such as Bluetooth', 'bluetooth', 'ms-settings:privacy-radios', 'bluetooth wifi radio control'],
    ['other-devices', 'bluetoothSync', 'Other devices', 'unpaired wireless devices', 'bluetooth', 'ms-settings:privacy-customdevices', 'communicate unpaired devices sync beacons'],
    ['app-diagnostics', 'appDiagnostics', 'App diagnostics', 'diagnostic info about your other apps', 'apps', 'ms-settings:privacy-appdiagnostics', 'diagnostic info other apps processes'],
    ['documents', 'documentsLibrary', 'Documents', 'your Documents library', SVG.folder, 'ms-settings:privacy-documents', 'files documents library'],
    ['downloads-folder', 'downloadsFolder', 'Downloads folder', 'your Downloads folder', SVG.folder, 'ms-settings:privacy-downloadsfolder', 'downloads folder files'],
    ['music', 'musicLibrary', 'Music library', 'your Music library', SVG.folder, 'ms-settings:privacy-musiclibrary', 'songs music library'],
    ['pictures', 'picturesLibrary', 'Pictures', 'your Pictures library', SVG.folder, 'ms-settings:privacy-pictures', 'photos pictures images library'],
    ['videos', 'videosLibrary', 'Videos', 'your Videos library', SVG.folder, 'ms-settings:privacy-videos', 'movies video library'],
    ['file-system', 'broadFileSystemAccess', 'File system', 'all your files', SVG.folder, 'ms-settings:privacy-broadfilesystemaccess', 'all files drive file system'],
    ['screenshots', 'graphicsCaptureProgrammatic', 'Screenshots and apps', 'screenshots of other apps', 'display', 'ms-settings:privacy-graphicscaptureprogrammatic', 'screen capture recording screenshot'],
    ['screenshot-borders', 'graphicsCaptureWithoutBorder', 'Screenshot borders', 'screenshots without the yellow border', 'display', 'ms-settings:privacy-graphicscapturewithoutborder', 'capture border yellow outline'],
    ['generative-ai', 'systemAIModels', 'Text and image generation', "Windows' generative AI", SVG.spark, 'ms-settings:privacy-systemaimodels', 'ai copilot generative models text image generation'],
    ['presence', 'humanPresence', 'Presence sensing', 'presence sensing', SVG.eye, 'ms-settings:privacy-presence', 'human presence sensor wake on approach'],
  ];
  const WORD = { Allow: 'On', Deny: 'Off', Prompt: 'Asks each time' };

  function capPage(pid, cap, title, noun) {
    return function (el, kit) {
      const R = (x) => 'privacy.' + pid + '.' + x;
      const device = kit.toggle({ row: R('device'), label: title + ' access', admin: DEVICE_DOES,
        help: 'For everyone on this PC: when this is off, no app may use ' + noun,
        onChange: (on) => change({ scope: 'device', allow: on }) });
      const user = kit.toggle({ row: R('user'), label: 'Let apps access ' + noun, help: 'Store apps, each can be switched below',
        onChange: (on) => change({ scope: 'user', allow: on }) });
      const desk = kit.toggle({ row: R('desktop'), label: 'Let desktop apps access ' + noun,
        help: 'Every desktop app at once: Windows has no switch per desktop app',
        onChange: (on) => change({ scope: 'desktop', allow: on }) });
      const note = kit.h('div', {});
      const apps = kit.list({ row: R('apps'), items: [], empty: 'Reading the apps…', onAction: appAction });
      const dnote = kit.h('div', {});
      const dapps = kit.list({ row: R('desktop-apps'), items: [], empty: 'Reading the desktop apps…' });
      const deskGroup = kit.h('div', {}, kit.group('Desktop apps', { row: R('desktop-apps') }), dnote, kit.card(dapps));
      el.append(kit.group('Access'), kit.card(device, user, desk), kit.group('Choose which apps can access ' + noun, { row: R('apps') }), note, kit.card(apps), deskGroup);

      const S = { r: null };
      async function change(a) {
        const r = await C(kit, 'capSet', Object.assign({ capability: cap }, a));
        if (r.ok && !r.dryRun) setTimeout(read, 300);
        return r;
      }
      async function appAction(key, act, it) {
        const r = await change({ scope: 'app', app: it.app, allow: act === 'allow' });
        return r;
      }
      function draw() {
        const r = S.r;
        const lock = r.policy ? 'Read only here: ' + r.policy.words + ', so Windows ignores any other choice' : null;
        const missing = r.present === false ? 'Read only here: ' + (r.reason || 'Windows keeps no permission store for this yet') : null;
        const devOff = r.device === 'Deny';
        const forced = r.policy && r.policy.force ? r.policy.force : null;   // a policy's value wins over what is stored
        const shown = (v) => (forced ? forced === 'allow' : v !== 'Deny');
        const userOff = r.user === 'Deny';
        device.set({ value: shown(r.device), disabled: !!(lock || missing), reason: lock || missing || (r.device == null ? 'The switch for everyone could not be read: ' + (r.deviceWhy || 'no reason came back') : null),
          admin: lock || missing ? null : r.elevated ? true : DEVICE_DOES });
        user.set({ value: shown(r.user), disabled: !!(lock || missing || devOff),
          reason: lock || missing || (devOff ? 'Read only while "' + title + ' access" is off: Windows blocks every app on this PC' : null) ||
            (r.user == null && r.present ? 'Not set yet (' + (r.userWhy || 'no value') + '): Windows treats it as on' : null) });
        desk.el.hidden = !r.hasDesktop;
        deskGroup.hidden = !r.hasDesktop;
        if (r.hasDesktop) {
          desk.set({ value: shown(r.desktop), disabled: !!(lock || missing || devOff),
            reason: lock || missing || (devOff ? 'Read only while "' + title + ' access" is off' : null) ||
              (r.desktop == null && r.present ? 'Not set yet (' + (r.desktopWhy || 'no value') + '): Windows treats it as on' : null) });
        }
        const blocked = lock || missing || (devOff ? 'Every app is blocked while "' + title + ' access" is off' : userOff ? 'Every app is blocked while "Let apps access ' + noun + '" is off' : null);
        note.replaceChildren(blocked ? kit.reason(blocked, { info: true }) : '');
        const list = Array.isArray(r.apps) ? r.apps : [];
        apps.set({ empty: r.appsWhy && r.present ? 'The apps could not be read: ' + r.appsWhy : 'No Store app has asked for ' + noun + (r.hiddenApps ? ' (' + r.hiddenApps + ' that are no longer installed are hidden, as Windows hides them)' : ''),
          items: list.map((a) => ({ key: keyOf(a.app), app: a.app, label: a.name || a.app,
            help: a.inUse ? 'In use now' : a.lastUsed ? 'Last accessed ' + when(a.lastUsed) : 'Not used yet',
            value: forced ? (forced === 'allow' ? 'On (policy)' : 'Off (policy)') : a.value ? WORD[a.value] : 'Not chosen',
            actions: [a.value === 'Allow' ? { id: 'deny', text: 'Turn off', disabled: !!blocked } : { id: 'allow', text: 'Turn on', tone: 'acc', disabled: !!blocked }] })) });
        const dl = Array.isArray(r.desktopApps) ? r.desktopApps : [];
        dnote.replaceChildren(kit.reason('Windows lists the desktop apps that used ' + noun + ' but has no switch per desktop app: "Let desktop apps access" covers them all.', { info: true }));
        dapps.set({ empty: 'No desktop app has used ' + noun + ' yet',
          items: dl.map((a) => ({ key: keyOf(a.path || a.app), label: a.name, mono: false,
            help: (a.inUse ? 'In use now' : a.lastUsed ? 'Last accessed ' + when(a.lastUsed) : 'Not used yet') + ' · ' + a.path })) });
      }
      async function read() {
        const r = await C(kit, 'cap', { capability: cap });
        if (!r || r.ok === false) {
          const why = bad(r, 'This permission could not be read');
          [device, user, desk].forEach((x) => x.set({ disabled: true, reason: why }));
          apps.set({ items: [], empty: why });
          dapps.set({ items: [], empty: why });
          return;
        }
        S.r = r;
        draw();
      }
      return read().then(() => ({ update: read, dispose() {} }));
    };
  }

  // ============================================================== switches pages (General, Speech, ...)
  // A switch row: [key, row, label, help]. settings.privacy.settings answers {values:{key:{on,locked,why,set}}}.
  function applySwitch(t, v, extra) {
    if (!v) return t.set({ disabled: true, reason: 'Windows did not report this switch' });
    const lock = v.locked ? 'Read only here: ' + v.locked : null;
    t.set({ value: v.on === true, disabled: !!(lock || (extra && extra.disabled)), reason: lock || (extra && extra.reason) || null,
      info: v.on === null ? 'Not set yet: Windows stores a choice the first time it is switched' : null });
  }
  function switchesPage(groups, more) {
    return function (el, kit) {
      const rows = {};
      for (const [title, list] of groups) {
        const ctl = list.map(([key, row, label, help]) => (rows[key] = kit.toggle({ row, label, help,
          onChange: (on) => C(kit, 'set', { key, value: on }).then((r) => { if (r.ok && !r.dryRun) setTimeout(read, 300); return r; }) })));
        el.append(kit.group(title), kit.card(...ctl));
      }
      const extra = more ? more(el, kit, () => read()) : null;
      async function read() {
        const r = await C(kit, 'settings');
        if (!r || r.ok === false) {
          const why = bad(r, 'These settings could not be read');
          Object.values(rows).forEach((t) => t.set({ disabled: true, reason: why }));
          if (extra) extra.fail(why);
          return;
        }
        const v = r.values || {};
        for (const k of Object.keys(rows)) applySwitch(rows[k], v[k], extra && extra.gate ? extra.gate(k, v) : null);
        if (extra) extra.apply(v);
      }
      return read().then(() => ({ update: read, dispose() {} }));
    };
  }

  const GENERAL = [['Change privacy options', [
    ['advertisingId', 'privacy.general.advertising-id', 'Let apps show me personalized ads by using my advertising ID', 'Apps see an ID Windows gives you instead of your name'],
    ['languageList', 'privacy.general.language-list', 'Let websites show me locally relevant content by accessing my language list', 'Websites read the languages you added to Windows'],
    ['appLaunchTracking', 'privacy.general.app-launch', 'Let Windows improve Start and search results by tracking app launches', 'Start and search list the apps you open most'],
    ['suggestedContent', 'privacy.general.suggested', 'Show me suggested content in the Settings app', 'Suggestions and tips in Windows Settings'],
    ['settingsNotifications', 'privacy.general.notifications', 'Show me notifications in the Settings app', 'Account notices in Windows Settings'],
  ]]];
  const SPEECH = [['Speech', [['onlineSpeech', 'privacy.speech.online', 'Online speech recognition', "Use your voice for apps that use Microsoft's cloud speech recognition"]]]];
  const INKING = [['Inking & typing personalization', [['inkingDictionary', 'privacy.inking.dictionary', 'Custom inking and typing dictionary',
    'Uses your typing history and handwriting to make a personal dictionary for better suggestions']]]];
  const SEARCHP = [
    ['Cloud content search', [
      ['cloudSearchMsa', 'privacy.search.cloud-msa', 'Microsoft account', 'Let search show results from OneDrive, Outlook and other Microsoft services'],
      ['cloudSearchWork', 'privacy.search.cloud-work', 'Work or school account', 'Let search show results from SharePoint, OneDrive for work and Outlook'],
    ]],
    ['History', [['searchHistory', 'privacy.search.history', 'Search history on this device', 'Improves search results with your search history on this PC']]],
    ['More settings', [['searchHighlights', 'privacy.search.highlights', 'Show search highlights', 'Content suggestions in the search box and search home']]],
  ];
  const VOICE = [['Voice activation', [
    ['voiceActivation', 'privacy.voice-activation.apps', 'Let apps access voice activation services', 'Apps can listen for their keyword, like "Hey Copilot"'],
    ['voiceLock', 'privacy.voice-activation.locked', 'Let apps use voice activation when the device is locked', 'Only while "Let apps access voice activation services" is on'],
  ]]];
  const DEVS = [['Developer options', [['endTask', 'privacy.developers.end-task', 'End task', 'Show End task when you right-click an app on the taskbar']]]];

  // Search permissions: SafeSearch is a choice above the switches.
  function safeSearchMore(el, kit, reread) {
    const ss = kit.choice({ row: 'privacy.search.safesearch', label: 'SafeSearch', help: 'Keeps adult text, images and videos out of web results in search',
      options: [{ value: 'strict', label: 'Strict' }, { value: 'moderate', label: 'Moderate' }, { value: 'off', label: 'Off' }], value: 'moderate',
      onChange: (v) => C(kit, 'set', { key: 'safeSearch', value: v }).then((r) => { if (r.ok && !r.dryRun) setTimeout(reread, 300); return r; }) });
    el.prepend(kit.group('SafeSearch'), kit.card(ss));
    return { apply: (v) => ss.set({ value: v.safeSearch ? v.safeSearch.value : 'moderate', disabled: !v.safeSearch, reason: v.safeSearch ? null : 'Windows did not report SafeSearch' }),
      fail: (why) => ss.set({ disabled: true, reason: why }) };
  }
  // Voice activation: the locked-screen switch waits for the first one, as in Windows.
  function voiceMore() {
    return { apply() {}, fail() {}, gate: (k, v) => (k === 'voiceLock' && v.voiceActivation && v.voiceActivation.on === false ? { disabled: true, reason: 'Read only while "Let apps access voice activation services" is off' } : null) };
  }
  // Diagnostics & feedback: the level (read-only), two switches, how often Windows asks for feedback.
  const FEEDBACK = [{ value: 'auto', label: 'Automatically (Recommended)' }, { value: 'always', label: 'Always' }, { value: 'day', label: 'Once a day' },
    { value: 'week', label: 'Once a week' }, { value: 'never', label: 'Never' }];
  function diagnosticsMore(el, kit, reread) {
    const level = kit.status({ row: 'privacy.diagnostics.level', label: 'Diagnostic data', help: 'What Windows sends Microsoft about this PC', value: 'Reading…' });
    const fb = kit.choice({ row: 'privacy.diagnostics.feedback', label: 'Feedback frequency', help: 'How often Windows asks for your feedback', style: 'dropdown',
      options: FEEDBACK, value: 'auto', onChange: (v) => C(kit, 'set', { key: 'feedback', value: v }).then((r) => { if (r.ok && !r.dryRun) setTimeout(reread, 300); return r; }) });
    el.prepend(kit.group('Diagnostic data'), kit.card(level));
    el.append(kit.group('Feedback'), kit.card(fb));
    const LV = { security: 'Security only (Enterprise)', required: 'Required diagnostic data only', optional: 'Optional diagnostic data: sent' };
    return {
      apply(v) {
        const d = v.diagLevel || {};
        level.set({ value: d.value ? LV[d.value] || d.value : 'Not reported', tone: 'info', info: 'Read only here: ' + (d.why || 'Windows keeps this for the whole PC') });
        const f = v.feedback || {};
        fb.set({ value: f.value || 'auto', options: f.value === 'custom' ? FEEDBACK.concat([{ value: 'custom', label: 'Custom (set by another program)' }]) : FEEDBACK,
          disabled: !!f.locked || !f.value, reason: f.locked ? 'Read only here: ' + f.locked : f.value ? null : 'Windows did not report it' });
      },
      fail(why) { level.set({ value: '—', reason: why }); fb.set({ disabled: true, reason: why }); },
    };
  }
  const DIAG = [['Improve inking and typing', [['improveInking', 'privacy.diagnostics.inking', 'Improve inking and typing', 'Send optional inking and typing diagnostic data to Microsoft']]],
    ['Tailored experiences', [['tailored', 'privacy.diagnostics.tailored', 'Tailored experiences', 'Let Microsoft use your diagnostic data for tips, ads and recommendations']]]];
  // For developers: developer mode is an administrator action.
  function developersMore(el, kit, reread) {
    const dm = kit.toggle({ row: 'privacy.developers.mode', label: 'Developer Mode', admin: DEV_DOES,
      help: 'Install apps from any source, including loose files, and create links without an administrator',
      onChange: (on) => C(kit, 'set', { key: 'developerMode', value: on }).then((r) => { if (r.ok && !r.dryRun) setTimeout(reread, 300); return r; }) });
    el.prepend(kit.group('Developer Mode'), kit.card(dm));
    return { apply: (v) => { const d = v.developerMode; if (!d) return dm.set({ disabled: true, reason: 'Windows did not report developer mode' }); dm.set({ value: !!d.on, disabled: false, reason: null, admin: d.admin === false ? true : DEV_DOES }); },
      fail: (why) => dm.set({ disabled: true, reason: why }) };
  }

  // Activity history: read-only, with Windows' reason.
  function renderActivity(el, kit) {
    const st = kit.status({ row: 'privacy.activity.store', label: 'Store my activity history on this device', help: 'The apps and files you used, for Timeline-style features', value: 'Reading…' });
    el.append(kit.group('Activity history'), kit.card(st));
    async function read() {
      const r = await C(kit, 'settings');
      if (!r || r.ok === false) return st.set({ value: '—', reason: bad(r, 'It could not be read') });
      const a = (r.values || {}).activity || {};
      st.set({ value: a.on === false ? 'Off' : 'Kept by Windows', tone: a.on === false ? 'warn' : 'info', info: 'Read only here: ' + (a.why || 'Windows keeps this itself') });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // Automatic file downloads: Windows keeps the blocked apps in its own Settings.
  function renderDownloads(el, kit) {
    el.append(kit.group('Automatic file downloads'), kit.card(kit.status({ row: 'privacy.file-downloads.allow', label: 'Apps that download cloud files for you',
      help: 'When an app opens a OneDrive file that is only online, Windows downloads it and can ask first', value: 'Kept by Windows', tone: 'info',
      info: 'Read only here: Windows keeps the list of apps you blocked from downloading cloud files inside its own Settings, with no documented setting another program may read or change' })));
    return { dispose() {} };
  }

  // ============================================================== Security (read-only)
  function securityReader(kit, apply) {
    let last = null;
    async function read() {
      const r = await C(kit, 'security');
      last = r;
      apply(r && r.ok !== false ? r : null, bad(r, 'Windows Security could not be read'));
    }
    return { read, get last() { return last; } };
  }
  function renderSecurity(el, kit) {
    const av = kit.list({ row: 'privacy.security.antivirus', items: [], empty: 'Reading Windows Security…' });
    const rtp = kit.status({ row: 'privacy.security.realtime', label: 'Real-time protection', help: 'Scans files as they are opened', value: 'Reading…', info: SECURITY_ROW });
    const tamper = kit.status({ row: 'privacy.security.tamper', label: 'Tamper protection', help: 'Stops other programs from changing Windows Security', value: 'Reading…', info: SECURITY_ROW });
    const sig = kit.status({ row: 'privacy.security.definitions', label: 'Security intelligence', help: 'When Microsoft Defender last updated what it looks for', value: 'Reading…', info: SECURITY_ROW });
    const fw = kit.list({ row: 'privacy.security.firewall', items: [], empty: 'Reading the firewall…' });
    el.append(kit.group('Virus & threat protection', { row: 'privacy.security.antivirus' }), kit.card(av, rtp, tamper, sig),
      kit.group('Firewall & network protection', { row: 'privacy.security.firewall' }), kit.card(fw),
      kit.card(kit.reason(SECURITY_APP + '.', { info: true })));
    const PROF = { domain: 'Domain network', private: 'Private network', public: 'Public network' };
    const onOff = (b, yes, no) => (b === true ? yes : b === false ? no : 'Not reported');
    const R = securityReader(kit, (r, why) => {
      if (!r) {
        av.set({ items: [], empty: why }); fw.set({ items: [], empty: why });
        [rtp, tamper, sig].forEach((x) => x.set({ value: '—', reason: why }));
        return;
      }
      av.set({ empty: r.antivirusWhy || 'Windows Security reports no antivirus', items: (r.antivirus || []).map((a, i) => ({ key: 'a' + i, label: a.name || 'Antivirus',
        help: (a.on ? 'On' : 'Off') + ' · ' + (a.upToDate ? 'Up to date' : 'Out of date') + (a.defender ? ' · Microsoft Defender' : ''),
        value: a.on && a.upToDate ? 'Protected' : 'Needs attention', reason: a.on && a.upToDate ? null : 'Windows Security says this needs attention; open the Windows Security app to act on it' })) });
      const d = r.defender || {};
      if (!d.ok) {
        [rtp, tamper, sig].forEach((x) => x.set({ value: '—', tone: null, reason: d.reason || 'Microsoft Defender did not report its status' }));
      } else {
        rtp.set({ value: onOff(d.realTime, 'On', 'Off'), tone: d.realTime ? 'ok' : 'warn', reason: null });
        tamper.set({ value: onOff(d.tamper, 'On', 'Off'), tone: d.tamper ? 'ok' : 'warn', reason: null });
        sig.set({ value: d.signaturesUpdated ? 'Updated ' + when(d.signaturesUpdated) : 'Not reported', tone: d.signaturesUpdated ? 'ok' : null, reason: null });
      }
      const f = r.firewall || {};
      const prods = (f.products || []).map((p, i) => ({ key: 'p' + i, label: p.name || 'Firewall', help: 'Another firewall, registered with Windows Security', value: p.on ? 'On' : 'Off' }));
      fw.set({ empty: 'The firewall could not be read', items: (f.profiles || []).map((p) => ({ key: p.profile, label: PROF[p.profile] || p.profile,
        help: 'Microsoft Defender Firewall' + (p.policy ? ' · set by a policy' : ''), value: onOff(p.on, 'On', 'Off'), reason: p.reason || (p.on === false ? 'The firewall is off for this network type' : null) })).concat(prods) });
    });
    kit.every(30000, R.read);
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }
  function renderFindMy(el, kit) {
    const fm = kit.status({ row: 'privacy.find-my-device.state', label: 'Find my device', help: 'Lets you locate this PC from your Microsoft account if you lose it', value: 'Reading…',
      info: 'Read only here: Windows keeps Find my device for the whole PC with your Microsoft account; changing it needs an administrator and that account' });
    el.append(kit.group('Find my device'), kit.card(fm));
    const R = securityReader(kit, (r, why) => {
      if (!r) return fm.set({ value: '—', reason: why });
      const x = r.findMyDevice || {};
      fm.set({ value: x.on === true ? 'On' : x.on === false ? 'Off' : 'Not set', tone: x.on ? 'ok' : null,
        reason: x.reason || (x.on && x.locationOn === false ? 'Location is off for this PC, so Windows cannot say where it is' : null) });
    });
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }
  function renderEncryption(el, kit) {
    const en = kit.status({ row: 'privacy.encryption.state', label: 'Device encryption', help: 'Keeps your files unreadable to anyone who takes the drive out', value: 'Reading…',
      info: 'Read only here: turning encryption on or off needs an administrator and a recovery key saved first, and a mistake can lock your files away, so Mantle only shows it' });
    el.append(kit.group('Device encryption'), kit.card(en));
    const R = securityReader(kit, (r, why) => {
      if (!r) return en.set({ value: '—', reason: why });
      const x = r.encryption || {};
      const word = x.words ? x.words.charAt(0).toUpperCase() + x.words.slice(1) : 'Not reported';
      en.set({ label: x.kind === 'bitlocker' ? 'BitLocker (system drive)' : 'Device encryption', value: word, tone: x.on ? 'ok' : x.state != null ? 'warn' : null,
        reason: x.reason || (x.prevented ? 'Device encryption is turned off for this PC (PreventDeviceEncryption)' : null) });
    });
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }
  function renderSearching(el, kit) {
    const ix = kit.status({ row: 'privacy.searching.indexer', label: 'Indexer status', help: 'The Windows Search service that indexes your files', value: 'Reading…',
      info: 'Read only here: the indexer is a Windows service; starting it, stopping it or changing what it indexes needs an administrator. Mantle\'s own search reads its index when it runs' });
    el.append(kit.group('Searching Windows'), kit.card(ix));
    const R = securityReader(kit, (r, why) => {
      if (!r) return ix.set({ value: '—', reason: why });
      const x = r.indexer || {};
      ix.set({ value: x.running ? 'Running' : x.service || 'Not reported', tone: x.running ? 'ok' : 'warn', help: 'Windows Search service' + (x.startType ? ' · starts ' + String(x.startType).toLowerCase() : ''),
        reason: x.running ? null : x.reason || 'The Windows Search service is not running' });
    });
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }

  // ============================================================== the section
  const search = (list, uri) => list.map(([, row, label, help], i) => Object.assign({ row, label, keywords: (help || '').toLowerCase() }, i === 0 && uri ? { uri } : {}));
  const flat = (groups) => groups.reduce((a, g) => a.concat(g[1]), []);
  const pages = [
    { id: 'security', title: 'Windows Security', icon: 'shield', help: 'Antivirus, real-time and tamper protection, firewall',
      search: [
        { row: 'privacy.security.antivirus', label: 'Virus & threat protection', keywords: 'antivirus defender virus malware windows security', uri: 'ms-settings:windowsdefender' },
        { row: 'privacy.security.realtime', label: 'Real-time protection', keywords: 'defender real time scan' },
        { row: 'privacy.security.tamper', label: 'Tamper protection', keywords: 'defender tamper' },
        { row: 'privacy.security.definitions', label: 'Security intelligence', keywords: 'definitions signatures updates defender' },
        { row: 'privacy.security.firewall', label: 'Firewall & network protection', keywords: 'firewall network defender' },
      ], render: renderSecurity },
    { id: 'find-my-device', title: 'Find my device', icon: SVG.pin, help: 'Locate this PC if you lose it',
      search: [{ row: 'privacy.find-my-device.state', label: 'Find my device', keywords: 'lost stolen locate', uri: 'ms-settings:findmydevice' }], render: renderFindMy },
    { id: 'encryption', title: 'Device encryption', icon: 'lock', help: 'BitLocker and device encryption',
      search: [{ row: 'privacy.encryption.state', label: 'Device encryption', keywords: 'bitlocker encrypt drive', uri: 'ms-settings:deviceencryption' }], render: renderEncryption },
    { id: 'developers', title: 'For developers', icon: SVG.code, help: 'Developer Mode, End task',
      search: [{ row: 'privacy.developers.mode', label: 'Developer Mode', keywords: 'sideload developer mode dev', uri: 'ms-settings:developers' }].concat(search(flat(DEVS))),
      render: switchesPage(DEVS, developersMore) },
    { id: 'general', title: 'General', icon: 'shield', help: 'Advertising ID, local content, app launch tracking, suggestions',
      search: search(flat(GENERAL), 'ms-settings:privacy-general'), render: switchesPage(GENERAL) },
    { id: 'speech', title: 'Speech', icon: 'mic', help: 'Online speech recognition',
      search: search(flat(SPEECH), 'ms-settings:privacy-speech'), render: switchesPage(SPEECH) },
    { id: 'inking', title: 'Inking & typing personalization', icon: 'shortcuts', help: 'Custom inking and typing dictionary',
      search: search(flat(INKING), 'ms-settings:privacy-speechtyping'), render: switchesPage(INKING) },
    { id: 'diagnostics', title: 'Diagnostics & feedback', icon: 'apps', help: 'Diagnostic data, tailored experiences, feedback frequency',
      search: [{ row: 'privacy.diagnostics.level', label: 'Diagnostic data', keywords: 'telemetry required optional diagnostic data', uri: 'ms-settings:privacy-feedback' },
        { row: 'privacy.diagnostics.feedback', label: 'Feedback frequency', keywords: 'feedback how often ask' }].concat(search(flat(DIAG))),
      render: switchesPage(DIAG, diagnosticsMore) },
    { id: 'activity', title: 'Activity history', icon: 'apps', help: 'Store my activity history on this device',
      search: [{ row: 'privacy.activity.store', label: 'Activity history', keywords: 'timeline activity history', uri: 'ms-settings:privacy-activityhistory' }], render: renderActivity },
    { id: 'search-permissions', title: 'Search permissions', icon: SVG.search, help: 'SafeSearch, cloud content search, search history',
      search: [{ row: 'privacy.search.safesearch', label: 'SafeSearch', keywords: 'adult filter safe search strict moderate', uri: 'ms-settings:search-permissions' }].concat(search(flat(SEARCHP))),
      render: switchesPage(SEARCHP, safeSearchMore) },
    { id: 'searching-windows', title: 'Searching Windows', icon: SVG.search, help: 'The Windows Search indexer',
      search: [{ row: 'privacy.searching.indexer', label: 'Indexer status', keywords: 'index indexing windows search service wsearch', uri: 'ms-settings:cortana-windowssearch' }], render: renderSearching },
  ];
  CAPS.forEach(([pid, cap, title, noun, icon, uri, kw], i) => {
    pages.push({ id: pid, title, icon, help: 'Which apps can access ' + noun,
      search: [{ row: 'privacy.' + pid + '.user', label: 'Let apps access ' + noun, keywords: kw + ' ' + title.toLowerCase() + ' permission', uri },
        { row: 'privacy.' + pid + '.device', label: title + ' access', keywords: kw + ' everyone this pc' },
        { row: 'privacy.' + pid + '.apps', label: title + ': app permissions', keywords: kw + ' apps allow deny' }]
        .concat(['location', 'camera', 'microphone', 'screenshots', 'screenshot-borders'].indexOf(pid) >= 0 ? [{ row: 'privacy.' + pid + '.desktop', label: 'Let desktop apps access ' + noun, keywords: kw + ' desktop apps' }] : []),
      render: capPage(pid, cap, title, noun) });
    if (pid === 'microphone') {
      pages.push({ id: 'voice-activation', title: 'Voice activation', icon: 'mic', help: 'Apps that listen for a keyword',
        search: search(flat(VOICE), 'ms-settings:privacy-voiceactivation'), render: switchesPage(VOICE, voiceMore) });
    }
    if (pid === 'app-diagnostics') {
      pages.push({ id: 'automatic-file-downloads', title: 'Automatic file downloads', icon: SVG.folder, help: 'Apps that download online-only files',
        search: [{ row: 'privacy.file-downloads.allow', label: 'Automatic file downloads', keywords: 'onedrive cloud files download block', uri: 'ms-settings:privacy-automaticfiledownloads' }], render: renderDownloads });
    }
    void i;
  });

  MantleSettings.section({
    id: 'privacy',
    title: 'Privacy & security',
    group: 'windows',
    icon: 'shield',
    order: 100,
    help: 'Windows Security, app permissions, diagnostics, search',
    keywords: 'privacy security permissions app permissions defender antivirus',
    pages,
  });
})();
