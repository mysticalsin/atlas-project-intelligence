// Access certs are cached per team domain, and an expired cache does not authenticate when the refetch fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccess } from '../src/app.js';

const TTL = 600_000;
const b64u = bytes => Buffer.from(bytes).toString('base64url');

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return { ...pair, jwk };
}

async function token(privateKey, kid, team, aud = 'aud-1') {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid };
  const body = { aud: [aud], iss: `https://${team}`, sub: 'user-1', email: 'user@example.com', exp: now + 600, iat: now };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}

function request(jwt) {
  return new Request('https://atlas.example/', { headers: { 'cf-access-jwt-assertion': jwt } });
}

test('an expired cert cache refetches, and a failed refetch does not keep the old key', async () => {
  const team = 'expire.cloudflareaccess.com';
  const first = await keyPair('old');
  const next = await keyPair('new');
  const urls = [];
  let fail = false;
  let keys = [first.jwk];
  const fetcher = async url => {
    urls.push(String(url));
    if (fail) throw new Error('directory down');
    return new Response(JSON.stringify({ keys }));
  };
  const env = { ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: team };
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  try {
    const ok = await verifyAccess(request(await token(first.privateKey, 'old', team)), env, fetcher);
    assert.equal(ok.sub, 'user-1');
    assert.deepEqual(urls, [`https://${team}/cdn-cgi/access/certs`]);
    const again = await verifyAccess(request(await token(first.privateKey, 'old', team)), env, fetcher);
    assert.equal(again.sub, 'user-1');
    assert.equal(urls.length, 1, 'a fresh cache is not refetched');
    clock += TTL + 1;
    keys = [next.jwk];
    const rotated = await verifyAccess(request(await token(next.privateKey, 'new', team)), env, fetcher);
    assert.equal(rotated.sub, 'user-1');
    assert.equal(urls.length, 2, 'expiry refetches');
    clock += TTL + 1;
    fail = true;
    const closed = await verifyAccess(request(await token(next.privateKey, 'new', team)), env, fetcher);
    assert.equal(closed, null);
  } finally {
    Date.now = realNow;
  }
});

test('cert caches are per team, so one team does not verify another team with the same kid', async () => {
  const teamA = 'alpha.cloudflareaccess.com';
  const teamB = 'beta.cloudflareaccess.com';
  const keyA = await keyPair('shared');
  const keyB = await keyPair('shared');
  const urls = [];
  const fetcher = async url => {
    urls.push(String(url));
    const team = String(url).includes('alpha') ? teamA : teamB;
    const jwk = team === teamA ? keyA.jwk : keyB.jwk;
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  const envA = { ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: teamA };
  const envB = { ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: teamB };
  const a = await verifyAccess(request(await token(keyA.privateKey, 'shared', teamA)), envA, fetcher);
  assert.equal(a.sub, 'user-1');
  const b = await verifyAccess(request(await token(keyB.privateKey, 'shared', teamB)), envB, fetcher);
  assert.equal(b.sub, 'user-1');
  assert.deepEqual(urls, [`https://${teamA}/cdn-cgi/access/certs`, `https://${teamB}/cdn-cgi/access/certs`]);
});
