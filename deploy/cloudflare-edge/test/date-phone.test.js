// A clock written after an ISO date is that date, not a phone number.
// The phone scan uses the same space the clock uses, so "2024-03-01 09:30"
// was masked and the day disappeared. A real phone after the date stays masked.
// Synthetic dates and numbers only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { piiText, pseudonymise } from '../src/scrub.js';

test('a dated clock stays, and a phone after that date is still masked', () => {
  assert.equal(piiText('Started 2024-03-01 09:30 and finished at noon.'), 'Started 2024-03-01 09:30 and finished at noon.');
  assert.equal(piiText('Started 2024-03-01T09:30 and finished at noon.'), 'Started 2024-03-01T09:30 and finished at noon.');
  assert.equal(piiText('Started 2024-03-01  09:30 and finished at noon.'), 'Started 2024-03-01  09:30 and finished at noon.');
  assert.equal(piiText('From 2024-03-01, 2019-2024: 40 to 12 minutes.'), 'From 2024-03-01, 2019-2024: 40 to 12 minutes.');
  assert.equal(piiText('On 2024-03-01 call +33 6 12 34 56 78.'), 'On 2024-03-01 call [phone].');
  assert.equal(piiText('On 2024-03-01 555-123-4567 the line was busy.'), 'On 2024-03-01 [phone] the line was busy.');
  assert.equal(piiText('Call +33 6 12 34 56 78, (555) 123-4567 or 06.12.34.56.78.'), 'Call [phone], [phone] or [phone].');
  const typed = pseudonymise(null, 'Started 2024-03-01 09:30. Call +33 6 12 34 56 78.');
  assert.equal(typed.text, 'Started 2024-03-01 09:30. Call [Phone 1].');
  assert.equal(typed.map['[Phone 1]'], '+33 6 12 34 56 78');
});
