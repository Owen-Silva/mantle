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
      await pg.reset();
      await pg.click('#volume', { button: 'middle', wait: 150 });
      t.check('vol: middle-click opens the volume mixer', (await pg.calls('osd.mixer')).length === 1);
      // as a person does it: the pointer rests on the speaker, its tooltip comes, then the right button
      await pg.reset();
      await pg.page.hover('#volume'); await pg.wait(1200);
      await pg.page.mouse.down({ button: 'right' }); await pg.page.mouse.up({ button: 'right' }); await pg.wait(200);
      t.check('vol: right-click with the tooltip up opens the volume mixer', (await pg.calls('osd.mixer')).length === 1);
      t.check('vol: ...and nothing else opens in the bar', await popKey(pg) === null, await popKey(pg));
      await pg.click('#volume', { wait: 350 });
      t.check('vol: a click opens Quick Settings', await pg.count('#pop .qstile') > 0);
      await pg.close();
    }

    /* The app volumes refused (the pop-up switched off in the tray): never a silent right-click. Quick
       settings opens instead, says why in plain words, and a line goes to the log (r5-overflow). */
    if (t.want('volfail')) {
      const pg = await open(PILL, Object.assign({}, W, { reply: '(ch, p) => ch === "osd.mixer" ? { ok: false, reason: "the pop-up is switched off in the tray" } : undefined' }));
      const logs = [];
      pg.page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
      await pg.click('#volume', { button: 'right', wait: 450 });
      t.check('volfail: the right-click still asked for the app volumes', (await pg.calls('osd.mixer')).length === 1);
      t.check('volfail: Quick settings opens instead', await pg.count('#pop .qstile') > 0, await popKey(pg));
      const note = await pg.eval(() => Array.from(document.querySelectorAll('#pop .qsnotes .note')).map((n) => n.textContent).join(' | '));
      t.check('volfail: the panel says why, in plain words', /app volumes did not open/i.test(note) && /switched off in the tray/i.test(note) && !JARGON.test(note), note);
      t.check('volfail: ...and a line goes to the log', logs.some((l) => /^warning: .*App volumes did not open.*osd\.mixer/i.test(l)), logs);
      t.check('volfail: no page errors', pg.errors.length === 0, pg.errors);
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

    /* ------------------------------------ a reveal from parked shows the apps (r5-overflow lane) */
    /* LIVE 2026-09-30 16:44 (Owen's screenshot): the bar came up with no app icons, only "+11" and
       Downloads, and a moment later showed every app. mantle.log: parked at 868x60 physical px
       (695 dip at 125 %), revealed as a 1400 px (1120 dip) pill that the page grows over 560 ms.
       The settle after each exit judged the fit on the PARKED bar (62 % of 695 dip: room for no
       icon at all) and put every app behind "+N", and the entrance kept that until the pill landed.
       Reproduced as live: open at the pill's width, hide, shrink the window to the parked width,
       then the pill rect and 'bar.reveal' together (from the resize event, as main does it). The
       animation clock is frozen for the entrance's first frame (late frames, as check-reveal.js
       does), then every frame is sampled until the pill has landed and settled. */
    if (t.want('reveal')) {
      const DOWN = 0.62;                                   // bar.css --pane-w at rest
      /* What the user sees of the dock, in one frame. Installed before the page's scripts. */
      const snap = function () {
        var dock = document.getElementById('dock'), bar = document.getElementById('bar'), more = document.getElementById('dock-more');
        var dr = dock.getBoundingClientRect();
        var cells = Array.prototype.slice.call(dock.querySelectorAll('.cell'));
        var shown = cells.filter(function (c) { return !c.classList.contains('ovf'); });
        var inBox = shown.filter(function (c) { var r = c.getBoundingClientRect(); return r.width > 0 && r.left >= dr.left - 1 && r.right <= dr.right + 1; }).length;
        var moreOn = !!more && !more.hidden && getComputedStyle(more).display !== 'none';
        return {
          up: document.body.classList.contains('up'),
          bw: Math.round(bar.getBoundingClientRect().width),
          /* the pill's width transition is still running: the entrance has not landed */
          fly: !!bar.getAnimations && bar.getAnimations().some(function (a) { return a.transitionProperty === 'width' && a.playState === 'running'; }),
          cells: cells.length,
          ovf: cells.length - shown.length,
          more: moreOn ? more.textContent : '',
          inBox: inBox,
          x: shown.map(function (c) { return Math.round(c.getBoundingClientRect().left); }).join(',')
        };
      };
      const INIT = 'window.__snap = ' + snap.toString() + ';';
      for (const c of [
        { name: 'fits', q: PILL, w: 1120, fits: true },                  // the mock's 14 icons (589 px) in the live 1120 pill
        { name: 'too many', q: PILL + '&apps=40', w: 1000, fits: false }  // genuinely too many: "+N" must hold steady
      ]) {
        const tag = 'reveal (' + c.name + '): ';
        const pg = await open(c.q, { w: c.w, h: 480, settle: 1400, init: INIT });
        const landed = await pg.eval(() => window.__snap());
        t.check(tag + 'the first reveal lands at the pill\'s width', landed.up && Math.abs(landed.bw - c.w) <= 1, landed);
        if (c.fits) t.check(tag + 'every app is on the strip and there is no "+N"', landed.ovf === 0 && landed.more === '' && landed.inBox === landed.cells, landed);
        else t.check(tag + 'some apps wait behind "+N", which says how many', landed.ovf > 0 && landed.more === '+' + landed.ovf, landed);

        /* down, then parked: the window shrinks to the pill's down width, as main parks it */
        await pg.eval(() => window.__mockMain.hide());
        await pg.wait(500);
        await pg.page.setViewportSize({ width: Math.round(c.w * DOWN), height: 480 });
        await pg.wait(400);
        const parked = await pg.eval(() => window.__snap());
        t.check(tag + 'parking the bar does not change which apps wait behind "+N"', !parked.up && parked.ovf === landed.ovf && parked.more === landed.more, [parked, landed]);

        /* the entrance's first frame: clock frozen, then the pill rect and the reveal together */
        const cdp = await pg.page.context().newCDPSession(pg.page);
        await cdp.send('Animation.enable');
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
        await pg.eval(() => {
          window.addEventListener('resize', () => window.__mockMain.reveal('harness: reveal from parked'), { once: true });
          window.__frames = [];
          const t0 = performance.now();
          const tick = () => { const s = window.__snap(); s.t = Math.round(performance.now() - t0); window.__frames.push(s); if (s.t < 2400) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        await pg.page.setViewportSize({ width: c.w, height: 480 });
        await pg.wait(450);                                // the pins answer at 30 ms, a settle runs 50 ms later
        const first = await pg.eval(() => window.__snap());
        t.check(tag + 'reproduced: revealed, the pill still at its down width', first.up && first.bw < c.w - 50, first);
        if (c.fits) t.check(tag + 'the entrance\'s first frame has the apps and no "+N"', first.ovf === 0 && first.more === '' && first.inBox > 0, first);
        else t.check(tag + 'the entrance\'s first frame has the same "+N" as the landed bar', first.ovf === landed.ovf && first.more === landed.more, [first, landed]);

        /* the frames come: the pill grows, lands and settles */
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
        await pg.wait(1300);
        const frames = (await pg.eval(() => window.__frames)).filter((f) => f.up);
        const end = await pg.eval(() => window.__snap());
        const off = frames.filter((f) => f.ovf !== landed.ovf || f.more !== landed.more);
        t.check(tag + 'no frame of the entrance changes what waits behind "+N" (' + frames.length + ' frames)', frames.length > 5 && off.length === 0,
          { frames: frames.length, off: off.slice(0, 3) });
        t.check(tag + 'landed again exactly as the first time', Math.abs(end.bw - c.w) <= 1 && end.ovf === landed.ovf && end.more === landed.more && end.x === landed.x, [end, landed]);
        const home = frames.filter((f) => !f.fly && Math.abs(f.bw - c.w) <= 1);   // landed: the transition is over
        const moved = home.filter((f) => f.x !== end.x);
        t.check(tag + 'nothing jumps when the landed fit is judged (' + home.length + ' landed frames)', home.length > 0 && moved.length === 0,
          { home: home.length, moved: moved.slice(0, 2), end: end.x });
        await cdp.detach().catch(() => {});
        t.check(tag + 'no page errors', pg.errors.length === 0, pg.errors);
        await pg.close();
      }
    }

    /* ------------------------------------------ Spotify ready, no media session (barfix lane) */
    /* The Spotify Mantle starts hidden with nothing loaded has no Windows media session. The chip
       and card must still offer it (Play Liked Songs), and go the moment the link is gone. */
    if (t.want('spotidle')) {
      const IDLE = PILL + '&media=none&spq=idle';
      // what the eye sees, not the attribute: a class's display rule can beat [hidden]
      const hid = (pg, sel) => pg.eval((s) => { const e = document.querySelector(s); return !e || !e.offsetParent || !e.getClientRects().length; }, sel);
      const pg = await open(IDLE, W);
      await pg.wait(250);
      t.check('spotidle: the chip shows with no media session', !(await hid(pg, '#media')));
      t.check('spotidle: ...named Spotify, with its icon', (await pg.text('#mchip .mtxt')) === 'Spotify' && await pg.count('#mchip .mart img') === 1, await pg.text('#mchip .mtxt'));
      t.check('spotidle: ...and no play/pause (nothing is loaded to play)', await hid(pg, '#mtog'));
      const tip = await pg.eval(() => document.getElementById('mchip').title);
      t.check('spotidle: its tooltip says nothing is playing and what a click does', /nothing is playing/i.test(tip) && /click to play/i.test(tip), tip);
      await pg.reset();
      await pg.click('#mchip', { wait: 400 });
      t.check('spotidle: a click opens the card', /mcard/.test(await popKey(pg) || ''), await popKey(pg));
      t.check('spotidle: the card says nothing is playing', (await pg.text('#pop .mc-title')) === 'Nothing is playing' && (await pg.text('#pop .mc-artist')) === 'Spotify is ready');
      t.check('spotidle: no transport, no progress, no app line', await hid(pg, '#pop .mc-ctl') && await hid(pg, '#pop .mc-prog') && await hid(pg, '#pop .mc-progwhy') && await hid(pg, '#pop .mc-app'));
      t.check('spotidle: the first thing offered is Play Liked Songs', (await pg.text('#pop .spq-idle')) === 'Play Liked Songs' && !(await hid(pg, '#pop .spq-idle .spq-btn')), await pg.text('#pop .spq-idle'));
      const ct = await pg.text('#pop');
      t.check('spotidle: no jargon on the card', !JARGON.test(ct), ct);
      t.check('spotidle: opening it controlled nothing', (await pg.calls('media.control')).length === 0);
      await pg.click('#pop .spq-idle .spq-btn', { wait: 700 });
      const pu = await pg.calls('spotify.playUri');
      t.check('spotidle: Play Liked Songs asks Spotify for Liked Songs', pu.length === 1 && pu[0].p.uri === 'spotify:collection:tracks', pu);
      t.check('spotidle: ...the card stays open as the real session takes over', /mcard/.test(await popKey(pg) || ''), await popKey(pg));
      t.check('spotidle: ...showing the track with its buttons', (await pg.text('#pop .mc-title')) !== 'Nothing is playing' && !(await hid(pg, '#pop .mc-ctl')) && !(await hid(pg, '#pop .mc-app')), await pg.text('#pop .mc-title'));
      t.check('spotidle: ...and the chip gets its play/pause back', !(await hid(pg, '#mtog')));
      t.check('spotidle: no page errors', pg.errors.length === 0, pg.errors);
      await pg.close();

      // the link wavers while the idle card is open: held (the section says why); gone once it closes
      const p2 = await open(IDLE, W);
      await p2.wait(250);
      await p2.click('#mchip', { wait: 400 });
      await p2.emit('spotify.status', { ok: false, state: 'notrunning', reason: 'Spotify is not running', port: 47292 });
      await p2.wait(200);
      t.check('spotidle: an open idle card is held when Spotify stops', /mcard/.test(await popKey(p2) || ''), await popKey(p2));
      await p2.key('Escape'); await p2.wait(250);
      const after = { pop: await popKey(p2), chipHidden: await hid(p2, '#media') };
      // (the pointer is still where the chip was: a dock icon that slides under it may open its own previews)
      t.check('spotidle: ...and once it closes, the chip goes', !/mcard/.test(after.pop || '') && after.chipHidden, after);
      await p2.emit('spotify.status', { ok: true, state: 'connected', reason: null, port: 47292 });
      await p2.wait(150);
      t.check('spotidle: the chip comes back when Spotify is connected again', !(await hid(p2, '#media')));
      await p2.emit('spotify.status', { ok: false, state: 'notrunning', reason: 'Spotify is not running', port: 47292 });
      await p2.wait(150);
      t.check('spotidle: ...and goes, with the card shut, when it is not', await hid(p2, '#media'));
      t.check('spotidle: no page errors (link wavering)', p2.errors.length === 0, p2.errors);
      await p2.close();

      // a Spotify that Mantle cannot reach (the default: not started by Mantle) gets no chip of its own
      const p3 = await open(PILL + '&media=none', W);
      await p3.wait(250);
      t.check('spotidle: no session and no Spotify link: no chip', await hid(p3, '#media'));
      await p3.close();
    }
  });
}

run().then(() => t.done(), (e) => { t.check('the run itself', false, e && e.stack || e); t.done(); });
