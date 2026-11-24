// Living CV core. Pure: no network, no database, no logging.
// A SMART need is read only from a fixture or from HTML the caller already has.
// Candidate Requirement is the only section that becomes a Need. Must tags and Level
// are the ATS keywords. Conflicts are flags. Gaps are never written as CV lines.

export const STATES = Object.freeze(['draft', 'in_review', 'approved', 'exported', 'withdrawn']);

const NEXT = Object.freeze({
  draft: { submit: 'in_review', withdraw: 'withdrawn' },
  in_review: { approve: 'approved', reject: 'draft', withdraw: 'withdrawn' },
  approved: { export: 'exported', withdraw: 'withdrawn', revise: 'draft' },
  exported: { withdraw: 'withdrawn', revise: 'draft' },
  withdrawn: {},
});

// Returns the next state. It does not write and it does not log.
export function transition(from, event) {
  const to = NEXT[from]?.[event];
  if (!to) return { ok: false, from, event };
  return { ok: true, from, to, event };
}

const BANNED_KEY = /salary|compensation|remuneration|market.?value|wage|bonus|payroll|\btjm\b|daily.?rate/i;
const BANNED_TEXT = /\b(salary|salaries|compensation|remuneration|market[\s_-]?value|wage|wages|bonus|payroll|tjm|daily rate)\b/i;

export function omitCompensation(value) {
  if (typeof value === 'string') return banned(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(omitCompensation).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (BANNED_KEY.test(k)) continue;
      const next = omitCompensation(v);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return value;
}

function banned(text) { return BANNED_TEXT.test(String(text || '')); }

function dedupe(items) {
  const out = [], seen = new Set();
  for (const item of items) {
    const text = String(item || '').trim();
    const key = text.toLowerCase();
    if (!text || text === '-' || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function htmlToText(page) {
  return String(page || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'");
}

function asText(page) {
  const raw = String(page || '');
  return /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw;
}

// The section between the Candidate Requirement heading and the next outer card.
export function extractCandidateRequirement(page) {
  const lines = asText(page).split(/\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^candidate requirement$/i.test(lines[i].trim())) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^(project information|contract type|needs)$/i.test(lines[i].trim())) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

const INNER = [
  ['profiles', /^profiles$/i],
  ['skillMust', /^skill\s*\(\s*must\s*\)$/i],
  ['skillNice', /^skill\s*\(\s*nice to have\s*\)$/i],
  ['langMust', /^language\s*\(\s*must\s*\)$/i],
  ['langNice', /^language\s*\(\s*nice to have\s*\)$/i],
  ['experience', /^level of experience\b/i],
  ['mission', /^mission description$/i],
  ['profile', /^profile requirement$/i],
  ['addCandidate', /^additional information of the candidate$/i],
  ['addNeed', /^additional information of the need$/i],
  ['certs', /^certifications?$/i],
];

function headingKey(line) {
  const t = String(line || '').trim();
  for (const [key, re] of INNER) if (re.test(t)) return key;
  return null;
}

function blocks(section) {
  const found = {};
  let key = null, buf = [];
  const flush = () => { if (key) found[key] = (found[key] ? found[key] + '\n' : '') + buf.join('\n'); };
  for (const line of String(section || '').split(/\n/)) {
    const next = headingKey(line);
    if (next) { flush(); key = next; buf = []; continue; }
    if (key) buf.push(line);
  }
  flush();
  return found;
}

function plainLines(block) {
  return String(block || '').split(/\n/).map(line => line.replace(/^[•·\-–]\s*/, '').trim()).filter(line => line && line !== '-');
}

function skillTokens(block) {
  const out = [];
  for (const line of plainLines(block)) {
    if (banned(line)) continue;
    const pieces = line.split(/\s{2,}|,/).flatMap(part => {
      const s = part.trim();
      if (!s) return [];
      if (!/[.]/.test(s) && s.split(/\s+/).every(word => word.length <= 24)) return s.split(/\s+/);
      return [s];
    });
    out.push(...pieces.filter(s => s && s !== '-' && !banned(s)));
  }
  return dedupe(out);
}

// A duplicated mission list is joined, once, by a middle dot. Split that join, then keep the first copy of each bullet.
function missionItems(block) {
  const out = [];
  for (const line of plainLines(block)) {
    if (banned(line)) continue;
    for (const part of line.split(/\s+[·•]\s+/)) {
      const text = part.trim();
      if (text && text !== '-' && !banned(text)) out.push(text);
    }
  }
  return dedupe(out);
}

function profileItems(block) {
  return dedupe(plainLines(block).filter(line => !banned(line)));
}

function languageItems(block) {
  const out = [], seen = new Set();
  for (const raw of plainLines(block)) {
    if (banned(raw)) continue;
    const m = /^(.*?)\s+-\s+(.*)$/.exec(raw);
    const item = m ? { language: m[1].trim(), level: m[2].trim() } : { language: raw, level: '' };
    const key = item.language.toLowerCase();
    if (!item.language || item.language === '-' || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function experienceOf(block) {
  const line = plainLines(block).find(item => !banned(item)) || '';
  if (!line || line === '-') return null;
  const m = /^(.*?)\s+-\s+From\s+(\d+)\s+to\s+(\d+)\s+years$/i.exec(line);
  if (m) return { label: line, level: m[1].trim(), minYears: Number(m[2]), maxYears: Number(m[3]) };
  const years = /(\d+)\s*(?:to|-)\s*(\d+)\s*years/i.exec(line);
  return { label: line, level: line.split(/\s+-\s+/)[0].trim(), minYears: years ? Number(years[1]) : null, maxYears: years ? Number(years[2]) : null };
}

function additionalOf(block) {
  const text = plainLines(block).filter(line => !banned(line)).join('\n').trim();
  return text && text !== '-' ? text : null;
}

function locateAll(section, texts) {
  let from = 0;
  return texts.map(text => {
    const start = section.indexOf(text, from);
    if (start < 0) return { text, start: 0, end: text.length };
    from = start + text.length;
    return { text, start, end: start + text.length };
  });
}

function locateLanguages(section, items) {
  let from = 0;
  return items.map(item => {
    const needle = item.level ? `${item.language} - ${item.level}` : item.language;
    const start = section.indexOf(needle, from);
    const at = start < 0 ? section.indexOf(item.language, from) : start;
    if (at < 0) return { ...item, start: 0, end: item.language.length };
    from = at + Math.max(needle.length, 1);
    return { ...item, start: at, end: at + (start < 0 ? item.language.length : needle.length) };
  });
}

export function authoritativeKeywords(need) {
  const out = [];
  for (const skill of need.skills?.must || []) out.push({ text: skill.text, authority: 'must', kind: 'skill', start: skill.start, end: skill.end });
  for (const skill of need.skills?.niceToHave || []) out.push({ text: skill.text, authority: 'nice', kind: 'skill', start: skill.start, end: skill.end });
  for (const lang of need.languages?.must || []) out.push({ text: lang.language, authority: 'must', kind: 'language', start: lang.start, end: lang.end });
  for (const lang of need.languages?.niceToHave || []) out.push({ text: lang.language, authority: 'nice', kind: 'language', start: lang.start, end: lang.end });
  if (need.experience?.label) out.push({ text: need.experience.label, authority: 'level', kind: 'experience', start: need.experience.start || 0, end: need.experience.end || need.experience.label.length });
  for (const cert of need.certifications || []) out.push({ text: cert.text, authority: cert.authority || 'must', kind: 'certification', start: cert.start, end: cert.end });
  return out.filter(k => k.text && k.text !== '-' && !banned(k.text));
}

const LEAD_IN = new Set(['of', 'with', 'like', 'and', 'or', 'the', 'in', 'for', 'to', 'a', 'an', 'on', 'by', 'ex', 'via', 'using', 'from']);

// Two bullets rendered as one line. The parts are recorded on the flag. The stored item stays as captured,
// so the join is not silently turned into two requirements.
function splitMerged(text) {
  const re = /([A-Za-z]+)\s+([A-Z][a-z]{2,})/g;
  let match;
  while ((match = re.exec(text))) {
    if (match[1][0] !== match[1][0].toLowerCase() || LEAD_IN.has(match[1].toLowerCase())) continue;
    const at = match.index + match[1].length + 1;
    return [text.slice(0, at).trim(), text.slice(at).trim()];
  }
  return null;
}

// Flags describe a disagreement inside the section. They do not change the authoritative keyword.
export function conflictFlags(need) {
  const flags = [];
  const profile = (need.profileRequirement || []).map(item => item.text || '');
  const exp = need.experience;
  if (exp && exp.minYears != null) {
    for (const text of profile) {
      const m = /(\d+)\s*\+\s*years/i.exec(text);
      if (m && Number(m[1]) < exp.minYears) {
        flags.push({
          code: 'experience_conflict', topic: 'experience',
          authoritative: `${exp.minYears}-${exp.maxYears} years`, other: `${m[1]}+ years`,
          detail: `Need asks ${exp.minYears}–${exp.maxYears} yrs; requirement says ${m[1]}+. Confirm with requester.`,
        });
        break;
      }
    }
  }
  for (const skill of need.skills?.must || []) {
    const name = skill.text;
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(?:is\\s+)?an\\s+asset', 'i');
    if (profile.some(text => re.test(text))) flags.push({
      code: 'skill_conflict', topic: 'skill', skill: name,
      authoritative: `${name} must`, other: `${name} an asset`,
      detail: `Need lists ${name} as a must; the requirement calls it an asset. Confirm with requester.`,
    });
  }
  for (const item of need.profileRequirement || []) {
    const parts = splitMerged(item.text || '');
    if (parts) flags.push({ code: 'merged_bullet', topic: 'profile_requirement', text: item.text, parts, detail: 'One requirement joins two sentences. Confirm with requester before splitting them.' });
  }
  return flags;
}

function finish(need) {
  need.keywords = authoritativeKeywords(need);
  need.flags = conflictFlags(need);
  const filled = need.profiles.length || need.skills.must.length || need.skills.niceToHave.length || need.languages.must.length
    || need.missionDescription.length || need.profileRequirement.length || need.experience;
  need.partial = !filled;
  return need;
}

function blankNeed(meta) {
  return {
    source: meta.source, sourceRef: meta.sourceRef || '', needId: meta.needId || '', title: meta.title || '',
    profiles: [], skills: { must: [], niceToHave: [] }, languages: { must: [], niceToHave: [] },
    experience: null, missionDescription: [], profileRequirement: [], certifications: [],
    additionalInformationCandidate: null, additionalInformationNeed: null,
  };
}

export function parseSectionText(section, meta = {}) {
  const body = String(section || '');
  const part = blocks(body);
  const need = blankNeed(meta);
  need.profiles = locateAll(body, skillTokens(part.profiles));
  need.skills = { must: locateAll(body, skillTokens(part.skillMust)), niceToHave: locateAll(body, skillTokens(part.skillNice)) };
  need.languages = { must: locateLanguages(body, languageItems(part.langMust)), niceToHave: locateLanguages(body, languageItems(part.langNice)) };
  need.experience = experienceOf(part.experience);
  if (need.experience) {
    const at = body.indexOf(need.experience.label);
    need.experience.start = at < 0 ? 0 : at;
    need.experience.end = at < 0 ? need.experience.label.length : at + need.experience.label.length;
  }
  need.missionDescription = locateAll(body, missionItems(part.mission));
  need.profileRequirement = locateAll(body, profileItems(part.profile));
  need.certifications = locateAll(body, skillTokens(part.certs)).map(item => ({ ...item, authority: 'must' }));
  need.additionalInformationCandidate = additionalOf(part.addCandidate);
  need.additionalInformationNeed = additionalOf(part.addNeed);
  return finish(need);
}

export function parseCandidateRequirementPage(page, meta = {}) {
  const text = asText(page);
  const headed = /^candidate requirement$/im.test(text);
  if (!headed && !/^profiles$/im.test(text) && !/^skill\s*\(\s*must\s*\)$/im.test(text)) return null;
  const section = headed ? extractCandidateRequirement(page) : text;
  if (section == null) return null;
  return parseSectionText(section, { source: 'smart', ...meta });
}

function textsOf(list) {
  return (Array.isArray(list) ? list : []).map(item => String(item || '').trim()).filter(item => item && item !== '-' && !banned(item));
}

function langsOf(list) {
  return (Array.isArray(list) ? list : []).map(item => {
    if (!item || typeof item !== 'object') return null;
    const language = String(item.language || '').trim();
    const level = String(item.level || '').trim();
    if (!language || language === '-' || banned(language)) return null;
    return { language, level: level === '-' ? '' : level, start: 0, end: language.length };
  }).filter(Boolean);
}

// A recorded capture (the golden JSON). Structured Must tags and Level stay as recorded.
export function fromCapture(capture, sourceRef = '') {
  const cr = capture?.candidateRequirement || {};
  const need = blankNeed({ source: 'smart', sourceRef: sourceRef || capture?.source || '', needId: String(capture?.need?.id || ''), title: capture?.need?.title || '' });
  need.profiles = locateAll('', textsOf(cr.profiles));
  need.skills = { must: locateAll('', textsOf(cr.skills?.must)), niceToHave: locateAll('', textsOf(cr.skills?.niceToHave)) };
  need.languages = { must: langsOf(cr.languages?.must), niceToHave: langsOf(cr.languages?.niceToHave) };
  const exp = cr.experience && typeof cr.experience === 'object' ? cr.experience : null;
  need.experience = exp && exp.label && exp.label !== '-' ? {
    label: String(exp.label), level: String(exp.level || ''), minYears: Number.isFinite(exp.minYears) ? exp.minYears : null,
    maxYears: Number.isFinite(exp.maxYears) ? exp.maxYears : null, start: 0, end: String(exp.label).length,
  } : null;
  need.missionDescription = locateAll('', textsOf(cr.missionDescription));
  need.profileRequirement = locateAll('', textsOf(cr.profileRequirement));
  need.additionalInformationCandidate = cr.additionalInformationCandidate && cr.additionalInformationCandidate !== '-' ? String(cr.additionalInformationCandidate) : null;
  need.additionalInformationNeed = cr.additionalInformationNeed && cr.additionalInformationNeed !== '-' ? String(cr.additionalInformationNeed) : null;
  return finish(need);
}

const SMART_URL = /^https:\/\/need\.arp\.mantu\.com\/needs\/([A-Za-z0-9_-]{1,80})\/?$/;

export function smartNeedId(input) {
  const url = String(input || '').trim();
  const m = SMART_URL.exec(url);
  return m ? m[1] : '';
}

// Fixture only. This object has no fetch method and does not read credentials.
export class SmartNeedLinkAdapter {
  constructor(options = {}) {
    this.fixtures = options.fixtures instanceof Map ? options.fixtures : new Map(Object.entries(options.fixtures || {}));
  }
  resolve(input) {
    const url = String(input || '').trim();
    const id = smartNeedId(url);
    if (!id) return { ok: false, error: 'malformed_link', pasteFallback: true };
    if (!this.fixtures.has(id)) return { ok: false, error: 'unreadable', pasteFallback: true, needId: id };
    const fixture = this.fixtures.get(id);
    const need = typeof fixture === 'string'
      ? parseCandidateRequirementPage(fixture, { source: 'smart', sourceRef: url, needId: id })
      : fromCapture(fixture, url);
    if (!need) return { ok: false, error: 'missing_candidate_requirement', pasteFallback: true, needId: id };
    return { ok: true, partial: !!need.partial, need };
  }
}

const PASTE_HEADS = [
  ['skillMust', /^(must have|must|required skills|required)$/i],
  ['skillNice', /^(nice to have|nice|preferred|optional)$/i],
  ['langMust', /^languages?$/i],
  ['experience', /^(seniority|experience level|years of experience)$/i],
  ['certs', /^certifications?$/i],
];

export class PastedJobDescriptionAdapter {
  resolve(input) {
    const text = String(input || '').replace(/\r/g, '').trim();
    if (!text) return { ok: false, error: 'empty', pasteFallback: true };
    if (/^candidate requirement$/im.test(text) || /^skill\s*\(\s*must\s*\)$/im.test(text) || /^mission description$/im.test(text)) {
      const need = /^candidate requirement$/im.test(asText(text))
        ? parseCandidateRequirementPage(text, { source: 'paste', sourceRef: 'paste' })
        : parseSectionText(text, { source: 'paste', sourceRef: 'paste' });
      return need ? { ok: true, partial: !!need.partial, need } : { ok: false, error: 'empty', pasteFallback: true };
    }
    const found = {};
    let key = null, buf = [];
    const flush = () => { if (key) found[key] = buf.join('\n'); };
    for (const line of text.split(/\n/)) {
      const heading = PASTE_HEADS.find(([, re]) => re.test(line.trim()));
      if (heading) { flush(); key = heading[0]; buf = []; continue; }
      if (key) buf.push(line);
    }
    flush();
    const need = blankNeed({ source: 'paste', sourceRef: 'paste' });
    need.skills = { must: locateAll(text, skillTokens(found.skillMust)), niceToHave: locateAll(text, skillTokens(found.skillNice)) };
    need.languages = { must: locateLanguages(text, languageItems(found.langMust)), niceToHave: [] };
    need.experience = experienceOf(found.experience);
    if (need.experience) {
      const at = text.indexOf(need.experience.label);
      need.experience.start = at < 0 ? 0 : at;
      need.experience.end = at < 0 ? need.experience.label.length : at + need.experience.label.length;
    }
    need.certifications = locateAll(text, skillTokens(found.certs)).map(item => ({ ...item, authority: 'must' }));
    if (!need.skills.must.length && !need.languages.must.length && !need.experience && !need.certifications.length) {
      need.additionalInformationNeed = banned(text) ? null : text.slice(0, 4000);
    }
    const done = finish(need);
    return { ok: true, partial: !!done.partial, need: done };
  }
}

export function hasTerm(text, term) {
  const t = String(term || '').trim();
  if (t.length < 2) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/[^a-z0-9]/i.test(t)) return new RegExp(escaped, 'i').test(String(text || ''));
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
}

function contentTokens(text) {
  const marked = String(text || '').replace(/C\+\+/gi, ' cxx ').replace(/C#/gi, ' csharp ');
  return (marked.toLowerCase().match(/[a-z0-9]+/g) || []).filter(token => token.length > 1 || /\d/.test(token));
}

// CV voice from one published sentence. Drops a leading I/We. Every remaining word is already in the sentence.
// If that check fails, the published sentence is kept. There is no model call.
export function phraseLine(text) {
  const source = String(text || '').trim().replace(/\s+/g, ' ');
  if (!source) return '';
  const stripped = source.replace(/^(?:I|We)(?:\s+am|\s+have|\s+had|\s+was|\s+were|'m|'ve)?\s+/i, '');
  if (!stripped || stripped === source) return source;
  const phrased = stripped[0].toUpperCase() + stripped.slice(1);
  const known = new Set(contentTokens(source));
  if (contentTokens(phrased).some(token => !known.has(token))) return source;
  return phrased;
}

function voiced(line) {
  const source = String(line.text || '').trim();
  return { ...line, source, text: phraseLine(source) };
}

// Snippet roles from the story model (snippets TOPIC_KEYS and kind). Support lines cite
// the work. They are not the consultant's achievement or responsibility.
const STORY_SUPPORT = new Set(['evidence', 'customer_relevance']);

function supportLine(line) {
  return line?.kind === 'evidence' || STORY_SUPPORT.has(line?.topic);
}

function roleSpanMonths(period) {
  const match = String(period || '').match(/(\d{4})-(\d{2})\s*[–—-]\s*(\d{4})-(\d{2})/);
  if (!match) return null;
  const months = (Number(match[3]) - Number(match[1])) * 12 + (Number(match[4]) - Number(match[2]));
  return months >= 0 ? months : null;
}

// A years claim that is longer than the role dates cannot stay on the CV. The sentence is kept on the flag.
function dateFlag(line) {
  const claimed = /(\d+)\s*\+?\s*years\b/i.exec(line.source || line.text || '');
  const months = roleSpanMonths(line.period);
  if (!claimed || months == null) return null;
  const years = Number(claimed[1]);
  if (years * 12 <= months + 2) return null;
  return {
    code: 'date_conflict', topic: 'dates', evidenceId: line.evidenceId,
    detail: `Line says ${years} years; role dates cover ${months} months. Leave it off the CV until the dates are confirmed.`,
  };
}

// Keywords are matched on the published sentence. The visible text is the phrased bullet.
export function composeCv({ consultant = {}, lines = [], need = null, audience = 'internal' } = {}) {
  const voicedLines = (Array.isArray(lines) ? lines : []).filter(line => line && line.text && line.evidenceId && !banned(line.text)).map(voiced);
  const provenance = voicedLines.filter(supportLine);
  const dateFlags = [];
  const source = voicedLines.filter(line => !supportLine(line)).filter(line => {
    const flag = dateFlag(line);
    if (!flag) return true;
    dateFlags.push(flag);
    return false;
  });
  const keywords = need?.keywords || [];
  const hits = line => keywords.reduce((n, key) => n + (hasTerm(line.source || line.text, key.text) ? 1 : 0), 0);
  const ranked = source.map(line => ({ line, n: need ? hits(line) : 0 }));
  ranked.sort((a, b) => b.n - a.n || String(b.line.at || '').localeCompare(String(a.line.at || '')));
  const matches = ranked.filter(item => item.n > 0);
  const rest = ranked.filter(item => item.n === 0);
  const kept = (need ? [...matches, ...rest] : ranked).slice(0, Math.max(16, matches.length)).map(item => item.line);
  const flaggedSkill = new Set((need?.flags || []).filter(flag => flag.code === 'skill_conflict' && flag.skill).map(flag => flag.skill));
  const gaps = keywords.filter(key => key.authority === 'must' && !flaggedSkill.has(key.text) && !kept.some(line => hasTerm(line.source || line.text, key.text))).map(key => ({ keyword: key.text, authority: key.authority, kind: key.kind }));
  return {
    consultant: {
      name: consultant.name || '',
      nameEvidenceId: consultant.nameEvidenceId || null,
      role: consultant.role || '',
      roleEvidenceId: consultant.roleEvidenceId || null,
    },
    audience: audience === 'external' ? 'external' : 'internal',
    lines: kept,
    provenance,
    gaps,
    flags: [...(need?.flags || []), ...dateFlags],
    need: need ? { source: need.source, sourceRef: need.sourceRef || '', needId: need.needId || '', title: need.title || '', keywords, flags: need.flags || [] } : null,
  };
}

const FICHE_TOPICS = ['context', 'contribution', 'approach', 'outcome', 'evidence', 'customer_relevance'];

export function buildFiche(input = {}) {
  const clean = omitCompensation(input);
  const lines = (clean.lines || []).filter(line => line && line.text && line.evidenceId && !banned(line.text));
  const sections = {};
  for (const topic of FICHE_TOPICS) sections[topic] = lines.filter(line => line.topic === topic).map(line => ({ text: line.text, evidenceId: line.evidenceId }));
  return { title: clean.title || '', storyId: clean.storyId || '', sections };
}

function cited(text, evidenceId) {
  if (!text || !evidenceId) return null;
  return { text: String(text), evidenceId: String(evidenceId) };
}

const LANGUAGES = ['English', 'French', 'German', 'Spanish', 'Dutch', 'Italian', 'Portuguese', 'Arabic', 'Mandarin', 'Chinese'];
const LEVELS = ['Native', 'Fluent', 'Professional', 'Intermediate', 'Basic', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const SOFT = ['coaching', 'mentoring', 'leadership', 'teamwork'];
const FUNCTIONAL = ['business analysis', 'stakeholder management'];

function sentence(line) { return line.source || line.text || ''; }

function levelNear(source, kind) {
  const names = LEVELS.join('|');
  const matched = new RegExp(`\\b(${names})\\b\\s+${kind}|${kind}\\s+(?:at\\s+)?(?:a\\s+)?\\b(${names})\\b`, 'i').exec(source);
  if (!matched) return '';
  const word = matched[1] || matched[2];
  return LEVELS.find(level => level.toLowerCase() === word.toLowerCase()) || '';
}

function languageOf(line) {
  const source = sentence(line);
  if (!/\b(speak|speaks|speaking|spoken|written|language|fluent|native|level)\b/i.test(source)) return null;
  const language = LANGUAGES.find(name => hasTerm(source, name));
  if (!language || !line.evidenceId) return null;
  return { language, spoken: levelNear(source, 'spoken'), written: levelNear(source, 'written'), evidenceId: line.evidenceId };
}

function isEducation(line) { return /\b(university|bachelor|master|degree|phd|diploma)\b/i.test(sentence(line)); }
function isTraining(line) { return /\b(certification|certified|certificate)\b/i.test(sentence(line)); }
function supports(line, terms) { return terms.some(term => hasTerm(sentence(line), term)); }

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Atlas CV lines onto the competency-file fields a future MiChat adapter would send.
// yearsOfExperience and summary stay null: a sentence that mentions years stays a project line.
// Languages, education, and certifications are copied only when that sentence states them.
export function toCompetencyFile(cv = {}) {
  const lines = (cv.lines || []).filter(line => line && line.text && line.evidenceId && !banned(line.text) && !supportLine(line));
  const name = splitName(cv.consultant?.name);
  const nameId = cv.consultant?.nameEvidenceId || null;
  const languages = [];
  const education = [];
  const trainings = [];
  const softSkills = [];
  const functionalSkills = [];
  const projectLines = [];
  for (const line of lines) {
    const language = languageOf(line);
    if (language) languages.push(language);
    if (isEducation(line)) { const item = cited(line.text, line.evidenceId); if (item) education.push(item); }
    if (isTraining(line)) { const item = cited(line.text, line.evidenceId); if (item) trainings.push(item); }
    if (supports(line, SOFT)) { const item = cited(line.text, line.evidenceId); if (item) softSkills.push(item); }
    if (supports(line, FUNCTIONAL)) { const item = cited(line.text, line.evidenceId); if (item) functionalSkills.push(item); }
    if (!language && !isEducation(line) && !isTraining(line)) projectLines.push(line);
  }
  const groups = new Map();
  for (const line of projectLines) {
    const id = line.storyId || 'story';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(line);
  }
  const projects = [...groups.values()].map(group => {
    const first = group.find(line => line.company || line.role || line.period) || group[0];
    const pick = topic => group.filter(line => line.topic === topic).map(line => cited(line.text, line.evidenceId)).filter(Boolean);
    const tech = [];
    const seen = new Set();
    for (const line of group) for (const item of line.technologies || []) {
      if (seen.has(item) || !hasTerm(sentence(line), item)) continue;
      seen.add(item);
      tech.push(cited(item, line.evidenceId));
    }
    return {
      company: cv.audience === 'external' ? null : cited(first.company, first.companyEvidenceId),
      role: cited(first.role, first.roleEvidenceId),
      period: cited(first.period, first.periodEvidenceId),
      context: pick('context'),
      responsibilities: [...pick('contribution'), ...pick('approach')],
      technologicalEnvironment: tech,
      achievements: pick('outcome'),
      evidenceIds: group.map(line => line.evidenceId),
    };
  });
  const technical = [];
  const seenTech = new Set();
  for (const line of projectLines) for (const item of line.technologies || []) {
    if (seenTech.has(item) || !hasTerm(sentence(line), item)) continue;
    seenTech.add(item);
    technical.push(cited(item, line.evidenceId));
  }
  return {
    firstName: cited(name.first, nameId),
    lastName: cited(name.last, nameId),
    yearsOfExperience: null,
    jobTitle: cited(cv.consultant?.role, cv.consultant?.roleEvidenceId),
    summary: null,
    technicalSkills: technical.length ? [{ category: null, lines: technical }] : [],
    softSkills,
    functionalSkills,
    languages,
    education,
    trainings,
    projects,
  };
}

export const MICHAT_TODO = 'TODO: MiChat API once owners confirm access. No public API was observed. Do not call MiChat.';
export const MICHAT_LAYOUTS = Object.freeze(['Amaris (Default)', 'European Commission', 'Bnp', 'Little Big Connection']);

// The envelope describes a future version. Atlas already tailored the CV, so this is not a request to run Adapt CF to Project.
export function michatEnvelope(cf, { status = 'draft', language = null, jobOffer = null, operation = null } = {}) {
  return {
    format: 'cf',
    operation: operation || (jobOffer ? 'adapt' : 'create'),
    language: language || null,
    jobOffer: jobOffer || null,
    source: 'atlas',
    status: status === 'Ready' ? 'Ready' : 'draft',
    layout: 'Amaris (Default)',
    layouts: [...MICHAT_LAYOUTS],
    export: 'docx',
    cf,
    network: false,
    todo: MICHAT_TODO,
  };
}

const enc = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of files) {
    const nb = enc.encode(name), data = typeof text === 'string' ? enc.encode(text) : text, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

function xml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
function para(text) { return `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`; }

function documentLines(cv) {
  const cf = toCompetencyFile(cv);
  const lines = [];
  const name = [cf.firstName?.text, cf.lastName?.text].filter(Boolean).join(' ');
  lines.push(name || cv.consultant?.name || 'Consultant');
  if (cf.jobTitle?.text) lines.push(cf.jobTitle.text);
  const section = (title, items) => {
    const rows = (items || []).map(item => item?.text).filter(Boolean);
    if (!rows.length) return;
    lines.push(title, ...rows);
  };
  section('Technical skills', (cf.technicalSkills || []).flatMap(group => group.lines || []));
  section('Soft skills', cf.softSkills);
  section('Functional skills', cf.functionalSkills);
  section('Languages', (cf.languages || []).map(item => ({
    text: [item.language, item.spoken && `spoken ${item.spoken}`, item.written && `written ${item.written}`].filter(Boolean).join(', '),
  })));
  section('Education', cf.education);
  section('Certifications', cf.trainings);
  for (const project of cf.projects || []) {
    lines.push(project.company?.text || 'Experience');
    if (project.role?.text) lines.push(project.role.text);
    if (project.period?.text) lines.push(project.period.text);
    section('Context', project.context);
    section('Responsibilities', project.responsibilities);
    section('Technologies', project.technologicalEnvironment);
    section('Achievements', project.achievements);
  }
  const ids = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.evidenceId && !ids.includes(value.evidenceId)) ids.push(value.evidenceId);
    if (Array.isArray(value.evidenceIds)) for (const id of value.evidenceIds) if (id && !ids.includes(id)) ids.push(id);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
  };
  walk(cf);
  if (ids.length) lines.push('Evidence', ...ids);
  return lines;
}

export function docxBytes(cv) {
  const body = documentLines(cv).map(para).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipStore([['[Content_Types].xml', types], ['_rels/.rels', rels], ['word/document.xml', document]]);
}

function pdfEscape(s) { return String(s).replace(/[\\()]/g, c => '\\' + c).replace(/[^\x20-\x7E]/g, '?'); }
export function pdfBytes(lines) {
  const body = (lines || []).slice(0, 80).map(line => pdfEscape(String(line).slice(0, 110)));
  const commands = ['BT', '/F1 11 Tf', '72 760 Td', '16 TL'];
  body.forEach((line, i) => { if (i) commands.push('T*'); commands.push(`(${line}) Tj`); });
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const xref = [0];
  for (const obj of objects) { xref.push(pdf.length); pdf += obj; }
  const start = pdf.length;
  pdf += `xref\n0 ${xref.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < xref.length; i++) pdf += String(xref[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer << /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return enc.encode(pdf);
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class MiChatAdapter {
  read() { return { ok: false, code: 'API_UNCONFIRMED', network: false, todo: MICHAT_TODO }; }
  write() { return { ok: false, code: 'API_UNCONFIRMED', network: false, todo: MICHAT_TODO }; }
  // Local .docx only. Atlas has already tailored the CV. This does not call Adapt CF to Project.
  exportDocument(cv = {}) {
    const cf = toCompetencyFile(cv);
    const ready = cv.status === 'approved' || cv.status === 'exported';
    const envelope = michatEnvelope(cf, {
      status: ready ? 'Ready' : 'draft',
      language: cv.language || null,
      jobOffer: cv.need?.title || null,
      operation: cv.need ? 'adapt' : 'create',
    });
    return {
      ok: true, network: false, michatAdapt: false, filename: 'cv.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: docxBytes(cv), envelope,
    };
  }
}

export function atlasExport(cv, format = 'docx') {
  if (format === 'html') {
    const body = documentLines(cv).map(line => `<p>${xml(line)}</p>`).join('');
    return { filename: 'cv.html', mime: 'text/html', bytes: enc.encode(`<!DOCTYPE html><html><body>${body}</body></html>`) };
  }
  if (format === 'pdf') return { filename: 'cv.pdf', mime: 'application/pdf', bytes: pdfBytes(documentLines(cv)) };
  return new MiChatAdapter().exportDocument(cv);
}
