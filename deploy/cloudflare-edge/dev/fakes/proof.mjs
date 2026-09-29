// T1 fake-model branches for the F1 policies (REQUIREMENTS, BID_RANK, ONEPAGER), keyed on each policy's unique
// first sentence. Deterministic JSON derived only from the input, for offline runs and tests; not a quality judgement.
// The one-pager answer always carries one invented figure ("Cut costs by 99% overnight") that the parser must drop.
import { lexical } from '../../src/reuse.js';
const first = t => (String(t || '').split(/(?<=[.!?])\s/)[0] || '').slice(0, 200);
const sentences = t => String(t || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length >= 12);
const kindOf = s => /\b(sector|industry|insurer|insurance|bank|banking|energy|utility|retail|telecom)\b/i.test(s) ? 'sector' : /\b(certif\w*|iso|accredit\w*)\b/i.test(s) ? 'credential'
  : /\b(reduc\w*|cut|faster|improv\w*|outcome|result)\b/i.test(s) ? 'outcome' : /\b(budget|deadline|regulat\w*|within|constraint)\b/i.test(s) ? 'constraint' : 'capability';

export function fake(system, input) {
  if (system.startsWith('You extract the proof requirements from a customer brief.')) {
    const all = sentences(input), wanted = all.filter(s => /\b(must|shall|need\w*|require\w*|experience|proof|proven|demonstrat\w*|reference)\b/i.test(s)).slice(0, 8);
    const find = re => all.find(s => re.test(s)) || '';
    return JSON.stringify({ requirements: wanted.map(s => ({ text: s.slice(0, 220), kind: kindOf(s), must: /\b(must|shall|required)\b/i.test(s) })),
      customer: { problem: all[0] || '', buyer: (input.match(/\b(COO|CFO|CIO|CTO|CEO|[Dd]irector of [a-z]+|[Hh]ead of [a-z]+)\b/) || [''])[0],
        constraints: find(/\b(budget|deadline|regulat\w*|within|constraint)\b/i), desired_outcome: find(/\b(reduc\w*|faster|improv\w*|outcome|goal)\b/i) } });
  }
  if (system.startsWith('You judge which past project references prove the requirements of a bid.')) {
    const { requirements, customer, candidates } = JSON.parse(input), want = [...requirements.map(r => r.text), ...Object.values(customer || {})].join(' ');
    return JSON.stringify({ results: candidates.map(c => {
      const text = [c.title, c.industry, c.headline, c.challenge, c.contribution, c.outcome, c.relevance].join(' ');
      return { id: c.id, relevance: Math.round(Math.min(100, 30 + 250 * lexical(want, text))), covers: requirements.filter(r => lexical(r.text, text) >= 0.12).map(r => r.id),
        why: 'Similar challenge: ' + first(c.challenge), transferable: [c.headline || c.title].filter(Boolean), caveat: '' };
    }).filter(r => r.relevance >= 30).sort((a, b) => b.relevance - a.relevance) });
  }
  if (system.startsWith('You write a one-page proof summary for a bid from numbered snippets.')) {
    const { requirements, references } = JSON.parse(input), snips = references.flatMap(r => r.snippets), req = requirements.slice(0, 1).map(r => r.id);
    const facts = snips.slice(0, 4).map(s => ({ text: first(s.text), kind: 'fact', cites: [s.id], requirements: req }));
    return JSON.stringify({ title: 'Proof for ' + String(requirements[0]?.text || 'this bid').split(/\s+/).slice(0, 8).join(' '), subtitle: references.map(r => r.title).join(' and ').slice(0, 120),
      summary: facts.slice(0, 2), sections: [{ heading: 'What we delivered', claims: facts.slice(2) },
        { heading: 'Why it matters', claims: [{ text: 'Cut costs by 99% overnight', kind: 'fact', cites: snips.slice(0, 1).map(s => s.id), requirements: [] },
          { text: 'A comparable approach fits this need.', kind: 'interpretation', cites: snips.slice(0, 1).map(s => s.id), requirements: req }] }] });
  }
  return null;
}
