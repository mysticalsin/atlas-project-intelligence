// One statement in, one statement out. The split understands quotes, comments,
// and a trigger body, so a semicolon inside those is not a second statement.
// Classification uses these tokens. A prefix of the text is not a statement.

function wordAt(text, i) {
  let j = i + 1;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
  return text.slice(i, j);
}

export function splitStatements(sql) {
  const text = String(sql ?? '');
  const parts = [];
  let start = 0;
  let i = 0;
  let beginDepth = 0;
  let caseDepth = 0;
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
    if (/[A-Za-z_]/.test(c)) {
      const word = wordAt(text, i).toLowerCase();
      i += word.length;
      if (word === 'begin') beginDepth++;
      else if (word === 'case') caseDepth++;
      else if (word === 'end') {
        if (caseDepth) caseDepth--;
        else if (beginDepth) beginDepth--;
      }
      continue;
    }
    if (c === ';' && beginDepth === 0) {
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
      while (i < text.length && /[0-9]/.test(text[i])) i++;
      continue;
    }
    i++;
  }
  return n;
}

export function sqlShape(sql) {
  const parts = splitStatements(sql);
  if (parts.length !== 1) return '';
  return parts[0].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Keywords and identifiers, in order. Comments are dropped. A quoted identifier
// is its text. A string literal is omitted, so it cannot impersonate a verb.
export function leadingWords(sql) {
  const text = String(sql ?? '');
  const words = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
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
      if (name) words.push(name.toLowerCase());
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = wordAt(text, i);
      words.push(word.toLowerCase());
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
  if (/^(insert|update|delete|replace|create|drop|alter|reindex|vacuum)$/.test(verb)) return true;
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
    if (depth === 0 && /[A-Za-z_]/.test(c)) {
      const word = wordAt(text, i).toLowerCase();
      if (/^(insert|update|delete|replace)$/.test(word)) return true;
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
