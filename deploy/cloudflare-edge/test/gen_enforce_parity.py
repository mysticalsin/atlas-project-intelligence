"""Record Python atlas_voice/enforce.py for the JS port (test/enforce.test.js): on_move, local_say, last_question, stems."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.enforce import on_move, local_say, last_question, stems, LOCAL_REANGLE, LOCAL_HOLD

ON = [  # (question, expected, intent, lang)
    ("What problem was the client facing?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("What was the client's situation?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("What was the client trying to achieve?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("What was happening at the client?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("What was the client's goal?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("What happened with the client?", "What was the main problem the team needed to solve?", "open_exploration", "en"),
    ("Let me make it easier: what's one concrete example you remember, however small?", "Let me make it easier: what's one concrete example you remember, however small?", "reangle_example", "en"),
    ("Can you think of one specific moment from the project?", "Let me make it easier: what's one concrete example you remember, however small?", "reangle_example", "en"),
    ("Okay, no worries. What was the client's situation?", "Let me make it easier: what's one concrete example you remember, however small?", "reangle_example", "en"),
    ("Roughly how big would you say the change was?", "What would a rough order of magnitude be, even approximately?", "reangle_scale", "en"),
    ("What was the client's situation?", "What would a rough order of magnitude be, even approximately?", "reangle_scale", "en"),
    ("Who might know more about that?", "Who on the project would know that best?", "reangle_who", "en"),
    ("What did you see yourself at that point?", "What did you see or do yourself at that point?", "reangle_saw", "en"),
    ("What data supports the handler productivity gain?", "How did you know it was working?", "measurement", "en"),
    ("How did you tell it was working?", "How did you know it was working?", "measurement", "en"),
    ("Which other teams were involved?", "Who used it day to day once it was live?", "adoption", "en"),
    ("Who used it day to day?", "Who used it day to day once it was live?", "adoption", "en"),
    ("Before we wrap up, I'm still missing what was done. What did you personally do?", "Before we wrap up, I'm still missing the problem and what you personally did. What was your role on the project?", "role", "en"),
    ("What was your role on the project?", "Before we wrap up, I'm still missing the problem and what you personally did. What was your role on the project?", "role", "en"),
    ("Quel exemple concret vous revient en mémoire ?", LOCAL_REANGLE['reangle_example']['fr'], "reangle_example", "fr"),
    ("Pouvez-vous me parler du client ?", LOCAL_REANGLE['reangle_example']['fr'], "reangle_example", "fr"),
    ("Qui saurait le mieux ?", LOCAL_REANGLE['reangle_who']['fr'], "reangle_who", "fr"),
    ("¿Quién lo sabría mejor?", LOCAL_REANGLE['reangle_who']['es'], "reangle_who", "es"),
    ("¿Cuánto tiempo te tomó diseñar esas reglas?", LOCAL_REANGLE['reangle_scale']['es'], "reangle_scale", "es"),
    ("Welches konkrete Beispiel fällt Ihnen ein?", LOCAL_REANGLE['reangle_example']['de'], "reangle_example", "de"),
    ("", "What was the main problem?", "open_exploration", "en"), ("What?", "What was the main problem?", "open_exploration", "en"), ("Why", "", "", "en"),
    ("Что произошло?", "Что произошло?", "", "ru"),
]
LAST = ["Before we wrap up, I'm still missing the problem. What was going on?", "One sentence only", "", "First. Second? Third.", "What was it? And why?  Done.", "Qui ? Quoi ?"]
STEMS = ["What problem was the client facing?", "Qu'avez-vous vu ou fait vous-même ?", "¿Qué estaba pasando?", "Welches konkrete Beispiel fällt Ihnen ein?", "approximately roughly", "", "A the of"]
LOCAL = [[i, None, '', l] for i in LOCAL_REANGLE for l in ['en', 'fr', 'es', 'pt', 'de', 'it', 'nl', 'pl']] + \
        [['ladder', f, w, l] for f in list(LOCAL_HOLD) + ['stakes'] for w in ['stop_missing:' + f + '>ladder:' + f, 'ladder:' + f] for l in ['en', 'fr', 'de', 'pl']]
out = {'on': [[list(c), on_move(*c)] for c in ON], 'last': [[t, last_question(t)] for t in LAST], 'stems': [[t, sorted(stems(t))] for t in STEMS],
       'local': [[c, local_say(c[0], c[1], c[2], c[3])] for c in LOCAL]}
(Path(__file__).parent / 'enforce.vectors.json').write_text(json.dumps(out, ensure_ascii=False))
print({k: len(v) for k, v in out.items()})
