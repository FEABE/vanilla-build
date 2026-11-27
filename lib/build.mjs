/**
 * lib/build.mjs — the build pipeline: HTML pages in, a deployable folder out.
 * Part of vanilla-build. MIT License.
 *
 *   build(config, { cwd }) -> { outputs, manifest, warnings, ms }
 *   watch(config, { cwd, onBuild, onError, debounce = 100 }) -> { close() }
 *   loadConfig(file) -> config (the default export of vanilla-build.config.mjs; may be a function)
 *
 * Steps: read every HTML page under root; each local <script src> becomes a bundle (type="module" -> esm, classic
 * -> iife), each <link rel="stylesheet" href> a CSS build (@import inlined, minified), each <img src> / other
 * <link href> an asset. Outputs keep the source folder layout and get content-hashed names (app.3f2a1b4c.js);
 * the pages are rewritten to point at them (optionally with integrity="sha384-..."); manifest.json maps every
 * source path to its output. All other files under root are copied as they are (the sources that went into a
 * bundle or a stylesheet are not), then publicDir is copied over the result.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { bundle } from './bundle.mjs';
import { minify } from './minify.mjs';
import { inlineImports, minifyCss } from './css.mjs';
import { scanHtml, rewriteHtml, isLocalRef } from './html.mjs';
import { isTypeScript } from './ts.mjs';

export const DEFAULTS = {
  root: '.',
  outDir: 'dist',
  html: null,            // list of pages (relative to root); default: every .html under root
  entries: [],           // extra scripts without a page: 'src/worker.js' or { entry, format, name }
  minify: true,
  hash: true,
  integrity: false,
  clean: true,
  publicDir: null,
  external: [],
  globals: {},
  importMeta: 'error',
  obfuscate: false,      // experimental: needs experimentalObfuscate: true
  experimentalObfuscate: false,
};

const posix = (p) => p.split(path.sep).join('/');
function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** Throws unless outDir is a folder that is safe to empty and write. */
export function checkOutDir(outDir, root, cwd) {
  if (path.parse(outDir).root === outDir) throw new Error('outDir must not be a filesystem root: ' + outDir);
  if (isInside(root, outDir)) throw new Error('outDir must not be the source root or contain it (' + posix(path.relative(cwd, outDir) || '.') + ')');
  if (isInside(cwd, outDir)) throw new Error('outDir must not be the working directory or contain it');
  if (fs.existsSync(path.join(outDir, '.git'))) throw new Error('outDir contains a .git folder; refusing to clean it');
}

function walk(dir, skip, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || skip.some((s) => isInside(p, s))) continue;
      walk(p, skip, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest();

export async function loadConfig(file) {
  const mod = await import(pathToFileURL(path.resolve(file)).href + '?t=' + Date.now());
  const c = mod.default;
  return typeof c === 'function' ? await c() : c;
}

export async function build(userConfig = {}, { cwd = process.cwd() } = {}) {
  const t0 = Date.now();
  const cfg = { ...DEFAULTS, ...userConfig };
  const root = path.resolve(cwd, cfg.root);
  const outDir = path.resolve(cwd, cfg.outDir);
  const rootRel = (p) => posix(path.relative(root, p));
  checkOutDir(outDir, root, cwd);
  if (cfg.obfuscate && !cfg.experimentalObfuscate) {
    throw new Error('obfuscation is experimental: enable it with --experimental-obfuscate (experimentalObfuscate: true); read the README section first');
  }
  const obf = cfg.obfuscate ? await import('./obfuscate.mjs') : null;
  if (cfg.clean) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const skip = [outDir];
  if (cfg.publicDir) skip.push(path.resolve(cwd, cfg.publicDir));
  const files = walk(root, skip);
  const pages = cfg.html ? cfg.html.map((h) => path.resolve(root, h)) : files.filter((f) => /\.html?$/i.test(f));
  const warnings = [];
  const jobs = new Map();        // source file -> { kind, format, name, refs: [] }
  const addJob = (file, kind, extra = {}) => {
    const j = jobs.get(file);
    if (j) {
      if (j.kind !== kind) throw new Error(rootRel(file) + ' is used both as ' + j.kind + ' and as ' + kind);
      if (kind === 'js' && extra.format && j.format !== extra.format) throw new Error(rootRel(file) + ' is loaded both as a module and as a classic script');
      return j;
    }
    const job = { file, kind, ...extra };
    jobs.set(file, job);
    return job;
  };
  const splitUrl = (u) => { const m = /^([^?#]*)(.*)$/.exec(u); return [m[1], m[2]]; };
  const targetOf = (page, url) => {
    const [p] = splitUrl(url);
    let file;
    try { file = p.startsWith('/') ? path.join(root, decodeURIComponent(p)) : path.resolve(path.dirname(page), decodeURIComponent(p)); } catch { return null; }
    return fs.existsSync(file) && fs.statSync(file).isFile() && isInside(file, root) ? file : null;
  };

  const pageRefs = new Map();
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const refs = scanHtml(html).filter((r) => isLocalRef(r.value));
    pageRefs.set(page, html);
    for (const r of refs) {
      const file = targetOf(page, r.value);
      if (!file) { warnings.push(rootRel(page) + ': ' + r.value + ' not found under root (left as is)'); continue; }
      if (r.tag === 'script') addJob(file, 'js', { format: (r.attrs.type || '').toLowerCase() === 'module' ? 'esm' : 'iife' });
      else if (r.tag === 'link' && /(^|\s)stylesheet(\s|$)/i.test(r.attrs.rel || '')) addJob(file, 'css');
      else if (r.tag === 'link' && /(^|\s)modulepreload(\s|$)/i.test(r.attrs.rel || '')) addJob(file, 'js', { format: 'esm' });
      else addJob(file, 'asset');
    }
  }
  for (const e of cfg.entries) {
    const spec = typeof e === 'string' ? { entry: e } : e;
    addJob(path.resolve(root, spec.entry), 'js', { format: spec.format || 'esm', name: spec.name });
  }

  const consumed = new Set(pages);
  const outputs = [];
  const manifest = {};
  function emit(job, bytes) {
    const relSrc = rootRel(job.file);
    const dir = path.posix.dirname(relSrc);
    const base = path.posix.basename(relSrc);
    const ext = job.kind === 'js' ? '.js' : job.kind === 'css' ? '.css' : path.posix.extname(base);
    const stem = base.slice(0, base.length - path.posix.extname(base).length);
    let name = stem + ext;
    if (cfg.hash) name = stem + '.' + sha('sha256', bytes).toString('hex').slice(0, 8) + ext;
    const relOut = dir === '.' ? name : dir + '/' + name;
    const dest = path.join(outDir, relOut);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    job.out = relOut;
    job.integrity = 'sha384-' + sha('sha384', bytes).toString('base64');
    manifest[relSrc] = relOut;
    outputs.push({ source: relSrc, file: relOut, bytes: bytes.length, kind: job.kind });
  }

  for (const job of jobs.values()) {
    if (job.kind === 'js') {
      const r = bundle({ entry: job.file, format: job.format, name: job.name, root, external: cfg.external, globals: cfg.globals, importMeta: cfg.importMeta });
      warnings.push(...r.warnings);
      for (const f of r.files) consumed.add(f);
      let code = r.code;
      if (obf) {
        const opts = typeof cfg.obfuscate === 'object' ? cfg.obfuscate : {};
        code = obf.obfuscate(code, { ...opts, sourceType: job.format === 'esm' ? 'module' : 'script' }).code;
      }
      if (cfg.minify) code = minify(code).code + '\n';
      emit(job, Buffer.from(code));
    } else if (job.kind === 'css') {
      const r = inlineImports(job.file, { root });
      warnings.push(...r.warnings);
      for (const f of r.files) consumed.add(f);
      emit(job, Buffer.from((cfg.minify ? minifyCss(r.css) : r.css) + '\n'));
    } else {
      emit(job, fs.readFileSync(job.file));
      // the original stays too: stylesheets may refer to it by its plain name
    }
  }

  for (const [page, html] of pageRefs) {
    const pageDir = path.posix.dirname(rootRel(page));
    const out = rewriteHtml(html, (r) => {
      if (!isLocalRef(r.value)) return null;
      const file = targetOf(page, r.value);
      const job = file && jobs.get(file);
      if (!job || !job.out) return null;
      const [p, suffix] = splitUrl(r.value);
      let url = p.startsWith('/') ? '/' + job.out : path.posix.relative(pageDir, job.out);
      if (p.startsWith('./') && !url.startsWith('.')) url = './' + url;
      const wantSri = cfg.integrity && (r.tag === 'script' || (r.tag === 'link' && job.kind !== 'asset'));
      return { url: url + suffix, integrity: wantSri ? job.integrity : null };
    });
    const dest = path.join(outDir, rootRel(page));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    outputs.push({ source: rootRel(page), file: rootRel(page), bytes: Buffer.byteLength(out), kind: 'html' });
  }

  for (const f of files) {
    if (consumed.has(f)) continue;
    if (/\.html?$/i.test(f) && !cfg.html) continue;
    if (isTypeScript(f)) continue;   // a TypeScript file that is not part of any bundle has no use in the output
    const dest = path.join(outDir, rootRel(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
    outputs.push({ source: rootRel(f), file: rootRel(f), bytes: fs.statSync(f).size, kind: 'copy' });
  }
  if (cfg.publicDir) {
    const pub = path.resolve(cwd, cfg.publicDir);
    for (const f of walk(pub, [outDir])) {
      const rel = posix(path.relative(pub, f));
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      outputs.push({ source: posix(path.relative(cwd, f)), file: rel, bytes: fs.statSync(f).size, kind: 'public' });
    }
  }
  const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(sortedManifest, null, 2) + '\n');
  return { outputs, manifest: sortedManifest, warnings, ms: Date.now() - t0, outDir };
}

/** Builds once, then again (debounced) whenever a file under root changes. */
export function watch(userConfig = {}, { cwd = process.cwd(), onBuild = () => {}, onError = (e) => { throw e; }, debounce = 100 } = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const root = path.resolve(cwd, cfg.root);
  const outDir = path.resolve(cwd, cfg.outDir);
  let timer = null, running = false, again = false, closed = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { onBuild(await build(userConfig, { cwd })); } catch (e) { onError(e); }
    running = false;
    if (again && !closed) { again = false; run(); }
  };
  run();
  const watcher = fs.watch(root, { recursive: true }, (event, name) => {
    if (closed || !name) return;
    const file = path.resolve(root, name);
    if (isInside(file, outDir)) return;
    clearTimeout(timer);
    timer = setTimeout(run, debounce);
  });
  return { close() { closed = true; clearTimeout(timer); watcher.close(); } };
}
