# vanilla-build

A build tool for plain web projects: it bundles ES modules and CommonJS into one `esm`, `iife` or `cjs` file,
minifies JavaScript and CSS, gives assets content-hashed names, writes a `manifest.json`, and rewrites your HTML
pages to point at the results. TypeScript works through Node's own type stripper.

[한국어 README](README.ko.md) · [Changelog](CHANGELOG.md) · MIT License

Part of a small family of zero-dependency, hand-written tools:
[vanilla-arch](https://github.com/FEABE/vanilla-arch) (diagrams) ·
[vanilla-kit](https://github.com/FEABE/vanilla-kit) (small modules) ·
[vanilla-build](https://github.com/FEABE/vanilla-build) (build) ·
[vanilla-deploy](https://github.com/FEABE/vanilla-deploy) (deploy)

- **Zero dependencies.** `package.json` has no `dependencies` and no `devDependencies`. Everything runs on Node's
  standard library.
- **Hand-written.** The parser, scope analysis, bundler, CSS tools and HTML scanner were written for this project.
  The JavaScript minifier is vendored unchanged from vanilla-kit, by the same author (see [Minifier](#minifier)).
- **Every guarantee is tested.** Each claim under [Guarantees](#guarantees-and-the-tests-behind-them) names the test
  that checks it. Behavior that is described but has no test of its own is listed under
  [Described, not tested here](#described-not-tested-here).

Status: **0.1.0**, first release. It needs Node ≥ 22. TypeScript needs `module.stripTypeScriptTypes`
(Node 22.13+ / 23.2+). The test suite was run on Node 26.13 (Windows).

## Quick start

The package is not on npm. Use it from a checkout of this repository:

```sh
node path/to/vanilla-build/bin/vanilla-build.mjs --help
# or put `vanilla-build` on your PATH:
cd path/to/vanilla-build && npm link
```

Build the bundled example:

```sh
cd examples/site
node ../../bin/vanilla-build.mjs
```

```
  css    css/app.css                      -> css/app.fcad097b.css  186 B
  js     js/main.ts                       -> js/main.<hash>.js  …
  asset  img/logo.svg                     -> img/logo.0664a9d1.svg  116 B
  html   index.html                       -> index.html  …
  copied 2 other file(s)
built in 40 ms -> dist/
```

The example is a page with a stylesheet that `@import`s another, an image, and a TypeScript entry module. The
entry imports a TypeScript module, a JSON module (`with { type: 'json' }`) and a CommonJS module. `dist/` gets
hashed files, a rewritten `index.html` with `integrity` attributes, `manifest.json`, and `public/robots.txt`.

## How a build works

1. Every `.html` file under `root` is read, or only the pages listed in `html`.
2. Each local reference in a page becomes a job:
   - `<script src>` is bundled: `type="module"` gives `esm` output, a classic script gives `iife`.
   - `<link rel="stylesheet" href>` gets its `@import`s inlined and is minified.
   - `<link rel="modulepreload" href>` is bundled as `esm`.
   - `<img src>` and any other `<link href>` are copied under a hashed name.
3. Outputs keep the source folder layout and are named `name.<8 hex of sha256>.ext`. The hash covers the final
   bytes.
4. Pages are rewritten in place. Only the attribute value changes, and everything else stays byte for byte. With
   `integrity`, scripts and stylesheets get `integrity="sha384-…"`.
5. `manifest.json` maps the source path (relative to `root`) of every bundled script, stylesheet and hashed asset
   to its output path. Pages and plainly copied files are not in it. Keys are sorted.
6. Other files under `root` are copied as they are. Files that went into a bundle or a stylesheet are not copied,
   and neither are TypeScript files. Then `publicDir` is copied over the result.

## Config file

`vanilla-build` (the `build` command) reads `./vanilla-build.config.mjs` if it exists, or the file given by
`--config`. The default export is an object, or a function (which may be async) that returns one. Every key is
optional; these are the defaults:

```js
export default {
  root: '.',            // source folder
  outDir: 'dist',       // output folder; emptied first when clean is true
  html: null,           // pages to process (relative to root); null = every .html under root
  entries: [],          // extra scripts without a page: 'js/worker.js' or { entry, format, name }
  minify: true,         // minify JS bundles and CSS
  hash: true,           // content-hashed file names
  integrity: false,     // add integrity="sha384-..." to <script> and stylesheet <link>
  clean: true,          // empty outDir before building
  publicDir: null,      // folder copied as is over the output
  external: [],         // specifiers left as import / require (iife output needs a globals entry)
  globals: {},          // iife: external specifier -> global variable name, e.g. { react: 'React' }
  importMeta: 'error',  // 'keep' leaves import.meta in esm output (it then refers to the bundle)
};
```

Before it empties anything, the build refuses an `outDir` that is a filesystem root, the source root or a folder
containing it, the working directory or a folder containing it, or a folder with a `.git` inside.

An extra entry's hashed name is only recorded in `manifest.json`. Nothing rewrites references to it.

## CLI

```
vanilla-build [build] [options]            build the site described by vanilla-build.config.mjs
vanilla-build bundle <entry> [options]     bundle one entry (ESM / CommonJS / JSON / TypeScript)
vanilla-build minify <file.js> [options]   minify one JavaScript file
vanilla-build css <file.css> [options]     inline @import and minify one stylesheet
```

| Command | Option | Meaning |
|---|---|---|
| build | `--config <file>` | config file (default `./vanilla-build.config.mjs` if present) |
| | `--root <dir>` / `--out <dir>` / `--public <dir>` | override `root`, `outDir`, `publicDir` |
| | `--no-minify` `--no-hash` `--no-clean` `--integrity` | override the matching config key |
| | `--watch` | rebuild (debounced) when a file under `root` changes; the output folder is ignored |
| bundle | `-o, --out <file>` | write here (default: stdout) |
| | `--format <esm\|iife\|cjs>` | output format (default `esm`) |
| | `--name <Global>` | iife: assign the entry's exports to this global |
| | `--external <a,b>` | leave these specifiers as imports / requires |
| | `--minify` | minify the bundle |
| minify | `-o, --out <file>` `--no-mangle` `--keep-fnames` `--no-license` | output file; whitespace only; keep function names; drop license comments |
| css | `-o, --out <file>` `--root <dir>` | output file; folder that root-relative `@import "/x.css"` and `url()` rebasing refer to (default: the file's folder) |
| all | `-h, --help` `-v, --version` | |

Command-line flags override the config file. Exit code 1 and a one-line message on any error. Warnings go to stdout
for `build` and to stderr for `bundle` and `css`.

## Programmatic API

```js
import { build, watch, bundle, minify, minifyCss, inlineImports, stripTypes } from 'vanilla-build';

const r = await build({ root: 'src', outDir: 'dist', integrity: true });
// r: { outputs: [{ source, file, bytes, kind }], manifest, warnings, ms, outDir }

const w = watch({ root: 'src' }, { onBuild: (r) => {}, onError: (e) => {}, debounce: 100 });
w.close();

const b = bundle({ entry: 'src/main.ts', format: 'iife', name: 'App', root: 'src', external: [], globals: {} });
// b: { code, modules, exports, warnings }; throws BundleError (with .file) on unsupported input

minify(code, { mangle: true, keepLicense: true, keepFnames: false, keepClassnames: true });  // -> { code, ... }
minifyCss(css);                                   // -> string
inlineImports('src/app.css', { root: 'src' });    // -> { css, files, warnings }
stripTypes(tsSource, 'file.ts');                  // -> JavaScript with types replaced by whitespace
```

Also exported: `loadConfig`, `checkOutDir`, `DEFAULTS`, `BundleError`, `scanHtml`, `rewriteHtml`,
`typeScriptAvailable`, and the lower layers `parse` (ESTree-shaped AST with source ranges) and `analyze` (scope
analysis).

## Guarantees and the tests behind them

`npm test` (`node --test`) runs 52 tests: 34 in `bundle.test.mjs`, 7 in `build.test.mjs`, 5 in `css.test.mjs`,
3 in `ts.test.mjs`, 2 in `html.test.mjs` and 1 in `examples.test.mjs`. The runner reports 54, because it also
loads the fixture and helper modules under `test/` as files.

### Bundler: differential tests against native Node

`test/bundle.test.mjs` takes each of 29 fixtures (`test/fixtures/bundle-cases.mjs`), writes it to a temporary
folder and **runs it natively in Node** as unbundled ES modules and CommonJS. Then it bundles the fixture in each
output format, runs the bundle, and requires the **same stdout, exit code and uncaught error name**.

- 22 fixtures produce bundles that are compared this way. 18 run in all three formats, 2 run in `esm` only (top-level
  await) and 2 in `iife` + `cjs` only (a CommonJS entry, and sloppy-mode code using `with`, which strict `esm`
  output cannot hold).
- 7 fixtures expect the build to fail with a specific message. These are cases that also fail natively or cannot
  be bundled faithfully.

What the fixtures cover:

| Behavior | Fixtures |
|---|---|
| Evaluation order is ESM's (post-order, each module once) | `evaluation-order` |
| Live bindings: an exported `let` changed by its module is seen by importers | `live-bindings` |
| Circular imports: function declarations usable early, `var` undefined, TDZ `ReferenceError` for `let`/`const`/`class` (caught and uncaught) | `circular-functions`, `circular-var`, `circular-tdz-caught`, `circular-tdz-uncaught` |
| `export *`, re-export chains, default + named, shorthand and destructuring patterns | `export-star`, `reexport-chain`, `default-and-named`, `shorthand-and-patterns` |
| Namespace objects (`import * as ns`) | `namespace-object` |
| Colliding top-level names renamed without changing behavior | `name-collisions` |
| Top-level `this` and strict mode of ES modules | `top-level-this-and-strict` |
| No ASI hazard when modules are concatenated | `asi-between-modules` |
| `import()` of a statically imported module | `dynamic-import`, `dynamic-import-in-function` |
| JSON modules with `with { type: 'json' }` | `json-import` |
| CommonJS graphs, ESM importing CommonJS, sloppy-mode CommonJS staying sloppy in iife/cjs | `cjs-graph`, `esm-imports-cjs`, `cjs-sloppy` |
| Top-level await (esm output) | `top-level-await` |
| TypeScript modules | `typescript-modules` |
| Refused with a clear error: ambiguous `export *` import, missing export, assignment to an import, JSON import without the attribute, `import.meta`, `import()` of a module not imported statically, top-level await in iife/cjs | `export-star-ambiguous-import`, `missing-export`, `assign-to-import`, `json-needs-attribute`, `import-meta`, `dynamic-import-unbundled`, `top-level-await-iife` |

Every compared bundle is also checked for absolute paths (there must be none). Five more tests cover:
- the iife global name, with live bindings through it;
- Node built-ins as externals in esm/cjs, and the error when iife output has no `globals` entry;
- the error for bare specifiers that are not external;
- the warning when sloppy CommonJS ends up in strict esm output;
- `importMeta: 'keep'`.

### Build pipeline

`test/build.test.mjs`, through the API:

- Hashed names are the first 8 hex digits of the sha256 of the written bytes. `manifest.json` equals the returned
  manifest.
- `integrity` is the sha384 of the exact file.
- Root-relative URLs stay root-relative and relative URLs stay relative. Links that are not assets are untouched.
- The CSS output has `@import` inlined, is minified, and keeps its `url()`s.
- The built module bundle runs. A classic script is wrapped in an iife, so its top-level `var` is not a global.
- Sources that went into a bundle are not copied. `publicDir` is copied.
- Building twice gives the same manifest. No absolute path appears in any output.
- `hash: false` keeps plain names, and `clean` removes stale files.
- `clean: false` keeps existing files. `minify: false` leaves bundles and CSS unminified, but `@import`s are still
  inlined.
- Dangerous output folders are refused and nothing is deleted.
- `html` (page list): listed pages are rewritten and unlisted pages are copied as is.
- `entries`: an iife entry with `name`, plus `external` + `globals`, runs and reads the external from the global.
- `watch` rebuilds after a change (two quick writes give one rebuild) and does not rebuild on its own output.

Through the CLI, the tests cover:
- `build` with a config file, `bundle --format iife --minify` (the bundle runs), `minify`, `css`, an unknown
  command (exit 1) and `--help`;
- `test/examples.test.mjs`, which copies `examples/site` to a temporary folder, builds it with the real CLI and
  checks the manifest, the rewritten page and its integrity values, the CSS output and the copied files. It also
  runs the bundle and compares its output.

These CLI flags are covered only through the matching API or config options, not as flags:
- `--watch`, `--integrity`, `--public`, `--no-hash`, `--no-clean`, `--no-minify`, `--root` and `--out`;
- `bundle --name` and `--external`;
- the `-o` options of `bundle`, `minify` and `css`.

### CSS

`test/css.test.mjs`:

- The minifier is checked by an oracle: apart from the last `;` before `}`, the output keeps every character that
  is not whitespace or a comment, in order.
- `url(...)`, strings, `content:` values and custom property values (`--x: …`) stay byte for byte. So do
  `/*! … */` comments.
- `a/**/b` still separates two words, and minifying twice changes nothing.
- `@import` inlining: nested imports and `url()` rebasing (quoted and unquoted), media lists wrapped in
  `@media`, and the returned list of inlined files are tested.
- Remote imports, `layer(...)` imports and import cycles (with a warning) are left in place.

### HTML

`test/html.test.mjs`:

- `script src`, `link href` and `img src` are found. Comments and the raw text of `<script>`/`<style>`/… are
  skipped.
- Rewriting changes only the values the callback maps. Quotes and everything else stay as they were.

### TypeScript

`test/ts.test.mjs` (skipped when Node has no type stripper):

- Erasable syntax is replaced by whitespace, so offsets are kept.
- Syntax that generates code (`enum`, namespaces, parameter properties) is refused with a clear message.
- Node's `ExperimentalWarning` is not printed.

### Minifier

`lib/minify.cjs` is the vanilla-kit 0.2.1 minifier (`browser/minify.js`, upstream commit `50cd50f`), vendored
unchanged. It differs from the upstream file only in a four-line header comment.

It drops comments and whitespace and shortens names that are provably local. It never renames top-level names,
properties, labels or exports. It turns renaming off for direct `eval`, `with` and escaped identifiers, and it
refuses input it cannot read (error with line and column) rather than guess.

Upstream verifies it with token, statement and binding oracles. Upstream's record: **1,134 files / 23.8 MB, 0
failures, 0 refusals (LF and CRLF)**.

Here, `scripts/check-corpus.mjs` (`npm run corpus -- <dir>...`) runs the same oracles over any folders. It
classifies every file with V8 first, then requires two things:
- minified output must compile, re-minify, keep the token stream (whitespace-only mode) and resolve every
  identifier to the same declaration (mangled mode);
- the parser must accept the file, and renaming every local binding through the scope analysis must keep every
  identifier's declaration, judged by the minifier's independent analysis.

Two records exist:
- At the first commit, the parser and scope analysis were checked on a 1,177-file corpus. That corpus is not part
  of this repository.
- Re-run for this release over this repository's `bin/`, `test/` and `lib/parse/` plus vanilla-kit: 43 files,
  0 oracle failures, 0 refusals, parser accepted 43/43, 3,997 bindings renamed.

### Described, not tested here

The following work as described but have no test in this repository yet:
- `<link rel="modulepreload">` bundling.
- `--config <file>` with a path other than the default.
- A config file whose default export is a function.
- `@import ... supports(...)` being left in place.
- The minifier's `--no-mangle`, `--keep-fnames` and `--no-license` flags.

## Experimental: obfuscation

> **This is not a security measure.** Obfuscation only raises the effort of reading the code; it never prevents
> recovery. Anyone who runs the code can read every string and watch every value, and the transforms below can be
> undone. Do not put a secret, a key, or a check you need to hold in client code and expect obfuscation to protect
> it — it will not. This feature exists as a hand-written exercise in AST transformation, nothing more.

It is **experimental and off by default.** Nothing changes unless you ask for it with the `--experimental-obfuscate`
CLI flag, the `experimentalObfuscate` config / API option, or a direct call to `obfuscate()`. With it off, every build
is byte-for-byte identical to 0.1.x. It is zero-dependency and hand-written like the rest of the tool, and it reuses
the same parser and scope analysis as the bundler and minifier.

```bash
vanilla-build build --experimental-obfuscate      # obfuscate every JS bundle (after minify)
vanilla-build bundle src/app.js --minify --experimental-obfuscate
```

```js
import { obfuscate } from 'vanilla-build';
const { code, stats } = obfuscate(source, { sourceType: 'module' /* 'script' | 'module' | 'commonjs' */ });
```

In a build it runs **after** minify, over each JS bundle. Options (all booleans unless noted):

| option | default | what it does |
| --- | --- | --- |
| `rename` | on | Renames bindings found by scope analysis to `_0x…` names. **Only declared locals change.** Free variables (`window`, `localStorage`, any global your page defines) are never touched, imported and exported names are kept (the module contract), and a classic script's top-level names are kept because they are globals. |
| `strings` | on | Rewrites string literals with `\x` / `\u` escapes. Property keys are included; directives and module specifiers are not. |
| `stringArray` | on | Moves string literals into one encoded table (a custom base64 alphabet over UTF-8, rotated) read through a small decoder function. In a classic script the table is placed inside the outermost wrapper function so no global is added. |
| `deadCode` | off | Inserts unreachable `if (<always false>) { … }` blocks into function bodies. `deadCodeRate` (0–1) sets how often. |
| `controlFlow` | off | Turns function bodies with at least `controlFlowMin` statements into a shuffled `switch` inside a loop, driven by an order string. |

`seed` makes a run reproducible; the same seed gives the same output. `stats.skipped` lists the file- or scope-level
reasons a pass declined to run (direct `eval` / `with` for `rename`, no wrapper function for `stringArray`), and in a
build those become warnings.

**No `eval`, no `new Function`, no other string-to-code.** The output runs under a Content-Security-Policy without
`'unsafe-eval'`; the string-table decoder is ordinary array and `decodeURIComponent` work, not code generation.
Self-defending / anti-debugging tricks are deliberately not offered — they only hurt real users and browsers.

### What it does not do, and where it steps aside

Two passes step aside rather than risk wrong code — they skip the scope and record it in `stats.skipped`. Two others
stay correct for almost all code but change behaviour in ways worth knowing. Known limits:

- **`rename` is disabled for the whole file when it uses direct `eval` or `with`** (skipped), because neither can be
  resolved statically. The file still goes through the other passes; `stats.skipped` records the reason.
- **`stringArray` needs a wrapper** (skipped). A classic script with no outermost wrapper function (IIFE / UMD
  factory, including `var X = (function(){…})()`) is left with its strings in place, so the table never becomes a new
  global; `stats.skipped` records it.
- **`rename` changes `function.name` / `class.name` values** (behaviour change). Code that reads a function's `.name`
  at run time (some dependency-injection and router tricks) will see the obfuscated name.
- **`controlFlow` does not reproduce the temporal dead zone, and turns `const` into `let`** (behaviour change). It
  hoists lexical declarations out of the re-entered switch block and turns them into assignments, so a binding read
  before its initializer runs yields `undefined` instead of a `ReferenceError`, and reassigning a former `const` no
  longer throws. Leave `controlFlow` off for code that relies on TDZ errors or on `const` immutability at run time
  (for example some circular-import patterns).
- It is **not** a minifier and it does not shrink code — `controlFlow` and `deadCode` make the output larger.

This was checked by running vanilla-kit's and vanilla-arch's own `node --test` suites against obfuscated builds of
their modules across many seeds, by confirming vanilla-arch renders a pixel-identical canvas (`toDataURL`) obfuscated
or not, and by obfuscating a large corpus of real `.js`/`.mjs` files and re-parsing every result (and every
double-obfuscated result). None of this measures how hard the output is to read, and no such claim is made: see the
warning at the top of this section.

## Limitations

- **No source maps.** No JSX. The parser also rejects decorators and HTML-like comments.
- **No `node_modules` resolution.** Bare specifiers must be listed in `external` (`package.json` `exports` are
  not read). Relative imports try `.js .mjs .cjs .ts .mts .cts .json` and `index.*`, and `./x.js` may name `./x.ts`.
- **No code splitting.** `import()` works only for modules that are also imported statically. Other `import()`s
  are refused. A computed `import()` is left native, and a computed `require()` is left to run time (both with a
  warning).
- **No tree shaking or dead-code removal.** Every module in the graph is included.
- Top-level await needs `esm` output. `import.meta` is refused unless `importMeta: 'keep'` with `esm` output.
  `require()` of an ES module is refused.
- Sloppy-mode CommonJS runs in strict mode in `esm` output, and a warning says so.
- **TypeScript:** only erasable syntax, and no type checking.
- **CSS:** `url()` references inside stylesheets are not rewritten to hashed names. The original files are copied
  next to the hashed ones so those references keep working. The CSS minifier only removes whitespace and comments.
  It does not merge rules or shorten values.
- **HTML:** a tag scanner, not a full HTML parser. Only `<script src>`, `<link href>` and `<img src>` are
  rewritten. `srcset`, `<source>`, inline `style` and `<a href>` are left alone.
- **Extra entries:** their hashed names appear only in `manifest.json`.
- Tested on Windows with Node 26.13. Not yet run in CI on Linux or macOS, or on Node 22.

## Roadmap

- Source maps (bundle and minifier).
- JSX.
- `node_modules` resolution, including `package.json` `exports` / `imports`.
- Precompressed `.br` / `.gz` outputs next to the hashed files.
- Integration as the build step of vanilla-deploy.

## License

MIT © 2026 FEABE. See [LICENSE](LICENSE).
