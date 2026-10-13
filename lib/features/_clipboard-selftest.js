'use strict';
/*
 * _clipboard-selftest.js - the clipboard feature proving itself inside an Electron --test instance
 * (MANTLE_CLIP_SELFTEST=1; loaded only by lib/features/clipboard.js, and only in --test).
 *
 * WHAT IT DRIVES: Win+V through ctx.test.fireChord (routed exactly like the hook would), the real
 * passive sidecar, and the real page, whose keyboard handler is fed KeyboardEvents INSIDE the page
 * (no OS input anywhere). Every paste is the feature's dry run.
 *
 * WHAT IT TOUCHES: nothing of Owen's. The items are this file's own fixtures (clip.seed, which only
 * a passive sidecar takes); the test sidecar was started with listen:false, so none of his copies
 * are even counted; his clipboard is never written; the panel is shown inactive and never focused;
 * the foreground window's HANDLE is read before and after (never its title) and the run fails if it
 * changed.
 *
 * Results: one line in mantle.log and %TEMP%\mantle-clipboard\selftest.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'mantle-clipboard', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let halt = false;

function start(k) {
  const { ctx, S, list, gate, hide, kbVerdict } = k;
  (async () => {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });
    const t0 = Date.now();
    while (!halt && Date.now() - t0 < 20000 && !(ctx.sidecar.ready && S.pageOk)) await sleep(100);
    if (halt) return;
    await sleep(800);   // the feature's own clip.start (onReady) settles first
    const page = (js) => S.win.webContents.executeJavaScript(js, true);
    const key = (k2) => page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k2)}, bubbles: true })); 1`);
    const waitFor = async (fn, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (await fn()) return true; await sleep(40); } return false; };
    try {
      const fgBefore = (await ctx.sidecar.send('clip.arm', {})).result;
      const seeded = await ctx.sidecar.send('clip.seed', { reset: true, items: [
        { kind: 'text', text: 'selftest line one\nline two' },
        { kind: 'image', w: 120, h: 80, color: '#4436E8', agoMs: 60000 },
        { kind: 'files', paths: ['C:\\selftest\\a.txt', 'C:\\selftest\\b'], agoMs: 120000 },
        { kind: 'text', text: 'selftest html', html: '<b>selftest html</b>', agoMs: 180000 },
      ] });
      check('seed', seeded.ok, seeded.error);

      // 1. Win+V opens the panel with the four items
      const fired = ctx.test.fireChord('Win+V');
      check('fireChord Win+V delivered', fired && fired.delivered, fired);
      const opened = await waitFor(async () => S.open && S.win.isVisible(), 3000);
      check('panel open and visible', opened, { open: S.open });
      const shown = await page('window.__clip.shown.length');
      check('page shows 4 items', shown === 4, shown);
      check('page reported painted', S.painted && S.painted.count === 4, S.painted);
      check('opened within 300 ms', S.lastOpen && S.lastOpen.ms < 300, S.lastOpen && S.lastOpen.ms);
      const b = S.win.getBounds();
      const w = S.lastOpen && S.lastOpen.work;
      check('panel inside the work area', w && b.x + 18 >= w.x && b.y + 18 >= w.y &&
        b.x + b.width - 18 <= w.x + w.width && b.y + b.height - 18 <= w.y + w.height, { b, w });
      check('panel NOT focused (test)', !S.win.isFocused());
      // the real page, rendered by Electron, showing this file's fixtures only
      try {
        const img = await S.win.webContents.capturePage();
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(OUT), 'e2e-panel.png'), img.toPNG());
      } catch (e) { check('capture the panel', false, e.message); }

      // 2. ArrowDown twice + Enter = dry-run paste of the files item into the armed window
      await key('ArrowDown'); await key('ArrowDown');
      const selKind = await page('window.__clip.shown[window.__clip.sel].kind');
      check('selection on the files item', selKind === 'files', selKind);
      await key('Enter');
      const pasted = await waitFor(async () => !!S.lastPaste, 3000);
      check('Enter pasted', pasted);
      const lp = S.lastPaste || {};
      check('paste was a DRY RUN', lp.dryRun === true);
      check('dry run ok, round trip', lp.ok && lp.roundTrip === true, lp);
      check('files formats', lp.formats.includes('CF_HDROP') && lp.formats.includes('Preferred DropEffect'), lp.formats);
      check('target = the window Win+V was pressed over', lp.target === (fgBefore && fgBefore.hwnd), { t: lp.target, fg: fgBefore && fgBefore.hwnd });
      check('panel hidden after paste', !S.open && !S.win.isVisible());

      // 3. again: P pins the top item, Del deletes the next, Esc closes
      S.lastPaste = null;
      ctx.test.fireChord('Win+V');
      await waitFor(async () => S.open, 3000);
      await key('p');
      await waitFor(async () => (await list()).pinned === 1, 2000);
      let l = await list();
      check('P pinned the top item', l.pinned === 1 && l.items[0].pinned, l.pinned);
      await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown'); await key('Delete');   // the html item (keep the image for step 5)
      await waitFor(async () => (await list()).count === 3, 2000);
      l = await list();
      check('Del deleted one', l.count === 3, l.count);
      await key('Escape');
      await waitFor(async () => !S.open, 2000);
      check('Esc closed', !S.open && !S.win.isVisible());
      check('no paste on Esc', S.lastPaste === null);

      // 4. Win+V toggles: open, then Win+V again closes
      ctx.test.fireChord('Win+V');
      await waitFor(async () => S.open, 3000);
      ctx.test.fireChord('Win+V');
      await waitFor(async () => !S.open, 2000);
      check('Win+V again closes', !S.open);

      // 4b. (audit #14) a second Win+V while it is still opening cancels it: it never appears
      const c0 = S.cancelled;
      ctx.test.fireChord('Win+V');
      ctx.test.fireChord('Win+V');
      await sleep(1500);
      check('Win+V twice while opening: stays closed', !S.open && !S.win.isVisible() && gate.state === 'hidden', { open: S.open, visible: S.win.isVisible(), state: gate.state });
      check('Win+V twice while opening: the first open was cancelled, not shown', S.cancelled === c0 + 1, S.cancelled - c0);
      // 4c. Esc while it is still opening: it never appears afterwards
      ctx.test.fireChord('Win+V');
      await sleep(20);
      const wasOpening = gate.state === 'opening';
      hide('esc');
      await sleep(1500);
      check('Esc while opening: never appears', wasOpening && !S.open && !S.win.isVisible(), { wasOpening, open: S.open });
      // 4d. then the next Win+V opens normally (nothing left stuck)
      ctx.test.fireChord('Win+V');
      check('Win+V after a cancel opens', await waitFor(async () => S.open && S.win.isVisible(), 3000), gate.state);
      // 4e. (audit #7) shown WITHOUT the keyboard: the panel says why in words, and Esc still closes it
      let escDown = false;
      kbVerdict({ ok: false, reason: 'Windows kept the keyboard on the app in front' }, { down: (vk) => vk === 0x1B && escDown });
      const said = await waitFor(async () => page("document.body.classList.contains('noting') && document.getElementById('noteTitle').textContent === 'No keyboard'"), 1500);
      const text = await page("document.getElementById('noteText').textContent");
      check('no keyboard: the panel says so, in words', said && /click here to type/i.test(text) && /Esc/.test(text) && !/undefined|null|0x|sidecar/i.test(text), text);
      check('no keyboard: the watch runs', !!S.kbWatch && S.kb.ok === false, S.kb);
      escDown = true;
      await waitFor(async () => !S.open, 1500);
      check('no keyboard: Esc closed it', !S.open && !S.win.isVisible() && !S.kbWatch);
      check('no keyboard: the line went with it', !(await page("document.body.classList.contains('noting')")));
      // 4f. it got the keyboard after all (a click in it): the line goes
      ctx.test.fireChord('Win+V');
      await waitFor(async () => S.open, 3000);
      kbVerdict({ ok: false, reason: 'Windows kept the keyboard on the app in front' }, { down: () => false });
      await waitFor(async () => page("document.body.classList.contains('noting')"), 1500);
      kbVerdict({ ok: true, how: 'click' });
      const gone = await waitFor(async () => !(await page("document.body.classList.contains('noting')")), 1500);
      check('keyboard arrived: the line goes, the watch stops', gone && !S.kbWatch && S.kb.ok === true);
      hide('esc');
      await waitFor(async () => !S.open, 1500);

      // 5. image dry run through the command path (formats PNG + CF_DIB)
      l = await list();
      const img = l.items.find((i) => i.kind === 'image');
      S.arm = { hwnd: '0' };
      const r = img ? await ctx.sidecar.send('clip.paste', { item: img.id, hwnd: '0', dryRun: true }) : { ok: false };
      check('image dry run: PNG + CF_DIB, round trip', r.ok && r.result.roundTrip &&
        r.result.formats.map((f) => f.name).join() === 'PNG,CF_DIB', r.ok ? r.result.formats : r.error);

      // 6. the real paste is refused by the passive sidecar
      const real = await ctx.sidecar.send('clip.paste', { item: l.items[0].id, hwnd: '0' });
      check('real paste refused (passive)', !real.ok && /passive/.test(real.error), real.error);

      const fgAfter = (await ctx.sidecar.send('clip.arm', {})).result;
      check('foreground window unchanged', fgBefore && fgAfter && fgBefore.hwnd === fgAfter.hwnd, { before: fgBefore && fgBefore.hwnd, after: fgAfter && fgAfter.hwnd });
    } catch (e) {
      check('selftest ran', false, e.message);
    }
    const passed = checks.filter((c) => c.ok).length;
    const failed = checks.length - passed;
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, failed, checks, lastOpen: S.lastOpen }, null, 1));
    } catch (e) { /* the log line still says it */ }
    ctx.log(`selftest: ${passed} passed, ${failed} failed${failed ? ' (' + checks.filter((c) => !c.ok).map((c) => c.name).join('; ') + ')' : ''}`);
  })();
}

module.exports = { start, stop() { halt = true; } };
