// test-devinput.js - DevInput.cs (mouse, keyboard, touchpad, pen) and DevMisc.cs (cameras, AutoPlay,
// USB) against a PASSIVE sidecar (lane devnet, 2026-09-28).
//
//   node sidecar/test-devinput.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes the user's settings: every write is proven by its dryRun (which a passive sidecar
// answers, because it changes nothing) and by the passive refusal of the real write. Prints counts
// and shapes only, never a camera's or handler's name.
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('DEVINPUT');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 8000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);

  try {
    // --- registration
    const ping = await send('ping');
    const feats = ping.ok && ping.result && ping.result.features;
    const cmds = (feats && feats.commands) || [];
    for (const c of ['devinput.get', 'devinput.set', 'devcam.list', 'devcam.plan', 'autoplay.get', 'autoplay.enable', 'autoplay.choose', 'usb.get', 'usb.set']) {
      t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    }
    const probs = ((feats && feats.problems) || []).filter((p) => /DevInput|DevMisc/.test(p));
    t.check('no DevInput/DevMisc registration problems', probs.length === 0, probs.join('; '));
    const el = await send('elevate.list');
    const acts = (el.ok && el.result && el.result.actions) || [];
    const cam = acts.find((a) => a.action === 'camera.setEnabled');
    t.check('camera.setEnabled is an elevated action with its words', !!cam && /camera/.test(cam.does), JSON.stringify(el).slice(0, 200));
    const eprobs = ((el.result && el.result.problems) || []).filter((p) => /camera|DevMisc/i.test(p));
    t.check('no elevate problems for camera.setEnabled', eprobs.length === 0, eprobs.join('; '));

    // --- devinput.get
    const g = await send('devinput.get');
    const v = g.ok && g.result && g.result.values;
    t.check('devinput.get answers values', !!v, JSON.stringify(g).slice(0, 200));
    if (v) {
      t.check('mouse.primary is left|right', ['left', 'right'].includes(v['mouse.primary']));
      t.check('mouse.speed 1-20', Number.isInteger(v['mouse.speed']) && v['mouse.speed'] >= 1 && v['mouse.speed'] <= 20, String(v['mouse.speed']));
      t.check('mouse.enhancePrecision bool', typeof v['mouse.enhancePrecision'] === 'boolean');
      t.check('mouse.scrollLines number|page', Number.isInteger(v['mouse.scrollLines']) || v['mouse.scrollLines'] === 'page');
      t.check('mouse.scrollInactive bool', typeof v['mouse.scrollInactive'] === 'boolean');
      t.check('keyboard.repeatDelay 0-3', v['keyboard.repeatDelay'] >= 0 && v['keyboard.repeatDelay'] <= 3);
      t.check('keyboard.repeatRate 0-31', v['keyboard.repeatRate'] >= 0 && v['keyboard.repeatRate'] <= 31);
      t.check('keyboard.caretBlinkMs number|off', Number.isInteger(v['keyboard.caretBlinkMs']) || v['keyboard.caretBlinkMs'] === 'off');
      t.check('no read problems', (g.result.problems || []).length === 0, (g.result.problems || []).join('; '));
      const tp = g.result.touchpad;
      t.check('touchpad: present, or a reason', tp && (tp.present === true ? !!tp.values : typeof tp.reason === 'string' && tp.reason.length > 5), JSON.stringify(tp).slice(0, 200));
      const pen = g.result.pen;
      t.check('pen: present, or a reason', pen && (pen.present === true || (typeof pen.reason === 'string' && pen.reason.length > 5)));
      console.log(`  (touchpad present: ${tp && tp.present}, pen present: ${pen && pen.present})`);

      // --- devinput.set: dryRun on the CURRENT value of each key (a no-op even if it were real)
      for (const key of ['mouse.primary', 'mouse.speed', 'mouse.enhancePrecision', 'mouse.scrollLines', 'mouse.scrollInactive',
        'mouse.doubleClickMs', 'mouse.vanish', 'keyboard.repeatDelay', 'keyboard.repeatRate', 'keyboard.caretBlinkMs']) {
        let value = v[key];
        if (key === 'mouse.doubleClickMs') value = Math.min(900, Math.max(200, value));
        if (key === 'keyboard.caretBlinkMs' && value !== 'off') value = Math.min(1200, Math.max(200, value));
        const d = await send('devinput.set', { key, value, dryRun: true });
        t.check(`${key} dryRun says what it would do`, d.ok && d.result.dryRun === true && /^set /.test(d.result.would), JSON.stringify(d).slice(0, 200));
      }
      const d2 = await send('devinput.set', { key: 'mouse.speed', value: v['mouse.speed'] === 20 ? 19 : v['mouse.speed'] + 1, dryRun: true });
      t.check('a different speed dryRun names from and to', d2.ok && d2.result.from === v['mouse.speed'] && d2.result.to !== v['mouse.speed']);
      const g2 = await send('devinput.get');
      t.check('dryRun changed nothing', g2.ok && g2.result.values['mouse.speed'] === v['mouse.speed']);
      const real = await send('devinput.set', { key: 'mouse.speed', value: v['mouse.speed'] });
      t.check('a real devinput.set is refused in passive', refused(real), JSON.stringify(real).slice(0, 200));
      if (!(tp && tp.present)) {
        const td = await send('devinput.set', { key: 'touchpad.tap', value: true, dryRun: true });
        t.check('touchpad write without a touchpad says why', td.ok === false && /touchpad/.test(td.error), JSON.stringify(td).slice(0, 200));
      }
    }
    // bad args
    const bads = [
      [{ value: 3 }, /needs key/], [{ key: 'mouse.speed' }, /needs value/], [{ key: 'mouse.speed', value: 21, dryRun: true }, /1 to 20/],
      [{ key: 'mouse.speed', value: 2.5, dryRun: true }, /whole number/], [{ key: 'mouse.primary', value: 'middle', dryRun: true }, /left/],
      [{ key: 'mouse.trails', value: 1, dryRun: true }, /trail/], [{ key: 'nope', value: 1, dryRun: true }, /unknown key/],
      [{ key: 'mouse.vanish', value: 'yes', dryRun: true }, /true or false/],
    ];
    for (const [a, rx] of bads) {
      const r = await send('devinput.set', a);
      t.check(`devinput.set ${JSON.stringify(a)} refused in words`, r.ok === false && rx.test(r.error), JSON.stringify(r).slice(0, 160));
    }

    // --- cameras
    const c = await send('devcam.list', {}, 10000);
    t.check('devcam.list answers', c.ok && Array.isArray(c.result.cameras), JSON.stringify(c).slice(0, 200));
    if (c.ok) {
      t.check('no default camera, with the reason', c.result.defaultCamera === null && /no system-wide default/.test(c.result.defaultReason));
      t.check('each camera has enabled + where', c.result.cameras.every((x) => typeof x.enabled === 'boolean' && typeof x.where === 'string'));
      console.log(`  (cameras: ${c.result.cameras.length})`);
      const one = c.result.cameras.find((x) => x.device);
      if (one) {
        const p = await send('devcam.plan', { device: one.device, on: one.enabled });
        t.check('devcam.plan on a real camera: no change, elevated', p.ok && p.result.elevated === true && /change nothing/.test(p.result.would), JSON.stringify(p).slice(0, 200));
        const p2 = await send('devcam.plan', { device: one.device, on: !one.enabled });
        t.check('devcam.plan the other way says the admin prompt', p2.ok && /administrator prompt/.test(p2.result.would));
      }
    }
    const pb = await send('devcam.plan', { device: 'USB\\VID_0000&PID_0000\\NOPE0000', on: false });
    t.check('devcam.plan on a missing device says so', pb.ok === false && /no device/.test(pb.error), JSON.stringify(pb).slice(0, 160));
    const pbad = await send('devcam.plan', { device: 'C:\\Windows\\..\\x', on: false });
    t.check('devcam.plan refuses a non-instance string', pbad.ok === false && /not a device instance/.test(pbad.error));
    const pextra = await send('devcam.plan', { device: 'USB\\A\\B', on: false, extra: 1 });
    t.check('devcam.plan ignores unknown request keys (only device/on reach the validator)', pextra.ok === false && /no device/.test(pextra.error), JSON.stringify(pextra).slice(0, 160));

    // --- AutoPlay
    const a = await send('autoplay.get');
    t.check('autoplay.get answers', a.ok && typeof a.result.enabled === 'boolean' && Array.isArray(a.result.media), JSON.stringify(a).slice(0, 200));
    if (a.ok) {
      const rem = a.result.media.find((m) => m.media === 'StorageOnArrival');
      const card = a.result.media.find((m) => m.label === 'Memory card');
      t.check('removable drive + memory card are there', !!rem && !!card);
      t.check('every media offers take-no-action / open folder / ask', a.result.media.every((m) => ['MSTakeNoAction', 'MSOpenFolder', 'MSPromptEachTime'].every((h) => m.choices.some((c2) => c2.handler === h))));
      t.check('the three always-choices have readable labels', rem.choices.filter((c2) => c2.handler.startsWith('MS')).every((c2) => c2.label && !c2.label.startsWith('@')));
      console.log(`  (media: ${a.result.media.length}, removable-drive choices: ${rem.choices.length})`);
      const e = await send('autoplay.enable', { on: a.result.enabled, dryRun: true });
      t.check('autoplay.enable dryRun', e.ok && e.result.dryRun === true && /AutoPlay/.test(e.result.would));
      const e2 = await send('autoplay.enable', { on: a.result.enabled });
      t.check('autoplay.enable real is refused in passive', refused(e2));
      const ch = await send('autoplay.choose', { media: 'StorageOnArrival', handler: 'MSPromptEachTime', dryRun: true });
      t.check('autoplay.choose dryRun', ch.ok && ch.result.dryRun === true && /Removable drive/.test(ch.result.would), JSON.stringify(ch).slice(0, 200));
      const ch2 = await send('autoplay.choose', { media: 'StorageOnArrival', handler: 'MSPromptEachTime' });
      t.check('autoplay.choose real is refused in passive', refused(ch2));
      const a2 = await send('autoplay.get');
      t.check('dryRun changed nothing', a2.ok && JSON.stringify(a2.result.media.map((m) => m.chosen)) === JSON.stringify(a.result.media.map((m) => m.chosen)));
    }
    const cb1 = await send('autoplay.choose', { media: 'Floppy', handler: 'MSOpenFolder', dryRun: true });
    t.check('autoplay.choose unknown media', cb1.ok === false && /unknown media/.test(cb1.error));
    const cb2 = await send('autoplay.choose', { media: 'StorageOnArrival', handler: 'EvilHandler', dryRun: true });
    t.check('autoplay.choose a handler Windows does not offer', cb2.ok === false && /not one Windows offers/.test(cb2.error));
    const cb3 = await send('autoplay.enable', { on: 'yes' });
    t.check('autoplay.enable wrong type', cb3.ok === false && /true or false/.test(cb3.error));

    // --- USB
    const u = await send('usb.get');
    t.check('usb.get answers its three settings', u.ok && u.result.settings.length === 3 && u.result.settings.every((x) => typeof x.on === 'boolean'), JSON.stringify(u).slice(0, 200));
    if (u.ok) {
      const bs = u.result.settings.find((x) => x.key === 'batterySaver');
      t.check('battery saver is marked elevated', bs && bs.elevated === true && bs.action === 'usb.setBatterySaver');
      const bd = await send('usb.set', { key: 'batterySaver', value: !bs.on, dryRun: true });
      t.check('battery saver dryRun names the admin prompt', bd.ok && bd.result.elevated === true && /administrator prompt/.test(bd.result.would), JSON.stringify(bd).slice(0, 200));
      const br = await send('usb.set', { key: 'batterySaver', value: bs.on });
      t.check('battery saver real usb.set points at the elevated action', br.ok === false && /usb\.setBatterySaver/.test(br.error));
      t.check('usb.setBatterySaver is an elevated action', acts.some((x) => x.action === 'usb.setBatterySaver'));
      const cur = u.result.settings[0];
      const ud = await send('usb.set', { key: cur.key, value: cur.on, dryRun: true });
      t.check('usb.set dryRun', ud.ok && ud.result.dryRun === true && /turn/.test(ud.result.would));
      const ur = await send('usb.set', { key: cur.key, value: cur.on });
      t.check('usb.set real is refused in passive', refused(ur));
    }
    const ub = await send('usb.set', { key: 'x', value: true, dryRun: true });
    t.check('usb.set unknown key', ub.ok === false && /needs key/.test(ub.error));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
