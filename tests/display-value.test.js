// Shared display text for a record field that may not be a string.
// node --test tests/display-value.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'display-value.js');
let displayValue = null;
let PLACEHOLDER = null;
try {
  ({displayValue, PLACEHOLDER} = require(file));
} catch (e) {
  displayValue = null;
}

const show = (v) => displayValue(v);

test('displayValue is a function and the module does not use innerHTML', () => {
  assert.equal(typeof displayValue, 'function', displayValue === null ? 'missing src/display-value.js' : typeof displayValue);
  const src = fs.readFileSync(file, 'utf8');
  assert.equal(src.includes('innerHTML'), false);
  assert.equal(typeof PLACEHOLDER, 'string');
  assert.equal(PLACEHOLDER.includes('[object'), false);
  assert.equal(PLACEHOLDER.length > 0, true);
});

test('strings and numbers are text', () => {
  assert.equal(show('Ada'), 'Ada');
  assert.equal(show(''), '');
  assert.equal(show('  lead  '), '  lead  ');
  assert.equal(show('<b>Ada</b>'), '<b>Ada</b>');
  assert.equal(show('0'), '0');
  assert.equal(show(0), '0');
  assert.equal(show(-0), '0');
  assert.equal(show(2), '2');
  assert.equal(show(-4), '-4');
  assert.equal(show(1.5), '1.5');
  assert.equal(show(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
});

test('a known object uses its label field', () => {
  assert.equal(show({label: 'Delivery lead'}), 'Delivery lead');
  assert.equal(show({label: 2, name: 'ignored'}), '2');
  assert.equal(show({label: 0}), '0');
  assert.equal(show({label: ''}), '');
  assert.equal(show({label: 'Lead', role: {label: 'other'}}), 'Lead');
});

test('null, arrays, and nested objects are the placeholder', () => {
  assert.equal(show(null), PLACEHOLDER);
  assert.equal(show(undefined), PLACEHOLDER);
  assert.equal(show([]), PLACEHOLDER);
  assert.equal(show(['Lead']), PLACEHOLDER);
  assert.equal(show([1, {label: 'Lead'}]), PLACEHOLDER);
  assert.equal(show({label: {label: 'Lead'}}), PLACEHOLDER);
  assert.equal(show({label: ['Lead']}), PLACEHOLDER);
  assert.equal(show({name: 'Ada', role: 'Lead'}), PLACEHOLDER);
  assert.equal(show({hours: 12}), PLACEHOLDER);
  assert.equal(show({}), PLACEHOLDER);
});

test('boundaries stay text or the placeholder and never the default object string', () => {
  for (const v of [true, false, NaN, Infinity, -Infinity, 1n, Symbol('role'), () => 'Ada', new Date(0), Object.create(null)]) {
    const out = show(v);
    assert.equal(typeof out, 'string', String(v));
    assert.equal(out.includes('[object'), false, String(v));
  }
  const lying = {toString() { return '[object Object]'; }, valueOf() { return 'Ada'; }};
  assert.equal(show(lying), PLACEHOLDER);
  assert.equal(show({label: lying}), PLACEHOLDER);
  const quoted = '[object Object]';
  assert.equal(show(quoted), quoted);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randomValue(rng, depth) {
  const kind = pick(rng, depth > 2 ? ['string', 'number', 'null', 'bool'] : ['string', 'number', 'null', 'bool', 'array', 'object', 'label']);
  if (kind === 'string') {
    const alphabet = 'Ada lead 0123456789 .,;-_';
    const n = Math.floor(rng() * 12);
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
    return s;
  }
  if (kind === 'number') {
    const special = [0, -0, 1, -1, 0.5, -2.25, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    if (rng() < 0.3) return pick(rng, special);
    return Math.floor(rng() * 2000) - 1000;
  }
  if (kind === 'null') return rng() < 0.5 ? null : undefined;
  if (kind === 'bool') return rng() < 0.5;
  if (kind === 'array') {
    const n = Math.floor(rng() * 4);
    return Array.from({length: n}, () => randomValue(rng, depth + 1));
  }
  if (kind === 'label') {
    const labelKind = pick(rng, ['string', 'number', 'object', 'null']);
    return {label: labelKind === 'object' ? {label: 'nested'} : randomValue(rng, depth + 1), extra: randomValue(rng, depth + 1)};
  }
  const obj = {};
  const n = Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) obj['k' + i] = randomValue(rng, depth + 1);
  return obj;
}

test('property: random values render as a string and never contain [object', () => {
  assert.equal(typeof displayValue, 'function');
  const rng = mulberry32(0xA71A5);
  for (let i = 0; i < 200; i++) {
    const value = randomValue(rng, 0);
    const out = show(value);
    assert.equal(typeof out, 'string', 'index ' + i);
    assert.equal(out.includes('[object'), false, 'index ' + i + ' ' + Object.prototype.toString.call(value));
  }
});
