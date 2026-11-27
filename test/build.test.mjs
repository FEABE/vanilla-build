import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, watch, checkOutDir } from '../lib/build.mjs';
import { tempDir, writeFiles } from './helpers/run.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vanilla-build.mjs');

const project = {
  'src/index.html': '<!doctype html>\n<link rel="stylesheet" href="css/app.css">\n<script src="js/legacy.js"></script>\n<script type="module" src="js/main.ts"></script>\n<img src="img/logo.svg">\n<a href="about/">about</a>\n',
  'src/about/index.html': '<!doctype html>\n<link rel="stylesheet" href="/css/app.css">\n<script type="module" src="../js/main.ts"></script>\n',
  'src/css/app.css': '@import "./base.css";\n.app {\n  background: url(../img/logo.svg);\n}\n',
  'src/css/base.css': 'body { margin: 0 }\n',
  'src/js/main.ts': 'import { greet } from "./greet.js";\nconst who: string = "world";\nglobalThis.__out = greet(who);\n',
  'src/js/greet.ts': 'export function greet(name: string): string { return "hello " + name; }\n',
  'src/js/legacy.js': 'var legacyValue = 40 + 2;\n',
  'src/img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  'src/robots.txt': 'User-agent: *\n',
  'public/favicon.ico': 'ico',
};

function setup() {
  const dir = tempDir('vb-build-');
  writeFiles(dir, project);
  return dir;
}

test('build: bundles, hashes, rewrites pages, writes a manifest, copies the rest', async () => {
  const dir = setup();
  try {
    const r = await build({ root: 'src', outDir: 'dist', integrity: true, publicDir: 'public' }, { cwd: dir });
    const m = r.manifest;
    assert.match(m['js/main.ts'], /^js\/main\.[0-9a-f]{8}\.js$/);
    assert.match(m['js/legacy.js'], /^js\/legacy\.[0-9a-f]{8}\.js$/);
    assert.match(m['css/app.css'], /^css\/app\.[0-9a-f]{8}\.css$/);
    assert.match(m['img/logo.svg'], /^img\/logo\.[0-9a-f]{8}\.svg$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'dist/manifest.json'), 'utf8')), m);
    const out = (p) => fs.readFileSync(path.join(dir, 'dist', p), 'utf8');
    // hashes are of the final bytes
    for (const f of Object.values(m)) {
      const bytes = fs.readFileSync(path.join(dir, 'dist', f));
      assert.equal(f.split('.').slice(-2, -1)[0], crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8), f);
    }
    const index = out('index.html');
    assert.ok(index.includes('href="' + m['css/app.css'] + '"'));
    assert.ok(index.includes('src="' + m['js/main.ts'] + '"'));
    assert.ok(index.includes('src="' + m['img/logo.svg'] + '"'));
    assert.ok(index.includes('<a href="about/">about</a>'), 'links that are not assets stay');
    const sri = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(path.join(dir, 'dist', m['js/main.ts']))).digest('base64');
    assert.ok(index.includes('integrity="' + sri + '"'), 'integrity of the exact file');
    const about = out('about/index.html');
    assert.ok(about.includes('href="/' + m['css/app.css'] + '"'), 'root-relative stays root-relative');
    assert.ok(about.includes('src="../' + m['js/main.ts'] + '"'), 'relative stays relative');
    // css: import inlined, minified, url untouched (same folder layout)
    assert.equal(out(m['css/app.css']), 'body{margin:0}.app{background:url(../img/logo.svg)}\n');
    // module bundle runs; classic script keeps its global
    const ctx = vm.createContext({});
    vm.runInContext(out(m['js/legacy.js']), ctx);
    assert.equal(ctx.legacyValue, undefined, 'classic scripts are wrapped in an iife: top-level var is not a global');
    const ctx2 = vm.createContext({});
    vm.runInContext(out(m['js/main.ts']).replace(/^export \{[^}]*\};?\s*$/m, ''), ctx2);
    assert.equal(ctx2.__out, 'hello world');
    // copies: originals kept for css url(), sources consumed by bundles not copied, public copied
    assert.ok(fs.existsSync(path.join(dir, 'dist/img/logo.svg')));
    assert.ok(fs.existsSync(path.join(dir, 'dist/robots.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'dist/favicon.ico')));
    assert.ok(!fs.existsSync(path.join(dir, 'dist/js/greet.ts')) && !fs.existsSync(path.join(dir, 'dist/css/base.css')));
    assert.ok(!fs.existsSync(path.join(dir, 'dist/js/legacy.js')), 'bundled sources are not copied');
    // deterministic
    const again = await build({ root: 'src', outDir: 'dist', integrity: true, publicDir: 'public' }, { cwd: dir });
    assert.deepEqual(again.manifest, m);
    // no absolute paths leak into outputs
    for (const f of Object.values(m)) assert.ok(!out(f).includes(dir) && !/[A-Za-z]:\\/.test(out(f)), f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: --no-hash keeps names; clean removes stale files', async () => {
  const dir = setup();
  try {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist/stale.txt'), 'x');
    const r = await build({ root: 'src', outDir: 'dist', hash: false }, { cwd: dir });
    assert.equal(r.manifest['js/main.ts'], 'js/main.js');
    assert.ok(!fs.existsSync(path.join(dir, 'dist/stale.txt')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: refuses dangerous output folders', async () => {
  const dir = setup();
  try {
    await assert.rejects(build({ root: 'src', outDir: 'src' }, { cwd: dir }), /source root/);
    await assert.rejects(build({ root: 'src', outDir: '.' }, { cwd: dir }), /source root|working directory/);
    await assert.rejects(build({ root: 'src/js', outDir: 'src' }, { cwd: dir }), /source root/);
    fs.mkdirSync(path.join(dir, 'other/.git'), { recursive: true });
    await assert.rejects(build({ root: 'src', outDir: 'other' }, { cwd: dir }), /\.git/);
    assert.throws(() => checkOutDir(path.parse(dir).root, path.join(dir, 'src'), dir), /filesystem root/);
    assert.ok(fs.existsSync(path.join(dir, 'src/index.html')), 'nothing was deleted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: watch rebuilds after a change (debounced) and ignores the output folder', async () => {
  const dir = setup();
  let w;
  try {
    const builds = [];
    let resolveNext;
    const next = () => new Promise((r) => { resolveNext = r; });
    let waiting = next();
    w = watch({ root: 'src', outDir: 'src-dist' }, {
      cwd: dir, debounce: 50,
      onBuild: (r) => { builds.push(r); resolveNext(r); },
      onError: (e) => { builds.push(e); resolveNext(e); },
    });
    await waiting;
    waiting = next();
    fs.writeFileSync(path.join(dir, 'src/js/greet.ts'), 'export function greet(name: string): string { return "hi " + name; }\n');
    fs.writeFileSync(path.join(dir, 'src/js/greet.ts'), 'export function greet(name: string): string { return "hey " + name; }\n');
    const r2 = await Promise.race([waiting, new Promise((_, rej) => setTimeout(() => rej(new Error('no rebuild')), 5000))]);
    assert.ok(!(r2 instanceof Error), String(r2));
    const code = fs.readFileSync(path.join(dir, 'src-dist', r2.manifest['js/main.ts']), 'utf8');
    assert.match(code, /hey /);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(builds.length, 2, 'writing the output did not trigger more builds');
  } finally {
    if (w) w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: build with a config file, bundle, minify, css', () => {
  const dir = setup();
  try {
    fs.writeFileSync(path.join(dir, 'vanilla-build.config.mjs'), 'export default { root: "src", outDir: "site", hash: false };\n');
    let r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /built in \d+ ms -> site\//);
    assert.ok(fs.existsSync(path.join(dir, 'site/js/main.js')));
    r = spawnSync(process.execPath, [CLI, 'bundle', 'src/js/main.ts', '--format', 'iife', '--minify'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ctx = vm.createContext({});
    vm.runInContext(r.stdout, ctx);
    assert.equal(ctx.__out, 'hello world');
    r = spawnSync(process.execPath, [CLI, 'minify', 'src/js/legacy.js'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.stdout, 'var legacyValue=40+2;\n');
    r = spawnSync(process.execPath, [CLI, 'css', 'src/css/app.css'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.stdout, 'body{margin:0}.app{background:url(../img/logo.svg)}\n');
    r = spawnSync(process.execPath, [CLI, 'nope'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    r = spawnSync(process.execPath, [CLI, '--help'], { cwd: dir, encoding: 'utf8' });
    assert.match(r.stdout, /Usage/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
