/**
 * lib/html.mjs — finds and rewrites asset references in HTML: <script src>, <link href>, <img src>.
 * Part of vanilla-build. MIT License.
 *
 *   scanHtml(html) -> [{ tag, attr, value, start, end, attrs, tagEnd }]
 *   rewriteHtml(html, (ref) => null | { url, integrity? }) -> string
 *
 * A small tag scanner, not a full HTML parser: it skips comments and the raw text of <script>, <style>,
 * <textarea>, <title>, reads attributes with or without quotes, and edits attribute values in place (keeping the
 * original quotes). Everything it does not rewrite is left byte for byte.
 */

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
const TARGETS = { script: ['src'], link: ['href'], img: ['src'] };

function readTag(html, i) {
  // at "<": returns { name, attrs: [{ name, value, vStart, vEnd, quote }], end } or null
  const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 64));
  if (!m) return null;
  const name = m[1].toLowerCase();
  let j = i + m[0].length;
  const attrs = [];
  const n = html.length;
  for (;;) {
    while (j < n && /\s/.test(html[j])) j++;
    if (j >= n) return { name, attrs, end: n, closeStart: n };
    if (html[j] === '>') return { name, attrs, end: j + 1, closeStart: j };
    if (html[j] === '/' && html[j + 1] === '>') return { name, attrs, end: j + 2, closeStart: j };
    if (html[j] === '/') { j++; continue; }
    const am = /^[^\s"'>/=]+/.exec(html.slice(j));
    if (!am) { j++; continue; }
    const aname = am[0].toLowerCase();
    j += am[0].length;
    let k = j;
    while (k < n && /\s/.test(html[k])) k++;
    if (html[k] !== '=') { attrs.push({ name: aname, value: '', vStart: -1, vEnd: -1, quote: '' }); continue; }
    k++;
    while (k < n && /\s/.test(html[k])) k++;
    const q = html[k];
    if (q === '"' || q === "'") {
      const e = html.indexOf(q, k + 1);
      const end = e < 0 ? n : e;
      attrs.push({ name: aname, value: html.slice(k + 1, end), vStart: k + 1, vEnd: end, quote: q });
      j = Math.min(end + 1, n);
    } else {
      const vm = /^[^\s>]*/.exec(html.slice(k));
      attrs.push({ name: aname, value: vm[0], vStart: k, vEnd: k + vm[0].length, quote: '' });
      j = k + vm[0].length;
    }
  }
}

const decodeAttr = (v) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function scanHtml(html) {
  const refs = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const tag = readTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    const want = TARGETS[tag.name];
    if (want) {
      for (const a of tag.attrs) {
        if (want.includes(a.name) && a.vStart >= 0) {
          const attrs = Object.fromEntries(tag.attrs.map((x) => [x.name, decodeAttr(x.value)]));
          refs.push({ tag: tag.name, attr: a.name, value: decodeAttr(a.value).trim(), start: a.vStart, end: a.vEnd, quote: a.quote, attrs, tagEnd: tag.closeStart });
        }
      }
    }
    i = tag.end;
    if (RAW_TEXT.has(tag.name)) {
      const close = html.toLowerCase().indexOf('</' + tag.name, i);
      i = close < 0 ? n : close;
    }
  }
  return refs;
}

/** Is the URL a file of this site (relative or root-relative), not an external / data / fragment URL? */
export function isLocalRef(url) {
  return !!url && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

export function rewriteHtml(html, fn) {
  const refs = scanHtml(html);
  let out = '';
  let pos = 0;
  for (const r of refs) {
    const res = fn(r);
    if (!res) continue;
    const q = r.quote || '"';
    const value = res.url.replace(/&/g, '&amp;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&#39;');
    out += html.slice(pos, r.start);
    out += r.quote ? value : q + value + q;
    pos = r.end;
    if (res.integrity && !('integrity' in r.attrs)) {
      // added as the tag's last attribute; a "/" before ">" stays where it was
      out += html.slice(pos, r.tagEnd).replace(/\s*$/, '') + ' integrity="' + res.integrity + '"';
      pos = r.tagEnd;
    }
  }
  return out + html.slice(pos);
}
