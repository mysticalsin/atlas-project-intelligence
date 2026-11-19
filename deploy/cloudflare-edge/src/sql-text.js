// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.
// The character and word tests come from primordials.js, captured at load.
// A non-boolean, a null, or a throw counts as a write.

import { includes, lower, match, primordialsHold, replace, some, test, trim } from './primordials.js';

function mustTest(pattern, value) {
  const out = test(pattern, value);
  if (out !== true && out !== false) throw new Error('primordial');
  return out;
}
function mustLower(value) {
  const out = lower(value);
  if (typeof out !== 'string') throw new Error('primordial');
  return out;
}
function mustTrim(value) {
  const out = trim(value);
  if (typeof out !== 'string') throw new Error('primordial');
  return out;
}
function mustIncludes(list, value) {
  const out = includes(list, value);
  if (out !== true && out !== false) throw new Error('primordial');
  return out;
}
function verbOf(word) {
  const found = match(/^(insert|update|delete|replace|create|drop|alter|reindex|vacuum)$/, word);
  if (found === undefined) return true;
  return found != null;
}
function writeOf(word) {
  const found = match(/^(insert|update|delete|replace)$/, word);
  if (found === undefined) return true;
  return found != null;
}
const isWord = (c) => mustTest(/[A-Za-z0-9_]/, c);
const isIdent = (c) => mustTest(/[A-Za-z_]/, c);
const isDigit = (c) => mustTest(/[0-9]/, c);
const isSpace = (c) => mustTest(/\s/, c);

function wordAt(text, i) {
  let j = i + 1;
  while (j < text.length && isWord(text[j])) j++;
  return text.slice(i, j);
}

export function splitStatements(sql) {
  if (!primordialsHold()) return [String(sql ?? ''), ''];
  try { return splitBody(sql); }
  catch { return [String(sql ?? ''), '']; }
}

function splitBody(sql) {
  const text = String(sql ?? '');
  const parts = [];
  let start = 0;
  let i = 0;
  // 0: ordinary SQL. 1: CREATE TRIGGER header. 2+: inside that trigger body.
  // A bare identifier begin, end, case, or trigger does not start a body.
  let trigger = 0;
  let paren = 0;
  let sawCreate = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '[') {
      while (i < text.length && text[i] !== ']') i++;
      i = Math.min(text.length, i + 1);
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') i++;
      i = Math.min(text.length, i + 1);
      continue;
    }
    if (c === '(') { paren++; i++; continue; }
    if (c === ')') { paren = Math.max(0, paren - 1); i++; continue; }
    if (isIdent(c)) {
      const word = mustLower(wordAt(text, i));
      i += word.length;
      if (trigger === 0) {
        if (paren === 0 && word === 'create') sawCreate = true;
        else if (sawCreate && word === 'trigger') { trigger = 1; sawCreate = false; }
        else if (!mustIncludes(['or', 'replace', 'temp', 'temporary', 'if', 'not', 'exists'], word)) sawCreate = false;
      } else if (trigger === 1) {
        if (paren === 0 && word === 'begin') trigger = 2;
      } else if (paren === 0 && word === 'begin') trigger++;
      else if (paren === 0 && word === 'end') trigger = trigger > 2 ? trigger - 1 : 0;
      continue;
    }
    if (c === ';' && trigger < 2) {
      const slice = mustTrim(text.slice(start, i));
      if (slice) parts.push(slice);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const tail = mustTrim(text.slice(start));
  if (tail) parts.push(tail);
  return parts;
}

export function placeholderCount(sql) {
  const text = String(sql ?? '');
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '?') {
      n++;
      i++;
      while (i < text.length && isDigit(text[i])) i++;
      continue;
    }
    i++;
  }
  return n;
}

export function sqlShape(sql) {
  if (!primordialsHold()) return '';
  try {
    const parts = splitBody(sql);
    if (parts.length !== 1) return '';
    let text = replace(parts[0], /\/\*[\s\S]*?\*\//g, ' ');
    if (typeof text !== 'string') return '';
    text = replace(text, /--[^\n]*/g, ' ');
    if (typeof text !== 'string') return '';
    text = replace(text, /\s+/g, ' ');
    if (typeof text !== 'string') return '';
    text = trim(text);
    if (typeof text !== 'string') return '';
    const out = lower(text);
    return typeof out === 'string' ? out : '';
  } catch {
    return '';
  }
}

// Keywords and identifiers, in order. Comments are dropped. A quoted identifier
// is its text. A string literal is omitted, so it cannot impersonate a verb.
export function leadingWords(sql) {
  const text = String(sql ?? '');
  const words = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      i++;
      let name = '';
      while (i < text.length && text[i] !== end) {
        if (text[i] === end && text[i + 1] === end) { name += end; i += 2; continue; }
        name += text[i++];
      }
      if (i < text.length) i++;
      if (name) words.push(mustLower(name));
      continue;
    }
    if (isIdent(c)) {
      const word = wordAt(text, i);
      words.push(mustLower(word));
      i += word.length;
      continue;
    }
    i++;
  }
  return words;
}

export function isMutatingStatement(sql) {
  if (!primordialsHold()) return true;
  try { return mutatingBody(sql); }
  catch { return true; }
}

function mutatingBody(sql) {
  const parts = splitStatements(sql);
  if (parts.length !== 1) return true;
  const words = leadingWords(parts[0]);
  const verb = words[0] || '';
  if (verbOf(verb)) return true;
  // EXPLAIN DELETE still names a mutation. EXPLAIN QUERY PLAN only describes one, and a plan read stays a read.
  const plan = verb === 'explain' && words[1] === 'query' && words[2] === 'plan';
  const named = some(words, (word) => verbOf(word));
  if (named !== true && named !== false) return true;
  if (verb === 'explain' && !plan && named) return true;
  if (verb !== 'with') return false;
  const text = parts[0];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === quote) { if (text[i + 1] === quote) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && isIdent(c)) {
      const word = mustLower(wordAt(text, i));
      if (writeOf(word)) return true;
      i += word.length;
      continue;
    }
    i++;
  }
  return false;
}

// True when the text after SQLite's prepared statement is only space, semicolons, or comments.
export function remainderIsNoise(tail) {
  const text = String(tail ?? '');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ';') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    return false;
  }
  return true;
}

// A semicolon outside quotes and comments, with more SQL after it.
// This is the backstop for a driver that cannot prepare. It does not track BEGIN/END.
export function unparsedTail(sql) {
  const text = String(sql ?? '');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      i++;
      while (i < text.length) {
        if (text[i] === end) {
          if (text[i + 1] === end) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ';') return !remainderIsNoise(text.slice(i + 1));
    i++;
  }
  return false;
}

export function hasCreateAsSelect(sql) {
  const words = leadingWords(sql);
  let depth = 0;
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === '(') depth++;
    else if (words[i] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && words[i] === 'as' && words[i + 1] === 'select') return true;
  }
  return false;
}
