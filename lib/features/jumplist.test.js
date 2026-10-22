'use strict';
// jumplist.test.js - Mantle's own pin overlay (_jumplist-pins.js) and the jumplist feature's
// commands with a fake ctx (lane jumplist, 2026-09-24). Plain node: `node lib/features/jumplist.test.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('./_jumplist-pins');
const feature = require('./jumplist');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
}

// ---- the overlay model
const chrome = { id: 'google chrome.lnk', name: 'Google Chrome', kind: 'pinned', exe: 'c:\\program files\\google\\chrome\\application\\chrome.exe', aumid: 'chrome' };
const browser = { id: 'running:x', name: 'Browser', kind: 'running', exe: 'c:\\users\\o\\browser\\electron.exe', aumid: null, shortcut: 'C:\\Users\\o\\Start Menu\\Browser.lnk' };
const player = { id: 'running:y', name: 'Contoso Player', kind: 'running', exe: 'c:\\program files\\windowsapps\\player\\a.exe', aumid: 'contoso.player_abc123xyz!app' };

let o = own.empty();
let r = own.unpin(o, chrome);
check('unpinning a Windows pin HIDES it', r.did === 'hid' && r.overlay.hide.length === 1 && r.overlay.add.length === 0, JSON.stringify(r));
check('the input overlay is not mutated', o.hide.length === 0);
r = own.unpin(r.overlay, chrome);
check('unpinning it twice is "already"', r.did === 'already' && r.overlay.hide.length === 1);
r = own.pin(r.overlay, Object.assign({}, chrome, { id: 'running:chrome', kind: 'running' }));
check('pinning the same app again (now a running item) UNHIDES the Windows pin', r.did === 'unhid' && r.overlay.hide.length === 0 && r.overlay.add.length === 0, JSON.stringify(r));
r = own.pin(own.empty(), browser);
check('pinning a running app ADDS a Mantle pin', r.did === 'added' && r.overlay.add.length === 1 && r.overlay.add[0].id === 'mantle:' + browser.exe, JSON.stringify(r.overlay));
const withBrowser = r.overlay;
r = own.pin(withBrowser, browser);
check('pinning it twice is "already"', r.did === 'already' && r.overlay.add.length === 1);
r = own.unpin(withBrowser, { id: 'mantle:' + browser.exe, name: 'Browser', exe: browser.exe });
check('unpinning a Mantle pin REMOVES it (no hide entry)', r.did === 'removed' && r.overlay.add.length === 0 && r.overlay.hide.length === 0, JSON.stringify(r.overlay));
let threw = null;
try { own.pin(own.empty(), { id: 'running:z', name: 'Mystery' }); } catch (e) { threw = e.message; }
check('pinning something with no exe, aumid or shortcut throws in words', /cannot be pinned/.test(threw || ''), threw);

// ---- apply
const winPins = [
  { id: 'google chrome.lnk', name: 'Google Chrome', exe: chrome.exe, aumid: null, order: 0 },
  { id: 'app:calc!app', name: 'Calculator', exe: null, aumid: 'calc!app', order: 1 },
];
let ov = own.unpin(own.empty(), chrome).overlay;
ov = own.pin(ov, browser).overlay;
ov = own.pin(ov, player).overlay;
let out = own.apply(winPins, ov);
check('apply: the hidden pin is gone', !out.some((p) => p.id === 'google chrome.lnk'), out.map((p) => p.id).join());
check('apply: Mantle pins come last, in pin order', out.length === 3 && out[1].id === 'mantle:' + browser.exe && out[2].id === 'mantle:' + player.aumid, out.map((p) => p.id).join());
check('apply: a Mantle pin starts from the shortcut Windows would use', out[1].lnkPath === browser.shortcut && out[1].target === browser.shortcut);
check('apply: a Store app pin starts from its AUMID (no exe target)', out[2].lnkPath === null && out[2].target === null && out[2].aumid === player.aumid);
check('apply: orders stay dense after the Windows pins', out[1].order === 2 && out[2].order === 3, out.map((p) => p.order).join());
out = own.apply(winPins.concat([{ id: 'browser.lnk', name: 'Browser', exe: browser.exe, order: 2 }]), own.pin(own.empty(), browser).overlay);
check('apply: never twice for an app Windows already pins', out.filter((p) => own.sameApp(p, browser)).length === 1, out.map((p) => p.id).join());
check('apply: a malformed overlay is ignored, not fatal', own.apply(winPins, { hide: [null, 3, { name: 'no id' }], add: 'x' }).length === 2);

// ---- read (a temp userData, never the user's)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-jumplist-test-'));
check('read: no file = empty overlay', JSON.stringify(own.read(tmp)) === JSON.stringify(own.empty()));
fs.mkdirSync(path.join(tmp, 'features'));
fs.writeFileSync(own.fileFor(tmp), JSON.stringify({ pins: ov }));
check('read: what ctx.settings wrote comes back', own.read(tmp).add.length === 2 && own.read(tmp).hide.length === 1);
fs.writeFileSync(own.fileFor(tmp), '{nope');
threw = null;
try { own.read(tmp); } catch (e) { threw = e.message; }
check('read: bad JSON throws a reason (main.js shows it)', /not valid JSON/.test(threw || ''), threw);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- targetOf
const T = feature._internals.targetOf;
check('targetOf: a running app goes by its window', T({ id: 'x', hwnds: ['123', '456'], exe: 'c:\\a.exe' }).hwnd === '123');
check('targetOf: a Store pin with no window goes by its AUMID', T({ id: 'app:calc!app', aumid: 'calc!app', hwnds: [] }).app === 'calc!app');
check('targetOf: a path in the id is never trusted as a pin file', T({ id: '..\\..\\evil.lnk', exe: 'c:\\a.exe' }).lnk === undefined);
threw = null;
try { T({ id: 'x', name: 'Nothing' }); } catch (e) { threw = e.message; }
check('targetOf: nothing to go by throws in words', /does not know which program/.test(threw || ''), threw);

// ---- the feature with a fake ctx: --test makes every action a dry run
(async () => {
  function fakeCtx(testMode) {
    const cmds = {}, logs = [], sent = [];
    const store = {};
    const ctx = {
      flags: { test: testMode, live: !testMode },
      log: (t) => logs.push(t),
      health: () => {},
      enabled: () => ctx._on,
      _on: true,
      command: (verb, fn) => { cmds[verb] = fn; return 'jumplist.' + verb; },
      settings: { get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: (k, v) => { store[k] = v; return v; } },
      sidecar: {
        send: async (cmd, args) => {
          sent.push({ cmd, args });
          if (cmd === 'jumplist.get') return { ok: true, result: { ok: true, appid: 'A', sections: [], none: "this app doesn't publish one" } };
          if (cmd === 'jumplist.open' || cmd === 'jumplist.remove') return args.dry ? { ok: true, result: { dryRun: true, route: 'link default command' } } : { ok: true, result: { route: 'link default command' } };
          if (cmd === 'jumplist.shortcut') return { ok: true, result: { shortcut: 'C:\\s.lnk' } };
          if (cmd === 'close') return { ok: true, result: {} };
          return { ok: false, error: 'unknown command' };
        },
      },
    };
    return { ctx, cmds, logs, sent, store };
  }
  const app = { id: 'running:x', name: 'Thing', kind: 'running', exe: 'c:\\t.exe', hwnds: ['77'] };
  let f = fakeCtx(true);
  feature.install(f.ctx);
  let g = await f.cmds.get({ app });
  check('get passes the sidecar reply through', g.ok === true && g.none && typeof g.mainMs === 'number', JSON.stringify(g));
  const o1 = await f.cmds.open({ app, item: 'c:0:0', title: 'New window' });
  check('--test: open is a DRY run (dry:true to the sidecar) with a log line', o1.dryRun === true && f.sent.some((s) => s.cmd === 'jumplist.open' && s.args.dry === true) && f.logs.some((l) => /dry run/.test(l)), JSON.stringify(o1));
  check('--test: the log line never carries the item title', !f.logs.some((l) => /New window/.test(l)), f.logs.join(' | '));
  const c1 = await f.cmds.close({ hwnds: ['77', '78'] });
  check('--test: close sends NO WM_CLOSE', c1.dryRun === true && !f.sent.some((s) => s.cmd === 'close'), JSON.stringify(c1));
  const p1 = await f.cmds.pin({ app, pin: true });
  check('--test: pin writes nothing', p1.dryRun === true && !('pins' in f.store), JSON.stringify(p1));
  f.ctx._on = false;
  g = await f.cmds.get({ app });
  check('switched off in the tray: get says so (the bar falls back to the window list)', g.ok === false && g.off === true, JSON.stringify(g));

  f = fakeCtx(false);
  feature.install(f.ctx);
  const c2 = await f.cmds.close({ hwnds: ['77', '78'] });
  check('live: close sends one WM_CLOSE per window', c2.ok && f.sent.filter((s) => s.cmd === 'close').length === 2, JSON.stringify(c2));
  const o2 = await f.cmds.open({ app, item: 'app' });
  check('live: "new window" goes to the sidecar for real', o2.ok && f.sent.some((s) => s.cmd === 'jumplist.open' && !s.args.dry && s.args.item === 'app'));
  const p2 = await f.cmds.pin({ app, pin: true });
  check('live: pin stores Mantle\'s own overlay with the shortcut', p2.did === 'added' && f.store.pins.add[0].shortcut === 'C:\\s.lnk', JSON.stringify(f.store));
  const p3 = await f.cmds.pin({ app: { id: 'mantle:c:\\t.exe', name: 'Thing', exe: 'c:\\t.exe' }, pin: false });
  check('live: unpin removes it again', p3.did === 'removed' && f.store.pins.add.length === 0, JSON.stringify(f.store));

  // ---- Mantle Files (lane barfiles, 2026-09-29): File Explorer's list, folders open in Mantle Files
  {
    const EventEmitter = require('events');
    const EL = 'c:\\users\\o\\mantle\\node_modules\\electron\\dist\\electron.exe';
    const filesApp = { id: 'mantle:mantle.files', name: 'Mantle Files', kind: 'pinned', exe: EL, aumid: 'mantle.files', hwnds: ['55'] };
    const T = feature._internals.targetOf;
    check('files: its menu reads File Explorer\'s jump list, even with a Files window open', JSON.stringify(T(filesApp)) === JSON.stringify({ app: 'Microsoft.Windows.Explorer' }), JSON.stringify(T(filesApp)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-files-'));
    const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'x');
    const fo = feature._internals.folderOf;
    check('files: folderOf takes an existing folder', (await fo(dir)) === dir);
    check('files: folderOf refuses a file, a shell item, a relative path and nothing',
      (await fo(file)) === null && (await fo('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')) === null && (await fo('rel\\x')) === null && (await fo(null)) === null);
    check('files: folderOf refuses a folder that is gone', (await fo(path.join(dir, 'gone'))) === null);

    const wire = (testMode, on) => {
      const w = fakeCtx(testMode);
      const eapp = new EventEmitter();
      const opened = [];
      if (on) eapp.on('mantle-open:files', (o) => { opened.push(o.path); if (o.reply) { o.reply.handled = true; o.reply.ok = true; } });
      w.ctx.electronApp = eapp;
      feature.install(w.ctx);
      return Object.assign(w, { opened, eapp });
    };
    let w = wire(false, true);
    let r = await w.cmds.open({ app: filesApp, item: 'a:3', title: 'Projects', tip: dir });
    check('files live: a folder opens in Mantle Files, not through the sidecar', r.ok && r.route === 'Mantle Files' && w.opened[0] === dir && !w.sent.some((s) => s.cmd === 'jumplist.open'), JSON.stringify(r));
    check('files live: the log line carries no path or title', !w.logs.some((l) => l.includes(dir) || /Projects/.test(l)), w.logs.join(' | '));
    r = await w.cmds.open({ app: filesApp, item: 'a:4', title: 'a.txt', tip: file });
    check('files live: a FILE still opens through the sidecar (its own app)', r.ok && w.opened.length === 1 && w.sent.some((s) => s.cmd === 'jumplist.open' && s.args.item === 'a:4'), JSON.stringify(r));
    r = await w.cmds.open({ app, item: 'a:5', title: 'x', tip: dir });
    check('files live: another app\'s folder item is not taken over', w.opened.length === 1 && w.sent.some((s) => s.cmd === 'jumplist.open' && s.args.item === 'a:5'), JSON.stringify(r));
    w = wire(false, false);
    r = await w.cmds.open({ app: filesApp, item: 'a:3', title: 'Projects', tip: dir });
    check('files OFF (no listener): the folder goes to the sidecar as before', r.ok && w.opened.length === 0 && w.sent.some((s) => s.cmd === 'jumplist.open' && s.args.app === 'Microsoft.Windows.Explorer'), JSON.stringify(r));
    w = wire(false, true);
    w.eapp.removeAllListeners('mantle-open:files');
    w.eapp.on('mantle-open:files', (o) => { o.reply.handled = true; o.reply.ok = false; o.reply.reason = 'Mantle Files is stopped'; });
    r = await w.cmds.open({ app: filesApp, item: 'a:3', title: 'Projects', tip: dir });
    check('files: a refusal from Mantle Files is said, never swallowed', r.ok === false && /Mantle Files is stopped/.test(r.reason), JSON.stringify(r));
    w = wire(true, true);
    r = await w.cmds.open({ app: filesApp, item: 'a:3', title: 'Projects', tip: dir });
    check('files --test: a dry run, nothing opened', r.dryRun === true && r.route === 'Mantle Files' && w.opened.length === 0, JSON.stringify(r));
    w = wire(false, true);
    r = await w.cmds.pin({ app: Object.assign({}, filesApp, { id: 'running:mantle.files', kind: 'running' }), pin: true });
    check('files: pinning Mantle Files stores its AUMID and NO shortcut (Explorer\'s is not its own)', r.did === 'added' && w.store.pins.add[0].aumid === 'mantle.files' && w.store.pins.add[0].shortcut === null && !w.sent.some((s) => s.cmd === 'jumplist.shortcut'), JSON.stringify(w.store));
    fs.rmSync(dir, { recursive: true, force: true });

    // two Mantle apps share electron.exe: different AUMIDs are different apps
    const tm = { id: 'running:mantle.taskmanager', name: 'Mantle Task Manager', kind: 'running', exe: EL, aumid: 'mantle.taskmanager' };
    let ovm = own.pin(own.empty(), filesApp).overlay;
    const rt = own.pin(ovm, tm);
    check('overlay: with Mantle Files pinned, Mantle Task Manager still pins (was "already": same electron.exe)', rt.did === 'added' && rt.overlay.add.length === 2, JSON.stringify(rt));
    const ru = own.unpin(rt.overlay, { id: 'running:mantle.taskmanager', exe: EL, aumid: 'mantle.taskmanager' });
    check('overlay: unpinning one leaves the other', ru.did === 'removed' && ru.overlay.add.length === 1 && ru.overlay.add[0].aumid === 'mantle.files', JSON.stringify(ru.overlay));
    const ap = own.apply([{ id: 'quartz.lnk', name: 'Quartz', exe: EL, aumid: 'quartz', order: 0 }], ovm);
    check('overlay: a Windows pin of another app on the same exe does not swallow the Mantle Files pin', ap.length === 2 && ap[1].aumid === 'mantle.files', ap.map((p) => p.id).join());
  }

  // ---- the page's keep-on-top request carries the window's pid when the bar has it (security review #19)
  {
    const vm = require('vm');
    const sandbox = { window: {}, document: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'bar', 'jumplist.js'), 'utf8'), sandbox);
    const ot = sandbox.window.MantleJumpList && sandbox.window.MantleJumpList._otArgs;
    check('page: the jump list exposes its keep-on-top request builder', typeof ot === 'function');
    if (ot) {
      const wins = [{ hwnd: '100', pid: 4242 }, { hwnd: '200' }];
      const a1 = ot(wins, '100', true, 'Notepad');
      check('page: keep on top sends hwnd + the window\'s pid', a1.hwnd === '100' && a1.pid === 4242 && a1.on === true && a1.name === 'Notepad', JSON.stringify(a1));
      const a2 = ot(wins, '200', false, '');
      check('page: no pid known -> none sent (main then checks nothing extra)', a2.hwnd === '200' && !('pid' in a2) && a2.on === false, JSON.stringify(a2));
      const a3 = ot(wins, 300, true);
      check('page: an hwnd the list does not have -> no pid, never another window\'s', a3.hwnd === '300' && !('pid' in a3), JSON.stringify(a3));
    }
  }

  /* ---- quality pass 2026-09-29: UNDO of an unpin puts the app back in its place (each of these
     failed before: there was no undoUnpin, and a re-pin went to the end of the bar) */
  {
    const A = { id: 'a.lnk', name: 'A', exe: 'c:\\a.exe' }, B = { id: 'b.lnk', name: 'B', exe: 'c:\\b.exe' };
    const M = { id: 'running:m', name: 'M', exe: 'c:\\m.exe', aumid: null };
    let ov = own.pin(own.empty(), M).overlay;                                   // a Mantle pin
    ov = own.pin(ov, { id: 'running:n', name: 'N', exe: 'c:\\n.exe' }).overlay; // and a second one after it
    ov = own.setOrder(ov, ['b.lnk', 'mantle:c:\\m.exe', 'a.lnk', 'mantle:c:\\n.exe']);
    const before = ov;
    const un = own.unpin(ov, Object.assign({}, M, { id: 'mantle:c:\\m.exe' }));
    check('undo: the unpin itself drops the Mantle pin and its place', un.did === 'removed' && !un.overlay.order.includes('mantle:c:\\m.exe'), JSON.stringify(un.overlay));
    const back = own.undoUnpin(un.overlay, before, Object.assign({}, M, { id: 'mantle:c:\\m.exe' }));
    check('undo: a Mantle pin comes back at its old place among Mantle pins AND in the dragged order',
      back.did === 'restored' && back.overlay.add[0].id === 'mantle:c:\\m.exe' && back.overlay.order.join('|') === before.order.join('|'), JSON.stringify(back.overlay));
    const hid = own.unpin(before, A);
    const later = own.setOrder(hid.overlay, ['mantle:c:\\n.exe', 'b.lnk', 'mantle:c:\\m.exe']);   // a drag AFTER the unpin
    const back2 = own.undoUnpin(later, before, A);
    check('undo: a hidden Windows pin is shown again and slots in after the id it followed',
      !back2.overlay.hide.length && back2.overlay.order.join('|') === 'mantle:c:\\n.exe|b.lnk|mantle:c:\\m.exe|a.lnk', JSON.stringify(back2.overlay.order));
    const pre = own.unpin(own.empty(), B).overlay;                                // B hidden BEFORE
    const back3 = own.undoUnpin(own.unpin(pre, A).overlay, pre, A);
    check('undo: a pin that was hidden before the unpin stays hidden', back3.overlay.hide.length === 1 && back3.overlay.hide[0].id === 'b.lnk', JSON.stringify(back3.overlay.hide));
  }

  /* ---- quality pass 2026-09-29: arguments that reach the sidecar / ShellExecute are checked, and
     the menu gets plain words (each failed before: all of these were sent on as they came) */
  {
    const f3 = fakeCtx(false);
    feature.install(f3.ctx);
    const bad = [
      ['a URL as the program', { app: { id: 'x', name: 'X', exe: 'https://evil.example/x.exe' }, item: 'app' }],
      ['a UNC program path', { app: { id: 'x', name: 'X', exe: '\\\\server\\share\\x.exe' }, item: 'app' }],
      ['shell: as the program', { app: { id: 'x', name: 'X', exe: 'shell:startup' }, item: 'app' }],
      ['a traversing program path', { app: { id: 'x', name: 'X', exe: 'c:\\a\\..\\..\\windows\\system32\\cmd.exe' }, item: 'app' }],
      ['an app id with a scheme', { app: { id: 'x', name: 'X', aumid: 'ms-settings:privacy' }, item: 'app' }],
      ['an app id that climbs out of AppsFolder', { app: { id: 'x', name: 'X', aumid: '..\\..\\x!App' }, item: 'app' }],
      ['a window handle that is not a number', { app: { id: 'x', name: 'X', exe: 'c:\\t.exe', hwnds: ['12; rm'] }, item: 'app' }],
      ['an item token jumplist.get never gives', { app: { id: 'x', name: 'X', exe: 'c:\\t.exe' }, item: 'c:0:0; x' }],
    ];
    for (const [what, args] of bad) {
      f3.sent.length = 0;
      const r = await f3.cmds.open(args);
      check(`refused, nothing sent: ${what}`, r.ok === false && !f3.sent.length && !/undefined|null|0x/.test(r.reason), JSON.stringify(r));
    }
    f3.sent.length = 0;
    const rm = await f3.cmds.remove({ app: { id: 'x', name: 'X', exe: 'c:\\t.exe' }, item: 'app' });
    check('"remove" of the app itself is refused (only list items can be removed)', rm.ok === false && !f3.sent.length, JSON.stringify(rm));
    const cl = await f3.cmds.close({ hwnds: ['77', 'notawindow'] });
    check('close: one bad handle refuses the whole request, nothing is closed', cl.ok === false && !f3.sent.some((s) => s.cmd === 'close'), JSON.stringify(cl));
    const many = await f3.cmds.close({ hwnds: Array.from({ length: 65 }, (_, i) => String(1000 + i)) });
    check('close: more than 64 windows at once is refused', many.ok === false && !f3.sent.some((s) => s.cmd === 'close'), JSON.stringify(many));
    // a refused close: a count and the reason in words, never the handle or a hex code
    f3.ctx.sidecar.send = async (cmd, a) => { f3.sent.push({ cmd, args: a }); return cmd === 'close' ? { ok: false, error: 'Windows refused (0x80070005)' } : { ok: false, error: 'x' }; };
    const cr = await f3.cmds.close({ hwnds: ['4242', '4343'] });
    check('close: a refusal names no window handle and no hex code', cr.ok === false && !/4242|4343|0x/.test(cr.reason) && /2 of 2 windows did not close: Windows refused/.test(cr.reason), cr.reason);
    f3.ctx.sidecar.send = async () => ({ ok: true, result: { ok: true, sections: [], none: null, error: 'its recent items could not be read (it has no DestList (0x80030002))' } });
    const gr = await f3.cmds.get({ app: { id: 'x', name: 'Secret App', exe: 'c:\\t.exe' } });
    check('get: sidecar words are made plain (no hex, no DestList)', gr.ok && !/0x|DestList/.test(gr.error), gr.error);
    f3.ctx.sidecar.send = async () => ({ ok: false, error: 'unknown command jumplist.get' });
    const old = await f3.cmds.get({ app: { id: 'x', name: 'X', exe: 'c:\\t.exe' } });
    check('get: an old helper is said without "sidecar" or an npm command', old.ok === false && !/sidecar|npm/.test(old.reason), old.reason);
  }

  /* ---- the feature's Undo: unpin -> {undo:true}; pin {undo:true} puts it back where it was; the
     log never names the app (it used to log its name or its shortcut's file name) */
  {
    const f4 = fakeCtx(false);
    feature.install(f4.ctx);
    const P1 = { id: 'one.lnk', name: 'Private One', kind: 'pinned', exe: 'c:\\one.exe', hwnds: [] };
    f4.store.pins = { hide: [], add: [], order: ['two.lnk', 'one.lnk', 'three.lnk'] };
    const u1 = await f4.cmds.pin({ app: P1, pin: false });
    check('feature: an unpin offers an undo', u1.ok && u1.did === 'hid' && u1.undo === true && !f4.store.pins.order.includes('one.lnk'), JSON.stringify(u1));
    f4.store.pins = own.setOrder(f4.store.pins, ['three.lnk', 'two.lnk']);         // a drag meanwhile
    const u2 = await f4.cmds.pin({ app: P1, pin: true, undo: true });
    check('feature: Undo restores it to its place, after the id it followed', u2.ok && u2.did === 'restored' &&
      f4.store.pins.order.join('|') === 'three.lnk|two.lnk|one.lnk' && !f4.store.pins.hide.length, JSON.stringify(f4.store.pins));
    const u3 = await f4.cmds.pin({ app: P1, pin: true, undo: true });
    check('feature: a second Undo is an ordinary (harmless) pin', u3.ok && u3.did !== 'restored', JSON.stringify(u3));
    check('feature: pin/unpin log lines name no app and no shortcut file', f4.logs.length >= 3 && !f4.logs.some((l) => /Private One|one\.lnk/.test(l)), JSON.stringify(f4.logs));
    const ft = fakeCtx(true);
    feature.install(ft.ctx);
    const d1 = await ft.cmds.pin({ app: P1, pin: false });
    check('--test: an unpin is a dry run that still offers the undo (so the page can be tested)', d1.dryRun === true && d1.undo === true && !Object.keys(ft.store).length, JSON.stringify(d1));
    const bp = await f4.cmds.pin({ app: { id: 'x', name: 'X', exe: 'https://x' }, pin: true });
    check('feature: pin refuses a program that is not a local path', bp.ok === false, JSON.stringify(bp));
  }

  console.log(`JUMPLIST UNIT TEST: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
