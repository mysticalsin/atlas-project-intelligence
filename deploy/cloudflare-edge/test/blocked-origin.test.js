// A blocked URL in the security log keeps the origin. A path, query, or password is not stored.
// Synthetic hosts only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secEvent } from '../src/security-log.js';

async function logged(blocked) {
  return secEvent({}, 'csp_violation', { blocked }, () => {});
}

test('a blocked URL keeps the origin and drops a path, query, and password', async () => {
  const token = await logged('https://cdn.example/app?token=synthetic-token');
  assert.equal(token.blocked, 'https://cdn.example');
  assert.equal(JSON.stringify(token).includes('synthetic-token'), false);

  const password = await logged('https://user:synthetic-pass@cdn.example/x');
  assert.equal(password.blocked, 'https://cdn.example');
  assert.equal(JSON.stringify(password).includes('synthetic-pass'), false);

  const port = await logged('https://user:synthetic-pass@cdn.example:8443/private/path');
  assert.equal(port.blocked, 'https://cdn.example:8443');
  assert.equal(JSON.stringify(port).includes('synthetic-pass'), false);
  assert.equal(JSON.stringify(port).includes('private'), false);

  assert.equal((await logged('https://[2001:db8::1]/private')).blocked, 'https://[2001:db8::1]');
  assert.equal((await logged('HTTPS://EVIL.EXAMPLE/Path?q=1')).blocked, 'https://evil.example');
  assert.equal((await logged('wss://voice.example/socket')).blocked, 'wss://voice.example');
  assert.equal((await logged('http://127.0.0.1:8787/admin?k=synthetic')).blocked, 'http://127.0.0.1:8787');
  assert.equal((await logged('https://cdn.example')).blocked, 'https://cdn.example');
  assert.equal((await logged('https://cdn.example/a#synthetic-token')).blocked, 'https://cdn.example');
});

test('a blocked keyword or scheme word stays, and a payload does not', async () => {
  assert.equal((await logged('inline')).blocked, 'inline');
  assert.equal((await logged('INLINE')).blocked, 'inline');
  assert.equal((await logged('self')).blocked, 'self');

  const script = await logged('javascript:alert(1)');
  assert.equal(script.blocked, 'javascript');
  assert.equal(JSON.stringify(script).includes('alert'), false);

  const blob = await logged('blob:https://cdn.example/uuid-synthetic');
  assert.equal(blob.blocked, 'blob');
  assert.equal(JSON.stringify(blob).includes('uuid-synthetic'), false);

  const data = await logged('data:text/html,synthetic');
  assert.equal(data.blocked, 'data');
  assert.equal(JSON.stringify(data).includes('synthetic'), false);

  assert.equal((await logged('not a url')).blocked, 'unknown');
  assert.equal((await logged('ftp://files.example/a')).blocked, 'unknown');

  const smashed = await logged('https://cdn.example/a\nX-Token: synthetic');
  assert.equal(smashed.blocked, 'https://cdn.example');
  assert.equal(JSON.stringify(smashed).includes('synthetic'), false);
  assert.equal(JSON.stringify(smashed).includes('Token'), false);
});
