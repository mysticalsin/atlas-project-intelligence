"""Record Python pace_notes for the JS parity test."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.cascade import pace_notes
CASES = [[0, 900, [], False], [125.5, 900, ['a', '', 'c', '', '', ''], False], [300, 900, ['a'] * 6, True], [405, 900, ['a', '', 'c', '', '', ''], False],
         [500.25, 900, ['a'] * 6, False], [689.9, 900, ['', 'b'], False], [690, 900, [], True], [880, 900, ['a'], False], [30, 120, [], True]]
(Path(__file__).parent / 'pace.vectors.json').write_text(json.dumps([[c, pace_notes(*c)] for c in CASES]))
print(len(CASES))
