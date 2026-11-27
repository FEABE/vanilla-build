/**
 * lib/bundle.mjs — module bundler: ES modules, CommonJS and JSON in, one iife / esm / cjs file out.
 * Part of vanilla-build. MIT License. Zero dependencies.
 *
 *   bundle({ entry, format = 'esm', name, external = [], globals = {}, root = process.cwd(), importMeta = 'error' })
 *     -> { code, modules: [relative paths in evaluation order], exports: [names], warnings: [string] }
 *
 * How ES modules are combined ("scope hoisting"): every ES module's top-level code is placed, in the order real ESM
 * evaluates it (post-order depth-first over the import requests, in source order, each module once), into ONE scope.
 * An import is replaced by a direct reference to the exporting module's own variable, so
 *   - live bindings are free: an exported `let` changed by its module is seen by every importer;
 *   - circular imports behave like ESM: reading a `let` / `const` / `class` binding before its module has run throws
 *     the same ReferenceError (TDZ), a function declaration is already usable, a `var` is undefined;
 *   - top-level names that collide across modules are renamed (scope-aware: only real references change).
 * `import * as ns` and `export * as ns` get a namespace object: null prototype, sorted keys, toStringTag "Module",
 * not extensible, getters that read the live bindings.
 *
 * CommonJS modules keep their own function wrapper (exports, require, module, __filename, __dirname) and run when
 * first required, like in Node. Sloppy-mode CommonJS stays sloppy (it is emitted outside the strict ESM part),
 * except in esm output, which is strict as a whole (a warning says so).
 *
 * Refused with a clear error (see README "Guarantees"): import() of a module that is not also imported statically,
 * top-level await outside esm output, import.meta (unless importMeta: 'keep' with esm output), assignments to
 * imported bindings, require() of an ES module, bare specifiers that are not external (no node_modules lookup).
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { parse } from './parse/parser.mjs';
import { analyze, allNames, occurrenceText } from './parse/scope.mjs';
import { forEachChild } from './parse/walk.mjs';
import { Editor } from './edit.mjs';
import { isTypeScript, stripTypes } from './ts.mjs';

const TRY_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'];
const BUILTINS = new Set(builtinModules);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
// globals the inserted helper code refers to: user top-level names must not shadow them
const HELPER_GLOBALS = ['Object', 'Promise', 'Symbol', 'JSON', 'require', 'module', 'exports', '__filename', '__dirname', 'globalThis', 'undefined'];

export class BundleError extends Error {
  constructor(message, file) { super(file ? file + ': ' + message : message); this.file = file || null; }
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
const posix = (p) => p.split(path.sep).join('/');
const member = (name) => IDENT_RE.test(name) ? '.' + name : '[' + JSON.stringify(name) + ']';
const exportNameText = (name) => IDENT_RE.test(name) ? name : JSON.stringify(name);

export function resolveFile(base) {
  if (isFile(base)) return base;
  const m = /\.(m|c)?js$/.exec(base);               // TypeScript convention: "./x.js" may name "./x.ts"
  if (m) { const ts = base.slice(0, -m[0].length) + '.' + (m[1] || '') + 'ts'; if (isFile(ts)) return ts; }
  for (const e of TRY_EXT) if (isFile(base + e)) return base + e;
  for (const e of TRY_EXT) { const p = path.join(base, 'index' + e); if (isFile(p)) return p; }
  return null;
}

function moduleSyntax(ast) {
  for (const s of ast.body) {
    if (s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration') return true;
  }
  return false;
}

// One walk per module: parents of identifiers, import() / import.meta / require() nodes.
function collect(ast) {
  const parent = new Map();
  const dynamicImports = [], importMetas = [], calls = [];
  (function visit(n, p) {
    if (n.type === 'Identifier') parent.set(n, p);
    else if (n.type === 'ImportExpression') dynamicImports.push(n);
    else if (n.type === 'MetaProperty' && n.meta.name === 'import') importMetas.push(n);
    else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') calls.push(n);
    forEachChild(n, (c) => visit(c, n));
  })(ast, null);
  return { parent, dynamicImports, importMetas, calls };
}

function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

// Names a CommonJS module exports, found statically (exports.x =, module.exports = { x }, defineProperty).
function cjsExportNames(m, modules) {
  if (m.cjsNames) return m.cjsNames;
  const names = new Set();
  m.cjsNames = names;
  const isExportsObj = (n) => (n.type === 'Identifier' && n.name === 'exports') ||
    (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'module' && n.property.name === 'exports');
  const propName = (n) => n.computed ? staticString(n.property) : n.property.name;
  (function visit(n) {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && isExportsObj(n.left.object)) {
      const k = propName(n.left); if (k) names.add(k);
    }
    if (n.type === 'AssignmentExpression' && isExportsObj(n.left) && n.left.type === 'MemberExpression') {
      if (n.right.type === 'ObjectExpression') {
        for (const p of n.right.properties) if (p.type === 'Property' && !p.computed) names.add(p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
      } else if (n.right.type === 'CallExpression' && n.right.callee.type === 'Identifier' && n.right.callee.name === 'require') {
        const dep = m.requires.get(n.right);
        if (dep && dep.module && dep.module.kind === 'cjs') for (const k of cjsExportNames(dep.module, modules)) names.add(k);
      }
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' &&
      n.callee.object.name === 'Object' && n.callee.property.name === 'defineProperty' && n.arguments.length >= 2 && isExportsObj(n.arguments[0])) {
      const k = staticString(n.arguments[1]); if (k) names.add(k);
    }
    forEachChild(n, visit);
  })(m.ast);
  names.delete('default');
  return names;
}

export function bundle(options) {
  const format = options.format || 'esm';
  if (!['esm', 'iife', 'cjs'].includes(format)) throw new BundleError('format must be "esm", "iife" or "cjs"');
  const root = path.resolve(options.root || process.cwd());
  const external = options.external || [];
  const globals = options.globals || {};
  const importMeta = options.importMeta || 'error';
  const warnings = [];
  const rel = (file) => { const r = posix(path.relative(root, file)); return r.startsWith('..') ? path.basename(file) : r; };

  // ---------------------------------------------------------------- loading
  const modules = new Map();      // abs path -> module
  const externals = new Map();    // specifier -> external module
  let nextId = 0;

  function isExternal(spec) {
    if (spec.startsWith('node:') || BUILTINS.has(spec)) return true;
    return external.some((e) => spec === e || spec.startsWith(e + '/'));
  }
  function externalModule(spec) {
    if (!externals.has(spec)) externals.set(spec, { kind: 'external', id: nextId++, spec, file: spec });
    return externals.get(spec);
  }
  function resolve(spec, from) {
    if (isExternal(spec)) return externalModule(spec);
    if (!(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || path.isAbsolute(spec) || spec === '.' || spec === '..')) {
      throw new BundleError('cannot resolve "' + spec + '": bare specifiers need `external` (node_modules lookup is not supported yet)', rel(from.file));
    }
    // "/x" is relative to the project root (as in a browser); "C:\\x" and other absolute paths are used as they are
    const base = spec.startsWith('/') ? path.join(root, spec) : path.resolve(path.dirname(from.file), spec);
    const file = resolveFile(base);
    if (!file) throw new BundleError('cannot find module "' + spec + '"', rel(from.file));
    return load(file);
  }

  function load(file) {
    if (modules.has(file)) return modules.get(file);
    let src = fs.readFileSync(file, 'utf8');
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const m = { id: nextId++, file, rel: rel(file), src, kind: null, ast: null, A: null, deps: [], requires: new Map(), dynamic: new Map() };
    modules.set(file, m);
    const ext = path.extname(file);
    if (ext === '.json') {
      try { JSON.parse(src); } catch (e) { throw new BundleError('invalid JSON: ' + e.message, m.rel); }
      m.kind = 'json';
      return m;
    }
    if (isTypeScript(file)) m.src = src = stripTypes(src, m.rel);
    const forced = ext === '.mjs' || ext === '.mts' ? 'esm' : ext === '.cjs' || ext === '.cts' ? 'cjs' : null;
    const parseAs = (kind) => parse(src, kind === 'esm' ? { sourceType: 'module' } : { sourceType: 'script', allowReturnOutsideFunction: true });
    try {
      if (forced) { m.kind = forced; m.ast = parseAs(forced); }
      else {
        let ast = null, err = null;
        try { ast = parseAs('esm'); } catch (e) { err = e; }
        if (ast) {
          const A = analyze(ast);
          const esm = moduleSyntax(ast) || A.hasTopLevelAwait || collect(ast).importMetas.length > 0;
          if (!esm && (A.free.has('require') || A.free.has('module') || A.free.has('exports'))) { m.kind = 'cjs'; m.ast = parseAs('cjs'); }
          else { m.kind = 'esm'; m.ast = ast; m.A = A; }
        } else {
          try { m.ast = parseAs('cjs'); m.kind = 'cjs'; } catch { throw err; }
        }
      }
    } catch (e) {
      if (e instanceof BundleError) throw e;
      throw new BundleError(e.message, m.rel);
    }
    m.A = m.A || analyze(m.ast);
    m.info = collect(m.ast);
    if (m.kind === 'esm') {
      for (const s of m.ast.body) {
        if ((s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' || s.type === 'ExportAllDeclaration') && s.source) {
          const dep = resolve(s.source.value, m);
          const typeAttr = (s.attributes || []).find((a) => (a.key.name || a.key.value) === 'type');
          if (dep.kind === 'json' && !(typeAttr && typeAttr.value.value === 'json')) {
            throw new BundleError('importing JSON needs `with { type: \'json\' }` (as in Node and browsers): ' + s.source.value, m.rel);
          }
          if (typeAttr && typeAttr.value.value === 'json' && dep.kind !== 'json' && dep.kind !== 'external') {
            throw new BundleError('`with { type: \'json\' }` on a module that is not JSON: ' + s.source.value, m.rel);
          }
          m.deps.push({ node: s, module: dep });
        }
      }
    } else {
      if (!m.A.free.has('require')) { /* no require calls to rewrite */ }
      for (const c of m.info.calls) {
        if (!m.A.free.has('require') || m.A.bindingOf.has(c.callee)) continue;   // a local `require` is not Node's
        const spec = c.arguments.length === 1 ? staticString(c.arguments[0]) : null;
        if (spec === null) { warnings.push(m.rel + ': require() with a computed argument is left to run time'); continue; }
        const dep = resolve(spec, m);
        if (dep.kind === 'esm') throw new BundleError('require() of the ES module "' + spec + '" is not supported; use import', m.rel);
        m.requires.set(c, { spec, module: dep });
      }
    }
    for (const d of m.info.dynamicImports) {
      const spec = staticString(d.source);
      if (spec === null) { warnings.push(m.rel + ': import() with a computed specifier is left as a native import()'); continue; }
      m.dynamic.set(d, { spec, module: resolve(spec, m) });
    }
    return m;
  }

  const entryFile = resolveFile(path.resolve(options.entry));
  if (!entryFile) throw new BundleError('cannot find entry ' + options.entry);
  const entry = load(entryFile);

  // ---------------------------------------------------------------- evaluation order (ESM post-order DFS)
  const order = [];
  const visited = new Set();
  (function visit(m) {
    if (visited.has(m) || m.kind === 'external' || m.kind === 'json') return;
    visited.add(m);
    if (m.kind === 'esm') for (const d of m.deps) visit(d.module);
    order.push(m);
  })(entry);
  // CommonJS modules reached only through require() run on demand; they still need wrappers.
  const cjsAll = [...modules.values()].filter((m) => m.kind === 'cjs');
  const esmAll = order.filter((m) => m.kind === 'esm');
  const inStatic = new Set([...order, ...cjsAll, ...[...modules.values()].filter((m) => m.kind === 'json')]);
  for (const m of modules.values()) {
    for (const { spec, module } of m.dynamic.values()) {
      if (module.kind !== 'external' && !inStatic.has(module)) {
        throw new BundleError('import("' + spec + '") of a module that is not imported statically is not supported yet (code splitting is on the roadmap); import it statically too, or mark it external', m.rel);
      }
    }
  }
  for (const m of esmAll) {
    if (m.A.hasTopLevelAwait && format !== 'esm') throw new BundleError('top-level await needs format "esm"', m.rel);
    if (m.info.importMetas.length && !(importMeta === 'keep' && format === 'esm')) {
      throw new BundleError('import.meta refers to the original module and is not supported in a bundle (use importMeta: "keep" with esm output to make it refer to the bundle)', m.rel);
    }
    if (m.A.free.has('arguments')) throw new BundleError('top-level `arguments` in an ES module', m.rel);
  }

  // ---------------------------------------------------------------- linking
  for (const m of esmAll) {
    m.localExports = new Map();      // exported name -> local name
    m.indirect = new Map();          // exported name -> { module, importName }
    m.stars = [];
    m.importBindings = new Map();    // local name -> { module, importName }
    const depOf = (node) => m.deps.find((d) => d.node === node).module;
    for (const s of m.ast.body) {
      if (s.type === 'ImportDeclaration') {
        const dep = depOf(s);
        for (const sp of s.specifiers) {
          const importName = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' :
            (sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value);
          m.importBindings.set(sp.local.name, { module: dep, importName });
        }
      } else if (s.type === 'ExportNamedDeclaration') {
        if (s.declaration) {
          const d = s.declaration;
          if (d.type === 'VariableDeclaration') {
            for (const decl of d.declarations) for (const id of patternIds(decl.id)) m.localExports.set(id.name, id.name);
          } else m.localExports.set(d.id.name, d.id.name);
        } else {
          const dep = s.source ? depOf(s) : null;
          for (const sp of s.specifiers) {
            const local = sp.local.type === 'Identifier' ? sp.local.name : sp.local.value;
            const exported = sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value;
            if (dep) m.indirect.set(exported, { module: dep, importName: local });
            else m.localExports.set(exported, local);
          }
        }
      } else if (s.type === 'ExportAllDeclaration') {
        const dep = depOf(s);
        if (s.exported) m.indirect.set(s.exported.type === 'Identifier' ? s.exported.name : s.exported.value, { module: dep, importName: '*' });
        else m.stars.push(dep);
      } else if (s.type === 'ExportDefaultDeclaration') {
        const d = s.declaration;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) m.localExports.set('default', d.id.name);
        else { m.localExports.set('default', null); m.defaultNode = s; }
      }
    }
  }

  function resolveExport(m, name, seen = new Set()) {
    if (m.kind === 'cjs') {
      if (name !== 'default' && !cjsExportNames(m, modules).has(name)) {
        warnings.push(m.rel + ': no static export "' + name + '" found in this CommonJS module (read at run time)');
      }
      return { type: 'cjs', module: m, name };
    }
    if (m.kind === 'json') return name === 'default' ? { type: 'json', module: m } : null;
    if (m.kind === 'external') return { type: 'external', module: m, name };
    const key = m.id + ':' + name;
    if (seen.has(key)) return null;
    seen.add(key);
    if (m.localExports.has(name)) {
      const local = m.localExports.get(name);
      if (local !== null && m.importBindings.has(local)) return resolveImport(m.importBindings.get(local), seen);
      return { type: 'local', module: m, name: local === null ? '*default*' : local };
    }
    if (m.indirect.has(name)) {
      const { module, importName } = m.indirect.get(name);
      if (importName === '*') return namespaceTarget(module);
      return resolveExport(module, importName, seen);
    }
    if (name === 'default') return null;
    let star = null;
    for (const s of m.stars) {
      const r = resolveExport(s, name, seen);
      if (r === 'ambiguous') return r;
      if (r) {
        if (!star) star = r;
        else if (!sameTarget(star, r)) return 'ambiguous';
      }
    }
    return star;
  }
  function resolveImport({ module, importName }, seen) {
    if (importName === '*') return namespaceTarget(module);
    return resolveExport(module, importName, seen);
  }
  function namespaceTarget(module) {
    if (module.kind === 'cjs') return { type: 'cjsns', module };
    if (module.kind === 'json') return { type: 'jsonns', module };
    if (module.kind === 'external') return { type: 'external', module, name: '*' };
    return { type: 'namespace', module };
  }
  function sameTarget(a, b) { return a.type === b.type && a.module === b.module && a.name === b.name; }

  function exportedNames(m, seen = new Set()) {
    if (m.kind === 'cjs') return ['default', ...cjsExportNames(m, modules)];
    if (m.kind === 'json') return ['default'];
    if (m.kind === 'external') return [];
    if (seen.has(m)) return [];
    seen.add(m);
    const names = [...m.localExports.keys(), ...m.indirect.keys()];
    for (const s of m.stars) {
      for (const n of exportedNames(s, seen)) if (n !== 'default' && !names.includes(n)) names.push(n);
    }
    return names;
  }

  // Resolve every import binding now, so missing exports fail the build before anything is emitted.
  for (const m of esmAll) {
    m.importTargets = new Map();
    for (const [local, imp] of m.importBindings) {
      const t = resolveImport(imp);
      const what = imp.importName === '*' ? 'namespace' : '"' + imp.importName + '"';
      if (t === null) throw new BundleError('module "' + imp.module.rel + '" does not provide an export named ' + what, m.rel);
      if (t === 'ambiguous') throw new BundleError('export ' + what + ' of "' + imp.module.rel + '" is ambiguous (two export * provide it)', m.rel);
      m.importTargets.set(local, t);
      const b = m.A.root.vars.get(local);
      for (const id of b.refs) {
        if (m.A.writes.has(id)) throw new BundleError('assignment to the imported binding "' + local + '" (imports are read-only)', m.rel);
      }
    }
  }

  // ---------------------------------------------------------------- names
  const everyName = new Set();
  const used = new Set(HELPER_GLOBALS);
  for (const m of modules.values()) {
    if (!m.ast) continue;
    for (const n of allNames(m.ast)) everyName.add(n);
    for (const n of m.A.free.keys()) used.add(n);
  }
  function fresh(base) {
    base = String(base).replace(/[^\w$]/g, '_');
    if (!/^[A-Za-z_$]/.test(base)) base = '_' + base;
    let name = base;
    for (let i = 1; used.has(name) || everyName.has(name); i++) name = base + '$' + i;
    used.add(name);
    return name;
  }
  const stem = (m) => path.basename(m.file).replace(/\.[^.]*$/, '').replace(/[^\w$]/g, '_') || 'mod';

  for (const m of esmAll) {
    m.finals = new Map();
    for (const [name, b] of m.A.root.vars) {
      if (b.kind === 'import') continue;
      let final = name;
      if (used.has(name)) final = fresh(name); else used.add(name);
      m.finals.set(name, final);
    }
    if (m.localExports.get('default') === null) m.finals.set('*default*', fresh(stem(m) + '_default'));
  }
  // An importer's local scope may declare the exporter's final name: rename the exporter's binding then.
  for (const m of esmAll) {
    for (const [local, t] of m.importTargets) {
      if (t.type !== 'local') continue;
      const b = m.A.root.vars.get(local);
      for (const id of b.refs) {
        const F = t.module.finals.get(t.name);
        for (let s = m.A.scopeOf.get(id); s && !s.isRoot; s = s.parent) {
          if (s.vars.has(F)) { t.module.finals.set(t.name, fresh(t.name)); break; }
        }
      }
    }
  }

  // Helpers and synthetic variables.
  const H = {};
  const helper = (k) => (H[k] = H[k] || fresh('__vb_' + k));
  const nsVar = new Map(), cjsFn = new Map(), cjsExp = new Map(), cjsNs = new Map(), jsonVar = new Map(), jsonNs = new Map(), extVar = new Map();
  const getVar = (map, m, base) => { if (!map.has(m)) map.set(m, fresh(base)); return map.get(m); };
  for (const m of cjsAll) getVar(cjsFn, m, 'require_' + stem(m));
  const nsOf = (m) => getVar(nsVar, m, stem(m) + '_ns');
  const extOf = (m) => getVar(extVar, m, m.spec.replace(/^node:/, '').replace(/[^\w$]/g, '_') + '_ext');

  // Expression text for a resolved target.
  function targetText(t) {
    switch (t.type) {
      case 'local': return t.module.finals.get(t.name);
      case 'namespace': return nsOf(t.module);
      case 'cjs': {
        const v = getVar(cjsExp, t.module, stem(t.module) + '_exports');
        return t.name === 'default' ? v : v + member(t.name);
      }
      case 'cjsns': getVar(cjsExp, t.module, stem(t.module) + '_exports'); helper('cjsNs'); return getVar(cjsNs, t.module, stem(t.module) + '_cjs_ns');
      case 'json': return getVar(jsonVar, t.module, stem(t.module) + '_json');
      case 'jsonns': getVar(jsonVar, t.module, stem(t.module) + '_json'); return getVar(jsonNs, t.module, stem(t.module) + '_json_ns');
      case 'external': {
        const v = extOf(t.module);
        if (t.name === '*') return v;
        if (t.name === 'default') return format === 'esm' ? v + '.default' : helper('default') + '(' + v + ')';
        return v + member(t.name);
      }
    }
    throw new Error('unknown target ' + t.type);
  }
  function dynamicText(module) {
    const dyn = helper('dyn');
    if (module.kind === 'esm') return dyn + '(() => ' + nsOf(module) + ')';
    if (module.kind === 'cjs') return dyn + '(() => ' + helper('cjsNs') + '(' + cjsFn.get(module) + '()))';
    if (module.kind === 'json') return dyn + '(() => ' + targetText({ type: 'jsonns', module }) + ')';
    return null;
  }

  // ---------------------------------------------------------------- transform modules
  function transformEsm(m) {
    const src = m.src;
    const ed = new Editor(src);
    const removed = [];
    const drop = (node) => { ed.overwrite(node.start, node.end, ';'); removed.push([node.start, node.end]); };
    const inRemoved = (id) => removed.some(([a, b]) => id.start >= a && id.end <= b);
    if (m.ast.hashbang) ed.remove(0, m.ast.hashbang.length);
    let after = '';
    for (const s of m.ast.body) {
      if (s.type === 'ImportDeclaration' || s.type === 'ExportAllDeclaration') drop(s);
      else if (s.type === 'ExportNamedDeclaration') {
        if (s.declaration) ed.remove(s.start, s.declaration.start);
        else drop(s);
      } else if (s.type === 'ExportDefaultDeclaration') {
        const d = s.declaration;
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          ed.remove(s.start, d.start);
          if (!d.id) {
            const name = m.finals.get('*default*');
            if (d.type === 'FunctionDeclaration') {
              const mm = /^(async\s+)?function\s*(\*\s*)?/.exec(src.slice(d.start, d.body.start));
              if (!mm) throw new BundleError('cannot read the default-exported function', m.rel);
              ed.insert(d.start + mm[0].length, (/\s$/.test(mm[0]) ? '' : ' ') + name);
            } else ed.insert(d.start + 5, ' ' + name);
            ed.insert(d.end, '\n' + helper('setName') + '(' + name + ');');
          }
        } else {
          const name = m.finals.get('*default*');
          const exprStart = d.parenthesized ? d.parenStart : d.start;
          const exprEnd = d.parenthesized ? d.parenEnd : d.end;
          ed.overwrite(s.start, exprStart, 'const ' + name + ' = ');
          let tail = s.end > exprEnd ? '' : ';';
          const anon = (d.type === 'FunctionExpression' || d.type === 'ClassExpression') ? !d.id : d.type === 'ArrowFunctionExpression';
          if (anon) tail += '\n' + helper('setName') + '(' + name + ');';
          if (tail) ed.insert(exprEnd, tail);
        }
      }
    }
    // own top-level bindings
    for (const [name, b] of m.A.root.vars) {
      if (b.kind === 'import') {
        const t = m.importTargets.get(name);
        const text = targetText(t);
        const plain = IDENT_RE.test(text);
        for (const id of b.refs) {
          if (inRemoved(id)) continue;
          const p = m.info.parent.get(id);
          let rep = text;
          if (!plain && p && ((p.type === 'CallExpression' && p.callee === id) || (p.type === 'TaggedTemplateExpression' && p.tag === id))) rep = '(0, ' + text + ')';
          ed.overwrite(id.start, id.end, occurrenceText(src, id, rep, m.A));
        }
        continue;
      }
      const final = m.finals.get(name);
      if (final === name) continue;
      for (const id of [...b.decls, ...b.refs]) if (!inRemoved(id)) ed.overwrite(id.start, id.end, occurrenceText(src, id, final, m.A));
    }
    for (const d of m.info.dynamicImports) {
      const dep = m.dynamic.get(d);
      if (!dep || dep.module.kind === 'external') continue;
      ed.overwrite(d.start, d.end, dynamicText(dep.module));
    }
    // ASI: the next module's code must not continue this module's last statement
    const last = m.ast.body[m.ast.body.length - 1];
    if (last && !/[;}]$/.test(src.slice(0, last.end)) && !removed.some(([a, b]) => a === last.start && b === last.end)) after = ';';
    return ed.toString() + after;
  }

  function transformCjs(m) {
    const ed = new Editor(m.src);
    if (m.ast.hashbang) ed.remove(0, m.ast.hashbang.length);
    for (const [call, { module }] of m.requires) {
      if (module.kind === 'cjs') ed.overwrite(call.start, call.end, cjsFn.get(module) + '()');
      else if (module.kind === 'json') ed.overwrite(call.start, call.end, targetText({ type: 'json', module }));
    }
    for (const d of m.info.dynamicImports) {
      const dep = m.dynamic.get(d);
      if (!dep || dep.module.kind === 'external') continue;
      ed.overwrite(d.start, d.end, dynamicText(dep.module));
    }
    return ed.toString();
  }

  const esmCode = new Map();
  for (const m of esmAll) esmCode.set(m, transformEsm(m));
  const cjsCode = new Map();
  for (const m of cjsAll) cjsCode.set(m, transformCjs(m));

  // namespace objects needed by the entry's exports
  const entryNeedsNs = format !== 'esm' && (format === 'cjs' || options.name);
  if (entryNeedsNs && entry.kind === 'esm') nsOf(entry);

  // ---------------------------------------------------------------- emit
  function nsPairs(m) {
    const pairs = [];
    for (const n of exportedNames(m).slice().sort()) {
      const t = resolveExport(m, n);
      if (!t || t === 'ambiguous') continue;
      pairs.push('[' + JSON.stringify(n) + ', () => ' + targetText(t) + ']');
    }
    return pairs;
  }
  // entry exports (esm output); computed before the namespaces because they can ask for more of them
  const exportLines = [];
  const exportNames = [];
  if (format === 'esm') {
    if (entry.kind === 'esm') {
      const specs = [];
      let k = 0;
      for (const n of exportedNames(entry)) {
        const t = resolveExport(entry, n);
        if (!t || t === 'ambiguous') continue;
        let text = targetText(t);
        if (!IDENT_RE.test(text)) { const v = fresh('__vb_export' + (k++)); exportLines.push('var ' + v + ' = ' + text + ';'); text = v; }
        specs.push(text === n ? n : text + ' as ' + exportNameText(n));
        exportNames.push(n);
      }
      if (specs.length) exportLines.push('export { ' + specs.join(', ') + ' };');
    } else {
      // like Node: module.exports is the default export, statically found names are named exports
      const v = fresh(stem(entry) + '_exports');
      exportLines.push('var ' + v + ' = ' + cjsFn.get(entry) + '();', 'export default ' + v + ';');
      exportNames.push('default');
      const specs = [];
      for (const n of cjsExportNames(entry, modules)) {
        const nv = fresh(n);
        exportLines.push('var ' + nv + ' = ' + v + member(n) + ';');
        specs.push(nv + ' as ' + exportNameText(n));
        exportNames.push(n);
      }
      if (specs.length) exportLines.push('export { ' + specs.join(', ') + ' };');
    }
  } else exportNames.push(...(entry.kind === 'esm' ? exportedNames(entry).filter((n) => { const t = resolveExport(entry, n); return t && t !== 'ambiguous'; }) : ['default']));

  // Namespace texts can create more namespaces (export * as); compute them until stable.
  const nsDecls = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const m of [...nsVar.keys()]) {
      if (nsDecls.has(m)) continue;
      nsDecls.set(m, 'var ' + nsVar.get(m) + ' = ' + helper('ns') + '([' + nsPairs(m).join(', ') + ']);');
      changed = true;
    }
  }

  // external modules
  const extLines = [];
  for (const [m, v] of extVar) {
    if (format === 'esm') extLines.push('import * as ' + v + ' from ' + JSON.stringify(m.spec) + ';');
    else if (format === 'cjs') extLines.push('var ' + v + ' = require(' + JSON.stringify(m.spec) + ');');
    else {
      if (!Object.prototype.hasOwnProperty.call(globals, m.spec)) throw new BundleError('external "' + m.spec + '" in iife output needs a `globals` entry (e.g. globals: { "' + m.spec + '": "Name" })');
      extLines.push('var ' + v + ' = globalThis' + member(globals[m.spec]) + ';');
    }
  }
  // side-effect-only imports of externals (no bindings) still have to load
  const sideEffectExternals = [];
  for (const m of esmAll) {
    for (const d of m.deps) {
      if (d.module.kind === 'external' && !extVar.has(d.module) && !sideEffectExternals.includes(d.module)) sideEffectExternals.push(d.module);
    }
  }
  for (const m of sideEffectExternals) {
    if (format === 'esm') extLines.push('import ' + JSON.stringify(m.spec) + ';');
    else if (format === 'cjs') extLines.push('require(' + JSON.stringify(m.spec) + ');');
  }

  const jsonLines = [];
  // a "__proto__" key would set the prototype in an object literal, so such JSON goes through JSON.parse
  for (const [m, v] of jsonVar) jsonLines.push('var ' + v + ' = ' + (/"__proto__"\s*:/.test(m.src) ? 'JSON.parse(' + JSON.stringify(m.src.trim()) + ')' : '(' + m.src.trim() + ')') + ';');
  for (const [m, v] of jsonNs) jsonLines.push('var ' + v + ' = ' + helper('ns') + '([["default", () => ' + jsonVar.get(m) + ']]);');

  // CommonJS wrappers
  const cjsLines = [];
  let sloppy = false;
  if (cjsAll.length) {
    const req = format === 'cjs' ? 'require' : 'typeof require === "function" ? require : void 0';
    for (const m of cjsAll) {
      const strict = m.A.root.strict;
      if (!strict) sloppy = true;
      const fname = format === 'cjs' ? '__filename' : JSON.stringify('/' + m.rel);
      const dname = format === 'cjs' ? '__dirname' : JSON.stringify('/' + posix(path.dirname(m.rel)).replace(/^\.$/, ''));
      cjsLines.push('// ' + m.rel + '\nvar ' + cjsFn.get(m) + ' = ' + helper('cjs') + '(function (exports, require, module, __filename, __dirname) {\n' +
        cjsCode.get(m) + '\n}, ' + fname + ', ' + dname + ', ' + req + ');');
    }
    if (sloppy && format === 'esm') warnings.push('sloppy-mode CommonJS modules run in strict mode in esm output');
  }

  // body: namespaces + modules in evaluation order
  const body = [];
  for (const line of nsDecls.values()) body.push(line);
  for (const m of order) {
    if (m.kind === 'esm') body.push('// ' + m.rel + '\n' + esmCode.get(m));
    else if (m.kind === 'cjs' && cjsExp.has(m)) {
      body.push('var ' + cjsExp.get(m) + ' = ' + cjsFn.get(m) + '();' + (cjsNs.has(m) ? '\nvar ' + cjsNs.get(m) + ' = ' + helper('cjsNs') + '(' + cjsExp.get(m) + ');' : ''));
    } else if (m.kind === 'cjs') body.push(cjsFn.get(m) + '();');
  }
  // cjs exports / namespaces that only dynamic import() or helpers asked for
  for (const m of cjsAll) if (!order.includes(m) && cjsExp.has(m)) body.unshift('var ' + cjsExp.get(m) + ' = ' + cjsFn.get(m) + '();');

  const helperCode = [];
  if (H.ns || H.cjsNs) {
    if (!H.ns) helper('ns');
    helperCode.push('function ' + H.ns + '(pairs) {\n  var ns = Object.create(null);\n  pairs.forEach(function (p) { Object.defineProperty(ns, p[0], { enumerable: true, get: p[1] }); });\n' +
      '  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });\n  return Object.preventExtensions(ns);\n}');
  }
  if (H.cjsNs) {
    helperCode.push('function ' + H.cjsNs + '(e) {\n  var pairs = [["default", function () { return e; }]];\n' +
      '  if (e !== null && (typeof e === "object" || typeof e === "function")) Object.keys(e).sort().forEach(function (k) { if (k !== "default") pairs.push([k, function () { return e[k]; }]); });\n' +
      '  pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });\n  return ' + H.ns + '(pairs);\n}');
  }
  if (H.cjs) {
    helperCode.push('function ' + H.cjs + '(fn, filename, dirname, req) {\n  var mod;\n  return function () {\n    if (!mod) {\n      mod = { exports: {} };\n' +
      '      try { fn.call(mod.exports, mod.exports, req, mod, filename, dirname); } catch (e) { mod = void 0; throw e; }\n    }\n    return mod.exports;\n  };\n}');
  }
  if (H.dyn) helperCode.push('function ' + H.dyn + '(get) { return Promise.resolve().then(get); }');
  if (H.setName) {
    helperCode.push('function ' + H.setName + '(f) {\n  var d = Object.getOwnPropertyDescriptor(f, "name");\n' +
      '  if (!d || ("value" in d && !d.writable)) Object.defineProperty(f, "name", { value: "default", configurable: true });\n}');
  }
  if (H.default) helperCode.push('function ' + H.default + '(m) { return m && m[Symbol.toStringTag] === "Module" ? m.default : m; }');

  const outer = [...helperCode, ...extLines, ...jsonLines, ...cjsLines].join('\n');
  const inner = body.join('\n');
  const hashbang = entry.ast && entry.ast.hashbang && format !== 'iife' ? entry.ast.hashbang + '\n' : '';
  const banner = options.banner ? options.banner + '\n' : '';
  let code;
  const entryValue = entry.kind === 'esm' ? (nsVar.has(entry) ? nsVar.get(entry) : null) : cjsFn.get(entry) + '()';
  if (format === 'esm') {
    code = hashbang + banner + [outer, inner, ...exportLines].filter(Boolean).join('\n') + '\n';
  } else {
    const ret = (format === 'cjs' || options.name) && entryValue ? 'return ' + entryValue + ';' : (entry.kind === 'cjs' ? entryValue + ';' : '');
    let fnBody;
    if (sloppy) {
      const strictPart = esmAll.length ? 'return (function () {\n"use strict";\n' + inner + '\n' + ret + '\n})();' : inner + '\n' + ret;
      fnBody = outer + '\n' + strictPart;
    } else fnBody = '"use strict";\n' + [outer, inner, ret].filter(Boolean).join('\n');
    const call = '(function () {\n' + fnBody + '\n})()';
    if (format === 'cjs') code = hashbang + banner + 'module.exports = ' + call + ';\n';
    else code = banner + (options.name ? 'var ' + options.name + ' = ' : '') + call + ';\n';
  }
  return {
    code,
    modules: [...order.map((m) => m.rel), ...cjsAll.filter((m) => !order.includes(m)).map((m) => m.rel), ...[...modules.values()].filter((m) => m.kind === 'json').map((m) => m.rel)],
    files: [...modules.values()].map((m) => m.file),
    exports: exportNames,
    warnings,
  };
}

function patternIds(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p); break;
    case 'ObjectPattern': for (const q of p.properties) patternIds(q.type === 'RestElement' ? q.argument : q.value, out); break;
    case 'ArrayPattern': for (const e of p.elements) patternIds(e, out); break;
    case 'RestElement': patternIds(p.argument, out); break;
    case 'AssignmentPattern': patternIds(p.left, out); break;
  }
  return out;
}
