/**
 * lib/minify.mjs — ES-module front for the vendored minifier (lib/minify.cjs, from vanilla-kit).
 * Part of vanilla-build. MIT License.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('./minify.cjs');

/**
 * minify(src, { mangle = true, keepLicense = true, keepFnames = false, keepClassnames = true })
 *   -> { code, renamed, bindings, skipped }
 * Throws with .line / .col when it cannot read the input (it refuses instead of guessing).
 */
export const minify = M.minify;
export const inspect = M.inspect;
export const tokenize = M.tokenize;
