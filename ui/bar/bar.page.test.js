require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* bar.page.test.js - the bar's own controls, CLICKED through the real ui/bar code (bar lane, 2026-09-29).
 *
 * WHAT: headless Chromium over file:// (never Electron, never a real window of Owen's), the real
 * index.html + bar.js on the mock bridge (mock-mantle.js), driven by ui/bar/page-harness.js. Every
 * case clicks, presses or pushes, then asserts on what the bar ASKED MAIN TO DO (the recorded calls)
 * and on what the user sees - the dock (left / middle / right click, hover previews, the card's go-to
 * and close), the launcher button, the calendar (months, Today, reopening on today), the More menu
 * (Quit's second click, Restart), the tray (left / right click, a refused icon), Win+N / Win+A, Esc
 * and click-outside, the volume glyph's wheel / right / middle click, the apps that do not fit, and
 * no jargon on any surface a user reads.
 * WHY: until this file the bar had screenshots (shoot.js) and tests of its pure helpers; nothing
 * clicked a pin and checked the bar asked for that app.
 *
 *   node ui/bar/bar.page.test.js          (ONLY=cal,more to run some cases)
 * Run it through the lane's uislot.sh. Prints "BAR PAGE TEST: n passed, m failed".
 */
'use strict';
const H = require('./page-harness.js');
const t = H.suite('BAR PAGE TEST');

/* Words a user must never read on the bar (BRIEF "The polish bar"). Checked on every surface below. */
const JARGON = /\b(sidecar|hwnd|IPC|renderer|dryRun|AUMID|bridge|main\.js|bar\.[a-z]+|undefined|null|NaN|ENOENT|0x[0-9a-f]{6,}|\[object Object\]|hook|exit code|legacy|exposes)\b/i;

async function run() {
  if (H.gaming()) { console.log('a game is running: the browser half is skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const PILL = '?mode=pill';
    const W = { w: 1280, h: 560 };
    const popKey = (pg) => pg.eval(() => { const p = document.getElementById('pop'); return p.hidden ? null : p.className; });

    /* ---------------------------------------------------------------- the dock */
    if (t.want('dock')) {
      const pg = await open(PILL, W);
      const n = await pg.count('#dock .cell');
      t.check('dock: the mock\'s apps are drawn', n >= 12, n);
      t.check('dock: running-only apps sit after a divider', await pg.count('#dock .div') === 1);
      t.check('dock: a running app has its running line', await pg.eval(() => document.querySelector('.cell[data-id="code"]').classList.contains('run')));
      t.check('dock: a not-running pin has none', await pg.eval(() => !document.querySelector('.cell[data-id="spotify"]').classList.contains('run')));

      // left click, not running: launch, no popover
      await pg.reset();
      await pg.click('.cell[data-id="spotify"]', { wait: 200 });
      let c = await pg.calls('bar.open');
      t.check('dock: click a pin that is not running asks to open it', c.length === 1 && c[0].p.id === 'spotify' && !c[0].p.fresh, c);
      t.check('dock: ...and opens no popover', await popKey(pg) === null);

      // left click, 1 window
      await pg.reset();
      await pg.click('.cell[data-id="code"]', { wait: 250 });
      c = await pg.calls('bar.open');
      t.check('dock: click a one-window app asks for that app', c.length === 1 && c[0].p.id === 'code', c);

      // left click, 3 windows: the previews
      await pg.reset();
      await pg.click('.cell[data-id="edge"]', { wait: 400 });
      t.check('dock: click a 3-window app opens its previews', /fly/.test(await popKey(pg) || ''), await popKey(pg));
      t.check('dock: one card per window', await pg.count('#pop .card') === 3, await pg.count('#pop .card'));
      t.check('dock: the close button has a name', await pg.eval(() => { const x = document.querySelector('#pop .card .x'); return !!x && /close/i.test(x.title + ' ' + (x.getAttribute('aria-label') || '')); }));
      // the same icon again closes it
      await pg.click('.cell[data-id="edge"]', { wait: 250 });
      t.check('dock: clicking the same icon again closes its previews', await popKey(pg) === null, await popKey(pg));

      // a card: go to that window
      await pg.click('.cell[data-id="edge"]', { wait: 400 });
      await pg.reset();
      await pg.click('#pop .card:nth-child(2) .card-shot', { wait: 250 });
      c = await pg.calls('bar.window');
      t.check('dock: clicking a card asks for that window', c.length === 1 && (c[0].p.action === 'focus' || c[0].p.action === 'toggle') && c[0].p.hwnd, c);
      t.check('dock: ...and closes the previews', await popKey(pg) === null);

      // a card's X: close that window, keep the flyout
      await pg.click('.cell[data-id="edge"]', { wait: 400 });
      await pg.reset();
      await pg.click('#pop .card:nth-child(1) .x', { wait: 250 });
      c = await pg.calls('bar.window');
      t.check('dock: a card\'s X asks that window to close', c.length === 1 && c[0].p.action === 'close', c);
      t.check('dock: ...and the previews stay up', /fly/.test(await popKey(pg) || ''));
      await pg.key('Escape');
      t.check('dock: Esc closes the previews', await popKey(pg) === null);

      // middle click = a new window
      await pg.reset();
      await pg.click('.cell[data-id="notion"]', { button: 'middle', wait: 250 });
      c = await pg.calls('bar.open');
      t.check('dock: middle-click asks for a new window', c.length === 1 && c[0].p.id === 'notion' && c[0].p.fresh === true, c);

      // right click = the jump list menu; again = closed
      await pg.reset();
      await pg.click('.cell[data-id="edge"]', { button: 'right', wait: 450 });
      t.check('dock: right-click opens the app menu', /jl|jump/.test(await popKey(pg) || '') || (await pg.count('#pop .jl-i')) > 0, await popKey(pg));
      t.check('dock: ...which reads the app\'s jump list', (await pg.calls('jumplist.get')).length === 1);
      await pg.click('.cell[data-id="edge"]', { button: 'right', wait: 250 });
      t.check('dock: a second right-click closes the menu', await popKey(pg) === null, await popKey(pg));

      // hover previews: open after the dwell, close after leaving. The pointer is still on edge
      // from the right-clicks above, so it leaves first: a hover needs the pointer to ARRIVE.
      await pg.page.mouse.move(640, 20);
      await pg.wait(300);
      await pg.page.hover('.cell[data-id="edge"]');
      await pg.wait(650);
      t.check('dock: resting on a running app shows its previews', /fly/.test(await popKey(pg) || ''), await popKey(pg));
      await pg.page.mouse.move(640, 20);
      await pg.wait(600);
      t.check('dock: moving away closes hover previews', await popKey(pg) === null, await popKey(pg));
      await pg.page.hover('.cell[data-id="spotify"]');
      await pg.wait(650);
      t.check('dock: a pin with no windows shows no previews', await popKey(pg) === null, await popKey(pg));

      // tooltips carry the shortcuts, in words
      const tip = await pg.eval(() => document.querySelector('.cell[data-id="notion"]').title);
      t.check('dock: a pin\'s tooltip names it and says middle-click opens a new window', /Notion/.test(tip) && /middle-click/i.test(tip), tip);
      const noIcon = await pg.eval(() => document.querySelector('.cell[data-id="files"]').title);
      t.check('dock: a missing icon\'s tooltip has no jargon', !JARGON.test(noIcon), noIcon);
      t.check('dock: no page errors', pg.errors.length === 0, pg.errors);
      await pg.close();
    }

    /* ---------------------------------------------------------------- launcher button */
    if (t.want('start')) {
      const pg = await open(PILL, W);
      await pg.reset();
      await pg.click('#start', { wait: 150 });
      t.check('start: the launcher button asks for the launcher', (await pg.calls('launcher.show')).length === 1);
      t.check('start: it has a name', /launcher/i.test(await pg.eval(() => document.getElementById('start').title)));
      await pg.close();
    }

    /* ---------------------------------------------------------------- the calendar */
    if (t.want('cal')) {
      const pg = await open(PILL, W);
      const month = (off) => pg.eval((o) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + o, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }, off);
      const title = () => pg.text('#pop .caltitle');
      await pg.click('#clock', { wait: 300 });
      t.check('cal: the clock opens the calendar', /cal/.test(await popKey(pg) || ''), await popKey(pg));
      t.check('cal: it opens on this month', await title() === await month(0), [await title(), await month(0)]);
      t.check('cal: six weeks of days', await pg.count('#pop .calday') === 42);
      t.check('cal: today is marked once', await pg.count('#pop .calday.today') === 1);
      await pg.click('#pop .calbtn[aria-label="Next month"]', { wait: 120 });
      t.check('cal: next month', await title() === await month(1), await title());
      await pg.click('#pop .calbtn[aria-label="Previous month"]', { wait: 120 });
      await pg.click('#pop .calbtn[aria-label="Previous month"]', { wait: 120 });
      t.check('cal: previous month (twice)', await title() === await month(-1), await title());
      t.check('cal: no "today" in another month', await pg.count('#pop .calday.today') === 0);
      const today = await pg.page.$('#pop .calbtn.today');
      await today.click(); await pg.wait(120);
      t.check('cal: Today comes back to this month', await title() === await month(0), await title());
      // the wheel moves months, the way Windows' calendar does
      await pg.page.hover('#pop .calgrid:not(.caldow)');
      await pg.page.mouse.wheel(0, 120); await pg.wait(150);
      t.check('cal: scrolling down shows the next month', await title() === await month(1), await title());
      await pg.page.mouse.wheel(0, -120); await pg.wait(150);
      t.check('cal: scrolling up comes back', await title() === await month(0), await title());
      // away and back: a closed calendar forgets the month it was showing
      await pg.click('#pop .calbtn[aria-label="Next month"]', { wait: 120 });
      await pg.key('Escape');
      t.check('cal: Esc closes it', await popKey(pg) === null);
      await pg.click('#clock', { wait: 300 });
      t.check('cal: reopening shows this month again, not the one left open', await title() === await month(0), await title());
      // a second click on the clock closes it
      await pg.click('#clock', { wait: 200 });
      t.check('cal: a second click on the clock closes it', await popKey(pg) === null, await popKey(pg));
      // the arrows are drawn, not typed characters
      await pg.click('#clock', { wait: 300 });
      t.check('cal: the month arrows are icons', await pg.eval(() => (() => { const bs = Array.from(document.querySelectorAll('#pop .calbtn:not(.today)')); return bs.length === 2 && bs.every((b) => !!b.querySelector('svg') && !b.textContent.trim()); })()));
      // the footer opens the notification centre
      await pg.reset();
      const link = await pg.page.$('#pop .calfoot button');
      if (link) { await link.click(); await pg.wait(350); }
      t.check('cal: the footer link opens the notifications', /ntf|notif/.test(await popKey(pg) || '') || (await pg.calls('notifs.get')).length > 0, await popKey(pg));
      // click outside closes any popover
      await pg.page.mouse.click(5, 5); await pg.wait(200);
      t.check('pop: a click outside the bar closes the popover', await popKey(pg) === null, await popKey(pg));
      t.check('cal: no page errors', pg.errors.length === 0, pg.errors);
      await pg.close();
    }

    /* ---------------------------------------------------------------- More menu */
    if (t.want('more')) {
      const pg = await open(PILL, W);
      await pg.click('#more', { wait: 300 });
      t.check('more: opens', await pg.count('#pop button') >= 3);
      const txt = await pg.text('#pop');
      t.check('more: no jargon in the menu', !JARGON.test(txt), txt);
      const quit = await pg.page.$('#pop button.danger');
      await pg.reset();
      await quit.click(); await pg.wait(150);
      t.check('more: Quit\'s first click only arms it', (await pg.calls('shell.quit')).length === 0 && /again/i.test(await quit.textContent()), await quit.textContent());
      await quit.click(); await pg.wait(150);
      t.check('more: Quit\'s second click quits', (await pg.calls('shell.quit')).length === 1);
      await pg.close();

      // Settings, and Quit's arm lapsing: a slip is forgiven after 4 s
      const pg3 = await open(PILL, W);
      await pg3.click('#more', { wait: 300 });
      await pg3.reset();
      await pg3.click('#pop .mitem:has(kbd)', { wait: 200 });
      let oc = await pg3.calls('open');
      t.check('more: Settings opens Settings (and names its shortcut)', oc.length === 1 && oc[0].p.target === 'ms-settings:', oc);
      t.check('more: ...and closes the menu', await popKey(pg3) === null, await popKey(pg3));
      await pg3.click('#more', { wait: 300 });
      const q3 = await pg3.page.$('#pop button.danger');
      await q3.click(); await pg3.wait(4300);
      t.check('more: an armed Quit lapses back after 4 s', /^Quit Mantle$/.test(await q3.textContent()), await q3.textContent());
      await pg3.reset();
      await q3.click(); await pg3.wait(150);
      t.check('more: ...so the next click only arms it again', (await pg3.calls('shell.quit')).length === 0);
      // Restore: a double-click sends one request
      const rs = await pg3.page.$('#pop .mitem:not(:has(kbd))');
      await pg3.reset();
      await rs.dblclick(); await pg3.wait(200);
      t.check('more: a double-click on Restore sends one request', (await pg3.calls('shell.restore')).length === 1, (await pg3.calls('shell.restore')).length);
      await pg3.close();

      const pg2 = await open(PILL + '&state=down', W);
      await pg2.click('#more', { wait: 300 });
      const txt2 = await pg2.text('#pop');
      t.check('more: a problem is said in plain words', !JARGON.test(txt2) && txt2.length > 0, txt2);
      const tip2 = await pg2.eval(() => document.getElementById('more').title);
      t.check('more: the button\'s tooltip has no jargon', !JARGON.test(tip2), tip2);
      await pg2.close();
    }

    /* ---------------------------------------------------------------- tray */
    if (t.want('tray')) {
      const pg = await open(PILL + '&tray=1', W);
      const n = await pg.count('#tray .ti');
      t.check('tray: shown icons are drawn', n >= 1, n);
      await pg.reset();
      await pg.click('#tray .ti:not(.off)', { wait: 150 });
      let c = await pg.calls('tray.click');
      t.check('tray: a click is a left click on that icon', c.length === 1 && c[0].p.button === 'left' && c[0].p.id, c);
      await pg.reset();
      await pg.click('#tray .ti:not(.off)', { button: 'right', wait: 150 });
      c = await pg.calls('tray.click');
      t.check('tray: a right-click is a right click on that icon', c.length === 1 && c[0].p.button === 'right', c);
      await pg.click('#more', { wait: 300 });
      const hid = await pg.count('#pop .hidtray .ti');
      t.check('tray: hidden icons are listed in More', hid >= 1, hid);
      if (hid) {
        await pg.reset();
        await pg.click('#pop .hidgo', { wait: 200 });
        const c2 = await pg.calls('open');
        t.check('tray: More offers the taskbar settings that unhide an icon', c2.length === 1 && /^ms-settings:taskbar$/.test(c2[0].p.target), c2);
      }
      // an icon that redraws itself 120 times must not leave 120 pictures in memory
      await pg.eval(async () => {
        for (let i = 0; i < 120; i++) {
          const c = document.createElement('canvas'); c.width = c.height = 16;
          const g = c.getContext('2d'); g.fillStyle = 'rgb(' + (i * 2) + ',80,160)'; g.fillRect(0, 0, 16, 16);
          g.fillStyle = '#fff'; g.fillRect(i % 16, 3, 2, 10);
          window.__mockMain.emit('tray', [{ id: 'spin', title: 'Syncing', icon: c.toDataURL('image/png'), exe: 'x.exe', promoted: true, clickable: true, reason: '' }]);
          await new Promise((r) => setTimeout(r, 8));
        }
      });
      await pg.wait(400);
      const kept = await pg.eval(() => window.__barDebug && window.__barDebug.tones());
      t.check('tray: a redrawing icon keeps a bounded number of pictures', typeof kept === 'number' && kept <= 64, kept);
      t.check('tray: no page errors', pg.errors.length === 0, pg.errors);
      await pg.close();
    }

    /* ---------------------------------------------------------------- pushes: Win+N, Win+A */
    if (t.want('keys')) {
      const pg = await open(PILL, W);
      await pg.emit('bar.winkey', { key: 'a' }); await pg.wait(350);
      t.check('keys: Win+A opens Quick Settings', await pg.count('#pop .qstile') > 0);
      await pg.emit('bar.winkey', { key: 'a' }); await pg.wait(250);
      t.check('keys: Win+A again closes it', await popKey(pg) === null, await popKey(pg));
      await pg.emit('bar.winkey', { key: 'n' }); await pg.wait(350);
      t.check('keys: Win+N opens the notifications', /ntf|notif/.test(await popKey(pg) || ''), await popKey(pg));
      await pg.emit('bar.winkey', { key: 'n' }); await pg.wait(250);
      t.check('keys: Win+N again closes them', await popKey(pg) === null, await popKey(pg));
      await pg.close();
    }

    /* ---------------------------------------------------------------- volume glyph */
    if (t.want('vol')) {
      const pg = await open(PILL, W);
      await pg.reset();
      await pg.page.hover('#volume');
      await pg.page.mouse.wheel(0, -100); await pg.wait(250);
      let c = await pg.calls('qs.set');
      t.check('vol: scrolling up over the speaker raises the volume', c.length >= 1 && c[c.length - 1].p.part === 'volume', c);
      await pg.reset();
      await pg.click('#volume', { button: 'right', wait: 150 });
      t.check('vol: right-click opens the volume mixer', (await pg.calls('osd.mixer')).length === 1);
      await pg.click('#volume', { wait: 350 });
      t.check('vol: a click opens Quick Settings', await pg.count('#pop .qstile') > 0);
      await pg.close();
    }

    /* ---------------------------------------------------------------- apps that do not fit */
    if (t.want('fit')) {
      const pg = await open(PILL + '&apps=40', { w: 1000, h: 560 });
      await pg.wait(900);
      // the ones that do not fit leave the strip whole (none is cut in half at the edge)
      const hiddenN = await pg.count('#dock .cell.ovf');
      t.check('fit: some apps do not fit at 1000 px', hiddenN > 0, hiddenN);
      const clipped = await pg.eval(() => { const d = document.getElementById('dock').getBoundingClientRect(); return Array.from(document.querySelectorAll('#dock .cell:not(.ovf), #dock-more')).filter((c) => { const r = c.getBoundingClientRect(); return r.width && (r.right > d.right + 1 || r.left < d.left - 1); }).length; });
      t.check('fit: no icon on the strip is cut off, "+N" included', clipped === 0, clipped);
      const more = await pg.page.$('#dock-more, .dock-more');
      t.check('fit: a button reaches the apps that do not fit', !!more);
      if (more) {
        const label = await more.evaluate((e) => e.textContent + ' ' + e.title);
        t.check('fit: it says how many', new RegExp('\\b' + hiddenN + '\\b').test(label), [label, hiddenN]);
        await more.click(); await pg.wait(350);
        const rows = await pg.count('#pop .ovf-app');
        t.check('fit: its panel lists exactly the hidden apps', rows === hiddenN, [rows, hiddenN]);
        const names = await pg.eval(() => Array.from(document.querySelectorAll('#pop .ovf-name')).every((n) => n.textContent.trim().length > 0));
        t.check('fit: every tile in it has a name', names);
        // a windows push that changes nothing behind "+N" must not rebuild the open panel
        await pg.eval(() => { window.__ovfGrid = document.querySelector('#pop .ovf-grid'); });
        await pg.eval(() => window.__mockMain.pushWindows());
        await pg.wait(200);
        t.check('fit: an unrelated update leaves the open panel alone', await pg.eval(() => document.querySelector('#pop .ovf-grid') === window.__ovfGrid && !!window.__ovfGrid));
        await pg.key('Escape');
        t.check('fit: Esc closes the panel', await popKey(pg) === null);
        await more.click(); await pg.wait(350);
        await pg.click('#pop .ovf-app', { button: 'right', wait: 400 });
        t.check('fit: right-click on a tile opens the app menu', /jl|jump/.test(await popKey(pg) || '') || (await pg.count('#pop .jl-i')) > 0, await popKey(pg));
        await pg.key('Escape');
        await more.click(); await pg.wait(350);
        await pg.reset();
        await pg.click('#pop .ovf-app', { button: 'middle', wait: 250 });
        let mc = await pg.calls('bar.open');
        t.check('fit: middle-click on a tile asks for a new window', mc.length === 1 && mc[0].p.fresh === true, mc);
        await more.click(); await pg.wait(350);
        await pg.reset();
        await pg.click('#pop .ovf-app', { wait: 200 });
        const c = await pg.calls('bar.open');
        t.check('fit: clicking one opens that app', c.length === 1 && !!c[0].p.id, c);
        t.check('fit: ...and closes the panel', await popKey(pg) === null);
      }
      t.check('fit: no page errors', pg.errors.length === 0, pg.errors);
      await pg.close();
    }
  });
}

run().then(() => t.done(), (e) => { t.check('the run itself', false, e && e.stack || e); t.done(); });
