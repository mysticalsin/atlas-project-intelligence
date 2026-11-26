// The confirmation page must follow the inbox cursor. The library returns at most
// 50 open rows. Rows that are no longer current are left out of items, and the
// cursor still points at the next raw row. Stopping after the first response hides
// a later open request, including when that first response has no items.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONFIRM_HTML } from '../src/confirm-page.js';

const script = () => {
  const found = /<script>([\s\S]*)<\/script>/.exec(CONFIRM_HTML);
  assert.ok(found);
  return found[1];
};

class Node {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), doc, children: [], attrs: {}, text: '', hidden: false, disabled: false, listeners: {}, value: '' });
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); return child; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { this.doc.activeElement = this; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

function item(id, title) {
  return {
    request: { id },
    reference: { title, consultant: { name: 'Ada' }, revision: 1 },
    claims: [{ id: id + '-c', topic: 1, text: 'The queue was shorter after the change.' }],
  };
}

function page(routes) {
  const doc = { activeElement: null, createElement: tag => new Node(tag, doc) };
  const root = new Node('main', doc);
  for (const id of ['confirmInbox', 'confirmDone', 'confirmNext', 'confirmError']) {
    const node = root.appendChild(new Node('div', doc));
    node.setAttribute('id', id);
  }
  doc.getElementById = id => root.all().find(node => node.getAttribute('id') === id) || null;
  const calls = [];
  function fetch(url) {
    calls.push(String(url));
    const hit = routes[String(url)];
    if (!hit) return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'missing' }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(hit) });
  }
  const window = { addEventListener() {} };
  vm.runInNewContext(script(), { window, document: doc, location: { hash: '' }, fetch });
  return { calls, root, doc };
}

function headings(root) {
  return root.all().filter(node => node.tagName === 'H1').map(node => node.textContent);
}

const CURSOR = { afterCreatedAt: '2026-11-01T00:00:00.000Z', afterId: 'old-row' };
const NEXT = '/api/library/confirmations/inbox?afterCreatedAt=' + encodeURIComponent(CURSOR.afterCreatedAt) + '&afterId=' + encodeURIComponent(CURSOR.afterId);

test('an empty first inbox page still shows the open request on the next page', async () => {
  const { calls, root, doc } = page({
    '/api/bootstrap': { csrf: 'token', features: { claims: true } },
    '/api/library/confirmations/inbox': { items: [], truncated: true, next: CURSOR },
    [NEXT]: { items: [item('later', 'Later request')], next: null },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['/api/bootstrap', '/api/library/confirmations/inbox', NEXT]);
  assert.deepEqual(headings(root), ['Confirm 1 point for Ada, about 60 seconds']);
  assert.equal(root.all().some(node => node.getAttribute('data-request') === 'later'), true);
  assert.equal(doc.getElementById('confirmError').hidden, true);
});

test('a full first page does not hide the open request on the next page', async () => {
  const { calls, root } = page({
    '/api/bootstrap': { csrf: 'token', features: { claims: true } },
    '/api/library/confirmations/inbox': { items: [item('first', 'First request')], truncated: true, next: CURSOR },
    [NEXT]: { items: [item('later', 'Later request')], next: null },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['/api/bootstrap', '/api/library/confirmations/inbox', NEXT]);
  const links = root.all().filter(node => node.tagName === 'A').map(node => node.getAttribute('href'));
  assert.deepEqual(links, ['#later']);
  assert.equal(root.all().some(node => node.getAttribute('data-request') === 'first'), true);
  assert.equal(root.all().some(node => node.textContent.includes('First request')), true);
  assert.equal(headings(root).some(text => text === 'Nothing to confirm'), false);
});

test('a repeated inbox cursor is requested once', async () => {
  const repeated = { items: [], truncated: true, next: CURSOR };
  const { calls, root } = page({
    '/api/bootstrap': { csrf: 'token', features: { claims: true } },
    '/api/library/confirmations/inbox': repeated,
    [NEXT]: repeated,
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['/api/bootstrap', '/api/library/confirmations/inbox', NEXT]);
  assert.deepEqual(headings(root), ['Nothing to confirm']);
});
