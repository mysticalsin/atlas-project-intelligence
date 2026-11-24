// A production demo conflict keeps the signed-in shell. Journey and Library
// show the 503 reason. The page names that conflict and does not invite a conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { ENV, ORIGIN, jwt } from './security-harness.js';

const page = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-stale'"></head><body>
<header data-shell="kept"><nav><button data-view="journey">Journey</button><button data-view="library">Library</button></nav></header>
<strong id="connectionStateLabel">Ready when you are</strong>
<h2 id="voiceHeading">Ready when you are.</h2>
<p id="voiceNetwork">ATLAS isn't answering right now.</p>
<p id="voiceCurly">ATLAS isn’t answering right now.</p>
<section id="journey"></section>
<p id="libraryStatusLine"></p>
<script>const label = 'Ready when you are';</script>
</body></html>`;

test('a production demo conflict keeps the shell and does not invite a conversation', async () => {
  const token = await jwt();
  const env = { ...ENV, ATLAS_DEV_IDENTITY: '1', ATLAS_TENANT_ISOLATION: 'local-synthetic' };
  const headers = { 'cf-access-jwt-assertion': token };
  const home = await handle(new Request(ORIGIN + '/', { headers }), env, page);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /data-shell="kept"/);
  assert.match(html, /data-view="journey"/);
  assert.match(html, /id="journey"/);
  assert.match(html, /id="libraryStatusLine"/);
  assert.match(html, /DATA_MODE=production cannot be combined/);
  assert.equal(html.includes('Ready when you are'), false);
  assert.equal(html.includes("isn't answering"), false);
  assert.equal(html.includes('isn\u2019t answering'), false);
  const boot = await handle(new Request(ORIGIN + '/api/bootstrap', { headers }), env, page);
  assert.equal(boot.status, 503);
  const body = await boot.json();
  assert.match(body.error, /Refused before any story, trust, or metric read/);
  assert.match(body.error, /DATA_MODE=production cannot be combined/);
  assert.equal(html.includes(body.error), true);
});
