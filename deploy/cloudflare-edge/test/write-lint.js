// The write-path lint. Product modules write through Library.exec inside a door.
// A mutating sql.exec is allowed only in the three files that hold the raw handle.
// The placeholder census is the same spelling grep the bound-parameter tests use.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXEC_ALLOW = new Set(['library.js', 'library-store.js', 'audit-chain.js']);

// Bounded dynamic placeholder lists. The max is every bound parameter on that statement.
export const PLACEHOLDER_ALLOW = [
  { file: 'operate.js', max: 3, why: 'directory erasure binds the tenant plus at most a mail and an oid' },
  { file: 'library.js', max: 3, why: 'an invitation list binds at most the sign-in email, the mail claim, and the tenant' },
];

const BUILDER = /\.map\(\s*\(\s*\)\s*=>\s*['"`]\?['"`]\s*\)|['"`]\?['"`]\s*\.repeat\s*\(|\.fill\(\s*['"`]\?['"`]\s*\)|Array\.from\(\s*\{[^}]*\}\s*,\s*\(\s*\)\s*=>\s*['"`]\?['"`]\s*\)/;
const EXEC_CALL = /\.sql\.exec\s*\(/;
const MUTATING = /^(?:insert|update|delete|replace|create|drop|alter|reindex|vacuum)\b/i;

export function stripLineComment(line) {
  return line.replace(/\/\/.*$/, '');
}

export function isMutatingSql(sql) {
  const text = String(sql ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (MUTATING.test(text)) return true;
  return /^with\b/i.test(text) && /\b(insert|update|delete|replace)\b/i.test(text);
}

function execViolation(line) {
  const code = stripLineComment(line);
  if (!EXEC_CALL.test(code)) return false;
  const literal = code.match(/\.sql\.exec\s*\(\s*(['"`])([\s\S]*)$/);
  if (!literal) return true;
  return isMutatingSql(literal[2]);
}

export function lintSource(file, text) {
  const lines = String(text).split('\n');
  const exec = [];
  const placeholders = [];
  lines.forEach((line, index) => {
    if (!EXEC_ALLOW.has(file) && execViolation(line)) exec.push({ file, line: index + 1, text: line.trim() });
    const code = stripLineComment(line);
    if (!BUILDER.test(code)) return;
    const above = lines.slice(Math.max(0, index - 4), index).join('\n');
    const marked = above.match(/sql-bound-fixed:\s*(\d+)/);
    placeholders.push({ file, line: index + 1, max: marked ? Number(marked[1]) : null });
  });
  return { exec, placeholders };
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
