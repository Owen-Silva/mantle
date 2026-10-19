require('../../tools/dev-env.js').lowcpu();
/* downloads.page.test.js - the Downloads shelf, CLICKED (ui/bar/downloads.js + downloads.css).
 *
 * WHAT: opens the real bar (ui/bar/index.html) over the mock bridge (mock-mantle.js, ?dl=<case>) in
 * headless Chromium through page-harness.js and drives the shelf the way a person does: click the
 * button, click a row, click Show in folder, double-click, the keyboard (Down/Up/Home/End/Enter/Space/
 * Esc), a repaint while a row has the keyboard, every state (empty, missing, unreadable, resting, off,
 * a failed open, a stopped watch, a plainer read, a long name). It asserts on what the page ASKED main
 * to do (window.__MOCK_CALLS__) and on what it shows, never on a picture.
 * WHY: round 2's Downloads increment was held because the page was never rendered or clicked; its
 * helpers were node-tested only (lib/features/downloads.test.js).
 *
 * Run (one test browser; the lane's slot):  bash <lanes>/bin/uislot.sh downloads node ui/bar/downloads.page.test.js
 * ONLY=keys,states  runs just those groups.  SHOTS=<dir>  also saves one PNG per state to look at.
 * Prints "DOWNLOADS PAGE TEST: n passed, m failed"; exits 1 on a failure.
 */
'use strict';
const path = require('path');
const H = require('./page-harness.js');
const t = H.suite('DOWNLOADS PAGE TEST');

/* Words a person must never read on the shelf (BRIEF "The polish bar"). */
const JARGON = /\b(sidecar|hwnd|IPC|renderer|dryRun|AUMID|Electron|E[A-Z]{4,}|HRESULT|0x[0-9a-f]{4,}|undefined|null|NaN|downloads\.[a-z]+|\w+Exception)\b|\[object/;
const SHOTS = process.env.SHOTS || '';

async function run() {
  if (H.gaming()) { console.log('a game is running: the browser half is skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const W = { w: 1280, h: 640 };
    const popOpen = (pg) => pg.eval(() => { const p = document.querySelector('.pop.dl'); return !!p && !p.closest('[hidden]') && p.getBoundingClientRect().height > 0; });
    const panelText = (pg) => pg.eval(() => { const p = document.querySelector('.pop.dl'); return p ? p.innerText : ''; });
    const titles = (pg) => pg.eval(() => Array.prototype.map.call(document.querySelectorAll('.pop.dl [title], #downloads'), (e) => e.title).join('\n'));
    const noJargon = async (pg, what) => {
      const s = (await panelText(pg)) + '\n' + (await titles(pg));
      const m = JARGON.exec(s);
      t.check(what + ': no jargon on screen or in tooltips', !m, m ? m[0] + ' in: ' + s.slice(Math.max(0, m.index - 60), m.index + 60) : '');
    };
    const shot = async (pg, name) => { if (SHOTS) await pg.shot(path.join(SHOTS, 'dl-' + name + '.png')); };
    const openShelf = async (pg) => { await pg.click('#downloads', { wait: 400 }); };

    /* ---------------------------------------------------------------- the list */
    if (t.want('list')) {
      const pg = await open('?mode=pill&dl=new', W);
      t.check('list: the button shows', await pg.visible('#downloads'));
      t.check('list: the button carries the new dot (2 new)', await pg.eval(() => document.getElementById('downloads').classList.contains('new')));
      await openShelf(pg);
      t.check('list: a click opens the shelf', await popOpen(pg));
      t.check('list: it asked for the list once', (await pg.calls('downloads.list')).length === 1, (await pg.calls('downloads.list')).length);
      t.check('list: it marked them seen', (await pg.calls('downloads.seen')).length === 1);
      t.check('list: the dot is gone after opening', await pg.eval(() => !document.getElementById('downloads').classList.contains('new')));
      const n = await pg.count('.pop.dl .dl-row');
      t.check('list: 12 rows drawn', n === 12, n);
      t.check('list: the rows that were new keep their dot while open', await pg.count('.pop.dl .dl-row.fresh') === 2, await pg.count('.pop.dl .dl-row.fresh'));
      t.check('list: every row has a drawn glyph, no <img>', await pg.count('.pop.dl .dl-row .dl-icon svg') === 12 && await pg.count('.pop.dl .dl-row img') === 0);
      const kinds = await pg.eval(() => Array.prototype.map.call(document.querySelectorAll('.pop.dl .dl-icon'), (e) => (/dl-k-(\w+)/.exec(e.className) || [])[1]));
      t.check('list: the glyph matches the type (pdf doc, zip archive, png image, msi app, folder, mp4 video, md doc, xlsx sheet)',
        kinds[0] === 'doc' && kinds[2] === 'archive' && kinds[3] === 'image' && kinds[4] === 'app' && kinds[6] === 'sheet' && kinds[7] === 'folder' && kinds[8] === 'video' && kinds[9] === 'doc', kinds);
      const first = await pg.eval(() => { const r = document.querySelector('.pop.dl .dl-row'); return { label: r.getAttribute('aria-label'), title: r.title, meta: r.querySelector('.dl-meta').textContent }; });
      t.check('list: a row says name, new, kind, size and age to a screen reader', /^Kitchen Remodel - Floor Plan\.pdf, new, Document, 412 KB · 2 min ago$/.test(first.label), first.label);
      t.check('list: a row\'s tooltip is the full name and what a click does', /^Kitchen Remodel - Floor Plan\.pdf\nClick to open, or drag it/.test(first.title), first.title);
      t.check('list: "1 still downloading" shows', /1 still downloading/.test(await panelText(pg)));
      t.check('list: no page errors', pg.errors.length === 0, pg.errors);
      await noJargon(pg, 'list');
      await shot(pg, 'list');

      /* a click opens that row's file, once, and closes the shelf */
      await pg.reset();
      await pg.click('.pop.dl .dl-row:nth-child(2) .dl-name', { wait: 300 });
      const o = await pg.calls('downloads.open');
      t.check('click: a row click asks main to open THAT item', o.length === 1 && o[0].p && o[0].p.item === 'd2', o);
      t.check('click: ... and the shelf closes', !(await popOpen(pg)));
      await pg.close();
    }

    if (t.want('click')) {
      const pg = await open('?mode=pill&dl=some', W);
      await openShelf(pg);
      await pg.reset();
      await pg.page.dblclick('.pop.dl .dl-row:nth-child(3) .dl-name');
      await pg.wait(300);
      const o = await pg.calls('downloads.open');
      t.check('click: a double-click opens it ONCE', o.length === 1, o.length);
      await pg.close();

      const p2 = await open('?mode=pill&dl=some', W);
      await openShelf(p2);
      await p2.reset();
      await p2.page.hover('.pop.dl .dl-row:nth-child(1)');
      t.check('reveal: the folder button shows on hover', await p2.eval(() => getComputedStyle(document.querySelector('.pop.dl .dl-row:nth-child(1) .dl-reveal')).opacity === '1'));
      await p2.click('.pop.dl .dl-row:nth-child(1) .dl-reveal', { wait: 300 });
      const rv = await p2.calls('downloads.reveal');
      t.check('reveal: Show in folder asks main to reveal that item', rv.length === 1 && rv[0].p.item === 'd1', rv);
      t.check('reveal: ... and does NOT also open it', (await p2.calls('downloads.open')).length === 0);
      await p2.close();

      const p3 = await open('?mode=pill&dl=some', W);
      await openShelf(p3);
      await p3.reset();
      await p3.click('.pop.dl .dl-foot button, .pop.dl button.dl-folder', { wait: 300 });
      t.check('folder: "Open Downloads folder" asks main to open it', (await p3.calls('downloads.folder')).length === 1, await p3.calls());
      await p3.close();

      /* the feature's words for Windows' "No application is associated..." (lib/features/downloads.js openWhy) */
      const ofr = "(ch, p) => ch === 'downloads.open' ? { ok: false, reason: 'Windows has no app set for this kind of file. Use Show in folder, then right-click it and choose Open with' } : undefined";
      const p4 = await open('?mode=pill&dl=some', Object.assign({ reply: ofr }, W));
      await openShelf(p4);
      await p4.click('.pop.dl .dl-row:nth-child(1) .dl-name', { wait: 400 });
      const txt = await panelText(p4);
      t.check('openfail: the shelf stays open and says why and what to do, as a sentence', await popOpen(p4) && /Could not open Kitchen Remodel - Floor Plan\.pdf: Windows has no app set for this kind of file\. Use Show in folder, then right-click it and choose Open with\./.test(txt), txt.slice(-300));
      await p4.reset();
      await p4.click('.pop.dl .dl-row:nth-child(1) .dl-name', { wait: 400 });
      t.check('openfail: a second click tries again (not stuck busy)', (await p4.calls('downloads.open')).length === 1, await p4.calls('downloads.open'));
      await noJargon(p4, 'openfail');
      await shot(p4, 'openfail');
      await p4.close();

      const p5 = await open('?mode=pill&dl=test', W);
      await openShelf(p5);
      await p5.click('.pop.dl .dl-row:nth-child(1) .dl-name', { wait: 400 });
      const t5 = await panelText(p5);
      t.check('test run: an open says what it would have done', /would open it with its default app/i.test(t5), t5.slice(0, 300));
      await p5.close();
    }

    /* ---------------------------------------------------------------- the keyboard */
    if (t.want('keys')) {
      const pg = await open('?mode=pill&dl=some', W);
      await openShelf(pg);
      const kb = await pg.calls('qs.keyboard');
      t.check('keys: opening asks main for the keyboard', kb.length === 1 && kb[0].p.on === true, kb);
      const at = () => pg.eval(() => { const a = document.activeElement; const r = a && a.closest && a.closest('.dl-row'); return r ? r.dataset.item + (a.classList.contains('dl-reveal') ? ':reveal' : '') : (a ? a.tagName : null); });
      await pg.key('ArrowDown');
      t.check('keys: the first Down lands on the newest row', await at() === 'd1', await at());
      await pg.key('ArrowDown'); await pg.key('ArrowDown');
      t.check('keys: Down walks the rows', await at() === 'd3', await at());
      await pg.key('ArrowUp');
      t.check('keys: Up walks back', await at() === 'd2', await at());
      await pg.key('End');
      t.check('keys: End = the oldest row', await at() === 'd12', await at());
      const scrolled = await pg.eval(() => document.querySelector('.pop.dl .dl-list, .pop.dl [role=list]').scrollTop);
      t.check('keys: ... scrolled into view', scrolled > 0, scrolled);
      await pg.key('ArrowDown');
      t.check('keys: Down on the last row stays there', await at() === 'd12', await at());
      await pg.key('Home');
      t.check('keys: Home = the newest row', await at() === 'd1', await at());

      /* a repaint (the 30 s tick, a push) keeps the keyboard on the same file */
      await pg.key('ArrowDown'); await pg.key('ArrowDown');
      await pg.eval(() => window.__mockMain.emit('downloads.state', { on: true, ok: true, state: 'ok', reason: null, count: 12, newCount: 0, partial: 0, watching: true, rev: 99 }));
      await pg.wait(300);
      t.check('keys: a repaint keeps the focused row', await at() === 'd3', await at());
      t.check('keys: ... the repaint really re-read', (await pg.calls('downloads.list')).length >= 2, (await pg.calls('downloads.list')).length);

      /* Enter on the Show in folder button reveals, it does not also open */
      await pg.key('Tab');
      t.check('keys: Tab from a row reaches its Show in folder button', await at() === 'd3:reveal', await at());
      await pg.reset();
      await pg.key('Enter', 300);
      t.check('keys: Enter on Show in folder reveals only', (await pg.calls('downloads.reveal')).length === 1 && (await pg.calls('downloads.open')).length === 0, await pg.calls());
      await pg.close();

      const p2 = await open('?mode=pill&dl=some', W);
      await openShelf(p2);
      await p2.key('ArrowDown'); await p2.key('ArrowDown');
      await p2.reset();
      await p2.key('Enter', 300);
      const o = await p2.calls('downloads.open');
      t.check('keys: Enter opens the focused row', o.length === 1 && o[0].p.item === 'd2', o);
      t.check('keys: ... and hands the keyboard back', (await p2.calls('qs.keyboard')).some((c) => c.p && c.p.on === false), await p2.calls('qs.keyboard'));
      await p2.close();

      const p3 = await open('?mode=pill&dl=some', W);
      await openShelf(p3);
      await p3.key('ArrowDown');
      await p3.reset();
      await p3.key(' ', 300);
      t.check('keys: Space opens the focused row too', (await p3.calls('downloads.open')).length === 1);
      await p3.close();

      const p4 = await open('?mode=pill&dl=some', W);
      await openShelf(p4);
      await p4.reset();
      await p4.key('Escape', 300);
      t.check('keys: Esc closes the shelf', !(await popOpen(p4)));
      t.check('keys: ... and hands the keyboard back', (await p4.calls('qs.keyboard')).some((c) => c.p && c.p.on === false), await p4.calls('qs.keyboard'));
      await p4.close();

      /* refused (a test instance, another window kept focus): the mouse still works and the list says why */
      const p5 = await open('?mode=pill&dl=some', Object.assign({ reply: "(ch, p) => ch === 'qs.keyboard' && p && p.on ? { ok: false, reason: 'Windows kept the keyboard on another window, so a password cannot be typed here' } : undefined" }, W));
      await openShelf(p5);
      const lt = await p5.eval(() => document.querySelector('.pop.dl .dl-list, .pop.dl [role=list]').title);
      t.check('keys refused: the list says why the arrows do not work', /^Arrow keys do not reach this panel: Windows kept the keyboard on another window$/.test(lt), lt);
      await p5.reset();
      await p5.key('Escape', 300);
      t.check('keys refused: nothing to hand back', (await p5.calls('qs.keyboard')).length === 0, await p5.calls('qs.keyboard'));
      await p5.close();
    }

    /* ---------------------------------------------------------------- every state */
    if (t.want('states')) {
      const pg = await open('?mode=pill&dl=none', W);
      await openShelf(pg);
      t.check('empty: says nothing downloaded yet', /Nothing downloaded yet/.test(await panelText(pg)), await panelText(pg));
      await noJargon(pg, 'empty');
      await shot(pg, 'empty');
      await pg.close();

      const reply = "(ch, p) => ch === 'downloads.list' ? { ok: false, state: 'missing', reason: 'the Downloads folder does not exist (it was moved, renamed or deleted)', folder: 'C:\\\\Users\\\\someone\\\\Downloads', items: [], total: 0, newCount: 0, partial: 0, rev: 1, retryMs: 120000 } : undefined";
      const p2 = await open('?mode=pill&dl=missing', Object.assign({ reply }, W));
      t.check('missing: the button is muted', await p2.eval(() => document.getElementById('downloads').classList.contains('off')));
      await openShelf(p2);
      const t2 = await panelText(p2);
      t.check('missing: a plain heading, then only the why (not the same fact twice), as a sentence', /Your Downloads folder is missing\s+It was moved, renamed or deleted\.\s/.test(t2) && !/does not exist/.test(t2), t2);
      t.check('missing: says what happens next', /Mantle looks again every 2 minutes and each time you open this panel\./.test(t2), t2);
      t.check('missing: "Open Downloads folder" is off, looks off, and says why', await p2.eval(() => { const b = document.querySelector('.pop.dl .dl-foot button, .pop.dl button.dl-folder'); return b.disabled && /no Downloads folder to open/.test(b.title) && Number(getComputedStyle(b).opacity) < 1; }));
      await noJargon(p2, 'missing');
      await shot(p2, 'missing');
      await p2.close();

      const p3 = await open('?mode=pill&dl=unreadable', W);
      await openShelf(p3);
      t.check('unreadable: its own heading', /Mantle cannot read your Downloads folder/.test(await panelText(p3)), await panelText(p3));
      await noJargon(p3, 'unreadable');
      await p3.close();

      const p4 = await open('?mode=pill&dl=off', W);
      t.check('off: the button is hidden', !(await p4.visible('#downloads')));
      await p4.close();

      const p5 = await open('?mode=pill&dl=rest', W);
      await p5.click('#downloads', { wait: 400 });
      const t5 = await panelText(p5);
      t.check('resting: the shelf opens and says it is paused', /Paused while you play|resting/i.test(t5 + (await p5.eval(() => document.getElementById('downloads').title))), t5);
      t.check('resting: no page errors', p5.errors.filter((e) => !/resting while/.test(e)).length === 0, p5.errors);
      await p5.close();

      const wr = "(ch, p) => ch === 'downloads.list' ? { ok: true, state: 'ok', reason: null, folder: 'C:\\\\x', items: [], total: 0, newCount: 0, partial: 0, rev: 1, watching: false, watchReason: 'new downloads show up when you open this panel, not the moment they finish', detail: 'Showing a simpler list for now, so hidden files may appear.' } : undefined";
      const p6 = await open('?mode=pill&dl=some', Object.assign({ reply: wr }, W));
      await openShelf(p6);
      const t6 = await panelText(p6);
      t.check('unwatched + plain read: both said in plain words', /Showing a simpler list for now, so hidden files may appear\. New downloads show up when you open this panel, not the moment they finish\./.test(t6), t6);
      await noJargon(p6, 'unwatched');
      await p6.close();

      /* a long name: cut with an ellipsis in the row, full on hover */
      const long = 'A very long file name that keeps going well past the width of the Downloads shelf - final version (3).pdf';
      const lr = "(ch, p) => ch === 'downloads.list' ? { ok: true, state: 'ok', reason: null, folder: 'C:\\\\x', items: [{ item: 'L1', name: " + JSON.stringify(long) + ", size: 1234567, at: Date.now() - 60000 }, { item: 'L2', name: 'b\\u202Egnp.exe', size: 10, at: Date.now() - 120000 }], total: 2, newCount: 0, partial: 0, rev: 1, watching: true } : undefined";
      const p7 = await open('?mode=pill&dl=some', Object.assign({ reply: lr }, W));
      await openShelf(p7);
      const lg = await p7.eval(() => { const r = document.querySelector('.pop.dl .dl-row'); const n = r.querySelector('.dl-name'); return { cut: n.scrollWidth > n.clientWidth, ell: getComputedStyle(n).textOverflow, title: r.title.split('\n')[0], rowW: r.getBoundingClientRect().width, popW: document.querySelector('.pop.dl').getBoundingClientRect().width }; });
      t.check('long name: ellipsized in the row', lg.cut && lg.ell === 'ellipsis', lg);
      t.check('long name: the full name on hover', lg.title === long, lg.title);
      t.check('long name: the row stays inside the panel', lg.rowW <= lg.popW, lg);
      const bidi = await p7.eval(() => document.querySelectorAll('.pop.dl .dl-name')[1].textContent);
      t.check('bidi override stripped from a name (no "exe.png" trick)', bidi === 'bgnp.exe', JSON.stringify(bidi));
      await shot(p7, 'long');
      await p7.close();
    }
  });
}

run().catch((e) => t.check('the test itself threw', false, (e && e.stack) || String(e))).then(() => t.done());
