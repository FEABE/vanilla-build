// Bundler fixtures: each case is a small multi-module program. test/bundle.test.mjs writes it to a temporary
// folder, runs it natively with Node, bundles it in every format, runs the bundle and compares stdout, the exit
// code and the name of an uncaught error. `formats` limits the formats; `buildError` expects the build to fail.
const out = 'const out = (...a) => console.log(a.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" "));\n';
const errName = 'const errName = (f) => { try { f(); return "no error"; } catch (e) { return e.constructor.name; } };\n';

export const cases = {
  'circular-functions': {
    files: {
      'main.mjs': out + 'import { a, callB } from "./a.mjs";\nout("main", a, callB());\n',
      'a.mjs': 'import { b } from "./b.mjs";\nexport const a = "A";\nexport function callB() { return b(); }\nexport function hoisted() { return "hoisted from a"; }\n',
      'b.mjs': out + 'import { hoisted } from "./a.mjs";\nout("b runs first:", hoisted());\nexport function b() { return "B"; }\n',
    },
  },
  'circular-tdz-uncaught': {
    files: {
      'main.mjs': 'import "./a.mjs";\nconsole.log("not reached");\n',
      'a.mjs': 'import { y } from "./b.mjs";\nexport let x = 1;\nconsole.log("a", y);\n',
      'b.mjs': 'import { x } from "./a.mjs";\nexport const y = x + 1;\n',
    },
  },
  'circular-tdz-caught': {
    files: {
      'main.mjs': out + errName + 'import { read, late } from "./b.mjs";\nout("after", read(), late);\n',
      'a.mjs': out + errName + 'import { late } from "./b.mjs";\nout("let", errName(() => late));\nexport let lateA = 1;\n',
      'b.mjs': out + errName + 'import { lateA } from "./a.mjs";\nimport * as A from "./a.mjs";\nout("ns read", errName(() => A.lateA));\nout("class", errName(() => K));\nexport let late = "L";\nexport class K {}\nexport function read() { return lateA; }\n',
    },
  },
  'circular-var': {
    files: {
      'main.mjs': out + 'import { v, f } from "./a.mjs";\nout(v, f());\n',
      'a.mjs': out + 'import { w } from "./b.mjs";\nexport var v = "v";\nexport function f() { return w; }\n',
      'b.mjs': out + 'import { v } from "./a.mjs";\nout("b sees", typeof v, v === undefined);\nexport var w = "w";\n',
    },
  },
  'export-star': {
    files: {
      'main.mjs': out + 'import * as all from "./barrel.mjs";\nimport { only1, only2, shared, explicit } from "./barrel.mjs";\nout(Object.keys(all));\nout(only1, only2, shared, explicit);\nout("dup" in all);\nimport { ns } from "./barrel.mjs";\nout(Object.keys(ns), ns.only1);\n',
      'barrel.mjs': 'export * from "./one.mjs";\nexport * from "./two.mjs";\nexport * as ns from "./one.mjs";\nexport { dup as explicit } from "./one.mjs";\n',
      'one.mjs': 'export const only1 = 1;\nexport const dup = "one";\nexport { common as shared } from "./common.mjs";\nexport default "one-default";\n',
      'two.mjs': 'export const only2 = 2;\nexport const dup = "two";\nexport { common as shared } from "./common.mjs";\n',
      'common.mjs': 'export const common = "same binding";\n',
    },
  },
  'export-star-ambiguous-import': {
    buildError: /ambiguous/,
    nativeError: 'SyntaxError',
    files: {
      'main.mjs': 'import { dup } from "./barrel.mjs";\nconsole.log(dup);\n',
      'barrel.mjs': 'export * from "./one.mjs";\nexport * from "./two.mjs";\n',
      'one.mjs': 'export const dup = 1;\n',
      'two.mjs': 'export const dup = 2;\n',
    },
  },
  'reexport-chain': {
    files: {
      'main.mjs': out + 'import { final, again, def } from "./c.mjs";\nimport * as C from "./c.mjs";\nout(final, again, def, Object.keys(C));\n',
      'c.mjs': 'export { middle as final, middle as again } from "./b.mjs";\nexport { default as def } from "./b.mjs";\n',
      'b.mjs': 'export { original as middle } from "./a.mjs";\nexport { default } from "./a.mjs";\n',
      'a.mjs': 'export const original = "deep";\nexport default "a-default";\n',
    },
  },
  'default-and-named': {
    files: {
      'main.mjs': out +
        'import fn, { named as n, Klass } from "./fn.mjs";\nimport K from "./klass.mjs";\nimport expr from "./expr.mjs";\nimport anon from "./anon.mjs";\nimport anonClass from "./anon-class.mjs";\nimport arrow from "./arrow.mjs";\nimport alias, { bump } from "./alias.mjs";\nimport snap, { bumpSnap } from "./snapshot.mjs";\n' +
        'out(fn(), fn.name, n, new Klass().k, new K().who(), K.name, expr);\nout(anon(), anon.name, anonClass.name, arrow(), arrow.name);\nbump(); out("alias is live", alias);\nbumpSnap(); out("default expr is a snapshot", snap);\n',
      'fn.mjs': 'export default function greet() { return "hi"; }\nexport const named = "named";\nexport class Klass { k = 1; }\n',
      'klass.mjs': 'export default class Person { who() { return "person"; } }\n',
      'expr.mjs': 'const x = 40;\nexport default x + 2\n',
      'anon.mjs': 'export default function () { return "anonymous"; }\n',
      'anon-class.mjs': 'export default class {}\n',
      'arrow.mjs': 'export default () => "arrow";\n',
      'alias.mjs': 'let value = 1;\nexport { value as default };\nexport function bump() { value++; }\n',
      'snapshot.mjs': 'let value = 1;\nexport default value;\nexport function bumpSnap() { value++; }\n',
    },
  },
  'live-bindings': {
    files: {
      'main.mjs': out + 'import { count, inc, reset } from "./counter.mjs";\nimport * as C from "./counter.mjs";\nout(count, C.count);\ninc(); inc();\nout(count, C.count);\nreset();\nout(count);\nconst read = () => count;\ninc();\nout(read());\n',
      'counter.mjs': 'export let count = 0;\nexport function inc() { count += 1; }\nexport function reset() { count = 0; }\n',
    },
  },
  'evaluation-order': {
    files: {
      'main.mjs': 'import "./log.mjs";\nimport "./a.mjs";\nimport { done } from "./b.mjs";\nimport "./a.mjs";\nconsole.log("main", done);\n',
      'log.mjs': 'console.log("log first");\n',
      'a.mjs': 'import "./shared.mjs";\nconsole.log("a");\n',
      'b.mjs': 'import "./shared.mjs";\nimport "./c.mjs";\nconsole.log("b");\nexport const done = true;\n',
      'c.mjs': 'console.log("c");\n',
      'shared.mjs': 'console.log("shared once");\n',
    },
  },
  'dynamic-import': {
    files: {
      'main.mjs': out + 'import * as staticNs from "./lazy.mjs";\nconst ns = await import("./lazy.mjs");\nout(ns === staticNs, Object.keys(ns), ns.value, ns.default());\nconst j = await import("./data.json", { with: { type: "json" } });\nout(j.default.list);\n',
      'lazy.mjs': 'export const value = "lazy";\nexport default function () { return "dyn default"; }\n',
      'data.json': '{ "list": [1, 2, 3] }',
      'side.mjs': 'import data from "./data.json" with { type: "json" };\nexport { data };\n',
    },
    formats: ['esm'],
  },
  'dynamic-import-in-function': {
    files: {
      'main.mjs': out + 'import { value } from "./lazy.mjs";\nfunction later() { return import("./lazy.mjs"); }\nlater().then((ns) => out("then", ns.value, value, Object.prototype.toString.call(ns)));\n',
      'lazy.mjs': 'export const value = 7;\n',
    },
  },
  'dynamic-import-unbundled': {
    buildError: /not imported statically/,
    files: {
      'main.mjs': 'import("./only-dynamic.mjs").then((m) => console.log(m.x));\n',
      'only-dynamic.mjs': 'export const x = 1;\n',
    },
  },
  'json-import': {
    files: {
      'main.mjs': out + 'import data from "./data.json" with { type: "json" };\nimport again from "./data.json" with { type: "json" };\nout(data, data === again, Object.getPrototypeOf(data) === Object.prototype);\n',
      'data.json': '{ "name": "x", "n": [1, 2], "nested": { "ok": true }, "__proto__": { "polluted": 1 } }',
    },
  },
  'json-needs-attribute': {
    buildError: /type: 'json'/,
    nativeError: 'TypeError',
    files: {
      'main.mjs': 'import data from "./data.json";\nconsole.log(data);\n',
      'data.json': '{}',
    },
  },
  'import-meta': {
    buildError: /import\.meta/,
    files: { 'main.mjs': 'console.log(typeof import.meta.url);\n' },
  },
  'name-collisions': {
    files: {
      'main.mjs': out + 'import { value as v, helper as h1 } from "./a.mjs";\nimport { helper as h2, useOwn } from "./b.mjs";\nconst helper = "main helper";\nfunction shadow() { const value = "inner"; return [v, value]; }\nfunction shadow2(helper) { return [h1(), helper]; }\nout(h1(), h2(), helper, shadow(), shadow2("param"), useOwn());\nlet console2 = 1;\nout(typeof console2);\n',
      'a.mjs': 'export const value = "a.value";\nexport function helper() { return "a.helper"; }\n',
      'b.mjs': 'const value = "b.value";\nexport function helper() { return "b.helper:" + value; }\nexport function useOwn() { const o = { value, helper }; return o.value + "/" + typeof o.helper; }\n',
    },
  },
  'top-level-this-and-strict': {
    files: {
      'main.mjs': out + errName + 'import { sloppyLooking } from "./other.mjs";\nout(this === undefined, typeof this, (() => this)() === undefined);\nfunction f() { return this; }\nout(f() === undefined);\nout(errName(() => { undeclaredVariable = 1; }));\nfunction g(a) { arguments[0] = 2; return a; }\nout(g(1));\nout(sloppyLooking());\nout(errName(() => { Object.freeze([]).push(1); }));\n',
      'other.mjs': 'export function sloppyLooking() { return (function () { return typeof this; })(); }\n',
    },
  },
  'namespace-object': {
    files: {
      'main.mjs': out + errName + 'import * as ns from "./m.mjs";\nout(Object.keys(ns), Object.prototype.toString.call(ns), Object.getPrototypeOf(ns), Object.isExtensible(ns));\nout(errName(() => { ns.zeta = 1; }), errName(() => { ns.added = 1; }));\nout(ns.zeta, ns.alpha, "default" in ns, ns.default);\nout(JSON.stringify(ns));\n',
      'm.mjs': 'export const zeta = "z";\nexport const alpha = "a";\nexport const Beta = "B";\nexport default 5;\n',
    },
  },
  'esm-imports-cjs': {
    files: {
      'main.mjs': out + 'import lib, { add, name } from "./lib.cjs";\nimport * as libNs from "./lib.cjs";\nimport plain from "./plain.cjs";\nout(add(2, 3), name, lib.name, typeof libNs.default, libNs.add === add);\nout(plain);\n',
      'lib.cjs': 'exports.add = (a, b) => a + b;\nexports.name = "lib";\nexports.thisIsExports = this === module.exports;\n',
      'plain.cjs': 'module.exports = "a string";\n',
    },
  },
  'cjs-graph': {
    files: {
      'main.cjs': 'const a = require("./a.cjs");\nconsole.log("main", a.done, a.bSawPartialA);\nconsole.log(require("./a.cjs") === a);\nconsole.log((function () { return typeof this; })());\nconsole.log(typeof __filename, typeof __dirname, typeof module.exports);\nconst data = require("./data.json");\nconsole.log(data.v);\n',
      'a.cjs': 'exports.done = false;\nconst b = require("./b.cjs");\nexports.bSawPartialA = b.sawA;\nexports.done = true;\n',
      'b.cjs': 'const a = require("./a.cjs");\nexports.sawA = a.done;\n',
      'data.json': '{ "v": 42 }',
    },
    // esm output is strict as a whole, so the sloppy `this` differs there (a warning says so; see the next test file)
    formats: ['iife', 'cjs'],
  },
  'cjs-sloppy': {
    files: {
      'main.mjs': 'import "./sloppy.cjs";\nconsole.log("esm done");\n',
      'sloppy.cjs': 'implicitGlobal = 5;\nconsole.log(typeof implicitGlobal, (function () { return this === globalThis; })());\nvar o = { a: 1 };\nwith (o) { console.log(a); }\ndelete globalThis.implicitGlobal;\n',
    },
    formats: ['iife', 'cjs'],
  },
  'assign-to-import': {
    buildError: /imports are read-only/,
    nativeError: 'TypeError',
    files: {
      'main.mjs': 'import { x } from "./a.mjs";\nx = 2;\n',
      'a.mjs': 'export let x = 1;\n',
    },
  },
  'missing-export': {
    buildError: /does not provide an export named "nope"/,
    nativeError: 'SyntaxError',
    files: {
      'main.mjs': 'import { nope } from "./a.mjs";\nconsole.log(nope);\n',
      'a.mjs': 'export const yes = 1;\n',
    },
  },
  'top-level-await': {
    files: {
      'main.mjs': 'import { v } from "./a.mjs";\nconsole.log("main", v);\n',
      'a.mjs': 'console.log("a start");\nexport const v = await Promise.resolve("awaited");\nconsole.log("a end");\n',
    },
    formats: ['esm'],
  },
  'top-level-await-iife': {
    buildError: /top-level await needs format "esm"/,
    formats: ['iife', 'cjs'],
    files: { 'main.mjs': 'await 1;\n' },
  },
  'asi-between-modules': {
    files: {
      'main.mjs': 'import "./a.mjs"\nimport { f } from "./b.mjs"\n;(function () { console.log("iife after import", f()) })()\n',
      'a.mjs': 'let x = 1\nx\n',
      'b.mjs': '[1].forEach((n) => console.log("b", n))\nexport function f() { return "f" }\n',
    },
  },
  'shorthand-and-patterns': {
    files: {
      'main.mjs': out + 'import { item, other } from "./a.mjs";\nconst item2 = { item, other };\nconst { item: renamed = 3 } = { item };\nout(item2, renamed);\nimport { list } from "./b.mjs";\nout(list);\n',
      'a.mjs': 'export const item = "I";\nexport let other = "O";\n',
      'b.mjs': 'const item = "b-item";\nconst { other = "default" } = {};\nexport const list = [item, other];\n',
    },
  },
  // Node runs .mts / .ts natively (type stripping), so this one is differential too.
  'typescript-modules': {
    files: {
      'main.mts': out + 'import { area, type Shape } from "./shapes.ts";\nconst s: Shape = { kind: "square", size: 3 };\nout(area(s));\n',
      'shapes.ts': 'export interface Square { kind: "square"; size: number }\nexport type Shape = Square;\nexport function area(s: Shape): number { return s.size * s.size; }\n',
    },
  },
};
