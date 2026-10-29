/* pages/settings.js - Windows' Task Manager Settings page (TM-SPEC.md "Settings page"): App theme, Default
 * start page, Real time update speed, Window management (Always on top, Minimize on use, Hide when
 * minimized), Other options (Show full account name, Show history for all processes), Efficiency mode (Ask
 * me before applying Efficiency mode). Each change is command `setting` {key, value}; model.settings echoes
 * them, and a refused change says why on its own row.
 */
(function () {
  'use strict';
  const { esc } = TM;
  let root = null, m = {};
  const why = new Map();         // key -> the reason a change did not take
  const PAGES = TM.NAV.filter((n) => n.id !== 'settings').map((n) => [n.id, n.label]);
  const SECTIONS = [
    { title: null, rows: [
      { key: 'theme', label: 'App theme', sub: 'Choose how Task Manager looks', kind: 'select', opts: [['system', 'Use system setting'], ['light', 'Light'], ['dark', 'Dark']] },
      { key: 'startPage', label: 'Default start page', sub: 'Choose which page Task Manager opens on', kind: 'select', opts: PAGES },
      { key: 'updateSpeed', label: 'Real time update speed', sub: 'Choose how often the numbers change', kind: 'select', opts: [['high', 'High'], ['normal', 'Normal'], ['low', 'Low'], ['paused', 'Paused']] },
    ] },
    { title: 'Window management', rows: [
      { key: 'alwaysOnTop', label: 'Always on top', kind: 'check' },
      { key: 'minimizeOnUse', label: 'Minimize on use', sub: 'Task Manager minimizes after you switch to an app', kind: 'check' },
      { key: 'hideWhenMinimized', label: 'Hide when minimized', kind: 'check' },
    ] },
    { title: 'Other options', rows: [
      { key: 'fullAccountName', label: 'Show full account name', kind: 'check' },
      { key: 'historyAllProcesses', label: 'Show history for all processes', kind: 'check' },
    ] },
    { title: 'Efficiency mode', rows: [
      { key: 'askBeforeEfficiency', label: 'Ask me before applying Efficiency mode', kind: 'check' },
    ] },
  ];
  const DEF = { theme: 'system', startPage: 'processes', updateSpeed: 'normal', alwaysOnTop: false, minimizeOnUse: false, hideWhenMinimized: false, fullAccountName: false, historyAllProcesses: false, askBeforeEfficiency: true };

  function build() {
    root.innerHTML = '<div class="setwrap">' + SECTIONS.map((s) => (s.title ? `<h2 class="seth">${esc(s.title)}</h2>` : '') + '<div class="setcard">' + s.rows.map((r) => {
      const id = 'set-' + r.key;
      const ctl = r.kind === 'select'
        ? `<select id="${id}" data-key="${r.key}" aria-label="${esc(r.label)}">${r.opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`
        : `<input type="checkbox" class="sw" id="${id}" data-key="${r.key}" role="switch" aria-label="${esc(r.label)}">`;
      return `<div class="setrow" data-row="${r.key}"><label class="setl" for="${id}"><span class="sett">${esc(r.label)}</span>${r.sub ? `<span class="sets">${esc(r.sub)}</span>` : ''}<span class="setwhy" hidden></span></label>${ctl}</div>`;
    }).join('') + '</div>').join('') + '</div>';
    root.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-key]');
      if (!el) return;
      const key = el.dataset.key, value = el.type === 'checkbox' ? el.checked : el.value;
      const r = await TM.run('setting', { key, value }, { noDry: true });
      if (r.ok === false) why.set(key, r.reason); else why.delete(key);
      TM.refresh();
    });
  }
  function render() {
    const s = m.settings;
    const state = s ? 'ok' : TM.dataState('settings');
    root.classList.toggle('nodata', !s);
    for (const sec of SECTIONS) for (const r of sec.rows) {
      const el = root.querySelector(`[data-key="${r.key}"]`);
      const v = s && s[r.key] !== undefined ? s[r.key] : DEF[r.key];
      if (el.type === 'checkbox') { if (el.checked !== !!v) el.checked = !!v; } else if (el.value !== String(v)) el.value = String(v);
      el.disabled = !s;
      const w = root.querySelector(`[data-row="${r.key}"] .setwhy`);
      const text = why.get(r.key) || (!s ? (state === 'loading' ? 'Reading...' : "This Mantle doesn't keep Task Manager settings yet: its helper needs updating.") : '');
      w.hidden = !text;
      TM.setHtml(w, text ? (why.has(r.key) || state !== 'loading' ? `${TM.ICON.warn}<span>${esc(text)}</span>` : `<span>${esc(text)}</span>`) : '');
      w.classList.toggle('bad', !!(why.has(r.key) || (!s && state !== 'loading')));
    }
  }
  TM.page({
    id: 'settings', search: false,
    init(el) { root = el; build(); },
    render(mm) { m = mm; render(); },
    focus() { const f = root && root.querySelector('select, input'); if (f) f.focus(); },
  });
}());
