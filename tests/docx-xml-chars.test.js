'use strict';
// U+FFFE and U+FFFF are illegal in XML 1.0. A reference sheet or one-pager that
// keeps them is not a Word file: the document part does not parse. The writer
// already drops the other illegal controls. These two must go as well. A value
// that is only those characters is empty, so the sheet says "To be completed".
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const D = require('../src/docx.js');
const P = require('../src/pptx.js');

function entries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const e = b.length - 22;
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
    out[name] = data;
    o += 46 + nl;
  }
  return out;
}

function text(buf) {
  return new TextDecoder('utf-8', {fatal: true}).decode(buf);
}

function assertXml(buf) {
  const r = spawnSync('python3', ['-c', 'import sys,xml.etree.ElementTree as ET; ET.fromstring(sys.stdin.buffer.read())'], {input: buf});
  assert.equal(r.status, 0, r.stderr.toString());
}

const BAD = '\uFFFE\uFFFF';

test('reference sheet drops XML 1.0 noncharacters and still opens', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const bytes = D.build({
    title: 'Plan\u0007 ' + BAD + ' alpha & <x>',
    exec: {summary: 'Keep \uD83D\uDCA1 ' + BAD + ' this', teamSize: BAD, duration: '', price: '', contacts: ''},
    sections: {issue: 'Issue ' + BAD + ' text'},
    visuals: [{bytes: png, type: 'png', width: 16, height: 16, name: 'vis' + BAD + 'ual', caption: 'Cap ' + BAD + ' tion'}],
  });
  const parts = entries(bytes);
  const doc = text(parts['word/document.xml']);
  const core = text(parts['docProps/core.xml']);
  assert.equal(doc.includes('\uFFFE') || doc.includes('\uFFFF') || doc.includes('\u0007'), false);
  assert.equal(core.includes('\uFFFE') || core.includes('\uFFFF'), false);
  assertXml(parts['word/document.xml']);
  assertXml(parts['docProps/core.xml']);
  assert.match(doc, /Plan {2}alpha &amp; &lt;x&gt;/);
  assert.match(core, /<dc:title>Plan {2}alpha &amp; &lt;x&gt;<\/dc:title>/);
  assert.ok(doc.includes('Keep \uD83D\uDCA1  this'));
  assert.match(doc, /Team size: <\/w:t>[\s\S]{0,500}To be completed<\/w:t>/);
  assert.match(doc, /Issue {2}text/);
  assert.match(doc, /Cap {2}tion/);
  assert.match(doc, /name="visual"/);
});

test('one-pager drops the same characters and omits an empty warning', () => {
  const bytes = D.buildOnePager({
    title: 'Proof ' + BAD,
    subtitle: BAD,
    warning: BAD,
    label: BAD,
    blocks: [{heading: 'H' + BAD + '1', paragraphs: [{text: 'Fact ' + BAD + ' & co', kind: 'fact', notes: [1]}]}],
    notes: [{n: 1, text: 'Source ' + BAD + ' line'}],
  });
  const parts = entries(bytes);
  const doc = text(parts['word/document.xml']);
  assert.equal(doc.includes('\uFFFE') || doc.includes('\uFFFF'), false);
  assertXml(parts['word/document.xml']);
  assertXml(parts['docProps/core.xml']);
  assert.match(doc, />Proof</);
  assert.doesNotMatch(doc, /9A0000/);
  assert.match(doc, />H1</);
  assert.match(doc, /Fact {2}&amp; co/);
  assert.match(doc, /Source {2}line/);
  assert.match(doc, /Everything else restates them\.<\/w:t>/);
});
