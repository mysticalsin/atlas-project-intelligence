"""Record Python EnergyTurns on deterministic synthetic PCM for the JS parity test."""
import json, math, struct, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.speech import EnergyTurns, Phrases, sentences, speakable, SAMPLE_RATE

def tone(sec, amp, hz=180):
    n = int(SAMPLE_RATE * sec); return [int(amp * 32767 * math.sin(2 * math.pi * hz * i / SAMPLE_RATE)) for i in range(n)]
CASES = {'one_turn': [(1.3, .001), (1.2, .2), (1.3, .001)], 'short_pause': [(.5, .001), (.6, .2), (.4, .001), (.6, .2), (1.3, .001)],
         'blip': [(.5, .001), (.04, .3), (1.3, .001)], 'two_turns': [(.4, .002), (.8, .15), (1.2, .002), (.9, .25), (1.3, .002)],
         'echo_agent': [(.5, .001), (.8, .03), (1.3, .001)]}
out = {}
for name, segs in CASES.items():
    samples = sum((tone(s, a) for s, a in segs), [])
    agent = name == 'echo_agent'
    t = EnergyTurns(); events = []
    for i in range(0, len(samples), 480):
        started, utt = t.feed(struct.pack('<%dh' % len(samples[i:i + 480]), *samples[i:i + 480]), agent)
        if started: events.append(['start', i])
        if utt: events.append(['utt', i, len(utt)])
    out[name] = {'segments': segs, 'agent': agent, 'events': events, 'floor': round(t.floor, 12)}
out['_sentences'] = [[s, sentences(s)] for s in ('Thanks. What was the baseline? And', 'No end yet', 'One! Two? Three.', 'Merci. Quelle était la référence ? Et', 'ありがとう。基準は何でしたか？そして', 'धन्यवाद। आधार क्या था? और',
    # Not sentence ends: initialisms, abbreviations, an ellipsis or a full stop before a lowercase word, decimals, list numbers.
    'We used A.I. to triage. Then we', 'For example, e.g. Kafka, i.e. a queue. It', 'Mr. Smith and Dr. Patel led it. And',
    'The U.S. team grew 3.5 times. Next', 'We had data... and more data... So', 'Kafka, Spark, etc. were used vs. the old stack. Ok',
    'It ended. ', 'Really? ', 'He said "done." Then', '1. We migrated. 2. We trained. 3', 'Mme. Durand a dit oui. Et')]
from atlas_voice.speech import is_echo
out['_echo'] = [[a, b, is_echo(a, b)] for a, b in (('quelle était la référence', 'Quelle était la référence avant le projet ?'), ('基準 は 何 でした か', '基準 は 何 でした か？'), ('Мы сократили время обработки', 'Как вы измерили время?'), ('what problem were you trying to solve', 'What problem were you trying to solve with it?'))]
# Streaming pieces for the voice: what each delta releases, then what the end of the reply releases.
def phrase_steps(deltas):
    p = Phrases(); return [p.feed(d) for d in deltas] + [p.flush()]
out['_phrases'] = [[d, phrase_steps(d)] for d in (
    ['Thanks. ', 'What was ', 'the baseline?'],
    ['Great. ', 'That is clear. ', 'So it worked. ', 'Who measured the change before and after?', ' Ok.'],
    ['Before we get into the numbers and the detail, ', 'tell me who ', 'owned it.'],
    ['Right, so the budget, ', 'who owned it?', ' And'],
    ['We used A.', 'I. models, e.g. ', 'GPT, in the U.S. ', 'market. It worked.'],
    ['Well...', ' it depends.', ' Right.'],
    ['Two things:\n', '- the budget\n', '- the scope. ', 'Which mattered more?'],
    ['Merci. ', 'Quelle était la référence ? ', 'Et comment l\'avez-vous mesurée ?'],
    ['ありがとう。', '基準は何でしたか？', 'そして'])]
out['_speakable'] = [[t, speakable(t)] for t in (
    '**Budget**: we cut __costs__ by `40%`.', '## Summary\nWe moved.', '- the budget\n- the scope', '1. We migrated.\n2) We trained.',
    'C# and F# stay, -5 degrees, 3.5 times.', '*really* good', '**', ' - ', 'Plain text stays as it is.', 'Quelle était la référence ?')]
(Path(__file__).parent / 'speech.vectors.json').write_text(json.dumps(out))
print({k: len(v['events']) for k, v in out.items() if not k.startswith('_')})
