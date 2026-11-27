# Changelog

## 0.2.0 — 2026-11-27

- **Experimental obfuscator** (`lib/obfuscate.mjs`), **off by default.** Reachable only through the
  `--experimental-obfuscate` CLI flag, the `experimentalObfuscate` config / API option, or a direct `obfuscate()`
  call; with it off every build is byte-for-byte identical to 0.1.x.
  - Passes: scope-aware `rename` (declared locals only — globals, imports/exports and classic-script top-level names
    are kept; disabled for a file using direct `eval` / `with`), `strings` (hex/unicode escapes), `stringArray`
    (encoded table + a decoder, no new global), `deadCode`, and `controlFlow` (switch-in-a-loop flattening).
  - No `eval` / `new Function`: output runs under a CSP without `'unsafe-eval'`.
  - **Not a security measure.** It only raises the effort of reading the code and never prevents recovery. See the
    README section "Experimental: obfuscation" for the full disclaimer and the per-pass limitations.
  - Zero-dependency and hand-written; reuses the existing parser and scope analysis.
  - Exposed from the API as `obfuscate`, `OBFUSCATE_DEFAULTS`, `OBFUSCATE_OPTIONS`.
- **Corpus checker** gains an `--only obfuscate` layer: parse-survival of every obfuscated file (and every
  double-obfuscated file) against V8 as the oracle.
- **Tests:** 87 with `node --test` (the 54 from 0.1.0 plus obfuscator construct, build-integration and
  suite-rerun tests; constructs are run in both sloppy and strict mode). `scripts/obfuscate-suites.mjs` reruns
  vanilla-kit / vanilla-arch suites against obfuscated builds across seeds, including the shipped bundle → minify →
  obfuscate order.

## 0.1.0 — 2026-11-27

First release.

- **Bundler** (`lib/bundle.mjs`):
  - ES modules are scope-hoisted into one scope and evaluated in native ESM order, so live bindings, circular
    imports and TDZ errors behave as in Node. Colliding names are renamed with scope awareness.
  - Namespace objects are supported.
  - CommonJS modules run in Node-style wrappers, and sloppy mode is kept in iife/cjs output.
  - JSON modules need `with { type: 'json' }`.
  - Externals (iife output maps them with `globals`).
  - `import()` works for modules that are also imported statically.
  - Output formats: `esm`, `iife` (optionally with a global `name`) and `cjs`.
  - Unsupported input is refused with a `BundleError` that names the file.
- **Parser and scope analysis** (`lib/parse/`): an ES2025 parser for scripts and modules that produces an
  ESTree-shaped AST with source ranges, plus scope analysis and a local renamer.
- **Minifier** (`lib/minify.cjs`): the vanilla-kit 0.2.1 minifier, vendored unchanged.
- **TypeScript** (`lib/ts.mjs`): erasable syntax only, through Node's `module.stripTypeScriptTypes`. Syntax that
  generates code is refused with a clear message.
- **CSS** (`lib/css.mjs`):
  - `@import` inlining, with media lists wrapped in `@media` and `url()` rebased.
  - Remote imports, `layer()` / `supports()` imports and cycles are left in place.
  - A conservative minifier.
- **HTML** (`lib/html.mjs`): a tag scanner that finds and rewrites `<script src>`, `<link href>` and `<img src>`
  in place.
- **Build pipeline** (`lib/build.mjs`):
  - Pages go in and a deployable folder comes out, with content-hashed names and `manifest.json`.
  - Optional `integrity` attributes.
  - Static files and `publicDir` are copied.
  - `outDir` is checked before it is cleaned.
  - `--watch` rebuilds with debouncing.
- **CLI** (`bin/vanilla-build.mjs`): the `build`, `bundle`, `minify` and `css` commands.
- **Example** (`examples/site`): built end to end by the CLI in the test suite.
- **Tests:** 52 with `node --test`, including 29 differential bundler fixtures that are compared against native
  Node.
- **Corpus checker:** `scripts/check-corpus.mjs`.
