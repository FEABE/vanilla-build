#!/usr/bin/env node
/**
 * scripts/check-corpus.mjs — runs vanilla-build's JavaScript layers over every .js / .mjs / .cjs file under the
 * given folders and checks each result against independent oracles.
 *
 *   node scripts/check-corpus.mjs <dir>... [--exclude <dir name>]... [--json report.json] [--verbose]
 *                                [--only minify|parse|obfuscate]...
 *
 *   Every file is first classified with V8 (classic script, CommonJS function body, or ES module). Files V8 rejects
 *   are reported separately and not counted. For the others:
 *
 *   minify     (lib/minify.cjs, vendored from vanilla-kit — same oracles as upstream)
 *     1. whitespace-only and mangled output must compile in the same mode, and so must minify(minify(x));
 *     2. whitespace-only output must have the identical token sequence and statement starts (inspect());
 *     3. mangled output must resolve every identifier to the same declaration (and keep every global name).
 *   parse      (lib/parse/parser.mjs + lib/parse/scope.mjs)
 *     1. the parser must accept every file V8 accepts;
 *     2. every binding the scope analysis finds below the top level is renamed to a fresh, long name; the result
 *        must compile in the same mode and resolve every identifier occurrence to the same declaration according to
 *        the minifier's independent analysis (inspect().occurrences). This checks the scope analysis that the
 *        bundler and the obfuscator stand on.
 *   obfuscate  (lib/obfuscate.mjs, experimental) — every option together must produce output that compiles in the
 *     same mode.
 *
 *   Folders named node_modules and .git are always skipped; --exclude skips more folder names before reading them.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (typeof vm.SourceTextModule !== 'function' && !process.env.CHECK_CORPUS_CHILD) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, CHECK_CORPUS_CHILD: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const require = createRequire(import.meta.url);
const M = require('../lib/minify.cjs');

const args = process.argv.slice(2);
const roots = [];
const skip = new Set(['node_modules', '.git']);
const only = new Set();
let jsonOut = null, verbose = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exclude') skip.add(args[++i]);
  else if (args[i] === '--json') jsonOut = args[++i];
  else if (args[i] === '--verbose') verbose = true;
  else if (args[i] === '--only') only.add(args[++i]);
  else roots.push(args[i]);
}
if (!roots.length) {
  process.stderr.write('usage: check-corpus <dir>... [--exclude name]... [--json out] [--verbose] [--only minify|parse|obfuscate]\n');
  process.exit(2);
}
const want = (k) => !only.size || only.has(k);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.isFile() && /\.(m|c)?js$/.test(e.name)) out.push(path.join(dir, e.name));
  }
}

function nearestType(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    const p = path.join(d, 'package.json');
    if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')).type || 'commonjs'; } catch { return 'commonjs'; } }
    if (path.dirname(d) === d) return 'commonjs';
  }
}
export function compiles(code, mode) {
  try {
    if (mode === 'script') new vm.Script(code);
    else if (mode === 'cjs') vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname']);
    else new vm.SourceTextModule(code);
    return null;
  } catch (e) { return e.message; }
}
function classify(file, src) {
  const ext = path.extname(file);
  const order = ext === '.mjs' ? ['module'] : ext === '.cjs' ? ['cjs'] :
    nearestType(file) === 'module' ? ['module', 'script'] : ['script', 'cjs', 'module'];
  for (const m of order) if (!compiles(src, m)) return m;
  return null;
}

function sameTokens(a, b) {
  if (a.length !== b.length) return 'token count ' + a.length + ' -> ' + b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].text !== b[i].text) return 'token ' + i + ' ' + JSON.stringify(a[i]) + ' -> ' + JSON.stringify(b[i]);
  }
  return null;
}
function sameList(a, b, what) {
  if (a.length !== b.length) return what + ' count ' + a.length + ' -> ' + b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return what + ' ' + i + ': ' + a[i] + ' -> ' + b[i];
  return null;
}
function sameOccurrences(a, b) {
  if (a.length !== b.length) return 'occurrence count ' + a.length + ' -> ' + b.length;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.binding !== y.binding) return 'occurrence ' + i + ' (' + x.name + ' -> ' + y.name + ') binding ' + x.binding + ' -> ' + y.binding;
    if ((x.binding === null || x.kept) && x.name !== y.name) return 'kept name changed ' + x.name + ' -> ' + y.name;
  }
  return null;
}

function checkMinify(src, mode, report, problems) {
  let ws, mg, err;
  try {
    ws = M.minify(src, { mangle: false });
    mg = M.minify(src);
  } catch (e) { report.minify.refused.push({ mode, error: e.message }); return false; }
  if ((err = compiles(ws.code, mode))) problems.push('minify: whitespace output does not compile: ' + err);
  if ((err = compiles(mg.code, mode))) problems.push('minify: mangled output does not compile: ' + err);
  try {
    const again = M.minify(mg.code);
    if ((err = compiles(again.code, mode))) problems.push('minify: minify(minify(x)) does not compile: ' + err);
    if (M.minify(ws.code, { mangle: false }).code !== ws.code) problems.push('minify: whitespace pass is not idempotent');
  } catch (e) { problems.push('minify: cannot re-read output: ' + e.message); }
  try {
    const a = M.inspect(src), w = M.inspect(ws.code), g = M.inspect(mg.code);
    if ((err = sameTokens(a.tokens, w.tokens))) problems.push('minify: whitespace tokens differ: ' + err);
    if ((err = sameList(a.statements, w.statements, 'statement start'))) problems.push('minify: whitespace statements differ: ' + err);
    if (a.statements.length !== g.statements.length) problems.push('minify: mangled statement count ' + a.statements.length + ' -> ' + g.statements.length);
    if ((err = sameOccurrences(a.occurrences, g.occurrences))) problems.push('minify: mangled resolution differs: ' + err);
  } catch (e) { problems.push('minify: inspect failed: ' + e.message); }
  report.minify.raw += Buffer.byteLength(src);
  report.minify.ws += Buffer.byteLength(ws.code);
  report.minify.mangled += Buffer.byteLength(mg.code);
  return true;
}

let P = null, S = null, O = null;
async function checkParse(src, mode, report, problems) {
  P ??= await import('../lib/parse/parser.mjs');
  S ??= await import('../lib/parse/scope.mjs');
  let ast;
  try { ast = P.parse(src, { sourceType: mode === 'module' ? 'module' : 'script', allowReturnOutsideFunction: mode === 'cjs' }); }
  catch (e) { report.parse.refused.push({ mode, error: e.message }); return; }
  report.parse.accepted++;
  let renamed;
  try { renamed = S.renameAllLocals(src, ast, (b, i) => '$' + i + '_' + b.name.replace(/[^\w$]/g, '_')); }
  catch (e) { problems.push('parse: rename threw: ' + e.message); return; }
  if (renamed.skipped) { report.parse.skipped.push(renamed.skipped); return; }
  let err;
  if ((err = compiles(renamed.code, mode))) { problems.push('parse: renamed output does not compile: ' + err); return; }
  try {
    const a = M.inspect(src), b = M.inspect(renamed.code);
    report.parse.compared++;
    // Same oracle as the minifier: every occurrence must keep its declaration; globals keep their names.
    if ((err = sameOccurrences(a.occurrences.map((o) => ({ ...o, kept: o.kept && false })), b.occurrences))) problems.push('parse: renamed resolution differs: ' + err);
    if (a.statements.length !== b.statements.length) problems.push('parse: statement count ' + a.statements.length + ' -> ' + b.statements.length);
  } catch (e) {
    // The minifier refuses some inputs; then only the compile check applies.
    if (!/line \d+/.test(e.message)) problems.push('parse: inspect failed: ' + e.message);
  }
  report.parse.renamedBindings += renamed.count;
}

async function checkObfuscate(src, mode, report, problems) {
  O ??= await import('../lib/obfuscate.mjs');
  let out;
  try {
    out = O.obfuscate(src, { sourceType: mode === 'module' ? 'module' : 'script', allowReturnOutsideFunction: mode === 'cjs', seed: 1, rename: true, strings: true, stringArray: true, deadCode: true, controlFlow: true });
  } catch (e) { report.obfuscate.refused.push({ mode, error: e.message }); return; }
  const err = compiles(out.code, mode);
  if (err) problems.push('obfuscate: output does not compile: ' + err);
  else report.obfuscate.ok++;
}

const files = [];
for (const r of roots) walk(path.resolve(r), files);
const report = {
  files: files.length, invalidOriginal: 0, modes: {}, failures: [],
  minify: { refused: [], raw: 0, ws: 0, mangled: 0 },
  parse: { accepted: 0, compared: 0, refused: [], skipped: [], renamedBindings: 0 },
  obfuscate: { ok: 0, refused: [] },
};
let index = 0;
for (const file of files) {
  index++;
  const src = fs.readFileSync(file, 'utf8');
  const mode = classify(file, src);
  if (!mode) { report.invalidOriginal++; continue; }
  report.modes[mode] = (report.modes[mode] || 0) + 1;
  const problems = [];
  if (want('minify')) checkMinify(src, mode, report, problems);
  if (want('parse')) await checkParse(src, mode, report, problems);
  if (want('obfuscate')) await checkObfuscate(src, mode, report, problems);
  // Reports name files by their index only, so a run over private folders can be shared.
  if (problems.length) report.failures.push({ file: verbose ? file : '#' + index, mode, problems });
  if (verbose) process.stdout.write((problems.length ? 'FAIL ' : 'ok   ') + file + '\n');
}

const checked = files.length - report.invalidOriginal;
const pct = (x) => (100 * x / report.minify.raw).toFixed(1) + '%';
const lines = [
  'files found:          ' + files.length,
  'V8 rejects original:  ' + report.invalidOriginal + ' (not counted)',
  'checked:              ' + checked + ' ' + JSON.stringify(report.modes),
  'oracle failures:      ' + report.failures.length,
];
if (want('minify')) lines.push(
  'minify refused:       ' + report.minify.refused.length,
  'minify bytes:         raw ' + report.minify.raw + ', whitespace ' + pct(report.minify.ws) + ', mangled ' + pct(report.minify.mangled));
if (want('parse')) lines.push(
  'parser accepted:      ' + report.parse.accepted + ' / ' + checked + ' (refused ' + report.parse.refused.length + ')',
  'scope rename skipped: ' + report.parse.skipped.length + ' (eval / with)',
  'bindings renamed:     ' + report.parse.renamedBindings + ' (occurrence oracle compared on ' + report.parse.compared + ' files)');
if (want('obfuscate')) lines.push('obfuscate compiled:   ' + report.obfuscate.ok + ' (refused ' + report.obfuscate.refused.length + ')');
process.stdout.write(lines.join('\n') + '\n');
for (const r of report.parse.refused) process.stdout.write('PARSE REFUSED [' + r.mode + ']: ' + r.error + '\n');
for (const r of report.minify.refused) process.stdout.write('MINIFY REFUSED [' + r.mode + ']: ' + r.error + '\n');
for (const r of report.obfuscate.refused) process.stdout.write('OBFUSCATE REFUSED [' + r.mode + ']: ' + r.error + '\n');
for (const f of report.failures) process.stdout.write('FAIL ' + f.file + ' [' + f.mode + ']:\n  ' + f.problems.join('\n  ') + '\n');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(report.failures.length || report.parse.refused.length ? 1 : 0);
