/* net.js — the network readout's words and glyph, from ONE sidecar reading (NetState.cs, pushed by
 * main as 'net').
 *
 * WHY (2026-09-23). The user: "you need to make the Internet thing ... actually work". The readout
 * beside the speaker was a fixed Wi-Fi drawing in index.html, so it showed full bars with the Wi-Fi
 * off, on Ethernet, with no internet and with no network at all. It now draws what Windows' own
 * routing and connectivity say: which adapter carries traffic (Wi-Fi, Ethernet, anything else),
 * whether that reaches the internet, and for Wi-Fi the network and its signal.
 *
 * THE WORDS ARE WINDOWS' OWN where it has them: its taskbar tooltip is the network's name over
 * "Internet access" / "No internet access", and "Not connected" when there is nothing. The one
 * addition is saying WHY there is nothing, when Mantle knows: the Wi-Fi being switched off.
 *
 * Loaded as a plain <script> by the bar (window.MantleNet) and by require() in node
 * (ui/bar/net.test.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleNet = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Three arcs, like the panel's Wi-Fi tile (bar.js wifiGlyph): the same signal draws the same
     number of arcs in both places. */
  function bars(signal) {
    var s = typeof signal === 'number' ? signal : 0;
    return s <= 0 ? 1 : Math.max(1, Math.min(3, Math.ceil(s / 34)));
  }

  /* r: the sidecar's reading, or null before the first one.
     -> { state, kind, bars, title, detail, tip, label }
        state: connected | no-internet | disconnected | wifi-off | unknown | error */
  function describe(r) {
    if (!r) {
      return finish({ state: 'unknown', kind: 'none', bars: 0, title: 'Network', detail: 'Not read yet' });
    }
    if (r.ok === false) {
      return finish({ state: 'error', kind: 'none', bars: 0, title: 'Network state unknown',
        detail: r.reason || 'the network could not be read, and no reason was given' });
    }
    var w = r.wifi || {};
    var kind = r.kind === 'wifi' || r.kind === 'ethernet' || r.kind === 'other' ? r.kind : 'none';
    var name = kind === 'wifi' ? (w.ssid || 'Wi-Fi')
      : kind === 'ethernet' ? (r.adapter || 'Ethernet')
      : (r.adapter || 'Network');
    var d = { kind: kind, bars: kind === 'wifi' ? bars(w.signal) : 0 };
    switch (r.state) {
      case 'connected':
        d.state = 'connected'; d.title = name; d.detail = 'Internet access';
        break;
      case 'no-internet':
        d.state = 'no-internet'; d.title = name; d.detail = 'No internet access';
        break;
      case 'wifi-off':
        d.state = 'wifi-off'; d.kind = 'wifi'; d.bars = 0; d.title = 'Not connected'; d.detail = 'Wi-Fi is turned off';
        break;
      case 'disconnected':
        d.state = 'disconnected'; d.kind = 'none'; d.bars = 0; d.title = 'Not connected';
        d.detail = w.present === false ? 'No connections are available'
          : w.on ? 'Wi-Fi is on but not connected to a network' : 'No connections are available';
        break;
      default:
        return finish({ state: 'error', kind: 'none', bars: 0, title: 'Network state unknown',
          detail: 'the sidecar sent a state this bar does not know ("' + r.state + '")' });
    }
    // Internet access Windows could not be asked about is not "no internet": say which it is.
    if (d.state === 'connected' && r.internet === null && r.reason) d.detail = 'Internet access unknown: ' + r.reason;
    if (kind === 'wifi' && d.state !== 'wifi-off' && typeof w.signal === 'number' && w.signal > 0 && w.connected)
      d.signal = w.signal;
    return finish(d);
  }

  function finish(d) {
    d.tip = d.title + '\n' + d.detail + (typeof d.signal === 'number' ? ' · signal ' + d.signal + '%' : '');
    d.label = d.title + ', ' + d.detail;
    return d;
  }

  var ARCS = ['M6.3 10.8a2.6 2.6 0 0 1 3.4 0', 'M4 8.2a6 6 0 0 1 8 0', 'M1.6 5.6a9.5 9.5 0 0 1 12.8 0'];

  function wrap(body) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  /* A small mark in the bottom-right corner: '!' for no internet, a slash for off. The glyph under
     it is dimmed so the mark reads at 16 px. The '!' is KNOCKED OUT of its disc with a mask, as
     battery.js knocks its bolt out of the fill, so it shows the pane through it in both themes
     rather than a colour that is right in only one. */
  var BANG = '<defs><mask id="mnet-ko" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">' +
    '<rect width="16" height="16" fill="#fff"/>' +
    '<path d="M12.6 10.7v1.9" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="12.6" cy="14.2" r=".7" fill="#000"/></mask></defs>' +
    '<circle cx="12.6" cy="12.5" r="3.2" fill="currentColor" mask="url(#mnet-ko)"/>';

  function wifi(nBars, dim) {
    var s = '<circle cx="8" cy="13.2" r="1" fill="currentColor"' + (dim ? ' opacity=".45"' : '') + '/>';
    for (var i = 0; i < 3; i++) {
      s += '<path d="' + ARCS[i] + '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="' +
        (dim ? (i < nBars ? '.45' : '.2') : (i < nBars ? '1' : '.28')) + '"/>';
    }
    return s;
  }

  // Windows 11 draws a wired connection as a small monitor.
  function monitor(dim) {
    var o = dim ? ' opacity=".45"' : '';
    return '<rect x="2" y="2.6" width="12" height="8.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.2"' + o + '/>' +
      '<path d="M6 13.6h4M8 11v2.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"' + o + '/>';
  }

  function globe(dim) {
    var o = dim ? ' opacity=".45"' : '';
    return '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"' + o + '/>' +
      '<path d="M2.6 8h10.8M8 2.4c-1.8 1.9-1.8 9.3 0 11.2M8 2.4c1.8 1.9 1.8 9.3 0 11.2" fill="none" stroke="currentColor" stroke-width="1.1"' + o + '/>';
  }

  var SLASH = '<path d="M2.2 2.2l11.6 11.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';

  function svg(d) {
    switch (d.state) {
      case 'connected':
        return wrap(d.kind === 'wifi' ? wifi(d.bars, false) : d.kind === 'ethernet' ? monitor(false) : globe(false));
      case 'no-internet':
        return wrap((d.kind === 'wifi' ? wifi(d.bars, true) : d.kind === 'ethernet' ? monitor(true) : globe(true)) + BANG);
      case 'wifi-off':
        return wrap(wifi(3, true) + SLASH);
      case 'disconnected':
        return wrap(globe(true) + SLASH);
      default:           // unknown, error: a plain dimmed globe; the tooltip says why
        return wrap(globe(true));
    }
  }

  return { describe: describe, svg: svg, bars: bars };
}));
