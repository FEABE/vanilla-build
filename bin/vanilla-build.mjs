#!/usr/bin/env node
/**
 * bin/vanilla-build.mjs — command line for vanilla-build. Zero dependencies. MIT License.
 * Run with --help for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, watch, loadConfig } from '../lib/build.mjs';
import { bundle } from '../lib/bundle.mjs';
import { minify } from '../lib/minify.mjs';
import { inlineImports, minifyCss } from '../lib/css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

const HELP = `vanilla-build ${VERSION} — zero-dependency bundler, minifier and asset pipeline

Usage
  vanilla-build [build] [options]            build the site described by vanilla-build.config.mjs
  vanilla-build bundle <entry> [options]     bundle one entry (ESM / CommonJS / JSON / TypeScript)
  vanilla-build minify <file.js> [options]   minify one JavaScript file
  vanilla-build css <file.css> [options]     inline @import and minify one stylesheet

build options
  --config <file>            config file (default: ./vanilla-build.config.mjs if it exists)
  --root <dir>               source folder (default: .)
  --out <dir>                output folder (default: dist), emptied first unless --no-clean
  --no-minify  --no-hash  --no-clean  --integrity
  --public <dir>             copied as is over the output
  --watch                    rebuild when a file under root changes
  --experimental-obfuscate   apply the experimental obfuscator (see README before using it)

bundle options
  -o, --out <file>           write here (default: stdout)
  --format <esm|iife|cjs>    output format (default: esm)
  --name <Global>            iife: assign the entry's exports to this global
  --external <a,b>           leave these specifiers as imports / requires
  --minify                   minify the bundle
  --experimental-obfuscate   obfuscate the bundle (experimental)

minify options
  -o, --out <file>   --no-mangle   --keep-fnames   --no-license

  -h, --help   -v, --version
`;

function fail(msg) { process.stderr.write('vanilla-build: ' + msg + '\n'); process.exit(1); }

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takes = ['--config', '--root', '--out', '-o', '--format', '--name', '--external', '--public'];
    if (takes.includes(a)) {
      if (i + 1 >= argv.length) fail(a + ' needs a value');
      out.flags[a === '-o' ? 'out' : a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) out.flags[a.slice(2)] = true;
    else if (a === '-h') out.flags.help = true;
    else if (a === '-v') out.flags.version = true;
    else out._.push(a);
  }
  return out;
}

function kb(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

function report(r) {
  const rows = r.outputs.filter((o) => o.kind !== 'copy' && o.kind !== 'public');
  const copies = r.outputs.length - rows.length;
  for (const o of rows) process.stdout.write('  ' + o.kind.padEnd(6) + ' ' + o.source.padEnd(32) + ' -> ' + o.file + '  ' + kb(o.bytes) + '\n');
  if (copies) process.stdout.write('  copied ' + copies + ' other file(s)\n');
  for (const w of r.warnings) process.stdout.write('  warning: ' + w + '\n');
  process.stdout.write('built in ' + r.ms + ' ms -> ' + path.relative(process.cwd(), r.outDir).split(path.sep).join('/') + '/\n');
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) { process.stdout.write(VERSION + '\n'); return; }
  if (flags.help) { process.stdout.write(HELP); return; }
  const cmd = _[0] || 'build';

  if (cmd === 'build') {
    let cfg = {};
    const cfgFile = flags.config || (fs.existsSync('vanilla-build.config.mjs') ? 'vanilla-build.config.mjs' : null);
    if (cfgFile) cfg = await loadConfig(cfgFile);
    if (flags.root) cfg.root = flags.root;
    if (flags.out) cfg.outDir = flags.out;
    if (flags.public) cfg.publicDir = flags.public;
    if (flags['no-minify']) cfg.minify = false;
    if (flags['no-hash']) cfg.hash = false;
    if (flags['no-clean']) cfg.clean = false;
    if (flags.integrity) cfg.integrity = true;
    if (flags['experimental-obfuscate']) { cfg.obfuscate = cfg.obfuscate || true; cfg.experimentalObfuscate = true; }
    if (flags.watch) {
      watch(cfg, {
        onBuild: (r) => { report(r); process.stdout.write('watching for changes (Ctrl+C to stop)\n'); },
        onError: (e) => process.stderr.write('build failed: ' + e.message + '\n'),
      });
      return;
    }
    report(await build(cfg));
    return;
  }

  if (cmd === 'bundle') {
    if (!_[1]) fail('bundle needs an entry file');
    const r = bundle({
      entry: _[1], format: flags.format || 'esm', name: typeof flags.name === 'string' ? flags.name : undefined,
      external: typeof flags.external === 'string' ? flags.external.split(',').filter(Boolean) : [],
    });
    let code = r.code;
    if (flags['experimental-obfuscate']) {
      const { obfuscate } = await import('../lib/obfuscate.mjs');
      code = obfuscate(code, { sourceType: (flags.format || 'esm') === 'esm' ? 'module' : 'script' }).code;
    }
    if (flags.minify) code = minify(code).code + '\n';
    for (const w of r.warnings) process.stderr.write('warning: ' + w + '\n');
    if (typeof flags.out === 'string') fs.writeFileSync(flags.out, code); else process.stdout.write(code);
    return;
  }

  if (cmd === 'minify') {
    if (!_[1]) fail('minify needs a file');
    let src = fs.readFileSync(_[1], 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const r = minify(src, { mangle: !flags['no-mangle'], keepFnames: !!flags['keep-fnames'], keepLicense: !flags['no-license'] });
    if (typeof flags.out === 'string') fs.writeFileSync(flags.out, r.code + '\n'); else process.stdout.write(r.code + '\n');
    return;
  }

  if (cmd === 'css') {
    if (!_[1]) fail('css needs a file');
    const r = inlineImports(_[1], { root: flags.root || path.dirname(_[1]) });
    for (const w of r.warnings) process.stderr.write('warning: ' + w + '\n');
    const css = minifyCss(r.css) + '\n';
    if (typeof flags.out === 'string') fs.writeFileSync(flags.out, css); else process.stdout.write(css);
    return;
  }

  fail('unknown command "' + cmd + '" (try --help)');
}

main().catch((e) => fail(e.message));
