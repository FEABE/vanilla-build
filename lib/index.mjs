/**
 * vanilla-build — programmatic API. Zero dependencies. MIT License.
 *
 *   import { build, watch, bundle, minify, minifyCss, inlineImports, stripTypes } from 'vanilla-build';
 */
export { build, watch, loadConfig, checkOutDir, DEFAULTS } from './build.mjs';
export { bundle, BundleError } from './bundle.mjs';
export { minify } from './minify.mjs';
export { minifyCss, inlineImports } from './css.mjs';
export { scanHtml, rewriteHtml } from './html.mjs';
export { stripTypes, typeScriptAvailable } from './ts.mjs';
export { parse } from './parse/parser.mjs';
export { analyze } from './parse/scope.mjs';
