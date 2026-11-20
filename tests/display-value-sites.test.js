// The seven raw concatenations must render through displayValue.
// node --test tests/display-value-sites.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const {html} = require('../src/safe-html.js');
const {displayValue, PLACEHOLDER} = require('../src/display-value.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const ask = fs.readFileSync(path.join(__dirname, '..', 'src', 'ask-ui.js'), 'utf8');
const bids = fs.readFileSync(path.join(__dirname, '..', 'src', 'bids-ui.js'), 'utf8');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function from(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'missing ' + start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j >= 0, 'missing ' + end + ' after ' + start);
  return src.slice(i, j + end.length);
}

function run(expr, names, values) {
  const fn = new Function(...names, 'return (' + expr + ');');
  return fn(...values);
}

function text(value) {
  const s = String(value);
  assert.equal(s.includes('[object'), false, s);
  return s;
}

test('app.js recordDoc issue field and detail use displayValue', () => {
  const expr = from(app, 'p.quality.issues.map(', ".join('')");
  const out = text(run(expr, ['esc', 'displayValue', 'p'], [esc, displayValue, {
    quality: {issues: [
      {field: {label: 'Outcome'}, detail: {hours: 4}},
      {field: 'scope', detail: 'One queue'},
      {field: 'team', detail: 4},
    ]},
  }]));
  assert.equal(out, '<li>Outcome: ' + PLACEHOLDER + '</li><li>scope: One queue</li><li>team: 4</li>');
});

test('app.js recordDoc practice area, consultants, and links use displayValue', () => {
  const practice = from(app, "row('Practice area (JEV)',", ")}").slice("row('Practice area (JEV)',".length, -2);
  const people = from(app, "row('Consultants',", ")}").slice("row('Consultants',".length, -2);
  const links = from(app, "row('Links',", ")}").slice("row('Links',".length, -2);
  const p = {
    consultant: {label: 'Ada'},
    role: {label: 'Delivery lead'},
    jev: {primary: {label: {hours: 2}}, also: [{label: 'Care'}, {label: {hours: 1}}]},
  };
  const d = {
    consultants: [{name: 'Sam', role: {hours: 12}}, {name: 'Noor', role: 'Analyst'}, {name: 'Kai', role: 2}, {name: 'Ren', role: null}],
    links: [{label: {label: 'Ticket'}, url: 'https://example.test/1'}, {label: '', url: {hours: 1}}, {label: 'Note', url: 'https://example.test/3'}],
  };
  assert.equal(text(run(practice, ['displayValue', 'p'], [displayValue, p])), PLACEHOLDER + ', Care, ' + PLACEHOLDER);
  assert.equal(text(run(people, ['displayValue', 'p', 'd'], [displayValue, p, d])),
    'Ada (Delivery lead); Sam (' + PLACEHOLDER + '); Noor (Analyst); Kai (2); Ren');
  assert.equal(text(run(links, ['displayValue', 'd'], [displayValue, d])),
    'Ticket: https://example.test/1; ' + PLACEHOLDER + '; Note: https://example.test/3');
});

test('app.js libraryDoc name and role use displayValue', () => {
  const expr = from(app, 'consultant:', ',answers').slice(0, -',answers'.length);
  const out = run('({' + expr + '})', ['displayValue', 'd'], [displayValue, {
    consultant: {name: {label: 'Ada'}, role: {hours: 9}},
  }]);
  assert.equal(out.consultant, 'Ada');
  assert.equal(out.role, PLACEHOLDER);
  const plain = run('({' + expr + '})', ['displayValue', 'd'], [displayValue, {
    consultant: {name: 'Noor', role: 'Analyst'},
  }]);
  assert.equal(plain.consultant, 'Noor');
  assert.equal(plain.role, 'Analyst');
});

test('app.js quality summary uses displayValue', () => {
  const expr = from(app, '(q.summary)?', ":('')");
  const labeled = text(run(expr, ['html', 'displayValue', 'q'], [html, displayValue, {summary: {label: 'Queue delay was the point'}}]));
  assert.equal(labeled, '<p>Queue delay was the point</p>');
  const shapeless = text(run(expr, ['html', 'displayValue', 'q'], [html, displayValue, {summary: {note: 'x'}}]));
  assert.equal(shapeless, '<p>' + PLACEHOLDER + '</p>');
  const sentence = text(run(expr, ['html', 'displayValue', 'q'], [html, displayValue, {summary: 'Kept as text'}]));
  assert.equal(sentence, '<p>Kept as text</p>');
});

test('app.js audit detail uses displayValue', () => {
  const expr = from(app, 'x.detail?', 'auditMark(x)');
  const body = expr.slice(0, expr.lastIndexOf('}'));
  assert.equal(text(run(body, ['displayValue', 'x'], [displayValue, {detail: {label: 'Checked the metric'}}])), ' · Checked the metric');
  assert.equal(text(run(body, ['displayValue', 'x'], [displayValue, {detail: {hours: 1}}])), ' · ' + PLACEHOLDER);
  assert.equal(text(run(body, ['displayValue', 'x'], [displayValue, {detail: 'Noted'}])), ' · Noted');
  assert.equal(text(run(body, ['displayValue', 'x'], [displayValue, {detail: ''}])), '');
});

test('ask-ui.js people lines use displayValue', () => {
  const card = from(ask, '(Array.isArray(x.people)?x.people:[]).map(', ".join(' · ')");
  const dot = from(ask, "p.role?' · '", ":''");
  const people = [{name: 'Ada', role: {label: 'Delivery lead'}}, {name: 'Sam', role: {hours: 2}}, {name: 'Ren', role: null}];
  assert.equal(text(run(card, ['displayValue', 'x'], [displayValue, {people}])),
    'Ada (Delivery lead) · Sam (' + PLACEHOLDER + ') · Ren');
  assert.equal(text(run(dot, ['displayValue', 'p'], [displayValue, {role: {label: 'Delivery lead'}}])), ' · Delivery lead');
  assert.equal(text(run(dot, ['displayValue', 'p'], [displayValue, {role: {hours: 2}}])), ' · ' + PLACEHOLDER);
  assert.equal(text(run(dot, ['displayValue', 'p'], [displayValue, {role: 'Analyst'}])), ' · Analyst');
  assert.equal(text(run(dot, ['displayValue', 'p'], [displayValue, {role: null}])), '');
});

test('bids-ui.js suggested person role uses displayValue', () => {
  const expr = from(bids, "s.role?' · '", ":''");
  assert.equal(text(run(expr, ['displayValue', 's'], [displayValue, {role: {label: 'Delivery lead'}}])), ' · Delivery lead');
  assert.equal(text(run(expr, ['displayValue', 's'], [displayValue, {role: ['Lead']}])), ' · ' + PLACEHOLDER);
  assert.equal(text(run(expr, ['displayValue', 's'], [displayValue, {role: 2}])), ' · 2');
  assert.equal(text(run(expr, ['displayValue', 's'], [displayValue, {role: ''}])), '');
});
