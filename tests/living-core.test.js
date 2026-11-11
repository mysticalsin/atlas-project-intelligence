const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

test('fiche, CV, and competency file drop compensation and keep the SMART conflicts as flags', async () => {
  const core = await import(pathToFileURL(require('path').join(__dirname, '../deploy/cloudflare-edge/src/living-core.js')).href);
  const capture = JSON.parse(readFileSync(require('path').join(__dirname, '../deploy/cloudflare-edge/test/smart-need-192497-candidate-requirement.json'), 'utf8'));
  const need = new core.SmartNeedLinkAdapter({ fixtures: new Map([['192497', capture]]) }).resolve('https://need.arp.mantu.com/needs/192497').need;
  assert.ok(need.flags.some(flag => flag.code === 'experience_conflict' && flag.other === '2+ years'));
  assert.ok(need.flags.some(flag => flag.code === 'skill_conflict' && flag.skill === 'C++'));
  const poisoned = { salary: '99123-salary-sentinel', compensation: { marketValue: '88421-market-sentinel' }, title: 'Alarm routing', storyId: 's',
    lines: [{ text: 'Daily rate 500 was the commercial note.', evidenceId: 's:A1.1', topic: 'context' }, { text: 'I designed the Windows service that routes alarms for the plant.', evidenceId: 's:A2.1', topic: 'contribution', storyId: 's' }] };
  const fiche = core.buildFiche(poisoned);
  const cv = core.composeCv({ consultant: { name: 'Ada Example' }, lines: poisoned.lines, need, audience: 'internal' });
  const cf = core.toCompetencyFile(cv);
  const blob = JSON.stringify({ fiche, cv, cf });
  assert.equal(blob.includes('99123-salary-sentinel'), false);
  assert.equal(blob.includes('88421-market-sentinel'), false);
  assert.equal(blob.includes('Daily rate'), false);
  assert.equal(cf.yearsOfExperience, null);
  assert.equal(cf.summary, null);
  assert.equal(cv.lines.some(line => line.text.includes('C++')), false);
  assert.ok(cv.gaps.some(gap => gap.keyword === 'C++'));
});
