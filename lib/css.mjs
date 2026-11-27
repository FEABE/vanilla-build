/**
 * lib/css.mjs — CSS: @import inlining and a conservative minifier.
 * Part of vanilla-build. MIT License.
 *
 *   inlineImports(file, { root }) -> { css, files }   files: every stylesheet that was inlined (including file)
 *   minifyCss(css) -> string
 *
 * inlineImports replaces `@import "x.css";` / `@import url(x.css) screen;` (local files only) with the file's
 * content — wrapped in `@media ... { }` when the import has a media list — and rewrites relative url(...) inside
 * the inlined file so it still points at the same file from the importing stylesheet's folder. Imports with
 * layer(...) or supports(...) conditions, remote URLs, and cycles are left as they are.
 *
 * minifyCss only removes what cannot matter: comments (except /*! ... *\/), runs of whitespace (to one space),
 * whitespace next to { } ; , and after :, and the last ; before }. Strings, url(...) contents and the values of
 * custom properties (--x: ...) are copied byte for byte. Nothing is reordered, merged or shortened.
 */
import fs from 'node:fs';
import path from 'node:path';

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isWord = (c) => !!c && /[\w\-.#%\u0080-￿]/.test(c);

/** Splits CSS into chunks: { t: 'comment'|'string'|'url'|'ws'|'char', v }. */
export function tokenizeCss(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out.push({ t: 'comment', v: css.slice(i, end) });
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c && css[j] !== '\n') { if (css[j] === '\\') j++; j++; }
      j = Math.min(j + 1, n);
      out.push({ t: 'string', v: css.slice(i, j) });
      i = j;
    } else if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !isWord(css[i - 1])) {
      // url( unquoted ) is one token; url("quoted") is url( + string + )
      let j = i + 4;
      while (j < n && isWs(css[j])) j++;
      if (css[j] === '"' || css[j] === "'") { out.push({ t: 'char', v: css.slice(i, i + 4) }); i += 4; continue; }
      while (j < n && css[j] !== ')') { if (css[j] === '\\') j++; j++; }
      j = Math.min(j + 1, n);
      out.push({ t: 'url', v: css.slice(i, j) });
      i = j;
    } else if (isWs(c)) {
      let j = i + 1;
      while (j < n && isWs(css[j])) j++;
      out.push({ t: 'ws', v: css.slice(i, j) });
      i = j;
    } else {
      if (c === '\\') { out.push({ t: 'char', v: css.slice(i, i + 2) }); i += 2; continue; }
      out.push({ t: 'char', v: c });
      i++;
    }
  }
  return out;
}

const TIGHT = new Set(['{', '}', ';', ',']);

export function minifyCss(css) {
  const toks = tokenizeCss(css);
  let out = '';
  let pendingSpace = false;
  // true right after "{" or ";" (ignoring whitespace and comments): a declaration may start here
  let declStart = true;
  const last = () => out[out.length - 1];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'comment') {
      if (tk.v.startsWith('/*!')) { if (pendingSpace && out) out += ' '; pendingSpace = false; out += tk.v; continue; }
      // a comment between two word characters separates them: keep an empty one
      const next = toks[i + 1];
      if (!pendingSpace && isWord(last()) && next && next.t !== 'ws' && isWord(next.v[0])) out += '/**/';
      continue;
    }
    if (tk.t === 'ws') { pendingSpace = true; continue; }
    // custom property: copy the value verbatim up to the ; or } that ends it
    if (declStart && tk.t === 'char' && tk.v === '-' && toks[i + 1] && toks[i + 1].v === '-') {
      let j = i, name = '';
      while (j < toks.length && toks[j].t === 'char' && /[\w-]/.test(toks[j].v)) { name += toks[j].v; j++; }
      let k = j;
      while (k < toks.length && (toks[k].t === 'ws' || toks[k].t === 'comment')) k++;
      if (toks[k] && toks[k].v === ':') {
        if (pendingSpace && out && !TIGHT.has(last())) out += ' ';
        pendingSpace = false;
        out += name + ':';
        let depth = 0, raw = '';
        let m = k + 1;
        for (; m < toks.length; m++) {
          const v = toks[m].v;
          if (toks[m].t === 'char') {
            if (v === '(' || v === '[' || v === '{') depth++;
            else if (v === ')' || v === ']') depth--;
            else if (v === '}') { if (depth === 0) break; depth--; }
            else if (v === ';' && depth === 0) break;
          }
          raw += v;
        }
        out += raw;
        i = m - 1;
        declStart = false;
        continue;
      }
    }
    const v = tk.v;
    if (pendingSpace && out) {
      const tightBefore = tk.t === 'char' && TIGHT.has(v);
      const tightAfter = TIGHT.has(last()) || last() === ':';
      if (!tightBefore && !tightAfter) out += ' ';
    }
    pendingSpace = false;
    if (tk.t === 'char' && v === '}' && last() === ';') out = out.slice(0, -1);
    out += v;
    if (tk.t === 'char') declStart = v === '{' || v === ';';
    else declStart = false;
  }
  return out.trim();
}

function isLocalUrl(u) {
  return !!u && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);
}
function unquote(s) {
  s = s.trim();
  if ((s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

// Rewrites relative url(...) references from fromDir to toDir.
function rebaseUrls(css, fromDir, toDir) {
  if (fromDir === toDir) return css;
  const toks = tokenizeCss(css);
  const fix = (u) => {
    if (!isLocalUrl(u) || u.startsWith('/')) return u;
    return path.posix.relative(toDir, path.posix.join(fromDir, u)) || '.';
  };
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'url') {
      const inner = tk.v.slice(4, -1);
      out += 'url(' + fix(inner.trim()) + ')';
    } else if (tk.t === 'char' && /^url\($/i.test(tk.v)) {
      // url( "string" )
      let j = i + 1;
      while (toks[j] && toks[j].t === 'ws') j++;
      if (toks[j] && toks[j].t === 'string') {
        const q = toks[j].v[0];
        out += tk.v + q + fix(toks[j].v.slice(1, -1)) + q;
        i = j;
      } else out += tk.v;
    } else out += tk.v;
  }
  return out;
}

const posixRel = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** Inlines local @import rules. root is used for "/x.css" (root-relative) imports and for url() rebasing. */
export function inlineImports(file, options = {}) {
  const root = path.resolve(options.root || path.dirname(file));
  const files = [];
  const warnings = [];
  function load(f, stack) {
    files.push(f);
    let css = fs.readFileSync(f, 'utf8');
    if (css.charCodeAt(0) === 0xfeff) css = css.slice(1);
    const toks = tokenizeCss(css);
    let out = '';
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === 'char' && tk.v === '{') depth++;
      if (tk.t === 'char' && tk.v === '}') depth--;
      if (depth === 0 && tk.t === 'char' && tk.v === '@' && /^import\b/i.test(toks.slice(i + 1, i + 7).map((t) => t.v).join(''))) {
        // read up to the ; that ends the rule
        let j = i + 1, text = '@';
        while (j < toks.length && !(toks[j].t === 'char' && toks[j].v === ';')) { text += toks[j].v; j++; }
        const rule = text.slice(7).trim();     // after "@import"
        let url = null, rest = '';
        const um = /^url\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*\)\s*/i.exec(rule);
        const sm = /^("[^"]*"|'[^']*')\s*/.exec(rule);
        if (um) { url = unquote(um[1]); rest = rule.slice(um[0].length); }
        else if (sm) { url = unquote(sm[1]); rest = rule.slice(sm[0].length); }
        const complex = /^(layer|supports)\b/i.test(rest);
        if (url && isLocalUrl(url) && !complex) {
          const target = url.startsWith('/') ? path.join(root, url) : path.resolve(path.dirname(f), url);
          if (stack.includes(target)) { warnings.push(posixRel(root, f) + ': @import cycle through ' + url + ' left as is'); out += text + ';'; i = j; continue; }
          if (!fs.existsSync(target)) throw new Error(posixRel(root, f) + ': @import of a missing file ' + url);
          let inner = load(target, [...stack, target]);
          inner = inner.replace(/^\s*@charset\s+("[^"]*"|'[^']*')\s*;/i, '');
          // relative to the importing file; its own importer rebases the combined text again
          inner = rebaseUrls(inner, posixRel(root, path.dirname(target)) || '.', posixRel(root, path.dirname(f)) || '.');
          out += rest ? '@media ' + rest + ' {\n' + inner + '\n}' : inner;
          i = j;
          continue;
        }
        out += text + (j < toks.length ? ';' : '');
        i = j;
        continue;
      }
      out += tk.v;
    }
    return out;
  }
  const abs = path.resolve(file);
  const css = load(abs, [abs]);
  return { css, files, warnings };
}
