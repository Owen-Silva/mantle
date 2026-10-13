/*
 * main-qskbd.test.js -- main.js's keyboard grant for the bar (qs.keyboard, the Wi-Fi password box,
 * the media queue box, the jump list, downloads), run as the REAL code: the `// <mainrel:qskbd>`
 * region is lifted out of main.js and run in a vm with a fake bar window (an EventEmitter that can
 * emit 'blur'), a fake sidecar and a recording broadcast (main.js itself needs Electron).
 *
 * WHY (lane mn-pop, 2026-10-12, audit #8): when the bar lost the keyboard on its own, qsKbBlur made
 * the bar unfocusable again and only logged it. The page was never told, so the password box went
 * on looking typeable while every key went to the app in front. Now the blur broadcasts
 * 'bar.keyboard.lost'. Pinned to the old code: afa3993's version must show the old fault.
 *
 *   node lib/main-qskbd.test.js
 * One summary line: "QSKBD TEST: n passed, m failed".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
let OLD = '';
try { OLD = execFileSync('git', ['show', 'afa3993:main.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n'); } catch (_) { OLD = ''; }

let passed = 0;
const failures = [];
function ok(cond, what, detail) {
  if (cond) passed++;
  else failures.push(what + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
}

/** The region, or (older code) from `let qsKbPrev` to the end of qsKeyboard. */
function piece(src) {
  const a = src.indexOf('// <mainrel:qskbd>');
  const b = src.indexOf('// </mainrel:qskbd>');
  if (a !== -1 && b !== -1) return src.slice(a, b);
  const s = src.indexOf('let qsKbPrev = null;');
  const f = src.indexOf('async function qsKeyboard(on)', s);
  const e = src.indexOf('\n}\n', f);
  if (s === -1 || f === -1 || e === -1) throw new Error('main.js has no qsKeyboard piece');
  return src.slice(s, e + 2);
}

function harness(code) {
  const bar = new EventEmitter();
  bar.focusable = false;
  bar.focused = false;
  bar.calls = [];
  bar.isDestroyed = () => false;
  bar.setFocusable = (v) => { bar.focusable = v; bar.calls.push(['focusable', v]); };
  bar.setSkipTaskbar = () => {};
  bar.focus = () => { if (bar.focusable) bar.focused = true; };
  bar.isFocused = () => bar.focused;
  bar.webContents = { focus: () => {} };
  const sent = [];
  const logs = [];
  const ctx = {
    barWin: bar,
    flags: { test: false },
    sidecar: { info: { pid: 1 }, call: async (cmd) => (cmd === 'foreground' ? { hwnd: 777 } : { how: 'focus' }) },
    hwndOf: () => '555',
    fgGrant: { grant: () => ({}), howWords: () => 'the sidecar focused it', words: () => 'granted', splitTried: (m) => ({ tried: '', shown: m }) },
    broadcast: (name, payload) => sent.push({ name, payload }),
    process: { stdout: { write: (l) => logs.push(String(l)) } },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, bar, sent, logs };
}

async function main() {
  // ---- the new code
  {
    const H = harness(piece(SRC));
    const r = await H.ctx.qsKeyboard(true);
    ok(r.ok && r.focused, 'qs.keyboard on: the fake bar takes the keyboard', r);
    ok(H.bar.listenerCount('blur') === 1, 'while it holds the keyboard, a blur listener is armed');
    H.bar.focused = false;
    H.bar.emit('blur');
    const lost = H.sent.filter((s) => s.name === 'bar.keyboard.lost');
    ok(lost.length === 1, 'the bar losing the keyboard on its own TELLS THE PAGE (bar.keyboard.lost)', H.sent);
    ok(lost[0] && typeof lost[0].payload.why === 'string' && !/\\|\.exe|\.lnk/.test(lost[0].payload.why), 'with a plain reason that names no app or file', lost[0]);
    ok(H.bar.focusable === false, 'and the bar is unfocusable again', H.bar.calls);
    ok(H.logs.some((l) => /lost the keyboard/.test(l)), 'the log line is still written', H.logs);
    ok(H.bar.listenerCount('blur') === 0, 'the blur listener is gone after it fired');
    H.bar.emit('blur');
    ok(H.sent.filter((s) => s.name === 'bar.keyboard.lost').length === 1, 'a second blur says nothing more');

    // released on purpose: no "lost"
    const H2 = harness(piece(SRC));
    await H2.ctx.qsKeyboard(true);
    const off = await H2.ctx.qsKeyboard(false);
    H2.bar.emit('blur');
    ok(off.ok && H2.sent.filter((s) => s.name === 'bar.keyboard.lost').length === 0, 'giving the keyboard back on purpose is not "lost"', H2.sent);

    // a --test instance never takes the keyboard, so there is nothing to lose
    const H3 = harness(piece(SRC));
    H3.ctx.flags.test = true;
    const t = await H3.ctx.qsKeyboard(true);
    ok(!t.ok && H3.bar.listenerCount('blur') === 0, '--test: refused, no listener', t);
  }

  // ---- the old code shows the fault (the page was never told)
  if (!OLD) {
    ok(false, 'baseline afa3993:main.js could be read from git');
  } else {
    const H = harness(piece(OLD));
    await H.ctx.qsKeyboard(true);
    H.bar.focused = false;
    H.bar.emit('blur');
    ok(H.sent.length === 0 && H.logs.some((l) => /lost the keyboard/.test(l)), 'baseline afa3993: the blur only logged, the page was never told (the fault)', H.sent);
  }

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`QSKBD TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.log('  FAIL the run itself: ' + (e && e.stack || e)); console.log(`QSKBD TEST: ${passed} passed, ${failures.length + 1} failed`); process.exitCode = 1; });
