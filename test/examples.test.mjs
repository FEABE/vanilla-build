// The example in examples/site is built with the real CLI (in a temporary copy) and its output is checked and run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { typeScriptAvailable } from '../lib/ts.mjs';
import { tempDir, runNode } from './helpers/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'vanilla-build.mjs');
const EXAMPLE = path.join(HERE, '..', 'examples', 'site');

test('examples/site: builds with the CLI and the output runs', { skip: !typeScriptAvailable() }, () => {
  const dir = tempDir('vb-example-');
  try {
    fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => path.basename(src) !== 'dist' });
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /warning/, r.stdout);
    assert.match(r.stdout, /built in \d+ ms -> dist\//);

    const dist = (p) => path.join(dir, 'dist', p);
    const m = JSON.parse(fs.readFileSync(dist('manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(m), ['css/app.css', 'img/logo.svg', 'js/main.ts']);
    assert.match(m['js/main.ts'], /^js\/main\.[0-9a-f]{8}\.js$/);

    // the page points at the hashed files, with the integrity of the exact bytes
    const html = fs.readFileSync(dist('index.html'), 'utf8');
    for (const key of ['css/app.css', 'js/main.ts']) {
      const sri = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(dist(m[key]))).digest('base64');
      assert.ok(html.includes('"' + m[key] + '" integrity="' + sri + '"'), key);
    }
    assert.ok(html.includes('src="' + m['img/logo.svg'] + '"'));

    // stylesheet: @import inlined and minified; custom property value kept byte for byte
    const css = fs.readFileSync(dist(m['css/app.css']), 'utf8');
    assert.ok(css.startsWith(':root{--accent: #2a6}body{'), css);
    assert.ok(!css.includes('@import'));

    // publicDir copied; TypeScript / JSON / CommonJS sources consumed by the bundle are not
    assert.ok(fs.existsSync(dist('robots.txt')));
    for (const f of ['js/main.ts', 'js/format.ts', 'js/items.json', 'js/legacy.cjs', 'css/base.css']) assert.ok(!fs.existsSync(dist(f)), f);

    // the bundle runs (outside a browser it prints its list)
    const runnable = path.join(dir, 'main.mjs');
    fs.copyFileSync(dist(m['js/main.ts']), runnable);
    const got = runNode(runnable);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, '[x] bundle ES modules\n[x] strip TypeScript types\n[ ] source maps\nhello from a CommonJS module in the build\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
