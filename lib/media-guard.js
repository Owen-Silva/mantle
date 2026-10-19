'use strict';
/*
 * lib/media-guard.js - PROTECTED MEDIA APPS: apps whose media sessions a stray click in Mantle must
 * never pause or skip (say, a video you are recording over), and the rule that keeps the bar's
 * transport controls off them.
 *
 * Some apps publish a system media session like any music player. One stray click on a play/pause
 * glyph would pause such an app under whatever it is doing, and nothing on screen would say why.
 * When the rule is ON, a session that belongs to a protected app:
 *   - gets NO transport controls anywhere in Mantle; the media card says
 *     "<app> · controls off so a stray click can't pause it" instead of drawing buttons,
 *   - is REFUSED by main's media.control whatever a page asks (the page is not the guard),
 *   - loses the now-playing chip to any other session when both exist, and when protected apps are
 *     the only sessions there is NO chip at all (lib/media-pick.js).
 * When the rule is OFF, a protected app is controllable like any other; it is only marked, and
 * named in the card's source switcher with the optional label.
 *
 * CONFIG: media-guard.json in Mantle's data folder (app.getPath('userData')), read once per start.
 * Missing or unreadable = the default, which protects nothing (the rule is inert):
 *   {
 *     "apps":  ["Contoso Player"],  each matched case-insensitively as a substring of a session's
 *                                   AUMID, app name or title (a web player in a browser has only
 *                                   its title to go on). Default [].
 *     "guard": true,                whether the rule is on. Default true once apps are listed;
 *                                   false keeps them marked (and labelled) but controllable.
 *     "label": "recording"          optional: the word the source switcher shows after a protected
 *                                   app's name in place of its title, and after the app's name in
 *                                   the card's "controls off" line. Default none.
 *   }
 * FLAGS (main.js passes argv): --media-guard turns the rule on for this run whatever "guard" says;
 * --media-controls turns it off and wins over both. With no apps listed neither has anything to do.
 *
 * Pure apart from read(): main.js reads once and passes the config in; lib/media-guard.test.js
 * drives every function here.
 */
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'media-guard.json';
const FLAG_ON = '--media-guard';
const FLAG_OFF = '--media-controls';
const MAX_APPS = 50;
const MAX_TEXT = 80;

function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, MAX_TEXT);
  return t || null;
}

/** Any parsed value -> { apps, guard, label }. Junk entries are dropped, never thrown on. */
function normalize(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const apps = [];
  for (const a of Array.isArray(o.apps) ? o.apps : []) {
    const t = cleanText(a);
    if (t && !apps.some((x) => x.toLowerCase() === t.toLowerCase())) apps.push(t);
    if (apps.length >= MAX_APPS) break;
  }
  return {
    apps,
    guard: typeof o.guard === 'boolean' ? o.guard : apps.length > 0,
    label: cleanText(o.label),
  };
}

/**
 * Read <dir>\media-guard.json. Never throws. Out: normalize()'s shape plus
 *   file    the path read
 *   found   whether the file was there
 *   reason  null when it was read cleanly, else why the default is in force
 */
function read(dir, fsImpl) {
  const F = fsImpl || fs;
  const file = path.join(String(dir || ''), FILE_NAME);
  let text;
  try {
    text = F.readFileSync(file, 'utf8');
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return Object.assign(normalize(null), {
      file, found: false,
      reason: missing ? `no ${FILE_NAME}, so no media app is protected` : `${FILE_NAME} could not be read (${err.message}), so no media app is protected`,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    return Object.assign(normalize(null), { file, found: true, reason: `${FILE_NAME} is not valid JSON (${err.message}), so no media app is protected` });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign(normalize(null), { file, found: true, reason: `${FILE_NAME} is not a JSON object, so no media app is protected` });
  }
  return Object.assign(normalize(parsed), { file, found: true, reason: null });
}

/** Whether the rule is on, and what turned it on or off: { on, by: 'none'|'flag'|'config'|'controls-flag' }. */
function state(cfg, argv) {
  const c = cfg || normalize(null);
  const args = Array.isArray(argv) ? argv : [];
  if (!c.apps.length) return { on: false, by: 'none' };
  if (args.includes(FLAG_OFF)) return { on: false, by: 'controls-flag' };
  if (args.includes(FLAG_ON)) return { on: true, by: 'flag' };
  return { on: !!c.guard, by: 'config' };
}

/** The protected app a session belongs to: the config's entry as written, or null. */
function match(cfg, s) {
  if (!cfg || !s || !cfg.apps.length) return null;
  const hay = [s.aumid, s.app && s.app.name, s.title].map((v) => String(v || '').toLowerCase());
  for (const a of cfg.apps) {
    const needle = a.toLowerCase();
    if (hay.some((h) => h.includes(needle))) return a;
  }
  return null;
}

/** The card's "controls off" line for a protected app. */
function reasonFor(cfg, app) {
  const label = cfg && cfg.label ? ' ' + cfg.label : '';
  return `${app || 'This app'}${label} · controls off so a stray click can't pause it`;
}

/** How to lift the rule, for the card (a --flag in it is drawn unbroken). */
function howFor(st) {
  if (st && st.by === 'flag') return `Mantle was started with ${FLAG_ON}; start it without that flag to allow them`;
  return `${FILE_NAME} in Mantle's data folder turns this on; set "guard" to false there, or start Mantle with ${FLAG_OFF}, to allow them`;
}

/** The `guard` field of main's media payload. */
function summary(cfg, argv) {
  const c = cfg || normalize(null);
  const st = state(c, argv);
  if (st.by === 'none') {
    return { on: false, apps: [], reason: (cfg && cfg.reason) || `no media app is protected (${FILE_NAME} in Mantle's data folder lists them)`, how: null };
  }
  const names = c.apps.join(', ');
  if (st.on) return { on: true, apps: c.apps.slice(), reason: `controls are off for ${names} so a stray click can't pause them`, how: howFor(st) };
  return {
    on: false,
    apps: c.apps.slice(),
    reason: st.by === 'controls-flag'
      ? `media controls are on for ${names} (Mantle was started with ${FLAG_OFF})`
      : `media controls are on for ${names} (start Mantle with ${FLAG_ON} to turn them off)`,
    how: null,
  };
}

module.exports = { FILE_NAME, FLAG_ON, FLAG_OFF, normalize, read, state, match, reasonFor, howFor, summary };
