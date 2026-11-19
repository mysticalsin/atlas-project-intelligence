// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.
// Character classes are code points. Verb checks are exact strings.
// Neither path calls RegExp.prototype.exec. A non-boolean, a null, or a throw
// from a snapshotted string or array method counts as a write.

import { charCodeAt, includes, lower, primordialsHold, push, slice, some, trim } from './primordials.js';

function codeAt(c) {
  const n = charCodeAt(c, 0);
  if (typeof n !== 'number') throw new Error('primordial');
  return n;
}
function isIdentChar(c) {
  const n = codeAt(c);
  return (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 95;
}
function isWordChar(c) {
  const n = codeAt(c);
  return isIdentChar(c) || (n >= 48 && n <= 57);
}
function isDigitChar(c) {
  const n = codeAt(c);
  return n >= 48 && n <= 57;
}
function isSpaceChar(c) {
  const n = codeAt(c);
  return n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32 || n === 0xa0
    || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) || n === 0x2028 || n === 0x2029
    || n === 0x202f || n === 0x205f || n === 0x3000 || n === 0xfeff;
}
function mustSlice(text, start, end) {
  const out = slice(text, start, end);
  if (typeof out !== 'string') throw new Error('primordial');
  return out;
}
function mustPush(list, value) {
  const before = list.length;
  const out = push(list, value);
  if (typeof out !== 'number' || list.length !== before + 1 || list[before] !== value) throw new Error('primordial');
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
const VERBS = ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'reindex', 'vacuum'];
const WRITES = ['insert', 'update', 'delete', 'replace'];
const BODY_NEXT = ['select', 'insert', 'update', 'delete', 'replace', 'with', 'values', 'begin', 'end'];
function listed(list, word) {
  const text = mustLower(word);
  for (let i = 0; i < list.length; i++) if (list[i] === text) return true;
  return false;
}
function verbOf(word) {
  return listed(VERBS, word);
}
function writeOf(word) {
  return listed(WRITES, word);
}

function wordAt(text, i) {
  let j = i + 1;
  while (j < text.length && isWordChar(text[j])) j++;
  return mustSlice(text, i, j);
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
  let atStatement = false;
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
    if (isIdentChar(c)) {
      const word = mustLower(wordAt(text, i));
      i += word.length;
      if (trigger === 0) {
        if (paren === 0 && word === 'create') sawCreate = true;
        else if (sawCreate && word === 'trigger') { trigger = 1; sawCreate = false; }
        else if (!mustIncludes(['or', 'replace', 'temp', 'temporary', 'if', 'not', 'exists'], word)) sawCreate = false;
      } else if (trigger === 1) {
        if (paren === 0 && word === 'begin' && listed(BODY_NEXT, nextIdent(text, i))) {
          trigger = 2;
          atStatement = true;
        }
      } else if (paren === 0 && atStatement && word === 'begin') {
        trigger++;
        atStatement = true;
      } else if (paren === 0 && atStatement && word === 'end') {
        trigger = trigger > 2 ? trigger - 1 : 0;
        atStatement = true;
      } else if (trigger >= 2) atStatement = false;
      continue;
    }
    if (c === ';' && trigger >= 2) { atStatement = true; i++; continue; }
    if (c === ';' && trigger < 2) {
      const piece = mustTrim(mustSlice(text, start, i));
      if (piece) mustPush(parts, piece);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const tail = mustTrim(mustSlice(text, start));
  if (tail) mustPush(parts, tail);
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
      while (i < text.length && isDigitChar(text[i])) i++;
      continue;
    }
    i++;
  }
  return n;
}

function nextIdent(text, i) {
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (isSpaceChar(c)) { j++; continue; }
    if (c === '-' && text[j + 1] === '-') { while (j < text.length && text[j] !== '\n') j++; continue; }
    if (c === '/' && text[j + 1] === '*') {
      j += 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j = Math.min(text.length, j + 2);
      continue;
    }
    if (!isIdentChar(c)) return '';
    return mustLower(wordAt(text, j));
  }
  return '';
}

function flattenShape(sql) {
  const text = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      out += ' ';
      continue;
    }
    if (isSpaceChar(c)) {
      out += ' ';
      while (i < text.length && isSpaceChar(text[i])) i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function sqlShape(sql) {
  if (!primordialsHold()) return '';
  try {
    const parts = splitBody(sql);
    if (parts.length !== 1) return '';
    const flat = trim(flattenShape(parts[0]));
    if (typeof flat !== 'string') return '';
    const out = lower(flat);
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
    if (isSpaceChar(c)) { i++; continue; }
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
      if (name) mustPush(words, mustLower(name));
      continue;
    }
    if (isIdentChar(c)) {
      const word = wordAt(text, i);
      mustPush(words, mustLower(word));
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
    if (depth === 0 && isIdentChar(c)) {
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

// The backstop for a driver that cannot prepare. It uses the same split as the
// door, so a semicolon inside CREATE TRIGGER ... BEGIN ... END is one statement
// and a statement after that END is a second one. '' and ';' have length 0.
export function unparsedTail(sql) {
  return splitStatements(sql).length > 1;
}

// A semicolon outside a quote, a comment, or a bracket. This does not look at
// the word begin. The caller decides whether that semicolon is still one statement.
export function bareSemicolon(sql) {
  if (!primordialsHold()) return true;
  try { return scanSemi(String(sql ?? '')); }
  catch { return true; }
}

function scanSemi(text) {
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
    if (c === ';') return true;
    i++;
  }
  return false;
}

const READS = ['select', 'pragma', 'values'];

// True only when the text is one statement and that statement is a read.
// EXPLAIN is a read only when the statement it explains is a read.
export function provenRead(sql) {
  if (!primordialsHold()) return false;
  try {
    if (scanSemi(String(sql ?? ''))) return false;
    const parts = splitStatements(sql);
    if (parts.length !== 1) return false;
    return readWords(leadingWords(parts[0]));
  } catch {
    return false;
  }
}

function readWords(words) {
  if (!words || !words.length) return false;
  let i = 0;
  if (words[0] === 'explain') {
    i = 1;
    if (words[1] === 'query' && words[2] === 'plan') i = 3;
  }
  const verb = words[i] || '';
  if (verb === 'with') {
    for (let k = i + 1; k < words.length; k++) if (verbOf(words[k])) return false;
    return true;
  }
  if (!listed(READS, verb)) return false;
  for (let k = i + 1; k < words.length; k++) if (verbOf(words[k])) return false;
  return true;
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
