// A client name is scrubbed before the sheet draft is serialised.
// JSON escaping would hide a quote, a backslash, or a newline from a later pass.
// Synthetic names only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftMessages } from '../src/sheet.js';

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function promptFor(name) {
  const messages = draftMessages({
    client: { name, location: 'Lyon', contact: '' },
    project: { title: 'Queue for ' + name, sector: 'Insurance' },
    current: { exec: { summary: 'Work with ' + name + ' in Lyon.' } },
    answers: 'The ' + name + ' team kept the queue.',
    documentText: name + ' approved the handover in Lyon.',
  });
  const body = messages[1].content;
  const parsed = JSON.parse(body);
  return { body, parsed, text: strings(parsed).join('\n') };
}

test('a client name that JSON would escape is removed before the model sees it', () => {
  for (const name of ['Foo "Bar" Ltd', 'Acme\\North', 'Foo\nBar Ltd']) {
    const { parsed, text } = promptFor(name);
    assert.equal(text.includes(name), false, name);
    assert.equal(parsed.project.sector, 'Insurance');
    assert.equal(parsed.project.title, 'Queue for the client');
    assert.equal(parsed.current_sheet.exec.summary, 'Work with the client in the client.');
    assert.equal(parsed.consultant_answers_to_challenges, 'The the client team kept the queue.');
    assert.equal(parsed.source_document, 'the client approved the handover in the client.');
  }
});

test('a plain client name is still removed and the prompt stays JSON', () => {
  const { body, parsed, text } = promptFor('Zebracorp');
  assert.equal(text.includes('Zebracorp'), false);
  assert.equal(text.includes('Lyon'), false);
  assert.equal(JSON.parse(body).source_document, parsed.source_document);
  assert.equal(parsed.source_document, 'the client approved the handover in the client.');
});
