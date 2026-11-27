// Differential bundler tests: every fixture runs natively in Node (unbundled ES modules / CommonJS) and as a
// bundle in each output format; stdout, exit code and the uncaught error's name must be identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '../lib/bundle.mjs';
import { cases } from './fixtures/bundle-cases.mjs';
import { tempDir, writeFiles, runNode } from './helpers/run.mjs';

const FORMATS = ['esm', 'iife', 'cjs'];
const EXT = { esm: '.mjs', iife: '.cjs', cjs: '.cjs' };

function entryOf(dir) {
  for (const n of ['main.mjs', 'main.cjs', 'main.mts', 'main.ts']) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  throw new Error('fixture without main');
}

for (const [name, c] of Object.entries(cases)) {
  test('bundle: ' + name, () => {
    const dir = tempDir('vb-bundle-');
    try {
      writeFiles(dir, c.files);
      const entry = entryOf(dir);
      const native = runNode(entry, { cwd: dir });
      if (c.nativeError) assert.equal(native.error, c.nativeError, 'native run should fail with ' + c.nativeError + '\n' + native.stderr);
      for (const format of c.formats || FORMATS) {
        if (c.buildError) {
          assert.throws(() => bundle({ entry, format, root: dir }), c.buildError, format);
          continue;
        }
        const result = bundle({ entry, format, root: dir });
        const outFile = path.join(dir, 'out-' + format + EXT[format]);
        fs.writeFileSync(outFile, result.code);
        const got = runNode(outFile, { cwd: dir });
        const where = name + ' [' + format + ']\n--- bundle ---\n' + result.code + '\n--- stderr ---\n' + got.stderr;
        assert.equal(got.stdout, native.stdout, where);
        assert.equal(got.status, native.status, where);
        assert.equal(got.error, native.error, where);
        assert.ok(!/[A-Za-z]:[\\/]|\/tmp\//.test(result.code.replace(/\/\/[^\n]*/g, '')), 'bundle must not contain absolute paths');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('bundle: iife with a global name exposes the entry namespace', () => {
  const dir = tempDir('vb-bundle-');
  try {
    writeFiles(dir, { 'main.mjs': 'export let n = 1;\nexport function inc() { n++; }\nexport default "d";\n' });
    const { code, exports } = bundle({ entry: path.join(dir, 'main.mjs'), format: 'iife', name: 'Lib', root: dir });
    assert.deepEqual(exports.sort(), ['default', 'inc', 'n']);
    const vm = { Lib: null };
    new Function('ctx', code + '\nctx.Lib = Lib;')(vm);
    assert.equal(vm.Lib.n, 1);
    vm.Lib.inc();
    assert.equal(vm.Lib.n, 2, 'live binding through the namespace');
    assert.equal(vm.Lib.default, 'd');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: externals (node built-ins) stay imports / requires', () => {
  const dir = tempDir('vb-bundle-');
  try {
    writeFiles(dir, { 'main.mjs': 'import { join } from "node:path";\nimport pathDefault from "node:path";\nimport * as os from "node:os";\nconsole.log(join("a", "b") === pathDefault.join("a", "b"), typeof os.cpus);\n' });
    const entry = path.join(dir, 'main.mjs');
    const native = runNode(entry);
    for (const format of ['esm', 'cjs']) {
      const { code } = bundle({ entry, format, root: dir });
      const f = path.join(dir, 'o' + EXT[format]);
      fs.writeFileSync(f, code);
      assert.equal(runNode(f).stdout, native.stdout, format);
    }
    assert.throws(() => bundle({ entry, format: 'iife', root: dir }), /globals/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: bare specifiers that are not external fail clearly', () => {
  const dir = tempDir('vb-bundle-');
  try {
    writeFiles(dir, { 'main.mjs': 'import x from "some-package";\n' });
    assert.throws(() => bundle({ entry: path.join(dir, 'main.mjs'), root: dir }), /bare specifiers need `external`/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: sloppy CommonJS in esm output is reported', () => {
  const dir = tempDir('vb-bundle-');
  try {
    writeFiles(dir, { 'main.mjs': 'import "./s.cjs";\n', 's.cjs': 'module.exports = function () { return this; };\n' });
    const r = bundle({ entry: path.join(dir, 'main.mjs'), root: dir, format: 'esm' });
    assert.ok(r.warnings.some((w) => /strict mode in esm output/.test(w)), r.warnings.join('\n'));
    assert.equal(bundle({ entry: path.join(dir, 'main.mjs'), root: dir, format: 'iife' }).warnings.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: import.meta can be kept in esm output', () => {
  const dir = tempDir('vb-bundle-');
  try {
    writeFiles(dir, { 'main.mjs': 'console.log(import.meta.url.endsWith(".mjs"));\n' });
    const { code } = bundle({ entry: path.join(dir, 'main.mjs'), root: dir, importMeta: 'keep' });
    assert.match(code, /import\.meta\.url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
