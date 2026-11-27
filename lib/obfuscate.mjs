/**
 * lib/obfuscate.mjs — EXPERIMENTAL JavaScript obfuscator. Part of vanilla-build. MIT License.
 *
 *   obfuscate(src, { sourceType = 'script' | 'module' | 'commonjs', seed, rename = true, strings = true,
 *                    stringArray = true, deadCode = false, controlFlow = false, controlFlowMin = 3, deadCodeRate = 0.3 })
 *     -> { code, stats: { seed, renamed, strings, escaped, flattened, deadBlocks, skipped: [] } }
 *
 * READ THE README SECTION "Experimental: obfuscation" BEFORE USING THIS. This is NOT a security measure: obfuscation
 * only raises the effort of reading the code, it never prevents recovery, and a determined reader will understand it.
 *
 * Every pass works on the AST from lib/parse and edits the source by ranges; the output is re-parsed after each pass.
 *   rename       renames bindings found by scope analysis (lib/parse/scope.mjs) to random names. Only declared names
 *                change: free variables (window, localStorage, navigator, any global your page defines) never do.
 *                Top-level names of a classic script are globals and are kept; in a module / CommonJS file the
 *                top-level names that are not imported or exported are renamed. Skipped completely when the code
 *                uses direct eval or with. Function and class .name values change.
 *   strings      writes string literals as \x / \u escapes (property keys too; directives and module specifiers not).
 *   stringArray  moves string literals into one encoded table (custom base64 alphabet over UTF-8, rotated) read
 *                through a decoder function: D(0x1f). In a classic script the table goes inside the outermost
 *                wrapper function (iife / UMD factory) so no global is added; scripts without one are left alone.
 *   deadCode     inserts unreachable `if (<always false>) { ... }` blocks into function bodies.
 *   controlFlow  turns function bodies with at least controlFlowMin statements into a shuffled switch inside a
 *                loop, driven by an order string. Function declarations stay hoisted (inside the switch block).
 * No pass uses eval, new Function or other string-to-code features: output runs under a CSP without 'unsafe-eval'.
 * Self-defending / anti-debugging tricks are deliberately not offered (they only hurt real users).
 */
import crypto from 'node:crypto';
import { parse } from './parse/parser.mjs';
import { analyze, allNames, occurrenceText } from './parse/scope.mjs';
import { forEachChild } from './parse/walk.mjs';
import { Editor } from './edit.mjs';

export const OPTION_NAMES = ['rename', 'strings', 'stringArray', 'deadCode', 'controlFlow'];
export const DEFAULT_OPTIONS = { rename: true, strings: true, stringArray: true, deadCode: false, controlFlow: false, controlFlowMin: 3, deadCodeRate: 0.3 };

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function parseAs(src, sourceType) {
  return parse(src, sourceType === 'module' ? { sourceType: 'module' } : { sourceType: 'script', allowReturnOutsideFunction: sourceType === 'commonjs' });
}

// Parent links for every node.
function parents(ast) {
  const map = new Map();
  (function visit(n, p) { map.set(n, p); forEachChild(n, (c) => visit(c, n)); })(ast, null);
  return map;
}
function patternIds(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternIds(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) patternIds(e, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  return out;
}
function isFunction(n) { return n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'; }
function directiveCount(body) { let k = 0; while (k < body.length && body[k].directive !== undefined) k++; return k; }

class Names {
  constructor(ast, A, rng) {
    this.used = allNames(ast);
    for (const n of A.free.keys()) this.used.add(n);
    this.rng = rng;
  }
  next() {
    for (;;) {
      const len = 4 + Math.floor(this.rng() * 3);
      let h = '';
      for (let i = 0; i < len; i++) h += Math.floor(this.rng() * 16).toString(16);
      const name = '_0x' + h;
      if (!this.used.has(name)) { this.used.add(name); return name; }
    }
  }
}

// ---------------------------------------------------------------- rename
function passRename(src, opts, rng, stats) {
  const ast = parseAs(src, opts.sourceType);
  const A = analyze(ast);
  if (A.unsafe) { stats.skipped.push('rename: code uses ' + A.unsafe); return src; }
  const names = new Names(ast, A, rng);
  const exported = new Set();
  if (opts.sourceType === 'module') {
    for (const s of ast.body) {
      if (s.type === 'ExportNamedDeclaration') {
        if (s.declaration) {
          const d = s.declaration;
          if (d.type === 'VariableDeclaration') {
            for (const decl of d.declarations) (function ids(p) {
              if (!p) return;
              if (p.type === 'Identifier') exported.add(p.name);
              else if (p.type === 'ObjectPattern') p.properties.forEach((q) => ids(q.type === 'RestElement' ? q.argument : q.value));
              else if (p.type === 'ArrayPattern') p.elements.forEach(ids);
              else if (p.type === 'RestElement') ids(p.argument);
              else if (p.type === 'AssignmentPattern') ids(p.left);
            })(decl.id);
          } else if (d.id) exported.add(d.id.name);
        }
      } else if (s.type === 'ExportDefaultDeclaration' && s.declaration.id) exported.add(s.declaration.id.name);
    }
  }
  const ed = new Editor(src);
  for (const s of A.scopes) {
    if (s.isRoot && opts.sourceType === 'script') continue;
    for (const b of s.vars.values()) {
      if (b.keep || b.implicit) continue;
      if (s.isRoot && (b.kind === 'import' || exported.has(b.name))) continue;
      const nn = names.next();
      for (const id of [...b.decls, ...b.refs]) ed.overwrite(id.start, id.end, occurrenceText(src, id, nn, A));
      stats.renamed++;
    }
  }
  return ed.toString();
}

// ---------------------------------------------------------------- dead code
function opaqueFalse(rng) {
  const a = 1 + Math.floor(rng() * 0xffff), b = 1 + Math.floor(rng() * 0xffff);
  const forms = [
    () => '(0x' + a.toString(16) + ' ^ 0x' + a.toString(16) + ') !== 0',
    () => '0x' + a.toString(16) + ' * 0x' + b.toString(16) + ' < 0',
    () => '"' + a.toString(36) + '".length > 0x' + (a.toString(36).length + 1 + (b % 5)).toString(16),
    () => '(0x' + a.toString(16) + ' & 1) === 2',
  ];
  return forms[Math.floor(rng() * forms.length)]();
}
function junk(names, rng) {
  const v = names.next(), w = names.next();
  const n = Math.floor(rng() * 0xfff);
  const forms = [
    () => 'let ' + v + ' = [0x' + n.toString(16) + ', "' + n.toString(36) + '"]; ' + v + '.reverse();',
    () => 'let ' + v + ' = 0x' + n.toString(16) + '; for (let ' + w + ' = 0; ' + w + ' < ' + v + '; ' + w + '++) ' + v + ' ^= ' + w + ';',
    () => 'let ' + v + ' = { ' + w + ': 0x' + n.toString(16) + ' }; delete ' + v + '.' + w + ';',
    () => 'let ' + v + ' = "' + n.toString(36) + '".split("").join("-");',
  ];
  return forms[Math.floor(rng() * forms.length)]();
}
function passDeadCode(src, opts, rng, stats) {
  const ast = parseAs(src, opts.sourceType);
  const A = analyze(ast);
  const names = new Names(ast, A, rng);
  const ed = new Editor(src);
  (function visit(n) {
    if (isFunction(n) && n.body.type === 'BlockStatement') {
      const body = n.body.body;
      const first = directiveCount(body);
      for (let i = first; i <= body.length; i++) {
        if (rng() >= opts.deadCodeRate) continue;
        const pos = i < body.length ? body[i].start : n.body.end - 1;
        ed.insert(pos, ';if (' + opaqueFalse(rng) + ') { ' + junk(names, rng) + ' }\n');
        stats.deadBlocks++;
      }
    }
    forEachChild(n, visit);
  })(ast);
  return ed.toString();
}

// ---------------------------------------------------------------- control flow flattening
function passControlFlow(src, opts, rng, stats) {
  const ast = parseAs(src, opts.sourceType);
  const A = analyze(ast);
  const names = new Names(ast, A, rng);
  const bodies = [];
  (function visit(n) {
    if (isFunction(n) && n.body.type === 'BlockStatement') bodies.push(n.body);
    forEachChild(n, visit);
  })(ast);
  bodies.sort((a, b) => a.start - b.start);

  // Text of src[start, end) with every function body inside it transformed.
  function render(start, end) {
    let out = '';
    let pos = start;
    for (const b of bodies) {
      if (b.start < pos || b.end > end) continue;
      out += src.slice(pos, b.start) + transform(b);
      pos = b.end;
    }
    return out + src.slice(pos, end);
  }
  function transform(body) {
    const list = body.body;
    const k = directiveCount(list);
    const fns = [], rest = [];
    for (let i = k; i < list.length; i++) (list[i].type === 'FunctionDeclaration' ? fns : rest).push(list[i]);
    if (rest.length < opts.controlFlowMin) return '{' + render(body.start + 1, body.end - 1) + '}';
    stats.flattened++;
    const keys = [];
    const seen = new Set();
    while (keys.length < rest.length) {
      const key = Math.floor(rng() * 0x10000).toString(36);
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
    const S = names.next(), I = names.next();
    const order = keys.join('|');
    // Every pass through the loop enters the switch block anew, which would re-create let / const / class
    // bindings declared inside it. So they are declared once before the loop (`let a, b;`) and their declarations
    // become assignments. Function declarations go before the loop too, where they see those names.
    const lexical = [];
    const range = (n) => n.parenthesized ? [n.parenStart, n.parenEnd] : [n.start, n.end];
    const stmtText = (s) => {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
        const parts = [];
        for (const d of s.declarations) {
          for (const id of patternIds(d.id)) lexical.push(id.name);
          if (!d.init) continue;
          const [is, ie] = range(d.init);
          const target = render(d.id.start, d.id.end);
          parts.push(d.id.type === 'Identifier' ? target + ' = ' + render(is, ie) : '(' + target + ' = ' + render(is, ie) + ')');
        }
        return parts.join(';\n') + ';';
      }
      if (s.type === 'ClassDeclaration') {
        lexical.push(s.id.name);
        return s.id.name + ' = ' + render(s.start, s.end) + ';';
      }
      return render(s.start, s.end);
    };
    const cases = rest.map((s, i) => ({ key: keys[i], text: stmtText(s) }));
    shuffle(cases, rng);
    const fnText = fns.map((f) => render(f.start, f.end)).join('\n');
    const caseText = cases.map((c) => 'case "' + c.key + '": ' + c.text + '\n;continue;').join('\n');
    const dirs = list.slice(0, k).map((d) => src.slice(d.start, d.end) + (src[d.end - 1] === ';' ? '' : ';')).join('\n');
    return '{' + (dirs ? dirs + '\n' : '') + (lexical.length ? 'let ' + lexical.join(', ') + ';\n' : '') + (fnText ? fnText + '\n' : '') +
      'var ' + S + ' = "' + order + '".split("|"), ' + I + ' = 0;\nwhile (true) {\nswitch (' + S + '[' + I + '++]) {\n' + caseText + '\n}\nbreak;\n}\n}';
  }
  return render(0, src.length);
}

// ---------------------------------------------------------------- string array
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function utf8(str) { return Buffer.from(str, 'utf8'); }
function hasLoneSurrogate(s) { return /[\ud800-\udbff](?![\udc00-\udfff])|(?:[^\ud800-\udbff]|^)[\udc00-\udfff]/.test(s); }
function encode64(bytes, alphabet) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
    const keep = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let j = 0; j < keep; j++) out += alphabet[chars[j]];
  }
  return out;
}

// Literal string nodes that may be replaced by an expression.
function replaceableStrings(ast, region, parentOf) {
  const list = [];
  (function visit(n) {
    if (n.type === 'Literal' && typeof n.value === 'string' && n.start >= region[0] && n.end <= region[1]) {
      const p = parentOf.get(n);
      const isKey = p && (p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n && !p.computed;
      const isModuleName = p && (p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration' || p.type === 'ExportAllDeclaration' ||
        p.type === 'ImportSpecifier' || p.type === 'ExportSpecifier' || p.type === 'ImportAttribute');
      const isDirective = p && p.type === 'ExpressionStatement' && p.directive !== undefined;
      if (!isKey && !isModuleName && !isDirective && n.value.length > 0 && !hasLoneSurrogate(n.value)) list.push(n);
    }
    forEachChild(n, visit);
  })(ast);
  return list;
}

function passStringArray(src, opts, rng, stats) {
  const ast = parseAs(src, opts.sourceType);
  const A = analyze(ast);
  const parentOf = parents(ast);
  let insertAt, region, prefix = '';
  if (opts.sourceType === 'script') {
    // the outermost wrapper function: a function expression called (or passed to a call) by a top-level statement.
    // This covers a bare IIFE / UMD (`(function(){...})()`, `!function(){...}()`) and the named form a bundler emits
    // for iife output with a global name (`var X = (function(){...})();`).
    const cands = [];
    const find = (n, depth) => {
      if (!n || depth > 3) return;
      if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.body.type === 'BlockStatement') { cands.push(n); return; }
      if (n.type === 'CallExpression') { find(n.callee, depth + 1); n.arguments.forEach((a) => find(a, depth + 1)); }
      else if (n.type === 'UnaryExpression' || n.type === 'SequenceExpression' || n.type === 'AssignmentExpression' || n.type === 'ChainExpression') {
        if (n.type === 'SequenceExpression') n.expressions.forEach((e) => find(e, depth + 1));
        else if (n.type === 'AssignmentExpression') find(n.right, depth + 1);
        else find(n.argument || n.expression, depth + 1);
      }
    };
    for (const s of ast.body) {
      if (s.type === 'ExpressionStatement') find(s.expression, 0);
      else if (s.type === 'VariableDeclaration') for (const d of s.declarations) find(d.init, 1);
    }
    if (!cands.length) { stats.skipped.push('stringArray: classic script without a wrapper function (a table would be a new global)'); return src; }
    let best = null, bestCount = -1;
    for (const f of cands) {
      const c = replaceableStrings(ast, [f.body.start, f.body.end], parentOf).length;
      if (c > bestCount) { best = f; bestCount = c; }
    }
    const k = directiveCount(best.body.body);
    insertAt = k ? best.body.body[k - 1].end : best.body.start + 1;
    region = [best.body.start, best.body.end];
    prefix = k ? '\n' : '';
  } else {
    const k = directiveCount(ast.body);
    insertAt = k ? ast.body[k - 1].end : (ast.hashbang ? ast.hashbang.length : 0);
    region = [insertAt, src.length];
    prefix = '\n';
  }
  const lits = replaceableStrings(ast, region, parentOf);
  if (!lits.length) return src;
  const names = new Names(ast, A, rng);
  const T = names.next(), D = names.next(), C = names.next();
  const values = [...new Set(lits.map((l) => l.value))];
  shuffle(values, rng);
  const alphabet = shuffle(B64.split(''), rng).join('');
  const encoded = values.map((v) => encode64(utf8(v), alphabet));
  const rot = Math.floor(rng() * values.length);
  // stored rotated left by rot: the table function rotates it back once, on first use
  const stored = encoded.slice(rot).concat(encoded.slice(0, rot));
  const offset = 0x40 + Math.floor(rng() * 0x400);
  const index = new Map(values.map((v, i) => [v, i]));
  const ed = new Editor(src);
  // A string literal can directly follow a keyword with no space in minified code (`case"x":`, `return"x"`,
  // `typeof"x"`). The decoder name is an identifier, so pad with a space when the preceding char is identifier-part,
  // or `case_0x..` / `return_0x..` would tokenize as one name.
  for (const l of lits) {
    const pad = l.start > 0 && /[\w$]/.test(src[l.start - 1]) ? ' ' : '';
    ed.overwrite(l.start, l.end, pad + D + '(0x' + (index.get(l.value) + offset).toString(16) + ')');
  }
  stats.strings += lits.length;
  const table = 'function ' + T + '() { var a = [' + stored.map((s) => '"' + s + '"').join(', ') + '];\n' +
    'for (var k = 0; k < ' + (values.length - rot) % values.length + '; k++) a.push(a.shift());\n' +
    T + ' = function () { return a; }; return a; }\n';
  const decoder = 'function ' + D + '(i) { i = i - 0x' + offset.toString(16) + '; ' + D + '.' + C + ' = ' + D + '.' + C + ' || {};\n' +
    'var c = ' + D + '.' + C + '; if (c[i] !== void 0) return c[i];\n' +
    'var s = ' + T + '()[i], al = "' + alphabet + '", b = [], n = 0, bits = 0;\n' +
    'for (var j = 0; j < s.length; j++) { n = (n << 6) | al.indexOf(s.charAt(j)); bits += 6; if (bits >= 8) { bits -= 8; b.push((n >> bits) & 255); } }\n' +
    'var r = ""; for (var q = 0; q < b.length; q++) r += "%" + (b[q] < 16 ? "0" : "") + b[q].toString(16);\n' +
    'return (c[i] = decodeURIComponent(r)); }\n';
  ed.insert(insertAt, prefix + table + decoder);
  return ed.toString();
}

// ---------------------------------------------------------------- string escapes
function escapeString(value, rng) {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) { out += '\\u{' + cp.toString(16) + '}'; continue; }
    if (cp < 256 && rng() < 0.6) out += '\\x' + cp.toString(16).padStart(2, '0');
    else out += '\\u' + cp.toString(16).padStart(4, '0');
  }
  return '"' + out + '"';
}
function passStrings(src, opts, rng, stats) {
  const ast = parseAs(src, opts.sourceType);
  const parentOf = parents(ast);
  const ed = new Editor(src);
  (function visit(n) {
    if (n.type === 'Literal' && typeof n.value === 'string') {
      const p = parentOf.get(n);
      const skip = p && ((p.type === 'ExpressionStatement' && p.directive !== undefined) || p.type === 'ImportDeclaration' ||
        p.type === 'ExportNamedDeclaration' || p.type === 'ExportAllDeclaration' || p.type === 'ImportAttribute' ||
        p.type === 'ImportSpecifier' || p.type === 'ExportSpecifier');
      if (!skip && !hasLoneSurrogate(n.value) && n.value.length) { ed.overwrite(n.start, n.end, escapeString(n.value, rng)); stats.escaped++; }
    }
    forEachChild(n, visit);
  })(ast);
  return ed.toString();
}

// ---------------------------------------------------------------- entry
export function obfuscate(src, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, sourceType: 'script', ...options };
  if (!['script', 'module', 'commonjs'].includes(opts.sourceType)) throw new Error('sourceType must be script, module or commonjs');
  const seed = opts.seed != null ? Number(opts.seed) : crypto.createHash('sha256').update(src).digest().readUInt32LE(0);
  const rng = mulberry32(seed);
  const stats = { seed, renamed: 0, strings: 0, escaped: 0, flattened: 0, deadBlocks: 0, skipped: [] };
  let code = String(src);
  parseAs(code, opts.sourceType);   // fail early on input that cannot be read
  if (opts.rename) code = passRename(code, opts, rng, stats);
  if (opts.deadCode) code = passDeadCode(code, opts, rng, stats);
  if (opts.controlFlow) code = passControlFlow(code, opts, rng, stats);
  if (opts.stringArray) code = passStringArray(code, opts, rng, stats);
  if (opts.strings) code = passStrings(code, opts, rng, stats);
  parseAs(code, opts.sourceType);   // internal check: the result must still parse
  return { code, stats };
}
