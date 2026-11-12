// Preview Access: the team domain is only a cert host when it is one <team>.cloudflareaccess.com label.
// A blank audience is the same closed door as a missing one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, verifyAccess } from '../src/app.js';

const SUFFIX = '-atlas.tony-walteur.workers.dev';
const HOST = 'https://gate8-atlas.tony-walteur.workers.dev';
const PAGE = '<script>/* SERVER_RUNTIME */</script></body>';
const CLOSED = 'Preview Access is not configured.';

function env(extra = {}) {
  return {
    ATLAS_PREVIEW: '1', ATLAS_PREVIEW_HOST_SUFFIX: SUFFIX, LEDGER_MODE: 'enforce', CSRF_SECRET: 'preview-test-secret',
    ACCESS_AUD: 'preview-aud', ACCESS_TEAM_DOMAIN: 'preview-team.cloudflareaccess.com', ...extra,
  };
}

test('a preview team domain that is not one cloudflareaccess.com host returns 403 and is not fetched', async () => {
  const hostile = [
    'https://tony-walteur.cloudflareaccess.com',
    'http://tony-walteur.cloudflareaccess.com',
    'tony-walteur.cloudflareaccess.com/cdn-cgi/access/certs',
    'tony-walteur.cloudflareaccess.com:443',
    'user:pass@tony-walteur.cloudflareaccess.com',
    'tony-walteur.cloudflareaccess.com.evil.com',
    'extra.tony-walteur.cloudflareaccess.com',
    'evil.com',
    '127.0.0.1',
    'cloudflareaccess.com',
    'tony-walteur.cloudflareaccess.com.',
    ' tony-walteur.cloudflareaccess.com',
    'tony-walteur.cloudflareaccess.com\n',
    '//tony-walteur.cloudflareaccess.com',
    'Tony-Walteur.cloudflareaccess.com',
  ];
  const fetched = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async url => { fetched.push(String(url)); return new Response('no'); };
  try {
    for (const team of hostile) {
      const res = await handle(new Request(HOST + '/'), env({ ACCESS_TEAM_DOMAIN: team }), PAGE);
      assert.equal(res.status, 403, team);
      assert.equal(await res.text(), CLOSED, team);
    }
    const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'hostile' };
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'hostile' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ aud: ['preview-aud'], iss: 'https://evil.com', sub: 'user', exp: now + 600 })).toString('base64url');
    const input = header + '.' + body;
    const token = input + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input))).toString('base64url');
    let called = 0;
    const who = await verifyAccess(new Request(HOST + '/', { headers: { 'cf-access-jwt-assertion': token } }), env({ ACCESS_TEAM_DOMAIN: 'evil.com' }), async () => { called += 1; return new Response(JSON.stringify({ keys: [jwk] })); });
    assert.equal(who, null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = previous;
  }
  assert.deepEqual(fetched, []);
});

test('a blank preview audience returns 403 and not the sign-in page', async () => {
  for (const aud of ['', ' ', '\t', '\n', ' \t ']) {
    const res = await handle(new Request(HOST + '/'), env({ ACCESS_AUD: aud }), PAGE);
    assert.equal(res.status, 403, JSON.stringify(aud));
    assert.equal(await res.text(), CLOSED, JSON.stringify(aud));
  }
});
