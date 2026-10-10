/* pingtest-shots.js — the ping test in the PING dropdown (lane pingtest, 2026-10-09), for shoot.js.
 * Plays the sidecar's `pingtest` events into the page (mock-mantle.js plays main) and CHECKS, light
 * and dark: idle -> Run sends start and the menu stays open; running shows progress and a Cancel that
 * sends cancel; closing the dropdown sends nothing and the result is there on reopen with its time;
 * done: amber exactly on the bad values (servers: avg >= 100 ms, jitter >= 10 ms, any loss; router:
 * avg >= 20 ms), the best server marked, the router line; every failure says its reason. PNGs:
 * pt-<state>-<light|dark>.png in OUT.
 *   used by shoot.js: await require('./pingtest-shots').pingTestChecks(browser, check, PAGE, OUT)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const AT = new Date(2026, 9, 9, 16, 12, 0).getTime();
const CAPS = { rounds: 20, periodMs: 750, downMs: 8000, downBytes: 60e6, upMs: 6000, upBytes: 25e6, answerMs: 5000, downStreams: 4, upStreams: 3 };
const R = (name, host, avg, min, max, jitter, loss, extra) => Object.assign({ kind: 'server', name, host, via: 'AWS', method: 'icmp', sent: 20, got: Math.round(20 * (100 - loss) / 100), avg, min, max, jitter, loss, best: false }, extra || {});
const ROUTER = (avg, min, max, jitter, loss) => ({ kind: 'router', name: 'Your router', host: '10.0.0.1', via: 'Wi-Fi', iface: 'Wi-Fi', wifi: true, method: 'icmp', sent: 20, got: 20 - loss / 5, avg, min, max, jitter, loss });
const SERVERS = () => [
  R('US West (N. California)', 'dynamodb.us-west-1.amazonaws.com', 15.8, 14, 19, 1.2, 0, { best: true }),
  R('US West (Oregon)', 'dynamodb.us-west-2.amazonaws.com', 36.1, 34, 41, 1.9, 0),
  R('US Central (Texas)', 'speedtest.dallas.linode.com', 57.3, 55, 63, 2, 0),
  R('US Central (Illinois)', 'speedtest.chicago.linode.com', 65, 63, 74, 2.6, 5),
  R('US East (N. Virginia)', 'dynamodb.us-east-1.amazonaws.com', 102.4, 77, 131, 12.5, 0),
  R('US East (Georgia)', 'speedtest.atlanta.linode.com', 70.2, 67, 79, 2.2, 0),
];
const SP = (state, mbps, bytes, extra) => Object.assign({ state, mbps, live: null, bytes, ms: 0, why: null }, extra || {});
const base = (o) => Object.assign({ run: 1, phase: 'done', running: false, why: null, startedAt: AT - 30000, endedAt: AT, progress: 1, label: 'Valorant',
  listWhy: null, routerWhy: null, rows: [ROUTER(2.4, 1.6, 4.1, 0.6, 0)].concat(SERVERS()), down: SP('ok', 62, 60e6), up: SP('ok', 30.8, 25e6),
  host: 'speed.cloudflare.com', caps: CAPS, test: null }, o);

const STATES = {
  done: base({}),
  'running-ping': base({ phase: 'ping', running: true, endedAt: null, progress: 0.3,
    rows: [ROUTER(2.1, 1.6, 3, 0.5, 0)].concat(SERVERS().map((r, i) => Object.assign(r, i === 5
      ? { sent: 0, got: 0, avg: null, min: null, max: null, jitter: null, loss: null, best: false }   // its first ping is not back yet
      : { sent: 6 - (i % 2), got: 6 - (i % 2), loss: 0, best: false }))),
    down: SP('waiting', null, 0), up: SP('waiting', null, 0) }),
  'running-down': base({ phase: 'down', running: true, endedAt: null, progress: 0.62, down: SP('running', null, 18e6, { live: 58.3 }), up: SP('waiting', null, 0) }),
  'wifi-lag': base({ rows: [ROUTER(28.1, 2, 180, 26.4, 0)].concat(SERVERS()) }),
  'internet-lag': base({ rows: [ROUTER(2, 1.4, 3.2, 0.4, 0)].concat(SERVERS().map((r) => Object.assign(r, { avg: r.avg + 100, loss: 0, got: 20 }))) }),
  'fail-norouter': base({ routerWhy: 'no router found: Windows reports no default gateway', rows: SERVERS() }),
  'fail-speed': base({ down: SP('failed', null, 0, { why: 'download: speed.cloudflare.com did not answer in 5 s' }),
    up: SP('skipped', null, 0, { why: 'upload skipped: the download could not reach speed.cloudflare.com' }) }),
  'fail-offline': base({ phase: 'failed', why: 'offline: Windows reports no network connection', rows: [], down: SP('waiting', null, 0), up: SP('waiting', null, 0) }),
  'fail-server': base({ rows: [ROUTER(2.4, 1.6, 4.1, 0.6, 0)].concat(SERVERS().slice(0, 5)).concat([R('US East (Georgia)', 'speedtest.atlanta.linode.com', null, null, null, null, 100,
    { got: 0, sent: 3, gaveUp: true, why: 'no reply from Valorant US East (Georgia) in 1 s' })]) }),
  cancelled: base({ phase: 'cancelled', progress: 0.55, down: SP('cancelled', null, 4e6), up: SP('waiting', null, 0) }),
};

function measure() {
  const ms = window.__mockCalls.filter((c) => c.name === 'topbar.menuState').pop();
  const dd = document.querySelector('.dd.stat');
  const pt = document.querySelector('.pt');
  const r = dd ? dd.getBoundingClientRect() : null;
  const tok = (v) => { const e = document.createElement('i'); e.style.color = `var(${v})`; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
  const warn = tok('--lg-warn');
  return {
    open: !!(window.__topbar.open && window.__topbar.open.stat === 'ping'),
    asked: ms && ms.args.open ? ms.args.height : null, ih: innerHeight,
    rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height, bottom: dd.offsetTop + dd.offsetHeight } : null,
    hidden: dd ? getComputedStyle(dd).visibility === 'hidden' : true,
    scrolls: dd ? dd.scrollHeight > dd.clientHeight + 1 : false,
    text: pt ? pt.innerText : '',
    head: pt && pt.querySelector('h4') ? pt.querySelector('h4').textContent : '',
    go: [...document.querySelectorAll('.pt .r.pt-go')].map((e) => ({ act: e.dataset.act, lb: e.querySelector('.lb').textContent, kb: e.querySelector('.kb').textContent })),
    prog: pt && pt.querySelector('progress') ? +pt.querySelector('progress').value : null,
    hi: [...document.querySelectorAll('.pt .pt-x.hi')].map((e) => e.previousElementSibling ? e.textContent : e.textContent),
    hiColors: [...document.querySelectorAll('.pt .pt-x.hi')].map((e) => getComputedStyle(e).color),
    warn,
    best: [...document.querySelectorAll('.pt .pt-best')].map((e) => e.parentElement.textContent),
    bad: [...document.querySelectorAll('.pt .info.bad')].map((e) => e.textContent),
    verdict: (document.querySelector('.pt .pt-verdict') || {}).textContent || '',
    inline: document.querySelectorAll('.pt [style]').length,
    calls: window.__mockCalls.filter((c) => c.name === 'topbar.pingTest').map((c) => c.args.action),
  };
}

async function pingTestChecks(browser, check, PAGE, OUT) {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const page = await browser.newPage({ viewport: { width: 1536, height: 38 }, screen: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
    const cdp = await page.context().newCDPSession(page);
    const setWin = (h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: h, deviceScaleFactor: 1.25, mobile: false, screenWidth: 1536, screenHeight: 864 });
    const grow = async () => {   // play main: the window grows to the height the page asks for
      let m = await page.evaluate(measure);
      for (let k = 0; k < 4 && m.asked && m.ih !== Math.min(m.asked, 864); k++) { await setWin(Math.min(m.asked, 864)); await page.waitForTimeout(40); m = await page.evaluate(measure); }
      return m;
    };
    const shot = async (name, m) => {
      if (!m.rect) return;
      const clip = { x: Math.max(0, m.rect.x - 12), y: 0, width: Math.min(1536, m.rect.w + 24), height: Math.min(m.ih, m.rect.bottom + 14), scale: 1 };
      fs.writeFileSync(path.join(OUT, `pt-${name}-${theme}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    };
    const emit = (s) => page.evaluate((x) => window.mantle.emit('topbar.pingtest', x), s);
    const up = (sel) => page.evaluate((q) => { const e = document.querySelector(q); if (e) e.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return !!e; }, sel);
    const tag = (s) => `ping test (${theme}): ${s}`;

    await setWin(38);
    await page.goto(PAGE + '?stat=ping' + (dark ? '&dark=1' : ''));
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    // dark is <html data-theme="dark"> (glass-light.css; the mock's dark=1 body class predates it)
    if (dark) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('mantle-theme')); });
    await page.waitForFunction(() => window.__topbar.open && window.__topbar.open.stat === 'ping', null, { timeout: 2000 });
    await page.waitForTimeout(200);

    // ---- idle
    let m = await grow();
    check(tag('idle: a Run ping test row with the time and data it will use'), m.go.length === 1 && m.go[0].act === 'pt-start' && m.go[0].lb === 'Run ping test' &&
      m.go[0].kb === 'about 30 s · up to 85 MB', JSON.stringify(m.go));
    check(tag('idle: the caption says what it does and the data it uses'), /Pings every Valorant location and your router 20 times/.test(m.text) && /up to 85 MB of data/.test(m.text) && /speed\.cloudflare\.com/.test(m.text), m.text);
    check(tag('idle: no results, no speed rows, no reasons before the first run'), !/(^|\n)SPEED(\n|$)|failed|Mbps|Your router/.test(m.text) && m.bad.length === 0, m.text);
    check(tag('idle: the state was read once at load (the last run)'), m.calls.length === 1 && m.calls[0] === 'state', JSON.stringify(m.calls));
    check(tag('idle: the dropdown is shown whole, nothing scrolls'), !m.hidden && !m.scrolls && m.rect.bottom <= m.ih, JSON.stringify([m.rect, m.ih]));
    await shot('idle', m);

    // ---- Run -> start, menu stays open, Cancel at once
    await up('.pt .r[data-act="pt-start"]');
    await page.waitForTimeout(30);
    m = await page.evaluate(measure);
    check(tag('Run sends start; the menu stays open and offers Cancel at once'), m.calls.includes('start') && m.open && m.go.length === 1 && m.go[0].act === 'pt-cancel', JSON.stringify([m.calls, m.go]));

    // ---- running: ping phase
    await emit(STATES['running-ping']);
    m = await grow();
    check(tag('running: a progress line at the run\'s progress and the step in words'), m.prog === 300 && /Pinging 7 places, 20 times each/.test(m.text), JSON.stringify([m.prog, m.text.slice(0, 200)]));
    check(tag('running: rows fill in as replies come, the unmeasured one says waiting'), /waiting/.test(m.text) && /2\.1 ms/.test(m.text), m.text.slice(0, 400));
    check(tag('running: no best is marked before the pings are done'), m.best.length === 0, JSON.stringify(m.best));
    await shot('running-ping', m);
    await emit(STATES['running-down']);
    m = await grow();
    check(tag('running: the download phase shows its live speed'), /Download speed… 58\.3 Mbps/.test(m.text) && m.prog === 620, m.text);
    if (!dark) await shot('running-down', m);
    await up('.pt .r[data-act="pt-cancel"]');
    await page.waitForTimeout(30);
    m = await page.evaluate(measure);
    check(tag('Cancel sends cancel and the menu stays open'), m.calls[m.calls.length - 1] === 'cancel' && m.open, JSON.stringify(m.calls));

    // ---- closing the dropdown does not cancel; the result waits for the reopen, with its time
    const before = m.calls.length;
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));   // click-away
    await page.waitForTimeout(30);
    await emit(STATES.done);   // the run ends while the dropdown is closed
    m = await page.evaluate(measure);
    check(tag('closing the dropdown sends nothing (no cancel)'), !m.open && m.calls.length === before, JSON.stringify(m.calls));
    await page.evaluate(() => document.querySelector('.st[data-k="ping"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await page.waitForTimeout(200);
    m = await grow();
    const when = await page.evaluate((t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), STATES.done.endedAt);
    check(tag('reopened: the finished result is there with its time'), m.open && m.head === `Ping test · ${when}` && /Your router/.test(m.text) && /62\.0 Mbps/.test(m.text) && /30\.8 Mbps/.test(m.text), JSON.stringify([m.head, when]));

    // ---- done: amber exactly on the bad values, best marked, the router line
    check(tag('done: amber on exactly the bad values (Illinois loss 5%, N. Virginia avg 102 ms and jitter 13 ms)'),
      JSON.stringify(m.hi) === JSON.stringify(['5%', '102 ms', '13 ms']), JSON.stringify(m.hi));
    check(tag('done: amber is --lg-warn'), m.hiColors.length === 3 && m.hiColors.every((c) => c === m.warn), JSON.stringify([m.hiColors, m.warn]));
    check(tag('done: the best server is marked, once'), m.best.length === 1 && /N\. California/.test(m.best[0]), JSON.stringify(m.best));
    check(tag('done: the router line says no lag'), /^No lag found: your router answers in 2\.4 ms and the closest server in 16 ms\.$/.test(m.verdict), m.verdict);
    check(tag('done: jitter and loss explained in one caption, with the thresholds'), /Jitter: how much the ping jumps between replies\. Loss: pings that never came back\. Amber: 100\+ ms \(router 20\+\), jitter 10\+ ms, any loss\./.test(m.text), m.text);
    check(tag('done: the data used and the endpoint are said'), /Used 85 MB of data with speed\.cloudflare\.com/.test(m.text), m.text);
    check(tag('done: Run again, with its time and data'), m.go.length === 1 && m.go[0].lb === 'Run again' && m.go[0].kb === 'about 30 s · up to 85 MB', JSON.stringify(m.go));
    check(tag('done: no inline style (the CSP drops them) and the dropdown shows whole'), m.inline === 0 && !m.hidden && m.rect.bottom <= m.ih && !m.scrolls, JSON.stringify([m.inline, m.rect, m.ih]));
    await shot('done', m);

    // ---- the router lines
    await emit(STATES['wifi-lag']); m = await grow();
    check(tag('Wi-Fi lag: the router is amber and the line blames the Wi-Fi'), /^The lag starts at your Wi-Fi: your own router takes 28 ms on average, jumps by 26 ms\.$/.test(m.verdict) && m.hi.includes('28 ms'), JSON.stringify([m.verdict, m.hi]));
    if (dark) await shot('wifi-lag', m);
    await emit(STATES['internet-lag']); m = await grow();
    check(tag('internet lag: router fine, servers slow -> the line says the internet'), /^Your router answers in 2\.0 ms, so your Wi-Fi is fine: the lag is out on the internet\.$/.test(m.verdict), m.verdict);
    if (!dark) await shot('internet-lag', m);

    // ---- every failure says why
    const FAILS = [
      ['fail-norouter', /^no router found: Windows reports no default gateway$/],
      ['fail-speed', /^Speed test, download: speed\.cloudflare\.com did not answer in 5 s$/],
      ['fail-offline', /^offline: Windows reports no network connection$/],
      ['fail-server', /^US East \(Georgia\): no reply from Valorant US East \(Georgia\) in 1 s$/],
    ];
    for (const [name, re] of FAILS) {
      await emit(STATES[name]); m = await grow();
      check(tag(`${name}: the reason is shown in words`), m.bad.some((b) => re.test(b)), JSON.stringify(m.bad));
      check(tag(`${name}: the dropdown shows whole`), !m.hidden && m.rect.bottom <= m.ih, JSON.stringify([m.rect, m.ih]));
      await shot(name, m);
    }
    await emit(STATES['fail-speed']); m = await page.evaluate(measure);
    check(tag('fail-speed: the upload says it was skipped and why'), m.bad.some((b) => /^Speed test, upload skipped: the download could not reach speed\.cloudflare\.com$/.test(b)), JSON.stringify(m.bad));
    await emit(STATES['fail-offline']); m = await page.evaluate(measure);
    check(tag('fail-offline: the header says failed with the time; Run again is there'), new RegExp(`^Ping test · failed ${when}$`).test(m.head) && m.go[0].act === 'pt-start', m.head);

    await emit(STATES.cancelled); m = await grow();
    check(tag('cancelled: says so, keeps what it measured'), new RegExp(`^Ping test · cancelled ${when}$`).test(m.head) && /Cancelled: what it measured before that is above\./.test(m.text) && /cancelled/.test(m.text) && /Your router/.test(m.text), m.head);
    if (!dark) await shot('cancelled', m);

    // ---- a refused start says why (the sidecar's own words)
    await page.evaluate(() => { const c = window.mantle.call; window.mantle.call = (n, a) => (n === 'topbar.pingTest' && a.action === 'start' ? (window.__mockCalls.push({ name: n, args: a }), Promise.resolve({ ok: false, reason: 'a ping test is already running' })) : c(n, a)); });
    await up('.pt .r[data-act="pt-start"]');
    await page.waitForTimeout(60);
    m = await grow();
    check(tag('a refused start shows its reason'), m.bad.includes('The ping test could not start: a ping test is already running'), JSON.stringify(m.bad));
    if (!dark) await shot('fail-start', m);
    await historyChecks(page, check, tag, shot, grow, up, dark);
    await page.close();
  }
}


/* ---- HISTORY (Owen: "i want history of the tests and make it so i can save tests and name them and
 * each test should also say what wifi i was on"): a fake main in the page keeps the list, so the
 * clicks, the name box and its keys go the whole way round. */
const WIFI = (name, why) => (name ? { kind: name === 'Ethernet' ? 'ethernet' : 'wifi', name, why: null, iface: name === 'Ethernet' ? 'Ethernet' : 'Wi-Fi' } : { kind: 'wifi', name: null, why, iface: 'Wi-Fi' });
const HIDDEN = 'Wi-Fi name hidden by Windows: Location access is off for desktop apps (Settings > Privacy & security > Location > Let desktop apps access your location)';
function entry(i, o) {
  const s = base({ run: i, startedAt: AT - i * 3600e3, endedAt: AT - i * 3600e3 + 30e3 });
  const best = s.rows.find((r) => r.best), rt = s.rows.find((r) => r.kind === 'router');
  return Object.assign({ id: `${s.startedAt}-${i}`, at: s.startedAt, endedAt: s.endedAt, name: null, saved: false, wifi: WIFI('HomeNet'), wifiChanged: null, label: 'Valorant', host: s.host,
    best: { name: best.name, avg: best.avg, jitter: best.jitter, loss: best.loss }, router: { host: rt.host, avg: rt.avg, jitter: rt.jitter, loss: rt.loss, iface: rt.iface },
    routerWhy: null, listWhy: null, down: { mbps: 62, bytes: 60e6, why: null, state: 'ok' }, up: { mbps: 30.8, bytes: 25e6, why: null, state: 'ok' }, rows: s.rows }, o || {});
}
const HISTORY = () => [
  entry(1, { name: 'upstairs', saved: true, down: { mbps: 41.5, bytes: 60e6, state: 'ok' }, up: { mbps: 12.2, bytes: 25e6, state: 'ok' } }),
  entry(2),
  entry(3, { wifi: WIFI(null, HIDDEN) }),
  entry(4, { name: 'after router reset', saved: true, best: { name: 'US West (N. California)', avg: 118, jitter: 14, loss: 0 } }),
  entry(5, { wifi: WIFI('Ethernet') }),
];

async function historyChecks(page, check, tag, shot, grow, up, dark) {
  await page.evaluate((list) => {
    window.__hist = { tests: list, problem: null, max: 50 };
    const prev = window.mantle.call;
    window.mantle.call = (n, a) => {
      if (n !== 'topbar.pingTests') return prev(n, a);
      window.__mockCalls.push({ name: n, args: a });
      const h = window.__hist, t = h.tests.find((x) => x.id === a.id);
      if (a.action === 'save' || a.action === 'rename') { if (t) { t.name = a.name; t.saved = true; } }
      if (a.action === 'delete') h.tests = h.tests.filter((x) => x.id !== a.id);
      return Promise.resolve({ ok: true, history: JSON.parse(JSON.stringify(h)) });
    };
    window.mantle.emit('topbar.pingtests', JSON.parse(JSON.stringify(window.__hist)));
  }, HISTORY());
  const q = async () => { await grow(); await page.waitForTimeout(80); return q0(); };   // a box shown by the grow takes its focus within 50 ms
  const q0 = () => page.evaluate(() => ({
    rows: [...document.querySelectorAll('.pt .pt-hrow')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    saved: document.querySelectorAll('.pt .pt-hrow .pt-saved').length,
    tabs: [...document.querySelectorAll('.pt .pt-tab')].map((t) => (t.classList.contains('on') ? '*' : '') + t.textContent),
    chips: [...document.querySelectorAll('.pt .pt-chip')].map((t) => (t.classList.contains('on') ? '*' : '') + t.textContent),
    go: [...document.querySelectorAll('.pt .r.pt-go')].map((e) => (e.classList.contains('armed') ? '!' : '') + e.querySelector('.lb').textContent),
    box: !!document.querySelector('.pt .pt-name'), focused: !!(document.activeElement && document.activeElement.classList.contains('pt-name')),
    value: (document.querySelector('.pt .pt-name') || {}).value, head: [...document.querySelectorAll('.pt h4')].map((h) => h.textContent).join(' | '),
    text: (document.querySelector('.pt') || {}).innerText || '', bad: [...document.querySelectorAll('.pt .info.bad')].map((e) => e.textContent),
    hist: window.__mockCalls.filter((c) => c.name === 'topbar.pingTests').map((c) => c.args), open: !!(window.__topbar.open && window.__topbar.open.stat === 'ping'),
    inline: document.querySelectorAll('.pt [style]').length,
  }));
  await up('.pt .pt-tab[data-act="pt-tab:history"]');
  await page.waitForTimeout(40);
  let m = await grow(), h = await q();
  check(tag('history: the History tab lists every kept test, newest first, the saved ones marked'), h.tabs.join(',') === 'Test,*History · 5' && h.rows.length === 5 && h.saved === 2 &&
    /^upstairs saved HomeNet 16 ms ↓41\.5 ↑12\.2$/.test(h.rows[0]), JSON.stringify(h.rows));
  check(tag('history: a hidden Wi-Fi name is said, never a blank; Ethernet is named'), /Wi-Fi \(name hidden\)/.test(h.rows[2]) && /Ethernet/.test(h.rows[4]), JSON.stringify(h.rows));
  check(tag('history: a bad best ping is amber in the list'), await page.evaluate(() => document.querySelectorAll('.pt .pt-hb.hi').length === 1));
  check(tag('history: the dropdown shows whole, no inline style'), !m.hidden && m.rect.bottom <= m.ih && h.inline === 0, JSON.stringify([m.rect, m.ih]));
  await shot('history', m);
  check(tag('history: a Wi-Fi filter when there is more than one network'), h.chips.join(',') === '*All,HomeNet,Wi-Fi (name hidden),Ethernet', JSON.stringify(h.chips));
  await up('.pt .pt-chip[data-act="pt-filter:0"]'); await page.waitForTimeout(20); h = await q();
  check(tag('history: filtering by a Wi-Fi shows only its tests'), h.rows.length === 3 && h.chips[1] === '*HomeNet', JSON.stringify([h.rows.length, h.chips]));
  await up('.pt .pt-chip[data-act="pt-filter:all"]'); await page.waitForTimeout(20);
  // one test in full, from the hidden-Wi-Fi row
  const ids = HISTORY().map((e) => e.id);
  await up(`.pt .pt-hrow[data-act="pt-open:${ids[2]}"]`); await page.waitForTimeout(20); m = await grow(); h = await q();
  check(tag('history: a row opens the whole result, with why the Wi-Fi name is missing'), h.text.includes(HIDDEN) && /Your router/.test(h.text) && /62\.0 Mbps/.test(h.text) &&
    h.go.join(',') === 'Save…,Delete,Back to history', JSON.stringify(h.go));
  // Save…: the name box, focused; typed words (with spaces) survive the 1 s re-render; Enter saves
  await up(`.pt .r[data-act="pt-save:${ids[2]}"]`); await page.waitForTimeout(30); h = await q();
  check(tag('save: the name box opens with the focus'), h.box && h.focused, JSON.stringify(h));
  await page.keyboard.type('after the ');
  await page.evaluate(() => window.mantle.emit('topbar.stats', window.__topbar.stats));   // the 1 s sample redraws the dropdown
  await page.keyboard.type('reset');
  h = await q(); m = await grow();
  check(tag('save: typing (spaces too) survives the 1 s redraw, and keeps the focus'), h.value === 'after the reset' && h.focused && h.open, JSON.stringify([h.value, h.focused]));
  await shot('history-save', m);
  await page.keyboard.press('Enter'); await page.waitForTimeout(40); h = await q();
  const last = h.hist[h.hist.length - 1];
  check(tag('save: Enter saves under the typed name and shows it'), last.action === 'save' && last.id === ids[2] && last.name === 'after the reset' && !h.box && /^after the reset · /.test(h.head) &&
    h.go.join(',') === 'Rename…,Delete,Back to history', JSON.stringify([last, h.head, h.go]));
  // Rename…, then Escape leaves the box and the dropdown stays
  await up(`.pt .r[data-act="pt-rename:${ids[2]}"]`); await page.waitForTimeout(30); h = await q();
  check(tag('rename: the box opens with the current name'), h.box && h.value === 'after the reset' && h.focused, JSON.stringify([h.value]));
  await page.keyboard.press('Escape'); await page.waitForTimeout(30); h = await q();
  check(tag('rename: Escape leaves the box; the dropdown stays open; nothing sent'), !h.box && h.open && h.hist.filter((a) => a.action === 'rename').length === 0, JSON.stringify(h.hist));
  // Delete asks once
  const n0 = h.hist.length;
  await up(`.pt .r[data-act="pt-del:${ids[2]}"]`); await page.waitForTimeout(30); h = await q(); m = await grow();
  check(tag('delete: the first press only asks'), h.hist.length === n0 && h.go.includes('!Delete: click again to confirm'), JSON.stringify(h.go));
  if (!dark) await shot('history-delete', m);
  await up(`.pt .r[data-act="pt-del:${ids[2]}"]`); await page.waitForTimeout(40); h = await q();
  check(tag('delete: the second press deletes and goes back to the list'), h.hist[h.hist.length - 1].action === 'delete' && h.hist[h.hist.length - 1].id === ids[2] && h.rows.length === 4, JSON.stringify(h.rows.length));
  // a damaged file: its reason, in words
  await page.evaluate(() => window.mantle.emit('topbar.pingtests', { tests: window.__hist.tests, problem: 'history could not be read: the file is damaged near character 12; starting fresh, old file kept as ping-tests.bad.json', max: 50 }));
  await page.waitForTimeout(20); h = await q(); m = await grow();
  check(tag('history: a damaged file says so, and where the old one went'), h.bad.includes('History could not be read: the file is damaged near character 12; starting fresh, old file kept as ping-tests.bad.json'), JSON.stringify(h.bad));
  if (dark) await shot('history-problem', m);
  // the Test tab: the current run's network, a network change, and Save… for it
  await up('.pt .pt-tab[data-act="pt-tab:test"]');
  const cur = Object.assign({}, STATES.done, { run: 7, startedAt: AT - 60e3, wifi: WIFI('HomeNet'), wifiChanged: 'the network changed during the test: Wi-Fi "HomeNet" at the start, Wi-Fi "Phone" at the end' });
  await page.evaluate((x) => { const e = Object.assign({}, window.__hist.tests[0], { id: `${x.startedAt}-${x.run}`, name: null, saved: false }); window.__hist.tests.unshift(e);
    window.mantle.emit('topbar.pingtests', JSON.parse(JSON.stringify(window.__hist))); window.mantle.emit('topbar.pingtest', x); }, cur);
  await page.waitForTimeout(30); h = await q(); m = await grow();
  check(tag('test tab: the network it ran on, a change said in amber, and Save… for this run'), /On Wi-Fi “HomeNet”/.test(h.text) && h.bad.some((b) => /^The network changed during the test: Wi-Fi "HomeNet" at the start, Wi-Fi "Phone" at the end$/.test(b)) &&
    h.go.join(',') === 'Save…,Run again', JSON.stringify([h.go, h.bad]));
  await shot('test-wifi', m);
}

module.exports = { pingTestChecks, STATES };
