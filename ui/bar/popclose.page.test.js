require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* popclose.page.test.js - the bar's pop-ups close when main says the click or the Esc happened
 * OUTSIDE the bar, and a box that held the keyboard stops looking typeable when the keyboard goes
 * (lane mn-pop, 2026-10-12, audit #1 and #8).
 *
 * WHAT: the real index.html + bar.js + qs-more.js on the mock bridge (page-harness.js, headless
 * Chromium over file://). Main's two new events are pushed exactly as main.js sends them:
 *   bar.popclose        lib/popwatch.js saw a click outside the bar window, or an Esc in another app
 *   bar.keyboard.lost   main.js qsKbBlur: the bar lost the keyboard on its own
 * and every case asserts on what the user sees and on what the bar asked main to do.
 *
 *   node ui/bar/popclose.page.test.js
 * Prints "POPCLOSE PAGE TEST: n passed, m failed".
 */
'use strict';
const H = require('./page-harness.js');
const t = H.suite('POPCLOSE PAGE TEST');

async function run() {
  if (H.gaming()) { console.log('a game is running: the browser half is skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const W = { w: 1280, h: 720 };
    const popOpen = (pg) => pg.eval(() => !document.getElementById('pop').hidden);
    const closes = async (pg) => (await pg.calls('bar.popover')).filter((c) => c.p && c.p.open === false).length;

    // ---- bar.popclose closes every kind of pop-up, the way the page's own outside click does
    const pg = await open('?mode=pill', W);
    const kinds = [['quick settings', '#network'], ['the calendar', '#clock'], ['the More menu', '#more']];
    for (const [name, sel] of kinds) {
      await pg.reset();
      await pg.click(sel, { wait: 400 });
      const was = await popOpen(pg);
      t.check(`${name}: opens from its button`, was);
      await pg.emit('bar.popclose', { why: 'a left click outside it' });
      await pg.eval(() => new Promise((r) => setTimeout(r, 150)));
      t.check(`${name}: a click outside the bar (bar.popclose) closes it`, was && !(await popOpen(pg)));
      t.check(`${name}: and gives its room back (bar.popover open:false)`, (await closes(pg)) >= 1, await pg.calls('bar.popover'));
    }
    await pg.reset();
    await pg.emit('bar.popclose', { why: 'Esc' });
    await pg.eval(() => new Promise((r) => setTimeout(r, 100)));
    t.check('bar.popclose with nothing open asks main for nothing', (await pg.calls('bar.popover')).length === 0, await pg.calls());

    // ---- Esc from another app is the same event: the newest pop-up goes, the bar keeps working
    await pg.click('#more', { wait: 400 });
    await pg.emit('bar.popclose', { why: 'Esc' });
    await pg.eval(() => new Promise((r) => setTimeout(r, 150)));
    await pg.click('#more', { wait: 400 });
    t.check('a pop-up opens again after being closed from outside', await popOpen(pg));
    await pg.emit('bar.popclose', { why: 'Esc' });

    // ---- bar.keyboard.lost: the Wi-Fi password box closes and says why; quick settings stays
    const q = await open('?mode=pill', W);
    await q.click('#network', { wait: 400 });
    await q.click('.qsx-chev', { wait: 1300 });
    await q.click('.qsx-net[data-ssid="Cafe WiFi"] .qsx-nethead', { wait: 300 });
    await q.click('.qsx-net.open .qsx-btn.acc', { wait: 400 });
    const field = await q.visible('#qsxpw');
    t.check('the password box appears once the bar holds the keyboard (mock qs.keyboard ok)', field);
    const kbOn = (await q.calls('qs.keyboard')).filter((c) => c.p && c.p.on === true).length;
    await q.reset();
    await q.emit('bar.keyboard.lost', { why: 'another window took focus' });
    await q.eval(() => new Promise((r) => setTimeout(r, 200)));
    t.check('keyboard lost: the password box is gone', field && !(await q.visible('#qsxpw')));
    const why = await q.text('.qsx-net.open .qsx-err');
    t.check('keyboard lost: the row says the keyboard went to another window', /keyboard went to another window/i.test(why || ''), why);
    t.check('keyboard lost: and how to get the box back (Connect)', /Press Connect/.test(why || ''), why);
    t.check('keyboard lost: quick settings itself stays open', await popOpen(q));
    t.check('keyboard lost: the bar does not ask for the keyboard back by itself', (await q.calls('qs.keyboard')).length === 0, await q.calls('qs.keyboard'));
    await q.click('.qsx-net.open .qsx-btn.acc', { wait: 400 });
    t.check('Connect again asks for the keyboard and brings the box back',
      (await q.calls('qs.keyboard')).some((c) => c.p && c.p.on === true) && await q.visible('#qsxpw') && kbOn >= 1);
    await q.emit('bar.popclose', { why: 'a left click outside it' });
    await q.eval(() => new Promise((r) => setTimeout(r, 150)));
    t.check('a click outside closes quick settings with the box in it', !(await popOpen(q)));
    t.check('...and gives the keyboard back as it closes', (await q.calls('qs.keyboard')).some((c) => c.p && c.p.on === false), await q.calls('qs.keyboard'));

    // ---- keyboard lost with a pop-up that never had the keyboard: nothing happens
    await q.click('#clock', { wait: 400 });
    await q.emit('bar.keyboard.lost', { why: 'another window took focus' });
    await q.eval(() => new Promise((r) => setTimeout(r, 150)));
    t.check('keyboard lost leaves the calendar alone (it never took the keyboard)', await popOpen(q));
    await q.emit('bar.popclose', { why: 'Esc' });
  });
}

run().then(() => t.done(), (e) => { t.check('the run itself', false, e && e.stack || e); t.done(); });
