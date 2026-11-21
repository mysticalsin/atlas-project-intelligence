"""A30 personality and greetings, folded into the PR #1 port. These fail until one persona is composed in."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy' / 'cloudflare-edge'


def build_edge():
    spec = importlib.util.spec_from_file_location('build_edge', EDGE / 'build_edge.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_talker_drops_filler_praise():
    from atlas_voice.cascade import TALKER_POLICY
    assert 'amazing' not in TALKER_POLICY


def test_prompts_follow_one_persona():
    from atlas_voice.persona import OPENING_BRIEF, PERSONA_CORE, PRAISE_RULES
    from atlas_voice.cascade import OPENING, TALKER_POLICY
    from atlas_voice.interview import ROLE
    from atlas_voice.quality import INTERVIEW_POLICY
    from atlas_voice.realtime import OPENING_TURN
    assert 'amazing' not in PRAISE_RULES
    for policy in (TALKER_POLICY, INTERVIEW_POLICY, ROLE):
        assert PERSONA_CORE in policy
    assert OPENING_BRIEF in ROLE and OPENING_BRIEF in INTERVIEW_POLICY and OPENING_BRIEF in OPENING
    assert OPENING_BRIEF in OPENING_TURN
    assert 'Speak in English' in ROLE


def test_cascade_reads_the_start_language():
    from atlas_voice.cascade import language_note, session_language, talker_messages
    source = (ROOT / 'atlas_voice' / 'cascade.py').read_text()
    assert 'session_language(init)' in source
    assert session_language({'language': 'fr-FR'}) == 'fr'
    assert session_language({'language': 'not-a-language'}) == 'en'
    messages = talker_messages({'title': 'Synthetic pilot'}, '', None, [], notes=(language_note('fr'),))
    assert any('French' in message['content'] for message in messages)


def test_cascade_note_points_at_the_english_voice_notice():
    from atlas_voice.cascade import language_note
    from atlas_voice.languages import english_voice_notice
    for code in ('nl', 'ja', 'fr'):
        notice = english_voice_notice(code)
        note = language_note(code)
        assert notice in note
        assert 'English' in note
        assert 'amazing' not in note.lower()
        assert 'Reply only in natural' not in note
    assert 'Reply only in natural English' in language_note('en')
    assert 'Reply only in natural Spanish' in language_note('es')
    assert 'amazing' not in english_voice_notice('en').lower()


def test_languages_py_is_wired_and_keeps_machine_translated_labels():
    from atlas_voice.languages import REVIEW_STATUS
    rendered = build_edge().render()
    assert REVIEW_STATUS['fr'] == 'machine_translated'
    assert REVIEW_STATUS['en'] == 'authored'
    assert 'export const LANG_REVIEW = ' in rendered
    assert 'machine_translated' in rendered
    assert 'export const LANG_NOTICES = ' in rendered
