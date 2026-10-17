require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* gcal.page.test.js - Google Calendar in the clock's calendar, CLICKED (ui/bar/gcal.js + gcal.css).
 *
 * WHAT: opens the real bar (ui/bar/index.html) over the mock bridge with MOCK Google events
 * (mock-mantle.js ?gcal=<case>: made-up calendars and events relative to today; never a real account)
 * in headless Chromium, light AND dark, and checks the day dots, the agenda, "No events", not connected,
 * the offline / rate-limit / sign-in-ended lines, the keyboard, a row opening its event, a month the
 * cache does not hold, and that the open path makes no gcal call before its first frame. Then it times
 * the open with 500 cached events against the plain calendar (PERF.md: warm p95 50 ms to first frame).
 *
 * Run (one test browser; the heavy-test queue):  node ui/bar/gcal.page.test.js
 * SHOTS=<dir> also saves gcal-<case>-<theme>.png, cropped to the flyout.  ONLY=perf,keys runs groups.
 * Prints "GCAL PAGE TEST: n passed, m failed"; exits 1 on a failure.
 */
'use strict';
const path = require('path');
const H = require('./page-harness.js');
const t = H.suite('GCAL PAGE TEST');
const SHOTS = process.env.SHOTS || '';
const JARGON = /\b(sidecar|IPC|renderer|dryRun|Electron|undefined|null|NaN|gcal\.[a-z]+|\w+Exception|DPAPI)\b|\[object/;
const DESK = { light: '#dfe4ec', dark: '#141619' };
const themeInit = (th) => 'document.documentElement.dataset.theme = ' + JSON.stringify(th) + ';' +
  'document.addEventListener("readystatechange", function () { document.documentElement.dataset.theme = ' + JSON.stringify(th) + '; });';

async function run() {
  if (H.gaming()) { console.log('a game is running: the browser half is skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const W = { w: 1280, h: 760 };
    const go = async (th, gcal, extra) => {
      const pg = await open('?mode=pill&gcal=' + gcal + (extra || ''), Object.assign({}, W, { init: themeInit(th) }));
      await pg.page.addStyleTag({ content: 'html{background:' + DESK[th] + ' !important;}' });
      return pg;
    };
    const openCal = async (pg) => { await pg.click('#clock', { wait: 350 }); };
    const popOpen = (pg) => pg.eval(() => { const p = document.querySelector('#pop'); return !!p && !p.hidden && p.classList.contains('cal'); });
    const shot = async (pg, name) => {
      if (!SHOTS) return;
      const r = await pg.eval(() => { const b = document.querySelector('#pop').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      const pad = 18;
      await pg.page.screenshot({ path: path.join(SHOTS, 'gcal-' + name + '.png'), clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 } });
    };
    const noJargon = async (pg, what) => {
      const s = await pg.eval(() => { const p = document.querySelector('#pop .gcal'); return p ? p.innerText + '\n' + Array.prototype.map.call(p.querySelectorAll('[title]'), (e) => e.title).join('\n') : ''; });
      const m = JARGON.exec(s);
      t.check(what + ': no jargon on screen or in tooltips', !m, m ? m[0] + ' in: ' + s.slice(Math.max(0, m.index - 60), m.index + 60) : '');
    };

    for (const th of ['light', 'dark']) {
      /* ------------------------------------------------------------ events: dots + agenda */
      if (t.want('events')) {
        const pg = await go(th, 'events');
        await pg.reset();
        // every request the page makes while it opens (the page is file://, so anything else is the network)
        const reqs = [];
        const onReq = (rq) => reqs.push(rq.url());
        pg.page.on('request', onReq);
        // the open path: no gcal call before the first frame
        const sync = await pg.eval(() => { document.querySelector('#clock').click(); return (window.__MOCK_CALLS__ || []).map((c) => c.ch); });
        t.check(th + ' events: the open path makes no gcal call (no IPC, no network)', !sync.some((c) => /^gcal\./.test(c)), sync);
        await pg.wait(350);
        pg.page.off('request', onReq);
        const net = reqs.filter((u) => !/^(file|data|blob|about):/i.test(u));
        t.check(th + ' events: opening the calendar makes NO network request', net.length === 0, net.slice(0, 5));
        const after = (await pg.calls()).map((c) => c.ch);
        t.check(th + ' events: gcal.opened only after the first frame, once', after.filter((c) => c === 'gcal.opened').length === 1, after);
        t.check(th + ' events: the calendar is open', await popOpen(pg));
        t.check(th + ' events: still 42 days, today marked once', await pg.count('#pop .calday') === 42 && await pg.count('#pop .calday.today') === 1);
        const order = await pg.eval(() => Array.prototype.map.call(document.querySelector('#pop').children, (e) => e.className.split(' ')[0]).join(','));
        t.check(th + ' events: the agenda sits between the grid and the footer', /calgrid,gcal,calfoot/.test(order), order);
        const dots = await pg.count('#pop .calday .gcal-dot');
        t.check(th + ' events: days with events have a dot', dots >= 8, dots);
        t.check(th + ' events: today (several calendars) has ONE neutral dot', await pg.count('#pop .calday.today .gcal-dot.many') === 1);
        const one = await pg.eval(() => {   // a day with one calendar only: its dot is that calendar's colour
          const d = new Date(); d.setDate(d.getDate() + 6);
          const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          const dot = document.querySelector('#pop .calday[data-day="' + k + '"] .gcal-dot');
          return dot ? getComputedStyle(dot).backgroundColor : 'no dot (the day may be in the next month grid)';
        });
        t.check(th + ' events: a one-calendar day\'s dot is the calendar colour', one === 'rgb(3, 155, 229)' || /next month/.test(one), one);
        t.check(th + ' events: today is selected by default', await pg.count('#pop .calday.today.sel') === 1 && await pg.text('#pop .gcal-head') === 'Today');
        const rows = await pg.eval(() => Array.prototype.map.call(document.querySelectorAll('#pop .gcal-row'), (r) => [r.querySelector('.gcal-time').textContent, r.querySelector('.gcal-title').textContent, getComputedStyle(r.querySelector('.gcal-bar')).backgroundColor]));
        t.check(th + ' events: today\'s 5 events, all-day first', rows.length === 5 && rows[0][0] === 'All day' && rows[1][0] === '6:45 AM' && rows[4][0] === '8:30 PM', rows);
        t.check(th + ' events: each row in its calendar colour', rows[0][2] === 'rgb(51, 182, 121)' && rows[2][2] === 'rgb(142, 36, 170)', rows.map((r) => r[2]));
        t.check(th + ' events: no status line when all is well', await pg.count('#pop .gcal-note') === 0);
        const sizes = await pg.eval(() => { const p = document.querySelector('#pop'); const l = document.querySelector('#pop .gcal-list'); return { pop: p.getBoundingClientRect().height, list: l.clientHeight, scroll: l.scrollHeight }; });
        t.check(th + ' events: the flyout stays a reasonable height (< 520 px)', sizes.pop < 520, sizes);
        await noJargon(pg, th + ' events');
        await shot(pg, 'events-' + th);
        // tomorrow: 7 rows -> the list scrolls after about 5
        await pg.click('#pop .calday.today + .calday, #pop .calday.sel + .calday', { wait: 150 });
        const tom = await pg.eval(() => { const l = document.querySelector('#pop .gcal-list'); return { head: document.querySelector('#pop .gcal-head').textContent, n: l.querySelectorAll('.gcal-row').length, ch: l.clientHeight, sh: l.scrollHeight }; });
        t.check(th + ' events: clicking a day selects it (Tomorrow)', tom.head === 'Tomorrow' && await pg.count('#pop .calday.sel') === 1, tom);
        t.check(th + ' events: 7 rows scroll inside ~5 rows of height', tom.n === 7 && tom.sh > tom.ch && tom.ch <= 145 && tom.ch >= 130, tom);
        await shot(pg, 'tomorrow-' + th);
        // a row opens its event in the browser (main looks the link up by key)
        await pg.reset();
        await pg.click('#pop .gcal-row:nth-child(2)', { wait: 200 });
        const oc = await pg.calls('gcal.open');
        t.check(th + ' events: a row asks main to open THAT event', oc.length === 1 && typeof oc[0].p.event === 'string' && oc[0].p.event.length > 0, oc);
        t.check(th + ' events: ...and the flyout closes', !(await popOpen(pg)));
        t.check(th + ' events: no page errors', pg.errors.length === 0, pg.errors);
        await pg.close();
      }

      /* ------------------------------------------------------------ the keyboard */
      if (t.want('keys')) {
        const pg = await go(th, 'events');
        await openCal(pg);
        const focused = await pg.eval(() => { const a = document.activeElement; return a && a.classList.contains('calday') && a.classList.contains('sel'); });
        t.check(th + ' keys: the keyboard lands on the selected day', focused);
        await pg.key('ArrowRight');
        t.check(th + ' keys: Right moves the selection a day', await pg.text('#pop .gcal-head') === 'Tomorrow');
        await pg.key('ArrowLeft'); await pg.key('ArrowLeft');
        t.check(th + ' keys: Left twice = Yesterday', await pg.text('#pop .gcal-head') === 'Yesterday');
        await pg.key('ArrowRight');
        const ring = await pg.eval(() => { const a = document.activeElement; return getComputedStyle(a).boxShadow; });
        t.check(th + ' keys: the focus ring is INSIDE the day (inset)', /inset/.test(ring), ring);
        await pg.key('Enter');
        t.check(th + ' keys: Enter goes into the day\'s agenda', await pg.eval(() => document.activeElement.classList.contains('gcal-row')));
        await pg.key('ArrowDown');
        const second = await pg.eval(() => Array.prototype.indexOf.call(document.querySelectorAll('#pop .gcal-row'), document.activeElement));
        t.check(th + ' keys: Down walks the rows', second === 1, second);
        const rring = await pg.eval(() => getComputedStyle(document.activeElement).boxShadow);
        t.check(th + ' keys: the row focus ring is inset', /inset/.test(rring), rring);
        await shot(pg, 'keys-' + th);
        await pg.reset();
        await pg.key('Enter', 250);
        t.check(th + ' keys: Enter opens the event', (await pg.calls('gcal.open')).length === 1);
        // a week down from the last row of the month crosses into the next month
        await openCal(pg);
        for (let i = 0; i < 6; i++) await pg.key('ArrowDown', 60);
        const title = await pg.text('#pop .caltitle');
        const next = await pg.eval(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); });
        t.check(th + ' keys: six weeks down moves into next month', title === next, [title, next]);
        t.check(th + ' keys: no page errors', pg.errors.length === 0, pg.errors);
        await pg.close();
      }

      /* ------------------------------------------------------------ the other states */
      if (t.want('states')) {
        let pg = await go(th, 'empty');
        await openCal(pg);
        t.check(th + ' empty: "No events" for today', await pg.text('#pop .gcal-empty') === 'No events' && await pg.count('#pop .gcal-row') === 0);
        await shot(pg, 'empty-' + th);
        await pg.close();

        pg = await go(th, 'disconnected');
        await openCal(pg);
        t.check(th + ' not connected: ONE quiet row, no agenda', await pg.count('#pop .gcal-connect') === 1 && await pg.count('#pop .gcal-list') === 0 && await pg.text('#pop .gcal-connect') === 'Connect Google Calendar');
        t.check(th + ' not connected: no dots', await pg.count('#pop .gcal-dot') === 0);
        await noJargon(pg, th + ' not connected');
        await shot(pg, 'connect-' + th);
        await pg.reset();
        await pg.click('#pop .gcal-connect', { wait: 200 });
        const so = await pg.calls('settings.open');
        t.check(th + ' not connected: the row opens Settings at the Google group', so.length === 1 && so[0].p.section === 'time' && so[0].p.page === 'datetime' && so[0].p.row === 'time.datetime.gcal', so);
        t.check(th + ' not connected: ...and the flyout closes', !(await popOpen(pg)));
        await pg.close();

        for (const [k, re] of [['offline', /^Last synced 12 min ago · no internet connection$/], ['ratelimit', /^Last synced 12 min ago · Google asked Mantle to slow down/], ['expired', /^Last synced 1 min ago · Google ended Mantle.s sign-in; sign in again in Settings$/]]) {
          pg = await go(th, k);
          await openCal(pg);
          const note = await pg.text('#pop .gcal-note');
          t.check(th + ' ' + k + ': cached rows stay', await pg.count('#pop .gcal-row') === 5);
          t.check(th + ' ' + k + ': the line says when and why', re.test(note || ''), note);
          await noJargon(pg, th + ' ' + k);
          if (k === 'offline') await shot(pg, 'offline-' + th);
          await pg.close();
        }

        pg = await go(th, 'syncing');
        await openCal(pg);
        t.check(th + ' syncing: says so', await pg.text('#pop .gcal-note') === 'Syncing with Google…');
        await pg.close();

        pg = await go(th, 'off');
        await openCal(pg);
        t.check(th + ' off: the calendar is exactly the plain month', await pg.count('#pop .gcal') === 0 && await pg.count('#pop .calday') === 42 && await pg.count('#pop .calfoot') === 1 && !(await pg.eval(() => document.querySelector('#pop').classList.contains('gcal-on'))));
        t.check(th + ' off: no gcal call at all', (await pg.calls()).every((c) => !/^gcal\./.test(c.ch)));
        await pg.close();

        // a month the cache does not hold: asked for after the frame, and said while it loads
        pg = await go(th, 'events');
        await openCal(pg);
        await pg.reset();
        await pg.click('#pop .calbtn[aria-label="Next month"]', { wait: 80 });
        t.check(th + ' month: next month is cached: nothing asked', (await pg.calls('gcal.want')).length === 0);
        await pg.click('#pop .calbtn[aria-label="Next month"]', { wait: 120 });
        const want = await pg.calls('gcal.want');
        const exp = await pg.eval(() => { const d = new Date(); const n = new Date(d.getFullYear(), d.getMonth() + 2, 1); return { year: n.getFullYear(), month: n.getMonth(), name: n.toLocaleDateString(undefined, { month: 'long' }) }; });
        t.check(th + ' month: two months on is asked for', want.length === 1 && want[0].p.year === exp.year && want[0].p.month === exp.month, want);
        t.check(th + ' month: "Loading <month> from Google…" while it comes', await pg.text('#pop .gcal-note') === 'Loading ' + exp.name + ' from Google…', await pg.text('#pop .gcal-note'));
        t.check(th + ' states: no page errors', pg.errors.length === 0, pg.errors);
        await pg.close();
      }

      /* ------------------------------------------------------------ Windows' time zone changes */
      if (t.want('zone') && th === 'light') {
        const pg = await go(th, 'events');
        await openCal(pg);
        // "Morning run" is today 6:45 in the page's own zone (mock-mantle.js)
        const S = await pg.eval(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 6, 45).getTime(); });
        const west = await pg.eval(() => new Date().getTimezoneOffset() > 0);
        await pg.key('Escape', 250);
        if (await popOpen(pg)) await openCal(pg);          // the clock toggles it shut
        t.check('zone: the calendar closed before the change', !(await popOpen(pg)));
        const cdp = await pg.page.context().newCDPSession(pg.page);
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: west ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago' });
        await openCal(pg);
        t.check('zone: the calendar opens again', await popOpen(pg));
        const z = await pg.eval((s) => { const D = window.MantleGcalDays; const k = D.keyOf(new Date(s)); const p = D.dateOf(k); return { k, before: D.keyOf(new Date(p.getFullYear(), p.getMonth(), p.getDate() - 1)), after: D.keyOf(new Date(p.getFullYear(), p.getMonth(), p.getDate() + 1)), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }; }, S);
        t.check('zone: the page really changed time zone', /Kiritimati|Pago_Pago/.test(z.zone), z);
        const titlesOn = async (k) => {
          if (!(await pg.count('#pop .calday[data-day="' + k + '"]'))) return null;
          await pg.click('#pop .calday[data-day="' + k + '"]', { wait: 120 });
          return pg.eval(() => Array.prototype.map.call(document.querySelectorAll('#pop .gcal-row'), (r) => r.textContent));
        };
        const on = await titlesOn(z.k), prev = await titlesOn(z.before);
        t.check('zone: after the change, an event sits on its NEW local day', !!on && on.some((s) => /Morning run/.test(s)), [z, on]);
        t.check('zone: ...and is gone from the day it used to be on', prev === null || !prev.some((s) => /Morning run/.test(s)), prev);
        t.check('zone: no page errors', pg.errors.length === 0, pg.errors);
        await cdp.detach().catch(() => {});
        await pg.close();
      }
    }

    /* ------------------------------------------------------------ open time with 500 cached events */
    if (t.want('perf')) {
      const measure = async (gcal) => {
        const pg = await open('?mode=pill&gcal=' + gcal, W);
        const r = await pg.eval(async () => {
          const out = [];
          const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
          for (let i = 0; i < 25; i++) {
            const t0 = performance.now();
            document.querySelector('#clock').click();
            await frame();
            out.push(performance.now() - t0);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            await new Promise((res) => setTimeout(res, 80));
          }
          // the push itself: what 500 events cost when they ARRIVE (off the open path)
          const p = { ver: 9, spans: [], calendars: [], events: [] };
          const st = window.MantleGcal && window.MantleGcal._state().idx;
          const n = st ? Array.from(st.days.values()).reduce((a, l) => a + l.length, 0) : 0;
          let idxMs = null;
          if (window.MantleGcalDays && st) {
            const evs = [];
            st.days.forEach((l) => l.forEach((e) => { if (evs.indexOf(e) < 0) evs.push(e); }));
            p.events = evs; p.calendars = Object.keys(st.colors).map((id) => ({ id, color: st.colors[id] }));
            const a = performance.now(); window.MantleGcalDays.index(p); idxMs = performance.now() - a;
          }
          return { out, n, idxMs, events: p.events.length };
        });
        await pg.close();
        const s = r.out.slice(5).sort((a, b) => a - b);   // the first 5 warm the page up
        const q = (f) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 10) / 10;
        return { p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] * 10) / 10, events: r.events, dayRows: r.n, idxMs: r.idxMs === null ? null : Math.round(r.idxMs * 10) / 10 };
      };
      const base = await measure('off');
      const many = await measure('many');
      console.log('  open to first frame, plain calendar: p50 ' + base.p50 + ' ms, p95 ' + base.p95 + ' ms, max ' + base.max + ' ms');
      console.log('  open to first frame, 500 cached events: p50 ' + many.p50 + ' ms, p95 ' + many.p95 + ' ms, max ' + many.max + ' ms (' + many.events + ' events, ' + many.dayRows + ' day rows; index built on arrival in ' + many.idxMs + ' ms)');
      t.check('perf: 500 events are in the cache', many.events === 500, many);
      t.check('perf: warm open p95 within 50 ms with 500 events (PERF.md)', many.p95 <= 50, many);
      t.check('perf: 500 events add under 8 ms at p50 to the plain calendar', many.p50 - base.p50 < 8, [base, many]);
    }
  });
}

run().then(() => t.done(), (e) => { t.check('the run itself', false, String(e && e.stack || e)); t.done(); });
