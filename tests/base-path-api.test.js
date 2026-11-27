// Wiki and continuity callers in intelligence-ui.js must use AtlasAuth.path.
// With APP_BASE_PATH set, a fetch of host-root /api/wiki or /api/memory/context fails this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src/intelligence-ui.js'), 'utf8');
const keeper = fs.readFileSync(path.join(root, 'src/session-keeper.js'), 'utf8');

function sliceFn(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, signature);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, signature);
  return src.slice(at, end + 2);
}

test('intelligence api and wiki export keep APP_BASE_PATH', async () => {
  const apiSrc = sliceFn(ui, "async function api(path,method='GET',data){");
  const appPathSrc = sliceFn(keeper, 'function appPath(path){');
  const literals = [...ui.matchAll(/api\(\s*'(\/api\/[^']*)'/g)].map((match) => match[1]);
  assert.ok(literals.some((item) => item.startsWith('/api/wiki')));
  assert.ok(literals.some((item) => item.startsWith('/api/memory/context')));
  const outside = ui.replace(apiSrc, '');
  const raw = [...outside.matchAll(/fetch\(\s*(['"`])(\/api\/[^'"`]*)\1/g)].map((match) => match[2]);
  assert.deepEqual(raw, [], 'host-root fetch ' + raw.join(','));
  const exportExpr = outside.match(/fetch\(([\s\S]*?),\s*\{method:'POST'/)[1];
  assert.match(exportExpr, /AtlasAuth\.path\(/);
  assert.match(apiSrc, /AtlasAuth\.path\(path\)/);

  const calls = [];
  const sandbox = {
    location: { protocol: 'https:' },
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: true, text: async () => '', json: async () => ({}) };
    },
    AbortSignal,
    Error,
    window: { AtlasVoice: { bootstrap: () => ({ csrf: 'fixture' }) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(appPathSrc + '\nwindow.AtlasAuth={path:appPath};\n' + apiSrc + '\nthis.api=api;', sandbox);

  const paths = [...new Set(literals.concat([
    '/api/wiki/story-1',
    '/api/wiki/story-1/withdraw',
    '/api/wiki/story-1/review',
    '/api/wiki/story-1/refine',
    '/api/memory/context',
  ]))];
  for (const base of ['/run/atlas/', '/run/atlas-dev/']) {
    sandbox.window.ATLAS_RUNTIME = { basePath: base };
    calls.length = 0;
    for (const item of paths) await sandbox.api(item, 'GET');
    assert.equal(calls.length, paths.length);
    for (let i = 0; i < paths.length; i++) {
      assert.equal(calls[i], base.replace(/\/$/, '') + paths[i]);
      assert.equal(calls[i].startsWith('/api/'), false, calls[i]);
    }
    assert.equal(vm.runInContext(exportExpr, sandbox), base.replace(/\/$/, '') + '/api/wiki/export');
  }
  sandbox.window.ATLAS_RUNTIME = undefined;
  calls.length = 0;
  await sandbox.api('/api/wiki', 'GET');
  assert.equal(calls[0], '/api/wiki');
});
