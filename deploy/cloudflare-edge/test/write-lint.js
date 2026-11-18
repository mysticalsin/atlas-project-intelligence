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

function propName(node) {
  if (!node) return '';
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal') return String(node.property.value);
  return '';
}

function exemptHandle(file, node) {
  if (node.object?.type !== 'Identifier') return false;
  const name = node.object.name;
  if (file === 'library-store.js' && name === 'storage') return true;
  if (file === 'sql-bound.js' && (name === 'spec' || name === 'group')) return true;
  return false;
}

function isHandleMember(node, file) {
  if (!node || node.type !== 'MemberExpression') return false;
  const name = propName(node);
  if (name !== 'sql' && name !== '_sql') return false;
  if (exemptHandle(file, node)) return false;
  return node.object?.type === 'Identifier' || node.object?.type === 'ThisExpression';
}

function isPrivateExec(node) {
  return node?.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && propName(node.callee) === 'exec'
    && node.callee.object?.type === 'Identifier'
    && node.callee.object.name === '_sql';
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

function walk(node, file, tainted, exec) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    const next = new Set(tainted);
    for (const child of children(node)) walk(child, file, next, exec);
    return;
  }
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isTaintedInit(node.init, file, tainted)) tainted.add(node.id.name);
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && isTaintedInit(node.right, file, tainted)) tainted.add(node.left.name);
  if (isHandleMember(node, file)) push(exec, file, node, 'raw handle');
  if (node.type === 'CallExpression' && calleeIsRaw(node.callee, file, tainted)) push(exec, file, node, 'raw exec');
  for (const child of children(node)) walk(child, file, tainted, exec);
}

function isTaintedInit(node, file, tainted) {
  if (!node) return false;
  if (isHandleMember(node, file)) return true;
  if (node.type === 'Identifier' && tainted.has(node.name)) return true;
  if (node.type === 'MemberExpression' && propName(node) === 'exec' && isHandleLike(node.object, file, tainted)) return true;
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && propName(node.callee) === 'bind' && isHandleLike(node.callee.object, file, tainted)) return true;
  return false;
}

function isHandleLike(node, file, tainted) {
  if (!node) return false;
  if (isHandleMember(node, file)) return true;
  if (node.type === 'Identifier' && tainted.has(node.name)) return true;
  if (node.type === 'MemberExpression' && propName(node) === 'exec' && isHandleLike(node.object, file, tainted)) return true;
  return false;
}

function calleeIsRaw(callee, file, tainted) {
  if (!callee) return false;
  if (callee.type === 'Identifier' && tainted.has(callee.name)) return true;
  if (callee.type === 'MemberExpression' && propName(callee) === 'exec' && isHandleLike(callee.object, file, tainted)) return true;
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
  walk(tree, file, new Set(), exec);
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
