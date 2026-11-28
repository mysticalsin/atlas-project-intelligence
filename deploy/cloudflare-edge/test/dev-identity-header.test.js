import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devIdentityHeaderError } from '../dev/dev-identity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const edgeHtml = join(root, 'src', 'atlas.html');
const voiceHtml = join(root, '..', '..', 'ATLAS_Voice.html');

test('a header-safe development identity is empty, and a code point above 255 is refused', () => {
  assert.equal(devIdentityHeaderError('consultant@example.test'), '');
  assert.equal(devIdentityHeaderError('caf\u00e9@example.test'), '');
  assert.equal(devIdentityHeaderError('\u7528\u6237@example.test'), 'This development identity cannot be used as a request header.');
  assert.equal(devIdentityHeaderError('ada@example.test\u7528'), 'This development identity cannot be used as a request header.');
});

test('the local edge answers 400 for a CJK development identity and still serves a Latin-1 one', async () => {
  assert.equal(existsSync(voiceHtml), true, 'ATLAS_Voice.html is required to start the local edge');
  const created = !existsSync(edgeHtml);
  if (created) copyFileSync(voiceHtml, edgeHtml);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--no-warnings', 'dev/local-edge.mjs', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local edge did not listen: ' + log.slice(-500))), 20000);
      const done = () => { if (log.includes('local edge on')) { clearTimeout(timer); resolve(); } };
      done();
      child.stdout.on('data', done);
      child.on('exit', code => { clearTimeout(timer); reject(new Error('local edge exited ' + code + ': ' + log.slice(-500))); });
    });
    const get = async query => {
      const res = await fetch('http://127.0.0.1:' + port + query);
      return { status: res.status, body: await res.text() };
    };
    const ascii = await get('/api/bootstrap?as=consultant@example.test');
    assert.equal(ascii.status, 200);
    assert.equal(ascii.body.includes('consultant@example.test'), true);
    const latin1 = await get('/api/bootstrap?as=' + encodeURIComponent('caf\u00e9@example.test'));
    assert.equal(latin1.status, 200);
    assert.equal(latin1.body.includes('This development identity cannot be used as a request header.'), false);
    const cjk = await get('/api/library?as=' + encodeURIComponent('\u7528\u6237@example.test'));
    assert.equal(cjk.status, 400);
    assert.equal(cjk.body, 'This development identity cannot be used as a request header.');
    const again = await get('/api/bootstrap?as=consultant@example.test');
    assert.equal(again.status, 200);
  } finally {
    stop();
    await new Promise(resolve => child.on('exit', resolve));
    if (created) rmSync(edgeHtml, { force: true });
  }
});
