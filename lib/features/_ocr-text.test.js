// _ocr-text.test.js - the Copy text mode's pure half (lib/features/_ocr-text.js): OCR lines in,
// clipboard text / card words / log line out. No Electron, no sidecar, no screen.
//
//   node lib/features/_ocr-text.test.js
'use strict';
const X = require('./_ocr-text.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + JSON.stringify(detail) : ''));
}
const L = (text, y, h) => ({ text, x: 10, y, w: 200, h: h || 14 });

/* ---- empty ----------------------------------------------------------------------------------- */
for (const [what, v] of [['no lines', []], ['null', null], ['not a list', 'x'], ['only blanks', [L('', 0), L('   ', 20), L('\t ', 40)]]]) {
  const s = X.shape(v);
  check(`empty (${what}): no text, 0 lines, 0 chars`, s.text === '' && s.lines === 0 && s.chars === 0, s);
}
check('empty: the card says "No text found in that area"', X.headline(X.shape([])) === 'No text found in that area');

/* ---- trimming ---------------------------------------------------------------------------------- */
{
  const s = X.shape([L('   Question 7:   A  train\tleaves  ', 0)]);
  check('trim: ends trimmed, inner runs of spaces/tabs are one space', s.text === 'Question 7: A train leaves', s.text);
  check('trim: one line, chars = its length', s.lines === 1 && s.chars === 'Question 7: A train leaves'.length, s);
  check('trim: NBSP and ideographic space count as spaces', X.tidy('a  b　c') === 'a b c');
  check('trim: a line break inside one OCR line becomes a space', X.tidy('a\r\nb') === 'a b');
}

/* ---- line joining -------------------------------------------------------------------------------- */
{
  // Three evenly spaced lines (pitch 20, box 14: gap 6) -> CRLF between each, no blank lines.
  const s = X.shape([L('one', 0), L('two', 20), L('three', 40)]);
  check('join: evenly spaced lines are joined with CRLF (Windows line breaks)', s.text === 'one\r\ntwo\r\nthree', s.text);
  check('join: 3 lines counted', s.lines === 3);
  check('join: chars counts the CRLFs too (what is on the clipboard)', s.chars === 'one\r\ntwo\r\nthree'.length);
  // Blank OCR lines in the middle are dropped, not turned into gaps.
  const d = X.shape([L('a', 0), L(' ', 10), L('b', 20)]);
  check('join: an empty line in the middle is dropped', d.text === 'a\r\nb' && d.lines === 2, d);
  // Plain strings (no boxes) join with no paragraph guessing.
  check('join: plain strings join line by line', X.shape(['x', 'y']).text === 'x\r\ny');
}

/* ---- paragraph gaps -------------------------------------------------------------------------------- */
{
  // A question stem, a big gap, then the answer choices: a blank line marks the gap.
  const q = [L('Which is a prime number?', 0), L('Pick one.', 20), L('A) 21', 70), L('B) 23', 90), L('C) 25', 110)];
  const s = X.shape(q);
  check('paragraph: a gap well past the usual one becomes a blank line', s.text === 'Which is a prime number?\r\nPick one.\r\n\r\nA) 21\r\nB) 23\r\nC) 25', s.text);
  check('paragraph: the blank line is not counted as a line', s.lines === 5, s.lines);
  // Two lines only: a gap over 1.5 line heights breaks, an ordinary one does not.
  check('paragraph: two lines far apart get a blank line', X.shape([L('a', 0), L('b', 60)]).text === 'a\r\n\r\nb');
  check('paragraph: two ordinary lines do not', X.shape([L('a', 0), L('b', 20)]).text === 'a\r\nb');
  // A line that starts ABOVE the last one (the next column) is a new line, never a paragraph break.
  check('paragraph: the next column (moving up) is just a new line', X.shape([L('a', 0), L('b', 20), L('c', 40), L('d', 0)]).text === 'a\r\nb\r\nc\r\nd');
  // Lines without boxes never guess.
  check('paragraph: no boxes, no guessing', X.paragraphBreaks([{ y: NaN, h: 1 }, { y: 100, h: 1 }]).size === 0);
  // A generous line height (gap = 1.1 box heights, evenly) is still one paragraph.
  check('paragraph: evenly loose lines stay one paragraph', X.shape([L('a', 0), L('b', 30), L('c', 60), L('d', 90)]).text === 'a\r\nb\r\nc\r\nd');
}

/* ---- the card and the log -------------------------------------------------------------------------- */
{
  const s = X.shape([L('Question 7: A train leaves the station at 3:45 PM', 0), L('traveling 62 miles per hour.', 20), L('How far?', 40)]);
  check('card: "Copied 3 lines"', X.headline(s) === 'Copied 3 lines', X.headline(s));
  check('card: "Copied 1 line" (singular)', X.headline(X.shape(['x'])) === 'Copied 1 line');
  const p = X.preview(s.text);
  check('preview: at most ~40 characters and an ellipsis when cut', p.length <= 41 && p.endsWith('…'), p);
  check('preview: cut at a word boundary', p === 'Question 7: A train leaves the station…', p);
  check('preview: line breaks show as spaces', X.preview('ab\r\ncd') === 'ab cd');
  check('preview: short text is shown whole, no ellipsis', X.preview('Hello') === 'Hello');
  const log = X.logLine(s, 142.4, 'ocr 15 ms at 2x, en-US');
  check('log: counts and timings', log === `ocr: 3 lines, ${s.chars} chars, 142 ms (ocr 15 ms at 2x, en-US)`, log);
  check('log: never the text', !/Question|train|miles|How far/.test(log), log);
  check('log: nothing found', X.logLine(X.shape([]), 30) === 'ocr: 0 lines, 0 chars, 30 ms');
}

/* ---- similarity (the tests' accuracy score) --------------------------------------------------------- */
check('similarity: identical is 1', X.similarity('abc', 'abc') === 1);
check('similarity: both empty is 1', X.similarity('', '') === 1);
check('similarity: one wrong char in 10 is 0.9', Math.abs(X.similarity('abcdefghij', 'abcdefghiX') - 0.9) < 1e-9);
check('similarity: nothing alike is 0', X.similarity('aaa', 'bbb') === 0);

console.log(`ocr-text unit: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
