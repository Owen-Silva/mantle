/* pages/game.js - Mantle's own "Get ready to game" page (the one page Windows lacks; TM-SPEC.md keeps it).
 * Every function the old view had: tick the apps to close before playing (saved by identity: `tick`),
 * "Reopen it" after the game, Free up RAM now (`free`, in the command bar as the page's one primary action),
 * "Free up RAM automatically when a game starts" (`auto`), and what the last Free up RAM / game start did,
 * failures grouped by reason. Rows come from model.prep (main sends them only while this page is on screen).
 */
(function () {
  'use strict';
  const { esc, fmt, ICON } = TM;
  let root = null, m = {}, freeing = false;
  const mb = (b) => fmt.mbi(b) || '—';
  /* Outcomes that failed for the same reason: the reason said once, after every app it hit */
  function grouped(list, whyFn) {
    const by = new Map();
    for (const r of list) { const w = whyFn(r); if (!by.has(w)) by.set(w, []); by.get(w).push(r.name); }
    return Array.from(by, ([w, names]) => `${names.join(', ')}: ${w}`);
  }
  const rowsOf = (g) => g.rows.concat((g.absent || []).map((a) => ({ key: 'absent:' + a.identity, identity: a.identity, name: a.name, mem: -1, tickable: true, ticked: true, reopen: a.reopen, absent: true })));

  function render() {
    const g = m.prep || { rows: [], absent: [] };
    root.querySelector('#auto').checked = !!g.auto;
    const lf = g.lastFree, la = g.lastAuto;
    const lines = [];
    if (lf) {
      lines.push(`<span class="h">${lf.dryRun ? 'Test Mantle: nothing was closed' : 'Free up RAM'} · ${lf.none ? esc(lf.none) : `freed about ${mb(lf.freed)} so far`}</span>`);
      for (const x of grouped((lf.results || []).filter((r) => !r.ok), (r) => r.why)) lines.push(TM.warnLine('bad', x));
      for (const r of lf.reopen || []) lines.push(r.can ? `<span>${esc(r.name)} reopens after your next game${r.why ? ' (' + esc(r.why) + ')' : ''}</span>` : TM.warnLine('bad', `${r.name} will not reopen: ${r.why}`));
    }
    if (la && la.at) {
      const when = new Date(la.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      lines.push(`<span class="h">When ${esc(la.game || 'a game')} started (${esc(when)}): ${la.none ? esc(la.none) : `freed about ${mb(la.freed)}`}</span>`);
      for (const x of grouped((la.results || []).filter((r) => r.state !== 'closed'), (r) => r.why || 'not closed')) lines.push(TM.warnLine('bad', x));
      if (la.reopened) for (const r of la.reopened.results || []) lines.push(r.ok ? `<span>${esc(r.name)} was started again after the game</span>` : TM.warnLine('bad', `${r.name} was not started again: ${r.why}`));
    }
    const lfEl = root.querySelector('#lastfree');
    lfEl.hidden = !lines.length;
    TM.setHtml(lfEl, lines.join(''));
    const host = root.querySelector('#prep');
    if (!m.loaded) { TM.setHtml(host, TM.stateHtml('loading', 'Reading running apps...')); return; }
    const rows = rowsOf(g).filter((r) => TM.match(r.name, r.identity));
    if (!rows.length) { TM.setHtml(host, TM.q ? TM.stateHtml('noq') : TM.stateHtml('empty', 'No apps that can be closed are running right now.')); return; }
    if (host.querySelector('.lsx')) { host.innerHTML = ''; host._h = undefined; }
    const have = new Map(Array.from(host.children).filter((e) => e.dataset.key).map((e) => [e.dataset.key, e]));
    let prev = null;
    for (const r of rows) {
      let el = have.get(r.key);
      if (el) have.delete(r.key); else { el = document.createElement('div'); el.dataset.key = r.key; }
      const why = !r.tickable ? r.why : r.absent ? 'Not running now' : r.reopenWhy ? r.reopenWhy : r.elevated ? 'Runs as administrator: Mantle may not be allowed to close it' : null;
      const bad = r.reopenWhy && /^Cannot/.test(r.reopenWhy);
      const s = `<div class="prow${r.tickable ? '' : ' off'}">` +
        (r.tickable ? `<input type="checkbox" data-act="tick" ${r.ticked ? 'checked' : ''} aria-label="Close ${esc(r.name)} before games">` : `<span class="lock" title="${esc(r.why)}">${ICON.lock}</span>`) +
        (r.absent ? `<span class="ic tile">${ICON.app}</span>` : TM.iconHtml(r.icon, r.iconWhy)) +
        `<span class="n" title="${esc(r.name)}">${esc(r.name)}</span><span class="mem">${r.mem >= 0 ? mb(r.mem) : ''}</span>` +
        (r.tickable && r.ticked ? `<label class="reo" title="Start it again when the game ends"><input type="checkbox" data-act="reopen" ${r.reopen ? 'checked' : ''}>Reopen it</label>` : '<span></span>') +
        (why ? (bad ? `<div class="pwhy bad">${ICON.warn}<span>${esc(why)}</span></div>` : `<div class="pwhy">${esc(why)}</div>`) : '') + '</div>';
      if (el._s !== s) { el.innerHTML = s; el._s = s; }
      const want = prev ? prev.nextSibling : host.firstChild;
      if (want !== el) host.insertBefore(el, want);
      prev = el;
    }
    for (const el of have.values()) el.remove();
  }

  async function free() {
    if (freeing) return;
    freeing = true;
    TM.refresh();
    const r = await TM.run('free', {}, { noDry: true });
    TM.note(r.ok === false ? (/^Mantle did not answer/.test(r.reason) ? TM.failWords('Free up RAM did not run', { message: r.reason.replace(/^Mantle did not answer \((.*)\)\. Nothing was done\.$/, '$1') }, 'Nothing was closed.') : r.reason) : null);
    freeing = false;
    TM.refresh();
  }

  TM.page({
    id: 'game', title: 'Get ready to game',
    init(el) {
      root = el;
      el.innerHTML = '<div class="gintro">Tick the apps you don\'t need while gaming. Free up RAM asks each one to close, like its own close button.</div>' +
        '<label class="opt"><input type="checkbox" id="auto"><span><b>Free up RAM automatically when a game starts</b><span class="optsub">Only ticked apps close. An app with unsaved work stays open and says so here.</span></span></label>' +
        '<div id="lastfree" class="lastfree" hidden></div>' +
        '<div class="gtbl"><div class="gcols" role="row"><span></span><span>App</span><span class="r">Frees</span><span class="reoh">After the game</span></div><div class="glist" id="prep"></div></div>';
      el.addEventListener('change', async (e) => {
        const tg = e.target;
        const row = tg.closest('[data-key]');
        const g = m.prep || { rows: [] };
        const r = row ? rowsOf(g).find((x) => x.key === row.dataset.key) : null;
        let res = null;
        if (tg.id === 'auto') res = await TM.run('auto', { on: tg.checked }, { noDry: true });
        else if (tg.dataset.act === 'tick' && r) res = await TM.run('tick', { identity: r.identity, on: tg.checked }, { noDry: true });
        else if (tg.dataset.act === 'reopen' && r) res = await TM.run('tick', { identity: r.identity, reopen: tg.checked }, { noDry: true });
        if (res) TM.note(res.ok === false ? (/^Mantle did not answer/.test(res.reason) ? res.reason.replace('Nothing was done.', 'Nothing was saved.') : res.reason) : null);
      });
    },
    render(mm) { m = mm; render(); },
    extra(mm) {
      const g = mm.prep || { rows: [] };
      const sum = g.rows.filter((r) => r.ticked).reduce((s, r) => s + r.mem, 0);
      return `<span class="gsum"><b>${esc(mb(sum))}</b> ticked</span>`;
    },
    commands(mm) {
      const g = mm.prep || { rows: [] };
      const n = g.rows.filter((r) => r.ticked).length;
      return [{ id: 'free', label: freeing ? 'Freeing...' : 'Free up RAM', primary: true, disabled: freeing || !n, title: n ? `Close the ${n} ticked app${n > 1 ? 's' : ''} now` : 'Tick at least one app below first', act: free }];
    },
    focus() { const c = root && root.querySelector('#prep input'); if (c) c.focus(); },
  });
}());
