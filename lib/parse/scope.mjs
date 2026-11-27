/**
 * lib/parse/scope.mjs — scope analysis over the AST from parser.mjs: which declaration every identifier refers to.
 * Part of vanilla-build. MIT License.
 *
 *   analyze(ast) -> { root, scopes, bindingOf, free, shorthand, exportShorthand, unsafe, topLevelThis, ... }
 *     bindingOf: Map(Identifier node -> binding) for every declaring and referencing identifier.
 *     binding:   { name, kind, scope, decls: [Identifier], refs: [Identifier], keep, implicit }
 *     free:      Map(name -> [Identifier]) — references that resolve to no declaration (globals).
 *     unsafe:    'eval' | 'with' | null — direct eval / with make static resolution unreliable.
 *   renameAllLocals(src, ast, nameFn) -> { code, count } | { skipped } — renames every binding below the top level.
 *
 * Scopes: the root (script or module); 'function' (parameters and the implicit `arguments`); 'body' (a function body,
 * the var scope); 'block'; 'catch'; 'name' (the own name of a function or class expression); 'class'; 'field'
 * (a class field initializer); 'static' (a class static block, a var scope).
 *
 * Rules that keep renaming safe (binding.keep = true means "never rename"):
 *   - a parameter's default value cannot see the body's declarations (separate 'function' and 'body' scopes);
 *     a body `var` with a parameter's name is the parameter binding;
 *   - Annex B (sloppy mode): a function declared in a block keeps its name, and so do same-named bindings outside it;
 *   - `catch (e) { var e = 1 }` writes the catch parameter: both keep their names;
 *   - the implicit `arguments` binding is never renamed.
 */
import { forEachChild } from './walk.mjs';
import { Editor } from '../edit.mjs';

export class Scope {
  constructor(kind, parent, node) {
    this.kind = kind;
    this.parent = parent;
    this.node = node;
    this.vars = new Map();
    this.children = [];
    this.strict = parent ? parent.strict : false;
    if (parent) parent.children.push(this);
  }
  get isVarScope() { return this.kind === 'script' || this.kind === 'module' || this.kind === 'body' || this.kind === 'static'; }
  get isRoot() { return this.kind === 'script' || this.kind === 'module'; }
  // the scope that `this` belongs to: function (non-arrow), class field / static block, or the root
  get isThisBoundary() {
    return this.isRoot || this.kind === 'field' || this.kind === 'static' || (this.kind === 'function' && !this.node.__arrow);
  }
}

function hasUseStrict(body) {
  for (const s of body) {
    if (s.type !== 'ExpressionStatement' || s.directive === undefined) return false;
    if (s.directive === 'use strict') return true;
  }
  return false;
}
function hasSimpleParams(params) { return params.every((p) => p.type === 'Identifier'); }

export function analyze(ast) {
  const isModule = ast.sourceType === 'module';
  const root = new Scope(isModule ? 'module' : 'script', null, ast);
  root.strict = isModule || hasUseStrict(ast.body);
  const scopes = [root];
  const bindingOf = new Map();
  const free = new Map();
  const shorthand = new Set();
  const exportShorthand = new Set();
  const pending = [];          // { id, scope }
  const evalCalls = [];        // Identifier callee nodes named eval
  const topLevelThis = [];     // ThisExpression nodes whose `this` is the root's
  const blockFunctions = [];   // bindings of functions declared in blocks in sloppy mode
  let unsafe = null;
  let hasTopLevelAwait = false;

  function newScope(kind, parent, node) { const s = new Scope(kind, parent, node); scopes.push(s); return s; }
  function varScopeOf(s) { while (!s.isVarScope) s = s.parent; return s; }
  function thisScopeOf(s) { while (!s.isThisBoundary) s = s.parent; return s; }
  function functionScopeOf(s) { while (s && !(s.kind === 'function' && !s.node.__arrow) && !s.isRoot) s = s.parent; return s; }
  // no function (arrow included), field or static block between s and the root
  function atTopLevel(s) { while (s && s.kind !== 'function' && s.kind !== 'field' && s.kind !== 'static' && !s.isRoot) s = s.parent; return !!s && s.isRoot; }

  function bindingIn(scope, name, kind) {
    let b = scope.vars.get(name);
    if (!b) {
      b = { name, kind, scope, decls: [], refs: [], keep: false, implicit: false, declNodes: [] };
      scope.vars.set(name, b);
    }
    return b;
  }
  function declare(id, scope, kind, declNode) {
    const b = bindingIn(scope, id.name, kind);
    b.decls.push(id);
    if (declNode) b.declNodes.push(declNode);
    bindingOf.set(id, b);
    return b;
  }
  // var-like declarations hoist to the var scope; a body var named like a parameter is that parameter.
  function declareVar(id, scope, kind, declNode) {
    const target = varScopeOf(scope);
    for (let s = scope; s !== target; s = s.parent) {
      if (s.kind === 'catch' && s.vars.has(id.name)) {
        const c = s.vars.get(id.name);
        c.keep = true;
        const b = declareVar0(id, target, kind, declNode);
        b.keep = true;
        return b;
      }
    }
    return declareVar0(id, target, kind, declNode);
  }
  function declareVar0(id, target, kind, declNode) {
    if (target.kind === 'body' && target.parent.kind === 'function' && target.parent.vars.has(id.name)) {
      const p = target.parent.vars.get(id.name);
      if (p.kind === 'param') return declare(id, target.parent, 'param', declNode);
    }
    return declare(id, target, kind, declNode);
  }
  function ref(id, scope) { pending.push({ id, scope }); }

  // ---- patterns
  // mode: 'var' | 'let' | 'const' | 'param' | 'catch' | 'assign'
  function pattern(node, scope, mode, declNode) {
    switch (node.type) {
      case 'Identifier':
        if (mode === 'assign') ref(node, scope);
        else if (mode === 'var') declareVar(node, scope, 'var', declNode);
        else declare(node, scope, mode, declNode);
        return;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') { pattern(p.argument, scope, mode, declNode); continue; }
          if (p.computed) expr(p.key, scope);
          if (p.shorthand) {
            const v = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
            if (v.type === 'Identifier') shorthand.add(v);
          }
          pattern(p.value, scope, mode, declNode);
        }
        return;
      case 'ArrayPattern':
        for (const e of node.elements) if (e) pattern(e, scope, mode, declNode);
        return;
      case 'RestElement': pattern(node.argument, scope, mode, declNode); return;
      case 'AssignmentPattern':
        pattern(node.left, scope, mode, declNode);
        expr(node.right, scope);
        return;
      case 'MemberExpression':
        expr(node, scope);
        return;
      default:
        // invalid targets that V8 would reject (e.g. a call): visit as an expression
        expr(node, scope);
    }
  }

  // ---- functions and classes
  function fn(node, scope) {
    let outer = scope;
    if (node.type === 'FunctionExpression' && node.id) {
      outer = newScope('name', scope, node);
      declare(node.id, outer, 'name', node);
    }
    if (node.type === 'ArrowFunctionExpression') node.__arrow = true;
    const fs = newScope('function', outer, node);
    const body = node.body;
    if (body.type === 'BlockStatement' && hasUseStrict(body.body)) fs.strict = true;
    for (const p of node.params) pattern(p, fs, 'param', node);
    if (body.type === 'BlockStatement') {
      const bs = newScope('body', fs, body);
      // with simple parameters the body var scope is the parameter scope; keep them apart anyway (merge on same name)
      void hasSimpleParams;
      statements(body.body, bs);
    } else expr(body, fs);
  }

  function cls(node, scope) {
    if (node.type === 'ClassDeclaration' && node.id) declare(node.id, scope, 'class', node);
    const cs = newScope('class', scope, node);
    cs.strict = true;
    if (node.type === 'ClassExpression' && node.id) declare(node.id, cs, 'name', node);
    if (node.superClass) expr(node.superClass, cs);
    for (const m of node.body.body) {
      if (m.type === 'StaticBlock') {
        const ss = newScope('static', cs, m);
        statements(m.body, ss);
        continue;
      }
      if (m.computed) expr(m.key, cs);
      if (m.type === 'MethodDefinition') fn(m.value, cs);
      else if (m.value) {
        const f = newScope('field', cs, m);
        expr(m.value, f);
      }
    }
  }

  // ---- statements
  function statements(list, scope) { for (const s of list) stmt(s, scope); }

  function blockFunction(node, scope) {
    // A function declared directly in a function body / root is var-like; in a block it is block scoped.
    if (scope.isVarScope) { declareVar(node.id, scope, 'function', node); return; }
    const b = declare(node.id, scope, 'function', node);
    if (!scope.strict) { b.keep = true; blockFunctions.push(b); }
  }

  function stmt(node, scope) {
    switch (node.type) {
      case 'ExpressionStatement': expr(node.expression, scope); return;
      case 'BlockStatement': { const b = newScope('block', scope, node); statements(node.body, b); return; }
      case 'EmptyStatement': case 'DebuggerStatement': return;
      case 'WithStatement': unsafe = unsafe || 'with'; expr(node.object, scope); stmt(node.body, scope); return;
      case 'ReturnStatement': case 'ThrowStatement': if (node.argument) expr(node.argument, scope); return;
      case 'LabeledStatement': stmt(node.body, scope); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'IfStatement':
        expr(node.test, scope);
        sub(node.consequent, scope);
        if (node.alternate) sub(node.alternate, scope);
        return;
      case 'SwitchStatement': {
        expr(node.discriminant, scope);
        const b = newScope('block', scope, node);
        for (const c of node.cases) { if (c.test) expr(c.test, b); statements(c.consequent, b); }
        return;
      }
      case 'TryStatement': {
        stmt(node.block, scope);
        if (node.handler) {
          const cs = newScope('catch', scope, node.handler);
          if (node.handler.param) pattern(node.handler.param, cs, 'catch', node.handler);
          const b = newScope('block', cs, node.handler.body);
          statements(node.handler.body.body, b);
        }
        if (node.finalizer) stmt(node.finalizer, scope);
        return;
      }
      case 'WhileStatement': expr(node.test, scope); sub(node.body, scope); return;
      case 'DoWhileStatement': sub(node.body, scope); expr(node.test, scope); return;
      case 'ForStatement': {
        const b = newScope('block', scope, node);
        if (node.init) { if (node.init.type === 'VariableDeclaration') decl(node.init, b); else expr(node.init, b); }
        if (node.test) expr(node.test, b);
        if (node.update) expr(node.update, b);
        sub(node.body, b);
        return;
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const b = newScope('block', scope, node);
        if (node.left.type === 'VariableDeclaration') decl(node.left, b);
        else pattern(node.left, b, 'assign');
        expr(node.right, b);
        if (node.type === 'ForOfStatement' && node.await && atTopLevel(scope)) hasTopLevelAwait = true;
        sub(node.body, b);
        return;
      }
      case 'FunctionDeclaration':
        if (node.id) blockFunction(node, scope);
        fn(node, scope);
        return;
      case 'ClassDeclaration': cls(node, scope); return;
      case 'VariableDeclaration': decl(node, scope); return;
      case 'ImportDeclaration':
        for (const s of node.specifiers) declare(s.local, scope, 'import', s);
        return;
      case 'ExportNamedDeclaration':
        if (node.declaration) stmt(node.declaration, scope);
        else if (!node.source) {
          for (const s of node.specifiers) {
            if (s.local.type !== 'Identifier') continue;
            if (s.local.start === s.exported.start) exportShorthand.add(s.local);
            ref(s.local, scope);
          }
        }
        return;
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if (d.type === 'FunctionDeclaration') { if (d.id) blockFunction(d, scope); fn(d, scope); }
        else if (d.type === 'ClassDeclaration') cls(d, scope);
        else expr(d, scope);
        return;
      }
      case 'ExportAllDeclaration': return;
      default: throw new Error('scope: unexpected statement ' + node.type);
    }
  }
  // The body of if / loops / labels: a declaration there gets its own block scope.
  function sub(node, scope) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || (node.type === 'VariableDeclaration' && node.kind !== 'var')) {
      const b = newScope('block', scope, node);
      stmt(node, b);
    } else stmt(node, scope);
  }
  function decl(node, scope) {
    for (const d of node.declarations) {
      pattern(d.id, scope, node.kind, node);
      if (d.init) expr(d.init, scope);
    }
  }

  // ---- expressions
  function expr(node, scope) {
    switch (node.type) {
      case 'Identifier': ref(node, scope); return;
      case 'Literal': case 'Super': case 'PrivateIdentifier': case 'MetaProperty': return;
      case 'ThisExpression':
        if (thisScopeOf(scope).isRoot) topLevelThis.push(node);
        return;
      case 'TemplateLiteral': for (const e of node.expressions) expr(e, scope); return;
      case 'TaggedTemplateExpression': expr(node.tag, scope); expr(node.quasi, scope); return;
      case 'ArrayExpression': for (const e of node.elements) if (e) expr(e, scope); return;
      case 'ObjectExpression':
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') { expr(p.argument, scope); continue; }
          if (p.computed) expr(p.key, scope);
          if (p.shorthand && p.value.type === 'Identifier') shorthand.add(p.value);
          if (p.value.type === 'FunctionExpression' && (p.method || p.kind !== 'init')) fn(p.value, scope);
          else if (p.value.type === 'AssignmentPattern') { if (p.shorthand) shorthand.add(p.value.left); pattern(p.value, scope, 'assign'); }
          else expr(p.value, scope);
        }
        return;
      case 'SpreadElement': expr(node.argument, scope); return;
      case 'FunctionExpression': case 'ArrowFunctionExpression': fn(node, scope); return;
      case 'ClassExpression': cls(node, scope); return;
      case 'MemberExpression':
        expr(node.object, scope);
        if (node.computed) expr(node.property, scope);
        return;
      case 'ChainExpression': expr(node.expression, scope); return;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval') evalCalls.push({ id: node.callee, scope });
        expr(node.callee, scope);
        for (const a of node.arguments) expr(a, scope);
        return;
      case 'NewExpression': expr(node.callee, scope); for (const a of node.arguments) expr(a, scope); return;
      case 'UpdateExpression': case 'UnaryExpression': expr(node.argument, scope); return;
      case 'AwaitExpression':
        if (atTopLevel(scope) && isModule) hasTopLevelAwait = true;
        expr(node.argument, scope);
        return;
      case 'YieldExpression': if (node.argument) expr(node.argument, scope); return;
      case 'BinaryExpression': case 'LogicalExpression': expr(node.left, scope); expr(node.right, scope); return;
      case 'ConditionalExpression': expr(node.test, scope); expr(node.consequent, scope); expr(node.alternate, scope); return;
      case 'AssignmentExpression':
        if (node.operator === '=') pattern(node.left, scope, 'assign'); else expr(node.left, scope);
        expr(node.right, scope);
        return;
      case 'SequenceExpression': for (const e of node.expressions) expr(e, scope); return;
      case 'ImportExpression': expr(node.source, scope); if (node.options) expr(node.options, scope); return;
      case 'ObjectPattern': case 'ArrayPattern': case 'AssignmentPattern': case 'RestElement':
        pattern(node, scope, 'assign');
        return;
      default: throw new Error('scope: unexpected expression ' + node.type);
    }
  }

  statements(ast.body, root);

  // Resolve references (after the whole program: var and function declarations are hoisted).
  for (const { id, scope } of pending) {
    let b = null;
    for (let s = scope; s; s = s.parent) {
      const c = s.vars.get(id.name);
      if (c) { b = c; break; }
      if (id.name === 'arguments' && s.kind === 'function' && !s.node.__arrow) {
        b = bindingIn(s, 'arguments', 'arguments');
        b.implicit = true;
        b.keep = true;
        break;
      }
    }
    if (b) { b.refs.push(id); bindingOf.set(id, b); }
    else {
      if (!free.has(id.name)) free.set(id.name, []);
      free.get(id.name).push(id);
    }
  }
  for (const e of evalCalls) if (!bindingOf.has(e.id)) unsafe = unsafe || 'eval';
  // Annex B: a sloppy block function also writes a same-named variable outside the block.
  for (const b of blockFunctions) {
    const stop = varScopeOf(b.scope);
    for (let s = b.scope.parent; s; s = s.parent) {
      const c = s.vars.get(b.name);
      if (c) c.keep = true;
      if (s === stop) break;
    }
  }
  return { root, scopes, bindingOf, free, shorthand, exportShorthand, unsafe, topLevelThis, hasTopLevelAwait };
}

/** Every identifier name that appears anywhere in the tree (declarations, references, property names, labels). */
export function allNames(ast) {
  const names = new Set();
  (function visit(n) {
    if (n.type === 'Identifier' || n.type === 'PrivateIdentifier') names.add(n.name);
    forEachChild(n, visit);
  })(ast);
  return names;
}

/** Replacement text for one occurrence of a renamed binding. */
export function occurrenceText(src, id, newName, A) {
  if (A.shorthand.has(id)) return src.slice(id.start, id.end) + ': ' + newName;
  if (A.exportShorthand.has(id)) return newName + ' as ' + src.slice(id.start, id.end);
  return newName;
}

/**
 * Renames every binding below the top level to nameFn(binding, index) (made unique against every name in the
 * program). Returns { code, count, analysis } or { skipped: 'eval' | 'with' }.
 */
export function renameAllLocals(src, ast, nameFn, options = {}) {
  const A = options.analysis || analyze(ast);
  if (A.unsafe) return { skipped: A.unsafe };
  const used = allNames(ast);
  for (const n of A.free.keys()) used.add(n);
  const ed = new Editor(src);
  let count = 0;
  for (const s of A.scopes) {
    if (s.isRoot) continue;
    for (const b of s.vars.values()) {
      if (b.keep || b.implicit) continue;
      if (options.filter && !options.filter(b)) continue;
      let nn = nameFn(b, count);
      while (used.has(nn)) nn += '_';
      used.add(nn);
      b.newName = nn;
      count++;
      for (const id of b.decls) ed.overwrite(id.start, id.end, occurrenceText(src, id, nn, A));
      for (const id of b.refs) ed.overwrite(id.start, id.end, occurrenceText(src, id, nn, A));
    }
  }
  return { code: ed.toString(), count, analysis: A };
}
