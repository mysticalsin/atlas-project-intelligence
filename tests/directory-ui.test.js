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
    this.listeners = {};
    this.parentNode = null;
    this._text = '';
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
}

test('the people directory stays hidden until /directory settles', async () => {
  const document = { ids: {} };
  document.createElement = tag => new Node(tag, document);
  document.createTextNode = text => { const node = new Node('#text', document); node.textContent = text; return node; };
  document.getElementById = id => document.ids[id] || null;
  const panel = document.createElement('section');
  panel.hidden = true;
  panel.setAttribute('id', 'peopleDirectory');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const window = {
    AtlasProfileCore: {},
    AtlasAuth: {
      mode: 'live',
      dirty() {},
      boot: async () => ({ libraryRole: 'admin', features: { profile: true }, library: true }),
    },
    ATLAS_APP: {
      libraryApi: async route => {
        if (route === '/directory') { calls += 1; return pending; }
        throw new Error(route);
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/profile-ui.js'), 'utf8'), { window, document, Node }, { filename: 'profile-ui.js' });
  const rendered = window.AtlasProfile.renderDirectory();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(panel.hidden, true);
  assert.equal(panel.textContent.includes('only synthetic addresses'), false);
  release({ dataMode: 'test', rows: { dna: 0, dna_export: 2 }, sources: { push: { status: 'off' }, pull: { status: 'off', needs: [] } } });
  await rendered;
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /only synthetic addresses/);
  assert.match(panel.textContent, /DNA push: not connected/);
});
