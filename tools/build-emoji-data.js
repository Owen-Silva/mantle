'use strict';
/*
 * tools/build-emoji-data.js - builds ui/emoji/emoji-data.js, the emoji picker's bundled data (lane
 * mantle-emoji, 2026-10-15; plan design notes: mantle-replace-windows P11). Run by hand when the data
 * should move to a newer Unicode release; the output is committed, so Mantle never fetches anything.
 *
 * SOURCES (all Unicode, Inc. data under the Unicode License v3, a permissive licence that asks for its
 * notice to travel with the data: ui/emoji/DATA-LICENSE.txt):
 *   emoji-test.txt       https://unicode.org/Public/emoji/15.1/emoji-test.txt   the list, its order, groups
 *   en.json              cldr-json cldr-annotations-full/annotations/en          names + search keywords
 *   en-derived.json      cldr-json cldr-annotations-derived-full/annotationsDerived/en   flags, keycaps, ...
 *
 * WHAT WINDOWS CAN DRAW: the picker renders with Segoe UI Emoji, as Windows' panel does, so an emoji the
 * font has no single glyph for (a newer ZWJ sequence draws as two pictures side by side) is left out.
 * Decided from the font itself (--font, default C:\Windows\Fonts\seguiemj.ttf): its cmap for single
 * code points, and its GSUB ligatures (applied in lookup order until nothing changes) for sequences.
 *
 *   node tools/build-emoji-data.js --src=<dir with the three files> [--font=<ttf>] [--out=<file>]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('src', null);
const FONT = arg('font', 'C:\\Windows\\Fonts\\seguiemj.ttf');
const OUT = arg('out', path.join(__dirname, '..', 'ui', 'emoji', 'emoji-data.js'));
if (!SRC) { console.error('usage: node tools/build-emoji-data.js --src=<dir> [--font=<ttf>] [--out=<file>]'); process.exit(2); }

const TONES = [0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF];
const FE0F = 0xFE0F;
const cps = (s) => Array.from(s).map((c) => c.codePointAt(0));
const str = (a) => String.fromCodePoint(...a);

/* ---- the font: its cmap (format 12) for single code points ---- */
function readCmap(file) {
  const b = fs.readFileSync(file);
  let cmapAt = 0;
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (b.toString('latin1', o, o + 4) === 'cmap') cmapAt = b.readUInt32BE(o + 8);
  }
  const cmap = new Set();
  const nSub = b.readUInt16BE(cmapAt + 2);
  for (let i = 0; i < nSub; i++) {
    const sub = cmapAt + b.readUInt32BE(cmapAt + 4 + i * 8 + 4);
    if (b.readUInt16BE(sub) !== 12) continue;
    const groups = b.readUInt32BE(sub + 12);
    for (let g = 0; g < groups; g++) {
      const q = sub + 16 + g * 12;
      for (let c = b.readUInt32BE(q); c <= b.readUInt32BE(q + 4); c++) cmap.add(c);
    }
  }
  return cmap;
}

/* Sequences: the font's GSUB (chained contexts, then ligatures) is a shaper's job, so they are judged by
   tools/measure-emoji-glyphs.js, which lets Chromium's HarfBuzz shape each one with the real font and
   records the ones that come out as ONE picture (--glyphs=<its JSON>). */
const GLYPHS = arg('glyphs', null);
const measured = GLYPHS ? new Set(JSON.parse(fs.readFileSync(GLYPHS, 'utf8')).one) : null;

/** One picture for the whole sequence in Segoe UI Emoji? */
function drawable(cmap, seq) {
  const core = seq.filter((c) => c !== FE0F);
  if (!core.every((c) => cmap.has(c))) return false;
  if (core.length === 1) return true;
  if (!measured) { if (!drawable.warned) console.warn('PROVISIONAL: no --glyphs, so every sequence is assumed drawable'); drawable.warned = true; return true; }
  return measured.has(str(seq));
}

/* ---- the Unicode list ---- */
function readTest(file) {
  const groups = [];
  let group = null, sub = null;
  const fq = new Set();
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let m = /^# group: (.+)$/.exec(line);
    if (m) { group = { name: m[1].trim(), items: [] }; groups.push(group); continue; }
    m = /^# subgroup: (.+)$/.exec(line);
    if (m) { sub = m[1].trim(); continue; }
    m = /^([0-9A-F ]+?)\s*;\s*(fully-qualified|minimally-qualified|unqualified|component)\s*#\s*\S+\s+E([\d.]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const seq = m[1].trim().split(/\s+/).map((h) => parseInt(h, 16));
    if (m[2] !== 'fully-qualified') continue;
    const s = str(seq);
    fq.add(s);
    rows.push({ s, seq, group, sub, ver: m[3], name: m[4].trim() });
  }
  return { groups, fq, rows };
}

function readCldr(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a = (j.annotations || j.annotationsDerived || {}).annotations || {};
    return a;
  } catch (e) { console.error(`could not read ${file}: ${e.message}`); return {}; }
}

/* The tone rule is the picker's own (ui/emoji/model.js withTone), so what is checked here is exactly
   what the page will type. */
const { withTone } = require('../ui/emoji/model.js');

/** Where the tone goes for the all-one-tone variant of `s` (code point indices), or null if none. */
function tonePlan(s, fq) {
  const seq = cps(s);
  const fits = (plan) => TONES.every((t) => fq.has(withTone(s, plan, t)));
  if (fits([0])) return [0];
  const idx = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== 0x200D && seq[i] !== FE0F && TONES.every((t) => fq.has(str([seq[i], t])))) idx.push(i);
  }
  if (idx.length > 1 && fits(idx)) return idx;
  // people holding hands: the people take the tone, the handshake between them does not
  for (let drop = 0; drop < idx.length && idx.length > 2; drop++) {
    const p = idx.filter((_, k) => k !== drop);
    if (fits(p)) return p;
  }
  return null;
}

const GROUP_ID = {
  'Smileys & Emotion': 'smileys', 'People & Body': 'people', 'Animals & Nature': 'nature', 'Food & Drink': 'food',
  'Travel & Places': 'travel', 'Activities': 'activities', 'Objects': 'objects', 'Symbols': 'symbols', 'Flags': 'flags',
};

function main() {
  const cmap = readCmap(FONT);
  const test = readTest(path.join(SRC, 'emoji-test.txt'));
  const ann = Object.assign({}, readCldr(path.join(SRC, 'en-derived.json')), readCldr(path.join(SRC, 'en.json')));
  const toneOf = new Set(TONES.map((t) => String.fromCodePoint(t)));
  const out = [];
  const dropped = [];
  let kept = 0, toned = 0;
  for (const g of test.groups) {
    const id = GROUP_ID[g.name];
    if (!id) continue;                          // "Component": the tones and hair pieces on their own
    out.push({ id, name: g.name, items: [] });
  }
  const byId = new Map(out.map((g) => [g.id, g]));
  for (const r of test.rows) {
    const g = byId.get(GROUP_ID[r.group.name]);
    if (!g) continue;
    if (r.seq.some((c) => toneOf.has(String.fromCodePoint(c)))) continue;   // tone variants come from the base
    if (!drawable(cmap, r.seq)) { dropped.push(`${r.s} ${r.name} (E${r.ver})`); continue; }
    const key = r.s.replace(/\uFE0F/g, '');
    const a = ann[r.s] || ann[key] || {};
    const name = (a.tts && a.tts[0]) || r.name;
    const words = new Set();
    for (const w of (a.default || [])) {
      const lw = w.toLowerCase();
      if (lw !== name.toLowerCase()) words.add(lw);
    }
    let plan = tonePlan(r.s, test.fq);
    if (plan) {
      // only if Segoe draws every toned variant as one picture
      const ok = TONES.every((t) => drawable(cmap, cps(withTone(r.s, plan, t))));
      if (!ok) plan = null;
    }
    const item = [r.s, name, Array.from(words).join('|')];
    if (plan) { item.push(plan.length === 1 && plan[0] === 0 ? 1 : plan.join(',')); toned++; }
    g.items.push(item);
    kept++;
  }
  const meta = {
    source: 'Unicode emoji-test.txt 15.1 + CLDR annotations (en), Unicode License v3 (ui/emoji/DATA-LICENSE.txt)',
    font: path.basename(FONT), kept, toned, dropped: dropped.length,
  };
  const body = `/* emoji-data.js - GENERATED by tools/build-emoji-data.js; do not edit by hand.
 * ${meta.source}.
 * Only what ${meta.font} draws as one picture: ${kept} emoji kept (${toned} take a skin tone), ${dropped.length} left out.
 * Item: [emoji, name, keywords joined by |, tone plan?]. Tone plan 1 = the tone goes after the first code
 * point; "0,4" = after those code points (FE0F removed first). */
(function (root) {
  var DATA = ${JSON.stringify({ v: 1, tones: TONES, groups: out })};
  if (typeof module === 'object' && module.exports) module.exports = DATA;
  else root.MantleEmojiData = DATA;
})(this);
`;
  fs.writeFileSync(OUT, body);
  console.log(`wrote ${OUT}: ${(body.length / 1024).toFixed(0)} KB, ${kept} kept, ${toned} toned, ${dropped.length} dropped`);
  if (dropped.length) console.log('dropped (first 40):\n  ' + dropped.slice(0, 40).join('\n  '));
}

main();
