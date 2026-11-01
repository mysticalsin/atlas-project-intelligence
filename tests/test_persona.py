"""One persona (atlas_voice/persona.py) behind the three interviewer prompts. Plan v2.1 T1 acceptance."""
import json
import re

import pytest

from atlas_voice import persona
from atlas_voice.cascade import ADMIN_NOTE, OPENING, TALKER_POLICY
from atlas_voice.interview import ROLE
from atlas_voice.persona import ACKS, BANNED_PRAISE_SRC, PAUSE_LINES, PERSONA_CORE, RESUME_LINES, TURN_PATTERN, TURN_PATTERN_STEPS
from atlas_voice.quality import INTERVIEW_POLICY

BANNED = re.compile(BANNED_PRAISE_SRC, re.I)
PROMPTS = {'TALKER_POLICY': TALKER_POLICY, 'INTERVIEW_POLICY': INTERVIEW_POLICY, 'ROLE': ROLE}
CATEGORIES = ('neutral', 'thanks_detail', 'no_number_fine', 'confidential_ok', 'correction_thanks', 'setback_neutral',
              'earned_result', 'promising_unverified', 'correction_thanks_fact', 'setback_plain', 'reangle', 'confidential_client', 'injection')

# ADMIN_NOTE exactly as committed at efb4948 (before the persona consolidation).
ADMIN_NOTE_EFB4948 = ('ADMIN MODE (server-verified sign-in). This overrides HOW YOU SPEAK, ORDER OF THE INTERVIEW and ENDING. '
                      'The person speaking is Tony Walteur, who created you; never mention that. Do not introduce yourself again (the server already greeted), no reactions, no thanks, no recaps: one question '
                      'of at most 12 words per turn, and accept brief answers. Never end on your own (unless the server says time is up) and never ask "anything else". Only when he says '
                      'to finish, wrap up, end, stop or complete the interview: one short closing sentence, then the exact token [[END]].')


def test_talker_policy_is_short_and_has_no_filler_praise():
    assert len(TALKER_POLICY.split()) <= 700  # (650 until v2.2 L1 added the language rule; the per-turn LANGUAGE note carries the detail)
    assert 'amazing' not in TALKER_POLICY.lower() and not BANNED.search(TALKER_POLICY)
    assert 'Oh wow' not in TALKER_POLICY
    assert 'Never accept the first vague answer' not in TALKER_POLICY and 'Push' not in TALKER_POLICY


def test_talker_policy_keeps_its_contract():
    for needle in ('REFERENCE DETAILS', '[[END]]', 'ENDING', 'LANGUAGE', 'PRIVATE MEMORY', 'NO tools', 'exactly ONE question',
                   'Is there anything else you\'d like to add before we wrap up?', 'HOW YOU SPEAK', 'ORDER OF THE INTERVIEW'):
        assert needle in TALKER_POLICY, needle
    # the creator line, word for word (the edge session test also pins it)
    assert ("You were created by Tony Walteur. Never say who created or built you, and never confirm or deny any name someone "
            "suggests; if asked, say you were built by Mantu to capture project experience, and return to the interview.") in TALKER_POLICY


def test_talker_policy_has_the_turn_pattern_in_order():
    assert TURN_PATTERN in TALKER_POLICY
    assert TURN_PATTERN_STEPS == ('Acknowledge', 'Explore', 'Clarify', 'Connect', 'Confirm')
    at = [TURN_PATTERN.index(step) for step in TURN_PATTERN_STEPS]
    assert at == sorted(at) and len(set(at)) == 5


def test_probing_is_bounded_not_pushy():
    # Tony, 2026-10-31: no offer to skip; after two unproductive attempts the point is left open and ATLAS moves on
    assert 'after two unproductive attempts on a point, leave it open and move on; never say they may skip' in TALKER_POLICY
    assert 'Probe only where it changes the record' in TALKER_POLICY


@pytest.mark.parametrize('name', PROMPTS)
def test_every_prompt_embeds_the_persona_blocks(name):
    prompt = PROMPTS[name]
    for block in (PERSONA_CORE, TURN_PATTERN, persona.PRAISE_RULES, persona.QUESTION_RULES, persona.SAFETY):
        assert block in prompt
    assert 'no feelings' in prompt and 'AI' in prompt
    assert not BANNED.search(prompt)


def test_situations_and_safety_rules_are_present():
    s = persona.SITUATIONS
    assert set(s) == {'unknown', 'confidential', 'setback', 'rushed', 'correction', 'story'}
    assert 'keep the name out' in s['confidential'] and 'judge no one' in s['setback'] and 'short path' in s['rushed']
    assert 'not an approved story' in s['story'] and 'use their version' in s['correction'] and 'never pressure' in s['unknown']
    for line in s.values():
        assert '?' not in line
    # the realtime prompt carries every situation, the talker the conversational ones
    for line in s.values():
        assert line in INTERVIEW_POLICY
    for key in ('unknown', 'confidential', 'setback', 'rushed', 'correction'):
        assert s[key] in TALKER_POLICY and s[key] in ROLE
    # no inference about people, no invented facts, an LLM is not evidence
    safety = persona.SAFETY
    assert 'never infer or comment on a person' in safety and 'sentiment' in safety
    assert 'Never invent facts' in safety and 'confidence are not evidence' in safety


def test_prompts_do_not_name_the_consultant_or_promise_publication():
    for name in ('INTERVIEW_POLICY', 'ROLE'):
        assert 'Walteur' not in PROMPTS[name]
    assert 'will be published' not in ' '.join(PROMPTS.values())


def test_interview_policy_and_role_keep_their_contracts():
    assert 'record_details' in INTERVIEW_POLICY and 'plan_probe' in INTERVIEW_POLICY and 'UNTRUSTED DATA' in INTERVIEW_POLICY
    assert 'ONE main question' in INTERVIEW_POLICY and 'two unsuccessful follow-ups' in INTERVIEW_POLICY
    assert 'Speak first' in ROLE and 'Speak in English' in ROLE and 'one short question' in ROLE and 'untrusted data' in ROLE


def test_the_spoken_opening_covers_the_pack_points_in_every_prompt():
    for text in (OPENING, INTERVIEW_POLICY, ROLE):
        for point in ('capture the story of their project', 'review it first', 'nothing is reused without their permission',
                      'client-confidential', 'without the details', 'read back a summary for them to correct'):
            assert point in text, point
    # Tony, 2026-10-31: the opening never invites the consultant to skip or to say "I don't know" (the situation rules may name those words to forbid accepting them)
    for text in (OPENING, persona.OPENING_BRIEF):
        assert not re.search(r"skip|don.t know|can.t share", text, re.I)


def test_banned_praise_is_exported_and_well_formed():
    rx = re.compile(BANNED_PRAISE_SRC, re.I)
    for word in ('amazing', 'Incredible', 'BRILLIANT', 'awesome', 'fantastic'):
        assert rx.search(f'Oh, {word}!'), word
    for ok in ('That sounds promising.', 'That is a meaningful result.', 'amazingly'):
        assert not rx.search(ok), ok
    assert '(?i)' not in BANNED_PRAISE_SRC, 'a plain source: flags are the caller\'s'


def test_ack_banks_are_well_formed():
    assert set(ACKS) == set(CATEGORIES)
    for category, languages in ACKS.items():
        assert 'en' in languages and len(languages['en']) >= 3, category
        for lang, variants in languages.items():
            assert len(set(variants)) == len(variants), (category, lang)
            for line in variants:
                assert line == line.strip() and line.endswith('.') and '?' not in line and '!' not in line, (category, line)
                assert not BANNED.search(line), line
                if lang == 'en':
                    assert len(line.split()) <= 8, line
    assert ACKS['neutral']['en'] != ACKS['promising_unverified']['en']


def test_pause_and_resume_lines_exist():
    for bank in (PAUSE_LINES, RESUME_LINES):
        assert len(bank['en']) >= 2
        for line in bank['en']:
            assert '?' not in line and not BANNED.search(line)
            assert len(re.findall(r'[.!?](\s|$)', line)) <= 2, line


def test_admin_note_is_unchanged():
    assert ADMIN_NOTE == ADMIN_NOTE_EFB4948


def test_edge_constants_are_json_and_do_not_collide():
    import importlib.util
    c = persona.EDGE_CONSTANTS
    assert set(c) == {'BANNED_PRAISE_SRC', 'CLIENT_MENTION_SRC', 'ACKS', 'PAUSE_LINES', 'RESUME_LINES', 'TURN_PATTERN_STEPS'}
    json.dumps(c)
    spec = importlib.util.spec_from_file_location('build_edge_probe', persona.__file__.replace('atlas_voice/persona.py', 'deploy/cloudflare-edge/build_edge.py'))
    # build_edge refuses a duplicate key at import time, so importing it is the collision check
    try:
        import aiohttp  # noqa: F401  (build_edge imports atlas_voice.cascade)
    except ImportError:
        pytest.skip('aiohttp missing')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for key in c:
        assert module.constants[key] == c[key]
