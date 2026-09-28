"""Record Python pace_notes for the JS parity test."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.cascade import pace_notes
CASES = [[0, 600, [], False], [125000, 600, ['a', '', 'c', '', '', ''], False], [515000, 600, ['a'] * 6, True], [599999, 600, ['', 'b'], False], [30000, 120, [], True]]
(Path(__file__).parent / 'pace.vectors.json').write_text(json.dumps([[c, pace_notes(*c)] for c in CASES]))
print(len(CASES))
