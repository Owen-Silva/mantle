'use strict';

/*
 * The page a window shows when the HTML it should load does not exist.
 *
 * WHY not a blank window: an empty transparent bar is indistinguishable from a
 * bar that loaded and drew nothing, and Owen's rule is that nothing fails
 * silently. So a missing file gets a page that names the exact file and the lane
 * that owns it, in the same instrument-glass look as the real thing.
 *
 * It is a data: URL, which means it cannot <link> ui/shared/tokens.css -- a data:
 * document has no base URL to resolve a relative path against. The handful of
 * colours below are therefore copied from tokens.css on purpose; they are only
 * ever seen when something is already broken, so drift here costs nothing.
 */

const TOKENS = {
  ink: '#1a1c20',
  fg: '#eef1f8',
  fg2: '#b0b5bf',
  fg3: '#a6abb5',
  glass: 'rgba(255,255,255,.055)',
  edge: 'rgba(255,255,255,.11)',
  ion: '#72adca',
  font: "'Bahnschrift','Segoe UI Variable','Segoe UI',sans-serif",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} o
 * @param {string} o.title   what this window is ("bar", "launcher")
 * @param {string} o.file    the file that is missing, repo-relative
 * @param {string} o.owner   which lane owns it
 * @param {boolean} o.compact  bar-height layout (one line) instead of a panel
 */
function placeholderUrl({ title, file, owner, compact }) {
  const t = TOKENS;
  const body = compact
    ? `<div class="strip"><span class="dot"></span><b>${esc(title)}</b> has no page yet &mdash; <code>${esc(file)}</code> does not exist (${esc(owner)})</div>`
    : `<div class="panel">
         <div class="head"><span class="dot"></span>${esc(title)} has no page yet</div>
         <p>Mantle is running and this window opened, but the file it should load is not there:</p>
         <p><code>${esc(file)}</code></p>
         <p class="who">${esc(owner)}</p>
       </div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Mantle &mdash; missing ${esc(file)}</title>
<style>
  html,body{margin:0;height:100%;font-family:${t.font};color:${t.fg};
    background:${compact ? t.glass : t.ink};-webkit-font-smoothing:antialiased}
  body{display:flex;align-items:center;justify-content:${compact ? 'flex-start' : 'center'}}
  .strip{display:flex;align-items:center;gap:10px;padding:0 14px;font-size:13px;
    width:100%;height:100%;box-sizing:border-box;border-top:1px solid ${t.edge};
    background:${t.glass}}
  .panel{max-width:520px;padding:22px 24px;border:1px solid ${t.edge};border-radius:14px;
    background:${t.glass};line-height:1.55;font-size:13px}
  .head{font-size:15px;margin-bottom:12px;display:flex;align-items:center;gap:10px}
  .dot{width:7px;height:7px;border-radius:50%;background:${t.ion};flex:0 0 auto}
  p{margin:8px 0;color:${t.fg2}}
  code{font-family:Consolas,monospace;font-size:12px;color:${t.fg};
    background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px}
  .who{color:${t.fg3};font-size:12px;margin-top:14px}
</style></head><body>${body}</body></html>`;

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

module.exports = { placeholderUrl };
