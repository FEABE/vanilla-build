# Changelog

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
