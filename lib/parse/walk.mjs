/**
 * lib/parse/walk.mjs — generic traversal of the AST built by parser.mjs.
 * Part of vanilla-build. MIT License.
 */

// Child keys per node type, in source order.
export const KEYS = {
  Program: ['body'],
  ExpressionStatement: ['expression'],
  BlockStatement: ['body'],
  StaticBlock: ['body'],
  EmptyStatement: [],
  DebuggerStatement: [],
  WithStatement: ['object', 'body'],
  ReturnStatement: ['argument'],
  LabeledStatement: ['label', 'body'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  IfStatement: ['test', 'consequent', 'alternate'],
  SwitchStatement: ['discriminant', 'cases'],
  SwitchCase: ['test', 'consequent'],
  ThrowStatement: ['argument'],
  TryStatement: ['block', 'handler', 'finalizer'],
  CatchClause: ['param', 'body'],
  WhileStatement: ['test', 'body'],
  DoWhileStatement: ['body', 'test'],
  ForStatement: ['init', 'test', 'update', 'body'],
  ForInStatement: ['left', 'right', 'body'],
  ForOfStatement: ['left', 'right', 'body'],
  FunctionDeclaration: ['id', 'params', 'body'],
  FunctionExpression: ['id', 'params', 'body'],
  ArrowFunctionExpression: ['params', 'body'],
  VariableDeclaration: ['declarations'],
  VariableDeclarator: ['id', 'init'],
  ClassDeclaration: ['id', 'superClass', 'body'],
  ClassExpression: ['id', 'superClass', 'body'],
  ClassBody: ['body'],
  MethodDefinition: ['key', 'value'],
  PropertyDefinition: ['key', 'value'],
  ImportDeclaration: ['specifiers', 'source', 'attributes'],
  ImportSpecifier: ['imported', 'local'],
  ImportDefaultSpecifier: ['local'],
  ImportNamespaceSpecifier: ['local'],
  ImportAttribute: ['key', 'value'],
  ExportNamedDeclaration: ['declaration', 'specifiers', 'source', 'attributes'],
  ExportSpecifier: ['local', 'exported'],
  ExportDefaultDeclaration: ['declaration'],
  ExportAllDeclaration: ['exported', 'source', 'attributes'],
  Identifier: [],
  PrivateIdentifier: [],
  Literal: [],
  ThisExpression: [],
  Super: [],
  ArrayExpression: ['elements'],
  ObjectExpression: ['properties'],
  Property: ['key', 'value'],
  SpreadElement: ['argument'],
  TemplateLiteral: ['quasis', 'expressions'],
  TemplateElement: [],
  TaggedTemplateExpression: ['tag', 'quasi'],
  MemberExpression: ['object', 'property'],
  ChainExpression: ['expression'],
  CallExpression: ['callee', 'arguments'],
  NewExpression: ['callee', 'arguments'],
  UpdateExpression: ['argument'],
  UnaryExpression: ['argument'],
  BinaryExpression: ['left', 'right'],
  LogicalExpression: ['left', 'right'],
  ConditionalExpression: ['test', 'consequent', 'alternate'],
  AssignmentExpression: ['left', 'right'],
  SequenceExpression: ['expressions'],
  YieldExpression: ['argument'],
  AwaitExpression: ['argument'],
  ImportExpression: ['source', 'options'],
  MetaProperty: ['meta', 'property'],
  ObjectPattern: ['properties'],
  ArrayPattern: ['elements'],
  RestElement: ['argument'],
  AssignmentPattern: ['left', 'right'],
};

/** Calls fn(child, parent, key) for every direct child node. */
export function forEachChild(node, fn) {
  const keys = KEYS[node.type];
  if (!keys) throw new Error('walk: unknown node type ' + node.type);
  for (const k of keys) {
    const v = node[k];
    if (!v) continue;
    if (Array.isArray(v)) { for (const c of v) if (c) fn(c, node, k); }
    else if (typeof v.type === 'string') fn(v, node, k);
  }
}

/**
 * Depth-first walk. enter(node, parent, key) may return false to skip the children; leave(node, parent, key) runs after.
 */
export function walk(node, enter, leave, parent = null, key = null) {
  if (enter && enter(node, parent, key) === false) return;
  forEachChild(node, (c, p, k) => walk(c, enter, leave, p, k));
  if (leave) leave(node, parent, key);
}
