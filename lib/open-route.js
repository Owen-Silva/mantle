'use strict';
/*
 * open-route.js - where the bar's `open` call sends a target (lane barfiles, 2026-09-29).
 *
 * Owen's goal for Mantle is to never lean on Windows' own features, and Mantle Settings now
 * covers the Windows Settings pages (its section modules CLAIM ms-settings: URIs). The bar still
 * opened WINDOWS Settings for its links (Energy saver, the gear, Bluetooth / airplane / radio tiles,
 * Quick Settings' "more" rows), because main.js 'open' went straight to lib/open-target.js ->
 * shell.openExternal. Now:
 *   ms-settings:<page>      -> lib/launcher-index.js launch({kind:'setting'}): Mantle's page when a
 *                              section claims it, Windows' page when none does (Windows' own is then
 *                              the only page there is), and Windows' page WITH the reason when Mantle
 *                              Settings is off / resting / not loaded (fellBack, the bar shows it)
 *   ms-settings: (the root) -> Mantle Settings Home ('mantle:settings')
 *   ms-availablenetworks:   -> Mantle Settings' Wi-Fi page (ms-settings:network-wifi)
 *   anything else           -> openTarget, exactly as before
 * launcher-index.js is another lane's file: this only calls its launch().
 */

const FELL = /^opened Windows Settings: /;

/** A bar target -> the launcher item that opens it in Mantle Settings, or null (not a Settings link). */
function settingsItem(target) {
  const t = String(target === undefined || target === null ? '' : target).trim();
  if (/^ms-availablenetworks:/i.test(t)) return { kind: 'setting', name: 'Wi-Fi', path: 'ms-settings:network-wifi' };
  if (/^ms-settings:\/*$/i.test(t)) return { kind: 'setting', name: 'Mantle Settings', path: 'mantle:settings' };
  if (/^ms-settings:/i.test(t)) return { kind: 'setting', name: t, path: t };
  return null;
}

/**
 * Open a bar target. deps: { launch(item, {dryRun}), openTarget(target), dryRun }.
 * Resolves { ok, reason, ... } like both; a Settings fallback also carries fellBack (the reason).
 */
async function openRouted(target, deps) {
  const d = deps || {};
  const item = settingsItem(target);
  if (!item) return d.openTarget(target);
  let r;
  try {
    r = await d.launch(item, { dryRun: !!d.dryRun });
  } catch (err) {
    return { ok: false, reason: `Mantle Settings could not open ${item.path}: ${(err && err.message) || err}` };
  }
  if (!r || typeof r !== 'object') return { ok: false, reason: `Mantle Settings did not answer for ${item.path}` };
  const out = Object.assign({}, r, { routed: item.path });
  if (r.ok && typeof r.reason === 'string' && FELL.test(r.reason)) out.fellBack = r.reason.replace(FELL, '');
  return out;
}

module.exports = { settingsItem, openRouted };
