// Build-pipeline integration for the experimental obfuscator: it must only run behind the flag, it runs after
// minify, and the obfuscated site must behave exactly like the plain one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../lib/build.mjs';
import { typeScriptAvailable } from '../lib/ts.mjs';
import { tempDir, runNode } from './helpers/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, '..', 'examples', 'site');

async function buildExample(experimentalObfuscate) {
  const root = tempDir('vb-obf-build-src-');
  const out = tempDir('vb-obf-build-out-');
  fs.cpSync(EXAMPLE, root, { recursive: true, filter: (src) => path.basename(src) !== 'dist' });
  const r = await build({ root, outDir: path.join(out, 'dist'), experimentalObfuscate }, { cwd: out });
  const jsSrc = Object.entries(r.manifest).find(([k]) => /\.ts$|\.js$/.test(k))[1];
  const jsPath = path.join(out, 'dist', jsSrc);
  const js = fs.readFileSync(jsPath, 'utf8');
  // run it: outside a browser the bundle prints its list
  const runnable = path.join(out, 'run.mjs');
  fs.copyFileSync(jsPath, runnable);
  const run = runNode(runnable);
  return { root, out, js, run, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); } };
}

const EXPECTED = '[x] bundle ES modules\n[x] strip TypeScript types\n[ ] source maps\nhello from a CommonJS module in the build\n';

test('build: default build has no obfuscation artifacts (0.1.x behaviour)', { skip: !typeScriptAvailable() }, async () => {
  const a = await buildExample(false);
  try {
    assert.equal(a.run.status, 0, a.run.stderr);
    assert.equal(a.run.stdout, EXPECTED);
    assert.doesNotMatch(a.js, /decodeURIComponent/, 'default build inserted a decoder');
    assert.doesNotMatch(a.js, /_0x[0-9a-f]+/, 'default build renamed to obfuscator names');
  } finally { a.cleanup(); }
});

test('build: --experimental-obfuscate runs after minify and preserves behaviour', { skip: !typeScriptAvailable() }, async () => {
  const plain = await buildExample(false);
  const obf = await buildExample(true);
  try {
    assert.equal(obf.run.status, 0, obf.run.stderr);
    assert.equal(obf.run.stdout, EXPECTED, 'obfuscated site behaves differently');
    assert.equal(obf.run.stdout, plain.run.stdout);
    assert.notEqual(obf.js, plain.js, 'the flag changed nothing');
    assert.match(obf.js, /decodeURIComponent/, 'string table decoder missing');
    // "after minify": the plain build is already minified (no newlines between statements); the obfuscated
    // output is built on top of that, so it is at least as large.
    assert.ok(obf.js.length > plain.js.length, 'obfuscated output is not larger than the minified bundle');
  } finally { plain.cleanup(); obf.cleanup(); }
});

test('build: obfuscated output option object is accepted (controlFlow + deadCode)', { skip: !typeScriptAvailable() }, async () => {
  const root = tempDir('vb-obf-build-src-');
  const out = tempDir('vb-obf-build-out-');
  try {
    fs.cpSync(EXAMPLE, root, { recursive: true, filter: (src) => path.basename(src) !== 'dist' });
    const r = await build({ root, outDir: path.join(out, 'dist'), experimentalObfuscate: { deadCode: true, controlFlow: true, deadCodeRate: 1 } }, { cwd: out });
    const jsSrc = Object.entries(r.manifest).find(([k]) => /\.ts$|\.js$/.test(k))[1];
    const runnable = path.join(out, 'run.mjs');
    fs.copyFileSync(path.join(out, 'dist', jsSrc), runnable);
    const run = runNode(runnable);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, EXPECTED);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});
