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

const NOTICE = 'The signed-in account changed. Close this tab and open ATLAS again.';
const HEX = /^[0-9a-f]{32}$/;

function memorySession(seed) {
  const map = new Map(seed || []);
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
    _map: map,
  };
}

function listen(target) {
  const events = new Map();
  target.addEventListener = (type, fn) => {
    const list = events.get(type) || [];
    list.push(fn);
    events.set(type, list);
  };
  target.removeEventListener = (type, fn) => {
    events.set(type, (events.get(type) || []).filter(item => item !== fn));
  };
  target.dispatch = (type, event) => {
    for (const fn of events.get(type) || []) fn(event || { type });
  };
  return target;
}

function pageFor(sessionStorage, who) {
  const calls = [];
  const reloads = [];
  const nodes = new Map();
  function track(node) {
    const previous = typeof node.setAttribute === 'function' ? node.setAttribute.bind(node) : null;
    node.attrs = node.attrs || {};
    node.getAttribute = name => (name in node.attrs ? node.attrs[name] : null);
    node.setAttribute = (name, value) => {
      if (previous) previous(name, value);
      node.attrs[name] = String(value);
      if (name === 'class') node.className = String(value);
      if (name === 'id' && value) nodes.set(value, node);
    };
    return node;
  }
  const body = track(element('Ada bids marker'));
  body.id = 'body';
  const enableSave = track(element('Enable autosave'));
  enableSave.id = 'enableSave';
  const backupQuick = track(element('Backup'));
  backupQuick.id = 'backupQuick';
  nodes.set('enableSave', enableSave);
  nodes.set('backupQuick', backupQuick);
  nodes.set('workspace', element('Ada local journal marker'));
  nodes.set('libraryList', element('Ada library marker'));
  nodes.set('agentText', element('Ada transcript marker'));
  nodes.set('journey', element('Ada journey marker'));
  const document = listen({
    visibilityState: 'visible',
    body,
    documentElement: { append(node) { if (node && node.id) nodes.set(node.id, node); } },
    getElementById(id) { return nodes.get(id) || null; },
    createElement() { return track(element('')); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const socket = { readyState: 1, closed: 0, close() { this.closed += 1; this.readyState = 3; } };
  let cancels = 0;
  const next = { who: who || ADA };
  const sandbox = listen({
    ATLAS_RUNTIME: { ...ADA },
    document,
    location: { protocol: 'https:', href: 'https://atlas.example/', hash: '', reload() { reloads.push(1); } },
    history: { replaceState() {} },
    sessionStorage,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      for (const value of Object.values(headers)) {
        if ([...String(value)].some(ch => ch.charCodeAt(0) > 255)) throw new TypeError('header is not a byte string');
      }
      calls.push({ path, headers });
      return Promise.resolve(response(bootBody(next.who)));
    },
    BroadcastChannel: Channel,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    AtlasVoice: { active() { return socket.readyState <= 1; }, cancel() { cancels += 1; socket.close(); } },
  });
  sandbox.window = sandbox;
  const src = readFileSync(new URL('../src/session-keeper.js', import.meta.url), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'session-keeper.js' });
  return { sandbox, calls, reloads, document, socket, next, cancels: () => cancels, nodes };
}

describe('access identity change, plan debate', { concurrency: false }, () => {
  test('the voice socket is opened with the bound subject token', async () => {
    const seen = [];
    const nodes = new Map();
    function bag() {
      const node = {
        hidden: false, disabled: false, textContent: '', value: 'atlas', checked: true, open: false,
        className: '', id: '',
        style: { setProperty() {} },
        dataset: {},
        classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
        children: [],
        addEventListener() {}, removeEventListener() {},
        setAttribute(name, value) { if (name === 'id') { node.id = value; nodes.set(value, node); } },
        removeAttribute() {}, append() {}, replaceChildren() {}, querySelector() { return bag(); },
        querySelectorAll() { return []; }, closest() { return null; }, focus() {}, click() {},
        showModal() { node.open = true; }, close() { node.open = false; },
      };
      return node;
    }
    const document = {
      body: bag(),
      addEventListener() {},
      getElementById(id) { return nodes.get(id) || (nodes.set(id, bag()), nodes.get(id)); },
      createElement() { return bag(); },
      querySelector() { return null; },
    };
    const sandbox = {
      document,
      location: { protocol: 'https:', href: 'https://atlas.example/', hash: '', pathname: '/', search: '' },
      history: { replaceState() {} },
      navigator: { language: 'en', mediaDevices: { getUserMedia: async () => { const track = { label: 'mic', addEventListener() {}, stop() {} }; return { getTracks: () => [track], getAudioTracks: () => [track] }; } } },
      isSecureContext: true,
      ATLAS_RUNTIME: { ...ADA, boundSubject: 'ab'.repeat(16), boundEmail: 'cd'.repeat(16) },
      ATLAS_VOICE_BRIDGE: { context: () => ({ workspaceId: 'w', isNew: true, project: { id: 'p', title: 'Synthetic' }, display: {} }) },
      AtlasSafe: { html() { return ''; }, setHTML() {}, insertHTML() {}, trusted(v) { return v; } },
      AtlasAuth: {
        mode: 'live',
        Expired: class extends Error {},
        fetch: async () => response({ protocol: 'atlas-personaplex-pcm-v1', codecAvailable: true, busy: false, csrf: 'csrf', identity: { name: ADA.name, mode: 'access', subjectKey: ADA.subjectKey }, voices: ['atlas'], defaultVoice: 'atlas', provider: 'workers', providerLabel: 'ATLAS', model: 'm', capacity: 1, maxSeconds: 60, memory: false, transcription: false, captureRequired: false }),
        probe: async () => 'live',
        onSignedIn() {},
        expired() {},
      },
      URL: class extends URL {
        static createObjectURL() { return 'blob:atlas'; }
        static revokeObjectURL() {}
      },
      WebSocket: class {
        constructor(url, proto) { seen.push({ url: String(url), proto: proto || '' }); this.readyState = 0; this.binaryType = ''; }
        close() {}
        send() {}
      },
      AudioContext: class {
        constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; this.audioWorklet = { addModule: async () => {} }; }
        resume() { return Promise.resolve(); }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        close() { return Promise.resolve(); }
      },
      AudioWorkletNode: class { constructor() { this.port = { postMessage() {} }; } connect() {} disconnect() {} },
      Blob, AbortSignal,
      setTimeout(fn, ms, ...args) { if ((ms || 0) >= 1000) return 0; return setTimeout(fn, ms, ...args); },
      clearTimeout, setInterval, clearInterval, queueMicrotask, performance,
      CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
      Event: class Event { constructor(type) { this.type = type; } },
      dispatchEvent() {},
      matchMedia: () => ({ matches: true }),
      console,
    };
    sandbox.window = sandbox;
    listen(sandbox);
    const src = readFileSync(new URL('../src/voice-client.js', import.meta.url), 'utf8');
    vm.runInNewContext(src, sandbox, { filename: 'voice-client.js' });
    await sandbox.AtlasVoice.checkConnection();
    document.getElementById('modelConsent').checked = true;
    document.getElementById('captureConsent').checked = true;
    document.getElementById('voiceConsentStart').onclick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(seen.map(item => item.proto), ['atlas-bound-' + 'ab'.repeat(16)]);
  });

  test('a focus event after the JWT changes fail-closes an idle tab', async () => {
    const page = pageFor(memorySession());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.sandbox.AtlasAuth.mode, 'live');
    page.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    page.sandbox.dispatch('focus');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.sandbox.AtlasAuth.mode, 'identity-changed');
    assert.equal(page.surfaces ? page.nodes.get('workspace').textContent : page.nodes.get('workspace').textContent, '');
  });

  test('a visibilitychange to visible fail-closes an idle tab', async () => {
    const page = pageFor(memorySession());
    await new Promise(resolve => setTimeout(resolve, 0));
    page.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    page.document.visibilityState = 'visible';
    page.document.dispatch('visibilitychange');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.sandbox.AtlasAuth.mode, 'identity-changed');
  });

  test('an atlas-auth broadcast fail-closes a tab that is not expired', async () => {
    const page = pageFor(memorySession());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.sandbox.AtlasAuth.mode, 'live');
    page.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    Channel.latest.onmessage({ data: 'ok' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.sandbox.AtlasAuth.mode, 'identity-changed');
  });

  test('focus probes are throttled to one fresh bootstrap', async () => {
    const page = pageFor(memorySession());
    await new Promise(resolve => setTimeout(resolve, 0));
    const before = page.calls.length;
    page.sandbox.dispatch('focus');
    page.sandbox.dispatch('focus');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(page.calls.length - before, 1);
  });

  test('a recent reload stamp does not reload again and the app root is blank', async () => {
    const storage = memorySession([['atlas.reauthAt', String(Date.now())]]);
    const page = pageFor(storage);
    await new Promise(resolve => setTimeout(resolve, 0));
    page.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    await page.sandbox.AtlasAuth.probe({ fresh: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    const note = page.nodes.get('atlasIdentityNotice');
    assert.deepEqual({
      mode: page.sandbox.AtlasAuth.mode,
      reloads: page.reloads.length,
      rootHidden: page.document.body.hidden,
      workspace: page.nodes.get('workspace').textContent,
      enableSave: page.nodes.get('enableSave').disabled,
      backupQuick: page.nodes.get('backupQuick').disabled,
      notice: note ? note.textContent.includes(NOTICE) : false,
      marker: page.document.body.textContent.includes('Ada bids marker'),
    }, {
      mode: 'identity-changed',
      reloads: 0,
      rootHidden: true,
      workspace: '',
      enableSave: true,
      backupQuick: true,
      notice: true,
      marker: false,
    });
  });

  test('a real sessionStorage stamp blocks the second identity-changed reload', async () => {
    const storage = memorySession();
    const first = pageFor(storage);
    await new Promise(resolve => setTimeout(resolve, 0));
    first.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    await first.sandbox.AtlasAuth.probe({ fresh: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(first.reloads.length, 1);
    assert.match(storage.getItem('atlas.reauthAt') || '', /^[0-9]+$/);
    const second = pageFor(storage, { subjectKey: 'subject-blake', name: 'blake@example.test' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual({
      mode: second.sandbox.AtlasAuth.mode,
      reloads: second.reloads.length,
      rootHidden: second.document.body.hidden,
    }, { mode: 'identity-changed', reloads: 0, rootHidden: true });
  });

  test('a non-Latin-1 mailbox is not copied into a request header', async () => {
    const mailbox = '用户@example.test';
    const page = pageFor(memorySession());
    page.sandbox.ATLAS_RUNTIME = {
      subjectKey: ADA.subjectKey,
      name: mailbox,
      boundSubject: 'ab'.repeat(16),
      boundEmail: 'cd'.repeat(16),
    };
    let threw = false;
    try { await page.sandbox.AtlasAuth.probe({ fresh: true }); } catch { threw = true; }
    const headers = page.calls.at(-1)?.headers || {};
    assert.deepEqual({
      threw,
      subject: headers['X-Atlas-Bound-Subject'] || '',
      email: headers['X-Atlas-Bound-Email'] || '',
    }, { threw: false, subject: 'ab'.repeat(16), email: 'cd'.repeat(16) });
    assert.equal(HEX.test(headers['X-Atlas-Bound-Email'] || ''), true);
    assert.equal(Object.values(headers).join('\n').includes(mailbox), false);
  });

  test('the identity notice is an assertive alert and adds no new copy', async () => {
    const storage = memorySession([['atlas.reauthAt', String(Date.now())]]);
    const page = pageFor(storage);
    await new Promise(resolve => setTimeout(resolve, 0));
    page.next.who = { subjectKey: 'subject-blake', name: 'blake@example.test' };
    await page.sandbox.AtlasAuth.probe({ fresh: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    const note = page.nodes.get('atlasIdentityNotice');
    assert.ok(note);
    assert.equal(note.getAttribute('role'), 'alert');
    assert.equal(note.getAttribute('aria-live'), 'assertive');
    assert.equal(note.getAttribute('class'), 'blocking-notice');
    assert.equal(note.textContent, 'The signed-in account changed. Close this tab and open ATLAS again. Anything not already saved on this device is discarded.');
  });
});

describe('access identity change, clean console', { concurrency: false }, () => {
  test('an identity switch produces no uncaught page error', async () => {
    const nodes = new Map();
    const errors = [];
    class Observed {
      constructor(callback) { this.callback = callback; this.nodes = new Set(); this.records = []; this.armed = false; }
      observe(node) { this.nodes.add(node); node._observers.add(this); }
      disconnect() { for (const node of this.nodes) node._observers.delete(this); this.nodes.clear(); this.records = []; }
    }
    function notify(node) {
      for (const obs of node._observers) {
        if (!obs.nodes.has(node)) continue;
        obs.records.push({ target: node });
        if (obs.armed) continue;
        obs.armed = true;
        queueMicrotask(() => {
          obs.armed = false;
          const records = obs.records.splice(0);
          if (!records.length) return;
          try { obs.callback(records, obs); }
          catch (error) { errors.push(String(error && error.message || error)); }
        });
      }
    }
    function bag(id = '') {
      const node = {
        id, hidden: false, disabled: false, value: '0', checked: false, open: false,
        className: '', dataset: {}, style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
        children: [], _observers: new Set(), _text: 'label', connected: true,
        get textContent() { return this._text; },
        set textContent(value) {
          this._text = String(value);
          if (this === body) {
            for (const child of this.children) child.connected = false;
            this.children.length = 0;
          }
          notify(this);
        },
        addEventListener() {}, removeEventListener() {},
        setAttribute(name, value) { this[name] = value; if (name === 'id') { this.id = value; nodes.set(value, this); } },
        removeAttribute() {},
        append(child) { this.children.push(child); child.connected = true; },
        querySelector() { return bag(); }, querySelectorAll() { return []; }, closest() { return null; },
        focus() {}, click() {}, showModal() {}, close() {},
      };
      if (id) nodes.set(id, node);
      return node;
    }
    const body = bag('body');
    const document = {
      body,
      documentElement: { append(node) { node.connected = true; node.parentNode = this; if (node && node.id) nodes.set(node.id, node); } },
      visibilityState: 'visible', hidden: false,
      addEventListener() {}, removeEventListener() {},
      getElementById(id) { const node = nodes.get(id); return node && node.connected ? node : null; },
      createElement() { return bag(); },
      querySelector() { return bag(); },
      querySelectorAll() { return []; },
    };
    for (const id of ['orbCanvas', 'orbDisplayNotice', 'orbMotion', 'orbQuickPause', 'motifTitle', 'motifDescription', 'motifPeriod', 'motifGlyph', 'motifSource', 'voicePanel', 'orbStateCaption', 'orbAccessibleState', 'orbInputWord', 'orbOutputWord', 'orbActivate', 'studioPreview', 'orbInteractionHint', 'previewNotice', 'previewPhase', 'voiceMute', 'voiceOpenHome', 'voiceNetwork', 'voiceRetry', 'voiceStart', 'orbTranscript', 'orbTranscriptToggle', 'replayPattern', 'orbQuickFocus', 'orbIntensity', 'orbIntensityValue', 'studioAppearance', 'appearancePanel', 'studioProjectDrawer', 'studioProject', 'studioContextMobile', 'studioCloseContext', 'studioChooseProject', 'studioConnection', 'voiceSetup', 'studioFocus', 'studioSave', 'studioBackup', 'profileButton', 'backupQuick', 'storageStatus', 'interview', 'workspace', 'libraryList', 'agentText', 'journey', 'enableSave', 'importQuick']) {
      const node = bag(id);
      body.children.push(node);
    }
    const listeners = new Map();
    const sandbox = {
      document,
      performance: { now: () => 0 },
      setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout, queueMicrotask,
      CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail || {}; } },
      Event: class Event { constructor(type) { this.type = type; } },
      MutationObserver: Observed,
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      AtlasOrb: {
        SignalState: class { snapshot() { return { state: 'idle', phase: 'idle', muted: false, input: 0, output: 0, inputActive: false }; } setPhase() {} levels() {} phase = 'idle'; },
        create() { return { setState() {}, setLevels() {}, restart() {}, pause() {}, setIntensity() {}, setPalette() {}, renderOnce() {}, inspect() { return { reducedMotion: false }; }, destroy() {} }; },
      },
      console,
      location: { protocol: 'https:', href: 'https://atlas.example/', hash: '', reload() {} },
      history: { replaceState() {} },
      sessionStorage: { getItem() { return String(Date.now()); }, setItem() {} },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      fetch() {
        return Promise.resolve({
          status: 200, ok: true, type: 'basic',
          async json() {
            return { protocol: 'atlas-personaplex-pcm-v1', csrf: 'csrf', identity: { name: 'blake@example.test', mode: 'access', subjectKey: 'subject-blake' }, email: 'blake@example.test' };
          },
        });
      },
      BroadcastChannel: class { set onmessage(fn) { this._fn = fn; } },
      AbortSignal: { timeout() { return {}; } },
      ATLAS_RUNTIME: { ...ADA },
      AtlasVoice: { active() { return false; }, cancel() {} },
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      removeEventListener() {},
      dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(readFileSync(new URL('../src/session-keeper.js', import.meta.url), 'utf8'), sandbox, { filename: 'session-keeper.js' });
    // app.js rewrites the storage line on atlas-auth, which is what queues the orb observer before the body is cleared.
    sandbox.addEventListener('atlas-auth', () => {
      const status = document.getElementById('storageStatus');
      if (status) status.textContent = 'Saved on this device · no cloud sync';
    });
    vm.runInNewContext(readFileSync(new URL('../src/orb-ui.js', import.meta.url), 'utf8'), sandbox, { filename: 'orb-ui.js' });
    await sandbox.AtlasAuth.probe({ fresh: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sandbox.AtlasAuth.mode, 'identity-changed');
    assert.deepEqual(errors, []);
  });

  test('the storage observer copies the status and is disconnected by the blank', async () => {
    const nodes = new Map();
    const errors = [];
    let callbacks = 0;
    class Observed {
      constructor(callback) { this.callback = callback; this.nodes = new Set(); this.records = []; this.armed = false; }
      observe(node) { this.nodes.add(node); node._observers.add(this); }
      disconnect() { for (const node of this.nodes) node._observers.delete(this); this.nodes.clear(); this.records = []; }
    }
    function notify(node) {
      for (const obs of node._observers) {
        if (!obs.nodes.has(node)) continue;
        obs.records.push({ target: node });
        if (obs.armed) continue;
        obs.armed = true;
        queueMicrotask(() => {
          obs.armed = false;
          const records = obs.records.splice(0);
          if (!records.length) return;
          callbacks += 1;
          try { obs.callback(records, obs); }
          catch (error) { errors.push(String(error && error.message || error)); }
        });
      }
    }
    function bag(id = '') {
      const node = {
        id, hidden: false, disabled: false, value: '0', checked: false, open: false,
        className: '', dataset: {}, style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
        children: [], _observers: new Set(), _text: 'label', connected: true,
        get textContent() { return this._text; },
        set textContent(value) {
          this._text = String(value);
          if (this === body) {
            for (const child of this.children) child.connected = false;
            this.children.length = 0;
          }
          notify(this);
        },
        addEventListener() {}, removeEventListener() {},
        setAttribute(name, value) { this[name] = value; if (name === 'id') { this.id = value; nodes.set(value, this); } },
        removeAttribute() {},
        append(child) { this.children.push(child); child.connected = true; },
        querySelector() { return bag(); }, querySelectorAll() { return []; }, closest() { return null; },
        focus() {}, click() {}, showModal() {}, close() {},
      };
      if (id) nodes.set(id, node);
      return node;
    }
    const body = bag('body');
    const document = {
      body,
      documentElement: { append(node) { node.connected = true; node.parentNode = this; if (node && node.id) nodes.set(node.id, node); } },
      visibilityState: 'visible', hidden: false,
      addEventListener() {}, removeEventListener() {},
      getElementById(id) { const node = nodes.get(id); return node && node.connected ? node : null; },
      createElement() { return bag(); },
      querySelector() { return bag(); },
      querySelectorAll() { return []; },
    };
    for (const id of ['orbCanvas', 'orbDisplayNotice', 'orbMotion', 'orbQuickPause', 'motifTitle', 'motifDescription', 'motifPeriod', 'motifGlyph', 'motifSource', 'voicePanel', 'orbStateCaption', 'orbAccessibleState', 'orbInputWord', 'orbOutputWord', 'orbActivate', 'studioPreview', 'orbInteractionHint', 'previewNotice', 'previewPhase', 'voiceMute', 'voiceOpenHome', 'voiceNetwork', 'voiceRetry', 'voiceStart', 'orbTranscript', 'orbTranscriptToggle', 'replayPattern', 'orbQuickFocus', 'orbIntensity', 'orbIntensityValue', 'studioAppearance', 'appearancePanel', 'studioProjectDrawer', 'studioProject', 'studioContextMobile', 'studioCloseContext', 'studioChooseProject', 'studioConnection', 'voiceSetup', 'studioFocus', 'studioSave', 'studioBackup', 'profileButton', 'backupQuick', 'storageStatus', 'interview', 'workspace', 'libraryList', 'agentText', 'journey', 'enableSave', 'importQuick']) {
      const node = bag(id);
      body.children.push(node);
    }
    const listeners = new Map();
    const sandbox = {
      document,
      performance: { now: () => 0 },
      setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout, queueMicrotask,
      CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail || {}; } },
      Event: class Event { constructor(type) { this.type = type; } },
      MutationObserver: Observed,
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      AtlasOrb: {
        SignalState: class { snapshot() { return { state: 'idle', phase: 'idle', muted: false, input: 0, output: 0, inputActive: false }; } setPhase() {} levels() {} phase = 'idle'; },
        create() { return { setState() {}, setLevels() {}, restart() {}, pause() {}, setIntensity() {}, setPalette() {}, renderOnce() {}, inspect() { return { reducedMotion: false }; }, destroy() {} }; },
      },
      console,
      location: { protocol: 'https:', href: 'https://atlas.example/', hash: '', reload() {} },
      history: { replaceState() {} },
      sessionStorage: { getItem() { return String(Date.now()); }, setItem() {} },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      fetch() {
        return Promise.resolve({
          status: 200, ok: true, type: 'basic',
          async json() {
            return { protocol: 'atlas-personaplex-pcm-v1', csrf: 'csrf', identity: { name: 'blake@example.test', mode: 'access', subjectKey: 'subject-blake' }, email: 'blake@example.test' };
          },
        });
      },
      BroadcastChannel: class { set onmessage(fn) { this._fn = fn; } },
      AbortSignal: { timeout() { return {}; } },
      ATLAS_RUNTIME: { ...ADA },
      AtlasVoice: { active() { return false; }, cancel() {} },
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      removeEventListener() {},
      dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(readFileSync(new URL('../src/session-keeper.js', import.meta.url), 'utf8'), sandbox, { filename: 'session-keeper.js' });
    sandbox.addEventListener('atlas-auth', () => {
      const status = document.getElementById('storageStatus');
      if (status) status.textContent = 'Saved on this device · no cloud sync';
    });
    vm.runInNewContext(readFileSync(new URL('../src/orb-ui.js', import.meta.url), 'utf8'), sandbox, { filename: 'orb-ui.js' });
    const status = document.getElementById('storageStatus');
    const save = document.getElementById('studioSave');
    status.textContent = 'Saved on this device';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(save.textContent, 'Saved on this device');
    assert.ok(callbacks > 0);
    const beforeBlank = callbacks;
    await sandbox.AtlasAuth.probe({ fresh: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sandbox.AtlasAuth.mode, 'identity-changed');
    assert.deepEqual(errors, []);
    const afterBlank = callbacks;
    status.textContent = 'after the blank';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(callbacks, afterBlank);
    assert.ok(beforeBlank > 0);
    assert.deepEqual(errors, []);
  });
});
