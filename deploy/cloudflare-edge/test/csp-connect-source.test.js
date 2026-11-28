// The voice page puts one websocket origin in connect-src. That value is not CSP text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlCsp, legacyCsp } from '../src/csp.js';

test('a connect value cannot add another CSP directive or a second origin', () => {
  const injected = 'wss://good.example; worker-src *';
  for (const policy of [htmlCsp({ connect: injected }), legacyCsp(injected)]) {
    assert.equal(policy.includes('worker-src *'), false);
    assert.equal(policy.includes('good.example'), false);
    assert.match(policy, /connect-src 'self'(?:;|$)/);
  }
  const extra = 'wss://good.example https://evil.example';
  assert.equal(htmlCsp({ connect: extra }).includes('evil.example'), false);
  assert.match(htmlCsp({ connect: 'wss://good.example', scriptBlob: true }), /connect-src 'self' wss:\/\/good\.example/);
  assert.match(legacyCsp('ws://127.0.0.1:8080'), /connect-src 'self' ws:\/\/127\.0\.0\.1:8080/);
  assert.match(htmlCsp({ connect: 'wss://[::1]:8443' }), /connect-src 'self' wss:\/\/\[::1\]:8443/);
});
