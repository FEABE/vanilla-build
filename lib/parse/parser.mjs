/**
 * lib/parse/parser.mjs — JavaScript parser (ES2025 scripts and modules) producing an ESTree-shaped AST.
 * Part of vanilla-build. MIT License. Zero dependencies.
 *
 *   parse(src, { sourceType = 'module' | 'script', allowReturnOutsideFunction = false }) -> Program
 *
 *   Every node has { type, start, end } (UTF-16 offsets into src, end exclusive), so callers edit the source text
 *   by ranges instead of re-printing it. Parenthesized expressions keep their inner node; the node gets
 *   `parenthesized: true` plus `parenStart` / `parenEnd`. Shorthand properties { a } get distinct key and value
 *   nodes with the same range.
 *
 *   The tokenizer always reads "/" as a punctuator; the parser re-reads it as a regular expression where an
 *   operand is expected, and re-reads "}" as a template continuation inside `${ }`. Lexing is lazy, so no
 *   guessing is involved.
 *
 *   The parser accepts valid programs and builds the right tree for them. It is not a validator: it does not
 *   report every early error that V8 reports (callers that need that compile the code with node:vm first).
 *   Not supported (throws): JSX, TypeScript (strip it first), decorators, HTML-like comments.
 */

const ID_START_RE = /[\p{ID_Start}$_]/u;
const ID_CONT_RE = /[\p{ID_Continue}$‌‍]/u;
const ZS_RE = /\p{Zs}/u;

function isIdStart(c) {
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
  return ID_START_RE.test(String.fromCodePoint(c));
}
function isIdChar(c) {
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95;
  return ID_CONT_RE.test(String.fromCodePoint(c));
}
function isNewline(c) { return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; }
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff ||
    (c > 127 && ZS_RE.test(String.fromCharCode(c)));
}

const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@'];
const PUNCT_BY_CHAR = new Map();
for (const p of PUNCTUATORS) {
  if (!PUNCT_BY_CHAR.has(p[0])) PUNCT_BY_CHAR.set(p[0], []);
  PUNCT_BY_CHAR.get(p[0]).push(p);
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const BINARY_PREC = {
  '??': 1, '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7, in: 7,
  '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};
const LOGICAL = new Set(['||', '&&', '??']);
// Words that can never be an identifier reference.
const RESERVED = new Set(('break case catch class const continue debugger default delete do else export extends false finally ' +
  'for function if import in instanceof new null return super switch this throw true try typeof var void while with enum').split(' '));

export class ParseError extends SyntaxError {
  constructor(message, src, pos) {
    let line = 1, lineStart = 0;
    for (let i = 0; i < pos && i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c === 10 || (c === 13 && src.charCodeAt(i + 1) !== 10) || c === 0x2028 || c === 0x2029) { line++; lineStart = i + 1; }
    }
    super(message + ' (' + line + ':' + (pos - lineStart + 1) + ')');
    this.pos = pos;
    this.line = line;
    this.column = pos - lineStart + 1;
  }
}

class Parser {
  constructor(input, options) {
    this.input = String(input);
    this.options = options;
    this.inModule = options.sourceType === 'module';
    this.strict = this.inModule;
    // function context
    this.inFunction = false;
    this.canReturn = false;
    this.inAsync = false;
    this.inGenerator = false;
    this.inClassField = false;
    // token state
    this.pos = 0;
    this.type = 'eof';
    this.value = null;
    this.start = 0;
    this.end = 0;
    this.nlBefore = false;
    this.escaped = false;
    this.lastTokEnd = 0;
    this.lastTokStart = 0;
    this.hashbang = null;
    if (this.input.charCodeAt(0) === 35 && this.input.charCodeAt(1) === 33) {   // #!
      let i = 2;
      while (i < this.input.length && !isNewline(this.input.charCodeAt(i))) i++;
      this.hashbang = this.input.slice(0, i);
      this.pos = i;
    }
    this.nextToken();
  }

  raise(msg, pos = this.start) { throw new ParseError(msg, this.input, pos); }
  unexpected() {
    if (this.type === 'eof') this.raise('Unexpected end of input');
    this.raise('Unexpected token ' + JSON.stringify(this.input.slice(this.start, this.end)));
  }

  // ------------------------------------------------------------------ tokenizer

  skipSpace() {
    const s = this.input;
    const n = s.length;
    while (this.pos < n) {
      const c = s.charCodeAt(this.pos);
      if (c === 32 || c === 9) { this.pos++; continue; }
      if (isNewline(c)) { this.pos++; this.nlBefore = true; continue; }
      if (c === 47) {   // /
        const d = s.charCodeAt(this.pos + 1);
        if (d === 47) {
          this.pos += 2;
          while (this.pos < n && !isNewline(s.charCodeAt(this.pos))) this.pos++;
          continue;
        }
        if (d === 42) {
          const e = s.indexOf('*/', this.pos + 2);
          if (e < 0) this.raise('Unterminated comment', this.pos);
          for (let i = this.pos + 2; i < e; i++) if (isNewline(s.charCodeAt(i))) { this.nlBefore = true; break; }
          this.pos = e + 2;
          continue;
        }
        break;
      }
      if (c === 60 && s.startsWith('<!--', this.pos)) this.raise('HTML-like comments are not supported', this.pos);
      if (c === 45 && this.nlBefore && s.startsWith('-->', this.pos)) this.raise('HTML-like comments are not supported', this.pos);
      if (isSpaceCode(c)) { this.pos++; continue; }
      break;
    }
  }

  nextToken() {
    this.nlBefore = false;
    this.skipSpace();
    this.start = this.pos;
    this.escaped = false;
    const s = this.input;
    if (this.pos >= s.length) { this.type = 'eof'; this.value = null; this.end = this.pos; return; }
    const c = s.codePointAt(this.pos);
    if (isIdStart(c) || c === 92) { this.readWord('name'); return; }
    if (c === 35) {   // #
      this.pos++;
      const c2 = s.codePointAt(this.pos);
      if (isIdStart(c2) || c2 === 92) { this.readWord('privateId'); return; }
      this.raise('Unexpected character "#"');
    }
    if (c >= 48 && c <= 57) { this.readNumber(); return; }
    if (c === 46 && s.charCodeAt(this.pos + 1) >= 48 && s.charCodeAt(this.pos + 1) <= 57) { this.readNumber(); return; }
    if (c === 34 || c === 39) { this.readString(c); return; }
    if (c === 96) { this.pos++; this.readTemplateChunk(); return; }
    const cands = PUNCT_BY_CHAR.get(s[this.pos]);
    if (cands) {
      for (const p of cands) {
        if (s.startsWith(p, this.pos)) {
          let v = p;
          if (v === '?.') { const d = s.charCodeAt(this.pos + 2); if (d >= 48 && d <= 57) v = '?'; }
          this.pos += v.length;
          this.type = 'punc';
          this.value = v;
          this.end = this.pos;
          return;
        }
      }
    }
    this.raise('Unexpected character ' + JSON.stringify(String.fromCodePoint(c)));
  }

  readWord(type) {
    const s = this.input;
    let word = '';
    let chunk = this.pos;
    let first = true;
    while (this.pos < s.length) {
      const c = s.codePointAt(this.pos);
      if (c === 92) {   // \u escape
        this.escaped = true;
        word += s.slice(chunk, this.pos);
        if (s.charCodeAt(this.pos + 1) !== 117) this.raise('Bad escape in identifier', this.pos);
        this.pos += 2;
        const cp = this.readCodePoint();
        if (!(first ? isIdStart(cp) : isIdChar(cp))) this.raise('Bad escape in identifier', this.pos);
        word += String.fromCodePoint(cp);
        chunk = this.pos;
      } else if (first ? isIdStart(c) : isIdChar(c)) {
        this.pos += c > 0xffff ? 2 : 1;
      } else break;
      first = false;
    }
    word += s.slice(chunk, this.pos);
    this.type = type;
    this.value = word;
    this.end = this.pos;
  }

  // After "\u": reads XXXX or {X...}; returns the code point.
  readCodePoint() {
    const s = this.input;
    if (s[this.pos] === '{') {
      const e = s.indexOf('}', this.pos);
      if (e < 0) this.raise('Bad Unicode escape', this.pos);
      const cp = parseInt(s.slice(this.pos + 1, e), 16);
      if (!(cp >= 0 && cp <= 0x10ffff) || !/^[0-9a-fA-F]+$/.test(s.slice(this.pos + 1, e))) this.raise('Bad Unicode escape', this.pos);
      this.pos = e + 1;
      return cp;
    }
    const hex = s.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.raise('Bad Unicode escape', this.pos);
    this.pos += 4;
    return parseInt(hex, 16);
  }

  readNumber() {
    const s = this.input;
    const start = this.pos;
    let bigint = false;
    const c0 = s[this.pos], c1 = (s[this.pos + 1] || '').toLowerCase();
    if (c0 === '0' && (c1 === 'x' || c1 === 'o' || c1 === 'b')) {
      this.pos += 2;
      const re = c1 === 'x' ? /[0-9a-fA-F_]/ : c1 === 'o' ? /[0-7_]/ : /[01_]/;
      while (this.pos < s.length && re.test(s[this.pos])) this.pos++;
      if (s[this.pos] === 'n') { bigint = true; this.pos++; }
    } else {
      let legacyOctal = c0 === '0' && /[0-9]/.test(s[this.pos + 1] || '');
      while (this.pos < s.length && /[0-9_]/.test(s[this.pos])) this.pos++;
      if (legacyOctal && /[89]/.test(s.slice(start, this.pos))) legacyOctal = false;
      if (!legacyOctal) {
        if (s[this.pos] === 'n') { bigint = true; this.pos++; }
        else {
          if (s[this.pos] === '.') { this.pos++; while (this.pos < s.length && /[0-9_]/.test(s[this.pos])) this.pos++; }
          if (s[this.pos] === 'e' || s[this.pos] === 'E') {
            this.pos++;
            if (s[this.pos] === '+' || s[this.pos] === '-') this.pos++;
            while (this.pos < s.length && /[0-9_]/.test(s[this.pos])) this.pos++;
          }
        }
      }
    }
    if (this.pos < s.length && isIdStart(s.codePointAt(this.pos))) this.raise('Identifier directly after number', this.pos);
    const raw = s.slice(start, this.pos);
    this.type = 'num';
    this.end = this.pos;
    if (bigint) { this.value = { bigint: raw.slice(0, -1).replace(/_/g, '') }; return; }
    const clean = raw.replace(/_/g, '');
    let v;
    if (/^0[0-7]+$/.test(clean)) v = parseInt(clean, 8);
    else if (/^0[oO]/.test(clean)) v = parseInt(clean.slice(2), 8);
    else if (/^0[bB]/.test(clean)) v = parseInt(clean.slice(2), 2);
    else v = Number(clean);
    this.value = { number: v };
  }

  // Reads one escape after "\" at this.pos; returns the cooked text, or null for an invalid escape (templates).
  readEscape(inTemplate) {
    const s = this.input;
    const ch = s[this.pos++];
    switch (ch) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'v': return '\u000b';
      case 'f': return '\f';
      case '\r': if (s[this.pos] === '\n') this.pos++; return '';
      case '\n': case ' ': case ' ': return '';
      case 'x': {
        const hex = s.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) { if (inTemplate) return null; this.raise('Bad \\x escape', this.pos); }
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (inTemplate) {
          const save = this.pos;
          try { return String.fromCodePoint(this.readCodePoint()); } catch { this.pos = save; return null; }
        }
        return String.fromCodePoint(this.readCodePoint());
      }
      default:
        if (ch >= '0' && ch <= '7') {
          if (ch === '0' && !/[0-9]/.test(s[this.pos] || '')) return '\0';
          if (inTemplate) return null;
          let oct = ch;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] || '') && parseInt(oct + s[this.pos], 8) <= 255) oct += s[this.pos++];
          return String.fromCharCode(parseInt(oct, 8));
        }
        if (ch === '8' || ch === '9') { if (inTemplate) return null; return ch; }
        if (ch === undefined) this.raise('Unterminated string', this.pos - 1);
        // a lone surrogate pair stays intact
        if (ch >= '\ud800' && ch <= '\udbff' && s[this.pos] >= '\udc00' && s[this.pos] <= '\udfff') return ch + s[this.pos++];
        return ch;
    }
  }

  readString(quote) {
    const s = this.input;
    const start = this.pos;
    this.pos++;
    let out = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= s.length) this.raise('Unterminated string', start);
      const c = s.charCodeAt(this.pos);
      if (c === quote) break;
      if (c === 92) {
        out += s.slice(chunk, this.pos);
        this.pos++;
        out += this.readEscape(false);
        chunk = this.pos;
        continue;
      }
      if (c === 10 || c === 13) this.raise('Unterminated string', start);
      this.pos++;
    }
    out += s.slice(chunk, this.pos);
    this.pos++;
    this.type = 'string';
    this.value = out;
    this.end = this.pos;
  }

  // At the first character after "`" or "}": reads up to "`" or "${".
  readTemplateChunk() {
    const s = this.input;
    const rawStart = this.pos;
    let cooked = '';
    let chunk = this.pos;
    let invalid = false;
    for (;;) {
      if (this.pos >= s.length) this.raise('Unterminated template literal', this.start);
      const c = s.charCodeAt(this.pos);
      if (c === 96) { break; }
      if (c === 36 && s.charCodeAt(this.pos + 1) === 123) { break; }
      if (c === 92) {
        cooked += s.slice(chunk, this.pos);
        this.pos++;
        const e = this.readEscape(true);
        if (e === null) invalid = true; else cooked += e;
        chunk = this.pos;
        continue;
      }
      if (c === 13) {   // CR and CRLF are cooked as LF
        cooked += s.slice(chunk, this.pos) + '\n';
        this.pos++;
        if (s.charCodeAt(this.pos) === 10) this.pos++;
        chunk = this.pos;
        continue;
      }
      this.pos++;
    }
    cooked += s.slice(chunk, this.pos);
    const raw = s.slice(rawStart, this.pos).replace(/\r\n?/g, '\n');
    const tail = s.charCodeAt(this.pos) === 96;
    this.pos += tail ? 1 : 2;
    this.type = 'template';
    this.value = { raw, cooked: invalid ? null : cooked, tail, rawStart, rawEnd: this.pos - (tail ? 1 : 2) };
    this.end = this.pos;
  }

  // The current token is "}" that closes a `${ }`: re-read from there as a template chunk.
  readTemplateContinuation() {
    if (!(this.type === 'punc' && this.value === '}')) this.unexpected();
    this.pos = this.start + 1;
    this.readTemplateChunk();
  }

  // The current token is "/" or "/=" in operand position: re-read it as a regular expression.
  readRegexp() {
    const s = this.input;
    const start = this.start;
    let i = start + 1, inClass = false;
    for (;;) {
      if (i >= s.length || isNewline(s.charCodeAt(i))) this.raise('Unterminated regular expression', start);
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      i++;
    }
    const pattern = s.slice(start + 1, i);
    i++;
    const fStart = i;
    while (i < s.length && isIdChar(s.codePointAt(i))) i++;
    const flags = s.slice(fStart, i);
    this.pos = i;
    this.type = 'regexp';
    this.value = { pattern, flags };
    this.end = i;
  }

  next() {
    this.lastTokEnd = this.end;
    this.lastTokStart = this.start;
    this.nextToken();
  }

  // Looks at the token after the current one without consuming anything.
  peek() {
    const saved = [this.pos, this.type, this.value, this.start, this.end, this.nlBefore, this.escaped];
    this.pos = this.end;
    this.nextToken();
    const t = { type: this.type, value: this.value, start: this.start, end: this.end, nlBefore: this.nlBefore, escaped: this.escaped };
    [this.pos, this.type, this.value, this.start, this.end, this.nlBefore, this.escaped] = saved;
    return t;
  }
  peek2() {
    const saved = [this.pos, this.type, this.value, this.start, this.end, this.nlBefore, this.escaped];
    this.pos = this.end;
    this.nextToken();
    this.pos = this.end;
    this.nextToken();
    const t = { type: this.type, value: this.value, start: this.start, end: this.end, nlBefore: this.nlBefore, escaped: this.escaped };
    [this.pos, this.type, this.value, this.start, this.end, this.nlBefore, this.escaped] = saved;
    return t;
  }

  isP(v) { return this.type === 'punc' && this.value === v; }
  isWord(w) { return this.type === 'name' && this.value === w && !this.escaped; }
  eat(v) { if (this.isP(v)) { this.next(); return true; } return false; }
  eatWord(w) { if (this.isWord(w)) { this.next(); return true; } return false; }
  expect(v) { if (!this.eat(v)) this.raise('Expected "' + v + '"' + (this.type === 'eof' ? ' at end of input' : '')); }
  expectWord(w) { if (!this.eatWord(w)) this.raise('Expected "' + w + '"'); }
  canInsertSemicolon() { return this.type === 'eof' || this.isP('}') || this.nlBefore; }
  semicolon() { if (!this.eat(';') && !this.canInsertSemicolon()) this.raise('Expected ";"'); }

  node(start) { return { type: '', start: start === undefined ? this.start : start, end: 0 }; }
  finish(node, type) { node.type = type; node.end = this.lastTokEnd; return node; }

  // ------------------------------------------------------------------ program and statements

  parseTopLevel() {
    const program = this.node(0);
    program.body = [];
    program.sourceType = this.inModule ? 'module' : 'script';
    this.parseDirectives(program.body, true);
    while (this.type !== 'eof') program.body.push(this.parseStatementListItem(true));
    program.end = this.input.length;
    program.type = 'Program';
    if (this.hashbang) program.hashbang = this.hashbang;
    return program;
  }

  // Reads the directive prologue ("use strict" ...) into body; switches to strict mode when found.
  parseDirectives(body, topLevel) {
    while (this.type === 'string') {
      const stmt = this.parseStatementListItem(topLevel);
      body.push(stmt);
      // "use strict".length or "a" + b is an ordinary statement and ends the prologue
      if (stmt.type !== 'ExpressionStatement' || stmt.expression.type !== 'Literal' || typeof stmt.expression.value !== 'string' || stmt.expression.parenthesized) return;
      const raw = this.input.slice(stmt.expression.start + 1, stmt.expression.end - 1);
      stmt.directive = raw;
      if (raw === 'use strict') this.strict = true;
    }
  }

  isLetDeclaration() {
    if (!this.isWord('let')) return false;
    const nt = this.peek();
    if (nt.type === 'punc') return nt.value === '[' || nt.value === '{';
    if (nt.type === 'name') return !(nt.value === 'in' || nt.value === 'instanceof') || nt.escaped;
    return false;
  }
  isAsyncFunction() {
    if (!this.isWord('async')) return false;
    const nt = this.peek();
    return nt.type === 'name' && nt.value === 'function' && !nt.nlBefore && !nt.escaped;
  }

  parseStatementListItem(topLevel) {
    if (this.isWord('import') && topLevel && this.inModule) {
      const nt = this.peek();
      if (!(nt.type === 'punc' && (nt.value === '(' || nt.value === '.'))) return this.parseImport();
    }
    if (this.isWord('export') && topLevel && this.inModule) return this.parseExport();
    return this.parseStatement(true);
  }

  parseStatement(declarationAllowed) {
    const start = this.start;
    if (this.type === 'punc') {
      if (this.value === '{') return this.parseBlock();
      if (this.value === ';') { const n = this.node(); this.next(); return this.finish(n, 'EmptyStatement'); }
    }
    if (this.type === 'name' && !this.escaped) {
      switch (this.value) {
        case 'var': return this.parseVarStatement('var');
        case 'const': return this.parseVarStatement('const');
        case 'let': if (this.isLetDeclaration()) return this.parseVarStatement('let'); break;
        case 'function': return this.parseFunctionStatement(false);
        case 'async': if (this.isAsyncFunction()) return this.parseFunctionStatement(true); break;
        case 'class': return this.parseClass(true, false);
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': {
          const n = this.node(); this.next();
          n.test = this.parseParenExpression();
          n.body = this.parseStatement(false);
          return this.finish(n, 'WhileStatement');
        }
        case 'do': {
          const n = this.node(); this.next();
          n.body = this.parseStatement(false);
          this.expectWord('while');
          n.test = this.parseParenExpression();
          this.eat(';');
          return this.finish(n, 'DoWhileStatement');
        }
        case 'return': {
          if (!this.canReturn && !this.options.allowReturnOutsideFunction) this.raise('"return" outside of a function');
          const n = this.node(); this.next();
          n.argument = (this.isP(';') || this.canInsertSemicolon()) ? null : this.parseExpression(false);
          this.semicolon();
          return this.finish(n, 'ReturnStatement');
        }
        case 'break': case 'continue': {
          const n = this.node(); const kind = this.value; this.next();
          n.label = null;
          if (this.type === 'name' && !this.nlBefore && !(RESERVED.has(this.value) && !this.escaped)) n.label = this.parseIdent(false);
          this.semicolon();
          return this.finish(n, kind === 'break' ? 'BreakStatement' : 'ContinueStatement');
        }
        case 'throw': {
          const n = this.node(); this.next();
          if (this.nlBefore) this.raise('Illegal newline after throw');
          n.argument = this.parseExpression(false);
          this.semicolon();
          return this.finish(n, 'ThrowStatement');
        }
        case 'try': return this.parseTry();
        case 'switch': return this.parseSwitch();
        case 'with': {
          if (this.strict) this.raise('"with" in strict mode');
          const n = this.node(); this.next();
          n.object = this.parseParenExpression();
          n.body = this.parseStatement(false);
          return this.finish(n, 'WithStatement');
        }
        case 'debugger': { const n = this.node(); this.next(); this.semicolon(); return this.finish(n, 'DebuggerStatement'); }
        case 'import': {
          const nt = this.peek();
          if (!(nt.type === 'punc' && (nt.value === '(' || nt.value === '.'))) this.raise('"import" declarations may only appear at the top level of a module');
          break;
        }
        case 'export': this.raise('"export" may only appear at the top level of a module');
      }
    }
    // expression statement or labeled statement
    const expr = this.parseExpression(false);
    if (expr.type === 'Identifier' && !expr.parenthesized && this.isP(':')) {
      this.next();
      const n = this.node(start);
      n.label = expr;
      n.body = this.parseStatement(false);
      return this.finish(n, 'LabeledStatement');
    }
    const n = this.node(start);
    n.expression = expr;
    this.semicolon();
    return this.finish(n, 'ExpressionStatement');
  }

  parseBlock() {
    const n = this.node();
    this.expect('{');
    n.body = [];
    while (!this.isP('}')) {
      if (this.type === 'eof') this.raise('Unterminated block');
      n.body.push(this.parseStatement(true));
    }
    this.next();
    return this.finish(n, 'BlockStatement');
  }

  parseParenExpression() {
    this.expect('(');
    const e = this.parseExpression(false);
    this.expect(')');
    return e;
  }

  parseIf() {
    const n = this.node(); this.next();
    n.test = this.parseParenExpression();
    n.consequent = this.parseStatement(false);
    n.alternate = this.eatWord('else') ? this.parseStatement(false) : null;
    return this.finish(n, 'IfStatement');
  }

  parseTry() {
    const n = this.node(); this.next();
    n.block = this.parseBlock();
    n.handler = null;
    if (this.isWord('catch')) {
      const h = this.node(); this.next();
      h.param = null;
      if (this.eat('(')) {
        h.param = this.parseBindingAtom();
        this.expect(')');
      }
      h.body = this.parseBlock();
      n.handler = this.finish(h, 'CatchClause');
    }
    n.finalizer = this.eatWord('finally') ? this.parseBlock() : null;
    if (!n.handler && !n.finalizer) this.raise('Missing catch or finally after try');
    return this.finish(n, 'TryStatement');
  }

  parseSwitch() {
    const n = this.node(); this.next();
    n.discriminant = this.parseParenExpression();
    n.cases = [];
    this.expect('{');
    let cur = null;
    while (!this.isP('}')) {
      if (this.isWord('case') || this.isWord('default')) {
        if (cur) n.cases.push(this.finish(cur, 'SwitchCase'));
        cur = this.node();
        const isCase = this.value === 'case';
        this.next();
        cur.test = isCase ? this.parseExpression(false) : null;
        this.expect(':');
        cur.consequent = [];
      } else {
        if (!cur) this.unexpected();
        cur.consequent.push(this.parseStatement(true));
      }
    }
    if (cur) n.cases.push(this.finish(cur, 'SwitchCase'));
    this.next();
    return this.finish(n, 'SwitchStatement');
  }

  parseVarStatement(kind) {
    const n = this.parseVar(kind, false);
    this.semicolon();
    return this.finish(n, 'VariableDeclaration');
  }
  // Reads "var|let|const a = 1, b" (without the ";"). In a for head (noIn) initializers are optional.
  parseVar(kind, noIn) {
    const n = this.node();
    this.next();
    n.kind = kind;
    n.declarations = [];
    for (;;) {
      const d = this.node();
      d.id = this.parseBindingAtom();
      d.init = this.eat('=') ? this.parseMaybeAssign(noIn) : null;
      n.declarations.push(this.finish(d, 'VariableDeclarator'));
      if (!this.eat(',')) break;
    }
    return this.finish(n, 'VariableDeclaration');
  }

  parseFor() {
    const n = this.node(); this.next();
    let isAwait = false;
    if (this.isWord('await')) { isAwait = true; this.next(); }
    this.expect('(');
    if (this.isP(';')) return this.parseForRest(n, null);
    let init;
    const startsLet = this.isWord('let') && (() => { const nt = this.peek(); return (nt.type === 'name' && !(nt.value === 'in' || nt.value === 'of') ) || (nt.type === 'punc' && (nt.value === '[' || nt.value === '{')); })();
    if (this.isWord('var') || this.isWord('const') || startsLet) {
      init = this.parseVar(this.value, true);
      if ((this.isWord('of') || this.isWord('in')) && init.declarations.length === 1) return this.parseForInOf(n, init, isAwait);
      return this.parseForRest(n, init);
    }
    const startsWithLet = this.isWord('let'), startsWithAsync = this.isWord('async');
    init = this.parseExpression(true);
    if (this.isWord('of') || this.isWord('in')) {
      void startsWithLet; void startsWithAsync;
      return this.parseForInOf(n, this.toAssignable(init), isAwait);
    }
    return this.parseForRest(n, init);
  }
  parseForRest(n, init) {
    n.init = init;
    this.expect(';');
    n.test = this.isP(';') ? null : this.parseExpression(false);
    this.expect(';');
    n.update = this.isP(')') ? null : this.parseExpression(false);
    this.expect(')');
    n.body = this.parseStatement(false);
    return this.finish(n, 'ForStatement');
  }
  parseForInOf(n, left, isAwait) {
    const isOf = this.value === 'of';
    this.next();
    n.left = left;
    n.right = isOf ? this.parseMaybeAssign(false) : this.parseExpression(false);
    this.expect(')');
    n.body = this.parseStatement(false);
    if (isOf) n.await = isAwait;
    return this.finish(n, isOf ? 'ForOfStatement' : 'ForInStatement');
  }

  parseFunctionStatement(isAsync) {
    const n = this.node();
    if (isAsync) this.next();
    this.next();   // function
    return this.parseFunction(n, true, isAsync, false);
  }

  // At the token after "function". statement: a declaration (name required unless optionalName).
  parseFunction(n, statement, isAsync, optionalName) {
    n.generator = this.eat('*');
    n.async = isAsync;
    n.id = null;
    if (this.type === 'name' && !(this.isP('('))) {
      // the name of a function expression is read in the function's own yield/await context
      n.id = this.parseIdent(false);
    } else if (statement && !optionalName) this.unexpected();
    this.parseFunctionParamsAndBody(n, isAsync, n.generator, false);
    return this.finish(n, statement ? 'FunctionDeclaration' : 'FunctionExpression');
  }

  enterFunction(isAsync, isGenerator, isArrow) {
    const saved = [this.inFunction, this.inAsync, this.inGenerator, this.inClassField, this.strict, this.canReturn];
    this.canReturn = true;
    if (!isArrow) { this.inFunction = true; this.inGenerator = isGenerator; this.inClassField = false; }
    else this.inGenerator = false;
    this.inAsync = isAsync;
    return saved;
  }
  leaveFunction(saved) { [this.inFunction, this.inAsync, this.inGenerator, this.inClassField, this.strict, this.canReturn] = saved; }

  parseFunctionParamsAndBody(n, isAsync, isGenerator, isMethod) {
    void isMethod;
    const saved = this.enterFunction(isAsync, isGenerator, false);
    this.expect('(');
    n.params = this.parseBindingList(')');
    n.body = this.parseFunctionBody();
    n.expression = false;
    this.leaveFunction(saved);
  }

  parseFunctionBody() {
    const b = this.node();
    this.expect('{');
    b.body = [];
    this.parseDirectives(b.body, false);
    while (!this.isP('}')) {
      if (this.type === 'eof') this.raise('Unterminated function body');
      b.body.push(this.parseStatement(true));
    }
    this.next();
    return this.finish(b, 'BlockStatement');
  }

  // Reads binding elements up to the closing token (already past the opening one).
  parseBindingList(close) {
    const list = [];
    let first = true;
    while (!this.eat(close)) {
      if (!first) { this.expect(','); if (this.eat(close)) break; }
      first = false;
      if (this.isP('...')) {
        const r = this.node(); this.next();
        r.argument = this.parseBindingAtom();
        list.push(this.finish(r, 'RestElement'));
        this.eat(',');
        this.expect(close);
        break;
      }
      list.push(this.parseMaybeDefault(this.parseBindingAtom()));
    }
    return list;
  }

  parseMaybeDefault(left) {
    if (!this.eat('=')) return left;
    const n = this.node(left.start);
    n.left = left;
    n.right = this.parseMaybeAssign(false);
    return this.finish(n, 'AssignmentPattern');
  }

  parseBindingAtom() {
    if (this.isP('[')) {
      const n = this.node(); this.next();
      n.elements = [];
      while (!this.eat(']')) {
        if (this.isP(',')) { this.next(); n.elements.push(null); continue; }
        if (this.isP('...')) {
          const r = this.node(); this.next();
          r.argument = this.parseBindingAtom();
          n.elements.push(this.finish(r, 'RestElement'));
          this.eat(',');
          this.expect(']');
          break;
        }
        n.elements.push(this.parseMaybeDefault(this.parseBindingAtom()));
        if (!this.isP(']')) this.expect(',');
      }
      return this.finish(n, 'ArrayPattern');
    }
    if (this.isP('{')) {
      const n = this.node(); this.next();
      n.properties = [];
      while (!this.eat('}')) {
        if (this.isP('...')) {
          const r = this.node(); this.next();
          r.argument = this.parseBindingAtom();
          n.properties.push(this.finish(r, 'RestElement'));
          this.eat(',');
          this.expect('}');
          break;
        }
        const p = this.node();
        p.method = false; p.kind = 'init';
        this.parsePropertyName(p);
        if (this.eat(':')) {
          p.shorthand = false;
          p.value = this.parseMaybeDefault(this.parseBindingAtom());
        } else {
          if (p.computed || p.key.type !== 'Identifier') this.unexpected();
          p.shorthand = true;
          p.value = this.parseMaybeDefault(this.copyIdent(p.key));
        }
        n.properties.push(this.finish(p, 'Property'));
        if (!this.isP('}')) this.expect(',');
      }
      return this.finish(n, 'ObjectPattern');
    }
    return this.parseIdent(false);
  }

  copyIdent(id) { return { type: 'Identifier', start: id.start, end: id.end, name: id.name }; }

  // ------------------------------------------------------------------ classes

  parseClass(statement, optionalName) {
    const n = this.node();
    this.next();
    const savedStrict = this.strict;
    this.strict = true;
    n.id = null;
    if (this.type === 'name' && !this.isWord('extends')) n.id = this.parseIdent(false);
    else if (statement && !optionalName) this.unexpected();
    n.superClass = this.eatWord('extends') ? this.parseExprSubscripts() : null;
    const body = this.node();
    this.expect('{');
    body.body = [];
    while (!this.eat('}')) {
      if (this.eat(';')) continue;
      if (this.type === 'eof') this.raise('Unterminated class body');
      body.body.push(this.parseClassElement());
    }
    n.body = this.finish(body, 'ClassBody');
    this.strict = savedStrict;
    return this.finish(n, statement ? 'ClassDeclaration' : 'ClassExpression');
  }

  // Is the current word a modifier (static / get / set / async) rather than the member's own name?
  isModifier(allowNewline) {
    const nt = this.peek();
    if (nt.type === 'punc' && ['(', '=', ';', '}', ','].includes(nt.value)) return false;
    if (nt.type === 'eof') return false;
    if (!allowNewline && nt.nlBefore) return false;
    return true;
  }

  parseClassElement() {
    const start = this.start;
    let isStatic = false;
    if (this.isWord('static')) {
      const nt = this.peek();
      if (nt.type === 'punc' && nt.value === '{') {
        const n = this.node(); this.next(); this.next();
        const saved = this.enterFunction(false, false, false);
        this.inClassField = true;
        n.body = [];
        while (!this.isP('}')) {
          if (this.type === 'eof') this.raise('Unterminated static block');
          n.body.push(this.parseStatement(true));
        }
        this.next();
        this.leaveFunction(saved);
        return this.finish(n, 'StaticBlock');
      }
      if (this.isModifier(true)) { isStatic = true; this.next(); }
    }
    let kind = 'method', isAsync = false, isGenerator = false;
    if (this.isWord('async') && this.isModifier(false)) { isAsync = true; this.next(); }
    if (this.isP('*')) { isGenerator = true; this.next(); }
    if (!isAsync && !isGenerator && (this.isWord('get') || this.isWord('set')) && this.isModifier(true)) {
      kind = this.value; this.next();
    }
    if (this.isWord('accessor') && this.isModifier(false) && !isAsync && !isGenerator && kind === 'method') {
      this.raise('"accessor" class members are not supported');
    }
    const n = this.node(start);
    n.static = isStatic;
    this.parsePropertyName(n, true);
    if (this.isP('(')) {
      const isCtor = !isStatic && !n.computed && ((n.key.type === 'Identifier' && n.key.name === 'constructor') || (n.key.type === 'Literal' && n.key.value === 'constructor'));
      n.kind = isCtor && kind === 'method' ? 'constructor' : kind;
      n.value = this.parseMethod(isAsync, isGenerator);
      return this.finish(n, 'MethodDefinition');
    }
    // field
    if (kind !== 'method' || isAsync || isGenerator) this.unexpected();
    n.value = null;
    if (this.eat('=')) {
      const saved = this.enterFunction(false, false, false);
      this.inClassField = true;
      n.value = this.parseMaybeAssign(false);
      this.leaveFunction(saved);
    }
    this.semicolon();
    return this.finish(n, 'PropertyDefinition');
  }

  parseMethod(isAsync, isGenerator) {
    const n = this.node();
    n.id = null;
    n.async = isAsync;
    n.generator = isGenerator;
    this.parseFunctionParamsAndBody(n, isAsync, isGenerator, true);
    return this.finish(n, 'FunctionExpression');
  }

  // Sets n.key and n.computed.
  parsePropertyName(n, inClass) {
    if (this.isP('[')) {
      this.next();
      n.computed = true;
      n.key = this.parseMaybeAssign(false);
      this.expect(']');
      return;
    }
    n.computed = false;
    if (this.type === 'num' || this.type === 'string') { n.key = this.parseLiteral(); return; }
    if (this.type === 'name') { n.key = this.parseIdent(true); return; }
    if (this.type === 'privateId' && inClass) {
      const k = this.node(); k.name = this.value; this.next();
      n.key = this.finish(k, 'PrivateIdentifier');
      return;
    }
    this.unexpected();
  }

  // ------------------------------------------------------------------ modules

  parseModuleSource() {
    if (this.type !== 'string') this.raise('Expected a module specifier string');
    return this.parseLiteral();
  }
  parseImportAttributes() {
    if ((this.isWord('with') || (this.isWord('assert') && !this.nlBefore))) {
      const nt = this.peek();
      if (!(nt.type === 'punc' && nt.value === '{')) return [];
      this.next(); this.next();
      const list = [];
      while (!this.eat('}')) {
        const a = this.node();
        a.key = this.type === 'string' ? this.parseLiteral() : this.parseIdent(true);
        this.expect(':');
        if (this.type !== 'string') this.raise('Import attribute value must be a string');
        a.value = this.parseLiteral();
        list.push(this.finish(a, 'ImportAttribute'));
        if (!this.isP('}')) this.expect(',');
      }
      return list;
    }
    return [];
  }
  parseModuleExportName() {
    if (this.type === 'string') return this.parseLiteral();
    return this.parseIdent(true);
  }

  parseImport() {
    const n = this.node();
    this.next();
    n.specifiers = [];
    if (this.type === 'string') {
      n.source = this.parseLiteral();
      n.attributes = this.parseImportAttributes();
      this.semicolon();
      return this.finish(n, 'ImportDeclaration');
    }
    if (this.type === 'name' && !this.isWord('from') || (this.isWord('from') && this.peek().type !== 'string')) {
      if (!(this.isP('{') || this.isP('*'))) {
        const s = this.node();
        s.local = this.parseIdent(false);
        n.specifiers.push(this.finish(s, 'ImportDefaultSpecifier'));
        if (!this.eat(',')) { this.finishImport(n); return n; }
      }
    }
    if (this.isP('*')) {
      const s = this.node(); this.next();
      this.expectWord('as');
      s.local = this.parseIdent(false);
      n.specifiers.push(this.finish(s, 'ImportNamespaceSpecifier'));
    } else if (this.isP('{')) {
      this.next();
      while (!this.eat('}')) {
        const s = this.node();
        s.imported = this.parseModuleExportName();
        if (this.eatWord('as')) s.local = this.parseIdent(false);
        else {
          if (s.imported.type !== 'Identifier') this.unexpected();
          s.local = this.copyIdent(s.imported);
        }
        n.specifiers.push(this.finish(s, 'ImportSpecifier'));
        if (!this.isP('}')) this.expect(',');
      }
    }
    this.finishImport(n);
    return n;
  }
  finishImport(n) {
    this.expectWord('from');
    n.source = this.parseModuleSource();
    n.attributes = this.parseImportAttributes();
    this.semicolon();
    this.finish(n, 'ImportDeclaration');
  }

  parseExport() {
    const n = this.node();
    this.next();
    if (this.isP('*')) {
      this.next();
      n.exported = this.eatWord('as') ? this.parseModuleExportName() : null;
      this.expectWord('from');
      n.source = this.parseModuleSource();
      n.attributes = this.parseImportAttributes();
      this.semicolon();
      return this.finish(n, 'ExportAllDeclaration');
    }
    if (this.isWord('default')) {
      this.next();
      if (this.isWord('function') || this.isAsyncFunction()) {
        const f = this.node();
        const isAsync = this.isWord('async');
        if (isAsync) this.next();
        this.next();
        n.declaration = this.parseFunction(f, true, isAsync, true);
      } else if (this.isWord('class')) {
        n.declaration = this.parseClass(true, true);
      } else {
        n.declaration = this.parseMaybeAssign(false);
        this.semicolon();
      }
      return this.finish(n, 'ExportDefaultDeclaration');
    }
    n.specifiers = [];
    n.source = null;
    n.attributes = [];
    if (this.isP('{')) {
      this.next();
      n.declaration = null;
      while (!this.eat('}')) {
        const s = this.node();
        s.local = this.parseModuleExportName();
        if (this.eatWord('as')) s.exported = this.parseModuleExportName();
        else s.exported = s.local.type === 'Identifier' ? this.copyIdent(s.local) : { ...s.local };
        n.specifiers.push(this.finish(s, 'ExportSpecifier'));
        if (!this.isP('}')) this.expect(',');
      }
      if (this.eatWord('from')) {
        n.source = this.parseModuleSource();
        n.attributes = this.parseImportAttributes();
      }
      this.semicolon();
      return this.finish(n, 'ExportNamedDeclaration');
    }
    if (this.isWord('var') || this.isWord('const') || this.isWord('let')) n.declaration = this.parseVarStatement(this.value);
    else if (this.isWord('function')) n.declaration = this.parseFunctionStatement(false);
    else if (this.isAsyncFunction()) n.declaration = this.parseFunctionStatement(true);
    else if (this.isWord('class')) n.declaration = this.parseClass(true, false);
    else this.unexpected();
    return this.finish(n, 'ExportNamedDeclaration');
  }

  // ------------------------------------------------------------------ expressions

  parseExpression(noIn) {
    const start = this.start;
    const e = this.parseMaybeAssign(noIn);
    if (this.isP(',')) {
      const n = this.node(start);
      n.expressions = [e];
      while (this.eat(',')) n.expressions.push(this.parseMaybeAssign(noIn));
      return this.finish(n, 'SequenceExpression');
    }
    return e;
  }

  parseMaybeAssign(noIn) {
    if (this.inGenerator && this.isWord('yield')) return this.parseYield(noIn);
    const start = this.start;
    const left = this.parseMaybeConditional(noIn);
    if (this.type === 'punc' && ASSIGN_OPS.has(this.value)) {
      const op = this.value;
      const n = this.node(start);
      n.operator = op;
      n.left = op === '=' ? this.toAssignable(left) : left;
      this.next();
      n.right = this.parseMaybeAssign(noIn);
      return this.finish(n, 'AssignmentExpression');
    }
    return left;
  }

  parseYield(noIn) {
    const n = this.node();
    this.next();
    if (this.nlBefore || this.type === 'eof' || this.isWord('in') || this.isWord('of') ||
      (this.type === 'punc' && !this.isP('*') && !this.startsExpression())) {
      n.delegate = false;
      n.argument = null;
    } else {
      n.delegate = this.eat('*');
      n.argument = this.parseMaybeAssign(noIn);
    }
    return this.finish(n, 'YieldExpression');
  }
  startsExpression() {
    if (this.type !== 'punc') return true;
    return ['(', '[', '{', '+', '-', '!', '~', '++', '--', '/', '/='].includes(this.value);
  }

  parseMaybeConditional(noIn) {
    const start = this.start;
    const test = this.parseExprOps(noIn);
    if (this.isP('?')) {
      if (test.type === 'ArrowFunctionExpression' && !test.parenthesized) return test;
      this.next();
      const n = this.node(start);
      n.test = test;
      n.consequent = this.parseMaybeAssign(false);
      this.expect(':');
      n.alternate = this.parseMaybeAssign(noIn);
      return this.finish(n, 'ConditionalExpression');
    }
    return test;
  }

  parseExprOps(noIn) {
    const start = this.start;
    const left = this.parseMaybeUnary();
    if (left.type === 'ArrowFunctionExpression' && !left.parenthesized) return left;
    return this.parseExprOp(left, start, -1, noIn);
  }

  binaryPrec(noIn) {
    if (this.type === 'punc') return BINARY_PREC[this.value] || 0;
    if (this.type === 'name' && !this.escaped) {
      if (this.value === 'instanceof') return 7;
      if (this.value === 'in' && !noIn) return 7;
    }
    return 0;
  }

  parseExprOp(left, leftStart, minPrec, noIn) {
    for (;;) {
      const prec = this.binaryPrec(noIn);
      if (!prec || prec <= minPrec) return left;
      const op = this.value;
      this.next();
      const rightStart = this.start;
      const right = this.parseExprOp(this.parseMaybeUnary(), rightStart, op === '**' ? prec - 1 : prec, noIn);
      const n = this.node(leftStart);
      n.operator = op;
      n.left = left;
      n.right = right;
      left = this.finish(n, LOGICAL.has(op) ? 'LogicalExpression' : 'BinaryExpression');
    }
  }

  canAwait() {
    if (this.inAsync) return true;
    if (this.inModule && !this.inFunction && !this.inClassField) return true;
    return false;
  }

  parseMaybeUnary() {
    const start = this.start;
    if (this.type === 'punc' && (this.value === '!' || this.value === '~' || this.value === '+' || this.value === '-')) {
      const n = this.node(); n.operator = this.value; n.prefix = true; this.next();
      n.argument = this.parseMaybeUnary();
      return this.finish(n, 'UnaryExpression');
    }
    if (this.type === 'punc' && (this.value === '++' || this.value === '--')) {
      const n = this.node(); n.operator = this.value; n.prefix = true; this.next();
      n.argument = this.parseMaybeUnary();
      return this.finish(n, 'UpdateExpression');
    }
    if (this.type === 'name' && !this.escaped && (this.value === 'typeof' || this.value === 'void' || this.value === 'delete')) {
      const n = this.node(); n.operator = this.value; n.prefix = true; this.next();
      n.argument = this.parseMaybeUnary();
      return this.finish(n, 'UnaryExpression');
    }
    if (this.isWord('await') && this.canAwait()) {
      const n = this.node(); this.next();
      n.argument = this.parseMaybeUnary();
      return this.finish(n, 'AwaitExpression');
    }
    let expr = this.parseExprSubscripts();
    while (this.type === 'punc' && (this.value === '++' || this.value === '--') && !this.nlBefore) {
      const n = this.node(start);
      n.operator = this.value; n.prefix = false; n.argument = expr;
      this.next();
      expr = this.finish(n, 'UpdateExpression');
    }
    return expr;
  }

  parseExprSubscripts() {
    const start = this.start;
    const base = this.parseExprAtom();
    if (base.type === 'ArrowFunctionExpression' && !base.parenthesized) return base;
    return this.parseSubscripts(base, start, false);
  }

  parseSubscripts(base, start, noCalls) {
    let chained = false;
    const maybeAsyncArrow = base.type === 'Identifier' && base.name === 'async' && !base.escaped && this.lastTokEnd === base.end && !this.nlBefore;
    for (;;) {
      if (this.isP('?.')) {
        if (noCalls) this.raise('Optional chaining is not allowed in new expressions');
        chained = true;
        this.next();
        if (this.isP('(')) {
          this.next();
          const n = this.node(start);
          n.callee = base; n.arguments = this.parseExprList(')'); n.optional = true;
          base = this.finish(n, 'CallExpression');
        } else if (this.isP('[')) {
          this.next();
          const n = this.node(start);
          n.object = base; n.property = this.parseExpression(false); n.computed = true; n.optional = true;
          this.expect(']');
          base = this.finish(n, 'MemberExpression');
        } else {
          const n = this.node(start);
          n.object = base; n.property = this.parsePropertyIdent(); n.computed = false; n.optional = true;
          base = this.finish(n, 'MemberExpression');
        }
        continue;
      }
      if (this.isP('.')) {
        this.next();
        const n = this.node(start);
        n.object = base; n.property = this.parsePropertyIdent(); n.computed = false; n.optional = false;
        base = this.finish(n, 'MemberExpression');
        continue;
      }
      if (this.isP('[')) {
        this.next();
        const n = this.node(start);
        n.object = base; n.property = this.parseExpression(false); n.computed = true; n.optional = false;
        this.expect(']');
        base = this.finish(n, 'MemberExpression');
        continue;
      }
      if (!noCalls && this.isP('(')) {
        const isAsyncCandidate = maybeAsyncArrow && base.type === 'Identifier';
        this.next();
        const args = this.parseExprList(')');
        if (isAsyncCandidate && this.isP('=>') && !this.nlBefore) {
          return this.parseArrow(this.node(start), args.map((a) => this.toAssignable(a)), true);
        }
        const n = this.node(start);
        n.callee = base; n.arguments = args; n.optional = false;
        base = this.finish(n, 'CallExpression');
        continue;
      }
      if (this.type === 'template') {
        if (chained) this.raise('Tagged template in optional chain');
        const n = this.node(start);
        n.tag = base;
        n.quasi = this.parseTemplate(true);
        base = this.finish(n, 'TaggedTemplateExpression');
        continue;
      }
      break;
    }
    if (chained) {
      const c = this.node(start);
      c.expression = base;
      c.type = 'ChainExpression';
      c.end = base.end;
      return c;
    }
    return base;
  }

  parsePropertyIdent() {
    if (this.type === 'privateId') {
      const k = this.node(); k.name = this.value; this.next();
      return this.finish(k, 'PrivateIdentifier');
    }
    return this.parseIdent(true);
  }

  // Arguments / array-like lists up to close (already past the opening token). Holes are not allowed.
  parseExprList(close) {
    const list = [];
    let first = true;
    while (!this.eat(close)) {
      if (!first) { this.expect(','); if (this.eat(close)) break; }
      first = false;
      if (this.isP('...')) {
        const s = this.node(); this.next();
        s.argument = this.parseMaybeAssign(false);
        list.push(this.finish(s, 'SpreadElement'));
      } else list.push(this.parseMaybeAssign(false));
    }
    return list;
  }

  parseIdent(liberal) {
    if (this.type !== 'name') this.unexpected();
    if (!liberal && !this.escaped && RESERVED.has(this.value)) this.raise('Unexpected keyword "' + this.value + '"');
    const n = this.node();
    n.name = this.value;
    if (this.escaped) n.escaped = true;
    this.next();
    return this.finish(n, 'Identifier');
  }

  parseLiteral() {
    const n = this.node();
    if (this.type === 'num') {
      if (this.value.bigint !== undefined) { n.value = null; n.bigint = this.value.bigint; }
      else n.value = this.value.number;
    } else n.value = this.value;
    n.raw = this.input.slice(this.start, this.end);
    this.next();
    return this.finish(n, 'Literal');
  }

  parseTemplate(tagged) {
    const n = this.node();
    n.expressions = [];
    n.quasis = [];
    for (;;) {
      if (this.type !== 'template') this.unexpected();
      const v = this.value;
      if (v.cooked === null && !tagged) this.raise('Invalid escape sequence in template');
      const q = { type: 'TemplateElement', start: v.rawStart, end: v.rawEnd, value: { raw: v.raw, cooked: v.cooked }, tail: v.tail };
      n.quasis.push(q);
      if (v.tail) { this.next(); break; }
      this.next();
      n.expressions.push(this.parseExpression(false));
      this.readTemplateContinuation();
    }
    return this.finish(n, 'TemplateLiteral');
  }

  parseExprAtom() {
    const start = this.start;
    if (this.type === 'punc') {
      switch (this.value) {
        case '/': case '/=': {
          this.readRegexp();
          const n = this.node(start);
          n.regex = this.value;
          n.value = null;
          n.raw = this.input.slice(start, this.end);
          this.next();
          return this.finish(n, 'Literal');
        }
        case '(': return this.parseParenAndDistinguish();
        case '[': {
          const n = this.node(); this.next();
          n.elements = [];
          while (!this.eat(']')) {
            if (this.isP(',')) { this.next(); n.elements.push(null); continue; }
            if (this.isP('...')) {
              const s = this.node(); this.next();
              s.argument = this.parseMaybeAssign(false);
              n.elements.push(this.finish(s, 'SpreadElement'));
            } else n.elements.push(this.parseMaybeAssign(false));
            if (!this.isP(']')) this.expect(',');
          }
          return this.finish(n, 'ArrayExpression');
        }
        case '{': return this.parseObject();
      }
      this.unexpected();
    }
    if (this.type === 'num' || this.type === 'string') return this.parseLiteral();
    if (this.type === 'template') return this.parseTemplate(false);
    if (this.type === 'privateId') {
      const k = this.node(); k.name = this.value; this.next();
      if (!this.isWord('in')) this.unexpected();
      return this.finish(k, 'PrivateIdentifier');
    }
    if (this.type !== 'name') this.unexpected();
    if (!this.escaped) {
      switch (this.value) {
        case 'function': {
          const n = this.node(); this.next();
          return this.parseFunctionExpr(n, false);
        }
        case 'class': return this.parseClass(false, false);
        case 'async': {
          const nt = this.peek();
          if (nt.type === 'name' && nt.value === 'function' && !nt.nlBefore && !nt.escaped) {
            const n = this.node(); this.next(); this.next();
            return this.parseFunctionExpr(n, true);
          }
          if (nt.type === 'name' && !nt.nlBefore && !(RESERVED.has(nt.value) && !nt.escaped)) {
            const nt2 = this.peek2();
            if (nt2.type === 'punc' && nt2.value === '=>' && !nt2.nlBefore) {
              const n = this.node(); this.next();
              const saved = [this.inAsync];
              this.inAsync = true;
              const param = this.parseIdent(false);
              this.inAsync = saved[0];
              return this.parseArrow(n, [param], true);
            }
          }
          break;
        }
        case 'new': return this.parseNew();
        case 'this': { const n = this.node(); this.next(); return this.finish(n, 'ThisExpression'); }
        case 'super': { const n = this.node(); this.next(); return this.finish(n, 'Super'); }
        case 'null': { const n = this.node(); n.value = null; n.raw = 'null'; this.next(); return this.finish(n, 'Literal'); }
        case 'true': case 'false': {
          const n = this.node(); n.value = this.value === 'true'; n.raw = this.value; this.next(); return this.finish(n, 'Literal');
        }
        case 'import': {
          const n = this.node(); this.next();
          if (this.eat('.')) {
            const meta = { type: 'Identifier', start, end: start + 6, name: 'import' };
            n.meta = meta;
            n.property = this.parseIdent(true);
            if (n.property.name !== 'meta') this.raise('Only import.meta is supported', n.property.start);
            if (!this.inModule) this.raise('import.meta outside a module', start);
            return this.finish(n, 'MetaProperty');
          }
          this.expect('(');
          n.source = this.parseMaybeAssign(false);
          n.options = null;
          if (this.eat(',') && !this.isP(')')) { n.options = this.parseMaybeAssign(false); this.eat(','); }
          this.expect(')');
          return this.finish(n, 'ImportExpression');
        }
      }
    }
    const id = this.parseIdent(false);
    if (this.isP('=>') && !this.nlBefore) return this.parseArrow(this.node(start), [id], false);
    return id;
  }

  parseFunctionExpr(n, isAsync) {
    n.generator = this.eat('*');
    n.async = isAsync;
    n.id = null;
    if (this.type === 'name' && !this.isP('(')) {
      const saved = this.enterFunction(isAsync, n.generator, false);
      n.id = this.parseIdent(false);
      this.leaveFunction(saved);
    }
    this.parseFunctionParamsAndBody(n, isAsync, n.generator, false);
    return this.finish(n, 'FunctionExpression');
  }

  parseNew() {
    const start = this.start;
    const n = this.node();
    this.next();
    if (this.eat('.')) {
      n.meta = { type: 'Identifier', start, end: start + 3, name: 'new' };
      n.property = this.parseIdent(true);
      if (n.property.name !== 'target') this.raise('Only new.target is supported', n.property.start);
      return this.finish(n, 'MetaProperty');
    }
    const calleeStart = this.start;
    if (this.isWord('import')) this.raise('Cannot use new with import()');
    n.callee = this.parseSubscripts(this.parseExprAtom(), calleeStart, true);
    n.arguments = this.eat('(') ? this.parseExprList(')') : [];
    return this.finish(n, 'NewExpression');
  }

  parseObject() {
    const n = this.node();
    this.next();
    n.properties = [];
    while (!this.eat('}')) {
      if (this.isP('...')) {
        const s = this.node(); this.next();
        s.argument = this.parseMaybeAssign(false);
        n.properties.push(this.finish(s, 'SpreadElement'));
      } else n.properties.push(this.parseObjectMember());
      if (!this.isP('}')) this.expect(',');
    }
    return this.finish(n, 'ObjectExpression');
  }

  isObjModifier() {
    const nt = this.peek();
    if (nt.type === 'punc' && [',', ':', '(', '}', '='].includes(nt.value)) return false;
    return nt.type !== 'eof';
  }

  parseObjectMember() {
    const p = this.node();
    let isAsync = false, isGenerator = false, kind = 'init';
    if (this.isWord('async') && this.isObjModifier() && !this.peek().nlBefore) { isAsync = true; this.next(); }
    if (this.isP('*')) { isGenerator = true; this.next(); }
    if (!isAsync && !isGenerator && (this.isWord('get') || this.isWord('set')) && this.isObjModifier()) { kind = this.value; this.next(); }
    this.parsePropertyName(p, false);
    p.kind = kind;
    if (kind === 'init' && !isAsync && !isGenerator && this.eat(':')) {
      p.method = false; p.shorthand = false;
      p.value = this.parseMaybeAssign(false);
      return this.finish(p, 'Property');
    }
    if (this.isP('(')) {
      p.method = kind === 'init';
      p.shorthand = false;
      p.value = this.parseMethod(isAsync, isGenerator);
      return this.finish(p, 'Property');
    }
    if (kind !== 'init' || isAsync || isGenerator || p.computed || p.key.type !== 'Identifier') this.unexpected();
    // shorthand { a } or the cover form { a = 1 } (valid only as a pattern)
    p.method = false; p.shorthand = true;
    const value = this.copyIdent(p.key);
    if (p.key.escaped) value.escaped = true;
    if (this.isP('=')) {
      this.next();
      const a = this.node(value.start);
      a.left = value;
      a.right = this.parseMaybeAssign(false);
      p.value = this.finish(a, 'AssignmentPattern');
    } else p.value = value;
    return this.finish(p, 'Property');
  }

  // At "(": a parenthesized expression or the parameter list of an arrow function.
  parseParenAndDistinguish() {
    const start = this.start;
    this.next();
    const items = [];
    let first = true, trailingComma = false, sawRest = false;
    while (!this.isP(')')) {
      if (!first) {
        this.expect(',');
        if (this.isP(')')) { trailingComma = true; break; }
      }
      first = false;
      if (this.isP('...')) {
        const r = this.node(); this.next();
        r.argument = this.parseBindingAtom();
        if (this.isP('=')) this.raise('A rest parameter cannot have a default value');
        items.push(this.finish(r, 'RestElement'));
        sawRest = true;
        break;
      }
      items.push(this.parseMaybeAssign(false));
    }
    this.expect(')');
    const parenEnd = this.lastTokEnd;
    if (this.isP('=>') && !this.nlBefore) {
      return this.parseArrow(this.node(start), items.map((e) => this.toAssignable(e)), false);
    }
    if (!items.length || sawRest || trailingComma) this.raise('Unexpected token', this.lastTokStart);
    let expr;
    if (items.length > 1) {
      expr = { type: 'SequenceExpression', start: items[0].start, end: items[items.length - 1].end, expressions: items };
    } else expr = items[0];
    // nested parentheses keep the outermost range
    expr.parenthesized = true;
    expr.parenStart = start;
    expr.parenEnd = parenEnd;
    return expr;
  }

  parseArrow(n, params, isAsync) {
    const saved = this.enterFunction(isAsync, false, true);
    this.expect('=>');
    n.id = null;
    n.params = params;
    n.async = isAsync;
    n.generator = false;
    if (this.isP('{')) {
      n.body = this.parseFunctionBody();
      n.expression = false;
    } else {
      n.body = this.parseMaybeAssign(false);
      n.expression = true;
    }
    this.leaveFunction(saved);
    return this.finish(n, 'ArrowFunctionExpression');
  }

  // Converts an expression parsed with the cover grammar into a pattern.
  toAssignable(node) {
    if (!node) return node;
    switch (node.type) {
      case 'Identifier': case 'MemberExpression': case 'ObjectPattern': case 'ArrayPattern': case 'AssignmentPattern': case 'RestElement':
        return node;
      case 'SpreadElement':   // async (...args) => {} arrives as call arguments
        node.type = 'RestElement';
        node.argument = this.toAssignable(node.argument);
        return node;
      case 'ObjectExpression':
        node.type = 'ObjectPattern';
        for (let i = 0; i < node.properties.length; i++) {
          const p = node.properties[i];
          if (p.type === 'SpreadElement') {
            p.type = 'RestElement';
            p.argument = this.toAssignable(p.argument);
          } else {
            if (p.kind !== 'init' || p.method) this.raise('Invalid destructuring target', p.start);
            p.value = this.toAssignable(p.value);
          }
        }
        return node;
      case 'ArrayExpression':
        node.type = 'ArrayPattern';
        for (let i = 0; i < node.elements.length; i++) {
          const e = node.elements[i];
          if (!e) continue;
          if (e.type === 'SpreadElement') { e.type = 'RestElement'; e.argument = this.toAssignable(e.argument); }
          else node.elements[i] = this.toAssignable(e);
        }
        return node;
      case 'AssignmentExpression':
        if (node.operator !== '=') this.raise('Invalid destructuring target', node.start);
        node.type = 'AssignmentPattern';
        delete node.operator;
        node.left = this.toAssignable(node.left);
        return node;
      case 'ChainExpression':
        this.raise('Invalid assignment target', node.start);
    }
    // Other expressions are invalid targets; V8 reports those (callers validate with node:vm when needed).
    return node;
  }
}

/**
 * Parses JavaScript source text.
 * @param {string} src
 * @param {{ sourceType?: 'module'|'script', allowReturnOutsideFunction?: boolean }} [options]
 */
export function parse(src, options = {}) {
  const p = new Parser(src, { sourceType: options.sourceType || 'module', allowReturnOutsideFunction: !!options.allowReturnOutsideFunction });
  return p.parseTopLevel();
}
