/* battery.js — the battery readout's words and glyph, from ONE sidecar reading (Battery.cs).
 *
 * WHY A MODULE OF ITS OWN (2026-09-23). Owen: "there are problems with it showing how charged my
 * computer is". The readout, its tooltip and the quick-settings footer each worded the battery
 * for themselves, from two different sources, and none of them could say "not charging": the
 * readout drew a bolt whenever the charger was in (Win32_Battery's BatteryStatus 2, which only
 * means "on AC"), the footer said "Plugged in" beside it. One pure function now words every
 * surface, and ui/bar/battery.test.js pins it down in node.
 *
 * THE WORDS ARE WINDOWS' OWN. Read out of %windir%\System32\en-US\batmeter.dll.mui on this
 * machine (build 26200) the same day: "Battery status: %1%% available (plugged in)", "fully
 * charged (100%)", "%3 hr %2 min (%1%%) remaining", "%2 min (%1%%) remaining", "%1%% remaining",
 * "unknown remaining", "plugged in", "no battery is detected", and "Energy saver on" on a line
 * of its own. Windows has no "not charging" string and shows that state with a plug instead of
 * a bolt; the one addition here is ", charging" / ", not charging" inside the brackets, because
 * a charge limit (Lenovo Vantage conservation mode) holding the battery on AC is exactly the
 * case the bolt got wrong.
 *
 * TIME LEFT ONLY WHEN WINDOWS KNOWS IT. It sends 0xFFFFFFFF (-1 read signed) on AC and for a
 * while after an unplug (32 s on the one measured), and WMI's Win32_Battery answers 71582788 minutes (136 years) for
 * the same "unknown". Every one of those, and anything over 100 hours, is no estimate at all.
 *
 * Loaded as a plain <script> by the bar (window.MantleBattery) and by require() in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleBattery = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_SECONDS = 100 * 3600;   // longer than any laptop runs: an "unknown" in disguise

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  /* The reading's fields, with `power`'s older names (onBattery, minutesLeft, hasBattery)
     accepted too: an older sidecar exe answers with those, and so does the panel's part. */
  function norm(r) {
    var pct = num(r.percent);
    if (pct !== null && (pct < 0 || pct > 100)) pct = null;           // 255 is Windows' "unknown"
    var ac = typeof r.ac === 'boolean' ? r.ac
      : typeof r.onBattery === 'boolean' ? !r.onBattery : null;
    var present = typeof r.present === 'boolean' ? r.present
      : typeof r.hasBattery === 'boolean' ? r.hasBattery
      : (pct !== null ? true : null);
    return {
      percent: pct === null ? null : Math.round(pct),
      ac: ac,
      present: present,
      charging: typeof r.charging === 'boolean' ? r.charging : null,  // null: this sidecar cannot say
      saver: r.saver === true,
      seconds: ac === false ? secondsLeft(r) : null
    };
  }

  /* Seconds left on battery, or null when Windows does not know. */
  function secondsLeft(r) {
    var s = num(r.secondsLeft);
    if (s === null && num(r.minutesLeft) !== null) s = r.minutesLeft * 60;
    if (s === null || s <= 0 || s >= MAX_SECONDS) return null;
    return Math.floor(s);
  }

  /* Windows' shape: "3 hr 12 min", and "45 min" under an hour. */
  function hm(sec) {
    var m = Math.floor(sec / 60), h = Math.floor(m / 60);
    m = m % 60;
    return h ? h + ' hr ' + m + ' min' : m + ' min';
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  var CLICK = 'Click: quick settings';

  /* describe(reading) -> everything the bar needs to draw the battery, as one object:
       show     draw the readout at all (false only for a machine with no battery)
       state    charging | plugged | full | battery | unknown | error | none
       short    the text beside the glyph ("72%", or "—")
       words    Windows' sentence, lower-case as it follows "Battery status: "
       tip      the readout's tooltip, ending with what a click does
       footer   the quick-settings footer, short enough for its one line
       level    0..1 for the fill, or null to draw it empty
       bolt / plug   which mark goes on the glyph (a bolt only while actually charging)
       reason   why something is unknown, or null */
  function describe(r) {
    var out = {
      show: true, state: 'error', percent: null, short: '—', words: '', tip: '', footer: '',
      level: null, bolt: false, plug: false, saver: false, timeLeft: null, reason: null
    };
    if (!r || typeof r !== 'object' || r.ok === false) {
      out.reason = (r && typeof r === 'object' && r.reason) ||
        (r && typeof r === 'object' ? 'the battery reading failed, and it gave no reason' : 'no battery reading has arrived yet');
      out.words = 'unknown';
      out.tip = 'Battery status: unknown\n' + out.reason + '\n' + CLICK;
      out.footer = 'Battery: ' + out.reason;
      return out;
    }
    var n = norm(r);
    out.percent = n.percent;
    out.saver = n.saver;
    if (n.present === false) {
      out.show = false; out.state = 'none';
      out.words = 'no battery is detected';
      out.tip = 'Battery status: no battery is detected';
      out.footer = 'No battery is detected';
      return out;
    }
    var p = n.percent;
    if (p !== null) { out.short = p + '%'; out.level = p / 100; }

    if (p === null || n.ac === null || n.present === null) {
      out.state = 'unknown';
      out.reason = (typeof r.reason === 'string' && r.reason) ||
        (p === null ? 'Windows does not know the battery percentage yet'
          : n.ac === null ? 'Windows does not know whether the charger is plugged in'
          : 'Windows cannot tell whether this machine has a battery');
      out.words = p === null ? (n.ac === true ? 'plugged in' : n.ac === false ? 'unknown remaining' : 'unknown')
        : p + '%';
      out.bolt = n.ac === true && n.charging === true;
      out.plug = n.ac === true && n.charging !== true;
      out.footer = p === null ? cap(out.words) : p + '% · ' + out.reason;
    } else if (n.ac) {
      if (n.charging === true) {
        out.state = 'charging'; out.bolt = true;
        out.words = p + '% available (plugged in, charging)';
        out.footer = p + '% · charging';
      } else if (p === 100 && n.charging === false) {
        out.state = 'full'; out.plug = true;
        out.words = 'fully charged (100%)';
        out.footer = 'Fully charged';
      } else {
        out.state = 'plugged'; out.plug = true;
        // An older sidecar cannot say whether it is charging: then exactly Windows' words, no claim.
        out.words = p + '% available (plugged in' + (n.charging === false ? ', not charging' : '') + ')';
        out.footer = p + '% · ' + (n.charging === false ? 'not charging' : 'plugged in');
      }
    } else {
      out.state = 'battery';
      if (n.seconds !== null) {
        out.timeLeft = hm(n.seconds);
        out.words = out.timeLeft + ' (' + p + '%) remaining';
        out.footer = p + '% · ' + out.timeLeft + ' left';
      } else {
        out.words = p + '% remaining';
        out.footer = p + '% · on battery';
      }
    }
    out.tip = 'Battery status: ' + out.words + (n.saver ? '\nEnergy saver on' : '') +
      (out.reason ? '\n' + out.reason : '') + '\n' + CLICK;
    return out;
  }

  /* The glyph, 16x16, currentColor throughout (no var() inside SVG presentation attributes: they
     are not custom-property aware). The body and fill are the ones the bar has always drawn. The
     bolt used to sit ON the fill in the same colour, so at 50-80 % it all but vanished; now the
     fill is cut away around the mark (a mask), the way Windows' own glyph leaves a gap. */
  var BOLT = 'M8.6 5.4L6.2 8.6h1.9l-.5 2.2 2.4-3H8.2z';
  var PLUG = 'M6.4 5.2H7.1V6.8H8.1V5.2H8.8V6.8H9.4V7.8A1 1 0 0 1 8.4 8.8H7.95V10.8H7.25V8.8H6.8A1 1 0 0 1 5.8 7.8V6.8H6.4Z';

  function svg(d) {
    var mark = d.bolt ? BOLT : d.plug ? PLUG : null;
    var s = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">';
    if (mark) {
      s += '<defs><mask id="mbat-ko" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">' +
        '<rect width="16" height="16" fill="#fff"/>' +
        '<path d="' + mark + '" fill="#000" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></mask></defs>';
    }
    s += '<rect x="1.2" y="4.7" width="11.6" height="6.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
    s += '<rect x="13.5" y="6.7" width="1.5" height="2.6" rx=".7" fill="currentColor"/>';
    if (d.level !== null && d.level > 0) {
      s += '<rect x="2.8" y="6.3" width="' + (8.4 * Math.min(1, d.level)).toFixed(2) + '" height="3.4" rx="1" fill="currentColor"' +
        (mark ? ' mask="url(#mbat-ko)"' : '') + '/>';
    }
    if (mark) s += '<path d="' + mark + '" fill="currentColor"/>';
    return s + '</svg>';
  }

  return { describe: describe, svg: svg, MAX_SECONDS: MAX_SECONDS };
}));
