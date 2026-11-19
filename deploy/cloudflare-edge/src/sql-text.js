// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.
// Character classes are code points. Verb checks are exact strings.
// Neither path calls RegExp.prototype.exec. A non-boolean, a null, or a throw
// from a snapshotted string or array method counts as a write.

import { charCodeAt, includes, least, lower, most, primordialsHold, push, slice, some, textOf, trim } from './primordials.js';

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
function mustLeast(a, b) {
  const n = least(a, b);
  if (typeof n !== 'number') throw new Error('primordial');
  return n;
}
function mustMost(a, b) {
  const n = most(a, b);
  if (typeof n !== 'number') throw new Error('primordial');
  return n;
}
function mustText(value) {
  const out = textOf(value == null ? '' : value);
  if (typeof out !== 'string') throw new Error('primordial');
  return out;
}
function mustIncludes(list, value) {
  const out = includes(list, value);
  if (out !== true && out !== false) throw new Error('primordial');
  return out;
}
const VERBS = ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'reindex', 'vacuum', 'attach', 'detach'];
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
  if (!primordialsHold()) return [mustText(sql), ''];
  try { return splitBody(sql); }
  catch { return [mustText(sql), '']; }
}

function splitBody(sql) {
  const text = mustText(sql);
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
      i = mustLeast(text.length, i + 2);
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
      i = mustLeast(text.length, i + 1);
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') i++;
      i = mustLeast(text.length, i + 1);
      continue;
    }
    if (c === '(') { paren++; i++; continue; }
    if (c === ')') { paren = mustMost(0, paren - 1); i++; continue; }
    if (isIdentChar(c)) {
      const word = mustLower(wordAt(text, i));
      i += word.length;
      if (trigger === 0) {
        if (paren === 0 && word === 'create') sawCreate = true;
        else if (sawCreate && word === 'trigger') { trigger = 1; sawCreate = false; }
        else if (!mustIncludes(['or', 'replace', 'temp', 'temporary', 'if', 'not', 'exists'], word)) sawCreate = false;
      } else if (trigger === 1) {
        if (paren === 0 && word === 'begin' && !dotted(text, i - word.length) && listed(BODY_NEXT, nextIdent(text, i))) {
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
  if (tail && !onlyNoise(tail, 0)) mustPush(parts, tail);
  return parts;
}

export function placeholderCount(sql) {
  const text = mustText(sql);
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
      i = mustLeast(text.length, i + 2);
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
      j = mustLeast(text.length, j + 2);
      continue;
    }
    if (!isIdentChar(c)) return '';
    return mustLower(wordAt(text, j));
  }
  return '';
}

function flattenShape(sql) {
  const text = mustText(sql);
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
      i = mustLeast(text.length, i + 2);
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
  const text = mustText(sql);
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
      i = mustLeast(text.length, i + 2);
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
  if (writableAssignment(sql)) return true;
  if (pragmaVerb(words) && !pragmaRead(sql)) return true;
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
      i = mustLeast(text.length, i + 2);
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
    if (c === ')') { depth = mustMost(0, depth - 1); i++; continue; }
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

// True when the text after SQLite's prepared statement is space, comments, or one semicolon.
export function remainderIsNoise(tail) {
  let text;
  try { text = mustText(tail); }
  catch { return false; }
  let i = 0;
  let semis = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ';') {
      semis += 1;
      if (semis > 1) return false;
      i++;
      continue;
    }
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = mustLeast(text.length, i + 2);
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

function dotted(text, start) {
  let j = start - 1;
  while (j >= 0 && isSpaceChar(text[j])) j--;
  return j >= 0 && text[j] === '.';
}

function onlyNoise(text, i) {
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
      i = mustLeast(text.length, i + 2);
      continue;
    }
    return false;
  }
  return true;
}

// A semicolon outside a quote, a comment, or a bracket. One trailing semicolon
// whose remainder is only whitespace or comments is not a second statement.
// This does not look at the word begin.
export function bareSemicolon(sql) {
  if (!primordialsHold()) return true;
  try { return scanSemi(mustText(sql)); }
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
      i = mustLeast(text.length, i + 2);
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
      i = mustLeast(text.length, i + 1);
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') i++;
      i = mustLeast(text.length, i + 1);
      continue;
    }
    if (c === ';') return !onlyNoise(text, i + 1);
    i++;
  }
  return false;
}

const READS = ['select', 'values'];
const PRAGMA_READS = ['user_version', 'table_info', 'table_xinfo', 'index_list', 'index_info', 'database_list', 'foreign_key_list', 'schema_version', 'integrity_check', 'quick_check', 'compile_options', 'writable_schema'];
const PRAGMA_TABLE_ARG = ['table_info', 'table_xinfo', 'index_list', 'index_info', 'foreign_key_list', 'integrity_check', 'quick_check'];

// True only when the text is one statement and that statement is a read.
// EXPLAIN is a read only when the statement it explains is a read.
export function provenRead(sql) {
  if (!primordialsHold()) return false;
  try {
    if (scanSemi(mustText(sql))) return false;
    if (writableAssignment(sql)) return false;
    if (pragmaRead(sql)) return true;
    const parts = splitStatements(sql);
    if (parts.length !== 1) return false;
    const words = leadingWords(parts[0]);
    if (pragmaVerb(words)) return false;
    return readWords(words);
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
  if (verb === 'attach' || verb === 'detach') return false;
  if (verb === 'with') {
    for (let k = i + 1; k < words.length; k++) if (verbOf(words[k])) return false;
    return true;
  }
  if (!listed(READS, verb)) return false;
  for (let k = i + 1; k < words.length; k++) if (verbOf(words[k])) return false;
  return true;
}

function pragmaVerb(words) {
  if (!words) return false;
  let i = 0;
  if (words[0] === 'explain') {
    i = 1;
    if (words[1] === 'query' && words[2] === 'plan') i = 3;
  }
  return words[i] === 'pragma';
}

function nameAt(text, name, from) {
  for (let i = from; i + name.length <= text.length; i++) {
    let match = true;
    for (let j = 0; j < name.length; j++) if (text[i + j] !== name[j]) { match = false; break; }
    if (!match) continue;
    if (i > 0 && isWordChar(text[i - 1])) continue;
    if (i + name.length < text.length && isWordChar(text[i + name.length])) continue;
    return i;
  }
  return -1;
}

// A read is a listed pragma with no assignment. Parentheses are a read only
// for the table-argument names. writable_schema and schema_version are bare.
export function pragmaRead(sql) {
  let words;
  try { words = leadingWords(sql); }
  catch { return false; }
  if (!pragmaVerb(words)) return false;
  let i = 0;
  if (words[0] === 'explain') {
    i = 1;
    if (words[1] === 'query' && words[2] === 'plan') i = 3;
  }
  let name = words[i + 1] || '';
  if (!listed(PRAGMA_READS, name) && listed(PRAGMA_READS, words[i + 2] || '')) name = words[i + 2];
  if (!listed(PRAGMA_READS, name)) return false;
  let text;
  try { text = mustLower(mustText(sql)); }
  catch { return false; }
  const pragmaAt = nameAt(text, 'pragma', 0);
  if (pragmaAt < 0) return false;
  const at = nameAt(text, name, pragmaAt + 'pragma'.length);
  if (at < 0) return false;
  let j = at + name.length;
  if (text[j] === '"' || text[j] === '`' || text[j] === ']') j++;
  while (j < text.length && isSpaceChar(text[j])) j++;
  if (j >= text.length) return true;
  if (text[j] === '=') return false;
  if (text[j] === '(') {
    if (!listed(PRAGMA_TABLE_ARG, name)) return false;
    let depth = 0;
    let closed = false;
    for (let k = j; k < text.length; k++) {
      if (text[k] === '=') return false;
      if (text[k] === '(') depth++;
      else if (text[k] === ')') {
        depth--;
        if (depth === 0) { j = k + 1; closed = true; break; }
      }
    }
    if (!closed) return false;
    while (j < text.length && isSpaceChar(text[j])) j++;
    return j >= text.length || onlyNoise(text, j);
  }
  return onlyNoise(text, j);
}

export function pragmaSetter(sql) {
  let words;
  try { words = leadingWords(sql); }
  catch { return true; }
  if (!pragmaVerb(words)) return false;
  return !pragmaRead(sql);
}

// Tokens of one pragma. Comments and strings are dropped. A quoted identifier
// is its text, so the name is the word, not the quote that follows it.
function pragmaTokens(text) {
  const tokens = [];
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
      i = mustLeast(text.length, i + 2);
      continue;
    }
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } i++; break; }
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
      if (name) tokens.push({ kind: 'word', text: name });
      continue;
    }
    if (isIdentChar(c) || isDigitChar(c)) {
      const start = i;
      while (i < text.length && (isWordChar(text[i]))) i++;
      tokens.push({ kind: 'word', text: mustSlice(text, start, i) });
      continue;
    }
    if (c === '=' || c === '(') { tokens.push({ kind: 'op', text: c }); i++; continue; }
    i++;
  }
  return tokens;
}

// PRAGMA writable_schema = ON, or the parenthesised form, writes the catalog flag.
// The name is the unquoted token. Comments between the name and = or ( do not hide it.
// A bare PRAGMA writable_schema reads it.
export function writableAssignment(sql) {
  let text;
  try { text = mustLower(mustText(sql)); }
  catch { return true; }
  try {
    const tokens = pragmaTokens(text);
    let i = 0;
    if (tokens[0] && tokens[0].kind === 'word' && tokens[0].text === 'explain') {
      i = 1;
      if (tokens[1] && tokens[1].text === 'query' && tokens[2] && tokens[2].text === 'plan') i = 3;
    }
    if (!tokens[i] || tokens[i].kind !== 'word' || tokens[i].text !== 'pragma') return false;
    i += 1;
    let name = '';
    while (tokens[i] && tokens[i].kind === 'word') { name = tokens[i].text; i += 1; }
    if (name !== 'writable_schema') return false;
    return !!(tokens[i] && tokens[i].kind === 'op' && (tokens[i].text === '=' || tokens[i].text === '('));
  } catch {
    return true;
  }
}

export function hasCreateAsSelect(sql) {
  const words = leadingWords(sql);
  let depth = 0;
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === '(') depth++;
    else if (words[i] === ')') depth = mustMost(0, depth - 1);
    else if (depth === 0 && words[i] === 'as' && words[i + 1] === 'select') return true;
  }
  return false;
}
