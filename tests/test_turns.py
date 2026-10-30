"""Turn pre-pass (atlas_voice/turns.py): table tests, the D18 key allowlist, languages, context, speed and the edge export."""
import json
import re
import time
from pathlib import Path

import pytest

from atlas_voice import turns
from atlas_voice.quality import FIELDS, NUMERIC, UNKNOWN
from atlas_voice.turns import analyze_turn

ROOT = Path(__file__).resolve().parents[1]
KEYS = ['intents', 'cues', 'field_hints', 'numbers', 'words']
INTENTS = {'pause', 'resume', 'repeat', 'skip', 'dont_know', 'cannot_disclose', 'correction', 'rushed', 'stop', 'question_to_atlas', 'confirm', 'deny'}
CUES = {'metric', 'estimate', 'vague_verb', 'team_claim', 'tech_list', 'certification', 'client_praise', 'describes_setback', 'describes_achievement'}
PERSON = re.compile(r'mood|emotion|sentiment|feel|stress|personality', re.I)


def intents(t, lang='en'): return analyze_turn(t, lang)['intents']
def cues(t): return analyze_turn(t)['cues']


# The cases the task names, then the neighbours that must NOT fire: (text, intents that must be exactly these, cues that must be present, cues that must be absent)
TABLE = [
    ('I helped improve the platform', None, {'vague_verb'}, set()),
    ('we delivered the migration', None, {'team_claim'}, {'vague_verb'}),
    ('I led the migration and we delivered it', None, set(), {'team_claim'}),
    ('about 80% faster', None, {'metric', 'estimate'}, set()),
    ('it was 80% faster', None, {'metric'}, {'estimate'}),
    ("I can't share the client name", ['cannot_disclose'], set(), set()),
    ('It is under NDA so I cannot name them', ['cannot_disclose'], set(), set()),
    ('can we pause for a sec', ['pause'], set(), set()),
    ('sorry, it was 35 not 38', ['correction'], set(), set()),
    ("I don't know", ['dont_know'], set(), set()),
    ('I do not know that', ['dont_know'], set(), set()),
    ('we had no baseline', ['dont_know'], set(), set()),
    ("yes that's right", ['confirm'], set(), set()),
    ("no, that's wrong", ['deny'], set(), set()),
    ('the pilot failed and we had to roll back', None, {'describes_setback'}, set()),
    ('we used Python, Kafka and Terraform', None, {'tech_list'}, set()),
    ('we used Python and Kafka', None, set(), {'tech_list'}),
    ('AWS Solutions Architect certified', None, {'certification'}, {'tech_list'}),
    ('the client said it was the best team they had', None, {'client_praise'}, set()),
    ('the client said the form was too slow', None, set(), {'client_praise'}),
    ("I'm in a hurry, can we keep this short", ['rushed'], set(), set()),
    ('Can you repeat the question?', ['repeat'], set(), set()),
    ('what do you mean by baseline?', ['question_to_atlas'], set(), set()),
    ("let's continue", ['resume'], set(), set()),
    ('can we skip this one', ['skip'], set(), set()),
    ("that's all for now", ['stop'], set(), set()),
    # project talk that only contains the words
    ('we paused the rollout for two weeks', [], set(), set()),
    ('we continue to use Kafka', [], set(), set()),
    ('we need to go through the logs', [], set(), set()),
    ('no idea', ['dont_know'], set(), set()),
    ('no measurement was taken', ['dont_know'], set(), set()),
    ("I'm not sure, maybe 40%", [], {'metric', 'estimate'}, set()),
    ('the next question was how to size the cluster', [], set(), set()),
    ('We streamlined onboarding', None, {'vague_verb'}, set()),
    ('We streamlined onboarding by 30%', None, {'metric'}, {'vague_verb'}),
    ('I personally owned the cutover plan', [], set(), {'team_claim'}),
    ('', [], set(), set()),
]


@pytest.mark.parametrize('text,expected_intents,want,absent', TABLE)
def test_turn_table(text, expected_intents, want, absent):
    r = analyze_turn(text)
    if expected_intents is not None:
        assert r['intents'] == expected_intents, r
    assert want <= set(r['cues']), r
    assert not absent & set(r['cues']), r


def test_intents_that_overlap_are_both_reported_in_a_fixed_order():
    r = analyze_turn("no, wait, it was 35")
    assert r['intents'] == ['correction', 'deny']
    assert analyze_turn('uh, no.')['intents'] == ['deny']
    assert analyze_turn("I can't share the client name")['intents'] == ['cannot_disclose']   # a refusal to disclose is not "I don't know"


def test_a_command_is_not_also_a_question_to_atlas():
    for t in ('can we pause for a sec?', 'could we skip this?', 'can you repeat that?', 'can we wrap up now?', 'can we keep this short?'):
        assert 'question_to_atlas' not in intents(t), t
    assert 'question_to_atlas' in intents('why are you asking that?')


def test_every_intent_and_cue_is_reachable_and_nothing_else_appears():
    seen_i, seen_c = set(), set()
    for text, *_ in TABLE:
        r = analyze_turn(text)
        seen_i |= set(r['intents']); seen_c |= set(r['cues'])
    assert seen_i == INTENTS and seen_c == CUES
    assert set(turns.INTENT_ORDER) == INTENTS and set(turns.CUE_ORDER) == CUES


def test_output_key_allowlist_and_types():
    for text in [t for t, *_ in TABLE] + ['we saved about $1.5 million, 3x faster', None, 42, 'x' * 9000]:
        r = analyze_turn(text)
        assert list(r) == KEYS
        assert set(r['intents']) <= INTENTS and set(r['cues']) <= CUES and set(r['field_hints']) <= set(FIELDS)
        assert isinstance(r['words'], int) and r['words'] >= 0
        for n in r['numbers']:
            assert set(n) <= {'text', 'value', 'unit'} and 'text' in n


def test_no_key_cue_or_intent_names_the_person():
    names = list(turns.INTENT_ORDER) + list(turns.CUE_ORDER) + KEYS + list(turns.CUE_SRC) + list(turns.HINT_SRC) + list(turns.EDGE_CONSTANTS)
    names += [r['intent'] for rules in turns.INTENT_RULES.values() for r in rules] + list(turns.UNIT_CANON.values())
    for t, *_ in TABLE:
        r = analyze_turn(t)
        names += list(r) + r['intents'] + r['cues'] + r['field_hints'] + [k for n in r['numbers'] for k in n]
    assert not [n for n in names if PERSON.search(str(n))]


def test_words_counts_whitespace_separated_tokens():
    assert analyze_turn('')['words'] == 0 and analyze_turn('   ')['words'] == 0
    assert analyze_turn('  one   two\tthree\n')['words'] == 3
    assert analyze_turn('we delivered it')['words'] == 3


def test_numbers_are_found_with_value_and_unit():
    r = analyze_turn('about $1.5 million, 80%, 250ms, 3 months, 2k users, 1,200 euros and 3,5 hours')['numbers']
    got = {n['text']: (n.get('value'), n.get('unit')) for n in r}
    assert got['$1.5 million'] == (1500000, '$') and got['80%'] == (80, '%') and got['250ms'] == (250, 'ms') and got['3 months'] == (3, 'month')
    assert got['2k'] == (2000, None) and got['1,200 euros'] == (1200, '€') and got['3,5 hours'] == (3.5, 'hour')
    assert analyze_turn('sorry, it was 35 not 38')['numbers'] == [{'text': '35', 'value': 35}, {'text': '38', 'value': 38}]
    assert analyze_turn('1.000 users')['numbers'] == [{'text': '1.000 users', 'unit': 'user'}]       # 1.000 is ambiguous: no value claimed
    assert analyze_turn('99999999999999999999 widgets')['numbers'] == [{'text': '99999999999999999999'}]
    assert len(analyze_turn('3 ' * 500)['numbers']) == turns.MAX_NUMBERS
    assert analyze_turn('no numbers here')['numbers'] == []


def test_field_hints_follow_ledger_fields():
    r = analyze_turn('The risk was a regulatory fine; we chose Kafka instead of RabbitMQ and measured the baseline per week')
    assert {'stakes', 'decision', 'measurement'} <= set(r['field_hints'])
    assert r['field_hints'] == [f for f in FIELDS if f in r['field_hints']]       # ledger order
    assert 'contribution' in analyze_turn('I personally owned the cutover plan')['field_hints']
    assert 'problem' not in analyze_turn('No problem, go ahead')['field_hints']
    assert 'measurement' in analyze_turn('latency fell from 800 ms to 250 ms')['field_hints']
    assert analyze_turn('yes')['field_hints'] == []


def test_context_asked_field_hints_an_answer_shaped_turn_only():
    ans = 'We were all over the place really'
    assert analyze_turn(ans)['field_hints'] == []
    assert analyze_turn(ans, context={'asked_field': 'adoption'})['field_hints'] == ['adoption']
    assert analyze_turn('yes', context={'asked_field': 'adoption'})['field_hints'] == []                    # too short to be an answer
    assert analyze_turn('I do not know that really', context={'asked_field': 'outcome'})['field_hints'] == []   # not an answer
    for bad in ({'asked_field': 'nope'}, {'asked_field': 3}, 'adoption', ['adoption'], {}):
        assert analyze_turn(ans, context=bad)['field_hints'] == []


@pytest.mark.parametrize('text,lang,expected', [
    ('on peut faire une pause ?', 'fr', ['pause']), ('on reprend', 'fr', ['resume']), ('pouvez-vous répéter la question', 'fr', ['repeat']),
    ('passons à la question suivante', 'fr', ['skip']), ('je ne sais pas', 'fr', ['dont_know']), ('Je ne peux pas partager le nom du client', 'fr', ['cannot_disclose']),
    ('terminons ici', 'fr', ['stop']), ('oui, exactement', 'fr', ['confirm']), ("non, ce n'est pas ça", 'fr', ['deny']), ('non', 'fr', ['deny']),
    ('Podemos hacer una pausa', 'es', ['pause']), ('continuemos', 'es', ['resume']), ('puedes repetir la pregunta', 'es', ['repeat']),
    ('siguiente pregunta', 'es', ['skip']), ('no sé', 'es', ['dont_know']), ('no se hizo así', 'es', []),
    ('no puedo compartir el nombre del cliente', 'es', ['cannot_disclose']), ('terminemos por hoy', 'es', ['stop']),
    ('sí, claro', 'es', ['confirm']), ('si el cliente lo pide lo hacemos', 'es', []), ('no, es incorrecto', 'es', ['deny']),
])
def test_french_and_spanish_have_intents(text, lang, expected):
    assert intents(text, lang) == expected


def test_french_spanish_and_other_languages_have_intents_only():
    for lang in ('fr', 'es'):
        r = analyze_turn('we delivered it, about 80% faster, the pilot failed', lang)
        assert r['cues'] == [] and r['field_hints'] == [] and r['numbers'] == [] and r['words'] == 9
    for lang in ('de', 'ja', 'pt', 'xx'):
        r = analyze_turn('yes, pause please, I helped improve it by 80%', lang)
        assert (r['intents'], r['cues'], r['field_hints'], r['numbers']) == ([], [], [], []) and r['words'] == 9
    # an unusable or regional language tag falls back to the base language
    assert intents('yes', 'EN-us') == ['confirm'] and intents('yes', 'en_GB') == ['confirm'] and intents('yes', None) == ['confirm']
    assert intents('yes', 'de') == [] and intents('ありがとう', 'ja') == []


def test_accents_quotes_and_case_do_not_matter():
    assert intents('I CAN’T SHARE THE CLIENT NAME') == ['cannot_disclose']
    assert intents('NO, THAT’S WRONG') == ['deny']
    assert 'tech_list' in cues('Café résumé: naïve déjà vu, we used Python, Kafka and Terraform')
    assert intents('POUVEZ-VOUS RÉPÉTER', 'fr') == ['repeat']


def test_pure_deterministic_and_does_not_touch_its_input():
    ctx = {'asked_field': 'adoption'}
    a = analyze_turn('We rolled it out to the ops team', 'en', ctx)
    assert a == analyze_turn('We rolled it out to the ops team', 'en', ctx) and ctx == {'asked_field': 'adoption'}
    a['intents'].append('x'); a['numbers'].append({})
    assert 'x' not in analyze_turn('We rolled it out to the ops team', 'en', ctx)['intents']
    for junk in (None, 7, ['a'], b'bytes', {'a': 1}):
        assert analyze_turn(junk) == {'intents': [], 'cues': [], 'field_hints': [], 'numbers': [], 'words': 0}


def _per_call(text, n=100):
    analyze_turn(text)
    t0 = time.perf_counter()
    for _ in range(n):
        analyze_turn(text)
    return (time.perf_counter() - t0) / n


def test_fast_under_two_milliseconds_on_real_answers_and_bounded_on_junk():
    typical = 'So we migrated the billing platform from the old batch jobs to Kafka, and I personally owned the cutover plan. It was about 80% faster.'
    long = 'we used Python, Kafka and Terraform and it was about 80% faster, the client said it was the best team. ' * 40    # 4000 characters, every cue firing
    assert _per_call(typical) < 0.002 and _per_call(long) < 0.002
    # Degenerate input (one word repeated, a wall of digits) is cut at MAX_CHARS, so it stays within a small constant.
    for text in ('we ' * 1500, 'a' * 5000, '3 ' * 2000):
        assert _per_call(text) < 0.005, text[:10]
    assert analyze_turn('word ' * 5000)['words'] == 5000    # words counts everything; only the first MAX_CHARS characters are analysed
    assert analyze_turn('filler ' * 400 + 'we paused. can we pause for a sec')['intents'] == []


def test_reuses_the_quality_regexes():
    rules = turns.INTENT_RULES['en']
    assert any(r['src'] == UNKNOWN.pattern and r['intent'] == 'dont_know' for r in rules)
    assert 'metric' in cues('cut waiting by 12 hours') and NUMERIC.search('cut waiting by 12 hours')
    assert 'estimate' in cues('maybe 12 hours')  # quality.UNCERTAIN
    assert 'estimate' not in cues('we maybe did it')    # an estimate marker without a number is not an estimate


def test_patterns_use_only_syntax_javascript_reads_the_same():
    srcs = [r['src'] for rules in turns.INTENT_RULES.values() for r in rules] + [r['unless_src'] for rules in turns.INTENT_RULES.values() for r in rules]
    srcs += [v for v in turns.CUE_SRC.values() if isinstance(v, str)] + list(turns.HINT_SRC.values()) + [turns.NUMBER_SRC, turns.TECH_SRC, turns.HINT_FROM_TO]
    for s in srcs:
        assert not re.search(r'\(\?P|\(\?i|\\A|\\Z|\(\?#|\(\?<[A-Za-z]|\(\?[aiLmsux]+[:)]|[*+?}]\+', s), s
        re.compile(s, re.I | re.A)


def test_edge_export_is_registered_and_generated():
    build = (ROOT / 'deploy' / 'cloudflare-edge' / 'build_edge.py').read_text()
    assert "'atlas_voice.turns'" in build
    generated = (ROOT / 'deploy' / 'cloudflare-edge' / 'src' / 'policy.generated.js').read_text()
    for k, v in turns.EDGE_CONSTANTS.items():
        assert k.startswith('TURN_')
        assert f'export const {k} = {json.dumps(v, ensure_ascii=False)};' in generated, k
    vectors = json.loads((ROOT / 'deploy' / 'cloudflare-edge' / 'test' / 'turns.vectors.json').read_text())
    assert len(vectors) >= 40 and all(analyze_turn(*args) == expected for args, expected in vectors)
