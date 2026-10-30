"""Record Python select() on scripted conversations and hand-made situations for the JS parity test (selector.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.quality import InterviewLedger
from atlas_voice.selector import select
from atlas_voice.turns import analyze_turn

VECTORS = []


def roundtrip(x): return json.loads(json.dumps(x, ensure_ascii=False))


def record(plan, turn, asked, prefill, phase, left, asr=None, rushed=False, lang='en'):
    args = roundtrip([plan, turn, asked, prefill, phase, left, asr, rushed, lang])
    move = select(*args)
    VECTORS.append([args, roundtrip(move)])
    return move


def ledger(*pairs):
    led = InterviewLedger()
    for i, (f, q) in enumerate(pairs):
        led.add_transcript(f't{i}', q); led.record({'details': [{'field': f, 'item_id': f't{i}', 'quote': q}]})
    return led.inspect()


def converse(utterances, prefill=None, rushed=False, plan=None, phases=None, lefts=None, asr=None, records=None, lang='en'):
    """Each step: analyse the answer with the last asked field, optionally record it in a real ledger, select, log the move."""
    asked, led = [], InterviewLedger()
    for i, text in enumerate(utterances):
        last = asked[-1] if asked else None
        t = analyze_turn(text, lang, {'asked_field': last['field']} if last and last['field'] else None)
        if records and records.get(i):
            led.add_transcript(f'i{i}', text); led.record({'details': [{'field': records[i], 'item_id': f'i{i}', 'quote': text}]})
        p = plan if plan is not None else led.inspect()
        m = record(p, t, asked, prefill or {}, phases[i] if phases else 'breadth', lefts[i] if lefts else 800 - 30 * i, (asr or {}).get(i), rushed, lang)
        asked.append(m)
    return asked


converse(['hello', 'We were modernising the reporting platform for the finance department', 'I helped improve the platform', 'We rebuilt the nightly report job so it ran in parallel',
          'I designed the pipeline and wrote the validation rules myself', 'It takes about 25 minutes now.', 'Three monthly cycles', 'It used to take two days', 'A dashboard and the pipeline docs',
          "I don't know", 'we cut costs by 30% and the client said it was the best reporting they had had'])
converse(['hello', 'Reports took too long and the data was inconsistent', 'we used Python, Kafka and Terraform for the pipeline', 'AWS Solutions Architect certified and also Scrum Master',
          'the client said it was the best team they had', 'we delivered the migration', 'ok', 'about 80% faster', 'We measured it', 'over three months', 'two days before', 'in a dashboard'],
         records={1: 'problem', 3: None})
converse(["I can't share the client name", 'It was a retail bank and the problem was slow onboarding for new customers', "I really can't say more about them", 'we built a new flow',
          'sorry, it was 35 not 38', 'I led the data migration only, not the whole programme', 'yes', 'no'])
converse(['I only have five minutes', 'a billing migration for a retailer', 'I wrote the scripts and ran the cutover', 'Latency fell and nobody complained', 'we used Python, Kafka and Terraform', 'we cut costs by 30%'], rushed=True)
converse(["I'm in a hurry, can we keep this short", 'we moved the batch jobs to Kafka', 'I did the design', 'faster reports', 'ok'])
converse(['we ran the assessment over two weeks', 'it showed the platform needed more work', 'I wrote the findings', 'the customer decided to pause', 'ok', 'ok', 'ok', 'ok'], prefill={'stage': 'Assessment', 'role': 'Architect'})
converse(['hello', 'hmm', 'hmm', 'hmm', 'mm', 'mm', 'uh huh', 'uh huh', 'hmm', 'hmm', 'hmm', 'hmm'])
converse(['the pilot failed and we had to roll back', 'we delivered the second phase and reduced the backlog', 'what do you mean?', 'can we pause for a sec', 'say that again', 'ok', 'ok', 'that is all for now', 'yes'])
converse(['x', 'x', 'a long enough answer that mentions the legacy batch jobs and the backlog of complaints', 'we owned it', 'I personally designed and owned the cutover plan',
          'it was adopted by the ops team after the handover', 'ok', 'ok', 'ok', 'ok'], phases=['breadth'] * 3 + ['depth'] * 7, lefts=[800, 700, 600, 500, 400, 300, 250, 200, 150, 60])
converse(['we cut it by forty-five percent', 'yes', 'no, wrong', 'it was Contoso', 'ok', 'fine'], asr={0: [{'text': 'forty-five percent', 'kind': 'number'}, {'text': 'Contoso', 'kind': 'name'}], 3: [{'text': 'Contoso', 'kind': 'name'}]})
converse(['Reports took two days', 'I owned the pipeline and the validation', 'it runs in 25 minutes now', 'I do not know that', 'we never measured it', 'ok', 'ok'],
         records={0: 'problem', 1: 'contribution', 2: 'outcome', 3: None, 4: 'measurement'}, phases=['breadth', 'breadth', 'depth', 'depth', 'depth', 'depth', 'depth'])
converse(['hello', 'bonjour', 'les rapports prenaient deux jours', 'je ne sais pas', 'terminons ici'], lang='fr')
converse(['ok'] * 4, prefill={'prior_notes': ['problem', 'contribution'], 'sector': 'Retail', 'oppId': 'OPP-7'})
converse(['ok'] * 4, prefill={'prior_notes': {'fields': {'problem': 'x', 'outcome': 'y', 'zzz': 'q'}}, 'problem': ''})
converse(['ok'] * 3, plan={'candidate_details': [], 'covered_fields': ['problem', 'stakes', 'contribution', 'intervention', 'decision', 'adoption', 'outcome', 'measurement', 'evidence', 'limitations', 'customer_fit', 'poor_fit']})

# hand-made situations
C = ledger(('outcome', 'It takes 25 minutes now'), ('outcome', 'The report now takes 40 minutes'))
record(C, analyze_turn('okay', 'en'), [], {}, 'breadth', 800)
record(C, analyze_turn('about 80% faster', 'en'), [], {}, 'breadth', 800)
record(C, analyze_turn("I don't know", 'en'), [], {}, 'breadth', 800)
record(C, analyze_turn('sorry I meant 30% faster', 'en'), [], {}, 'breadth', 800)
record(C, analyze_turn('okay', 'en'), [], {}, 'depth', 800, rushed=True)
record(C, analyze_turn('okay', 'en'), [], {}, 'closing', 800)
record(ledger(('outcome', 'a 30% saving'), ('outcome', 'a 12% saving'), ('measurement', 'measured monthly, 5 then 3 hours')), analyze_turn('okay', 'en'), [], {}, 'breadth', 800)
record(ledger(('outcome', 'It dropped from 2 days to 25 minutes'), ('outcome', 'It takes 25 minutes')), analyze_turn('okay', 'en'), [], {}, 'breadth', 800)
D = ledger(('problem', 'Reports took two days'), ('contribution', 'I owned the pipeline'), ('outcome', 'They run in 25 minutes'))
record(D, analyze_turn('okay', 'en'), [], {}, 'depth', 800)
record(D, analyze_turn('okay', 'en'), [], {}, 'breadth', 800)
record(D, analyze_turn('we delivered the migration and reduced the ticket backlog', 'en'), [], {}, 'breadth', 800)
E = ledger(('outcome', 'It dropped from 2 days to 25 minutes'), ('measurement', 'Median duration measured before and after over three months in 2024 for the finance team report queue, 2 days then 25 minutes'))
record(E, analyze_turn('we delivered the migration and reduced the ticket backlog', 'en'), [], {}, 'breadth', 800)
record(E, analyze_turn('we delivered the migration and reduced the ticket backlog', 'en'), [{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'reaction': 'earned'}], {}, 'breadth', 800)
record(E, analyze_turn('the pilot failed and we had to roll back', 'en'), [], {}, 'breadth', 800)
record(ledger(('problem', 'Reports took two days'), ('measurement', "We don't know the baseline, it was never measured")), analyze_turn('about 80% faster', 'en'), [], {}, 'breadth', 800)
record({}, analyze_turn('it was 80% faster after we delivered it', 'en'), [], {}, 'breadth', 800)
record({}, analyze_turn('', 'en'), [], {}, 'breadth', 800)
record({}, analyze_turn('', 'en'), [], {}, 'wrap', 800)
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, 'depth', 60, asr=[{'text': '30', 'kind': 'number'}])
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, 'breadth', 200)
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, 'breadth', 75)
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, 'breadth', 76)
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, 'junk', None)
record({}, analyze_turn('we cut costs by 30%', 'en'), [], {}, None, None)
record({'candidate_details': [], 'missing': list(['problem', 'stakes', 'decision'])}, analyze_turn('ok then', 'en'), [], {}, 'breadth', 800)
record({'candidate_details': [], 'unresolved_fields': ['problem'], 'deferred_fields': {'contribution': 'x'}}, analyze_turn('ok then', 'en'), [], {}, 'breadth', 800)
record({'flags': ['Numerical outcome lacks a recorded measurement basis'], 'candidate_details': []}, analyze_turn('ok then', 'en'), [], {}, 'breadth', 800)
record({'flags': ['Numerical outcome lacks a recorded measurement basis'], 'candidate_details': [], 'covered_fields': ['outcome']}, analyze_turn('it was measured weekly', 'en'), [], {}, 'breadth', 800)
record(None, None, None, None, None, None)
record('x', 5, 'y', [], 'nope', 'soon')
record({'candidate_details': [None, {'field': 'zzz'}, {'field': 'problem', 'quote': 3}]}, {'intents': 'pause', 'field_hints': [1, 'problem'], 'words': 'x'}, [None, 3, {}, {'field': 'problem', 'why': 3}], {'prior_notes': 7}, 'depth', 300)
record({}, {'intents': [], 'cues': ['team_claim', 'tech_list', 'certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9}, [], {}, 'breadth', 800)
record({}, {'intents': [], 'cues': ['tech_list', 'certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9}, [], {}, 'breadth', 800)
record({}, {'intents': [], 'cues': ['certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9}, [], {}, 'breadth', 800)
record({}, {'intents': [], 'cues': ['client_praise'], 'field_hints': [], 'numbers': [], 'words': 9}, [], {}, 'breadth', 800)
record({}, analyze_turn('x' * 5, 'en'), [{'intent': 'x', 'field': None, 'rung': None, 'say': 'filler about nothing'}], {}, 'breadth', 800)
# repetition: the first variant already said by another intent, then every variant said
from atlas_voice.selector import QUESTION_BANK
v = QUESTION_BANK['open_exploration']['en']
record({}, analyze_turn('', 'en'), [{'intent': 'q', 'field': None, 'rung': None, 'say': v[0]}], {}, 'breadth', 800)
record({}, analyze_turn('', 'en'), [{'intent': 'q', 'field': None, 'rung': None, 'say': s} for s in v], {}, 'breadth', 800)
record({}, analyze_turn('', 'en'), [{'intent': 'q', 'field': None, 'rung': None, 'say': v[0].upper() + ' today'}], {}, 'breadth', 800)
# the exact 0.8 boundary: "What was your role on the" is 4 of the 5 word 3-grams of "What was your role on the project?"
only_contribution = {'candidate_details': [], 'covered_fields': [f for f in ['problem', 'stakes', 'contribution', 'intervention', 'decision', 'adoption', 'outcome', 'measurement', 'evidence', 'limitations', 'customer_fit', 'poor_fit'] if f != 'contribution']}
record(only_contribution, analyze_turn('', 'en'), [{'intent': 'q', 'field': None, 'rung': None, 'say': 'What was your role on the'}], {}, 'breadth', 800)
record(only_contribution, analyze_turn('', 'en'), [{'intent': 'q', 'field': None, 'rung': None, 'say': 'What was your role'}], {}, 'breadth', 800)
# vague verb after two examples and an ownership question: the vague rule stays quiet
vq = {'kind': 'ask', 'intent': 'vague_example', 'field': 'intervention', 'rung': 2, 'why': 'vague:example'}
record({}, analyze_turn('I helped with the migration', 'en'), [{**vq, 'say': 'a one'}, {**vq, 'say': 'another two'}, {'kind': 'ask', 'intent': 'ownership', 'field': 'contribution', 'rung': 3, 'say': 'what part three'}], {}, 'breadth', 800)
record({}, analyze_turn('I helped with the migration', 'en'), [{**vq, 'say': 'a one'}, {**vq, 'say': 'another two'}], {}, 'breadth', 800)
# the offer to move on, after two attempts
only = {'candidate_details': [], 'covered_fields': [f for f in ['problem', 'stakes', 'contribution', 'intervention', 'decision', 'adoption', 'outcome', 'measurement', 'evidence', 'limitations', 'customer_fit', 'poor_fit'] if f != 'problem']}
converse(['hmm'] * 6, plan=only)
converse(['hmm'] * 5, plan={'candidate_details': [], 'covered_fields': [f for f in ['problem', 'stakes', 'intervention', 'decision', 'adoption', 'outcome', 'measurement', 'evidence', 'limitations', 'customer_fit', 'poor_fit']]})

(Path(__file__).parent / 'selector.vectors.json').write_text(json.dumps(VECTORS, ensure_ascii=False))
print(len(VECTORS))
