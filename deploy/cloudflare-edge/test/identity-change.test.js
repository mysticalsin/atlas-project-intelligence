// ATLAS-HROW10-IDENTITY-CHANGE-RESIDUAL
// Red until a bound Access identity that disagrees with the current JWT
// returns 409 IDENTITY_CHANGED before any Durable Object is opened.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-identity-change';
const ORIGIN = 'https://atlas.example.workers.dev';
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k-identity' };
globalThis.fetch = async url => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};

async function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now + 600,
    iat: now,
    ...claims,
  };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k-identity' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}

const ADA = { sub: 'user-ada', email: 'ada@example.test' };
const BLAKE = { sub: 'user-blake', email: 'blake@example.test' };
const RENAMED = { sub: 'user-ada', email: 'ada.renamed@example.test' };
const MARKER = 'Blake journal marker';
const FAILURE = {
  status: 409,
  opened: [],
  error: 'The signed-in identity changed. Reload ATLAS and sign in again.',
  code: 'IDENTITY_CHANGED',
  marker: false,
};

function binder(payload) {
  const opened = [];
  const binding = {
    idFromName(name) { opened.push(String(name)); return name; },
    get() {
      return {
        fetch: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      };
    },
  };
  return { binding, opened };
}

function envFor(library, interview) {
  return {
    ORIGIN,
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: TEAM,
    CSRF_SECRET: 'test-secret',
    LOG_SALT: 'synthetic-log-salt',
    ATLAS_TENANT_ISOLATION: 'local-synthetic',
    ATLAS_ADMIN_ROLES: 'ATLAS.Admin',
    ATLAS_PRESALES_ROLES: 'ATLAS.Presales,ATLAS.Publish',
    ATLAS_REVIEWER_ROLES: 'ATLAS.Reviewer,ATLAS.Review',
    LIBRARY: library,
    INTERVIEW: interview,
  };
}

async function tokenFor(who) {
  return jwt({ sub: who.sub, email: who.email });
}

async function established() {
  const token = await tokenFor(ADA);
  const res = await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': token } }), envFor(binder({}).binding, binder({}).binding), '');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.identity.name, ADA.email);
  assert.match(body.identity.subjectKey, /^[0-9a-f]{32}$/);
  return { token, subjectKey: body.identity.subjectKey, email: body.identity.name, csrf: body.csrf };
}

function boundHeaders(ada, extra = {}) {
  return {
    'X-Atlas-Bound-Subject': ada.subjectKey,
    'X-Atlas-Bound-Email': ada.email,
    ...extra,
  };
}

async function outcome(res, opened) {
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  return {
    status: res.status,
    opened: opened.slice(),
    error: body.error || '',
    code: body.code || '',
    marker: text.includes(MARKER),
  };
}

describe('access identity change, worker', { concurrency: false }, () => {
test('library GET with the other bound identity does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: { 'cf-access-jwt-assertion': await tokenFor(BLAKE), ...boundHeaders(ada) },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('library GET with only the email changed does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: { 'cf-access-jwt-assertion': await tokenFor(RENAMED), ...boundHeaders(ada) },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('library GET with only the subject changed does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: {
      'cf-access-jwt-assertion': await tokenFor({ sub: BLAKE.sub, email: ADA.email }),
      ...boundHeaders(ada),
    },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('voice upgrade with the other bound subject does not open the interview object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/voice', {
    headers: {
      'cf-access-jwt-assertion': await tokenFor(BLAKE),
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': 'atlas-bound-' + ada.subjectKey,
    },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, interview.opened), FAILURE);
});

test('privacy delete with the new csrf and the old bound identity does not open the library', async () => {
  // Access mode without a tid:oid subject is refused here as "A verified tenant is required"
  // before the library. That 403 is not this residual. Entra-shaped Access tokens carry a
  // verified tid, so today's handler accepts B's csrf and opens the library.
  const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const entraEnv = (library, interview) => ({
    ...envFor(library, interview),
    ATLAS_TENANT_ISOLATION: 'enforced',
    IDENTITY_SOURCE: 'entra',
    ENTRA_TENANTS: tid,
  });
  const entraToken = (email, oid) => jwt({ sub: 'cf-' + oid, email, custom: { tid, oid } });
  const adaToken = await entraToken('ada@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const blakeToken = await entraToken('blake@example.test', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const adaBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', {
    headers: { 'cf-access-jwt-assertion': adaToken },
  }), entraEnv(binder({}).binding, binder({}).binding), '')).json();
  const blakeBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', {
    headers: { 'cf-access-jwt-assertion': blakeToken },
  }), entraEnv(binder({}).binding, binder({}).binding), '')).json();
  assert.equal(adaBoot.identity.mode, 'entra');
  assert.match(adaBoot.identity.subjectKey, /^[0-9a-f]{32}$/);
  assert.notEqual(adaBoot.identity.subjectKey, blakeBoot.identity.subjectKey);
  const library = binder({ note: MARKER, outcomes: [{ store: 'journey', removed: 1 }] });
  const interview = binder({});
  const res = await handle(new Request(ORIGIN + '/api/library/privacy/delete', {
    method: 'POST',
    body: '{}',
    headers: {
      'cf-access-jwt-assertion': blakeToken,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-Atlas-CSRF': blakeBoot.csrf,
      'X-Atlas-Bound-Subject': adaBoot.identity.subjectKey,
      'X-Atlas-Bound-Email': adaBoot.identity.name,
    },
  }), entraEnv(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});
});

// R1–R5. The bound keys are HMAC-SHA256(LOG_SALT, label + value), first 32 hex characters.
// Subject label: atlas-bound-subject-v1:   Email label: atlas-bound-email-v1: plus the trimmed lower-case mailbox.
// They are not the log pseudonym, which is HMAC-SHA256(LOG_SALT, sub) with no label.
const SALT = 'synthetic-log-salt';
const enc = new TextEncoder();
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const subjectBound = sub => hmacHex(SALT, 'atlas-bound-subject-v1:' + sub).then(hex => hex.slice(0, 32));
const emailBound = email => hmacHex(SALT, 'atlas-bound-email-v1:' + String(email).trim().toLowerCase()).then(hex => hex.slice(0, 32));
const logPseudonym = sub => hmacHex(SALT, sub).then(hex => hex.slice(0, 32));

function recordingBindings() {
  const opened = [];
  const forwarded = [];
  const binding = {
    idFromName(name) { opened.push(String(name)); return name; },
    get() {
      return {
        fetch: async req => {
          forwarded.push(req);
          return new Response(JSON.stringify({ title: MARKER, note: MARKER }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      };
    },
  };
  return { opened, forwarded, binding };
}

function entraBase(library, interview) {
  const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return {
    env: {
      ...envFor(library, interview),
      ATLAS_TENANT_ISOLATION: 'enforced',
      IDENTITY_SOURCE: 'entra',
      ENTRA_TENANTS: tid,
    },
    tid,
  };
}

describe('access identity change, required plan changes', { concurrency: false }, () => {
  test('a matching voice upgrade echoes exactly one Sec-WebSocket-Protocol token', async () => {
    const Real = globalThis.Response;
    globalThis.Response = class {
      constructor(body, init = {}) {
        if (init && Number(init.status) === 101) {
          return {
            status: 101,
            webSocket: init.webSocket || null,
            headers: new Headers(init.headers || {}),
            text: async () => '',
            json: async () => ({}),
          };
        }
        return new Real(body, init);
      }
    };
    try {
      const ada = await established();
      const token = 'atlas-bound-' + await subjectBound(ADA.sub);
      const opened = [];
      const interview = {
        idFromName(name) { opened.push(String(name)); return name; },
        get() {
          return { fetch: async () => ({ status: 200, webSocket: { id: 'socket' }, headers: new Headers(), text: async () => '' }) };
        },
      };
      const res = await handle(new Request(ORIGIN + '/api/voice', {
        headers: {
          'cf-access-jwt-assertion': ada.token,
          Upgrade: 'websocket',
          Origin: ORIGIN,
          'Sec-WebSocket-Protocol': token,
        },
      }), envFor(binder({}).binding, interview), '');
      const echoed = res.headers.get('sec-websocket-protocol') || '';
      assert.deepEqual(
        { status: res.status, echoed, commas: echoed.includes(','), opened: opened.length > 0 },
        { status: 101, echoed: token, commas: false, opened: true },
      );
    } finally {
      globalThis.Response = Real;
    }
  });

  test('a mismatched subprotocol token is 409 and opens no interview', async () => {
    const ada = await established();
    const library = binder({ title: MARKER });
    const interview = binder({ title: MARKER });
    const res = await handle(new Request(ORIGIN + '/api/voice', {
      headers: {
        'cf-access-jwt-assertion': ada.token,
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': 'atlas-bound-' + 'ab'.repeat(16),
      },
    }), envFor(library.binding, interview.binding), '');
    assert.deepEqual(await outcome(res, interview.opened), FAILURE);
  });

  test('two bound subprotocol tokens are 409 and open no interview', async () => {
    const ada = await established();
    const token = 'atlas-bound-' + await subjectBound(ADA.sub);
    const library = binder({});
    const interview = binder({ title: MARKER });
    const res = await handle(new Request(ORIGIN + '/api/voice', {
      headers: {
        'cf-access-jwt-assertion': ada.token,
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': token + ', atlas-bound-' + 'cd'.repeat(16),
      },
    }), envFor(library.binding, interview.binding), '');
    assert.deepEqual(await outcome(res, interview.opened), FAILURE);
  });

  test('every durable object route fail-closes on an email-only bound mismatch', async () => {
    const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sub = tid + ':' + oid;
    const adaEmail = 'ada@example.test';
    const renamed = 'ada.renamed@example.test';
    const tokenForOid = email => jwt({ sub: 'cf-' + oid, email, custom: { tid, oid } });
    const adaToken = await tokenForOid(adaEmail);
    const renamedToken = await tokenForOid(renamed);
    const { binding, opened } = recordingBindings();
    const { env } = entraBase(binding, binding);
    const boot = await (await handle(new Request(ORIGIN + '/api/bootstrap', {
      headers: { 'cf-access-jwt-assertion': adaToken },
    }), env, '')).json();
    const subject = await subjectBound(sub);
    const emailKey = await emailBound(adaEmail);
    const bound = {
      'X-Atlas-Bound-Subject': subject,
      'X-Atlas-Bound-Email': emailKey,
      'X-Atlas-CSRF': boot.csrf,
      Origin: ORIGIN,
    };
    const pcm = new Uint8Array(4800);
    const project = JSON.stringify({ project: { title: 'Synthetic', role: '', sector: '', stage: '', answers: ['one change', '', '', '', '', ''] } });
    const routes = [
      ['consent', ORIGIN + '/api/consent', { method: 'POST', body: '{}', headers: { ...bound, 'Content-Type': 'application/json' } }],
      ['me/erase', ORIGIN + '/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { ...bound, 'Content-Type': 'application/json' } }],
      ['me/export', ORIGIN + '/api/me/export', { method: 'GET', headers: { ...bound } }],
      ['memory', ORIGIN + '/api/memory', { method: 'GET', headers: { ...bound } }],
      ['sheet', ORIGIN + '/api/sheet/ingest', { method: 'POST', body: 'synthetic-bytes', headers: { ...bound, 'Content-Type': 'application/octet-stream' } }],
      ['transcribe', ORIGIN + '/api/transcribe', { method: 'POST', body: pcm, headers: { ...bound, 'Content-Type': 'audio/L16;rate=24000', 'X-Atlas-Consent': 'spoken-ask-v1; once' } }],
      ['jev/classify', ORIGIN + '/api/jev/classify', { method: 'POST', body: project, headers: { ...bound, 'Content-Type': 'application/json' } }],
      ['library GET', ORIGIN + '/api/library/journey', { method: 'GET', headers: { ...bound } }],
      ['library POST', ORIGIN + '/api/library', { method: 'POST', body: '{}', headers: { ...bound, 'Content-Type': 'application/json' } }],
      ['privacy delete', ORIGIN + '/api/library/privacy/delete', { method: 'POST', body: '{}', headers: { ...bound, 'Content-Type': 'application/json' } }],
      ['voice', ORIGIN + '/api/voice', { method: 'GET', headers: { ...bound, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'atlas-bound-' + subject } }],
    ];
    const failures = [];
    for (const [name, url, init] of routes) {
      opened.length = 0;
      const headers = { 'cf-access-jwt-assertion': renamedToken, ...init.headers };
      let got;
      try {
        const res = await handle(new Request(url, { method: init.method, body: init.body, headers }), env, '', {
          flagsOf: () => ({ spokenAsk: true }),
        });
        got = await outcome(res, opened);
      } catch (e) {
        got = { status: 0, opened: opened.slice(), error: String(e.message || e), code: '', marker: false };
      }
      const closed = got.status === 409 && got.opened.length === 0 && got.code === 'IDENTITY_CHANGED' && got.marker === false
        && got.error === FAILURE.error;
      if (!closed) failures.push(name + ' ' + JSON.stringify(got));
    }
    assert.deepEqual(failures, []);
  });

  test('a non-Latin-1 mailbox mints an email key and does not throw', async () => {
    const mailbox = '用户@example.test';
    const token = await tokenFor({ sub: 'user-ada', email: mailbox });
    let threw = false;
    let res;
    try {
      res = await handle(new Request(ORIGIN + '/api/bootstrap', {
        headers: { 'cf-access-jwt-assertion': token },
      }), envFor(binder({}).binding, binder({}).binding), '');
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false);
    const body = await res.json();
    const headerValues = [...res.headers].map(([, value]) => value).join('\n');
    assert.equal(headerValues.includes(mailbox), false);
    assert.match(body.identity.boundSubject, /^[0-9a-f]{32}$/);
    assert.match(body.identity.boundEmail, /^[0-9a-f]{32}$/);
    assert.equal(body.identity.boundSubject, await subjectBound('user-ada'));
    assert.equal(body.identity.boundEmail, await emailBound(mailbox));
    assert.notEqual(body.identity.boundSubject, body.identity.subjectKey);
    assert.notEqual(body.identity.boundEmail, body.identity.subjectKey);
    assert.notEqual(body.identity.boundSubject, await logPseudonym('user-ada'));
  });

  for (const [label, value] of [
    ['wrong length', 'a'.repeat(31)],
    ['non-hex', 'g'.repeat(32)],
    ['upper case', 'A'.repeat(32)],
  ]) {
    test('a ' + label + ' bound key is a mismatch and opens nothing', async () => {
      const ada = await established();
      const library = binder({ title: MARKER });
      const interview = binder({ title: MARKER });
      const res = await handle(new Request(ORIGIN + '/api/library/journey', {
        headers: {
          'cf-access-jwt-assertion': ada.token,
          'X-Atlas-Bound-Subject': value,
          'X-Atlas-Bound-Email': await emailBound(ADA.email),
        },
      }), envFor(library.binding, interview.binding), '');
      assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
    });
  }

  test('a duplicated bound header is a mismatch and opens nothing', async () => {
    const ada = await established();
    const key = await subjectBound(ADA.sub);
    const headers = new Headers({ 'cf-access-jwt-assertion': ada.token });
    headers.append('x-atlas-bound-subject', key);
    headers.append('x-atlas-bound-subject', key);
    const library = binder({ title: MARKER });
    const interview = binder({});
    const res = await handle(new Request(ORIGIN + '/api/library/journey', { headers }), envFor(library.binding, interview.binding), '');
    assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
  });

  test('an Entra token with no mailbox rejects a presented email key', async () => {
    const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const token = await jwt({ sub: 'cf-' + oid, custom: { tid, oid } });
    const { binding, opened } = recordingBindings();
    const { env } = entraBase(binding, binding);
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: {
        'cf-access-jwt-assertion': token,
        'X-Atlas-Bound-Subject': await subjectBound(tid + ':' + oid),
        'X-Atlas-Bound-Email': 'ab'.repeat(16),
      },
    }), env, '');
    assert.deepEqual(await outcome(res, opened), FAILURE);
  });

  test('a bound mismatch writes identity_changed and not the email or the raw subject', async () => {
    const ada = await established();
    const lines = [];
    const library = binder({ title: MARKER });
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: {
        'cf-access-jwt-assertion': ada.token,
        'X-Atlas-Bound-Subject': 'ab'.repeat(16),
        'cf-connecting-ip': '203.0.113.9',
      },
    }), envFor(library.binding, binder({}).binding), '', { log: line => lines.push(String(line)) });
    const rec = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row && row.event === 'identity_changed');
    const blob = JSON.stringify(rec || lines);
    assert.equal(res.status, 409);
    assert.ok(rec);
    assert.equal(rec.reason, 'IDENTITY_CHANGED');
    assert.equal(rec.status, 409);
    assert.equal(blob.includes(ADA.email), false);
    assert.equal(blob.includes(ADA.sub), false);
    assert.equal(blob.includes('ab'.repeat(16)), false);
  });

  test('a forwarded durable object request has no X-Atlas-Bound header', async () => {
    const ada = await established();
    const subject = await subjectBound(ADA.sub);
    const emailKey = await emailBound(ADA.email);
    const { binding, forwarded, opened } = recordingBindings();
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: {
        'cf-access-jwt-assertion': ada.token,
        'X-Atlas-Bound-Subject': subject,
        'X-Atlas-Bound-Email': emailKey,
      },
    }), envFor(binding, binding), '');
    assert.equal(res.status, 200);
    assert.ok(opened.length > 0);
    const req = forwarded[0];
    assert.ok(req);
    assert.equal(req.headers.get('x-atlas-bound-subject'), null);
    assert.equal(req.headers.get('x-atlas-bound-email'), null);
  });

  test('a matching bound key still reaches the library', async () => {
    const ada = await established();
    const library = binder({ title: 'Ada library' });
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: {
        'cf-access-jwt-assertion': ada.token,
        'X-Atlas-Bound-Subject': await subjectBound(ADA.sub),
        'X-Atlas-Bound-Email': await emailBound(ADA.email),
      },
    }), envFor(library.binding, binder({}).binding), '');
    assert.equal(res.status, 200);
    assert.deepEqual(library.opened, ['global']);
  });

  test('a request with no bound key still reaches the library', async () => {
    const ada = await established();
    const library = binder({ title: 'Ada library' });
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: { 'cf-access-jwt-assertion': ada.token },
    }), envFor(library.binding, binder({}).binding), '');
    assert.equal(res.status, 200);
    assert.deepEqual(library.opened, ['global']);
  });

  test('a voice upgrade with no subprotocol still opens the interview and echoes nothing', async () => {
    const ada = await established();
    const opened = [];
    const interview = {
      idFromName(name) { opened.push(String(name)); return name; },
      get() { return { fetch: async () => new Response(null, { status: 200 }) }; },
    };
    const res = await handle(new Request(ORIGIN + '/api/voice', {
      headers: { 'cf-access-jwt-assertion': ada.token, Upgrade: 'websocket', Origin: ORIGIN },
    }), envFor(binder({}).binding, interview), '');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('sec-websocket-protocol'), null);
    assert.deepEqual(opened, [ADA.sub]);
  });

  test('an Entra token with no mailbox and a matching subject key reaches the library', async () => {
    const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const token = await jwt({ sub: 'cf-' + oid, custom: { tid, oid } });
    const { binding, opened } = recordingBindings();
    const { env } = entraBase(binding, binding);
    const res = await handle(new Request(ORIGIN + '/api/library/journey', {
      headers: {
        'cf-access-jwt-assertion': token,
        'X-Atlas-Bound-Subject': await subjectBound(tid + ':' + oid),
      },
    }), env, '');
    assert.equal(res.status, 200);
    assert.deepEqual(opened, ['global']);
  });
});
