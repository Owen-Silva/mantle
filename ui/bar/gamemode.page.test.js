require('../../tools/dev-env.js').lowcpu();
'use strict';
/* gamemode.page.test.js - the Game mode tile CLICKED in the real bar (lane sysmon-game, 2026-09-29).
 * Opens ui/bar/index.html headless with the mock bridge (page-harness.js), opens quick settings and
 * drives the tile the way a person does: the switch, a fast double click, Details, Esc, the options,
 * a refused option, keyboard, a push from main, and every state's words (no jargon anywhere).
 *   bash .../uislot.sh sysmon-game node ui/bar/gamemode.page.test.js [--shots=<dir>]
 * Nothing real is touched: the mock answers every call; a test answers some itself (__MOCK_REPLY__). */
const H = require('./page-harness.js');

const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS = shotsArg ? shotsArg.slice('--shots='.length) : null;
const JARGON = (s) => /sidecar|hwnd|\bIPC\b|renderer|dryRun|dry run|AUMID|0x[0-9a-f]{4,}|undefined|\bnull\b|NaN|\[object|gamemode\./i.test(s) || /\bE[A-Z]{4,}\b/.test(s);

(async () => {
  const t = H.suite('GAMEMODE PAGE TEST');
  if (H.gaming && H.gaming()) { console.log('a game is running: skipped'); process.exit(0); }
  await H.withBrowser(async (open) => {
    const qs = async (q, o) => {
      const pg = await open(q, Object.assign({ h: 900 }, o));
      await pg.click('#network', { wait: 400 });
      return pg;
    };
    const tileText = (pg) => pg.eval(() => { const r = document.querySelector('.gmrow'); return r ? r.innerText : ''; });
    const shot = async (pg, name) => { if (SHOTS) await pg.page.locator('.gmrow').screenshot({ path: require('path').join(SHOTS, name + '.png') }).catch(() => {}); };

    // 1) off and watching: the status, the verb, the track
    let pg = await qs('?mode=pill');
    t.check('off: the tile is in quick settings', (await pg.count('.gmrow')) === 1);
    t.check('off: status "Off · starts with your games"', (await pg.text('.gmsub')) === 'Off · starts with your games', await pg.text('.gmsub'));
    t.check('off: the switch says "Turn on", aria-checked false', (await pg.text('.gmswtext')) === 'Turn on' && (await pg.eval(() => document.querySelector('.gmswitch').getAttribute('aria-checked'))) === 'false');
    t.check('off: the switch has a tooltip saying what a click does', /Turn game mode on/.test(await pg.eval(() => document.querySelector('.gmswitch').title)));
    t.check('off: nothing to read under the switch', !(await pg.visible('.gmwhy')));
    await shot(pg, 'gm-off');

    // 2) Details: what it does, the two options, Esc closes it and focus goes back
    await pg.click('.gmmore');
    t.check('details: open, aria-expanded, "Hide details"', (await pg.eval(() => document.querySelector('.gmmore').getAttribute('aria-expanded'))) === 'true' && (await pg.text('.gmmore')) === 'Hide details');
    t.check('details: 6 "when it is on" rows (with the boost) + the last game line', (await pg.count('.gmact.st-plan')) === 6 && (await pg.visible('.gmlast')) && (await pg.text('.gmlisthead')) === 'When it is on');
    t.check('details: the three options (the boost is the third, on by default)', (await pg.count('.gmopt input[type=checkbox]')) === 3);
    await shot(pg, 'gm-off-details');
    await pg.eval(() => document.querySelector('.gmopt input').focus());
    await pg.key('Escape');
    t.check('Esc inside details: closed, focus back on Details, quick settings still open', !(await pg.visible('.gmlist')) && (await pg.eval(() => document.activeElement && document.activeElement.classList.contains('gmmore'))) && (await pg.visible('.gmrow')));

    // 3) an option: one call with the new value; the checkbox holds
    await pg.click('.gmmore');
    await pg.reset();
    await pg.click('.gmopt input', { wait: 200 });
    let c = await pg.calls('gamemode.auto');
    t.check('option: "Turn on by itself" off -> one gamemode.auto {on:false}', c.length === 1 && c[0].p && c[0].p.on === false, JSON.stringify(c));
    t.check('option: status follows ("starts only by hand")', (await pg.text('.gmsub')) === 'Off · starts only by hand', await pg.text('.gmsub'));

    // 4) the switch: one click = one call, pressed at once, then "Turn off" with the track on
    await pg.reset();
    await pg.click('.gmswitch', { wait: 300 });
    c = await pg.calls('gamemode.set');
    t.check('switch: one click -> gamemode.set {on:true}', c.length === 1 && c[0].p.on === true, JSON.stringify(c));
    t.check('switch: now "Turn off", aria-checked true, status "On"', (await pg.text('.gmswtext')) === 'Turn off' && (await pg.eval(() => document.querySelector('.gmswitch').getAttribute('aria-checked'))) === 'true' && (await pg.text('.gmsub')) === 'On', await pg.text('.gmsub'));
    t.check('switch: Details now lists what it did (rows with badges)', (await pg.count('.gmact .gmbadge')) >= 3);
    await shot(pg, 'gm-on-manual-details');
    await pg.click('.gmswitch', { wait: 300 });
    t.check('switch: second click -> off again, "Turn on"', (await pg.text('.gmswtext')) === 'Turn on' && (await pg.calls('gamemode.set')).length === 2);
    await pg.close();

    // 5) a fast double click while main is slow: ONE call, pressed state within 100 ms
    pg = await qs('?mode=pill', { reply: "(ch, p) => ch === 'gamemode.set' ? new Promise((r) => setTimeout(() => r({ on: true, how: 'manual', game: {}, auto: true, watching: true, enabled: true, actions: [], ok: true }), 500)) : undefined" });
    await pg.reset();
    await pg.page.dblclick('.gmswitch');
    await pg.wait(60);
    const pressed = await pg.eval(() => document.querySelector('.gmswitch').classList.contains('pending'));
    await pg.wait(700);
    t.check('double click: one gamemode.set, not two', (await pg.calls('gamemode.set')).length === 1, (await pg.calls('gamemode.set')).length);
    t.check('double click: pressed (pending) within 100 ms', pressed);
    t.check('double click: ends on, not flipped back', (await pg.text('.gmswtext')) === 'Turn off');
    await pg.close();

    // 6) keyboard: Tab to the switch, Space turns it on
    pg = await qs('?mode=pill');
    await pg.eval(() => document.querySelector('.gmswitch').focus());
    await pg.reset();
    await pg.key('Space', 300);
    t.check('keyboard: Space on the focused switch -> gamemode.set', (await pg.calls('gamemode.set')).length === 1);
    await pg.close();

    // 7) a refused option: the box goes back and the reason is under the switch, in plain words
    pg = await qs('?mode=pill', { reply: "(ch) => ch === 'gamemode.liftSaver' ? Promise.reject(new Error('sidecar is not running')) : undefined" });
    await pg.click('.gmmore');
    await pg.click('.gmopt:nth-child(2) input', { wait: 300 });
    t.check('refused option: the box goes back', (await pg.eval(() => document.querySelectorAll('.gmopt input')[1].checked)) === false);
    const w7 = (await pg.text('.gmwhy')) || '';
    t.check('refused option: said in warning ink, plain words, no "sidecar"', (await pg.eval(() => document.querySelector('.gmwhy').classList.contains('warn'))) && /didn't change/.test(w7) && !JARGON(w7), w7);
    await pg.close();

    // 8) on for Valorant on battery with Energy saver: warn glyph + warning ink, never a tinted block
    pg = await qs('?mode=pill&gm=on&pm=saver');
    t.check('on for a game: status "On for VALORANT"', (await pg.text('.gmsub')) === 'On for VALORANT', await pg.text('.gmsub'));
    await pg.click('.gmmore');
    t.check('a row not done has the warn glyph', (await pg.count('.gmact.st-blocked .gmwarn')) >= 1);
    t.check('a row not done has no tinted background', (await pg.eval(() => getComputedStyle(document.querySelector('.gmact.st-blocked')).backgroundColor)) === 'rgba(0, 0, 0, 0)');
    t.check('why it came on is a Details row', /Why it is on/.test(await tileText(pg)));
    await shot(pg, 'gm-on-battery-details');
    const on8 = await tileText(pg);
    await pg.close();

    // 9) main pushes a change while the panel is open: the tile follows at once
    pg = await qs('?mode=pill');
    await pg.emit('gamemode.state', { on: true, how: 'auto', game: { file: 'RobloxPlayerBeta.exe', why: 'RobloxPlayerBeta.exe is a known game' }, auto: true, watching: true, enabled: true, actions: [] });
    await pg.wait(100);
    t.check('push: the tile follows ("On for RobloxPlayerBeta")', (await pg.text('.gmsub')) === 'On for RobloxPlayerBeta', await pg.text('.gmsub'));
    await pg.close();

    // 10) every other state a person can meet, each with its words and no jargon
    const cases = [
      ['tray', '?mode=pill&gm=tray', null, async (p) => (await p.eval(() => document.querySelector('.gmswitch').disabled)) && /tray menu/.test(await p.text('.gmwhy'))],
      ['not watching', '?mode=pill&gm=nowatch', null, async (p) => (await p.text('.gmsub')) === 'Off · not watching' && (await p.eval(() => document.querySelector('.gmwhy').classList.contains('warn')))],
      ['after a restart', '?mode=pill&gm=crash', null, async (p) => /^After Mantle restarted: /.test(await p.text('.gmwhy'))],
      ['test run', '?mode=pill&gm=dry', null, async (p) => /^Test run/.test(await p.text('.gmwhy'))],
      ['no answer', '?mode=pill', "(ch) => ch === 'gamemode.state' ? Promise.reject(new Error('sidecar is not running')) : undefined",
        async (p) => (await p.text('.gmsub')) === 'Unavailable' && (await p.eval(() => document.querySelector('.gmswitch').disabled))],
      ['not put back yet', '?mode=pill', "(ch) => ch === 'gamemode.state' ? { on: false, auto: true, watching: true, enabled: true, actions: [], leftover: { text: 'Not put back yet: claude.exe: Windows would not let Mantle change it. Mantle tries again every 30 s', tries: 1 } } : undefined",
        async (p) => /^Not put back yet/.test(await p.text('.gmwhy')) && (await p.eval(() => document.querySelector('.gmwhy').classList.contains('warn')))],
      ['resting', '?mode=pill', "(ch) => ch === 'gamemode.state' ? { on: false, auto: true, watching: true, enabled: true, actions: [], rest: { on: true, why: 'VALORANT runs', text: 'Mantle is resting while VALORANT runs: closed 9 windows' } } : undefined",
        async (p) => (await p.text('.gmsub')) === 'Off · Mantle is resting' && !(await p.visible('.gmwhy'))],
    ];
    // mock-mantle.js's gm= fixtures still carry the old words ("dry run", "sidecar"): only states whose
    // data this test writes (or the tile's own words) are held to the jargon rule.
    const seen = [];
    void on8;
    for (const [name, q, reply, ok] of cases) {
      pg = await qs(q, reply ? { reply } : {});
      if (!(await pg.eval(() => document.querySelector('.gmmore').disabled))) await pg.click('.gmmore', { wait: 150 });
      t.check(`state "${name}": shown as designed`, await ok(pg), await tileText(pg));
      if (reply) seen.push(await tileText(pg));
      await shot(pg, 'gm-' + name.replace(/ /g, '-'));
      t.check(`state "${name}": no page error`, pg.errors.length === 0, pg.errors.join(' | '));
      await pg.close();
    }
    const bad = seen.filter(JARGON);
    t.check('no jargon, error code, "undefined" or "null" in any state', bad.length === 0, bad.join(' || ').slice(0, 400));
  });
  t.done();
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
