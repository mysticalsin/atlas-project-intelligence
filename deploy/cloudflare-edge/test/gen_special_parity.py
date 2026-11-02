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
    # v2.2 X2 (red M13/L14): look-alikes, invisible characters, spaced letters, the new languages, place names, languages with no list
    'I was off for chemo during the pilot.', 'I was off for che\u200bmotherapy during the pilot.', 'I was off for \u0441hemotherapy during the pilot.', 'I was off for c-h-e-m-o-t-h-e-r-a-p-y.',
    'I am on antidepressants.', 'My oncologist said rest.', '\u042f \u0431\u044b\u043b \u043d\u0430 \u0431\u043e\u043b\u044c\u043d\u0438\u0447\u043d\u043e\u043c \u0438\u0437-\u0437\u0430 \u0440\u0430\u043a\u0430.',
    '\u0643\u0646\u062a \u0641\u064a \u0625\u062c\u0627\u0632\u0629 \u0645\u0631\u0636\u064a\u0629 \u0628\u0633\u0628\u0628 \u0627\u0644\u0633\u0631\u0637\u0627\u0646', '\u79c1\u306f\u764c\u306e\u6cbb\u7642\u3067\u4f11\u8077\u3057\u3066\u3044\u307e\u3057\u305f\u3002',
    'By\u0142em na zwolnieniu z powodu raka.', 'Jestem cz\u0142onkiem zwi\u0105zku zawodowego.', 'I am a uni\u00adon member.', 'I am a \uff55\uff4e\uff49\uff4f\uff4e member.', 'The project was for Church Street Bank.',
    'We went to church on Sunday.', '\u6211\u60a3\u6709\u764c\u75c7\u3002', '\u6211\u4eec\u7684\u5de5\u4f1a\u4ee3\u8868\u6765\u4e86', 'Kunde war ein Systemausfall wegen Fehler', 'c h e', 'a b', 'x y z w', 'The CV and the MD were reviewed.',
]
out = [[t, p.special_categories(t)] for t in TEXTS]
norm = [[t, p.normalize(t)] for t in ['c-h-e-m-o', 'che\u200bmo', '\u0441hemo', 'a b c d', 'a b', '\u5de5\u4f1a \u4ee3\u8868', 'Ärzte über Straße', 'Mi origen étnico', "J'ai voté", 'ÀÉÎÕÜ', '  a  b  ', 'ß', 'ǅ', 'ﬁne', 'İstanbul', '日本語 text']]
unc = [[t, p.uncovered_language(t)] for t in TEXTS + ['Jag har cancer och \u00e4r sjukskriven sedan i v\u00e5ras.', '\u05d0\u05e0\u05d9 \u05d7\u05d5\u05dc\u05d4 \u05d1\u05e1\u05e8\u05d8\u05df \u05de\u05d6\u05d4 \u05d6\u05de\u05df', '\u03a0\u03ac\u03c1\u03b1 \u03c0\u03bf\u03bb\u03cd \u03b1\u03c5\u03c4\u03cc \u03c4\u03bf \u03ad\u03c1\u03b3\u03bf \u03ae\u03c4\u03b1\u03bd \u03b1\u03c0\u03cc\u03bb\u03c5\u03c4\u03b1 \u03b5\u03c0\u03b9\u03c4\u03c5\u03c7\u03ad\u03c2', 'ok', 'Das Projekt war ein Erfolg und das Team hat die Migration abgeschlossen.']]
(Path(__file__).parent / 'special.vectors.json').write_text(json.dumps({'cases': out, 'normalize': norm, 'uncovered': unc}, ensure_ascii=False))
print({'cases': len(out), 'normalize': len(norm)})
