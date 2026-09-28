// Python ↔ JavaScript parity for the end-of-interview report parser and the talker end marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EndMarker, parseReport, reportMessages } from '../src/report.js';

const V = JSON.parse(readFileSync(new URL('./report.vectors.json', import.meta.url)));
for (const [name, [input, expected]] of Object.entries(V.parse)) test('report parse parity: ' + name, () => assert.deepEqual(parseReport(input), expected));
test('end marker parity', () => {
  for (const [deltas, pieces, seen] of V.marker) { const m = new EndMarker(); assert.deepEqual([...deltas.map(d => m.feed(d)), m.flush()], pieces); assert.equal(m.seen, seen); }
});
test('report messages parity (Q/A transcript, head + tail kept)', () => { const m = reportMessages(V.history, ['ctx', '', '', 'out'], 'Pilot'); assert.deepEqual(m, V.messages);
  const t = JSON.parse(m[1].content).interview_transcript; assert.ok(t.startsWith('ATLAS: What was going on?\nConsultant: First answer.') && t.includes('middle of the interview omitted')); });
