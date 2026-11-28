'use strict';
// Requires src/pptx.js. build.py inlines that module into the HTML aliases;
// this file is a node test and is not one of those aliases.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/pptx.js');

function entries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  assert.equal(v.getUint32(e, true), 0x06054b50);
  const n = v.getUint16(e + 10, true);
  let o = v.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(v.getUint32(o, true), 0x02014b50);
    const crc = v.getUint32(o + 16, true);
    const size = v.getUint32(o + 20, true);
    const nl = v.getUint16(o + 28, true);
    const lo = v.getUint32(o + 42, true);
    const name = new TextDecoder().decode(b.slice(o + 46, o + 46 + nl));
    const ln = v.getUint16(lo + 26, true);
    const data = b.slice(lo + 30 + ln, lo + 30 + ln + size);
    assert.equal(P.crc32(data), crc, name);
    out[name] = new TextDecoder().decode(data);
    o += 46 + nl;
  }
  return out;
}

function deck(extra) {
  return {
    title: 'Claims triage',
    subtitle: 'Insurance',
    summary: 'Queue time fell.',
    sections: [{ heading: 'Results', bullets: [{ text: 'Fell from 40 to 12.', kind: 'fact' }] }],
    facts: { industry: 'Insurance', technologies: ['Python'] },
    reference: { revision: 4, status: 'in_review', title: 'Claims triage' },
    ...extra,
  };
}

const SERVER_WARNING = 'Draft reference: not validated for client use.';

test('pptx: a draft warning is written and the file does not call the reference validated', () => {
  const slide = entries(P.build(deck({ warning: SERVER_WARNING })))['ppt/slides/slide2.xml'];
  assert.match(slide, /Draft reference: not validated for client use\./);
  assert.match(slide, /\(r4\)/);
  assert.match(slide, /nothing was added/);
  assert.doesNotMatch(slide, /validated ATLAS reference/);
});

test('pptx: warning text is escaped, and a published reference with no warning stays validated', () => {
  const marked = entries(P.build(deck({ warning: 'Draft <ref> & "notes"' })))['ppt/slides/slide2.xml'];
  assert.match(marked, /Draft &lt;ref&gt; &amp; &quot;notes&quot;/);
  assert.doesNotMatch(marked, /<ref>/);
  assert.doesNotMatch(marked, /validated ATLAS reference/);
  const published = entries(P.build(deck({
    warning: '',
    reference: { revision: 4, status: 'published', title: 'Claims triage' },
  })))['ppt/slides/slide2.xml'];
  assert.match(published, /validated ATLAS reference \(r4\)/);
  assert.doesNotMatch(published, /Draft reference/);
  const blank = entries(P.build(deck({ warning: '   ' })))['ppt/slides/slide2.xml'];
  assert.match(blank, /validated ATLAS reference \(r4\)/);
});
