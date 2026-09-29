// Deterministic stand-in for the analyst model in local runs and tests. It answers each known prompt shape with
// JSON derived only from its input, so flows can be exercised offline. It is not a quality judgement.
import { lexical } from '../src/reuse.js';
import { EXTRA_FAKES } from './fakes/index.mjs';
const first = t => (String(t || '').split(/(?<=[.!?])\s/)[0] || '').slice(0, 200);
const INDUSTRY = [[/energy|oil|gas|utility|power/i, 'Energy'], [/bank|finance|payment/i, 'Banking'], [/insur/i, 'Insurance'], [/telecom|operator|network/i, 'Telecom'], [/retail|shop/i, 'Retail']];
export function fakeModel() {
  const words = t => (String(t).toLowerCase().match(/[a-z0-9&+.-]{3,}/g) || []);
  return {
    async complete(messages) {
      const system = messages[0]?.content || '', input = messages[1]?.content || '';
      // Feature policies first (dev/fakes/<track>.mjs), each keyed on its policy's unique first sentence.
      for (const fake of EXTRA_FAKES) { const out = await fake(system, input); if (typeof out === 'string') return out; }
      if (system.startsWith('You review a draft project reference')) {
        const rec = JSON.parse(input), a = rec.answers || [], len = a.filter(x => (x || '').length > 40).length;
        return JSON.stringify({ score: 40 + len * 9, client_value_clear: (a[5] || '').length > 30, issues: (a[4] || '').length < 20 ? [{ field: 'evidence', kind: 'missing', detail: 'No supporting evidence is named.' }] : [],
          recommendations: ['Name who measured the result and over which period.'], summary: 'Stand-in review for local testing.' });
      }
      if (system.startsWith('A consultant describes a sales situation')) {
        const industry = (INDUSTRY.find(([re]) => re.test(input)) || [0, 'General'])[1];
        return JSON.stringify({ industry, audience: /data/i.test(input) ? 'Data director' : 'Executive', country: '', likely_challenges: ['Fragmented data and slow decisions', 'Manual, error-prone operations'],
          capabilities: ['Data & AI', 'Process automation'], search_text: input + ' data platform automation operations efficiency' });
      }
      if (system.startsWith('You match past project references')) {
        const { context, candidates } = JSON.parse(input), want = [context.query, context.search_text, ...(context.likelyChallenges || [])].join(' ');
        return JSON.stringify({ results: candidates.map(c => ({ id: c.id, relevance: Math.round(30 + 70 * Math.min(1, lexical(want, [c.challenge, c.outcome, c.relevance, c.headline].join(' ')) * 3)),
          why: 'Similar challenge: ' + first(c.challenge), transferable: [c.headline || c.title].filter(Boolean), caveat: '' })).sort((a, b) => b.relevance - a.relevance) });
      }
      if (system.startsWith('You turn one validated project reference')) {
        const { context, reference: r } = JSON.parse(input), a = r.answers || [];
        return JSON.stringify({ title: r.title, subtitle: r.report?.headline || r.sector || '', summary: first(a[0]) + ' ' + first(a[3]),
          sections: [{ heading: 'The challenge', bullets: [{ text: first(a[0]), kind: 'fact', source: 'context' }] }, { heading: 'What we did', bullets: [{ text: first(a[1]), kind: 'fact', source: 'contribution' }] },
            { heading: 'Results', bullets: [{ text: first(a[3]), kind: 'fact', source: 'outcome' }, { text: 'Cut costs by 99% overnight', kind: 'fact', source: 'outcome' }] },
            { heading: 'Why it matters for you', bullets: [{ text: 'A comparable approach fits: ' + String(context).slice(0, 80), kind: 'interpretation', source: 'target' }] }] });
      }
      if (system.startsWith('You are an assistant specialising in project reference sheets')) {
        const m = JSON.parse(input), doc = m.source_document || '', ans = m.consultant_answers_to_challenges || '', p = m.project || {};
        const sentences = (doc.match(/[^.!?\n]+[.!?]/g) || []).map(s => s.trim()), TBD = 'To be completed';
        const answer = ans ? ans.split('A:').pop().trim() : '';
        return JSON.stringify({ title: p.title || (doc.split('\n').find(Boolean) || '').slice(0, 60),
          exec: { summary: sentences.length >= 3 ? sentences.slice(0, 3).join(' ') : TBD, teamSize: /consultant/i.test(doc) ? (doc.match(/\d+ consultants[^.\n]*/i) || [TBD])[0] : TBD, duration: (doc.match(/\d+ months/) || [TBD])[0], price: TBD, contacts: TBD },
          sections: { industry: p.sector ? p.sector + ' client' : TBD, issue: sentences[0] || TBD, scope: doc ? doc.split('\n').filter(Boolean).slice(1, 3).join(' ') : TBD, methodology: TBD, deliverables: TBD, tools: TBD, team: TBD, value: answer || TBD },
          challenges: [{ group: 'Results and ROI', questions: ['What measurable gain did the client get?', 'Compared with what baseline?'] }, { group: 'Team and delivery', questions: ['How many consultants, where, and at what seniority?'] }] });
      }
      if (system.startsWith('You select the 2 or 3 visuals')) {
        const { images } = JSON.parse(input);
        return JSON.stringify({ selected: images.map(i => ({ index: i.index, approach: /diagram|phase|approach/i.test(i.description), why: 'Shows ' + i.description.slice(0, 60), caption: 'Project approach (labels translated from French)' })) });
      }
      if (system.startsWith('You analyse a set of anonymised')) {
        const { references } = JSON.parse(input), ids = references.map(r => r.id), by = {};
        for (const r of references) (by[r.industry || 'General'] = by[r.industry || 'General'] || []).push(r.id);
        const top = Object.entries(by).sort((a, b) => b[1].length - a[1].length);
        return JSON.stringify({ repeated_needs: top.map(([k, v]) => ({ need: `Operational efficiency in ${k}`, reference_ids: v })), emerging_expertise: [{ area: 'Applied AI in operations', reference_ids: ids.slice(0, 2) }],
          offering_ideas: [{ title: 'Packaged triage automation', rationale: 'Several references solve the same routing problem. It could become a repeatable offer.', reference_ids: ids.concat(['not-a-real-id']) }], gaps: ['Few references outside Europe'] });
      }
      return '{}';
    },
    async embed(text) { const v = new Array(64).fill(0); for (const w of words(text)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 64] += 1; } return v; },
  };
}
