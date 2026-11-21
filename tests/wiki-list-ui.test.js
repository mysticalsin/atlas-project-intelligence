'use strict';
// The wiki screen must follow the catalogue cursor past 200 stories and keep each row's gap count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function element() {
  return {
    hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '',
    dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    showModal() {}, click() {}, replaceChildren() {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
  };
}

test('the wiki screen follows next past 200 stories and keeps the gap count', async () => {
  const ids = new Map();
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, element());
      return ids.get(id);
    },
  };
  const calls = [];
  const story = (index, gaps) => ({
    id: 'story-' + index,
    title: 'Synthetic catalogue story ' + index,
    stage: 'Pilot',
    audience: 'internal',
    eligible: false,
    revision: 1,
    content_hash: 'abcdef0123456789',
    quality_gap_count: gaps,
  });
  const fetch = async (requestPath) => {
    calls.push(String(requestPath));
    const url = new URL(requestPath, 'http://atlas.example.test');
    const audience = url.searchParams.get('audience');
    const after = url.searchParams.get('after');
    let body = { stories: [], limit: 200, next: null, truncated: false };
    if (audience === 'internal' && !after) {
      const stories = Array.from({ length: 200 }, (_, index) => story(index, index === 0 ? 2 : 0));
      body = { stories, limit: 200, next: 'story-199', truncated: true };
    } else if (audience === 'internal' && after === 'story-199') {
      body = { stories: [story(200, 3)], limit: 200, next: null, truncated: false };
    }
    return { ok: true, json: async () => body, text: async () => '' };
  };
  const window = {
    addEventListener() {},
    AtlasSafe: require('../src/safe-html.js'),
    AtlasQuality: { fields: {}, sections: [], esc: value => String(value ?? '') },
    AtlasVoice: { bootstrap: () => ({ csrf: 'csrf' }), checkConnection: async () => ({ csrf: 'csrf' }), status: () => ({ phase: 'idle' }) },
    confirm: () => false,
  };
  const location = { protocol: 'http:', hostname: 'atlas.example.test' };
  const ui = fs.readFileSync(path.join(__dirname, '../src/intelligence-ui.js'), 'utf8');
  vm.runInNewContext(ui, { window, document, location, fetch, AbortSignal, URL }, { filename: 'intelligence-ui.js' });
  const button = document.getElementById('wikiLoad');
  await button.onclick({ currentTarget: button });
  const rows = document.getElementById('wikiRows').innerHTML;
  const note = document.getElementById('wikiMessage').textContent;
  assert.ok(calls.some(path => path.includes('audience=internal') && path.includes('after=story-199')), calls.join(' | '));
  assert.ok(rows.includes('Synthetic catalogue story 200'), rows.slice(0, 200));
  assert.ok(rows.includes('2 concrete review gaps'), rows);
  assert.ok(rows.includes('3 concrete review gaps'), rows);
  assert.match(note, /201/);
});
