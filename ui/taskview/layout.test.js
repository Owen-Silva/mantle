// layout.test.js - Task View's grid geometry and arrow keys (ui/taskview/layout.js). Pure; plain node.
//   node ui/taskview/layout.test.js
'use strict';
const T = require('./layout.js');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`  FAIL ${name}${detail ? ' (' + detail + ')' : ''}`); }
}

// Screens in DIP: Owen's 1920x1080 at 125% is 1536x864; plus the common ones and a small one.
const SCREENS = [[1536, 864], [1920, 1080], [1280, 720], [2560, 1440], [1024, 768], [1366, 768]];

// ---- empty and single ---------------------------------------------------------------------------
{
  const lay = T.layout(0, 1920, 1080);
  check('n=0: no rows', lay.rows === 0 && T.place(lay, 0).length === 0);
  check('n=0: move answers -1', T.move(lay, 0, 'ArrowRight') === -1);
  const one = T.layout(1, 1920, 1080);
  const p = T.place(one, 0)[0];
  check('n=1: the biggest tile', one.tileW === T.L.tileMax, String(one.tileW));
  check('n=1: centred horizontally', Math.abs(p.x + one.tileW / 2 - 960) <= 1, String(p.x));
  check('n=1: centred vertically in the area', Math.abs(p.y + one.tileH / 2 - (one.area.y + one.area.h / 2)) <= 1, String(p.y));
}

// ---- every n on every screen: the invariants --------------------------------------------------
for (const [W, H] of SCREENS) {
  for (let n = 1; n <= 60; n++) {
    const lay = T.layout(n, W, H);
    const tag = `${W}x${H} n=${n}`;
    const pos = T.place(lay, 0);
    const vis = pos.filter((q) => q.visible);
    let bad = '';
    if (lay.tileW > T.L.tileMax || lay.tileW < T.L.tileMin) bad = 'tile width ' + lay.tileW;
    if (!bad && lay.cols * lay.rows < n) bad = 'grid too small';
    // every row full except the last, which has at least one tile; and the columns are the fewest
    // that still give this many rows (balanced: 7 over 6 columns is 4+3, never 6+1)
    for (let r = 0; r < lay.rows && !bad; r++) {
      const k = T.rowLen(lay, r);
      if (r < lay.rows - 1 ? k !== lay.cols : k < 1) bad = `row ${r} has ${k} of ${lay.cols}`;
    }
    if (!bad && lay.rows > 0 && Math.ceil(n / (lay.cols - 1 || 1)) === lay.rows && lay.cols > 1) bad = `${lay.cols} columns where ${lay.cols - 1} give the same rows`;
    // whole visible rows inside the area (a DWM picture cannot be clipped), none off the sides
    for (const q of vis) {
      if (q.y < lay.area.y - 0.5 || q.y + lay.tileH > lay.area.y + lay.area.h + 0.5) { bad = `tile ${q.i} outside the area vertically`; break; }
      if (q.x < lay.area.x - 0.5 || q.x + lay.tileW > lay.area.x + lay.area.w + 0.5) { bad = `tile ${q.i} outside the area horizontally`; break; }
    }
    // no two visible tiles overlap
    for (let i = 0; i < vis.length && !bad; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = vis[i], b = vis[j];
        if (a.x < b.x + lay.tileW && b.x < a.x + lay.tileW && a.y < b.y + lay.tileH && b.y < a.y + lay.tileH) { bad = `tiles ${a.i} and ${b.i} overlap`; break; }
      }
    }
    if (!lay.scrolls && vis.length !== n) bad = bad || 'not every tile visible though it fits';
    if (lay.scrolls && vis.length !== lay.visibleRows * lay.cols) bad = bad || 'scrolled view is not whole rows';
    check(`invariants ${tag}`, !bad, bad);
  }
}

// Balanced columns, measured: 7 windows at 1920x1080 are rows of 4 and 3, not 6 and 1.
{
  const lay = T.layout(7, 1920, 1080);
  check('7 windows at 1920x1080: rows of 4 and 3', lay.cols === 4 && lay.rows === 2 && T.rowLen(lay, 1) === 3, `${lay.cols}x${lay.rows}`);
  check('7 windows at 1920x1080: still the biggest tiles', lay.tileW === T.L.tileMax, String(lay.tileW));
}

// Many windows on a small screen scroll by whole rows, and firstRowFor keeps the selection shown.
{
  const lay = T.layout(40, 1280, 720);
  check('40 windows at 1280x720 scroll', lay.scrolls === true && lay.visibleRows >= 1, JSON.stringify({ r: lay.rows, v: lay.visibleRows }));
  const first = T.firstRowFor(lay, 39, 0);
  check('the last window scrolls the last row into view', first === lay.rows - lay.visibleRows, String(first));
  const pos = T.place(lay, first);
  check('...and it is visible there', pos[39].visible === true);
  check('...and the first is not', pos[0].visible === false);
  check('selecting the first scrolls back to the top', T.firstRowFor(lay, 0, first) === 0);
  check('a selection already on screen does not scroll', T.firstRowFor(lay, (first + 1) * lay.cols, first) === first);
}

// ---- the arrow keys -----------------------------------------------------------------------------
{
  const lay = T.layout(7, 1920, 1080);     // rows of 4 and 3, centred
  check('Right steps on', T.move(lay, 0, 'ArrowRight') === 1);
  check('Right at the end stays', T.move(lay, 6, 'ArrowRight') === 6);
  check('Left at the start stays', T.move(lay, 0, 'ArrowLeft') === 0);
  check('Right crosses rows like reading', T.move(lay, 3, 'ArrowRight') === 4);
  check('Home / End', T.move(lay, 3, 'Home') === 0 && T.move(lay, 2, 'End') === 6);
  check('Down from the first goes to the nearest tile below (4)', T.move(lay, 0, 'ArrowDown') === 4, String(T.move(lay, 0, 'ArrowDown')));
  check('Down from the last of row 0 goes to the last of row 1', T.move(lay, 3, 'ArrowDown') === 6, String(T.move(lay, 3, 'ArrowDown')));
  const pos = T.place(lay, 0);
  const cx = (i) => pos[i].x + lay.tileW / 2;
  const up5 = T.move(lay, 5, 'ArrowUp');
  const nearest = [0, 1, 2, 3].reduce((b, i) => (Math.abs(cx(i) - cx(5)) < Math.abs(cx(b) - cx(5)) - 0.5 ? i : b), 0);
  check('Up goes to the tile whose centre is nearest in x', up5 === nearest, `${up5} vs ${nearest}`);
  check('Up on the top row stays', T.move(lay, 2, 'ArrowUp') === 2);
  check('Down on the bottom row stays', T.move(lay, 5, 'ArrowDown') === 5);
  check('an unknown key does not move', T.move(lay, 2, 'x') === 2);
  check('a stale selection is clamped', T.move(lay, 99, 'ArrowLeft') === 5);
}

// ---- type to filter -----------------------------------------------------------------------------
{
  const items = [
    { title: 'Inbox - Outlook', app: 'olk' }, { title: 'mantle - Visual Studio Code', app: 'Code' },
    { title: 'Spotify Premium', app: 'Spotify' }, { title: 'README.md - mantle', app: 'notepad' },
  ];
  check('empty query matches all', T.filter(items, '').length === 4);
  check('case-insensitive', T.filter(items, 'SPOTIFY').join() === '2');
  check('every word must match, in any order', T.filter(items, 'mantle code').join() === '1');
  check('the program name counts', T.filter(items, 'notepad').join() === '3');
  check('no match is empty', T.filter(items, 'zzz').length === 0);
  check('list order is kept', T.filter(items, 'mantle').join() === '1,3');
}

// ---- cost: the page lays out on every keystroke of the filter -----------------------------------
{
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 200; k++) { const lay = T.layout(60, 1536, 864); T.place(lay, 0); }
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  check('layout + place of 60 windows under 1 ms', per < 1, per.toFixed(3) + ' ms');
  console.log(`  note: layout + place, 60 windows: ${per.toFixed(3)} ms`);
}

for (const f of fails) console.log(f);
console.log(`TASKVIEW LAYOUT TEST: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
