// Json.cs - a tiny hand-rolled JSON reader/writer.
//
// WHY hand-rolled: build.ps1 compiles with the built-in csc.exe (there is no
// dotnet SDK on this machine, so no NuGet) and references only System.dll,
// System.Core.dll, System.Drawing.dll and System.Windows.Forms.dll. That rules
// out Newtonsoft AND System.Web.Extensions' JavaScriptSerializer. The protocol
// is one flat-ish object per line, so ~200 lines of recursive descent is plenty
// and it keeps the sidecar a single self-contained exe with zero dependencies.
//
// Shapes used across the wire:
//   object -> Dictionary<string,object>   (on the way in)
//             IDictionary                 (on the way out; see Json.Obj)
//   array  -> List<object> / any IEnumerable
//   number -> double on the way in, any numeric type on the way out
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.Text;

namespace Mantle {
  static class Json {
    // ---------------------------------------------------------------- writing

    /// Build an ordered object from alternating key,value pairs:
    ///   Json.Obj("id", 1, "ok", true)
    /// Ordered (not Dictionary) purely so a human reading the wire sees
    /// id/ok/result in that order; JSON itself does not care.
    public static IDictionary Obj(params object[] kv) {
      var d = new OrderedDictionary();
      for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
      return d;
    }

    public static string Write(object v) {
      var sb = new StringBuilder(256);
      WriteValue(sb, v, 0);
      return sb.ToString();
    }

    /// How deep a value may nest, in and out. The protocol is flat-ish (a handful of levels);
    /// the limit exists because recursion past ~10,000 levels is a StackOverflowException, which
    /// .NET cannot catch: the sidecar died on the spot with no restore (core-sc, measured
    /// 2026-09-29 with a 200,000-deep request).
    public const int MaxDepth = 128;

    static void WriteValue(StringBuilder sb, object v, int depth) {
      if (depth > MaxDepth) throw new InvalidOperationException("the value nests more than " + MaxDepth + " levels deep");
      if (v == null) { sb.Append("null"); return; }
      if (v is string) { WriteString(sb, (string)v); return; }
      if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
      if (v is int || v is long || v is short || v is byte || v is uint || v is ulong || v is sbyte || v is ushort) {
        sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); return;
      }
      if (v is double || v is float || v is decimal) {
        // "R" round-trips and renders 1.0 as "1", which is what a JS caller wants.
        // NaN and the infinities have NO JSON spelling: written as text they made the
        // whole line unreadable, so the caller's reply was lost with it. null is what
        // JSON.stringify writes for them too (core-sc, 2026-09-29).
        double dv = Convert.ToDouble(v, CultureInfo.InvariantCulture);
        if (double.IsNaN(dv) || double.IsInfinity(dv)) { sb.Append("null"); return; }
        sb.Append(dv.ToString("R", CultureInfo.InvariantCulture));
        return;
      }
      if (v is IDictionary) {
        var d = (IDictionary)v;
        sb.Append('{');
        bool first = true;
        foreach (DictionaryEntry e in d) {
          if (!first) sb.Append(',');
          first = false;
          WriteString(sb, Convert.ToString(e.Key));
          sb.Append(':');
          WriteValue(sb, e.Value, depth + 1);
        }
        sb.Append('}');
        return;
      }
      if (v is IEnumerable) {
        sb.Append('[');
        bool first = true;
        foreach (var item in (IEnumerable)v) {
          if (!first) sb.Append(',');
          first = false;
          WriteValue(sb, item, depth + 1);
        }
        sb.Append(']');
        return;
      }
      WriteString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
    }

    static void WriteString(StringBuilder sb, string s) {
      sb.Append('"');
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        switch (c) {
          case '"': sb.Append("\\\""); break;
          case '\\': sb.Append("\\\\"); break;
          case '\b': sb.Append("\\b"); break;
          case '\f': sb.Append("\\f"); break;
          case '\n': sb.Append("\\n"); break;
          case '\r': sb.Append("\\r"); break;
          case '\t': sb.Append("\\t"); break;
          default:
            // Anything below 0x20 must be escaped; everything else (including
            // emoji in window titles) goes out as UTF-8 bytes on the stream.
            // A LONE surrogate has no UTF-8 form: the encoder turned it into
            // U+FFFD, so a window title or path holding one came back changed
            // and could never be matched again. Escaped, it round-trips exactly.
            if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { sb.Append(c).Append(s[i + 1]); i++; }
            else if (char.IsSurrogate(c)) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
            break;
        }
      }
      sb.Append('"');
    }

    // ---------------------------------------------------------------- reading

    public static object Parse(string s) {
      int i = 0;
      object v = ParseValue(s, ref i, 0);
      SkipWs(s, ref i);
      // Trailing content is NOT ignored. '{"id":1,...}{"id":2,...}' on one line
      // used to parse the first object and drop the second without a word - a
      // silent failure, and the caller would wait forever for reply 2.
      if (i < s.Length)
        throw new FormatException("extra text after the first JSON object at offset " + i +
                                  " (send exactly one object per line)");
      return v;
    }

    static void SkipWs(string s, ref int i) {
      while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
    }

    static object ParseValue(string s, ref int i, int depth) {
      SkipWs(s, ref i);
      if (i >= s.Length) throw new FormatException("unexpected end of JSON");
      char c = s[i];
      if ((c == '{' || c == '[') && depth >= MaxDepth)
        throw new FormatException("the request is too deeply nested (more than " + MaxDepth + " levels)");
      if (c == '{') return ParseObject(s, ref i, depth + 1);
      if (c == '[') return ParseArray(s, ref i, depth + 1);
      if (c == '"') return ParseString(s, ref i);
      if (c == 't') { Expect(s, ref i, "true"); return true; }
      if (c == 'f') { Expect(s, ref i, "false"); return false; }
      if (c == 'n') { Expect(s, ref i, "null"); return null; }
      return ParseNumber(s, ref i);
    }

    static void Expect(string s, ref int i, string lit) {
      if (i + lit.Length > s.Length || string.CompareOrdinal(s, i, lit, 0, lit.Length) != 0)
        throw new FormatException("not valid JSON: expected '" + lit + "' at offset " + i);
      i += lit.Length;
    }

    static Dictionary<string, object> ParseObject(string s, ref int i, int depth) {
      var d = new Dictionary<string, object>(StringComparer.Ordinal);
      i++; // '{'
      SkipWs(s, ref i);
      if (i < s.Length && s[i] == '}') { i++; return d; }
      while (true) {
        SkipWs(s, ref i);
        string key = ParseString(s, ref i);
        SkipWs(s, ref i);
        if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':' at offset " + i);
        i++;
        d[key] = ParseValue(s, ref i, depth);
        SkipWs(s, ref i);
        if (i >= s.Length) throw new FormatException("unterminated object");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == '}') { i++; return d; }
        throw new FormatException("expected ',' or '}' at offset " + i);
      }
    }

    static List<object> ParseArray(string s, ref int i, int depth) {
      var list = new List<object>();
      i++; // '['
      SkipWs(s, ref i);
      if (i < s.Length && s[i] == ']') { i++; return list; }
      while (true) {
        list.Add(ParseValue(s, ref i, depth));
        SkipWs(s, ref i);
        if (i >= s.Length) throw new FormatException("unterminated array");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == ']') { i++; return list; }
        throw new FormatException("expected ',' or ']' at offset " + i);
      }
    }

    static string ParseString(string s, ref int i) {
      if (i >= s.Length || s[i] != '"') throw new FormatException("expected string at offset " + i);
      i++;
      var sb = new StringBuilder();
      while (true) {
        if (i >= s.Length) throw new FormatException("unterminated string");
        char c = s[i++];
        if (c == '"') return sb.ToString();
        if (c != '\\') { sb.Append(c); continue; }
        if (i >= s.Length) throw new FormatException("unterminated escape");
        char e = s[i++];
        switch (e) {
          case '"': sb.Append('"'); break;
          case '\\': sb.Append('\\'); break;
          case '/': sb.Append('/'); break;
          case 'b': sb.Append('\b'); break;
          case 'f': sb.Append('\f'); break;
          case 'n': sb.Append('\n'); break;
          case 'r': sb.Append('\r'); break;
          case 't': sb.Append('\t'); break;
          case 'u':
            if (i + 4 > s.Length) throw new FormatException("truncated \\u escape");
            // Exactly four hex digits: NumberStyles.HexNumber also allows spaces,
            // so a "u 12a" escape used to be read as U+012A.
            int code = 0;
            for (int k = 0; k < 4; k++) {
              int h = HexVal(s[i + k]);
              if (h < 0) throw new FormatException("bad \\u escape at offset " + (i - 2) + ": it needs exactly four hex digits");
              code = code * 16 + h;
            }
            sb.Append((char)code);
            i += 4;
            break;
          default: throw new FormatException("bad escape \\" + e);
        }
      }
    }

    static object ParseNumber(string s, ref int i) {
      int start = i;
      while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
      if (i == start)
        throw new FormatException("not valid JSON: expected a value at offset " + i +
                                  " but found '" + (i < s.Length ? s[i].ToString() : "end of line") + "'");
      string num = s.Substring(start, i - start);
      // JSON's own grammar, not double.Parse's looser one: "+1", ".5", "01" and
      // "1." all parsed before. -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?
      if (!IsJsonNumber(num))
        throw new FormatException("not a valid JSON number at offset " + start + ": '" +
                                  (num.Length > 40 ? num.Substring(0, 40) + "..." : num) + "'");
      double d;
      if (!double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out d) || double.IsInfinity(d))
        throw new FormatException("number out of range at offset " + start);
      return d;
    }

    static int HexVal(char c) {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    }

    static bool IsDigit(string n, int i) { return i < n.Length && n[i] >= '0' && n[i] <= '9'; }

    static bool IsJsonNumber(string n) {
      int i = 0;
      if (i < n.Length && n[i] == '-') i++;
      if (!IsDigit(n, i)) return false;
      if (n[i] == '0') i++;
      else while (IsDigit(n, i)) i++;
      if (i < n.Length && n[i] == '.') {
        i++;
        if (!IsDigit(n, i)) return false;
        while (IsDigit(n, i)) i++;
      }
      if (i < n.Length && (n[i] == 'e' || n[i] == 'E')) {
        i++;
        if (i < n.Length && (n[i] == '+' || n[i] == '-')) i++;
        if (!IsDigit(n, i)) return false;
        while (IsDigit(n, i)) i++;
      }
      return i == n.Length;
    }

    // ------------------------------------------------------------- arg helpers
    // Requests arrive as Dictionary<string,object>; these pull typed values out
    // without throwing on a missing/odd field (the caller decides what is fatal).

    public static bool TryGet(Dictionary<string, object> req, string key, out object v) {
      v = null;
      return req != null && req.TryGetValue(key, out v) && v != null;
    }

    public static bool GetBool(Dictionary<string, object> req, string key, bool dflt) {
      object v;
      if (!TryGet(req, key, out v)) return dflt;
      if (v is bool) return (bool)v;
      if (v is double) return (double)v != 0;
      if (v is string) return string.Equals((string)v, "true", StringComparison.OrdinalIgnoreCase);
      return dflt;
    }

    public static bool HasKey(Dictionary<string, object> req, string key) {
      object v;
      return TryGet(req, key, out v);
    }

    public static int GetInt(Dictionary<string, object> req, string key, int dflt) {
      object v;
      if (!TryGet(req, key, out v)) return dflt;
      // Clamped, not cast: (int) of a double outside the int range is undefined in
      // C# and came out as int.MinValue, so w:1e12 read as a huge NEGATIVE width.
      if (v is double) {
        double d = Math.Round((double)v);
        if (double.IsNaN(d)) return dflt;
        if (d >= int.MaxValue) return int.MaxValue;
        if (d <= int.MinValue) return int.MinValue;
        return (int)d;
      }
      if (v is string) {
        int n;
        if (int.TryParse((string)v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) return n;
      }
      return dflt;
    }

    public static string GetString(Dictionary<string, object> req, string key) {
      object v;
      if (!TryGet(req, key, out v)) return null;
      return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    /// HWNDs travel as DECIMAL STRINGS, the same convention as ~/browser/embed.js,
    /// because a 64-bit handle does not survive a round trip through a JS number.
    /// A plain number is accepted too, for callers that only ever see small hwnds.
    public static IntPtr GetHwnd(Dictionary<string, object> req, string key) {
      object v;
      if (!TryGet(req, key, out v)) return IntPtr.Zero;
      long n = 0;
      if (v is double) n = (long)(double)v;
      else if (v is string) long.TryParse(((string)v).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n);
      return new IntPtr(n);
    }
  }
}
