"""Record Python EnergyTurns on deterministic synthetic PCM for the JS parity test."""
import json, math, struct, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.speech import EnergyTurns, sentences, SAMPLE_RATE

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
out['_sentences'] = [[s, sentences(s)] for s in ('Thanks. What was the baseline? And', 'No end yet', 'One! Two? Three.', 'Merci. Quelle était la référence ? Et', 'ありがとう。基準は何でしたか？そして', 'धन्यवाद। आधार क्या था? और')]
from atlas_voice.speech import is_echo
out['_echo'] = [[a, b, is_echo(a, b)] for a, b in (('quelle était la référence', 'Quelle était la référence avant le projet ?'), ('基準 は 何 でした か', '基準 は 何 でした か？'), ('Мы сократили время обработки', 'Как вы измерили время?'), ('what problem were you trying to solve', 'What problem were you trying to solve with it?'))]
(Path(__file__).parent / 'speech.vectors.json').write_text(json.dumps(out))
print({k: len(v['events']) for k, v in out.items() if not k.startswith('_')})
