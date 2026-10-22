'use strict';
/*
 * lib/features/_toasts-status.js -- SETTINGS' NOTIFICATION STATUS IN PLAIN WORDS (lane mantle-notif-safety,
 * 2026-10-17).
 *
 * Owen's rule: "No silent failures: every fallback shows its state AND the reason in its UI." The banner
 * path has several fallbacks whose reasons reached the log only (lane toastfast, 44569b0):
 *   - Windows' change event throws 0x80070490, so the helper checks every 100 ms instead;
 *   - an old helper exe or no notification database: banners wait for the full list;
 *   - a watch that will not arm: main's own 10 s poll;
 *   - new toasts that came without the early signal;
 *   - a change-check shortcut switched off (each check then asks the database itself);
 * plus this lane's: the helper dead and Windows' own banners put back (_toasts-safety.js).
 * statusOf() turns them into ONE line for Settings > System > Notifications:
 *   { mode: 'mantle' | 'windows' | 'none', line: 'Banners: Mantle', why: '<plain words>' | null,
 *     tone: 'ok' | 'info' | 'warn', at: <ms> | null }
 * mode = whose pop-ups Owen gets right now; 'none' = neither (the helper is down and Windows' are not
 * back yet, or could not be put back), always with the reason.
 *
 * Pure: everything comes in as plain values, so _toasts-status.test.js drives every case.
 */

const LINE = { mantle: 'Banners: Mantle', windows: 'Banners: Windows\' own', none: 'Banners: none' };

/** 100 -> "0.1 s", 10000 -> "10 s". */
function secs(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : String(Number(s.toFixed(2)))} s`;
}
function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** A sentence for inside the parentheses: no trailing period, first letter lower unless it names Windows/Mantle. */
function inner(s) {
  let t = String(s || '').trim().replace(/[.\s]+$/, '');
  if (/^[A-Z][a-z]/.test(t) && !/^(Windows|Mantle)\b/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  return t;
}
/** looksWhy (the helper's own words) -> what got slower, plainly. */
function looksWords(looks, looksWhy) {
  if (!looks || looks === 'wal-index header') return null;
  const w = String(looksWhy || '');
  const cause = /could not be (opened|mapped|viewed)/.test(w) ? 'the quick check could not be set up'
    : /header did not/.test(w) ? 'the quick check missed a change'
    : /data_version/.test(w) ? 'the quick check missed a change'
    : 'a quicker check was switched off';
  return looks === 'full signature'
    ? `each check reads the whole list, because ${cause}`
    : `each check asks the notification database, because ${cause}`;
}
const make = (mode, why, tone, at) => ({ mode, line: LINE[mode], why: why ? inner(why) : null, tone, at: at || null });

/*
 * i: { on, accessWhy, applyWhy (a failed take), helperReady, safety (_toasts-safety state()),
 *      watch (lib/notifications.js watchState() or null), now }
 */
function statusOf(i) {
  const x = i || {};
  const now = x.now || Date.now();
  if (!x.on) return make('windows', 'Mantle\'s style is off', 'info');
  const sf = x.safety || {};
  const down = sf.down;
  const last = sf.last;
  if (down || !x.helperReady) {
    const since = down ? down.at : now;
    const ran = last && last.at >= since ? last : null;
    const what = down && down.starting ? 'Mantle\'s notification helper has not started yet' : 'Mantle\'s notification helper stopped';
    const when = down && down.starting ? `${what} (since ${hhmm(since)})` : `${what} at ${hhmm(since)}`;
    if (ran && ran.ok && ran.nothing) return make('windows', `${what}; Windows shows its own pop-ups`, 'warn', ran.at);
    if (ran && ran.ok) return make('windows', `${what}; restored at ${hhmm(ran.at)}`, 'warn', ran.at);
    if (ran && !ran.ok) return make('none', `${what} and Windows' pop-ups could not be put back: ${inner(ran.why)}`, 'warn', ran.at);
    if (sf.running) return make('none', `${when}; Windows' own pop-ups are being put back now`, 'warn', since);
    const wait = sf.graceMs ? `within ${secs(sf.graceMs)}` : 'shortly';
    return make('none', `${when}; Windows' own pop-ups come back ${wait} unless it starts`, 'warn', since);
  }
  if (x.accessWhy) return make('windows', x.accessWhy, 'warn');
  const w = x.watch;
  const bits = [];
  let tone = 'ok';
  if (!w) bits.push(null);
  else if (!w.watching) {
    tone = 'warn';
    bits.push(`checking every ${secs(w.fallbackPollMs || 10000)}, because ${inner(w.watchReason || 'the notification watch would not start')}`);
  } else if (w.coming) {
    if (w.changes === 'event') bits.push('Windows tells Mantle about each new notification');
    else bits.push(`checking every ${secs(w.pollMs || 100)}, because Windows won't send change events to this app`);
    const lw = looksWords(w.looks, w.looksWhy);
    if (lw) { bits.push(lw); tone = 'info'; }
  } else {
    tone = 'info';
    const how = w.pollMs ? `checking every ${secs(w.pollMs)}; ` : '';
    const why = /older than the early signal/.test(String(w.why || '')) ? 'Mantle\'s notification helper is an older build that sends no early signal'
      : (w.why || 'this helper sends no early signal');
    bits.push(`${how}banners wait for the full list, because ${inner(why)}`);
  }
  if (w && w.missed > 0) {
    bits.push(`${w.missed} new notification${w.missed === 1 ? '' : 's'} came without the early signal and showed late`);
    if (tone === 'ok') tone = 'info';
  }
  if (x.applyWhy) {
    bits.push(`some apps still get Windows' own pop-up too: ${inner(x.applyWhy)}`);
    tone = 'warn';
  }
  const why = bits.filter(Boolean).join('; ');
  return make('mantle', why || null, tone);
}

module.exports = { statusOf, secs, looksWords, inner, LINE };
