'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

test('the N+1 draft does not repeat a recorded client name', () => {
  const project = E.project({
    title: 'Zebracorp queue',
    consultant: 'Alex',
    role: 'Zebracorp lead',
    sector: 'Zebracorp desks',
    stage: 'Pilot',
  });
  project.client = { name: 'Zebracorp', location: 'Lyon', contact: 'CIO' };
  project.validation = E.cleanValidation({ manager: { name: 'Sam', email: 'sam@example.com' } });
  project.report = E.cleanReport({
    headline: 'Zebracorp triage in Lyon',
    summary: 'The CIO at zebracorp asked for a shorter queue.',
    highlights: ['ZEBRACORP adopted it'],
    gaps: ['Ask the CIO again'],
  });
  const draft = E.validationEmail(project, 'https://atlas.example/library/abc');
  const text = draft.subject + '\n' + draft.body;
  assert.equal(draft.to, 'sam@example.com');
  assert.equal(text.includes('Zebracorp'), false);
  assert.equal(text.includes('zebracorp'), false);
  assert.equal(text.includes('ZEBRACORP'), false);
  assert.equal(text.includes('Lyon'), false);
  assert.equal(text.includes('CIO'), false);
  assert.equal(text.includes('Sam'), true);
  assert.match(text, /not included in this email/);
});

test('the N+1 draft uses the same client scrub as the stored report', () => {
  const report = E.cleanReport({
    headline: 'Zebra.Corp triage',
    summary: 'Noted in Lyon.',
    highlights: ['zebra.corp adopted it'],
    gaps: ['ZebraXCorp is a different token'],
  });
  const scrubbed = E.scrubReport(report, { name: 'Zebra.Corp', location: 'Lyon', contact: 'Head of Claims' });
  assert.equal(scrubbed.headline, 'the client triage');
  assert.equal(scrubbed.gaps[0], 'ZebraXCorp is a different token');
  const project = E.project({ title: 'Queue', consultant: 'Alex' });
  project.client = { name: 'Zebra.Corp', location: 'Lyon', contact: 'Head of Claims' };
  project.validation = E.cleanValidation({ manager: { name: 'Sam', email: 'sam@example.com' } });
  project.report = report;
  const text = E.validationEmail(project).subject + '\n' + E.validationEmail(project).body;
  assert.equal(text.includes('Zebra.Corp'), false);
  assert.equal(text.includes('zebra.corp'), false);
  assert.equal(text.includes('Lyon'), false);
  assert.equal(text.includes('ZebraXCorp is a different token'), true);
});
