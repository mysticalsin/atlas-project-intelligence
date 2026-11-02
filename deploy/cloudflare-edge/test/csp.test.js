// F1: the strict script CSP on every HTML response, the hash freshness check, the JSON runtime block and POST /api/csp-report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_SCRIPT_HASHES, RUNTIME_BLOCK, htmlCsp, htmlCspHeaders, inlineScriptHashes, runtimeBlock, withoutMetaCsp, cspMode } from '../src/csp.js';
import { parseReports, blockedOrigin, MAX_REPORT_BYTES } from '../src/csp-report.js';
import { handle, SIGNED_IN_HTML } from '../src/app.js';
import { CONFIRM_HTML } from '../src/confirm-page.js';
import { ENV, ORIGIN, session, ns, jwt } from './security-harness.js';

const root = f => new URL('../../../' + f, import.meta.url);
const PAGE = readFileSync(root('ATLAS_Voice.html'), 'utf8');
const scriptSrc = csp => /(?:^|; )script-src ([^;]*)/.exec(csp)[1];
const strictOk = csp => !/script-src[^;]*unsafe-inline|strict-dynamic|unsafe-eval/.test(csp) && csp.includes("script-src-attr 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'");

test('freshness: the generated hash list is exactly the executable inline scripts of the built page (rebuild with python3 build.py when this fails)', async () => {
  assert.deepEqual(await inlineScriptHashes(PAGE), PAGE_SCRIPT_HASHES);
  assert.ok(PAGE_SCRIPT_HASHES.length >= 25 && PAGE_SCRIPT_HASHES.every(h => /^sha256-[A-Za-z0-9+/]{43}=$/.test(h)));
  for (const alias of ['ATLAS_Intelligence.html', 'ATLAS_Project_Intelligence.html', 'ATLAS_Voice_Studio.html']) assert.equal(readFileSync(root(alias), 'utf8'), PAGE, alias + ' is an identical copy');
  assert.equal(PAGE.split(RUNTIME_BLOCK).length, 2, 'the runtime data block appears exactly once');
});

test('the page carries its own <meta> policy with the same hashes (an offline copy), and no inline handler attribute or javascript: URL', () => {
  const meta = /<meta content="([^"]*)" http-equiv="Content-Security-Policy"\/>/.exec(PAGE);
  assert.ok(meta, 'meta policy present');
  assert.ok(strictOk(meta[1]));
  assert.deepEqual([...scriptSrc(meta[1]).matchAll(/'(sha256-[^']+)'/g)].map(m => m[1]).sort(), PAGE_SCRIPT_HASHES);
  assert.ok(!PAGE.includes('__CSP_SCRIPT_SRC__'));
  assert.doesNotMatch(PAGE, /<[a-zA-Z][^<>]*\son[a-z]+\s*=/, 'no inline event handler attribute in the built markup');
  assert.doesNotMatch(PAGE, /href\s*=\s*["']\s*javascript:/i);
  assert.doesNotMatch(PAGE, /<script\b[^>]*\bsrc=/i, 'no external script');
});

test('htmlCsp: hashes + blob:, never unsafe-inline for script, the report target; the small-page variant has no fetch and no blob', () => {
  const full = htmlCsp({ hashes: ['sha256-aaa'], connect: 'wss://x.example' });
  assert.ok(strictOk(full));
  assert.equal(scriptSrc(full), "'sha256-aaa' blob:");
  assert.ok(full.includes("connect-src 'self' wss://x.example") && full.includes("frame-ancestors 'none'") && full.includes('report-uri /api/csp-report') && full.includes('report-to atlas-csp') && full.includes("style-src 'unsafe-inline'"));
  assert.equal(scriptSrc(htmlCsp({})), 'blob:');
  const small = htmlCsp({ hashes: ['sha256-aaa'], page: false, blob: false, report: false, formAction: "'none'", frameAncestors: 'https://t.example' });
  assert.equal(scriptSrc(small), "'sha256-aaa'"); assert.ok(!small.includes('connect-src') && !small.includes('report-') && small.endsWith("frame-ancestors https://t.example; require-trusted-types-for 'script'; trusted-types 'none'"));
  // Trusted Types on every variant: the full page allows the one policy safe-html.js creates, a small page none; never a default or duplicates
  assert.ok(full.includes("require-trusted-types-for 'script'; trusted-types atlas-html") && !/trusted-types[^;]*('allow-duplicates'|\bdefault\b|\*)/.test(full));
  assert.equal(scriptSrc(htmlCsp({ blob: false })), "'none'");
  const noBlob = htmlCsp({ hashes: ['sha256-aaa'], blob: false });
  assert.doesNotMatch(noBlob, /blob:/, 'blob: false removes every blob: source, not only the script one'); assert.ok(noBlob.includes("connect-src 'self'") && noBlob.includes('img-src data:;'));
});

test('every HTML route ships the strict policy with ITS OWN hashes: page, privacy notice, confirm, re-sign-in', async () => {
  const me = await session(ENV);
  const html = async (path) => { const r = await me.go(path); assert.equal(r.status, 200, path); assert.match(r.headers.get('content-type'), /text\/html/); return r; };
  const home = await html('/'), body = await home.text(), csp = home.headers.get('content-security-policy');
  assert.ok(strictOk(csp)); assert.deepEqual([...scriptSrc(csp).matchAll(/'(sha256-[^']+)'/g)].map(m => m[1]), PAGE_SCRIPT_HASHES);
  assert.equal(home.headers.get('reporting-endpoints'), 'atlas-csp="/api/csp-report"');
  assert.ok(csp.includes("connect-src 'self' wss://atlas.example.workers.dev") && csp.includes("frame-ancestors 'none'"));
  assert.equal(body, '<html></html>', 'sanity: the harness page is a stub');
  const signed = await html('/go/signed-in'), c1 = signed.headers.get('content-security-policy');
  assert.ok(strictOk(c1)); assert.equal(scriptSrc(c1), `'${(await inlineScriptHashes(SIGNED_IN_HTML))[0]}'`, 're-sign-in page: no blob:');
  const confirm = await html('/confirm'), c2 = confirm.headers.get('content-security-policy');
  assert.ok(strictOk(c2)); assert.equal(scriptSrc(c2), `'${(await inlineScriptHashes(CONFIRM_HTML))[0]}'`, 'confirm page: no blob:');
  const priv = await html('/privacy'), c3 = priv.headers.get('content-security-policy');
  assert.ok(strictOk(c3)); assert.equal(scriptSrc(c3), "'none'", 'the privacy notice has no script at all, so no script source');
  for (const c of [c1, c2, c3]) assert.doesNotMatch(c, /blob:/, 'only the voice page keeps blob: (X3, red I2)');
  assert.match(csp, /script-src [^;]*blob:/, 'the voice page keeps blob: for its AudioWorklet');
  for (const c of [csp, c1, c2, c3]) assert.ok(c.includes("require-trusted-types-for 'script'; trusted-types atlas-html"), 'every HTML route enforces Trusted Types');
  assert.doesNotMatch(await priv.text(), /<script/i);
  for (const r of [home, signed, confirm, priv]) assert.equal(r.headers.get('content-security-policy-report-only'), null);
  // data responses stay on the data-only policy
  const boot = await me.go('/api/bootstrap'); assert.equal(boot.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
});

test('the real built page served through the Worker: runtime facts in the JSON block, hashes still match the body that is sent, no executable runtime', async () => {
  const email = 'a"b</script><!--@mantu.com';
  const token = await jwt({ email }), env = { ...ENV, DATA_MODE: 'production' };
  const res = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), env, PAGE);
  const body = await res.text(), csp = res.headers.get('content-security-policy');
  assert.equal(res.status, 200);
  assert.deepEqual(await inlineScriptHashes(body), PAGE_SCRIPT_HASHES, 'filling the data block does not change any executable script');
  const m = /<script id="atlas-runtime" type="application\/json">([\s\S]*?)<\/script>/.exec(body);
  assert.ok(m && !m[1].includes('<'), 'no "<" can end the block');
  assert.deepEqual(Object.keys(JSON.parse(m[1])).sort(), ['authMode', 'name', 'subjectKey']);
  assert.equal(JSON.parse(m[1]).name, email, 'the value round-trips exactly');
  assert.ok(!body.includes('window.ATLAS_RUNTIME={') && !body.includes('SERVER_RUNTIME'), 'the server never writes script');
  assert.ok(body.includes("connect-src 'self' wss://atlas.example.workers.dev;"), 'the <meta> policy carries the ws origin too');
  assert.ok(strictOk(csp));
});

test('runtimeBlock escapes "<", U+2028 and U+2029 and round-trips any value', () => {
  const nasty = { name: '</script><script>alert(1)</script><!-- \u2028 \u2029 "\'\\ ' };
  const block = runtimeBlock(nasty), inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf('</script>'));
  assert.ok(!/[<\u2028\u2029]/.test(inner));
  assert.deepEqual(JSON.parse(inner), nasty);
  assert.ok(block.startsWith(RUNTIME_BLOCK.slice(0, RUNTIME_BLOCK.indexOf('{}'))));
});

test('ATLAS_CSP=report-only: the old policy is enforced, the strict one reported, and the page <meta> that would enforce is dropped', async () => {
  assert.equal(cspMode(ENV), 'enforce'); assert.equal(cspMode({ ATLAS_CSP: 'Report-Only' }), 'report-only'); assert.equal(cspMode({ ATLAS_CSP: 'junk' }), 'enforce');
  const ro = htmlCspHeaders({ ATLAS_CSP: 'report-only' }, { hashes: ['sha256-a'] });
  assert.ok(ro['Content-Security-Policy'].includes("script-src 'unsafe-inline' blob:") && strictOk(ro['Content-Security-Policy-Report-Only']));
  const me = await session({ ...ENV, ATLAS_CSP: 'report-only' }), r = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': me.token } }), { ...ENV, ATLAS_CSP: 'report-only' }, PAGE);
  const body = await r.text();
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'unsafe-inline'") && strictOk(r.headers.get('content-security-policy-report-only')));
  assert.ok(!/http-equiv="Content-Security-Policy"/.test(body.slice(0, 4000)) && withoutMetaCsp(PAGE) !== PAGE);
  const enforced = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': me.token } }), ENV, PAGE);
  assert.ok(/http-equiv="Content-Security-Policy"/.test((await enforced.text()).slice(0, 4000)), 'enforce mode keeps the <meta> (defence in depth)');
});

test('parseReports reads both wire formats and keeps only the directive name and the blocked ORIGIN', () => {
  const legacy = parseReports({ 'csp-report': { 'document-uri': 'https://atlas.example/secret?x=1', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/steal.js?token=abc', 'script-sample': 'alert(document.cookie)' } });
  assert.deepEqual(legacy, [{ directive: 'script-src-elem', blocked: 'https://evil.example' }]);
  const modern = parseReports([{ type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'wss://evil.example:8443/x' } }, { type: 'deprecation', body: {} }, null]);
  assert.deepEqual(modern, [{ directive: 'connect-src', blocked: 'wss://evil.example:8443' }]);
  assert.deepEqual(parseReports({ 'csp-report': { 'violated-directive': "script-src 'self'", 'blocked-uri': 'inline' } }), [{ directive: 'script-src', blocked: 'inline' }]);
  assert.equal(blockedOrigin('data:text/html;base64,AAAA'), 'data'); assert.equal(blockedOrigin('javascript:alert(1)'), 'javascript'); assert.equal(blockedOrigin('not a url ../etc'), 'unknown');
  assert.deepEqual(parseReports('x'), []); assert.deepEqual(parseReports(null), []); assert.deepEqual(parseReports({ 'csp-report': 5 }), []);
  assert.equal(parseReports(Array.from({ length: 50 }, () => ({ type: 'csp-violation', body: { effectiveDirective: 'img-src' } }))).length, 5, 'a batch is capped');
});

test('POST /api/csp-report: 204, one csp_violation event with directive + blocked origin and nothing else; no CSRF token needed; sign-in still required', async () => {
  const me = await session({ ...ENV, INTERVIEW: ns(), LIBRARY: ns() });
  const send = (body, headers = {}) => me.go('/api/csp-report', { method: 'POST', csrf: false, origin: false, body, headers: { 'Content-Type': 'application/csp-report', ...headers } });
  const r = await send(JSON.stringify({ 'csp-report': { 'document-uri': 'https://atlas.example.workers.dev/?as=tony@example.com', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/p/q?email=tony@example.com', 'script-sample': 'SECRET-CLIENT-TEXT' } }));
  assert.equal(r.status, 204); assert.equal(await r.text(), '');
  const events = me.logs.filter(l => l.event === 'csp_violation');
  assert.equal(events.length, 1);
  assert.equal(events[0].directive, 'script-src-elem'); assert.equal(events[0].blocked, 'https://evil.example'); assert.equal(events[0].reason, 'CSP_VIOLATION'); assert.equal(events[0].route, '/api/csp-report');
  const text = JSON.stringify(me.logs);
  for (const s of ['tony@example.com', 'SECRET-CLIENT-TEXT', '/p/q', 'document-uri']) assert.ok(!text.includes(s), s);
  me.logs.length = 0;
  assert.equal((await send(JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://cdn.example/a.png' } }]), { 'Content-Type': 'application/reports+json' })).status, 204);
  assert.deepEqual(me.logs.map(l => [l.event, l.directive, l.blocked]), [['csp_violation', 'img-src', 'https://cdn.example']]);
  me.logs.length = 0;
  assert.equal((await send('not json')).status, 204); assert.equal((await send('')).status, 204); assert.equal(me.logs.length, 0, 'junk is dropped quietly');
  const big = await send('{"csp-report":{"x":"' + 'a'.repeat(MAX_REPORT_BYTES) + '"}}');
  assert.equal(big.status, 413); assert.ok(me.logs.some(l => l.event === 'body_too_large'));
  assert.equal((await me.go('/api/csp-report', { method: 'POST', signed: false, csrf: false, origin: false, body: '{}' })).status, 401);
  assert.equal((await me.go('/api/csp-report')).status !== 204, true, 'GET is not a report');
});

test('POST /api/csp-report is rate limited per person (429) and the limiter failing does not block it', async () => {
  const limit = ns(() => new Response(JSON.stringify({ error: 'x', retryAfter: 30 }), { status: 429 }));
  const me = await session({ ...ENV, INTERVIEW: limit });
  const r = await me.go('/api/csp-report', { method: 'POST', csrf: false, origin: false, body: '{"csp-report":{"effective-directive":"img-src"}}' });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '30');
  assert.ok(!me.logs.some(l => l.event === 'csp_violation'), 'a refused report is not logged as a violation');
  const down = await session({ ...ENV, INTERVIEW: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } });
  assert.equal((await down.go('/api/csp-report', { method: 'POST', csrf: false, origin: false, body: '{}' })).status, 204);
});
