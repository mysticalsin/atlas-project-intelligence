"""Record atlas_voice.gaps (the gap-interview policy) for the JS parity test (test/gap-policy.test.js).
Stdlib only:  python3 deploy/cloudflare-edge/test/gen_gap_parity.py
"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.gaps import gap_system_block, gap_notes, gap_status, gap_guidance, time_plan  # noqa: E402

ADMIN = 'ADMIN MODE (fixture): passed through first, unchanged.'  # gap_notes passes any admin note through as given
ASKS = [{'id': 'G1', 'field': 'outcome', 'label': 'Observed outcome', 'ask': 'Proof the bid needs: a measured reduction in claims handling time for [company]'},
        {'id': 'G2', 'field': 'evidence', 'label': 'Supporting artifact', 'ask': 'Proof the bid needs: an ISO 27001 audit report'},
        {'id': 'G3', 'field': 'customer_fit', 'label': 'Customer relevance', 'ask': 'Proof the bid needs: an insurer in «Europe» with “legacy” claims\nsystems'}]
LONG = 'We cut the average handling time from nine to four days.'  # 11 words, no UNKNOWN phrase
D = lambda i, field, status, active=True: {'id': i, 'field': field, 'item_id': 'user-1', 'quote': 'x' * 5, 'status': status, 'active': active,
                                            'supersedes': '', 'provenance': 'unverified_speech_recognition'}

BLOCKS = [[ASKS], [ASKS[:1]], [[]], [[{'id': 'G1', 'field': 'problem', 'label': 'Customer problem', 'ask': 'Tab\there, quote " and backslash \\ and émoji 🙂'}]]]

NOTES = []
for elapsed in (0, 59.9, 125.5, 200, 209.9, 210, 211, 259.5, 260, 261, 300, 320):  # left 300 .. -20: every threshold and both edges
    NOTES.append([elapsed, 300, ['Observed outcome', 'Supporting artifact'], ''])
NOTES += [[100, 300, [], ''], [100, 300, ['Customer relevance'], ADMIN], [250, 300, [], ADMIN], [265, 300, ['Observed outcome'], ADMIN],
          [0, 900, ['Observed outcome'], ''], [809, 900, ['Observed outcome'], ''], [810, 900, [], ''], [860.5, 900, [], '']]

STATUS = [
    # The analyst filed the answer under another field: the ask's own answer window still answers it (and no D-id is listed).
    [ASKS, {'G1': 1}, {'G1': [LONG]}, [D('D-001', 'measurement', 'reported')]],
    # UNKNOWN answers (long or short), a confidential answer, and "don't know" with a curly apostrophe (UNKNOWN uses don.t).
    [ASKS, {'G1': 1, 'G2': 1, 'G3': 1}, {'G1': ["I really don't know what the baseline was back then."], 'G2': ['Confidential, I cannot share that.'],
                                         'G3': ['I don’t know']}, []],
    # Short answers stay open (one attempt) or become deferred (two attempts), whatever the ledger's deferred_fields say.
    [ASKS, {'G1': 1, 'G2': 2, 'G3': 3}, {'G1': ['Yes, about three.'], 'G2': ['Not really.'], 'G3': ['Maybe banks.']}, []],
    # Two attempts, nothing said: deferred; no attempt yet: open; attempts for an unknown ask id are ignored.
    [ASKS, {'G1': 2, 'G9': 5}, {}, []],
    # Details in the ask's own field: reported or uncertain answer it, unknown makes it unknown, an inactive one is ignored.
    [ASKS, {'G1': 2, 'G2': 2, 'G3': 2}, {}, [D('D-001', 'outcome', 'reported'), D('D-002', 'evidence', 'unknown'), D('D-003', 'customer_fit', 'reported', False)]],
    [ASKS, {}, {}, [D('D-001', 'evidence', 'uncertain'), D('D-002', 'evidence', 'unknown'), D('D-003', 'outcome', 'unknown')]],
    # Precedence: an answer beats an unknown in the same window; an unknown beats two attempts.
    [ASKS, {'G1': 2, 'G2': 3}, {'G1': ['Not measured, sorry.', LONG], 'G2': ['That is unknown to me.']}, []],
    # Exactly 5 and 6 words; Python whitespace (U+001F splits, U+FEFF does not); non-ASCII words; non-strings ignored.
    [ASKS, {}, {'G1': ['one two three four five'], 'G2': ['a\x1fb c d e f'], 'G3': ['Nous avons réduit le délai de traitement']}, []],
    [ASKS, {'G2': 1}, {'G1': ['one two three four five six'], 'G2': ['a﻿b c d e f'], 'G3': [None, 7, 'x']}, []],
    [ASKS[:1], {'G1': 0}, {'G1': []}, []],
    [[], {}, {}, [D('D-001', 'outcome', 'reported')]],
    # v2.2 U2 (Tony, 2026-10-31): "I don't know", "no idea", "pass", "next question" are re-angled (up to GAP_REANGLES = 2) before the ask is recorded unknown; "I can't share" is accepted at once.
    [ASKS, {'G1': 1, 'G2': 1, 'G3': 1}, {'G1': ["I don't know"], 'G2': ['no idea'], 'G3': ['pass']}, []],
    [ASKS, {'G1': 2, 'G2': 2, 'G3': 2}, {'G1': ["I don't know", 'no idea'], 'G2': ['pass', 'next question'], 'G3': ['skip', 'dunno']}, []],
    [ASKS, {'G1': 3, 'G2': 3, 'G3': 3}, {'G1': ["I don't know", 'no idea', 'honestly no clue'], 'G2': ['pass', 'next question', 'skip it'], 'G3': ['skip', "I'm not sure", 'dunno']}, []],
    [ASKS, {'G1': 3, 'G2': 4, 'G3': 2}, {'G1': ['no idea', 'Yes, about three.'], 'G2': ['pass', 'Not really.'], 'G3': ['Maybe banks.']}, []],
    [ASKS, {'G1': 2, 'G2': 3, 'G3': 4}, {'G1': ["I don't know", 'it was nine days before'], 'G2': ["I don't know"], 'G3': ["I don't know", 'no idea']}, []],
    [ASKS, {'G1': 2, 'G2': 2, 'G3': 2}, {'G1': ["I don't know", LONG], 'G2': ["I don't know", "I can't share that, it is under NDA"], 'G3': ['It is confidential']}, []],
    [ASKS, {'G1': 2}, {'G1': ['no idea', 'the ops team may know']}, [D('D-001', 'outcome', 'unknown')]],
    [ASKS, {'G1': 1, 'G2': 2, 'G3': 3}, {'G1': ['je ne sais pas'], 'G2': ['aucune idée', 'je passe'], 'G3': ['question suivante', 'passe', 'je ne sais pas']}, [], 'fr'],
    [ASKS, {'G1': 1, 'G2': 2, 'G3': 3}, {'G1': ['weiß ich nicht'], 'G2': ['keine Ahnung', 'nächste Frage'], 'G3': ['pass', 'weiß ich nicht', 'Das kann ich nicht teilen']}, [], 'de'],
    [ASKS, {'G1': 1, 'G2': 2, 'G3': 3}, {'G1': ['no lo sé'], 'G2': ['ni idea', 'siguiente pregunta'], 'G3': ['paso', 'no sé', 'no tengo ni idea']}, [], 'es'],
    [ASKS, {'G1': 2, 'G2': 3, 'G3': 3}, {'G1': ['non lo so', 'non posso condividerlo'], 'G2': ['non ne ho idea', 'passo'], 'G3': ['non lo so', 'prossima domanda', 'passo']}, [], 'it'],
    [ASKS, {'G1': 1, 'G2': 3, 'G3': 3}, {'G1': ['weet ik niet'], 'G2': ['geen idee', 'volgende vraag', 'ik pas'], 'G3': ['weet ik niet', 'overslaan', 'ik pas']}, [], 'nl'],
]

TIMES = [[900, 'full'], [300, 'gap'], [900, 'gap'], [300, 'full'], [120, 'full'], [121, 'full'], [10, 'full'], [30, 'full'], [50, 'full'], [1, 'full'], [45.5, 'full'], [0, 'gap']]

out = {
    'gapSystemBlock': [[c, gap_system_block(*c)] for c in BLOCKS],
    'gapNotes': [[c, gap_notes(*c)] for c in NOTES],
    'gapStatus': [[c, gap_status(*c)] for c in STATUS],
    # Guidance from each recorded status list (so the two functions are also checked together), plus a statuses/asks mismatch.
    'gapGuidance': [[[c[0], gap_status(*c)], gap_guidance(c[0], gap_status(*c))] for c in STATUS]
                   + [[[ASKS, [{'id': 'G2', 'status': 'open'}, {'id': 'G1', 'status': 'deferred'}]],
                       gap_guidance(ASKS, [{'id': 'G2', 'status': 'open'}, {'id': 'G1', 'status': 'deferred'}])]],
    'timePlan': [[c, time_plan(*c)] for c in TIMES],
}
(Path(__file__).parent / 'gap.vectors.json').write_text(json.dumps(out, indent=1) + '\n')
print(sum(len(v) for v in out.values()))
