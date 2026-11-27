/**
 * lib/ts.mjs — TypeScript support through Node's own type stripper (module.stripTypeScriptTypes).
 * Part of vanilla-build. MIT License.
 *
 * Only erasable syntax is supported: type annotations, interfaces, type aliases, `import type`, generics, `as`,
 * `satisfies`, non-null `!`. Enums, namespaces with values, parameter properties and other syntax that generates
 * code are refused by Node with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (Node 26 offers no transform mode). Types are
 * replaced by whitespace, so every offset in the output matches the input. No type checking happens.
 */
import nodeModule from 'node:module';

export const TS_EXTENSIONS = ['.ts', '.mts', '.cts'];
export const isTypeScript = (file) => TS_EXTENSIONS.some((e) => file.endsWith(e));

export function typeScriptAvailable() { return typeof nodeModule.stripTypeScriptTypes === 'function'; }

/** Strips types from TypeScript source. Throws a clear error when Node cannot do it. */
export function stripTypes(src, file) {
  if (!typeScriptAvailable()) {
    const e = new Error((file ? file + ': ' : '') + 'TypeScript needs Node with module.stripTypeScriptTypes (Node 22.13+ / 23.2+); this is Node ' + process.versions.node);
    e.code = 'VB_TS_UNAVAILABLE';
    throw e;
  }
  // The API prints an ExperimentalWarning once; keep the build output clean.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning && warning.message;
    if (/stripTypeScriptTypes/.test(String(text))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return nodeModule.stripTypeScriptTypes(src, { mode: 'strip' });
  } catch (err) {
    const e = new Error((file ? file + ': ' : '') + err.message.split('\n')[0] +
      (err.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ? ' (only erasable TypeScript is supported: no enum, namespace, parameter properties)' : ''));
    e.code = err.code || 'VB_TS_ERROR';
    throw e;
  } finally {
    process.emitWarning = emit;
  }
}
