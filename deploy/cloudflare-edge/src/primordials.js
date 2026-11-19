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
  const methods = [toLower, trim, replace, test, match, some, every, includes];
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
  } catch {
    return null;
  }
  return { toLower, trim, replace, test, match, some, every, includes };
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

export function lower(value) {
  return text(captured && captured.toLower, String(value ?? ''));
}

export function trim(value) {
  return text(captured && captured.trim, String(value ?? ''));
}

export function replace(value, pattern, replacement) {
  if (!captured) return null;
  try {
    const out = captured.replace(String(value ?? ''), pattern, replacement);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

export function test(pattern, value) {
  if (!captured) return null;
  try {
    const out = captured.test(pattern, value);
    return out === true || out === false ? out : null;
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
