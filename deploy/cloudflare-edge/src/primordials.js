// Methods captured once, at load, unbound from the live prototypes.
// Function.prototype.bind.bind(Function.prototype.call) freezes the uncurry.
// A later patch of call, apply, bind, or Reflect.apply does not reach these.
// A snapshot that is not the real method fails closed: callers treat that as a write.

const bind = Function.prototype.bind;
const call = Function.prototype.call;

function take(un, fn) {
  if (typeof un !== 'function' || typeof fn !== 'function') return null;
  try {
    const bound = un(fn);
    return typeof bound === 'function' ? bound : null;
  } catch {
    return null;
  }
}

function snapshot() {
  if (typeof bind !== 'function' || typeof call !== 'function') return null;
  let uncurry;
  try { uncurry = bind.bind(call); }
  catch { return null; }
  const toLower = take(uncurry, String.prototype.toLowerCase);
  const trim = take(uncurry, String.prototype.trim);
  const replace = take(uncurry, String.prototype.replace);
  const test = take(uncurry, RegExp.prototype.test);
  const match = take(uncurry, RegExp.prototype.exec);
  const some = take(uncurry, Array.prototype.some);
  const every = take(uncurry, Array.prototype.every);
  const includes = take(uncurry, Array.prototype.includes);
  const slice = take(uncurry, String.prototype.slice);
  const push = take(uncurry, Array.prototype.push);
  const charCodeAt = take(uncurry, String.prototype.charCodeAt);
  const toISOString = take(uncurry, Date.prototype.toISOString);
  const min = typeof Math.min === 'function' ? Math.min : null;
  const find = take(uncurry, Array.prototype.find);
  const cast = typeof String === 'function' ? String : null;
  const dateParse = typeof Date.parse === 'function' ? Date.parse : null;
  const dateNow = typeof Date.now === 'function' ? Date.now : null;
  const methods = [toLower, trim, replace, test, match, some, every, includes, slice, push, charCodeAt, toISOString, min, find, cast, dateParse, dateNow];
  for (let i = 0; i < methods.length; i++) if (methods[i] == null) return null;
  try {
    if (toLower('Ab') !== 'ab') return null;
    if (trim(' x ') !== 'x') return null;
    if (replace('ab', 'a', 'c') !== 'cb') return null;
    if (test(/a/, 'a') !== true || test(/a/, 'b') !== false) return null;
    const found = match(/^ab$/, 'ab');
    if (found == null || found[0] !== 'ab') return null;
    if (match(/^ab$/, 'c') !== null) return null;
    if (some([1], (n) => n === 1) !== true || some([1], (n) => n === 2) !== false) return null;
    if (every([1], (n) => n === 1) !== true) return null;
    if (includes(['or'], 'or') !== true || includes(['or'], 'no') !== false) return null;
    if (slice('abcd', 1, 3) !== 'bc' || slice('abcd', 2) !== 'cd') return null;
    const probe = [];
    if (push(probe, 'a') !== 1 || probe.length !== 1 || probe[0] !== 'a') return null;
    if (charCodeAt('A', 0) !== 65) return null;
    if (toISOString(new Date(0)) !== '1970-01-01T00:00:00.000Z') return null;
    if (min(2, 5) !== 2 || min(5, 2) !== 2) return null;
    if (cast('Ab') !== 'Ab' || cast(1) !== '1') return null;
    const foundItem = find([{ id: 'a' }, { id: 'b' }], (item) => item.id === 'b');
    if (!foundItem || foundItem.id !== 'b') return null;
    if (find([{ id: 'a' }], (item) => item.id === 'z') !== undefined) return null;
    if (dateParse('1970-01-01T00:00:00.000Z') !== 0) return null;
    if (typeof dateNow() !== 'number' || !Number.isFinite(dateNow())) return null;
  } catch {
    return null;
  }
  return { toLower, trim, replace, test, match, some, every, includes, slice, push, charCodeAt, toISOString, min, find, cast, dateParse, dateNow };
}

const captured = snapshot();

export function primordialsHold() {
  return captured != null;
}

function text(fn, value) {
  if (!captured) return null;
  try {
    const out = fn(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

function asText(value) {
  if (!captured) return '';
  try {
    const out = captured.cast(value ?? '');
    return typeof out === 'string' ? out : '';
  } catch {
    return '';
  }
}

export function lower(value) {
  return text(captured && captured.toLower, asText(value));
}

export function trim(value) {
  return text(captured && captured.trim, asText(value));
}

export function replace(value, pattern, replacement) {
  if (!captured) return null;
  try {
    const out = captured.replace(asText(value), pattern, replacement);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

// Calls the exec captured at load. RegExp.prototype.test would look exec up
// on the live prototype, so a later patch of exec would decide the answer.
export function test(pattern, value) {
  if (!captured) return null;
  try {
    const out = captured.match(pattern, value);
    if (out == null) return false;
    return typeof out === 'object' ? true : null;
  } catch {
    return null;
  }
}

export function match(pattern, value) {
  if (!captured) return undefined;
  try {
    const out = captured.match(pattern, value);
    if (out == null) return null;
    return typeof out === 'object' ? out : undefined;
  } catch {
    return undefined;
  }
}

export function some(list, fn) {
  if (!captured || typeof fn !== 'function') return null;
  try {
    const out = captured.some(list, fn);
    return out === true || out === false ? out : null;
  } catch {
    return null;
  }
}

export function every(list, fn) {
  if (!captured || typeof fn !== 'function') return null;
  try {
    const out = captured.every(list, fn);
    return out === true || out === false ? out : null;
  } catch {
    return null;
  }
}

export function includes(list, value) {
  if (!captured) return null;
  try {
    const out = captured.includes(list, value);
    return out === true || out === false ? out : null;
  } catch {
    return null;
  }
}

function spanOf(text, start, end) {
  const n = text.length;
  let a = start === undefined ? 0 : Number(start);
  let b = end === undefined ? n : Number(end);
  if (!Number.isFinite(a)) a = 0;
  if (!Number.isFinite(b)) b = n;
  a = Math.trunc(a);
  b = Math.trunc(b);
  if (a < 0) a = Math.max(n + a, 0);
  else if (a > n) a = n;
  if (b < 0) b = Math.max(n + b, 0);
  else if (b > n) b = n;
  if (b < a) b = a;
  let out = '';
  for (let i = a; i < b; i++) out += text[i];
  return out;
}

// Null when the captured slice is missing or the text is not the requested span.
export function slice(value, start, end) {
  if (!captured) return null;
    const text = captured.cast(value ?? '');
    if (typeof text !== 'string') return null;
  try {
    const out = end === undefined ? captured.slice(text, start) : captured.slice(text, start, end);
    if (typeof out !== 'string') return null;
    if (out !== spanOf(text, start, end)) return null;
    return out;
  } catch {
    return null;
  }
}

export function push(list, value) {
  if (!captured || list == null) return null;
  try {
    const before = list.length;
    const out = captured.push(list, value);
    if (typeof out !== 'number' || list.length !== before + 1 || list[before] !== value) return null;
    return out;
  } catch {
    return null;
  }
}

export function charCodeAt(value, index) {
  if (!captured) return null;
  try {
    const text = captured.cast(value ?? '');
    if (typeof text !== 'string') return null;
    const out = captured.charCodeAt(text, index);
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

function finiteIso(text) {
  if (typeof text !== 'string' || text.length !== 24) return false;
  if (text[4] !== '-' || text[7] !== '-' || text[10] !== 'T' || text[13] !== ':' || text[16] !== ':' || text[19] !== '.' || text[23] !== 'Z') return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '-' || text[i] === 'T' || text[i] === ':' || text[i] === '.' || text[i] === 'Z') continue;
    const n = charCodeAt(text, i);
    if (typeof n !== 'number' || n < 48 || n > 57) return false;
  }
  return parseDate(text) != null;
}

// A finite UTC timestamp, or null. A patched toISOString does not move it.
export function isoFrom(ms) {
  if (!captured || typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try {
    const out = captured.toISOString(new Date(ms));
    if (!finiteIso(out)) return null;
    if (parseDate(out) !== ms) return null;
    return out;
  } catch {
    return null;
  }
}

export function least(a, b) {
  if (!captured) return null;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    const out = captured.min(x, y);
    if (typeof out !== 'number' || out !== (x < y ? x : y)) return null;
    return out;
  } catch {
    return null;
  }
}

export function textOf(value) {
  if (!captured) return null;
  try {
    const out = captured.cast(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

export function find(list, fn) {
  if (!captured || typeof fn !== 'function' || list == null) return null;
  try {
    const out = captured.find(list, fn);
    if (out === undefined) return undefined;
    let seen = false;
    for (let i = 0; i < list.length; i++) if (list[i] === out) seen = true;
    return seen ? out : null;
  } catch {
    return null;
  }
}

export function parseDate(value) {
  if (!captured) return null;
  try {
    const out = captured.dateParse(value);
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

export function nowMs() {
  if (!captured) return null;
  try {
    const out = captured.dateNow();
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

export function clockIso() {
  const ms = nowMs();
  if (typeof ms !== 'number') return null;
  return isoFrom(ms);
}
