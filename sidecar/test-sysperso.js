// test-sysperso.js - SysPerso.cs (colours, Windows' background, lock screen switches, device usage,
// the read-only rest), SysPersoFonts.cs (fonts) and SysPersoLock.cs (the lock screen picture) against a
// PASSIVE sidecar (lane perso, 2026-09-29).
//
//   node sidecar/test-sysperso.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes the user's theme, colours, background, lock screen or fonts: every write is proven by its
// dryRun (sent with the CURRENT value, so even a real one would be a no-op) and by the passive refusal
// of the real write, then a read shows nothing moved. Prints counts and shapes only, never a path,
// a picture's or a font's file name.
'use strict';
const fs = require('fs');
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSPERSO');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 20000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).replace(/[A-Z]:\\\\[^"]*/g, '<path>').slice(0, 240);
  const R = (r) => (r && r.ok && r.result) || null;
  const err = (r) => String((r && (r.error || (r.result && r.result.reason))) || '');

  try {
    // --- registration
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['perso.colors', 'perso.background', 'perso.more', 'perso.set', 'perso.fonts', 'perso.fontInstall', 'perso.fontRemove', 'perso.lock', 'perso.lockPicture']) {
      t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    }
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /Perso/.test(p));
    t.check('no SysPerso registration problems', probs.length === 0, probs.join('; '));

    // --- colours
    const col = R(await send('perso.colors'));
    t.check('perso.colors answers', !!col, short(col));
    const KEYS = ['appsLight', 'systemLight', 'transparency', 'accentOnStart', 'accentOnTitleBars', 'autoAccent'];
    if (col) {
      t.check('every colour switch is {on:bool, set:bool}', KEYS.every((k) => col.values[k] && typeof col.values[k].on === 'boolean' && typeof col.values[k].set === 'boolean'), short(col.values));
      t.check('an unset switch says why', KEYS.every((k) => col.values[k].set || col.values[k].why));
      t.check('the accent is #RRGGBB, or null with a reason', (typeof col.accent === 'string' && /^#[0-9A-F]{6}$/.test(col.accent)) || (col.accent === null && !!col.accentWhy), short(col.accent));
      t.check("Windows' 48 accent swatches", Array.isArray(col.swatches) && col.swatches.length === 48 && col.swatches.every((x) => /^#[0-9A-F]{6}$/.test(x)));
      t.check('highContrast is a bool, and a lock says why', typeof col.highContrast === 'boolean' && (!col.highContrast || /contrast theme/.test(col.locked)));
      for (const k of KEYS) {
        const d = R(await send('perso.set', { key: k, value: col.values[k].on, dryRun: true }));
        t.check(`set ${k} dryRun says what it would write`, d && d.dryRun === true && typeof d.would === 'string' && Array.isArray(d.writes) &&
          d.writes.some((w) => w.api === 'registry' && w.hive === 'HKCU') && d.writes.some((w) => w.api === 'WM_SETTINGCHANGE' && w.value === 'ImmersiveColorSet'), short(d));
      }
      if (col.accent) {
        const a = R(await send('perso.set', { key: 'accent', value: col.accent, dryRun: true }));
        t.check('accent dryRun: 7 values + the broadcast, a 32-byte palette', a && a.dryRun && a.writes.length === 8 &&
          a.writes.some((w) => w.name === 'AccentPalette' && /^[0-9A-F]{64}$/.test(w.value)) && a.writes.some((w) => w.name === 'ColorizationColor'), short(a));
        const ar = await send('perso.set', { key: 'accent', value: col.accent });
        t.check('a real accent write is refused in passive', refused(ar), short(ar));
      }
      const rr = await send('perso.set', { key: 'appsLight', value: col.values.appsLight.on });
      t.check('a real light/dark write is refused in passive', refused(rr), short(rr));
      const after = R(await send('perso.colors'));
      t.check('nothing changed', after && KEYS.every((k) => after.values[k].on === col.values[k].on) && after.accent === col.accent);
    }
    const bads = [
      [{ key: 'accent', value: 'red', dryRun: true }, /like "#0078D4"/],
      [{ key: 'accent', value: '#12345', dryRun: true }, /like "#0078D4"/],
      [{ key: 'appsLight', value: 'yes', dryRun: true }, /true or false/],
      [{ key: 'nope', value: true, dryRun: true }, /unknown key/],
      [{ key: 'fit', value: 'zoom', dryRun: true }, /fit must be one of/],
      [{ key: 'picture', value: 'relative.jpg', dryRun: true }, /full path/],
      [{ key: 'picture', value: 'C:\\Windows\\win.ini', dryRun: true }, /picture file/],
      [{ key: 'picture', value: 'C:\\no\\such\\picture.jpg', dryRun: true }, /does not exist/],
      [{ key: 'slideshow', value: 'C:\\no\\such\\folder', dryRun: true }, /folder that exists/],
      [{ key: 'interval', value: 5, dryRun: true }, /60000/],
      [{ key: 'solid', value: 'black', dryRun: true }, /like "#1F1F1F"/],
      [{ value: true, dryRun: true }, /needs key/],
    ];
    for (const [a, re] of bads) {
      const r = await send('perso.set', a);
      t.check(`perso.set refuses ${JSON.stringify(a).slice(0, 60)}`, (r.ok === false || (r.result && r.result.ok === false)) && re.test(err(r)), short(r));
    }

    // --- Windows' background
    const bg = R(await send('perso.background', {}, 30000));
    t.check('perso.background answers', !!bg, short(bg));
    if (bg) {
      t.check('kind is picture|solid|slideshow|spotlight', ['picture', 'solid', 'slideshow', 'spotlight'].includes(bg.kind), bg.kind);
      t.check('fit is one of the six (or null)', bg.fit === null || bg.fits.includes(bg.fit), short([bg.fit, bg.fits]));
      t.check('recent pictures are {path, exists}', Array.isArray(bg.recent) && bg.recent.every((x) => typeof x.path === 'string' && typeof x.exists === 'boolean'));
      t.check('the desktop wallpaper service answered (monitors counted)', Number.isInteger(bg.monitors) && bg.monitors >= 1 && bg.serviceWhy === null, short([bg.monitors, bg.serviceWhy]));
      t.check('slideshow shape', bg.slideshow && typeof bg.slideshow.on === 'boolean' && typeof bg.slideshow.shuffle === 'boolean');
      t.check('Lively is only looked at (a bool)', typeof bg.livelyRunning === 'boolean');
      t.check('the colour is #RRGGBB or null', bg.color === null || /^#[0-9A-F]{6}$/.test(bg.color));
      console.log(`  (kind ${bg.kind}, fit ${bg.fit}, ${bg.recent.length} recent, ${bg.monitors} monitor(s), Lively running: ${bg.livelyRunning}, locked: ${!!bg.locked})`);
      if (!bg.locked) {
        if (bg.fit) {
          const d = R(await send('perso.set', { key: 'fit', value: bg.fit, dryRun: true }));
          t.check('fit dryRun names IDesktopWallpaper', d && d.dryRun && d.writes[0].api === 'IDesktopWallpaper', short(d));
          const r = await send('perso.set', { key: 'fit', value: bg.fit });
          t.check('a real fit write is refused in passive', refused(r), short(r));
        }
        const pic = bg.pictureExists ? bg.picture : (bg.recent.find((x) => x.exists) || {}).path;
        if (pic && /\.(jpe?g|jfif|png|bmp|gif|tiff?|heic|webp|avif|jxr|wdp|dib)$/i.test(pic)) {
          const d = R(await send('perso.set', { key: 'picture', value: pic, dryRun: true }));
          t.check('picture dryRun: IDesktopWallpaper + BackgroundType 0', d && d.dryRun && d.writes.some((w) => w.name === 'BackgroundType' && w.value === 0), short(d));
          const r = await send('perso.set', { key: 'picture', value: pic });
          t.check('a real picture write is refused in passive', refused(r), short(r));
        } else console.log('  (no existing picture to dry-run a picture change with)');
        const sd = R(await send('perso.set', { key: 'solid', value: bg.color || '#000000', dryRun: true }));
        t.check('solid dryRun: BackgroundType 1', sd && sd.dryRun && sd.writes.some((w) => w.name === 'BackgroundType' && w.value === 1), short(sd));
        const sl = R(await send('perso.set', { key: 'slideshow', value: 'C:\\Windows\\Web\\Wallpaper', dryRun: true }));
        t.check('slideshow dryRun on a real folder: BackgroundType 2', sl && sl.dryRun && sl.writes.some((w) => w.name === 'BackgroundType' && w.value === 2), short(sl));
        const sh = R(await send('perso.set', { key: 'shuffle', value: bg.slideshow.shuffle, dryRun: true }));
        t.check('shuffle dryRun', sh && sh.dryRun && /shuffle/.test(sh.would), short(sh));
      }
      const after = R(await send('perso.background', {}, 30000));
      t.check('the background did not change', after && after.kind === bg.kind && after.fit === bg.fit && after.picture === bg.picture && after.color === bg.color);
    }

    // --- themes, lock screen, device usage, the read-only rest
    const more = R(await send('perso.more'));
    t.check('perso.more answers', !!more, short(more));
    if (more) {
      const th = more.themes;
      t.check('themes: a list with names, files and a scope', th && Array.isArray(th.list) && th.list.length > 0 && th.list.every((x) => x.name && x.file && (x.scope === 'user' || x.scope === 'windows')), short(th && th.list.length));
      t.check('themes: at most one is current', th && th.list.filter((x) => x.current).length <= 1);
      t.check('themes: applying says why it is read-only', th && /theme service/.test(th.applyWhy));
      t.check('theme names are resolved (no @dll,-id left)', th && th.list.every((x) => !/^@/.test(x.name)));
      t.check('lock: spotlight and facts are switches', more.lock && typeof more.lock.spotlight.on === 'boolean' && typeof more.lock.facts.on === 'boolean');
      t.check('lock: sign-in background and status say why they are read-only', more.lock && /protected|policy/.test(more.lock.signin.why) && /protected/.test(more.lock.statusWhy));
      t.check('device usage: the seven uses', more.usage && Object.keys(more.usage).length === 7 && Object.values(more.usage).every((u) => typeof u.on === 'boolean'));
      t.check('dynamic lighting: read-only with a reason', more.lighting && /LampArray/.test(more.lighting.why) && typeof more.lighting.present === 'boolean');
      t.check('touch keyboard: read-only with a reason', more.touchKeyboard && /TabletTip/.test(more.touchKeyboard.why));
      console.log(`  (${th.list.length} themes, ${th.list.filter((x) => x.current).length} current, ${Object.values(more.usage).filter((u) => u.on).length} uses on, lighting stored: ${more.lighting.present})`);
      const ug = await send('perso.set', { key: 'usage.gaming', value: more.usage.gaming.on, dryRun: true });
      t.check('device usage is read-only with the reason', ug.ok === false && /^Read only: Windows keeps device usage/.test(err(ug)) && /does not document/.test(more.usageWhy), short(ug));
      for (const k of ['spotlight', 'lockFacts']) {
        const cur = k === 'spotlight' ? more.lock.spotlight.on : more.lock.facts.on;
        const d = R(await send('perso.set', { key: k, value: cur, dryRun: true }));
        t.check(`set ${k} dryRun (no broadcast)`, d && d.dryRun && d.writes.every((w) => w.api === 'registry' && w.hive === 'HKCU'), short(d));
        const r = await send('perso.set', { key: k, value: cur });
        t.check(`a real ${k} write is refused in passive`, refused(r), short(r));
      }
    }

    // --- the lock screen picture
    const lk = R(await send('perso.lock'));
    t.check('perso.lock: a picture or the reason there is none', lk && (typeof lk.picture === 'string' || !!lk.pictureWhy) && typeof lk.canSet === 'boolean', short(lk));
    const screen = ['C:\\Windows\\Web\\Screen\\img100.jpg', 'C:\\Windows\\Web\\Screen\\img103.png'].find((f) => fs.existsSync(f));
    if (lk && lk.canSet && screen) {
      const d = R(await send('perso.lockPicture', { path: screen, dryRun: true }));
      t.check('lockPicture dryRun names LockScreen.SetImageFileAsync', d && d.dryRun && d.writes[0].api === 'LockScreen.SetImageFileAsync', short(d));
      const r = await send('perso.lockPicture', { path: screen });
      t.check('a real lock screen picture is refused in passive', refused(r), short(r));
    }
    const lb = await send('perso.lockPicture', { path: 'C:\\Windows\\win.ini', dryRun: true });
    t.check('lockPicture refuses a non-picture', lb.ok === false && /\.jpg, \.png or \.bmp/.test(err(lb)), short(lb));

    // --- fonts
    const fo = R(await send('perso.fonts', {}, 30000));
    t.check('perso.fonts answers', !!fo, short(fo));
    if (fo) {
      t.check('more than 20 families', fo.families.length > 20, fo.families.length);
      t.check('every family has faces, a scope and files', fo.families.every((f) => f.name && f.faces.length && ['system', 'user', 'both'].includes(f.scope) && f.faces.every((x) => x.face && x.file && x.scope)));
      t.check('Segoe UI is one family holding its weights', (() => { const f = fo.families.find((x) => x.name === 'Segoe UI'); return !!f && f.faces.length >= 4; })());
      t.check('faces count adds up', fo.faces === fo.families.reduce((n, f) => n + f.faces.length, 0) && Number.isInteger(fo.userFaces));
      t.check('the system reason is there', /administrator/.test(fo.systemWhy));
      console.log(`  (${fo.families.length} families, ${fo.faces} faces, ${fo.userFaces} yours)`);
      const sysFace = fo.families.flatMap((f) => f.faces).find((x) => x.scope === 'system');
      const sr = await send('perso.fontRemove', { face: sysFace.face, dryRun: true });
      t.check('removing a font for everyone is read-only with the reason', sr.ok === false && /^Read only: fonts for everyone/.test(err(sr)), short(sr));
      const userFace = fo.families.flatMap((f) => f.faces).find((x) => x.scope === 'user');
      if (userFace) {
        const d = R(await send('perso.fontRemove', { face: userFace.face, dryRun: true }));
        t.check('removing one of your fonts: dryRun', d && d.dryRun && /remove the font/.test(d.would), short(d));
        const r = await send('perso.fontRemove', { face: userFace.face });
        t.check('a real font removal is refused in passive', refused(r), short(r));
      }
      const nf = await send('perso.fontRemove', { face: 'No Such Font Made Up (TrueType)', dryRun: true });
      t.check('an unknown font is refused', nf.ok === false && /no font called/.test(err(nf)), short(nf));
      const src = 'C:\\Windows\\Fonts\\georgia.ttf';
      if (fs.existsSync(src)) {
        const d = R(await send('perso.fontInstall', { path: src, dryRun: true }, 30000));
        t.check('install dryRun reads the family from the file', d && d.dryRun && d.family === 'Georgia' && d.writes.some((w) => w.hive === 'HKCU'), short(d));
        const r = await send('perso.fontInstall', { path: src }, 30000);
        t.check('a real install is refused in passive', refused(r), short(r));
      }
      for (const [a, re] of [[{ path: 'C:\\Windows\\win.ini', dryRun: true }, /\.ttf, \.otf, \.ttc/], [{ path: 'C:\\no\\such.ttf', dryRun: true }, /does not exist/], [{ dryRun: true }, /needs path/]]) {
        const r = await send('perso.fontInstall', a);
        t.check(`fontInstall refuses ${JSON.stringify(a).slice(0, 50)}`, r.ok === false && re.test(err(r)), short(r));
      }
      const fo2 = R(await send('perso.fonts', {}, 30000));
      t.check('the font list did not change', fo2 && fo2.faces === fo.faces && fo2.userFaces === fo.userFaces);
    }
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
