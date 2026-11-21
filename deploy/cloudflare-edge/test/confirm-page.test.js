// F3.3 the /confirm page (WOW_SPEC §F3.3, §F3.6). The page script runs against a tiny DOM double that only knows
// createElement, setAttribute, textContent and events: any innerHTML/outerHTML/insertAdjacentHTML use throws. The
// served-at-/confirm assertion (standard CSP, after sign-in) lives in app.test.js (T1-S0).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONFIRM_HTML } from '../src/confirm-page.js';

const script = () => { const m = /<script>([\s\S]*)<\/script>/.exec(CONFIRM_HTML); assert.ok(m); return m[1]; };

class Node {
  constructor(tag, doc) { Object.assign(this, { tagName: tag.toUpperCase(), doc, children: [], attrs: {}, text: '', hidden: false, disabled: false, listeners: {}, value: '' }); }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { throw new Error('innerHTML is never used'); }
  get innerHTML() { throw new Error('innerHTML is never used'); }
  set outerHTML(v) { throw new Error('outerHTML is never used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML is never used'); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  fire(t) { for (const f of this.listeners[t] || []) f({ preventDefault() {} }); }
  focus() { this.doc.activeElement = this; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}
function page(hash = '') {
  const doc = { activeElement: null, createElement: t => new Node(t, doc) };
  const root = new Node('main', doc);
  for (const id of ['confirmInbox', 'confirmDone', 'confirmNext', 'confirmError']) { const n = root.appendChild(new Node('div', doc)); n.setAttribute('id', id); }
  doc.getElementById = id => root.all().find(n => n.getAttribute('id') === id) || null;
  const window = {};
  vm.runInNewContext(script(), { window, document: doc, location: { hash } });
  return { api: window.AtlasConfirm, doc, root, find: sel => root.all().filter(sel) };
}
const EVIL = '<img src=x onerror="alert(1)"> & <b>bold</b>';
const items = () => [
  { request: { id: 'r1' }, reference: { title: 'Title <script>alert(1)</script>', consultant: { name: 'Alex <i>M</i>', role: 'Data' }, revision: 3 },
    claims: [{ id: 'c1', topic: 1, text: EVIL }, { id: 'c2', topic: 3, text: 'Triage fell from 40 to 12 minutes.' }] },
  { request: { id: 'r2' }, reference: { title: 'Second', consultant: { name: 'Kim', role: '' }, revision: 1 }, claims: [{ id: 'c9', topic: 2, text: 'We kept a manual fallback.' }] },
];

test('CONFIRM_HTML is self-contained: no external URL, no <script src>, no link or font, no animation', () => {
  assert.match(CONFIRM_HTML, /^<!doctype html>/i);
  assert.doesNotMatch(CONFIRM_HTML, /<script[^>]+src|https?:\/\/|<link\b|@import|@font-face|url\(/i);
  assert.doesNotMatch(CONFIRM_HTML, /animation|transition|@keyframes|requestAnimationFrame|setInterval/i);
  assert.doesNotMatch(script(), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  for (const id of ['confirmInbox', 'confirmDone']) assert.match(CONFIRM_HTML, new RegExp(`id="${id}"`));
  assert.match(CONFIRM_HTML, /Recorded\. Thank you\. Nothing else is shared\./);
  assert.match(CONFIRM_HTML, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.equal((CONFIRM_HTML.match(/<\/script/g) || []).length, 1);
});

test('escaping: every text reaches the DOM through textContent only, even hostile claim, title and name text', () => {
  const { api, find } = page();
  const h = api.render(items(), '');
  assert.equal(h.textContent, 'Confirm 2 points for Alex <i>M</i>, about 60 seconds');
  assert.equal(find(n => n.getAttribute('class') === 'text')[0].textContent, EVIL);
  assert.ok(find(n => n.textContent === 'Title <script>alert(1)</script> · revision 3').length >= 1);
  assert.equal(find(n => ['IMG', 'SCRIPT', 'B', 'I'].includes(n.tagName)).length, 0, 'no element ever comes from data');
  assert.equal(api.el('p', { 'data-x': '"><img>' }, '<i>x</i>').textContent, '<i>x</i>');
  assert.equal(api.heading({ claims: [{}], reference: { consultant: { name: '' } } }), 'Confirm 1 point for a colleague, about 60 seconds');
  const opaque = page();
  opaque.api.render([{ request: { id: 'r9' }, reference: { handle: 'r9' }, claims: [{ id: 'c', topic: 1, text: 'A point.' }] }], '');
  const line = opaque.find(n => n.getAttribute('class') === 'muted').map(n => n.textContent).join('\n');
  assert.equal(line.includes('undefined'), false);
  assert.match(line, /Confirmation request/);
});

test('flow: three buttons per claim; Correct reveals a required note; #confirmSubmit enables only when all are decided', () => {
  const { api, doc, find } = page();
  api.render(items(), '');
  const buttons = find(n => n.tagName === 'BUTTON' && n.getAttribute('data-decision'));
  assert.deepEqual(buttons.map(b => b.getAttribute('data-decision')), ['confirm', 'correct', 'cant_say', 'confirm', 'correct', 'cant_say']);
  const submit = doc.getElementById('confirmSubmit');
  assert.equal(submit.disabled, true);
  buttons[0].fire('click');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true'); assert.equal(submit.disabled, true);
  buttons[4].fire('click');
  const note = doc.getElementById('note-1'), wrap = note.parentNode;
  assert.equal(wrap.hidden, false); assert.equal(doc.activeElement, note, 'Correct focuses its note');
  assert.equal(submit.disabled, true, 'a correction needs a note');
  note.value = '  '; note.fire('input'); assert.equal(submit.disabled, true);
  note.value = 'It was 15 minutes.'; note.fire('input'); assert.equal(submit.disabled, false);
  buttons[5].fire('click');
  assert.equal(wrap.hidden, true); assert.deepEqual(buttons.slice(3).map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assert.equal(api.ready(), true); assert.equal(submit.disabled, false);
  assert.equal(doc.getElementById('note-0').parentNode.hidden, true, 'no note field unless Correct');
});

test('the confirm page steps through confirmStep', () => {
  const { api } = page();
  assert.match(script(), /function confirmStep/);
  assert.match(script(), /confirmStep\(\{ phase: state\.phase/);
  api.render(items(), '');
  assert.equal(api.state.phase, 'choosing');
  api.render(items(), '');
  assert.equal(api.state.phase, 'choosing');
  assert.equal(api.render([], ''), null);
  assert.equal(api.state.phase, 'empty');
});

test('deep link: #<reqId> focuses that request; an unknown id says so and shows the first; an empty inbox says nothing is waiting', () => {
  const { api, find } = page('#r2');
  const h = api.render(items(), '#r2');
  assert.equal(h.getAttribute('data-request'), 'r2'); assert.equal(h.textContent, 'Confirm 1 point for Kim, about 60 seconds');
  assert.deepEqual(find(n => n.tagName === 'A').map(a => [a.getAttribute('href'), a.textContent]), [['#r1', 'Confirm 2 points for Alex <i>M</i>, about 60 seconds']]);
  const other = api.render(items(), '#gone');
  assert.equal(other.getAttribute('data-request'), 'r1');
  assert.ok(find(n => n.getAttribute('role') === 'note' && /no longer open/.test(n.textContent)).length === 1);
  assert.equal(api.render([], ''), null);
  assert.ok(find(n => n.tagName === 'H1' && n.textContent === 'Nothing to confirm').length === 1);
});
