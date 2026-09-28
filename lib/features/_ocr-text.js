'use strict';
/*
 * _ocr-text.js - the screenshot overlay's "Copy text" mode, the pure half (ocr lane, 2026-09-27):
 * what Windows' OCR hands back (sidecar/Ocr.cs: one entry per line, in reading order, with the
 * line's box in physical px) becomes the plain text that goes on the clipboard, and the one-line
 * confirmation the card shows. lib/features/_ocr-text.test.js checks it; no Electron, no sidecar.
 *
 * PRIVACY: nothing here logs. `logLine()` is the ONLY thing about a recognition that may reach the
 * log, and it is counts and timings by construction (it never sees the text).
 */

const EOL = '\r\n';              // Windows' own line break: what Notepad, Word and a <textarea> expect
const PREVIEW_CHARS = 40;

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One line's text, tidied: every run of whitespace (tabs, NBSP, stray breaks) is one space; no ends. */
function tidy(s) {
  return String(s == null ? '' : s).replace(/[\s  -​　]+/g, ' ').trim();
}

/**
 * Where a paragraph ends: a vertical gap between two consecutive lines well past the usual one.
 * lines: [{y, h}] in reading order. Returns a Set of indices i such that a blank line goes
 * BEFORE lines[i]. With fewer than two ordinary gaps to compare against, a gap has to exceed
 * 1.5 line heights; otherwise it has to exceed both one line height and 1.7x the median gap.
 * A line that starts ABOVE the previous one (the next column, a text box to the side) is never
 * a paragraph break: it just starts a new line.
 */
function paragraphBreaks(lines) {
  const out = new Set();
  const boxed = lines.every((l) => l && Number.isFinite(l.y) && Number.isFinite(l.h) && l.h > 0);
  if (!boxed || lines.length < 2) return out;
  const hs = lines.map((l) => l.h);
  const H = median(hs);
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i].y - (lines[i - 1].y + lines[i - 1].h);
    gaps.push(g);
  }
  const positive = gaps.filter((g) => g > 0);
  const limit = positive.length >= 2 ? Math.max(H, 1.7 * median(positive)) : 1.5 * H;
  for (let i = 1; i < lines.length; i++) if (gaps[i - 1] > limit) out.add(i);
  return out;
}

/**
 * OCR lines -> the clipboard text. `lines` is the sidecar's list ({text, x, y, w, h}) or plain
 * strings. Blank lines are dropped, each line is tidied, lines are joined with CRLF, and a blank
 * line marks a paragraph gap (paragraphBreaks). Returns {text, lines, chars}; text '' = nothing.
 */
function shape(lines) {
  const kept = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const o = typeof l === 'string' ? { text: l } : (l || {});
    const t = tidy(o.text);
    if (t) kept.push({ text: t, y: Number(o.y), h: Number(o.h) });
  }
  if (!kept.length) return { text: '', lines: 0, chars: 0 };
  const breaks = paragraphBreaks(kept);
  const parts = [];
  kept.forEach((l, i) => { if (breaks.has(i)) parts.push(''); parts.push(l.text); });
  const text = parts.join(EOL);
  return { text, lines: kept.length, chars: text.length };
}

/** The first ~40 characters on one line (breaks shown as a space), with an ellipsis when cut. */
function preview(text, n) {
  const max = n || PREVIEW_CHARS;
  const flat = tidy(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp >= max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '') + '…';
}

/** What the card says: "Copied 3 lines", and the preview under it (the card shows both). */
function headline(shaped) {
  if (!shaped || !shaped.lines) return 'No text found in that area';
  return `Copied ${shaped.lines} line${shaped.lines === 1 ? '' : 's'}`;
}

/** The ONLY log line about a recognition: counts and timings, never the text. */
function logLine(shaped, ms, extra) {
  const n = shaped ? shaped.lines : 0;
  const c = shaped ? shaped.chars : 0;
  return `ocr: ${n} line${n === 1 ? '' : 's'}, ${c} char${c === 1 ? '' : 's'}, ${Math.round(ms)} ms${extra ? ` (${extra})` : ''}`;
}

/** 1 - Levenshtein distance / the longer length: 1 is identical, 0 is nothing alike (tests). */
function similarity(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a.length && !b.length) return 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

module.exports = { EOL, PREVIEW_CHARS, tidy, paragraphBreaks, shape, preview, headline, logLine, similarity, median };
