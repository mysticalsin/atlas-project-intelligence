// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.
// The methods below are the originals from module load. A later patch of
// String.prototype.toLowerCase or RegExp.prototype.test / exec does not reach them.

const lower = String.prototype.toLowerCase;
const reTest = RegExp.prototype.test;
const reExec = RegExp.prototype.exec;
const isWord = (c) => reTest.call(/[A-Za-z0-9_]/, c);
const isIdent = (c) => reTest.call(/[A-Za-z_]/, c);
const isDigit = (c) => reTest.call(/[0-9]/, c);
const isSpace = (c) => reTest.call(/\s/, c);
const verbOf = (word) => reExec.call(/^(insert|update|delete|replace|create|drop|alter|reindex|vacuum)$/, word);
const writeOf = (word) => reExec.call(/^(insert|update|delete|replace)$/, word);

function wordAt(text, i) {
  let j = i + 1;
  while (j < text.length && isWord(text[j])) j++;
  return text.slice(i, j);
}

export function splitStatements(sql) {
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
      const word = lower.call(wordAt(text, i));
      i += word.length;
      if (trigger === 0) {
        if (paren === 0 && word === 'create') sawCreate = true;
        else if (sawCreate && word === 'trigger') { trigger = 1; sawCreate = false; }
        else if (!['or', 'replace', 'temp', 'temporary', 'if', 'not', 'exists'].includes(word)) sawCreate = false;
      } else if (trigger === 1) {
        if (paren === 0 && word === 'begin') trigger = 2;
      } else if (paren === 0 && word === 'begin') trigger++;
      else if (paren === 0 && word === 'end') trigger = trigger > 2 ? trigger - 1 : 0;
      continue;
    }
    if (c === ';' && trigger < 2) {
      const slice = text.slice(start, i).trim();
      if (slice) parts.push(slice);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const tail = text.slice(start).trim();
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
  const parts = splitStatements(sql);
  if (parts.length !== 1) return '';
  return lower.call(parts[0].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim());
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
      if (name) words.push(lower.call(name));
      continue;
    }
    if (isIdent(c)) {
      const word = wordAt(text, i);
      words.push(lower.call(word));
      i += word.length;
      continue;
    }
    i++;
  }
  return words;
}

export function isMutatingStatement(sql) {
  const parts = splitStatements(sql);
  if (parts.length !== 1) return true;
  const words = leadingWords(parts[0]);
  const verb = words[0] || '';
  if (verbOf(verb)) return true;
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
      const word = lower.call(wordAt(text, i));
      if (writeOf(word)) return true;
      i += word.length;
      continue;
    }
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
