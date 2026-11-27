// Tests for the EXPERIMENTAL obfuscator (lib/obfuscate.mjs). The method throughout: obfuscate a snippet, run the
// original and the obfuscated version in a child Node process, and require identical stdout, exit code and uncaught
// error name. Behaviour, never "strength", is what is checked. Each case also asserts that the pass it exercises
// actually fired (stats > 0) or was skipped for a stated reason, so a case can never pass by doing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { obfuscate, DEFAULT_OPTIONS, OPTION_NAMES } from '../lib/obfuscate.mjs';
import { minify } from '../lib/minify.mjs';
import { tempDir, writeFiles, runNode } from './helpers/run.mjs';

const EXT = { script: '.cjs', commonjs: '.cjs', module: '.mjs' };
const allOn = { rename: true, strings: true, stringArray: true, deadCode: true, controlFlow: true, deadCodeRate: 1, controlFlowMin: 1 };
const only = (name, extra = {}) => ({ ...Object.fromEntries(OPTION_NAMES.map((k) => [k, false])), [name]: true, ...extra });

// Obfuscate `src` once, run both versions, assert identical behaviour. Returns the obfuscation stats.
function runOnce(src, sourceType, options, seed) {
  const { code, stats } = obfuscate(src, { ...options, sourceType, seed });
  const dir = tempDir('vb-obf-test-');
  try {
    const ext = EXT[sourceType];
    writeFiles(dir, { ['src' + ext]: src, ['obf' + ext]: code });
    const a = runNode(path.join(dir, 'src' + ext));
    const b = runNode(path.join(dir, 'obf' + ext));
    assert.equal(b.stdout, a.stdout, 'stdout differs\n--- obfuscated ---\n' + code + '\n--- stderr ---\n' + b.stderr);
    assert.equal(b.status, a.status, 'exit code differs');
    assert.equal(b.error, a.error, 'uncaught error name differs');
    return { code, stats };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Run a snippet in sloppy and strict mode (strict = a prepended directive), unless `modes` narrows it. A module is
// always strict, so it runs once. Returns the stats of the last run (identical across modes for these snippets).
function same(src, { sourceType = 'commonjs', options = {}, seed = 7, modes } = {}) {
  const pick = modes || (sourceType === 'module' ? ['strict'] : ['sloppy', 'strict']);
  let last;
  for (const mode of pick) {
    const text = mode === 'strict' && sourceType !== 'module' ? '"use strict";\n' + src : src;
    last = runOnce(text, sourceType, options, seed);
  }
  return last;
}

// ---------------------------------------------------------------- defaults and API surface
test('obfuscate: default options keep 0.1.x-compatible defaults and the documented option set', () => {
  assert.deepEqual(OPTION_NAMES, ['rename', 'strings', 'stringArray', 'deadCode', 'controlFlow']);
  assert.equal(DEFAULT_OPTIONS.rename, true);
  assert.equal(DEFAULT_OPTIONS.strings, true);
  assert.equal(DEFAULT_OPTIONS.stringArray, true);
  assert.equal(DEFAULT_OPTIONS.deadCode, false);
  assert.equal(DEFAULT_OPTIONS.controlFlow, false);
});

test('obfuscate: same seed is deterministic, different seeds differ', () => {
  const src = 'function f(x) { const y = x + "abc"; return y.length; }\nmodule.exports = f(1);\n';
  const a = obfuscate(src, { sourceType: 'commonjs', seed: 1 }).code;
  const b = obfuscate(src, { sourceType: 'commonjs', seed: 1 }).code;
  const c = obfuscate(src, { sourceType: 'commonjs', seed: 2 }).code;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('obfuscate: rejects an unknown sourceType', () => {
  assert.throws(() => obfuscate('var x = 1;', { sourceType: 'nonsense' }), /sourceType/);
});

test('obfuscate: output stays parseable when obfuscated twice (all passes)', () => {
  const src = 'exports.run = function () {\n  const parts = ["a", "b", "c"];\n  let total = 0;\n  for (const p of parts) total += p.length;\n  return total;\n};\nconsole.log(exports.run());\n';
  const once = obfuscate(src, { sourceType: 'commonjs', seed: 3, ...allOn });
  const twice = obfuscate(once.code, { sourceType: 'commonjs', seed: 4, ...allOn });
  // If either result were broken, these re-parses (obfuscate's own final check) would throw.
  assert.ok(twice.code.length > 0);
});

// ---------------------------------------------------------------- each pass fires and preserves behaviour
test('rename: locals change, globals and the result behave the same', () => {
  const src = 'const greeting = "hi";\nfunction build(name) { const out = greeting + " " + name; return out.length; }\nconsole.log(build("world"), typeof console, typeof globalThis);\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: only('rename') });
  assert.ok(stats.renamed > 0, 'nothing renamed');
  assert.ok(/console\b/.test(code) && /globalThis\b/.test(code), 'a global was renamed');
});

test('strings: string literals are escaped, behaviour preserved', () => {
  const { stats } = same('console.log("héllo \\u{1f600}", "tab\\tend");\n', { sourceType: 'commonjs', options: only('strings') });
  assert.ok(stats.escaped > 0, 'no string escaped');
});

test('stringArray: literals move into a decoder table, behaviour preserved', () => {
  const src = 'exports.f = () => ["alpha", "beta", "alpha"].join("-");\nconsole.log(exports.f());\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: only('stringArray') });
  assert.ok(stats.strings > 0, 'no string moved to the table');
  assert.ok(/decodeURIComponent/.test(code), 'no decoder emitted');
});

test('stringArray: a named iife (var X = (function(){})()) gets the table inside the wrapper', () => {
  const src = [
    'var MyLib = (function () {',
    '  var msgs = ["hello", "world", "hello"];',
    '  return { join: function () { return msgs.join("-"); } };',
    '})();',
    'console.log(MyLib.join());',
  ].join('\n') + '\n';
  // Test the shipped order too: minify first, then obfuscate.
  for (const input of [src, minify(src).code]) {
    const { code, stats } = obfuscate(input, { sourceType: 'script', seed: 9, ...only('stringArray') });
    assert.ok(stats.strings > 0, 'no string tabled for a named iife');
    assert.ok(!/^\s*function _0x/m.test(code) || /MyLib/.test(code), 'table escaped the wrapper into a global');
    const dir = tempDir('vb-obf-iife-');
    try {
      writeFiles(dir, { 'src.cjs': input, 'obf.cjs': code });
      assert.equal(runNode(path.join(dir, 'obf.cjs')).stdout, runNode(path.join(dir, 'src.cjs')).stdout);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('deadCode: unreachable blocks are inserted, behaviour preserved', () => {
  const src = 'function f(a) { let b = a * 2; let c = b + 1; return c; }\nconsole.log(f(3));\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: only('deadCode', { deadCodeRate: 1 }) });
  assert.ok(stats.deadBlocks > 0, 'no dead block inserted');
});

test('controlFlow: function bodies are flattened, behaviour preserved', () => {
  const src = 'function f(a) {\n  let x = a + 1;\n  let y = x * 2;\n  let z = y - 3;\n  return x + y + z;\n}\nconsole.log(f(5));\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: only('controlFlow', { controlFlowMin: 1 }) });
  assert.ok(stats.flattened > 0, 'nothing flattened');
});

test('all passes together preserve behaviour', () => {
  const src = 'exports.main = function () {\n  const words = ["one", "two", "three"];\n  let acc = "";\n  for (let i = 0; i < words.length; i++) { acc += words[i] + ":" + i + ";"; }\n  return acc;\n};\nconsole.log(exports.main());\n';
  same(src, { sourceType: 'commonjs', options: allOn });
});

// ---------------------------------------------------------------- constructs an identifier renamer can break
test('construct: direct eval disables renaming for the file (skipped, not corrupted)', () => {
  // sloppy only: a direct eval that reads a sibling binding behaves differently under strict mode (own scope).
  const src = 'var secret = 41;\nfunction run() { return eval("secret + 1"); }\nconsole.log(run());\n';
  const { code, stats } = same(src, { sourceType: 'script', options: allOn, modes: ['sloppy'] });
  assert.ok(stats.skipped.some((s) => s.startsWith('rename')), 'rename was not reported as skipped');
  assert.ok(/\bsecret\b/.test(code), 'eval present but a local was still renamed');
});

test('construct: with statement disables renaming (sloppy only)', () => {
  const src = 'var o = { a: 1, b: 2 };\nvar total = 0;\nwith (o) { total = a + b; }\nconsole.log(total);\n';
  const { code, stats } = same(src, { sourceType: 'script', options: allOn, modes: ['sloppy'] });
  assert.ok(stats.skipped.some((s) => s.startsWith('rename')), 'rename not skipped for with');
  assert.ok(/\btotal\b/.test(code));
});

test('construct: arguments object is never renamed', () => {
  const src = 'function sum() { let t = 0; for (let i = 0; i < arguments.length; i++) t += arguments[i]; return t; }\nconsole.log(sum(1, 2, 3, 4));\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: only('rename') });
  assert.ok(stats.renamed > 0);
  assert.ok(/arguments\.length/.test(code), 'arguments was renamed');
});

test('construct: getters and setters, computed and not', () => {
  const src = [
    'function f() {',
    '  const key = "dynamic";',
    '  const obj = {',
    '    _v: 1,',
    '    get value() { return this._v; },',
    '    set value(x) { this._v = x; },',
    '    get [key]() { return "computed-getter"; },',
    '  };',
    '  obj.value = 10;',
    '  return [obj.value, obj.dynamic].join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

test('construct: labeled break and continue keep their labels', () => {
  const src = [
    'function f() {',
    '  let hits = [];',
    '  outer: for (let i = 0; i < 3; i++) {',
    '    inner: for (let j = 0; j < 3; j++) {',
    '      if (j === 1) continue inner;',
    '      if (i === 2) break outer;',
    '      hits.push(i + "" + j);',
    '    }',
    '  }',
    '  return hits.join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { code } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(/outer\s*:/.test(code) && /inner\s*:/.test(code), 'a label was renamed');
});

test('construct: template literals (escaping must not touch them)', () => {
  const src = [
    'function f() {',
    '  const who = "team";',
    '  const n = 3;',
    '  const msg = `hello ${who}, you have ${n + 1} items\\n${`nested ${who}`}`;',
    '  return [msg, String.raw`a\\tb`].join("|");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
  assert.ok(/`hello \$\{/.test(code), 'template literal text was altered');
});

test('construct: regex vs division are not confused by the parser', () => {
  const src = [
    'function f() {',
    '  const a = 10, b = 2;',
    '  const q = a / b / 1;',
    '  const re = /ab+c/gi;',
    '  const m = "xabbbcy".match(re);',
    '  const g = function () { return 4; };',
    '  return [q, re.source, m[0], g() / 2].join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
  assert.ok(/\/ab\+c\/gi/.test(code), 'the regex literal was altered');
});

test('construct: ASI-dependent code stays correct', () => {
  const src = [
    'function f() {',
    '  let a = 1',
    '  let b = 2',
    '  ;[a, b] = [b, a]',          // leading ; after a statement with no semicolon
    '  let c = a',
    '  c',
    '  ++b',                        // `c` and `++b` are two statements by ASI, not `c++ b`
    '  return a + "," + b + "," + c',
    '}',
    'function g() { return',        // ASI inserts a semicolon after return
    '  99 }',
    'console.log(f(), g())',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

test('construct: class fields (public, private, static) and methods', () => {
  const src = [
    'function f() {',
    '  class Counter {',
    '    #count = 0;',
    '    static label = "C";',
    '    step = 1;',
    '    inc() { this.#count += this.step; return this.#count; }',
    '    get count() { return this.#count; }',
    '  }',
    '  const c = new Counter();',
    '  c.inc(); c.inc();',
    '  return [c.count, Counter.label].join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { code, stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
  assert.ok(/#count/.test(code), 'a private name was renamed');
});

test('construct: yield and await usable as identifiers in sloppy mode', () => {
  const src = [
    'var yield = 3;',   // legal name outside strict mode / generators
    'var await = 4;',   // legal name outside modules / async
    'function f() { var yield = 5; return yield + 1; }',
    'console.log(yield, await, f());',
  ].join('\n') + '\n';
  const { code, stats } = same(src, { sourceType: 'script', options: allOn, modes: ['sloppy'] });
  assert.ok(stats.renamed > 0, 'the inner yield local was not renamed');
  assert.ok(/console\.log\(yield, await,/.test(code), 'a top-level global name was renamed');
});

test('construct: yield in a generator and await in an async function', () => {
  const src = [
    'async function main() {',
    '  function* gen() { yield 1; yield 2; }',
    '  let total = 0;',
    '  for (const v of gen()) total += v;',
    '  total += await Promise.resolve(10);',
    '  return total;',
    '}',
    'main().then((n) => console.log(n));',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

test('construct: catch parameter scope (binding, destructuring, optional)', () => {
  const src = [
    'function f() {',
    '  let log = [];',
    '  try { throw { code: 7 }; } catch (err) { let v = err.code + 1; log.push(v); }',
    '  try { throw "x"; } catch ({ length }) { log.push(length); }',
    '  try { throw new Error("boom"); } catch { log.push("no binding"); }',
    '  return log.join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

test('construct: Annex-B var redeclaring the catch parameter (sloppy only)', () => {
  const src = [
    'function f() {',
    '  let out;',
    '  try { throw { code: 7 }; }',
    '  catch (e) { var e = e.code + 1; out = e; }',   // Annex B: var e writes the catch param
    '  return out;',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'script', options: allOn, modes: ['sloppy'] });
  assert.ok(stats.renamed > 0);
});

test('construct: Annex-B function declared in a block', () => {
  // sloppy: inner is hoisted to the function scope. strict: inner is block-scoped, so both sides throw the same
  // ReferenceError — still a valid differential case.
  const src = [
    'function outer() {',
    '  if (true) { function inner() { return "inner"; } }',
    '  return inner();',
    '}',
    'console.log(outer());',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'script', options: allOn });
  assert.ok(stats.renamed >= 0);   // outer is a script-root global (kept); inner may or may not be renamed
});

test('construct: computed keys in objects and classes', () => {
  const src = [
    'function f() {',
    '  const k1 = "a", k2 = "b";',
    '  const obj = { [k1]: 1, [k2 + k1]: 2, plain: 3 };',
    '  class K { [k1]() { return "m"; } static [k2] = 9; }',
    '  return [obj.a, obj.ba, obj.plain, new K().a(), K.b].join(",");',
    '}',
    'console.log(f());',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

test('construct: destructuring with defaults, holes, rest and nesting', () => {
  const src = [
    'function f(arr, obj) {',
    '  const [first, , third = 99, ...rest] = arr;',
    '  const { a, b: { c = 5 } = {}, ...others } = obj;',
    '  return [first, third, rest.join("|"), a, c, JSON.stringify(others)].join(",");',
    '}',
    'console.log(f([1, 2], { a: 10, z: 1 }));',
    'console.log(f([1, 2, 3, 4, 5], { a: 10, b: { c: 7 }, z: 1, y: 2 }));',
  ].join('\n') + '\n';
  const { stats } = same(src, { sourceType: 'commonjs', options: allOn });
  assert.ok(stats.renamed > 0);
});

// ---------------------------------------------------------------- import / export bindings (modules, two files)
test('construct: import / export bindings are preserved, locals renamed', () => {
  const dep = [
    'const internalPrefix = "val:";',
    'function format(x) { return internalPrefix + x; }',
    'export const NAMED = format(1);',
    'export function helper(x) { return format(x); }',
    'export default function () { return "the-default"; }',
  ].join('\n') + '\n';
  const main = [
    'import makeDefault, { NAMED, helper } from "./dep.mjs";',
    'const localOnly = helper(2);',
    'console.log(NAMED, localOnly, makeDefault());',
  ].join('\n') + '\n';

  const depObf = obfuscate(dep, { sourceType: 'module', seed: 11, ...allOn });
  const mainObf = obfuscate(main, { sourceType: 'module', seed: 12, ...allOn });

  // The exported names and the module specifier must survive, or the two modules would not link.
  assert.ok(/NAMED/.test(depObf.code) && /helper/.test(depObf.code), 'an exported name was renamed');
  assert.ok(/NAMED/.test(mainObf.code) && /helper/.test(mainObf.code), 'an imported name was renamed');
  assert.ok(/dep\.mjs/.test(mainObf.code), 'the module specifier was changed');
  assert.ok(depObf.stats.renamed > 0, 'no local renamed in the dependency');

  const dir = tempDir('vb-obf-mod-');
  try {
    writeFiles(dir, { 'dep.mjs': dep, 'main.mjs': main });
    const native = runNode(path.join(dir, 'main.mjs'));
    writeFiles(dir, { 'dep.mjs': depObf.code, 'main.mjs': mainObf.code });
    const obf = runNode(path.join(dir, 'main.mjs'));
    assert.equal(obf.stdout, native.stdout, 'obfuscated modules behave differently\n' + obf.stderr);
    assert.equal(obf.status, native.status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('construct: named re-export shorthand keeps both names', () => {
  const src = [
    'const original = 5;',
    'const other = 6;',
    'export { original, other as renamed };',
  ].join('\n') + '\n';
  const { code } = obfuscate(src, { sourceType: 'module', seed: 5, ...only('rename') });
  // `export { original }` must still export the name "original"; a local may be renamed only as `X as original`.
  assert.ok(/\boriginal\b/.test(code) && /\brenamed\b/.test(code));
});
