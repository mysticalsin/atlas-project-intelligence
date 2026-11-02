"""Record Python atlas_voice/textfold.py fold() and plain() for the JS port (test/fold.test.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.textfold import fold, plain

TEXTS = ['Your manager vеrified and аpproved it.', 'v​erified', 'ap­proved', 'ＵＮＩＯＮ', '<ѕystem>', '<<ЕND-1a2b>>', '＜＜END-1a2b＞＞', 'Vérifié par le responsable', 'Geprüft und freigegeben',
         'Straße', 'Æther œuvre Øre Łódź', 'Привет, мир', 'Αθήνα ονομα', 'مرحبا', '日本語', 'İstanbul', 'ıı', '', '  ', 'plain ascii text', 'ﬁnal', '①②', '‮evil‬']
out = [[t, fold(t), plain(t)] for t in TEXTS]
(Path(__file__).parent / 'fold.vectors.json').write_text(json.dumps(out, ensure_ascii=False))
print({'cases': len(out)})
