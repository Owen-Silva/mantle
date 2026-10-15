require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* apppower.test.js — App power in the CPU / RAM / GPU dropdowns (lane mantle-power-ui, 2026-10-14).
 *
 * Headless Chromium over file:// (never Electron, never a real app): the REAL top bar page
 * (ui/topbar/index.html: topbar.js + apppower.js + topbar.css) on a FAKE window.mantle defined before
 * the page's own scripts (so mock-mantle.js stands aside). The fake plays main: topbar.stats samples
 * decorated the way lib/apppower-core.js decorates them, and apppower.set / remember / trim / reset
 * answering like lib/features/apppower.js. Every app, number and path is MADE UP.
 *
 * Checks: rows with labels ("Quartz (13)"), state marks and the reading; protected rows say why and
 * open nothing; a refusal shows on its row; a click and the keyboard open a panel (one at a time);
 * every control sends the right command and arguments; Remember is on by default; the panel, its focus
 * and its row's place survive 5 re-sorted samples; Free up memory shows the answer's words; the memory
 * limit's warning; GPU: priority hidden with its reason when Windows refuses it, the preference only
 * with 2 GPUs, the honest line; a failed change says why on the row and springs back; no jargon; with the
 * feature off the rows are exactly the old ones. Shots (light + dark, CPU / RAM / GPU with a row open):
 * MANTLE_SHOOT_OUT, default C:/Users/user/mantle-notes/power-shots.
 *
 *   node ui/topbar/apppower.test.js        Prints "APP POWER DROPDOWN TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || 'C:/Users/user/mantle-notes/power-shots';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail != null ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

/* Runs IN THE PAGE before its scripts. Made-up apps; the decorated fields of contract section 4. */
function FAKE() {
  const GB = 1073741824, MB = 1048576;
  const DEF = { eco: false, priority: null, cpuCap: 0, memLow: false, memCap: 0, gpuLow: false, gpuPref: 'default' };
  const APPS = {
    k1: { label: 'Quartz', exe: 'quartz', n: 13, ctl: true, cpu: 5.1, mem: 1.62 * GB, gpu: 3.4, shared: false },
    k2: { label: 'Service Host', exe: 'svchost', n: 43, ctl: false, why: 'Windows protects this process', cpu: 4.6, mem: 0.9 * GB, gpu: 0 },
    k3: { label: 'PowerShell', exe: 'powershell', n: 3, ctl: true, deny: 'Windows didn’t let Mantle change PowerShell: it runs as administrator', cpu: 3.9, mem: 0.21 * GB, gpu: 0 },
    k4: { label: 'MsMpEng', exe: 'MsMpEng', n: 1, ctl: false, why: 'Windows protects this process', cpu: 3.6, mem: 0.33 * GB, gpu: 0 },
    k5: { label: 'Mantle', exe: 'electron', n: 6, ctl: false, why: 'This is Mantle', cpu: 2.8, mem: 0.41 * GB, gpu: 1.2 },
    k6: { label: 'Code', exe: 'Code', n: 9, ctl: true, cpu: 1.9, mem: 1.1 * GB, gpu: 0.8 },
    k7: { label: 'Rocket League', exe: 'RocketLeague', n: 1, ctl: false, why: 'Mantle never changes games or anti-cheat', cpu: 1.2, mem: 2.4 * GB, gpu: 31.5 },
  };
  const ST = {};   // key -> { set, remembered }
  Object.keys(APPS).forEach((k) => { ST[k] = { set: Object.assign({}, DEF), remembered: false }; });
  const isDef = (s) => Object.keys(DEF).every((f) => s[f] === DEF[f]);
  const row = (k) => {
    const a = APPS[k], s = ST[k];
    return { key: k, label: a.label, n: a.n, ctl: a.ctl, why: a.why || null, deny: a.deny || null, set: Object.assign({}, s.set), remembered: s.remembered,
      shared: (s.set.cpuCap || s.set.memCap) ? (a.shared === false ? false : true) : null, test: !!window.__apTest };
  };
  const caps = { gpus: 1, gpuLow: false, gpuLowWhy: 'Windows only lets administrators change graphics priority', gpuPref: false };
  window.__ap = { fail: new Set(), off: false, caps, ST, APPS, freed: { ok: true, freed: 412 * MB, text: 'Freed 412 MB' } };
  // one sample; order = keys in the order the sidecar sorted them this second
  window.__sample = (order, bump) => {
    const top = (kind) => (order || Object.keys(APPS).slice(0, 5)).map((k, i) => {
      const a = APPS[k];
      const base = { name: a.exe + (a.n > 1 ? ` (${a.n})` : ''), exe: a.exe, n: a.n, path: 'C:\\Made up\\' + a.exe + '.exe', access: a.ctl ? 'ok' : 'protected' };
      if (kind === 'mem') base.bytes = a.mem + (bump || 0) * MB * i; else base.pct = (kind === 'cpu' ? a.cpu : a.gpu) + (bump || 0) * 0.1 * i;
      return window.__ap.off ? base : Object.assign(base, row(k));
    });
    const p = { t: Date.now(), cpu: { pct: 23.4, cores: [22, 61, 9, 14, 37, 5, 71, 18], top: top('cpu') },
      mem: { used: 9.7 * GB, total: 15.7 * GB, commit: 13.1 * GB, commitLimit: 23.4 * GB, top: top('mem') },
      gpu: { pct: 7.8, name: 'Made-up Graphics 600', engines: [{ type: '3D', pct: 7.8 }, { type: 'Copy', pct: 0 }], dedicated: 0.13 * GB, shared: 1.2 * GB, top: top('gpu') },
      net: { down: 2.4 * MB, up: 88 * 1024, adapters: [{ name: 'Wi-Fi', down: 2.4 * MB, up: 88 * 1024 }] }, costMs: 1.8 };
    if (!window.__ap.off) p.apppower = Object.assign({}, window.__ap.caps, { test: !!window.__apTest });
    (handlers['topbar.stats'] || []).forEach((fn) => fn(p));
  };
  const handlers = {};
  const later = (v) => new Promise((res) => setTimeout(() => res(v), 15));
  const focus = { hwnd: '4242', cls: 'Notepad', title: 'notes.txt - Notepad', exe: 'C:\\Made up\\notepad.exe', pid: 7, appPid: 7, desc: 'Notepad', product: 'Notepad',
    self: false, shell: false, fullscreen: false, zoomed: true, topmost: false, enabled: true, uia: 'not needed', menu: null, menuReason: 'no Win32 menu bar' };
  window.__calls = [];
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    call(name, args) {
      const a = JSON.parse(JSON.stringify(args || {}));
      window.__calls.push({ name, args: a });
      const k = a.key;
      if (/^apppower\./.test(name) && window.__ap.fail.has(k)) return later({ ok: false, reason: 'Windows didn’t let Mantle change Quartz: it runs as administrator', row: row(k) });
      switch (name) {
        case 'topbar.hello': return Promise.resolve({ focus, stats: null });
        case 'glass.topbarMenu': return Promise.resolve({ ok: false, reason: 'no desktop picture in a page test' });
        case 'apppower.set': {
          const s = ST[k];
          const ch = a.change || {};
          Object.keys(ch).forEach((f) => { s.set[f] = f === 'priority' && ch[f] === 'normal' ? null : ch[f]; });
          s.remembered = isDef(s.set) ? false : a.remember !== false;
          return later({ ok: true, row: row(k), dryRun: window.__apTest || undefined });
        }
        case 'apppower.remember': ST[k].remembered = !!a.on; return later({ ok: true, row: row(k) });
        case 'apppower.trim': return later(window.__ap.freed);
        case 'apppower.reset': ST[k].set = Object.assign({}, DEF); ST[k].remembered = false; return later({ ok: true, row: row(k) });
        default: return Promise.resolve({ ok: true });
      }
    },
  };
}

// <html data-theme="dark"> before the first paint: <html> does not exist yet when an init script runs
// (ui/settings/test-browser.js applyTheme does the same)
function dark(theme) {
  const put = () => { const el = document.documentElement; if (el) el.setAttribute('data-theme', theme); return !!el; };
  if (!put()) { const mo = new MutationObserver(() => { if (put()) mo.disconnect(); }); mo.observe(document, { childList: true }); }
  document.addEventListener('DOMContentLoaded', put);
}

async function run(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.25 });
  await ctx.addInitScript(FAKE);
  if (theme === 'dark') await ctx.addInitScript(dark, 'dark');
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' <- ').replace(/file:\/\/\/[^ )]*\//g, '')));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__topbar && !!window.AppPower, null, { timeout: 8000 });
  const T = theme;
  check(`${T}: the page is in the ${T} theme`, (await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'light')) === T);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const settle = (ms) => page.waitForTimeout(ms || 60);
  const sample = async (order, bump) => { await ev(([o, b]) => window.__sample(o, b), [order || null, bump || 0]); await settle(30); };
  const openStat = async (k) => { await ev((kk) => { const s = window.__topbar; if (s.open) document.querySelector(`.st[data-k="${s.open.stat}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.querySelector(`.st[data-k="${kk}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }, k); await settle(80); };
  const names = () => ev(() => [...document.querySelectorAll('.dd.stat .ap-item .ap-n')].map((e) => e.textContent));
  const item = (label) => page.locator('.dd.stat .ap-item', { has: page.locator('.ap-n', { hasText: label }) }).first();
  const calls = (name) => ev((n) => window.__calls.filter((c) => c.name === n).map((c) => c.args), name);
  const lastCall = async (name) => (await calls(name)).pop();
  const clearCalls = () => ev(() => { window.__calls = []; });
  const key = async (k, n) => { for (let i = 0; i < (n || 1); i++) await page.keyboard.press(k); await settle(40); };
  const panelOpen = (label) => item(label).evaluate((el) => el.classList.contains('open') && el.querySelector('.ap-pc') !== null);
  const shot = async (name) => {
    const r = await ev(() => { const d = document.querySelector('.dd.stat').getBoundingClientRect(); return { x: d.left, y: 0, w: d.width, h: d.bottom }; });
    const clip = { x: Math.max(0, r.x - 24), y: 0, width: Math.min(1280 - Math.max(0, r.x - 24), r.w + 48), height: Math.min(900, r.h + 24) };
    await page.screenshot({ path: path.join(OUT, `ap-${name}-${T}.png`), clip });
  };

  await sample();
  /* ---- CPU ---- */
  await openStat('cpu');
  check(`${T}: CPU rows use label (n)`, JSON.stringify(await names()) === JSON.stringify(['Quartz (13)', 'Service Host (43)', 'PowerShell (3)', 'MsMpEng', 'Mantle (6)']), JSON.stringify(await names()));
  check(`${T}: the reading is on each row`, (await item('Quartz').locator('.ap-x').textContent()).includes('5'));
  const prot = await item('Service Host').evaluate((el) => ({ why: el.querySelector('.ap-s') && el.querySelector('.ap-s').textContent, ctl: el.classList.contains('ctl'), lock: [...el.querySelectorAll('.ap-c svg')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => !!g.querySelector('rect')).join() === 'true' }));
  check(`${T}: a protected row says why, with a lock and no controls`, prot.why === 'Windows protects this process' && !prot.ctl && prot.lock, JSON.stringify(prot));
  check(`${T}: Mantle's own row says so`, (await item('Mantle').locator('.ap-s').textContent()) === 'This is Mantle');
  await item('Service Host').locator('.ap-row').click();
  await settle(260);
  check(`${T}: clicking a protected row opens nothing`, (await page.locator('.dd.stat .ap-item.open').count()) === 0);
  check(`${T}: a refusal shows on its row`, /Windows didn’t let Mantle change PowerShell: it runs as administrator/.test(await item('PowerShell').locator('.ap-sub').textContent()));
  // open by click
  await item('Quartz').locator('.ap-row').click();
  await settle(280);
  check(`${T}: a click opens the panel`, await panelOpen('Quartz'));
  check(`${T}: a controllable row shows only its chevron`, (await item('Quartz').evaluate((el) => [...el.querySelectorAll('.ap-c svg')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => !!g.querySelector('rect')).join())) === 'false');
  const ptxt = await item('Quartz').locator('.ap-pc').textContent();
  check(`${T}: CPU panel has its controls`, ['Efficiency mode', 'Priority', 'Low', 'Below normal', 'Normal', 'Above normal', 'CPU limit', 'of your whole CPU', 'No limit', '75%', '50%', '25%', '10%', 'Remember for this app'].every((w) => ptxt.includes(w)), ptxt);
  check(`${T}: Remember is on by default`, (await item('Quartz').locator('.ap-ck').getAttribute('aria-checked')) === 'true');
  await clearCalls();
  await item('Quartz').locator('.ap-sw[data-f="eco"]').click();
  await settle(80);
  const eco = await lastCall('apppower.set');
  check(`${T}: Efficiency mode sends set {eco:true} remember:true`, eco && eco.key === 'k1' && eco.change.eco === true && Object.keys(eco.change).length === 1 && eco.remember === true, JSON.stringify(eco));
  check(`${T}: the switch shows on, the row shows the leaf`, (await item('Quartz').locator('.ap-sw[data-f="eco"]').getAttribute('aria-checked')) === 'true' && (await item('Quartz').locator('.ap-mk.eco').count()) === 1);
  check(`${T}: Efficiency mode implies Low priority`, (await item('Quartz').locator('[data-f="priority"] [aria-checked="true"]').textContent()) === 'Low');
  await item('Quartz').locator('[data-f="priority"] [data-v="belownormal"]').click();
  await settle(80);
  const pr = await lastCall('apppower.set');
  check(`${T}: Priority sends set {priority:"belownormal"}`, pr && pr.change.priority === 'belownormal' && pr.remember === true, JSON.stringify(pr));
  await item('Quartz').locator('[data-f="cpuCap"] [data-v="25"]').click();
  await settle(80);
  const cap = await lastCall('apppower.set');
  check(`${T}: CPU limit 25% sends set {cpuCap:25}`, cap && cap.change.cpuCap === 25, JSON.stringify(cap));
  check(`${T}: the row shows the cap badge`, (await item('Quartz').locator('.ap-mk.cap').textContent()) === 'CPU 25%');
  check(`${T}: shared:false says it applies fully after a restart`, (await item('Quartz').locator('.ap-shared').evaluate((e) => !e.hidden && e.textContent)) === 'Applies fully after Quartz restarts');
  await sample(['k1', 'k2', 'k3', 'k4', 'k5']);
  check(`${T}: the next sample keeps what was set`, (await item('Quartz').locator('.ap-mk.cap').count()) === 1 && (await item('Quartz').locator('.ap-mk.eco').count()) === 1);
  // remember off (a rule exists now)
  await item('Quartz').locator('.ap-ck').click();
  await settle(80);
  const rem = await lastCall('apppower.remember');
  check(`${T}: unticking Remember sends remember {on:false}`, rem && rem.key === 'k1' && rem.on === false, JSON.stringify(rem));
  check(`${T}: the box shows off`, (await item('Quartz').locator('.ap-ck').getAttribute('aria-checked')) === 'false');
  await item('Quartz').locator('.ap-ck').click();
  await settle(80);
  // THE 1 S RE-RENDER: focus a chip, mark the panel element, then 5 samples in shuffled orders
  await item('Quartz').locator('[data-f="cpuCap"] [data-v="50"]').focus();
  await item('Quartz').locator('.ap-pc').evaluate((el) => { el.__mark = 7; });
  const idx0 = await ev(() => [...document.querySelectorAll('.dd.stat .ap-item')].findIndex((e) => e.querySelector('.ap-n').textContent.startsWith('Quartz')));
  const ORDERS = [['k6', 'k3', 'k1', 'k2', 'k4'], ['k2', 'k6', 'k7', 'k5', 'k4'], ['k5', 'k1', 'k6', 'k7', 'k3'], ['k7', 'k6', 'k5', 'k4', 'k1'], ['k3', 'k2', 'k1', 'k6', 'k5']];
  let held = 0;
  for (let i = 0; i < 5; i++) {
    await sample(ORDERS[i], i + 1);
    const st = await ev(() => {
      const items = [...document.querySelectorAll('.dd.stat .ap-item')];
      const q = items.findIndex((e) => e.querySelector('.ap-n').textContent.startsWith('Quartz'));
      const pc = q >= 0 ? items[q].querySelector('.ap-pc') : null;
      const a = document.activeElement;
      return { q, mark: pc && pc.__mark, open: q >= 0 && items[q].classList.contains('open'), focus: a && a.dataset && a.dataset.v, n: items.length };
    });
    if (st.q === idx0 && st.mark === 7 && st.open && st.focus === '50') held++;
    else failures.push(`${T}: sample ${i + 1} moved the open panel (${JSON.stringify(st)})`);
  }
  check(`${T}: the panel, its focus and its row's place survive 5 re-sorted samples`, held === 5, held + ' of 5');
  // failure: springs back and says why on the row
  await ev(() => window.__ap.fail.add('k1'));
  await item('Quartz').locator('[data-f="cpuCap"] [data-v="10"]').click();
  await settle(90);
  check(`${T}: a failed change says why on the row`, /Windows didn’t let Mantle change Quartz/.test(await item('Quartz').locator('.ap-s.bad').first().textContent()));
  check(`${T}: and springs back`, (await item('Quartz').locator('[data-f="cpuCap"] [aria-checked="true"]').textContent()) === '25%');
  await ev(() => window.__ap.fail.delete('k1'));
  await shot('cpu');
  // keyboard: Esc closes, arrows move, Enter opens and focuses the first control, Tab moves, Left closes
  await key('Escape');
  check(`${T}: Esc closes the panel, the dropdown stays`, !(await panelOpen('Quartz')) && (await ev(() => !!(window.__topbar.open && window.__topbar.open.stat === 'cpu'))));
  await sample();   // unfrozen: sorted again
  const hotName = () => ev(() => { const h = document.querySelector('.dd.stat .ap-item.hot .ap-n'); return h ? h.textContent : null; });
  await page.mouse.move(5, 600);
  await ev(() => { const P = window.AppPower.state(); P.hot = null; P.kbd = false; P.inside = false; });
  await key('ArrowDown');
  check(`${T}: ArrowDown highlights the first row`, (await hotName()) === 'Quartz (13)', await hotName());
  await key('ArrowDown', 2);
  check(`${T}: ArrowDown moves on`, (await hotName()) === 'PowerShell (3)', await hotName());
  await key('Enter');
  await settle(260);
  check(`${T}: Enter opens the highlighted row's panel`, await panelOpen('PowerShell'));
  check(`${T}: one panel at a time`, (await page.locator('.dd.stat .ap-item.open').count()) === 1);
  check(`${T}: focus lands on the first control`, (await ev(() => document.activeElement && document.activeElement.dataset.f)) === 'eco');
  await key('Tab');
  check(`${T}: Tab moves to Priority`, (await ev(() => document.activeElement && document.activeElement.closest('[data-f]') && document.activeElement.closest('[data-f]').dataset.f)) === 'priority');
  await key('ArrowRight');
  const fv = await ev(() => document.activeElement && document.activeElement.dataset.v);
  await key('Enter');
  await settle(60);
  const kc = await lastCall('apppower.set');
  check(`${T}: Enter on a chip sends it`, kc && kc.key === 'k3' && kc.change.priority === fv, JSON.stringify(kc) + ' focus ' + fv);
  await key('ArrowDown');
  await key('ArrowLeft');
  await settle(260);
  check(`${T}: Left closes the panel`, !(await panelOpen('PowerShell')));
  await key('ArrowRight');
  await settle(260);
  check(`${T}: Right opens it again`, await panelOpen('PowerShell'));
  await key('Escape');
  await key('Escape');
  check(`${T}: a second Esc closes the dropdown`, await ev(() => !window.__topbar.open));
  // a test copy: the panel says changes are only shown
  await ev(() => { window.__apTest = true; });
  await sample();
  await openStat('cpu');
  await item('Quartz').locator('.ap-row').click();
  await settle(260);
  const anyOpen = await page.locator('.dd.stat .ap-item.open .ap-test').count();
  check(`${T}: a test copy's panel says it only shows each change`, anyOpen === 1, anyOpen);
  await ev(() => { window.__apTest = false; });

  /* ---- RAM ---- */
  await sample();
  await openStat('mem');
  await item('Quartz').locator('.ap-row').click();
  await settle(280);
  const mtxt = await item('Quartz').locator('.ap-pc').textContent();
  check(`${T}: RAM panel has its controls and the warning`, ['Lower memory priority', 'Free up memory', 'Memory limit', 'If Quartz needs more, it may close or crash', 'Off', '512 MB', '1 GB', '2 GB', '4 GB', 'Remember for this app'].every((w) => mtxt.includes(w)), mtxt);
  await clearCalls();
  await item('Quartz').locator('.ap-sw[data-f="memLow"]').click();
  await settle(80);
  const ml = await lastCall('apppower.set');
  check(`${T}: Lower memory priority sends set {memLow:true}`, ml && ml.change.memLow === true, JSON.stringify(ml));
  await item('Quartz').locator('.ap-btn[data-f="trim"]').click();
  await settle(100);
  const tr = await lastCall('apppower.trim');
  check(`${T}: Free up memory sends trim {key}`, tr && tr.key === 'k1', JSON.stringify(tr));
  check(`${T}: and shows the answer's words`, (await item('Quartz').locator('.ap-res').textContent()) === 'Freed 412 MB');
  await item('Quartz').locator('[data-f="memCap"] [data-v="1073741824"]').click();
  await settle(80);
  const mc = await lastCall('apppower.set');
  check(`${T}: Memory limit 1 GB sends set {memCap:1073741824}`, mc && mc.change.memCap === 1073741824, JSON.stringify(mc));
  check(`${T}: the row shows RAM marks`, /RAM ↓/.test(await item('Quartz').locator('.ap-m').textContent()) && /RAM 1 GB/.test(await item('Quartz').locator('.ap-m').textContent()));
  await sample();
  await shot('mem');
  await item('Quartz').locator('.ap-lnk[data-f="reset"]').click();
  await settle(80);
  const rs = await lastCall('apppower.reset');
  check(`${T}: Back to normal sends reset {key}`, rs && rs.key === 'k1', JSON.stringify(rs));
  check(`${T}: and the row's marks go`, (await item('Quartz').locator('.ap-mk').count()) === 0);

  /* ---- GPU ---- */
  await sample(['k7', 'k1', 'k5', 'k6', 'k2']);
  await openStat('gpu');
  await item('Rocket League').locator('.ap-row').click();
  await settle(200);
  check(`${T}: a game's row says Mantle never changes it`, (await item('Rocket League').locator('.ap-s').textContent()) === 'Mantle never changes games or anti-cheat' && (await page.locator('.dd.stat .ap-item.open').count()) === 0);
  await item('Quartz').locator('.ap-row').click();
  await settle(280);
  let g = await item('Quartz').evaluate((el) => ({ txt: el.querySelector('.ap-pc').textContent, sw: !!el.querySelector('[data-f="gpuLow"]'), pref: !!el.querySelector('[data-f="gpuPref"]') }));
  check(`${T}: 1 GPU, priority refused: no switch, the reason, no preference, the honest line`, !g.sw && !g.pref && /Lower graphics priority/.test(g.txt) && /Not available here: windows only lets administrators change graphics priority/i.test(g.txt) && g.txt.includes('Windows can’t put a hard limit on graphics use.'), g.txt);
  await item('Quartz').locator('.ap-row').click();
  await settle(260);
  await ev(() => Object.assign(window.__ap.caps, { gpus: 2, gpuLow: true, gpuLowWhy: null, gpuPref: true }));
  await sample(['k7', 'k1', 'k5', 'k6', 'k2']);
  await item('Quartz').locator('.ap-row').click();
  await settle(280);
  g = await item('Quartz').evaluate((el) => ({ txt: el.querySelector('.ap-pc').textContent, sw: !!el.querySelector('[data-f="gpuLow"]'), pref: el.querySelectorAll('[data-f="gpuPref"] [data-v]').length }));
  check(`${T}: 2 GPUs: the switch and the 3 preferences`, g.sw && g.pref === 3 && ['Let Windows decide', 'Power saving', 'High performance'].every((w) => g.txt.includes(w)), JSON.stringify(g));
  await clearCalls();
  await item('Quartz').locator('.ap-sw[data-f="gpuLow"]').click();
  await settle(80);
  const gl = await lastCall('apppower.set');
  check(`${T}: Lower graphics priority sends set {gpuLow:true}`, gl && gl.change.gpuLow === true, JSON.stringify(gl));
  await item('Quartz').locator('[data-f="gpuPref"] [data-v="saving"]').click();
  await settle(80);
  const gp = await lastCall('apppower.set');
  check(`${T}: Power saving sends set {gpuPref:"saving"}`, gp && gp.change.gpuPref === 'saving', JSON.stringify(gp));
  await sample(['k7', 'k1', 'k5', 'k6', 'k2']);
  await shot('gpu');
  const all = await ev(() => document.querySelector('.dd.stat').textContent);
  check(`${T}: no jargon on screen`, !/EcoQoS|job object|working set|\bpid\b|dryRun|priority class|\bQoS\b|\bkey\b/i.test(all), (all.match(/EcoQoS|job object|working set|\bpid\b|dryRun|priority class|\bQoS\b|\bkey\b/i) || [])[0]);
  await ev(() => Object.assign(window.__ap.caps, { gpus: 1, gpuLow: false, gpuLowWhy: 'Windows only lets administrators change graphics priority', gpuPref: false }));

  /* ---- feature off: exactly the old rows ---- */
  await ev(() => { window.__ap.off = true; });
  await sample();
  await openStat('cpu');
  const off = await ev(() => ({ ap: document.querySelectorAll('.dd.stat .ap-list').length, rows: [...document.querySelectorAll('.dd.stat .row2 .n')].map((e) => e.textContent) }));
  check(`${T}: feature off: the old rows, no controls`, off.ap === 0 && off.rows.join('|') === 'quartz (13)|svchost (43)|powershell (3)|MsMpEng|electron (6)', JSON.stringify(off));
  check(`${T}: no page errors`, problems.length === 0, problems.join(' | '));
  await ctx.close();
}

(async () => {
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium);
  try {
    for (const theme of ['light', 'dark']) {
      try { await run(browser, theme); } catch (e) { failures.push(`${theme}: the run threw: ${e.message.split('\n')[0]}`); }
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(`APP POWER DROPDOWN TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
