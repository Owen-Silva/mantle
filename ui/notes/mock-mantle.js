/* mock-mantle.js — plays main for the quick notes pad when it is opened over file:// without
 * Electron (headless shots). The real preload.js defines window.mantle first, so under Electron this
 * file does nothing. Every note, time and path here is MADE UP: nothing is read from Owen's notes.
 *
 * Query: mock=3notes (default) | empty | failed | armed | armed2 | many | outside | long | nobridge
 *        busy=1 (a hard striped "app" behind the glass)  dark=1 (a dark desktop)
 * When the page has settled, <html data-ready="1">. window.__mockCalls lists every call made.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('mock') || '3notes';
  if (mode === 'nobridge') return;                 // the page must say it cannot save
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('mock');
    if (q.get('busy') === '1') document.body.classList.add('busy');
    if (q.get('dark') === '1') document.body.classList.add('dark');
  });

  const FILE = 'C:\\Users\\you\\Documents\\Mantle Notes\\notes.md';
  const FOLDER = 'C:\\Users\\you\\Documents\\Mantle Notes';
  const at = new Date(2026, 8, 27, 21, 14, 0).getTime();
  const three = [
    { id: 'n1', text: 'Project 4 - specs\nstep 7: write the outline first, then fill in the details\nask about the deadline one' },
    { id: 'n2', text: 'Errands Tue 6:15\n- new batteries\n- light bulbs\n- water bottle' },
    { id: 'n3', text: 'mantle ideas\nnotes pad: tabs scroll sideways when there are many' },
  ];
  const many = three.concat([
    { id: 'n4', text: 'Groceries' }, { id: 'n5', text: 'Expense write-up due Fri' }, { id: 'n6', text: '' },
    { id: 'n7', text: 'Book club: chapter 9' }, { id: 'n8', text: 'Call about the conference hotel' }, { id: 'n9', text: 'Monitor 27 vs 32 in?' },
  ]);
  const longText = ['Apartment - unit 3 review', ''].concat(Array.from({ length: 40 }, (_, i) => `${i + 1}. a made-up practice line for the scroll test, long enough to wrap once`)).join('\n');

  let notes = three, active = 'n1', saved = { ok: true, at, reason: null, rev: 0 }, outside = null, loadError = null, dirty = false;
  if (mode === 'empty') { notes = [{ id: 'n1', text: '' }]; saved = { ok: true, at: null, reason: null, rev: 0 }; }
  if (mode === 'many') { notes = many; active = 'n8'; }
  if (mode === 'long') { notes = [{ id: 'n1', text: longText }].concat(three.slice(1)); }
  if (mode === 'outside') outside = { copy: FOLDER + '\\notes (changed outside Mantle 2026-09-27 211403).md', name: 'notes (changed outside Mantle 2026-09-27 211403).md', at };
  const FAIL = `could not save ${FILE}: the disk is full`;
  if (mode === 'failed') { active = 'n2'; saved = { ok: false, at, reason: FAIL, rev: 0 }; dirty = true; }

  const handlers = {};
  window.__mockCalls = [];
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    emit(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
    call(name, args) {
      window.__mockCalls.push({ name, args });
      switch (name) {
        case 'notes.load': return Promise.resolve({ ok: true, notes: notes.map((n) => Object.assign({}, n)), active, file: FILE, folder: FOLDER, saved, outside, loadError, dirty, rescued: [] });
        case 'notes.dirty': {
          const t = window.__notesTake && window.__notesTake();
          if (mode === 'failed') return Promise.resolve({ ok: true, rev: t && t.rev, saved: { ok: false, at, reason: FAIL, rev: 0 }, outside: null });
          return Promise.resolve({ ok: true, rev: t && t.rev, saved: { ok: true, at: Date.now(), reason: null, rev: t ? t.rev : 0 }, outside });
        }
        case 'notes.delete': return Promise.resolve({ ok: true, deleted: args.id, keptIn: FOLDER + '\\deleted.md', saved: { ok: true, at: Date.now(), reason: null, rev: 0 } });
        default: return Promise.resolve({ ok: true });
      }
    },
  };
  window.addEventListener('load', () => {
    setTimeout(() => {
      window.mantle.emit('notes.open', { focus: true, reload: null, via: 'mock' });
      const del = document.getElementById('del');
      const click = () => del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (mode === 'armed' || mode === 'armed2') click();
      setTimeout(() => {
        if (mode === 'armed2') click();
        document.documentElement.dataset.ready = '1';
      }, 350);
    }, 60);
  });
}());
