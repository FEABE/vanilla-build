import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanHtml, rewriteHtml, isLocalRef } from '../lib/html.mjs';

const page = `<!doctype html>
<html><head>
<!-- <script src="commented.js"></script> -->
<link rel="stylesheet" href="css/app.css">
<link rel=icon href=img/icon.png>
<link rel="stylesheet" href="https://cdn.example.com/x.css">
<script type="module" src='./js/main.js'></script>
<script src="//cdn.example.com/lib.js"></script>
<script>const s = '<img src="inline.png">';</script>
</head><body>
<img src="/img/logo.png?v=2#top" alt="logo"/>
<img src="data:image/png;base64,AAAA">
<textarea><script src="not-a-tag.js"></script></textarea>
</body></html>`;

test('html: finds script / link / img references, skips comments and raw text', () => {
  const refs = scanHtml(page).map((r) => r.tag + ' ' + r.value);
  assert.deepEqual(refs, [
    'link css/app.css', 'link img/icon.png', 'link https://cdn.example.com/x.css', 'script ./js/main.js',
    'script //cdn.example.com/lib.js', 'img /img/logo.png?v=2#top', 'img data:image/png;base64,AAAA',
  ]);
  assert.deepEqual(refs.map((r) => isLocalRef(r.split(' ')[1])), [true, true, false, true, false, true, false]);
});

test('html: rewrites only what the callback maps, keeps quotes and everything else', () => {
  const map = { 'css/app.css': 'css/app.11111111.css', 'img/icon.png': 'img/icon.22222222.png', './js/main.js': './js/main.33333333.js', '/img/logo.png?v=2#top': '/img/logo.44444444.png?v=2#top' };
  const out = rewriteHtml(page, (r) => map[r.value] ? { url: map[r.value], integrity: r.tag === 'script' ? 'sha384-abc' : null } : null);
  assert.match(out, /<link rel="stylesheet" href="css\/app\.11111111\.css">/);
  assert.match(out, /<link rel=icon href="img\/icon\.22222222\.png">/);
  assert.match(out, /<script type="module" src='\.\/js\/main\.33333333\.js' integrity="sha384-abc"><\/script>/);
  assert.match(out, /<img src="\/img\/logo\.44444444\.png\?v=2#top" alt="logo"\/>/);
  assert.ok(out.includes('<!-- <script src="commented.js"></script> -->'));
  assert.ok(out.includes(`const s = '<img src="inline.png">';`));
  assert.ok(out.includes('https://cdn.example.com/x.css') && out.includes('//cdn.example.com/lib.js') && out.includes('data:image/png;base64,AAAA'));
  // nothing else changed
  const strip = (s) => s.replace(/\.[0-9]{8}\./g, '.').replace(/ integrity="[^"]*"/g, '').replace(/href="img\/icon\.png"/, 'href=img/icon.png');
  assert.equal(strip(out), page);
});
