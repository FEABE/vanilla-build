'use strict';
/**
 * scripts/obfuscate-hook.cjs — preload (NODE_OPTIONS=--require) used by scripts/obfuscate-suites.mjs.
 * Replaces chosen source files by their obfuscated version when they are loaded, so another project's own test
 * suite runs against obfuscated code without touching that project.
 *
 *   VB_OBF_OPTIONS  JSON options for obfuscate() (seed included)
 *   VB_OBF_TARGETS  JSON array of { file, sourceType } — loaded through require()
 *   VB_OBF_READS    JSON array of files whose fs.readFileSync(file, 'utf8') text is replaced too
 *   VB_OBF_COUNT    file that receives "<pid> <count>" at exit: how many loads were replaced (positive control)
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { obfuscate } = require('../lib/obfuscate.mjs');

const options = JSON.parse(process.env.VB_OBF_OPTIONS || '{}');
const targets = new Map(JSON.parse(process.env.VB_OBF_TARGETS || '[]').map((t) => [path.resolve(t.file), t.sourceType]));
const reads = new Set(JSON.parse(process.env.VB_OBF_READS || '[]').map((f) => path.resolve(f)));
const cache = new Map();
let count = 0;

function obfuscated(file, src) {
  if (!cache.has(file)) cache.set(file, obfuscate(src, { ...options, sourceType: targets.get(file) || 'script' }).code);
  count++;
  return cache.get(file);
}

const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  const f = path.resolve(filename);
  if (targets.has(f)) content = obfuscated(f, content);
  return compile.call(this, content, filename);
};

const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, enc) {
  const out = readFileSync.apply(this, arguments);
  if (typeof file === 'string' && reads.has(path.resolve(file)) && (enc === 'utf8' || (enc && enc.encoding === 'utf8'))) return obfuscated(path.resolve(file), out);
  return out;
};

process.on('exit', () => {
  if (process.env.VB_OBF_COUNT && count) fs.appendFileSync(process.env.VB_OBF_COUNT, process.pid + ' ' + count + '\n');
});
