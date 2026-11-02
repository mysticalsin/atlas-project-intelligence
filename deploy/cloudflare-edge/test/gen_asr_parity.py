"""Record Python uncertain_spans / replacement / tau_from on a table of word lists for the JS parity test."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.asr import uncertain_spans, replacement, tau_from


def words(spec, conf=0.95):
    """'twenty:0.4 five:0.4 minutes' -> [{w, c, s, e}]: a token may carry ':confidence'; start and end follow its position."""
    out = []
    for i, tok in enumerate(spec.split()):
        w, _, c = tok.partition(':')
        out.append({'w': w, 'c': float(c) if c else conf, 's': round(i * 0.4, 3), 'e': round(i * 0.4 + 0.35, 3)})
    return out


SPECS = [
    'it took twenty:0.4 five:0.4 minutes', 'it took twenty five minutes', 'we saved 35:0.3 percent', 'we saved 35%:0.3 a year', 'it cost $ 5:0.4 million',
    'it cost $5:0.4 million', 'we saved dirty:0.3 percent', 'we saved dirty:0.3 euros', 'we saved euros:0.3', 'five:0.3 percent ten:0.9 percent', 'five:0.9 percent ten:0.3 percent',
    'we worked with Contoso:0.4 on it', 'we worked with Contoso on it', 'Contoso:0.4 hired us', 'We hired Kyle:0.3 Johnson:0.9 last year', 'We hired Kyle:0.3 Johnson:0.2 last year',
    'I:0.2 led the team', "I'm:0.2 sure it was fine", 'It was big. Yesterday:0.3 we shipped', 'It was big. Then Contoso:0.3 signed', 'He said "done." Then Contoso:0.3 signed',
    'AWS:0.4 and Azure:0.5 both ran it', 'on Q3:0.3 we shipped', 'in 2023:0.4 we moved', 'twenty-five:0.4 hours a week', 'nothing uncertain here at all',
    'the one:0.2 thing we did', 'about 3.5:0.4 hours', 'it was 3.:0.4', 'a:0.1 b:0.1 c:0.1', '', 'hello', 'we saved 35:0.549 percent', 'we saved 35:0.55 percent', 'we saved 35:0.5499 percent',
    'it took twenty:1.0 five:1.0 minutes', 'it took twenty:0.0 five:0.0 minutes', '1:0.1 2:0.1 3:0.1 4:0.1 5:0.1 6:0.1 7:0.1 8:0.1 9:0.1', 'Alpha:0.1 beta Beta:0.1 gamma Gamma:0.1',
    'we used Python:0.3 and Kafka:0.2 and Terraform:0.4', 'ten:0.4 Contoso:0.2 five:0.3', 'we saved 5:0.3 dollars and 7:0.4 euros', '€ 12:0.2 per month', '£ the:0.1 cost', 'Zoë:0.3 and Émile:0.3 joined',
    'x' * 80 + ':0.3', 'twenty:0.3 five:0.3 thousand:0.3 Euros:0.3',
]
THRESHOLDS = [None, 0.55, 0.3, 0.9, 1, 0, -1, 'abc', '0.4', ' 0.4 ', '.4', '1.5', 'nan', True, [0.4]]
cases = [[words(s)] for s in SPECS]
cases += [[words('it took twenty:0.4 five:0.4 minutes'), t] for t in THRESHOLDS]
cases += [[words('we saved 35:0.45 percent'), t] for t in (0.4, 0.5, 0.6)]
# malformed inputs
cases += [[None], ['twenty five'], [42], [{}], [[None, 3, 'x', [], {}]], [[{'w': 'five', 'c': 0.1}]], [[{'w': 'five', 'c': 'low'}]], [[{'w': 'five', 'c': 0.1, 's': 'x', 'e': True}]],
          [[{'w': 'five', 'c': True}]], [[{'w': 5, 'c': 0.1}]], [[{'w': 'five', 'c': 0.1}] * 450]]
spans = [[a, uncertain_spans(*a)] for a in cases]
TEXTS = [('no, thirty five', 'number'), ("no, it was 35 percent", 'number'), ('it was thirty five minutes, not twenty five', 'number'), ('the right one was fifteen', 'number'), ('no, it was Contoso', 'proper_noun'),
         ('It was Contoso Limited', 'proper_noun'), ('no Kyle Johnson and Contoso', 'proper_noun'), ('no, it was Contoso', 'number'), ('thirty-five', 'number'), ('', 'number'), ('no', 'number'), ('$ 5 million', 'number'),
         ('yes', 'proper_noun'), (None, 'number'), (7, 'number'), ('five ' * 300, 'number')]
repl = [[a, replacement(*a)] for a in TEXTS]
tau = [[v, tau_from(v)] for v in [None, '0.55', '0.3', '1', '1.0', '0', '0.0', '2', '-0.2', '.5', '5.', '1e-1', '0x1', '1_0', 'abc', '', ' 0.7 ', 0.2, 1, 0, True, False, [], {}]]
out = {'spans': spans, 'replacement': repl, 'tau': tau}
(Path(__file__).parent / 'asr.vectors.json').write_text(json.dumps(out, ensure_ascii=False, allow_nan=False))
print(len(spans), len(repl), len(tau))
