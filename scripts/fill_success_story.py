#!/usr/bin/env python3
"""Fill the pinned Spanish success-story template from a story JSON record.

  python3 scripts/fill_success_story.py assets/templates/amaris_success_story_es.docx story.json out.docx --audience internal|client|public

client and public need the story's approval_state gates; their output never contains the internal notes. Any refusal (schema,
gate, template drift, post-render leak scan) exits 2 and writes nothing. Stdlib only.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from atlas_voice import success_story as ss  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('template'); ap.add_argument('story_json'); ap.add_argument('output')
    ap.add_argument('--audience', choices=ss.AUDIENCES, default='internal')
    ap.add_argument('--language', default='es', help='output language: selects the pinned template (only es today)')
    args = ap.parse_args(argv)
    try:
        story = json.loads(Path(args.story_json).read_text(encoding='utf-8'))
        out = ss.fill_docx(args.template, story, args.audience, args.output, language=args.language)
    except (ss.StoryError, OSError, ValueError) as e:  # StoryError subclasses ValueError; JSON errors too
        print(f'refused: {e}', file=sys.stderr)
        return 2
    print(f'Created {out} for audience={args.audience}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
