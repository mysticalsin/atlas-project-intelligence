import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import * as profile from '../src/profile.js';
import * as living from '../src/living.js';
import {
  transition, SmartNeedLinkAdapter, PastedJobDescriptionAdapter, composeCv, buildFiche, toCompetencyFile,
  MiChatAdapter, atlasExport, omitCompensation, phraseLine,
} from '../src/living-core.js';

const CAPTURE = JSON.parse(readFileSync(new URL('./smart-need-192497-candidate-requirement.json', import.meta.url), 'utf8'));
const LINK = 'https://need.arp.mantu.com/needs/192497';
const MISSIONS = CAPTURE.candidateRequirement.missionDescription;
const MERGED = CAPTURE.candidateRequirement.profileRequirement[1];

const RAW = `<h2>Project Information</h2>
<p>Client Johnson Controls</p>
<p>Salary 99123-salary-sentinel</p>
<p>Compensation market value 88421-market-sentinel</p>
<h2>Candidate Requirement</h2>
Profiles
ENG - Electronics - Embedded Software Engineer
Skill (Must)
Windows
C++
C#
Skill (Nice to have)
-
Language (Must)
English - Fluent
Language (Nice to have)
-
Level of Experience (in years)
Middle - From 4 to 6 years
Mission Description
• ${MISSIONS[0]}
• ${MISSIONS[1]}
• ${MISSIONS[2]}
• ${MISSIONS[3]}
• ${MISSIONS[4]}
• ${MISSIONS[5]}
• ${MISSIONS[6]} · ${MISSIONS[0]}
• ${MISSIONS[1]}
• ${MISSIONS[2]}
• ${MISSIONS[3]}
• ${MISSIONS[4]}
• ${MISSIONS[5]}
• ${MISSIONS[6]}
Profile Requirement
• ${CAPTURE.candidateRequirement.profileRequirement[0]}
• ${MERGED}
• ${CAPTURE.candidateRequirement.profileRequirement[2]}
• ${CAPTURE.candidateRequirement.profileRequirement[3]}
• ${CAPTURE.candidateRequirement.profileRequirement[4]}
• ${CAPTURE.candidateRequirement.profileRequirement[5]}
• ${CAPTURE.candidateRequirement.profileRequirement[6]}
• ${CAPTURE.candidateRequirement.profileRequirement[7]}
Additional Information of the Candidate
-
Additional Information of the Need
-
<h2>Contract Type</h2>
<p>Daily rate 700</p>`;

function texts(list) { return list.map(item => item.text); }

test('state changes are a pure function', () => {
  assert.deepEqual(transition('draft', 'submit'), { ok: true, from: 'draft', to: 'in_review', event: 'submit' });
  assert.deepEqual(transition('in_review', 'approve'), { ok: true, from: 'in_review', to: 'approved', event: 'approve' });
  assert.deepEqual(transition('approved', 'export'), { ok: true, from: 'approved', to: 'exported', event: 'export' });
  assert.equal(transition('in_review', 'export').ok, false);
  assert.equal(transition('withdrawn', 'approve').ok, false);
  assert.equal(transition('exported', 'export').ok, false);
});

test('SMART fixture: Candidate Requirement only, quirks handled, conflicts flagged', () => {
  const adapter = new SmartNeedLinkAdapter({ fixtures: new Map([['192497', CAPTURE]]) });
  const got = adapter.resolve(LINK);
  assert.equal(got.ok, true);
  assert.equal(got.need.needId, '192497');
  assert.equal(got.need.title, 'Software Developer');
  assert.deepEqual(texts(got.need.profiles), CAPTURE.candidateRequirement.profiles);
  assert.deepEqual(texts(got.need.skills.must), ['Windows', 'C++', 'C#']);
  assert.deepEqual(got.need.skills.niceToHave, []);
  assert.deepEqual(got.need.languages.must.map(item => [item.language, item.level]), [['English', 'Fluent']]);
  assert.deepEqual(got.need.languages.niceToHave, []);
  assert.equal(got.need.experience.label, 'Middle - From 4 to 6 years');
  assert.equal(got.need.experience.minYears, 4);
  assert.equal(got.need.experience.maxYears, 6);
  assert.deepEqual(texts(got.need.missionDescription), MISSIONS);
  assert.equal(texts(got.need.profileRequirement)[1], MERGED);
  assert.equal(got.need.additionalInformationCandidate, null);
  assert.equal(got.need.additionalInformationNeed, null);
  assert.deepEqual(got.need.keywords.filter(k => k.authority === 'must' && k.kind === 'skill').map(k => k.text), ['Windows', 'C++', 'C#']);
  assert.equal(got.need.keywords.find(k => k.authority === 'level').text, 'Middle - From 4 to 6 years');
  assert.ok(got.need.flags.some(f => f.code === 'experience_conflict' && f.authoritative === '4-6 years' && f.other === '2+ years'));
  assert.ok(got.need.flags.some(f => f.code === 'skill_conflict' && f.skill === 'C++' && f.authoritative === 'C++ must'));
  const merged = got.need.flags.find(f => f.code === 'merged_bullet');
  assert.equal(merged.text, MERGED);
  assert.equal(merged.parts[1].startsWith('Relevant experience'), true);
  assert.equal(got.need.profileRequirement.filter(item => item.text === MERGED).length, 1);
  assert.equal(got.need.keywords.some(k => k.text.includes('2+')), false);
  assert.equal(got.need.skills.must.some(k => k.text === 'C++'), true);
});

test('raw Candidate Requirement page: middle dot, dash, merged bullet, nothing outside the section', () => {
  const adapter = new SmartNeedLinkAdapter({ fixtures: new Map([['192497', RAW]]) });
  const got = adapter.resolve(LINK).need;
  assert.deepEqual(texts(got.skills.must), ['Windows', 'C++', 'C#']);
  assert.deepEqual(got.skills.niceToHave, []);
  assert.deepEqual(got.languages.niceToHave, []);
  assert.equal(got.languages.must[0].level, 'Fluent');
  assert.deepEqual(texts(got.missionDescription), MISSIONS);
  assert.equal(texts(got.profileRequirement).length, 8);
  assert.equal(texts(got.profileRequirement)[1], MERGED);
  assert.equal(got.additionalInformationCandidate, null);
  assert.equal(got.flags.filter(f => f.code === 'merged_bullet').length, 1);
  const blob = JSON.stringify(got);
  assert.equal(blob.includes('99123-salary-sentinel'), false);
  assert.equal(blob.includes('88421-market-sentinel'), false);
  assert.equal(blob.includes('Johnson Controls'), false);
  assert.equal(blob.includes('Daily rate'), false);
  assert.equal(blob.includes('"-"]') || blob.includes('"-"'), false);
});

test('a SMART link with no fixture is unreadable and does not call the network', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(String(args[0])); return Promise.reject(new Error('network')); };
  try {
    const bare = new SmartNeedLinkAdapter();
    assert.deepEqual(bare.resolve(LINK), { ok: false, error: 'unreadable', pasteFallback: true, needId: '192497' });
    assert.equal(bare.resolve('https://example.com/needs/192497').error, 'malformed_link');
    assert.equal(bare.resolve('http://need.arp.mantu.com/needs/192497').error, 'malformed_link');
    assert.equal(bare.resolve('https://user:pass@need.arp.mantu.com/needs/192497').error, 'malformed_link');
    const missing = new SmartNeedLinkAdapter({ fixtures: new Map([['192497', '<h2>Project Information</h2><p>Only the commercial card</p>']]) });
    assert.equal(missing.resolve(LINK).error, 'missing_candidate_requirement');
    const partial = new SmartNeedLinkAdapter({ fixtures: new Map([['192497', '<h2>Candidate Requirement</h2>']]) });
    assert.equal(partial.resolve(LINK).partial, true);
    assert.equal(partial.resolve(LINK).need.keywords.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(new MiChatAdapter().read().code, 'API_UNCONFIRMED');
    assert.equal(new MiChatAdapter().write().network, false);
  } finally { globalThis.fetch = orig; }
});

test('phraseLine turns a published sentence into a CV bullet and falls back when it cannot', () => {
  assert.equal(phraseLine('I designed the Windows service that routes alarms for the plant.'), 'Designed the Windows service that routes alarms for the plant.');
  assert.equal(phraseLine('I have 8 years of Windows work on that same service.'), '8 years of Windows work on that same service.');
  assert.equal(phraseLine("I've built the Windows service for the plant."), 'Built the Windows service for the plant.');
  assert.equal(phraseLine('The service was written in C# and covered the alarm queue.'), 'The service was written in C# and covered the alarm queue.');
  assert.equal(phraseLine('I'), 'I');
  assert.equal(phraseLine(''), '');
});

test('a competency file matches the MiChat fields and cites only the fixture sentences', () => {
  const fixture = JSON.parse(readFileSync(new URL('./cf-cv-fixture.json', import.meta.url), 'utf8'));
  const need = new PastedJobDescriptionAdapter().resolve('Must have\nWindows\n\nLanguages\nFrench - Fluent').need;
  const cv = composeCv({ ...fixture, need });
  const cf = toCompetencyFile(cv);
  assert.deepEqual(Object.keys(cf), ['firstName', 'lastName', 'yearsOfExperience', 'jobTitle', 'summary', 'technicalSkills', 'softSkills', 'functionalSkills', 'languages', 'education', 'trainings', 'projects']);
  assert.equal(cf.yearsOfExperience, null);
  assert.equal(cf.summary, null);
  assert.deepEqual(cf.firstName, { text: 'Ada', evidenceId: 'story:consultant' });
  assert.deepEqual(cf.lastName, { text: 'Example', evidenceId: 'story:consultant' });
  assert.deepEqual(cf.jobTitle, { text: 'Software engineer', evidenceId: 'story:role' });
  assert.equal(cf.technicalSkills[0].category, null);
  assert.deepEqual(cf.technicalSkills[0].lines.map(item => item.text), ['Windows', 'C#']);
  assert.equal(JSON.stringify(cf.technicalSkills).includes('C++'), false);
  assert.deepEqual(cf.softSkills, [{ text: 'Coaching the night-shift operators was part of the same alarm queue.', evidenceId: 'story:A5.1' }]);
  assert.deepEqual(cf.functionalSkills, []);
  assert.deepEqual(cf.languages, [{ language: 'English', spoken: 'Fluent', written: 'Professional', evidenceId: 'story:A6.1' }]);
  assert.equal(JSON.stringify(cf.languages).includes('French'), false);
  assert.equal(cf.education[0].text, 'Holds a university degree in software engineering.');
  assert.equal(cf.education[0].evidenceId, 'story:A7.1');
  assert.equal(cf.trainings[0].text, 'Holds a certified Azure qualification from the same programme.');
  assert.equal(cf.trainings[0].evidenceId, 'story:A8.1');
  const project = cf.projects[0];
  assert.deepEqual(project.company, { text: 'Northwind Synthetic', evidenceId: 'story:client' });
  assert.deepEqual(project.role, { text: 'Software engineer', evidenceId: 'story:role' });
  assert.deepEqual(project.period, { text: '2024-03 – 2024-11', evidenceId: 'story:period' });
  assert.equal(project.context[0].text, 'Northwind Synthetic needed a quieter alarm queue for the night shift.');
  assert.equal(project.responsibilities[0].text, 'Designed the Windows service that routes alarms for the plant.');
  assert.equal(project.technologicalEnvironment.map(item => item.text).join(','), 'Windows,C#');
  assert.equal(project.achievements[0].text, '8 years of Windows work on that same service.');
  assert.equal(JSON.stringify(project).includes('university'), false);
  assert.equal(JSON.stringify(project).includes('English'), false);
  assert.equal(cf.yearsOfExperience, null);
  const cited = value => {
    if (Array.isArray(value)) return value.forEach(cited);
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string') assert.ok(value.evidenceId);
    if (typeof value.language === 'string') assert.ok(value.evidenceId);
    for (const child of Object.values(value)) if (child && typeof child === 'object') cited(child);
  };
  cited(cf);
});

test('gaps and conflicts stay off the CV; unsupported keywords are not claims', () => {
  const need = new SmartNeedLinkAdapter({ fixtures: new Map([['192497', CAPTURE]]) }).resolve(LINK).need;
  const lines = [
    { text: 'I designed the Windows service that routes alarms for the plant.', evidenceId: 's:A2.1', storyId: 's', topic: 'contribution', at: '2024-11', technologies: ['Windows', 'C++'], role: 'Software engineer', roleEvidenceId: 's:role', company: 'Northwind Synthetic', companyEvidenceId: 's:client' },
    { text: 'The service was written in C# and covered the alarm queue.', evidenceId: 's:A3.1', storyId: 's', topic: 'approach', at: '2024-11', technologies: ['C#'] },
    { text: 'I have 8 years of Windows work on that same service.', evidenceId: 's:A4.1', storyId: 's', topic: 'outcome', at: '2024-11' },
    { text: 'Daily rate was discussed and left out of the reference.', evidenceId: 's:A5.1', storyId: 's', topic: 'evidence', at: '2024-11' },
  ];
  const cv = composeCv({ consultant: { name: 'Ada Example', nameEvidenceId: 's:consultant', role: 'Software engineer', roleEvidenceId: 's:role' }, lines, need, audience: 'internal' });
  assert.ok(cv.lines.every(line => lines.some(input => input.text === line.source && input.evidenceId === line.evidenceId)));
  assert.equal(cv.lines.find(line => line.evidenceId === 's:A2.1').text, 'Designed the Windows service that routes alarms for the plant.');
  assert.equal(cv.lines.find(line => line.evidenceId === 's:A4.1').text, '8 years of Windows work on that same service.');
  assert.equal(cv.lines.some(line => /^I\b/.test(line.text)), false);
  assert.equal(cv.lines.some(line => line.text.includes('Daily rate')), false);
  assert.deepEqual(cv.gaps.map(gap => gap.keyword).sort(), ['C++', 'English']);
  assert.equal(cv.gaps.every(gap => gap.authority === 'must'), true);
  assert.equal(cv.gaps.some(gap => gap.keyword === 'Middle - From 4 to 6 years'), false);
  const withNice = composeCv({ consultant: cv.consultant, lines, need: { ...need, keywords: [...need.keywords, { text: 'WPF', authority: 'nice', kind: 'skill' }] }, audience: 'internal' });
  assert.equal(withNice.gaps.some(gap => gap.keyword === 'WPF'), false);
  assert.equal(cv.gaps.some(gap => /2\+|an asset|WinUI|WPF/.test(gap.keyword)), false);
  assert.equal(cv.lines.some(line => /C\+\+|WinUI|2\+ years|an asset/.test(line.text)), false);
  assert.ok(cv.flags.some(flag => flag.code === 'skill_conflict'));
  assert.ok(cv.flags.some(flag => flag.code === 'experience_conflict'));
  const cf = toCompetencyFile(cv);
  assert.equal(cf.yearsOfExperience, null);
  assert.equal(cf.summary, null);
  assert.deepEqual(cf.languages, []);
  assert.deepEqual(cf.softSkills, []);
  assert.equal(JSON.stringify(cf.technicalSkills).includes('C++'), false);
  assert.equal(JSON.stringify(cf.technicalSkills).includes('Windows'), true);
  assert.equal(cf.projects[0].company.text, 'Northwind Synthetic');
  assert.ok(cf.projects[0].company.evidenceId);
  const external = toCompetencyFile(composeCv({ consultant: cv.consultant, lines, need, audience: 'external' }));
  assert.equal(external.projects[0].company, null);
  const file = new MiChatAdapter().exportDocument({ ...cv, status: 'approved', need: cv.need });
  assert.equal(file.network, false);
  assert.equal(file.michatAdapt, false);
  assert.equal(file.envelope.operation, 'adapt');
  assert.equal(file.envelope.status, 'Ready');
  assert.equal(JSON.stringify(file.envelope).includes('mantumichat'), false);
  const xml = Buffer.from(file.bytes).toString('utf8');
  assert.equal(xml.includes('Designed the Windows service'), true);
  assert.equal(xml.includes('I designed'), false);
  assert.equal(xml.includes('s:A2.1'), true);
  assert.equal(xml.includes('C++'), false);
  assert.equal(xml.includes('99123'), false);
  assert.equal(xml.includes('Middle - From 4 to 6 years'), false);
});

test('compensation fields cannot reach a fiche, a CV, or a competency file', () => {
  const poisoned = {
    salary: '99123-salary-sentinel',
    compensation: { marketValue: '88421-market-sentinel' },
    title: 'Alarm routing',
    storyId: 's',
    lines: [
      { text: 'Daily rate 500 was the commercial note.', evidenceId: 's:A1.1', topic: 'context' },
      { text: 'I designed the Windows service that routes alarms for the plant.', evidenceId: 's:A2.1', topic: 'contribution', storyId: 's' },
    ],
  };
  const fiche = buildFiche(poisoned);
  const cv = composeCv({ consultant: { name: 'Ada Example' }, lines: poisoned.lines, need: null, audience: 'internal' });
  const cf = toCompetencyFile(cv);
  const blob = JSON.stringify({ fiche, cv, cf, stripped: omitCompensation(poisoned) });
  assert.equal(blob.includes('99123-salary-sentinel'), false);
  assert.equal(blob.includes('88421-market-sentinel'), false);
  assert.equal(blob.includes('Daily rate'), false);
  assert.equal(fiche.sections.contribution[0].evidenceId, 's:A2.1');
  const walk = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /salary|compensation|marketValue|wage|bonus|payroll|tjm|dailyRate/i, path + key);
      walk(child, path + key + '.');
    }
  };
  walk({ fiche, cv, cf });
  const pdf = Buffer.from(atlasExport(cv, 'pdf').bytes).toString('utf8');
  assert.equal(pdf.startsWith('%PDF-1.4'), true);
  assert.equal(pdf.includes('Daily rate'), false);
});

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const GOOD = JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: [], summary: 'Strong.' });
const OWNER = { email: 'ada@example.test', role: 'user', tenant: T, tenantEnforced: true };
const N1 = { email: 'sam@example.test', role: 'user', tenant: T, tenantEnforced: true };
const PRE = { email: 'pre@example.test', role: 'presales', tenant: T, tenantEnforced: true };
const OTHER = { email: 'kim@example.test', role: 'user', tenant: U, tenantEnforced: true };
function ref() {
  return { title: 'Alarm routing alias', stage: 'Production', sector: 'Buildings', consultant: { name: 'Ada Example', role: 'Software engineer' },
    client: { name: 'Northwind Synthetic', location: 'Lyon', contact: 'Plant lead' },
    details: { projectId: 'PRJ-SYN', country: 'France', start: '2024-03', end: '2024-11', teamSize: 4, teamRoles: ['Software engineer'], technologies: ['Windows', 'C#', 'C++'], deliverables: ['Alarm service'], serviceLines: ['Software'], consultants: [], links: [] },
    answers: [
      'Northwind Synthetic needed a quieter alarm queue for the night shift across two sites.',
      'I designed the Windows service that routes alarms for the plant.',
      'The service was written in C# and covered the alarm queue.',
      'I have 8 years of Windows work on that same service and the queue got shorter.',
      'The operations log for the quarter is the source for that queue time.',
      'A building team with a manual alarm queue would recognise the same constraint.',
    ],
    validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false } };
}
function lib() {
  let t = 0;
  return new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 11, 0, 0, t++)).toISOString(), complete: async () => GOOD });
}
async function publish(l) {
  const row = await l.upsert(OWNER, { localId: 'p1', reference: ref() });
  await l.review(OWNER, row.id);
  l.bindTrust({ role: 'system', tenant: T, tenantEnforced: true }, { owner: OWNER.email, email: N1.email, source: 'directory', tenant: T, tenantEnforced: true });
  l.validate(N1, row.id, { decision: 'validate', lane: 'manager' });
  l.validate(PRE, row.id, { decision: 'validate', lane: 'presales' });
  return row.id;
}
async function consent(l, user = OWNER) {
  await profile.routes({ method: 'POST', parts: ['profile', 'consent'], user, lib: l, env: {}, body: { kind: 'profileReuse', version: 1, granted: true } });
}
const smart = () => new SmartNeedLinkAdapter({ fixtures: new Map([['192497', CAPTURE]]) });

test('generate uses published snippets, refuses a live link, and blocks self-approval and early export', async () => {
  const l = lib();
  const id = await publish(l);
  const ctx = body => ({ method: 'POST', parts: ['living', 'generate'], user: OWNER, lib: l, env: {}, body });
  const unread = await living.routes(ctx({ link: LINK }));
  assert.equal(unread.body.ok, false);
  assert.equal(unread.body.pasteFallback, true);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM living_artifacts')[0].n, 0);
  await assert.rejects(living.routes(ctx({ text: 'Must have\nWindows' })), /Consent required/);
  await consent(l);
  const made = await living.routes(ctx({ link: LINK, audience: 'external' }), { smart: smart() });
  assert.equal(made.body.artifact.status, 'in_review');
  assert.equal(made.body.artifact.canApprove, false);
  const joined = JSON.stringify(made.body.artifact.lines);
  assert.equal(joined.includes('Northwind Synthetic'), false);
  assert.equal(joined.includes('Designed the Windows service'), true);
  assert.equal(joined.includes('I designed'), false);
  assert.equal(made.body.artifact.lines.every(line => line.evidenceId.startsWith(id + ':')), true);
  assert.ok(made.body.artifact.gaps.some(gap => gap.keyword === 'C++'));
  assert.equal(made.body.artifact.lines.some(line => line.text.includes('C++')), false);
  const audits = l.rows('SELECT action, detail FROM audit WHERE action LIKE ? ', 'living %');
  assert.equal(JSON.stringify(audits).includes('I designed the Windows service'), false);
  assert.equal(l.rows("SELECT token_status FROM telemetry WHERE feature = 'living'")[0].token_status, 'missing');
  await assert.rejects(living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'approve'], user: OWNER, lib: l, body: {} }), /cannot approve/);
  assert.equal(l.rows('SELECT status FROM living_artifacts')[0].status, 'in_review');
  await assert.rejects(living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'export'], user: OWNER, lib: l, body: {} }), /not available/);
  const approved = await living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'approve'], user: PRE, lib: l, body: {} });
  assert.equal(approved.body.status, 'approved');
  l.withdraw(OWNER, id, { note: 'withdrawn for the test' });
  await assert.rejects(living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'export'], user: OWNER, lib: l, body: {} }), /no longer published/);
});

test('an approved CV exports once, another tenant cannot see it, and privacy delete removes it', async () => {
  const l = lib();
  await publish(l);
  await consent(l);
  const made = await living.routes({ method: 'POST', parts: ['living', 'generate'], user: OWNER, lib: l, body: { text: 'Must have\nWindows\nC++\n\nLanguages\nEnglish - Fluent' } });
  await assert.rejects(living.routes({ method: 'GET', parts: ['living', 'artifacts', made.body.artifact.id], user: OTHER, lib: l }), /Not found/);
  const queued = await living.routes({ method: 'GET', parts: ['living'], user: N1, lib: l });
  assert.equal(queued.body.queue[0].id, made.body.artifact.id);
  assert.equal(queued.body.queue[0].canApprove, true);
  const own = await living.routes({ method: 'GET', parts: ['living'], user: OWNER, lib: l });
  assert.equal(own.body.queue.length, 0);
  assert.equal(own.body.cv.canApprove, false);
  await living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'approve'], user: N1, lib: l, body: {} });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(String(args[0])); return Promise.reject(new Error('network')); };
  let file;
  try {
    file = await living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'export'], user: OWNER, lib: l, body: { format: 'docx', adapter: 'michat' } });
  } finally { globalThis.fetch = orig; }
  assert.equal(calls.length, 0);
  assert.equal(file.body.filename, 'cv.docx');
  assert.equal(l.rows('SELECT status FROM living_artifacts')[0].status, 'exported');
  const again = await living.routes({ method: 'POST', parts: ['living', 'artifacts', made.body.artifact.id, 'export'], user: OWNER, lib: l, body: {} });
  assert.equal(again.body.status, 'exported');
  const fiche = await living.routes({ method: 'POST', parts: ['living', 'review'], user: OWNER, lib: l, body: { storyId: made.body.artifact.lines[0].storyId, salary: '99123-salary-sentinel' } });
  assert.equal(JSON.stringify(fiche.body).includes('99123-salary-sentinel'), false);
  assert.equal(fiche.body.artifact.fiche.sections.contribution[0].text.includes('Windows service'), true);
  assert.equal(living.deleteOwned(l, OTHER), 0);
  assert.equal(living.deleteOwned(l, OWNER) > 0, true);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM living_artifacts')[0].n, 0);
});
