/* calc.js — the launcher's calculator row: a small arithmetic parser, NEVER eval.
 *
 * WHY A PARSER. The query box is text anyone (or anything pasted) can put in; eval or new
 * Function on it would run code inside the launcher page. This file only knows numbers, the
 * operators below, a fixed list of functions and constants, and nothing else — an identifier it
 * does not know makes the whole query "not a calculation", so a file name like "notes-2" never
 * turns into arithmetic.
 *
 * WHEN IT ANSWERS. Only for something that is plainly a calculation: at least one operator, or a
 * function call, and every token understood. A bare number ("42"), a bare constant ("e") or
 * half-typed input ("2+") answers null — typing is not a failure, and a calculator row that
 * flickers in and out on every keystroke would bury the app you are looking for. ISO dates
 * ("2026-09-24") answer null too: they parse as subtraction, and nobody typing a date wants 1993.
 *
 * WHEN IT CANNOT. Something that IS a calculation but has no answer (1/0, sqrt(-1), 171!) comes
 * back { ok:false, reason } in plain words, and the launcher shows that row — no silent nothing.
 *
 *   evaluate('2*(3+4)')   -> { ok:true, value:14, display:'14', copy:'14', expr:'2*(3+4)' }
 *   evaluate('15% of 80') -> { ok:true, value:12, ... }
 *   evaluate('1/0')       -> { ok:false, reason:'cannot divide by zero', expr:'1/0' }
 *   evaluate('notes')     -> null
 *
 * Grammar (highest binding last):
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '×' | '÷' | 'x' | 'mod' | '%' | 'of') unary | implicit-mul)*
 *   unary   := ('+' | '-') unary | power
 *   power   := postfix (('^' | '**') unary)?            right-associative; -2^2 = -4
 *   postfix := primary ('!' | '%' | '°')*               '%' is percent unless an operand follows
 *   primary := number | constant | func '(' args ')' | '(' expr ')'
 * UMD: a <script> in the sandboxed launcher page (window.MantleCalc) and require() in node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FUNCS = {
    sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs],
    round: [1, Math.round], floor: [1, Math.floor], ceil: [1, Math.ceil],
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
    asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
    ln: [1, Math.log], log: [1, Math.log10], log2: [1, Math.log2], log10: [1, Math.log10],
    exp: [1, Math.exp],
    min: [-1, Math.min], max: [-1, Math.max], pow: [2, Math.pow],
  };
  var CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI };
  var TRIG = { sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1 };
  var MAX_LEN = 200;

  function CalcError(reason) { this.reason = reason; }        // "a calculation, with no answer"
  function NotMath() { }                                      // "not a calculation at all"

  /* ---- tokens ------------------------------------------------------------ */
  function tokenize(src) {
    var out = [], i = 0, m;
    while (i < src.length) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      var rest = src.slice(i);
      if ((m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest))) {
        // "3e" / "3e-" at the END is an exponent being typed, not 3 times Euler's number
        if (/^[eE][+-]?$/.test(rest.slice(m[0].length))) throw new NotMath();
        out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
      }
      if (rest.slice(0, 2) === '**') { out.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/^()%!,°'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
      if (c === '×' || c === '·') { out.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '÷') { out.push({ t: 'op', v: '/' }); i++; continue; }
      if (c === '−') { out.push({ t: 'op', v: '-' }); i++; continue; }     // a typographic minus
      if (c === 'π') { out.push({ t: 'id', v: 'π' }); i++; continue; }
      if ((m = /^[a-z][a-z0-9]*/i.exec(rest))) {
        var w = m[0].toLowerCase();
        // "log2" and "log10" are names; any other letters-then-digits run ("x3") splits
        if (!FUNCS[w] && /\d/.test(w)) w = /^[a-z]+/.exec(w)[0];
        i += w.length;
        if (w === 'x') out.push({ t: 'op', v: '*' });
        else if (w === 'mod') out.push({ t: 'op', v: 'mod' });
        else if (w === 'of') out.push({ t: 'op', v: 'of' });
        else if (FUNCS[w] || CONSTS[w] !== undefined) out.push({ t: 'id', v: w });
        else throw new NotMath();                           // an unknown word: not arithmetic
        continue;
      }
      throw new NotMath();
    }
    return out;
  }

  /* ---- the parser ---------------------------------------------------------- */
  function Parser(tokens) {
    this.k = tokens; this.i = 0;
    this.ops = 0;          // binary operators, postfix operators and calls seen: "is it a calculation?"
    this.trig = false;
  }
  Parser.prototype.peek = function () { return this.k[this.i]; };
  Parser.prototype.isOp = function (v) { var t = this.k[this.i]; return !!t && t.t === 'op' && t.v === v; };
  Parser.prototype.startsOperand = function (t) {
    return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && (t.v === '(' || t.v === '-' || t.v === '+')));
  };

  Parser.prototype.expr = function () {
    var v = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      var op = this.k[this.i++].v; this.ops++;
      var r = this.term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  Parser.prototype.term = function () {
    var v = this.unary();
    for (;;) {
      var t = this.peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === 'mod' || t.v === 'of' ||
                                (t.v === '%' && this.startsOperand(this.k[this.i + 1])))) {
        this.i++; this.ops++;
        var r = this.unary();
        if (t.v === '*' || t.v === 'of') v = v * r;
        else if (t.v === '/') { if (r === 0) throw new CalcError('cannot divide by zero'); v = v / r; }
        else { if (r === 0) throw new CalcError('cannot take a remainder by zero'); v = v % r; }
        continue;
      }
      // implicit multiplication: "2pi", "2(3+4)", "(1+2)(3+4)", "3 sqrt(4)"
      if (t && (t.t === 'id' || (t.t === 'op' && t.v === '('))) {
        this.ops++;
        v = v * this.unary();
        continue;
      }
      return v;
    }
  };

  Parser.prototype.unary = function () {
    if (this.isOp('-')) { this.i++; return -this.unary(); }
    if (this.isOp('+')) { this.i++; return this.unary(); }
    return this.power();
  };

  Parser.prototype.power = function () {
    var base = this.postfix();
    if (this.isOp('^')) {
      this.i++; this.ops++;
      var ex = this.unary();                              // right-assoc: 2^3^2 = 2^9
      return Math.pow(base, ex);
    }
    return base;
  };

  Parser.prototype.postfix = function () {
    var v = this.primary();
    for (;;) {
      if (this.isOp('!')) {
        this.i++; this.ops++;
        if (v < 0 || Math.floor(v) !== v) throw new CalcError('factorial needs a whole number that is not negative');
        if (v > 170) throw new CalcError('the answer is too large to show');
        var f = 1; for (var n = 2; n <= v; n++) f *= n;
        v = f;
        continue;
      }
      if (this.isOp('%') && !this.startsOperand(this.k[this.i + 1])) { this.i++; this.ops++; v = v / 100; continue; }
      if (this.isOp('°')) { this.i++; this.ops++; v = v * Math.PI / 180; continue; }
      return v;
    }
  };

  Parser.prototype.primary = function () {
    var t = this.k[this.i++];
    if (!t) throw new NotMath();                          // ran out: still being typed
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      var v = this.expr();
      if (!this.isOp(')')) throw new NotMath();           // "(2+3" is half-typed, not wrong
      this.i++;
      return v;
    }
    if (t.t === 'id') {
      if (CONSTS[t.v] !== undefined && !FUNCS[t.v]) return CONSTS[t.v];
      var fn = FUNCS[t.v];
      if (!this.isOp('(')) throw new NotMath();           // "sqrt" alone: still typing
      this.i++; this.ops++;
      var args = [];
      if (!this.isOp(')')) {
        args.push(this.expr());
        while (this.isOp(',')) { this.i++; args.push(this.expr()); }
      }
      if (!this.isOp(')')) throw new NotMath();
      this.i++;
      if (fn[0] >= 0 && args.length !== fn[0]) {
        throw new CalcError(t.v + '() takes ' + fn[0] + (fn[0] === 1 ? ' number' : ' numbers') + ', not ' + args.length);
      }
      if (!args.length) throw new CalcError(t.v + '() needs at least one number');
      if (TRIG[t.v]) this.trig = true;
      return fn[1].apply(null, args);
    }
    throw new NotMath();
  };

  /* ---- formatting ---------------------------------------------------------- */
  /* 12 significant digits hides binary noise (0.1+0.2 -> 0.3) and is more than any display
     needs. Very large or very small answers go to exponent form, grouped digits otherwise. */
  function tidy(v) { return Number(v.toPrecision(12)); }

  function copyText(v) {
    var n = tidy(v);
    if (n === 0) return '0';                              // never "-0"
    var s = String(n);
    return s.replace(/e\+/, 'e');
  }

  function display(v) {
    var n = tidy(v);
    if (n === 0) return '0';
    var a = Math.abs(n);
    if (a >= 1e15 || a < 1e-6) {
      var parts = n.toExponential(9).split('e');
      var mant = parts[0].replace(/\.?0+$/, '');
      return mant + ' × 10^' + parts[1].replace('+', '');
    }
    var fixed = String(n);
    var neg = fixed[0] === '-';
    if (neg) fixed = fixed.slice(1);
    var dot = fixed.indexOf('.');
    var int = dot >= 0 ? fixed.slice(0, dot) : fixed;
    var frac = dot >= 0 ? fixed.slice(dot) : '';
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '−' : '') + int + frac;
  }

  /* ---- the one entry point -------------------------------------------------- */
  function evaluate(text) {
    var src = String(text == null ? '' : text).trim();
    if (!src || src.length > MAX_LEN) return null;
    if (src[0] === '=') src = src.slice(1).trim();        // "=2+2", the spreadsheet habit
    if (!src) return null;
    if (/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(src)) return null;   // a date, not a subtraction
    if (!/[\d.]|pi|π|tau|\be\b/i.test(src)) return null;   // no number anywhere: not arithmetic
    var tokens;
    try { tokens = tokenize(src); } catch (e) { if (e instanceof NotMath) return null; throw e; }
    if (!tokens.length) return null;
    var p = new Parser(tokens);
    var v;
    try {
      v = p.expr();
      if (p.i !== tokens.length) return null;            // "2 3", "(2))": not something we read
    } catch (e) {
      if (e instanceof NotMath) return null;
      if (e instanceof CalcError) return p.ops ? { ok: false, reason: e.reason, expr: src } : null;
      throw e;
    }
    if (!p.ops) return null;                              // "42", "(5)", "-3", "pi": nothing to work out
    if (typeof v !== 'number' || isNaN(v)) return { ok: false, reason: 'that has no real-number answer', expr: src };
    if (!isFinite(v)) return { ok: false, reason: 'the answer is too large to show', expr: src };
    return { ok: true, value: tidy(v), display: display(v), copy: copyText(v), expr: src, radians: p.trig };
  }

  return { evaluate: evaluate, _internals: { tokenize: tokenize, display: display, copyText: copyText } };
});
