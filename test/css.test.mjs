import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minifyCss, inlineImports, tokenizeCss } from '../lib/css.mjs';
import { tempDir, writeFiles } from './helpers/run.mjs';

// Oracle: the minifier may only drop whitespace and comments. Everything else — every character outside
// whitespace / comments — must survive in the same order.
function significant(css) {
  return tokenizeCss(css).filter((t) => t.t !== 'ws' && !(t.t === 'comment' && !t.v.startsWith('/*!'))).map((t) => t.v).join('');
}

test('css: whitespace and comments go, the rest stays in order', () => {
  const src = '/* header */\n.a  ,  .b > .c {\n  color :  red ;\n  margin: 0  auto;\n}\n\n@media screen and (max-width: 600px) {\n  .a { display : none ; }\n}\n';
  const out = minifyCss(src);
  assert.equal(out, '.a,.b > .c{color :red;margin:0 auto}@media screen and (max-width:600px){.a{display :none}}');
  // the only thing besides whitespace that may go is the last ";" before "}"
  assert.equal(significant(out).replace(/;}/g, '}'), significant(src).replace(/;}/g, '}'));
});

test('css: url(), strings, content: and custom properties are untouched', () => {
  const cases = [
    ['.a { background: url(  img/a.png  ) }', 'url(  img/a.png  )'],
    ['.a { background: url( "a  b.png" ) }', '"a  b.png"'],
    ['.a { background: url(data:image/svg+xml;utf8,<svg  a="1"></svg>) }', 'url(data:image/svg+xml;utf8,<svg  a="1"></svg>)'],
    ['.a::before { content: "  /* not a comment */  ;  { } " }', '"  /* not a comment */  ;  { } "'],
    [".a::after { content: '\\'  x  \\'' }", "'\\'  x  \\''"],
    ['.a { --spacing:   4px   8px ; --obj: {  a : b ; c } ; --empty: ; color: var(--spacing) }', '--spacing:   4px   8px ;'],
    ['.a { --obj: {  a : b ; c } }', '--obj: {  a : b ; c } '],
    ['.a { --json: [ 1 ,  2 ] ; }', '--json: [ 1 ,  2 ] '],
    ['.a { grid-template-areas: "a  b"   "c  d" }', '"a  b" "c  d"'],
    ['.a { width: calc(100%  -  (2 * 4px)) }', 'calc(100% - (2 * 4px))'],
    ['a :hover, a:focus { x: y }', 'a :hover,a:focus'],
    ['/*! keep me */ .a{}', '/*! keep me */'],
  ];
  for (const [src, mustContain] of cases) {
    const out = minifyCss(src);
    assert.ok(out.includes(mustContain), JSON.stringify(src) + ' -> ' + JSON.stringify(out));
  }
  assert.equal(minifyCss('a/**/b{}'), 'a/**/b{}', 'a comment between two words still separates them');
  assert.equal(minifyCss('.a { --x:1 }'), '.a{--x:1 }');
});

test('css: minify is idempotent', () => {
  const src = '.a { color: red; } /* c */ .b{ --v :  1 ; background:url( x.png ) }';
  const once = minifyCss(src);
  assert.equal(minifyCss(once), once);
});

test('css: @import inlining, media wrapping, url rebasing, untouched cases', () => {
  const dir = tempDir('vb-css-');
  try {
    writeFiles(dir, {
      'css/app.css': '@charset "utf-8";\n@import "./parts/base.css";\n@import url(parts/print.css) print;\n@import url("https://example.com/remote.css");\n@import "./parts/layered.css" layer(base);\n.app { background: url(../img/app.png) }\n',
      'css/parts/base.css': '@import "../../shared/vars.css";\n.base { background: url("../../img/base.png"); }\n',
      'css/parts/print.css': '.p { display: none }\n',
      'css/parts/layered.css': '.l {}\n',
      'shared/vars.css': ':root { --c: red; background: url(./tile.png) }\n',
    });
    const r = inlineImports(path.join(dir, 'css/app.css'), { root: dir });
    assert.match(r.css, /--c: red/);
    assert.match(r.css, /url\(\.\.\/shared\/tile\.png\)/, 'nested url rebased to css/');
    assert.match(r.css, /url\("\.\.\/img\/base\.png"\)/, 'quoted url rebased');
    assert.match(r.css, /@media print \{\n\.p \{ display: none \}/);
    assert.match(r.css, /@import url\("https:\/\/example\.com\/remote\.css"\);/);
    assert.match(r.css, /@import "\.\/parts\/layered\.css" layer\(base\);/);
    assert.match(r.css, /url\(\.\.\/img\/app\.png\)/, 'own urls untouched');
    assert.deepEqual(r.files.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort(),
      ['css/app.css', 'css/parts/base.css', 'css/parts/print.css', 'shared/vars.css']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('css: @import cycles are left in place with a warning', () => {
  const dir = tempDir('vb-css-');
  try {
    writeFiles(dir, { 'a.css': '@import "b.css";\n.a{}', 'b.css': '@import "a.css";\n.b{}' });
    const r = inlineImports(path.join(dir, 'a.css'), { root: dir });
    assert.equal(r.warnings.length, 1);
    assert.match(r.css, /@import "a\.css";/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
