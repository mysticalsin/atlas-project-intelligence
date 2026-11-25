'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/office.js');
const P = require('../src/pptx.js');

// Synthetic slide only. PowerPoint writes xml:space="preserve" on a run that starts or ends with a space.
function deck(slides) {
  return P.zip(slides.map((xml, i) => ['ppt/slides/slide' + (i + 1) + '.xml', xml]));
}

function slide(body) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld><p:spTree><p:sp><p:txBody>' + body + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
}

test('a text run with attributes keeps its words', async () => {
  const text = await O.pptxText(deck([slide(
    '<a:p><a:r><a:t>Queue</a:t></a:r><a:r><a:t xml:space="preserve"> intake</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t xml:space="preserve">Kept phrase</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>Plain &amp; clear</a:t></a:r></a:p>'
  )]));
  assert.equal(text, 'Slide 1\nQueue intake\nKept phrase\nPlain & clear');
});
