// Python ↔ JavaScript parity for the talker's server pacing note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paceNotes } from '../src/session.js';
const V = JSON.parse(readFileSync(new URL('./pace.vectors.json', import.meta.url)));
test('pace note parity', () => { for (const [args, expected] of V) assert.deepEqual(paceNotes(...args), expected); });
