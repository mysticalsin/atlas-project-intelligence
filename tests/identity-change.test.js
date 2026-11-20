// ATLAS-HROW10-IDENTITY-CHANGE-RESIDUAL
// Red until a mid-session Access identity change fail-closes.
// The established runtime stays A. A later bootstrap that names B must not stay live,
// must not keep B's bootstrap, must not leave A's text on screen, and must not resume voice.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ADA = { subjectKey: 'subject-ada', name: 'ada@example.test', authMode: 'access' };
const ADA_KEY = 'mantu.atlas.workspace.v4.subject-ada';
const ADA_BLOB = '{"title":"Ada local journal marker"}';

function bootBody(who) {
  return {
    protocol: 'atlas-personaplex-pcm-v1',
    csrf: 'csrf-' + who.subjectKey,
    identity: { name: who.name, mode: 'access', subjectKey: who.subjectKey },
    email: who.name,
    library: true,
    libraryRole: 'user',
  };
}

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    type: 'basic',
    async json() { return body; },
  };
}

class Channel {
  constructor() { Channel.latest = this; }
  postMessage() {}
  set onmessage(fn) { this._fn = fn; }
  get onmessage() { return this._fn; }
}

function element(text = '') {
  return {
    textContent: text,
    hidden: false,
    disabled: false,
    children: [],
    addEventListener() {},
    removeEventListener() {},
  };
}

function loadKeeper(next) {
  const calls = [];
  const reloads = [];
  const storage = new Map([[ADA_KEY, ADA_BLOB]]);
  const writes = [];
  const surfaces = {
    workspace: element('Ada local journal marker'),
    libraryList: element('Ada library marker'),
    agentText: element('Ada transcript marker'),
    journey: element('Ada journey marker'),
  };
  const socket = {
    readyState: 1,
    sent: [],
    closed: 0,
    close() { this.closed += 1; this.readyState = 3; },
    send(data) { this.sent.push(String(data)); },
  };
  let cancels = 0;
  const sandbox = {
    ATLAS_RUNTIME: { ...ADA },
    document: { getElementById(id) { return surfaces[id] || null; } },
    location: {
      protocol: 'https:',
      hash: '',
      reload() { reloads.push(1); },
    },
    history: { replaceState() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { writes.push(['set', key]); storage.set(key, String(value)); },
      removeItem(key) { writes.push(['remove', key]); storage.delete(key); },
    },
    fetch(path, opts = {}) {
      calls.push({ path, headers: { ...(opts.headers || {}) } });
      return Promise.resolve(response(bootBody(next.who)));
    },
    BroadcastChannel: Channel,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AtlasVoice: {
      active() { return socket.readyState <= 1; },
      cancel() { cancels += 1; socket.close(); },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => {};
  const src = readFileSync(new URL('../src/session-keeper.js', import.meta.url), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'session-keeper.js' });
  return { sandbox, calls, reloads, storage, writes, surfaces, socket, cancels: () => cancels };
}

async function settled(page) {
  await page.sandbox.AtlasAuth.probe();
  page.next.who = page.after;
  await page.sandbox.AtlasAuth.probe({ fresh: true });
  await new Promise(resolve => setTimeout(resolve, 0));
}

function snapshot(page) {
  const bootWait = page.sandbox.AtlasAuth.boot();
  return bootWait.then(body => ({
    mode: page.sandbox.AtlasAuth.mode,
    reloads: page.reloads.length,
    closed: page.socket.closed,
    cancels: page.cancels(),
    sent: page.socket.sent.length,
    workspace: page.surfaces.workspace.textContent,
    libraryList: page.surfaces.libraryList.textContent,
    agentText: page.surfaces.agentText.textContent,
    journey: page.surfaces.journey.textContent,
    bootSubject: body?.identity?.subjectKey || '',
    adaKey: page.storage.get(ADA_KEY) || '',
    writes: page.writes.length,
  }));
}

const CLOSED = {
  mode: 'identity-changed',
  reloads: 1,
  closed: 1,
  cancels: 1,
  sent: 0,
  workspace: '',
  libraryList: '',
  agentText: '',
  journey: '',
  bootSubject: '',
  adaKey: ADA_BLOB,
  writes: 0,
};

describe('access identity change, client', { concurrency: false }, () => {
test('the page sends the established Access identity on bootstrap', async () => {
  const next = { who: ADA };
  const page = loadKeeper(next);
  await page.sandbox.AtlasAuth.probe();
  const headers = page.calls.at(-1)?.headers || {};
  assert.deepEqual(
    { subject: headers['X-Atlas-Bound-Subject'] || '', email: headers['X-Atlas-Bound-Email'] || '' },
    { subject: ADA.subjectKey, email: ADA.name },
  );
});

for (const [label, after] of [
  ['email and subject', { subjectKey: 'subject-blake', name: 'blake@example.test' }],
  ['email only', { subjectKey: ADA.subjectKey, name: 'ada.renamed@example.test' }],
  ['subject only', { subjectKey: 'subject-blake', name: ADA.name }],
]) {
  test('fail closed when the Access identity changes: ' + label, async () => {
    const next = { who: ADA };
    const page = loadKeeper(next);
    page.next = next;
    page.after = after;
    await page.sandbox.AtlasAuth.probe();
    assert.equal(page.sandbox.AtlasAuth.mode, 'live');
    await settled(page);
    assert.deepEqual(await snapshot(page), CLOSED);
  });
}

test('a re-sign-in popup for a different Access identity does not resume the interview', async () => {
  const next = { who: ADA };
  const page = loadKeeper(next);
  await page.sandbox.AtlasAuth.probe();
  assert.equal(page.sandbox.AtlasAuth.mode, 'live');
  let began = false;
  page.sandbox.AtlasAuth.onSignedIn(() => { began = true; });
  next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
  page.sandbox.AtlasAuth.expired({ resume: 'start' });
  await new Promise(resolve => setTimeout(resolve, 0));
  Channel.latest.onmessage({ data: 'ok' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(
    { began, mode: page.sandbox.AtlasAuth.mode, closed: page.socket.closed, reloads: page.reloads.length },
    { began: false, mode: 'identity-changed', closed: 1, reloads: 1 },
  );
});

function walk(root, pred) {
  if (pred(root)) return root;
  for (const child of root.children || []) {
    if (!child || typeof child !== 'object') continue;
    const hit = walk(child, pred);
    if (hit) return hit;
  }
  return null;
}

function allText(node) {
  const own = node && typeof node.textContent === 'string' ? node.textContent : '';
  const kids = (node && node.children || []).map(allText).join('');
  return own + kids;
}

function journeyElement() {
  const listeners = new Map();
  const node = {
    id: '', hidden: false, disabled: false, open: false, textContent: '', value: '',
    className: '', children: [], parent: null, onclick: null,
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
      node.textContent = '';
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
  };
  return node;
}

test('journal and privacy delete stay blank when the signed-in identity changed', async () => {
  const nodes = new Map();
  const document = {
    getElementById(id) { return nodes.get(id) || null; },
    createElement() { return journeyElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const orig = document.createElement;
  document.createElement = () => {
    const node = orig();
    const setAttribute = node.setAttribute;
    node.setAttribute = (name, value) => {
      setAttribute.call(node, name, value);
      if (name === 'id') nodes.set(value, node);
    };
    return node;
  };
  for (const id of ['journey', 'admin', 'adminNav', 'confirmDialog', 'confirmTitle', 'confirmText', 'confirmYes']) {
    const node = journeyElement();
    node.id = id;
    nodes.set(id, node);
  }
  const posts = [];
  const sandbox = {
    document,
    location: { hostname: 'atlas.example' },
    ATLAS_RUNTIME: { ...ADA },
    AtlasAuth: { mode: 'live', boot: async () => bootBody({ subjectKey: 'subject-blake', name: 'blake@example.test' }) },
    AtlasSafe: { html() { return ''; }, setHTML() {}, insertHTML() {}, trusted(value) { return value; } },
    console: { warn() {}, log() {}, error() {} },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    ATLAS_APP: {
      bootInfo: async () => ({
        libraryRole: 'user',
        identity: { name: 'blake@example.test', mode: 'access', subjectKey: 'subject-blake' },
        email: 'blake@example.test',
      }),
      download() {},
      confirm(title, message, action) {
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
            stages: [{ id: 'project', title: 'Blake journey marker', current: true }],
            fields: { title: { value: 'Blake journey marker' }, personalWork: { value: '' }, evidence: { value: '' } },
            confirmed: {},
            roles: { explanation: '', decision: '', matches: [] },
            publication: '',
            integrations: { spotlight: { reason: '' } },
          };
        }
        if (path === '/privacy/disclosure') {
          return {
            consent: { interview: 'interview-v2' },
            recording: '',
            textOnly: '',
            retention: { appTelemetryDays: 180, vendorDeletion: 'not-asserted' },
            lawfulBasis: '',
            biometrics: '',
          };
        }
        if (path === '/privacy/delete') {
          posts.push(opts);
          return { outcomes: [{ store: 'journey', removed: 1, error: null }], note: 'Blake delete receipt' };
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
  await sandbox.AtlasJourney.render('journey');
  await new Promise(resolve => setTimeout(resolve, 0));
  const button = walk(document.getElementById('journey'), node => node.textContent === 'Delete my journey data');
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.getElementById('confirmYes').onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  const text = allText(document.getElementById('journey'));
  assert.deepEqual(
    { showsBlake: text.includes('Blake journey marker'), posts: posts.length },
    { showsBlake: false, posts: 0 },
  );
});
});
