// The write-path lint. Calls are parsed, not scanned line by line.
// A raw SQL handle is any .sql or ._sql member (lib.sql, lib._sql, this.sql).
// audit-chain.js may use the handle it is given. library.js may call exec on
// the private _sql binding once, inside exec. Everywhere else is a violation.
// The placeholder census is the same spelling grep the bound-parameter tests use.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './vendor/acorn.mjs';

export const EXEC_ALLOW = ['audit-chain.js'];

export const PLACEHOLDER_ALLOW = [
  { file: 'operate.js', max: 3, why: 'directory erasure binds the tenant plus at most a mail and an oid' },
  { file: 'library.js', max: 3, why: 'an invitation list binds at most the sign-in email, the mail claim, and the tenant' },
];

const BUILDER = /\.map\(\s*\(\s*\)\s*=>\s*['"`]\?['"`]\s*\)|['"`]\?['"`]\s*\.repeat\s*\(|\.fill\(\s*['"`]\?['"`]\s*\)|Array\.from\(\s*\{[^}]*\}\s*,\s*\(\s*\)\s*=>\s*['"`]\?['"`]\s*\)/;
const MUTATING = /^(?:insert|update|delete|replace|create|drop|alter|reindex|vacuum)\b/i;

export function stripLineComment(line) {
  return line.replace(/\/\/.*$/, '');
}

export function isMutatingSql(sql) {
  const text = String(sql ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (MUTATING.test(text)) return true;
  return /^with\b/i.test(text) && /\b(insert|update|delete|replace)\b/i.test(text);
}

function unwrap(node) {
  if (node?.type === 'ChainExpression') return unwrap(node.expression);
  return node;
}

function peel(node) {
  node = unwrap(node);
  if (node?.type === 'SequenceExpression') return peel(node.expressions.at(-1));
  return node;
}

function isDirectLibrary(node) {
  node = unwrap(node);
  if (node?.type === 'ThisExpression') return true;
  return node?.type === 'Identifier' && node.name === 'lib';
}

function foldString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map(part => part.value.cooked).join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = foldString(node.left);
    const right = foldString(node.right);
    if (left == null || right == null) return null;
    return left + right;
  }
  return null;
}

function propName(node) {
  node = unwrap(node);
  if (!node || node.type !== 'MemberExpression') return '';
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed) {
    const folded = foldString(node.property);
    if (folded != null) return folded;
  }
  return '';
}

function exemptHandle(file, node) {
  const object = unwrap(node.object);
  if (object?.type !== 'Identifier') return false;
  const name = object.name;
  if (file === 'library-store.js' && name === 'storage') return true;
  if (file === 'sql-bound.js' && (name === 'spec' || name === 'group')) return true;
  return false;
}

function isHandleMember(node, file) {
  node = unwrap(node);
  if (!node || node.type !== 'MemberExpression') return false;
  if (exemptHandle(file, node)) return false;
  const object = unwrap(node.object);
  if (node.computed && foldString(node.property) == null && isDirectLibrary(object)) return true;
  const name = propName(node);
  if (name !== 'sql' && name !== '_sql') return false;
  if (object?.type === 'Identifier' || object?.type === 'ThisExpression') return true;
  return object?.type === 'MemberExpression' && propName(object) === 'storage';
}

function isPrivateExec(node) {
  const callee = unwrap(node?.callee);
  return node?.type === 'CallExpression'
    && callee?.type === 'MemberExpression'
    && !callee.computed
    && propName(callee) === 'exec'
    && unwrap(callee.object)?.type === 'Identifier'
    && unwrap(callee.object).name === '_sql';
}

function isReflectOrValues(node) {
  node = unwrap(node);
  if (node?.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  if (callee?.type !== 'MemberExpression') return false;
  const object = unwrap(callee.object);
  const name = propName(callee);
  if (object?.type !== 'Identifier') return false;
  if (object.name === 'Reflect' && (name === 'get' || name === 'apply')) return true;
  return object.name === 'Object' && (name === 'values' || name === 'entries');
}

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value.type === 'string') out.push(value);
  }
  return out.sort((a, b) => (a.start || 0) - (b.start || 0));
}

function lineOf(node) {
  return node.loc?.start?.line || 1;
}

function push(exec, file, node, text) {
  exec.push({ file, line: lineOf(node), text: String(text || node.type).trim() });
}

function taintPattern(id, file, node, tainted, exec) {
  if (id?.type !== 'ObjectPattern') return;
  for (const prop of id.properties) {
    if (prop?.type !== 'Property') continue;
    const key = prop.computed ? foldString(prop.key) : (prop.key?.name || (typeof prop.key?.value === 'string' ? prop.key.value : ''));
    if (key !== 'sql' && key !== '_sql' && key !== 'exec') continue;
    push(exec, file, node, 'raw handle');
    if (prop.value?.type === 'Identifier') tainted.add(prop.value.name);
  }
}

function walk(node, file, tainted, exec, params) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    for (const param of node.params || []) {
      if (param?.type === 'AssignmentPattern' && param.left?.type === 'ObjectPattern' && isHandleSource(param.right, file, tainted)) {
        push(exec, file, param, 'raw handle');
      }
    }
    const next = new Set(tainted);
    const more = params?.get(node);
    if (more) for (const name of more) next.add(name);
    for (const child of children(node)) walk(child, file, next, exec, params);
    return;
  }
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && (isTaintedInit(node.init, file, tainted) || isPrivateField(node.init))) tainted.add(node.id.name);
  if (node.type === 'VariableDeclarator') taintPattern(node.id, file, node, tainted, exec);
  if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isDirectLibrary(node.init)) {
    for (const prop of node.id.properties) {
      if (prop?.type !== 'Property' || !prop.computed || foldString(prop.key) != null) continue;
      push(exec, file, node, 'raw handle');
      if (prop.value?.type === 'Identifier') tainted.add(prop.value.name);
    }
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && isTaintedInit(node.right, file, tainted)) tainted.add(node.left.name);
  if (isHandleMember(node, file)) push(exec, file, node, 'raw handle');
  if (node.type === 'MemberExpression' && (propName(node) === '_enter' || propName(node) === 'registered')) push(exec, file, node, 'private door');
  if (node.type === 'CallExpression' && isEvalCall(node)) push(exec, file, node, 'raw exec');
  if (node.type === 'CallExpression' && isReflectApplyExec(node, file, tainted)) push(exec, file, node, 'raw exec');
  if (node.type === 'AssignmentExpression' && isWeakMapPrototype(node.right)) push(exec, file, node, 'raw handle');
  if ((node.type === 'NewExpression' || node.type === 'CallExpression') && isFunctionValue(node.callee)) push(exec, file, node, 'raw exec');
  if (node.type === 'CallExpression' && propName(peel(node.callee)) === 'rewriteAudit' && file !== 'subject-rights.js' && file !== 'retention.js') push(exec, file, node, 'audit erasure');
  if (node.type === 'CallExpression' && isRawCall(node, file, tainted) && !(file === 'library.js' && isPrivateExec(node))) push(exec, file, node, 'raw exec');
  if (node.type === 'CallExpression' && passesHandle(node, file, tainted)) push(exec, file, node, 'raw handle');
  for (const child of children(node)) walk(child, file, tainted, exec, params);
}

function passesHandle(node, file, tainted) {
  const callee = unwrap(node.callee);
  const name = callee?.type === 'MemberExpression' ? propName(callee) : '';
  if (name === 'exec' || name === 'call' || name === 'apply' || name === 'bind') return false;
  return (node.arguments || []).some(arg => isHandleSource(arg, file, tainted));
}

function functionsIn(node, out = new Map()) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') out.set(node.id.name, node);
  for (const child of children(node)) functionsIn(child, out);
  return out;
}

function parameterTaint(tree, file) {
  const functions = functionsIn(tree);
  const extra = new Map();
  for (const fn of functions.values()) extra.set(fn, new Set());
  primary = new Set();
  aliases = new Set();
  evalAliases = new Set();
  evalStrings = new Set();
  const see = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isHandleSource(node.init, file, primary)) primary.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isWeakMapPrototype(node.init)) aliases.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isWeakMapPrototype(node.init)) {
      for (const prop of node.id.properties) {
        if (prop?.type === 'Property' && prop.value?.type === 'Identifier' && prop.key?.type === 'Identifier' && prop.key.name === 'get') primary.add(prop.value.name);
      }
    }
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && isWeakMapPrototype(node.right)) aliases.add(node.left.name);
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && isHandleSource(node.right, file, primary)) primary.add(node.left.name);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isEvalValue(node.init)) evalAliases.add(node.id.name);
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && isEvalValue(node.right)) evalAliases.add(node.left.name);
    if (node.type === 'VariableDeclarator') noteEvalBinding(node.id, node.init);
    if (node.type === 'AssignmentExpression') noteEvalBinding(node.left, node.right);
    if (node.type === 'CallExpression' && unwrap(node.callee)?.type === 'Identifier') {
      const fn = functions.get(unwrap(node.callee).name);
      if (fn) (node.arguments || []).forEach((arg, index) => {
        if (!isHandleSource(arg, file, primary)) return;
        const param = fn.params[index];
        if (param?.type === 'Identifier') extra.get(fn).add(param.name);
      });
    }
    for (const child of children(node)) see(child);
  };
  see(tree);
  for (const fn of functions.values()) {
    for (const param of fn.params || []) {
      if (param?.type === 'AssignmentPattern' && param.left?.type === 'Identifier' && isHandleSource(param.right, file, primary)) extra.get(fn).add(param.left.name);
    }
  }
  return extra;
}

function isEvalValue(node) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === 'Identifier' && (node.name === 'eval' || evalAliases.has(node.name))) return true;
  return node.type === 'MemberExpression' && propName(node) === 'eval';
}

function noteEvalBinding(id, init) {
  if (!id) return;
  if (id.type === 'Identifier' && foldString(init) === 'eval') evalStrings.add(id.name);
  if (id.type === 'ObjectPattern') {
    for (const prop of id.properties || []) {
      if (prop?.type !== 'Property' || prop.value?.type !== 'Identifier') continue;
      const key = prop.key?.type === 'Identifier' ? prop.key.name : (prop.key?.type === 'Literal' ? String(prop.key.value) : '');
      if (key === 'eval') evalAliases.add(prop.value.name);
    }
  }
  if (id.type === 'ArrayPattern' && init?.type === 'ArrayExpression') {
    const left = id.elements || [];
    const right = init.elements || [];
    for (let n = 0; n < left.length; n++) {
      if (left[n]?.type === 'Identifier' && isEvalValue(right[n])) evalAliases.add(left[n].name);
    }
  }
}

function isIndexEval(node) {
  if (node?.type !== 'MemberExpression' || !node.computed) return false;
  const list = unwrap(node.object);
  if (list?.type !== 'ArrayExpression') return false;
  const index = node.property?.type === 'Literal' ? node.property.value : null;
  if (typeof index !== 'number') return false;
  return isEvalValue(list.elements[index]);
}

function isObjectEval(node) {
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  const obj = unwrap(node.object);
  if (obj?.type !== 'ObjectExpression') return false;
  const key = propName(node);
  for (const prop of obj.properties || []) {
    if (prop?.type !== 'Property') continue;
    const name = prop.key?.type === 'Identifier' ? prop.key.name : '';
    if (name === key && isEvalValue(prop.value)) return true;
  }
  return false;
}

function isReflectApplyEval(node) {
  const callee = unwrap(node.callee);
  if (propName(callee) !== 'apply' || unwrap(callee?.object)?.name !== 'Reflect') return false;
  return isEvalValue((node.arguments || [])[0]);
}

function isMapEval(node) {
  if (propName(peel(node.callee)) !== 'map') return false;
  return (node.arguments || []).some((arg) => isEvalValue(arg));
}

function isFunctionValue(node) {
  node = peel(node);
  if (node?.type === 'Identifier' && node.name === 'Function') return true;
  return node?.type === 'MemberExpression' && propName(node) === 'Function';
}

function isEvalCall(node) {
  const callee = peel(node.callee);
  if (callee?.type === 'Identifier' && (callee.name === 'eval' || evalAliases.has(callee.name))) return true;
  if (isIndexEval(callee) || isObjectEval(callee) || isReflectApplyEval(node) || isMapEval(node)) return true;
  if (callee?.type === 'MemberExpression' && callee.computed && callee.property?.type === 'Identifier' && evalStrings.has(callee.property.name)) return true;
  return callee?.type === 'MemberExpression' && propName(callee) === 'eval';
}

function isReflectApplyExec(node, file, tainted) {
  const callee = unwrap(node.callee);
  if (callee?.type !== 'MemberExpression' || unwrap(callee.object)?.name !== 'Reflect' || propName(callee) !== 'apply') return false;
  return (node.arguments || []).some((arg) => {
    const value = unwrap(arg);
    if (value?.type === 'MemberExpression' && propName(value) === 'exec') return true;
    return isHandleLike(value, file, tainted);
  });
}

function isWeakMapPrototype(node) {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && unwrap(node.object)?.name === 'WeakMap' && propName(node) === 'prototype';
}

function isPrivateField(node) {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && node.property?.type === 'PrivateIdentifier' && (node.property.name === '#sql' || node.property.name === 'sql');
}

function isWeakMapGet(node) {
  node = unwrap(node);
  if (node?.type !== 'MemberExpression' || propName(node) !== 'get') return false;
  const proto = unwrap(node.object);
  if (proto?.type === 'Identifier' && aliases.has(proto.name)) return true;
  return isWeakMapPrototype(proto);
}

// Names assigned from rawSql, HANDLES, or WeakMap.prototype.get. Not every tainted binding:
// Object.entries is tainted for the exec check and is not a handle being passed on.
let primary = new Set();
let aliases = new Set();
let evalAliases = new Set();
let evalStrings = new Set();

function isHandlesGet(node) {
  node = unwrap(node);
  if (node?.type !== 'MemberExpression' || propName(node) !== 'get') return false;
  const object = unwrap(node.object);
  if (object?.type !== 'Identifier') return false;
  return object.name === 'HANDLES' || primary.has(object.name);
}

function isHandleSource(node, file, tainted) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === 'Identifier' && (node.name === 'rawSql' || node.name === 'HANDLES' || primary.has(node.name))) return true;
  if (isWeakMapGet(node) || isHandlesGet(node)) return true;
  if (node.type === 'CallExpression') {
    const callee = peelCall(node.callee);
    if (callee?.type === 'Identifier' && (callee.name === 'rawSql' || primary.has(callee.name))) return true;
    const name = propName(callee);
    if ((name === 'call' || name === 'apply' || name === 'bind') && isHandleSource(callee?.object, file, tainted)) return true;
  }
  return false;
}

function isTaintedInit(node, file, tainted) {
  node = unwrap(node);
  if (!node) return false;
  if (isHandleSource(node, file, tainted)) return true;
  if (isHandleMember(node, file)) return true;
  if (node.type === 'Identifier' && tainted.has(node.name)) return true;
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'rawSql') return true;
  if (isReflectGet(node)) return true;
  if (isReflectOrValues(node)) return true;
  if (node.type === 'MemberExpression' && isHandleLike(node.object, file, tainted)) return true;
  if (node.type === 'CallExpression') {
    const callee = unwrap(node.callee);
    const name = propName(callee);
    if ((name === 'bind' || name === 'call' || name === 'apply') && receiverIsExec(callee?.object, file, tainted)) return true;
  }
  return false;
}

function isHandleLike(node, file, tainted) {
  node = unwrap(node);
  if (!node) return false;
  if (isHandleSource(node, file, tainted)) return true;
  if (isHandleMember(node, file)) return true;
  if (node.type === 'Identifier' && (tainted.has(node.name) || node.name === '_sql')) return true;
  if (isReflectOrValues(node)) return true;
  if (node.type === 'MemberExpression' && isHandleLike(node.object, file, tainted)) return true;
  if (node.type === 'CallExpression' && (isHandleFactory(node) || isHandleLike(node.callee, file, tainted))) return true;
  return false;
}

function isReflectGet(node) {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && unwrap(node.object)?.name === 'Reflect' && propName(node) === 'get';
}

function peelCall(node) {
  node = unwrap(node);
  while (node?.type === 'SequenceExpression') node = unwrap(node.expressions[node.expressions.length - 1]);
  return node;
}

function isHandleFactory(node) {
  node = unwrap(node);
  if (node?.type !== 'CallExpression') return false;
  const callee = peelCall(node.callee);
  if (callee?.type === 'Identifier' && callee.name === 'rawSql') return true;
  if (callee?.type !== 'MemberExpression') return false;
  const object = unwrap(callee.object);
  const name = propName(callee);
  if (object?.type !== 'Identifier') return false;
  if (object.name === 'Object' && (name === 'assign' || name === 'getOwnPropertyDescriptor')) return true;
  return object.name === 'HANDLES' && name === 'get';
}

function receiverIsExec(node, file, tainted) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === 'MemberExpression' && propName(node) === 'exec') return true;
  return isHandleLike(node, file, tainted);
}

function isRawCall(node, file, tainted) {
  const callee = peel(node?.callee);
  if (!callee) return false;
  if (callee.type === 'Identifier' && tainted.has(callee.name)) return true;
  if (callee.type !== 'MemberExpression') return false;
  const name = propName(callee);
  if (name === 'exec' && (isHandleLike(callee.object, file, tainted) || isPrivateField(callee.object))) return true;
  if ((name === 'call' || name === 'apply' || name === 'bind') && receiverIsExec(callee.object, file, tainted)) return true;
  return false;
}

function lintHandles(file, text) {
  if (EXEC_ALLOW.includes(file)) return [];
  let tree;
  try {
    tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch {
    try { tree = parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); }
    catch (error) { return [{ file, line: 1, text: 'unparsed: ' + error.message }]; }
  }
  const exec = [];
  if (file === 'library.js') {
    const calls = [];
    const see = node => {
      if (!node || typeof node.type !== 'string') return;
      if (isPrivateExec(node)) calls.push(node);
      for (const child of children(node)) see(child);
    };
    see(tree);
    if (calls.length !== 1) exec.push({ file, line: calls[0] ? lineOf(calls[0]) : 1, text: `library.js has ${calls.length} _sql.exec calls` });
  }
  walk(tree, file, new Set(), exec, parameterTaint(tree, file));
  return exec;
}

export function lintSource(file, text) {
  const lines = String(text).split('\n');
  const placeholders = [];
  lines.forEach((line, index) => {
    const code = stripLineComment(line);
    if (!BUILDER.test(code)) return;
    const above = lines.slice(Math.max(0, index - 4), index).join('\n');
    const marked = above.match(/sql-bound-fixed:\s*(\d+)/);
    placeholders.push({ file, line: index + 1, max: marked ? Number(marked[1]) : null });
  });
  return { exec: lintHandles(file, String(text)), placeholders };
}

export function lintDir(dir) {
  const exec = [];
  const placeholders = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.js')).sort()) {
    const found = lintSource(file, readFileSync(join(dir, file), 'utf8'));
    exec.push(...found.exec);
    placeholders.push(...found.placeholders);
  }
  const helper = placeholders.filter(item => item.file === 'sql-bound.js');
  const rest = placeholders.filter(item => item.file !== 'sql-bound.js');
  const known = new Set(PLACEHOLDER_ALLOW.map(item => `${item.file}:${item.max}`));
  const census = rest.map(item => `${item.file}:${item.max}`);
  const unbound = rest.filter(item => !known.has(`${item.file}:${item.max}`));
  return { exec, helper, rest, census, unbound };
}
