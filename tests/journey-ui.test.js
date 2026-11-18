'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Node {
  constructor(tag, doc) {
    this.tagName = String(tag || '').toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.listeners = {};
    this.parentNode = null;
    this._text = '';
    this.value = '';
  }
  setAttribute(name, value) {
    if (name === 'id' && this.attrs.id && this.doc.ids[this.attrs.id] === this) delete this.doc.ids[this.attrs.id];
    this.attrs[name] = String(value);
    if (name === 'id') this.doc.ids[this.attrs.id] = this;
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  set textContent(value) { this.children = []; this._text = String(value ?? ''); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.all().find(node => node.getAttribute('id') === sel.slice(1)) || null;
    return null;
  }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

function documentStub() {
  const doc = { ids: {} };
  doc.createElement = tag => new Node(tag, doc);
  doc.createTextNode = text => ({ textContent: String(text ?? ''), parentNode: null, children: [], tagName: '#text', all() { return [this]; } });
  doc.getElementById = id => doc.ids[id] || null;
  const journey = doc.createElement('section');
  journey.setAttribute('id', 'journey');
  const admin = doc.createElement('button');
  admin.setAttribute('id', 'adminNav');
  return doc;
}

function bootJourney(libraryApi) {
  const document = documentStub();
  const window = {
    addEventListener() {},
    AtlasSafe: {},
    AtlasAuth: { boot: async () => ({}) },
    ATLAS_APP: { libraryApi, download() {}, bootInfo: async () => ({ library: true, libraryRole: 'user' }) },
  };
  const location = { hostname: 'atlas.example' };
  const machine = fs.readFileSync(path.join(__dirname, '../src/erasure-machine.js'), 'utf8').replaceAll('export ', '');
  const ui = fs.readFileSync(path.join(__dirname, '../src/journey-ui.js'), 'utf8');
  vm.runInNewContext(machine + '\n' + ui, { window, document, location }, { filename: 'journey-ui.js' });
  return { window, document };
}

const JOURNEY = {
  stages: [{ id: 'spotlight', title: 'Spotlight', current: true }],
  fields: {}, confirmed: {}, publication: 'Not public.',
  roles: { explanation: '', decision: '', matches: [] },
  integrations: { spotlight: { reason: 'Blocked.' } },
};
const DISCLOSURE = { consent: { interview: 'recorded' }, recording: '', textOnly: '', retention: { appTelemetryDays: 30, vendorDeletion: 'not-asserted' }, lawfulBasis: '', biometrics: '' };
const GOOD = JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: [], summary: 'Strong.' });
const OWNER = { email: 'alex@mantu.com', role: 'user' };
const MANAGER = { email: 'sam@mantu.com', role: 'user' };
const ADMIN = { email: 'admin@example.test', role: 'admin' };
const SYSTEM = { email: 'directory', role: 'system' };

function reference(title) {
  return {
    title, sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' },
    client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
    details: { projectId: 'PRJ-' + title.length, country: 'France', technologies: ['Python'], serviceLines: ['Data & AI'] },
    answers: [
      'Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.',
      'I designed and built the routing model and ran the pilot with two teams.',
      'We compared rules against a model, chose the model, and kept a manual fallback.',
      'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
      'Operations dashboard export v3, before and after quarters.',
      'Any insurer with a measurable queue would benefit.',
    ],
  };
}

async function libraryOfStories() {
  const { Library } = await import('../deploy/cloudflare-edge/src/library.js');
  const { memorySql } = await import('../deploy/cloudflare-edge/test/sqlite.js');
  let t = 0;
  let mode = 'good';
  const l = new Library(memorySql(), {
    now: () => new Date(Date.UTC(2026, 0, 2, 0, 0, t++)).toISOString(),
    complete: async () => (mode === 'bad' ? 'not json' : GOOD),
  });
  const save = async title => l.upsert(OWNER, { localId: title, reference: reference(title) });
  const withdrawn = await save('Withdrawn story');
  l.withdraw(OWNER, withdrawn.id, { note: 'Withdrawn' });
  mode = 'bad';
  const needs = await save('Needs work story');
  await l.review(OWNER, needs.id);
  mode = 'good';
  const testStory = await save('Admin test story');
  await l.adminPublish(ADMIN, testStory.id, { test: true });
  const waiting = await save('Waiting story');
  await l.review(OWNER, waiting.id);
  const open = await save('Open story');
  await l.review(OWNER, open.id);
  l.bindTrust(SYSTEM, { owner: OWNER.email, email: MANAGER.email, source: 'directory', sandbox: true });
  l.validate(MANAGER, waiting.id, { decision: 'validate', lane: 'manager' });
  return { l, waiting: waiting.id, open: open.id };
}

function queueRows(root) {
  return root.all().filter(node => node.tagName === 'ARTICLE').map(node => ({
    title: node.children.find(child => child.tagName === 'STRONG')?.textContent || '',
    label: node.children.find(child => child.getAttribute('class') === 'tiny')?.textContent || '',
    approve: node.all().find(child => child.tagName === 'BUTTON' && child.textContent === 'Approve as trusted manager') || null,
  }));
}

async function settle(root, ready) {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (ready(queueRows(root))) return queueRows(root);
  }
  return queueRows(root);
}

test('a later status wins over a manager approval on real list() output', async () => {
  const { Library } = await import('../deploy/cloudflare-edge/src/library.js');
  const { memorySql } = await import('../deploy/cloudflare-edge/test/sqlite.js');
  let t = 0;
  let mode = 'good';
  const l = new Library(memorySql(), {
    now: () => new Date(Date.UTC(2026, 0, 3, 0, 0, t++)).toISOString(),
    complete: async () => (mode === 'bad' ? 'not json' : GOOD),
  });
  const PRE = { email: 'pre@mantu.com', role: 'presales' };
  const save = async title => l.upsert(OWNER, { localId: title, reference: reference(title) });
  const pulled = await save('Withdrawn after approval');
  await l.review(OWNER, pulled.id);
  l.bindTrust(SYSTEM, { owner: OWNER.email, email: MANAGER.email, source: 'directory', sandbox: true });
  l.validate(MANAGER, pulled.id, { decision: 'validate', lane: 'manager' });
  l.withdraw(OWNER, pulled.id, { note: 'Withdrawn after the manager approved.' });
  mode = 'bad';
  const thin = await save('Needs work after approval');
  await l.review(OWNER, thin.id);
  mode = 'good';
  l.validate(MANAGER, thin.id, { decision: 'validate', lane: 'manager' });
  const changed = await save('Changes after approval');
  await l.review(OWNER, changed.id);
  l.validate(MANAGER, changed.id, { decision: 'validate', lane: 'manager' });
  l.validate(PRE, changed.id, { decision: 'request_changes', lane: 'presales', note: 'Name the source.' });
  const early = await save('In review after approval');
  l.validate(MANAGER, early.id, { decision: 'validate', lane: 'manager' });
  const waiting = await save('Still awaiting pre-sales');
  await l.review(OWNER, waiting.id);
  l.validate(MANAGER, waiting.id, { decision: 'validate', lane: 'manager' });
  const listed = l.list(MANAGER);
  const item = title => listed.items.find(row => row.title === title);
  assert.equal(item('Withdrawn after approval').status, 'withdrawn');
  assert.equal(item('Withdrawn after approval').managerDecision, 'approved');
  assert.equal(item('Needs work after approval').status, 'needs_work');
  assert.equal(item('Needs work after approval').managerDecision, 'approved');
  assert.equal(item('Changes after approval').status, 'changes_requested');
  assert.equal(item('Changes after approval').managerDecision, 'approved');
  assert.equal(item('Changes after approval').presalesDecision, 'changes_requested');
  assert.equal(item('In review after approval').status, 'in_review');
  assert.equal(item('In review after approval').managerDecision, 'approved');
  assert.equal(item('Still awaiting pre-sales').status, 'awaiting_validation');
  assert.equal(item('Still awaiting pre-sales').managerDecision, 'approved');
  const { window, document } = bootJourney(async path => {
    if (path === '/journey') return JOURNEY;
    if (path === '/privacy/disclosure') return DISCLOSURE;
    if (path === '') return listed;
    throw new Error('unexpected ' + path);
  });
  window.AtlasJourney.render('journey');
  const root = document.getElementById('journey');
  const rows = await settle(root, found => found.length >= listed.items.length);
  const label = title => rows.find(row => row.title === title)?.label;
  assert.equal(label('Withdrawn after approval'), 'Withdrawn');
  assert.equal(label('Needs work after approval'), 'Needs work');
  assert.equal(label('Changes after approval'), 'Changes requested');
  assert.equal(label('In review after approval'), 'In review');
  assert.equal(label('Still awaiting pre-sales'), 'Manager approved · awaiting pre-sales');
});

test('the journey queue labels real list() output and drops an approved lane after the click', async () => {
  const { l, waiting, open } = await libraryOfStories();
  const listed = l.list(MANAGER);
  const waitingItem = listed.items.find(item => item.id === waiting);
  const openItem = listed.items.find(item => item.id === open);
  assert.equal(waitingItem.managerDecision, 'approved');
  assert.equal(waitingItem.presalesDecision, 'pending');
  assert.equal(openItem.managerDecision, 'pending');
  const { window, document } = bootJourney(async (path, opts) => {
    if (path === '/journey') return JOURNEY;
    if (path === '/privacy/disclosure') return DISCLOSURE;
    if (path === '') return l.list(MANAGER);
    const match = /^\/([^/]+)\/validate$/.exec(path);
    if (match && opts?.method === 'POST') return l.validate(MANAGER, match[1], opts.body || {});
    throw new Error('unexpected ' + path);
  });
  window.AtlasJourney.render('journey');
  const root = document.getElementById('journey');
  let rows = await settle(root, found => found.length >= listed.items.length);
  const byTitle = Object.fromEntries(rows.map(row => [row.title, row]));
  assert.equal(byTitle['Withdrawn story'].label, 'Withdrawn');
  assert.equal(byTitle['Needs work story'].label, 'Needs work');
  assert.equal(byTitle['Admin test story'].label, 'Admin test, not public');
  assert.equal(byTitle['Waiting story'].label, 'Manager approved · awaiting pre-sales');
  assert.equal(byTitle['Waiting story'].approve, null);
  assert.ok(byTitle['Open story'].approve);
  for (const fn of byTitle['Open story'].approve.listeners.click) fn();
  rows = await settle(root, found => !found.find(row => row.title === 'Open story' && row.approve));
  const after = Object.fromEntries(rows.map(row => [row.title, row]));
  assert.equal(l.list(MANAGER).items.find(item => item.id === open).managerDecision, 'approved');
  assert.equal(after['Open story'].approve, null);
  assert.equal(after['Open story'].label, 'Manager approved · awaiting pre-sales');
});
