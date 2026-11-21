'use strict';
// Inspector on slice 2 at 4221a51f, report 30b60570. These fail until the summary
// rides the session bus, the read-back can be labelled and saved, and a long
// quote is not clipped. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('a summary event is on the live session bus', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'voice-client.js'), 'utf8');
  const list = src.match(/const SESSION_EVENTS=\[(.*?)\]/);
  assert.ok(list, 'SESSION_EVENTS is declared');
  assert.match(list[1], /'summary'/);
  assert.match(src, /if\(SESSION_EVENTS\.includes\(m\.type\)\)sessionEvent\(m\)/);
});

test('an 1800-character read-back quote is not clipped', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'storyboard.css'), 'utf8');
  const board = css.match(/\.story-board\{[^}]+\}/);
  assert.ok(board);
  assert.doesNotMatch(board[0], /overflow:\s*hidden/);
  assert.doesNotMatch(board[0], /390px/);
  const quote = css.match(/\.story-board p\.board-quote\{[^}]+\}/);
  assert.ok(quote, 'the read-back quote has its own rule');
  assert.match(quote[0], /overflow:\s*visible/);
  assert.match(quote[0], /max-height:\s*none/);
  assert.match(quote[0], /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(quote[0], /390px/);
});

function element(tag) {
  const node = {
    tagName: tag, id: '', className: '', hidden: false, textContent: '', value: '',
    htmlFor: '', ariaLabel: '', ariaLive: '', dataset: {}, style: {}, children: [], parent: null, listeners: {},
  };
  node.append = (...kids) => { for (const k of kids) { k.parent = node; node.children.push(k); } };
  node.replaceChildren = (...kids) => { node.children = []; if (kids.length) node.append(...kids); };
  node.addEventListener = (type, fn) => { (node.listeners[type] ||= []).push(fn); };
  node.querySelector = () => null;
  node.querySelectorAll = sel => {
    const out = [];
    const walk = n => {
      if (sel === 'input' && n.tagName === 'input') out.push(n);
      if (sel === 'label' && n.tagName === 'label') out.push(n);
      if (sel === 'button' && n.tagName === 'button') out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(node);
    return out;
  };
  node.focus = () => { global.document.activeElement = node; };
  node.remove = () => { if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node); };
  return node;
}

function findId(node, id) {
  if (node && node.id === id) return node;
  for (const c of node?.children || []) { const hit = findId(c, id); if (hit) return hit; }
  return null;
}

function memoryStorage(seed) {
  const data = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}

function loadBoard(storage) {
  const body = element('body');
  const ids = {};
  const add = (id, tag) => { const n = element(tag); n.id = id; body.append(n); ids[id] = n; return n; };
  add('storyBoard', 'section');
  add('gapPanel', 'section');
  add('gapSend', 'button');
  add('gapApply', 'button');
  add('boardSummary', 'p');
  add('boardCoverage', 'p');
  add('boardTime', 'div');
  add('boardTimeLeft', 'span');
  add('boardPhase', 'span');
  add('boardTimeBar', 'div');
  add('boardGaps', 'section');
  add('boardMap', 'section');
  add('boardMetrics', 'section');
  add('boardDims', 'section');
  add('boardChallenge', 'section');
  add('gapResults', 'div');
  add('gapMessage', 'p');
  for (const id of ['boardGaps', 'boardMap', 'boardMetrics', 'boardDims', 'boardChallenge']) {
    const inner = element('div'); inner.className = 'board-body'; ids[id].append(inner);
    ids[id].querySelector = sel => (sel === '.board-body' ? inner : null);
  }
  const listeners = {};
  global.document = {
    body,
    activeElement: null,
    getElementById: id => ids[id] || findId(body, id),
    createElement: tag => element(tag),
    createElementNS: () => element('svg'),
    querySelector: () => null,
  };
  global.window = {
    AtlasSafe: { html: () => '', setHTML() {}, insertHTML() {}, trusted: () => '' },
    AtlasBoard: { model: () => ({}), diff: () => [], summaryText: () => '' },
    ATLAS_POLICY: { FIELDS: { outcome: ['Outcome', 'What changed?'] } },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    matchMedia: () => ({ matches: false }),
    sessionStorage: storage || undefined,
  };
  const src = fs.readFileSync(path.join(root, 'src', 'storyboard-ui.js'), 'utf8');
  vm.runInThisContext(src, { filename: 'storyboard-ui.js' });
  return {
    listeners,
    dispatch(type, detail) { for (const fn of listeners[type] || []) fn({ detail }); },
    readback: () => global.document.getElementById('boardReadback'),
  };
}

const ITEMS = [
  { detail_id: 'D-001', field: 'outcome', label: 'Outcome', quote: 'synthetic outcome number 1 for the cohort' },
];

test('the read-back labels each correction, saves it, and announces it', () => {
  const storage = memoryStorage();
  const draft = 'synthetic unsaved correction about the pilot cohort';
  const board = loadBoard(storage);
  board.dispatch('atlas-session', { type: 'summary', items: ITEMS });
  const box = board.readback();
  const input = box.querySelectorAll('input').find(n => n.dataset.detail === 'D-001');
  const label = box.querySelectorAll('label').find(n => n.htmlFor && n.htmlFor === input.id);
  assert.ok(label, 'the correction input has a label');
  assert.equal(label.textContent, 'Outcome');
  assert.match(input.ariaLabel, /Outcome/);
  const live = global.document.getElementById('boardReadbackLive');
  assert.equal(live.ariaLive, 'polite');
  assert.ok(live.textContent, 'the live region announces the summary');
  const save = box.querySelectorAll('button').find(n => n.textContent === 'Save draft');
  assert.ok(save, 'the read-back has a save control');
  input.value = draft;
  for (const fn of input.listeners.input || []) fn();
  for (const fn of save.listeners.click || []) fn();
  const kept = JSON.parse(storage.getItem('atlas-readback-draft'));
  assert.equal(kept['D-001'], draft);
  assert.match(live.textContent, /saved/i);
  const again = loadBoard(storage);
  again.dispatch('atlas-session', { type: 'summary', items: ITEMS });
  const restored = again.readback().querySelectorAll('input').find(n => n.dataset.detail === 'D-001');
  assert.equal(restored.value, draft);
});

test('without storage the read-back says a reload drops the draft', () => {
  const board = loadBoard(null);
  board.dispatch('atlas-session', { type: 'summary', items: ITEMS });
  const live = global.document.getElementById('boardReadbackLive');
  assert.match(live.textContent, /A reload drops this draft/);
});
