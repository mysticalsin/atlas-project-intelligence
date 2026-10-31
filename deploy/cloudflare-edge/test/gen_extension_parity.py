"""Record Python atlas_voice/extension.py for the JS port (test/extension.test.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice import extension as x

out = {
    'hard': [[s, x.hard_limit(s)] for s in (1200, 120, 300, 90, 1, 5, 1500)],
    'offer': [[f, i, x.offer_text(f, i)] for f, i in (('contribution', 'ask'), ('measurement', None), ('outcome', 'measurement'), (None, 'confirm_asr'), (None, 'contradiction'), ('problem', 'asr_repair'), ('nonsense', 'ask'), (None, None), ('_asr', 'ask'), ('toString', 'ask'))],
    'should': [[k, r, e, t, x.should_offer(k, r, e, t)] for k in ('ask', 'summary', 'close', 'confirm_asr', 'offer_move_on', 'accept_and_move') for r in (False, True) for e in (None, 'offered', 'accepted', 'refused') for t in (400, 270, 269, 90)],
    'reply': [[i, w, x.reply(i, w)] for i, w in (([], 0), (['confirm'], 1), (['confirm'], 0), (['deny'], 1), (['confirm', 'deny'], 3), (['rushed'], 9), ([], 6), ([], 5), (['stop'], 20), (['dont_know'], 8), (['skip'], 2), (['question_to_atlas'], 3), (['pause'], 1), (['correction'], 12), (['cannot_disclose', 'confirm'], 3))],
}
(Path(__file__).parent / 'extension.vectors.json').write_text(json.dumps(out, ensure_ascii=False))
print({k: len(v) for k, v in out.items()})
