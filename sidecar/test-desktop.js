'use strict';
/*
 * test-desktop.js -- the sidecar's desktop-layer command (Desktop.cs) and the `foreground` read the
 * wallpaper's pause rules live on (lane launch-desk, 2026-09-29).
 *
 * A PASSIVE sidecar only (test-lib.js): `desktop` (attach / recheck / detach) must be refused, so a
 * test can never re-parent a window into Owen's desktop; `foreground` is a read and must answer in the
 * shape lib/wallpaper.js needs ({hwnd, fullscreen: boolean, rect: [l,t,r,b]}), or a full-screen game
 * would no longer pause the wallpaper. The explorer-restart rejoin cannot be driven without a real
 * explorer restart, so its code path is checked in the source (and is LIVE-ONLY in the matrix).
 *
 *   node sidecar/test-desktop.js --exe=<your private build>     (or MANTLE_SIDECAR_EXE)
 *   node sidecar/test-desktop.js --src=<dir holding Desktop.cs>  (source check against another copy)
 * Prints "DESKTOP SIDECAR TEST: n passed, m failed".
 */
const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

(async () => {
  const c = T.checker('DESKTOP SIDECAR');
  const srcDir = (process.argv.find((a) => a.startsWith('--src=')) || '').slice(6) || __dirname;
  const cs = fs.readFileSync(path.join(srcDir, 'Desktop.cs'), 'utf8');
  const recheck = cs.slice(cs.indexOf('public static string Recheck'), cs.indexOf('const uint GW_HWNDPREV'));
  c.check('source: Recheck rejoins the desktop when its parent is no longer Progman (explorer restart)',
    /GA_PARENT\) != progman\) \{[\s\S]*?Attach\(hwnd, out mode\)/.test(recheck));
  c.check('source: a rejoin is reported as a move, so main logs it and clears the warning',
    /moved = true;\s*\r?\n\s*covering = "explorer restarted/.test(recheck));

  let s;
  try { s = await T.startPassive(); } catch (err) { c.fail('the sidecar starts', err.message); process.exit(c.summary()); }
  try {
    for (const extra of [{ hwnd: '1' }, { hwnd: '1', recheck: true }, { hwnd: '1', detach: true }]) {
      let err = '';
      try { await s.call('desktop', extra, 4000); } catch (e) { err = e.message; }
      c.check(`passive: desktop ${extra.recheck ? 'recheck' : extra.detach ? 'detach' : 'attach'} is refused`, err === T.PASSIVE_REFUSAL, err || 'it answered');
    }
    const fg = await s.call('foreground', {}, 4000);
    c.check('foreground: answers with a fullscreen flag the pause rules can use', fg && typeof fg.fullscreen === 'boolean', JSON.stringify(fg && Object.keys(fg)));
    c.check('foreground: answers with a window handle', fg && fg.hwnd !== undefined);
    c.check('foreground: a rect is four numbers when present', !fg || fg.rect === undefined || fg.rect === null || (Array.isArray(fg.rect) && fg.rect.length === 4 && fg.rect.every((n) => typeof n === 'number')));
  } finally {
    await s.stop();
  }
  process.exit(c.summary());
})();
