import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetRoutes, parseDraft, draftMessages, parseVisuals, TBD } from '../src/sheet.js';

const req = (body, headers = {}) => new Request('https://atlas.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });

test('draft: every field present, unsupported fields are "To be completed", challenges bounded, client scrubbed before the model', async () => {
  let seen = null;
  const ai = { complete: async m => { seen = m; return 'Sure: {"title":"ERP rollout","exec":{"summary":"S1. S2. S3.","teamSize":"5 consultants: 3 in Paris, 2 in Madrid"},"sections":{"scope":"Rolled out SAP."},"challenges":[{"group":"Results and ROI","questions":["What was saved?","q2","q3","q4","q5"]},{"group":"","questions":[]}]}'; } };
  const r = await (await sheetRoutes(req({ client: { name: 'Zebracorp', location: 'Lyon' }, documentText: 'Tender for Zebracorp in Lyon.', project: { sector: 'Insurance' } }), 'draft', ai)).json();
  assert.equal(r.exec.duration, TBD); assert.equal(r.sections.value, TBD); assert.equal(r.sections.scope, 'Rolled out SAP.');
  assert.equal(r.challenges.length, 1); assert.equal(r.challenges[0].questions.length, 4);
  assert.doesNotMatch(JSON.stringify(seen), /Zebracorp|Lyon/); assert.match(seen[1].content, /Tender for the client in the client/);
  assert.match(seen[0].content, /NEVER make up information/); assert.match(seen[0].content, /Never consultant counts/);
  assert.equal(parseDraft('no json'), null);
  const bad = await sheetRoutes(req({}), 'draft', { complete: async () => 'nope' }); assert.equal(bad.status, 502);
});

test('ingest: toMarkdown result returned and bounded; unreadable types and oversize files refused', async () => {
  const ai = { toMarkdown: async f => ({ name: f.name, format: 'markdown', data: 'x'.repeat(70000) }) };
  const r = await (await sheetRoutes(req(new Uint8Array([1, 2, 3]), { 'Content-Type': 'application/pdf', 'x-file-name': 'tender.pdf' }), 'ingest', ai)).json();
  assert.equal(r.text.length, 60000); assert.equal(r.truncated, true); assert.equal(r.name, 'tender.pdf');
  const bad = await sheetRoutes(req(new Uint8Array([1]), { 'x-file-name': 'a.pptx' }), 'ingest', { toMarkdown: async () => ({ format: 'error', error: 'unsupported' }) });
  assert.equal(bad.status, 415);
  assert.equal((await sheetRoutes(req(new Uint8Array(0)), 'ingest', ai)).status, 400);
});

test('visuals: images described, 2-3 selected, overall approach first, invalid indexes dropped', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');
  const ai = { toMarkdown: async f => ({ format: 'markdown', data: f.name.startsWith('logo') ? 'A company logo' : 'A diagram showing the project phases' }),
    complete: async m => { const u = JSON.parse(m[1].content); assert.equal(u.images.length, 3); return '{"selected":[{"index":2,"approach":false,"why":"Roadmap","caption":"Roadmap"},{"index":1,"approach":true,"why":"Approach","caption":"Overall approach (labels translated from French)"},{"index":9,"why":"bad"},{"index":1,"why":"dup"}]}'; } };
  const r = await (await sheetRoutes(req({ images: [{ name: 'logo', dataUrl: png }, { name: 'approach', dataUrl: png }, { name: 'roadmap', dataUrl: png }, { name: 'bad', dataUrl: 'javascript:x' }], context: 'ERP' }), 'visuals', ai)).json();
  assert.deepEqual(r.selected.map(s => s.index), [1, 2]); assert.equal(r.selected[0].approach, true);
  const refused = await sheetRoutes(req({ images: [{ name: 'diagram.png', dataUrl: png }] }), 'visuals', { toMarkdown: async () => { throw Object.assign(new Error('Image conversion is refused until detr-resnet-50 has a list price.'), { status: 413, code: 'unpriced_model' }); } });
  assert.equal(refused.status, 413); assert.equal((await refused.json()).code, 'unpriced_model');
  assert.deepEqual(parseVisuals('{"selected":[{"index":0},{"index":1},{"index":2},{"index":3}]}', 4).length, 3);
  assert.equal(draftMessages({}).length, 2);
});

import { projectContext } from '../src/session.js';
import { cleanReference, anonymise } from '../src/library.js';
import { forModel } from '../src/review.js';
test('Opp ID reaches the interviewer; the library keeps the sheet but contacts, price and file name never reach a model or other readers', () => {
  assert.equal(projectContext({ title: 'T', oppId: '00123' }).oppId, '00123'); assert.ok(!('oppId' in projectContext({ title: 'T' })));
  const r = cleanReference({ title: 'T', client: { name: 'Zebracorp' }, sheet: { oppId: '00123', exec: { summary: 'S', contacts: 'PM: Jo (jo@x.co)', price: 'EUR 250k' }, sections: { tools: 'SAP' }, file: { country: 'France', entity: 'NOPE' }, fileName: '00123 - France - Zebracorp - T.docx' } });
  assert.equal(r.sheet.file.entity, ''); assert.equal(r.sheet.exec.contacts, 'PM: Jo (jo@x.co)');
  for (const view of [forModel(r), anonymise(r)]) { const t = JSON.stringify(view); assert.doesNotMatch(t, /Jo \(jo@x\.co\)|EUR 250k|Zebracorp/); assert.match(t, /"tools":"SAP"/); }
});
