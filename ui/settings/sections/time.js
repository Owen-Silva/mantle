/* time.js — Settings > Time & language, done natively (lane timelang, 2026-09-28).
 *
 * The user: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". Every row reads and changes the setting itself through settings.time.*
 * (lib/features/_settings-sections/time.js -> sidecar/SysTime*.cs); nothing hands off to Windows'
 * Settings app. What only an administrator may change carries the shield and goes through ONE
 * administrator prompt per change (sidecar/ELEVATE.md). What Mantle does not change is read-only
 * with the exact reason on the row.
 *
 * Pages: Date & time, Language & region (display language, preferred languages, country or region,
 * regional format with a live preview and every format override), Typing, Speech. Kit only
 * (ui/settings/SECTIONS.md): no CSS of its own.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.time.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const pad = (n) => String(n).padStart(2, '0');
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const stamp = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 10) + ' ' + iso.slice(11, 16) : null);
  /* Two choices that look the same NOW (h:mm and hh:mm at 12:22) get their pattern beside them. */
  const fmtOpts = (opts) => {
    const seen = {};
    (opts || []).forEach((o) => { seen[o.label] = (seen[o.label] || 0) + 1; });
    return (opts || []).map((o) => ({ value: o.value, label: seen[o.label] > 1 ? o.label + '  (' + o.value + ')' : o.label }));
  };
  const zoneOpts = (zones) => zones.map((z) => ({ value: z.zone, label: z.name || z.zone }));

  // ============================================================== Date & time
  const TRAY_WHY = 'Read only here: Windows 11 keeps this switch in a value it has never written on this PC, so where it lives is not measured yet and Mantle does not change it';
  const CAL_WHY = 'Read only here: Windows keeps this choice for its own taskbar calendar in a value not measured on this PC, so Mantle neither reads nor changes it yet';

  function dateTimePage(el, kit) {
    let last = null, zones = null;
    const now = kit.status({ row: 'time.datetime.now', label: 'Date and time', icon: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/>', value: 'Reading the clock…' });
    const autoTime = kit.toggle({ row: 'time.datetime.autoTime', label: 'Set time automatically', admin: 'turn setting the time automatically on or off',
      onChange: (on) => after(C(kit, 'setAutoSync', { on })) });
    const autoZone = kit.toggle({ row: 'time.datetime.autoZone', label: 'Set time zone automatically', admin: 'turn setting the time zone automatically on or off',
      onChange: (on) => after(C(kit, 'setAutoZone', { on })) });
    const zone = kit.choice({ row: 'time.datetime.zone', label: 'Time zone', style: 'dropdown', options: [], value: null,
      onChange: (v) => after(C(kit, 'setZone', { zone: v })) });
    const dst = kit.toggle({ row: 'time.datetime.dst', label: 'Adjust for daylight saving time automatically',
      onChange: (on) => after(C(kit, 'setDst', { on })) });
    const manual = kit.button({ row: 'time.datetime.manual', label: 'Set the date and time manually', text: 'Change',
      onClick: () => { openEditor(); return { ok: true }; } });
    const editor = kit.h('div', {});
    const sync = kit.button({ row: 'time.datetime.sync', label: 'Synchronize your clock', admin: 'sync the clock with the time server now', text: 'Sync now',
      onClick: () => after(C(kit, 'syncNow')) });
    const seconds = kit.toggle({ row: 'time.datetime.traySeconds', label: 'Show seconds in the system tray clock', help: 'Windows\' own taskbar clock',
      onChange: (value) => after(C(kit, 'setTray', { key: 'showSeconds', value })) });
    const trayClock = kit.status({ row: 'time.datetime.trayClock', label: 'Show time and date in the system tray', value: '…' });
    const calendar = kit.status({ row: 'time.datetime.calendar', label: 'Show additional calendars in the taskbar', value: 'Not read', reason: CAL_WHY });
    const clocksBox = kit.h('div', {});
    el.append(kit.card(now), kit.card(autoTime, autoZone, zone, dst), kit.card(manual), editor, kit.card(sync),
      kit.group('Additional settings'), kit.card(seconds, trayClock, calendar),
      kit.group('Additional clocks', { row: 'time.datetime.clocks' }), clocksBox);

    const after = (p) => Promise.resolve(p).then((r) => { if (r && r.ok && !r.dryRun) setTimeout(read, 400); return r; });

    // ---- additional clocks: switch + zone + name per slot
    const clocks = [1, 2].map((slot) => {
      const st = { on: false, zone: null, name: '' };
      const save = (patch) => C(kit, 'setExtraClock', Object.assign({ slot, on: st.on, zone: st.zone || (last && last.zone.key) || undefined, name: st.name }, patch));
      const t = kit.toggle({ row: 'time.datetime.clock' + slot, label: 'Show additional clock ' + slot, help: 'Windows shows it in its taskbar clock\'s pop-up and tooltip',
        onChange: (on) => after(save({ on })) });
      const z = kit.choice({ row: 'time.datetime.clock' + slot + '.zone', label: 'Time zone', style: 'dropdown', options: [], value: null,
        onChange: (v) => after(save({ zone: v })) });
      const n = kit.text({ row: 'time.datetime.clock' + slot + '.name', label: 'Display name', value: '', placeholder: 'Clock ' + slot,
        onChange: (s) => (s.length > 15 ? { ok: false, reason: 'Windows allows at most 15 characters' } : after(save({ name: s }))) });
      clocksBox.append(kit.card(t, z, n));
      return { st, t, z, n };
    });

    // ---- set the date and time by hand (administrator)
    function openEditor() {
      const d = new Date();
      let date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      let time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      const dt = kit.text({ row: 'time.datetime.manual.date', label: 'Date', help: 'Year-month-day, e.g. 2026-09-28', value: date, onChange: (s) => { date = s.trim(); return { ok: true }; } });
      const tm = kit.text({ row: 'time.datetime.manual.time', label: 'Time', help: '24-hour hours:minutes, seconds optional, e.g. 14:05 or 14:05:30', value: time, onChange: (s) => { time = s.trim(); return { ok: true }; } });
      const set = kit.button({ row: 'time.datetime.manual.set', label: 'Set this date and time', admin: 'set this PC\'s date and time', text: 'Set', tone: 'acc',
        onClick: () => {
          const a = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date), b = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
          if (!a) return { ok: false, reason: 'The date must look like 2026-09-28' };
          if (!b) return { ok: false, reason: 'The time must look like 14:05 or 14:05:30' };
          return after(C(kit, 'setClock', { year: +a[1], month: +a[2], day: +a[3], hour: +b[1], minute: +b[2], second: +(b[3] || 0) })).then((r) => {
            if (r && r.ok && !r.dryRun) editor.replaceChildren();
            return r;
          });
        } });
      const close = kit.button({ row: 'time.datetime.manual.cancel', label: 'Leave the clock as it is', text: 'Cancel', onClick: () => { editor.replaceChildren(); return { ok: true }; } });
      editor.replaceChildren(kit.card(dt, tm, set, close));
    }

    async function readZones() {
      const r = await C(kit, 'zones');
      if (!r.ok) return bad(r, 'The time zones could not be read');
      zones = Array.isArray(r.zones) ? r.zones : [];
      return null;
    }

    async function read() {
      const [r, zerr] = await Promise.all([C(kit, 'get'), zones ? null : readZones()]);
      if (kit.disposed) return;
      if (!r.ok) {
        const why = bad(r, 'Date and time could not be read');
        now.set({ value: '—', reason: why });
        for (const c of [autoTime, autoZone, dst, seconds]) c.set({ disabled: true, reason: why });
        zone.set({ disabled: true, reason: why });
        manual.set({ disabled: true, reason: why }); sync.set({ disabled: true, reason: why });
        return;
      }
      last = r;
      now.set({ value: (r.now.timeShort || r.now.time) + ', ' + r.now.date, reason: r.problems && r.problems.length ? r.problems.join('; ') : null });
      const A = r.autoTime, Z = r.zone, AZ = r.autoZone;
      const svc = A.service || {};
      autoTime.set({ value: !!A.on, disabled: !!A.reason, reason: A.reason,
        help: A.on ? (A.servers.length ? 'Windows syncs with ' + A.servers.join(', ') : 'No time server is set') + (svc.state ? ' · Windows Time service ' + svc.state + (svc.state === 'stopped' ? ' (it starts itself when needed)' : '') : '')
          : 'Windows keeps the time you set' });
      autoZone.set({ value: !!AZ.on, disabled: !!AZ.reason, reason: AZ.reason || (AZ.works ? null : AZ.blocked),
        help: AZ.on ? 'Windows picks the zone from your location' : 'You choose the time zone below' });
      const opts = zones ? zoneOpts(zones) : [];
      if (Z.key && !opts.some((o) => o.value === Z.key)) opts.unshift({ value: Z.key, label: Z.name || Z.key });
      zone.set({ options: opts, value: Z.key, disabled: !Z.writable || !opts.length,
        reason: zerr || (Z.writable ? null : 'Read only here: ' + (Z.reason || 'no reason came back')),
        help: Z.key ? 'Now UTC' + (Z.offsetMinutes >= 0 ? '+' : '−') + pad(Math.floor(Math.abs(Z.offsetMinutes) / 60)) + ':' + pad(Math.abs(Z.offsetMinutes) % 60) + (Z.daylightNow ? ' (' + Z.daylightName + ')' : '') : null });
      dst.set({ value: !!Z.dstAuto, disabled: !Z.supportsDst || !Z.writable,
        reason: !Z.supportsDst ? 'Read only here: ' + (Z.dstReason || 'this time zone has no daylight saving time') : !Z.writable ? 'Read only here: ' + (Z.reason || 'the time zone cannot be changed') : null });
      manual.set({ disabled: !!r.clock.reason, reason: r.clock.reason, help: r.clock.reason ? null : 'Needs an administrator, as in Windows' });
      if (r.clock.reason) editor.replaceChildren();
      sync.set({ disabled: !!r.sync.reason, reason: r.sync.reason,
        help: [A.lastGood ? 'Last known good time ' + stamp(A.lastGood) : A.lastGoodReason ? 'Last good time not known (' + A.lastGoodReason + ')' : null,
          r.sync.server ? 'Time server: ' + r.sync.server : null].filter(Boolean).join(' · ') || null });
      const T = r.tray || {};
      seconds.set({ value: !!(T.showSeconds && T.showSeconds.on), info: T.showSeconds && T.showSeconds.info });
      trayClock.set({ value: T.clockHidden && T.clockHidden.on ? 'Hidden by a policy' : 'Not hidden by a policy', reason: (T.clockHidden && T.clockHidden.reason) || TRAY_WHY });
      (r.extraClocks || []).forEach((x, i) => {
        const c = clocks[i];
        if (!c) return;
        c.st.on = !!x.on; c.st.zone = x.zone || null; c.st.name = x.name || '';
        c.t.set({ value: !!x.on, info: x.info || null });
        const zo = zoneOpts(zones || []);
        if (x.zone && !zo.some((o) => o.value === x.zone)) zo.unshift({ value: x.zone, label: x.zoneName || x.zone });
        c.z.set({ options: zo, value: x.zone || Z.key, disabled: !zo.length, reason: zerr, info: x.zone ? null : 'No zone chosen yet: turning the clock on uses your own zone' });
        c.n.set({ value: x.name || '' });
      });
    }

    read();
    kit.every(15000, read);
    el.append(kit.group('Google Calendar', { row: 'time.datetime.gcal.group' }), gcalGroup(kit));
    return { update: read, dispose() {} };
  }

  // ============================================================== Google Calendar (lane mantle-gcal, 2026-10-16)
  /* The clock's calendar shows Google Calendar events (lib/features/gcal.js, ui/bar/gcal.js). Read-only:
   * one scope, calendar.readonly. Everything here talks to the gcal feature's own commands and redraws
   * from its 'gcal.status' push; only the "Last synced" line ticks on its own. */
  const agoText = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  };
  function gcalGroup(kit) {
    const box = kit.h('div', {});
    const G = (name, args) => kit.call('gcal.' + name, args || {});
    let st = null, sig = null, synced = null;
    const syncedValue = (s) => (s.syncedAt ? agoText(s.syncedAt) : s.syncing ? 'Syncing now…' : 'Not yet');
    // main's reasons are written for the clock's flyout ("... in Settings"); here they are already in Settings
    const here = (r) => String(r || '').replace(/ in Settings$/, '');
    const syncedReason = (s) => {
      const r = s.error && !s.needsSignIn ? here(s.error.reason || 'the last sync did not finish') : '';
      return r ? r.charAt(0).toUpperCase() + r.slice(1) : null;
    };
    function draw() {
      const s = st;
      synced = null;
      if (!s || s.enabled === false) {
        box.replaceChildren(kit.card(kit.status({ row: 'time.datetime.gcal', label: 'Google Calendar', value: 'Off',
          reason: !s ? 'Mantle\'s Google Calendar part is not running, so nothing can be connected (it may be turned off in Mantle\'s tray menu)' : 'Turned off in Mantle\'s tray menu: the clock\'s calendar shows no Google events' })));
        return;
      }
      const rows = [];
      rows.push(kit.status({ row: 'time.datetime.gcal', label: 'Google Calendar',
        value: s.signedIn && s.needsSignIn ? 'Sign-in ended' + (s.account ? ' (' + s.account + ')' : '')
          : s.signedIn ? (s.account ? 'Signed in as ' + s.account : 'Signed in') : 'Not connected', tone: s.signedIn && !s.needsSignIn ? 'ok' : 'info',
        help: 'Read-only: your events show in the clock\'s calendar; Mantle never changes them',
        reason: s.needsSignIn ? here((s.error && s.error.reason) || 'Google ended Mantle\'s sign-in; sign in again') : (!s.canEncrypt ? 'Windows encryption (DPAPI) is not available, so Mantle will not store a Google sign-in' : null) }));
      if (!s.signedIn || s.needsSignIn) {
        rows.push(kit.button({ row: 'time.datetime.gcal.signin', label: 'Sign in with Google', text: s.signingIn ? 'Waiting for your browser…' : 'Sign in with Google', tone: 'acc',
          help: s.client ? 'Opens Google\'s sign-in page in your default browser' : 'Choose your Google client file first (below)',
          disabled: !s.client || s.signingIn || !s.canEncrypt,
          onClick: () => G('signIn') }));
      }
      if (s.signedIn) {
        synced = kit.status({ row: 'time.datetime.gcal.synced', label: 'Last synced', value: syncedValue(s), tone: s.error ? 'warn' : 'ok', reason: syncedReason(s) });
        rows.push(synced);
      }
      const card = [kit.card(...rows)];
      if (s.signedIn && s.calendars && s.calendars.length) {
        card.push(kit.card(...s.calendars.map((c) => kit.toggle({ row: 'time.datetime.gcal.cal.' + keyOf(c.id), label: c.name,
          help: c.primary ? 'Your main calendar' : null, value: !!c.on,
          onChange: (on) => G('setCalendar', { calendar: c.id, on }) }))));
      } else if (s.signedIn && !s.needsSignIn && s.syncedAt) {
        card.push(kit.card(kit.status({ row: 'time.datetime.gcal.cal.none', label: 'Calendars', value: 'None', tone: 'info',
          reason: 'This Google account has no calendars Mantle can read, so the clock\'s calendar shows no events' })));
      }
      const tail = [];
      if (s.signedIn) {
        tail.push(kit.button({ row: 'time.datetime.gcal.signout', label: 'Sign out', text: 'Sign out',
          help: 'Ends Mantle\'s access at Google and deletes the sign-in and the cached events from this PC',
          onClick: () => G('signOut') }));
      }
      tail.push(kit.button({ row: 'time.datetime.gcal.client', label: 'Google client file', text: 'Choose Google client file…',
        help: s.client ? 'A Desktop app client is saved on this PC, encrypted' : 'The JSON you downloaded for your "Desktop app" client in Google Cloud',
        reason: s.clientReason || null,
        onClick: () => G('pickClient') }));
      card.push(kit.card(...tail));
      box.replaceChildren(...card);
    }
    /* Redrawn only when something but the clock changed: a push every sync must not rebuild the rows. */
    const apply = (s) => {
      st = s || null;
      const k = JSON.stringify(st ? Object.assign({}, st, { syncedAt: !!st.syncedAt, nextAt: 0, ver: 0, error: st.error && st.error.reason, syncing: !st.syncedAt && st.syncing }) : null);
      if (k !== sig) { sig = k; draw(); }
      else if (synced && st) synced.set({ value: syncedValue(st), reason: syncedReason(st), tone: st.error ? 'warn' : 'ok' });
    };
    // not running: the "Off" row (drawn below) already says why, so a refused ask changes nothing
    G('status').then((r) => { if (!kit.disposed) apply(r && r.ok === false ? null : r); }, () => {});
    kit.watch('gcal.status', apply);
    kit.every(30000, () => { if (synced && st) synced.set({ value: syncedValue(st) }); });
    draw();
    return box;
  }

  // ============================================================== Language & region
  const FORMAT_ROWS = [
    ['firstDayOfWeek', 'time.region.firstDay', 'First day of week'],
    ['shortDate', 'time.region.shortDate', 'Short date'],
    ['longDate', 'time.region.longDate', 'Long date'],
    ['shortTime', 'time.region.shortTime', 'Short time'],
    ['longTime', 'time.region.longTime', 'Long time'],
    ['measure', 'time.region.measure', 'Measurement system'],
  ];
  const PREVIEW_ROWS = [['shortDate', 'Short date'], ['longDate', 'Long date'], ['shortTime', 'Short time'], ['longTime', 'Long time'],
    ['number', 'Number'], ['currency', 'Currency'], ['firstDay', 'First day of week'], ['measure', 'Measurement system'], ['calendar', 'Calendar']];

  function regionPage(el, kit) {
    let lists = null, cur = null;
    const display = kit.status({ row: 'time.region.display', label: 'Windows display language', value: 'Reading…' });
    const langs = kit.list({ row: 'time.region.languages', items: [], empty: 'Reading your preferred languages…' });
    const add = kit.button({ row: 'time.region.addLanguage', label: 'Add a language', text: 'Add a language', disabled: true });
    const country = kit.choice({ row: 'time.region.country', label: 'Country or region', help: 'Windows and apps might use it to give you local content', style: 'dropdown', options: [], value: null,
      onChange: (geo) => after(C(kit, 'setGeo', { geo })) });
    const format = kit.choice({ row: 'time.region.format', label: 'Regional format', help: 'Windows and some apps format dates and times with it', style: 'dropdown', options: [], value: null,
      onChange: async (locale) => {
        const r = await after(C(kit, 'setLocale', { locale }));
        if (r && r.ok && r.dryRun && r.preview) showPreview(r.preview, nameOf(locale) + ' (a test run: shown, not applied)');
        return r;
      } });
    const previewAs = kit.choice({ row: 'time.region.previewAs', label: 'Preview a regional format', help: 'See how another format writes dates, times, numbers and money; nothing changes', style: 'dropdown', options: [], value: null,
      onChange: async (locale) => {
        const r = await C(kit, 'preview', { locale });
        if (!r.ok) return r;
        showPreview(r.preview, r.display || nameOf(locale));
        return { ok: true };
      } });
    const showing = kit.status({ row: 'time.region.preview', label: 'Showing', value: 'Your regional format now', tone: 'info' });
    const pv = new Map(PREVIEW_ROWS.map(([k, label]) => [k, kit.status({ row: 'time.region.preview.' + k, label, value: '…' })]));
    const rows = new Map(FORMAT_ROWS.map(([key, row, label]) => [key, kit.choice({ row, label, style: 'dropdown', options: [], value: null,
      onChange: (value) => after(C(kit, 'setFormat', { key, value })) })]));
    const reset = kit.button({ row: 'time.region.reset', label: 'Reset formats', help: 'Every format back to the regional format\'s own', text: 'Reset',
      onClick: () => (cur ? after(C(kit, 'setLocale', { locale: cur.locale.name })) : { ok: false, reason: 'The regional format has not been read yet' }) });
    const sysLoc = kit.status({ row: 'time.region.systemLocale', label: 'Language for non-Unicode programs', value: '…' });
    const langWhy = kit.h('div', {});
    el.append(kit.group('Language'), kit.card(display, langs, langWhy, add),
      kit.group('Region'), kit.card(country, format),
      kit.group('Preview', { row: 'time.region.previewGroup' }), kit.card(previewAs, showing, ...pv.values()),
      kit.group('Regional format'), kit.card(...rows.values(), reset),
      kit.group('Administrative language settings'), kit.card(sysLoc));

    const after = (p) => Promise.resolve(p).then((r) => { if (r && r.ok && !r.dryRun) setTimeout(read, 400); return r; });
    const nameOf = (loc) => { const x = lists && lists.locales.find((l) => l.locale === loc); return x ? x.name : loc; };
    function showPreview(p, label) {
      showing.set({ value: label });
      for (const [k] of PREVIEW_ROWS) pv.get(k).set({ value: p && p[k] ? p[k] : '—' });
    }

    async function readLists() {
      const r = await C(kit, 'lists');
      if (!r.ok) return bad(r, 'The lists of formats and regions could not be read');
      lists = { locales: r.locales || [], geos: r.geos || [], reason: r.reason || null };
      return r.reason || null;
    }

    async function readLang() {
      const r = await C(kit, 'lang');
      if (kit.disposed) return;
      if (!r.ok) {
        const why = bad(r, 'The languages could not be read');
        display.set({ value: '—', reason: why });
        langs.set({ items: [], empty: why });
        return;
      }
      const d = r.display || {};
      display.set({ value: d.name || d.now || '—', reason: 'Read only here: ' + d.reason,
        info: d.pending && d.pending !== d.now ? 'Changes to ' + d.pending + ' at your next sign-in' : null });
      langs.set({ empty: r.languagesReason || 'No preferred languages', items: (r.languages || []).map((l, i) => ({
        key: keyOf(l.tag), label: l.name, value: i === 0 ? 'First choice' : null, mono: false,
        help: l.keyboards && l.keyboards.length ? 'Keyboards: ' + l.keyboards.map((k) => k.name).join(', ') : 'No keyboards listed',
        actions: [] })) });
      langWhy.replaceChildren(kit.reason('Read only here: ' + r.orderReason, { info: true }));
      add.set({ reason: 'Read only here: ' + r.addReason });
    }

    async function read() {
      const [r, lerr] = await Promise.all([C(kit, 'region'), lists ? null : readLists()]);
      if (kit.disposed) return;
      if (!r.ok) {
        const why = bad(r, 'The regional format could not be read');
        for (const c of [country, format, previewAs, ...rows.values()]) c.set({ disabled: true, reason: why });
        reset.set({ disabled: true, reason: why });
        showing.set({ value: '—', reason: why });
        return;
      }
      cur = r;
      const locOpts = lists ? lists.locales.map((l) => ({ value: l.locale, label: l.name })) : [{ value: r.locale.name, label: r.locale.display || r.locale.name }];
      if (!locOpts.some((o) => o.value === r.locale.name)) locOpts.unshift({ value: r.locale.name, label: r.locale.display || r.locale.name });
      format.set({ options: locOpts, value: r.locale.name, disabled: !!r.locale.reason || !lists, reason: lerr || (r.locale.reason ? 'Read only here: ' + r.locale.reason : null) });
      previewAs.set({ options: locOpts, value: previewAs.value || r.locale.name, disabled: !lists, reason: lerr });
      const geoOpts = lists ? lists.geos.map((g) => ({ value: g.geo, label: g.name })) : [];
      if (r.geo.code && !geoOpts.some((o) => o.value === r.geo.code)) geoOpts.unshift({ value: r.geo.code, label: r.geo.name || r.geo.code });
      country.set({ options: geoOpts, value: r.geo.code, disabled: !geoOpts.length || !r.geo.code, reason: r.geo.reason || lerr });
      for (const [key] of FORMAT_ROWS) {
        const f = r.formats[key], c = rows.get(key);
        if (!f) { c.set({ disabled: true, reason: 'The sidecar did not answer this format' }); continue; }
        c.set({ options: fmtOpts(f.options), value: f.value, disabled: !!f.reason, reason: f.reason,
          info: f.override ? 'Custom: the regional format\'s own is ' + (fmtOpts(f.options).find((o) => o.value === f.default) || { label: f.default }).label : null });
      }
      const n = (r.overrides || []).length;
      reset.set({ disabled: !n || !!r.locale.reason, info: n ? n + ' custom format' + (n === 1 ? '' : 's') + ' (resetting also re-applies the regional format)' : 'No custom formats: every format is the regional format\'s own',
        reason: r.locale.reason ? 'Read only here: ' + r.locale.reason : null });
      if (!previewAs.value || previewAs.value === r.locale.name) showPreview(r.preview, 'Your regional format now');
      const s = r.systemLocale || {};
      sysLoc.set({ value: s.display || s.name || '—', reason: 'Read only here: ' + (s.reason || 'no reason came back') });
    }

    read();
    readLang();
    return { update() { read(); readLang(); }, dispose() {} };
  }

  // ============================================================== Typing
  function typingPage(el, kit) {
    const box = kit.h('div', {});
    const perApp = kit.toggle({ row: 'time.typing.perApp', label: 'Let me use a different input method for each app window',
      onChange: (on) => C(kit, 'setPerAppInput', { on }) });
    const defInput = kit.status({ row: 'time.typing.defaultInput', label: 'Override for default input method', value: '…' });
    const bar = kit.status({ row: 'time.typing.languageBar', label: 'Language bar', value: '…' });
    el.append(kit.group('Text suggestions and autocorrect'), box, kit.group('Advanced keyboard settings', { row: 'time.typing.advanced' }), kit.card(defInput, perApp, bar));
    let toggles = null;
    async function read() {
      const r = await C(kit, 'lang');
      if (kit.disposed) return;
      if (!r.ok) {
        const why = bad(r, 'The typing settings could not be read');
        box.replaceChildren(kit.card(kit.reason(why)));
        toggles = null;
        perApp.set({ disabled: true, reason: why });
        defInput.set({ value: '—', reason: why }); bar.set({ value: '—', reason: why });
        return;
      }
      if (!toggles) {
        toggles = new Map();
        box.replaceChildren(kit.card(...(r.typing || []).map((x) => {
          const c = kit.toggle({ row: 'time.typing.' + x.key, label: x.label, help: x.registry, mono: true,
            onChange: (value) => C(kit, 'setTyping', { key: x.key, value }) });
          toggles.set(x.key, c);
          return c;
        })));
      }
      for (const x of r.typing || []) { const c = toggles.get(x.key); if (c) c.set({ value: !!x.on, info: x.info || null }); }
      const k = r.keyboard || {};
      const pa = k.perAppInput || {};
      perApp.set({ value: !!pa.on, disabled: typeof pa.on !== 'boolean', reason: pa.reason || null });
      defInput.set({ value: (k.defaultInput && k.defaultInput.text) || '—', reason: 'Read only here: ' + ((k.defaultInput && k.defaultInput.reason) || 'no reason came back') });
      bar.set({ value: cap((k.languageBar && k.languageBar.text) || '—'), reason: 'Read only here: ' + ((k.languageBar && k.languageBar.reason) || 'no reason came back') });
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== Speech
  function speechPage(el, kit) {
    const lang = kit.status({ row: 'time.speech.language', label: 'Speech recognition languages', value: '…' });
    const voice = kit.status({ row: 'time.speech.defaultVoice', label: 'Default voice', value: '…' });
    const voices = kit.list({ row: 'time.speech.voices', items: [], empty: 'Reading the voices…' });
    const recs = kit.list({ row: 'time.speech.recognizers', items: [], empty: 'Reading the recognizers…' });
    const why = kit.h('div', {});
    el.append(kit.card(lang, voice), kit.group('Installed voices'), kit.card(voices), kit.group('Speech recognizers'), kit.card(recs, why));
    const item = (v) => ({ key: keyOf(v.source + v.token), label: v.name, value: v.isDefault ? 'Default' : null,
      help: [v.languageName || v.language, v.gender, v.source].filter(Boolean).join(' · '), actions: [] });
    async function read() {
      const r = await C(kit, 'lang');
      if (kit.disposed) return;
      if (!r.ok) {
        const w = bad(r, 'The speech settings could not be read');
        lang.set({ value: '—', reason: w }); voice.set({ value: '—', reason: w });
        voices.set({ items: [], empty: w }); recs.set({ items: [], empty: w });
        return;
      }
      const s = r.speech || { voices: [], recognizers: [] };
      const langsOf = [...new Set(s.recognizers.map((x) => x.languageName || x.language).filter(Boolean))];
      lang.set({ value: langsOf.join(', ') || 'None installed', reason: 'Read only here: ' + s.reason });
      const def = s.voices.find((v) => v.isDefault);
      voice.set({ value: def ? def.name : (s.defaultVoice || 'Not set'), reason: 'Read only here: Mantle lists the voices but does not change the default voice yet (Windows keeps it in HKCU\\Software\\Microsoft\\Speech_OneCore\\Voices, DefaultTokenId)' });
      voices.set({ items: s.voices.map(item), empty: 'No voices are installed' });
      recs.set({ items: s.recognizers.map(item), empty: 'No speech recognizers are installed' });
      why.replaceChildren(kit.reason('Read only here: ' + s.reason, { info: true }));
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== the section
  const row = (r, label, keywords, uri) => (uri ? { row: r, label, keywords, uri } : { row: r, label, keywords });
  MantleSettings.section({
    id: 'time',
    title: 'Time & language',
    group: 'windows',
    icon: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/>',
    order: 70,
    help: 'Date, time zone, region, typing, speech',
    keywords: 'clock date time zone timezone language region locale format typing keyboard speech voice',
    pages: [
      { id: 'datetime', title: 'Date & time', icon: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/>', help: 'Time zones, automatic clock settings, calendar display',
        search: [row('time.datetime.now', 'Current date and time', 'clock now today', 'ms-settings:dateandtime'),
          row('time.datetime.autoTime', 'Set time automatically', 'ntp internet time sync automatic clock w32time'),
          row('time.datetime.autoZone', 'Set time zone automatically', 'automatic time zone location tzautoupdate'),
          row('time.datetime.zone', 'Time zone', 'timezone utc gmt offset zone'),
          row('time.datetime.dst', 'Adjust for daylight saving time automatically', 'dst daylight saving summer time'),
          row('time.datetime.manual', 'Set the date and time manually', 'change date change time set clock'),
          row('time.datetime.sync', 'Sync now', 'synchronize clock time server time.windows.com resync'),
          row('time.datetime.traySeconds', 'Show seconds in the system tray clock', 'seconds taskbar clock'),
          row('time.datetime.trayClock', 'Show time and date in the system tray', 'taskbar clock hide clock'),
          row('time.datetime.calendar', 'Show additional calendars in the taskbar', 'lunar calendar chinese calendar'),
          row('time.datetime.clock1', 'Additional clock 1', 'additional clocks world clock second time zone'),
          row('time.datetime.clock2', 'Additional clock 2', 'additional clocks world clock another time zone'),
          row('time.datetime.gcal', 'Google Calendar', 'google calendar gcal events agenda sync connect account'),
          row('time.datetime.gcal.signin', 'Sign in with Google', 'google calendar sign in connect login account'),
          row('time.datetime.gcal.synced', 'Google Calendar last synced', 'google calendar sync status offline'),
          row('time.datetime.gcal.signout', 'Sign out of Google Calendar', 'google calendar sign out disconnect revoke'),
          row('time.datetime.gcal.client', 'Choose Google client file', 'google cloud oauth client json desktop app credentials')],
        render: dateTimePage },
      { id: 'region', title: 'Language & region', icon: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>', help: 'Display language, country or region, regional format',
        search: [row('time.region.display', 'Windows display language', 'display language ui language interface', 'ms-settings:regionlanguage'),
          row('time.region.languages', 'Preferred languages', 'languages keyboard layout language list'),
          row('time.region.addLanguage', 'Add a language', 'language pack install language'),
          row('time.region.country', 'Country or region', 'country region location home location geo'),
          row('time.region.format', 'Regional format', 'locale culture format region format', 'ms-settings:regionformatting'),
          row('time.region.previewAs', 'Preview a regional format', 'preview format example'),
          row('time.region.firstDay', 'First day of week', 'week start monday sunday'),
          row('time.region.shortDate', 'Short date', 'date format'),
          row('time.region.longDate', 'Long date', 'date format'),
          row('time.region.shortTime', 'Short time', 'time format 24 hour 12 hour clock'),
          row('time.region.longTime', 'Long time', 'time format seconds 24 hour'),
          row('time.region.measure', 'Measurement system', 'metric imperial us units'),
          row('time.region.reset', 'Reset formats', 'default formats custom formats'),
          row('time.region.systemLocale', 'Language for non-Unicode programs', 'system locale administrative language beta utf-8')],
        render: regionPage },
      { id: 'typing', title: 'Typing', icon: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 7h1M7 7h1M10 7h2M5 9.5h6"/>', help: 'Text suggestions, autocorrect, input methods',
        search: [row('time.typing.touchSuggestions', 'Show text suggestions when typing on the touch keyboard', 'text prediction suggestions touch keyboard', 'ms-settings:typing'),
          row('time.typing.hwSuggestions', 'Show text suggestions when typing on the physical keyboard', 'text prediction hardware keyboard'),
          row('time.typing.multilingual', 'Multilingual text suggestions', 'languages suggestions'),
          row('time.typing.autocorrect', 'Autocorrect misspelled words', 'autocorrect spelling'),
          row('time.typing.highlight', 'Highlight misspelled words', 'spellcheck spelling underline'),
          row('time.typing.hwAutocorrect', 'Autocorrect misspelled words I type on the physical keyboard', 'autocorrect hardware keyboard'),
          row('time.typing.spaceAfter', 'Add a space after I choose a text suggestion', 'space suggestion'),
          row('time.typing.doubleTapPeriod', 'Add a period after I double-tap the Spacebar', 'period full stop spacebar'),
          row('time.typing.insights', 'Typing insights', 'typing statistics insights'),
          row('time.typing.defaultInput', 'Override for default input method', 'input method keyboard layout default', 'ms-settings:keyboard'),
          row('time.typing.perApp', 'Let me use a different input method for each app window', 'input method per app'),
          row('time.typing.languageBar', 'Language bar', 'desktop language bar input indicator')],
        render: typingPage },
      { id: 'speech', title: 'Speech', icon: '<rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14.5"/>', help: 'Speech language, voices, recognizers',
        search: [row('time.speech.language', 'Speech language', 'speech recognition language', 'ms-settings:speech'),
          row('time.speech.defaultVoice', 'Default voice', 'narrator voice text to speech tts'),
          row('time.speech.voices', 'Installed voices', 'voices text to speech'),
          row('time.speech.recognizers', 'Speech recognizers', 'speech recognition dictation')],
        render: speechPage },
    ],
  });
}());
