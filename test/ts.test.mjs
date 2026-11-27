// TypeScript goes through Node's module.stripTypeScriptTypes. These tests document exactly what the installed
// Node accepts (checked on Node 26.13: strip mode only, no transform mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypes, typeScriptAvailable } from '../lib/ts.mjs';

test('ts: erasable syntax is replaced by whitespace (offsets are kept)', { skip: !typeScriptAvailable() }, () => {
  const src = 'const x: number = 1;\ninterface I { a: string }\ntype T = I | null;\nfunction f<T>(a: T, b?: string): T { return a as T; }\nlet y = x!;\nexport type { T };\nimport type { Q } from "./q.js";\nconst s = { a: 1 } satisfies Record<string, number>;\n';
  const out = stripTypes(src, 'x.ts');
  assert.equal(out.length, src.length);
  assert.ok(!/interface|number|satisfies|import type/.test(out));
  assert.equal(new Function(out.replace(/export\s*\{[^}]*\};?/, '') + '\nreturn [x, f(2), y, s.a];')().join(','), '1,2,1,1');
});

test('ts: code-generating syntax is refused with a clear message', { skip: !typeScriptAvailable() }, () => {
  for (const [src, what] of [['enum E { A }', /enum/], ['namespace N { export const a = 1 }', /namespace/], ['class C { constructor(public a: number) {} }', /parameter propert/]]) {
    assert.throws(() => stripTypes(src, 'bad.ts'), (e) => what.test(e.message) && /bad\.ts/.test(e.message) && /only erasable TypeScript/.test(e.message));
  }
});

test('ts: no ExperimentalWarning is printed', { skip: !typeScriptAvailable() }, () => {
  const seen = [];
  const onWarn = (w) => seen.push(w);
  process.on('warning', onWarn);
  stripTypes('const a: number = 1;', 'w.ts');
  process.off('warning', onWarn);
  assert.equal(seen.filter((w) => /stripTypeScriptTypes/.test(w.message)).length, 0);
});
