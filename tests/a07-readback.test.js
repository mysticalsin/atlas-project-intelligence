'use strict';
// Codex: a summary update must not wipe an unsaved correction. The read-back
// editor is created by src/storyboard-ui.js when a summary event arrives.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag) {
  const node = {
    tagName: tag, id: '', className: '', hidden: false, textContent: '', value: '',
    dataset: {}, style: {}, children: [], parent: null, listeners: {},
  };
  node.append = (...kids) => { for (const k of kids) { k.parent = node; node.children.push(k); } };
  node.replaceChildren = (...kids) => { node.children = []; if (kids.length) node.append(...kids); };
  node.addEventListener = (type, fn) => { (node.listeners[type] ||= []).push(fn); };
  node.querySelector = () => null;
  node.querySelectorAll = sel => {
    const out = [];
    const walk = n => {
      const input = n.tagName === 'input';
      if ((sel === 'input' || sel === 'input[data-detail]') && input && n.dataset.detail) out.push(n);
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

function loadBoard() {
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
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'storyboard-ui.js'), 'utf8');
  vm.runInThisContext(src, { filename: 'storyboard-ui.js' });
  return {
    listeners,
    dispatch(type, detail) { for (const fn of listeners[type] || []) fn({ detail }); },
    readback: () => global.document.getElementById('boardReadback'),
  };
}

test('an unsaved correction survives a summary update', () => {
  const board = loadBoard();
  const draft = 'synthetic unsaved correction about the pilot cohort';
  board.dispatch('atlas-session', { type: 'summary', items: [
    { detail_id: 'D-001', field: 'outcome', label: 'Outcome', quote: 'synthetic outcome number 1 for the cohort' },
    { detail_id: 'D-002', field: 'measurement', label: 'Measurement', quote: 'synthetic measurement for the same cohort' },
  ] });
  const first = board.readback();
  assert.ok(first, 'the summary event builds a read-back editor');
  const editing = first.querySelectorAll('input').find(n => n.dataset.detail === 'D-001');
  assert.ok(editing);
  editing.value = draft;
  editing.focus();
  for (const fn of editing.listeners.input || []) fn();
  board.dispatch('atlas-session', { type: 'summary', items: [
    { detail_id: 'D-001', field: 'outcome', label: 'Outcome', quote: 'synthetic outcome number 1 for the cohort' },
    { detail_id: 'D-002', field: 'measurement', label: 'Measurement', quote: 'synthetic measurement for the same cohort' },
    { detail_id: 'D-003', field: 'evidence', label: 'Evidence', quote: 'synthetic evidence added while the correction was open' },
  ] });
  const inputs = board.readback().querySelectorAll('input');
  assert.equal(inputs.length, 3);
  const again = inputs.find(n => n.dataset.detail === 'D-001');
  assert.equal(again.value, draft);
  assert.equal(global.document.activeElement, again);
});
