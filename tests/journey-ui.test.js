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
    AtlasAuth: { boot: async () => ({}) },
    ATLAS_APP: { libraryApi, download() {}, bootInfo: async () => ({ library: true, libraryRole: 'user' }) },
  };
  const location = { hostname: 'atlas.example' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/journey-ui.js'), 'utf8'), { window, document, location }, { filename: 'journey-ui.js' });
  return { window, document };
}

test('the journey queue uses status labels instead of raw tokens', async () => {
  const { window, document } = bootJourney(async path => {
    if (path === '/journey') return {
      stages: [{ id: 'spotlight', title: 'Spotlight', current: true }],
      fields: {}, confirmed: {}, publication: 'Not public.',
      roles: { explanation: '', decision: '', matches: [] },
      integrations: { spotlight: { reason: 'Blocked.' } },
    };
    if (path === '/privacy/disclosure') return { consent: { interview: 'recorded' }, recording: '', textOnly: '', retention: { appTelemetryDays: 30, vendorDeletion: 'not-asserted' }, lawfulBasis: '', biometrics: '' };
    if (path === '') return { items: [
      { id: 'w', title: 'Withdrawn story', status: 'withdrawn', access: 'public', mine: true },
      { id: 'n', title: 'Needs work story', status: 'needs_work', access: 'public', mine: true },
      { id: 'a', title: 'Admin test story', status: 'admin_test', access: 'public', mine: true },
      { id: 'm', title: 'Waiting story', status: 'awaiting_validation', access: 'full', mine: false, managerDecision: 'approved', presalesDecision: 'pending' },
    ] };
    throw new Error('unexpected ' + path);
  });
  window.AtlasJourney.render('journey');
  const root = document.getElementById('journey');
  let labels = [];
  for (let i = 0; i < 20 && labels.length < 4; i++) {
    await new Promise(resolve => setImmediate(resolve));
    labels = root.all().filter(node => node.getAttribute('class') === 'tiny').map(node => node.textContent);
  }
  assert.deepEqual(labels, ['Withdrawn', 'Needs work', 'Admin test, not public', 'Manager approved · awaiting pre-sales']);
});
