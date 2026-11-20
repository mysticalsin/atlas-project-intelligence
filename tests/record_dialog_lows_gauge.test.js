'use strict';
// Separate from tests/charts.test.js so a stack that appends there can merge this file cleanly.
// Run: node --test tests/record_dialog_lows_gauge.test.js
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const C = require('../src/charts.js');
const num = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function trackRow() {
  const src = fs.readFileSync(path.join(__dirname, '../src/charts.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('tr=(l,v)=>'));
  assert.ok(line, 'qualityGauge defines tr');
  const expr = line.slice(line.indexOf('tr=(l,v)=>')).trim();
  return new Function('num', 'clamp', expr + '\nreturn tr;')(num, clamp);
}

test('an empty or whitespace track label renders no row', () => {
  const tr = trackRow();
  for (const label of ['', ' ', '   ', '\t', '\n', ' \t\n ', null, undefined]) {
    const html = tr(label, 40);
    assert.equal(html, '', 'label ' + JSON.stringify(label));
    assert.ok(!String(html).includes('<li'), 'no row ' + JSON.stringify(label));
  }
  const shown = tr('Completeness', 40);
  assert.ok(shown.startsWith('<li><span>Completeness</span>'), 'a real label still renders');
});

test('the rules engine omits the 0.8 note for missing and NaN completeness and keeps it for zero', () => {
  const note = 'No rating engine answered (score = 0.8 × completeness)';
  const gauge = completeness => {
    const q = {score: 80, status: 'ready', engine: 'rules'};
    if (completeness !== 'missing') q.completeness = completeness;
    return C.qualityGauge(q, {jev: true});
  };
  for (const completeness of ['missing', NaN]) {
    const h = gauge(completeness);
    assert.ok(h.includes('<span>Completeness</span><div class="ag-meter is-tbd"></div>'), 'placeholder ' + completeness);
    assert.ok(!h.includes(note), 'formula absent ' + completeness);
    assert.ok(!h.includes('score = 0.8'), 'no 0.8 note ' + completeness);
  }
  const zero = gauge(0);
  assert.ok(zero.includes('<span>Completeness</span><b>0</b>'), 'zero stays on the track');
  assert.ok(zero.includes(note), 'zero is a finite completeness, so the guard shows the note');
});
