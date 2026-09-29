// test-systime.js - SysTime.cs (date & time), SysTimeRegion.cs (region formats) and SysTimeLang.cs
// (language, typing, speech) against a PASSIVE sidecar (lane timelang, 2026-09-28).
//
//   node sidecar/test-systime.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes Owen's clock, time zone, formats, region, language or typing: every write is proven
// by its dryRun (which a passive sidecar answers, because it changes nothing) and by the passive
// refusal of the real write. The administrator actions are proven through elevate.run's validator,
// which runs BEFORE the passive refusal: no prompt can appear (MANTLE_ELEVATE_TEST is removed).
// At the end every value read at the start is read again and must be unchanged. Prints counts and
// shapes only.
'use strict';
delete process.env.MANTLE_ELEVATE_TEST;
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSTIME');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 10000);
  const res = (r) => (r && r.ok && r.result) || null;
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const errOf = (r) => String((r && (r.error || (r.result && r.result.reason))) || '');
  const dry = (r) => { const x = res(r); return !!x && x.ok === true && x.dryRun === true; };

  try {
    // ---------------------------------------------------------------- registration
    const ping = await send('ping');
    const feats = ping.ok && ping.result && ping.result.features;
    const cmds = (feats && feats.commands) || [];
    const mine = ['systime.get', 'systime.zones', 'systime.setZone', 'systime.setDst', 'systime.setAutoSync', 'systime.setAutoZone',
      'systime.setClock', 'systime.syncNow', 'systime.setExtraClock', 'systime.setTray', 'sysregion.get', 'sysregion.lists',
      'sysregion.preview', 'sysregion.setFormat', 'sysregion.setLocale', 'sysregion.setGeo', 'syslang.get', 'syslang.setTyping', 'syslang.setPerAppInput'];
    const missing = mine.filter((c) => !cmds.includes(c));
    t.check(`all ${mine.length} commands are registered`, missing.length === 0, missing.join(' '));
    const probs = ((feats && feats.problems) || []).filter((p) => /SysTime|SysRegion|SysLang/.test(p));
    t.check('no SysTime/SysRegion/SysLang registration problems', probs.length === 0, probs.join('; '));
    const el = res(await send('elevate.list'));
    const acts = (el && el.actions) || [];
    for (const [a, words] of [['time.setAutoSync', /time automatically/], ['time.setAutoZone', /time zone automatically/], ['time.setClock', /date and time/], ['time.syncNow', /sync the clock/]]) {
      const x = acts.find((y) => y.action === a);
      t.check(`${a} is an elevated action with its words`, !!x && words.test(x.does), x ? x.does : 'missing');
    }
    const eprobs = ((el && el.problems) || []).filter((p) => /time\.|SysTime/i.test(p));
    t.check('no elevate problems for the time actions', eprobs.length === 0, eprobs.join('; '));

    // the validators, through elevate.run: a bad request is refused by the validator, a good one by
    // the passive sidecar (the validator runs first, the passive refusal before any prompt)
    const run = (action, args) => send('elevate.run', { action, args }, 8000);
    const good = { year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0 };
    let r = await run('time.setClock', Object.assign({}, good, { month: 2, day: 30 }));
    t.check('time.setClock validator refuses 30 February', r.ok === false && /only 28 days|only 29 days/.test(errOf(r)), errOf(r));
    r = await run('time.setClock', Object.assign({}, good, { year: 1999 }));
    t.check('time.setClock validator refuses a year out of range', r.ok === false && /year must be/.test(errOf(r)), errOf(r));
    r = await run('time.setClock', Object.assign({}, good, { path: 'x' }));
    t.check('time.setClock validator refuses an unknown key', r.ok === false && /not something this action takes/.test(errOf(r)), errOf(r));
    r = await run('time.setClock', good);
    t.check('time.setClock with good args: refused by the passive sidecar, no prompt', refused(r), errOf(r));
    r = await run('time.setAutoSync', { on: 'yes' });
    t.check('time.setAutoSync validator wants a bool', r.ok === false && /on must be true or false/.test(errOf(r)), errOf(r));
    r = await run('time.setAutoZone', { on: true });
    t.check('time.setAutoZone with good args: passive refusal, no prompt', refused(r), errOf(r));
    r = await run('time.syncNow', { server: 'evil.example' });
    t.check('time.syncNow validator takes no arguments at all', r.ok === false && /not something this action takes/.test(errOf(r)), errOf(r));

    // ---------------------------------------------------------------- systime.get
    const g0 = res(await send('systime.get'));
    t.check('systime.get answers', !!g0 && g0.ok === true, JSON.stringify(g0).slice(0, 200));
    const Z = g0 && g0.zone;
    t.check('zone: a key, a name and an offset', Z && typeof Z.key === 'string' && Z.key.length > 2 && typeof Z.name === 'string' && Number.isInteger(Z.offsetMinutes));
    t.check('zone: the privilege path is read (SeTimeZonePrivilege held, NOT enabled)', Z && Z.privilege && Z.privilege.held === true && Z.privilege.enabled === false, JSON.stringify(Z && Z.privilege));
    t.check('zone: writable, or a reason', Z && (Z.writable === true ? Z.reason === null : typeof Z.reason === 'string'));
    t.check('zone: dstAuto is a bool; a zone without DST says so', Z && typeof Z.dstAuto === 'boolean' && (Z.supportsDst || /no daylight saving/.test(Z.dstReason || '')));
    const A = g0 && g0.autoTime;
    t.check('autoTime: on, servers, service state, admin action', A && typeof A.on === 'boolean' && Array.isArray(A.servers) && A.service && A.admin === 'time.setAutoSync', JSON.stringify(A && A.service));
    t.check('autoTime: last good time, or why not', A && (typeof A.lastGood === 'string' || typeof A.lastGoodReason === 'string'));
    const AZ = g0 && g0.autoZone;
    t.check('autoZone: on, works, blocked reason when it cannot work', AZ && typeof AZ.on === 'boolean' && typeof AZ.works === 'boolean' && (AZ.works || typeof AZ.blocked === 'string'));
    t.check('clock + sync rows carry their admin actions', g0 && g0.clock.admin === 'time.setClock' && g0.sync.admin === 'time.syncNow');
    t.check('manual clock says why when automatic sync is on', g0 && (A.on ? /Set time automatically is on/.test(g0.clock.reason) : g0.clock.reason === null));
    t.check('two additional clock slots', g0 && Array.isArray(g0.extraClocks) && g0.extraClocks.length === 2 && g0.extraClocks.every((c) => typeof c.on === 'boolean'));
    t.check('tray: seconds + hidden-clock policy', g0 && g0.tray && typeof g0.tray.showSeconds.on === 'boolean' && typeof g0.tray.clockHidden.on === 'boolean');
    t.check('the clock reads now (local within 5 s of this machine)', g0 && Math.abs(g0.now.epochMs - Date.now()) < 5000 && typeof g0.now.date === 'string' && typeof g0.now.time === 'string');
    t.check('no systime.get problems', g0 && g0.problems.length === 0, g0 && g0.problems.join('; '));
    console.log(`  (auto time ${A && A.on}, service ${A && A.service.state}, auto zone ${AZ && AZ.on}, works ${AZ && AZ.works}, supports DST ${Z && Z.supportsDst})`);

    const zl = res(await send('systime.zones'));
    const zones = (zl && zl.zones) || [];
    t.check('systime.zones lists 100+ zones including the current one', zones.length >= 100 && zones.some((z) => z.zone === (Z && Z.key)), `zones ${zones.length}`);
    const other = zones.find((z) => z.zone !== (Z && Z.key) && z.dst === true) || zones.find((z) => z.zone !== (Z && Z.key));

    // ---------------------------------------------------------------- zone writes (dryRun only)
    r = await send('systime.setZone', { zone: Z.key, dryRun: true });
    t.check('setZone dryRun (current zone): ok with a plan', dry(r) && /change the time zone/.test(res(r).would) && res(r).writes[0].api === 'SetDynamicTimeZoneInformation', errOf(r));
    r = await send('systime.setZone', { zone: other.zone, dryRun: true });
    const zp = res(r);
    t.check('setZone dryRun (another zone): names it, privilege held but not enabled', dry(r) && zp.zone === other.zone && zp.privilege.held === true && zp.privilege.enabled === false, errOf(r));
    r = await send('systime.setZone', { zone: 'Not A Real Zone', dryRun: true });
    t.check('setZone refuses an unknown zone', r.ok === false && /does not know a time zone/.test(errOf(r)), errOf(r));
    r = await send('systime.setZone', { zone: '..\\..\\Run', dryRun: true });
    t.check('setZone refuses a path-like key', r.ok === false && /not a time zone key/.test(errOf(r)), errOf(r));
    r = await send('systime.setZone', { zone: Z.key });
    t.check('setZone real: refused by the passive sidecar', refused(r), errOf(r));
    if (Z.supportsDst) {
      r = await send('systime.setDst', { on: Z.dstAuto, dryRun: true });
      t.check('setDst dryRun: a plan through SetDynamicTimeZoneInformation', dry(r) && /daylight saving/.test(res(r).would), errOf(r));
      r = await send('systime.setDst', { on: !Z.dstAuto });
      t.check('setDst real: passive refusal', refused(r), errOf(r));
    } else t.check('setDst on a zone without DST says so', /no daylight saving/.test(errOf(await send('systime.setDst', { on: true, dryRun: true }))));
    r = await send('systime.setDst', { on: 'yes', dryRun: true });
    t.check('setDst wants a bool', r.ok === false && /true or false/.test(errOf(r)), errOf(r));

    // ---------------------------------------------------------------- administrator rows: plans
    for (const [cmd, args, action] of [['systime.setAutoSync', { on: A.on }, 'time.setAutoSync'], ['systime.setAutoZone', { on: AZ.on }, 'time.setAutoZone'],
      ['systime.setClock', good, 'time.setClock']]) {
      r = await send(cmd, Object.assign({ dryRun: true }, args));
      const p = res(r);
      t.check(`${cmd} dryRun: a plan naming ${action}`, dry(r) && p.elevate && p.elevate.action === action && /administrator permission/.test(p.would) && p.needsAdmin === true, errOf(r));
      r = await send(cmd, args);
      t.check(`${cmd} real: passive refusal`, refused(r), errOf(r));
    }
    r = await send('systime.setClock', Object.assign({}, good, { day: 31, month: 4, dryRun: true }));
    t.check('setClock refuses 31 April before any prompt', r.ok === false && /only 30 days/.test(errOf(r)), errOf(r));
    r = await send('systime.syncNow', { dryRun: true });
    t.check('syncNow dryRun: a plan (automatic time on) or the reason it cannot', A.on ? (dry(r) && res(r).elevate.action === 'time.syncNow') : (r.ok === false && /off/.test(errOf(r))), errOf(r));
    r = await send('systime.syncNow', {});
    t.check('syncNow real: passive refusal (or the reason)', refused(r) || (!A.on && r.ok === false), errOf(r));

    // ---------------------------------------------------------------- HKCU rows
    r = await send('systime.setExtraClock', { slot: 1, on: true, zone: other.zone, name: 'Made up', dryRun: true });
    t.check('setExtraClock dryRun: three registry values', dry(r) && res(r).writes.length === 3 && res(r).writes.every((w) => w.hive === 'HKCU'), errOf(r));
    r = await send('systime.setExtraClock', { slot: 3, on: true, zone: other.zone, dryRun: true });
    t.check('setExtraClock refuses slot 3', r.ok === false && /slot/.test(errOf(r)), errOf(r));
    r = await send('systime.setExtraClock', { slot: 2, on: true, zone: other.zone, name: 'x'.repeat(16), dryRun: true });
    t.check('setExtraClock refuses a 16-character name', r.ok === false && /15 characters/.test(errOf(r)), errOf(r));
    r = await send('systime.setExtraClock', { slot: 2, on: true, zone: 'Nope', dryRun: true });
    t.check('setExtraClock refuses an unknown zone', r.ok === false && /does not know/.test(errOf(r)), errOf(r));
    r = await send('systime.setExtraClock', { slot: 1, on: true, zone: other.zone });
    t.check('setExtraClock real: passive refusal', refused(r), errOf(r));
    r = await send('systime.setTray', { key: 'showSeconds', value: true, dryRun: true });
    t.check('setTray dryRun: ShowSecondsInSystemClock', dry(r) && res(r).writes[0].name === 'ShowSecondsInSystemClock', errOf(r));
    r = await send('systime.setTray', { key: 'showSeconds', value: true });
    t.check('setTray real: passive refusal', refused(r), errOf(r));

    // ---------------------------------------------------------------- region
    const rg0 = res(await send('sysregion.get'));
    t.check('sysregion.get answers a locale and a region', rg0 && typeof rg0.locale.name === 'string' && typeof rg0.locale.display === 'string' && typeof rg0.geo.code === 'string', JSON.stringify(rg0 && rg0.geo));
    const keys = ['shortDate', 'longDate', 'shortTime', 'longTime', 'firstDayOfWeek', 'measure'];
    t.check('every format row has a value and choices', rg0 && keys.every((k) => rg0.formats[k] && typeof rg0.formats[k].value === 'string' && rg0.formats[k].options.length >= 2),
      rg0 && keys.filter((k) => !(rg0.formats[k] && rg0.formats[k].options.length >= 2)).join(' '));
    t.check('each date choice carries a live sample', rg0 && rg0.formats.shortDate.options.every((o) => typeof o.sample === 'string' && o.sample.length >= 6));
    t.check('the current value is among the choices', rg0 && keys.every((k) => rg0.formats[k].options.some((o) => o.value === rg0.formats[k].value)));
    t.check('the preview has numbers, money, dates and times', rg0 && ['number', 'currency', 'shortDate', 'longDate', 'shortTime', 'longTime', 'calendar'].every((k) => typeof rg0.preview[k] === 'string' && rg0.preview[k].length > 0), JSON.stringify(rg0 && rg0.preview).length);
    t.check('the regional format can be switched (NlsUpdateLocale present)', rg0 && rg0.locale.reason === null, rg0 && rg0.locale.reason);
    t.check('the system locale is read-only with its reason', rg0 && typeof rg0.systemLocale.name === 'string' && /administrat/.test(rg0.systemLocale.reason));
    console.log(`  (overrides: ${rg0 && rg0.overrides.length}, short date choices: ${rg0 && rg0.formats.shortDate.options.length})`);
    const ls = res(await send('sysregion.lists', {}, 20000));
    t.check('sysregion.lists: 100+ formats and 100+ regions, including the current ones', ls && ls.locales.length >= 100 && ls.geos.length >= 100 &&
      ls.locales.some((l) => l.locale.toLowerCase() === rg0.locale.name.toLowerCase()) && ls.geos.some((x) => x.geo === rg0.geo.code), ls ? `${ls.locales.length} / ${ls.geos.length}` : 'no answer');
    const pv = res(await send('sysregion.preview', { locale: 'en-GB' }));
    t.check('sysregion.preview en-GB: day before month, pound sign', pv && /^\d\d\/\d\d\/\d{4}$/.test(pv.preview.shortDate) && /£/.test(pv.preview.currency), pv && JSON.stringify(pv.preview).slice(0, 160));
    r = await send('sysregion.preview', { locale: 'xx-NOPE' });
    t.check('sysregion.preview refuses an unknown format', r.ok === false, errOf(r));

    for (const k of keys) {
      r = await send('sysregion.setFormat', { key: k, value: rg0.formats[k].value, dryRun: true });
      t.check(`setFormat ${k} dryRun: SetLocaleInfoW + the intl broadcast`, dry(r) && res(r).writes[0].api === 'SetLocaleInfoW' && res(r).writes[1].lParam === 'intl', errOf(r));
    }
    r = await send('sysregion.setFormat', { key: 'shortDate', value: 'yyyy"; rm', dryRun: true });
    t.check('setFormat refuses a format Windows does not list', r.ok === false && /not one of the choices/.test(errOf(r)), errOf(r));
    r = await send('sysregion.setFormat', { key: 'sDecimal', value: ',', dryRun: true });
    t.check('setFormat refuses a key outside its table', r.ok === false && /key must be one of/.test(errOf(r)), errOf(r));
    r = await send('sysregion.setFormat', { key: 'shortDate', value: rg0.formats.shortDate.value });
    t.check('setFormat real: passive refusal', refused(r), errOf(r));
    r = await send('sysregion.setLocale', { locale: 'en-GB', dryRun: true });
    t.check('setLocale dryRun: NlsUpdateLocale with the new format\'s preview', dry(r) && res(r).writes[0].api === 'NlsUpdateLocale' && res(r).preview && /English/.test(res(r).would), errOf(r));
    r = await send('sysregion.setLocale', { locale: 'zz-ZZ', dryRun: true });
    t.check('setLocale refuses an unknown format', r.ok === false && /regional format Windows lists/.test(errOf(r)), errOf(r));
    r = await send('sysregion.setLocale', { locale: 'en-GB' });
    t.check('setLocale real: passive refusal', refused(r), errOf(r));
    r = await send('sysregion.setGeo', { geo: 'GB', dryRun: true });
    t.check('setGeo dryRun: SetUserGeoName', dry(r) && res(r).writes[0].api === 'SetUserGeoName', errOf(r));
    r = await send('sysregion.setGeo', { geo: 'ZZ', dryRun: true });
    t.check('setGeo refuses an unknown region', r.ok === false, errOf(r));
    r = await send('sysregion.setGeo', { geo: 'GB' });
    t.check('setGeo real: passive refusal', refused(r), errOf(r));

    // ---------------------------------------------------------------- language, typing, speech
    const lg = res(await send('syslang.get'));
    t.check('syslang.get: 1+ preferred languages with keyboards', lg && lg.languages.length >= 1 && lg.languages.every((l) => typeof l.name === 'string' && Array.isArray(l.keyboards)), lg && lg.languagesReason);
    t.check('display language read, read-only with its reason', lg && typeof lg.display.now === 'string' && /sign-in/.test(lg.display.reason));
    t.check('add/order reasons are on the answer', lg && /language pack/.test(lg.addReason) && /SetUserLanguages/.test(lg.orderReason));
    t.check('9 typing switches, each on/off with its registry place', lg && lg.typing.length === 9 && lg.typing.every((x) => typeof x.on === 'boolean' && /^HKCU\\/.test(x.registry)));
    t.check('per-app input method read (SPI)', lg && typeof lg.keyboard.perAppInput.on === 'boolean');
    t.check('default input + language bar read-only with reasons', lg && /not wired/.test(lg.keyboard.defaultInput.reason) && /CTF/.test(lg.keyboard.languageBar.reason));
    t.check('speech: voices and recognizers listed', lg && lg.speech.voices.length >= 1 && lg.speech.recognizers.length >= 1 && /speech/.test(lg.speech.reason), lg && `${lg.speech.voices.length} voices`);
    console.log(`  (languages ${lg && lg.languages.length}, typing set ${lg && lg.typing.filter((x) => x.set).length}/9, voices ${lg && lg.speech.voices.length}, recognizers ${lg && lg.speech.recognizers.length})`);
    r = await send('syslang.setTyping', { key: 'autocorrect', value: true, dryRun: true });
    t.check('setTyping dryRun: one HKCU DWORD', dry(r) && res(r).writes.length === 1 && res(r).writes[0].name === 'EnableAutocorrection', errOf(r));
    r = await send('syslang.setTyping', { key: 'Run', value: true, dryRun: true });
    t.check('setTyping refuses an unknown key', r.ok === false && /unknown key/.test(errOf(r)), errOf(r));
    r = await send('syslang.setTyping', { key: 'autocorrect', value: true });
    t.check('setTyping real: passive refusal', refused(r), errOf(r));
    r = await send('syslang.setPerAppInput', { on: lg.keyboard.perAppInput.on, dryRun: true });
    t.check('setPerAppInput dryRun: SPI 0x104F', dry(r) && /0x104F/.test(res(r).writes[0].action), errOf(r));
    r = await send('syslang.setPerAppInput', { on: true });
    t.check('setPerAppInput real: passive refusal', refused(r), errOf(r));

    // ---------------------------------------------------------------- nothing changed
    const g1 = res(await send('systime.get'));
    const rg1 = res(await send('sysregion.get'));
    t.check('after all of it: zone, DST and privilege unchanged', g1 && g1.zone.key === Z.key && g1.zone.dstAuto === Z.dstAuto && g1.zone.privilege.enabled === false);
    t.check('after all of it: automatic time/zone unchanged', g1 && g1.autoTime.on === A.on && g1.autoZone.on === AZ.on && JSON.stringify(g1.extraClocks) === JSON.stringify(g0.extraClocks));
    t.check('after all of it: format, region and every format row unchanged', rg1 && rg1.locale.name === rg0.locale.name && rg1.geo.code === rg0.geo.code && keys.every((k) => rg1.formats[k].value === rg0.formats[k].value));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  }
  await s.stop();
  process.exit(t.summary());
})();
