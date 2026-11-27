#!/usr/bin/env node
/**
 * scripts/obfuscate-suites.mjs — correctness sweep for the experimental obfuscator.
 *
 *   node scripts/obfuscate-suites.mjs [--seeds 20] [--jobs 4] [--kit <vanilla-kit dir>] [--arch <vanilla-arch dir>]
 *                                     [--only rename,all] [--json out.json]
 *
 * For every option alone and all options together, and for every seed:
 *   fixtures  every bundler fixture (test/fixtures/bundle-cases.mjs) is bundled as iife / esm / cjs, obfuscated,
 *             and run in a child Node process; stdout, exit code and uncaught error name must equal the native
 *             run of the unbundled sources. iife output also runs in a vm context with string code generation
 *             disabled (what a CSP without 'unsafe-eval' does): no eval / new Function anywhere.
 *   kit/arch  the whole test suite of another project runs with its source files replaced by obfuscated builds
 *             (scripts/obfuscate-hook.cjs). Pass counts must equal the unmodified baseline, and the hook must
 *             report that it really replaced the files (otherwise the run counts as a failure).
 * Tests that check the project's own minified files are excluded from baseline and sweep alike.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundle } from '../lib/bundle.mjs';
import { minify } from '../lib/minify.mjs';
import { obfuscate, OPTION_NAMES } from '../lib/obfuscate.mjs';
import { cases } from '../test/fixtures/bundle-cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'obfuscate-hook.cjs');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SEEDS = Number(arg('seeds', 20));
const JOBS = Number(arg('jobs', Math.max(2, Math.min(6, os.cpus().length - 1))));
const kitDir = arg('kit', null), archDir = arg('arch', null);
const jsonOut = arg('json', null);

const off = Object.fromEntries(OPTION_NAMES.map((k) => [k, false]));
let CONFIGS = Object.fromEntries(OPTION_NAMES.map((k) => [k, { ...off, [k]: true }]));
CONFIGS.all = Object.fromEntries(OPTION_NAMES.map((k) => [k, true]));
if (arg('only', null)) CONFIGS = Object.fromEntries(arg('only').split(',').map((k) => [k, CONFIGS[k]]));

function uncaughtName(stderr) { const m = /^(?:Uncaught )?([A-Z][A-Za-z]*(?:Error|Exception))\b/m.exec(stderr); return m ? m[1] : null; }
function runFile(file, cwd) {
  const r = spawnSync(process.execPath, ['--no-warnings', file], { cwd, encoding: 'utf8', timeout: 15000 });
  return { stdout: (r.stdout || '').replace(/\r\n/g, '\n'), status: r.status, error: r.status === 0 ? null : uncaughtName(r.stderr || ''), timedOut: !!r.error };
}
async function runCsp(code) {
  const lines = [];
  const fmt = (v) => typeof v === 'string' ? v : String(v);
  const ctx = vm.createContext({ console: { log: (...a) => lines.push(a.map(fmt).join(' ')) } }, { codeGeneration: { strings: false, wasm: false } });
  let error = null;
  try { vm.runInContext(code, ctx, { timeout: 5000 }); } catch (e) { error = e && e.constructor ? e.constructor.name : 'Error'; }
  await new Promise((r) => setTimeout(r, 20));
  return { lines, error };
}

// ---------------------------------------------------------------- fixtures
const FORMAT_EXT = { esm: '.mjs', iife: '.cjs', cjs: '.cjs' };
const SOURCE_TYPE = { esm: 'module', iife: 'script', cjs: 'commonjs' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-obf-'));
const fixtureRuns = [];
for (const [name, c] of Object.entries(cases)) {
  if (c.buildError) continue;
  const dir = path.join(tmp, name);
  for (const [f, text] of Object.entries(c.files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  const entry = ['main.mjs', 'main.cjs', 'main.mts'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  const native = runFile(entry, dir);
  for (const format of c.formats || ['esm', 'iife', 'cjs']) {
    const code = bundle({ entry, format, root: dir }).code;
    // The shipped build order is bundle -> minify -> obfuscate, so test obfuscation of the minified bundle too.
    fixtureRuns.push({ name, dir, format, native, obfSkip: c.obfSkip || [], code, codeMin: minify(code).code });
  }
}

// Does this config enable a pass this fixture is documented to be incompatible with?
function incompatible(config, obfSkip) { return obfSkip.some((p) => config[p]); }

async function fixtureSweep(config, seed) {
  const failures = [];
  let checks = 0, skipped = 0;
  for (const fr of fixtureRuns) {
    if (incompatible(config, fr.obfSkip)) { skipped += 2; continue; }
    // 'raw': obfuscate the bundle directly. 'min': minify first, as the build does.
    for (const [variant, input] of [['raw', fr.code], ['min', fr.codeMin]]) {
      // The minifier mangles local names, so it changes function/class .name just as `rename` does: a fixture that
      // reads .name (obfSkip rename) is incompatible with the minified variant too.
      if (variant === 'min' && fr.obfSkip.includes('rename')) { skipped++; continue; }
      let code;
      try { code = obfuscate(input, { ...config, seed, sourceType: SOURCE_TYPE[fr.format] }).code; }
      catch (e) { failures.push(fr.name + ' [' + fr.format + '/' + variant + '] obfuscate threw: ' + e.message); continue; }
      const file = path.join(fr.dir, 'obf-' + fr.format + '-' + variant + '-' + seed + FORMAT_EXT[fr.format]);
      fs.writeFileSync(file, code);
      const got = runFile(file, fr.dir);
      checks++;
      if (got.stdout !== fr.native.stdout || got.status !== fr.native.status || got.error !== fr.native.error) {
        failures.push(fr.name + ' [' + fr.format + '/' + variant + '] differs: ' + JSON.stringify({ want: fr.native.stdout.slice(0, 200), got: got.stdout.slice(0, 200), status: got.status, error: got.error }));
      }
      if (fr.format === 'iife') {
        const csp = await runCsp(code);
        checks++;
        if (csp.error === 'EvalError') failures.push(fr.name + ' [iife/' + variant + '] needs eval / new Function (EvalError under codeGeneration: strings false)');
      }
    }
  }
  return { checks, failures, skipped };
}

// ---------------------------------------------------------------- other projects' suites
function suiteSpec(kind, dir) {
  const testDir = path.join(dir, 'test');
  if (kind === 'kit') {
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js') && f !== 'minified.test.js').map((f) => path.join(testDir, f));
    const targets = [
      ...fs.readdirSync(path.join(dir, 'browser')).filter((f) => f.endsWith('.js')).map((f) => ({ file: path.join(dir, 'browser', f), sourceType: 'script' })),
      ...fs.readdirSync(path.join(dir, 'node')).filter((f) => f.endsWith('.js')).map((f) => ({ file: path.join(dir, 'node', f), sourceType: 'commonjs' })),
    ];
    return { kind, dir, files, targets, reads: [] };
  }
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js') && f !== 'min.test.js').map((f) => path.join(testDir, f));
  const subject = path.join(dir, 'vanilla-arch.js');
  return { kind, dir, files, targets: [{ file: subject, sourceType: 'script' }], reads: [subject] };
}
function runSuite(spec, options) {
  return new Promise((resolve) => {
    const countFile = path.join(tmp, 'count-' + spec.kind + '-' + Math.random().toString(36).slice(2));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    if (options) {
      env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(HOOK)).trim();
      env.VB_OBF_OPTIONS = JSON.stringify(options);
      env.VB_OBF_TARGETS = JSON.stringify(spec.targets);
      env.VB_OBF_READS = JSON.stringify(spec.reads);
      env.VB_OBF_COUNT = countFile;
    }
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...spec.files], { cwd: spec.dir, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', () => {
      clearTimeout(timer);
      const num = (k) => { const m = new RegExp('^# ' + k + ' (\\d+)', 'm').exec(out); return m ? Number(m[1]) : -1; };
      let replaced = 0;
      if (fs.existsSync(countFile)) { replaced = fs.readFileSync(countFile, 'utf8').trim().split('\n').reduce((s, l) => s + Number(l.split(' ')[1]), 0); fs.rmSync(countFile); }
      const notOk = out.split('\n').filter((l) => /^\s*not ok /.test(l)).slice(0, 5);
      resolve({ pass: num('pass'), fail: num('fail'), replaced, notOk });
    });
  });
}

async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

const suites = [];
if (kitDir) suites.push(suiteSpec('kit', path.resolve(kitDir)));
if (archDir) suites.push(suiteSpec('arch', path.resolve(archDir)));
const baseline = {};
for (const s of suites) {
  baseline[s.kind] = await runSuite(s, null);
  process.stdout.write('baseline ' + s.kind + ': pass ' + baseline[s.kind].pass + ', fail ' + baseline[s.kind].fail + '\n');
}

const report = { seeds: SEEDS, configs: {}, baseline };
const t0 = Date.now();
for (const [cname, config] of Object.entries(CONFIGS)) {
  const row = { fixtures: { runs: 0, ok: 0, checks: 0, skipped: 0, failures: [] } };
  for (const s of suites) row[s.kind] = { runs: 0, ok: 0, failures: [] };
  const tasks = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    tasks.push(async () => {
      const r = await fixtureSweep(config, seed);
      row.fixtures.runs++; row.fixtures.checks += r.checks; row.fixtures.skipped = r.skipped;
      if (!r.failures.length) row.fixtures.ok++; else row.fixtures.failures.push('seed ' + seed + ': ' + r.failures.slice(0, 3).join(' | '));
    });
    for (const s of suites) {
      tasks.push(async () => {
        const r = await runSuite(s, { ...config, seed });
        const b = baseline[s.kind];
        row[s.kind].runs++;
        const good = r.fail === 0 && r.pass === b.pass && r.replaced > 0;
        if (good) row[s.kind].ok++;
        else row[s.kind].failures.push('seed ' + seed + ': pass ' + r.pass + '/' + b.pass + ', fail ' + r.fail + ', replaced ' + r.replaced + (r.notOk.length ? ' :: ' + r.notOk.join(' | ') : ''));
      });
    }
  }
  await pool(tasks, JOBS);
  report.configs[cname] = row;
  const cells = ['fixtures', ...suites.map((s) => s.kind)].map((k) => k + ' ' + row[k].ok + '/' + row[k].runs);
  process.stdout.write(cname.padEnd(12) + cells.join('   ') + (row.fixtures.skipped ? '   (' + row.fixtures.skipped + ' fixture run(s)/seed skipped: documented limitation)' : '') + '\n');
  for (const k of ['fixtures', ...suites.map((s) => s.kind)]) for (const f of row[k].failures.slice(0, 3)) process.stdout.write('    ' + k + ' ' + f.slice(0, 400) + '\n');
}
report.ms = Date.now() - t0;
process.stdout.write('done in ' + Math.round(report.ms / 1000) + ' s (fixture checks per run: ' + (report.configs[Object.keys(CONFIGS)[0]].fixtures.checks / SEEDS) + ')\n');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
const anyFail = Object.values(report.configs).some((row) => Object.values(row).some((c) => c.ok !== c.runs));
process.exit(anyFail ? 1 : 0);
