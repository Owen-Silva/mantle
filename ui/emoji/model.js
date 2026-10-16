/* model.js - the emoji picker's pure logic (lane mantle-emoji, 2026-10-15; plan P11): the catalogue
 * (emoji-data.js unpacked, plus a small symbols tab and a kaomoji tab), search, recents, skin tones,
 * keyboard navigation over the grid, and where the panel goes on screen.
 *
 * No DOM and no Electron in here, so the SAME file runs in the page (window.EmojiModel), in main
 * (lib/features/emoji.js: placement, recents, tone) and under node for model.test.js, and the data
 * builder (tools/build-emoji-data.js) checks its tone rule with the very withTone the page uses.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmojiModel = factory();
})(this, function () {
  'use strict';

  var PANEL_W = 360, PANEL_H = 424;   // DIP, the pane itself
  var MARGIN = 18;                    // DIP of see-through window round the pane (light's drop shadow)
  var COLS = 8;
  var RECENT_MAX = 32;                // four rows
  var TONES = [0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF];
  var TONE_NAMES = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'];
  var FE0F = 0xFE0F;

  /* ---- skin tones -------------------------------------------------------------------------- */

  /** `s` with `tone` (a modifier code point) after the code points at `plan` (indices into s's code
      points); an FE0F right after a toned code point goes (the tone takes its place). */
  function withTone(s, plan, tone) {
    var seq = Array.from(s);
    var out = '';
    var toned = false;
    for (var i = 0; i < seq.length; i++) {
      var c = seq[i].codePointAt(0);
      if (c === FE0F && toned) { toned = false; continue; }
      toned = false;
      out += seq[i];
      if (plan.indexOf(i) >= 0) { out += String.fromCodePoint(tone); toned = true; }
    }
    return out;
  }

  /** The plan a data item carries: 1 = after the first code point; "0,4" = those; none = no tone. */
  function planOf(raw) {
    if (raw === 1) return [0];
    if (typeof raw === 'string' && raw) return raw.split(',').map(Number);
    return null;
  }

  /** What the cell shows and what is typed: the emoji in skin tone `tone` (0 = default, 1..5). */
  function display(item, tone) {
    if (!item.plan || !tone || tone < 1 || tone > 5) return item.ch;
    return withTone(item.ch, item.plan, TONES[tone - 1]);
  }

  function clampTone(t) { t = Number(t); return t >= 0 && t <= 5 && Math.floor(t) === t ? t : 0; }

  /* ---- the catalogue ----------------------------------------------------------------------- */

  var GROUP_GLYPH = { recent: '\u{1F552}', smileys: '\u{1F600}', people: '\u{1F44B}', nature: '\u{1F43B}', food: '\u{1F354}',
    travel: '\u{1F697}', activities: '\u26BD', objects: '\u{1F4A1}', symbols: '\u2764\uFE0F', flags: '\u{1F3C1}' };
  var GROUP_LABEL = { recent: 'Most recently used', smileys: 'Smileys & emotion', people: 'People & body', nature: 'Animals & nature',
    food: 'Food & drink', travel: 'Travel & places', activities: 'Activities', objects: 'Objects', symbols: 'Symbols', flags: 'Flags' };

  /* Symbols: the cheap half of Windows' symbols tab (arrows, maths, currency, punctuation and a few
     marks people actually type). Name first, then extra search words. */
  var SYMBOLS = [
    { id: 'punct', name: 'Punctuation', items: [
      ['\u2026', 'ellipsis', 'dots'], ['\u2013', 'en dash', 'dash range'], ['\u2014', 'em dash', 'dash'], ['\u2022', 'bullet', 'dot'],
      ['\u00B7', 'middle dot', 'interpunct'], ['\u2018', 'left single quote', 'quotation'], ['\u2019', 'right single quote', 'apostrophe quotation'],
      ['\u201C', 'left double quote', 'quotation'], ['\u201D', 'right double quote', 'quotation'], ['\u00AB', 'left guillemet', 'quotation angle'],
      ['\u00BB', 'right guillemet', 'quotation angle'], ['\u00A1', 'inverted exclamation', 'spanish'], ['\u00BF', 'inverted question', 'spanish'],
      ['\u00A7', 'section sign', 'law'], ['\u00B6', 'pilcrow', 'paragraph'], ['\u2020', 'dagger', 'footnote'], ['\u2021', 'double dagger', 'footnote'],
      ['\u2032', 'prime', 'feet minutes'], ['\u2033', 'double prime', 'inches seconds'], ['\u00B0', 'degree', 'temperature'],
      ['\u2116', 'numero', 'number'], ['\u203D', 'interrobang', 'question exclamation'], ['\u2042', 'asterism', 'stars'], ['\u00A9', 'copyright', 'c'],
      ['\u00AE', 'registered', 'trademark r'], ['\u2122', 'trade mark', 'tm'], ['\u2713', 'check mark', 'tick yes done'], ['\u2717', 'ballot x', 'cross no'],
      ['\u2605', 'black star', 'star rating'], ['\u2606', 'white star', 'star rating'], ['\u2665', 'heart suit', 'love card'], ['\u2660', 'spade suit', 'card'],
      ['\u2663', 'club suit', 'card'], ['\u2666', 'diamond suit', 'card'], ['\u266A', 'eighth note', 'music'], ['\u266B', 'beamed notes', 'music'] ] },
    { id: 'currency', name: 'Currency', items: [
      ['$', 'dollar', 'usd money'], ['\u20AC', 'euro', 'eur money'], ['\u00A3', 'pound', 'gbp sterling money'], ['\u00A5', 'yen', 'yuan jpy money'],
      ['\u00A2', 'cent', 'money'], ['\u20B9', 'rupee', 'inr india money'], ['\u20A9', 'won', 'krw korea money'], ['\u20BD', 'ruble', 'rub money'],
      ['\u20BF', 'bitcoin', 'btc crypto money'], ['\u20BA', 'lira', 'try turkey money'], ['\u20B4', 'hryvnia', 'uah money'], ['\u20A6', 'naira', 'ngn money'],
      ['\u20B1', 'peso', 'php money'], ['\u20AB', 'dong', 'vnd money'], ['\u20AA', 'shekel', 'ils money'], ['\u0E3F', 'baht', 'thb money'],
      ['\u20A1', 'colon', 'crc money'], ['\u20B8', 'tenge', 'kzt money'], ['\u00A4', 'currency sign', 'money'] ] },
    { id: 'math', name: 'Maths', items: [
      ['\u00B1', 'plus minus', 'math'], ['\u00D7', 'multiplication', 'times math'], ['\u00F7', 'division', 'divide math'], ['\u2212', 'minus', 'math'],
      ['\u2260', 'not equal', 'math'], ['\u2248', 'almost equal', 'approximately math'], ['\u2261', 'identical', 'equivalent math'], ['\u2264', 'less or equal', 'math'],
      ['\u2265', 'greater or equal', 'math'], ['\u221E', 'infinity', 'math'], ['\u221A', 'square root', 'math'], ['\u2211', 'sum', 'sigma math'],
      ['\u220F', 'product', 'pi math'], ['\u222B', 'integral', 'math'], ['\u2202', 'partial', 'derivative math'], ['\u2206', 'increment', 'delta math'],
      ['\u2207', 'nabla', 'gradient math'], ['\u2208', 'element of', 'in set math'], ['\u2209', 'not element of', 'set math'], ['\u2229', 'intersection', 'set math'],
      ['\u222A', 'union', 'set math'], ['\u2282', 'subset', 'set math'], ['\u2283', 'superset', 'set math'], ['\u2227', 'logical and', 'math'],
      ['\u2228', 'logical or', 'math'], ['\u00AC', 'not', 'logic math'], ['\u2200', 'for all', 'math'], ['\u2203', 'there exists', 'math'],
      ['\u2205', 'empty set', 'math'], ['\u221D', 'proportional', 'math'], ['\u2234', 'therefore', 'math'], ['\u2030', 'per mille', 'percent'],
      ['\u00BD', 'one half', 'fraction'], ['\u2153', 'one third', 'fraction'], ['\u00BC', 'one quarter', 'fraction'], ['\u00BE', 'three quarters', 'fraction'],
      ['\u00B9', 'superscript one', 'power'], ['\u00B2', 'superscript two', 'squared power'], ['\u00B3', 'superscript three', 'cubed power'],
      ['\u207F', 'superscript n', 'power'], ['\u03C0', 'pi', 'greek math'], ['\u00B5', 'micro', 'mu greek'], ['\u03B1', 'alpha', 'greek'],
      ['\u03B2', 'beta', 'greek'], ['\u03B3', 'gamma', 'greek'], ['\u03B4', 'delta', 'greek'], ['\u03B8', 'theta', 'greek'], ['\u03BB', 'lambda', 'greek'],
      ['\u03C3', 'sigma', 'greek'], ['\u03C9', 'omega', 'greek'], ['\u03A9', 'capital omega', 'ohm greek'], ['\u0394', 'capital delta', 'greek change'] ] },
    { id: 'arrows', name: 'Arrows', items: [
      ['\u2190', 'left arrow', ''], ['\u2192', 'right arrow', ''], ['\u2191', 'up arrow', ''], ['\u2193', 'down arrow', ''],
      ['\u2194', 'left right arrow', ''], ['\u2195', 'up down arrow', ''], ['\u2196', 'up left arrow', ''], ['\u2197', 'up right arrow', ''],
      ['\u2198', 'down right arrow', ''], ['\u2199', 'down left arrow', ''], ['\u21D0', 'left double arrow', 'implies'], ['\u21D2', 'right double arrow', 'implies'],
      ['\u21D1', 'up double arrow', ''], ['\u21D3', 'down double arrow', ''], ['\u21D4', 'left right double arrow', 'iff'], ['\u21A9', 'left hook arrow', 'return'],
      ['\u21AA', 'right hook arrow', ''], ['\u21BA', 'anticlockwise arrow', 'undo refresh'], ['\u21BB', 'clockwise arrow', 'redo refresh'],
      ['\u27F5', 'long left arrow', ''], ['\u27F6', 'long right arrow', ''], ['\u279C', 'heavy round arrow', 'right'], ['\u21E7', 'shift', 'up key'],
      ['\u2318', 'command key', 'mac'], ['\u2325', 'option key', 'mac'], ['\u232B', 'backspace', 'erase key'], ['\u23CE', 'return key', 'enter'], ['\u238B', 'escape key', 'esc'] ] },
  ];

  var KAOMOJI = [
    { id: 'happy', name: 'Happy', items: [
      ['(\u25D5\u203F\u25D5)', 'happy', 'smile'], ['(\u00B4\uFF61\u2022 \u1D55 \u2022\uFF61`)', 'happy', 'cute'], ['\u30FD(\u30FB\u2200\u30FB)\uFF89', 'happy', 'yay'],
      ['(\uFF3E\u25BD\uFF3E)', 'happy', 'grin'], ['(\u2267\u25E1\u2266)', 'happy', 'smile'], ['\\(^o^)/', 'cheer', 'yay happy'], ['(\u273F\u25E0\u203F\u25E0)', 'happy', 'flower'],
      ['(\u2310\u25A0_\u25A0)', 'cool', 'sunglasses'], ['( \u02D8 \u00B3\u02D8)\u2665', 'kiss', 'love'], ['(\u2665\u03C9\u2665)', 'love', 'heart eyes'] ] },
    { id: 'sad', name: 'Sad', items: [
      ['(\u2565\uFE4F\u2565)', 'crying', 'sad tears'], ['(\u3063\u02D8\u0329\u256D\u256E\u02D8\u0329)\u3063', 'sad', 'hug'], ['(\u00B4\uFF1B\u03C9\uFF1B`)', 'sad', 'tears'],
      ['(\u30CE_<\u3002)', 'sad', 'crying'], ['(-_-)', 'meh', 'unimpressed'], ['(\u00AC_\u00AC)', 'suspicious', 'side eye'] ] },
    { id: 'other', name: 'Other', items: [
      ['\u00AF\\_(\u30C4)_/\u00AF', 'shrug', 'whatever dunno'], ['(\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B', 'table flip', 'angry rage'],
      ['\u252C\u2500\u252C\u30CE( \u00BA _ \u00BA\u30CE)', 'put table back', 'calm'], ['( \u0361\u00B0 \u035C\u0296 \u0361\u00B0)', 'lenny', 'face'],
      ['\u0CA0_\u0CA0', 'disapproval', 'look'], ['(\u3065\uFFE3 \u00B3\uFFE3)\u3065', 'hug', 'kiss'], ['(\u2022_\u2022)', 'plain', 'neutral'],
      ['(\u0E07\u2019\u0300-\u2019\u0301)\u0E07', 'fight', 'fists'], ['\u0295\u2022\u1D25\u2022\u0294', 'bear', 'cute'], ['(=^\uFF65\u03C9\uFF65^=)', 'cat', 'cute'],
      ['(\u30FB\u03C9\u30FB)', 'cute', 'face'], ['\u2510(\u2018\uFF5E`;)\u250C', 'dunno', 'shrug'] ] },
  ];

  function wordsOf(name, kw) {
    var w = (name + ' ' + (kw || '').replace(/\|/g, ' ')).toLowerCase();
    return w.split(/[\s:,.\-\u2019'()]+/).filter(Boolean);
  }

  function mkItem(ch, name, kw, plan, group) {
    return { ch: ch, name: name, plan: plan, group: group, lname: name.toLowerCase(),
             kw: kw ? kw.toLowerCase().split('|') : [], words: wordsOf(name, kw), nameWords: wordsOf(name, '').length };
  }

  /** The bundled data as the page uses it: {emoji: [section], symbols: [...], kaomoji: [...], byChar}. */
  function catalogue(data) {
    var out = { emoji: [], symbols: [], kaomoji: [], byChar: Object.create(null) };
    var groups = (data && data.groups) || [];
    for (var g = 0; g < groups.length; g++) {
      var sec = { id: groups[g].id, name: GROUP_LABEL[groups[g].id] || groups[g].name, glyph: GROUP_GLYPH[groups[g].id] || '', items: [] };
      for (var i = 0; i < groups[g].items.length; i++) {
        var r = groups[g].items[i];
        var it = mkItem(r[0], r[1], r[2], planOf(r[3]), sec.id);
        sec.items.push(it);
        out.byChar[it.ch] = it;
      }
      out.emoji.push(sec);
    }
    var mk = function (list, tab) {
      return list.map(function (s) {
        return { id: s.id, name: s.name, items: s.items.map(function (r) { var it = mkItem(r[0], r[1], r[2], null, s.id); it.tab = tab; return it; }) };
      });
    };
    out.symbols = mk(SYMBOLS, 'symbols');
    out.kaomoji = mk(KAOMOJI, 'kaomoji');
    return out;
  }

  /* ---- search ------------------------------------------------------------------------------- */

  /* The most-used emoji, most first (Unicode, "Emoji Frequency", 2021): only a search tie-break, so
     "heart" puts the red heart near the top and "joy" the face before the cat. */
  var POPULAR = Array.from('😂❤️🤣👍😭🙏😘🥰😍😊🎉😁💕🥺😅🔥☺️🤦♥️🤷🙄😆🤗😉🎂🤔👏🙂😳🥳😎👌💜😔💪✨💖👀😋😏😢👉💗😩💯🌹💞🎈💙😃😡💐😜🙈🤞😄🤤🙌🤪❣️😀💋💀👇💔😌💓🤩🙃😬😱😴🤭😐🌞😒😇🌸😈🎶✌️🎊🥵😞💚☀️🖤💰😚👑🎁💥🙋☹️😑🥴👈💩✅')
    .reduce(function (a, c) { if (c === '️') a[a.length - 1] += c; else a.push(c); return a; }, []);

  function norm(q) { return String(q == null ? '' : q).toLowerCase().replace(/\s+/g, ' ').trim(); }

  /** One item's score for the query tokens, 0 = no match. Every token must start a word of the name
      or a keyword ("hea" finds heart and face with head-bandage, never "the"), with a looser
      substring rule for tokens of 3+ letters ("rocket" in "rocketship"). */
  function score(it, q, toks) {
    if (it.lname === q) return 1000;
    var s = 0, weak = true;
    for (var t = 0; t < toks.length; t++) {
      var tok = toks[t], best = 0;
      for (var w = 0; w < it.words.length; w++) {
        var word = it.words[w], inName = w < it.nameWords;
        if (word === tok) best = Math.max(best, inName ? 200 : 120);
        else if (word.indexOf(tok) === 0) best = Math.max(best, inName ? 80 : 40);
        else if (tok.length >= 3 && word.indexOf(tok) > 0) best = Math.max(best, 10);
      }
      if (!best) return 0;
      if (best > 10) weak = false;
      s += best;
    }
    if (it.lname.indexOf(q) === 0) s += 40;                   // the name starts with what was typed
    var last = it.words[it.nameWords - 1];
    if (last && last === toks[toks.length - 1]) s += 30;     // ...or ends with it: "red heart" is a heart
    var pop = POPULAR.indexOf(it.ch);
    if (pop >= 0 && !weak) s += 25 - pop * 0.2;                       // what people pick most (Unicode's emoji frequency list)
    return s - it.nameWords * 3;                             // then the plainer name
  }

  /** Items of `sections` matching `query`, best first (ties keep Unicode's order). */
  function search(sections, query, limit) {
    var q = norm(query);
    if (!q) return [];
    var toks = q.split(' ');
    var hits = [];
    var at = 0;
    for (var s = 0; s < sections.length; s++) {
      for (var i = 0; i < sections[s].items.length; i++) {
        var it = sections[s].items[i];
        var sc = score(it, q, toks);
        if (sc) hits.push({ it: it, sc: sc, at: at });
        at++;
      }
    }
    hits.sort(function (a, b) { return b.sc - a.sc || a.at - b.at; });
    return hits.slice(0, limit || 160).map(function (h) { return h.it; });
  }

  /* ---- recents -------------------------------------------------------------------------------- */

  /** Recents after `ch` was typed: newest first, no repeats, at most RECENT_MAX. */
  function remember(list, ch) {
    var out = [ch];
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length && out.length < RECENT_MAX; i++) {
      if (typeof src[i] === 'string' && src[i] && src[i] !== ch) out.push(src[i]);
    }
    return out;
  }

  /** The stored recents as items: what was typed is shown as typed (with its tone), named from the base. */
  function recentItems(list, cat) {
    var out = [];
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length && out.length < RECENT_MAX; i++) {
      var ch = src[i];
      if (typeof ch !== 'string' || !ch || ch.length > 64) continue;
      var base = cat.byChar[ch] || cat.byChar[stripTone(ch)];
      out.push({ ch: ch, name: base ? base.name : ch, plan: null, group: 'recent', lname: '', kw: [], words: [], fixed: true });
    }
    return out;
  }

  function stripTone(ch) {
    var out = '';
    var seq = Array.from(ch);
    for (var i = 0; i < seq.length; i++) {
      var c = seq[i].codePointAt(0);
      if (c >= 0x1F3FB && c <= 0x1F3FF) {
        // the FE0F the tone replaced comes back when the base has one (U+261D, U+270C ...)
        if (i === 1 && /[\u2600-\u27BF]/.test(seq[0])) out += '\uFE0F';
        continue;
      }
      out += seq[i];
    }
    return out;
  }

  /* ---- keyboard ------------------------------------------------------------------------------ */

  /** The grid's rows: each section starts a new row of up to `cols` cells. `counts` = items per section. */
  function layout(counts, cols) {
    var rows = [];
    var at = 0;
    for (var s = 0; s < counts.length; s++) {
      for (var i = 0; i < counts[s]; i += cols) {
        var row = [];
        for (var k = i; k < Math.min(counts[s], i + cols); k++) row.push(at + k);
        rows.push(row);
      }
      at += counts[s];
    }
    return rows;
  }

  /** The new selection (a flat index) after `key` in the grid laid out as `rows`. */
  function move(rows, sel, key, page) {
    if (!rows.length) return -1;
    var total = rows[rows.length - 1][rows[rows.length - 1].length - 1] + 1;
    if (sel < 0 || sel >= total) return 0;
    var r = 0;
    while (r < rows.length - 1 && rows[r][rows[r].length - 1] < sel) r++;
    var col = sel - rows[r][0];
    var to = function (row) { row = Math.max(0, Math.min(rows.length - 1, row)); return rows[row][Math.min(col, rows[row].length - 1)]; };
    switch (key) {
      case 'ArrowRight': return Math.min(total - 1, sel + 1);
      case 'ArrowLeft': return Math.max(0, sel - 1);
      case 'ArrowDown': return to(r + 1);
      case 'ArrowUp': return to(r - 1);
      case 'PageDown': return to(r + (page || 5));
      case 'PageUp': return to(r - (page || 5));
      case 'Home': return 0;
      case 'End': return total - 1;
    }
    return sel;
  }

  /** What a key does in the panel: {do:'insert'|'close'|'move'|'type'|'back'|'clear'|'tab'|'none', ...}.
      `k` = {key, shift, text}; keys arrive from the sidecar's watch (the app keeps the focus) or, when
      the panel itself has the keyboard, from the page's own keydown. */
  function keyAction(k, closeAfter) {
    var key = k && k.key;
    if (key === 'Escape') return { do: 'close' };
    if (key === 'Enter') return { do: 'insert', close: !!closeAfter !== !!k.shift };
    if (key === 'Backspace') return { do: 'back' };
    if (key === 'Delete') return { do: 'clear' };
    if (key === 'Tab') return { do: 'tab', back: !!k.shift };
    if (/^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/.test(key || '')) return { do: 'move', key: key };
    if (k && typeof k.text === 'string' && k.text.length === 1 && k.text >= ' ') return { do: 'type', text: k.text };
    return { do: 'none' };
  }

  /* ---- placement ----------------------------------------------------------------------------- */

  /** The window rectangle (DIP, panel + MARGIN round it) near `anchor` {x, y, h}: just under the
      caret line, or above it when there is no room under; always inside `work`. */
  function place(anchor, work, size) {
    var w = (size && size.w) || PANEL_W + 2 * MARGIN;
    var h = (size && size.h) || PANEL_H + 2 * MARGIN;
    if (!anchor || !isFinite(anchor.x) || !isFinite(anchor.y)) {
      return { x: Math.round(work.x + (work.width - w) / 2), y: Math.round(work.y + (work.height - h) / 2), width: w, height: h };
    }
    var ax = Math.round(anchor.x), ay = Math.round(anchor.y);
    var ah = anchor && anchor.h > 0 ? anchor.h : 0;
    var x = ax - MARGIN;
    var y = ay + 6 - MARGIN;                                 // the pane's top 6 DIP under the caret's foot
    if (y + h > work.y + work.height) y = ay - ah - 6 - h + MARGIN;   // above the caret line
    x = Math.max(work.x, Math.min(x, work.x + work.width - w));
    y = Math.max(work.y, Math.min(y, work.y + work.height - h));
    return { x: Math.round(x), y: Math.round(y), width: w, height: h };
  }

  return {
    PANEL_W: PANEL_W, PANEL_H: PANEL_H, MARGIN: MARGIN, COLS: COLS, RECENT_MAX: RECENT_MAX, TONES: TONES, TONE_NAMES: TONE_NAMES,
    withTone: withTone, planOf: planOf, display: display, clampTone: clampTone, stripTone: stripTone,
    catalogue: catalogue, norm: norm, search: search, remember: remember, recentItems: recentItems,
    layout: layout, move: move, keyAction: keyAction, place: place,
    GROUP_GLYPH: GROUP_GLYPH, GROUP_LABEL: GROUP_LABEL,
  };
});
