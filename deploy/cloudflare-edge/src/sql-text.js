// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.
// Character classes are code points. Verb checks are exact strings.
// Neither path calls RegExp.prototype.exec. A non-boolean, a null, or a throw
// from a snapshotted string or array method counts as a write.

import { charCodeAt, includes, least, lower, most, primordialsHold, push, slice, textOf, trim } from './primordials.js';

function codeAt(c) {
  const n = charCodeAt(c, 0);
  if (typeof n !== 'number') throw new Error('primordial');
  return n;
}
function isIdentChar(c) {
  const n = codeAt(c);
  return (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 95;
}
function isDigitChar(c) {
  const n = codeAt(c);
  return n >= 48 && n <= 57;
}
// SQLite IdChar: letters, digits, '_', '$', and a code unit at or above 128.
function isSqlIdChar(c) {
  const n = codeAt(c);
  if (n >= 128) return true;
  if (n >= 48 && n <= 57) return true;
  if (n >= 65 && n <= 90) return true;
  if (n >= 97 && n <= 122) return true;
  return n === 95 || n === 36;
}
// sqlite3Isspace: tab, LF, VT, FF, CR, and space. A no-break space is not one.
function isSqliteSpace(c) {
  const n = codeAt(c);
  return n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32;
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
const VERBS = ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'reindex', 'vacuum', 'attach', 'detach', 'analyze', 'begin', 'commit', 'end', 'rollback', 'savepoint', 'release'];
const BODY_NEXT = ['select', 'insert', 'update', 'delete', 'replace', 'with', 'values', 'begin', 'end'];
function listed(list, word) {
  const text = mustLower(word);
  for (let i = 0; i < list.length; i++) if (list[i] === text) return true;
  return false;
}
// The statement verb is the first verb keyword at depth 0 after a WITH list.
// A call, an alias, a dotted name, and a quoted name are not that verb.
function plain(token, text) {
  return !!(token && token.kind === 'word' && !token.quoted && token.text === text && token.depth === 0);
}
function blockedVerb(tokens, i) {
  const prev = tokens[i - 1];
  if (prev && ((prev.text === 'as' && !prev.quoted) || prev.text === '.')) return true;
  const next = tokens[i + 1];
  return !!(next && next.text === ')');
}
const WRITES = ['insert', 'update', 'delete', 'replace'];
// A bare unquoted token inside parentheses. REPLACE is not here: REPLACE( is a function.
const NESTED_WRITES = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'analyze'];
function writeVerbAt(tokens, i) {
  const token = tokens[i];
  if (!(token && token.kind === 'word' && !token.quoted && listed(WRITES, token.text))) return false;
  if (blockedVerb(tokens, i)) return false;
  if (token.text === 'replace' && tokens[i + 1] && tokens[i + 1].text === '(') return false;
  return true;
}
function nestedWrite(tokens, i) {
  const token = tokens[i];
  if (!(token && token.kind === 'word' && !token.quoted && token.depth > 0 && listed(NESTED_WRITES, token.text))) return false;
  const prev = tokens[i - 1];
  if (prev && ((prev.text === 'as' && !prev.quoted) || prev.text === '.')) return false;
  return true;
}
function explainsPlan(tokens) {
  const words = [];
  for (let i = 0; i < tokens.length && words.length < 3; i++) {
    const token = tokens[i];
    if (token.kind === 'word' && !token.quoted) words.push(token.text);
  }
  return words[0] === 'explain' && words[1] === 'query' && words[2] === 'plan';
}
// A write verb at depth > 0 is inside a CTE body or a subquery. A write verb
// after the first depth-0 verb is a second write. REPLACE( is the function.
// topVerb still returns only the first depth-0 verb. EXPLAIN QUERY PLAN
// describes a statement, so its verb is not this check.
function strayWrite(tokens) {
  if (explainsPlan(tokens)) return false;
  let seen = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (nestedWrite(tokens, i) || (writeVerbAt(tokens, i) && (token.depth > 0 || seen))) return true;
    if (token && token.kind === 'word' && !token.quoted && token.depth === 0 && !blockedVerb(tokens, i)) {
      if (listed(VERBS, token.text) || listed(READS, token.text) || token.text === 'with' || token.text === 'explain') seen = true;
    }
  }
  return false;
}
function skipGroup(tokens, j) {
  if (!(tokens[j] && tokens[j].text === '(')) return -1;
  const base = tokens[j].depth;
  j++;
  while (j < tokens.length && !(tokens[j].text === ')' && tokens[j].depth === base)) j++;
  if (j >= tokens.length) return j;
  return j + 1;
}
function afterCteList(tokens, withAt) {
  let i = withAt + 1;
  if (plain(tokens[i], 'recursive')) i++;
  while (i < tokens.length) {
    let j = i;
    const name = tokens[j];
    if (name && name.kind === 'word' && name.depth === 0 && !(name.text === 'as' && !name.quoted)) {
      j++;
      if (tokens[j] && tokens[j].text === '(' && tokens[j].depth === name.depth) {
        const after = skipGroup(tokens, j);
        if (after < 0) break;
        j = after;
      }
      if (!plain(tokens[j], 'as')) break;
    }
    if (!plain(tokens[j], 'as')) break;
    j++;
    if (plain(tokens[j], 'not')) j++;
    if (plain(tokens[j], 'materialized')) j++;
    if (!(tokens[j] && tokens[j].text === '(')) break;
    const after = skipGroup(tokens, j);
    if (after < 0) break;
    i = after;
  }
  return i;
}
function topVerb(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (plain(token, 'with') && !blockedVerb(tokens, i)) {
      i = afterCteList(tokens, i);
      continue;
    }
    if (token && token.kind === 'word' && !token.quoted && token.depth === 0 && !blockedVerb(tokens, i)) {
      if (listed(VERBS, token.text) || listed(READS, token.text)) return token.text;
    }
    i++;
  }
  return '';
}
function hasStatementVerb(sql) {
  return listed(VERBS, topVerb(sqlTokens(sql)));
}
function extraStatement(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === ';' && i < tokens.length - 1) return true;
  }
  return false;
}
function openingVerb(sql) {
  const tokens = sqlTokens(sql);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word') continue;
    return !token.quoted && listed(VERBS, token.text);
  }
  return false;
}

function wordAt(text, i) {
  let j = i + 1;
  while (j < text.length && isSqlIdChar(text[j])) j++;
  return mustSlice(text, i, j);
}
// A letter or '_' starts an identifier. '$' continues it (tokenize.c IdChar,
// line 168) and is not a parameter. Call this before takeVariable.
function skipIdent(text, i) {
  if (!isIdentChar(text[i])) return -1;
  return i + wordAt(text, i).length;
}
// SQLite 3.53.4 src/tokenize.c, the version this host's node:sqlite reports.
// '?' and '?NNN' are CC_VARNUM, lines 504-507 (the class is line 35).
// '$' '@' ':' '#' are CC_DOLLAR / CC_VARALPHA, lines 509-537 (classes are lines 33-34).
// IdChar is line 168. The '(' suffix is lines 519-528 and stops at sqlite3Isspace or ')'.
// '::' is lines 529-530. n==0 is TK_ILLEGAL at line 536.
// A quote or a comment inside the suffix is text. '$' inside an identifier is IdChar.
function takeVariable(text, i) {
  const sigil = text[i];
  if (sigil === '?') {
    let j = i + 1;
    while (j < text.length && isDigitChar(text[j])) j++;
    return { next: j, named: false };
  }
  if (sigil !== '$' && sigil !== '@' && sigil !== ':' && sigil !== '#') return null;
  let n = 0;
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (isSqlIdChar(c)) { n++; j++; continue; }
    if (c === '(' && n > 0) {
      j++;
      while (j < text.length && !isSqliteSpace(text[j]) && text[j] !== ')') j++;
      if (j < text.length && text[j] === ')') j++;
      break;
    }
    if (c === ':' && text[j + 1] === ':') { j += 2; continue; }
    break;
  }
  return { next: j, named: n > 0 };
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
    const variable = takeVariable(text, i);
    if (variable) { i = variable.next; continue; }
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
      while (i < text.length) {
        if (text[i] === '`') {
          if (text[i + 1] === '`') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
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
    if (c === '[') {
      while (i < text.length && text[i] !== ']') i++;
      i = mustLeast(text.length, i + 1);
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length) {
        if (text[i] === '`') {
          if (text[i + 1] === '`') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const ident = skipIdent(text, i);
    if (ident > i) { i = ident; continue; }
    const variable = takeVariable(text, i);
    if (variable) {
      if (c === '?') n++;
      i = variable.next;
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

function skipQuote(text, i, end) {
  i++;
  while (i < text.length) {
    if (text[i] === end) {
      if (text[i + 1] === end) { i += 2; continue; }
      return { next: i + 1, closed: true };
    }
    i++;
  }
  return { next: i, closed: false };
}

function quotedName(text, i) {
  const end = text[i] === '[' ? ']' : text[i];
  const start = i + 1;
  let j = start;
  let name = '';
  let closed = false;
  while (j < text.length) {
    if (text[j] === end) {
      if (end !== ']' && text[j + 1] === end) { name += end; j += 2; continue; }
      j++;
      closed = true;
      break;
    }
    name += text[j++];
  }
  return { name, next: j, start, closed };
}

// One lexer. Comments are dropped. A string literal is omitted. A quoted
// identifier, in ", `, or [], is one lowercased word. Each token carries the
// parenthesis depth it sits at. Operators that change a pragma or a name stay
// in the stream so a later check never reads the raw text again.
export function sqlTokens(sql) {
  const text = mustText(sql);
  const tokens = [];
  let i = 0;
  let depth = 0;
  let unclosed = false;
  const push = (token) => {
    token.depth = depth;
    mustPush(tokens, token);
  };
  while (i < text.length) {
    const c = text[i];
    if (isSpaceChar(c)) { i++; continue; }
    const variable = takeVariable(text, i);
    if (variable) {
      push({ kind: 'var', text: mustLower(mustSlice(text, i, variable.next)), named: variable.named });
      i = variable.next;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) unclosed = true;
      else i += 2;
      continue;
    }
    if (c === "'") {
      const quote = skipQuote(text, i, "'");
      if (!quote.closed) unclosed = true;
      i = quote.next;
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const quoted = quotedName(text, i);
      i = quoted.next;
      if (!quoted.closed) unclosed = true;
      else if (quoted.name) push({ kind: 'word', text: mustLower(quoted.name), quoted: true });
      continue;
    }
    if (c === '=' || c === '(' || c === ')' || c === '.' || c === ';') {
      if (c === ')') depth = mustMost(0, depth - 1);
      push({ kind: 'op', text: c });
      if (c === '(') depth++;
      i++;
      continue;
    }
    if (isDigitChar(c)) {
      const start = i;
      i++;
      while (i < text.length && isDigitChar(text[i])) i++;
      push({ kind: 'word', text: mustSlice(text, start, i) });
      continue;
    }
    if (isIdentChar(c)) {
      const word = wordAt(text, i);
      push({ kind: 'word', text: mustLower(word) });
      i += word.length;
      continue;
    }
    i++;
  }
  tokens.unclosed = unclosed;
  return tokens;
}

// An unterminated ', ", [, `, or /* consumes the rest of the input. That is not
// a proven read. A finished quote, identifier, or block comment is not this.
export function unclosedLexeme(sql) {
  if (!primordialsHold()) return true;
  try { return sqlTokens(sql).unclosed === true; }
  catch { return true; }
}

// A named parameter is '$' ':' '@' or '#' with at least one IdChar, the n>0
// rule in tokenize.c. '?' and '?NNN' are not named. A sigil inside a string or
// a quoted identifier is not a token of this kind. '$' inside 'x$y' is not one.
export function namedVariable(sql) {
  if (!primordialsHold()) return true;
  try {
    const tokens = sqlTokens(sql);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind === 'var' && tokens[i].named === true) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// Keywords and identifiers, in order. Comments are dropped. A quoted identifier
// is its text. A string literal is omitted, so it cannot impersonate a verb.
export function leadingWords(sql) {
  const tokens = sqlTokens(sql);
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'word' || token.text === '(' || token.text === ')') mustPush(words, token.text);
  }
  return words;
}

export function isMutatingStatement(sql) {
  if (!primordialsHold()) return true;
  try { return mutatingBody(sql); }
  catch { return true; }
}

function mutatingBody(sql) {
  const tokens = sqlTokens(sql);
  if (strayWrite(tokens)) return true;
  if (extraStatement(tokens)) return true;
  const words = leadingWords(sql);
  const verb = words[0] || '';
  if (writableAssignment(sql)) return true;
  if (pragmaVerb(words) && !pragmaRead(sql)) return true;
  if (openingVerb(sql)) return true;
  // EXPLAIN DELETE still names a mutation. EXPLAIN QUERY PLAN only describes one, and a plan read stays a read.
  const plan = verb === 'explain' && words[1] === 'query' && words[2] === 'plan';
  const named = hasStatementVerb(sql);
  if (verb === 'explain' && !plan && named) return true;
  // WITH is not itself a verb. The same tokens decide the verb after its list.
  if (verb === 'with') return named;
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
    const ident = skipIdent(text, i);
    if (ident > i) { i = ident; continue; }
    const variable = takeVariable(text, i);
    if (variable) { i = variable.next; continue; }
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
      while (i < text.length) {
        if (text[i] === '`') {
          if (text[i + 1] === '`') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
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
    if (unclosedLexeme(sql)) return false;
    const tokens = sqlTokens(sql);
    if (extraStatement(tokens)) return false;
    const opened = leadingWords(sql);
    if (pragmaVerb(opened)) {
      if (writableAssignment(sql)) return false;
      return pragmaRead(sql);
    }
    if (writableAssignment(sql)) return false;
    return readWords(tokens);
  } catch {
    return false;
  }
}

// The primary door asks the same lexer as provenRead. A WITH or EXPLAIN whose
// statement is not a read is a write even when the first word is not the verb.
// EXPLAIN QUERY PLAN only describes a statement, so it is not this check.
export function hiddenWrite(sql) {
  if (!primordialsHold()) return true;
  try {
    const words = leadingWords(sql);
    const verb = words[0] || '';
    if (verb === 'explain' && words[1] === 'query' && words[2] === 'plan') return false;
    if (verb !== 'with' && verb !== 'explain') return false;
    return !provenRead(sql);
  } catch {
    return true;
  }
}

function readWords(tokens) {
  if (strayWrite(tokens)) return false;
  if (!tokens || !tokens.length) return false;
  let i = 0;
  while (i < tokens.length && tokens[i].kind !== 'word') i++;
  if (tokens[i] && tokens[i].text === 'explain' && !tokens[i].quoted) {
    i++;
    while (i < tokens.length && tokens[i].kind !== 'word') i++;
    if (tokens[i] && tokens[i].text === 'query' && !tokens[i].quoted && tokens[i + 1] && tokens[i + 1].text === 'plan' && !tokens[i + 1].quoted) {
      i += 2;
      while (i < tokens.length && tokens[i].kind !== 'word') i++;
    }
  }
  const verb = tokens[i] && !tokens[i].quoted ? tokens[i].text : '';
  if (verb === 'attach' || verb === 'detach') return false;
  if (verb === 'with' || listed(READS, verb)) return !listed(VERBS, topVerb(tokens));
  return false;
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

// A pragma name is the word after PRAGMA, or the word after a schema dot.
// An equals sign is an assignment. Parentheses are a read only for the
// table-argument names. One trailing semicolon is still that statement.
function readPragma(tokens, i) {
  let n = i + 1;
  if (tokens[n]?.kind !== 'word') return { name: '', kind: 'setter', start: i, end: n };
  let name = tokens[n].text;
  n++;
  if (tokens[n]?.kind === 'op' && tokens[n].text === '.' && tokens[n + 1]?.kind === 'word') {
    name = tokens[n + 1].text;
    n += 2;
  }
  if (tokens[n]?.kind === 'op' && tokens[n].text === '=') {
    n++;
    if (n < tokens.length) n++;
    if (tokens[n]?.text === ';') n++;
    const kind = name === 'writable_schema' ? 'writable' : 'setter';
    return { name, kind, start: i, end: n };
  }
  if (tokens[n]?.kind === 'op' && tokens[n].text === '(') {
    let depth = 0;
    let eq = false;
    let closed = -1;
    for (let k = n; k < tokens.length; k++) {
      if (tokens[k].text === '=') eq = true;
      if (tokens[k].text === '(') depth++;
      else if (tokens[k].text === ')') {
        depth = mustMost(0, depth - 1);
        if (depth === 0) { closed = k; break; }
      }
    }
    if (closed < 0) {
      return { name, kind: name === 'writable_schema' ? 'writable' : 'setter', start: i, end: n };
    }
    if (eq || !listed(PRAGMA_TABLE_ARG, name)) {
      let end = closed + 1;
      if (tokens[end]?.text === ';') end++;
      return { name, kind: name === 'writable_schema' ? 'writable' : 'setter', start: i, end };
    }
    n = closed + 1;
  }
  if (tokens[n]?.text === ';') n++;
  if (!listed(PRAGMA_READS, name)) return { name, kind: 'setter', start: i, end: n };
  if (n < tokens.length && tokens[n - 1]?.text !== ';') return { name, kind: 'setter', start: i, end: n };
  return { name, kind: 'read', start: i, end: n };
}

// none, read, setter, or writable. writable wins. A throw is a setter.
export function pragmaClass(sql) {
  try {
    if (!primordialsHold()) return 'setter';
    const tokens = sqlTokens(sql);
    let saw = 'none';
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind !== 'word' || tokens[i].text !== 'pragma') continue;
      const found = readPragma(tokens, i);
      if (found.kind === 'writable') return 'writable';
      if (found.kind === 'setter') saw = 'setter';
      else if (saw === 'none') saw = 'read';
      if (found.end > i) i = found.end - 1;
    }
    return saw;
  } catch {
    return 'setter';
  }
}

// The schema door may set only these two, and only as the whole statement.
export function pragmaSetterName(sql) {
  try {
    const tokens = sqlTokens(sql);
    let found = null;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind !== 'word' || tokens[i].text !== 'pragma') continue;
      found = readPragma(tokens, i);
      break;
    }
    if (!found || found.kind !== 'setter' || found.start !== 0 || found.end < tokens.length) return '';
    if (found.name !== 'user_version' && found.name !== 'foreign_keys') return '';
    return found.name;
  } catch {
    return '';
  }
}

export function pragmaRead(sql) {
  try { return pragmaClass(sql) === 'read'; }
  catch { return false; }
}

export function pragmaSetter(sql) {
  try {
    const klass = pragmaClass(sql);
    return klass === 'setter' || klass === 'writable';
  } catch {
    return true;
  }
}

// PRAGMA writable_schema = ON, or the parenthesised form, writes the catalog flag.
// A bare PRAGMA writable_schema reads it. Quotes and comments are already gone.
export function writableAssignment(sql) {
  try { return pragmaClass(sql) === 'writable'; }
  catch { return true; }
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
