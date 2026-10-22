// test-sysprivacy.js - SysPrivacy.cs (app permissions), SysPrivacyGeneral.cs (the page's own switches)
// and SysPrivacySecurity.cs (Windows Security status, read-only) against a PASSIVE sidecar (lane
// privacy, 2026-09-28).
//
//   node sidecar/test-sysprivacy.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes the user's privacy permissions: every write is proven by its dryRun (answered by a
// passive sidecar because it changes nothing) and by the passive refusal of the real write, and the
// administrator actions only by elevate.list (never run). Prints counts and shapes only, never an
// app's name, path or product name.
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSPRIVACY');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 15000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 240);

  try {
    // --- registration
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['privacy.caps', 'privacy.cap', 'privacy.capSet', 'privacy.settings', 'privacy.set', 'privacy.security']) {
      t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    }
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /Privacy/.test(p));
    t.check('no SysPrivacy registration problems', probs.length === 0, probs.join('; '));
    const el = await send('elevate.list');
    const acts = (el.ok && el.result && el.result.actions) || [];
    const dev = acts.find((a) => a.action === 'privacy.deviceAccess');
    const dm = acts.find((a) => a.action === 'privacy.developerMode');
    t.check('privacy.deviceAccess is an elevated action with its words', !!dev && /privacy permission for everyone/.test(dev.does), short(el));
    t.check('privacy.developerMode is an elevated action with its words', !!dm && /developer mode/.test(dm.does), short(el));
    const eprobs = ((el.result && el.result.problems) || []).filter((p) => /privacy/i.test(p));
    t.check('no elevate problems for the privacy actions', eprobs.length === 0, eprobs.join('; '));

    // --- privacy.caps
    const caps = await send('privacy.caps');
    const list = caps.ok && caps.result && caps.result.caps;
    t.check('privacy.caps answers a list of 25', Array.isArray(list) && list.length === 25, short(caps));
    const ok3 = (v) => v === null || v === 'Allow' || v === 'Deny' || v === 'Prompt';
    if (list) {
      t.check('every capability: device/user are Allow|Deny|Prompt|null', list.every((c) => ok3(c.device) && ok3(c.user)));
      t.check('every capability: a null says why', list.every((c) => (c.user !== null || c.userWhy || !c.present) && (c.device !== null || c.deviceWhy || !c.present)),
        short(list.filter((c) => (c.user === null && !c.userWhy) || (c.device === null && !c.deviceWhy)).map((c) => c.capability)));
      t.check('camera, location, microphone and screenshots have a desktop switch', ['webcam', 'location', 'microphone', 'graphicsCaptureProgrammatic'].every((k) => list.find((c) => c.capability === k).hasDesktop));
      t.check('a missing store says why', list.every((c) => c.present || /no app has asked/.test(c.reason)));
      t.check('apps and inUse are counts', list.every((c) => Number.isInteger(c.apps) && Number.isInteger(c.inUse)));
      console.log(`  (${list.filter((c) => c.present).length} of 25 present, ${list.filter((c) => c.policy).length} under a policy)`);
    }

    // --- privacy.cap webcam
    const cam = await send('privacy.cap', { capability: 'webcam' });
    const cr = cam.ok && cam.result;
    t.check('privacy.cap webcam answers apps and desktop apps', cr && Array.isArray(cr.apps) && Array.isArray(cr.desktopApps), short(cam));
    if (cr) {
      t.check('every app has a name, a family key and a value', cr.apps.every((a) => a.name && a.app && a.kind === 'packaged' && ok3(a.value)));
      t.check('every app name was resolved (not the raw family name)', cr.apps.every((a) => !/_[a-z0-9]{13}$/.test(a.name)));
      t.check('every desktop app has a name and a path, no switch', cr.desktopApps.every((a) => a.name && a.path && a.kind === 'desktop' && !('value' in a)));
      t.check('last used is ms since 1970 or null', cr.apps.concat(cr.desktopApps).every((a) => a.lastUsed === null || (a.lastUsed > 1.3e12 && a.lastUsed < 2.2e12)));
      console.log(`  (webcam: ${cr.apps.length} apps, ${cr.desktopApps.length} desktop apps, ${cr.hiddenApps} not installed, ${cr.apps.concat(cr.desktopApps).filter((a) => a.inUse).length} in use)`);
      // --- capSet dryRun: the CURRENT value in every scope (a no-op even if it were real)
      const cur = (v) => v !== 'Deny';
      const d1 = await send('privacy.capSet', { capability: 'webcam', scope: 'user', allow: cur(cr.user), dryRun: true });
      t.check('capSet user dryRun says what it would do', d1.ok && d1.result.dryRun && /^set "let apps use webcam"/.test(d1.result.would) && d1.result.writes[0].hive === 'HKCU', short(d1));
      const d2 = await send('privacy.capSet', { capability: 'webcam', scope: 'desktop', allow: cur(cr.desktop), dryRun: true });
      t.check('capSet desktop dryRun names NonPackaged', d2.ok && d2.result.dryRun && /NonPackaged$/.test(d2.result.writes[0].key), short(d2));
      const d3 = await send('privacy.capSet', { capability: 'webcam', scope: 'device', allow: cur(cr.device), dryRun: true });
      t.check('capSet device dryRun says administrator and HKLM', d3.ok && d3.result.dryRun && /administrator permission/.test(d3.result.would) && d3.result.writes[0].hive === 'HKLM' && d3.result.needsAdmin === true, short(d3));
      if (cr.apps.length) {
        const a = cr.apps[0];
        const d4 = await send('privacy.capSet', { capability: 'webcam', scope: 'app', app: a.app, allow: cur(a.value), dryRun: true });
        t.check('capSet app dryRun on a listed app', d4.ok && d4.result.dryRun && /let this app use webcam/.test(d4.result.would), short(d4));
      }
      const r1 = await send('privacy.capSet', { capability: 'webcam', scope: 'user', allow: cur(cr.user) });
      t.check('a real capSet is refused in passive', refused(r1), short(r1));
      const r2 = await send('privacy.capSet', { capability: 'webcam', scope: 'device', allow: cur(cr.device) });
      t.check('a real device capSet is refused in passive (no prompt)', refused(r2), short(r2));
      const after = await send('privacy.cap', { capability: 'webcam' });
      t.check('nothing changed', after.ok && after.result.user === cr.user && after.result.device === cr.device && after.result.desktop === cr.desktop);
    }
    // bad args
    const bads = [
      [{ capability: 'nope', scope: 'user', allow: true, dryRun: true }, /permission names/],
      [{ capability: '..\\..\\Run', scope: 'user', allow: true, dryRun: true }, /permission names/],
      [{ capability: 'webcam', scope: 'all', allow: true, dryRun: true }, /scope/],
      [{ capability: 'webcam', scope: 'user', allow: 'yes', dryRun: true }, /true or false/],
      [{ capability: 'contacts', scope: 'desktop', allow: true, dryRun: true }, /no desktop-apps switch/],
      [{ capability: 'webcam', scope: 'app', app: 'NonPackaged', allow: true, dryRun: true }, /family name/],
      [{ capability: 'webcam', scope: 'app', app: 'x\\..\\y', allow: true, dryRun: true }, /family name/],
      [{ capability: 'webcam', scope: 'app', app: 'Made.Up_abcdefghijklm', allow: true, dryRun: true }, /never asked/],
    ];
    for (const [a, re] of bads) {
      const r = await send('privacy.capSet', a);
      t.check(`capSet refuses ${short(a).slice(0, 70)}`, r.ok === false && re.test(r.error), short(r));
    }
    const nc = await send('privacy.cap', { capability: 'Run' });
    t.check('privacy.cap refuses an unknown capability', nc.ok === false && /permission names/.test(nc.error));

    // --- privacy.settings
    const st = await send('privacy.settings');
    const v = st.ok && st.result && st.result.values;
    t.check('privacy.settings answers values', !!v, short(st));
    const SW = ['advertisingId', 'languageList', 'appLaunchTracking', 'suggestedContent', 'settingsNotifications', 'onlineSpeech', 'inkingDictionary',
      'improveInking', 'tailored', 'cloudSearchMsa', 'cloudSearchWork', 'searchHistory', 'searchHighlights', 'voiceActivation', 'voiceLock', 'endTask'];
    if (v) {
      t.check('every switch is on/off/null with a lock field', SW.every((k) => v[k] && (v[k].on === null || typeof v[k].on === 'boolean') && 'locked' in v[k]), short(SW.filter((k) => !v[k])));
      t.check('safeSearch is off|moderate|strict', ['off', 'moderate', 'strict'].includes(v.safeSearch.value));
      t.check('feedback is a known choice', ['auto', 'always', 'day', 'week', 'never', 'custom'].includes(v.feedback.value));
      t.check('diagLevel is read with its read-only reason', /Windows keeps|policy/.test(v.diagLevel.why), short(v.diagLevel));
      t.check('activity history says why it is read-only', typeof v.activity.why === 'string' && v.activity.why.length > 20);
      t.check('developer mode: on is a bool, admin words', typeof v.developerMode.on === 'boolean' && /developer mode/.test(v.developerMode.does));
      for (const k of SW) {
        if (v[k].locked) continue;
        const d = await send('privacy.set', { key: k, value: v[k].on === true, dryRun: true });
        t.check(`${k} dryRun says what it would write`, d.ok && d.result.dryRun && /^turn "/.test(d.result.would) && d.result.writes.length >= 1, short(d));
      }
      const ink = await send('privacy.set', { key: 'inkingDictionary', value: v.inkingDictionary.on === true, dryRun: true });
      t.check('the inking dictionary writes its 4 values', ink.ok && ink.result.writes.length === 4, short(ink));
      const ss = await send('privacy.set', { key: 'safeSearch', value: v.safeSearch.value, dryRun: true });
      t.check('safeSearch dryRun', ss.ok && ss.result.dryRun && /SafeSearch/.test(ss.result.would), short(ss));
      if (!v.feedback.locked && v.feedback.value !== 'custom') {
        const fb = await send('privacy.set', { key: 'feedback', value: v.feedback.value, dryRun: true });
        t.check('feedback dryRun', fb.ok && fb.result.dryRun && /feedback/.test(fb.result.would), short(fb));
      }
      const dv = await send('privacy.set', { key: 'developerMode', value: v.developerMode.on, dryRun: true });
      t.check('developer mode dryRun names the administrator prompt', dv.ok && dv.result.dryRun && /administrator permission/.test(dv.result.would), short(dv));
      const rd = await send('privacy.set', { key: 'developerMode', value: v.developerMode.on });
      t.check('a real developer mode change is refused in passive (no prompt)', refused(rd), short(rd));
      const ra = await send('privacy.set', { key: 'advertisingId', value: v.advertisingId.on === true });
      t.check('a real switch change is refused in passive', refused(ra), short(ra));
      const again = await send('privacy.settings');
      t.check('nothing changed', again.ok && SW.every((k) => again.result.values[k].on === v[k].on) && again.result.values.developerMode.on === v.developerMode.on);
    }
    const sb = [
      [{ value: true }, /needs key/], [{ key: 'advertisingId' }, /needs value/], [{ key: 'advertisingId', value: 1, dryRun: true }, /true or false/],
      [{ key: 'nope', value: true, dryRun: true }, /unknown key/], [{ key: 'safeSearch', value: 'max', dryRun: true }, /moderate/],
      [{ key: 'feedback', value: 'hourly', dryRun: true }, /auto/], [{ key: 'diagLevel', value: 'required', dryRun: true }, /^Read only/],
      [{ key: 'activity', value: false, dryRun: true }, /^Read only/],
    ];
    for (const [a, re] of sb) {
      const r = await send('privacy.set', a);
      t.check(`set refuses ${short(a).slice(0, 60)}`, r.ok === false && re.test(r.error), short(r));
    }

    // --- privacy.security
    const sec = await send('privacy.security', {}, 30000);
    const x = sec.ok && sec.result;
    t.check('privacy.security answers', !!x, short(sec));
    if (x) {
      t.check('antivirus: a list, or why not', Array.isArray(x.antivirus) && (x.antivirus.length > 0 || !!x.antivirusWhy));
      t.check('antivirus entries: on/upToDate bools', x.antivirus.every((a) => typeof a.on === 'boolean' && typeof a.upToDate === 'boolean'));
      t.check('defender: status or a reason', x.defender.ok ? typeof x.defender.realTime === 'boolean' && typeof x.defender.tamper === 'boolean' : typeof x.defender.reason === 'string', short(x.defender));
      t.check('firewall: three profiles', x.firewall.profiles.length === 3 && x.firewall.profiles.every((p) => typeof p.on === 'boolean' || p.reason));
      t.check('encryption: a state or a reason', x.encryption.state !== null || typeof x.encryption.reason === 'string', short(x.encryption));
      t.check('find my device: on or a reason', typeof x.findMyDevice.on === 'boolean' || typeof x.findMyDevice.reason === 'string');
      t.check('indexer: a service state', typeof x.indexer.service === 'string' || typeof x.indexer.reason === 'string', short(x.indexer));
      console.log(`  (antivirus ${x.antivirus.length}, defender rtp ${x.defender.realTime}, tamper ${x.defender.tamper}, firewall ${x.firewall.profiles.map((p) => p.on).join('/')}, encryption ${x.encryption.words}, indexer ${x.indexer.service})`);
    }
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
