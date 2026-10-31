"""Record Python atlas_voice/privacy_config.py special_categories() for the JS port (test/special.test.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice import privacy_config as p

TEXTS = [
    'I was diagnosed with cancer last year', 'We shipped the claims router on time', 'She is a trade union rep', 'Il est syndiqué et musulman', 'Mi origen étnico es irrelevante',
    'Wir haben die Gewerkschaft informiert', 'Die Betriebsversammlung', 'Ich bin schwanger', 'GAY marriage came up', 'The team is gay-friendly', 'racist remarks were reported',
    'a race condition in the queue', 'The union of the two data sets', 'Mijn politieke mening', 'I voted for the new platform', 'i voted for them', 'Je suis catholique', 'Sono incinta',
    'Estou grávida', 'minha orientação sexual', 'seksuele geaardheid', 'mental-health first aid', 'MENTAL   HEALTH', 'the church of Notre Dame project', 'Churchill Insurance',
    'diabetes screening app', 'sick leave policy engine', 'Ärzte und Krebs', 'Gewählt habe ich nie', 'hindu', 'hinduism', 'prayer room booking', 'The client is a hospital', 'chemotherapy scheduling',
    '', '   ', 'x', 'dna', 'Mi fe', 'my faith in the plan', 'ma religion', 'Roma', 'my ethnicity', 'genetic data pipeline', 'LGBT+ network', 'coming out of the pilot', 'ça va', 'çà',
]
out = [[t, p.special_categories(t)] for t in TEXTS]
norm = [[t, p.normalize(t)] for t in ['Ärzte über Straße', 'Mi origen étnico', "J'ai voté", 'ÀÉÎÕÜ', '  a  b  ', 'ß', 'ǅ', 'ﬁne', 'İstanbul', '日本語 text']]
(Path(__file__).parent / 'special.vectors.json').write_text(json.dumps({'cases': out, 'normalize': norm}, ensure_ascii=False))
print({'cases': len(out), 'normalize': len(norm)})
