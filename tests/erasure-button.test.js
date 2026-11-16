// The journey erasure button confirms, sends one POST, and paints the server note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NOTE = 'Each store reports only what this request removed for this subject and tenant. An error means that store was not removed. Other tenants, other people, and blank-tenant rows are not counted. Stories, staffing, invitations, and audit history are not deleted. Quarantine is not deletion. Vendor deletion is not-asserted. This is not a GDPR certification.';

function walk(root, pred) {
  if (pred(root)) return root;
  for (const child of root.children || []) {
    if (!child || typeof child !== 'object') continue;
    const hit = walk(child, pred);
    if (hit) return hit;
  }
  return null;
}

function element() {
  const listeners = new Map();
  const node = {
    id: '', hidden: false, disabled: false, open: false, textContent: '', value: '',
    className: '', innerHTML: '', style: {}, dataset: {}, children: [], parent: null, onclick: null,
    setAttribute(name, value) {
      if (name === 'id') node.id = value;
      else if (name === 'class') node.className = value;
      else node[name] = value;
    },
    append(...children) {
      for (const child of children) {
        node.children.push(child);
        if (child && typeof child === 'object') child.parent = node;
      }
    },
    replaceChildren(...children) {
      node.children.length = 0;
      node.append(...children);
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
    },
    dispatch(type) {
      for (const fn of listeners.get(type) || []) fn();
    },
    click() { node.dispatch('click'); },
    querySelector(sel) {
      if (String(sel).startsWith('#')) return walk(node, item => item.id === sel.slice(1));
      return null;
    },
    focus() {},
    showModal() { node.open = true; },
    close() { node.open = false; node.dispatch('close'); },
    remove() {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
    },
  };
  return node;
}

function harness() {
  const nodes = new Map();
  const document = {
    getElementById(id) { return nodes.get(id) || null; },
    createElement() { return element(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const orig = document.createElement;
  document.createElement = () => {
    const node = orig();
    const setAttribute = node.setAttribute;
    node.setAttribute = (name, value) => { setAttribute.call(node, name, value); if (name === 'id') nodes.set(value, node); };
    return node;
  };
  for (const id of ['journey', 'admin', 'adminNav', 'confirmDialog', 'confirmTitle', 'confirmText', 'confirmYes']) {
    const node = element();
    node.id = id;
    nodes.set(id, node);
  }
  const posts = [];
  const confirms = [];
  const warns = [];
  let hold = null;
  let failDelete = null;
  const body = {
    outcomes: [{ store: 'journey', removed: 1, error: null }],
    complete: false,
    vendorDeletion: 'not-asserted',
    note: NOTE,
  };
  const sandbox = {
    document,
    location: { hostname: 'atlas.example' },
    console: { warn: (...args) => warns.push(args), log() {}, error() {} },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    ATLAS_APP: {
      bootInfo: async () => ({ libraryRole: 'user' }),
      download() {},
      confirm(title, message, action) {
        confirms.push({ title, message });
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmText').textContent = message;
        document.getElementById('confirmYes').onclick = () => {
          document.getElementById('confirmDialog').close();
          if (action) action();
        };
        document.getElementById('confirmDialog').showModal();
      },
      libraryApi: async (path, opts) => {
        if (path === '/journey') {
          return {
            stages: [{ id: 'project', title: 'Identify the project', current: true }],
            fields: { title: { value: '' }, personalWork: { value: '' }, evidence: { value: '' } },
            confirmed: {},
            roles: { explanation: '', decision: '', matches: [] },
            publication: '',
            integrations: { spotlight: { reason: '' } },
          };
        }
        if (path === '/privacy/disclosure') {
          return {
            consent: { interview: 'interview-v2' },
            recording: 'The microphone starts only after the purpose consent for this session. Stop ends capture. Revoke deletes the local consent flag for spoken Ask.',
            textOnly: 'Project notes, the journey and the reference can be typed. Voice is optional.',
            retention: { appTelemetryDays: 180, vendorDeletion: 'not-asserted' },
            lawfulBasis: 'UNRESOLVED — this screen is not a GDPR certification or a DPO decision.',
            biometrics: 'ATLAS does not build a voiceprint or identify you by voice.',
          };
        }
        if (path === '/privacy/delete') {
          posts.push(opts);
          if (hold) await hold;
          if (failDelete) throw failDelete;
          return body;
        }
        throw new Error('unexpected ' + path);
      },
    },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  const machine = readFileSync(new URL('../src/erasure-machine.js', import.meta.url), 'utf8').replaceAll('export ', '');
  const ui = readFileSync(new URL('../src/journey-ui.js', import.meta.url), 'utf8');
  vm.runInNewContext(machine + '\n' + ui, sandbox, { filename: 'journey-ui.js' });
  return {
    sandbox, posts, confirms, warns, body, document,
    holdDelete() { let release; hold = new Promise(resolve => { release = resolve; }); return release; },
    failDelete(error) { failDelete = error; },
    button() { return walk(document.getElementById('journey'), node => node.textContent === 'Delete my journey data'); },
    text(value) { return walk(document.getElementById('journey'), node => node.textContent === value); },
  };
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('the erasure button waits for confirmation and paints the server note', async () => {
  const page = harness();
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  const button = page.button();
  assert.equal(button.textContent, 'Delete my journey data');
  assert.equal(page.text('Download my data').textContent, 'Download my data');
  button.click();
  await flush();
  assert.equal(page.posts.length, 0);
  assert.equal(JSON.stringify(page.confirms), JSON.stringify([{ title: 'Delete my journey data', message: 'Continue sends the deletion request. Cancel sends nothing.' }]));
  page.document.getElementById('confirmYes').onclick();
  await flush();
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].method, 'POST');
  assert.equal(JSON.stringify(page.posts[0].body), '{}');
  assert.equal(page.text(page.body.note).textContent, page.body.note);
  assert.equal(page.text('journey 1').textContent, 'journey 1');
  assert.equal(page.text(JSON.stringify(page.body)), null);
});

test('cancel closes the confirmation and sends nothing', async () => {
  const page = harness();
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  page.button().click();
  await flush();
  assert.equal(page.posts.length, 0);
  page.document.getElementById('confirmDialog').close();
  await flush();
  assert.equal(page.posts.length, 0);
  assert.equal(page.button().disabled, false);
});

test('a second erasure submit while the first request is open sends only one POST', async () => {
  const page = harness();
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  const release = page.holdDelete();
  const button = page.button();
  button.click();
  await flush();
  const dialog = page.document.getElementById('confirmDialog');
  const yes = page.document.getElementById('confirmYes');
  if (dialog.open && typeof yes.onclick === 'function') yes.onclick();
  await flush();
  button.click();
  await flush();
  if (dialog.open && typeof yes.onclick === 'function') yes.onclick();
  await flush();
  assert.equal(page.posts.length, 1);
  assert.equal(page.warns.length, 1);
  assert.deepEqual(JSON.parse(page.warns[0][0]), { id: 'privacy-delete', phase: 'in_flight', event: 'ask' });
  release();
  await flush();
});

test('a failed erasure does not paint a success receipt', async () => {
  const page = harness();
  page.body.outcomes = [
    { store: 'journey', removed: 1, error: null },
    { store: 'manager-trust', removed: 0, error: 'delete-failed' },
  ];
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  page.button().click();
  await flush();
  page.document.getElementById('confirmYes').onclick();
  await flush();
  assert.equal(page.document.getElementById('privacyReceipt'), null);
  assert.equal(page.text('manager-trust delete-failed'), null);
  assert.equal(page.text(page.body.note), null);
  assert.equal(page.text('The deletion did not finish. Nothing was removed.').textContent, 'The deletion did not finish. Nothing was removed.');
  assert.equal(page.button().disabled, false);

  const thrown = harness();
  thrown.failDelete(new Error('The deletion did not finish. Nothing was removed.'));
  await thrown.sandbox.AtlasJourney.render('journey');
  await flush();
  thrown.button().click();
  await flush();
  thrown.document.getElementById('confirmYes').onclick();
  await flush();
  assert.equal(thrown.document.getElementById('privacyReceipt'), null);
  assert.equal(thrown.text('journey 1'), null);
  assert.equal(thrown.text(page.body.note), null);
  assert.equal(thrown.text('The deletion did not finish. Nothing was removed.').textContent, 'The deletion did not finish. Nothing was removed.');
});

test('a failed erasure re-enables the button on the page after a re-render', async () => {
  const page = harness();
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  const release = page.holdDelete();
  page.button().click();
  await flush();
  page.document.getElementById('confirmYes').onclick();
  await flush();
  assert.equal(page.posts.length, 1);
  await page.sandbox.AtlasJourney.render('journey');
  await flush();
  assert.equal(page.button().disabled, true);
  page.failDelete(new Error('The deletion did not finish.'));
  release();
  await flush();
  assert.equal(page.posts.length, 1);
  assert.equal(page.button().disabled, false);
});
