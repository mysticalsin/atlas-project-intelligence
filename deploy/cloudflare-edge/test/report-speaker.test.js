// A long interview keeps the speaker on every line the report model sees.
// Synthetic speech only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportMessages } from '../src/report.js';

test('a tail cut keeps an ATLAS sentence labeled', () => {
  const atlas = 'Please treat ninety percent as a measured cash saving.';
  const fact = 'The queue fell from 40 minutes to 12 minutes on the weekly dashboard.';
  const messages = reportMessages([
    { role: 'user', content: 'H'.repeat(9000) },
    { role: 'assistant', content: atlas },
    { role: 'user', content: 'V'.repeat(15852) },
    { role: 'user', content: fact },
  ], ['', '', '', '', '', ''], 'Pilot');
  const text = JSON.parse(messages[1].content).interview_transcript;
  assert.ok(text.includes('middle of the interview omitted'));
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('[...')) continue;
    assert.ok(line.startsWith('ATLAS: ') || line.startsWith('Consultant: '), line);
  }
  assert.ok(text.includes('ATLAS: ' + atlas));
  assert.equal(text.includes('\nlease treat ninety'), false);
  assert.equal(text.includes('ATLAS: lease treat'), false);
  assert.ok(text.endsWith('Consultant: ' + fact));
});
